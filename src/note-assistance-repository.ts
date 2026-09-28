import {noteMetadataSummary} from "./inbox-observations";
import { createHash } from "node:crypto";
import { isManagedNote, NOTE_TYPES } from "./note-kinds";
import { passageKey, requestPassages } from "./note-content";
import { firstLineWithoutPropertyTokens, parseProperties, parsePropertyRecords, patchPropertyText } from "./properties";
import type { InboxResult, InboxUsage } from "./inbox-types";
import type { NoteCandidate, NotePlan } from "./note-assistance-types";
import type { OutlinerStore } from "./store";
import type { Block, PropertyPatchOperation } from "./types";
import { BLOCK_EDIT_ACTIVITY_KIND_SQL } from "./types";

interface State {
  blockId: string;
  revision: number;
  fingerprint: string;
  activityCursor: number;
  observedTypes: string[];
  seenRequestPassages: string[];
  inferredType?: string;
  inferredTags: string[];
  rejectedTags: string[];
  typeLocked: boolean;
  lastRequestKey?: string;
  lastResultId?: string;
  reconsider: boolean;
  instructions?: string;
}

interface StateRow { handled_revision: number; state_json: string }
interface ResultRow { payload_hash: string; result_json: string; recovery_json: string | null }
interface Recovery { before: Block; beforeState: State; afterRevision: number; afterState: State }

const mutation = { author: "agent" as const, actorId: "note-assistant" };
const ownedKeys = new Set(["type", "tag", "request-status"]);

