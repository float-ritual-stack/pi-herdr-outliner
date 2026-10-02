import type { On, ProcessRunInit, ProcessRunResult } from 'claude-code'
import { describe, expect, mock, test, tier } from 'claude-code/testing'

tier('user')

// The outline_* and door_* tools (PIE-504). A plugin test has no processes, so the installed CLI and ep0ch are
// answered here, as a scratch service answers them in test/agent-tools.test.ts, which runs the same
// `agent <operation> --stdin --actor … --session …` command against a real one. Fictional notes only.

const result = (exitCode: number, stdout: string, stderr = ''): ProcessRunResult =>
  ({ exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false })

const WORKSPACE = '/work/garden'
const NOTE = '0f3c2a1b-1111-4222-8333-444455556666'
const THREAD = '7a1e0c2d-2222-4333-8444-555566667777'
const HERDR_LISTING = JSON.stringify({ result: { plugins: [{ plugin_id: 'float.pi-outliner', enabled: true, plugin_root: '/opt/outliner' }] } })
const CONTROL = '/state/ep0ch-door/door-4242.sock'
const DOOR = { EP0CH_CONTROL: CONTROL, EP0CH_TILE: 'claude' }

/** What the scratch service answers each `agent` operation with (see test/agent-tools.test.ts). */
const LONG_TEXT = 'Seed swap plan [page::Seed Swap]\n\n## Beans\n\nBorlotti and runner beans. ^beans'
const ANSWERS: Record<string, string> = {
  read: JSON.stringify({ id: NOTE, ref: `((${NOTE}))`, title: 'Seed swap plan', revision: 3, text: LONG_TEXT, properties: { page: 'Seed Swap' },
    author: 'user', updated: '2026-03-01T09:00:00.000Z', parentId: null, children: [{ id: THREAD, text: 'Bring labels', revision: 1 }], complete: true }),
  find: JSON.stringify({ blocks: [{ id: NOTE, title: 'Seed swap plan', revision: 3, parentId: null, updated: '2026-03-01T09:00:00.000Z' }], complete: true }),
  resolve: JSON.stringify({ id: NOTE, ref: `((${NOTE}))`, title: 'Seed swap plan', revision: 3 }),
  edit: JSON.stringify({ id: NOTE, ref: `((${NOTE}))`, revision: 4, previousRevision: 3, diff: '@@ line 5\n-Borlotti\n+Borlotti only' }),
  create: JSON.stringify({ id: THREAD, ref: `((${THREAD}))`, revision: 1, parentId: NOTE }),
  comment: JSON.stringify({ thread: THREAD, blockId: NOTE, author: 'agent', actorId: 'claude-code', lifecycle: 'open' }),
  reply: JSON.stringify({ thread: THREAD, reply: NOTE, author: 'agent', actorId: 'claude-code', lifecycle: 'open' }),
  'resolve-thread': JSON.stringify({ thread: THREAD, author: 'agent', actorId: 'claude-code', lifecycle: 'resolved' }),
  changes: JSON.stringify({ entries: [{ cursor: 9, id: NOTE, title: 'Seed swap plan', kind: 'text', author: 'agent', actorId: 'claude-code', at: '2026-03-01T09:00:00.000Z', revision: 4 }], cursor: 9 }),
  patch: JSON.stringify({ outcome: 'applied', edits: [{ blockId: NOTE, route: 'saved', revision: 5 }] }),
}

type Run = { argv: readonly string[]; init?: ProcessRunInit }

/** The CLI's `resolve <uri>` and `door-open` (a door that lands it in middle), as a click or `show` runs them. */
function resolveAnswer(run: Run): ProcessRunResult | undefined {
  if (run.argv.includes('door-open')) return result(0, `{"reader":"middle","id":"${NOTE}"}\n`)
  if (run.argv[3] === 'resolve') return result(0, `{"id":"${NOTE}","title":"Seed swap plan"}\n`)
  return undefined
}

