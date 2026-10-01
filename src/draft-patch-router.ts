/**
 * Where a `draft.patch` goes (PIE-501). Routing is the service's job, not the
 * agent's: a note a door holds a live draft of is patched in that draft (the
 * door runs the compare against its buffer), any other is patched as saved,
 * under a revision check. Several notes apply together or not at all: every
 * part is checked, the drafts are patched, then the saved notes are written in
 * one transaction; a failure anywhere reverts the drafts already patched and
 * the whole patch lands as a proposal instead.
 *
 * The rule a matching patch is held to (`policy`) is the patch's: `edit`, the
 * default, is the guard every agent edit has (`droppedLinkedStructure`, shared
 * with outline_edit), and a patch it refuses is an error, nothing written, as
 * outline_edit's is: it never parks as a proposal. `prose` (a tidy of the
 * person's words) keeps every structural token, and what it refuses becomes a
 * proposal for the person. Only a compare that fails (the note changed since
 * it was read, the passage isn't there, the cursor is in it) or a prose refusal
 * becomes a proposal.
 */
import {
  applyLocated,
  locateSpans,
  locateSpanForced,
  markStart,
  spanContext,
  type DraftPatchSpan,
} from "./draft-patch-compare";
import {
  DRAFT_PATCH_POLICIES,
  DRAFT_PROPOSAL_TYPE,
  draftPatchPolicy,
  droppedStructure,
  draftPatchTextPolicy,
  proposalShowsPatch,
  embedLine,
  insertAfterMark,
  parseProposal,
  proposalChanges,
  proposalText,
  withProposalApplied,
  type DraftHold,
  type DraftHolderAnswer,
  type DraftHolderRequest,
  type DraftHolds,
  type DraftPatchApplied,
  type DraftPatchEdit,
  type DraftPatchInput,
  type DraftPatchPolicyName,
  type DraftPatchProposed,
  type DraftPatchResult,
  type DraftPatchRoute,
  type DraftProposal,
} from "./draft-patch";
import { blockDisplayTitle } from "./references";
import type { OutlinerStore } from "./store";
import type { MutationProvenance } from "./types";
import { droppedLinkedStructure, type WorkToolsClient } from "./work-tools";

/** What a request to a holding door carries besides its ids, which the server fills in. */
export type DraftHolderAsk =
  | { kind: "read" }
  | { kind: "patch"; patchId: string; revision: number; patches: DraftPatchSpan[]; mutation: MutationProvenance; mark?: string; force?: boolean }
  | { kind: "revert"; patchId: string }
  | { kind: "embed"; line: string; mark?: string; mutation: MutationProvenance };

export interface DraftPatchRouterDeps {
  store: OutlinerStore;
  holds: DraftHolds;
  /** Whether a door's client is still connected. */
  isLive(clientId: string): boolean;
  /** Ask the door holding a draft; rejects when it doesn't answer in time (the hold is then let go). */
  ask(hold: DraftHold, request: DraftHolderAsk): Promise<DraftHolderAnswer>;
  /** Reads for the `edit` policy's guard (backlinks, block text), in process. */
  client: WorkToolsClient;
}

interface RunOptions {
  mutation: MutationProvenance;
  mark?: { text: string; blockId: string };
  /** "Apply anyway" by the person: placed as well as it can be, with no revision, mark or policy check. */
  force?: boolean;
  /** Compare against the text as it is now rather than the revision the patch was read at (an agent's apply). */
  current?: boolean;
  /** The rule a matching patch is held to (not checked when forced). */
  policy: DraftPatchPolicyName;
  allowStructural?: boolean;
}

/** `refused`: the `edit` policy's guard said no; the patch is an error, never a proposal. */
type Outcome = { ok: true; applied: DraftPatchApplied["edits"] } | { ok: false; reason: string; refused?: boolean };

/** A refusal by the `edit` policy: nothing was written, and the agent hears why. */
export class DraftPatchRefusal extends Error {
  constructor(reason: string) {
    super(`Not applied, nothing was written: ${reason}`);
    this.name = "DraftPatchRefusal";
  }
}

