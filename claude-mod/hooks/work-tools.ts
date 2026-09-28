/**
 * Workboard tools for Claude: each one is a thin call to the installed CLI's
 * `work` / `note` commands (src/work-tools.ts), so Claude, Codex and Pi share
 * one implementation. This file only turns tool arguments into CLI argv.
 */

type Json = Record<string, unknown>

export interface WorkToolDefinition {
  name: string
  description: string
  inputSchema: Json
  /** The CLI arguments and stdin for one call, or the reason the input is unusable. */
  command(input: Record<string, unknown>): { args: string[]; stdin?: string } | string
}

const ITEM = { type: 'string', description: 'The roadmap item: a Work ID (PIE-123) or its block UUID. Never a title.' }
const EXPECTED = {
  type: 'integer',
  minimum: 1,
  description: 'The revision you read; the write is refused if the block changed since.',
}

function text(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

function expected(input: Record<string, unknown>): string[] {
  const value = input.expectedRevision
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? ['--expected', String(value)] : []
}

function schema(properties: Json, required: string[]): Json {
  return { type: 'object', properties, required, additionalProperties: false }
}

export const WORK_TOOLS: readonly WorkToolDefinition[] = [
  {
    name: 'work_create',
    description:
      "Create a roadmap item under the project's work queue with a newly allocated Work ID. Returns the Work ID, " +
      'block reference and revision. New work defaults to unprioritized; pass stage only when it was agreed.',
    inputSchema: schema({
      title: { type: 'string', description: 'Concise outcome, without a Work ID or property tokens' },
      project: { type: 'string' },
      arc: { type: 'string' },
      tracks: { type: 'array', items: { type: 'string' }, minItems: 1 },
      priority: { type: 'string', enum: ['high', 'medium', 'low'] },
      stage: { type: 'string', enum: ['unprioritized', 'later', 'queued', 'doing', 'review', 'validate'] },
      batch: { type: 'string', description: 'UUID of the agreed work-batch' },
      body: { type: 'string', description: 'Markdown body: context and acceptance criteria' },
    }, ['title', 'project', 'arc', 'tracks', 'priority']),
    command(input) {
      const tracks = Array.isArray(input.tracks) ? input.tracks.filter((track): track is string => typeof track === 'string') : []
      const [title, project, arc, priority] = ['title', 'project', 'arc', 'priority'].map(key => text(input, key))
      if (!title || !project || !arc || !priority || tracks.length === 0) return 'Give a title, project, arc, priority and at least one track.'
      const args = ['work', 'create', '--title', title, '--project', project, '--arc', arc, '--priority', priority,
        ...tracks.flatMap(track => ['--track', track])]
      const stage = text(input, 'stage')
      const batch = text(input, 'batch')
      if (stage) args.push('--stage', stage)
      if (batch) args.push('--batch', batch)
      const body = text(input, 'body')
      return body ? { args: [...args, '--stdin'], stdin: body } : { args }
    },
  },
  {
    name: 'work_stage',
    description:
      "Move a roadmap item to another work stage (queued, doing, review, validate, later…), checked against its " +
      'revision and read back. Done needs proof: use work_complete.',
    inputSchema: schema({ item: ITEM, stage: { type: 'string' }, expectedRevision: EXPECTED }, ['item', 'stage']),
    command(input) {
      const [item, stage] = [text(input, 'item'), text(input, 'stage')]
      if (!item || !stage) return 'Give the item and the stage.'
      return { args: ['work', 'stage', item, stage, ...expected(input)] }
    },
  },
  {
    name: 'work_set',
    description:
      'Set one single-valued property on a roadmap item (priority, work-batch, arc…), checked against its revision ' +
      'and read back. Identity properties and multi-valued ones are refused. On a delivery only delivery-stage can ' +
      'be set: complete finishes a merged delivery (e.g. one left in validate on an item already done), validate reopens it.',
    inputSchema: schema({
      item: {
        type: 'string',
        description: 'A roadmap item (Work ID or block UUID), or for delivery-stage a delivery: its block UUID or key (PIE-123/door).',
      },
      key: { type: 'string' },
      value: { type: 'string' },
      expectedRevision: EXPECTED,
    }, ['item', 'key', 'value']),
    command(input) {
      const [item, key, value] = [text(input, 'item'), text(input, 'key'), text(input, 'value')]
      if (!item || !key || !value) return 'Give the item, the property key and its value.'
      return { args: ['work', 'set', item, key, value, ...expected(input)] }
    },
  },
  {
    name: 'work_deliver',
    description:
      "Record a GitHub pull request as one of the item's deliveries and sync its live state: an open PR moves the " +
      "item to review, a merged one to validate. The PR's branches must match the delivery's. An item can have " +
      'several deliveries (one per repository or branch), each under its own key.',
    inputSchema: schema({
      item: ITEM,
      repo: { type: 'string', description: 'owner/name' },
      pr: { type: 'integer', minimum: 1 },
      key: {
        type: 'string',
        description:
          'Delivery name (door → PIE-123/door). Omitted: the delivery already recording this repo and branch, else ' +
          'primary, else (primary is another repo) the repository name. A second branch in the same repo needs one.',
      },
      base: { type: 'string', description: "Base branch; defaults to the PR's" },
      branch: { type: 'string', description: "Work branch; defaults to the PR's head" },
    }, ['item', 'repo', 'pr']),
    command(input) {
      const [item, repo] = [text(input, 'item'), text(input, 'repo')]
      const pr = input.pr
      if (!item || !repo || typeof pr !== 'number' || !Number.isSafeInteger(pr) || pr < 1) return 'Give the item, repo and PR number.'
      const args = ['work', 'deliver', item, '--repo', repo, '--pr', String(pr)]
      const [key, base, branch] = [text(input, 'key'), text(input, 'base'), text(input, 'branch')]
      if (key) args.push('--key', key)
      if (base) args.push('--base', base)
      if (branch) args.push('--branch', branch)
      return { args }
    },
  },
  {
    name: 'work_complete',
    description:
      'Accept a roadmap item with linked proof. Every incomplete delivery must be covered: name them in deliveries ' +
      'or set allMerged; each must be merged. If another delivery is still incomplete the call is refused, naming it ' +
      'and how to finish it. The proof is added as a child block (or an existing linked proof block is used), the ' +
      'covered deliveries become complete and the item done.',
    inputSchema: schema({
      item: ITEM,
      deliveries: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        description: 'Deliveries to complete: block UUID, key (PIE-123/door) or name (door)',
      },
      allMerged: { type: 'boolean', description: 'Complete every delivery whose PR is merged, instead of naming them' },
      proof: { type: 'string', description: 'Proof as Markdown: first line is its title' },
      proofBlock: { type: 'string', description: 'An existing proof block UUID linked to the item, instead of proof text' },
    }, ['item']),
    command(input) {
      const item = text(input, 'item')
      const [proof, proofBlock] = [text(input, 'proof'), text(input, 'proofBlock')]
      const deliveries = Array.isArray(input.deliveries)
        ? input.deliveries.filter((delivery): delivery is string => typeof delivery === 'string' && delivery.trim() !== '')
        : []
      if (!item) return 'Give the item.'
      if (!proof === !proofBlock) return 'Give either proof text or an existing proofBlock.'
      if (input.allMerged === true && deliveries.length) return 'Name deliveries or set allMerged, not both.'
      const args = ['work', 'complete', item, ...deliveries.flatMap(delivery => ['--delivery', delivery]),
        ...(input.allMerged === true ? ['--all-merged'] : [])]
      return proof ? { args: [...args, '--stdin'], stdin: proof } : { args: [...args, '--proof-block', proofBlock!] }
    },
  },
  {
    name: 'work_body',
    description:
      "Replace a roadmap item's (or any block's) body below its title and property lines, checked against its revision.",
    inputSchema: schema({ item: ITEM, body: { type: 'string' }, expectedRevision: EXPECTED }, ['item', 'body']),
    command(input) {
      const item = text(input, 'item')
      if (!item || typeof input.body !== 'string') return 'Give the item and its new body.'
      return { args: ['work', 'body', item, '--stdin', ...expected(input)], stdin: input.body }
    },
  },
  {
    name: 'note_section',
    description:
      'Replace one Markdown section of a note: the text under a heading up to the next heading of its level, as ' +
      'Detail folds it. The heading stays; the replaced text is returned as "previous".',
    inputSchema: schema({
      block: { type: 'string', description: 'The note: block UUID or Work ID' },
      heading: { type: 'string', description: 'Heading text, optionally with its ## level' },
      body: { type: 'string' },
      expectedRevision: EXPECTED,
    }, ['block', 'heading', 'body']),
    command(input) {
      const [block, heading] = [text(input, 'block'), text(input, 'heading')]
      if (!block || !heading || typeof input.body !== 'string') return 'Give the note, the heading and the new section text.'
      return { args: ['note', 'section', block, heading, '--stdin', ...expected(input)], stdin: input.body }
    },
  },
]
