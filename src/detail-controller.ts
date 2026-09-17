import type { BacklinkPeekLaunch } from "./backlink-peek";
import {
  DEFAULT_OUTLINER_ACTION_KEYMAP,
  type OutlinerActionKeymap,
} from "./outliner-actions";
import {
  annotationSourceHash,
  createTextQuoteAnchor,
  extractAnnotationBody,
} from "./annotations";
import {
  attentionClientState,
  attentionSourceLine,
  emptyAttentionState,
} from "./attention";
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
import {
  firstOutlinerReference,
  outlinerLinkUri,
  type OutlinerLinkTarget,
  type ResolvedOutlinerLinkTarget,
} from "./outliner-links";
import { ALL_DETAILS_LOCKED_ERROR } from "./navigation-routes";
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
import { isVirtualBranchDefinition } from "./virtual-branches";
import { blockDisplayTitle } from "./references";
import {
  RESOURCE_CAPABILITIES,
  RESOURCE_CAPABILITY_FACTORS,
  resourceRevisionRefEquals,
  resourceAddressLabel,
} from "./resources";
import { TextBuffer } from "./text-buffer";
import type { TerminalKey } from "./terminal";
import type {
  AnnotationBatchReceipt,
  AnnotationCreateInput,
  AnnotationListQuery,
  AnnotationReconcileInput,
  AnnotationReconcileReceipt,
  AnnotationRepresentation,
  AnnotationSubject,
  AnnotationTarget,
  AnnotationThread,
  AttentionClientState,
  BacklinkCollection,
  BacklinkSource,
  BacklinkQuery,
  Block,
  Resource,
  BookmarkStatus,
  BookmarkToggleReceipt,
  BlockSearchQuery,
  BrowsingContextState,
  InternResourceReceipt,
  PageAddressCollection,
  OutlinerEvent,
  PropertyPatchOperation,
  RenderedPassageObservation,
  RenderedPassageProjection,
  RenderedSelectionCapture,
  SelectionContext,
  OutlinerNavigationDispatch,
  OutlinerNavigationResolution,
  OutlinerNavigationIntent,
  OutlinerNavigationTarget,
  OutlinerUiCommand,
  ResourceDescription,
  ResolvedBlockReferences,
  VisibleBlockCollection,
} from "./types";

