import type { EngineInterface, On, PluginOptions } from 'claude-code'

import {
  boundWorkspaceOf,
  effectiveWorkspaces,
  failureReasonOf,
  isIngestible,
  type MentionMessage,
  mentionMessageOf,
  mentionsModeOf,
  sessionWorkspaceOf,
  type Workspace,
  workspaceEnvOf,
  workspaceForCwd,
} from './mention-message'
import {
  detailSplitArgv,
  isProtectedDestination,
  linkifyReferences,
  type OutlinerClient,
  outlinerBlockIdOf,
  outlinerLabelOf,
  outlinerReferenceOf,
  outlinerUriFor,
  outlinerUriOf,
  scratchPaneOf,
} from './references'
import { actorOf, DOOR_TOOLS, doorActArgv, OUTLINE_TOOLS, peekOf } from './outline-tools'
import { WORK_TOOLS } from './work-tools'
import {
  type DoorEnv,
  doorTileOf,
  envSummaryOf,
  HELP_PROBE,
  inDoorEnv,
  knowsWhere,
  WHERE_BLOCK,
  WHERE_TIMEOUT_MS,
  WHERE_WAIT_MS,
  whereSummaryOf,
  whereText,
} from './where'

/**
 * What drawing a reply needs, read once per session: the Outliner workspace the
 * session belongs to (null: its folder is bound to no outline, or opted out;
 * nothing is linked) and its Work-ID prefixes. A render hook only reads, so
 * this is loaded beside it, not in it.
 */
type ReferenceContext = { workspace: Workspace | null; prefixes: string[] }
let references: ReferenceContext | undefined
/** The load in flight, so a tool call made while the session starts waits for it rather than being refused. */
let loadingReferences: Promise<void> | undefined
/**
 * The environment an Outliner CLI run gets for one workspace: its bound
 * folder, whose client.json the CLI resolves the outline from itself (so every
 * client lands on the same outline), and the outline's name for a root only
 * the host records.
 */
const envFor = workspaceEnvOf
/** Each reason the session's workspace could not be found is toasted once. */
const toldWorkspaceFailures = new Set<string>()
/** The pane id Herdr gave the last Detail this session split, until it registers. */
let splitScratchPane: string | undefined
/** Shows run one at a time, so concurrent clicks and tool calls split one pane. */
let showQueue: Promise<unknown> = Promise.resolve()
/**
 * Where this session runs (`ep0ch where`'s summary), started at session.start
 * for the first prompt's context; null outside a door.
 */
let whereLoad: Promise<string | null> | undefined

/**
 * Registers Recent Mentions: each completed main-loop answer in a folder bound
 * to an outline goes to that outline, as the Codex Stop hook sends Codex's.
 *
 * The session's workspace is its folder's nearest bound ancestor, resolved by
 * the installed CLI the way every client resolves it (`sessionWorkspace`). An
 * unbound folder feeds nothing. The `workspaces` option, or, left empty,
 * `PI_OUTLINER_MENTIONS_WORKSPACES`, lists folders opted out; with the `mode`
 * option or `PI_OUTLINER_MENTIONS_MODE` set to `allowlist` they are instead
 * the only folders that feed (the strict mode). The engine hands an unset string
 * option over as '', so empty and unset are one case: an empty option cannot
 * override the environment.
 *
 * The answer passes on untouched. Delivery runs off the turn's dispatch, so a
 * slow or absent service never delays the prompt; a failure is one toast.
 *
 * In the same workspaces, Work IDs, `[[pages]]` and `((block references))` in
 * Claude's replies are drawn as links; a click opens the target where `show`
 * and `door_open` do (`openNote`): the door this session runs in, else Claude's
 * own Detail in Herdr, else a toast with the `((id))` to copy.
 */
