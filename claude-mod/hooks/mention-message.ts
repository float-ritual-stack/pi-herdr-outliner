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
 * The workspaces option as configured: one absolute folder or several,
 * separated by ':' or ','. Trailing slashes are dropped so `/a/b/` matches a
 * cwd of `/a/b`. An entry names a folder only: which outline it feeds is
 * resolved by the Outliner CLI from that folder's `client.json`, the same way
 * for every client. Any other entry is an error, never skipped.
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
 * The option when it names at least one workspace, otherwise the environment
 * variable. Claude Code passes an unset string option as '', so an empty
 * option cannot be told from an unset one and never overrides the environment.
 */
export function effectiveWorkspaces(option: unknown, environment: string | undefined, home?: string): string[] {
  const configured = workspacesOf(option, home)
  return configured.length > 0 ? configured : workspacesOf(environment, home)
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
 * The message for one completed turn, or null when the turn or its workspace
 * is not ingested. The turn id is the message identity, so a repeated delivery
 * of the same turn deduplicates in the service.
 */
export function mentionMessageOf(
  e: TurnCompleteInput,
  session: { id: string; cwd: string },
  workspaces: readonly string[],
): MentionMessage | null {
  if (!isIngestible(e)) return null
  const workspaceRoot = workspaceForCwd(session.cwd, workspaces)
  if (workspaceRoot === null) return null
  return {
    workspaceRoot,
    agent: 'claude',
    sessionId: session.id,
    messageId: e.turnId,
    text: e.answer,
  }
}
