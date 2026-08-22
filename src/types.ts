export type BlockAuthor = "user" | "agent" | "system";

export interface BlockProperty {
  key: string;
  value: string;
}

export interface Block {
  id: string;
  parentId: string | null;
  position: number;
  text: string;
  author: BlockAuthor;
  collapsed: boolean;
  createdAt: string;
  updatedAt: string;
  properties: BlockProperty[];
}

export interface PropertyFilter {
  key: string;
  value?: string;
}

export interface BlockQuery {
  filters?: PropertyFilter[];
  text?: string;
  subtreeRootId?: string;
  limit?: number;
  includeCollapsed?: boolean;
}

export interface VisibleBlock extends Block {
  depth: number;
  multilineExpanded: boolean;
}

export type OutlinerRequest =
  | { id: string; action: "ping" }
  | { id: string; action: "list"; query?: BlockQuery }
  | { id: string; action: "get"; blockId: string }
  | { id: string; action: "create"; parentId?: string | null; text: string; author?: BlockAuthor }
  | { id: string; action: "update"; blockId: string; text: string; expectedUpdatedAt?: string }
  | { id: string; action: "move"; blockId: string; parentId: string | null; position?: number }
  | { id: string; action: "delete"; blockId: string }
  | { id: string; action: "toggle"; blockId: string }
  | { id: string; action: "view.toggleMultiline"; blockId: string }
  | { id: string; action: "references.resolve"; text: string }
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
