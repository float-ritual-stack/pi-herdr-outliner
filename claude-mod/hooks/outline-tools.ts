/**
 * Outline and door tools for Claude (PIE-504), so an agent never hand-rolls a
 * script to read, edit or comment on a note, or to act in the door it runs in.
 *
 * - `outline_*`: each is one call to the installed CLI's `agent <operation>`
 *   (src/agent-tools.ts) with the tool's input as JSON on stdin. The service and
 *   that module own the rules; this file only names the operation and checks
 *   the input's shape.
 * - `door_*`: each is one `ep0ch` command on the session's EP0CH_CONTROL, the
 *   door this Claude runs in. They exist only when EP0CH_CONTROL is set. The
 *   door enforces its rules (an agent never takes the person's focus); its
 *   refusals come back as the tool's denial.
 *
 * Every write is `author: agent`, attributed to the actor `actorOf` picks.
 */

type Json = Record<string, unknown>

export interface OutlineToolDefinition {
  name: string
  description: string
  inputSchema: Json
  /** The CLI `agent` operation and its JSON input, or the reason the input is unusable. */
  command(input: Record<string, unknown>): { operation: string; input: Json } | string
}

const ACTOR = {
  type: 'string',
  description: 'Who this is attributed to. Leave it out: it defaults to OUTLINER_ACTOR, EP0CH_AGENT or claude-code.',
}
const REF = {
  type: 'string',
  description: 'The block: its id, ((id)), [[page]] or a Work ID (PIE-123). Never a title: find it with outline_find first.',
}
const EXPECTED = {
  type: 'integer',
  minimum: 1,
  description: 'The revision outline_read returned. A block that changed since is refused: read it again.',
}

/** A write's schema carries `actor`, the attribution override; a read's has none (outline_changes' `actor` is a filter). */
function schema(properties: Json, required: string[], writes = true): Json {
  return { type: 'object', properties: writes ? { ...properties, actor: ACTOR } : properties, required, additionalProperties: false }
}

/** The input without the actor, which travels as a CLI flag, and without keys left undefined. */
function inputOf(input: Record<string, unknown>, keys: readonly string[]): Json {
  const out: Json = {}
  for (const key of keys) if (input[key] !== undefined) out[key] = input[key]
  return out
}

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''

