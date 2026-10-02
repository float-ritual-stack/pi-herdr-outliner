import type { On, ProcessRunInit, ProcessRunResult, TurnCompleteInput } from 'claude-code'
import { describe, expect, mock, test, tier } from 'claude-code/testing'

tier('user')

const result = (exitCode: number, stdout: string, stderr: string): ProcessRunResult =>
  ({ exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false })

const WORKSPACE = '/work/outliner'

const HERDR_LISTING = JSON.stringify({
  result: {
    plugins: [{ plugin_id: 'float.pi-outliner', enabled: true, plugin_root: '/opt/outliner' }],
  },
})

const ANSWER: TurnCompleteInput = {
  reason: 'answer',
  answer: 'Filed [[PIE-356]] under ((88476cef-3559-492e-85c3-2d6d31de882e)).',
  durationMs: 1200,
  isAborted: false,
  turnId: 'turn-1',
}

type Run = { argv: readonly string[]; init?: ProcessRunInit }

/** `bound-folder`'s answer: WORKSPACE is bound to an outline by its client.json; every other folder is unbound. */
function boundToWorkspace(folder: string): string {
  return folder === WORKSPACE || folder.startsWith(`${WORKSPACE}/`)
    ? JSON.stringify({ bound: true, source: 'client', folder: WORKSPACE, configPath: '/config/outliner--0a1b2c3d4e5f/client.json', mode: 'host', outline: 'garden' })
    : JSON.stringify({ bound: false, folder })
}

/**
 * A session in `cwd` whose host commands answer from `answer`, recording each.
 * `bound-folder` answers from `binding` and is recorded apart, in `bindings`.
 * `workspaces` is PI_OUTLINER_MENTIONS_WORKSPACES (an opt-out list in folder mode).
 */
