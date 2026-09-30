/**
 * `draft.patch` (PIE-501): compare-and-swap on a span of a note's text, by an
 * agent, while the person may be typing in the same note.
 *
 * - compare: the observed text and the revision it was read at (the range is a
 *   hint; `src/draft-patch-compare.ts`, which the door copies, finds it);
 * - swap: the replacement, attributed to the agent;
 * - policy: when a compare that succeeds may apply (`draftPatchPolicy`): prose
 *   only, every structural token in the span kept, the span above the mark;
 * - failure: the proposal lands as a reply block embedded under the mark or the
 *   note (`proposalText`), and "apply anyway" applies it as an ordinary edit.
 *
 * Routing is the service's: a door that holds a live draft of the note
 * (`DraftHolds`, a lease it renews) gets the patch; with none, the saved block
 * is patched under a revision check. This file owns the grammar checks and the
 * holds; `src/server.ts` routes.
 */
import { fragmentAnchors } from "./fragments";
import { pageAddressReferences } from "./page-addresses";
import { parsePropertyRecords } from "./properties";
import { blockReferenceOccurrences } from "./references";
import type { DraftPatchSpan } from "./draft-patch-compare";
import type { MutationProvenance } from "./types";

/** A door's lease on the live draft it holds, when it doesn't say (ms). */
export const DRAFT_HOLD_DEFAULT_LEASE_MS = 15_000;
export const DRAFT_HOLD_MIN_LEASE_MS = 1_000;
export const DRAFT_HOLD_MAX_LEASE_MS = 120_000;
/** How long the service waits for a holding door to answer before it counts the hold as gone. */
export const DRAFT_HOLDER_TIMEOUT_MS = 2_500;

/** One note's part of a patch. */
export interface DraftPatchEdit {
  blockId: string;
  /** The saved revision the observed text was read at (`drafts.read` or `get`). */
  revision: number;
  patches: DraftPatchSpan[];
}

/**
 * The request. One note (`blockId`, `revision`, `patches`) or several
 * (`edits`), which apply together or not at all.
 */
export interface DraftPatchInput {
  blockId?: string;
  revision?: number;
  patches?: DraftPatchSpan[];
  edits?: DraftPatchEdit[];
  /** Who proposes it: an agent, with its actor id. */
  mutation: MutationProvenance;
  /**
   * The mark: the `@request` line a span must end above (its text, as a line of
   * the note), and the note it is in (default the first edit's). Without one, a
   * live draft uses the start of the person's cursor's block.
   */
  mark?: { text: string; blockId?: string };
}

export type DraftPatchRoute = "draft" | "saved";

export interface DraftPatchApplied {
  outcome: "applied";
  edits: Array<{ blockId: string; route: DraftPatchRoute; revision?: number; holder?: string }>;
}

export interface DraftPatchProposed {
  outcome: "proposed";
  /** Why it didn't apply, in words. */
  reason: string;
  /** The reply block holding the proposal. */
  proposalId: string;
  /** Where its embed line went: into a live draft, the saved note, or nowhere (the note changed under it). */
  embedded: DraftPatchRoute | null;
  embeddedIn: string;
}

export type DraftPatchResult = DraftPatchApplied | DraftPatchProposed;

/** What the service asks the door holding a draft; the door answers with `drafts.answer`. */
export type DraftHolderRequest =
  | { kind: "read"; requestId: string; holdId: string; blockId: string; targetClientId: string }
  | {
      kind: "patch"; requestId: string; holdId: string; blockId: string; targetClientId: string;
      patchId: string; revision: number; patches: DraftPatchSpan[]; mutation: MutationProvenance;
      mark?: string; force?: boolean;
    }
  | { kind: "revert"; requestId: string; holdId: string; blockId: string; targetClientId: string; patchId: string }
  | {
      kind: "embed"; requestId: string; holdId: string; blockId: string; targetClientId: string;
      line: string; mark?: string; mutation: MutationProvenance;
    };

export type DraftHolderAnswer =
  | { text: string; revision: number }
  | { applied: true }
  | { applied: false; reason: string }
  | { reverted: boolean };

// ── the policy ───────────────────────────────────────────────────────────────