function sessionIn(on: On, answer: (run: Run) => ProcessRunResult | undefined, env: Record<string, string> = {}, cwd = WORKSPACE) {
  const runs: Run[] = []
  const registered: string[] = []
  const clock = mock.clock(on)
  mock.env(on, { PI_OUTLINER_MENTIONS_WORKSPACES: '', ...env })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.cwd', () => ({ value: cwd }))
  on('tool.register', ($, e) => {
    registered.push(e.name)
    return { value: { tool: `mcp__pi-outliner__${e.name}` } }
  })
  on('process.run', ($, e) => {
    runs.push(e)
    const given = answer(e)
    if (given) return { value: given }
    if (e.argv[0] === 'herdr') return { value: result(0, HERDR_LISTING) }
    // The garden folder is bound to an outline (its client.json); every other folder is unbound.
    if (e.argv.includes('bound-folder')) {
      const folder = e.argv.at(-1)!
      return { value: result(0, folder === WORKSPACE || folder.startsWith(`${WORKSPACE}/`)
        ? `{"bound":true,"source":"client","folder":"${WORKSPACE}","mode":"host","outline":"garden"}\n`
        : `{"bound":false,"folder":"${folder}"}\n`) }
    }
    if (e.argv.includes('work-id-status')) return { value: result(0, '{"prefix":"PIE","observedPrefixes":["PIE"]}') }
    if (e.argv[0] === 'ep0ch' && e.argv[1] === 'help') return { value: result(0, 'usage:\n  ep0ch where [--json]  where this runs\n') }
    if (e.argv[0] === 'ep0ch' && e.argv[1] === 'where') return { value: result(0, '{"summary":"door:4242/desk/t1:claude","typing":false}\n') }
    const answered = resolveAnswer(e)
    if (answered) return { value: answered }
    const operation = e.argv[e.argv.indexOf('agent') + 1]
    if (e.argv.includes('agent') && operation && ANSWERS[operation]) return { value: result(0, `${ANSWERS[operation]}\n`) }
    return { value: result(1, '', 'error: unexpected command\n') }
  })
  async function begin(start: () => Promise<unknown>) {
    await start()
    await clock.settle()
    runs.length = 0
  }
  const agentRuns = () => runs.filter(run => run.argv.includes('agent'))
  return { runs, registered, begin, agentRuns }
}

const START = { surface: 'terminal', isInteractive: true, cwd: WORKSPACE } as const
const CLI = ['/bin/sh', '/opt/outliner/scripts/run-bun.sh', '/opt/outliner/src/cli.ts']

/** One call of each outline tool, and the operation and JSON the CLI gets for it. */
const CALLS: Array<{ tool: string; input: Record<string, unknown>; operation: string; json: Record<string, unknown> }> = [
  { tool: 'outline_read', input: { ref: 'PIE-12', depth: 2 }, operation: 'read', json: { ref: 'PIE-12', depth: 2 } },
  { tool: 'outline_find', input: { property: 'crop=leek', limit: 5 }, operation: 'find', json: { property: 'crop=leek', limit: 5 } },
  { tool: 'outline_resolve', input: { ref: '[[Seed Swap]]' }, operation: 'resolve', json: { ref: '[[Seed Swap]]' } },
  { tool: 'outline_edit', input: { ref: NOTE, expectedRevision: 3, append: 'Swap starts at ten.' }, operation: 'edit',
    json: { ref: NOTE, expectedRevision: 3, append: 'Swap starts at ten.' } },
  { tool: 'outline_create', input: { parent: NOTE, text: 'Bring labels', position: 0 }, operation: 'create', json: { parent: NOTE, text: 'Bring labels', position: 0 } },
  { tool: 'outline_comment', input: { ref: NOTE, quote: 'runner', body: 'Which variety?' }, operation: 'comment',
    json: { ref: NOTE, quote: 'runner', body: 'Which variety?' } },
  { tool: 'outline_reply', input: { thread: THREAD, body: 'Scarlet emperor.' }, operation: 'reply', json: { thread: THREAD, body: 'Scarlet emperor.' } },
  { tool: 'outline_resolve_thread', input: { thread: THREAD, resolved: true }, operation: 'resolve-thread', json: { thread: THREAD, resolved: true } },
  { tool: 'outline_changes', input: { since: '2026-03-01T00:00:00Z', actor: 'garden-agent' }, operation: 'changes',
    json: { since: '2026-03-01T00:00:00Z', actor: 'garden-agent' } },
  { tool: 'outline_patch', input: { ref: NOTE, revision: 3, patches: [{ observed: 'runner  beans', replacement: 'runner beans' }] }, operation: 'patch',
    json: { policy: 'edit', ref: NOTE, revision: 3, patches: [{ observed: 'runner  beans', replacement: 'runner beans' }] } },
]

