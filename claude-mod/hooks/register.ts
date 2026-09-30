import type { EngineInterface, On, PluginOptions } from 'claude-code'

import {
  effectiveWorkspaces,
  failureReasonOf,
  isIngestible,
  type MentionMessage,
  mentionMessageOf,
  workspaceForCwd,
} from './mention-message'
import {
  detailSplitArgv,
  isProtectedDestination,
  linkifyReferences,
  type OutlinerClient,
  outlinerUriFor,
  outlinerUriOf,
  scratchPaneOf,
} from './references'
import { WORK_TOOLS } from './work-tools'

/**
 * What drawing a reply needs, read once per session: the Outliner workspace the
 * session belongs to (null: none configured, nothing is linked) and its Work-ID
 * prefixes. A render hook only reads, so this is loaded beside it, not in it.
 */
type ReferenceContext = { workspace: string | null; prefixes: string[] }
let references: ReferenceContext | undefined
let isLoadingReferences = false
/**
 * The environment an Outliner CLI run or pane gets for one workspace: its
 * folder only. The CLI and the pane resolve the outline from the folder's
 * client.json themselves, so every client lands on the same outline.
 */
const envFor = (workspace: string) => ({ OUTLINER_WORKSPACE_ROOT: workspace })
/** The pane id Herdr gave the last Detail this session split, until it registers. */
let splitScratchPane: string | undefined
/** Shows run one at a time, so concurrent clicks and tool calls split one pane. */
let showQueue: Promise<unknown> = Promise.resolve()

/**
 * Registers Recent Mentions: each completed main-loop answer in a configured
 * workspace goes to the Outliner, as the Codex Stop hook sends Codex's.
 *
 * Workspaces come from the `workspaces` option, or, left empty, from
 * `PI_OUTLINER_MENTIONS_WORKSPACES` (for a `CLAUDE_CODE_PLUGIN_DIRS` setup,
 * whose settings `env` block can carry it). Neither set: nothing is ingested.
 * The engine hands an unset string option over as '', so empty and unset are
 * one case: an empty option cannot override the environment.
 *
 * The answer passes on untouched. Delivery runs off the turn's dispatch, so a
 * slow or absent service never delays the prompt; a failure is one toast.
 *
 * In the same workspaces, Work IDs, `[[pages]]` and `((block references))` in
 * Claude's replies are drawn as links; a click opens the target through the
 * Outliner Tree in this Herdr tab, as a click inside the Tree would.
 */
export function register(on: On, options: PluginOptions): void {
  const option = options.workspaces

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    $.clock.after(0, () => void loadReferences($, option))
    await $.tool.register({
      name: 'show',
      description:
        "Show an Outliner note in Claude's own Outliner Detail pane, split below this conversation " +
        'in Herdr and reused for every call, so the person can read it beside the chat. When this ' +
        "session runs in an ep0ch-door tile, it opens in that door, where its tile's opens land, instead. It never " +
        'moves their Trees, Details or focus. Use it when pointing the person at a note matters; ' +
        'references in replies are already clickable.',
      inputSchema: {
        type: 'object',
        properties: {
          reference: {
            type: 'string',
            description: 'A Work ID (PIE-123), [[page]], ((block-uuid)), bare block UUID, or pi-outliner:// URI.',
          },
        },
        required: ['reference'],
        additionalProperties: false,
      },
    })
    for (const tool of WORK_TOOLS) {
      await $.tool.register({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })
    }
    return result
  })

  for (const tool of WORK_TOOLS) {
    on('tool.call', { tool: `mcp__pi-outliner__${tool.name}` }, async ($, e) => {
      const command = tool.command(e as Record<string, unknown>)
      if (typeof command === 'string') return { deny: command }
      if (!references) await loadReferences($, option)
      const workspace = references?.workspace
      if (!workspace) return { deny: 'This session is not in a configured Outliner workspace.' }
      try {
        return { result: await runWorkCommand($, workspace, command) }
      } catch (error) {
        return { deny: error instanceof Error ? error.message : String(error) }
      }
    })
  }

  on('tool.call', { tool: 'mcp__pi-outliner__show' }, async ($, e) => {
    // A plugin tool's arguments arrive flat on the event, beside `tool`.
    const reference: unknown = e.reference
    const uri = typeof reference === 'string' ? outlinerUriFor(reference) : null
    if (!uri) return { deny: 'Give a Work ID, [[page]], ((block-uuid)) or pi-outliner:// URI to show.' }
    if (!references) await loadReferences($, option)
    const workspace = references?.workspace
    if (!workspace) return { deny: 'This session is not in a configured Outliner workspace.' }
    try {
      const { title, place, reader } = await showInScratchPane($, workspace, uri)
      return { result: `Showing ${title || reference} ${place === 'door' ? (reader ? `in the door's ${reader} reader` : 'in the door') : "in Claude's Outliner pane"}.` }
    } catch (error) {
      return { deny: `Could not show ${reference}: ${error instanceof Error ? error.message : String(error)}` }
    }
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const workspace = references?.workspace
    if (!workspace) return next(e)
    const { text, hrefs } = linkifyReferences(e.props.text, references!.prefixes)
    if (hrefs.length === 0 || text.length > 10_000) return next(e)
    const { Box, Text, Markdown } = await $.ui.resolve(e)
    return Box({
      flexDirection: 'row',
      children: [
        Box({ width: 2, flexShrink: 0, children: Text({ children: e.props.isFirstOfReply ? '⏺' : '' }) }),
        Box({
          flexGrow: 1,
          flexShrink: 1,
          children: Markdown({
            key: 'outliner-references',
            text,
            pressableLinks: hrefs.slice(0, 256),
            onLinkPress: link => void openReference($, workspace, link.href),
          }),
        }),
      ],
    })
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // A module reloaded mid-session never sees its session.start.
    if (!references) $.clock.after(0, () => void loadReferences($, option))
    if (!isIngestible(e)) return result
    let workspaces: string[]
    try {
      workspaces = effectiveWorkspaces(option, await $.env.get('PI_OUTLINER_MENTIONS_WORKSPACES'), await $.env.get('HOME'))
    } catch (error) {
      $.ui.toast(`Outliner recent mentions unavailable: ${error instanceof Error ? error.message : String(error)}`, { timeoutMs: 6000 })
      return result
    }
    if (workspaces.length === 0) return result
    const [id, cwd] = await Promise.all([$.session.id(), $.session.cwd()])
    const message = mentionMessageOf(e, { id, cwd }, workspaces)
    if (message) {
      $.clock.after(0, () => {
        deliver($, message).catch((error: unknown) => {
          const reason = error instanceof Error ? error.message : String(error)
          $.ui.toast(`Outliner recent mentions unavailable: ${reason}`, { timeoutMs: 6000 })
        })
      })
    }
    return result
  })
}

