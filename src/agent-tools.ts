/**
 * Outline operations for agents (PIE-504): read, find, resolve, edit, create,
 * comment, reply, resolve a thread, recent changes and `draft.patch`. The CLI's
 * `agent` command runs them, and the Claude mod's `outline_*` tools call that
 * command, so an agent never hand-rolls a script around `list --subtree`,
 * `update` or a comment socket.
 *
 * Each one is the agent side of a service call the door and Detail already
 * make: the service keeps the rules (revisions, quote anchoring, the draft
 * patch policy, activity). These helpers name blocks explicitly, always return
 * full text, attribute every write to the agent that asked, and answer compact
 * JSON. The refusals they add are the ones an agent's script got wrong: an
 * empty write, a stale revision, and an edit that drops a `[page::…]` or an
 * anchor other notes link to.
 */
import { randomUUID } from "node:crypto";
import { createBlockComment } from "./block-comments";
import { parsePropertyFilterClause } from "./block-query";
import { DRAFT_PATCH_POLICIES, droppedStructure, type DraftPatchPolicyName, type DraftPatchResult } from "./draft-patch";
import type { DraftPatchSpan } from "./draft-patch-compare";
import { parseOutlinerLinkUri, resolveOutlinerLinkTarget, type OutlinerLinkTarget } from "./outliner-links";
import { pageAddressReferences } from "./page-addresses";
import { blockDisplayTitle, blockReferenceOccurrences } from "./references";
import { readSavedView } from "./saved-view-read";
import { parseWorkId } from "./work-ids";
import { refuseDroppedStructure, replaceSectionText, WorkToolRefusal, type WorkToolsClient } from "./work-tools";
import type {
  AnnotationBatchReceipt,
  AnnotationRecord,
  Block,
  BlockAuthor,
  BlockEditActivityPage,
  BlockReadCollection,
  BlockProperty,
  BlockSearchQuery,
  MutationProvenance,
  OutlinerCapability,
  PropertyFilter,
  VisibleBlockCollection,
} from "./types";

/** The client these operations use: requests, and the capability check before an additive one. */
export interface AgentToolsClient extends WorkToolsClient {
  requireCompatibleService(needed?: readonly OutlinerCapability[]): Promise<unknown>;
}

/** The agent a write is attributed to: always `author: agent`, with its actor id and session. */
export interface AgentActor {
  actorId: string;
  sessionId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function mutationOf(actor: AgentActor): MutationProvenance {
  return { author: "agent", actorId: actor.actorId, ...(actor.sessionId ? { sessionId: actor.sessionId } : {}) };
}

function provenanceOf(actor: AgentActor) {
  return { actorId: actor.actorId, ...(actor.sessionId ? { sessionId: actor.sessionId } : {}) };
}

function requireText(value: unknown, what: string): string {
  if (typeof value !== "string" || !value.trim()) throw new WorkToolRefusal(`${what} is empty; give the text to write`);
  return value;
}

function boundedInteger(value: unknown, what: string, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new WorkToolRefusal(`${what} must be a whole number from ${min} to ${max}`);
  }
  return value;
}

function requireRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new WorkToolRefusal("Give expectedRevision: the revision outline_read returned");
  }
  return value;
}

/** Properties as `{key: value}`, a repeated key as a list of its values. */
function propertyMap(properties: readonly BlockProperty[]): Record<string, string | string[]> {
  const map: Record<string, string | string[]> = {};
  for (const { key, value } of properties) {
    const had = map[key];
    map[key] = had === undefined ? value : Array.isArray(had) ? [...had, value] : [had, value];
  }
  return map;
}

function workIdOf(block: Block): string | undefined {
  return block.properties.find(property => property.key === "work-id")?.value;
}

// ─── Resolve ───────────────────────────────────────────────────────────────

/**
 * What an agent may name a block by: its id, `((id))` (with `^fragment` or
 * `|label`), `[[page]]`, a Work ID, or a `pi-outliner://` link. A title is
 * refused (outline_find finds one), so a write never lands on a guess.
 */