describe('outline tools', () => {
  test('each outline tool runs the CLI agent operation in the workspace, as this Claude session', async ($, on) => {
    const session = sessionIn(on, () => undefined)
    await session.begin(() => $.session.start(START))
    for (const call of CALLS) expect(session.registered).toContain(call.tool)

    for (const call of CALLS) {
      const answered = await $.tool.call({ tool: `mcp__pi-outliner__${call.tool}`, ...call.input })
      expect(answered).toMatchObject({ result: ANSWERS[call.operation] })
      const run = session.agentRuns().at(-1)!
      expect(run.argv).toEqual([...CLI, 'agent', call.operation, '--stdin', '--actor', 'claude-code', '--session', 'session-1'])
      expect(JSON.parse(run.init!.stdin!)).toEqual(call.json)
      expect(run.init?.cwd).toBe(WORKSPACE)
      expect(run.init?.env).toEqual({ OUTLINER_WORKSPACE_ROOT: WORKSPACE, OUTLINER_OUTLINE: 'garden', OUTLINER_CONFIG_PATH: '' })
    }
  })

  test('a patch is an edit unless it asks for prose; allowStructural passes through; another policy never runs', async ($, on) => {
    const session = sessionIn(on, () => undefined)
    await session.begin(() => $.session.start(START))
    const patches = [{ observed: 'see [[Seed Swap]]', replacement: 'see the swap' }]
    await $.tool.call({ tool: 'mcp__pi-outliner__outline_patch', ref: NOTE, revision: 3, patches })
    expect(JSON.parse(session.agentRuns().at(-1)!.init!.stdin!)).toEqual({ policy: 'edit', ref: NOTE, revision: 3, patches })
    await $.tool.call({ tool: 'mcp__pi-outliner__outline_patch', ref: NOTE, revision: 3, patches, policy: 'prose' })
    expect(JSON.parse(session.agentRuns().at(-1)!.init!.stdin!)).toMatchObject({ policy: 'prose' })
    await $.tool.call({ tool: 'mcp__pi-outliner__outline_patch', ref: NOTE, revision: 3, patches, allowStructural: true })
    expect(JSON.parse(session.agentRuns().at(-1)!.init!.stdin!)).toMatchObject({ policy: 'edit', allowStructural: true })
    const runs = session.agentRuns().length
    const odd = await $.tool.call({ tool: 'mcp__pi-outliner__outline_patch', ref: NOTE, revision: 3, patches, policy: 'tidy' })
    expect(odd.deny).toContain('edit (the default) or prose')
    expect(session.agentRuns().length).toBe(runs)
  })

  test('a read comes back with the full text, not the title', async ($, on) => {
    const session = sessionIn(on, () => undefined)
    await session.begin(() => $.session.start(START))
    const read = await $.tool.call({ tool: 'mcp__pi-outliner__outline_read', ref: `((${NOTE}))` })
    const note = JSON.parse(String((read as { result: unknown }).result))
    expect(note.text).toBe(LONG_TEXT)
    expect(note).toMatchObject({ revision: 3, complete: true })
  })

  test('an edit that would blank the note never runs; a stale revision is denied with the reason', async ($, on) => {
    const session = sessionIn(on, run => run.argv.includes('edit')
      ? result(1, '', `error: ${NOTE} is at revision 4, not 3: it changed since you read it. Read it again, then edit\n`)
      : undefined)
    await session.begin(() => $.session.start(START))
    for (const text of ['', '   ', null]) {
      const blank = await $.tool.call({ tool: 'mcp__pi-outliner__outline_edit', ref: NOTE, expectedRevision: 3, text })
      expect(blank.deny).toBeDefined()
    }
    const noRevision = await $.tool.call({ tool: 'mcp__pi-outliner__outline_edit', ref: NOTE, text: 'Seed swap' })
    expect(noRevision.deny).toContain('read the note with outline_read first')
    const two = await $.tool.call({ tool: 'mcp__pi-outliner__outline_edit', ref: NOTE, expectedRevision: 3, text: 'x', append: 'y' })
    expect(two.deny).toContain('exactly one')
    expect(session.agentRuns()).toEqual([])

    const stale = await $.tool.call({ tool: 'mcp__pi-outliner__outline_edit', ref: NOTE, expectedRevision: 3, text: 'Seed swap plan, revised' })
    expect(stale.deny).toContain('changed since you read it')
  })

  test('a comment is the agent\'s: the session\'s actor, or the one the caller names', async ($, on) => {
    const session = sessionIn(on, () => undefined, { EP0CH_AGENT: 'loki' })
    await session.begin(() => $.session.start(START))
    await $.tool.call({ tool: 'mcp__pi-outliner__outline_comment', ref: NOTE, whole: true, body: 'Due this week.' })
    expect(session.agentRuns().at(-1)!.argv.slice(3)).toEqual(['agent', 'comment', '--stdin', '--actor', 'loki', '--session', 'session-1'])
    await $.tool.call({ tool: 'mcp__pi-outliner__outline_comment', ref: NOTE, whole: true, body: 'Due this week.', actor: 'garden-agent' })
    expect(session.agentRuns().at(-1)!.argv).toContain('garden-agent')
    // The actor never travels in the JSON: attribution is the CLI flag's.
    expect(JSON.parse(session.agentRuns().at(-1)!.init!.stdin!)).toEqual({ ref: NOTE, whole: true, body: 'Due this week.' })
    const neither = await $.tool.call({ tool: 'mcp__pi-outliner__outline_comment', ref: NOTE, body: 'Hm.' })
    expect(neither.deny).toContain('quote')
  })

  test('OUTLINER_ACTOR names the agent before EP0CH_AGENT, for workboard tools too', async ($, on) => {
    const session = sessionIn(on, run => run.argv.includes('work') ? result(0, '{"workId":"PIE-008"}\n') : undefined,
      { OUTLINER_ACTOR: 'cowboy', EP0CH_AGENT: 'loki' })
    await session.begin(() => $.session.start(START))
    await $.tool.call({ tool: 'mcp__pi-outliner__outline_create', parent: 'root', text: 'Plant garlic' })
    expect(session.agentRuns().at(-1)!.argv).toContain('cowboy')
    await $.tool.call({ tool: 'mcp__pi-outliner__work_stage', item: 'PIE-8', stage: 'doing' })
    const work = session.runs.find(run => run.argv.includes('work'))!
    expect(work.argv.slice(-6)).toEqual(['--author', 'agent', '--actor', 'cowboy', '--session', 'session-1'])
  })

  test('in a folder bound to no outline, outline tools change nothing', async ($, on) => {
    const session = sessionIn(on, () => undefined, {}, '/elsewhere')
    await session.begin(() => $.session.start({ ...START, cwd: '/elsewhere' }))
    const denied = await $.tool.call({ tool: 'mcp__pi-outliner__outline_read', ref: NOTE })
    expect(denied.deny).toContain('not bound to an Outliner outline')
    expect(session.agentRuns()).toEqual([])
  })
})

