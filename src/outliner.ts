import { rmSync } from "node:fs";
import { join } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { completionTargetAtCursor, completionWindow } from "./completion";
import { completeReferencedPaths, readReferencedFile } from "./files";
import { focusPluginPane, registerPaneState, requestDetailEdit } from "./pane-control";
import { resolvePaths } from "./paths";
import { parseFilter } from "./properties";
import { quickInsertionPoint } from "./quick-edit";
import { blockDisplayTitle } from "./references";
import { OutlinerServer } from "./server";
import { OutlinerStore } from "./store";
import { layoutExpandedBlock } from "./tree-layout";
import {
  TerminalInputDecoder,
  isDetailToggle,
  isPrintableInput,
  renderMarkdownLine,
  truncate,
  type TerminalKey,
} from "./terminal";
import { TextBuffer } from "./text-buffer";
import type { Block, VisibleBlock } from "./types";

type InputMode = "edit" | "add-child" | "add-sibling" | "filter";
type Mode = "browse" | "delete" | "viewer" | InputMode;

interface QuickCompletionState {
  start: number;
  end: number;
  index: number;
  items: Array<{ label: string; insertion: string }>;
}

type TreeRenderEntry =
  | { kind: "block"; blockIndex: number }
  | { kind: "quick"; depth: number };

const AUTHOR_MARKERS: Record<Block["author"], string> = {
  agent: "A",
  system: "S",
  user: " ",
};

const ESC = "\x1b[";
const paths = resolvePaths();
const store = new OutlinerStore(paths.database);
const server = new OutlinerServer(store, paths.socket);
await server.start();
const paneStatePath = join(paths.stateDir, "outliner-pane.json");
registerPaneState(paths.stateDir, "outliner", paths.workspaceRoot);

let rows: VisibleBlock[] = [];
let selectedIndex = 0;
let scrollStartEntryIndex = 0;
let activeFilter = "";
let mode: Mode = "browse";
let quickBuffer = new TextBuffer();
let quickCompletion: QuickCompletionState | null = null;
let viewerLines: string[] = [];
let viewerPath = "";
let viewerOffset = 0;
let lastSelectionId: string | null = null;
let lastSequence = -1;
let status = "";
let stopping = false;
const inputDecoder = new TerminalInputDecoder();

emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdout.write("\x1b[?1049h\x1b[?25l");

function reload(preferredSelectedId?: string | null): void {
  let selectedId: string | null | undefined = rows[selectedIndex]?.id ?? store.getSelection().selected?.id;
  if (preferredSelectedId !== undefined) selectedId = preferredSelectedId;
  rows = store.list({ filters: parseFilter(activeFilter) });
  const nextIndex = selectedId ? rows.findIndex((block) => block.id === selectedId) : -1;
  selectedIndex = Math.max(0, Math.min(nextIndex >= 0 ? nextIndex : selectedIndex, rows.length - 1));
  lastSequence = store.sequence;
}

function quickInputText(): string {
  return quickBuffer.lines[0] ?? "";
}

function isCanonicalDescendant(candidateId: string, ancestorId: string): boolean {
  let candidate = store.get(candidateId);
  while (candidate?.parentId) {
    if (candidate.parentId === ancestorId) return true;
    candidate = store.get(candidate.parentId);
  }
  return false;
}

function renderQuickInputRow(
  depth: number,
  marker: string,
  author: string,
  width: number,
): string {
  const prefix = `${"  ".repeat(depth)}${marker} `;
  const suffix = `  ${author}`;
  const available = Math.max(1, width - prefix.length - suffix.length);
  const textWidth = Math.max(0, available - 1);
  const line = quickInputText();
  const horizontalOffset = Math.max(0, quickBuffer.column - textWidth);
  const visible = line.slice(horizontalOffset, horizontalOffset + textWidth);
  const cursor = Math.max(0, quickBuffer.column - horizontalOffset);
  const content = `${visible.slice(0, cursor)}▏${visible.slice(cursor)}`;
  return truncate(`${prefix}${content}${suffix}`, width);
}

