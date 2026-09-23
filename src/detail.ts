import { initTheme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { DetailReadingSurface, detailReaderGeometry } from "./detail-reading-surface";
import { renderDetailDestinationPicker } from "./detail-pi-renderer";
import { navigationDestinationItems, navigationDestinationStatus, NavigationDestinationPreview, renderNavigationDestinationPreview } from "./navigation-destination-menu";
import { getProperty } from "./properties";
import { detailPropertyInspectorRegions } from "./property-inspector";
import { emitKeypressEvents } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { createOutlinerClient, type OutlinerWatcher } from "./client";
import {
  startClientRuntimeSync,
  type ClientRuntimeSync,
} from "./client-runtime-sync";
import { OutlinerActionKeymap, filterActionMenuItems, type OutlinerActionMenuItem } from "./outliner-actions";
import {
  createDetailController,
  type DetailEffects,
  type DetailController,
  type DetailViewport,
} from "./detail-controller";
import { projectDetailRead } from "./detail-embeds";
import { DetailEventScheduler } from "./detail-event-scheduler";
import { createDetailKeyHandler, detailActionScopes } from "./detail-keymap";
import { buildDetailAnsiPreview, renderDetailLines } from "./detail-renderer";
import { referencedFilePreview, type FileContents, type ReferencedPathCandidate } from "./files";
import {
  editTextInExternalEditor,
  resolveExternalEditorConfiguration,
} from "./external-editor";
import { followResourceOccurrence, resolveOutlinerLinkTarget } from "./outliner-links";
import {
  dispatchNavigation,
  focusTreeForClient,
  resolveNavigationDestination,
} from "./navigation-routes";
import { openExternalUrl } from "./open-external";
import { TUI_RESOURCE_PRESENTATION_CONTEXT } from "./resource-presentation";
import { reportCurrentPaneWorkspace,
  currentPaneRuntime,
  detailTargetFromEnvironment,
  focusCurrentPane,
  openBacklinkPeekPopup,
  openDetailPane,
  openVirtualBranchNavigatorPopup,
} from "./pane-control";
import { resolveClientPaths } from "./paths";
import { openDestinationTimeoutFromEnvironment } from "./open-destination-chooser";
import {
  BRACKETED_PASTE_DISABLE,
  BRACKETED_PASTE_ENABLE,
  osc52ClipboardWrite,
  TerminalInputDecoder,
  type TerminalKey,
} from "./terminal";
import {
  OUTLINER_PROTOCOL_VERSION,
  type AnnotationBatchReceipt,
  type AnnotationListQuery,
  type AnnotationReconcileInput,
  type AnnotationReconcileReceipt,
  type AnnotationThread,
  type AnnotationRecord,
  type AttentionClientState,
  type BacklinkCollection,
  type Block,
  type BookmarkStatus,
  type BookmarkToggleReceipt,
  type BrowsingContextState,
  type InternResourceReceipt,
  type PageAddressCollection,
  type OutlinerNavigationTarget,
  type OutlinerViewAddress,
  type NavigationLinkState,
  type OutlinerServiceStatus,
  type ResourceDescription,
  type ResolvedBlockReferences,
  type SelectionContext,
  type VisibleBlockCollection,
} from "./types";

const WEB_RESOURCE_REQUEST_TIMEOUT_MS = 17_000;

initTheme(undefined, false);
const paths = resolveClientPaths();
reportCurrentPaneWorkspace(paths.workspaceRoot);
const client = createOutlinerClient(paths);
const clientId = crypto.randomUUID();
const browsingContextId = process.env.OUTLINER_BROWSING_CONTEXT_ID?.trim() || clientId;
const actionKeymap = OutlinerActionKeymap.load();
const destinationTimeoutMs = openDestinationTimeoutFromEnvironment(
  process.env.OUTLINER_OPEN_DESTINATION_TIMEOUT_MS,
);
const detailPresentation = process.env.OUTLINER_DETAIL_PRESENTATION?.trim() || "block";
if (detailPresentation !== "block" && detailPresentation !== "property-inspector") {
  throw new Error(`Unsupported Detail presentation: ${detailPresentation}`);
}
const dedicatedPropertyBlockId =
  process.env.OUTLINER_DETAIL_TARGET_BLOCK_ID?.trim() || null;
if (detailPresentation === "property-inspector" && !dedicatedPropertyBlockId) {
  throw new Error("Dedicated property inspector requires a target block ID");
}
const initialTarget = detailTargetFromEnvironment(process.env.OUTLINER_DETAIL_TARGET);
let stopping = false;
let externalEditorActive = false;
let watcher: OutlinerWatcher | null = null;
let runtimeSync: ClientRuntimeSync | null = null;
let workQueue = Promise.resolve();
let pendingPaste: string | null = null;

interface DetailDestinationPicker {
  state: NavigationLinkState; purpose: "link" | "open"; showOther: boolean;
  query: string; index: number; preview: NavigationDestinationPreview; reader: DetailController;
  resolve(value: OutlinerViewAddress | null | undefined): void;
}
let destinationPicker: DetailDestinationPicker | null = null;
function destinationItems(picker: DetailDestinationPicker): OutlinerActionMenuItem[] {
  return filterActionMenuItems(navigationDestinationItems(picker.state, picker.purpose === "link", picker.showOther), picker.query);
}
function refreshDestinationPreview(): void {
  const picker = destinationPicker;
  if (!picker) return;
  const items = destinationItems(picker);
  picker.index = Math.max(0, Math.min(picker.index, items.length - 1));
  const item = items[picker.index];
  void picker.preview.select(item ? picker.state.destinations[Number(item.id.slice(12))] : undefined);
  draw();
}
async function handleDestinationInput(str: string, key: TerminalKey): Promise<void> {
  const picker = destinationPicker;
  if (!picker) return;
  if (key.name === "escape") {
    picker.preview.clear(); destinationPicker = null; picker.resolve(undefined); draw(); return;
  }
  if (key.name === "return") {
    const item = destinationItems(picker)[picker.index];
    if (!item) return;
    if (item.id === "destination:other") {
      picker.showOther = !picker.showOther; picker.query = ""; picker.index = 0; refreshDestinationPreview(); return;
    }
    picker.preview.clear(); destinationPicker = null;
    if (item.id === "destination:new-right" || item.id === "destination:new-below") {
      try { await picker.reader.dispatch({type: "pane.open", direction: item.id === "destination:new-right" ? "right" : "down"}, viewport(picker.reader)); }
      finally { picker.resolve(undefined); }
    } else picker.resolve(item.id === "destination:unlink" ? null : picker.state.destinations[Number(item.id.slice(12))]?.view);
    draw(); return;
  }
  if (key.name === "up") picker.index--;
  else if (key.name === "down" || key.name === "tab") picker.index++;
  else if (key.name === "backspace") { picker.query = [...picker.query].slice(0, -1).join(""); picker.index = 0; }
  else if (str && !key.ctrl && !key.meta && [...str].every(char => char >= " " && char !== "\x7f")) { picker.query += str; picker.index = 0; }
  refreshDestinationPreview();
}

function viewport(reader: DetailController = readingSurface.active): DetailViewport {
  const geometry = detailReaderGeometry(process.stdout.columns ?? 100, process.stdout.rows ?? 30, readingSurface.previewVisible);
  const {width, height} = reader === inspection ? geometry.preview : geometry.current;
  return {
    width,
    height,
    ...(reader.state.mode === "preview" ? { preview: buildDetailAnsiPreview(reader.state, width) } : {}),
  };
}
const firstWatcherConnection = Promise.withResolvers<void>();
let runtimeInitialized = false;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function openTargetInNewDetail(
  target: OutlinerNavigationTarget,
  direction: "right" | "down",
): Promise<void> {
  const contextId = crypto.randomUUID();
  await client.request({
    action: "browsing-context.publish",
    sourceClientId: clientId,
    contextId,
    target,
    dispatchPreview: false,
  });
  openDetailPane({
    workspaceRoot: paths.workspaceRoot,
    browsingContextId: contextId,
    direction,
    initialTarget: target,
  });
}

const effects: DetailEffects = {
  clientId,
  browsingContextId,
  enqueueViewUpdate: enqueueWork,
  focusSelf() {
    if (process.env.HERDR_ENV === "1") focusCurrentPane();
  },
  async getBrowsingContext() {
    const browsingContext = await client.request<BrowsingContextState>({
      action: "browsing-context.get",
      contextId: browsingContextId,
    });
    if (!dedicatedPropertyBlockId || browsingContext.target) return browsingContext;
    return {
      ...browsingContext,
      target: { kind: "block", blockId: dedicatedPropertyBlockId },
    };
  },
  async loadTarget(target) {
    if (target.kind === "block") {
      return {
        kind: "block",
        target,
        context: await client.request<SelectionContext>({
          action: "blocks.context",
          blockId: target.blockId,
        }),
      };
    }
    return {
      kind: "resource",
      target,
      description: await client.request<ResourceDescription>(
        {
          action: "resources.open",
          target,
          destinationClientId: clientId,
        },
        WEB_RESOURCE_REQUEST_TIMEOUT_MS,
      ),
    };
  },
  async chooseDestination(purpose) {
    const reader = readingSurface.active;
    const state = await client.request<NavigationLinkState>({action: "navigation.link.get", source: {clientId, region: "detail"}});
    return new Promise<OutlinerViewAddress | null | undefined>(resolve => {
      destinationPicker = {state, purpose, reader, query: "", index: 0, showOther: false, preview: new NavigationDestinationPreview(client, draw), resolve};
      refreshDestinationPreview();
    });
  },
  async setDestination(destination) {
    const state = await client.request<NavigationLinkState>({action: "navigation.link.set", source: {clientId, region: "detail"}, destination});
    return state.destinations.find(item => item.view.clientId === destination?.clientId && item.view.region === destination.region)?.label;
  },
  async setNavigationProtection(navigationProtection) {
    await client.request({action: "clients.update", clientId, navigationProtection});
  },
  async setCurrentTarget(currentTarget) {
    await client.request({ action: "clients.update", clientId, currentTarget });
  },
  dispatchNavigation(target, intent, options) {
    return dispatchNavigation(client, clientId, target, intent, options);
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
  openBacklinkPeek(input) {
    openBacklinkPeekPopup({
      workspaceRoot: paths.workspaceRoot,
      ...input,
    });
  },
  openVirtualBranchNavigator(viewId, adapter) {
    openVirtualBranchNavigatorPopup({
      workspaceRoot: paths.workspaceRoot,
      browsingContextId,
      sourceClientId: clientId,
      sourceRole: "detail",
      viewId,
      ...(adapter ? { adapter } : {}),
    });
  },
  bookmarkStatus(targetBlockId) {
    return client.request<BookmarkStatus>({ action: "bookmarks.status", targetBlockId });
  },
  toggleBookmark(targetBlockId, expectedRecordId) {
    return client.request<BookmarkToggleReceipt>({
      action: "bookmarks.toggle",
      targetBlockId,
      expectedRecordId,
    });
  },
  bookmarksRoot() {
    return client.request<Block>({ action: "bookmarks.root" });
  },
  openDetailPane: openTargetInNewDetail,
  copyText(text) {
    process.stdout.write(osc52ClipboardWrite(text));
  },
  editExternalDraft(input) {
    const configuration = resolveExternalEditorConfiguration();
    const expectedRevision = input.kind === "block"
      ? String(input.expectedRevision)
      : JSON.stringify(input.expectedRevision);
    return editTextInExternalEditor({
      text: input.text,
      expectedRevision,
    }, {
      editor: configuration.editor,
      environment: configuration.environment,
      cwd: paths.workspaceRoot,
      suspendTerminal() {
        externalEditorActive = true;
        pendingPaste = null;
        inputDecoder = new TerminalInputDecoder((text) => {
          pendingPaste = text;
        });
        process.stdin.pause();
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        process.stdout.write(`${BRACKETED_PASTE_DISABLE}\x1b[?25h\x1b[?1049l`);
      },
      restoreTerminal() {
        try {
          process.stdout.write(`\x1b[?1049h\x1b[?25l${BRACKETED_PASTE_ENABLE}`);
          if (process.stdin.isTTY) process.stdin.setRawMode(true);
          process.stdin.resume();
          if (process.env.HERDR_ENV === "1") focusCurrentPane();
          draw();
        } finally {
          externalEditorActive = false;
        }
      },
      async currentRevision() {
        if (input.kind === "block") {
          return String((await client.request<Block>({
            action: "get",
            blockId: input.blockId,
          })).revision);
        }
        const description = await client.request<ResourceDescription>({
          action: "resources.describe",
          target: { kind: "resource", resourceId: input.resourceId },
          destinationClientId: clientId,
        });
        if (!description.filesystem) {
          throw new Error("Filesystem Resource text is unavailable");
        }
        return JSON.stringify(description.filesystem.revision);
      },
    });
  },
  writeFilesystemResource(input) {
    return client.request<ResourceDescription>({
      action: "resources.write-filesystem",
      input,
      destinationClientId: clientId,
    });
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
  followResourceOccurrence: target => followResourceOccurrence(client, target),
  async createAnnotation(input) {
    return client.request<AnnotationBatchReceipt>({
      action: "annotations.create",
      ...input,
      author: "user",
    });
  },
  async replyAnnotation(input) {
    return client.request<AnnotationBatchReceipt>({ action: "annotations.reply", ...input, author: "user" });
  },
  async setAnnotationLifecycle(input) {
    return client.request<AnnotationRecord>({ action: "annotations.lifecycle", input, mutation: { author: "user", actorId: "detail" } });
  },
  async internFilesystem(path) {
    return client.request<InternResourceReceipt>({
      action: "resources.intern-filesystem",
      input: { path },
    });
  },
  async lookupFilesystem(path) {
    return client.request<InternResourceReceipt["resource"] | null>({
      action: "resources.lookup-filesystem",
      path,
    });
  },
  async refreshResource(resourceId) {
    return client.request<ResourceDescription>(
      {
        action: "resources.refresh",
        resourceId,
        destinationClientId: clientId,
      },
      WEB_RESOURCE_REQUEST_TIMEOUT_MS,
    );
  },
  openExternal: openExternalUrl,
  async getAnnotation(annotationId) {
    return client.request<AnnotationRecord>({
      action: "annotations.get",
      annotationId,
    });
  },
  async listAnnotations(query: AnnotationListQuery) {
    return client.request<AnnotationThread[]>({
      action: "annotations.list",
      query,
    });
  },
  async reconcileAnnotations(input: AnnotationReconcileInput) {
    return client.request<AnnotationReconcileReceipt>({
      action: "annotations.reconcile",
      input,
    });
  },
  async getAttention() {
    return client.request<AttentionClientState>({
      action: "attention.get",
      targetClientId: clientId,
    });
  },
  async acknowledgeAttention(markId) {
    return client.request<AttentionClientState>({
      action: "attention.acknowledge",
      input: { targetClientId: clientId, ...(markId ? { markId } : {}) },
    });
  },
  async queryBlocks(query) {
    return client.request<VisibleBlockCollection>({ action: "blocks.query", query });
  },
  async queryPageAddresses(query, limit) {
    return client.request<PageAddressCollection>({ action: "pages.complete", query, limit });
  },
  async readFile(block) {
    const path = getProperty(block.properties, "file");
    if (!path) throw new Error("Selected block has no [file::path] property");
    const contents = await client.request<FileContents>({ action: "files.read", path });
    return referencedFilePreview(block, contents);
  },
  async completeFiles(query) {
    return client.request<ReferencedPathCandidate[]>({ action: "files.complete", prefix: query });
  },
  async focusOutliner() {
    await focusTreeForClient(client, clientId);
  },
  async openPropertyInspectorPane(blockId) {
    const contextId = crypto.randomUUID();
    await client.request({
      action: "browsing-context.publish",
      sourceClientId: clientId,
      contextId,
      target: { kind: "block", blockId },
      dispatchPreview: false,
    });
    return openDetailPane({
      workspaceRoot: paths.workspaceRoot,
      browsingContextId: contextId,
      propertyInspectorBlockId: blockId,
    });
  },
};

function draw(): void {
  if (destinationPicker) {
    const picker = destinationPicker;
    const items = destinationItems(picker);
    const lines = renderDetailDestinationPicker({
      width: process.stdout.columns ?? 100, height: process.stdout.rows ?? 30,
      purpose: picker.purpose, query: picker.query, status: navigationDestinationStatus(picker.state, picker.purpose, picker.showOther),
      list: (width, height) => {
        const visibleItems = Math.max(1, Math.floor(height / 2));
        const start = Math.max(0, picker.index - visibleItems + 1);
        return items.slice(start, start + visibleItems).flatMap((item, index) => [
          truncateToWidth(`${start + index === picker.index ? "▶" : " "} ${item.label}`, width),
          truncateToWidth(`  ${item.description}`, width),
        ]);
      },
      preview: (width, height) => renderNavigationDestinationPreview(picker.preview, width, height),
    });
    process.stdout.write("\x1b[H\x1b[2J" + lines.join("\n"));
    return;
  }
  const geometry = detailReaderGeometry(process.stdout.columns ?? 100, process.stdout.rows ?? 30, readingSurface.previewVisible);
  const render = (reader: DetailController, label: string) => {
    reader.setPreviewRegions(detailPropertyInspectorRegions(reader.state));
    return renderDetailLines(reader.state, viewport(reader), {
      header: {surface: label === "Current" && geometry.arrangement === "switch" ? `Current · Preview ready (${actionKeymap.primaryBinding("detail.reading.focus")})` : label, focused: readingSurface.active === reader},
      helpPrefix: readingSurface.previewVisible ? `${actionKeymap.primaryBinding("detail.reading.focus")} Current/Preview · Alt+Enter Keep · Esc close Preview` : "",
      helpText: actionKeymap.helpText("detail", detailActionScopes(reader.state, {bufferMode: reader.isBufferMode()})),
      chooserHelpText: reader.destinationChooserHelpText(),
    });
  };
  let lines: string[];
  if (geometry.arrangement === "beside") {
    const left = render(controller, "Current");
    const right = render(inspection, "Preview");
    const width = viewport(controller).width;
    lines = Array.from({length: Math.max(left.length, right.length)}, (_, index) => {
      const line = truncateToWidth(left[index] ?? "", width);
      return line + " ".repeat(Math.max(0, width - visibleWidth(line))) + "│" + (right[index] ?? "");
    });
  } else if (geometry.arrangement === "below") {
    lines = [...render(controller, "Current"), "─".repeat(geometry.current.width), ...render(inspection, "Preview")];
  } else lines = render(readingSurface.active, readingSurface.active === inspection ? "Preview" : "Current");
  process.stdout.write("\x1b[H\x1b[2J" + lines.join("\n"));
}

const controller = createDetailController(
  effects,
  draw,
  {
    propertyInspectorPresentation: detailPresentation === "property-inspector"
      ? "dedicated"
      : "inline",
    destinationTimeoutMs,
    initialTarget,
    actionKeymap,
  },
);

const inspection = createDetailController({
  ...effects,
  loadTarget: async target => target.kind === "block" ? effects.loadTarget(target) : {
    kind: "resource", target,
    description: await client.request<ResourceDescription>({action: "resources.describe", destinationClientId: clientId, target}),
  },
  getBrowsingContext: async () => ({contextId: browsingContextId, target: null}),
  setCurrentTarget: async previewTarget => { await client.request({action: "clients.update", clientId, previewTarget}); },
  setNavigationProtection: async () => {},
  isSourceSelectionActive: () => false,
}, draw, {actionKeymap, openHere: target => readingSurface.openHere(target, viewport(controller))});
const readingSurface = new DetailReadingSurface(controller, inspection, draw, async () => {
  await client.request({action: "clients.update", clientId, previewTarget: null});
});

function enqueueWork(task: () => void | Promise<void>): void {
  workQueue = workQueue.then(task).catch((error) => {
    controller.onServiceError(error);
  });
}
const serviceEventScheduler = new DetailEventScheduler({
  clientId,
  enqueue: enqueueWork,
  handle: (event) => readingSurface.onServiceEvent(event, viewport()),
  supersedePreview: () => inspection.supersedePassivePreview(),
});

let inputDecoder = new TerminalInputDecoder((text) => {
  pendingPaste = text;
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
      onError: (error) =>
        serviceEventScheduler.scheduleWork(() => controller.onServiceError(error)),
    })
    : null;
  watcher = client.watch({
    client: {
      clientId,
      role: "detail",
      contextId: browsingContextId,
      runtime,
      resourcePresentation: TUI_RESOURCE_PRESENTATION_CONTEXT,
    },
    onConnect: async () => {
      await runtimeSync?.synchronize();
      firstWatcherConnection.resolve();
      if (runtimeInitialized) {
        serviceEventScheduler.scheduleWork(async () => { await controller.onServiceConnect(viewport(controller)); await inspection.onServiceConnect(viewport(inspection)); });
      }
    },
    onDisconnect: () => {
      runtimeSync?.suspend();
      serviceEventScheduler.scheduleWork(() => { controller.onServiceDisconnect(); inspection.onServiceDisconnect(); });
    },
    onError: (error) => {
      if (!runtimeInitialized) firstWatcherConnection.reject(error);
      else serviceEventScheduler.scheduleWork(() => controller.onServiceError(error));
    },
    onEvent: (event) => serviceEventScheduler.schedule(event),
  });
}

function stop(): void {
  if (stopping) return;
  stopping = true;
  watcher?.stop();
  void runtimeSync?.stop();
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdout.write(`${BRACKETED_PASTE_DISABLE}\x1b[?25h\x1b[?1049l`);
  process.exit(0);
}

const handleKeypress = createDetailKeyHandler({ controller, viewport: () => viewport(controller), stop, actionKeymap });
const inspectionKeypress = createDetailKeyHandler({controller: inspection, viewport: () => viewport(inspection), stop: () => { void readingSurface.closePreview(); }, actionKeymap});

async function initialize(): Promise<void> {
  await waitForService();
  startWatcher();
  await firstWatcherConnection.promise;
  await controller.initialize();
  runtimeInitialized = true;
  await controller.onServiceConnect(viewport(controller));
  await inspection.onServiceConnect(viewport(inspection));
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

process.on("SIGINT", () => {
  if (!externalEditorActive) stop();
});
process.on("SIGTERM", stop);
process.on("SIGHUP", stop);

async function handleInput(str: string, key: TerminalKey): Promise<void> {
  const inputAction = inputDecoder.consume(str, key);
  const active = readingSurface.active;
  if (pendingPaste !== null) {
    const text = pendingPaste;
    pendingPaste = null;
    if (active.state.destinationChooser.active) {
      await active.handleDestinationChooserKeypress("", { name: "paste" });
      return;
    }
    if (active.isBufferMode()) await active.dispatch({ type: "buffer.insert", text }, viewport());
  }
  if (inputAction !== "suppress" && key.name === "escape" && await readingSurface.escapePreview()) return;
  if (inputAction !== "suppress" && !active.state.destinationChooser.active) {
    const {actionId} = actionKeymap.resolve("detail", detailActionScopes(active.state), str, key);
    if (actionId === "detail.reading.focus") { readingSurface.toggleFocus(); return; }
    if (actionId === "detail.reading.close") { await readingSurface.closePreview(); return; }
    if (actionId === "detail.reading.keep") { await readingSurface.keepPreview(viewport(controller)); return; }
    if (active === inspection && (actionId === "detail.annotation.reply" || actionId === "detail.annotation.lifecycle")) {
      const annotationId = inspection.state.selectedAnnotationId;
      if (!annotationId) { inspection.onServiceError(new Error("Select a comment before replying or resolving")); return; }
      await readingSurface.activatePreviewAction({type: actionId === "detail.annotation.reply" ? "annotation.thread.reply" : "annotation.thread.lifecycle", annotationId}, viewport(controller));
      return;
    }
    if (actionId && active === inspection && actionKeymap.action(actionId).menuGroup === "Edit" && actionId !== "detail.annotation.previous" && actionId !== "detail.annotation.next") {
      if (await readingSurface.keepPreview(viewport(controller))) await handleKeypress.invoke(actionId);
      return;
    }
  }
  await (active === inspection ? inspectionKeypress : handleKeypress)(str, key, inputAction);
}

process.stdin.on("keypress", (str: string, key: TerminalKey) => {
  if (destinationPicker) { void handleDestinationInput(str, key).catch(error => controller.onServiceError(error)); return; }
  serviceEventScheduler.scheduleWork(() => handleInput(str, key));
});

process.stdout.on("resize", () => {
  serviceEventScheduler.scheduleWork(() =>
    controller.dispatch({ type: "viewport.changed" }, viewport())
  );
});
draw();
