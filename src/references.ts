import { firstLineWithoutPropertyTokens } from "./properties";
import { resolveFragment, stripFragmentAnchors } from "./fragments";
import type {
  Block,
  BlockReferenceResolution,
  ResolvedBlockReferences,
} from "./types";

const BLOCK_REFERENCE_PATTERN =
  /\(\(([A-Za-z0-9_-]{8,})(?:\^([A-Za-z0-9][A-Za-z0-9_-]{0,63}))?(?:\|((?:(?!\)\))[^\r\n])+))?\)\)/g;
const TITLED_BLOCK_REFERENCE_ENVELOPE_PATTERN =
  /\(\([A-Za-z0-9_-]{8,}(?:\^[A-Za-z0-9][A-Za-z0-9_-]{0,63})?\|[\s\S]*?\)\)/g;

export interface BlockReferenceOccurrence {
  blockId: string;
  fragmentId?: string;
  label?: string;
  start: number;
  end: number;
}

export function blockDisplayTitle(block: Block): string {
  const firstContentLine = firstLineWithoutPropertyTokens(stripFragmentAnchors(block.text));
  return firstContentLine?.replace(/\s{2,}/g, " ").trim() || block.id;
}

export function titledBlockReferenceEnvelopeRanges(text: string): Array<{ start: number; end: number }> {
  return [...text.matchAll(TITLED_BLOCK_REFERENCE_ENVELOPE_PATTERN)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
}

export function blockReferenceOccurrences(text: string): BlockReferenceOccurrence[] {
  return [...text.matchAll(BLOCK_REFERENCE_PATTERN)].flatMap((match) => {
    const label = match[3];
    if (label !== undefined && !label.trim()) return [];
    return [{
      blockId: match[1]!,
      ...(match[2] ? { fragmentId: match[2] } : {}),
      ...(label !== undefined ? { label } : {}),
      start: match.index,
      end: match.index + match[0].length,
    }];
  });
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
    (reference, blockId: string, fragmentId: string | undefined, label: string | undefined) => {
      if (label !== undefined && !label.trim()) return reference;
      const block = lookup(blockId);
      if (!block) {
        references.push({
          blockId,
          ...(fragmentId ? { fragmentId } : {}),
          status: "missing",
          ...(label !== undefined ? { label } : {}),
        });
        return reference;
      }
      const title = blockDisplayTitle(block);
      const visible = label ?? title;
      if (block.effectiveDeletedRootId) {
        references.push({
          blockId,
          ...(fragmentId ? { fragmentId } : {}),
          status: "deleted",
          ...(label !== undefined ? { label } : {}),
          title,
          deletionRootId: block.effectiveDeletedRootId,
        });
        return `((${visible}${label === undefined && fragmentId ? `^${fragmentId}` : ""} · Trash))`;
      }
      if (fragmentId) {
        const fragment = resolveFragment(block.text, fragmentId);
        if (fragment.status !== "resolved") {
          const status = fragment.status === "missing" ? "stale" : "duplicate";
          references.push({
            blockId,
            fragmentId,
            ...(label !== undefined ? { label } : {}),
            status,
            title,
          });
          const suffix = status === "stale" ? "Missing fragment" : "Duplicate fragment";
          return `((${visible}${label === undefined ? `^${fragmentId}` : ""} · ${suffix}))`;
        }
      }
      references.push({
        blockId,
        ...(fragmentId ? { fragmentId } : {}),
        ...(label !== undefined ? { label } : {}),
        status: "resolved",
        title,
      });
      return `((${visible}${label === undefined && fragmentId ? `^${fragmentId}` : ""}))`;
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
