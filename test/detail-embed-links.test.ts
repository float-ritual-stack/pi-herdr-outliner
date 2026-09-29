import {expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {MarkdownTheme} from '@earendil-works/pi-tui';
import {OutlinerClient} from '../src/client';
import {OutlinerServer} from '../src/server';
import {OutlinerStore} from '../src/store';
import {loadDetailReadPreview} from '../src/detail-read-preview';
import {renderDetailReadPreview} from '../src/detail-pi-preview';
import {measureRenderedLinks, withInternalLinks} from '../src/rendered-links';
import {linkOutlinerMarkdown, parseOutlinerLinkUri} from '../src/outliner-links';
import type {Block} from '../src/types';
import {blockReferenceEnvelopeRanges, blockReferenceOccurrences, resolveBlockReferencesWithStatus} from '../src/references';
import {completionTargetAtCursor} from '../src/completion';

const plain = (value: string) => value;
const theme: MarkdownTheme = {heading:plain,link:plain,linkUrl:plain,code:plain,codeBlock:plain,codeBlockBorder:plain,
  quote:plain,quoteBorder:plain,hr:plain,listBullet:plain,bold:plain,italic:plain,strikethrough:plain,underline:plain};

/** The link targets Detail's click mapping sees: OSC 8 cells in the rendered reader. */
async function clickableBlockTargets(client: OutlinerClient, block: Block): Promise<string[]> {
  const document = await loadDetailReadPreview(client, block);
  const {lines} = withInternalLinks(() => renderDetailReadPreview(document, 100, theme, undefined, true));
  return measureRenderedLinks(lines).flatMap(link => {
    if (!link.uri.startsWith('pi-outliner:')) return []; // checklist, fold and embed controls
    const target = parseOutlinerLinkUri(link.uri);
    return target.kind === 'block' ? [target.value] : [];
  });
}

function roughEdges(parentTitle: string, otherId: string): string {
  return [
    parentTitle,
    '',
    '- [x] Write `((uuid))` to link a note, or `((uuid|label))` to name it ^link-syntax',
    '- [!] **Embeds** like `!((b8f38120-0000-4000-8000-00000000abcd|doing))` show a label they ignore ^embed-label',
    '- [ ] Ticket titles such as `((PC-1027: thanks Kim; follow up))` are not references ^q-missing-query',
    `- [ ] See ((${otherId}|Rough edges from day one)) for the first list ^first-list`,
    '',
    '[type::test-plan]',
  ].join('\n');
}

test('an embedded note whose title has parentheses keeps every link in the host clickable', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'embed-links-'));
  const store = new OutlinerStore(join(directory, 'outline.sqlite'));
  const server = new OutlinerServer(store, join(directory, 'outliner.sock'));
  await server.start();
  const client = new OutlinerClient(join(directory, 'outliner.sock'));
  try {
    const first = await client.request<Block>({action:'create', text:'Day one list'});
    const a = await client.request<Block>({action:'create', text:'Alpha notes'});
    const b = await client.request<Block>({action:'create', text:'Bravo notes'});
    const c = await client.request<Block>({action:'create', text:roughEdges('Rough edges (2026-09-29)', first.id)});

    const referenced = await client.request<Block>({action:'create',
      text:`jazzhands\n\n((${a.id}))\n\n!((${b.id}))\n\n((${c.id}))`});
    const before = await clickableBlockTargets(client, referenced);
    expect(before).toEqual(expect.arrayContaining([a.id, b.id, c.id]));

    const embedded = await client.request<Block>({action:'create',
      text:`jazzhands\n\n((${a.id}))\n\n!((${b.id}))\n\n!((${c.id}))`});
    const after = await clickableBlockTargets(client, embedded);
    // The references above the embed, the embeds' headers and the embed's own reference.
    expect(after).toEqual(expect.arrayContaining([a.id, b.id, c.id, first.id]));
  } finally {
    await server.close(); store.close(); rmSync(directory, {recursive:true, force:true});
  }
});

test('a resolved title with parentheses is one link, and the references after it keep their targets', () => {
  const raw = '((aaaaaaaa1)) then ((bbbbbbbb2)) and ((cccccccc3)).';
  const resolved = '((Alpha)) then ((Rough edges (2026-09-29))) and ((Smile :))).';
  const linked = linkOutlinerMarkdown(resolved, raw);
  const targets = [...linked.matchAll(/\[((?:\\.|[^\]])*)\]\(([^)\s]+)\)/g)].map(match => [match[1], parseOutlinerLinkUri(match[2]!).value]);
  expect(targets).toEqual([
    ['Alpha', 'aaaaaaaa1'],
    ['Rough edges (2026-09-29)', 'bbbbbbbb2'],
    ['Smile :)', 'cccccccc3'],
  ]);
});

test('a label or title with parentheses stays inside its reference', () => {
  const id = 'b8f38120-0000-4000-8000-00000000abcd';
  const text = `See ((${id}|Label (with parens))) and ((${id}^step-one|plain)) then ((${id})).`;
  expect(blockReferenceOccurrences(text).map(({label, fragmentId, start, end}) => ({label, fragmentId, token: text.slice(start, end)})))
    .toEqual([
      {label: 'Label (with parens)', fragmentId: undefined, token: `((${id}|Label (with parens)))`},
      {label: 'plain', fragmentId: 'step-one', token: `((${id}^step-one|plain))`},
      {label: undefined, fragmentId: undefined, token: `((${id}))`},
    ]);
  const titled = 'Ticket ((Rough edges (2026-09-29))) then ((PC-1027: follow up)) and ((a (b)) c)).';
  expect(blockReferenceEnvelopeRanges(titled).map(({start, end}) => titled.slice(start, end)))
    .toEqual(['((Rough edges (2026-09-29)))', '((PC-1027: follow up))', '((a (b))']);
  const resolved = resolveBlockReferencesWithStatus(`Read ((${id}|Label (x))) twice: ((${id})).`,
    () => ({id, text: 'Rough edges (2026-09-29)'} as Block));
  expect(resolved.text).toBe('Read ((Label (x))) twice: ((Rough edges (2026-09-29))).');
  expect(resolved.references.map(reference => reference.label)).toEqual(['Label (x)', undefined]);
});

test('completion replaces a whole title reference with parentheses', () => {
  const line = 'Link ((Rough edges (2026)))';
  expect(completionTargetAtCursor(line, line.indexOf('2026') + 2)).toEqual({
    kind: 'block', start: 5, end: line.length, query: 'Rough edges (20',
  });
});
