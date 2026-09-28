import {AttributedMarkdown} from './attributed-markdown';
import {generatedDocument, sliceDocument, type MappedDocument, type DocumentOrigin} from './document-provenance';
import {DocumentFrame,paintDocumentRows,type DocumentGlyph} from './document-frame';
import {LinkAwareMarkdown,stripLinkMarkers} from './link-aware-markdown';
import {renderChecklistControls, type ChecklistControl} from './checklist-controls';
import {withInternalLinks, stripRenderedLinks, measureRenderedLinks, type RenderedLink} from './rendered-links';
import {
  Box,
  Markdown,
  type Component,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";
import {markdownSourceTokens} from "./markdown-structure";
import {foldDocument, revealFoldedLine, type DocumentFold, type FoldedDocument} from "./document-folds";
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
  const blocks: MarkdownRenderBlock[] = [];
  for (const {token, span} of markdownSourceTokens(text)) {
    const {start, end} = span;
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
  let cursor = 0;
  for (const {token, span: {start: tokenStart, end: tokenEnd}} of markdownSourceTokens(text)) {
    if (tokenStart > cursor) {
      const gapSpan = sourceSpan(starts, cursor, tokenStart);
      appendSegment(segments, text.slice(cursor, tokenStart), gapSpan, intersectsRange(gapSpan, ranges));
    }
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
  private attributed: AttributedMarkdown | null = null;
  private attributedSegments: {renderer:AttributedMarkdown;decorated:boolean;blank:boolean}[] | null = null;
  renderedFrame: DocumentFrame | null = null;
  private checklists: readonly ChecklistControl[] = [];
  private folds: readonly DocumentFold[] = [];
  private folded: {signature: string; projection: FoldedDocument; visible: ReadonlySet<number>; renderer: SourceSpannedMarkdown} | null = null;
  private segments: RenderSegment[] = [];
  private calloutDocument: DetailCalloutDocument | null = null;
  private sourceText = "";
  private sourceDocument: MappedDocument = generatedDocument("", "empty reader");
  renderedLinks: readonly RenderedLink[] = [];
  private linkCache: {lines:string[]; links:RenderedLink[]} | null = null;
  private ranges: readonly MarkdownLineRange[] = [];
  private decorationEnabled = false;
  private callouts: readonly DetailCalloutRegion[] = [];

  constructor(
    private readonly theme: MarkdownTheme,
    private readonly decorate: (text: string) => string,
    private readonly previewRegions?: Readonly<PreviewRegionState>,
    private readonly linksEnabled = false,
    private readonly calloutTheme: DetailCalloutTheme = DEFAULT_DETAIL_CALLOUT_THEME,
    private readonly trackLinks = false,
  ) {}

  setContent(
    input: string | MappedDocument,
    ranges: readonly MarkdownLineRange[],
    decorationEnabled: boolean,
    callouts: readonly DetailCalloutRegion[] = [],
    folds: readonly DocumentFold[] = [],
    checklists: readonly ChecklistControl[] = [],
  ): void {
    let document=typeof input==='string'?generatedDocument(input,'unobserved Markdown'):input;
    let text=document.text;
    this.attributed=null;
    this.attributedSegments=null;
    this.renderedFrame=null;
    this.checklists = checklists;
    this.folds = folds;
    this.folded = null;
    this.sourceText = text;
    this.sourceDocument = document;
    // Folded rendering decorates in its child after remapping source lines.
    if (!folds.length) {document = renderChecklistControls(document, checklists); text = document.text;}
    this.ranges = ranges;
    this.decorationEnabled = decorationEnabled && ranges.length > 0;
    this.callouts = callouts;
    if (callouts.length > 0 && this.previewRegions) {
      this.calloutDocument = new DetailCalloutDocument(
        document,
        callouts,
        this.theme,
        this.previewRegions,
        this.linksEnabled || this.trackLinks,
        this.decorationEnabled
          ? { ranges, decorate: this.decorate }
          : undefined,
        this.calloutTheme,
        this.trackLinks,
      );
      this.segments = [];
      return;
    }
    this.calloutDocument = null;
    if(!folds.length&&!this.decorationEnabled) {
      this.attributed=AttributedMarkdown.compile(document,this.theme,this.linksEnabled);
    }
    const sourceSegments = this.decorationEnabled
      ? sourceSpannedMarkdownSegments(text, ranges)
      : text
      ? [{
          text,
          span: sourceSpan(lineStarts(text), 0, text.length),
          decorated: false,
        }]
      : [];
    if(this.decorationEnabled&&!folds.length) {
      const mapped:{renderer:AttributedMarkdown;decorated:boolean;blank:boolean}[]=[];let cursor=0,complete=true;
      for(const [index,segment] of sourceSegments.entries()) {
        if(document.text.slice(cursor,cursor+segment.text.length)!==segment.text){complete=false;break;}
        const renderer=AttributedMarkdown.compile(sliceDocument(document,cursor,cursor+segment.text.length),this.theme,this.linksEnabled,`segment:${index}`);
        cursor+=segment.text.length;
        if(!renderer){complete=false;break;}
        mapped.push({renderer,decorated:segment.decorated,blank:!segment.text.trim()});
      }
      if(complete&&cursor===document.text.length)this.attributedSegments=mapped;
    }
    this.segments = sourceSegments.map((segment) => {
      const markdown = this.trackLinks ? new LinkAwareMarkdown(segment.text,this.theme) : new Markdown(segment.text, 0, 0, this.theme);
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
    const folded = this.foldedDocument();
    if (folded) return folded.renderer.sourceLineRow(width, folded.projection.lineMap[sourceLine] ?? folded.projection.lineMap.at(-1) ?? 0, renderedLineCount);
    const starts = lineStarts(this.sourceText);
    const targetLine = Math.max(0, Math.min(Math.trunc(sourceLine), starts.length - 1));
    if(this.renderedFrame&&this.sourceDocument.runs.some(run=>run.origin.kind!=='generated')) {
      // The current frame owns wrapping, including grid/card conversion. Hidden
      // syntax advances to the next visible source; painted-text searches and
      // the old renderer's layout cannot establish this position.
      for(let line=targetLine;line<starts.length;line++) {
        const origins=sliceDocument(this.sourceDocument,starts[line]!,starts[line+1]??this.sourceText.length).runs.map(run=>run.origin);
        const found=this.renderedFrame.firstRowForOrigins(origins);
        if(found!==undefined)return found;
      }
      return renderedLineCount;
    }
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

  visibleSourceLines(): ReadonlySet<number> | null {
    return this.foldedDocument()?.visible ?? null;
  }

  /** Reveal through the pre-fold projection map. Source identity and occurrence
   * matching happen before hiding content; no rendered-text search is involved. */
  revealMatchingSource(matches:(origin:DocumentOrigin)=>boolean):void {
    if(!this.previewRegions)return;
    let offset=0;
    for(const [line,text] of this.sourceDocument.text.split(/(?<=\n)/).entries()){
      const span=sliceDocument(this.sourceDocument,offset,offset+text.length);offset+=text.length;
      if(span.runs.some(run=>matches(run.origin)))revealFoldedLine(this.previewRegions,[...this.folds,...this.callouts],line);
    }
  }

  private foldedDocument() {
    if (!this.folds.length || !this.previewRegions) return null;
    const signature = this.folds.map(fold => `${fold.id}:${this.previewRegions!.disclosureOverrides.get(fold.id) ?? true}`).join("|");
    if (this.folded?.signature === signature) return this.folded;
    const projection = foldDocument(this.sourceDocument, this.folds, this.previewRegions);
    const visible = new Set(projection.visibleSourceLines);
    const starts = lineStarts(projection.text);
    const mapLine = (line: number) => projection.lineMap[line] ?? Math.max(0, starts.length - 1);
    const callouts = this.callouts.filter(region => visible.has(region.headerLine)).map(region => {
      const startLine = mapLine(region.headerLine), endLine = mapLine(region.sourceSpan!.endLine);
      return {...region, headerLine: startLine, sourceSpan: {startLine, endLine, start: starts[startLine]!, end: starts[endLine + 1] ?? projection.text.length}};
    });
    const renderer = new SourceSpannedMarkdown(this.theme, this.decorate, this.previewRegions, this.linksEnabled, this.calloutTheme, this.trackLinks);
    const checklists = this.checklists.filter(control => visible.has(control.sourceSpan!.startLine)).map(control => ({...control,
      sourceSpan: {...control.sourceSpan!, startLine: mapLine(control.sourceSpan!.startLine), endLine: mapLine(control.sourceSpan!.endLine)}}));
    renderer.setContent(projection.document, this.ranges.map(range => ({startLine: mapLine(range.startLine), endLine: mapLine(range.endLine)})), this.decorationEnabled, callouts, [], checklists);
    return this.folded = {signature, projection, visible, renderer};
  }

  private publishFrame(frame:DocumentFrame):string[] {
    this.renderedFrame=frame;
    const links:RenderedLink[]=[];
    for(const cell of frame.cells) {
      if(!cell.link)continue;
      const previous=links.at(-1);
      if(previous&&previous.row===cell.row&&previous.column+previous.width===cell.column&&previous.occurrenceId===cell.link.id) {
        previous.width+=cell.width;previous.label+=cell.text;
      } else links.push({row:cell.row,column:cell.column,width:cell.width,uri:cell.link.uri,label:cell.text,occurrenceId:cell.link.id});
    }
    this.renderedLinks=links;
    return this.linksEnabled?[...frame.lines]:frame.lines.map(stripRenderedLinks);
  }

  render(width: number): string[] {
    this.renderedFrame=null;
    if(this.attributed)return this.publishFrame(this.attributed.frame(width));
    if(this.attributedSegments) {
      const rows:DocumentGlyph[][]=this.attributedSegments.flatMap(segment=>{
        const content=segment.blank?[[]]:segment.renderer.glyphRows(width);
        return segment.decorated?paintDocumentRows(content,width,this.decorate):content;
      });
      return this.publishFrame(new DocumentFrame(rows,width,this.theme,this.linksEnabled));
    }
    const folded = this.foldedDocument();
    if (folded) {
      const lines = folded.renderer.render(width);
      this.renderedLinks = folded.renderer.renderedLinks;
      this.renderedFrame = folded.renderer.renderedFrame;
      return lines;
    }
    const render = () => {
      if(this.calloutDocument){const lines=this.calloutDocument.render(width);this.renderedFrame=this.calloutDocument.renderedFrame;return lines;}
      return this.segments.flatMap(segment=>segment.component.render(width));
    };
    const lines=this.trackLinks?withInternalLinks(render):render();
    if(this.renderedFrame)return this.publishFrame(this.renderedFrame);
    if(!this.trackLinks)return lines;
    if (!this.linkCache || this.linkCache.lines.length !== lines.length ||
      lines.some((line,index)=>line !== this.linkCache!.lines[index])) {
      this.linkCache = {lines,links:measureRenderedLinks(lines)};
    }
    this.renderedLinks = this.linkCache.links;
    const output=lines.map(stripLinkMarkers);
    return this.linksEnabled ? output : output.map(stripRenderedLinks);
  }

  invalidate(): void {
    this.attributed?.invalidate();
    this.attributedSegments?.forEach(segment=>segment.renderer.invalidate());
    this.folded?.renderer.invalidate();
    this.calloutDocument?.invalidate();
    for (const segment of this.segments) segment.component.invalidate();
  }
}
