import { setTimeout as sleep } from "node:timers/promises";
import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import {
  decodeKittyPrintable,
  getCapabilities,
  Key,
  KeybindingsManager,
  matchesKey,
  ProcessTerminal,
  SelectList,
  setKeybindings,
  setCapabilities,
  TUI_KEYBINDINGS,
  TuiAltScreen,
  type Component,
  type SelectListTheme,
  type OverlayHandle,
  type TuiInputListener,
} from "@earendil-works/pi-tui";
import { OutlinerClient, type OutlinerWatcher } from "./client";
import { BufferComposer } from "./buffer-composer";
import {
  actionMenuItemText,
  filterActionMenuItems,
  OutlinerActionKeymap,
  outlinerActionLink,
  type OutlinerActionMenuItem,
} from "./outliner-actions";
import {
  createDetailController,
  type DetailEffects,
  type DetailViewport,
} from "./detail-controller";
import { layoutDetailEditor } from "./detail-editor-layout";
import {
  detailEditorPointAtClick,
  detailMouseRegionAt,
  type DetailMouseRegion,
} from "./detail-mouse";
import { detailCalloutThemeFromEnvironment } from "./detail-callout-theme";
import { projectDetailRead } from "./detail-embeds";
import { createDetailKeyHandler, detailActionScopes } from "./detail-keymap";
import {
  createPiDetailInputListener,
  detailChooserOwnsPiInput,
  piDetailChooserInput,
  piDetailLinkClick,
  PiDetailInputStreamDecoder,
  type PiDetailInput,
  type PiDetailLinkClick,
} from "./detail-pi-input";
import {
  DetailPiPreviewLayout,
  parseDetailPreviewActionUri,
} from "./detail-pi-preview";
import { resolvePreviewPointerAction } from "./detail-preview-regions";
import {
  DETAIL_DRAFT_SPLIT_MIN_WIDTH,
  DetailPiComponent,
  DetailPiDraftSplitLayout,
  detailDraftSplitWidths,
} from "./detail-pi-renderer";
import { parsePropertySummaryKeys } from "./property-summary";
import { completeReferencedPaths, readReferencedFile } from "./files";
import {
  configureCurrentPaneRightClick,
  currentPaneRuntime,
  focusCurrentPane,
  openBacklinkPeekPopup,
  openDetailPane,
  outlinerRightClickOwnership,
} from "./pane-control";
import { parseOutlinerLinkUri, resolveOutlinerLinkTarget } from "./outliner-links";
import {
  dispatchNavigation,
  focusTreeForClient,
  resolveNavigationDestination,
} from "./navigation-routes";
import { resolvePaths } from "./paths";
import { openDestinationTimeoutFromEnvironment } from "./open-destination-chooser";
import {
  isTreeMouseSequence,
  parseTreePlainClick,
  parseTreePrimaryClick,
  parseTreePrimaryPointer,
  parseTreeSecondaryClick,
  parseTreeWheelEvent,
  type TreeMouseClick,
} from "./tree-mouse";
import { osc52ClipboardWrite } from "./terminal";
import {
  OUTLINER_PROTOCOL_VERSION,
  type AnnotationBatchReceipt,
  type AnnotationReanchorInput,
  type AnnotationThread,
  type AttentionClientState,
  type BacklinkCollection,
  type Block,
  type BrowsingContextState,
  type PageAddressCollection,
  type OutlinerServiceStatus,
  type ResolvedBlockReferences,
  type SelectionContext,
  type VisibleBlockCollection,
} from "./types";

class DetailTuiAltScreen extends TuiAltScreen {
  declare private viewportInputListener: TuiInputListener | undefined;

  override addInputListener(listener: TuiInputListener): () => void {
    this.viewportInputListener ??= listener;
    return super.addInputListener(listener);
  }

  addOutlinerInputListener(listener: TuiInputListener): () => void {
    const viewportListener = this.viewportInputListener;
    if (!viewportListener) return super.addInputListener(listener);
    super.removeInputListener(viewportListener);
    const remove = super.addInputListener(listener);
    super.addInputListener(viewportListener);
    return remove;
  }
}

