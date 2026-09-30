/**
 * The compare of `draft.patch` (PIE-501): where a patch's observed text is in a
 * note's text now, and what the text and a position become once it is applied.
 *
 * It imports nothing, because the door runs the same compare against its live
 * draft: ep0ch-door keeps this file byte for byte in
 * `src/vendor/draft-patch-compare.ts` (checked by its tests), as it does the
 * property grammar. Bump `DRAFT_PATCH_COMPARE_VERSION` with any change to what
 * it accepts; `ping` reports it (`ping.draftPatchCompare`).
 *
 * Offsets are UTF-16 code units unless a span declares `unit: "utf8"`, whose
 * range is then in UTF-8 bytes. The range is a hint: the observed text is what
 * is compared.
 */

export const DRAFT_PATCH_COMPARE_VERSION = 1;

/** How far from its hinted start a span's observed text may have moved (UTF-16 units) and still match. */
export const DRAFT_PATCH_NEAR = 256;

/** How much text either side of a span a proposal keeps, to place "apply anyway" once the span has changed. */
export const DRAFT_PATCH_CONTEXT = 48;

export type DraftPatchUnit = "utf16" | "utf8";

export interface DraftPatchRange {
  start: number;
  end: number;
}

/** One compare-and-swap on a span of a note's text. */
export interface DraftPatchSpan {
  /** The text the writer saw there. Never empty: an insertion compares the text it goes beside. */
  observed: string;
  /** What it becomes. */
  replacement: string;
  /** Where the writer saw it: a hint, in `unit`. */
  range?: DraftPatchRange;
  /** The range's unit; UTF-16 code units when left out. */
  unit?: DraftPatchUnit;
  /** Text just before and after the span when it was proposed (a proposal keeps these for "apply anyway"). */
  before?: string;
  after?: string;
}

/** A span found in the text: `[start, end)` in UTF-16 units becomes `replacement`. */
export interface LocatedSpan {
  start: number;
  end: number;
  replacement: string;
}

export type LocatedSpans =
  | { ok: true; spans: LocatedSpan[] }
  | { ok: false; index: number; reason: string };

/** A range in `unit` as UTF-16 offsets of `text`; null when it doesn't fall on characters of the text. */
export function utf16Range(text: string, range: DraftPatchRange, unit: DraftPatchUnit = "utf16"): DraftPatchRange | null {
  if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end < range.start) return null;
  if (unit === "utf16") return range.end <= text.length ? { start: range.start, end: range.end } : null;
  const start = utf16OfByte(text, range.start);
  const end = utf16OfByte(text, range.end);
  return start === null || end === null ? null : { start, end };
}

function utf16OfByte(text: string, byte: number): number | null {
  let bytes = 0;
  for (let index = 0; index <= text.length;) {
    if (bytes === byte) return index;
    if (bytes > byte || index === text.length) return null;
    const code = text.codePointAt(index)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    index += code > 0xffff ? 2 : 1;
  }
  return null;
}

function occurrences(text: string, needle: string): number[] {
  const found: number[] = [];
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) found.push(at);
  return found;
}

function nearest(candidates: number[], to: number, within: number): { at: number } | { tie: true } | null {
  let best: number | null = null;
  let tie = false;
  for (const at of candidates) {
    const distance = Math.abs(at - to);
    if (distance > within) continue;
    if (best === null || distance < Math.abs(best - to)) { best = at; tie = false; }
    else if (distance === Math.abs(best - to)) tie = true;
  }
  return best === null ? null : tie ? { tie: true } : { at: best };
}

/**
 * Where one span's observed text is now. With a range, the text at the range,
 * or failing that the nearest copy within `DRAFT_PATCH_NEAR` of its start; without
 * one, its only copy.
 */
export function locateSpan(text: string, span: DraftPatchSpan): { start: number; end: number } | { reason: string } {
  if (!span.observed) return { reason: "the observed text is empty; compare the text the change goes beside" };
  const found = occurrences(text, span.observed);
  if (!span.range) {
    if (found.length === 1) return { start: found[0]!, end: found[0]! + span.observed.length };
    return { reason: found.length ? "the observed text is in the note more than once; give its range" : "the observed text isn't there any more" };
  }
  const hint = utf16Range(text, span.range, span.unit);
  if (hint && text.slice(hint.start, hint.end) === span.observed) return hint;
  const hintStart = hint?.start ?? Math.min(text.length, span.range.start);
  const near = nearest(found, hintStart, DRAFT_PATCH_NEAR);
  if (near && "at" in near) return { start: near.at, end: near.at + span.observed.length };
  if (near) return { reason: "the observed text is near its range more than once" };
  return { reason: found.length ? "the observed text has moved away from its range" : "the observed text isn't there any more" };
}

/**
 * "Apply anyway": the observed text wherever it is nearest its hint, or else
 * the text now between the context the proposal kept on either side.
 */
