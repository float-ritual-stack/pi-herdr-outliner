import {
  Box,
  Markdown,
  type Component,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";
import { Marked } from "marked";
import {
  DetailCalloutDocument,
  type DetailCalloutRegion,
} from "./detail-callouts";
import {
  DEFAULT_DETAIL_CALLOUT_THEME,
  type DetailCalloutTheme,
} from "./detail-callout-theme";
import type {
  PreviewRegionState,
  PreviewSourceSpan,
} from "./detail-preview-regions";

export interface MarkdownLineRange {
  startLine: number;
  endLine: number;
}

export type MarkdownSourceSpan = PreviewSourceSpan;

export interface SourceSpannedMarkdownSegment {
  text: string;
  span: MarkdownSourceSpan;
  decorated: boolean;
}

export interface SourceSpannedMarkdownRowRender {
  lines: string[];
  sourceLineRow: number;
}

const markdownParser = new Marked();

interface RenderSegment extends SourceSpannedMarkdownSegment {
  component: Component;
}

interface MarkdownRenderBlock {
  text: string;
  type: string;
  startLine: number;
  endLine: number;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function normalizeMarkdownSource(text: string): {
  text: string;
  originalOffsets: number[];
} {
  let normalized = "";
  const originalOffsets = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\r") {
      normalized += "\n";
      if (text[index + 1] === "\n") index += 1;
    } else {
      normalized += text[index]!;
    }
    originalOffsets.push(index + 1);
  }
  return { text: normalized, originalOffsets };
}

function markdownTokenRange(
  source: string,
  raw: string,
  cursor: number,
  type: string,
): { start: number; end: number } {
  const start = source.indexOf(raw, cursor);
  if (start >= 0) return { start, end: start + raw.length };
  const remainingLength = source.length - cursor;
  if (
    raw.length === remainingLength + 1 &&
    raw.endsWith("\n") &&
    source.startsWith(raw.slice(0, -1), cursor)
  ) {
    return { start: cursor, end: source.length };
  }
  throw new Error(`Markdown token source span could not be recovered: ${type}`);
}

function lineAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle]! <= offset) low = middle;
    else high = middle;
  }
  return low;
}


function markdownRenderBlocks(text: string): MarkdownRenderBlock[] {
  if (!text) return [];
  const starts = lineStarts(text);
  const normalized = normalizeMarkdownSource(text);
  const tokens = markdownParser.lexer(normalized.text);
  const blocks: MarkdownRenderBlock[] = [];
  let normalizedCursor = 0;
  for (const token of tokens) {
    const range = markdownTokenRange(
      normalized.text,
      token.raw,
      normalizedCursor,
      token.type,
    );
    const normalizedStart = range.start;
    const normalizedEnd = range.end;
    const start = normalized.originalOffsets[normalizedStart]!;
    const end = normalized.originalOffsets[normalizedEnd]!;
    const span = sourceSpan(starts, start, end);
    const previous = blocks.at(-1);
    if (token.type === "space" && previous) {
      previous.text += text.slice(start, end);
      previous.endLine = span.endLine;
    } else {
      blocks.push({
        text: text.slice(start, end),
        type: token.type,
        startLine: span.startLine,
        endLine: span.endLine,
      });
    }
    normalizedCursor = normalizedEnd;
  }
  return blocks;
}

function markdownBlockRowCount(
  blocks: readonly MarkdownRenderBlock[],
  index: number,
  width: number,
  theme: MarkdownTheme,
): number {
  const block = blocks[index]!;
  const next = blocks[index + 1];
  if (!next) return new Markdown(block.text, 0, 0, theme).render(width).length;
  const nextRows = new Markdown(next.text, 0, 0, theme).render(width).length;
  const combinedRows = new Markdown(
    block.text + next.text,
    0,
    0,
    theme,
  ).render(width).length;
  return Math.max(0, combinedRows - nextRows);
}

