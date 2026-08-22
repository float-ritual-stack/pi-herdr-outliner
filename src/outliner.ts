import { rmSync } from "node:fs";
import { join } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { OutlinerClient, type OutlinerWatcher } from "./client";
import { completionTargetAtCursor, completionWindow } from "./completion";
import { completeReferencedPaths, readReferencedFile } from "./files";
import { focusPluginPane, registerPaneState } from "./pane-control";
import { resolvePaths } from "./paths";
import { parseFilter } from "./properties";
import { quickInsertionPoint } from "./quick-edit";
import { blockDisplayTitle } from "./references";
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
import {
  OUTLINER_PROTOCOL_VERSION,
  type Block,
  type OutlinerEvent,
  type OutlinerServiceStatus,
  type VisibleBlock,
  type WorkspaceSnapshot,
} from "./types";

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
const client = new OutlinerClient(paths.socket);
const paneStatePath = join(paths.stateDir, "outliner-pane.json");
registerPaneState(paths.stateDir, "outliner", paths.workspaceRoot);

let rows: VisibleBlock[] = [];
let allBlocksById = new Map<string, VisibleBlock>();
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
let status = "";
let stopping = false;
let watcher: OutlinerWatcher | null = null;
let refreshPending = false;
let workQueue = Promise.resolve();
const inputDecoder = new TerminalInputDecoder();

emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdout.write("\x1b[?1049h\x1b[?25l");

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForService(): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const service = await client.request<OutlinerServiceStatus>({ action: "ping" }, 300);
      if (service.protocolVersion === OUTLINER_PROTOCOL_VERSION) return;
    } catch {
      // Retry until the startup deadline.
    }
    await sleep(100);
  }
  throw new Error("Compatible outliner service is not available");
}

async function reload(preferredSelectedId?: string | null): Promise<void> {
  const currentSelectedId = rows[selectedIndex]?.id;
  const snapshot = await client.request<WorkspaceSnapshot>({
    action: "workspace.snapshot",
    query: { filters: parseFilter(activeFilter) },
  });
  refreshPending = false;
  rows = snapshot.blocks;
  allBlocksById = new Map(snapshot.allBlocks.map((block) => [block.id, block]));
  const selectedId =
    preferredSelectedId !== undefined
      ? preferredSelectedId
      : currentSelectedId ?? snapshot.selection.selected?.id;
  const nextIndex = selectedId ? rows.findIndex((block) => block.id === selectedId) : -1;
  selectedIndex = Math.max(0, Math.min(nextIndex >= 0 ? nextIndex : selectedIndex, rows.length - 1));
}

function enqueueWork(task: () => void | Promise<void>): void {
  workQueue = workQueue.then(task).catch((error) => {
    status = errorMessage(error);
    draw();
  });
}

function quickInputText(): string {
  return quickBuffer.lines[0] ?? "";
}