const MAX_EDITS = 50;
const MAX_SPANS = 200;

function normalizeSpan(span: DraftPatchSpan): DraftPatchSpan {
  if (!span || typeof span !== "object") throw new Error("A patch span is an object");
  if (typeof span.observed !== "string" || typeof span.replacement !== "string") {
    throw new Error("A patch span needs observed and replacement text");
  }
  if (span.unit !== undefined && span.unit !== "utf16" && span.unit !== "utf8") {
    throw new Error("A patch span's unit is utf16 or utf8");
  }
  if (span.range !== undefined && (typeof span.range !== "object" || !Number.isSafeInteger(span.range.start) || !Number.isSafeInteger(span.range.end))) {
    throw new Error("A patch span's range is { start, end }, integers");
  }
  return {
    observed: span.observed,
    replacement: span.replacement,
    ...(span.range ? { range: { start: span.range.start, end: span.range.end } } : {}),
    unit: span.unit ?? "utf16",
    ...(typeof span.before === "string" ? { before: span.before } : {}),
    ...(typeof span.after === "string" ? { after: span.after } : {}),
  };
}

/** The request's notes, checked: one note's fields, or `edits`. */
export function normalizeDraftPatchEdits(input: Pick<DraftPatchInput, "blockId" | "revision" | "patches" | "edits">): DraftPatchEdit[] {
  const single = input.blockId !== undefined || input.revision !== undefined || input.patches !== undefined;
  if (single && input.edits !== undefined) throw new Error("A patch names one note (blockId, revision, patches) or several (edits), not both");
  const raw = single ? [{ blockId: input.blockId, revision: input.revision, patches: input.patches }] : input.edits;
  if (!Array.isArray(raw) || !raw.length) throw new Error("A patch needs blockId, revision and patches, or edits");
  if (raw.length > MAX_EDITS) throw new Error(`A patch changes at most ${MAX_EDITS} notes`);
  const seen = new Set<string>();
  let spans = 0;
  return raw.map(edit => {
    const blockId = typeof edit?.blockId === "string" ? edit.blockId.trim() : "";
    if (!blockId) throw new Error("Each note of a patch needs a blockId");
    if (seen.has(blockId)) throw new Error(`A patch names ${blockId} twice; put its spans together`);
    seen.add(blockId);
    if (!Number.isSafeInteger(edit.revision) || edit.revision! < 1) throw new Error("Each note of a patch needs the positive integer revision its text was read at");
    if (!Array.isArray(edit.patches) || !edit.patches.length) throw new Error("Each note of a patch needs at least one span");
    spans += edit.patches.length;
    if (spans > MAX_SPANS) throw new Error(`A patch has at most ${MAX_SPANS} spans`);
    return { blockId, revision: edit.revision!, patches: edit.patches.map(normalizeSpan) };
  });
}

function normalizePolicy(policy: unknown): DraftPatchPolicyName {
  if (policy === undefined || policy === null) return "edit";
  if (!DRAFT_PATCH_POLICIES.includes(policy as DraftPatchPolicyName)) throw new Error(`A patch's policy is ${DRAFT_PATCH_POLICIES.join(" or ")}`);
  return policy as DraftPatchPolicyName;
}

/**
 * Which change of a patch (1-based, counted across all its notes, in the order given) is the first whose
 * application makes `fails` true of the note's text, or null when none alone does. A refusal's reason names it,
 * so a patch of six changes reads as one edit with one change at fault.
 */
function blame(edits: readonly DraftPatchEdit[], edit: DraftPatchEdit, text: string, fails: (after: string) => boolean): number | null {
  let offset = 0;
  for (const other of edits) {
    if (other === edit) break;
    offset += other.patches.length;
  }
  for (let count = 1; count <= edit.patches.length; count += 1) {
    const located = locateSpans(text, edit.patches.slice(0, count));
    if (!located.ok) return null;
    if (fails(applyLocated(text, located.spans))) return offset + count;
  }
  return null;
}