const PLUGIN_ID = 'float.pi-outliner'

/**
 * The installed Outliner's root, as Herdr reports it: exactly one enabled
 * `float.pi-outliner` with an absolute `plugin_root`. Never a guessed checkout.
 * Null when the plugin is installed but disabled.
 */
async function outlinerRootOf($: EngineInterface): Promise<string | null> {
  const listed = await $.process.run(
    ['herdr', 'plugin', 'list', '--plugin', PLUGIN_ID, '--json'],
    { timeoutMs: 5000 },
  )
  if (listed.exitCode !== 0) throw Error('Herdr could not discover the Outliner installation')
  const plugins: unknown = JSON.parse(listed.stdout)?.result?.plugins
  const matches = Array.isArray(plugins)
    ? plugins.filter(plugin => plugin?.plugin_id === PLUGIN_ID)
    : []
  if (matches.length !== 1) throw Error(`Expected one installed ${PLUGIN_ID} plugin`)
  const [plugin] = matches
  if (plugin.enabled === false) return null
  if (typeof plugin.plugin_root !== 'string' || !plugin.plugin_root.startsWith('/'))
    throw Error('Herdr did not report an absolute plugin_root')
  return plugin.plugin_root
}

/**
 * Posts one message through the installed CLI's `mentions ingest`. The event
 * workspace selects the database, never this process's cwd; an existing
 * connection override in the environment is kept, and no service is started.
 */
async function deliver($: EngineInterface, message: MentionMessage): Promise<void> {
  const root = await outlinerRootOf($)
  if (root === null) return
  const ingested = await $.process.run(
    ['/bin/sh', `${root}/scripts/run-bun.sh`, `${root}/src/cli.ts`, 'mentions', 'ingest'],
    {
      cwd: message.workspaceRoot,
      env: envFor(message.workspaceRoot),
      stdin: JSON.stringify(message),
      timeoutMs: 30_000,
    },
  )
  if (ingested.exitCode !== 0) {
    const reason = failureReasonOf(ingested.stderr)
    throw Error(`mentions ingest failed${reason ? `: ${reason}` : ''}`)
  }
}

/**
 * Runs one `work` / `note` command through the installed CLI in the session's
 * workspace, as Claude (agent author, this session as provenance). Resolves to
 * the command's JSON; a refusal throws with the CLI's reason.
 */
