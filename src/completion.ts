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
