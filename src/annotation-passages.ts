import {reanchorAnnotationTarget} from './annotation-reanchoring';
import type {ObservedDocument} from './document-provenance';
import type {AnnotationPassage, AnnotationPassageResolution, AnnotationPassageSlice,
  AnnotationPassageSliceResolution, AnnotationRepresentation, AnnotationResolutionStatus, AnnotationTarget} from './types';

/** Representation of immutable observation bytes, not permission to mutate them. */
export function passageDocumentRepresentation(document: ObservedDocument, capturedAt: string): AnnotationRepresentation {
  const resource = document.resource;
  return {id: resource?.representationId ?? `observed:${JSON.stringify(document.subject)}:${document.hash}`,
    subject: document.subject, contentHash: document.hash, capturedAt: resource?.capturedAt ?? capturedAt,
    adapter: resource?.adapter ?? {id: 'outliner.block-text', version: 1}, mediaType: 'text/markdown',
    sourceSnapshot: document.subject.kind === 'block'
      ? {kind: 'block', blockId: document.subject.blockId, updatedAt: document.inbox?.updatedAt ?? capturedAt, contentHash: document.hash,
        ...(document.inbox ? {inboxAttemptId: document.inbox.attemptId} : {})}
      : document.subject.kind === 'resource'
        ? {kind: 'resource', resourceId: document.subject.resourceId,
          sourceSnapshotId: resource?.sourceSnapshotId ?? null, revision: resource?.revision ?? null}
        : {kind: 'unknown', reason: 'Unsupported observed subject'},
  };
}

/** Resolve every slice against one consistent set of current observations. This
 * reuses the quote codec but never supplies stale positions to structural replay. */
export function resolveAnnotationPassage(passage: AnnotationPassage, capturedAt: string,
  currentDocument: (observed: ObservedDocument) => ObservedDocument | null,
  capturedTarget?: (slice: AnnotationPassageSlice) => AnnotationTarget | undefined): AnnotationPassageResolution {
  const current = new Map<number, ObservedDocument | null>();
  const resolve = (slice: AnnotationPassageSlice): AnnotationPassageSliceResolution => {
    const observed = passage.documents[slice.document]!;
    const captured = capturedTarget?.(slice);
    const unavailable = (status: AnnotationResolutionStatus, reason: string): AnnotationPassageSliceResolution => ({
      document: slice.document, resolvedTarget: null, status, confidence: null, candidates: [],
      method: {kind: 'codec', codecId: 'rendered-passage', codecVersion: 1, method: reason},
    });
    if (observed.draft) return unavailable('unsupported', 'unsaved-observation');
    if (!current.has(slice.document)) current.set(slice.document, currentDocument(observed));
    const document = current.get(slice.document);
    if (!document) return unavailable('unresolved', 'source-unavailable');
    if (JSON.stringify(document.subject) !== JSON.stringify(observed.subject)) {
      throw new Error('Passage resolution changed source ownership');
    }
    // Only service-admitted capture evidence can replay its own ID insertions.
    // This includes host tokens displaced by an insertion elsewhere in a note.
    const original = captured?.listItemId === slice.listItemId && captured?.anchor.kind === 'text-quote' &&
      captured.anchor.exact === slice.anchor.exact
      ? {representation:captured.representation, anchor:captured.anchor, ...(slice.listItemId ? {listItemId:slice.listItemId} : {})}
      : {representation: passageDocumentRepresentation(observed, capturedAt), anchor: slice.anchor,
        ...(slice.listItemId ? {listItemId: slice.listItemId} : {})};
    const unchanged = document.hash === original.representation.contentHash;
    const result = reanchorAnnotationTarget({...original,
      anchor: unchanged ? original.anchor : {...original.anchor, start: null, end: null}},
      passageDocumentRepresentation(document, capturedAt), document.text);
    return {document: slice.document, ...result};
  };
  return {fragments: passage.fragments.map(fragment => ({
    sources: fragment.kind === 'source' ? fragment.slices.map(slice => resolve(slice))
      : fragment.kind === 'reference' ? [resolve(fragment.token)] : [],
    ...((fragment.kind === 'source' || fragment.kind === 'reference') && fragment.occurrence ? {
      occurrence: {host: resolve(fragment.occurrence.host), path: fragment.occurrence.path.map(step => resolve(step.token))},
    } : {}),
  }))};
}

export function passageResolutionStatus(resolution: AnnotationPassageResolution): 'resolved' | 'unresolved' | 'unsupported' {
  const sources = resolution.fragments.flatMap(fragment => fragment.sources);
  if (!sources.length || sources.every(source => source.status === 'unsupported')) return 'unsupported';
  const positions = resolution.fragments.flatMap(fragment => [...fragment.sources,
    ...(fragment.occurrence ? [fragment.occurrence.host, ...fragment.occurrence.path] : [])]);
  return positions.every(position => position.status === 'resolved') ? 'resolved' : 'unresolved';
}
