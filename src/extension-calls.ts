import {
  ComponentError,
  renderComponent,
  renderMarkdownOutput,
  validateComponent,
  type ComponentOutput,
  type RenderTarget,
  type RenderedComponent,
} from "./component-primitives";
import { handlerCalls, mayHaveHandlerLines, type HandlerCall } from "./extension-handlers";
import { DEFAULT_DEADLINE_MS, durationMs, type LoadedExtension } from "./extension-manifest";
import { extensionActorId, inertBlockdown, recordBlockText, type ExtensionRecordData } from "./extension-records";
import type { ExtensionActionEntry, ExtensionRegistry } from "./extension-registry";
import { parsePropertyRecords } from "./properties";
import type { ResourceProjection } from "./resource-projection";
import type { ResourceExtensionRuntime } from "./resource-extensions";
import type { ExtensionOutputRow, OutlinerStore } from "./store";
import type { Block, MutationProvenance } from "./types";

/**
 * Runs extension handlers for the lines that ask for them, keeps their
 * results, and answers what readers show (wave B of the extension design,
 * PIE-507). The service runs extension code; clients only draw.
 *
 * - **Data** (`kind: "data"`, kind 1): the key's record is written as a real
 *   block the extension owns, with namespaced properties (`[moon.phase::Full]`),
 *   under the key's home, like Jira's (`src/extension-records.ts`, the store's
 *   `extension_records`). Refreshed when stale (`staleAfter`) or on `r`.
 * - **Output** (`kind: "output"`, kind 2): markdown kept per line
 *   (`extension_outputs`) and shown under it. `keep` writes it as blocks.
 * - **Component** (`kind: "component"`, kind 3): data plus a view composed from
 *   the shared primitives, rendered to the target a reader asks for.
 * - **Actions** (`act`): what an extension can do, returned as writes the
 *   service checks and commits as `author: agent`, `actorId: ext:<id>`.
 *
 * When a handler runs on its own (`effects`):
 * - `read`: on save and on open, when it has no result, its result is older
 *   than `staleAfter`, or the extension's version changed.
 * - `spend` (costs money or model time): once, when a person writes the line;
 *   then only on `r`. A line an agent wrote waits for `r`.
 * - `write`: only on `r`.
 */

export interface ExtensionCallsOptions {
  readonly now?: () => number;
  /** A block's handler results changed without a content change (an output ran): readers repaint it. */
  readonly changed?: (blockId: string) => void;
}

export type CallReason = "save" | "open" | "refresh";

interface PassOptions {
  /** The save was a person's own. */
  readonly byPerson?: boolean;
  /** The save created the block. */
  readonly created?: boolean;
  /** Only the line on this index (a refresh of one line). */
  readonly line?: number;
}

/** What an action may return: writes inside the block it acts on, checked and attributed by the service. */
export type ExtensionWrite =
  | { readonly op: "create"; readonly parentId: string; readonly text: string }
  | { readonly op: "update"; readonly blockId: string; readonly expectedRevision: number; readonly text: string };

export interface ExtensionActRequest {
  readonly extension: string;
  readonly action: string;
  /** The block it acts on (and, for a handler's action, its line). Optional for an action on a tile. */
  readonly blockId?: string;
  readonly line?: number;
  /** Arguments a tile or agent passes along (the tile's own args). */
  readonly args?: Readonly<Record<string, string>>;
}

export interface ExtensionActResult {
  readonly extension: string;
  readonly action: string;
  readonly message?: string;
  /** Blocks the action created or changed. */
  readonly written: readonly string[];
}

export interface ExtensionRenderResult {
  readonly blockId: string;
  readonly line: number;
  readonly handler: string;
  readonly rendered: RenderedComponent;
}

interface CallState {
  readonly running: boolean;
  readonly error?: string;
}

const MAX_CONTEXT_TEXT = 16_000;
const MAX_CHILD_TEXT = 2_000;
const MAX_CHILDREN = 50;
const MAX_MARKDOWN = 64 * 1024;
const MAX_WRITES = 20;
const MAX_WRITE_TEXT = 64 * 1024;
const RETRY_FAILED_MS = 60_000;
const MAX_SPEND_MEMORY = 5_000;

function message(error: unknown): string {
  return error instanceof Error ? error.message.replace(/^Resource extension: /, "") : String(error);
}

