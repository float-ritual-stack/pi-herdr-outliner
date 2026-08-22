import { rmSync } from "node:fs";
import { join } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { extractFileAnnotationComment, formatFileAnnotation } from "./annotations";
import { OutlinerClient } from "./client";
import { completionTargetAtCursor, completionWindow } from "./completion";
import { completeReferencedPaths, readReferencedFile, type ReferencedFile } from "./files";
import { resolvePaths } from "./paths";
import { focusPluginPane, readDetailEditCommand, registerPaneState } from "./pane-control";
import { getProperty } from "./properties";
import { blockDisplayTitle } from "./references";
import {
  BRACKETED_PASTE_DISABLE,
  BRACKETED_PASTE_ENABLE,
  TerminalInputDecoder,
  isPrintableInput,
  renderMarkdownLine,
  truncate,
  type TerminalKey,
} from "./terminal";
import { TextBuffer } from "./text-buffer";
import type { Block, SelectionContext, VisibleBlock } from "./types";

type Mode = "preview" | "file" | "annotation" | "edit" | "comment";

interface CompletionState {
  start: number;
  end: number;
  index: number;
  items: Array<{ label: string; insertion: string }>;
}

interface LineRange {
  startLine: number;
  endLine: number;
}

const ESC = "\x1b[";
const paths = resolvePaths();
const client = new OutlinerClient(paths.socket);
const paneStatePath = join(paths.stateDir, "detail-pane.json");
registerPaneState(paths.stateDir, "detail", paths.workspaceRoot);

let context: SelectionContext = { selected: null, ancestors: [], children: [] };
let resolvedSelectedText = "";
let resolvedBreadcrumb = "";
let mode: Mode = "preview";
let buffer = new TextBuffer();
let referencedFile: ReferencedFile | null = null;
let previewOffset = 0;
let editorOffset = 0;
let fileOffset = 0;
let fileCursor = 0;
let selectionAnchor: number | null = null;
let annotationRange: LineRange | null = null;
let completion: CompletionState | null = null;
let status = "";
let stopping = false;
let polling = false;
let busy = false;
let lastDetailCommandId: string | null = null;
function insertPastedText(text: string): void {
  if (!isBufferMode()) return;
  completion = null;
  buffer.insert(text);
  draw();
}

const inputDecoder = new TerminalInputDecoder(insertPastedText);

async function waitForService(): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await client.request({ action: "ping" }, 300);
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error("Outliner service is not available");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isBufferMode(): boolean {
  return mode === "edit" || mode === "comment";
}

function helpText(): string {
  switch (mode) {
    case "edit":
      return "Enter newline  Ctrl+S save  Tab complete  Esc cancel → tree";
    case "comment":
      return "Enter newline  Ctrl+S add annotation  Esc cancel → tree";
    case "annotation":
      return "↑↓ scroll  e edit annotation  f source file  b raw block  q tree";
    case "file":
      return "↑↓ lines  v select range  c comment  b block  q tree";
    case "preview":
      return "↑↓ scroll  Enter/e edit  f file  q tree  Ctrl+Q close";
  }
}

function displayModeForBlock(block: Block | null): "preview" | "file" | "annotation" {
  if (!block) return "preview";
  if (getProperty(block.properties, "type") === "annotation") return "annotation";
  return getProperty(block.properties, "file") ? "file" : "preview";
}

function selectedFileRange(): LineRange | null {
  if (!referencedFile) return null;
  const anchor = selectionAnchor ?? fileCursor;
  return {
    startLine: referencedFile.firstLine + Math.min(anchor, fileCursor),
    endLine: referencedFile.firstLine + Math.max(anchor, fileCursor),
  };
}

function loadFile(block: Block): void {
  try {
    referencedFile = readReferencedFile(block, paths.workspaceRoot);
    fileCursor = 0;
    fileOffset = 0;
    selectionAnchor = null;
  } catch (error) {
    referencedFile = null;
    status = errorMessage(error);
  }
}

