import { parsePropertyRecords } from "./properties";
import { PROPERTY_KEY_SOURCE, PROPERTY_TOKEN_SOURCE } from "./property-grammar";

/**
 * Context-scoped resolution: "the nearest X" for a position in a block.
 *
 * This is the first slice of PIE-408, built for PIE-445's resource
 * projections (a Jira ticket under a `jira::` line is the first kind). It
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
 *    subject line, at the same or a shallower indent, that holds a key. Each
 *    line passed narrows the indent, so the walk leaves a section through its
 *    heading instead of entering an earlier section's items;
 * 4. `block-property`: the block's own block-scope property (a ticket page);
 * 5. `subject-line`: a key in the block's first non-blank line;
 * 6. `ancestor-property`, then `ancestor-subject`, for each ancestor, nearest
 *    first.
 *
 * Two different keys at the step that matched are ambiguous: the walk reports
 * both and does not guess or skip to a farther step.
 *
 * Current shape, to revisit for PIE-408's soft links: it resolves a line, not
 * an offset, and reads only block-scope properties (not line or inline ones).
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
function keysByLine(text: string, lines: readonly TextLine[], matcher: ContextKeyMatcher): Map<number, string[]> {
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

const PROPERTY_ONLY_LINE = new RegExp(String.raw`^[ \t]*(?:(?:${PROPERTY_TOKEN_SOURCE}[ \t]*)+|${PROPERTY_KEY_SOURCE}::.*)$`);

/**
 * The subject line and the preamble after it: where an ancestor's own
 * property and subject live. A large ancestor is not parsed past them.
 */
function blockHead(text: string): string {
  let start = 0;
  let end = 0;
  let seenSubject = false;
  while (start <= text.length) {
    const newline = text.indexOf("\n", start);
    const lineEnd = newline < 0 ? text.length : newline;
    const line = text.slice(start, lineEnd);
    if (line.trim()) {
      if (seenSubject && !PROPERTY_ONLY_LINE.test(line)) break;
      seenSubject = true;
      end = lineEnd;
    }
    if (newline < 0) break;
    start = newline + 1;
  }
  return text.slice(0, end);
}

interface PreparedBlock {
  readonly id: string;
  readonly subject: number;
  readonly propertyKeys: readonly string[];
  readonly subjectKeys: readonly string[];
}

/**
 * The walk for one block and its ancestors. Each block is parsed once per
 * resolver, however many lines are resolved; ancestors are read only up to
 * the end of their preamble, and only when a nearer step found nothing.
 */
export interface ContextResolver {
  resolve(line: number, explicitKey?: string): ContextResolution;
  /** The block's own block-scope property keys, parsed once. */
  ownPropertyKeys(): readonly string[];
}

export function createContextResolver(input: Omit<ContextResolutionInput, "line" | "explicitKey">): ContextResolver {
  const { block, matcher } = input;
  const lines = textLines(block.text);
  const byLine = keysByLine(block.text, lines, matcher);
  const subject = lines.findIndex((line) => line.text.trim().length > 0);
  let ownProperty: readonly string[] | undefined;
  const preparedAncestors: PreparedBlock[] = [];
  const ancestor = (index: number): PreparedBlock => {
    const existing = preparedAncestors[index];
    if (existing) return existing;
    const source = input.ancestors[index]!;
    const head = blockHead(source.text);
    const headLines = textLines(head);
    const ancestorSubject = headLines.findIndex((line) => line.text.trim().length > 0);
    const prepared = {
      id: source.id,
      subject: ancestorSubject,
      propertyKeys: blockPropertyKeys(head, matcher),
      subjectKeys: ancestorSubject < 0 ? [] : keysByLine(head, headLines, matcher).get(ancestorSubject) ?? [],
    };
    preparedAncestors[index] = prepared;
    return prepared;
  };
  const site = (step: ContextResolutionStep, blockId: string, line: number): ContextResolutionSite =>
    ({ step, blockId, line });

  return {
    ownPropertyKeys() {
      ownProperty ??= blockPropertyKeys(block.text, matcher);
      return ownProperty;
    },
    resolve(line, explicitKey) {
      if (explicitKey) return { kind: "resolved", key: explicitKey, site: site("explicit", block.id, line) };
      const own = decide(byLine.get(line) ?? [], site("line", block.id, line));
      if (own) return own;

      // Each line that passes narrows the indent, so the walk climbs out of a
      // section rather than into an earlier sibling section's items.
      let indent = indentWidth(lines[line]?.text ?? "");
      for (let above = line - 1; above > subject; above -= 1) {
        const text = lines[above]!.text;
        if (!text.trim() || indentWidth(text) > indent) continue;
        const found = decide(byLine.get(above) ?? [], site("preceding-line", block.id, above));
        if (found) return found;
        indent = indentWidth(text);
      }

      const property = decide(this.ownPropertyKeys(), site("block-property", block.id, subject));
      if (property) return property;
      if (subject >= 0 && subject !== line) {
        const found = decide(byLine.get(subject) ?? [], site("subject-line", block.id, subject));
        if (found) return found;
      }

      for (let index = 0; index < input.ancestors.length; index += 1) {
        const prepared = ancestor(index);
        const found = decide(prepared.propertyKeys, site("ancestor-property", prepared.id, prepared.subject)) ??
          decide(prepared.subjectKeys, site("ancestor-subject", prepared.id, prepared.subject));
        if (found) return found;
      }
      return { kind: "none" };
    },
  };
}

export function resolveContextKey(input: ContextResolutionInput): ContextResolution {
  return createContextResolver(input).resolve(input.line, input.explicitKey);
}
