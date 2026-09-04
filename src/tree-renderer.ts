import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  actionMenuItemText,
  DEFAULT_OUTLINER_ACTION_KEYMAP,
  outlinerActionLink,
} from "./outliner-actions";
import { completionWindow } from "./completion";
import { createOutlinerTextLinker } from "./outliner-links";
import { quickInsertionPoint } from "./quick-edit";
import { firstLineWithoutPropertyTokens } from "./properties";
import {
  DEFAULT_PROPERTY_SUMMARY_KEYS,
  propertySummarySegments,
} from "./property-summary";
import { blockDisplayTitle } from "./references";
import { layoutExpandedBlock } from "./tree-layout";
import { renderMarkdownLine, truncate } from "./terminal";
import type { Block, VisibleBlock } from "./types";
import type { TreeQuickCompletion, TreeView } from "./tree-controller";
import type { TreeMouseTarget } from "./tree-mouse";
import {
  decorateVirtualBranchDefinitionText,
  virtualBranchStateLabel,
  type TreeRow,
  type VirtualBranchState,
} from "./virtual-branches";

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function branchStatusText(state: VirtualBranchState): string {
  const details = [
    countLabel(state.count, "matched root"),
    countLabel(state.descendantCount, "contextual descendant"),
  ];
  if (state.truncation.rootQuery) {
    details.push(`ROOT QUERY TRUNCATED at ${state.completeness?.kind === "truncated" ? state.completeness.limit : state.count}`);
  }
  if (state.truncation.depth) details.push("DESCENDANTS TRUNCATED at relative depth 2");
  if (state.truncation.budget) details.push("PROJECTION TRUNCATED at 1000 rows");
  if (state.configurationErrors.length > 0) {
    details.push(`CONFIG ERROR: ${state.configurationErrors.join("; ")}`);
  }
  if (state.queryError) details.push(`QUERY ERROR: ${state.queryError}`);
  if (state.creationErrors.length > 0) {
    details.push(`READ-ONLY: ${state.creationErrors.join("; ")}`);
  } else if (state.config?.readOnly) {
    details.push("READ-ONLY: configure create and create-parent");
  }
  return `Virtual branch · ${details.join(" · ")}`;
}

function virtualBranchCreationHelp(
  state: VirtualBranchState | undefined,
  physicalBlocksById: ReadonlyMap<string, VisibleBlock>,
): string | null {
  const config = state?.config;
  if (!config || config.readOnly || !config.create || !config.createParentId) return null;
  const parent = physicalBlocksById.get(config.createParentId);
  const parentTitle = parent ? blockDisplayTitle(parent) : config.createParentId;
  return `Create canonical under ${parentTitle} · sets [${config.create.key}::${config.create.value}] · ↵ save · ⎋ cancel`;
}

function isCanonicalDescendant(
  candidateId: string,
  ancestorId: string,
  physicalBlocksById: ReadonlyMap<string, VisibleBlock>,
): boolean {
  let candidate = physicalBlocksById.get(candidateId);
  while (candidate?.parentId) {
    if (candidate.parentId === ancestorId) return true;
    candidate = physicalBlocksById.get(candidate.parentId);
  }
  return false;
}

function isVisualDescendant(
  candidate: TreeRow,
  ancestor: TreeRow,
  physicalBlocksById: ReadonlyMap<string, VisibleBlock>,
): boolean {
  if (ancestor.kind === "occurrence") return false;
  if (candidate.kind === "occurrence") {
    return (
      candidate.viewId === ancestor.canonicalId ||
      isCanonicalDescendant(candidate.viewId, ancestor.canonicalId, physicalBlocksById)
    );
  }
  return isCanonicalDescendant(candidate.canonicalId, ancestor.canonicalId, physicalBlocksById);
}

const ESC = "\x1b[";
const AUTHOR_MARKERS: Record<Block["author"], string> = {
  agent: "A",
  system: "S",
  user: " ",
};

type TreeRenderEntry =
  | { kind: "block"; blockIndex: number }
  | { kind: "quick"; depth: number };

