import type {
  CreateResourceSourceInput,
  InternFilesystemResourceInput,
  InternResourceInput,
  RelocateResourceInput,
  ResourceRevisionRef,
} from "./resources";

export type {
  CapabilityAssessment,
  InternFilesystemResourceInput,
  InternResourceReceipt,
  Resource,
  ResourceAddress,
  ResourceCapability,
  ResourceCapabilityDecision,
  ResourceCapabilityReport,
  ResourceDescription,
  ResourceFreshness,
  ResourcePolicy,
  ResourceProvider,
  ResourceRevision,
  ResourceRevisionRef,
  ResourceSource,
  WebRepresentationAdapter,
  WebRepresentationProvenance,
  WebResourceDocument,
  WebResourceProvenance,
  WebResourceStatus,
  WebSourceSnapshotProvenance,
} from "./resources";

export type BlockAuthor = "user" | "agent" | "system";

export interface BlockProvenance {
  actorId: string;
  sessionId?: string;
  taskId?: string;
}

export interface MutationProvenance {
  author: BlockAuthor;
  actorId?: string;
  sessionId?: string;
  taskId?: string;
}

export interface BlockEditActivity {
  cursor: number;
  block: Block;
  author: BlockAuthor;
  actorId?: string;
  sessionId?: string;
  taskId?: string;
  kind: "text" | "properties";
  editedAt: string;
}

export interface BlockEditActivityPage {
  entries: BlockEditActivity[];
  cursor: number;
}

export interface BlockProperty {
  key: string;
  value: string;
}

export type PropertyPlacement = "inline" | "trailing-metadata" | "metadata-line";
export type PropertyScope = "block" | "line" | "inline";
export type PropertyQueryScope = PropertyScope | "all";
export type PropertySyntax = "bracket" | "bare";

export interface PropertyRecord extends BlockProperty {
  ordinal: number;
  raw: string;
  start: number;
  end: number;
  line: number;
  column: number;
  placement: PropertyPlacement;
  scope: PropertyScope;
  syntax: PropertySyntax;
}

export interface PropertyMatchContext extends BlockProperty {
  ordinal: number;
  start: number;
  end: number;
  line: number;
  column: number;
  scope: PropertyScope;
}

export type PropertyPatchOperation =
  | { op: "replace"; ordinal: number; key?: string; value: string }
  | { op: "remove"; ordinal: number }
  | { op: "append"; key: string; value: string };

export interface PropertyCatalogItem {
  key: string;
  value: string;
  count: number;
}

export interface Block {
  id: string;
  parentId: string | null;
  position: number;
  text: string;
  author: BlockAuthor;
  actorId?: string;
  sessionId?: string;
  taskId?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  effectiveDeletedRootId?: string;
  properties: BlockProperty[];
}

export type CaptureSource = "tree" | "pi" | "omp" | "cli" | "external";

export interface CaptureReceipt {
  block: Block;
  inboxBlockId: string;
  deduplicated: boolean;
}

export interface QuickCaptureDraft {
  requestId: string;
  text: string;
  cursorRow: number;
  cursorColumn: number;
  capturedFromBlockId?: string;
  revision: number;
  updatedAt: string;
}

export interface QuickCaptureDraftSaveInput {
  requestId: string;
  text: string;
  cursorRow: number;
  cursorColumn: number;
  capturedFromBlockId?: string;
  expectedRevision: number | null;
}

export interface BookmarkStatus {
  root: Block;
  targetBlockId: string;
  record: Block | null;
}

export type BookmarkResolution =
  | {
    record: Block;
    target: Block;
  }
  | {
    record: Block;
    target: null;
    unavailableReason: string;
  };

export interface BookmarkToggleReceipt {
  root: Block;
  target: Block;
  record: Block;
  bookmarked: boolean;
}

export interface BookmarkRemoveReceipt {
  record: Block;
  targetBlockId: string;
}

export type AnnotationSource = "user" | "agent";
export type AnnotationLifecycle = "open" | "resolved";

export interface AnnotationAdapter {
  readonly id: string;
  readonly version: number;
}

export type AnnotationSubject =
  | { readonly kind: "block"; readonly blockId: string }
  | { readonly kind: "resource"; readonly resourceId: string }
  | {
      readonly kind: "legacy-file";
      readonly sourceBlockId: string;
      readonly filePath: string;
    };

export type RenderedPassageProjection = "canonical" | "resolved" | "generated" | "mixed";

