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
 */
export function workspacesOf(value: unknown): string[] {
  const parts = Array.isArray(value)
    ? value.filter((part): part is string => typeof part === 'string')
    : typeof value === 'string'
      ? value.split(/[:,]/)
      : []
  return parts
    .map(part => part.trim().replace(/(?<=.)\/+$/, ''))
    .filter(part => part.startsWith('/'))
}

/**
 * Which completed turns reach Recent Mentions: the main loop's own answers,
 * never a subagent's run, an interruption, a refusal or an error.
 */
export function isIngestible(e: TurnCompleteInput): boolean {
  return e.agentId === undefined && e.reason === 'answer' && e.answer.trim() !== ''
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
  const cwd = session.cwd.replace(/(?<=.)\/+$/, '')
  if (!workspaces.includes(cwd)) return null
  return {
    workspaceRoot: cwd,
    agent: 'claude',
    sessionId: session.id,
    messageId: e.turnId,
    text: e.answer,
  }
}
