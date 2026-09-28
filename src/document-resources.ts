import type {ResourceDescription} from './resources';
import {atomicDocument,observeDocument,sourceDocument,type MappedDocument,type ObservedDocument} from './document-provenance';

/** Observe the selected provider text, never the surrounding capability report.
 * Non-Markdown selections have no Markdown coordinate claim. */
export function resourceDocumentObservation(description:ResourceDescription):ObservedDocument|null {
  const representation=description.presentation?.selected?.representation;
  if(representation!==undefined&&representation!=='cached-markdown')return null;
  const {resource,filesystem,pdf,web,remoteEntity,computed}=description;
  const observe=(text:string,evidence:NonNullable<ObservedDocument['resource']>)=>({
    ...observeDocument({kind:'resource',resourceId:resource.id},text),resource:evidence,
  });
  if(filesystem)return observe(filesystem.text,{
    revision:filesystem.revision,adapter:{id:'filesystem.text',version:1},capturedAt:filesystem.capturedAt,
  });
  if(computed) {
    const result=observe(computed.markdown,{revision:computed.revision,adapter:computed.adapter,
      representationId:computed.representationId,capturedAt:computed.derivedAt});
    return result;
  }
  const document=pdf??web;
  if(document)return observe(document.markdown,{
    revision:document.sourceSnapshot.revision,adapter:document.representation.adapter,
    representationId:document.representation.id,sourceSnapshotId:document.sourceSnapshot.id,
    capturedAt:document.representation.derivedAt??resource.updatedAt,
  });
  if(remoteEntity)return observe(remoteEntity.markdown,{
    revision:remoteEntity.sourceSnapshot.revision,adapter:remoteEntity.representation.adapter,
    capturedAt:remoteEntity.representation.derivedAt,
  });
  return null;
}

export function resourceContentDocument(description:ResourceDescription):MappedDocument|null {
  const observation=resourceDocumentObservation(description);
  if(!observation)return null;
  return description.computed
    ? atomicDocument(observation.text,{kind:'derived',resultId:description.computed.representationId,result:observation,
      dependencies:[],resourceDependencies:description.computed.dependencies})
    : sourceDocument(observation);
}