export function referenceTarget(ref: string): OutlinerLinkTarget {
  const text = typeof ref === "string" ? ref.trim() : "";
  if (!text) throw new WorkToolRefusal("Give a reference: a block id, ((id)), [[page]] or a Work ID");
  if (text.startsWith("pi-outliner://")) return parseOutlinerLinkUri(text);
  if (UUID.test(text)) return { kind: "block", value: text.toLowerCase() };
  const references = blockReferenceOccurrences(text);
  if (references.length === 1 && references[0]!.start === 0 && references[0]!.end === text.length) {
    const { blockId, fragmentId } = references[0]!;
    return { kind: "block", value: blockId, ...(fragmentId ? { fragmentId } : {}) };
  }
  const pages = pageAddressReferences(text);
  if (pages.length === 1 && pages[0]!.start === 0 && pages[0]!.end === text.length) {
    const address = pages[0]!.displayAddress;
    return parseWorkId(address) ? { kind: "work", value: parseWorkId(address)!.workId } : { kind: "page", value: address };
  }
  const workId = parseWorkId(text);
  if (workId) return { kind: "work", value: workId.workId };
  throw new WorkToolRefusal(
    `"${text}" is not a reference; give a block id, ((id)), [[page]] or a Work ID (titles aren't accepted: outline_find finds one)`,
  );
}

export interface ResolvedReference {
  id: string;
  ref: string;
  title: string;
  revision: number;
  workId?: string;
  fragmentId?: string;
  deleted?: true;
}

async function resolveReference(client: AgentToolsClient, ref: string): Promise<{ block: Block; fragmentId?: string }> {
  const target = referenceTarget(ref);
  if (target.kind === "goto" || target.kind === "resource" || target.kind === "reference") {
    throw new WorkToolRefusal(`A ${target.kind} link doesn't name one block; give its id, [[page]] or Work ID`);
  }
  // Read-only: a page address that doesn't resolve is an error, never a new page.
  const resolved = await resolveOutlinerLinkTarget(client, target, { followMissingPages: false });
  return { block: resolved.block, ...(resolved.fragmentId ? { fragmentId: resolved.fragmentId } : {}) };
}

/** A block to write to: resolved, and refused while it is in Trash. */
async function writableBlock(client: AgentToolsClient, ref: string): Promise<Block> {
  const { block } = await resolveReference(client, ref);
  if (block.effectiveDeletedRootId) throw new WorkToolRefusal(`${block.id} is in Trash; restore it before writing`);
  return block;
}

export async function resolveRef(client: AgentToolsClient, ref: string): Promise<ResolvedReference> {
  const { block, fragmentId } = await resolveReference(client, ref);
  const workId = workIdOf(block);
  return {
    id: block.id,
    ref: `((${block.id}))`,
    title: blockDisplayTitle(block),
    revision: block.revision,
    ...(workId ? { workId } : {}),
    ...(fragmentId ? { fragmentId } : {}),
    ...(block.effectiveDeletedRootId ? { deleted: true as const } : {}),
  };
}

// ─── Read ──────────────────────────────────────────────────────────────────

export interface ReadChild {
  id: string;
  text: string;
  revision: number;
  children?: ReadChild[];
  /** It has children this read didn't reach (past `depth`, or past `limit`). */
  more?: true;
}

export interface ReadResult extends ResolvedReference {
  text: string;
  properties: Record<string, string | string[]>;
  author: BlockAuthor;
  actorId?: string;
  updated: string;
  parentId: string | null;
  children: ReadChild[];
  /** Every descendant to `depth` is here, and none below it was cut off. */
  complete: boolean;
}

/** How much children's text one read returns at most (the note's own text is always whole). */
export const READ_CHILDREN_MAX_CHARS = 60_000;

/**
 * A block with its full text (never the title alone), properties, revision and
 * who last wrote it, and its children to `depth` levels (default 1), at most
 * `limit` descendants in all (default 50), each with full text, and at most
 * READ_CHILDREN_MAX_CHARS of children's text. `complete` says
 * whether anything was left out; a child marked `more` has unread children.
 */
