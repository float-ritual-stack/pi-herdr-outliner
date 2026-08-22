import { rmSync } from "node:fs";
import { join } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { OutlinerClient, type OutlinerWatcher } from "./client";
import {
  createDetailController,
  type DetailEffects,
  type DetailIntent,
  type DetailViewport,
} from "./detail-controller";
import { renderDetailAnsi } from "./detail-renderer";
import { completeReferencedPaths, readReferencedFile } from "./files";
import { focusPluginPane, registerPaneState } from "./pane-control";
import { resolvePaths } from "./paths";
import {
  BRACKETED_PASTE_DISABLE,
  BRACKETED_PASTE_ENABLE,
  TerminalInputDecoder,
  isPrintableInput,
  type TerminalKey,
} from "./terminal";
import {
  OUTLINER_PROTOCOL_VERSION,
  type Block,
  type OutlinerServiceStatus,
  type SelectionContext,
  type VisibleBlock,
} from "./types";

const paths = resolvePaths();
const client = new OutlinerClient(paths.socket);
const paneStatePath = join(paths.stateDir, "detail-pane.json");
let stopping = false;
let watcher: OutlinerWatcher | null = null;
let workQueue = Promise.resolve();
let pendingPaste: string | null = null;

function viewport(): DetailViewport {
  return {
    width: process.stdout.columns ?? 100,
    height: process.stdout.rows ?? 30,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const effects: DetailEffects = {
  async getSelection() {
    return client.request<SelectionContext>({ action: "selection.get" });
  },
  async setSelection(blockId) {
    await client.request({ action: "selection.set", blockId });
  },
  async resolveReferences(text) {
    const result = await client.request<{ text: string }>({ action: "references.resolve", text });
    return result.text;
  },
  async updateBlock(input) {
    return client.request<Block>({ action: "update", ...input });
  },
  async createBlock(input) {
    return client.request<Block>({ action: "create", ...input });
  },
  async listBlocks(query) {
    return client.request<VisibleBlock[]>({ action: "list", query });
  },
  readFile(block) {
    return readReferencedFile(block, paths.workspaceRoot);
  },
  completeFiles(query) {
    return completeReferencedPaths(query, paths.workspaceRoot);
  },
  focusOutliner() {
    focusPluginPane(paths.stateDir, "outliner");
  },
};

function draw(): void {
  process.stdout.write(renderDetailAnsi(controller.state, viewport()));
}

const controller = createDetailController(effects, draw);

function enqueueWork(task: () => void | Promise<void>): void {
  workQueue = workQueue.then(task).catch((error) => {
    controller.onServiceError(error);
  });
}

async function refreshPendingSelection(): Promise<void> {
  if (controller.state.refreshPending) await controller.refreshPendingSelection();
}

const inputDecoder = new TerminalInputDecoder((text) => {
  pendingPaste = text;
});

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

function startWatcher(): void {
  watcher = client.watch({
    onConnect: () => enqueueWork(() => controller.onServiceConnect(viewport())),
    onDisconnect: () => enqueueWork(() => controller.onServiceDisconnect()),
    onError: (error) => enqueueWork(() => controller.onServiceError(error)),
    onEvent: (event) => enqueueWork(() => controller.onServiceEvent(event, viewport())),
  });
}

function stop(): void {
  if (stopping) return;
  stopping = true;
  watcher?.stop();
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdout.write(`${BRACKETED_PASTE_DISABLE}\x1b[?25h\x1b[?1049l`);
  rmSync(paneStatePath, { force: true });
  process.exit(0);
}

async function dispatch(intent: DetailIntent): Promise<void> {
  await controller.dispatch(intent, viewport());
}

async function cancelBuffer(): Promise<void> {
  await dispatch({ type: "buffer.cancel" });
  await refreshPendingSelection();
}

async function handleCompletionKey(key: TerminalKey): Promise<void> {
  if (key.name === "up") await dispatch({ type: "completion.move", delta: -1 });
  else if (key.name === "down") await dispatch({ type: "completion.move", delta: 1 });
  else if (key.name === "return" || key.name === "tab") await dispatch({ type: "completion.accept" });
  else if (key.name === "escape") await dispatch({ type: "completion.dismiss" });
  else await dispatch({ type: "redraw" });
}

async function handleBufferKey(str: string, key: TerminalKey, modifiedEnter: boolean): Promise<void> {
  if (controller.state.completion) {
    await handleCompletionKey(key);
    return;
  }
  if (key.ctrl && key.name === "s") {
    await dispatch({ type: "buffer.save" });
    return;
  }
  if (
    (key.name === "tab" || (key.ctrl && key.name === "space")) &&
    controller.state.mode === "edit"
  ) {
    await dispatch({ type: "completion.open" });
    return;
  }
  if (key.name === "escape") {
    await cancelBuffer();
    return;
  }
  if (key.name === "return" || modifiedEnter) await dispatch({ type: "buffer.newline" });
  else if (key.name === "backspace") await dispatch({ type: "buffer.backspace" });
  else if (key.name === "delete") await dispatch({ type: "buffer.delete" });
  else if (
    key.name === "left" ||
    key.name === "right" ||
    key.name === "up" ||
    key.name === "down" ||
    key.name === "home" ||
    key.name === "end"
  ) {
    await dispatch({ type: "buffer.move", direction: key.name });
  } else if (isPrintableInput(str, key)) await dispatch({ type: "buffer.insert", text: str });
  else await dispatch({ type: "redraw" });
}

async function handlePreviewKey(str: string, key: TerminalKey): Promise<void> {
  if (
    key.name === "up" ||
    key.name === "down" ||
    key.name === "pageup" ||
    key.name === "pagedown"
  ) {
    await dispatch({ type: "preview.navigate", direction: key.name });
  } else if (key.name === "return" || str === "e") await dispatch({ type: "edit.begin" });
  else if (str === "f") await dispatch({ type: "view.file" });
  else if (str === "b" && controller.state.mode === "annotation") await dispatch({ type: "view.block" });
  else await dispatch({ type: "redraw" });
}

async function handleFileKey(str: string, key: TerminalKey): Promise<void> {
  if (
    key.name === "up" ||
    key.name === "down" ||
    key.name === "pageup" ||
    key.name === "pagedown"
  ) {
    await dispatch({ type: "file.navigate", direction: key.name });
  } else if (str === "g") await dispatch({ type: "file.navigate", direction: "home" });
  else if (str === "G") await dispatch({ type: "file.navigate", direction: "end" });
  else if (str === "v") await dispatch({ type: "file.selection.toggle" });
  else if (str === "c") await dispatch({ type: "comment.begin" });
  else if (str === "b") await dispatch({ type: "view.block" });
  else await dispatch({ type: "redraw" });
}

async function initialize(): Promise<void> {
  await waitForService();
  await controller.initialize();
  registerPaneState(paths.stateDir, "detail", paths.workspaceRoot);
}

try {
  await initialize();
} catch (error) {
  rmSync(paneStatePath, { force: true });
  console.error(errorMessage(error));
  process.exit(1);
}

emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdout.write(`\x1b[?1049h\x1b[?25l${BRACKETED_PASTE_ENABLE}`);

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("SIGHUP", stop);

async function handleKeypress(str: string, key: TerminalKey): Promise<void> {
  const inputAction = inputDecoder.consume(str, key);
  if (pendingPaste !== null) {
    const text = pendingPaste;
    pendingPaste = null;
    if (controller.isBufferMode()) await dispatch({ type: "buffer.insert", text });
  }
  if (inputAction === "suppress") return;
  if (key.ctrl && key.name === "q") {
    stop();
    return;
  }
  if (key.ctrl && key.name === "c") {
    if (controller.isBufferMode()) await cancelBuffer();
    else await dispatch({ type: "focus.outliner" });
    return;
  }
  if (controller.isBufferMode()) {
    await handleBufferKey(str, key, inputAction === "modified-enter");
    return;
  }
  if (key.name === "q") {
    await dispatch({ type: "focus.outliner", announce: true });
    return;
  }
  if (controller.state.mode === "file" && controller.state.referencedFile) {
    await handleFileKey(str, key);
  } else {
    await handlePreviewKey(str, key);
  }
}

process.stdin.on("keypress", (str: string, key: TerminalKey) => {
  enqueueWork(() => handleKeypress(str, key));
});

process.stdout.on("resize", () => enqueueWork(() => dispatch({ type: "viewport.changed" })));
startWatcher();
draw();
