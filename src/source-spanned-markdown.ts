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

const markdownParser = new Marked();

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") starts.push(index + 1);
  }
  return starts;
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
  const tokens = markdownParser.lexer(text);
  let cursor = 0;

  for (const token of tokens) {
    const tokenStart = text.indexOf(token.raw, cursor);
    if (tokenStart < 0) {
      throw new Error(`Markdown token source span could not be recovered: ${token.type}`);
    }
    if (tokenStart > cursor) {
      const gapSpan = sourceSpan(starts, cursor, tokenStart);
      appendSegment(
        segments,
        text.slice(cursor, tokenStart),
        gapSpan,
        intersectsRange(gapSpan, ranges),
      );
    }
    const tokenEnd = tokenStart + token.raw.length;
    appendSourceLines(
      segments,
      text,
      tokenStart,
      tokenEnd,
      starts,
      ranges,
      token.type !== "space",
    );
    cursor = tokenEnd;
  }

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

export class SourceSpannedMarkdown implements Component {
  private segments: Component[] = [];
  private calloutDocument: DetailCalloutDocument | null = null;

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
    if (callouts.length > 0 && this.previewRegions) {
      this.calloutDocument = new DetailCalloutDocument(
        text,
        callouts,
        this.theme,
        this.previewRegions,
        this.linksEnabled,
        decorationEnabled && ranges.length > 0
          ? { ranges, decorate: this.decorate }
          : undefined,
        this.calloutTheme,
      );
      this.segments = [];
      return;
    }
    this.calloutDocument = null;
    if (!decorationEnabled || ranges.length === 0) {
      this.segments = [new Markdown(text, 0, 0, this.theme)];
      return;
    }
    this.segments = sourceSpannedMarkdownSegments(text, ranges).map(
      (segment) => {
        const markdown = new Markdown(segment.text, 0, 0, this.theme);
        if (!segment.decorated) return markdown;
        const box = new Box(0, 0, this.decorate);
        box.addChild(markdown);
        return box;
      },
    );
  }

  render(width: number): string[] {
    return this.calloutDocument?.render(width) ??
      this.segments.flatMap((segment) => segment.render(width));
  }

  invalidate(): void {
    this.calloutDocument?.invalidate();
    for (const segment of this.segments) segment.invalidate();
  }
}
