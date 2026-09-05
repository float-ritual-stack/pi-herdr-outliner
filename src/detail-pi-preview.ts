import {
  Key,
  Markdown,
  matchesKey,
  ScrollView,
  type Component,
  type MarkdownTheme,
  VStack,
} from "@earendil-works/pi-tui";
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
  renderAnnotationDocument,
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
import { SourceSpannedMarkdown } from "./source-spanned-markdown";
import type { BacklinkReferenceGroup } from "./types";

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
    };
  }
  const blank = authored.findIndex((line) => sanitizeDynamicText(line).trim() === "");
  const titleEnd = blank < 0 ? authored.length : blank;
  const bodyStart = blank < 0 ? authored.length : blank + 1;
  const title = authored.slice(0, titleEnd);
  const body = authored.slice(bodyStart);
  const lines = [...title];
  if (title.length > 0) lines.push("");
  const inspectorStart = lines.length;
  lines.push(...inspector);
  const renderedBodyStart = lines.length + (body.length > 0 ? 1 : 0);
  if (body.length > 0) lines.push("", ...body);
  return {
    lines,
    inspectorStart,
    mapAuthoredRow: (row) => {
      if (row < bodyStart) return Math.min(row, titleEnd);
      return renderedBodyStart + row - bodyStart;
    },
  };
}

class DetailPreviewBody implements Component {
  constructor(
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
    const authored = this.authored.render(width);
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
  readonly inspectorMarkdown: Markdown;
  readonly backlinkMarkdown: Markdown;
  readonly scrollView: ScrollView;
  private renderedSourceText: string | undefined;
  private renderedRawText: string | undefined;
  private renderedWorkIdPrefix: string | null | undefined;
  private renderedAnnotationDocument: string | undefined;
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
  private previousSelectionId: string | null | undefined;
  private previousTargetFragmentId: string | null | undefined;
  private previousPreviewOffset: number | undefined;
  private active: boolean;
  private resetScroll = false;
  private previousBacklinksExpanded = false;
  private previousBacklinkSelectedIndex: number | undefined;
  private pendingBacklinkSelectionScroll = false;
  private previousPropertyFocusedId: string | null = null;
  private pendingPropertySelectionScroll = false;
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
      markdown,
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

  draftSourceLineAtScroll(width: number): number | null {
    const anchors = this.currentDraftAnchors(width);
    return anchors ? nearestDraftSourceLine(anchors, this.scrollView.scrollTop) : null;
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
    const annotationDocument = draftText === null ? renderAnnotationDocument(this.state) : "";
    const sourceChanged =
      sourceText !== this.renderedSourceText ||
      rawText !== this.renderedRawText ||
      workIdPrefix !== this.renderedWorkIdPrefix ||
      annotationDocument !== this.renderedAnnotationDocument ||
      embedPresentation !== this.renderedEmbedPresentation ||
      this.draftProjectionError !== this.renderedDraftProjectionError;
    if (sourceChanged || calloutSourceChanged) {
      this.renderedSourceText = sourceText;
      this.renderedRawText = rawText;
      this.renderedWorkIdPrefix = workIdPrefix;
      this.renderedAnnotationDocument = annotationDocument;
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
      const decoratedDocument = annotationDocument
        ? `${document}\n\n---\n\n${annotationDocument}`
        : document;
      const renderedText = this.draftProjectionError
        ? `${decoratedDocument}\n\n> Draft preview error: ${
          sanitizeMarkdownDocument(this.draftProjectionError).replace(/\r?\n/g, " ")
        }`
        : decoratedDocument;
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
    const backlinksDocument = renderBacklinksDocument(this.state);
    if (backlinksDocument !== this.renderedBacklinksDocument) {
      this.renderedBacklinksDocument = backlinksDocument;
      this.backlinkMarkdown.setText(backlinksDocument);
    }
    const regions = this.state.propertyInspector.presentation === "dedicated"
      ? detailPropertyInspectorRegions(this.state)
      : [
        ...this.calloutRegions,
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
    const renderedDocument = this.markdown.renderWithSourceLineRow(
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
      arrangeInlinePreview(this.markdown.render(contentWidth), inspector).lines.length +
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
            this.markdown.render(contentWidth),
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
    if (this.ensureBacklinkSelectionVisible(width)) lines = super.render(width);
    if (this.applyPropertyInspectorScroll()) lines = super.render(width);
    if (this.ensurePropertySelectionVisible(width)) lines = super.render(width);
    return lines;
  }
}
