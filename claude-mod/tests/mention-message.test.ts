import { describe, expect, test, tier } from 'claude-code/testing'

import {
  boundWorkspaceOf,
  effectiveWorkspaces,
  failureReasonOf,
  mentionsModeOf,
  sessionWorkspaceOf,
  workspaceEnvOf,
  workspacesOf,
} from '../hooks/mention-message'

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

  test('the mode: folder unless allowlist is asked for; the option wins over the environment', async () => {
    expect(mentionsModeOf('', undefined)).toBe('folder')
    expect(mentionsModeOf(undefined, ' ')).toBe('folder')
    expect(mentionsModeOf('', 'folder', ['/work/garden'])).toBe('folder')
    expect(() => mentionsModeOf('', undefined, ['/work/garden'])).toThrow('PI_OUTLINER_MENTIONS_MODE is unset')
    expect(mentionsModeOf('', 'allowlist')).toBe('allowlist')
    expect(mentionsModeOf('folder', 'allowlist')).toBe('folder')
    expect(mentionsModeOf(' allowlist ', undefined)).toBe('allowlist')
    expect(() => mentionsModeOf('', 'strict')).toThrow('"strict" is neither folder nor allowlist')
  })

  test("bound-folder's answer: a bound folder containing the cwd, or nothing", async () => {
    const client = '{"bound":true,"source":"client","folder":"/work/garden","configPath":"/c/client.json","mode":"host","outline":"garden"}'
    expect(boundWorkspaceOf(client, '/work/garden/src')).toEqual({ root: '/work/garden', outline: 'garden', pinned: true })
    expect(boundWorkspaceOf('{"bound":true,"source":"client","folder":"/work/garden","mode":"local"}', '/work/garden')).toEqual({ root: '/work/garden', pinned: true })
    expect(boundWorkspaceOf('{"bound":true,"source":"client","folder":"/work/garden","mode":"host"}', '/work/garden')).toBeNull()
    expect(boundWorkspaceOf('{"bound":true,"source":"host-root","folder":"/work/jam/notes/","outline":"jam-shelf"}', '/work/jam/notes'))
      .toEqual({ root: '/work/jam/notes', outline: 'jam-shelf', pinned: true })
    expect(boundWorkspaceOf('{"bound":false,"folder":"/tmp/scratch"}', '/tmp/scratch')).toBeNull()
    // A folder that doesn't hold the session, a sibling prefix, a relative folder or an unknown source binds nothing.
    expect(boundWorkspaceOf(client, '/home/sam')).toBeNull()
    expect(boundWorkspaceOf(client, '/work/garden-other')).toBeNull()
    expect(boundWorkspaceOf('{"bound":true,"source":"client","folder":"garden"}', '/work/garden')).toBeNull()
    expect(boundWorkspaceOf('{"bound":true,"source":"guess","folder":"/work/garden","outline":"garden"}', '/work/garden')).toBeNull()
    expect(boundWorkspaceOf('{"bound":true,"source":"host-root","folder":"/work/garden"}', '/work/garden')).toBeNull()
    expect(boundWorkspaceOf('Unknown command', '/work/garden')).toBeNull()
  })

  test("the session's workspace: opt-outs first, then the binding; strict mode lists only", async () => {
    const bound = { root: '/work/garden' }
    expect(sessionWorkspaceOf('/work/garden/src', 'folder', [], bound)).toEqual(bound)
    expect(sessionWorkspaceOf('/tmp/scratch', 'folder', [], null)).toBeNull()
    expect(sessionWorkspaceOf('/work/garden/src', 'folder', ['/work/garden/src'], bound)).toBeNull()
    expect(sessionWorkspaceOf('/work/garden/src', 'folder', ['/work'], bound)).toBeNull()
    expect(sessionWorkspaceOf('/work/garden/src', 'folder', ['/work/gard'], bound)).toEqual(bound)
    expect(sessionWorkspaceOf('/work/garden/src', 'allowlist', ['/work/garden'], null)).toEqual({ root: '/work/garden' })
    expect(sessionWorkspaceOf('/work/garden/src', 'allowlist', [], bound)).toBeNull()
  })

  test("a bound workspace's CLI environment pins the outline that bound it; a strict-mode one is the CLI's to resolve", async () => {
    expect(workspaceEnvOf({ root: '/work/garden' })).toEqual({ OUTLINER_WORKSPACE_ROOT: '/work/garden' })
    expect(workspaceEnvOf({ root: '/work/jam/notes', outline: 'jam-shelf', pinned: true }))
      .toEqual({ OUTLINER_WORKSPACE_ROOT: '/work/jam/notes', OUTLINER_OUTLINE: 'jam-shelf', OUTLINER_CONFIG_PATH: '' })
    // A local or remote choice: an inherited OUTLINER_OUTLINE or OUTLINER_CONFIG_PATH is blanked, so the folder's config decides.
    expect(workspaceEnvOf({ root: '/work/garden', pinned: true })).toEqual({ OUTLINER_WORKSPACE_ROOT: '/work/garden', OUTLINER_OUTLINE: '', OUTLINER_CONFIG_PATH: '' })
  })
})