async function runWorkCommand(
  $: EngineInterface,
  workspace: string,
  command: { args: string[]; stdin?: string },
): Promise<string> {
  const root = await outlinerRootOf($)
  if (!root) throw Error('the Outliner plugin is disabled')
  const sessionId = await $.session.id()
  const ran = await $.process.run(
    ['/bin/sh', `${root}/scripts/run-bun.sh`, `${root}/src/cli.ts`, ...command.args,
      '--author', 'agent', '--actor', 'claude-code', '--session', sessionId],
    {
      cwd: workspace,
      env: envFor(workspace),
      ...(command.stdin === undefined ? {} : { stdin: command.stdin }),
      timeoutMs: 60_000,
    },
  )
  if (ran.exitCode !== 0) throw Error(failureReasonOf(ran.stderr) || `${command.args.slice(0, 2).join(' ')} failed`)
  return ran.stdout.trim()
}

/**
 * Reads the session's workspace and Work-ID prefixes into `references`. A
 * session outside the configured workspaces links nothing; a service that
 * cannot answer leaves pages and block references linked, bare IDs not.
 */
async function loadReferences($: EngineInterface, option: unknown): Promise<void> {
  if (isLoadingReferences) return
  isLoadingReferences = true
  try {
    const workspaces = effectiveWorkspaces(option, await $.env.get('PI_OUTLINER_MENTIONS_WORKSPACES'), await $.env.get('HOME'))
    const workspace = workspaceForCwd(await $.session.cwd(), workspaces)
    if (!workspace) {
      references = { workspace: null, prefixes: [] }
      return
    }
    references = { workspace, prefixes: [] }
    const root = await outlinerRootOf($)
    if (!root) return
    const status = await $.process.run(
      ['/bin/sh', `${root}/scripts/run-bun.sh`, `${root}/src/cli.ts`, 'work-id-status'],
      { cwd: workspace, env: envFor(workspace), timeoutMs: 30_000 },
    )
    if (status.exitCode !== 0) return
    const { prefix, observedPrefixes } = JSON.parse(status.stdout) as { prefix?: unknown; observedPrefixes?: unknown }
    const prefixes = [prefix, ...(Array.isArray(observedPrefixes) ? observedPrefixes : [])]
      .filter((value): value is string => typeof value === 'string')
    references = { workspace, prefixes: [...new Set(prefixes)] }
  } catch {
    // Linking is a convenience: the reply is drawn as before.
  } finally {
    isLoadingReferences = false
  }
}

/** Where a note was shown: the door this session runs in (and the reader tile it landed in), or Claude's own Detail pane in Herdr. */
type Shown = { title: string; place: 'door' | 'pane'; reader?: string }

/**
 * Shows an Outliner link where the person reads beside Claude. In an ep0ch-door
 * tile (EP0CH_TILE and EP0CH_CONTROL set): in that door, as an agent's open
 * from its tile, landing where the tile's opens go (the daily layout's middle
 * detail; the door says which). Otherwise, or when no door answers: in
 * Claude's own Detail, the pane this session split below the Claude pane,
 * reused while it lives, else split anew. It never navigates the person's
 * Trees or Details, and never takes focus. Resolves to the shown block's title
 * and where it went; throws with the reason otherwise.
 */
function showInScratchPane($: EngineInterface, workspace: string, uri: string): Promise<Shown> {
  const shown = showQueue.then(() => showNow($, workspace, uri))
  showQueue = shown.catch(() => {})
  return shown
}

/** The door tile this session runs in, if any: its name and the door's control socket (or a link to it). */
async function doorOf($: EngineInterface): Promise<{ tile: string; control: string } | null> {
  const [tile, control] = await Promise.all([$.env.get('EP0CH_TILE'), $.env.get('EP0CH_CONTROL')])
  return tile && control ? { tile, control } : null
}

async function showNow($: EngineInterface, workspace: string, uri: string): Promise<Shown> {
  const root = await outlinerRootOf($)
  if (!root) throw Error('the Outliner plugin is disabled')
  const outliner = (args: string[]) => $.process.run(
    ['/bin/sh', `${root}/scripts/run-bun.sh`, `${root}/src/cli.ts`, ...args],
    { cwd: workspace, env: envFor(workspace), timeoutMs: 30_000 },
  )
  const door = await doorOf($)
  if (door) {
    const shown = await showInDoor($, outliner, door, uri)
    if (shown !== null) return { ...shown, place: 'door' }
  }
  return { title: await showInHerdrPane($, outliner, workspace, uri), place: 'pane' }
}

/**
 * Shows the block in the door as an agent's `open` from this session's tile
 * (attributed, never moving the person's focus): the door decides the reader,
 * its tile's link, so no tile name is assumed here. Resolves to its title and
 * the reader it landed in, or null when no door answers on that socket (the
 * door quit): the caller shows it in Herdr instead.
 */
