import { createHash } from "node:crypto";
import type { DraftPatchInput, DraftPatchResult } from "./draft-patch";
import type { DraftPatchSpan } from "./draft-patch-compare";
import { durationMs, DEFAULT_DEADLINE_MS } from "./extension-manifest";
import { extensionActorId, inertBlockdown } from "./extension-records";
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
 * line an agent or an import wrote waits for `r` (so agents can't loop). A
 * request runs once per text; changing the line is a new request, and `r`
 * asks again. Every write is `author: agent`, `actorId: ext:<id>`, under
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
  return {
    ...(typeof value.message === "string" ? { message: value.message } : {}),
    ...(typeof value.reply === "string" ? { reply: value.reply } : {}),
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

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
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

  /** `r` pressed while that request was running: one more run after it. */
  private readonly again = new Set<string>();

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
    // save and read since this feature shipped, across restarts).
    const before = new Set(created ? [] : this.store.agentRequestBaseline(blockId) ?? []);
    this.remember(blockId, shapes);
    const rows = this.store.agentRequests(blockId);
    const waitingTimers = [...this.timers.keys()].some((key) => key.startsWith(`${blockId}\0`));
    // Most saves: no request lines, nothing known, nothing waiting. No event either.
    if (!lines.length && !rows.length && !waitingTimers) return;
    // A request still waiting for quiet that the note no longer has is withdrawn.
    for (const [key, timer] of this.timers) {
      const [timerBlock, requestKey] = key.split("\0");
      if (timerBlock === blockId && !keys.includes(requestKey!)) {
        clearTimeout(timer);
        this.timers.delete(key);
      }
    }
    // Rows of names no extension answers now stay (the folder may be coming back); others follow the text.
    this.store.pruneAgentRequests(blockId, [...keys, ...rows.filter((row) => !this.registry.agent(row.agent)).map((row) => row.requestKey)]);
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

  /** `r` on a request line: ask its agent again now. Returns whether the line is a request. */
  async refresh(blockId: string, line: number): Promise<boolean> {
    const block = this.store.get(blockId);
    if (!block) return false;
    const chosen = this.lines(block).filter((candidate) => candidate.line === line);
    await Promise.all(chosen.map((candidate) => this.run(blockId, candidate.requestKey, true)));
    return chosen.length > 0;
  }

  private async run(blockId: string, requestKey: string, asked = false): Promise<void> {
    const key = this.key(blockId, requestKey);
    if (this.stopped) return;
    if (this.running.has(key)) {
      if (asked) this.again.add(key);
      return;
    }
    const block = this.store.get(blockId);
    const line = block ? this.lines(block).find((candidate) => candidate.requestKey === requestKey) : undefined;
    const bound = line ? this.registry.agent(line.agent) : undefined;
    if (!block || !line || !bound) return;
    const { extension, agent } = bound;
    const previous = this.store.agentRequests(blockId).find((row) => row.requestKey === requestKey);
    const base = {
      blockId, requestKey, agent: line.agent, extensionId: extension.id, request: line.request,
      requestedBy: previous && !asked ? previous.requestedBy : asked ? "r" : "user",
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
      // An agent never writes a request line (new or reworded, any name): its edit can't set off another agent.
      const beforeKeys = new Set(requestLines(draft.text, null).map((candidate) => candidate.requestKey));
      let after = draft.text;
      for (const patch of respond.patches) after = after.replace(patch.observed, () => patch.replacement);
      if (requestLines(after, null).some((candidate) => !beforeKeys.has(candidate.requestKey))) {
        throw new Error(`@${line.agent} tried to write an @request line; agents can't ask agents`);
      }
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
      if (this.again.delete(key)) void this.run(blockId, requestKey, true).catch(() => {});
    }
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
