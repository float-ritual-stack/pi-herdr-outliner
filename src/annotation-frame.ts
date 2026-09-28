import type {DocumentCell, DocumentFrame} from './document-frame';
import {checklistItems} from './checklist-items';
import {passageDocumentRepresentation} from './annotation-passages';
import type {DocumentOrigin, ObservedDocument, SourceSlice} from './document-provenance';
import type {AnnotationPassage, AnnotationPassageResolution, AnnotationPassageSlice,AnnotationPassageSliceResolution, AnnotationTarget, AnnotationThread} from './types';

/** Match evidence to cells at the current width. Hashes establish byte identity;
 * coordinates alone, including an old coordinate with identical-looking text,
 * do not. Host tokens use exact bounds so repeated embeds remain distinct. */
function matchesSlice(slice: SourceSlice, target: AnnotationTarget | null, exact = false,
  itemMarkers?: WeakMap<ObservedDocument,Map<string,number>>): boolean {
  if (!target || slice.document.draft) return false;
  const {representation, anchor} = target;
  if (representation.sourceSnapshot.kind === 'rendered' || representation.contentHash !== slice.document.hash ||
    JSON.stringify(representation.subject) !== JSON.stringify(slice.document.subject)) return false;
  if(slice.document.resource && (representation.sourceSnapshot.kind!=='resource' ||
    JSON.stringify(representation.sourceSnapshot.revision)!==JSON.stringify(slice.document.resource.revision) ||
    JSON.stringify(representation.adapter)!==JSON.stringify(slice.document.resource.adapter) ||
    (slice.document.resource.representationId!==undefined && representation.id!==slice.document.resource.representationId)))return false;
  if (anchor.kind === 'list-item') {
    if (!itemMarkers || exact) return false;
    let markers = itemMarkers.get(slice.document);
    if (!markers) {
      markers = new Map(checklistItems(slice.document.text).flatMap(item => item.identity === 'unique' ? [[item.itemId!,item.markerStart]] : []));
      itemMarkers.set(slice.document, markers);
    }
    const marker = markers.get(anchor.itemId);
    return marker !== undefined && slice.start < marker + 3 && marker < slice.end;
  }
  if ((anchor.kind !== 'text-quote' && anchor.kind !== 'pdf-page-region') || anchor.start === null || anchor.end === null ||
    slice.document.text.slice(anchor.start, anchor.end) !== anchor.exact) return false;
  return exact ? slice.start === anchor.start && slice.end === anchor.end
    : slice.start < anchor.end && anchor.start < slice.end;
}

function currentTarget(position: AnnotationPassageSliceResolution | undefined): AnnotationTarget | null {
  return position?.status === 'resolved' ? position.resolvedTarget : null;
}

/** One logical thread can occupy discontiguous cells from several sources. Never
 * fill the gaps or attach a contextual fragment to a different occurrence. */
function annotationPassageMatcher(thread: AnnotationThread, includeItemAttachments = false, historical = false): (origin:DocumentOrigin)=>boolean {
  const passage = thread.originalTarget.passage;
  const resolution = thread.currentResolution.passageResolution;
  if (!passage || !resolution) return ()=>false;
  const resolutions = historical
    ? [resolution, ...thread.resolutionHistory.flatMap(event => event.passageResolution ? [event.passageResolution] : []),
      capturedResolution(passage, thread.originalTarget.representation.capturedAt)]
    : [resolution];
  return passageMatcher(passage, resolutions, includeItemAttachments);
}

function capturedResolution(passage: AnnotationPassage, capturedAt: string): AnnotationPassageResolution {
  const original = (slice: AnnotationPassageSlice): AnnotationPassageSliceResolution => ({document: slice.document,
    resolvedTarget: {representation: passageDocumentRepresentation(passage.documents[slice.document]!, capturedAt), anchor: slice.anchor},
    status: 'resolved', confidence: 1, candidates: [],
    method: {kind: 'codec', codecId: 'rendered-passage', codecVersion: 1, method: 'displayed-observation'}});
  return {fragments: passage.fragments.map(fragment => ({
    sources: fragment.kind === 'source' ? fragment.slices.map(original) : fragment.kind === 'reference' ? [original(fragment.token)] : [],
    ...((fragment.kind === 'source' || fragment.kind === 'reference') && fragment.occurrence ? {
      occurrence: {host: original(fragment.occurrence.host), path: fragment.occurrence.path.map(step => original(step.token))},
    } : {}),
  }))};
}

function passageMatcher(passage: AnnotationPassage, resolutions: readonly AnnotationPassageResolution[], includeItemAttachments = false): (origin: DocumentOrigin) => boolean {
  const itemMarkers = includeItemAttachments ? new WeakMap<ObservedDocument,Map<string,number>>() : undefined;
  return (origin: DocumentOrigin): boolean => resolutions.some(evidence=>passage.fragments.some((fragment, index) => {
    if ((fragment.kind !== 'source' && fragment.kind !== 'reference') || origin.kind !== fragment.kind) return false;
    const position = evidence.fragments[index];
    if (!position) return false;
    if (fragment.kind === 'reference' && origin.kind === 'reference' && fragment.destination !== origin.destination) return false;
    if (fragment.occurrence) {
      const observed = origin.occurrence;
      const resolved = position.occurrence;
      if (!observed || !resolved || !matchesSlice(observed.host, currentTarget(resolved.host), true) ||
        fragment.occurrence.path.length !== observed.path.length ||
        !observed.path.every((step, n) => step.target === fragment.occurrence!.path[n]!.target &&
          matchesSlice(step.token, currentTarget(resolved.path[n]), true))) return false;
    } else if (origin.occurrence) return false;
    const slices = origin.kind === 'source' ? origin.slices : [origin.token];
    return slices.some(slice => position.sources.some(source => matchesSlice(slice, currentTarget(source), false, itemMarkers)));
  }));
}

/** Old exact targets and new multi-source passages use the same cell matcher.
 * The reader selects the admissible historical/contextual target before here. */
export function annotationFrameMatcher(thread:AnnotationThread,includeItemAttachments=false,historical=false,target?:AnnotationTarget):(origin:DocumentOrigin)=>boolean {
  if(thread.originalTarget.passage)return annotationPassageMatcher(thread,includeItemAttachments,historical);
  return annotationTargetMatcher(target, includeItemAttachments);
}

/** A composer has captured evidence, not a saved thread or a resolution event.
 * Highlight only cells that still match that immutable observation. */
export function annotationTargetMatcher(target: AnnotationTarget | undefined, includeItemAttachments = false): (origin: DocumentOrigin) => boolean {
  if (target?.passage) return passageMatcher(target.passage,
    [capturedResolution(target.passage, target.representation.capturedAt)], includeItemAttachments);
  const markers=includeItemAttachments?new WeakMap<ObservedDocument,Map<string,number>>():undefined;
  return origin=>(origin.kind==='source'?origin.slices:origin.kind==='reference'?[origin.token]:[])
    .some(slice=>matchesSlice(slice,target??null,false,markers));
}

export function annotationFrameCells(thread: AnnotationThread, frame: DocumentFrame, includeItemAttachments = false, historical = false,target?:AnnotationTarget): readonly DocumentCell[] {
  const matches=annotationFrameMatcher(thread,includeItemAttachments,historical,target);
  return frame.cells.filter(cell=>cell.origins.some(matches));
}
