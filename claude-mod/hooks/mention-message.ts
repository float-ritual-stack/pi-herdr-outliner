import type { TurnCompleteInput } from 'claude-code'

/**
 * The host-neutral contract `mentions.ingest` takes; `src/mentions-types.ts`
 * owns it. Restated here because a hooks module cannot import application code.
 */
export type MentionMessage = {
  workspaceRoot: string
  agent: 'claude'
  sessionId: string
  messageId: string
  text: string
}

/**
 * A folder list as configured (the `workspaces` option or
 * `PI_OUTLINER_MENTIONS_WORKSPACES`): one absolute folder or several,
 * separated by ':' or ','. Trailing slashes are dropped so `/a/b/` matches a
 * cwd of `/a/b`. An entry names a folder only; any other entry is an error,
 * never skipped. In folder mode the list opts folders out; in allowlist mode
 * it is the only folders that feed an outline (`mentionsModeOf`).
 */
export function workspacesOf(value: unknown, home?: string): string[] {
  const parts = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[:,]/) : []
  return parts.flatMap(part => {
    if (typeof part !== 'string') throw Error(`Outliner workspaces entry ${JSON.stringify(part)} is not a folder path`)
    const typed = part.trim()
    // `~` and `~/…` are written by people; expand them when the home folder is known.
    const entry = home && (typed === '~' || typed.startsWith('~/')) ? home.replace(/\/+$/, '') + typed.slice(1) : typed
    if (entry === '') return []
    if (!entry.startsWith('/') || entry.includes('=')) {
      throw Error(`Outliner workspaces entry "${entry}" is not an absolute folder; list folders only, and bind a folder to an outline in its client.json (the choose-outline action)`)
    }
    return [entry.replace(/(?<=.)\/+$/, '')]
  })
}

/**
 * The option when it names at least one folder, otherwise the environment
 * variable. Claude Code passes an unset string option as '', so an empty
 * option cannot be told from an unset one and never overrides the environment.
 */
export function effectiveWorkspaces(option: unknown, environment: string | undefined, home?: string): string[] {
  const configured = workspacesOf(option, home)
  return configured.length > 0 ? configured : workspacesOf(environment, home)
}

/**
 * How a session's folder finds its outline:
 *
 * - `folder`: the nearest folder bound to an outline, the way every Outliner
 *   client resolves it (`bound-folder`: a `client.json`, or an outline root the
 *   host serves). The folder list opts folders out. An unbound folder feeds
 *   nothing; it never falls back to a default outline.
 * - `allowlist`: only the listed folders, as before folder mode (the strict mode).
 */
export type MentionsMode = 'folder' | 'allowlist'

/**
 * The `mode` option when set, otherwise `PI_OUTLINER_MENTIONS_MODE`; neither:
 * `folder`. A list with no mode is opted out, so a list that was the allowlist
 * before folder mode fails closed (its folders feed nothing) until strict mode
 * is set or the list removed. Any other value is an error, never read as one.
 */
export function mentionsModeOf(option: unknown, environment: string | undefined): MentionsMode {
  const typed = typeof option === 'string' && option.trim() !== '' ? option.trim() : (environment ?? '').trim()
  if (typed === '' || typed === 'folder' || typed === 'allowlist') return typed === 'allowlist' ? 'allowlist' : 'folder'
  throw Error(`Outliner mentions mode "${typed}" is neither folder nor allowlist`)
}

/**
 * The folder a session's Outliner CLI runs start from. A bound folder (folder
 * mode) is `pinned` to the outline `bound-folder` found, `outline` when it
 * names a host outline: its CLI runs go there whatever Claude's environment
 * says. A strict-mode folder is the CLI's to resolve, as before folder mode.
 */
export type Workspace = { root: string; outline?: string; pinned?: true }

/**
 * The environment an Outliner CLI run gets for a workspace: its folder and,
 * when pinned, the outline that bound it, blanking an inherited
 * OUTLINER_OUTLINE or OUTLINER_CONFIG_PATH so the write lands where the folder
 * was found bound (`resolveClientPaths` reads an empty one as unset).
 */
