import type { RequestInput } from "./client";
import { blockDisplayTitle } from "./references";
import type { Block, WorkspaceSnapshot } from "./types";

export type BlockFocusMatchKind =
  | "exact-id"
  | "id-prefix"
  | "exact-title"
  | "title-prefix"
  | "title-contains"
  | "text-contains"
  | "title-terms"
  | "text-terms"
  | "title-fuzzy"
  | "text-fuzzy";

export interface BlockFocusMatch {
  block: Block;
  kind: BlockFocusMatchKind;
  score: number;
  title: string;
}

export type BlockFocusResolution =
  | { kind: "match"; match: BlockFocusMatch; matches: BlockFocusMatch[] }
  | { kind: "ambiguous"; matches: BlockFocusMatch[] }
  | { kind: "none"; matches: [] };

export interface BlockFocusRequester {
  request<T>(input: RequestInput): Promise<T>;
}

export interface BlockFocusResult {
  resolution: BlockFocusResolution;
  focused: boolean;
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function subsequenceScore(query: string, candidate: string): number {
  if (!query || query.length > candidate.length) return 0;
  let queryIndex = 0;
  let previousMatch = -1;
  let gaps = 0;
  for (let index = 0; index < candidate.length && queryIndex < query.length; index += 1) {
    if (candidate[index] !== query[queryIndex]) continue;
    if (previousMatch >= 0) gaps += index - previousMatch - 1;
    previousMatch = index;
    queryIndex += 1;
  }
  if (queryIndex !== query.length) return 0;
  return Math.max(1, 1_000 - gaps - Math.max(0, candidate.length - query.length));
}

function scoreBlock(
  block: Block,
  normalizedQuery: string,
  terms: readonly string[],
): BlockFocusMatch | null {
  const id = block.id.toLowerCase();
  const title = blockDisplayTitle(block);
  const normalizedTitle = normalize(title);

  if (id === normalizedQuery) return { block, kind: "exact-id", score: 100_000, title };
  if (normalizedQuery.length >= 4 && id.startsWith(normalizedQuery)) {
    return { block, kind: "id-prefix", score: 90_000 + normalizedQuery.length, title };
  }
  if (normalizedTitle === normalizedQuery) {
    return { block, kind: "exact-title", score: 80_000, title };
  }
  if (normalizedTitle.startsWith(normalizedQuery)) {
    return { block, kind: "title-prefix", score: 70_000, title };
  }
  if (normalizedTitle.includes(normalizedQuery)) {
    return { block, kind: "title-contains", score: 60_000, title };
  }
  const normalizedText = normalize(block.text);
  if (normalizedText.includes(normalizedQuery)) {
    return { block, kind: "text-contains", score: 50_000, title };
  }
  if (terms.every((term) => normalizedTitle.includes(term))) {
    return { block, kind: "title-terms", score: 40_000 + terms.length, title };
  }
  if (terms.every((term) => normalizedText.includes(term))) {
    return { block, kind: "text-terms", score: 30_000 + terms.length, title };
  }
  if (normalizedQuery.length >= 3) {
    const titleScore = subsequenceScore(normalizedQuery, normalizedTitle);
    if (titleScore > 0) {
      return { block, kind: "title-fuzzy", score: 10_000 + titleScore, title };
    }
    const textScore = subsequenceScore(normalizedQuery, normalizedText);
    if (textScore > 0) {
      return { block, kind: "text-fuzzy", score: 5_000 + textScore, title };
    }
  }
  return null;
}

export function rankBlockFocusMatches(
  blocks: readonly Block[],
  query: string,
  limit = 20,
): BlockFocusMatch[] {
  if (!Number.isInteger(limit) || limit <= 0) throw new Error("Focus match limit must be positive");
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return [];
  const terms = normalizedQuery.split(" ").filter(Boolean);
  return blocks
    .map((block) => scoreBlock(block, normalizedQuery, terms))
    .filter((match): match is BlockFocusMatch => match !== null)
    .sort((left, right) =>
      right.score - left.score || left.title.localeCompare(right.title) || left.block.id.localeCompare(right.block.id)
    )
    .slice(0, limit);
}

export function resolveBlockFocus(
  blocks: readonly Block[],
  query: string,
  limit = 20,
): BlockFocusResolution {
  const matches = rankBlockFocusMatches(blocks, query, limit);
  if (matches.length === 0) return { kind: "none", matches: [] };
  const [first, second] = matches;
  const isDirectMatch =
    first.kind === "exact-id" ||
    first.kind === "exact-title" ||
    matches.length === 1 ||
    (first.kind === "id-prefix" && second?.kind !== "id-prefix") ||
    (second !== undefined && first.score - second.score >= 10_000);
  return isDirectMatch
    ? { kind: "match", match: first, matches }
    : { kind: "ambiguous", matches };
}

export function shortBlockId(blockId: string): string {
  return blockId.slice(0, 8);
}

export function formatBlockFocusMatch(match: BlockFocusMatch): string {
  return `${shortBlockId(match.block.id)} · ${match.title}`;
}

export async function focusBlockByQuery(
  requester: BlockFocusRequester,
  query: string,
  limit = 20,
): Promise<BlockFocusResult> {
  const snapshot = await requester.request<WorkspaceSnapshot>({ action: "workspace.snapshot" });
  const resolution = resolveBlockFocus(snapshot.physical.blocks, query, limit);
  if (resolution.kind !== "match") return { resolution, focused: false };

  const blockId = resolution.match.block.id;
  await requester.request({ action: "selection.set", blockId });
  await requester.request({
    action: "ui.command.send",
    command: { target: "tree", command: "focus", blockId },
  });
  return { resolution, focused: true };
}
