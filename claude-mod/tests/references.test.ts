import { describe, expect, test, tier } from 'claude-code/testing'

import { destinationOf, detailSplitArgv, isProtectedDestination, linkifyReferences, outlinerUriOf } from '../hooks/references'

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

  test('only a protected destination triggers the Detail split', async () => {
    expect(isProtectedDestination('Destination is protected: active edit or source selection · finish or cancel it there')).toBe(true)
    expect(isProtectedDestination('Page address did not resolve: x')).toBe(false)
  })

  test('the Detail split opens below the Claude pane, unfocused, on the target', async () => {
    const argv = detailSplitArgv({ paneId: 'w:p9', workspace: '/work/a b', blockId: UUID, fragmentId: 'f1' })
    expect(argv.slice(0, 4)).toEqual(['herdr', 'plugin', 'pane', 'open'])
    expect(argv).toContain('--no-focus')
    const env = argv.filter((_, index) => argv[index - 1] === '--env')
    expect(env[0]).toBe('OUTLINER_WORKSPACE_ROOT=/work/a b')
    expect(JSON.parse(decodeURIComponent(env[1]!.split('=')[1]!))).toEqual({ kind: 'block', blockId: UUID, fragmentId: 'f1' })
  })

  test('the destination is a live Tree in the caller\'s tab, else one in the workspace', async () => {
    const clients = [
      { clientId: 'detail-here', role: 'detail', paneId: 'w:p2' },
      { clientId: 'tree-gone', role: 'tree', paneId: 'w:p9' },
      { clientId: 'tree-elsewhere', role: 'tree', paneId: 'w:p3' },
      { clientId: 'tree-here', role: 'composed', paneId: 'w:p4' },
    ]
    const panes = new Map([['w:p2', 'w:t1'], ['w:p3', 'w:t2'], ['w:p4', 'w:t1']])
    expect(destinationOf(clients, panes, 'w:t1')?.clientId).toBe('tree-here')
    expect(destinationOf(clients, panes, 'w:t7')?.clientId).toBe('tree-elsewhere')
    expect(destinationOf(clients.slice(0, 2), panes, 'w:t1')).toBeNull()
  })
})