function quickCompletionRows(depth: number, width: number): string[] {
  if (!quickCompletion) return [];
  const prefix = `${"  ".repeat(depth)}  `;
  const window = completionWindow(quickCompletion.items.length, quickCompletion.index, 6);
  const completionRows = [
    `${prefix}\x1b[2m${truncate(
      `Completions ${quickCompletion.index + 1}/${quickCompletion.items.length}`,
      Math.max(1, width - prefix.length),
    )}\x1b[0m`,
  ];
  for (let index = window.start; index < window.end; index++) {
    const item = quickCompletion.items[index];
    const label = truncate(item.label, Math.max(1, width - prefix.length - 2));
    completionRows.push(
      index === quickCompletion.index ? `${prefix}\x1b[7m› ${label}\x1b[0m` : `${prefix}  ${label}`,
    );
  }
  return completionRows;
}

function draw(): void {
  const width = process.stdout.columns ?? 100;
  const height = process.stdout.rows ?? 30;
  const output: string[] = [`${ESC}H${ESC}2J`];

  if (mode === "viewer") {
    output.push(`\x1b[1m${truncate(viewerPath, width)}\x1b[0m`);
    output.push("─".repeat(width));
    const bodyHeight = Math.max(1, height - 3);
    for (const line of viewerLines.slice(viewerOffset, viewerOffset + bodyHeight)) {
      output.push(renderMarkdownLine(truncate(line, width)));
    }
    while (output.length < height) output.push("");
    output.push(`\x1b[2m↑↓ scroll  g/G ends  Esc close  ${viewerOffset + 1}/${Math.max(1, viewerLines.length)}\x1b[0m`);
    process.stdout.write(output.join("\n"));
    return;
  }

  output.push(`\x1b[1;36mOutliner\x1b[0m  \x1b[2m${truncate(paths.workspaceRoot, Math.max(10, width - 20))}\x1b[0m`);
  const filterLabel = activeFilter ? `  \x1b[33mfilter: ${activeFilter}\x1b[0m` : "";
  output.push(`\x1b[2m${rows.length} blocks${filterLabel}\x1b[0m`);
  output.push("─".repeat(width));
  const insertionPoint =
    mode === "add-child" || mode === "add-sibling"
      ? quickInsertionPoint(rows, selectedIndex, mode, isCanonicalDescendant)
      : null;
  const entries: TreeRenderEntry[] = [];
  for (let index = 0; index <= rows.length; index++) {
    if (insertionPoint?.gap === index) entries.push({ kind: "quick", depth: insertionPoint.depth });
    if (index < rows.length) entries.push({ kind: "block", blockIndex: index });
  }

  const physicalRows: Array<string[] | undefined> = [];
  function getBlockRows(index: number): string[] {
    const cached = physicalRows[index];
    if (cached) return cached;

    const block = rows[index];
    const hasChildren = store.children(block.id).length > 0;
    let marker = "•";
    if (hasChildren) marker = block.collapsed ? "▸" : "▾";
    const author = AUTHOR_MARKERS[block.author];
    const editingInline = mode === "edit" && index === selectedIndex;
    if (editingInline) {
      const result = [
        renderQuickInputRow(block.depth, marker, author, width),
        ...quickCompletionRows(block.depth + 1, width),
      ];
      physicalRows[index] = result;
      return result;
    }

    const displayText = store.resolveBlockReferences(block.text);
    const expanded = block.multilineExpanded && displayText.includes("\n");
    const result = expanded
      ? layoutExpandedBlock({
          text: displayText,
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
            `${"  ".repeat(block.depth)}${marker} ${displayText.replace(/\r?\n/g, " ↵ ")}  ${author}`,
            width,
          ),
        ];
    physicalRows[index] = result;
    return result;
  }

  function getEntryRows(entry: TreeRenderEntry): string[] {
    return entry.kind === "block"
      ? getBlockRows(entry.blockIndex)
      : [
          renderQuickInputRow(entry.depth, "•", AUTHOR_MARKERS.user, width),
          ...quickCompletionRows(entry.depth + 1, width),
        ];
  }

  const targetEntryIndex = Math.max(
    0,
    entries.findIndex((entry) =>
      insertionPoint
        ? entry.kind === "quick"
        : entry.kind === "block" && entry.blockIndex === selectedIndex,
    ),
  );
  const bodyHeight = Math.max(1, height - 6);
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
    const entry = entries[entryIndex];
    const entryRows = getEntryRows(entry);
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

  if (mode === "edit" || mode === "add-child" || mode === "add-sibling") {
    output.push("Quick edit: ←→ cursor  Tab complete  Enter save  Shift+Enter/Ctrl+E multiline  Esc cancel");
  } else if (mode === "filter") {
    const label = "Filter";
    output.push(`\x1b[1m${label}:\x1b[0m ${truncate(`${quickInputText()}▏`, Math.max(1, width - label.length - 3))}`);
  } else if (mode === "delete") {
    output.push("\x1b[31;1mDelete this block and all descendants? y/N\x1b[0m");
  } else {
    output.push(truncate(status, width));
  }
  const help = "↑↓ navigate  Shift+↑↓ reorder  . / ⌘. detail  Enter inline  Ctrl+Q close";
  output.push(`\x1b[2m${truncate(help, width)}\x1b[0m`);
  process.stdout.write(output.join("\n"));
}

