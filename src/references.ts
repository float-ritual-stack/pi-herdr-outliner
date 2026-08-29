import { firstLineWithoutPropertyTokens } from "./properties";
import { resolveFragment, stripFragmentAnchors } from "./fragments";
import type {
  Block,
  BlockReferenceResolution,
  ResolvedBlockReferences,
} from "./types";

const BLOCK_REFERENCE_PATTERN =
  /\(\(([A-Za-z0-9_-]{8,})(?:\^([A-Za-z0-9][A-Za-z0-9_-]{0,63}))?\)\)/g;

export interface BlockReferenceOccurrence {
  blockId: string;
  fragmentId?: string;
  start: number;
  end: number;
}

export function blockDisplayTitle(block: Block): string {
  const firstContentLine = firstLineWithoutPropertyTokens(stripFragmentAnchors(block.text));
  return firstContentLine?.replace(/\s{2,}/g, " ").trim() || block.id;
}

export function blockReferenceOccurrences(text: string): BlockReferenceOccurrence[] {
  return [...text.matchAll(BLOCK_REFERENCE_PATTERN)].map((match) => ({
    blockId: match[1]!,
    ...(match[2] ? { fragmentId: match[2] } : {}),
    start: match.index,
    end: match.index + match[0].length,
  }));
}

export function blockReferenceIds(text: string): string[] {
  return blockReferenceOccurrences(text).map((reference) => reference.blockId);
}

export function resolveBlockReferencesWithStatus(
  text: string,
  lookup: (blockId: string) => Block | null,
): ResolvedBlockReferences {
  const references: BlockReferenceResolution[] = [];
  const resolved = text.replace(
    BLOCK_REFERENCE_PATTERN,
    (reference, blockId: string, fragmentId: string | undefined) => {
      const block = lookup(blockId);
      if (!block) {
        references.push({
          blockId,
          ...(fragmentId ? { fragmentId } : {}),
          status: "missing",
        });
        return reference;
      }
      const title = blockDisplayTitle(block);
      if (block.effectiveDeletedRootId) {
        references.push({
          blockId,
          ...(fragmentId ? { fragmentId } : {}),
          status: "deleted",
          title,
          deletionRootId: block.effectiveDeletedRootId,
        });
        return `((${title}${fragmentId ? `^${fragmentId}` : ""} · Trash))`;
      }
      if (fragmentId) {
        const fragment = resolveFragment(block.text, fragmentId);
        if (fragment.status !== "resolved") {
          const status = fragment.status === "missing" ? "stale" : "duplicate";
          references.push({ blockId, fragmentId, status, title });
          const suffix = status === "stale" ? "Missing fragment" : "Duplicate fragment";
          return `((${title}^${fragmentId} · ${suffix}))`;
        }
      }
      references.push({
        blockId,
        ...(fragmentId ? { fragmentId } : {}),
        status: "resolved",
        title,
      });
      return `((${title}${fragmentId ? `^${fragmentId}` : ""}))`;
    },
  );
  return { text: resolved, references };
}

export function resolveBlockReferences(
  text: string,
  lookup: (blockId: string) => Block | null,
): string {
  return resolveBlockReferencesWithStatus(text, lookup).text;
}