export async function readBlock(
  client: AgentToolsClient,
  input: { ref: string; depth?: number; limit?: number },
): Promise<ReadResult> {
  const depth = boundedInteger(input.depth, "depth", 1, 0, 6);
  const limit = boundedInteger(input.limit, "limit", 50, 0, 500);
  // The children's text in all, so a read of a large subtree never floods the caller: past it, `complete` is false.
  let chars = READ_CHILDREN_MAX_CHARS;
  const resolved = await resolveRef(client, input.ref);
  const block = await client.request<Block>({ action: "get", blockId: resolved.id });
  let budget = limit;
  let complete = true;
  // Blocks whose children this read doesn't reach: ask the service which have any, in one read.
  const markMore = async (unread: ReadChild[]) => {
    if (!unread.length) return;
    const read = await client.request<BlockReadCollection>({ action: "blocks.read", ids: unread.map(child => child.id), fields: ["hasChildren"] });
    const withChildren = new Set(read.blocks.filter(row => row.hasChildren).map(row => row.id));
    for (const child of unread) {
      if (withChildren.has(child.id)) { child.more = true; complete = false; }
    }
  };
  const read = async (parentId: string, level: number): Promise<ReadChild[]> => {
    const blocks = await client.request<Block[]>({ action: "children", parentId });
    const children: ReadChild[] = [];
    for (const child of blocks) {
      if (budget === 0 || child.text.length > chars) { budget = 0; complete = false; break; }
      budget--;
      chars -= child.text.length;
      children.push({ id: child.id, text: child.text, revision: child.revision });
    }
    const unread: ReadChild[] = [];
    for (const child of children) {
      if (level === depth || budget === 0) { unread.push(child); continue; }
      const below = await read(child.id, level + 1);
      if (below.length) child.children = below;
    }
    await markMore(unread);
    return children;
  };
  let children: ReadChild[] = [];
  if (depth > 0) children = await read(block.id, 1);
  else await markMore([{ id: block.id, text: "", revision: block.revision }]);
  return {
    ...resolved,
    title: blockDisplayTitle(block),
    revision: block.revision,
    text: block.text,
    properties: propertyMap(block.properties),
    author: block.author,
    ...(block.actorId ? { actorId: block.actorId } : {}),
    updated: block.updatedAt,
    parentId: block.parentId,
    children,
    complete,
  };
}

// ─── Find ──────────────────────────────────────────────────────────────────

export interface FindInput {
  text?: string;
  /** `key=value`, or `key` for any value (as `list --filter`). */
  property?: string;
  hasKey?: string;
  /** The saved-view query grammar (`list --query`). */
  query?: string;
  /** A saved view (virtual branch): its members, instead of a search. */
  view?: string;
  /** Only under this block. */
  under?: string;
  limit?: number;
}

export interface FindRow {
  id: string;
  title: string;
  revision: number;
  parentId: string | null;
  updated: string;
  workId?: string;
}

function findRow(block: Block): FindRow {
  const workId = workIdOf(block);
  return {
    id: block.id,
    title: blockDisplayTitle(block),
    revision: block.revision,
    parentId: block.parentId,
    updated: block.updatedAt,
    ...(workId ? { workId } : {}),
  };
}

/**
 * Blocks by text, property, property key, query or saved view, as rows to read
 * next (id, title, revision). `text`, `property`, `hasKey`, `query` and `under`
 * combine; `view` stands alone. `complete: false` means more matched than `limit`.
 */
export async function findBlocks(client: AgentToolsClient, input: FindInput): Promise<{ blocks: FindRow[]; complete: boolean; total?: number }> {
  const limit = boundedInteger(input.limit, "limit", 20, 1, 200);
  const given = (key: keyof FindInput) => typeof input[key] === "string" && (input[key] as string).trim() !== "";
  if (given("view")) {
    if (["text", "property", "hasKey", "query", "under"].some(key => given(key as keyof FindInput))) {
      throw new WorkToolRefusal("A view is read on its own; drop text, property, hasKey, query and under");
    }
    await client.requireCompatibleService(["views.read"]);
    const view = await resolveRef(client, input.view!);
    const read = await readSavedView(client, view.id, { limit });
    if (read.errors.length) throw new WorkToolRefusal(`The view ${view.id} can't be read: ${read.errors.join("; ")}`);
    return {
      blocks: read.blocks.map(findRow),
      complete: read.nextOffset === undefined && (read.completeness?.kind ?? "complete") === "complete",
      ...(read.total === undefined ? {} : { total: read.total }),
    };
  }
  if (!["text", "property", "hasKey", "query"].some(key => given(key as keyof FindInput))) {
    throw new WorkToolRefusal("Give text, property, hasKey, query or view to find blocks by");
  }
  const filters: PropertyFilter[] = [];
  if (given("property")) filters.push(parsePropertyFilterClause(input.property!));
  if (given("hasKey")) filters.push({ key: input.hasKey!.trim() });
  const query: BlockSearchQuery = {
    limit,
    ...(filters.length ? { filters } : {}),
    ...(given("text") ? { text: input.text } : {}),
    ...(given("query") ? { expression: input.query } : {}),
    ...(given("under") ? { subtreeRootId: (await resolveRef(client, input.under!)).id } : {}),
  };
  // An older service ignores `expression` and would return unfiltered results.
  if (query.expression !== undefined) await client.requireCompatibleService(["query.expression"]);
  const found = await client.request<VisibleBlockCollection>({ action: "blocks.query", query });
  return { blocks: found.blocks.map(findRow), complete: found.completeness.kind === "complete" };
}

