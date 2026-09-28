/**
 * Workboard operations for agents: one implementation behind the `work` /
 * `note` CLI commands, the Claude mod tools and Pi's task completion.
 *
 * Every operation names its item explicitly (a Work ID or a block UUID), goes
 * through the service's existing RPCs with the revision it read, and reads the
 * result back. The service still owns the rules (valid stages, reserved
 * roadmap properties, delivery facts); these helpers only refuse what they can
 * tell is wrong before writing, and say why.
 */
import type { RequestInput } from "./client";
import { deliveryIdentities, deterministicDeliveryIdentity, parseDeliveryIdentity } from "./delivery-lifecycle";
import { documentFolds } from "./document-folds";
import { markdownSourceTokens } from "./markdown-structure";
import { getProperty, matchesFilters, normalizePropertyKey, parsePropertyRecords, patchPropertyText, validateProperty } from "./properties";
import { parseWorkId } from "./work-ids";
import {
  ROADMAP_WORK_STAGES,
  type Block,
  type BlockAuthor,
  type BlockProvenance,
  type DeliveryReceipt,
  type DeliverySyncReceipt,
  type MutationProvenance,
  type PageAddressResolution,
  type PropertyPatchOperation,
  type RoadmapItemCreateInput,
  type RoadmapItemCreateReceipt,
  type RoadmapWorkStage,
} from "./types";

/** The part of `OutlinerClient` these operations use. */
export interface WorkToolsClient {
  request<T>(input: RequestInput, timeoutMs?: number): Promise<T>;
}

/** Who is writing: the block author plus provenance, as the service records it. */
export interface WorkActor {
  author: BlockAuthor;
  actorId: string;
  sessionId?: string;
  taskId?: string;
}

/** A refusal made before writing; the message says what to change. */
export class WorkToolRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkToolRefusal";
  }
}

const BLOCK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Identity is assigned once; changing it would orphan links, deliveries and reservations. */
const IMMUTABLE_KEYS = new Set(["type", "work-id"]);
/** Roadmap list relationships: setting one value would drop the others. */
const LIST_KEYS = new Set(["track", "depends-on", "related-to", "proof"]);

function mutationOf(actor: WorkActor): MutationProvenance {
  return {
    author: actor.author,
    actorId: actor.actorId,
    ...(actor.sessionId ? { sessionId: actor.sessionId } : {}),
    ...(actor.taskId ? { taskId: actor.taskId } : {}),
  };
}

/** Creation provenance; the service records it for agent-authored blocks only. */
function provenanceOf(actor: WorkActor): BlockProvenance | undefined {
  if (actor.author !== "agent") return undefined;
  return {
    actorId: actor.actorId,
    ...(actor.sessionId ? { sessionId: actor.sessionId } : {}),
    ...(actor.taskId ? { taskId: actor.taskId } : {}),
  };
}

/** What every result names: the item, how to link it, and the revision now current. */
export interface BlockRef {
  blockId: string;
  ref: string;
  revision: number;
}

export interface WorkItemRef extends BlockRef {
  workId: string;
  workStage: string | null;
}

export function blockRef(block: Block): BlockRef {
  return { blockId: block.id, ref: `((${block.id}))`, revision: block.revision };
}

export function workItemRef(block: Block): WorkItemRef {
  return {
    workId: requireWorkItem(block),
    ...blockRef(block),
    workStage: getProperty(block.properties, "work-stage") ?? null,
  };
}

/** The roadmap item's Work ID; refuses any other block. */
export function requireWorkItem(block: Block): string {
  if (!matchesFilters(block.properties, [{ key: "type", value: "roadmap-item" }])) {
    throw new WorkToolRefusal(`Block is not a roadmap item: ${block.id}`);
  }
  const workId = getProperty(block.properties, "work-id");
  if (!workId) throw new WorkToolRefusal(`Roadmap item has no Work ID: ${block.id}`);
  return workId;
}

/**
 * Resolves an explicit address: a block UUID (optionally as `((uuid))`) or a
 * Work ID such as PIE-438. Titles and short prefixes are refused, so a write
 * never lands on a guessed block.
 */
