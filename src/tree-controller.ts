import type { RequestInput } from "./client";
import {
  formatBlockFocusMatch,
  rankBlockFocusMatches,
  uniqueBlockFocusIdentifier,
} from "./block-focus";
import { completionTargetAtCursor } from "./completion";
import type { ReferencedFile, ReferencedPathCandidate } from "./files";
import { parseFilter } from "./properties";
import { blockDisplayTitle } from "./references";
import { layoutExpandedBlock } from "./tree-layout";
import { isDetailToggle, isPrintableInput, type TerminalInputAction, type TerminalKey } from "./terminal";
import { TextBuffer } from "./text-buffer";
import type {
  Block,
  BlockCollectionCompleteness,
  OutlinerEvent,
  VisibleBlock,
  VisibleBlockCollection,
  WorkspaceSnapshot,
} from "./types";
import {
  buildVirtualBranchCreationText,
  decorateVirtualBranchDefinitionText,
  isVirtualBranchOccurrence,
  projectVirtualBranches,
  type PhysicalTreeRow,
  type TreeRow,
  type VirtualBranchState,
} from "./virtual-branches";

export type TreeInputMode = "edit" | "add-child" | "add-sibling" | "filter" | "goto";
export type TreeMode = "browse" | "delete" | "viewer" | TreeInputMode;

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
  readonly rows: readonly TreeRow[];
  readonly physicalBlocksById: ReadonlyMap<string, VisibleBlock>;
  readonly visibleCompleteness: BlockCollectionCompleteness;
  readonly branchStates: ReadonlyMap<string, VirtualBranchState>;
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
}

export interface TreeFilesystem {
  completeReferencedPaths(prefix: string): ReferencedPathCandidate[];
  readReferencedFile(block: Block): ReferencedFile;
}

export interface TreeControllerEffects {
  readonly workspaceRoot: string;
  request<T>(input: RequestInput): Promise<T>;
  readonly filesystem: TreeFilesystem;
  focusPane(pane: "detail" | "outliner"): void;
  terminalWidth(): number;
  terminalHeight(): number;
  stop(): void;
  invalidate(): void;
}