export interface RenderedSelectionEvidence {
  readonly quote: string;
  readonly capturedAt: string;
  readonly hostBlockId: string;
  readonly paneId: string;
  readonly contentRevision: number;
  readonly contextId: string;
  readonly detailClientId: string;
  readonly validation: "herdr-keybinding";
}

export interface RenderedSelectionCapture extends RenderedSelectionEvidence {
  readonly snapshotText: string;
}

export interface RenderedPassageObservation extends RenderedSelectionEvidence {
  readonly projection: RenderedPassageProjection;
}

export type AnnotationSourceSnapshot =
  | {
      readonly kind: "block";
      readonly blockId: string;
      readonly updatedAt: string;
      readonly contentHash: string;
    }
  | {
      readonly kind: "resource";
      readonly resourceId: string;
      readonly sourceSnapshotId: string | null;
      readonly revision: ResourceRevisionRef | null;
    }
  | {
      readonly kind: "rendered";
      readonly observation: RenderedPassageObservation;
    }
  | {
      readonly kind: "unknown";
      readonly reason: string;
    };

export interface AnnotationRepresentation {
  readonly id: string;
  readonly subject: AnnotationSubject;
  readonly sourceSnapshot: AnnotationSourceSnapshot;
  readonly adapter: AnnotationAdapter | null;
  readonly mediaType: string | null;
  readonly contentHash: string | null;
  readonly capturedAt: string;
  readonly observation?: RenderedPassageObservation;
}

export type AnnotationAnchor =
  | {
      readonly kind: "text-quote";
      readonly start: number | null;
      readonly end: number | null;
      readonly exact: string;
      readonly prefix: string;
      readonly suffix: string;
    }
  | {
      readonly kind: "dom-range";
      readonly start: {
        readonly selector: string;
        readonly textNode: number;
        readonly offset: number;
      };
      readonly end: {
        readonly selector: string;
        readonly textNode: number;
        readonly offset: number;
      };
      readonly exact: string;
    }
  | {
      readonly kind: "pdf-page-region";
      readonly page: number;
      readonly regions: readonly {
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
      }[];
      readonly exact: string | null;
    }
  | {
      readonly kind: "structured-entity-field";
      readonly entityType: string;
      readonly entityId: string;
      readonly fieldPath: readonly string[];
      readonly valueHash: string;
    }
  | {
      readonly kind: "provider-comment-id";
      readonly provider: string;
      readonly commentId: string;
    };

export interface AnnotationTarget {
  readonly representation: AnnotationRepresentation;
  readonly anchor: AnnotationAnchor;
}

export type AnnotationResolutionStatus =
  | "resolved"
  | "probable"
  | "unresolved"
  | "ambiguous"
  | "orphaned"
  | "unsupported"
  | "rejected";

export type AnnotationResolutionMethod =
  | {
      readonly kind: "codec";
      readonly codecId: string;
      readonly codecVersion: number;
      readonly method: string;
    }
  | {
      readonly kind: "human";
      readonly method: string;
    };

export interface AnnotationResolutionCandidate {
  readonly target: AnnotationTarget;
  readonly method: AnnotationResolutionMethod;
  readonly confidence: number;
}

export type AnnotationResolutionReviewer =
  | { readonly kind: "system"; readonly id: string }
  | { readonly kind: "user"; readonly id: string }
  | { readonly kind: "agent"; readonly id: string };

export interface AnnotationResolutionEvent {
  readonly id: string;
  readonly annotationId: string;
  readonly sequence: number;
  readonly sourceRepresentation: AnnotationRepresentation;
  readonly targetRepresentation: AnnotationRepresentation;
  readonly resolvedTarget: AnnotationTarget | null;
  readonly method: AnnotationResolutionMethod;
  readonly reviewer: AnnotationResolutionReviewer;
  readonly confidence: number | null;
  readonly candidates: readonly AnnotationResolutionCandidate[];
  readonly status: AnnotationResolutionStatus;
  readonly appliesCurrent: boolean;
  readonly createdAt: string;
}

export interface AnnotationCreateInput {
  readonly target: AnnotationTarget;
  readonly body: string;
  readonly source: AnnotationSource;
}

export interface AnnotationReplyInput {
  readonly annotationId: string;
  readonly body: string;
  readonly source: AnnotationSource;
}

