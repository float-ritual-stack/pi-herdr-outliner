import { parsePropertyRecords } from "./properties";

/**
 * Context-scoped resolution: "the nearest X" for a position in a block.
 *
 * This is the first slice of PIE-408, built for PIE-445's `jira::` lines. It
 * knows nothing about providers: a matcher supplies the property key and the
 * key grammar (plus any claim filter, such as "a configured Source owns this
 * project"). PIE-408's soft links reuse this walk rather than adding a second
 * resolver. The walk is local and pure; it reads only the text it is given.
 *
 * Order, nearest first. The walk stops at the first step with any key:
 *
 * 1. `explicit`: a key written in the directive's own value;
 * 2. `line`: a key elsewhere on the same line;
 * 3. `preceding-line`: the nearest earlier line of the same block, below the
 *    subject line, at the same or a shallower indent, that holds a key;
 * 4. `block-property`: the block's own block-scope property (a ticket page);
 * 5. `subject-line`: a key in the block's first non-blank line;
 * 6. `ancestor-property`, then `ancestor-subject`, for each ancestor, nearest
 *    first.
 *
 * Two different keys at the step that matched are ambiguous: the walk reports
 * both and does not guess or skip to a farther step.
 */

export interface ContextKeyOccurrence {
  readonly key: string;
  readonly start: number;
  readonly end: number;
}

export interface ContextKeyMatcher {
  /** The block-scope property that names a whole block's subject, e.g. `jira`. */
  readonly propertyKey: string;
  /** Keys this matcher accepts in text, as offsets into that text. */
  keysIn(text: string): readonly ContextKeyOccurrence[];
  /** A property value as a key, or null when the value is not one. */
  keyFromProperty(value: string): string | null;
}

export interface ContextBlock {
  readonly id: string;
  readonly text: string;
}

export type ContextResolutionStep =
  | "explicit"
  | "line"
  | "preceding-line"
  | "block-property"
  | "subject-line"
  | "ancestor-property"
  | "ancestor-subject";

export interface ContextResolutionSite {
  readonly step: ContextResolutionStep;
  readonly blockId: string;
  /** Line index within that block's text. */
  readonly line: number;
}

export type ContextResolution =
  | { readonly kind: "resolved"; readonly key: string; readonly site: ContextResolutionSite }
  | { readonly kind: "ambiguous"; readonly keys: readonly string[]; readonly site: ContextResolutionSite }
  | { readonly kind: "none" };

export interface ContextResolutionInput {
  readonly block: ContextBlock;
  /** The line being resolved, as an index into `block.text`. */
  readonly line: number;
  /** Ancestors, nearest (the parent) first. */
  readonly ancestors: readonly ContextBlock[];
  readonly matcher: ContextKeyMatcher;
  readonly explicitKey?: string;
}

interface TextLine {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

function textLines(text: string): TextLine[] {
  const lines: TextLine[] = [];
  let start = 0;
  for (const raw of text.split("\n")) {
    const content = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    lines.push({ start, end: start + content.length, text: content });
    start += raw.length + 1;
  }
  return lines;
}

function indentWidth(line: string): number {
  return /^[ \t]*/.exec(line)![0].replaceAll("\t", "    ").length;
}

function distinct(keys: Iterable<string>): string[] {
  return [...new Set(keys)];
}

function decide(keys: readonly string[], site: ContextResolutionSite): ContextResolution | null {
  if (keys.length === 0) return null;
  return keys.length === 1
    ? { kind: "resolved", key: keys[0]!, site }
    : { kind: "ambiguous", keys, site };
}

/** Distinct keys on each line of a block, in line order. */
function keysByLine(text: string, matcher: ContextKeyMatcher): Map<number, string[]> {
  const lines = textLines(text);
  const byLine = new Map<number, string[]>();
  let index = 0;
  for (const occurrence of [...matcher.keysIn(text)].sort((left, right) => left.start - right.start)) {
    while (index + 1 < lines.length && lines[index]!.end < occurrence.start) index += 1;
    const keys = byLine.get(index) ?? [];
    if (!keys.includes(occurrence.key)) keys.push(occurrence.key);
    byLine.set(index, keys);
  }
  return byLine;
}

export function subjectLineIndex(text: string): number {
  return textLines(text).findIndex((line) => line.text.trim().length > 0);
}

/** Distinct values of the block-scope property that are keys to this matcher. */
export function blockPropertyKeys(text: string, matcher: ContextKeyMatcher): string[] {
  return distinct(parsePropertyRecords(text)
    .filter((record) => record.scope === "block" && record.key === matcher.propertyKey)
    .flatMap((record) => {
      const key = matcher.keyFromProperty(record.value);
      return key ? [key] : [];
    }));
}

export function resolveContextKey(input: ContextResolutionInput): ContextResolution {
  const { block, matcher } = input;
  const site = (step: ContextResolutionStep, blockId: string, line: number): ContextResolutionSite =>
    ({ step, blockId, line });
  if (input.explicitKey) {
    return { kind: "resolved", key: input.explicitKey, site: site("explicit", block.id, input.line) };
  }

  const lines = textLines(block.text);
  const byLine = keysByLine(block.text, matcher);
  const subject = subjectLineIndex(block.text);
  const own = decide(byLine.get(input.line) ?? [], site("line", block.id, input.line));
  if (own) return own;

  const indent = indentWidth(lines[input.line]?.text ?? "");
  for (let line = input.line - 1; line > subject; line -= 1) {
    const text = lines[line]!.text;
    if (!text.trim() || indentWidth(text) > indent) continue;
    const found = decide(byLine.get(line) ?? [], site("preceding-line", block.id, line));
    if (found) return found;
  }

  const property = decide(
    blockPropertyKeys(block.text, matcher),
    site("block-property", block.id, subject),
  );
  if (property) return property;
  if (subject >= 0 && subject !== input.line) {
    const found = decide(byLine.get(subject) ?? [], site("subject-line", block.id, subject));
    if (found) return found;
  }

  for (const ancestor of input.ancestors) {
    const ancestorSubject = subjectLineIndex(ancestor.text);
    const found = decide(
      blockPropertyKeys(ancestor.text, matcher),
      site("ancestor-property", ancestor.id, ancestorSubject),
    ) ?? (ancestorSubject >= 0
      ? decide(
        keysByLine(ancestor.text, matcher).get(ancestorSubject) ?? [],
        site("ancestor-subject", ancestor.id, ancestorSubject),
      )
      : null);
    if (found) return found;
  }
  return { kind: "none" };
}
