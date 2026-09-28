import {annotationSourceHash} from './annotations';
import type {AnnotationSubject} from './types';
import type {ResourceRevisionRef,ResourceRepresentationAdapter} from './resources';

export interface ObservedDocument {
  subject: AnnotationSubject;
  text: string;
  hash: string;
  revision?: number;
  /** Unsaved bytes observed in an editor, never a claim about persisted content. */
  draft?: true;
  /** Saved Inbox before-image, never authority to change the live block. */
  inbox?: {attemptId: string; updatedAt: string};
  /** Provider observation, separate from a block's integer edit revision. */
  resource?: {
    revision: ResourceRevisionRef;
    adapter: ResourceRepresentationAdapter;
    representationId?: string;
    sourceSnapshotId?: string;
    capturedAt: string;
  };
}

export interface SourceSlice {
  document: ObservedDocument;
  start: number;
  end: number;
}

export interface DocumentOccurrence {
  host: SourceSlice;
  path: readonly {token: SourceSlice; target: string}[];
}

export type DocumentOrigin =
  | {kind: 'source'; slices: readonly SourceSlice[]; occurrence?: DocumentOccurrence}
  | {kind: 'reference'; token: SourceSlice; destination: string; occurrence?: DocumentOccurrence}
  | {kind: 'derived'; resultId: string; dependencies: readonly SourceSlice[];
      result?: ObservedDocument; resourceDependencies?: readonly ResourceRevisionRef[]}
  | {kind: 'generated'; reason: string};

export interface ProjectedRun {
  start: number;
  end: number;
  origin: DocumentOrigin;
  /** Linear is permitted only for unchanged source text, never transformed labels. */
  mapping: 'linear' | 'atomic';
}

export interface MappedDocument {
  text: string;
  runs: readonly ProjectedRun[];
}

export function observeDocument(subject: AnnotationSubject, text: string, revision?: number): ObservedDocument {
  return {subject, text, hash: annotationSourceHash(text), ...(revision === undefined ? {} : {revision})};
}

export function sourceDocument(document: ObservedDocument, start = 0, end = document.text.length): MappedDocument {
  requireRange(start, end, document.text.length);
  return {text: document.text.slice(start, end), runs: start === end ? [] : [{start: 0, end: end - start,
    origin: {kind: 'source', slices: [{document, start, end}]}, mapping: 'linear'}]};
}

export function atomicDocument(text: string, origin: DocumentOrigin): MappedDocument {
  return {text, runs: text ? [{start: 0, end: text.length, origin, mapping: 'atomic'}] : []};
}

export function concatDocuments(parts: readonly MappedDocument[]): MappedDocument {
  let text = '';
  const runs: ProjectedRun[] = [];
  for (const part of parts) {
    const offset = text.length;
    text += part.text;
    for (const run of part.runs) runs.push({...run, start: run.start + offset, end: run.end + offset});
  }
  return {text, runs};
}

function requireRange(start: number, end: number, length: number): void {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > length) {
    throw new Error('Document range must use bounded UTF-16 offsets');
  }
}

/** Compose known edits by slicing their input map, never by searching the output. */
export function sliceDocument(document: MappedDocument, start: number, end = document.text.length): MappedDocument {
  requireRange(start, end, document.text.length);
  const runs = document.runs.flatMap(run => {
    const left = Math.max(start, run.start), right = Math.min(end, run.end);
    if (right <= left) return [];
    let origin = run.origin;
    if (run.mapping === 'linear') {
      if (origin.kind !== 'source' || origin.slices.length !== 1) throw new Error('Linear projection requires one source slice');
      const slice = origin.slices[0]!;
      if (slice.end - slice.start !== run.end - run.start) throw new Error('Linear projection length differs from its source');
      origin = {...origin, slices: [{...slice, start: slice.start + left - run.start, end: slice.start + right - run.start}]};
    }
    return [{...run, start: left - start, end: right - start, origin}];
  });
  return {text: document.text.slice(start, end), runs};
}

export function withDocumentOccurrence(document: MappedDocument, occurrence: DocumentOccurrence): MappedDocument {
  return {...document, runs: document.runs.map(run => ({...run,
    origin: run.origin.kind === 'source' || run.origin.kind === 'reference' ? {...run.origin,
      occurrence: run.origin.occurrence ? {...occurrence, path: [...occurrence.path, ...run.origin.occurrence.path]} : occurrence,
    } : run.origin}))};
}

export function generatedDocument(text: string, reason: string): MappedDocument {
  return atomicDocument(text, {kind: 'generated', reason});
}

/** Layout invalidation includes hidden source changes without serializing each
 * observed document's full text for every visible run. */
export function documentProvenanceKey(document: MappedDocument): string {
  return JSON.stringify(document.runs, (key, value) => key === 'document'
    ? observedDocumentIdentity(value) : value);
}

export function observedDocumentIdentity(document:ObservedDocument):unknown {
  return {subject:document.subject,hash:document.hash,revision:document.revision,draft:document.draft,inbox:document.inbox,resource:document.resource};
}