function resetQuickEditor(): void {
  quickBuffer = new TextBuffer();
  quickCompletion = null;
}

function beginInput(nextMode: InputMode, initial = ""): void {
  const selected = rows[selectedIndex];
  if (nextMode === "add-child" && selected?.collapsed) {
    store.toggle(selected.id);
    reload(selected.id);
  }
  mode = nextMode;
  quickBuffer = new TextBuffer(initial);
  quickBuffer.moveEnd();
  quickCompletion = null;
  draw();
}

function commitQuickBlock(): string | null {
  const selected = rows[selectedIndex];
  if (!selected) return null;
  const text = quickInputText();
  if (!text.trim()) return mode === "edit" ? selected.id : null;

  if (mode === "edit") {
    store.update(selected.id, text);
    return selected.id;
  }
  if (mode === "add-child") {
    const created = store.create(text, selected.id, "user");
    store.move(created.id, selected.id, 0);
    return created.id;
  }
  if (mode === "add-sibling") {
    const canonical = store.require(selected.id);
    const created = store.create(text, canonical.parentId, "user");
    store.move(created.id, canonical.parentId, canonical.position + 1);
    return created.id;
  }
  return null;
}

function syncVisibleSelection(preferredId: string | null): void {
  reload(preferredId);
  if (preferredId && !rows.some((row) => row.id === preferredId)) {
    activeFilter = "";
    reload(preferredId);
    status = "Filter cleared to show saved block";
  }
  const visibleId = rows[selectedIndex]?.id ?? null;
  lastSelectionId = visibleId;
  store.setSelection(visibleId);
}

function finishInput(): void {
  if (mode === "filter") {
    activeFilter = quickInputText().trim();
    mode = "browse";
    resetQuickEditor();
    reload();
    const visibleId = rows[selectedIndex]?.id ?? null;
    lastSelectionId = visibleId;
    store.setSelection(visibleId);
    draw();
    return;
  }

  const committedBlockId = commitQuickBlock();
  const fallbackId = rows[selectedIndex]?.id ?? null;
  mode = "browse";
  resetQuickEditor();
  syncVisibleSelection(committedBlockId ?? fallbackId);
  draw();
}

function handoffToDetail(): void {
  const selected = rows[selectedIndex];
  if (!selected) return;
  const committedBlockId = commitQuickBlock();
  if ((mode === "add-child" || mode === "add-sibling") && !committedBlockId) {
    status = "Type a title before opening multiline detail";
    draw();
    return;
  }
  const targetId = committedBlockId ?? selected.id;
  mode = "browse";
  resetQuickEditor();
  syncVisibleSelection(targetId);
  requestDetailEdit(paths.stateDir, targetId);
  try {
    focusPluginPane(paths.stateDir, "detail");
    status = "Multiline editor opened in detail pane";
  } catch (error) {
    status = error instanceof Error ? error.message : String(error);
  }
  draw();
}

function openQuickCompletion(): void {
  if (mode === "filter") return;
  const line = quickInputText();
  const target = completionTargetAtCursor(line, quickBuffer.column);
  if (!target) {
    status = "Type [[page, ((block, or [file::path before requesting completion";
    return;
  }

  let items: QuickCompletionState["items"];
  if (target.kind === "file") {
    try {
      items = completeReferencedPaths(target.query, paths.workspaceRoot).map((candidate) => ({
        label: candidate.sourcePath,
        insertion: `[file::${candidate.sourcePath}${candidate.isDirectory ? "" : "]"}`,
      }));
    } catch (error) {
      quickCompletion = null;
      status = error instanceof Error ? error.message : String(error);
      return;
    }
  } else {
    let blocks: VisibleBlock[] = [];
    if (target.kind === "page") {
      blocks = store.list({
        text: target.query || undefined,
        filters: [{ key: "type", value: "page" }],
        limit: 20,
      });
    }
    if (blocks.length === 0) {
      blocks = store.list({ text: target.query || undefined, limit: 20, includeCollapsed: true });
    }
    items = blocks.map((block) => {
      const title = blockDisplayTitle(block);
      return {
        label: title,
        insertion: target.kind === "page" ? `[[${title}]]` : `((${block.id}))`,
      };
    });
  }

  if (items.length === 0) {
    quickCompletion = null;
    status = target.kind === "file" ? "No matching files" : "No matching blocks";
    return;
  }
  quickCompletion = {
    start: target.start,
    end: target.end,
    index: 0,
    items,
  };
  status = "";
}