/** The structural tokens of a span of text, each as one comparable string. */
export function structuralTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const anchor of fragmentAnchors(text)) tokens.push(`^${anchor.id}`);
  for (const reference of blockReferenceOccurrences(text)) {
    tokens.push(text.slice(reference.start, reference.end));
  }
  for (const page of pageAddressReferences(text)) tokens.push(text.slice(page.start, page.end));
  for (const property of parsePropertyRecords(text)) tokens.push(property.raw);
  return tokens.sort();
}

function missingFrom(from: readonly string[], within: readonly string[]): string[] {
  const left = new Map<string, number>();
  for (const token of within) left.set(token, (left.get(token) ?? 0) + 1);
  const missing: string[] = [];
  for (const token of from) {
    const n = left.get(token) ?? 0;
    if (n > 0) left.set(token, n - 1);
    else missing.push(token);
  }
  return missing;
}

/**
 * The first policy (a check, not part of the patch's shape): a prose edit keeps
 * every `^anchor`, `[[page]]`, `((block))` and `[key::value]` of its span, and adds
 * none. `inbound(anchor)` says how many notes link to an anchor, for the reason.
 * Null when the span may apply.
 */
export function draftPatchPolicy(span: DraftPatchSpan, inbound: (anchorId: string) => number = () => 0): string | null {
  const before = structuralTokens(span.observed);
  const after = structuralTokens(span.replacement);
  const dropped = missingFrom(before, after);
  if (dropped.length) {
    const anchor = dropped.find(token => token.startsWith("^"));
    const links = anchor ? inbound(anchor.slice(1)) : 0;
    return `it would drop ${dropped.join(", ")}${links ? ` (${links} ${links === 1 ? "note links" : "notes link"} to ${anchor})` : ""}; a prose edit keeps them`;
  }
  const added = missingFrom(after, before);
  if (added.length) return `it would add ${added.join(", ")}; a prose edit adds no links, anchors or properties`;
  return null;
}

/**
 * The same policy over a whole note: its text before and after every span of the patch keeps the same
 * structural tokens. The per-span check can't see a span that edits inside a token (`[[Seed list]]` with
 * `Seed` as its observed text), or one that opens a code span whose closing backtick is further on and so
 * turns a `[key::value]` after it into code; this does. Null when the note may change.
 */
export function draftPatchTextPolicy(before: string, after: string): string | null {
  const was = structuralTokens(before);
  const now = structuralTokens(after);
  const dropped = missingFrom(was, now);
  if (dropped.length) return `it would change or drop ${dropped.join(", ")} in the note; a prose edit keeps them`;
  const added = missingFrom(now, was);
  if (added.length) return `it would add ${added.join(", ")} to the note; a prose edit adds no links, anchors or properties`;
  return null;
}

/**
 * What a whole-text edit (an agent's `outline_edit`, not a prose patch) would take away that others rely on:
 * the `[page::…]` properties that register the note's page addresses, and its `^anchors` (the caller asks how
 * many notes link to each; one nobody links to may go). Links, other properties and additions are the edit's
 * business: unlike `draftPatchTextPolicy`, this is not a prose-only rule.
 */
export function droppedStructure(before: string, after: string): { pages: string[]; anchors: string[] } {
  const pages = (text: string) => parsePropertyRecords(text).filter(property => property.key === "page").map(property => property.raw);
  const anchors = (text: string) => fragmentAnchors(text).map(anchor => anchor.id);
  return { pages: missingFrom(pages(before), pages(after)), anchors: [...new Set(missingFrom(anchors(before), anchors(after)))] };
}

// ── holds: which door has a live draft of which note ────────────────────────

export interface DraftHold {
  holdId: string;
  blockId: string;
  clientId: string;
  /** The saved revision the draft started from. */
  revision: number;
  leaseMs: number;
  expiresAt: number;
  renewedAt: number;
}

/**
 * The live drafts doors hold, each on a lease the door renews
 * (`drafts.heartbeat`). A lease that runs out, a door that disconnects or one
 * that stops answering loses its hold, and patches go to the saved block again.
 */
export class DraftHolds {
  private readonly holds = new Map<string, DraftHold>();
  constructor(private readonly now: () => number = Date.now) {}

