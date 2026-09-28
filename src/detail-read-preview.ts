import type { OutlinerRequester } from "./client-target";
import { projectDetailRead } from "./detail-embeds";
import type { DetailReadPreviewDocument, DetailDraftProjection } from "./detail-pi-preview";
import type { Block, ResolvedBlockReferences } from "./types";
import {observeDocument, sliceDocument, type ObservedDocument} from './document-provenance';
import {presentedSource} from './document-source';
import {resolvedDocument} from './document-references';
import {fragmentPresentationText, type FragmentSlice} from './fragments';

export async function loadDetailDraftPreview(client:OutlinerRequester,document:ObservedDocument):Promise<DetailDraftProjection> {
  const source=presentedSource(document);
  const projection=await projectDetailRead(client,source.text,{
    source,hostBlockId:document.subject.kind==='block'?document.subject.blockId:undefined,
  });
  const resolved=await client.request<ResolvedBlockReferences>({action:'references.resolve',text:projection.text});
  return {provenance:resolvedDocument(projection.provenance,resolved),rawText:projection.text,
    embedRanges:projection.embedRanges,workIdPrefix:resolved.workIdPrefix??null};
}

export async function loadDetailReadPreview(
  client: OutlinerRequester,
  block: Block,
  maxCharacters = Infinity,
  fragment?: FragmentSlice,
): Promise<DetailReadPreviewDocument> {
  let truncated = false;
  const clip = (text: string) => {
    if (text.length <= maxCharacters) return text;
    truncated = true;
    const boundary = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text).containing(maxCharacters);
    return text.slice(0, boundary?.index ?? maxCharacters);
  };
  const canonicalText = clip(fragment ? fragmentPresentationText(fragment) : block.text);
  const observed = observeDocument({kind:'block',blockId:block.id}, block.text, block.revision);
  const source = fragment
    ? presentedSource(observed, fragment.startLine, fragment.endLine, fragment.anchor.kind === 'list-item')
    : presentedSource(observed, 0, Infinity, false, canonicalText.length);
  const boundedSource = sliceDocument(source, 0, clip(source.text).length);
  const projection = await projectDetailRead(client, boundedSource.text, { hostBlockId: block.id, source: boundedSource });
  const projectedText = clip(projection.text);
  const resolved = await client.request<ResolvedBlockReferences>({ action: "references.resolve", text: projectedText });
  const resolvedText = clip(resolved.text);
  const provenance = sliceDocument(resolvedDocument(sliceDocument(projection.provenance, 0, projectedText.length), resolved), 0, resolvedText.length);
  return { ...(fragment ? {sourceSlice:{block,startLine:fragment.startLine,endLine:fragment.endLine}}
      : {sourceBlock:{id:block.id,revision:block.revision,text:block.text}}), canonicalText, resolvedText, projectedText, provenance, truncated,
    embedRanges: projection.embedRanges, workIdPrefix: resolved.workIdPrefix ?? null };
}
