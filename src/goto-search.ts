import { rankBlockFocusMatches } from "./block-focus";
import type { NormalizedPageAddress } from "./page-addresses";
import { blockDisplayTitle } from "./references";
import { searchTextTerms } from "./search-match";
import { ancestorPath, contextList, searchContext, sortByContext, type ContextReason } from "./search-context";
import type { Block, GotoSearchCollection } from "./types";

export const GOTO_CANDIDATE_LIMIT = 80;
export const GOTO_RESULT_LIMIT = 30;

export interface GotoSearchOptions {
  /** The block a named address in the query resolves to: it is offered first. */
  exactAddressId?: string;
  /** The note being edited (`contextBlockId`): nearer notes first inside each rung, and an empty query's list. */
  contextBlockId?: string;
  /** What a `[[address]]` in a nearby note names, for an empty query's list. */
  resolveAddress?: (address: NormalizedPageAddress) => string | undefined;
}

/** A disposable projection of canonical blocks, never a second content store. */
export function gotoCandidates(blocks: readonly Block[], query: string, options: GotoSearchOptions = {}): GotoSearchCollection {
  if (typeof query !== "string" || query.length > 500) throw new Error("Goto query must be at most 500 characters");
  const live = blocks.filter(block => !block.effectiveDeletedRootId && !block.deletedAt);
  const byId = new Map(live.map(block => [block.id, block]));
  const context = searchContext(byId, options.contextBlockId);
  let ranked: { block: Block; title: string; kind: string; reason?: ContextReason }[];
  if (query.trim() && context) ranked = live.length ? sortByContext(rankBlockFocusMatches(live, query.trim(), live.length), context) : [];
  else if (query.trim()) ranked = rankBlockFocusMatches(live, query.trim(), GOTO_CANDIDATE_LIMIT + 1);
  else if (context) ranked = contextList(live, byId, context, GOTO_CANDIDATE_LIMIT + 1, options.resolveAddress ?? (() => undefined))
    .map(({ block, reason }) => ({ block, title: blockDisplayTitle(block), kind: "recent", reason }));
  else ranked = [...live].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
    .slice(0, GOTO_CANDIDATE_LIMIT + 1).map(block => ({ block, title: blockDisplayTitle(block), kind: "recent" }));
  const address = options.exactAddressId ? byId.get(options.exactAddressId) : undefined;
  if (address && ranked[0]?.kind !== "exact-id") {
    const index = ranked.findIndex(match => match.block.id === address.id);
    if (index >= 0) ranked.splice(index, 1);
    ranked.unshift({ block: address, title: blockDisplayTitle(address), kind: "exact-address" });
  }
  // Where a word of the query is (split as blocks.query splits it), for the snippet.
  const terms = searchTextTerms(query).filter(term => term.length >= 3);
  return {
    matches: ranked.slice(0, GOTO_CANDIDATE_LIMIT).map(({ block, title, kind, reason }) => {
      const lower = block.text.toLowerCase();
      const hit = terms.map(term => lower.indexOf(term)).filter(index => index >= 0).sort((a, b) => a - b)[0] ?? 0;
      const start = Math.max(0, hit - 160);
      return {
        block: { id: block.id, revision: block.revision }, title: title.slice(0, 250),
        path: ancestorPath(block, byId),
        snippet: block.text.slice(start, start + 1000),
        exact: kind === "exact-id" || kind === "exact-address" || kind === "id-prefix" || kind === "exact-title",
        ...(reason ? { reason } : {}),
      };
    }),
    completeness: ranked.length > GOTO_CANDIDATE_LIMIT ? { kind: "truncated", limit: GOTO_CANDIDATE_LIMIT } : { kind: "complete" },
    semantic: { status: "lexical" },
    ...(context ? { context: { blockId: context.block.id, ...context.note } } : {}),
  };
}

export function visibleGotoResults(result: GotoSearchCollection): GotoSearchCollection {
  return {
    ...result,
    matches: result.matches.slice(0, GOTO_RESULT_LIMIT),
    completeness: result.matches.length > GOTO_RESULT_LIMIT ? { kind: "truncated", limit: GOTO_RESULT_LIMIT } : result.completeness,
  };
}

export {rankSearchWithJev as rankGotoWithJev} from './search-ranking';
