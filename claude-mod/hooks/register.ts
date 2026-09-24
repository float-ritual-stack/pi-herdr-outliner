import type { EngineInterface, On, PluginOptions } from 'claude-code'

import { isIngestible, type MentionMessage, mentionMessageOf, workspacesOf } from './mention-message'

/**
 * Registers Recent Mentions: each completed main-loop answer in a configured
 * workspace goes to the Outliner, as the Codex Stop hook sends Codex's.
 *
 * Workspaces come from the `workspaces` option, or, when unset, from
 * `PI_OUTLINER_MENTIONS_WORKSPACES` (for a `CLAUDE_CODE_PLUGIN_DIRS` setup,
 * whose settings `env` block can carry it). Neither set: nothing is ingested.
 *
 * The answer passes on untouched. Delivery runs off the turn's dispatch, so a
 * slow or absent service never delays the prompt; a failure is one toast.
 */
export function register(on: On, options: PluginOptions): void {
  const configured = options.workspaces === undefined ? undefined : workspacesOf(options.workspaces)

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!isIngestible(e)) return result
    const workspaces = configured
      ?? workspacesOf(await $.env.get('PI_OUTLINER_MENTIONS_WORKSPACES'))
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
