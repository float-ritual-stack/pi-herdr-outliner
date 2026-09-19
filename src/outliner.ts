import { emitKeypressEvents } from "node:readline";
import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { StdinBuffer } from "@earendil-works/pi-tui";
import { createOutlinerClient, type OutlinerWatcher, type RequestInput } from "./client";
import {
  startClientRuntimeSync,
  type ClientRuntimeSync,
} from "./client-runtime-sync";
import { OutlinerActionKeymap } from "./outliner-actions";
import { navigateOutlinerLink } from "./outliner-links";
import {
  configureCurrentPaneRightClick,
  currentPaneRuntime,
  focusCurrentPane,
  openDetailPane,
  openCapturePopup as openHerdrCapturePopup,
  openVirtualBranchNavigatorPopup,
  outlinerRightClickOwnership,
} from "./pane-control";
import { parsePropertySummaryKeys } from "./property-summary";
import { resolveClientPaths } from "./paths";
import { TerminalInputDecoder, type TerminalKey } from "./terminal";
import { createTreeController } from "./tree-controller";
import {
  isTreeMouseSequence,
  parseTreePrimaryClick,
  treeDisclosureAtClick,
  parseTreeWheel,
  treeLinkAtClick,
  treeClickActivates,
  treeRowAtClick,
  type TreeMouseTarget,
  parseTreeSecondaryClick,
} from "./tree-mouse";
import { renderTreeFrame } from "./tree-renderer";
import { OUTLINER_PROTOCOL_VERSION, type OutlinerServiceStatus } from "./types";

const paths = resolveClientPaths();
const client = createOutlinerClient(paths);
const clientId = crypto.randomUUID();
const browsingContextId = process.env.OUTLINER_BROWSING_CONTEXT_ID?.trim() || clientId;
const inputDecoder = new TerminalInputDecoder();
const actionKeymap = OutlinerActionKeymap.load();
const propertySummaryKeys = parsePropertySummaryKeys(
  process.env.OUTLINER_PROPERTY_SUMMARY_KEYS,
);
const rightClickOwnership = outlinerRightClickOwnership();
const mouseEnabled = process.env.HERDR_ENV === "1";
const mouseInput = mouseEnabled ? new StdinBuffer() : null;
const keyboardInput = mouseEnabled ? new PassThrough() : null;
const keypressInput = keyboardInput ?? process.stdin;
const enableMouse = "\x1b[?1000h\x1b[?1006h";
const disableMouse = "\x1b[?1006l\x1b[?1000l";
let watcher: OutlinerWatcher | null = null;
let runtimeSync: ClientRuntimeSync | null = null;
let stopping = false;
let workQueue = Promise.resolve();
let scrollStartEntryIndex = 0;
let renderedFrameLines: string[] = [];
let renderedMouseTargets: readonly (TreeMouseTarget | null | undefined)[] = [];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function draw(): void {
  const result = renderTreeFrame(
    controller.view(),
    process.stdout.columns ?? 100,
    process.stdout.rows ?? 30,
    scrollStartEntryIndex,
    { propertyKeys: propertySummaryKeys },
  );
  renderedFrameLines = result.frame.split("\n");
  renderedMouseTargets = result.mouseTargets;
  scrollStartEntryIndex = result.scrollStartEntryIndex;
  process.stdout.write(result.frame);
}

function stop(): void {
  if (stopping) return;
  if (rightClickOwnership === "outliner") {
    try {
      configureCurrentPaneRightClick("herdr");
    } catch {
      // The pane is already closing; do not mask terminal restoration.
    }
  }
  stopping = true;
  watcher?.stop();
  void runtimeSync?.stop();
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  mouseInput?.destroy();
  keyboardInput?.destroy();
  process.stdin.off("data", handleRawInput);
  process.stdout.write(`${mouseEnabled ? disableMouse : ""}\x1b[?25h\x1b[?1049l`);
  process.exit(0);
}

