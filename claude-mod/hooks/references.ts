/**
 * Outliner references in a Claude reply, made clickable. `Markdown` only draws
 * `https:`, `http:` and `file:` links as links, so each reference becomes an
 * https stand-in on the reserved `.invalid` domain, which never resolves: a
 * click the plugin does not take goes nowhere. The plugin maps it back to the
 * `pi-outliner://` URI the Outliner's own link navigation takes.
 */
const STAND_IN = 'https://pi-outliner.invalid/'

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'

/**
 * Code, existing links and URLs: never rewritten. An unclosed fence runs to the
 * end, as the renderer draws it.
 */
const PROTECTED = /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`|!?\[[^\]\n]*\]\([^)\n]*\)|<[a-z][a-z0-9+.-]*:[^>\s]*>|\b[a-z][a-z0-9+.-]*:\/\/[^\s<>()]+/gi

export type Linkified = {
  /** The markdown to draw, references as stand-in links. */
  text: string
  /** Every stand-in href in `text`, once each: what `pressableLinks` takes. */
  hrefs: string[]
}

/**
 * `[[page]]`, `[[target|label]]`, `((uuid))`, `((uuid|label))` and bare Work
 * IDs with one of `prefixes`, rewritten as links outside protected ranges.
 */
export function linkifyReferences(text: string, prefixes: readonly string[]): Linkified {
  const hrefs = new Set<string>()
  const workIds = prefixes
    .filter(prefix => /^[A-Z][A-Z0-9]*$/.test(prefix))
    .map(prefix => `${prefix}-\\d+`)
  const reference = new RegExp(
    `\\[\\[([^\\[\\]|\\n]+)(?:\\|([^\\[\\]\\n]+))?\\]\\]` +
      `|\\(\\((${UUID})(?:\\|([^()\\n]+))?\\)\\)` +
      (workIds.length ? `|(?<![\\w/#-])(${workIds.join('|')})(?![\\w-])` : ''),
    'g',
  )
  const rewrite = (plain: string) =>
    plain.replace(reference, (whole, page?: string, pageLabel?: string, block?: string, blockLabel?: string, workId?: string) => {
      const [kind, value, label] = page
        ? ['page', page.trim(), pageLabel?.trim() || page.trim()]
        : block
          ? ['block', block.toLowerCase(), blockLabel?.trim() || whole]
          : ['work', workId!.toUpperCase(), workId!]
      const href = `${STAND_IN}${kind}/${encodeURIComponent(value)}`
      hrefs.add(href)
      return `[${label.replace(/[[\]\\]/g, '\\$&')}](${href})`
    })

  let out = ''
  let last = 0
  for (const match of text.matchAll(PROTECTED)) {
    out += rewrite(text.slice(last, match.index)) + match[0]
    last = match.index + match[0].length
  }
  out += rewrite(text.slice(last))
  return { text: out, hrefs: [...hrefs] }
}

/**
 * The `pi-outliner://` URI a stand-in href names, or null for any other link.
 */
export function outlinerUriOf(href: string): string | null {
  if (!href.startsWith(STAND_IN)) return null
  const [kind, value, ...rest] = href.slice(STAND_IN.length).split('/')
  if (rest.length || !value || !['block', 'page', 'work'].includes(kind!)) return null
  return `pi-outliner://${kind}/${value}`
}

export type OutlinerClient = {
  clientId: string
  role: string
  paneId: string
}

/**
 * The Outliner view a click opens through: a live Tree (or combined view) in
 * the caller's Herdr tab, else one elsewhere in its workspace. `paneTabs` maps
 * each live pane of the workspace to its tab, so a client whose pane is gone
 * never qualifies. Null when there is none.
 */
export function destinationOf(
  clients: readonly OutlinerClient[],
  paneTabs: ReadonlyMap<string, string>,
  tabId: string | undefined,
): OutlinerClient | null {
  const live = clients.filter(client =>
    (client.role === 'tree' || client.role === 'composed') && paneTabs.has(client.paneId))
  return live.find(client => paneTabs.get(client.paneId) === tabId) ?? live[0] ?? null
}

/**
 * Whether a navigation failed only because its destination is mid-edit (or
 * holding a source selection): the Outliner protects it, and a new Detail is
 * the way round, never overriding the protection.
 */
export function isProtectedDestination(reason: string): boolean {
  return reason.startsWith('Destination is protected')
}

/**
 * The Herdr command that splits a new Outliner Detail below `paneId` (the
 * Claude pane), unfocused, already showing the block: somewhere visible that
 * the person can move afterwards.
 */
export function detailSplitArgv(split: {
  paneId: string
  workspace: string
  blockId: string
  fragmentId?: string
}): string[] {
  const target = { kind: 'block', blockId: split.blockId, ...(split.fragmentId ? { fragmentId: split.fragmentId } : {}) }
  return [
    'herdr', 'plugin', 'pane', 'open',
    '--plugin', 'float.pi-outliner',
    '--entrypoint', 'detail',
    '--placement', 'split',
    '--target-pane', split.paneId,
    '--direction', 'down',
    '--no-focus',
    '--cwd', split.workspace,
    '--env', `OUTLINER_WORKSPACE_ROOT=${split.workspace}`,
    '--env', `OUTLINER_DETAIL_TARGET=${encodeURIComponent(JSON.stringify(target))}`,
  ]
}