function markdownRowsBeforeBlockLine(
  block: MarkdownRenderBlock,
  line: number,
  width: number,
  theme: MarkdownTheme,
): number {
  if (line <= block.startLine) return 0;
  const starts = lineStarts(block.text);
  const localLine = Math.min(line - block.startLine, starts.length - 1);
  const prefix = block.text.slice(0, starts[localLine]!);
  if (block.type !== "code") {
    return new Markdown(prefix, 0, 0, theme).render(width).length;
  }
  const closingCandidate = block.text.trimEnd().split(/\r?\n/).at(-1);
  const closing = closingCandidate &&
      /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.test(closingCandidate)
    ? closingCandidate
    : null;
  if (!closing) return new Markdown(prefix, 0, 0, theme).render(width).length;
  const completed = `${prefix}${prefix.endsWith("\n") ? "" : "\n"}${closing}`;
  return Math.max(0, new Markdown(completed, 0, 0, theme).render(width).length - 1);
}

function markdownRowBeforeSourceLine(
  text: string,
  line: number,
  width: number,
  theme: MarkdownTheme,
): number {
  const blocks = markdownRenderBlocks(text);
  let row = 0;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    if (line < block.startLine) return row;
    if (line <= block.endLine) {
      return row + markdownRowsBeforeBlockLine(block, line, width, theme);
    }
    row += markdownBlockRowCount(blocks, index, width, theme);
  }
  return row;
}

interface SourceRowTraversal {
  nextRow: number;
  targetRow?: number;
}

function sourceSpan(
  starts: readonly number[],
  start: number,
  end: number,
): MarkdownSourceSpan {
  return {
    start,
    end,
    startLine: lineAt(starts, start),
    endLine: lineAt(starts, Math.max(start, end - 1)),
  };
}

function intersectsRange(
  span: MarkdownSourceSpan,
  ranges: readonly MarkdownLineRange[],
): boolean {
  return ranges.some((range) =>
    range.startLine <= span.endLine && range.endLine >= span.startLine
  );
}

function appendSegment(
  segments: SourceSpannedMarkdownSegment[],
  text: string,
  span: MarkdownSourceSpan,
  decorated: boolean,
): void {
  if (!text) return;
  const previous = segments.at(-1);
  if (previous?.decorated === decorated && previous.span.end === span.start) {
    previous.text += text;
    previous.span.end = span.end;
    previous.span.endLine = span.endLine;
    return;
  }
  segments.push({ text, span, decorated });
}

function appendSourceLines(
  segments: SourceSpannedMarkdownSegment[],
  source: string,
  start: number,
  end: number,
  starts: readonly number[],
  ranges: readonly MarkdownLineRange[],
  decorate: boolean,
): void {
  let lineStart = start;
  while (lineStart < end) {
    const newline = source.indexOf("\n", lineStart);
    const lineEnd = newline === -1 || newline >= end ? end : newline + 1;
    const span = sourceSpan(starts, lineStart, lineEnd);
    appendSegment(
      segments,
      source.slice(lineStart, lineEnd),
      span,
      decorate && intersectsRange(span, ranges),
    );
    lineStart = lineEnd;
  }
}

