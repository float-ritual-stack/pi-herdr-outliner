import {
  Key,
  Markdown,
  matchesKey,
  ScrollView,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type Component,
  type MarkdownTheme,
  VStack,
} from "@earendil-works/pi-tui";
import { currentAttentionMark } from "./attention";
import { decorateAttentionLines } from "./attention-render";
import { DEFAULT_OUTLINER_ACTION_KEYMAP } from "./outliner-actions";
import {
  parseDetailCallouts,
  type DetailCalloutRegion,
} from "./detail-callouts";
import type { DetailCalloutTheme } from "./detail-callout-theme";
import { detailEmbedIds } from "./detail-embeds";
import { linkOutlinerMarkdown } from "./outliner-links";
import {
  visibleBacklinkSources,
  type DetailState,
} from "./detail-controller";
import {
  previewRegionActionUri,
  reconcilePreviewRegions,
  parsePreviewRegionActionUri,
  type PreviewRegion,
  type PreviewRegionAction,
} from "./detail-preview-regions";
import {
  detailPropertyInspectorRegions,
  renderPropertyInspectorDocument,
} from "./detail-pi-renderer";
import { stripFragmentAnchors } from "./fragments";
import { propertyInspectorAuthoredText } from "./property-inspector";
import {
  renderDetailFooter,
  renderDetailHeader,
  type DetailHeaderOptions,
} from "./detail-renderer";
import { sanitizeDynamicText } from "./terminal";
import {
  SourceSpannedMarkdown,
  type SourceSpannedMarkdownRowRender,
} from "./source-spanned-markdown";
import type {
  AnnotationAnchor,
  AnnotationThread,
  AttentionMark,
  BacklinkReferenceGroup,
} from "./types";

export interface DetailDraftProjection {
  sourceText: string;
  rawText: string;
  embedRanges: DetailState["embedRanges"];
  workIdPrefix: string | null;
}

function sourceLineStarts(text: string): number[] {
  const starts = [0];
  for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) {
    starts.push(index + 1);
  }
  return starts;
}

function sourceLineAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle]! <= offset) low = middle;
    else high = middle;
  }
  return low;
}

function embedSourceLines(text: string): number[] {
  const starts = sourceLineStarts(text);
  const lines: number[] = [];
  let cursor = 0;
  for (const id of detailEmbedIds(text)) {
    const start = text.indexOf(`!((${id}`, cursor);
    if (start < 0) continue;
    lines.push(sourceLineAt(starts, start));
    cursor = start + id.length + 3;
  }
  return lines;
}

export function projectedSourceLine(
  authoredText: string,
  embedRanges: DetailState["embedRanges"],
  sourceLine: number,
): number {
  const target = Math.max(0, Math.floor(sourceLine));
  const embedLines = embedSourceLines(stripFragmentAnchors(authoredText));
  let projected = target;
  for (let index = 0; index < embedRanges.length; index += 1) {
    const embedLine = embedLines[index];
    if (embedLine === undefined || embedLine > target) break;
    const range = embedRanges[index]!;
    if (embedLine === target) return range.startLine;
    projected += range.endLine - range.startLine;
  }
  return projected;
}

function sourcePrefixThroughLine(text: string, line: number): string {
  const starts = sourceLineStarts(text);
  const start = starts[Math.max(0, Math.min(Math.floor(line), starts.length - 1))]!;
  const newline = text.indexOf("\n", start);
  let end = newline;
  if (newline < 0) end = text.length;
  else if (newline > start && text[newline - 1] === "\r") end -= 1;
  return text.slice(0, end);
}

function lineAfterMetadataRemoval(text: string, line: number): number {
  const filtered = propertyInspectorAuthoredText(sourcePrefixThroughLine(text, line));
  if (!filtered) return 0;
  return sourceLineStarts(filtered).length - 1;
}

function remapEmbedRangesAfterMetadataRemoval(
  text: string,
  ranges: DetailState["embedRanges"],
): DetailState["embedRanges"] {
  return ranges.map((range) => ({
    startLine: lineAfterMetadataRemoval(text, range.startLine),
    endLine: lineAfterMetadataRemoval(text, range.endLine),
  }));
}

export function nearestDraftSourceLine(
  sourceRowAnchors: readonly number[],
  renderedRow: number,
): number | null {
  if (sourceRowAnchors.length === 0) return null;
  const target = Math.max(0, Math.floor(renderedRow));
  let low = 0;
  let high = sourceRowAnchors.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (sourceRowAnchors[middle]! <= target) low = middle;
    else high = middle;
  }
  return low;
}

export function draftSourceRowAnchors(
  sourceText: string,
  width: number,
  theme: MarkdownTheme,
): number[] {
  const contentWidth = Math.max(1, Math.floor(width));
  const lines = detailMarkdownPresentation(sourceText).split(/\r?\n/);
  const anchors: number[] = [];
  let renderedRow = 0;
  for (const [index, line] of lines.entries()) {
    anchors.push(renderedRow);
    renderedRow += Math.max(1, new Markdown(line || " ", 0, 0, theme).render(contentWidth).length);
    if (
      /^ {0,3}#{1,6}[ \t]+/.test(line) &&
      index + 1 < lines.length &&
      lines[index + 1] !== ""
    ) {
      renderedRow += 1;
    }
  }
  return anchors;
}

interface CachedDetailDraftProjection extends DetailDraftProjection {
  inputText: string;
}

export interface DetailPiPreviewOptions {
  draftText?(): string | null;
  projectDraft?(text: string): Promise<DetailDraftProjection>;
  splitActive?(): boolean;
  focused?(): boolean;
  projectionDelayMs?: number;
  setRegions?(regions: readonly PreviewRegion[]): void;
  calloutTheme?: DetailCalloutTheme;
  helpText?(): string;
  chooserHelpText?(): string;
  headerPropertyKeys?: readonly string[];
}

function annotationSelectionOffsets(state: Readonly<DetailState>): {
  start: number;
  end: number;
} | null {
  const range = state.buffer.selectionRange;
  if (!range) return null;
  const offset = (row: number, column: number): number => {
    let value = column;
    for (let index = 0; index < row; index += 1) {
      value += state.buffer.lines[index]!.length + 1;
    }
    return value;
  };
  return {
    start: offset(range.start.row, range.start.column),
    end: offset(range.end.row, range.end.column),
  };
}

function annotationSelectionMark(state: Readonly<DetailState>): AttentionMark | null {
  const selected = state.context.selected;
  if (!selected) return null;
  const target = state.mode === "comment"
    ? state.annotationDraft?.target
    : undefined;
  let anchor: AnnotationAnchor;
  if (target?.kind === "block") {
    anchor = target.anchor;
  } else if (state.mode === "select") {
    const offsets = annotationSelectionOffsets(state);
    if (!offsets) return null;
    anchor = {
      ...offsets,
      excerpt: selected.text.slice(offsets.start, offsets.end),
      contextBefore: "",
      contextAfter: "",
      sourceVersion: selected.updatedAt,
      sourceHash: "",
    };
  } else {
    return null;
  }
  return {
    markId: "local-annotation-selection",
    targetClientId: state.attention.targetClientId,
    target: {
      kind: "block",
      sourceBlockId: selected.id,
      sourceVersion: anchor.sourceVersion,
      sourceHash: anchor.sourceHash,
      anchor,
    },
    tone: "current",
    role: "current",
    sender: "Local selection",
    createdAt: "",
    expiresAt: "",
    returnCuePending: false,
    sourceState: "active",
  };
}

interface MarkdownTextProjection {
  text: string;
  sourceOffsets: number[];
}

