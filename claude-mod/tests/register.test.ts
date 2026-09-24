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
  mock.env(on, { PI_OUTLINER_MENTIONS_WORKSPACES: `${WORKSPACE}/` })
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
  return { runs, toasts, clock }
}

function succeeding(run: Run): ProcessRunResult {
  return run.argv[0] === 'herdr'
    ? { exitCode: 0, stdout: HERDR_LISTING, stderr: '' }
    : { exitCode: 0, stdout: '{"references":2}', stderr: '' }
}

describe('register', () => {
  test('an answer in a configured workspace is ingested after the turn', async ($, on) => {
    const session = sessionIn(on, WORKSPACE, succeeding)

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

    await $.turn.complete({ ...ANSWER, agentId: 'agent-1' })
    await $.turn.complete({ ...ANSWER, reason: 'aborted', isAborted: true })
    await $.turn.complete({ ...ANSWER, answer: '  ' })
    await session.clock.settle()

    expect(session.runs).toEqual([])
  })

  test('a session outside the configured workspaces ingests nothing', async ($, on) => {
    const session = sessionIn(on, `${WORKSPACE}/src`, succeeding)

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

    const { text } = await $.turn.complete(ANSWER)
    await session.clock.settle()

    expect(text).toBe(ANSWER.answer)
    expect(session.toasts).toEqual([
      'Outliner recent mentions unavailable: mentions ingest failed: error: connect ENOENT outliner.sock',
    ])
  })
})
