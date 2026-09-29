import type { FragmentCandidateCollection } from "./fragment-search";
import {captureAnnotationPassage} from "./document-annotation";
import {loadDetailDraftPreview} from './detail-read-preview';
import {PaneDisplay} from "./pane-display";
import {sanitizeDynamicText} from "./terminal";
import {listItemRemovalMenu, checklistStatusMenu} from "./checklist-ui";
import type {ChecklistChoice} from "./checklist-session";
import {detailTitle} from "./detail-renderer";
import {adjacentReaderMenu, readerMenuFromAction, readerMenuItems, type ReaderMenu} from "./reader-chrome";
import {ViewPreferences} from "./view-preferences";
import { renderDetailLines } from "./detail-renderer";
import { treeLinkAtClick } from "./tree-mouse";
import {EditRecoveryInput} from "./edit-recovery-input";
import {EditRecoveryClient} from "./edit-recovery-client";
import {EditRecoveryReview,type RecoveryChoice} from "./edit-recovery-review";
import type {EditRecovery} from "./edit-recovery";
import type {ExternalEditorOptions} from "./external-editor";
import {destinationRecoveryKey} from "./open-destination-chooser";
import {ProvenanceInspector} from "./provenance-inspector";
import {KeyInspector} from "./key-inspector";
import {createDetailDestination, type DetailDestinationPlacement} from "./detail-pane-placement";
import { ComposedLayout, ComposedTree, composedTreeNavigation, composedPointer, composedWidths, detailServiceCapabilities } from "./composed-surface";
import { navigationDestinationItems, navigationDestinationStatus, navigationPlacementItems, navigationPlacementStatus, NavigationDestinationDisplay, NavigationDestinationPreview, renderNavigationDestinationPreview } from "./navigation-destination-menu";
import { getProperty } from "./properties";
import { waitForCompatibleService } from "./service-compatibility";
import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import {
  decodeKittyPrintable,
  getCapabilities,
  Key,
  KeybindingsManager,
  matchesKey,
  ProcessTerminal,
  SelectList,
  wrapTextWithAnsi,
  truncateToWidth,
  setKeybindings,
  setCapabilities,
  TUI_KEYBINDINGS,
  TuiAltScreen,
  type Component,
  type SelectListTheme,
  type OverlayHandle,
  type TuiInputListener,
} from "@earendil-works/pi-tui";
import { createOutlinerClient, type OutlinerWatcher } from "./client";
import {
  startClientRuntimeSync,
  type ClientRuntimeSync,
} from "./client-runtime-sync";
import { BUFFER_COMPOSER_HEIGHT, BufferComposer, bufferComposerEditorBody } from "./buffer-composer";
import {
  actionMenuItemText,
  filterActionMenuItems,
  OutlinerActionKeymap,
  outlinerActionLink,
  type OutlinerActionMenuItem,
} from "./outliner-actions";
import {
  createDetailController,
  detailRestoreRequest,
  type DetailDirectSelectionCapture,
  type DetailEffects,
  type DetailController,
  type DetailViewport,
} from "./detail-controller";
import { DetailReadingSurface, detailReaderGeometry } from "./detail-reading-surface";
import { DetailEventScheduler } from "./detail-event-scheduler";
import { layoutDetailEditor } from "./detail-editor-layout";
import {
  detailEditorPointAtClick,
  detailMouseRegionAt,
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
  DetailReaderSplitLayout,
  DetailReaderVerticalLayout,
  detailDraftSplitWidths,
  renderDetailDestinationPicker,
} from "./detail-pi-renderer";
import { parsePropertySummaryKeys } from "./property-summary";
import { referencedFilePreview, type FileContents, type ReferencedPathCandidate } from "./files";
import {
  editTextInExternalEditor,
  resolveExternalEditorConfiguration,
} from "./external-editor";
import { reportCurrentPaneWorkspace,
  configureCurrentPaneRightClick,
  detailTargetFromEnvironment,
  currentPaneRuntime,
  focusCurrentPane,
  openBacklinkPeekPopup,
  openDetailPane,
  openTreePane,
  openVirtualBranchNavigatorPopup,
  outlinerRightClickOwnership,
} from "./pane-control";
import { followResourceOccurrence, parseOutlinerLinkUri, resolveOutlinerLinkTarget } from "./outliner-links";
import {
  dispatchNavigation,
  focusTreeForClient,
  resolveNavigationDestination,
} from "./navigation-routes";
import { openExternalUrl } from "./open-external";
import { readHerdrPaneSnapshot } from "./herdr-comment-selection";
import {copyRenderedSelection} from './rendered-links';
import { TUI_RESOURCE_PRESENTATION_CONTEXT } from "./resource-presentation";
import { resolveClientPaths } from "./paths";
import { openDestinationTimeoutFromEnvironment } from "./open-destination-chooser";
import {
  isTreeMouseSequence,
  parseTreePlainClick,
  parseTreePrimaryPointer,
  parseTreeSecondaryClick,
  parseTreeWheelEvent,
  type TreeMouseClick,
} from "./tree-mouse";
import { osc52ClipboardWrite } from "./terminal";
import {
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
  type NavigationLinkState,
  type OutlinerViewAddress,
  type OutlinerRegion,
  type InternResourceReceipt,
  type PageAddressCollection,
  type OutlinerNavigationTarget,
  type ResourceDescription,
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

  releasePointerGesture(): void {
    // A modal takes pointer ownership. Retire the viewport's click-count/drag
    // state through its focus-out path, without discarding completed selection.
    // Otherwise click → menu → Esc → click can become word selection.
    this.viewportInputListener?.("\x1b[O");
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
const WEB_RESOURCE_REQUEST_TIMEOUT_MS = 17_000;

const paths = resolveClientPaths();
const viewPreferences = new ViewPreferences();
const paneDisplay = new PaneDisplay(() => synchronizeLayout?.());
reportCurrentPaneWorkspace(paths.workspaceRoot);
const client = createOutlinerClient(paths);
const editRecovery = new EditRecoveryClient(client,paths.stateDir);
const clientId = crypto.randomUUID();
const destinationDisplay = new NavigationDestinationDisplay(client, {clientId, region: "detail"}, () => tui.requestRender());
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
const initialTarget = detailTargetFromEnvironment(process.env.OUTLINER_DETAIL_TARGET);
configureCurrentPaneRightClick(rightClickOwnership);
let pendingLinkClick: PiDetailLinkClick = {
  activate: false,
  routing: "linked",
  suppress: false,
};
let directSelectionDocument: {
  reader: DetailController;
  document: DetailController["state"]["document"];
  text: string;
  file: DetailController["state"]["referencedFile"];
} | null = null;
let latestDirectSelection: DetailDirectSelectionCapture | null = null;
let pendingDirectSelection: Promise<DetailDirectSelectionCapture | null> | null = null;
let directSelectionGeneration = 0;
function retireDirectSelection(): void {
  directSelectionGeneration++;
  directSelectionDocument = null;
  latestDirectSelection = null;
  pendingDirectSelection = null;
}
const composed = process.env.OUTLINER_COMPOSED_SURFACE === "1";
let focusedRegion: OutlinerRegion = "tree";
const processTerminal = new ProcessTerminal();
let inspectionVisible = false;
const readerWidth = () => composed ? composedWidths(processTerminal.columns).detail : processTerminal.columns;
const readerGeometry = () => detailReaderGeometry(readerWidth(), processTerminal.rows, inspectionVisible);
const currentReaderWidth = () => readerGeometry().current.width;
// Detail receives its allocated rectangle; Pi still owns the actual terminal.
const terminal = {
  get columns() { return currentReaderWidth(); },
  get rows() { return readerGeometry().current.height; },
  drainInput: (quietMs: number, maxMs: number) => processTerminal.drainInput(quietMs, maxMs),
};
let detailPaneId: string | undefined;
let inputStream = new PiDetailInputStreamDecoder();
const INPUT_IDLE_FLUSH_MS = 10;
let inputFlushTimer: ReturnType<typeof setTimeout> | undefined;
let inputGeneration = 0;
const tui = new DetailTuiAltScreen(processTerminal, false, undefined, {
  mouse: true,
  async copySelection(quote, renderedLines, selection) {
    const captured=focusedPreviewLayout().captureSelection(selection);
    // Menus, editors and other non-reader surfaces retain ordinary copy.
    const copied = captured?.text ?? copyRenderedSelection(renderedLines);
    if (copied) process.stdout.write(osc52ClipboardWrite(copied));
    const generation = ++directSelectionGeneration;
    const reader = focusedReader();
    directSelectionDocument = { reader, document: reader.state.document, text: reader.state.projectedSelectedText, file: reader.state.referencedFile };
    latestDirectSelection = null;
    const resourceCapture = captured
      ? reader.captureResourceSelection({...captured,text:copied},selection.sourceLines.join("\n"),generation)
      : null;
    const selected = focusedReader().state.context.selected;
    const socketPath = process.env.HERDR_SOCKET_PATH?.trim();
    const paneId = detailPaneId;
    const capturePromise = (async (): Promise<DetailDirectSelectionCapture | null> => {
      if (resourceCapture) return resourceCapture;
      if (captured && selected && paneId && copied) return {
        kind: "rendered",
        capture: {quote: copied, passage: captureAnnotationPassage({...captured, text: copied}),
          capturedAt: new Date().toISOString(), hostBlockId: selected.id, paneId,
          contentRevision: generation, contextId: browsingContextId, detailClientId: clientId,
          validation: "detail-pointer", snapshotText: selection.sourceLines.join("\n")},
      };
      if (!selected || !socketPath || !paneId) return null;
      try {
        const snapshot = await readHerdrPaneSnapshot(socketPath, paneId);
        if (!snapshot.text.includes(quote)) return null;
        return {
          kind: "rendered",
          capture: {
            quote,
            capturedAt: new Date().toISOString(),
            hostBlockId: selected.id,
            paneId,
            contentRevision: snapshot.revision,
            contextId: browsingContextId,
            detailClientId: clientId,
            validation: "detail-pointer",
            snapshotText: snapshot.text,
          },
        };
      } catch {
        return null;
      }
    })();
    pendingDirectSelection = capturePromise;
    const capture = await capturePromise;
    if (generation === directSelectionGeneration) {
      latestDirectSelection = capture;
      pendingDirectSelection = null;
    }
    return Boolean(copied);
  },
  openUrl(url) {
    if (recoveryReview) {
      if (url.startsWith("pi-outliner-action:recovery.")) void recoveryReview.action(url.slice("pi-outliner-action:recovery.".length));
      return;
    }
    const pointer = pendingLinkClick;
    pendingLinkClick = { activate: false, routing: "linked", suppress: false };
    if (pointer.suppress || stopping) return;
    if (actionMenuInvoke && url.startsWith("pi-outliner-action:")) { actionMenuInvoke(url.slice("pi-outliner-action:".length)); return; }
    serviceEventScheduler.scheduleWork(async () => {
      if (focusedReader().state.destinationChooser.active) {
        const recovery=url.startsWith('pi-outliner-action:')?destinationRecoveryKey(url.slice('pi-outliner-action:'.length)):null;
        await focusedReader().handleDestinationChooserKeypress(recovery?.str??"",recovery?.key??{name:"pointer"});
        return;
      }
      if (url.startsWith("pi-outliner-action:")) {
        await invokeDetailAction(url.slice("pi-outliner-action:".length));
        return;
      }
      if (url.startsWith("http://") || url.startsWith("https://")) {
        await focusedReader().dispatch({ type: "resource.open-url", url }, viewport());
        return;
      }
      const action = parseDetailPreviewActionUri(url);
      if (action) {
        const resolution = resolvePreviewPointerAction(action, pointer.activate);
        if (resolution.type === "focus") {
          await focusedReader().dispatch({type: "preview.focus.set", regionId: resolution.regionId}, viewport());
        } else {
          await readingSurface.activatePreviewAction(resolution.action, viewport(), resolution.routing);
        }
        return;
      }
      await focusedReader().dispatch({
        type: "reference.open",
        target: parseOutlinerLinkUri(url),
        routing: pointer.routing,
      }, viewport());
    });
  },
});
let stopping = false;
let externalEditorActive = false;
let watcher: OutlinerWatcher | null = null;
let runtimeSync: ClientRuntimeSync | null = null;
let workQueue = Promise.resolve();
const firstWatcherConnection = Promise.withResolvers<void>();
let runtimeInitialized = false;

type DetailDraftSplitFocus = "editor" | "preview";

let draftSplitFocus: DetailDraftSplitFocus = "editor";
let editorDragActive = false;
let renderedSelectionDragActive = false;

function draftSplitActive(): boolean {
  return controller.state.mode === "edit" &&
    terminal.columns >= DETAIL_DRAFT_SPLIT_MIN_WIDTH;
}

function viewport(reader: DetailController = controller): DetailViewport {
  const rectangle = reader === inspection ? readerGeometry().preview : readerGeometry().current;
  const width = rectangle.width;
  const editorUsesSplitWidth = width >= DETAIL_DRAFT_SPLIT_MIN_WIDTH &&
    reader.state.mode !== "file" &&
    reader.state.mode !== "comment";
  return {
    width,
    editorWidth: editorUsesSplitWidth
      ? detailDraftSplitWidths(width).editor
      : width,
    height: rectangle.height,
    editorBody: reader.state.mode === "comment"
      ? bufferComposerEditorBody(width)
      : undefined,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function openTargetInNewDetail(
  target: OutlinerNavigationTarget,
  direction: "right" | "down",
  targetPaneId?: string,
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
    targetPaneId,
    initialTarget: target,
  });
}

const effects: DetailEffects = {
  clientId,
  browsingContextId,
  enqueueViewUpdate: enqueueWork,
  focusSelf() {
    if (composed) focusRegion("detail");
    else if (process.env.HERDR_ENV === "1") focusCurrentPane();
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
    const invokingReader = focusedReader();
    const state = await client.request<NavigationLinkState>({action: "navigation.link.get", source: {clientId, region: "detail"}});
    const document = new NavigationDestinationPreview(client, () => tui.requestRender());
    let showOther = false;
    let placement: "right" | "down" | null = null;
    return new Promise<OutlinerViewAddress | null | undefined>(resolve => {
      const createDestination = async (placement: DetailDestinationPlacement) => {
        try {
          const initialTarget = invokingReader.state.target;
          if (!initialTarget) throw new Error("No target selected");
          await invokingReader.dispatch({type: "status.set", message: "Creating Detail · waiting for the new reader to connect…"}, viewport(invokingReader));
          resolve(await createDetailDestination(client, clientId, {workspaceRoot: paths.workspaceRoot, initialTarget, placement, timeoutMs: destinationTimeoutMs}));
        } catch (error) {
          invokingReader.onServiceError(error);
          resolve(undefined);
        }
      };
      const show = () => showActionMenu(placement ? navigationPlacementItems(state) : navigationDestinationItems(state, purpose === "link", showOther), async id => {
        if (id === "destination:other") { showOther = !showOther; show(); return; }
        if (id === "destination:place-right" || id === "destination:place-below") { placement = id === "destination:place-right" ? "right" : "down"; show(); return; }
        if (id === "placement:back") { placement = null; show(); return; }
        document.clear();
        if (id.startsWith("destination:sidebar-")) {
          const [, scope, side] = id.split("-") as [string, "outliner" | "tab", "left" | "right"];
          await createDestination({kind: "sidebar", scope, side});
        } else if (placement) {
          const targetPaneId = state.destinations[Number(id.slice(10))]?.placementPaneId;
          if (targetPaneId) await createDestination({kind: "split", direction: placement, targetPaneId});
          else { invokingReader.onServiceError(new Error("Selected placement pane is unavailable")); resolve(undefined); }
        } else if (id === "destination:new-right" || id === "destination:new-below") {
          await createDestination({kind: "split", direction: id === "destination:new-right" ? "right" : "down"});
        } else resolve(id === "destination:unlink" ? null : state.destinations[Number(id.slice(12))]?.view);
      }, undefined, () => { document.clear(); resolve(undefined); }, {
        purpose: placement ? "place" : purpose, status: () => placement ? navigationPlacementStatus(placement) : navigationDestinationStatus(state, purpose, showOther), preview: document,
        select: id => { void document.select(id ? state.destinations[Number(id.split(":")[1])] : undefined); },
      });
      show();
    });
  },
  async setDestination(destination) {
    const state = await client.request<NavigationLinkState>({action: "navigation.link.set", source: {clientId, region: "detail"}, destination});
    await destinationDisplay.refresh();
    return state.destinations.find(item => item.view.clientId === destination?.clientId && item.view.region === destination.region)?.label;
  },
  async setNavigationProtection(navigationProtection) {
    await client.request({action: "clients.update", clientId, navigationProtection});
  },
  async setCurrentTarget(currentTarget) {
    await client.request({ action: "clients.update", clientId, currentTarget });
  },
  dispatchNavigation(target, intent, options) {
    return dispatchNavigation(client, clientId, target, intent, {...options, sourceRegion: "detail"});
  },
  resolveNavigation(intent, options) {
    return resolveNavigationDestination(client, clientId, intent, {...options, sourceRegion: "detail"});
  },
  async resolveReferences(text) {
    return client.request<ResolvedBlockReferences>({ action: "references.resolve", text });
  },
  projectRead(text, hostBlockId, hostRevision) {
    return projectDetailRead(client, text, { hostBlockId, hostRevision });
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
  recovery: editRecovery,
  reviewRecovery: showRecoveryReview,
  editExternalDraft(input) {
    const configuration = resolveExternalEditorConfiguration();
    const expectedRevision = input.kind === "block"
      ? String(input.expectedRevision)
      : JSON.stringify(input.expectedRevision);
    const options: ExternalEditorOptions = {
      editor: configuration.editor,
      environment: configuration.environment,
      cwd: paths.workspaceRoot,
      suspendTerminal() {
        externalEditorActive = true;
        if (inputFlushTimer) {
          clearTimeout(inputFlushTimer);
          inputFlushTimer = undefined;
        }
        inputGeneration += 1;
        inputStream = new PiDetailInputStreamDecoder();
        tui.stop({ preserveScreen: true });
      },
      restoreTerminal() {
        try {
          tui.start();
          tui.requestRender(true);
          if (process.env.HERDR_ENV === "1") focusCurrentPane();
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
    };
    return input.kind === "block" ? editRecovery.files.edit(input,options) : editTextInExternalEditor({text:input.text,expectedRevision},options);
  },
  writeFilesystemResource(input) {
    return client.request<ResourceDescription>({
      action: "resources.write-filesystem",
      input,
      destinationClientId: clientId,
    });
  },

  confirmListItemRemoval(ids) {
    return new Promise(resolve => {
      showActionMenu(listItemRemovalMenu(ids), async id => {resolve(id === "remove");}, undefined, () => resolve(false), undefined, undefined, "Remove item addresses?");
    });
  },
  chooseChecklistAction() {
    return new Promise(resolve => {
      showActionMenu(checklistStatusMenu(), async id => {resolve(id as ChecklistChoice);}, undefined, () => resolve(undefined), undefined, undefined, "Checklist step");
    });
  },
  updateChecklist(blockId, input) {
    return client.request({action: "checklist.update", blockId, input, mutation: {author: "user", actorId: "detail"}});
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
    return client.request<Block>(detailRestoreRequest(blockId));
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
  async fragmentCandidates(query) {
    return client.request<FragmentCandidateCollection>({ action: "fragments.candidates", query });
  },
  async ensureFragment(input) {
    return client.request<{ fragmentId: string; created: boolean }>({ action: "fragments.ensure", ...input, mutation: { author: "user", actorId: "detail" } });
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
    if (composed) focusRegion("tree");
    else await focusTreeForClient(client, clientId);
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
    readerLabel: "linked Detail",
    previewHere: target => readingSurface.previewHere(target, viewport()),
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
}, () => synchronizeLayout?.(), {readerLabel: "linked Detail", actionKeymap, previewHere: target => readingSurface.previewHere(target, viewport()), openHere: target => readingSurface.openHere(target, viewport())});
const readingSurface = new DetailReadingSurface(controller, inspection, () => synchronizeLayout?.(), async () => {
  await client.request({action: "clients.update", clientId, previewTarget: null});
});
const focusedReader = () => readingSurface.active;
const focusedPreviewLayout = () => readingSurface.focused === "preview" && readingSurface.previewVisible ? inspectionLayout : preview;
const readingHelp = () => readingSurface.previewVisible ? `${actionKeymap.primaryBinding("detail.reading.focus")} Current/Preview  Alt+Enter Keep Preview  Esc close Preview  ` : "";
const currentLabel = () => `${readingSurface.focused === "current" ? "●" : "○"} Current${inspectionVisible && readerGeometry().arrangement === "switch" ? ` · Preview ready (${actionKeymap.primaryBinding("detail.reading.focus")})` : ""}`;

function focusRegion(region: OutlinerRegion): void {
  if (focusedRegion === region) return;
  focusedRegion = region;
  if (runtimeInitialized) enqueueWork(async () => { await client.request({action: "clients.update", clientId, focusedRegion}); });
  synchronizeLayout?.();
}

function requestStop(): void {
  if (composed && (controller.state.mode === "edit" || controller.state.mode === "comment" ||
      ["edit", "add-child", "add-sibling"].includes(composedTree!.controller.mode))) {
    controller.onServiceError(new Error("Finish or cancel the draft before closing the Outliner"));
    return;
  }
  void stop();
}

const localNavigation = composedTreeNavigation({
  client, clientId, contextId: browsingContextId, detail: {state: controller.state, handleUiCommand: (command, size) => readingSurface.receive(command, size)}, viewport,
  revealBlock: (blockId) => composedTree!.controller.revealBlock(blockId),
  schedulePreview: (task) => serviceEventScheduler.schedulePreview(task),
});
const composedTree: ComposedTree | null = composed ? new ComposedTree({
  viewPreferences,
  client, clientId, contextId: browsingContextId, workspaceRoot: paths.workspaceRoot,
  navigation: localNavigation, actionKeymap,
  width: () => composedTree?.controller.mode === "goto" ? processTerminal.columns : composedWidths(processTerminal.columns).tree,
  height: () => processTerminal.rows,
  focused: () => focusedRegion === "tree", focus: () => focusRegion("tree"),
  invalidate: () => { synchronizeLayout?.(); }, stop: requestStop,
  detach: openTargetInNewDetail,
}) : null;

function enqueueWork(task: () => void | Promise<void>): void {
  workQueue = workQueue.then(task).catch((error) => {
    controller.onServiceError(error);
  });
}
const serviceEventScheduler = new DetailEventScheduler({
  clientId,
  enqueue: enqueueWork,
  async handle(event) {
    if (!composedTree) return readingSurface.onServiceEvent(event, viewport());
    if (event.domain === "ui") {
      if (event.command?.targetClientId !== clientId) return;
      if (event.command.targetRegion === "tree") {
        await composedTree.controller.handleServiceEvent(event);
        focusRegion("tree");
      } else if (event.command.targetRegion === "detail") await readingSurface.onServiceEvent(event, viewport());
      else throw new Error("Composed UI commands require an explicit region");
      if (event.command.command !== "preview" && (!('focus' in event.command) || event.command.focus !== false) && process.env.HERDR_ENV === "1") focusCurrentPane();
      return;
    }
    if (event.domain === "attention" && event.attentionInstruction) {
      const region = event.attentionInstruction.targetRegion;
      await composedTree.controller.handleServiceEvent(region === "tree" ? event : {...event, attentionInstruction: undefined});
      await controller.onServiceEvent(region === "detail" ? event : {...event, attentionInstruction: undefined}, viewport());
      if (event.attentionInstruction.focus && process.env.HERDR_ENV === "1") focusCurrentPane();
      return;
    }
    await composedTree.controller.handleServiceEvent(event);
    await readingSurface.onServiceEvent(event, viewport());
  },
  supersedePreview: () => inspection.supersedePassivePreview(),
});

async function waitForService(): Promise<void> {
  try {
    await waitForCompatibleService(client, {
      timeoutMs: paths.mode === "remote" ? 30_000 : 5_000,
      pingTimeoutMs: paths.mode === "remote" ? 3_000 : 300,
      needed: detailServiceCapabilities(composed),
    });
  } catch (error) {
    throw new Error(`Compatible outliner service is not available: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function startWatcher(): void {
  let runtime: ReturnType<typeof currentPaneRuntime>;
  try {
    runtime = currentPaneRuntime();
  } catch (error) {
    console.error(errorMessage(error));
  }
  detailPaneId = runtime?.paneId;
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
      role: composed ? "composed" : "detail",
      ...(composed ? {focusedRegion} : {}),
      contextId: browsingContextId,
      runtime,
      resourcePresentation: TUI_RESOURCE_PRESENTATION_CONTEXT,
    },
    onConnect: async () => {
      void destinationDisplay.refresh();
      await runtimeSync?.synchronize();
      firstWatcherConnection.resolve();
      if (runtimeInitialized) {
        serviceEventScheduler.scheduleWork(async () => {
          await composedTree?.controller.handleConnect();
          await controller.onServiceConnect(viewport());
          await inspection.onServiceConnect(viewport());
          if (composed) await client.request({action: "clients.update", clientId, focusedRegion});
        });
      }
    },
    onDisconnect: () => {
      runtimeSync?.suspend();
      serviceEventScheduler.scheduleWork(() => { composedTree?.controller.handleDisconnect(); controller.onServiceDisconnect(); inspection.onServiceDisconnect(); });
    },
    onError: (error) => {
      if (!runtimeInitialized) firstWatcherConnection.reject(error);
      else serviceEventScheduler.scheduleWork(() => controller.onServiceError(error));
    },
    onEvent: (event) => { destinationDisplay.onEvent(event); serviceEventScheduler.schedule(event); },
  });
}

async function stop(exitCode = 0): Promise<void> {
  if (stopping) return;
  try {controller.checkpointRecovery();inspection.checkpointRecovery();}
  catch(error){controller.onServiceError(error);return;}
  await paneDisplay.stop();
  destinationDisplay.dispose();
  if (rightClickOwnership === "outliner") {
    try {
      configureCurrentPaneRightClick("herdr");
    } catch {
      // The pane is already closing; do not mask terminal restoration.
    }
  }
  stopping = true;
  provenanceInspector.dispose();
  provenanceInspectorHandle?.hide();
  keyInspector.dispose();
  keyInspectorHandle?.hide();
  composedTree?.dispose();
  if (inputFlushTimer) clearTimeout(inputFlushTimer);
  await runtimeSync?.stop();
  await watcher?.stop();
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
let actionMenuInvoke: ((id: string) => void) | null = null;
let actionMenuCancelled: (() => void) | undefined;
let composerHandle: OverlayHandle | null = null;
let keyInspectorHandle: OverlayHandle | null = null;
let keyInspectorGeometry = "";
const keyInspector = new KeyInspector({actionKeymap, invalidate: refreshKeyInspectorOverlay});
function refreshKeyInspectorOverlay(): void {
  const width = readerWidth(), height = processTerminal.rows;
  const column = composed ? composedWidths(processTerminal.columns).detailX : 0;
  const geometry = `${width}/${height}/${column}`;
  if (!keyInspector.active || geometry !== keyInspectorGeometry) {
    keyInspectorHandle?.hide(); keyInspectorHandle = null;
  }
  if (keyInspector.active && !keyInspectorHandle) {
    keyInspectorGeometry = geometry;
    keyInspectorHandle = tui.showOverlay({render: columns => keyInspector.render(columns, height), invalidate() {}},
      {width, maxHeight: height, row: 0, col: column, anchor: "top-left", margin: 0});
  }
  tui.requestRender();
}
function openKeyInspector(): void {
  closeActionMenu();
  inputGeneration++;
  if (inputFlushTimer) {clearTimeout(inputFlushTimer); inputFlushTimer = undefined;}
  keyInspector.open();
}

let provenanceInspectorHandle:OverlayHandle|null=null;
let provenanceInspectorGeometry="";
const provenanceInspector=new ProvenanceInspector(refreshProvenanceInspectorOverlay);
function refreshProvenanceInspectorOverlay():void {
  const width=readerWidth(),height=processTerminal.rows;
  const column=composed?composedWidths(processTerminal.columns).detailX:0;
  const geometry=`${width}/${height}/${column}`;
  if(!provenanceInspector.active||geometry!==provenanceInspectorGeometry){
    provenanceInspectorHandle?.hide();provenanceInspectorHandle=null;
  }
  if(provenanceInspector.active&&!provenanceInspectorHandle){
    provenanceInspectorGeometry=geometry;
    provenanceInspectorHandle=tui.showOverlay({render:columns=>provenanceInspector.render(columns,height),invalidate(){}},
      {width,maxHeight:height,row:0,col:column,anchor:"top-left",margin:0});
  }
  tui.requestRender();
}
function openProvenanceInspector():void {
  closeActionMenu();
  const captured=focusedPreviewLayout().provenanceSnapshot();
  if(!captured){void focusedReader().dispatch({type:"status.set",message:"No rendered document frame to inspect"},viewport(focusedReader()));return;}
  inputGeneration++;
  if(inputFlushTimer){clearTimeout(inputFlushTimer);inputFlushTimer=undefined;}
  provenanceInspector.open(captured.frame,captured.row);
}

function closeActionMenu(cancel = true): void {
  const cancelled = actionMenuCancelled;
  actionMenuCancelled = undefined;
  actionMenuHandle?.hide();
  actionMenuHandle = null;
  actionMenuInvoke = null;
  if (cancel) cancelled?.();
}

const actionMenuTheme: SelectListTheme = {
  selectedPrefix: (text) => `\x1b[36m${text}\x1b[0m`,
  selectedText: (text) => `\x1b[1m${text}\x1b[0m`,
  description: (text) => `\x1b[2m${text}\x1b[0m`,
  scrollInfo: (text) => `\x1b[2m${text}\x1b[0m`,
  noMatch: (text) => `\x1b[2m${text}\x1b[0m`,
};

interface DetailDestinationMenuOptions {
  purpose: "link" | "open" | "place"; status(): string; preview: NavigationDestinationPreview; select(id: string | undefined): void;
}

class FuzzyActionMenu implements Component {
  private query = "";
  private list: SelectList;
  private visibleRows: number | undefined;
  onSelect?: (actionId: string) => void;
  onCancel?: () => void;

  constructor(
    private readonly items: readonly OutlinerActionMenuItem[],
    private readonly maxVisible: number,
    private readonly destination?: DetailDestinationMenuOptions,
    private readonly changeMenu?: (delta: number) => void,
    private readonly decisionTitle?: string,
  ) {
    this.list = this.createList();
  }

  render(width: number): string[] {
    if (this.destination) return renderDetailDestinationPicker({
      width, height: Math.max(10, Math.floor(processTerminal.rows * 0.9)), purpose: this.destination.purpose,
      status: this.destination.status(), query: this.query,
      list: (columns, rows) => {
        const count = Math.max(1, rows - 1);
        if (this.visibleRows !== count) {
          const selected = this.list.getSelectedItem()?.value;
          this.visibleRows = count;
          this.list = this.createList(selected);
        }
        return this.list.render(columns).slice(0, rows);
      },
      preview: (columns, rows) => renderNavigationDestinationPreview(this.destination!.preview, columns, rows),
    });
    if (this.decisionTitle) {
      const selected = this.items.find(item => item.id === this.list.getSelectedItem()?.value);
      return [this.decisionTitle, "", ...this.list.render(width), "",
        ...wrapTextWithAnsi(sanitizeDynamicText(selected?.description ?? ""), Math.max(1, width)), "",
        ...wrapTextWithAnsi("↑↓ choose · Enter confirms · Esc cancels", Math.max(1, width))]
        .map(line => truncateToWidth(line, width, "", true));
    }
    return [
      `\x1b[2mFind: ${this.query}▏\x1b[0m`,
      ...this.list.render(width),
    ];
  }

  handleInput(data: string): void {
    if (this.changeMenu && (matchesKey(data, Key.left) || matchesKey(data, Key.right))) {
      this.changeMenu(matchesKey(data, Key.right) ? 1 : -1); return;
    }
    if (matchesKey(data, Key.backspace)) {
      this.updateQuery([...this.query].slice(0, -1).join(""));
      return;
    }
    const printable = decodeKittyPrintable(data) ??
      (data.length === 1 && data >= " " && data !== "\x7f" ? data : undefined);
    if (printable !== undefined && !this.decisionTitle) {
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

  private createList(selected?: string): SelectList {
    const filtered = filterActionMenuItems(this.items, this.query);
    const list = new SelectList(
      filtered.map((item) => ({
        value: item.id,
        label: outlinerActionLink(item.id, this.destination || this.decisionTitle ? item.label : actionMenuItemText(item)),
        description: this.decisionTitle ? undefined : item.description,
      })),
      Math.min(this.visibleRows ?? this.maxVisible, Math.max(1, filtered.length)),
      actionMenuTheme,
    );
    if (selected) list.setSelectedIndex(Math.max(0, filtered.findIndex(item => item.id === selected)));
    list.onSelect = (item) => this.onSelect?.(item.value);
    list.onCancel = () => this.onCancel?.();
    list.onSelectionChange = item => this.destination?.select(item.value);
    this.destination?.select(list.getSelectedItem()?.value);
    return list;
  }
}

let recoveryReview: EditRecoveryReview | null = null;
let recoveryInputDecoder = new EditRecoveryInput();
function showRecoveryReview(records:EditRecovery[]):Promise<RecoveryChoice> {
  recoveryInputDecoder.dispose();recoveryInputDecoder=new EditRecoveryInput();
  closeActionMenu();
  return new Promise(resolve=>{
    recoveryReview = new EditRecoveryReview(records,editRecovery,()=>tui.requestRender(),choice=>{
      recoveryInputDecoder.dispose();recoveryReview=null;closeActionMenu();tui.requestRender();resolve(choice);
    },editRecovery.warnings);
    actionMenuHandle=tui.showOverlay({
      render:width=>recoveryReview?.render(width,Math.max(8,processTerminal.rows))??[],
      invalidate() {},
    },{width:"100%",maxHeight:"100%",anchor:"center",margin:0});
  });
}

function showActionMenu(
  items: readonly OutlinerActionMenuItem[],
  invoke: (actionId: string) => Promise<void>,
  origin?: TreeMouseClick,
  cancelled?: () => void,
  destination?: DetailDestinationMenuOptions,
  changeMenu?: (delta: number) => void,
  decisionTitle?: string,
): void {
  closeActionMenu();
  tui.releasePointerGesture();
  actionMenuCancelled = cancelled;
  const menu = new FuzzyActionMenu(items, destination ? 7 : 13, destination, changeMenu, decisionTitle);
  menu.onSelect = (actionId) => {
    closeActionMenu(false);
    if (cancelled) void invoke(actionId);
    else serviceEventScheduler.scheduleWork(() => invoke(actionId));
  };
  actionMenuInvoke = menu.onSelect;
  menu.onCancel = () => {
    closeActionMenu();
    tui.requestRender();
  };
  actionMenuHandle = tui.showOverlay(menu, {
    width: decisionTitle ? "100%" : destination ? "95%" : "70%",
    maxHeight: destination ? "90%" : "70%",
    minWidth: decisionTitle ? 1 : 32,
    anchor: "top-right",
    ...(origin ? { row: origin.row, col: origin.column } : {}),
    margin: { top: 1, right: decisionTitle ? 0 : 1 },
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
  return detailActionScopes(focusedReader().state, {
    bufferMode: focusedReader().isBufferMode(),
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
  const reader = focusedReader();
  const layout = focusedPreviewLayout();
  const rectangle = reader === inspection ? readerGeometry().preview : readerGeometry().current;
  if (reader.state.mode !== "select") {
    renderedSelectionDragActive = false;
    return false;
  }
  const pointer = parseTreePrimaryPointer(data);
  if (!pointer || pointer.meta || pointer.ctrl) return false;
  let row = pointer.row - rectangle.y;
  if (renderedSelectionDragActive && pointer.phase !== "down") {
    const bodyTop = layout.headerHeight(rectangle.width);
    const bodyBottom = rectangle.height - layout.footerHeight(rectangle.width) - 1;
    if (row < bodyTop) {
      layout.navigate("up");
      row = bodyTop;
    } else if (row > bodyBottom) {
      layout.navigate("down");
      row = bodyBottom;
    }
  }
  const point = layout.sourcePointAtViewport(
    row,
    pointer.column - rectangle.x,
    rectangle.width,
  );
  if (!point) {
    if (pointer.phase === "up") renderedSelectionDragActive = false;
    return true;
  }
  if (pointer.phase === "down") {
    renderedSelectionDragActive = true;
    await reader.dispatch({
      type: "annotation.selection.place",
      ...point,
      extend: false,
    }, viewport(reader));
    return true;
  }
  if (!renderedSelectionDragActive) return true;
  await reader.dispatch({
    type: "annotation.selection.place",
    ...point,
    extend: true,
  }, viewport(reader));
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
  if(controller.state.completion){
    const uri=treeLinkAtClick(renderDetailLines(controller.state,{width:mouseLayout.editorWidth,height:mouseLayout.height}),data);
    const choice=uri?.match(/^pi-outliner-action:completion\.choose:(\d+):(\d+)$/);
    if(choice){editorDragActive=false;await controller.dispatch({type:"completion.choose",index:Number(choice[1]),generation:Number(choice[2])},viewport());return true;}
  }
  const wheel = parseTreeWheelEvent(data);
  if (wheel) {
    editorDragActive = false;
    const region = detailMouseRegionAt(wheel, mouseLayout);
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
  if (actionMenuHandle) return true;
  const linkClick = piDetailLinkClick(data);
  if (linkClick) pendingLinkClick = linkClick;
  const pointer = parseTreePrimaryPointer(data);
  if (pointer && !pointer.meta && !pointer.ctrl) {
    if (pointer.phase === "down") {
      retireDirectSelection();
    }

  }
  if (
    focusedReader().state.destinationChooser.active &&
    detailChooserOwnsPiInput(data)
  ) return false;
  if (actionMenuHandle) return true;
  if (composerHandle) return false;
  if (focusedReader().state.mode === "select" && parseTreePrimaryPointer(data)) return false;
  if (readingSurface.active === inspection && isTreeMouseSequence(data)) return true;
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
  synchronizeLayout?.();
  return true;
}

async function directSelectionCapture(reader: DetailController): Promise<DetailDirectSelectionCapture | null> {
  const generation = directSelectionGeneration;
  if (directSelectionDocument?.reader !== reader) return null;
  const capture = latestDirectSelection ?? await pendingDirectSelection;
  const target = reader.state.target;
  if (generation !== directSelectionGeneration || !capture || !target) {
    throw new Error("The selected passage could not be captured; select it again, or clear the selection to comment on the whole note");
  }
  if (capture.kind === "rendered") {
    if (target.kind === "block" && target.blockId === capture.capture.hostBlockId) return capture;
  } else if (target.kind === "resource" && target.resourceId === capture.resourceId) return capture;
  throw new Error("The selection belongs to another document; select the passage again");
}

const handleKeypress = createDetailKeyHandler({openNewTree: () => { openTreePane({workspaceRoot: paths.workspaceRoot, root: null, direction: "right"}); },
  controller,
  viewport,
  stop: requestStop,
  actionKeymap,
  openActionMenu: items => showActionMenu(items, invokeDetailAction),
  openKeyInspector,
  openProvenanceInspector,
  focusDraftSplit,
  navigatePreview,
  previewFocused: () => draftSplitActive() && draftSplitFocus === "preview",
  annotationSelectionSourceLine: () => preview.sourceLineAtScroll(terminal.columns),
  directSelectionCapture: () => directSelectionCapture(controller),
});

const inspectionKeypress = createDetailKeyHandler({openNewTree: () => { openTreePane({workspaceRoot: paths.workspaceRoot, root: null, direction: "right"}); },controller: inspection, viewport: () => viewport(inspection), stop: () => { void readingSurface.closePreview(); }, actionKeymap,
  openActionMenu: items => showActionMenu(items, invokeDetailAction),
  openKeyInspector,
  openProvenanceInspector,
  navigatePreview: direction => inspectionLayout.navigate(direction),
  annotationSelectionSourceLine: () => inspectionLayout.sourceLineAtScroll(viewport(inspection).width),
  directSelectionCapture: () => directSelectionCapture(inspection),
});
function showReaderMenu(menu: ReaderMenu): void {
  const items = readerMenuItems(actionKeymap.menuItems("detail", activeDetailActionScopes()), menu).map(item =>
    item.id === "detail.navigation.link" ? {...item, label: `Opens in: ${destinationDisplay.text} · Change`} : item);
  showActionMenu(items, invokeDetailAction, undefined, undefined, undefined, delta => showReaderMenu(adjacentReaderMenu(menu,delta)));
}

async function readerAction(actionId: string): Promise<boolean> {
  const menu = readerMenuFromAction(actionId);
  if (menu) { showReaderMenu(menu); return true; }
  if (actionId.startsWith("detail.density.")) {
    const value = actionId.slice("detail.density.".length);
    if (value !== "compact" && value !== "expanded") return true;
    try {
      const geometry = readerGeometry();
      preview.preserveReadingPosition(geometry.current.width, geometry.current.height, () => {
        if (readingSurface.previewVisible) inspectionLayout.preserveReadingPosition(geometry.preview.width, geometry.preview.height, () => viewPreferences.setDensity(value));
        else viewPreferences.setDensity(value);
      });
      synchronizeLayout?.();
    }
    catch (error) { readingSurface.active.onServiceError(error); }
    return true;
  }
  if (actionId === "detail.location") {
    const state = readingSurface.active.state;
    showActionMenu(state.context.ancestors.map(block => ({id: `location:${block.id}`, label: block.text.split(/\r?\n/)[0] ?? block.id,
      description: "Open this ancestor", binding: "", group: "Navigate"})), async id => {
        await readingSurface.active.dispatch({type:"reference.open",target:{kind:"block",value:id.slice("location:".length)},routing:"linked"}, viewport(readingSurface.active));
      });
    return true;
  }

  if (actionId === "detail.reading.focus") { readingSurface.toggleFocus(); return true; }
  if (actionId === "detail.reading.close") { await readingSurface.closePreview(); return true; }
  if (actionId === "detail.reading.keep") { await readingSurface.keepPreview(viewport()); return true; }
  if (readingSurface.active === inspection && (actionId === "detail.annotation.reply" || actionId === "detail.annotation.lifecycle")) {
    const annotationId = inspection.state.selectedAnnotationId;
    if (!annotationId) { inspection.onServiceError(new Error("Select a comment before replying or resolving")); return true; }
    await readingSurface.activatePreviewAction({type: actionId === "detail.annotation.reply" ? "annotation.thread.reply" : "annotation.thread.lifecycle", annotationId}, viewport(inspection));
    return true;
  }
  if (readingSurface.active === inspection && ["detail.edit.begin", "detail.edit.external", "detail.edit.recover"].includes(actionId)) {
    if (!await readingSurface.keepPreview(viewport())) return true;
    await handleKeypress.invoke(actionId);
    return true;
  }
  return false;
}
invokeDetailAction = async (actionId) => {
  closeActionMenu();
  if (await readerAction(actionId)) return;
  await (readingSurface.active === inspection ? inspectionKeypress : handleKeypress).invoke(actionId);
};

async function handleDecodedInput(input: PiDetailInput): Promise<void> {
  if (focusedReader().state.destinationChooser.active) {
    if (
      input.kind === "key" &&
      input.inputAction !== "suppress" &&
      input.key.ctrl &&
      input.key.name === "q"
    ) {
      requestStop();
      return;
    }
    pendingLinkClick = { activate: false, routing: "linked", suppress: false };
    const forwarded = piDetailChooserInput(input);
    await focusedReader().handleDestinationChooserKeypress(forwarded.str, forwarded.key);
    return;
  }
  if (input.kind === "paste") {
    if (focusedReader().isBufferMode()) {
      await focusedReader().dispatch({ type: "buffer.insert", text: input.text }, viewport(focusedReader()));
    }
    return;
  }

  if (input.inputAction !== "suppress" && input.key.name === "escape" && await readingSurface.escapePreview()) return;
  const resolved = actionKeymap.resolve("detail", activeDetailActionScopes(), input.str, input.key);
  if (resolved.actionId && await readerAction(resolved.actionId)) return;
  await (readingSurface.active === inspection ? inspectionKeypress : handleKeypress)(input.str, input.key, input.inputAction);
}

async function handleInput(data: string): Promise<void> {
  if (readingSurface.active === inspection) {
    if (await handleRenderedSelectionMouse(data)) return;
    for (const input of inputStream.push(data)) await handleDecodedInput(input);
    return;
  }
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

async function flushInput(): Promise<void> {
  for (const input of inputStream.flush()) await handleDecodedInput(input);
}

function scheduleInputFlush(): void {
  inputGeneration += 1;
  const generation = inputGeneration;
  if (inputFlushTimer) clearTimeout(inputFlushTimer);
  inputFlushTimer = setTimeout(() => {
    inputFlushTimer = undefined;
    serviceEventScheduler.scheduleWork(() => {
      if (generation === inputGeneration && !stopping && !keyInspector.active && !provenanceInspector.active && !composedTree?.keyInspectorActive) return composedTree && focusedRegion === "tree" ? composedTree.flushInput() : flushInput();
    });
  }, INPUT_IDLE_FLUSH_MS);
}

const customFrame = new DetailPiComponent({
  state: controller.state,
  height: () => terminal.rows,
  header: () => {
    const propertyKeys = detailHeaderPropertyKeys;
    const destinationLabel = destinationDisplay.text;
    if (!draftSplitActive()) return { surface: currentLabel(), propertyKeys, destinationLabel, ...(composed ? {focused: focusedRegion === "detail"} : {}) };
    const focused = (!composed || focusedRegion === "detail") && draftSplitFocus === "editor";
    const linked = controller.state.draftPreviewLinked ? "↔ " : "";
    return {
      surface: `${linked}${focused ? "●" : "○"} Edit${inspectionVisible && readerGeometry().arrangement === "switch" ? ` · Preview ready (${actionKeymap.primaryBinding("detail.reading.focus")})` : ""}`,
      focused,
      propertyKeys,
      destinationLabel,
    };
  },
  helpText: () => `${readingHelp()}${composed ? "F6 Tree  " : ""}${actionKeymap.helpText("detail", activeDetailActionScopes())}`,
});
const preview = new DetailPiPreviewLayout(
  controller.state,
  getMarkdownTheme(),
  hyperlinksEnabled,
  () => tui.requestRender(),
  {
    calloutTheme: calloutThemeResolution.theme,
    density: () => viewPreferences.density,
    titleInFrame: () => paneDisplay.inFrame && !composed,
    headerPropertyKeys: detailHeaderPropertyKeys,
    destinationLabel: () => destinationDisplay.text,
    draftText: () => draftSplitActive() ? controller.state.buffer.text : null,
    projectDraft(source) { return loadDetailDraftPreview(client,source); },
    ...(composed ? {primaryFocused: () => focusedRegion === "detail"} : {}),
    splitActive: draftSplitActive,
    focused: () => (!composed || focusedRegion === "detail") && draftSplitFocus === "preview",
    surfaceLabel: currentLabel,
    helpText: () => `${readingHelp()}${composed ? "F6 Tree  " : ""}${actionKeymap.helpText("detail", activeDetailActionScopes())}`,
    chooserHelpText: () => controller.destinationChooserHelpText(),
    setRegions: (regions) => controller.setPreviewRegions(regions),
  },
);
const draftSplit = new DetailPiDraftSplitLayout(customFrame, preview);
const inspectionLayout = new DetailPiPreviewLayout(inspection.state, getMarkdownTheme(), hyperlinksEnabled, () => tui.requestRender(), {
  calloutTheme: calloutThemeResolution.theme,
  density: () => viewPreferences.density,
  destinationLabel: () => destinationDisplay.text,
  surfaceLabel: () => `${readingSurface.focused === "preview" ? "●" : "○"} Preview`,
  helpText: () => `${readingHelp()}${actionKeymap.helpText("detail", detailActionScopes(inspection.state))}`,
  chooserHelpText: () => inspection.destinationChooserHelpText(),
  setRegions: regions => inspection.setPreviewRegions(regions),
});
const readerSplit = new DetailReaderSplitLayout(preview, inspectionLayout);
const readerVertical = new DetailReaderVerticalLayout(preview, inspectionLayout);

const composer = new BufferComposer(() => {
  const reader = focusedReader();
  const reply = reader.state.annotationReplyDraft;
  const thread = reply ? reader.state.annotationThreads.find(thread => thread.block.id === reply.annotationId) : null;
  const target = reader.state.annotationDraft?.target;
  const context = target?.anchor.kind === "text-quote"
    ? target.anchor.exact
    : target?.anchor.kind === "dom-range"
      ? target.anchor.exact
      : target?.anchor.kind === "pdf-page-region"
        ? target.anchor.exact ?? ""
        : "";
  return {
    title: reply ? "Reply to comment" : target?.referenceContext
      ? "Comment on this reference"
      : target?.anchor.kind === "whole-subject"
      ? "Comment on whole note"
      : target?.representation.subject.kind === "resource"
      ? "Comment on Resource selection"
      : "Comment on selection",
    context: thread?.body ?? (target?.anchor.kind === "whole-subject" ? detailTitle(reader.state) : context),
    buffer: reader.state.buffer,
    placeholder: reply ? "Write a reply…" : "Write a comment…",
    commitAction: "Ctrl+S",
    cancelAction: "Esc",
    viewportOffset: reader.state.editorVisualOffset,
    status: reader.state.status,
  };
});
let layoutRoot: Component | undefined;
let previousMode = controller.state.mode;
const composedLayout = composedTree ? new ComposedLayout(composedTree, preview, () => processTerminal.columns) : null;
let composerGeometry = "";

synchronizeLayout = () => {
  paneDisplay.update(detailTitle(controller.state));
  // A retained quote is convenience state, never a navigation lock. A new
  // document retires both completed and in-flight captures before they can be reused.
  if (directSelectionDocument && (directSelectionDocument.reader.state.document !== directSelectionDocument.document ||
    directSelectionDocument.reader.state.projectedSelectedText !== directSelectionDocument.text ||
    directSelectionDocument.reader.state.referencedFile !== directSelectionDocument.file)) {
    retireDirectSelection();
  }
  inspectionVisible = readingSurface.previewVisible;
  const mode = controller.state.mode;
  if (mode !== previousMode) editorDragActive = false;
  if ((mode === "edit" || mode === "select") && mode !== previousMode) {
    draftSplitFocus = "editor";
  }
  previousMode = mode;

  const split = draftSplitActive();
  const previewActive = mode === "preview" || mode === "select" ||
    mode === "comment" || split;
  preview.setActive(previewActive);

  let previewWidth = readingSurface.previewVisible ? readerGeometry().current.width : terminal.columns;
  if (split) {
    draftSplit.setWidth(terminal.columns);
    previewWidth = detailDraftSplitWidths(terminal.columns).preview;
  }
  if (previewActive) {
    preview.syncState(previewWidth);
    preview.applyPendingFragmentScroll(previewWidth);
    if (!split && mode === "preview") {
      preview.ensureFocusVisible(previewWidth,readerGeometry().current.height);
    }
  }

  composedLayout?.resize();
  const active = focusedReader();
  const rectangle = active === inspection ? readerGeometry().preview : readerGeometry().current;
  const composerCol = rectangle.x + (composed ? composedWidths(processTerminal.columns).detailX : 0);
  const composerRow = rectangle.y + Math.max(0, rectangle.height - BUFFER_COMPOSER_HEIGHT);
  const geometryKey = `${composerCol}:${composerRow}:${rectangle.width}:${rectangle.height}`;
  if (composerHandle && (composerGeometry !== geometryKey || active.state.mode !== "comment")) {
    composerHandle.hide();
    composerHandle = null;
  }
  if (active.state.mode === "comment" && !composerHandle) {
    composerGeometry = geometryKey;
    composerHandle = tui.showOverlay(composer, {
      width: rectangle.width,
      col: composerCol,
      maxHeight: Math.min(rectangle.height, BUFFER_COMPOSER_HEIGHT),
      row: composerRow,
      anchor: "top-left",
      nonCapturing: true,
    });
  }

  let nextRoot: Component;
  if (split) nextRoot = draftSplit;
  else if (previewActive) nextRoot = preview;
  else nextRoot = customFrame;

  inspectionLayout.setActive(readingSurface.previewVisible);
  if (readingSurface.previewVisible) {
    const geometry = readerGeometry();
    const inspectionWidth = geometry.preview.width;
    inspectionLayout.syncState(inspectionWidth);
    inspectionLayout.applyPendingFragmentScroll(inspectionWidth);
    inspectionLayout.ensureFocusVisible(inspectionWidth,geometry.preview.height);
    if (geometry.arrangement === "beside") {
      readerSplit.setLayout(nextRoot, readerWidth());
      nextRoot = readerSplit;
    } else if (geometry.arrangement === "below") {
      readerVertical.setLayout(nextRoot, processTerminal.rows);
      nextRoot = readerVertical;
    } else if (readingSurface.focused === "preview") nextRoot = inspectionLayout;
  }

  if (nextRoot !== layoutRoot) {
    layoutRoot = nextRoot;
    if (composedLayout) composedLayout.setDetail(nextRoot);
  }
  tui.setLayoutRoot(composedTree && (composedTree.controller.mode === "goto" || composedTree.keyInspectorActive) ? composedTree : composedLayout ?? nextRoot);
  tui.requestRender();
};
synchronizeLayout();

const detailInputListener = createPiDetailInputListener(
  data => {
    if (!stopping) { serviceEventScheduler.scheduleWork(() => handleInput(data)); scheduleInputFlush(); }
  },
  data => shouldPassDetailInputToTui(data),
);
let composedViewerDrag=false;
tui.addOutlinerInputListener(data => {
  if (recoveryReview) {
    const wheel=parseTreeWheelEvent(data);
    if(wheel){recoveryReview.key("",{name:wheel.direction==="up"?"up":"down"});return {consume:true};}
    if(isTreeMouseSequence(data))return;
    recoveryInputDecoder.accept(data,decoded=>recoveryReview?.key(decoded.str,decoded.key));
    return {consume:true};
  }

  // Inspect delivered bytes before focus routing, native overlays, or our decoders.
  if(provenanceInspector.handle(data,composed?composedWidths(processTerminal.columns).detailX:0))return {consume:true};
  if (keyInspector.handle(data)) return {consume: true};
  if (composedTree?.keyInspectorActive) {
    serviceEventScheduler.scheduleWork(() => composedTree.handleInput(data));
    return {consume: true};
  }
  const detailPointer = parseTreePrimaryPointer(data);
  if (composedTree && !actionMenuHandle && detailPointer) {
    if (detailPointer.phase === "down") composedViewerDrag = detailPointer.column < composedWidths(processTerminal.columns).tree &&
      composedTree.controller.mode === "viewer" && !!composedTree.controller.view().workspaceReport;
    if (composedViewerDrag) {
      if (detailPointer.phase === "up") composedViewerDrag = false;
      serviceEventScheduler.scheduleWork(async () => {
        if(detailPointer.phase === "down")focusRegion("tree");
        await composedTree.handleInput(data);
      });
      return {consume:true};
    }
  }
  if (!actionMenuHandle && detailPointer?.phase === "down" && readingSurface.previewVisible && ["beside", "below"].includes(readerGeometry().arrangement)) {
    const detailColumn = detailPointer.column - (composed ? composedWidths(processTerminal.columns).detailX : 0);
    if (detailColumn >= 0) {
      const rect = readerGeometry().preview;
      readingSurface.focused = detailColumn >= rect.x && detailPointer.row >= rect.y ? "preview" : "current";
      synchronizeLayout?.();
    }
  }
  if (!composedTree) return detailInputListener(data);
  if (composedTree.controller.mode === "goto") {
    serviceEventScheduler.scheduleWork(() => composedTree.handleInput(data));
    scheduleInputFlush();
    return { consume: true };
  }
  const pointer = composedPointer(data, processTerminal.columns);
  if (!pointer && !actionMenuHandle) {
    // Keys are already split by Pi. Choose their region when they execute, after
    // earlier keys have changed focus, not while they are entering the queue.
    serviceEventScheduler.scheduleWork(async () => {
      if (matchesKey(data, "f6")) focusRegion(focusedRegion === "tree" ? "detail" : "tree");
      else if (focusedRegion === "tree" && !controller.state.destinationChooser.active) await composedTree.handleInput(data);
      else await handleInput(data);
    });
    scheduleInputFlush();
    return {consume: true};
  }
  if (pointer && !actionMenuHandle) serviceEventScheduler.scheduleWork(() => focusRegion(pointer.region));
  if ((pointer?.region ?? focusedRegion) === "tree" && !actionMenuHandle && !controller.state.destinationChooser.active) {
    serviceEventScheduler.scheduleWork(() => composedTree.handleInput(pointer?.data ?? data));
    return {consume: true};
  }
  // Our editor/selection code uses local coordinates; native Pi selection sees
  // the unchanged whole-terminal event after this listener returns.
  return detailInputListener(pointer?.data ?? data);
});

function handleResize(): void {
  if (keyInspector.active) refreshKeyInspectorOverlay();
  if(provenanceInspector.active)refreshProvenanceInspectorOverlay();
  serviceEventScheduler.scheduleWork(async () => {
    await controller.dispatch({ type: "viewport.changed" }, viewport());
    if (readingSurface.previewVisible) await inspection.dispatch({ type: "viewport.changed" }, viewport(inspection));
  });
}

async function initialize(): Promise<void> {
  await waitForService();
  startWatcher();
  await firstWatcherConnection.promise;
  await controller.initialize();
  await composedTree?.controller.initialize();
  runtimeInitialized = true;
  await controller.onServiceConnect(viewport());
  await inspection.onServiceConnect(viewport());
}

try {
  await initialize();
} catch (error) {
  console.error(errorMessage(error));
  process.exit(1);
}

process.on("SIGINT", () => {
  if (!externalEditorActive) void stop();
});
process.on("SIGTERM", () => void stop());
process.on("SIGHUP", () => void stop());
process.stdout.on("resize", handleResize);

tui.start();
