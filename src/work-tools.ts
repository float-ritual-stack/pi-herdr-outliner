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
import { deliveryIdentities, parseDeliveryIdentity, type DeliveryIdentity } from "./delivery-lifecycle";
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

function isDeliveryBlock(block: Block): boolean {
  return block.properties.some((property) => property.key === "type" && property.value === "delivery");
}

/**
 * A roadmap item or one of its deliveries: a block UUID, a Work ID, or a
 * delivery key (`PIE-123/door`), which is looked up among that item's
 * deliveries rather than by title.
 */
async function resolveItemOrDelivery(client: WorkToolsClient, address: string): Promise<Block> {
  const trimmed = address.trim();
  const slash = trimmed.indexOf("/");
  if (slash > 0 && parseWorkId(trimmed.slice(0, slash))) {
    const task = await resolveWorkItem(client, trimmed.slice(0, slash));
    const workId = requireWorkItem(task);
    return findItemDelivery(workId, await itemDeliveries(client, task), trimmed.slice(slash + 1)).block;
  }
  return resolveBlock(client, address);
}

/**
 * Sets one single-valued property on a roadmap item, revision-checked, and
 * reads the value back. `work-stage` must be a known stage; Done needs proof,
 * so it goes through `completeWorkItem` instead. On a delivery (its block
 * UUID or key) only `delivery-stage` can be set, through `setDeliveryStage`.
 */
export async function setWorkProperty(
  client: WorkToolsClient,
  address: string,
  rawKey: string,
  rawValue: string,
  actor: WorkActor,
  options: { expectedRevision?: number } = {},
): Promise<WorkSetResult | DeliveryStageResult> {
  const { key, value } = validateProperty(normalizePropertyKey(rawKey), rawValue);
  if (key === "delivery-stage") {
    const block = await resolveItemOrDelivery(client, address);
    if (!isDeliveryBlock(block)) {
      throw new WorkToolRefusal(`[delivery-stage::…] belongs to a delivery; name its block UUID or key (PIE-123/primary), not ${block.id}`);
    }
    return setDeliveryStage(client, block, value, actor, options);
  }
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
  const block = await resolveItemOrDelivery(client, address);
  if (isDeliveryBlock(block)) {
    throw new WorkToolRefusal(`On a delivery, work set changes only delivery-stage, not ${key}`);
  }
  requireWorkItem(block);
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
  return setWorkProperty(client, address, "work-stage", stage, actor, options) as Promise<WorkSetResult>;
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

const DELIVERY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The item's deliveries, as recorded beneath it. */
async function itemDeliveries(client: WorkToolsClient, task: Block): Promise<DeliveryIdentity[]> {
  return deliveryIdentities(await client.request<Block[]>({ action: "children", parentId: task.id }));
}

/**
 * A full delivery key for `workId`: `door` becomes `PIE-123/door`; a full key
 * must belong to this item.
 */
export function deliveryKeyFor(workId: string, name: string): string {
  const trimmed = name.trim();
  const slash = trimmed.indexOf("/");
  if (slash >= 0) {
    if (trimmed.slice(0, slash).toUpperCase() !== workId.toUpperCase()) {
      throw new WorkToolRefusal(`Delivery key ${trimmed} does not belong to ${workId}; give a name such as "door"`);
    }
  }
  const suffix = slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
  if (!DELIVERY_NAME.test(suffix)) {
    throw new WorkToolRefusal(`Delivery name "${suffix}" must be letters, digits, ".", "_" or "-", such as "door"`);
  }
  return `${workId.toUpperCase()}/${suffix}`;
}

function describeDelivery(delivery: DeliveryIdentity): string {
  return `${delivery.key} (${delivery.repository}:${delivery.workBranch})`;
}

/**
 * Which delivery a PR is recorded under when no key is given: the delivery
 * already recording this repository and branch; else `primary`; else, when
 * primary belongs to another repository, one named after this repository
 * (`owner/ep0ch-door` → `ep0ch-door`). A second branch in primary's own
 * repository needs an explicit name.
 */
export function defaultDeliveryKey(
  workId: string,
  deliveries: readonly DeliveryIdentity[],
  repository: string,
  workBranch: string,
): string {
  const same = deliveries.filter((delivery) => delivery.repository === repository && delivery.workBranch === workBranch);
  if (same.length === 1) return same[0]!.key;
  if (same.length > 1) {
    throw new WorkToolRefusal(`More than one delivery records ${repository}:${workBranch} (${same.map((d) => d.key).join(", ")}); pass --key`);
  }
  const primaryKey = deliveryKeyFor(workId, "primary");
  const primary = deliveries.find((delivery) => delivery.key === primaryKey);
  if (!primary) return primaryKey;
  if (primary.repository === repository) {
    throw new WorkToolRefusal(
      `${describeDelivery(primary)} already records another branch of ${repository}; ` +
        `pass --key <name> to record ${workBranch} as a second delivery`,
    );
  }
  return deliveryKeyFor(workId, repository.split("/")[1]!);
}

/**
 * Records a pull request as one of the item's deliveries (`deliveries.ensure`)
 * and syncs its facts (`deliveries.sync`): open → Review, merged → Validate.
 * The PR must be the delivery's branch into its base, so a wrong number is
 * refused rather than recorded. `deliveryKey` is a name (`door`) or a full key
 * (`PIE-123/door`); omitted, `defaultDeliveryKey` chooses one.
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
  const deliveries = await itemDeliveries(client, task);
  const deliveryKey = input.deliveryKey === undefined
    ? defaultDeliveryKey(workId, deliveries, input.repository, workBranch)
    : deliveryKeyFor(workId, input.deliveryKey);
  const existing = deliveries.find((delivery) => delivery.key === deliveryKey);
  if (existing && (existing.repository !== input.repository || existing.workBranch !== workBranch || existing.baseBranch !== baseBranch)) {
    throw new WorkToolRefusal(
      `${existing.key} already records ${existing.repository}:${existing.workBranch} into ${existing.baseBranch}; ` +
        `pass --key <name> to record ${input.repository}:${workBranch} as another delivery`,
    );
  }
  const ensured = await client.request<DeliveryReceipt>({
    action: "deliveries.ensure",
    input: {
      taskBlockId: task.id,
      deliveryKey,
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

export interface DeliveryRef extends BlockRef {
  deliveryKey: string;
  stage: string;
}

export interface WorkCompleteResult extends WorkItemRef {
  proof: BlockRef & { created: boolean };
  /** The deliveries this completion covered, each now Complete. */
  deliveries: DeliveryRef[];
}

