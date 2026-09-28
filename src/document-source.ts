import {parsePropertyRecords} from './properties';
import type {Block} from './types';
import {stripFragmentAnchors} from './fragments';
import {atomicDocument, concatDocuments, observeDocument, sliceDocument, sourceDocument, type MappedDocument, type ObservedDocument} from './document-provenance';

/** Render the known source transformations while retaining their exact input slices. */
export function presentedSource(document: ObservedDocument, startLine = 0, endLine = Infinity, unindent = false, endOffset = document.text.length): MappedDocument {
  const parts: MappedDocument[] = [];
  let offset = 0, lineIndex = 0, indent = '';
  for (const line of document.text.slice(0, endOffset).split('\n')) {
    const raw = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (lineIndex >= startLine && lineIndex <= endLine) {
      if (lineIndex === startLine && unindent) indent = /^[ \t]*/.exec(raw)![0];
      const skipped = indent && raw.startsWith(indent) ? indent.length : 0;
      const visible = stripFragmentAnchors(raw.slice(skipped));
      parts.push(sourceDocument(document, offset + skipped, offset + skipped + visible.length));
      if (offset + line.length < endOffset && lineIndex < endLine) {
        const newline = {document, start: offset + raw.length, end: offset + line.length + 1};
        parts.push(atomicDocument('\n', {kind: 'source', slices: [newline]}));
      }
    }
    offset += line.length + 1;
    lineIndex++;
  }
  return concatDocuments(parts);
}


/** A generated view link displays the canonical title, not prose from the query block. */
export function projectedBlockReference(block: Block): MappedDocument {
  const observed = observeDocument({kind: 'block', blockId: block.id}, block.text, block.revision);
  const document = presentedSource(observed);
  const tokens = parsePropertyRecords(document.text).filter(property => property.syntax !== 'hashtag');
  const parts: MappedDocument[] = [];
  let cursor = 0;
  for (const token of tokens) {
    parts.push(sliceDocument(document, cursor, token.start));
    cursor = token.end;
  }
  parts.push(sliceDocument(document, cursor));
  const titleSource = concatDocuments(parts);
  let lineStart = 0;
  for (const line of titleSource.text.split('\n')) {
    if (line.trim()) {
      const start = lineStart + line.length - line.trimStart().length;
      const end = lineStart + line.trimEnd().length;
      const slices = sliceDocument(titleSource, start, end).runs.flatMap(run => run.origin.kind === 'source' ? run.origin.slices : []);
      return atomicDocument(`((${block.id}))`, {kind: 'source', slices});
    }
    lineStart += line.length + 1;
  }
  return atomicDocument(`((${block.id}))`, {kind: 'derived', resultId: `block-label:${block.id}`,
    dependencies: [{document: observed, start: 0, end: observed.text.length}]});
}
