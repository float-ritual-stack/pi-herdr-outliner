import { describe, expect, test, tier } from 'claude-code/testing'

import { detailSplitArgv, linkifyReferences, outlinerReferenceOf, outlinerUriFor, outlinerUriOf, scratchPaneOf } from '../hooks/references'

tier('user')

const UUID = '88476cef-3559-492e-85c3-2d6d31de882e'
const STAND_IN = 'https://pi-outliner.invalid/'

describe('references', () => {
  test('pages, block references and Work IDs become stand-in links', async () => {
    const { text, hrefs } = linkifyReferences(
      `See PIE-356, [[PIE-325]], [[Daily notes|the notes]] and ((${UUID})).`,
      ['PIE'],
    )
    expect(text).toBe(
      `See [PIE-356](${STAND_IN}work/PIE-356), [PIE-325](${STAND_IN}page/PIE-325), ` +
        `[the notes](${STAND_IN}page/Daily%20notes) and [((${UUID}))](${STAND_IN}block/${UUID}).`,
    )
    expect(hrefs).toEqual([
      `${STAND_IN}work/PIE-356`,
      `${STAND_IN}page/PIE-325`,
      `${STAND_IN}page/Daily%20notes`,
      `${STAND_IN}block/${UUID}`,
    ])
  })

  test('a labelled block reference draws its label, and repeats share one href', async () => {
    const { text, hrefs } = linkifyReferences(`((${UUID}|the ticket)) then PIE-1 and PIE-1`, ['PIE'])
    expect(text).toBe(
      `[the ticket](${STAND_IN}block/${UUID}) then [PIE-1](${STAND_IN}work/PIE-1) and [PIE-1](${STAND_IN}work/PIE-1)`,
    )
    expect(hrefs).toHaveLength(2)
  })

  test('code, existing links, URLs and near-misses are left alone', async () => {
    const source = [
      'Inline `PIE-1` and `[[page]]`.',
      '```',
      `PIE-2 ((${UUID}))`,
      '```',
      '[PIE-3](https://example.com/PIE-3) and https://github.com/x/PIE-4 and <https://a.b/PIE-5>',
      'pie-6, XPIE-7, PIE-8a, feat/PIE-9, UTF-8, [[]]',
    ].join('\n')
    expect(linkifyReferences(source, ['PIE'])).toEqual({ text: source, hrefs: [] })
  })

  test('bare Work IDs follow the configured prefixes only', async () => {
    expect(linkifyReferences('ABC-12 and PIE-3', ['ABC']).hrefs).toEqual([`${STAND_IN}work/ABC-12`])
    expect(linkifyReferences('PIE-3 and [[x]]', []).hrefs).toEqual([`${STAND_IN}page/x`])
  })

  test('link-label brackets are escaped', async () => {
    expect(linkifyReferences(`((${UUID}|x [y] z))`, []).text).toBe(`[x \\[y\\] z](${STAND_IN}block/${UUID})`)
  })

  test('stand-ins map back to Outliner URIs; other links do not', async () => {
    expect(outlinerUriOf(`${STAND_IN}block/${UUID}`)).toBe(`pi-outliner://block/${UUID}`)
    expect(outlinerUriOf(`${STAND_IN}page/Daily%20notes`)).toBe('pi-outliner://page/Daily%20notes')
    expect(outlinerUriOf(`${STAND_IN}work/PIE-1`)).toBe('pi-outliner://work/PIE-1')
    expect(outlinerUriOf(`${STAND_IN}resource/x`)).toBeNull()
    expect(outlinerUriOf(`${STAND_IN}work/PIE-1/extra`)).toBeNull()
    expect(outlinerUriOf('https://example.com/work/PIE-1')).toBeNull()
  })

  test('the Detail split opens below the Claude pane, unfocused, on the target', async () => {
    const argv = detailSplitArgv({ paneId: 'w:p9', workspace: '/work/a b', sessionId: 'session-1', blockId: UUID, fragmentId: 'f1' })
    expect(argv.slice(0, 4)).toEqual(['herdr', 'plugin', 'pane', 'open'])
    expect(argv).toContain('--no-focus')
    const env = argv.filter((_, index) => argv[index - 1] === '--env')
    expect(env[0]).toBe('OUTLINER_WORKSPACE_ROOT=/work/a b')
    expect(env[1]).toBe('OUTLINER_BROWSING_CONTEXT_ID=session-1')
    expect(JSON.parse(decodeURIComponent(env[2]!.split('=')[1]!))).toEqual({ kind: 'block', blockId: UUID, fragmentId: 'f1' })
  })

  test("Claude's pane is the live Detail carrying this session's browsing context", async () => {
    const clients = [
      { clientId: 'tree-here', role: 'tree', paneId: 'w:p1', contextId: 'session-1' },
      { clientId: 'other-detail', role: 'detail', paneId: 'w:p2', contextId: 'someone' },
      { clientId: 'gone', role: 'detail', paneId: 'w:p8', contextId: 'session-1' },
      { clientId: 'mine', role: 'detail', paneId: 'w:p3', contextId: 'session-1' },
    ]
    const panes = new Map([['w:p1', 'w:t1'], ['w:p2', 'w:t1'], ['w:p3', 'w:t2']])
    expect(scratchPaneOf(clients, panes, 'session-1')?.clientId).toBe('mine')
    expect(scratchPaneOf(clients, panes, 'session-2')).toBeNull()
  })

  test('a reference as the model writes it becomes an Outliner URI', async () => {
    expect(outlinerUriFor(' PIE-12 ')).toBe('pi-outliner://work/PIE-12')
    expect(outlinerUriFor('[[Daily notes]]')).toBe('pi-outliner://page/Daily%20notes')
    expect(outlinerUriFor(`((${UUID}))`)).toBe(`pi-outliner://block/${UUID}`)
    expect(outlinerUriFor(UUID.toUpperCase())).toBe(`pi-outliner://block/${UUID}`)
    expect(outlinerUriFor('pi-outliner://work/PIE-1')).toBe('pi-outliner://work/PIE-1')
    expect(outlinerUriFor('Daily notes')).toBe('pi-outliner://page/Daily%20notes')
    expect(outlinerUriFor('  ')).toBeNull()
  })

  test('a URI goes back to the reference the outline writes: ((id)), [[page]], the Work ID', () => {
    for (const reference of [`((${UUID}))`, '[[Daily notes]]', 'PIE-7']) {
      expect(outlinerReferenceOf(outlinerUriFor(reference)!)).toBe(reference)
    }
    expect(outlinerReferenceOf(`pi-outliner://block/${UUID.toUpperCase()}`)).toBe(`((${UUID}))`)
  })
})
