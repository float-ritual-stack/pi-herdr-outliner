/**
 * `draft.patch` (PIE-501): compare-and-swap on a span of a note's text, by an
 * agent, while the person may be typing in the same note.
 *
 * - compare: the observed text and the revision it was read at (the range is a
 *   hint; `src/draft-patch-compare.ts`, which the door copies, finds it);
 * - swap: the replacement, attributed to the agent;
 * - policy: when a compare that succeeds may apply. `edit` (the default) is the
 *   guard every agent edit has (`droppedLinkedStructure` in `src/work-tools.ts`):
 *   no dropped `[page::…]`, no dropped `^anchor` another note links to, unless
 *   `allowStructural`. `prose` (opt-in, for tidying text the person is typing)
 *   keeps every structural token (`draftPatchPolicy`, `draftPatchTextPolicy`).
 *   Either way the spans end above the mark;
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

/**
 * Which rule a patch that matches is held to. `edit`: the guard every agent edit has, so a dropped
 * `[[link]]` or `((ref))` is the edit's business, but a dropped `[page::…]` or a linked `^anchor` is
 * refused (unless `allowStructural`). `prose`: a tidy of the person's words keeps every structural token.
 */
export type DraftPatchPolicyName = "edit" | "prose";
export const DRAFT_PATCH_POLICIES: readonly DraftPatchPolicyName[] = ["edit", "prose"];

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
   * the note), and the note it is in (default the first edit's). Without one,
   * nothing limits where a span may be but the person's cursor: a live draft
   * refuses a span around it.
   */
  mark?: { text: string; blockId?: string };
  /** The rule a matching patch is held to; default `edit`. */
  policy?: DraftPatchPolicyName;
  /** Under the `edit` policy: dropping a `[page::…]` or a linked `^anchor` is the point. */
  allowStructural?: boolean;
  /**
   * Capability `draft.patch.current`: on a saved note, compare the spans (and
   * the mark) against the text as it is now instead of requiring `revision`:
   * a person typing elsewhere in the note doesn't turn the patch into a
   * proposal; typing in the passage still does. A live draft compares this way already.
   */
  current?: boolean;
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
/** The proposal a patch sent to a holding door settles: `apply` (apply anyway) or `dismiss` (its embed line out). */
export interface DraftHolderProposal { id: string; op: "apply" | "dismiss" }

export type DraftHolderRequest =
  | { kind: "read"; requestId: string; holdId: string; blockId: string; targetClientId: string }
  | {
      kind: "patch"; requestId: string; holdId: string; blockId: string; targetClientId: string;
      patchId: string; revision: number; patches: DraftPatchSpan[]; mutation: MutationProvenance;
      mark?: string; force?: boolean;
      /** Set when the patch applies or dismisses a proposal, so the door says which it was, not guessing from the patch. */
      proposal?: DraftHolderProposal;
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
  /** The rule the patch was sent under; a proposal without one predates `edit` and was `prose`. */
  policy?: DraftPatchPolicyName;
  allowStructural?: boolean;
}

/** How many changes (spans) a proposal holds, across its notes. */
export function proposalChanges(proposal: Pick<DraftProposal, "edits">): number {
  return proposal.edits.reduce((count, edit) => count + edit.patches.length, 0);
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
 * Where a proposal is in its life (`[proposal-status::…]`): `open` until the person (or its own agent)
 * applies it anyway (`applied`) or dismisses it (`dismissed`). Clients offer apply and dismiss on an `open`
 * one; `[proposal-applies::no]` beside it says the passage it changes was already gone when it was proposed
 * (or is at or below the mark, which a forced apply doesn't pass either), so only dismiss is offered (PIE-510).
 */
export type DraftProposalStatus = "open" | "applied" | "dismissed";

export const DRAFT_PROPOSAL_STATUSES: readonly DraftProposalStatus[] = ["open", "applied", "dismissed"];

/** The property a proposal carries, set to `no`, when its passage wasn't in the note when it was proposed, or was at or below the mark. */
export const DRAFT_PROPOSAL_APPLIES = "proposal-applies";

/**
 * A proposal's first line, from its patch and its status (never from the sentences already there): who
 * proposed it, why it didn't apply, what became of it. It names no client's keys; each client offers its
 * own controls by the status.
 */
function proposalHeader(proposal: DraftProposal, status: DraftProposalStatus, applies: boolean): string {
  const who = proposal.actor?.actorId ? `@${proposal.actor.actorId}` : proposal.actor?.author === "agent" ? "an agent" : "someone";
  const changes = proposalChanges(proposal);
  const count = changes > 1 ? ` (${changes} changes)` : "";
  const reason = typeof proposal.reason === "string" ? proposal.reason : "it couldn't be placed";
  const said = status === "applied"
    ? `Applied anyway: 1 edit${count} from ${who}, which didn't apply at first because ${reason}`
    : status === "dismissed"
      ? `Dismissed: 1 proposed edit${count} from ${who}, not applied because ${reason}`
      : `1 proposed edit${count} from ${who}: not applied, because ${reason}`;
  return `${said} [type::${DRAFT_PROPOSAL_TYPE}] [proposal-status::${status}]${applies ? "" : ` [${DRAFT_PROPOSAL_APPLIES}::no]`}`;
}

/**
 * The reply block's text: who proposed what, why it didn't apply, what it
 * would change (fenced, so its links stay text), and the patch itself as a
 * metadata property (`[draft-patch::…]`, base64url JSON: inert, and hidden by
 * readers like any metadata line). A patch is one proposal however many
 * changes it holds, applied whole or not at all, and its header says so:
 * `1 proposed edit (6 changes) from @agent: not applied, because change 1 would …`.
 * `applies: false`: its passage is already gone, so it can only be dismissed.
 */
export function proposalText(proposal: DraftProposal, names: (blockId: string) => string = id => id, options: { applies?: boolean } = {}): string {
  const payload = Buffer.from(JSON.stringify(proposal), "utf8").toString("base64url");
  if (payload.length > DRAFT_PROPOSAL_MAX_PAYLOAD) {
    throw new Error(`The patch is too large to keep as a proposal (${Math.ceil(payload.length / 1024)} KB of the ${DRAFT_PROPOSAL_MAX_PAYLOAD / 1024} KB a proposal holds); nothing was changed. Patch a smaller passage`);
  }
  const targets = [...new Set(proposal.edits.map(edit => edit.blockId))].map(id => `((${id}|${labelOf(names(id))}))`).join(", ");
  const changes = proposalChanges(proposal);
  const many = changes > 1;
  const lines = [
    proposalHeader(proposal, "open", options.applies !== false),
    `[draft-patch::${payload}]`,
    many ? `To ${targets}: one edit, its ${changes} changes applied together or not at all.` : `To ${targets}.`,
  ];
  let change = 0;
  for (const edit of proposal.edits) {
    for (const span of edit.patches) {
      change += 1;
      lines.push("", many ? `Change ${change} of ${changes}, in ${labelOf(names(edit.blockId))}: this` : `In ${labelOf(names(edit.blockId))}, this:`,
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

/** A proposal's status, from its properties: `open` when it names none this service knows. */
export function proposalStatus(properties: readonly { key: string; value: string }[]): DraftProposalStatus {
  const value = properties.find(property => property.key === "proposal-status")?.value;
  return DRAFT_PROPOSAL_STATUSES.includes(value as DraftProposalStatus) ? value as DraftProposalStatus : "open";
}

/**
 * A proposal's text with a new status. Its first line is written again from the patch it holds and the
 * status, so no sentence is matched; the person's own edits below it stay. A proposal from before PIE-510
 * said in its body what a door's key would do: that line is put the neutral way.
 */
export function withProposalStatus(text: string, status: DraftProposalStatus): string {
  const lines = text.split("\n");
  const proposal = parseProposal(text);
  if (proposal && lines[0]!.includes(`[type::${DRAFT_PROPOSAL_TYPE}]`)) {
    lines[0] = proposalHeader(proposal, status, !lines[0]!.includes(`[${DRAFT_PROPOSAL_APPLIES}::no]`));
  } else if (/\[proposal-status::[a-z-]+\]/.test(lines[0]!)) {
    lines[0] = lines[0]!.replace(/\[proposal-status::[a-z-]+\]/, `[proposal-status::${status}]`);
  } else {
    lines[0] = `${lines[0]} [proposal-status::${status}]`;
  }
  return lines.join("\n")
    .replace(/^(To .*?)\. A applies it anyway, as an ordinary edit\.$/m, "$1.")
    .replace(/^(To .*?: one edit, its \d+ changes applied together or not at all)\. A applies all of them anyway, as one ordinary edit\.$/m, "$1.");
}

/** The embed line a proposal gets under the mark or at the end of the note. */
export function embedLine(proposalId: string): string {
  return `!((${proposalId}))`;
}

/**
 * The span that takes a proposal's embed line out of `text`: the line with the line break before it (after
 * it, when it is the first line), or the embed alone when it shares its line with other text. Null when the
 * text doesn't have it.
 */
export function embedLineSpan(text: string, line: string): DraftPatchSpan | null {
  let start = 0;
  const lines = text.split("\n");
  for (const [index, candidate] of lines.entries()) {
    if (candidate.trim() === line) {
      const from = index > 0 ? start - 1 : start;
      const to = index > 0 ? start + candidate.length : Math.min(text.length, start + candidate.length + 1);
      return { observed: text.slice(from, to), replacement: "", range: { start: from, end: to }, unit: "utf16" };
    }
    start += candidate.length + 1;
  }
  const at = text.indexOf(line);
  return at < 0 ? null : { observed: line, replacement: "", range: { start: at, end: at + line.length }, unit: "utf16" };
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