export function locateSpanForced(text: string, span: DraftPatchSpan): { start: number; end: number } | { reason: string } {
  const hintStart = span.range ? (utf16Range(text, span.range, span.unit)?.start ?? Math.min(text.length, span.range.start)) : 0;
  if (span.observed) {
    const found = occurrences(text, span.observed);
    const near = nearest(found, hintStart, Infinity);
    if (near && "at" in near) return { start: near.at, end: near.at + span.observed.length };
  }
  if (span.before === undefined || span.after === undefined || (!span.before && !span.after)) {
    return { reason: "the passage it replaces isn't there any more" };
  }
  // The context nearest the passage matters most: a line typed or put in further away (a proposal's own
  // embed under the mark) only shortens it, a line at a time.
  let start = -1;
  for (const before of span.before ? trimmed(span.before, "start") : [""]) {
    const pick = nearest(before ? occurrences(text, before).map(at => at + before.length) : [0], hintStart, Infinity);
    if (pick && "at" in pick) { start = pick.at; break; }
  }
  if (start < 0) return { reason: "the text before the passage isn't there any more" };
  for (const after of span.after ? trimmed(span.after, "end") : [""]) {
    const end = after ? text.indexOf(after, start) : text.length;
    if (end >= 0) return { start, end };
  }
  return { reason: "the text after the passage isn't there any more" };
}

/** Context, then shorter by whole lines from its far side (`start`: the lines before; `end`: after). */
function trimmed(context: string, far: "start" | "end"): string[] {
  const out = [context];
  if (far === "start") {
    for (let at = context.indexOf("\n"); at >= 0 && at < context.length - 1; at = context.indexOf("\n", at + 1)) out.push(context.slice(at + 1));
  } else {
    for (let at = context.lastIndexOf("\n"); at > 0; at = context.lastIndexOf("\n", at - 1)) out.push(context.slice(0, at));
  }
  return out.filter(candidate => candidate.trim());
}

/** Every span of one note located at once; they may not overlap. */
export function locateSpans(text: string, spans: readonly DraftPatchSpan[], force = false): LocatedSpans {
  const located: LocatedSpan[] = [];
  for (const [index, span] of spans.entries()) {
    const at = force ? locateSpanForced(text, span) : locateSpan(text, span);
    if ("reason" in at) return { ok: false, index, reason: at.reason };
    located.push({ start: at.start, end: at.end, replacement: span.replacement });
  }
  const ordered = [...located].sort((left, right) => left.start - right.start);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index]!.start < ordered[index - 1]!.end) {
      return { ok: false, index: located.indexOf(ordered[index]!), reason: "two spans of the patch overlap" };
    }
  }
  return { ok: true, spans: ordered };
}

/** The text with located spans replaced. */
export function applyLocated(text: string, spans: readonly LocatedSpan[]): string {
  let out = "";
  let cursor = 0;
  for (const span of [...spans].sort((left, right) => left.start - right.start)) {
    out += text.slice(cursor, span.start) + span.replacement;
    cursor = span.end;
  }
  return out + text.slice(cursor);
}

/**
 * Where an offset of the old text is in the new one. Before a span it stays,
 * after it moves by the span's change in length; inside one it goes to the
 * replacement's end (a cursor inside a replaced passage lands after it).
 */
export function mapOffset(offset: number, spans: readonly LocatedSpan[]): number {
  let delta = 0;
  for (const span of spans) {
    if (offset < span.start || (offset === span.start && span.end > span.start)) break;
    if (offset < span.end) return span.start + delta + span.replacement.length;
    delta += span.replacement.length - (span.end - span.start);
  }
  return offset + delta;
}

/**
 * Where the mark line starts: the first line whose text, trimmed, is `mark`
 * trimmed (the `@request` line). -1 when no line is.
 */
export function markStart(text: string, mark: string): number {
  const wanted = mark.trim();
  if (!wanted) return -1;
  let start = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === wanted) return start;
    start += line.length + 1;
  }
  return -1;
}

/**
 * The start of the block of text holding `offset`: its paragraph (lines back to
 * a blank one), or its own line when that is a list item or a heading. The mark
 * for an actor with no `@request` line is the start of the cursor's block.
 */
export function blockStartAt(text: string, offset: number): number {
  const lines = text.split("\n");
  let start = 0;
  let row = 0;
  for (; row < lines.length - 1 && start + lines[row]!.length < offset; row += 1) start += lines[row]!.length + 1;
  const own = lines[row]!;
  if (/^\s*(?:[-*+]|\d{1,9}[.)])\s|^\s*#{1,6}\s/.test(own) || !own.trim()) return start;
  while (row > 0) {
    const above = lines[row - 1]!;
    if (!above.trim() || /^\s*(?:[-*+]|\d{1,9}[.)])\s|^\s*#{1,6}\s/.test(above)) break;
    row -= 1;
    start -= above.length + 1;
  }
  return start;
}

/** The text kept on either side of a span, for placing it again later. */
export function spanContext(text: string, start: number, end: number): { before: string; after: string } {
  return {
    before: text.slice(Math.max(0, start - DRAFT_PATCH_CONTEXT), start),
    after: text.slice(end, end + DRAFT_PATCH_CONTEXT),
  };
}
