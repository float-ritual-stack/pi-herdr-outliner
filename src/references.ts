import { firstLineWithoutPropertyTokens } from "./properties";
import type { Block } from "./types";

const BLOCK_REFERENCE_PATTERN = /\(\(([A-Za-z0-9_-]{8,})\)\)/g;

export function blockDisplayTitle(block: Block): string {
  const firstContentLine = firstLineWithoutPropertyTokens(block.text);
  return firstContentLine?.replace(/\s{2,}/g, " ").trim() || block.id;
}

export function blockReferenceIds(text: string): string[] {
  return [...text.matchAll(BLOCK_REFERENCE_PATTERN)].map((match) => match[1]);
}

export function resolveBlockReferences(
  text: string,
  lookup: (blockId: string) => Block | null,
): string {
  return text.replace(BLOCK_REFERENCE_PATTERN, (reference, blockId: string) => {
    const block = lookup(blockId);
    return block ? `((${blockDisplayTitle(block)}))` : reference;
  });
}