initTheme(undefined, false);
setKeybindings(
  new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.altScreen.pageUp": [],
    "tui.altScreen.pageDown": [],
    "tui.altScreen.top": [],
    "tui.altScreen.bottom": [],
  }),
);

const hyperlinksEnabled = process.env.HERDR_ENV === "1";
if (hyperlinksEnabled) {
  setCapabilities({ ...getCapabilities(), hyperlinks: true });
}
const calloutThemeResolution = detailCalloutThemeFromEnvironment();
if (calloutThemeResolution.errors.length > 0) {
  const shown = calloutThemeResolution.errors.slice(0, 3);
  const omitted = calloutThemeResolution.errors.length - shown.length;
  process.stderr.write(
    `Callout theme: ${shown.join("; ")}${omitted > 0 ? `; ${omitted} more` : ""}\n`,
  );
}
const detailHeaderPropertyKeys = parsePropertySummaryKeys(
  process.env.OUTLINER_PROPERTY_SUMMARY_KEYS,
);
const destinationTimeoutMs = openDestinationTimeoutFromEnvironment(
  process.env.OUTLINER_OPEN_DESTINATION_TIMEOUT_MS,
);

const paths = resolvePaths();
const client = new OutlinerClient(paths.socket);
const clientId = crypto.randomUUID();
const browsingContextId = process.env.OUTLINER_BROWSING_CONTEXT_ID?.trim() || clientId;
const actionKeymap = OutlinerActionKeymap.load();
const rightClickOwnership = outlinerRightClickOwnership();
let invokeDetailAction: (actionId: string) => Promise<void> = async () => {};
const detailPresentation = process.env.OUTLINER_DETAIL_PRESENTATION?.trim() || "block";
if (detailPresentation !== "block" && detailPresentation !== "property-inspector") {
  throw new Error(`Unsupported Detail presentation: ${detailPresentation}`);
}
const dedicatedPropertyBlockId =
  process.env.OUTLINER_DETAIL_TARGET_BLOCK_ID?.trim() || null;
if (detailPresentation === "property-inspector" && !dedicatedPropertyBlockId) {
  throw new Error("Dedicated property inspector requires a target block ID");
}
const initialTargetFragmentId =
  process.env.OUTLINER_DETAIL_TARGET_FRAGMENT_ID?.trim() || undefined;
configureCurrentPaneRightClick(rightClickOwnership);
let pendingLinkClick: PiDetailLinkClick = {
  activate: false,
  routing: "first-unlocked",
  suppress: false,
};
const terminal = new ProcessTerminal();
const inputStream = new PiDetailInputStreamDecoder();
const tui = new DetailTuiAltScreen(terminal, false, undefined, {
  mouse: true,
  openUrl(url) {
    const pointer = pendingLinkClick;
    pendingLinkClick = { activate: false, routing: "first-unlocked", suppress: false };
    if (pointer.suppress || stopping) return;
    enqueueWork(async () => {
      if (controller.state.destinationChooser.active) {
        await controller.handleDestinationChooserKeypress("", { name: "pointer" });
        return;
      }
      if (url.startsWith("pi-outliner-action:")) {
        await invokeDetailAction(url.slice("pi-outliner-action:".length));
        return;
      }
      const action = parseDetailPreviewActionUri(url);
      if (action) {
        const resolution = resolvePreviewPointerAction(action, pointer.activate);
        await controller.dispatch(
          resolution.type === "focus"
            ? { type: "preview.focus.set", regionId: resolution.regionId }
            : {
                type: "preview.action",
                action: resolution.action,
                ...(resolution.routing ? { routing: resolution.routing } : {}),
              },
          viewport(),
        );
        return;
      }
      await controller.dispatch({
        type: "reference.open",
        target: parseOutlinerLinkUri(url),
        routing: pointer.routing,
      }, viewport());
    });
  },
});
let stopping = false;
let watcher: OutlinerWatcher | null = null;
let workQueue = Promise.resolve();

type DetailDraftSplitFocus = "editor" | "preview";

let draftSplitFocus: DetailDraftSplitFocus = "editor";
let draftSplitHover: DetailMouseRegion | null = null;
let editorDragActive = false;
let renderedSelectionDragActive = false;

