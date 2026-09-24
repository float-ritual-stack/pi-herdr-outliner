import type { On, ProcessRunInit, ProcessRunResult, TurnCompleteInput } from 'claude-code'
import { describe, expect, mock, test, tier } from 'claude-code/testing'

tier('user')

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

/**
 * A session in `cwd` whose host commands answer from `answer`, recording each.
 */
function sessionIn(on: On, cwd: string, answer: (run: Run) => ProcessRunResult) {
  const runs: Run[] = []
  const toasts: string[] = []
  const clock = mock.clock(on)
  mock.env(on, {
    PI_OUTLINER_MENTIONS_WORKSPACES: `${WORKSPACE}/`,
    HERDR_PANE_ID: 'w:p9',
    HERDR_TAB_ID: 'w:t1',
    HERDR_WORKSPACE_ID: 'w',
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
    toasts.length = 0
  }
  return { runs, toasts, clock, begin }
}

const START = { surface: 'terminal', isInteractive: true, cwd: WORKSPACE } as const

const PANES = JSON.stringify({
  result: { panes: [{ pane_id: 'w:p1', tab_id: 'w:t1' }, { pane_id: 'w:p2', tab_id: 'w:t1' }, { pane_id: 'w:p3', tab_id: 'w:t2' }] },
})

const BLOCK = '11111111-2222-4333-8444-555555555555'

/** The Detail split the fallback asked Herdr for, if any. */
function splitOf(runs: readonly Run[]) {
  return runs.find(run => run.argv[0] === 'herdr' && run.argv[2] === 'pane' && run.argv[3] === 'open')
}

const CLIENTS = JSON.stringify([
  { clientId: 'tree-elsewhere', role: 'tree', runtime: { paneId: 'w:p3' } },
  { clientId: 'detail-here', role: 'detail', runtime: { paneId: 'w:p2' } },
  { clientId: 'tree-here', role: 'tree', runtime: { paneId: 'w:p1' } },
])

function succeeding(run: Run): ProcessRunResult {
  const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' })
  if (run.argv[0] === 'herdr') {
    if (run.argv[1] === 'pane') return ok(PANES)
    return ok(run.argv[2] === 'pane' ? '{"result":{"pane":{"pane_id":"w:p10"}}}' : HERDR_LISTING)
  }
  if (run.argv.includes('resolve')) return ok(`{"id":"${BLOCK}","title":"Daily notes"}`)
  if (run.argv.includes('work-id-status')) return ok('{"prefix":"PIE","observedPrefixes":["PIE","OLD"]}')
  if (run.argv.includes('clients')) return ok(CLIENTS)
  return ok('{"references":2}')
}

describe('register', () => {
  test('an answer from a subdirectory ingests into its configured parent workspace', async ($, on) => {
    const session = sessionIn(on, `${WORKSPACE}/projects/mod`, succeeding)
    await session.begin(() => $.session.start(START))
    const { text } = await $.turn.complete(ANSWER)
    await session.clock.settle()
    expect(text).toBe(ANSWER.answer)
    expect(session.runs.map(run => run.argv[0])).toEqual(['herdr', '/bin/sh'])
    const ingest = session.runs[1]!
    expect(ingest.init?.cwd).toBe(WORKSPACE)
    expect(ingest.init?.env).toEqual({ OUTLINER_WORKSPACE_ROOT: WORKSPACE })
    expect(JSON.parse(ingest.init?.stdin ?? '').workspaceRoot).toBe(WORKSPACE)
  })

  test('an answer in a configured workspace is ingested after the turn', async ($, on) => {
    const session = sessionIn(on, WORKSPACE, succeeding)
    await session.begin(() => $.session.start(START))

    const { text } = await $.turn.complete(ANSWER)
    await session.clock.settle()

    expect(text).toBe(ANSWER.answer)
    expect(session.runs.map(run => run.argv[0])).toEqual(['herdr', '/bin/sh'])
    const ingest = session.runs[1]!
    expect(ingest.argv.slice(1)).toEqual([
      '/opt/outliner/scripts/run-bun.sh',
      '/opt/outliner/src/cli.ts',
      'mentions',
      'ingest',
    ])
    expect(ingest.init?.env).toEqual({ OUTLINER_WORKSPACE_ROOT: WORKSPACE })
    expect(JSON.parse(ingest.init?.stdin ?? '')).toEqual({
      workspaceRoot: WORKSPACE,
      agent: 'claude',
      sessionId: 'session-1',
      messageId: 'turn-1',
      text: ANSWER.answer,
    })
    expect(session.toasts).toEqual([])
  })

  test('subagent, interrupted and empty turns are not ingested', async ($, on) => {
    const session = sessionIn(on, WORKSPACE, succeeding)
    await session.begin(() => $.session.start(START))

    await $.turn.complete({ ...ANSWER, agentId: 'agent-1' })
    await $.turn.complete({ ...ANSWER, reason: 'aborted', isAborted: true })
    await $.turn.complete({ ...ANSWER, answer: '  ' })
    await session.clock.settle()

    expect(session.runs).toEqual([])
  })

  test('a session outside the configured workspaces ingests nothing', async ($, on) => {
    const session = sessionIn(on, `${WORKSPACE}-other/src`, succeeding)
    await session.begin(() => $.session.start(START))

    await $.turn.complete(ANSWER)
    await session.clock.settle()

    expect(session.runs).toEqual([])
  })

  test('a disabled Outliner plugin is skipped quietly', async ($, on) => {
    const session = sessionIn(on, WORKSPACE, () => ({
      exitCode: 0,
      stdout: HERDR_LISTING.replace('"enabled":true', '"enabled":false'),
      stderr: '',
    }))
    await session.begin(() => $.session.start(START))

    await $.turn.complete(ANSWER)
    await session.clock.settle()

    expect(session.runs.map(run => run.argv[0])).toEqual(['herdr'])
    expect(session.toasts).toEqual([])
  })

  test('an unreachable service leaves the answer and shows one toast', async ($, on) => {
    const session = sessionIn(on, WORKSPACE, run =>
      run.argv[0] === 'herdr'
        ? succeeding(run)
        : { exitCode: 1, stdout: '', stderr: 'trace\nerror: connect ENOENT outliner.sock' },
    )
    await session.begin(() => $.session.start(START))

    const { text } = await $.turn.complete(ANSWER)
    await session.clock.settle()

    expect(text).toBe(ANSWER.answer)
    expect(session.toasts).toEqual([
      'Outliner recent mentions unavailable: mentions ingest failed: connect ENOENT outliner.sock',
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

  test('clicking a reference opens it through the Tree in this Herdr tab', async ($, on) => {
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
    expect(link?.argv.slice(3)).toEqual(['link', 'pi-outliner://page/Daily%20notes', '--source-client', 'tree-here'])
    expect(link?.init?.cwd).toBe(WORKSPACE)
    expect(session.toasts).toEqual([])
  })

  test('with no Outliner Tree open, a click splits a Detail below the Claude pane', async ($, on) => {
    const session = sessionIn(on, WORKSPACE, run =>
      run.argv.includes('clients') ? { exitCode: 0, stdout: '[]', stderr: '' } : succeeding(run))
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
    expect(split).toContain(`OUTLINER_DETAIL_TARGET=${encodeURIComponent(JSON.stringify({ kind: 'block', blockId: BLOCK }))}`)
    expect(session.toasts).toEqual([])
  })

  test('a Tree whose Detail is mid-edit falls back to a split; other failures do not', async ($, on) => {
    const protectedStderr = 'error: Destination is protected: active edit or source selection · finish or cancel it there\nBun v1.3.14 (Linux x64)'
    let linkStderr = protectedStderr
    const session = sessionIn(on, WORKSPACE, run =>
      run.argv.includes('link') ? { exitCode: 1, stdout: '', stderr: linkStderr } : succeeding(run))
    await session.begin(() => $.session.start(START))
    const drawn = await $.ui.mount({
      plugin: 'pi-outliner',
      surface: 'terminal',
      component: 'AssistantMessage',
      props: { text: 'See [[Daily notes]].', isFirstOfReply: true },
    })
    const press = () => drawn.press({ key: 'outliner-references', link: { href: 'https://pi-outliner.invalid/page/Daily%20notes' } })

    await press()
    await session.clock.settle()
    expect(session.runs.find(run => run.argv.includes('link'))?.argv).toContain('tree-here')
    expect(splitOf(session.runs)).toBeDefined()
    expect(session.toasts).toEqual([])

    session.runs.length = 0
    linkStderr = 'error: Page address did not resolve: Daily notes\nBun v1.3.14 (Linux x64)'
    await press()
    await session.clock.settle()
    expect(splitOf(session.runs)).toBeUndefined()
    expect(session.toasts).toEqual(['Could not open Daily notes in the Outliner: Page address did not resolve: Daily notes'])
  })

  test('outside the configured workspaces, replies are not linked', async ($, on) => {
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
