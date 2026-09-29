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
 * The workspaces option as configured: one path or several separated by ':'
 * or ','. Trailing slashes are dropped so `/a/b/` matches a cwd of `/a/b`.
 * An entry may bind its folder to an outline on the outline host by name:
 * `/work/fred-folder=fred`.
 */
export function workspaceBindingsOf(value: unknown): { root: string; outline?: string }[] {
  const parts = Array.isArray(value)
    ? value.filter((part): part is string => typeof part === 'string')
    : typeof value === 'string'
      ? value.split(/[:,]/)
      : []
  return parts
    .map(part => {
      const [path = '', outline] = part.trim().split('=', 2)
      const root = path.trim().replace(/(?<=.)\/+$/, '')
      const name = outline?.trim()
      return name && /^[a-z0-9][a-z0-9-]{0,31}$/.test(name) ? { root, outline: name } : { root }
    })
    .filter(binding => binding.root.startsWith('/'))
}

export function workspacesOf(value: unknown): string[] {
  return workspaceBindingsOf(value).map(binding => binding.root)
}

/**
 * The workspaces in force: the option when it names any, else the environment
 * variable. Claude Code passes an unset string option as '', so an empty
 * option cannot be told from an unset one and never overrides the environment.
 */
export function effectiveWorkspaceBindings(option: unknown, environment: string | undefined): { root: string; outline?: string }[] {
  const configured = workspaceBindingsOf(option)
  return configured.length > 0 ? configured : workspaceBindingsOf(environment)
}

export function effectiveWorkspaces(option: unknown, environment: string | undefined): string[] {
  return effectiveWorkspaceBindings(option, environment).map(binding => binding.root)
}

/**
 * The environment an Outliner CLI run or pane gets for one workspace: its
 * folder, and the outline it is bound to when the entry names one.
 */
export function outlinerEnvironment(
  workspace: string,
  bindings: readonly { root: string; outline?: string }[],
): Record<string, string> {
  const outline = bindings.find(binding => binding.root === workspace)?.outline
  return { OUTLINER_WORKSPACE_ROOT: workspace, ...(outline ? { OUTLINER_OUTLINE: outline } : {}) }
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
