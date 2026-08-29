const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });
const MAX_HISTORY_ENTRIES = 100;

type HistoryGroup = "typing" | "backspace" | "delete" | null;

export interface TextBufferPoint {
  row: number;
  column: number;
}

export interface TextBufferRange {
  start: TextBufferPoint;
  end: TextBufferPoint;
}

interface TextBufferSnapshot {
  lines: string[];
  row: number;
  column: number;
  selectionAnchor: TextBufferPoint | null;
}

function comparePoints(left: TextBufferPoint, right: TextBufferPoint): number {
  return left.row === right.row ? left.column - right.column : left.row - right.row;
}

function previousGraphemeStart(line: string, column: number): number {
  if (column <= 0) return 0;
  return graphemeSegmenter.segment(line).containing(Math.min(column - 1, line.length - 1))?.index ?? 0;
}

function nextGraphemeEnd(line: string, column: number): number {
  if (column >= line.length) return line.length;
  const grapheme = graphemeSegmenter.segment(line).containing(Math.max(0, column));
  return grapheme ? grapheme.index + grapheme.segment.length : line.length;
}

function clampToGraphemeStart(line: string, column: number): number {
  const clamped = Math.max(0, Math.min(column, line.length));
  if (clamped === line.length) return clamped;
  return graphemeSegmenter.segment(line).containing(clamped)?.index ?? clamped;
}

function isSingleGrapheme(value: string): boolean {
  if (!value) return false;
  const segments = graphemeSegmenter.segment(value)[Symbol.iterator]();
  const first = segments.next();
  return !first.done && segments.next().done === true;
}

function firstWordStart(line: string): number | null {
  for (const word of wordSegmenter.segment(line)) {
    if (word.isWordLike) return word.index;
  }
  return null;
}

function lastWordStart(line: string): number | null {
  let start: number | null = null;
  for (const word of wordSegmenter.segment(line)) {
    if (word.isWordLike) start = word.index;
  }
  return start;
}

function wordStartBefore(line: string, column: number): number | null {
  let previous: number | null = null;
  for (const word of wordSegmenter.segment(line)) {
    if (!word.isWordLike) continue;
    const end = word.index + word.segment.length;
    if (word.index < column && end >= column) return word.index;
    if (word.index >= column) break;
    previous = word.index;
  }
  return previous;
}

function wordStartAfter(line: string, column: number): number | null {
  for (const word of wordSegmenter.segment(line)) {
    if (word.isWordLike && word.index > column) return word.index;
  }
  return null;
}

export class TextBuffer {
  readonly lines: string[];
  row = 0;
  column = 0;
  #selectionAnchor: TextBufferPoint | null = null;
  readonly #undoHistory: TextBufferSnapshot[] = [];
  readonly #redoHistory: TextBufferSnapshot[] = [];
  #historyGroup: HistoryGroup = null;

  constructor(text = "") {
    this.lines = text.split(/\r?\n/);
  }

  get text(): string {
    return this.lines.join("\n");
  }

