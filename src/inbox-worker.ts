import {InboxAttempts,InboxConflictError,inboxFailureKind} from "./inbox-attempts";
import { combinedInboxUsage } from "./inbox-usage";
import { InboxRepository, summarizeInboxResult } from "./inbox-repository";
import type { InboxModel, InboxPlan, InboxResult, InboxStatus, InboxUsage } from "./inbox-types";
import { isNoteAssistanceEligible, NoteAssistanceRepository } from "./note-assistance-repository";
import type { NoteModel } from "./note-assistance-model";
import { blockDisplayTitle } from "./references";
import type { OutlinerStore } from "./store";
import type { Block, PropertyInventory } from "./types";

/** Both operation histories, with one global page; receipts remain with their operations. */
export function assistantActivity(store: OutlinerStore, inbox: InboxRepository, notes?: NoteAssistanceRepository,
  attentionOnly = false, offset = 0): { results: InboxResult[]; attentionCount: number } {
  if (!notes) {
    const attention = inbox.attention(31);
    return { results: attentionOnly ? attention.results : inbox.results(31, offset), attentionCount: attention.total };
  }
  // Attention belongs to the latest operation on a note, even when that note
  // moves from Inbox editing to workspace assistance without changing revision.
  const attentionRows = store.database.query(`
    WITH operations AS (
      SELECT source_id, suppressed_revision AS revision, NULL AS parent_id,
        result_json, created_at, 0 AS origin, rowid AS ordinal FROM inbox_agent_results
      UNION ALL
      SELECT source_id, source_revision, source_parent_id,
        result_json, created_at, 1 AS origin, rowid AS ordinal FROM note_assistance_results
    ), latest AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY source_id ORDER BY created_at DESC, origin DESC, ordinal DESC) AS rank
      FROM operations
    )
    SELECT r.source_id, r.origin, r.result_json FROM latest r JOIN blocks b ON b.id = r.source_id
    WHERE r.rank = 1 AND r.revision = b.revision AND b.effective_deleted_root_id IS NULL
      AND (r.origin = 0 OR r.parent_id IS b.parent_id)
      AND (
        (json_extract(r.result_json, '$.state') = 'applied' AND json_extract(r.result_json, '$.kind') = 'unfulfilled')
        OR (json_extract(r.result_json, '$.state') IN ('held', 'failed') AND (r.origin = 1 OR b.parent_id IN (
          SELECT block_id FROM block_properties WHERE key = 'system-view' AND LOWER(value) = 'inbox' AND scope = 'block'
        )))
      )
    ORDER BY r.created_at, r.origin, r.ordinal
  `).all() as Array<{ source_id: string; origin: number; result_json: string }>;
  const attention = attentionRows.filter(row => row.origin === 0 || isNoteAssistanceEligible(store.require(row.source_id)))
    .map(row => JSON.parse(row.result_json) as InboxResult);
  const attentionCount = attention.length;
  if (attentionOnly) return { results: attention.slice(0, 31), attentionCount };
  const rows = store.database.query(`
    SELECT result_json FROM (
      SELECT result_json, created_at, 0 AS origin, rowid AS ordinal FROM inbox_agent_results
      UNION ALL
      SELECT result_json, created_at, 1 AS origin, rowid AS ordinal FROM note_assistance_results
    ) ORDER BY created_at DESC, origin DESC, ordinal DESC LIMIT 31 OFFSET ?
  `).all(offset) as Array<{ result_json: string }>;
  return { results: rows.map(row => JSON.parse(row.result_json) as InboxResult), attentionCount };
}

/** Pages are consumed in the same read transaction: one complete observation, not mixed snapshots. */
export function completePropertyInventory(store: OutlinerStore, key: string): PropertyInventory {
  return store.database.transaction(() => {
    const result = store.propertyInventory({ key });
    while (result.nextOffset !== null) {
      const page = store.propertyInventory({ key, offset: result.nextOffset });
      result.items.push(...page.items);
      result.nextOffset = page.nextOffset;
    }
    result.complete = true;
    return result;
  })();
}

/** One workspace-owned loop, with Inbox editing and note assistance as explicit operations. */
export class InboxWorker {
  readonly repository: InboxRepository;
  readonly notes: NoteAssistanceRepository | undefined;
  private readonly noteModel: NoteModel | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private active: AbortController | undefined;
  private current: Block | undefined;
  private stopped = false;
  private unavailable: string | undefined;
  private message = "Automatic cleanup is ready";
  private readonly settleMs: number;
  private readonly attempts:InboxAttempts;

  constructor(
    private readonly store: OutlinerStore,
    private readonly model: InboxModel,
    private readonly changed: (result?: InboxResult) => void,
    options: { settleMs?: number; repository?: InboxRepository; notes?: NoteAssistanceRepository; noteModel?: NoteModel } = {},
  ) {
    this.repository = options.repository ?? new InboxRepository(store);
    this.noteModel = options.noteModel;
    this.notes = options.notes ?? (this.noteModel ? new NoteAssistanceRepository(store) : undefined);
    this.notes?.initialize();
    this.attempts=new InboxAttempts(store,!!this.notes);
    this.settleMs = options.settleMs ?? 750;
  }

