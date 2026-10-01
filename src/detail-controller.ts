import type { FragmentCandidateCollection, FragmentCandidateQuery } from "./fragment-search";
import {captureAnnotationPassage,renderedDocumentAnnotationTarget} from './document-annotation';
import type {DocumentSelection} from './document-frame';
import { blockCommentTarget } from "./block-comments";
import {blockAnnotationRepresentation, resourceAnnotationRepresentation} from "./annotation-representations";
import {removedListItemIds} from "./checklist-items";
import {checklistFoldState, restoreChecklistFold, checklistControlId, checklistCommentRange, findChecklistControl, type ChecklistControl} from "./checklist-controls";
import {ChecklistSession, type ChecklistChoice, type ChecklistResult} from "./checklist-session";
import type {ChecklistUpdateInput, ChecklistUpdateReceipt} from "./types";
import type {ChecklistIdentityChange, MutationProvenance} from "./types";
import { COMPLETION_ROWS } from "./reference-completion-renderer";
import { ReferenceCompletionSession, type ReferenceCompletionItem, type ReferenceCompletionState } from "./reference-completion";
import { buildDetailAnnotationView, displayedResourceText, detailAnnotationGroups, annotationReferenceTokens, resolveAnnotationReferences, sameAnnotationReferences, selectedAnnotationThread } from "./detail-annotations";
import type { BacklinkPeekLaunch } from "./backlink-peek";
import type { EditRecovery, EditRecoveryStart } from "./edit-recovery";
import { EditRecoveryRetainedLocallyError, type EditRecoveryClient } from "./edit-recovery-client";
import type { RecoveryChoice } from "./edit-recovery-review";
import {
  DEFAULT_OUTLINER_ACTION_KEYMAP,
  type OutlinerActionKeymap,
} from "./outliner-actions";
import {
  annotationSourceHash,
  annotationReferenceContextsEqual,
  createAnnotationReferenceContext,
  createPdfPageRegionAnchor,
  createTextQuoteAnchor,
} from "./annotations";
import {
  attentionClientState,
  attentionSourceLine,
  emptyAttentionState,
} from "./attention";
import {
  backlinkGroupRows,
  BACKLINK_QUERY_LIMIT,
  backlinkView,
  DEFAULT_BACKLINK_VIEW_OPTIONS,
  nextBacklinkKindFilter,
  nextBacklinkSort,
  nextBacklinkStageFilter,
  type BacklinkSortDirection,
  type BacklinkSortField,
  type BacklinkStageFilter,
  type BacklinkView,
  type BacklinkViewOptions,
} from "./backlink-view";
import {
  detailEditorPositionAtVisualPoint,
  detailEditorVisualRowForSourceLine,
  layoutDetailEditor,
} from "./detail-editor-layout";
import type { DetailEmbedRange, DetailEmbedState, DetailReadProjection } from "./detail-embeds";
import type { ResourceProjection } from "./resource-projection";
import {concatDocuments, generatedDocument, documentProvenanceKey, observeDocument, sourceDocument, type MappedDocument} from './document-provenance';
import {resourceContentDocument} from './document-resources';
import {resolvedDocument} from './document-references';
import {
  resolveFragment,
} from "./fragments";
import type { ReferencedFile, ReferencedPathCandidate } from "./files";
import {
  firstOutlinerReference,
  parseOutlinerLinkUri,
  outlinerLinkUri,
  resourceOccurrenceLink,
  type OutlinerLinkTarget,
  type ResolvedOutlinerLinkTarget,
  type FollowResourceOccurrenceReceipt,
} from "./outliner-links";
import {
  createOpenDestinationChooserState,
  OpenDestinationChooser,
  missingNavigationDestination,
  type OpenDestinationChooserState,
  type OpenDestinationScheduler,
  type OpenDestinationTarget,
} from "./open-destination-chooser";
import { getProperty } from "./properties";
import {
  createPropertyInspectorModel,
  findPropertyInspectorEntry,
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
  type BacklinkControl,
  type PreviewRegion,
  type PreviewRegionAction,
  type PreviewRegionState,
} from "./detail-preview-regions";
import { isTextualMediaType } from "./resource-presentation";
import { isVirtualBranchDefinition } from "./virtual-branches";
import { blockDisplayTitle } from "./references";
import { authoredResourceReferenceOccurrences, isAuthoredFileOccurrence } from "./resource-references";
import {
  RESOURCE_CAPABILITIES,
  RESOURCE_CAPABILITY_FACTORS,
  resourceRevisionRefEquals,
  resourceAddressLabel,
  resourceDescriptionLabel,
} from "./resources";
import { TextBuffer, type TextBufferRange } from "./text-buffer";
import { sanitizeDynamicText, type TerminalKey } from "./terminal";
import type {
  AnnotationBatchReceipt,
  AnnotationReplyInput,
  AnnotationLifecycleInput,
  AnnotationRecord,
  AnnotationAnchor,
  AnnotationCreateInput,
  AnnotationListQuery,
  AnnotationReconcileInput,
  AnnotationReconcileReceipt,
  AnnotationRepresentation,
  AnnotationReferenceContext,
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
  OutlinerViewAddress,
  OutlinerNavigationResolution,
  OutlinerNavigationIntent,
  OutlinerNavigationTarget,
  OutlinerUiCommand,
  ResourceDescription,
  ResourceRevisionRef,
  ResolvedBlockReferences,
  VisibleBlockCollection,
} from "./types";

interface DetailNavigationEntry {
  target: OutlinerNavigationTarget;
}

export type DetailMode = "preview" | "file" | "annotation" | "edit" | "select" | "comment";

export interface DetailViewport {
  width: number;
  editorWidth?: number;
  previewBodyHeight?: number;
  height: number;
  editorBody?: Readonly<{ contentWidth: number; height: number }>;
  preview?: Readonly<{
    rendered?: boolean;
    regions?: readonly PreviewRegion[];
    regionRows?: ReadonlyMap<string, number>;
    regionColumns?: ReadonlyMap<string, {column: number; width: number}>;
    sourceLineRow?: (line: number) => number;
    sourceLines: readonly string[];
    annotationLines: readonly string[];
    threadRows: ReadonlyMap<string, number>;
  }>;
}

export type DetailCompletionItem = ReferenceCompletionItem;
export type DetailCompletionState = ReferenceCompletionState;

export interface DetailLineRange {
  startLine: number;
  endLine: number;
}

export interface DetailBacklinkState {
  expanded: boolean;
  loading: boolean;
  collection: BacklinkCollection | null;

  selectedIndex: number;
  error: string;
  filter: string;
  filterDraft: string | null;
  sortField: BacklinkSortField;
  sortDirection: BacklinkSortDirection;
  showRelated: boolean;
  showResolved: boolean;
  kindFilter: string | null;
  stageFilter: BacklinkStageFilter;
  /** Kind groups the reader opened; groups start collapsed. */
  expandedKinds: Set<string>;
  expandedSourceIds: Set<string>;
}

/** Who Detail says made a change: the person, through Detail. */
export const DETAIL_MUTATION: Readonly<MutationProvenance> = { author: "user", actorId: "detail" };

/** The `trash.restore` request behind `DetailEffects.restoreBlock`, attributed to the person (PIE-451). */
export function detailRestoreRequest(blockId: string): { action: "trash.restore"; blockId: string; mutation: MutationProvenance } {
  return { action: "trash.restore", blockId, mutation: { ...DETAIL_MUTATION } };
}

export function createDetailBacklinkState(): DetailBacklinkState {
  return {
    expanded: false,
    loading: false,
    collection: null,
    selectedIndex: 0,
    error: "",
    filter: DEFAULT_BACKLINK_VIEW_OPTIONS.filter,
    filterDraft: null,
    sortField: DEFAULT_BACKLINK_VIEW_OPTIONS.sortField,
    sortDirection: DEFAULT_BACKLINK_VIEW_OPTIONS.sortDirection,
    showRelated: DEFAULT_BACKLINK_VIEW_OPTIONS.showRelated,
    showResolved: DEFAULT_BACKLINK_VIEW_OPTIONS.showResolved,
    kindFilter: DEFAULT_BACKLINK_VIEW_OPTIONS.kind,
    stageFilter: DEFAULT_BACKLINK_VIEW_OPTIONS.stage,
    expandedKinds: new Set(),
    expandedSourceIds: new Set(),
  };
}
export type DetailPropertyInspectorPresentation = "inline" | "dedicated";