/** A reason that says "it would …" said of one change, when the patch has more than one. */
function blamed(reason: string, change: number | null, total: number): string {
  return change !== null && total > 1 ? reason.replace(/^it would /, `change ${change} would `) : reason;
}

function normalizeMutation(mutation: MutationProvenance | undefined): MutationProvenance {
  if (!mutation || (mutation.author !== "agent" && mutation.author !== "user")) {
    throw new Error("A patch names who proposes it: mutation { author: agent, actorId }");
  }
  if (mutation.author === "agent" && !mutation.actorId?.trim()) throw new Error("An agent's patch names its actorId");
  return mutation;
}

export class DraftPatchRouter {
  constructor(private readonly deps: DraftPatchRouterDeps) {}

  private holderOf(blockId: string): DraftHold | null {
    return this.deps.holds.holderOf(blockId, clientId => this.deps.isLive(clientId));
  }

  /**
   * Where a note's part goes: the one door holding a live draft of it, the saved note when none does, or
   * nowhere when more than one door does (the patch then fails into a proposal; nothing guesses).
   */
  private routeOf(blockId: string): { hold: DraftHold | null; many: boolean } {
    const holds = this.deps.holds.holdersOf(blockId, clientId => this.deps.isLive(clientId));
    return { hold: holds[0] ?? null, many: holds.length > 1 };
  }

  /** A note's text as the draft a door holds has it now, or as saved. */
  async read(blockId: string): Promise<{ blockId: string; route: DraftPatchRoute; text: string; revision: number; holder?: string }> {
    const saved = this.deps.store.requireActive(blockId);
    const hold = this.holderOf(blockId);
    if (hold) {
      try {
        const answer = await this.deps.ask(hold, { kind: "read" });
        if ("text" in answer && typeof answer.text === "string") {
          return { blockId, route: "draft", text: answer.text, revision: answer.revision, holder: hold.clientId };
        }
      } catch {
        // The door stopped answering: its hold is gone, and the saved note is the truth.
      }
    }
    return { blockId, route: "saved", text: saved.text, revision: saved.revision };
  }

  async patch(input: DraftPatchInput): Promise<DraftPatchResult> {
    const edits = normalizeDraftPatchEdits(input);
    const mutation = normalizeMutation(input.mutation);
    const policy = normalizePolicy(input.policy);
    const allowStructural = input.allowStructural === true;
    const mark = input.mark?.text?.trim() ? { text: input.mark.text, blockId: input.mark.blockId?.trim() || edits[0]!.blockId } : undefined;
    for (const edit of edits) this.deps.store.requireActive(edit.blockId);
    if (mark) this.deps.store.requireActive(mark.blockId);
    const sent = { policy, ...(allowStructural ? { allowStructural } : {}) };
    if (policy === "prose") {
      const total = proposalChanges({ edits });
      let change = 0;
      for (const edit of edits) {
        for (const span of edit.patches) {
          change += 1;
          const reason = draftPatchPolicy(span, anchor => this.inboundLinks(edit.blockId, anchor));
          if (reason) return this.propose(blamed(reason, change, total), edits, mutation, mark, sent);
        }
      }
    }
    const outcome = await this.run(edits, { mutation, mark, ...sent });
    if (outcome.ok) return { outcome: "applied", edits: outcome.applied };
    if (outcome.refused) throw new DraftPatchRefusal(outcome.reason);
    return this.propose(outcome.reason, edits, mutation, mark, sent);
  }