export const OUTLINE_TOOLS: readonly OutlineToolDefinition[] = [
  {
    name: 'outline_read',
    description:
      "Read a note: its full text (never just the title), properties, revision, who last wrote it and when, and its " +
      'children to `depth` levels (default 1), at most `limit` descendants (default 50), each with full text. ' +
      '`complete` says whether anything was left out; a child with `more` has unread children. Read before you ' +
      'edit: outline_edit and outline_patch need the revision this returns.',
    inputSchema: schema({
      ref: REF,
      depth: { type: 'integer', minimum: 0, maximum: 6 },
      limit: { type: 'integer', minimum: 0, maximum: 500 },
    }, ['ref'], false),
    command(input) {
      if (!nonEmpty(input.ref)) return 'Give the ref: a block id, ((id)), [[page]] or Work ID.'
      return { operation: 'read', input: inputOf(input, ['ref', 'depth', 'limit']) }
    },
  },
  {
    name: 'outline_find',
    description:
      'Find blocks by text, a property (`key=value`, or `key`), a property key (hasKey), a query in the saved-view ' +
      'grammar (`type=roadmap-item AND work-stage=doing`), or a saved view. text, property, hasKey, query and under ' +
      'combine; view stands alone. Returns rows (id, title, revision); read one with outline_read.',
    inputSchema: schema({
      text: { type: 'string' },
      property: { type: 'string', description: 'key=value, or key for any value' },
      hasKey: { type: 'string' },
      query: { type: 'string' },
      view: { type: 'string', description: 'A saved view (virtual branch): its id or ((id))' },
      under: { type: 'string', description: 'Only blocks under this one (a ref)' },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
    }, [], false),
    command(input) {
      if (!['text', 'property', 'hasKey', 'query', 'view'].some(key => nonEmpty(input[key]))) {
        return 'Give text, property, hasKey, query or view to find blocks by.'
      }
      return { operation: 'find', input: inputOf(input, ['text', 'property', 'hasKey', 'query', 'view', 'under', 'limit']) }
    },
  },
  {
    name: 'outline_resolve',
    description:
      'Resolve a reference ([[page]], ((id)), a Work ID or an id) to its block id, title and revision, without ' +
      'reading the whole note. An unknown page is an error, never a new page.',
    inputSchema: schema({ ref: REF }, ['ref'], false),
    command(input) {
      if (!nonEmpty(input.ref)) return 'Give the ref to resolve.'
      return { operation: 'resolve', input: inputOf(input, ['ref']) }
    },
  },
  {
    name: 'outline_edit',
    description:
      'Rewrite a note, checked against the revision you read with outline_read: its whole `text`, one ' +
      '`replaceSection` (the text under a heading, subheadings included, as Detail folds it), or an `append` at the end. Give exactly one. ' +
      'Refused before anything is written: an empty or whitespace-only result, a stale revision (read again, then ' +
      'edit), and dropping a [page::…] property or an ^anchor other notes link to (pass allowStructural: true only ' +
      'when removing them is the point). Returns the new revision and a short diff. Use it for rewriting your own ' +
      'pages, such as a status page; for small edits to a note the person may be typing in, use outline_patch.',
    inputSchema: schema({
      ref: REF,
      expectedRevision: EXPECTED,
      text: { type: 'string', description: 'The whole new text: title line, properties and body' },
      replaceSection: {
        type: 'object',
        properties: {
          heading: { type: 'string', description: 'Heading text, optionally with its ## level' },
          body: { type: 'string' },
        },
        required: ['heading', 'body'],
        additionalProperties: false,
      },
      append: { type: 'string', description: 'Added as a new paragraph at the end (start it with a newline to join the last line)' },
      allowStructural: { type: 'boolean' },
    }, ['ref', 'expectedRevision']),
    command(input) {
      if (!nonEmpty(input.ref)) return 'Give the ref of the note to edit.'
      if (typeof input.expectedRevision !== 'number') return 'Give expectedRevision: read the note with outline_read first.'
      const modes = ['text', 'replaceSection', 'append'].filter(key => input[key] !== undefined && input[key] !== null)
      if (modes.length !== 1) return 'Give exactly one of text, replaceSection or append.'
      if (modes[0] === 'text' && !nonEmpty(input.text)) return 'The new text is empty; an edit never blanks a note.'
      if (modes[0] === 'append' && !nonEmpty(input.append)) return 'The text to append is empty.'
      return { operation: 'edit', input: inputOf(input, ['ref', 'expectedRevision', 'text', 'replaceSection', 'append', 'allowStructural']) }
    },
  },
  {
    name: 'outline_create',
    description:
      'Create a block under `parent` (a ref, or root), at `position` among its siblings (0 is first; default last). ' +
      'Returns its id, ((ref)) and revision.',
    inputSchema: schema({
      parent: { type: 'string', description: 'The parent: a ref, or root' },
      text: { type: 'string' },
      position: { type: 'integer', minimum: 0 },
    }, ['parent', 'text']),
    command(input) {
      if (!nonEmpty(input.parent) || !nonEmpty(input.text)) return 'Give the parent and non-empty text.'
      return { operation: 'create', input: inputOf(input, ['parent', 'text', 'position']) }
    },
  },
  {
    name: 'outline_comment',
    description:
      'Start a comment thread on a note, as you: on an exact `quote` of its source text (add start, prefix or ' +
      'suffix when the quote repeats), or on the `whole` note. Returns the thread id for outline_reply and ' +
      'outline_resolve_thread. A requestId makes a retry return the same thread.',
    inputSchema: schema({
      ref: REF,
      body: { type: 'string' },
      quote: { type: 'string', description: 'Exact source text the comment is about' },
      whole: { type: 'boolean', description: 'true: about the whole note, instead of a quote' },
      start: { type: 'integer', minimum: 0, description: 'The quote’s UTF-16 offset, when it repeats' },
      prefix: { type: 'string' },
      suffix: { type: 'string' },
      requestId: { type: 'string' },
    }, ['ref', 'body']),
    command(input) {
      if (!nonEmpty(input.ref) || !nonEmpty(input.body)) return 'Give the note and a non-empty comment.'
      if ((input.whole === true) === (typeof input.quote === 'string')) return 'Give either quote (exact source text) or whole: true.'
      return { operation: 'comment', input: inputOf(input, ['ref', 'body', 'quote', 'whole', 'start', 'prefix', 'suffix', 'requestId']) }
    },
  },
  {
    name: 'outline_reply',
    description: 'Reply in a comment thread, as you. `thread` is the id outline_comment returned (or a thread you read).',
    inputSchema: schema({ thread: { type: 'string' }, body: { type: 'string' }, requestId: { type: 'string' } }, ['thread', 'body']),
    command(input) {
      if (!nonEmpty(input.thread) || !nonEmpty(input.body)) return 'Give the thread and a non-empty reply.'
      return { operation: 'reply', input: inputOf(input, ['thread', 'body', 'requestId']) }
    },
  },
  {
    name: 'outline_resolve_thread',
    description: 'Resolve a comment thread (resolved: true), or reopen it (false), as you.',
    inputSchema: schema({ thread: { type: 'string' }, resolved: { type: 'boolean' } }, ['thread', 'resolved']),
    command(input) {
      if (!nonEmpty(input.thread) || typeof input.resolved !== 'boolean') return 'Give the thread and resolved: true or false.'
      return { operation: 'resolve-thread', input: inputOf(input, ['thread', 'resolved']) }
    },
  },
  {
    name: 'outline_changes',
    description:
      'What changed since a point: an ISO time, or the `cursor` an earlier call returned. Each block once, at its ' +
      'latest change, newest first, with who made it (author, actorId, sessionId). `author` (user, agent, system) and ' +
      '`actor` (an agent id, such as claude-code) narrow it. `complete: false`: more changed than `limit`; call again ' +
      'with the same since and the returned `before` for older ones. Once complete, pass `cursor` as since next time.',
    inputSchema: schema({
      since: { type: ['string', 'integer'], description: 'An ISO time, or a cursor from an earlier call' },
      author: { type: 'string', enum: ['user', 'agent', 'system'] },
      actor: { type: 'string', description: 'Only this agent’s changes, by actor id (claude-code, garden-agent…)' },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      before: { type: 'integer', minimum: 1, description: 'The `before` an incomplete answer returned: its older changes' },
    }, ['since'], false),
    command(input) {
      if (!nonEmpty(input.since) && typeof input.since !== 'number') return 'Give since: an ISO time or a cursor.'
      return { operation: 'changes', input: inputOf(input, ['since', 'author', 'actor', 'limit', 'before']) }
    },
  },
  {
    name: 'outline_patch',
    description:
      'Small edits to a note the person may be typing in, without waiting for their save (draft.patch); for ' +
      'rewriting your own pages, such as a status page, use outline_edit. Each patch names the exact `observed` text ' +
      '(never empty) and its `replacement`, against the `revision` outline_read returned; all apply as one edit or ' +
      'none. A live draft gets it in place; otherwise it is an ordinary edit of the saved note. policy `edit` (the ' +
      'default) has outline_edit\'s guard (allowStructural likewise); `prose` keeps every link, anchor and property. ' +
      'If the text changed under it, or prose refuses, it becomes one proposal for the person (outcome: proposed).',
    inputSchema: schema({
      ref: REF,
      revision: EXPECTED,
      patches: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            observed: { type: 'string' },
            replacement: { type: 'string' },
            range: {
              type: 'object',
              properties: { start: { type: 'integer', minimum: 0 }, end: { type: 'integer', minimum: 0 } },
              required: ['start', 'end'],
              description: 'Where you saw it (UTF-16 offsets): a hint',
            },
          },
          required: ['observed', 'replacement'],
        },
      },
      mark: { type: 'string', description: 'The @request line the patch answers: spans must end above it' },
      policy: { type: 'string', enum: ['edit', 'prose'], default: 'edit' },
      allowStructural: { type: 'boolean' },
    }, ['ref', 'revision', 'patches']),
    command(input) {
      if (!nonEmpty(input.ref) || typeof input.revision !== 'number') return 'Give the ref and the revision you read.'
      if (!Array.isArray(input.patches) || input.patches.length === 0) return 'Give at least one patch: {observed, replacement}.'
      if (input.policy !== undefined && input.policy !== 'edit' && input.policy !== 'prose') return 'policy is edit (the default) or prose.'
      return { operation: 'patch', input: { policy: 'edit', ...inputOf(input, ['ref', 'revision', 'patches', 'mark', 'policy', 'allowStructural']) } }
    },
  },
]

