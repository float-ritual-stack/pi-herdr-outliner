import { hyperlink } from "@earendil-works/pi-tui";
import { blockDisplayTitle, blockReferenceIds } from "./references";
import type { Block } from "./types";

const OUTLINER_SCHEME = "pi-outliner:";
const BLOCK_ID_PATTERN = /^[A-Za-z0-9_-]{8,}$/;
const BLOCK_ID_TOKEN_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const WORK_ID_PATTERN = /\bPIE-\d+\b/g;
const RAW_BLOCK_REFERENCE_PATTERN = /\(\(([A-Za-z0-9_-]{8,})\)\)/g;
const TERMINAL_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

export type OutlinerLinkKind = "block" | "goto" | "page";

export interface OutlinerLinkTarget {
  kind: OutlinerLinkKind;
  value: string;
}

interface LinkSpan {
  start: number;
  end: number;
  uri: string;
}

interface TextRange {
  start: number;
  end: number;
}

export function outlinerLinkUri(kind: OutlinerLinkKind, value: string): string {
  const normalized = value.trim();
  if (TERMINAL_CONTROL_PATTERN.test(normalized)) {
    throw new Error("Outliner link target contains terminal control characters");
  }
  if (!normalized) throw new Error("Outliner link target cannot be empty");
  if (kind === "block" && !BLOCK_ID_PATTERN.test(normalized)) {
    throw new Error(`Invalid outliner block target: ${normalized}`);
  }
  return `${OUTLINER_SCHEME}//${kind}/${encodeURIComponent(normalized)}`;
}

export function parseOutlinerLinkUri(uri: string): OutlinerLinkTarget {
  if (!URL.canParse(uri)) {
    throw new Error("Invalid outliner link URI");
  }
  const parsed = new URL(uri);
  if (
    parsed.protocol !== OUTLINER_SCHEME ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("Invalid outliner link URI");
  }
  const kind = parsed.hostname;
  if (kind !== "block" && kind !== "goto" && kind !== "page") {
    throw new Error(`Unsupported outliner link kind: ${parsed.hostname}`);
  }
  const encoded = parsed.pathname.startsWith("/") ? parsed.pathname.slice(1) : parsed.pathname;
  let value: string;
  try {
    value = decodeURIComponent(encoded);
  } catch {
    throw new Error("Invalid outliner link encoding");
  }
  if (
    !value ||
    TERMINAL_CONTROL_PATTERN.test(value) ||
    (kind === "block" && !BLOCK_ID_PATTERN.test(value))
  ) {
    throw new Error(`Invalid outliner ${kind} target`);
  }
  return { kind, value };
}

function protectedMarkdownRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  let activeFence: { marker: string; length: number } | null = null;
  let lineStart = 0;
  for (const line of text.split("\n")) {
    const lineEnd = lineStart + line.length;
    if (activeFence) {
      ranges.push({ start: lineStart, end: lineEnd });
      const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)?.[1];
      if (
        closing &&
        closing[0] === activeFence.marker &&
        closing.length >= activeFence.length
      ) {
        activeFence = null;
      }
    } else {
      const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (opening) {
        ranges.push({ start: lineStart, end: lineEnd });
        activeFence = { marker: opening[0], length: opening.length };
      } else if (/^( {4}|\t)/.test(line)) {
        ranges.push({ start: lineStart, end: lineEnd });
      }
    }
    lineStart = lineEnd + 1;
  }
  for (const pattern of [/(`+)[^\n]*?\1/g, /!?\[[^\]\n]*\]\([^)\n]*\)/g]) {
    for (const match of text.matchAll(pattern)) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  return ranges;
}

function overlaps(left: TextRange, right: TextRange): boolean {
  return left.start < right.end && right.start < left.end;
}

function genericLinkSpans(
  text: string,
  canLinkBlock: (blockId: string) => boolean,
): LinkSpan[] {
  const spans: LinkSpan[] = [];
  for (const match of text.matchAll(WORK_ID_PATTERN)) {
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      uri: outlinerLinkUri("goto", match[0]),
    });
  }
  for (const match of text.matchAll(BLOCK_ID_TOKEN_PATTERN)) {
    if (!canLinkBlock(match[0])) continue;
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      uri: outlinerLinkUri("block", match[0]),
    });
  }
  return spans;
}

function selectLinkSpans(
  text: string,
  exactSpans: readonly LinkSpan[],
  canLinkBlock: (blockId: string) => boolean,
): LinkSpan[] {
  const protectedRanges = protectedMarkdownRanges(text);
  const selected: LinkSpan[] = [];
  for (const span of [...exactSpans, ...genericLinkSpans(text, canLinkBlock)]) {
    if (protectedRanges.some((range) => overlaps(span, range))) continue;
    if (selected.some((existing) => overlaps(span, existing))) continue;
    selected.push(span);
  }
  return selected.sort((left, right) => left.start - right.start);
}

function renderLinkSpans(
  text: string,
  spans: readonly LinkSpan[],
  renderLink: (visible: string, uri: string) => string,
): string {
  if (spans.length === 0) return text;
  let result = "";
  let cursor = 0;
  for (const span of spans) {
    result += text.slice(cursor, span.start);
    result += renderLink(text.slice(span.start, span.end), span.uri);
    cursor = span.end;
  }
  return result + text.slice(cursor);
}

function markdownLink(visible: string, uri: string): string {
  const label = visible.replaceAll("\\", "\\\\").replaceAll("]", "\\]");
  return `[${label}](${uri})`;
}

function resolvedReferenceSpans(rawText: string, resolvedText: string): LinkSpan[] {
  const spans: LinkSpan[] = [];
  let rawCursor = 0;
  let resolvedCursor = 0;
  for (const match of rawText.matchAll(RAW_BLOCK_REFERENCE_PATTERN)) {
    resolvedCursor += match.index - rawCursor;
    if (!resolvedText.startsWith("((", resolvedCursor)) return [];
    const end = resolvedText.indexOf("))", resolvedCursor + 2);
    if (end < 0) return [];
    spans.push({
      start: resolvedCursor,
      end: end + 2,
      uri: outlinerLinkUri("block", match[1]),
    });
    rawCursor = match.index + match[0].length;
    resolvedCursor = end + 2;
  }
  return spans;
}

export function linkOutlinerMarkdown(resolvedText: string, rawText: string): string {
  const spans = selectLinkSpans(
    resolvedText,
    resolvedReferenceSpans(rawText, resolvedText),
    () => true,
  );
  return renderLinkSpans(resolvedText, spans, markdownLink);
}

export interface OutlinerTextLinker {
  link(text: string): string;
}

export function createOutlinerTextLinker(
  rawText: string,
  lookup: (blockId: string) => Block | null,
): OutlinerTextLinker {
  const references = blockReferenceIds(rawText).map((blockId) => {
    const target = lookup(blockId);
    return {
      visible: target ? `((${blockDisplayTitle(target)}))` : `((${blockId}))`,
      uri: target ? outlinerLinkUri("block", blockId) : null,
    };
  });
  const consumedReferences = new Set<number>();
  return {
    link(text: string): string {
      const exactSpans: LinkSpan[] = [];
      const referenceRanges: TextRange[] = [];
      for (let index = 0; index < references.length; index += 1) {
        if (consumedReferences.has(index)) continue;
        const reference = references[index];
        let start = text.indexOf(reference.visible);
        while (
          start >= 0 &&
          referenceRanges.some((range) =>
            range.start < start + reference.visible.length && start < range.end
          )
        ) {
          start = text.indexOf(reference.visible, start + 1);
        }
        if (start < 0) continue;
        const range = { start, end: start + reference.visible.length };
        referenceRanges.push(range);
        consumedReferences.add(index);
        if (reference.uri) exactSpans.push({ ...range, uri: reference.uri });
      }
      const spans = selectLinkSpans(text, exactSpans, (blockId) => lookup(blockId) !== null);
      return renderLinkSpans(text, spans, hyperlink);
    },
  };
}
