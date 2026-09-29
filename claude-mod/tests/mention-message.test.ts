import { describe, expect, test, tier } from 'claude-code/testing'

import { effectiveWorkspaceBindings, effectiveWorkspaces, failureReasonOf, outlinerEnvironment, workspacesOf } from '../hooks/mention-message'

tier('user')

describe('mention-message', () => {
  test('an entry may bind its folder to a host outline by name', async () => {
    const bindings = effectiveWorkspaceBindings('', '/work/fred-folder=fred,/work/jam-shelf/,/work/odd=Not A Name')
    expect(bindings).toEqual([{ root: '/work/fred-folder', outline: 'fred' }, { root: '/work/jam-shelf' }, { root: '/work/odd' }])
    expect(effectiveWorkspaces('', '/work/fred-folder=fred')).toEqual(['/work/fred-folder'])
    expect(outlinerEnvironment('/work/fred-folder', bindings)).toEqual({ OUTLINER_WORKSPACE_ROOT: '/work/fred-folder', OUTLINER_OUTLINE: 'fred' })
    expect(outlinerEnvironment('/work/jam-shelf', bindings)).toEqual({ OUTLINER_WORKSPACE_ROOT: '/work/jam-shelf' })
  })

  test('workspaces split on either separator and keep absolute paths only', async () => {
    expect(workspacesOf(' /a/b/, relative : /c ')).toEqual(['/a/b', '/c'])
    expect(workspacesOf(['/a', 3, 'x'])).toEqual(['/a'])
    expect(workspacesOf('')).toEqual([])
    expect(workspacesOf('/')).toEqual(['/'])
  })

  test('a CLI failure reports its error line, not the Bun trailer', async () => {
    const stderr = [
      '187 |         const response = JSON.parse(buffer.slice(0, newline)) as OutlinerResponse;',
      '188 |         if (!response.ok) responseReceived.reject(new Error(response.error));',
      '                                                            ^',
      'error: Destination is protected: active edit or source selection · finish or cancel it there',
      '      at data (node:net:281:72)',
      '',
      'Bun v1.3.14 (Linux x64)',
      '',
    ].join('\n')
    expect(failureReasonOf(stderr)).toBe('Destination is protected: active edit or source selection · finish or cancel it there')
    expect(failureReasonOf('plain failure\n    at x (y:1:2)\nBun v1.3.14 (Linux x64)')).toBe('plain failure')
    expect(failureReasonOf('')).toBe('')
  })

  test('a configured option wins; an empty or unset one falls back to the environment', async () => {
    expect(effectiveWorkspaces('/option', '/env')).toEqual(['/option'])
    expect(effectiveWorkspaces('', '/env')).toEqual(['/env'])
    expect(effectiveWorkspaces(undefined, '/env')).toEqual(['/env'])
    expect(effectiveWorkspaces(' , ', '/env')).toEqual(['/env'])
    expect(effectiveWorkspaces('', undefined)).toEqual([])
  })
})