export interface TreeController {
  view(): TreeView;
  initialize(): Promise<void>;
  handleKeypress(str: string, key: TerminalKey, inputAction: TerminalInputAction): Promise<void>;
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

const GOTO_PROMPT = "Type a block ID, short prefix, or fuzzy text";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rowIndexForIdentity(
  rows: readonly TreeRow[],
  rowId: string,
  canonicalId = rowId,
): number {
  const exactIndex = rows.findIndex((row) => row.rowId === rowId);
  if (exactIndex >= 0) return exactIndex;
  const physicalIndex = rows.findIndex(
    (row) => row.kind === "physical" && row.canonicalId === canonicalId,
  );
  if (physicalIndex >= 0) return physicalIndex;
  return rows.findIndex((row) => row.canonicalId === canonicalId);
}

export function createTreeController(effects: TreeControllerEffects): TreeController {
  let rows: TreeRow[] = [];
  let physicalBlocksById = new Map<string, VisibleBlock>();
  let visibleCompleteness: BlockCollectionCompleteness = { kind: "complete" };
  let branchStates = new Map<string, VirtualBranchState>();
  let selectedIndex = 0;
  let activeFilter = "";
  let mode: TreeMode = "browse";
  let quickBuffer = new TextBuffer();
  let quickCompletion: MutableQuickCompletion | null = null;
  let viewerLines: string[] = [];
  let viewerPath = "";
  let viewerOffset = 0;
  let expandedBlockOffset = 0;
  let lastSelectionId: string | null = null;
  let status = "";
  let refreshPending = false;

  function quickInputText(): string {
    return quickBuffer.lines[0] ?? "";
  }

  function view(): TreeView {
    return {
      workspaceRoot: effects.workspaceRoot,
      rows,
      physicalBlocksById,
      visibleCompleteness,
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
    };
  }

  async function reload(preferredSelectedId?: string | null): Promise<boolean> {
    const currentSelected = rows[selectedIndex];
    const snapshot = await effects.request<WorkspaceSnapshot>({
      action: "workspace.snapshot",
      view: { filters: parseFilter(activeFilter) },
    });
    if (snapshot.physical.completeness.kind === "truncated") {
      throw new Error(
        `Workspace snapshot physical blocks are truncated at ${snapshot.physical.completeness.limit}; canonical ancestry is unavailable`,
      );
    }

    const projection = await projectVirtualBranches(
      snapshot.visible.blocks,
      snapshot.physical.blocks,
      (query) => effects.request<VisibleBlockCollection>({ action: "blocks.query", query }),
    );
    const nextRows = projection.rows;
    const nextPhysicalBlocksById = new Map(snapshot.physical.blocks.map((block) => [block.id, block]));
    const serviceSelectedId = snapshot.selection.selected?.id ?? null;
    let nextIndex = -1;
    if (preferredSelectedId !== undefined) {
      if (preferredSelectedId) {
        nextIndex = rowIndexForIdentity(nextRows, preferredSelectedId);
      }
    } else if (currentSelected) {
      nextIndex = rowIndexForIdentity(
        nextRows,
        currentSelected.rowId,
        currentSelected.canonicalId,
      );
    }
    if (nextIndex < 0 && preferredSelectedId === undefined && serviceSelectedId) {
      nextIndex = nextRows.findIndex((row) => row.canonicalId === serviceSelectedId);
    }
    const nextSelectedIndex = Math.max(
      0,
      Math.min(nextIndex >= 0 ? nextIndex : selectedIndex, nextRows.length - 1),
    );
    const nextSelectedRow = nextRows[nextSelectedIndex];
    const selectedRowChanged = currentSelected?.rowId !== nextSelectedRow?.rowId;
    const selectedExpansionChanged =
      currentSelected?.multilineExpanded !== nextSelectedRow?.multilineExpanded;
    if (selectedRowChanged || selectedExpansionChanged) resetExpandedBlockPaging();

    rows = nextRows;
    physicalBlocksById = nextPhysicalBlocksById;
    visibleCompleteness = snapshot.visible.completeness;
    branchStates = projection.branchStates;
    selectedIndex = nextSelectedIndex;
    lastSelectionId = rows[selectedIndex]?.canonicalId ?? null;
    refreshPending = false;
    return serviceSelectedId !== null;
  }

  function expandedBlockRowCount(row: TreeRow): number {
    let marker = row.kind === "occurrence" ? "◇" : "•";
    if (row.kind === "physical" && row.hasChildren) {
      marker = row.block.collapsed ? "▸" : "▾";
    }
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
    if (!selected?.multilineExpanded) {
      expandedBlockOffset = 0;
      status = "Expand the selected block before paging within it";
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
    if (nextMode === "add-child" && selected?.block.collapsed) {
      await effects.request({ action: "toggle", blockId: selected.canonicalId });
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
    await selectVisibleBlock(blockId);
    status = `Focused ${label}`;
    effects.invalidate();
  }

  async function commitQuickBlock(): Promise<string | null> {
    const selected = rows[selectedIndex];
    if (!selected) return null;
    const text = quickInputText();
    if (!text.trim()) return mode === "edit" ? selected.canonicalId : null;

    if (mode === "edit") {
      await effects.request<Block>({
        action: "update",
        blockId: selected.canonicalId,
        text,
        expectedUpdatedAt: selected.block.updatedAt,
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

  async function selectVisibleBlock(
    preferredId: string | null,
    preferredRowId?: string,
  ): Promise<void> {
    await reload(preferredRowId ?? preferredId);
    let visibilityChanged = false;
    if (preferredId && rows[selectedIndex]?.canonicalId !== preferredId) {
      const target = physicalBlocksById.get(preferredId);
      if (!target) throw new Error(`Block not found: ${preferredId}`);
      if (activeFilter) {
        activeFilter = "";
        visibilityChanged = true;
      }
      const collapsedAncestorIds: string[] = [];
      let parentId = target.parentId;
      while (parentId) {
        const parent = physicalBlocksById.get(parentId);
        if (!parent) throw new Error(`Block ancestry is incomplete at ${parentId}`);
        if (parent.collapsed) collapsedAncestorIds.push(parent.id);
        parentId = parent.parentId;
      }
      for (const blockId of collapsedAncestorIds.reverse()) {
        await effects.request({ action: "toggle", blockId });
        visibilityChanged = true;
      }
      await reload(preferredId);
    }
    const visibleId = rows[selectedIndex]?.canonicalId ?? null;
    if (preferredId && visibleId !== preferredId) {
      throw new Error(`Block ${preferredId} could not be revealed`);
    }
    lastSelectionId = visibleId;
    await effects.request({ action: "selection.set", blockId: visibleId });
    if (visibilityChanged) status = "Filter cleared or collapsed ancestors expanded to reveal block";
  }

  async function finishInput(): Promise<void> {
    if (mode === "filter") {
      activeFilter = quickInputText().trim();
      mode = "browse";
      resetQuickEditor();
      await selectVisibleBlock(null);
      effects.invalidate();
      return;
    }

    const selected = rows[selectedIndex];
    const editingRowId = mode === "edit" ? selected?.rowId : undefined;
    const committedBlockId = await commitQuickBlock();
    const fallbackId = selected?.canonicalId ?? null;
    mode = "browse";
    resetQuickEditor();
    await selectVisibleBlock(committedBlockId ?? fallbackId, editingRowId);
    effects.invalidate();
  }

  async function handoffToDetail(): Promise<void> {
    const selected = rows[selectedIndex];
    if (!selected) return;
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
    await selectVisibleBlock(targetId, targetRowId);
    await effects.request({
      action: "ui.command.send",
      command: { target: "detail", command: "edit", blockId: targetId },
    });
    try {
      effects.focusPane("detail");
      status = "Multiline editor opened in detail pane";
    } catch (error) {
      status = errorMessage(error);
    }
    effects.invalidate();
  }

  async function openQuickCompletion(): Promise<void> {
    if (mode === "filter") return;
    const line = quickInputText();
    const target = completionTargetAtCursor(line, quickBuffer.column);
    if (!target) {
      status = "Type [[page, ((block, or [file::path before requesting completion";
      return;
    }

    let items: MutableQuickCompletion["items"];
    let truncatedLimit: number | null = null;
    if (target.kind === "file") {
      items = effects.filesystem.completeReferencedPaths(target.query).map((candidate) => ({
        label: candidate.sourcePath,
        insertion: `[file::${candidate.sourcePath}${candidate.isDirectory ? "" : "]"}`,
      }));
    } else {
      let collection: VisibleBlockCollection | undefined;
      if (target.kind === "page") {
        collection = await effects.request<VisibleBlockCollection>({
          action: "blocks.query",
          query: {
            text: target.query || undefined,
            filters: [{ key: "type", value: "page" }],
            limit: 20,
          },
        });
      }
      if (!collection || collection.blocks.length === 0) {
        collection = await effects.request<VisibleBlockCollection>({
          action: "blocks.query",
          query: { text: target.query || undefined, limit: 20 },
        });
      }
      if (collection.completeness.kind === "truncated") {
        truncatedLimit = collection.completeness.limit;
      }
      items = collection.blocks.map((block) => {
        const title = blockDisplayTitle(block);
        return {
          label: title,
          insertion: target.kind === "page" ? `[[${title}]]` : `((${block.id}))`,
        };
      });
    }

    if (items.length === 0) {
      quickCompletion = null;
      status = target.kind === "file" ? "No matching files" : "No matching blocks";
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
    if (event.domain === "ui") {
      const command = event.command;
      if (!command || command.target !== "tree") return;
      if (mode !== "browse") {
        refreshPending = true;
        return;
      }
      if (command.blockId) {
        activeFilter = "";
        await selectVisibleBlock(command.blockId);
      }
      if (command.command === "focus") effects.focusPane("outliner");
      effects.invalidate();
      return;
    }
    if (mode !== "browse") {
      refreshPending = true;
      return;
    }
    if (event.domain === "selection") {
      await reload(event.blockId ?? null);
    } else {
      await reload();
    }
    effects.invalidate();
  }

  async function handleConnect(): Promise<void> {
    resetExpandedBlockPaging();
    status = "";
    if (mode === "browse") await reload();
    else refreshPending = true;
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

  async function handleKeypress(
    str: string,
    key: TerminalKey,
    inputAction: TerminalInputAction,
  ): Promise<void> {
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
        status = "Ctrl+Q closes the outliner pane";
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

    if (mode === "delete") {
      const selected = rows[selectedIndex];
      if (str.toLowerCase() === "y" && selected) {
        await effects.request({ action: "delete", blockId: selected.canonicalId });
      }
      mode = "browse";
      await reload();
      const visibleId = rows[selectedIndex]?.canonicalId ?? null;
      lastSelectionId = visibleId;
      await effects.request({ action: "selection.set", blockId: visibleId });
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

      if (mode !== "filter" && detailHandoffRequested) {
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
      } else if (key.name === "tab" && mode !== "filter") {
        await openQuickCompletion();
      } else {
        updateQuickBuffer(str, key);
      }
      effects.invalidate();
      return;
    }

    const selected = rows[selectedIndex];
    let preferredSelectedId: string | undefined;
    let reloadRequired = false;
    if (key.name === "q") {
      status = "Outliner remains open; Ctrl+Q closes this pane";
    } else if (isDetailToggle(str, key)) {
      if (!selected) {
        status = "No block selected";
      } else {
        resetExpandedBlockPaging();
        const result = await effects.request<{ expanded: boolean }>({
          action: "view.toggleMultiline",
          blockId: selected.canonicalId,
        });
        status = result.expanded ? "Block detail expanded" : "Block detail collapsed";
        reloadRequired = true;
      }
    } else if (detailHandoffRequested) {
      await handoffToDetail();
      return;
    } else if (key.name === "pageup" || key.name === "pagedown") {
      scrollSelectedExpandedBlock(key.name);
    } else if (key.shift && key.name === "up") {
      if (selected && isVirtualBranchOccurrence(selected)) {
        occurrenceMutationDisabled("sibling reorder");
      } else if (selected) {
        preferredSelectedId = await moveSibling(selected, -1);
        reloadRequired = true;
      }
    } else if (key.shift && key.name === "down") {
      if (selected && isVirtualBranchOccurrence(selected)) {
        occurrenceMutationDisabled("sibling reorder");
      } else if (selected) {
        preferredSelectedId = await moveSibling(selected, 1);
        reloadRequired = true;
      }
    } else if (key.name === "up") selectedIndex = Math.max(0, selectedIndex - 1);
    else if (key.name === "down") selectedIndex = Math.min(rows.length - 1, selectedIndex + 1);
    else if (key.name === "left" && selected) {
      if (isVirtualBranchOccurrence(selected)) {
        selectedIndex = Math.max(0, rows.findIndex((row) => row.rowId === selected.viewId));
      } else if (!selected.block.collapsed && selected.hasChildren) {
        await effects.request({ action: "toggle", blockId: selected.canonicalId });
        reloadRequired = true;
      } else if (selected.block.parentId) {
        selectedIndex = Math.max(
          0,
          rows.findIndex((row) => row.rowId === selected.block.parentId),
        );
      }
    } else if (key.name === "right" && selected) {
      if (isVirtualBranchOccurrence(selected)) {
        occurrenceMutationDisabled("hierarchy expansion");
      } else if (selected.block.collapsed) {
        await effects.request({ action: "toggle", blockId: selected.canonicalId });
        reloadRequired = true;
      } else if (selected.hasChildren) selectedIndex = Math.min(rows.length - 1, selectedIndex + 1);
    } else if (key.name === "return" && selected) {
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
        preferredSelectedId = selected.canonicalId;
        reloadRequired = true;
      }
    } else if (key.name === "space" && selected) {
      if (isVirtualBranchOccurrence(selected)) {
        occurrenceMutationDisabled("collapse");
      } else {
        await effects.request({ action: "toggle", blockId: selected.canonicalId });
        reloadRequired = true;
      }
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
    } else if (str === "d" && selected) mode = "delete";
    else if (str === "f" && selected) openReferencedFile(selected.block);
    else if (key.name === "escape" && activeFilter) {
      activeFilter = "";
      reloadRequired = true;
    }

    if (rows[selectedIndex]?.rowId !== selected?.rowId) resetExpandedBlockPaging();
    if (reloadRequired) await reload(preferredSelectedId);
    const visibleId = rows[selectedIndex]?.canonicalId ?? null;
    if (visibleId !== lastSelectionId) {
      lastSelectionId = visibleId;
      await effects.request({ action: "selection.set", blockId: visibleId });
    }
    effects.invalidate();
  }

  async function initialize(): Promise<void> {
    const hasServiceSelection = await reload();
    if (!hasServiceSelection && lastSelectionId !== null) {
      await effects.request({ action: "selection.set", blockId: lastSelectionId });
    }
  }

  return {
    view,
    initialize,
    handleKeypress,
    handleServiceEvent,
    handleConnect,
    handleDisconnect,
    handleError,
  };
}