describe('door tools', () => {
  test('without EP0CH_CONTROL they are not offered, and a call is refused without running ep0ch', async ($, on) => {
    const session = sessionIn(on, () => undefined)
    await session.begin(() => $.session.start(START))
    for (const name of ['door_where', 'door_peek', 'door_act', 'door_open']) expect(session.registered).not.toContain(name)
    for (const name of ['door_where', 'door_peek', 'door_act', 'door_open']) {
      const denied = await $.tool.call({ tool: `mcp__pi-outliner__${name}`, action: 'layout.get', id: NOTE })
      expect(denied.deny).toContain('only in an ep0ch-door tile')
    }
    expect(session.runs.filter(run => run.argv[0] === 'ep0ch')).toEqual([])
  })

  test('in a door tile they run ep0ch on its control socket, attributed with --as', async ($, on) => {
    const session = sessionIn(on, run => {
      if (run.argv[0] !== 'ep0ch') return undefined
      if (run.argv[1] === 'peek') return result(0, '{\n  "screen": "desk",\n  "focus": "middle"\n}\nDESK  middle: Seed swap plan\n')
      if (run.argv[1] === 'act') return result(0, `{"ok":true,"action":"${run.argv[2]}"}\n`)
      return undefined
    }, { ...DOOR, EP0CH_AGENT: 'loki' })
    await session.begin(() => $.session.start(START))
    for (const name of ['door_where', 'door_peek', 'door_act', 'door_open']) expect(session.registered).toContain(name)

    const where = await $.tool.call({ tool: 'mcp__pi-outliner__door_where' })
    expect(JSON.parse(String((where as { result: unknown }).result))).toMatchObject({ summary: 'door:4242/desk/t1:claude' })

    const peek = await $.tool.call({ tool: 'mcp__pi-outliner__door_peek' })
    expect(JSON.parse(String((peek as { result: unknown }).result))).toEqual({ screen: { screen: 'desk', focus: 'middle' }, text: 'DESK  middle: Seed swap plan' })

    await $.tool.call({ tool: 'mcp__pi-outliner__door_act', action: 'block.mark', args: { reason: 'needs your call', line: 3 }, tile: 'middle' })
    const act = session.runs.findLast(run => run.argv[1] === 'act')!
    expect(act.argv).toEqual(['ep0ch', 'act', 'block.mark', 'reason=needs your call', 'line=3', 'tile=middle', '--as', 'loki'])
    expect(act.init?.env).toEqual({ EP0CH_CONTROL: CONTROL })

    // ep0ch reads a value starting with @ as a file: it goes through stdin instead.
    await $.tool.call({ tool: 'mcp__pi-outliner__door_act', action: 'view.scrollTo', args: { text: '@request tidy' }, actor: 'garden-agent' })
    const at = session.runs.findLast(run => run.argv[1] === 'act')!
    expect(at.argv).toEqual(['ep0ch', 'act', 'view.scrollTo', 'text=@-', '--as', 'garden-agent'])
    expect(at.init?.stdin).toBe('@request tidy')

    // door_open is the same open as a click or `show`: the CLI's door-open from this tile, as the agent.
    const opened = await $.tool.call({ tool: 'mcp__pi-outliner__door_open', id: `((${NOTE}))` })
    expect(opened).toMatchObject({ result: "Showing Seed swap plan in the door's middle reader." })
    const open = session.runs.find(run => run.argv.includes('door-open'))!
    expect(open.argv.slice(3)).toEqual(['door-open', NOTE, '--control', CONTROL, '--actor', 'loki', '--from', 'claude'])
  })

  test("a door's refusal comes back as the tool's error; a reference is resolved before opening", async ($, on) => {
    const session = sessionIn(on, run => run.argv[0] === 'ep0ch' && run.argv[1] === 'act'
      ? result(1, '', 'an agent never moves the person\'s focus while they type; set a mark instead\n')
      : undefined, DOOR)
    await session.begin(() => $.session.start(START))
    const refused = await $.tool.call({ tool: 'mcp__pi-outliner__door_act', action: 'screen.open', args: { name: 'board' } })
    expect(refused.deny).toContain("never moves the person's focus")
    const bad = await $.tool.call({ tool: 'mcp__pi-outliner__door_act', action: 'layout.get', args: { as: 'someone' } })
    expect(bad.deny).toContain('not an argument name')

    await $.tool.call({ tool: 'mcp__pi-outliner__door_open', id: '[[Seed Swap]]' })
    expect(session.runs.find(run => run.argv.includes('resolve'))?.argv.slice(3)).toEqual(['resolve', 'pi-outliner://page/Seed%20Swap'])
    const open = session.runs.find(run => run.argv.includes('door-open'))!
    expect(open.argv.slice(3, 5)).toEqual(['door-open', NOTE])
    expect(open.argv[open.argv.indexOf('--actor') + 1]).toBe('claude-code')
  })

  test("door_open passes the door's refusal through, and is never shown anywhere else", async ($, on) => {
    const session = sessionIn(on, run => run.argv.includes('door-open')
      ? result(1, '', "error: middle holds an edit; an agent never takes it\nBun v1.3.14 (Linux x64)\n")
      : resolveAnswer(run), { ...DOOR, HERDR_PANE_ID: 'w:p9', HERDR_WORKSPACE_ID: 'w' })
    await session.begin(() => $.session.start(START))
    const refused = await $.tool.call({ tool: 'mcp__pi-outliner__door_open', id: NOTE })
    expect(refused.deny).toBe(`Could not show ${NOTE}: middle holds an edit; an agent never takes it`)
    expect(session.runs.some(run => run.argv[0] === 'herdr' && run.argv[1] !== 'plugin')).toBe(false)
  })
})
