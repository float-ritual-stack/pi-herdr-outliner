import type { VisibleBlock } from "./types";

export type QuickInsertionMode = "add-child" | "add-sibling";

export interface QuickInsertionPoint {
  gap: number;
  depth: number;
}

export function quickInsertionPoint(
  rows: ReadonlyArray<Pick<VisibleBlock, "id" | "depth">>,
  selectedIndex: number,
  mode: QuickInsertionMode,
  isDescendant: (candidateId: string, ancestorId: string) => boolean,
): QuickInsertionPoint | null {
  const selected = rows[selectedIndex];
  if (!selected) return null;
  if (mode === "add-child") {
    return { gap: selectedIndex + 1, depth: selected.depth + 1 };
  }

  let gap = selectedIndex + 1;
  while (gap < rows.length && isDescendant(rows[gap].id, selected.id)) gap += 1;
  return { gap, depth: selected.depth };
}