  status(attentionOnly = false, resultsOffset = 0): InboxStatus {
    const paused = this.repository.settings().paused;
    const { results, attentionCount } = assistantActivity(this.store, this.repository, this.notes, attentionOnly, resultsOffset);
    return {
      enabled: true, paused,
      state: this.unavailable ? "unavailable" : paused ? "paused" : this.current ? "working" : "idle",
      message: this.unavailable ?? (paused ? "Automatic cleanup paused" : this.message),
      pending: this.pendingCount(),
      ...(this.current ? { current: { id: this.current.id, title: blockDisplayTitle(this.current) } } : {}),
      results: results.slice(0, 30).map(summarizeInboxResult), resultsTruncated: results.length > 30,
      attentionCount, attentionOnly, resultsOffset: attentionOnly ? 0 : resultsOffset,
    };
  }

  wake(): void {
    if (this.stopped || this.running || this.timer || this.unavailable || this.repository.settings().paused) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.running = this.drain().catch(() => {
        this.unavailable = "Assistant recovery could not be saved; automatic cleanup stopped";
        this.changed();
      }).finally(() => { this.running = undefined; this.wakeIfPending(); });
    }, this.settleMs);
    this.timer.unref?.();
  }

  pause(): InboxStatus {
    this.repository.setPaused(true);
    clearTimeout(this.timer);
    this.timer = undefined;
    this.active?.abort();
    this.changed();
    return this.status();
  }

  resume(): InboxStatus {
    if (this.stopped) throw new Error("Inbox processor is stopping");
    const latest = assistantActivity(this.store, this.repository, this.notes).results[0];
    if (latest?.state === "failed") {
      this.repository.reconsider(latest.sourceId, this.repository.instructions(latest.sourceId));
      this.notes?.reconsider(latest.sourceId);
      this.attempts.request(latest.sourceId,"resume");
    }
    this.unavailable = undefined;
    this.repository.setPaused(false);
    this.message = "Automatic cleanup resumed";
    this.changed();
    this.wake();
    return this.status();
  }

  reconsider(sourceId: string, instructions?: string): InboxStatus {
    if (typeof sourceId !== "string" || !sourceId) throw new Error("Source ID is required");
    if (instructions !== undefined && (typeof instructions !== "string" || instructions.length > 2000)) {
      throw new Error("Steering instructions must be at most 2000 characters");
    }
    const editorial = this.repository.reconsider(sourceId, instructions?.trim());
    const note = this.noteModel && this.notes?.reconsider(sourceId, instructions?.trim());
    if (!editorial && !note) throw new Error("This block is not an eligible note");
    this.attempts.request(sourceId,"reconsider");
    if (this.current?.id === sourceId) this.active?.abort();
    this.unavailable = undefined;
    this.message = "Note ready for reconsideration";
    this.changed();
    this.wake();
    return this.status();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.active?.abort();
    await this.running;
  }

  private pendingCount(): number {
    const inbox = this.repository.pending();
    return inbox.length + (this.noteModel ? this.notes!.pending(this.repository.sourceIds()).length : 0);
  }

  private wakeIfPending(): void {
    if (!this.stopped && !this.unavailable && !this.repository.settings().paused && this.pendingCount()) this.wake();
  }

  private async drain(): Promise<void> {
    while (!this.stopped && !this.repository.settings().paused && !this.unavailable) {
      const inbox = this.repository.pending();
      const candidate = !inbox.length && this.noteModel ? this.notes!.pending(this.repository.sourceIds())[0] : undefined;
      const source = inbox[0] ?? candidate?.source;
      if (!source) { this.message = this.noteModel ? "Inbox and notes are caught up" : "Inbox is caught up"; this.changed(); return; }
      const attempt=this.attempts.start(source);
      this.current = source;
      this.message = candidate ? "Organizing note and checking for a request" : "Reading and finding related notes";
      this.changed();
      const abort = new AbortController();
      this.active = abort;
      const observed = new Map<string, Block>([[source.id, source]]);
      const read = (id: string): Block | null => {
        abort.signal.throwIfAborted();
        const block = this.store.get(id);
        if (!block || block.effectiveDeletedRootId || block.deletedAt) return null;
        // Keep the first observation. Reading again cannot erase a conflict.
        if (!observed.has(id)) observed.set(id, block);
        return block;
      };
      const search = (query: string): Block[] => {
        abort.signal.throwIfAborted();
        return this.store.searchTree(query).matches.slice(0, 20)
          .filter(match => match.block.id !== source.id)
          .map(match => read(match.block.id)).filter((block): block is Block => block !== null);
      };
      const progress = (message: string): void => {
        if (abort.signal.aborted || this.stopped) return;
        this.message = message.slice(0, 200); this.changed();
      };
      const operationId = crypto.randomUUID();
      let abortListener: (() => void) | undefined;
      let applying = false;
      let returnedUsage: InboxUsage | undefined;
      let reportedUsage: InboxUsage | undefined;
      let inventorySequence: number | undefined;
      try {
        const cancelled = new Promise<never>((_, reject) => {
          abortListener = () => reject(new Error("Assistant work interrupted"));
          abort.signal.addEventListener("abort", abortListener, { once: true });
        });
        const noteCandidate = candidate ?? (this.noteModel ? this.notes!.candidateFor(source.id) : undefined);
        const inspectNote = () => this.noteModel!({
          candidate: noteCandidate!, read, search, progress, signal: abort.signal,
          reportUsage: usage => { reportedUsage = usage; },
          tags: this.store.propertyCatalog("tag", "", 100).map(item => item.value),
          propertyKeys: this.store.propertyCatalog(undefined, "", 100).map(item => item.key),
          inventory: key => {
            abort.signal.throwIfAborted();
            const result = completePropertyInventory(this.store, key);
            if (inventorySequence !== undefined && inventorySequence !== result.sequence) {
              throw new Error("The workspace changed between property reads; assistance was not applied");
            }
            inventorySequence = result.sequence;
            return result;
          },
        });
        const operation = candidate ? inspectNote().then(answer => ({ usage: answer.usage, apply: () =>
          this.notes!.apply(operationId, candidate, answer.plan, answer.usage),
        })) : (async () => {
          // Classify the original user intent before editorial rewriting. The final
          // answer/metadata and filing share one receipt; there is no second pass.
          const assistance = noteCandidate ? await inspectNote() : undefined;
          returnedUsage = assistance?.usage;
          let plan: InboxPlan;
          let usage: InboxUsage;
          const empty = { notes: [], tasks: [], updates: [] };
          if (assistance?.plan.fulfillment) {
            plan = { ...empty, summary: assistance.plan.fulfillment.summary,
              source: { disposition: "file", text: assistance.plan.fulfillment.text } };
            usage = assistance.usage;
          } else {
            // An unsupported action can still be useful backlog input. Let the
            // editor record or file it without claiming the request was executed.
            const editorial = await this.model({ source, read, search, progress, signal: abort.signal,
              reportUsage: usage => { reportedUsage = usage; },
              instructions: this.repository.instructions(source.id),
              validatePlan: plan=>this.repository.validate(plan,source),
            });
            plan = editorial.plan;
            usage = assistance ? combinedInboxUsage(assistance.usage, editorial.usage) : editorial.usage;
          }
          return { usage, apply: () => this.store.database.transaction(() => {
            for (const update of plan.updates) {
              const before = observed.get(update.blockId);
              if (!before || before.revision !== update.expectedRevision) throw new InboxConflictError("A target changed or was not read; cleanup was not applied");
            }
            const result = this.repository.apply(operationId, source, plan, usage,
              assistance && noteCandidate ? { candidate: noteCandidate, plan: assistance.plan } : undefined);
            this.notes?.checkpointEditorial(result, noteCandidate, assistance?.plan);
            return result;
          })() };
        })();
        const answer = await Promise.race([cancelled, operation]);
        if (abort.signal.aborted || this.stopped || this.repository.settings().paused) return;
        returnedUsage = answer.usage;
        applying = true;
        if (inventorySequence !== undefined && this.store.sequence !== inventorySequence) {
          throw new InboxConflictError("The property inventory changed while answering; assistance was not applied");
        }
        for (const before of observed.values()) {
          const current = this.store.get(before.id);
          if (!current || current.effectiveDeletedRootId || current.revision !== before.revision || current.parentId !== before.parentId) {
            throw new InboxConflictError("A note used by this answer changed; assistance was not applied");
          }
        }
        this.changed(this.store.database.transaction(()=>this.attempts.finish(answer.apply(),attempt,!!candidate))());
      } catch (error) {
        const canceled = abort.signal.aborted || this.stopped;
        const detail = canceled ? "Assistant work canceled; the source is unchanged" : error instanceof Error ? error.message : "Assistant work failed";
        const errorUsage = error instanceof Error && "usage" in error ? error.usage as InboxUsage : reportedUsage;
        // Once applying, returnedUsage already includes every inference stage.
        // reportUsage is a snapshot of that attempt, not another model call.
        const failureUsage = applying ? returnedUsage
          : returnedUsage && errorUsage ? combinedInboxUsage(returnedUsage, errorUsage) : errorUsage ?? returnedUsage;
        const failureKind=inboxFailureKind(error,canceled);
        this.changed(this.store.database.transaction(()=>this.attempts.finish(candidate
          ? this.notes!.fail(operationId, candidate, detail.slice(0, 500), failureUsage, canceled ? "canceled" : "failed")
          : this.repository.fail(operationId, source, detail.slice(0, 500), failureUsage, canceled ? "canceled" : "failed"),attempt,!!candidate,failureKind))());
        if (!canceled && !applying && failureKind!=="validation" && !(error instanceof Error && error.name === "InboxNoteError")) {
          this.unavailable = detail.slice(0, 500);
          this.repository.setPaused(true);
        }
      } finally {
        if (abortListener) abort.signal.removeEventListener("abort", abortListener);
        this.current = undefined;
        this.active = undefined;
        this.changed();
      }
    }
  }
}
