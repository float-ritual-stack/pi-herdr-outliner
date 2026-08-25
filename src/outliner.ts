import { rmSync } from "node:fs";
import { join } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { OutlinerClient, type OutlinerWatcher, type RequestInput } from "./client";
import { completeReferencedPaths, readReferencedFile } from "./files";
import { focusPluginPane, registerPaneState } from "./pane-control";
import { resolvePaths } from "./paths";
import { TerminalInputDecoder, type TerminalKey } from "./terminal";
import { createTreeController, type TreeController } from "./tree-controller";
import { renderTreeFrame } from "./tree-renderer";
import { OUTLINER_PROTOCOL_VERSION, type OutlinerServiceStatus } from "./types";

const paths = resolvePaths();
const client = new OutlinerClient(paths.socket);
const paneStatePath = join(paths.stateDir, "outliner-pane.json");
const inputDecoder = new TerminalInputDecoder();
let watcher: OutlinerWatcher | null = null;
let stopping = false;
let workQueue = Promise.resolve();
let scrollStartEntryIndex = 0;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function draw(): void {
  const result = renderTreeFrame(
    controller.view(),
    process.stdout.columns ?? 100,
    process.stdout.rows ?? 30,
    scrollStartEntryIndex,
  );
  scrollStartEntryIndex = result.scrollStartEntryIndex;
  process.stdout.write(result.frame);
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

const controller = createTreeController({
  workspaceRoot: paths.workspaceRoot,
  request<T>(input: RequestInput): Promise<T> {
    return client.request<T>(input);
  },
  filesystem: {
    completeReferencedPaths(prefix) {
      return completeReferencedPaths(prefix, paths.workspaceRoot);
    },
    readReferencedFile(block) {
      return readReferencedFile(block, paths.workspaceRoot);
    },
  },
  focusPane(pane) {
    focusPluginPane(paths.stateDir, pane);
  },
  terminalWidth() {
    return process.stdout.columns ?? 100;
  },
  terminalHeight() {
    return process.stdout.rows ?? 30;
  },
  stop,
  invalidate: draw,
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

function enqueueWork(task: () => void | Promise<void>): void {
  workQueue = workQueue.then(task).catch((error) => controller.handleError(error));
}

function startWatcher(): void {
  watcher = client.watch({
    onConnect: () => enqueueWork(() => controller.handleConnect()),
    onDisconnect: () => enqueueWork(() => controller.handleDisconnect()),
    onError: (error) => enqueueWork(() => controller.handleError(error)),
    onEvent: (event) => enqueueWork(() => controller.handleServiceEvent(event)),
  });
}

async function initialize(): Promise<void> {
  await waitForService();
  await controller.initialize();
  registerPaneState(paths.stateDir, "outliner", paths.workspaceRoot);
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
process.stdout.write("\x1b[?1049h\x1b[?25l");

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("SIGHUP", stop);

process.stdin.on("keypress", (str: string, key: TerminalKey) => {
  const inputAction = inputDecoder.consume(str, key);
  enqueueWork(() => controller.handleKeypress(str, key, inputAction));
});

process.stdout.on("resize", draw);
startWatcher();
draw();
