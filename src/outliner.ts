import { emitKeypressEvents } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { StdinBuffer } from "@earendil-works/pi-tui";
import { OutlinerClient, type OutlinerWatcher, type RequestInput } from "./client";
import { completeReferencedPaths, readReferencedFile } from "./files";
import { navigateOutlinerLink } from "./outliner-links";
import { currentPaneRuntime, focusCurrentPane } from "./pane-control";
import { resolvePaths } from "./paths";
import { TerminalInputDecoder, type TerminalKey } from "./terminal";
import { listOpenRouteDestinations } from "./navigation-routes";
import { createTreeController, type TreeController } from "./tree-controller";
import {
  isTreeMouseSequence,
  parseTreeWheel,
  treeLinkAtClick,
} from "./tree-mouse";
import { renderTreeFrame } from "./tree-renderer";
import { OUTLINER_PROTOCOL_VERSION, type OutlinerServiceStatus } from "./types";

const paths = resolvePaths();
const client = new OutlinerClient(paths.socket);
const clientId = crypto.randomUUID();
const browsingContextId = process.env.OUTLINER_BROWSING_CONTEXT_ID?.trim() || clientId;
const inputDecoder = new TerminalInputDecoder();
const mouseEnabled = process.env.HERDR_ENV === "1";
const mouseInput = mouseEnabled ? new StdinBuffer() : null;
const enableMouse = "\x1b[?1000h\x1b[?1006h";
const disableMouse = "\x1b[?1006l\x1b[?1000l";
let watcher: OutlinerWatcher | null = null;
let stopping = false;
let workQueue = Promise.resolve();
let scrollStartEntryIndex = 0;
let renderedFrameLines: string[] = [];

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
  renderedFrameLines = result.frame.split("\n");
  scrollStartEntryIndex = result.scrollStartEntryIndex;
  process.stdout.write(result.frame);
}

function stop(): void {
  if (stopping) return;
  stopping = true;
  watcher?.stop();
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  mouseInput?.destroy();
  process.stdin.off("data", handleRawInput);
  process.stdout.write(`${mouseEnabled ? disableMouse : ""}\x1b[?25h\x1b[?1049l`);
  process.exit(0);
}

const controller = createTreeController({
  clientId,
  browsingContextId,
  workspaceRoot: paths.workspaceRoot,
  request<T>(input: RequestInput): Promise<T> {
    return client.request<T>(input);
  },
  listOpenRouteDestinations() {
    return listOpenRouteDestinations(client, clientId);
  },
  filesystem: {
    completeReferencedPaths(prefix) {
      return completeReferencedPaths(prefix, paths.workspaceRoot);
    },
    readReferencedFile(block) {
      return readReferencedFile(block, paths.workspaceRoot);
    },
  },
  focusSelf() {
    if (process.env.HERDR_ENV === "1") focusCurrentPane();
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

function handleRawInput(data: string | Buffer): void {
  mouseInput?.process(data);
}

function handleMouseSequence(sequence: string): void {
  const wheelDirection = parseTreeWheel(sequence);
  if (wheelDirection) {
    enqueueWork(() =>
      controller.handleKeypress("", { name: wheelDirection, sequence }, "pass")
    );
    return;
  }

  const link = treeLinkAtClick(renderedFrameLines, sequence);
  if (!link) return;
  enqueueWork(async () => {
    await navigateOutlinerLink(client, link, { sourceClientId: clientId, intent: "open" });
  });
}

mouseInput?.on("data", handleMouseSequence);

function startWatcher(): void {
  watcher = client.watch({
    client: {
      clientId,
      role: "tree",
      contextId: browsingContextId,
      runtime: currentPaneRuntime(),
    },
    onConnect: () => enqueueWork(() => controller.handleConnect()),
    onDisconnect: () => enqueueWork(() => controller.handleDisconnect()),
    onError: (error) => enqueueWork(() => controller.handleError(error)),
    onEvent: (event) => enqueueWork(() => controller.handleServiceEvent(event)),
  });
}

async function initialize(): Promise<void> {
  await waitForService();
  await controller.initialize();
}

try {
  await initialize();
} catch (error) {
  console.error(errorMessage(error));
  process.exit(1);
}

emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdout.write(`\x1b[?1049h\x1b[?25l${mouseEnabled ? enableMouse : ""}`);
if (mouseInput) process.stdin.on("data", handleRawInput);

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("SIGHUP", stop);

process.stdin.on("keypress", (str: string, key: TerminalKey) => {
  if (isTreeMouseSequence(key.sequence ?? str)) return;
  const inputAction = inputDecoder.consume(str, key);
  enqueueWork(() => controller.handleKeypress(str, key, inputAction));
});

process.stdout.on("resize", draw);
startWatcher();
draw();
