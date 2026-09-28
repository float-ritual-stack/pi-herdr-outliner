import {blockReferenceDisplayText, blockReferenceOccurrences} from './references';
import type {ResolvedBlockReferences} from './types';
import {atomicDocument, concatDocuments, generatedDocument, sliceDocument, type DocumentOrigin, type MappedDocument} from './document-provenance';

/** Replay the resolver's explicit token edits, retaining authored tokens atomically. */
export function resolvedDocument(document: MappedDocument, resolved: ResolvedBlockReferences): MappedDocument {
  const occurrences = blockReferenceOccurrences(document.text);
  const references = resolved.references ?? [];
  const unavailable = () => generatedDocument(resolved.text, 'Reference resolution did not supply matching token evidence');
  if (occurrences.length !== references.length) return unavailable();
  const parts: MappedDocument[] = [];
  let cursor = 0;
  for (let index = 0; index < occurrences.length; index++) {
    const token = occurrences[index]!, reference = references[index]!;
    if (token.blockId !== reference.blockId || token.fragmentId !== reference.fragmentId || token.label !== reference.label) return unavailable();
    parts.push(sliceDocument(document, cursor, token.start));
    const mapped = sliceDocument(document, token.start, token.end);
    // Authored syntax is linear; generated view references already carry their
    // canonical title or derived origin and must retain that ownership.
    const run = mapped.runs.length === 1 ? mapped.runs[0] : undefined;
    let origin: DocumentOrigin = {kind: 'generated', reason: 'Reference spans multiple projection origins'};
    if (run && run.start === 0 && run.end === mapped.text.length) {
      origin = run.mapping === 'linear' && run.origin.kind === 'source'
        ? {kind: 'reference', token: run.origin.slices[0]!, destination: token.blockId + (token.fragmentId ? `^${token.fragmentId}` : ''),
          ...(run.origin.occurrence ? {occurrence: run.origin.occurrence} : {})}
        : run.origin;
    }
    parts.push(atomicDocument(blockReferenceDisplayText(reference), origin));
    cursor = token.end;
  }
  parts.push(sliceDocument(document, cursor));
  const result = concatDocuments(parts);
  return result.text === resolved.text ? result : unavailable();
}
