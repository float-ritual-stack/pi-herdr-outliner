import { extractFileAnnotationComment, formatFileAnnotation } from "./annotations";
import { completionTargetAtCursor } from "./completion";
import { layoutDetailEditor } from "./detail-editor-layout";
import type { ReferencedFile, ReferencedPathCandidate } from "./files";
import { firstOutlinerReference, type OutlinerLinkTarget } from "./outliner-links";
import { getProperty } from "./properties";
import { blockDisplayTitle } from "./references";
import { TextBuffer } from "./text-buffer";
import type {
  Block,
  BlockSearchQuery,
  BrowsingContextState,
  PageAddressCollection,
  OutlinerEvent,
  SelectionContext,
  OutlinerNavigationDispatch,
  OutlinerNavigationResolution,
  OutlinerNavigationIntent,
  OutlinerUiCommand,
  ResolvedBlockReferences,
  VisibleBlockCollection,
} from "./types";

export type DetailMode = "preview" | "file" | "annotation" | "edit" | "comment";
export type DetailConnectionMode = "unlocked" | "locked";

export interface DetailViewport {
  width: number;
  height: number;
}

export interface DetailCompletionItem {
  label: string;
  insertion: string;
}

export interface DetailCompletionState {
  start: number;
  end: number;
  index: number;
  items: DetailCompletionItem[];
}

export interface DetailLineRange {
  startLine: number;
  endLine: number;
}


export interface DetailState {
  context: SelectionContext;
  targetBlockId: string | null;
  connectionMode: DetailConnectionMode;
  canNavigateBack: boolean;
  canNavigateForward: boolean;
  resolvedSelectedText: string;
  workIdPrefix: string | null;
  resolvedBreadcrumb: string;
  mode: DetailMode;
  buffer: TextBuffer;
  referencedFile: ReferencedFile | null;
  previewOffset: number;
  editorVisualOffset: number;
  fileOffset: number;
  fileCursor: number;
  selectionAnchor: number | null;
  annotationRange: DetailLineRange | null;
  completion: DetailCompletionState | null;
  status: string;
  busy: boolean;
  refreshPending: boolean;
}

export interface DetailEffects {
  readonly clientId: string;
  readonly browsingContextId: string;
  focusSelf(): void;
  getBrowsingContext(): Promise<BrowsingContextState>;
  getBlockContext(blockId: string): Promise<SelectionContext>;
  setLocked(locked: boolean): Promise<void>;
  dispatchNavigation(
    blockId: string,
    intent: OutlinerNavigationIntent,
  ): Promise<OutlinerNavigationDispatch>;
  resolveNavigation(
    intent: OutlinerNavigationIntent,
  ): Promise<OutlinerNavigationResolution>;
  resolveReferences(text: string): Promise<ResolvedBlockReferences>;
  updateBlock(input: {
    blockId: string;
    text: string;
    expectedUpdatedAt: string;
  }): Promise<Block>;
  createBlock(input: {
    parentId: string;
    text: string;
    author: "user";
  }): Promise<Block>;
  restoreBlock(blockId: string): Promise<Block>;
  resolveReference(target: OutlinerLinkTarget): Promise<{ block: Block; created?: boolean }>;
  queryBlocks(query: BlockSearchQuery): Promise<VisibleBlockCollection>;
  queryPageAddresses(query: string | undefined, limit: number): Promise<PageAddressCollection>;
  readFile(block: Block): ReferencedFile;
  completeFiles(query: string): ReferencedPathCandidate[];
  focusOutliner(): Promise<void>;
}

export type DetailBufferMoveDirection =
  | "left"
  | "right"
  | "up"
  | "down"
  | "home"
  | "end"
  | "word-left"
  | "word-right";