export interface TreeRenderResult {
  readonly frame: string;
  readonly scrollStartEntryIndex: number;
  readonly mouseTargets: readonly (TreeMouseTarget | null | undefined)[];
}

export interface TreeRenderOptions {
  readonly propertyKeys?: readonly string[];
}

function propertyKeysForRow(
  view: TreeView,
  row: TreeRow,
  options: TreeRenderOptions,
): readonly string[] {
  if (row.kind === "occurrence") {
    const configured = view.branchStates.get(row.viewId)?.config?.summaryPropertyKeys;
    if (configured !== undefined) return configured;
  }
  return options.propertyKeys ?? DEFAULT_PROPERTY_SUMMARY_KEYS;
}

function collapsedBlockTitle(block: VisibleBlock): string {
  if (block.properties.length === 0) return block.displayText.replace(/\r?\n/g, " ↵ ");
  return firstLineWithoutPropertyTokens(block.displayText)?.trim() || block.id;
}

function renderSummarySegment(label: string, value: string): string {
  const renderedLabel = label ? `\x1b[2m${label}\x1b[0m ` : "";
  return `${renderedLabel}\x1b[36m${value}\x1b[0m`;
}

function renderCollapsedRow(
  prefix: string,
  title: string,
  summary: readonly { label: string; value: string; plain: string }[],
  fixedSuffix: string,
  optionalSuffix: string,
  width: number,
): string {
  let suffix = `${fixedSuffix}${optionalSuffix}`;
  let available = Math.max(1, width - visibleWidth(prefix) - visibleWidth(suffix));
  const segments = [...summary];
  const separator = "  ";
  const plainSummary = () => segments.length === 1
    ? segments[0]!.value
    : segments.map((segment) => segment.plain).join(" · ");
  if (
    segments.length > 0 &&
    optionalSuffix &&
    visibleWidth(title) + visibleWidth(separator) + visibleWidth(plainSummary()) > available
  ) {
    suffix = fixedSuffix;
    available = Math.max(1, width - visibleWidth(prefix) - visibleWidth(suffix));
  }

  while (
    segments.length > 1 &&
    visibleWidth(title) + visibleWidth(separator) + visibleWidth(plainSummary()) > available
  ) {
    segments.pop();
  }

  if (segments.length === 0) {
    if (!fixedSuffix) return truncate(`${prefix}${title}${suffix}`, width);
    return truncateToWidth(`${prefix}${truncateToWidth(title, available)}${suffix}`, width);
  }

  const renderedSummary = () =>
    segments.length === 1
      ? renderSummarySegment("", segments[0]!.value)
      : segments
        .map((segment) => renderSummarySegment(segment.label, segment.value))
        .join(" \x1b[2m·\x1b[0m ");
  if (
    visibleWidth(title) + visibleWidth(separator) + visibleWidth(plainSummary()) <= available
  ) {
    const gap = " ".repeat(
      available - visibleWidth(title) - visibleWidth(plainSummary()),
    );
    return truncateToWidth(`${prefix}${title}${gap}${renderedSummary()}${suffix}`, width);
  }

  const contentWidth = Math.max(1, available - visibleWidth(separator));
  const titleFloor = Math.min(
    visibleWidth(title),
    4,
    Math.max(1, contentWidth - 1),
  );
  const summaryWidth = Math.min(
    visibleWidth(plainSummary()),
    Math.max(1, contentWidth - titleFloor),
  );
  const titleWidth = Math.max(1, contentWidth - summaryWidth);
  return truncateToWidth(
    `${prefix}${truncateToWidth(title, titleWidth)}${separator}${
      truncateToWidth(renderedSummary(), summaryWidth)
    }${suffix}`,
    width,
  );
}

