export class TextBuffer {
  readonly lines: string[];
  row = 0;
  column = 0;

  constructor(text = "") {
    this.lines = text.split(/\r?\n/);
  }

  get text(): string {
    return this.lines.join("\n");
  }

  insert(value: string): void {
    const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
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
    this.lines[this.row] = line.slice(0, safeStart) + value + line.slice(safeEnd);
    this.column = safeStart + value.length;
  }

  newline(): void {
    this.insert("\n");
  }

  backspace(): void {
    if (this.column > 0) {
      const line = this.lines[this.row];
      this.lines[this.row] = line.slice(0, this.column - 1) + line.slice(this.column);
      this.column -= 1;
      return;
    }
    if (this.row === 0) return;

    const previousLength = this.lines[this.row - 1].length;
    this.lines[this.row - 1] += this.lines[this.row];
    this.lines.splice(this.row, 1);
    this.row -= 1;
    this.column = previousLength;
  }

  deleteForward(): void {
    const line = this.lines[this.row];
    if (this.column < line.length) {
      this.lines[this.row] = line.slice(0, this.column) + line.slice(this.column + 1);
      return;
    }
    if (this.row >= this.lines.length - 1) return;
    this.lines[this.row] += this.lines[this.row + 1];
    this.lines.splice(this.row + 1, 1);
  }

  moveLeft(): void {
    if (this.column > 0) {
      this.column -= 1;
    } else if (this.row > 0) {
      this.row -= 1;
      this.column = this.lines[this.row].length;
    }
  }

  moveRight(): void {
    if (this.column < this.lines[this.row].length) {
      this.column += 1;
    } else if (this.row < this.lines.length - 1) {
      this.row += 1;
      this.column = 0;
    }
  }

  moveUp(): void {
    if (this.row === 0) return;
    this.row -= 1;
    this.column = Math.min(this.column, this.lines[this.row].length);
  }

  moveDown(): void {
    if (this.row >= this.lines.length - 1) return;
    this.row += 1;
    this.column = Math.min(this.column, this.lines[this.row].length);
  }

  moveHome(): void {
    this.column = 0;
  }

  moveEnd(): void {
    this.column = this.lines[this.row].length;
  }
}
