import { protectedCodeRanges } from "./markdown-code-ranges";
import { pageAddressReferences } from "./page-addresses";
import { parsePropertyRecords } from "./properties";
import type { PropertyRecord } from "./types";
import { blockReferenceEnvelopeRanges, blockReferenceOccurrences } from "./references";
import { ticketKeyReferences } from "./work-ids";

export interface TextRange {
  start: number;
  end: number;
}

export type OutlinerReferenceOccurrence =
  | {
      kind: "block";
      blockId: string;
      fragmentId?: string;
      label?: string;
      start: number;
      end: number;
    }
  | {
      kind: "page";
      address: string;
      normalizedAddress: string;
      label?: string;
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
  const ranges = protectedCodeRanges(text);
  for (const match of text.matchAll(/!?\[[^\]\n]*\]\([^)\n]*\)/g)) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

export function pageSyntaxRanges(text: string): TextRange[] {
  return [...text.matchAll(/\[\[[^\r\n]*?(?:\]\]|(?=\r?$))/gm)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
}

export function propertyReferenceOccurrences(
  text: string,
  propertyRecords: readonly PropertyRecord[] = parsePropertyRecords(text),
): PropertyReferenceOccurrence[] {
  return propertyRecords.map((token) => ({
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
  propertyRecords: readonly PropertyRecord[] = parsePropertyRecords(text),
): OutlinerReferenceOccurrence[] {
  const blockReferences = blockReferenceOccurrences(text);
  const blockReferenceRanges = blockReferenceEnvelopeRanges(text);
  const candidates: OutlinerReferenceOccurrence[] = blockReferences.map(
    (reference) => ({ kind: "block", ...reference }),
  );
  for (const reference of pageAddressReferences(text)) {
    candidates.push({
      kind: "page",
      address: reference.displayAddress,
      normalizedAddress: reference.normalizedAddress,
      ...(reference.label ? { label: reference.label } : {}),
      start: reference.start,
      end: reference.end,
    });
  }

  const pageRanges = pageSyntaxRanges(text);
  for (const reference of ticketKeyReferences(text, workIdPrefix)) {
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
    ...propertyRecords.map((token) => ({ start: token.start, end: token.end })),
  ];
  return candidates
    .filter((candidate) =>
      (candidate.kind === "block" ||
        !blockReferenceRanges.some((range) => rangesOverlap(candidate, range))) &&
      !protectedRanges.some((range) => rangesOverlap(candidate, range))
    )
    .sort((left, right) => left.start - right.start);
}