function renderQuickInputRow(
  quickInput: string,
  quickColumn: number,
  depth: number,
  marker: string,
  author: string,
  width: number,
): string {
  const prefix = `${"  ".repeat(depth)}${marker} `;
  const suffix = `  ${author}`;
  const available = Math.max(1, width - prefix.length - suffix.length);
  const textWidth = Math.max(0, available - 1);
  const horizontalOffset = Math.max(0, quickColumn - textWidth);
  const visible = quickInput.slice(horizontalOffset, horizontalOffset + textWidth);
  const cursor = Math.max(0, quickColumn - horizontalOffset);
  const content = `${visible.slice(0, cursor)}▏${visible.slice(cursor)}`;
  return truncate(`${prefix}${content}${suffix}`, width);
}


function renderQuickCompletionRows(
  completion: TreeQuickCompletion | null,
  depth: number,
  width: number,
): string[] {
  if (!completion) return [];
  const prefix = `${"  ".repeat(depth)}  `;
  const window = completionWindow(completion.items.length, completion.index, 6);
  const truncationLabel =
    completion.truncatedLimit === null ? "" : ` · Showing first ${completion.truncatedLimit} matches`;
  const rows = [
    `${prefix}\x1b[2m${truncate(
      `Completions ${completion.index + 1}/${completion.items.length}${truncationLabel}`,
      Math.max(1, width - prefix.length),
    )}\x1b[0m`,
  ];
  for (let index = window.start; index < window.end; index++) {
    const item = completion.items[index];
    const label = truncate(item.label, Math.max(1, width - prefix.length - 2));
    rows.push(index === completion.index ? `${prefix}\x1b[7m› ${label}\x1b[0m` : `${prefix}  ${label}`);
  }
  return rows;
}

