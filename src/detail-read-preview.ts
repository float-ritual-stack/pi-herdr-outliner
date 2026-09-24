import type { OutlinerRequester } from "./client-target";
import { projectDetailRead } from "./detail-embeds";
import type { DetailReadPreviewDocument } from "./detail-pi-preview";
import type { Block, ResolvedBlockReferences } from "./types";

export async function loadDetailReadPreview(
  client: OutlinerRequester,
  block: Block,
  maxCharacters = Infinity,
): Promise<DetailReadPreviewDocument> {
  let truncated = false;
  const clip = (text: string) => {
    if (text.length <= maxCharacters) return text;
    truncated = true;
    const boundary = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text).containing(maxCharacters);
    return text.slice(0, boundary?.index ?? maxCharacters);
  };
  const canonicalText = clip(block.text);
  const projection = await projectDetailRead(client, canonicalText, { hostBlockId: block.id });
  const projectedText = clip(projection.text);
  const resolved = await client.request<ResolvedBlockReferences>({ action: "references.resolve", text: projectedText });
  const resolvedText = clip(resolved.text);
  return { sourceBlock:{id:block.id,revision:block.revision,text:canonicalText}, canonicalText, resolvedText, projectedText, truncated,
    embedRanges: projection.embedRanges, workIdPrefix: resolved.workIdPrefix ?? null };
}
