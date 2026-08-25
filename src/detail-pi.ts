import { rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager,
  ProcessTerminal,
  setKeybindings,
  TUI_KEYBINDINGS,
  TuiAltScreen,
} from "@earendil-works/pi-tui";
import { OutlinerClient, type OutlinerWatcher } from "./client";
import {
  createDetailController,
  type DetailEffects,
  type DetailViewport,
} from "./detail-controller";
import { createDetailKeyHandler } from "./detail-keymap";
import { createPiDetailInputListener, decodePiDetailInput } from "./detail-pi-input";
import { DetailPiPreviewLayout } from "./detail-pi-preview";
import { DetailPiComponent } from "./detail-pi-renderer";
import { completeReferencedPaths, readReferencedFile } from "./files";
import { focusPluginPane, registerPaneState } from "./pane-control";
import { resolvePaths } from "./paths";
import {
  OUTLINER_PROTOCOL_VERSION,
  type Block,
  type OutlinerServiceStatus,
  type SelectionContext,
  type VisibleBlockCollection,
} from "./types";

initTheme(undefined, false);
setKeybindings(
  new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.altScreen.pageUp": [],
    "tui.altScreen.pageDown": [],
    "tui.altScreen.top": [],
    "tui.altScreen.bottom": [],
  }),
);

const paths = resolvePaths();
const client = new OutlinerClient(paths.socket);
const paneStatePath = join(paths.stateDir, "detail-pane.json");
const terminal = new ProcessTerminal();
const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true });
let stopping = false;
let watcher: OutlinerWatcher | null = null;
let workQueue = Promise.resolve();

function viewport(): DetailViewport {
  return {
    width: terminal.columns,
    height: terminal.rows,
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
  async queryBlocks(query) {
    return client.request<VisibleBlockCollection>({ action: "blocks.query", query });
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

let synchronizeLayout: (() => void) | undefined;
const controller = createDetailController(effects, () => {
  if (synchronizeLayout) synchronizeLayout();
  else tui.requestRender();
});

function enqueueWork(task: () => void | Promise<void>): void {
  workQueue = workQueue.then(task).catch((error) => {
    controller.onServiceError(error);
  });
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

function startWatcher(): void {
  watcher = client.watch({
    onConnect: () => enqueueWork(() => controller.onServiceConnect(viewport())),
    onDisconnect: () => enqueueWork(() => controller.onServiceDisconnect()),
    onError: (error) => enqueueWork(() => controller.onServiceError(error)),
    onEvent: (event) => enqueueWork(() => controller.onServiceEvent(event, viewport())),
  });
}

async function stop(exitCode = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  watcher?.stop();
  process.stdout.off("resize", handleResize);
  try {
    await terminal.drainInput(100, 20);
  } catch {
    // Best effort during terminal shutdown.
  }
  tui.stop({ preserveScreen: true });
  rmSync(paneStatePath, { force: true });
  process.exit(exitCode);
}

const handleKeypress = createDetailKeyHandler({
  controller,
  viewport,
  stop: () => void stop(),
});

async function handleInput(data: string): Promise<void> {
  if (preview.handleInput(data)) {
    tui.requestRender();
    return;
  }

  const input = decodePiDetailInput(data);
  if (input.kind === "paste") {
    if (controller.isBufferMode()) {
      await controller.dispatch({ type: "buffer.insert", text: input.text }, viewport());
    }
    return;
  }
  await handleKeypress(input.str, input.key, input.inputAction);
}

const customFrame = new DetailPiComponent({
  state: controller.state,
  height: () => terminal.rows,
});
const preview = new DetailPiPreviewLayout(controller.state, getMarkdownTheme());
let layoutRoot: DetailPiComponent | DetailPiPreviewLayout | undefined;

synchronizeLayout = () => {
  const previewActive = controller.state.mode === "preview";
  preview.setActive(previewActive);
  if (previewActive) preview.syncState();
  const nextRoot = previewActive ? preview : customFrame;
  if (nextRoot !== layoutRoot) {
    layoutRoot = nextRoot;
    tui.setLayoutRoot(nextRoot);
  }
  tui.requestRender();
};
synchronizeLayout();

tui.addInputListener(
  createPiDetailInputListener(
    (data) => {
      if (!stopping) enqueueWork(() => handleInput(data));
    },
    () => tui.hasOverlay(),
  ),
);

function handleResize(): void {
  enqueueWork(() => controller.dispatch({ type: "viewport.changed" }, viewport()));
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

process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
process.on("SIGHUP", () => void stop());
process.stdout.on("resize", handleResize);

tui.start();
startWatcher();
