import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  firstLineWithoutPropertyTokens,
  matchesFilters,
  parseProperties,
  parsePropertyTokens,
  patchPropertyText,
  PROPERTY_PARSER_VERSION,
} from "./properties";
import {
  isWorkIdAddress,
  normalizePageAddress,
  PAGE_ADDRESS_REGISTRY_VERSION,
  type NormalizedPageAddress,
} from "./page-addresses";
import {
  resolveBlockReferences as resolveBlockReferenceText,
  resolveBlockReferencesWithStatus,
} from "./references";
import type {
  Block,
  BlockAuthor,
  BlockProvenance,
  BlockProperty,
  BlockSearchQuery,
  BlockTraversalOptions,
  NavigationState,
  PageAddressCollection,
  PageAddressFollowResult,
  PageAddressRemoval,
  PageAddressKind,
  PageAddressMatch,
  PageAddressRecord,
  PageAddressResolution,
  PropertyCatalogItem,
  PropertyPatchOperation,
  SelectionContext,
  ResolvedBlockReferences,
  VisibleBlock,
  VisibleBlockCollection,
  VirtualOccurrenceRank,
  WorkspaceSnapshot,
  WorkspaceSnapshotView,
} from "./types";

interface BlockRow {
  id: string;
  parent_id: string | null;
  position: number;
  text: string;
  author: BlockAuthor;
  actor_id: string | null;
  session_id: string | null;
  task_id: string | null;
  deleted_at: string | null;
  effective_deleted_root_id: string | null;
  collapsed: number;
  created_at: string;
  updated_at: string;
}

interface PropertyRow {
  block_id: string;
  key: string;
  value: string;
}

interface PageAddressRow {
  normalized_address: string;
  display_address: string;
  block_id: string;
  kind: PageAddressKind;
}

interface PageAddressMatchRow extends PageAddressRow {
  text: string;
}

interface VirtualOccurrenceRankRow {
  view_id: string;
  block_id: string;
  rank: number;
}

interface VisibleBlockRow extends BlockRow {
  depth: number;
  multiline_expanded: number;
  has_children: number;
}

interface LoadedGraph {
  byId: Map<string, Block>;
  byParent: Map<string | null, Block[]>;
  expandedIds: Set<string>;
}

interface LoadedGraphTraversalOptions extends BlockTraversalOptions {
  text?: string;
  stopAfterMatches?: number;
  deletedMode?: "active" | "roots" | "all";
}

function normalizeCreatorProvenance(
  author: BlockAuthor,
  provenance: BlockProvenance | undefined,
): { actorId: string | null; sessionId: string | null; taskId: string | null } {
  if (provenance === undefined) {
    return { actorId: null, sessionId: null, taskId: null };
  }
  if (author !== "agent") {
    throw new Error("Only agent-authored blocks may include agent provenance");
  }

  const normalizeOptionalId = (value: string | undefined, label: string): string | null => {
    if (value === undefined) return null;
    const normalized = value.trim();
    if (!normalized) throw new Error(`${label} cannot be empty`);
    return normalized;
  };
  const actorId = normalizeOptionalId(provenance.actorId, "Provenance actorId");
  if (actorId === null) throw new Error("Provenance actorId cannot be empty");

  return {
    actorId,
    sessionId: normalizeOptionalId(provenance.sessionId, "Provenance sessionId"),
    taskId: normalizeOptionalId(provenance.taskId, "Provenance taskId"),
  };
}

export class OutlinerStore {
  readonly database: Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.database = new Database(path, { create: true });
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.migrate();
    this.seed();
    this.ensureTrashView();
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

  create(
    text: string,
    parentId: string | null = null,
    author: BlockAuthor = "user",
    provenance?: BlockProvenance,
  ): Block {
    if (parentId !== null) this.requireActive(parentId);
    const { actorId, sessionId, taskId } = normalizeCreatorProvenance(author, provenance);
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const positionRow = this.database
      .query("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM blocks WHERE parent_id IS ?")
      .get(parentId) as { position: number };

    this.database.transaction(() => {
      this.database
        .query(
          "INSERT INTO blocks (id, parent_id, position, text, author, actor_id, session_id, task_id, collapsed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
        )
        .run(
          id,
          parentId,
          positionRow.position,
          text,
          author,
          actorId,
          sessionId,
          taskId,
          now,
          now,
        );
      this.replaceProperties(id, parseProperties(text));
      this.bumpSequence();
    })();

    return this.require(id);
  }

