import {annotationSourceHash, createTextQuoteAnchor, normalizeAnnotationPassage} from './annotations';
import type {DocumentSelection} from './document-frame';
import {observedDocumentIdentity, type DocumentOccurrence, type ObservedDocument, type SourceSlice} from './document-provenance';
import type {AnnotationPassage, AnnotationPassageFragment, AnnotationPassageOccurrence, AnnotationPassageSlice, AnnotationTarget, AnnotationSubject, AnnotationReferenceContext, PreviewPassageObservation} from './types';

/** Retain one rendered quote and separate exact source slices. Intern observations,
 * not subjects: two revisions of a note are different evidence. No range is
 * inferred from the selected text, and decoration never acquires an anchor. */
export function captureAnnotationPassage(selection: DocumentSelection): AnnotationPassage {
  const documents: ObservedDocument[] = [];
  const indices = new Map<string, number>();
  const observe = (document: ObservedDocument): number => {
    const key = JSON.stringify(observedDocumentIdentity(document));
    const existing = indices.get(key);
    if (existing !== undefined) {
      if (documents[existing]!.text !== document.text) throw new Error('Conflicting passage observations');
      return existing;
    }
    const index = documents.length;
    documents.push(document);
    indices.set(key, index);
    return index;
  };
  const slice = (source: SourceSlice): AnnotationPassageSlice => ({document: observe(source.document),
    anchor: createTextQuoteAnchor(source.document.text, source.start, source.end)});
  const occurrence = (source: DocumentOccurrence): AnnotationPassageOccurrence => ({host: slice(source.host),
    path: source.path.map(step => ({token: slice(step.token), target: step.target}))});
  const fragments = selection.origins.map((origin): AnnotationPassageFragment => {
    if (origin.kind === 'generated') return {kind: 'generated', reason: origin.reason};
    if (origin.kind === 'derived') return {kind: 'derived', resultId: origin.resultId,
      dependencies: origin.dependencies.map(slice),
      ...(origin.result ? {result: observe(origin.result)} : {}),
      ...(origin.resourceDependencies ? {resourceDependencies: origin.resourceDependencies} : {}),
    };
    const context = origin.occurrence ? {occurrence: occurrence(origin.occurrence)} : {};
    return origin.kind === 'source' ? {kind: 'source', slices: origin.slices.map(slice), ...context}
      : {kind: 'reference', token: slice(origin.token), destination: origin.destination, ...context};
  });
  // Normalize creates an owned snapshot, also enforcing the persistence contract
  // before the composer can outlive this frame or the source documents.
  const passage = normalizeAnnotationPassage({version: 1, quote: selection.text, documents, fragments});
  const freeze = (value: unknown): void => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
  };
  freeze(passage);
  return passage;
}

/** The outer target owns the rendered quote. Exact ranges live only in the
 * passage fragments; never pretend transformed text is a contiguous source. */
export function renderedDocumentAnnotationTarget(input: {
  subject:AnnotationSubject; passage:AnnotationPassage; snapshotText:string;
  capturedAt:string; readerId:string; renderRevision:number;
  input:'pointer'|'keyboard'; projection:PreviewPassageObservation['projection'];
  fragmentId?:string; referenceContext?:AnnotationReferenceContext;
}):AnnotationTarget {
  const snapshotHash=annotationSourceHash(input.snapshotText);
  const representationId=`preview:${input.readerId}:${input.renderRevision}:${snapshotHash}`;
  const observation:PreviewPassageObservation={
    validation:'preview-selection',input:input.input,quote:input.passage.quote,capturedAt:input.capturedAt,
    readerId:input.readerId,renderRevision:input.renderRevision,representationId,snapshotHash,
    projection:input.projection,...(input.fragmentId?{fragmentId:input.fragmentId}:{}),
  };
  return {passage:input.passage,...(input.referenceContext?{referenceContext:input.referenceContext}:{}),
    representation:{id:representationId,subject:input.subject,sourceSnapshot:{kind:'rendered',observation},
      observation,adapter:{id:'outliner.document-frame',version:1},mediaType:'text/plain',
      contentHash:snapshotHash,capturedAt:input.capturedAt},
    anchor:{kind:'text-quote',start:null,end:null,exact:input.passage.quote,prefix:'',suffix:''}};
}