  /** "Apply anyway": the proposal's patch, placed as well as it can be, as an ordinary edit by `mutation`. */
  async applyProposal(proposalId: string, mutation: MutationProvenance): Promise<DraftPatchApplied & { proposalId: string }> {
    const block = this.deps.store.requireActive(proposalId);
    const proposal = parseProposal(block.text);
    if (!proposal || !block.properties.some(property => property.key === "type" && property.value === DRAFT_PROPOSAL_TYPE)) {
      throw new Error("This block isn't a draft proposal");
    }
    if (block.properties.some(property => property.key === "proposal-status" && property.value === "applied")) {
      throw new Error("This proposal was already applied");
    }
    if (!proposalShowsPatch(block.text, proposal)) {
      throw new Error("This proposal's text no longer shows the patch it holds; it isn't applied");
    }
    const who = normalizeMutation(mutation);
    const edits = normalizeDraftPatchEdits({ edits: proposal.edits });
    // "Apply anyway" is the person's choice. An agent's is held to the same compare as a patch, under the
    // patch's own policy (a proposal from before policies was prose), above the mark and the person's cursor,
    // against the text as it is now (it can't force its own proposal).
    const forced = who.author !== "agent";
    const policy: DraftPatchPolicyName = proposal.policy === "edit" ? "edit" : "prose";
    const allowStructural = policy === "edit" && proposal.allowStructural === true;
    let mark: { text: string; blockId: string } | undefined;
    if (!forced) {
      if (policy === "prose") {
        for (const edit of edits) {
          for (const span of edit.patches) {
            const reason = draftPatchPolicy(span);
            if (reason) throw new Error(`Couldn't apply it: ${reason}; only the person applies that anyway`);
          }
        }
      }
      const kept = proposal.mark;
      if (kept && typeof kept.text === "string" && kept.text.trim()) {
        mark = { text: kept.text, blockId: typeof kept.blockId === "string" && kept.blockId.trim() ? kept.blockId.trim() : edits[0]!.blockId };
      }
    }
    const outcome = await this.run(edits, forced
      ? { mutation: who, force: true, policy }
      : { mutation: who, current: true, policy, ...(allowStructural ? { allowStructural } : {}), ...(mark ? { mark } : {}) });
    if (!outcome.ok) throw new Error(`Couldn't apply it: ${outcome.reason}${outcome.refused ? "; only the person applies that anyway" : ""}`);
    const current = this.deps.store.require(proposalId);
    try {
      this.deps.store.update(proposalId, withProposalApplied(current.text), current.revision, who);
    } catch {
      // The edit landed; the proposal's status is only a note about it.
    }
    return { outcome: "applied", edits: outcome.applied, proposalId };
  }

  /** How many notes link to `^anchor` in `blockId`. */
  private inboundLinks(blockId: string, anchor: string): number {
    try {
      const sources = this.deps.store.queryBacklinks({ targetBlockId: blockId, limit: 200 }).sources;
      return sources.filter(source => this.deps.store.get(source.blockId)?.text.includes(`^${anchor}`)).length;
    } catch {
      return 0;
    }
  }

