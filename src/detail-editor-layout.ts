import { visibleWidth } from "@earendil-works/pi-tui";
import type { TextBufferRange } from "./text-buffer";
import { sanitizeDynamicText } from "./terminal";

const MIN_LINE_NUMBER_WIDTH = 4;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export interface DetailEditorVisualRow {
  logicalRow: number;
  continuation: boolean;
  text: string;
  startColumn: number;
  endColumn: number;
  selectionStartColumn: number | null;
  selectionEndColumn: number | null;
}

export interface DetailEditorLayout {
  rows: DetailEditorVisualRow[];
  cursorRow: number;
  cursorColumn: number;
  lineNumberWidth: number;
  contentWidth: number;
}

export interface DetailEditorPosition {
  row: number;
  column: number;
}

interface Segment {
  text: string;
  width: number;
}

function takeSegment(
  graphemes: Intl.Segments,
  value: string,
  start: number,
  maxWidth: number,
): { end: number; width: number } {
  let index = start;
  let width = 0;
  let lastWhitespaceEnd = -1;
  let lastWhitespaceWidth = 0;

  while (index < value.length) {
    const grapheme = graphemes.containing(index);
    if (!grapheme) break;
    const end = grapheme.index + grapheme.segment.length;
    const characterWidth = visibleWidth(grapheme.segment);
    if (width > 0 && width + characterWidth > maxWidth) break;

    width += characterWidth;
    index = end;
    if (/\s/u.test(grapheme.segment)) {
      lastWhitespaceEnd = index;
      lastWhitespaceWidth = width;
    }
  }

  if (index < value.length && lastWhitespaceEnd > start) {
    return { end: lastWhitespaceEnd, width: lastWhitespaceWidth };
  }
  return { end: index, width };
}

function wrapLine(line: string, maxWidth: number): Segment[] {
  const sanitizedLine = sanitizeDynamicText(line);
  if (!sanitizedLine) return [{ text: "", width: 0 }];
  const graphemes = graphemeSegmenter.segment(sanitizedLine);

  const segments: Segment[] = [];
  let start = 0;
  while (start < sanitizedLine.length) {
    const segment = takeSegment(graphemes, sanitizedLine, start, maxWidth);
    segments.push({
      text: sanitizedLine.slice(start, segment.end),
      width: segment.width,
    });
    start = segment.end;
  }
  return segments;
}

function selectionDisplayColumns(
  line: string,
  logicalRow: number,
  selection: TextBufferRange | null,
): { start: number; end: number } | null {
  if (!selection || logicalRow < selection.start.row || logicalRow > selection.end.row) {
    return null;
  }
  const sourceStart = logicalRow === selection.start.row ? selection.start.column : 0;
  const sourceEnd = logicalRow === selection.end.row ? selection.end.column : line.length;
  if (sourceEnd <= sourceStart) return null;
  return {
    start: visibleWidth(sanitizeDynamicText(line.slice(0, sourceStart))),
    end: visibleWidth(sanitizeDynamicText(line.slice(0, sourceEnd))),
  };
}

