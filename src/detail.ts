import { emitKeypressEvents } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { OutlinerClient, type OutlinerWatcher } from "./client";
import { sendUniqueClientCommand } from "./client-target";
import {
  createDetailController,
  type DetailEffects,
  type DetailViewport,
} from "./detail-controller";
import { createDetailKeyHandler } from "./detail-keymap";
import { renderDetailAnsi } from "./detail-renderer";
import { completeReferencedPaths, readReferencedFile } from "./files";
import { navigateOutlinerLink, outlinerLinkUri } from "./outliner-links";
import { currentPaneRuntime, focusCurrentPane } from "./pane-control";
import { resolvePaths } from "./paths";
import {
  BRACKETED_PASTE_DISABLE,
  BRACKETED_PASTE_ENABLE,
  TerminalInputDecoder,
  type TerminalKey,
} from "./terminal";
import {
  OUTLINER_PROTOCOL_VERSION,
  type Block,
  type NavigationState,
  type PageAddressCollection,
  type OutlinerServiceStatus,
  type ResolvedBlockReferences,
  type SelectionContext,
  type VisibleBlockCollection,
} from "./types";

const paths = resolvePaths();
const client = new OutlinerClient(paths.socket);
const clientId = crypto.randomUUID();
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
  clientId,
  focusSelf() {
    focusCurrentPane();
  },
  async getSelection() {
    return client.request<SelectionContext>({ action: "selection.get" });
  },
  async setSelection(blockId) {
    await client.request({ action: "selection.set", blockId });
  },
  async resolveReferences(text) {
    return client.request<ResolvedBlockReferences>({ action: "references.resolve", text });
  },
  async updateBlock(input) {
    return client.request<Block>({ action: "update", ...input });
  },
  async restoreBlock(blockId) {
    return client.request<Block>({ action: "trash.restore", blockId });
  },
  async navigateHistory(direction) {
    const action = direction === "back" ? "navigation.back" : "navigation.forward";
    return client.request<NavigationState>({ action });
  },
  async followReference(target) {
    await navigateOutlinerLink(client, outlinerLinkUri(target.kind, target.value), {
      detailClientId: clientId,
    });
  },
  async createBlock(input) {
    return client.request<Block>({ action: "create", ...input });
  },
  async queryBlocks(query) {
    return client.request<VisibleBlockCollection>({ action: "blocks.query", query });
  },
  async queryPageAddresses(query, limit) {
    return client.request<PageAddressCollection>({ action: "pages.complete", query, limit });
  },
  readFile(block) {
    return readReferencedFile(block, paths.workspaceRoot);
  },
  completeFiles(query) {
    return completeReferencedPaths(query, paths.workspaceRoot);
  },
  async focusOutliner() {
    await sendUniqueClientCommand(client, "tree", { command: "focus" });
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
    client: {
      clientId,
      role: "detail",
      runtime: currentPaneRuntime(),
    },
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
  process.exit(0);
}

const handleKeypress = createDetailKeyHandler({ controller, viewport, stop });

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
process.stdout.write(`\x1b[?1049h\x1b[?25l${BRACKETED_PASTE_ENABLE}`);

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("SIGHUP", stop);

async function handleInput(str: string, key: TerminalKey): Promise<void> {
  const inputAction = inputDecoder.consume(str, key);
  if (pendingPaste !== null) {
    const text = pendingPaste;
    pendingPaste = null;
    if (controller.isBufferMode()) {
      await controller.dispatch({ type: "buffer.insert", text }, viewport());
    }
  }
  await handleKeypress(str, key, inputAction);
}

process.stdin.on("keypress", (str: string, key: TerminalKey) => {
  enqueueWork(() => handleInput(str, key));
});

process.stdout.on("resize", () => {
  enqueueWork(() => controller.dispatch({ type: "viewport.changed" }, viewport()));
});
startWatcher();
draw();
