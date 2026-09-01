import { emitKeypressEvents } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { OutlinerClient, type OutlinerWatcher } from "./client";
import { OutlinerActionKeymap } from "./outliner-actions";
import { sendContextClientCommand } from "./client-target";
import {
  createDetailController,
  type DetailEffects,
  type DetailViewport,
} from "./detail-controller";
import { projectDetailRead } from "./detail-embeds";
import { createDetailKeyHandler } from "./detail-keymap";
import { renderDetailAnsi } from "./detail-renderer";
import { completeReferencedPaths, readReferencedFile } from "./files";
import { resolveOutlinerLinkTarget } from "./outliner-links";
import {
  dispatchNavigation,
  resolveNavigationDestination,
} from "./navigation-routes";
import { currentPaneRuntime, focusCurrentPane, openDetailPane } from "./pane-control";
import { resolvePaths } from "./paths";
import {
  BRACKETED_PASTE_DISABLE,
  BRACKETED_PASTE_ENABLE,
  TerminalInputDecoder,
  type TerminalKey,
} from "./terminal";
import {
  OUTLINER_PROTOCOL_VERSION,
  type BacklinkCollection,
  type Block,
  type BrowsingContextState,
  type PageAddressCollection,
  type OutlinerServiceStatus,
  type ResolvedBlockReferences,
  type SelectionContext,
  type VisibleBlockCollection,
} from "./types";

const paths = resolvePaths();
const client = new OutlinerClient(paths.socket);
const clientId = crypto.randomUUID();
const browsingContextId = process.env.OUTLINER_BROWSING_CONTEXT_ID?.trim() || clientId;
const actionKeymap = OutlinerActionKeymap.load();
const detailPresentation = process.env.OUTLINER_DETAIL_PRESENTATION?.trim() || "block";
if (detailPresentation !== "block" && detailPresentation !== "property-inspector") {
  throw new Error(`Unsupported Detail presentation: ${detailPresentation}`);
}
const dedicatedPropertyBlockId =
  process.env.OUTLINER_DETAIL_TARGET_BLOCK_ID?.trim() || null;
if (detailPresentation === "property-inspector" && !dedicatedPropertyBlockId) {
  throw new Error("Dedicated property inspector requires a target block ID");
}
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
  browsingContextId,
  focusSelf() {
    if (process.env.HERDR_ENV === "1") focusCurrentPane();
  },
  async getBrowsingContext() {
    const browsingContext = await client.request<BrowsingContextState>({
      action: "browsing-context.get",
      contextId: browsingContextId,
    });
    if (!dedicatedPropertyBlockId) return browsingContext;
    return {
      ...browsingContext,
      target: await client.request<SelectionContext>({
        action: "blocks.context",
        blockId: dedicatedPropertyBlockId,
      }),
    };
  },
  async getBlockContext(blockId) {
    return client.request<SelectionContext>({ action: "blocks.context", blockId });
  },
  async setLocked(locked) {
    await client.request({ action: "clients.update", clientId, locked });
  },
  async setCurrentBlock(currentBlockId) {
    await client.request({ action: "clients.update", clientId, currentBlockId });
  },
  dispatchNavigation(blockId, intent, options) {
    return dispatchNavigation(client, clientId, blockId, intent, options);
  },
  resolveNavigation(intent, options) {
    return resolveNavigationDestination(client, clientId, intent, options);
  },
  async resolveReferences(text) {
    return client.request<ResolvedBlockReferences>({ action: "references.resolve", text });
  },
  projectRead(text, hostBlockId) {
    return projectDetailRead(client, text, { hostBlockId });
  },
  async queryBacklinks(query) {
    return client.request<BacklinkCollection>({ action: "references.backlinks", query });
  },
  async updateBlock(input) {
    return client.request<Block>({
      action: "update",
      ...input,
      mutation: { author: "user", actorId: "detail" },
    });
  },
  async patchProperties(input) {
    return client.request<Block>({
      action: "properties.patch",
      ...input,
      mutation: { author: "user", actorId: "detail" },
    });
  },
  async restoreBlock(blockId) {
    return client.request<Block>({ action: "trash.restore", blockId });
  },
  async resolveReference(target) {
    return resolveOutlinerLinkTarget(client, target);
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
    await sendContextClientCommand(client, "tree", browsingContextId, { command: "focus" });
  },
  openPropertyInspectorPane(blockId) {
    return openDetailPane({
      workspaceRoot: paths.workspaceRoot,
      browsingContextId,
      propertyInspectorBlockId: blockId,
    });
  },
};

function draw(): void {
  process.stdout.write(renderDetailAnsi(controller.state, viewport(), {
    helpText: actionKeymap.helpText("detail", controller.state.mode),
  }));
}

const controller = createDetailController(
  effects,
  draw,
  {
    propertyInspectorPresentation: detailPresentation === "property-inspector"
      ? "dedicated"
      : "inline",
  },
);

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
      contextId: browsingContextId,
      locked: detailPresentation === "property-inspector",
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

const handleKeypress = createDetailKeyHandler({ controller, viewport, stop, actionKeymap });

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