// ─── Edit ──────────────────────────────────────────────────────────────────

export interface EditInput {
  ref: string;
  expectedRevision: number;
  /** The whole new text. */
  text?: string;
  /** One heading's section, as Detail folds it. */
  replaceSection?: { heading: string; body: string };
  /** Added after the text, as a new paragraph unless it starts with a newline. */
  append?: string;
  /** Allow dropping a `[page::…]` or an anchor other notes link to. */
  allowStructural?: boolean;
}

export interface EditResult {
  id: string;
  ref: string;
  revision: number;
  previousRevision: number;
  diff: string;
  /** For replaceSection: the heading and the text it replaced. */
  section?: { heading: string; previous: string };
  /** With allowStructural: the `[page::…]` properties and `^anchors` the edit removed. */
  dropped?: string[];
}

/** A short line diff: the changed lines between the common head and tail, `-` then `+`, at most `max` lines. */
export function shortDiff(before: string, after: string, max = 40): string {
  const a = before.split("\n");
  const b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const removed = a.slice(head, a.length - tail).map(line => `-${line}`);
  const added = b.slice(head, b.length - tail).map(line => `+${line}`);
  const lines = [`@@ line ${head + 1}`, ...removed, ...added];
  if (!removed.length && !added.length) return "";
  return lines.length > max ? [...lines.slice(0, max), `… ${lines.length - max} more lines`].join("\n") : lines.join("\n");
}

/**
 * Rewrites a block's text, checked against the revision the agent read: the
 * whole text, one section, or an addition at the end. An empty result, a stale
 * revision, and (unless `allowStructural`) dropping a `[page::…]` or an anchor
 * other notes link to are refused before anything is written.
 */
export async function editBlock(client: AgentToolsClient, input: EditInput, actor: AgentActor): Promise<EditResult> {
  const expectedRevision = requireRevision(input.expectedRevision);
  const modes = [input.text !== undefined, input.replaceSection !== undefined, input.append !== undefined].filter(Boolean).length;
  if (modes !== 1) throw new WorkToolRefusal("Give exactly one of text, replaceSection or append");
  const block = await writableBlock(client, input.ref);
  if (block.revision !== expectedRevision) {
    throw new WorkToolRefusal(
      `${block.id} is at revision ${block.revision}, not ${expectedRevision}: it changed since you read it. Read it again, then edit`,
    );
  }
  let next: string;
  let section: EditResult["section"];
  if (input.text !== undefined) {
    next = requireText(input.text, "The new text");
  } else if (input.replaceSection !== undefined) {
    const { heading, body } = input.replaceSection ?? {};
    if (typeof heading !== "string" || typeof body !== "string") throw new WorkToolRefusal("replaceSection needs a heading and a body");
    const replaced = replaceSectionText(block.text, heading, body, block.id);
    next = replaced.text;
    section = { heading: replaced.heading, previous: replaced.previous };
  } else {
    const addition = requireText(input.append, "The text to append");
    next = addition.startsWith("\n") ? `${block.text.replace(/\s+$/, "")}${addition}` : `${block.text.replace(/\s+$/, "")}\n\n${addition}`;
  }
  requireText(next, "The note's new text");
  if (next === block.text) {
    return { id: block.id, ref: `((${block.id}))`, revision: block.revision, previousRevision: block.revision, diff: "", ...(section ? { section } : {}) };
  }
  // Only an explicit boolean true skips the guard ("true" or 1 do not), and what it let go is said in the result.
  let dropped: string[] = [];
  if (input.allowStructural !== true) await refuseDroppedStructure(client, block, next);
  else {
    const lost = droppedStructure(block.text, next);
    dropped = [...lost.pages, ...lost.anchors.map(anchor => `^${anchor}`)];
  }
  const updated = await client.request<Block>({
    action: "update",
    blockId: block.id,
    text: next,
    expectedRevision,
    mutation: mutationOf(actor),
  });
  return {
    id: updated.id,
    ref: `((${updated.id}))`,
    revision: updated.revision,
    previousRevision: block.revision,
    diff: shortDiff(block.text, updated.text),
    ...(section ? { section } : {}),
    ...(dropped.length ? { dropped } : {}),
  };
}

