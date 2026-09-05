import type { BacklinkPeekLaunch } from "./backlink-peek";
import {
  DEFAULT_OUTLINER_ACTION_KEYMAP,
  type OutlinerActionKeymap,
} from "./outliner-actions";
import {
  annotationOffsetsForLineRange,
  annotationSourceHash,
  createAnnotationAnchor,
  extractAnnotationBody,
  parseAnnotationBlock,
  reanchorAnnotation,
} from "./annotations";
import {
  completionTargetAtCursor,
  pageAddressCompletion,
  pageCompletionLookupQuery,
} from "./completion";
import { rankBlockFocusMatches, subsequenceScore } from "./block-focus";
import {
  detailEditorPositionAtVisualPoint,
  detailEditorVisualRowForSourceLine,
  layoutDetailEditor,
} from "./detail-editor-layout";
import type { DetailEmbedRange, DetailEmbedState, DetailReadProjection } from "./detail-embeds";
import {
  ensureHeadingFragment,
  fragmentCandidates,
  parseFragmentCompletionQuery,
  resolveFragment,
} from "./fragments";
import type { ReferencedFile, ReferencedPathCandidate } from "./files";
import { firstOutlinerReference, type OutlinerLinkTarget } from "./outliner-links";
import {
  createOpenDestinationChooserState,
  OpenDestinationChooser,
  type OpenDestinationChooserState,
  type OpenDestinationScheduler,
  type OpenDestinationTarget,
} from "./open-destination-chooser";
import { getProperty } from "./properties";
import {
  createPropertyInspectorModel,
  filterPropertyInspectorEntries,
  type PropertyInspectorEntry,
  type PropertyInspectorGroupBy,
  type PropertyInspectorModel,
  type PropertyInspectorTarget,
} from "./property-inspector";
import {
  focusedPreviewRegion,
  movePreviewRegionFocus,
  reconcilePreviewRegions,
  togglePreviewRegionDisclosure,
  type PreviewRegion,
  type PreviewRegionAction,
  type PreviewRegionState,
} from "./detail-preview-regions";
import { blockDisplayTitle } from "./references";
import { TextBuffer } from "./text-buffer";
import type { TerminalKey } from "./terminal";
import type {
  AnnotationBatchReceipt,
  AnnotationCreateInput,
  AnnotationReanchorInput,
  AnnotationThread,
  AnnotationTarget,
  BacklinkCollection,
  BacklinkSource,
  BacklinkQuery,
  Block,
  BlockSearchQuery,
  BrowsingContextState,
  PageAddressCollection,
  OutlinerEvent,
  PropertyPatchOperation,
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

export type DetailMode = "preview" | "file" | "annotation" | "edit" | "select" | "comment";
export type DetailConnectionMode = "unlocked" | "locked";

export interface DetailViewport {
  width: number;
  editorWidth?: number;
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
export type DetailPropertyInspectorPresentation = "inline" | "dedicated";

export interface DetailPropertyValueEdit {
  occurrenceId: string;
  ordinal: number;
  blockId: string;
  expectedUpdatedAt: string;
  buffer: TextBuffer;
}

export interface DetailPropertyInspectorState {
  presentation: DetailPropertyInspectorPresentation;
  model: PropertyInspectorModel | null;
  expanded: boolean;
  groupBy: PropertyInspectorGroupBy | null;
  filter: string;
  filterDraft: string | null;
  viewportOffset: number;
  edit: DetailPropertyValueEdit | null;
}

export interface DetailControllerOptions {
  propertyInspectorPresentation?: DetailPropertyInspectorPresentation;
  destinationTimeoutMs?: number;
  initialTargetFragmentId?: string;
  destinationScheduler?: OpenDestinationScheduler;
  actionKeymap?: OutlinerActionKeymap;
}

export function visiblePropertyInspectorEntries(
  inspector: Readonly<DetailPropertyInspectorState>,
): PropertyInspectorEntry[] {
  if (!inspector.model) return [];
  return filterPropertyInspectorEntries(inspector.model.entries, {
    query: inspector.filterDraft ?? inspector.filter,
  });
}

export function propertyInspectorTargetLink(
  target: PropertyInspectorTarget,
  options: { preserveSource?: boolean; intent?: "reveal" } = {},
): OutlinerLinkTarget {
  if (target.kind === "block") {
    return {
      kind: "block",
      value: target.blockId,
      ...(target.fragmentId ? { fragmentId: target.fragmentId } : {}),
      ...options,
    };
  }
  if (target.kind === "work-id") {
    return { kind: "work", value: target.workId, ...options };
  }
  return { kind: "page", value: target.address, ...options };
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
export interface DetailAnnotationDraft {
  requestId: string;
  target: AnnotationTarget;
  returnMode: "preview" | "file";
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
  editorViewportManual?: boolean;
  draftPreviewLinked?: boolean;
  fileOffset: number;
  fileCursor: number;
  selectionAnchor: number | null;
  annotationThreads: AnnotationThread[];
  annotationRange: DetailLineRange | null;
  annotationDraft?: DetailAnnotationDraft;
  completion: DetailCompletionState | null;
  status: string;
  busy: boolean;
  refreshPending: boolean;
  backlinks: DetailBacklinkState;
  propertyInspector: DetailPropertyInspectorState;
  previewRegions: PreviewRegionState;
  destinationChooser: OpenDestinationChooserState;
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
  openBacklinkPeek(input: BacklinkPeekLaunch): void;
  openDetailPane(
    blockId: string,
    direction: "right" | "down",
    fragmentId?: string,
  ): void | Promise<void>;
  copyText(text: string): void;
  updateBlock(input: {
    blockId: string;
    text: string;
    expectedUpdatedAt: string;
  }): Promise<Block>;
  patchProperties(input: {
    blockId: string;
    expectedUpdatedAt: string;
    operations: PropertyPatchOperation[];
  }): Promise<Block>;
  createAnnotation(input: {
    requestId: string;
    input: AnnotationCreateInput;
  }): Promise<AnnotationBatchReceipt>;
  listAnnotations(sourceBlockId: string): Promise<AnnotationThread[]>;
  reanchorAnnotations(input: AnnotationReanchorInput): Promise<AnnotationThread[]>;
  restoreBlock(blockId: string): Promise<Block>;
  resolveReference(target: OutlinerLinkTarget): Promise<{ block: Block; created?: boolean }>;
  queryBlocks(query: BlockSearchQuery): Promise<VisibleBlockCollection>;
  queryPageAddresses(query: string | undefined, limit: number): Promise<PageAddressCollection>;
  readFile(block: Block): ReferencedFile;
  completeFiles(query: string): ReferencedPathCandidate[];
  focusOutliner(): Promise<void>;
  openPropertyInspectorPane(blockId: string): string | Promise<string>;
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

export type DetailOpenRouting = "first-unlocked" | "chooser";

export type DetailIntent =
  | { type: "edit.begin" }
  | { type: "annotation.selection.begin" }
  | { type: "trash.restore" }
  | { type: "comment.begin" }
  | { type: "navigation.back" }
  | { type: "navigation.forward" }
  | { type: "reference.follow" }
  | { type: "reference.open"; target: OutlinerLinkTarget; routing?: DetailOpenRouting }
  | { type: "reference.reveal" }
  | { type: "current.reveal" }
  | { type: "backlinks.move"; delta: -1 | 1 }
  | { type: "backlinks.open" }
  | { type: "backlinks.reveal" }
  | { type: "backlinks.toggle" }
  | { type: "backlinks.filter.begin" }
  | { type: "backlinks.filter.input"; text: string }
  | { type: "annotation.reveal" }
  | { type: "backlinks.filter.backspace" }
  | { type: "backlinks.filter.commit" }
  | { type: "backlinks.filter.cancel" }
  | { type: "backlinks.sort.cycle" }
  | { type: "backlinks.source.toggle"; blockId?: string }
  | { type: "preview.focus.move"; delta: -1 | 1 }
  | { type: "preview.focus.set"; regionId: string }
  | { type: "preview.activate" }
  | { type: "preview.action"; action: PreviewRegionAction; routing?: DetailOpenRouting }
  | { type: "property-inspector.disclosure.toggle" }
  | { type: "property-inspector.pane.open" }
  | { type: "pane.open"; direction: "right" | "down" }
  | { type: "property-inspector.target.open"; occurrenceId: string; intent: "open" | "reveal"; routing?: DetailOpenRouting }
  | { type: "property-inspector.group.cycle" }
  | { type: "property-inspector.filter.begin" }
  | { type: "property-inspector.filter.input"; text: string }
  | { type: "property-inspector.filter.backspace" }
  | { type: "property-inspector.filter.commit" }
  | { type: "property-inspector.filter.cancel" }
  | { type: "property-inspector.viewport.navigate"; direction: "up" | "down" | "pageup" | "pagedown" | "home" | "end" }
  | { type: "property-inspector.edit.begin" }
  | { type: "property-inspector.edit.insert"; text: string }
  | { type: "property-inspector.edit.backspace" }
  | { type: "property-inspector.edit.delete" }
  | { type: "property-inspector.edit.move"; direction: "left" | "right" | "home" | "end" }
  | { type: "property-inspector.edit.commit" }
  | { type: "property-inspector.edit.cancel" }
  | { type: "property-inspector.edit.select-all" }
  | { type: "embed-background.toggle" }
  | { type: "lock.toggle" }
  | { type: "buffer.insert"; text: string }
  | { type: "buffer.newline" }
  | { type: "buffer.backspace" }
  | { type: "buffer.delete" }
  | { type: "buffer.move"; direction: DetailBufferMoveDirection; extend?: boolean }
  | { type: "buffer.select-all" }
  | { type: "buffer.copy" }
  | { type: "buffer.undo" }
  | { type: "buffer.redo" }
  | { type: "buffer.save" }
  | { type: "editor.viewport.scroll"; delta: number }
  | { type: "editor.viewport.anchor"; sourceLine: number }
  | { type: "editor.cursor.place"; visualRow: number; contentColumn: number; extend?: boolean }
  | { type: "draft-preview.link.toggle" }
  | { type: "buffer.cancel" }
  | { type: "completion.open" }
  | { type: "completion.move"; delta: -1 | 1 }
  | { type: "completion.accept" }
  | { type: "completion.dismiss" }
  | { type: "preview.navigate"; direction: "up" | "down" | "pageup" | "pagedown" | "top" | "bottom" }
  | { type: "file.navigate"; direction: "up" | "down" | "pageup" | "pagedown" | "home" | "end" }
  | { type: "file.selection.toggle" }
  | { type: "view.file" }
  | { type: "view.block" }
  | { type: "focus.outliner"; announce?: boolean }
  | { type: "viewport.changed" }
  | { type: "status.set"; message: string }
  | { type: "redraw" };

export interface DetailController {
  readonly state: Readonly<DetailState>;
  initialize(): Promise<void>;
  isBufferMode(): boolean;
  dispatch(intent: DetailIntent, viewport: DetailViewport): Promise<void>;
  setPreviewRegions(regions: readonly PreviewRegion[]): void;
  onServiceEvent(event: OutlinerEvent, viewport: DetailViewport): Promise<void>;
  handleDestinationChooserKeypress(str: string, key: TerminalKey): Promise<boolean>;
  destinationChooserHelpText(): string;
  onServiceConnect(viewport: DetailViewport): Promise<void>;
  onServiceDisconnect(): void;
  onServiceError(error: unknown): void;
  refreshPendingSelection(): Promise<void>;
}

export function detailDisplayMode(block: Block | null): "preview" | "file" | "annotation" {
  if (!block) return "preview";
  if (getProperty(block.properties, "type")?.startsWith("annotation")) return "annotation";
  return getProperty(block.properties, "file") ? "file" : "preview";
}

export function detailHelpText(mode: DetailMode): string {
  return DEFAULT_OUTLINER_ACTION_KEYMAP.helpText("detail", mode);
}

export function selectedDetailFileRange(state: Readonly<DetailState>): DetailLineRange | null {
  if (!state.referencedFile) return null;
  const anchor = state.selectionAnchor ?? state.fileCursor;
  return {
    startLine: state.referencedFile.firstLine + Math.min(anchor, state.fileCursor),
    endLine: state.referencedFile.firstLine + Math.max(anchor, state.fileCursor),
  };
}

function detailBufferRangeOffsets(buffer: Readonly<TextBuffer>): { start: number; end: number } | null {
  const range = buffer.selectionRange;
  if (!range) return null;
  const offset = (row: number, column: number): number => {
    let total = column;
    for (let index = 0; index < row; index += 1) total += buffer.lines[index]!.length + 1;
    return total;
  };
  return {
    start: offset(range.start.row, range.start.column),

    end: offset(range.end.row, range.end.column),
  };
}
function detailBufferPointAtOffset(text: string, offset: number): { row: number; column: number } {
  const clamped = Math.max(0, Math.min(offset, text.length));
  const before = text.slice(0, clamped);
  const lines = before.split("\n");
  return { row: lines.length - 1, column: lines[lines.length - 1]!.length };
}

export function detailAnnotationLineCount(state: Readonly<DetailState>): number {
  const comment = extractAnnotationBody(state.resolvedSelectedText) || "(No comment text)";
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
  options: DetailControllerOptions = {},
): DetailController {
  const destinationChooserState = createOpenDestinationChooserState();
  const state: DetailState = {
    context: { selected: null, ancestors: [], children: [] },
    targetBlockId: null,
    targetFragmentId: null,
    connectionMode: options.propertyInspectorPresentation === "dedicated" ? "locked" : "unlocked",
    canNavigateBack: false,
    annotationThreads: [],
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
    editorViewportManual: false,
    draftPreviewLinked: false,
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
    propertyInspector: {
      presentation: options.propertyInspectorPresentation ?? "inline",
      model: null,
      expanded: options.propertyInspectorPresentation === "dedicated",
      groupBy: null,
      filter: "",
      filterDraft: null,
      viewportOffset: 0,
      edit: null,
    },
    previewRegions: {
      regions: [],
      focusedRegionId: null,
      disclosureOverrides: new Map(),
    },
    destinationChooser: destinationChooserState,
  };
  const navigationHistory: DetailNavigationEntry[] = [];
  let navigationIndex = -1;
  let pendingUiCommand: OutlinerUiCommand | null = null;
  let serviceConnected = false;
  let destinationChooser: OpenDestinationChooser | undefined;
  const destinationReferences = new WeakMap<OpenDestinationTarget, OutlinerLinkTarget>();
  let startupTargetFragmentId = options.initialTargetFragmentId ?? null;

  const emit = (): void => onChange(state);
  const isBufferMode = (): boolean =>
    state.mode === "edit" || state.mode === "select" || state.mode === "comment" ||
    state.propertyInspector.edit !== null;

  const refreshBreadcrumb = (): void => {
    const titles = state.context.ancestors.map(blockDisplayTitle);
    if (state.context.selected) {
      titles.push(blockDisplayTitle({ ...state.context.selected, text: state.resolvedSelectedText }));
    }
    state.resolvedBreadcrumb = titles.join(" › ");
  };

  const loadFile = (block: Block): void => {
    try {
      if (getProperty(block.properties, "type")?.startsWith("annotation")) {
        try {
          const annotation = parseAnnotationBlock(block);
          if (annotation.target.kind === "block") {
            state.referencedFile = null;
            return;
          }
          const source = [...state.context.ancestors, state.context.selected, ...state.context.children]
            .find((candidate) => candidate?.id === annotation.target.sourceBlockId);
          if (!source) throw new Error(`Annotation source block is outside the loaded context: ${annotation.target.sourceBlockId}`);
          state.referencedFile = effects.readFile(source);
        } catch {
          state.referencedFile = effects.readFile(block);
        }
      } else {
        state.referencedFile = effects.readFile(block);
      }
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

  const loadAnnotations = async (): Promise<void> => {
    const selected = state.context.selected;
    if (!selected) {
      state.annotationThreads = [];
      return;
    }
    let sourceBlockId = selected.id;
    let sourceText = selected.text;
    let sourceVersion = selected.updatedAt;
    let sourceHash: string | undefined;
    if (getProperty(selected.properties, "type")?.startsWith("annotation")) {
      try {
        const annotation = parseAnnotationBlock(selected);
        sourceBlockId = annotation.target.sourceBlockId;
        const source = [...state.context.ancestors, ...state.context.children]
          .find((candidate) => candidate.id === sourceBlockId);
        if (annotation.target.kind === "file" && state.referencedFile?.sourceText !== undefined) {
          sourceText = state.referencedFile.sourceText;
          sourceVersion = state.referencedFile.sourceVersion ?? source?.updatedAt ?? sourceVersion;
          sourceHash = state.referencedFile.sourceHash;
        } else if (source) {
          sourceText = source.text;
          sourceVersion = source.updatedAt;
        }
      } catch {
        sourceBlockId = getProperty(selected.properties, "source-block") ?? selected.id;
      }
    } else if (state.referencedFile?.sourceText !== undefined) {
      sourceText = state.referencedFile.sourceText;
      sourceVersion = state.referencedFile.sourceVersion ?? selected.updatedAt;
      sourceHash = state.referencedFile.sourceHash;
    }
    try {
      state.annotationThreads = await effects.reanchorAnnotations({
        sourceBlockId,
        sourceText,
        sourceVersion,
        ...(sourceHash ? { sourceHash } : {}),
      });
    } catch {
      state.annotationThreads = await effects.listAnnotations(sourceBlockId).catch(() => []);
    }
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

  const syncPropertyInspector = (block: Block | null, targetChanged: boolean): void => {
    state.propertyInspector.model = block
      ? createPropertyInspectorModel(block.id, block.text)
      : null;
    if (!targetChanged) return;
    state.propertyInspector.filter = "";
    state.propertyInspector.filterDraft = null;
    state.propertyInspector.edit = null;
    state.propertyInspector.viewportOffset = 0;
    state.previewRegions.focusedRegionId = null;
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
    const targetChanged = (next.selected?.id ?? null) !== state.targetBlockId;
    const fragmentChanged = fragmentId !== state.targetFragmentId;
    const changed =
      targetChanged ||
      fragmentChanged ||
      next.selected?.updatedAt !== state.context.selected?.updatedAt;
    if (targetChanged || fragmentChanged) destinationChooser?.dispose();
    if (targetChanged) state.previewRegions.disclosureOverrides.clear();
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
    syncPropertyInspector(next.selected, targetChanged);

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
    state.mode = state.propertyInspector.presentation === "dedicated"
      ? "preview"
      : detailDisplayMode(next.selected);
    if (next.selected?.deletedAt) {
      state.status = "In Trash — read-only · r restore";
    } else if (next.selected?.effectiveDeletedRootId) {
      state.status = "In Trash — read-only · restore its direct Trash root";
    }
    if ((state.mode === "file" || state.mode === "annotation") && next.selected) loadFile(next.selected);
    else state.referencedFile = null;
    await loadBacklinks();
    await loadAnnotations();
  };

  const loadBrowsingContext = async (force = false): Promise<void> => {
    const browsingContext = await effects.getBrowsingContext();
    const fragmentId = startupTargetFragmentId;
    startupTargetFragmentId = null;
    await applyTarget(browsingContext.target, force, true, fragmentId);
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
      if (blockId !== state.targetBlockId) {
        state.previewRegions.disclosureOverrides.clear();
      }
      if (record) recordNavigation(state.targetBlockId, state.targetFragmentId);
      state.context = { selected: null, ancestors: [], children: [] };
      syncPropertyInspector(null, true);
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

  const resolveDestinationTarget = async (
    target: OpenDestinationTarget,
    reference: OutlinerLinkTarget,
  ): Promise<void> => {
    const resolved = await effects.resolveReference(reference);
    target.blockId = resolved.block.id;
    target.title = blockDisplayTitle(resolved.block);
  };

  const openFirstUnlocked = async (
    target: OpenDestinationTarget,
    preserveSource = false,
  ): Promise<boolean> => {
    try {
      const dispatched = await effects.dispatchNavigation(target.blockId, "open", {
        ...(preserveSource ? { preserveSource: true } : {}),
        ...(target.fragmentId ? { fragmentId: target.fragmentId } : {}),
      });
      if (dispatched.targetClientId === effects.clientId) {
        await applyNavigationCommand(dispatched.command);
      }
      state.status = `Opened ${target.title} in first unlocked Detail`;
      return true;
    } catch (error) {
      if (
        errorMessage(error) ===
          "All Details in this tab are locked · unlock one or open another Detail"
      ) {
        return false;
      }
      throw error;
    }
  };

  destinationChooser = new OpenDestinationChooser({
    beforeOpen: async (target) => {
      const reference = destinationReferences.get(target);
      if (reference) await resolveDestinationTarget(target, reference);
    },
    replace: async (target) => {
      if (isBufferMode()) {
        throw new Error("Finish or cancel the active edit before replacing this Detail");
      }
      await applyNavigationCommand({
        targetClientId: effects.clientId,
        command: "replace",
        blockId: target.blockId,
        ...(target.fragmentId ? { fragmentId: target.fragmentId } : {}),
      });
      state.status = state.connectionMode === "locked"
        ? "Replaced here · remains locked · L unlocks this block"
        : "Replaced here · still unlocked · L locks this block";
    },
    openFirstUnlocked: (target) =>
      openFirstUnlocked(
        target,
        destinationReferences.get(target)?.preserveSource === true,
      ),
    openNewDetail: async (target, direction) => {
      await effects.openDetailPane(target.blockId, direction, target.fragmentId);
      state.status = direction === "right"
        ? `Opened ${target.title} to the right`
        : `Opened ${target.title} below`;
    },
    invalidate: emit,
  }, {
    state: destinationChooserState,
    ...(options.destinationTimeoutMs === undefined
      ? {}
      : { timeoutMs: options.destinationTimeoutMs }),
    ...(options.destinationScheduler === undefined
      ? {}
      : { scheduler: options.destinationScheduler }),
    actionKeymap: options.actionKeymap,
  });

  const refreshPendingTarget = async (): Promise<void> => {
    const command = pendingUiCommand;
    pendingUiCommand = null;
    if (command) await applyNavigationCommand(command);
    else await loadCurrentTarget(true);
  };

  const editorLayout = (viewport: DetailViewport) =>
    layoutDetailEditor(
      state.buffer.lines,
      state.buffer.row,
      state.buffer.column,
      viewport.editorWidth ?? viewport.width,
      state.buffer.selectionRange,
    );

  const ensureEditorCursorVisible = (viewport: DetailViewport): void => {
    state.editorViewportManual = false;
    const visibleHeight = detailVisibleEditorHeight(state, viewport);
    const layout = editorLayout(viewport);
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
    state.editorViewportManual = false;
    state.draftPreviewLinked = false;
    state.completion = null;
    state.mode = "edit";
    state.status = "Locked for editing";
    ensureEditorCursorVisible(viewport);
  };

  const beginPropertyEdit = async (): Promise<void> => {
    const selected = state.context.selected;
    if (!selected) {
      state.status = "No selected block to edit";
      return;
    }
    if (selected.deletedAt || selected.effectiveDeletedRootId) {
      state.status = "Block is in Trash; restore before editing";
      return;
    }
    const focusedId = state.previewRegions.focusedRegionId;
    const entry = state.propertyInspector.model?.entries.find(
      (candidate) => candidate.occurrenceId === focusedId,
    );
    if (!entry) {
      state.status = "Focus a property value before editing";
      return;
    }
    await setLocked(true);
    const buffer = new TextBuffer(entry.value);
    buffer.moveEnd();
    state.propertyInspector.edit = {
      occurrenceId: entry.occurrenceId,
      ordinal: entry.ordinal,
      blockId: selected.id,
      expectedUpdatedAt: selected.updatedAt,
      buffer,
    };
    state.status = `Editing ${entry.key} · ↵ save · ⎋ cancel`;
  };

  const cancelPropertyEdit = (): void => {
    state.propertyInspector.edit = null;
    state.status = "Property edit cancelled";
  };

  const commitPropertyEdit = async (): Promise<void> => {
    const edit = state.propertyInspector.edit;
    if (!edit || state.busy) return;
    state.busy = true;
    try {
      const updated = await effects.patchProperties({
        blockId: edit.blockId,
        expectedUpdatedAt: edit.expectedUpdatedAt,
        operations: [{ op: "replace", ordinal: edit.ordinal, value: edit.buffer.text }],
      });
      state.propertyInspector.edit = null;
      if (state.refreshPending) {
        await refreshPendingTarget();
        return;
      }
      state.context = { ...state.context, selected: updated };
      syncPropertyInspector(updated, false);
      await applyReadProjection(updated.text, updated.id);
      refreshBreadcrumb();
      const editedEntry = state.propertyInspector.model?.entries[edit.ordinal];
      state.previewRegions.focusedRegionId = editedEntry?.occurrenceId ?? "property-inspector";
      state.status = editedEntry
        ? `Updated ${editedEntry.key}`
        : "Updated property";
    } catch (error) {
      state.status = errorMessage(error);
    } finally {
      state.busy = false;
    }
  };

  const beginAnnotationSelection = async (): Promise<void> => {
    const selected = state.context.selected;
    if (!selected || selected.effectiveDeletedRootId) {
      state.status = "Block is in Trash; restore before adding annotations";
      return;
    }
    await setLocked(true);
    state.buffer = new TextBuffer(selected.text);
    state.editorVisualOffset = 0;
    state.editorViewportManual = false;
    state.draftPreviewLinked = false;
    state.completion = null;
    state.annotationDraft = undefined;
    state.mode = "select";
    state.status = "Locked · select source text, then press c to comment";
  };

  const beginComment = async (): Promise<void> => {
    const selected = state.context.selected;
    if (!selected || selected.effectiveDeletedRootId) {
      state.status = "Block is in Trash; restore before adding annotations";
      return;
    }
    let target: AnnotationTarget;
    let returnMode: "preview" | "file";
    if (state.mode === "select") {
      const offsets = detailBufferRangeOffsets(state.buffer);
      if (!offsets) {
        state.status = "Select a non-empty source range before commenting";
        return;
      }
      const sourceText = state.buffer.text;
      target = {
        kind: "block",
        sourceBlockId: selected.id,
        anchor: createAnnotationAnchor(
          sourceText,
          offsets.start,
          offsets.end,
          selected.updatedAt,
          annotationSourceHash(sourceText),
        ),
      };
      returnMode = "preview";
    } else {
      const range = selectedDetailFileRange(state);
      const file = state.referencedFile;
      if (!range || !file) return;
      const sourceText = file.sourceText ?? file.lines.join("\n");
      const offsetRange = annotationOffsetsForLineRange(
        sourceText,
        file.sourceText ? range.startLine : range.startLine - file.firstLine + 1,
        file.sourceText ? range.endLine : range.endLine - file.firstLine + 1,
      );
      target = {
        kind: "file",
        sourceBlockId: selected.id,
        filePath: file.sourcePath,
        startLine: range.startLine,
        endLine: range.endLine,
        anchor: createAnnotationAnchor(
          sourceText,
          offsetRange.start,
          offsetRange.end,
          file.sourceVersion ?? selected.updatedAt,
          file.sourceHash ?? annotationSourceHash(sourceText),
        ),
      };
      returnMode = "file";
      state.annotationRange = range;
    }
    await setLocked(true);
    state.annotationDraft = { requestId: crypto.randomUUID(), target, returnMode };
    state.buffer = new TextBuffer();
    state.editorVisualOffset = 0;
    state.draftPreviewLinked = false;
    state.completion = null;
    state.mode = "comment";
    state.status = target.kind === "file"
      ? `Locked · commenting on ${target.filePath}:${target.startLine}-${target.endLine}`
      : `Locked · commenting on source range ${target.anchor.start}-${target.anchor.end}`;
  };

  const focusOutliner = async (announce: boolean): Promise<void> => {
    try {
      await effects.focusOutliner();
      if (announce) state.status = "Focus returned to outliner; ⌃Q closes detail";
    } catch (error) {
      state.status = errorMessage(error);
    }
    emit();
  };

  const cancelBuffer = async (): Promise<void> => {
    const cancelledMode = state.mode;
    state.mode = detailDisplayMode(state.context.selected);
    state.annotationDraft = undefined;
    state.status = cancelledMode === "comment" ? "Comment cancelled" : "Edit cancelled";
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
      } else if (state.mode === "comment" && state.annotationDraft) {
        const draft = state.annotationDraft;
        const body = state.buffer.text.trim();
        if (!body) throw new Error("Annotation body cannot be empty");
        await effects.createAnnotation({
          requestId: draft.requestId,
          input: {
            target: draft.target,
            body,
            source: "user",
          },
        });
        state.mode = draft.returnMode;
        state.annotationDraft = undefined;
        state.selectionAnchor = null;
        state.status = draft.target.kind === "file"
          ? `Annotation added for lines ${draft.target.startLine}-${draft.target.endLine}`
          : `Annotation added for source range ${draft.target.anchor.start}-${draft.target.anchor.end}`;
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
      state.status = "Type [[named address]], [[target|label]], or ((fuzzy block))";
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
      const collection = await effects.queryPageAddresses(
        pageCompletionLookupQuery(target.query, state.workIdPrefix) || undefined,
        20,
      );
      items = collection.addresses.map((address) =>
        pageAddressCompletion(address, target.query, state.workIdPrefix)
      );
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
          state.status =
            "No matching named addresses; [[target|label]] labels a target, ((...)) searches blocks";
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
    direction: "up" | "down" | "pageup" | "pagedown" | "top" | "bottom",
    viewport: DetailViewport,
  ): void => {
    const lineCount = state.mode === "annotation"
      ? detailAnnotationLineCount(state)
      : state.resolvedSelectedText.split(/\r?\n/).length;
    const maximum = Math.max(0, lineCount - 1);
    if (direction === "top") state.previewOffset = 0;
    else if (direction === "bottom") state.previewOffset = maximum;
    else {
      const amount = direction === "pageup" || direction === "pagedown"
        ? pageSize(viewport)
        : 1;
      const delta = direction === "up" || direction === "pageup" ? -amount : amount;
      state.previewOffset = Math.max(0, Math.min(maximum, state.previewOffset + delta));
    }
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
      case "annotation.selection.begin":
        await beginAnnotationSelection();
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
      case "current.reveal": {
        const current = state.context.selected;
        if (!current) {
          state.status = "No block selected";
          break;
        }
        await effects.dispatchNavigation(current.id, "reveal");
        state.status = `Revealed ${blockDisplayTitle(current)}`;
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
        const navigationIntent: OutlinerNavigationIntent =
          intent.type === "reference.reveal" ||
            (intent.type === "reference.open" && intent.target.intent === "reveal")
            ? "reveal"
            : "open";
        if (navigationIntent === "open" && isBufferMode()) {
          state.status = "Finish or cancel the active edit before opening another target";
          break;
        }
        const fragmentId = reference.kind === "block" ? reference.fragmentId : undefined;
        if (navigationIntent === "open") {
          const target: OpenDestinationTarget = {
            blockId: reference.value,
            title: reference.value,
            ...(fragmentId ? { fragmentId } : {}),
          };
          const routing = intent.type === "reference.open"
            ? intent.routing ?? "chooser"
            : "chooser";
          if (routing === "chooser") {
            destinationReferences.set(target, reference);
            destinationChooser!.open(target);
          } else {
            await resolveDestinationTarget(target, reference);
            if (!await openFirstUnlocked(target, reference.preserveSource === true)) {
              destinationChooser!.open(target);
            }
          }
          break;
        }
        if (reference.kind === "page") {
          await effects.resolveNavigation("reveal");
        }
        const resolved = await effects.resolveReference(reference);
        await effects.dispatchNavigation(
          resolved.block.id,
          "reveal",
          fragmentId ? { fragmentId } : {},
        );
        state.status = `Revealed ${blockDisplayTitle(resolved.block)}`;
        break;
      }
      case "pane.open": {
        const target = state.context.selected;
        if (!target) {
          state.status = "No block selected";
          break;
        }
        await effects.openDetailPane(
          target.id,
          intent.direction,
          state.targetFragmentId ?? undefined,
        );
        state.status = intent.direction === "right"
          ? `Opened ${blockDisplayTitle(target)} to the right`
          : `Opened ${blockDisplayTitle(target)} below`;
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
      case "preview.focus.set": {
        const region = state.previewRegions.regions.find((candidate) =>
          candidate.id === intent.regionId && candidate.focusable
        );
        if (!region) {
          state.status = "Preview row is no longer visible";
          break;
        }
        state.previewRegions.focusedRegionId = region.id;
        if (region.kind === "backlink-source") {
          const blockId = region.activation?.type === "backlink.open"
            ? region.activation.blockId
            : null;
          const index = visibleBacklinkSources(state.backlinks)
            .findIndex((source) => source.blockId === blockId);
          if (index >= 0) state.backlinks.selectedIndex = index;
        }
        break;
      }
      case "preview.focus.move": {
        const region = movePreviewRegionFocus(state.previewRegions, intent.delta);
        if (region?.kind === "backlink-source") {
          const blockId = region.activation?.type === "backlink.open"
            ? region.activation.blockId
            : null;
          const index = visibleBacklinkSources(state.backlinks)
            .findIndex((source) => source.blockId === blockId);
          if (index >= 0) state.backlinks.selectedIndex = index;
        }
        break;
      }
      case "preview.activate": {
        const action = focusedPreviewRegion(state.previewRegions)?.activation;
        if (action) await dispatch({ type: "preview.action", action }, viewport);
        break;
      }
      case "preview.action":
        switch (intent.action.type) {
          case "preview.region.focus":
            await dispatch({
              type: "preview.focus.set",
              regionId: intent.action.regionId,
            }, viewport);
            break;
          case "callout.disclosure.toggle":
            togglePreviewRegionDisclosure(state.previewRegions, intent.action.regionId);
            break;
          case "backlinks.disclosure.toggle":
            await dispatch({ type: "backlinks.toggle" }, viewport);
            break;
          case "backlink.source.disclosure.toggle":
            await dispatch({
              type: "backlinks.source.toggle",
              blockId: intent.action.blockId,
            }, viewport);
            break;
          case "backlink.open": {
            const blockId = intent.action.blockId;
            const index = visibleBacklinkSources(state.backlinks)
              .findIndex((candidate) => candidate.blockId === blockId);
            if (index < 0) {
              state.status = "Backlink source is no longer visible";
              break;
            }
            state.backlinks.selectedIndex = index;
            await dispatch({ type: "backlinks.open" }, viewport);
            break;
          }
          case "property-inspector.disclosure.toggle":
            await dispatch({ type: "property-inspector.disclosure.toggle" }, viewport);
            break;
          case "property-inspector.pane.open":
            await dispatch({ type: "property-inspector.pane.open" }, viewport);
            break;
          case "property-inspector.target.open":
            await dispatch({
              type: "property-inspector.target.open",
              occurrenceId: intent.action.occurrenceId,
              intent: "open",
              ...(intent.routing ? { routing: intent.routing } : {}),
            }, viewport);
            break;
        }
        break;
      case "property-inspector.disclosure.toggle": {
        if (state.propertyInspector.presentation === "dedicated") {
          state.status = "Dedicated property inspector remains expanded";
          break;
        }
        const expanded = togglePreviewRegionDisclosure(
          state.previewRegions,
          "property-inspector",
        );
        state.propertyInspector.expanded = expanded ?? !state.propertyInspector.expanded;
        state.previewRegions.disclosureOverrides.set(
          "property-inspector",
          state.propertyInspector.expanded,
        );
        state.status = state.propertyInspector.expanded
          ? "Properties expanded"
          : "Properties collapsed";
        break;
      }
      case "property-inspector.pane.open": {
        const blockId = state.propertyInspector.model?.blockId;
        if (!blockId) {
          state.status = "No selected block to inspect";
          break;
        }
        await effects.openPropertyInspectorPane(blockId);
        state.status = "Opened dedicated property inspector";
        break;
      }
      case "property-inspector.edit.begin":
        await beginPropertyEdit();
        break;
      case "property-inspector.edit.insert":
        state.propertyInspector.edit?.buffer.insert(intent.text);
        break;
      case "property-inspector.edit.backspace":
        state.propertyInspector.edit?.buffer.backspace();
        break;
      case "property-inspector.edit.delete":
        state.propertyInspector.edit?.buffer.deleteForward();
        break;
      case "property-inspector.edit.move": {
        const buffer = state.propertyInspector.edit?.buffer;
        if (!buffer) break;
        if (intent.direction === "left") buffer.moveLeft();
        else if (intent.direction === "right") buffer.moveRight();
        else if (intent.direction === "home") buffer.moveHome();
        else buffer.moveEnd();
        break;
      }
      case "property-inspector.edit.select-all":
        state.propertyInspector.edit?.buffer.selectAll();
        break;
      case "property-inspector.edit.commit":
        await commitPropertyEdit();
        break;
      case "property-inspector.edit.cancel":
        cancelPropertyEdit();
        break;
      case "property-inspector.target.open": {
        const entry = state.propertyInspector.model?.entries.find(
          (candidate) => candidate.occurrenceId === intent.occurrenceId,
        );
        if (!entry) {
          state.status = "Property occurrence is no longer available";
          break;
        }
        if (!entry.target) {
          state.status = `${entry.key} has no navigation target`;
          break;
        }
        await dispatch({
          type: "reference.open",
          target: propertyInspectorTargetLink(entry.target, {
            preserveSource: state.propertyInspector.presentation === "dedicated",
            ...(intent.intent === "reveal" ? { intent: "reveal" as const } : {}),
          }),
          routing: intent.routing ?? "chooser",
        }, viewport);
        break;
      }
      case "property-inspector.group.cycle": {
        const groups: Array<PropertyInspectorGroupBy | null> = [
          null,
          "key",
          "scope",
          "target",
        ];
        const current = groups.indexOf(state.propertyInspector.groupBy);
        state.propertyInspector.groupBy = groups[(current + 1) % groups.length]!;
        state.propertyInspector.viewportOffset = 0;
        state.status = state.propertyInspector.groupBy
          ? `Properties grouped by ${state.propertyInspector.groupBy}`
          : "Property grouping cleared";
        break;
      }
      case "property-inspector.filter.begin":
        state.propertyInspector.filterDraft = state.propertyInspector.filter;
        state.status = "Filtering properties";
        break;
      case "property-inspector.filter.input":
        state.propertyInspector.filterDraft = `${
          state.propertyInspector.filterDraft ?? ""
        }${intent.text}`;
        state.propertyInspector.viewportOffset = 0;
        break;
      case "property-inspector.filter.backspace":
        state.propertyInspector.filterDraft = (
          state.propertyInspector.filterDraft ?? ""
        ).slice(0, -1);
        state.propertyInspector.viewportOffset = 0;
        break;
      case "property-inspector.filter.commit":
        state.propertyInspector.filter = (
          state.propertyInspector.filterDraft ?? ""
        ).trim();
        state.propertyInspector.filterDraft = null;
        state.propertyInspector.viewportOffset = 0;
        state.status = state.propertyInspector.filter
          ? `Filtered properties by “${state.propertyInspector.filter}”`
          : "Property filter cleared";
        break;
      case "property-inspector.filter.cancel":
        state.propertyInspector.filterDraft = null;
        state.status = "Property filter unchanged";
        break;
      case "property-inspector.viewport.navigate": {
        const maximum = Math.max(
          0,
          visiblePropertyInspectorEntries(state.propertyInspector).length * 2 + 8 -
            pageSize(viewport),
        );
        const amount = intent.direction === "pageup" || intent.direction === "pagedown"
          ? pageSize(viewport)
          : 1;
        if (intent.direction === "home") state.propertyInspector.viewportOffset = 0;
        else if (intent.direction === "end") state.propertyInspector.viewportOffset = maximum;
        else {
          const delta = intent.direction === "up" || intent.direction === "pageup"
            ? -amount
            : amount;
          state.propertyInspector.viewportOffset = Math.max(
            0,
            Math.min(maximum, state.propertyInspector.viewportOffset + delta),
          );
        }
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
      case "backlinks.open": {
        const source = selectedBacklinkSource();
        const targetBlockId = state.targetBlockId;
        if (!source || !targetBlockId) {
          state.status = "No backlink source selected";
          break;
        }
        effects.openBacklinkPeek({
          sourceClientId: effects.clientId,
          browsingContextId: effects.browsingContextId,
          targetBlockId,
          selectedSourceBlockId: source.blockId,
          filter: state.backlinks.filter,
          sortField: state.backlinks.sortField,
          sortDirection: state.backlinks.sortDirection,
        });
        state.status = `Peeking ${source.title}`;
        break;
      }
      case "backlinks.reveal": {
        const source = selectedBacklinkSource();
        if (!source) {
          state.status = "No backlink source selected";
          break;
        }
        await effects.dispatchNavigation(source.blockId, "reveal");
        state.status = `Revealed ${source.title}`;
        break;
      }
      case "annotation.reveal": {
        const selected = state.context.selected;
        if (!selected) break;
        let annotation;
        try {
          annotation = parseAnnotationBlock(selected);
        } catch (error) {
          state.status = errorMessage(error);
          break;
        }
        await loadBlock(annotation.target.sourceBlockId, true);
        if (annotation.target.kind === "file") {
          if (!state.referencedFile) {
            state.status = `Referenced file unavailable: ${annotation.target.filePath}`;
            break;
          }
          state.mode = "file";
          state.selectionAnchor = Math.max(
            0,
            annotation.target.startLine - state.referencedFile.firstLine,
          );
          state.fileCursor = Math.min(
            state.referencedFile.lines.length - 1,
            Math.max(0, annotation.target.endLine - state.referencedFile.firstLine),
          );
          ensureFileCursorVisible(viewport);
          state.status = `Revealed ${annotation.target.filePath}:${annotation.target.startLine}-${annotation.target.endLine}`;
          break;
        }
        await beginAnnotationSelection();
        const reanchored = reanchorAnnotation(
          annotation.target.anchor,
          state.buffer.text,
          state.context.selected?.updatedAt ?? annotation.target.anchor.sourceVersion,
        );
        if (reanchored.state !== "anchored") {
          state.status = `Annotation anchor is ${reanchored.state}; exact range not selected`;
          break;
        }
        const start = detailBufferPointAtOffset(state.buffer.text, reanchored.anchor.start);
        const end = detailBufferPointAtOffset(state.buffer.text, reanchored.anchor.end);
        state.buffer.placeCursor(start.row, start.column);
        state.buffer.placeCursor(end.row, end.column, true);
        ensureEditorCursorVisible(viewport);
        state.status = `Revealed source range ${reanchored.anchor.start}-${reanchored.anchor.end}`;
        break;
      }
      case "comment.begin":
        await beginComment();
        break;
      case "buffer.insert":
        if (isBufferMode() && state.mode !== "select") {
          state.completion = null;
          state.buffer.insert(intent.text);
          state.status = "";
          ensureEditorCursorVisible(viewport);
        }
        break;
      case "buffer.newline":
        if (state.mode === "select") {
          state.status = "Source selection is read-only";
          break;
        }
        state.buffer.newline();
        state.status = "";
        ensureEditorCursorVisible(viewport);
        break;
      case "buffer.backspace":
        if (state.mode === "select") {
          state.status = "Source selection is read-only";
          break;
        }
        state.buffer.backspace();
        state.status = "";
        ensureEditorCursorVisible(viewport);
        break;
      case "buffer.delete":
        if (state.mode === "select") {
          state.status = "Source selection is read-only";
          break;
        }
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
      case "editor.viewport.scroll": {
        const layout = editorLayout(viewport);
        const visibleHeight = detailVisibleEditorHeight(state, viewport);
        const maxOffset = Math.max(0, layout.rows.length - visibleHeight);
        state.editorVisualOffset = Math.max(
          0,
          Math.min(maxOffset, state.editorVisualOffset + Math.trunc(intent.delta)),
        );
        state.editorViewportManual = true;
        break;
      }
      case "editor.viewport.anchor": {
        const layout = editorLayout(viewport);
        const visualRow = detailEditorVisualRowForSourceLine(layout, intent.sourceLine);
        if (visualRow !== null) {
          const maxOffset = Math.max(
            0,
            layout.rows.length - detailVisibleEditorHeight(state, viewport),
          );
          state.editorVisualOffset = Math.max(0, Math.min(maxOffset, visualRow));
          state.editorViewportManual = true;
        }
        break;
      }
      case "editor.cursor.place": {
        const layout = editorLayout(viewport);
        const position = detailEditorPositionAtVisualPoint(
          layout,
          state.buffer.lines,
          intent.visualRow,
          intent.contentColumn,
        );
        state.buffer.placeCursor(position.row, position.column, intent.extend);
        state.completion = null;
        ensureEditorCursorVisible(viewport);
        break;
      }
      case "draft-preview.link.toggle":
        if ((viewport.editorWidth ?? viewport.width) >= viewport.width) {
          state.draftPreviewLinked = false;
          state.status = "Linked scrolling requires the wide draft preview";
          break;
        }
        state.draftPreviewLinked = !state.draftPreviewLinked;
        state.status = state.draftPreviewLinked
          ? "Draft preview scrolling linked by source line"
          : "Draft preview scrolling independent";
        break;
      case "buffer.select-all":
        state.buffer.selectAll();
        ensureEditorCursorVisible(viewport);
        break;
      case "buffer.copy": {
        const selectedText = state.buffer.selectedText;
        if (selectedText === null) {
          state.status = "No text selected";
        } else {
          effects.copyText(selectedText);
          state.status = `Copied ${[...selectedText].length} characters`;
        }
        break;
      }
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
        state.draftPreviewLinked = false;
        state.editorViewportManual = false;
        if (isBufferMode()) ensureEditorCursorVisible(viewport);
        else if (state.mode === "file" && state.referencedFile) ensureFileCursorVisible(viewport);
        break;
      case "status.set":
        state.status = intent.message;
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
    setPreviewRegions(regions) {
      reconcilePreviewRegions(state.previewRegions, regions);
    },
    handleDestinationChooserKeypress(str, key) {
      return destinationChooser!.handleKeypress(str, key);
    },
    destinationChooserHelpText() {
      return destinationChooser!.helpText();
    },
    async onServiceEvent(event, viewport) {
      if (event.domain === "ui") {
        const command = event.command;
        if (!command || command.targetClientId !== effects.clientId) return;
        if (command.command === "backlinks.select") {
          if (
            command.targetBlockId === state.targetBlockId &&
            command.sourceBlockId
          ) {
            await loadBacklinks();
            const index = visibleBacklinkSources(state.backlinks)
              .findIndex((source) => source.blockId === command.sourceBlockId);
            if (index >= 0) {
              state.backlinks.selectedIndex = index;
              state.previewRegions.focusedRegionId = `backlink:${command.sourceBlockId}`;
            }
          }
          effects.focusSelf();
          emit();
          return;
        }
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
          } else if (command.command === "replace") {
            state.status = state.connectionMode === "locked"
              ? "Replaced here · remains locked · L unlocks this block"
              : "Replaced here · still unlocked · L locks this block";
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
