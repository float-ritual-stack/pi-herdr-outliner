import type { EngineInterface, On, PluginOptions } from 'claude-code'

import {
  effectiveWorkspaces,
  isIngestible,
  type MentionMessage,
  mentionMessageOf,
  workspaceForCwd,
} from './mention-message'
import { destinationOf, linkifyReferences, type OutlinerClient, outlinerUriOf } from './references'

/**
 * What drawing a reply needs, read once per session: the Outliner workspace the
 * session belongs to (null: none configured, nothing is linked) and its Work-ID
 * prefixes. A render hook only reads, so this is loaded beside it, not in it.
 */
type ReferenceContext = { workspace: string | null; prefixes: string[] }
let references: ReferenceContext | undefined
let isLoadingReferences = false

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
    return result
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
    const workspaces = effectiveWorkspaces(
      option,
      await $.env.get('PI_OUTLINER_MENTIONS_WORKSPACES'),
    )
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
      env: { OUTLINER_WORKSPACE_ROOT: message.workspaceRoot },
      stdin: JSON.stringify(message),
      timeoutMs: 30_000,
    },
  )
  if (ingested.exitCode !== 0) {
    const reason = ingested.stderr.trim().split('\n').at(-1) ?? ''
    throw Error(`mentions ingest failed${reason ? `: ${reason}` : ''}`)
  }
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
    const workspaces = effectiveWorkspaces(option, await $.env.get('PI_OUTLINER_MENTIONS_WORKSPACES'))
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
      { cwd: workspace, env: { OUTLINER_WORKSPACE_ROOT: workspace }, timeoutMs: 30_000 },
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

/**
 * Opens a clicked reference in the Outliner: through the live Tree in this
 * Herdr tab, else one in this workspace, with the Outliner's own link
 * navigation (the Tree's linked Detail shows it). Every failure is a toast.
 */
async function openReference($: EngineInterface, workspace: string, href: string): Promise<void> {
  const uri = outlinerUriOf(href)
  if (!uri) return
  const target = decodeURIComponent(uri.slice(uri.indexOf('/', 'pi-outliner://'.length) + 1))
  try {
    const root = await outlinerRootOf($)
    if (!root) throw Error('the Outliner plugin is disabled')
    const [tabId, herdrWorkspace] = await Promise.all([
      $.env.get('HERDR_TAB_ID'),
      $.env.get('HERDR_WORKSPACE_ID'),
    ])
    if (!herdrWorkspace) throw Error('this session is not running inside Herdr')
    const outliner = (args: string[]) => $.process.run(
      ['/bin/sh', `${root}/scripts/run-bun.sh`, `${root}/src/cli.ts`, ...args],
      { cwd: workspace, env: { OUTLINER_WORKSPACE_ROOT: workspace }, timeoutMs: 30_000 },
    )
    const [listedClients, listedPanes] = await Promise.all([
      outliner(['clients']),
      $.process.run(['herdr', 'pane', 'list', '--workspace', herdrWorkspace], { timeoutMs: 5000 }),
    ])
    if (listedClients.exitCode !== 0) throw Error(lastLine(listedClients.stderr) || 'the Outliner service did not answer')
    if (listedPanes.exitCode !== 0) throw Error('Herdr could not list panes')
    const registered: unknown = JSON.parse(listedClients.stdout)
    const clients: OutlinerClient[] = (Array.isArray(registered) ? registered : (registered as { clients?: unknown[] })?.clients ?? [])
      .flatMap((client: any) => typeof client?.runtime?.paneId === 'string'
        ? [{ clientId: String(client.clientId), role: String(client.role), paneId: client.runtime.paneId }]
        : [])
    const panes: unknown = JSON.parse(listedPanes.stdout)?.result?.panes
    const paneTabs = new Map((Array.isArray(panes) ? panes : []).map((pane: any) => [String(pane.pane_id), String(pane.tab_id)]))
    const destination = destinationOf(clients, paneTabs, tabId)
    if (!destination) {
      $.ui.toast(`No Outliner Tree is open in this Herdr workspace to show ${target}`, { timeoutMs: 6000 })
      return
    }
    const navigated = await outliner([
      'link', uri, '--source-client', destination.clientId,
      ...(destination.role === 'composed' ? ['--source-region', 'tree'] : []),
    ])
    if (navigated.exitCode !== 0) throw Error(lastLine(navigated.stderr) || 'navigation failed')
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    $.ui.toast(`Could not open ${target} in the Outliner: ${reason}`, { timeoutMs: 6000 })
  }
}

function lastLine(text: string): string {
  return text.trim().split('\n').at(-1) ?? ''
}
