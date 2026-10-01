import { createHash } from "node:crypto";
import type { DraftPatchInput, DraftPatchResult } from "./draft-patch";
import type { DraftPatchSpan } from "./draft-patch-compare";
import { durationMs, DEFAULT_DEADLINE_MS } from "./extension-manifest";
import { cleanExtensionText, extensionActorId, inertBlockdown } from "./extension-records";
import type { ExtensionRegistry } from "./extension-registry";
import { scanPropertyLiteralRanges } from "./properties";
import type { ResourceProjection } from "./resource-projection";
import type { ResourceExtensionRuntime } from "./resource-extensions";
import type { AgentRequestRow, OutlinerStore } from "./store";
import type { Block, MutationProvenance } from "./types";

/**
 * Agents addressed while you write (PIE-501): a person writes
 * `@tidy can you fix the formatting above` and keeps typing. The service
 * picks the line up once it has been quiet for a moment, runs the agent an
 * extension declares (`agents[]`, the `respond` operation), and:
 *
 * - applies its patches as an attributed edit through `draft.patch` with the
 *   default `edit` policy, spans ending above the request line. A note held by
 *   a door's live draft gets the patch there; only a failed compare (the
 *   person was typing in that passage) becomes a proposal under the line;
 * - shows its reply, if any, under the line (the projection slot, like an
 *   extension's output).
 *
 * Who wrote the line decides whether it runs: a person's line runs once; a
 * line an agent or an import wrote waits for a person's `r` (so agents can't
 * loop). A request runs once per text; changing the line is a new request, and
 * `r` asks again (on the note, `r` asks the requests not answered yet). A door
 * that says when the person types in a draft it holds (`drafts.touch`) gets a
 * request run while they write, before any save. Every write is `author: agent`, `actorId: ext:<id>`, under
 * `ext.<id>.agent.<name>` in the change feed.
 */

export interface RequestLine {
  readonly agent: string;
  /** What the person asked, after `@name`. */
  readonly request: string;
  /** The whole line as written: the mark a patch must end above. */
  readonly text: string;
  readonly line: number;
  readonly start: number;
  readonly end: number;
  /** One request per agent and wording in a block. */
  readonly requestKey: string;
}

const REQUEST = /^([ \t]*(?:[-*+][ \t]+)?)@([a-z][a-z0-9-]{0,31})(?=$|[\s:,])[:,]?[ \t]*(.*)$/;
const MAX_REQUESTS = 8;
const MAX_NOTE_TEXT = 64 * 1024;
const MAX_REPLY = 64 * 1024;
const MAX_PATCHES = 20;
const DEFAULT_QUIET_MS = 1_500;
/** How long a removed request line's answer is kept, so undoing the removal doesn't ask again. */
const REMOVED_KEPT_MS = 10 * 60_000;
const REMOVED_KEPT_MAX = 500;
const ANSWERED: ReadonlySet<string> = new Set(["applied", "proposed", "replied", "nothing"]);

/**
 * The `@name …` lines in a block's text whose names an extension answers
 * (every `@name` line with `names` null). Code is text.
 */
export function requestLines(text: string, names: ReadonlySet<string> | null): RequestLine[] {
  if ((names && !names.size) || !text.includes("@")) return [];
  const literal = scanPropertyLiteralRanges(text);
  const found: RequestLine[] = [];
  let offset = 0;
  text.split("\n").forEach((raw, line) => {
    const start = offset;
    offset += raw.length + 1;
    const content = raw.replace(/\r$/, "");
    const match = REQUEST.exec(content);
    if (!match || (names && !names.has(match[2]!)) || found.length >= (names ? MAX_REQUESTS : 256)) return;
    const at = start + match[1]!.length;
    if (literal.some((range) => range.start <= at && at < range.end)) return;
    const request = match[3]!.trim();
    found.push({
      agent: match[2]!, request, text: content, line, start: at, end: start + content.length,
      requestKey: createHash("sha256").update(`${match[2]}\0${request}`).digest("hex").slice(0, 32),
    });
  });
  return found;
}

export interface AgentRequestDeps {
  /** The note as the person sees it: its live draft when a door holds one (`drafts.read`). */
  readDraft(blockId: string): Promise<{ text: string; revision: number }>;
  /** `draft.patch`, routed to the live draft or the saved note. */
  patch(input: DraftPatchInput): Promise<DraftPatchResult>;
  /** A request's state changed: readers repaint the block. */
  changed(blockId: string): void;
  /** How long a person's request line must stay unchanged before it runs (default 1.5 s). */
  readonly quietMs?: number;
  readonly now?: () => number;
}