// ─── Create ────────────────────────────────────────────────────────────────

/** A new block under `parent` (a reference, or `root`), at `position` among its siblings (0 first; default last). */
export async function createBlock(
  client: AgentToolsClient,
  input: { parent: string; text: string; position?: number },
  actor: AgentActor,
): Promise<{ id: string; ref: string; revision: number; parentId: string | null }> {
  const text = requireText(input.text, "The new block's text");
  if (typeof input.parent !== "string" || !input.parent.trim()) throw new WorkToolRefusal("Give the parent: a reference, or root");
  const parentId = input.parent.trim() === "root" ? null : (await writableBlock(client, input.parent)).id;
  const position = input.position === undefined ? undefined : boundedInteger(input.position, "position", 0, 0, 1_000_000);
  let block = await client.request<Block>({ action: "create", text, parentId, author: "agent", provenance: provenanceOf(actor) });
  if (position !== undefined) {
    await client.requireCompatibleService(["mutations.provenance"]);
    block = await client.request<Block>({ action: "move", blockId: block.id, parentId, position, mutation: mutationOf(actor) });
  }
  return { id: block.id, ref: `((${block.id}))`, revision: block.revision, parentId: block.parentId };
}

// ─── Comments ──────────────────────────────────────────────────────────────

export interface CommentResult {
  thread: string;
  blockId?: string;
  author: BlockAuthor;
  actorId?: string;
  lifecycle: string;
  deduplicated?: boolean;
}

function commentResult(record: AnnotationRecord, extra: Partial<CommentResult> = {}): CommentResult {
  return {
    thread: record.parentAnnotationId ?? record.block.id,
    author: record.block.author,
    ...(record.block.actorId ? { actorId: record.block.actorId } : {}),
    lifecycle: record.lifecycle,
    ...extra,
  };
}

/**
 * A comment thread on a block, as the agent: on an exact `quote` of its source
 * (with `start`, `prefix` or `suffix` when the quote repeats), or on the
 * `whole` block. A `requestId` makes a retry return the same thread.
 */
export async function commentOn(
  client: AgentToolsClient,
  input: { ref: string; body: string; quote?: string; whole?: boolean; start?: number; prefix?: string; suffix?: string; requestId?: string },
  actor: AgentActor,
): Promise<CommentResult> {
  const body = requireText(input.body, "The comment");
  if ((input.whole === true) === (typeof input.quote === "string")) {
    throw new WorkToolRefusal("Give either quote (exact source text) or whole: true");
  }
  const block = await writableBlock(client, input.ref);
  const receipt = await createBlockComment(client, {
    requestId: input.requestId?.trim() || randomUUID(),
    author: "agent",
    provenance: provenanceOf(actor),
    input: {
      blockId: block.id,
      expectedRevision: block.revision,
      body,
      source: "agent",
      ...(input.whole ? {} : {
        passage: {
          quote: input.quote!,
          ...(input.start === undefined ? {} : { start: input.start }),
          ...(input.prefix === undefined ? {} : { prefix: input.prefix }),
          ...(input.suffix === undefined ? {} : { suffix: input.suffix }),
        },
      }),
    },
  });
  const record = receipt.annotations[0];
  if (!record) throw new Error("The service recorded no comment");
  return commentResult(record, { blockId: block.id, ...(receipt.deduplicated ? { deduplicated: true } : {}) });
}

function threadId(thread: string): string {
  const target = referenceTarget(thread);
  if (target.kind !== "block") throw new WorkToolRefusal("Name the thread by its id (outline_comment returns it)");
  return target.value;
}

/** A reply in a comment thread, as the agent. */
export async function replyTo(
  client: AgentToolsClient,
  input: { thread: string; body: string; requestId?: string },
  actor: AgentActor,
): Promise<CommentResult & { reply: string }> {
  const body = requireText(input.body, "The reply");
  const annotationId = threadId(input.thread);
  const receipt = await client.request<AnnotationBatchReceipt>({
    action: "annotations.reply",
    requestId: input.requestId?.trim() || randomUUID(),
    input: { annotationId, body, source: "agent" },
    author: "agent",
    provenance: provenanceOf(actor),
  });
  const record = receipt.annotations[0];
  if (!record) throw new Error("The service recorded no reply");
  return { ...commentResult(record, receipt.deduplicated ? { deduplicated: true } : {}), thread: annotationId, reply: record.block.id };
}