  hold(blockId: string, clientId: string, revision: number, leaseMs = DRAFT_HOLD_DEFAULT_LEASE_MS): DraftHold {
    if (!blockId?.trim()) throw new Error("A draft hold needs a blockId");
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("A draft hold needs the positive integer revision its draft started from");
    if (!Number.isFinite(leaseMs) || leaseMs < DRAFT_HOLD_MIN_LEASE_MS || leaseMs > DRAFT_HOLD_MAX_LEASE_MS) {
      throw new Error(`A draft hold's lease is ${DRAFT_HOLD_MIN_LEASE_MS}-${DRAFT_HOLD_MAX_LEASE_MS} ms`);
    }
    // One hold per door and note: holding again replaces it.
    for (const [id, existing] of this.holds) {
      if (existing.blockId === blockId && existing.clientId === clientId) this.holds.delete(id);
    }
    const at = this.now();
    const hold: DraftHold = { holdId: crypto.randomUUID(), blockId, clientId, revision, leaseMs, expiresAt: at + leaseMs, renewedAt: at };
    this.holds.set(hold.holdId, hold);
    return { ...hold };
  }

  heartbeat(holdId: string, revision?: number): DraftHold {
    this.expire();
    const hold = this.holds.get(holdId);
    if (!hold) throw new Error("This draft hold has expired or was released; hold the draft again");
    if (revision !== undefined) {
      if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("A draft hold's revision is a positive integer");
      hold.revision = revision;
    }
    hold.renewedAt = this.now();
    hold.expiresAt = hold.renewedAt + hold.leaseMs;
    return { ...hold };
  }

  release(holdId: string): boolean {
    return this.holds.delete(holdId);
  }

  releaseClient(clientId: string): void {
    for (const [id, hold] of this.holds) if (hold.clientId === clientId) this.holds.delete(id);
  }

  /** The door to route a note's patch to: the most recently renewed live hold, if any. */
  holderOf(blockId: string, live: (clientId: string) => boolean): DraftHold | null {
    return this.holdersOf(blockId, live)[0] ?? null;
  }

  /**
   * Every live hold on a note, most recently renewed first. More than one door can hold a draft of the same
   * note; a patch then goes to none of them (which one the person is typing in isn't the service's to guess).
   */
  holdersOf(blockId: string, live: (clientId: string) => boolean): DraftHold[] {
    this.expire();
    const found: DraftHold[] = [];
    for (const hold of this.holds.values()) {
      if (hold.blockId !== blockId) continue;
      if (!live(hold.clientId)) { this.holds.delete(hold.holdId); continue; }
      found.push({ ...hold });
    }
    return found.sort((left, right) => right.renewedAt - left.renewedAt);
  }

  has(holdId: string): boolean {
    this.expire();
    return this.holds.has(holdId);
  }

  list(): DraftHold[] {
    this.expire();
    return [...this.holds.values()].map(hold => ({ ...hold }));
  }

  private expire(): void {
    const at = this.now();
    for (const [id, hold] of this.holds) if (hold.expiresAt <= at) this.holds.delete(id);
  }
}

// ── the proposal: a reply block holding a patch that didn't apply ────────────

export const DRAFT_PROPOSAL_TYPE = "draft-proposal";

/**
 * The most a proposal's hidden `[draft-patch::…]` line may hold (bytes of base64url). A patch too big to keep
 * as a proposal is refused with an error instead, so the agent still has its text and nothing is written.
 */
export const DRAFT_PROPOSAL_MAX_PAYLOAD = 256 * 1024;

export interface DraftProposal {
  version: 1;
  edits: DraftPatchEdit[];
  mark?: { text: string; blockId?: string };
  reason: string;
  actor: { author: MutationProvenance["author"]; actorId?: string };
}

/** A code fence that no run of backticks in `text` can close. */
function fenceFor(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map(match => match[0].length));
  return "`".repeat(longest + 1);
}

