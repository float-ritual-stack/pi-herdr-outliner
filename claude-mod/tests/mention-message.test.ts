import { describe, expect, test, tier } from 'claude-code/testing'

import { workspacesOf } from '../hooks/mention-message'

tier('user')

describe('mention-message', () => {
  test('workspaces split on either separator and keep absolute paths only', async () => {
    expect(workspacesOf(' /a/b/, relative : /c ')).toEqual(['/a/b', '/c'])
    expect(workspacesOf(['/a', 3, 'x'])).toEqual(['/a'])
    expect(workspacesOf('')).toEqual([])
    expect(workspacesOf('/')).toEqual(['/'])
  })
})
