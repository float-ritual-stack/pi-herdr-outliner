import { sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { TreePrimaryPointer } from "./tree-mouse";

export interface PreviewContentRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Point = { column: number; row: number };
type Pointer = Pick<TreePrimaryPointer, "phase" | "column" | "row">;
type Selection = {
  rect: PreviewContentRect;
  anchor: Point;
  head: Point;
  lines: readonly string[];
};

function sameRect(a: PreviewContentRect, b: PreviewContentRect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function clamp(point: Point, rect: PreviewContentRect): Point {
  if (point.row < rect.y) return {row: rect.y, column: rect.x};
  if (point.row >= rect.y + rect.height) return {row: rect.y + rect.height - 1, column: rect.x + rect.width};
  return {row: point.row, column: Math.max(rect.x, Math.min(rect.x + rect.width, point.column))};
}

function range(selection: Selection, row: number): [number, number] | null {
  const {anchor, head, rect} = selection;
  const forward = anchor.row < head.row || (anchor.row === head.row && anchor.column <= head.column);
  const [start, end] = forward ? [anchor, head] : [head, anchor];
  if (row < start.row || row > end.row) return null;
  const left = row === start.row ? start.column : rect.x;
  const right = row === end.row ? end.column : rect.x + rect.width;
  return right > left ? [left, right] : null;
}

function graphemeRange(selection: Selection, row: number, line: string): [number, number] | null {
  const columns = range(selection, row);
  if (!columns) return null;
  const edge = (column: number, strict: boolean) => visibleWidth(sliceByColumn(line, 0, column, strict));
  // Expand partial glyphs inside the rectangle, but never borrow a neighboring pane's glyph.
  const left = edge(columns[0], true);
  const right = edge(columns[1], false);
  const boundedLeft = left >= selection.rect.x ? left : edge(columns[0], false);
  const boundedRight = right <= selection.rect.x + selection.rect.width ? right : edge(columns[1], true);
  return boundedRight > boundedLeft ? [boundedLeft, boundedRight] : null;
}

/** Select rendered columns within one Preview; the caller owns clipboard delivery. */
export class PreviewSelection {
  private claimed = false;
  private selection: Selection | null = null;

  // Keep ownership until mouseup, even when a redraw cancels the selected content.
  clear(): void {
    this.selection = null;
  }

  /** Lines are the full frame, with one entry per actual terminal row. End columns are exclusive. */
  pointer(event: Pointer, rect: PreviewContentRect, visibleAnsiLines: readonly string[]): {consumed: boolean; copy?: string} {
    if (event.phase === "down") {
      this.clear();
      this.claimed = rect.width > 0 && rect.height > 0 && event.column >= rect.x &&
        event.column < rect.x + rect.width && event.row >= rect.y && event.row < rect.y + rect.height;
      if (this.claimed) this.selection = {rect: {...rect}, anchor: {...event}, head: {...event}, lines: [...visibleAnsiLines]};
      return {consumed: this.claimed};
    }
    if (!this.claimed) return {consumed: false};
    if (this.selection && !sameRect(this.selection.rect, rect)) this.clear();
    if (this.selection) this.selection.head = clamp(event, this.selection.rect);
    if (event.phase !== "up") return {consumed: true};
    this.claimed = false;
    if (!this.selection) return {consumed: true};
    const {anchor, head, lines} = this.selection;
    if (anchor.row === head.row && anchor.column === head.column) return {consumed: true};
    const selected: string[] = [];
    for (let row = Math.min(anchor.row, head.row); row <= Math.max(anchor.row, head.row); row++) {
      const columns = graphemeRange(this.selection, row, lines[row] ?? "");
      selected.push(columns ? stripTerminalSequences(sliceByColumn(lines[row] ?? "", columns[0], columns[1] - columns[0], true)).trimEnd() : "");
    }
    const copy = selected.join("\n");
    return copy.trim() ? {consumed: true, copy} : {consumed: true};
  }

  /** Reverse only selected content; surrounding frame columns retain their existing ANSI. */
  highlight(frameLines: readonly string[], rect: PreviewContentRect): string[] {
    const selection = this.selection;
    if (!selection || !sameRect(selection.rect, rect)) return [...frameLines];
    return frameLines.map((line, row) => {
      const columns = graphemeRange(selection, row, line);
      if (!columns) return line;
      const [left, right] = columns;
      const middle = stripTerminalSequences(sliceByColumn(line, left, right - left, true));
      if (!middle) return line;
      return `${sliceByColumn(line, 0, left, true)}\x1b[7m${middle}\x1b[27m${sliceByColumn(line, right, Number.MAX_SAFE_INTEGER, true)}`;
    });
  }
}
