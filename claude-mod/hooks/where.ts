/**
 * Where this session runs: the stack of layers outside it (ssh, Herdr, an
 * ep0ch-door and its tile), from ep0ch-door's `EP0CH_NEST`, checked by
 * `ep0ch where --json`. Claude gets it as one context block, so it never has
 * to guess from the repo name or a window title.
 *
 * `EP0CH_NEST` is one line, outermost first, with ` › ` between layers:
 *   ssh:pts/5 › herdr:w1:p1 › door:1388380/desk/t1:claude › herdr:door-claude
 * (ep0ch-door's docs/AGENT-INTERFACE.md, "Where am I").
 */

/** The variables a door gives a tile's program (and the daily agent's Herdr pane). */
export type DoorEnv = {
  EP0CH_NEST?: string
  EP0CH_CONTROL?: string
  EP0CH_TILE?: string
  EP0CH_TILE_ID?: string
}

export const WHERE_BLOCK = 'whereAmI'
/** How long `ep0ch where` may take: it asks a door and Herdr, each with its own shorter timeout. */
export const WHERE_TIMEOUT_MS = 8000
/** How long the first prompt waits for it before using the variables alone. */
export const WHERE_WAIT_MS = 1500

/**
 * The extra argument `ep0ch help` is asked with: a socket path that never
 * exists. Every ep0ch with `help` prints its usage and ignores it; one older
 * than `help` takes it for the socket to open and stops at "no carrier",
 * instead of opening a door on the default outline.
 */
export const HELP_PROBE = '/nonexistent/ep0ch-where-probe.sock'

/** One line: control characters (a newline in an inherited EP0CH_NEST) become spaces. */
const oneLine = (s: string): string => s.replace(/[\x00-\x1f\x7f]+/g, ' ').trim()

/** Whether to look at all: only a session a door started (or its Herdr agent pane). */
export const inDoorEnv = (env: DoorEnv): boolean => !!(env.EP0CH_NEST?.trim() || env.EP0CH_CONTROL?.trim())

/** `ep0ch help` lists `where`: this ep0ch has it (an older one would open a door instead). */
export const knowsWhere = (help: string): boolean => /^\s*ep0ch where\b/m.test(help)

/**
 * The summary `ep0ch where --json` printed, or null when its output isn't
 * that (an ep0ch too old to know `where` prints its usage or an error).
 */
export function whereSummaryOf(stdout: string): string | null {
  try {
    const parsed: unknown = JSON.parse(stdout)
    const summary = (parsed as { summary?: unknown } | null)?.summary
    return typeof summary === 'string' && oneLine(summary) ? oneLine(summary).slice(0, 1000) : null
  } catch {
    return null
  }
}

/** What the variables alone say, when `ep0ch where` can't be run: unchecked. */
export function envSummaryOf(env: DoorEnv): string {
  const nest = oneLine(env.EP0CH_NEST ?? '').slice(0, 1000)
  const tile = oneLine(env.EP0CH_TILE_ID || env.EP0CH_TILE || '').slice(0, 120)
  return [
    nest ? `stack: ${nest}` : `in an ep0ch-door tile${tile ? ` (${tile})` : ''}, from a door older than EP0CH_NEST`,
    'unchecked: `ep0ch where` could not run, so no layer was checked and where the keys are is unknown',
  ].join(' · ')
}

/** The context block's text. */
export function whereText(summary: string): string {
  return [
    `This Claude session runs inside these layers (outermost first; EP0CH_NEST): ${summary}.`,
    'Trust this over guesses from the repo name, window titles or other agents. `ep0ch where` checks it again, read-only.',
    'To see or act in this door (what the person sees, opening a note in front of them, marks, tiles), use the ep0ch skill: `ep0ch peek` and `ep0ch actions` read; `ep0ch act <action> … --as <your name>` acts, attributed, and never takes the person\'s keys. EP0CH_CONTROL already points at this door.',
  ].join('\n')
}

/**
 * The tile `door-open --from` names: EP0CH_TILE, the name the door's links and
 * the daily layout use (it survives a door restart for an agent kept in its
 * Herdr pane), else the tile's id (`t<n>`) when the name is empty. The door
 * takes either; one it doesn't know falls back to `--reader middle`, then to
 * where its own open puts notes (src/door-control.ts).
 */
export function doorTileOf(env: { EP0CH_TILE?: string; EP0CH_TILE_ID?: string }): string | null {
  const name = env.EP0CH_TILE?.trim()
  if (name) return name
  const id = env.EP0CH_TILE_ID?.trim()
  return id && /^t\d+$/.test(id) ? id : null
}

