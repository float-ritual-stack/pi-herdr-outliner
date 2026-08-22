import { stripProperties } from "./properties";
import type { Block } from "./types";

const BLOCK_REFERENCE_PATTERN = /\(\(([A-Za-z0-9_-]{8,})\)\)/g;

export function blockDisplayTitle(block: Block): string {
  for (const line of block.text.split(/\r?\n/)) {
    const title = stripProperties(line);
    if (title) return title;
  }
  return block.id;
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
