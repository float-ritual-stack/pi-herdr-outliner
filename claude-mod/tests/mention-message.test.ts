import { describe, expect, test, tier } from 'claude-code/testing'

import { effectiveWorkspaces, workspacesOf } from '../hooks/mention-message'

tier('user')

describe('mention-message', () => {
  test('workspaces split on either separator and keep absolute paths only', async () => {
    expect(workspacesOf(' /a/b/, relative : /c ')).toEqual(['/a/b', '/c'])
    expect(workspacesOf(['/a', 3, 'x'])).toEqual(['/a'])
    expect(workspacesOf('')).toEqual([])
    expect(workspacesOf('/')).toEqual(['/'])
  })

  test('a configured option wins; an empty or unset one falls back to the environment', async () => {
    expect(effectiveWorkspaces('/option', '/env')).toEqual(['/option'])
    expect(effectiveWorkspaces('', '/env')).toEqual(['/env'])
    expect(effectiveWorkspaces(undefined, '/env')).toEqual(['/env'])
    expect(effectiveWorkspaces(' , ', '/env')).toEqual(['/env'])
    expect(effectiveWorkspaces('', undefined)).toEqual([])
  })
})