export function workspaceEnvOf(workspace: Workspace): Record<string, string> {
  return {
    OUTLINER_WORKSPACE_ROOT: workspace.root,
    ...(workspace.pinned ? { OUTLINER_OUTLINE: workspace.outline ?? '', OUTLINER_CONFIG_PATH: '' } : {}),
  }
}

/**
 * The bound folder in `bound-folder`'s answer for `cwd`, or null: unbound, or
 * an answer that is not one (a folder that does not contain `cwd` is not).
 */
export function boundWorkspaceOf(stdout: string, cwd: string): Workspace | null {
  let answer: unknown
  try { answer = JSON.parse(stdout) } catch { return null }
  if (!answer || typeof answer !== 'object') return null
  const { bound, source, folder, outline } = answer as Record<string, unknown>
  if (bound !== true || typeof folder !== 'string') return null
  const root = absolutePath(folder)
  if (root === null || workspaceForCwd(cwd, [root]) !== root) return null
  const named = typeof outline === 'string' && outline !== '' ? outline : undefined
  if (source === 'host-root') return named ? { root, outline: named, pinned: true } : null
  // A client.json naming a host outline is pinned to it; a local or remote choice is the folder's config to resolve.
  if (source !== 'client') return null
  const { mode } = answer as Record<string, unknown>
  return mode === 'host' ? (named ? { root, outline: named, pinned: true } : null) : { root, pinned: true }
}

/**
 * The workspace a session in `cwd` feeds, or null. In folder mode a listed
 * folder (or one inside it) is opted out, and otherwise the bound folder wins;
 * in allowlist mode the nearest listed folder, bound or not.
 */
export function sessionWorkspaceOf(
  cwd: string,
  mode: MentionsMode,
  listed: readonly string[],
  bound: Workspace | null,
): Workspace | null {
  const nearestListed = workspaceForCwd(cwd, listed)
  if (mode === 'allowlist') return nearestListed === null ? null : { root: nearestListed }
  return nearestListed === null ? bound : null
}

/**
 * The reason in an Outliner CLI failure's stderr: Bun prints the thrown
 * error's source excerpt, then `error: <message>`, its stack and a `Bun v…`
 * trailer, so the last line never says why. Falls back to the last line that
 * is not stack or trailer; '' when nothing is left.
 */
export function failureReasonOf(stderr: string): string {
  const lines = stderr.split('\n').map(line => line.trim()).filter(Boolean)
  const error = lines.findLast(line => line.startsWith('error: '))
  if (error) return error.slice('error: '.length)
  return lines.findLast(line => !/^at\s|^Bun v\d/.test(line)) ?? ''
}

/**
 * Which completed turns reach Recent Mentions: the main loop's own answers,
 * never a subagent's run, an interruption, a refusal or an error.
 */
export function isIngestible(e: TurnCompleteInput): boolean {
  return e.agentId === undefined && e.reason === 'answer' && e.answer.trim() !== ''
}

// Lexical POSIX paths: no host filesystem access or Git-root assumptions.
function absolutePath(path: string): string | null {
  if (!path.startsWith('/')) return null
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '..') parts.pop()
    else if (part !== '' && part !== '.') parts.push(part)
  }
  return '/' + parts.join('/')
}

/** Nested configured roots own their descendants; siblings never match a prefix. */
export function workspaceForCwd(cwd: string, workspaces: readonly string[]): string | null {
  const path = absolutePath(cwd)
  if (path === null) return null
  let nearest: string | null = null
  for (const workspace of workspaces) {
    const root = absolutePath(workspace)
    if (root === null) continue
    if ((path === root || path.startsWith(root === '/' ? '/' : root + '/')) &&
        (nearest === null || root.length > nearest.length)) nearest = root
  }
  return nearest
}

/**
 * The message for one completed turn in a session feeding `workspace`, or
 * null when the turn is not ingested or the session feeds none. The turn id
 * is the message identity, so a repeated delivery of the same turn
 * deduplicates in the service.
 */
export function mentionMessageOf(
  e: TurnCompleteInput,
  session: { id: string },
  workspace: Workspace | null,
): MentionMessage | null {
  if (!isIngestible(e) || workspace === null) return null
  return {
    workspaceRoot: workspace.root,
    agent: 'claude',
    sessionId: session.id,
    messageId: e.turnId,
    text: e.answer,
  }
}