export function sourceSpannedMarkdownSegments(
  text: string,
  ranges: readonly MarkdownLineRange[],
): SourceSpannedMarkdownSegment[] {
  if (!text) return [];
  const starts = lineStarts(text);
  const segments: SourceSpannedMarkdownSegment[] = [];
  const normalized = normalizeMarkdownSource(text);
  const tokens = markdownParser.lexer(normalized.text);
  let normalizedCursor = 0;

  for (const token of tokens) {
    const range = markdownTokenRange(
      normalized.text,
      token.raw,
      normalizedCursor,
      token.type,
    );
    const normalizedTokenStart = range.start;
    const tokenStart = normalized.originalOffsets[normalizedTokenStart]!;
    if (tokenStart > normalized.originalOffsets[normalizedCursor]!) {
      const gapStart = normalized.originalOffsets[normalizedCursor]!;
      const gapSpan = sourceSpan(starts, gapStart, tokenStart);
      appendSegment(
        segments,
        text.slice(gapStart, tokenStart),
        gapSpan,
        intersectsRange(gapSpan, ranges),
      );
    }
    const normalizedTokenEnd = range.end;
    const tokenEnd = normalized.originalOffsets[normalizedTokenEnd]!;
    appendSourceLines(
      segments,
      text,
      tokenStart,
      tokenEnd,
      starts,
      ranges,
      token.type !== "space",
    );
    normalizedCursor = normalizedTokenEnd;
  }

  const cursor = normalized.originalOffsets[normalizedCursor]!;
  if (cursor < text.length) {
    const span = sourceSpan(starts, cursor, text.length);
    appendSegment(
      segments,
      text.slice(cursor),
      span,
      intersectsRange(span, ranges),
    );
  }
  return segments;
}

function decoratedAtLine(
  line: number,
  ranges: readonly MarkdownLineRange[],
  decorationEnabled: boolean,
): boolean {
  return decorationEnabled && ranges.some((range) =>
    range.startLine <= line && range.endLine >= line
  );
}

function calloutBodyLine(
  source: string,
  starts: readonly number[],
  line: number,
  quoteDepth: number,
): string {
  const raw = source.slice(starts[line]!, starts[line + 1] ?? source.length);
  if (quoteDepth === 0) return raw;
  const hasNewline = raw.endsWith("\n");
  let text = hasNewline ? raw.slice(0, -1).replace(/\r$/, "") : raw;
  for (let depth = 0; depth < quoteDepth; depth += 1) {
    const quote = /^[ \t]{0,3}>[ \t]?/.exec(text);
    if (!quote) break;
    text = text.slice(quote[0].length);
  }
  return `${text}${hasNewline ? "\n" : ""}`;
}

function traverseMarkdownLineRange(
  source: string,
  starts: readonly number[],
  startLine: number,
  endLine: number,
  quoteDepth: number,
  targetLine: number,
  renderedRow: number,
  width: number,
  theme: MarkdownTheme,
  ranges: readonly MarkdownLineRange[],
  decorationEnabled: boolean,
  preserveBlankLines = false,
): SourceRowTraversal {
  if (
    preserveBlankLines &&
    endLine > startLine &&
    Array.from(
      { length: endLine - startLine },
      (_, offset) => calloutBodyLine(source, starts, startLine + offset, quoteDepth),
    ).every((line) => line.trim().length === 0)
  ) {
    return {
      nextRow: renderedRow + endLine - startLine,
      targetRow: targetLine >= startLine && targetLine < endLine
        ? renderedRow + targetLine - startLine
        : undefined,
    };
  }

  let row = renderedRow;
  let targetRow: number | undefined;
  let groupStart = startLine;
  while (groupStart < endLine) {
    const decorated = decoratedAtLine(groupStart, ranges, decorationEnabled);
    let groupEnd = groupStart + 1;
    while (
      groupEnd < endLine &&
      decoratedAtLine(groupEnd, ranges, decorationEnabled) === decorated
    ) {
      groupEnd += 1;
    }
    const text = Array.from(
      { length: groupEnd - groupStart },
      (_, offset) => calloutBodyLine(source, starts, groupStart + offset, quoteDepth),
    ).join("");
    if (targetLine >= groupStart && targetLine < groupEnd) {
      targetRow = row +
        markdownRowBeforeSourceLine(text, targetLine - groupStart, width, theme);
    }
    row += new Markdown(text, 0, 0, theme).render(width).length;
    groupStart = groupEnd;
  }
  return { nextRow: row, targetRow };
}

