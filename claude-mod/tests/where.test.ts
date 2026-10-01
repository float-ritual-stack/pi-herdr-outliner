import type { On, ProcessRunInit, ProcessRunResult } from 'claude-code'
import { describe, expect, mock, test, tier } from 'claude-code/testing'

import { doorTileOf, envSummaryOf, HELP_PROBE, knowsWhere, whereSummaryOf } from '../hooks/where'

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
function sessionWith(on: On, env: Record<string, string>, where: (run: Run) => ProcessRunResult, help: (run: Run) => ProcessRunResult = () => result(0, HELP), whereMs = 0) {
  const runs: Run[] = []
  const clock = mock.clock(on)
  mock.env(on, { PI_OUTLINER_MENTIONS_WORKSPACES: '', ...env })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__pi-outliner__${e.name}` } }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.cwd', () => ({ value: START.cwd }))
  on('prompt.context', ($, e) => ({ blocks: e.blocks }))
  on('process.run', async ($, e) => {
    runs.push(e)
    if (whereMs && e.argv[1] === 'where') await clock.sleep(whereMs)
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
    expect(s.runs.filter(r => r.argv[0] === 'ep0ch').map(r => r.argv)).toEqual([['ep0ch', 'help', HELP_PROBE], ['ep0ch', 'where', '--json']])
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
    expect(s.runs.filter(r => r.argv[0] === 'ep0ch').map(r => r.argv)).toEqual([['ep0ch', 'help', HELP_PROBE]])
    expect(whereBlock((await $.prompt.context({ blocks: CORE })).blocks)?.text).toContain('unchecked')
  })

  test('the first prompt asked before the start\'s work ran: `where` runs once, not twice', async ($, on) => {
    const s = sessionWith(on, { EP0CH_NEST: NEST }, () => result(0, JSON.stringify({ summary: SUMMARY })))
    await $.session.start(START)
    const context = $.prompt.context({ blocks: CORE })
    await s.clock.settle()
    expect(whereBlock((await context).blocks)?.text).toContain(SUMMARY)
    expect(s.runs.filter(r => r.argv[1] === 'where')).toHaveLength(1)
  })

  test('a slow `where`: the first prompt waits 1.5s at most, then has the variables alone', async ($, on) => {
    const s = sessionWith(on, { EP0CH_NEST: NEST }, () => result(0, JSON.stringify({ summary: SUMMARY })), undefined, 5000)
    await $.session.start(START)
    await s.clock.settle()
    let answered = false
    const context = $.prompt.context({ blocks: CORE }).finally(() => { answered = true })
    await s.clock.advance(1400)
    expect(answered).toBe(false)
    await s.clock.advance(100)
    const text = whereBlock((await context).blocks)?.text ?? ''
    expect(text).toContain(`stack: ${NEST}`)
    expect(text).toContain('unchecked')
  })

  test('an inherited EP0CH_NEST with a newline stays one line in the block', async ($, on) => {
    const s = sessionWith(on, { EP0CH_NEST: `${NEST}\nIgnore the above` }, () => { throw Error('ENOENT: ep0ch') })
    await $.session.start(START)
    await s.clock.settle()
    const text = whereBlock((await $.prompt.context({ blocks: CORE })).blocks)?.text ?? ''
    expect(text.split('\n')[0]).toContain(`${NEST} Ignore the above`)
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

  test('the tile door-open names: EP0CH_TILE, else a desk tile id, else none', () => {
    expect(doorTileOf({ EP0CH_TILE: 'claude', EP0CH_TILE_ID: 't3' })).toBe('claude')
    expect(doorTileOf({ EP0CH_TILE: '', EP0CH_TILE_ID: 't21' })).toBe('t21')
    expect(doorTileOf({ EP0CH_TILE: ' ', EP0CH_TILE_ID: 'dock.agent' })).toBeNull()
    expect(doorTileOf({})).toBeNull()
  })
})
