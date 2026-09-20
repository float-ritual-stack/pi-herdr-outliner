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
} from "./detail-preview-regions";
import {
  groupPropertyInspectorEntries,
  type PropertyInspectorEntry,
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

function propertyEntryFocusUri(entry: PropertyInspectorEntry): string {
  return previewRegionActionUri({
    type: "preview.region.focus",
    regionId: entry.occurrenceId,
  });
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
  if (!entry.target) return `[${value}](${propertyEntryFocusUri(entry)})`;
  return `[${value}](${
    previewRegionActionUri({
      type: "property-inspector.target.open",
      occurrenceId: entry.occurrenceId,
    })
  })`;
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
    const focusUri = propertyEntryFocusUri(entry);
    const key = `${marker}[**${escapeInspectorMarkdown(entry.key)}**](${focusUri})`;
    const value = propertyEntryValue(state, entry);
    const source = `#${entry.ordinal} · L${entry.line + 1}:C${entry.column + 1}`;
    const scope = `[${entry.scope}](${focusUri})`;
    const sourceLink = `[${source}](${focusUri})`;
    lines.push(
      narrow
        ? `| ${key} | ${value} | ${scope} · ${sourceLink} |`
        : `| ${key} | ${value} | ${scope} | ${sourceLink} |`,
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
