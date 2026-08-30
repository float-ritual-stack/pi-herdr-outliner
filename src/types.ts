export type BlockAuthor = "user" | "agent" | "system";

export interface BlockProvenance {
  actorId: string;
  sessionId?: string;
  taskId?: string;
}

export interface BlockProperty {
  key: string;
  value: string;
}

export type PropertyPlacement = "inline" | "trailing-metadata" | "metadata-line";

export interface PropertyToken extends BlockProperty {
  ordinal: number;
  raw: string;
  start: number;
  end: number;
  line: number;
  column: number;
  placement: PropertyPlacement;
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

export type OutlinerClientRole = "tree" | "detail" | "report";

export type OutlinerNavigationIntent = "preview" | "open" | "reveal";

export interface OutlinerClientRuntime {
  paneId?: string;
  terminalId?: string;
  workspaceId?: string;
  tabId?: string;
  paneX?: number;
  paneY?: number;
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

export interface PropertyFilter {
  key: string;
  value?: string;
}


export interface BlockTraversalOptions {
  filters?: PropertyFilter[];
  subtreeRootId?: string;
}

export interface BlockSearchQuery {
  filters?: PropertyFilter[];
  text?: string;
  subtreeRootId?: string;
  rankViewId?: string;
  includeDeleted?: "roots" | "all";
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
  status: "resolved" | "deleted" | "missing" | "stale" | "duplicate";
  title?: string;
  deletionRootId?: string;
}

export interface ResolvedBlockReferences {
  text: string;
  references: BlockReferenceResolution[];
  workIdPrefix?: string;
}

export const OUTLINER_PROTOCOL_VERSION = 21;

export interface AgentReport {
  sessionId: string;
  rawText: string;
  resolvedText: string;
  publishedAt: string;
  revision: number;
  workIdPrefix?: string;
  taskId?: string;
}

export interface AgentReportSummary {
  sessionId: string;
  publishedAt: string;
  revision: number;
  taskId?: string;
}

export interface AgentReportPromotion {
  reportRevision: number;
  block: Block;
  startLine: number;
  endLine: number;
}

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
  | { id: string; action: "ui.command.send"; command: OutlinerUiCommand }
  | {
      id: string;
      action: "reports.publish";
      sessionId: string;
      text: string;
      taskId?: string;
    }
  | { id: string; action: "reports.list" }
  | { id: string; action: "reports.get"; sessionId: string }
  | { id: string; action: "reports.clear"; sessionId: string }
  | {
      id: string;
      action: "reports.promote";
      sessionId: string;
      startLine?: number;
      endLine?: number;
    }
  | { id: string; action: "blocks.context"; blockId: string }
  | { id: string; action: "browsing-context.get"; contextId: string }
  | {
      id: string;
      action: "browsing-context.publish";
      sourceClientId: string;
      contextId: string;
      blockId: string | null;
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
      action: "capture.create";
      requestId: string;
      text: string;
      source: CaptureSource;
      capturedFromBlockId?: string;
      author?: BlockAuthor;
      provenance?: BlockProvenance;
    }
  | { id: string; action: "update"; blockId: string; text: string; expectedUpdatedAt?: string }
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
    }
  | { id: string; action: "properties.catalog"; key?: string; prefix?: string; limit?: number }
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
  command: "edit" | "reveal" | "focus" | "preview" | "open";
  blockId?: string;
  fragmentId?: string;
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
  | "browsing-context"
  | "report";

export interface OutlinerEvent {
  id: string;
  domain: OutlinerEventDomain;
  action: string;
  sequence: number;
  blockId?: string;
  contextId?: string;
  command?: OutlinerUiCommand;
}

export interface OutlinerEventEnvelope {
  event: OutlinerEvent;
}
