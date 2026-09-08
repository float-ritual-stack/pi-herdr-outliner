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

export type AnnotationSource = "user" | "agent";
export type AnnotationLifecycle = "open" | "resolved";
export type AnnotationAnchorState = "anchored" | "ambiguous" | "orphaned";

export interface AnnotationAnchor {
  start: number;
  end: number;
  excerpt: string;
  contextBefore: string;
  contextAfter: string;
  sourceVersion: string;
  sourceHash: string;
}

export type AnnotationTarget =
  | {
      kind: "block";
      sourceBlockId: string;
      anchor: AnnotationAnchor;
    }
  | {
      kind: "file";
      sourceBlockId: string;
      filePath: string;
      startLine: number;
      endLine: number;
      anchor: AnnotationAnchor;
    };

export interface AnnotationCreateInput {
  target: AnnotationTarget;
  body: string;
  source: AnnotationSource;
}

export interface AnnotationReplyInput {
  annotationId: string;
  body: string;
  source: AnnotationSource;
}

export type AnnotationBatchOperation =
  | { operationId: string; type: "create"; input: AnnotationCreateInput }
  | { operationId: string; type: "reply"; input: AnnotationReplyInput };

export interface AnnotationRecord {
  block: Block;
  target: AnnotationTarget;
  body: string;
  source: AnnotationSource;
  lifecycle: AnnotationLifecycle;
  promotedBlockIds?: string[];
  anchorState: AnnotationAnchorState;
  parentAnnotationId?: string;
}

export interface AnnotationThread extends AnnotationRecord {
  replies: AnnotationRecord[];
}

export interface AnnotationBatchReceipt {
  annotations: AnnotationRecord[];
  deduplicated: boolean;
}

export interface AnnotationListQuery {
  sourceBlockId?: string;
  filePath?: string;
  lifecycle?: AnnotationLifecycle;
  includeResolved?: boolean;
}

export interface AnnotationReanchorInput {
  sourceBlockId: string;
  sourceText: string;
  sourceVersion: string;
  sourceHash?: string;
}

export interface AnnotationLifecycleInput {
  annotationId: string;
  lifecycle: AnnotationLifecycle;
  promotedBlockId?: string;
}

export type AttentionTone = "current" | "info" | "warning" | "error" | "match" | "dim";
export type AttentionRole = "current" | "supporting";
export type AttentionSourceState = "active" | "stale";

export type AttentionTargetInput =
  | {
      kind: "block";
      sourceBlockId: string;
      fragmentId?: string;
      sourceVersion?: string;
      sourceHash?: string;
      anchor?: AnnotationAnchor;
    }
  | {
      kind: "file";
      sourceBlockId: string;
      filePath: string;
      startLine: number;
      endLine: number;
      anchor: AnnotationAnchor;
    };

export type AttentionTarget =
  | {
      kind: "block";
      sourceBlockId: string;
      fragmentId?: string;
      sourceVersion: string;
      sourceHash: string;
      anchor?: AnnotationAnchor;
    }
  | {
      kind: "file";
      sourceBlockId: string;
      filePath: string;
      startLine: number;
      endLine: number;
      anchor: AnnotationAnchor;
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

export type OutlinerNavigationIntent = "preview" | "open" | "reveal";

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
  currentBlockId?: string;
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
  | "later";

export interface RoadmapItemCreateInput {
  title: string;
  body?: string;
  priority: RoadmapItemPriority;
  workStage?: RoadmapWorkStage;
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

export const OUTLINER_PROTOCOL_VERSION = 32;


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
      currentBlockId?: string | null;
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
      blockId: string | null;
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
      blockId: string;
      fragmentId?: string;
      intent: OutlinerNavigationIntent;
      preserveSource?: boolean;
    }
  | {
      id: string;
      action: "create";
      parentId?: string | null;
      text: string;
      author?: BlockAuthor;
      provenance?: BlockProvenance;
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
      action: "annotations.reanchor";
      input: AnnotationReanchorInput;
      mutation: MutationProvenance;
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
  target: SelectionContext;
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

export interface OutlinerUiCommand {
  targetClientId: string;
  command: "edit" | "reveal" | "focus" | "preview" | "open" | "replace" | "backlinks.select";
  blockId?: string;
  fragmentId?: string;
  targetBlockId?: string;
  sourceBlockId?: string;
}

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
  contextId?: string;
  command?: OutlinerUiCommand;
  attention?: AttentionClientState;
  attentionInstruction?: AttentionInstruction;
}

export interface OutlinerEventEnvelope {
  event: OutlinerEvent;
}
