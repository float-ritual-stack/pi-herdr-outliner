import type { RequestInput } from "./client";
import { completionTargetAtCursor } from "./completion";
import type { ReferencedFile, ReferencedPathCandidate } from "./files";
import { parseFilter } from "./properties";
import { blockDisplayTitle } from "./references";
import { isDetailToggle, isPrintableInput, type TerminalInputAction, type TerminalKey } from "./terminal";
import { TextBuffer } from "./text-buffer";
import type { Block, OutlinerEvent, VisibleBlock, WorkspaceSnapshot } from "./types";

export type TreeInputMode = "edit" | "add-child" | "add-sibling" | "filter";
export type TreeMode = "browse" | "delete" | "viewer" | TreeInputMode;

export interface TreeQuickCompletionItem {
  readonly label: string;
  readonly insertion: string;
}

export interface TreeQuickCompletion {
  readonly start: number;
  readonly end: number;
  readonly index: number;
  readonly items: readonly TreeQuickCompletionItem[];
}

export interface TreeView {
  readonly workspaceRoot: string;
  readonly rows: readonly VisibleBlock[];
  readonly allBlocksById: ReadonlyMap<string, VisibleBlock>;
  readonly selectedIndex: number;
  readonly activeFilter: string;
  readonly mode: TreeMode;
  readonly quickInput: string;
  readonly quickColumn: number;
  readonly quickCompletion: TreeQuickCompletion | null;
  readonly viewerLines: readonly string[];
  readonly viewerPath: string;
  readonly viewerOffset: number;
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
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createTreeController(effects: TreeControllerEffects): TreeController {
  let rows: VisibleBlock[] = [];
  let allBlocksById = new Map<string, VisibleBlock>();
  let selectedIndex = 0;
  let activeFilter = "";
  let mode: TreeMode = "browse";
  let quickBuffer = new TextBuffer();
  let quickCompletion: MutableQuickCompletion | null = null;
  let viewerLines: string[] = [];
  let viewerPath = "";
  let viewerOffset = 0;
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
      allBlocksById,
      selectedIndex,
      activeFilter,
      mode,
      quickInput: quickInputText(),
      quickColumn: quickBuffer.column,
      quickCompletion,
      viewerLines,
      viewerPath,
      viewerOffset,
      status,
      refreshPending,
    };
  }

  async function reload(preferredSelectedId?: string | null): Promise<void> {
    const currentSelectedId = rows[selectedIndex]?.id;
    const snapshot = await effects.request<WorkspaceSnapshot>({
      action: "workspace.snapshot",
      query: { filters: parseFilter(activeFilter) },
    });
    refreshPending = false;
    rows = snapshot.blocks;
    allBlocksById = new Map(snapshot.allBlocks.map((block) => [block.id, block]));
    let selectedId: string | null | undefined = currentSelectedId ?? snapshot.selection.selected?.id;
    if (preferredSelectedId !== undefined) selectedId = preferredSelectedId;
    const nextIndex = selectedId ? rows.findIndex((block) => block.id === selectedId) : -1;
    selectedIndex = Math.max(0, Math.min(nextIndex >= 0 ? nextIndex : selectedIndex, rows.length - 1));
  }

  function resetQuickEditor(): void {
    quickBuffer = new TextBuffer();
    quickCompletion = null;
  }

  async function beginInput(nextMode: TreeInputMode, initial = ""): Promise<void> {
    const selected = rows[selectedIndex];
    if (nextMode === "add-child" && selected?.collapsed) {
      await effects.request({ action: "toggle", blockId: selected.id });
      await reload(selected.id);
    }
    mode = nextMode;
    quickBuffer = new TextBuffer(initial);
    quickBuffer.moveEnd();
    quickCompletion = null;
    effects.invalidate();
  }

  async function commitQuickBlock(): Promise<string | null> {
    const selected = rows[selectedIndex];
    if (!selected) return null;
    const text = quickInputText();
    if (!text.trim()) return mode === "edit" ? selected.id : null;

    if (mode === "edit") {
      await effects.request<Block>({
        action: "update",
        blockId: selected.id,
        text,
        expectedUpdatedAt: selected.updatedAt,
      });
      return selected.id;
    }
    if (mode === "add-child") {
      const created = await effects.request<Block>({
        action: "create",
        parentId: selected.id,
        text,
        author: "user",
      });
      await effects.request({ action: "move", blockId: created.id, parentId: selected.id, position: 0 });
      return created.id;
    }
    if (mode === "add-sibling") {
      const canonical = await effects.request<Block>({ action: "get", blockId: selected.id });
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

  async function selectVisibleBlock(preferredId: string | null): Promise<void> {
    await reload(preferredId);
    if (preferredId && !rows.some((row) => row.id === preferredId)) {
      activeFilter = "";
      await reload(preferredId);
      status = "Filter cleared to show saved block";
    }
    const visibleId = rows[selectedIndex]?.id ?? null;
    lastSelectionId = visibleId;
    await effects.request({ action: "selection.set", blockId: visibleId });
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

    const committedBlockId = await commitQuickBlock();
    const fallbackId = rows[selectedIndex]?.id ?? null;
    mode = "browse";
    resetQuickEditor();
    await selectVisibleBlock(committedBlockId ?? fallbackId);
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
    const targetId = committedBlockId ?? selected.id;
    mode = "browse";
    resetQuickEditor();
    await selectVisibleBlock(targetId);
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
    if (target.kind === "file") {
      items = effects.filesystem.completeReferencedPaths(target.query).map((candidate) => ({
        label: candidate.sourcePath,
        insertion: `[file::${candidate.sourcePath}${candidate.isDirectory ? "" : "]"}`,
      }));
    } else {
      let blocks: VisibleBlock[] = [];
      if (target.kind === "page") {
        blocks = await effects.request<VisibleBlock[]>({
          action: "list",
          query: {
            text: target.query || undefined,
            filters: [{ key: "type", value: "page" }],
            limit: 20,
          },
        });
      }
      if (blocks.length === 0) {
        blocks = await effects.request<VisibleBlock[]>({
          action: "list",
          query: { text: target.query || undefined, limit: 20, includeCollapsed: true },
        });
      }
      items = blocks.map((block) => {
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

  async function indent(selected: VisibleBlock): Promise<void> {
    for (let index = selectedIndex - 1; index >= 0; index--) {
      const candidate = rows[index];
      if (candidate.depth < selected.depth) break;
      if (candidate.depth === selected.depth) {
        await effects.request({ action: "move", blockId: selected.id, parentId: candidate.id });
        return;
      }
    }
    status = "No previous sibling to indent beneath";
  }

  async function outdent(selected: VisibleBlock): Promise<void> {
    const canonical = await effects.request<Block>({ action: "get", blockId: selected.id });
    if (!canonical.parentId) return;
    const parent = await effects.request<Block>({ action: "get", blockId: canonical.parentId });
    await effects.request({
      action: "move",
      blockId: canonical.id,
      parentId: parent.parentId,
      position: parent.position + 1,
    });
  }

  async function moveSibling(selected: VisibleBlock, offset: -1 | 1): Promise<string> {
    const canonical = await effects.request<Block>({ action: "get", blockId: selected.id });
    const siblings = await effects.request<Block[]>({ action: "children", parentId: canonical.parentId });
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
      lastSelectionId = event.blockId ?? null;
      await reload(lastSelectionId);
    } else {
      await reload();
    }
    effects.invalidate();
  }

  async function handleConnect(): Promise<void> {
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
      if (str.toLowerCase() === "y" && rows[selectedIndex]) {
        await effects.request({ action: "delete", blockId: rows[selectedIndex].id });
      }
      mode = "browse";
      await reload();
      const visibleId = rows[selectedIndex]?.id ?? null;
      lastSelectionId = visibleId;
      await effects.request({ action: "selection.set", blockId: visibleId });
      effects.invalidate();
      return;
    }

    if (mode !== "browse") {
      if (quickCompletion) {
        if (key.name === "up") quickCompletion.index = Math.max(0, quickCompletion.index - 1);
        else if (key.name === "down") {
          quickCompletion.index = Math.min(quickCompletion.items.length - 1, quickCompletion.index + 1);
        } else if (key.name === "return" || key.name === "tab") applyQuickCompletion();
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
      } else if (key.name === "backspace") quickBuffer.backspace();
      else if (key.name === "delete") quickBuffer.deleteForward();
      else if (key.name === "left") quickBuffer.moveLeft();
      else if (key.name === "right") quickBuffer.moveRight();
      else if (key.name === "home") quickBuffer.moveHome();
      else if (key.name === "end") quickBuffer.moveEnd();
      else if (isPrintableInput(str, key)) quickBuffer.insert(str);
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
        const result = await effects.request<{ expanded: boolean }>({
          action: "view.toggleMultiline",
          blockId: selected.id,
        });
        status = result.expanded ? "Block detail expanded" : "Block detail collapsed";
        reloadRequired = true;
      }
    } else if (detailHandoffRequested) {
      await handoffToDetail();
      return;
    } else if (key.shift && key.name === "up") {
      if (selected) {
        preferredSelectedId = await moveSibling(selected, -1);
        reloadRequired = true;
      }
    } else if (key.shift && key.name === "down") {
      if (selected) {
        preferredSelectedId = await moveSibling(selected, 1);
        reloadRequired = true;
      }
    } else if (key.name === "up") selectedIndex = Math.max(0, selectedIndex - 1);
    else if (key.name === "down") selectedIndex = Math.min(rows.length - 1, selectedIndex + 1);
    else if (key.name === "left" && selected) {
      if (!selected.collapsed && selected.hasChildren) {
        await effects.request({ action: "toggle", blockId: selected.id });
        reloadRequired = true;
      } else if (selected.parentId) {
        selectedIndex = Math.max(0, rows.findIndex((block) => block.id === selected.parentId));
      }
    } else if (key.name === "right" && selected) {
      if (selected.collapsed) {
        await effects.request({ action: "toggle", blockId: selected.id });
        reloadRequired = true;
      } else if (selected.hasChildren) selectedIndex = Math.min(rows.length - 1, selectedIndex + 1);
    } else if (key.name === "return" && selected) {
      if (selected.text.includes("\n")) {
        await handoffToDetail();
        return;
      }
      await beginInput("edit", selected.text);
      return;
    } else if (key.name === "tab" && selected) {
      if (key.shift) await outdent(selected);
      else await indent(selected);
      preferredSelectedId = selected.id;
      reloadRequired = true;
    } else if (key.name === "space" && selected) {
      await effects.request({ action: "toggle", blockId: selected.id });
      reloadRequired = true;
    } else if (str === "a" && selected) {
      await beginInput("add-child");
      return;
    } else if (str === "s" && selected) {
      await beginInput("add-sibling");
      return;
    } else if (str === "/") {
      await beginInput("filter", activeFilter);
      return;
    } else if (str === "d" && selected) mode = "delete";
    else if (str === "f" && selected) openReferencedFile(selected);
    else if (key.name === "escape" && activeFilter) {
      activeFilter = "";
      reloadRequired = true;
    }

    if (reloadRequired) await reload(preferredSelectedId);
    const visibleId = rows[selectedIndex]?.id ?? null;
    if (visibleId !== lastSelectionId) {
      lastSelectionId = visibleId;
      await effects.request({ action: "selection.set", blockId: visibleId });
    }
    effects.invalidate();
  }

  async function initialize(): Promise<void> {
    await reload();
    lastSelectionId = rows[selectedIndex]?.id ?? null;
    await effects.request({ action: "selection.set", blockId: lastSelectionId });
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
