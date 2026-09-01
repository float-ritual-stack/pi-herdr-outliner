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
import { linkOutlinerMarkdown, outlinerLinkUri } from "./outliner-links";
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
  const anchors: number[] = [];
  let renderedRow = 0;
  for (const line of sourceText.split(/\r?\n/)) {
    anchors.push(renderedRow);
    renderedRow += Math.max(1, new Markdown(line || " ", 0, 0, theme).render(contentWidth).length);
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
}

export function sanitizeMarkdownDocument(value: string): string {
  return sanitizeDynamicText(value, true);
}

function renderPreviewDocument(
  sourceText: string,
  rawText: string,
  linksEnabled: boolean,
  workIdPrefix: string | null,
): string {
  const sanitizedSource = sanitizeMarkdownDocument(sourceText);
  if (!linksEnabled) return sanitizedSource;

  // Authored text must be sanitized before adding trusted, generated Markdown links.
  return linkOutlinerMarkdown(
    sanitizedSource,
    sanitizeMarkdownDocument(rawText),
    workIdPrefix,
  );
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
      const uri = outlinerLinkUri("block", source.blockId, { preserveSource: true });
      const selected = index === backlinks.selectedIndex;
      const active = selected ? "**▶ ACTIVE** " : "";
      const sourceExpanded = backlinks.expandedSourceIds.has(source.blockId);
      const disclosure = detailBacklinkToggleUri(source.blockId);
      const groups = source.referenceGroups.map(backlinkGroupLabel).join(", ");
      const row =
        `[${sourceExpanded ? "−" : "+"}](${disclosure}) ${active}[${title}](${uri}) — ${context}${trash} · ${count} · ${groups}`;
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
    const lines = this.includeInspector() ? inspector : [];
    if (authored.length > 0) {
      if (lines.length > 0) lines.push("");
      lines.push(...authored);
    }
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
  private renderedBacklinksDocument: string | undefined;
  private renderedInspectorDocument: string | undefined;
  private renderedInspectorWidth: number | undefined;
  private renderedEmbedPresentation: string | undefined;
  private renderedDraftProjectionError: string | undefined;
  private renderedCalloutSource: string | undefined;
  private calloutRegions: DetailCalloutRegion[] = [];
  private renderedCalloutRegions: DetailCalloutRegion[] = [];
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
    let embedRanges: DetailState["embedRanges"];
    let workIdPrefix: string | null;
    if (draftText !== null) {
      this.scheduleDraftProjection(draftText);
      const projection = this.draftProjection?.inputText === draftText
        ? this.draftProjection
        : null;
      sourceText = projection?.sourceText ?? draftText;
      rawText = this.linksEnabled ? projection?.rawText ?? draftText : sourceText;
      embedRanges = projection?.embedRanges ?? [];
      workIdPrefix = projection?.workIdPrefix ?? this.state.workIdPrefix;
    } else {
      this.resetDraftProjectionState();
      sourceText = selected
        ? this.state.resolvedSelectedText
        : "Select a block in the outliner pane.";
      rawText = selected && this.linksEnabled ? this.state.projectedSelectedText : sourceText;
      embedRanges = this.state.embedRanges;
      workIdPrefix = this.state.workIdPrefix;
    }
    if (draftText === null && selected) {
      sourceText = propertyInspectorAuthoredText(sourceText);
      rawText = propertyInspectorAuthoredText(rawText);
    }
    const authoredCalloutSource = draftText ?? selected?.text ?? sourceText;

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
      const authoredCalloutIds = new Set(
        this.calloutRegions.map((region) => region.id),
      );
      this.renderedCalloutRegions = parseDetailCallouts(
        renderedText,
        this.options.calloutTheme,
      )
        .filter((region) => authoredCalloutIds.has(region.id))
        .map((region) => ({
          ...region,
          childIds: region.childIds.filter((id) => authoredCalloutIds.has(id)),
        }));
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
    const inspectorHeight =
      this.state.context.selected && !(this.options.splitActive?.() ?? false)
        ? this.inspectorMarkdown.render(contentWidth).length + 1
        : 0;
    const contentHeight = this.markdown.render(contentWidth).length +
      inspectorHeight + 1 + this.backlinkMarkdown.render(contentWidth).length;
    this.scrollView.updateLayout(contentHeight, this.scrollView.viewportHeight, () => {});
    this.pendingFragmentScroll = false;
    const previousScrollTop = this.scrollView.scrollTop;
    this.scrollView.scrollTo(
      this.state.targetFragmentId ? this.state.previewOffset : 0,
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
    const selectedRow = this.markdown.render(contentWidth).length + 1 +
      this.inspectorMarkdown.render(contentWidth).length + 1 + selectedLine;
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
    const selectedRow =
      this.state.propertyInspector.presentation === "dedicated"
        ? selectedLine
        : this.markdown.render(contentWidth).length + 1 + selectedLine;
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