// ─── Door tools ────────────────────────────────────────────────────────────

export interface DoorToolDefinition {
  name: string
  description: string
  inputSchema: Json
}

export const DOOR_TOOLS: readonly DoorToolDefinition[] = [
  {
    name: 'door_where',
    description:
      'Where this session runs (ep0ch where): the layers (ssh › herdr › door tile), which are live, and whether the ' +
      'person is typing in your tile. Only reads.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'door_peek',
    description: 'What the door shows the person now (ep0ch peek): the screen as structured state and as text. Only reads.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'door_act',
    description:
      "Run one of the door's actions as you (ep0ch act, attributed with --as and said on the person's screen). " +
      '`ep0ch actions` names them; door_peek shows the state they act on. The door never lets an agent take the ' +
      "person's focus, keys or selection: such an action is refused with the reason, which comes back as this " +
      "tool's error. To point the person at something, use block.mark. To open a note, door_open.",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'The action name, e.g. layout.get, view.scrollTo, block.mark' },
        args: {
          type: 'object',
          additionalProperties: { type: ['string', 'number', 'boolean'] },
          description: 'The action’s arguments, key: value',
        },
        reader: { type: 'string', description: 'The reader tile to act in, when the action needs one' },
        actor: ACTOR,
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'door_open',
    description:
      'Open a note in the door this session runs in, where your tile’s opens land (from=$EP0CH_TILE), as you. It ' +
      "never moves the person's focus; the door says which reader it went to.",
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'A block id, ((id)), [[page]] or Work ID' }, actor: ACTOR },
      required: ['id'],
      additionalProperties: false,
    },
  },
]