export type AnnotationBatchOperation =
  | { readonly operationId: string; readonly type: "create"; readonly input: AnnotationCreateInput }
  | { readonly operationId: string; readonly type: "reply"; readonly input: AnnotationReplyInput };

export interface AnnotationRecord {
  readonly block: Block;
  readonly originalTarget: AnnotationTarget;
  readonly resolvedTarget: AnnotationTarget | null;
  readonly currentResolution: AnnotationResolutionEvent;
  readonly resolutionHistory: readonly AnnotationResolutionEvent[];
  readonly body: string;
  readonly source: AnnotationSource;
  readonly lifecycle: AnnotationLifecycle;
  readonly promotedBlockIds?: readonly string[];
  readonly parentAnnotationId?: string;
}

export interface AnnotationThread extends AnnotationRecord {
  readonly replies: AnnotationRecord[];
}

export interface AnnotationBatchReceipt {
  readonly annotations: AnnotationRecord[];
  readonly deduplicated: boolean;
}

export interface AnnotationListQuery {
  readonly subject: Exclude<AnnotationSubject, { readonly kind: "legacy-file" }>;
  readonly lifecycle?: AnnotationLifecycle;
  readonly includeResolved?: boolean;
}

export interface AnnotationReconcileInput {
  readonly subject: Exclude<AnnotationSubject, { readonly kind: "legacy-file" }>;
  readonly newRepresentation: AnnotationRepresentation;
  readonly content?: string;
}

export interface AnnotationReconcileReceipt {
  readonly threads: AnnotationThread[];
  readonly changed: boolean;
}

export interface AnnotationApproveResolutionInput {
  readonly annotationId: string;
  readonly target: AnnotationTarget;
}

export interface AnnotationLifecycleInput {
  readonly annotationId: string;
  readonly lifecycle: AnnotationLifecycle;
  readonly promotedBlockId?: string;
}


export type AttentionTone = "current" | "info" | "warning" | "error" | "match" | "dim";
export type AttentionRole = "current" | "supporting";
export type AttentionSourceState = "active" | "stale";
export interface AttentionTextAnchor {
  readonly start: number;
  readonly end: number;
  readonly excerpt: string;
  readonly contextBefore: string;
  readonly contextAfter: string;
  readonly sourceVersion: string;
  readonly sourceHash: string;
}

export type AttentionTargetInput =
  | {
      kind: "block";
      sourceBlockId: string;
      fragmentId?: string;
      sourceVersion?: string;
      sourceHash?: string;
      anchor?: AttentionTextAnchor;
    }
  | {
      kind: "file";
      sourceBlockId: string;
      filePath: string;
      startLine: number;
      endLine: number;
      anchor: AttentionTextAnchor;
    };

export type AttentionTarget =
  | {
      kind: "block";
      sourceBlockId: string;
      fragmentId?: string;
      sourceVersion: string;
      sourceHash: string;
      anchor?: AttentionTextAnchor;
    }
  | {
      kind: "file";
      sourceBlockId: string;
      filePath: string;
      startLine: number;
      endLine: number;
      anchor: AttentionTextAnchor;
    };

export interface AttentionMarkInput {
  markId: string;
  targetClientId: string;
  target: AttentionTargetInput;
  tone: AttentionTone;
  role?: AttentionRole;
  sender: string;
  expiresInMs?: number;
  reveal?: boolean;
  focus?: boolean;
}

export interface AttentionMark {
  markId: string;
  targetClientId: string;
  target: AttentionTarget;
  tone: AttentionTone;
  role: AttentionRole;
  sender: string;
  createdAt: string;
  expiresAt: string;
  acknowledgedAt?: string;
  returnCuePending: boolean;
  sourceState: AttentionSourceState;
}

export interface AttentionClientState {
  targetClientId: string;
  marks: AttentionMark[];
  currentMarkId?: string;
  pendingCount: number;
  summary: string;
  updatedAt: string;
}

export interface AttentionClearInput {
  targetClientId: string;
  markId?: string;
}

export interface AttentionAcknowledgeInput extends AttentionClearInput {}

export interface AttentionInstruction {
  markId: string;
  reveal: boolean;
  focus: boolean;
}

export type WorkflowActionId = "walkthrough.plan";
export type WorkflowPlanner = "pi-direct" | "callscript";
export type WorkflowStatus =
  | "planning"
  | "ready"
  | "active"
  | "paused"
  | "completed"
  | "cancelled"
  | "failed";
