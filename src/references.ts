import { firstLineWithoutPropertyTokens } from "./properties";
import { resolveFragment, stripFragmentAnchors } from "./fragments";
import type {
  Block,
  BlockReferenceResolution,
  ResolvedBlockReferences,
} from "./types";

export function blockReferenceDisplayText(reference: BlockReferenceResolution): string {
  const fragment = reference.fragmentId ? `^${reference.fragmentId}` : "";
  if (reference.status === "missing") {
    return `((${reference.blockId}${fragment}${reference.label !== undefined ? `|${reference.label}` : ""}))`;
  }
  const title = reference.label ?? reference.title ?? reference.blockId;
  const label = `${title}${reference.label === undefined ? fragment : ""}`;
  const suffix = reference.status === "deleted" ? " · Trash"
    : reference.status === "stale" ? " · Missing fragment"
    : reference.status === "duplicate" ? " · Duplicate fragment" : "";
  return `((${label}${suffix}))`;
}

const BLOCK_REFERENCE_PATTERN =
  /\(\(([A-Za-z0-9_-]{8,})(?:\^([A-Za-z0-9][A-Za-z0-9_-]{0,63}))?(?:\|((?:(?!\)\))[^\r\n])+))?\)\)/g;
const BLOCK_REFERENCE_ENVELOPE_PATTERN = /\(\((?:(?!\)\))[\s\S])*\)\)/g;

export interface BlockReferenceOccurrence {
  blockId: string;
  fragmentId?: string;
  label?: string;
  start: number;
  end: number;
}

export interface BlockReferenceEnvelope {
  start: number;
  end: number;
}

export function blockReferenceEnvelopeRanges(text: string): BlockReferenceEnvelope[] {
  return Array.from(
    text.matchAll(BLOCK_REFERENCE_ENVELOPE_PATTERN),
    (match) => ({ start: match.index, end: match.index + match[0].length }),
  );
}

export function blockDisplayTitle(block: Block): string {
  const firstContentLine = firstLineWithoutPropertyTokens(stripFragmentAnchors(block.text));
  return firstContentLine?.replace(/\s{2,}/g, " ").trim() || block.id;
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
      let status: BlockReferenceResolution["status"] = block ? "resolved" : "missing";
      if (block?.effectiveDeletedRootId) status = "deleted";
      else if (block && fragmentId) {
        const fragment = resolveFragment(block.text, fragmentId);
        if (fragment.status !== "resolved") status = fragment.status === "missing" ? "stale" : "duplicate";
      }
      const resolution: BlockReferenceResolution = {
        blockId,
        ...(fragmentId ? { fragmentId } : {}),
        ...(label !== undefined ? { label } : {}),
        status,
        ...(block ? { title: blockDisplayTitle(block) } : {}),
        ...(block?.effectiveDeletedRootId ? { deletionRootId: block.effectiveDeletedRootId } : {}),
      };
      references.push(resolution);
      return blockReferenceDisplayText(resolution);
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
