import { rankBlockFocusMatches } from "./block-focus";
import { blockDisplayTitle } from "./references";
import type { Block, GotoSearchCollection } from "./types";

export const GOTO_CANDIDATE_LIMIT = 80;
export const GOTO_RESULT_LIMIT = 30;

/** A disposable projection of canonical blocks, never a second content store. */
export function gotoCandidates(blocks: readonly Block[], query: string, exactAddressId?: string): GotoSearchCollection {
  if (typeof query !== "string" || query.length > 500) throw new Error("Goto query must be at most 500 characters");
  const live = blocks.filter(block => !block.effectiveDeletedRootId && !block.deletedAt);
  const byId = new Map(live.map(block => [block.id, block]));
  const ranked = query.trim()
    ? rankBlockFocusMatches(live, query.trim(), GOTO_CANDIDATE_LIMIT + 1)
    : [...live].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
      .slice(0, GOTO_CANDIDATE_LIMIT + 1).map(block => ({ block, title: blockDisplayTitle(block), kind: "recent" }));
  const address = exactAddressId ? byId.get(exactAddressId) : undefined;
  if (address && ranked[0]?.kind !== "exact-id") {
    const index = ranked.findIndex(match => match.block.id === address.id);
    if (index >= 0) ranked.splice(index, 1);
    ranked.unshift({ block: address, title: blockDisplayTitle(address), kind: "exact-address" });
  }
  const terms = query.toLowerCase().split(/\s+/).filter(term => term.length >= 3);
  return {
    matches: ranked.slice(0, GOTO_CANDIDATE_LIMIT).map(({ block, title, kind }) => {
      const ancestors: string[] = [];
      const seen = new Set([block.id]);
      let parent = block.parentId;
      while (parent && !seen.has(parent) && ancestors.length < 12) {
        seen.add(parent);
        const value = byId.get(parent);
        if (!value) break;
        ancestors.unshift(blockDisplayTitle(value).slice(0, 90));
        parent = value.parentId;
      }
      const lower = block.text.toLowerCase();
      const hit = terms.map(term => lower.indexOf(term)).filter(index => index >= 0).sort((a, b) => a - b)[0] ?? 0;
      const start = Math.max(0, hit - 160);
      return {
        block: { id: block.id, revision: block.revision }, title: title.slice(0, 250),
        path: ancestors.join(" › ").slice(-500),
        snippet: block.text.slice(start, start + 1000),
        exact: kind === "exact-id" || kind === "exact-address" || kind === "id-prefix" || kind === "exact-title",
      };
    }),
    completeness: ranked.length > GOTO_CANDIDATE_LIMIT ? { kind: "truncated", limit: GOTO_CANDIDATE_LIMIT } : { kind: "complete" },
    semantic: { status: "lexical" },
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
