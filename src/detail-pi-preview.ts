import type {ReaderDensity} from "./reader-chrome";
import { parsePropertyRecords } from "./properties";
import {documentFolds, revealFoldedLine, type DocumentFold} from './document-folds';
import type {Block} from "./types";
import {authoredResourceReferenceOccurrences} from "./resource-references";
import type {RenderedLink} from './rendered-links';
import { displayedResourceText, detailAnnotationGroups, sourceLineStarts, sourceLineAt, selectedAnnotationThread, annotationScopeLabel, type DetailAnnotationGroup } from "./detail-annotations";
import { detailPropertyInspectorRegions } from "./property-inspector";
import {
  Key,
  Markdown,
  matchesKey,
  ScrollView,
  sliceByColumn,
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
import { linkOutlinerMarkdown, outlinerLinkUri, resourceOccurrenceLink, resourceOccurrenceLinks } from "./outliner-links";
import {
  detailBlockTarget,
  detailResourceDescription,
  visibleBacklinkSources,
  type DetailState,
} from "./detail-controller";
import {
  previewRegionActionUri,
  reconcilePreviewRegions,
  parsePreviewRegionActionUri,
  type PreviewRegion,
  type PreviewRegionAction,
  type PreviewRegionState,
} from "./detail-preview-regions";
import {
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

export interface DetailReadPreviewDocument {
  previewRegions?: PreviewRegionState;
  sourceBlock?: Pick<Block,"id"|"revision"|"text">;
  preserveMetadata?: boolean;
  truncated?: boolean;
  canonicalText: string;
  resolvedText: string;
  projectedText: string;
  embedRanges: DetailState["embedRanges"];
  workIdPrefix: string | null;
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
  density?(): ReaderDensity;
  titleInFrame?(): boolean;
  destinationLabel?(): string;
  surfaceLabel?(): string;
  primaryFocused?(): boolean;
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

interface PreviewSelectionSource {
  text: string;
  sourceId: string;
  sourceVersion: string;
  sourceHash: string;
}

function previewSelectionSource(
  state: Readonly<DetailState>,
): PreviewSelectionSource | null {
  const selected = state.context.selected;
  if (selected) {
    return {
      text: selected.text,
      sourceId: selected.id,
      sourceVersion: selected.updatedAt,
      sourceHash: "",
    };
  }
  const description = detailResourceDescription(state);
  if (displayedResourceText(state) === null) return null;
  const pdf = description?.pdf;
  if (description && pdf) {
    return {
      text: pdf.markdown,
      sourceId: description.resource.id,
      sourceVersion: pdf.representation.id,
      sourceHash: pdf.representation.contentHash,
    };
  }
  const filesystem = description?.filesystem;
  if (description && filesystem) {
    return {
      text: filesystem.text,
      sourceId: description.resource.id,
      sourceVersion: filesystem.capturedAt,
      sourceHash: filesystem.contentHash,
    };
  }
  const web = description?.web;
  if (!description || !web) return null;
  return {
    text: web.markdown,
    sourceId: description.resource.id,
    sourceVersion: web.representation.id,
    sourceHash: web.representation.contentHash,
  };
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
  const source = previewSelectionSource(state);
  if (!source) return null;
  const target = state.mode === "comment"
    ? state.annotationDraft?.target
    : undefined;
  let anchor: {
    start: number;
    end: number;
    excerpt: string;
    contextBefore: string;
    contextAfter: string;
    sourceVersion: string;
    sourceHash: string;
  };
  if (
    target &&
    (target.anchor.kind === "text-quote" ||
      target.anchor.kind === "pdf-page-region") &&
    target.anchor.start !== null &&
    target.anchor.end !== null &&
    target.anchor.exact !== null &&
    target.anchor.prefix !== null &&
    target.anchor.suffix !== null
  ) {
    anchor = {
      start: target.anchor.start,
      end: target.anchor.end,
      excerpt: target.anchor.exact,
      contextBefore: target.anchor.prefix,
      contextAfter: target.anchor.suffix,
      sourceVersion: source.sourceVersion,
      sourceHash: source.sourceHash,
    };
  } else if (state.mode === "select") {
    const offsets = annotationSelectionOffsets(state);
    if (!offsets) return null;
    anchor = {
      ...offsets,
      excerpt: source.text.slice(offsets.start, offsets.end),
      contextBefore: "",
      contextAfter: "",
      sourceVersion: source.sourceVersion,
      sourceHash: source.sourceHash,
    };
  } else {
    return null;
  }
  return {
    markId: "local-annotation-selection",
    targetClientId: state.attention.targetClientId,
    target: {
      kind: "block",
      sourceBlockId: source.sourceId,
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
  resourceLinks: ReadonlyMap<number, string> = new Map(),
): string {
  const sanitizedSource = sanitizeMarkdownDocument(sourceText);
  // Sanitize authored text before generated links or presentation-only Markdown are added.
  return detailMarkdownPresentation(
    linkOutlinerMarkdown(
      sanitizedSource,
      sanitizeMarkdownDocument(rawText),
      workIdPrefix,
      linksEnabled,
      new Map([...resourceLinks].map(([offset, uri]) => [
        sanitizeMarkdownDocument(rawText.slice(0, offset)).length, uri,
      ])),
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

export function renderDetailReadPreview(
  input: DetailReadPreviewDocument,
  width: number,
  markdownTheme: MarkdownTheme,
  calloutTheme?: DetailCalloutTheme,
  linksEnabled = false,
  revealSourceLine?: number,
): {lines:string[]; sourceLineRow:(line:number)=>number} {
  const sourceText = input.preserveMetadata?input.resolvedText:propertyInspectorAuthoredText(input.resolvedText);
  const projectedText = input.preserveMetadata?input.projectedText:propertyInspectorAuthoredText(input.projectedText);
  const metadataRemoved = projectedText !== input.projectedText;
  const embedRanges = metadataRemoved
    ? remapEmbedRangesAfterMetadataRemoval(input.projectedText, input.embedRanges)
    : input.embedRanges;
  const renderedLineForAuthoredLine = (line: number): number => {
    const projectedLine = projectedSourceLine(input.canonicalText, input.embedRanges, line);
    return metadataRemoved
      ? lineAfterMetadataRemoval(input.projectedText, projectedLine)
      : projectedLine;
  };
  const document = renderPreviewDocument(
    sourceText,
    projectedText,
    linksEnabled,
    input.workIdPrefix,
    input.sourceBlock?resourceOccurrenceLinks(input.sourceBlock,projectedText,renderedLineForAuthoredLine):new Map(),
  );
  const callouts = renderedAuthoredCallouts(
    parseDetailCallouts(input.canonicalText, calloutTheme),
    document,
    renderedLineForAuthoredLine,
    calloutTheme,
  );
  // Picker thumbnails have no disclosure input; retain their plain reading layout.
  const folds = linksEnabled ? documentFolds(projectedText, embedRanges) : [];
  const previewRegions: PreviewRegionState = input.previewRegions ??= {
    regions: [],
    focusedRegionId: null,
    disclosureOverrides: new Map(),
  };
  reconcilePreviewRegions(previewRegions, [...folds, ...callouts]);
  if (revealSourceLine !== undefined) revealFoldedLine(previewRegions, [...folds, ...callouts], renderedLineForAuthoredLine(revealSourceLine));
  const markdown = new SourceSpannedMarkdown(
    markdownTheme,
    applyEmbedBackground,
    previewRegions,
    linksEnabled,
    calloutTheme,
  );
  markdown.setContent(document, embedRanges, true, callouts, folds);
  const metadataSpans = new Set(parsePropertyRecords(input.canonicalText).filter(record => record.scope === "block").map(record => record.start));
  const metadataLinks = input.preserveMetadata ? [] : authoredResourceReferenceOccurrences(input.canonicalText).flatMap(link => {
    if (link.kind !== "authored-resource") return [];
    if (link.reference.kind === "resource") return [`[${link.label}](${outlinerLinkUri("resource", link.reference.resourceId)})`];
    if (link.reference.kind !== "filesystem" || !input.sourceBlock || !metadataSpans.has(link.start)) return [];
    const target = resourceOccurrenceLink(input.sourceBlock, link);
    const label = sanitizeMarkdownDocument(link.label).replace(/([\\[\]`*_])/g, "\\$1");
    return [`[File: ${label}](${outlinerLinkUri(target.kind, target.value, target)})`];
  });
  const metadataRows = metadataLinks.length ? new Markdown(metadataLinks.join(" · "), 0, 0, markdownTheme).render(Math.max(1, width)) : [];
  return {lines:[...metadataRows, ...markdown.render(Math.max(1, width))],
    sourceLineRow:line=>metadataRows.length+markdown.sourceLineRow(Math.max(1,width),renderedLineForAuthoredLine(line))};
}

/** Static thumbnails and interactive readers use the same document layout. */
export function renderDetailReadPreviewLines(input: DetailReadPreviewDocument, width: number, markdownTheme: MarkdownTheme,
  calloutTheme?: DetailCalloutTheme, linksEnabled = false): string[] {
  return renderDetailReadPreview(input,width,markdownTheme,calloutTheme,linksEnabled).lines;
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
  const lines = authored.slice(0, titleEnd);
  if (titleEnd > 0) lines.push("");
  const inspectorStart = lines.length;
  lines.push(...inspector);
  const renderedBodyStart = lines.length + (bodyStart < authored.length ? 1 : 0);
  if (bodyStart < authored.length) lines.push("", ...authored.slice(bodyStart));
  return {
    lines,
    inspectorStart,
    mapAuthoredRow: (row) =>
      row < bodyStart ? Math.min(row, titleEnd) : renderedBodyStart + row - bodyStart,
    authoredRowAt: (row) => {
      if (row < 0 || row >= lines.length) return null;
      if (row < titleEnd) return row;
      if (row >= renderedBodyStart) return bodyStart + row - renderedBodyStart;
      return null;
    },
  };
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
  placement: DetailAnnotationGroup["placement"],
  selected: boolean,
  scope: string,
): string[] {
  const panelWidth = Math.max(1, width);
  const title =
    ` ${selected ? "▶ " : ""}Comment ${index + 1} · ${thread.source} · ${placement === "inline" ? thread.currentResolution.status : placement} · ${thread.lifecycle} `;
  const top = truncateToWidth(
    `╭${title}${"─".repeat(Math.max(0, panelWidth - visibleWidth(title) - 1))}`,
    panelWidth,
  );
  const action = (label: string, type: "annotation.thread.select" | "annotation.thread.reply" | "annotation.thread.lifecycle") =>
    `[${label}](${previewRegionActionUri({ type, annotationId: thread.block.id })})`;
  const navigation = (label: string, delta: -1 | 1) =>
    `[${label}](${previewRegionActionUri({ type: "annotation.thread.move", delta })})`;
  const body = [
    `${navigation("‹", -1)} ${action("Select", "annotation.thread.select")} ${navigation("›", 1)} · ${action("Reply", "annotation.thread.reply")} · ${action(thread.lifecycle === "open" ? "Resolve" : "Reopen", "annotation.thread.lifecycle")}`,
    `${thread.source} · ${placement === "inline" ? thread.currentResolution.status : placement} · ${thread.lifecycle}`,
    scope,
    "",
    ...thread.body.split(/\r?\n/).map(escapeGeneratedMarkdown),
  ];
  if (placement === "unpositioned") {
    const anchor = thread.originalTarget.anchor;
    if ("exact" in anchor && anchor.exact) {
      body.splice(3, 0, ...anchor.exact.split(/\r?\n/).map((line) => `> ${escapeGeneratedMarkdown(line)}`), "");
    }
    body.push("", `[Open thread](${outlinerLinkUri("block", thread.block.id)})`);
  }
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
      Array<{ regionId: string; groupId: string; lines: string[] }>
    >();
    for (const group of this.groups) {
      if (group.placement !== "inline") continue;
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
      const existing = insertions.get(insertionRow) ?? [];
      for (const thread of group.threads) {
        existing.push({
          regionId: `annotation-thread:${thread.block.id}`, groupId: group.regionId,
          lines: annotationPanelLines(thread, this.groups.flatMap(group => group.threads).indexOf(thread),
            contentWidth, this.theme, group.placement, selectedAnnotationThread(this.state)?.block.id === thread.block.id, annotationScopeLabel(thread, this.state)),
        });
      }
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
        if (!panelRows.has(panel.groupId)) panelRows.set(panel.groupId, lines.length);
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
    for (const group of this.groups.filter((candidate) => candidate.placement !== "inline")) {
      const region = this.state.previewRegions.regions.find((candidate) => candidate.id === group.regionId);
      const symbol = region?.disclosure?.expanded ? "−" : "+";
      const heading = new Markdown(
        `[${symbol} ${group.placement === "general" ? "Note comments" : "Unpositioned comments"} (${group.threads.length})](${previewRegionActionUri({
          type: "annotation.disclosure.toggle", regionId: group.regionId,
        })})`, 0, 0, this.theme,
      ).render(outerWidth);
      lines.push("");
      markdownRows.push(null);
      markerRows.set(group.regionId, lines.length);
      for (const line of heading) {
        lines.push(this.state.previewRegions.focusedRegionId === group.regionId ? highlightActiveSelection(line) : line);
        markdownRows.push(null);
      }
      if (!region?.disclosure?.expanded) continue;
      panelRows.set(group.regionId, lines.length);
      for (const thread of group.threads) {
        panelRows.set(`annotation-thread:${thread.block.id}`, lines.length);
        const panel = annotationPanelLines(thread, this.groups.flatMap(group => group.threads).indexOf(thread), outerWidth,
          this.theme, group.placement, selectedAnnotationThread(this.state)?.block.id === thread.block.id, annotationScopeLabel(thread, this.state));
        lines.push(...panel);
        markdownRows.push(...panel.map(() => null));
      }
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

function detailAnnotationRegions(
  groups: readonly DetailAnnotationGroup[],
): PreviewRegion[] {
  return groups.flatMap((group): PreviewRegion[] => [{
    id: group.regionId, kind: "annotation", sourceSpan: group.sourceSpan, parentId: null,
    childIds: group.threads.map(thread => `annotation-thread:${thread.block.id}`),
    focusable: true, disclosure: { defaultExpanded: false, expanded: false },
    activation: { type: "annotation.disclosure.toggle", regionId: group.regionId },
  }, ...group.threads.map((thread): PreviewRegion => ({
    id: `annotation-thread:${thread.block.id}`, kind: "annotation-thread", sourceSpan: group.sourceSpan,
    parentId: group.regionId, childIds: [], focusable: true, disclosure: null,
    activation: { type: "annotation.thread.select", annotationId: thread.block.id },
  }))]);
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
    private readonly decorateBody: (lines:string[],width:number)=>string[],
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
    const selectionSource = previewSelectionSource(this.state);
    const authored = decorateAttentionLines(
      this.decorateBody(this.authored.render(width),width),
      annotationSelectionMark(this.state) ??
        currentAttentionMark(this.state.attention, detailBlockTarget(this.state)?.blockId ?? null),
      width,
      selectionSource?.text,
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
      density: this.options.splitActive?.() ? "expanded" : this.options.density?.() ?? "compact",
      titleInFrame: this.options.titleInFrame?.(),
      propertyKeys: this.options.headerPropertyKeys,
      destinationLabel: this.options.destinationLabel?.(),
    };
    const split = this.options.splitActive?.() ?? false;
    if (this.state.propertyInspector.presentation === "dedicated") {
      header.surface = "Properties";
      header.focused = true;
    } else if (split) {
      const focused = this.options.focused?.() ?? false;
      header.surface = `${focused ? "●" : "○"} Draft`;
      header.focused = focused;
    } else if (this.options.surfaceLabel) {
      header.surface = this.options.surfaceLabel();
      header.focused = this.options.primaryFocused?.() ?? true;
    } else if (this.options.primaryFocused) {
      const focused = this.options.primaryFocused();
      header.surface = `${focused ? "●" : "○"} Detail`;
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
      this.options.splitActive?.() ? "expanded" : this.options.density?.() ?? "compact",
    );
  }

  invalidate(): void {}
}

interface AuthoredCalloutParse {
  readonly source: string;
  readonly regions: DetailCalloutRegion[];
}

export class DetailPiPreviewLayout extends VStack {
  readonly markdown: SourceSpannedMarkdown;
  private readonly annotationPreview: DetailAnnotationPreview;
  readonly inspectorMarkdown: Markdown;
  readonly backlinkMarkdown: Markdown;
  readonly scrollView: ScrollView;
  private readonly body: DetailPreviewBody;
  private bodyLinks = new Map<string, RenderedLink[]>();
  private bodyRegions: PreviewRegion[] = [];
  private previousBodyFocusedId: string | null = null;
  private previousFocusWidth: number | undefined;
  private pendingBodyFocusScroll = false;
  private renderedSourceText: string | undefined;
  private renderedBlockRevision: number | undefined;
  private renderedBlockId: string | undefined;
  private renderedRawText: string | undefined;
  private renderedReferencesReady: boolean | undefined;
  private renderedWorkIdPrefix: string | null | undefined;
  private renderedBacklinksDocument: string | undefined;
  private renderedInspectorDocument: string | undefined;
  private renderedInspectorWidth: number | undefined;
  private renderedEmbedPresentation: string | undefined;
  private renderedDraftProjectionError: string | undefined;
  private authoredCallouts: AuthoredCalloutParse | undefined;
  private renderedCalloutRegions: DetailCalloutRegion[] = [];
  private documentFoldRegions: DocumentFold[] = [];
  private readerAnchorCache: {key:string; lines:number[]; rows:Map<number,number>; renderedCount:number} | null = null;
  private renderedLineForSourceLine = (line: number) => line;
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
  private fragmentScrollTop: number | null = null;
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
      {...markdownTheme, linkUrl:()=>""},
      applyEmbedBackground,
      state.previewRegions,
      linksEnabled,
      options.calloutTheme,
      true,
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
      () => Boolean(state.context.selected) && !(options.splitActive?.() ?? false) && ((options.density?.() ?? "compact") === "expanded" || state.propertyInspector.expanded),
      () => !(options.splitActive?.() ?? false) && ((options.density?.() ?? "compact") === "expanded" || state.backlinks.expanded),
      (lines,width) => this.highlightBodyFocus(lines,width),
    );
    const scrollView = new ScrollView(body, {
      primary: true,
      follow: "none",
      scrollbar: "always",
    });
    super([
      {
        component: new DetailPreviewHeader(state, linksEnabled, options),
        basis: "auto",
        shrink: 0,
      },
      { component: scrollView, grow: 1, shrink: 1, minSize: 1 },
      { component: new DetailPreviewFooter(state, options), basis: "auto", shrink: 0 },
    ]);
    this.markdown = markdown;
    this.annotationPreview = annotationPreview;
    this.inspectorMarkdown = inspectorMarkdown;
    this.backlinkMarkdown = backlinkMarkdown;
    this.scrollView = scrollView;
    this.body = body;
    this.active = state.mode === "preview";
  }

  headerHeight(width: number): number {
    return new DetailPreviewHeader(this.state, this.linksEnabled, this.options).render(width).length;
  }

  footerHeight(width: number): number {
    return new DetailPreviewFooter(this.state, this.options).render(width).length;
  }

  private showInspector(): boolean {
    return this.state.propertyInspector.presentation === "dedicated" || this.state.propertyInspector.expanded || (this.options.density?.() ?? "compact") === "expanded";
  }

  private inspectorLines(width: number): string[] {
    return this.showInspector() ? this.inspectorMarkdown.render(width) : [];
  }

  private showBacklinks(): boolean {
    return this.state.backlinks.expanded || (this.options.density?.() ?? "compact") === "expanded";
  }

  private backlinkLines(width: number): string[] {
    return this.showBacklinks() ? this.backlinkMarkdown.render(width) : [];
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

  private resourceMarkdownEndRow(annotated: AnnotationPreviewArrangement): number | null {
    if (this.state.context.selected) return null;
    const description = detailResourceDescription(this.state);
    const markdown = description?.pdf?.markdown ??
      description?.web?.markdown ??
      description?.filesystem?.text;
    if (markdown === undefined) return null;
    return this.markdown.sourceLineRow(
      annotated.contentWidth,
      markdown.split(/\r?\n/).length,
      annotated.markdownLines.length,
    );
  }

  sourceLineAtScroll(width: number): number | null {
    const sourceText = previewSelectionSource(this.state)?.text;
    if (!sourceText) return null;
    const contentWidth = this.scrollView.getContentWidth(width);
    const annotated = this.annotationPreview.renderArrangement(contentWidth);
    const resourceEndRow = this.resourceMarkdownEndRow(annotated);
    if (
      resourceEndRow !== null &&
      this.scrollView.scrollTop >= annotated.mapMarkdownRow(resourceEndRow)
    ) return null;
    const inspector = this.state.context.selected && !(this.options.splitActive?.() ?? false)
      ? arrangeInlinePreview(annotated.lines,this.inspectorLines(contentWidth)) : null;
    return this.readerSourceAnchorAtRow(sourceText,annotated.contentWidth,this.scrollView.scrollTop,
      row=>inspector?.mapAuthoredRow(annotated.mapMarkdownRow(row)) ?? annotated.mapMarkdownRow(row))?.line ?? null;
  }

  /** Presentation changes must keep the same authored passage at the top. */
  preserveReadingPosition(width: number, height: number, change: () => void): void {
    const line = this.sourceLineAtScroll(width);
    const sourceRow = (): number => {
      const contentWidth = this.scrollView.getContentWidth(width);
      const annotated = this.renderAnnotatedWithSourceLineRow(contentWidth, this.renderedLineForSourceLine(line!));
      const inspector = this.state.context.selected && !(this.options.splitActive?.() ?? false)
        ? this.inspectorLines(contentWidth) : [];
      return arrangeInlinePreview(annotated.lines, inspector).mapAuthoredRow(annotated.sourceLineRow);
    };
    const offset = line === null ? null : this.scrollView.scrollTop - sourceRow();
    change();
    this.syncState(width);
    this.ensureFocusVisible(width, height);
    if (offset !== null) this.scrollView.scrollTo(sourceRow() + offset);
  }

  /** Locate one visible source line lazily, rather than render every prefix on each pointer event. */
  private readerSourceAnchorAtRow(sourceText:string,width:number,targetRow:number,mapRow=(row:number)=>row):{line:number;row:number}|null {
    if (!this.documentFoldRegions.length) {
      const rows=draftSourceRowAnchors(sourceText,width,this.markdownTheme);
      const line=nearestDraftSourceLine(rows.map(mapRow),targetRow);
      return line===null?null:{line,row:rows[line]!};
    }
    const key=JSON.stringify([width,sourceText,this.renderedRawText,this.renderedEmbedPresentation,[...this.state.previewRegions.disclosureOverrides]]);
    if(this.readerAnchorCache?.key!==key){
      const visible=this.markdown.visibleSourceLines();
      const lines=sourceText.split(/\r?\n/).flatMap((_,line)=>!visible||visible.has(this.renderedLineForSourceLine(line))?[line]:[]);
      this.readerAnchorCache={key,lines,rows:new Map(),renderedCount:this.markdown.render(width).length};
    }
    const cache=this.readerAnchorCache;
    const rowAt=(index:number)=>{
      const line=cache.lines[index]!;
      let row=cache.rows.get(line);
      if(row===undefined){row=this.markdown.sourceLineRow(width,this.renderedLineForSourceLine(line),cache.renderedCount);cache.rows.set(line,row);}
      return row;
    };
    if(!cache.lines.length)return null;
    let low=0,high=cache.lines.length;
    while(low+1<high){const middle=(low+high)>>>1;if(mapRow(rowAt(middle))<=targetRow)low=middle;else high=middle;}
    return {line:cache.lines[low]!,row:rowAt(low)};
  }

  sourcePointAtViewport(
    viewportRow: number,
    viewportColumn: number,
    width: number,
  ): { row: number; column: number } | null {
    const sourceText = previewSelectionSource(this.state)?.text;
    if (!sourceText) return null;
    const contentWidth = this.scrollView.getContentWidth(width);
    const annotated = this.annotationPreview.renderArrangement(contentWidth);
    const inlineInspector = Boolean(this.state.context.selected) &&
      !(this.options.splitActive?.() ?? false);
    const arrangement = arrangeInlinePreview(
      annotated.lines,
      inlineInspector ? this.inspectorLines(contentWidth) : [],
    );
    const sourceLines = sourceText.split(/\r?\n/);
    if (viewportRow < this.headerHeight(width)) return null;
    const bodyRow = this.scrollView.scrollTop + viewportRow - this.headerHeight(width);
    const annotatedRow = arrangement.authoredRowAt(bodyRow);
    if (annotatedRow === null) return null;
    const markdownRow = annotated.markdownRowAt(annotatedRow);
    if (markdownRow === null) return null;
    const resourceEndRow = this.resourceMarkdownEndRow(annotated);
    if (resourceEndRow !== null && markdownRow >= resourceEndRow) return null;
    const anchor = this.readerSourceAnchorAtRow(sourceText,annotated.contentWidth,markdownRow);
    if (!anchor) return null;
    const sourceLine = anchor.line;
    const markdownAnchor = anchor.row;
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
        // Generated disclosure or transformed text is not an exact source range.
        if (this.documentFoldRegions.length) return null;
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
    const target = this.state.target;
    const selectedWeb = detailResourceDescription(this.state)?.web;
    const selectionId = target?.kind === "resource"
      ? `resource:${target.resourceId}:representation:${selectedWeb?.representation.id ?? "none"}`
      : selected?.id ?? null;
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
      const hasDocument = selected !== null ||
        (this.state.document.kind === "ready" &&
          this.state.document.document.kind === "resource");
      sourceText = hasDocument
        ? this.state.resolvedSelectedText
        : this.state.document.kind === "loading"
          ? "Loading target…"
          : this.state.document.kind === "failed"
            ? this.state.document.message
            : "Select a block or resource in the outliner pane.";
      projectionRawText = hasDocument ? this.state.projectedSelectedText : sourceText;
      rawText = hasDocument ? projectionRawText : sourceText;
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
    this.renderedLineForSourceLine = renderedLineForAuthoredLine;
    this.renderedFragmentSourceLine = detailBlockTarget(this.state)?.fragmentId
      ? renderedLineForAuthoredLine(this.state.previewOffset)
      : 0;
    this.renderedAttentionSourceLine = this.state.attentionRevealSourceLine === null
      ? 0
      : renderedLineForAuthoredLine(this.state.attentionRevealSourceLine);

    const embedPresentation = `${this.state.embedBackgroundEnabled}:${
      embedRanges.map((range) => `${range.startLine}-${range.endLine}`).join(",")
    }`;
    const previousAuthoredCallouts = this.authoredCallouts;
    const authoredCallouts = previousAuthoredCallouts?.source === authoredCalloutSource
      ? previousAuthoredCallouts
      : {
          source: authoredCalloutSource,
          regions: parseDetailCallouts(
            authoredCalloutSource,
            this.options.calloutTheme,
          ),
        };
    this.authoredCallouts = authoredCallouts;
    const calloutSourceChanged =
      authoredCallouts !== previousAuthoredCallouts &&
      ((previousAuthoredCallouts?.regions.length ?? 0) > 0 ||
        authoredCallouts.regions.length > 0);
    const referencesReady = draftText !== null || this.state.readStatus === "ready";
    const sourceChanged =
      sourceText !== this.renderedSourceText ||
      selected?.revision !== this.renderedBlockRevision ||
      selected?.id !== this.renderedBlockId ||
      rawText !== this.renderedRawText ||
      referencesReady !== this.renderedReferencesReady ||
      workIdPrefix !== this.renderedWorkIdPrefix ||
      embedPresentation !== this.renderedEmbedPresentation ||
      this.draftProjectionError !== this.renderedDraftProjectionError;
    if (sourceChanged || calloutSourceChanged) {
      this.renderedSourceText = sourceText;
      this.renderedBlockRevision = selected?.revision;
      this.renderedBlockId = selected?.id;
      this.renderedRawText = rawText;
      this.renderedReferencesReady = referencesReady;
      this.renderedWorkIdPrefix = workIdPrefix;
      this.renderedEmbedPresentation = embedPresentation;
      this.renderedDraftProjectionError = this.draftProjectionError;
      const document = !selected
        ? renderPreviewDocument(sourceText, sourceText, true, workIdPrefix)
        : referencesReady
        ? renderPreviewDocument(
            sourceText,
            rawText,
            true,
            workIdPrefix,
            draftText === null
              ? resourceOccurrenceLinks(selected, rawText, renderedLineForAuthoredLine)
              : new Map(),
          )
        : detailMarkdownPresentation(sanitizeMarkdownDocument(sourceText));
      const renderedText = this.draftProjectionError
        ? `${document}\n\n> Draft preview error: ${
          sanitizeMarkdownDocument(this.draftProjectionError).replace(/\r?\n/g, " ")
        }`
        : document;
      this.renderedCalloutRegions = renderedAuthoredCallouts(
        authoredCallouts.regions,
        renderedText,
        renderedLineForAuthoredLine,
        this.options.calloutTheme,
      );
      this.documentFoldRegions = draftText === null && referencesReady ? documentFolds(rawText, embedRanges) : [];
      this.markdown.setContent(
        renderedText,
        embedRanges,
        this.state.embedBackgroundEnabled,
        this.renderedCalloutRegions,
        this.documentFoldRegions,
      );
    }
    const annotationGroups = draftText === null
      ? detailAnnotationGroups(
        this.state,
        renderedLineForAuthoredLine,
        sourceText.split(/\r?\n/).length,
        sourceText,
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
        ...this.documentFoldRegions.map(region => {
          const callout = this.renderedCalloutRegions.filter(callout => callout.headerLine < region.sourceSpan!.startLine && callout.sourceSpan!.endLine >= region.sourceSpan!.endLine).at(-1);
          const parent = this.documentFoldRegions.find(fold => fold.id === region.parentId);
          return callout && (!parent || callout.headerLine >= parent.contentStartLine) ? {...region, parentId:callout.id} : region;
        }),
        ...authoredCallouts.regions.map(region => {
          if (region.parentId) return region;
          const line = this.renderedCalloutRegions.find(rendered => rendered.id === region.id)?.headerLine;
          const parent = line === undefined ? undefined : this.documentFoldRegions.filter(fold => fold.contentStartLine <= line && fold.sourceSpan!.endLine >= line).at(-1);
          return parent ? {...region, parentId:parent.id} : region;
        }),
        ...this.bodyRegions,
        ...detailAnnotationRegions(annotationGroups),
        ...(this.showInspector() ? detailPropertyInspectorRegions(this.state) : []),
        ...(this.showBacklinks() ? detailBacklinkRegions(this.state) : []),
      ];
    if (this.options.setRegions) this.options.setRegions(regions);
    else reconcilePreviewRegions(this.state.previewRegions, regions, this.state.document.kind === 'loading' || (this.state.document.kind === 'ready' && this.state.readStatus === 'pending'));
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
      (region.kind === "annotation" || region.kind === "annotation-thread")
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
      const group = annotationGroups.find(group => group.regionId === focusedAnnotationId || group.threads.some(thread => `annotation-thread:${thread.block.id}` === focusedAnnotationId));
      if (group?.placement === 'inline') revealFoldedLine(this.state.previewRegions, [...this.documentFoldRegions, ...this.renderedCalloutRegions], group.startLine);
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
    const fragmentId = detailBlockTarget(this.state)?.fragmentId;
    const fragmentChanged =
      fragmentId !== this.previousTargetFragmentId ||
      this.state.previewOffset !== this.previousPreviewOffset;
    if (
      this.resetScroll ||
      selectionChanged ||
      fragmentChanged ||
      (sourceChanged && fragmentId && this.scrollView.scrollTop === this.fragmentScrollTop)
    ) {
      this.pendingFragmentScroll = true;
      if (fragmentId) revealFoldedLine(this.state.previewRegions, [...this.documentFoldRegions, ...this.renderedCalloutRegions], this.renderedFragmentSourceLine);
    }
    this.previousTargetFragmentId = fragmentId;
    this.previousPreviewOffset = this.state.previewOffset;
    this.resetScroll = false;
    if (
      this.state.attentionRevealSourceLine !== this.previousAttentionRevealSourceLine &&
      this.state.attentionRevealSourceLine !== null
    ) {
      this.pendingAttentionScroll = true;
      revealFoldedLine(this.state.previewRegions, [...this.documentFoldRegions, ...this.renderedCalloutRegions], this.renderedAttentionSourceLine);
    }
    this.previousAttentionRevealSourceLine = this.state.attentionRevealSourceLine;
    if (width !== undefined) {
      this.syncInspectorDocument(this.scrollView.getContentWidth(width));
      this.syncBodyLinks(width, regions);
      if(this.previousFocusWidth!==width && this.state.previewRegions.focusedRegionId){
        this.scheduleFocusedRegionScroll();
      }
      this.previousFocusWidth=width;
    }
  }

  private syncBodyLinks(width:number, regions:readonly PreviewRegion[]):void {
    this.bodyLinks.clear();
    this.bodyRegions=[];
    if (this.state.propertyInspector.presentation === "dedicated") return;
    const contentWidth=this.scrollView.getContentWidth(width);
    const annotated=this.annotationPreview.renderArrangement(contentWidth);
    const calloutRows=new Map<string,number>();
    for(const link of this.markdown.renderedLinks){
      if(link.uri.startsWith("pi-outliner-detail:")){
        const action=parsePreviewRegionActionUri(link.uri);
        if(action?.type==="callout.disclosure.toggle" || action?.type==="document.disclosure.toggle") {
          if (!calloutRows.has(action.regionId)) calloutRows.set(action.regionId,annotated.mapMarkdownRow(link.row));
          const spans = this.bodyLinks.get(action.regionId) ?? [];
          spans.push({...link,row:annotated.mapMarkdownRow(link.row),column:link.column+contentWidth-annotated.contentWidth});
          this.bodyLinks.set(action.regionId,spans);
        }
      }
      if(!/^(pi-outliner:|https?:)/.test(link.uri))continue;
      const id=`body-link:${link.occurrenceId??`${link.uri}:${link.row}:${link.column}`}`;
      if(!this.bodyLinks.has(id))this.bodyRegions.push({id,kind:"body-link",sourceSpan:null,parentId:null,childIds:[],focusable:true,disclosure:null,activation:{type:"link.open",uri:link.uri}});
      const spans=this.bodyLinks.get(id)??[];
      spans.push({...link,row:annotated.mapMarkdownRow(link.row),column:link.column+contentWidth-annotated.contentWidth});
      this.bodyLinks.set(id,spans);
    }
    const inspector=this.state.context.selected && !(this.options.splitActive?.()??false)?this.inspectorLines(contentWidth):[];
    const arrangement=arrangeInlinePreview(annotated.lines,inspector);
    const row=(region:PreviewRegion):number=>{
      const link=this.bodyLinks.get(region.id)?.[0];
      if(link)return arrangement.mapAuthoredRow(link.row);
      if(region.kind.startsWith("property-"))return arrangement.inspectorStart;
      if(region.kind.startsWith("backlink"))return arrangement.lines.length+1;
      const annotation=annotated.panelRows.get(region.id)??annotated.markerRows.get(region.id);
      if(annotation!==undefined)return arrangement.mapAuthoredRow(annotation);
      const calloutRow=calloutRows.get(region.id);
      return calloutRow!==undefined?arrangement.mapAuthoredRow(calloutRow):0;
    };
    const ordered=[...regions.filter(region=>region.kind!=="body-link"),...this.bodyRegions]
      .map(region=>({region,row:row(region)})).sort((a,b)=>a.row-b.row).map(entry=>entry.region);
    if(this.options.setRegions)this.options.setRegions(ordered);
    else reconcilePreviewRegions(this.state.previewRegions,ordered, this.state.document.kind === 'loading' || (this.state.document.kind === 'ready' && this.state.readStatus === 'pending'));
    const focused=this.state.previewRegions.focusedRegionId;
    if(focused&&this.bodyLinks.has(focused)&&focused!==this.previousBodyFocusedId)this.pendingBodyFocusScroll=true;
    this.previousBodyFocusedId=focused;
  }

  private highlightBodyFocus(lines:string[],width:number):string[]{
    const focused=this.state.previewRegions.focusedRegionId;
    const links=focused?this.bodyLinks.get(focused):undefined;
    if(!links)return lines;
    const result=[...lines];
    for(const link of links){
      const line=result[link.row];if(line===undefined)continue;
      result[link.row]=sliceByColumn(line,0,link.column,true)+highlightActiveSelection(sliceByColumn(line,link.column,link.width,true))+sliceByColumn(line,link.column+link.width,Math.max(0,width-link.column-link.width),true);
    }
    return result;
  }

  /** Called by both Pi's layout engine and direct component rendering. */
  ensureFocusVisible(width:number,height?:number):boolean {
    if(height!==undefined){
      const viewportHeight=Math.max(1,height-this.headerHeight(width)-this.footerHeight(width));
      if(viewportHeight!==this.scrollView.viewportHeight&&this.state.previewRegions.focusedRegionId){
        this.scheduleFocusedRegionScroll();
      }
      this.scrollView.updateLayout(this.body.render(this.scrollView.getContentWidth(width)).length,viewportHeight,()=>{});
    }
    let changed=this.ensureBacklinkSelectionVisible(width);
    changed=this.ensureAnnotationSelectionVisible(width)||changed;
    changed=this.ensurePropertySelectionVisible(width)||changed;
    if(!this.pendingBodyFocusScroll||this.scrollView.viewportHeight<=0)return changed;
    this.pendingBodyFocusScroll=false;
    const link=this.bodyLinks.get(this.state.previewRegions.focusedRegionId??"")?.[0];
    if(!link)return changed;
    const contentWidth=this.scrollView.getContentWidth(width);
    const inspector=this.state.context.selected&&!(this.options.splitActive?.()??false)?this.inspectorLines(contentWidth):[];
    const arrangement=arrangeInlinePreview(this.annotationPreview.render(contentWidth),inspector);
    const row=arrangement.mapAuthoredRow(link.row);
    const before=this.scrollView.scrollTop;
    if(row<before)this.scrollView.scrollTo(row);
    else if(row>=before+this.scrollView.viewportHeight)this.scrollView.scrollTo(row-this.scrollView.viewportHeight+1);
    return changed||before!==this.scrollView.scrollTop;
  }

  private scheduleFocusedRegionScroll(): void {
    const focused = this.state.previewRegions.regions.find(
      region => region.id === this.state.previewRegions.focusedRegionId,
    );
    switch (focused?.kind) {
      case "document-fold":
      case "callout":
      case "body-link": this.pendingBodyFocusScroll = true; break;
      case "property-entry":
      case "property-inspector": this.pendingPropertySelectionScroll = true; break;
      case "annotation":
      case "annotation-thread": this.pendingAnnotationSelectionScroll = true; break;
      case "backlink-source": this.pendingBacklinkSelectionScroll = true; break;
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
        ? this.inspectorLines(contentWidth)
        : [];
    const renderedDocument = this.renderAnnotatedWithSourceLineRow(
      contentWidth,
      this.renderedFragmentSourceLine,
    );
    const arrangement = arrangeInlinePreview(renderedDocument.lines, inspectorLines);
    const contentHeight = arrangement.lines.length +
      1 + this.backlinkLines(contentWidth).length;
    this.scrollView.updateLayout(contentHeight, this.scrollView.viewportHeight, () => {});
    this.pendingFragmentScroll = false;
    const previousScrollTop = this.scrollView.scrollTop;
    const fragmentRow = arrangement.mapAuthoredRow(renderedDocument.sourceLineRow);
    this.scrollView.scrollTo(
      detailBlockTarget(this.state)?.fragmentId ? fragmentRow : 0,
    );
    this.fragmentScrollTop = this.scrollView.scrollTop;
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
        ? this.inspectorLines(contentWidth)
        : [];
    const renderedDocument = this.renderAnnotatedWithSourceLineRow(
      contentWidth,
      this.renderedAttentionSourceLine,
    );
    const arrangement = arrangeInlinePreview(renderedDocument.lines, inspectorLines);
    const contentHeight = arrangement.lines.length +
      1 + this.backlinkLines(contentWidth).length;
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
    const panelRow = region?.kind === "annotation-thread" || region?.disclosure?.expanded
      ? annotated.panelRows.get(regionId)
      : undefined;
    const targetRow = panelRow ?? annotated.markerRows.get(regionId);
    if (targetRow === undefined) return false;
    const inspector = this.state.context.selected && !(this.options.splitActive?.() ?? false)
      ? this.inspectorLines(contentWidth)
      : [];
    const arrangement = arrangeInlinePreview(annotated.lines, inspector);
    const backlinks = this.options.splitActive?.()
      ? []
      : this.backlinkLines(contentWidth);
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
    const selectedLine = this.backlinkLines(contentWidth)
      .findIndex((line) => line.includes("▶ ACTIVE"));
    if (selectedLine < 0) return false;

    this.pendingBacklinkSelectionScroll = false;
    const inspector = this.state.context.selected && !(this.options.splitActive?.() ?? false)
      ? this.inspectorLines(contentWidth)
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
    const selectedLine = this.inspectorLines(contentWidth)
      .findIndex((line) => line.includes("▶ "));
    if (selectedLine < 0) {
      this.pendingPropertySelectionScroll = false;
      return false;
    }
    this.pendingPropertySelectionScroll = false;
    const inspector = this.inspectorLines(contentWidth);
    const selectedRow =
      this.state.propertyInspector.presentation === "dedicated"
        ? selectedLine
        : arrangeInlinePreview(
            this.annotationPreview.render(contentWidth),
            inspector,
          ).inspectorStart + selectedLine;
    let endLine=selectedLine+1;
    while(endLine<inspector.length&&stripTerminalSequences(inspector[endLine]!).trimStart().startsWith("│"))endLine++;
    const selectedEndRow=selectedRow+Math.min(endLine-selectedLine,this.scrollView.viewportHeight)-1;
    const previousScrollTop = this.scrollView.scrollTop;
    if (selectedRow < previousScrollTop) {
      this.scrollView.scrollTo(selectedRow);
    } else if (selectedEndRow >= previousScrollTop + this.scrollView.viewportHeight) {
      this.scrollView.scrollTo(
        selectedEndRow - this.scrollView.viewportHeight + 1,
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
    if (this.applyPropertyInspectorScroll()) lines = super.render(width);
    if (this.ensureFocusVisible(width)) lines = super.render(width);
    return lines;
  }
}
