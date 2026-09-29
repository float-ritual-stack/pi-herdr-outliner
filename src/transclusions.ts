// The service's fragment and transclusion rules (PIE-424): what `((id^fragment))` covers in its note, and
// what `!((id))` / `!((id^fragment))` project, nested to a bounded depth and cycle-safe (the PIE-185
// contract's limits and wording). Clients ask (`fragments.read`, `transclusions.read`) instead of
// re-deriving; Detail's own embed projection (detail-embeds.ts) takes its limits and wording from here.
import { checklistItems } from "./checklist-items";
import { codeLineSet, fragmentPresentationText, isFragmentId, resolveFragmentSlice, type FragmentKind } from "./fragments";
import { blockDisplayTitle } from "./references";
import type { Block, ChecklistItem } from "./types";
import { isVirtualBranchDefinition } from "./virtual-branches";

/** How many transclusions one document projects; the rest say EMBED LIMIT (Detail's rule). */
export const MAX_EMBEDS_PER_DOCUMENT = 16;
/** How deep embeds nest when the caller doesn't say: the target is level 1, an embed in it level 2. */
export const TRANSCLUSION_DEFAULT_DEPTH = 3;
/** The hard ceiling a caller's `maxDepth` is clamped to. */
export const TRANSCLUSION_MAX_DEPTH = 6;
/** Expanded embeds in one read, across every target and level; past it each says EMBED BUDGET. */
export const TRANSCLUSION_MAX_NODES = 64;
/**
 * The note text one read carries, all notes together (each is sent once, however often it's embedded).
 * A note that would take the read past it says EMBED TOO LARGE instead of being sent.
 */
export const TRANSCLUSION_MAX_BYTES = 512 * 1024;

/** `!((id))` and `!((id^fragment))`: Detail's transclusion syntax (no label). */
export const EMBED_PATTERN_SOURCE = String.raw`!\(\(([A-Za-z0-9_-]{8,})(?:\^([A-Za-z0-9][A-Za-z0-9_-]{0,63}))?\)\)`;
export const embedPattern = () => new RegExp(EMBED_PATTERN_SOURCE, "g");

/**
 * The embeds a reader expands in `text`, in order. Fenced and indented code shows `!((…))` as written,
 * so it never embeds. `text` is line for line with `note` from `firstLine` (a fragment's slice), and code
 * is judged in the note, where the slice is read.
 */
export function embedMatches(text: string, note = text, firstLine = 0, max = Infinity) {
  if (!text.includes("!((")) return [];
  const code = codeLineSet(note);
  const starts = lineStarts(text);
  const out: RegExpExecArray[] = [];
  const pattern = embedPattern();
  let line = 0;
  // Only as many as the caller can use: a note with thousands of embeds isn't scanned past them.
  for (let m = pattern.exec(text); m && out.length < max; m = pattern.exec(text)) {
    while (line + 1 < starts.length && starts[line + 1]! <= m.index) line++;
    if (!code.has(firstLine + line)) out.push(m);
  }
  return out;
}

export type TransclusionStatus =
  | "ready" | "missing" | "deleted" | "failed" | "fragment-missing" | "fragment-duplicate"
  | "limit" | "depth-limit" | "cycle" | "budget" | "too-large";

/**
 * What a reader says in place of an embed that can't be shown, after `!((ref)) · `. Detail's wording for
 * the states it has; PIE-185's for the nesting ones.
 */
export const TRANSCLUSION_WORDING = {
  missing: "MISSING TARGET",
  deleted: (title: string) => `IN TRASH · ${title}`,
  failed: (error: string) => `TARGET FAILED · ${error}`,
  fragmentMissing: "MISSING FRAGMENT",
  fragmentDuplicate: "DUPLICATE FRAGMENT",
  limit: `EMBED LIMIT · maximum ${MAX_EMBEDS_PER_DOCUMENT}`,
  depthLimit: (depth: number) => `DEPTH LIMIT · embeds nest ${depth} deep`,
  cycle: "CYCLE · this embed is already open above it",
  budget: `EMBED BUDGET · ${TRANSCLUSION_MAX_NODES} embeds per read`,
  tooLarge: (kb: number) => `EMBED TOO LARGE · ${kb} KB would take this read past ${TRANSCLUSION_MAX_BYTES / 1024} KB`,
} as const;

