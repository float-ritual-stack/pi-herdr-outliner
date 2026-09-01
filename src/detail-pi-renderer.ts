import {
  HStack,
  truncateToWidth,
  type Component,
} from "@earendil-works/pi-tui";
import {
  visiblePropertyInspectorEntries,
  type DetailState,
} from "./detail-controller";
import {
  previewRegionActionUri,
  type PreviewRegion,
} from "./detail-preview-regions";
import {
  groupPropertyInspectorEntries,
  type PropertyInspectorEntry,
  type PropertyInspectorGroupBy,
} from "./property-inspector";
import {
  renderDetailLines,
  type DetailHeaderOptions,
} from "./detail-renderer";
import { sanitizeDynamicText } from "./terminal";

export const DETAIL_DRAFT_SPLIT_MIN_WIDTH = 100;
const DETAIL_DRAFT_SPLIT_GAP = 1;

export function detailDraftSplitWidths(width: number): {
  editor: number;
  preview: number;
} {
  const availableWidth = Math.max(
    2,
    Math.floor(width) - DETAIL_DRAFT_SPLIT_GAP,
  );
  const editor = Math.ceil(availableWidth / 2);
  return { editor, preview: availableWidth - editor };
}

function escapeInspectorMarkdown(value: string): string {
  return sanitizeDynamicText(value, true)
    .replace(/\r?\n/g, " ")
    .replaceAll("\\", "\\\\")
    .replace(/([|`*_[\]<>~])/g, "\\$1");
}

function propertyEntryValue(
  state: Readonly<DetailState>,
  entry: PropertyInspectorEntry,
): string {
  const edit = state.propertyInspector.edit;
  if (edit?.occurrenceId === entry.occurrenceId) {
    const text = edit.buffer.lines[0] ?? "";
    const cursor = Math.max(0, Math.min(edit.buffer.column, text.length));
    return `✎ ${escapeInspectorMarkdown(text.slice(0, cursor))}▏${
      escapeInspectorMarkdown(text.slice(cursor))
    }`;
  }
  const value = escapeInspectorMarkdown(entry.value) || "_empty_";
  if (!entry.target) return value;
  return `[${value}](${
    previewRegionActionUri({
      type: "property-inspector.target.open",
      occurrenceId: entry.occurrenceId,
    })
  })`;
}

function propertyGroupLabel(
  entry: PropertyInspectorEntry,
  groupBy: PropertyInspectorGroupBy,
): string {
  switch (groupBy) {
    case "key":
      return entry.key;
    case "scope":
      return entry.scope;
    case "target":
      return entry.target?.kind ?? "plain";
  }
}

function propertyGroupId(groupBy: PropertyInspectorGroupBy, label: string): string {
  return `property-group:${groupBy}:${encodeURIComponent(label)}`;
}

function propertyEntryParentId(
  state: Readonly<DetailState>,
  entry: PropertyInspectorEntry,
): string {
  const groupBy = state.propertyInspector.groupBy;
  return groupBy
    ? propertyGroupId(groupBy, propertyGroupLabel(entry, groupBy))
    : "property-inspector";
}

export function detailPropertyInspectorRegions(
  state: Readonly<DetailState>,
): PreviewRegion[] {
  if (!state.propertyInspector.model) return [];
  const inspector = state.propertyInspector;
  const expanded = inspector.presentation === "dedicated" || inspector.expanded;
  const entries = expanded ? visiblePropertyInspectorEntries(inspector) : [];
  const groupBy = inspector.groupBy;
  const groups = groupBy
    ? groupPropertyInspectorEntries(entries, groupBy)
    : [];
  const childIds = groupBy
    ? groups.map((group) => propertyGroupId(groupBy, group.label))
    : entries.map((entry) => entry.occurrenceId);
  const regions: PreviewRegion[] = [{
    id: "property-inspector",
    kind: "property-inspector",
    sourceSpan: null,
    parentId: null,
    childIds,
    focusable: inspector.presentation === "inline",
    disclosure: {
      defaultExpanded: inspector.presentation === "dedicated",
      expanded,
    },
    activation: inspector.presentation === "dedicated"
      ? null
      : { type: "property-inspector.disclosure.toggle" },
  }];
  if (groupBy) {
    for (const group of groups) {
      regions.push({
        id: propertyGroupId(groupBy, group.label),
        kind: "property-group",
        sourceSpan: null,
        parentId: "property-inspector",
        childIds: group.entries.map((entry) => entry.occurrenceId),
        focusable: false,
        disclosure: null,
        activation: null,
      });
    }
  }
  for (const entry of entries) {
    regions.push({
      id: entry.occurrenceId,
      kind: "property-entry",
      sourceSpan: {
        start: entry.start,
        end: entry.end,
        startLine: entry.line,
        endLine: entry.line + entry.raw.split(/\r?\n/).length - 1,
      },
      parentId: propertyEntryParentId(state, entry),
      childIds: [],
      focusable: true,
      disclosure: null,
      activation: entry.target
        ? {
          type: "property-inspector.target.open",
          occurrenceId: entry.occurrenceId,
        }
        : null,
    });
  }
  return regions;
}

function propertyTableLines(
  state: Readonly<DetailState>,
  entries: readonly PropertyInspectorEntry[],
  width: number,
): string[] {
  const focusedId = state.previewRegions.focusedRegionId;
  const narrow = width < 72;
  const lines = narrow
    ? [
      "| Property | Value | Source |",
      "| :-- | :-- | :-- |",
    ]
    : [
      "| Property | Value | Scope | Source |",
      "| :-- | :-- | :-- | :-- |",
    ];
  for (const entry of entries) {
    const marker = focusedId === entry.occurrenceId ? "▶ " : "";
    const key = `${marker}**${escapeInspectorMarkdown(entry.key)}**`;
    const value = propertyEntryValue(state, entry);
    const source = `#${entry.ordinal} · L${entry.line + 1}:C${entry.column + 1}`;
    lines.push(
      narrow
        ? `| ${key} | ${value} | ${entry.scope} · ${source} |`
        : `| ${key} | ${value} | ${entry.scope} | ${source} |`,
    );
  }
  return lines;
}

export function renderPropertyInspectorDocument(
  state: Readonly<DetailState>,
  width: number,
): string {
  const inspector = state.propertyInspector;
  const model = inspector.model;
  const dedicated = inspector.presentation === "dedicated";
  const expanded = dedicated || inspector.expanded;
  const toggle = previewRegionActionUri({
    type: "property-inspector.disclosure.toggle",
  });
  const pane = previewRegionActionUri({ type: "property-inspector.pane.open" });
  const count = model?.entries.length ?? 0;
  const headingLabel = `${
    state.previewRegions.focusedRegionId === "property-inspector" ? "▶ " : ""
  }${expanded ? "▾" : "▸"} Properties`;
  const heading = dedicated
    ? `## Properties · ${count} ${count === 1 ? "record" : "records"}`
    : `## [${headingLabel}](${toggle}) · ${count} ${
      count === 1 ? "record" : "records"
    } · [dedicated Detail](${pane})`;
  if (!expanded) return heading;

  const entries = visiblePropertyInspectorEntries(inspector);
  const filter = inspector.filterDraft ?? inspector.filter;
  const lines = [heading];
  if (inspector.edit) {
    const entry = model?.entries.find(
      (candidate) => candidate.occurrenceId === inspector.edit?.occurrenceId,
    );
    lines.push(
      `**Editing ${escapeInspectorMarkdown(entry?.key ?? "property")}** · ↵ save · ⎋ cancel`,
    );
  } else if (inspector.filterDraft !== null) {
    lines.push(
      `**Filter:** ${escapeInspectorMarkdown(filter)}▏ · ↵ apply · ⎋ cancel`,
    );
  } else {
    lines.push(
      `_Tab select · Enter/e edit · o open target · / filter · G group · ${
        entries.length
      }/${count} shown · ${inspector.groupBy ?? "source order"}${
        filter ? ` · “${escapeInspectorMarkdown(filter)}”` : ""
      }_`,
    );
  }
  if (!model || count === 0) {
    lines.push("_No properties._");
    return lines.join("\n");
  }
  if (entries.length === 0) {
    lines.push("_No properties match the current filter._");
    return lines.join("\n");
  }
  lines.push("");

  const groupBy = inspector.groupBy;
  if (!groupBy) {
    lines.push(...propertyTableLines(state, entries, width));
  } else {
    for (const group of groupPropertyInspectorEntries(entries, groupBy)) {
      lines.push(`### ${escapeInspectorMarkdown(group.label)}`);
      lines.push(...propertyTableLines(state, group.entries, width));
    }
  }
  return lines.join("\n");
}

export interface DetailPiComponentOptions {
  state: Readonly<DetailState>;
  height(): number;
  header?(): DetailHeaderOptions | undefined;
  helpPrefix?(): string | undefined;
  helpText?(): string | undefined;
}

export class DetailPiComponent implements Component {
  constructor(private readonly options: DetailPiComponentOptions) {}

  render(width: number): string[] {
    return renderDetailLines(this.options.state, {
      width,
      height: Math.max(1, this.options.height()),
    }, {
      header: this.options.header?.(),
      helpPrefix: this.options.helpPrefix?.(),
      helpText: this.options.helpText?.(),
    }).map((line) => truncateToWidth(line, width));
  }

  invalidate(): void {}
}

export class DetailPiDraftSplitLayout extends HStack {
  private editorPaneWidth = 1;

  constructor(editor: Component, preview: Component) {
    super([
      { component: editor, basis: 1, grow: 0, shrink: 0, minSize: 1, maxSize: 1 },
      { component: preview, basis: 1, grow: 0, shrink: 0, minSize: 1, maxSize: 1 },
    ], { gap: DETAIL_DRAFT_SPLIT_GAP });
  }

  setWidth(width: number): void {
    const sizes = detailDraftSplitWidths(width);
    this.editorPaneWidth = sizes.editor;
    Object.assign(this.entries[0], {
      basis: sizes.editor,
      minSize: sizes.editor,
      maxSize: sizes.editor,
    });
    Object.assign(this.entries[1], {
      basis: sizes.preview,
      minSize: sizes.preview,
      maxSize: sizes.preview,
    });
  }

  get editorWidth(): number {
    return this.editorPaneWidth;
  }
}
