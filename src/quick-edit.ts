export interface QuickInsertionRow {
  readonly depth: number;
}

export type QuickInsertionMode = "add-child" | "add-sibling";

export interface QuickInsertionPoint {
  readonly gap: number;
  readonly depth: number;
}

export function quickInsertionPoint<Row extends QuickInsertionRow>(
  rows: readonly Row[],
  selectedIndex: number,
  mode: QuickInsertionMode,
  isDescendant: (candidate: Row, ancestor: Row) => boolean,
): QuickInsertionPoint | null {
  const selected = rows[selectedIndex];
  if (!selected) return null;
  if (mode === "add-child") {
    return { gap: selectedIndex + 1, depth: selected.depth + 1 };
  }

  let gap = selectedIndex + 1;
  while (gap < rows.length && isDescendant(rows[gap], selected)) {
    gap += 1;
  }
  return { gap, depth: selected.depth };
}