async function showInDoor(
  $: EngineInterface,
  outliner: (args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
  door: { tile: string; control: string },
  uri: string,
): Promise<{ title: string; reader?: string } | null> {
  const resolved = await outliner(['resolve', uri])
  if (resolved.exitCode !== 0) throw Error(failureReasonOf(resolved.stderr) || 'the target did not resolve')
  const { id, title } = JSON.parse(resolved.stdout) as { id: string; title?: string }
  const actor = (await $.env.get('EP0CH_AGENT')) || 'claude-code'
  // `--reader middle` only for a door older than `open from=` (ep0ch-door #61), which lands it where this mod
  // always did; a door that knows `from=` never reads it. Drop it once every door has `from=`.
  const opened = await outliner(['door-open', id, '--control', door.control, '--actor', actor, '--from', door.tile, '--reader', 'middle'])
  if (opened.exitCode === 3) return null
  if (opened.exitCode !== 0) throw Error(failureReasonOf(opened.stderr) || 'the door did not open it')
  let reader: unknown
  try { reader = JSON.parse(opened.stdout)?.reader } catch { reader = undefined }
  return { title: title ?? '', ...(typeof reader === 'string' && reader ? { reader } : {}) }
}

async function showInHerdrPane(
  $: EngineInterface,
  outliner: (args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
  workspace: string,
  uri: string,
): Promise<string> {
  const [sessionId, paneId, herdrWorkspace] = await Promise.all([
    $.session.id(),
    $.env.get('HERDR_PANE_ID'),
    $.env.get('HERDR_WORKSPACE_ID'),
  ])
  if (!paneId || !herdrWorkspace) throw Error('this session is not running inside Herdr')
  const findScratchPane = async () => {
    const [listedClients, listedPanes] = await Promise.all([
      outliner(['clients']),
      $.process.run(['herdr', 'pane', 'list', '--workspace', herdrWorkspace], { timeoutMs: 5000 }),
    ])
    if (listedClients.exitCode !== 0) throw Error(failureReasonOf(listedClients.stderr) || 'the Outliner service did not answer')
    if (listedPanes.exitCode !== 0) throw Error('Herdr could not list panes')
    const registered: unknown = JSON.parse(listedClients.stdout)
    const clients: OutlinerClient[] = (Array.isArray(registered) ? registered : (registered as { clients?: unknown[] })?.clients ?? [])
      .flatMap((client: any) => typeof client?.runtime?.paneId === 'string'
        ? [{ clientId: String(client.clientId), role: String(client.role), paneId: client.runtime.paneId, contextId: client.contextId }]
        : [])
    const panes: unknown = JSON.parse(listedPanes.stdout)?.result?.panes
    const paneTabs = new Map((Array.isArray(panes) ? panes : []).map((pane: any) => [String(pane.pane_id), String(pane.tab_id)]))
    return { pane: scratchPaneOf(clients, paneTabs, sessionId), paneTabs }
  }

  let { pane, paneTabs } = await findScratchPane()
  // A pane split moments ago may not have registered yet: wait for it rather
  // than splitting a second one.
  for (let wait = 0; !pane && splitScratchPane && paneTabs.has(splitScratchPane) && wait < 10; wait++) {
    await $.clock.sleep(300)
    ;({ pane, paneTabs } = await findScratchPane())
  }
  if (pane) {
    const shown = await outliner(['link', uri, '--detail-client', pane.clientId, '--no-focus'])
    if (shown.exitCode === 0) return String(JSON.parse(shown.stdout)?.title ?? '')
    const reason = failureReasonOf(shown.stderr)
    throw Error(isProtectedDestination(reason)
      ? "Claude's Outliner pane is mid-edit; finish or cancel it there"
      : reason || 'navigation failed')
  }
  const resolved = await outliner(['resolve', uri])
  if (resolved.exitCode !== 0) throw Error(failureReasonOf(resolved.stderr) || 'the target did not resolve')
  const { id, title, fragmentId } = JSON.parse(resolved.stdout) as { id: string; title?: string; fragmentId?: string }
  const opened = await $.process.run(
    detailSplitArgv({ paneId, workspace, sessionId, blockId: id, ...(fragmentId ? { fragmentId } : {}) }),
    { timeoutMs: 15_000 },
  )
  if (opened.exitCode !== 0) throw Error(failureReasonOf(opened.stderr) || 'Herdr could not open a Detail')
  try {
    splitScratchPane = JSON.parse(opened.stdout)?.result?.plugin_pane?.pane?.pane_id
  } catch {
    splitScratchPane = undefined
  }
  return title ?? ''
}

/** A click on a reference: shown in Claude's pane, or a toast saying why not. */
async function openReference($: EngineInterface, workspace: string, href: string): Promise<void> {
  const uri = outlinerUriOf(href)
  if (!uri) return
  try {
    await showInScratchPane($, workspace, uri)
  } catch (error) {
    const target = decodeURIComponent(uri.slice(uri.indexOf('/', 'pi-outliner://'.length) + 1))
    const reason = error instanceof Error ? error.message : String(error)
    $.ui.toast(`Could not open ${target} in the Outliner: ${reason}`, { timeoutMs: 6000 })
  }
}
