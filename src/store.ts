import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { matchesFilters, parseProperties } from "./properties";
import { resolveBlockReferences as resolveBlockReferenceText } from "./references";
import type {
  Block,
  BlockAuthor,
  BlockProperty,
  BlockQuery,
  SelectionContext,
  VisibleBlock,
} from "./types";

interface BlockRow {
  id: string;
  parent_id: string | null;
  position: number;
  text: string;
  author: BlockAuthor;
  collapsed: number;
  created_at: string;
  updated_at: string;
}

interface PropertyRow {
  block_id: string;
  key: string;
  value: string;
}

export class OutlinerStore {
  readonly database: Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.database = new Database(path, { create: true });
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.migrate();
    this.seed();
  }

  close(): void {
    this.database.close();
  }

  get sequence(): number {
    const row = this.database.query("SELECT value FROM metadata WHERE key = 'sequence'").get() as
      | { value: string }
      | null;
    return Number(row?.value ?? 0);
  }

  create(text: string, parentId: string | null = null, author: BlockAuthor = "user"): Block {
    if (parentId !== null && !this.get(parentId)) throw new Error(`Parent block not found: ${parentId}`);
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const positionRow = this.database
      .query("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM blocks WHERE parent_id IS ?")
      .get(parentId) as { position: number };

    this.database.transaction(() => {
      this.database
        .query(
          "INSERT INTO blocks (id, parent_id, position, text, author, collapsed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
        )
        .run(id, parentId, positionRow.position, text, author, now, now);
      this.replaceProperties(id, parseProperties(text));
      this.bumpSequence();
    })();

    return this.require(id);
  }

  update(id: string, text: string, expectedUpdatedAt?: string): Block {
    const existing = this.require(id);
    if (expectedUpdatedAt && existing.updatedAt !== expectedUpdatedAt) {
      throw new Error(`Block changed since editing began: ${id}`);
    }
    const timestamp = Math.max(Date.now(), Date.parse(existing.updatedAt) + 1);
    this.database.transaction(() => {
      this.database.query("UPDATE blocks SET text = ?, updated_at = ? WHERE id = ?").run(text, new Date(timestamp).toISOString(), id);
      this.replaceProperties(id, parseProperties(text));
      this.bumpSequence();
    })();
    return this.require(id);
  }

  move(id: string, parentId: string | null, requestedPosition?: number): Block {
    const block = this.require(id);
    if (parentId !== null) {
      this.require(parentId);
      if (parentId === id || this.isDescendant(parentId, id)) throw new Error("Cannot move a block beneath itself");
    }

    const siblings = this.children(parentId).filter((candidate) => candidate.id !== id);
    const position = Math.max(0, Math.min(requestedPosition ?? siblings.length, siblings.length));
    siblings.splice(position, 0, block);

    this.database.transaction(() => {
      this.database.query("UPDATE blocks SET parent_id = ? WHERE id = ?").run(parentId, id);
      const updatePosition = this.database.query("UPDATE blocks SET position = ?, updated_at = ? WHERE id = ?");
      const now = new Date().toISOString();
      siblings.forEach((sibling, index) => updatePosition.run(index, now, sibling.id));
      this.normalizePositions(block.parentId);
      this.bumpSequence();
    })();
    return this.require(id);
  }

  delete(id: string): void {
    this.require(id);
    this.database.transaction(() => {
      this.database.query("DELETE FROM blocks WHERE id = ?").run(id);
      this.bumpSequence();
    })();
  }

  toggle(id: string): Block {
    this.require(id);
    this.database.transaction(() => {
      this.database
        .query("UPDATE blocks SET collapsed = CASE collapsed WHEN 0 THEN 1 ELSE 0 END, updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), id);
      this.bumpSequence();
    })();
    return this.require(id);
  }

  toggleMultilineExpanded(id: string): boolean {
    this.require(id);
    const current = this.database
      .query("SELECT multiline_expanded FROM block_view_state WHERE block_id = ?")
      .get(id) as { multiline_expanded: number } | null;
    const expanded = current?.multiline_expanded !== 1;
    this.database.transaction(() => {
      this.database
        .query(
          "INSERT INTO block_view_state (block_id, multiline_expanded) VALUES (?, ?) ON CONFLICT(block_id) DO UPDATE SET multiline_expanded = excluded.multiline_expanded",
        )
        .run(id, expanded ? 1 : 0);
      this.bumpSequence();
    })();
    return expanded;
  }

  resolveBlockReferences(text: string): string {
    return resolveBlockReferenceText(text, (blockId) => this.get(blockId));
  }

  get(id: string): Block | null {
    const row = this.database.query("SELECT * FROM blocks WHERE id = ?").get(id) as BlockRow | null;
    return row ? this.hydrate(row) : null;
  }

  require(id: string): Block {
    const block = this.get(id);
    if (!block) throw new Error(`Block not found: ${id}`);
    return block;
  }

  children(parentId: string | null): Block[] {
    const rows = this.database
      .query("SELECT * FROM blocks WHERE parent_id IS ? ORDER BY position, created_at")
      .all(parentId) as BlockRow[];
    return rows.map((row) => this.hydrate(row));
  }

  list(query: BlockQuery = {}): VisibleBlock[] {
    const rows = this.database.query("SELECT * FROM blocks ORDER BY position, created_at").all() as BlockRow[];
    const blocks = rows.map((row) => this.hydrate(row));
    const byParent = new Map<string | null, Block[]>();
    for (const block of blocks) {
      const siblings = byParent.get(block.parentId) ?? [];
      siblings.push(block);
      byParent.set(block.parentId, siblings);
    }
    for (const siblings of byParent.values()) siblings.sort((a, b) => a.position - b.position);
    const expandedRows = this.database
      .query("SELECT block_id FROM block_view_state WHERE multiline_expanded = 1")
      .all() as Array<{ block_id: string }>;
    const expandedIds = new Set(expandedRows.map((row) => row.block_id));

    const result: VisibleBlock[] = [];
    const filterText = query.text?.toLowerCase();
    const shouldTraverseCollapsed = Boolean(
      query.includeCollapsed || query.filters?.length || filterText,
    );
    const visit = (block: Block, depth: number): void => {
      const matches =
        (!query.filters?.length || matchesFilters(block.properties, query.filters)) &&
        (!filterText || block.text.toLowerCase().includes(filterText));
      if (matches) result.push({ ...block, depth, multilineExpanded: expandedIds.has(block.id) });
      if (!block.collapsed || shouldTraverseCollapsed) {
        for (const child of byParent.get(block.id) ?? []) visit(child, depth + 1);
      }
    };

    if (query.subtreeRootId) {
      const root = blocks.find((block) => block.id === query.subtreeRootId);
      if (root) visit(root, 0);
    } else {
      for (const root of byParent.get(null) ?? []) visit(root, 0);
    }
    return result.slice(0, query.limit ?? 500);
  }

  getSelection(): SelectionContext {
    const row = this.database.query("SELECT block_id FROM selection WHERE singleton = 1").get() as
      | { block_id: string | null }
      | null;
    const selected = row?.block_id ? this.get(row.block_id) : null;
    if (!selected) return { selected: null, ancestors: [], children: [] };

    const ancestors: Block[] = [];
    let parentId = selected.parentId;
    while (parentId) {
      const parent = this.get(parentId);
      if (!parent) break;
      ancestors.unshift(parent);
      parentId = parent.parentId;
    }
    return { selected, ancestors, children: this.children(selected.id) };
  }

  setSelection(blockId: string | null): SelectionContext {
    if (blockId !== null) this.require(blockId);
    this.database.query("UPDATE selection SET block_id = ? WHERE singleton = 1").run(blockId);
    return this.getSelection();
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS blocks (
        id TEXT PRIMARY KEY,
        parent_id TEXT REFERENCES blocks(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        text TEXT NOT NULL,
        author TEXT NOT NULL CHECK (author IN ('user', 'agent', 'system')),
        collapsed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS blocks_parent_position ON blocks(parent_id, position);
      CREATE TABLE IF NOT EXISTS block_properties (
        block_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        PRIMARY KEY (block_id, key, ordinal)
      );
      CREATE INDEX IF NOT EXISTS properties_key_value ON block_properties(key, value);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO metadata (key, value) VALUES ('sequence', '0');
      CREATE TABLE IF NOT EXISTS selection (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        block_id TEXT REFERENCES blocks(id) ON DELETE SET NULL
      );
      INSERT OR IGNORE INTO selection (singleton, block_id) VALUES (1, NULL);
      CREATE TABLE IF NOT EXISTS block_view_state (
        block_id TEXT PRIMARY KEY REFERENCES blocks(id) ON DELETE CASCADE,
        multiline_expanded INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  private seed(): void {
    const row = this.database.query("SELECT COUNT(*) AS count FROM blocks").get() as { count: number };
    if (row.count > 0) return;
    const workspace = this.create("Workspace [type::workspace]", null, "system");
    this.create("Notes [type::notes]", workspace.id, "system");
    this.create("Open Questions [type::questions] [status::open]", workspace.id, "system");
    this.create("Decisions [type::decisions]", workspace.id, "system");
    this.create("Progress Log [type::progress-log]", workspace.id, "system");
    this.setSelection(workspace.id);
  }

  private hydrate(row: BlockRow): Block {
    const properties = this.database
      .query("SELECT block_id, key, value FROM block_properties WHERE block_id = ? ORDER BY ordinal")
      .all(row.id) as PropertyRow[];
    return {
      id: row.id,
      parentId: row.parent_id,
      position: row.position,
      text: row.text,
      author: row.author,
      collapsed: row.collapsed === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      properties: properties.map(({ key, value }) => ({ key, value })),
    };
  }

  private replaceProperties(blockId: string, properties: BlockProperty[]): void {
    this.database.query("DELETE FROM block_properties WHERE block_id = ?").run(blockId);
    const insert = this.database.query(
      "INSERT INTO block_properties (block_id, key, value, ordinal) VALUES (?, ?, ?, ?)",
    );
    properties.forEach((property, ordinal) => insert.run(blockId, property.key, property.value, ordinal));
  }

  private normalizePositions(parentId: string | null): void {
    const siblings = this.children(parentId);
    const update = this.database.query("UPDATE blocks SET position = ? WHERE id = ?");
    siblings.forEach((sibling, index) => update.run(index, sibling.id));
  }

  private isDescendant(candidateId: string, ancestorId: string): boolean {
    let current = this.get(candidateId);
    while (current?.parentId) {
      if (current.parentId === ancestorId) return true;
      current = this.get(current.parentId);
    }
    return false;
  }

  private bumpSequence(): void {
    this.database.query("UPDATE metadata SET value = CAST(value AS INTEGER) + 1 WHERE key = 'sequence'").run();
  }
}