/** Resolves (or reopens) a comment thread, as the agent. */
export async function resolveThread(
  client: AgentToolsClient,
  input: { thread: string; resolved: boolean },
  actor: AgentActor,
): Promise<CommentResult> {
  if (typeof input.resolved !== "boolean") throw new WorkToolRefusal("Say resolved: true to resolve the thread, false to reopen it");
  const annotationId = threadId(input.thread);
  const record = await client.request<AnnotationRecord>({
    action: "annotations.lifecycle",
    input: { annotationId, lifecycle: input.resolved ? "resolved" : "open" },
    mutation: mutationOf(actor),
  });
  return commentResult(record);
}

// ─── Changes ───────────────────────────────────────────────────────────────

export interface ChangeRow {
  cursor: number;
  id: string;
  title: string;
  kind: string;
  author: BlockAuthor;
  actorId?: string;
  sessionId?: string;
  at: string;
  revision: number;
}

/**
 * What changed since a point: an ISO time, or the `cursor` a previous call
 * returned. Each block once, at its latest edit, newest first. Without
 * `author`, the person's, agents' and the system's edits together; `actor`
 * narrows to one agent (or extension).
 *
 * When more changed than `limit`, `complete` is false and `before` is given:
 * call again with the same `since` and that `before` for the older ones, until
 * `complete` is true. Then pass `cursor` as `since` next time for only what is
 * newer; it is past everything that matched, so take it only once every page
 * is read.
 */
export async function changesSince(
  client: AgentToolsClient,
  input: { since: string | number; author?: string; actor?: string; limit?: number; before?: number },
): Promise<{ entries: ChangeRow[]; cursor: number; complete: boolean; before?: number }> {
  const limit = boundedInteger(input.limit, "limit", 20, 1, 100);
  const since = typeof input.since === "number" ? String(input.since) : typeof input.since === "string" ? input.since.trim() : "";
  if (!since) throw new WorkToolRefusal("Give since: an ISO time (2026-01-31T09:00:00Z) or a cursor from an earlier call");
  const point = /^\d+$/.test(since) ? { afterCursor: Number(since) } : { since };
  if ("since" in point && !Number.isFinite(Date.parse(since))) throw new WorkToolRefusal(`since is neither a time nor a cursor: ${since}`);
  if (input.author !== undefined && !["user", "agent", "system"].includes(input.author)) {
    throw new WorkToolRefusal("author is user, agent or system");
  }
  const before = input.before === undefined ? undefined : boundedInteger(input.before, "before", 1, 1, Number.MAX_SAFE_INTEGER);
  const actor = typeof input.actor === "string" && input.actor.trim() ? input.actor.trim() : undefined;
  await client.requireCompatibleService(["mutations.provenance", ...(actor || before ? ["activity.actor" as const] : [])]);
  const authors = (input.author ? [input.author] : actor ? ["agent", "system", "user"] : ["user", "agent", "system"]) as BlockAuthor[];
  // One more than asked (the service's cap is 100), to tell a full page from a cut one.
  const asked = Math.min(limit + 1, 100);
  const pages = await Promise.all(authors.map(author => client.request<BlockEditActivityPage>({
    action: "activity.recent",
    ...point,
    author,
    limit: asked,
    kinds: ["text", "properties", "move", "delete", "restore"],
    ...(actor ? { actorId: actor } : {}),
    ...(before ? { beforeCursor: before } : {}),
  })));
  // One entry per block across authors: its latest.
  const latest = new Map<string, ChangeRow>();
  for (const entry of pages.flatMap(page => page.entries)) {
    const had = latest.get(entry.block.id);
    if (had && had.cursor > entry.cursor) continue;
    latest.set(entry.block.id, {
      cursor: entry.cursor,
      id: entry.block.id,
      title: blockDisplayTitle(entry.block),
      kind: entry.kind,
      author: entry.author,
      ...(entry.actorId ? { actorId: entry.actorId } : {}),
      ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
      at: entry.editedAt,
      revision: entry.block.revision,
    });
  }
  const sorted = [...latest.values()].sort((a, b) => b.cursor - a.cursor);
  // `cut`: every entry above it is here; at or below it, some may not be. A page the service filled is whole only
  // above its oldest entry (one cursor can cover several blocks), and so is this answer past `limit`.
  let cut = 0;
  for (const page of pages) {
    if (page.entries.length >= asked) cut = Math.max(cut, Math.min(...page.entries.map(entry => entry.cursor)));
  }
  let entries = sorted.filter(entry => entry.cursor > cut);
  if (entries.length > limit) {
    cut = entries[limit]!.cursor;
    entries = entries.filter(entry => entry.cursor > cut);
  }
  // More blocks at one cursor than `limit`: return them all rather than page forever.
  if (cut && !entries.length) {
    entries = sorted.filter(entry => entry.cursor >= cut);
    cut -= 1;
  }
  const floor = "afterCursor" in point ? point.afterCursor ?? 0 : 0;
  return {
    entries,
    cursor: Math.max(floor, ...pages.map(page => page.cursor)),
    complete: cut === 0,
    ...(cut ? { before: cut + 1 } : {}),
  };
}