function applyQuickCompletion(): void {
  if (!quickCompletion) return;
  const item = quickCompletion.items[quickCompletion.index];
  quickBuffer.replaceCurrentLine(quickCompletion.start, quickCompletion.end, item.insertion);
  quickCompletion = null;
}

function openReferencedFile(block: Block): void {
  try {
    const file = readReferencedFile(block, paths.workspaceRoot);
    viewerLines = file.lines;
    viewerPath = `${file.displayPath}${file.firstLine > 1 ? `:${file.firstLine}` : ""}`;
    viewerOffset = 0;
    mode = "viewer";
    status = "";
  } catch (error) {
    status = error instanceof Error ? error.message : String(error);
  }
}

function indent(selected: VisibleBlock): void {
  for (let index = selectedIndex - 1; index >= 0; index--) {
    const candidate = rows[index];
    if (candidate.depth < selected.depth) break;
    if (candidate.depth === selected.depth) {
      store.move(selected.id, candidate.id);
      return;
    }
  }
  status = "No previous sibling to indent beneath";
}

function outdent(selected: VisibleBlock): void {
  if (!selected.parentId) return;
  const parent = store.require(selected.parentId);
  store.move(selected.id, parent.parentId, parent.position + 1);
}

function moveSibling(selected: VisibleBlock, offset: -1 | 1): string {
  const canonical = store.require(selected.id);
  const siblings = store.children(canonical.parentId);
  const currentIndex = siblings.findIndex((sibling) => sibling.id === canonical.id);
  const targetIndex = currentIndex + offset;
  if (currentIndex < 0 || targetIndex < 0) {
    status = "Already first sibling";
  } else if (targetIndex >= siblings.length) {
    status = "Already last sibling";
  } else {
    store.move(canonical.id, canonical.parentId, targetIndex);
    status = offset < 0 ? "Moved up among siblings" : "Moved down among siblings";
  }
  return canonical.id;
}

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(refreshTimer);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdout.write("\x1b[?25h\x1b[?1049l");
  await server.close();
  rmSync(paneStatePath, { force: true });
  store.close();
  process.exit(0);
}

process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
process.on("SIGHUP", () => void stop());