function calloutExpanded(
  region: DetailCalloutRegion,
  previewRegions: Readonly<PreviewRegionState>,
): boolean {
  const live = previewRegions.regions.find((candidate) => candidate.id === region.id) ?? region;
  return live.disclosure?.expanded ?? true;
}

function indexCalloutsByParent(
  callouts: readonly DetailCalloutRegion[],
): ReadonlyMap<string | null, readonly DetailCalloutRegion[]> {
  const childrenByParent = new Map<string | null, DetailCalloutRegion[]>();
  for (const callout of callouts) {
    const children = childrenByParent.get(callout.parentId) ?? [];
    children.push(callout);
    childrenByParent.set(callout.parentId, children);
  }
  for (const children of childrenByParent.values()) {
    children.sort((left, right) => left.headerLine - right.headerLine);
  }
  return childrenByParent;
}

function traverseCalloutRows(
  source: string,
  starts: readonly number[],
  region: DetailCalloutRegion,
  childrenByParent: ReadonlyMap<string | null, readonly DetailCalloutRegion[]>,
  previewRegions: Readonly<PreviewRegionState>,
  targetLine: number,
  renderedRow: number,
  width: number,
  theme: MarkdownTheme,
  ranges: readonly MarkdownLineRange[],
  decorationEnabled: boolean,
): SourceRowTraversal {
  const endLine = region.sourceSpan!.endLine;
  if (!calloutExpanded(region, previewRegions)) {
    return {
      nextRow: renderedRow + 1,
      targetRow: targetLine >= region.headerLine && targetLine <= endLine
        ? renderedRow
        : undefined,
    };
  }

  let row = renderedRow + 1;
  let targetRow = targetLine === region.headerLine ? renderedRow : undefined;
  let cursor = region.headerLine + 1;
  const bodyWidth = Math.max(1, width - 2);
  for (const child of childrenByParent.get(region.id) ?? []) {
    const beforeChild = traverseMarkdownLineRange(
      source,
      starts,
      cursor,
      child.headerLine,
      region.depth,
      targetLine,
      row,
      bodyWidth,
      theme,
      ranges,
      decorationEnabled,
    );
    row = beforeChild.nextRow;
    targetRow ??= beforeChild.targetRow;
    const childRows = traverseCalloutRows(
      source,
      starts,
      child,
      childrenByParent,
      previewRegions,
      targetLine,
      row,
      bodyWidth,
      theme,
      ranges,
      decorationEnabled,
    );
    row = childRows.nextRow;
    targetRow ??= childRows.targetRow;
    cursor = child.sourceSpan!.endLine + 1;
  }
  const tail = traverseMarkdownLineRange(
    source,
    starts,
    cursor,
    endLine + 1,
    region.depth,
    targetLine,
    row,
    bodyWidth,
    theme,
    ranges,
    decorationEnabled,
  );
  return {
    nextRow: tail.nextRow,
    targetRow: targetRow ?? tail.targetRow,
  };
}

export class SourceSpannedMarkdown implements Component {
  private segments: RenderSegment[] = [];
  private calloutDocument: DetailCalloutDocument | null = null;
  private sourceText = "";
  private ranges: readonly MarkdownLineRange[] = [];
  private decorationEnabled = false;
  private callouts: readonly DetailCalloutRegion[] = [];

  constructor(
    private readonly theme: MarkdownTheme,
    private readonly decorate: (text: string) => string,
    private readonly previewRegions?: Readonly<PreviewRegionState>,
    private readonly linksEnabled = false,
    private readonly calloutTheme: DetailCalloutTheme = DEFAULT_DETAIL_CALLOUT_THEME,
  ) {}

