import {captureHistoryResource,captureOriginalResources} from "./capture-history";
import { InboxPlanValidationError } from "./inbox-attempts";
import { createHash } from "node:crypto";
import { prepareNoteEdit } from "./note-assistance-repository";
import type { NoteCandidate, NotePlan } from "./note-assistance-types";
import { NOTE_TYPES } from "./note-kinds";
import { firstLineWithoutPropertyTokens, parseProperties, parsePropertyRecords, patchPropertyText } from "./properties";
import type { InboxPlan, InboxResult, InboxResultSummary, InboxUsage } from "./inbox-types";
import type { OutlinerStore } from "./store";
import type { Block, BlockProperty, PropertyPatchOperation } from "./types";

interface ResultRow {
  payload_hash: string;
  result_json: string;
  recovery_json: string | null;
}

interface ShapeRow {
  id: string;
  parent_id: string | null;
  revision: number;
  position: number | null;
  deleted_at: string | null;
  effective_deleted_root_id: string | null;
}

interface Recovery {
  before: Block[];
  after: Array<{ id: string; shape: ShapeRow[] }>;
  createdIds: string[];
  roots: Array<{ id: string; revision: number; parentId: string | null }>;
  references?: Array<{ id: string; complete: boolean; sources: Array<{ id: string; revision: number }> }>;
}