async function resolveReadText(text: string): Promise<string> {
  const result = await client.request<{ text: string }>({ action: "references.resolve", text });
  return result.text;
}

function refreshResolvedBreadcrumb(): void {
  const titles = context.ancestors.map(blockDisplayTitle);
  if (context.selected) {
    titles.push(blockDisplayTitle({ ...context.selected, text: resolvedSelectedText }));
  }
  resolvedBreadcrumb = titles.join(" › ");
}

async function loadSelection(force = false): Promise<void> {
  const next = await client.request<SelectionContext>({ action: "selection.get" });
  const changed =
    next.selected?.id !== context.selected?.id ||
    next.selected?.updatedAt !== context.selected?.updatedAt;
  context = next;
  if (!force && !changed) return;
  if (changed) status = "";

  resolvedSelectedText = next.selected ? await resolveReadText(next.selected.text) : "";
  refreshResolvedBreadcrumb();
  previewOffset = 0;
  completion = null;
  mode = displayModeForBlock(next.selected);
  if ((mode === "file" || mode === "annotation") && next.selected) loadFile(next.selected);
  else referencedFile = null;
}

function renderEditorLine(line: string, row: number, width: number): string {
  if (row !== buffer.row) return truncate(line, width);
  const horizontalOffset = Math.max(0, buffer.column - width + 1);
  const visible = line.slice(horizontalOffset, horizontalOffset + width);
  const cursor = buffer.column - horizontalOffset;
  const before = visible.slice(0, cursor);
  const after = visible.slice(cursor);
  return `${before}▏${after}`;
}

function drawCompletion(output: string[], width: number, height: number): void {
  if (!completion) return;
  const available = Math.max(1, Math.min(6, height - output.length - 1));
  const window = completionWindow(completion.items.length, completion.index, available);
  const title = `Completions ${completion.index + 1}/${completion.items.length}`;
  output.push(`\x1b[2m${truncate(title, width)}\x1b[0m`);
  for (let index = window.start; index < window.end; index++) {
    const label = truncate(completion.items[index].label, Math.max(1, width - 2));
    output.push(index === completion.index ? `\x1b[7m› ${label}\x1b[0m` : `  ${label}`);
  }
}

function buildAnnotationView(width: number): string[] {
  if (!context.selected) return [];
  const output: string[] = [];
  if (referencedFile) {
    const file = referencedFile;
    const lastLine = file.firstLine + Math.max(0, file.lines.length - 1);
    output.push(
      `\x1b[2m${truncate(`Source: ${file.sourcePath}:${file.firstLine}-${lastLine}`, width)}\x1b[0m`,
    );
    const lineNumberWidth = String(lastLine).length;
    file.lines.forEach((line, index) => {
      const lineNumber = file.firstLine + index;
      const prefix = `${String(lineNumber).padStart(lineNumberWidth)} │ `;
      output.push(`${prefix}${truncate(line, Math.max(1, width - prefix.length))}`);
    });
    output.push("─".repeat(width));
  }
  output.push("\x1b[1mComment\x1b[0m");
  const comment = extractFileAnnotationComment(resolvedSelectedText);
  for (const line of (comment || "(No comment text)").split(/\r?\n/)) {
    output.push(renderMarkdownLine(truncate(line, width)));
  }
  return output;
}