function draftSplitActive(): boolean {
  return controller.state.mode === "edit" &&
    terminal.columns >= DETAIL_DRAFT_SPLIT_MIN_WIDTH;
}

function viewport(): DetailViewport {
  const width = terminal.columns;
  const editorUsesSplitWidth = width >= DETAIL_DRAFT_SPLIT_MIN_WIDTH &&
    controller.state.mode !== "file" &&
    controller.state.mode !== "comment";
  return {
    width,
    editorWidth: editorUsesSplitWidth
      ? detailDraftSplitWidths(width).editor
      : width,
    height: terminal.rows,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function openTargetInNewDetail(
  blockId: string,
  direction: "right" | "down",
  fragmentId?: string,
): Promise<void> {
  const contextId = crypto.randomUUID();
  await client.request({
    action: "browsing-context.publish",
    sourceClientId: clientId,
    contextId,
    blockId,
    dispatchPreview: false,
  });
  openDetailPane({
    workspaceRoot: paths.workspaceRoot,
    browsingContextId: contextId,
    direction,
    ...(fragmentId ? { targetFragmentId: fragmentId } : {}),
  });
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
    if (!dedicatedPropertyBlockId || browsingContext.target.selected) return browsingContext;
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
  openBacklinkPeek(input) {
    openBacklinkPeekPopup({
      workspaceRoot: paths.workspaceRoot,
      ...input,
    });
  },
  openDetailPane: openTargetInNewDetail,
  copyText(text) {
    process.stdout.write(osc52ClipboardWrite(text));
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
  async createAnnotation(input) {
    return client.request<AnnotationBatchReceipt>({
      action: "annotations.create",
      ...input,
      author: "user",
    });
  },
  async listAnnotations(sourceBlockId) {
    return client.request<AnnotationThread[]>({
      action: "annotations.list",
      query: { sourceBlockId, includeResolved: true },
    });
  },
  async reanchorAnnotations(input: AnnotationReanchorInput) {
    return client.request<AnnotationThread[]>({
      action: "annotations.reanchor",
      input,
      mutation: { author: "user", actorId: "detail" },
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
  readFile(block) {
    return readReferencedFile(block, paths.workspaceRoot);
  },
  completeFiles(query) {
    return completeReferencedPaths(query, paths.workspaceRoot);
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
      blockId,
      dispatchPreview: false,
    });
    return openDetailPane({
      workspaceRoot: paths.workspaceRoot,
      browsingContextId: contextId,
      propertyInspectorBlockId: blockId,
    });
  },
};

let synchronizeLayout: (() => void) | undefined;
const controller = createDetailController(
  effects,
  () => {
    if (synchronizeLayout) synchronizeLayout();
    else tui.requestRender();
  },
  {
    propertyInspectorPresentation: detailPresentation === "property-inspector"
      ? "dedicated"
      : "inline",
    destinationTimeoutMs,
    initialTargetFragmentId,
    actionKeymap,
  },
);

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
  let runtime: ReturnType<typeof currentPaneRuntime>;
  try {
    runtime = currentPaneRuntime();
  } catch (error) {
    console.error(errorMessage(error));
  }
  watcher = client.watch({
    client: {
      clientId,
      role: "detail",
      contextId: browsingContextId,
      locked: detailPresentation === "property-inspector",
      runtime,
    },
    onConnect: () => enqueueWork(() => controller.onServiceConnect(viewport())),
    onDisconnect: () => enqueueWork(() => controller.onServiceDisconnect()),
    onError: (error) => enqueueWork(() => controller.onServiceError(error)),
    onEvent: (event) => enqueueWork(() => controller.onServiceEvent(event, viewport())),
  });
}

async function stop(exitCode = 0): Promise<void> {
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
  process.stdout.off("resize", handleResize);
  try {
    await terminal.drainInput(100, 20);
  } catch {
    // Best effort during terminal shutdown.
  }
  tui.stop({ preserveScreen: true });
  process.exit(exitCode);
}

let actionMenuHandle: OverlayHandle | null = null;
let composerHandle: OverlayHandle | null = null;

function closeActionMenu(): void {
  actionMenuHandle?.hide();
  actionMenuHandle = null;
}

const actionMenuTheme: SelectListTheme = {
  selectedPrefix: (text) => `\x1b[36m${text}\x1b[0m`,
  selectedText: (text) => `\x1b[1m${text}\x1b[0m`,
  description: (text) => `\x1b[2m${text}\x1b[0m`,
  scrollInfo: (text) => `\x1b[2m${text}\x1b[0m`,
  noMatch: (text) => `\x1b[2m${text}\x1b[0m`,
};

class FuzzyActionMenu implements Component {
  private query = "";
  private list: SelectList;
  onSelect?: (actionId: string) => void;
  onCancel?: () => void;

  constructor(
    private readonly items: readonly OutlinerActionMenuItem[],
    private readonly maxVisible: number,
  ) {
    this.list = this.createList();
  }

  render(width: number): string[] {
    return [
      `\x1b[2mFind: ${this.query}▏\x1b[0m`,
      ...this.list.render(width),
    ];
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.backspace)) {
      this.updateQuery([...this.query].slice(0, -1).join(""));
      return;
    }
    const printable = decodeKittyPrintable(data) ??
      (data.length === 1 && data >= " " && data !== "\x7f" ? data : undefined);
    if (printable !== undefined) {
      this.updateQuery(this.query + printable);
      return;
    }
    this.list.handleInput(data);
  }

  invalidate(): void {
    this.list.invalidate();
  }

  private updateQuery(query: string): void {
    this.query = query;
    this.list = this.createList();
    tui.requestRender();
  }

  private createList(): SelectList {
    const filtered = filterActionMenuItems(this.items, this.query);
    const list = new SelectList(
      filtered.map((item) => ({
        value: item.id,
        label: outlinerActionLink(item.id, actionMenuItemText(item)),
        description: item.description,
      })),
      Math.min(this.maxVisible, Math.max(1, filtered.length)),
      actionMenuTheme,
    );
    list.onSelect = (item) => this.onSelect?.(item.value);
    list.onCancel = () => this.onCancel?.();
    return list;
  }
}

function showActionMenu(
  items: readonly OutlinerActionMenuItem[],
  invoke: (actionId: string) => Promise<void>,
  origin?: TreeMouseClick,
): void {
  closeActionMenu();
  const menu = new FuzzyActionMenu(items, 13);
  menu.onSelect = (actionId) => {
    closeActionMenu();
    enqueueWork(() => invoke(actionId));
  };
  menu.onCancel = () => {
    closeActionMenu();
    tui.requestRender();
  };
  actionMenuHandle = tui.showOverlay(menu, {
    width: "70%",
    maxHeight: "70%",
    minWidth: 32,
    anchor: "top-right",
    ...(origin ? { row: origin.row, col: origin.column } : {}),
    margin: { top: 1, right: 1 },
  });
}

function focusDraftSplit(): void {
  if (!draftSplitActive()) return;
  draftSplitFocus = draftSplitFocus === "editor" ? "preview" : "editor";
  synchronizeLayout?.();
}

function navigatePreview(
  direction: "up" | "down" | "pageup" | "pagedown" | "top" | "bottom",
): void {
  preview.navigate(direction);
}
function activeDetailActionScopes(): readonly string[] {
  return detailActionScopes(controller.state, {
    bufferMode: controller.isBufferMode(),
    previewFocused: draftSplitActive() && draftSplitFocus === "preview",
  });
}


function editorSourceLineAtViewport(): number | null {
  const layout = layoutDetailEditor(
    controller.state.buffer.lines,
    controller.state.buffer.row,
    controller.state.buffer.column,
    viewport().editorWidth ?? viewport().width,
    controller.state.buffer.selectionRange,
  );
  return layout.rows[controller.state.editorVisualOffset]?.logicalRow ?? null;
}

function synchronizePreviewFromEditor(): void {
  if (!controller.state.draftPreviewLinked || !draftSplitActive()) return;
  const sourceLine = editorSourceLineAtViewport();
  if (sourceLine !== null) {
    preview.scrollDraftToSourceLine(sourceLine, detailDraftSplitWidths(terminal.columns).preview);
  }
}

async function synchronizeEditorFromPreview(): Promise<void> {
  if (!controller.state.draftPreviewLinked || !draftSplitActive()) return;
  const sourceLine = preview.draftSourceLineAtScroll(
    detailDraftSplitWidths(terminal.columns).preview,
  );
  if (sourceLine !== null) {
    await controller.dispatch({ type: "editor.viewport.anchor", sourceLine }, viewport());
  }
}

function editorPointerLocation(
  pointer: TreeMouseClick,
  mouseLayout: {
    width: number;
    height: number;
    editorWidth: number;
    split: boolean;
  },
): { visualRow: number; contentColumn: number } | null {
  if (detailMouseRegionAt(pointer, mouseLayout) !== "editor") return null;
  const layout = layoutDetailEditor(
    controller.state.buffer.lines,
    controller.state.buffer.row,
    controller.state.buffer.column,
    mouseLayout.editorWidth,
    controller.state.buffer.selectionRange,
  );
  return detailEditorPointAtClick(
    pointer,
    layout,
    controller.state.editorVisualOffset,
  );
}
async function handleRenderedSelectionMouse(data: string): Promise<boolean> {
  if (controller.state.mode !== "select") {
    renderedSelectionDragActive = false;
    return false;
  }
  const pointer = parseTreePrimaryPointer(data);
  if (!pointer || pointer.meta || pointer.ctrl) return false;
  const point = preview.sourcePointAtViewport(
    pointer.row,
    pointer.column,
    terminal.columns,
  );
  if (!point) return true;
  if (pointer.phase === "down") {
    renderedSelectionDragActive = true;
    await controller.dispatch({
      type: "annotation.selection.place",
      ...point,
      extend: false,
    }, viewport());
    return true;
  }
  if (!renderedSelectionDragActive) return true;
  await controller.dispatch({
    type: "annotation.selection.place",
    ...point,
    extend: true,
  }, viewport());
  if (pointer.phase === "up") renderedSelectionDragActive = false;
  return true;
}

async function handleDetailMouse(data: string): Promise<boolean> {
  if (controller.state.mode !== "edit") return false;
  const split = draftSplitActive();
  const widths = detailDraftSplitWidths(terminal.columns);
  const mouseLayout = {
    width: terminal.columns,
    height: terminal.rows,
    editorWidth: split ? widths.editor : terminal.columns,
    split,
  };
  const wheel = parseTreeWheelEvent(data);
  if (wheel) {
    editorDragActive = false;
    const region = detailMouseRegionAt(wheel, mouseLayout);
    draftSplitHover = region;
    if (region === "editor") {
      draftSplitFocus = "editor";
      await controller.dispatch({
        type: "editor.viewport.scroll",
        delta: wheel.direction === "up" ? -3 : 3,
      }, viewport());
      synchronizePreviewFromEditor();
      return true;
    }
    if (region === "preview") {
      draftSplitFocus = "preview";
      preview.navigate(wheel.direction);
      await synchronizeEditorFromPreview();
      return true;
    }
    return true;
  }

  const pointer = parseTreePrimaryPointer(data);
  if (!pointer) return false;
  if (pointer.phase === "down") {
    editorDragActive = false;
    const region = detailMouseRegionAt(pointer, mouseLayout);
    draftSplitHover = region;
    if (region === "editor" && !pointer.meta && !pointer.ctrl) {
      draftSplitFocus = "editor";
      editorDragActive = true;
      const location = editorPointerLocation(pointer, mouseLayout);
      if (location) {
        await controller.dispatch({
          type: "editor.cursor.place",
          ...location,
          extend: pointer.shift,
        }, viewport());
      }
      return true;
    }
    if (region === "preview") {
      draftSplitFocus = "preview";
      preview.handleInput(data);
      tui.requestRender();
    }
    return true;
  }

  if (!editorDragActive) return true;
  const bodyTop = 3;
  const bodyBottom = terminal.rows - 3;
  if (bodyBottom < bodyTop) {
    if (pointer.phase === "up") editorDragActive = false;
    return true;
  }
  let row = pointer.row;
  if (row < bodyTop) {
    await controller.dispatch({ type: "editor.viewport.scroll", delta: -1 }, viewport());
    row = bodyTop;
  } else if (row > bodyBottom) {
    await controller.dispatch({ type: "editor.viewport.scroll", delta: 1 }, viewport());
    row = bodyBottom;
  }
  const column = Math.max(0, Math.min(pointer.column, mouseLayout.editorWidth - 1));
  const location = editorPointerLocation({ row, column }, mouseLayout);
  if (location) {
    await controller.dispatch({
      type: "editor.cursor.place",
      ...location,
      extend: true,
    }, viewport());
    synchronizePreviewFromEditor();
  }
  if (pointer.phase === "up") editorDragActive = false;
  return true;
}

function shouldPassDetailInputToTui(data: string): boolean {
  const linkClick = piDetailLinkClick(data);
  if (linkClick) pendingLinkClick = linkClick;
  if (
    controller.state.destinationChooser.active &&
    detailChooserOwnsPiInput(data)
  ) return false;
  if (actionMenuHandle) return true;
  if (composerHandle) return false;
  if (tui.hasOverlay()) return true;
  if (!isTreeMouseSequence(data)) return false;
  if (parseTreeSecondaryClick(data) && rightClickOwnership === "outliner") return false;
  if (controller.state.mode === "select" && parseTreePrimaryPointer(data)) return false;
  if (controller.state.mode !== "edit") return true;
  const click = parseTreePlainClick(data);
  if (!click || !draftSplitActive()) return false;
  const widths = detailDraftSplitWidths(terminal.columns);
  const region = detailMouseRegionAt(click, {
    width: terminal.columns,
    height: terminal.rows,
    editorWidth: widths.editor,
    split: true,
  });
  if (region !== "preview") return false;
  draftSplitFocus = "preview";
  draftSplitHover = region;
  synchronizeLayout?.();
  return true;
}

const handleKeypress = createDetailKeyHandler({
  controller,
  viewport,
  stop: () => void stop(),
  actionKeymap,
  openActionMenu: showActionMenu,
  focusDraftSplit,
  navigatePreview,
  previewFocused: () => draftSplitActive() && draftSplitFocus === "preview",
  annotationSelectionSourceLine: () => preview.sourceLineAtScroll(terminal.columns),
});
invokeDetailAction = async (actionId) => {
  closeActionMenu();
  await handleKeypress.invoke(actionId);
};
async function handleDecodedInput(input: PiDetailInput): Promise<void> {
  if (controller.state.destinationChooser.active) {
    if (
      input.kind === "key" &&
      input.inputAction !== "suppress" &&
      input.key.ctrl &&
      input.key.name === "q"
    ) {
      await stop();
      return;
    }
    pendingLinkClick = { activate: false, routing: "first-unlocked", suppress: false };
    const forwarded = piDetailChooserInput(input);
    await controller.handleDestinationChooserKeypress(forwarded.str, forwarded.key);
    return;
  }
  if (input.kind === "paste") {
    if (controller.isBufferMode()) {
      await controller.dispatch({ type: "buffer.insert", text: input.text }, viewport());
    }
    return;
  }

  await handleKeypress(input.str, input.key, input.inputAction);
}

async function handleInput(data: string): Promise<void> {
  if (controller.state.destinationChooser.active) {
    for (const input of inputStream.push(data)) await handleDecodedInput(input);
    return;
  }
  const secondaryClick = parseTreeSecondaryClick(data);
  if (secondaryClick && rightClickOwnership === "outliner") {
    showActionMenu(
      actionKeymap.menuItems("detail", activeDetailActionScopes()),
      invokeDetailAction,
      secondaryClick,
    );
    return;
  }
  if (await handleRenderedSelectionMouse(data)) return;
  if (await handleDetailMouse(data)) return;
  for (const input of inputStream.push(data)) await handleDecodedInput(input);
}

const customFrame = new DetailPiComponent({
  state: controller.state,
  height: () => terminal.rows,
  header: () => {
    const propertyKeys = detailHeaderPropertyKeys;
    if (!draftSplitActive()) return { propertyKeys };
    const focused = draftSplitFocus === "editor";
    const linked = controller.state.draftPreviewLinked ? "↔ " : "";
    return {
      surface: `${linked}${focused ? "●" : "○"} Edit`,
      focused,
      propertyKeys,
    };
  },
  helpText: () => actionKeymap.helpText("detail", activeDetailActionScopes()),
});
const preview = new DetailPiPreviewLayout(
  controller.state,
  getMarkdownTheme(),
  hyperlinksEnabled,
  () => tui.requestRender(),
  {
    calloutTheme: calloutThemeResolution.theme,
    headerPropertyKeys: detailHeaderPropertyKeys,
    draftText: () => draftSplitActive() ? controller.state.buffer.text : null,
    async projectDraft(text) {
      const projection = await effects.projectRead(
        text,
        controller.state.context.selected?.id,
      );
      const resolved = await effects.resolveReferences(projection.text);
      return {
        sourceText: resolved.text,
        rawText: projection.text,
        embedRanges: projection.embedRanges,
        workIdPrefix: resolved.workIdPrefix ?? null,
      };
    },
    splitActive: draftSplitActive,
    focused: () => draftSplitFocus === "preview",
    helpText: () => actionKeymap.helpText("detail", activeDetailActionScopes()),
    chooserHelpText: () => controller.destinationChooserHelpText(),
    setRegions: (regions) => controller.setPreviewRegions(regions),
  },
);
const draftSplit = new DetailPiDraftSplitLayout(customFrame, preview);
const composer = new BufferComposer(() => {
  const target = controller.state.annotationDraft?.target;
  const context = target?.anchor.excerpt ?? "";
  return {
    title: target?.kind === "file"
      ? `Comment on ${target.filePath}:${target.startLine}-${target.endLine}`
      : "Comment on selection",
    context,
    buffer: controller.state.buffer,
    placeholder: "Write a comment…",
    commitAction: "Ctrl+S",
    cancelAction: "Esc",
    viewportOffset: controller.state.editorVisualOffset,
  };
});
let layoutRoot:
  | DetailPiComponent
  | DetailPiPreviewLayout
  | DetailPiDraftSplitLayout
  | undefined;
let previousMode = controller.state.mode;

synchronizeLayout = () => {
  const mode = controller.state.mode;
  if (mode !== previousMode) editorDragActive = false;
  if ((mode === "edit" || mode === "select") && mode !== previousMode) {
    draftSplitFocus = "editor";
    draftSplitHover = null;
  }
  previousMode = mode;

  const split = draftSplitActive();
  const previewActive = mode === "preview" || mode === "select" ||
    mode === "comment" || split;
  preview.setActive(previewActive);

  let previewWidth = terminal.columns;
  if (split) {
    draftSplit.setWidth(terminal.columns);
    previewWidth = detailDraftSplitWidths(terminal.columns).preview;
  }
  if (previewActive) {
    preview.syncState(previewWidth);
    preview.applyPendingFragmentScroll(previewWidth);
    if (!split && mode === "preview") {
      preview.ensureBacklinkSelectionVisible(previewWidth);
    }
  }

  if (mode === "comment" && !composerHandle) {
    composerHandle = tui.showOverlay(composer, {
      width: "100%",
      maxHeight: 7,
      anchor: "bottom-center",
      nonCapturing: true,
    });
  } else if (mode !== "comment" && composerHandle) {
    composerHandle.hide();
    composerHandle = null;
  }

  let nextRoot: DetailPiComponent | DetailPiPreviewLayout | DetailPiDraftSplitLayout;
  if (split) nextRoot = draftSplit;
  else if (previewActive) nextRoot = preview;
  else nextRoot = customFrame;

  if (nextRoot !== layoutRoot) {
    layoutRoot = nextRoot;
    tui.setLayoutRoot(nextRoot);
  }
  tui.requestRender();
};
synchronizeLayout();

tui.addOutlinerInputListener(
  createPiDetailInputListener(
    (data) => {
      if (!stopping) enqueueWork(() => handleInput(data));
    },
    (data) => shouldPassDetailInputToTui(data),
  ),
);

function handleResize(): void {
  enqueueWork(() => controller.dispatch({ type: "viewport.changed" }, viewport()));
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

process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
process.on("SIGHUP", () => void stop());
process.stdout.on("resize", handleResize);

tui.start();
startWatcher();