export async function resolveBlock(client: WorkToolsClient, address: string): Promise<Block> {
  const trimmed = address.trim().replace(/^\(\((.*)\)\)$/, "$1").trim();
  let block: Block;
  if (BLOCK_ID.test(trimmed)) {
    block = await client.request<Block>({ action: "get", blockId: trimmed.toLowerCase() });
  } else if (parseWorkId(trimmed)) {
    const workId = parseWorkId(trimmed)!.workId;
    const resolved = await client.request<PageAddressResolution>({ action: "pages.resolve", address: workId });
    if (resolved.status === "deleted") throw new WorkToolRefusal(`${workId} is in Trash`);
    if (resolved.status !== "resolved" || !resolved.block) throw new WorkToolRefusal(`No block has Work ID ${workId}`);
    block = resolved.block;
  } else {
    throw new WorkToolRefusal(
      `Give a Work ID (PIE-123) or a full block UUID, not "${address}"; titles and prefixes are not accepted`,
    );
  }
  if (block.effectiveDeletedRootId) throw new WorkToolRefusal(`Block is in Trash: ${block.id}`);
  return block;
}

/** A block named by its UUID (a delivery or proof), refusing one in Trash. */
async function getActiveBlock(client: WorkToolsClient, blockId: string): Promise<Block> {
  const block = await client.request<Block>({ action: "get", blockId: blockId.trim().replace(/^\(\((.*)\)\)$/, "$1").trim() });
  if (block.effectiveDeletedRootId) throw new WorkToolRefusal(`Block is in Trash: ${block.id}`);
  return block;
}

export async function resolveWorkItem(client: WorkToolsClient, address: string): Promise<Block> {
  const block = await resolveBlock(client, address);
  requireWorkItem(block);
  return block;
}

/** Replace the one block-scoped `key`, or append it when absent; duplicates are ambiguous. */
export function propertyTransition(block: Block, key: string, value: string): PropertyPatchOperation {
  let ordinal: number | undefined;
  for (const property of parsePropertyRecords(block.text)) {
    if (property.scope !== "block" || property.key !== key) continue;
    if (ordinal !== undefined) {
      throw new WorkToolRefusal(`Block has more than one [${key}::…] property, so it cannot be set as one value: ${block.id}`);
    }
    ordinal = property.ordinal;
  }
  return ordinal === undefined ? { op: "append", key, value } : { op: "replace", ordinal, value };
}

/**
 * Text for a typed artifact under `sourceBlockId` (a proof, a finding…). The
 * metadata goes in the preamble through the shared property writer, so it is
 * block-scoped however many paragraphs the body has.
 */
export function typedArtifactText(text: string, type: string, sourceBlockId: string | null): string {
  const body = text.trim();
  if (!body) throw new WorkToolRefusal("Artifact text cannot be empty");
  const operations: PropertyPatchOperation[] = [{ op: "append", key: "type", value: type }];
  if (sourceBlockId) operations.push({ op: "append", key: "source-block", value: sourceBlockId });
  return patchPropertyText(body, operations);
}

function requireRevision(block: Block, expectedRevision: number | undefined): number {
  if (expectedRevision !== undefined && block.revision !== expectedRevision) {
    throw new WorkToolRefusal(
      `${block.id} is at revision ${block.revision}, not ${expectedRevision}; read it again before editing`,
    );
  }
  return block.revision;
}

// ─── Create ────────────────────────────────────────────────────────────────

export interface WorkCreateResult extends WorkItemRef {
  workQueueId: string;
}

/** Allocates a Work ID and creates the item under its project's work queue. */
export async function createWorkItem(
  client: WorkToolsClient,
  input: RoadmapItemCreateInput,
  actor: WorkActor,
): Promise<WorkCreateResult> {
  const receipt = await client.request<RoadmapItemCreateReceipt>({
    action: "roadmap.items.create",
    input,
    author: actor.author,
    provenance: provenanceOf(actor),
  });
  return { ...workItemRef(receipt.block), workQueueId: receipt.workQueueId };
}

