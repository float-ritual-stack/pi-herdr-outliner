import { normalizePageAddress } from "./page-addresses";
import {
  outlinerReferenceOccurrences,
  propertyReferenceOccurrences,
  type OutlinerReferenceOccurrence,
  type PropertyReferenceOccurrence,
} from "./reference-occurrences";
import { blockDisplayTitle } from "./references";
import type {
  BacklinkCollection,
  BacklinkOccurrence,
  BacklinkQuery,
  BacklinkReferenceGroup,
  BacklinkSource,
  Block,
} from "./types";

const OCCURRENCE_PREVIEW_LIMIT = 3;
const SNIPPET_LIMIT = 180;

type BacklinkRelationOccurrence = OutlinerReferenceOccurrence | PropertyReferenceOccurrence;

export interface BacklinkRelationInput {
  query: BacklinkQuery;
  target: Block;
  orderedBlocks: readonly Block[];
  blocksById: ReadonlyMap<string, Block>;
  addressTargets: ReadonlyMap<string, string>;
  workIdPrefix: string | null;
}

export function normalizeBacklinkQuery(query: BacklinkQuery): BacklinkQuery {
  if (!query.targetBlockId.trim()) throw new Error("Backlink target block ID cannot be empty");
  if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 1000) {
    throw new Error("Backlink limit must be an integer from 1 through 1000");
  }
  return {
    targetBlockId: query.targetBlockId.trim(),
    ...(query.includeDeleted ? { includeDeleted: true } : {}),
    limit: query.limit,
  };
}

function occurrenceTarget(
  occurrence: BacklinkRelationOccurrence,
  addressTargets: ReadonlyMap<string, string>,
): string | undefined {
  if (occurrence.kind === "block" || occurrence.kind === "property") {
    return occurrence.blockId;
  }
  const normalizedAddress = occurrence.kind === "page"
    ? occurrence.normalizedAddress
    : normalizePageAddress(occurrence.address).normalizedAddress;
  return addressTargets.get(normalizedAddress);
}

function occurrenceSnippet(text: string, start: number, end: number): string {
  const lineStart = text.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const nextNewline = text.indexOf("\n", end);
  const lineEnd = nextNewline < 0 ? text.length : nextNewline;
  const line = text.slice(lineStart, lineEnd).replace(/\s+/g, " ").trim();
  if (line.length <= SNIPPET_LIMIT) return line;

  const occurrenceStart = Math.max(0, start - lineStart);
  const windowStart = Math.max(0, Math.min(occurrenceStart - 60, line.length - SNIPPET_LIMIT));
  const windowEnd = Math.min(line.length, windowStart + SNIPPET_LIMIT);
  return `${windowStart > 0 ? "…" : ""}${line.slice(windowStart, windowEnd).trim()}${
    windowEnd < line.length ? "…" : ""
  }`;
}

function humanizedReferenceLabel(
  source: Block,
  occurrence: BacklinkRelationOccurrence,
  targetTitle: string,
): string {
  if (occurrence.kind === "block") return `((${targetTitle}))`;
  if (occurrence.kind === "property") return `[${occurrence.propertyKey}::${targetTitle}]`;
  return source.text.slice(occurrence.start, occurrence.end);
}

function backlinkOccurrence(
  source: Block,
  occurrence: BacklinkRelationOccurrence,
  sourceOccurrences: readonly BacklinkRelationOccurrence[],
  target: Block,
): BacklinkOccurrence {
  const label = source.text.slice(occurrence.start, occurrence.end);
  const targetTitle = blockDisplayTitle(target);
  let snippet = occurrenceSnippet(source.text, occurrence.start, occurrence.end);
  for (const sourceOccurrence of sourceOccurrences) {
    const rawLabel = source.text.slice(sourceOccurrence.start, sourceOccurrence.end);
    snippet = snippet.replaceAll(
      rawLabel,
      humanizedReferenceLabel(source, sourceOccurrence, targetTitle),
    );
  }
  const base = {
    label,
    snippet,
    start: occurrence.start,
    end: occurrence.end,
  };
  return occurrence.kind === "property"
    ? { kind: "property", propertyKey: occurrence.propertyKey, ...base }
    : { kind: occurrence.kind, ...base };
}

function parentContext(block: Block, blocksById: ReadonlyMap<string, Block>): string {
  const titles: string[] = [];
  let parentId = block.parentId;
  while (parentId) {
    const parent = blocksById.get(parentId);
    if (!parent) break;
    titles.unshift(blockDisplayTitle(parent));
    parentId = parent.parentId;
  }
  return titles.join(" › ") || "Top level";
}

function referenceGroups(
  occurrences: readonly BacklinkRelationOccurrence[],
): BacklinkReferenceGroup[] {
  const groups = new Map<string, BacklinkReferenceGroup>();
  for (const occurrence of occurrences) {
    const key = occurrence.kind === "property"
      ? `property:${occurrence.propertyKey}`
      : occurrence.kind;
    const group = groups.get(key);
    if (group) {
      group.count += 1;
    } else if (occurrence.kind === "property") {
      groups.set(key, {
        kind: "property",
        propertyKey: occurrence.propertyKey,
        count: 1,
      });
    } else {
      groups.set(key, { kind: occurrence.kind, count: 1 });
    }
  }
  return [...groups.values()];
}

function backlinkSource(
  source: Block,
  target: Block,
  occurrences: readonly BacklinkRelationOccurrence[],
  blocksById: ReadonlyMap<string, Block>,
): BacklinkSource {
  return {
    blockId: source.id,
    title: blockDisplayTitle(source),
    parentContext: parentContext(source, blocksById),
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    occurrenceCount: occurrences.length,
    referenceGroups: referenceGroups(occurrences),
    occurrences: occurrences
      .slice(0, OCCURRENCE_PREVIEW_LIMIT)
      .map((occurrence) => backlinkOccurrence(source, occurrence, occurrences, target)),
    occurrencesTruncated: occurrences.length > OCCURRENCE_PREVIEW_LIMIT,
    ...(source.effectiveDeletedRootId
      ? { deletedRootId: source.effectiveDeletedRootId }
      : {}),
  };
}

export function resolveBacklinkRelation(input: BacklinkRelationInput): BacklinkCollection {
  const query = normalizeBacklinkQuery(input.query);
  if (input.target.id !== query.targetBlockId) {
    throw new Error(`Backlink target mismatch: ${query.targetBlockId}`);
  }

  const matches: BacklinkSource[] = [];
  for (const source of input.orderedBlocks) {
    if (source.effectiveDeletedRootId && !query.includeDeleted) continue;
    const occurrences = [
      ...outlinerReferenceOccurrences(source.text, input.workIdPrefix),
      ...propertyReferenceOccurrences(source.text),
    ]
      .sort((left, right) => left.start - right.start)
      .filter(
        (occurrence) => occurrenceTarget(occurrence, input.addressTargets) === input.target.id,
      );
    if (occurrences.length === 0) continue;
    matches.push(backlinkSource(source, input.target, occurrences, input.blocksById));
    if (matches.length > query.limit) break;
  }

  const truncated = matches.length > query.limit;
  return {
    targetBlockId: input.target.id,
    ...(input.target.effectiveDeletedRootId
      ? { targetDeletedRootId: input.target.effectiveDeletedRootId }
      : {}),
    sources: truncated ? matches.slice(0, query.limit) : matches,
    completeness: truncated
      ? { kind: "truncated", limit: query.limit }
      : { kind: "complete" },
  };
}