interface RespondValue {
  message?: string;
  reply?: string;
  patches: DraftPatchSpan[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validateRespond(value: unknown): RespondValue {
  if (!isObject(value)) throw new Error("an agent answers { message?, reply?, patches? }");
  if (value.message !== undefined && (typeof value.message !== "string" || value.message.length > 500)) throw new Error("message must be text up to 500 characters");
  if (value.reply !== undefined && (typeof value.reply !== "string" || Buffer.byteLength(value.reply) > MAX_REPLY)) throw new Error("reply must be markdown up to 64 KiB");
  const patches = value.patches ?? [];
  if (!Array.isArray(patches) || patches.length > MAX_PATCHES) throw new Error(`patches must be a list of at most ${MAX_PATCHES}`);
  // Kept clean: no terminal escapes or control characters reach a reader.
  return {
    ...(typeof value.message === "string" ? { message: cleanExtensionText(value.message) } : {}),
    ...(typeof value.reply === "string" ? { reply: cleanExtensionText(value.reply, true) } : {}),
    patches: patches.map((patch, index) => {
      if (!isObject(patch) || typeof patch.observed !== "string" || !patch.observed || typeof patch.replacement !== "string") {
        throw new Error(`patches[${index}] must be { observed, replacement, before?, after? }`);
      }
      return {
        observed: patch.observed, replacement: patch.replacement,
        ...(typeof patch.before === "string" ? { before: patch.before } : {}),
        ...(typeof patch.after === "string" ? { after: patch.after } : {}),
      };
    }),
  };
}

/** Who asked, as a request row says it: `user`, `agent:<actorId>` or `system`. */
function requester(actor: MutationProvenance | undefined): string {
  if (actor?.author === "agent") return actor.actorId ? `agent:${actor.actorId}` : "agent";
  return actor?.author === "system" ? "system" : "user";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message.replace(/^Resource extension: /, "") : String(error);
}

export class AgentRequests {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly running = new Set<string>();
  private stopped = false;

  constructor(
    private readonly store: OutlinerStore,
    private readonly registry: ExtensionRegistry,
    private readonly runtime: ResourceExtensionRuntime,
    private readonly deps: AgentRequestDeps,
  ) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /**
   * The service started. A request a restart cut off says so (it isn't "working on it" forever), and once per
   * outline every note with `@name` lines and no baseline (written before this feature) gets one: its lines
   * are old, so its first unrelated save doesn't run them.
   */
  start(): void {
    this.store.interruptAgentRequests("interrupted by a restart: r asks again", new Date(this.now).toISOString());
    this.store.seedAgentRequestBaselines((text) => requestLines(text, null).map((line) => line.requestKey));
  }

  /** A request still waiting out its quiet when the service stops is kept as waiting for `r`, not lost. */
  stop(): void {
    this.stopped = true;
    for (const [key, timer] of this.timers) {
      clearTimeout(timer);
      const [blockId, requestKey] = key.split("\0") as [string, string];
      try {
        const block = this.store.get(blockId);
        const line = block ? this.lines(block).find((candidate) => candidate.requestKey === requestKey) : undefined;
        const bound = line ? this.registry.agent(line.agent) : undefined;
        if (line && bound && !this.store.agentRequests(blockId).some((row) => row.requestKey === requestKey)) {
          this.store.putAgentRequest({
            blockId, requestKey, agent: line.agent, extensionId: bound.extension.id, request: line.request, status: "waiting",
            message: `the service stopped before @${line.agent} answered: r asks it`, requestedBy: "user", requestedAt: new Date(this.now).toISOString(),
          });
        }
      } catch {
        // The store is closing: the line stays as written, and r asks.
      }
    }
    this.timers.clear();
  }

  /** Every `@name` line's key, whatever the name: what a later save is compared with. */
  private shapes(block: Block): string[] {
    if (block.effectiveDeletedRootId || this.store.extensionOwner(block.id)) return [];
    return requestLines(block.text, null).map((line) => line.requestKey);
  }

  private lines(block: Block): RequestLine[] {
    if (block.effectiveDeletedRootId || this.store.extensionOwner(block.id)) return [];
    return requestLines(block.text, this.registry.agentNames());
  }

  private key(blockId: string, requestKey: string): string {
    return `${blockId}\0${requestKey}`;
  }

  /** `r` pressed while that request was running: one more run after it, for whoever asked. */
  private readonly again = new Map<string, string>();

  /** Rows of request lines a save took out lately: undoing the removal brings the answer back instead of asking again. */
  private readonly removed = new Map<string, { row: AgentRequestRow; at: number }>();

  private recall(blockId: string, requestKey: string): AgentRequestRow | null {
    const key = this.key(blockId, requestKey);
    const kept = this.removed.get(key);
    if (!kept) return null;
    this.removed.delete(key);
    return this.now - kept.at <= REMOVED_KEPT_MS ? kept.row : null;
  }

  /** The `@name` lines a block holds now become what its next save is compared with (kept in the store). */
  private remember(blockId: string, keys: readonly string[]): void {
    const before = this.store.agentRequestBaseline(blockId);
    if (before === null && !keys.length) return;
    if (before && before.length === keys.length && before.every((key, index) => key === keys[index])) return;
    this.store.setAgentRequestBaseline(blockId, keys);
  }

  private schedule(blockId: string, requestKey: string): void {
    const key = this.key(blockId, requestKey);
    const previous = this.timers.get(key);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.timers.delete(key);
      void this.run(blockId, requestKey).catch(() => {});
    }, this.deps.quietMs ?? DEFAULT_QUIET_MS);
    timer.unref?.();
    this.timers.set(key, timer);
  }

