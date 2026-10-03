import type { RequestInput } from "./client";
import { listLiveClients, requireUniqueClientId, sendClientCommand } from "./client-target";
import { blockDisplayTitle } from "./references";
import { prepareSearchQuery, scoreSearchDocument, searchMemo, type SearchMatchKind, type SearchQuery } from "./search-match";
import type { Block, WorkspaceSnapshot } from "./types";

export type BlockFocusMatchKind = SearchMatchKind;
export { rankTextSearchMatches, subsequenceScore, type SearchDocument, type TextSearchMatch } from "./search-match";

export interface BlockFocusMatch {
  block: Block;
  kind: BlockFocusMatchKind;
  score: number;
  title: string;
  /** The share of the query found in the title (src/search-match.ts). */
  inTitle: number;
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

// A note's title is derived from its text alone, so it is cached by the text.
const displayTitle = searchMemo(text => blockDisplayTitle({ id: "", text } as Block));
// `blockDisplayTitle` falls back to the id for a note without a first line.
const titleOf = (block: Block) => displayTitle(block.text) || block.id;

function scoreBlock(block: Block, query: SearchQuery): BlockFocusMatch | null {
  const match = scoreSearchDocument({ id: block.id, title: titleOf(block), text: block.text }, query);
  return match ? { block, kind: match.kind, score: match.score, title: match.title, inTitle: match.inTitle } : null;
}

function rankAllBlockFocusMatches(
  blocks: readonly Block[],
  query: string,
): BlockFocusMatch[] {
  const prepared = prepareSearchQuery(query);
  if (!prepared) return [];
  return blocks
    .map((block) => scoreBlock(block, prepared))
    .filter((match): match is BlockFocusMatch => match !== null)
    .sort((left, right) =>
      right.score - left.score ||
      left.title.localeCompare(right.title) ||
      left.block.id.localeCompare(right.block.id)
    );
}

export function rankBlockFocusMatches(
  blocks: readonly Block[],
  query: string,
  limit = 20,
): BlockFocusMatch[] {
  if (!Number.isInteger(limit) || limit <= 0) throw new Error("Focus match limit must be positive");
  return rankAllBlockFocusMatches(blocks, query).slice(0, limit);
}

export function resolveBlockFocus(
  blocks: readonly Block[],
  query: string,
  limit = 20,
): BlockFocusResolution {
  if (!Number.isInteger(limit) || limit <= 0) throw new Error("Focus match limit must be positive");
  const allMatches = rankAllBlockFocusMatches(blocks, query);
  if (allMatches.length === 0) return { kind: "none", matches: [] };
  const [first, second] = allMatches;
  const matches = allMatches.slice(0, limit);
  const isDirectMatch =
    first.kind === "exact-id" ||
    (first.kind === "exact-title" && second?.kind !== "exact-title") ||
    allMatches.length === 1 ||
    (first.kind === "id-prefix" && second?.kind !== "id-prefix") ||
    (second !== undefined && first.score - second.score >= 10_000);
  return isDirectMatch
    ? { kind: "match", match: first, matches }
    : { kind: "ambiguous", matches };
}

export function shortBlockId(blockId: string): string {
  return blockId.slice(0, 8);
}

export function uniqueBlockFocusIdentifier(
  blockId: string,
  matches: readonly { block: Pick<Block, "id"> }[],
  minimumLength = 8,
): string {
  const startLength = Math.max(1, Math.min(minimumLength, blockId.length));
  for (let length = startLength; length < blockId.length; length += 1) {
    const prefix = blockId.slice(0, length);
    if (matches.filter((match) => match.block.id.startsWith(prefix)).length === 1) {
      return prefix;
    }
  }
  return blockId;
}

export function formatBlockFocusMatch(
  match: { block: Pick<Block, "id">; title: string },
  identifier = shortBlockId(match.block.id),
): string {
  return `${identifier} · ${match.title}`;
}

export async function focusBlockByQuery(
  requester: BlockFocusRequester,
  query: string,
  limit = 20,
  targetClientId?: string,
): Promise<BlockFocusResult> {
  const snapshot = await requester.request<WorkspaceSnapshot>({ action: "workspace.snapshot" });
  const resolution = resolveBlockFocus(snapshot.physical.blocks, query, limit);
  if (resolution.kind !== "match") return { resolution, focused: false };

  const blockId = resolution.match.block.id;
  let clientId: string;
  if (targetClientId) {
    const trees = await listLiveClients(requester, "tree");
    if (!trees.some((client) => client.clientId === targetClientId)) {
      throw new Error(`Target client is not a registered tree client: ${targetClientId}`);
    }
    clientId = targetClientId;
  } else {
    clientId = await requireUniqueClientId(requester, "tree");
  }
  await requester.request({ action: "selection.set", blockId });
  await sendClientCommand(requester, clientId, {
    command: "focus", targetRegion: "tree",
    target: { kind: "block", blockId },
  });
  return { resolution, focused: true };
}