// ─── Properties ────────────────────────────────────────────────────────────

export interface WorkSetResult extends WorkItemRef {
  key: string;
  previous: string | null;
  value: string;
  changed: boolean;
}

/**
 * Sets one single-valued property on a roadmap item, revision-checked, and
 * reads the value back. `work-stage` must be a known stage; Done needs proof,
 * so it goes through `completeWorkItem` instead.
 */
export async function setWorkProperty(
  client: WorkToolsClient,
  address: string,
  rawKey: string,
  rawValue: string,
  actor: WorkActor,
  options: { expectedRevision?: number } = {},
): Promise<WorkSetResult> {
  const { key, value } = validateProperty(normalizePropertyKey(rawKey), rawValue);
  if (IMMUTABLE_KEYS.has(key)) throw new WorkToolRefusal(`[${key}::…] is the item's identity and cannot be changed`);
  if (LIST_KEYS.has(key)) throw new WorkToolRefusal(`[${key}::…] is a list on roadmap items; edit it with properties.patch, not work set`);
  if (key === "status") throw new WorkToolRefusal("Roadmap items have no status; set work-stage instead");
  let stage = value;
  if (key === "work-stage") {
    stage = value.toLowerCase();
    if (!(ROADMAP_WORK_STAGES as readonly string[]).includes(stage)) {
      throw new WorkToolRefusal(`Unknown work stage "${value}"; use one of ${ROADMAP_WORK_STAGES.join(", ")}`);
    }
    if (stage === "done") throw new WorkToolRefusal("Done needs linked proof; use work complete");
  }
  const block = await resolveWorkItem(client, address);
  const revision = requireRevision(block, options.expectedRevision);
  const previous = getProperty(block.properties, key) ?? null;
  const operation = propertyTransition(block, key, stage);
  if (previous === stage) return { ...workItemRef(block), key, previous, value: stage, changed: false };
  const updated = await client.request<Block>({
    action: "properties.patch",
    blockId: block.id,
    expectedRevision: revision,
    operations: [operation],
    mutation: mutationOf(actor),
  });
  const readBack = getProperty(updated.properties, key);
  if (readBack !== stage) {
    throw new Error(`${block.id} reads back [${key}::${readBack ?? ""}] after setting ${stage}`);
  }
  return { ...workItemRef(updated), key, previous, value: readBack, changed: true };
}

export function setWorkStage(
  client: WorkToolsClient,
  address: string,
  stage: RoadmapWorkStage | string,
  actor: WorkActor,
  options: { expectedRevision?: number } = {},
): Promise<WorkSetResult> {
  return setWorkProperty(client, address, "work-stage", stage, actor, options);
}

// ─── Delivery ──────────────────────────────────────────────────────────────

/** A pull request as GitHub reports it (`gh pr view --json`). */
export interface PullRequestFacts {
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  mergeCommit: string | null;
  headRefName: string;
  baseRefName: string;
}

export interface WorkDeliverResult extends WorkItemRef {
  delivery: BlockRef & { deliveryKey: string; stage: string; created: boolean };
  pullRequest: { number: number; url: string; state: string; mergeCommit: string | null };
  changed: boolean;
}

/**
 * Records a pull request as the item's delivery (`deliveries.ensure`) and
 * syncs its facts (`deliveries.sync`): open → Review, merged → Validate. The
 * PR must be the delivery's branch into its base, so a wrong number is refused
 * rather than recorded.
 */
