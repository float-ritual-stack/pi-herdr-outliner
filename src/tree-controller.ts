import type { RequestInput } from "./client";
import {
  authoredTextDigest,
  decodeAuthoredLinksSnapshot,
} from "./authored-links";
import { emptyAttentionState } from "./attention";
import {
  formatBlockFocusMatch,
  rankBlockFocusMatches,
  uniqueBlockFocusIdentifier,
} from "./block-focus";
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
import type { ReferencedFile, ReferencedPathCandidate } from "./files";
import {
  firstOutlinerReference,
  resolveOutlinerLinkTarget,
} from "./outliner-links";
import { blockDisplayTitle } from "./references";
import {
  DEFAULT_OUTLINER_ACTION_KEYMAP,
  filterActionMenuItems,
  type OutlinerActionKeymap,
  type OutlinerActionMenuItem,
} from "./outliner-actions";
import { dispatchNavigation } from "./navigation-routes";
import { layoutExpandedBlock } from "./tree-layout";
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
  type TreeDisplayRow,
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
  OutlinerNavigationDispatch,
  OutlinerNavigationResolution,
  BrowsingContextPublication,
  OutlinerNavigationTarget,
  PageAddressCollection,
  PropertyCatalogItem,
  VisibleBlock,
  VisibleBlockCollection,
  WorkspaceSnapshot,
} from "./types";
import {
  buildVirtualBranchCreationText,
  decorateVirtualBranchDefinitionText,
  isVirtualBranchOccurrence,
  isVirtualBranchRootOccurrence,
  projectVirtualBranches,
  type PhysicalTreeRow,
  type TreeRow,
  type VirtualBranchOccurrenceRow,
  type VirtualBranchState,
  type TreePresentationState,
} from "./virtual-branches";

export type TreeInputMode =
  | "edit"
  | "add-child"
  | "add-sibling"
  | "filter"
  | "goto"
  | "purge";
export type TreeMode = "browse" | "delete" | "viewer" | "action-menu" | TreeInputMode;

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

export interface TreeView {
  readonly workspaceRoot: string;
  readonly rows: readonly TreeDisplayRow[];
  readonly physicalBlocksById: ReadonlyMap<string, VisibleBlock>;
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
}

export interface TreeFilesystem {
  completeReferencedPaths(prefix: string): ReferencedPathCandidate[];
  readReferencedFile(block: Block): ReferencedFile;
}

export interface TreeControllerEffects {
  readonly workspaceRoot: string;
  readonly clientId: string;
  readonly browsingContextId: string;
  request<T>(input: RequestInput): Promise<T>;
  readonly filesystem: TreeFilesystem;
  createDetailPane(blockId: string, direction?: "right" | "down"): Promise<void>;
  openCapturePopup(capturedFromBlockId: string): Promise<void>;
  openVirtualBranchNavigator(viewId: string, adapter?: "bookmark"): void | Promise<void>;
  focusSelf(): void;
  terminalWidth(): number;
  terminalHeight(): number;
  stop(): void;
  invalidate(): void;
  readonly actionKeymap?: OutlinerActionKeymap;
}

export interface TreeController {
  view(): TreeView;
  initialize(): Promise<void>;
  handleKeypress(str: string, key: TerminalKey, inputAction: TerminalInputAction): Promise<void>;
  handlePaste(text: string): void;
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
  readonly rowId: string;
  readonly canonicalId: string;
}

interface PendingBrowsingPublication {
  readonly target: OutlinerNavigationTarget | null;
  readonly dispatchPreview: boolean;
}
const MAX_TREE_HISTORY_ENTRIES = 200;

