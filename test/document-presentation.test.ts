import {expect, test} from 'bun:test';
import {observeDocument, sourceDocument, sliceDocument, withDocumentOccurrence} from '../src/document-provenance';
import {propertyInspectorAuthoredDocument} from '../src/property-inspector';
import {presentReaderHeadings, sanitizeReaderDocument} from '../src/document-presentation';

// Owner boundary: reader transforms must retain canonical offsets even when
// identical displayed words, metadata removal and terminal controls shift them.
test('reader presentation preserves exact UTF-16 slices through metadata, controls, tabs and heading changes', () => {
  const text = 'Title [type::note]\r\n[status::open]\r\n\r\n### Repeat\r\nA\tB\x1b[31mC\x1b[0m 👩🏽‍💻\r\nRepeat';
  const observed = observeDocument({kind:'block',blockId:'synthetic-note'}, text, 7);
  const result = presentReaderHeadings(sanitizeReaderDocument(propertyInspectorAuthoredDocument(sourceDocument(observed))));
  expect(result.text).toBe('# Title\n\n## › Repeat\nA    BC 👩🏽‍💻\nRepeat');
  const ranges = (start:number, end:number) => sliceDocument(result,start,end).runs.map(run => {
    expect(run.origin.kind).toBe('source');
    if(run.origin.kind !== 'source') throw Error('Expected observed source');
    return run.origin.slices.map(slice => {
      expect(slice.document).toEqual(observed);
      return [slice.start,slice.end];
    });
  }).flat();
  expect(ranges(2,7)).toEqual([[0,5]]);
  expect(ranges(14,20)).toEqual([[42,48]]);
  expect(ranges(22,26)).toEqual([[51,52]]); // Four spaces, one authored tab.
  expect(ranges(27,28)).toEqual([[58,59]]); // C after the stripped SGR.
  expect(ranges(29,36)).toEqual([[64,71]]); // Entire multi-codepoint emoji.
  expect(ranges(37,43)).toEqual([[73,79]]); // Second Repeat, not the heading.
  expect(sliceDocument(result,9,14).runs.map(run => run.origin)).toEqual([{kind:'generated',reason:'reader heading depth'}]);
});

test('sanitization retains source separation and repeated occurrence identity around OSC and C1 controls', () => {
  const text = 'a\x1b]8;;https://example.test\x07b\x1b]8;;\x1b\\c\u009b31md\u009dhidden\u009ce';
  const observed = observeDocument({kind:'block',blockId:'synthetic-embedded'},text,2);
  const host = observeDocument({kind:'block',blockId:'synthetic-host'},'!((first)) !((second))',1);
  const token = {document:host,start:11,end:22};
  const occurrence = {host:token,path:[{token,target:'synthetic-embedded'}]};
  const result = sanitizeReaderDocument(withDocumentOccurrence(sourceDocument(observed),occurrence));
  expect(result.text).toBe('abcde');
  expect(result.runs.map(run => {
    if(run.origin.kind !== 'source') throw Error('Expected observed source');
    expect(run.origin.occurrence).toEqual(occurrence);
    return run.origin.slices.map(slice=>[slice.start,slice.end]);
  })).toEqual([[[0,1]],[[27,28]],[[35,36]],[[40,41]],[[49,50]]]);
});

test('fenced headings remain literal and quoted heading prefixes retain their own source', () => {
  const observed=observeDocument({kind:'block',blockId:'synthetic-fences'},'Title\n```md\n### literal\n```\n> #### Nested');
  const result=presentReaderHeadings(sourceDocument(observed));
  expect(result.text).toBe('# Title\n```md\n### literal\n```\n> ## ›› Nested');
  const literal=sliceDocument(result,14,25).runs[0]!.origin;
  expect(literal.kind==='source' && literal.slices.map(s=>[s.start,s.end])).toEqual([[12,23]]);
  const quote=sliceDocument(result,30,32).runs[0]!.origin;
  expect(quote.kind==='source' && quote.slices.map(s=>[s.start,s.end])).toEqual([[28,30]]);
});

test('link labels retain their authored token through generated Markdown escapes and repeated aliases', async () => {
  const {linkOutlinerDocument} = await import('../src/outliner-links');
  const {atomicDocument, concatDocuments} = await import('../src/document-provenance');
  const raw = 'See [[guide|Read me]] and [[guide|Read me]].';
  const observed = observeDocument({kind:'block',blockId:'synthetic-links'},raw,3);
  const linked = linkOutlinerDocument(sourceDocument(observed),raw);
  expect(linked.text).toBe('See [Read me](pi-outliner://page/guide) and [Read me](pi-outliner://page/guide).');
  expect(linked.runs.flatMap(run=>run.origin.kind==='reference' ? [[run.origin.token.start,run.origin.token.end]] : []))
    .toEqual([[4,21],[26,43]]);
  expect(linked.runs.filter(run=>run.origin.kind==='generated').every(run=>run.mapping==='atomic')).toBe(true);

  // A view row already owns the canonical title rather than the host query.
  const title=observeDocument({kind:'block',blockId:'synthetic-title'},'Read ] me',5);
  const id='11111111-1111-4111-8111-111111111111';
  const projected=concatDocuments([atomicDocument('((Read ] me))',{kind:'source',slices:[{document:title,start:0,end:9}]})]);
  const viewLink=linkOutlinerDocument(projected,`((${id}))`);
  expect(viewLink.text).toBe(`[Read \\] me](pi-outliner://block/${id})`);
  const origins=viewLink.runs.flatMap(run=>run.origin.kind==='source' ? run.origin.slices : []);
  expect(origins.length).toBeGreaterThan(0);
  for(const origin of origins)expect(origin).toEqual({document:title,start:0,end:9});
});