function draw(): void {
  const width = process.stdout.columns ?? 100;
  const height = process.stdout.rows ?? 30;
  const bodyHeight = Math.max(1, height - 5);
  const output: string[] = [`${ESC}H${ESC}2J`];
  output.push(`\x1b[1;36mDetail\x1b[0m  \x1b[2m${truncate(resolvedBreadcrumb || "No block selected", Math.max(1, width - 8))}\x1b[0m`);
  output.push("─".repeat(width));

  if (!context.selected) {
    output.push("Select a block in the outliner pane.");
  } else if (isBufferMode()) {
    editorOffset = Math.max(0, Math.min(editorOffset, buffer.row));
    if (buffer.row >= editorOffset + bodyHeight) editorOffset = buffer.row - bodyHeight + 1;
    const lines = buffer.lines.slice(editorOffset, editorOffset + bodyHeight);
    lines.forEach((line, index) => {
      const row = editorOffset + index;
      const prefix = `${String(row + 1).padStart(4)} `;
      output.push(`${prefix}${renderEditorLine(line, row, Math.max(1, width - prefix.length))}`);
    });
    drawCompletion(output, width, height);
  } else if (mode === "annotation") {
    for (const line of buildAnnotationView(width).slice(previewOffset, previewOffset + bodyHeight)) {
      output.push(line);
    }
  } else if (mode === "file" && referencedFile) {
    const file = referencedFile;
    const range = selectedFileRange();
    const lineNumberWidth = String(file.firstLine + file.lines.length).length;
    const visibleLines = file.lines.slice(fileOffset, fileOffset + bodyHeight);
    visibleLines.forEach((line, index) => {
      const localIndex = fileOffset + index;
      const lineNumber = file.firstLine + localIndex;
      const inRange = range && lineNumber >= range.startLine && lineNumber <= range.endLine;
      const current = localIndex === fileCursor;
      const prefix = `${current ? ">" : " "}${String(lineNumber).padStart(lineNumberWidth)} ${inRange ? "│" : " "} `;
      const rendered = renderMarkdownLine(truncate(line, Math.max(1, width - prefix.length)));
      output.push(current ? `\x1b[48;5;238m${prefix}${rendered}\x1b[0m` : `${prefix}${rendered}`);
    });
  } else {
    const lines = resolvedSelectedText.split(/\r?\n/);
    for (const line of lines.slice(previewOffset, previewOffset + bodyHeight)) {
      output.push(renderMarkdownLine(truncate(line, width)));
    }
  }

  while (output.length < height - 2) output.push("");
  output.push(truncate(status, width));
  const help = helpText();
  output.push(`\x1b[2m${truncate(help, width)}\x1b[0m`);
  process.stdout.write(output.join("\n"));
}

function beginEdit(): void {
  if (!context.selected) return;
  buffer = new TextBuffer(context.selected.text);
  buffer.row = buffer.lines.length - 1;
  buffer.moveEnd();
  editorOffset = Math.max(0, buffer.row - (process.stdout.rows ?? 30) + 7);
  completion = null;
  mode = "edit";
  status = "";
}

function focusOutliner(): void {
  try {
    focusPluginPane(paths.stateDir, "outliner");
  } catch (error) {
    status = errorMessage(error);
  }
}

async function processDetailEditCommand(): Promise<boolean> {
  const command = readDetailEditCommand(paths.stateDir);
  if (!command || command.id === lastDetailCommandId) return false;
  lastDetailCommandId = command.id;
  if (Date.now() - command.createdAt > 10_000) return false;
  await loadSelection(true);
  if (context.selected?.id !== command.blockId) return false;
  beginEdit();
  return true;
}

async function refresh(): Promise<void> {
  if (polling || isBufferMode()) return;
  polling = true;
  try {
    const openedEditor = await processDetailEditCommand();
    if (!openedEditor) await loadSelection();
    draw();
  } catch (error) {
    status = errorMessage(error);
    draw();
  } finally {
    polling = false;
  }
}

function beginComment(): void {
  const range = selectedFileRange();
  if (!range || !referencedFile) return;
  annotationRange = range;
  buffer = new TextBuffer();
  editorOffset = 0;
  completion = null;
  mode = "comment";
  status = `Commenting on ${referencedFile.sourcePath}:${range.startLine}-${range.endLine}`;
}