/** One fragment's slice of its note: what it covers, where, and the text a reader shows for it. */
export interface FragmentSliceRead {
  kind: FragmentKind;
  label: string;
  /** Lines of the note's text, from 0, inclusive. */
  startLine: number;
  endLine: number;
  /** UTF-16 offsets into the note's text: the covered lines, [start, end). */
  start: number;
  end: number;
  /**
   * The slice as a reader shows it: anchors hidden, a list item standing alone (its indentation
   * dropped). Line for line with startLine..endLine.
   */
  text: string;
}

export type FragmentRead =
  | { blockId: string; fragmentId: string; revision: number; status: "resolved"; fragment: FragmentSliceRead }
  | { blockId: string; fragmentId: string; revision: number; status: "missing" }
  | { blockId: string; fragmentId: string; revision: number; status: "duplicate"; duplicates: { kind: FragmentKind; label: string; line: number }[] };

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

/** `((id^fragment))` in `block`: its slice, or why there is none. The same slice Detail embeds. */
export function readFragment(block: Pick<Block, "id" | "text" | "revision">, fragmentId: string): FragmentRead {
  const base = { blockId: block.id, fragmentId, revision: block.revision };
  if (!isFragmentId(fragmentId)) throw new Error(`Not a fragment id: ${fragmentId}`);
  const r = resolveFragmentSlice(block.text, fragmentId);
  if (r.status === "missing") return { ...base, status: "missing" };
  if (r.status === "duplicate") {
    return { ...base, status: "duplicate", duplicates: r.anchors.map(a => ({ kind: a.kind, label: a.label, line: a.lineIndex })) };
  }
  const starts = lineStarts(block.text);
  const lines = block.text.split("\n");
  const { slice } = r;
  const endOfLast = starts[slice.endLine]! + lines[slice.endLine]!.replace(/\r$/, "").length;
  // Line for line: a trailing blank line the slice trimmed is still one of its lines.
  const shown = fragmentPresentationText(slice).split("\n");
  while (shown.length < slice.endLine - slice.startLine + 1) shown.push("");
  return {
    ...base, status: "resolved",
    fragment: {
      kind: slice.anchor.kind, label: slice.anchor.label, startLine: slice.startLine, endLine: slice.endLine,
      start: starts[slice.startLine]!, end: endOfLast, text: shown.join("\n"),
    },
  };
}

/** A target to project: `!((blockId))` or `!((blockId^fragmentId))`. */
export interface TransclusionTarget { blockId: string; fragmentId?: string }

/**
 * One projected embed. A ready one names its target block (sent once in `TransclusionRead.blocks`: the
 * whole note, which a reader draws as it draws a note) and, for a fragment, the slice it shows; the steps
 * inside what's shown are that block's `checklists` entries between its lines (`shownLines`), so a reader
 * can offer their status controls; `embeds` are the embeds inside what's shown, in the order they occur
 * there, each projected the same way (or saying why not). `kind: "view"` is a virtual branch: the reader
 * reads its results (`views.read`), and nothing in its definition is expanded.
 */
export interface TransclusionNode {
  blockId: string;
  fragmentId?: string;
  status: TransclusionStatus;
  /** Why it isn't shown, in the reader's words: see TRANSCLUSION_WORDING. */
  message?: string;
  kind?: "note" | "fragment" | "view";
  title?: string;
  revision?: number;
  fragment?: FragmentSliceRead;
  /** The note lines (from 0) a ready note or fragment shows, inclusive. */
  shownLines?: { start: number; end: number };
  embeds?: TransclusionNode[];
  /** How deep this embed is: the target a reader asked for is 1. */
  depth: number;
}

export interface TransclusionRead {
  limits: { maxDepth: number; maxPerDocument: number; maxNodes: number };
  results: TransclusionNode[];
  /** Every block the answer shows or tried to: a change to any of them makes it stale. */
  dependencies: string[];
  /** Each note a ready projection shows, once, by id. */
  blocks: Record<string, Block>;
  /** Each of those notes' checklist steps, as `checklist.query` reads them (without their properties). */
  checklists: Record<string, TransclusionStep[]>;
}