export async function deliverPullRequest(
  client: WorkToolsClient,
  input: {
    address: string;
    repository: string;
    pullRequest: PullRequestFacts;
    baseBranch?: string;
    workBranch?: string;
    deliveryKey?: string;
  },
  actor: WorkActor,
): Promise<WorkDeliverResult> {
  const pr = input.pullRequest;
  const baseBranch = input.baseBranch ?? pr.baseRefName;
  const workBranch = input.workBranch ?? pr.headRefName;
  if (pr.headRefName !== workBranch || pr.baseRefName !== baseBranch) {
    throw new WorkToolRefusal(
      `PR #${pr.number} merges ${pr.headRefName} into ${pr.baseRefName}, not ${workBranch} into ${baseBranch}`,
    );
  }
  const task = await resolveWorkItem(client, input.address);
  const workId = requireWorkItem(task);
  const ensured = await client.request<DeliveryReceipt>({
    action: "deliveries.ensure",
    input: {
      taskBlockId: task.id,
      deliveryKey: input.deliveryKey ?? deterministicDeliveryIdentity(workId).deliveryKey,
      repository: input.repository,
      baseBranch,
      workBranch,
    },
    author: actor.author,
    provenance: provenanceOf(actor),
  });
  const synced = await client.request<DeliverySyncReceipt>({
    action: "deliveries.sync",
    input: {
      taskBlockId: task.id,
      deliveryBlockId: ensured.delivery.id,
      expectedDeliveryRevision: ensured.delivery.revision,
      expectedTaskRevision: ensured.task.revision,
      pullRequest: { number: pr.number, url: pr.url, state: pr.state, mergeCommit: pr.mergeCommit },
    },
    mutation: mutationOf(actor),
  });
  const delivery = parseDeliveryIdentity(synced.delivery);
  return {
    ...workItemRef(synced.task),
    delivery: { ...blockRef(synced.delivery), deliveryKey: delivery.key, stage: delivery.stage, created: ensured.created },
    pullRequest: { number: pr.number, url: pr.url, state: pr.state, mergeCommit: pr.mergeCommit },
    changed: synced.changed,
  };
}

/** Parses `gh pr view --json number,url,state,mergeCommit,headRefName,baseRefName`. */
export function parsePullRequestFacts(json: string): PullRequestFacts {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("GitHub returned invalid pull-request JSON");
  }
  const state = raw.state;
  const mergeCommit = (raw.mergeCommit as { oid?: unknown } | null | undefined)?.oid;
  if (
    !Number.isSafeInteger(raw.number) || typeof raw.url !== "string" ||
    (state !== "OPEN" && state !== "CLOSED" && state !== "MERGED") ||
    typeof raw.headRefName !== "string" || typeof raw.baseRefName !== "string"
  ) {
    throw new Error("GitHub returned an incomplete pull-request record");
  }
  return {
    number: raw.number as number,
    url: raw.url,
    state,
    mergeCommit: typeof mergeCommit === "string" && mergeCommit ? mergeCommit : null,
    headRefName: raw.headRefName,
    baseRefName: raw.baseRefName,
  };
}

/** Reads one PR's facts through the GitHub CLI. Read-only. */
export async function readPullRequestFacts(repository: string, number: number): Promise<PullRequestFacts> {
  const child = Bun.spawn(
    ["gh", "pr", "view", String(number), "--repo", repository, "--json", "number,url,state,mergeCommit,headRefName,baseRefName"],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`gh could not read ${repository}#${number}: ${stderr.trim() || `exit ${exitCode}`}`);
  return parsePullRequestFacts(stdout);
}

// ─── Completion ────────────────────────────────────────────────────────────

export interface WorkCompleteResult extends WorkItemRef {
  proof: BlockRef & { created: boolean };
  delivery: (BlockRef & { deliveryKey: string; stage: string }) | null;
}

/**
 * Accepts an item with linked proof: its delivery (if it has one) must be
 * merged; the proof becomes a child `[type::proof]` (or an existing linked
 * block); the delivery becomes Complete and the item Done with a `proof` link.
 *
 * `delivery`: the delivery block (or its UUID). Omitted, the item must have no
 * incomplete delivery, so an unmerged one is never skipped silently.
 * Everything is checked before the first write.
 */
