import type { PageAddressMatch } from "./types";
import { workIdReferences } from "./work-ids";

export type CompletionTargetKind = "page" | "block" | "file";

export interface CompletionTarget {
  kind: CompletionTargetKind;
  start: number;
  end: number;
  query: string;
}

const TARGET_SYNTAX: ReadonlyArray<{
  kind: CompletionTargetKind;
  opening: string;
  closing: string;
}> = [
  { kind: "page", opening: "[[", closing: "]]" },
  { kind: "block", opening: "((", closing: "))" },
  { kind: "file", opening: "[file::", closing: "]" },
];
export interface PageAddressCompletion {
  label: string;
  insertion: string;
}

export function pageCompletionLookupQuery(
  authoredQuery: string,
  workIdPrefix: string | null,
): string {
  const separator = authoredQuery.indexOf("|");
  if (separator >= 0) return authoredQuery.slice(0, separator).trim();
  const workIds = workIdPrefix ? workIdReferences(authoredQuery, workIdPrefix) : [];
  return workIds.length === 1 ? workIds[0]!.workId : authoredQuery.trim();
}

export function pageAddressCompletion(
  address: PageAddressMatch,
  authoredQuery: string,
  workIdPrefix: string | null,
): PageAddressCompletion {
  const title = address.title.trim();
  const normalizedTitle = title.toLocaleLowerCase();
  const normalizedAddress = address.address.toLocaleLowerCase();
  const label = address.kind === "work-id" &&
      (
        normalizedTitle === normalizedAddress ||
        normalizedTitle.startsWith(`${normalizedAddress} `)
      )
    ? title
    : `${address.address} — ${title}`;
  if (address.kind !== "work-id") {
    return { label, insertion: `[[${address.address}]]` };
  }

  const separator = authoredQuery.indexOf("|");
  const workIds = workIdPrefix ? workIdReferences(authoredQuery, workIdPrefix) : [];
  const authoredLabel = separator >= 0
    ? authoredQuery.slice(separator + 1).trim()
    : workIds.length === 1 &&
        workIds[0]!.workId === address.address &&
        authoredQuery.trim() !== address.address
      ? authoredQuery.trim()
      : title;
  const safeLabel = authoredLabel && !/[\]\r\n]/.test(authoredLabel)
    ? authoredLabel
    : null;
  return {
    label,
    insertion: safeLabel
      ? `[[${address.address}|${safeLabel}]]`
      : `[[${address.address}]]`,
  };
}


export function completionTargetAtCursor(
  line: string,
  column: number,
): CompletionTarget | null {
  const end = Math.max(0, Math.min(column, line.length));
  const beforeCursor = line.slice(0, end);
  let target: CompletionTarget | null = null;

  for (const syntax of TARGET_SYNTAX) {
    let searchFrom = beforeCursor.length;
    let closedDepth = 0;
    let start = -1;

    while (searchFrom > 0) {
      const opening = beforeCursor.lastIndexOf(syntax.opening, searchFrom - 1);
      const closing = beforeCursor.lastIndexOf(syntax.closing, searchFrom - 1);
      if (opening < 0) break;
      if (closing > opening) {
        closedDepth += 1;
        searchFrom = closing;
      } else if (closedDepth > 0) {
        closedDepth -= 1;
        searchFrom = opening;
      } else {
        start = opening;
        break;
      }
    }

    if (start < 0) continue;
    if (!target || start > target.start) {
      target = {
        kind: syntax.kind,
        start,
        end,
        query: beforeCursor.slice(start + syntax.opening.length),
      };
    }
  }

  return target;
}

export interface CompletionWindow {
  start: number;
  end: number;
}

export function completionWindow(
  itemCount: number,
  selectedIndex: number,
  capacity: number,
): CompletionWindow {
  const visibleCount = Math.max(0, Math.min(itemCount, capacity));
  if (visibleCount === 0) {
    return { start: 0, end: 0 };
  }

  const clampedSelectedIndex = Math.max(
    0,
    Math.min(selectedIndex, itemCount - 1),
  );
  const centeredStartIndex =
    clampedSelectedIndex - Math.floor(visibleCount / 2);
  const start = Math.max(
    0,
    Math.min(centeredStartIndex, itemCount - visibleCount),
  );

  return { start, end: start + visibleCount };
}