export type WorkflowCapability =
  | "outline.structure"
  | "outline.route"
  | "attention.mark"
  | "annotations.create"
  | "annotations.reply"
  | "annotations.batch"
  | "promotion.preview"
  | "promotion.commit";

export type WorkflowInvocation =
  | { kind: "block"; sourceBlockId: string }
  | { kind: "callout"; sourceBlockId: string; calloutType: string; calloutIndex?: number }
  | { kind: "query"; query: BlockSearchQuery }
  | { kind: "command"; command: string; sourceBlockId?: string };

export interface WorkflowLimits {
  fanOut: number;
  calls: number;
}

export interface WorkflowStartInput {
  requestId: string;
  actionId: WorkflowActionId;
  invocation: WorkflowInvocation;
  capabilities: WorkflowCapability[];
  limits: WorkflowLimits;
  planner: WorkflowPlanner;
  targetClientId?: string;
  provenance?: BlockProvenance;
}

export interface WorkflowStructureRegion {
  regionId: string;
  title: string;
  target: AttentionTargetInput;
  sourceBytes: number;
}

export interface WorkflowStructureItem {
  blockId: string;
  title: string;
  updatedAt: string;
  depth: number;
  properties: BlockProperty[];
  regions: WorkflowStructureRegion[];
  sourceBytes: number;
}

export interface WorkflowStructure {
  invocation: WorkflowInvocation;
  items: WorkflowStructureItem[];
  completeness: BlockCollectionCompleteness;
  contextBytes: number;
}

export interface WorkflowStep {
  stepId: string;
  ordinal: number;
  title: string;
  target: AttentionTargetInput;
  sourceRevision: string;
  status: "pending" | "current" | "visited" | "skipped";
}

export interface WorkflowMetrics {
  planner: WorkflowPlanner;
  modelTurns: number;
  operations: number;
  contextBytes: number;
  wallTimeMs: number;
  completeness: BlockCollectionCompleteness;
  artifactQuality: "unrated" | "usable" | "needs-revision";
  structureFirst: boolean;
}

export interface WorkflowComparison {
  direct: WorkflowMetrics;
  callscript: WorkflowMetrics;
  contextBytesSaved: number;
  operationDelta: number;
}

export interface WorkflowBranchQuestion {
  stepId: string;
  question: string;
  createdAt: string;
}