  /**
   * Check every note, patch the drafts, then write the saved notes together.
   * Any failure reverts what was patched and says why.
   */
  private async run(edits: DraftPatchEdit[], options: RunOptions): Promise<Outcome> {
    const { store } = this.deps;
    const plan = edits.map(edit => ({ edit, ...this.routeOf(edit.blockId) }));
    const crowded = plan.find(part => part.many);
    if (crowded) return { ok: false, reason: "more than one door holds a live draft of the note; which one is being typed in isn't clear" };
    // Saved notes first: nothing is written until every part has passed. The text the policy passed is the
    // text the write below must still find.
    const checked = new Map<string, string>();
    for (const { edit, hold } of plan) {
      if (hold) continue;
      const failure = this.checkSaved(edit, options);
      if (failure) return { ok: false, reason: failure };
      if (options.force) continue;
      const text = this.deps.store.requireActive(edit.blockId).text;
      const refusal = await this.policyFailure(edits, edit, text, options);
      if (refusal) return refusal;
      checked.set(edit.blockId, text);
    }
    // Drafts next, read but not yet touched: the policy is checked over the whole note as typed.
    if (!options.force) {
      for (const { edit, hold } of plan) {
        if (!hold) continue;
        let answer: DraftHolderAnswer;
        try {
          answer = await this.deps.ask(hold, { kind: "read" });
        } catch (error) {
          return { ok: false, reason: `the door holding its draft didn't answer (${error instanceof Error ? error.message : String(error)})` };
        }
        if (!("text" in answer) || typeof answer.text !== "string") return { ok: false, reason: "the door holding its draft didn't say what it holds" };
        const located = locateSpans(answer.text, edit.patches);
        if (!located.ok) return { ok: false, reason: located.reason };
        const refusal = await this.policyFailure(edits, edit, answer.text, options);
        if (refusal) return refusal;
      }
    }
    const patched: Array<{ hold: DraftHold; patchId: string }> = [];
    const applied: DraftPatchApplied["edits"] = [];
    const undo = async () => {
      for (const { hold, patchId } of patched.reverse()) {
        await this.deps.ask(hold, { kind: "revert", patchId }).catch(() => undefined);
      }
    };
    for (const { edit, hold } of plan) {
      if (!hold) continue;
      const patchId = crypto.randomUUID();
      let answer: DraftHolderAnswer;
      try {
        answer = await this.deps.ask(hold, {
          kind: "patch", patchId, revision: options.force || options.current ? hold.revision : edit.revision, patches: edit.patches,
          mutation: options.mutation,
          ...(options.mark && options.mark.blockId === edit.blockId && !options.force ? { mark: options.mark.text } : {}),
          ...(options.force ? { force: true } : {}),
        });
      } catch (error) {
        // A slow door may still apply it after the service stopped waiting: take it back there too.
        void this.deps.ask(hold, { kind: "revert", patchId }).catch(() => undefined);
        await undo();
        return { ok: false, reason: `the door holding its draft didn't answer (${error instanceof Error ? error.message : String(error)})` };
      }
      if (!("applied" in answer) || !answer.applied) {
        await undo();
        return { ok: false, reason: "reason" in answer && answer.reason ? answer.reason : "the draft refused it" };
      }
      patched.push({ hold, patchId });
      applied.push({ blockId: edit.blockId, route: "draft", holder: hold.clientId });
    }
    const saved = plan.filter(part => !part.hold);
    try {
      const written = store.database.transaction(() => saved.map(({ edit }) => {
        const failure = this.checkSaved(edit, options);
        if (failure) throw new Error(failure);
        const block = store.requireActive(edit.blockId);
        if (!options.force && block.text !== checked.get(edit.blockId)) throw new Error("the note changed while the patch was being checked");
        const located = locateSpans(block.text, edit.patches, options.force);
        if (!located.ok) throw new Error(located.reason);
        return store.update(edit.blockId, applyLocated(block.text, located.spans), block.revision, options.mutation);
      }))();
      for (const block of written) applied.push({ blockId: block.id, route: "saved", revision: block.revision });
    } catch (error) {
      await undo();
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    const order = new Map(edits.map((edit, index) => [edit.blockId, index]));
    applied.sort((left, right) => order.get(left.blockId)! - order.get(right.blockId)!);
    return { ok: true, applied };
  }

  /** Why a saved note's part can't apply now, or null. */
  private checkSaved(edit: DraftPatchEdit, options: RunOptions): string | null {
    const block = this.deps.store.get(edit.blockId);
    if (!block || block.effectiveDeletedRootId) return "the note is gone or in the Trash";
    if (!options.force && !options.current && block.revision !== edit.revision) {
      return `the note was saved since it was read (revision ${edit.revision}, now ${block.revision})`;
    }
    const located = locateSpans(block.text, edit.patches, options.force);
    if (!located.ok) return located.reason;
    if (options.mark && options.mark.blockId === edit.blockId && !options.force) {
      const at = markStart(block.text, options.mark.text);
      if (at < 0) return "the mark isn't in the note";
      if (located.spans.some(span => span.end > at)) return "it reaches the mark or below it; a patch changes only text above the mark";
    }
    return null;
  }

  /**
   * Whether the patch's part for one note, applied to `text` (the note as saved, or the draft as typed), passes
   * the patch's policy. `edit`: the guard every agent edit has, `droppedLinkedStructure` (unless
   * `allowStructural`), and a refusal is final, never a proposal. `prose`: every structural token kept, and a
   * refusal becomes a proposal. Null when it passes.
   */
  private async policyFailure(edits: DraftPatchEdit[], edit: DraftPatchEdit, text: string, options: RunOptions): Promise<Extract<Outcome, { ok: false }> | null> {
    if (options.force) return null;
    const located = locateSpans(text, edit.patches);
    if (!located.ok) return { ok: false, reason: located.reason };
    const after = applyLocated(text, located.spans);
    const total = proposalChanges({ edits });
    if (options.policy === "prose") {
      const reason = draftPatchTextPolicy(text, after);
      if (!reason) return null;
      return { ok: false, reason: blamed(reason, blame(edits, edit, text, next => draftPatchTextPolicy(text, next) !== null), total) };
    }
    if (options.allowStructural) return null;
    const lost = await droppedLinkedStructure(this.deps.client, edit.blockId, text, after);
    if (!lost.length) return null;
    // Which change drops one of them: the first whose application loses a page or an anchor named here.
    const named = (token: string) => lost.some(entry => entry === token || entry.startsWith(`${token} (`));
    const change = blame(edits, edit, text, next => {
      const dropped = droppedStructure(text, next);
      return dropped.pages.some(named) || dropped.anchors.some(anchor => named(`^${anchor}`));
    });
    return {
      ok: false,
      refused: true,
      reason: blamed(`it would drop ${lost.join(", ")}; keep ${lost.length === 1 ? "it" : "them"}, or pass allowStructural: true if removing ${lost.length === 1 ? "it" : "them"} is the point`, change, total),
    };
  }

  /** The patch as a reply block, embedded under the mark (or at the note's end), attributed to its proposer. */
  private async propose(
    reason: string, edits: DraftPatchEdit[], mutation: MutationProvenance, mark: { text: string; blockId: string } | undefined,
    sent: { policy: DraftPatchPolicyName; allowStructural?: boolean },
  ): Promise<DraftPatchProposed> {
    const { store } = this.deps;
    const hostId = mark?.blockId ?? edits[0]!.blockId;
    const kept: DraftPatchEdit[] = [];
    for (const edit of edits) {
      // Keep the text around each span as it is now, so "apply anyway" can place it after the span changes.
      const text = (await this.read(edit.blockId).catch(() => null))?.text ?? store.get(edit.blockId)?.text ?? "";
      kept.push({
        ...edit,
        patches: edit.patches.map(span => {
          if (span.before !== undefined && span.after !== undefined) return span;
          const at = locateSpanForced(text, span);
          return "reason" in at ? span : { ...span, ...spanContext(text, at.start, at.end) };
        }),
      });
    }
    const proposal: DraftProposal = {
      version: 1, edits: kept, reason, ...sent,
      ...(mark ? { mark } : {}),
      actor: { author: mutation.author, ...(mutation.actorId ? { actorId: mutation.actorId } : {}) },
    };
    const names = (blockId: string) => {
      const block = store.get(blockId);
      return block ? blockDisplayTitle(block) : blockId;
    };
    const created = mutation.author === "agent"
      ? store.create(proposalText(proposal, names), hostId, "agent", { actorId: mutation.actorId!, ...(mutation.sessionId ? { sessionId: mutation.sessionId } : {}) })
      : store.create(proposalText(proposal, names), hostId, "user");
    const line = embedLine(created.id);
    let embedded: DraftPatchRoute | null = null;
    const { hold, many } = this.routeOf(hostId);
    if (many) {
      // Several doors hold drafts of it: the proposal stays a reply under the note, and no draft or saved text changes.
    } else if (hold) {
      const answer = await this.deps.ask(hold, { kind: "embed", line, ...(mark ? { mark: mark.text } : {}), mutation }).catch(() => null);
      if (answer && "applied" in answer && answer.applied) embedded = "draft";
      // A draft that didn't take it keeps its note: writing the saved note under it would refuse the person's save.
    } else {
      const block = store.get(hostId);
      if (block && !block.effectiveDeletedRootId) {
        try {
          store.update(hostId, insertAfterMark(block.text, line, mark?.text), block.revision, mutation);
          embedded = "saved";
        } catch {
          // Saved by someone else meanwhile: the proposal stays a reply under the note.
        }
      }
    }
    return { outcome: "proposed", reason, proposalId: created.id, embedded, embeddedIn: hostId };
  }
}

export type { DraftHolderRequest };
