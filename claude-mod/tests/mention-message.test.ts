import { describe, expect, test, tier } from 'claude-code/testing'

import { effectiveWorkspaces, failureReasonOf, workspacesOf } from '../hooks/mention-message'

tier('user')

describe('mention-message', () => {
  test('workspaces split on either separator; entries are absolute folders only', async () => {
    expect(workspacesOf(' /a/b/, : /c ')).toEqual(['/a/b', '/c'])
    expect(workspacesOf('')).toEqual([])
    expect(workspacesOf('/')).toEqual(['/'])
    expect(workspacesOf('~/projects/jam-shelf, ~', '/home/sam')).toEqual(['/home/sam/projects/jam-shelf', '/home/sam'])
    expect(effectiveWorkspaces('~/a', '/env', '/home/sam/')).toEqual(['/home/sam/a'])
    expect(() => workspacesOf('~/projects/jam-shelf')).toThrow('is not an absolute folder')
    // No silent fallback: a relative path, a non-string or the old folder=name form is an error.
    expect(() => workspacesOf(' /a/b/, relative : /c ')).toThrow('"relative" is not an absolute folder')
    expect(() => workspacesOf(['/a', 3])).toThrow('3 is not a folder path')
    expect(() => workspacesOf('/work/fred-folder=fred')).toThrow('bind a folder to an outline in its client.json')
    expect(() => effectiveWorkspaces('', '/work/jam-shelf,jam')).toThrow('"jam" is not an absolute folder')
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