export interface WorkflowRun {
  runId: string;
  requestId: string;
  actionId: WorkflowActionId;
  invocation: WorkflowInvocation;
  capabilities: WorkflowCapability[];
  limits: WorkflowLimits;
  planner: WorkflowPlanner;
  targetClientId?: string;
  provenance?: BlockProvenance;
  status: WorkflowStatus;
  route: WorkflowStep[];
  currentStepIndex: number | null;
  branchQuestion?: WorkflowBranchQuestion;
  metrics?: WorkflowMetrics;
  comparison?: WorkflowComparison;
  resultBlockIds: string[];
  cancellationRequested: boolean;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowStartReceipt {
  run: WorkflowRun;
  deduplicated: boolean;
}

export interface WorkflowPlanInput {
  runId: string;
  route: WorkflowStep[];
  metrics: WorkflowMetrics;
  comparison?: WorkflowComparison;
}

export type WorkflowTransitionAction =
  | "next"
  | "previous"
  | "pause"
  | "resume"
  | "skip"
  | "branch"
  | "end";

export interface WorkflowTransitionInput {
  runId: string;
  action: WorkflowTransitionAction;
  question?: string;
  targetClientId?: string;
  focus?: boolean;
}

export type WorkflowPromotionKind = "decision" | "follow-up" | "task" | "artifact";

export interface WorkflowPromotionInput {
  runId: string;
  stepId: string;
  annotationId: string;
  kind: WorkflowPromotionKind;
  title: string;
  approvedBy: string;
  body?: string;
  parentId?: string | null;
}

export interface WorkflowPromotionPreview {
  input: WorkflowPromotionInput;
  text: string;
  approvalToken: string;
}

export interface WorkflowPromotionCommitInput {
  requestId: string;
  approvalToken: string;
  input: WorkflowPromotionInput;
}

export interface WorkflowPromotionReceipt {
  run: WorkflowRun;
  block: Block;
  deduplicated: boolean;
}

export type DeliveryStage = "work" | "review" | "validate" | "complete";

export interface DeliveryEnsureInput {
  taskBlockId: string;
  deliveryKey: string;
  repository: string;
  baseBranch: string;
  workBranch: string;
}

export interface DeliveryReceipt {
  task: Block;
  delivery: Block;
  created: boolean;
}

export type OutlinerClientRole = "tree" | "detail";

export interface BlockTarget {
  kind: "block";
  blockId: string;
  fragmentId?: string;
}

export interface ResourceTarget {
  kind: "resource";
  resourceId: string;
  revision?: ResourceRevisionRef;
}

export type OutlinerNavigationIntent = "preview" | "open" | "reveal";

export type OutlinerNavigationTarget = BlockTarget | ResourceTarget;
export interface OutlinerClientRuntime {
  paneId?: string;
  terminalId?: string;
  workspaceId?: string;
  tabId?: string;
  paneX?: number;
  paneY?: number;
  focused?: boolean;
  visible?: boolean;
}

export interface OutlinerClientRegistration {
  clientId: string;
  role: OutlinerClientRole;
  contextId: string;
  locked?: boolean;
  currentTarget?: OutlinerNavigationTarget;
  runtime?: OutlinerClientRuntime;
}

export type PageAddressKind = "page" | "alias" | "work-id";

export interface PageAddressRecord {
  address: string;
  normalizedAddress: string;
  blockId: string;
  kind: PageAddressKind;
}

export interface PageAddressRemoval {
  removed: PageAddressRecord;
  block: Block;
}

export interface PageAddressResolution {
  address: string;
  normalizedAddress: string;
  status: "resolved" | "deleted" | "missing";
  registeredAddress?: string;
  kind?: PageAddressKind;
  block?: Block;
  deletionRootId?: string;
}

export interface PageAddressFollowResult extends PageAddressResolution {
  created: boolean;
}

export interface PageAddressMatch extends PageAddressRecord {
  title: string;
}

export interface PageAddressCollection {
  addresses: PageAddressMatch[];
  completeness: BlockCollectionCompleteness;
}

export interface WorkIdAllocatorStatus {
  prefix: string | null;
  nextNumber: number | null;
  nextWorkId: string | null;
  reservedCount: number;
  observedPrefixes: string[];
}

export interface WorkIdAllocation {
  workId: string;
  block: Block;
}

export type RoadmapItemPriority = "high" | "medium" | "low";

export type RoadmapWorkStage =
  | "unprioritized"
  | "next"
  | "doing"
  | "review"
  | "validate"
  | "later"
  | "done";

export interface RoadmapItemCreateInput {
  title: string;
  body?: string;
  priority: RoadmapItemPriority;
  workStage?: Exclude<RoadmapWorkStage, "done">;
  project: string;
  arc: string;
  tracks: string[];
  dependsOn?: string[];
  relatedTo?: string[];
  sourceBlockId?: string;
}

export interface RoadmapBranchMembership {
  viewId: string;
  title: string;
  rank?: number;
}

export interface RoadmapItemCreateReceipt {
  workId: string;
  workQueueId: string;
  block: Block;
  memberships: RoadmapBranchMembership[];
}

export interface PropertyFilter {
  key: string;
  value?: string;
}

export type BlockQuerySortField = "created" | "updated";
export type BlockQuerySortDirection = "asc" | "desc";

export interface BlockQuerySort {
  field: BlockQuerySortField;
  direction: BlockQuerySortDirection;
}


export interface BlockTraversalOptions {
  filters?: PropertyFilter[];
  subtreeRootId?: string;
  propertyScope?: PropertyQueryScope;
}

export interface BlockSearchQuery {
  filters?: PropertyFilter[];
  text?: string;
  subtreeRootId?: string;
  rankViewId?: string;
  includeDeleted?: "roots" | "all";
  propertyScope?: PropertyQueryScope;
  sort?: BlockQuerySort;
  limit: number;
}

export type BlockCollectionCompleteness =
  | { kind: "complete" }
  | { kind: "truncated"; limit: number };

export interface VisibleBlock extends Block {
  depth: number;
  deletedDescendantCount?: number;
  hasChildren: boolean;
  displayText: string;
  propertyMatches?: PropertyMatchContext[];
}

export interface VisibleBlockCollection {
  blocks: VisibleBlock[];
  completeness: BlockCollectionCompleteness;
}

export type BacklinkReferenceKind = "block" | "page" | "work-id" | "property";

interface BacklinkOccurrenceBase {
  label: string;
  snippet: string;
  start: number;
  end: number;
}

export type BacklinkOccurrence =
  | (BacklinkOccurrenceBase & {
      kind: "block" | "page" | "work-id";
    })
  | (BacklinkOccurrenceBase & {
      kind: "property";
      propertyKey: string;
    });

export type BacklinkReferenceGroup =
  | {
      kind: "block" | "page" | "work-id";
      count: number;
    }
  | {
      kind: "property";
      propertyKey: string;
      count: number;
    };

export interface BacklinkSource {
  blockId: string;
  title: string;
  parentContext: string;
  createdAt: string;
  updatedAt: string;
  occurrenceCount: number;
  referenceGroups: BacklinkReferenceGroup[];
  occurrences: BacklinkOccurrence[];
  occurrencesTruncated: boolean;
  deletedRootId?: string;
}

export interface BacklinkQuery {
  targetBlockId: string;
  includeDeleted?: boolean;
  limit: number;
}

export interface BacklinkCollection {
  targetBlockId: string;
  targetDeletedRootId?: string;
  sources: BacklinkSource[];
  completeness: BlockCollectionCompleteness;
}

export interface VirtualOccurrenceRank {
  viewId: string;
  blockId: string;
  rank: number;
}

export interface BlockReferenceResolution {
  blockId: string;
  fragmentId?: string;
  label?: string;
  status: "resolved" | "deleted" | "missing" | "stale" | "duplicate";
  title?: string;
  deletionRootId?: string;
}

export interface ResolvedBlockReferences {
  text: string;
  references: BlockReferenceResolution[];
  workIdPrefix?: string;
}

export const OUTLINER_PROTOCOL_VERSION = 42;


export interface OutlinerServiceStatus {
  status: "ready";
  protocolVersion: typeof OUTLINER_PROTOCOL_VERSION;
}

export type OutlinerRequest =
  | { id: string; action: "ping" }
  | { id: string; action: "blocks.query"; query: BlockSearchQuery }
  | { id: string; action: "get"; blockId: string }
  | { id: string; action: "children"; parentId: string | null }
  | { id: string; action: "workspace.snapshot"; view?: WorkspaceSnapshotView }
  | { id: string; action: "events.subscribe"; client: OutlinerClientRegistration }
  | { id: string; action: "clients.list"; role?: OutlinerClientRole }
  | {
      id: string;
      action: "clients.update";
      clientId: string;
      locked?: boolean;
      currentTarget?: OutlinerNavigationTarget | null;
    }
  | { id: string; action: "resource-sources.create"; input: CreateResourceSourceInput }
  | { id: string; action: "resource-sources.list" }
  | { id: string; action: "resource-sources.get"; sourceId: string }
  | { id: string; action: "resources.intern"; input: InternResourceInput }
  | { id: string; action: "resources.intern-filesystem"; input: InternFilesystemResourceInput }
  | { id: string; action: "resources.get"; resourceId: string }
  | { id: string; action: "resources.relocate"; input: RelocateResourceInput }
  | {
      id: string;
      action: "resources.describe";
      target: ResourceTarget;
      destinationClientId: string;
    }
  | {
      id: string;
      action: "resources.open";
      target: ResourceTarget;
      destinationClientId: string;
    }
  | {
      id: string;
      action: "resources.refresh";
      resourceId: string;
      destinationClientId: string;
    }
  | { id: string; action: "attention.get"; targetClientId: string }
  | { id: string; action: "attention.mark"; input: AttentionMarkInput }
  | { id: string; action: "attention.advance"; input: AttentionMarkInput }
  | { id: string; action: "attention.clear"; input: AttentionClearInput }
  | { id: string; action: "attention.acknowledge"; input: AttentionAcknowledgeInput }
  | { id: string; action: "workflows.start"; input: WorkflowStartInput }
  | { id: string; action: "workflows.get"; runId: string }
  | { id: string; action: "workflows.list"; limit?: number }
  | { id: string; action: "workflows.structure"; runId: string }
  | { id: string; action: "workflows.plan"; input: WorkflowPlanInput }
  | { id: string; action: "workflows.transition"; input: WorkflowTransitionInput }
  | { id: string; action: "workflows.cancel"; runId: string }
  | { id: string; action: "workflows.promotion.preview"; input: WorkflowPromotionInput }
  | {
      id: string;
      action: "workflows.promotion.commit";
      input: WorkflowPromotionCommitInput;
      author?: BlockAuthor;
      provenance?: BlockProvenance;
    }
  | { id: string; action: "ui.command.send"; command: OutlinerUiCommand }
  | { id: string; action: "blocks.context"; blockId: string }
  | { id: string; action: "browsing-context.get"; contextId: string }
  | {
      id: string;
      action: "browsing-context.publish";
      sourceClientId: string;
      contextId: string;
      target: OutlinerNavigationTarget | null;
      dispatchPreview?: boolean;
    }
  | {
      id: string;
      action: "navigation.resolve";
      sourceClientId: string;
      intent: OutlinerNavigationIntent;
      preserveSource?: boolean;
    }
  | {
      id: string;
      action: "navigation.dispatch";
      sourceClientId: string;
      target: OutlinerNavigationTarget;
      intent: OutlinerNavigationIntent;
      preserveSource?: boolean;
      focusTarget?: boolean;
    }
  | {
      id: string;
      action: "create";
      parentId?: string | null;
      text: string;
      author?: BlockAuthor;
      provenance?: BlockProvenance;
    }
  | { id: string; action: "bookmarks.root" }
  | { id: string; action: "bookmarks.status"; targetBlockId: string }
  | { id: string; action: "bookmarks.resolve"; recordId: string }
  | {
      id: string;
      action: "bookmarks.toggle";
      targetBlockId: string;
      expectedRecordId: string | null;
      label?: string;
      author?: BlockAuthor;
      provenance?: BlockProvenance;
    }
  | {
      id: string;
      action: "bookmarks.remove";
      recordId: string;
      expectedUpdatedAt: string;
    }
  | {
      id: string;
      action: "roadmap.items.create";
      input: RoadmapItemCreateInput;
      author?: BlockAuthor;
      provenance?: BlockProvenance;
    }
  | {
      id: string;
      action: "deliveries.ensure";
      input: DeliveryEnsureInput;
      author?: BlockAuthor;
      provenance?: BlockProvenance;
    }
  | {
      id: string;
      action: "capture.create";
      requestId: string;
      text: string;
      source: CaptureSource;
      capturedFromBlockId?: string;
      author?: BlockAuthor;
      provenance?: BlockProvenance;
    }
  | {
      id: string;
      action: "capture.retitle";
      blockId: string;
      expectedUpdatedAt: string;
      title: string;
      mutation: MutationProvenance;
    }
  | { id: string; action: "capture.draft.get" }
  | {
      id: string;
      action: "capture.draft.save";
      input: QuickCaptureDraftSaveInput;
    }
  | {
      id: string;
      action: "capture.draft.clear";
      expectedRevision: number | null;
    }
  | {
      id: string;
      action: "annotations.list";
      query: AnnotationListQuery;
    }
  | {
      id: string;
      action: "annotations.create";
      requestId: string;
      input: AnnotationCreateInput;
      author?: BlockAuthor;
      provenance?: BlockProvenance;
    }
  | {
      id: string;
      action: "annotations.get";
      annotationId: string;
    }
  | {
      id: string;
      action: "annotations.reply";
      requestId: string;
      input: AnnotationReplyInput;
      author?: BlockAuthor;
      provenance?: BlockProvenance;
    }
  | {
      id: string;
      action: "annotations.batch";
      requestId: string;
      operations: AnnotationBatchOperation[];
      author?: BlockAuthor;
      provenance?: BlockProvenance;
    }
  | {
      id: string;
      action: "annotations.reconcile";
      input: AnnotationReconcileInput;
    }
  | {
      id: string;
      action: "annotations.approve-resolution";
      input: AnnotationApproveResolutionInput;
    }
  | {
      id: string;
      action: "annotations.lifecycle";
      input: AnnotationLifecycleInput;
      mutation: MutationProvenance;
    }
  | {
      id: string;
      action: "update";
      blockId: string;
      text: string;
      expectedUpdatedAt?: string;
      mutation: MutationProvenance;
    }
  | { id: string; action: "move"; blockId: string; parentId: string | null; position?: number }
  | { id: string; action: "delete"; blockId: string }
  | { id: string; action: "trash.restore"; blockId: string }
  | { id: string; action: "trash.purge"; blockId: string; confirmation: string }
  | {
      id: string;
      action: "virtual.occurrences.reorder";
      viewId: string;
      orderedBlockIds: string[];
    }
  | { id: string; action: "references.resolve"; text: string }
  | { id: string; action: "references.backlinks"; query: BacklinkQuery }
  | { id: string; action: "pages.resolve"; address: string }
  | {
      id: string;
      action: "pages.follow";
      address: string;
      author?: BlockAuthor;
      provenance?: BlockProvenance;
    }
  | { id: string; action: "pages.complete"; query?: string; limit: number }
  | {
      id: string;
      action: "pages.rename";
      blockId: string;
      address: string;
      expectedUpdatedAt: string;
    }
  | { id: string; action: "pages.alias"; blockId: string; address: string }
  | {
      id: string;
      action: "pages.remove";
      blockId: string;
      address: string;
      expectedUpdatedAt: string;
    }
  | {
      id: string;
      action: "properties.patch";
      blockId: string;
      expectedUpdatedAt: string;
      operations: PropertyPatchOperation[];
      mutation: MutationProvenance;
    }
  | {
      id: string;
      action: "activity.recent";
      afterCursor?: number;
      since?: string;
      limit?: number;
      author?: BlockAuthor;
    }
  | {
      id: string;
      action: "properties.catalog";
      key?: string;
      prefix?: string;
      limit?: number;
      propertyScope?: PropertyQueryScope;
    }
  | { id: string; action: "selection.get" }
  | { id: string; action: "selection.set"; blockId: string | null }
  | { id: string; action: "navigation.state" }
  | { id: string; action: "navigation.back" }
  | { id: string; action: "navigation.forward" }
  | { id: string; action: "work-ids.status" }
  | { id: string; action: "work-ids.configure"; prefix: string }
  | {
      id: string;
      action: "work-ids.allocate";
      blockId: string;
      expectedUpdatedAt: string;
    };

export type OutlinerResponse =
  | { id: string; ok: true; result: unknown; sequence: number }
  | { id: string; ok: false; error: string; sequence: number };

export interface SelectionContext {
  selected: Block | null;
  ancestors: Block[];
  children: Block[];
}

export interface NavigationState {
  selection: SelectionContext;
  canBack: boolean;
  canForward: boolean;
}

export interface BrowsingContextState {
  contextId: string;
  target: OutlinerNavigationTarget | null;
}

export interface BrowsingContextPublication extends BrowsingContextState {
  preview?: OutlinerNavigationDispatch;
  unavailable?: string;
}

export interface WorkspaceSnapshotView {
  query?: BlockSearchQuery;
}

export interface WorkspaceSnapshot {
  visible: VisibleBlockCollection;
  physical: VisibleBlockCollection;
  selection: SelectionContext;
  virtualOccurrenceRanks: VirtualOccurrenceRank[];
  sequence: number;
  workIdPrefix?: string;
}

export type OutlinerUiCommand =
  | {
      targetClientId: string;
      command: "focus";
      target?: OutlinerNavigationTarget;
      focus?: boolean;
    }
  | {
      targetClientId: string;
      command: "edit" | "reveal";
      target: Extract<OutlinerNavigationTarget, { kind: "block" }>;
      focus?: boolean;
    }
  | {
      targetClientId: string;
      command: "preview" | "open" | "replace";
      target: OutlinerNavigationTarget;
      focus?: boolean;
    }
  | {
      targetClientId: string;
      command: "backlinks.select";
      targetBlockId: string;
      sourceBlockId: string;
    }
  | {
      targetClientId: string;
      command: "comment.selection";
      renderedSelection: RenderedSelectionCapture;
    };

export interface OutlinerNavigationResolution {
  sourceClientId: string;
  targetClientId: string;
  intent: OutlinerNavigationIntent;
  resolution: "unlocked" | "self" | "context" | "same-tab";
}

export interface OutlinerNavigationDispatch extends OutlinerNavigationResolution {
  command: OutlinerUiCommand;
}

export type OutlinerEventDomain =
  | "content"
  | "resource-catalog"
  | "selection"
  | "view"
  | "ui"
  | "attention"
  | "browsing-context";

export interface OutlinerEvent {
  id: string;
  domain: OutlinerEventDomain;
  action: string;
  sequence: number;
  blockId?: string;
  resourceId?: string;
  sourceId?: string;
  contextId?: string;
  command?: OutlinerUiCommand;
  attention?: AttentionClientState;
  attentionInstruction?: AttentionInstruction;
}

export interface OutlinerEventEnvelope {
  event: OutlinerEvent;
}
