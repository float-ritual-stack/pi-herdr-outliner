import { extractFileAnnotationComment, formatFileAnnotation } from "./annotations";
import { completionTargetAtCursor } from "./completion";
import { layoutDetailEditor } from "./detail-editor-layout";
import type { ReferencedFile, ReferencedPathCandidate } from "./files";
import { getProperty } from "./properties";
import { blockDisplayTitle } from "./references";
import { TextBuffer } from "./text-buffer";
import type {
  Block,
  BlockSearchQuery,
  OutlinerEvent,
  SelectionContext,
  VisibleBlockCollection,
} from "./types";

export type DetailMode = "preview" | "file" | "annotation" | "edit" | "comment";

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
  resolvedSelectedText: string;
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
  getSelection(): Promise<SelectionContext>;
  setSelection(blockId: string): Promise<void>;
  resolveReferences(text: string): Promise<string>;
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
  queryBlocks(query: BlockSearchQuery): Promise<VisibleBlockCollection>;
  readFile(block: Block): ReferencedFile;
  completeFiles(query: string): ReferencedPathCandidate[];
  focusOutliner(): void;
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
  | { type: "comment.begin" }
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
      return "↑↓ scroll  e edit annotation  f source file  b raw block  q tree";
    case "file":
      return "↑↓ lines  v select range  c comment  b block  q tree";
    case "preview":
      return "↑↓ scroll  Enter/e edit  f file  q tree  Ctrl+Q close";
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
    resolvedSelectedText: "",
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

  const loadSelection = async (force = false): Promise<void> => {
    const next = await effects.getSelection();
    state.refreshPending = false;
    const changed =
      next.selected?.id !== state.context.selected?.id ||
      next.selected?.updatedAt !== state.context.selected?.updatedAt;
    state.context = next;
    if (!force && !changed) return;
    if (changed) state.status = "";

    state.resolvedSelectedText = next.selected
      ? await effects.resolveReferences(next.selected.text)
      : "";
    refreshBreadcrumb();
    state.previewOffset = 0;
    state.completion = null;
    state.mode = detailDisplayMode(next.selected);
    if ((state.mode === "file" || state.mode === "annotation") && next.selected) loadFile(next.selected);
    else state.referencedFile = null;
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

  const beginEdit = (viewport: DetailViewport): void => {
    if (!state.context.selected) return;
    state.buffer = new TextBuffer(state.context.selected.text);
    state.buffer.row = state.buffer.lines.length - 1;
    state.buffer.moveEnd();
    state.editorVisualOffset = 0;
    state.completion = null;
    state.mode = "edit";
    state.status = "";
    ensureEditorCursorVisible(viewport);
  };

  const beginComment = (): void => {
    const range = selectedDetailFileRange(state);
    if (!range || !state.referencedFile) return;
    state.annotationRange = range;
    state.buffer = new TextBuffer();
    state.editorVisualOffset = 0;
    state.completion = null;
    state.mode = "comment";
    state.status = `Commenting on ${state.referencedFile.sourcePath}:${range.startLine}-${range.endLine}`;
  };

  const focusOutliner = (announce: boolean): void => {
    try {
      effects.focusOutliner();
    } catch (error) {
      state.status = errorMessage(error);
    }
    if (announce) state.status = "Focus returned to outliner; Ctrl+Q closes detail";
  };

  const cancelBuffer = (): void => {
    state.mode = detailDisplayMode(state.context.selected);
    state.status = "Edit cancelled";
    focusOutliner(false);
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
        state.resolvedSelectedText = await effects.resolveReferences(updated.text);
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
      if (!isBufferMode() && state.refreshPending) await loadSelection(true);
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
    } else {
      let collection: VisibleBlockCollection | undefined;
      if (target.kind === "page") {
        collection = await effects.queryBlocks({
          text: target.query || undefined,
          filters: [{ key: "type", value: "page" }],
          limit: 20,
        });
      }
      if (!collection || collection.blocks.length === 0) {
        collection = await effects.queryBlocks({
          text: target.query || undefined,
          limit: 20,
        });
      }
      items = collection.blocks.map((block) => {
        const title = blockDisplayTitle(block);
        return {
          label: title,
          insertion: target.kind === "page" ? `[[${title}]]` : `((${block.id}))`,
        };
      });
      if (collection.completeness.kind === "truncated") {
        completionStatus = `Showing first ${collection.completeness.limit} matches`;
      }
    }

    if (items.length === 0) {
      state.completion = null;
      state.status = target.kind === "file" ? "No matching files" : "No matching blocks";
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
        beginEdit(viewport);
        break;
      case "comment.begin":
        beginComment();
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
        cancelBuffer();
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
        focusOutliner(intent.announce ?? false);
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
      return loadSelection(true);
    },
    isBufferMode,
    dispatch,
    async onServiceEvent(event, viewport) {
      if (event.domain === "ui") {
        const command = event.command;
        if (!command || command.target !== "detail") return;
        if (isBufferMode()) {
          state.refreshPending = true;
          return;
        }
        if (command.blockId && state.context.selected?.id !== command.blockId) {
          await effects.setSelection(command.blockId);
        }
        await loadSelection(true);
        if (command.command === "edit") beginEdit(viewport);
        emit();
        return;
      }
      if (isBufferMode()) {
        state.refreshPending = true;
        return;
      }
      await loadSelection(event.domain === "selection");
      emit();
    },
    async onServiceConnect() {
      state.status = "";
      if (isBufferMode()) state.refreshPending = true;
      else await loadSelection(true);
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
      await loadSelection(true);
      emit();
    },
  };
}