export function register(on: On, options: PluginOptions): void {
  const option = options

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    $.clock.after(0, () => void loadReferences($, option))
    // Off the start's dispatch: a slow or missing `ep0ch` never holds the session up.
    whereLoad = new Promise(resolve => {
      $.clock.after(0, () => void loadWhere($).then(resolve, () => resolve(null)))
    })
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
    // Off the start's dispatch: each registration republishes the tool server (~20ms), and these tools are
    // loaded on demand, so the session never waits for them. The door tools act in the door this Claude runs
    // in: only in a door tile, where EP0CH_CONTROL names it.
    $.clock.after(0, () => void (async () => {
      const tools = [...WORK_TOOLS, ...OUTLINE_TOOLS, ...((await $.env.get('EP0CH_CONTROL')) ? DOOR_TOOLS : [])]
      for (const tool of tools) {
        await $.tool.register({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })
      }
    })().catch(() => {}))
    return result
  })

  // Where this session runs, as one context block of the first prompt (not a pane): waited for briefly, else
  // the variables alone. Nothing is added outside a door, and a failure adds nothing.
  on('prompt.context', async ($, e, next) => {
    const result = await next(e)
    try {
      const env = await doorEnvOf($)
      if (!inDoorEnv(env)) return result
      // Before session.start's work is queued (or after a reload): start it once, here.
      const load = (whereLoad ??= loadWhere($).catch(() => null))
      const summary = (await Promise.race([load, $.clock.sleep(WHERE_WAIT_MS).then(() => null)])) ?? envSummaryOf(env)
      const block = { name: WHERE_BLOCK, text: whereText(summary) }
      return { ...result, blocks: [...result.blocks.filter(b => b.name !== WHERE_BLOCK), block] }
    } catch {
      return result
    }
  })

  for (const tool of WORK_TOOLS) {
    on('tool.call', { tool: `mcp__pi-outliner__${tool.name}` }, async ($, e) => {
      const command = tool.command(e as Record<string, unknown>)
      if (typeof command === 'string') return { deny: command }
      if (!references) await loadReferences($, option)
      const workspace = references?.workspace
      if (!workspace) return { deny: NOT_BOUND }
      try {
        return { result: await runWorkCommand($, workspace, command, await actorFor($, {})) }
      } catch (error) {
        return { deny: error instanceof Error ? error.message : String(error) }
      }
    })
  }

  for (const tool of OUTLINE_TOOLS) {
    on('tool.call', { tool: `mcp__pi-outliner__${tool.name}` }, async ($, e) => {
      const input = e as Record<string, unknown>
      const command = tool.command(input)
      if (typeof command === 'string') return { deny: command }
      if (!references) await loadReferences($, option)
      const workspace = references?.workspace
      if (!workspace) return { deny: NOT_BOUND }
      // outline_changes' `actor` filters by agent; every other tool's names who the write is attributed to.
      const actor = await actorFor($, tool.name === 'outline_changes' ? {} : input)
      try {
        return { result: await runOutlinerCli($, workspace, ['agent', command.operation, '--stdin', '--actor', actor], JSON.stringify(command.input)) }
      } catch (error) {
        return { deny: error instanceof Error ? error.message : String(error) }
      }
    })
  }

  for (const tool of DOOR_TOOLS) {
    on('tool.call', { tool: `mcp__pi-outliner__${tool.name}` }, async ($, e) => {
      const control = await $.env.get('EP0CH_CONTROL')
      if (!control) return { deny: 'The door tools work only in an ep0ch-door tile (EP0CH_CONTROL is not set).' }
      try {
        return { result: await runDoorTool($, tool.name, e as Record<string, unknown>, control, option) }
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
    try {
      return { result: shownText(await openNote($, references?.workspace ?? null, uri, await actorFor($, {})), String(reference)) }
    } catch (error) {
      return { deny: deniedText(error, String(reference)) }
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
    // Off the turn's dispatch: finding the folder's outline runs the CLI, and a slow one never delays the answer.
    $.clock.after(0, () => void (async () => {
      let workspace: Workspace | null
      try {
        workspace = await sessionWorkspace($, option)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        if (toldWorkspaceFailures.has(reason)) return
        toldWorkspaceFailures.add(reason)
        $.ui.toast(`Outliner recent mentions unavailable: ${reason}`, { timeoutMs: 6000 })
        return
      }
      const message = mentionMessageOf(e, { id: await $.session.id() }, workspace)
      if (!message || !workspace) return
      await deliver($, message, workspace).catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error)
        $.ui.toast(`Outliner recent mentions unavailable: ${reason}`, { timeoutMs: 6000 })
      })
    })())
    return result
  })
}

const NOT_BOUND = "This session's folder is not bound to an Outliner outline (bind it with the choose-outline action), or it is opted out."

const PLUGIN_ID = 'float.pi-outliner'

