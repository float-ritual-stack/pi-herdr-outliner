import type { MentionMessage, MentionScope } from "./mentions-types";
import type { AuthoredResourceReference } from "./resource-references";
import type { PromptRevision } from "./ai-prompts";
import type {
  ComputedExecutionReceipt,
  CreateComputedInvocationInput,
  CreateResourceSourceInput,
  InternFilesystemResourceInput,
  FilesystemResourceWriteInput,
  InternResourceInput,
  RelocateResourceInput,
  ResourceDescription,
  ResourceProviderCommandInput,
  ResourceProviderCommandReceipt,
  ResourceRevisionRef,
  ResourcePresentationContext,
  ResourceRetentionPinInput,
  ResourceRetentionPolicyInput,
  ResourceRetentionReferenceInput,
  ReviseComputedInvocationInput,
} from "./resources";
export type { AuthoredResourceReference } from "./resource-references";

export type {
  ComputedExecutionHistory,
  ComputedExecutionReceipt,
  ComputedExecutionReceiptOutput,
  ComputedExecutionRecord,
  ComputedExecutionRecordOutput,
  ComputedHandlerResolution,
  ComputedInvocation,
  ComputedProducerDeclarationSnapshot,
  ComputedResourceDocument,
  ComputedResourceFailure,
  ComputedResourceStatus,
  CreateComputedInvocationInput,
  CapabilityAssessment,
  FilesystemResourceWriteInput,
  InternFilesystemResourceInput,
  InternResourceReceipt,
  PdfPageText,
  PdfRegion,
  PdfRepresentationProvenance,
  PdfResourceDocument,
  PdfResourceHistory,
  PdfSourceSnapshotProvenance,
  RemoteEntityDocument,
  RemoteEntityMetadata,
  RemoteEntityMetadataValue,
  RemoteEntityProvider,
  RemoteEntityRepresentationProvenance,
  RemoteEntitySourceSnapshotProvenance,
  PdfTextSpan,
  Resource,
  ResourceAddress,
  ResourceCapability,
  ResourceCapabilityDecision,
  ResourceCapabilityReport,
  ResourceDescription,
  ResourceNativePayload,
  ResourceKind,
  ResourcePlacement,
  ResourcePresentationAttempt,
  ResourcePresentationContext,
  ResourcePresentationDecision,
  ResourcePresentationHost,
  ResourcePresentationSelection,
  ResourceProviderAccess,
  ResourceRenderer,
  ResourceRepresentationKind,
  ResourceSurface,
  ResourceProviderCommandDescriptor,
  ResourceProviderCommandInput,
  ResourceProviderCommandReceipt,
  PurgedResourceArtifact,
  ResourceRetentionArtifact,
  ResourceRetentionArtifactKind,
  ResourceRetentionArtifactRef,
  ResourceRetentionCollectionReceipt,
  ResourceRetentionPin,
  ResourceRetentionPinInput,
  ResourceRetentionPolicy,
  ResourceRetentionPolicyInput,
  ResourceRetentionReference,
  ResourceRetentionReferenceInput,
  ResourceRetentionReferenceOwner,
  ResourceRetentionReport,
  ResourceRetentionState,
  ResourceFreshness,
  ResourcePolicy,
  ResourceProvider,
  ResourceRevision,
  ResourceRevisionRef,
  ResourceSource,
  ResourceRepresentationAdapter,
  WebRepresentationProvenance,
  WebResourceDocument,
  WebResourceProvenance,
  ReviseComputedInvocationInput,
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
export type PropertySyntax = "bracket" | "bare" | "hashtag";

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

export interface PropertyInventory {
  key: string;
  propertyScope: PropertyQueryScope;
  items: PropertyCatalogItem[];
  totalValues: number;
  totalBlocks: number;
  matchedBlocks: number;
  offset: number;
  nextOffset: number | null;
  /** This response contains every matching value, rather than one page. */
  complete: boolean;
  sequence: number;
}

export interface Block {
  id: string;
  parentId: string | null;
  position: number;
  text: string;
  revision: number;
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
  submittedText?: string;
  cursorRow: number;
  cursorColumn: number;
  selectionAnchor?: {row: number; column: number};
  blockId?: string;
  blockRevision?: number;
  capturedFromBlockId?: string;
  revision: number;
  updatedAt: string;
}

/** Live Capture ownership follows its subscribed client, never a durable lock. */
export interface CaptureOwnerLocation {
  launching?: boolean;
  hostname: string;
  herdrSocket: string;
  paneId: string;
  popup: boolean;
}
export interface CaptureOwner extends CaptureOwnerLocation { clientId: string }
export interface CaptureOwnerClaim { acquired: boolean; owner: CaptureOwner }

export interface QuickCaptureDraftSaveInput {
  ownerClientId?: string;
  requestId: string;
  text: string;
  submittedText?: string;
  cursorRow: number;
  cursorColumn: number;
  selectionAnchor?: {row: number; column: number};
  prepareBlock?: boolean;
  /** Explicit writing-history choice, guarded against edits made after review. */
  recovery?: {id: string; revision: number; basedOnBlockRevision: number};
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
export type RenderedSelectionValidation = "herdr-keybinding" | "detail-pointer";

export interface RenderedSelectionEvidence {
  readonly quote: string;
  readonly capturedAt: string;
  readonly hostBlockId: string;
  readonly paneId: string;
  readonly contentRevision: number;
  readonly contextId: string;
  readonly detailClientId: string;
  readonly validation: RenderedSelectionValidation;
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
      readonly inboxAttemptId?: string;
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

/** Evidence captured by a local Preview, without asserting Markdown offsets. */
export interface PreviewPassageObservation {
  readonly fragmentId?:string;
  readonly validation:"preview-selection";
  readonly input:"pointer"|"keyboard";
  readonly quote:string;
  readonly capturedAt:string;
  readonly readerId:string;
  readonly renderRevision:number;
  readonly representationId:string;
  readonly snapshotHash:string;
  readonly projection:RenderedPassageProjection;
}

export interface AnnotationRepresentation {
  readonly id: string;
  readonly subject: AnnotationSubject;
  readonly sourceSnapshot: AnnotationSourceSnapshot;
  readonly adapter: AnnotationAdapter | null;
  readonly mediaType: string | null;
  readonly contentHash: string | null;
  readonly capturedAt: string;
  readonly observation?: RenderedPassageObservation | PreviewPassageObservation;
}

export type AnnotationAnchor =
  | { readonly kind: "whole-subject" }
  | { readonly kind: "list-item"; readonly itemId: string }
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
      readonly start: number | null;
      readonly end: number | null;
      readonly exact: string | null;
      readonly prefix: string | null;
      readonly suffix: string | null;
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

export interface AnnotationReferenceContext {
  readonly representation: AnnotationRepresentation;
  readonly anchor: Extract<AnnotationAnchor, { readonly kind: "text-quote" }>;
  /** Immutable host evidence, never a read/write authority. */
  readonly sourceText: string;
}

export interface AnnotationTarget {
  /** Stable checklist ownership, independent of the immutable captured quote. */
  readonly listItemId?: string;
  readonly representation: AnnotationRepresentation;
  readonly anchor: AnnotationAnchor;
  readonly referenceContext?: AnnotationReferenceContext;
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
      readonly proposalEventId?: string;
    }
  | {
      readonly kind: "agent";
      readonly modelId: string;
      readonly method: "semantic-reconciliation";
      readonly rationale: string;
      readonly evidence: readonly string[];
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

/** A quote is exact source text; optional context must identify one occurrence. */
export interface BlockCommentPassage {
  readonly quote: string;
  readonly start?: number;
  readonly prefix?: string;
  readonly suffix?: string;
  readonly itemId?: string;
}

export interface BlockCommentInput {
  readonly blockId: string;
  readonly expectedRevision: number;
  readonly body: string;
  readonly source: AnnotationSource;
  /** Omit only for an intentional whole-block comment. */
  readonly passage?: BlockCommentPassage;
}

export interface AnnotationReplyInput {
  readonly annotationId: string;
  readonly body: string;
  readonly source: AnnotationSource;
}

export type AnnotationBatchOperation =
  | { readonly operationId: string; readonly type: "block-comment"; readonly input: BlockCommentInput }
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

export interface AnnotationAgentCandidateSection {
  readonly index: number;
  readonly deterministicMethod: AnnotationResolutionMethod;
  readonly deterministicConfidence: number;
  readonly passage: string;
  readonly prefix: string;
  readonly suffix: string;
}

export interface AnnotationAgentPromptPackage {
  readonly annotationId: string;
  readonly baseEventId: string;
  readonly annotationBody: string;
  readonly originalPassage: string;
  readonly originalPrefix: string;
  readonly originalSuffix: string;
  readonly candidates: readonly AnnotationAgentCandidateSection[];
  readonly truncated: boolean;
  readonly characterCount: number;
}

export type AnnotationAgentResult =
  | {
      readonly status: "reanchored";
      readonly candidateIndex: number;
      readonly confidence: number;
      readonly rationale: string;
      readonly evidence: readonly string[];
    }
  | {
      readonly status: "ambiguous";
      readonly candidateIndexes: readonly number[];
      readonly confidence: number;
      readonly rationale: string;
      readonly evidence: readonly string[];
    }
  | {
      readonly status: "orphaned";
      readonly confidence: number;
      readonly rationale: string;
      readonly evidence: readonly string[];
    };

export interface AnnotationAgentProposalInput {
  readonly annotationId: string;
  readonly baseEventId: string;
  readonly modelId: string;
  readonly result: AnnotationAgentResult;
}

export interface AnnotationAgentProposalReceipt {
  readonly annotation: AnnotationRecord;
  readonly proposal: AnnotationResolutionEvent;
  readonly deduplicated: boolean;
}

export interface AnnotationAgentReviewInput {
  readonly annotationId: string;
  readonly proposalEventId: string;
  readonly decision: "accept" | "reject";
  readonly candidateIndex?: number;
}

export interface AnnotationAgentEvidenceSample {
  readonly annotationId: string;
  readonly proposalEventId: string;
  readonly modelId: string;
  readonly outcome: "reanchored" | "ambiguous" | "orphaned";
  readonly acceptedBy: "automatic" | "human";
  readonly confidence: number;
  readonly originalPassage: string;
  readonly resolvedPassage: string | null;
  readonly rationale: string;
  readonly evidence: readonly string[];
}

export interface AnnotationAgentEvidenceSummary {
  readonly acceptedCount: number;
  readonly automaticCount: number;
  readonly humanReviewedCount: number;
  readonly samples: readonly AnnotationAgentEvidenceSample[];
  readonly truncated: boolean;
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
  targetRegion?: OutlinerRegion;
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
  targetRegion?: OutlinerRegion;
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

export interface DeliverySyncInput {
  taskBlockId: string;
  deliveryBlockId: string;
  expectedDeliveryRevision: number;
  expectedTaskRevision: number;
  pullRequest: { number: number; url: string; state: "OPEN" | "CLOSED" | "MERGED"; mergeCommit: string | null };
}

export interface DeliverySyncReceipt {
  task: Block;
  delivery: Block;
  changed: boolean;
}

export type OutlinerClientRole = "tree" | "detail" | "composed" | "observer";
export type OutlinerRegion = "tree" | "detail";

export function clientSupportsRole(client: Pick<OutlinerClientRegistration, "role">, role: OutlinerClientRole): boolean {
  return client.role === role || (client.role === "composed" && (role === "tree" || role === "detail"));
}

export interface BlockTarget {
  kind: "block";
  blockId: string;
  fragmentId?: string;
}

export interface ResourceTarget {
  kind: "resource";
  resourceId: string;
  revision?: ResourceRevisionRef;
  referenceContext?: AnnotationReferenceContext;
}

export type OutlinerNavigationIntent = "preview" | "open" | "reveal";

export type OutlinerNavigationTarget = BlockTarget | ResourceTarget;
export interface OutlinerClientRuntime {
  hostname?: string;
  paneId?: string;
  terminalId?: string;
  workspaceId?: string;
  tabId?: string;
  paneX?: number;
  paneY?: number;
  focused?: boolean;
  visible?: boolean;
}

export interface OutlinerViewAddress {
  clientId: string;
  region: OutlinerRegion;
}

export interface NavigationLinkState {
  source: OutlinerViewAddress;
  destination: OutlinerViewAddress | null;
  destinations: Array<{ view: OutlinerViewAddress; label: string; description?: string; groupLabel?: string; target?: OutlinerNavigationTarget; otherLocation?: boolean; protection?: string; placementPaneId?: string }>;
}

export interface OutlinerClientRegistration {
  clientId: string;
  role: OutlinerClientRole;
  contextId: string;
  navigationProtection?: string | null;
  currentTarget?: OutlinerNavigationTarget;
  previewTarget?: OutlinerNavigationTarget;
  runtime?: OutlinerClientRuntime;
  resourcePresentation?: ResourcePresentationContext;
  focusedRegion?: OutlinerRegion;
  treeSelection?: { target: OutlinerNavigationTarget; rowId: string };
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

export const ROADMAP_WORK_STAGES = [
  "unprioritized", "later", "queued", "doing", "review", "validate", "done", "superseded",
] as const;
export type RoadmapWorkStage = typeof ROADMAP_WORK_STAGES[number];

export interface RoadmapItemCreateInput {
  title: string;
  body?: string;
  priority: RoadmapItemPriority;
  workStage?: Exclude<RoadmapWorkStage, "done" | "superseded">;
  workBatchId?: string;
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

export type ChecklistStatus = "todo" | "done" | "waiting" | "problem";

export interface ChecklistItem {
  itemId?: string;
  identity: "unassigned" | "unique" | "duplicate";
  status: ChecklistStatus;
  evidence: string;
  /** Canonical UTF-16 positions; the extent includes continuation lines and nested items. */
  span: { start: number; end: number; startLine: number; endLine: number };
  markerStart: number;
  depth: number;
  parentStart?: number;
  text: string;
  /** Only this item's properties: descendants and the plan's metadata do not inherit. */
  properties: PropertyRecord[];
}

export interface ChecklistQuery {
  statuses?: ChecklistStatus[];
  excludeStatuses?: ChecklistStatus[];
  filters?: PropertyFilter[];
  nested?: "include" | "top-level";
  limit: number;
}

export interface ChecklistCollection {
  blockId: string;
  revision: number;
  title: string;
  items: ChecklistItem[];
  completeness: BlockCollectionCompleteness;
}

export interface ChecklistSearchQuery {
  /** Select canonical plans, independently of the item predicates and pane expansion. */
  scope?: Pick<BlockSearchQuery, "filters" | "text" | "subtreeRootId" | "propertyScope" | "sort">;
  items: ChecklistQuery;
}

export interface ChecklistSearchCollection {
  matches: {block: Block; item: ChecklistItem}[];
  completeness: BlockCollectionCompleteness;
}

export interface ChecklistUpdateInput {
  /** Unassigned items are addressed only against an exact observed block revision. */
  target: { itemId: string } | { start: number; expectedRevision: number };
  expectedEvidence: string;
  change: { kind: "status"; status: ChecklistStatus } | { kind: "ensure-id" };
}

export interface ChecklistUpdateReceipt {
  block: Block;
  item: ChecklistItem;
  changed: boolean;
}

/** Explicit identity edits are authorized only with the enclosing block's expected revision. */
export type ChecklistIdentityChange =
  | { kind: "remove"; itemId: string }
  | { kind: "rename"; itemId: string; to: string };

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

export interface TreeIndexBlock extends Omit<VisibleBlock, "text" | "displayText" | "propertyMatches"> {
  preview: string;
  previewReferences: TreePreviewReference[];
  textDigest: string;
}

export interface TreePreviewReference {
  start: number;
  end: number;
  target: Pick<BlockReferenceResolution, "blockId" | "fragmentId"> | null;
}

export interface TreeIndexCollection {
  blocks: TreeIndexBlock[];
  completeness: BlockCollectionCompleteness;
}

export interface TreeFocusCollection {
  matches: Array<{ block: Pick<Block, "id">; title: string }>;
  completeness: BlockCollectionCompleteness;
}

export interface GotoSearchMatch {
  block: Pick<Block, "id" | "revision">;
  title: string;
  path: string;
  snippet: string;
  exact: boolean;
}

export interface GotoSearchCollection {
  matches: GotoSearchMatch[];
  completeness: BlockCollectionCompleteness;
  semantic: {
    status: "lexical" | "ranked" | "unavailable";
    message?: string;
    model?: string;
    elapsedMs?: number;
    candidateCount?: number;
    inputTokens?: number;
    promptRevisions?: PromptRevision[];
  };
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

export interface WorkingSelectionTarget {
  blockId: string;
  rowId: string;
  viewId?: string;
  parentRowId?: string | null;
  rankRoot?: boolean;
}

export interface WorkingSelection {
  id: string;
  ownerClientId: string;
  revision: number;
  updatedAt: string;
  targets: WorkingSelectionTarget[];
}

export interface WorkingSelectionSaveInput {
  ownerClientId: string;
  expected: {id: string; revision: number} | null;
  targets: WorkingSelectionTarget[];
}

export interface WorkingSelectionRecovery {
  selections: WorkingSelection[];
  completeness: BlockCollectionCompleteness;
}

export interface VirtualBranchOrder {
  viewId: string;
  viewRevision: number;
  blockIds: string[];
  completeness: BlockCollectionCompleteness;
}

export type VirtualBranchPlacement =
  | {kind: "up" | "down" | "top" | "bottom"}
  | {kind: "before" | "after"; anchorId: string};

export interface VirtualBranchPlacementInput {
  selection?: Pick<WorkingSelection, "id" | "ownerClientId" | "revision">;
  expected: VirtualBranchOrder;
  selectedBlockIds: string[];
  placement: VirtualBranchPlacement;
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

export const OUTLINER_PROTOCOL_VERSION = 80;


export interface OutlinerServiceStatus {
  status: "ready";
  protocolVersion: typeof OUTLINER_PROTOCOL_VERSION;
  location?: {hostname:string;workspaceRoot:string;database:string;stateDirectory:string};
}

export interface ResourceProviderCommandResult {
  readonly receipt: ResourceProviderCommandReceipt;
  readonly description: ResourceDescription;
}

export interface ComputedExecutionResult {
  readonly receipt: ComputedExecutionReceipt;
  readonly description: ResourceDescription;
}

export type OutlinerRequest =
  | { id: string; action: "properties.inventory"; key: string; propertyScope?: PropertyQueryScope; offset?: number; limit?: number }
  | { id: string; action: "inbox.search"; query: string; semantic?: boolean }
  | { id: string; action: "inbox.status"; attentionOnly?: boolean; resultsOffset?: number }
  | { id: string; action: "inbox.result"; resultId: string }
  | { id: string; action: "inbox.pause" }
  | { id: string; action: "inbox.resume" }
  | { id: string; action: "inbox.retry"; sourceId: string; instructions?: string }
  | { id: string; action: "inbox.undo"; resultId: string }
  | { id: string; action: "ping" }
  | { id: string; action: "blocks.query"; query: BlockSearchQuery }
  | { id: string; action: "blocks.authored-links"; ownerBlockId: string }
  | { id: string; action: "get"; blockId: string }
  | { id: string; action: "children"; parentId: string | null }
  | { id: string; action: "files.read"; path: string }
  | { id: string; action: "files.complete"; prefix: string }
  | { id: string; action: "workspace.snapshot"; view?: WorkspaceSnapshotView }
  | { id: string; action: "tree.index"; view?: WorkspaceSnapshotView }
  | { id: string; action: "tree.query"; query: BlockSearchQuery }
  | { id: string; action: "tree.search"; query: string; semantic?: boolean }
  | { id: string; action: "tree.focus"; query: string }
  | { id: string; action: "events.subscribe"; client: OutlinerClientRegistration }
  | { id: string; action: "clients.list"; role?: OutlinerClientRole }
  | {
      id: string;
      action: "clients.update";
      clientId: string;
      navigationProtection?: string | null;
      currentTarget?: OutlinerNavigationTarget | null;
      previewTarget?: OutlinerNavigationTarget | null;
      runtime?: OutlinerClientRuntime | null;
      focusedRegion?: OutlinerRegion;
      treeSelection?: { target: OutlinerNavigationTarget; rowId: string } | null;
    }
  | { id: string; action: "resource-sources.create"; input: CreateResourceSourceInput }
  | { id: string; action: "resource-sources.list" }
  | { id: string; action: "resource-sources.get"; sourceId: string }
  | {
      id: string;
      action: "computed.invocations.create";
      input: CreateComputedInvocationInput;
    }
  | {
      id: string;
      action: "computed.invocations.revise";
      input: ReviseComputedInvocationInput;
    }
  | { id: string; action: "computed.handlers.resolve"; reference: string }
  | { id: string; action: "computed.executions.list"; resourceId: string }
  | {
      id: string;
      action: "computed.execute";
      resourceId: string;
      destinationClientId: string;
    }
  | { id: string; action: "resources.intern"; input: InternResourceInput }
  | { id: string; action: "resources.intern-filesystem"; input: InternFilesystemResourceInput }
  | { id: string; action: "resources.lookup-filesystem"; path: string }
  | {
      id: string;
      action: "resources.follow-authored";
      reference: AuthoredResourceReference;
    }
  | { id: string; action: "resources.get"; resourceId: string }
  | { id: string; action: "resources.relocate"; input: RelocateResourceInput }
  | {
      id: string;
      action: "resources.write-filesystem";
      input: FilesystemResourceWriteInput;
      destinationClientId: string;
    }

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
  | {
      id: string;
      action: "resources.command.execute";
      resourceId: string;
      destinationClientId: string;
      input: ResourceProviderCommandInput;
    }
  | { id: string; action: "resources.retention.get" }
  | { id: string; action: "resources.retention.configure"; input: ResourceRetentionPolicyInput }
  | { id: string; action: "resources.retention.inspect"; resourceId?: string }
  | { id: string; action: "resources.retention.pin"; input: ResourceRetentionPinInput }
  | { id: string; action: "resources.retention.unpin"; pinId: string }
  | {
      id: string;
      action: "resources.retention.reference";
      input: ResourceRetentionReferenceInput;
    }
  | { id: string; action: "resources.retention.unreference"; referenceId: string }
  | {
      id: string;
      action: "resources.collect";
      mode: "evict" | "purge";
      resourceId?: string;
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
  | { id: string; action: "navigation.link.get"; source: OutlinerViewAddress }
  | { id: string; action: "navigation.link.set"; source: OutlinerViewAddress; destination: OutlinerViewAddress | null }
  | {
      id: string;
      action: "navigation.resolve";
      sourceClientId: string;
      intent: OutlinerNavigationIntent;
      sourceRegion?: OutlinerRegion;
      destination?: OutlinerViewAddress;
      preserveSource?: boolean;
    }
  | {
      id: string;
      action: "navigation.dispatch";
      sourceClientId: string;
      target: OutlinerNavigationTarget;
      intent: OutlinerNavigationIntent;
      sourceRegion?: OutlinerRegion;
      destination?: OutlinerViewAddress;
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
  | { id:string; action:"mentions.ingest"; message:MentionMessage }
  | { id:string; action:"mentions.list"; scope?:MentionScope; limit?:number }
  | { id:string; action:"mentions.message"; messageKey:string }
  | { id:string; action:"mentions.clear"; scope?:MentionScope }
  | { id:string; action:"mentions.save"; messageKey:string }
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
      expectedRevision: number;
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
      action: "deliveries.sync";
      input: DeliverySyncInput;
      mutation: MutationProvenance;
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
      expectedDraftRevision?: number;
      ownerClientId?: string;
    }
  | {
      id: string;
      action: "capture.retitle";
      blockId: string;
      expectedRevision: number;
      title: string;
      mutation: MutationProvenance;
    }
  | { id: string; action: "capture.owner.get" }
  | { id: string; action: "capture.owner.claim"; clientId: string; location: CaptureOwnerLocation; transferToken?: string }
  | { id: string; action: "capture.owner.handoff"; clientId: string; requestId: string; expectedDraftRevision: number }
  | { id: string; action: "capture.draft.get" }
  | { id: string; action: "edit-recovery.start"; input: import("./edit-recovery").EditRecoveryStart }
  | { id: string; action: "edit-recovery.get"; recoveryId: string }
  | { id: string; action: "edit-recovery.list"; blockId: string; includeHistory?: boolean }
  | { id: string; action: "edit-recovery.restore"; recoveryId: string; requestId: string; version: "draft"|"before-save" }
  | { id: string; action: "edit-recovery.refresh"; recoveryId: string; expectedRevision: number }
  | { id: string; action: "edit-recovery.propose"; recoveryId: string; expectedRevision: number; proposal: import("./edit-recovery").EditRecoveryProposal }
  | { id: string; action: "edit-recovery.assist"; recoveryId: string; expectedRevision: number }
  | { id: string; action: "edit-recovery.cancel"; recoveryId: string }
  | { id: string; action: "edit-recovery.commit"; recoveryId: string; expectedRevision: number; text: string; basedOnRevision: number; mutation: MutationProvenance; identityChanges?:ChecklistIdentityChange[] }
  | { id: string; action: "edit-recovery.discard"; recoveryId: string; expectedRevision: number }
  | { id: string; action: "edit-recovery.separate"; recoveryId: string; expectedRevision: number; mutation: MutationProvenance }
  | {
      id: string;
      action: "capture.draft.save";
      input: QuickCaptureDraftSaveInput;
    }
  | {
      id: string;
      action: "capture.draft.clear";
      ownerClientId?: string;
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
      action: "annotations.agent-package";
      annotationId: string;
    }
  | {
      id: string;
      action: "annotations.agent-receipt";
      requestId: string;
    }
  | {
      id: string;
      action: "annotations.propose-agent";
      requestId: string;
      input: AnnotationAgentProposalInput;
    }
  | {
      id: string;
      action: "annotations.review-agent";
      input: AnnotationAgentReviewInput;
    }
  | {
      id: string;
      action: "annotations.agent-evidence";
      limit?: number;
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
      expectedRevision: number;
      mutation: MutationProvenance;
      identityChanges?: ChecklistIdentityChange[];
    }
  | { id: string; action: "checklist.query"; blockId: string; query: ChecklistQuery }
  | { id: string; action: "checklist.search"; query: ChecklistSearchQuery }
  | { id: string; action: "checklist.update"; blockId: string; input: ChecklistUpdateInput; mutation: MutationProvenance }
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
  | { id: string; action: "virtual.occurrences.order"; viewId: string }
  | { id: string; action: "working-selection.get"; ownerClientId: string }
  | { id: string; action: "working-selection.save"; input: WorkingSelectionSaveInput }
  | { id: string; action: "working-selection.recoverable"; ownerClientId: string }
  | { id: string; action: "working-selection.resume"; ownerClientId: string; selectionId: string; expectedRevision: number }
  | { id: string; action: "virtual.occurrences.place"; input: VirtualBranchPlacementInput }
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
      expectedRevision: number;
    }
  | { id: string; action: "pages.alias"; blockId: string; address: string }
  | {
      id: string;
      action: "pages.remove";
      blockId: string;
      address: string;
      expectedRevision: number;
    }
  | {
      id: string;
      action: "properties.patch";
      blockId: string;
      expectedRevision: number;
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
      expectedRevision: number;
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

export interface TreeIndexSnapshot {
  blocks: TreeIndexBlock[];
  physicalBlockIds: string[];
  visible: {
    rows: Pick<VisibleBlock, "id" | "depth" | "propertyMatches">[];
    completeness: BlockCollectionCompleteness;
  };
  selectedBlockId: string | null;
  virtualOccurrenceRanks: VirtualOccurrenceRank[];
  sequence: number;
  workIdPrefix?: string;
}

export type OutlinerUiCommand = (
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
    }) & { targetRegion?: OutlinerRegion };

export interface OutlinerNavigationResolution {
  sourceClientId: string;
  targetClientId: string;
  intent: OutlinerNavigationIntent;
  resolution: "self" | "context" | "same-tab" | "linked" | "chosen";
  targetRegion?: OutlinerRegion;
}

export interface OutlinerNavigationDispatch extends OutlinerNavigationResolution {
  command: OutlinerUiCommand;
}

export type OutlinerEventDomain =
  | "mentions"
  | "inbox"
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
  clientId?: string;
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