export type DetailIntent =
  | { type: "edit.begin" }
  | { type: "trash.restore" }
  | { type: "comment.begin" }
  | { type: "navigation.back" }
  | { type: "navigation.forward" }
  | { type: "reference.follow" }
  | { type: "reference.open"; target: OutlinerLinkTarget }
  | { type: "reference.reveal" }
  | { type: "lock.toggle" }
  | { type: "buffer.insert"; text: string }
  | { type: "buffer.newline" }
  | { type: "buffer.backspace" }
  | { type: "buffer.delete" }
  | { type: "buffer.move"; direction: DetailBufferMoveDirection; extend?: boolean }
  | { type: "buffer.select-all" }
  | { type: "buffer.undo" }
  | { type: "buffer.redo" }
  | { type: "buffer.save" }
  | { type: "buffer.cancel" }
  | { type: "completion.open" }
  | { type: "completion.move"; delta: -1 | 1 }
  | { type: "completion.accept" }
  | { type: "completion.dismiss" }
  | { type: "preview.navigate"; direction: "up" | "down" | "pageup" | "pagedown" }
  | { type: "file.navigate"; direction: "up" | "down" | "pageup" | "pagedown" | "home" | "end" }
  | { type: "file.selection.toggle" }
  | { type: "view.file" }
  | { type: "view.block" }
  | { type: "focus.outliner"; announce?: boolean }
  | { type: "viewport.changed" }
  | { type: "redraw" };

export interface DetailController {
  readonly state: Readonly<DetailState>;
  initialize(): Promise<void>;
  isBufferMode(): boolean;
  dispatch(intent: DetailIntent, viewport: DetailViewport): Promise<void>;
  onServiceEvent(event: OutlinerEvent, viewport: DetailViewport): Promise<void>;
  onServiceConnect(viewport: DetailViewport): Promise<void>;
  onServiceDisconnect(): void;
  onServiceError(error: unknown): void;
  refreshPendingSelection(): Promise<void>;
}

export function detailDisplayMode(block: Block | null): "preview" | "file" | "annotation" {
  if (!block) return "preview";
  if (getProperty(block.properties, "type") === "annotation") return "annotation";
  return getProperty(block.properties, "file") ? "file" : "preview";
}

export function detailHelpText(mode: DetailMode): string {
  switch (mode) {
    case "edit":
      return "^Z/⌘Z undo  ^⇧Z/^Y redo  ⌥←→ word  Home/End line  ⇧Arrows select  Del  ^S save  Tab complete  Esc cancel";
    case "comment":
      return "^Z/⌘Z undo  ^⇧Z/^Y redo  ⌥←→ word  Home/End line  ⇧Arrows select  Del  ^S add annotation  Esc cancel";
    case "annotation":
      return "L lock/unlock  ↑↓ read  e edit  o open next unlocked  R reveal  f source  b block";
    case "file":
      return "L lock/unlock  ↑↓ lines  o open next unlocked  R reveal  v select  c comment  b block";
    case "preview":
      return "L lock/unlock  ↑↓ read  e edit  o open next unlocked  R reveal  q tree";
  }
}

export function selectedDetailFileRange(state: Readonly<DetailState>): DetailLineRange | null {
  if (!state.referencedFile) return null;
  const anchor = state.selectionAnchor ?? state.fileCursor;
  return {
    startLine: state.referencedFile.firstLine + Math.min(anchor, state.fileCursor),
    endLine: state.referencedFile.firstLine + Math.max(anchor, state.fileCursor),
  };
}

export function detailAnnotationLineCount(state: Readonly<DetailState>): number {
  const comment = extractFileAnnotationComment(state.resolvedSelectedText) || "(No comment text)";
  const sourceLines = state.referencedFile ? state.referencedFile.lines.length + 2 : 0;
  return sourceLines + 1 + comment.split(/\r?\n/).length;
}