function deliveryRef(block: Block): DeliveryRef {
  const delivery = parseDeliveryIdentity(block);
  return { ...blockRef(block), deliveryKey: delivery.key, stage: delivery.stage };
}

function isMerged(delivery: DeliveryIdentity): boolean {
  return (delivery.stage === "validate" || delivery.stage === "complete") && delivery.mergeCommit !== null;
}

/**
 * One of the item's deliveries, named by block UUID (optionally `((uuid))`),
 * full key (`PIE-123/door`) or name (`door`).
 */
function findItemDelivery(workId: string, deliveries: readonly DeliveryIdentity[], address: string | Block): DeliveryIdentity {
  const listed = () => deliveries.map((delivery) => `${delivery.key} ${delivery.block.id}`).join(", ") || "none";
  if (typeof address !== "string") {
    const match = deliveries.find((delivery) => delivery.block.id === address.id);
    if (!match) throw new WorkToolRefusal(`Delivery ${address.id} does not belong to ${workId}; its deliveries: ${listed()}`);
    return match;
  }
  const trimmed = address.trim().replace(/^\(\((.*)\)\)$/, "$1").trim();
  const match = BLOCK_ID.test(trimmed)
    ? deliveries.find((delivery) => delivery.block.id === trimmed.toLowerCase())
    : deliveries.find((delivery) => delivery.key.toUpperCase() === deliveryKeyFor(workId, trimmed).toUpperCase());
  if (!match) throw new WorkToolRefusal(`${workId} has no delivery ${trimmed}; its deliveries: ${listed()}`);
  return match;
}

/** What finishing one delivery takes, for a refusal that names it. */
function howToFinish(workId: string, delivery: DeliveryIdentity): string {
  const name = delivery.key.slice(delivery.key.indexOf("/") + 1);
  const deliver = `work deliver ${workId} --repo ${delivery.repository} --pr ${delivery.pullRequestNumber ?? "N"} --key ${name}`;
  if (isMerged(delivery)) return `merged: include it with --delivery ${delivery.key}, or use --all-merged`;
  if (delivery.pullRequestNumber === null) return `no PR recorded: record it with ${deliver}`;
  if (delivery.stage === "validate") return `in validate without a merge commit: sync it with ${deliver}`;
  return `PR #${delivery.pullRequestNumber} is not merged (${delivery.stage}): merge it and sync with ${deliver}`;
}

