import { firstLineWithoutPropertyTokens } from "./properties";
import { referenceEnvelopeEnd } from "./reference-envelopes";
export { blockReferenceEnvelopeRanges, referenceEnvelopeEnd, type BlockReferenceEnvelope } from "./reference-envelopes";
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

const BLOCK_REFERENCE_HEAD_PATTERN =
  /\(\(([A-Za-z0-9_-]{8,})(?:\^([A-Za-z0-9][A-Za-z0-9_-]{0,63}))?(?=\)\)|\|)/g;

function blockReferenceMatches(text: string): BlockReferenceOccurrence[] {
  const matches: BlockReferenceOccurrence[] = [];
  const pattern = new RegExp(BLOCK_REFERENCE_HEAD_PATTERN.source, "g");
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const head = match.index + match[0].length;
    let end = head + 2;
    let label: string | undefined;
    if (text[head] === "|") {
      // A label is one line and needs at least one character.
      end = referenceEnvelopeEnd(text, head + 1, true, head + 2);
      if (end < 0) {
        pattern.lastIndex = match.index + 1;
        continue;
      }
      label = text.slice(head + 1, end - 2);
    }
    matches.push({
      blockId: match[1]!,
      ...(match[2] ? { fragmentId: match[2] } : {}),
      ...(label !== undefined ? { label } : {}),
      start: match.index,
      end,
    });
    pattern.lastIndex = end;
  }
  return matches;
}

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

export function blockReferenceOccurrences(text: string): BlockReferenceOccurrence[] {
  return blockReferenceMatches(text).filter((match) => match.label === undefined || match.label.trim());
}

export function blockReferenceIds(text: string): string[] {
  return blockReferenceOccurrences(text).map((reference) => reference.blockId);
}

export function resolveBlockReferencesWithStatus(
  text: string,
  lookup: (blockId: string) => Block | null,
): ResolvedBlockReferences {
  const references: BlockReferenceResolution[] = [];
  let resolved = "";
  let cursor = 0;
  for (const { blockId, fragmentId, label, start, end } of blockReferenceOccurrences(text)) {
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
    resolved += text.slice(cursor, start) + blockReferenceDisplayText(resolution);
    cursor = end;
  }
  return { text: resolved + text.slice(cursor), references };
}

export function resolveBlockReferences(
  text: string,
  lookup: (blockId: string) => Block | null,
): string {
  return resolveBlockReferencesWithStatus(text, lookup).text;
}