interface DetailNavigationEntry {
  target: OutlinerNavigationTarget;
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
  initialTarget?: OutlinerNavigationTarget;
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
type DetailAnnotationTarget = AnnotationTarget;

export interface DetailAnnotationDraft {
  requestId: string;
  target: DetailAnnotationTarget;
  returnMode: "preview" | "file";
}

const EMPTY_SELECTION_CONTEXT: SelectionContext = {
  selected: null,
  ancestors: [],
  children: [],
};

export type DetailReadyDocument =
  | {
      kind: "block";
      target: Extract<OutlinerNavigationTarget, { kind: "block" }>;
      context: SelectionContext;
    }
  | {
      kind: "resource";
      target: Extract<OutlinerNavigationTarget, { kind: "resource" }>;
      description: ResourceDescription;
    };

export type DetailDocumentState =
  | { kind: "empty" }
  | { kind: "loading"; target: OutlinerNavigationTarget }
  | { kind: "ready"; document: DetailReadyDocument }
  | { kind: "failed"; target: OutlinerNavigationTarget; message: string };

function detailDocumentTarget(
  document: DetailDocumentState,
): OutlinerNavigationTarget | null {
  if (document.kind === "empty") return null;
  return document.kind === "ready" ? document.document.target : document.target;
}

function detailDocumentContext(document: DetailDocumentState): SelectionContext {
  return document.kind === "ready" && document.document.kind === "block"
    ? document.document.context
    : EMPTY_SELECTION_CONTEXT;
}

export function detailResourceDescription(
  state: Pick<DetailState, "document">,
): ResourceDescription | null {
  return state.document.kind === "ready" && state.document.document.kind === "resource"
    ? state.document.document.description
    : null;
}

export interface DetailState {
  document: DetailDocumentState;
  readonly context: SelectionContext;
  readonly target: OutlinerNavigationTarget | null;
  readonly resource: ResourceDescription["resource"] | null;
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
  attention: AttentionClientState;
  attentionRevealSourceLine: number | null;
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

export function detailBlockTarget(
  state: Pick<DetailState, "target">,
): Extract<OutlinerNavigationTarget, { kind: "block" }> | null {
  return state.target?.kind === "block" ? state.target : null;
}

export function detailResourceTarget(
  state: Pick<DetailState, "document">,
): ResourceDescription["resource"] | null {
  return detailResourceDescription(state)?.resource ?? null;
}

export interface DetailEffects {
  readonly clientId: string;
  readonly browsingContextId: string;
  focusSelf(): void;
  getBrowsingContext(): Promise<BrowsingContextState>;
  loadTarget(target: OutlinerNavigationTarget): Promise<DetailReadyDocument>;
  setLocked(locked: boolean): Promise<void>;
  setCurrentTarget(target: OutlinerNavigationTarget | null): Promise<void>;
  dispatchNavigation(
    target: OutlinerNavigationTarget,
    intent: OutlinerNavigationIntent,
    options?: { preserveSource?: boolean; focusTarget?: boolean },
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
    target: OutlinerNavigationTarget,
    direction: "right" | "down",
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
  internFilesystem(path: string): Promise<InternResourceReceipt>;
  refreshResource(resourceId: string): Promise<ResourceDescription>;
  openExternal(url: string): void | Promise<void>;
  getAnnotation(annotationId: string): Promise<AnnotationThread>;
  listAnnotations(query: AnnotationListQuery): Promise<AnnotationThread[]>;
  reconcileAnnotations(input: AnnotationReconcileInput): Promise<AnnotationReconcileReceipt>;
  getAttention(): Promise<AttentionClientState>;
  acknowledgeAttention(markId?: string): Promise<AttentionClientState>;
  restoreBlock(blockId: string): Promise<Block>;
  resolveReference(target: OutlinerLinkTarget): Promise<ResolvedOutlinerLinkTarget>;
  queryBlocks(query: BlockSearchQuery): Promise<VisibleBlockCollection>;
  queryPageAddresses(query: string | undefined, limit: number): Promise<PageAddressCollection>;
  readFile(block: Block): ReferencedFile;
  completeFiles(query: string): ReferencedPathCandidate[];
  focusOutliner(): Promise<void>;
  openPropertyInspectorPane(blockId: string): string | Promise<string>;
  openVirtualBranchNavigator(viewId: string, adapter?: "bookmark"): void | Promise<void>;
  bookmarkStatus(targetBlockId: string): Promise<BookmarkStatus>;
  toggleBookmark(targetBlockId: string, expectedRecordId: string | null): Promise<BookmarkToggleReceipt>;
  bookmarksRoot(): Promise<Block>;
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
  | { type: "annotation.selection.begin"; sourceLine?: number; sourceColumn?: number }
  | { type: "resource.refresh" }
  | { type: "resource.open-external" }
  | { type: "resource.open-url"; url: string }
  | { type: "annotation.selection.place"; row: number; column: number; extend?: boolean }
  | { type: "trash.restore" }
  | { type: "comment.begin"; sourceRange?: { start: number; end: number } }
  | { type: "navigation.back" }
  | { type: "navigation.forward" }
  | { type: "reference.follow" }
  | { type: "reference.open"; target: OutlinerLinkTarget; routing?: DetailOpenRouting }
  | { type: "reference.reveal" }
  | { type: "current.reveal" }
  | { type: "virtual-branch.open" }
  | { type: "bookmark.toggle" }
  | { type: "bookmarks.open" }
  | { type: "backlinks.move"; delta: -1 | 1 }
  | { type: "backlinks.open" }
  | { type: "backlinks.reveal" }
  | { type: "backlinks.toggle" }
  | { type: "backlinks.filter.begin" }
  | { type: "backlinks.filter.input"; text: string }
  | { type: "annotation.reveal" }
  | { type: "attention.acknowledge" }
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

function annotationOffsetsForLineRange(
  text: string,
  startLine: number,
  endLine: number,
): { start: number; end: number } {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  const start = starts[startLine - 1];
  if (start === undefined || endLine < startLine) {
    throw new Error("Annotation line range is outside the file");
  }
  const next = starts[endLine];
  let end = next === undefined ? text.length : next - 1;
  if (end > start && text.charCodeAt(end - 1) === 13) end -= 1;
  if (end <= start) throw new Error("Annotation line range must contain text");
  return { start, end };
}

function annotationLineRangeForOffsets(
  text: string,
  start: number,
  end: number,
): { startLine: number; endLine: number } {
  let startLine = 1;
  let endLine = 1;
  for (let index = 0; index < end; index += 1) {
    if (text.charCodeAt(index) !== 10) continue;
    if (index < start) startLine += 1;
    endLine += 1;
  }
  return { startLine, endLine };
}


function blockAnnotationRepresentation(block: Block): AnnotationRepresentation {
  const contentHash = annotationSourceHash(block.text);
  return {
    id: `block:${block.id}:${contentHash}`,
    subject: { kind: "block", blockId: block.id },
    sourceSnapshot: {
      kind: "block",
      blockId: block.id,
      updatedAt: block.updatedAt,
      contentHash,
    },
    adapter: { id: "outliner.block-text", version: 1 },
    mediaType: "text/markdown",
    contentHash,
    capturedAt: block.updatedAt,
  };
}

function resourceAnnotationRepresentation(
  description: ResourceDescription,
): AnnotationRepresentation | null {
  const filesystem = description.filesystem;
  if (filesystem) {
    const revision = filesystem.revision.revision;
    if (revision.kind !== "filesystem") {
      throw new Error("Filesystem Resource has a non-filesystem revision");
    }
    return {
      id: `filesystem:${description.resource.id}:${revision.mtimeNs}:${revision.size}:${filesystem.contentHash}`,
      subject: { kind: "resource", resourceId: description.resource.id },
      sourceSnapshot: {
        kind: "resource",
        resourceId: description.resource.id,
        sourceSnapshotId: null,
        revision: filesystem.revision,
      },
      adapter: { id: "filesystem.text", version: 1 },
      mediaType: description.resource.mediaType ?? "text/plain",
      contentHash: filesystem.contentHash,
      capturedAt: filesystem.capturedAt,
    };
  }
  const web = description.web;
  if (!web) return null;
  return {
    id: web.representation.id,
    subject: { kind: "resource", resourceId: description.resource.id },
    sourceSnapshot: {
      kind: "resource",
      resourceId: description.resource.id,
      sourceSnapshotId: web.sourceSnapshot.id,
      revision: web.sourceSnapshot.revision,
    },
    adapter: web.representation.adapter,
    mediaType: web.representation.mediaType,
    contentHash: web.representation.contentHash,
    capturedAt: web.representation.derivedAt ??
      web.sourceSnapshot.fetchedAt ??
      description.resource.updatedAt,
  };
}

function filesystemAnnotationRepresentation(
  resource: Resource,
  file: ReferencedFile,
): AnnotationRepresentation {
  if (resource.provider !== "filesystem") {
    throw new Error("Filesystem annotation requires a filesystem Resource");
  }
  const sourceText = file.sourceText ?? file.lines.join("\n");
  const contentHash = file.sourceHash ?? annotationSourceHash(sourceText);
  const revisionParts = file.sourceVersion?.split(":");
  const revision = revisionParts?.length === 2 &&
      revisionParts.every((part) => /^\d+$/.test(part))
    ? {
        resourceId: resource.id,
        addressVersion: resource.addressVersion,
        revision: {
          kind: "filesystem" as const,
          mtimeNs: revisionParts[0]!,
          size: revisionParts[1]!,
        },
      }
    : null;
  return {
    id: `filesystem:${resource.id}:${file.sourceVersion ?? contentHash}:${contentHash}`,
    subject: { kind: "resource", resourceId: resource.id },
    sourceSnapshot: {
      kind: "resource",
      resourceId: resource.id,
      sourceSnapshotId: null,
      revision,
    },
    adapter: { id: "filesystem.text", version: 1 },
    mediaType: resource.mediaType ?? "text/plain",
    contentHash,
    capturedAt: file.capturedAt ?? "1970-01-01T00:00:00.000Z",
  };
}

export function renderedSelectionAnnotationTarget(
  state: Pick<
    DetailState,
    "context" | "resolvedSelectedText" | "projectedSelectedText"
  >,
  capture: RenderedSelectionCapture,
): AnnotationTarget {
  const selected = state.context.selected;
  if (!selected) throw new Error("No block is open in this Detail");
  if (selected.id !== capture.hostBlockId) {
    throw new Error("The Detail target changed after the rendered selection was captured");
  }
  const projected = state.projectedSelectedText !== selected.text;
  const resolved = state.resolvedSelectedText !== state.projectedSelectedText;
  const projection: RenderedPassageProjection = projected && resolved
    ? "mixed"
    : projected
      ? "generated"
      : resolved
        ? "resolved"
        : "canonical";
  const { snapshotText, ...evidence } = capture;
  const observation: RenderedPassageObservation = { ...evidence, projection };
  const match = snapshotText.indexOf(capture.quote);
  const unique = match >= 0 && snapshotText.indexOf(capture.quote, match + 1) < 0;
  const contentHash = annotationSourceHash(snapshotText);
  return {
    representation: {
      id: `rendered:${capture.hostBlockId}:${capture.paneId}:${capture.contentRevision}:${contentHash}`,
      subject: { kind: "block", blockId: selected.id },
      sourceSnapshot: { kind: "rendered", observation },
      adapter: { id: "herdr.rendered-passage", version: 1 },
      mediaType: "text/plain",
      contentHash,
      capturedAt: capture.capturedAt,
      observation,
    },
    anchor: unique
      ? createTextQuoteAnchor(snapshotText, match, match + capture.quote.length)
      : {
          kind: "text-quote",
          start: null,
          end: null,
          exact: capture.quote,
          prefix: "",
          suffix: "",
        },
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
    document: options.initialTarget
      ? { kind: "loading", target: options.initialTarget }
      : { kind: "empty" },
    get context() {
      return detailDocumentContext(this.document);
    },
    get target() {
      return detailDocumentTarget(this.document);
    },
    get resource() {
      return detailResourceDescription(this)?.resource ?? null;
    },
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
    attention: emptyAttentionState(effects.clientId),
    attentionRevealSourceLine: null,
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
  let loadGeneration = 0;

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
    let fileSourceBlockId = block.id;
    try {
      const source = getProperty(block.properties, "type")?.startsWith("annotation")
        ? [...state.context.ancestors].reverse().find((candidate) =>
          getProperty(candidate.properties, "file")
        )
        : block;
      if (!source) {
        state.referencedFile = null;
        return;
      }
      state.referencedFile = effects.readFile(source);
      fileSourceBlockId = source.id;
      const file = state.referencedFile;
      if (file) {
        const marks = state.attention.marks.map((mark) => {
          if (
            mark.target.kind !== "file" ||
            mark.target.sourceBlockId !== fileSourceBlockId
          ) return mark;
          const matches =
            file.sourceVersion === mark.target.anchor.sourceVersion &&
            file.sourceHash === mark.target.anchor.sourceHash &&
            file.sourceText?.slice(mark.target.anchor.start, mark.target.anchor.end) ===
              mark.target.anchor.excerpt;
          return { ...mark, sourceState: matches ? "active" as const : "stale" as const };
        });
        state.attention = attentionClientState(
          effects.clientId,
          marks,
          state.attention.pendingCount,
        );
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

  const loadAnnotations = async (expectedGeneration?: number): Promise<void> => {
    const targetAtStart = state.target;
    let threads: AnnotationThread[] = [];
    try {
      if (targetAtStart?.kind === "resource") {
        const description = detailResourceDescription(state);
        if (!description) return;
        const subject: Extract<AnnotationSubject, { readonly kind: "resource" }> = {
          kind: "resource",
          resourceId: description.resource.id,
        };
        const representation = resourceAnnotationRepresentation(description);
        const content = description.web?.markdown ?? description.filesystem?.text ?? null;
        threads = representation && content !== null && targetAtStart.revision === undefined
          ? (await effects.reconcileAnnotations({
              subject,
              newRepresentation: representation,
              content,
            })).threads
          : await effects.listAnnotations({ subject, includeResolved: true });
      } else {
        const selected = state.context.selected;
        if (!selected) {
          state.annotationThreads = [];
          return;
        }
        if (getProperty(selected.properties, "type")?.startsWith("annotation")) {
          threads = [await effects.getAnnotation(selected.id)];
        } else if (state.referencedFile) {
          const receipt = await effects.internFilesystem(state.referencedFile.absolutePath);
          const subject: Extract<AnnotationSubject, { readonly kind: "resource" }> = {
            kind: "resource",
            resourceId: receipt.resource.id,
          };
          const representation = filesystemAnnotationRepresentation(
            receipt.resource,
            state.referencedFile,
          );
          const content = state.referencedFile.sourceText ?? state.referencedFile.lines.join("\n");
          threads = (await effects.reconcileAnnotations({
            subject,
            newRepresentation: representation,
            content,
          })).threads;
        } else {
          const representation = blockAnnotationRepresentation(selected);
          threads = (await effects.reconcileAnnotations({
            subject: { kind: "block", blockId: selected.id },
            newRepresentation: representation,
            content: selected.text,
          })).threads;
        }
      }
    } catch {
      threads = [];
    }
    if (
      (expectedGeneration !== undefined && expectedGeneration !== loadGeneration) ||
      !sameNavigationTarget(state.target, targetAtStart)
    ) {
      return;
    }
    state.annotationThreads = threads;
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
    const targetBlockId = detailBlockTarget(state)?.blockId;
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
      if (state.backlinks.expanded && detailBlockTarget(state)?.blockId === targetBlockId) {
        state.backlinks.collection = collection;
        clampBacklinkSelection();
      }
    } catch (error) {
      if (state.backlinks.expanded && detailBlockTarget(state)?.blockId === targetBlockId) {
        state.backlinks.error = errorMessage(error);
      }
    } finally {
      if (detailBlockTarget(state)?.blockId === targetBlockId) state.backlinks.loading = false;
    }
  };

  const syncNavigationState = (): void => {
    state.canNavigateBack = navigationIndex > 0;
    state.canNavigateForward = navigationIndex >= 0 && navigationIndex < navigationHistory.length - 1;
  };

  const sameNavigationTarget = (
    left: OutlinerNavigationTarget | null,
    right: OutlinerNavigationTarget | null,
  ): boolean => {
    if (!left || !right || left.kind !== right.kind) return left === right;
    if (left.kind === "block" && right.kind === "block") {
      return left.blockId === right.blockId && left.fragmentId === right.fragmentId;
    }
    if (left.kind !== "resource" || right.kind !== "resource") return false;
    if (left.resourceId !== right.resourceId) return false;
    if (!left.revision || !right.revision) return left.revision === right.revision;
    return resourceRevisionRefEquals(left.revision, right.revision);
  };

  const recordNavigation = (target: OutlinerNavigationTarget | null): void => {
    const current = navigationHistory[navigationIndex]?.target ?? null;
    if (!target || sameNavigationTarget(current, target)) {
      syncNavigationState();
      return;
    }
    navigationHistory.splice(navigationIndex + 1);
    navigationHistory.push({ target });
    if (navigationHistory.length > 200) navigationHistory.shift();
    navigationIndex = navigationHistory.length - 1;
    syncNavigationState();
  };

  const replaceSelectedBlock = (selected: Block): void => {
    if (state.document.kind !== "ready" || state.document.document.kind !== "block") {
      throw new Error("Block update completed without a loaded block document");
    }
    const document = state.document.document;
    state.document = {
      kind: "ready",
      document: {
        ...document,
        context: { ...document.context, selected },
      },
    };
  };

  const clearDocumentPresentation = (): void => {
    state.resolvedSelectedText = "";
    state.projectedSelectedText = "";
    state.embedStates = [];
    state.embedRanges = [];
    state.workIdPrefix = null;
    state.resolvedBreadcrumb = "";
    state.referencedFile = null;
    state.previewOffset = 0;
    state.annotationThreads = [];
    invalidateBacklinks();
    syncPropertyInspector(null, true);
  };

  const providerRevisionLabel = (
    revision: NonNullable<ResourceDescription["web"]>["sourceSnapshot"]["revision"],
  ): string => {
    const providerRevision = revision.revision;
    if (providerRevision.kind === "filesystem") {
      return `filesystem mtime ${providerRevision.mtimeNs}, ${providerRevision.size} bytes`;
    }
    if (providerRevision.kind === "web") {
      const validator = providerRevision.validator;
      if (validator.kind === "etag") {
        return `web ETag ${validator.weak ? "W/" : ""}${validator.value}`;
      }
      if (validator.kind === "last-modified") {
        return `web Last-Modified ${validator.value}`;
      }
      return `web content hash ${validator.value}`;
    }
    return `GitHub ${providerRevision.validator.kind} ${providerRevision.validator.value}`;
  };

  const freshnessGuidance = (
    freshness: NonNullable<ResourceDescription["webStatus"]>["freshness"],
    hasLocalContent: boolean,
  ): string => {
    switch (freshness) {
      case "fresh":
        return "The latest observed snapshot is within the local freshness window.";
      case "stale":
        return "The selected content is local and older than the freshness window. Press r to refresh explicitly.";
      case "unknown":
        return hasLocalContent
          ? "Provider freshness has not been checked. Press r to refresh explicitly."
          : "No local snapshot is available. Press r to refresh explicitly. Opening this resource only reads local storage and never contacts the provider.";
      case "refreshing":
        return hasLocalContent
          ? "Refresh is reconciling with the provider. The selected immutable content remains available until persistence succeeds."
          : "Refresh is reconciling with the provider. No local snapshot is available yet.";
      case "failed":
        return hasLocalContent
          ? "The last refresh failed. The selected immutable content remains available."
          : "The last refresh failed and no local snapshot is available. Press r to retry explicitly.";
      default: {
        const exhaustive: never = freshness;
        return exhaustive;
      }
    }
  };

  const resourceDocumentText = (description: ResourceDescription): string => {
    const { resource, source, web, webHistory, presentation } = description;
    const representation = presentation?.selected?.representation;
    const renderLocalContent = representation === undefined || representation === "cached-markdown";
    if (description.filesystem && renderLocalContent) return description.filesystem.text;
    const externalUrl = presentation?.selected?.externalUrl ??
      web?.sourceSnapshot.canonicalUrl ??
      (resource.address.kind === "web" ? resource.address.url : null);
    const lines = web && renderLocalContent
      ? [
          web.markdown,
          "",
          "---",
          "",
          "## Web resource",
          "",
          `[Stable resource link](${outlinerLinkUri("resource", resource.id)})`,
          ...(externalUrl ? ["", `[Open externally](<${externalUrl}>)`] : []),
        ]
      : [
          `# ${resourceAddressLabel(resource.address)}`,
          "",
          `[Stable resource link](${outlinerLinkUri("resource", resource.id)})`,
          ...(resource.provider === "web"
            ? ["", `[Open externally](<${resource.address.url}>)`]
            : []),
        ];
    if (presentation) {
      lines.push(
        "",
        "## Negotiated presentation",
        "",
        `- Resource kind: ${presentation.resourceKind}`,
        `- Surface: ${presentation.surface}`,
        `- Placement: ${presentation.selected?.placement ?? presentation.requestedPlacement}`,
        `- Representation: ${presentation.selected?.representation ?? "unavailable"}`,
        `- Renderer: ${presentation.selected?.renderer ?? "unavailable"}`,
      );
    }
    if (resource.provider === "web") {
      const freshness = description.webStatus?.freshness ?? "unknown";
      lines.push(
        "",
        "## Local status",
        "",
        `- Freshness: **${freshness}**`,
        `- Checked: ${description.webStatus?.checkedAt ?? "Never"}`,
        ...(description.webStatus?.lastError
          ? [`- Last refresh error: ${description.webStatus.lastError}`]
          : []),
        "",
        freshnessGuidance(freshness, web !== null),
      );
    }
    if (web) {
      lines.push(
        "",
        "## Selected immutable content",
        "",
        `- Source snapshot ID: \`${web.sourceSnapshot.id}\``,
        `- Source hash: ${web.sourceSnapshot.contentHash ? `\`${web.sourceSnapshot.contentHash}\`` : "Unknown"}`,
        `- Provider revision: ${providerRevisionLabel(web.sourceSnapshot.revision)}`,
        `- Fetched: ${web.sourceSnapshot.fetchedAt ?? "Unknown"}`,
        `- Source body available: ${web.sourceSnapshot.bodyAvailable ? "yes" : "no"}`,
        `- Representation ID: \`${web.representation.id}\``,
        `- Adapter: \`${web.representation.adapter.id}@${web.representation.adapter.version}\``,
        `- Representation hash: \`${web.representation.contentHash}\``,
        `- Derived: ${web.representation.derivedAt ?? "Unknown"}`,
        `- Representation content available: ${web.representation.contentAvailable ? "yes" : "no"}`,
      );
    } else {
      lines.push(
        "",
        "## Resource identity",
        "",
        `- Resource ID: \`${resource.id}\``,
        `- Source: ${source.name} (\`${source.id}\`)`,
        `- Provider: \`${resource.provider}\``,
        `- Address version: \`${resource.addressVersion}\``,
        `- Requested revision: ${
          description.requestedRevision
            ? `address version ${description.requestedRevision.addressVersion}`
            : "latest address"
        }`,
        ...(description.webError ? [`- Read error: ${description.webError}`] : []),
      );
    }
    if (webHistory) {
      lines.push(
        "",
        "## Retained history",
        "",
        `- Source snapshots: ${webHistory.sourceSnapshots.length}`,
        `- Representations: ${webHistory.representations.length}`,
      );
      for (const snapshot of webHistory.sourceSnapshots) {
        lines.push(
          `- Snapshot \`${snapshot.id}\` · address v${snapshot.addressVersion} · ${snapshot.canonicalUrl ?? "URL unknown"} · ${snapshot.contentHash ?? "hash unknown"} · fetched ${snapshot.fetchedAt ?? "unknown"} · body ${snapshot.bodyAvailable ? "available" : "unavailable"}`,
        );
      }
      for (const representation of webHistory.representations) {
        lines.push(
          `- Representation \`${representation.id}\` · snapshot \`${representation.sourceSnapshotId}\` · \`${representation.adapter.id}@${representation.adapter.version}\` · ${representation.contentHash} · derived ${representation.derivedAt ?? "unknown"} · content ${representation.contentAvailable ? "available" : "unavailable"}`,
        );
      }
    }
    lines.push("", "## Capabilities");
    for (const capability of RESOURCE_CAPABILITIES) {
      const decision = description.capabilities[capability];
      lines.push(`- ${capability}: ${decision.status}`);
      for (const factor of RESOURCE_CAPABILITY_FACTORS) {
        const assessment = decision.factors[factor];
        if (assessment.state === "blocked" || assessment.state === "unknown") {
          lines.push(`  - ${factor}: ${assessment.state} — ${assessment.detail}`);
        }
      }
    }
    return lines.join("\n");
  };

  const applyReadyDocument = async (
    document: DetailReadyDocument,
    generation: number,
    force: boolean,
    record: boolean,
    previousTarget: OutlinerNavigationTarget | null,
  ): Promise<void> => {
    const previousContext = state.context;
    const targetChanged = !sameNavigationTarget(previousTarget, document.target);
    const nextSelected = document.kind === "block" ? document.context.selected : null;
    const blockChanged = detailBlockTarget({ target: previousTarget })?.blockId !== nextSelected?.id;
    const changed = document.kind === "resource" || targetChanged ||
      nextSelected?.updatedAt !== previousContext.selected?.updatedAt;

    let projection: DetailReadProjection | null = null;
    let resolved: ResolvedBlockReferences | null = null;
    if (document.kind === "block" && nextSelected && (force || changed)) {
      projection = await effects.projectRead(nextSelected.text, nextSelected.id);
      resolved = await effects.resolveReferences(projection.text);
      if (generation !== loadGeneration) return;
    }

    if (record) recordNavigation(previousTarget);
    state.document = { kind: "ready", document };
    state.refreshPending = false;
    if (targetChanged) destinationChooser?.dispose();
    if (blockChanged) {
      state.previewRegions.disclosureOverrides.clear();
      state.attentionRevealSourceLine = null;
    }
    if (blockChanged || changed) invalidateBacklinks();
    if (serviceConnected) await effects.setCurrentTarget(document.target);
    if (generation !== loadGeneration) return;
    if (record) recordNavigation(document.target);
    else syncNavigationState();
    if (!force && !changed) return;
    if (changed) state.status = "";

    if (document.kind === "resource") {
      clearDocumentPresentation();
      state.resolvedSelectedText = resourceDocumentText(document.description);
      state.projectedSelectedText = state.resolvedSelectedText;
      state.resolvedBreadcrumb = resourceAddressLabel(document.description.resource.address);
      state.mode = "preview";
      await loadAnnotations(generation);
      return;
    }

    const next = document.context;
    syncPropertyInspector(next.selected, blockChanged);
    if (next.selected && projection && resolved) {
      state.projectedSelectedText = projection.text;
      state.embedStates = projection.embeds;
      state.embedRanges = projection.embedRanges;
      applyResolvedReferences(resolved);
    } else if (!next.selected) {
      clearDocumentPresentation();
    }
    refreshBreadcrumb();
    state.previewOffset = 0;
    const fragmentId = document.target.fragmentId;
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
    if (generation !== loadGeneration) return;
    await loadAnnotations(generation);
  };

  const loadNavigationTarget = async (
    target: OutlinerNavigationTarget,
    force = false,
    record = true,
  ): Promise<void> => {
    const generation = ++loadGeneration;
    const previousTarget = state.target;
    state.document = { kind: "loading", target };
    state.refreshPending = false;
    emit();
    try {
      const document = await effects.loadTarget(target);
      if (generation !== loadGeneration) return;
      if (!sameNavigationTarget(document.target, target)) {
        throw new Error("Detail loader returned a different navigation target");
      }
      await applyReadyDocument(document, generation, force, record, previousTarget);
    } catch (error) {
      if (generation !== loadGeneration) return;
      const message = errorMessage(error);
      clearDocumentPresentation();
      state.document = { kind: "failed", target, message };
      if (record) {
        recordNavigation(previousTarget);
        recordNavigation(target);
      } else syncNavigationState();
      await effects.setCurrentTarget(target);
      state.status = `Target is no longer available · ${message}`;
    }
  };

  const loadBrowsingContext = async (force = false): Promise<void> => {
    const generation = ++loadGeneration;
    const browsingContext = await effects.getBrowsingContext();
    if (generation !== loadGeneration) return;
    if (!browsingContext.target) {
      clearDocumentPresentation();
      state.document = { kind: "empty" };
      await effects.setCurrentTarget(null);
      return;
    }
    loadGeneration -= 1;
    await loadNavigationTarget(browsingContext.target, force, true);
  };

  const loadBlock = async (
    blockId: string,
    force = false,
    record = true,
    fragmentId: string | null = null,
  ): Promise<void> => {
    await loadNavigationTarget({
      kind: "block",
      blockId,
      ...(fragmentId ? { fragmentId } : {}),
    }, force, record);
  };

  const loadCurrentTarget = async (force = false): Promise<void> => {
    if (state.target) await loadNavigationTarget(state.target, force, false);
    else await loadBrowsingContext(force);
  };

  const applyNavigationCommand = async (command: OutlinerUiCommand): Promise<boolean> => {
    if (!("target" in command) || !command.target) return false;
    if (
      state.connectionMode === "locked" &&
      (command.command === "preview" || command.command === "open")
    ) {
      return false;
    }
    await loadNavigationTarget(command.target, true, command.command !== "preview");
    return true;
  };

  const resolveDestinationTarget = async (
    target: OpenDestinationTarget,
    reference: OutlinerLinkTarget,
  ): Promise<void> => {
    if (reference.kind === "resource") {
      target.target = { kind: "resource", resourceId: reference.value };
      target.title = reference.value;
      return;
    }
    const resolved = await effects.resolveReference(reference);
    target.target = {
      kind: "block",
      blockId: resolved.block.id,
      ...(resolved.fragmentId ? { fragmentId: resolved.fragmentId } : {}),
    };
    target.title = blockDisplayTitle(resolved.block);
  };

  const openFirstUnlocked = async (
    target: OpenDestinationTarget,
    preserveSource = false,
  ): Promise<boolean> => {
    try {
      const dispatched = await effects.dispatchNavigation(target.target, "open", {
        ...(preserveSource ? { preserveSource: true } : {}),
      });
      if (dispatched.targetClientId === effects.clientId) {
        await applyNavigationCommand(dispatched.command);
      }
      state.status = `Opened ${target.title} in first unlocked Detail`;
      return true;
    } catch (error) {
      if (errorMessage(error) === ALL_DETAILS_LOCKED_ERROR) {
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
        target: target.target,
      });
      const noun = target.target.kind === "resource" ? "resource" : "block";
      state.status = state.connectionMode === "locked"
        ? `Replaced here · remains locked · L unlocks this ${noun}`
        : `Replaced here · still unlocked · L locks this ${noun}`;
    },
    openFirstUnlocked: (target) =>
      openFirstUnlocked(
        target,
        destinationReferences.get(target)?.preserveSource === true,
      ),
    openNewDetail: async (target, direction) => {
      await effects.openDetailPane(target.target, direction);
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
      replaceSelectedBlock(updated);
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

  const beginAnnotationSelection = async (
    sourceLine = 0,
    sourceColumn = 0,
  ): Promise<void> => {
    const selected = state.context.selected;
    const web = detailResourceDescription(state)?.web;
    if (!web && (!selected || selected.effectiveDeletedRootId)) {
      state.status = selected
        ? "Block is in Trash; restore before adding annotations"
        : "This resource has no cached Markdown to annotate";
      return;
    }
    await setLocked(true);
    state.buffer = new TextBuffer(web?.markdown ?? selected!.text);
    state.buffer.placeCursor(sourceLine, sourceColumn);
    state.editorVisualOffset = 0;
    state.editorViewportManual = false;
    state.draftPreviewLinked = false;
    state.completion = null;
    state.annotationDraft = undefined;
    state.mode = "select";
    state.status = "Locked · extend the rendered selection, then press c";
  };

  const beginComment = async (
    sourceRange?: { start: number; end: number },
  ): Promise<void> => {
    const selected = state.context.selected;
    const description = detailResourceDescription(state);
    const web = description?.web;
    if (!web && (!selected || selected.effectiveDeletedRootId)) {
      state.status = selected
        ? "Block is in Trash; restore before adding annotations"
        : "This resource has no cached Markdown to annotate";
      return;
    }
    let target: DetailAnnotationTarget;
    let returnMode: "preview" | "file";
    if (state.mode === "select" || sourceRange) {
      const offsets = sourceRange ?? detailBufferRangeOffsets(state.buffer);
      if (!offsets) {
        state.status = "Select a non-empty source range before commenting";
        return;
      }
      if (web && description) {
        const representation = resourceAnnotationRepresentation(description);
        if (!representation) throw new Error("Cached web representation is unavailable");
        target = {
          representation,
          anchor: createTextQuoteAnchor(web.markdown, offsets.start, offsets.end),
        };
      } else {
        const source = selected!;
        target = {
          representation: blockAnnotationRepresentation(source),
          anchor: createTextQuoteAnchor(source.text, offsets.start, offsets.end),
        };
      }
      returnMode = "preview";
    } else {
      const range = selectedDetailFileRange(state);
      const file = state.referencedFile;
      if (!range || !file || !selected) return;
      const sourceText = file.sourceText ?? file.lines.join("\n");
      const offsetRange = annotationOffsetsForLineRange(
        sourceText,
        file.sourceText ? range.startLine : range.startLine - file.firstLine + 1,
        file.sourceText ? range.endLine : range.endLine - file.firstLine + 1,
      );
      const receipt = await effects.internFilesystem(file.absolutePath);
      target = {
        representation: filesystemAnnotationRepresentation(receipt.resource, file),
        anchor: createTextQuoteAnchor(sourceText, offsetRange.start, offsetRange.end),
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
    const anchor = target.anchor;
    const range = anchor.kind === "text-quote" && anchor.start !== null && anchor.end !== null
      ? `${anchor.start}-${anchor.end}`
      : "unpositioned quote";
    state.status = returnMode === "file" && state.annotationRange
      ? `Locked · commenting on ${state.referencedFile?.sourcePath}:${state.annotationRange.startLine}-${state.annotationRange.endLine}`
      : target.representation.subject.kind === "resource"
        ? `Locked · commenting on cached Markdown ${range}`
        : `Locked · commenting on source range ${range}`;
  };

  const beginRenderedComment = async (
    capture: RenderedSelectionCapture,
  ): Promise<void> => {
    const selected = state.context.selected;
    if (!selected || selected.effectiveDeletedRootId) {
      state.status = "Block is in Trash; restore before adding annotations";
      return;
    }
    if (capture.detailClientId !== effects.clientId) {
      state.status = "Rendered selection targeted a different Detail client";
      return;
    }
    if (capture.contextId !== effects.browsingContextId) {
      state.status = "Rendered selection targeted a different browsing context";
      return;
    }
    let target: AnnotationTarget;
    try {
      target = renderedSelectionAnnotationTarget(state, capture);
    } catch (error) {
      state.status = errorMessage(error);
      return;
    }
    await setLocked(true);
    state.annotationDraft = {
      requestId: crypto.randomUUID(),
      target,
      returnMode: "preview",
    };
    state.buffer = new TextBuffer();
    state.editorVisualOffset = 0;
    state.draftPreviewLinked = false;
    state.completion = null;
    state.mode = "comment";
    const anchor = target.anchor;
    state.status = anchor.kind === "text-quote" && anchor.start !== null && anchor.end !== null
      ? `Locked · commenting on rendered quote ${anchor.start}-${anchor.end}`
      : "Locked · commenting on the captured rendered passage";
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
    if (state.busy) return;
    state.busy = true;
    try {
      if (state.mode === "edit") {
        const selected = state.context.selected;
        if (!selected) throw new Error("Only blocks can be edited");
        const updated = await effects.updateBlock({
          blockId: selected.id,
          text: state.buffer.text,
          expectedUpdatedAt: selected.updatedAt,
        });
        replaceSelectedBlock(updated);
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
        await loadAnnotations();
        const anchor = draft.target.anchor;
        const range = anchor.kind === "text-quote" &&
            anchor.start !== null &&
            anchor.end !== null
          ? `${anchor.start}-${anchor.end}`
          : "unpositioned quote";
        state.status = draft.returnMode === "file" && state.annotationRange
          ? `Annotation added for lines ${state.annotationRange.startLine}-${state.annotationRange.endLine}`
          : draft.target.representation.sourceSnapshot.kind === "rendered"
            ? "Annotation added for captured rendered passage"
            : draft.target.representation.subject.kind === "resource"
              ? `Annotation added for cached Markdown ${range}`
              : `Annotation added for source range ${range}`;
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
        await beginAnnotationSelection(intent.sourceLine, intent.sourceColumn);
        break;
      case "resource.refresh": {
        const description = detailResourceDescription(state);
        if (!description || description.resource.provider !== "web") {
          state.status = "Current target is not a web resource";
          break;
        }
        state.busy = true;
        try {
          const refreshed = await effects.refreshResource(description.resource.id);
          await loadCurrentTarget(true);
          const freshness = refreshed.webStatus?.freshness ?? "unknown";
          switch (freshness) {
            case "fresh":
              state.status = "Web resource refreshed";
              break;
            case "stale":
              state.status = "Refresh completed · selected local content remains stale";
              break;
            case "unknown":
              state.status = "Refresh completed · provider freshness remains unknown";
              break;
            case "refreshing":
              state.status = "Web resource refresh is still in progress";
              break;
            case "failed":
              state.status = refreshed.web
                ? `Refresh failed · showing selected immutable content · ${refreshed.webStatus?.lastError ?? "Unknown error"}`
                : `Refresh failed · no local snapshot · ${refreshed.webStatus?.lastError ?? "Unknown error"}`;
              break;
            default: {
              const exhaustive: never = freshness;
              state.status = exhaustive;
            }
          }
        } catch (error) {
          state.status = errorMessage(error);
        } finally {
          state.busy = false;
        }
        break;
      }
      case "resource.open-external":
      case "resource.open-url": {
        const description = detailResourceDescription(state);
        if (!description || description.resource.provider !== "web") {
          state.status = "Current target has no external web URL";
          break;
        }
        if (description.source.policy.deniedCapabilities.includes("open-external")) {
          state.status = "Workspace policy denies opening this resource externally";
          break;
        }
        const url = intent.type === "resource.open-url"
          ? intent.url
          : description.web?.sourceSnapshot.canonicalUrl ?? description.resource.address.url;
        await effects.openExternal(url);
        state.status = "Opened URL externally";
        break;
      }
      case "annotation.selection.place":
        if (state.mode === "select") {
          state.buffer.placeCursor(intent.row, intent.column, intent.extend);
        }
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
        await loadNavigationTarget(target.target, true, false);
        state.status = direction < 0 ? "Navigation back" : "Navigation forward";
        break;
      }
      case "current.reveal": {
        const current = state.context.selected;
        if (!current) {
          state.status = "No block selected";
          break;
        }
        await effects.dispatchNavigation(
          { kind: "block", blockId: current.id },
          "reveal",
          { focusTarget: true },
        );
        state.status = `Revealed ${blockDisplayTitle(current)}`;
        break;
      }
      case "virtual-branch.open": {
        const current = state.context.selected;
        if (!current) {
          state.status = "No block selected";
          break;
        }
        if (!isVirtualBranchDefinition(current)) {
          state.status = "Current block is not a virtual branch";
          break;
        }
        await effects.openVirtualBranchNavigator(current.id);
        state.status = `Opened virtual navigator for ${blockDisplayTitle(current)}`;
        break;
      }
      case "bookmark.toggle": {
        const current = state.context.selected;
        if (!current) {
          state.status = "No block selected";
          break;
        }
        if (current.deletedAt || current.effectiveDeletedRootId) {
          state.status = "Block is in Trash; restore before bookmarking";
          break;
        }
        try {
          const bookmark = await effects.bookmarkStatus(current.id);
          const receipt = await effects.toggleBookmark(current.id, bookmark.record?.id ?? null);
          state.status = receipt.bookmarked ? "Bookmarked" : "Bookmark removed";
        } catch (error) {
          state.status = errorMessage(error);
        }
        break;
      }
      case "bookmarks.open": {
        const root = await effects.bookmarksRoot();
        await effects.openVirtualBranchNavigator(root.id, "bookmark");
        state.status = "Opened Bookmarks";
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
            target: reference.kind === "resource"
              ? { kind: "resource", resourceId: reference.value }
              : {
                  kind: "block",
                  blockId: reference.value,
                  ...(fragmentId ? { fragmentId } : {}),
                },
            title: reference.value,
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
        if (reference.kind === "resource") {
          await effects.dispatchNavigation(
            { kind: "resource", resourceId: reference.value },
            "reveal",
            { focusTarget: true },
          );
          break;
        }
        if (reference.kind === "page") {
          await effects.resolveNavigation("reveal");
        }
        const resolved = await effects.resolveReference(reference);
        await effects.dispatchNavigation({
          kind: "block",
          blockId: resolved.block.id,
          ...(resolved.fragmentId ? { fragmentId: resolved.fragmentId } : {}),
        }, "reveal", { focusTarget: true });
        state.status = `Revealed ${blockDisplayTitle(resolved.block)}`;
        break;
      }
      case "pane.open": {
        const target = state.target;
        if (!target) {
          state.status = "No target selected";
          break;
        }
        await effects.openDetailPane(target, intent.direction);
        const title = state.resource
          ? resourceAddressLabel(state.resource.address)
          : (state.context.selected ? blockDisplayTitle(state.context.selected) : "target");
        state.status = intent.direction === "right"
          ? `Opened ${title} to the right`
          : `Opened ${title} below`;
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
          case "annotation.disclosure.toggle":
            state.previewRegions.focusedRegionId = intent.action.regionId;
            togglePreviewRegionDisclosure(state.previewRegions, intent.action.regionId);
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
        const targetBlockId = detailBlockTarget(state)?.blockId;
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
        await effects.dispatchNavigation(
          { kind: "block", blockId: source.blockId },
          "reveal",
          { focusTarget: true },
        );
        state.status = `Revealed ${source.title}`;
        break;
      }
      case "annotation.reveal": {
        const selected = state.context.selected;
        if (!selected) break;
        const annotationId = selected.id;
        let annotation: AnnotationThread;
        try {
          annotation = await effects.getAnnotation(annotationId);
        } catch (error) {
          state.status = errorMessage(error);
          break;
        }
        let target = annotation.resolvedTarget;
        if (annotation.currentResolution.status !== "resolved" || !target) {
          state.status = `Annotation resolution is ${annotation.currentResolution.status}; no target can be revealed`;
          break;
        }
        const subject = target.representation.subject;
        let openFile = state.referencedFile;
        if (subject.kind === "block") {
          await loadBlock(subject.blockId, true);
        } else if (subject.kind === "resource" && openFile) {
          const receipt = await effects.internFilesystem(openFile.absolutePath);
          if (receipt.resource.id === subject.resourceId) {
            await effects.reconcileAnnotations({
              subject,
              newRepresentation: filesystemAnnotationRepresentation(
                receipt.resource,
                openFile,
              ),
              content: openFile.sourceText ?? openFile.lines.join("\n"),
            });
          } else {
            await loadNavigationTarget({ kind: "resource", resourceId: subject.resourceId }, true);
            openFile = null;
          }
        } else if (subject.kind === "resource") {
          await loadNavigationTarget({ kind: "resource", resourceId: subject.resourceId }, true);
        } else {
          state.status = "Legacy file annotation is orphaned and cannot be revealed";
          break;
        }
        annotation = await effects.getAnnotation(annotationId);
        target = annotation.resolvedTarget;
        if (
          annotation.currentResolution.status !== "resolved" ||
          !target ||
          target.anchor.kind !== "text-quote"
        ) {
          state.status = `Annotation resolution is ${annotation.currentResolution.status}; no positioned text quote can be revealed`;
          break;
        }
        const anchor = target.anchor;
        if (anchor.start === null || anchor.end === null) {
          state.status = `Annotation resolution is ${annotation.currentResolution.status}; no positioned text quote can be revealed`;
          break;
        }
        if (target.representation.subject.kind === "block") {
          if (target.representation.sourceSnapshot.kind === "rendered") {
            state.mode = "preview";
            state.previewOffset = state.resolvedSelectedText
              .slice(0, anchor.start)
              .split(/\r?\n/)
              .length - 1;
          } else {
            await beginAnnotationSelection();
            if (state.buffer.text.slice(anchor.start, anchor.end) !== anchor.exact) {
              state.status = "Resolved text quote no longer matches the loaded block";
              break;
            }
            const start = detailBufferPointAtOffset(state.buffer.text, anchor.start);
            const end = detailBufferPointAtOffset(state.buffer.text, anchor.end);
            state.buffer.placeCursor(start.row, start.column);
            state.buffer.placeCursor(end.row, end.column, true);
            ensureEditorCursorVisible(viewport);
          }
        } else if (openFile && target.representation.subject.kind === "resource") {
          const sourceText = openFile.sourceText ?? openFile.lines.join("\n");
          if (sourceText.slice(anchor.start, anchor.end) !== anchor.exact) {
            state.status = "Resolved text quote no longer matches the loaded file";
            break;
          }
          const lineRange = annotationLineRangeForOffsets(sourceText, anchor.start, anchor.end);
          state.mode = "file";
          state.referencedFile = openFile;
          state.selectionAnchor = Math.max(0, lineRange.startLine - openFile.firstLine);
          state.fileCursor = Math.min(
            openFile.lines.length - 1,
            Math.max(0, lineRange.endLine - openFile.firstLine),
          );
          ensureFileCursorVisible(viewport);
        } else {
          const description = detailResourceDescription(state);
          const resourceText = description?.web?.markdown ?? description?.filesystem?.text;
          if (!resourceText || resourceText.slice(anchor.start, anchor.end) !== anchor.exact) {
            state.status = "Resolved text quote is unavailable in the loaded Resource";
            break;
          }
          state.previewOffset = resourceText.slice(0, anchor.start).split(/\r?\n/).length - 1;
        }
        state.status = `Revealed resolved text quote ${anchor.start}-${anchor.end}`;
        break;
      }
      case "attention.acknowledge":
        state.attention = await effects.acknowledgeAttention();
        state.status = "Attention cue acknowledged; active marks remain";
        break;
      case "comment.begin":
        await beginComment(intent.sourceRange);
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
      return options.initialTarget
        ? loadNavigationTarget(options.initialTarget, true, true)
        : loadBrowsingContext(true);
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
      if (event.domain === "attention") {
        if (!event.attention || event.attention.targetClientId !== effects.clientId) return;
        state.attention = event.attention;
        const instruction = event.attentionInstruction;
        const mark = instruction
          ? state.attention.marks.find((candidate) => candidate.markId === instruction.markId)
          : undefined;
        if (mark && instruction?.reveal) {
          await loadBlock(
            mark.target.sourceBlockId,
            true,
            true,
            mark.target.kind === "block" ? mark.target.fragmentId ?? null : null,
          );
          if (mark.sourceState === "stale") {
            state.status = "Attention source changed; exact mark is stale";
          } else if (mark.target.kind === "file") {
            if (state.referencedFile) {
              state.mode = "file";
              state.fileCursor = Math.min(
                state.referencedFile.lines.length - 1,
                Math.max(0, mark.target.startLine - state.referencedFile.firstLine),
              );
              ensureFileCursorVisible(viewport);
              state.status = `Attention · ${mark.target.filePath}:${mark.target.startLine}-${mark.target.endLine}`;
            } else {
              state.status = `Attention file unavailable · ${mark.target.filePath}`;
            }
          } else {
            const selected = state.context.selected;
            state.mode = "preview";
            state.attentionRevealSourceLine = selected
              ? attentionSourceLine(selected.text, mark)
              : 0;
            state.previewOffset = state.attentionRevealSourceLine;
            state.status = mark.target.anchor
              ? `Attention · source range ${mark.target.anchor.start}-${mark.target.anchor.end}`
              : `Attention · ${mark.target.sourceBlockId.slice(0, 8)}`;
          }
        }
        if (instruction?.focus) effects.focusSelf();
        emit();
        return;
      }
      if (event.domain === "ui") {
        const command = event.command;
        if (!command || command.targetClientId !== effects.clientId) return;
        if (command.command === "comment.selection") {
          if (!command.renderedSelection) {
            state.status = "Rendered selection payload is missing";
          } else if (isBufferMode()) {
            state.status = "Finish or cancel the current editor before commenting";
          } else {
            await beginRenderedComment(command.renderedSelection);
          }
          effects.focusSelf();
          emit();
          return;
        }
        if (command.command === "backlinks.select") {
          if (
            command.targetBlockId === detailBlockTarget(state)?.blockId &&
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
          if ("target" in command && command.target) pendingUiCommand = command;
          state.refreshPending = true;
          return;
        }
        if ("target" in command && command.target) {
          await applyNavigationCommand(command);
          if (state.document.kind !== "failed") {
            if (command.command === "preview") {
              state.status = command.target.kind === "resource"
                ? "Previewing resource · L locks this resource"
                : "Previewing Tree selection · L locks this block";
            } else if (command.command === "open") {
              state.status = command.target.kind === "block" && command.target.fragmentId
                ? `Opened fragment · ^${command.target.fragmentId} · line ${state.previewOffset + 1} · still unlocked`
                : command.target.kind === "resource"
                  ? "Opened resource here · still unlocked · L locks this resource"
                  : "Opened here · still unlocked · L locks this block";
            } else if (command.command === "replace") {
              const noun = command.target.kind === "resource" ? "resource" : "block";
              state.status = state.connectionMode === "locked"
                ? `Replaced here · remains locked · L unlocks this ${noun}`
                : `Replaced here · still unlocked · L locks this ${noun}`;
            }
          }
        }
        if (command.command === "edit") await beginEdit(viewport);
        if (command.command !== "preview") effects.focusSelf();
        emit();
        return;
      }
      if (event.domain === "resource-catalog") {
        const description = detailResourceDescription(state);
        const matchesTarget = state.target?.kind === "resource" &&
          event.resourceId === state.target.resourceId;
        const matchesDescription = description !== null &&
          (event.resourceId === description.resource.id ||
            event.sourceId === description.source.id);
        if (!matchesTarget && !matchesDescription) return;
      } else if (event.domain === "content") {
        invalidateBacklinks();
      }
      if (event.domain === "selection" || event.domain === "browsing-context") return;
      if (isBufferMode()) {
        state.refreshPending = true;
        return;
      }
      await loadCurrentTarget(true);
      await loadBacklinks();
      emit();
    },
    async onServiceConnect() {
      serviceConnected = true;
      await effects.setLocked(state.connectionMode === "locked");
      await effects.setCurrentTarget(state.target);
      state.attention = await effects.getAttention();
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
