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
 * - **Refresh.** `resources.projection.refresh` refreshes one ticket now. Any
 *   refresh (this one, Detail's `r`, the poll) writes the record blocks, because
 *   the catalog reports every observation (`onRemoteEntityObserved`).
 * - **Poll.** While the service runs, one provider search every few minutes
 *   asks which of the outline's tickets changed since the last poll; only those
 *   are read again. A poll that finds nothing writes nothing.
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

function minutes(value: string | undefined): number | undefined {
  const match = value ? /^([1-9][0-9]{0,3})m$/.exec(value) : null;
  return match ? Number(match[1]) * 60_000 : undefined;
}

export class ExtensionSync {
  private readonly pages = new Map<string, Promise<void>>();
  private readonly follows = new Map<string, Promise<string>>();
  /** Pages waiting for a Resource's first observation, by Resource. */
  private readonly waiting = new Map<string, Set<string>>();
  private readonly state = new Map<string, ExtensionSyncState>();
  private readonly scheduled = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastPoll: number | null = null;
  /** Pages whose `--comments` the last write satisfied, by `page\0key`. */
  private readonly commentsWritten = new Set<string>();
  /** Resources whose provider returned no record (a contract 1 install): nothing to keep as blocks. */
  private readonly recordless = new Set<string>();
  private pollEveryMs = DEFAULT_POLL_MS;
  private stopped = true;
  private described: Promise<ExtensionDescription | null> | null = null;
  lastPollResult: { at: string; checked: number; changed: number; error?: string } | null = null;

  constructor(private readonly store: OutlinerStore, private readonly options: ExtensionSyncOptions = {}) {}

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** The installed Jira extension, read once per sync pass (null when none is installed or the client is a fixture). */
  private extension(): Promise<ExtensionDescription | null> {
    const client = this.store.resources.remoteEntityProviderClient as { describeExtension?: (provider: string) => Promise<ExtensionDescription | null> };
    this.described ??= (client.describeExtension?.("jira") ?? Promise.resolve(null)).catch(() => null)
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
    const handler = described?.handlers.find((candidate) => candidate.key === "jira");
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

  /** A block was saved: its provider lines get their records, in the background. */
  blockChanged(blockId: string): void {
    if (this.stopped || this.scheduled.has(blockId)) return;
    // Cheap guard: only a block with a provider line or property, or one that had records, has work.
    const block = this.store.get(blockId);
    if (!block || (!mayHaveResourceProjections(block.text) &&
      this.store.extensionRecords({ parentBlockId: blockId, role: "record" }).length === 0)) return;
    this.scheduled.add(blockId);
    setTimeout(() => {
      this.scheduled.delete(blockId);
      void this.materialize(blockId).catch(() => {});
    }, 0);
  }

  /** What a reader may show for a key on a page: fetching, or why the last attempt failed. */
  stateFor(pageBlockId: string, key: string): ExtensionSyncState | undefined {
    return this.state.get(`${pageBlockId}\0${key}`);
  }

  private setState(pageBlockId: string, key: string, state: ExtensionSyncState | null): void {
    if (state) this.state.set(`${pageBlockId}\0${key}`, state);
    else this.state.delete(`${pageBlockId}\0${key}`);
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

  private wanted(pageBlockId: string): { projections: readonly ResourceProjection[]; keys: Map<string, { comments?: number }> } | null {
    const block = this.store.get(pageBlockId);
    if (!block || block.effectiveDeletedRootId || this.store.extensionOwner(pageBlockId)) return null;
    let projections: readonly ResourceProjection[];
    try {
      projections = readResourceProjections(this.store, { blockId: pageBlockId }).projections;
    } catch {
      return null;
    }
    const keys = new Map<string, { comments?: number }>();
    for (const projection of projections) {
      if (projection.provider !== "jira" || !projection.key) continue;
      if (projection.status === "ambiguous" || projection.status === "no-key") continue;
      const previous = keys.get(projection.key);
      const comments = Math.max(previous?.comments ?? 0, projection.options.comments ?? 0);
      keys.set(projection.key, comments > 0 ? { comments } : {});
    }
    return { projections, keys };
  }

  private async materializeNow(pageBlockId: string, force: boolean): Promise<void> {
    // Keys count in context only when a Source claims them: make the configured ones first.
    if (this.store.get(pageBlockId) && !this.store.extensionOwner(pageBlockId)) await this.ensureSources();
    const wanted = this.wanted(pageBlockId);
    if (!wanted) return;
    const existing = this.store.extensionRecords({ parentBlockId: pageBlockId, extensionId: "jira", role: "record" });
    if (existing.some((row) => !wanted.keys.has(row.itemKey))) {
      this.asExtension("jira", () => this.store.removeExtensionRecords(pageBlockId, "jira", new Set(wanted.keys.keys())));
    }
    await Promise.all([...wanted.keys.keys()].map(async (key) => {
      const record = existing.find((row) => row.itemKey === key);
      try {
        const resourceId = await this.resourceFor(key);
        const description = this.store.resources.describe(resourceId, false);
        const freshness = description.remoteStatus?.freshness;
        // Comments asked for since the last write (a new --comments) need the ticket read again, once.
        const needsComments = (wanted.keys.get(key)?.comments ?? 0) > 0 && !this.commentsWritten.has(`${pageBlockId}\0${key}`);
        // A fresh copy is enough; a failed or stale one is tried again (a laptop that was offline recovers
        // on the next open). A provider that returns no record (a contract 1 install) is not asked again
        // while its copy is fresh: there would be nothing more to write.
        const settled = freshness === "fresh" || freshness === "refreshing";
        if (!force && settled && (record ? !needsComments : this.recordless.has(resourceId))) {
          return;
        }
        this.waitFor(resourceId, pageBlockId);
        this.setState(pageBlockId, key, { fetching: true });
        this.options.resourceChanged?.(resourceId);
        const refreshed = await this.store.resources.refreshRemoteEntity(resourceId, false);
        const error = refreshed.remoteStatus?.freshness === "failed" ? refreshed.remoteStatus.lastError ?? "the last fetch failed" : undefined;
        this.setState(pageBlockId, key, error ? { fetching: false, error } : null);
        this.options.resourceChanged?.(resourceId);
      } catch (error) {
        this.setState(pageBlockId, key, { fetching: false, error: error instanceof Error ? error.message : String(error) });
      }
    }));
  }

  private waitFor(resourceId: string, pageBlockId: string): void {
    const pages = this.waiting.get(resourceId) ?? new Set<string>();
    pages.add(pageBlockId);
    this.waiting.set(resourceId, pages);
  }

  /** The Resource for a key: registered on first use (one provider call), Sources from the extension's config. */
  private async resourceFor(key: string): Promise<string> {
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
      const origin = new URL(configured.origin).origin;
      if (sources.some((source) => source.provider === "jira" && source.boundary.origin === origin &&
        source.boundary.project === configured.project)) continue;
      this.store.resources.createSource({
        name: `${described.name} · ${configured.project}`,
        provider: "jira",
        boundary: { kind: "jira", origin, project: configured.project },
      });
    }
  }

  /** A refresh committed: write the records of every page that shows this Resource, now. */
  private observed(resource: Resource, document: RemoteEntityDocument): void {
    if (resource.provider !== "jira") return;
    if (!document.record) { this.recordless.add(resource.id); return; }
    this.recordless.delete(resource.id);
    const record = document.record;
    const pages = new Set([
      ...this.waiting.get(resource.id) ?? [],
      ...this.store.extensionRecords({ resourceId: resource.id, role: "record" }).map((row) => row.parentBlockId),
    ]);
    this.waiting.delete(resource.id);
    for (const pageBlockId of pages) {
      const wanted = this.wanted(pageBlockId);
      if (!wanted) continue;
      const key = [...wanted.keys.keys()].find((candidate) => {
        const found = this.store.resources.resolveAuthoredReference({ kind: "jira", key: candidate });
        return found.kind === "ready" && found.resourceId === resource.id;
      });
      if (!key) continue;
      const comments = wanted.keys.get(key)?.comments;
      try {
        this.asExtension("jira", () => this.store.writeExtensionRecord({
          extensionId: "jira",
          label: this.label,
          parentBlockId: pageBlockId,
          itemKey: key,
          resourceId: resource.id,
          text: recordBlockText("jira", key, record),
          // No `--comments`: none; the provider returned none this time: keep what is there.
          comments: !comments ? null : record.comments ? commentTexts(record, comments) : undefined,
        }));
        this.setState(pageBlockId, key, null);
        if (comments && record.comments) this.commentsWritten.add(`${pageBlockId}\0${key}`);
      } catch (error) {
        this.setState(pageBlockId, key, { fetching: false, error: error instanceof Error ? error.message : String(error) });
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
   * A provider that can't search has its stale copies refreshed instead.
   */
  async poll(): Promise<{ checked: number; changed: number }> {
    const started = this.now;
    // The first poll looks back to the oldest record's last write (the service may have been down),
    // at most a week; later ones to the last poll that finished.
    const oldest = Math.min(...this.store.extensionRecords({ extensionId: "jira", role: "record" }).map((row) => Date.parse(row.syncedAt)).filter(Number.isFinite));
    const from = this.lastPoll ?? Math.max(started - 7 * 24 * 60 * 60_000, Number.isFinite(oldest) ? oldest : started - this.pollEveryMs);
    const sinceMinutes = Math.ceil((started - from) / 60_000) + 1;
    const bySource = new Map<string, Map<string, string>>();
    for (const row of this.store.extensionRecords({ extensionId: "jira", role: "record" })) {
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
    for (const [sourceId, keys] of bySource) {
      checked += keys.size;
      try {
        const found = await this.store.resources.remoteEntityChanges(sourceId, [...keys.keys()], sinceMinutes);
        const due = found === null
          ? [...keys.values()].filter((id) => this.store.resources.describe(id, false).remoteStatus?.freshness === "stale")
          : found.flatMap((item) => keys.get(item.locator) ?? []);
        for (const resourceId of new Set(due)) {
          changed += 1;
          // One ticket that fails (the extension refuses it) doesn't hold up the others.
          try {
            const refreshed = await this.store.resources.refreshRemoteEntity(resourceId, false);
            if (refreshed.remoteStatus?.freshness === "failed") failure ??= refreshed.remoteStatus.lastError ?? "a refresh failed";
          } catch (error) {
            failure ??= error instanceof Error ? error.message : String(error);
          }
        }
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
    }
    // A failed ticket stays failed (the next open retries it); the window moves on for the others.
    this.lastPoll = started;
    this.lastPollResult = { at: new Date(started).toISOString(), checked, changed, ...(failure ? { error: failure } : {}) };
    return { checked, changed };
  }
}

function commentTexts(record: ExtensionRecordData, count: number): { itemKey: string; text: string }[] {
  return (record.comments ?? []).slice(-count).map((comment) => ({ itemKey: comment.id, text: commentBlockText("jira", comment) }));
}