// ─── draft.patch ───────────────────────────────────────────────────────────

/**
 * `draft.patch` as the agent: compare-and-swap on spans of a note's text, safe
 * while the person types in it. The door holding a live draft gets it; with
 * none, the saved note is patched under the revision, as an ordinary edit.
 * `policy` is `edit` unless the caller says `prose`: the same guard as
 * outline_edit (a dropped `[page::…]` or linked `^anchor` is refused, unless
 * `allowStructural`). A patch that no longer matches, or that `prose` refuses,
 * lands as one proposal the person can apply (`outcome: proposed`, with the reason).
 */
export async function patchDraft(
  client: AgentToolsClient,
  input: { ref: string; revision: number; patches: DraftPatchSpan[]; mark?: string; policy?: DraftPatchPolicyName; allowStructural?: boolean },
  actor: AgentActor,
): Promise<DraftPatchResult> {
  const revision = requireRevision(input.revision);
  const policy = input.policy ?? "edit";
  if (!DRAFT_PATCH_POLICIES.includes(policy)) throw new WorkToolRefusal(`policy is ${DRAFT_PATCH_POLICIES.join(" or ")}`);
  if (!Array.isArray(input.patches) || input.patches.length === 0) throw new WorkToolRefusal("Give at least one patch: {observed, replacement}");
  for (const patch of input.patches) {
    if (!patch || typeof patch.observed !== "string" || !patch.observed || typeof patch.replacement !== "string") {
      throw new WorkToolRefusal("Each patch needs observed (the exact text you read, never empty) and replacement");
    }
  }
  await client.requireCompatibleService(["draft.patch"]);
  const block = await writableBlock(client, input.ref);
  return client.request<DraftPatchResult>({
    action: "draft.patch",
    blockId: block.id,
    revision,
    patches: input.patches,
    mutation: mutationOf(actor),
    policy,
    ...(input.allowStructural === true ? { allowStructural: true } : {}),
    ...(typeof input.mark === "string" && input.mark.trim() ? { mark: { text: input.mark } } : {}),
  }, 15_000);
}

// ─── The CLI's `agent` command ──────────────────────────────────────────────

export const AGENT_OPERATIONS = ["read", "find", "resolve", "edit", "create", "comment", "reply", "resolve-thread", "changes", "patch"] as const;
export type AgentOperation = (typeof AGENT_OPERATIONS)[number];

/** Runs one operation on its JSON input. Writes need an actor; reads ignore it. */
export function runAgentOperation(
  client: AgentToolsClient,
  operation: AgentOperation,
  input: Record<string, unknown>,
  actor: AgentActor | undefined,
): Promise<unknown> {
  const writer = () => {
    if (!actor?.actorId.trim()) throw new WorkToolRefusal(`agent ${operation} writes: pass --actor <agent id>`);
    return actor;
  };
  const any = input as any;
  switch (operation) {
    case "read": return readBlock(client, any);
    case "find": return findBlocks(client, any);
    case "resolve": return resolveRef(client, any.ref);
    case "edit": return editBlock(client, any, writer());
    case "create": return createBlock(client, any, writer());
    case "comment": return commentOn(client, any, writer());
    case "reply": return replyTo(client, any, writer());
    case "resolve-thread": return resolveThread(client, any, writer());
    case "changes": return changesSince(client, any);
    case "patch": return patchDraft(client, any, writer());
  }
}
