import { pageAddressReferences } from "./page-addresses";
import { parsePropertyRecords } from "./properties";
import type { PropertyRecord } from "./types";
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
      label?: string;
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

interface ListContainer {
  indent: number;
  contentIndent: number;
  contentOffset: number;
}

function indentationColumns(value: string): number {
  let columns = 0;
  for (const character of value) {
    columns = character === "\t" ? columns + (4 - columns % 4) : columns + 1;
  }
  return columns;
}

function listMarker(line: string): ListContainer | null {
  const match = /^([ \t]*)(?:[-+*]|\d{1,9}[.)])([ \t]+)/.exec(line);
  if (!match) return null;
  const indent = indentationColumns(match[1]);
  return {
    indent,
    contentIndent: indent + indentationColumns(match[0].slice(match[1].length)),
    contentOffset: match[0].length,
  };
}

function fenceMarker(
  line: string,
  contentIndent: number,
  closing = false,
): string | null {
  const match = closing
    ? /^([ \t]*)(`{3,}|~{3,})[ \t]*\r?$/.exec(line)
    : /^([ \t]*)(`{3,}|~{3,})/.exec(line);
  if (!match) return null;
  const relativeIndent = indentationColumns(match[1]) - contentIndent;
  return relativeIndent >= 0 && relativeIndent <= 3 ? match[2] : null;
}

export function protectedMarkdownRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  const listContainers: ListContainer[] = [];
  let activeFence: {
    marker: string;
    length: number;
    contentIndent: number;
  } | null = null;
  let activeIndentedCode = false;
  let canStartIndentedCode = true;
  let lineStart = 0;
  for (const line of text.split("\n")) {
    const lineEnd = lineStart + line.length;
    if (activeFence) {
      ranges.push({ start: lineStart, end: lineEnd });
      const closing = fenceMarker(line, activeFence.contentIndent, true);
      if (
        closing &&
        closing[0] === activeFence.marker &&
        closing.length >= activeFence.length
      ) {
        activeFence = null;
        canStartIndentedCode = true;
      }
    } else if (/^[ \t]*\r?$/.test(line)) {
      canStartIndentedCode = true;
    } else {
      const indent = indentationColumns(/^[ \t]*/.exec(line)?.[0] ?? "");
      while (
        listContainers.length > 0 &&
        indent < listContainers[listContainers.length - 1]!.contentIndent
      ) {
        listContainers.pop();
      }

      const marker = listMarker(line);
      const parent = listContainers[listContainers.length - 1];
      const startsListItem = marker !== null &&
        (parent ? marker.indent - parent.contentIndent <= 3 : marker.indent <= 3);
      let fenceContentIndent = parent?.contentIndent ?? 0;
      let openingLine = line;
      if (startsListItem) {
        listContainers.push(marker);
        activeIndentedCode = false;
        fenceContentIndent = marker.contentIndent;
        openingLine = line.slice(marker.contentOffset);
      }

      const opening = fenceMarker(
        openingLine,
        startsListItem ? 0 : fenceContentIndent,
      );
      if (opening) {
        ranges.push({ start: lineStart, end: lineEnd });
        activeFence = {
          marker: opening[0],
          length: opening.length,
          contentIndent: fenceContentIndent,
        };
        activeIndentedCode = false;
      } else if (!startsListItem) {
        const relativeIndent = indent - fenceContentIndent;
        const indented = relativeIndent >= 4;
        if (indented && (activeIndentedCode || canStartIndentedCode)) {
          ranges.push({ start: lineStart, end: lineEnd });
          activeIndentedCode = true;
        } else if (!indented) {
          activeIndentedCode = false;
        }
      }
      canStartIndentedCode = false;
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
  const blockReferenceRanges = blockReferences.map((reference) => ({
    start: reference.start,
    end: reference.end,
  }));
  const candidates: OutlinerReferenceOccurrence[] = blockReferences.map(
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