export function layoutDetailEditor(
  lines: readonly string[],
  logicalCursorRow: number,
  logicalCursorColumn: number,
  viewportWidth: number,
  selection: TextBufferRange | null = null,
): DetailEditorLayout {
  const lineNumberWidth = Math.max(
    MIN_LINE_NUMBER_WIDTH,
    String(lines.length).length,
  );
  const contentWidth = Math.max(
    1,
    Math.floor(viewportWidth) - lineNumberWidth - 1,
  );
  const wrapWidth = Math.max(1, contentWidth - 1);
  const cursorLogicalRow = Math.max(
    0,
    Math.min(logicalCursorRow, lines.length - 1),
  );
  const cursorLine = lines[cursorLogicalRow] ?? "";
  const cursorSourceColumn = Math.max(
    0,
    Math.min(logicalCursorColumn, cursorLine.length),
  );
  const cursorDisplayColumn = visibleWidth(
    sanitizeDynamicText(cursorLine.slice(0, cursorSourceColumn)),
  );

  const rows: DetailEditorVisualRow[] = [];
  let cursorRow = 0;
  let cursorColumn = 0;

  for (let logicalRow = 0; logicalRow < lines.length; logicalRow += 1) {
    const line = lines[logicalRow] ?? "";
    const segments = wrapLine(line, wrapWidth);
    let startColumn = 0;
    const firstVisualRow = rows.length;
    const selectionColumns = selectionDisplayColumns(line, logicalRow, selection);

    for (
      let segmentIndex = 0;
      segmentIndex < segments.length;
      segmentIndex += 1
    ) {
      const segment = segments[segmentIndex];
      const endColumn = startColumn + segment.width;
      const selectionStartColumn = selectionColumns
        ? Math.max(0, selectionColumns.start - startColumn)
        : null;
      const selectionEndColumn = selectionColumns
        ? Math.min(segment.width, selectionColumns.end - startColumn)
        : null;
      const hasSelection =
        selectionStartColumn !== null &&
        selectionEndColumn !== null &&
        selectionEndColumn > selectionStartColumn;
      rows.push({
        logicalRow,
        continuation: segmentIndex > 0,
        text: segment.text,
        startColumn,
        endColumn,
        selectionStartColumn: hasSelection ? selectionStartColumn : null,
        selectionEndColumn: hasSelection ? selectionEndColumn : null,
      });
      startColumn = endColumn;
    }

    if (logicalRow !== cursorLogicalRow) continue;
    const lastSegment = segments.length - 1;
    let cursorSegment = lastSegment;
    for (let index = 0; index < lastSegment; index += 1) {
      if (cursorDisplayColumn < rows[firstVisualRow + index].endColumn) {
        cursorSegment = index;
        break;
      }
    }
    const cursorVisualRow = firstVisualRow + cursorSegment;
    const row = rows[cursorVisualRow];
    cursorRow = cursorVisualRow;
    cursorColumn = Math.max(
      0,
      Math.min(cursorDisplayColumn - row.startColumn, segmentWidth(row)),
    );
  }

  return { rows, cursorRow, cursorColumn, lineNumberWidth, contentWidth };
}

function segmentWidth(row: DetailEditorVisualRow): number {
  return row.endColumn - row.startColumn;
}

export function detailEditorPositionAtVisualPoint(
  layout: Readonly<DetailEditorLayout>,
  lines: readonly string[],
  visualRow: number,
  contentColumn: number,
): DetailEditorPosition {
  const row = layout.rows[Math.max(0, Math.min(Math.floor(visualRow), layout.rows.length - 1))];
  if (!row) return { row: 0, column: 0 };
  const line = lines[row.logicalRow] ?? "";
  const targetDisplayColumn = Math.min(
    row.endColumn,
    row.startColumn + Math.max(0, Math.floor(contentColumn)),
  );
  let sourceColumn = 0;
  let displayColumn = 0;
  for (const grapheme of graphemeSegmenter.segment(line)) {
    const nextDisplayColumn = displayColumn + visibleWidth(sanitizeDynamicText(grapheme.segment));
    const nextSourceColumn = grapheme.index + grapheme.segment.length;
    if (targetDisplayColumn < nextDisplayColumn) {
      sourceColumn = targetDisplayColumn - displayColumn >=
          (nextDisplayColumn - displayColumn) / 2
        ? nextSourceColumn
        : grapheme.index;
      return { row: row.logicalRow, column: sourceColumn };
    }
    sourceColumn = nextSourceColumn;
    displayColumn = nextDisplayColumn;
  }
  return { row: row.logicalRow, column: line.length };
}

export function detailEditorVisualRowForSourceLine(
  layout: Readonly<DetailEditorLayout>,
  logicalRow: number,
): number | null {
  const index = layout.rows.findIndex((row) => row.logicalRow >= logicalRow);
  return index < 0 ? null : index;
}
