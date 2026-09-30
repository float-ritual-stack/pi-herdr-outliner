/**
 * Where a `draft.patch` goes (PIE-501). Routing is the service's job, not the
 * agent's: a note a door holds a live draft of is patched in that draft (the
 * door runs the compare against its buffer), any other is patched as saved,
 * under a revision check. Several notes apply together or not at all: every
 * part is checked, the drafts are patched, then the saved notes are written in
 * one transaction; a failure anywhere reverts the drafts already patched and
 * the whole patch lands as a proposal instead.
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
  DRAFT_PROPOSAL_TYPE,
  draftPatchPolicy,
  embedLine,
  insertAfterMark,
  parseProposal,
  proposalText,
  withProposalStatus,
  type DraftHold,
  type DraftHolderAnswer,
  type DraftHolderRequest,
  type DraftHolds,
  type DraftPatchApplied,
  type DraftPatchEdit,
  type DraftPatchInput,
  type DraftPatchProposed,
  type DraftPatchResult,
  type DraftPatchRoute,
  type DraftProposal,
} from "./draft-patch";
import { blockDisplayTitle } from "./references";
import type { OutlinerStore } from "./store";
import type { MutationProvenance } from "./types";

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
}

type Outcome = { ok: true; applied: DraftPatchApplied["edits"] } | { ok: false; reason: string };

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
    const mark = input.mark?.text?.trim() ? { text: input.mark.text, blockId: input.mark.blockId?.trim() || edits[0]!.blockId } : undefined;
    for (const edit of edits) this.deps.store.requireActive(edit.blockId);
    if (mark) this.deps.store.requireActive(mark.blockId);
    for (const edit of edits) {
      for (const span of edit.patches) {
        const reason = draftPatchPolicy(span, anchor => this.inboundLinks(edit.blockId, anchor));
        if (reason) return this.propose(reason, edits, mutation, mark);
      }
    }
    const outcome = await this.run(edits, { mutation, mark });
    if (outcome.ok) return { outcome: "applied", edits: outcome.applied };
    return this.propose(outcome.reason, edits, mutation, mark);
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
    const who = normalizeMutation(mutation);
    const edits = normalizeDraftPatchEdits({ edits: proposal.edits });
    const outcome = await this.run(edits, { mutation: who, force: true });
    if (!outcome.ok) throw new Error(`Couldn't apply it: ${outcome.reason}`);
    const current = this.deps.store.require(proposalId);
    try {
      this.deps.store.update(proposalId, withProposalStatus(current.text, "applied"), current.revision, who);
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
  private async run(edits: DraftPatchEdit[], options: { mutation: MutationProvenance; mark?: { text: string; blockId: string }; force?: boolean }): Promise<Outcome> {
    const { store } = this.deps;
    const plan = edits.map(edit => ({ edit, hold: this.holderOf(edit.blockId) }));
    // Saved notes first: nothing is written until every part has passed.
    for (const { edit, hold } of plan) {
      if (hold) continue;
      const failure = this.checkSaved(edit, options);
      if (failure) return { ok: false, reason: failure };
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
          kind: "patch", patchId, revision: options.force ? hold.revision : edit.revision, patches: edit.patches,
          mutation: options.mutation,
          ...(options.mark && options.mark.blockId === edit.blockId && !options.force ? { mark: options.mark.text } : {}),
          ...(options.force ? { force: true } : {}),
        });
      } catch (error) {
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
  private checkSaved(edit: DraftPatchEdit, options: { mark?: { text: string; blockId: string }; force?: boolean }): string | null {
    const block = this.deps.store.get(edit.blockId);
    if (!block || block.effectiveDeletedRootId) return "the note is gone or in the Trash";
    if (!options.force && block.revision !== edit.revision) {
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

  /** The patch as a reply block, embedded under the mark (or at the note's end), attributed to its proposer. */
  private async propose(reason: string, edits: DraftPatchEdit[], mutation: MutationProvenance, mark?: { text: string; blockId: string }): Promise<DraftPatchProposed> {
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
      version: 1, edits: kept, reason,
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
    const hold = this.holderOf(hostId);
    if (hold) {
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
