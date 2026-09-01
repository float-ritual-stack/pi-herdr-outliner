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

export interface SourceSpannedMarkdownRender {
  lines: string[];
  sourceLineRows: number[];
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
    const normalizedStart = normalized.text.indexOf(token.raw, normalizedCursor);
    if (normalizedStart < 0) {
      throw new Error(`Markdown token source span could not be recovered: ${token.type}`);
    }
    const normalizedEnd = normalizedStart + token.raw.length;
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

function markdownBlockRowCounts(
  blocks: readonly MarkdownRenderBlock[],
  width: number,
  theme: MarkdownTheme,
): number[] {
  return blocks.map((block, index) => {
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
  });
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

function assignMarkdownRows(
  rows: Array<number | undefined>,
  text: string,
  sourceLine: number,
  renderedRow: number,
  width: number,
  theme: MarkdownTheme,
): void {
  const blocks = markdownRenderBlocks(text);
  const rowCounts = markdownBlockRowCounts(blocks, width, theme);
  let row = renderedRow;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    for (let line = block.startLine; line <= block.endLine; line += 1) {
      rows[sourceLine + line] ??= row +
        markdownRowsBeforeBlockLine(block, line, width, theme);
    }
    row += rowCounts[index]!;
  }
}

function fillSourceRows(
  rows: Array<number | undefined>,
  renderedLineCount: number,
): number[] {
  let row = 0;
  for (let line = 0; line < rows.length; line += 1) {
    if (rows[line] !== undefined) row = rows[line]!;
    else rows[line] = row;
  }
  return rows.map((value) => Math.min(value ?? 0, renderedLineCount));
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
    const normalizedTokenStart = normalized.text.indexOf(token.raw, normalizedCursor);
    if (normalizedTokenStart < 0) {
      throw new Error(`Markdown token source span could not be recovered: ${token.type}`);
    }
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
    const normalizedTokenEnd = normalizedTokenStart + token.raw.length;
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

function assignMarkdownLineRange(
  rows: Array<number | undefined>,
  source: string,
  starts: readonly number[],
  startLine: number,
  endLine: number,
  quoteDepth: number,
  renderedRow: number,
  width: number,
  theme: MarkdownTheme,
  ranges: readonly MarkdownLineRange[],
  decorationEnabled: boolean,
): number {
  let row = renderedRow;
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
    let text = "";
    for (let line = groupStart; line < groupEnd; line += 1) {
      text += calloutBodyLine(source, starts, line, quoteDepth);
    }
    assignMarkdownRows(rows, text, groupStart, row, width, theme);
    row += new Markdown(text, 0, 0, theme).render(width).length;
    groupStart = groupEnd;
  }
  return row;
}

function calloutExpanded(
  region: DetailCalloutRegion,
  previewRegions: Readonly<PreviewRegionState>,
): boolean {
  const live = previewRegions.regions.find((candidate) => candidate.id === region.id) ?? region;
  return live.disclosure?.expanded ?? true;
}

function assignCalloutRows(
  rows: Array<number | undefined>,
  source: string,
  starts: readonly number[],
  region: DetailCalloutRegion,
  callouts: readonly DetailCalloutRegion[],
  previewRegions: Readonly<PreviewRegionState>,
  renderedRow: number,
  width: number,
  theme: MarkdownTheme,
  ranges: readonly MarkdownLineRange[],
  decorationEnabled: boolean,
): number {
  const endLine = region.sourceSpan!.endLine;
  rows[region.headerLine] ??= renderedRow;
  if (!calloutExpanded(region, previewRegions)) {
    for (let line = region.headerLine + 1; line <= endLine; line += 1) {
      rows[line] ??= renderedRow;
    }
    return renderedRow + 1;
  }

  let row = renderedRow + 1;
  let cursor = region.headerLine + 1;
  const bodyWidth = Math.max(1, width - 2);
  const children = callouts
    .filter((candidate) => candidate.parentId === region.id)
    .sort((left, right) => left.headerLine - right.headerLine);
  for (const child of children) {
    row = assignMarkdownLineRange(
      rows,
      source,
      starts,
      cursor,
      child.headerLine,
      region.depth,
      row,
      bodyWidth,
      theme,
      ranges,
      decorationEnabled,
    );
    row = assignCalloutRows(
      rows,
      source,
      starts,
      child,
      callouts,
      previewRegions,
      row,
      bodyWidth,
      theme,
      ranges,
      decorationEnabled,
    );
    cursor = child.sourceSpan!.endLine + 1;
  }
  return assignMarkdownLineRange(
    rows,
    source,
    starts,
    cursor,
    endLine + 1,
    region.depth,
    row,
    bodyWidth,
    theme,
    ranges,
    decorationEnabled,
  );
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

  renderWithSourceLineRows(width: number): SourceSpannedMarkdownRender {
    const lines = this.render(width);
    const starts = lineStarts(this.sourceText);
    const rows: Array<number | undefined> = Array.from({ length: starts.length });
    let row = 0;
    if (this.calloutDocument && this.previewRegions) {
      let cursor = 0;
      const roots = this.callouts
        .filter((region) => region.parentId === null)
        .sort((left, right) => left.headerLine - right.headerLine);
      for (const root of roots) {
        row = assignMarkdownLineRange(
          rows,
          this.sourceText,
          starts,
          cursor,
          root.headerLine,
          0,
          row,
          width,
          this.theme,
          this.ranges,
          this.decorationEnabled,
        );
        row = assignCalloutRows(
          rows,
          this.sourceText,
          starts,
          root,
          this.callouts,
          this.previewRegions,
          row,
          width,
          this.theme,
          this.ranges,
          this.decorationEnabled,
        );
        cursor = root.sourceSpan!.endLine + 1;
      }
      assignMarkdownLineRange(
        rows,
        this.sourceText,
        starts,
        cursor,
        starts.length,
        0,
        row,
        width,
        this.theme,
        this.ranges,
        this.decorationEnabled,
      );
    } else {
      for (const segment of this.segments) {
        assignMarkdownRows(
          rows,
          segment.text,
          segment.span.startLine,
          row,
          width,
          this.theme,
        );
        row += segment.component.render(width).length;
      }
    }
    return {
      lines,
      sourceLineRows: fillSourceRows(rows, lines.length),
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
