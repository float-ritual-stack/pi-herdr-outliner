import { AsyncLocalStorage } from "node:async_hooks";
import type { Database } from "bun:sqlite";
import type { Block, BlockAuthor, ChangeFeedPage, MutationProvenance, OutlinerChange, OutlinerChangeKind } from "./types";

export const CHANGE_FEED_DEFAULT_LIMIT = 200;
export const CHANGE_FEED_MAX_LIMIT = 1000;
export const CHANGE_FEED_DEFAULT_RETENTION = 10_000;

const FLOOR_KEY = "change_feed_floor";
/** Written by the first feed build, which inferred completeness from a clean shutdown. */
const LEGACY_COMPLETE_KEY = "change_feed_complete_through";

/**
 * Raises the oldest answerable cursor to `sequence`. Used for sequence advances
 * that cannot be described as changes, such as a startup index rebuild.
 */
export function raiseChangeFeedFloor(database: Database, sequence: number): void {
  database.query(`
    INSERT INTO metadata (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = MAX(CAST(value AS INTEGER), CAST(excluded.value AS INTEGER))
  `).run(FLOOR_KEY, String(sequence));
}

interface ChangeRow {
  change_id: number;
  sequence: number;
  action: string;
  kind: OutlinerChangeKind;
  block_id: string | null;
  parent_id: string | null;
  has_parent: number;
  previous_parent_id: string | null;
  has_previous_parent: number;
  revision: number | null;
  deleted: number | null;
  author: BlockAuthor | null;
  actor_id: string | null;
  session_id: string | null;
  task_id: string | null;
  requested_by: string | null;
  recorded_at: string;
}

export type ChangeInput = Omit<OutlinerChange, "changeId" | "recordedAt">;

/** What a store mutation changed, described at the moment it advances the sequence. */
export interface SequenceChange {
  readonly kind: OutlinerChangeKind;
  /** Primary block, read inside the committing transaction for parent, revision and Trash state. */
  readonly blockId?: string;
  readonly previousParentId?: string | null;
}

/**
 * Who a change is attributed to. A request attribution collects the changes it
 * commits so the service can publish them as live events; a background one only
 * labels them, and they are delivered through `onBackgroundChanges`.
 */
export interface ChangeAttribution {
  readonly action: string;
  readonly actor?: MutationProvenance;
  /**
   * Who asked for it, when that isn't the writer: an extension's action (`actor` `ext:<id>`) asked for by
   * the person or an agent (`extensions.act`'s `mutation`).
   */
  readonly requestedBy?: MutationProvenance;
  /** Replaces the store's kind for request-level meanings (annotate, draft). */
  readonly kind?: OutlinerChangeKind;
  readonly collect: boolean;
  readonly changes: OutlinerChange[];
  closed: boolean;
}