export interface DetailPropertyValueEdit {
  occurrenceId: string;
  ordinal: number;
  blockId: string;
  expectedRevision: number;
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
  openHere?(target: OutlinerNavigationTarget): Promise<boolean>;
  previewHere?(target: OutlinerNavigationTarget): Promise<void>;
  propertyInspectorPresentation?: DetailPropertyInspectorPresentation;
  destinationTimeoutMs?: number;
  readerLabel?: string;
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
  if (target.kind === "link") {
    const parsed = parseOutlinerLinkUri(target.uri);
    return {...parsed, ...options, preserveSource: parsed.preserveSource === true || options.preserveSource === true};
  }
  if (target.kind === "resource-reference") {
    throw new Error("Resource property navigation requires its source occurrence");
  }
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



export function backlinkGroupRegionId(kind: string): string {
  return `backlink-group:${kind}`;
}

const BACKLINK_CONTROL_INTENTS = {
  kind: "backlinks.kind.cycle",
  stage: "backlinks.stage.cycle",
  resolved: "backlinks.resolved.toggle",
  related: "backlinks.related.toggle",
  sort: "backlinks.sort.cycle",
} as const satisfies Record<BacklinkControl, DetailIntent["type"]>;

export function detailBacklinkViewOptions(
  backlinks: Readonly<DetailBacklinkState>,
): BacklinkViewOptions {
  return {
    filter: backlinks.filter,
    sortField: backlinks.sortField,
    sortDirection: backlinks.sortDirection,
    showRelated: backlinks.showRelated,
    showResolved: backlinks.showResolved,
    kind: backlinks.kindFilter,
    stage: backlinks.stageFilter,
  };
}

export function detailBacklinkView(backlinks: Readonly<DetailBacklinkState>): BacklinkView {
  return backlinkView(backlinks.collection, detailBacklinkViewOptions(backlinks));
}

/** A narrowing filter opens every group so matches are never folded away. */
function backlinkNarrowingActive(backlinks: Readonly<DetailBacklinkState>): boolean {
  return backlinks.filter !== "" || backlinks.kindFilter !== null || backlinks.stageFilter !== "all";
}

export function detailBacklinkGroupExpanded(
  backlinks: Readonly<DetailBacklinkState>,
  kind: string,
): boolean {
  return backlinks.expandedKinds.has(kind) || backlinkNarrowingActive(backlinks);
}

/** Backlink rows as rendered, in order; selection and focus index this list. */
export function visibleBacklinkSources(
  backlinks: Readonly<DetailBacklinkState>,
): BacklinkSource[] {
  const view = detailBacklinkView(backlinks);
  if (!view.faceted) return view.matching;
  return view.groups.flatMap((group) =>
    backlinkGroupRows(group, detailBacklinkGroupExpanded(backlinks, group.kind))
  );
}
type DetailAnnotationTarget = AnnotationTarget;

export interface DetailAnnotationReplyDraft {
  requestId: string;
  annotationId: string;
  returnMode: "preview" | "file" | "annotation";
}

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

type DetailBlockReadyDocument = Extract<DetailReadyDocument, { kind: "block" }>;

interface DetailBlockCacheEntry {
  document: DetailBlockReadyDocument;
  projection: DetailReadProjection | null;
  resolved: ResolvedBlockReferences | null;
  stale: boolean;
}

interface DetailBlockRead {
  projection: DetailReadProjection;
  resolved: ResolvedBlockReferences;
}

/** One Detail process retains at most 32 block targets, including fragment variants. */
export const DETAIL_BLOCK_CACHE_TARGET_LIMIT = 32;

function blockCacheKey(target: DetailBlockReadyDocument["target"]): string {
  return `${target.blockId}\u0000${target.fragmentId ?? ""}`;
}

function sameBlockRevision(left: Block | null, right: Block | null): boolean {
  if (!left || !right) return left === right;
  return left.id === right.id &&
    left.revision === right.revision &&
    left.updatedAt === right.updatedAt &&
    left.parentId === right.parentId &&
    left.position === right.position &&
    left.deletedAt === right.deletedAt &&
    left.effectiveDeletedRootId === right.effectiveDeletedRootId;
}

function sameBlockListRevision(
  left: readonly Block[],
  right: readonly Block[],
): boolean {
  return left.length === right.length &&
    left.every((block, index) => sameBlockRevision(block, right[index] ?? null));
}

function sameBlockDocumentRevision(
  left: DetailBlockReadyDocument,
  right: DetailBlockReadyDocument,
): boolean {
  return sameBlockRevision(left.context.selected, right.context.selected) &&
    sameBlockListRevision(left.context.ancestors, right.context.ancestors) &&
    sameBlockListRevision(left.context.children, right.context.children);
}

function sameDisplayedBlockRead(
  state: Readonly<DetailState>,
  current: DetailBlockRead,
): boolean {
  if (
    state.projectedSelectedText !== current.projection.text ||
    state.resolvedSelectedText !== current.resolved.text ||
    state.resolvedProvenance === null ||
    documentProvenanceKey(state.resolvedProvenance) !== documentProvenanceKey(resolvedDocument(current.projection.provenance,current.resolved)) ||
    state.workIdPrefix !== (current.resolved.workIdPrefix ?? null) ||
    state.embedRanges.length !== current.projection.embedRanges.length ||
    state.embedStates.length !== current.projection.embeds.length
  ) {
    return false;
  }
  const sameRanges = state.embedRanges.every((range, index) => {
    const candidate = current.projection.embedRanges[index];
    return candidate !== undefined &&
      range.startLine === candidate.startLine &&
      range.endLine === candidate.endLine &&
      range.source?.block.id === candidate.source?.block.id &&
      range.source?.block.revision === candidate.source?.block.revision &&
      range.source?.startLine === candidate.source?.startLine &&
      range.source?.endLine === candidate.source?.endLine &&
      JSON.stringify(range.sources) === JSON.stringify(candidate.sources);
  });
  if (!sameRanges) return false;
  return state.embedStates.every((embed, index) => {
    const candidate = current.projection.embeds[index];
    if (
      candidate === undefined ||
      embed.blockId !== candidate.blockId ||
      embed.fragmentId !== candidate.fragmentId ||
      embed.status !== candidate.status ||
      embed.count !== candidate.count ||
      embed.completeness?.kind !== candidate.completeness?.kind
    ) {
      return false;
    }
    if (embed.completeness?.kind !== "truncated") return true;
    return candidate.completeness?.kind === "truncated" &&
      embed.completeness.limit === candidate.completeness.limit;
  });
}

function sameAnnotationThreads(
  left: readonly AnnotationThread[],
  right: readonly AnnotationThread[],
): boolean {
  return left.length === right.length &&
    left.every((thread, index) => {
      const candidate = right[index];
      return candidate !== undefined &&
        thread.block.id === candidate.block.id &&
        thread.block.revision === candidate.block.revision &&
        thread.currentResolution.id === candidate.currentResolution.id &&
        thread.replies.length === candidate.replies.length &&
        thread.replies.every((reply, replyIndex) => {
          const candidateReply = candidate.replies[replyIndex];
          return candidateReply !== undefined &&
            reply.block.id === candidateReply.block.id &&
            reply.block.revision === candidateReply.block.revision &&
            reply.currentResolution.id === candidateReply.currentResolution.id;
        });
    });
}

type DetailLoadOutcome = "applied" | "unchanged" | "cached" | "superseded";

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
  disconnected?: boolean;
  recovery?: EditRecovery;
  recoveryAccepted?: boolean;
  recoveryCount?: number;
  recoveryNotice?: string;
  document: DetailDocumentState;
  readonly context: SelectionContext;
  readonly target: OutlinerNavigationTarget | null;
  readonly resource: ResourceDescription["resource"] | null;
  canNavigateBack: boolean;
  canNavigateForward: boolean;
  resolvedSelectedText: string;
  resolvedProvenance: MappedDocument | null;
  projectedSelectedText: string;
  readStatus: "pending" | "ready" | "failed";
  embedStates: DetailEmbedState[];
  embedRanges: DetailEmbedRange[];
  /** Resource projections in the current read; catalog changes to them repaint the note. */
  resourceProjections?: readonly ResourceProjection[];
  embedBackgroundEnabled: boolean;
  workIdPrefix: string | null;
  resolvedBreadcrumb: string;
  mode: DetailMode;
  buffer: TextBuffer;
  referencedFile: ReferencedFile | null;
  previewOffset: number;
  previewSourceLine?: number;
  editorVisualOffset: number;
  editorViewportManual?: boolean;
  draftPreviewLinked?: boolean;
  fileOffset: number;
  fileCursor: number;
  selectionAnchor: number | null;
  annotationThreads: AnnotationThread[];
  /** Comment and reply text with block-reference titles resolved, keyed by stored text. */
  annotationReferences?: ReadonlyMap<string, string>;
  annotationRange: DetailLineRange | null;
  attention: AttentionClientState;
  attentionRevealSourceLine: number | null;
  annotationDraft?: DetailAnnotationDraft;
  annotationReplyDraft?: DetailAnnotationReplyDraft;
  selectedAnnotationId?: string;
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

export interface DetailEffects {
  chooseChecklistAction?(): Promise<ChecklistChoice | undefined>;
  updateChecklist?(blockId: string, input: ChecklistUpdateInput): Promise<ChecklistUpdateReceipt>;
  confirmListItemRemoval?(ids: readonly string[]): Promise<boolean>;
  recovery?: Pick<EditRecoveryClient,"retain"|"list"|"commit"|"separate"> & Partial<Pick<EditRecoveryClient,"checkpoint"|"warnings">>;
  reviewRecovery?(records:EditRecovery[]):Promise<RecoveryChoice>;
  readonly clientId: string;
  readonly browsingContextId: string;
  enqueueViewUpdate(update: () => void): void;
  focusSelf(): void;
  getBrowsingContext(): Promise<BrowsingContextState>;
  loadTarget(target: OutlinerNavigationTarget): Promise<DetailReadyDocument>;
  setNavigationProtection?(reason: string | null): Promise<void>;
  chooseDestination?(purpose: "link" | "open"): Promise<OutlinerViewAddress | null | undefined>;
  setDestination?(destination: OutlinerViewAddress | null): Promise<string | void>;
  setCurrentTarget(target: OutlinerNavigationTarget | null): Promise<void>;
  dispatchNavigation(
    target: OutlinerNavigationTarget,
    intent: OutlinerNavigationIntent,
    options?: { preserveSource?: boolean; focusTarget?: boolean; destination?: OutlinerViewAddress },
  ): Promise<OutlinerNavigationDispatch>;
  resolveNavigation(
    intent: OutlinerNavigationIntent,
    options?: { preserveSource?: boolean },
  ): Promise<OutlinerNavigationResolution>;
  resolveReferences(text: string): Promise<ResolvedBlockReferences>;
  projectRead(text: string, hostBlockId?: string, hostRevision?: number): Promise<DetailReadProjection>;
  queryBacklinks(query: BacklinkQuery): Promise<BacklinkCollection>;
  openBacklinkPeek(input: BacklinkPeekLaunch): void;
  openDetailPane(
    target: OutlinerNavigationTarget,
    direction: "right" | "down",
    targetPaneId?: string,
  ): void | Promise<void>;
  copyText(text: string): void;
  editExternalDraft(
    input:
      | {
          kind: "block";
          blockId: string;
          baseText: string;
          text: string;
          expectedRevision: number;
        }
      | {
          kind: "filesystem-resource";
          resourceId: string;
          text: string;
          expectedRevision: ResourceRevisionRef;
        },
  ): Promise<{
    text: string;
    changed: boolean;
    recoveryPath: string;
    recoveryInput?: EditRecoveryStart;
    cleanup(): void;
  }>;
  writeFilesystemResource(input: {
    resourceId: string;
    text: string;
    expectedRevision: ResourceRevisionRef;
  }): Promise<ResourceDescription>;
  updateBlock(input: {
    blockId: string;
    text: string;
    expectedRevision: number;
    identityChanges?: ChecklistIdentityChange[];
  }): Promise<Block>;
  patchProperties(input: {
    blockId: string;
    expectedRevision: number;
    operations: PropertyPatchOperation[];
  }): Promise<Block>;
  createAnnotation(input: {
    requestId: string;
    input: AnnotationCreateInput;
  }): Promise<AnnotationBatchReceipt>;
  replyAnnotation(input: { requestId: string; input: AnnotationReplyInput }): Promise<AnnotationBatchReceipt>;
  setAnnotationLifecycle(input: AnnotationLifecycleInput): Promise<AnnotationRecord>;
  internFilesystem(path: string): Promise<InternResourceReceipt>;
  lookupFilesystem(path: string): Promise<InternResourceReceipt["resource"] | null>;
  refreshResource(resourceId: string): Promise<ResourceDescription>;
  /** `r` on a note: fetch its tickets and run its extension lines again (`resources.projection.refresh`). */
  refreshProjections?(blockId: string): Promise<void>;
  openExternal(url: string): void | Promise<void>;
  getAnnotation(annotationId: string): Promise<AnnotationRecord>;
  listAnnotations(query: AnnotationListQuery): Promise<AnnotationThread[]>;
  reconcileAnnotations(input: AnnotationReconcileInput): Promise<AnnotationReconcileReceipt>;
  getAttention(): Promise<AttentionClientState>;
  acknowledgeAttention(markId?: string): Promise<AttentionClientState>;
  restoreBlock(blockId: string): Promise<Block>;
  resolveReference(target: OutlinerLinkTarget): Promise<ResolvedOutlinerLinkTarget>;
  followResourceOccurrence(target: OutlinerLinkTarget): Promise<FollowResourceOccurrenceReceipt>;
  queryBlocks(query: BlockSearchQuery): Promise<VisibleBlockCollection>;
  /** Fragment completion over every note (`fragments.candidates`); absent, completion searches blocks itself. */
  fragmentCandidates?(query: FragmentCandidateQuery): Promise<FragmentCandidateCollection>;
  /** Write a heading's anchor through the service (`fragments.ensure`). */
  ensureFragment?(input: { blockId: string; lineIndex: number; expectedRevision: number }): Promise<{ fragmentId: string; created: boolean }>;
  queryPageAddresses(query: string | undefined, limit: number): Promise<PageAddressCollection>;
  readFile(block: Block): Promise<ReferencedFile>;
  completeFiles(query: string): Promise<ReferencedPathCandidate[]>;
  focusOutliner(): Promise<void>;
  openPropertyInspectorPane(blockId: string): string | Promise<string>;
  openVirtualBranchNavigator(viewId: string, adapter?: "bookmark" | "mentions"): void | Promise<void>;
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

export type DetailOpenRouting = "linked" | "chooser";

export interface DetailResourceSelectionCapture {
  readonly kind: "resource";
  readonly resourceId: string;
  readonly representationId: string;
  readonly referenceContext?: AnnotationReferenceContext;
  readonly target: AnnotationTarget;
}

export type DetailDirectSelectionCapture =
  | { readonly kind: "rendered"; readonly capture: RenderedSelectionCapture }
  | DetailResourceSelectionCapture;

export type DetailIntent =
  | { type: "edit.begin" }
  | { type: "edit.external" }
  | { type: "edit.recover" }
  | { type: "annotation.selection.begin"; sourceLine?: number; sourceColumn?: number }
  | { type: "annotation.comment.direct"; capture: DetailDirectSelectionCapture | null }
  | { type: "annotation.thread.move"; delta: -1 | 1 }
  | { type: "annotation.thread.select"; annotationId: string }
  | { type: "annotation.thread.reply"; annotationId?: string }
  | { type: "annotation.thread.lifecycle"; annotationId?: string }
  | { type: "resource.refresh" }
  | { type: "resource.open-external" }
  | { type: "resource.open-url"; url: string }
  | { type: "annotation.selection.place"; row: number; column: number; extend?: boolean }
  | { type: "trash.restore" }
  | { type: "comment.begin"; sourceRange?: { start: number; end: number } }
  | { type: "navigation.link" }
  | { type: "navigation.back" }
  | { type: "navigation.forward" }
  | { type: "reference.follow" }
  | { type: "reference.open"; target: OutlinerLinkTarget; routing?: DetailOpenRouting }
  | { type: "reference.reveal" }
  | { type: "current.reveal" }
  | { type: "virtual-branch.open" }
  | { type: "bookmark.toggle" }
  | { type: "bookmarks.open" }
  | { type: "mentions.open" }
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
  | { type: "backlinks.kind.cycle" }
  | { type: "backlinks.stage.cycle" }
  | { type: "backlinks.resolved.toggle" }
  | { type: "backlinks.related.toggle" }
  | { type: "backlinks.group.toggle"; kind?: string }
  | { type: "backlinks.source.toggle"; blockId?: string }
  | { type: "preview.focus.move"; delta: -1 | 1 }
  | { type: "preview.focus.set"; regionId: string }
  | { type: "preview.activate" }
  | { type: "checklist.toggle" }
  | { type: "checklist.undo" }
  | { type: "preview.action"; action: PreviewRegionAction; routing?: DetailOpenRouting }
  | { type: "property-inspector.disclosure.toggle" }
  | { type: "property-inspector.pane.open" }
  | { type: "pane.open"; direction: "right" | "down"; targetPaneId?: string }
  | { type: "property-inspector.value.copy"; occurrenceId?: string }
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
  | { type: "completion.choose"; index:number; generation?:number }
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
  checkpointRecovery(): void;
  dispatch(intent: DetailIntent, viewport: DetailViewport): Promise<void>;
  captureResourceSelection(
    selection: DocumentSelection,
    snapshotText: string,
    renderRevision: number,
  ): DetailResourceSelectionCapture | null;
  setPreviewRegions(regions: readonly PreviewRegion[], viewport?: DetailViewport): void;
  handleUiCommand(command: OutlinerUiCommand, viewport: DetailViewport): Promise<void>;
  onServiceEvent(event: OutlinerEvent, viewport: DetailViewport): Promise<void>;
  supersedePassivePreview(): void;
  releaseDocument(): void;
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


function pdfAnnotationAnchor(
  description: ResourceDescription,
  start: number,
  end: number,
): Extract<AnnotationAnchor, { kind: "pdf-page-region" }> {
  const pdf = description.pdf;
  if (!pdf) throw new Error("PDF representation is unavailable");
  const page = pdf.pages.find((candidate) =>
    start >= candidate.start && end <= candidate.end
  );
  if (!page) throw new Error("PDF annotations must stay within one extracted page");
  const regions = page.spans
    .filter((span) => span.end > start && span.start < end)
    .map(({ region }) => region);
  if (regions.length === 0) {
    throw new Error("PDF selection has no durable page region");
  }
  return createPdfPageRegionAnchor(pdf.markdown, start, end, page.page, regions);
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
  const revision = revisionParts?.length === 3 &&
      revisionParts.slice(0, 2).every((part) => /^\d+$/.test(part)) &&
      /^[0-9a-f]{64}$/.test(revisionParts[2]!)
    ? {
        resourceId: resource.id,
        addressVersion: resource.addressVersion,
        revision: {
          kind: "filesystem" as const,
          mtimeNs: revisionParts[0]!,
          size: revisionParts[1]!,
          contentHash: revisionParts[2]!,
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
  const { snapshotText, passage, ...evidence } = capture;
  const observation: RenderedPassageObservation = { ...evidence, projection };
  const match = passage ? -1 : snapshotText.indexOf(capture.quote);
  const unique = match >= 0 && snapshotText.indexOf(capture.quote, match + 1) < 0;
  const contentHash = annotationSourceHash(snapshotText);
  return {
    ...(passage ? {passage} : {}),
    representation: {
      id: `rendered:${capture.hostBlockId}:${capture.paneId}:${capture.contentRevision}:${contentHash}${passage ? `:${capture.detailClientId}` : ""}`,
      subject: { kind: "block", blockId: selected.id },
      sourceSnapshot: { kind: "rendered", observation },
      adapter: { id: passage ? "outliner.document-frame" : "herdr.rendered-passage", version: 1 },
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

function textRangeOffsets(
  text: string,
  range: TextBufferRange,
): { start: number; end: number } | null {
  const lines = text.split("\n");
  const offset = ({ row, column }: TextBufferRange["start"]): number | null => {
    const line = lines[row];
    if (line === undefined || column < 0 || column > line.length) return null;
    let total = column;
    for (let index = 0; index < row; index += 1) total += lines[index]!.length + 1;
    return total;
  };
  const anchor = offset(range.start);
  const focus = offset(range.end);
  if (anchor === null || focus === null || anchor === focus) return null;
  return anchor < focus
    ? { start: anchor, end: focus }
    : { start: focus, end: anchor };
}

function detailBufferRangeOffsets(buffer: Readonly<TextBuffer>): { start: number; end: number } | null {
  const range = buffer.selectionRange;
  return range ? textRangeOffsets(buffer.text, range) : null;
}
function detailBufferPointAtOffset(text: string, offset: number): { row: number; column: number } {
  const clamped = Math.max(0, Math.min(offset, text.length));
  const before = text.slice(0, clamped);
  const lines = before.split("\n");
  return { row: lines.length - 1, column: lines[lines.length - 1]!.length };
}



export function detailVisibleEditorHeight(
  state: Pick<DetailState, "completion">,
  viewport: DetailViewport,
): number {
  if (viewport.editorBody) return viewport.editorBody.height;
  const completionRows = state.completion
    ? COMPLETION_ROWS
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
    canNavigateBack: false,
    annotationThreads: [],
    canNavigateForward: false,
    resolvedSelectedText: "",
    resolvedProvenance: null,
    projectedSelectedText: "",
    readStatus: "pending",
    embedStates: [],
    embedRanges: [],
    resourceProjections: [],
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
    backlinks: createDetailBacklinkState(),
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
  const checklist = new ChecklistSession((blockId, input) => {
    if (!effects.updateChecklist) throw Error("Checklist updates are unavailable in this reader");
    return effects.updateChecklist(blockId, input);
  });
  let navigationIndex = -1;
  let serviceConnected = false;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  function routineNotice(message: string): void {
    state.status = message;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { if (state.status === message) { state.status = ""; emit(); } }, 3_000);
    noticeTimer.unref();
  }

  let destinationChooser: OpenDestinationChooser | undefined;
  const destinationReferences = new WeakMap<OpenDestinationTarget, OutlinerLinkTarget>();
  let loadGeneration = 0;
  let openGeneration = 0;
  let fileReadGeneration = 0;
  const blockCache = new Map<string, DetailBlockCacheEntry>();

  const readBlockCache = (
    target: DetailBlockReadyDocument["target"],
  ): DetailBlockCacheEntry | null => {
    const key = blockCacheKey(target);
    const cached = blockCache.get(key);
    if (!cached) return null;
    blockCache.delete(key);
    blockCache.set(key, cached);
    return cached;
  };

  const writeBlockCache = (entry: DetailBlockCacheEntry): void => {
    const key = blockCacheKey(entry.document.target);
    blockCache.delete(key);
    blockCache.set(key, entry);
    while (blockCache.size > DETAIL_BLOCK_CACHE_TARGET_LIMIT) {
      const oldestKey = blockCache.keys().next().value;
      if (oldestKey === undefined) break;
      blockCache.delete(oldestKey);
    }
  };

  const markBlockCacheStale = (): void => {
    for (const entry of blockCache.values()) entry.stale = true;
  };

  let lastProtection: string | null | undefined;
  const protection = (): string | null => isBufferMode() ? "active edit or source selection" : state.selectionAnchor !== null ? "active source selection" : null;
  const emit = (): void => {
    const reason = protection();
    if (reason !== lastProtection && effects.setNavigationProtection && serviceConnected) {
      lastProtection = reason;
      void effects.setNavigationProtection(reason).catch(() => { lastProtection = undefined; });
    }
    onChange(state);
  };
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

  const loadFile = async (block: Block): Promise<boolean> => {
    const fileGeneration = ++fileReadGeneration;
    const generation = loadGeneration;
    const mode = state.mode;
    const isCurrent = (): boolean => fileGeneration === fileReadGeneration &&
      generation === loadGeneration &&
      state.context.selected?.id === block.id && state.mode === mode;
    const previousFile = state.referencedFile;
    state.referencedFile = null;
    try {
      const loaded = await effects.readFile(block);
      if (!isCurrent()) return false;
      if (previousFile?.absolutePath !== loaded?.absolutePath ||
        previousFile?.sourceHash !== loaded?.sourceHash ||
        previousFile?.sourceVersion !== loaded?.sourceVersion) state.annotationThreads = [];
      state.referencedFile = loaded;
      const file = state.referencedFile;
      if (file) {
        const marks = state.attention.marks.map((mark) => {
          if (
            mark.target.kind !== "file" ||
            mark.target.sourceBlockId !== block.id
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
      return true;
    } catch (error) {
      if (!isCurrent()) return false;
      state.referencedFile = null;
      state.status = errorMessage(error);
      return false;
    }
  };

  const applyResolvedReferences = (resolved: ResolvedBlockReferences, projection: MappedDocument): void => {
    state.resolvedSelectedText = resolved.text;
    state.resolvedProvenance = resolvedDocument(projection,resolved);
    state.workIdPrefix = resolved.workIdPrefix ?? null;
    state.readStatus = "ready";
  };

  const applyBlockRead = ({projection, resolved}: DetailBlockRead): void => {
    state.projectedSelectedText = projection.text;
    state.embedStates = projection.embeds;
    state.embedRanges = projection.embedRanges;
    state.resourceProjections = projection.resourceProjections ?? [];
    applyResolvedReferences(resolved,projection.provenance);
  };

  const applyReadProjection = async (
    text: string,
    hostBlockId?: string,
    hostRevision?: number,
  ): Promise<DetailBlockRead> => {
    const projection = await effects.projectRead(text, hostBlockId, hostRevision);
    const resolved = await effects.resolveReferences(projection.text);
    applyBlockRead({projection, resolved});
    return { projection, resolved };
  };

  const loadAnnotations = async (expectedGeneration = loadGeneration, application: "queued" | "current-turn" = "queued"): Promise<void> => {
    const targetAtStart = state.target;
    const documentAtStart = state.document;
    const fileAtStart = state.referencedFile;
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
        const content = description.pdf?.markdown ??
          description.web?.markdown ??
          description.filesystem?.text ??
          null;
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
          const record = await effects.getAnnotation(selected.id);
          const rootId = record.parentAnnotationId ?? record.block.id;
          const subject = record.originalTarget.representation.subject;
          threads = subject.kind === "legacy-file" ? [{ ...record, replies: [] }]
            : (await effects.listAnnotations({ subject, includeResolved: true }))
              .filter(thread => thread.block.id === rootId);
          // Quarantined legacy records still expose their immutable evidence.
          if (threads.length === 0 && !record.parentAnnotationId) threads = [{ ...record, replies: [] }];
        } else if (fileAtStart) {
          const resource = await effects.lookupFilesystem(fileAtStart.absolutePath);
          if (resource) {
            const subject: Extract<AnnotationSubject, { readonly kind: "resource" }> = {
              kind: "resource",
              resourceId: resource.id,
            };
            const representation = filesystemAnnotationRepresentation(resource, fileAtStart);
            const content = fileAtStart.sourceText ?? fileAtStart.lines.join("\n");
            threads = (await effects.reconcileAnnotations({
              subject,
              newRepresentation: representation,
              content,
            })).threads;
          }
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
    // Resolve only when a title can change; otherwise apply in this turn as before.
    const references = annotationReferenceTokens(threads).length
      ? await resolveAnnotationReferences(threads, text => effects.resolveReferences(text)) : new Map<string, string>();
    const apply = () => {
      if (expectedGeneration !== loadGeneration || state.document !== documentAtStart ||
        state.referencedFile !== fileAtStart || !sameNavigationTarget(state.target, targetAtStart) ||
        (sameAnnotationThreads(state.annotationThreads, threads) &&
          sameAnnotationReferences(state.annotationReferences, references))) return;
      if (isBufferMode() && !state.annotationReplyDraft) {
        state.refreshPending = true;
        return;
      }
      state.annotationThreads = threads;
      state.annotationReferences = references;
      emit();
    };
    if (application === "current-turn") apply();
    else effects.enqueueViewUpdate(apply);
  };

  const invalidateBacklinks = (): void => {
    state.backlinks.loading = false;
    state.backlinks.collection = null;
    state.backlinks.error = "";
    state.backlinks.selectedIndex = 0;
    state.backlinks.filter = "";
    state.backlinks.filterDraft = null;
    state.backlinks.kindFilter = null;
    state.backlinks.expandedKinds.clear();
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
    const generation = loadGeneration;
    const targetBlockId = detailBlockTarget(state)?.blockId;
    const isCurrent = (): boolean => generation === loadGeneration &&
      detailBlockTarget(state)?.blockId === targetBlockId;
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
        limit: BACKLINK_QUERY_LIMIT,
      });
      if (state.backlinks.expanded && isCurrent()) {
        if (isBufferMode()) state.refreshPending = true;
        else {
          state.backlinks.collection = collection;
          clampBacklinkSelection();
        }
      }
    } catch (error) {
      if (state.backlinks.expanded && isCurrent()) {
        state.backlinks.error = errorMessage(error);
      }
    } finally {
      if (isCurrent()) {
        state.backlinks.loading = false;
        effects.enqueueViewUpdate(() => { if (isCurrent()) emit(); });
      }
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
    if (!annotationReferenceContextsEqual(left.referenceContext, right.referenceContext)) return false;
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
    syncPropertyInspector(selected,false);
  };

  const cacheCurrentBlockRead = (read: DetailBlockRead): void => {
    if (state.document.kind !== "ready" || state.document.document.kind !== "block") return;
    writeBlockCache({
      document: state.document.document,
      projection: read.projection,
      resolved: read.resolved,
      stale: false,
    });
  };

  const clearDocumentPresentation = (): void => {
    state.recovery = undefined;
    state.recoveryAccepted = false;
    state.recoveryCount = 0;
    state.recoveryNotice = undefined;
    state.resolvedSelectedText = "";
    state.resolvedProvenance = null;
    state.projectedSelectedText = "";
    state.readStatus = "pending";
    state.embedStates = [];
    state.embedRanges = [];
    state.resourceProjections = [];
    state.workIdPrefix = null;
    state.resolvedBreadcrumb = "";
    state.referencedFile = null;
    state.previewOffset = 0;
    state.annotationThreads = [];
    invalidateBacklinks();
    syncPropertyInspector(null, true);
  };

  const providerRevisionLabel = (revision: ResourceRevisionRef): string => {
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
    if (providerRevision.kind === "computed") {
      return `computed ${providerRevision.producerId}@${providerRevision.producerVersion}, input v${providerRevision.inputVersion}, dependencies ${providerRevision.dependencyFingerprint}`;
    }
    const provider = providerRevision.kind === "github"
      ? "GitHub"
      : providerRevision.kind === "jira"
      ? "Jira"
      : "Linear";
    return `${provider} ${providerRevision.validator.kind} ${providerRevision.validator.value}`;
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

  const resourceDocument = (description: ResourceDescription): MappedDocument => {
    const {
      resource,
      source,
      pdf,
      pdfHistory,
      web,
      webHistory,
      remoteEntity,
      computed,
      computedStatus,
      computedFailure,
      presentation,
    } = description;
    const representation = presentation?.selected?.representation;
    const renderLocalContent = representation === undefined ||
      representation === "cached-markdown";
    const content=resourceContentDocument(description);
    if (description.filesystem && renderLocalContent) return content!;
    const externalUrl = presentation?.selected?.externalUrl ?? null;
    const openExternal = presentation?.capabilities["open-external"];
    const unavailableExternalFactor = RESOURCE_CAPABILITY_FACTORS
      .map((factor) => openExternal?.factors[factor])
      .find((assessment) =>
        assessment?.state === "blocked" || assessment?.state === "unknown"
      );
    const externalLines = externalUrl === null
      ? []
      : openExternal?.status === "available"
      ? externalUrl.startsWith("http://") || externalUrl.startsWith("https://")
        ? ["", `[Open externally](<${externalUrl}>)`]
        : [
            "",
            `- External URL: \`${externalUrl}\``,
            "- Open externally: Press Alt+O",
          ]
      : [
          "",
          `- External URL: \`${externalUrl}\``,
          `- External open: unavailable — ${
            unavailableExternalFactor && "detail" in unavailableExternalFactor
              ? unavailableExternalFactor.detail
              : "No negotiated open-external capability"
          }`,
        ];
    const remoteProvider = resource.provider === "jira"
      ? "Jira"
      : resource.provider === "linear"
      ? "Linear"
      : null;
    const lines = computed && renderLocalContent
      ? [
          computed.markdown,
          "",
          "---",
          "",
          "## Computed resource",
          "",
          `[Stable resource link](${outlinerLinkUri("resource", resource.id)})`,
        ]
      : pdf && renderLocalContent
      ? [
          pdf.markdown,
          "",
          "---",
          "",
          "## PDF resource",
          "",
          `[Stable resource link](${outlinerLinkUri("resource", resource.id)})`,
          ...externalLines,
        ]
      : web && renderLocalContent
        ? [
            web.markdown,
            "",
            "---",
            "",
            "## Web resource",
            "",
            `[Stable resource link](${outlinerLinkUri("resource", resource.id)})`,
            ...externalLines,
          ]
        : remoteEntity && renderLocalContent
          ? [
              remoteEntity.markdown,
              "",
              "---",
              "",
              `## ${remoteProvider ?? "Remote"} entity`,
              "",
              `[Stable resource link](${outlinerLinkUri("resource", resource.id)})`,
              ...externalLines,
            ]
          : [
              `# ${remoteEntity?.title ?? resourceAddressLabel(resource.address)}`,
              "",
              `[Stable resource link](${outlinerLinkUri("resource", resource.id)})`,
              ...externalLines,
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
    if (remoteEntity) {
      lines.push(
        "",
        "## Entity metadata",
        "",
        "```json",
        JSON.stringify(remoteEntity.metadata, null, 2),
        "```",
      );
    }
    if (resource.provider === "computed") {
      lines.push(
        "",
        "## Computed status",
        "",
        `- Invocation ID: \`${resource.address.invocationId}\``,
        `- Handler reference: \`producer:${resource.address.invocationId}\``,
        `- State: **${computedStatus?.state ?? "idle"}**`,
        `- Generation: ${computedStatus?.generation ?? 0}`,
        `- Last execution: ${computedStatus?.lastExecutionAt ?? "Never"}`,
      );
      if (computedFailure) {
        lines.push(
          "",
          "## Latest execution failure",
          "",
          `- Execution ID: \`${computedFailure.executionId}\``,
          `- Code: \`${computedFailure.code}\``,
          `- Failed: ${computedFailure.failedAt}`,
          `- Message: ${computedFailure.message}`,
        );
      }
    }
    if (
      resource.provider === "web" ||
      resource.provider === "jira" ||
      resource.provider === "linear"
    ) {
      const status = resource.provider === "web"
        ? description.webStatus
        : description.remoteStatus;
      const freshness = status?.freshness ?? "unknown";
      lines.push(
        "",
        "## Local status",
        "",
        `- Freshness: **${freshness}**`,
        `- Checked: ${status?.checkedAt ?? "Never"}`,
        ...(status?.lastError
          ? [`- Last refresh error: ${status.lastError}`]
          : description.remoteError
          ? [`- Last refresh error: ${description.remoteError}`]
          : []),
        "",
        freshnessGuidance(freshness, pdf != null || web !== null || remoteEntity !== null),
      );
    }
    if (computed) {
      const computedRevision = computed.revision.revision;
      if (computedRevision.kind !== "computed") {
        throw new Error("Computed Resource has a non-computed revision");
      }
      lines.push(
        "",
        "## Selected immutable content",
        "",
        `- Representation ID: \`${computed.representationId}\``,
        `- Content hash: \`${computed.contentHash}\``,
        `- Producer: \`${computedRevision.producerId}@${computedRevision.producerVersion}\``,
        `- Input version: ${computedRevision.inputVersion}`,
        `- Dependency fingerprint: \`${computedRevision.dependencyFingerprint}\``,
        `- Adapter: \`${computed.adapter.id}@${computed.adapter.version}\``,
        `- Derived: ${computed.derivedAt}`,
        `- Exact dependencies: ${computed.dependencies.length}`,
      );
      for (const dependency of computed.dependencies) {
        lines.push(
          `- Dependency \`${dependency.resourceId}\` · address v${dependency.addressVersion} · ${providerRevisionLabel(dependency)}`,
        );
      }
    } else if (pdf) {
      lines.push(
        "",
        "## Selected immutable content",
        "",
        `- Source snapshot ID: \`${pdf.sourceSnapshot.id}\``,
        `- Source hash: \`${pdf.sourceSnapshot.contentHash}\``,
        `- Provider revision: ${providerRevisionLabel(pdf.sourceSnapshot.revision)}`,
        `- Captured: ${pdf.sourceSnapshot.capturedAt}`,
        `- Source bytes available: ${pdf.sourceSnapshot.bytesAvailable ? "yes" : "no"}`,
        `- Text representation ID: \`${pdf.representation.id}\``,
        `- Text adapter: \`${pdf.representation.adapter.id}@${pdf.representation.adapter.version}\``,
        `- Text representation hash: \`${pdf.representation.contentHash}\``,
        `- Native representation ID: \`${pdf.nativeRepresentation.id}\``,
        `- Pages: ${pdf.pages.length}`,
      );
    } else if (web) {
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
    } else if (remoteEntity) {
      lines.push(
        "",
        "## Selected immutable content",
        "",
        `- Provider: \`${remoteEntity.sourceSnapshot.provider}\``,
        `- Entity ID: \`${remoteEntity.sourceSnapshot.entityId}\``,
        `- Locator: \`${remoteEntity.sourceSnapshot.locator}\``,
        `- Source hash: \`${remoteEntity.sourceSnapshot.contentHash}\``,
        `- Address version: \`${remoteEntity.sourceSnapshot.addressVersion}\``,
        `- Provider revision: ${providerRevisionLabel(remoteEntity.sourceSnapshot.revision)}`,
        `- Fetched: ${remoteEntity.sourceSnapshot.fetchedAt}`,
        `- Media type: \`${remoteEntity.representation.mediaType}\``,
        `- Adapter: \`${remoteEntity.representation.adapter.id}@${remoteEntity.representation.adapter.version}\``,
        `- Representation hash: \`${remoteEntity.representation.contentHash}\``,
        `- Derived: ${remoteEntity.representation.derivedAt}`,
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
        ...(description.remoteError ? [`- Read error: ${description.remoteError}`] : []),
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
          `- Snapshot \`${snapshot.id}\` · address v${snapshot.addressVersion} · ${snapshot.canonicalUrl ?? "URL unknown"} · ${snapshot.contentHash ?? "hash unknown"} · fetched ${snapshot.fetchedAt ?? "unknown"} · body ${snapshot.bodyAvailable ? "available" : snapshot.evictedAt ? `evicted ${snapshot.evictedAt}` : "unavailable"}`,
        );
      }
      for (const representation of webHistory.representations) {
        lines.push(
          `- Representation \`${representation.id}\` · snapshot \`${representation.sourceSnapshotId}\` · \`${representation.adapter.id}@${representation.adapter.version}\` · ${representation.contentHash} · derived ${representation.derivedAt ?? "unknown"} · content ${representation.contentAvailable ? "available" : representation.evictedAt ? `evicted ${representation.evictedAt}` : "unavailable"}`,
        );
      }
    }
    if (pdfHistory) {
      lines.push(
        "",
        "## Retained PDF history",
        "",
        `- Source snapshots: ${pdfHistory.sourceSnapshots.length}`,
        `- Representations: ${pdfHistory.representations.length}`,
      );
      for (const snapshot of pdfHistory.sourceSnapshots) {
        lines.push(
          `- Snapshot \`${snapshot.id}\` · address v${snapshot.addressVersion} · ${snapshot.locator} · ${snapshot.contentHash} · captured ${snapshot.capturedAt} · bytes ${snapshot.bytesAvailable ? "available" : "unavailable"}`,
        );
      }
      for (const candidate of pdfHistory.representations) {
        lines.push(
          `- Representation \`${candidate.id}\` · snapshot \`${candidate.sourceSnapshotId}\` · ${candidate.mediaType} · \`${candidate.adapter.id}@${candidate.adapter.version}\` · ${candidate.contentHash} · derived ${candidate.derivedAt}`,
        );
      }
    }
    if (description.availableCommands.length > 0) {
      lines.push(
        "",
        "## Available commands",
        "",
        "```json",
        JSON.stringify(description.availableCommands, null, 2),
        "```",
      );
    }
    lines.push("", "## Capabilities");
    const capabilityReport = presentation?.capabilities ?? description.capabilities;
    for (const capability of RESOURCE_CAPABILITIES) {
      const decision = capabilityReport[capability];
      lines.push(`- ${capability}: ${decision.status}`);
      for (const factor of RESOURCE_CAPABILITY_FACTORS) {
        const assessment = decision.factors[factor];
        if (assessment.state === "blocked" || assessment.state === "unknown") {
          lines.push(`  - ${factor}: ${assessment.state} — ${assessment.detail}`);
        }
      }
    }
    // The content is inserted as the first element above. Split at this known
    // construction boundary, not by searching a rendered string for a match.
    return content
      ? concatDocuments([content,generatedDocument(`\n${lines.slice(1).join('\n')}`,'resource presentation and diagnostics')])
      : generatedDocument(lines.join('\n'),'resource presentation and diagnostics');
  };

  const applyReadyBlockPresentation = (
    document: DetailBlockReadyDocument,
    read: DetailBlockRead | null,
    previousTarget: OutlinerNavigationTarget | null,
    record: boolean,
    changed: boolean,
  ): void => {
    const next = document.context;
    const targetChanged = !sameNavigationTarget(previousTarget, document.target);
    const preserveAnnotationViewport = !targetChanged && state.mode === "annotation" &&
      detailDisplayMode(next.selected) === "annotation";
    const blockChanged =
      detailBlockTarget({ target: previousTarget })?.blockId !== next.selected?.id;
    const revisionChanged = state.context.selected?.revision !== next.selected?.revision;
    if (record) recordNavigation(previousTarget);
    state.document = { kind: "ready", document };
    state.refreshPending = false;
    if (targetChanged) destinationChooser?.dispose();
    if (blockChanged) {
      state.previewRegions.disclosureOverrides.clear();
      state.attentionRevealSourceLine = null;
    }
    if (blockChanged || (revisionChanged && !preserveAnnotationViewport)) state.annotationThreads = [];
    if (blockChanged || changed) invalidateBacklinks();
    if (record) recordNavigation(document.target);
    else syncNavigationState();
    if (changed) state.status = "";

    if (next.selected) {
      syncPropertyInspector(next.selected, blockChanged);
      state.projectedSelectedText = read?.projection.text ?? next.selected.text;
      state.embedStates = read?.projection.embeds ?? [];
      state.embedRanges = read?.projection.embedRanges ?? [];
      state.resourceProjections = read?.projection.resourceProjections ?? [];
      if (read) applyResolvedReferences(read.resolved,read.projection.provenance);
      else {
        state.resolvedSelectedText = next.selected.text;
        state.resolvedProvenance = sourceDocument(observeDocument({kind:'block',blockId:next.selected.id},next.selected.text,next.selected.revision));
      }
      state.readStatus = read ? "ready" : "pending";
    } else {
      clearDocumentPresentation();
    }
    refreshBreadcrumb();
    if (!preserveAnnotationViewport) { state.previewOffset = 0; state.previewSourceLine = undefined; }
    const fragmentId = document.target.fragmentId;
    if (!preserveAnnotationViewport && fragmentId && next.selected) {
      const fragment = resolveFragment(next.selected.text, fragmentId);
      if (fragment.status === "resolved") {
        state.previewOffset = fragment.anchor.lineIndex;
        state.previewSourceLine = fragment.anchor.lineIndex;
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
    state.referencedFile = null;
  };

  const applyReadyDocument = async (
    document: DetailReadyDocument,
    generation: number,
    force: boolean,
    record: boolean,
    previousTarget: OutlinerNavigationTarget | null,
    cached: DetailBlockCacheEntry | null,
  ): Promise<boolean> => {
    const currentBlockDocument = state.document.kind === "ready" &&
        state.document.document.kind === "block"
      ? state.document.document
      : null;
    const targetChanged = !sameNavigationTarget(previousTarget, document.target);
    const changed = document.kind === "resource" || targetChanged ||
      currentBlockDocument === null || !sameBlockDocumentRevision(currentBlockDocument, document);
    const isCurrent = (): boolean => generation === loadGeneration &&
      state.document.kind === "ready" && state.document.document === document;

    if (document.kind === "resource") {
      if (record) recordNavigation(previousTarget);
      state.document = { kind: "ready", document };
      state.refreshPending = false;
      if (targetChanged) destinationChooser?.dispose();
      clearDocumentPresentation();
      state.status = "";
      state.resolvedProvenance = resourceDocument(document.description);
      state.resolvedSelectedText = state.resolvedProvenance.text;
      state.projectedSelectedText = state.resolvedSelectedText;
      state.readStatus = "ready";
      state.resolvedBreadcrumb = resourceDescriptionLabel(document.description);
      state.mode = "preview";
      if (record) recordNavigation(document.target);
      else syncNavigationState();
      emit();
    } else {
      const cachedRead = cached && sameBlockDocumentRevision(cached.document, document) &&
        cached.projection && cached.resolved
        ? { projection: cached.projection, resolved: cached.resolved }
        : null;
      if (changed) {
        applyReadyBlockPresentation(document, cachedRead, previousTarget, record, true);
        emit();
      } else {
        state.document = { kind: "ready", document };
      }
      writeBlockCache({ document, projection: cachedRead?.projection ?? null,
        resolved: cachedRead?.resolved ?? null, stale: false });
      const selected = document.context.selected;
      if (selected && effects.recovery) {
        void effects.recovery.list(selected.id).then(records => effects.enqueueViewUpdate(() => {
          if (!isCurrent()) return;
          state.recoveryCount = records.length;
          state.recoveryNotice = effects.recovery?.warnings?.join(" · ") || undefined;
          emit();
        })).catch(error => effects.enqueueViewUpdate(() => {
          if (isCurrent()) { state.status = `Could not inspect retained drafts · ${errorMessage(error)}`; emit(); }
        }));
      }

      if (selected && (force || changed || !cachedRead)) {
        // Only completed state updates enter the existing input/event lane.
        // Waiting for optional reads here would stall every later keypress.
        void (async () => {
          try {
            const projection = await effects.projectRead(selected.text, selected.id, selected.revision);
            if (!isCurrent()) return;
            const resolved = await effects.resolveReferences(projection.text);
            effects.enqueueViewUpdate(() => {
              if (!isCurrent()) return;
              const read = { projection, resolved };
              writeBlockCache({ document, ...read, stale: false });
              if (isBufferMode()) {
                state.refreshPending = true;
                return;
              }
              if (state.readStatus === "ready" && sameDisplayedBlockRead(state, read)) return;
              applyBlockRead(read);
              refreshBreadcrumb();
              emit();
            });
          } catch (error) {
            effects.enqueueViewUpdate(() => {
              if (!isCurrent()) return;
              if (isBufferMode()) state.refreshPending = true;
              else {
                state.readStatus = "failed";
                state.status = `Preview enrichment failed · ${errorMessage(error)}`;
                emit();
              }
            });
          }
        })();
      }
      if (state.mode === "file" && selected) {
        await loadFile(selected);
        if (!isCurrent()) return false;
        emit();
      }
    }
    if (serviceConnected) await effects.setCurrentTarget(document.target);
    if (!isCurrent()) return false;
    void loadBacklinks();
    void loadAnnotations(generation);
    return changed;
  };

  const loadNavigationTarget = async (
    target: OutlinerNavigationTarget,
    force = false,
    record = true,
    successStatus?: () => string,
  ): Promise<DetailLoadOutcome> => {
    const generation = ++loadGeneration;
    const previousTarget = state.target;
    const cached = target.kind === "block" ? readBlockCache(target) : null;
    state.refreshPending = false;
    const cachedPainted = cached !== null &&
      !sameNavigationTarget(previousTarget, target);
    if (cachedPainted) {
      applyReadyBlockPresentation(
        cached.document,
        cached.projection && cached.resolved
          ? { projection: cached.projection, resolved: cached.resolved }
          : null,
        previousTarget,
        record,
        true,
      );
      if (successStatus) routineNotice(successStatus());
      emit();
      if (state.mode === "file" && cached.document.context.selected) {
        await loadFile(cached.document.context.selected);
        if (generation !== loadGeneration) return "superseded";
        emit();
      }
    } else if (!cached) {
      state.document = { kind: "loading", target };
      emit();
    }
    try {
      const document = await effects.loadTarget(target);
      if (generation !== loadGeneration) return "superseded";
      if (!sameNavigationTarget(document.target, target)) {
        throw new Error("Detail loader returned a different navigation target");
      }
      const applied = await applyReadyDocument(
        document,
        generation,
        (cached?.stale ?? false) || force,
        cachedPainted ? false : record,
        cachedPainted ? target : previousTarget,
        cached,
      );
      if (generation !== loadGeneration) return "superseded";
      if (successStatus) routineNotice(successStatus());
      if (applied) return "applied";
      return cachedPainted ? "cached" : "unchanged";
    } catch (error) {
      if (generation !== loadGeneration) return "superseded";
      const message = errorMessage(error);
      if (cached) {
        cached.stale = true;
        writeBlockCache(cached);
        await effects.setCurrentTarget(target);
        if (generation !== loadGeneration) return "superseded";
        state.status = `Refresh failed · ${message}`;
        return "applied";
      }
      clearDocumentPresentation();
      state.document = { kind: "failed", target, message };
      if (record) {
        recordNavigation(previousTarget);
        recordNavigation(target);
      } else syncNavigationState();
      await effects.setCurrentTarget(target);
      if (generation !== loadGeneration) return "superseded";
      state.status = `Target is no longer available · ${message}`;
      return "applied";
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

  const applyNavigationCommand = async (
    command: OutlinerUiCommand,
  ): Promise<DetailLoadOutcome | null> => {
    if (!("target" in command) || !command.target) return null;
    const successStatus = (): string => {
      if (command.command === "preview") return "Preview";
      if (command.command === "open") {
        return command.target.kind === "block" && command.target.fragmentId
          ? `Opened fragment · ^${command.target.fragmentId} · line ${state.previewOffset + 1}`
          : "Opened here";
      }
      return command.command === "replace" ? "Replaced here" : "";
    };
    return loadNavigationTarget(
      command.target,
      true,
      command.command !== "preview",
      successStatus,
    );
  };

  const resolveDestinationTarget = async (
    target: OpenDestinationTarget,
    reference: OutlinerLinkTarget,
  ): Promise<void> => {
    if (reference.kind === "reference") {
      const receipt = await effects.followResourceOccurrence(reference);
      target.target = { kind: "resource", resourceId: receipt.resource.id,
        referenceContext: receipt.referenceContext };
      target.title = resourceAddressLabel(receipt.resource.address);
      return;
    }
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

  const openLinked = async (
    target: OpenDestinationTarget,
    preserveSource = false,
  ): Promise<boolean> => {
    try {
      const dispatched = await effects.dispatchNavigation(target.target, "open", {
        ...(preserveSource ? { preserveSource: true } : {}),
      });
      if (dispatched.targetClientId === effects.clientId) {
        if (options.openHere) {
          if (!await options.openHere(target.target)) throw new Error("Finish or cancel the Current draft or source selection before opening here");
        } else await applyNavigationCommand(dispatched.command);
      }
      routineNotice(`Opened ${target.title} in ${options.readerLabel ?? "linked Detail"}`);
      return true;
    } catch (error) {
      throw error;
    }
  };

  destinationChooser = new OpenDestinationChooser({
    openChosen: async (target) => {
      const destination = await effects.chooseDestination?.("open");
      if (!destination) return false;
      // Choosing or cancelling never resolves an authored Resource occurrence.
      const reference = destinationReferences.get(target);
      if (reference) await resolveDestinationTarget(target, reference);
      await effects.dispatchNavigation(target.target, "open", {destination});
      return true;
    },
    beforeOpen: async (target) => {
      const reference = destinationReferences.get(target);
      if (reference) await resolveDestinationTarget(target, reference);
    },
    replace: async (target) => {
      if (options.openHere) {
        if (!await options.openHere(target.target)) throw new Error("Finish or cancel the Current draft or source selection before opening here");
        return;
      }
      if (protection()) {
        throw new Error("Finish or cancel the active edit or source selection before replacing this Detail");
      }
      await applyNavigationCommand({
        targetClientId: effects.clientId,
        command: "replace",
        target: target.target,
      });
      const noun = target.target.kind === "resource" ? "resource" : "block";
      state.status = `Replaced ${noun} here`;
    },
    openLinked: (target) =>
      openLinked(
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
    readerLabel: options.readerLabel,
    ...(options.destinationTimeoutMs === undefined
      ? {}
      : { timeoutMs: options.destinationTimeoutMs }),
    ...(options.destinationScheduler === undefined
      ? {}
      : { scheduler: options.destinationScheduler }),
    actionKeymap: options.actionKeymap,
  });

  const refreshPendingTarget = async (): Promise<void> => {
    await loadCurrentTarget(true);
  };

  const editorLayout = (viewport: DetailViewport) =>
    layoutDetailEditor(
      state.buffer.lines,
      state.buffer.row,
      state.buffer.column,
      viewport.editorBody ?? viewport.editorWidth ?? viewport.width,
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

  const beginEdit = async (viewport: DetailViewport): Promise<void> => {
    const selected = state.context.selected;
    let text: string;
    let status: string;
    if (selected) {
      if (selected.effectiveDeletedRootId) {
        state.status = "Block is in Trash; restore before editing";
        return;
      }
      text = selected.text;
      status = "Editing";
    } else {
      const description = detailResourceDescription(state);
      if (
        !description ||
        description.resource.provider !== "filesystem" ||
        description.source.provider !== "filesystem"
      ) {
        state.status = description
          ? "Resource content is provider-owned; edit it through the provider"
          : "No selected block or Resource to edit";
        return;
      }
      if (description.requestedRevision !== null) {
        state.status = "Pinned filesystem Resource revisions are read-only";
        return;
      }
      if (
        !description.filesystem ||
        !isTextualMediaType(description.resource.mediaType)
      ) {
        state.status = "This filesystem Resource has no editable text representation";
        return;
      }
      const write = description.capabilities.write;
      if (write.status !== "available") {
        const factor = RESOURCE_CAPABILITY_FACTORS
          .map((name) => write.factors[name])
          .find((assessment) =>
            assessment.state === "blocked" || assessment.state === "unknown"
          );
        state.status = factor && "detail" in factor
          ? factor.detail
          : "Filesystem Resource writing is unavailable";
        return;
      }
      text = description.filesystem.text;
      status = "Editing filesystem Resource";
    }
    state.buffer = new TextBuffer(text);
    state.recovery = undefined;
    state.recoveryAccepted = false;
    state.buffer.row = state.buffer.lines.length - 1;
    state.buffer.moveEnd();
    state.editorVisualOffset = 0;
    state.editorViewportManual = false;
    state.draftPreviewLinked = false;
    state.completion = null;
    state.mode = "edit";
    state.status = status;
    ensureEditorCursorVisible(viewport);
  };

  const editExternalDraft = async (viewport: DetailViewport): Promise<void> => {
    if (state.mode !== "edit") await beginEdit(viewport);
    if (state.mode !== "edit") return;
    const selected = state.context.selected;
    if (state.busy) return;
    const previousViewportOffset = state.editorVisualOffset;
    state.busy = true;
    state.status = "Opening draft in $EDITOR";
    emit();
    try {
      if (!selected) {
        const description = detailResourceDescription(state);
        const filesystem = description?.filesystem;
        if (
          !description ||
          description.resource.provider !== "filesystem" ||
          !filesystem
        ) {
          throw new Error("Editable filesystem Resource is unavailable");
        }
        const result = await effects.editExternalDraft({
          kind: "filesystem-resource",
          resourceId: description.resource.id,
          text: state.buffer.text,
          expectedRevision: filesystem.revision,
        });
        if (!result.changed) {
          result.cleanup();
          state.status = "$EDITOR returned an unchanged filesystem Resource";
          return;
        }
        await effects.writeFilesystemResource({
          resourceId: description.resource.id,
          text: result.text,
          expectedRevision: filesystem.revision,
        });
        result.cleanup();
        state.mode = "preview";
        await loadCurrentTarget(true);
        state.status = "Filesystem Resource updated from $EDITOR";
        return;
      }
      const result = await effects.editExternalDraft({
        kind: "block",
        blockId: selected.id,
        baseText: selected.text,
        text: state.buffer.text,
        expectedRevision: selected.revision,
      });
      if (!result.changed && (!result.recoveryInput || result.text === selected.text)) {
        result.cleanup();
        state.status = "$EDITOR returned an unchanged draft";
        return;
      }
      let replaced: boolean;
      try {
        replaced = state.buffer.replaceText(result.text);
      } catch (error) {
        throw new Error(
          `Could not import the external editor draft. Recoverable editor file: ${result.recoveryPath}`,
          { cause: error },
        );
      }
      if (!replaced && !result.recoveryInput) {
        result.cleanup();
        state.status = "$EDITOR returned an unchanged draft";
        return;
      }
      if (effects.recovery && result.recoveryInput) {
        state.recovery = await effects.recovery.retain(result.recoveryInput);
        state.recoveryAccepted = state.recovery.latest.revision === selected.revision;
        state.recoveryCount = Math.max(1,state.recoveryCount ?? 0);
        result.cleanup();
        if (state.recovery.latest.revision !== selected.revision) {
          if (!acceptMechanicalRecovery()) {
            state.status = "Your writing is retained. The note also changed; review both versions.";
            await recoverWriting(viewport,[state.recovery]);
            return;
          }
        }
      } else result.cleanup();
      const layout = editorLayout(viewport);
      const maximumOffset = Math.max(
        0,
        layout.rows.length - detailVisibleEditorHeight(state, viewport),
      );
      state.editorVisualOffset = Math.min(previousViewportOffset, maximumOffset);
      state.completion = null;
      state.status = state.recovery && state.recovery.latest.revision !== selected.revision
        ? "Combined independent changes · Ctrl+S saves · original writing retained"
        : "Imported $EDITOR changes into the draft · Ctrl+S saves · Undo restores the prior draft";
    } catch (error) {
      state.status = errorMessage(error);
    } finally {
      state.busy = false;
    }
  };

  const recoveryInput = (): EditRecoveryStart => {
    const selected=state.context.selected;
    if (!selected) throw Error("Recovery requires an ordinary note");
    return {id:crypto.randomUUID(),blockId:selected.id,baseText:selected.text,baseRevision:selected.revision,
      prelaunchText:state.buffer.text,draftText:state.buffer.text,source:"save-conflict"};
  };

  let mechanicalAcceptance: {buffer: TextBuffer; recovery: EditRecovery; text: string; undone: boolean} | undefined;
  const mechanicalMergeUndone = (): boolean =>
    mechanicalAcceptance?.buffer === state.buffer && mechanicalAcceptance.undone;

  // Accept only the deterministic comparison for this active draft. Historical
  // recoveries and model proposals still require an explicit choice.
  const acceptMechanicalRecovery = (): boolean => {
    const recovery = state.recovery;
    if (mechanicalMergeUndone() || !recovery || !recovery.proposal || recovery.proposal.source !== "mechanical" ||
        recovery.proposal.unresolved.length || recovery.merge.incomplete ||
        recovery.merge.conflicts.length || recovery.merge.propertyConflicts?.length ||
        state.buffer.text !== recovery.draftText) return false;
    state.buffer.replaceText(recovery.proposal.text);
    mechanicalAcceptance = {buffer: state.buffer, recovery, text: state.buffer.text, undone: false};
    replaceSelectedBlock(recovery.latest);
    state.recoveryAccepted = true;
    return true;
  };

  const recoverWriting = async (viewport:DetailViewport, records?:EditRecovery[]):Promise<void> => {
    const selected=state.context.selected;
    if (!selected || !effects.recovery || !effects.reviewRecovery) {state.status="No block recovery is available in this view";return;}
    if ((!records || mechanicalMergeUndone()) && state.mode === "edit" &&
        (state.buffer.text !== selected.text || mechanicalMergeUndone()) && state.recovery?.draftText !== state.buffer.text) {
      state.recovery=await effects.recovery.retain(recoveryInput());
      state.recoveryAccepted=false;
      if (records) records=[state.recovery];
    }
    records ??= await effects.recovery.list(selected.id,true);
    state.recoveryNotice=effects.recovery.warnings?.join(" · ") || undefined;
    if (!records.length) {state.recovery=undefined;state.recoveryCount=0;state.status=state.recoveryNotice??"No retained drafts or saved recovery history for this note";return;}
    emit();
    const choice=await effects.reviewRecovery(records);
    if(choice.action==="later") {
      if(choice.record.state==="discarded"&&state.recovery?.id===choice.record.id)state.recovery=undefined;
      state.recoveryCount=(await effects.recovery.list(selected.id)).length;
      state.status=state.recoveryCount ? "Writing retained · Alt+R or the actions menu opens Writing history" : "Recovery closed; canonical note unchanged";
      return;
    }
    if(choice.action==="separate") {
      const block=await effects.recovery.separate(choice.record);
      state.mode="preview";
      await loadNavigationTarget({kind:"block",blockId:block.id},true,true);
      state.status="Saved a separate note containing the exact draft as quoted text; original note unchanged";
      return;
    }
    state.recovery=choice.record;
    mechanicalAcceptance=undefined;
    state.recoveryAccepted=true;
    replaceSelectedBlock(choice.record.latest);
    state.buffer=new TextBuffer(choice.action==="proposal" ? choice.record.proposal!.text : choice.record.draftText);
    state.mode="edit";state.completion=null;state.editorVisualOffset=0;
    state.status=choice.record.proposal?.unresolved.length
      ? "Review unresolved choices against Latest before Ctrl+S · original draft retained"
      : "Review recovered draft · Ctrl+S saves against the displayed latest revision · Esc retains recovery";
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
    const entry = findPropertyInspectorEntry(state.propertyInspector.model, focusedId);
    if (!entry) {
      state.status = "Focus a property value before editing";
      return;
    }
    const buffer = new TextBuffer(entry.value);
    buffer.moveEnd();
    state.propertyInspector.edit = {
      occurrenceId: entry.occurrenceId,
      ordinal: entry.ordinal,
      blockId: selected.id,
      expectedRevision: selected.revision,
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
        expectedRevision: edit.expectedRevision,
        operations: [{ op: "replace", ordinal: edit.ordinal, value: edit.buffer.text }],
      });
      state.propertyInspector.edit = null;
      if (state.refreshPending) {
        await refreshPendingTarget();
        return;
      }
      replaceSelectedBlock(updated);
      syncPropertyInspector(updated, false);
      const read = await applyReadProjection(updated.text, updated.id, updated.revision);
      cacheCurrentBlockRead(read);
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
    const description = detailResourceDescription(state);
    const resourceText = displayedResourceText(state);
    if (description?.pdf && sourceLine >= description.pdf.markdown.split("\n").length) {
      state.status = "Select PDF text, not resource metadata, before adding annotations";
      return;
    }
    if (!resourceText && (!selected || selected.effectiveDeletedRootId)) {
      state.status = selected
        ? "Block is in Trash; restore before adding annotations"
        : "This view has no source text to annotate";
      return;
    }
    state.buffer = new TextBuffer(resourceText ?? selected!.text);
    state.buffer.placeCursor(sourceLine, sourceColumn);
    state.editorVisualOffset = 0;
    state.editorViewportManual = false;
    state.draftPreviewLinked = false;
    state.completion = null;
    state.annotationDraft = undefined;
    state.mode = "select";
    state.status = "extend the rendered selection, then press c";
  };

  const beginComment = async (
    sourceRange?: { start: number; end: number },
    sourceOverride?: Block,
  ): Promise<void> => {
    const selected = sourceOverride ?? state.context.selected;
    const description = sourceOverride ? null : detailResourceDescription(state);
    const pdf = description?.pdf;
    const resourceText = sourceOverride ? null : displayedResourceText(state);
    if (!resourceText && (!selected || selected.effectiveDeletedRootId)) {
      state.status = selected
        ? "Block is in Trash; restore before adding annotations"
        : "This view has no source text to annotate";
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
      if (resourceText && description) {
        const representation = resourceAnnotationRepresentation(description);
        if (!representation) throw new Error("Local resource representation is unavailable");
        target = {
          representation,
          anchor: pdf
            ? pdfAnnotationAnchor(description, offsets.start, offsets.end)
            : createTextQuoteAnchor(resourceText, offsets.start, offsets.end),
          ...(state.target?.kind === "resource" && state.target.referenceContext
            ? { referenceContext: state.target.referenceContext } : {}),
        };
      } else {
        const source = selected!;
        target = blockCommentTarget(source, { quote: source.text.slice(offsets.start, offsets.end), start: offsets.start });
        if (authoredResourceReferenceOccurrences(source.text).some(occurrence =>
          occurrence.kind === "authored-resource" && occurrence.start === offsets.start && occurrence.end === offsets.end
        )) {
          const referenceContext = createAnnotationReferenceContext(source, offsets.start, offsets.end);
          target = { representation: referenceContext.representation, anchor: referenceContext.anchor, referenceContext };
        }
      }
      returnMode = "preview";
    } else if (state.mode === "file") {
      const range = selectedDetailFileRange(state);
      const file = state.referencedFile;
      if (!range || !file || !selected) {
        state.status = "Select file lines before commenting";
        return;
      }
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
    } else {
      const representation = description
        ? resourceAnnotationRepresentation(description)
        : selected ? blockAnnotationRepresentation(selected) : null;
      if (!representation) {
        state.status = "This view has no captured representation to comment on";
        return;
      }
      target = {
        representation,
        anchor: { kind: "whole-subject" },
        ...(state.target?.kind === "resource" && state.target.referenceContext
          ? { referenceContext: state.target.referenceContext } : {}),
      };
      returnMode = "preview";
    }
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
    state.status = anchor.kind === "whole-subject"
      ? target.referenceContext ? "Commenting on this reference" : "Commenting on the whole note"
      : returnMode === "file" && state.annotationRange
      ? `commenting on ${state.referencedFile?.sourcePath}:${state.annotationRange.startLine}-${state.annotationRange.endLine}`
      : target.referenceContext
        ? `commenting on this reference${target.representation.subject.kind === "resource" ? ` · Resource passage ${range}` : " occurrence"}`
      : target.representation.subject.kind === "resource"
        ? `commenting on cached Markdown ${range}`
        : `commenting on source range ${range}`;
  };

  const captureResourceSelection = (
    selection:DocumentSelection, snapshotText:string, renderRevision:number,
  ):DetailResourceSelectionCapture|null => {
    const description=detailResourceDescription(state);
    const representation=description?resourceAnnotationRepresentation(description):null;
    if(!description||!representation||!selection.text)return null;
    const referenceContext=state.target?.kind==='resource'?state.target.referenceContext:undefined;
    return {kind:'resource',resourceId:description.resource.id,representationId:representation.id,
      ...(referenceContext?{referenceContext}:{}),
      target:renderedDocumentAnnotationTarget({subject:representation.subject,
        passage:captureAnnotationPassage(selection),snapshotText,capturedAt:new Date().toISOString(),
        readerId:effects.clientId,renderRevision,input:'pointer',projection:'resolved',referenceContext})};
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
      ? `commenting on rendered quote ${anchor.start}-${anchor.end}`
      : "commenting on the captured rendered passage";
  };

  const beginDirectComment = async (
    capture: DetailDirectSelectionCapture,
  ): Promise<void> => {
    if (capture.kind === "rendered") {
      await beginRenderedComment(capture.capture);
      return;
    }
    const description = detailResourceDescription(state);
    const text = displayedResourceText(state);
    const representation = description ? resourceAnnotationRepresentation(description) : null;
    if (
      !description ||
      !text ||
      !representation ||
      description.resource.id !== capture.resourceId
    ) {
      state.status = "The Resource changed after the selection was captured";
      return;
    }
    if (
      representation.id !== capture.representationId
    ) {
      state.status = "The Resource representation changed after the selection was captured";
      return;
    }
    if (!annotationReferenceContextsEqual(capture.referenceContext,
      state.target?.kind === "resource" ? state.target.referenceContext : undefined)) {
      state.status = "The reference context changed after the selection was captured; select the passage again";
      return;
    }
    state.annotationDraft={requestId:crypto.randomUUID(),target:capture.target,returnMode:'preview'};
    state.buffer=new TextBuffer();
    state.editorVisualOffset=0;
    state.draftPreviewLinked=false;
    state.completion=null;
    state.mode='comment';
    state.status='Commenting on the captured Resource passage';
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

  const annotationGroups = () => detailAnnotationGroups(state);

  const selectAnnotationThread = (annotationId: string, reveal: boolean, viewport?: DetailViewport): boolean => {
    const groups = annotationGroups();
    const group = groups.find(group => group.threads.some(thread => thread.block.id === annotationId));
    const threads = groups.flatMap(group => group.threads);
    const index = threads.findIndex(thread => thread.block.id === annotationId);
    if (!group || index < 0) {
      state.status = "Comment thread is no longer available";
      return false;
    }
    state.selectedAnnotationId = annotationId;
    if (reveal) {
      state.previewRegions.disclosureOverrides.set(group.regionId, true);
      const region = state.previewRegions.regions.find(region => region.id === group.regionId);
      if (region?.disclosure) region.disclosure.expanded = true;
      state.previewRegions.focusedRegionId = `annotation-thread:${annotationId}`;
      const preview = viewport?.preview;
      const row = preview?.threadRows.get(annotationId);
      if (viewport && preview && row !== undefined) {
        const lineCount = preview.sourceLines.length + preview.annotationLines.length;
        state.previewOffset = Math.min(row, Math.max(0, lineCount - (viewport.previewBodyHeight ?? Math.max(1, viewport.height - 5))));
        state.propertyInspector.expanded = false;
      }
    }
    state.status = `Comment ${index + 1} of ${threads.length} · ${group.placement} · ${threads[index]!.lifecycle}`;
    return true;
  };

  const beginAnnotationReply = (annotationId?: string): void => {
    if (isBufferMode() || state.busy) return;
    if (annotationId && !selectAnnotationThread(annotationId, false)) return;
    const thread = selectedAnnotationThread(state);
    if (!thread) {
      state.status = "Select a comment with [ or ] before replying";
      return;
    }
    state.annotationReplyDraft = {
      requestId: crypto.randomUUID(), annotationId: thread.block.id,
      returnMode: state.mode as "preview" | "file" | "annotation",
    };
    state.annotationDraft = undefined;
    state.buffer = new TextBuffer();
    state.editorVisualOffset = 0;
    state.editorViewportManual = false;
    state.completion = null;
    state.mode = "comment";
    state.status = "Reply to selected comment · Ctrl+S saves · Esc cancels";
  };

  const changeAnnotationLifecycle = async (annotationId?: string): Promise<void> => {
    if (isBufferMode() || state.busy) return;
    if (annotationId && !selectAnnotationThread(annotationId, false)) return;
    const thread = selectedAnnotationThread(state);
    if (!thread) {
      state.status = "Select a comment with [ or ] before resolving or reopening";
      return;
    }
    state.busy = true;
    try {
      const lifecycle = thread.lifecycle === "open" ? "resolved" : "open";
      const updated = await effects.setAnnotationLifecycle({ annotationId: thread.block.id, lifecycle });
      state.annotationThreads = state.annotationThreads.map(current =>
        current.block.id === updated.block.id ? { ...updated, replies: current.replies } : current);
      state.status = lifecycle === "resolved" ? "Comment resolved" : "Comment reopened";
    } catch (error) {
      state.status = errorMessage(error);
    } finally {
      state.busy = false;
    }
  };

  const cancelBuffer = async (): Promise<void> => {
    let retentionNotice: string | undefined;
    if (state.mode === "edit" && state.recovery && effects.recovery && state.buffer.text !== state.recovery.draftText) {
      try {
        state.recovery=await effects.recovery.retain(recoveryInput());
      } catch (error) {
        if (!(error instanceof EditRecoveryRetainedLocallyError)) throw error;
        retentionNotice=`Writing retained locally; the service did not acknowledge it · ${errorMessage(error)}`;
      }
      state.recoveryAccepted=false;
    }
    if (state.annotationReplyDraft) {
      state.mode = state.annotationReplyDraft.returnMode;
      state.annotationReplyDraft = undefined;
      state.status = "Reply cancelled";
      return;
    }
    const cancelledMode = state.mode;
    const commentReturnMode = state.annotationDraft?.returnMode;
    state.mode = commentReturnMode ?? detailDisplayMode(state.context.selected);
    state.annotationDraft = undefined;
    state.status = cancelledMode === "comment" ? "Comment cancelled" : "Edit cancelled";
    if(cancelledMode==="edit"&&state.recovery)state.status="Writing retained · Alt+R or the actions menu opens Writing history";
    const cancelStatus = state.status;
    if (cancelledMode !== "comment") await focusOutliner(false);
    if (retentionNotice) state.status = state.status === cancelStatus ? retentionNotice : `${retentionNotice} · ${state.status}`;
  };

  const saveBuffer = async (viewport:DetailViewport): Promise<void> => {
    if (state.busy) return;
    if (state.mode === "edit" && state.recovery &&
        (mechanicalMergeUndone() || !state.recoveryAccepted) && !acceptMechanicalRecovery()) {
      state.recoveryAccepted=false;
      state.status="Review the retained writing against Latest before saving";
      await recoverWriting(viewport,[state.recovery]);
      return;
    }
    let written = false;
    state.busy = true;
    try {
      if (state.mode === "edit") {
        const selected = state.context.selected;
        if (selected) {
          const draftText = state.buffer.text;
          const basis = state.recovery?.latest ?? selected;
          const removed = removedListItemIds(basis.text, draftText);
          let identityChanges: ChecklistIdentityChange[] | undefined;
          if (removed.length) {
            if (!await effects.confirmListItemRemoval?.(removed)) {
              state.status = "Draft kept open · item addresses have not been removed";
              return;
            }
            if (state.mode !== "edit" || state.context.selected?.id !== selected.id ||
              state.context.selected.revision !== selected.revision || state.buffer.text !== draftText ||
              (state.recovery?.latest.revision ?? selected.revision) !== basis.revision) {
              state.status = "Writing changed during confirmation · review the draft and save again";
              return;
            }
            identityChanges = removed.map(itemId => ({kind: "remove", itemId}));
          }
          const updated = state.recovery && effects.recovery ? await effects.recovery.commit(state.recovery,draftText,identityChanges) : await effects.updateBlock({
            blockId: selected.id,
            text: draftText,
            expectedRevision: selected.revision,
            ...(identityChanges ? {identityChanges} : {}),
          });
          written = true;
          state.recovery=undefined;
          state.status="Saved";
          replaceSelectedBlock(updated);
          const read = await applyReadProjection(updated.text, updated.id, updated.revision);
          cacheCurrentBlockRead(read);
          refreshBreadcrumb();
          state.mode = detailDisplayMode(updated);
          if (state.mode === "file") await loadFile(updated);
          else state.referencedFile = null;
        } else {
          const description = detailResourceDescription(state);
          const filesystem = description?.filesystem;
          if (
            !description ||
            description.resource.provider !== "filesystem" ||
            !filesystem
          ) {
            throw new Error("Editable filesystem Resource is unavailable");
          }
          await effects.writeFilesystemResource({
            resourceId: description.resource.id,
            text: state.buffer.text,
            expectedRevision: filesystem.revision,
          });
          state.mode = "preview";
          await loadCurrentTarget(true);
          state.status = "Filesystem Resource saved";
        }
      } else if (state.mode === "comment" && state.annotationReplyDraft) {
        const draft = state.annotationReplyDraft;
        const body = state.buffer.text.trim();
        if (!body) throw new Error("Reply body cannot be empty");
        await effects.replyAnnotation({ requestId: draft.requestId, input: {
          annotationId: draft.annotationId, body, source: "user",
        } });
        state.mode = draft.returnMode;
        state.annotationReplyDraft = undefined;
        await loadAnnotations();
        state.status = "Reply added";
        return;
      } else if (state.mode === "comment" && state.annotationDraft) {
        const draft = state.annotationDraft;
        const body = state.buffer.text.trim();
        if (!body) throw new Error("Annotation body cannot be empty");
        const receipt = await effects.createAnnotation({
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
        // Saving this comment may have assigned an item ID. Reconcile against the
        // resulting source, never the pre-save reader snapshot.
        if (receipt.annotations.some(record => record.originalTarget.listItemId)) await loadCurrentTarget(true);
        else await loadAnnotations();
        const anchor = draft.target.anchor;
        const range = anchor.kind === "text-quote" &&
            anchor.start !== null &&
            anchor.end !== null
          ? `${anchor.start}-${anchor.end}`
          : "unpositioned quote";
        state.status = anchor.kind === "whole-subject"
          ? draft.target.referenceContext ? "Comment added for this reference" : "Comment added for the whole note"
          : draft.returnMode === "file" && state.annotationRange
          ? `Annotation added for lines ${state.annotationRange.startLine}-${state.annotationRange.endLine}`
          : draft.target.referenceContext
            ? "Annotation added for this reference occurrence"
          : draft.target.representation.sourceSnapshot.kind === "rendered"
            ? "Annotation added for captured rendered passage"
            : draft.target.representation.subject.kind === "resource"
              ? `Annotation added for cached Markdown ${range}`
              : `Annotation added for source range ${range}`;
      }
      if (!isBufferMode() && state.refreshPending) await refreshPendingTarget();
    } catch (error) {
      state.status = written ? `Saved; display refresh failed · ${errorMessage(error)}` : errorMessage(error);
      if (!written && state.mode === "edit" && state.context.selected && effects.recovery) {
        try {
          state.recovery=await effects.recovery.retain(recoveryInput());
          state.recoveryAccepted=false;
          state.recoveryCount=Math.max(1,state.recoveryCount??0);
          state.status=`Save did not apply · ${errorMessage(error)} · writing retained`;
        } catch (retentionError) {
          const retained = retentionError instanceof EditRecoveryRetainedLocallyError ? "this editor and local recovery" : "this editor";
          state.status=`Save did not apply · draft remains in ${retained} · ${errorMessage(retentionError)}`;
        }
      }
    } finally {
      state.busy = false;
      emit();
    }
  };

  let completionViewport:DetailViewport={width:80,height:24};
  const completions = new ReferenceCompletionSession({
    queryBlocks: query => effects.queryBlocks(query),
    ...(effects.fragmentCandidates ? { fragmentCandidates: (query: FragmentCandidateQuery) => effects.fragmentCandidates!(query) } : {}),
    ...(effects.ensureFragment ? { ensureFragment: (input: { blockId: string; lineIndex: number; expectedRevision: number }) => effects.ensureFragment!(input) } : {}),
    queryPageAddresses: (query, limit) => effects.queryPageAddresses(query, limit),
    completeFiles: query => effects.completeFiles(query),
    readContext: async blockId => {
      const document = await effects.loadTarget({kind:"block",blockId});
      if(document.kind!=="block")throw Error("Expected a block completion target");
      return document.context;
    },
    updateBlock: input => effects.updateBlock(input),
  }, () => state.buffer, () => state.workIdPrefix, () => {state.completion=completions.state;if(completions.state)state.status=completions.state.message??"";ensureEditorCursorVisible(completionViewport);emit();},
  () => state.mode === "edit", () => state.context.selected ? {blockId:state.context.selected.id,text:state.buffer.text}:undefined);
  const openCompletion = () => completions.refresh();
  const applyCompletion = async () => {
    const item=completions.state?.items[completions.state.index];
    if(await completions.accept())state.status=item?.anchor?`Created fragment · ^${item.anchor.fragmentId}`:"";
  };

  let measuredPreviewFocus = "";
  const navigatePreview = (
    direction: "up" | "down" | "pageup" | "pagedown" | "top" | "bottom",
    viewport: DetailViewport,
  ): void => {
    const lineCount = state.mode === "annotation"
      ? buildDetailAnnotationView(state, viewport.width).length
      : viewport.preview ? viewport.preview.sourceLines.length + viewport.preview.annotationLines.length
      : state.resolvedSelectedText.split(/\r?\n/).length;
    const maximum = Math.max(0, lineCount - (state.mode === "annotation" || viewport.preview ? (viewport.previewBodyHeight ?? Math.max(1, viewport.height - 5)) : 1));
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

  const showChecklistReceipt = async (result: ChecklistResult, generation: number, hostId:string, foldExpanded?:boolean): Promise<void> => {
    const receipt = result.receipt;
    const selected = state.context.selected;
    if (generation !== openGeneration || state.mode !== "preview" || selected?.id !== hostId) return;
    const source = selected.id === receipt.block.id ? receipt.block : selected;
    const projection = await effects.projectRead(source.text, source.id, source.revision);
    const resolved = await effects.resolveReferences(projection.text);
    if (generation !== openGeneration || state.mode !== "preview" || state.context.selected?.id !== hostId || state.context.selected.revision > source.revision) return;
    const read = {projection, resolved};
    replaceSelectedBlock(source);
    applyBlockRead(read);
    cacheCurrentBlockRead(read);
    state.previewRegions.focusedRegionId = checklistControlId(receipt.block.id, receipt.item, receipt.block.revision, result.occurrenceId);
    restoreChecklistFold(state.previewRegions, state.previewRegions.focusedRegionId, foldExpanded);
    state.status = `Step ${receipt.item.status} · Ctrl+Z undoes the last status change`;
  };

  const changeChecklist = async (control: ChecklistControl, choice: ChecklistChoice, generation: number): Promise<void> => {
    const hostId = state.context.selected?.id;
    if (!hostId) return;
    const foldExpanded = checklistFoldState(state.previewRegions, control);
    const result = await checklist.choose(control, choice, hostId);
    if (generation === openGeneration && result.link) effects.copyText(result.link);
    await showChecklistReceipt(result, generation, hostId, foldExpanded);
    if (generation === openGeneration && result.link) state.status = "Step link copied";
  };

  const dispatch = async (intent: DetailIntent, viewport: DetailViewport): Promise<void> => {
    completionViewport=viewport;
    const requestGeneration = ++openGeneration;
    switch (intent.type) {
      case "edit.begin":
        await beginEdit(viewport);
        break;
      case "edit.recover":
        await recoverWriting(viewport);
        break;
      case "edit.external":
        await editExternalDraft(viewport);
        break;
      case "annotation.selection.begin":
        if (state.mode === "preview" && viewport.preview && state.previewOffset >= viewport.preview.sourceLines.length) {
          state.status = "Scroll to source text before starting a selection";
        } else {
          await beginAnnotationSelection(intent.sourceLine, intent.sourceColumn);
        }
        break;
      case "annotation.comment.direct": {
        const property = state.propertyInspector.expanded
          ? findPropertyInspectorEntry(state.propertyInspector.model, state.previewRegions.focusedRegionId)
          : undefined;
        if (property?.target?.kind === "resource-reference" && state.mode === "preview") {
          await beginComment({ start: property.start, end: property.end });
        } else if (!intent.capture) {
          const control = findChecklistControl(state.previewRegions.regions, state.previewRegions.focusedRegionId ?? "");
          const selected = state.context.selected;
          if (control && !control.sourceBlock && (control.blockId !== selected?.id || control.revision !== selected.revision)) {
            state.status = "The checklist changed; focus the current step before commenting";
          } else await beginComment(control ? checklistCommentRange(control) : undefined, control?.sourceBlock);
        } else {
          await beginDirectComment(intent.capture);
        }
        break;
      }
      case "annotation.thread.move": {
        const threads = annotationGroups().flatMap(group => group.threads);
        if (threads.length === 0) { state.status = "No comment threads in this document"; break; }
        const current = threads.findIndex(thread => thread.block.id === selectedAnnotationThread(state)?.block.id);
        const next = current < 0 ? (intent.delta > 0 ? 0 : threads.length - 1)
          : (current + intent.delta + threads.length) % threads.length;
        selectAnnotationThread(threads[next]!.block.id, true, viewport);
        if (current >= 0 && (intent.delta > 0 ? next <= current : next >= current)) state.status += " · wrapped";
        break;
      }
      case "annotation.thread.select":
        selectAnnotationThread(intent.annotationId, true, viewport);
        break;
      case "annotation.thread.reply":
        if (intent.annotationId && !state.annotationThreads.some(thread => thread.block.id === intent.annotationId)) await loadAnnotations(loadGeneration, "current-turn");
        beginAnnotationReply(intent.annotationId);
        break;
      case "annotation.thread.lifecycle":
        if (intent.annotationId && !state.annotationThreads.some(thread => thread.block.id === intent.annotationId)) await loadAnnotations(loadGeneration, "current-turn");
        await changeAnnotationLifecycle(intent.annotationId);
        break;
      case "resource.refresh": {
        const description = detailResourceDescription(state);
        if (
          description?.resource.provider === "filesystem" &&
          description.resource.mediaType !== "application/pdf"
        ) {
          await loadCurrentTarget(true);
          state.status = "Filesystem Resource reopened from disk";
          break;
        }
        if (!description && state.target?.kind === "block" && (state.resourceProjections ?? []).length && effects.refreshProjections) {
          state.busy = true;
          try {
            await effects.refreshProjections(state.target.blockId);
            await loadCurrentTarget(true);
            state.status = "Refreshed this note's tickets and extension lines";
          } catch (error) {
            state.status = `Refresh failed · ${error instanceof Error ? error.message : String(error)}`;
          } finally {
            state.busy = false;
          }
          break;
        }
        if (
          !description ||
          (
            description.resource.provider !== "web" &&
            description.resource.provider !== "jira" &&
            description.resource.provider !== "linear" &&
            description.resource.provider !== "computed" &&
            !(description.resource.provider === "filesystem" &&
              description.resource.mediaType === "application/pdf")
          )
        ) {
          state.status = "Current target does not support refresh";
          break;
        }
        state.busy = true;
        try {
          const refreshed = await effects.refreshResource(description.resource.id);
          await loadCurrentTarget(true);
          if (refreshed.pdf) {
            state.status = refreshed.pdfError
              ? `PDF refresh failed · showing selected immutable content · ${refreshed.pdfError}`
              : "PDF resource refreshed";
            break;
          }
          if (refreshed.resource.provider === "computed") {
            state.status = refreshed.computedFailure
              ? `Computed execution failed · ${refreshed.computedFailure.message}`
              : refreshed.computed
              ? "Computed resource executed and cached"
              : "Computed producer executed";
            break;
          }
          if (
            refreshed.resource.provider === "jira" ||
            refreshed.resource.provider === "linear"
          ) {
            const provider = refreshed.resource.provider === "jira" ? "Jira" : "Linear";
            const freshness = refreshed.remoteStatus?.freshness ?? "unknown";
            if (freshness === "fresh") {
              state.status = `${provider} resource refreshed`;
            } else if (freshness === "stale") {
              state.status = "Refresh completed · selected local content remains stale";
            } else if (freshness === "unknown") {
              state.status = "Refresh completed · provider freshness remains unknown";
            } else if (freshness === "refreshing") {
              state.status = `${provider} resource refresh is still in progress`;
            } else {
              state.status = refreshed.remoteEntity
                ? `Refresh failed · showing selected immutable content · ${refreshed.remoteStatus?.lastError ?? refreshed.remoteError ?? "Unknown error"}`
                : `Refresh failed · no local snapshot · ${refreshed.remoteStatus?.lastError ?? refreshed.remoteError ?? "Unknown error"}`;
            }
            break;
          }
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
      case "resource.open-external": {
        const description = detailResourceDescription(state);
        const selected = description?.presentation?.selected;
        const capability = description?.presentation?.capabilities["open-external"];
        if (!selected?.externalUrl) {
          state.status = "Current target has no negotiated external URL";
          break;
        }
        if (capability?.status !== "available") {
          const unavailableFactor = RESOURCE_CAPABILITY_FACTORS
            .map((factor) => capability?.factors[factor])
            .find((assessment) =>
              assessment?.state === "blocked" || assessment?.state === "unknown"
            );
          state.status = unavailableFactor && "detail" in unavailableFactor
            ? unavailableFactor.detail
            : "Opening this resource externally is unavailable";
          break;
        }
        await effects.openExternal(selected.externalUrl);
        state.status = "Opened current resource externally";
        break;
      }
      case "resource.open-url":
        await effects.openExternal(intent.url);
        state.status = "Opened URL externally";
        break;
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
      case "navigation.link": {
        const destination = await effects.chooseDestination?.("link");
        if (destination !== undefined) {
          const label = await effects.setDestination?.(destination);
          state.status = destination ? `Open → ${sanitizeDynamicText(label || "selected Detail")} · Alt+L changes destination` : "Open unlinked · choose a destination or new split";
        }
        break;
      }
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
      case "mentions.open": {
        try {
          await effects.openVirtualBranchNavigator("recent-mentions", "mentions");
          state.status = "Opened recent agent mentions";
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
        if (intent.type !== "reference.open" && state.readStatus !== "ready") {
          state.status = "References are not ready · preview enrichment is incomplete";
          break;
        }
        const resourceEntries = state.propertyInspector.model?.entries.filter(entry =>
          entry.target?.kind === "resource-reference"
        ) ?? [];
        if (intent.type !== "reference.open" && resourceEntries.length > 1) {
          if (!state.propertyInspector.expanded) {
            await dispatch({ type: "property-inspector.disclosure.toggle" }, viewport);
          }
          state.propertyInspector.filter = "";
          state.propertyInspector.filterDraft = null;
          state.previewRegions.focusedRegionId = resourceEntries[0]!.occurrenceId;
          state.status = "Choose a reference in Properties · Tab selects · o opens · p closes";
          break;
        }
        const reference = intent.type === "reference.open"
          ? intent.target
          : state.context.selected && resourceEntries.length === 1
            ? resourceOccurrenceLink(state.context.selected, resourceEntries[0]!)
          : state.context.selected
            ? firstOutlinerReference(state.projectedSelectedText, state.workIdPrefix)
            : null;
        if (!reference) {
          state.status = "Selected block has no actionable references";
          break;
        }
        const navigationIntent: OutlinerNavigationIntent =
          intent.type === "reference.reveal" ||
            (intent.type === "reference.open" && intent.target.intent === "reveal")
            ? "reveal"
            : "open";
        const selected=state.context.selected;
        if(navigationIntent==="open"&&options.previewHere&&reference.kind==="reference"&&reference.occurrence&&selected&&
          reference.value===selected.id&&reference.occurrence.revision===selected.revision&&
          isAuthoredFileOccurrence(selected.text,reference.occurrence.start,reference.occurrence.end)){
          const documentGeneration=loadGeneration;
          const receipt=await effects.followResourceOccurrence(reference);
          if(documentGeneration!==loadGeneration||requestGeneration!==openGeneration)break;
          await options.previewHere({kind:"resource",resourceId:receipt.resource.id,referenceContext:receipt.referenceContext});
          state.status="File opened in Preview · Current note retained";
          break;
        }
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
            const documentGeneration=loadGeneration;
            if(intent.type === "reference.follow") {
              try { await effects.resolveNavigation("open"); }
              catch(error) {
                if(!missingNavigationDestination(error))throw error;
                if(documentGeneration===loadGeneration && requestGeneration===openGeneration)destinationChooser!.recover(target);
                break;
              }
            }
            if(documentGeneration===loadGeneration && requestGeneration===openGeneration)destinationChooser!.open(target);
          } else {
            const documentGeneration = loadGeneration;
            await resolveDestinationTarget(target, reference);
            if(documentGeneration!==loadGeneration || requestGeneration!==openGeneration)break;
            try { await openLinked(target, reference.preserveSource === true); }
            catch(error){
              if(!missingNavigationDestination(error))throw error;
              if(documentGeneration===loadGeneration && requestGeneration===openGeneration)destinationChooser!.recover(target);
            }
          }
          break;
        }
        if (reference.kind === "resource" || reference.kind === "reference") {
          const followed = reference.kind === "reference"
            ? await effects.followResourceOccurrence(reference) : null;
          await effects.dispatchNavigation(
            { kind: "resource", resourceId: followed?.resource.id ?? reference.value,
              ...(followed ? { referenceContext: followed.referenceContext } : {}),
            },
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
        await effects.openDetailPane(target, intent.direction, intent.targetPaneId);
        const title = state.resource
          ? resourceAddressLabel(state.resource.address)
          : (state.context.selected ? blockDisplayTitle(state.context.selected) : "target");
        state.status = intent.direction === "right"
          ? `Opened ${title} to the right`
          : `Opened ${title} below`;
        state.status += " · New Detail created; use Change to link it";
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
        if (region.activation?.type === "annotation.thread.select") {
          state.selectedAnnotationId = region.activation.annotationId;
        }
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
        if (region?.activation?.type === "annotation.thread.select") {
          state.selectedAnnotationId = region.activation.annotationId;
        }
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
      case "checklist.toggle": {
        const control = findChecklistControl(state.previewRegions.regions, state.previewRegions.focusedRegionId ?? "");
        if (!control || state.mode !== "preview" || state.busy) break;
        state.busy = true;
        try { await changeChecklist(control, control.item.status === "done" ? "todo" : "done", requestGeneration); }
        finally { state.busy = false; }
        break;
      }
      case "checklist.undo": {
        const blockId = state.context.selected?.id;
        if (!blockId || state.mode !== "preview" || state.busy) break;
        state.busy = true;
        try {
          const result = await checklist.undo(blockId);
          if (result) await showChecklistReceipt(result, requestGeneration, blockId);
          else state.status = "No checklist status change to undo in this note";
        } finally { state.busy = false; }
        break;
      }
      case "preview.action":
        switch (intent.action.type) {
          case "checklist.open": {
            const control = findChecklistControl(state.previewRegions.regions, intent.action.regionId);
            if (!control || state.mode !== "preview" || state.busy) break;
            state.previewRegions.focusedRegionId = control.id;
            state.busy = true;
            try {
              const choice = await effects.chooseChecklistAction?.();
              if (choice && requestGeneration === openGeneration && state.mode === "preview") {
                await changeChecklist(control, choice, requestGeneration);
              }
            } finally { state.busy = false; }
            break;
          }
          case "link.open": {
            const uri = intent.action.uri;
            if (uri.startsWith("http://") || uri.startsWith("https://")) {
              await dispatch({type:"resource.open-url",url:uri},viewport);
            } else {
              await dispatch({type:"reference.open",target:parseOutlinerLinkUri(uri),routing:intent.routing??"linked"},viewport);
            }
            break;
          }
          case "preview.region.focus":
            await dispatch({
              type: "preview.focus.set",
              regionId: intent.action.regionId,
            }, viewport);
            break;
          case "annotation.thread.select":
          case "annotation.thread.reply":
          case "annotation.thread.lifecycle":
          case "annotation.thread.move":
            await dispatch(intent.action, viewport);
            break;
          case "annotation.disclosure.toggle":
            state.previewRegions.focusedRegionId = intent.action.regionId;
            togglePreviewRegionDisclosure(state.previewRegions, intent.action.regionId);
            break;
          case "callout.disclosure.toggle":
          case "document.disclosure.toggle":
            state.previewRegions.focusedRegionId = intent.action.regionId;
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
          case "backlink.group.disclosure.toggle":
            state.previewRegions.focusedRegionId = backlinkGroupRegionId(intent.action.kind);
            await dispatch({ type: "backlinks.group.toggle", kind: intent.action.kind }, viewport);
            break;
          case "backlinks.control":
            await dispatch({ type: BACKLINK_CONTROL_INTENTS[intent.action.control] }, viewport);
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
          case "property-inspector.value.copy":
            await dispatch(intent.action, viewport);
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
        routineNotice(state.propertyInspector.expanded
          ? "Properties expanded"
          : "Properties collapsed");
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
      case "property-inspector.value.copy": {
        const occurrenceId = intent.occurrenceId ?? state.previewRegions.focusedRegionId;
        const entry = findPropertyInspectorEntry(state.propertyInspector.model, occurrenceId);
        if (!entry) {state.status = "Property occurrence is no longer available"; break;}
        state.previewRegions.focusedRegionId = occurrenceId ?? entry.occurrenceId;
        try {
          effects.copyText(entry.value);
          state.status = "Value sent to terminal clipboard";
        } catch (error) {
          state.status = `Copy failed: ${error instanceof Error ? error.message : String(error)}`;
        }
        break;
      }
      case "property-inspector.target.open": {
        const entry = findPropertyInspectorEntry(state.propertyInspector.model, intent.occurrenceId);
        if (!entry) {
          state.status = "Property occurrence is no longer available";
          break;
        }
        state.previewRegions.focusedRegionId = intent.occurrenceId;
        const uri = entry.valueParts.find(part => part.regionId === intent.occurrenceId && part.uri)?.uri;
        if (uri) {
          if (uri.startsWith("http://") || uri.startsWith("https://")) {
            await dispatch({type: "preview.action", action: {type: "link.open", uri}, routing: intent.routing}, viewport);
          } else {
            await dispatch({type: "reference.open", target: propertyInspectorTargetLink({kind: "link", uri, source: "value"}, {
              preserveSource: state.propertyInspector.presentation === "dedicated",
              ...(intent.intent === "reveal" ? {intent: "reveal" as const} : {})}),
              routing: intent.routing ?? "linked"}, viewport);
          }
          break;
        }
        if (!entry.target) {
          state.status = `${entry.key} has no navigation target`;
          break;
        }
        await dispatch({
          type: "reference.open",
          target: entry.target.kind === "resource-reference" && state.context.selected
            ? { ...resourceOccurrenceLink(state.context.selected, entry),
                preserveSource: state.propertyInspector.presentation === "dedicated",
                ...(intent.intent === "reveal" ? { intent: "reveal" as const } : {}),
              }
            : propertyInspectorTargetLink(entry.target, {
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
          routineNotice("Backlinks collapsed");
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
        const [field, direction] = nextBacklinkSort(
          state.backlinks.sortField,
          state.backlinks.sortDirection,
        );
        state.backlinks.sortField = field;
        state.backlinks.sortDirection = direction;
        state.backlinks.selectedIndex = 0;
        state.status = `Backlinks sorted by ${field} ${direction}`;
        break;
      }
      case "backlinks.kind.cycle": {
        const kinds = detailBacklinkView(state.backlinks).kinds;
        state.backlinks.kindFilter = nextBacklinkKindFilter(state.backlinks.kindFilter, kinds);
        state.backlinks.selectedIndex = 0;
        const label = kinds.find((kind) => kind.kind === state.backlinks.kindFilter)?.label;
        state.status = label ? `Backlinks: only ${label}` : "Backlinks: every kind";
        break;
      }
      case "backlinks.stage.cycle":
        state.backlinks.stageFilter = nextBacklinkStageFilter(state.backlinks.stageFilter);
        state.backlinks.selectedIndex = 0;
        state.status = state.backlinks.stageFilter === "all"
          ? "Backlinks: every stage"
          : `Backlinks: only ${state.backlinks.stageFilter}`;
        break;
      case "backlinks.resolved.toggle":
        state.backlinks.showResolved = !state.backlinks.showResolved;
        clampBacklinkSelection();
        state.status = state.backlinks.showResolved
          ? "Showing resolved comments"
          : "Hiding resolved comments";
        break;
      case "backlinks.related.toggle":
        state.backlinks.showRelated = !state.backlinks.showRelated;
        clampBacklinkSelection();
        state.status = state.backlinks.showRelated
          ? "Showing this note and its descendants"
          : "Hiding this note and its descendants";
        break;
      case "backlinks.group.toggle": {
        const focused = focusedPreviewRegion(state.previewRegions);
        const kind = intent.kind ?? (focused?.activation?.type === "backlink.group.disclosure.toggle"
          ? focused.activation.kind
          : selectedBacklinkSource()?.facets?.kind);
        if (!kind) {
          state.status = "No backlink group selected";
          break;
        }
        // A narrowing filter opens every group, so a fold would change nothing visible.
        if (backlinkNarrowingActive(state.backlinks)) {
          state.status = "Clear the filter to fold groups";
          break;
        }
        const selected = selectedBacklinkSource()?.blockId;
        if (state.backlinks.expandedKinds.has(kind)) state.backlinks.expandedKinds.delete(kind);
        else state.backlinks.expandedKinds.add(kind);
        const rows = visibleBacklinkSources(state.backlinks);
        const kept = rows.findIndex((source) => source.blockId === selected);
        state.backlinks.selectedIndex = kept >= 0 ? kept : Math.min(state.backlinks.selectedIndex, Math.max(0, rows.length - 1));
        break;
      }
      case "backlinks.source.toggle": {
        const focusedGroup = intent.blockId === undefined
          ? focusedPreviewRegion(state.previewRegions)
          : undefined;
        if (focusedGroup?.activation?.type === "backlink.group.disclosure.toggle") {
          await dispatch({ type: "backlinks.group.toggle", kind: focusedGroup.activation.kind }, viewport);
          break;
        }
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
          view: detailBacklinkViewOptions(state.backlinks),
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
        let annotation: AnnotationRecord;
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
        if (subject.kind === "block") {
          await loadBlock(subject.blockId, true);
        } else if (subject.kind === "resource") {
          const snapshot = target.representation.sourceSnapshot;
          await loadNavigationTarget({ kind: "resource", resourceId: subject.resourceId,
            ...(target.referenceContext && snapshot.kind === "resource" && snapshot.revision
              ? { revision: snapshot.revision } : {}),
            ...(target.referenceContext ? { referenceContext: target.referenceContext } : {}),
          }, true);
        } else {
          state.status = "Legacy file annotation is orphaned and cannot be revealed";
          break;
        }
        annotation = await effects.getAnnotation(annotationId);
        target = annotation.resolvedTarget;
        if (annotation.currentResolution.status === "resolved" && target?.anchor.kind === "list-item" &&
          target.representation.subject.kind === "block") {
          await loadBlock(target.representation.subject.blockId, true, false, target.anchor.itemId);
          state.mode = "preview";
          state.status = "Opened checklist step · original passage changed";
          break;
        }
        if (
          annotation.currentResolution.status !== "resolved" ||
          !target ||
          (target.anchor.kind !== "text-quote" &&
            target.anchor.kind !== "pdf-page-region")
        ) {
          state.status = `Annotation resolution is ${annotation.currentResolution.status}; no positioned text quote can be revealed`;
          break;
        }
        const anchor = target.anchor;
        if (anchor.start === null || anchor.end === null || anchor.exact === null) {
          state.status = `Annotation resolution is ${annotation.currentResolution.status}; no positioned text quote can be revealed`;
          break;
        }
        if (target.representation.subject.kind === "block") {
          if (target.representation.sourceSnapshot.kind === "rendered") {
            state.mode = "preview";
            state.status = "Opened source; captured pane quote is unpositioned";
            break;
          } else {
            await beginAnnotationSelection();
            if (target.representation.contentHash !== annotationSourceHash(state.buffer.text) ||
              state.buffer.text.slice(anchor.start, anchor.end) !== anchor.exact) {
              state.status = "Resolved text quote no longer matches the loaded block";
              break;
            }
            const start = detailBufferPointAtOffset(state.buffer.text, anchor.start);
            const end = detailBufferPointAtOffset(state.buffer.text, anchor.end);
            state.buffer.placeCursor(start.row, start.column);
            state.buffer.placeCursor(end.row, end.column, true);
            ensureEditorCursorVisible(viewport);
          }
        } else {
          const description = detailResourceDescription(state);
          const resourceText = displayedResourceText(state);
          const representation = description && resourceAnnotationRepresentation(description);
          if (!resourceText || anchor.start === null || anchor.end === null ||
            representation?.contentHash !== target.representation.contentHash ||
            target.representation.subject.kind !== "resource" ||
            description?.resource.id !== target.representation.subject.resourceId ||
            resourceText.slice(anchor.start, anchor.end) !== anchor.exact) {
            state.status = "Resolved text quote is not displayed in this Resource view";
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
      case "buffer.redo": {
        state.completion = null;
        const before = state.buffer.text;
        const undo = intent.type === "buffer.undo";
        const changed = undo ? state.buffer.undo() : state.buffer.redo();
        state.status = changed ? (undo ? "Undo" : "Redo") : (undo ? "Nothing to undo" : "Nothing to redo");
        if (changed && mechanicalAcceptance?.buffer === state.buffer) {
          if (state.buffer.text === mechanicalAcceptance.text) mechanicalAcceptance.undone = false;
          else if (undo && before === mechanicalAcceptance.text) mechanicalAcceptance.undone = true;
          if (mechanicalAcceptance.undone) state.recoveryAccepted = false;
          else if (state.recovery === mechanicalAcceptance.recovery) state.recoveryAccepted = true;
        }
        ensureEditorCursorVisible(viewport);
        break;
      }
      case "buffer.save":
        await saveBuffer(viewport);
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
        completions.move(intent.delta);
        break;
      case "completion.choose":
        await completions.accept(intent.index,intent.generation);
        ensureEditorCursorVisible(viewport);
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
        completions.dismiss();
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
          if (await loadFile(state.context.selected)) state.mode = "file";
        }
        break;
      case "view.block":
        fileReadGeneration += 1;
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
    if (["buffer.insert","buffer.backspace","buffer.delete","buffer.newline","buffer.move","editor.cursor.place"].includes(intent.type)) void completions.refresh();
    else if (["buffer.undo","buffer.redo","buffer.cancel","buffer.save"].includes(intent.type)) completions.dismiss();
    emit();
  };

  async function handleUiCommand(command: OutlinerUiCommand, viewport: DetailViewport): Promise<void> {
    if (command.command === "focus" && !command.target) { effects.focusSelf(); emit(); return; }
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
        // Peek walks every matching source; open the group of one that was folded away.
        const kind = state.backlinks.collection?.sources
          .find((source) => source.blockId === command.sourceBlockId)?.facets?.kind;
        if (kind) state.backlinks.expandedKinds.add(kind);
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
    if (protection() && "target" in command && command.target) {
      state.status = "Open rejected · finish or cancel the active edit or source selection";
      emit();
      return;
    }
    if (isBufferMode()) {
      state.refreshPending = true;
      return;
    }
    let navigationOutcome: DetailLoadOutcome | null = null;
    if ("target" in command && command.target) {
      navigationOutcome = await applyNavigationCommand(command);
      if (navigationOutcome === "superseded") return;
    }
    if (command.command === "edit") await beginEdit(viewport);
    // `focus: false` navigates a Detail without taking focus from its sender.
    const keepsFocus = "focus" in command && command.focus === false;
    if (command.command !== "preview" && !keepsFocus) effects.focusSelf();
    if (navigationOutcome !== "cached" || command.command === "edit") emit();
    return;
  }

  return {
    get state() {
      return state;
    },
    async initialize() {
      if (options.initialTarget) {
        await loadNavigationTarget(options.initialTarget, true, true);
      } else {
        await loadBrowsingContext(true);
      }
    },
    isBufferMode,
    checkpointRecovery() {
      if (state.mode === "edit" && state.recovery && state.context.selected) effects.recovery?.checkpoint?.(recoveryInput());
    },
    handleUiCommand,
    dispatch,
    captureResourceSelection,
    setPreviewRegions(regions, viewport) {
      reconcilePreviewRegions(state.previewRegions, regions, state.document.kind === 'loading' || (state.document.kind === 'ready' && state.readStatus === 'pending'));
      if (viewport?.preview?.regionRows) {
        const focused = state.previewRegions.focusedRegionId;
        const key = `${focused}:${viewport.width}:${viewport.previewBodyHeight}`;
        if (state.previewSourceLine !== undefined && viewport.preview.sourceLineRow) {
          state.previewOffset = viewport.preview.sourceLineRow(state.previewSourceLine);
          state.previewSourceLine = undefined;
          measuredPreviewFocus = key;
        } else if (key !== measuredPreviewFocus) {
          const row = viewport.preview.regionRows.get(focused ?? "");
          const height = viewport.previewBodyHeight ?? Math.max(1, viewport.height - 5);
          if (row !== undefined && (row < state.previewOffset || row >= state.previewOffset + height)) {
            state.previewOffset = Math.max(0, row - Math.floor(height / 2));
          }
          measuredPreviewFocus = key;
        }
      }
    },
    releaseDocument() {
      openGeneration++;destinationChooser!.dispose();
      loadGeneration += 1;
      clearDocumentPresentation();
      state.document = {kind: "empty"};
      navigationHistory.length = 0;
      navigationIndex = -1;
      blockCache.clear();
      syncNavigationState();
      emit();
    },
    supersedePassivePreview() {
      loadGeneration += 1;
    },
    handleDestinationChooserKeypress(str, key) {
      if(key.name==="escape")openGeneration++;
      return destinationChooser!.handleKeypress(str, key);
    },
    destinationChooserHelpText() {
      return destinationChooser!.helpText();
    },
    async onServiceEvent(event, viewport) {
      if (event.domain === "mentions") return;
      // Destination headers consume these independently; no document changed.
      if (event.domain === "view" && ["clients.update", "clients.unregister", "navigation.link.set"].includes(event.action)) return;
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
            state.previewSourceLine = state.attentionRevealSourceLine;
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
        if (event.command?.targetClientId === effects.clientId) await handleUiCommand(event.command, viewport);
        return;
      }
      if (event.domain === "content" && event.action.startsWith("annotations.") &&
        state.target?.kind === "resource") {
        // Annotation writes do not change Resource bytes. Reloading the Resource
        // here discards its scroll, disclosures and the selected thread.
        await loadAnnotations();
        return;
      }
      if (event.domain === "resource-catalog") {
        const description = detailResourceDescription(state);
        const unscopedResourceChange =
          event.resourceId === undefined && event.sourceId === undefined;
        const matchesTarget = state.target?.kind === "resource" &&
          (unscopedResourceChange || event.resourceId === state.target.resourceId);
        const matchesDescription = description !== null &&
          (
            unscopedResourceChange ||
            event.resourceId === description.resource.id ||
            event.sourceId === description.source.id
          );
        // A registration, refresh or new Source can change what a resource
        // projection shows: its own Resource or Source, or, while it has no
        // Resource (not registered, no key, ambiguous), any catalog change.
        const matchesProjection = state.target?.kind === "block" && (state.resourceProjections ?? []).some(projection =>
          unscopedResourceChange || projection.resourceId === undefined ||
          event.resourceId === projection.resourceId || event.sourceId === projection.sourceId);
        if (!matchesTarget && !matchesDescription && !matchesProjection) return;
      } else if (event.domain === "content") {
        markBlockCacheStale();
        invalidateBacklinks();
      }
      if (event.domain === "selection" || event.domain === "browsing-context" || event.domain === "inbox") return;
      if (isBufferMode()) {
        state.refreshPending = true;
        return;
      }
      await loadCurrentTarget(true);
      emit();
    },
    async onServiceConnect() {
      markBlockCacheStale();
      serviceConnected = true;
      state.disconnected = false;
      lastProtection = protection();
      await effects.setNavigationProtection?.(lastProtection);
      await effects.setCurrentTarget(state.target);
      state.attention = await effects.getAttention();
      state.status = "";
      if (isBufferMode()) state.refreshPending = true;
      else await loadCurrentTarget(true);
      emit();
    },
    onServiceDisconnect() {
      markBlockCacheStale();
      serviceConnected = false;
      state.disconnected = true; clearTimeout(noticeTimer);
      state.status = "Workspace service disconnected; reconnecting…";
      emit();
    },
    onServiceError(error) {
      clearTimeout(noticeTimer);
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
