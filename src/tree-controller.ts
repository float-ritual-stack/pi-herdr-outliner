import type {DetailDestinationPlacement} from "./detail-pane-placement";
import type {OutlinerViewAddress} from "./types";
import {DocumentPreview, type DocumentPreviewState} from './document-preview';
import {treePreviewFrame, defaultPreviewPreferences, type PreviewPreferences} from './tree-preview';
import type { RequestInput } from "./client";
import {
  decodeAuthoredLinksSnapshot,
} from "./authored-links";
import { emptyAttentionState } from "./attention";
import { GotoController } from "./goto-controller";
import { handleGotoMouse as routeGotoMouse } from "./goto-renderer";
import { InboxController } from "./inbox-controller";
import { inboxStatusCue } from "./inbox-renderer";
import {
  filterCompletionTargetAtCursor,
  parsePropertyFilterExpression,
  serializePropertyFilterValue,
} from "./block-query";
import {
  completionTargetAtCursor,
  pageAddressCompletion,
  pageCompletionLookupQuery,
} from "./completion";
import { referencedFilePreview, type FileContents, type ReferencedPathCandidate } from "./files";
import { getProperty } from "./properties";
import {
  firstOutlinerReference,
  resolveOutlinerLinkTarget,
} from "./outliner-links";
import { blockDisplayTitle } from "./references";
import {
  DEFAULT_OUTLINER_ACTION_KEYMAP,
  displayActionChord,
  filterActionMenuItems,
  type OutlinerActionKeymap,
  type OutlinerActionMenuItem,
} from "./outliner-actions";
import { navigationDestinationItems, navigationPlacementItems, navigationPlacementStatus, navigationDestinationStatus, NavigationDestinationPreview, NavigationDestinationDisplay } from "./navigation-destination-menu";
import type { TreeNavigation, NavigationRouteOptions } from "./navigation-routes";
import {
  historyNavigationDirection,
  isDetailToggle,
  isPrintableInput,
  type TerminalInputAction,
  type TerminalKey,
} from "./terminal";
import {
  authoredLinkActivation,
  authoredLinkCanOpen,
  authoredLinkFallbackRowIds,
  authoredLinkHeaderRowId,
  authoredLinkTarget,
  authoredLinkUnavailableReason,
  composeAuthoredLinkRows,
  isBlockTreeRow,
  type AuthoredLinksPanel,
  type AuthoredLinkHeaderRow,
  type TreeDisplayRow as ProjectedDisplayRow,
} from "./tree-rows";
import { isVirtualBranchDefinition } from "./virtual-branches";
import { TextBuffer } from "./text-buffer";
import type {
  AttentionClientState,
  Block,
  BookmarkStatus,
  BookmarkToggleReceipt,
  BlockCollectionCompleteness,
  InternResourceReceipt,
  OutlinerEvent,
  OutlinerNavigationIntent,
  NavigationLinkState,
  OutlinerNavigationTarget,
  PageAddressCollection,
  PropertyCatalogItem,
  TreeIndexBlock,
  TreeIndexCollection,
  TreeIndexSnapshot,
  ResolvedBlockReferences,
} from "./types";
import {
  buildVirtualBranchCreationText,
  isVirtualBranchOccurrence,
  isVirtualBranchRootOccurrence,
  projectVirtualBranches,
  type PhysicalTreeRow as ProjectedPhysicalRow,
  type TreeRow as ProjectedTreeRow,
  type VirtualBranchOccurrenceRow as ProjectedOccurrenceRow,
  type VirtualBranchState,
  type TreePresentationState,
} from "./virtual-branches";

type TreeRow = ProjectedTreeRow<TreeIndexBlock>;
type PhysicalTreeRow = ProjectedPhysicalRow<TreeIndexBlock>;
type VirtualBranchOccurrenceRow = ProjectedOccurrenceRow<TreeIndexBlock>;
type TreeDisplayRow = ProjectedDisplayRow<TreeIndexBlock>;

export interface ExpandedTreeDocument {
  readonly block: Block;
  readonly resolved: ResolvedBlockReferences;
}

export type TreeInputMode =
  | "edit"
  | "add-child"
  | "add-sibling"
  | "filter"
  | "goto"
  | "purge";
export type TreeMode = "browse" | "delete" | "viewer" | "action-menu" | "inbox" | TreeInputMode;

export interface TreeQuickCompletionItem {
  readonly label: string;
  readonly insertion: string;
  readonly blockId?: string;
}

export interface TreeQuickCompletion {
  readonly start: number;
  readonly end: number;
  readonly index: number;
  readonly truncatedLimit: number | null;
  readonly items: readonly TreeQuickCompletionItem[];
}

export interface TreeRoot { readonly rowId: string; readonly canonicalId: string; readonly label: string }

export interface TreeView {
  readonly root?: TreeRoot | null;
  readonly breadcrumbs?: readonly (TreeRoot & {kind:"physical"|"occurrence"})[];
  readonly breadcrumbStart?: number | null;
  readonly indentationMode?: "viewport" | "selection";
  readonly scrollStartEntryIndex?: number;
  readonly workspaceRoot: string;
  readonly rows: readonly TreeDisplayRow[];
  readonly physicalBlocksById: ReadonlyMap<string, TreeIndexBlock>;
  readonly expandedDocuments: ReadonlyMap<string, ExpandedTreeDocument>;
  readonly physicalRowCount: number;
  readonly occurrenceRowCount: number;
  readonly workIdPrefix: string | null;
  readonly visibleCompleteness: BlockCollectionCompleteness;
  readonly branchStates: ReadonlyMap<string, VirtualBranchState>;
  readonly workspaceContextBlockId: string | null;
  readonly selectedIndex: number;
  readonly activeFilter: string;
  readonly mode: TreeMode;
  readonly quickInput: string;
  readonly quickColumn: number;
  readonly quickCompletion: TreeQuickCompletion | null;
  readonly goto?: GotoController | null;
  readonly inbox?: InboxController | null;
  readonly inboxCue?: string;
  readonly localPreview?: DocumentPreviewState | null;
  readonly previewHelp?: string;
  readonly previewPreferences?: PreviewPreferences;
  readonly viewerLines: readonly string[];
  readonly viewerPath: string;
  readonly viewerOffset: number;
  readonly expandedBlockOffset: number;
  readonly status: string;
  readonly refreshPending: boolean;
  readonly actionHelpText?: string;
  readonly actionMenuItems?: readonly OutlinerActionMenuItem[];
  readonly actionMenuIndex?: number;
  readonly actionMenuOrigin?: { column: number; row: number } | null;
  readonly attention: AttentionClientState;
  readonly actionMenuQuery?: string;
  readonly destinationPreview?: NavigationDestinationPreview;
  readonly destinationInstructions?: string;
  readonly destinationPurpose?: "link" | "open" | "place";
  readonly navigationDestinationLabel?: string;
}

export interface TreeControllerEffects {
  readonly initialRoot?: TreeRoot;
  createTreePane?(root: TreeRoot | null, direction: "right" | "down"): Promise<void>;
  readonly workspaceRoot: string;
  readonly navigation: TreeNavigation;
  readonly clientId: string;
  readonly browsingContextId: string;
  request<T>(input: RequestInput): Promise<T>;
  createDetailPane(blockId: string, direction?: "right" | "down", targetPaneId?: string): Promise<void>;
  createDetailDestination?(blockId: string, placement: DetailDestinationPlacement): Promise<OutlinerViewAddress>;
  openKeyInspector?(): void;
  openCapturePopup(capturedFromBlockId: string): Promise<void>;
  openGotoPopup?(): void | Promise<void>;
  openVirtualBranchNavigator(viewId: string, adapter?: "bookmark"): void | Promise<void>;
  focusSelf(): void;
  terminalWidth(): number;
  terminalHeight(): number;
  stop(): void;
  invalidate(): void;
  readonly actionKeymap?: OutlinerActionKeymap;
}

export interface TreeExpandedPage {
  readonly rowId: string;
  readonly pageSize: number;
  readonly totalRows: number;
  readonly offset: number;
}

export interface TreeController {
  setViewportStart(index: number, expandedPage?: TreeExpandedPage | null): void;
  setBreadcrumbStart(index: number): void;
  view(): TreeView;
  revealBlock(blockId: string): Promise<void>;
  initialize(): Promise<void>;
  handleKeypress(str: string, key: TerminalKey, inputAction: TerminalInputAction): Promise<void>;
  handleTreeWheel(direction: "up" | "down"): Promise<void>;
  handlePaste(text: string): Promise<void>;
  handleGotoMouse(sequence: string): Promise<void>;
  focusLocalPreview(focused?: boolean): void;
  scrollLocalPreview(delta:number): void;
  resizeLocalPreview(fraction:number): void;
  handleDisclosure(rowId: string): Promise<void>;
  handleRowClick(rowId: string, activate?: boolean): Promise<void>;
  handleAction(actionId: string, origin?: { column: number; row: number }): Promise<void>;
  handleServiceEvent(event: OutlinerEvent): Promise<void>;
  handleConnect(): Promise<void>;
  handleDisconnect(): void;
  handleError(error: unknown): void;
}

interface MutableQuickCompletion {
  start: number;
  end: number;
  index: number;
  items: TreeQuickCompletionItem[];
  truncatedLimit: number | null;
}

interface TreeNavigationEntry {
  readonly root: TreeRoot | null;
  readonly scrollStartEntryIndex: number;
  readonly rowId: string;
  readonly canonicalId: string;
}

interface PendingBrowsingPublication {
  rowId: string | null;
  readonly target: OutlinerNavigationTarget | null;
  readonly dispatchPreview: boolean;
}
const MAX_TREE_HISTORY_ENTRIES = 200;


function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const GENERATED_ROW_DISABLED_ACTIONS: Record<string, true> = {
  "tree.authored-links.toggle": true,
  "tree.bookmark.toggle": true,
  "tree.capture": true,
  "tree.add.child": true,
  "tree.add.sibling": true,
  "tree.current.reveal": true,
  "tree.delete": true,
  "tree.detail.below": true,
  "tree.detail.right": true,
  "tree.edit": true,
  "tree.file.open": true,
  "tree.reference.open": true,
  "tree.reference.reveal": true,
  "tree.reorder.up": true,
  "tree.reorder.down": true,
  "tree.virtual-branch.open": true,
};

function rowIndexForIdentity(
  rows: readonly TreeDisplayRow[],
  rowId: string,
  canonicalId = rowId,
): number {
  const exactIndex = rows.findIndex((row) => row.rowId === rowId);
  if (exactIndex >= 0) return exactIndex;
  const physicalIndex = rows.findIndex(
    (row) => row.kind === "physical" && row.canonicalId === canonicalId,
  );
  if (physicalIndex >= 0) return physicalIndex;
  return rows.findIndex((row) => isBlockTreeRow(row) && row.canonicalId === canonicalId);
}

function fallbackRowBeforeDelete(
  rows: readonly TreeDisplayRow[],
  selectedIndex: number,
  physicalBlocksById: ReadonlyMap<string, TreeIndexBlock>,
): TreeRow | null {
  const selected = rows[selectedIndex];
  if (!isBlockTreeRow(selected)) return null;
  const blockRows = rows.filter(isBlockTreeRow);
  const selectedBlockIndex = blockRows.findIndex((row) => row.rowId === selected.rowId);
  const removedCanonicalIds = new Set([selected.canonicalId]);
  let discoveredDescendant = true;
  while (discoveredDescendant) {
    discoveredDescendant = false;
    for (const block of physicalBlocksById.values()) {
      if (
        block.parentId &&
        removedCanonicalIds.has(block.parentId) &&
        !removedCanonicalIds.has(block.id)
      ) {
        removedCanonicalIds.add(block.id);
        discoveredDescendant = true;
      }
    }
  }
  const survives = (row: TreeRow): boolean =>
    !removedCanonicalIds.has(row.canonicalId) &&
    !(row.kind === "occurrence" && removedCanonicalIds.has(row.viewId));
  const survivingRows = blockRows.filter(survives);
  if (survivingRows.length === 0) return null;
  const removedBefore = blockRows
    .slice(0, selectedBlockIndex)
    .filter((row) => !survives(row))
    .length;
  const fallbackIndex = Math.min(
    selectedBlockIndex - removedBefore,
    survivingRows.length - 1,
  );
  return survivingRows[Math.max(0, fallbackIndex)] ?? null;
}

