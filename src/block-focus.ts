import type { RequestInput } from "./client";
import { listLiveClients, requireUniqueClientId, sendClientCommand } from "./client-target";
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
// Search prose often contains words absent from the remembered note's title.
const QUERY_FILLER = new Set("a an the that this those these it its of on in at to for with and or about where when how i we my our was is are were be been thing things note page block please find show me what did does do would could should can have has had will then again something some any using get got".split(" "));

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

export function subsequenceScore(query: string, candidate: string): number {
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
  if (queryIndex !== query.length || gaps > query.length * 2) return 0;
  return Math.max(1, 1_000 - gaps - Math.max(0, candidate.length - query.length));
}

export interface SearchDocument { id: string; title: string; text: string }
export interface TextSearchMatch<T> {document:T;kind:BlockFocusMatchKind;score:number;title:string}
export function rankTextSearchMatches<T extends SearchDocument>(documents:readonly T[],query:string,limit:number):TextSearchMatch<T>[] {
  if (!Number.isInteger(limit) || limit <= 0) throw new Error("Search limit must be positive");
  const normalized=normalize(query);if(!normalized)return [];
  const terms=normalized.split(" ").filter(Boolean);
  return documents.map(document=>scoreSearchDocument(document,normalized,terms)).filter((match):match is TextSearchMatch<T>=>match!==null)
    .sort((a,b)=>b.score-a.score||a.title.localeCompare(b.title)||a.document.id.localeCompare(b.document.id)).slice(0,limit);
}

function scoreSearchDocument<T extends SearchDocument>(
  document: T,
  normalizedQuery: string,
  terms: readonly string[],
): TextSearchMatch<T> | null {
  const id = document.id.toLowerCase();
  const title = document.title;
  const normalizedTitle = normalize(title);

  if (id === normalizedQuery) return { document, kind: "exact-id", score: 100_000, title };
  if (normalizedQuery.length >= 4 && id.startsWith(normalizedQuery)) {
    return { document, kind: "id-prefix", score: 90_000 + normalizedQuery.length, title };
  }
  if (normalizedTitle === normalizedQuery) {
    return { document, kind: "exact-title", score: 80_000, title };
  }
  if (normalizedTitle.startsWith(normalizedQuery)) {
    return { document, kind: "title-prefix", score: 70_000, title };
  }
  if (normalizedTitle.includes(normalizedQuery)) {
    return { document, kind: "title-contains", score: 60_000, title };
  }
  const normalizedText = normalize(document.text);
  if (normalizedText.includes(normalizedQuery)) {
    return { document, kind: "text-contains", score: 50_000, title };
  }
  const usefulTerms = terms.filter(term => term.length >= 2 && !QUERY_FILLER.has(term));
  const searchTerms = usefulTerms.length ? usefulTerms : terms;
  const titleHits = searchTerms.filter(term => normalizedTitle.includes(term)).length;
  const textHits = searchTerms.filter(term => normalizedText.includes(term)).length;
  if (titleHits === searchTerms.length) return { document, kind: "title-terms", score: 40_000 + searchTerms.length, title };
  if (textHits > 0) {
    // Word evidence outranks accidental letter subsequences in long documents.
    // Titles carry more weight; document length breaks otherwise equal matches.
    const score = 12_000 + (titleHits * 10_000 + textHits * 8_000) / searchTerms.length + 1_000 / (1 + normalizedText.length / 1_000);
    return { document, kind: "text-terms", score, title };
  }
  if (normalizedQuery.length >= 3) {
    const titleScore = subsequenceScore(normalizedQuery, normalizedTitle);
    if (titleScore > 0) {
      return { document, kind: "title-fuzzy", score: 10_000 + titleScore, title };
    }
    const textScore = subsequenceScore(normalizedQuery, normalizedText);
    if (textScore > 0) {
      return { document, kind: "text-fuzzy", score: 5_000 + textScore, title };
    }
  }
  return null;
}
function scoreBlock(block:Block,query:string,terms:readonly string[]):BlockFocusMatch|null {
 const match=scoreSearchDocument({id:block.id,title:blockDisplayTitle(block),text:block.text},query,terms);
 return match?{block,kind:match.kind,score:match.score,title:match.title}:null;
}

function rankAllBlockFocusMatches(
  blocks: readonly Block[],
  query: string,
): BlockFocusMatch[] {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return [];
  const terms = normalizedQuery.split(" ").filter(Boolean);
  return blocks
    .map((block) => scoreBlock(block, normalizedQuery, terms))
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
