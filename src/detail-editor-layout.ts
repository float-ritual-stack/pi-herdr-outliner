import { visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeDynamicText } from "./terminal";

const MIN_LINE_NUMBER_WIDTH = 4;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export interface DetailEditorVisualRow {
  logicalRow: number;
  continuation: boolean;
  text: string;
  startColumn: number;
  endColumn: number;
}

export interface DetailEditorLayout {
  rows: DetailEditorVisualRow[];
  cursorRow: number;
  cursorColumn: number;
  lineNumberWidth: number;
  contentWidth: number;
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

export function layoutDetailEditor(
  lines: readonly string[],
  logicalCursorRow: number,
  logicalCursorColumn: number,
  viewportWidth: number,
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
    const segments = wrapLine(lines[logicalRow] ?? "", wrapWidth);
    let startColumn = 0;
    const firstVisualRow = rows.length;

    for (
      let segmentIndex = 0;
      segmentIndex < segments.length;
      segmentIndex += 1
    ) {
      const segment = segments[segmentIndex];
      const endColumn = startColumn + segment.width;
      rows.push({
        logicalRow,
        continuation: segmentIndex > 0,
        text: segment.text,
        startColumn,
        endColumn,
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