function isCanonicalDescendant(candidateId: string, ancestorId: string): boolean {
  let candidate = allBlocksById.get(candidateId);
  while (candidate?.parentId) {
    if (candidate.parentId === ancestorId) return true;
    candidate = allBlocksById.get(candidate.parentId);
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
    let marker = "•";
    if (block.hasChildren) marker = block.collapsed ? "▸" : "▾";
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

async function beginInput(nextMode: InputMode, initial = ""): Promise<void> {
  const selected = rows[selectedIndex];
  if (nextMode === "add-child" && selected?.collapsed) {
    await client.request({ action: "toggle", blockId: selected.id });
    await reload(selected.id);
  }
  mode = nextMode;
  quickBuffer = new TextBuffer(initial);
  quickBuffer.moveEnd();
  quickCompletion = null;
  draw();
}

async function commitQuickBlock(): Promise<string | null> {
  const selected = rows[selectedIndex];
  if (!selected) return null;
  const text = quickInputText();
  if (!text.trim()) return mode === "edit" ? selected.id : null;

  if (mode === "edit") {
    await client.request<Block>({
      action: "update",
      blockId: selected.id,
      text,
      expectedUpdatedAt: selected.updatedAt,
    });
    return selected.id;
  }
  if (mode === "add-child") {
    const created = await client.request<Block>({
      action: "create",
      parentId: selected.id,
      text,
      author: "user",
    });
    await client.request({ action: "move", blockId: created.id, parentId: selected.id, position: 0 });
    return created.id;
  }
  if (mode === "add-sibling") {
    const canonical = await client.request<Block>({ action: "get", blockId: selected.id });
    const created = await client.request<Block>({
      action: "create",
      parentId: canonical.parentId,
      text,
      author: "user",
    });
    await client.request({
      action: "move",
      blockId: created.id,
      parentId: canonical.parentId,
      position: canonical.position + 1,
    });
    return created.id;
  }
  return null;
}

async function selectVisibleBlock(preferredId: string | null): Promise<void> {
  await reload(preferredId);
  if (preferredId && !rows.some((row) => row.id === preferredId)) {
    activeFilter = "";
    await reload(preferredId);
    status = "Filter cleared to show saved block";
  }
  const visibleId = rows[selectedIndex]?.id ?? null;
  lastSelectionId = visibleId;
  await client.request({ action: "selection.set", blockId: visibleId });
}

async function finishInput(): Promise<void> {
  if (mode === "filter") {
    activeFilter = quickInputText().trim();
    mode = "browse";
    resetQuickEditor();
    await selectVisibleBlock(null);
    draw();
    return;
  }

  const committedBlockId = await commitQuickBlock();
  const fallbackId = rows[selectedIndex]?.id ?? null;
  mode = "browse";
  resetQuickEditor();
  await selectVisibleBlock(committedBlockId ?? fallbackId);
  draw();
}

async function handoffToDetail(): Promise<void> {
  const selected = rows[selectedIndex];
  if (!selected) return;
  const committedBlockId = await commitQuickBlock();
  if ((mode === "add-child" || mode === "add-sibling") && !committedBlockId) {
    status = "Type a title before opening multiline detail";
    draw();
    return;
  }
  const targetId = committedBlockId ?? selected.id;
  mode = "browse";
  resetQuickEditor();
  await selectVisibleBlock(targetId);
  await client.request({
    action: "ui.command.send",
    command: { target: "detail", command: "edit", blockId: targetId },
  });
  try {
    focusPluginPane(paths.stateDir, "detail");
    status = "Multiline editor opened in detail pane";
  } catch (error) {
    status = errorMessage(error);
  }
  draw();
}

async function openQuickCompletion(): Promise<void> {
  if (mode === "filter") return;
  const line = quickInputText();
  const target = completionTargetAtCursor(line, quickBuffer.column);
  if (!target) {
    status = "Type [[page, ((block, or [file::path before requesting completion";
    return;
  }

  let items: QuickCompletionState["items"];
  if (target.kind === "file") {
    items = completeReferencedPaths(target.query, paths.workspaceRoot).map((candidate) => ({
      label: candidate.sourcePath,
      insertion: `[file::${candidate.sourcePath}${candidate.isDirectory ? "" : "]"}`,
    }));
  } else {
    let blocks: VisibleBlock[] = [];
    if (target.kind === "page") {
      blocks = await client.request<VisibleBlock[]>({
        action: "list",
        query: {
          text: target.query || undefined,
          filters: [{ key: "type", value: "page" }],
          limit: 20,
        },
      });
    }
    if (blocks.length === 0) {
      blocks = await client.request<VisibleBlock[]>({
        action: "list",
        query: { text: target.query || undefined, limit: 20, includeCollapsed: true },
      });
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
    status = errorMessage(error);
  }
}

async function indent(selected: VisibleBlock): Promise<void> {
  for (let index = selectedIndex - 1; index >= 0; index--) {
    const candidate = rows[index];
    if (candidate.depth < selected.depth) break;
    if (candidate.depth === selected.depth) {
      await client.request({ action: "move", blockId: selected.id, parentId: candidate.id });
      return;
    }
  }
  status = "No previous sibling to indent beneath";
}

async function outdent(selected: VisibleBlock): Promise<void> {
  const canonical = await client.request<Block>({ action: "get", blockId: selected.id });
  if (!canonical.parentId) return;
  const parent = await client.request<Block>({ action: "get", blockId: canonical.parentId });
  await client.request({
    action: "move",
    blockId: canonical.id,
    parentId: parent.parentId,
    position: parent.position + 1,
  });
}

async function moveSibling(selected: VisibleBlock, offset: -1 | 1): Promise<string> {
  const canonical = await client.request<Block>({ action: "get", blockId: selected.id });
  const siblings = await client.request<Block[]>({ action: "children", parentId: canonical.parentId });
  const currentIndex = siblings.findIndex((sibling) => sibling.id === canonical.id);
  const targetIndex = currentIndex + offset;
  if (currentIndex < 0 || targetIndex < 0) {
    status = "Already first sibling";
  } else if (targetIndex >= siblings.length) {
    status = "Already last sibling";
  } else {
    await client.request({
      action: "move",
      blockId: canonical.id,
      parentId: canonical.parentId,
      position: targetIndex,
    });
    status = offset < 0 ? "Moved up among siblings" : "Moved down among siblings";
  }
  return canonical.id;
}

function stop(): void {
  if (stopping) return;
  stopping = true;
  watcher?.stop();
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdout.write("\x1b[?25h\x1b[?1049l");
  rmSync(paneStatePath, { force: true });
  process.exit(0);
}

async function handleServiceEvent(event: OutlinerEvent): Promise<void> {
  if (event.domain === "ui") {
    if (event.command?.target !== "tree") return;
    if (event.command.blockId) {
      activeFilter = "";
      await selectVisibleBlock(event.command.blockId);
    }
    if (event.command.command === "focus") focusPluginPane(paths.stateDir, "outliner");
    draw();
    return;
  }
  if (mode !== "browse") {
    refreshPending = true;
    return;
  }
  if (event.domain === "selection") {
    lastSelectionId = event.blockId ?? null;
    await reload(lastSelectionId);
  } else {
    await reload();
  }
  draw();
}

function startWatcher(): void {
  watcher = client.watch({
    onConnect: () =>
      enqueueWork(async () => {
        status = "";
        if (mode === "browse") await reload();
        else refreshPending = true;
        draw();
      }),
    onDisconnect: () =>
      enqueueWork(() => {
        status = "Workspace service disconnected; reconnecting…";
        draw();
      }),
    onError: (error) =>
      enqueueWork(() => {
        status = errorMessage(error);
        draw();
      }),
    onEvent: (event) => enqueueWork(() => handleServiceEvent(event)),
  });
}

async function handleKeypress(str: string, key: TerminalKey, inputAction: ReturnType<TerminalInputDecoder["consume"]>): Promise<void> {
  if (inputAction === "suppress") return;
  if (key.ctrl && key.name === "q") {
    stop();
    return;
  }
  if (key.ctrl && key.name === "c") {
    if (mode !== "browse") {
      mode = "browse";
      resetQuickEditor();
      if (refreshPending) await reload();
    } else {
      status = "Ctrl+Q closes the outliner pane";
    }
    draw();
    return;
  }
  const detailHandoffRequested = inputAction === "modified-enter" || (key.name === "e" && key.ctrl);

  if (mode === "viewer") {
    const page = Math.max(1, (process.stdout.rows ?? 30) - 4);
    const maxOffset = Math.max(0, viewerLines.length - 1);
    if (key.name === "escape" || key.name === "q") {
      mode = "browse";
      if (refreshPending) await reload();
    } else if (key.name === "up") viewerOffset = Math.max(0, viewerOffset - 1);
    else if (key.name === "down") viewerOffset = Math.min(maxOffset, viewerOffset + 1);
    else if (key.name === "pageup") viewerOffset = Math.max(0, viewerOffset - page);
    else if (key.name === "pagedown") viewerOffset = Math.min(maxOffset, viewerOffset + page);
    else if (str === "g") viewerOffset = 0;
    else if (str === "G") viewerOffset = Math.max(0, viewerLines.length - page);
    draw();
    return;
  }

  if (mode === "delete") {
    if (str.toLowerCase() === "y" && rows[selectedIndex]) {
      await client.request({ action: "delete", blockId: rows[selectedIndex].id });
    }
    mode = "browse";
    await reload();
    const visibleId = rows[selectedIndex]?.id ?? null;
    lastSelectionId = visibleId;
    await client.request({ action: "selection.set", blockId: visibleId });
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
      await handoffToDetail();
      return;
    }
    if (key.name === "escape") {
      mode = "browse";
      resetQuickEditor();
      if (refreshPending) await reload();
    } else if (key.name === "return") {
      await finishInput();
      return;
    } else if (key.name === "tab" && mode !== "filter") {
      await openQuickCompletion();
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
  let reloadRequired = false;
  if (key.name === "q") {
    status = "Outliner remains open; Ctrl+Q closes this pane";
  } else if (isDetailToggle(str, key)) {
    if (!selected) {
      status = "No block selected";
    } else {
      const result = await client.request<{ expanded: boolean }>({
        action: "view.toggleMultiline",
        blockId: selected.id,
      });
      status = result.expanded ? "Block detail expanded" : "Block detail collapsed";
      reloadRequired = true;
    }
  } else if (detailHandoffRequested) {
    await handoffToDetail();
    return;
  } else if (key.shift && key.name === "up") {
    if (selected) {
      preferredSelectedId = await moveSibling(selected, -1);
      reloadRequired = true;
    }
  } else if (key.shift && key.name === "down") {
    if (selected) {
      preferredSelectedId = await moveSibling(selected, 1);
      reloadRequired = true;
    }
  } else if (key.name === "up") selectedIndex = Math.max(0, selectedIndex - 1);
  else if (key.name === "down") selectedIndex = Math.min(rows.length - 1, selectedIndex + 1);
  else if (key.name === "left" && selected) {
    if (!selected.collapsed && selected.hasChildren) {
      await client.request({ action: "toggle", blockId: selected.id });
      reloadRequired = true;
    } else if (selected.parentId) {
      selectedIndex = Math.max(0, rows.findIndex((block) => block.id === selected.parentId));
    }
  } else if (key.name === "right" && selected) {
    if (selected.collapsed) {
      await client.request({ action: "toggle", blockId: selected.id });
      reloadRequired = true;
    } else if (selected.hasChildren) selectedIndex = Math.min(rows.length - 1, selectedIndex + 1);
  } else if (key.name === "return" && selected) {
    if (selected.text.includes("\n")) {
      await handoffToDetail();
      return;
    }
    await beginInput("edit", selected.text);
    return;
  } else if (key.name === "tab" && selected) {
    if (key.shift) await outdent(selected);
    else await indent(selected);
    preferredSelectedId = selected.id;
    reloadRequired = true;
  } else if (key.name === "space" && selected) {
    await client.request({ action: "toggle", blockId: selected.id });
    reloadRequired = true;
  } else if (str === "a" && selected) {
    await beginInput("add-child");
    return;
  } else if (str === "s" && selected) {
    await beginInput("add-sibling");
    return;
  } else if (str === "/") {
    await beginInput("filter", activeFilter);
    return;
  } else if (str === "d" && selected) mode = "delete";
  else if (str === "f" && selected) openReferencedFile(selected);
  else if (key.name === "escape" && activeFilter) {
    activeFilter = "";
    reloadRequired = true;
  }

  if (reloadRequired) await reload(preferredSelectedId);
  const visibleId = rows[selectedIndex]?.id ?? null;
  if (visibleId !== lastSelectionId) {
    lastSelectionId = visibleId;
    await client.request({ action: "selection.set", blockId: visibleId });
  }
  draw();
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("SIGHUP", stop);

process.stdin.on("keypress", (str: string, key: TerminalKey) => {
  const inputAction = inputDecoder.consume(str, key);
  enqueueWork(() => handleKeypress(str, key, inputAction));
});

process.stdout.on("resize", draw);
await waitForService();
await reload();
lastSelectionId = rows[selectedIndex]?.id ?? null;
await client.request({ action: "selection.set", blockId: lastSelectionId });
startWatcher();
draw();
