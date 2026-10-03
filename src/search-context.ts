import { pageAddressReferences, type NormalizedPageAddress } from "./page-addresses";
import { blockDisplayTitle, blockReferenceIds } from "./references";
import { SEARCH_MATCH_KINDS, type SearchMatchKind } from "./search-match";
import type { Block } from "./types";

/**
 * Where a search is asked from: the note being edited (`contextBlockId` on `tree.search` and
 * `pages.complete`). The text rungs stay in charge; inside one rung, matches nearer the note in the
 * physical tree come first, then the more recently edited. Virtual-branch occurrences never count as near.
 */
export interface SearchContext {
  block: Block;
  /** Hops up from the note to the ancestor it shares with `block`: 0 its own subtree, 1 its siblings', 2 its cousins'; Infinity for another root. */
  distance(block: Block): number;
  /** The note's title and the titles above it, for Jev's state. */
  note: { title: string; path: string };
}

/** Why a note is in the list an empty query opens on. */
export type ContextReason = "linked" | "near" | "yours";

export function ancestorPath(block: Block, byId: ReadonlyMap<string, Block>): string {
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
  return ancestors.join(" › ").slice(-500);
}

export function searchContext(byId: ReadonlyMap<string, Block>, contextBlockId: string | undefined): SearchContext | null {
  if (contextBlockId === undefined) return null;
  if (typeof contextBlockId !== "string") throw new Error("contextBlockId must be a block id");
  const block = byId.get(contextBlockId);
  if (!block) return null;
  const up = new Map<string, number>();
  for (let at: Block | undefined = block, hops = 0; at && !up.has(at.id); at = at.parentId ? byId.get(at.parentId) : undefined) up.set(at.id, hops++);
  const known = new Map<string, number>();
  return {
    block,
    note: { title: blockDisplayTitle(block).slice(0, 250), path: ancestorPath(block, byId) },
    distance(candidate: Block): number {
      const path: string[] = [];
      let distance = Infinity;
      for (let at: Block | undefined = candidate; at; at = at.parentId ? byId.get(at.parentId) : undefined) {
        const hops = up.get(at.id) ?? known.get(at.id);
        if (hops !== undefined) { distance = hops; break; }
        if (path.includes(at.id)) break;
        path.push(at.id);
      }
      // Every note on the way up shares the same ancestor with the context note.
      for (const id of path) known.set(id, distance);
      return distance;
    },
  };
}

const tier = (kind: string) => {
  const index = SEARCH_MATCH_KINDS.indexOf(kind as SearchMatchKind);
  return index < 0 ? -1 : index;
};

/**
 * Matches in their rungs' order, and inside a rung by how much of the query is in the title (a title match
 * is better evidence than a mention in a body) and by fewer typo edits; then nearer the context note first,
 * then the more recently edited.
 */
export function sortByContext<T extends { block: Block; kind: string; inTitle: number; edits?: number }>(matches: T[], context: SearchContext, tie?: (a: T, b: T) => number): T[] {
  return matches.sort((a, b) =>
    tier(a.kind) - tier(b.kind) ||
    b.inTitle - a.inTitle ||
    (a.edits ?? 0) - (b.edits ?? 0) ||
    context.distance(a.block) - context.distance(b.block) ||
    b.block.updatedAt.localeCompare(a.block.updatedAt) ||
    (tie?.(a, b) ?? 0) ||
    a.block.id.localeCompare(b.block.id));
}

/**
 * What an empty query offers from the context note: what its parent and siblings link to (`((id))` and
 * `[[address]]`), the most recently edited linking note's targets first; then notes near it (cousins or
 * closer), most recently edited first; then the person's own recent edits.
 */
export function contextList(
  live: readonly Block[],
  byId: ReadonlyMap<string, Block>,
  context: SearchContext,
  limit: number,
  resolveAddress: (address: NormalizedPageAddress) => string | undefined,
): { block: Block; reason: ContextReason }[] {
  const out: { block: Block; reason: ContextReason }[] = [];
  const seen = new Set<string>([context.block.id]);
  const add = (block: Block | undefined, reason: ContextReason) => {
    if (!block || seen.has(block.id) || out.length >= limit) return;
    seen.add(block.id);
    out.push({ block, reason });
  };
  const newest = (a: Block, b: Block) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
  const parent = context.block.parentId ? byId.get(context.block.parentId) : undefined;
  const linking = [...(parent ? [parent] : []), ...live.filter(block => block.parentId === context.block.parentId && block.id !== context.block.id)].sort(newest);
  for (const source of linking) {
    for (const id of blockReferenceIds(source.text)) add(byId.get(id), "linked");
    for (const reference of pageAddressReferences(source.text)) {
      const id = resolveAddress(reference);
      if (id) add(byId.get(id), "linked");
    }
  }
  for (const block of live.filter(block => context.distance(block) <= 2).sort(newest)) add(block, "near");
  for (const block of live.filter(block => block.author === "user").sort(newest)) add(block, "yours");
  return out;
}