/**
 * Accepts an item with linked proof. Its deliveries are all covered or
 * already Complete: `deliveries` names the ones to complete (block UUID, key or
 * name), `allMerged` takes every merged one, and any other incomplete delivery
 * refuses the completion by name, so none is left behind. Each covered
 * delivery must be merged. The proof becomes a child `[type::proof]` (or an
 * existing linked block); covered deliveries become Complete and the item Done
 * with a `proof` link. Everything is checked before the first write.
 */
export async function completeWorkItem(
  client: WorkToolsClient,
  input: {
    task: string | Block;
    deliveries?: ReadonlyArray<string | Block>;
    allMerged?: boolean;
    proof: { text: string } | { blockId: string };
  },
  actor: WorkActor,
): Promise<WorkCompleteResult> {
  if (input.allMerged && input.deliveries?.length) {
    throw new WorkToolRefusal("Name deliveries or use all-merged, not both");
  }
  const task = typeof input.task === "string" ? await resolveWorkItem(client, input.task) : input.task;
  const workId = requireWorkItem(task);
  const deliveries = await itemDeliveries(client, task);
  const stage = getProperty(task.properties, "work-stage")?.toLowerCase();
  if (stage === "superseded") throw new WorkToolRefusal(`${workId} is superseded; reopen it explicitly before completing`);
  if (stage === "done") {
    const leftover = deliveries.filter((delivery) => delivery.stage !== "complete");
    throw new WorkToolRefusal(
      leftover.length === 0
        ? `${workId} is already done`
        : `${workId} is already done; finish a leftover delivery with work set <delivery> delivery-stage complete: ` +
          leftover.map((delivery) => `${delivery.key} ${delivery.block.id} (${delivery.stage})`).join(", "),
    );
  }

  const selected: DeliveryIdentity[] = [];
  if (input.allMerged) {
    selected.push(...deliveries.filter(isMerged));
  } else {
    for (const address of input.deliveries ?? []) {
      const delivery = findItemDelivery(workId, deliveries, address);
      if (!selected.includes(delivery)) selected.push(delivery);
    }
  }
  for (const delivery of selected) {
    if (!isMerged(delivery)) {
      throw new WorkToolRefusal(
        `Delivery ${delivery.key} must have a merged PR and reach Validate before completion (it is ${delivery.stage})`,
      );
    }
  }
  const remaining = deliveries.filter((delivery) => delivery.stage !== "complete" && !selected.includes(delivery));
  if (remaining.length > 0) {
    throw new WorkToolRefusal(
      `${workId} has ${remaining.length === 1 ? "another incomplete delivery" : "other incomplete deliveries"}, ` +
        `so it cannot be done yet: ` +
        remaining.map((delivery) => `${delivery.key} ${delivery.block.id} — ${howToFinish(workId, delivery)}`).join("; "),
    );
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

  const operations: PropertyPatchOperation[] = [propertyTransition(task, "work-stage", "done")];
  if (!task.properties.some((property) => property.key === "proof" && property.value === proof.id)) {
    operations.push({ op: "append", key: "proof", value: proof.id });
  }
  const completed: Block[] = [];
  try {
    for (const delivery of selected) {
      completed.push(delivery.stage === "complete" ? delivery.block : await client.request<Block>({
        action: "properties.patch",
        blockId: delivery.block.id,
        expectedRevision: delivery.block.revision,
        operations: [propertyTransition(delivery.block, "delivery-stage", "complete")],
        mutation: mutationOf(actor),
      }));
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
      deliveries: completed.map(deliveryRef),
    };
  } catch (error) {
    const written = completed.filter((block) => selected.find((delivery) => delivery.block.id === block.id)!.stage !== "complete");
    if (!proofCreated && written.length === 0) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    const notes = [
      ...(written.length ? [`${written.map((block) => parseDeliveryIdentity(block).key).join(", ")} ${written.length === 1 ? "is" : "are"} now complete`] : []),
      ...(proofCreated ? [`proof ${proof.id} was created; retry with it as the existing proof`] : []),
    ];
    throw new Error(`${reason}. ${notes.join("; ")}`);
  }
}

// ─── Delivery stage ────────────────────────────────────────────────────────

export interface DeliveryStageResult extends DeliveryRef {
  workId: string;
  taskBlockId: string;
  previous: string;
  changed: boolean;
}

/**
 * Sets a delivery's `delivery-stage` by hand, revision-checked: `complete`
 * finishes a merged delivery left in Validate (say, on an item already done);
 * `validate` reopens a complete one. Both need its merge commit. Work and
 * Review come from the PR, through `work deliver`.
 */
export async function setDeliveryStage(
  client: WorkToolsClient,
  deliveryBlock: Block,
  rawStage: string,
  actor: WorkActor,
  options: { expectedRevision?: number } = {},
): Promise<DeliveryStageResult> {
  const delivery = parseDeliveryIdentity(deliveryBlock);
  const stage = rawStage.trim().toLowerCase();
  if (stage !== "complete" && stage !== "validate") {
    throw new WorkToolRefusal(
      stage === "work" || stage === "review"
        ? `A delivery's ${stage} stage comes from its PR; sync it with work deliver`
        : `Unknown delivery stage "${rawStage}"; set complete or validate`,
    );
  }
  const revision = requireRevision(deliveryBlock, options.expectedRevision);
  if (!delivery.mergeCommit || (delivery.stage !== "validate" && delivery.stage !== "complete")) {
    throw new WorkToolRefusal(`Delivery ${delivery.key} must have a merged PR before it is ${stage} (it is ${delivery.stage})`);
  }
  const task = await getActiveBlock(client, deliveryBlock.parentId ?? "");
  const workId = requireWorkItem(task);
  const base = { workId, taskBlockId: task.id, previous: delivery.stage };
  if (delivery.stage === stage) return { ...base, ...deliveryRef(deliveryBlock), changed: false };
  const updated = await client.request<Block>({
    action: "properties.patch",
    blockId: deliveryBlock.id,
    expectedRevision: revision,
    operations: [propertyTransition(deliveryBlock, "delivery-stage", stage)],
    mutation: mutationOf(actor),
  });
  const readBack = deliveryRef(updated);
  if (readBack.stage !== stage) throw new Error(`${updated.id} reads back [delivery-stage::${readBack.stage}] after setting ${stage}`);
  return { ...base, ...readBack, changed: true };
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
  const block = await resolveBlock(client, address);
  const revision = requireRevision(block, options.expectedRevision);
  const section = replaceSectionText(block.text, heading, body, block.id);
  const updated = await client.request<Block>({
    action: "update",
    blockId: block.id,
    text: section.text,
    expectedRevision: revision,
    mutation: mutationOf(actor),
  });
  return { ...textResult(updated, section.previous), heading: section.heading };
}

/**
 * A note's text with one heading's section replaced: what Detail folds under
 * that heading, up to the next heading of the same or a higher level. The
 * heading line stays. `heading` may carry its `##` level; a missing or
 * ambiguous heading is refused, naming the headings there are.
 */
export function replaceSectionText(
  text: string,
  heading: string,
  body: string,
  blockId: string,
): { text: string; previous: string; heading: string } {
  const wanted = /^(#{1,6})\s+(.*)$/.exec(heading.trim());
  const title = (wanted ? wanted[2]! : heading).trim();
  const depth = wanted ? wanted[1]!.length : undefined;
  if (!title) throw new WorkToolRefusal("Name the section heading to replace");
  const headings = markdownSourceTokens(text).flatMap((node) =>
    node.token.type === "heading" ? [{ node, depth: node.token.depth as number, text: String(node.token.text).trim() }] : []
  );
  const matches = headings.filter((candidate) => candidate.text === title && (depth === undefined || candidate.depth === depth));
  if (matches.length !== 1) {
    const available = headings.map((candidate) => `${"#".repeat(candidate.depth)} ${candidate.text}`).join("; ") || "none";
    throw new WorkToolRefusal(
      matches.length === 0
        ? `No heading "${heading.trim()}" in ${blockId}; headings: ${available}`
        : `More than one heading "${heading.trim()}" in ${blockId}; include its level (## …) or rename one`,
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
  return {
    text: [text.slice(0, headingEnd), body.trim(), rest].filter(Boolean).join("\n\n"),
    previous,
    heading: `${"#".repeat(matches[0]!.depth)} ${title}`,
  };
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
