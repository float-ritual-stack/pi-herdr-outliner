import { authoredTextDigest } from "../src/authored-links";
import { firstLineWithoutPropertyTokens } from "../src/properties";
import { blockReferenceDisplayText, blockReferenceOccurrences, resolveBlockReferencesWithStatus } from "../src/references";
import type { Block, TreeIndexBlock, VisibleBlock } from "../src/types";

// Controller/renderer fixtures retain source documents outside their compact
// wire/view objects. Exact text is available only through their read effects.
export function treeIndexFixture(
  { text, displayText, propertyMatches: _matches, ...metadata }: VisibleBlock,
  lookup: (id: string) => Block | null,
): TreeIndexBlock {
  const title = metadata.properties.length
    ? firstLineWithoutPropertyTokens(displayText)?.trim() || metadata.id
    : displayText.replace(/\r?\n/g, " ↵ ");
  const source = metadata.properties.length
    ? firstLineWithoutPropertyTokens(text)?.trim() || metadata.id
    : text.replace(/\r?\n/g, " ↵ ");
  const occurrences = blockReferenceOccurrences(source);
  let offset = 0;
  const references = resolveBlockReferencesWithStatus(source, lookup).references.map((reference, index) => {
    const occurrence = occurrences[index]!;
    const start = occurrence.start + offset;
    const end = start + blockReferenceDisplayText(reference).length;
    offset += end - start - (occurrence.end - occurrence.start);
    return { ...reference, start, end };
  });
  return {
    ...metadata,
    preview: title.length > 512 ? `${title.slice(0, 511)}…` : title,
    previewReferences: references,
    textDigest: authoredTextDigest(text),
  };
}
