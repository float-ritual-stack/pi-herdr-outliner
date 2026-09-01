import { pageAddressReferences } from "./page-addresses";
import { parsePropertyRecords } from "./properties";
import { blockReferenceOccurrences } from "./references";
import { workIdReferences } from "./work-ids";

export interface TextRange {
  start: number;
  end: number;
}

export type OutlinerReferenceOccurrence =
  | {
      kind: "block";
      blockId: string;
      fragmentId?: string;
      start: number;
      end: number;
    }
  | {
      kind: "page";
      address: string;
      normalizedAddress: string;
      start: number;
      end: number;
    }
  | {
      kind: "work-id";
      address: string;
      start: number;
      end: number;
    };

export interface PropertyReferenceOccurrence {
  kind: "property";
  propertyKey: string;
  blockId: string;
  start: number;
  end: number;
}

export function rangesOverlap(left: TextRange, right: TextRange): boolean {
  return left.start < right.end && right.start < left.end;
}

export function protectedMarkdownRanges(text: string): TextRange[] {
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

export function pageSyntaxRanges(text: string): TextRange[] {
  return [...text.matchAll(/\[\[[^\r\n]*?(?:\]\]|(?=\r?$))/gm)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
}

export function propertyReferenceOccurrences(text: string): PropertyReferenceOccurrence[] {
  return parsePropertyRecords(text).map((token) => ({
    kind: "property",
    propertyKey: token.key,
    blockId: token.value,
    start: token.start,
    end: token.end,
  }));
}

export function outlinerReferenceOccurrences(
  text: string,
  workIdPrefix: string | null = null,
): OutlinerReferenceOccurrence[] {
  const candidates: OutlinerReferenceOccurrence[] = blockReferenceOccurrences(text).map(
    (reference) => ({ kind: "block", ...reference }),
  );
  for (const reference of pageAddressReferences(text)) {
    candidates.push({
      kind: "page",
      address: reference.displayAddress,
      normalizedAddress: reference.normalizedAddress,
      start: reference.start,
      end: reference.end,
    });
  }

  const pageRanges = pageSyntaxRanges(text);
  for (const reference of workIdPrefix ? workIdReferences(text, workIdPrefix) : []) {
    const range = { start: reference.start, end: reference.end };
    if (pageRanges.some((pageRange) => rangesOverlap(range, pageRange))) continue;
    candidates.push({
      kind: "work-id",
      address: reference.workId,
      ...range,
    });
  }

  const protectedRanges = [
    ...protectedMarkdownRanges(text),
    ...parsePropertyRecords(text).map((token) => ({ start: token.start, end: token.end })),
  ];
  return candidates
    .filter((candidate) => !protectedRanges.some((range) => rangesOverlap(candidate, range)))
    .sort((left, right) => left.start - right.start);
}