  /**
   * An extension wrote the block (its own record, an action's write, an agent's applied patch). That runs
   * nothing, but the `@name` lines it holds now are what the next save is compared with: a line an
   * extension's write left is never taken for one the person's next save added.
   */
  observe(blockId: string): void {
    if (this.stopped) return;
    const block = this.store.get(blockId);
    if (!block) return;
    this.remember(blockId, this.shapes(block));
    // Requests whose lines the write took out are withdrawn, as after any save.
    if (this.withdraw(blockId, this.lines(block).map((line) => line.requestKey))) this.deps.changed(blockId);
  }

  /**
   * Rows and waiting timers of request lines a block no longer has go (rows of names no extension answers now
   * stay: the folder may be coming back). Whether anything was known about the block's requests.
   */
  private withdraw(blockId: string, keys: readonly string[]): boolean {
    const rows = this.store.agentRequests(blockId);
    let waiting = false;
    for (const [key, timer] of this.timers) {
      const [timerBlock, requestKey] = key.split("\0");
      if (timerBlock !== blockId) continue;
      waiting = true;
      if (!keys.includes(requestKey!)) {
        clearTimeout(timer);
        this.timers.delete(key);
      }
    }
    if (!rows.length && !waiting) return false;
    const now = this.now;
    for (const [key, kept] of this.removed) if (now - kept.at > REMOVED_KEPT_MS) this.removed.delete(key);
    for (const row of rows) {
      // Answered ones only: a line that was waiting (an agent wrote it) and a person writes again is theirs, and new.
      if (keys.includes(row.requestKey) || !ANSWERED.has(row.status) || !this.registry.agent(row.agent)) continue;
      if (this.removed.size >= REMOVED_KEPT_MAX) this.removed.delete(this.removed.keys().next().value!);
      this.removed.set(this.key(blockId, row.requestKey), { row, at: now });
    }
    this.store.pruneAgentRequests(blockId, [...keys, ...rows.filter((row) => !this.registry.agent(row.agent)).map((row) => row.requestKey)]);
    return true;
  }