function markdownTextProjection(source: string): MarkdownTextProjection {
  const sourceOffsets: number[] = [];
  let text = "";
  let index = 0;
  const heading = /^ {0,3}#{1,6}[ \t]+/.exec(source);
  if (heading) index = heading[0].length;
  while (index < source.length) {
    if (source[index] === "\\" && index + 1 < source.length) {
      index += 1;
      sourceOffsets.push(index);
      text += source[index]!;
      index += 1;
      continue;
    }
    if (source[index] === "[" || source[index] === "]") {
      if (source[index] === "]" && source[index + 1] === "(") {
        const end = source.indexOf(")", index + 2);
        index = end < 0 ? index + 1 : end + 1;
      } else {
        index += 1;
      }
      continue;
    }
    if (
      source[index] === "`" || source[index] === "*" ||
      source[index] === "_" || source[index] === "~"
    ) {
      index += 1;
      continue;
    }
    sourceOffsets.push(index);
    text += source[index]!;
    index += 1;
  }
  sourceOffsets.push(source.length);
  return { text, sourceOffsets };
}

export function sanitizeMarkdownDocument(value: string): string {
  return sanitizeDynamicText(value, true);
}

interface MarkdownFence {
  marker: "`" | "~";
  length: number;
}

export function detailMarkdownPresentation(value: string): string {
  let fence: MarkdownFence | null = null;
  return value.split(/(?<=\n)/).map((sourceLine, index) => {
    const newline = sourceLine.endsWith("\r\n")
      ? "\r\n"
      : sourceLine.endsWith("\n")
      ? "\n"
      : "";
    const line = newline ? sourceLine.slice(0, -newline.length) : sourceLine;
    const fenceMatch = /^((?: {0,3}>[ \t]?)* {0,3})(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (
        fenceMatch &&
        fenceMatch[2]![0] === fence.marker &&
        fenceMatch[2]!.length >= fence.length
      ) {
        fence = null;
      }
      return sourceLine;
    }
    if (fenceMatch) {
      fence = {
        marker: fenceMatch[2]![0] as MarkdownFence["marker"],
        length: fenceMatch[2]!.length,
      };
      return sourceLine;
    }

    const heading = /^((?: {0,3}>[ \t]?)* {0,3})(#{1,6})[ \t]+(.*)$/.exec(line);
    if (index === 0 && line.trim()) {
      const title = heading && heading[1] === "" ? heading[3]! : line;
      return `# ${title}${newline}`;
    }
    if (heading && heading[2]!.length >= 3) {
      const depth = heading[2]!.length;
      return `${heading[1]}## ${"›".repeat(depth - 2)} ${heading[3]}${newline}`;
    }
    return sourceLine;
  }).join("");
}

function renderPreviewDocument(
  sourceText: string,
  rawText: string,
  linksEnabled: boolean,
  workIdPrefix: string | null,
): string {
  const sanitizedSource = sanitizeMarkdownDocument(sourceText);
  // Sanitize authored text before generated links or presentation-only Markdown are added.
  return detailMarkdownPresentation(
    linkOutlinerMarkdown(
      sanitizedSource,
      sanitizeMarkdownDocument(rawText),
      workIdPrefix,
      linksEnabled,
    ),
  );
}

function renderedAuthoredCallouts(
  authored: readonly DetailCalloutRegion[],
  renderedText: string,
  renderedLineForAuthoredLine: (line: number) => number,
  theme?: DetailCalloutTheme,
): DetailCalloutRegion[] {
  const rendered = parseDetailCallouts(renderedText, theme);
  const used = new Set<number>();
  const matched: DetailCalloutRegion[] = [];
  for (const origin of authored) {
    const headerLine = renderedLineForAuthoredLine(origin.headerLine);
    const index = rendered.findIndex((candidate, candidateIndex) =>
      !used.has(candidateIndex) &&
      candidate.headerLine === headerLine &&
      candidate.canonicalType === origin.canonicalType &&
      candidate.depth === origin.depth
    );
    if (index < 0) continue;
    used.add(index);
    const projected = rendered[index]!;
    matched.push({
      ...projected,
      id: origin.id,
      parentId: origin.parentId,
      childIds: origin.childIds,
      activation: projected.activation
        ? { type: "callout.disclosure.toggle", regionId: origin.id }
        : null,
    });
  }
  const matchedIds = new Set(matched.map((region) => region.id));
  return matched.map((region) => ({
    ...region,
    parentId: region.parentId && matchedIds.has(region.parentId) ? region.parentId : null,
    childIds: region.childIds.filter((id) => matchedIds.has(id)),
  }));
}

const PREVIEW_HELP = DEFAULT_OUTLINER_ACTION_KEYMAP.helpText("detail", "preview");
const ACTIVE_SELECTION_STYLE = "\x1b[1;97;48;5;24m";
const RESET_STYLE = "\x1b[0m";

function highlightActiveSelection(text: string): string {
  const styled = text.replaceAll(
    RESET_STYLE,
    `${RESET_STYLE}${ACTIVE_SELECTION_STYLE}`,
  );
  return `${ACTIVE_SELECTION_STYLE}${styled}${RESET_STYLE}`;
}

function highlightActiveBacklink(text: string): string {
  return `${ACTIVE_SELECTION_STYLE}${text}${RESET_STYLE}`;
}


function escapeGeneratedMarkdown(value: string): string {
  return sanitizeMarkdownDocument(value)
    .replace(/\r?\n/g, " ")
    .replaceAll("\\", "\\\\")
    .replace(/([`*_[\]<>~])/g, "\\$1");
}

function backlinkGroupLabel(group: BacklinkReferenceGroup): string {
  if (group.kind === "property") return `${group.propertyKey} property ×${group.count}`;
  let label = "Work ID";
  if (group.kind === "block") label = "block reference";
  else if (group.kind === "page") label = "page link";
  return `${label} ×${group.count}`;
}

export type DetailPreviewAction = PreviewRegionAction;

export function detailBacklinkToggleUri(blockId: string): string {
  return previewRegionActionUri({
    type: "backlink.source.disclosure.toggle",
    blockId,
  });
}

export function parseDetailPreviewActionUri(uri: string): DetailPreviewAction | null {
  return parsePreviewRegionActionUri(uri);
}

export function detailBacklinkRegions(
  state: Readonly<DetailState>,
): PreviewRegion[] {
  const parentId = "backlinks";
  const sources = state.backlinks.expanded
    ? visibleBacklinkSources(state.backlinks)
    : [];
  const regions: PreviewRegion[] = [{
    id: parentId,
    kind: "backlinks",
    sourceSpan: null,
    parentId: null,
    childIds: sources.map((source) => `backlink:${source.blockId}`),
    focusable: false,
    disclosure: {
      defaultExpanded: false,
      expanded: state.backlinks.expanded,
    },
    activation: { type: "backlinks.disclosure.toggle" },
  }];
  if (!state.backlinks.expanded) return regions;
  for (const source of sources) {
    regions.push({
      id: `backlink:${source.blockId}`,
      kind: "backlink-source",
      sourceSpan: null,
      parentId,
      childIds: [],
      focusable: true,
      disclosure: {
        defaultExpanded: false,
        expanded: state.backlinks.expandedSourceIds.has(source.blockId),
      },
      activation: { type: "backlink.open", blockId: source.blockId },
    });
  }
  return regions;
}

export function renderBacklinksDocument(state: Readonly<DetailState>): string {
  const backlinks = state.backlinks;
  const heading = `[Backlinks](${
    previewRegionActionUri({ type: "backlinks.disclosure.toggle" })
  })`;
  if (!backlinks.expanded) return `## ${heading}\n_Collapsed · press b to load_`;
  if (backlinks.loading) return `## ${heading}\n_Loading…_`;
  if (backlinks.error) {
    return `## ${heading}\n_Error: ${escapeGeneratedMarkdown(backlinks.error)}_`;
  }
  const collection = backlinks.collection;
  if (!collection) return `## ${heading}\n_No backlink data loaded_`;

  const sources = visibleBacklinkSources(backlinks);
  const filter = backlinks.filterDraft ?? backlinks.filter;
  const direction = backlinks.sortDirection === "asc" ? "↑" : "↓";
  const sort = backlinks.sortField === "created" ? "Created" : "Updated";
  const lines = [`## ${heading}`];
  if (backlinks.filterDraft !== null) {
    lines.push(
      `**Filter:** ${escapeGeneratedMarkdown(filter)}▏ · ↵ apply · ⎋ cancel`,
    );
  } else {
    lines.push(
      `_Filter: ${filter ? escapeGeneratedMarkdown(filter) : "none"} · ${sources.length}/${collection.sources.length} sources · Sort: ${sort} ${direction}_`,
    );
  }
  if (collection.targetDeletedRootId) lines.push("_Target is in Trash._");
  if (collection.sources.length === 0) {
    lines.push("_No backlinks._");
  } else if (sources.length === 0) {
    lines.push("_No backlinks match the current filter._");
  } else {
    for (const [index, source] of sources.entries()) {
      const title = escapeGeneratedMarkdown(source.title);
      const context = escapeGeneratedMarkdown(source.parentContext);
      const trash = source.deletedRootId ? " · Trash" : "";
      const count = source.occurrenceCount === 1
        ? "1 reference"
        : `${source.occurrenceCount} references`;
      const uri = previewRegionActionUri({ type: "backlink.open", blockId: source.blockId });
      const selected = index === backlinks.selectedIndex;
      const active = selected ? "**▶ ACTIVE** " : "";
      const sourceExpanded = backlinks.expandedSourceIds.has(source.blockId);
      const disclosure = detailBacklinkToggleUri(source.blockId);
      const groups = source.referenceGroups.map(backlinkGroupLabel).join(", ");
      const details = `${context}${trash} · ${count} · ${groups}`;
      const row =
        `[${sourceExpanded ? "−" : "+"}](${disclosure}) ${active}[${title}](${uri}) — [${details}](${uri})`;
      lines.push(selected ? `~~${row}~~` : row);
      if (sourceExpanded) {
        for (const occurrence of source.occurrences) {
          const property = occurrence.kind === "property"
            ? `**${escapeGeneratedMarkdown(occurrence.propertyKey)} property** · `
            : "";
          lines.push(`  > ${property}${escapeGeneratedMarkdown(occurrence.snippet)}`);
        }
        if (source.occurrencesTruncated) lines.push("  > Additional occurrences omitted.");
      }
    }
  }
  if (collection.completeness.kind === "truncated") {
    lines.push(`_Showing first ${collection.completeness.limit} source blocks._`);
  }
  return lines.join("\n");
}

function applyEmbedBackground(text: string): string {
  return `\x1b[48;5;236m${text}\x1b[0m`;
}

interface InlinePreviewArrangement {
  lines: string[];
  inspectorStart: number;
  mapAuthoredRow(row: number): number;
  authoredRowAt(row: number): number | null;
}

function arrangeInlinePreview(
  authored: readonly string[],
  inspector: readonly string[],
): InlinePreviewArrangement {
  if (inspector.length === 0) {
    return {
      lines: [...authored],
      inspectorStart: authored.length,
      mapAuthoredRow: (row) => row,
      authoredRowAt: (row) => row >= 0 && row < authored.length ? row : null,
    };
  }
  const blank = authored.findIndex((line) => sanitizeDynamicText(line).trim() === "");
  const titleEnd = blank < 0 ? authored.length : blank;
  const bodyStart = blank < 0 ? authored.length : blank + 1;
  const lines: string[] = [];
  const authoredToOutput: number[] = [];
  const outputToAuthored: Array<number | null> = [];
  for (let row = 0; row < titleEnd; row += 1) {
    authoredToOutput[row] = lines.length;
    lines.push(authored[row]!);
    outputToAuthored.push(row);
  }
  if (titleEnd > 0) {
    lines.push("");
    outputToAuthored.push(blank >= 0 ? blank : null);
  }
  const inspectorStart = lines.length;
  for (const line of inspector) {
    lines.push(line);
    outputToAuthored.push(null);
  }
  if (bodyStart < authored.length) {
    lines.push("");
    outputToAuthored.push(blank >= 0 ? blank : null);
    for (let row = bodyStart; row < authored.length; row += 1) {
      authoredToOutput[row] = lines.length;
      lines.push(authored[row]!);
      outputToAuthored.push(row);
    }
  }
  return {
    lines,
    inspectorStart,
    mapAuthoredRow: (row) =>
      authoredToOutput[Math.max(0, Math.min(row, authored.length - 1))] ??
        Math.min(row, lines.length),
    authoredRowAt: (row) => outputToAuthored[row] ?? null,
  };
}

interface DetailAnnotationGroup {
  regionId: string;
  startLine: number;
  endLine: number;
  sourceLineCount: number;
  sourceSpan: NonNullable<PreviewRegion["sourceSpan"]>;
  threads: AnnotationThread[];
}

interface AnnotationPreviewArrangement {
  markdownLines: readonly string[];
  lines: string[];
  contentWidth: number;
  mapMarkdownRow(row: number): number;
  markdownRowAt(row: number): number | null;
  markerRows: ReadonlyMap<string, number>;
  panelRows: ReadonlyMap<string, number>;
}

const ANNOTATION_GUTTER_WIDTH = 2;
const ANNOTATION_BORDER_STYLE = "\x1b[35m";

function annotationBorder(text: string): string {
  return `${ANNOTATION_BORDER_STYLE}${text}${RESET_STYLE}`;
}

function annotationPanelLines(
  thread: AnnotationThread,
  index: number,
  width: number,
  theme: MarkdownTheme,
): string[] {
  const panelWidth = Math.max(1, width);
  const title =
    ` Comment ${index + 1} · ${thread.source} · ${thread.anchorState} · ${thread.lifecycle} `;
  const top = truncateToWidth(
    `╭${title}${"─".repeat(Math.max(0, panelWidth - visibleWidth(title) - 1))}`,
    panelWidth,
  );
  const body = thread.body.split(/\r?\n/).map(escapeGeneratedMarkdown);
  for (const reply of thread.replies) {
    body.push(
      "",
      `**${escapeGeneratedMarkdown(reply.source)}:** ${
        escapeGeneratedMarkdown(reply.body)
      }`,
    );
  }
  const rendered = new Markdown(body.join("\n"), 0, 0, theme)
    .render(Math.max(1, panelWidth - 2));
  return [
    annotationBorder(top),
    ...rendered.map((line) => `${annotationBorder("│")} ${line}`),
    annotationBorder(`╰${"─".repeat(Math.max(0, panelWidth - 1))}`),
  ];
}

class DetailAnnotationPreview implements Component {
  private groups: readonly DetailAnnotationGroup[] = [];

  constructor(
    private readonly state: Readonly<DetailState>,
    private readonly markdown: SourceSpannedMarkdown,
    private readonly theme: MarkdownTheme,
  ) {}

  setGroups(groups: readonly DetailAnnotationGroup[]): void {
    this.groups = groups;
  }

  renderArrangement(width: number): AnnotationPreviewArrangement {
    const outerWidth = Math.max(1, Math.floor(width));
    if (this.groups.length === 0) {
      const lines = this.markdown.render(outerWidth);
      return {
        markdownLines: lines,
        lines,
        contentWidth: outerWidth,
        mapMarkdownRow: (row) => Math.max(0, Math.min(row, lines.length)),
        markdownRowAt: (row) => row >= 0 && row < lines.length ? row : null,
        markerRows: new Map(),
        panelRows: new Map(),
      };
    }

    const gutterWidth = Math.min(
      ANNOTATION_GUTTER_WIDTH,
      Math.max(0, outerWidth - 1),
    );
    const contentWidth = outerWidth - gutterWidth;
    const markdownLines = this.markdown.render(contentWidth);
    const markers = new Map<number, DetailAnnotationGroup>();
    const insertions = new Map<
      number,
      Array<{ regionId: string; lines: string[] }>
    >();
    for (const group of this.groups) {
      const startRow = this.markdown.sourceLineRow(
        contentWidth,
        group.startLine,
        markdownLines.length,
      );
      markers.set(startRow, group);
      const endBoundary = group.endLine + 1 >= group.sourceLineCount
        ? markdownLines.length
        : this.markdown.sourceLineRow(
          contentWidth,
          group.endLine + 1,
          markdownLines.length,
        );
      const region = this.state.previewRegions.regions.find((candidate) =>
        candidate.id === group.regionId
      );
      if (!region?.disclosure?.expanded) continue;
      const insertionRow = Math.max(startRow + 1, endBoundary);
      const panel = group.threads.flatMap((thread) =>
        annotationPanelLines(
          thread,
          this.state.annotationThreads.indexOf(thread),
          contentWidth,
          this.theme,
        )
      );
      const existing = insertions.get(insertionRow) ?? [];
      existing.push({ regionId: group.regionId, lines: panel });
      insertions.set(insertionRow, existing);
    }

    const lines: string[] = [];
    const markdownRows: Array<number | null> = [];
    const markdownToOutput: number[] = [];
    const markerRows = new Map<string, number>();
    const panelRows = new Map<string, number>();
    for (let row = 0; row <= markdownLines.length; row += 1) {
      for (const panel of insertions.get(row) ?? []) {
        panelRows.set(panel.regionId, lines.length);
        for (const panelLine of panel.lines) {
          lines.push(`${" ".repeat(gutterWidth)}${panelLine}`);
          markdownRows.push(null);
        }
      }
      if (row === markdownLines.length) break;
      markdownToOutput[row] = lines.length;
      const group = markers.get(row);
      let marker = "";
      if (group && gutterWidth > 0) {
        const region = this.state.previewRegions.regions.find((candidate) =>
          candidate.id === group.regionId
        );
        const symbol = region?.disclosure?.expanded ? "−" : "+";
        marker = new Markdown(
          `[${symbol}](${
            previewRegionActionUri({
              type: "annotation.disclosure.toggle",
              regionId: group.regionId,
            })
          })`,
          0,
          0,
          this.theme,
        ).render(1)[0] ?? symbol;
        if (this.state.previewRegions.focusedRegionId === group.regionId) {
          marker = highlightActiveSelection(marker);
        }
        markerRows.set(group.regionId, lines.length);
      }
      const padding = " ".repeat(Math.max(0, gutterWidth - visibleWidth(marker)));
      lines.push(`${marker}${padding}${markdownLines[row]}`);
      markdownRows.push(row);
    }
    return {
      markdownLines,
      lines,
      contentWidth,
      mapMarkdownRow: (row) =>
        row >= markdownLines.length
          ? lines.length
          : markdownToOutput[Math.max(0, row)] ?? 0,
      markdownRowAt: (row) => markdownRows[row] ?? null,
      markerRows,
      panelRows,
    };
  }

  render(width: number): string[] {
    return this.renderArrangement(width).lines;
  }

  invalidate(): void {
    this.markdown.invalidate();
  }
}

function detailAnnotationGroups(
  state: Readonly<DetailState>,
  renderedLineForAuthoredLine: (line: number) => number,
  renderedSourceLineCount: number,
): DetailAnnotationGroup[] {
  const selected = state.context.selected;
  if (!selected) return [];
  const starts = sourceLineStarts(selected.text);
  const groups = new Map<number, DetailAnnotationGroup>();
  for (const thread of state.annotationThreads) {
    if (
      thread.target.kind !== "block" ||
      thread.target.sourceBlockId !== selected.id
    ) continue;
    const anchor = thread.target.anchor;
    let markerOffset = anchor.start;
    while (
      markerOffset < anchor.end &&
      /\s/.test(selected.text[markerOffset] ?? "")
    ) markerOffset += 1;
    const authoredStartLine = sourceLineAt(
      starts,
      markerOffset < anchor.end ? markerOffset : anchor.start,
    );
    const authoredEndLine = sourceLineAt(
      starts,
      Math.max(anchor.start, anchor.end - 1),
    );
    const startLine = renderedLineForAuthoredLine(authoredStartLine);
    const endLine = renderedLineForAuthoredLine(authoredEndLine);
    const existing = groups.get(startLine);
    if (existing) {
      existing.endLine = Math.max(existing.endLine, endLine);
      existing.sourceSpan.start = Math.min(existing.sourceSpan.start, anchor.start);
      existing.sourceSpan.end = Math.max(existing.sourceSpan.end, anchor.end);
      existing.sourceSpan.startLine = Math.min(
        existing.sourceSpan.startLine,
        authoredStartLine,
      );
      existing.sourceSpan.endLine = Math.max(
        existing.sourceSpan.endLine,
        authoredEndLine,
      );
      existing.threads.push(thread);
      continue;
    }
    groups.set(startLine, {
      regionId: `annotation:${selected.id}:${authoredStartLine}`,
      startLine,
      endLine,
      sourceLineCount: renderedSourceLineCount,
      sourceSpan: {
        start: anchor.start,
        end: anchor.end,
        startLine: authoredStartLine,
        endLine: authoredEndLine,
      },
      threads: [thread],
    });
  }
  return [...groups.values()].sort((left, right) => left.startLine - right.startLine);
}

function detailAnnotationRegions(
  groups: readonly DetailAnnotationGroup[],
): PreviewRegion[] {
  return groups.map((group) => ({
    id: group.regionId,
    kind: "annotation",
    sourceSpan: group.sourceSpan,
    parentId: null,
    childIds: [],
    focusable: true,
    disclosure: {
      defaultExpanded: false,
      expanded: false,
    },
    activation: {
      type: "annotation.disclosure.toggle",
      regionId: group.regionId,
    },
  }));
}

class DetailPreviewBody implements Component {
  constructor(
    private readonly state: Readonly<DetailState>,
    private readonly authored: Component,
    private readonly inspector: Markdown,
    private readonly backlinks: Markdown,
    private readonly dedicatedInspector: () => boolean,
    private readonly includeInspector: () => boolean,
    private readonly includeBacklinks: () => boolean,
  ) {}

  private renderInspector(width: number): string[] {
    const lines = [...this.inspector.render(width)];
    const activeLine = lines.findIndex((line) => line.includes("▶ "));
    if (activeLine < 0) return lines;

    const isTableContent = (line: string): boolean =>
      sanitizeDynamicText(line).trimStart().startsWith("│");
    let start = activeLine;
    let end = activeLine;
    while (start > 0 && isTableContent(lines[start - 1]!)) start -= 1;
    while (end + 1 < lines.length && isTableContent(lines[end + 1]!)) end += 1;
    return lines.map((line, index) =>
      index >= start && index <= end ? highlightActiveSelection(line) : line
    );
  }

  render(width: number): string[] {
    const inspector = this.renderInspector(width);
    if (this.dedicatedInspector()) return inspector;
    const authored = decorateAttentionLines(
      this.authored.render(width),
      annotationSelectionMark(this.state) ??
        currentAttentionMark(this.state.attention, this.state.targetBlockId),
      width,
      this.state.context.selected?.text,
    );
    const lines = this.includeInspector()
      ? arrangeInlinePreview(authored, inspector).lines
      : [...authored];
    if (this.includeBacklinks()) lines.push("", ...this.backlinks.render(width));
    return lines;
  }

  invalidate(): void {
    this.authored.invalidate();
    this.inspector.invalidate();
    this.backlinks.invalidate();
  }
}

class DetailPreviewHeader implements Component {
  constructor(
    private readonly state: Readonly<DetailState>,
    private readonly linksEnabled: boolean,
    private readonly options: DetailPiPreviewOptions,
  ) {}

  render(width: number): string[] {
    const header: DetailHeaderOptions = {
      linkBreadcrumbs: this.linksEnabled,
      propertyKeys: this.options.headerPropertyKeys,
    };
    const split = this.options.splitActive?.() ?? false;
    if (this.state.propertyInspector.presentation === "dedicated") {
      header.surface = "Properties";
      header.focused = true;
    } else if (split) {
      const focused = this.options.focused?.() ?? false;
      header.surface = `${focused ? "●" : "○"} Draft`;
      header.focused = focused;
    }
    return renderDetailHeader(this.state, width, header);
  }

  invalidate(): void {}
}
class DetailPreviewFooter implements Component {
  constructor(
    private readonly state: Readonly<DetailState>,
    private readonly options: DetailPiPreviewOptions,
  ) {}

  render(width: number): string[] {
    return renderDetailFooter(
      this.state,
      width,
      "preview",
      this.options.helpText?.() ?? PREVIEW_HELP,
      this.options.chooserHelpText?.(),
    );
  }

  invalidate(): void {}
}

export class DetailPiPreviewLayout extends VStack {
  readonly markdown: SourceSpannedMarkdown;
  private readonly annotationPreview: DetailAnnotationPreview;
  readonly inspectorMarkdown: Markdown;
  readonly backlinkMarkdown: Markdown;
  readonly scrollView: ScrollView;
  private renderedSourceText: string | undefined;
  private renderedRawText: string | undefined;
  private renderedWorkIdPrefix: string | null | undefined;
  private renderedBacklinksDocument: string | undefined;
  private renderedInspectorDocument: string | undefined;
  private renderedInspectorWidth: number | undefined;
  private renderedEmbedPresentation: string | undefined;
  private renderedDraftProjectionError: string | undefined;
  private renderedCalloutSource: string | undefined;
  private calloutRegions: DetailCalloutRegion[] = [];
  private renderedCalloutRegions: DetailCalloutRegion[] = [];
  private renderedDocumentText = "";
  private renderedFragmentSourceLine = 0;
  private renderedAttentionSourceLine = 0;
  private previousAttentionRevealSourceLine: number | null | undefined;
  private pendingAttentionScroll = false;
  private previousSelectionId: string | null | undefined;
  private previousTargetFragmentId: string | null | undefined;
  private previousAnnotationFocusedExpanded: boolean | undefined;
  private previousPreviewOffset: number | undefined;
  private active: boolean;
  private resetScroll = false;
  private previousBacklinksExpanded = false;
  private previousBacklinkSelectedIndex: number | undefined;
  private pendingBacklinkSelectionScroll = false;
  private previousPropertyFocusedId: string | null = null;
  private pendingPropertySelectionScroll = false;
  private previousAnnotationFocusedId: string | null = null;
  private pendingAnnotationSelectionScroll = false;
  private pendingFragmentScroll = false;
  private fragmentRenderScheduled = false;
  private draftProjection: CachedDetailDraftProjection | null = null;
  private scheduledDraftText: string | undefined;
  private failedDraftText: string | undefined;
  private draftProjectionTimer: ReturnType<typeof setTimeout> | undefined;
  private draftProjectionRevision = 0;
  private draftProjectionError = "";
  private draftAnchorCache:
    | { sourceText: string; width: number; anchors: number[] }
    | null = null;

  constructor(
    private readonly state: Readonly<DetailState>,
    private readonly markdownTheme: MarkdownTheme,
    private readonly linksEnabled = process.env.HERDR_ENV === "1",
    private readonly requestRender?: () => void,
    private readonly options: DetailPiPreviewOptions = {},
  ) {
    const markdown = new SourceSpannedMarkdown(
      markdownTheme,
      applyEmbedBackground,
      state.previewRegions,
      linksEnabled,
      options.calloutTheme,
    );
    const annotationPreview = new DetailAnnotationPreview(state, markdown, markdownTheme);
    const inspectorMarkdown = new Markdown("", 0, 0, {
      ...markdownTheme,
      linkUrl: () => "",
    });
    const backlinkMarkdown = new Markdown("", 0, 0, {
      ...markdownTheme,
      strikethrough: highlightActiveBacklink,
      linkUrl: () => "",
    });
    const body = new DetailPreviewBody(
      state,
      annotationPreview,
      inspectorMarkdown,
      backlinkMarkdown,
      () => state.propertyInspector.presentation === "dedicated",
      () => Boolean(state.context.selected) && !(options.splitActive?.() ?? false),
      () => !(options.splitActive?.() ?? false),
    );
    const scrollView = new ScrollView(body, {
      primary: true,
      follow: "none",
      scrollbar: "always",
    });
    super([
      {
        component: new DetailPreviewHeader(state, linksEnabled, options),
        basis: 3,
        shrink: 0,
      },
      { component: scrollView, grow: 1, shrink: 1, minSize: 1 },
      { component: new DetailPreviewFooter(state, options), basis: 2, shrink: 0 },
    ]);
    this.markdown = markdown;
    this.annotationPreview = annotationPreview;
    this.inspectorMarkdown = inspectorMarkdown;
    this.backlinkMarkdown = backlinkMarkdown;
    this.scrollView = scrollView;
    this.active = state.mode === "preview";
  }

  setActive(active: boolean): void {
    if (active && !this.active) this.resetScroll = true;
    if (!active && this.active) this.resetDraftProjectionState();
    this.active = active;
  }

  navigate(direction: "up" | "down" | "pageup" | "pagedown" | "top" | "bottom"): void {
    const page = Math.max(1, this.scrollView.viewportHeight);
    if (direction === "up") this.scrollView.scrollBy(-1);
    else if (direction === "down") this.scrollView.scrollBy(1);
    else if (direction === "pageup") this.scrollView.scrollBy(-page);
    else if (direction === "pagedown") this.scrollView.scrollBy(page);
    else if (direction === "top") this.scrollView.scrollToStart();
    else this.scrollView.scrollToEnd();
    this.requestRender?.();
  }

  private renderAnnotatedWithSourceLineRow(
    width: number,
    sourceLine: number,
  ): SourceSpannedMarkdownRowRender {
    const arrangement = this.annotationPreview.renderArrangement(width);
    const markdownRow = this.markdown.sourceLineRow(
      arrangement.contentWidth,
      sourceLine,
      arrangement.markdownLines.length,
    );
    return {
      lines: arrangement.lines,
      sourceLineRow: arrangement.mapMarkdownRow(markdownRow),
    };
  }

  draftSourceLineAtScroll(width: number): number | null {
    const anchors = this.currentDraftAnchors(width);
    return anchors ? nearestDraftSourceLine(anchors, this.scrollView.scrollTop) : null;
  }

  sourceLineAtScroll(width: number): number | null {
    const sourceText = this.state.context.selected?.text;
    if (!sourceText) return null;
    const contentWidth = this.scrollView.getContentWidth(width);
    const annotated = this.annotationPreview.renderArrangement(contentWidth);
    const anchors = draftSourceRowAnchors(
      sourceText,
      annotated.contentWidth,
      this.markdownTheme,
    ).map((row) => annotated.mapMarkdownRow(row));
    if (!(this.options.splitActive?.() ?? false)) {
      const inspector = this.inspectorMarkdown.render(contentWidth);
      const arrangement = arrangeInlinePreview(annotated.lines, inspector);
      for (let index = 0; index < anchors.length; index += 1) {
        anchors[index] = arrangement.mapAuthoredRow(anchors[index]!);
      }
    }
    return nearestDraftSourceLine(anchors, this.scrollView.scrollTop);
  }

  sourcePointAtViewport(
    viewportRow: number,
    viewportColumn: number,
    width: number,
  ): { row: number; column: number } | null {
    const sourceText = this.state.context.selected?.text;
    if (!sourceText) return null;
    const contentWidth = this.scrollView.getContentWidth(width);
    const annotated = this.annotationPreview.renderArrangement(contentWidth);
    const inspector = this.inspectorMarkdown.render(contentWidth);
    const split = this.options.splitActive?.() ?? false;
    const arrangement = split
      ? {
        lines: annotated.lines,
        mapAuthoredRow: (row: number) => row,
        authoredRowAt: (row: number) =>
          row >= 0 && row < annotated.lines.length ? row : null,
      }
      : arrangeInlinePreview(annotated.lines, inspector);
    const sourceLines = sourceText.split(/\r?\n/);
    const markdownAnchors = draftSourceRowAnchors(
      sourceText,
      annotated.contentWidth,
      this.markdownTheme,
    );
    const anchors = markdownAnchors
      .map((row) => arrangement.mapAuthoredRow(annotated.mapMarkdownRow(row)));
    const bodyRow = this.scrollView.scrollTop + Math.max(0, viewportRow - 3);
    const annotatedRow = arrangement.authoredRowAt(bodyRow);
    if (annotatedRow === null) return null;
    const markdownRow = annotated.markdownRowAt(annotatedRow);
    if (markdownRow === null) return null;
    const sourceLine = nearestDraftSourceLine(anchors, bodyRow);
    if (sourceLine === null) return null;
    const markdownAnchor = markdownAnchors[sourceLine];
    if (markdownAnchor === undefined || markdownRow < markdownAnchor) return null;
    const projection = markdownTextProjection(sourceLines[sourceLine] ?? "");
    let projectionOffset = 0;
    for (let row = markdownAnchor; row <= markdownRow; row += 1) {
      const rendered = stripTerminalSequences(annotated.markdownLines[row] ?? "")
        .replace(/^▐ /, "");
      const segment = rendered.trim();
      if (!segment) continue;
      const segmentStart = projection.text.indexOf(segment, projectionOffset);
      if (segmentStart < 0) {
        if (row !== markdownRow) continue;
        const contentColumn = Math.max(
          0,
          viewportColumn - (contentWidth - annotated.contentWidth),
        );
        const ratio = Math.max(0, Math.min(1, contentColumn / Math.max(1, rendered.length)));
        const projectedColumn = Math.round(ratio * projection.text.length);
        return {
          row: sourceLine,
          column: projection.sourceOffsets[projectedColumn] ?? projection.sourceOffsets.at(-1)!,
        };
      }
      if (row !== markdownRow) {
        projectionOffset = segmentStart + segment.length;
        continue;
      }
      const displayStart = rendered.indexOf(segment);
      const contentColumn = Math.max(
        0,
        viewportColumn - (contentWidth - annotated.contentWidth),
      );
      const displayColumn = Math.max(0, Math.min(
        segment.length,
        contentColumn - displayStart,
      ));
      return {
        row: sourceLine,
        column: projection.sourceOffsets[segmentStart + displayColumn] ??
          projection.sourceOffsets.at(-1)!,
      };
    }
    return { row: sourceLine, column: 0 };
  }

  scrollDraftToSourceLine(sourceLine: number, width: number): boolean {
    const anchors = this.currentDraftAnchors(width);
    const anchor = anchors?.[Math.max(0, Math.min(Math.floor(sourceLine), anchors.length - 1))];
    if (anchor === undefined) return false;
    const previous = this.scrollView.scrollTop;
    this.scrollView.scrollTo(anchor);
    if (this.scrollView.scrollTop !== previous) this.requestRender?.();
    return true;
  }

  private currentDraftAnchors(width: number): number[] | null {
    const draftText = this.options.draftText?.();
    const projection = this.draftProjection;
    if (!draftText || !projection || projection.rawText !== draftText) return null;
    const contentWidth = this.scrollView.getContentWidth(width);
    if (
      this.draftAnchorCache?.sourceText !== draftText ||
      this.draftAnchorCache.width !== contentWidth
    ) {
      this.draftAnchorCache = {
        sourceText: draftText,
        width: contentWidth,
        anchors: draftSourceRowAnchors(draftText, contentWidth, this.markdownTheme),
      };
    }
    return this.draftAnchorCache.anchors;
  }
  handleInput(data: string): boolean {
    if (
      !this.active ||
      (this.state.mode !== "preview" && !(this.options.splitActive?.() ?? false))
    ) {
      return false;
    }
    if (this.state.propertyInspector.presentation === "dedicated") return false;
    if (
      this.state.propertyInspector.expanded &&
      matchesKey(data, Key.shift("g"))
    ) return false;

    if (matchesKey(data, Key.up)) this.scrollView.scrollBy(-1);
    else if (matchesKey(data, Key.down)) this.scrollView.scrollBy(1);
    else if (matchesKey(data, Key.ctrl("u"))) {
      this.scrollView.scrollBy(
        -Math.max(1, Math.floor(this.scrollView.viewportHeight / 2)),
      );
    } else if (matchesKey(data, Key.ctrl("d"))) {
      this.scrollView.scrollBy(
        Math.max(1, Math.floor(this.scrollView.viewportHeight / 2)),
      );
    } else if (matchesKey(data, Key.pageUp)) {
      this.scrollView.scrollBy(-Math.max(1, this.scrollView.viewportHeight));
    } else if (matchesKey(data, Key.pageDown)) {
      this.scrollView.scrollBy(Math.max(1, this.scrollView.viewportHeight));
    } else if (matchesKey(data, "g")) this.scrollView.scrollToStart();
    else if (matchesKey(data, Key.shift("g"))) this.scrollView.scrollToEnd();
    else return false;

    return true;
  }

  private invalidatePendingDraftProjection(): void {
    clearTimeout(this.draftProjectionTimer);
    this.draftProjectionTimer = undefined;
    this.scheduledDraftText = undefined;
    this.draftProjectionRevision += 1;
  }

  private resetDraftProjectionState(): void {
    this.invalidatePendingDraftProjection();
    this.draftProjection = null;
    this.draftAnchorCache = null;
    this.failedDraftText = undefined;
    this.draftProjectionError = "";
  }

  private isCurrentDraftProjection(text: string, revision: number): boolean {
    return revision === this.draftProjectionRevision &&
      this.options.draftText?.() === text;
  }

  private finishDraftProjection(): void {
    this.scheduledDraftText = undefined;
    this.syncState();
    this.requestRender?.();
  }

  private scheduleDraftProjection(text: string): void {
    if (
      !this.options.projectDraft ||
      this.draftProjection?.inputText === text ||
      this.scheduledDraftText === text ||
      this.failedDraftText === text
    ) {
      return;
    }
    clearTimeout(this.draftProjectionTimer);
    this.scheduledDraftText = text;
    this.failedDraftText = undefined;
    this.draftProjectionError = "";
    const revision = ++this.draftProjectionRevision;
    this.draftProjectionTimer = setTimeout(() => {
      this.draftProjectionTimer = undefined;
      void this.options.projectDraft!(text).then((projection) => {
        if (!this.isCurrentDraftProjection(text, revision)) return;

        this.draftProjection = { ...projection, inputText: text };
        this.draftAnchorCache = null;
        this.draftProjectionError = "";
        this.finishDraftProjection();
      }).catch((error: unknown) => {
        if (!this.isCurrentDraftProjection(text, revision)) return;

        this.failedDraftText = text;
        this.draftProjectionError = error instanceof Error
          ? error.message
          : String(error);
        this.finishDraftProjection();
      });
    }, this.options.projectionDelayMs ?? 120);
  }

  syncState(width?: number): void {
    if (!this.active) return;

    const selected = this.state.context.selected;
    const selectionId = selected?.id ?? null;
    const selectionChanged = selectionId !== this.previousSelectionId;
    this.previousSelectionId = selectionId;

    const draftText = this.options.draftText?.() ?? null;
    if (selectionChanged && draftText !== null) this.resetDraftProjectionState();
    let sourceText: string;
    let rawText: string;
    let projectionRawText: string;
    let embedRanges: DetailState["embedRanges"];
    let workIdPrefix: string | null;
    if (draftText !== null) {
      this.scheduleDraftProjection(draftText);
      const projection = this.draftProjection?.inputText === draftText
        ? this.draftProjection
        : null;
      sourceText = projection?.sourceText ?? draftText;
      projectionRawText = projection?.rawText ?? draftText;
      rawText = projectionRawText;
      embedRanges = projection?.embedRanges ?? [];
      workIdPrefix = projection?.workIdPrefix ?? this.state.workIdPrefix;
    } else {
      this.resetDraftProjectionState();
      sourceText = selected
        ? this.state.resolvedSelectedText
        : "Select a block in the outliner pane.";
      projectionRawText = selected ? this.state.projectedSelectedText : sourceText;
      rawText = selected ? projectionRawText : sourceText;
      embedRanges = this.state.embedRanges;
      workIdPrefix = this.state.workIdPrefix;
    }
    const projectedTextBeforeMetadataRemoval = projectionRawText;
    const authoredCalloutSource = draftText ?? selected?.text ?? sourceText;
    const projectedEmbedRanges = embedRanges;
    let metadataRemoved = false;
    if (draftText === null && selected) {
      const filteredSourceText = propertyInspectorAuthoredText(sourceText);
      const filteredProjectionRawText = propertyInspectorAuthoredText(
        projectedTextBeforeMetadataRemoval,
      );
      metadataRemoved = filteredProjectionRawText !== projectedTextBeforeMetadataRemoval;
      if (metadataRemoved) {
        embedRanges = remapEmbedRangesAfterMetadataRemoval(
          projectedTextBeforeMetadataRemoval,
          embedRanges,
        );
      }
      sourceText = filteredSourceText;
      projectionRawText = filteredProjectionRawText;
      rawText = filteredProjectionRawText;
    }
    const renderedLineForAuthoredLine = (line: number): number => {
      const projected = projectedSourceLine(
        authoredCalloutSource,
        projectedEmbedRanges,
        line,
      );
      if (!metadataRemoved) return projected;
      return lineAfterMetadataRemoval(projectedTextBeforeMetadataRemoval, projected);
    };
    this.renderedFragmentSourceLine = this.state.targetFragmentId
      ? renderedLineForAuthoredLine(this.state.previewOffset)
      : 0;
    this.renderedAttentionSourceLine = this.state.attentionRevealSourceLine === null
      ? 0
      : renderedLineForAuthoredLine(this.state.attentionRevealSourceLine);

    const embedPresentation = `${this.state.embedBackgroundEnabled}:${
      embedRanges.map((range) => `${range.startLine}-${range.endLine}`).join(",")
    }`;
    const nextCalloutRegions = parseDetailCallouts(
      authoredCalloutSource,
      this.options.calloutTheme,
    );
    const calloutSourceChanged =
      authoredCalloutSource !== this.renderedCalloutSource &&
      (this.calloutRegions.length > 0 || nextCalloutRegions.length > 0);
    this.renderedCalloutSource = authoredCalloutSource;
    this.calloutRegions = nextCalloutRegions;
    const sourceChanged =
      sourceText !== this.renderedSourceText ||
      rawText !== this.renderedRawText ||
      workIdPrefix !== this.renderedWorkIdPrefix ||
      embedPresentation !== this.renderedEmbedPresentation ||
      this.draftProjectionError !== this.renderedDraftProjectionError;
    if (sourceChanged || calloutSourceChanged) {
      this.renderedSourceText = sourceText;
      this.renderedRawText = rawText;
      this.renderedWorkIdPrefix = workIdPrefix;
      this.renderedEmbedPresentation = embedPresentation;
      this.renderedDraftProjectionError = this.draftProjectionError;
      const document = selected
        ? renderPreviewDocument(
            sourceText,
            rawText,
            this.linksEnabled,
            workIdPrefix,
          )
        : sourceText;
      const renderedText = this.draftProjectionError
        ? `${document}\n\n> Draft preview error: ${
          sanitizeMarkdownDocument(this.draftProjectionError).replace(/\r?\n/g, " ")
        }`
        : document;
      this.renderedDocumentText = renderedText;
      this.renderedCalloutRegions = renderedAuthoredCallouts(
        this.calloutRegions,
        renderedText,
        renderedLineForAuthoredLine,
        this.options.calloutTheme,
      );
      this.markdown.setContent(
        renderedText,
        embedRanges,
        this.state.embedBackgroundEnabled,
        this.renderedCalloutRegions,
      );
    }
    const annotationGroups = draftText === null
      ? detailAnnotationGroups(
        this.state,
        renderedLineForAuthoredLine,
        this.renderedDocumentText.split(/\r?\n/).length,
      )
      : [];
    this.annotationPreview.setGroups(annotationGroups);
    const backlinksDocument = renderBacklinksDocument(this.state);
    if (backlinksDocument !== this.renderedBacklinksDocument) {
      this.renderedBacklinksDocument = backlinksDocument;
      this.backlinkMarkdown.setText(backlinksDocument);
    }
    const regions = this.state.propertyInspector.presentation === "dedicated"
      ? detailPropertyInspectorRegions(this.state)
      : [
        ...this.calloutRegions,
        ...detailAnnotationRegions(annotationGroups),
        ...detailPropertyInspectorRegions(this.state),
        ...detailBacklinkRegions(this.state),
      ];
    if (this.options.setRegions) this.options.setRegions(regions);
    else reconcilePreviewRegions(this.state.previewRegions, regions);
    const focusedProperty = this.state.previewRegions.regions.find((region) =>
      region.id === this.state.previewRegions.focusedRegionId &&
      (region.kind === "property-entry" || region.kind === "property-inspector")
    );
    const focusedPropertyId = focusedProperty?.id ?? null;
    if (
      focusedPropertyId !== null &&
      focusedPropertyId !== this.previousPropertyFocusedId
    ) {
      this.pendingPropertySelectionScroll = true;
    }
    this.previousPropertyFocusedId = focusedPropertyId;
    const focusedAnnotation = this.state.previewRegions.regions.find((region) =>
      region.id === this.state.previewRegions.focusedRegionId &&
      region.kind === "annotation"
    );
    const focusedAnnotationId = focusedAnnotation?.id ?? null;
    const focusedAnnotationExpanded = focusedAnnotation?.disclosure?.expanded;
    if (
      focusedAnnotationId !== null &&
      (
        focusedAnnotationId !== this.previousAnnotationFocusedId ||
        focusedAnnotationExpanded !== this.previousAnnotationFocusedExpanded
      )
    ) {
      this.pendingAnnotationSelectionScroll = true;
    }
    this.previousAnnotationFocusedId = focusedAnnotationId;
    this.previousAnnotationFocusedExpanded = focusedAnnotationExpanded;
    const backlinkSelectionChanged =
      this.state.backlinks.selectedIndex !== this.previousBacklinkSelectedIndex;
    if (
      this.state.backlinks.expanded &&
      (!this.previousBacklinksExpanded || backlinkSelectionChanged)
    ) {
      this.pendingBacklinkSelectionScroll = true;
    }
    this.previousBacklinksExpanded = this.state.backlinks.expanded;
    this.previousBacklinkSelectedIndex = this.state.backlinks.selectedIndex;
    const fragmentChanged =
      this.state.targetFragmentId !== this.previousTargetFragmentId ||
      this.state.previewOffset !== this.previousPreviewOffset;
    if (
      this.resetScroll ||
      selectionChanged ||
      fragmentChanged ||
      (sourceChanged && this.state.targetFragmentId)
    ) {
      this.pendingFragmentScroll = true;
    }
    this.previousTargetFragmentId = this.state.targetFragmentId;
    this.previousPreviewOffset = this.state.previewOffset;
    this.resetScroll = false;
    if (
      this.state.attentionRevealSourceLine !== this.previousAttentionRevealSourceLine &&
      this.state.attentionRevealSourceLine !== null
    ) {
      this.pendingAttentionScroll = true;
    }
    this.previousAttentionRevealSourceLine = this.state.attentionRevealSourceLine;
    if (width !== undefined) {
      this.syncInspectorDocument(this.scrollView.getContentWidth(width));
    }
  }

  private syncInspectorDocument(width: number): void {
    const document = renderPropertyInspectorDocument(this.state, width);
    if (
      document === this.renderedInspectorDocument &&
      width === this.renderedInspectorWidth
    ) return;
    this.renderedInspectorDocument = document;
    this.renderedInspectorWidth = width;
    this.inspectorMarkdown.setText(document);
    if (this.previousPropertyFocusedId !== null) {
      this.pendingPropertySelectionScroll = true;
    }
  }

  applyPendingFragmentScroll(width: number): boolean {
    if (this.state.propertyInspector.presentation === "dedicated") {
      this.pendingFragmentScroll = false;
      return false;
    }
    if (!this.pendingFragmentScroll) return false;
    if (this.scrollView.viewportHeight <= 0) {
      if (this.requestRender && !this.fragmentRenderScheduled) {
        this.fragmentRenderScheduled = true;
        setTimeout(() => {
          this.fragmentRenderScheduled = false;
          this.requestRender?.();
        }, 0);
      }
      return false;
    }
    const contentWidth = this.scrollView.getContentWidth(width);
    const inspectorLines =
      this.state.context.selected && !(this.options.splitActive?.() ?? false)
        ? this.inspectorMarkdown.render(contentWidth)
        : [];
    const renderedDocument = this.renderAnnotatedWithSourceLineRow(
      contentWidth,
      this.renderedFragmentSourceLine,
    );
    const arrangement = arrangeInlinePreview(renderedDocument.lines, inspectorLines);
    const contentHeight = arrangement.lines.length +
      1 + this.backlinkMarkdown.render(contentWidth).length;
    this.scrollView.updateLayout(contentHeight, this.scrollView.viewportHeight, () => {});
    this.pendingFragmentScroll = false;
    const previousScrollTop = this.scrollView.scrollTop;
    const fragmentRow = arrangement.mapAuthoredRow(renderedDocument.sourceLineRow);
    this.scrollView.scrollTo(
      this.state.targetFragmentId ? fragmentRow : 0,
    );
    return this.scrollView.scrollTop !== previousScrollTop;
  }

  private applyPendingAttentionScroll(width: number): boolean {
    if (
      !this.pendingAttentionScroll ||
      this.state.attentionRevealSourceLine === null ||
      this.scrollView.viewportHeight <= 0 ||
      this.state.propertyInspector.presentation === "dedicated"
    ) return false;
    const contentWidth = this.scrollView.getContentWidth(width);
    const inspectorLines =
      this.state.context.selected && !(this.options.splitActive?.() ?? false)
        ? this.inspectorMarkdown.render(contentWidth)
        : [];
    const renderedDocument = this.renderAnnotatedWithSourceLineRow(
      contentWidth,
      this.renderedAttentionSourceLine,
    );
    const arrangement = arrangeInlinePreview(renderedDocument.lines, inspectorLines);
    const contentHeight = arrangement.lines.length +
      1 + this.backlinkMarkdown.render(contentWidth).length;
    this.scrollView.updateLayout(contentHeight, this.scrollView.viewportHeight, () => {});
    this.pendingAttentionScroll = false;
    const previousScrollTop = this.scrollView.scrollTop;
    this.scrollView.scrollTo(arrangement.mapAuthoredRow(renderedDocument.sourceLineRow));
    return this.scrollView.scrollTop !== previousScrollTop;
  }

  ensureAnnotationSelectionVisible(width: number): boolean {
    if (
      !this.pendingAnnotationSelectionScroll ||
      this.scrollView.viewportHeight <= 0
    ) return false;
    this.pendingAnnotationSelectionScroll = false;
    const regionId = this.previousAnnotationFocusedId;
    if (!regionId) return false;
    const contentWidth = this.scrollView.getContentWidth(width);
    const annotated = this.annotationPreview.renderArrangement(contentWidth);
    const region = this.state.previewRegions.regions.find((candidate) =>
      candidate.id === regionId
    );
    const panelRow = region?.disclosure?.expanded
      ? annotated.panelRows.get(regionId)
      : undefined;
    const targetRow = panelRow ?? annotated.markerRows.get(regionId);
    if (targetRow === undefined) return false;
    const inspector = this.state.context.selected && !(this.options.splitActive?.() ?? false)
      ? this.inspectorMarkdown.render(contentWidth)
      : [];
    const arrangement = arrangeInlinePreview(annotated.lines, inspector);
    const backlinks = this.options.splitActive?.()
      ? []
      : this.backlinkMarkdown.render(contentWidth);
    const contentHeight = arrangement.lines.length +
      (backlinks.length > 0 ? backlinks.length + 1 : 0);
    this.scrollView.updateLayout(
      contentHeight,
      this.scrollView.viewportHeight,
      () => {},
    );
    const selectedRow = arrangement.mapAuthoredRow(targetRow);
    const previousScrollTop = this.scrollView.scrollTop;
    if (panelRow !== undefined) {
      this.scrollView.scrollTo(
        Math.max(0, selectedRow - Math.max(1, Math.floor(this.scrollView.viewportHeight / 3))),
      );
    } else if (selectedRow < previousScrollTop) {
      this.scrollView.scrollTo(selectedRow);
    } else if (selectedRow >= previousScrollTop + this.scrollView.viewportHeight) {
      this.scrollView.scrollTo(selectedRow - this.scrollView.viewportHeight + 1);
    }
    return this.scrollView.scrollTop !== previousScrollTop;
  }


  ensureBacklinkSelectionVisible(width: number): boolean {
    if (!this.pendingBacklinkSelectionScroll || this.scrollView.viewportHeight <= 0) return false;

    const contentWidth = this.scrollView.getContentWidth(width);
    const selectedLine = this.backlinkMarkdown.render(contentWidth)
      .findIndex((line) => line.includes("▶ ACTIVE"));
    if (selectedLine < 0) return false;

    this.pendingBacklinkSelectionScroll = false;
    const inspector = this.state.context.selected && !(this.options.splitActive?.() ?? false)
      ? this.inspectorMarkdown.render(contentWidth)
      : [];
    const selectedRow =
      arrangeInlinePreview(this.annotationPreview.render(contentWidth), inspector).lines.length +
      1 + selectedLine;
    const previousScrollTop = this.scrollView.scrollTop;
    if (selectedRow < previousScrollTop) {
      this.scrollView.scrollTo(selectedRow);
    } else if (selectedRow >= previousScrollTop + this.scrollView.viewportHeight) {
      this.scrollView.scrollTo(selectedRow - this.scrollView.viewportHeight + 1);
    }
    return this.scrollView.scrollTop !== previousScrollTop;
  }
  private ensurePropertySelectionVisible(width: number): boolean {
    if (
      !this.pendingPropertySelectionScroll ||
      this.scrollView.viewportHeight <= 0
    ) return false;
    const contentWidth = this.scrollView.getContentWidth(width);
    const selectedLine = this.inspectorMarkdown.render(contentWidth)
      .findIndex((line) => line.includes("▶ "));
    if (selectedLine < 0) {
      this.pendingPropertySelectionScroll = false;
      return false;
    }
    this.pendingPropertySelectionScroll = false;
    const inspector = this.inspectorMarkdown.render(contentWidth);
    const selectedRow =
      this.state.propertyInspector.presentation === "dedicated"
        ? selectedLine
        : arrangeInlinePreview(
            this.annotationPreview.render(contentWidth),
            inspector,
          ).inspectorStart + selectedLine;
    const previousScrollTop = this.scrollView.scrollTop;
    if (selectedRow < previousScrollTop) {
      this.scrollView.scrollTo(selectedRow);
    } else if (selectedRow >= previousScrollTop + this.scrollView.viewportHeight) {
      this.scrollView.scrollTo(
        selectedRow - this.scrollView.viewportHeight + 1,
      );
    }
    return this.scrollView.scrollTop !== previousScrollTop;
  }


  private applyPropertyInspectorScroll(): boolean {
    if (
      this.state.propertyInspector.presentation !== "dedicated" ||
      this.scrollView.viewportHeight <= 0
    ) return false;
    const previousScrollTop = this.scrollView.scrollTop;
    this.scrollView.scrollTo(this.state.propertyInspector.viewportOffset);
    return this.scrollView.scrollTop !== previousScrollTop;
  }

  override render(width: number): string[] {
    this.syncState(width);
    let lines = super.render(width);
    if (this.applyPendingFragmentScroll(width)) lines = super.render(width);
    if (this.applyPendingAttentionScroll(width)) lines = super.render(width);
    if (this.ensureBacklinkSelectionVisible(width)) lines = super.render(width);
    if (this.applyPropertyInspectorScroll()) lines = super.render(width);
    if (this.ensureAnnotationSelectionVisible(width)) lines = super.render(width);
    if (this.ensurePropertySelectionVisible(width)) lines = super.render(width);
    return lines;
  }
}
