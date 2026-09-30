import type { On, ProcessRunInit, ProcessRunResult } from 'claude-code'
import { describe, expect, mock, test, tier } from 'claude-code/testing'

import { envSummaryOf, knowsWhere, whereSummaryOf } from '../hooks/where'

tier('user')

const START = { surface: 'terminal', isInteractive: true, cwd: '/work/elsewhere' } as const
const NEST = 'ssh:pts/5 › door:4242/desk/t1:claude'
const SUMMARY = `stack: ${NEST} · keys: the person is typing in this tile (t1 claude)`

const HELP = 'ep0ch: a BBS door\n\n  ep0ch status [--json]\n  ep0ch where [--json]             where this runs\n  ep0ch help'
const OLD_HELP = 'ep0ch: a BBS door\n\n  ep0ch status [--json]\n  ep0ch help'

type Run = { argv: readonly string[]; init?: ProcessRunInit }
const result = (exitCode: number, stdout = '', stderr = ''): ProcessRunResult =>
  ({ exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false })

/** A session whose `ep0ch where` answers from `where` (throwing: not on PATH), outside any configured Outliner workspace. */
function sessionWith(on: On, env: Record<string, string>, where: (run: Run) => ProcessRunResult, help: (run: Run) => ProcessRunResult = () => result(0, HELP)) {
  const runs: Run[] = []
  const clock = mock.clock(on)
  mock.env(on, { PI_OUTLINER_MENTIONS_WORKSPACES: '', ...env })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.cwd', () => ({ value: START.cwd }))
  on('prompt.context', ($, e) => ({ blocks: e.blocks }))
  on('process.run', ($, e) => {
    runs.push(e)
    return { value: e.argv[0] !== 'ep0ch' ? result(1) : e.argv[1] === 'help' ? help(e) : where(e) }
  })
  return { runs, clock }
}

const CORE = [{ name: 'currentDate', text: "Today's date is 2026-09-30." }]
const whereBlock = (blocks: readonly { name: string; text: string }[]) => blocks.find(b => b.name === 'whereAmI')

describe('where this session runs', () => {
  test('in a door tile: `ep0ch where --json` at session start, its summary in the first prompt\'s context', async ($, on) => {
    const s = sessionWith(on, { EP0CH_NEST: NEST, EP0CH_CONTROL: '/run/door.sock', EP0CH_TILE: 'claude' },
      () => result(0, JSON.stringify({ inDoor: true, nest: NEST, summary: SUMMARY })))
    await $.session.start(START)
    await s.clock.settle()
    expect(s.runs.filter(r => r.argv[0] === 'ep0ch').map(r => r.argv)).toEqual([['ep0ch', 'help'], ['ep0ch', 'where', '--json']])
    const { blocks } = await $.prompt.context({ blocks: CORE })
    expect(blocks[0]).toEqual(CORE[0]!)
    expect(whereBlock(blocks)?.text).toContain(SUMMARY)
    expect(whereBlock(blocks)?.text).toContain('`ep0ch where` checks it again')
  })

  test('ep0ch not on PATH: the variables alone, said to be unchecked', async ($, on) => {
    const s = sessionWith(on, { EP0CH_NEST: NEST, EP0CH_CONTROL: '/run/door.sock' }, () => { throw Error('ENOENT: ep0ch') })
    await $.session.start(START)
    await s.clock.settle()
    const text = whereBlock((await $.prompt.context({ blocks: CORE })).blocks)?.text ?? ''
    expect(text).toContain(`stack: ${NEST}`)
    expect(text).toContain('unchecked')
  })

  test('an ep0ch without `where` (usage on stdout, an error exit): the variables alone', async ($, on) => {
    const s = sessionWith(on, { EP0CH_CONTROL: '/run/door.sock', EP0CH_TILE: 'claude' }, () => result(1, '', 'ep0ch: no carrier'))
    await $.session.start(START)
    await s.clock.settle()
    expect(whereBlock((await $.prompt.context({ blocks: CORE })).blocks)?.text).toContain('in an ep0ch-door tile (claude), from a door older than EP0CH_NEST')
  })

  test('an ep0ch older than `where` is never asked for it (it would open a door): the variables alone', async ($, on) => {
    const s = sessionWith(on, { EP0CH_NEST: NEST }, () => { throw Error('where must not run') }, () => result(0, OLD_HELP))
    await $.session.start(START)
    await s.clock.settle()
    expect(s.runs.filter(r => r.argv[0] === 'ep0ch').map(r => r.argv)).toEqual([['ep0ch', 'help']])
    expect(whereBlock((await $.prompt.context({ blocks: CORE })).blocks)?.text).toContain('unchecked')
  })

  test('outside a door: ep0ch is never run and no block is added', async ($, on) => {
    const s = sessionWith(on, {}, () => result(0, '{}'))
    await $.session.start(START)
    await s.clock.settle()
    const { blocks } = await $.prompt.context({ blocks: CORE })
    expect(blocks).toEqual(CORE)
    expect(s.runs.filter(r => r.argv[0] === 'ep0ch')).toEqual([])
  })
})

describe('where helpers', () => {
  test('the summary is read from where --json, and anything else is not one', () => {
    expect(whereSummaryOf(JSON.stringify({ summary: SUMMARY }))).toBe(SUMMARY)
    expect(whereSummaryOf('usage: ep0ch …')).toBeNull()
    expect(whereSummaryOf('{"summary":""}')).toBeNull()
    expect(knowsWhere(HELP)).toBe(true)
    expect(knowsWhere(OLD_HELP)).toBe(false)
    expect(envSummaryOf({ EP0CH_CONTROL: '/c' })).toContain('from a door older than EP0CH_NEST')
  })
})