export function createTreeController(effects: TreeControllerEffects): TreeController {
  let baseRows: TreeRow[] = [];
  let rows: TreeDisplayRow[] = [];
  let root: TreeRoot | null = effects.initialRoot ?? null;
  let expandedPage: TreeExpandedPage | null = null;
  let fullRowsById = new Map<string,TreeRow>();
  let breadcrumbRowId: string | undefined;
  let breadcrumbStart: number | null = null;
  let indentationMode: "viewport" | "selection" = "viewport";
  let scrollStartEntryIndex = 0;
  let physicalBlocksById = new Map<string, TreeIndexBlock>();
  let expandedDocuments = new Map<string, ExpandedTreeDocument>();
  let indexSequence: number | null = null;
  let quickEditSource: Pick<Block, "id" | "revision"> | null = null;
  let physicalRowCount = 0;
  let occurrenceRowCount = 0;
  let workIdPrefix: string | null = null;
  let visibleCompleteness: BlockCollectionCompleteness = { kind: "complete" };
  let branchStates = new Map<string, VirtualBranchState>();
  const collapsedBlockIds = new Set<string>();
  let authoredLinksPanel: AuthoredLinksPanel = { kind: "closed" };
  let authoredLinksGeneration = 0;
  let authoredLinksDirty = false;
  let authoredLinksRefresh: Promise<void> | null = null;
  const collapsedOccurrenceRowIds = new Set<string>();
  const multilineExpandedRowIds = new Set<string>();
  const uncollapsedPresentationIds = new Set<string>();
  const navigationHistory: TreeNavigationEntry[] = [];
  let navigationIndex = -1;
  let initialWorkspaceSelectionApplied = false;
  let workspaceContextBlockId: string | null = null;
  let selectedIndex = 0;
  let activeFilter = "";
  let mode: TreeMode = "browse";
  let quickBuffer = new TextBuffer();
  let quickCompletion: MutableQuickCompletion | null = null;

  const localReader = new DocumentPreview(effects, () => effects.invalidate(), effects.clientId);
  let previewPreferences = defaultPreviewPreferences();
  let viewerLines: string[] = [];
  let viewerPath = "";
  let viewerOffset = 0;
  let expandedBlockOffset = 0;
  let lastVisibleCanonicalId: string | null = null;
  let status = "";
  let browsingPublicationStatus = "";
  let refreshPending = false;
  let attention = emptyAttentionState(effects.clientId);
  const actionKeymap = effects.actionKeymap ?? DEFAULT_OUTLINER_ACTION_KEYMAP;
  let actionMenuOrigin: { column: number; row: number } | null = null;
  let actionMenuIndex = 0;
  const destinationPreview=new NavigationDestinationPreview(effects,effects.invalidate);
  const navigationDisplay = new NavigationDestinationDisplay(effects, {clientId: effects.clientId, region: "tree"}, effects.invalidate);
  let showOtherDestinations=false;
  let actionMenuQuery = "";
  let actionMenuReturnMode: TreeMode = "browse";
  let actionMenuScope = "browse";
  let lastInboxCue = "";
  let pendingBrowsingPublication: PendingBrowsingPublication | null = null;
  let browsingPublicationPump: Promise<void> | null = null;

  const goto = new GotoController({
    request: input => effects.request(input),
    invalidate: () => effects.invalidate(),
    async close() {
      mode = "browse"; status = "";
      if (refreshPending) await reload();
      effects.invalidate();
    },
    async open(blockId, destination) {
      if (destination === "detail") await effects.navigation.dispatch({ kind: "block", blockId }, "open");
      else await selectVisibleBlock(blockId, { recordNavigation: true });
      mode = "browse"; status = destination === "detail" ? "Opened in Detail" : "Focused selected result";
      if (refreshPending) await reload();
    },
  });

  const inbox = new InboxController({
    request: input => effects.request(input),
    async openResource(resourceId) {
      await effects.navigation.dispatch({ kind: "resource", resourceId }, "open");
      mode = "browse";
      status = "Pi session opened in Detail";
      if (refreshPending) await reload();
      effects.invalidate();
    },
    invalidate() {
      const cue = inboxStatusCue(inbox.snapshot, inbox.error);
      if (mode === "inbox" || cue !== lastInboxCue) effects.invalidate();
      lastInboxCue = cue;
    },
    async close() {
      mode = "browse";
      status = "";
      if (refreshPending) await reload();
      effects.invalidate();
    },
    async open(blockId, destination) {
      if (destination === "detail") {
        const state = await effects.request<NavigationLinkState>({action:"navigation.link.get", source:{clientId:effects.clientId,region:"tree"}});
        if (!state.destination || !state.destinations.some(d=>d.view.clientId===state.destination!.clientId && d.view.region===state.destination!.region)) {
          await handleAction("tree.navigation.once"); return;
        }
        await effects.navigation.dispatch({kind:"block",blockId},"open");
      } else { await selectVisibleBlock(blockId, { recordNavigation: true, physicalSource: true }); mode = "browse"; }
      status = destination === "detail" ? "Inbox result opened in Detail" : "Inbox block revealed in Tree";
      if (refreshPending) await reload();
      effects.invalidate();
    },
  });

  function actionScope(): string {
    return mode === "inbox" && inbox.searchEditing ? "inbox-search" : mode === "inbox" && inbox.steering ? "inbox-steer" : mode;
  }

  async function handleGotoMouse(sequence: string): Promise<void> {
    if (mode !== "goto") return;
    await routeGotoMouse(goto, sequence, effects.terminalWidth(), effects.terminalHeight());
  }

  let placementDirection: "right" | "down" | null = null;
  let destinationMenu: {state: NavigationLinkState; purpose: "link" | "open"} | null = null;

  function filteredActionMenuItems(): OutlinerActionMenuItem[] {
    if (destinationMenu) return filterActionMenuItems(placementDirection ? navigationPlacementItems(destinationMenu.state) : navigationDestinationItems(destinationMenu.state, destinationMenu.purpose === "link",showOtherDestinations), actionMenuQuery);
    const selected = rows[selectedIndex];
    let items = actionKeymap.menuItems("tree", actionMenuScope);
    if (actionMenuScope !== "browse") return filterActionMenuItems(items
      .filter(item => !inbox.attentionOnly || !["tree.inbox.older", "tree.inbox.newer"].includes(item.id))
      .map(item => item.id === "tree.inbox.attention"
      ? { ...item, label: inbox.attentionOnly ? "Show recent results" : `Show needs attention (${inbox.snapshot?.attentionCount ?? 0})` }
      : item), actionMenuQuery);
    if (isBlockTreeRow(selected)) {
      const hiding = authoredLinksPanel.kind === "open" &&
        authoredLinksPanel.owner.rowId === selected.rowId;
      items = items.map((item) =>
        item.id === "tree.authored-links.toggle"
          ? { ...item, label: hiding ? "Hide authored links" : "Show authored links" }
          : item
      );
      if (isVirtualBranchOccurrence(selected) &&
        (!isVirtualBranchRootOccurrence(selected) || branchStates.get(selected.viewId)?.config?.sort)) {
        items = items.filter(item => item.id !== "tree.reorder.up" && item.id !== "tree.reorder.down");
      }
    } else {
      items = items.filter((item) => {
        if (GENERATED_ROW_DISABLED_ACTIONS[item.id]) return false;
        if (item.id === "tree.read") {
          return selected?.kind === "authored-link" && authoredLinkCanOpen(selected);
        }
        if (item.id === "tree.disclosure.toggle") {
          return selected?.kind === "authored-link-header";
        }
        return true;
      });
    }
    return filterActionMenuItems(items, actionMenuQuery);
  }

  function updateDestinationPreview():void {
    const item=filteredActionMenuItems()[actionMenuIndex];
    void destinationPreview.select(destinationMenu?.state.destinations[Number(item?.id.split(":")[1])]);
  }
  function updateActionMenuQuery(query: string): void {
    actionMenuQuery = query;
    actionMenuIndex = 0;
    if(destinationMenu)updateDestinationPreview();
  }

  function quickInputText(): string {
    return quickBuffer.lines[quickBuffer.row] ?? "";
  }

  function inboxHelpText(): string | null {
    if (mode !== "inbox") return null;
    if(inbox.searchEditing)return "Esc cancel search · Enter browse results · Alt+Enter open Detail\nType to search all history · ↑↓ select";
    if (inbox.steering) return actionKeymap.helpText("tree", "inbox-steer", ["tree.cancel", "tree.inbox.retry.submit"]);
    const main = actionKeymap.helpText("tree", "inbox", [
      "tree.cancel", "tree.inbox.pause", "tree.inbox.tree", "tree.inbox.detail", "tree.inbox.undo", "tree.inbox.reconsider",
    ]);
    const toggle = `${displayActionChord(actionKeymap.primaryBinding("tree.inbox.attention"))} ${inbox.attentionOnly ? "show recent results" : `needs attention (${inbox.snapshot?.attentionCount ?? 0})`}`;
    const navigation = actionKeymap.helpText("tree", "inbox", [
      ...inbox.attentionOnly ? [] : ["tree.inbox.older", "tree.inbox.newer"],
      "tree.inbox.preview.focus", "tree.inbox.preview.source", "tree.inbox.preview.output", "tree.inbox.preview.activity", "tree.inbox.source", "tree.inbox.target", "tree.inbox.up", "tree.inbox.down", "tree.inbox.pageup", "tree.inbox.pagedown",
    ]);
    return `${toggle}  ${main}\n${actionKeymap.helpText("tree", "inbox", ["tree.menu.open"])}  ${navigation}`;
  }

  function breadcrumbs(): Array<TreeRoot & {kind:"physical"|"occurrence"}> {
    const selected=rows[selectedIndex];
    const path: Array<TreeRoot & {kind:"physical"|"occurrence"}> = [];
    let row=fullRowsById.get(isBlockTreeRow(selected) ? selected.rowId : selected?.owner.rowId ?? "");
    const seen=new Set<string>();
    while(row && !seen.has(row.rowId)) {
      seen.add(row.rowId);
      path.unshift({rowId:row.rowId,canonicalId:row.canonicalId,label:row.block.preview,kind:row.kind});
      row=fullRowsById.get(row.kind === "occurrence" ? row.parentRowId : row.block.parentId ?? "");
    }
    return path;
  }

  function view(): TreeView {
    return {
      workspaceRoot: effects.workspaceRoot,
      root, scrollStartEntryIndex,
      breadcrumbs:breadcrumbs(),
      indentationMode,
      breadcrumbStart:breadcrumbRowId === rows[selectedIndex]?.rowId ? breadcrumbStart : null,
      rows,
      physicalBlocksById,
      expandedDocuments,
      physicalRowCount,
      occurrenceRowCount,
      workIdPrefix,
      visibleCompleteness,
      workspaceContextBlockId,
      branchStates,
      selectedIndex,
      activeFilter,
      mode,
      quickInput: mode === "goto" ? goto.query : quickInputText(),
      quickColumn: quickBuffer.column,
      quickCompletion,
      goto: mode === "goto" ? goto : null,
      inbox: mode === "inbox" ? inbox : null,
      inboxCue: inboxStatusCue(inbox.snapshot, inbox.error),
      localPreview: localReader.state,
      previewPreferences,
      navigationDestinationLabel: navigationDisplay.text,
      previewHelp: `${actionKeymap.helpText("tree", "browse", ["tree.preview.focus", "tree.preview.close"])} · drag to copy`,
      viewerLines,
      viewerPath,
      viewerOffset,
      expandedBlockOffset,
      status,
      refreshPending,
      attention,
      actionHelpText: inboxHelpText() ?? actionKeymap.helpText("tree", actionScope()),
      actionMenuItems: mode === "action-menu" ? filteredActionMenuItems() : [],
      actionMenuOrigin,
      actionMenuIndex,
      actionMenuQuery,
      ...(destinationMenu && mode === "action-menu" ? {destinationPreview,destinationPurpose:placementDirection ? "place" : destinationMenu.purpose,destinationInstructions:placementDirection ? navigationPlacementStatus(placementDirection) : navigationDestinationStatus(destinationMenu.state,destinationMenu.purpose,showOtherDestinations)}:{}),
    };
  }

  function panelOwnerBlock(): TreeIndexBlock | null {
    if (authoredLinksPanel.kind === "closed") return null;
    return physicalBlocksById.get(authoredLinksPanel.owner.blockId) ?? null;
  }
  function authoredLinksOwnerCollapsed(): boolean {
    const panel = authoredLinksPanel;
    if (panel.kind === "closed") return false;
    const owner = baseRows.find((row) => row.rowId === panel.owner.rowId);
    if (!owner) return false;
    return owner.kind === "occurrence"
      ? collapsedOccurrenceRowIds.has(owner.rowId)
      : collapsedBlockIds.has(owner.canonicalId);
  }

  function authoredLinksPanelVisible(): boolean {
    const panel = authoredLinksPanel;
    if (panel.kind === "closed") return false;
    const ownerExists = baseRows.some((row) => row.rowId === panel.owner.rowId);
    return ownerExists && !authoredLinksOwnerCollapsed();
  }
  function recomposeAuthoredRows(preferredRowId?: string): void {
    const previous = rows[selectedIndex];
    rows = composeAuthoredLinkRows(
      baseRows,
      authoredLinksPanel,
      authoredLinksOwnerCollapsed(),
    );
    let nextIndex = preferredRowId === undefined
      ? previous ? rows.findIndex((row) => row.rowId === previous.rowId) : -1
      : rows.findIndex((row) => row.rowId === preferredRowId);
    if (nextIndex < 0 && previous) {
      for (const fallbackRowId of authoredLinkFallbackRowIds(previous)) {
        nextIndex = rows.findIndex((row) => row.rowId === fallbackRowId);
        if (nextIndex >= 0) break;
      }
    }
    selectedIndex = Math.max(
      0,
      Math.min(nextIndex >= 0 ? nextIndex : selectedIndex, rows.length - 1),
    );
  }

  async function runAuthoredLinksRefresh(): Promise<void> {
    while (
      authoredLinksDirty &&
      authoredLinksPanel.kind === "open" &&
      authoredLinksPanelVisible()
    ) {
      authoredLinksDirty = false;
      const owner = authoredLinksPanel.owner;
      const generation = authoredLinksPanel.generation;
      try {
        const decoded = decodeAuthoredLinksSnapshot(await effects.request<unknown>({
          action: "blocks.authored-links",
          ownerBlockId: owner.blockId,
        }));
        if (decoded.ownerId !== owner.blockId) {
          throw new Error("Authored-links response owner does not match the requested block");
        }
        if (
          authoredLinksPanel.kind !== "open" ||
          authoredLinksPanel.generation !== generation ||
          authoredLinksPanel.owner.rowId !== owner.rowId ||
          authoredLinksDirty
        ) continue;
        const currentOwner = panelOwnerBlock();
        if (
          decoded.kind === "ready" &&
          currentOwner &&
          decoded.ownerTextDigest !== currentOwner.textDigest
        ) {
          authoredLinksDirty = true;
          authoredLinksPanel = {
            ...authoredLinksPanel,
            load: { kind: "loading" },
          };
          recomposeAuthoredRows();
          effects.invalidate();
          break;
        }
        authoredLinksPanel = {
          ...authoredLinksPanel,
          load: { kind: "ready", snapshot: decoded },
        };
      } catch (error) {
        if (
          authoredLinksPanel.kind === "open" &&
          authoredLinksPanel.generation === generation &&
          authoredLinksPanel.owner.rowId === owner.rowId
        ) {
          authoredLinksPanel = {
            ...authoredLinksPanel,
            load: { kind: "error", message: errorMessage(error) },
          };
        }
      }
      recomposeAuthoredRows();
      effects.invalidate();
    }
  }

  function refreshAuthoredLinks(markDirty = true): Promise<void> {
    if (authoredLinksPanel.kind === "closed") return Promise.resolve();
    if (markDirty) authoredLinksDirty = true;
    if (!authoredLinksDirty || !authoredLinksPanelVisible()) return Promise.resolve();
    if (!authoredLinksRefresh) {
      authoredLinksRefresh = runAuthoredLinksRefresh().finally(() => {
        authoredLinksRefresh = null;
      });
    }
    return authoredLinksRefresh;
  }

  async function reload(
    preferredRowId?: string | null,
    options?: { exactRowIdOnly?: boolean },
  ): Promise<boolean> {
    const currentSelected = rows[selectedIndex];
    const snapshot = await effects.request<TreeIndexSnapshot>({
      action: "tree.index",
      view: activeFilter
        ? {
            query: {
              filters: parsePropertyFilterExpression(activeFilter),
              limit: 500,
            },
          }
        : undefined,
    });
    workIdPrefix = snapshot.workIdPrefix ?? null;
    const indexed = new Map(snapshot.blocks.map(block => [block.id, block]));
    const requireEntry = (id: string): TreeIndexBlock => {
      const block = indexed.get(id);
      if (!block) throw new Error(`Tree index is missing canonical entry ${id}`);
      return block;
    };
    const physical = snapshot.physicalBlockIds.map(requireEntry);
    const visible = snapshot.visible.rows.map(row => ({ ...requireEntry(row.id), ...row }));

    const presentation: TreePresentationState = {
      collapsedBlockIds: activeFilter ? uncollapsedPresentationIds : collapsedBlockIds,
      collapsedOccurrenceRowIds,
      multilineExpandedRowIds,
    };
    const projection = await projectVirtualBranches(
      visible,
      physical,
      (query) => effects.request<TreeIndexCollection>({ action: "tree.query", query }),
      snapshot.virtualOccurrenceRanks,
      presentation,
    );
    fullRowsById = new Map(projection.rows.map(row=>[row.rowId,row]));
    const rootIndex = root ? projection.rows.findIndex(row => row.rowId === root!.rowId) : -1;
    let scope = projection.rows;
    if(root) {
      const anchor = projection.rows[rootIndex];
      if(!anchor) scope = [];
      else {
        root = {...root,label:anchor.block.preview};
        let end = rootIndex+1;
        while(end<projection.rows.length && projection.rows[end]!.depth>anchor.depth) end++;
        scope = projection.rows.slice(rootIndex,end).map(row=>({...row,depth:row.depth-anchor.depth}));
      }
    }
    if(root && rootIndex < 0) status = "Focused occurrence is no longer visible · return to workspace from actions";
    const expanded = new Map(scope.filter(row => row.multilineExpanded).map(row => [row.canonicalId, row.block]));
    const loaded = new Map<string, ExpandedTreeDocument>();
    await Promise.all([...expanded].map(async ([id, entry]) => {
      const retained = indexSequence === snapshot.sequence ? expandedDocuments.get(id) : undefined;
      if (retained?.block.revision === entry.revision) {
        loaded.set(id, retained);
        return;
      }
      const block = await effects.request<Block>({ action: "get", blockId: id });
      if (block.revision !== entry.revision) throw new Error("Block changed while expanding; refresh the Tree");
      const resolved = await effects.request<ResolvedBlockReferences>({ action: "references.resolve", text: block.text });
      loaded.set(id, { block, resolved });
    }));
    expandedDocuments = loaded;
    indexSequence = snapshot.sequence;
    baseRows = scope;
    physicalBlocksById = new Map(physical.map((block) => [block.id, block]));
    if (authoredLinksPanel.kind === "open" && authoredLinksPanel.load.kind === "ready") {
      const loaded = authoredLinksPanel.load.snapshot;
      const owner = panelOwnerBlock();
      if (
        loaded.kind === "ready" &&
        owner &&
        loaded.ownerTextDigest !== owner.textDigest
      ) {
        authoredLinksPanel = {
          ...authoredLinksPanel,
          load: { kind: "loading" },
        };
        authoredLinksDirty = true;
      }
    }
    const nextRows = composeAuthoredLinkRows(
      baseRows,
      authoredLinksPanel,
      authoredLinksOwnerCollapsed(),
    );
    const serviceSelectedId = snapshot.selectedBlockId;
    let nextIndex = -1;
    if (preferredRowId !== undefined) {
      if (preferredRowId) {
        nextIndex = options?.exactRowIdOnly
          ? nextRows.findIndex((row) => row.rowId === preferredRowId)
          : rowIndexForIdentity(nextRows, preferredRowId);
      }
    } else if (currentSelected) {
      nextIndex = nextRows.findIndex((row) => row.rowId === currentSelected.rowId);
      if (nextIndex < 0) {
        for (const fallbackRowId of authoredLinkFallbackRowIds(currentSelected)) {
          nextIndex = nextRows.findIndex((row) => row.rowId === fallbackRowId);
          if (nextIndex >= 0) break;
        }
      }
    }
    if (
      nextIndex < 0 &&
      preferredRowId === undefined &&
      !initialWorkspaceSelectionApplied &&
      serviceSelectedId
    ) {
      nextIndex = nextRows.findIndex(
        (row) => isBlockTreeRow(row) && row.canonicalId === serviceSelectedId,
      );
    }
    const nextSelectedIndex = Math.max(
      0,
      Math.min(nextIndex >= 0 ? nextIndex : selectedIndex, nextRows.length - 1),
    );
    const nextSelectedRow = nextRows[nextSelectedIndex];
    const selectedRowChanged = currentSelected?.rowId !== nextSelectedRow?.rowId;
    const currentMultilineExpanded = isBlockTreeRow(currentSelected)
      ? currentSelected.multilineExpanded
      : false;
    const nextMultilineExpanded = isBlockTreeRow(nextSelectedRow)
      ? nextSelectedRow.multilineExpanded
      : false;
    if (selectedRowChanged || currentMultilineExpanded !== nextMultilineExpanded) {
      resetExpandedBlockPaging();
    }
    rows = nextRows;
    physicalRowCount = projection.physicalRowCount;
    occurrenceRowCount = projection.occurrenceRowCount;
    visibleCompleteness = snapshot.visible.completeness;
    branchStates = projection.branchStates;
    selectedIndex = nextSelectedIndex;
    const selectedBlock = rows[selectedIndex];
    lastVisibleCanonicalId = isBlockTreeRow(selectedBlock) ? selectedBlock.canonicalId : null;
    initialWorkspaceSelectionApplied = true;
    if (lastVisibleCanonicalId) workspaceContextBlockId = lastVisibleCanonicalId;
    refreshPending = false;
    if (authoredLinksDirty) await refreshAuthoredLinks(false);
    return rows.length > 0;
  }

  function scrollSelectedExpandedBlock(direction: "pageup" | "pagedown"): void {
    const selected = rows[selectedIndex];
    if (!isBlockTreeRow(selected) || !selected.multilineExpanded) {
      expandedBlockOffset = 0;
      status = isBlockTreeRow(selected)
        ? "Expand the selected block before paging within it"
        : "Authored-link rows are single-line";
      return;
    }
    if (!expandedPage || expandedPage.rowId !== selected.rowId) {
      status = "Waiting for expanded block layout";
      return;
    }
    const { totalRows, pageSize } = expandedPage;
    const maxOffset = Math.max(0, totalRows - pageSize);
    if (maxOffset === 0) {
      expandedBlockOffset = 0;
      status = `Expanded block fits in ${totalRows} visual row${totalRows === 1 ? "" : "s"}`;
      return;
    }
    const currentOffset = Math.min(expandedBlockOffset, maxOffset);
    expandedBlockOffset = direction === "pageup"
      ? Math.max(0, currentOffset - pageSize)
      : Math.min(maxOffset, currentOffset + pageSize);
    const end = Math.min(totalRows, expandedBlockOffset + pageSize);
    status = `Expanded block rows ${expandedBlockOffset + 1}-${end}/${totalRows}`;
  }

  function resetExpandedBlockPaging(): void {
    expandedBlockOffset = 0;
    if (status.startsWith("Expanded block") || status.startsWith("Expand the selected")) {
      status = "";
    }
  }

  function resetQuickEditor(): void {
    quickBuffer = new TextBuffer();
    quickEditSource = null;
    quickCompletion = null;
    goto.dispose();
  }


  function moveQuickCompletion(delta: number, wrap = false): void {
    if (!quickCompletion) return;
    const itemCount = quickCompletion.items.length;
    quickCompletion.index = wrap
      ? (quickCompletion.index + delta + itemCount) % itemCount
      : Math.max(0, Math.min(itemCount - 1, quickCompletion.index + delta));
  }

  function updateQuickBuffer(str: string, key: TerminalKey): boolean {
    switch (key.name) {
      case "backspace":
        quickBuffer.backspace();
        return true;
      case "delete":
        quickBuffer.deleteForward();
        return true;
      case "left":
        quickBuffer.moveLeft();
        return false;
      case "right":
        quickBuffer.moveRight();
        return false;
      case "home":
        quickBuffer.moveHome();
        return false;
      case "end":
        quickBuffer.moveEnd();
        return false;
    }
    if (!isPrintableInput(str, key)) return false;
    quickBuffer.insert(str);
    return true;
  }

  async function beginInput(nextMode: TreeInputMode, initial = ""): Promise<void> {
    if (nextMode === "goto" && effects.openGotoPopup) {
      await effects.openGotoPopup();
      return;
    }
    const selected = rows[selectedIndex];
    if (
      !isBlockTreeRow(selected) &&
      nextMode !== "filter" &&
      nextMode !== "goto"
    ) {
      status = "Authored-link rows cannot enter block input modes";
      return;
    }
    if (nextMode === "add-child" && selected?.kind === "physical" && selected.collapsed) {
      collapsedBlockIds.delete(selected.canonicalId);
      await reload(selected.rowId);
    }
    mode = nextMode;
    if (nextMode === "goto") { goto.start(); return; }
    quickBuffer = new TextBuffer(initial);
    quickBuffer.moveEnd();
    quickCompletion = null;
    effects.invalidate();
  }

  async function commitQuickBlock(): Promise<string | null> {
    const selected = rows[selectedIndex];
    if (!isBlockTreeRow(selected)) return null;
    const text = quickInputText();
    if (!text.trim()) return mode === "edit" ? selected.canonicalId : null;

    if (mode === "edit") {
      if (!quickEditSource || quickEditSource.id !== selected.canonicalId) throw new Error("The draft has no matching source revision");
      await effects.request<Block>({
        action: "update",
        blockId: selected.canonicalId,
        text,
        expectedRevision: quickEditSource.revision,
        mutation: { author: "user", actorId: "tree" },
      });
      return selected.canonicalId;
    }
    if (mode === "add-child") {
      const branchState = branchStates.get(selected.canonicalId);
      if (branchState) {
        const config = branchState.config;
        if (!config || config.readOnly) {
          throw new Error("Virtual branch is read-only");
        }
        const created = await effects.request<Block>({
          action: "create",
          parentId: config.createParentId,
          text: buildVirtualBranchCreationText(text, config),
          author: "user",
        });
        return created.id;
      }
      const created = await effects.request<Block>({
        action: "create",
        parentId: selected.canonicalId,
        text,
        author: "user",
      });
      await effects.request({
        action: "move",
        blockId: created.id,
        parentId: selected.canonicalId,
        position: 0,
      });
      return created.id;
    }
    if (mode === "add-sibling") {
      const canonical = await effects.request<Block>({
        action: "get",
        blockId: selected.canonicalId,
      });
      const created = await effects.request<Block>({
        action: "create",
        parentId: canonical.parentId,
        text,
        author: "user",
      });
      await effects.request({
        action: "move",
        blockId: created.id,
        parentId: canonical.parentId,
        position: canonical.position + 1,
      });
      return created.id;
    }
    return null;
  }

  function navigationEntry(row: TreeDisplayRow | undefined): TreeNavigationEntry | null {
    return isBlockTreeRow(row) ? { rowId: row.rowId, canonicalId: row.canonicalId, root, scrollStartEntryIndex } : null;
  }

  function sameNavigationEntry(
    left: TreeNavigationEntry | null | undefined,
    right: TreeNavigationEntry | null | undefined,
  ): boolean {
    return left?.rowId === right?.rowId && left?.canonicalId === right?.canonicalId && left?.root?.rowId === right?.root?.rowId;
  }

  function recordNavigation(
    source: TreeNavigationEntry | null,
    target: TreeNavigationEntry | null,
  ): void {
    if (!source || !target || sameNavigationEntry(source, target)) return;

    if (!sameNavigationEntry(navigationHistory[navigationIndex], source)) {
      navigationHistory.splice(navigationIndex + 1);
      navigationHistory.push(source);
      navigationIndex = navigationHistory.length - 1;
    } else {
      navigationHistory.splice(navigationIndex + 1);
    }
    navigationHistory.push(target);
    navigationIndex = navigationHistory.length - 1;
    if (navigationHistory.length > MAX_TREE_HISTORY_ENTRIES) {
      const excess = navigationHistory.length - MAX_TREE_HISTORY_ENTRIES;
      navigationHistory.splice(0, excess);
      navigationIndex -= excess;
    }
  }

  async function inspectLocally(target: OutlinerNavigationTarget): Promise<void> {
    if (!previewPreferences.enabled) return;
    if (await localReader.load(target)) {
      try { await effects.request({action:"clients.update",clientId:effects.clientId,previewTarget:target}); }
      catch (error) { status = errorMessage(error); effects.invalidate(); }
    }
  }

  async function drainBrowsingPublications(): Promise<void> {
    while (pendingBrowsingPublication) {
      const desired = pendingBrowsingPublication;
      pendingBrowsingPublication = null;
      const publication = await effects.navigation.publish(desired.target, desired.dispatchPreview, desired.rowId);
      if (!pendingBrowsingPublication) {
        workspaceContextBlockId =
          desired.target?.kind === "block" ? desired.target.blockId : null;
        if (publication.unavailable) {
          status = publication.unavailable;
          browsingPublicationStatus = publication.unavailable;

        } else {
          if (desired.dispatchPreview && desired.target && publication.preview?.targetClientId === effects.clientId && publication.preview.targetRegion === "tree") {
            void inspectLocally(desired.target);
          } else if (localReader.state && publication.preview) {
            localReader.clear();
            await effects.request({action: "clients.update", clientId: effects.clientId, previewTarget: null});
          }
          if (status === browsingPublicationStatus) {
            status = "";
            browsingPublicationStatus = "";
          }
        }
        effects.invalidate();
      }
    }
  }

  function startBrowsingPublicationPump(): Promise<void> {
    if (browsingPublicationPump) return browsingPublicationPump;
    const running = drainBrowsingPublications();
    browsingPublicationPump = running;
    const finish = (): void => {
      if (browsingPublicationPump !== running) return;
      browsingPublicationPump = null;
      if (pendingBrowsingPublication) {
        void startBrowsingPublicationPump().catch((error) => {
          status = errorMessage(error);
          browsingPublicationStatus = status;
          effects.invalidate();
        });
      }
    };
    void running.then(finish, finish);
    return running;
  }

  async function flushBrowsingPublications(): Promise<void> {
    while (browsingPublicationPump) {
      try {
        await browsingPublicationPump;
      } catch {
        // Queued publication reports its own failure; only ordering matters here.
      }
    }
  }

  async function publishBrowsingTarget(
    target: OutlinerNavigationTarget | null,
    dispatchPreview = true,
  ): Promise<void> {
    localReader.cancelLoad();
    pendingBrowsingPublication = { target, dispatchPreview, rowId: rows[selectedIndex]?.rowId ?? null };
    await startBrowsingPublicationPump();
  }

  async function publishBrowsingContext(blockId: string | null): Promise<void> {
    await publishBrowsingTarget(blockId ? { kind: "block", blockId } : null);
  }

  function headerSelectionStatus(row: AuthoredLinkHeaderRow): string {
    if (row.state.kind !== "ready") return row.state.message;
    const details = [`${row.state.entryCount} authored ${row.label}`];
    if (row.state.invalidCount > 0) details.push(`${row.state.invalidCount} invalid`);
    if (row.state.limited) details.push("limited");
    if (row.state.diagnostics[0]) details.push(row.state.diagnostics[0].message);
    return details.join(" · ");
  }

  async function publishDisplayRowSelection(row: TreeDisplayRow | undefined): Promise<void> {
    if (isBlockTreeRow(row)) {
      lastVisibleCanonicalId = row.canonicalId;
      await publishBrowsingContext(row.canonicalId);
      return;
    }
    lastVisibleCanonicalId = null;
    if (!row) {
      await publishBrowsingTarget(null, false);
      return;
    }
    if (row.kind === "authored-link-header") {
      status = headerSelectionStatus(row);
      await publishBrowsingTarget(null, false);
      return;
    }
    const target = authoredLinkTarget(row);
    if (target) {
      status = `${row.link.label} selected · Enter opens in Detail`;
      await publishBrowsingTarget(target);
    } else {
      status = authoredLinkUnavailableReason(row) ?? "Authored target is unavailable";
      await publishBrowsingTarget(null, false);
    }
  }

  function queueDisplayRowSelection(row: TreeDisplayRow | undefined): void {
    void publishDisplayRowSelection(row).catch((error) => {
      status = errorMessage(error);
      browsingPublicationStatus = status;
      effects.invalidate();
    });
  }

  async function selectVisibleBlock(
    canonicalId: string | null,
    options?: {
      preferredRowId?: string;
      recordNavigation?: boolean;
      physicalSource?: boolean;
    },
  ): Promise<void> {
    const source = navigationEntry(rows[selectedIndex]);
    let visibilityChanged = false;
    if (options?.physicalSource) root = null;
    if (!canonicalId || !options?.physicalSource) {
      await reload(options?.preferredRowId ?? canonicalId);
    }
    const currentSelected = rows[selectedIndex];
    if (
      canonicalId &&
      (options?.physicalSource ||
        !isBlockTreeRow(currentSelected) ||
        currentSelected.canonicalId !== canonicalId)
    ) {
      root = null;
      const target = physicalBlocksById.get(canonicalId);
      if (!target) throw new Error(`Block not found: ${canonicalId}`);
      if (activeFilter) {
        activeFilter = "";
        visibilityChanged = true;
      }
      let parentId = target.parentId;
      while (parentId) {
        const parent = physicalBlocksById.get(parentId);
        if (!parent) throw new Error(`Block ancestry is incomplete at ${parentId}`);
        if (collapsedBlockIds.delete(parent.id)) visibilityChanged = true;
        parentId = parent.parentId;
      }
      await reload(canonicalId);
    }
    const selected = rows[selectedIndex];
    const visibleCanonicalId = isBlockTreeRow(selected) ? selected.canonicalId : null;
    if (
      canonicalId &&
      (visibleCanonicalId !== canonicalId || (options?.physicalSource && selected?.kind !== "physical"))
    ) {
      throw new Error(`Block ${canonicalId} could not be revealed`);
    }
    const target = navigationEntry(selected);
    if (options?.recordNavigation) recordNavigation(source, target);
    lastVisibleCanonicalId = visibleCanonicalId;
    await publishBrowsingContext(visibleCanonicalId);
    if (visibilityChanged) status = "Filter cleared or collapsed ancestors expanded to reveal block";
  }

  async function finishInput(): Promise<void> {
    if (mode === "filter") {
      const candidate = quickInputText().trim();
      try {
        parsePropertyFilterExpression(candidate);
      } catch (error) {
        quickCompletion = null;
        status = `Invalid filter: ${errorMessage(error)}`;
        effects.invalidate();
        return;
      }
      activeFilter = candidate;
      mode = "browse";
      resetQuickEditor();
      await selectVisibleBlock(null);
      effects.invalidate();
      return;
    }
    if (mode === "purge") {
      const selected = rows[selectedIndex];
      const confirmation = quickInputText().trim();
      mode = "browse";
      resetQuickEditor();
      if (!isBlockTreeRow(selected) || !selected.block.deletedAt) {
        status = "Selected block is not a Trash root";
      } else {
        await effects.request({
          action: "trash.purge",
          blockId: selected.canonicalId,
          confirmation,
        });
        status = "Permanently purged";
        await reload();
        const nextSelected = rows[selectedIndex];
        const visibleCanonicalId = isBlockTreeRow(nextSelected) ? nextSelected.canonicalId : null;
        await publishBrowsingContext(visibleCanonicalId);
      }
      effects.invalidate();
      return;
    }

    const selected = rows[selectedIndex];
    const editingRowId = mode === "edit" ? selected?.rowId : undefined;
    const committedBlockId = await commitQuickBlock();
    const fallbackId = isBlockTreeRow(selected) ? selected.canonicalId : null;
    mode = "browse";
    resetQuickEditor();
    await selectVisibleBlock(committedBlockId ?? fallbackId, {
      preferredRowId: editingRowId,
    });
    effects.invalidate();
  }

  async function focusDetailReader(routeOptions: NavigationRouteOptions = {}): Promise<void> {
    const selected = rows[selectedIndex];
    if (!selected) return;
    if (selected.kind === "authored-link-header") {
      status = headerSelectionStatus(selected);
      effects.invalidate();
      return;
    }
    await flushBrowsingPublications();
    if (selected.kind === "authored-link") {
      const activation = authoredLinkActivation(selected);
      if (activation.kind === "unavailable") {
        status = activation.reason;
        effects.invalidate();
        return;
      }
      try {
        await effects.navigation.resolve("open", routeOptions);
        let target: OutlinerNavigationTarget;
        let createdPage = false;
        let createdResource = false;
        if (activation.kind === "follow-page") {
          const resolved = await resolveOutlinerLinkTarget(effects, {
            kind: "page",
            value: activation.address,
          });
          target = { kind: "block", blockId: resolved.block.id };
          createdPage = resolved.created === true;
        } else if (activation.kind === "follow-resource") {
          const receipt = await effects.request<InternResourceReceipt>({
            action: "resources.follow-authored",
            reference: activation.reference,
          });
          target = { kind: "resource", resourceId: receipt.resource.id };
          createdResource = receipt.created;
        } else {
          target = activation.target;
        }
        await effects.navigation.dispatch(
          target,
          "open",
          { ...routeOptions, preserveSource: true },
        );
        status = createdPage
          ? `Page created and opened in ${effects.navigation.readerLabel}`
          : createdResource
          ? `Resource created and opened in ${effects.navigation.readerLabel}`
          : `Authored target opened in ${effects.navigation.readerLabel}`;
      } catch (error) {
        status = errorMessage(error);
      }
      effects.invalidate();
      return;
    }
    try {
      await effects.navigation.dispatch({
        kind: "block",
        blockId: selected.canonicalId,
      }, "open", routeOptions);
      status = `Reader opened in ${effects.navigation.readerLabel}`;
    } catch (error) {
      status = errorMessage(error);
    }
    effects.invalidate();
  }

  async function createLinkedDetail(placement: DetailDestinationPlacement): Promise<void> {
    const selected = rows[selectedIndex];
    const purpose = destinationMenu?.purpose ?? "link";
    const callerMode = destinationMenu ? actionMenuReturnMode : mode;
    const selectedBlockId = isBlockTreeRow(selected) ? selected.canonicalId : undefined;
    destinationMenu = null; placementDirection = null; destinationPreview.clear(); mode = callerMode;
    try {
      const blockId = callerMode === "inbox" ? await inbox.resolveContentTarget() : selectedBlockId;
      if (!blockId) throw new Error("Select a block to create a Detail destination");
      if (!effects.createDetailDestination) throw new Error("Creating a destination is unavailable in this host");
      status = "Creating Detail · waiting for the new reader to connect…";
      if (callerMode === "inbox") inbox.notice = status;
      effects.invalidate();
      const destination = await effects.createDetailDestination(blockId, placement);
      if (purpose === "link") await effects.request({action: "navigation.link.set", source: {clientId: effects.clientId, region: "tree"}, destination});
      void navigationDisplay.refresh();
      status = purpose === "link" ? "Linked: Tree → new Detail" : "Opened once in new Detail";
      if (callerMode === "inbox") inbox.notice = status;
    } catch (error) {
      status = errorMessage(error);
      if (callerMode === "inbox") inbox.notice = `${status} · Use Link destination or Open once to retry`;
    }
    effects.invalidate();
  }

  async function createDetailPane(direction: "right" | "down" = "down", targetPaneId?: string): Promise<void> {
    const selected = rows[selectedIndex];
    if (!isBlockTreeRow(selected)) {
      status = "Open authored targets in the existing Detail";
      effects.invalidate();
      return;
    }
    try {
      await effects.createDetailPane(selected.canonicalId, direction, targetPaneId);
      status = `Opened new independent Detail ${direction} for ${selected.block.preview}`;
    } catch (error) {
      status = errorMessage(error);
    }
    effects.invalidate();
  }

  async function handoffToDetail(): Promise<void> {
    const selected = rows[selectedIndex];
    if (!isBlockTreeRow(selected)) {
      status = "Authored-link rows cannot enter the block editor";
      effects.invalidate();
      return;
    }
    const committedBlockId = await commitQuickBlock();
    if ((mode === "add-child" || mode === "add-sibling") && !committedBlockId) {
      status = "Type a title before opening multiline detail";
      effects.invalidate();
      return;
    }
    const targetId = committedBlockId ?? selected.canonicalId;
    const targetRowId = mode === "edit" ? selected.rowId : undefined;
    mode = "browse";
    resetQuickEditor();
    await selectVisibleBlock(targetId, { preferredRowId: targetRowId });
    try {
      await effects.navigation.edit(targetId);
      status = `Multiline editor opened in ${effects.navigation.readerLabel}`;
    } catch (error) {
      status = errorMessage(error);
    }
    effects.invalidate();
  }

  async function openQuickCompletion(): Promise<void> {
    if (mode === "filter") {
      const target = filterCompletionTargetAtCursor(quickInputText(), quickBuffer.column);
      if (!target) {
        status = "Type a valid property key before requesting filter completion";
        return;
      }
      const catalog = await effects.request<PropertyCatalogItem[]>({
        action: "properties.catalog",
        ...(target.kind === "value" ? { key: target.key } : {}),
        prefix: target.prefix,
        limit: target.kind === "value" ? 20 : 100,
      });
      let items: TreeQuickCompletionItem[];
      if (target.kind === "value") {
        items = catalog.map((item) => ({
          label: `${item.value} (${item.count})`,
          insertion: `${target.key}=${serializePropertyFilterValue(item.value)}`,
        }));
      } else {
        const counts = new Map<string, number>();
        for (const item of catalog) counts.set(item.key, (counts.get(item.key) ?? 0) + item.count);
        items = [...counts]
          .sort(([leftKey, leftCount], [rightKey, rightCount]) =>
            rightCount - leftCount || leftKey.localeCompare(rightKey)
          )
          .map(([key, count]) => ({
            label: `${key} (${count})`,
            insertion: `${key}=`,
          }));
      }
      if (items.length === 0) {
        quickCompletion = null;
        status = target.kind === "value"
          ? `No matching values for ${target.key}`
          : "No matching property keys";
        return;
      }
      quickCompletion = {
        start: target.start,
        end: target.end,
        index: 0,
        items,
        truncatedLimit: null,
      };
      status = "";
      return;
    }
    const line = quickInputText();
    const target = completionTargetAtCursor(line, quickBuffer.column);
    if (!target) {
      status = "Type [[address]], ((block)), or [file::path] for Resource path completion";
      return;
    }
    let items: MutableQuickCompletion["items"];
    let truncatedLimit: number | null = null;
    if (target.kind === "file") {
      const candidates = await effects.request<ReferencedPathCandidate[]>({ action: "files.complete", prefix: target.query });
      items = candidates.map((candidate) => ({
        label: candidate.sourcePath,
        insertion: `[file::${candidate.sourcePath}${candidate.isDirectory ? "" : "]"}`,
      }));
    } else if (target.kind === "page") {
      const collection = await effects.request<PageAddressCollection>({
        action: "pages.complete",
        query: pageCompletionLookupQuery(target.query, workIdPrefix) || undefined,
        limit: 20,
      });
      if (collection.completeness.kind === "truncated") {
        truncatedLimit = collection.completeness.limit;
      }
      items = collection.addresses.map((address) => ({
        ...pageAddressCompletion(address, target.query, workIdPrefix),
        blockId: address.blockId,
      }));
    } else {
      const collection = await effects.request<TreeIndexCollection>({
        action: "tree.query",
        query: { text: target.query || undefined, limit: 20 },
      });
      if (collection.completeness.kind === "truncated") {
        truncatedLimit = collection.completeness.limit;
      }
      items = collection.blocks.map((block) => ({
        label: block.preview,
        insertion: `((${block.id}))`,
        blockId: block.id,
      }));
    }

    if (items.length === 0) {
      quickCompletion = null;
      switch (target.kind) {
        case "file":
          status = "No matching files";
          break;
        case "page":
          status =
            "No matching named addresses; [[target|label]] labels a target, ((...)) searches blocks";
          break;
        case "block":
          status = "No matching blocks";
          break;
      }
      return;
    }
    quickCompletion = {
      start: target.start,
      end: target.end,
      index: 0,
      items,
      truncatedLimit,
    };
    status = "";
  }

  function applyQuickCompletion(): void {
    if (!quickCompletion) return;
    const item = quickCompletion.items[quickCompletion.index];
    quickBuffer.replaceCurrentLine(quickCompletion.start, quickCompletion.end, item.insertion);
    quickCompletion = null;
  }

  async function openReferencedFile(block: Pick<Block, "properties">): Promise<void> {
    const rowId = rows[selectedIndex]?.rowId;
    const path = getProperty(block.properties, "file");
    if (!path) {
      status = "Selected block has no [file::path] property";
      return;
    }
    mode = "viewer";
    viewerLines = [];
    viewerPath = path;
    viewerOffset = 0;
    status = "Loading file…";
    effects.invalidate();
    try {
      const contents = await effects.request<FileContents>({ action: "files.read", path });
      if (mode !== "viewer" || rows[selectedIndex]?.rowId !== rowId) return;
      const file = referencedFilePreview(block, contents);
      viewerLines = file.lines;
      viewerPath = `${file.displayPath}${file.firstLine > 1 ? `:${file.firstLine}` : ""}`;
      viewerOffset = 0;
      mode = "viewer";
      status = "";
    } catch (error) {
      if (mode !== "viewer" || rows[selectedIndex]?.rowId !== rowId) return;
      mode = "browse";
      status = errorMessage(error);
    }
  }

  async function indent(selected: PhysicalTreeRow): Promise<void> {
    for (let index = selectedIndex - 1; index >= 0; index--) {
      const candidate = rows[index];
      if (candidate.depth < selected.depth) break;
      if (
        candidate.kind === "physical" &&
        candidate.depth === selected.depth &&
        candidate.block.parentId === selected.block.parentId
      ) {
        await effects.request({
          action: "move",
          blockId: selected.canonicalId,
          parentId: candidate.canonicalId,
        });
        return;
      }
    }
    status = "No previous sibling to indent beneath";
  }

  async function outdent(selected: PhysicalTreeRow): Promise<void> {
    const canonical = await effects.request<Block>({
      action: "get",
      blockId: selected.canonicalId,
    });
    if (!canonical.parentId) return;
    const parent = await effects.request<Block>({ action: "get", blockId: canonical.parentId });
    await effects.request({
      action: "move",
      blockId: canonical.id,
      parentId: parent.parentId,
      position: parent.position + 1,
    });
  }

  async function moveSibling(selected: PhysicalTreeRow, offset: -1 | 1): Promise<string> {
    const canonical = await effects.request<Block>({
      action: "get",
      blockId: selected.canonicalId,
    });
    const siblings = await effects.request<Block[]>({
      action: "children",
      parentId: canonical.parentId,
    });
    const currentIndex = siblings.findIndex((sibling) => sibling.id === canonical.id);
    const targetIndex = currentIndex + offset;
    if (currentIndex < 0 || targetIndex < 0) {
      status = "Already first sibling";
    } else if (targetIndex >= siblings.length) {
      status = "Already last sibling";
    } else {
      await effects.request({
        action: "move",
        blockId: canonical.id,
        parentId: canonical.parentId,
        position: targetIndex,
      });
      status = offset < 0 ? "Moved up among siblings" : "Moved down among siblings";
    }
    return canonical.id;
  }

  async function moveOccurrenceSibling(
    selected: VirtualBranchOccurrenceRow,
    offset: -1 | 1,
  ): Promise<string | null> {
    const sort = branchStates.get(selected.viewId)?.config?.sort;
    if (sort) {
      status = `Virtual branch is sorted by ${sort.field} ${sort.direction}; manual reorder is disabled`;
      return null;
    }
    const branchRows = rows.filter(
      (row): row is VirtualBranchOccurrenceRow =>
        isBlockTreeRow(row) &&
        isVirtualBranchRootOccurrence(row) &&
        row.viewId === selected.viewId,
    );
    const currentIndex = branchRows.findIndex((row) => row.rowId === selected.rowId);
    const targetIndex = currentIndex + offset;
    if (currentIndex < 0 || targetIndex < 0) {
      status = "Already first in virtual branch; canonical order unchanged";
      return null;
    }
    if (targetIndex >= branchRows.length) {
      status = "Already last in virtual branch; canonical order unchanged";
      return null;
    }

    const orderedBlockIds = branchRows.map((row) => row.canonicalId);
    [orderedBlockIds[currentIndex], orderedBlockIds[targetIndex]] = [
      orderedBlockIds[targetIndex]!,
      orderedBlockIds[currentIndex]!,
    ];
    await effects.request({
      action: "virtual.occurrences.reorder",
      viewId: selected.viewId,
      orderedBlockIds,
    });
    status = offset < 0
      ? "Moved up within virtual branch; canonical order unchanged"
      : "Moved down within virtual branch; canonical order unchanged";
    return selected.rowId;
  }

  function occurrenceMutationDisabled(action: string): void {
    status = `Virtual occurrence ${action} is disabled; canonical hierarchy unchanged`;
  }

  function virtualBranchCreationProblem(selected: PhysicalTreeRow): string | null {
    const state = branchStates.get(selected.canonicalId);
    if (!state) return null;
    if (state.configurationErrors.length > 0) {
      return `Virtual branch is invalid: ${state.configurationErrors.join("; ")}`;
    }
    if (!state.config || state.config.readOnly) {
      const reason = state.creationErrors.join("; ");
      return reason
        ? `Virtual branch is read-only: ${reason}`
        : "Virtual branch is read-only: configure create and create-parent";
    }
    return null;
  }

  async function handleServiceEvent(event: OutlinerEvent): Promise<void> {
    navigationDisplay.onEvent(event);
    if (event.domain === "view" && (event.action === "navigation.link.set" || event.action.startsWith("clients."))) return;
    if (event.domain === "inbox") {
      // Progress must not queue provider/status round trips ahead of keyboard input.
      void inbox.refresh();
      return;
    }
    if (event.domain === "attention") {
      if (!event.attention || event.attention.targetClientId !== effects.clientId) return;
      attention = event.attention;
      const instruction = event.attentionInstruction;
      const mark = instruction
        ? attention.marks.find((candidate) => candidate.markId === instruction.markId)
        : undefined;
      if (mark && instruction?.reveal) {
        await selectVisibleBlock(mark.target.sourceBlockId, { recordNavigation: true });
        status = mark.sourceState === "stale"
          ? "Attention source changed; mark is stale"
          : `Attention · ${mark.tone} · ${mark.target.sourceBlockId.slice(0, 8)}`;
      }
      if (instruction?.focus) effects.focusSelf();
      effects.invalidate();
      return;
    }
    if (event.domain === "ui") {
      const command = event.command;
      if (!command || command.targetClientId !== effects.clientId) return;
      // The publication pump owns these previews and rejects obsolete selections.
      // Its echoed UI event must not restart the read or restore an older target.
      if (command.command === "preview" && event.action === "browsing-context.publish") return;
      if (mode !== "browse") {
        refreshPending = true;
        return;
      }
      if (command.command === "preview") {
        void inspectLocally(command.target);
        return;
      }
      if ("target" in command && command.target?.kind === "block") {
        await selectVisibleBlock(command.target.blockId, {
          recordNavigation: true,
          physicalSource: command.command === "reveal",
        });
      }
      if (command.command === "focus" || ("focus" in command && command.focus)) effects.focusSelf();
      effects.invalidate();
      return;
    }
    if (event.domain === "browsing-context") {
      if (event.contextId !== effects.browsingContextId) return;
      workspaceContextBlockId = event.blockId ?? null;
      effects.invalidate();
      return;
    }
    if (event.domain === "resource-catalog") {
      if (authoredLinksPanel.kind === "open") await refreshAuthoredLinks();
      effects.invalidate();
      return;
    }
    if (event.domain === "selection") return;
    if (mode === "inbox") inbox.contentChanged();
    if (authoredLinksPanel.kind === "open") authoredLinksDirty = true;
    if (mode !== "browse") {
      refreshPending = true;
      return;
    }
    const previousRow = rows[selectedIndex];
    await reload();
    if (previousRow && !rows.some((row) => row.rowId === previousRow.rowId)) {
      await publishDisplayRowSelection(rows[selectedIndex]);
    }
    effects.invalidate();
  }

  async function navigateTreeHistory(direction: "back" | "forward"): Promise<void> {
    const targetIndex = navigationIndex + (direction === "back" ? -1 : 1);
    const target = navigationHistory[targetIndex];
    if (!target) {
      status = "No further navigation history";
      return;
    }

    let canonical: Block;
    try {
      canonical = await effects.request<Block>({
        action: "get",
        blockId: target.canonicalId,
      });
    } catch {
      status = "Navigation target no longer exists";
      return;
    }
    navigationIndex = targetIndex;
    if (canonical.effectiveDeletedRootId) {
      await flushBrowsingPublications();
      await effects.navigation.dispatch({kind: "block", blockId: canonical.id}, "open");
      status = `Navigation history opened deleted block read-only in ${effects.navigation.readerLabel}`;
      return;
    }

    root = target.root;
    if(root) {
      await reload(target.rowId,{exactRowIdOnly:true});
      await publishDisplayRowSelection(rows[selectedIndex]);
    } else await selectVisibleBlock(canonical.id, { preferredRowId: target.rowId });
    scrollStartEntryIndex = target.scrollStartEntryIndex;
    status = direction === "back" ? "Navigation back" : "Navigation forward";
  }

  async function handleConnect(): Promise<void> {
    void navigationDisplay.refresh();
    resetExpandedBlockPaging();
    status = "";
    attention = await effects.request<AttentionClientState>({
      action: "attention.get",
      targetClientId: effects.clientId,
    });
    await inbox.refresh();
    if (mode === "browse") {
      if (authoredLinksPanel.kind === "open") authoredLinksDirty = true;
      await reload();
      await publishDisplayRowSelection(rows[selectedIndex]);
    } else {
      refreshPending = true;
      if (mode === "inbox") inbox.contentChanged();
      if (authoredLinksPanel.kind === "open") authoredLinksDirty = true;
    }
    effects.invalidate();
  }

  function handleDisconnect(): void {
    status = "Workspace service disconnected; reconnecting…";
    inbox.disconnected();
    effects.invalidate();
  }

  function handleError(error: unknown): void {
    status = errorMessage(error);
    effects.invalidate();
  }

  async function navigateSelectedReference(
    selected: TreeRow,
    intent: OutlinerNavigationIntent,
  ): Promise<void> {
    await flushBrowsingPublications();
    const source = await effects.request<Block>({ action: "get", blockId: selected.canonicalId });
    const reference = firstOutlinerReference(source.text, workIdPrefix);
    if (!reference) {
      status = "Selected block has no block or page references";
      return;
    }
    if (reference.kind === "page") {
      await effects.navigation.resolve(intent);
    }
    const resolved = await resolveOutlinerLinkTarget(effects, reference);
    const dispatched = await effects.navigation.dispatch({
        kind: "block",
        blockId: resolved.block.id,
        ...(resolved.fragmentId ? { fragmentId: resolved.fragmentId } : {}),
      }, intent, {focusTarget: intent === "reveal"});
    const verb = intent === "open"
      ? resolved.created ? "Created and opened" : "Opened"
      : "Revealed";
    status = intent === "open"
      ? `${verb} ${blockDisplayTitle(resolved.block)} in ${effects.navigation.readerLabel}`
      : `${verb} ${blockDisplayTitle(resolved.block)} · ${dispatched.resolution}`;
  }

  function setCollapsed(row: TreeRow, collapsed: boolean): void {
    const ids = row.kind === "occurrence" ? collapsedOccurrenceRowIds : collapsedBlockIds;
    const id = row.kind === "occurrence" ? row.rowId : row.canonicalId;
    if(collapsed) ids.add(id); else ids.delete(id);
  }

  async function changeDepth(expand: boolean): Promise<void> {
    const selected = rows[selectedIndex];
    if(!isBlockTreeRow(selected)) return;
    const branch = () => {
      const index = rows.findIndex(row => row.rowId === selected.rowId);
      const result: TreeRow[] = [];
      for(let i=index; i>=0 && i<rows.length; i++) {
        const row=rows[i]!;
        if(i>index && row.depth<=selected.depth) break;
        if(isBlockTreeRow(row)) result.push(row);
      }
      return result;
    };
    const previouslyVisible = new Set(branch().map(row=>row.rowId));
    const candidates = branch().filter(row=>row.hasChildren && row.collapsed === expand);
    if(!candidates.length) return;
    const depth = expand ? Math.min(...candidates.map(row=>row.depth)) : Math.max(...candidates.map(row=>row.depth));
    for(const row of candidates) if(row.depth === depth) setCollapsed(row,!expand);
    await reload(selected.rowId,{exactRowIdOnly:true});
    if(expand) {
      // A newly exposed child starts closed even if it was expanded before hiding.
      for(const row of branch()) if(row.depth === depth+1 && row.hasChildren && !previouslyVisible.has(row.rowId)) setCollapsed(row,true);
      await reload(selected.rowId,{exactRowIdOnly:true});
    }
    status = expand ? "Expanded one layer" : "Collapsed one layer";
  }

  async function focusRoot(next: TreeRoot | null): Promise<void> {
    const source = navigationEntry(rows[selectedIndex]);
    root = next;
    scrollStartEntryIndex = 0;
    await reload(next?.rowId ?? source?.rowId);
    recordNavigation(source,navigationEntry(rows[selectedIndex]));
    await publishDisplayRowSelection(rows[selectedIndex]);
    status = next ? `Focused branch: ${next.label}` : "Workspace Tree";
  }

  async function handleDisclosure(rowId: string): Promise<void> {
    const rowIndex = rows.findIndex((row) => row.rowId === rowId);
    const row = rows[rowIndex];
    if (!row) return;
    selectedIndex = rowIndex;
    if (row.kind === "authored-link-header") {
      if (authoredLinksPanel.kind !== "open") return;
      authoredLinksPanel = {
        ...authoredLinksPanel,
        collapsedGroups: {
          ...authoredLinksPanel.collapsedGroups,
          [row.group]: !authoredLinksPanel.collapsedGroups[row.group],
        },
      };
      recomposeAuthoredRows(row.rowId);
      await publishDisplayRowSelection(rows[selectedIndex]);
      effects.invalidate();
      return;
    }
    if (!isBlockTreeRow(row) || !row.hasChildren) return;
    if (isVirtualBranchOccurrence(row)) {
      if (!collapsedOccurrenceRowIds.delete(row.rowId)) {
        collapsedOccurrenceRowIds.add(row.rowId);
      }
    } else if (!collapsedBlockIds.delete(row.canonicalId)) {
      collapsedBlockIds.add(row.canonicalId);
    }
    await reload(row.rowId, { exactRowIdOnly: true });
    await publishDisplayRowSelection(rows[selectedIndex]);
    effects.invalidate();
  }

  async function handleRowClick(rowId: string, activate = false): Promise<void> {
    if (mode !== "browse") return;
    const rowIndex = rows.findIndex((row) => row.rowId === rowId);
    if (rowIndex < 0) return;
    if (rows[selectedIndex]?.rowId !== rowId) resetExpandedBlockPaging();
    selectedIndex = rowIndex;
    await publishDisplayRowSelection(rows[selectedIndex]);
    effects.invalidate();
    if (activate) await focusDetailReader();
  }

  function focusLocalPreview(focused = true):void {if(mode === "inbox") inbox.reader.focus(focused); else localReader.focus(focused);}
  function scrollLocalPreview(delta:number):void {
    if(mode === "inbox") { inbox.scrollPreview(delta); return; }
    if(!localReader.state)return;
    const frame=treePreviewFrame(localReader.state,effects.terminalWidth(),effects.terminalHeight(),"",previewPreferences);
    localReader.scroll(delta,frame.content.width,frame.content.height);
  }
  function resizeLocalPreview(fraction: number): void {
    if (!localReader.state || !Number.isFinite(fraction)) return;
    const frame = treePreviewFrame(localReader.state,effects.terminalWidth(),effects.terminalHeight(),"",previewPreferences);
    const key = frame.placement === 'beside' ? 'sideFraction' : 'bottomFraction';
    previewPreferences = {...previewPreferences, [key]: Math.max(.2, Math.min(.8, fraction))};
    effects.invalidate();
  }
  async function handleAction(
    actionId: string,
    origin?: { column: number; row: number },
  ): Promise<void> {
    if (actionId === "tree.preview.close" || actionId === "tree.preview.toggle") {
      const enabled = actionId === "tree.preview.toggle" && !previewPreferences.enabled;
      previewPreferences = {...previewPreferences, enabled};
      if (!enabled) {
        const hadPreview = !!localReader.state;
        localReader.clear();
        try { if (hadPreview) await effects.request({action:"clients.update",clientId:effects.clientId,previewTarget:null}); }
        catch (error) { status = errorMessage(error); }
      } else {
        const selected = rows[selectedIndex];
        if (isBlockTreeRow(selected)) await inspectLocally({kind:"block",blockId:selected.canonicalId});
        else await publishDisplayRowSelection(selected);
      }
      effects.invalidate(); return;
    }
    if (["tree.preview.right", "tree.preview.bottom", "tree.preview.auto"].includes(actionId)) {
      previewPreferences = {...previewPreferences, dock: actionId.split('.').at(-1) as PreviewPreferences['dock']};
      effects.invalidate(); return;
    }
    if (actionId === "tree.preview.grow" || actionId === "tree.preview.shrink") {
      const frame = localReader.state && treePreviewFrame(localReader.state,effects.terminalWidth(),effects.terminalHeight(),"",previewPreferences);
      const fraction = frame?.placement === 'beside' ? previewPreferences.sideFraction : previewPreferences.bottomFraction;
      resizeLocalPreview(fraction + (actionId.endsWith('grow') ? .05 : -.05)); return;
    }
    if(actionId==="tree.preview.focus") {if(localReader.state)localReader.focus(!localReader.state.focused);else status="Select an item to preview it here";effects.invalidate();return;}
    if (mode === "inbox") {
      if (actionId.startsWith('tree.inbox.select:')) {inbox.selectResult(Number(actionId.split(':')[1]));return;}
      if (actionId.startsWith('tree.inbox.preview-target:')) {inbox.selectTarget(Number(actionId.split(':')[1]));return;}
      if (actionId === 'tree.inbox.preview.activity') {inbox.showActivity();return;}
      if (actionId === 'tree.inbox.preview.focus') {inbox.reader.focus(!inbox.reader.state?.focused);return;}
      if (actionId === 'tree.inbox.preview.source' || actionId === 'tree.inbox.preview.output') {
        const role=actionId.endsWith('source')?'source':'output';
        const index=inbox.targets.findIndex(target=>target.role===role);
        if(index>=0)inbox.selectTarget(index);else inbox.notice='No separate output; preview the current Source';
        effects.invalidate();return;
      }
    }
    if(actionId==="tree.inbox.search"&&(mode==="inbox"||(mode==="action-menu"&&actionMenuReturnMode==="inbox"))){mode="inbox";inbox.startSearch();return;}
    if(actionId==="tree.inbox.search.clear"&&mode==="inbox"){await inbox.cancelSearch();return;}
    if (actionId.startsWith("tree.inbox.open-target:") && mode === "inbox") {
      const index=Number(actionId.split(":")[1]);
      if (Number.isInteger(index) && inbox.targets[index]?.role !== "diagnostics" && inbox.targets[index]) {
        inbox.targetIndex=index; await inbox.input("",{name:"return",meta:true});
      }
      return;
    }
    if (mode === "goto" && actionId === "tree.goto.detail") { await goto.accept("detail"); return; }
    if (actionId === "tree.navigation.link" || actionId === "tree.navigation.once") {
      const activeMode=mode === "action-menu" ? actionMenuReturnMode : mode;
      if(activeMode !== "browse" && activeMode !== "inbox") {
        status="Finish or cancel the active edit/filter before changing destinations";
        effects.invalidate();return;
      }
      const state = await effects.request<NavigationLinkState>({action: "navigation.link.get", source: {clientId: effects.clientId, region: "tree"}});
      showOtherDestinations=false;
      placementDirection=null;
      destinationMenu = {state, purpose: actionId === "tree.navigation.link" ? "link" : "open"};
      actionMenuReturnMode = activeMode;
      mode = "action-menu";
      updateActionMenuQuery("");
      status = navigationDestinationStatus(state,destinationMenu.purpose);
      effects.invalidate();
      return;
    }
    if (destinationMenu && actionId === "placement:back") {
      placementDirection=null;updateActionMenuQuery("");effects.invalidate();return;
    }
    if (destinationMenu && placementDirection && actionId.startsWith("placement:")) {
      const anchor=destinationMenu.state.destinations[Number(actionId.split(":")[1])];
      if (!anchor?.placementPaneId) return;
      const direction=placementDirection;
      placementDirection=null;destinationPreview.clear();mode=actionMenuReturnMode;
      await createLinkedDetail({kind:"split",direction,targetPaneId:anchor.placementPaneId});return;
    }
    if (actionId.startsWith("destination:") && destinationMenu) {
      if (/^destination:sidebar-(outliner|tab)-(left|right)$/.test(actionId)) {
        const [,scope,side]=actionId.match(/^destination:sidebar-(outliner|tab)-(left|right)$/)!;
        await createLinkedDetail({kind:"sidebar",scope:scope as "outliner"|"tab",side:side as "left"|"right"});return;
      }
      if(actionId==='destination:place-right'||actionId==='destination:place-below') {
        placementDirection=actionId.endsWith('right')?'right':'down';updateActionMenuQuery("");effects.invalidate();return;
      }
      if(actionId==='destination:other'){showOtherDestinations=!showOtherDestinations;updateActionMenuQuery("");effects.invalidate();return;}
      if(actionId==='destination:new-right'||actionId==='destination:new-below'){
        destinationPreview.clear();mode=actionMenuReturnMode;
        await createLinkedDetail({kind:'split',direction:actionId.endsWith('right')?'right':'down'});return;
      }
      const menu = destinationMenu;
      const destination = actionId === "destination:unlink" ? null : menu.state.destinations[Number(actionId.slice(12))]?.view;
      if (destination === undefined) return;
      destinationMenu = null;placementDirection=null;destinationPreview.clear();
      mode = actionMenuReturnMode;
      try {
      if (menu.purpose === "link") {
        await effects.request({action: "navigation.link.set", source: menu.state.source, destination});
        void navigationDisplay.refresh();
        status = destination ? `Linked: Tree → ${menu.state.destinations.find(entry=>entry.view.clientId===destination.clientId)?.label ?? "Detail"}` : "Open unlinked · choose once or new split";
      } else if (destination) {
        if (mode === "inbox") {
          const blockId = await inbox.resolveContentTarget();
          await effects.navigation.dispatch({kind:"block",blockId},"open",{destination});
        } else await focusDetailReader({destination});
      }
      } catch (error) {
        const failure = errorMessage(error);
        if (mode === "inbox") {
          inbox.notice = failure;
          try { await handleAction(menu.purpose === "link" ? "tree.navigation.link" : "tree.navigation.once"); }
          catch { /* Keep the original failure visible even if discovery is unavailable. */ }
        }
        status = failure;
      }
      effects.invalidate();
      return;
    }
    if (actionId === "tree.menu.open") {
      destinationMenu = null;placementDirection=null;destinationPreview.clear();
      if (mode !== "action-menu") {
        actionMenuReturnMode = mode;
        actionMenuScope = actionScope();
      }
      mode = "action-menu";
      actionMenuOrigin = origin ?? null;
      updateActionMenuQuery("");
      status = "Choose an action";
      effects.invalidate();
      return;
    }
    if (mode === "action-menu" && actionId === "tree.cancel") {
      destinationMenu = null;placementDirection=null;destinationPreview.clear();
      mode = actionMenuReturnMode;
      status = "";
      effects.invalidate();
      return;
    }
    if (mode === "action-menu") mode = actionMenuReturnMode;
    if (actionId === "tree.debug.keys") {
      if(effects.openKeyInspector) effects.openKeyInspector();
      else status="Key inspector is unavailable in this host";
      effects.invalidate();return;
    }
    if (actionId === "tree.inbox.open") {
      if (mode !== "browse") {
        status = "Finish or cancel the Tree editor before opening Inbox activity";
        effects.invalidate();
        return;
      }
      mode = "inbox";
      status = "";
      await inbox.start();
      return;
    }
    if (actionId === "tree.note.assist") {
      const selected = rows[selectedIndex];
      if (!isBlockTreeRow(selected)) status = "Select a note to assist";
      else {
        try {
          await effects.request({ action: "inbox.retry", sourceId: selected.canonicalId });
          status = "Note queued for assistance; open Inbox activity to inspect the result";
        } catch (error) { status = error instanceof Error ? error.message : "Note assistance unavailable"; }
      }
      effects.invalidate();
      return;
    }
    if (actionId === "tree.indentation.toggle") {
      indentationMode = indentationMode === "viewport" ? "selection" : "viewport";
      status = indentationMode === "selection"
        ? "Indentation follows selection · ‹ marks rows extending left of this view"
        : "Indentation fits the whole viewport";
      effects.invalidate();
      return;
    }
    if(actionId.startsWith("tree.breadcrumb.focus:")) {
      let id: string;
      try { id=decodeURIComponent(actionId.slice("tree.breadcrumb.focus:".length)); }
      catch { return; }
      const target=breadcrumbs().find(crumb=>crumb.rowId === id);
      if(target) await focusRoot(target);
      effects.invalidate();return;
    }
    if(actionId === "tree.breadcrumb.left" || actionId === "tree.breadcrumb.right") {
      const path=breadcrumbs();
      breadcrumbStart=Math.max(0,Math.min(path.length-1,(breadcrumbStart ?? 0)+(actionId.endsWith("left") ? -1 : 1)));
      breadcrumbRowId=rows[selectedIndex]?.rowId;
      effects.invalidate();return;
    }
    if (actionId === "tree.pane.new") {
      try { if (!effects.createTreePane) throw new Error("Creating a Tree pane is unavailable in this host");
        await effects.createTreePane(null, "right"); status = "Opened new workspace Tree";
      } catch (error) { status = errorMessage(error); }
      effects.invalidate(); return;
    }
    if(actionId === "tree.root.parent") {
      const path=breadcrumbs();
      if(path.length>1) await focusRoot(path[path.length-2]!);
      else await focusRoot(null);
      effects.invalidate();return;
    }
    if (["tree.root.focus","tree.root.workspace","tree.root.right","tree.root.below","tree.depth.expand","tree.depth.collapse"].includes(actionId)) {
      const row=rows[selectedIndex];
      if(actionId === "tree.root.workspace") await focusRoot(null);
      else if(actionId.startsWith("tree.depth.")) await changeDepth(actionId === "tree.depth.expand");
      else if(isBlockTreeRow(row)) {
        const next={rowId:row.rowId,canonicalId:row.canonicalId,label:row.block.preview};
        if(actionId === "tree.root.focus") await focusRoot(next);
        else if(effects.createTreePane) await effects.createTreePane(next,actionId === "tree.root.right" ? "right" : "down");
        else status = "Creating a Tree split requires a pane host";
      }
      effects.invalidate(); return;
    }
    if (actionId === "tree.detail.right" || actionId === "tree.detail.below") {
      await createDetailPane(actionId === "tree.detail.right" ? "right" : "down");
      return;
    }
    if (actionId === "tree.attention.acknowledge") {
      attention = await effects.request<AttentionClientState>({
        action: "attention.acknowledge",
        input: { targetClientId: effects.clientId },
      });
      status = "Attention cue acknowledged; active marks remain";
      effects.invalidate();
      return;
    }
    if (actionId === "tree.keymap.reload") {
      const result = actionKeymap.reload();
      status = result.ok ? "Outliner keymap reloaded" : `Keymap unchanged: ${result.error}`;
      effects.invalidate();
      return;
    }
    const selected = rows[selectedIndex];
    if (actionId === "tree.reorder.up" || actionId === "tree.reorder.down") {
      const offset = actionId === "tree.reorder.up" ? -1 : 1;
      let preferredRowId: string | null = null;
      if (!isBlockTreeRow(selected)) {
        status = "Select an ordinary block occurrence to reorder";
      } else if (isVirtualBranchRootOccurrence(selected)) {
        preferredRowId = await moveOccurrenceSibling(selected, offset);
      } else if (isVirtualBranchOccurrence(selected)) {
        occurrenceMutationDisabled("reorder");
      } else {
        preferredRowId = await moveSibling(selected, offset);
      }
      if (preferredRowId) {
        await reload(preferredRowId);
        await publishDisplayRowSelection(rows[selectedIndex]);
      }
      effects.invalidate();
      return;
    }
    if (actionId === "tree.authored-links.toggle") {
      if (!isBlockTreeRow(selected)) {
        status = "Select an ordinary block occurrence to show authored links";
        effects.invalidate();
        return;
      }
      if (
        authoredLinksPanel.kind === "open" &&
        authoredLinksPanel.owner.rowId === selected.rowId
      ) {
        authoredLinksGeneration += 1;
        authoredLinksDirty = false;
        authoredLinksPanel = { kind: "closed" };
        recomposeAuthoredRows(selected.rowId);
        status = "Authored links hidden";
        effects.invalidate();
        return;
      }
      authoredLinksGeneration += 1;
      if (selected.kind === "occurrence") collapsedOccurrenceRowIds.delete(selected.rowId);
      else collapsedBlockIds.delete(selected.canonicalId);
      authoredLinksPanel = {
        kind: "open",
        owner: { rowId: selected.rowId, blockId: selected.canonicalId },
        generation: authoredLinksGeneration,
        collapsedGroups: { outlinks: false, resources: false },
        load: { kind: "loading" },
      };
      await reload(selected.rowId, { exactRowIdOnly: true });
      effects.invalidate();
      await refreshAuthoredLinks();
      status = "Authored links shown";
      effects.invalidate();
      return;
    }
    if (actionId === "tree.virtual-branch.open") {
      if (!isBlockTreeRow(selected)) {
        status = "No block selected";
      } else if (!isVirtualBranchDefinition(selected.block)) {
        status = "Selected block is not a virtual branch";
      } else {
        try {
          await effects.openVirtualBranchNavigator(selected.canonicalId);
          status = `Opened virtual navigator for ${selected.block.preview}`;
        } catch (error) {
          status = errorMessage(error);
        }
      }
      effects.invalidate();
      return;
    }
    if (actionId === "tree.bookmarks.open") {
      try {
        const root = await effects.request<Block>({ action: "bookmarks.root" });
        await effects.openVirtualBranchNavigator(root.id, "bookmark");
        status = "Opened Bookmarks";
      } catch (error) {
        status = errorMessage(error);
      }
      effects.invalidate();
      return;
    }
    if (actionId === "tree.bookmark.toggle") {
      if (!isBlockTreeRow(selected)) {
        status = "No block selected";
      } else {
        try {
          const bookmark = await effects.request<BookmarkStatus>({
            action: "bookmarks.status",
            targetBlockId: selected.canonicalId,
          });
          const receipt = await effects.request<BookmarkToggleReceipt>({
            action: "bookmarks.toggle",
            targetBlockId: selected.canonicalId,
            expectedRecordId: bookmark.record?.id ?? null,
          });
          status = receipt.bookmarked ? "Bookmarked" : "Bookmark removed";
        } catch (error) {
          status = errorMessage(error);
        }
      }
      effects.invalidate();
      return;
    }
    if (actionId === "tree.current.reveal") {
      if (!isBlockTreeRow(selected)) {
        status = "No block selected";
      } else {
        try {
          await selectVisibleBlock(selected.canonicalId, {
            recordNavigation: true,
            physicalSource: true,
          });
          effects.focusSelf();
          status = `Revealed source ${selected.block.preview}`;
        } catch (error) {
          status = errorMessage(error);
        }
      }
      effects.invalidate();
      return;
    }
    if (actionId === "tree.reference.open" || actionId === "tree.reference.reveal") {
      if (!isBlockTreeRow(selected)) {
        status = "No block selected";
      } else {
        try {
          await navigateSelectedReference(
            selected,
            actionId === "tree.reference.reveal" ? "reveal" : "open",
          );
        } catch (error) {
          status = errorMessage(error);
        }
      }
      effects.invalidate();
      return;
    }
    const input = actionKeymap.defaultInput(actionId);
    if (!input) {
      status = `${actionKeymap.action(actionId).label} has no direct invocation`;
      effects.invalidate();
      return;
    }
    await handleKeypress(input.str, input.key, "pass", false);
  }

  async function handlePaste(text: string): Promise<void> {
    if (mode === "goto") { goto.paste(text); return; }
    if (mode === "inbox") { inbox.paste(text); return; }
    if (mode === "action-menu") {
      updateActionMenuQuery(actionMenuQuery + text);
    } else if (mode !== "browse" && mode !== "delete" && mode !== "viewer") {
      quickBuffer.insert(text);
    }
    effects.invalidate();
  }

  async function handleKeypress(
    str: string,
    key: TerminalKey,
    inputAction: TerminalInputAction,
    resolveAction = true,
    treePointer = false,
  ): Promise<void> {
    if(resolveAction && inputAction !== "suppress" && mode !== "browse" && mode !== "action-menu" && (key.meta || key.ctrl)) {
      const browseAction=actionKeymap.canonicalize("tree","browse",str,key);
      if(browseAction.actionId === "tree.navigation.link" || browseAction.actionId === "tree.navigation.once") {
        await handleAction(browseAction.actionId);return;
      }
    }
    if (!treePointer && inputAction !== "suppress" && mode === "browse" && localReader.state?.focused) {
      const action=actionKeymap.canonicalize("tree","browse",str,key);
      if(action.suppressed)return;
      if(action.actionId && (action.actionId.startsWith("tree.preview.") || ["tree.preview.focus","tree.preview.close","tree.pane.new","tree.navigation.link","tree.navigation.once","tree.menu.open"].includes(action.actionId))) return handleAction(action.actionId);
      const frame=treePreviewFrame(localReader.state,effects.terminalWidth(),effects.terminalHeight(),"",previewPreferences);
      const delta=key.name==="up"?-1:key.name==="down"?1:key.name==="pageup"?-frame.content.height:key.name==="pagedown"?frame.content.height:0;
      if(delta) scrollLocalPreview(delta);
      else if(key.name==="return") { try {await effects.navigation.dispatch(localReader.state.target,"open");} catch(error){status=errorMessage(error);} }
      else if(!(key.ctrl&&key.name==="q")) return;
      if(!(key.ctrl&&key.name==="q")){effects.invalidate();return;}
    }
    if (resolveAction) {
      const mapped = actionKeymap.canonicalize("tree", actionScope(), str, key);
      if (mapped.suppressed) return;
      if (mapped.actionId) {
        await handleAction(mapped.actionId);
        return;
      }
      str = mapped.str;
      key = mapped.key;
    }
    if (inputAction === "suppress") return;
    if (key.ctrl && key.name === "q") {
      effects.stop();
      return;
    }
    if (key.ctrl && key.name === "c") {
      if (mode === "inbox" || (mode === "action-menu" && actionMenuReturnMode === "inbox")) { await inbox.close(); return; }
      if (mode !== "browse") {
        mode = "browse";
        resetQuickEditor();
        if (refreshPending) await reload();
      } else {
        status = "⌃Q closes the outliner pane";
      }
      effects.invalidate();
      return;
    }
    const detailHandoffRequested = inputAction === "modified-enter" || (key.name === "e" && key.ctrl);

    if (mode === "viewer") {
      const page = Math.max(1, effects.terminalHeight() - 4);
      const maxOffset = Math.max(0, viewerLines.length - 1);
      if (key.name === "escape" || key.name === "q") {
        mode = "browse";
        if (refreshPending) await reload();
      } else if (key.name === "up") viewerOffset = Math.max(0, viewerOffset - 1);
      else if (key.name === "down") viewerOffset = Math.min(maxOffset, viewerOffset + 1);
      else if (key.name === "pageup") viewerOffset = Math.max(0, viewerOffset - page);
      else if (key.name === "pagedown") viewerOffset = Math.min(maxOffset, viewerOffset + page);
      else if (str === "g") viewerOffset = 0;
      else if (str === "G") viewerOffset = Math.max(0, viewerLines.length - page);
      effects.invalidate();
      return;
    }
    if (mode === "action-menu") {
      const items = filteredActionMenuItems();
      if (key.name === "escape") {
        mode = actionMenuReturnMode;
        status = "";
        destinationMenu=null;destinationPreview.clear();
      } else if (key.name === "up") {
        actionMenuIndex = Math.max(0, actionMenuIndex - 1);
      } else if (key.name === "down") {
        actionMenuIndex = Math.min(Math.max(0, items.length - 1), actionMenuIndex + 1);
      } else if (key.name === "return") {
        const action = items[actionMenuIndex];
        if (action) {
          await handleAction(action.id);
          return;
        }
      } else if (key.name === "backspace") {
        updateActionMenuQuery([...actionMenuQuery].slice(0, -1).join(""));
      } else if (isPrintableInput(str, key)) {
        updateActionMenuQuery(actionMenuQuery + str);
      }
      if(destinationMenu)updateDestinationPreview();
      effects.invalidate();
      return;
    }

    if (mode === "delete") {
      const selected = rows[selectedIndex];
      if (str.toLowerCase() === "y" && isBlockTreeRow(selected)) {
        const fallback = fallbackRowBeforeDelete(rows, selectedIndex, physicalBlocksById);
        await publishBrowsingContext(fallback?.canonicalId ?? null);
        await effects.request({ action: "delete", blockId: selected.canonicalId });
        await reload(fallback?.rowId ?? null, { exactRowIdOnly: true });
        const visible = rows[selectedIndex];
        lastVisibleCanonicalId = isBlockTreeRow(visible) ? visible.canonicalId : null;
        status = "Moved to Trash";
      } else if (refreshPending) {
        await reload();
      }
      mode = "browse";
      effects.invalidate();
      return;
    }


    if (mode === "goto") { await goto.input(str, key); return; }
    if (mode === "inbox") { await inbox.input(str, key); return; }

    if (mode !== "browse") {
      if (quickCompletion) {
        if (key.name === "up") moveQuickCompletion(-1);
        else if (key.name === "down") moveQuickCompletion(1);
        else if (key.name === "return" || key.name === "tab") applyQuickCompletion();
        else if (key.name === "escape") quickCompletion = null;
        effects.invalidate();
        return;
      }

      if (mode !== "filter" && mode !== "purge" && detailHandoffRequested) {
        await handoffToDetail();
        return;
      }
      if (key.name === "escape") {
        mode = "browse";
        resetQuickEditor();
        if (refreshPending) await reload();
      } else if (key.name === "return") {
        await finishInput();
        return;
      } else if (key.name === "tab" && mode !== "purge") {
        await openQuickCompletion();
      } else {
        updateQuickBuffer(str, key);
      }
      effects.invalidate();
      return;
    }

    const selected = rows[selectedIndex];
    let preferredRowId: string | undefined;
    let reloadRequired = false;
    let queueSelectionPublication = false;
    const historyDirection = historyNavigationDirection(key);
    if (historyDirection) {
      await navigateTreeHistory(historyDirection);
      effects.invalidate();
      return;
    }
    if (selected && !isBlockTreeRow(selected)) {
      if (key.name === "q") {
        status = "Outliner remains open; ⌃Q closes this pane";
      } else if (key.name === "up" || key.name === "down") {
        const delta = key.name === "up" ? -1 : 1;
        selectedIndex = Math.max(0, Math.min(rows.length - 1, selectedIndex + delta));
        resetExpandedBlockPaging();
        queueDisplayRowSelection(rows[selectedIndex]);
      } else if (key.name === "left") {
        if (selected.kind === "authored-link-header" && !selected.collapsed) {
          await handleDisclosure(selected.rowId);
          return;
        }
        const targetRowId = selected.kind === "authored-link-header"
          ? selected.owner.rowId
          : authoredLinkHeaderRowId(selected.owner.rowId, selected.group);
        const targetIndex = rows.findIndex((row) => row.rowId === targetRowId);
        if (targetIndex >= 0) {
          selectedIndex = targetIndex;
          await publishDisplayRowSelection(rows[selectedIndex]);
        }
      } else if (
        selected.kind === "authored-link-header" &&
        (key.name === "right" || key.name === "space" || key.name === "return")
      ) {
        await handleDisclosure(selected.rowId);
        return;
      } else if (key.name === "return" || detailHandoffRequested) {
        await focusDetailReader();
        return;
      } else if (key.name === "pageup" || key.name === "pagedown" || isDetailToggle(str, key)) {
        status = "Authored-link rows are single-line";
      } else if (str === "g") {
        await beginInput("goto");
        return;
      } else if (str === "/") {
        await beginInput("filter", activeFilter);
        return;
      } else if (key.name === "escape" && activeFilter) {
        activeFilter = "";
        await reload(selected.rowId, { exactRowIdOnly: true });
        await publishDisplayRowSelection(rows[selectedIndex]);

      } else {
        status = "Authored-link rows are read-only; Enter opens the target";
      }
      effects.invalidate();
      return;
    }
    if (key.name === "q") {
      status = "Outliner remains open; ⌃Q closes this pane";
    } else if (isDetailToggle(str, key)) {
      if (!selected) {
        status = "No block selected";
      } else {
        resetExpandedBlockPaging();
        const expanded = !multilineExpandedRowIds.delete(selected.rowId);
        if (expanded) multilineExpandedRowIds.add(selected.rowId);
        status = expanded ? "Block detail expanded" : "Block detail collapsed";
        preferredRowId = selected.rowId;
        reloadRequired = true;
      }
    } else if (detailHandoffRequested) {
      await handoffToDetail();
      return;
    } else if (key.name === "pageup" || key.name === "pagedown") {
      scrollSelectedExpandedBlock(key.name);
    } else if (key.name === "up") {
      selectedIndex = Math.max(0, selectedIndex - 1);
      queueSelectionPublication = true;
    } else if (key.name === "down") {
      selectedIndex = Math.min(rows.length - 1, selectedIndex + 1);
      queueSelectionPublication = true;
    } else if (key.name === "left" && selected) {
      if (isVirtualBranchOccurrence(selected)) {
        if (!selected.collapsed && selected.hasChildren) {
          collapsedOccurrenceRowIds.add(selected.rowId);
          preferredRowId = selected.rowId;
          reloadRequired = true;
        } else {
          selectedIndex = Math.max(
            0,
            rows.findIndex((row) => row.rowId === selected.parentRowId),
          );
        }
      } else if (!selected.collapsed && selected.hasChildren) {
        collapsedBlockIds.add(selected.canonicalId);
        reloadRequired = true;
      } else if (selected.block.parentId) {
        selectedIndex = Math.max(
          0,
          rows.findIndex((row) => row.rowId === selected.block.parentId),
        );
      }
    } else if (key.name === "right" && selected) {
      if (isVirtualBranchOccurrence(selected)) {
        if (selected.collapsed) {
          collapsedOccurrenceRowIds.delete(selected.rowId);
          preferredRowId = selected.rowId;
          reloadRequired = true;
        } else if (selected.hasChildren) {
          const childIndex = rows.findIndex((row) =>
            isBlockTreeRow(row) &&
            isVirtualBranchOccurrence(row) &&
            row.parentRowId === selected.rowId
          );
          if (childIndex >= 0) selectedIndex = childIndex;
        }
      } else if (selected.collapsed) {
        collapsedBlockIds.delete(selected.canonicalId);
        reloadRequired = true;
      } else if (selected.hasChildren) selectedIndex = Math.min(rows.length - 1, selectedIndex + 1);
    } else if (str === "r" && selected?.block.deletedAt) {
      await effects.request({ action: "trash.restore", blockId: selected.canonicalId });
      status = "Restored from Trash";
      reloadRequired = true;
    } else if (str === "p" && selected?.block.deletedAt) {
      const required =
        selected.block.properties.find((property) => property.key === "work-id")?.value
        ?? selected.canonicalId.slice(0, 8);
      status = `Type ${required} to permanently purge`;
      await beginInput("purge");
      return;
    } else if (key.name === "return" && selected) {
      await focusDetailReader();
      return;
    } else if (str === "e" && selected) {
      if (selected.block.effectiveDeletedRootId) {
        status = "Block is in Trash; open it read-only with ↵";
        effects.invalidate();
        return;
      }
      const exact = await effects.request<Block>({ action: "get", blockId: selected.canonicalId });
      if (exact.text.includes("\n")) {
        await handoffToDetail();
        return;
      }
      quickEditSource = { id: exact.id, revision: exact.revision };
      await beginInput("edit", exact.text);
      return;
    } else if (key.name === "tab" && selected) {
      if (isVirtualBranchOccurrence(selected)) {
        occurrenceMutationDisabled(key.shift ? "outdent" : "indent");
      } else {
        if (key.shift) await outdent(selected);
        else await indent(selected);
        preferredRowId = selected.canonicalId;
        reloadRequired = true;
      }
    } else if (key.name === "space" && selected) {
      if (isVirtualBranchOccurrence(selected)) {
        if (selected.hasChildren) {
          if (!collapsedOccurrenceRowIds.delete(selected.rowId)) {
            collapsedOccurrenceRowIds.add(selected.rowId);
          }
          preferredRowId = selected.rowId;
          reloadRequired = true;
        }
      } else {
        if (!collapsedBlockIds.delete(selected.canonicalId)) {
          collapsedBlockIds.add(selected.canonicalId);
        }
        reloadRequired = true;
      }
    } else if (str === "c" && selected) {
      try {
        await effects.openCapturePopup(selected.canonicalId);
        status = "Opened quick capture popup";
      } catch (error) {
        status = errorMessage(error);
      }
      effects.invalidate();
      return;
    } else if (str === "a" && selected) {
      if (isVirtualBranchOccurrence(selected)) {
        occurrenceMutationDisabled("add-child");
      } else {
        const problem = virtualBranchCreationProblem(selected);
        if (problem) status = problem;
        else {
          await beginInput("add-child");
          return;
        }
      }
    } else if (str === "s" && selected) {
      if (isVirtualBranchOccurrence(selected)) {
        occurrenceMutationDisabled("add-sibling");
      } else {
        await beginInput("add-sibling");
        return;
      }
    } else if (str === "g") {
      await beginInput("goto");
      return;
    } else if (str === "/") {
      await beginInput("filter", activeFilter);
      return;
    } else if (key.name === "delete" && selected) mode = "delete";
    else if (str === "f" && selected) await openReferencedFile(selected.block);
    else if (key.name === "escape" && activeFilter) {
      activeFilter = "";
      reloadRequired = true;
    }

    if (rows[selectedIndex]?.rowId !== selected?.rowId) resetExpandedBlockPaging();
    if (reloadRequired) await reload(preferredRowId);
    const visible = rows[selectedIndex];
    if (visible?.rowId !== selected?.rowId || reloadRequired) {
      if (queueSelectionPublication) queueDisplayRowSelection(visible);
      else await publishDisplayRowSelection(visible);
    }
    effects.invalidate();
  }

  async function initialize(): Promise<void> {
    void navigationDisplay.refresh();
    await reload();
    await publishDisplayRowSelection(rows[selectedIndex]);
    await inbox.refresh();
  }
  return {
    focusLocalPreview,
    scrollLocalPreview,
    resizeLocalPreview,
    setViewportStart(index, page) {
      scrollStartEntryIndex = index;
      expandedPage = page ?? null;
      if (page) expandedBlockOffset = page.offset;
    },
    setBreadcrumbStart(index) { breadcrumbStart=index;breadcrumbRowId=rows[selectedIndex]?.rowId; },
    view,
    async revealBlock(blockId) {
      if (mode !== "browse") throw new Error("Finish or cancel the Tree editor before navigating");
      await selectVisibleBlock(blockId, { recordNavigation: true, physicalSource: true });
      effects.focusSelf();
      effects.invalidate();
    },
    initialize,
    handleKeypress,
    handleTreeWheel: async direction => {if(mode === "inbox") {inbox.reader.focus(false);inbox.move(direction === "up"?-1:1);}else await handleKeypress("", {name: direction}, "pass", false, true);},
    handlePaste,
    handleGotoMouse,
    handleDisclosure,
    handleRowClick,
    handleAction,
    handleServiceEvent,
    handleConnect,
    handleDisconnect,
    handleError,
  };
}
