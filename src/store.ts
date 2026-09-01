import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { resolveBacklinkRelation } from "./backlinks";
import {
  normalizeBlockSearchQuery,
  parsePropertyFilterExpression,
} from "./block-query";
import {
  firstLineWithoutPropertyTokens,
  formatProperty,
  matchingPropertyRecords,
  matchesFilters,
  parsePropertyRecords,
  patchPropertyText,
  PROPERTY_PARSER_VERSION,
} from "./properties";
import {
  normalizePageAddress,
  PAGE_ADDRESS_REGISTRY_VERSION,
  tryNormalizePageAddress,
  type NormalizedPageAddress,
} from "./page-addresses";
import {
  resolveBlockReferences as resolveBlockReferenceText,
  resolveBlockReferencesWithStatus,
} from "./references";
import {
  formatWorkId,
  isConfiguredWorkIdPlaceholder,
  normalizeWorkIdPrefix,
  parseWorkId,
  workIdReferences,
  type ParsedWorkId,
} from "./work-ids";
import type {
  BacklinkCollection,
  BacklinkQuery,
  Block,
  BlockAuthor,
  BlockProperty,
  BlockProvenance,
  BlockEditActivity,
  BlockEditActivityPage,
  BlockSearchQuery,
  BlockTraversalOptions,
  CaptureReceipt,
  CaptureSource,
  NavigationState,
  MutationProvenance,
  PageAddressCollection,
  PageAddressFollowResult,
  PageAddressKind,
  PageAddressMatch,
  PageAddressRecord,
  PageAddressRemoval,
  PageAddressResolution,
  PropertyCatalogItem,
  PropertyFilter,
  PropertyPlacement,
  PropertyQueryScope,
  PropertyRecord,
  PropertyScope,
  PropertySyntax,
  PropertyPatchOperation,
  ResolvedBlockReferences,
  RoadmapBranchMembership,
  RoadmapItemCreateInput,
  RoadmapItemCreateReceipt,
  RoadmapItemPriority,
  RoadmapWorkStage,
  SelectionContext,
  VirtualOccurrenceRank,
  VisibleBlock,
  VisibleBlockCollection,
  WorkIdAllocation,
  WorkIdAllocatorStatus,
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
  created_at: string;
  updated_at: string;
}

interface CaptureRequestRow {
  block_id: string;
  inbox_block_id: string;
}

interface PropertyRow {
  block_id: string;
  key: string;
  value: string;
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

interface PageAddressRow {
  normalized_address: string;
  display_address: string;
  block_id: string;
  kind: PageAddressKind;
}

interface PageAddressMatchRow extends PageAddressRow {
  text: string;
}

interface WorkIdAllocatorRow {
  prefix: string;
  next_number: number;
}

interface VirtualOccurrenceRankRow {
  view_id: string;
  block_id: string;
  rank: number;
}

interface VisibleBlockRow extends BlockRow {
  depth: number;
  has_children: number;
}

interface BlockEditActivityRow {
  activity_id: number;
  block_id: string;
  author: BlockAuthor;
  actor_id: string | null;
  session_id: string | null;
  task_id: string | null;
  kind: "text" | "properties";
  edited_at: string;
}

interface LoadedGraph {
  byId: Map<string, Block>;
  byParent: Map<string | null, Block[]>;
  propertyRecordsByBlock: Map<string, PropertyRecord[]>;
}
function propertyRecordFromRow(row: PropertyRow): PropertyRecord {
  return {
    key: row.key,
    value: row.value,
    ordinal: row.ordinal,
    raw: row.raw,
    start: row.start,
    end: row.end,
    line: row.line,
    column: row.column,
    placement: row.placement,
    scope: row.scope,
    syntax: row.syntax,
  };
}

function propertyMatchContexts(records: readonly PropertyRecord[]) {
  return records.map(({ key, value, ordinal, start, end, line, column, scope }) => ({
    key,
    value,
    ordinal,
    start,
    end,
    line,
    column,
    scope,
  }));
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

function normalizeMutationProvenance(
  mutation: MutationProvenance,
): {
  author: BlockAuthor;
  actorId: string | null;
  sessionId: string | null;
  taskId: string | null;
} {
  if (!mutation || !["user", "agent", "system"].includes(mutation.author)) {
    throw new Error("Mutation provenance must identify user, agent, or system");
  }
  const normalizeOptionalId = (value: string | undefined, label: string): string | null => {
    if (value === undefined) return null;
    const normalized = value.trim();
    if (!normalized) throw new Error(`${label} cannot be empty`);
    return normalized;
  };
  const actorId = normalizeOptionalId(mutation.actorId, "Mutation actorId");
  if (mutation.author === "agent" && actorId === null) {
    throw new Error("Agent mutation provenance requires actorId");
  }
  return {
    author: mutation.author,
    actorId,
    sessionId: normalizeOptionalId(mutation.sessionId, "Mutation sessionId"),
    taskId: normalizeOptionalId(mutation.taskId, "Mutation taskId"),
  };
}

const CAPTURE_SOURCES = new Set<CaptureSource>(["tree", "pi", "omp", "cli", "external"]);

function normalizeCaptureRequestId(requestId: string): string {
  if (typeof requestId !== "string") {
    throw new Error("Capture requestId must be 1-200 printable characters");
  }
  const normalized = requestId.trim();
  if (!normalized || normalized.length > 200 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error("Capture requestId must be 1-200 printable characters");
  }
  return normalized;
}

const ROADMAP_PRIORITIES: Record<RoadmapItemPriority, true> = {
  high: true,
  medium: true,
  low: true,
};
const ROADMAP_WORK_STAGES: Record<RoadmapWorkStage, true> = {
  unprioritized: true,
  next: true,
  doing: true,
  review: true,
  validate: true,
  later: true,
};
const RESERVED_ROADMAP_PROPERTY_KEYS: Record<string, true> = {
  type: true,
  status: true,
  priority: true,
  "work-stage": true,
  project: true,
  arc: true,
  track: true,
  "depends-on": true,
  "related-to": true,
  "source-block": true,
  "work-id": true,
};

const CANONICAL_BLOCK_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeRoadmapText(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} cannot be empty`);
  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} must be a single printable line`);
  }
  return normalized;
}

function normalizeRoadmapValues(values: unknown, label: string): string[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${label} must contain at least one value`);
  }
  return [...new Set(values.map((value) => normalizeRoadmapText(value, label)))];
}

function normalizeRoadmapRelationshipId(value: unknown, label: string): string {
  const blockId = normalizeRoadmapText(value, label);
  if (!CANONICAL_BLOCK_ID_PATTERN.test(blockId)) {
    throw new Error(`${label} must contain canonical block UUIDs: ${blockId}`);
  }
  return blockId;
}

function normalizeRoadmapRelationshipIds(
  values: unknown,
  label: string,
): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`);
  return [...new Set(values.map((value) => normalizeRoadmapRelationshipId(value, label)))];
}