process.stdin.on("keypress", (str: string, key: TerminalKey) => {
  const inputAction = inputDecoder.consume(str, key);
  if (inputAction === "suppress") return;
  if (key.ctrl && key.name === "q") {
    void stop();
    return;
  }
  if (key.ctrl && key.name === "c") {
    if (mode !== "browse") {
      mode = "browse";
      resetQuickEditor();
    } else {
      status = "Ctrl+Q closes the outliner pane";
    }
    draw();
    return;
  }
  const detailHandoffRequested =
    inputAction === "modified-enter" || (key.name === "e" && key.ctrl);

  if (mode === "viewer") {
    const page = Math.max(1, (process.stdout.rows ?? 30) - 4);
    const maxOffset = Math.max(0, viewerLines.length - 1);
    if (key.name === "escape" || key.name === "q") mode = "browse";
    else if (key.name === "up") viewerOffset = Math.max(0, viewerOffset - 1);
    else if (key.name === "down") viewerOffset = Math.min(maxOffset, viewerOffset + 1);
    else if (key.name === "pageup") viewerOffset = Math.max(0, viewerOffset - page);
    else if (key.name === "pagedown") viewerOffset = Math.min(maxOffset, viewerOffset + page);
    else if (str === "g") viewerOffset = 0;
    else if (str === "G") viewerOffset = Math.max(0, viewerLines.length - page);
    draw();
    return;
  }

  if (mode === "delete") {
    if (str.toLowerCase() === "y" && rows[selectedIndex]) store.delete(rows[selectedIndex].id);
    mode = "browse";
    reload();
    lastSelectionId = rows[selectedIndex]?.id ?? null;
    store.setSelection(lastSelectionId);
    draw();
    return;
  }

  if (mode !== "browse") {
    if (quickCompletion) {
      if (key.name === "up") quickCompletion.index = Math.max(0, quickCompletion.index - 1);
      else if (key.name === "down") {
        quickCompletion.index = Math.min(quickCompletion.items.length - 1, quickCompletion.index + 1);
      } else if (key.name === "return" || key.name === "tab") applyQuickCompletion();
      else if (key.name === "escape") quickCompletion = null;
      draw();
      return;
    }

    if (mode !== "filter" && detailHandoffRequested) {
      handoffToDetail();
      return;
    }
    if (key.name === "escape") {
      mode = "browse";
      resetQuickEditor();
    } else if (key.name === "return") {
      finishInput();
      return;
    } else if (key.name === "tab" && mode !== "filter") {
      openQuickCompletion();
    } else if (key.name === "backspace") quickBuffer.backspace();
    else if (key.name === "delete") quickBuffer.deleteForward();
    else if (key.name === "left") quickBuffer.moveLeft();
    else if (key.name === "right") quickBuffer.moveRight();
    else if (key.name === "home") quickBuffer.moveHome();
    else if (key.name === "end") quickBuffer.moveEnd();
    else if (isPrintableInput(str, key)) quickBuffer.insert(str);
    draw();
    return;
  }

  const selected = rows[selectedIndex];
  let preferredSelectedId: string | undefined;
  if (key.name === "q") {
    status = "Outliner remains open; Ctrl+Q closes this pane";
  } else if (isDetailToggle(str, key)) {
    if (!selected || !selected.text.includes("\n")) {
      status = "Selected block has no multiline detail";
    } else {
      const expanded = store.toggleMultilineExpanded(selected.id);
      status = expanded ? "Multiline detail expanded" : "Multiline detail collapsed";
    }
  } else if (detailHandoffRequested) {
    handoffToDetail();
    return;
  } else if (key.shift && key.name === "up") {
    if (selected) preferredSelectedId = moveSibling(selected, -1);
  } else if (key.shift && key.name === "down") {
    if (selected) preferredSelectedId = moveSibling(selected, 1);
  } else if (key.name === "up") selectedIndex = Math.max(0, selectedIndex - 1);
  else if (key.name === "down") selectedIndex = Math.min(rows.length - 1, selectedIndex + 1);
  else if (key.name === "left" && selected) {
    if (!selected.collapsed && store.children(selected.id).length) store.toggle(selected.id);
    else if (selected.parentId) selectedIndex = Math.max(0, rows.findIndex((block) => block.id === selected.parentId));
  } else if (key.name === "right" && selected) {
    if (selected.collapsed) store.toggle(selected.id);
    else if (store.children(selected.id).length) selectedIndex = Math.min(rows.length - 1, selectedIndex + 1);
  } else if (key.name === "return" && selected) {
    if (selected.text.includes("\n")) {
      handoffToDetail();
      return;
    }
    beginInput("edit", selected.text);
  } else if (key.name === "tab" && selected) {
    if (key.shift) outdent(selected);
    else indent(selected);
  } else if (key.name === "space" && selected) store.toggle(selected.id);
  else if (str === "a" && selected) beginInput("add-child");
  else if (str === "s" && selected) beginInput("add-sibling");
  else if (str === "/") beginInput("filter", activeFilter);
  else if (str === "d" && selected) mode = "delete";
  else if (str === "f" && selected) openReferencedFile(selected);
  else if (key.name === "escape" && activeFilter) activeFilter = "";

  reload(preferredSelectedId);
  if (rows[selectedIndex]) {
    lastSelectionId = rows[selectedIndex].id;
    store.setSelection(lastSelectionId);
  }
  draw();
});

process.stdout.on("resize", draw);
const refreshTimer = setInterval(() => {
  if (mode !== "browse") return;
  const sharedSelectionId = store.getSelection().selected?.id ?? null;
  if (sharedSelectionId !== lastSelectionId) {
    lastSelectionId = sharedSelectionId;
    reload(sharedSelectionId);
    draw();
  } else if (store.sequence !== lastSequence) {
    reload();
    draw();
  }
}, 250);

lastSelectionId = store.getSelection().selected?.id ?? null;
reload(lastSelectionId);
draw();