const ACT_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/

/**
 * `ep0ch act` argv (and stdin) for an action as `actor`. Values go as
 * `key=value` words. `ep0ch` reads a value starting with `@` as a file (`@-`
 * as stdin), so one such value is sent through stdin instead; a second is
 * refused rather than read as a path.
 */
export function doorActArgv(
  input: Record<string, unknown>,
  actor: string,
): { argv: string[]; stdin?: string } | string {
  const action = input.action
  if (!nonEmpty(action) || /\s/.test(action)) return 'Give the action name (door_peek and `ep0ch actions` list them).'
  const args = input.args ?? {}
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return 'args is an object of key: value.'
  const words: string[] = []
  let stdin: string | undefined
  for (const [key, raw] of Object.entries(args as Record<string, unknown>)) {
    if (!ACT_KEY.test(key) || key === 'as' || key === 'reader') return `"${key}" is not an argument name (use reader and actor for those).`
    if (!['string', 'number', 'boolean'].includes(typeof raw)) return `${key} must be a string, number or boolean.`
    const value = String(raw)
    if (value.startsWith('@')) {
      if (stdin !== undefined) return 'Only one argument may start with @.'
      stdin = value
      words.push(`${key}=@-`)
    } else {
      words.push(`${key}=${value}`)
    }
  }
  if (input.reader !== undefined) {
    if (!nonEmpty(input.reader) || String(input.reader).startsWith('@')) return 'reader is a tile name.'
    words.push(`reader=${input.reader}`)
  }
  return { argv: ['ep0ch', 'act', action, ...words, '--as', actor], ...(stdin === undefined ? {} : { stdin }) }
}

/**
 * `ep0ch peek` prints the screen's state as indented JSON, then the screen's
 * text. Both, as one compact value; the text alone when the state doesn't parse.
 */
export function peekOf(stdout: string): { screen?: unknown; text: string } {
  const lines = stdout.split('\n')
  const end = lines.findIndex(line => line === '}' || line === ']')
  if (lines[0]?.startsWith('{') || lines[0]?.startsWith('[')) {
    try {
      return { screen: JSON.parse(lines.slice(0, end + 1).join('\n')), text: lines.slice(end + 1).join('\n').trimEnd() }
    } catch {
      // Not the state this expects: the text alone.
    }
  }
  return { text: stdout.trimEnd() }
}

/**
 * Who a write is attributed to: the caller's `actor`, else OUTLINER_ACTOR, else
 * EP0CH_AGENT (the door's own name for the agent), else claude-code.
 */
export function actorOf(input: Record<string, unknown>, env: { OUTLINER_ACTOR?: string; EP0CH_AGENT?: string }): string {
  for (const candidate of [input.actor, env.OUTLINER_ACTOR, env.EP0CH_AGENT]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return 'claude-code'
}