function nonempty(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a nonempty string`);
  return value.trim();
}

function tag(value: string): string {
  return value.trim().replace(/^#/, "").toLowerCase();
}

function tags(block: Block): string[] {
  return [...new Set(block.properties.filter(property => property.key === "tag").map(property => tag(property.value)))];
}

function types(block: Block): string[] {
  return block.properties.filter(property => property.key === "type").map(property => property.value.toLowerCase());
}

function withoutOwnedProperties(text: string): string {
  return patchPropertyText(text, parsePropertyRecords(text)
    .filter(property => property.scope === "block" && property.syntax !== "hashtag" && ownedKeys.has(property.key))
    .map(property => ({ op: "remove", ordinal: property.ordinal })));
}

function fingerprint(block: Block): string {
  return createHash("sha256").update(withoutOwnedProperties(block.text).replace(/\s+/g, " ").trim()).digest("hex");
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([, field]) => field !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, field]) => [key, stable(field)]));
  return value;
}

function payloadHash(candidate: NoteCandidate, payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(stable({ candidate, payload }))).digest("hex");
}

/** This deliberately excludes records with product behavior, not agent-authored prose. */
export function isNoteAssistanceEligible(block: Block): boolean {
  return !block.deletedAt && !block.effectiveDeletedRootId && !isManagedNote(block) &&
    !!firstLineWithoutPropertyTokens(block.text)?.trim();
}

function validatePlan(plan: NotePlan): void {
  nonempty(plan?.summary, "Note assistance summary");
  if (plan.type !== undefined && !(NOTE_TYPES as readonly string[]).includes(plan.type)) {
    throw new Error("Note assistance requires an ordinary canonical type");
  }
  if (!Array.isArray(plan.tags) || plan.tags.length > 32 || plan.tags.some(value =>
    typeof value !== "string" || !tag(value) || tag(value).length > 100 || /[\s\[\]]/.test(tag(value)))) {
    throw new Error("Note assistance tags must be at most 32 nonempty tag names");
  }
  if (plan.fulfillment !== undefined) {
    nonempty(plan.fulfillment.key, "Request identity");
    if (!["property-inventory", "answer"].includes(plan.fulfillment.operation)) throw new Error("Unsupported note request operation");
    nonempty(plan.fulfillment.text, "Request result text");
    nonempty(plan.fulfillment.summary, "Request result summary");
  }
  if (plan.unfulfilledRequest !== undefined) {
    if (plan.fulfillment !== undefined) throw new Error("A note request cannot be both fulfilled and unfulfilled");
    nonempty(plan.unfulfilledRequest.key, "Unfulfilled request identity");
    nonempty(plan.unfulfilledRequest.reason, "Unfulfilled request reason");
  }
}

function validateUsage(usage?: InboxUsage): void {
  if (usage === undefined) return;
  nonempty(usage.provider, "Usage provider");
  nonempty(usage.model, "Usage model");
  for (const key of ["inputTokens", "outputTokens", "cost", "jevCalls", "elapsedMs"] as const) {
    if (typeof usage[key] !== "number" || !Number.isFinite(usage[key]) || usage[key] < 0) throw new Error(`Invalid usage ${key}`);
  }
}

/** The original candidate owns authored metadata; an optional edited draft never acquires that authority. */
export function prepareNoteEdit(candidate: NoteCandidate, plan: NotePlan, draftText?: string): {
  text: string;
  inferredType?: string;
  inferredTags: string[];
  lastRequestKey?: string;
  kind: "organized" | "fulfilled" | "unfulfilled";
  summary: string;
} {
  validatePlan(plan);
  const source = candidate.source;
  const fulfillment = plan.fulfillment?.key === candidate.lastRequestKey ? undefined : plan.fulfillment;
  const unfulfilled = plan.unfulfilledRequest?.key === candidate.lastRequestKey ? undefined : plan.unfulfilledRequest;
  if ((fulfillment || unfulfilled) && !candidate.requestAllowed) throw new Error("This note does not contain fresh user intent; reconsider it explicitly");
  const requestStatus = fulfillment ? "fulfilled" : unfulfilled ? "open" : undefined;
  const originalTags = tags(source);
  const authoredTags = originalTags.filter(value => !candidate.inferredTags.includes(value));
  const draftProperties = draftText === undefined ? undefined : parseProperties(draftText);
  const editorTags = draftProperties?.filter(property => property.key === "tag").map(property => tag(property.value))
    .filter(value => !originalTags.includes(value)) ?? [];
  const inferredTags = [...new Set([...plan.tags.map(tag), ...editorTags])].filter(value =>
    !authoredTags.includes(value) && !candidate.rejectedTags.includes(value));
  const desiredTags = new Set([...authoredTags, ...inferredTags]);
  const nextType = candidate.typeLocked ? undefined : plan.type;
  const replaceType = nextType !== undefined && (types(source).length !== 1 || types(source)[0] !== nextType);
  let text = draftText ?? source.text;
  if (fulfillment) {
    // The writer supplies prose. Every existing block property remains service-owned.
    const body = draftText ?? fulfillment.text;
    const clean = patchPropertyText(body, parsePropertyRecords(body)
      .filter(property => property.scope === "block" && property.syntax !== "hashtag")
      .map(property => ({ op: "remove", ordinal: property.ordinal }))).trim();
    if (!clean) throw new Error("Request result requires authored content");
    const retainedTags = new Set(parsePropertyRecords(clean).filter(property => property.key === "tag" && property.scope === "block")
      .map(property => tag(property.value)));
    text = patchPropertyText(clean, (draftProperties ?? source.properties)
      .filter(property => property.key !== "tag" || !retainedTags.has(tag(property.value)))
      .map(property => ({ op: "append", ...property })));
  }
  const operations: PropertyPatchOperation[] = [];
  for (const property of parsePropertyRecords(text)) {
    if (property.scope !== "block") continue;
    if (property.key === "tag" && !desiredTags.has(tag(property.value))) operations.push({ op: "remove", ordinal: property.ordinal });
    if (property.key === "type" && replaceType) operations.push({ op: "remove", ordinal: property.ordinal });
    if (property.key === "request-status" && requestStatus) operations.push({ op: "remove", ordinal: property.ordinal });
  }
  const presentTags = new Set(parsePropertyRecords(text).filter(property => property.scope === "block" && property.key === "tag")
    .map(property => tag(property.value)));
  for (const value of inferredTags) {
    if (!presentTags.has(value)) operations.push({ op: "append", key: "tag", value });
  }
  if (replaceType) operations.push({ op: "append", key: "type", value: nextType! });
  if (requestStatus) operations.push({ op: "append", key: "request-status", value: requestStatus });
  const finalText=patchPropertyText(text, operations);
  return {
    text: finalText,
    inferredType: nextType ?? candidate.inferredType,
    inferredTags,
    lastRequestKey: fulfillment?.key ?? candidate.lastRequestKey,
    kind: fulfillment ? "fulfilled" : unfulfilled ? "unfulfilled" : "organized",
    summary: fulfillment ? `Fulfilled: ${fulfillment.summary}` : unfulfilled ? `Unfulfilled: ${unfulfilled.reason}` : noteMetadataSummary(source.text,finalText),
  };
}

/** Revisions derive the work; checkpoints and receipts commit with the canonical note. */
export class NoteAssistanceRepository {
  constructor(private readonly store: OutlinerStore) {
    store.database.exec(`
      CREATE TABLE IF NOT EXISTS note_assistance_state (
        block_id TEXT PRIMARY KEY REFERENCES blocks(id) ON DELETE CASCADE,
        handled_revision INTEGER NOT NULL,
        state_json TEXT NOT NULL CHECK (json_valid(state_json))
      );
      CREATE TABLE IF NOT EXISTS note_assistance_results (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
        source_parent_id TEXT,
        payload_hash TEXT NOT NULL,
        result_json TEXT NOT NULL CHECK (json_valid(result_json)),
        recovery_json TEXT CHECK (recovery_json IS NULL OR json_valid(recovery_json)),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS note_assistance_results_source ON note_assistance_results(source_id);
    `);
  }

  /** Run before enabling the worker. Old notes, including Trash, are not a request queue. */
  initialize(): void {
    this.store.database.transaction(() => {
      if (this.store.database.query("SELECT 1 FROM metadata WHERE key = 'note_assistance_initialized'").get()) return;
      const rows = this.store.database.query("SELECT id FROM blocks").all() as Array<{ id: string }>;
      for (const { id } of rows) this.saveState(this.initialState(this.store.require(id)));
      this.store.database.query("INSERT INTO metadata (key, value) VALUES ('note_assistance_initialized', '1')").run();
    })();
  }

  pending(excludeIds: ReadonlySet<string> = new Set()): NoteCandidate[] {
    this.requireInitialized();
    return this.store.database.transaction(() => {
      const rows = this.store.database.query(`
        SELECT b.id FROM blocks b LEFT JOIN note_assistance_state s ON s.block_id = b.id
        WHERE b.effective_deleted_root_id IS NULL AND (
          s.block_id IS NULL OR s.handled_revision != b.revision OR json_extract(s.state_json, '$.reconsider') = 1
        ) ORDER BY b.created_at, b.id
      `).all() as Array<{ id: string }>;
      const pending: NoteCandidate[] = [];
      for (const { id } of rows) {
        const previous = this.state(id);
        if (excludeIds.has(id) && !previous?.reconsider) continue;
        const source = this.store.require(id);
        const state = this.observe(source, previous);
        const agentChangedType = previous && !state.typeLocked &&
          JSON.stringify(types(source)) !== JSON.stringify(previous.observedTypes);
        if (!isNoteAssistanceEligible(source) || this.store.isCaptureDraft(source.id) || (previous && !state.reconsider && !agentChangedType && state.fingerprint === fingerprint(source))) {
          this.checkpoint(source, state);
          continue;
        }
        pending.push(this.candidate(source, state, previous));
      }
      return pending;
    })();
  }

  /** Read current assistance context without adding, consuming, or checkpointing work. */
  candidateFor(sourceId: string): NoteCandidate | undefined {
    this.requireInitialized();
    const source = this.store.get(sourceId);
    if (!source || !isNoteAssistanceEligible(source) || this.store.isCaptureDraft(source.id)) return undefined;
    const previous = this.state(sourceId);
    return this.candidate(source, this.observe(source, previous), previous);
  }

  /** The caller commits this with Inbox.apply, so its outputs cannot immediately invalidate Inbox Undo. */
  checkpointEditorial(result: InboxResult, candidate?: NoteCandidate, plan?: NotePlan): void {
    this.requireInitialized();
    if (candidate && candidate.source.id !== result.sourceId) throw new Error("Inbox assistance candidate does not match its source");
    if (plan && !candidate) throw new Error("Inbox assistance requires its original candidate");
    this.store.database.transaction(() => {
      for (const id of new Set([result.sourceId, ...result.outputIds])) {
        const source = this.store.requireActive(id);
        const previous = this.state(id);
        let state = this.observe(source, previous);
        if (id === result.sourceId && candidate && plan && result.state === "applied") {
          const prepared = prepareNoteEdit(candidate, plan, source.text);
          state = {
            ...this.observe(candidate.source, previous),
            inferredType: types(source).includes(prepared.inferredType ?? "") ? prepared.inferredType : undefined,
            inferredTags: prepared.inferredTags.filter(value => tags(source).includes(value)),
            lastRequestKey: prepared.lastRequestKey,
            lastResultId: result.id,
          };
        }
        this.checkpoint(source, state);
      }
    })();
  }

  /** Undo is an explicit correction, not fresh prose for another automatic pass. */
  checkpointRestored(blocks: readonly Block[]): void {
    this.requireInitialized();
    for (const source of blocks) {
      const previous = this.state(source.id);
      if (!previous) {
        this.checkpoint(source, this.initialState(source));
        continue;
      }
      const presentTags = tags(source);
      const typeChanged = JSON.stringify(types(source)) !== JSON.stringify(previous.observedTypes);
      this.checkpoint(source, {
        ...previous,
        inferredType: typeChanged ? undefined : previous.inferredType,
        typeLocked: previous.typeLocked || typeChanged,
        inferredTags: previous.inferredTags.filter(value => presentTags.includes(value)),
        rejectedTags: [...new Set([...previous.rejectedTags, ...previous.inferredTags.filter(value => !presentTags.includes(value))])],
      });
    }
  }

  apply(id: string, candidate: NoteCandidate, plan: NotePlan, usage?: InboxUsage): InboxResult {
    this.requireInitialized();
    nonempty(id, "Note operation ID");
    validatePlan(plan);
    validateUsage(usage);
    const hash = payloadHash(candidate, { kind: "apply", plan });
    return this.store.database.transaction(() => {
      const replay = this.replay(id, hash);
      if (replay) return replay;
      const source = this.requireUnchanged(candidate.source);
      if (!isNoteAssistanceEligible(source) || this.store.isCaptureDraft(source.id)) throw new Error("Note is no longer eligible for assistance");
      const previous = this.state(source.id);
      const beforeState = this.observe(source, previous);
      const current = this.candidate(source, beforeState, previous);
      if (current.instructions !== candidate.instructions || current.requestAllowed !== candidate.requestAllowed) {
        throw new Error("Note reconsideration changed since assistance began");
      }
      const prepared = prepareNoteEdit(current, plan);
      // Avoid revision churn when the classifier confirms the current metadata.
      const changed = prepared.text !== source.text;
      const after = changed ? this.store.update(source.id, prepared.text, source.revision, mutation, prepared.kind === "fulfilled" ? "text" : "properties") : source;
      const afterState: State = {
        ...beforeState,
        inferredType: prepared.inferredType,
        inferredTags: prepared.inferredTags,
        lastRequestKey: prepared.lastRequestKey,
        lastResultId: id,
      };
      this.checkpoint(after, afterState);
      const result = this.result(id, source, prepared.summary, usage);
      result.kind = prepared.kind;
      this.save(result, hash, after, { before: source, beforeState, afterRevision: after.revision, afterState });
      return result;
    })();
  }

  fail(id: string, candidate: NoteCandidate, error: string, usage?: InboxUsage, outcome: "failed" | "canceled" = "failed"): InboxResult {
    this.requireInitialized();
    nonempty(id, "Note operation ID");
    nonempty(error, "Note assistance error");
    validateUsage(usage);
    const hash = payloadHash(candidate, { kind: outcome, error });
    return this.store.database.transaction(() => {
      const replay = this.replay(id, hash);
      if (replay) return replay;
      const result = this.result(id, candidate.source, outcome === "canceled" ? "Note assistance canceled; the note is unchanged." : "Note assistance failed; the note is unchanged.", usage);
      result.state = outcome;
      result.error = error;
      const current = this.store.get(candidate.source.id);
      if (outcome !== "canceled" && current && !current.effectiveDeletedRootId && current.revision === candidate.source.revision && current.parentId === candidate.source.parentId) {
        const previous = this.state(current.id);
        const state = this.observe(current, previous);
        const pending = this.candidate(current, state, previous);
        if (pending.instructions === candidate.instructions && pending.requestAllowed === candidate.requestAllowed) this.checkpoint(current, state);
      }
      this.save(result, hash, candidate.source);
      return result;
    })();
  }

  results(limit = 30, offset = 0): InboxResult[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid note result page");
    const rows = this.store.database.query("SELECT result_json FROM note_assistance_results ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?")
      .all(limit, offset) as Array<{ result_json: string }>;
    return rows.map(row => JSON.parse(row.result_json) as InboxResult);
  }

  beforeSource(id: string): Pick<Block, "id" | "text" | "revision"> | undefined {
    const result = this.getResult(id);
    const row = this.row(id);
    if (!row?.recovery_json) return undefined;
    const before = (JSON.parse(row.recovery_json) as Recovery).before;
    return before && before.id === result.sourceId
      ? { id: before.id, text: before.text, revision: before.revision } : undefined;
  }

  getResult(id: string): InboxResult {
    const row = this.row(id);
    if (!row) throw new Error(`Note assistance result not found: ${id}`);
    return JSON.parse(row.result_json) as InboxResult;
  }

  hasResult(id: string): boolean {
    return !!this.store.database.query("SELECT 1 FROM note_assistance_results WHERE id = ?").get(id);
  }

  attention(limit = 30, offset = 0): { results: InboxResult[]; total: number } {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid note attention page");
    return this.store.database.transaction(() => {
      const rows = this.store.database.query(`
        SELECT r.source_id, r.result_json FROM note_assistance_results r JOIN blocks b ON b.id = r.source_id
        WHERE b.effective_deleted_root_id IS NULL AND r.source_revision = b.revision AND r.source_parent_id IS b.parent_id
          AND (json_extract(r.result_json, '$.state') IN ('held', 'failed') OR
            (json_extract(r.result_json, '$.state') = 'applied' AND json_extract(r.result_json, '$.kind') = 'unfulfilled'))
          AND r.rowid = (SELECT MAX(latest.rowid) FROM note_assistance_results latest WHERE latest.source_id = r.source_id)
        ORDER BY r.created_at, r.rowid
      `).all() as Array<{ source_id: string; result_json: string }>;
      // Use the same managed-record boundary as processing, including custom types.
      const results = rows.filter(row => isNoteAssistanceEligible(this.store.require(row.source_id)))
        .map(row => JSON.parse(row.result_json) as InboxResult);
      return { results: results.slice(offset, offset + limit), total: results.length };
    })();
  }

  undo(id: string): InboxResult {
    return this.store.database.transaction(() => {
      const row = this.row(id);
      if (!row) throw new Error(`Note assistance result not found: ${id}`);
      const result = JSON.parse(row.result_json) as InboxResult;
      if (result.state === "undone") return result;
      if (result.state !== "applied" || !row.recovery_json) throw new Error("Only applied note assistance can be undone");
      const recovery = JSON.parse(row.recovery_json) as Recovery;
      const current = this.store.requireActive(recovery.before.id);
      if (current.revision !== recovery.afterRevision || current.parentId !== recovery.before.parentId || this.state(current.id)?.lastResultId !== id) {
        throw new Error("Cannot undo note assistance: the note changed since assistance");
      }
      const restored = current.text === recovery.before.text ? current
        : this.store.update(current.id, recovery.before.text, current.revision, mutation);
      const rejectedTags = [...new Set([...recovery.beforeState.rejectedTags,
        ...recovery.afterState.inferredTags.filter(value => !tags(restored).includes(value))])];
      this.checkpoint(restored, {
        ...recovery.beforeState,
        rejectedTags,
        typeLocked: recovery.beforeState.typeLocked || recovery.afterState.inferredType !== recovery.beforeState.inferredType,
        lastRequestKey: recovery.afterState.lastRequestKey,
        lastResultId: id,
      });
      result.state = "undone";
      this.store.database.query("UPDATE note_assistance_results SET result_json = ? WHERE id = ?").run(JSON.stringify(result), id);
      return result;
    })();
  }

  reconsider(sourceId: string, instructions?: string): boolean {
    this.requireInitialized();
    if (instructions !== undefined && (typeof instructions !== "string" || instructions.length > 2000)) {
      throw new Error("Steering instructions must be at most 2000 characters");
    }
    return this.store.database.transaction(() => {
      const source = this.store.get(sourceId);
      if (!source || !isNoteAssistanceEligible(source)) return false;
      const state = this.observe(source, this.state(sourceId));
      this.saveState({ ...state, reconsider: true, lastRequestKey: undefined, instructions: instructions?.trim() || undefined });
      return true;
    })();
  }

  private activityCursor(id: string): number {
    return (this.store.database.query(`SELECT COALESCE(MAX(activity_id), 0) AS cursor FROM block_edit_activity WHERE block_id = ? AND ${BLOCK_EDIT_ACTIVITY_KIND_SQL}`)
      .get(id) as { cursor: number }).cursor;
  }

  private requireInitialized(): void {
    if (!this.store.database.query("SELECT 1 FROM metadata WHERE key = 'note_assistance_initialized'").get()) {
      throw new Error("Initialize note assistance before processing workspace notes");
    }
  }

  private initialState(source: Block): State {
    const values = types(source);
    const automaticCapture = values.length === 1 && values[0] === "capture" && source.properties.some(property => property.key === "capture-source");
    const latestEdit = this.store.database.query(`SELECT author FROM block_edit_activity WHERE block_id = ? AND ${BLOCK_EDIT_ACTIVITY_KIND_SQL} ORDER BY activity_id DESC LIMIT 1`)
      .get(source.id) as { author: string } | null;
    const userEdited = !!this.store.database.query(`SELECT 1 FROM block_edit_activity WHERE block_id = ? AND ${BLOCK_EDIT_ACTIVITY_KIND_SQL} AND author = 'user' LIMIT 1`).get(source.id);
    const agentType = source.author !== "user" && !userEdited && (latestEdit?.author ?? source.author) === "agent";
    return {
      blockId: source.id, revision: source.revision, fingerprint: fingerprint(source), activityCursor: this.activityCursor(source.id),
      observedTypes: values,
      seenRequestPassages: requestPassages(source.text).map(passageKey),
      inferredType: (automaticCapture || agentType) && values.length === 1 ? values[0] : undefined,
      inferredTags: [], rejectedTags: [], typeLocked: !!values.length && !automaticCapture && !agentType,
      reconsider: false,
    };
  }

  private observe(source: Block, previous: State | null): State {
    if (!previous) return this.initialState(source);
    const currentTags = tags(source);
    const removed = previous.inferredTags.filter(value => !currentTags.includes(value));
    const currentTypes = types(source);
    const changedType = JSON.stringify(currentTypes) !== JSON.stringify(previous.observedTypes);
    const latestEdit = changedType ? this.store.database.query(`
      SELECT author FROM block_edit_activity WHERE block_id = ? AND ${BLOCK_EDIT_ACTIVITY_KIND_SQL} AND activity_id > ? ORDER BY activity_id DESC LIMIT 1
    `).get(source.id, previous.activityCursor) as { author: string } | null : null;
    // Activity records do not isolate property authorship. A later agent prose edit cannot erase a human correction.
    const userEdited = changedType && !!this.store.database.query(`
      SELECT 1 FROM block_edit_activity WHERE block_id = ? AND ${BLOCK_EDIT_ACTIVITY_KIND_SQL} AND activity_id > ? AND author = 'user' LIMIT 1
    `).get(source.id, previous.activityCursor);
    const agentType = changedType && !userEdited && latestEdit?.author === "agent";
    return {
      ...previous,
      inferredType: changedType ? agentType && currentTypes.length === 1 ? currentTypes[0] : undefined : previous.inferredType,
      inferredTags: previous.inferredTags.filter(value => currentTags.includes(value)),
      rejectedTags: [...new Set([...previous.rejectedTags.filter(value => !currentTags.includes(value)), ...removed])],
      typeLocked: changedType ? !agentType : previous.typeLocked,
    };
  }

  private candidate(source: Block, state: State, previous: State | null): NoteCandidate {
    const latestTextEdit = this.store.database.query(`
      SELECT author FROM block_edit_activity WHERE block_id = ? AND kind = 'text' AND activity_id > ?
      ORDER BY activity_id DESC LIMIT 1
    `).get(source.id, previous?.activityCursor ?? 0) as { author: string } | null;
    return {
      source, inferredType: state.inferredType, inferredTags: state.inferredTags,
      rejectedTags: state.rejectedTags, typeLocked: state.typeLocked, lastRequestKey: state.lastRequestKey,
      requestAllowed: state.reconsider || (!previous && source.author === "user") || latestTextEdit?.author === "user",
      explicitReconsideration: state.reconsider,
      seenRequestPassages: previous?.seenRequestPassages ?? [],
      ...(state.reconsider && state.instructions ? { instructions: state.instructions } : {}),
    };
  }

  private requireUnchanged(source: Block): Block {
    const current = this.store.requireActive(source.id);
    if (current.revision !== source.revision || current.parentId !== source.parentId || current.text !== source.text) {
      throw new Error("Note changed since assistance began");
    }
    return current;
  }

  private state(id: string): State | null {
    const row = this.store.database.query("SELECT handled_revision, state_json FROM note_assistance_state WHERE block_id = ?").get(id) as StateRow | null;
    return row ? JSON.parse(row.state_json) as State : null;
  }

  private checkpoint(source: Block, state: State): void {
    this.saveState({ ...state, revision: source.revision, fingerprint: fingerprint(source), activityCursor: this.activityCursor(source.id),
      observedTypes: types(source), seenRequestPassages: requestPassages(source.text).map(passageKey), reconsider: false, instructions: undefined });
  }

  private saveState(state: State): void {
    this.store.database.query(`
      INSERT INTO note_assistance_state (block_id, handled_revision, state_json) VALUES (?, ?, ?)
      ON CONFLICT(block_id) DO UPDATE SET handled_revision = excluded.handled_revision, state_json = excluded.state_json
    `).run(state.blockId, state.revision, JSON.stringify(state));
  }

  private result(id: string, source: Block, summary: string, usage?: InboxUsage): InboxResult {
    return { id, sourceId: source.id, sourceTitle: firstLineWithoutPropertyTokens(source.text)?.trim() ?? "Untitled note",
      summary, state: "applied", outputIds: [], createdAt: new Date().toISOString(), ...(usage ? { usage } : {}) };
  }

  private row(id: string): ResultRow | null {
    return this.store.database.query("SELECT payload_hash, result_json, recovery_json FROM note_assistance_results WHERE id = ?").get(id) as ResultRow | null;
  }

  private replay(id: string, hash: string): InboxResult | null {
    const row = this.row(id);
    if (!row) return null;
    if (row.payload_hash !== hash) throw new Error("Note operation ID already belongs to different input");
    return JSON.parse(row.result_json) as InboxResult;
  }

  private save(result: InboxResult, hash: string, source: Block, recovery?: Recovery): void {
    this.store.database.query(`
      INSERT INTO note_assistance_results (id, source_id, source_revision, source_parent_id, payload_hash, result_json, recovery_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(result.id, result.sourceId, source.revision, source.parentId, hash, JSON.stringify(result), recovery ? JSON.stringify(recovery) : null, result.createdAt);
  }
}
