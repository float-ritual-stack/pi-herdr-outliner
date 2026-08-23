import { completionWindow } from "./completion";
import { quickInsertionPoint } from "./quick-edit";
import { layoutExpandedBlock } from "./tree-layout";
import { renderMarkdownLine, truncate } from "./terminal";
import type { Block } from "./types";
import type { TreeQuickCompletion, TreeView } from "./tree-controller";

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
  output.push(`\x1b[2m${view.rows.length} blocks${filterLabel}\x1b[0m${truncationLabel}`);
  output.push("─".repeat(width));

  function isCanonicalDescendant(candidateId: string, ancestorId: string): boolean {
    let candidate = view.physicalBlocksById.get(candidateId);
    while (candidate?.parentId) {
      if (candidate.parentId === ancestorId) return true;
      candidate = view.physicalBlocksById.get(candidate.parentId);
    }
    return false;
  }
  const insertionPoint =
    view.mode === "add-child" || view.mode === "add-sibling"
      ? quickInsertionPoint(view.rows, view.selectedIndex, view.mode, isCanonicalDescendant)
      : null;
  const entries: TreeRenderEntry[] = [];
  for (let index = 0; index <= view.rows.length; index++) {
    if (insertionPoint?.gap === index) entries.push({ kind: "quick", depth: insertionPoint.depth });
    if (index < view.rows.length) entries.push({ kind: "block", blockIndex: index });
  }

  const physicalRows: Array<string[] | undefined> = [];
  function getBlockRows(index: number): string[] {
    const cached = physicalRows[index];
    if (cached) return cached;

    const block = view.rows[index];
    let marker = "•";
    if (block.hasChildren) marker = block.collapsed ? "▸" : "▾";
    const author = AUTHOR_MARKERS[block.author];
    const editingInline = view.mode === "edit" && index === view.selectedIndex;
    if (editingInline) {
      const result = [
        renderQuickInputRow(view.quickInput, view.quickColumn, block.depth, marker, author, width),
        ...renderQuickCompletionRows(view.quickCompletion, block.depth + 1, width),
      ];
      physicalRows[index] = result;
      return result;
    }

    const result = block.multilineExpanded
      ? layoutExpandedBlock({
          text: block.displayText,
          width,
          depth: block.depth,
          marker,
          author,
        }).map((row, rowIndex) => {
          const text = rowIndex === 0 ? row.text : renderMarkdownLine(row.text);
          return `${row.prefix}${text}${row.suffix}`;
        })
      : [
          truncate(
            `${"  ".repeat(block.depth)}${marker} ${block.displayText.replace(/\r?\n/g, " ↵ ")}  ${author}`,
            width,
          ),
        ];
    physicalRows[index] = result;
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
  const bodyHeight = Math.max(1, height - 6);
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

  if (view.mode === "edit" || view.mode === "add-child" || view.mode === "add-sibling") {
    output.push("Quick edit: ←→ cursor  Tab complete  Enter save  Shift+Enter/Ctrl+E multiline  Esc cancel");
  } else if (view.mode === "filter") {
    const label = "Filter";
    output.push(
      `\x1b[1m${label}:\x1b[0m ${truncate(`${view.quickInput}▏`, Math.max(1, width - label.length - 3))}`,
    );
  } else if (view.mode === "delete") {
    output.push("\x1b[31;1mDelete this block and all descendants? y/N\x1b[0m");
  } else {
    output.push(truncate(view.status, width));
  }
  const help = "↑↓ navigate  Shift+↑↓ reorder  . / ⌘. detail  Enter inline  Ctrl+Q close";
  output.push(`\x1b[2m${truncate(help, width)}\x1b[0m`);
  return { frame: output.join("\n"), scrollStartEntryIndex };
}
