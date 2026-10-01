import { commentBlockText, extensionActorId, recordBlockText, type ExtensionRecordData } from "./extension-records";
import { readResourceProjections, type ResourceProjection } from "./resource-projection";
import { mayHaveResourceProjections } from "./resource-references";
import type { ExtensionDescription } from "./resource-extensions";
import type { RemoteEntityDocument, Resource } from "./resources";
import type { OutlinerStore } from "./store";

/**
 * Keeps extension records in step with the lines that ask for them (wave A of
 * the extension design, PIE-445 slices 2 and 3).
 *
 * - **One step.** Saving a block with a provider line (`jira::`, `jira:: KEY
 *   --comments`) or a ticket page's own `[jira::KEY]` registers the ticket and
 *   fetches it in the background; the save never waits. Opening a note whose
 *   copy is stale does the same (`resources.projection.read` with
 *   `materialize`).
 * - **One copy.** A key has one record block, under its home
 *   (`OutlinerStore.extensionRecordHome`: the key's page, else its first
 *   `[jira::KEY]` block, else the first block that asks). Every other block
 *   that asks shows that block. The record moves when its home changes and
 *   goes to Trash when nothing asks for it any more. Its comments are the
 *   most any asker wants (`--comments=N`).
 * - **Refresh.** `resources.projection.refresh` refreshes one ticket now. Any
 *   refresh (this one, Detail's `r`, the poll) writes the record blocks, because
 *   the catalog reports every observation (`onRemoteEntityObserved`).
 * - **Poll.** While the service runs, one provider search every few minutes
 *   asks which of the outline's tickets changed since the last poll; only those
 *   are read again. A poll that finds nothing writes nothing.
 * - **Back off.** A provider that refuses the credentials (401, 403, none on
 *   this machine) or rate-limits (429) pauses the automatic fetches (saves,
 *   opens, the poll) for a while; `r` still tries at once.
 *
 * Every write goes through `OutlinerStore.writeExtensionRecord`, attributed to
 * the extension (`author: agent`, `actorId: ext:jira`), and skips a text that
 * didn't change.
 */

export interface ExtensionSyncOptions {
  /** How often the poll runs; 0 turns it off. Default: the handler's `pollEvery`, else 12 minutes. */
  readonly pollMs?: number;
  readonly now?: () => number;
  /** A Resource's stored state changed without a request (a background fetch): repaint it. */
  readonly resourceChanged?: (resourceId: string) => void;
}

/** What a reader shows beside a projection while the service works on it. */
export interface ExtensionSyncState {
  readonly fetching: boolean;
  readonly error?: string;
}

const DEFAULT_POLL_MS = 12 * 60 * 1_000;
const MAX_POLL_KEYS = 1_000;
const EXTENSION_ID = "jira";
/** Refused credentials: wait this long before fetching on our own again. */
const AUTH_PAUSE_MS = 15 * 60 * 1_000;
/** Rate-limited: the first wait, doubling to the most. */
const RATE_PAUSE_MS = 60 * 1_000;
const MAX_RATE_PAUSE_MS = 30 * 60 * 1_000;

/** The provider refused who we are, or has none of our credentials: trying again soon won't help. */
const REFUSED = /\(401\)|\(403\)|credentials/;
const RATE_LIMITED = /\(429\)/;