export async function completeWorkItem(
  client: WorkToolsClient,
  input: {
    task: string | Block;
    delivery?: string | Block;
    proof: { text: string } | { blockId: string };
  },
  actor: WorkActor,
): Promise<WorkCompleteResult> {
  const task = typeof input.task === "string" ? await resolveWorkItem(client, input.task) : input.task;
  const workId = requireWorkItem(task);
  const stage = getProperty(task.properties, "work-stage")?.toLowerCase();
  if (stage === "superseded") throw new WorkToolRefusal(`${workId} is superseded; reopen it explicitly before completing`);
  if (stage === "done") throw new WorkToolRefusal(`${workId} is already done`);

  let deliveryBlock: Block | null = null;
  if (input.delivery === undefined) {
    const open = deliveryIdentities(await client.request<Block[]>({ action: "children", parentId: task.id }))
      .filter((delivery) => delivery.stage !== "complete");
    if (open.length > 0) {
      throw new WorkToolRefusal(
        `${workId} has incomplete deliveries; name the one to complete: ${open.map((delivery) => `${delivery.key} ${delivery.block.id}`).join(", ")}`,
      );
    }
  } else {
    deliveryBlock = typeof input.delivery === "string"
      ? await getActiveBlock(client, input.delivery)
      : input.delivery;
  }
  const delivery = deliveryBlock ? parseDeliveryIdentity(deliveryBlock) : null;
  if (delivery) {
    if (delivery.block.parentId !== task.id) {
      throw new WorkToolRefusal(`Delivery ${delivery.key} does not belong to ${workId}`);
    }
    if ((delivery.stage !== "validate" && delivery.stage !== "complete") || !delivery.mergeCommit) {
      throw new WorkToolRefusal(
        `Delivery ${delivery.key} must have a merged PR and reach Validate before completion (it is ${delivery.stage})`,
      );
    }
  }

  let proof: Block;
  let proofCreated = false;
  if ("blockId" in input.proof) {
    proof = await getActiveBlock(client, input.proof.blockId);
    const linked = proof.parentId === task.id ||
      proof.properties.some((property) => property.key === "source-block" && property.value === task.id);
    if (!linked) throw new WorkToolRefusal(`Proof ${proof.id} must be a child of ${workId} or name it as source-block`);
  } else {
    const text = typedArtifactText(input.proof.text, "proof", task.id);
    proof = await client.request<Block>({
      action: "create",
      text,
      parentId: task.id,
      author: actor.author,
      provenance: provenanceOf(actor),
    });
    proofCreated = true;
  }

  let completedDelivery = delivery?.block ?? null;
  const operations: PropertyPatchOperation[] = [propertyTransition(task, "work-stage", "done")];
  if (!task.properties.some((property) => property.key === "proof" && property.value === proof.id)) {
    operations.push({ op: "append", key: "proof", value: proof.id });
  }
  try {
    if (delivery && delivery.stage === "validate") {
      completedDelivery = await client.request<Block>({
        action: "properties.patch",
        blockId: delivery.block.id,
        expectedRevision: delivery.block.revision,
        operations: [propertyTransition(delivery.block, "delivery-stage", "complete")],
        mutation: mutationOf(actor),
      });
    }
    const updated = await client.request<Block>({
      action: "properties.patch",
      blockId: task.id,
      expectedRevision: task.revision,
      operations,
      mutation: mutationOf(actor),
    });
    return {
      ...workItemRef(updated),
      proof: { ...blockRef(proof), created: proofCreated },
      delivery: completedDelivery
        ? { ...blockRef(completedDelivery), deliveryKey: delivery!.key, stage: parseDeliveryIdentity(completedDelivery).stage }
        : null,
    };
  } catch (error) {
    if (!proofCreated) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${reason}. Proof ${proof.id} was created; retry with it as the existing proof`);
  }
}

// ─── Prose ─────────────────────────────────────────────────────────────────

export interface TextReplaceResult extends BlockRef {
  workId: string | null;
  previous: string;
}

function textResult(block: Block, previous: string): TextReplaceResult {
  return { ...blockRef(block), workId: getProperty(block.properties, "work-id") ?? null, previous };
}

/**
 * Replaces the body of one Markdown heading's section: exactly what Detail
 * folds under that heading, up to the next heading of the same or a higher
 * level. The heading line stays; `previous` returns what was replaced.
 */
export async function replaceNoteSection(
  client: WorkToolsClient,
  address: string,
  heading: string,
  body: string,
  actor: WorkActor,
  options: { expectedRevision?: number } = {},
): Promise<TextReplaceResult & { heading: string }> {
  const wanted = /^(#{1,6})\s+(.*)$/.exec(heading.trim());
  const title = (wanted ? wanted[2]! : heading).trim();
  const depth = wanted ? wanted[1]!.length : undefined;
  if (!title) throw new WorkToolRefusal("Name the section heading to replace");
  const block = await resolveBlock(client, address);
  const revision = requireRevision(block, options.expectedRevision);
  const text = block.text;
  const headings = markdownSourceTokens(text).flatMap((node) =>
    node.token.type === "heading" ? [{ node, depth: node.token.depth as number, text: String(node.token.text).trim() }] : []
  );
  const matches = headings.filter((candidate) => candidate.text === title && (depth === undefined || candidate.depth === depth));
  if (matches.length !== 1) {
    const available = headings.map((candidate) => `${"#".repeat(candidate.depth)} ${candidate.text}`).join("; ") || "none";
    throw new WorkToolRefusal(
      matches.length === 0
        ? `No heading "${heading.trim()}" in ${block.id}; headings: ${available}`
        : `More than one heading "${heading.trim()}" in ${block.id}; include its level (## …) or rename one`,
    );
  }
  const target = matches[0]!.node;
  const lineStarts = [0];
  for (let index = 0; index < text.length; index++) if (text[index] === "\n") lineStarts.push(index + 1);
  const headingEnd = (lineStarts[target.span.startLine + 1] ?? text.length + 1) - 1;
  const fold = documentFolds(text).find((candidate) =>
    candidate.structure === "heading" && candidate.sourceSpan!.startLine === target.span.startLine
  );
  const sectionEnd = fold ? fold.sourceSpan!.end : Math.min(text.length, headingEnd + 1);
  const previous = text.slice(Math.min(text.length, headingEnd + 1), sectionEnd).trim();
  const rest = text.slice(sectionEnd).replace(/^\n+/, "");
  const next = [text.slice(0, headingEnd), body.trim(), rest].filter(Boolean).join("\n\n");
  const updated = await client.request<Block>({
    action: "update",
    blockId: block.id,
    text: next,
    expectedRevision: revision,
    mutation: mutationOf(actor),
  });
  return { ...textResult(updated, previous), heading: `${"#".repeat(matches[0]!.depth)} ${title}` };
}