/**
 * A checklist step as a transclusion carries it: `checklist.query`'s item without its property records
 * or its text (the note, sent once in `blocks`, holds it at `span`).
 */
export type TransclusionStep = Omit<ChecklistItem, "properties" | "text" | "markerStart" | "parentStart">;
/** Roughly what one step adds to an answer, for its byte budget. */
const STEP_BYTES = 180;
/** A line that could be a checklist step: only a note with one is parsed for steps. */
const MAY_HOLD_STEP = /^[ \t]*(?:[-+*]|\d+[.)])[ \t]+\[[ xX~!]\]/m;

/**
 * What a read needs from a note's text, worked out once per text and kept for the next reads: its steps,
 * its display title, how many lines it has, and each fragment's slice.
 */
interface NoteFacts { text: string; steps: TransclusionStep[]; title: string; lines: number; fragments: Map<string, FragmentRead> }
const NOTE_FACTS = 64;
const noteFacts = new Map<string, NoteFacts>();
function factsOf(block: Block): NoteFacts {
  const key = `${block.id}:${block.revision}`;
  const hit = noteFacts.get(key);
  if (hit && hit.text === block.text) { noteFacts.delete(key); noteFacts.set(key, hit); return hit; }
  const steps = MAY_HOLD_STEP.test(block.text)
    ? checklistItems(block.text).map(({ properties: _, text: __, markerStart: ___, parentStart: ____, ...item }) => item) : [];
  const facts = { text: block.text, steps, title: blockDisplayTitle(block), lines: block.text.split("\n").length, fragments: new Map<string, FragmentRead>() };
  noteFacts.set(key, facts);
  if (noteFacts.size > NOTE_FACTS) noteFacts.delete(noteFacts.keys().next().value!);
  return facts;
}

export interface TransclusionOptions {
  /** The note the targets are embedded in: embedding it again inside them is a cycle. */
  hostBlockId?: string;
  /** Levels to expand, clamped to 1..TRANSCLUSION_MAX_DEPTH (default TRANSCLUSION_DEFAULT_DEPTH). */
  maxDepth?: number;
}

const refKey = (t: TransclusionTarget) => `${t.blockId}${t.fragmentId ? `^${t.fragmentId}` : ""}`;

/**
 * Project `targets` as a reader shows them, nested. `load` answers a block (trashed ones too) or null
 * when there is none. Cycles are found by (block, fragment) on the path from the host; the same target in
 * sibling places is fine. Depth, a document's embed count and the read's budget each fail at the embed
 * that crosses them, never blanking the rest.
 */