async function doorEnvOf($: EngineInterface): Promise<DoorEnv> {
  const [EP0CH_NEST, EP0CH_CONTROL, EP0CH_TILE, EP0CH_TILE_ID] = await Promise.all([
    $.env.get('EP0CH_NEST'),
    $.env.get('EP0CH_CONTROL'),
    $.env.get('EP0CH_TILE'),
    $.env.get('EP0CH_TILE_ID'),
  ])
  return { EP0CH_NEST, EP0CH_CONTROL, EP0CH_TILE, EP0CH_TILE_ID }
}

/**
 * `ep0ch where --json`'s one-line summary when this session runs in a door
 * (EP0CH_NEST or EP0CH_CONTROL set); the variables alone when `ep0ch` isn't
 * on PATH, is too old or fails; null outside a door. `where` only reads.
 */
async function loadWhere($: EngineInterface): Promise<string | null> {
  const env = await doorEnvOf($)
  if (!inDoorEnv(env)) return null
  try {
    // An ep0ch older than `where` would read `where` as a socket path and open a door on the terminal-less
    // session (attaching, maybe creating, an outline): its help must list `where` first. An ep0ch older than
    // `help` (before ep0ch-door #31) reads `help` the same way; the probe socket it then picks instead of
    // the default one doesn't exist, so it stops at "no carrier" before opening anything.
    const help = await $.process.run(['ep0ch', 'help', HELP_PROBE], { timeoutMs: 5000 })
    if (help.exitCode !== 0 || !knowsWhere(help.stdout)) return envSummaryOf(env)
    const ran = await $.process.run(['ep0ch', 'where', '--json'], { timeoutMs: WHERE_TIMEOUT_MS })
    const summary = ran.exitCode === 0 ? whereSummaryOf(ran.stdout) : null
    if (summary) return summary
  } catch {
    // Not on PATH, or it didn't answer in time: the variables alone.
  }
  return envSummaryOf(env)
}

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
 * The workspace a session feeds and works in, or null (`sessionWorkspaceOf`).
 * In folder mode the installed CLI's `bound-folder` says which folder, from
 * the session's cwd up, is bound to an outline; an opted-out folder never
 * asks. A disabled Outliner is null; a CLI that cannot answer (one older than
 * `bound-folder`) throws with why, and nothing is fed.
 */
async function sessionWorkspace($: EngineInterface, options: PluginOptions): Promise<Workspace | null> {
  const [listedEnv, modeEnv, home, cwd] = await Promise.all([
    $.env.get('PI_OUTLINER_MENTIONS_WORKSPACES'),
    $.env.get('PI_OUTLINER_MENTIONS_MODE'),
    $.env.get('HOME'),
    $.session.cwd(),
  ])
  const listed = effectiveWorkspaces(options.workspaces, listedEnv, home)
  const mode = mentionsModeOf(options.mode, modeEnv)
  if (mode === 'allowlist' || workspaceForCwd(cwd, listed) !== null) return sessionWorkspaceOf(cwd, mode, listed, null)
  // A remote socket in Claude's environment would take every CLI run elsewhere than the folder's binding.
  const [remote, socket] = await Promise.all([$.env.get('OUTLINER_REMOTE'), $.env.get('OUTLINER_SOCKET_PATH')])
  if (remote?.trim() || socket?.trim()) {
    throw Error("OUTLINER_REMOTE / OUTLINER_SOCKET_PATH in Claude's environment would send it elsewhere than this folder's outline; unset them, or use strict mode (PI_OUTLINER_MENTIONS_MODE=allowlist)")
  }
  const root = await outlinerRootOf($)
  if (!root) return null
  const ran = await $.process.run(
    ['/bin/sh', `${root}/scripts/run-bun.sh`, `${root}/src/cli.ts`, 'bound-folder', cwd],
    { cwd, timeoutMs: 30_000 },
  )
  if (ran.exitCode !== 0) {
    const reason = failureReasonOf(ran.stderr)
    throw Error(/Unknown command: bound-folder/.test(reason)
      ? "the installed Outliner is too old to find this folder's outline (no bound-folder); update it"
      : `bound-folder failed${reason ? `: ${reason}` : ''}`)
  }
  return sessionWorkspaceOf(cwd, mode, listed, boundWorkspaceOf(ran.stdout, cwd))
}

/**
 * Posts one message through the installed CLI's `mentions ingest`. The
 * session's workspace selects the outline, never this process's cwd; an
 * existing connection override in the environment is kept, and no service is
 * started.
 */