const mutation = { author: "agent" as const, actorId: "inbox-agent" };
const ordinaryTypes = new Set<string>([...NOTE_TYPES, "capture", "learning", "question"]);
const protectedKeys = new Set([
  "type", "status", "system-view", "system-doc", "page", "alias", "source-block",
  "parent-annotation", "promoted-block", "superseded-by", "raw-capture", "before-rewrite",
]);
const taskKeys = new Set(["priority", "project", "arc", "track", "depends-on", "related-to"]);

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a nonempty string`);
  return value.trim();
}

function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error("Inbox edits require a positive integer revision");
  return value as number;
}

function has(block: Block, key: string, value?: string): boolean {
  return block.properties.some(property => property.key === key &&
    (value === undefined || property.value.toLowerCase() === value));
}

function protectedProperty(key: string, workflow: boolean): boolean {
  return protectedKeys.has(key) || /^(work-|capture-|captured-|delivery-|annotation-|inbox-)/.test(key) ||
    (workflow && taskKeys.has(key));
}

function preserveProperties(block: Block, draft: string, processed = false): string {
  const workflow = has(block, "type", "roadmap-item") || has(block, "type", "work-batch") || has(block, "type", "delivery");
  const properties = block.properties.filter(property => protectedProperty(property.key, workflow) &&
    !(processed && property.key === "status"));
  if (processed) properties.push({ key: "status", value: "processed" });
  const operations: PropertyPatchOperation[] = parsePropertyRecords(draft)
    .filter(property => property.scope === "block" && protectedProperty(property.key, workflow))
    .map(property => ({ op: "remove", ordinal: property.ordinal }));
  const cleaned = patchPropertyText(draft, operations).trim();
  return patchPropertyText(cleaned, properties.map(property => ({ op: "append", ...property })));
}

function preserveTags(block: Block, draft: string): string {
  const normalize = (value: string) => value.replace(/^#/, "").toLowerCase();
  const present = new Set(parseProperties(draft).filter(property => property.key === "tag").map(property => normalize(property.value)));
  return patchPropertyText(draft, block.properties
    .filter(property => property.key === "tag" && !present.has(normalize(property.value)))
    .map(property => ({ op: "append", ...property })));
}

function validateNote(value: string): void {
  for (const property of parsePropertyRecords(value)) {
    if (property.scope !== "block") continue;
    if (property.key === "type" && ordinaryTypes.has(property.value.toLowerCase()) && property.value.toLowerCase() !== "capture") continue;
    if (protectedProperty(property.key, false)) {
      throw new Error(`Inbox notes cannot declare managed property ${property.key}; tasks use the roadmap allocator`);
    }
  }
}

export function validateInboxPlan(plan: InboxPlan): void {
  if (!plan || typeof plan !== "object") throw new Error("Inbox plan must be an object");
  text(plan.summary, "Inbox summary");
  if (!plan.source || !["file", "archive", "hold"].includes(plan.source.disposition)) throw new Error("Invalid Inbox source disposition");
  if (typeof plan.source.text !== "string") throw new Error("Inbox source text must be a string");
  if (plan.source.disposition !== "hold") text(plan.source.text, "Inbox source text");
  if (plan.source.reason !== undefined) text(plan.source.reason, "Inbox hold reason");
  if (plan.source.disposition === "hold") text(plan.source.reason, "Inbox hold reason");
  for (const key of ["notes", "tasks", "updates"] as const) {
    if (!Array.isArray(plan[key])) throw new Error(`Inbox ${key} must be an array`);
  }
  if (plan.source.disposition === "hold" && (plan.notes.length || plan.tasks.length || plan.updates.length)) {
    throw new Error("A held Inbox source cannot produce content changes");
  }
  for (const [index,note] of plan.notes.entries()) {
    if (!note || typeof note !== "object") throw new Error("Inbox note must be an object");
    try {validateNote(text(note.text, "Inbox note text"));}
    catch(error){throw new InboxPlanValidationError(`notes[${index}].text`,error instanceof Error?error.message:String(error));}
    if (note.parentId !== undefined) text(note.parentId, "Inbox note parent ID");
  }
  for (const update of plan.updates) {
    if (!update || typeof update !== "object") throw new Error("Inbox update must be an object");
    text(update.blockId, "Inbox update ID");
    text(update.text, "Inbox update text");
    revision(update.expectedRevision);
  }
  for (const task of plan.tasks) {
    if (!task || typeof task !== "object") throw new Error("Inbox task must be an object");
    text(task.title, "Inbox task title");
    if (typeof task.body !== "string") throw new Error("Inbox task body must be a string");
    // createRoadmapItem validates project, track, priority and relationship values in the transaction.
  }
}

function validateUsage(usage?: InboxUsage): void {
  if (usage === undefined) return;
  if (!usage || typeof usage !== "object") throw new Error("Inbox usage must be an object");
  text(usage.provider, "Inbox usage provider");
  text(usage.model, "Inbox usage model");
  for (const key of ["inputTokens", "outputTokens", "cost", "jevCalls", "elapsedMs"] as const) {
    if (typeof usage[key] !== "number" || !Number.isFinite(usage[key]) || usage[key] < 0) throw new Error(`Invalid Inbox usage ${key}`);
  }
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([, field]) => field !== undefined).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, field]) => [key, stable(field)]));
  return value;
}

function payloadHash(source: Block, payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(stable({
    sourceId: source.id, sourceRevision: source.revision, sourceParentId: source.parentId,
    sourceText: source.text, payload,
  }))).digest("hex");
}

export function summarizeInboxResult(result: InboxResult): InboxResultSummary {
  if (!result.usage?.promptRevisions) return result;
  return {
    ...result,
    usage: {
      ...result.usage,
      promptRevisions: result.usage.promptRevisions.map(({ text, ...revision }) => revision),
    },
  };
}

/** Recovery receipts share the canonical service connection and commit with its normal block mutations. */
export class InboxRepository {
  constructor(private readonly store: OutlinerStore) {
    store.database.exec(`
      CREATE TABLE IF NOT EXISTS inbox_agent_settings (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        paused INTEGER NOT NULL CHECK (paused IN (0, 1))
      );
      INSERT OR IGNORE INTO inbox_agent_settings (singleton, paused) VALUES (1, 0);
      CREATE TABLE IF NOT EXISTS inbox_agent_results (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        suppressed_revision INTEGER,
        payload_hash TEXT NOT NULL,
        result_json TEXT NOT NULL CHECK (json_valid(result_json)),
        recovery_json TEXT CHECK (recovery_json IS NULL OR json_valid(recovery_json)),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS inbox_agent_results_source ON inbox_agent_results(source_id, suppressed_revision);
      CREATE TABLE IF NOT EXISTS inbox_agent_instructions (
        source_id TEXT PRIMARY KEY,
        instructions TEXT NOT NULL
      );
    `);
  }

  settings(): { paused: boolean } {
    const row = this.store.database.query("SELECT paused FROM inbox_agent_settings WHERE singleton = 1").get() as { paused: number };
    return { paused: row.paused === 1 };
  }

  instructions(sourceId: string): string | undefined {
    const row = this.store.database.query("SELECT instructions FROM inbox_agent_instructions WHERE source_id = ?")
      .get(sourceId) as { instructions: string } | null;
    return row?.instructions;
  }

  setPaused(paused: boolean): void {
    if (typeof paused !== "boolean") throw new Error("Inbox paused must be a boolean");
    this.store.database.query("UPDATE inbox_agent_settings SET paused = ? WHERE singleton = 1").run(paused ? 1 : 0);
  }

  pending(): Block[] {
    return this.store.database.transaction(() => {
      const inbox = this.inbox();
      const ids = this.store.database.query(`
        SELECT b.id FROM blocks b
        WHERE b.parent_id = ? AND b.effective_deleted_root_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM inbox_agent_results r WHERE r.source_id = b.id AND r.suppressed_revision = b.revision)
        ORDER BY b.created_at, b.id
      `).all(inbox.id) as Array<{ id: string }>;
      return ids.map(({ id }) => this.store.require(id)).filter(block => this.eligible(block));
    })();
  }

  /** Filing owns eligible direct Inbox sources, including held and undone captures. */
  sourceIds(): Set<string> {
    const rows = this.store.database.query("SELECT id FROM blocks WHERE parent_id = ? AND effective_deleted_root_id IS NULL")
      .all(this.inbox().id) as Array<{ id: string }>;
    return new Set(rows.map(row => this.store.require(row.id)).filter(block => this.eligible(block)).map(block => block.id));
  }

  results(limit = 30, offset = 0): InboxResult[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("Inbox result limit must be between 1 and 1000");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Inbox result offset must be a nonnegative integer");
    const rows = this.store.database.query("SELECT result_json FROM inbox_agent_results ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?")
      .all(limit, offset) as Array<{ result_json: string }>;
    return rows.map(row => JSON.parse(row.result_json) as InboxResult);
  }

  beforeSource(id: string): Pick<Block, "id" | "text" | "revision"> | undefined {
    const result = this.getResult(id);
    const row = this.row(id);
    if (!row?.recovery_json) return undefined;
    const before = (JSON.parse(row.recovery_json) as Recovery).before.find(block => block.id === result.sourceId);
    return before && before.id === result.sourceId
      ? { id: before.id, text: before.text, revision: before.revision } : undefined;
  }

  getResult(id: string): InboxResult {
    text(id, "Inbox result ID");
    const row = this.store.database.query("SELECT result_json FROM inbox_agent_results WHERE id = ?")
      .get(id) as { result_json: string } | null;
    if (!row) throw new Error(`Inbox result not found: ${id}`);
    return JSON.parse(row.result_json) as InboxResult;
  }

  attention(limit = 30): { results: InboxResult[]; total: number } {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("Inbox attention limit must be between 1 and 1000");
    return this.store.database.transaction(() => {
      const rows = this.store.database.query(`
        SELECT r.result_json, COUNT(*) OVER() AS total
        FROM inbox_agent_results r JOIN blocks b ON b.id = r.source_id
        WHERE b.effective_deleted_root_id IS NULL
          AND r.suppressed_revision = b.revision
          AND ((b.parent_id = ? AND json_extract(r.result_json, '$.state') IN ('held', 'failed')) OR
            (json_extract(r.result_json, '$.state') = 'applied' AND json_extract(r.result_json, '$.kind') = 'unfulfilled'))
          AND r.rowid = (
            SELECT MAX(latest.rowid) FROM inbox_agent_results latest
            WHERE latest.source_id = b.id AND latest.suppressed_revision = b.revision
          )
        ORDER BY r.created_at, r.rowid LIMIT ?
      `).all(this.inbox().id, limit) as Array<{ result_json: string; total: number }>;
      return { results: rows.map(row => JSON.parse(row.result_json) as InboxResult), total: rows[0]?.total ?? 0 };
    })();
  }

  apply(id: string, source: Block, plan: InboxPlan, usage?: InboxUsage, assistance?: { candidate: NoteCandidate; plan: NotePlan }): InboxResult {
    text(id, "Inbox operation ID");
    revision(source.revision);
    validateInboxPlan(plan);
    validateUsage(usage);
    if (assistance && (assistance.candidate.source.id !== source.id || assistance.candidate.source.revision !== source.revision ||
      assistance.candidate.source.text !== source.text || assistance.candidate.source.parentId !== source.parentId)) {
      throw new Error("Inbox assistance must describe the original source revision");
    }
    const prepared = assistance ? prepareNoteEdit(assistance.candidate, assistance.plan) : undefined;
    const hash = payloadHash(source, { kind: "apply", plan, assistance });
    return this.store.database.transaction(() => {
      const previous = this.replay(id, hash);
      if (previous) return previous;
      const current = this.store.requireActive(source.id);
      if (current.revision !== source.revision || current.text !== source.text || current.parentId !== source.parentId) {
        throw new Error(`Inbox source changed since processing began: ${source.id}`);
      }
      if (current.parentId !== this.inbox().id || !this.eligible(current)) throw new Error("Inbox source is no longer an unprocessed Inbox note");
      if (this.store.database.query("SELECT 1 FROM inbox_agent_results WHERE source_id = ? AND suppressed_revision = ? LIMIT 1")
        .get(source.id, source.revision)) throw new Error("Inbox source is held; reconsider it before retrying");

      const result = this.result(id, current, plan.source.disposition === "hold" ? plan.source.reason! : plan.summary, usage);
      if (prepared && (plan.source.disposition !== "hold" || prepared.kind === "unfulfilled")) {
        result.kind = prepared.kind;
        result.summary = prepared.kind === "organized" ? `${prepared.summary}${plan.summary === "Organized note metadata" ? "" : ` · ${plan.summary}`}`
          : prepared.kind === "unfulfilled" && plan.source.disposition !== "hold" ? `${prepared.summary}\n\n${plan.summary}` : prepared.summary;
      }
      if (plan.source.disposition === "hold") {
        result.state = "held";
        this.save(result, hash, current.revision);
        this.consumeInstructions(current.id);
        return result;
      }

      const before = [current];
      const seen = new Set([current.id]);
      for (const update of plan.updates) {
        if (seen.has(update.blockId)) throw new Error("Inbox updates cannot repeat a block or include the source");
        seen.add(update.blockId);
        const target = this.store.requireActive(update.blockId);
        if (target.revision !== update.expectedRevision) throw new Error(`Inbox update target changed: ${target.id}`);
        this.requireEditable(target);
        before.push(target);
      }
      const sourceOriginals=this.originalCaptures(current,id);
      const sourceBefore=captureHistoryResource(this.store.database,this.store.resources,id,current.id);
      const connected=(value:string,originals:readonly string[],before?:string)=>patchPropertyText(value,[
        ...parsePropertyRecords(value).filter(p=>p.scope==="block"&&(p.key==="raw-capture"||p.key==="before-rewrite")).map(p=>({op:"remove" as const,ordinal:p.ordinal})),
        ...[...new Set(originals)].map(value=>({op:"append" as const,key:"raw-capture",value})),
        ...(before?[{op:"append" as const,key:"before-rewrite",value:before}]:[]),
      ]);
      const createdIds: string[] = [];
      const roots: Block[] = [];
      for (const note of plan.notes) {
        const parent = note.parentId ? this.store.requireActive(note.parentId) : this.folder("filed", roots);
        const block = this.store.create(connected(this.linkSource(note.text, source.id),sourceOriginals), parent.id, "agent", mutation);
        createdIds.push(block.id);
      }
      for (const task of plan.tasks) {
        const block = this.store.createRoadmapItem({
          title: task.title, body: connected(this.linkSource(task.body, source.id),sourceOriginals), priority: task.priority,
          project: task.project, arc: task.arc, tracks: task.tracks, relatedTo: task.relatedTo,
          sourceBlockId: source.id, workStage: "unprioritized",
        }, "agent", mutation).block;
        createdIds.push(block.id);
      }
      for (const update of plan.updates) {
        const target = before.find(block => block.id === update.blockId)!;
        this.store.update(target.id, connected(preserveProperties(target, this.linkSource(update.text, source.id)),[...this.originalCaptures(target,id),...sourceOriginals],captureHistoryResource(this.store.database,this.store.resources,id,target.id)), update.expectedRevision, mutation);
      }

      result.outputIds = [...createdIds, ...plan.updates.map(update => update.blockId)];
      const destination = this.folder(plan.source.disposition === "file" ? "filed" : "processed", roots);
      const sourceText = plan.source.disposition === "archive"
        ? `${plan.source.text.trim()}${result.outputIds.length ? `\n\nProcessed into: ${result.outputIds.map(outputId => `((${outputId}))`).join(", ")}` : ""}`
        : plan.source.text;
      let finalText = preserveProperties(current, sourceText, true);
      if (assistance) {
        finalText = preserveTags(current, finalText);
        const applied = prepareNoteEdit(assistance.candidate, assistance.plan, finalText);
        finalText = applied.text;
        if(applied.kind === "organized")result.summary = `${applied.summary}${plan.summary === "Organized note metadata" ? "" : ` · ${plan.summary}`}`;
      }
      finalText=connected(finalText,sourceOriginals,sourceBefore);
      this.store.update(current.id, finalText, current.revision, mutation);
      this.store.move(current.id, destination.id);
      const recovery: Recovery = {
        before, createdIds,
        after: [...before.map(block => block.id), ...createdIds].map(blockId => ({ id: blockId, shape: this.shape(blockId) })),
        roots: roots.map(block => ({ id: block.id, revision: block.revision, parentId: block.parentId })),
        references: createdIds.map(blockId => this.references(blockId)),
      };
      this.save(result, hash, this.store.require(current.id).revision, recovery);
      this.consumeInstructions(current.id);
      return result;
    })();
  }

  /** Read-only preflight; apply repeats authoritative checks in its write transaction. */
  validate(plan:InboxPlan,source:Block):void {
    validateInboxPlan(plan);
    for(const [index,note] of plan.notes.entries())if(note.parentId){
      const parent=this.store.get(note.parentId);
      if(!parent||parent.effectiveDeletedRootId||parent.id===source.id)throw new InboxPlanValidationError(`notes[${index}].parentId`,"Choose an active existing container other than the source");
    }
    const seen=new Set([source.id]);
    for(const [index,update] of plan.updates.entries())try {
      if(seen.has(update.blockId))throw new Error("Use source.text for the source and update each target once");
      seen.add(update.blockId);
      const target=this.store.requireActive(update.blockId);
      this.requireEditable(target);
      if(target.revision!==update.expectedRevision)throw new Error("Target revision changed; read it again");
    }catch(error){throw new InboxPlanValidationError(`updates[${index}]`,error instanceof Error?error.message:String(error));}
    for(const [index,task] of plan.tasks.entries())try {
      this.store.validateRoadmapItem({...task,sourceBlockId:source.id});
    } catch(error){throw new InboxPlanValidationError(`tasks[${index}]`,error instanceof Error?error.message:String(error));}
  }

  fail(id: string, source: Block, error: string, usage?: InboxUsage, outcome: "failed" | "canceled" = "failed"): InboxResult {
    text(id, "Inbox operation ID");
    text(error, "Inbox failure");
    revision(source.revision);
    validateUsage(usage);
    const hash = payloadHash(source, { kind: outcome, error });
    return this.store.database.transaction(() => {
      const previous = this.replay(id, hash);
      if (previous) return previous;
      const result = this.result(id, source, outcome === "canceled" ? "Cleanup canceled; the source is unchanged." : "Cleanup failed; the source is unchanged.", usage);
      result.state = outcome;
      result.error = error;
      this.save(result, hash, outcome === "canceled" ? null : source.revision);
      return result;
    })();
  }

  undo(id: string, checkpointRestored?: (blocks: Block[]) => void): InboxResult {
    return this.store.database.transaction(() => {
      const row = this.row(id);
      if (!row) throw new Error(`Inbox result not found: ${id}`);
      const result = JSON.parse(row.result_json) as InboxResult;
      if (result.state === "undone") return result;
      if (result.state !== "applied" || !row.recovery_json) throw new Error("Only applied Inbox cleanups can be undone");
      const recovery = JSON.parse(row.recovery_json) as Recovery;
      for (const snapshot of recovery.after) {
        if (JSON.stringify(this.shape(snapshot.id)) !== JSON.stringify(snapshot.shape)) {
          throw new Error(`Cannot undo Inbox cleanup: block or children changed since cleanup (${snapshot.id})`);
        }
      }
      const owned = new Set([...recovery.before.map(block => block.id), ...recovery.createdIds]);
      for (const createdId of recovery.createdIds) {
        if (this.store.listAnnotationThreads({ subject: { kind: "block", blockId: createdId }, includeResolved: true }).length) {
          throw new Error(`Cannot undo Inbox cleanup: created output has a later annotation (${createdId})`);
        }
        const current = this.references(createdId);
        const previous = recovery.references?.find(reference => reference.id === createdId);
        if (!current.complete || previous?.complete === false || current.sources.some(source =>
          !owned.has(source.id) && !previous?.sources.some(old => old.id === source.id && old.revision === source.revision))) {
          throw new Error(`Cannot undo Inbox cleanup: created output has new or changed references (${createdId})`);
        }
      }
      for (const before of recovery.before) {
        if (before.parentId) this.store.requireActive(before.parentId);
      }
      for (const createdId of recovery.createdIds) this.store.delete(createdId);
      for (const before of recovery.before) {
        const current = this.store.requireActive(before.id);
        this.store.update(before.id, before.text, current.revision, mutation);
        if (current.parentId !== before.parentId) this.store.move(before.id, before.parentId, before.position);
      }
      // A helper folder may now be shared by later cleanups. Remove it only while still empty and untouched.
      for (const root of recovery.roots) {
        const current = this.store.get(root.id);
        if (current && !current.effectiveDeletedRootId && current.revision === root.revision &&
          current.parentId === root.parentId && this.store.children(root.id).length === 0) this.store.delete(root.id);
      }
      checkpointRestored?.(recovery.before.map(before => this.store.requireActive(before.id)));
      result.state = "undone";
      this.store.database.query("UPDATE inbox_agent_results SET result_json = ?, suppressed_revision = ? WHERE id = ?")
        .run(JSON.stringify(result), this.store.require(result.sourceId).revision, id);
      return result;
    })();
  }

  reconsider(sourceId: string, instructions?: string): boolean {
    if (instructions !== undefined && typeof instructions !== "string") throw new Error("Inbox instructions must be a string");
    return this.store.database.transaction(() => {
      const source = this.store.get(sourceId);
      if (!source || source.effectiveDeletedRootId || source.parentId !== this.inbox().id || !this.eligible(source)) return false;
      this.store.database.query("UPDATE inbox_agent_results SET suppressed_revision = NULL WHERE source_id = ?").run(sourceId);
      if (instructions?.trim()) {
        this.store.database.query(`
          INSERT INTO inbox_agent_instructions (source_id, instructions) VALUES (?, ?)
          ON CONFLICT (source_id) DO UPDATE SET instructions = excluded.instructions
        `).run(sourceId, instructions.trim());
      } else if (instructions !== undefined) this.consumeInstructions(sourceId);
      return true;
    })();
  }

  private consumeInstructions(sourceId: string): void {
    this.store.database.query("DELETE FROM inbox_agent_instructions WHERE source_id = ?").run(sourceId);
  }

  private inbox(): Block {
    const roots = this.findRoots({ key: "system-view", value: "inbox" });
    if (roots.length !== 1) throw new Error(`Workspace must contain exactly one active [system-view::inbox]; found ${roots.length}`);
    return roots[0]!;
  }

  private eligible(block: Block): boolean {
    if (block.author === "system" || block.actorId === "inbox-agent" || has(block, "system-view") || has(block, "system-doc") ||
      has(block, "work-id") || has(block, "work-stage")) return false;
    const types = block.properties.filter(property => property.key === "type").map(property => property.value.toLowerCase());
    if (types.some(type => !ordinaryTypes.has(type))) return false;
    const statuses = block.properties.filter(property => property.key === "status");
    if (statuses.length && (statuses.length !== 1 || statuses[0]!.value.toLowerCase() !== "unprocessed")) return false;
    return block.author === "user" || (types.length === 1 && types[0] === "capture" && has(block, "capture-source"));
  }

  private requireEditable(block: Block): void {
    if (block.author === "system" || has(block, "system-view") || has(block, "system-doc") ||
      has(block, "type", "annotation") || has(block, "type", "annotation-reply") ||
      this.store.database.query("SELECT 1 FROM annotation_targets WHERE annotation_block_id = ?").get(block.id)) {
      throw new Error(`Inbox cannot rewrite managed or annotation blocks: ${block.id}`);
    }
  }

  private findRoots(property: BlockProperty): Block[] {
    const rows = this.store.database.query(`
      SELECT DISTINCT b.id FROM blocks b JOIN block_properties p ON p.block_id = b.id
      WHERE b.effective_deleted_root_id IS NULL AND p.scope = 'block' AND p.key = ? AND LOWER(p.value) = ?
      ORDER BY b.id
    `).all(property.key, property.value) as Array<{ id: string }>;
    return rows.map(({ id }) => this.store.require(id));
  }

  private folder(kind: "filed" | "processed", created: Block[]): Block {
    const roots = this.findRoots({ key: "inbox-folder", value: kind });
    if (roots.length > 1 || roots.some(root => root.parentId !== null)) throw new Error(`Ambiguous Inbox ${kind} folder`);
    if (roots[0]) return roots[0];
    const root = this.store.create(`${kind === "filed" ? "Filed notes" : "Processed captures"} [inbox-folder::${kind}]`, null, "system");
    created.push(root);
    return root;
  }

  private originalCaptures(block:Block,currentAttemptId:string):string[] {
    return captureOriginalResources(this.store.database,this.store.resources,block,currentAttemptId);
  }

  private linkSource(value: string, sourceId: string): string {
    return `${value.trim()}\n\nSource: ((${sourceId}))`.trim();
  }

  private shape(id: string): ShapeRow[] {
    // Parent changes do not advance text revisions. Child revisions/identity also protect content added beneath outputs.
    return this.store.database.query(`
      WITH RECURSIVE subtree(id) AS (
        SELECT id FROM blocks WHERE id = ?
        UNION ALL SELECT b.id FROM blocks b JOIN subtree s ON b.parent_id = s.id
      )
      SELECT b.id, b.parent_id, b.revision, CASE WHEN b.id = ? THEN NULL ELSE b.position END AS position,
        b.deleted_at, b.effective_deleted_root_id
      FROM blocks b JOIN subtree s ON s.id = b.id ORDER BY b.id
    `).all(id, id) as ShapeRow[];
  }

  private references(id: string): NonNullable<Recovery["references"]>[number] {
    const result = this.store.queryBacklinks({ targetBlockId: id, limit: 1000 });
    return {
      id, complete: result.completeness.kind === "complete",
      sources: result.sources.map(source => ({ id: source.blockId, revision: this.store.require(source.blockId).revision })),
    };
  }

  private result(id: string, source: Block, summary: string, usage?: InboxUsage): InboxResult {
    return {
      id, sourceId: source.id, sourceTitle: firstLineWithoutPropertyTokens(source.text)?.trim() ?? "Untitled capture",
      summary, state: "applied", outputIds: [], createdAt: new Date().toISOString(), ...(usage ? { usage } : {}),
    };
  }

  private row(id: string): ResultRow | null {
    return this.store.database.query("SELECT payload_hash, result_json, recovery_json FROM inbox_agent_results WHERE id = ?").get(id) as ResultRow | null;
  }

  private replay(id: string, hash: string): InboxResult | null {
    const row = this.row(id);
    if (!row) return null;
    if (row.payload_hash !== hash) throw new Error("Inbox operation ID already belongs to a different source revision or plan");
    return JSON.parse(row.result_json) as InboxResult;
  }

  private save(result: InboxResult, hash: string, suppressedRevision: number | null, recovery?: Recovery): void {
    this.store.database.query(`
      INSERT INTO inbox_agent_results (id, source_id, suppressed_revision, payload_hash, result_json, recovery_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(result.id, result.sourceId, suppressedRevision, hash, JSON.stringify(result), recovery ? JSON.stringify(recovery) : null, result.createdAt);
  }
}