  /**
   * A block was saved (not by an extension). A request line this save added
   * runs once the note has been quiet for a moment, when a person wrote it;
   * when an agent or an import did, it is recorded as waiting for `r`. Lines
   * already there (before an install, or before this service started and no
   * reader opened the note) are never run by a save: `r` asks. `created`: the
   * save made the block, so all its lines are new.
   */
  blockChanged(blockId: string, actor: MutationProvenance | undefined, created = false): void {
    if (this.stopped) return;
    const block = this.store.get(blockId);
    if (!block) return;
    const lines = this.lines(block);
    const keys = lines.map((line) => line.requestKey);
    // The baseline is every `@name` line, answered or not: a line written before its extension was
    // installed is an old line once it is, not a new request.
    const shapes = this.shapes(block);
    // Never seen with an `@name` line: none was there before this save (the baseline is kept from every
    // save and read since this feature shipped, across restarts, and `start` gave notes from before it one).
    const before = new Set(created ? [] : this.store.agentRequestBaseline(blockId) ?? []);
    this.remember(blockId, shapes);
    const rows = this.store.agentRequests(blockId);
    // A request still waiting for quiet that the note no longer has is withdrawn; rows follow the text.
    const known = this.withdraw(blockId, keys);
    // Most saves: no request lines, nothing known, nothing waiting. No event either.
    if (!lines.length && !known) return;
    const answered = new Set(rows.map((row) => row.requestKey));
    const byPerson = actor?.author === "user";
    for (const line of lines) {
      const key = this.key(blockId, line.requestKey);
      // Quiet means quiet: any save while the line waits starts the wait again.
      if (this.timers.has(key)) {
        this.schedule(blockId, line.requestKey);
        continue;
      }
      if (before.has(line.requestKey) || answered.has(line.requestKey)) continue;
      // Taken out and put back (an undo): what it had is what it has, nothing is asked again.
      const kept = this.recall(blockId, line.requestKey);
      if (kept) {
        this.store.putAgentRequest(kept);
        continue;
      }
      if (byPerson) {
        this.schedule(blockId, line.requestKey);
        continue;
      }
      this.store.putAgentRequest({
        blockId, requestKey: line.requestKey, agent: line.agent, extensionId: this.registry.agent(line.agent)!.extension.id, request: line.request,
        status: "waiting", message: "written by an agent: r asks it", requestedBy: actor?.actorId ? `agent:${actor.actorId}` : actor?.author ?? "system",
        requestedAt: new Date(this.now).toISOString(),
      });
    }
    this.deps.changed(blockId);
  }

  /**
   * A person typed in a draft a door holds (`drafts.touch`; `text` is the draft as the door has it). A request
   * line the draft has and the saved note never had runs once the draft has been quiet, as a save's would: the
   * person goes on typing and the answer lands in the draft. The rows it leaves keep a later save from asking
   * again.
   */
  touched(blockId: string, text: string): void {
    if (this.stopped) return;
    const block = this.store.get(blockId);
    if (!block || block.effectiveDeletedRootId || this.store.extensionOwner(blockId)) return;
    const lines = requestLines(text, this.registry.agentNames());
    const keys = new Set(lines.map((line) => line.requestKey));
    // A request waiting for quiet that the draft no longer has stops waiting.
    for (const [key, timer] of this.timers) {
      const [timerBlock, requestKey] = key.split("\0");
      if (timerBlock === blockId && !keys.has(requestKey!)) {
        clearTimeout(timer);
        this.timers.delete(key);
      }
    }
    const before = new Set(this.store.agentRequestBaseline(blockId) ?? []);
    const answered = new Set(this.store.agentRequests(blockId).map((row) => row.requestKey));
    for (const line of lines) {
      const key = this.key(blockId, line.requestKey);
      if (this.timers.has(key)) {
        this.schedule(blockId, line.requestKey);
        continue;
      }
      if (before.has(line.requestKey) || answered.has(line.requestKey) || this.running.has(key)) continue;
      const kept = this.recall(blockId, line.requestKey);
      if (kept) {
        this.store.putAgentRequest(kept);
        continue;
      }
      this.schedule(blockId, line.requestKey);
    }
  }

  /**
   * `r`: on a request line (`line`), ask its agent again now; on the note, ask every request in it not answered
   * yet (not asked, waiting, failed). `actor` is who pressed it, recorded as who asked. A line an agent or an
   * import wrote waits for a person: an agent's `r` on it is refused. Returns whether a request was asked.
   */
  async refresh(blockId: string, line: number | undefined, actor?: MutationProvenance): Promise<boolean> {
    const block = this.store.get(blockId);
    if (!block) return false;
    const rows = new Map(this.store.agentRequests(blockId).map((row) => [row.requestKey, row]));
    const byAgent = actor?.author === "agent";
    const held = (candidate: RequestLine) => {
      const row = rows.get(candidate.requestKey);
      return row?.status === "waiting" && row.requestedBy !== "user";
    };
    const lines = this.lines(block);
    let chosen: RequestLine[];
    if (line !== undefined) {
      chosen = lines.filter((candidate) => candidate.line === line);
      const waits = byAgent ? chosen.find(held) : undefined;
      if (waits) throw new Error(`@${waits.agent} on this line was written by an agent or an import: it waits for a person's r`);
    } else {
      chosen = lines.filter((candidate) => {
        const row = rows.get(candidate.requestKey);
        return (!row || row.status === "waiting" || row.status === "failed") && !(byAgent && held(candidate));
      });
    }
    const asked = [...new Set(chosen.map((candidate) => candidate.requestKey))];
    for (const requestKey of asked) {
      // Asked now: a wait for quiet on it is over.
      const timer = this.timers.get(this.key(blockId, requestKey));
      if (timer) clearTimeout(timer);
      this.timers.delete(this.key(blockId, requestKey));
    }
    const by = requester(actor);
    await Promise.all(asked.map((requestKey) => this.run(blockId, requestKey, by)));
    return asked.length > 0;
  }

