import type { Database } from "bun:sqlite";
import type { BlockAuthor, ChangeFeedPage, MutationProvenance, OutlinerChange, OutlinerChangeKind } from "./types";

export const CHANGE_FEED_DEFAULT_LIMIT = 200;
export const CHANGE_FEED_MAX_LIMIT = 1000;
export const CHANGE_FEED_DEFAULT_RETENTION = 10_000;

const FLOOR_KEY = "change_feed_floor";
const COMPLETE_KEY = "change_feed_complete_through";

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
  recorded_at: string;
}

export type ChangeInput = Omit<OutlinerChange, "changeId" | "recordedAt">;

function change(row: ChangeRow): OutlinerChange {
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
    recordedAt: row.recorded_at,
  };
}

/**
 * Bounded, durable history of content changes, keyed by the service sequence.
 *
 * The floor is the oldest cursor that can still be answered completely: every
 * change with a greater sequence is retained. It advances when old entries are
 * pruned. Only the serving process records changes, so the feed is complete only
 * across a clean service shutdown followed by a start at the same sequence. A
 * crash (a committed change may be unrecorded) or any write between the two
 * moves the floor to the current sequence when serving resumes.
 */
export class ChangeFeed {
  retention = CHANGE_FEED_DEFAULT_RETENTION;
  private serving = false;

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
        recorded_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS change_feed_sequence ON change_feed(sequence, change_id);
    `);
    // A workspace created before the feed has no history for earlier sequences.
    if (this.metadata(FLOOR_KEY) === null) this.setMetadata(FLOOR_KEY, currentSequence());
  }

  /** Called when the service starts accepting requests; later changes are recorded. */
  resume(): void {
    this.database.transaction(() => {
      const current = this.currentSequence();
      if (this.metadata(COMPLETE_KEY) !== current && this.floor < current) this.setMetadata(FLOOR_KEY, current);
      this.database.query("DELETE FROM metadata WHERE key = ?").run(COMPLETE_KEY);
    })();
    this.serving = true;
  }

  get floor(): number {
    return this.metadata(FLOOR_KEY) ?? 0;
  }

  /** Records a clean service shutdown; a restart at this sequence keeps the history. */
  close(): void {
    if (!this.serving) return;
    this.serving = false;
    this.setMetadata(COMPLETE_KEY, this.currentSequence());
  }

  record(input: ChangeInput): OutlinerChange {
    return this.database.transaction(() => {
      const actor = input.actor;
      const row = this.database.query(`
        INSERT INTO change_feed (
          sequence, action, kind, block_id, parent_id, has_parent, previous_parent_id,
          has_previous_parent, revision, deleted, author, actor_id, session_id, task_id, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      const floor = this.floor;
      if (sequence > current) return { kind: "reset", reason: "sequence-ahead", oldestSequence: floor, sequence: current };
      if (sequence < floor) return { kind: "reset", reason: "history-unavailable", oldestSequence: floor, sequence: current };
      const rows = this.database.query(`
        SELECT * FROM change_feed WHERE sequence > ? ORDER BY sequence, change_id LIMIT ?
      `).all(sequence, limit + 1) as ChangeRow[];
      if (rows.length <= limit) {
        return {
          kind: "changes",
          changes: rows.map(change),
          nextSequence: rows.at(-1)?.sequence ?? sequence,
          completeness: { kind: "complete" },
          sequence: current,
        };
      }
      const page = rows.slice(0, limit);
      const last = page.at(-1)!;
      // A cursor is a sequence, so a page must end on a whole sequence.
      if (rows[limit]!.sequence === last.sequence) {
        page.push(...this.database.query(`
          SELECT * FROM change_feed WHERE sequence = ? AND change_id > ? ORDER BY change_id
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