/** A note's title as a reference label: one line, no characters that could end the reference. */
function labelOf(title: string): string {
  const label = title.replace(/[()|\[\]\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  return label || "a note";
}

/**
 * The reply block's text: who proposed what, why it didn't apply, what it
 * would change (fenced, so its links stay text), and the patch itself as a
 * metadata property (`[draft-patch::…]`, base64url JSON: inert, and hidden by
 * readers like any metadata line).
 */
export function proposalText(proposal: DraftProposal, names: (blockId: string) => string = id => id): string {
  const payload = Buffer.from(JSON.stringify(proposal), "utf8").toString("base64url");
  if (payload.length > DRAFT_PROPOSAL_MAX_PAYLOAD) {
    throw new Error(`The patch is too large to keep as a proposal (${Math.ceil(payload.length / 1024)} KB of the ${DRAFT_PROPOSAL_MAX_PAYLOAD / 1024} KB a proposal holds); nothing was changed. Patch a smaller passage`);
  }
  const who = proposal.actor.actorId ? `@${proposal.actor.actorId}` : proposal.actor.author === "agent" ? "an agent" : "someone";
  const targets = [...new Set(proposal.edits.map(edit => edit.blockId))].map(id => `((${id}|${labelOf(names(id))}))`).join(", ");
  const lines = [
    `Proposed edit from ${who}: not applied, ${proposal.reason} [type::${DRAFT_PROPOSAL_TYPE}] [proposal-status::open]`,
    `[draft-patch::${payload}]`,
    `To ${targets}. A applies it anyway, as an ordinary edit.`,
  ];
  for (const edit of proposal.edits) {
    for (const [index, span] of edit.patches.entries()) {
      lines.push("", `In ${labelOf(names(edit.blockId))}${edit.patches.length > 1 ? ` (${index + 1} of ${edit.patches.length})` : ""}, this:`,
        ...shownSpan(span));
    }
  }
  return lines.join("\n");
}

/** How a proposal shows one span: the passage and what it becomes, each fenced. */
function shownSpan(span: DraftPatchSpan): string[] {
  const fence = fenceFor(span.observed + span.replacement);
  return [fence, span.observed, fence, "becomes:", fence, span.replacement, fence];
}

/**
 * Whether a proposal block still shows the patch it holds: every span's passage and replacement, fenced as
 * `proposalText` wrote them. "Apply anyway" applies only what the person can read in the proposal, never a
 * hidden payload that says something else.
 */
export function proposalShowsPatch(text: string, proposal: DraftProposal): boolean {
  return proposal.edits.every(edit => Array.isArray(edit.patches) && edit.patches.every(span =>
    typeof span?.observed === "string" && typeof span.replacement === "string" && text.includes(`\n${shownSpan(span).join("\n")}`)));
}

/** The patch a proposal block holds, or null when the block isn't one. */
export function parseProposal(text: string): DraftProposal | null {
  const match = /\[draft-patch::([A-Za-z0-9_-]+)\]/.exec(text);
  if (!match) return null;
  try {
    const proposal = JSON.parse(Buffer.from(match[1]!, "base64url").toString("utf8")) as DraftProposal;
    return proposal?.version === 1 && Array.isArray(proposal.edits) ? proposal : null;
  } catch {
    return null;
  }
}

/** The proposal's status token, after "apply anyway" or a refusal. */
export function withProposalStatus(text: string, status: "open" | "applied"): string {
  const title = status === "applied"
    ? text.replace(/^Proposed edit from (.*?): not applied, /, "Applied anyway: edit from $1, which didn't apply at first: ")
    : text.replace(/^Applied anyway: edit from (.*?), which didn't apply at first: /, "Proposed edit from $1: not applied, ");
  return title.replace(/\[proposal-status::[a-z-]+\]/, `[proposal-status::${status}]`);
}

/** The embed line a proposal gets under the mark or at the end of the note. */
export function embedLine(proposalId: string): string {
  return `!((${proposalId}))`;
}

/**
 * `text` with `line` inserted after the mark line (the first line whose text,
 * trimmed, is the mark), or at the end when there is no mark or it isn't there.
 */
export function insertAfterMark(text: string, line: string, mark?: string): string {
  const lines = text.split("\n");
  const wanted = mark?.trim();
  const at = wanted ? lines.findIndex(candidate => candidate.trim() === wanted) : -1;
  if (at >= 0) {
    lines.splice(at + 1, 0, line);
    return lines.join("\n");
  }
  return text.endsWith("\n") || !text ? `${text}${line}` : `${text}\n${line}`;
}