function assertNoReservedRoadmapProperties(title: string, body: string): void {
  const reservedProperty = parsePropertyRecords(`${title}\n${body}`).find(
    (property) => RESERVED_ROADMAP_PROPERTY_KEYS[property.key] === true,
  );
  if (reservedProperty) {
    throw new Error(
      `Roadmap title and body cannot include reserved property: ${reservedProperty.key}`,
    );
  }
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
    this.ensureInbox();
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
          "INSERT INTO blocks (id, parent_id, position, text, author, actor_id, session_id, task_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
      this.replaceProperties(id, parsePropertyRecords(text));
      this.bumpSequence();
    })();

    return this.require(id);
  }

  createRoadmapItem(
    input: RoadmapItemCreateInput,
    author: BlockAuthor = "user",
    provenance?: BlockProvenance,
  ): RoadmapItemCreateReceipt {
    if (!input || typeof input !== "object") {
      throw new Error("Roadmap item input must be an object");
    }
    const title = normalizeRoadmapText(input.title, "Roadmap title");
    let body = "";
    if (input.body !== undefined) {
      if (typeof input.body !== "string") {
        throw new Error("Roadmap body must be a string");
      }
      body = input.body.trim();
    }
    const priority = input.priority;
    if (ROADMAP_PRIORITIES[priority] !== true) {
      throw new Error(`Invalid roadmap priority: ${String(priority)}`);
    }
    const workStage = input.workStage ?? "unprioritized";
    if (ROADMAP_WORK_STAGES[workStage] !== true) {
      throw new Error(`Invalid roadmap work stage: ${String(workStage)}`);
    }
    const project = normalizeRoadmapText(input.project, "Roadmap project");
    const arc = normalizeRoadmapText(input.arc, "Roadmap arc");
    const tracks = normalizeRoadmapValues(input.tracks, "Roadmap tracks");
    const dependsOn = normalizeRoadmapRelationshipIds(input.dependsOn, "dependsOn");
    const relatedTo = normalizeRoadmapRelationshipIds(input.relatedTo, "relatedTo");
    const sourceBlockId = input.sourceBlockId === undefined
      ? undefined
      : normalizeRoadmapRelationshipId(input.sourceBlockId, "sourceBlockId");
    const creator = normalizeCreatorProvenance(author, provenance);
    assertNoReservedRoadmapProperties(title, body);

    return this.database.transaction(() => {
      const workQueues = this.database.query(
        "SELECT DISTINCT block.id FROM blocks block JOIN block_properties type_property ON type_property.block_id = block.id AND type_property.scope = 'block' AND type_property.key = 'type' AND type_property.value = 'work-queue' JOIN block_properties project_property ON project_property.block_id = block.id AND project_property.scope = 'block' AND project_property.key = 'project' AND project_property.value = ? WHERE block.effective_deleted_root_id IS NULL ORDER BY block.id",
      ).all(project) as Array<{ id: string }>;
      if (workQueues.length !== 1) {
        throw new Error(
          `Expected exactly one active work queue for project ${project}; found ${workQueues.length}`,
        );
      }
      const workQueueId = workQueues[0]!.id;
      const allocator = this.workIdAllocatorFromCurrentRead();
      if (!allocator) {
        throw new Error("Configure the project Work-ID prefix before creating roadmap items");
      }
      for (const blockId of [...dependsOn, ...relatedTo, ...(sourceBlockId ? [sourceBlockId] : [])]) {
        const target = this.getFromCurrentRead(blockId);
        if (!target) throw new Error(`Relationship target not found: ${blockId}`);
        if (target.effectiveDeletedRootId) {
          throw new Error(`Relationship target is in Trash: ${blockId}`);
        }
      }

      let nextNumber = allocator.next_number;
      let workId = formatWorkId(allocator.prefix, nextNumber);
      while (this.reservedWorkIdOwnerFromCurrentRead(workId) !== undefined) {
        nextNumber += 1;
        workId = formatWorkId(allocator.prefix, nextNumber);
      }
      const properties: BlockProperty[] = [
        { key: "type", value: "roadmap-item" },
        { key: "status", value: "planned" },
        { key: "priority", value: priority },
        { key: "work-stage", value: workStage },
        { key: "project", value: project },
        { key: "arc", value: arc },
        ...tracks.map((value) => ({ key: "track", value })),
        ...dependsOn.map((value) => ({ key: "depends-on", value })),
        ...relatedTo.map((value) => ({ key: "related-to", value })),
        ...(sourceBlockId ? [{ key: "source-block", value: sourceBlockId }] : []),
        { key: "work-id", value: workId },
      ];
      const metadata = properties.map(formatProperty).join(" ");
      const text = `${workId} — ${title} ${metadata}${body ? `\n\n${body}` : ""}`;
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const position = this.database.query(
        "SELECT COALESCE(MAX(position), -1) + 1 AS position FROM blocks WHERE parent_id IS ?",
      ).get(workQueueId) as { position: number };
      this.database.query(
        "INSERT INTO blocks (id, parent_id, position, text, author, actor_id, session_id, task_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        id,
        workQueueId,
        position.position,
        text,
        author,
        creator.actorId,
        creator.sessionId,
        creator.taskId,
        now,
        now,
      );
      this.replaceProperties(id, parsePropertyRecords(text));
      this.bumpSequence();
      const block = this.getFromCurrentRead(id);
      if (!block) throw new Error(`Roadmap item was not created: ${id}`);
      return {
        workId,
        workQueueId,
        block,
        memberships: this.roadmapBranchMembershipsFromCurrentRead(block),
      };
    })();
  }

  capture(
    requestId: string,
    text: string,
    source: CaptureSource,
    capturedFromBlockId?: string,
    author: BlockAuthor = "user",
    provenance?: BlockProvenance,
  ): CaptureReceipt {
    if (typeof text !== "string") throw new Error("Capture text must be a string");
    if (capturedFromBlockId !== undefined && typeof capturedFromBlockId !== "string") {
      throw new Error("Capture capturedFromBlockId must be a string");
    }
    const normalizedRequestId = normalizeCaptureRequestId(requestId);
    const normalizedText = text.trim();
    if (!normalizedText) throw new Error("Capture text cannot be empty");
    if (!CAPTURE_SOURCES.has(source)) throw new Error(`Invalid capture source: ${String(source)}`);

    return this.database.transaction((): CaptureReceipt => {
      const existing = this.database
        .query(
          "SELECT block_id, inbox_block_id FROM capture_requests WHERE request_id = ?",
        )
        .get(normalizedRequestId) as CaptureRequestRow | null;
      if (existing) {
        const block = this.getFromCurrentRead(existing.block_id);
        if (!block) {
          throw new Error(`Capture receipt target no longer exists: ${normalizedRequestId}`);
        }
        return {
          block,
          inboxBlockId: existing.inbox_block_id,
          deduplicated: true,
        };
      }

      const inbox = this.requireCaptureInboxFromCurrentRead();
      if (capturedFromBlockId) this.require(capturedFromBlockId);
      const capturedAt = new Date().toISOString();
      const metadata = [
        formatProperty({ key: "type", value: "capture" }),
        formatProperty({ key: "status", value: "unprocessed" }),
        formatProperty({ key: "capture-source", value: source }),
        formatProperty({ key: "captured-at", value: capturedAt }),
        ...(capturedFromBlockId
          ? [formatProperty({ key: "captured-from", value: capturedFromBlockId })]
          : []),
      ].join(" ");
      const block = this.create(
        `${metadata}\n${normalizedText}`,
        inbox.id,
        author,
        provenance,
      );
      this.database
        .query(
          "INSERT INTO capture_requests (request_id, block_id, inbox_block_id, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(normalizedRequestId, block.id, inbox.id, capturedAt);
      return { block, inboxBlockId: inbox.id, deduplicated: false };
    })();
  }

  update(
    id: string,
    text: string,
    expectedUpdatedAt: string | undefined = undefined,
    mutation: MutationProvenance = { author: "system" },
    kind: "text" | "properties" = "text",
  ): Block {
    const existing = this.requireActive(id);
    if (expectedUpdatedAt && existing.updatedAt !== expectedUpdatedAt) {
      throw new Error(`Block changed since editing began: ${id}`);
    }
    const provenance = normalizeMutationProvenance(mutation);
    const timestamp = Math.max(Date.now(), Date.parse(existing.updatedAt) + 1);
    const editedAt = new Date(timestamp).toISOString();
    this.database.transaction(() => {
      this.database.query("UPDATE blocks SET text = ?, updated_at = ? WHERE id = ?").run(text, editedAt, id);
      this.replaceProperties(id, parsePropertyRecords(text));
      this.database.query(`
        INSERT INTO block_edit_activity
          (block_id, author, actor_id, session_id, task_id, kind, edited_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        provenance.author,
        provenance.actorId,
        provenance.sessionId,
        provenance.taskId,
        kind,
        editedAt,
      );
      this.bumpSequence();
    })();
    return this.require(id);
  }

  patchProperties(
    id: string,
    expectedUpdatedAt: string,
    operations: PropertyPatchOperation[],
    mutation: MutationProvenance = { author: "system" },
  ): Block {
    if (operations.length === 0) throw new Error("Property patch requires at least one operation");
    const existing = this.requireActive(id);
    if (existing.updatedAt !== expectedUpdatedAt) {
      throw new Error(`Block changed since editing began: ${id}`);
    }
    const text = patchPropertyText(existing.text, operations);
    return this.update(id, text, expectedUpdatedAt, mutation, "properties");
  }

  recentEditActivity(options: {
    afterCursor?: number;
    since?: string;
    limit?: number;
    author?: BlockAuthor;
  } = {}): BlockEditActivityPage {
    const afterCursor = options.afterCursor ?? 0;
    if (!Number.isSafeInteger(afterCursor) || afterCursor < 0) {
      throw new Error("Activity cursor must be a non-negative safe integer");
    }
    const limit = Math.min(options.limit ?? 5, 100);
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error("Activity limit must be a positive integer");
    }
    const author = options.author ?? "user";
    if (!["user", "agent", "system"].includes(author)) {
      throw new Error("Activity author must be user, agent, or system");
    }
    const since = options.since ?? "0000-01-01T00:00:00.000Z";
    if (options.since !== undefined && !Number.isFinite(Date.parse(options.since))) {
      throw new Error("Activity since must be an ISO timestamp");
    }
    const cursorRow = this.database.query(`
      SELECT COALESCE(MAX(activity_id), ?) AS cursor
      FROM block_edit_activity
      WHERE activity_id > ? AND author = ? AND edited_at >= ?
    `).get(afterCursor, afterCursor, author, since) as { cursor: number };
    const rows = this.database.query(`
      SELECT activity_id, block_id, author, actor_id, session_id, task_id, kind, edited_at
      FROM block_edit_activity
      WHERE activity_id IN (
        SELECT MAX(activity_id)
        FROM block_edit_activity
        WHERE activity_id > ? AND author = ? AND edited_at >= ?
        GROUP BY block_id
      )
      ORDER BY activity_id DESC, block_id ASC
      LIMIT ?
    `).all(afterCursor, author, since, limit) as BlockEditActivityRow[];
    const entries = rows.flatMap((row): BlockEditActivity[] => {
      const block = this.get(row.block_id);
      if (!block || block.effectiveDeletedRootId) return [];
      return [{
        cursor: row.activity_id,
        block,
        author: row.author,
        ...(row.actor_id ? { actorId: row.actor_id } : {}),
        ...(row.session_id ? { sessionId: row.session_id } : {}),
        ...(row.task_id ? { taskId: row.task_id } : {}),
        kind: row.kind,
        editedAt: row.edited_at,
      }];
    });
    return { entries, cursor: cursorRow.cursor };
  }

  propertyCatalog(
    key?: string,
    prefix = "",
    requestedLimit = 50,
    requestedScope: PropertyQueryScope = "block",
  ): PropertyCatalogItem[] {
    if (!["block", "line", "inline", "all"].includes(requestedScope)) {
      throw new Error(`Invalid property scope: ${requestedScope}`);
    }
    const limit = Math.max(1, Math.min(100, Math.floor(requestedLimit)));
    const normalizedPrefix = prefix.toLowerCase();
    const scopeClause = requestedScope === "all" ? "" : "AND property.scope = ?";
    const scopeParameters = requestedScope === "all" ? [] : [requestedScope];
    if (key) {
      return this.database
        .query(
          `SELECT property.key, property.value, COUNT(*) AS count FROM block_properties property JOIN blocks block ON block.id = property.block_id WHERE block.effective_deleted_root_id IS NULL AND property.key = ? AND SUBSTR(LOWER(property.value), 1, LENGTH(?)) = ? ${scopeClause} GROUP BY property.key, property.value ORDER BY count DESC, LOWER(property.value), property.value LIMIT ?`,
        )
        .all(
          key.toLowerCase(),
          normalizedPrefix,
          normalizedPrefix,
          ...scopeParameters,
          limit,
        ) as PropertyCatalogItem[];
    }
    return this.database
      .query(
        `SELECT property.key, property.value, COUNT(*) AS count FROM block_properties property JOIN blocks block ON block.id = property.block_id WHERE block.effective_deleted_root_id IS NULL AND SUBSTR(property.key, 1, LENGTH(?)) = ? ${scopeClause} GROUP BY property.key, property.value ORDER BY count DESC, property.key, LOWER(property.value), property.value LIMIT ?`,
      )
      .all(normalizedPrefix, normalizedPrefix, ...scopeParameters, limit) as PropertyCatalogItem[];
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
        if (
          restored &&
          !restored.effectiveDeletedRootId &&
          this.canRegisterRestoredPageAddresses(blockId, restored.properties)
        ) {
          for (const workId of this.configuredWorkIdValues(restored.properties)) {
            this.reserveWorkIdForBlockFromCurrentRead(blockId, workId);
          }
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
        `SELECT block_id, value FROM block_properties WHERE scope = 'block' AND key = 'work-id' AND block_id IN (${placeholders})`,
      ).all(...subtree) as Array<{ block_id: string; value: string }>;
      for (const row of reserved) {
        const parsed = parseWorkId(row.value);
        if (!parsed || parsed.workId !== row.value.trim()) continue;
        if (this.reservedWorkIdOwnerFromCurrentRead(parsed.workId) !== undefined) {
          continue;
        }
        this.reservePurgedWorkIdFromCurrentRead(row.block_id, parsed);
      }
      this.database.query("DELETE FROM blocks WHERE id = ?").run(id);
      this.recomputeEffectiveDeletion();
      this.bumpSequence();
    })();
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
    const resolved = resolveBlockReferencesWithStatus(text, (blockId) => this.get(blockId));
    const workIdPrefix = this.workIdAllocatorFromCurrentRead()?.prefix;
    return workIdPrefix ? { ...resolved, workIdPrefix } : resolved;
  }

  queryBacklinks(input: BacklinkQuery): BacklinkCollection {
    return this.database.transaction(() => {
      const query = { ...input, targetBlockId: input.targetBlockId.trim() };
      const graph = this.loadGraph();
      const target = graph.byId.get(query.targetBlockId);
      if (!target) throw new Error(`Block not found: ${query.targetBlockId}`);

      const orderedBlocks: Block[] = [];
      const visit = (block: Block): void => {
        orderedBlocks.push(block);
        for (const child of graph.byParent.get(block.id) ?? []) visit(child);
      };
      for (const root of graph.byParent.get(null) ?? []) visit(root);

      const addressRows = this.database.query(
        "SELECT normalized_address, block_id FROM page_addresses ORDER BY normalized_address",
      ).all() as Array<{ normalized_address: string; block_id: string }>;
      const addressTargets = new Map(
        addressRows.map((row) => [row.normalized_address, row.block_id]),
      );
      return resolveBacklinkRelation({
        query,
        target,
        orderedBlocks,
        blocksById: graph.byId,
        addressTargets,
        workIdPrefix: this.workIdAllocatorFromCurrentRead()?.prefix ?? null,
      });
    })();
  }

  resolvePageAddress(address: string): PageAddressResolution {
    return this.database.transaction(() =>
      this.resolveAuthoredPageAddressFromCurrentRead(normalizePageAddress(address))
    )();
  }

  followPageAddress(
    address: string,
    author: BlockAuthor = "user",
    provenance?: BlockProvenance,
  ): PageAddressFollowResult {
    return this.database.transaction(() => {
      const normalized = normalizePageAddress(address);
      const existing = this.resolveAuthoredPageAddressFromCurrentRead(normalized);
      if (existing.status !== "missing") return { ...existing, created: false };
      const allocator = this.workIdAllocatorFromCurrentRead();
      const embeddedWorkIds = allocator
        ? workIdReferences(normalized.displayAddress, allocator.prefix)
        : [];
      if (embeddedWorkIds.length === 1) {
        throw new Error(
          `Unresolved Work ID cannot create a page stub: ${embeddedWorkIds[0]!.workId}`,
        );
      }
      const parsedWorkId = parseWorkId(normalized.displayAddress);
      const canonicalWorkId = parsedWorkId?.workId ===
          normalized.displayAddress.toUpperCase()
        ? parsedWorkId
        : null;
      if (
        canonicalWorkId &&
        (
          this.reservedWorkIdOwnerFromCurrentRead(canonicalWorkId.workId) !== undefined ||
          allocator?.prefix === canonicalWorkId.prefix
        )
      ) {
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
      const pageTokens = parsePropertyRecords(block.text).filter(
        (token) => token.scope === "block" && token.key === "page",
      );
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
      this.replaceProperties(blockId, parsePropertyRecords(nextText));
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
        const token = parsePropertyRecords(block.text).find((candidate) =>
          candidate.scope === "block" &&
          candidate.key === "page" &&
          normalizePageAddress(candidate.value).normalizedAddress === row.normalized_address
        );
        if (!token) throw new Error(`Block has no matching page declaration: ${blockId}`);
        const nextText = patchPropertyText(block.text, [{ op: "remove", ordinal: token.ordinal }]);
        const timestamp = new Date(Math.max(Date.now(), Date.parse(block.updatedAt) + 1)).toISOString();
        this.database.query("UPDATE blocks SET text = ?, updated_at = ? WHERE id = ?")
          .run(nextText, timestamp, blockId);
        this.replaceProperties(blockId, parsePropertyRecords(nextText));
        updated = this.getFromCurrentRead(blockId)!;
      }
      this.bumpSequence();
      return { removed, block: updated };
    })();
  }

  workIdAllocatorStatus(): WorkIdAllocatorStatus {
    return this.database.transaction(() =>
      this.workIdAllocatorStatusFromCurrentRead()
    )();
  }

  configureWorkIdPrefix(prefix: string): WorkIdAllocatorStatus {
    const normalizedPrefix = normalizeWorkIdPrefix(prefix);
    return this.database.transaction(() => {
      const current = this.workIdAllocatorFromCurrentRead();
      if (current?.prefix === normalizedPrefix) {
        return this.workIdAllocatorStatusFromCurrentRead();
      }
      if (
        current &&
        this.canonicalWorkIdReservationsFromCurrentRead().some(
          (reservation) => reservation.prefix === current.prefix,
        )
      ) {
        throw new Error(
          `Work-ID prefix ${current.prefix} already has immutable reservations`,
        );
      }
      const nextNumber = this.nextWorkIdNumberForPrefixFromCurrentRead(
        normalizedPrefix,
      );
      this.database.query(
        "INSERT INTO work_id_allocator (singleton, prefix, next_number) VALUES (1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET prefix = excluded.prefix, next_number = excluded.next_number",
      ).run(normalizedPrefix, nextNumber);
      this.reconcileWorkIdAddresses();
      this.bumpSequence();
      return this.workIdAllocatorStatusFromCurrentRead();
    })();
  }

  allocateWorkId(
    blockId: string,
    expectedUpdatedAt: string,
  ): WorkIdAllocation {
    return this.database.transaction(() => {
      const block = this.getFromCurrentRead(blockId);
      if (!block) throw new Error(`Block not found: ${blockId}`);
      if (block.effectiveDeletedRootId) throw new Error(`Block is in Trash: ${blockId}`);
      if (block.updatedAt !== expectedUpdatedAt) {
        throw new Error(`Block changed since editing began: ${blockId}`);
      }
      const allocator = this.workIdAllocatorFromCurrentRead();
      if (!allocator) {
        throw new Error("Configure the project Work-ID prefix before allocation");
      }
      const workIdProperties = parsePropertyRecords(block.text).filter(
        (property) => property.scope === "block" && property.key === "work-id",
      );
      const replacesPlaceholder =
        workIdProperties.length === 1 &&
        isConfiguredWorkIdPlaceholder(workIdProperties[0]!.value, allocator.prefix);
      if (workIdProperties.length > 0 && !replacesPlaceholder) {
        throw new Error(`Block already has a Work ID: ${blockId}`);
      }

      let nextNumber = allocator.next_number;
      let workId = formatWorkId(allocator.prefix, nextNumber);
      while (this.reservedWorkIdOwnerFromCurrentRead(workId) !== undefined) {
        nextNumber += 1;
        workId = formatWorkId(allocator.prefix, nextNumber);
      }
      const workIdOperation: PropertyPatchOperation = replacesPlaceholder
        ? { op: "replace", ordinal: workIdProperties[0]!.ordinal, value: workId }
        : { op: "append", key: "work-id", value: workId };
      const nextText = patchPropertyText(block.text, [workIdOperation]);
      const updatedAt = new Date(
        Math.max(Date.now(), Date.parse(block.updatedAt) + 1),
      ).toISOString();
      const properties = parsePropertyRecords(nextText);
      this.database.query("UPDATE blocks SET text = ?, updated_at = ? WHERE id = ?")
        .run(nextText, updatedAt, blockId);
      this.replaceProperties(blockId, properties);
      this.bumpSequence();
      return {
        workId,
        block: this.getFromCurrentRead(blockId)!,
      };
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

  traversePreorder(options: BlockTraversalOptions = {}): VisibleBlock[] {
    return this.database.transaction(() =>
      this.traverseLoadedGraph(this.loadGraph(), options)
    )();
  }

  queryBlocks(input: BlockSearchQuery): VisibleBlockCollection {
    const query = normalizeBlockSearchQuery(input);

    return this.database.transaction((): VisibleBlockCollection => {
      if (query.subtreeRootId) this.require(query.subtreeRootId);
      const deletedMode = query.includeDeleted ?? "active";
      if (query.rankViewId && deletedMode === "active") {
        return this.queryRankedBlocksFromCurrentRead(query, query.rankViewId);
      }
      const blocks = this.traverseLoadedGraph(this.loadGraph(), {
        filters: query.filters,
        propertyScope: query.propertyScope,
        subtreeRootId: query.subtreeRootId,
        text: query.text,
        stopAfterMatches: query.limit + 1,
        deletedMode,
      });
      if (blocks.length <= query.limit) {
        return { blocks, completeness: { kind: "complete" } };
      }
      return {
        blocks: blocks.slice(0, query.limit),
        completeness: { kind: "truncated", limit: query.limit },
      };
    })();
  }

  readWorkspaceSnapshot(view: WorkspaceSnapshotView = {}): WorkspaceSnapshot {
    return this.database.transaction((): WorkspaceSnapshot => {
      const graph = this.loadGraph();
      const query = view.query ? normalizeBlockSearchQuery(view.query) : null;
      if (query?.rankViewId) throw new Error("Workspace snapshot query cannot use rankViewId");
      if (query?.subtreeRootId && !graph.byId.has(query.subtreeRootId)) {
        throw new Error(`Block not found: ${query.subtreeRootId}`);
      }
      const matched = this.traverseLoadedGraph(graph, {
        filters: query?.filters,
        propertyScope: query?.propertyScope,
        subtreeRootId: query?.subtreeRootId,
        text: query?.text,
        stopAfterMatches: query ? query.limit + 1 : undefined,
        deletedMode: query?.includeDeleted ?? "active",
      });
      const visible: VisibleBlockCollection = query && matched.length > query.limit
        ? {
            blocks: matched.slice(0, query.limit),
            completeness: { kind: "truncated", limit: query.limit },
          }
        : { blocks: matched, completeness: { kind: "complete" } };
      const physical = this.traverseLoadedGraph(graph, {});

      const workIdPrefix = this.workIdAllocatorFromCurrentRead()?.prefix;
      return {
        visible,
        physical: { blocks: physical, completeness: { kind: "complete" } },
        selection: this.selectionFromGraph(graph),
        sequence: this.sequence,
        virtualOccurrenceRanks: this.virtualOccurrenceRanksFromCurrentRead(),
        ...(workIdPrefix ? { workIdPrefix } : {}),
      };
    })();
  }

  getSelection(): SelectionContext {
    return this.database.transaction(() => this.selectionFromCurrentRead())();
  }

  blockContext(blockId: string): SelectionContext {
    return this.database.transaction(() => {
      const selected = this.getFromCurrentRead(blockId);
      if (!selected) throw new Error(`Block not found: ${blockId}`);
      return this.contextForBlockFromCurrentRead(selected);
    })();
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
    const propertyScope = query.propertyScope ?? "block";
    const propertyScopePredicate = propertyScope === "all" ? "" : " AND property.scope = ?";
    for (const filter of query.filters ?? []) {
      if (filter.value === undefined) {
        predicates.push(
          `EXISTS (SELECT 1 FROM block_properties property WHERE property.block_id = block.id AND property.key = ?${propertyScopePredicate})`,
        );
        parameters.push(filter.key);
      } else {
        predicates.push(
          `EXISTS (SELECT 1 FROM block_properties property WHERE property.block_id = block.id AND property.key = ? AND LOWER(property.value) = LOWER(?)${propertyScopePredicate})`,
        );
        parameters.push(filter.key, filter.value);
      }
      if (propertyScope !== "all") parameters.push(propertyScope);
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
          EXISTS (
            SELECT 1 FROM blocks child
            WHERE child.parent_id = block.id AND child.effective_deleted_root_id IS NULL
          ) AS has_children
        FROM tree
        JOIN blocks block ON block.id = tree.id
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
    const blocks = this.hydrateVisibleRowsFromCurrentRead(
      rows.slice(0, query.limit),
      query.filters ?? [],
      propertyScope,
    );
    return {
      blocks,
      completeness: rows.length > query.limit
        ? { kind: "truncated", limit: query.limit }
        : { kind: "complete" },
    };
  }

  private hydrateVisibleRowsFromCurrentRead(
    rows: readonly VisibleBlockRow[],
    filters: readonly PropertyFilter[],
    propertyScope: PropertyQueryScope,
  ): VisibleBlock[] {
    if (rows.length === 0) return [];
    const placeholders = rows.map(() => "?").join(", ");
    const propertyRows = this.database
      .query(
        `SELECT block_id, key, value, ordinal, raw, start, end, line, column, placement, scope, syntax FROM block_properties WHERE block_id IN (${placeholders}) ORDER BY block_id, ordinal`,
      )
      .all(...rows.map((row) => row.id)) as PropertyRow[];
    const recordsByBlock = new Map<string, PropertyRecord[]>();
    for (const row of propertyRows) {
      const records = recordsByBlock.get(row.block_id);
      if (records) records.push(propertyRecordFromRow(row));
      else recordsByBlock.set(row.block_id, [propertyRecordFromRow(row)]);
    }
    return rows.map((row) => {
      const records = recordsByBlock.get(row.id) ?? [];
      const block = this.hydrate(
        row,
        records
          .filter((record) => record.scope === "block")
          .map(({ key, value }) => ({ key, value })),
      );
      return {
        ...block,
        depth: row.depth,
        hasChildren: row.has_children === 1,
        displayText: resolveBlockReferenceText(
          block.text,
          (blockId) => this.getFromCurrentRead(blockId),
        ),
        ...(propertyScope !== "block" && filters.length > 0
          ? {
              propertyMatches: propertyMatchContexts(
                matchingPropertyRecords(records, filters, propertyScope),
              ),
            }
          : {}),
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
    return this.contextForBlockFromCurrentRead(selected);
  }

  private contextForBlockFromCurrentRead(selected: Block | null): SelectionContext {
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
      .query(
        "SELECT block_id, key, value, ordinal, raw, start, end, line, column, placement, scope, syntax FROM block_properties ORDER BY block_id, ordinal",
      )
      .all() as PropertyRow[];
    const propertyRecordsByBlock = new Map<string, PropertyRecord[]>();
    const propertiesByBlock = new Map<string, BlockProperty[]>();
    for (const row of propertyRows) {
      const record = propertyRecordFromRow(row);
      const records = propertyRecordsByBlock.get(row.block_id);
      if (records) records.push(record);
      else propertyRecordsByBlock.set(row.block_id, [record]);
      if (record.scope !== "block") continue;
      const properties = propertiesByBlock.get(row.block_id);
      if (properties) properties.push({ key: record.key, value: record.value });
      else propertiesByBlock.set(row.block_id, [{ key: record.key, value: record.value }]);
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

    return { byId, byParent, propertyRecordsByBlock };
  }

  private traverseLoadedGraph(
    graph: LoadedGraph,
    options: LoadedGraphTraversalOptions,
  ): VisibleBlock[] {
    const blocks: VisibleBlock[] = [];
    const filterText = options.text?.toLowerCase();
    const deletedMode = options.deletedMode ?? "active";
    const propertyScope = options.propertyScope ?? "block";
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
      const propertyRecords = graph.propertyRecordsByBlock.get(block.id) ?? [];
      const matches =
        deletionMatches &&
        (!options.filters?.length ||
          matchesFilters(propertyRecords, options.filters, propertyScope)) &&
        (!filterText || block.text.toLowerCase().includes(filterText));
      if (matches) {
        const children = (graph.byParent.get(block.id) ?? []).filter((child) =>
          deletedMode === "active" ? !child.effectiveDeletedRootId : true
        );
        blocks.push({
          ...block,
          depth,
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
          ...(propertyScope !== "block" && options.filters?.length
            ? {
                propertyMatches: propertyMatchContexts(
                  matchingPropertyRecords(propertyRecords, options.filters, propertyScope),
                ),
              }
            : {}),
        });
        if (options.stopAfterMatches !== undefined && blocks.length >= options.stopAfterMatches) {
          return true;
        }
      }

      for (const child of graph.byParent.get(block.id) ?? []) {
        if (visit(child, depth + 1)) return true;
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
        raw TEXT NOT NULL,
        start INTEGER NOT NULL,
        end INTEGER NOT NULL,
        line INTEGER NOT NULL,
        column INTEGER NOT NULL,
        placement TEXT NOT NULL CHECK (placement IN ('inline', 'trailing-metadata', 'metadata-line')),
        scope TEXT NOT NULL CHECK (scope IN ('block', 'line', 'inline')),
        syntax TEXT NOT NULL CHECK (syntax IN ('bracket', 'bare')),
        PRIMARY KEY (block_id, ordinal)
      );
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
        reserved_at TEXT NOT NULL,
        block_id TEXT
      );
      CREATE TABLE IF NOT EXISTS work_id_allocator (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        prefix TEXT NOT NULL UNIQUE,
        next_number INTEGER NOT NULL CHECK (next_number >= 1)
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
      CREATE TABLE IF NOT EXISTS capture_requests (
        request_id TEXT PRIMARY KEY,
        block_id TEXT NOT NULL,
        inbox_block_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS block_edit_activity (
        activity_id INTEGER PRIMARY KEY AUTOINCREMENT,
        block_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
        author TEXT NOT NULL CHECK (author IN ('user', 'agent', 'system')),
        actor_id TEXT,
        session_id TEXT,
        task_id TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('text', 'properties')),
        edited_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS block_edit_activity_author_cursor
        ON block_edit_activity(author, activity_id DESC);
      CREATE INDEX IF NOT EXISTS block_edit_activity_block_cursor
        ON block_edit_activity(block_id, activity_id DESC);
    `);
    this.migrateBlockStateColumns();
    this.retireTreePresentationState();
    this.migratePropertyIndex();
    this.migrateWorkIdStateColumns();
    this.migrateWorkIdReservations();
    this.reconcileWorkIdAllocator();
    this.migratePageAddressRegistry();
    this.reconcileWorkIdAddresses();
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

  private retireTreePresentationState(): void {
    this.database.transaction(() => {
      this.database.exec("DROP TABLE IF EXISTS block_view_state");
      const columns = new Set(
        (
          this.database.query("PRAGMA table_info(blocks)").all() as Array<{ name: string }>
        ).map((column) => column.name),
      );
      if (columns.has("collapsed")) {
        this.database.exec("ALTER TABLE blocks DROP COLUMN collapsed");
      }
    })();
  }

  private migrateWorkIdStateColumns(): void {
    this.database.transaction(() => {
      const columns = new Set(
        (
          this.database.query("PRAGMA table_info(reserved_work_ids)").all() as Array<{
            name: string;
          }>
        ).map((column) => column.name),
      );
      if (!columns.has("block_id")) {
        this.database.exec("ALTER TABLE reserved_work_ids ADD COLUMN block_id TEXT");
      }
      this.database.query(`
        UPDATE reserved_work_ids
        SET block_id = (
          SELECT property.block_id
          FROM block_properties property
          JOIN blocks block ON block.id = property.block_id
          WHERE property.scope = 'block'
            AND property.key = 'work-id'
          ORDER BY (block.effective_deleted_root_id IS NOT NULL), property.block_id
          LIMIT 1
        )
        WHERE block_id IS NULL
      `).run();
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

      const columns = new Set(
        (
          this.database.query("PRAGMA table_info(block_properties)").all() as Array<{
            name: string;
          }>
        ).map((column) => column.name),
      );
      const requiredColumns = [
        "block_id",
        "key",
        "value",
        "ordinal",
        "raw",
        "start",
        "end",
        "line",
        "column",
        "placement",
        "scope",
        "syntax",
      ];
      const schemaCurrent = requiredColumns.every((column) => columns.has(column));
      if (schemaCurrent && storedVersion === PROPERTY_PARSER_VERSION) return;

      const existingBlocks = this.database.query("SELECT id, text FROM blocks ORDER BY id").all() as Array<{
        id: string;
        text: string;
      }>;
      if (!schemaCurrent) {
        this.database.exec(`
          DROP TABLE block_properties;
          CREATE TABLE block_properties (
            block_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            ordinal INTEGER NOT NULL,
            raw TEXT NOT NULL,
            start INTEGER NOT NULL,
            end INTEGER NOT NULL,
            line INTEGER NOT NULL,
            column INTEGER NOT NULL,
            placement TEXT NOT NULL CHECK (placement IN ('inline', 'trailing-metadata', 'metadata-line')),
            scope TEXT NOT NULL CHECK (scope IN ('block', 'line', 'inline')),
            syntax TEXT NOT NULL CHECK (syntax IN ('bracket', 'bare')),
            PRIMARY KEY (block_id, ordinal)
          );
        `);
      } else {
        this.database.query("DELETE FROM block_properties").run();
      }
      this.database.exec(`
        CREATE INDEX IF NOT EXISTS properties_scope_key_value
          ON block_properties(scope, key, value, block_id);
      `);
      for (const block of existingBlocks) {
        this.replacePropertyIndex(block.id, parsePropertyRecords(block.text));
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
    this.database.transaction(() => {
      const rows = this.database.query(
        "SELECT property.block_id, property.value FROM block_properties property JOIN blocks block ON block.id = property.block_id WHERE property.scope = 'block' AND property.key = 'work-id' AND block.effective_deleted_root_id IS NULL ORDER BY property.block_id",
      ).all() as Array<{ block_id: string; value: string }>;
      for (const row of rows) {
        const parsed = parseWorkId(row.value);
        if (!parsed || parsed.workId !== row.value.trim()) continue;
        if (this.reservedWorkIdOwnerFromCurrentRead(parsed.workId) === undefined) {
          this.database.query(
            "INSERT INTO reserved_work_ids (work_id, reserved_at, block_id) VALUES (?, ?, ?)",
          ).run(parsed.workId, new Date().toISOString(), row.block_id);
        }
      }
    })();
  }

  private reconcileWorkIdAllocator(): void {
    this.database.transaction(() => {
      const reservations = this.canonicalWorkIdReservationsFromCurrentRead();
      const prefixes = [...new Set(
        reservations.map((reservation) => reservation.prefix),
      )].sort();
      const current = this.workIdAllocatorFromCurrentRead();
      const migration = this.database.query(
        "SELECT value FROM metadata WHERE key = 'work_id_allocator_migration_version'",
      ).get() as { value: string } | null;
      if (!current && migration === null && prefixes.length === 1) {
        const prefix = prefixes[0]!;
        this.database.query(
          "INSERT INTO work_id_allocator (singleton, prefix, next_number) VALUES (1, ?, ?)",
        ).run(prefix, this.nextWorkIdNumberForPrefixFromCurrentRead(prefix));
      } else if (current) {
        this.database.query(
          "UPDATE work_id_allocator SET next_number = ? WHERE singleton = 1",
        ).run(Math.max(
          current.next_number,
          this.nextWorkIdNumberForPrefixFromCurrentRead(current.prefix),
        ));
      }
      this.database.query(
        "INSERT INTO metadata (key, value) VALUES ('work_id_allocator_migration_version', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run();
    })();
  }

  private reconcileWorkIdAddresses(): void {
    this.database.transaction(() => {
      const allocator = this.workIdAllocatorFromCurrentRead();
      const rows = this.database.query(
        "SELECT normalized_address, display_address, block_id, kind FROM page_addresses WHERE kind = 'work-id' ORDER BY normalized_address",
      ).all() as PageAddressRow[];
      for (const row of rows) {
        const parsed = parseWorkId(row.display_address);
        const owner = parsed
          ? this.reservedWorkIdOwnerFromCurrentRead(parsed.workId)
          : undefined;
        if (
          !parsed ||
          parsed.workId !== row.display_address.trim() ||
          owner !== row.block_id
        ) {
          this.database.query(
            "DELETE FROM page_addresses WHERE normalized_address = ?",
          ).run(row.normalized_address);
        }
      }
      if (allocator) {
        this.registerConfiguredWorkIdAddressesFromCurrentRead(allocator.prefix);
      }
    })();
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

      const retainedAddresses = this.database.query(
        "SELECT address.normalized_address, address.display_address, address.block_id, address.kind FROM page_addresses address JOIN blocks block ON block.id = address.block_id WHERE address.kind = 'alias' OR block.effective_deleted_root_id IS NOT NULL ORDER BY address.normalized_address",
      ).all() as PageAddressRow[];
      this.database.query("DELETE FROM page_addresses").run();
      const rows = this.database.query(
        "SELECT property.block_id, property.key, property.value FROM block_properties property JOIN blocks block ON block.id = property.block_id WHERE block.effective_deleted_root_id IS NULL AND property.scope = 'block' AND property.key IN ('page', 'work-id') ORDER BY property.block_id, property.ordinal",
      ).all() as Array<{ block_id: string; key: string; value: string }>;
      const propertiesByBlock = new Map<string, BlockProperty[]>();
      for (const row of rows) {
        const properties = propertiesByBlock.get(row.block_id) ?? [];
        properties.push({ key: row.key, value: row.value });
        propertiesByBlock.set(row.block_id, properties);
      }
      for (const [blockId, properties] of propertiesByBlock) {
        this.syncDeclaredPageAddresses(blockId, properties);
      }
      for (const retained of retainedAddresses) {
        const normalized = normalizePageAddress(retained.display_address);
        const existing = this.pageAddressRowFromCurrentRead(normalized.normalizedAddress);
        if (existing) {
          if (existing.block_id === retained.block_id) continue;
          throw new Error(
            `Retained address migration conflicts with block ${existing.block_id}: ${retained.display_address}`,
          );
        }
        this.insertPageAddressFromCurrentRead(
          retained.block_id,
          retained.display_address,
          retained.kind,
        );
      }
      this.database.query(
        "INSERT INTO metadata (key, value) VALUES ('page_address_registry_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(String(PAGE_ADDRESS_REGISTRY_VERSION));
    })();
  }

  private captureInboxesFromCurrentRead(): Block[] {
    const rows = this.database
      .query(
        "SELECT DISTINCT property.block_id FROM block_properties property JOIN blocks block ON block.id = property.block_id WHERE property.scope = 'block' AND property.key = 'system-view' AND LOWER(property.value) = 'inbox' AND block.effective_deleted_root_id IS NULL ORDER BY block.created_at, block.id",
      )
      .all() as Array<{ block_id: string }>;
    return rows
      .map((row) => this.getFromCurrentRead(row.block_id))
      .filter((block): block is Block => block !== null);
  }

  private requireCaptureInboxFromCurrentRead(): Block {
    const inboxes = this.captureInboxesFromCurrentRead();
    if (inboxes.length !== 1) {
      throw new Error(
        `Workspace must contain exactly one active [system-view::inbox]; found ${inboxes.length}`,
      );
    }
    return inboxes[0]!;
  }

  private ensureInbox(): void {
    const inboxes = this.database.transaction(() => this.captureInboxesFromCurrentRead())();
    if (inboxes.length > 1) {
      throw new Error(
        `Workspace must contain exactly one active [system-view::inbox]; found ${inboxes.length}`,
      );
    }
    if (inboxes.length === 1) return;
    this.create("Inbox [type::inbox] [system-view::inbox]", null, "system");
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
          .query(
            "SELECT key, value FROM block_properties WHERE block_id = ? AND scope = 'block' ORDER BY ordinal",
          )
          .all(row.id) as BlockProperty[]
      );
    return {
      id: row.id,
      parentId: row.parent_id,
      position: row.position,
      text: row.text,
      author: row.author,
      ...(row.actor_id ? { actorId: row.actor_id } : {}),
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      ...(row.task_id ? { taskId: row.task_id } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
      ...(row.effective_deleted_root_id
        ? { effectiveDeletedRootId: row.effective_deleted_root_id }
        : {}),
      properties: hydratedProperties,
    };
  }

  private workIdAllocatorFromCurrentRead(): WorkIdAllocatorRow | null {
    return this.database.query(
      "SELECT prefix, next_number FROM work_id_allocator WHERE singleton = 1",
    ).get() as WorkIdAllocatorRow | null;
  }

  private reservedWorkIdOwnerFromCurrentRead(
    workId: string,
  ): string | null | undefined {
    const row = this.database.query(
      "SELECT block_id FROM reserved_work_ids WHERE work_id = ?",
    ).get(workId) as { block_id: string | null } | null;
    return row ? row.block_id : undefined;
  }

  private canonicalWorkIdReservationsFromCurrentRead(): Array<{
    workId: string;
    prefix: string;
    number: number;
  }> {
    const rows = this.database.query(
      "SELECT work_id FROM reserved_work_ids ORDER BY work_id",
    ).all() as Array<{ work_id: string }>;
    return rows.flatMap((row) => {
      const parsed = parseWorkId(row.work_id);
      return parsed && parsed.workId === row.work_id ? [parsed] : [];
    });
  }

  private workIdAllocatorStatusFromCurrentRead(): WorkIdAllocatorStatus {
    const allocator = this.workIdAllocatorFromCurrentRead();
    const reservations = this.canonicalWorkIdReservationsFromCurrentRead();
    const observedPrefixes = [...new Set(
      reservations.map((reservation) => reservation.prefix),
    )].sort();
    return {
      prefix: allocator?.prefix ?? null,
      nextNumber: allocator?.next_number ?? null,
      nextWorkId: allocator
        ? formatWorkId(allocator.prefix, allocator.next_number)
        : null,
      reservedCount: reservations.length,
      observedPrefixes,
    };
  }

  private nextWorkIdNumberForPrefixFromCurrentRead(prefix: string): number {
    let maximum = 0;
    for (const reservation of this.canonicalWorkIdReservationsFromCurrentRead()) {
      if (reservation.prefix === prefix) {
        maximum = Math.max(maximum, reservation.number);
      }
    }
    return maximum + 1;
  }

  private registerConfiguredWorkIdAddressesFromCurrentRead(prefix: string): void {
    const rows = this.database.query(
      "SELECT DISTINCT property.block_id FROM block_properties property JOIN blocks block ON block.id = property.block_id WHERE property.scope = 'block' AND property.key = 'work-id' AND block.effective_deleted_root_id IS NULL ORDER BY property.block_id",
    ).all() as Array<{ block_id: string }>;
    for (const row of rows) {
      const block = this.getFromCurrentRead(row.block_id);
      if (
        block &&
        block.properties.some((property) => {
          if (property.key !== "work-id") return false;
          const parsed = parseWorkId(property.value);
          return parsed?.workId === property.value.trim() &&
            parsed.prefix === prefix;
        }) &&
        this.canRegisterRestoredPageAddresses(block.id, block.properties)
      ) {
        this.syncDeclaredPageAddresses(block.id, block.properties);
      }
    }
  }

  private reserveWorkIdForBlockFromCurrentRead(
    blockId: string,
    value: string,
  ): void {
    const parsed = parseWorkId(value);
    if (!parsed || parsed.workId !== value.trim()) {
      throw new Error(`Invalid canonical Work ID: ${value}`);
    }
    const allocator = this.workIdAllocatorFromCurrentRead();
    if (allocator && allocator.prefix !== parsed.prefix) {
      throw new Error(
        `Work-ID prefix is already configured as ${allocator.prefix}`,
      );
    }

    const owner = this.reservedWorkIdOwnerFromCurrentRead(parsed.workId);
    if (owner === null) {
      throw new Error(`Work ID is reserved and cannot be reused: ${parsed.workId}`);
    }
    if (owner !== undefined && owner !== blockId) {
      throw new Error(`Work ID already belongs to block ${owner}: ${parsed.workId}`);
    }
    if (owner === undefined) {
      this.database.query(
        "INSERT INTO reserved_work_ids (work_id, reserved_at, block_id) VALUES (?, ?, ?)",
      ).run(parsed.workId, new Date().toISOString(), blockId);
    }
    if (allocator && allocator.next_number <= parsed.number) {
      this.database.query(
        "UPDATE work_id_allocator SET next_number = ? WHERE singleton = 1",
      ).run(parsed.number + 1);
    }
  }

  private reservePurgedWorkIdFromCurrentRead(
    blockId: string,
    parsed: ParsedWorkId,
  ): void {
    this.database.query(
      "INSERT INTO reserved_work_ids (work_id, reserved_at, block_id) VALUES (?, ?, ?)",
    ).run(parsed.workId, new Date().toISOString(), blockId);
    const allocator = this.workIdAllocatorFromCurrentRead();
    if (!allocator) return;
    if (
      allocator.prefix === parsed.prefix &&
      allocator.next_number <= parsed.number
    ) {
      this.database.query(
        "UPDATE work_id_allocator SET next_number = ? WHERE singleton = 1",
      ).run(parsed.number + 1);
    }
  }

  private resolveAuthoredPageAddressFromCurrentRead(
    normalized: NormalizedPageAddress,
  ): PageAddressResolution {
    const exact = this.resolvePageAddressFromCurrentRead(normalized);
    if (exact.status !== "missing") return exact;
    const allocator = this.workIdAllocatorFromCurrentRead();
    if (!allocator) return exact;
    const embeddedWorkIds = workIdReferences(normalized.displayAddress, allocator.prefix);
    if (embeddedWorkIds.length !== 1) return exact;
    const resolved = this.resolvePageAddressFromCurrentRead(
      normalizePageAddress(embeddedWorkIds[0]!.workId),
    );
    return resolved.status === "missing"
      ? exact
      : {
          ...resolved,
          address: normalized.displayAddress,
          normalizedAddress: normalized.normalizedAddress,
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

  private configuredWorkIdValues(properties: BlockProperty[]): string[] {
    const allocator = this.workIdAllocatorFromCurrentRead();
    if (!allocator) return [];
    return properties.flatMap((property) => {
      if (property.key !== "work-id") return [];
      const parsed = parseWorkId(property.value);
      return parsed &&
          parsed.workId === property.value.trim() &&
          parsed.prefix === allocator.prefix
        ? [parsed.workId]
        : [];
    });
  }

  private canRegisterRestoredPageAddresses(
    blockId: string,
    properties: BlockProperty[],
  ): boolean {
    const pageValues = properties.filter((property) => property.key === "page");
    const workIdValues = this.configuredWorkIdValues(properties);
    if (pageValues.length > 1 || workIdValues.length > 1) return false;
    if (workIdValues[0]) {
      const owner = this.reservedWorkIdOwnerFromCurrentRead(workIdValues[0]);
      if (owner === null || (owner !== undefined && owner !== blockId)) return false;
    }

    const page = pageValues[0] ? tryNormalizePageAddress(pageValues[0].value) : null;
    const workId = workIdValues[0]
      ? tryNormalizePageAddress(workIdValues[0])
      : null;
    if ((pageValues[0] && !page) || (workIdValues[0] && !workId)) return false;
    if (page && workId && page.normalizedAddress === workId.normalizedAddress) return false;

    for (const [kind, desired] of [["page", page], ["work-id", workId]] as const) {
      const current = this.database.query(
        "SELECT normalized_address FROM page_addresses WHERE block_id = ? AND kind = ?",
      ).get(blockId, kind) as { normalized_address: string } | null;
      if (current && current.normalized_address !== desired?.normalizedAddress) return false;
      if (!desired) continue;
      const owner = this.pageAddressRowFromCurrentRead(desired.normalizedAddress);
      if (owner && owner.block_id !== blockId) return false;
    }
    return true;
  }

  private syncDeclaredPageAddresses(blockId: string, properties: BlockProperty[]): void {
    const pageValues = properties
      .filter((property) => property.key === "page")
      .map((property) => property.value);
    const workIdValues = this.configuredWorkIdValues(properties);
    if (pageValues.length > 1) {
      throw new Error(`Block may declare at most one page address: ${blockId}`);
    }
    if (workIdValues.length > 1) {
      throw new Error(`Block may declare at most one canonical Work ID: ${blockId}`);
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

  private replacePropertyIndex(
    blockId: string,
    properties: readonly PropertyRecord[],
  ): void {
    this.database.query("DELETE FROM block_properties WHERE block_id = ?").run(blockId);
    const insert = this.database.query(
      "INSERT INTO block_properties (block_id, key, value, ordinal, raw, start, end, line, column, placement, scope, syntax) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const property of properties) {
      insert.run(
        blockId,
        property.key,
        property.value,
        property.ordinal,
        property.raw,
        property.start,
        property.end,
        property.line,
        property.column,
        property.placement,
        property.scope,
        property.syntax,
      );
    }
  }

  private replaceProperties(blockId: string, properties: readonly PropertyRecord[]): void {
    this.replacePropertyIndex(blockId, properties);
    const blockProperties = properties
      .filter((property) => property.scope === "block")
      .map(({ key, value }) => ({ key, value }));
    const allocator = this.workIdAllocatorFromCurrentRead();
    for (const property of blockProperties) {
      if (property.key !== "work-id") continue;
      const parsed = parseWorkId(property.value);
      if (
        parsed &&
        parsed.workId === property.value.trim() &&
        (!allocator || allocator.prefix === parsed.prefix)
      ) {
        this.reserveWorkIdForBlockFromCurrentRead(blockId, parsed.workId);
      }
    }
    this.syncDeclaredPageAddresses(blockId, blockProperties);
  }

  private roadmapBranchMembershipsFromCurrentRead(
    block: Block,
  ): RoadmapBranchMembership[] {
    const rows = this.database.query(
      "SELECT DISTINCT block.id FROM blocks block JOIN block_properties property ON property.block_id = block.id AND property.scope = 'block' AND property.key = 'type' AND property.value = 'virtual-branch' WHERE block.effective_deleted_root_id IS NULL ORDER BY block.position, block.created_at, block.id",
    ).all() as Array<{ id: string }>;
    const memberships: RoadmapBranchMembership[] = [];
    for (const row of rows) {
      const branch = this.getFromCurrentRead(row.id);
      if (!branch) continue;
      const queries = branch.properties.filter((property) => property.key === "query");
      if (queries.length !== 1) continue;
      let filters: PropertyFilter[];
      try {
        filters = parsePropertyFilterExpression(queries[0]!.value);
      } catch {
        continue;
      }
      if (!matchesFilters(block.properties, filters)) continue;
      const rank = this.database.query(
        "SELECT rank FROM virtual_occurrence_ranks WHERE view_id = ? AND block_id = ?",
      ).get(branch.id, block.id) as { rank: number } | null;
      memberships.push({
        viewId: branch.id,
        title: firstLineWithoutPropertyTokens(branch.text)?.trim() || branch.id,
        ...(rank ? { rank: rank.rank } : {}),
      });
    }
    return memberships;
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