function requester(raw: string | null): MutationProvenance | undefined {
  if (raw === null) return undefined;
  try {
    const parsed = JSON.parse(raw) as MutationProvenance;
    return parsed && typeof parsed === "object" && typeof parsed.author === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function change(row: ChangeRow): OutlinerChange {
  const requestedBy = requester(row.requested_by);
  return {
    sequence: row.sequence,
    changeId: row.change_id,
    action: row.action,
    kind: row.kind,
    ...(row.block_id !== null ? { blockId: row.block_id } : {}),
    ...(row.has_parent ? { parentId: row.parent_id } : {}),
    ...(row.has_previous_parent ? { previousParentId: row.previous_parent_id } : {}),
    ...(row.revision !== null ? { revision: row.revision } : {}),
    ...(row.deleted !== null ? { deleted: row.deleted === 1 } : {}),
    ...(row.author !== null ? {
      actor: {
        author: row.author,
        ...(row.actor_id !== null ? { actorId: row.actor_id } : {}),
        ...(row.session_id !== null ? { sessionId: row.session_id } : {}),
        ...(row.task_id !== null ? { taskId: row.task_id } : {}),
      } satisfies MutationProvenance,
    } : {}),
    ...(requestedBy ? { requestedBy } : {}),
    recordedAt: row.recorded_at,
  };
}

function sameChange(left: OutlinerChange, right: OutlinerChange): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Bounded, durable history of content changes, keyed by the service sequence.
 *
 * Every sequence advance writes a feed row in the transaction that advances it:
 * a visible change for content, or a hidden sequence-only row for changes the
 * feed does not describe (resource catalog). A committed sequence therefore
 * always has a row, whether the writer is a request, a background worker or
 * another process running this code. `since` still verifies that coverage and
 * turns any sequence without a row (a writer from an older build, raw SQL) into
 * an explicit reset by raising the floor.
 *
 * The floor is the oldest cursor that can still be answered completely: every
 * change with a greater sequence is retained. It advances when old rows are
 * pruned, when a startup rebuild advances the sequence without a describable
 * change, and when coverage finds an unrecorded sequence.
 */
export class ChangeFeed {
  retention = CHANGE_FEED_DEFAULT_RETENTION;
  /** Receives committed changes recorded outside a request attribution. */
  onBackgroundChanges: ((changes: OutlinerChange[]) => void) | undefined;
  private readonly storage = new AsyncLocalStorage<ChangeAttribution>();
  private background: OutlinerChange[] = [];
  private flushScheduled = false;

  constructor(private readonly database: Database, private readonly currentSequence: () => number) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS change_feed (
        change_id INTEGER PRIMARY KEY AUTOINCREMENT,
        sequence INTEGER NOT NULL,
        action TEXT NOT NULL,
        kind TEXT NOT NULL,
        block_id TEXT,
        parent_id TEXT,
        has_parent INTEGER NOT NULL DEFAULT 0,
        previous_parent_id TEXT,
        has_previous_parent INTEGER NOT NULL DEFAULT 0,
        revision INTEGER,
        deleted INTEGER,
        author TEXT,
        actor_id TEXT,
        session_id TEXT,
        task_id TEXT,
        recorded_at TEXT NOT NULL,
        visible INTEGER NOT NULL DEFAULT 1,
        requested_by TEXT
      );
      CREATE INDEX IF NOT EXISTS change_feed_sequence ON change_feed(sequence, change_id);
    `);
    const columns = database.query("PRAGMA table_info(change_feed)").all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === "visible")) {
      database.exec("ALTER TABLE change_feed ADD COLUMN visible INTEGER NOT NULL DEFAULT 1");
    }
    if (!columns.some(column => column.name === "requested_by")) {
      database.exec("ALTER TABLE change_feed ADD COLUMN requested_by TEXT");
    }
    database.query("DELETE FROM metadata WHERE key = ?").run(LEGACY_COMPLETE_KEY);
    // A workspace created before the feed has no history for earlier sequences.
    if (this.metadata(FLOOR_KEY) === null) this.setMetadata(FLOOR_KEY, currentSequence());
  }

  get floor(): number {
    return this.metadata(FLOOR_KEY) ?? 0;
  }

  /**
   * Creates an attribution for `run`. With `collect`, it lists its committed
   * changes for live events; `committed` closes it, so later asynchronous writes
   * that inherited its context count as background changes.
   */
  attribution(
    input: { action: string; actor?: MutationProvenance; requestedBy?: MutationProvenance; kind?: OutlinerChangeKind; collect?: boolean },
  ): ChangeAttribution {
    return {
      action: input.action,
      ...(input.actor ? { actor: input.actor } : {}),
      ...(input.requestedBy ? { requestedBy: input.requestedBy } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      collect: input.collect ?? false,
      changes: [],
      closed: false,
    };
  }

  /** Runs `work` (and the asynchronous work it starts) with changes attributed to `attribution`. */
  run<T>(attribution: ChangeAttribution, work: () => T): T {
    return this.storage.run(attribution, work);
  }

  /** Changes an attribution collected that are still committed (a rollback discards its rows). */
  committed(attribution: ChangeAttribution): OutlinerChange[] {
    attribution.closed = true;
    return this.stillCommitted(attribution.changes);
  }

  /** Delivers background changes now rather than on the next microtask. */
  flushBackground(): void {
    const pending = this.background;
    this.background = [];
    this.flushScheduled = false;
    if (!this.onBackgroundChanges) return;
    const committed = this.stillCommitted(pending);
    if (committed.length > 0) this.onBackgroundChanges?.(committed);
  }

  /**
   * Records a content change at `sequence`. Must run in the transaction that
   * advanced the sequence, so the change commits or rolls back with it.
   */
  recordSequence(sequence: number, input: SequenceChange, block: Block | null): OutlinerChange {
    const context = this.storage.getStore();
    const open = context && !context.closed ? context : undefined;
    // A created block's stored provenance is authoritative, including defaults.
    const actor = input.kind === "create" && block
      ? {
          author: block.author,
          ...(block.actorId ? { actorId: block.actorId } : {}),
          ...(block.sessionId ? { sessionId: block.sessionId } : {}),
          ...(block.taskId ? { taskId: block.taskId } : {}),
        }
      : open?.actor;
    const recorded = this.record({
      sequence,
      action: open?.action ?? "background",
      kind: open?.kind ?? input.kind,
      ...(input.blockId ? { blockId: input.blockId } : {}),
      ...(block ? {
        parentId: block.parentId,
        revision: block.revision,
        deleted: Boolean(block.effectiveDeletedRootId),
      } : {}),
      ...(input.previousParentId !== undefined ? { previousParentId: input.previousParentId } : {}),
      ...(actor ? { actor } : {}),
      ...(open?.requestedBy ? { requestedBy: open.requestedBy } : {}),
    });
    if (open?.collect) open.changes.push(recorded);
    else if (this.onBackgroundChanges) {
      this.background.push(recorded);
      if (!this.flushScheduled) {
        this.flushScheduled = true;
        queueMicrotask(() => { if (this.flushScheduled) this.flushBackground(); });
      }
    }
    return recorded;
  }

  /**
   * Marks a sequence advance that changed no outline content (resource catalog
   * bookkeeping). The hidden row proves coverage and is never returned.
   */
  recordSequenceOnly(sequence: number, action: string): void {
    this.database.transaction(() => {
      const row = this.database.query(`
        INSERT INTO change_feed (sequence, action, kind, recorded_at, visible) VALUES (?, ?, 'other', ?, 0)
        RETURNING change_id
      `).get(sequence, action, new Date().toISOString()) as { change_id: number };
      this.prune(row.change_id);
    })();
  }

  record(input: ChangeInput): OutlinerChange {
    return this.database.transaction(() => {
      const actor = input.actor;
      const row = this.database.query(`
        INSERT INTO change_feed (
          sequence, action, kind, block_id, parent_id, has_parent, previous_parent_id,
          has_previous_parent, revision, deleted, author, actor_id, session_id, task_id, requested_by, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING *
      `).get(
        input.sequence,
        input.action,
        input.kind,
        input.blockId ?? null,
        input.parentId ?? null,
        input.parentId !== undefined ? 1 : 0,
        input.previousParentId ?? null,
        input.previousParentId !== undefined ? 1 : 0,
        input.revision ?? null,
        input.deleted === undefined ? null : input.deleted ? 1 : 0,
        actor?.author ?? null,
        actor?.actorId ?? null,
        actor?.sessionId ?? null,
        actor?.taskId ?? null,
        input.requestedBy ? JSON.stringify(input.requestedBy) : null,
        new Date().toISOString(),
      ) as ChangeRow;
      this.prune(row.change_id);
      return change(row);
    })();
  }

  since(sequence: number, limit = CHANGE_FEED_DEFAULT_LIMIT): ChangeFeedPage {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new Error("changes.since sequence must be a non-negative safe integer");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > CHANGE_FEED_MAX_LIMIT) {
      throw new Error(`changes.since limit must be an integer from 1 through ${CHANGE_FEED_MAX_LIMIT}`);
    }
    return this.database.transaction((): ChangeFeedPage => {
      const current = this.currentSequence();
      if (sequence > current) return { kind: "reset", reason: "sequence-ahead", oldestSequence: this.floor, sequence: current };
      this.verifyCoverage(sequence, current);
      const floor = this.floor;
      if (sequence < floor) return { kind: "reset", reason: "history-unavailable", oldestSequence: floor, sequence: current };
      const rows = this.database.query(`
        SELECT * FROM change_feed WHERE sequence > ? AND visible = 1 ORDER BY sequence, change_id LIMIT ?
      `).all(sequence, limit + 1) as ChangeRow[];
      if (rows.length <= limit) {
        // Every sequence through `current` was checked, including hidden rows, so
        // the cursor advances to it. Stopping at the last visible row would leave
        // a client behind hidden activity until pruning resets it.
        return {
          kind: "changes",
          changes: rows.map(change),
          nextSequence: current,
          completeness: { kind: "complete" },
          sequence: current,
        };
      }
      const page = rows.slice(0, limit);
      const last = page.at(-1)!;
      // A cursor is a sequence, so a page must end on a whole sequence.
      if (rows[limit]!.sequence === last.sequence) {
        page.push(...this.database.query(`
          SELECT * FROM change_feed WHERE sequence = ? AND change_id > ? AND visible = 1 ORDER BY change_id
        `).all(last.sequence, last.change_id) as ChangeRow[]);
      }
      return {
        kind: "changes",
        changes: page.map(change),
        nextSequence: last.sequence,
        completeness: { kind: "truncated", limit },
        sequence: current,
      };
    })();
  }

  /**
   * Every sequence after the cursor must have a row. A sequence without one was
   * committed by a writer that did not record it, so no page may cross it: the
   * floor moves past the newest such sequence and older cursors get a reset.
   */
  private verifyCoverage(sequence: number, current: number): void {
    const from = Math.max(sequence, this.floor);
    if (from >= current) return;
    const { covered } = this.database.query(
      "SELECT COUNT(DISTINCT sequence) AS covered FROM change_feed WHERE sequence > ? AND sequence <= ?",
    ).get(from, current) as { covered: number };
    if (covered === current - from) return;
    const recorded = new Set((this.database.query(
      "SELECT DISTINCT sequence FROM change_feed WHERE sequence > ? AND sequence <= ?",
    ).all(from, current) as Array<{ sequence: number }>).map(row => row.sequence));
    let uncovered = current;
    while (recorded.has(uncovered)) uncovered -= 1;
    this.setMetadata(FLOOR_KEY, uncovered);
  }

  private stillCommitted(changes: readonly OutlinerChange[]): OutlinerChange[] {
    if (changes.length === 0) return [];
    const rows = this.database.query(
      `SELECT * FROM change_feed WHERE change_id IN (${changes.map(() => "?").join(", ")})`,
    ).all(...changes.map(entry => entry.changeId)) as ChangeRow[];
    const byId = new Map(rows.map(row => [row.change_id, change(row)]));
    // AUTOINCREMENT ids of rolled-back rows can be reused, so compare the whole record.
    return changes.filter(entry => {
      const stored = byId.get(entry.changeId);
      return stored !== undefined && sameChange(stored, entry);
    });
  }

  private prune(latestChangeId: number): void {
    const cutoff = latestChangeId - this.retention;
    if (cutoff < 1) return;
    const pruned = this.database.query(
      "SELECT MAX(sequence) AS sequence FROM change_feed WHERE change_id <= ?",
    ).get(cutoff) as { sequence: number | null };
    if (pruned.sequence === null) return;
    this.database.query("DELETE FROM change_feed WHERE change_id <= ?").run(cutoff);
    if (pruned.sequence > this.floor) this.setMetadata(FLOOR_KEY, pruned.sequence);
  }

  private metadata(key: string): number | null {
    const row = this.database.query("SELECT value FROM metadata WHERE key = ?").get(key) as { value: string } | null;
    return row ? Number(row.value) : null;
  }

  private setMetadata(key: string, value: number): void {
    this.database.query(
      "INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(key, String(value));
  }
}
