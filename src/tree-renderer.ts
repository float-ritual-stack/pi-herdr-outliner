import { completionWindow } from "./completion";
import { quickInsertionPoint } from "./quick-edit";
import { blockDisplayTitle } from "./references";
import { layoutExpandedBlock } from "./tree-layout";
import { renderMarkdownLine, truncate } from "./terminal";
import type { Block, VisibleBlock } from "./types";
import type { TreeQuickCompletion, TreeView } from "./tree-controller";
import type { TreeRow, VirtualBranchState } from "./virtual-branches";

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function branchStateLabel(state: VirtualBranchState): string {
  const indicators = [`V:${state.count}`];
  if (state.completeness?.kind === "truncated") indicators.push("TRUNCATED");
  if (state.configurationErrors.length > 0) indicators.push("CONFIG ERROR");
  if (state.queryError) indicators.push("QUERY ERROR");
  if (state.config?.readOnly) indicators.push("READ-ONLY");
  return ` [${indicators.join(" · ")}]`;
}

function branchStatusText(state: VirtualBranchState): string {
  const details = [countLabel(state.count, "projected occurrence")];
  if (state.completeness?.kind === "truncated") {
    details.push(`TRUNCATED at ${state.completeness.limit}`);
  }
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

function decorateDefinitionText(text: string, state: VirtualBranchState | undefined): string {
  if (!state) return text;
  const newlineIndex = text.search(/\r?\n/);
  if (newlineIndex < 0) return `${text}${branchStateLabel(state)}`;
  return `${text.slice(0, newlineIndex)}${branchStateLabel(state)}${text.slice(newlineIndex)}`;
}

function virtualBranchCreationHelp(
  state: VirtualBranchState | undefined,
  physicalBlocksById: ReadonlyMap<string, VisibleBlock>,
): string | null {
  const config = state?.config;
  if (!config || config.readOnly || !config.create || !config.createParentId) return null;
  const parent = physicalBlocksById.get(config.createParentId);
  const parentTitle = parent ? blockDisplayTitle(parent) : config.createParentId;
  return `Create canonical under ${parentTitle} · sets [${config.create.key}::${config.create.value}] · Enter save · Esc cancel`;
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
): TreeRenderResult {
  const output: string[] = [`${ESC}H${ESC}2J`];

  if (view.mode === "viewer") {
    output.push(`\x1b[1m${truncate(view.viewerPath, width)}\x1b[0m`);
    output.push("─".repeat(width));
    const bodyHeight = Math.max(1, height - 3);
    for (const line of view.viewerLines.slice(view.viewerOffset, view.viewerOffset + bodyHeight)) {
      output.push(renderMarkdownLine(truncate(line, width)));
    }
    while (output.length < height - 1) output.push("");
    output.push(
      `\x1b[2m↑↓ scroll  g/G ends  Esc close  ${view.viewerOffset + 1}/${Math.max(1, view.viewerLines.length)}\x1b[0m`,
    );
    return { frame: output.join("\n"), scrollStartEntryIndex: initialScrollStartEntryIndex };
  }

  output.push(
    `\x1b[1;36mOutliner\x1b[0m  \x1b[2m${truncate(view.workspaceRoot, Math.max(10, width - 20))}\x1b[0m`,
  );
  const filterLabel = view.activeFilter ? `  \x1b[33mfilter: ${view.activeFilter}\x1b[0m` : "";
  const truncationLabel =
    view.visibleCompleteness.kind === "truncated"
      ? `  \x1b[33mWARNING: truncated at ${view.visibleCompleteness.limit}\x1b[0m`
      : "";
  const physicalCount = view.rows.reduce((count, row) => count + Number(row.kind === "physical"), 0);
  const occurrenceCount = view.rows.length - physicalCount;
  output.push(
    `\x1b[2m${countLabel(physicalCount, "physical block")} · ${countLabel(
      occurrenceCount,
      "projected occurrence",
    )}${filterLabel}\x1b[0m${truncationLabel}`,
  );
  output.push("─".repeat(width));
  const bodyHeight = Math.max(1, height - 6);
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
  const entries: TreeRenderEntry[] = [];
  for (let index = 0; index <= view.rows.length; index++) {
    if (insertionPoint?.gap === index) entries.push({ kind: "quick", depth: insertionPoint.depth });
    if (index < view.rows.length) entries.push({ kind: "block", blockIndex: index });
  }

  const renderedRows: Array<string[] | undefined> = [];
  function getBlockRows(index: number): string[] {
    const cached = renderedRows[index];
    if (cached) return cached;

    const row = view.rows[index];
    const block = row.block;
    let marker = row.kind === "occurrence" ? "◇" : "•";
    if (row.kind === "physical" && row.hasChildren) marker = block.collapsed ? "▸" : "▾";
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

    const branchState =
      row.kind === "physical" ? view.branchStates.get(row.canonicalId) : undefined;
    let result: string[];
    if (!row.multilineExpanded && branchState) {
      const prefix = `${"  ".repeat(row.depth)}${marker} `;
      const suffix = `  ${author}`;
      const badge = truncate(
        branchStateLabel(branchState),
        Math.max(1, width - prefix.length - suffix.length),
      );
      const titleWidth = Math.max(1, width - prefix.length - suffix.length - badge.length);
      const title = truncate(block.displayText.replace(/\r?\n/g, " ↵ "), titleWidth);
      result = [truncate(`${prefix}${title}${badge}${suffix}`, width)];
    } else {
      const displayText = decorateDefinitionText(block.displayText, branchState);
      if (row.multilineExpanded) {
        const expandedRows = layoutExpandedBlock({
          text: displayText,
          width,
          depth: row.depth,
          marker,
          author,
        }).map((renderedRow, rowIndex) => {
          const text = rowIndex === 0 ? renderedRow.text : renderMarkdownLine(renderedRow.text);
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
      } else {
        result = [
          truncate(
            `${"  ".repeat(row.depth)}${marker} ${displayText.replace(/\r?\n/g, " ↵ ")}  ${author}`,
            width,
          ),
        ];
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

  function isTargetEntry(entry: TreeRenderEntry): boolean {
    if (insertionPoint) return entry.kind === "quick";
    return entry.kind === "block" && entry.blockIndex === view.selectedIndex;
  }
  const targetEntryIndex = Math.max(0, entries.findIndex(isTargetEntry));
  let scrollStartEntryIndex = initialScrollStartEntryIndex;
  if (targetEntryIndex < scrollStartEntryIndex) scrollStartEntryIndex = targetEntryIndex;
  if (scrollStartEntryIndex < targetEntryIndex) {
    let requiredHeight = 0;
    for (let index = scrollStartEntryIndex; index <= targetEntryIndex; index++) {
      requiredHeight += getEntryRows(entries[index]).length;
    }
    while (requiredHeight > bodyHeight && scrollStartEntryIndex < targetEntryIndex) {
      requiredHeight -= getEntryRows(entries[scrollStartEntryIndex]).length;
      scrollStartEntryIndex += 1;
    }
  }

  let renderedBodyLines = 0;
  for (let entryIndex = scrollStartEntryIndex; entryIndex < entries.length; entryIndex++) {
    if (renderedBodyLines >= bodyHeight) break;
    const entryRows = getEntryRows(entries[entryIndex]);
    for (let lineIndex = 0; lineIndex < entryRows.length; lineIndex++) {
      if (renderedBodyLines >= bodyHeight) break;
      const line = entryRows[lineIndex];
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
        : "Quick edit: ←→ cursor  Tab complete  Enter save  Shift+Enter/Ctrl+E multiline  Esc cancel",
    );
  } else if (view.mode === "filter" || view.mode === "goto") {
    const label = view.mode === "goto" ? "Goto" : "Filter";
    const completion = view.quickCompletion;
    const selectedCompletion = completion?.items[completion.index];
    let completionSuffix = "";
    if (completion && selectedCompletion) {
      completionSuffix = `  ${completion.index + 1}/${completion.items.length} ${selectedCompletion.label}`;
    } else if (view.mode === "goto" && view.status) {
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
        `\x1b[31;1m${truncate(
          `Delete canonical block “${blockDisplayTitle(selectedRow.block)}” and its physical descendants? Removes it everywhere. y/N`,
          width,
        )}\x1b[0m`,
      );
    } else {
      output.push("\x1b[31;1mDelete this block and all descendants? y/N\x1b[0m");
    }
  } else {
    const contextualStatus =
      view.status ||
      expandedStatus ||
      (selectedBranchState ? branchStatusText(selectedBranchState) : "");
    output.push(truncate(contextualStatus, width));
  }
  let help: string;
  if (view.mode === "goto") {
    help = "type ID/text  ↑↓ choose  Tab cycle  Enter jump  Esc cancel";
  } else if (expandedScrollable) {
    help = "PgUp/PgDn scroll selected block  ↑↓ navigate blocks  g goto  . / ⌘. detail";
  } else if (selectedRow?.kind === "occurrence") {
    help = "◇ projected occurrence  ← definition  Enter edit canonical  d delete canonical  hierarchy disabled";
  } else {
    help = "↑↓ navigate  Shift+↑↓ reorder  g goto  . / ⌘. detail  Enter inline  Ctrl+Q close";
  }
  output.push(`\x1b[2m${truncate(help, width)}\x1b[0m`);
  return { frame: output.join("\n"), scrollStartEntryIndex };
}