  get selectionRange(): TextBufferRange | null {
    if (!this.#selectionAnchor) return null;
    const cursor = this.cursorPoint();
    const order = comparePoints(this.#selectionAnchor, cursor);
    if (order === 0) return null;
    return order < 0
      ? { start: { ...this.#selectionAnchor }, end: cursor }
      : { start: cursor, end: { ...this.#selectionAnchor } };
  }

  get hasSelection(): boolean {
    const anchor = this.#selectionAnchor;
    return anchor !== null && (anchor.row !== this.row || anchor.column !== this.column);
  }

  clearSelection(): void {
    this.clearSelectionAnchor();
    this.breakHistoryGroup();
  }

  selectAll(): void {
    this.breakHistoryGroup();
    this.#selectionAnchor = { row: 0, column: 0 };
    this.row = this.lines.length - 1;
    this.column = this.lines[this.row].length;
    if (!this.hasSelection) this.clearSelectionAnchor();
  }

  insert(value: string): void {
    const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (!normalized) return;
    const selection = this.selectionRange;
    const historyGroup = !selection && !normalized.includes("\n") && isSingleGrapheme(normalized)
      ? "typing"
      : null;
    this.recordEdit(historyGroup);
    if (selection) this.deleteRange(selection);

    const parts = normalized.split("\n");
    const line = this.lines[this.row];
    const before = line.slice(0, this.column);
    const after = line.slice(this.column);

    if (parts.length === 1) {
      this.lines[this.row] = before + normalized + after;
      this.column += normalized.length;
      return;
    }

    const lastPart = parts[parts.length - 1];
    const replacement = [before + parts[0], ...parts.slice(1, -1), lastPart + after];
    this.lines.splice(this.row, 1, ...replacement);
    this.row += replacement.length - 1;
    this.column = lastPart.length;
  }

  replaceCurrentLine(start: number, end: number, value: string): void {
    const line = this.lines[this.row];
    const safeStart = Math.max(0, Math.min(start, line.length));
    const safeEnd = Math.max(safeStart, Math.min(end, line.length));
    this.recordEdit(null);
    this.clearSelectionAnchor();
    this.lines[this.row] = line.slice(0, safeStart) + value + line.slice(safeEnd);
    this.column = safeStart + value.length;
  }

  replaceLine(row: number, value: string): void {
    if (!Number.isInteger(row) || row < 0 || row >= this.lines.length) {
      throw new Error(`Text buffer line is unavailable: ${row + 1}`);
    }
    if (value.includes("\n") || value.includes("\r")) {
      throw new Error("Text buffer line replacement cannot contain a newline");
    }
    if (this.lines[row] === value) return;
    this.recordEdit(null);
    this.clearSelectionAnchor();
    this.lines[row] = value;
    if (row === this.row) this.column = Math.min(this.column, value.length);
  }

  newline(): void {
    this.insert("\n");
  }

  backspace(): void {
    if (this.deleteSelection()) return;
    if (this.column > 0) {
      this.recordEdit("backspace");
      const line = this.lines[this.row];
      const start = previousGraphemeStart(line, this.column);
      this.lines[this.row] = line.slice(0, start) + line.slice(this.column);
      this.column = start;
      return;
    }
    if (this.row === 0) return;

    this.recordEdit(null);
    const previousLength = this.lines[this.row - 1].length;
    this.lines[this.row - 1] += this.lines[this.row];
    this.lines.splice(this.row, 1);
    this.row -= 1;
    this.column = previousLength;
  }

  deleteForward(): void {
    if (this.deleteSelection()) return;
    const line = this.lines[this.row];
    if (this.column < line.length) {
      this.recordEdit("delete");
      const end = nextGraphemeEnd(line, this.column);
      this.lines[this.row] = line.slice(0, this.column) + line.slice(end);
      return;
    }
    if (this.row >= this.lines.length - 1) return;

    this.recordEdit(null);
    this.lines[this.row] += this.lines[this.row + 1];
    this.lines.splice(this.row + 1, 1);
  }

  deleteSelection(): boolean {
    const range = this.selectionRange;
    if (!range) return false;
    this.recordEdit(null);
    this.deleteRange(range);
    return true;
  }

  undo(): boolean {
    const snapshot = this.#undoHistory.pop();
    if (!snapshot) return false;
    this.pushHistory(this.#redoHistory, this.snapshot());
    this.restore(snapshot);
    this.breakHistoryGroup();
    return true;
  }

  redo(): boolean {
    const snapshot = this.#redoHistory.pop();
    if (!snapshot) return false;
    this.pushHistory(this.#undoHistory, this.snapshot());
    this.restore(snapshot);
    this.breakHistoryGroup();
    return true;
  }

  moveLeft(extend = false): void {
    if (this.column > 0) {
      this.moveTo(this.row, previousGraphemeStart(this.lines[this.row], this.column), extend);
    } else if (this.row > 0) {
      this.moveTo(this.row - 1, this.lines[this.row - 1].length, extend);
    } else {
      this.finishMotion(extend);
    }
  }

  moveRight(extend = false): void {
    if (this.column < this.lines[this.row].length) {
      this.moveTo(this.row, nextGraphemeEnd(this.lines[this.row], this.column), extend);
    } else if (this.row < this.lines.length - 1) {
      this.moveTo(this.row + 1, 0, extend);
    } else {
      this.finishMotion(extend);
    }
  }

  moveUp(extend = false): void {
    if (this.row === 0) {
      this.finishMotion(extend);
      return;
    }
    const row = this.row - 1;
    this.moveTo(row, clampToGraphemeStart(this.lines[row], this.column), extend);
  }

  moveDown(extend = false): void {
    if (this.row >= this.lines.length - 1) {
      this.finishMotion(extend);
      return;
    }
    const row = this.row + 1;
    this.moveTo(row, clampToGraphemeStart(this.lines[row], this.column), extend);
  }

  moveHome(extend = false): void {
    this.moveTo(this.row, 0, extend);
  }

  moveEnd(extend = false): void {
    this.moveTo(this.row, this.lines[this.row].length, extend);
  }

  moveWordLeft(extend = false): void {
    const wordStart = wordStartBefore(this.lines[this.row], this.column);
    if (wordStart !== null) {
      this.moveTo(this.row, wordStart, extend);
      return;
    }
    for (let row = this.row - 1; row >= 0; row -= 1) {
      const column = lastWordStart(this.lines[row]);
      if (column !== null) {
        this.moveTo(row, column, extend);
        return;
      }
    }
    this.moveTo(0, 0, extend);
  }

  moveWordRight(extend = false): void {
    const wordStart = wordStartAfter(this.lines[this.row], this.column);
    if (wordStart !== null) {
      this.moveTo(this.row, wordStart, extend);
      return;
    }
    for (let row = this.row + 1; row < this.lines.length; row += 1) {
      const column = firstWordStart(this.lines[row]);
      if (column !== null) {
        this.moveTo(row, column, extend);
        return;
      }
    }
    const row = this.lines.length - 1;
    this.moveTo(row, this.lines[row].length, extend);
  }

  private snapshot(): TextBufferSnapshot {
    return {
      lines: [...this.lines],
      row: this.row,
      column: this.column,
      selectionAnchor: this.#selectionAnchor ? { ...this.#selectionAnchor } : null,
    };
  }

  private restore(snapshot: TextBufferSnapshot): void {
    this.lines.splice(0, this.lines.length, ...snapshot.lines);
    this.row = snapshot.row;
    this.column = snapshot.column;
    this.#selectionAnchor = snapshot.selectionAnchor ? { ...snapshot.selectionAnchor } : null;
  }

  private recordEdit(group: HistoryGroup): void {
    const coalesced = group !== null && group === this.#historyGroup && this.#redoHistory.length === 0;
    if (!coalesced) this.pushHistory(this.#undoHistory, this.snapshot());
    this.#redoHistory.length = 0;
    this.#historyGroup = group;
  }

  private pushHistory(history: TextBufferSnapshot[], snapshot: TextBufferSnapshot): void {
    history.push(snapshot);
    if (history.length > MAX_HISTORY_ENTRIES) history.shift();
  }

  private breakHistoryGroup(): void {
    this.#historyGroup = null;
  }

  private clearSelectionAnchor(): void {
    this.#selectionAnchor = null;
  }

  private deleteRange(range: TextBufferRange): void {
    const before = this.lines[range.start.row].slice(0, range.start.column);
    const after = this.lines[range.end.row].slice(range.end.column);
    this.lines.splice(
      range.start.row,
      range.end.row - range.start.row + 1,
      before + after,
    );
    this.row = range.start.row;
    this.column = range.start.column;
    this.clearSelectionAnchor();
  }

  private cursorPoint(): TextBufferPoint {
    return { row: this.row, column: this.column };
  }

  private moveTo(row: number, column: number, extend: boolean): void {
    this.breakHistoryGroup();
    if (extend && !this.#selectionAnchor) this.#selectionAnchor = this.cursorPoint();
    if (!extend) this.clearSelectionAnchor();
    this.row = row;
    this.column = column;
    if (!this.hasSelection) this.clearSelectionAnchor();
  }

  private finishMotion(extend: boolean): void {
    this.breakHistoryGroup();
    if (!extend) this.clearSelectionAnchor();
  }
}