/** The first line plus any block-property lines directly under it. */
function preambleLineCount(text: string): number {
  const blockLines = parsePropertyRecords(text)
    .filter((property) => property.scope === "block" && property.syntax !== "hashtag")
    .map((property) => property.line);
  return Math.max(0, ...blockLines) + 1;
}

/**
 * Replaces everything after a block's title and block-property lines, keeping
 * those lines verbatim, and reads them back.
 */
export async function replaceItemBody(
  client: WorkToolsClient,
  address: string,
  body: string,
  actor: WorkActor,
  options: { expectedRevision?: number } = {},
): Promise<TextReplaceResult> {
  const block = await resolveBlock(client, address);
  const revision = requireRevision(block, options.expectedRevision);
  const lines = block.text.split("\n");
  const head = lines.slice(0, preambleLineCount(block.text)).join("\n");
  const previous = lines.slice(preambleLineCount(block.text)).join("\n").trim();
  const content = body.trim();
  const updated = await client.request<Block>({
    action: "update",
    blockId: block.id,
    text: content ? `${head}\n\n${content}` : head,
    expectedRevision: revision,
    mutation: mutationOf(actor),
  });
  if (updated.text.split("\n").slice(0, preambleLineCount(block.text)).join("\n") !== head) {
    throw new Error(`${block.id} did not keep its title and properties`);
  }
  return textResult(updated, previous);
}