  setContent(
    text: string,
    ranges: readonly MarkdownLineRange[],
    decorationEnabled: boolean,
    callouts: readonly DetailCalloutRegion[] = [],
  ): void {
    this.sourceText = text;
    this.ranges = ranges;
    this.decorationEnabled = decorationEnabled && ranges.length > 0;
    this.callouts = callouts;
    if (callouts.length > 0 && this.previewRegions) {
      this.calloutDocument = new DetailCalloutDocument(
        text,
        callouts,
        this.theme,
        this.previewRegions,
        this.linksEnabled,
        this.decorationEnabled
          ? { ranges, decorate: this.decorate }
          : undefined,
        this.calloutTheme,
      );
      this.segments = [];
      return;
    }
    this.calloutDocument = null;
    const sourceSegments = this.decorationEnabled
      ? sourceSpannedMarkdownSegments(text, ranges)
      : text
      ? [{
          text,
          span: sourceSpan(lineStarts(text), 0, text.length),
          decorated: false,
        }]
      : [];
    this.segments = sourceSegments.map((segment) => {
      const markdown = new Markdown(segment.text, 0, 0, this.theme);
      if (!segment.decorated) return { ...segment, component: markdown };
      const box = new Box(0, 0, this.decorate);
      box.addChild(markdown);
      return { ...segment, component: box };
    });
  }

  sourceLineRow(
    width: number,
    sourceLine: number,
    renderedLineCount = this.render(width).length,
  ): number {
    const starts = lineStarts(this.sourceText);
    const targetLine = Math.max(0, Math.min(Math.trunc(sourceLine), starts.length - 1));
    let row = 0;
    if (this.calloutDocument && this.previewRegions) {
      let cursor = 0;
      let hasPreviousRoot = false;
      const childrenByParent = indexCalloutsByParent(this.callouts);
      for (const root of childrenByParent.get(null) ?? []) {
        const beforeRoot = traverseMarkdownLineRange(
          this.sourceText,
          starts,
          cursor,
          root.headerLine,
          0,
          targetLine,
          row,
          width,
          this.theme,
          this.ranges,
          this.decorationEnabled,
          hasPreviousRoot,
        );
        if (beforeRoot.targetRow !== undefined) {
          return Math.min(beforeRoot.targetRow, renderedLineCount);
        }
        row = beforeRoot.nextRow;
        const rootRows = traverseCalloutRows(
          this.sourceText,
          starts,
          root,
          childrenByParent,
          this.previewRegions,
          targetLine,
          row,
          width,
          this.theme,
          this.ranges,
          this.decorationEnabled,
        );
        if (rootRows.targetRow !== undefined) {
          return Math.min(rootRows.targetRow, renderedLineCount);
        }
        row = rootRows.nextRow;
        cursor = root.sourceSpan!.endLine + 1;
        hasPreviousRoot = true;
      }
      const tail = traverseMarkdownLineRange(
        this.sourceText,
        starts,
        cursor,
        starts.length,
        0,
        targetLine,
        row,
        width,
        this.theme,
        this.ranges,
        this.decorationEnabled,
      );
      return Math.min(tail.targetRow ?? tail.nextRow, renderedLineCount);
    }

    for (const segment of this.segments) {
      if (targetLine < segment.span.startLine) break;
      if (targetLine <= segment.span.endLine) {
        return Math.min(
          row + markdownRowBeforeSourceLine(
            segment.text,
            targetLine - segment.span.startLine,
            width,
            this.theme,
          ),
          renderedLineCount,
        );
      }
      row += segment.component.render(width).length;
    }
    return Math.min(row, renderedLineCount);
  }

  renderWithSourceLineRow(
    width: number,
    sourceLine: number,
  ): SourceSpannedMarkdownRowRender {
    const lines = this.render(width);
    return {
      lines,
      sourceLineRow: this.sourceLineRow(width, sourceLine, lines.length),
    };
  }

  render(width: number): string[] {
    return this.calloutDocument?.render(width) ??
      this.segments.flatMap((segment) => segment.component.render(width));
  }

  invalidate(): void {
    this.calloutDocument?.invalidate();
    for (const segment of this.segments) segment.component.invalidate();
  }
}
