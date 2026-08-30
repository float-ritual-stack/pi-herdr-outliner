import { extractFileAnnotationComment, formatFileAnnotation } from "./annotations";
import { completionTargetAtCursor } from "./completion";
import { rankBlockFocusMatches, subsequenceScore } from "./block-focus";
import { layoutDetailEditor } from "./detail-editor-layout";
import type { DetailEmbedRange, DetailEmbedState, DetailReadProjection } from "./detail-embeds";
import {
  ensureHeadingFragment,
  fragmentCandidates,
  parseFragmentCompletionQuery,
  resolveFragment,
} from "./fragments";
import type { ReferencedFile, ReferencedPathCandidate } from "./files";
import { firstOutlinerReference, type OutlinerLinkTarget } from "./outliner-links";
import { getProperty } from "./properties";
import { blockDisplayTitle } from "./references";
import { TextBuffer } from "./text-buffer";
import type {
  BacklinkCollection,
  BacklinkSource,
  BacklinkQuery,
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

interface DetailNavigationEntry {
  blockId: string;
  fragmentId: string | null;
}

export type DetailMode = "preview" | "file" | "annotation" | "edit" | "comment";
export type DetailConnectionMode = "unlocked" | "locked";

export interface DetailViewport {
  width: number;
  height: number;
}

export interface DetailCompletionItem {
  label: string;
  insertion: string;
  anchor?: {
    blockId: string;
    fragmentId: string;
    lineIndex: number;
    text: string;
    expectedUpdatedAt: string;
  };
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

export type DetailBacklinkSortField = "created" | "updated";
export type DetailBacklinkSortDirection = "asc" | "desc";

export interface DetailBacklinkState {
  expanded: boolean;
  loading: boolean;
  collection: BacklinkCollection | null;
  selectedIndex: number;
  error: string;
  filter: string;
  filterDraft: string | null;
  sortField: DetailBacklinkSortField;
  sortDirection: DetailBacklinkSortDirection;
  expandedSourceIds: Set<string>;
}



function normalizeBacklinkFilter(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

export function visibleBacklinkSources(
  backlinks: Readonly<DetailBacklinkState>,
): BacklinkSource[] {
  const query = normalizeBacklinkFilter(backlinks.filter);
  const sources = backlinks.collection?.sources.filter((source) => {
    if (!query) return true;
    const fields = [
      source.title,
      source.parentContext,
      ...source.referenceGroups.map((group) =>
        group.kind === "property" ? group.propertyKey : group.kind
      ),
      ...source.occurrences.map((occurrence) => occurrence.snippet),
    ].map(normalizeBacklinkFilter);
    return fields.some((field) =>
      field.includes(query) || subsequenceScore(query, field) >= 900
    );
  }) ?? [];
  const timestamp = backlinks.sortField === "created" ? "createdAt" : "updatedAt";
  const direction = backlinks.sortDirection === "asc" ? 1 : -1;
  return sources.sort((left, right) =>
    direction * left[timestamp].localeCompare(right[timestamp]) ||
    left.title.localeCompare(right.title) ||
    left.blockId.localeCompare(right.blockId)
  );
}
export interface DetailState {
  context: SelectionContext;
  targetBlockId: string | null;
  targetFragmentId: string | null;
  connectionMode: DetailConnectionMode;
  canNavigateBack: boolean;
  canNavigateForward: boolean;
  resolvedSelectedText: string;
  projectedSelectedText: string;
  embedStates: DetailEmbedState[];
  embedRanges: DetailEmbedRange[];
  embedBackgroundEnabled: boolean;
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
  backlinks: DetailBacklinkState;
}

export interface DetailEffects {
  readonly clientId: string;
  readonly browsingContextId: string;
  focusSelf(): void;
  getBrowsingContext(): Promise<BrowsingContextState>;
  getBlockContext(blockId: string): Promise<SelectionContext>;
  setLocked(locked: boolean): Promise<void>;
  setCurrentBlock(blockId: string | null): Promise<void>;
  dispatchNavigation(
    blockId: string,
    intent: OutlinerNavigationIntent,
    options?: { preserveSource?: boolean; fragmentId?: string },
  ): Promise<OutlinerNavigationDispatch>;
  resolveNavigation(
    intent: OutlinerNavigationIntent,
    options?: { preserveSource?: boolean },
  ): Promise<OutlinerNavigationResolution>;
  resolveReferences(text: string): Promise<ResolvedBlockReferences>;
  projectRead(text: string, hostBlockId?: string): Promise<DetailReadProjection>;
  queryBacklinks(query: BacklinkQuery): Promise<BacklinkCollection>;
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
  | { type: "backlinks.move"; delta: -1 | 1 }
  | { type: "backlinks.open" }
  | { type: "backlinks.reveal" }
  | { type: "backlinks.toggle" }
  | { type: "backlinks.filter.begin" }
  | { type: "backlinks.filter.input"; text: string }
  | { type: "backlinks.filter.backspace" }
  | { type: "backlinks.filter.commit" }
  | { type: "backlinks.filter.cancel" }
  | { type: "backlinks.sort.cycle" }
  | { type: "backlinks.source.toggle"; blockId?: string }
  | { type: "embed-background.toggle" }
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
      return "L lock/unlock  ↑↓ read  E embeds  e edit  o open next unlocked  R reveal  q tree";
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
    targetFragmentId: null,
    connectionMode: "unlocked",
    canNavigateBack: false,
    canNavigateForward: false,
    resolvedSelectedText: "",
    projectedSelectedText: "",
    embedStates: [],
    embedRanges: [],
    embedBackgroundEnabled: true,
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
    backlinks: {
      expanded: false,
      loading: false,
      collection: null,
      selectedIndex: 0,
      error: "",
      filter: "",
      filterDraft: null,
      sortField: "updated",
      sortDirection: "desc",
      expandedSourceIds: new Set(),
    },
  };
  const navigationHistory: DetailNavigationEntry[] = [];
  let navigationIndex = -1;
  let pendingUiCommand: OutlinerUiCommand | null = null;
  let serviceConnected = false;

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

  const applyReadProjection = async (text: string, hostBlockId?: string): Promise<void> => {
    const projection = await effects.projectRead(text, hostBlockId);
    state.projectedSelectedText = projection.text;
    state.embedStates = projection.embeds;
    state.embedRanges = projection.embedRanges;
    applyResolvedReferences(await effects.resolveReferences(projection.text));
  };

  const invalidateBacklinks = (): void => {
    state.backlinks.loading = false;
    state.backlinks.collection = null;
    state.backlinks.error = "";
    state.backlinks.selectedIndex = 0;
    state.backlinks.filter = "";
    state.backlinks.filterDraft = null;
    state.backlinks.expandedSourceIds.clear();
  };

  const selectedBacklinkSource = (): BacklinkSource | undefined =>
    visibleBacklinkSources(state.backlinks)[state.backlinks.selectedIndex];

  const clampBacklinkSelection = (): void => {
    const maximum = Math.max(0, visibleBacklinkSources(state.backlinks).length - 1);
    state.backlinks.selectedIndex = Math.min(state.backlinks.selectedIndex, maximum);
  };

  const loadBacklinks = async (): Promise<void> => {
    const targetBlockId = state.targetBlockId;
    if (
      !state.backlinks.expanded ||
      !targetBlockId ||
      state.backlinks.collection?.targetBlockId === targetBlockId
    ) {
      return;
    }
    state.backlinks.loading = true;
    state.backlinks.error = "";
    try {
      const collection = await effects.queryBacklinks({
        targetBlockId,
        limit: 50,
      });
      if (state.backlinks.expanded && state.targetBlockId === targetBlockId) {
        state.backlinks.collection = collection;
        clampBacklinkSelection();
      }
    } catch (error) {
      if (state.backlinks.expanded && state.targetBlockId === targetBlockId) {
        state.backlinks.error = errorMessage(error);
      }
    } finally {
      if (state.targetBlockId === targetBlockId) state.backlinks.loading = false;
    }
  };

  const syncNavigationState = (): void => {
    state.canNavigateBack = navigationIndex > 0;
    state.canNavigateForward = navigationIndex >= 0 && navigationIndex < navigationHistory.length - 1;
  };

  const recordNavigation = (
    blockId: string | null,
    fragmentId: string | null,
  ): void => {
    const current = navigationHistory[navigationIndex];
    if (
      !blockId ||
      (current?.blockId === blockId && current.fragmentId === fragmentId)
    ) {
      syncNavigationState();
      return;
    }
    navigationHistory.splice(navigationIndex + 1);
    navigationHistory.push({ blockId, fragmentId });
    if (navigationHistory.length > 200) navigationHistory.shift();
    navigationIndex = navigationHistory.length - 1;
    syncNavigationState();
  };

  const applyTarget = async (
    next: SelectionContext,
    force = false,
    record = true,
    fragmentId: string | null = null,
  ): Promise<void> => {
    state.refreshPending = false;
    const targetChanged = next.selected?.id !== state.context.selected?.id;
    const fragmentChanged = fragmentId !== state.targetFragmentId;
    const changed =
      targetChanged ||
      fragmentChanged ||
      next.selected?.updatedAt !== state.context.selected?.updatedAt;
    if (targetChanged || next.selected?.updatedAt !== state.context.selected?.updatedAt) {
      invalidateBacklinks();
    }
    if (record) recordNavigation(state.targetBlockId, state.targetFragmentId);
    state.context = next;
    state.targetBlockId = next.selected?.id ?? null;
    state.targetFragmentId = fragmentId;
    if (targetChanged && serviceConnected) await effects.setCurrentBlock(state.targetBlockId);
    if (record) recordNavigation(state.targetBlockId, state.targetFragmentId);
    else syncNavigationState();
    if (!force && !changed) return;
    if (changed) state.status = "";

    if (next.selected) {
      await applyReadProjection(next.selected.text, next.selected.id);
    } else {
      state.projectedSelectedText = "";
      state.embedStates = [];
      state.resolvedSelectedText = "";
      state.workIdPrefix = null;
    }
    refreshBreadcrumb();
    state.previewOffset = 0;
    if (fragmentId && next.selected) {
      const fragment = resolveFragment(next.selected.text, fragmentId);
      if (fragment.status === "resolved") {
        state.previewOffset = fragment.anchor.lineIndex;
      } else {
        state.status = fragment.status === "duplicate"
          ? `Duplicate fragment · ^${fragmentId}`
          : `Missing fragment · ^${fragmentId}`;
      }
    }
    state.completion = null;
    state.mode = detailDisplayMode(next.selected);
    if (next.selected?.deletedAt) {
      state.status = "In Trash — read-only · r restore";
    } else if (next.selected?.effectiveDeletedRootId) {
      state.status = "In Trash — read-only · restore its direct Trash root";
    }
    if ((state.mode === "file" || state.mode === "annotation") && next.selected) loadFile(next.selected);
    else state.referencedFile = null;
    await loadBacklinks();
  };

  const loadBrowsingContext = async (force = false): Promise<void> => {
    const browsingContext = await effects.getBrowsingContext();
    await applyTarget(browsingContext.target, force);
  };

  const loadBlock = async (
    blockId: string,
    force = false,
    record = true,
    fragmentId: string | null = null,
  ): Promise<void> => {
    try {
      await applyTarget(
        await effects.getBlockContext(blockId),
        force,
        record,
        fragmentId,
      );
    } catch {
      if (record) recordNavigation(state.targetBlockId, state.targetFragmentId);
      state.context = { selected: null, ancestors: [], children: [] };
      await effects.setCurrentBlock(null);
      state.targetBlockId = blockId;
      state.targetFragmentId = fragmentId;
      state.resolvedSelectedText = "";
      state.projectedSelectedText = "";
      state.embedStates = [];
      state.resolvedBreadcrumb = "";
      state.referencedFile = null;
      if (record) recordNavigation(blockId, fragmentId);
      else syncNavigationState();
      state.status = `Target is no longer available · ${blockId}${
        fragmentId ? `^${fragmentId}` : ""
      }`;
    }
  };

  const loadCurrentTarget = async (force = false): Promise<void> => {
    if (state.targetBlockId) {
      await loadBlock(
        state.targetBlockId,
        force,
        false,
        state.targetFragmentId,
      );
    } else await loadBrowsingContext(force);
  };

  const applyNavigationCommand = async (command: OutlinerUiCommand): Promise<boolean> => {
    if (!command.blockId) return false;
    if (
      state.connectionMode === "locked" &&
      (command.command === "preview" || command.command === "open")
    ) {
      return false;
    }
    await loadBlock(
      command.blockId,
      true,
      command.command !== "preview",
      command.fragmentId ?? null,
    );
    return true;
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
        await applyReadProjection(updated.text, updated.id);
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
    let emptyStatus = "";
    let completionStatus = "";
    if (target.kind === "file") {
      items = effects.completeFiles(target.query).map((candidate) => ({
        label: candidate.sourcePath,
        insertion: `[file::${candidate.sourcePath}${candidate.isDirectory ? "" : "]"}`,
      }));
    } else if (target.kind === "page") {
      const collection = await effects.queryPageAddresses(target.query || undefined, 20);
      items = collection.addresses.map((address) => {
        const title = address.title.trim();
        const normalizedTitle = title.toLocaleLowerCase();
        const normalizedAddress = address.address.toLocaleLowerCase();
        return {
          label: normalizedTitle === normalizedAddress ||
              normalizedTitle.startsWith(`${normalizedAddress} `)
            ? title
            : `${address.address} — ${title}`,
          insertion: address.kind === "work-id"
            ? `((${address.blockId}))`
            : `[[${address.address}]]`,
        };
      });
      if (collection.completeness.kind === "truncated") {
        completionStatus = `Showing first ${collection.completeness.limit} matches`;
      }
    } else {
      const fragmentQuery = parseFragmentCompletionQuery(target.query);
      if (!fragmentQuery) {
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
      } else {
        const collection = await effects.queryBlocks({ limit: 500 });
        const blocks = fragmentQuery.blockQuery
          ? rankBlockFocusMatches(collection.blocks, fragmentQuery.blockQuery, 50)
            .map((match) => match.block)
          : collection.blocks;
        items = [];
        outer:
        for (const block of blocks) {
          const sourceText = block.id === state.context.selected?.id
            ? state.buffer.text
            : block.text;
          for (
            const candidate of fragmentCandidates(
              sourceText,
              fragmentQuery.fragmentQuery,
              fragmentQuery.mode,
            )
          ) {
            const ensured = candidate.fragmentId
              ? { text: sourceText, fragmentId: candidate.fragmentId, created: false }
              : ensureHeadingFragment(sourceText, candidate.lineIndex);
            items.push({
              label: `${blockDisplayTitle(block)} › ${
                candidate.kind === "heading" ? "#" : "¶"
              } ${candidate.label}${
                candidate.fragmentId ? ` · ^${candidate.fragmentId}` : " · create anchor"
              }`,
              insertion: `((${block.id}^${ensured.fragmentId}))`,
              ...(ensured.created
                ? {
                    anchor: {
                      blockId: block.id,
                      fragmentId: ensured.fragmentId,
                      lineIndex: candidate.lineIndex,
                      text: ensured.text,
                      expectedUpdatedAt: block.updatedAt,
                    },
                  }
                : {}),
            });
            if (items.length >= 20) break outer;
          }
        }
        emptyStatus = "No matching block fragments";
        if (collection.completeness.kind === "truncated") {
          completionStatus = `Searched first ${collection.completeness.limit} blocks`;
        }
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
          state.status = emptyStatus || "No matching blocks";
          break;
      }
      return;
    }
    state.completion = { start: target.start, end: target.end, index: 0, items };
    state.status = completionStatus;
  };
  const applyCompletion = async (): Promise<void> => {
    const completion = state.completion;
    if (!completion || completion.items.length === 0) return;
    const item = completion.items[completion.index]!;
    if (item.anchor) {
      if (item.anchor.blockId === state.context.selected?.id) {
        const anchoredLine = item.anchor.text.split(/\r?\n/)[item.anchor.lineIndex];
        if (anchoredLine === undefined) {
          throw new Error(`Fragment heading line is unavailable: ${item.anchor.lineIndex + 1}`);
        }
        state.buffer.replaceLine(item.anchor.lineIndex, anchoredLine);
      } else {
        await effects.updateBlock({
          blockId: item.anchor.blockId,
          text: item.anchor.text,
          expectedUpdatedAt: item.anchor.expectedUpdatedAt,
        });
      }
    }
    state.buffer.replaceCurrentLine(completion.start, completion.end, item.insertion);
    state.completion = null;
    state.status = item.anchor ? `Created fragment · ^${item.anchor.fragmentId}` : "";
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
        const target = navigationHistory[targetIndex];
        if (!target) {
          state.status = "No further navigation history";
          break;
        }
        navigationIndex = targetIndex;
        await loadBlock(
          target.blockId,
          true,
          false,
          target.fragmentId,
        );
        state.status = direction < 0 ? "Navigation back" : "Navigation forward";
        break;
      }
      case "reference.open":
      case "reference.follow":
      case "reference.reveal": {
        const reference = intent.type === "reference.open"
          ? intent.target
          : state.context.selected
            ? firstOutlinerReference(state.projectedSelectedText, state.workIdPrefix)
            : null;
        if (!reference) {
          state.status = "Selected block has no block or page references";
          break;
        }
        const preserveSource = intent.type === "reference.open" &&
          intent.target.preserveSource === true;
        const navigationIntent: OutlinerNavigationIntent =
          intent.type === "reference.reveal" ||
            (intent.type === "reference.open" && intent.target.intent === "reveal")
            ? "reveal"
            : "open";
        if (reference.kind === "page") {
          await effects.resolveNavigation(navigationIntent, { preserveSource });
        }
        const resolved = await effects.resolveReference(reference);
        const dispatched = await effects.dispatchNavigation(
          resolved.block.id,
          navigationIntent,
          {
            preserveSource,
            fragmentId: reference.kind === "block" ? reference.fragmentId : undefined,
          },
        );
        if (dispatched.targetClientId === effects.clientId && navigationIntent === "open") {
          const applied = await applyNavigationCommand({
            targetClientId: effects.clientId,
            command: "open",
            blockId: resolved.block.id,
            ...(reference.kind === "block" && reference.fragmentId
              ? { fragmentId: reference.fragmentId }
              : {}),
          });
          if (!applied) {
            state.status = "Locked · ordinary navigation preserved this Detail";
            break;
          }
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
      case "backlinks.toggle":
        state.backlinks.expanded = !state.backlinks.expanded;
        state.backlinks.filterDraft = null;
        if (state.backlinks.expanded) {
          await loadBacklinks();
          state.status = state.backlinks.error || "Backlinks expanded";
        } else {
          state.status = "Backlinks collapsed";
        }
        break;
      case "backlinks.move": {
        const maximum = Math.max(0, visibleBacklinkSources(state.backlinks).length - 1);
        state.backlinks.selectedIndex = Math.max(
          0,
          Math.min(maximum, state.backlinks.selectedIndex + intent.delta),
        );
        break;
      }
      case "backlinks.filter.begin":
        state.backlinks.filterDraft = state.backlinks.filter;
        state.status = "Filtering backlinks";
        break;
      case "backlinks.filter.input":
        state.backlinks.filterDraft = `${state.backlinks.filterDraft ?? ""}${intent.text}`;
        break;
      case "backlinks.filter.backspace":
        state.backlinks.filterDraft = (state.backlinks.filterDraft ?? "").slice(0, -1);
        break;
      case "backlinks.filter.commit":
        state.backlinks.filter = (state.backlinks.filterDraft ?? "").trim();
        state.backlinks.filterDraft = null;
        state.backlinks.selectedIndex = 0;
        state.status = state.backlinks.filter
          ? `Filtered backlinks by “${state.backlinks.filter}”`
          : "Backlink filter cleared";
        break;
      case "backlinks.filter.cancel":
        state.backlinks.filterDraft = null;
        state.status = "Backlink filter unchanged";
        break;
      case "backlinks.sort.cycle": {
        const options: Array<[
          DetailBacklinkSortField,
          DetailBacklinkSortDirection,
        ]> = [
          ["updated", "desc"],
          ["updated", "asc"],
          ["created", "desc"],
          ["created", "asc"],
        ];
        const current = options.findIndex(([field, direction]) =>
          field === state.backlinks.sortField && direction === state.backlinks.sortDirection
        );
        const [field, direction] = options[(current + 1) % options.length];
        state.backlinks.sortField = field;
        state.backlinks.sortDirection = direction;
        state.backlinks.selectedIndex = 0;
        state.status = `Backlinks sorted by ${field} ${direction}`;
        break;
      }
      case "backlinks.source.toggle": {
        const blockId = intent.blockId ?? selectedBacklinkSource()?.blockId;
        if (!blockId) {
          state.status = "No backlink source selected";
          break;
        }
        if (state.backlinks.expandedSourceIds.has(blockId)) {
          state.backlinks.expandedSourceIds.delete(blockId);
        } else {
          state.backlinks.expandedSourceIds.add(blockId);
        }
        break;
      }
      case "backlinks.open":
      case "backlinks.reveal": {
        const source = selectedBacklinkSource();
        if (!source) {
          state.status = "No backlink source selected";
          break;
        }
        const navigationIntent: OutlinerNavigationIntent =
          intent.type === "backlinks.reveal" ? "reveal" : "open";
        await effects.dispatchNavigation(
          source.blockId,
          navigationIntent,
          navigationIntent === "open" ? { preserveSource: true } : undefined,
        );
        state.status = navigationIntent === "open"
          ? `Opened ${source.title} in another unlocked Detail`
          : `Revealed ${source.title}`;
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
        try {
          await applyCompletion();
        } catch (error) {
          state.status = errorMessage(error);
        }
        ensureEditorCursorVisible(viewport);
        break;
      case "completion.dismiss":
        if (state.completion) state.status = "";
        state.completion = null;
        ensureEditorCursorVisible(viewport);
        break;
      case "embed-background.toggle":
        state.embedBackgroundEnabled = !state.embedBackgroundEnabled;
        state.status = state.embedBackgroundEnabled
          ? "Embedded item backgrounds shown"
          : "Embedded item backgrounds hidden";
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
        if (
          state.connectionMode === "locked" &&
          (command.command === "preview" || command.command === "open")
        ) {
          return;
        }
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
            state.status = command.fragmentId
              ? `Opened fragment · ^${command.fragmentId} · line ${state.previewOffset + 1} · still unlocked`
              : "Opened here · still unlocked · L locks this block";
          }
        }
        if (command.command === "edit") await beginEdit(viewport);
        if (command.command !== "preview") effects.focusSelf();
        emit();
        return;
      }
      if (event.domain === "content") invalidateBacklinks();
      if (event.domain === "selection" || event.domain === "browsing-context") return;
      if (isBufferMode()) {
        state.refreshPending = true;
        return;
      }
      await loadCurrentTarget(event.domain === "content");
      await loadBacklinks();
      emit();
    },
    async onServiceConnect() {
      serviceConnected = true;
      await effects.setLocked(state.connectionMode === "locked");
      await effects.setCurrentBlock(state.targetBlockId);
      state.status = "";
      if (isBufferMode()) state.refreshPending = true;
      else await loadCurrentTarget(true);
      emit();
    },
    onServiceDisconnect() {
      serviceConnected = false;
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