export function renderTreeFrame(
  view: TreeView,
  width: number,
  height: number,
  initialScrollStartEntryIndex = 0,
  options: TreeRenderOptions = {},
): TreeRenderResult {
  const output: string[] = [`${ESC}H${ESC}2J`];
  const mouseTargets: Array<TreeMouseTarget | null | undefined> = [];

  if (view.mode === "viewer") {
    output.push(`\x1b[1m${truncate(view.viewerPath, width)}\x1b[0m`);
    output.push("─".repeat(width));
    const bodyHeight = Math.max(1, height - 3);
    for (const line of view.viewerLines.slice(view.viewerOffset, view.viewerOffset + bodyHeight)) {
      output.push(renderMarkdownLine(truncate(line, width)));
    }
    while (output.length < height - 1) output.push("");
    output.push(
      `\x1b[2m${truncate(
        view.actionHelpText ?? DEFAULT_OUTLINER_ACTION_KEYMAP.helpText("tree", "viewer"),
        width,
      )}\x1b[0m`,
    );
    return {
      frame: output.join("\n"),
      scrollStartEntryIndex: initialScrollStartEntryIndex,
      mouseTargets,
    };
  }

  const paneMenu = outlinerActionLink("tree.menu.open", "[⋯]");
  output.push(
    `\x1b[1;36mOutliner\x1b[0m  \x1b[2m${truncate(view.workspaceRoot, Math.max(10, width - 25))}\x1b[0m  ${paneMenu}`,
  );
  const filterLabel = view.activeFilter ? `  \x1b[33mfilter: ${view.activeFilter}\x1b[0m` : "";
  const truncationLabel =
    view.visibleCompleteness.kind === "truncated"
      ? `  \x1b[33mWARNING: truncated at ${view.visibleCompleteness.limit}\x1b[0m`
      : "";
  const physicalCount = view.physicalRowCount;
  const occurrenceCount = view.occurrenceRowCount;
  output.push(truncateToWidth(
    `\x1b[2m${countLabel(physicalCount, "physical block")} · ${countLabel(
      occurrenceCount,
      "projected occurrence",
    )}${filterLabel}\x1b[0m${truncationLabel}`,
    width,
  ));
  output.push("─".repeat(width));
  const bodyHeight = Math.max(1, height - 6);
  if (view.mode === "action-menu") {
    const actionMenuItems = view.actionMenuItems ?? [];
    const actionMenuIndex = view.actionMenuIndex ?? 0;
    const actionMenuQuery = view.actionMenuQuery ?? "";
    const originRow = view.actionMenuOrigin
      ? Math.max(0, Math.min(bodyHeight - 1, view.actionMenuOrigin.row - 3))
      : 0;
    const menuColumn = view.actionMenuOrigin
      ? Math.max(0, Math.min(view.actionMenuOrigin.column, Math.max(0, width - 24)))
      : 0;
    const menuHeight = Math.max(1, bodyHeight - originRow);
    const menuWidth = Math.max(1, width - menuColumn);
    const window = completionWindow(
      actionMenuItems.length,
      actionMenuIndex,
      menuHeight,
    );
    for (let row = 0; row < originRow; row += 1) output.push("");
    for (let index = window.start; index < window.end; index++) {
      const item = actionMenuItems[index]!;
      const text = actionMenuItemText(item);
      const linked = outlinerActionLink(item.id, truncate(text, Math.max(1, menuWidth - 2)));
      const prefix = " ".repeat(menuColumn);
      output.push(
        `${prefix}${index === actionMenuIndex ? `\x1b[7m› ${linked}\x1b[0m` : `  ${linked}`}`,
      );
    }
    while (output.length < height - 2) output.push("");
    const selected = actionMenuItems[actionMenuIndex];
    const description = selected ? ` · ${selected.description}` : "";
    output.push(truncate(`Find: ${actionMenuQuery}▏${description}`, width));
    output.push(`\x1b[2m${truncate("↑↓ choose  ↵ invoke  ⎋ close", width)}\x1b[0m`);
    return {
      frame: output.join("\n"),
      scrollStartEntryIndex: initialScrollStartEntryIndex,
      mouseTargets,
    };
  }
  const selectedExpandedInfo = {
    current: null as { offset: number; end: number; total: number } | null,
  };

  function rowIsVisualDescendant(candidate: TreeRow, ancestor: TreeRow): boolean {
    return isVisualDescendant(candidate, ancestor, view.physicalBlocksById);
  }
  const insertionPoint =
    view.mode === "add-child" || view.mode === "add-sibling"
      ? quickInsertionPoint(view.rows, view.selectedIndex, view.mode, rowIsVisualDescendant)
      : null;
  const quickEntryIndex = insertionPoint?.gap ?? -1;
  const entryCount = view.rows.length + Number(insertionPoint !== null);
  function entryAt(index: number): TreeRenderEntry {
    if (insertionPoint && index === quickEntryIndex) {
      return { kind: "quick", depth: insertionPoint.depth };
    }
    return {
      kind: "block",
      blockIndex: insertionPoint && index > quickEntryIndex ? index - 1 : index,
    };
  }


  const renderedRows: Array<string[] | undefined> = [];
  function getBlockRows(index: number): string[] {
    const cached = renderedRows[index];
    if (cached) return cached;

    const row = view.rows[index];
    const block = row.block;
    let marker = row.kind === "occurrence" ? "◇" : "•";
    if (row.hasChildren) marker = row.collapsed ? "▸" : "▾";
    const author = AUTHOR_MARKERS[block.author];
    const editingInline = view.mode === "edit" && index === view.selectedIndex;
    if (editingInline) {
      const result = [
        renderQuickInputRow(view.quickInput, view.quickColumn, row.depth, marker, author, width),
        ...renderQuickCompletionRows(view.quickCompletion, row.depth + 1, width),
      ];
      renderedRows[index] = result;
      return result;
    }

    const linker = createOutlinerTextLinker(
      block.text,
      (blockId) => view.physicalBlocksById.get(blockId) ?? null,
      view.workIdPrefix,
    );

    const branchState =
      row.kind === "physical" ? view.branchStates.get(row.canonicalId) : undefined;
    let trashLabel = "";
    if (block.deletedAt) {
      trashLabel = `  [Trash · ${block.deletedDescendantCount ?? 0} descendants]`;
    } else if (block.effectiveDeletedRootId) {
      trashLabel = "  [Trash]";
    }
    let result: string[];
    if (!row.multilineExpanded) {
      const prefix = `${"  ".repeat(row.depth)}${marker} `;
      const branchBadge = branchState ? virtualBranchStateLabel(branchState) : "";
      const fixedSuffix = `${branchBadge}${trashLabel}`;
      const optionalSuffix = `  ${author}`;
      const summary = propertySummarySegments(
        block.properties,
        propertyKeysForRow(view, row, options),
      );
      result = [
        linker.link(
          renderCollapsedRow(
            prefix,
            collapsedBlockTitle(block),
            summary,
            fixedSuffix,
            optionalSuffix,
            width,
          ),
        ),
      ];
    } else {
      const displayText = decorateVirtualBranchDefinitionText(
        `${block.displayText}${trashLabel}`,
        branchState,
      );
      const expandedRows = layoutExpandedBlock({
        text: displayText,
        width,
        depth: row.depth,
        marker,
        author,
      }).map((renderedRow, rowIndex) => {
        const linkedText = linker.link(renderedRow.text);
        const text = rowIndex === 0 ? linkedText : renderMarkdownLine(linkedText);
        return `${renderedRow.prefix}${text}${renderedRow.suffix}`;
      });
      if (index === view.selectedIndex) {
        const maxOffset = Math.max(0, expandedRows.length - bodyHeight);
        const offset = Math.min(view.expandedBlockOffset, maxOffset);
        const end = Math.min(expandedRows.length, offset + bodyHeight);
        selectedExpandedInfo.current = {
          offset,
          end,
          total: expandedRows.length,
        };
        result = expandedRows.slice(offset, end);
      } else {
        result = expandedRows;
      }
    }
    renderedRows[index] = result;
    return result;
  }

  function getEntryRows(entry: TreeRenderEntry): string[] {
    if (entry.kind === "block") return getBlockRows(entry.blockIndex);
    return [
      renderQuickInputRow(view.quickInput, view.quickColumn, entry.depth, "•", AUTHOR_MARKERS.user, width),
      ...renderQuickCompletionRows(view.quickCompletion, entry.depth + 1, width),
    ];
  }

  function getEntryHeight(entryIndex: number): number {
    const entry = entryAt(entryIndex);
    if (entry.kind === "quick") return getEntryRows(entry).length;
    const row = view.rows[entry.blockIndex];
    const editingInline = view.mode === "edit" && entry.blockIndex === view.selectedIndex;
    return row.multilineExpanded || editingInline ? getEntryRows(entry).length : 1;
  }

  const targetEntryIndex = insertionPoint
    ? quickEntryIndex
    : Math.max(0, view.selectedIndex + Number(quickEntryIndex >= 0 && view.selectedIndex >= quickEntryIndex));
  let scrollStartEntryIndex = Math.max(
    0,
    Math.min(initialScrollStartEntryIndex, Math.max(0, entryCount - 1)),
  );
  if (targetEntryIndex < scrollStartEntryIndex) {
    scrollStartEntryIndex = targetEntryIndex;
  } else if (scrollStartEntryIndex < targetEntryIndex) {
    let requiredHeight = 0;
    let scanIndex = scrollStartEntryIndex;
    while (scanIndex <= targetEntryIndex && requiredHeight <= bodyHeight) {
      requiredHeight += getEntryHeight(scanIndex);
      scanIndex += 1;
    }
    if (scanIndex <= targetEntryIndex) {
      scrollStartEntryIndex = targetEntryIndex;
      requiredHeight = getEntryHeight(targetEntryIndex);
      while (scrollStartEntryIndex > 0) {
        const previousHeight = getEntryHeight(scrollStartEntryIndex - 1);
        if (requiredHeight + previousHeight > bodyHeight) break;
        scrollStartEntryIndex -= 1;
        requiredHeight += previousHeight;
      }
    } else {
      while (requiredHeight > bodyHeight && scrollStartEntryIndex < targetEntryIndex) {
        requiredHeight -= getEntryHeight(scrollStartEntryIndex);
        scrollStartEntryIndex += 1;
      }
    }
  }

  let renderedBodyLines = 0;
  for (let entryIndex = scrollStartEntryIndex; entryIndex < entryCount; entryIndex++) {
    if (renderedBodyLines >= bodyHeight) break;
    const entry = entryAt(entryIndex);
    const entryRows = getEntryRows(entry);
    for (let lineIndex = 0; lineIndex < entryRows.length; lineIndex++) {
      if (renderedBodyLines >= bodyHeight) break;
      const line = entryRows[lineIndex];
      if (entry.kind === "block") {
        const row = view.rows[entry.blockIndex];
        const disclosureMarkerVisible =
          lineIndex === 0 &&
          (!row.multilineExpanded ||
            entry.blockIndex !== view.selectedIndex ||
            view.expandedBlockOffset === 0);
        mouseTargets[output.length] = {
          rowId: row.rowId,
          disclosureColumn: row.hasChildren && disclosureMarkerVisible
            ? row.depth * 2
            : -1,
        };
      }
      output.push(
        entryIndex === targetEntryIndex && lineIndex === 0
          ? `\x1b[48;5;238m\x1b[1m${line}\x1b[0m`
          : line,
      );
      renderedBodyLines += 1;
    }
  }
  while (output.length < height - 2) output.push("");

  const selectedRow = view.rows[view.selectedIndex];
  const selectedBranchState =
    selectedRow?.kind === "physical"
      ? view.branchStates.get(selectedRow.canonicalId)
      : undefined;
  const selectedInfo = selectedExpandedInfo.current;
  const expandedScrollable = selectedInfo !== null && selectedInfo.total > bodyHeight;
  const expandedStatus = expandedScrollable
    ? `Expanded block rows ${selectedInfo.offset + 1}-${selectedInfo.end}/${selectedInfo.total}`
    : "";
  const creationHelp =
    view.mode === "add-child"
      ? virtualBranchCreationHelp(selectedBranchState, view.physicalBlocksById)
      : null;
  if (view.mode === "edit" || view.mode === "add-child" || view.mode === "add-sibling") {
    output.push(
      creationHelp
        ? truncate(creationHelp, width)
        : truncate(
          view.actionHelpText ?? DEFAULT_OUTLINER_ACTION_KEYMAP.helpText("tree", view.mode),
          width,
        ),
    );
  } else if (view.mode === "purge") {
    const required =
      selectedRow?.block.properties.find((property) => property.key === "work-id")?.value
      ?? selectedRow?.canonicalId.slice(0, 8)
      ?? "identifier";
    output.push(`\x1b[31;1mPurge ${required}: \x1b[0m${view.quickInput}▏`);
  } else if (view.mode === "filter" || view.mode === "goto") {
    const label = view.mode === "goto" ? "Goto" : "Filter";
    const completion = view.quickCompletion;
    const selectedCompletion = completion?.items[completion.index];
    let completionSuffix = "";
    if (completion && selectedCompletion) {
      completionSuffix = `  ${completion.index + 1}/${completion.items.length} ${selectedCompletion.label}`;
    } else if (view.status) {
      completionSuffix = `  ${view.status}`;
    }
    output.push(
      `\x1b[1m${label}:\x1b[0m ${truncate(
        `${view.quickInput}▏${completionSuffix}`,
        Math.max(1, width - label.length - 3),
      )}`,
    );
  } else if (view.mode === "delete") {
    if (selectedRow?.kind === "occurrence") {
      output.push(
        `\x1b[33;1m${truncate(
          `Move canonical block “${blockDisplayTitle(selectedRow.block)}” and its descendants to Trash? y/N`,
          width,
        )}\x1b[0m`,
      );
    } else {
      output.push("\x1b[33;1mMove this block and its descendants to Trash? y/N\x1b[0m");
    }
  } else {
    const contextualStatus =
      view.status ||
      expandedStatus ||
      (selectedBranchState ? branchStatusText(selectedBranchState) : "");
    output.push(truncate(contextualStatus, width));
  }
  const help = view.actionHelpText ??
    DEFAULT_OUTLINER_ACTION_KEYMAP.helpText("tree", view.mode);
  output.push(`\x1b[2m${truncate(help, width)}\x1b[0m`);
  return { frame: output.join("\n"), scrollStartEntryIndex, mouseTargets };
}