export function detailVisibleEditorHeight(
  state: Pick<DetailState, "completion">,
  viewport: DetailViewport,
): number {
  const completionRows = state.completion
    ? 1 + Math.min(6, state.completion.items.length)
    : 0;
  return Math.max(1, viewport.height - 5 - completionRows);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pageSize(viewport: DetailViewport): number {
  return Math.max(1, viewport.height - 6);
}

export function createDetailController(
  effects: DetailEffects,
  onChange: (state: Readonly<DetailState>) => void = () => {},
): DetailController {
  const state: DetailState = {
    context: { selected: null, ancestors: [], children: [] },
    targetBlockId: null,
    connectionMode: "unlocked",
    canNavigateBack: false,
    canNavigateForward: false,
    resolvedSelectedText: "",
    workIdPrefix: null,
    resolvedBreadcrumb: "",
    mode: "preview",
    buffer: new TextBuffer(),
    referencedFile: null,
    previewOffset: 0,
    editorVisualOffset: 0,
    fileOffset: 0,
    fileCursor: 0,
    selectionAnchor: null,
    annotationRange: null,
    completion: null,
    status: "",
    busy: false,
    refreshPending: false,
  };
  const navigationHistory: string[] = [];
  let navigationIndex = -1;
  let pendingUiCommand: OutlinerUiCommand | null = null;

  const emit = (): void => onChange(state);
  const isBufferMode = (): boolean => state.mode === "edit" || state.mode === "comment";

  const refreshBreadcrumb = (): void => {
    const titles = state.context.ancestors.map(blockDisplayTitle);
    if (state.context.selected) {
      titles.push(blockDisplayTitle({ ...state.context.selected, text: state.resolvedSelectedText }));
    }
    state.resolvedBreadcrumb = titles.join(" › ");
  };

  const loadFile = (block: Block): void => {
    try {
      state.referencedFile = effects.readFile(block);
      state.fileCursor = 0;
      state.fileOffset = 0;
      state.selectionAnchor = null;
    } catch (error) {
      state.referencedFile = null;
      state.status = errorMessage(error);
    }
  };

  const applyResolvedReferences = (resolved: ResolvedBlockReferences): void => {
    state.resolvedSelectedText = resolved.text;
    state.workIdPrefix = resolved.workIdPrefix ?? null;
  };

  const syncNavigationState = (): void => {
    state.canNavigateBack = navigationIndex > 0;
    state.canNavigateForward = navigationIndex >= 0 && navigationIndex < navigationHistory.length - 1;
  };

  const recordNavigation = (blockId: string | null): void => {
    if (!blockId || navigationHistory[navigationIndex] === blockId) {
      syncNavigationState();
      return;
    }
    navigationHistory.splice(navigationIndex + 1);
    navigationHistory.push(blockId);
    if (navigationHistory.length > 200) navigationHistory.shift();
    navigationIndex = navigationHistory.length - 1;
    syncNavigationState();
  };

  const applyTarget = async (
    next: SelectionContext,
    force = false,
    record = true,
  ): Promise<void> => {
    state.refreshPending = false;
    const changed =
      next.selected?.id !== state.context.selected?.id ||
      next.selected?.updatedAt !== state.context.selected?.updatedAt;
    state.context = next;
    state.targetBlockId = next.selected?.id ?? null;
    if (record) recordNavigation(state.targetBlockId);
    else syncNavigationState();
    if (!force && !changed) return;
    if (changed) state.status = "";

    if (next.selected) {
      applyResolvedReferences(await effects.resolveReferences(next.selected.text));
    } else {
      state.resolvedSelectedText = "";
      state.workIdPrefix = null;
    }
    refreshBreadcrumb();
    state.previewOffset = 0;
    state.completion = null;
    state.mode = detailDisplayMode(next.selected);
    if (next.selected?.deletedAt) {
      state.status = "In Trash — read-only · r restore";
    } else if (next.selected?.effectiveDeletedRootId) {
      state.status = "In Trash — read-only · restore its direct Trash root";
    }
    if ((state.mode === "file" || state.mode === "annotation") && next.selected) loadFile(next.selected);
    else state.referencedFile = null;
  };

  const loadBrowsingContext = async (force = false): Promise<void> => {
    const browsingContext = await effects.getBrowsingContext();
    await applyTarget(browsingContext.target, force);
  };

  const loadBlock = async (
    blockId: string,
    force = false,
    record = true,
  ): Promise<void> => {
    try {
      await applyTarget(await effects.getBlockContext(blockId), force, record);
    } catch {
      state.context = { selected: null, ancestors: [], children: [] };
      state.targetBlockId = blockId;
      state.resolvedSelectedText = "";
      state.resolvedBreadcrumb = "";
      state.referencedFile = null;
      if (record) recordNavigation(blockId);
      else syncNavigationState();
      state.status = `Target is no longer available · ${blockId}`;
    }
  };

  const loadCurrentTarget = async (force = false): Promise<void> => {
    if (state.targetBlockId) await loadBlock(state.targetBlockId, force, false);
    else await loadBrowsingContext(force);
  };

  const applyNavigationCommand = async (command: OutlinerUiCommand): Promise<void> => {
    if (!command.blockId) return;
    await loadBlock(command.blockId, true, command.command !== "preview");
  };

  const refreshPendingTarget = async (): Promise<void> => {
    const command = pendingUiCommand;
    pendingUiCommand = null;
    if (command) await applyNavigationCommand(command);
    else await loadCurrentTarget(true);
  };

  const ensureEditorCursorVisible = (viewport: DetailViewport): void => {
    const visibleHeight = detailVisibleEditorHeight(state, viewport);
    const layout = layoutDetailEditor(
      state.buffer.lines,
      state.buffer.row,
      state.buffer.column,
      viewport.width,
    );
    const maxOffset = Math.max(0, layout.rows.length - visibleHeight);
    state.editorVisualOffset = Math.max(
      0,
      Math.min(state.editorVisualOffset, maxOffset),
    );
    if (layout.cursorRow < state.editorVisualOffset) {
      state.editorVisualOffset = layout.cursorRow;
    } else if (layout.cursorRow >= state.editorVisualOffset + visibleHeight) {
      state.editorVisualOffset = Math.min(
        maxOffset,
        layout.cursorRow - visibleHeight + 1,
      );
    }
  };

  const ensureFileCursorVisible = (viewport: DetailViewport): void => {
    const page = pageSize(viewport);
    if (state.fileCursor < state.fileOffset) state.fileOffset = state.fileCursor;
    if (state.fileCursor >= state.fileOffset + page) {
      state.fileOffset = state.fileCursor - page + 1;
    }
  };

  const setLocked = async (locked: boolean): Promise<void> => {
    await effects.setLocked(locked);
    state.connectionMode = locked ? "locked" : "unlocked";
  };

  const beginEdit = async (viewport: DetailViewport): Promise<void> => {
    if (!state.context.selected) return;
    if (state.context.selected.effectiveDeletedRootId) {
      state.status = "Block is in Trash; restore before editing";
      return;
    }
    await setLocked(true);
    state.buffer = new TextBuffer(state.context.selected.text);
    state.buffer.row = state.buffer.lines.length - 1;
    state.buffer.moveEnd();
    state.editorVisualOffset = 0;
    state.completion = null;
    state.mode = "edit";
    state.status = "Locked for editing";
    ensureEditorCursorVisible(viewport);
  };

  const beginComment = async (): Promise<void> => {
    if (state.context.selected?.effectiveDeletedRootId) {
      state.status = "Block is in Trash; restore before adding annotations";
      return;
    }
    const range = selectedDetailFileRange(state);
    if (!range || !state.referencedFile) return;
    await setLocked(true);
    state.annotationRange = range;
    state.buffer = new TextBuffer();
    state.editorVisualOffset = 0;
    state.completion = null;
    state.mode = "comment";
    state.status = `Locked · commenting on ${state.referencedFile.sourcePath}:${range.startLine}-${range.endLine}`;
  };

  const focusOutliner = async (announce: boolean): Promise<void> => {
    try {
      await effects.focusOutliner();
      if (announce) state.status = "Focus returned to outliner; Ctrl+Q closes detail";
    } catch (error) {
      state.status = errorMessage(error);
    }
    emit();
  };

  const cancelBuffer = async (): Promise<void> => {
    state.mode = detailDisplayMode(state.context.selected);
    state.status = "Edit cancelled";
    await focusOutliner(false);
  };

  const saveBuffer = async (): Promise<void> => {
    if (!state.context.selected || state.busy) return;
    state.busy = true;
    try {
      if (state.mode === "edit") {
        const updated = await effects.updateBlock({
          blockId: state.context.selected.id,
          text: state.buffer.text,
          expectedUpdatedAt: state.context.selected.updatedAt,
        });
        state.context = { ...state.context, selected: updated };
        applyResolvedReferences(await effects.resolveReferences(updated.text));
        refreshBreadcrumb();
        state.mode = detailDisplayMode(updated);
        if (state.mode === "file" || state.mode === "annotation") loadFile(updated);
        else state.referencedFile = null;
      } else if (state.mode === "comment" && state.referencedFile && state.annotationRange) {
        const text = formatFileAnnotation({
          sourceBlockId: state.context.selected.id,
          filePath: state.referencedFile.sourcePath,
          startLine: state.annotationRange.startLine,
          endLine: state.annotationRange.endLine,
          comment: state.buffer.text,
        });
        await effects.createBlock({
          parentId: state.context.selected.id,
          text,
          author: "user",
        });
        state.mode = "file";
        state.selectionAnchor = null;
        state.status = `Annotation added for lines ${state.annotationRange.startLine}-${state.annotationRange.endLine}`;
      }
      if (!isBufferMode() && state.refreshPending) await refreshPendingTarget();
    } catch (error) {
      state.status = errorMessage(error);
    } finally {
      state.busy = false;
      emit();
    }
  };

  const openCompletion = async (): Promise<void> => {
    const line = state.buffer.lines[state.buffer.row];
    const target = completionTargetAtCursor(line, state.buffer.column);
    if (!target) {
      state.status = "Type [[page, ((block, or [file::path before requesting completion";
      return;
    }

    let items: DetailCompletionItem[];
    let completionStatus = "";
    if (target.kind === "file") {
      items = effects.completeFiles(target.query).map((candidate) => ({
        label: candidate.sourcePath,
        insertion: `[file::${candidate.sourcePath}${candidate.isDirectory ? "" : "]"}`,
      }));
    } else if (target.kind === "page") {
      const collection = await effects.queryPageAddresses(target.query || undefined, 20);
      items = collection.addresses.map((address) => ({
        label: `${address.address} — ${address.title}`,
        insertion: `[[${address.address}]]`,
      }));
      if (collection.completeness.kind === "truncated") {
        completionStatus = `Showing first ${collection.completeness.limit} matches`;
      }
    } else {
      const collection = await effects.queryBlocks({
        text: target.query || undefined,
        limit: 20,
      });
      items = collection.blocks.map((block) => ({
        label: blockDisplayTitle(block),
        insertion: `((${block.id}))`,
      }));
      if (collection.completeness.kind === "truncated") {
        completionStatus = `Showing first ${collection.completeness.limit} matches`;
      }
    }

    if (items.length === 0) {
      state.completion = null;
      switch (target.kind) {
        case "file":
          state.status = "No matching files";
          break;
        case "page":
          state.status = "No matching page addresses";
          break;
        case "block":
          state.status = "No matching blocks";
          break;
      }
      return;
    }
    state.completion = { start: target.start, end: target.end, index: 0, items };
    state.status = completionStatus;
  };

  const applyCompletion = (): void => {
    if (!state.completion || state.completion.items.length === 0) return;
    const item = state.completion.items[state.completion.index];
    state.buffer.replaceCurrentLine(state.completion.start, state.completion.end, item.insertion);
    state.completion = null;
    state.status = "";
  };

  const navigatePreview = (
    direction: "up" | "down" | "pageup" | "pagedown",
    viewport: DetailViewport,
  ): void => {
    const lineCount = state.mode === "annotation"
      ? detailAnnotationLineCount(state)
      : state.resolvedSelectedText.split(/\r?\n/).length;
    const maximum = Math.max(0, lineCount - 1);
    const amount = direction === "pageup" || direction === "pagedown" ? pageSize(viewport) : 1;
    const delta = direction === "up" || direction === "pageup" ? -amount : amount;
    state.previewOffset = Math.max(0, Math.min(maximum, state.previewOffset + delta));
  };

  const navigateFile = (
    direction: "up" | "down" | "pageup" | "pagedown" | "home" | "end",
    viewport: DetailViewport,
  ): void => {
    if (!state.referencedFile) return;
    const maximum = Math.max(0, state.referencedFile.lines.length - 1);
    if (direction === "home") state.fileCursor = 0;
    else if (direction === "end") state.fileCursor = maximum;
    else {
      const amount = direction === "pageup" || direction === "pagedown" ? pageSize(viewport) : 1;
      const delta = direction === "up" || direction === "pageup" ? -amount : amount;
      state.fileCursor = Math.max(0, Math.min(maximum, state.fileCursor + delta));
    }
    ensureFileCursorVisible(viewport);
  };

  const dispatch = async (intent: DetailIntent, viewport: DetailViewport): Promise<void> => {
    switch (intent.type) {
      case "edit.begin":
        await beginEdit(viewport);
        break;
      case "trash.restore":
        if (state.context.selected?.deletedAt) {
          await effects.restoreBlock(state.context.selected.id);
          await loadCurrentTarget(true);
          state.status = "Restored from Trash";
        }
        break;
      case "navigation.back":
      case "navigation.forward": {
        const direction = intent.type === "navigation.back" ? -1 : 1;
        const targetIndex = navigationIndex + direction;
        const blockId = navigationHistory[targetIndex];
        if (!blockId) {
          state.status = "No further navigation history";
          break;
        }
        navigationIndex = targetIndex;
        await loadBlock(blockId, true, false);
        state.status = direction < 0 ? "Navigation back" : "Navigation forward";
        break;
      }
      case "reference.open":
      case "reference.follow":
      case "reference.reveal": {
        const reference = intent.type === "reference.open"
          ? intent.target
          : state.context.selected
            ? firstOutlinerReference(state.context.selected.text, state.workIdPrefix)
            : null;
        if (!reference) {
          state.status = "Selected block has no block or page references";
          break;
        }
        const navigationIntent: OutlinerNavigationIntent =
          intent.type === "reference.reveal" ? "reveal" : "open";
        if (reference.kind === "page") {
          await effects.resolveNavigation(navigationIntent);
        }
        const resolved = await effects.resolveReference(reference);
        const dispatched = await effects.dispatchNavigation(
          resolved.block.id,
          navigationIntent,
        );
        if (dispatched.targetClientId === effects.clientId && navigationIntent === "open") {
          await applyNavigationCommand({
            targetClientId: effects.clientId,
            command: "open",
            blockId: resolved.block.id,
          });
        }
        const verb = navigationIntent === "open"
          ? resolved.created ? "Created and opened" : "Opened"
          : "Revealed";
        state.status = navigationIntent === "open"
          ? `${verb} ${blockDisplayTitle(resolved.block)} in first unlocked Detail`
          : `${verb} ${blockDisplayTitle(resolved.block)}`;
        break;
      }
      case "lock.toggle": {
        const locked = state.connectionMode !== "locked";
        await setLocked(locked);
        state.status = locked
          ? "Locked this block · previews use the next unlocked Detail"
          : "Unlocked · available for previews and opens";
        break;
      }
      case "comment.begin":
        await beginComment();
        break;
      case "buffer.insert":
        if (isBufferMode()) {
          state.completion = null;
          state.buffer.insert(intent.text);
          state.status = "";
          ensureEditorCursorVisible(viewport);
        }
        break;
      case "buffer.newline":
        state.buffer.newline();
        state.status = "";
        ensureEditorCursorVisible(viewport);
        break;
      case "buffer.backspace":
        state.buffer.backspace();
        state.status = "";
        ensureEditorCursorVisible(viewport);
        break;
      case "buffer.delete":
        state.buffer.deleteForward();
        state.status = "";
        ensureEditorCursorVisible(viewport);
        break;
      case "buffer.move": {
        const extend = intent.extend ?? false;
        switch (intent.direction) {
          case "left":
            state.buffer.moveLeft(extend);
            break;
          case "right":
            state.buffer.moveRight(extend);
            break;
          case "up":
            state.buffer.moveUp(extend);
            break;
          case "down":
            state.buffer.moveDown(extend);
            break;
          case "home":
            state.buffer.moveHome(extend);
            break;
          case "end":
            state.buffer.moveEnd(extend);
            break;
          case "word-left":
            state.buffer.moveWordLeft(extend);
            break;
          case "word-right":
            state.buffer.moveWordRight(extend);
            break;
        }
        ensureEditorCursorVisible(viewport);
        break;
      }
      case "buffer.select-all":
        state.buffer.selectAll();
        ensureEditorCursorVisible(viewport);
        break;
      case "buffer.undo":
        state.completion = null;
        state.status = state.buffer.undo() ? "Undo" : "Nothing to undo";
        ensureEditorCursorVisible(viewport);
        break;
      case "buffer.redo":
        state.completion = null;
        state.status = state.buffer.redo() ? "Redo" : "Nothing to redo";
        ensureEditorCursorVisible(viewport);
        break;
      case "buffer.save":
        await saveBuffer();
        return;
      case "buffer.cancel":
        await cancelBuffer();
        break;
      case "completion.open":
        try {
          await openCompletion();
          ensureEditorCursorVisible(viewport);
        } catch (error) {
          state.status = errorMessage(error);
        }
        break;
      case "completion.move":
        if (state.completion) {
          state.completion.index = Math.max(
            0,
            Math.min(state.completion.items.length - 1, state.completion.index + intent.delta),
          );
        }
        break;
      case "completion.accept":
        applyCompletion();
        ensureEditorCursorVisible(viewport);
        break;
      case "completion.dismiss":
        if (state.completion) state.status = "";
        state.completion = null;
        ensureEditorCursorVisible(viewport);
        break;
      case "preview.navigate":
        navigatePreview(intent.direction, viewport);
        break;
      case "file.navigate":
        navigateFile(intent.direction, viewport);
        break;
      case "file.selection.toggle":
        state.selectionAnchor = state.selectionAnchor === null ? state.fileCursor : null;
        break;
      case "view.file":
        if (state.mode === "annotation") {
          if (state.referencedFile) state.mode = "file";
        } else if (state.context.selected) {
          loadFile(state.context.selected);
          if (state.referencedFile) state.mode = "file";
        }
        break;
      case "view.block":
        state.mode = "preview";
        state.previewOffset = 0;
        break;
      case "focus.outliner":
        await focusOutliner(intent.announce ?? false);
        break;
      case "viewport.changed":
        if (isBufferMode()) ensureEditorCursorVisible(viewport);
        else if (state.mode === "file" && state.referencedFile) ensureFileCursorVisible(viewport);
        break;
      case "redraw":
        break;
    }
    emit();
  };

  return {
    get state() {
      return state;
    },
    initialize() {
      return loadBrowsingContext(true);
    },
    isBufferMode,
    dispatch,
    async onServiceEvent(event, viewport) {
      if (event.domain === "ui") {
        const command = event.command;
        if (!command || command.targetClientId !== effects.clientId) return;
        if (command.command === "preview" && state.connectionMode === "locked") return;
        if (isBufferMode()) {
          if (command.blockId) pendingUiCommand = command;
          state.refreshPending = true;
          return;
        }
        if (command.blockId) {
          await applyNavigationCommand(command);
          if (command.command === "preview") {
            state.status = "Previewing Tree selection · L locks this block";
          } else if (command.command === "open") {
            state.status = "Opened here · still unlocked · L locks this block";
          }
        }
        if (command.command === "edit") await beginEdit(viewport);
        if (command.command !== "preview") effects.focusSelf();
        emit();
        return;
      }
      if (event.domain === "selection" || event.domain === "browsing-context") return;
      if (isBufferMode()) {
        state.refreshPending = true;
        return;
      }
      await loadCurrentTarget();
      emit();
    },
    async onServiceConnect() {
      await effects.setLocked(state.connectionMode === "locked");
      state.status = "";
      if (isBufferMode()) state.refreshPending = true;
      else await loadCurrentTarget(true);
      emit();
    },
    onServiceDisconnect() {
      state.status = "Workspace service disconnected; reconnecting…";
      emit();
    },
    onServiceError(error) {
      state.status = errorMessage(error);
      emit();
    },
    async refreshPendingSelection() {
      if (!state.refreshPending) return;
      await refreshPendingTarget();
      emit();
    },
  };
}
