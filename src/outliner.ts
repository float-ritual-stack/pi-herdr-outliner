import { rmSync } from "node:fs";
import { join } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { readReferencedFile } from "./files";
import { parseFilter } from "./properties";
import { resolvePaths } from "./paths";
import { focusPluginPane, registerPaneState, requestDetailEdit } from "./pane-control";
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
import type { Block, VisibleBlock } from "./types";

type InputMode = "edit" | "add-child" | "add-sibling" | "filter";
type Mode = "browse" | "delete" | "viewer" | InputMode;

const AUTHOR_MARKERS: Record<Block["author"], string> = {
  agent: "A",
  system: "S",
  user: " ",
};
const INPUT_LABELS: Record<InputMode, string> = {
  edit: "Edit",
  "add-child": "Add",
  "add-sibling": "Add",
  filter: "Filter",
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
let scrollStartIndex = 0;
let activeFilter = "";
let mode: Mode = "browse";
let input = "";
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
  const physicalRows: Array<string[] | undefined> = [];
  function getPhysicalRows(index: number): string[] {
    const cached = physicalRows[index];
    if (cached) return cached;

    const block = rows[index];
    const hasChildren = store.children(block.id).length > 0;
    let marker = "•";
    if (hasChildren) marker = block.collapsed ? "▸" : "▾";
    const author = AUTHOR_MARKERS[block.author];
    const editingInline = mode === "edit" && index === selectedIndex;
    const displayText = editingInline ? block.text : store.resolveBlockReferences(block.text);
    const expanded = block.multilineExpanded && displayText.includes("\n") && !editingInline;
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
            `${"  ".repeat(block.depth)}${marker} ${
              editingInline ? `${input}▏` : displayText.replace(/\r?\n/g, " ↵ ")
            }  ${author}`,
            width,
          ),
        ];
    physicalRows[index] = result;
    return result;
  }

  const bodyHeight = Math.max(1, height - 6);
  if (selectedIndex < scrollStartIndex) scrollStartIndex = selectedIndex;
  if (scrollStartIndex < selectedIndex) {
    let requiredHeight = 0;
    for (let index = scrollStartIndex; index <= selectedIndex; index++) {
      requiredHeight += getPhysicalRows(index).length;
    }
    while (requiredHeight > bodyHeight && scrollStartIndex < selectedIndex) {
      requiredHeight -= getPhysicalRows(scrollStartIndex).length;
      scrollStartIndex += 1;
    }
  }

  let renderedBodyLines = 0;
  for (let absoluteIndex = scrollStartIndex; absoluteIndex < rows.length; absoluteIndex++) {
    if (renderedBodyLines >= bodyHeight) break;
    const blockLines = getPhysicalRows(absoluteIndex);
    for (let lineIndex = 0; lineIndex < blockLines.length; lineIndex++) {
      if (renderedBodyLines >= bodyHeight) break;
      const line = blockLines[lineIndex];
      output.push(
        absoluteIndex === selectedIndex && lineIndex === 0
          ? `\x1b[48;5;238m\x1b[1m${line}\x1b[0m`
          : line,
      );
      renderedBodyLines += 1;
    }
  }
  while (output.length < height - 2) output.push("");

  if (mode === "edit") {
    output.push("Inline edit: Enter save  Shift+Enter/Ctrl+E multiline  Esc cancel");
  } else if (mode === "add-child" || mode === "add-sibling" || mode === "filter") {
    const label = INPUT_LABELS[mode];
    output.push(`\x1b[1m${label}:\x1b[0m ${truncate(`${input}▏`, Math.max(1, width - label.length - 3))}`);
  } else if (mode === "delete") {
    output.push("\x1b[31;1mDelete this block and all descendants? y/N\x1b[0m");
  } else {
    output.push(truncate(status, width));
  }
  const help = "↑↓ navigate  Shift+↑↓ reorder  . / ⌘. detail  Enter inline  Ctrl+Q close";
  output.push(`\x1b[2m${truncate(help, width)}\x1b[0m`);
  process.stdout.write(output.join("\n"));
}

function beginInput(nextMode: InputMode, initial = ""): void {
  mode = nextMode;
  input = initial;
  draw();
}

function finishInput(): void {
  const selected = rows[selectedIndex];
  const value = input.trim();
  switch (mode) {
    case "edit":
      if (selected && value) store.update(selected.id, input);
      break;
    case "add-child":
      if (selected && value) store.create(input, selected.id, "user");
      break;
    case "add-sibling":
      if (selected && value) store.create(input, selected.parentId, "user");
      break;
    case "filter":
      activeFilter = value;
      break;
  }
  mode = "browse";
  input = "";
  reload();
  draw();
}

function handoffToDetail(): void {
  const selected = rows[selectedIndex];
  if (!selected) return;
  if (mode === "edit" && input.trim()) store.update(selected.id, input);
  mode = "browse";
  input = "";
  lastSelectionId = selected.id;
  store.setSelection(selected.id);
  requestDetailEdit(paths.stateDir, selected.id);
  try {
    focusPluginPane(paths.stateDir, "detail");
    status = "Multiline editor opened in detail pane";
  } catch (error) {
    status = error instanceof Error ? error.message : String(error);
  }
  reload(selected.id);
  draw();
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
      input = "";
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
    const multilineHandoff = mode === "edit" && detailHandoffRequested;
    if (multilineHandoff) {
      handoffToDetail();
      return;
    }
    if (key.name === "escape") {
      mode = "browse";
      input = "";
    } else if (key.name === "return") {
      finishInput();
      return;
    } else if (key.name === "backspace") {
      input = input.slice(0, -1);
    } else if (isPrintableInput(str, key)) {
      input += str;
    }
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