const GOTO_PROMPT = "Type a block ID, short prefix, or fuzzy text";

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
  physicalBlocksById: ReadonlyMap<string, VisibleBlock>,
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
  let physicalBlocksById = new Map<string, VisibleBlock>();
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
  let actionMenuQuery = "";
  let pendingBrowsingPublication: PendingBrowsingPublication | null = null;
  let browsingPublicationPump: Promise<void> | null = null;

  function filteredActionMenuItems(): OutlinerActionMenuItem[] {
    const selected = rows[selectedIndex];
    let items = actionKeymap.menuItems("tree", "browse");
    if (isBlockTreeRow(selected)) {
      const hiding = authoredLinksPanel.kind === "open" &&
        authoredLinksPanel.owner.rowId === selected.rowId;
      items = items.map((item) =>
        item.id === "tree.authored-links.toggle"
          ? { ...item, label: hiding ? "Hide authored links" : "Show authored links" }
          : item
      );
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

  function updateActionMenuQuery(query: string): void {
    actionMenuQuery = query;
    actionMenuIndex = 0;
  }

  function quickInputText(): string {
    return quickBuffer.lines[quickBuffer.row] ?? "";
  }

  function view(): TreeView {
    return {
      workspaceRoot: effects.workspaceRoot,
      rows,
      physicalBlocksById,
      physicalRowCount,
      occurrenceRowCount,
      workIdPrefix,
      visibleCompleteness,
      workspaceContextBlockId,
      branchStates,
      selectedIndex,
      activeFilter,
      mode,
      quickInput: quickInputText(),
      quickColumn: quickBuffer.column,
      quickCompletion,
      viewerLines,
      viewerPath,
      viewerOffset,
      expandedBlockOffset,
      status,
      refreshPending,
      attention,
      actionHelpText: actionKeymap.helpText("tree", mode),
      actionMenuItems: mode === "action-menu" ? filteredActionMenuItems() : [],
      actionMenuOrigin,
      actionMenuIndex,
      actionMenuQuery,
    };
  }

  function panelOwnerBlock(): VisibleBlock | null {
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
          decoded.ownerTextDigest !== authoredTextDigest(currentOwner.text)
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
    const snapshot = await effects.request<WorkspaceSnapshot>({
      action: "workspace.snapshot",
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
    if (snapshot.physical.completeness.kind === "truncated") {
      throw new Error(
        `Workspace snapshot physical blocks are truncated at ${snapshot.physical.completeness.limit}; canonical ancestry is unavailable`,
      );
    }

    const presentation: TreePresentationState = {
      collapsedBlockIds: activeFilter ? uncollapsedPresentationIds : collapsedBlockIds,
      collapsedOccurrenceRowIds,
      multilineExpandedRowIds,
    };
    const projection = await projectVirtualBranches(
      snapshot.visible.blocks,
      snapshot.physical.blocks,
      (query) => effects.request<VisibleBlockCollection>({ action: "blocks.query", query }),
      snapshot.virtualOccurrenceRanks,
      presentation,
    );
    baseRows = projection.rows;
    physicalBlocksById = new Map(snapshot.physical.blocks.map((block) => [block.id, block]));
    if (authoredLinksPanel.kind === "open" && authoredLinksPanel.load.kind === "ready") {
      const loaded = authoredLinksPanel.load.snapshot;
      const owner = panelOwnerBlock();
      if (
        loaded.kind === "ready" &&
        owner &&
        loaded.ownerTextDigest !== authoredTextDigest(owner.text)
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
    const serviceSelectedId = snapshot.selection.selected?.id ?? null;
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

  function expandedBlockRowCount(row: TreeRow): number {
    let marker = row.kind === "occurrence" ? "◇" : "•";
    if (row.hasChildren) marker = row.collapsed ? "▸" : "▾";
    const branchState = row.kind === "physical" ? branchStates.get(row.canonicalId) : undefined;
    const displayText = decorateVirtualBranchDefinitionText(row.block.displayText, branchState);
    return layoutExpandedBlock({
      text: displayText,
      width: effects.terminalWidth(),
      depth: row.depth,
      marker,
      author: " ",
    }).length;
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
    const totalRows = expandedBlockRowCount(selected);
    const pageSize = Math.max(1, effects.terminalHeight() - 6);
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
    quickCompletion = null;
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
    quickBuffer = new TextBuffer(initial);
    quickBuffer.moveEnd();
    quickCompletion = null;
    effects.invalidate();
  }

  function refreshGotoCompletion(): void {
    const query = quickInputText().trim();
    if (!query) {
      quickCompletion = null;
      status = GOTO_PROMPT;
      return;
    }
    const matches = rankBlockFocusMatches(
      [...physicalBlocksById.values()],
      query,
      20,
    );
    if (matches.length === 0) {
      quickCompletion = null;
      status = `No block matches: ${query}`;
      return;
    }
    quickCompletion = {
      start: 0,
      end: quickInputText().length,
      index: 0,
      items: matches.map((match) => ({
        label: formatBlockFocusMatch(
          match,
          uniqueBlockFocusIdentifier(match.block.id, matches),
        ),
        insertion: match.block.id,
        blockId: match.block.id,
      })),
      truncatedLimit: null,
    };
    status = "";
  }

  async function acceptGotoCompletion(): Promise<void> {
    const item = quickCompletion?.items[quickCompletion.index];
    if (!item?.blockId) {
      status = "No matching block selected";
      return;
    }
    const blockId = item.blockId;
    const label = item.label;
    mode = "browse";
    resetQuickEditor();
    await selectVisibleBlock(blockId, { recordNavigation: true });
    status = `Focused ${label}`;
    effects.invalidate();
  }


  async function commitQuickBlock(): Promise<string | null> {
    const selected = rows[selectedIndex];
    if (!isBlockTreeRow(selected)) return null;
    const text = quickInputText();
    if (!text.trim()) return mode === "edit" ? selected.canonicalId : null;

    if (mode === "edit") {
      await effects.request<Block>({
        action: "update",
        blockId: selected.canonicalId,
        text,
        expectedRevision: selected.block.revision,
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
    return isBlockTreeRow(row) ? { rowId: row.rowId, canonicalId: row.canonicalId } : null;
  }

  function sameNavigationEntry(
    left: TreeNavigationEntry | null | undefined,
    right: TreeNavigationEntry | null | undefined,
  ): boolean {
    return left?.rowId === right?.rowId && left?.canonicalId === right?.canonicalId;
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

  async function drainBrowsingPublications(): Promise<void> {
    while (pendingBrowsingPublication) {
      const desired = pendingBrowsingPublication;
      pendingBrowsingPublication = null;
      const publication = await effects.request<BrowsingContextPublication>({
        action: "browsing-context.publish",
        sourceClientId: effects.clientId,
        contextId: effects.browsingContextId,
        target: desired.target,
        ...(desired.dispatchPreview ? {} : { dispatchPreview: false }),
      });
      if (!pendingBrowsingPublication) {
        workspaceContextBlockId =
          desired.target?.kind === "block" ? desired.target.blockId : null;
        if (publication.unavailable) {
          status = publication.unavailable;
          browsingPublicationStatus = publication.unavailable;
        } else if (status === browsingPublicationStatus) {
          status = "";
          browsingPublicationStatus = "";
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
    pendingBrowsingPublication = { target, dispatchPreview };
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
      await publishBrowsingTarget(target, false);
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

  async function focusDetailReader(): Promise<void> {
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
        await dispatchNavigation(
          effects,
          effects.clientId,
          target,
          "open",
          { preserveSource: true },
        );
        status = createdPage
          ? "Page created and opened in first unlocked Detail"
          : createdResource
          ? "Resource created and opened in first unlocked Detail"
          : "Authored target opened in first unlocked Detail";
      } catch (error) {
        status = errorMessage(error);
      }
      effects.invalidate();
      return;
    }
    try {
      await dispatchNavigation(effects, effects.clientId, {
        kind: "block",
        blockId: selected.canonicalId,
      }, "open");
      status = "Reader opened in first unlocked Detail";
    } catch (error) {
      status = errorMessage(error);
    }
    effects.invalidate();
  }

  async function createDetailPane(direction: "right" | "down" = "down"): Promise<void> {
    const selected = rows[selectedIndex];
    if (!isBlockTreeRow(selected)) {
      status = "Open authored targets in the existing Detail";
      effects.invalidate();
      return;
    }
    try {
      await effects.createDetailPane(selected.canonicalId, direction);
      status = `Opened new independent Detail ${direction} for ${blockDisplayTitle(selected.block)}`;
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
      const destination = await effects.request<OutlinerNavigationResolution>({
        action: "navigation.resolve",
        sourceClientId: effects.clientId,
        intent: "open",
      });
      await effects.request({
        action: "ui.command.send",
        command: {
          targetClientId: destination.targetClientId,
          command: "edit",
          target: { kind: "block", blockId: targetId },
        },
      });
      status = "Multiline editor opened and locked in first unlocked Detail";
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
      items = effects.filesystem.completeReferencedPaths(target.query).map((candidate) => ({
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
      const collection = await effects.request<VisibleBlockCollection>({
        action: "blocks.query",
        query: { text: target.query || undefined, limit: 20 },
      });
      if (collection.completeness.kind === "truncated") {
        truncatedLimit = collection.completeness.limit;
      }
      items = collection.blocks.map((block) => ({
        label: blockDisplayTitle(block),
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

  function openReferencedFile(block: Block): void {
    try {
      const file = effects.filesystem.readReferencedFile(block);
      viewerLines = file.lines;
      viewerPath = `${file.displayPath}${file.firstLine > 1 ? `:${file.firstLine}` : ""}`;
      viewerOffset = 0;
      mode = "viewer";
      status = "";
    } catch (error) {
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
      if (mode !== "browse") {
        refreshPending = true;
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
      await effects.request({ action: "navigation.dispatch", sourceClientId: effects.clientId, target: { kind: "block", blockId: canonical.id }, intent: "open", });
      status = "Navigation history opened deleted block read-only in first unlocked Detail";
      return;
    }

    await selectVisibleBlock(canonical.id, { preferredRowId: target.rowId });
    status = direction === "back" ? "Navigation back" : "Navigation forward";
  }

  async function handleConnect(): Promise<void> {
    resetExpandedBlockPaging();
    status = "";
    attention = await effects.request<AttentionClientState>({
      action: "attention.get",
      targetClientId: effects.clientId,
    });
    if (mode === "browse") {
      if (authoredLinksPanel.kind === "open") authoredLinksDirty = true;
      await reload();
      await publishDisplayRowSelection(rows[selectedIndex]);
    } else {
      refreshPending = true;
      if (authoredLinksPanel.kind === "open") authoredLinksDirty = true;
    }
    effects.invalidate();
  }

  function handleDisconnect(): void {
    status = "Workspace service disconnected; reconnecting…";
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
    const reference = firstOutlinerReference(selected.block.text, workIdPrefix);
    if (!reference) {
      status = "Selected block has no block or page references";
      return;
    }
    if (reference.kind === "page") {
      await effects.request({
        action: "navigation.resolve",
        sourceClientId: effects.clientId,
        intent,
      });
    }
    const resolved = await resolveOutlinerLinkTarget(effects, reference);
    const dispatched = await effects.request<OutlinerNavigationDispatch>({
      action: "navigation.dispatch",
      sourceClientId: effects.clientId,
      target: {
        kind: "block",
        blockId: resolved.block.id,
        ...(resolved.fragmentId ? { fragmentId: resolved.fragmentId } : {}),
      },
      intent,
      ...(intent === "reveal" ? { focusTarget: true } : {}),
    });
    const verb = intent === "open"
      ? resolved.created ? "Created and opened" : "Opened"
      : "Revealed";
    status = intent === "open"
      ? `${verb} ${blockDisplayTitle(resolved.block)} in first unlocked Detail`
      : `${verb} ${blockDisplayTitle(resolved.block)} · ${dispatched.resolution}`;
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

  async function handleAction(
    actionId: string,
    origin?: { column: number; row: number },
  ): Promise<void> {
    if (actionId === "tree.menu.open") {
      mode = "action-menu";
      actionMenuOrigin = origin ?? null;
      updateActionMenuQuery("");
      status = "Choose an action";
      effects.invalidate();
      return;
    }
    if (mode === "action-menu") mode = "browse";
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
          status = `Opened virtual navigator for ${blockDisplayTitle(selected.block)}`;
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
          status = `Revealed source ${blockDisplayTitle(selected.block)}`;
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

  function handlePaste(text: string): void {
    if (mode === "action-menu") {
      updateActionMenuQuery(actionMenuQuery + text);
    } else if (mode !== "browse" && mode !== "delete" && mode !== "viewer") {
      quickBuffer.insert(text);
      if (mode === "goto") refreshGotoCompletion();
    }
    effects.invalidate();
  }

  async function handleKeypress(
    str: string,
    key: TerminalKey,
    inputAction: TerminalInputAction,
    resolveAction = true,
  ): Promise<void> {
    if (resolveAction) {
      const mapped = actionKeymap.canonicalize("tree", mode, str, key);
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
        mode = "browse";
        status = "";
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


    if (mode === "goto") {
      if (key.name === "escape") {
        mode = "browse";
        resetQuickEditor();
        status = "";
        if (refreshPending) await reload();
      } else if (key.name === "up") {
        moveQuickCompletion(-1);
      } else if (key.name === "down") {
        moveQuickCompletion(1);
      } else if (key.name === "tab") {
        if (!quickCompletion) refreshGotoCompletion();
        else moveQuickCompletion(key.shift ? -1 : 1, true);
      } else if (key.name === "return") {
        if (!quickCompletion) refreshGotoCompletion();
        if (quickCompletion) await acceptGotoCompletion();
        return;
      } else {
        const queryChanged = updateQuickBuffer(str, key);
        if (queryChanged) refreshGotoCompletion();
      }
      effects.invalidate();
      return;
    }

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
        status = GOTO_PROMPT;
        await beginInput("goto");
        return;
      } else if (str === "/") {
        await beginInput("filter", activeFilter);
        return;
      } else if (key.name === "escape" && activeFilter) {
        activeFilter = "";
        await reload(selected.rowId, { exactRowIdOnly: true });
        await publishDisplayRowSelection(rows[selectedIndex]);
      } else if (str === "L") {
        status = "Lock or unlock from a Detail pane";
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
    } else if (key.shift && key.name === "up") {
      if (selected && isVirtualBranchRootOccurrence(selected)) {
        const movedRowId = await moveOccurrenceSibling(selected, -1);
        if (movedRowId) {
          preferredRowId = movedRowId;
          reloadRequired = true;
        }
      } else if (selected && isVirtualBranchOccurrence(selected)) {
        occurrenceMutationDisabled("reorder");
      } else if (selected) {
        preferredRowId = await moveSibling(selected, -1);
        reloadRequired = true;
      }
    } else if (key.shift && key.name === "down") {
      if (selected && isVirtualBranchRootOccurrence(selected)) {
        const movedRowId = await moveOccurrenceSibling(selected, 1);
        if (movedRowId) {
          preferredRowId = movedRowId;
          reloadRequired = true;
        }
      } else if (selected && isVirtualBranchOccurrence(selected)) {
        occurrenceMutationDisabled("reorder");
      } else if (selected) {
        preferredRowId = await moveSibling(selected, 1);
        reloadRequired = true;
      }
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
      if (selected.block.text.includes("\n")) {
        await handoffToDetail();
        return;
      }
      await beginInput("edit", selected.block.text);
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
      status = GOTO_PROMPT;
      await beginInput("goto");
      return;
    } else if (str === "/") {
      await beginInput("filter", activeFilter);
      return;
    } else if (str === "d" && selected) {
      await createDetailPane("right");
      return;
    } else if (str === "D" && selected) {
      await createDetailPane("down");
      return;
    } else if (key.name === "delete" && selected) mode = "delete";
    else if (str === "f" && selected) openReferencedFile(selected.block);
    else if (str === "L") {
      status = "Lock or unlock from a Detail pane";
      effects.invalidate();
      return;
    } else if (key.name === "escape" && activeFilter) {
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
    await reload();
    await publishDisplayRowSelection(rows[selectedIndex]);
  }
  return {
    view,
    initialize,
    handleKeypress,
    handlePaste,
    handleDisclosure,
    handleRowClick,
    handleAction,
    handleServiceEvent,
    handleConnect,
    handleDisconnect,
    handleError,
  };
}