  /** `askedBy`: who pressed `r` (absent when a save or a draft's quiet ran it). */
  private async run(blockId: string, requestKey: string, askedBy?: string): Promise<void> {
    const key = this.key(blockId, requestKey);
    if (this.stopped) return;
    if (this.running.has(key)) {
      if (askedBy) this.again.set(key, askedBy);
      return;
    }
    const block = this.store.get(blockId);
    if (!block) return;
    let found = this.lines(block).find((candidate) => candidate.requestKey === requestKey);
    if (!found && !block.effectiveDeletedRootId && !this.store.extensionOwner(blockId)) {
      // Asked while typing (`drafts.touch`): the line is in the live draft, not saved yet.
      const draft = await this.deps.readDraft(blockId).catch(() => null);
      found = draft ? requestLines(draft.text, this.registry.agentNames()).find((candidate) => candidate.requestKey === requestKey) : undefined;
      if (this.stopped || this.running.has(key)) return;
    }
    const line = found;
    const bound = line ? this.registry.agent(line.agent) : undefined;
    if (!line || !bound) return;
    const { extension, agent } = bound;
    const previous = this.store.agentRequests(blockId).find((row) => row.requestKey === requestKey);
    const base = {
      blockId, requestKey, agent: line.agent, extensionId: extension.id, request: line.request,
      requestedBy: askedBy ?? previous?.requestedBy ?? "user",
      requestedAt: previous?.requestedAt ?? new Date(this.now).toISOString(),
    };
    const stillThere = (text: string) => text.split("\n").some((candidate) => candidate.replace(/\r$/, "") === line.text);
    this.running.add(key);
    this.store.putAgentRequest({ ...base, status: "running" });
    this.deps.changed(blockId);
    let answer: Pick<AgentRequestRow, "status" | "message" | "reply" | "proposalId"> | null = null;
    try {
      const draft = await this.deps.readDraft(blockId);
      // The person changed or removed the line meanwhile: that is a new request (or none), not this one.
      if (!stillThere(draft.text)) return;
      const context = this.store.blockContext(blockId);
      const result = await this.runtime.invokeLoaded(extension, "respond", {
        agent: line.agent,
        request: line.request,
        mark: line.text,
        note: { id: blockId, revision: draft.revision, text: draft.text.slice(0, MAX_NOTE_TEXT) },
        context: {
          ancestors: context.ancestors.slice(-8).map((ancestor) => ({ id: ancestor.id, title: ancestor.text.split("\n", 1)[0] })),
          children: context.children.slice(0, 50).map((child) => ({ id: child.id, text: child.text.slice(0, 2_000) })),
          now: new Date(this.now).toISOString(),
        },
      }, durationMs(agent.deadline) ?? durationMs(extension.manifest.deadline) ?? DEFAULT_DEADLINE_MS);
      let respond: RespondValue;
      try {
        respond = validateRespond(result.value);
      } catch (error) {
        throw new Error(`@${line.agent} answered something the service can't apply: ${message(error)}`);
      }
      // An agent never writes a request line (new or reworded, any name): draft.patch refuses every agent's
      // patch that would, this one's included, so its edit can't set off another agent.
      // Reworded while it ran: the answer was to a request that isn't there any more.
      if (!stillThere((await this.deps.readDraft(blockId)).text)) return;
      if (respond.patches.length) {
        const actor: MutationProvenance = { author: "agent", actorId: extensionActorId(extension.id) };
        // The edit's own feed entries say which agent made it. `current`: typing elsewhere in the note
        // doesn't make it a proposal; typing in that passage does.
        const outcome = await this.store.changes.run(
          this.store.changes.attribution({ action: `ext.${extension.id}.agent.${line.agent}`, actor }),
          () => this.deps.patch({ blockId, revision: draft.revision, patches: respond.patches, mutation: actor, mark: { text: line.text, blockId }, current: true }),
        );
        answer = outcome.outcome === "applied"
          ? { status: "applied", message: respond.message ?? `applied ${respond.patches.length === 1 ? "an edit" : `${respond.patches.length} edits`}`, reply: respond.reply ?? null }
          : { status: "proposed", message: `proposed instead: ${outcome.reason}`, proposalId: outcome.proposalId, reply: respond.reply ?? null };
      } else if (respond.reply !== undefined) {
        answer = { status: "replied", message: respond.message ?? null, reply: respond.reply };
      } else {
        answer = { status: "nothing", message: respond.message ?? "nothing to change" };
      }
    } catch (error) {
      answer = { status: "failed", message: message(error) };
    } finally {
      this.running.delete(key);
      const current = this.store.get(blockId);
      if (answer && current) this.store.putAgentRequest({ ...base, ...answer, answeredAt: new Date(this.now).toISOString() });
      // Not answered (the line changed): put back what was known before this run, or nothing.
      else if (current && previous) this.store.putAgentRequest(previous);
      else if (current) this.store.pruneAgentRequests(blockId, this.store.agentRequests(blockId).map((row) => row.requestKey).filter((candidate) => candidate !== requestKey));
      this.deps.changed(blockId);
      const again = this.again.get(key);
      if (again) {
        this.again.delete(key);
        void this.run(blockId, requestKey, again).catch(() => {});
      }
    }
  }

