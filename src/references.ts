import { firstLineWithoutPropertyTokens } from "./properties";
import type {
  Block,
  BlockReferenceResolution,
  ResolvedBlockReferences,
} from "./types";

const BLOCK_REFERENCE_PATTERN = /\(\(([A-Za-z0-9_-]{8,})\)\)/g;

export function blockDisplayTitle(block: Block): string {
  const firstContentLine = firstLineWithoutPropertyTokens(block.text);
  return firstContentLine?.replace(/\s{2,}/g, " ").trim() || block.id;
}

export function blockReferenceIds(text: string): string[] {
  return [...text.matchAll(BLOCK_REFERENCE_PATTERN)].map((match) => match[1]);
}

export function resolveBlockReferencesWithStatus(
  text: string,
  lookup: (blockId: string) => Block | null,
): ResolvedBlockReferences {
  const references: BlockReferenceResolution[] = [];
  const resolved = text.replace(BLOCK_REFERENCE_PATTERN, (reference, blockId: string) => {
    const block = lookup(blockId);
    if (!block) {
      references.push({ blockId, status: "missing" });
      return reference;
    }
    const title = blockDisplayTitle(block);
    if (block.effectiveDeletedRootId) {
      references.push({
        blockId,
        status: "deleted",
        title,
        deletionRootId: block.effectiveDeletedRootId,
      });
      return `((${title} · Trash))`;
    }
    references.push({ blockId, status: "resolved", title });
    return `((${title}))`;
  });
  return { text: resolved, references };
}

export function resolveBlockReferences(
  text: string,
  lookup: (blockId: string) => Block | null,
): string {
  return resolveBlockReferencesWithStatus(text, lookup).text;
}