  update(id: string, text: string, expectedUpdatedAt?: string): Block {
    const existing = this.requireActive(id);
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

  patchProperties(
    id: string,
    expectedUpdatedAt: string,
    operations: PropertyPatchOperation[],
  ): Block {
    if (operations.length === 0) throw new Error("Property patch requires at least one operation");
    const existing = this.requireActive(id);
    if (existing.updatedAt !== expectedUpdatedAt) {
      throw new Error(`Block changed since editing began: ${id}`);
    }
    const text = patchPropertyText(existing.text, operations);
    return this.update(id, text, expectedUpdatedAt);
  }

  propertyCatalog(
    key?: string,
    prefix = "",
    requestedLimit = 50,
  ): PropertyCatalogItem[] {
    const limit = Math.max(1, Math.min(100, Math.floor(requestedLimit)));
    const normalizedPrefix = prefix.toLowerCase();
    if (key) {
      return this.database
        .query(
          "SELECT property.key, property.value, COUNT(*) AS count FROM block_properties property JOIN blocks block ON block.id = property.block_id WHERE block.effective_deleted_root_id IS NULL AND property.key = ? AND SUBSTR(LOWER(property.value), 1, LENGTH(?)) = ? GROUP BY property.key, property.value ORDER BY count DESC, LOWER(property.value), property.value LIMIT ?",
        )
        .all(key.toLowerCase(), normalizedPrefix, normalizedPrefix, limit) as PropertyCatalogItem[];
    }
    return this.database
      .query(
        "SELECT property.key, property.value, COUNT(*) AS count FROM block_properties property JOIN blocks block ON block.id = property.block_id WHERE block.effective_deleted_root_id IS NULL AND SUBSTR(property.key, 1, LENGTH(?)) = ? GROUP BY property.key, property.value ORDER BY count DESC, property.key, LOWER(property.value), property.value LIMIT ?",
      )
      .all(normalizedPrefix, normalizedPrefix, limit) as PropertyCatalogItem[];
  }

  move(id: string, parentId: string | null, requestedPosition?: number): Block {
    const block = this.requireActive(id);
    if (parentId !== null) {
      this.requireActive(parentId);
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

  delete(id: string): Block {
    const block = this.requireActive(id);
    const deletedAt = new Date().toISOString();
    this.database.transaction(() => {
      this.database.query("UPDATE blocks SET deleted_at = ?, updated_at = ? WHERE id = ?")
        .run(deletedAt, deletedAt, id);
      this.recomputeEffectiveDeletion();
      const selected = this.selectionFromCurrentRead().selected;
      if (selected?.effectiveDeletedRootId) {
        const replacement = this.childrenFromCurrentRead(block.parentId)
          .find((candidate) => !candidate.effectiveDeletedRootId && candidate.id !== id)
          ?? (block.parentId ? this.getFromCurrentRead(block.parentId) : null);
        this.setSelectionFromCurrentRead(
          replacement?.effectiveDeletedRootId ? null : replacement?.id ?? null,
        );
      }
      this.bumpSequence();
    })();
    return this.require(id);
  }

  restore(id: string): Block {
    const block = this.require(id);
    if (!block.deletedAt) throw new Error(`Block is not a direct Trash root: ${id}`);
    let ancestorId = block.parentId;
    while (ancestorId) {
      const ancestor = this.require(ancestorId);
      if (ancestor.deletedAt) {
        throw new Error(`Restore enclosing Trash root first: ${ancestor.id}`);
      }
      ancestorId = ancestor.parentId;
    }
    this.database.transaction(() => {
      this.database.query("UPDATE blocks SET deleted_at = NULL, updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), id);
      this.recomputeEffectiveDeletion();
      for (const blockId of this.subtreeIdsFromCurrentRead(id)) {
        const restored = this.getFromCurrentRead(blockId);
        if (restored && !restored.effectiveDeletedRootId) {
          this.syncDeclaredPageAddresses(blockId, restored.properties);
        }
      }
      this.bumpSequence();
    })();
    return this.require(id);
  }

  purge(id: string, confirmation: string): void {
    const block = this.require(id);
    if (!block.deletedAt) throw new Error(`Block is not a direct Trash root: ${id}`);
    const workId = block.properties.find((property) => property.key === "work-id")?.value;
    const expected = workId ?? block.id.slice(0, 8);
    if (confirmation !== expected) throw new Error(`Permanent purge requires confirmation: ${expected}`);
    this.database.transaction(() => {
      const subtree = this.subtreeIdsFromCurrentRead(id);
      const placeholders = subtree.map(() => "?").join(", ");
      const reserved = this.database.query(
        `SELECT value FROM block_properties WHERE key = 'work-id' AND block_id IN (${placeholders})`,
      ).all(...subtree) as Array<{ value: string }>;
      const reserve = this.database.query(
        "INSERT OR IGNORE INTO reserved_work_ids (work_id, reserved_at) VALUES (?, ?)",
      );
      const now = new Date().toISOString();
      for (const row of reserved) reserve.run(row.value, now);
      this.database.query("DELETE FROM blocks WHERE id = ?").run(id);
      this.recomputeEffectiveDeletion();
      this.bumpSequence();
    })();
  }

  toggle(id: string): Block {
    this.requireActive(id);
    this.database.transaction(() => {
      this.database
        .query("UPDATE blocks SET collapsed = CASE collapsed WHEN 0 THEN 1 ELSE 0 END, updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), id);
      this.bumpSequence();
    })();
    return this.require(id);
  }

  toggleMultilineExpanded(id: string): boolean {
    this.requireActive(id);
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

  reorderVirtualOccurrences(
    viewId: string,
    orderedBlockIds: readonly string[],
  ): VirtualOccurrenceRank[] {
    if (orderedBlockIds.length === 0) {
      throw new Error("Virtual occurrence reorder requires at least one block");
    }
    return this.database.transaction(() => {
      const view = this.getFromCurrentRead(viewId);
      if (!view) throw new Error(`Virtual branch not found: ${viewId}`);
      if (!view.properties.some((property) =>
        property.key.toLowerCase() === "type" && property.value.toLowerCase() === "virtual-branch"
      )) {
        throw new Error(`Block is not a virtual branch: ${viewId}`);
      }

      const orderedBlockIdSet = new Set(orderedBlockIds);
      if (orderedBlockIdSet.size !== orderedBlockIds.length) {
        throw new Error("Virtual occurrence reorder contains duplicate block IDs");
      }
      for (const blockId of orderedBlockIds) {
        if (blockId === viewId) {
          throw new Error("Virtual branch cannot rank itself as an occurrence");
        }
        if (!this.getFromCurrentRead(blockId)) {
          throw new Error(`Virtual occurrence block not found: ${blockId}`);
        }
      }

      const retainedRanks = new Set(
        this.virtualOccurrenceRanksFromCurrentRead()
          .filter((entry) =>
            entry.viewId === viewId && !orderedBlockIdSet.has(entry.blockId)
          )
          .map((entry) => entry.rank),
      );
      const upsert = this.database.query(
        "INSERT INTO virtual_occurrence_ranks (view_id, block_id, rank) VALUES (?, ?, ?) ON CONFLICT(view_id, block_id) DO UPDATE SET rank = excluded.rank",
      );
      let nextRank = 0;
      for (const blockId of orderedBlockIds) {
        while (retainedRanks.has(nextRank)) nextRank += 1;
        upsert.run(viewId, blockId, nextRank);
        nextRank += 1;
      }
      this.bumpSequence();
      return this.virtualOccurrenceRanksFromCurrentRead().filter((entry) => entry.viewId === viewId);
    })();
  }
  resolveBlockReferences(text: string): ResolvedBlockReferences {
    return resolveBlockReferencesWithStatus(text, (blockId) => this.get(blockId));
  }

  resolvePageAddress(address: string): PageAddressResolution {
    return this.database.transaction(() =>
      this.resolvePageAddressFromCurrentRead(normalizePageAddress(address))
    )();
  }

  followPageAddress(
    address: string,
    author: BlockAuthor = "user",
    provenance?: BlockProvenance,
  ): PageAddressFollowResult {
    return this.database.transaction(() => {
      const normalized = normalizePageAddress(address);
      const existing = this.resolvePageAddressFromCurrentRead(normalized);
      if (existing.status !== "missing") return { ...existing, created: false };
      if (isWorkIdAddress(normalized.displayAddress)) {
        throw new Error(`Unresolved Work ID cannot create a page stub: ${normalized.displayAddress}`);
      }

      this.create(
        `${normalized.displayAddress} [page::${normalized.displayAddress}]`,
        null,
        author,
        provenance,
      );
      const created = this.resolvePageAddressFromCurrentRead(normalized);
      if (!created.block) {
        throw new Error(`Created page address did not resolve: ${normalized.displayAddress}`);
      }
      return { ...created, created: true };
    })();
  }

  completePageAddresses(query: string | undefined, requestedLimit: number): PageAddressCollection {
    if (!Number.isInteger(requestedLimit) || requestedLimit <= 0) {
      throw new Error("Page address completion limit must be a positive integer");
    }
    const limit = Math.min(requestedLimit, 100);
    let normalizedQuery = "";
    try {
      normalizedQuery = query?.trim()
        ? normalizePageAddress(query).normalizedAddress
        : "";
    } catch {
      return { addresses: [], completeness: { kind: "complete" } };
    }
    const rows = this.database.query(`
      SELECT address.normalized_address, address.display_address, address.block_id, address.kind, block.text
      FROM page_addresses address
      JOIN blocks block ON block.id = address.block_id
      WHERE block.effective_deleted_root_id IS NULL
        AND INSTR(address.normalized_address, ?) > 0
      ORDER BY
        CASE WHEN SUBSTR(address.normalized_address, 1, LENGTH(?)) = ? THEN 0 ELSE 1 END,
        CASE address.kind WHEN 'page' THEN 0 WHEN 'work-id' THEN 1 ELSE 2 END,
        address.normalized_address,
        address.block_id
      LIMIT ?
    `).all(
      normalizedQuery,
      normalizedQuery,
      normalizedQuery,
      limit + 1,
    ) as PageAddressMatchRow[];
    const complete = rows.length <= limit;
    const addresses: PageAddressMatch[] = rows.slice(0, limit).map((row) => ({
      ...this.pageAddressRecord(row),
      title: firstLineWithoutPropertyTokens(row.text)?.trim() || row.block_id,
    }));
    return {
      addresses,
      completeness: complete ? { kind: "complete" } : { kind: "truncated", limit },
    };
  }

  renamePageAddress(
    blockId: string,
    address: string,
    expectedUpdatedAt: string,
  ): PageAddressRecord {
    const nextAddress = normalizePageAddress(address);
    return this.database.transaction(() => {
      const block = this.getFromCurrentRead(blockId);
      if (!block) throw new Error(`Block not found: ${blockId}`);
      if (block.effectiveDeletedRootId) throw new Error(`Block is in Trash: ${blockId}`);
      if (block.updatedAt !== expectedUpdatedAt) {
        throw new Error(`Block changed since editing began: ${blockId}`);
      }
      const pageTokens = parsePropertyTokens(block.text).filter((token) => token.key === "page");
      if (pageTokens.length !== 1) {
        throw new Error(`Page rename requires exactly one [page::address] declaration: ${blockId}`);
      }
      const nextText = patchPropertyText(block.text, [{
        op: "replace",
        ordinal: pageTokens[0].ordinal,
        value: nextAddress.displayAddress,
      }]);
      const current = this.database.query(
        "SELECT normalized_address, display_address, block_id, kind FROM page_addresses WHERE block_id = ? AND kind = 'page'",
      ).get(blockId) as PageAddressRow | null;
      if (!current) throw new Error(`Block has no registered page address: ${blockId}`);

      const target = this.pageAddressRowFromCurrentRead(nextAddress.normalizedAddress);
      if (target && target.block_id !== blockId) {
        throw new Error(
          `Page address already belongs to block ${target.block_id}: ${nextAddress.displayAddress}`,
        );
      }
      if (target?.kind === "work-id") {
        throw new Error(`Page address conflicts with the block Work ID: ${nextAddress.displayAddress}`);
      }

      if (current.normalized_address === nextAddress.normalizedAddress) {
        this.database.query(
          "UPDATE page_addresses SET display_address = ? WHERE normalized_address = ?",
        ).run(nextAddress.displayAddress, current.normalized_address);
      } else {
        this.database.query(
          "UPDATE page_addresses SET kind = 'alias' WHERE normalized_address = ?",
        ).run(current.normalized_address);
        if (target) {
          this.database.query(
            "UPDATE page_addresses SET display_address = ?, kind = 'page' WHERE normalized_address = ?",
          ).run(nextAddress.displayAddress, nextAddress.normalizedAddress);
        } else {
          this.insertPageAddressFromCurrentRead(blockId, nextAddress.displayAddress, "page");
        }
      }

      const timestamp = new Date(Math.max(Date.now(), Date.parse(block.updatedAt) + 1)).toISOString();
      this.database.query("UPDATE blocks SET text = ?, updated_at = ? WHERE id = ?")
        .run(nextText, timestamp, blockId);
      this.replaceProperties(blockId, parseProperties(nextText));
      this.bumpSequence();
      const renamed: PageAddressRecord = {
        address: nextAddress.displayAddress,
        normalizedAddress: nextAddress.normalizedAddress,
        blockId,
        kind: "page",
      };
      return renamed;
    })();
  }

  addPageAlias(blockId: string, address: string): PageAddressRecord {
    this.requireActive(blockId);
    const normalized = normalizePageAddress(address);
    return this.database.transaction(() => {
      const registered = this.database.query(
        "SELECT 1 FROM page_addresses WHERE block_id = ? LIMIT 1",
      ).get(blockId);
      if (!registered) throw new Error(`Block has no registered symbolic address: ${blockId}`);

      const existing = this.pageAddressRowFromCurrentRead(normalized.normalizedAddress);
      if (existing) {
        if (existing.block_id !== blockId) {
          throw new Error(
            `Page address already belongs to block ${existing.block_id}: ${normalized.displayAddress}`,
          );
        }
        return this.pageAddressRecord(existing);
      }
      const alias = this.insertPageAddressFromCurrentRead(
        blockId,
        normalized.displayAddress,
        "alias",
      );
      this.bumpSequence();
      return alias;
    })();
  }

  removePageAddress(
    blockId: string,
    address: string,
    expectedUpdatedAt: string,
  ): PageAddressRemoval {
    const normalized = normalizePageAddress(address);
    return this.database.transaction(() => {
      const block = this.getFromCurrentRead(blockId);
      if (!block) throw new Error(`Block not found: ${blockId}`);
      if (block.effectiveDeletedRootId) throw new Error(`Block is in Trash: ${blockId}`);
      if (block.updatedAt !== expectedUpdatedAt) {
        throw new Error(`Block changed since editing began: ${blockId}`);
      }
      const row = this.pageAddressRowFromCurrentRead(normalized.normalizedAddress);
      if (!row || row.block_id !== blockId) {
        throw new Error(`Page address is not registered to block ${blockId}: ${normalized.displayAddress}`);
      }
      if (row.kind === "work-id") {
        throw new Error(`Work IDs cannot be removed through pages.remove: ${normalized.displayAddress}`);
      }
      const removed = this.pageAddressRecord(row);
      this.database.query("DELETE FROM page_addresses WHERE normalized_address = ?")
        .run(row.normalized_address);

      let updated = block;
      if (row.kind === "page") {
        const token = parsePropertyTokens(block.text).find((candidate) =>
          candidate.key === "page" &&
          normalizePageAddress(candidate.value).normalizedAddress === row.normalized_address
        );
        if (!token) throw new Error(`Block has no matching page declaration: ${blockId}`);
        const nextText = patchPropertyText(block.text, [{ op: "remove", ordinal: token.ordinal }]);
        const timestamp = new Date(Math.max(Date.now(), Date.parse(block.updatedAt) + 1)).toISOString();
        this.database.query("UPDATE blocks SET text = ?, updated_at = ? WHERE id = ?")
          .run(nextText, timestamp, blockId);
        this.replaceProperties(blockId, parseProperties(nextText));
        updated = this.getFromCurrentRead(blockId)!;
      }
      this.bumpSequence();
      return { removed, block: updated };
    })();
  }

  get(id: string): Block | null {
    return this.database.transaction(() => this.getFromCurrentRead(id))();
  }

  require(id: string): Block {
    const block = this.get(id);
    if (!block) throw new Error(`Block not found: ${id}`);
    return block;
  }

  requireActive(id: string): Block {
    const block = this.require(id);
    if (block.effectiveDeletedRootId) throw new Error(`Block is in Trash: ${id}`);
    return block;
  }

  children(parentId: string | null): Block[] {
    return this.database.transaction(() => this.childrenFromCurrentRead(parentId))();
  }

  traversePreorder(options: BlockTraversalOptions): VisibleBlock[] {
    return this.database.transaction(() =>
      this.traverseLoadedGraph(this.loadGraph(), options)
    )();
  }

  queryBlocks(query: BlockSearchQuery): VisibleBlockCollection {
    const limit = query?.limit;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) {
      throw new Error("Block search limit must be a positive integer");
    }

    return this.database.transaction((): VisibleBlockCollection => {
      const deletedFilter = query.filters?.find((filter) =>
        filter.key === "deleted" && filter.value?.toLowerCase() === "true"
      );
      const filters = query.filters?.filter((filter) => filter !== deletedFilter);
      const deletedMode = query.includeDeleted ?? (deletedFilter ? "roots" : "active");
      if (query.rankViewId && deletedMode === "active") {
        return this.queryRankedBlocksFromCurrentRead(
          { ...query, filters },
          query.rankViewId,
        );
      }
      const blocks = this.traverseLoadedGraph(this.loadGraph(), {
        filters,
        subtreeRootId: query.subtreeRootId,
        collapsedDescendants: "traverse",
        text: query.text,
        stopAfterMatches: limit + 1,
        deletedMode,
      });
      if (blocks.length <= limit) {
        return { blocks, completeness: { kind: "complete" } };
      }
      return {
        blocks: blocks.slice(0, limit),
        completeness: { kind: "truncated", limit },
      };
    })();
  }

  readWorkspaceSnapshot(view: WorkspaceSnapshotView = {}): WorkspaceSnapshot {
    return this.database.transaction((): WorkspaceSnapshot => {
      const graph = this.loadGraph();
      const visible = this.traverseLoadedGraph(graph, {
        filters: view.filters,
        collapsedDescendants: view.filters?.length ? "traverse" : "prune",
      });
      const physical = this.traverseLoadedGraph(graph, {
        collapsedDescendants: "traverse",
      });

      return {
        visible: { blocks: visible, completeness: { kind: "complete" } },
        physical: { blocks: physical, completeness: { kind: "complete" } },
        selection: this.selectionFromGraph(graph),
        sequence: this.sequence,
        virtualOccurrenceRanks: this.virtualOccurrenceRanksFromCurrentRead(),
      };
    })();
  }

  getSelection(): SelectionContext {
    return this.database.transaction(() => this.selectionFromCurrentRead())();
  }

  setSelection(blockId: string | null): SelectionContext {
    return this.database.transaction(() => this.setSelectionFromCurrentRead(blockId))();
  }

  navigationState(): NavigationState {
    return this.database.transaction(() => this.navigationStateFromCurrentRead())();
  }

  navigateHistory(direction: "back" | "forward"): NavigationState {
    return this.database.transaction(() => {
      const cursor = this.navigationCursorFromCurrentRead();
      const currentId = this.selectionFromCurrentRead().selected?.id ?? null;
      const comparison = direction === "back" ? "<" : ">";
      const ordering = direction === "back" ? "DESC" : "ASC";
      const target = this.database.query(
        `SELECT entry_id, block_id FROM navigation_history
         WHERE entry_id ${comparison} ? AND block_id IS NOT NULL
           AND (? IS NULL OR block_id <> ?)
         ORDER BY entry_id ${ordering} LIMIT 1`,
      ).get(cursor, currentId, currentId) as { entry_id: number; block_id: string } | null;
      if (!target) return this.navigationStateFromCurrentRead();
      this.setNavigationCursorFromCurrentRead(target.entry_id);
      this.database.query("UPDATE selection SET block_id = ? WHERE singleton = 1")
        .run(target.block_id);
      return this.navigationStateFromCurrentRead();
    })();
  }

  private getFromCurrentRead(id: string): Block | null {
    const row = this.database.query("SELECT * FROM blocks WHERE id = ?").get(id) as BlockRow | null;
    return row ? this.hydrate(row) : null;
  }

  private childrenFromCurrentRead(
    parentId: string | null,
    includeDeleted = false,
  ): Block[] {
    const rows = this.database
      .query(
        `SELECT * FROM blocks WHERE parent_id IS ? ${
          includeDeleted ? "" : "AND effective_deleted_root_id IS NULL"
        } ORDER BY position, created_at`,
      )
      .all(parentId) as BlockRow[];
    return rows.map((row) => this.hydrate(row));
  }

  private queryRankedBlocksFromCurrentRead(
    query: BlockSearchQuery,
    rankViewId: string,
  ): VisibleBlockCollection {
    const parameters: Array<string | number> = [];
    const rootQuery = query.subtreeRootId
      ? "SELECT id, 0, printf('%010d:%s', position, created_at) FROM blocks WHERE id = ?"
      : "SELECT id, 0, printf('%010d:%s', position, created_at) FROM blocks WHERE parent_id IS NULL";
    if (query.subtreeRootId) parameters.push(query.subtreeRootId);
    parameters.push(rankViewId);
    const predicates: string[] = [];
    for (const filter of query.filters ?? []) {
      if (filter.value === undefined) {
        predicates.push(
          "EXISTS (SELECT 1 FROM block_properties property WHERE property.block_id = block.id AND property.key = ?)",
        );
        parameters.push(filter.key);
      } else {
        predicates.push(
          "EXISTS (SELECT 1 FROM block_properties property WHERE property.block_id = block.id AND property.key = ? AND LOWER(property.value) = LOWER(?))",
        );
        parameters.push(filter.key, filter.value);
      }
    }
    predicates.push("block.effective_deleted_root_id IS NULL");
    if (query.text) {
      predicates.push("INSTR(LOWER(block.text), LOWER(?)) > 0");
      parameters.push(query.text);
    }
    parameters.push(query.limit + 1);

    const where = predicates.length > 0 ? `WHERE ${predicates.join(" AND ")}` : "";
    const rows = this.database
      .query(`
        WITH RECURSIVE tree(id, depth, sort_path) AS (
          ${rootQuery}
          UNION ALL
          SELECT
            child.id,
            tree.depth + 1,
            tree.sort_path || '/' || printf('%010d:%s', child.position, child.created_at)
          FROM blocks child
          JOIN tree ON child.parent_id = tree.id
        )
        SELECT
          block.*,
          tree.depth,
          COALESCE(view_state.multiline_expanded, 0) AS multiline_expanded,
          EXISTS (
            SELECT 1 FROM blocks child
            WHERE child.parent_id = block.id AND child.effective_deleted_root_id IS NULL
          ) AS has_children
        FROM tree
        JOIN blocks block ON block.id = tree.id
        LEFT JOIN block_view_state view_state ON view_state.block_id = block.id
        LEFT JOIN virtual_occurrence_ranks occurrence_rank
          ON occurrence_rank.view_id = ? AND occurrence_rank.block_id = block.id
        ${where}
        ORDER BY
          CASE WHEN occurrence_rank.rank IS NULL THEN 1 ELSE 0 END,
          occurrence_rank.rank,
          CASE WHEN occurrence_rank.rank IS NULL THEN tree.sort_path ELSE block.id END
        LIMIT ?
      `)
      .all(...parameters) as VisibleBlockRow[];
    const blocks = this.hydrateVisibleRowsFromCurrentRead(rows.slice(0, query.limit));
    return {
      blocks,
      completeness: rows.length > query.limit
        ? { kind: "truncated", limit: query.limit }
        : { kind: "complete" },
    };
  }

  private hydrateVisibleRowsFromCurrentRead(rows: readonly VisibleBlockRow[]): VisibleBlock[] {
    if (rows.length === 0) return [];
    const placeholders = rows.map(() => "?").join(", ");
    const propertyRows = this.database
      .query(
        `SELECT block_id, key, value FROM block_properties WHERE block_id IN (${placeholders}) ORDER BY block_id, ordinal`,
      )
      .all(...rows.map((row) => row.id)) as PropertyRow[];
    const propertiesByBlock = new Map<string, BlockProperty[]>();
    for (const row of propertyRows) {
      const properties = propertiesByBlock.get(row.block_id);
      if (properties) properties.push({ key: row.key, value: row.value });
      else propertiesByBlock.set(row.block_id, [{ key: row.key, value: row.value }]);
    }
    return rows.map((row) => {
      const block = this.hydrate(row, propertiesByBlock.get(row.id) ?? []);
      return {
        ...block,
        depth: row.depth,
        multilineExpanded: row.multiline_expanded === 1,
        hasChildren: row.has_children === 1,
        displayText: resolveBlockReferenceText(
          block.text,
          (blockId) => this.getFromCurrentRead(blockId),
        ),
      };
    });
  }
  private navigationCursorFromCurrentRead(): number {
    const row = this.database.query(
      "SELECT value FROM metadata WHERE key = 'navigation_cursor'",
    ).get() as { value: string } | null;
    return Number(row?.value ?? 0);
  }

  private setNavigationCursorFromCurrentRead(entryId: number): void {
    this.database.query(
      "INSERT INTO metadata (key, value) VALUES ('navigation_cursor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(String(entryId));
  }

  private setSelectionFromCurrentRead(blockId: string | null): SelectionContext {
    if (blockId !== null && !this.getFromCurrentRead(blockId)) {
      throw new Error(`Block not found: ${blockId}`);
    }
    const currentId = this.selectionFromCurrentRead().selected?.id ?? null;
    if (blockId !== currentId) {
      if (currentId) this.recordNavigationFromCurrentRead(currentId);
      if (blockId) this.recordNavigationFromCurrentRead(blockId);
      this.database.query("UPDATE selection SET block_id = ? WHERE singleton = 1").run(blockId);
    }
    return this.selectionFromCurrentRead();
  }

  private recordNavigationFromCurrentRead(blockId: string): void {
    const cursor = this.navigationCursorFromCurrentRead();
    const current = this.database.query(
      "SELECT block_id FROM navigation_history WHERE entry_id = ?",
    ).get(cursor) as { block_id: string | null } | null;
    if (current?.block_id === blockId) return;
    this.database.query("DELETE FROM navigation_history WHERE entry_id > ?").run(cursor);
    const result = this.database.query(
      "INSERT INTO navigation_history (block_id) VALUES (?)",
    ).run(blockId);
    this.setNavigationCursorFromCurrentRead(Number(result.lastInsertRowid));
    this.database.query(
      "DELETE FROM navigation_history WHERE entry_id NOT IN (SELECT entry_id FROM navigation_history ORDER BY entry_id DESC LIMIT 200)",
    ).run();
  }

  private navigationStateFromCurrentRead(): NavigationState {
    const cursor = this.navigationCursorFromCurrentRead();
    const currentId = this.selectionFromCurrentRead().selected?.id ?? null;
    const canBack = this.database.query(
      "SELECT 1 FROM navigation_history WHERE entry_id < ? AND block_id IS NOT NULL AND (? IS NULL OR block_id <> ?) LIMIT 1",
    ).get(cursor, currentId, currentId) !== null;
    const canForward = this.database.query(
      "SELECT 1 FROM navigation_history WHERE entry_id > ? AND block_id IS NOT NULL AND (? IS NULL OR block_id <> ?) LIMIT 1",
    ).get(cursor, currentId, currentId) !== null;
    return {
      selection: this.selectionFromCurrentRead(),
      canBack,
      canForward,
    };
  }


  private virtualOccurrenceRanksFromCurrentRead(): VirtualOccurrenceRank[] {
    const rows = this.database
      .query(
        "SELECT view_id, block_id, rank FROM virtual_occurrence_ranks ORDER BY view_id, rank, block_id",
      )
      .all() as VirtualOccurrenceRankRow[];
    return rows.map((row) => ({
      viewId: row.view_id,
      blockId: row.block_id,
      rank: row.rank,
    }));
  }

  private selectionFromCurrentRead(): SelectionContext {
    const row = this.database.query("SELECT block_id FROM selection WHERE singleton = 1").get() as
      | { block_id: string | null }
      | null;
    const selected = row?.block_id ? this.getFromCurrentRead(row.block_id) : null;
    if (!selected) return { selected: null, ancestors: [], children: [] };

    const ancestors: Block[] = [];
    let parentId = selected.parentId;
    while (parentId) {
      const parent = this.getFromCurrentRead(parentId);
      if (!parent) break;
      ancestors.unshift(parent);
      parentId = parent.parentId;
    }
    return {
      selected,
      ancestors,
      children: this.childrenFromCurrentRead(
        selected.id,
        Boolean(selected.effectiveDeletedRootId),
      ),
    };
  }

  private loadGraph(): LoadedGraph {
    const rows = this.database.query("SELECT * FROM blocks ORDER BY position, created_at").all() as BlockRow[];
    const propertyRows = this.database
      .query("SELECT block_id, key, value FROM block_properties ORDER BY block_id, ordinal")
      .all() as PropertyRow[];
    const propertiesByBlock = new Map<string, BlockProperty[]>();
    for (const { block_id: blockId, key, value } of propertyRows) {
      const properties = propertiesByBlock.get(blockId);
      if (properties) {
        properties.push({ key, value });
      } else {
        propertiesByBlock.set(blockId, [{ key, value }]);
      }
    }

    const blocks = rows.map((row) => this.hydrate(row, propertiesByBlock.get(row.id) ?? []));
    const byId = new Map<string, Block>();
    const byParent = new Map<string | null, Block[]>();
    for (const block of blocks) {
      byId.set(block.id, block);
      const siblings = byParent.get(block.parentId);
      if (siblings) {
        siblings.push(block);
      } else {
        byParent.set(block.parentId, [block]);
      }
    }
    const expandedRows = this.database
      .query("SELECT block_id FROM block_view_state WHERE multiline_expanded = 1")
      .all() as Array<{ block_id: string }>;
    const expandedIds = new Set<string>();
    for (const row of expandedRows) expandedIds.add(row.block_id);

    return { byId, byParent, expandedIds };
  }

  private traverseLoadedGraph(
    graph: LoadedGraph,
    options: LoadedGraphTraversalOptions,
  ): VisibleBlock[] {
    const blocks: VisibleBlock[] = [];
    const filterText = options.text?.toLowerCase();
    const deletedMode = options.deletedMode ?? "active";
    const visit = (block: Block, depth: number): boolean => {
      const effectivelyDeleted = Boolean(block.effectiveDeletedRootId);
      if (deletedMode === "active" && effectivelyDeleted) return false;
      let deletionMatches: boolean;
      switch (deletedMode) {
        case "active":
          deletionMatches = !effectivelyDeleted;
          break;
        case "roots":
          deletionMatches = Boolean(block.deletedAt);
          break;
        case "all":
          deletionMatches = effectivelyDeleted;
          break;
      }
      const matches =
        deletionMatches &&
        (!options.filters?.length || matchesFilters(block.properties, options.filters)) &&
        (!filterText || block.text.toLowerCase().includes(filterText));
      if (matches) {
        const children = (graph.byParent.get(block.id) ?? []).filter((child) =>
          deletedMode === "active" ? !child.effectiveDeletedRootId : true
        );
        blocks.push({
          ...block,
          depth,
          multilineExpanded: graph.expandedIds.has(block.id),
          hasChildren: children.length > 0,
          ...(block.deletedAt
            ? {
                deletedDescendantCount: [...graph.byId.values()].filter(
                  (candidate) =>
                    candidate.id !== block.id &&
                    candidate.effectiveDeletedRootId === block.id,
                ).length,
              }
            : {}),
          displayText: resolveBlockReferenceText(
            block.text,
            (blockId) => graph.byId.get(blockId) ?? null,
          ),
        });
        if (options.stopAfterMatches !== undefined && blocks.length >= options.stopAfterMatches) {
          return true;
        }
      }

      if (!block.collapsed || options.collapsedDescendants === "traverse") {
        for (const child of graph.byParent.get(block.id) ?? []) {
          if (visit(child, depth + 1)) return true;
        }
      }
      return false;
    };

    if (options.subtreeRootId) {
      const root = graph.byId.get(options.subtreeRootId);
      if (root) visit(root, 0);
    } else {
      for (const root of graph.byParent.get(null) ?? []) {
        if (visit(root, 0)) break;
      }
    }
    return blocks;
  }

  private selectionFromGraph(graph: LoadedGraph): SelectionContext {
    const row = this.database.query("SELECT block_id FROM selection WHERE singleton = 1").get() as
      | { block_id: string | null }
      | null;
    const selected = row?.block_id ? graph.byId.get(row.block_id) ?? null : null;
    if (!selected) return { selected: null, ancestors: [], children: [] };

    const ancestors: Block[] = [];
    let parentId = selected.parentId;
    while (parentId) {
      const parent = graph.byId.get(parentId);
      if (!parent) break;
      ancestors.unshift(parent);
      parentId = parent.parentId;
    }
    return {
      selected,
      ancestors,
      children: graph.byParent.get(selected.id) ?? [],
    };
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS blocks (
        id TEXT PRIMARY KEY,
        parent_id TEXT REFERENCES blocks(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        text TEXT NOT NULL,
        author TEXT NOT NULL CHECK (author IN ('user', 'agent', 'system')),
        actor_id TEXT,
        session_id TEXT,
        task_id TEXT,
        collapsed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        effective_deleted_root_id TEXT
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
      CREATE TABLE IF NOT EXISTS navigation_history (
        entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
        block_id TEXT REFERENCES blocks(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS navigation_history_block
        ON navigation_history(block_id, entry_id);
      INSERT OR IGNORE INTO metadata (key, value) VALUES ('navigation_cursor', '0');
      CREATE TABLE IF NOT EXISTS block_view_state (
        block_id TEXT PRIMARY KEY REFERENCES blocks(id) ON DELETE CASCADE,
        multiline_expanded INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS virtual_occurrence_ranks (
        view_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
        block_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
        rank INTEGER NOT NULL CHECK (rank >= 0),
        PRIMARY KEY (view_id, block_id),
        CHECK (view_id <> block_id)
      );
      CREATE INDEX IF NOT EXISTS virtual_occurrence_ranks_order
        ON virtual_occurrence_ranks(view_id, rank, block_id);
      CREATE TABLE IF NOT EXISTS reserved_work_ids (
        work_id TEXT PRIMARY KEY,
        reserved_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS page_addresses (
        normalized_address TEXT PRIMARY KEY,
        display_address TEXT NOT NULL,
        block_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('page', 'alias', 'work-id'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS page_addresses_primary_per_block
        ON page_addresses(block_id) WHERE kind = 'page';
      CREATE UNIQUE INDEX IF NOT EXISTS page_addresses_work_id_per_block
        ON page_addresses(block_id) WHERE kind = 'work-id';
    `);
    this.migrateBlockStateColumns();
    this.migratePropertyIndex();
    this.migrateWorkIdReservations();
    this.migratePageAddressRegistry();
    this.migrateNavigationHistory();
  }

  private migrateBlockStateColumns(): void {
    this.database.transaction(() => {
      const existingColumns = new Set(
        (
          this.database.query("PRAGMA table_info(blocks)").all() as Array<{ name: string }>
        ).map((column) => column.name),
      );
      const needsEffectiveDeletionBackfill = !existingColumns.has("effective_deleted_root_id");
      const textColumns = [
        "actor_id",
        "session_id",
        "task_id",
        "deleted_at",
        "effective_deleted_root_id",
      ] as const;
      for (const name of textColumns) {
        if (!existingColumns.has(name)) {
          this.database.exec(`ALTER TABLE blocks ADD COLUMN ${name} TEXT`);
        }
      }
      this.database.exec(
        "CREATE INDEX IF NOT EXISTS blocks_effective_deleted ON blocks(effective_deleted_root_id, deleted_at)",
      );
      if (needsEffectiveDeletionBackfill) this.recomputeEffectiveDeletion();
    })();
  }
  private migrateNavigationHistory(): void {
    const count = this.database.query(
      "SELECT COUNT(*) AS count FROM navigation_history",
    ).get() as { count: number };
    if (count.count > 0) return;
    const selected = this.database.query(
      "SELECT block_id FROM selection WHERE singleton = 1",
    ).get() as { block_id: string | null } | null;
    if (selected?.block_id) this.recordNavigationFromCurrentRead(selected.block_id);
  }


  private migratePropertyIndex(): void {
    this.database.transaction(() => {
      const versionRow = this.database
        .query("SELECT value FROM metadata WHERE key = 'property_parser_version'")
        .get() as { value: string } | null;
      const storedVersion = versionRow ? Number(versionRow.value) : 0;
      if (!Number.isInteger(storedVersion) || storedVersion < 0) {
        throw new Error(`Invalid property parser version: ${versionRow?.value}`);
      }
      if (storedVersion > PROPERTY_PARSER_VERSION) {
        throw new Error(
          `Database property parser version ${storedVersion} is newer than supported version ${PROPERTY_PARSER_VERSION}`,
        );
      }
      if (storedVersion === PROPERTY_PARSER_VERSION) return;

      const existingBlocks = this.database.query("SELECT id, text FROM blocks ORDER BY id").all() as Array<{
        id: string;
        text: string;
      }>;
      this.database.query("DELETE FROM block_properties").run();
      for (const block of existingBlocks) {
        this.replaceProperties(block.id, parseProperties(block.text));
      }
      this.database
        .query(
          "INSERT INTO metadata (key, value) VALUES ('property_parser_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(String(PROPERTY_PARSER_VERSION));
      if (existingBlocks.length > 0) this.bumpSequence();
    })();
  }

  private migrateWorkIdReservations(): void {
    const now = new Date().toISOString();
    this.database.query(
      "INSERT OR IGNORE INTO reserved_work_ids (work_id, reserved_at) SELECT value, ? FROM block_properties WHERE key = 'work-id'",
    ).run(now);
  }

  private migratePageAddressRegistry(): void {
    this.database.transaction(() => {
      const versionRow = this.database.query(
        "SELECT value FROM metadata WHERE key = 'page_address_registry_version'",
      ).get() as { value: string } | null;
      const version = versionRow ? Number(versionRow.value) : 0;
      if (
        !Number.isInteger(version) ||
        version < 0 ||
        version > PAGE_ADDRESS_REGISTRY_VERSION
      ) {
        throw new Error(`Unsupported page address registry version: ${versionRow?.value}`);
      }
      if (version === PAGE_ADDRESS_REGISTRY_VERSION) return;

      const aliases = this.database.query(
        "SELECT normalized_address, display_address, block_id, kind FROM page_addresses WHERE kind = 'alias' ORDER BY normalized_address",
      ).all() as PageAddressRow[];
      this.database.query("DELETE FROM page_addresses").run();
      const rows = this.database.query(
        "SELECT property.block_id, property.key, property.value FROM block_properties property JOIN blocks block ON block.id = property.block_id WHERE block.effective_deleted_root_id IS NULL AND property.key IN ('page', 'work-id') ORDER BY property.block_id, property.ordinal",
      ).all() as PropertyRow[];
      const propertiesByBlock = new Map<string, BlockProperty[]>();
      for (const row of rows) {
        const properties = propertiesByBlock.get(row.block_id) ?? [];
        properties.push({ key: row.key, value: row.value });
        propertiesByBlock.set(row.block_id, properties);
      }
      for (const [blockId, properties] of propertiesByBlock) {
        this.syncDeclaredPageAddresses(blockId, properties);
      }
      for (const alias of aliases) {
        const normalized = normalizePageAddress(alias.display_address);
        const existing = this.pageAddressRowFromCurrentRead(normalized.normalizedAddress);
        if (existing) {
          if (existing.block_id === alias.block_id) continue;
          throw new Error(
            `Page alias migration conflicts with block ${existing.block_id}: ${alias.display_address}`,
          );
        }
        this.insertPageAddressFromCurrentRead(alias.block_id, alias.display_address, "alias");
      }
      this.database.query(
        "INSERT INTO metadata (key, value) VALUES ('page_address_registry_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(String(PAGE_ADDRESS_REGISTRY_VERSION));
    })();
  }

  private ensureTrashView(): void {
    const existing = this.queryBlocks({
      filters: [{ key: "system-view", value: "trash" }],
      limit: 1,
    }).blocks[0];
    if (existing) return;
    this.create(
      "Trash [type::virtual-branch] [system-view::trash] [query::deleted=true] [limit::200]",
      null,
      "system",
    );
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

  private hydrate(row: BlockRow, properties?: BlockProperty[]): Block {
    const hydratedProperties =
      properties ??
      (
        this.database
          .query("SELECT block_id, key, value FROM block_properties WHERE block_id = ? ORDER BY ordinal")
          .all(row.id) as PropertyRow[]
      ).map(({ key, value }) => ({ key, value }));
    return {
      id: row.id,
      parentId: row.parent_id,
      position: row.position,
      text: row.text,
      author: row.author,
      ...(row.actor_id ? { actorId: row.actor_id } : {}),
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      ...(row.task_id ? { taskId: row.task_id } : {}),
      collapsed: row.collapsed === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
      ...(row.effective_deleted_root_id
        ? { effectiveDeletedRootId: row.effective_deleted_root_id }
        : {}),
      properties: hydratedProperties,
    };
  }

  private resolvePageAddressFromCurrentRead(
    normalized: NormalizedPageAddress,
  ): PageAddressResolution {
    const row = this.pageAddressRowFromCurrentRead(normalized.normalizedAddress);
    if (!row) {
      return {
        address: normalized.displayAddress,
        normalizedAddress: normalized.normalizedAddress,
        status: "missing",
      };
    }
    const block = this.getFromCurrentRead(row.block_id);
    if (!block) {
      throw new Error(`Page address points to missing block: ${row.normalized_address}`);
    }
    return {
      address: normalized.displayAddress,
      normalizedAddress: normalized.normalizedAddress,
      status: block.effectiveDeletedRootId ? "deleted" : "resolved",
      registeredAddress: row.display_address,
      kind: row.kind,
      block,
      ...(block.effectiveDeletedRootId
        ? { deletionRootId: block.effectiveDeletedRootId }
        : {}),
    };
  }

  private pageAddressRowFromCurrentRead(normalizedAddress: string): PageAddressRow | null {
    return this.database.query(
      "SELECT normalized_address, display_address, block_id, kind FROM page_addresses WHERE normalized_address = ?",
    ).get(normalizedAddress) as PageAddressRow | null;
  }

  private pageAddressRecord(row: PageAddressRow): PageAddressRecord {
    return {
      address: row.display_address,
      normalizedAddress: row.normalized_address,
      blockId: row.block_id,
      kind: row.kind,
    };
  }

  private insertPageAddressFromCurrentRead(
    blockId: string,
    address: string,
    kind: PageAddressKind,
  ): PageAddressRecord {
    const normalized = normalizePageAddress(address);
    const existing = this.pageAddressRowFromCurrentRead(normalized.normalizedAddress);
    if (existing) {
      throw new Error(
        `Page address already belongs to block ${existing.block_id}: ${normalized.displayAddress}`,
      );
    }
    this.database.query(
      "INSERT INTO page_addresses (normalized_address, display_address, block_id, kind) VALUES (?, ?, ?, ?)",
    ).run(normalized.normalizedAddress, normalized.displayAddress, blockId, kind);
    return {
      address: normalized.displayAddress,
      normalizedAddress: normalized.normalizedAddress,
      blockId,
      kind,
    };
  }

  private syncDeclaredPageAddresses(blockId: string, properties: BlockProperty[]): void {
    const pageValues = properties
      .filter((property) => property.key === "page")
      .map((property) => property.value);
    const workIdValues = properties
      .filter((property) => property.key === "work-id")
      .map((property) => property.value);
    if (pageValues.length > 1) {
      throw new Error(`Block may declare at most one page address: ${blockId}`);
    }
    if (workIdValues.length > 1) {
      throw new Error(`Block may declare at most one Work ID: ${blockId}`);
    }

    const page = pageValues[0] ? normalizePageAddress(pageValues[0]) : null;
    const workId = workIdValues[0] ? normalizePageAddress(workIdValues[0]) : null;
    if (page && workId && page.normalizedAddress === workId.normalizedAddress) {
      throw new Error(`Page address duplicates the block Work ID: ${page.displayAddress}`);
    }
    this.syncDeclaredPageAddressKind(blockId, "page", page);
    this.syncDeclaredPageAddressKind(blockId, "work-id", workId);
  }

  private syncDeclaredPageAddressKind(
    blockId: string,
    kind: Extract<PageAddressKind, "page" | "work-id">,
    desired: NormalizedPageAddress | null,
  ): void {
    const current = this.database.query(
      "SELECT normalized_address, display_address, block_id, kind FROM page_addresses WHERE block_id = ? AND kind = ?",
    ).get(blockId, kind) as PageAddressRow | null;
    if (!current) {
      if (desired) this.insertPageAddressFromCurrentRead(blockId, desired.displayAddress, kind);
      return;
    }
    if (!desired) {
      if (kind === "work-id") {
        throw new Error(`Work IDs are immutable once registered: ${blockId}`);
      }
      throw new Error(`Page address removal requires pages.remove: ${blockId}`);
    }
    if (current.normalized_address !== desired.normalizedAddress) {
      if (kind === "page") {
        throw new Error(`Page address changes require pages.rename: ${blockId}`);
      }
      throw new Error(`Work IDs are immutable once registered: ${blockId}`);
    }
    if (current.display_address !== desired.displayAddress) {
      this.database.query(
        "UPDATE page_addresses SET display_address = ? WHERE normalized_address = ?",
      ).run(desired.displayAddress, desired.normalizedAddress);
    }
  }

  private replaceProperties(blockId: string, properties: BlockProperty[]): void {
    this.database.query("DELETE FROM block_properties WHERE block_id = ?").run(blockId);
    const insert = this.database.query(
      "INSERT INTO block_properties (block_id, key, value, ordinal) VALUES (?, ?, ?, ?)",
    );
    properties.forEach((property, ordinal) => insert.run(blockId, property.key, property.value, ordinal));
    this.syncDeclaredPageAddresses(blockId, properties);
    const reserve = this.database.query(
      "INSERT OR IGNORE INTO reserved_work_ids (work_id, reserved_at) VALUES (?, ?)",
    );
    for (const property of properties) {
      if (property.key === "work-id") reserve.run(property.value, new Date().toISOString());
    }
  }

  private subtreeIdsFromCurrentRead(rootId: string): string[] {
    const rows = this.database.query(`
      WITH RECURSIVE subtree(id) AS (
        SELECT id FROM blocks WHERE id = ?
        UNION ALL
        SELECT block.id FROM blocks block JOIN subtree ON block.parent_id = subtree.id
      )
      SELECT id FROM subtree
    `).all(rootId) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  private recomputeEffectiveDeletion(): void {
    const rows = this.database
      .query("SELECT id, parent_id, deleted_at FROM blocks ORDER BY position, created_at")
      .all() as Array<{ id: string; parent_id: string | null; deleted_at: string | null }>;
    const children = new Map<string | null, typeof rows>();
    for (const row of rows) {
      const siblings = children.get(row.parent_id);
      if (siblings) siblings.push(row);
      else children.set(row.parent_id, [row]);
    }
    const update = this.database.query(
      "UPDATE blocks SET effective_deleted_root_id = ? WHERE id = ?",
    );
    const visit = (row: (typeof rows)[number], inheritedRoot: string | null): void => {
      const effectiveRoot = row.deleted_at ? row.id : inheritedRoot;
      update.run(effectiveRoot, row.id);
      for (const child of children.get(row.id) ?? []) visit(child, effectiveRoot);
    };
    for (const root of children.get(null) ?? []) visit(root, null);
  }

  private normalizePositions(parentId: string | null): void {
    const siblings = this.childrenFromCurrentRead(parentId);
    const update = this.database.query("UPDATE blocks SET position = ? WHERE id = ?");
    siblings.forEach((sibling, index) => update.run(index, sibling.id));
  }

  private isDescendant(candidateId: string, ancestorId: string): boolean {
    return this.database.transaction(() => {
      let current = this.getFromCurrentRead(candidateId);
      while (current?.parentId) {
        if (current.parentId === ancestorId) return true;
        current = this.getFromCurrentRead(current.parentId);
      }
      return false;
    })();
  }

  private bumpSequence(): void {
    this.database.query("UPDATE metadata SET value = CAST(value AS INTEGER) + 1 WHERE key = 'sequence'").run();
  }
}
