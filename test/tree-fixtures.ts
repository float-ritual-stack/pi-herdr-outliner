import { authoredTextDigest } from "../src/authored-links";
import { firstLineWithoutPropertyTokens } from "../src/properties";
import { resolveBlockReferencesWithStatus } from "../src/references";
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
  return {
    ...metadata,
    preview: title.length > 512 ? `${title.slice(0, 511)}…` : title,
    previewReferences: resolveBlockReferencesWithStatus(text, lookup).references,
    textDigest: authoredTextDigest(text),
  };
}
