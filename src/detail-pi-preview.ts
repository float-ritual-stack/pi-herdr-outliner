import {
  Key,
  Markdown,
  matchesKey,
  ScrollView,
  type Component,
  type MarkdownTheme,
  VStack,
} from "@earendil-works/pi-tui";
import { linkOutlinerMarkdown, outlinerLinkUri } from "./outliner-links";
import {
  visibleBacklinkSources,
  type DetailState,
} from "./detail-controller";
import {
  renderDetailFooter,
  renderDetailHeader,
} from "./detail-renderer";
import { sanitizeDynamicText } from "./terminal";
import type { BacklinkReferenceGroup } from "./types";

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

const PREVIEW_HELP = "b backlinks  / filter  s sort  Tab select  . expand  Enter inspect  R reveal";

function escapeGeneratedMarkdown(value: string): string {
  return sanitizeMarkdownDocument(value)
    .replace(/\r?\n/g, " ")
    .replaceAll("\\", "\\\\")
    .replace(/([`*_[\]<>~])/g, "\\$1");
}

function backlinkGroupLabel(group: BacklinkReferenceGroup): string {
  if (group.kind === "property") return `${group.propertyKey} property ×${group.count}`;
  const label = group.kind === "block"
    ? "block reference"
    : group.kind === "page"
    ? "page link"
    : "Work ID";
  return `${label} ×${group.count}`;
}

const DETAIL_PREVIEW_SCHEME = "pi-outliner-detail:";
const ACTIVE_BACKLINK_STYLE = "\x1b[1;97;48;5;24m";

function highlightActiveBacklink(text: string): string {
  return `${ACTIVE_BACKLINK_STYLE}${text}\x1b[0m`;
}

export type DetailPreviewAction =
  | { kind: "backlink-toggle"; blockId: string };

export function detailBacklinkToggleUri(blockId: string): string {
  if (!blockId.trim()) throw new Error("Backlink source ID cannot be empty");
  return `${DETAIL_PREVIEW_SCHEME}//backlink-toggle/${encodeURIComponent(blockId)}`;
}

export function parseDetailPreviewActionUri(uri: string): DetailPreviewAction | null {
  if (!URL.canParse(uri)) return null;
  const parsed = new URL(uri);
  if (parsed.protocol !== DETAIL_PREVIEW_SCHEME) return null;
  if (parsed.hostname !== "backlink-toggle" || parsed.search || parsed.hash) {
    throw new Error("Invalid Detail preview action URI");
  }
  const encoded = parsed.pathname.startsWith("/") ? parsed.pathname.slice(1) : parsed.pathname;
  let blockId: string;
  try {
    blockId = decodeURIComponent(encoded);
  } catch {
    throw new Error("Invalid Detail preview action encoding");
  }
  if (!blockId) throw new Error("Invalid Detail backlink source");
  return { kind: "backlink-toggle", blockId };
}

export function renderBacklinksDocument(state: Readonly<DetailState>): string {
  const backlinks = state.backlinks;
  if (!backlinks.expanded) return "## Backlinks\n_Collapsed · press b to load_";
  if (backlinks.loading) return "## Backlinks\n_Loading…_";
  if (backlinks.error) {
    return `## Backlinks\n_Error: ${escapeGeneratedMarkdown(backlinks.error)}_`;
  }
  const collection = backlinks.collection;
  if (!collection) return "## Backlinks\n_No backlink data loaded_";

  const sources = visibleBacklinkSources(backlinks);
  const filter = backlinks.filterDraft ?? backlinks.filter;
  const direction = backlinks.sortDirection === "asc" ? "↑" : "↓";
  const sort = backlinks.sortField === "created" ? "Created" : "Updated";
  const lines = ["## Backlinks"];
  if (backlinks.filterDraft !== null) {
    lines.push(
      `**Filter:** ${escapeGeneratedMarkdown(filter)}▏ · Enter apply · Esc cancel`,
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

class DetailPreviewBody implements Component {
  constructor(
    private readonly authored: Markdown,
    private readonly backlinks: Markdown,
  ) {}

  render(width: number): string[] {
    return [...this.authored.render(width), "", ...this.backlinks.render(width)];
  }

  invalidate(): void {
    this.authored.invalidate();
    this.backlinks.invalidate();
  }
}

class DetailPreviewHeader implements Component {
  constructor(
    private readonly state: Readonly<DetailState>,
    private readonly linksEnabled: boolean,
  ) {}

  render(width: number): string[] {
    return renderDetailHeader(this.state, width, {
      linkBreadcrumbs: this.linksEnabled,
    });
  }

  invalidate(): void {}
}

class DetailPreviewFooter implements Component {
  constructor(private readonly state: Readonly<DetailState>) {}

  render(width: number): string[] {
    return renderDetailFooter(this.state, width, "preview", PREVIEW_HELP);
  }

  invalidate(): void {}
}

export class DetailPiPreviewLayout extends VStack {
  readonly markdown: Markdown;
  readonly backlinkMarkdown: Markdown;
  readonly scrollView: ScrollView;
  private renderedSourceText: string | undefined;
  private renderedRawText: string | undefined;
  private renderedWorkIdPrefix: string | null | undefined;
  private renderedBacklinksDocument: string | undefined;
  private previousSelectionId: string | null | undefined;
  private active: boolean;
  private resetScroll = false;
  private previousBacklinksExpanded = false;
  private previousBacklinkSelectedIndex: number | undefined;
  private pendingBacklinkSelectionScroll = false;

  constructor(
    private readonly state: Readonly<DetailState>,
    markdownTheme: MarkdownTheme,
    private readonly linksEnabled = process.env.HERDR_ENV === "1",
  ) {
    const markdown = new Markdown("", 0, 0, markdownTheme);
    const backlinkMarkdown = new Markdown("", 0, 0, {
      ...markdownTheme,
      strikethrough: highlightActiveBacklink,
      linkUrl: () => "",
    });
    const body = new DetailPreviewBody(markdown, backlinkMarkdown);
    const scrollView = new ScrollView(body, {
      primary: true,
      follow: "none",
      scrollbar: "always",
    });
    super([
      { component: new DetailPreviewHeader(state, linksEnabled), basis: 3, shrink: 0 },
      { component: scrollView, grow: 1, shrink: 1, minSize: 1 },
      { component: new DetailPreviewFooter(state), basis: 2, shrink: 0 },
    ]);
    this.markdown = markdown;
    this.backlinkMarkdown = backlinkMarkdown;
    this.scrollView = scrollView;
    this.active = state.mode === "preview";
  }

  setActive(active: boolean): void {
    if (active && !this.active) this.resetScroll = true;
    this.active = active;
  }

  handleInput(data: string): boolean {
    if (!this.active || this.state.mode !== "preview") return false;

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

  syncState(): void {
    if (!this.active) return;

    const selected = this.state.context.selected;
    const selectionId = selected?.id ?? null;
    const selectionChanged = selectionId !== this.previousSelectionId;
    this.previousSelectionId = selectionId;
    const sourceText = selected
      ? this.state.resolvedSelectedText
      : "Select a block in the outliner pane.";
    const rawText = selected && this.linksEnabled ? this.state.projectedSelectedText : sourceText;
    if (
      sourceText !== this.renderedSourceText ||
      rawText !== this.renderedRawText ||
      this.state.workIdPrefix !== this.renderedWorkIdPrefix
    ) {
      this.renderedSourceText = sourceText;
      this.renderedRawText = rawText;
      this.renderedWorkIdPrefix = this.state.workIdPrefix;
      const renderedText = selected
        ? renderPreviewDocument(
            sourceText,
            rawText,
            this.linksEnabled,
            this.state.workIdPrefix,
          )
        : sourceText;
      this.markdown.setText(renderedText);
    }
    const backlinksDocument = renderBacklinksDocument(this.state);
    if (backlinksDocument !== this.renderedBacklinksDocument) {
      this.renderedBacklinksDocument = backlinksDocument;
      this.backlinkMarkdown.setText(backlinksDocument);
    }
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
    if (this.resetScroll || selectionChanged) this.scrollView.scrollToStart();
    this.resetScroll = false;
  }

  ensureBacklinkSelectionVisible(width: number): boolean {
    if (!this.pendingBacklinkSelectionScroll || this.scrollView.viewportHeight <= 0) return false;

    const contentWidth = this.scrollView.getContentWidth(width);
    const selectedLine = this.backlinkMarkdown.render(contentWidth)
      .findIndex((line) => line.includes("▶ ACTIVE"));
    if (selectedLine < 0) return false;

    this.pendingBacklinkSelectionScroll = false;
    const selectedRow = this.markdown.render(contentWidth).length + 1 + selectedLine;
    const previousScrollTop = this.scrollView.scrollTop;
    if (selectedRow < previousScrollTop) {
      this.scrollView.scrollTo(selectedRow);
    } else if (selectedRow >= previousScrollTop + this.scrollView.viewportHeight) {
      this.scrollView.scrollTo(selectedRow - this.scrollView.viewportHeight + 1);
    }
    return this.scrollView.scrollTop !== previousScrollTop;
  }

  override render(width: number): string[] {
    this.syncState();
    const lines = super.render(width);
    return this.ensureBacklinkSelectionVisible(width) ? super.render(width) : lines;
  }
}

