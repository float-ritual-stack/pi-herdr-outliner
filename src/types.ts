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
  collapsed: boolean;
  createdAt: string;
  updatedAt: string;
  properties: BlockProperty[];
}

export interface PropertyFilter {
  key: string;
  value?: string;
}

export type CollapsedDescendantPolicy = "prune" | "traverse";

export interface BlockTraversalOptions {
  filters?: PropertyFilter[];
  subtreeRootId?: string;
  collapsedDescendants: CollapsedDescendantPolicy;
}

export interface BlockSearchQuery {
  filters?: PropertyFilter[];
  text?: string;
  subtreeRootId?: string;
  rankViewId?: string;
  limit: number;
}

export type BlockCollectionCompleteness =
  | { kind: "complete" }
  | { kind: "truncated"; limit: number };

export interface VisibleBlock extends Block {
  depth: number;
  multilineExpanded: boolean;
  hasChildren: boolean;
  displayText: string;
}

export interface VisibleBlockCollection {
  blocks: VisibleBlock[];
  completeness: BlockCollectionCompleteness;
}

export interface VirtualOccurrenceRank {
  viewId: string;
  blockId: string;
  rank: number;
}

export const OUTLINER_PROTOCOL_VERSION = 5;

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
  | { id: string; action: "events.subscribe" }
  | { id: string; action: "ui.command.send"; command: OutlinerUiCommand }
  | {
      id: string;
      action: "create";
      parentId?: string | null;
      text: string;
      author?: BlockAuthor;
      provenance?: BlockProvenance;
    }
  | { id: string; action: "update"; blockId: string; text: string; expectedUpdatedAt?: string }
  | { id: string; action: "move"; blockId: string; parentId: string | null; position?: number }
  | { id: string; action: "delete"; blockId: string }
  | { id: string; action: "toggle"; blockId: string }
  | { id: string; action: "view.toggleMultiline"; blockId: string }
  | {
      id: string;
      action: "virtual.occurrences.reorder";
      viewId: string;
      orderedBlockIds: string[];
    }
  | { id: string; action: "references.resolve"; text: string }
  | {
      id: string;
      action: "properties.patch";
      blockId: string;
      expectedUpdatedAt: string;
      operations: PropertyPatchOperation[];
    }
  | { id: string; action: "properties.catalog"; key?: string; prefix?: string; limit?: number }
  | { id: string; action: "selection.get" }
  | { id: string; action: "selection.set"; blockId: string | null };

export type OutlinerResponse =
  | { id: string; ok: true; result: unknown; sequence: number }
  | { id: string; ok: false; error: string; sequence: number };

export interface SelectionContext {
  selected: Block | null;
  ancestors: Block[];
  children: Block[];
}

export interface WorkspaceSnapshotView {
  filters?: PropertyFilter[];
}

export interface WorkspaceSnapshot {
  visible: VisibleBlockCollection;
  physical: VisibleBlockCollection;
  selection: SelectionContext;
  virtualOccurrenceRanks: VirtualOccurrenceRank[];
  sequence: number;
}

export interface OutlinerUiCommand {
  target: "tree" | "detail";
  command: "edit" | "reveal" | "focus";
  blockId?: string;
}

export type OutlinerEventDomain = "content" | "selection" | "view" | "ui";

export interface OutlinerEvent {
  id: string;
  domain: OutlinerEventDomain;
  action: string;
  sequence: number;
  blockId?: string;
  command?: OutlinerUiCommand;
}

export interface OutlinerEventEnvelope {
  event: OutlinerEvent;
}