export function readTransclusions(
  load: (blockId: string) => Block | null,
  targets: readonly TransclusionTarget[],
  options: TransclusionOptions = {},
): TransclusionRead {
  if (!Array.isArray(targets)) throw new Error("transclusions.read needs targets: [{blockId, fragmentId?}]");
  if (targets.length > 64) throw new Error("transclusions.read takes at most 64 targets");
  for (const t of targets) {
    if (!t || typeof t.blockId !== "string" || !t.blockId) throw new Error("Each target needs a blockId");
    if (t.fragmentId !== undefined && !isFragmentId(t.fragmentId)) throw new Error(`Not a fragment id: ${t.fragmentId}`);
  }
  const requested = options.maxDepth ?? TRANSCLUSION_DEFAULT_DEPTH;
  if (!Number.isSafeInteger(requested)) throw new Error("maxDepth must be a whole number");
  const maxDepth = Math.max(1, Math.min(TRANSCLUSION_MAX_DEPTH, requested));
  const dependencies = new Set<string>();
  const sent: Record<string, Block> = {};
  const checklists: Record<string, TransclusionStep[]> = {};
  let bytes = 0;
  let nodes = 0;
  const cached = new Map<string, Block | null>();
  const get = (id: string) => {
    if (!cached.has(id)) cached.set(id, load(id));
    return cached.get(id)!;
  };

  const project = (t: TransclusionTarget, depth: number, path: readonly string[]): TransclusionNode => {
    const base = { blockId: t.blockId, ...(t.fragmentId ? { fragmentId: t.fragmentId } : {}), depth };
    dependencies.add(t.blockId);
    if (path.includes(refKey(t))) {
      return { ...base, status: "cycle", message: TRANSCLUSION_WORDING.cycle };
    }
    if (++nodes > TRANSCLUSION_MAX_NODES) return { ...base, status: "budget", message: TRANSCLUSION_WORDING.budget };
    let block: Block | null;
    try { block = get(t.blockId); } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 240);
      return { ...base, status: "failed", message: TRANSCLUSION_WORDING.failed(message) };
    }
    if (!block) return { ...base, status: "missing", message: TRANSCLUSION_WORDING.missing };
    if (block.effectiveDeletedRootId) { const title = blockDisplayTitle(block); return { ...base, status: "deleted", message: TRANSCLUSION_WORDING.deleted(title), title }; }
    // Each note goes out once, with its steps; one that would take the read past its byte budget isn't
    // sent (nor parsed) at all.
    if (!sent[block.id]) {
      const size = Buffer.byteLength(block.text);
      const tooLarge = (n: number) => ({ ...base, title: blockDisplayTitle(block!), revision: block!.revision, status: "too-large" as const, message: TRANSCLUSION_WORDING.tooLarge(Math.ceil(n / 1024)) });
      if (bytes + size > TRANSCLUSION_MAX_BYTES) return tooLarge(size);
      const withSteps = size + factsOf(block).steps.length * STEP_BYTES;
      if (bytes + withSteps > TRANSCLUSION_MAX_BYTES) return tooLarge(withSteps);
      bytes += withSteps;
      sent[block.id] = block;
    }
    const facts = factsOf(block);
    const title = facts.title;
    const found = { ...base, title, revision: block.revision };
    let shown: { startLine: number; endLine: number; text: string } = { startLine: 0, endLine: facts.lines - 1, text: block.text };
    let fragment: FragmentSliceRead | undefined;
    if (t.fragmentId) {
      let read = facts.fragments.get(t.fragmentId);
      if (!read) facts.fragments.set(t.fragmentId, (read = readFragment(block, t.fragmentId)));
      if (read.status === "missing") return { ...base, title, revision: block.revision, status: "fragment-missing", message: TRANSCLUSION_WORDING.fragmentMissing };
      if (read.status === "duplicate") return { ...base, title, revision: block.revision, status: "fragment-duplicate", message: TRANSCLUSION_WORDING.fragmentDuplicate };
      fragment = read.fragment;
      shown = { startLine: fragment.startLine, endLine: fragment.endLine, text: fragment.text };
    } else if (isVirtualBranchDefinition(block)) {
      return { ...found, status: "ready", kind: "view" };
    }
    checklists[block.id] ??= facts.steps;
    const inner = embedMatches(shown.text, block.text, shown.startLine, MAX_EMBEDS_PER_DOCUMENT + 1).map(m => ({ blockId: m[1]!, ...(m[2] ? { fragmentId: m[2] } : {}) }));
    const here = [...path, refKey(t)];
    const embeds = inner.map((child, index): TransclusionNode => {
      const at = { blockId: child.blockId, ...(child.fragmentId ? { fragmentId: child.fragmentId } : {}), depth: depth + 1 };
      if (index >= MAX_EMBEDS_PER_DOCUMENT) return { ...at, status: "limit", message: TRANSCLUSION_WORDING.limit };
      if (depth >= maxDepth) { dependencies.add(child.blockId); return { ...at, status: "depth-limit", message: TRANSCLUSION_WORDING.depthLimit(maxDepth) }; }
      return project(child, depth + 1, here);
    });
    return {
      ...found, status: "ready", kind: fragment ? "fragment" : "note",
      ...(fragment ? { fragment } : {}), shownLines: { start: shown.startLine, end: shown.endLine }, embeds,
    };
  };

  const root = options.hostBlockId ? [options.hostBlockId] : [];
  const results = targets.map((t, index) => index >= MAX_EMBEDS_PER_DOCUMENT
    ? { blockId: t.blockId, ...(t.fragmentId ? { fragmentId: t.fragmentId } : {}), depth: 1, status: "limit" as const, message: TRANSCLUSION_WORDING.limit }
    : project(t, 1, root));
  return {
    limits: { maxDepth, maxPerDocument: MAX_EMBEDS_PER_DOCUMENT, maxNodes: TRANSCLUSION_MAX_NODES },
    results,
    dependencies: [...dependencies],
    blocks: sent,
    checklists,
  };
}
