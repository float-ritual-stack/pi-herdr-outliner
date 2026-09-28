import {expect, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OutlinerClient} from '../src/client';
import {OutlinerServer} from '../src/server';
import {OutlinerStore} from '../src/store';
import {loadDetailReadPreview,loadDetailDraftPreview} from '../src/detail-read-preview';
import {observeDocument} from '../src/document-provenance';
import {DocumentPreview} from '../src/document-preview';
import type {Block} from '../src/types';

test('Preview loading retains canonical observations through references, embeds, fragment presentation and clipping', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'preview-source-'));
  const store = new OutlinerStore(join(directory, 'outline.sqlite'));
  const server = new OutlinerServer(store, join(directory, 'outliner.sock'));
  await server.start();
  const client = new OutlinerClient(join(directory, 'outliner.sock'));
  try {
    const target = await client.request<Block>({action:'create', text:'A much longer destination title that keeps going beyond the bounded preview'});
    const source = await client.request<Block>({action:'create', text:`Plan ^hidden\r\n\r\nSee ((${target.id})) and ((${target.id}|Short)).\r\n\r\n  - [ ] 界 é 👩‍💻 ^step\r\n    continuation\r\n\r\nTail`});
    const hash = createHash('sha256').update(source.text).digest('hex');
    const document = await loadDetailReadPreview(client, source);
    expect(document.resolvedText).toContain('See ((A much longer destination title that keeps going beyond the bounded preview)) and ((Short)).');
    const references = document.provenance!.runs.flatMap(run => run.origin.kind === 'reference' ? [run.origin] : []);
    expect(references.map(origin => source.text.slice(origin.token.start, origin.token.end))).toEqual([
      `((${target.id}))`, `((${target.id}|Short))`,
    ]);
    expect(references.map(origin => origin.token.start)).toEqual([20, 20 + target.id.length + 9]);
    for (const reference of references) {
      expect(reference.token.document).toMatchObject({subject:{kind:'block',blockId:source.id}, hash, revision:source.revision, text:source.text});
      expect(reference.destination).toBe(target.id);
    }

    // Truncation inside an expanded label must retain the whole authored token,
    // whereas the document observation still describes the unabridged note.
    const clipped = await loadDetailReadPreview(client, source, 62);
    expect(clipped.truncated).toBe(true);
    expect(clipped.resolvedText.length).toBeLessThanOrEqual(62);
    expect(clipped.sourceBlock!.text).toBe(source.text);
    for (const run of clipped.provenance!.runs) {
      const observations = run.origin.kind === 'source' ? run.origin.slices.map(slice => slice.document)
        : run.origin.kind === 'reference' ? [run.origin.token.document] : [];
      for (const observation of observations) expect(observation).toMatchObject({text:source.text, hash, revision:source.revision});
    }
    const clippedReference = clipped.provenance!.runs.find(run => run.origin.kind === 'reference')!;
    expect(clippedReference.end).toBe(62);
    expect(clippedReference.origin.kind === 'reference' && source.text.slice(clippedReference.origin.token.start, clippedReference.origin.token.end)).toBe(`((${target.id}))`);

    const reader = new DocumentPreview(client, () => {});
    await reader.load({kind:'block',blockId:source.id,fragmentId:'step'});
    expect(reader.state!.document.resolvedText).toContain('- [ ] 界 é 👩‍💻');
    const fragmentSlices = reader.state!.document.provenance!.runs.flatMap(run => run.origin.kind === 'source' ? run.origin.slices : []);
    expect(fragmentSlices.filter(slice => source.text.slice(slice.start,slice.end).trim()).map(slice => source.text.slice(slice.start,slice.end)))
      .toEqual(['- [ ] 界 é 👩‍💻', '  continuation']);
    expect(fragmentSlices.every(slice => slice.document.hash === hash && slice.document.text === source.text)).toBe(true);

    const host = await client.request<Block>({action:'create',text:`# Host\n!((${source.id}))\nAgain !((${source.id}))`});
    const embedded = await loadDetailReadPreview(client, host);
    const embeddedReferences = embedded.provenance!.runs.flatMap(run => run.origin.kind === 'reference' && run.origin.destination === target.id ? [run.origin] : []);
    expect(embeddedReferences).toHaveLength(4);
    expect(new Set(embeddedReferences.map(origin => origin.occurrence!.host.start)).size).toBe(2);
    expect(embeddedReferences.every(origin => origin.token.document.hash === hash && origin.occurrence!.host.document.subject.kind === 'block'
      && origin.occurrence!.host.document.subject.blockId === host.id)).toBe(true);

    const draftText=`# Unsaved ^draft\nNew ((${target.id})).\n!((${source.id}))`;
    const draft=await loadDetailDraftPreview(client,{...observeDocument({kind:'block',blockId:host.id},draftText),draft:true});
    expect(draft.provenance.text).not.toContain('^draft');
    const draftReferences=draft.provenance.runs.flatMap(run=>run.origin.kind==='reference'?[run.origin]:[]);
    const hostReference=draftReferences.find(origin=>origin.token.document.subject.kind==='block'&&origin.token.document.subject.blockId===host.id)!;
    expect(hostReference.token.document).toMatchObject({text:draftText,draft:true});
    expect(hostReference.token.document.revision).toBeUndefined();
    const embeddedDraftReference=draftReferences.find(origin=>origin.occurrence)!;
    expect(embeddedDraftReference.token.document).toMatchObject({text:source.text,revision:source.revision});
    expect(embeddedDraftReference.token.document.draft).toBeUndefined();
    expect(embeddedDraftReference.occurrence!.host.document).toMatchObject({text:draftText,draft:true});
    expect((await client.request<Block>({action:'get',blockId:host.id})).text).toBe(host.text);
  } finally {
    await server.close(); store.close(); rmSync(directory, {recursive:true, force:true});
  }
});