function minutes(value: string | undefined): number | undefined {
  const match = value ? /^([1-9][0-9]{0,3})m$/.exec(value) : null;
  return match ? Number(match[1]) * 60_000 : undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ExtensionSync {
  private readonly pages = new Map<string, Promise<void>>();
  private readonly follows = new Map<string, Promise<string>>();
  /** Keys waiting for a Resource's first observation, by Resource. */
  private readonly waiting = new Map<string, Set<string>>();
  /** Fetching, or why the last fetch failed, by key. */
  private readonly state = new Map<string, ExtensionSyncState>();
  private readonly scheduled = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastPoll: number | null = null;
  /** How many comments the last write of each key kept (the most any asker wanted then). */
  private readonly commentsWritten = new Map<string, number>();
  /** Resources whose provider returned no record (a contract 1 install): nothing to keep as blocks. */
  private readonly recordless = new Set<string>();
  private pollEveryMs = DEFAULT_POLL_MS;
  private stopped = true;
  private described: Promise<ExtensionDescription | null> | null = null;
  /** Automatic fetches wait until then (the provider refused us or rate-limited us); `r` doesn't. */
  private pausedUntil = 0;
  private pauseReason: string | undefined;
  private ratePauses = 0;
  lastPollResult: { at: string; checked: number; changed: number; error?: string } | null = null;

  constructor(private readonly store: OutlinerStore, private readonly options: ExtensionSyncOptions = {}) {}

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** The installed Jira extension, read once per sync pass (null when none is installed or the client is a fixture). */
  private extension(): Promise<ExtensionDescription | null> {
    const client = this.store.resources.remoteEntityProviderClient as { describeExtension?: (provider: string) => Promise<ExtensionDescription | null> };
    this.described ??= (client.describeExtension?.(EXTENSION_ID) ?? Promise.resolve(null)).catch(() => null)
      .then((described) => {
        if (described) this.label = described.name;
        setTimeout(() => { this.described = null; }, 1_000).unref?.();
        return described;
      });
    return this.described;
  }
  /** How readers name the extension; the manifest's `name` once read. */
  private label = "Jira";

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.store.resources.onRemoteEntityObserved = (resource, document) => this.observed(resource, document);
    void this.schedulePoll();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.store.resources.onRemoteEntityObserved) this.store.resources.onRemoteEntityObserved = undefined;
  }

  private async schedulePoll(): Promise<void> {
    if (this.stopped) return;
    const described = await this.extension();
    const handler = described?.handlers.find((candidate) => candidate.key === EXTENSION_ID);
    const every = this.options.pollMs ??
      (Number(process.env.OUTLINER_EXTENSION_POLL_MS) || minutes(handler?.pollEvery) || DEFAULT_POLL_MS);
    if (every > 0) this.pollEveryMs = every;
    // The manifest's stale age is the one the catalog applies to its copies.
    const stale = minutes(handler?.staleAfter);
    if (stale) this.store.resources.remoteEntityStaleAfterMs = stale;
    if (every <= 0 || this.stopped) return;
    this.timer = setTimeout(() => {
      void this.poll().finally(() => this.schedulePoll());
    }, every);
    this.timer.unref?.();
  }

  /** Whether automatic fetches are paused now, and why. */
  paused(): string | undefined {
    return this.now < this.pausedUntil ? this.pauseReason : undefined;
  }

  /** A fetch failed: a refused credential or a rate limit pauses the automatic fetches. */
  private failed(error: string): void {
    if (RATE_LIMITED.test(error)) {
      const wait = Math.min(MAX_RATE_PAUSE_MS, RATE_PAUSE_MS * 2 ** this.ratePauses);
      this.ratePauses += 1;
      this.pause(wait, error);
    } else if (REFUSED.test(error)) {
      this.pause(AUTH_PAUSE_MS, error);
    }
  }

  private pause(ms: number, reason: string): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.now + ms);
    this.pauseReason = reason;
  }

  /** A fetch worked: whatever paused the automatic fetches is over. */
  private succeeded(): void {
    this.pausedUntil = 0;
    this.pauseReason = undefined;
    this.ratePauses = 0;
  }

  /** A block was saved: its provider lines get their records, in the background. */
  blockChanged(blockId: string): void {
    if (this.stopped || this.scheduled.has(blockId)) return;
    // Cheap guard: only a block with a provider line or property, or one that asked before, has work.
    const block = this.store.get(blockId);
    if (!block || (!mayHaveResourceProjections(block.text) && !this.store.asksExtension(blockId))) return;
    this.scheduled.add(blockId);
    setTimeout(() => {
      this.scheduled.delete(blockId);
      void this.materialize(blockId).catch(() => {});
    }, 0);
  }

  /** What a reader may show for a key: fetching, or why the last attempt failed. */
  stateFor(key: string): ExtensionSyncState | undefined {
    return this.state.get(key);
  }

  private setState(key: string, state: ExtensionSyncState | null): void {
    if (state) this.state.set(key, state);
    else this.state.delete(key);
  }

  /**
   * Registers and fetches what a block asks for, when it isn't fetched or is
   * stale; with `force`, fetches anyway. Concurrent calls for one block share
   * one pass. Returns when the fetches it started have finished.
   */
  materialize(pageBlockId: string, force = false): Promise<void> {
    const running = this.pages.get(pageBlockId);
    if (running && !force) return running;
    const pass = this.materializeNow(pageBlockId, force)
      .finally(() => { if (this.pages.get(pageBlockId) === pass) this.pages.delete(pageBlockId); });
    this.pages.set(pageBlockId, pass);
    return pass;
  }

  /** The keys a block asks for, each with the most comments any of its lines asks to see; null when it asks for nothing it can. */
  private wanted(pageBlockId: string): Map<string, number> | null {
    const block = this.store.get(pageBlockId);
    if (!block || block.effectiveDeletedRootId || this.store.extensionOwner(pageBlockId)) return null;
    let projections: readonly ResourceProjection[];
    try {
      projections = readResourceProjections(this.store, { blockId: pageBlockId }).projections;
    } catch {
      return null;
    }
    const keys = new Map<string, number>();
    for (const projection of projections) {
      if (projection.provider !== EXTENSION_ID || !projection.key) continue;
      if (projection.status === "ambiguous" || projection.status === "no-key") continue;
      keys.set(projection.key, Math.max(keys.get(projection.key) ?? 0, projection.options.comments ?? 0));
    }
    return keys;
  }

  /** The most comments any block that asks for a key wants to see. */
  private commentsFor(key: string): number {
    return Math.max(0, ...this.store.extensionAskers(EXTENSION_ID, key).map((asker) => asker.comments));
  }

  /**
   * Puts a key's record where it belongs without a fetch: under its home,
   * with no more comments than anyone asks for; in Trash when nothing asks.
   */
  private settle(key: string): void {
    if (this.store.settleExtensionRecord(EXTENSION_ID, key) === "dropped") {
      this.commentsWritten.delete(key);
      this.setState(key, null);
      return;
    }
    const record = this.store.extensionRecords({ extensionId: EXTENSION_ID, role: "record", itemKey: key })[0];
    const comments = this.commentsFor(key);
    if (record && comments < (this.commentsWritten.get(key) ?? Infinity)) {
      this.store.trimExtensionComments(EXTENSION_ID, record.blockId, comments);
      this.commentsWritten.set(key, comments);
    }
  }

  private async materializeNow(pageBlockId: string, force: boolean): Promise<void> {
    // Keys count in context only when a Source claims them: make the configured ones first.
    if (this.store.get(pageBlockId) && !this.store.extensionOwner(pageBlockId)) await this.ensureSources();
    // A block in Trash keeps what it asked for: restored, it asks again (and its record comes back with it).
    const wanted = this.wanted(pageBlockId);
    if (!wanted) return;
    const released = this.store.setExtensionAsks(pageBlockId, EXTENSION_ID, wanted);
    for (const key of released) this.safely(key, () => this.settle(key));
    const paused = force ? undefined : this.paused();
    await Promise.all([...wanted.keys()].map(async (key) => {
      this.safely(key, () => this.settle(key));
      const record = this.store.extensionRecords({ extensionId: EXTENSION_ID, role: "record", itemKey: key })[0];
      try {
        const resourceId = await this.resourceFor(key, paused);
        const description = this.store.resources.describe(resourceId, false);
        const freshness = description.remoteStatus?.freshness;
        // More comments asked for than the last write kept (a new --comments) need the ticket read again, once.
        const needsComments = this.commentsFor(key) > (this.commentsWritten.get(key) ?? 0);
        // A fresh copy is enough; a failed or stale one is tried again (a laptop that was offline recovers
        // on the next open). A provider that returns no record (a contract 1 install) is not asked again
        // while its copy is fresh: there would be nothing more to write.
        const settled = freshness === "fresh" || freshness === "refreshing";
        if (!force && settled && (record ? !needsComments : this.recordless.has(resourceId))) {
          return;
        }
        if (paused) {
          this.setState(key, { fetching: false, error: `${paused}; paused, r tries now` });
          return;
        }
        this.waitFor(resourceId, key);
        this.setState(key, { fetching: true });
        this.options.resourceChanged?.(resourceId);
        const refreshed = await this.store.resources.refreshRemoteEntity(resourceId, false);
        const error = refreshed.remoteStatus?.freshness === "failed" ? refreshed.remoteStatus.lastError ?? "the last fetch failed" : undefined;
        if (error) this.failed(error);
        this.setState(key, error ? { fetching: false, error } : null);
        this.options.resourceChanged?.(resourceId);
      } catch (error) {
        this.failed(message(error));
        this.setState(key, { fetching: false, error: message(error) });
      }
    }));
  }

  /** Runs one key's bookkeeping; a failure is that key's to show, not the pass's. */
  private safely(key: string, work: () => void): void {
    try {
      work();
    } catch (error) {
      this.setState(key, { fetching: false, error: message(error) });
    }
  }

  private waitFor(resourceId: string, key: string): void {
    const keys = this.waiting.get(resourceId) ?? new Set<string>();
    keys.add(key);
    this.waiting.set(resourceId, keys);
  }

  /** The Resource for a key: registered on first use (one provider call), Sources from the extension's config. */
  private async resourceFor(key: string, paused?: string): Promise<string> {
    const lookup = () => this.store.resources.resolveAuthoredReference({ kind: "jira", key });
    let found = lookup();
    if (found.kind === "unavailable" && /No Jira Source/.test(found.reason)) {
      await this.ensureSources();
      found = lookup();
    }
    if (found.kind === "ready") return found.resourceId;
    if (found.kind === "unavailable") {
      throw new Error(/No Jira Source/.test(found.reason) && !(await this.extension())
        ? `${found.reason}: no Jira extension on this machine (add it with \`outliner ext add jira\`)`
        : found.reason);
    }
    // Registering asks the provider too: not while it has refused or rate-limited us.
    if (paused) throw new Error(`${paused}; paused, r tries now`);
    const running = this.follows.get(key);
    if (running) return running;
    const follow = this.store.resources.followAuthoredReference({ kind: "jira", key })
      .then((receipt) => receipt.resource.id)
      .finally(() => this.follows.delete(key));
    this.follows.set(key, follow);
    return follow;
  }

  /** The Sources an extension's config.json names, created once (no `resource-sources.create` step). */
  private async ensureSources(): Promise<void> {
    const described = await this.extension();
    if (!described) return;
    const sources = this.store.resources.listSources();
    for (const configured of described.sources) {
      // One bad entry in config.json doesn't stop the others (or every fetch).
      try {
        const origin = new URL(configured.origin).origin;
        if (sources.some((source) => source.provider === "jira" && source.boundary.origin === origin &&
          source.boundary.project === configured.project)) continue;
        this.store.resources.createSource({
          name: `${described.name} · ${configured.project}`,
          provider: "jira",
          boundary: { kind: "jira", origin, project: configured.project },
        });
      } catch {
        continue;
      }
    }
  }

  /** A refresh committed: write the key's one record under its home, now. */
  private observed(resource: Resource, document: RemoteEntityDocument): void {
    if (resource.provider !== "jira") return;
    this.succeeded();
    if (!document.record) { this.recordless.add(resource.id); return; }
    this.recordless.delete(resource.id);
    const record = document.record;
    const keys = new Set([
      ...this.waiting.get(resource.id) ?? [],
      ...this.store.extensionRecords({ extensionId: EXTENSION_ID, resourceId: resource.id, role: "record" }).map((row) => row.itemKey),
    ]);
    this.waiting.delete(resource.id);
    for (const key of keys) {
      const found = this.store.resources.resolveAuthoredReference({ kind: "jira", key });
      if (found.kind !== "ready" || found.resourceId !== resource.id) continue;
      const home = this.store.extensionRecordHome(EXTENSION_ID, key);
      if (!home) continue;
      const comments = this.commentsFor(key);
      try {
        this.asExtension(EXTENSION_ID, () => this.store.writeExtensionRecord({
          extensionId: EXTENSION_ID,
          label: this.label,
          parentBlockId: home,
          itemKey: key,
          resourceId: resource.id,
          text: recordBlockText(EXTENSION_ID, key, record),
          // Nobody asks for comments: none; the provider returned none this time: keep what is there.
          comments: !comments ? null : record.comments ? commentTexts(record, comments) : undefined,
        }));
        this.setState(key, null);
        if (!comments || record.comments) this.commentsWritten.set(key, comments);
      } catch (error) {
        this.setState(key, { fetching: false, error: message(error) });
      }
    }
    this.options.resourceChanged?.(resource.id);
  }

  /** Runs writes attributed to the extension, whatever request context started them. */
  private asExtension<T>(extensionId: string, work: () => T): T {
    const attribution = this.store.changes.attribution({
      action: `ext.${extensionId}.sync`,
      actor: { author: "agent", actorId: extensionActorId(extensionId) },
    });
    return this.store.changes.run(attribution, work);
  }

  /**
   * One provider search per Source for the tickets the outline shows, changed
   * since the last poll (with a minute of overlap); only those are read again.
   * A provider that can't search has its stale copies refreshed instead. A
   * search that fails keeps its window for the next poll; a paused sync skips
   * the poll.
   */
  async poll(): Promise<{ checked: number; changed: number }> {
    const started = this.now;
    const paused = this.paused();
    if (paused) {
      this.lastPollResult = { at: new Date(started).toISOString(), checked: 0, changed: 0, error: `paused: ${paused}` };
      return { checked: 0, changed: 0 };
    }
    // The first poll looks back to the oldest record's last write (the service may have been down),
    // at most a week; later ones to the last poll that finished.
    const oldest = Math.min(...this.store.extensionRecords({ extensionId: EXTENSION_ID, role: "record" }).map((row) => Date.parse(row.syncedAt)).filter(Number.isFinite));
    const from = Math.max(started - 7 * 24 * 60 * 60_000,
      this.lastPoll ?? (Number.isFinite(oldest) ? oldest : started - this.pollEveryMs));
    const sinceMinutes = Math.ceil((started - from) / 60_000) + 1;
    const bySource = new Map<string, Map<string, string>>();
    for (const row of this.store.extensionRecords({ extensionId: EXTENSION_ID, role: "record" })) {
      if (!row.resourceId) continue;
      const resource = this.store.resources.get(row.resourceId);
      if (!resource || resource.provider !== "jira") continue;
      const keys = bySource.get(resource.sourceId) ?? new Map<string, string>();
      if (keys.size < MAX_POLL_KEYS) keys.set(resource.address.key, resource.id);
      bySource.set(resource.sourceId, keys);
    }
    let checked = 0;
    let changed = 0;
    let failure: string | undefined;
    let searchFailed = false;
    for (const [sourceId, keys] of bySource) {
      if (this.paused()) { searchFailed = true; break; }
      checked += keys.size;
      try {
        const found = await this.store.resources.remoteEntityChanges(sourceId, [...keys.keys()], sinceMinutes);
        const due = found === null
          ? [...keys.values()].filter((id) => this.store.resources.describe(id, false).remoteStatus?.freshness === "stale")
          : found.flatMap((item) => keys.get(item.locator) ?? []);
        for (const resourceId of new Set(due)) {
          if (this.paused()) break;
          changed += 1;
          // One ticket that fails (the extension refuses it) doesn't hold up the others.
          try {
            const refreshed = await this.store.resources.refreshRemoteEntity(resourceId, false);
            if (refreshed.remoteStatus?.freshness === "failed") {
              const error = refreshed.remoteStatus.lastError ?? "a refresh failed";
              this.failed(error);
              failure ??= error;
            }
          } catch (error) {
            this.failed(message(error));
            failure ??= message(error);
          }
        }
      } catch (error) {
        failure = message(error);
        this.failed(failure);
        searchFailed = true;
      }
    }
    // A failed ticket stays failed (the next open retries it); a failed search keeps its window.
    if (!searchFailed) this.lastPoll = started;
    this.lastPollResult = { at: new Date(started).toISOString(), checked, changed, ...(failure ? { error: failure } : {}) };
    return { checked, changed };
  }
}

function commentTexts(record: ExtensionRecordData, count: number): { itemKey: string; text: string }[] {
  return (record.comments ?? []).slice(-count).map((comment) => ({ itemKey: comment.id, text: commentBlockText(EXTENSION_ID, comment) }));
}