  /**
   * The proposal a request left was applied anyway or dismissed (PIE-510): its row says so, so the line's
   * projection tells the truth in every client. Who did it is said when it wasn't the person.
   */
  proposalSettled(proposalId: string, status: "applied" | "dismissed", by: MutationProvenance): void {
    const row = this.store.agentRequestByProposal(proposalId);
    if (!row || row.status !== "proposed") return;
    const who = by.author === "agent" ? ` by @${by.actorId ?? "an agent"}` : "";
    this.store.putAgentRequest({
      ...row, status,
      message: status === "applied" ? `its proposal was applied anyway${who}` : `its proposal was dismissed${who}`,
      answeredAt: new Date(this.now).toISOString(),
    });
    this.deps.changed(row.blockId);
  }

  /** One projection per request line, in the slot extension outputs use (`resources.projection.read`). */
  projections(blockId: string, line?: number): ResourceProjection[] {
    const block = this.store.get(blockId);
    if (!block) return [];
    const rows = new Map(this.store.agentRequests(blockId).map((row) => [row.requestKey, row]));
    const lines = this.lines(block);
    // A note a reader opens: what it holds now is the baseline a later save is compared with.
    if (this.store.agentRequestBaseline(blockId) === null) this.remember(blockId, this.shapes(block));
    return lines
      .filter((candidate) => line === undefined || candidate.line === line)
      .map((candidate) => {
        const bound = this.registry.agent(candidate.agent)!;
        const row = rows.get(candidate.requestKey);
        const scheduled = this.timers.has(this.key(blockId, candidate.requestKey));
        const base = {
          anchor: { kind: "directive" as const, line: candidate.line, start: candidate.start, end: candidate.end },
          provider: bound.extension.id,
          label: bound.extension.name,
          propertyKey: `@${candidate.agent}`,
          key: `@${candidate.agent}`,
          kind: "agent" as const,
          options: { unknown: [] },
          fields: [],
          agent: {
            name: candidate.agent,
            status: row?.status ?? (scheduled ? "queued" : "not-asked"),
            ...(row?.message ? { message: row.message } : {}),
            ...(row?.proposalId ? { proposalId: row.proposalId } : {}),
            ...(row ? { requestedBy: row.requestedBy } : {}),
          },
        };
        if (!row) {
          return { ...base, status: "not-run" as const, reason: scheduled ? `@${candidate.agent} answers once the line is quiet` : `r asks @${candidate.agent}` };
        }
        if (row.status === "running") return { ...base, status: "not-run" as const, fetching: true, reason: `@${candidate.agent} is working on it` };
        if (row.status === "waiting") return { ...base, status: "not-run" as const, reason: row.message ?? `r asks @${candidate.agent}` };
        if (row.status === "failed") return { ...base, status: "unavailable" as const, reason: row.message ?? "it failed", fetchError: row.message ?? "it failed" };
        const at = row.answeredAt ?? row.requestedAt;
        return {
          ...base,
          status: "ready" as const,
          summary: row.message ?? row.status,
          fetchedAt: at,
          ...(row.reply ? { output: { markdown: inertBlockdown(row.reply), ranAt: at, ...(row.message ? { title: row.message } : {}) } } : {}),
        };
      });
  }
}