function sessionIn(
  on: On,
  cwd: string,
  answer: (run: Run) => ProcessRunResult,
  workspaces = '',
  env: Record<string, string> = {},
  binding: (folder: string) => ProcessRunResult = folder => result(0, `${boundToWorkspace(folder)}\n`, ''),
) {
  const runs: Run[] = []
  const bindings: Run[] = []
  const toasts: string[] = []
  const clock = mock.clock(on)
  mock.env(on, {
    PI_OUTLINER_MENTIONS_WORKSPACES: workspaces,
    HERDR_PANE_ID: 'w:p9',
    HERDR_TAB_ID: 'w:t1',
    HERDR_WORKSPACE_ID: 'w',
    ...env,
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  // The engine's own drawing of a reply, where the plugin leaves it.
  on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return Box({ key: 'engine', children: Text({ children: e.props.text }) })
  })
  on('session.id', () => ({ value: 'session-1' }))
  on('session.cwd', () => ({ value: cwd }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('process.run', ($, e) => {
    if (e.argv.includes('bound-folder')) {
      bindings.push(e)
      return { value: binding(e.argv.at(-1)!) }
    }
    runs.push(e)
    return { value: answer(e) }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  /**
   * Starts the session and lets its reference context load, then forgets
   * those runs: what a test records is its own turn's or click's.
   */
  async function begin(start: () => Promise<unknown>) {
    await start()
    await clock.settle()
    runs.length = 0
    bindings.length = 0
    toasts.length = 0
  }
  /** The runs after the session's workspace was found: its Herdr discovery is dropped. */
  const delivered = () => runs.slice(1)
  return { runs, bindings, toasts, clock, begin, delivered }
}

const START = { surface: 'terminal', isInteractive: true, cwd: WORKSPACE } as const

const PANES = JSON.stringify({
  result: { panes: [{ pane_id: 'w:p1', tab_id: 'w:t1' }, { pane_id: 'w:p2', tab_id: 'w:t1' }, { pane_id: 'w:p3', tab_id: 'w:t2' }] },
})

const BLOCK = '11111111-2222-4333-8444-555555555555'

/** A session outside Herdr: a door tile drops Herdr's pane variables, and a plain terminal never had them. */
const NOT_IN_HERDR = { HERDR_PANE_ID: '', HERDR_TAB_ID: '', HERDR_WORKSPACE_ID: '' }

/** A reply drawn with its references as links. */
function mountReply($: { ui: { mount: (init: any) => Promise<any> } }, text: string) {
  return $.ui.mount({ plugin: 'pi-outliner', surface: 'terminal', component: 'AssistantMessage', props: { text, isFirstOfReply: true } })
}

/** The Detail split the fallback asked Herdr for, if any. */
function splitOf(runs: readonly Run[]) {
  return runs.find(run => run.argv[0] === 'herdr' && run.argv[2] === 'pane' && run.argv[3] === 'open')
}

const CLIENTS = JSON.stringify([
  { clientId: 'tree-here', role: 'tree', contextId: 'session-1', runtime: { paneId: 'w:p1' } },
  { clientId: 'someone-elses', role: 'detail', contextId: 'theirs', runtime: { paneId: 'w:p2' } },
  { clientId: 'claude-pane', role: 'detail', contextId: 'session-1', runtime: { paneId: 'w:p3' } },
])

/** The registry before Claude has a pane of its own. */
const CLIENTS_WITHOUT_SCRATCH = JSON.stringify(JSON.parse(CLIENTS).slice(0, 2))

function succeeding(run: Run): ProcessRunResult {
  const ok = (stdout: string) => result(0, stdout, '')
  if (run.argv[0] === 'herdr') {
    if (run.argv[1] === 'pane') return ok(PANES)
    return ok(run.argv[2] === 'pane' ? '{"result":{"plugin_pane":{"pane":{"pane_id":"w:p10"}}}}' : HERDR_LISTING)
  }
  if (run.argv.includes('resolve')) return ok(`{"id":"${BLOCK}","title":"Daily notes"}`)
  if (run.argv.includes('work-id-status')) return ok('{"prefix":"PIE","observedPrefixes":["PIE","OLD"]}')
  if (run.argv.includes('clients')) return ok(CLIENTS)
  if (run.argv.includes('link')) return ok('{"kind":"page","title":"Daily notes"}')
  return ok('{"references":2}')
}

describe('register', () => {
  test('a bound folder: the answer is ingested into its outline after the turn', async ($, on) => {
    const session = sessionIn(on, WORKSPACE, succeeding)
    await session.begin(() => $.session.start(START))

    const { text } = await $.turn.complete(ANSWER)
    await session.clock.settle()

    expect(text).toBe(ANSWER.answer)
    // The CLI says which folder is bound, from the session's cwd up; nothing is guessed here.
    expect(session.bindings.map(run => [run.argv.slice(3), run.init?.cwd, run.init?.env])).toEqual([[['bound-folder', WORKSPACE], WORKSPACE, undefined]])
    expect(session.delivered().map(run => run.argv[0])).toEqual(['herdr', '/bin/sh'])
    const ingest = session.delivered()[1]!
    expect(ingest.argv.slice(1)).toEqual([
      '/opt/outliner/scripts/run-bun.sh',
      '/opt/outliner/src/cli.ts',
      'mentions',
      'ingest',
    ])
    expect(ingest.init?.cwd).toBe(WORKSPACE)
    expect(ingest.init?.env).toEqual({ OUTLINER_WORKSPACE_ROOT: WORKSPACE, OUTLINER_OUTLINE: 'garden', OUTLINER_CONFIG_PATH: '' })
    expect(JSON.parse(ingest.init?.stdin ?? '')).toEqual({
      workspaceRoot: WORKSPACE,
      agent: 'claude',
      sessionId: 'session-1',
      messageId: 'turn-1',
      text: ANSWER.answer,
    })
    expect(session.toasts).toEqual([])
  })

  test('a nested folder feeds its nearest binding, the folder the CLI names', async ($, on) => {
    const nested = `${WORKSPACE}/projects/mod`
    // projects/ has a binding of its own (to another outline), nearer than the workspace's.
    const session = sessionIn(on, `${nested}/src`, succeeding, '', {}, folder =>
      result(0, folder.startsWith(`${nested}/`) ? `{"bound":true,"source":"client","folder":"${nested}","mode":"host","outline":"mod-notes"}` : boundToWorkspace(folder), ''))
    await session.begin(() => $.session.start({ ...START, cwd: `${nested}/src` }))
    await $.turn.complete(ANSWER)
    await session.clock.settle()
    const ingest = session.delivered()[1]!
    expect(ingest.init?.cwd).toBe(nested)
    expect(ingest.init?.env).toEqual({ OUTLINER_WORKSPACE_ROOT: nested, OUTLINER_OUTLINE: 'mod-notes', OUTLINER_CONFIG_PATH: '' })
    expect(JSON.parse(ingest.init?.stdin ?? '').workspaceRoot).toBe(nested)
  })

  test('an outline root the host serves: its outline is named, since no client.json names it', async ($, on) => {
    const root = '/work/jam-shelf/notes'
    const session = sessionIn(on, `${root}/drafts`, succeeding, '', {}, () =>
      result(0, `{"bound":true,"source":"host-root","folder":"${root}","outline":"jam-shelf"}`, ''))
    await session.begin(() => $.session.start({ ...START, cwd: `${root}/drafts` }))
    await $.turn.complete(ANSWER)
    await session.clock.settle()
    const ingest = session.delivered()[1]!
    expect(ingest.init?.cwd).toBe(root)
    expect(ingest.init?.env).toEqual({ OUTLINER_WORKSPACE_ROOT: root, OUTLINER_OUTLINE: 'jam-shelf', OUTLINER_CONFIG_PATH: '' })
  })

  test('an unbound folder: nothing is ingested, nothing linked, and no outline is guessed or defaulted', async ($, on) => {
    const session = sessionIn(on, '/home/sam/scratch', succeeding)
    await session.begin(() => $.session.start({ ...START, cwd: '/home/sam/scratch' }))

    await $.turn.complete(ANSWER)
    await session.clock.settle()

    expect(session.bindings.map(run => run.argv.at(-1))).toEqual(['/home/sam/scratch'])
    // Only Herdr's discovery of the CLI ran: no ingest, no work-id-status, nothing addressed to an outline.
    expect(session.runs.map(run => run.argv[0])).toEqual(['herdr'])
    expect(session.toasts).toEqual([])
    const drawn = await mountReply($, 'See PIE-7 and [[Daily notes]].')
    expect(await drawn.find({ key: 'outliner-references' })).toBeUndefined()
  })

  test('an answer the CLI binds outside the session folder is not trusted', async ($, on) => {
    const session = sessionIn(on, '/home/sam/scratch', succeeding, '', {}, () =>
      result(0, `{"bound":true,"source":"client","folder":"${WORKSPACE}","mode":"host","outline":"garden"}`, ''))
    await session.begin(() => $.session.start({ ...START, cwd: '/home/sam/scratch' }))
    await $.turn.complete(ANSWER)
    await session.clock.settle()
    expect(session.runs.filter(run => run.argv.includes('ingest'))).toEqual([])
  })

  for (const listed of [`${WORKSPACE}/`, `/elsewhere,${WORKSPACE}/projects`]) {
    test(`an opted-out folder (${listed}): nothing is ingested, and its binding is never asked for`, async ($, on) => {
      const cwd = `${WORKSPACE}/projects/mod`
      const session = sessionIn(on, cwd, succeeding, listed, { PI_OUTLINER_MENTIONS_MODE: 'folder' })
      await session.begin(() => $.session.start({ ...START, cwd }))
      await $.turn.complete(ANSWER)
      await session.clock.settle()
      expect(session.bindings).toEqual([])
      expect(session.runs).toEqual([])
      const drawn = await mountReply($, 'See PIE-7.')
      expect(await drawn.find({ key: 'outliner-references' })).toBeUndefined()
    })
  }

  test('a sibling of an opted-out folder is not opted out', async ($, on) => {
    const session = sessionIn(on, WORKSPACE, succeeding, `${WORKSPACE}-other`, { PI_OUTLINER_MENTIONS_MODE: 'folder' })
    await session.begin(() => $.session.start(START))
    await $.turn.complete(ANSWER)
    await session.clock.settle()
    expect(session.runs.filter(run => run.argv.includes('ingest'))).toHaveLength(1)
  })

  test('strict allowlist mode: only listed folders feed, bound or not, as before folder mode', async ($, on) => {
    const listed = '/work/listed'
    const session = sessionIn(on, `${listed}/src`, succeeding, `${listed}/`, { PI_OUTLINER_MENTIONS_MODE: 'allowlist' })
    await session.begin(() => $.session.start({ ...START, cwd: `${listed}/src` }))
    await $.turn.complete(ANSWER)
    await session.clock.settle()
    // The listed folder needs no binding; bound-folder is never run.
    expect(session.bindings).toEqual([])
    expect(session.runs.map(run => run.argv[0])).toEqual(['herdr', '/bin/sh'])
    const ingest = session.runs[1]!
    expect(ingest.init?.cwd).toBe(listed)
    expect(ingest.init?.env).toEqual({ OUTLINER_WORKSPACE_ROOT: listed })
  })

  test('a list with no mode opts out: an allowlist from before folder mode fails closed', async ($, on) => {
    const session = sessionIn(on, `${WORKSPACE}/src`, succeeding, WORKSPACE)
    await session.begin(() => $.session.start({ ...START, cwd: `${WORKSPACE}/src` }))
    await $.turn.complete(ANSWER)
    await session.clock.settle()
    expect(session.bindings).toEqual([])
    expect(session.runs).toEqual([])
  })

  test("a remote socket in Claude's environment: nothing is fed, and it says why once", async ($, on) => {
    const session = sessionIn(on, WORKSPACE, succeeding, '', { OUTLINER_REMOTE: '1', OUTLINER_SOCKET_PATH: '/elsewhere/outliner.sock' })
    await session.begin(() => $.session.start(START))
    await $.turn.complete(ANSWER)
    await $.turn.complete({ ...ANSWER, turnId: 'turn-2' })
    await session.clock.settle()
    expect(session.bindings).toEqual([])
    expect(session.runs).toEqual([])
    expect(session.toasts).toHaveLength(1)
    expect(session.toasts[0]).toContain('OUTLINER_REMOTE / OUTLINER_SOCKET_PATH')
  })

  test('strict allowlist mode: a bound folder that is not listed feeds nothing', async ($, on) => {
    const session = sessionIn(on, WORKSPACE, succeeding, '/work/listed', { PI_OUTLINER_MENTIONS_MODE: 'allowlist' })
    await session.begin(() => $.session.start(START))
    await $.turn.complete(ANSWER)
    await session.clock.settle()
    expect(session.bindings).toEqual([])
    expect(session.runs).toEqual([])
  })

  test('an unknown mode is one toast, and nothing is ingested', async ($, on) => {
    const session = sessionIn(on, WORKSPACE, succeeding, '', { PI_OUTLINER_MENTIONS_MODE: 'everywhere' })
    await session.begin(() => $.session.start(START))
    await $.turn.complete(ANSWER)
    await $.turn.complete({ ...ANSWER, turnId: 'turn-2' })
    await session.clock.settle()
    expect(session.runs).toEqual([])
    expect(session.toasts).toEqual(['Outliner recent mentions unavailable: Outliner mentions mode "everywhere" is neither folder nor allowlist'])
  })

  test('an Outliner older than bound-folder feeds nothing and says so once', async ($, on) => {
    const session = sessionIn(on, WORKSPACE, succeeding, '', {}, () =>
      result(1, '', '1016 |     throw new Error(`Unknown command: ${command}`);\nerror: Unknown command: bound-folder\n      at cli.ts:1016:15\n\nBun v1.4.2 (Linux x64)'))
    await session.begin(() => $.session.start(START))
    await $.turn.complete(ANSWER)
    await $.turn.complete({ ...ANSWER, turnId: 'turn-2' })
    await session.clock.settle()
    expect(session.runs.filter(run => run.argv.includes('ingest'))).toEqual([])
    expect(session.toasts).toEqual([
      "Outliner recent mentions unavailable: the installed Outliner is too old to find this folder's outline (no bound-folder); update it",
    ])
  })

  test('subagent, interrupted and empty turns are not ingested', async ($, on) => {
    const session = sessionIn(on, WORKSPACE, succeeding)
    await session.begin(() => $.session.start(START))

    await $.turn.complete({ ...ANSWER, agentId: 'agent-1' })
    await $.turn.complete({ ...ANSWER, reason: 'aborted', isAborted: true })
    await $.turn.complete({ ...ANSWER, answer: '  ' })
    await session.clock.settle()

    expect(session.runs).toEqual([])
    expect(session.bindings).toEqual([])
  })

  test('a disabled Outliner plugin is skipped quietly', async ($, on) => {
    const session = sessionIn(on, WORKSPACE, () =>
      result(0, HERDR_LISTING.replace('"enabled":true', '"enabled":false'), ''))
    await session.begin(() => $.session.start(START))

    await $.turn.complete(ANSWER)
    await session.clock.settle()

    // The CLI is never asked for the folder's binding, nor anything else.
    expect(session.runs.map(run => run.argv[0])).toEqual(['herdr'])
    expect(session.bindings).toEqual([])
    expect(session.toasts).toEqual([])
  })

  test('an unreachable service leaves the answer and shows one toast', async ($, on) => {
    const session = sessionIn(on, WORKSPACE, run =>
      run.argv[0] === 'herdr'
        ? succeeding(run)
        : result(1, '', 'trace\nerror: connect ENOENT outliner.sock'),
    )
    await session.begin(() => $.session.start(START))

    const { text } = await $.turn.complete(ANSWER)
    await session.clock.settle()

    expect(text).toBe(ANSWER.answer)
    expect(session.toasts).toEqual([
      'Outliner recent mentions unavailable: mentions ingest failed: connect ENOENT outliner.sock',
    ])
  })

  test('an invalid workspaces entry is one toast, and nothing is ingested or bound by name', async ($, on) => {
    const session = sessionIn(on, WORKSPACE, succeeding, `${WORKSPACE}=fred`)
    await session.begin(() => $.session.start(START))

    const { text } = await $.turn.complete(ANSWER)
    await session.clock.settle()

    expect(text).toBe(ANSWER.answer)
    expect(session.runs.filter(run => run.argv.includes('ingest'))).toEqual([])
    expect(session.toasts).toEqual([
      `Outliner recent mentions unavailable: Outliner workspaces entry "${WORKSPACE}=fred" is not an absolute folder; list folders only, and bind a folder to an outline in its client.json (the choose-outline action)`,
    ])
  })

  test('Outliner references in a reply are drawn as links; other replies are left to the engine', async ($, on) => {
    const session = sessionIn(on, WORKSPACE, succeeding)
    await session.begin(() => $.session.start(START))

    const drawn = await $.ui.mount({
      plugin: 'pi-outliner',
      surface: 'terminal',
      component: 'AssistantMessage',
      props: { text: 'Filed PIE-356 and OLD-2 beside `PIE-1`.', isFirstOfReply: true },
    })
    const markdown = await drawn.find({ key: 'outliner-references' })
    expect(markdown?.props.text).toBe(
      'Filed [PIE-356](https://pi-outliner.invalid/work/PIE-356) and ' +
        '[OLD-2](https://pi-outliner.invalid/work/OLD-2) beside `PIE-1`.',
    )
    expect(markdown?.props.pressableLinks).toEqual([
      'https://pi-outliner.invalid/work/PIE-356',
      'https://pi-outliner.invalid/work/OLD-2',
    ])

    const plain = await $.ui.mount({
      plugin: 'pi-outliner',
      surface: 'terminal',
      component: 'AssistantMessage',
      props: { text: 'Nothing to link here.', isFirstOfReply: true },
    })
    expect(await plain.find({ key: 'outliner-references' })).toBeUndefined()
    expect((await plain.find({ key: 'engine' }))?.text).toBe('Nothing to link here.')
  })

  test("clicking a reference shows it in Claude's own pane, without focus", async ($, on) => {
    const session = sessionIn(on, WORKSPACE, succeeding)
    await session.begin(() => $.session.start(START))
    const drawn = await $.ui.mount({
      plugin: 'pi-outliner',
      surface: 'terminal',
      component: 'AssistantMessage',
      props: { text: 'See [[Daily notes]].', isFirstOfReply: true },
    })

    await drawn.press({ key: 'outliner-references', link: { href: 'https://pi-outliner.invalid/page/Daily%20notes' } })
    await session.clock.settle()

    const link = session.runs.find(run => run.argv.includes('link'))
    expect(link?.argv.slice(3)).toEqual(['link', 'pi-outliner://page/Daily%20notes', '--detail-client', 'claude-pane', '--no-focus'])
    expect(link?.init?.cwd).toBe(WORKSPACE)
    expect(splitOf(session.runs)).toBeUndefined()
    expect(session.toasts).toEqual([])
  })

  test("with no pane of its own, a click splits one below the Claude pane for this session", async ($, on) => {
    const session = sessionIn(on, WORKSPACE, run =>
      run.argv.includes('clients') ? result(0, CLIENTS_WITHOUT_SCRATCH, '') : succeeding(run))
    await session.begin(() => $.session.start(START))
    const drawn = await $.ui.mount({
      plugin: 'pi-outliner',
      surface: 'terminal',
      component: 'AssistantMessage',
      props: { text: 'See PIE-7.', isFirstOfReply: true },
    })

    await drawn.press({ key: 'outliner-references', link: { href: 'https://pi-outliner.invalid/work/PIE-7' } })
    await session.clock.settle()

    expect(session.runs.some(run => run.argv.includes('link'))).toBe(false)
    expect(session.runs.find(run => run.argv.includes('resolve'))?.argv.at(-1)).toBe('pi-outliner://work/PIE-7')
    const split = splitOf(session.runs)?.argv ?? []
    expect(split.slice(split.indexOf('--target-pane'), split.indexOf('--target-pane') + 4)).toEqual(['--target-pane', 'w:p9', '--direction', 'down'])
    expect(split).toContain('OUTLINER_BROWSING_CONTEXT_ID=session-1')
    expect(split).toContain(`OUTLINER_DETAIL_TARGET=${encodeURIComponent(JSON.stringify({ kind: 'block', blockId: BLOCK }))}`)
    expect(session.toasts).toEqual([])
  })

  test("a mid-edit Claude pane is a toast, never a second split", async ($, on) => {
    const session = sessionIn(on, WORKSPACE, run =>
      run.argv.includes('link')
        ? result(1, '', 'error: Destination is protected: active edit\nBun v1.3.14 (Linux x64)')
        : succeeding(run))
    await session.begin(() => $.session.start(START))
    const drawn = await $.ui.mount({
      plugin: 'pi-outliner',
      surface: 'terminal',
      component: 'AssistantMessage',
      props: { text: 'See PIE-7.', isFirstOfReply: true },
    })

    await drawn.press({ key: 'outliner-references', link: { href: 'https://pi-outliner.invalid/work/PIE-7' } })
    await session.clock.settle()

    expect(splitOf(session.runs)).toBeUndefined()
    expect(session.toasts).toEqual(["Could not open PIE-7 in the Outliner: Claude's Outliner pane is mid-edit; finish or cancel it there"])
  })

  test("a click and a show call at once split one pane, then reuse it", async ($, on) => {
    let split = false
    const session = sessionIn(on, WORKSPACE, run => {
      if (splitOf([run])) split = true
      if (run.argv[1] === 'pane' && run.argv[2] === 'list' && split) {
        return result(0, PANES.replace('"w:p3"', '"w:p10"'), '')
      }
      if (run.argv.includes('clients')) {
        const clients = JSON.parse(CLIENTS_WITHOUT_SCRATCH)
        if (split) clients.push({ clientId: 'new-pane', role: 'detail', contextId: 'session-1', runtime: { paneId: 'w:p10' } })
        return result(0, JSON.stringify(clients), '')
      }
      return succeeding(run)
    })
    on('tool.register', ($, e) => ({ value: { tool: `mcp__pi-outliner__${e.name}` } }))
    await session.begin(() => $.session.start(START))
    const drawn = await $.ui.mount({
      plugin: 'pi-outliner',
      surface: 'terminal',
      component: 'AssistantMessage',
      props: { text: 'See PIE-7.', isFirstOfReply: true },
    })

    await Promise.all([
      drawn.press({ key: 'outliner-references', link: { href: 'https://pi-outliner.invalid/work/PIE-7' } }),
      $.tool.call({ tool: 'mcp__pi-outliner__show', reference: 'PIE-8' }),
    ])
    await session.clock.settle()

    expect(session.runs.filter(run => splitOf([run]))).toHaveLength(1)
    expect(session.runs.filter(run => run.argv.includes('link')).map(run => run.argv.at(-2))).toEqual(['new-pane'])
  })

  test("the show tool puts a reference in Claude's pane and reports it", async ($, on) => {
    const session = sessionIn(on, WORKSPACE, succeeding)
    const registered: string[] = []
    on('tool.register', ($, e) => {
      registered.push(e.name)
      return { value: { tool: `mcp__pi-outliner__${e.name}` } }
    })
    await session.begin(() => $.session.start(START))
    expect(registered).toEqual([
      'show', 'work_create', 'work_stage', 'work_set', 'work_deliver', 'work_complete', 'work_body', 'note_section',
      'outline_read', 'outline_find', 'outline_resolve', 'outline_edit', 'outline_create', 'outline_comment',
      'outline_reply', 'outline_resolve_thread', 'outline_changes', 'outline_patch',
    ])

    const shown = await $.tool.call({ tool: 'mcp__pi-outliner__show', reference: '[[Daily notes]]' })
    expect(shown).toMatchObject({ result: "Showing Daily notes in Claude's Outliner pane." })
    expect(session.runs.find(run => run.argv.includes('link'))?.argv).toContain('claude-pane')

    const empty = await $.tool.call({ tool: 'mcp__pi-outliner__show', reference: ' ' })
    expect(empty.deny).toContain('Give a Work ID')
  })

  test('in neither a door nor Herdr, a click and show say so and give the ((id)) to copy, never failing silently', async ($, on) => {
    const session = sessionIn(on, WORKSPACE, succeeding, '', NOT_IN_HERDR)
    on('tool.register', ($, e) => ({ value: { tool: `mcp__pi-outliner__${e.name}` } }))
    await session.begin(() => $.session.start(START))
    const drawn = await mountReply($, 'See [[Daily notes]].')

    await drawn.press({ key: 'outliner-references', link: { href: 'https://pi-outliner.invalid/page/Daily%20notes' } })
    await session.clock.settle()
    const message = `Can't open Daily notes here: this session is not in an ep0ch-door tile, nor in Herdr. Copy ((${BLOCK})) to open it in the Outliner.`
    expect(session.toasts).toEqual([message])

    const shown = await $.tool.call({ tool: 'mcp__pi-outliner__show', reference: '[[Daily notes]]' })
    expect(shown.deny).toBe(message)
    expect(session.runs.some(run => run.argv.includes('door-open') || run.argv.includes('link'))).toBe(false)
    expect(splitOf(session.runs)).toBeUndefined()
  })

  describe('in an ep0ch-door tile', () => {
    const DOOR = { EP0CH_TILE: 'claude', EP0CH_CONTROL: '/state/ep0ch-door/agent-door-claude.sock' }
    const doorOpenOf = (runs: readonly Run[]) => runs.find(run => run.argv.includes('door-open'))

    test('show opens the note in the door as an agent, from its own tile, and splits nothing in Herdr', async ($, on) => {
      // The door says where the tile's opens landed (its link).
      const session = sessionIn(on, WORKSPACE, run =>
        run.argv.includes('door-open') ? result(0, '{"reader":"centre","id":"x"}\n', '') : succeeding(run),
      '', DOOR)
      on('tool.register', ($, e) => ({ value: { tool: `mcp__pi-outliner__${e.name}` } }))
      await session.begin(() => $.session.start(START))

      const shown = await $.tool.call({ tool: 'mcp__pi-outliner__show', reference: '[[Daily notes]]' })
      expect(shown).toMatchObject({ result: "Showing Daily notes in the door's centre reader." })
      const opened = doorOpenOf(session.runs)!
      // --reader middle is only for a door older than from= (door-control asks it only then).
      expect(opened.argv.slice(-10)).toEqual([
        'door-open', BLOCK, '--control', DOOR.EP0CH_CONTROL, '--actor', 'claude-code', '--from', 'claude', '--reader', 'middle',
      ])
      expect(opened.init?.cwd).toBe(WORKSPACE)
      expect(splitOf(session.runs)).toBeUndefined()
      expect(session.runs.some(run => run.argv.includes('link'))).toBe(false)
    })

    test('show is attributed like every other write: OUTLINER_ACTOR before EP0CH_AGENT', async ($, on) => {
      const session = sessionIn(on, WORKSPACE, run =>
        run.argv.includes('door-open') ? result(0, '{"reader":"centre","id":"x"}\n', '') : succeeding(run),
      '', { ...DOOR, OUTLINER_ACTOR: 'garden-agent', EP0CH_AGENT: 'loki' })
      on('tool.register', ($, e) => ({ value: { tool: `mcp__pi-outliner__${e.name}` } }))
      await session.begin(() => $.session.start(START))
      await $.tool.call({ tool: 'mcp__pi-outliner__show', reference: '[[Daily notes]]' })
      const opened = doorOpenOf(session.runs)!
      expect(opened.argv[opened.argv.indexOf('--actor') + 1]).toBe('garden-agent')
    })

    test('with no door answering (it quit), show falls back to Claude\'s pane in Herdr', async ($, on) => {
      const session = sessionIn(on, WORKSPACE, run =>
        run.argv.includes('door-open') ? result(3, '', 'error: no door at /state/x (ECONNREFUSED)\n') : succeeding(run),
      '', DOOR)
      on('tool.register', ($, e) => ({ value: { tool: `mcp__pi-outliner__${e.name}` } }))
      await session.begin(() => $.session.start(START))

      const shown = await $.tool.call({ tool: 'mcp__pi-outliner__show', reference: '[[Daily notes]]' })
      expect(shown).toMatchObject({ result: "Showing Daily notes in Claude's Outliner pane." })
      expect(doorOpenOf(session.runs)).toBeDefined()
      expect(session.runs.find(run => run.argv.includes('link'))?.argv).toContain('claude-pane')
    })

    test('a door that refuses is denied with its reason, never shown elsewhere', async ($, on) => {
      const session = sessionIn(on, WORKSPACE, run =>
        run.argv.includes('door-open')
          ? result(1, '', "error: the menu screen can't open blocks; open the board or desk first\n")
          : succeeding(run),
      '', DOOR)
      on('tool.register', ($, e) => ({ value: { tool: `mcp__pi-outliner__${e.name}` } }))
      await session.begin(() => $.session.start(START))

      const shown = await $.tool.call({ tool: 'mcp__pi-outliner__show', reference: '[[Daily notes]]' })
      expect(shown.deny).toContain("the menu screen can't open blocks")
      expect(splitOf(session.runs)).toBeUndefined()
      expect(session.runs.some(run => run.argv.includes('link'))).toBe(false)
    })

    test("a click in a terminal tile (^W o s, no Herdr pane) opens in the door, from the tile's id when its name is empty", async ($, on) => {
      const session = sessionIn(on, WORKSPACE, run =>
        run.argv.includes('door-open') ? result(0, '{"reader":"right","id":"x"}\n', '') : succeeding(run),
      '', { ...NOT_IN_HERDR, EP0CH_CONTROL: DOOR.EP0CH_CONTROL, EP0CH_TILE: '', EP0CH_TILE_ID: 't21' })
      await session.begin(() => $.session.start(START))
      const drawn = await mountReply($, 'See PIE-7.')

      await drawn.press({ key: 'outliner-references', link: { href: 'https://pi-outliner.invalid/work/PIE-7' } })
      await session.clock.settle()

      const opened = doorOpenOf(session.runs)!
      expect(opened.argv.slice(-10)).toEqual([
        'door-open', BLOCK, '--control', DOOR.EP0CH_CONTROL, '--actor', 'claude-code', '--from', 't21', '--reader', 'middle',
      ])
      expect(splitOf(session.runs)).toBeUndefined()
      expect(session.toasts).toEqual([])
    })

    test("a click the door refuses is a toast with the door's reason", async ($, on) => {
      const session = sessionIn(on, WORKSPACE, run =>
        run.argv.includes('door-open')
          ? result(1, '', 'error: right holds an edit; an agent never takes it\n')
          : succeeding(run),
      '', { ...NOT_IN_HERDR, ...DOOR })
      await session.begin(() => $.session.start(START))
      const drawn = await mountReply($, 'See PIE-7.')

      await drawn.press({ key: 'outliner-references', link: { href: 'https://pi-outliner.invalid/work/PIE-7' } })
      await session.clock.settle()

      expect(session.toasts).toEqual(['Could not open PIE-7 in the Outliner: right holds an edit; an agent never takes it'])
      expect(splitOf(session.runs)).toBeUndefined()
    })

    test('with no door answering and no Herdr, a click says so and gives the ((id)) to copy', async ($, on) => {
      const session = sessionIn(on, WORKSPACE, run =>
        run.argv.includes('door-open') ? result(3, '', 'error: no door at /state/x (ECONNREFUSED)\n') : succeeding(run),
      '', { ...NOT_IN_HERDR, ...DOOR })
      await session.begin(() => $.session.start(START))
      const drawn = await mountReply($, 'See PIE-7.')

      await drawn.press({ key: 'outliner-references', link: { href: 'https://pi-outliner.invalid/work/PIE-7' } })
      await session.clock.settle()

      expect(session.toasts).toEqual([
        `Can't open PIE-7 here: no door answers on ${DOOR.EP0CH_CONTROL} (it quit?), nor in Herdr. Copy ((${BLOCK})) to open it in the Outliner.`,
      ])
    })

    test('a click on a reference opens it in the door too', async ($, on) => {
      const session = sessionIn(on, WORKSPACE, run =>
        run.argv.includes('door-open') ? result(0, '{}\n', '') : succeeding(run),
      '', { ...DOOR, EP0CH_AGENT: 'door-claude' })
      on('tool.register', ($, e) => ({ value: { tool: `mcp__pi-outliner__${e.name}` } }))
      await session.begin(() => $.session.start(START))

      await $.tool.call({ tool: 'mcp__pi-outliner__show', reference: `((${BLOCK}))` })
      const opened = doorOpenOf(session.runs)!
      expect(opened.argv).toContain('door-claude')
      expect(session.toasts).toEqual([])
    })
  })

  test('a workboard tool runs the installed CLI in the workspace as this Claude session', async ($, on) => {
    const session = sessionIn(on, `${WORKSPACE}/projects/mod`, run =>
      run.argv.includes('work') ? result(0, '{"workId":"PIE-008","workStage":"review","revision":4}\n', '') : succeeding(run),
    )
    on('tool.register', ($, e) => ({ value: { tool: `mcp__pi-outliner__${e.name}` } }))
    await session.begin(() => $.session.start({ ...START, cwd: `${WORKSPACE}/projects/mod` }))

    const staged = await $.tool.call({ tool: 'mcp__pi-outliner__work_stage', item: 'PIE-8', stage: 'review', expectedRevision: 3 })
    expect(staged).toMatchObject({ result: '{"workId":"PIE-008","workStage":"review","revision":4}' })
    const run = session.runs.find(candidate => candidate.argv.includes('work'))!
    expect(run.argv).toEqual([
      '/bin/sh', '/opt/outliner/scripts/run-bun.sh', '/opt/outliner/src/cli.ts',
      'work', 'stage', 'PIE-8', 'review', '--expected', '3',
      '--author', 'agent', '--actor', 'claude-code', '--session', 'session-1',
    ])
    expect(run.init?.cwd).toBe(WORKSPACE)
    expect(run.init?.env).toEqual({ OUTLINER_WORKSPACE_ROOT: WORKSPACE, OUTLINER_OUTLINE: 'garden', OUTLINER_CONFIG_PATH: '' })

    await $.tool.call({ tool: 'mcp__pi-outliner__work_complete', item: 'PIE-8', deliveries: ['d-1', 'PIE-8/door'], proof: 'Proof\n\nChecked.' })
    const completed = session.runs.findLast(candidate => candidate.argv.includes('complete'))!
    expect(completed.argv.slice(3, 11)).toEqual(['work', 'complete', 'PIE-8', '--delivery', 'd-1', '--delivery', 'PIE-8/door', '--stdin'])
    expect(completed.init?.stdin).toBe('Proof\n\nChecked.')

    await $.tool.call({ tool: 'mcp__pi-outliner__work_complete', item: 'PIE-8', allMerged: true, proofBlock: 'p-1' })
    const allMerged = session.runs.findLast(candidate => candidate.argv.includes('complete'))!
    expect(allMerged.argv.slice(3, 9)).toEqual(['work', 'complete', 'PIE-8', '--all-merged', '--proof-block', 'p-1'])

    await $.tool.call({ tool: 'mcp__pi-outliner__work_deliver', item: 'PIE-8', repo: 'example-org/example-door', pr: 16, key: 'door' })
    const delivered = session.runs.findLast(candidate => candidate.argv.includes('deliver'))!
    expect(delivered.argv.slice(3, 11)).toEqual(['work', 'deliver', 'PIE-8', '--repo', 'example-org/example-door', '--pr', '16', '--key'])
    expect(delivered.argv[11]).toBe('door')

    await $.tool.call({ tool: 'mcp__pi-outliner__work_set', item: 'PIE-8/door', key: 'delivery-stage', value: 'complete', expectedRevision: 2 })
    const set = session.runs.findLast(candidate => candidate.argv.includes('set'))!
    expect(set.argv.slice(3, 10)).toEqual(['work', 'set', 'PIE-8/door', 'delivery-stage', 'complete', '--expected', '2'])

    await $.tool.call({ tool: 'mcp__pi-outliner__note_section', block: 'PIE-8', heading: '## Now', body: 'Updated.' })
    const section = session.runs.findLast(candidate => candidate.argv.includes('section'))!
    expect(section.argv.slice(3, 8)).toEqual(['note', 'section', 'PIE-8', '## Now', '--stdin'])
    expect(section.init?.stdin).toBe('Updated.')
  })

  test('a refused workboard change is denied with the reason, and unusable input never runs', async ($, on) => {
    const session = sessionIn(on, WORKSPACE, run =>
      run.argv.includes('work')
        ? result(1, '', 'error: Unknown work stage "shipping"; use one of queued, doing\n')
        : succeeding(run),
    )
    on('tool.register', ($, e) => ({ value: { tool: `mcp__pi-outliner__${e.name}` } }))
    await session.begin(() => $.session.start(START))

    const refused = await $.tool.call({ tool: 'mcp__pi-outliner__work_stage', item: 'PIE-8', stage: 'shipping' })
    expect(refused.deny).toBe('Unknown work stage "shipping"; use one of queued, doing')

    const runs = session.runs.length
    const both = await $.tool.call({ tool: 'mcp__pi-outliner__work_complete', item: 'PIE-8', proof: 'x', proofBlock: 'y' })
    expect(both.deny).toContain('either proof text or an existing proofBlock')
    const named = await $.tool.call({ tool: 'mcp__pi-outliner__work_complete', item: 'PIE-8', proof: 'x', deliveries: ['d-1'], allMerged: true })
    expect(named.deny).toContain('not both')
    expect(session.runs.length).toBe(runs)
  })

  test('in a folder bound to no outline, workboard tools change nothing', async ($, on) => {
    const session = sessionIn(on, '/elsewhere', succeeding)
    on('tool.register', ($, e) => ({ value: { tool: `mcp__pi-outliner__${e.name}` } }))
    await session.begin(() => $.session.start({ ...START, cwd: '/elsewhere' }))
    const denied = await $.tool.call({ tool: 'mcp__pi-outliner__work_stage', item: 'PIE-8', stage: 'doing' })
    expect(denied.deny).toContain('not bound to an Outliner outline')
    expect(session.runs).toEqual([])
  })

  test('in a folder bound to no outline, replies are not linked', async ($, on) => {
    const session = sessionIn(on, '/elsewhere', succeeding)
    await session.begin(() => $.session.start({ ...START, cwd: '/elsewhere' }))
    const drawn = await $.ui.mount({
      plugin: 'pi-outliner',
      surface: 'terminal',
      component: 'AssistantMessage',
      props: { text: 'See PIE-7.', isFirstOfReply: true },
    })
    expect(await drawn.find({ key: 'outliner-references' })).toBeUndefined()
    expect((await drawn.find({ key: 'engine' }))?.text).toBe('See PIE-7.')
  })
})