function title(text: string): string {
  return text.split("\n", 1)[0]!.trim();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** An output handler's result: `{ markdown, title? }`. */
function validateOutput(value: unknown): { markdown: string; title?: string } {
  if (!isObject(value) || typeof value.markdown !== "string") throw new Error("an output handler returns { markdown }");
  if (Buffer.byteLength(value.markdown) > MAX_MARKDOWN) throw new Error("markdown is larger than 64 KiB");
  if (value.title !== undefined && (typeof value.title !== "string" || value.title.length > 300)) throw new Error("title must be text up to 300 characters");
  return { markdown: value.markdown, ...(typeof value.title === "string" ? { title: value.title } : {}) };
}

/** A data handler's `read`: `{ record: { title, fields, body } }`. */
function validateRecord(value: unknown): ExtensionRecordData {
  const record = isObject(value) ? value.record : undefined;
  if (!isObject(record) || typeof record.title !== "string" || !record.title.trim()) throw new Error("a data handler's read returns { record: { title, fields, body } }");
  if (!Array.isArray(record.fields) || record.fields.length > 64) throw new Error("record.fields must be a list of at most 64 { key, value }");
  const fields = record.fields.map((field, index) => {
    if (!isObject(field) || typeof field.key !== "string" || !/^[a-z][a-z0-9_-]{0,39}$/.test(field.key)) {
      throw new Error(`record.fields[${index}].key must be a lowercase name`);
    }
    const value = field.value;
    const ok = value === null || typeof value === "string" || (Array.isArray(value) && value.length <= 200 && value.every((item) => typeof item === "string"));
    if (!ok) throw new Error(`record.fields[${index}].value must be text, a list of text, or null`);
    return { key: field.key, value: value as string | string[] | null };
  });
  if (record.body !== undefined && typeof record.body !== "string") throw new Error("record.body must be markdown text");
  const body = (record.body as string | undefined) ?? "";
  if (Buffer.byteLength(body) > MAX_MARKDOWN) throw new Error("record.body is larger than 64 KiB");
  return { title: record.title, fields, body };
}

function validateAct(value: unknown): { message?: string; writes: ExtensionWrite[] } {
  if (!isObject(value)) throw new Error("an action returns { message?, writes? }");
  if (value.message !== undefined && (typeof value.message !== "string" || value.message.length > 500)) throw new Error("message must be text up to 500 characters");
  const writes = value.writes ?? [];
  if (!Array.isArray(writes) || writes.length > MAX_WRITES) throw new Error(`writes must be a list of at most ${MAX_WRITES}`);
  return {
    ...(typeof value.message === "string" ? { message: value.message } : {}),
    writes: writes.map((write, index) => {
      if (!isObject(write)) throw new Error(`writes[${index}] must be an object`);
      if (typeof write.text !== "string" || Buffer.byteLength(write.text) > MAX_WRITE_TEXT) throw new Error(`writes[${index}].text must be text up to 64 KiB`);
      if (write.op === "create" && typeof write.parentId === "string") return { op: "create", parentId: write.parentId, text: write.text };
      if (write.op === "update" && typeof write.blockId === "string" && Number.isSafeInteger(write.expectedRevision)) {
        return { op: "update", blockId: write.blockId, expectedRevision: write.expectedRevision as number, text: write.text };
      }
      throw new Error(`writes[${index}] must be { op: "create", parentId, text } or { op: "update", blockId, expectedRevision, text }`);
    }),
  };
}

export class ExtensionCalls {
  private readonly state = new Map<string, CallState>();
  private readonly passes = new Map<string, Promise<void>>();
  private readonly queued = new Map<string, { next: { reason: CallReason; options: PassOptions }; promise: Promise<void> }>();
  private readonly scheduled = new Set<string>();
  private readonly saves = new Map<string, { byPerson: boolean; created: boolean }>();
  /** Spend lines each block had at its last pass (most recent blocks only). */
  private readonly spendSeen = new Map<string, Set<string>>();
  private stopped = false;

  constructor(
    private readonly store: OutlinerStore,
    private readonly registry: ExtensionRegistry,
    private readonly runtime: ResourceExtensionRuntime,
    private readonly options: ExtensionCallsOptions = {},
  ) {}

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  stop(): void {
    this.stopped = true;
  }

  /**
   * A block was saved (not by an extension): run what its lines ask for, in
   * the background. `created`: the save made the block, so every line in it is new.
   */
  blockChanged(blockId: string, actor: MutationProvenance | undefined, created = false): void {
    if (this.stopped) return;
    const block = this.store.get(blockId);
    if (!block || (!mayHaveHandlerLines(block.text) && !this.store.asksExtension(blockId) && !this.store.extensionOutputs(blockId).length)) return;
    // Only a person's own save may spend: not an agent's, not a system or unattributed one (an import).
    const byPerson = actor?.author === "user";
    const pending = this.saves.get(blockId);
    // Saves in one tick run as one pass: it spends only if every one of them was a person's.
    this.saves.set(blockId, { byPerson: pending ? pending.byPerson && byPerson : byPerson, created: (pending?.created ?? false) || created });
    if (this.scheduled.has(blockId)) return;
    this.scheduled.add(blockId);
    setTimeout(() => {
      this.scheduled.delete(blockId);
      const save = this.saves.get(blockId);
      this.saves.delete(blockId);
      void this.materialize(blockId, "save", { byPerson: save?.byPerson ?? false, created: save?.created ?? false }).catch(() => {});
    }, 0);
  }

  /** The handler lines a block has now (none for a block an extension owns). */
  calls(blockId: string): { block: Block; calls: HandlerCall[] } | null {
    const block = this.store.get(blockId);
    if (!block || block.effectiveDeletedRootId || this.store.extensionOwner(blockId)) return null;
    return { block, calls: handlerCalls(block.text, this.registry) };
  }

  /**
   * Runs what a block's lines ask for and keeps the results. `open` and
   * `save` follow each handler's `effects`; `refresh` runs every line (or the
   * one on `line`) now. A pass asked for while one runs on that block runs
   * after it (a save during a slow call is never lost); a refresh runs at once.
   */
  materialize(blockId: string, reason: CallReason, options: PassOptions = {}): Promise<void> {
    const running = this.passes.get(blockId);
    if (running && reason !== "refresh") {
      const queued = this.queued.get(blockId);
      // One pass waits behind the running one; a save's options win over an open's.
      if (queued) {
        if (reason === "save") queued.next = { reason, options: { byPerson: (queued.next.options.byPerson ?? false) || (options.byPerson ?? false),
          created: (queued.next.options.created ?? false) || (options.created ?? false) } };
        return queued.promise;
      }
      const entry: { next: { reason: CallReason; options: PassOptions }; promise: Promise<void> } = { next: { reason, options }, promise: Promise.resolve() };
      entry.promise = running.catch(() => {}).then(() => {
        this.queued.delete(blockId);
        return this.materialize(blockId, entry.next.reason, entry.next.options);
      });
      this.queued.set(blockId, entry);
      return entry.promise;
    }
    const pass = this.materializeNow(blockId, reason, options)
      .finally(() => { if (this.passes.get(blockId) === pass) this.passes.delete(blockId); });
    this.passes.set(blockId, pass);
    return pass;
  }

  /**
   * The spend lines a block had at its last pass, so a save can tell which of its spend lines are new
   * (a person just wrote them) from ones that were already there (edited, or written by an agent).
   */
  private spendLinesSeen(blockId: string, calls: readonly HandlerCall[], reason: CallReason, created: boolean): Set<string> {
    const current = calls.filter((call) => call.effects === "spend").map((call) => call.callKey);
    const before = this.spendSeen.get(blockId);
    this.spendSeen.delete(blockId);
    this.spendSeen.set(blockId, new Set(current));
    if (this.spendSeen.size > MAX_SPEND_MEMORY) this.spendSeen.delete(this.spendSeen.keys().next().value!);
    if (reason !== "save") return new Set(current);
    // A block this service hasn't seen since it started: only a new block's lines are new.
    return before ?? (created ? new Set() : new Set(current));
  }

  private async materializeNow(blockId: string, reason: CallReason, options: PassOptions): Promise<void> {
    const found = this.calls(blockId);
    if (!found) return;
    const { block, calls } = found;
    const seen = this.spendLinesSeen(blockId, calls, reason, options.created ?? false);
    // A spend line edited into another one (still being typed, or changed) replaces a result: it waits for r.
    const current = new Set(calls.map((call) => call.callKey));
    const replaced = new Set(this.store.extensionOutputs(blockId).filter((row) => !current.has(row.callKey)).map((row) => row.handlerKey));
    // Outputs of lines the block no longer has go; the records it no longer asks for settle.
    this.store.pruneExtensionOutputs(blockId, calls.filter((call) => call.kind !== "data").map((call) => call.callKey));
    this.settleAsks(blockId, calls);
    const rows = new Map(this.store.extensionOutputs(blockId).map((row) => [row.callKey, row]));
    const chosen = calls.filter((call) => options.line === undefined || call.line === options.line);
    await Promise.all(chosen.map(async (call) => {
      if (call.problems.length) return;
      const extension = this.registry.extension(call.extensionId);
      if (!extension) return;
      // A spend line runs by itself only when a person has just written it.
      const fresh = call.effects !== "spend" ||
        (reason === "save" && (options.byPerson ?? false) && !seen.has(call.callKey) && !replaced.has(call.handlerKey));
      if (call.kind === "data") {
        if (this.dataDue(call, extension, reason, fresh)) await this.fetchRecord(block, call, extension);
        return;
      }
      if (this.outputDue(call, extension, rows.get(call.callKey), reason, fresh)) await this.run(block, call, extension);
    }));
  }

  /**
   * Records the keys a block asks each extension for; a key nobody asks for
   * any more moves or goes to Trash (`store.settleExtensionRecord`, as Jira's
   * sync does). A line whose key is being typed (it doesn't parse yet) holds
   * that extension's asks as they were, so a record doesn't flicker to Trash.
   */
  private settleAsks(blockId: string, calls: readonly HandlerCall[]): void {
    const wanted = new Map<string, Map<string, number>>();
    const typing = new Set<string>();
    for (const call of calls) {
      if (call.kind !== "data") continue;
      if (!call.argumentOk || call.argument === null) {
        typing.add(call.extensionId);
        continue;
      }
      const keys = wanted.get(call.extensionId) ?? new Map<string, number>();
      keys.set(call.argument, 0);
      wanted.set(call.extensionId, keys);
    }
    const before = new Set(this.store.extensionAsksOf(blockId).map((ask) => ask.extensionId));
    for (const extensionId of new Set([...before, ...wanted.keys()])) {
      // Jira's asks are its own sync's (src/extension-sync.ts). An extension that is gone (its folder
      // removed or broken beyond its last good copy) leaves its records and asks as they are: data stays.
      if (extensionId === "jira" || !this.registry.extension(extensionId) || typing.has(extensionId)) continue;
      const released = this.store.setExtensionAsks(blockId, extensionId, wanted.get(extensionId) ?? new Map());
      for (const key of [...released, ...(wanted.get(extensionId)?.keys() ?? [])]) {
        try {
          this.store.settleExtensionRecord(extensionId, key);
        } catch (error) {
          this.state.set(this.dataKey(extensionId, key), { running: false, error: message(error) });
        }
      }
    }
  }

  private dataKey(extensionId: string, key: string): string {
    return `data\0${extensionId}\0${key}`;
  }

  private outputKey(blockId: string, callKey: string): string {
    return `${blockId}\0${callKey}`;
  }

  /** Whether `effects` lets a line run now; `fresh`: a spend line a person has just written. */
  private automatic(call: HandlerCall, reason: CallReason, fresh: boolean, firstRun: boolean): boolean {
    if (reason === "refresh") return true;
    if (call.effects === "write") return false;
    if (call.effects === "spend") return firstRun && fresh;
    return true;
  }

  private dataDue(call: HandlerCall, extension: LoadedExtension, reason: CallReason, fresh: boolean): boolean {
    const record = this.store.extensionRecords({ extensionId: extension.id, role: "record", itemKey: call.argument! })[0];
    if (!this.automatic(call, reason, fresh, !record)) return false;
    if (reason === "refresh") return true;
    const key = this.dataKey(extension.id, call.argument!);
    if (!record) return !this.state.get(key)?.error || this.retryable(key);
    const handler = extension.manifest.handlers?.find((candidate) => candidate.key === call.handlerKey);
    const stale = durationMs(handler?.staleAfter);
    return stale !== undefined && this.now - Date.parse(record.syncedAt) > stale;
  }

  private readonly failedAt = new Map<string, number>();
  private retryable(key: string): boolean {
    return this.now - (this.failedAt.get(key) ?? 0) > RETRY_FAILED_MS;
  }

  private outputDue(call: HandlerCall, extension: LoadedExtension, row: ExtensionOutputRow | undefined, reason: CallReason, fresh: boolean): boolean {
    if (!this.automatic(call, reason, fresh, !row)) return false;
    if (reason === "refresh" || !row) return true;
    if (row.result === null) return row.error !== null && this.now - Date.parse(row.attemptedAt) > RETRY_FAILED_MS && call.effects === "read";
    if (call.effects !== "read") return false;
    if (row.extensionVersion !== extension.version) return true;
    const handler = extension.manifest.handlers?.find((candidate) => candidate.key === call.handlerKey);
    const stale = durationMs(handler?.staleAfter);
    return stale !== undefined && row.ranAt !== null && this.now - Date.parse(row.ranAt) > stale;
  }

  private deadline(extension: LoadedExtension, handlerKey?: string): number {
    const handler = handlerKey ? extension.manifest.handlers?.find((candidate) => candidate.key === handlerKey) : undefined;
    return durationMs(handler?.deadline) ?? durationMs(extension.manifest.deadline) ?? DEFAULT_DEADLINE_MS;
  }

  /** What a call sees of the outline: bounded, read-only, from one read. */
  private context(block: Block, line: number | undefined): Record<string, unknown> {
    const context = this.store.blockContext(block.id);
    const lines = block.text.split("\n");
    return {
      block: { id: block.id, text: block.text.slice(0, MAX_CONTEXT_TEXT), revision: block.revision,
        properties: parsePropertyRecords(block.text).filter((record) => record.scope === "block").map((record) => ({ key: record.key, value: record.value })) },
      ...(line !== undefined ? { line: { index: line, text: lines[line] ?? "" } } : {}),
      children: context.children.slice(0, MAX_CHILDREN).map((child) => ({ id: child.id, text: child.text.slice(0, MAX_CHILD_TEXT) })),
      ancestors: context.ancestors.slice(-8).map((ancestor) => ({ id: ancestor.id, title: title(ancestor.text) })),
      now: new Date(this.now).toISOString(),
    };
  }

  private async run(block: Block, call: HandlerCall, extension: LoadedExtension): Promise<void> {
    const key = this.outputKey(block.id, call.callKey);
    if (this.state.get(key)?.running) return;
    this.state.set(key, { running: true });
    this.options.changed?.(block.id);
    const request = { argument: call.argument, options: call.options };
    const attemptedAt = new Date(this.now).toISOString();
    const base = { blockId: block.id, callKey: call.callKey, extensionId: extension.id, handlerKey: call.handlerKey,
      kind: call.kind as "output" | "component", request, attemptedAt, blockRevision: block.revision, extensionVersion: extension.version };
    try {
      const answer = await this.runtime.invokeLoaded(extension, "run",
        { handler: call.handlerKey, ...request, context: this.context(block, call.line) }, this.deadline(extension, call.handlerKey));
      let result: unknown;
      try {
        result = call.kind === "component"
          ? { ...validateComponent(answer.value), ...(isObject(answer.value) && typeof answer.value.title === "string" ? { title: answer.value.title.slice(0, 300) } : {}) }
          : validateOutput(answer.value);
      } catch (error) {
        throw new Error(`${extension.name} returned something the service can't show: ${error instanceof ComponentError || error instanceof Error ? error.message : String(error)}`);
      }
      if (this.store.get(block.id)) this.store.putExtensionOutput({ ...base, result });
      this.state.delete(key);
    } catch (error) {
      if (this.store.get(block.id)) this.store.putExtensionOutput({ ...base, error: message(error) });
      this.state.set(key, { running: false, error: message(error) });
    }
    this.options.changed?.(block.id);
  }

  private async fetchRecord(block: Block, call: HandlerCall, extension: LoadedExtension): Promise<void> {
    const itemKey = call.argument!;
    const key = this.dataKey(extension.id, itemKey);
    if (this.state.get(key)?.running) return;
    this.state.set(key, { running: true });
    this.options.changed?.(block.id);
    try {
      const answer = await this.runtime.invokeLoaded(extension, "read",
        { handler: call.handlerKey, key: itemKey, options: call.options, context: this.context(block, call.line) },
        this.deadline(extension, call.handlerKey));
      let record: ExtensionRecordData;
      try {
        record = validateRecord(answer.value);
      } catch (error) {
        throw new Error(`${extension.name} returned a record the service can't keep: ${message(error)}`);
      }
      const home = this.store.extensionRecordHome(extension.id, itemKey);
      if (home) {
        const actor: MutationProvenance = { author: "agent", actorId: extensionActorId(extension.id) };
        this.store.changes.run(this.store.changes.attribution({ action: `ext.${extension.id}.sync`, actor }), () =>
          this.store.writeExtensionRecord({
            extensionId: extension.id, label: extension.name, parentBlockId: home, itemKey, resourceId: null,
            text: recordBlockText(extension.id, itemKey, record),
          }));
      }
      this.state.delete(key);
      this.failedAt.delete(key);
    } catch (error) {
      this.state.set(key, { running: false, error: message(error) });
      this.failedAt.set(key, this.now);
    }
    this.options.changed?.(block.id);
  }

  /**
   * `r` on a data record: fetch that one key again, from a block that asks
   * for it, without running anything else those blocks have.
   */
  async refreshRecord(extensionId: string, itemKey: string): Promise<boolean> {
    const extension = this.registry.extension(extensionId);
    if (!extension) return false;
    for (const asker of this.store.extensionAskers(extensionId, itemKey)) {
      const found = this.calls(asker.blockId);
      const call = found?.calls.find((candidate) => candidate.kind === "data" && candidate.extensionId === extensionId &&
        candidate.argument === itemKey && candidate.argumentOk);
      if (found && call) {
        await this.fetchRecord(found.block, call, extension);
        return true;
      }
    }
    return false;
  }

  // ── What readers show ────────────────────────────────────────────────

  /**
   * One projection per handler line, in the same slot as a Jira ticket's
   * (`resources.projection.read`): status, when it ran, and the result.
   */
  projections(blockId: string, line?: number): ResourceProjection[] {
    const found = this.calls(blockId);
    if (!found) return [];
    const rows = new Map(this.store.extensionOutputs(blockId).map((row) => [row.callKey, row]));
    return found.calls
      .filter((call) => line === undefined || call.line === line)
      .map((call) => this.projection(found.block, call, rows.get(call.callKey)));
  }

  private projection(block: Block, call: HandlerCall, row: ExtensionOutputRow | undefined): ResourceProjection {
    const extension = this.registry.extension(call.extensionId);
    const handler = extension?.manifest.handlers?.find((candidate) => candidate.key === call.handlerKey);
    const base = {
      anchor: { kind: "directive" as const, line: call.line, start: call.start, end: call.end },
      provider: call.extensionId,
      label: extension?.name ?? call.extensionId,
      propertyKey: call.handlerKey,
      options: { unknown: call.unknown },
      kind: call.kind as "data" | "output" | "component",
      extension: { id: call.extensionId, handler: call.handlerKey, effects: call.effects, display: call.display,
        ...(extension ? { version: extension.version } : {}) },
      ...(call.argument !== null ? { key: call.argument } : {}),
      fields: [] as { label: string; value: string }[],
    };
    if (call.problems.length) return { ...base, status: "unavailable", reason: call.problems.join("; ") };
    if (call.kind === "data") return this.dataProjection(base, call, handler?.fields ?? []);
    const state = this.state.get(this.outputKey(block.id, call.callKey));
    const fetching = state?.running ? { fetching: true } : {};
    if (!row || row.result === null) {
      const error = state?.error ?? row?.error ?? undefined;
      if (error) return { ...base, ...fetching, status: "unavailable", reason: error, fetchError: error };
      const waiting = call.effects === "write"
        ? "runs only when asked: r runs it"
        : call.effects === "spend"
          ? "costs model time or money: it runs once when you write the line; r runs it"
          : "not run yet";
      return { ...base, ...fetching, status: "not-run", reason: state?.running ? `${extension?.name ?? call.extensionId} is running` : waiting };
    }
    const result = row.result as { markdown?: string; title?: string } & Partial<ComponentOutput>;
    const markdown = call.kind === "component"
      ? renderComponent(result as ComponentOutput, "markdown").body
      : result.markdown ?? "";
    const output = {
      markdown: inertBlockdown(markdown),
      ranAt: row.ranAt!,
      ...(result.title ? { title: result.title } : {}),
      ...(call.kind === "component" ? { component: { data: result.data, view: result.view } } : {}),
      ...(row.blockRevision !== block.revision ? { inputsChanged: true as const } : {}),
      ...(extension && row.extensionVersion !== extension.version ? { versionChanged: true as const } : {}),
    };
    const failed = state?.error ?? row.error ?? undefined;
    return {
      ...base,
      ...fetching,
      status: failed ? "stale" : "ready",
      ...(failed ? { reason: `the last run failed: ${failed}; showing the one from ${row.ranAt}`, fetchError: failed } : {}),
      summary: result.title ?? title(markdown) ?? "",
      fetchedAt: row.ranAt!,
      output,
    };
  }

  private dataProjection(base: Omit<ResourceProjection, "status">, call: HandlerCall, fields: readonly string[]): ResourceProjection {
    const key = call.argument!;
    const row = this.store.extensionRecords({ extensionId: call.extensionId, role: "record", itemKey: key })[0];
    const state = this.state.get(this.dataKey(call.extensionId, key));
    const fetching = state?.running ? { fetching: true } : {};
    if (!row) {
      if (state?.error) return { ...base, ...fetching, status: "unavailable", reason: state.error, fetchError: state.error };
      return { ...base, ...fetching, status: "not-fetched", reason: state?.running ? "fetching" : call.effects === "read" ? "not fetched yet" : "r fetches it" };
    }
    const record = this.store.get(row.blockId);
    const properties = record ? parsePropertyRecords(record.text).filter((property) => property.scope === "block") : [];
    const shown = fields.flatMap((field) => {
      const values = properties.filter((property) => property.key === `${call.extensionId}.${field}`).map((property) => property.value);
      return values.length ? [{ label: field, value: values.join(", ") }] : [];
    });
    return {
      ...base,
      ...fetching,
      fields: shown,
      status: state?.error ? "stale" : "ready",
      ...(state?.error ? { reason: state.error, fetchError: state.error } : {}),
      summary: record ? title(record.text) : key,
      fetchedAt: row.syncedAt,
      record: { blockId: row.blockId, pageBlockId: row.parentBlockId, syncedAt: row.syncedAt, commentBlockIds: [] },
    };
  }

  /** A line's result in one render target, down the fallback chain (`extensions.render`). */
  render(blockId: string, line: number | undefined, target: RenderTarget, fallback?: RenderTarget): ExtensionRenderResult[] {
    const found = this.calls(blockId);
    if (!found) throw new Error(`No handler lines in ${blockId}`);
    const rows = new Map(this.store.extensionOutputs(blockId).map((row) => [row.callKey, row]));
    return found.calls
      .filter((call) => (line === undefined || call.line === line) && call.kind !== "data")
      .flatMap((call) => {
        const row = rows.get(call.callKey);
        if (!row || row.result === null) return [];
        const result = row.result as { markdown?: string } & ComponentOutput;
        const rendered = call.kind === "component" ? renderComponent(result, target, fallback) : renderMarkdownOutput(result.markdown ?? "", target);
        return [{ blockId, line: call.line, handler: call.handlerKey, rendered }];
      });
  }

  // ── Actions ──────────────────────────────────────────────────────────

  /**
   * Runs an action: the built-in `keep`, or the extension's own `act`. Its
   * writes must stay inside the block it acts on; they are revision-checked
   * and attributed to the extension (`ext.<id>.<action>` in the change feed).
   */
  async act(request: ExtensionActRequest): Promise<ExtensionActResult> {
    const extension = this.registry.extension(request.extension);
    if (!extension) throw new Error(`No extension ${request.extension} is active here (outliner ext ls lists them)`);
    const action = this.registry.action(extension.id, request.action);
    if (!action) throw new Error(`${extension.name} has no action ${request.action}`);
    const block = request.blockId ? this.store.get(request.blockId) : null;
    if (request.blockId && (!block || block.effectiveDeletedRootId)) throw new Error(`Block not found: ${request.blockId}`);
    if (!block && (action.on ?? "block") !== "block" && !action.on!.startsWith("tile:")) throw new Error(`${action.name} acts on a block's line: pass blockId and line`);
    if (!block && (action.on ?? "block") === "block") throw new Error(`${action.name} acts on a block: pass blockId`);
    const call = block ? this.callFor(block, action, request.line) : undefined;
    if (action.builtIn) return this.keep(extension, action, block!, call!);
    const answer = await this.runtime.invokeLoaded(extension, "act", {
      action: action.id,
      ...(request.args ? { args: request.args } : {}),
      ...(block ? { target: { blockId: block.id, revision: block.revision, ...(call ? { line: call.line, argument: call.argument, options: call.options } : {}) } } : {}),
      ...(block ? { context: this.context(block, call?.line ?? request.line) } : {}),
      ...(call ? { output: this.store.extensionOutputs(block!.id).find((row) => row.callKey === call.callKey)?.result ?? null } : {}),
    }, this.deadline(extension));
    let parsed: { message?: string; writes: ExtensionWrite[] };
    try {
      parsed = validateAct(answer.value);
    } catch (error) {
      throw new Error(`${extension.name} returned an answer the service can't apply: ${message(error)}`);
    }
    if (parsed.writes.length && action.effects !== "write") throw new Error(`${action.name} is declared read-only (effects: read) but returned writes`);
    const written = parsed.writes.length ? this.apply(extension, action, block, parsed.writes) : [];
    // An action's writes change what a read handler's line reads: run that line again (found again by its
    // call, in case the writes moved it) before answering. A spend or write line waits for r.
    const again = written.length && call?.effects === "read" ? this.calls(block!.id)?.calls.find((candidate) => candidate.callKey === call.callKey) : undefined;
    if (again) await this.materialize(block!.id, "refresh", { line: again.line });
    else if (written.length) this.options.changed?.(block!.id);
    return { extension: extension.id, action: action.id, ...(parsed.message ? { message: parsed.message } : {}), written };
  }

  private callFor(block: Block, action: ExtensionActionEntry, line: number | undefined): HandlerCall | undefined {
    if (!action.on?.startsWith("handler:")) return undefined;
    const key = action.on.slice(8);
    const calls = handlerCalls(block.text, this.registry).filter((call) => call.handlerKey === key && (line === undefined || call.line === line));
    if (!calls.length) throw new Error(`${action.name} needs a ${key}:: line${line !== undefined ? ` on line ${line}` : ""} in that block`);
    if (calls.length > 1 && line === undefined) throw new Error(`${action.name}: that block has ${calls.length} ${key}:: lines; pass line`);
    return calls[0];
  }

  /** `keep`: the output written under the block as real blocks, attributed to the extension. */
  private keep(extension: LoadedExtension, action: ExtensionActionEntry, block: Block, call: HandlerCall): ExtensionActResult {
    const row = this.store.extensionOutputs(block.id).find((candidate) => candidate.callKey === call.callKey);
    if (!row || row.result === null) throw new Error(`${call.handlerKey}:: hasn't run yet: r runs it, then keep`);
    const result = row.result as { markdown?: string; title?: string } & ComponentOutput;
    const markdown = call.kind === "component" ? renderComponent(result, "markdown").body : result.markdown ?? "";
    const heading = result.title ?? `${extension.name}${call.argument ? ` · ${call.argument}` : ""}`;
    const text = `${inertBlockdown(heading).split("\n", 1)[0]}\n\n${inertBlockdown(markdown)}`.trim();
    const written = this.apply(extension, action, block, [{ op: "create", parentId: block.id, text }]);
    return { extension: extension.id, action: action.id, message: `kept ${call.handlerKey}:: as a block`, written };
  }

  private apply(extension: LoadedExtension, action: ExtensionActionEntry, block: Block | null, writes: readonly ExtensionWrite[]): string[] {
    if (!block) throw new Error(`${action.name} returned writes but acts on no block; writes stay inside the block an action acts on`);
    const inside = (id: string) => id === block.id || this.store.isDescendant(id, block.id);
    for (const write of writes) {
      const target = write.op === "create" ? write.parentId : write.blockId;
      if (!inside(target)) throw new Error(`${action.name} tried to write outside the block it acts on (${target}); nothing was written`);
    }
    const actor: MutationProvenance = { author: "agent", actorId: extensionActorId(extension.id) };
    const written: string[] = [];
    this.store.changes.run(this.store.changes.attribution({ action: action.name, actor }), () => this.store.atomically(() => {
      for (const write of writes) {
        if (write.op === "create") written.push(this.store.create(write.text, write.parentId, "agent", { actorId: actor.actorId! }).id);
        else written.push(this.store.update(write.blockId, write.text, write.expectedRevision, actor).id);
      }
    }));
    return written;
  }
}
