// Fragment completion over the whole outline (PIE-424, PIE-295): which `((note#heading` / `((note^anchor`
// targets match what was typed, by the service's own fragment rules (src/fragments.ts), across every active
// note rather than the first 500. Every client's completion asks `fragments.candidates`; a heading without
// an anchor is offered with the anchor it would get, and `fragments.ensure` writes it (revision-checked).
import { rankBlockFocusMatches } from "./block-focus";
import { ensureHeadingFragment, fragmentCandidates, type FragmentKind } from "./fragments";
import { blockDisplayTitle } from "./references";
import type { Block } from "./types";

export const FRAGMENT_CANDIDATE_DEFAULT_LIMIT = 20;
export const FRAGMENT_CANDIDATE_MAX_LIMIT = 100;

export interface FragmentCandidateQuery {
  /** The note part typed before `#` or `^` (`garden` in `((garden#beds`); empty searches every note. */
  noteQuery?: string;
  /** The fragment part typed after it. */
  fragmentQuery?: string;
  /** `#`: headings (anchored or not) and other anchors; `^`: anchors by id or label. */
  mode?: "heading" | "id";
  limit?: number;
  /** The note being edited, as typed now: searched first, in its draft text. */
  draft?: { blockId: string; text: string };
}

export interface FragmentCandidateHit {
  blockId: string;
  title: string;
  revision: number;
  kind: FragmentKind;
  label: string;
  lineIndex: number;
  /** Its anchor, when it has one. */
  fragmentId?: string;
  /** A heading without an anchor: the anchor it would get and its line with it (`## Beds ^beds`). */
  anchor?: { fragmentId: string; line: string };
}

export interface FragmentCandidateCollection {
  items: FragmentCandidateHit[];
  completeness: { kind: "complete" } | { kind: "truncated"; limit: number };
  /** How many notes were looked into (every active note is considered). */
  searched: number;
}

const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();

/**
 * The fragments across `blocks` that match `query`, in order: the draft's note first, then the notes the
 * note part ranks (every note when it's empty, newest first). A note is only parsed when its text could
 * hold a match (a `#` or `^`, and the fragment part's words), so a large outline stays cheap.
 */
export function searchFragmentCandidates(blocks: readonly Block[], query: FragmentCandidateQuery): FragmentCandidateCollection {
  if (!query || typeof query !== "object") throw new Error("fragments.candidates needs a query");
  const limit = query.limit ?? FRAGMENT_CANDIDATE_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > FRAGMENT_CANDIDATE_MAX_LIMIT) {
    throw new Error(`Fragment candidate limit must be between 1 and ${FRAGMENT_CANDIDATE_MAX_LIMIT}`);
  }
  const mode = query.mode ?? "heading";
  if (mode !== "heading" && mode !== "id") throw new Error("Fragment candidate mode must be heading or id");
  const draft = query.draft;
  const fragmentQuery = query.fragmentQuery ?? "";
  const wanted = normalize(fragmentQuery);
  const noteQuery = (query.noteQuery ?? "").trim();
  const ordered = noteQuery
    ? blocks.length ? rankBlockFocusMatches(blocks, noteQuery, blocks.length).map(match => match.block) : []
    : [...blocks].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const draftBlock = draft ? blocks.find(block => block.id === draft.blockId) : undefined;
  const order = draftBlock && (!noteQuery || ordered.includes(draftBlock))
    ? [draftBlock, ...ordered.filter(block => block !== draftBlock)] : ordered;
  const items: FragmentCandidateHit[] = [];
  let searched = 0;
  for (const block of order) {
    const source = block.id === draft?.blockId ? draft.text : block.text;
    if (!source.includes(mode === "heading" ? "#" : "^") && !source.includes("^")) continue;
    if (wanted && !normalize(source).includes(wanted)) continue;
    searched++;
    for (const candidate of fragmentCandidates(source, fragmentQuery, mode)) {
      if (items.length >= limit) return { items, completeness: { kind: "truncated", limit }, searched };
      const hit: FragmentCandidateHit = {
        blockId: block.id, title: blockDisplayTitle(block), revision: block.revision,
        kind: candidate.kind, label: candidate.label, lineIndex: candidate.lineIndex,
        ...(candidate.fragmentId ? { fragmentId: candidate.fragmentId } : {}),
      };
      if (!candidate.fragmentId) {
        const anchored = ensureHeadingFragment(source, candidate.lineIndex);
        hit.anchor = { fragmentId: anchored.fragmentId, line: anchored.text.split(/\r?\n/)[candidate.lineIndex]! };
      }
      items.push(hit);
    }
  }
  return { items, completeness: { kind: "complete" }, searched };
}