async function deliver($: EngineInterface, message: MentionMessage, workspace: Workspace): Promise<void> {
  const root = await outlinerRootOf($)
  if (root === null) return
  const ingested = await $.process.run(
    ['/bin/sh', `${root}/scripts/run-bun.sh`, `${root}/src/cli.ts`, 'mentions', 'ingest'],
    {
      cwd: workspace.root,
      env: envFor(workspace),
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
  workspace: Workspace,
  command: { args: string[]; stdin?: string },
  actor: string,
): Promise<string> {
  return runOutlinerCli($, workspace, [...command.args, '--author', 'agent', '--actor', actor], command.stdin)
}

/**
 * Who this session's writes are attributed to: the tool call's `actor`, else
 * OUTLINER_ACTOR, else EP0CH_AGENT (the door's name for the agent), else
 * claude-code. The session id goes beside it as provenance.
 */
async function actorFor($: EngineInterface, input: Record<string, unknown>): Promise<string> {
  const [OUTLINER_ACTOR, EP0CH_AGENT] = await Promise.all([$.env.get('OUTLINER_ACTOR'), $.env.get('EP0CH_AGENT')])
  return actorOf(input, { ...(OUTLINER_ACTOR ? { OUTLINER_ACTOR } : {}), ...(EP0CH_AGENT ? { EP0CH_AGENT } : {}) })
}

/**
 * Runs the installed CLI in the session's workspace with this session as the
 * write's provenance (`--session`). Resolves to its output; a refusal throws
 * with the CLI's reason.
 */
async function runOutlinerCli($: EngineInterface, workspace: Workspace, args: string[], stdin?: string): Promise<string> {
  const root = await outlinerRootOf($)
  if (!root) throw Error('the Outliner plugin is disabled')
  const sessionId = await $.session.id()
  const ran = await $.process.run(
    ['/bin/sh', `${root}/scripts/run-bun.sh`, `${root}/src/cli.ts`, ...args, '--session', sessionId],
    {
      cwd: workspace.root,
      env: envFor(workspace),
      ...(stdin === undefined ? {} : { stdin }),
      timeoutMs: 60_000,
    },
  )
  if (ran.exitCode !== 0) throw Error(failureReasonOf(ran.stderr) || `${args.slice(0, 2).join(' ')} failed`)
  return ran.stdout.trim()
}

/**
 * One door tool through `ep0ch` on this session's door (EP0CH_CONTROL, passed
 * explicitly). Acting and opening are attributed with --as; the door's
 * refusal (an agent never takes the person's focus) throws with its reason.
 */
async function runDoorTool(
  $: EngineInterface,
  name: string,
  input: Record<string, unknown>,
  control: string,
  option: PluginOptions,
): Promise<string> {
  const ep0ch = async (argv: string[], stdin?: string) => {
    const ran = await $.process.run(argv, { env: { EP0CH_CONTROL: control }, ...(stdin === undefined ? {} : { stdin }), timeoutMs: 15_000 })
    if (ran.exitCode !== 0) throw Error(failureReasonOf(ran.stderr) || ran.stderr.trim() || `${argv.slice(0, 2).join(' ')} failed`)
    return ran.stdout
  }
  const compact = (stdout: string) => {
    try { return JSON.stringify(JSON.parse(stdout)) } catch { return stdout.trim() }
  }
  switch (name) {
    case 'door_where': {
      // An ep0ch older than `where` would open a door on this terminal-less session: its help must list it.
      const help = await $.process.run(['ep0ch', 'help', HELP_PROBE], { timeoutMs: 5000 })
      if (help.exitCode !== 0 || !knowsWhere(help.stdout)) throw Error('this ep0ch is too old for where; update it (ep0ch install)')
      return compact(await ep0ch(['ep0ch', 'where', '--json']))
    }
    case 'door_peek':
      return JSON.stringify(peekOf(await ep0ch(['ep0ch', 'peek'])))
    case 'door_act': {
      const command = doorActArgv(input, await actorFor($, input))
      if (typeof command === 'string') throw Error(command)
      return compact(await ep0ch(command.argv, command.stdin))
    }
    case 'door_open': {
      // The same open as a click or `show`: in this door first (EP0CH_CONTROL is set, or the tool is refused).
      const ref = typeof input.id === 'string' ? input.id.trim() : ''
      const uri = ref ? outlinerUriFor(ref) : null
      if (!uri) throw Error('Give the note to open: its id, ((id)), [[page]] or Work ID.')
      if (!references) await loadReferences($, option)
      try {
        return shownText(await openNote($, references?.workspace ?? null, uri, await actorFor($, input)), ref)
      } catch (error) {
        throw Error(deniedText(error, ref))
      }
    }
    default:
      throw Error(`unknown door tool ${name}`)
  }
}

/**
 * Reads the session's workspace and Work-ID prefixes into `references`. A
 * session whose folder is bound to no outline, or opted out, links nothing; a
 * service that cannot answer leaves pages and block references linked, bare
 * IDs not.
 */
function loadReferences($: EngineInterface, option: PluginOptions): Promise<void> {
  return (loadingReferences ??= readReferences($, option).finally(() => { loadingReferences = undefined }))
}

async function readReferences($: EngineInterface, option: PluginOptions): Promise<void> {
  try {
    const workspace = await sessionWorkspace($, option)
    if (!workspace) {
      references = { workspace: null, prefixes: [] }
      return
    }
    references = { workspace, prefixes: [] }
    const root = await outlinerRootOf($)
    if (!root) return
    const status = await $.process.run(
      ['/bin/sh', `${root}/scripts/run-bun.sh`, `${root}/src/cli.ts`, 'work-id-status'],
      { cwd: workspace.root, env: envFor(workspace), timeoutMs: 30_000 },
    )
    if (status.exitCode !== 0) return
    const { prefix, observedPrefixes } = JSON.parse(status.stdout) as { prefix?: unknown; observedPrefixes?: unknown }
    const prefixes = [prefix, ...(Array.isArray(observedPrefixes) ? observedPrefixes : [])]
      .filter((value): value is string => typeof value === 'string')
    references = { workspace, prefixes: [...new Set(prefixes)] }
  } catch {
    // Linking is a convenience: the reply is drawn as before.
  }
}

/** Where a note was opened: the door this session runs in (and the reader tile it landed in), or Claude's own Detail pane in Herdr. */
type Shown = { title: string; place: 'door' | 'pane'; reader?: string }

/**
 * Neither a door nor Herdr took the note: the message says why and gives its
 * `((id))` to copy. Shown as it is, never prefixed.
 */
class NotOpenedHere extends Error {}

/** A tool's denial for a note it couldn't open: NotOpenedHere as it is, any other reason after the reference. */
function deniedText(error: unknown, reference: string): string {
  if (error instanceof NotOpenedHere) return error.message
  return `Could not show ${reference}: ${error instanceof Error ? error.message : String(error)}`
}

/** How `show` and `door_open` report where a note went. */
function shownText({ title, place, reader }: Shown, reference: string): string {
  const where = place === 'door' ? (reader ? `in the door's ${reader} reader` : 'in the door') : "in Claude's Outliner pane"
  return `Showing ${title || reference} ${where}.`
}

/**
 * Opens an Outliner note where the person reads beside Claude: the one open
 * every path shares (a click on a reference, `show`, `door_open`). In order:
 *
 * 1. In an ep0ch-door tile (EP0CH_CONTROL set): in that door, as the agent's
 *    `open` from this session's tile, landing where the tile's opens go (its
 *    link; the door says which reader). Attributed to `actor`; the door never
 *    lets it take the person's focus, and its refusal is the answer, never
 *    shown somewhere else instead. Only when no door answers on that socket
 *    (it quit) does it go on.
 * 2. In Herdr: Claude's own Detail, the pane this session split below the
 *    Claude pane, reused while it lives, else split anew. It never navigates
 *    the person's Trees or Details, and never takes focus.
 * 3. Otherwise a NotOpenedHere saying why, with the note's `((id))` to copy.
 *
 * `workspace` is the session's Outliner workspace: needed to resolve a page or
 * Work ID and for Herdr; a block id opens in a door without one. Opens run one
 * at a time, so concurrent clicks and tool calls split one pane. Resolves to
 * the title and where it went; throws with the reason otherwise.
 */
function openNote($: EngineInterface, workspace: Workspace | null, uri: string, actor: string): Promise<Shown> {
  const shown = showQueue.then(() => openNow($, workspace, uri, actor))
  showQueue = shown.catch(() => {})
  return shown
}

async function openNow($: EngineInterface, workspace: Workspace | null, uri: string, actor: string): Promise<Shown> {
  const [control, tile, tileId, paneId, herdrWorkspace] = await Promise.all([
    $.env.get('EP0CH_CONTROL'),
    $.env.get('EP0CH_TILE'),
    $.env.get('EP0CH_TILE_ID'),
    $.env.get('HERDR_PANE_ID'),
    $.env.get('HERDR_WORKSPACE_ID'),
  ])
  // Found on first use: outside a door and Herdr, a block id needs no installed Outliner to be named.
  let installed: Promise<string | null> | undefined
  const outliner = async (args: string[]) => {
    const root = await (installed ??= outlinerRootOf($))
    if (!root) throw Error('the Outliner plugin is disabled')
    return $.process.run(
      ['/bin/sh', `${root}/scripts/run-bun.sh`, `${root}/src/cli.ts`, ...args],
      { cwd: workspace?.root ?? await $.session.cwd(), ...(workspace ? { env: envFor(workspace) } : {}), timeoutMs: 30_000 },
    )
  }
  let target: { id: string; title?: string } | undefined
  const resolve = async () => {
    if (target) return target
    if (!workspace) {
      const id = outlinerBlockIdOf(uri)
      if (!id) throw Error("this session's folder is not bound to an Outliner outline to resolve it in; give a block id")
      return (target = { id })
    }
    const resolved = await outliner(['resolve', uri])
    if (resolved.exitCode !== 0) throw Error(failureReasonOf(resolved.stderr) || 'the target did not resolve')
    return (target = JSON.parse(resolved.stdout) as { id: string; title?: string })
  }

  let why: string
  if (control) {
    const { id, title } = await resolve()
    const from = doorTileOf({ ...(tile ? { EP0CH_TILE: tile } : {}), ...(tileId ? { EP0CH_TILE_ID: tileId } : {}) })
    // `--reader middle` only for a door older than `open from=` (ep0ch-door #61), which lands it where this mod
    // always did; a door that knows `from=` never reads it. Drop it once every door has `from=`.
    const opened = await outliner(['door-open', id, '--control', control, '--actor', actor, ...(from ? ['--from', from] : []), '--reader', 'middle'])
    if (opened.exitCode === 0) {
      let reader: unknown
      try { reader = JSON.parse(opened.stdout)?.reader } catch { reader = undefined }
      return { title: title ?? '', place: 'door', ...(typeof reader === 'string' && reader ? { reader } : {}) }
    }
    // The door's refusal (it is on its menu, the reader holds an edit) is the answer.
    if (opened.exitCode !== 3) throw Error(failureReasonOf(opened.stderr) || 'the door did not open it')
    why = `no door answers on ${control} (it quit?)`
  } else {
    why = 'this session is not in an ep0ch-door tile'
  }
  if (paneId && herdrWorkspace && workspace) {
    return { title: await showInHerdrPane($, outliner, workspace, uri), place: 'pane' }
  }
  why += paneId && herdrWorkspace ? ", and its folder is not bound to an Outliner outline for a Herdr pane" : ', nor in Herdr'
  const label = outlinerLabelOf(uri)
  let ref: string
  try {
    ref = `((${(await resolve()).id}))`
  } catch {
    // Unresolved here: the reference as the outline writes it.
    ref = outlinerReferenceOf(uri)
  }
  throw new NotOpenedHere(`Can't open ${label} here: ${why}. Copy ${ref} to open it in the Outliner.`)
}

async function showInHerdrPane(
  $: EngineInterface,
  outliner: (args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
  workspace: Workspace,
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
    detailSplitArgv({ paneId, workspace: workspace.root, ...(workspace.outline ? { outline: workspace.outline } : {}), sessionId, blockId: id, ...(fragmentId ? { fragmentId } : {}) }),
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

/** A click on a reference: opened by `openNote`, or a toast saying why not. */
async function openReference($: EngineInterface, workspace: Workspace, href: string): Promise<void> {
  const uri = outlinerUriOf(href)
  if (!uri) return
  try {
    await openNote($, workspace, uri, await actorFor($, {}))
  } catch (error) {
    if (error instanceof NotOpenedHere) return $.ui.toast(error.message, { timeoutMs: 12_000 })
    const reason = error instanceof Error ? error.message : String(error)
    $.ui.toast(`Could not open ${outlinerLabelOf(uri)} in the Outliner: ${reason}`, { timeoutMs: 6000 })
  }
}