const controller = createTreeController({
  clientId,
  browsingContextId,
  workspaceRoot: paths.workspaceRoot,
  actionKeymap,
  request<T>(input: RequestInput): Promise<T> {
    return client.request<T>(input);
  },
  async createDetailPane(blockId, direction) {
    const detailContextId = crypto.randomUUID();
    await client.request({
      action: "browsing-context.publish",
      sourceClientId: clientId,
      contextId: detailContextId,
      target: { kind: "block", blockId },
    });
    openDetailPane({
      workspaceRoot: paths.workspaceRoot,
      browsingContextId: detailContextId,
      direction,
    });
  },
  async openCapturePopup(capturedFromBlockId) {
    openHerdrCapturePopup({
      workspaceRoot: paths.workspaceRoot,
      capturedFromBlockId,
    });
  },
  openVirtualBranchNavigator(viewId, adapter) {
    openVirtualBranchNavigatorPopup({
      workspaceRoot: paths.workspaceRoot,
      browsingContextId,
      sourceClientId: clientId,
      sourceRole: "tree",
      viewId,
      ...(adapter ? { adapter } : {}),
    });
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
  const deadline = Date.now() + (paths.mode === "remote" ? 30_000 : 5_000);
  while (Date.now() < deadline) {
    try {
      const service = await client.request<OutlinerServiceStatus>(
        { action: "ping" },
        paths.mode === "remote" ? 3_000 : 300,
      );
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
  const secondaryClick = parseTreeSecondaryClick(sequence);
  if (secondaryClick && rightClickOwnership === "outliner") {
    enqueueWork(() => controller.handleAction("tree.menu.open", secondaryClick));
    return;
  }
  const wheelDirection = parseTreeWheel(sequence);
  if (wheelDirection) {
    enqueueWork(() =>
      controller.handleKeypress("", { name: wheelDirection, sequence }, "pass")
    );
    return;
  }
  const primaryClick = parseTreePrimaryClick(sequence);
  if (!primaryClick) return;
  const activate = treeClickActivates(primaryClick);
  if (primaryClick.shift && !activate) return;

  const disclosureRowId = treeDisclosureAtClick(renderedMouseTargets, sequence);
  if (disclosureRowId) {
    enqueueWork(() => controller.handleDisclosure(disclosureRowId));
    return;
  }

  const rowId = treeRowAtClick(renderedMouseTargets, sequence);
  const link = treeLinkAtClick(renderedFrameLines, sequence);
  if (link?.startsWith("pi-outliner-action:")) {
    enqueueWork(() => controller.handleAction(link.slice("pi-outliner-action:".length)));
    return;
  }
  if (!activate && rowId) {
    enqueueWork(() => controller.handleRowClick(rowId));
    return;
  }
  if (link) {
    enqueueWork(async () => {
      if (rowId) await controller.handleRowClick(rowId);
      await navigateOutlinerLink(client, link, { sourceClientId: clientId, intent: "open" });
    });
    return;
  }
  if (activate && rowId) {
    enqueueWork(() => controller.handleRowClick(rowId, true));
  }
}

mouseInput?.on("data", (sequence) => {
  if (isTreeMouseSequence(sequence)) handleMouseSequence(sequence);
  else keyboardInput?.write(sequence);
});
mouseInput?.on("paste", (text) => enqueueWork(() => controller.handlePaste(text)));

function startWatcher(): void {
  let runtime: ReturnType<typeof currentPaneRuntime>;
  try {
    runtime = currentPaneRuntime();
  } catch (error) {
    console.error(errorMessage(error));
  }
  runtimeSync = paths.mode === "remote"
    ? startClientRuntimeSync({
      client,
      clientId,
      initialRuntime: runtime,
      herdrSocketPath: process.env.HERDR_SOCKET_PATH,
      onError: (error) => enqueueWork(() => controller.handleError(error)),
    })
    : null;
  watcher = client.watch({
    client: {
      clientId,
      role: "tree",
      contextId: browsingContextId,
      runtime,
    },
    onConnect: async () => {
      await runtimeSync?.synchronize();
      enqueueWork(() => controller.handleConnect());
    },
    onDisconnect: () => {
      runtimeSync?.suspend();
      enqueueWork(() => controller.handleDisconnect());
    },
    onError: (error) => enqueueWork(() => controller.handleError(error)),
    onEvent: (event) => enqueueWork(() => controller.handleServiceEvent(event)),
  });
}
  configureCurrentPaneRightClick(rightClickOwnership);

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

emitKeypressEvents(keypressInput);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdout.write(`\x1b[?1049h\x1b[?25l${mouseEnabled ? enableMouse : ""}`);
if (mouseInput) process.stdin.on("data", handleRawInput);

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("SIGHUP", stop);

keypressInput.on("keypress", (str: string | undefined, key: TerminalKey) => {
  const text = str ?? "";
  const sequence = key.sequence ?? text;
  if (!sequence && !key.name) return;
  if (isTreeMouseSequence(sequence)) return;
  const inputAction = inputDecoder.consume(text, key);
  enqueueWork(() => controller.handleKeypress(text, key, inputAction));
});

process.stdout.on("resize", draw);
startWatcher();
draw();
