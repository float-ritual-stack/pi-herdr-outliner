import {PaneDisplay} from "./pane-display";
import {ViewPreferences} from "./view-preferences";
import {focusActiveCapture} from "./capture-owner";
import {TextViewerInput} from './text-viewer-input';
import {openExternalUrl} from "./open-external";
import {DocumentPreviewInput} from './document-preview-input';
import {KeyInspector} from "./key-inspector";
import {createDetailDestination} from "./detail-pane-placement";
import {osc52ClipboardWrite} from './terminal';
import { initTheme } from "@earendil-works/pi-coding-agent";
import { serviceTreeNavigation } from "./navigation-routes";
import { emitKeypressEvents } from "node:readline";
import { PassThrough } from "node:stream";
import { StdinBuffer } from "@earendil-works/pi-tui";
import { createOutlinerClient, type OutlinerWatcher, type RequestInput } from "./client";
import {
  startClientRuntimeSync,
  type ClientRuntimeSync,
} from "./client-runtime-sync";
import { OutlinerActionKeymap } from "./outliner-actions";
import { reportCurrentPaneWorkspace,
  configureCurrentPaneRightClick,
  currentPaneRuntime,
  focusCurrentPane,
  openDetailPane,
  openTreePane,
  openGotoPopup,
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
import { waitForCompatibleService } from "./service-compatibility";

initTheme(undefined, false);
const paths = resolveClientPaths();
const viewPreferences = new ViewPreferences();
const paneDisplay = new PaneDisplay(draw);
reportCurrentPaneWorkspace(paths.workspaceRoot);
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
const keyboardInput = new PassThrough();
const keypressInput = keyboardInput;
const keyInspector = new KeyInspector({actionKeymap,invalidate:draw});
const enableMouse = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
const disableMouse = "\x1b[?1006l\x1b[?1002l\x1b[?1000l";
let watcher: OutlinerWatcher | null = null;
let runtimeSync: ClientRuntimeSync | null = null;
let stopping = false;
let workQueue = Promise.resolve();
let renderedFrameLines: string[] = [];
const previewInput = new DocumentPreviewInput();
const viewerInput = new TextViewerInput();
let renderedMouseTargets: readonly (TreeMouseTarget | null | undefined)[] = [];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function draw(): void {
  paneDisplay.update(controller.view().root?.label ?? "Outliner");
  if(keyInspector.active) {
    process.stdout.write(`\x1b[H\x1b[2J${keyInspector.render(process.stdout.columns ?? 100,process.stdout.rows ?? 30).join("\n")}`);
    return;
  }
  const result = renderTreeFrame(
    controller.view(),
    process.stdout.columns ?? 100,
    process.stdout.rows ?? 30,
    controller.view().scrollStartEntryIndex ?? 0,
    { propertyKeys: propertySummaryKeys, titleInFrame: paneDisplay.inFrame },
  );
  renderedFrameLines = previewInput.render(result.frame.split("\n"),result.preview,controller.view().mode === "inbox" ? controller.view().inbox?.reader.state : controller.view().localPreview);
  renderedFrameLines=viewerInput.render(renderedFrameLines,result.viewer);
  renderedMouseTargets = result.mouseTargets;
  controller.setViewportStart(result.scrollStartEntryIndex, result.expandedPage);
  if(result.breadcrumbStart !== undefined) controller.setBreadcrumbStart(result.breadcrumbStart);
  process.stdout.write(renderedFrameLines.join("\n"));
}

async function stop(): Promise<void> {
  if (stopping) return;
  if (rightClickOwnership === "outliner") {
    try {
      configureCurrentPaneRightClick("herdr");
    } catch {
      // The pane is already closing; do not mask terminal restoration.
    }
  }
  stopping = true;
  await paneDisplay.stop();
  keyInspector.dispose();
  watcher?.stop();
  void runtimeSync?.stop();
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  mouseInput?.destroy();
  keyboardInput?.destroy();
  process.stdin.off("data", handleRawInput);
  process.stdout.write(`${mouseEnabled ? disableMouse : ""}\x1b[?25h\x1b[?1049l`);
  process.exit(0);
}

const initialRoot = process.env.OUTLINER_TREE_ROOT ? JSON.parse(decodeURIComponent(process.env.OUTLINER_TREE_ROOT)) : undefined;
if(initialRoot && ![initialRoot.rowId,initialRoot.canonicalId,initialRoot.label].every(value=>typeof value === "string" && value.length)) {
  throw new Error("OUTLINER_TREE_ROOT must identify a Tree occurrence");
}
const controller = createTreeController({
  previewSelectionInput:previewInput,
  inspectProperties: blockId => { openDetailPane({workspaceRoot: paths.workspaceRoot, browsingContextId: crypto.randomUUID(), propertyInspectorBlockId: blockId}); },
  density: () => viewPreferences.density,
  setDensity: value => viewPreferences.setDensity(value),
  copyText:text=>process.stdout.write(osc52ClipboardWrite(text)),
      openExternal: openExternalUrl,
  openKeyInspector: () => keyInspector.open(),
  initialRoot,
  async createTreePane(root,direction) { openTreePane({workspaceRoot:paths.workspaceRoot,root,direction}); },
  navigation: serviceTreeNavigation(client, clientId, browsingContextId),
  clientId,
  browsingContextId,
  workspaceRoot: paths.workspaceRoot,
  actionKeymap,
  ...(process.env.HERDR_ENV === "1" ? {
    openGotoPopup: () => openGotoPopup({ workspaceRoot: paths.workspaceRoot, sourceClientId: clientId, sourceRegion: "tree" }),
  } : {}),
  request<T>(input: RequestInput): Promise<T> {
    return client.request<T>(input);
  },
  async createDetailPane(blockId, direction, targetPaneId) {
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
      targetPaneId,
    });
  },
  createDetailDestination: (blockId, placement) => createDetailDestination(client,clientId,{workspaceRoot:paths.workspaceRoot,initialTarget:{kind:"block",blockId},placement,timeoutMs:paths.mode === "remote" ? 60_000 : 5_000}),
  async openCapturePopup(capturedFromBlockId) {
    if (await focusActiveCapture(client)) return;
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
  try {
    await waitForCompatibleService(client, {
      timeoutMs: paths.mode === "remote" ? 30_000 : 5_000,
      pingTimeoutMs: paths.mode === "remote" ? 3_000 : 300,
    });
  } catch (error) {
    throw new Error(`Compatible outliner service is not available: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function enqueueWork(task: () => void | Promise<void>): void {
  workQueue = workQueue.then(task).catch((error) => controller.handleError(error));
}

function handleRawInput(data: string | Buffer): void {
  if(keyInspector.handle(data))return;
  if(mouseInput)mouseInput.process(data);
  else keyboardInput.write(data);
}

function handleMouseSequence(sequence: string): void {
  if(viewerInput.handle(sequence,text=>controller.copyViewerSelection(text),id=>enqueueWork(()=>controller.handleAction(id)),draw))return;
  if (controller.view().mode === "inbox" && controller.view().inbox?.handlePreviewMouse(sequence,text=>process.stdout.write(osc52ClipboardWrite(text)))) return;
  if(previewInput.handle(sequence,{focus:v=>controller.focusLocalPreview(v),scroll:d=>controller.scrollLocalPreview(d),resize:f=>controller.resizeLocalPreview(f),invoke:id=>controller.handleAction(id)},text=>process.stdout.write(osc52ClipboardWrite(text)),draw))return;
  if (controller.view().mode === "inbox" && controller.view().inbox?.handleActivityMouse(sequence)) return;
  if (controller.view().mode === "goto") { enqueueWork(() => controller.handleGotoMouse(sequence)); return; }
  const secondaryClick = parseTreeSecondaryClick(sequence);
  if (secondaryClick && rightClickOwnership === "outliner") {
    enqueueWork(() => controller.handleAction("tree.menu.open", secondaryClick));
    return;
  }
  const wheelDirection = parseTreeWheel(sequence);
  if (wheelDirection) {
    enqueueWork(() =>
      controller.handleTreeWheel(wheelDirection)
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
      await controller.handleLink(link);
    });
    return;
  }
  if (activate && rowId) {
    enqueueWork(() => controller.handleRowClick(rowId, true));
  }
}

mouseInput?.on("data", (sequence) => {
  if (isTreeMouseSequence(sequence)) handleMouseSequence(sequence);
  // StdinBuffer has already waited to distinguish Escape from an Alt chord.
  // Feeding that completed frame to readline leaves Escape pending again.
  else if (sequence === "\x1b") keypressInput.emit("keypress", sequence, {name:"escape",sequence});
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
process.stdin.on("data", handleRawInput);

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