async function saveBuffer(): Promise<void> {
  if (!context.selected || busy) return;
  busy = true;
  try {
    if (mode === "edit") {
      const updated = await client.request<Block>({
        action: "update",
        blockId: context.selected.id,
        text: buffer.text,
        expectedUpdatedAt: context.selected.updatedAt,
      });
      context = { ...context, selected: updated };
      resolvedSelectedText = await resolveReadText(updated.text);
      refreshResolvedBreadcrumb();
      mode = displayModeForBlock(updated);
      if (mode === "file" || mode === "annotation") loadFile(updated);
      else referencedFile = null;
    } else if (mode === "comment" && referencedFile && annotationRange) {
      const text = formatFileAnnotation({
        sourceBlockId: context.selected.id,
        filePath: referencedFile.sourcePath,
        startLine: annotationRange.startLine,
        endLine: annotationRange.endLine,
        comment: buffer.text,
      });
      await client.request<Block>({ action: "create", parentId: context.selected.id, text, author: "user" });
      mode = "file";
      selectionAnchor = null;
      status = `Annotation added for lines ${annotationRange.startLine}-${annotationRange.endLine}`;
    }
  } catch (error) {
    status = errorMessage(error);
  } finally {
    busy = false;
    draw();
  }
}

async function openCompletion(): Promise<void> {
  const line = buffer.lines[buffer.row];
  const target = completionTargetAtCursor(line, buffer.column);
  if (!target) {
    status = "Type [[page, ((block, or [file::path before requesting completion";
    return;
  }

  let items: CompletionState["items"];
  if (target.kind === "file") {
    const candidates = completeReferencedPaths(target.query, paths.workspaceRoot);
    items = candidates.map((candidate) => ({
      label: candidate.sourcePath,
      insertion: `[file::${candidate.sourcePath}${candidate.isDirectory ? "" : "]"}`,
    }));
  } else {
    let blocks: VisibleBlock[] = [];
    if (target.kind === "page") {
      blocks = await client.request<VisibleBlock[]>({
        action: "list",
        query: { text: target.query || undefined, filters: [{ key: "type", value: "page" }], limit: 20 },
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
  completion = {
    start: target.start,
    end: target.end,
    index: 0,
    items,
  };

  if (completion.items.length === 0) {
    completion = null;
    status = target.kind === "file" ? "No matching files" : "No matching blocks";
  } else {
    status = "";
  }
}

function applyCompletion(): void {
  if (!completion || completion.items.length === 0) return;
  const item = completion.items[completion.index];
  buffer.replaceCurrentLine(completion.start, completion.end, item.insertion);
  completion = null;
}

function handleBufferKey(str: string, key: TerminalKey, modifiedEnter: boolean): void {
  if (completion) {
    if (key.name === "up") completion.index = Math.max(0, completion.index - 1);
    else if (key.name === "down") completion.index = Math.min(completion.items.length - 1, completion.index + 1);
    else if (key.name === "return" || key.name === "tab") applyCompletion();
    else if (key.name === "escape") completion = null;
    draw();
    return;
  }
  if (key.ctrl && key.name === "s") {
    void saveBuffer();
    return;
  }
  if ((key.name === "tab" || (key.ctrl && key.name === "space")) && mode === "edit") {
    void openCompletion()
      .catch((error) => {
        status = errorMessage(error);
      })
      .finally(draw);
    return;
  }
  if (key.name === "escape") {
    mode = displayModeForBlock(context.selected);
    status = "Edit cancelled";
    focusOutliner();
  } else if (key.name === "return" || modifiedEnter) buffer.newline();
  else if (key.name === "backspace") buffer.backspace();
  else if (key.name === "delete") buffer.deleteForward();
  else if (key.name === "left") buffer.moveLeft();
  else if (key.name === "right") buffer.moveRight();
  else if (key.name === "up") buffer.moveUp();
  else if (key.name === "down") buffer.moveDown();
  else if (key.name === "home") buffer.moveHome();
  else if (key.name === "end") buffer.moveEnd();
  else if (isPrintableInput(str, key)) buffer.insert(str);
  draw();
}

function stop(): void {
  if (stopping) return;
  stopping = true;
  clearInterval(refreshTimer);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdout.write(`${BRACKETED_PASTE_DISABLE}\x1b[?25h\x1b[?1049l`);
  rmSync(paneStatePath, { force: true });
  process.exit(0);
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("SIGHUP", stop);

emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdout.write(`\x1b[?1049h\x1b[?25l${BRACKETED_PASTE_ENABLE}`);

process.stdin.on("keypress", (str: string, key: TerminalKey) => {
  const inputAction = inputDecoder.consume(str, key);
  if (inputAction === "suppress") return;
  if (key.ctrl && key.name === "q") {
    stop();
    return;
  }
  if (key.ctrl && key.name === "c") {
    if (isBufferMode()) {
      mode = displayModeForBlock(context.selected);
      status = "Edit cancelled";
    }
    focusOutliner();
    draw();
    return;
  }
  if (isBufferMode()) {
    handleBufferKey(str, key, inputAction === "modified-enter");
    return;
  }
  if (key.name === "q") {
    focusOutliner();
    status = "Focus returned to outliner; Ctrl+Q closes detail";
    draw();
    return;
  }
  if (mode === "annotation") {
    const lines = buildAnnotationView(process.stdout.columns ?? 100);
    const page = Math.max(1, (process.stdout.rows ?? 30) - 6);
    if (key.name === "up") previewOffset = Math.max(0, previewOffset - 1);
    else if (key.name === "down") previewOffset = Math.min(Math.max(0, lines.length - 1), previewOffset + 1);
    else if (key.name === "pageup") previewOffset = Math.max(0, previewOffset - page);
    else if (key.name === "pagedown") previewOffset = Math.min(Math.max(0, lines.length - 1), previewOffset + page);
    else if (key.name === "return" || str === "e") beginEdit();
    else if (str === "f" && referencedFile) mode = "file";
    else if (str === "b") mode = "preview";
  } else if (mode === "file" && referencedFile) {
    const page = Math.max(1, (process.stdout.rows ?? 30) - 6);
    const maxCursor = Math.max(0, referencedFile.lines.length - 1);
    if (key.name === "up") fileCursor = Math.max(0, fileCursor - 1);
    else if (key.name === "down") fileCursor = Math.min(maxCursor, fileCursor + 1);
    else if (key.name === "pageup") fileCursor = Math.max(0, fileCursor - page);
    else if (key.name === "pagedown") fileCursor = Math.min(maxCursor, fileCursor + page);
    else if (str === "g") fileCursor = 0;
    else if (str === "G") fileCursor = maxCursor;
    else if (str === "v") selectionAnchor = selectionAnchor === null ? fileCursor : null;
    else if (str === "c") beginComment();
    else if (str === "b") mode = displayModeForBlock(context.selected);
    if (fileCursor < fileOffset) fileOffset = fileCursor;
    if (fileCursor >= fileOffset + page) fileOffset = fileCursor - page + 1;
  } else {
    const lines = context.selected?.text.split(/\r?\n/) ?? [];
    const page = Math.max(1, (process.stdout.rows ?? 30) - 6);
    if (key.name === "up") previewOffset = Math.max(0, previewOffset - 1);
    else if (key.name === "down") previewOffset = Math.min(Math.max(0, lines.length - 1), previewOffset + 1);
    else if (key.name === "pageup") previewOffset = Math.max(0, previewOffset - page);
    else if (key.name === "pagedown") previewOffset = Math.min(Math.max(0, lines.length - 1), previewOffset + page);
    else if (key.name === "return" || str === "e") beginEdit();
    else if (str === "f" && context.selected) {
      loadFile(context.selected);
      if (referencedFile) mode = "file";
    }
  }
  draw();
});

process.stdout.on("resize", draw);
const refreshTimer = setInterval(() => void refresh(), 250);

await waitForService();
await loadSelection(true);
await processDetailEditCommand();
draw();
