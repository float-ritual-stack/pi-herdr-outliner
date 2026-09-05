import { createHash } from "node:crypto";
import { createAnnotationAnchor, parseAnnotationBlock } from "./annotations";
import { normalizeBlockSearchQuery } from "./block-query";
import { parseDetailCallouts } from "./detail-callouts";
import { firstLineWithoutPropertyTokens } from "./properties";
import type { OutlinerStore } from "./store";
import type {
  Block,
  BlockCollectionCompleteness,
  BlockProvenance,
  WorkflowCapability,
  WorkflowComparison,
  WorkflowInvocation,
  WorkflowLimits,
  WorkflowMetrics,
  WorkflowPlanInput,
  WorkflowPromotionCommitInput,
  WorkflowPromotionInput,
  WorkflowPromotionPreview,
  WorkflowPromotionReceipt,
  WorkflowRun,
  WorkflowStartInput,
  WorkflowStartReceipt,
  WorkflowStep,
  WorkflowStructure,
  WorkflowStructureItem,
  WorkflowStructureRegion,
  WorkflowTransitionInput,
} from "./types";

const MAX_WORKFLOW_FAN_OUT = 20;
const MAX_WORKFLOW_CALLS = 50;
const MAX_WORKFLOW_LIST = 100;
const MAX_WORKFLOW_ROUTE = 200;
const WORKFLOW_ACTION = "walkthrough.plan" as const;
const CAPABILITIES: readonly WorkflowCapability[] = [
  "outline.structure",
  "outline.route",
  "attention.mark",
  "annotations.create",
  "annotations.reply",
  "annotations.batch",
  "promotion.preview",
  "promotion.commit",
];
const PROMOTION_KINDS = ["decision", "follow-up", "task", "artifact"] as const;

interface WorkflowRunRow {
  run_id: string;
  request_id: string;
  action_id: string;
  invocation_json: string;
  capabilities_json: string;
  limits_json: string;
  planner: string;
  target_client_id: string | null;
  provenance_json: string | null;
  status: string;
  route_json: string;
  current_step_index: number | null;
  branch_question_json: string | null;
  metrics_json: string | null;
  comparison_json: string | null;
  result_block_ids_json: string;
  cancellation_requested: number;
  error: string | null;
  created_at: string;
  updated_at: string;
  request_hash: string;
}

interface PromotionRow {
  block_id: string;
  proposal_hash: string;
}

function printable(value: unknown, label: string, maximum = 500): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} must be 1-${maximum} printable characters`);
  }
  return normalized;
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return Number(value);
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`Corrupt ${label}`);
  }
}

function normalizeCapabilities(value: unknown): WorkflowCapability[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Workflow capabilities must be a non-empty array");
  }
  const capabilities = [...new Set(value.map((candidate) => {
    if (!CAPABILITIES.includes(candidate as WorkflowCapability)) {
      throw new Error(`Unsupported workflow capability: ${String(candidate)}`);
    }
    return candidate as WorkflowCapability;
  }))];
  for (const required of ["outline.structure", "outline.route"] as const) {
    if (!capabilities.includes(required)) throw new Error(`Workflow capability is required: ${required}`);
  }
  return capabilities;
}

function normalizeLimits(value: WorkflowLimits): WorkflowLimits {
  if (!value || typeof value !== "object") throw new Error("Workflow limits are required");
  return {
    fanOut: boundedInteger(value.fanOut, "Workflow fan-out limit", 1, MAX_WORKFLOW_FAN_OUT),
    calls: boundedInteger(value.calls, "Workflow call limit", 2, MAX_WORKFLOW_CALLS),
  };
}

function normalizeInvocation(value: WorkflowInvocation): WorkflowInvocation {
  if (!value || typeof value !== "object") throw new Error("Workflow invocation is required");
  if (value.kind === "block") {
    return { kind: "block", sourceBlockId: printable(value.sourceBlockId, "Workflow source block ID", 200) };
  }
  if (value.kind === "callout") {
    return {
      kind: "callout",
      sourceBlockId: printable(value.sourceBlockId, "Workflow source block ID", 200),
      calloutType: printable(value.calloutType, "Workflow callout type", 100).toLowerCase(),
      ...(value.calloutIndex === undefined
        ? {}
        : { calloutIndex: boundedInteger(value.calloutIndex, "Workflow callout index", 0, 1_000) }),
    };
  }
  if (value.kind === "query") {
    return { kind: "query", query: normalizeBlockSearchQuery(value.query) };
  }
  if (value.kind === "command") {
    const command = printable(value.command, "Workflow command", 100).toLowerCase();
    if (command !== "walkthrough") throw new Error(`Unsupported workflow command: ${command}`);
    return {
      kind: "command",
      command,
      ...(value.sourceBlockId
        ? { sourceBlockId: printable(value.sourceBlockId, "Workflow source block ID", 200) }
        : {}),
    };
  }
  throw new Error(`Unsupported workflow invocation: ${String((value as { kind?: unknown }).kind)}`);
}

function normalizeProvenance(value: WorkflowStartInput["provenance"]): WorkflowStartInput["provenance"] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") throw new Error("Workflow provenance must be an object");
  return {
    actorId: printable(value.actorId, "Workflow provenance actor ID", 200),
    ...(value.sessionId
      ? { sessionId: printable(value.sessionId, "Workflow provenance session ID", 500) }
      : {}),
    ...(value.taskId
      ? { taskId: printable(value.taskId, "Workflow provenance task ID", 500) }
      : {}),
  };
}

export function normalizeWorkflowStartInput(input: WorkflowStartInput): WorkflowStartInput {
  if (!input || typeof input !== "object") throw new Error("Workflow start input is required");
  if (input.actionId !== WORKFLOW_ACTION) throw new Error(`Unsupported workflow action: ${String(input.actionId)}`);
  if (input.planner !== "pi-direct" && input.planner !== "callscript") {
    throw new Error(`Unsupported workflow planner: ${String(input.planner)}`);
  }
  return {
    requestId: printable(input.requestId, "Workflow request ID", 200),
    actionId: input.actionId,
    invocation: normalizeInvocation(input.invocation),
    capabilities: normalizeCapabilities(input.capabilities),
    limits: normalizeLimits(input.limits),
    planner: input.planner,
    ...(input.targetClientId
      ? { targetClientId: printable(input.targetClientId, "Workflow target client ID", 200) }
      : {}),
    ...(input.provenance ? { provenance: normalizeProvenance(input.provenance) } : {}),
  };
}

function sourceBlockId(invocation: WorkflowInvocation): string | null {
  return invocation.kind === "query" ? invocation.query.subtreeRootId ?? null : invocation.sourceBlockId ?? null;
}

function headingRegions(block: Block): WorkflowStructureRegion[] {
  const regions: WorkflowStructureRegion[] = [];
  const pattern = /^(#{1,6})[ \t]+([^\r\n]+)$/gm;
  for (const match of block.text.matchAll(pattern)) {
    const rawTitle = match[2]!.replace(/[ \t]+\^[-\w]+[ \t]*$/, "").trim();
    if (!rawTitle) continue;
    const line = match[0]!;
    const titleOffset = line.indexOf(rawTitle);
    const start = (match.index ?? 0) + titleOffset;
    regions.push({
      regionId: `heading:${start}`,
      title: rawTitle,
      target: {
        kind: "block",
        sourceBlockId: block.id,
        anchor: createAnnotationAnchor(block.text, start, start + rawTitle.length, block.updatedAt),
      },
      sourceBytes: Buffer.byteLength(rawTitle),
    });
  }
  return regions;
}

function calloutRegions(block: Block, invocation: Extract<WorkflowInvocation, { kind: "callout" }>): WorkflowStructureRegion[] {
  const matches = parseDetailCallouts(block.text).filter((callout) => callout.calloutType === invocation.calloutType);
  const selected = invocation.calloutIndex === undefined ? matches : matches.slice(invocation.calloutIndex, invocation.calloutIndex + 1);
  return selected.map((callout) => {
    const span = callout.sourceSpan!;
    const calloutSource = block.text.slice(span.start, span.end);
    const titleOffset = calloutSource.indexOf(callout.title);
    const start = span.start + Math.max(0, titleOffset);
    const end = start + callout.title.length;
    return {
      regionId: callout.id,
      title: callout.title,
      target: {
        kind: "block" as const,
        sourceBlockId: block.id,
        anchor: createAnnotationAnchor(block.text, start, end, block.updatedAt),
      },
      sourceBytes: Buffer.byteLength(callout.title),
    };
  });
}

function structureItem(block: Block, depth: number, invocation: WorkflowInvocation): WorkflowStructureItem {
  let regions = invocation.kind === "callout" && block.id === invocation.sourceBlockId
    ? calloutRegions(block, invocation)
    : headingRegions(block);
  if (regions.length === 0) {
    regions = [{
      regionId: "block",
      title: firstLineWithoutPropertyTokens(block.text) || "Untitled block",
      target: {
        kind: "block",
        sourceBlockId: block.id,
        sourceVersion: block.updatedAt,
      },
      sourceBytes: 0,
    }];
  }
  return {
    sourceBytes: Buffer.byteLength(block.text),
    blockId: block.id,
    title: firstLineWithoutPropertyTokens(block.text) || "Untitled block",
    updatedAt: block.updatedAt,
    depth,
    properties: block.properties,
    regions,
  };
}

function semanticRank(title: string): number {
  const normalized = title.toLowerCase();
  if (/\b(goal|problem|context|why|overview)\b/.test(normalized)) return 0;
  if (/\b(decision|contract|approach|architecture)\b/.test(normalized)) return 1;
  if (/\b(acceptance|check|risk|warning|question)\b/.test(normalized)) return 2;
  if (/\b(next|action|follow-up|result|proof)\b/.test(normalized)) return 4;
  return 3;
}

export function planWorkflowRoute(structure: WorkflowStructure): WorkflowStep[] {
  return structure.items
    .flatMap((item) => item.regions.map((region) => ({ item, region })))
    .sort((left, right) =>
      semanticRank(left.region.title) - semanticRank(right.region.title) ||
      left.item.depth - right.item.depth ||
      left.item.blockId.localeCompare(right.item.blockId) ||
      left.region.regionId.localeCompare(right.region.regionId)
    )
    .slice(0, MAX_WORKFLOW_ROUTE)
    .map(({ item, region }, ordinal) => ({
      stepId: `${item.blockId}:${region.regionId}`,
      ordinal,
      title: region.title,
      target: region.target,
      sourceRevision: item.updatedAt,
      status: "pending" as const,
    }));
}

function normalizeMetrics(metrics: WorkflowMetrics): WorkflowMetrics {
  if (!metrics || typeof metrics !== "object") throw new Error("Workflow metrics are required");
  if (metrics.planner !== "pi-direct" && metrics.planner !== "callscript") {
    throw new Error("Workflow metric planner is invalid");
  }
  if (!metrics.completeness || (metrics.completeness.kind !== "complete" && metrics.completeness.kind !== "truncated")) {
    throw new Error("Workflow completeness is required");
  }
  if (!metrics.structureFirst) throw new Error("Walkthrough planning must be structure-first");
  if (!["unrated", "usable", "needs-revision"].includes(metrics.artifactQuality)) {
    throw new Error("Workflow artifact quality is invalid");
  }
  const completeness = metrics.completeness.kind === "complete"
    ? { kind: "complete" as const }
    : {
        kind: "truncated" as const,
        limit: boundedInteger(metrics.completeness.limit, "Workflow completeness limit", 1, 100_000),
      };
  return {
    planner: metrics.planner,
    modelTurns: boundedInteger(metrics.modelTurns, "Workflow model turns", 0, 10_000),
    operations: boundedInteger(metrics.operations, "Workflow operations", 0, 100_000),
    contextBytes: boundedInteger(metrics.contextBytes, "Workflow context bytes", 0, 100_000_000),
    wallTimeMs: boundedInteger(metrics.wallTimeMs, "Workflow wall time", 0, 86_400_000),
    completeness,
    artifactQuality: metrics.artifactQuality,
    structureFirst: true,
  };
}

function normalizeComparison(comparison: WorkflowComparison): WorkflowComparison {
  if (!comparison || typeof comparison !== "object") {
    throw new Error("Workflow comparison must be an object");
  }
  const direct = normalizeMetrics(comparison.direct);
  const callscript = normalizeMetrics(comparison.callscript);
  if (direct.planner !== "pi-direct" || callscript.planner !== "callscript") {
    throw new Error("Workflow comparison planner identities are invalid");
  }
  return {
    direct,
    callscript,
    contextBytesSaved: Math.max(0, direct.contextBytes - callscript.contextBytes),
    operationDelta: direct.operations - callscript.operations,
  };
}

function normalizeRoute(route: readonly WorkflowStep[], store: OutlinerStore): WorkflowStep[] {
  if (!Array.isArray(route) || route.length === 0 || route.length > MAX_WORKFLOW_ROUTE) {
    throw new Error(`Workflow route must contain 1-${MAX_WORKFLOW_ROUTE} steps`);
  }
  const ids = new Set<string>();
  return route.map((step, ordinal) => {
    const stepId = printable(step.stepId, "Workflow step ID", 500);
    if (ids.has(stepId)) throw new Error(`Duplicate workflow step ID: ${stepId}`);
    ids.add(stepId);
    const source = store.requireActive(step.target.sourceBlockId);
    if (step.target.kind !== "block") throw new Error("The walkthrough prototype supports block anchors only");
    const anchor = step.target.anchor;
    if (anchor && (
      anchor.sourceVersion !== source.updatedAt ||
      source.text.slice(anchor.start, anchor.end) !== anchor.excerpt
    )) {
      throw new Error(`Workflow step source evidence is stale: ${stepId}`);
    }
    return {
      stepId,
      ordinal,
      title: printable(step.title, "Workflow step title", 500),
      target: step.target,
      sourceRevision: source.updatedAt,
      status: "pending",
    };
  });
}

function workflowJsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}
function promotionText(input: WorkflowPromotionInput): string {
  return [
    printable(input.title, "Workflow promotion title", 500),
    `[type::${input.kind}] [source-block::${input.annotationId}] [workflow-run::${input.runId}] [workflow-step::${input.stepId}] [approved-by::${input.approvedBy}]`,
    input.body?.trim() ?? "",
  ].filter(Boolean).join("\n\n");
}

function promotionToken(input: WorkflowPromotionInput, text: string): string {
  return createHash("sha256").update(JSON.stringify({ input, text })).digest("hex");
}

export class WorkflowManager {
  constructor(private readonly store: OutlinerStore) {
    this.store.database.exec(`
      CREATE TABLE IF NOT EXISTS workflow_runs (
        run_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        action_id TEXT NOT NULL,
        invocation_json TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        limits_json TEXT NOT NULL,
        planner TEXT NOT NULL,
        target_client_id TEXT,
        provenance_json TEXT,
        status TEXT NOT NULL,
        route_json TEXT NOT NULL,
        current_step_index INTEGER,
        branch_question_json TEXT,
        metrics_json TEXT,
        comparison_json TEXT,
        result_block_ids_json TEXT NOT NULL,
        cancellation_requested INTEGER NOT NULL DEFAULT 0,
        request_hash TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS workflow_runs_updated ON workflow_runs(updated_at DESC);
      CREATE TABLE IF NOT EXISTS workflow_promotions (
        request_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
        step_id TEXT NOT NULL,
        annotation_id TEXT NOT NULL REFERENCES blocks(id),
        block_id TEXT NOT NULL REFERENCES blocks(id),
        proposal_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    const workflowColumns = this.store.database
      .query("PRAGMA table_info(workflow_runs)")
      .all() as Array<{ name: string }>;
    if (!workflowColumns.some((column) => column.name === "provenance_json")) {
      this.store.database.exec("ALTER TABLE workflow_runs ADD COLUMN provenance_json TEXT");
    }
  }

  private row(runId: string): WorkflowRunRow {
    const row = this.store.database.query("SELECT * FROM workflow_runs WHERE run_id = ?").get(runId) as WorkflowRunRow | null;
    if (!row) throw new Error(`Workflow run not found: ${runId}`);
    return row;
  }

  private parseRun(row: WorkflowRunRow): WorkflowRun {
    return {
      runId: row.run_id,
      requestId: row.request_id,
      actionId: row.action_id as WorkflowRun["actionId"],
      invocation: parseJson(row.invocation_json, "workflow invocation"),
      capabilities: parseJson(row.capabilities_json, "workflow capabilities"),
      limits: parseJson(row.limits_json, "workflow limits"),
      planner: row.planner as WorkflowRun["planner"],
      ...(row.target_client_id ? { targetClientId: row.target_client_id } : {}),
      ...(row.provenance_json
        ? { provenance: parseJson(row.provenance_json, "workflow provenance") }
        : {}),
      status: row.status as WorkflowRun["status"],
      route: parseJson(row.route_json, "workflow route"),
      currentStepIndex: row.current_step_index,
      ...(row.branch_question_json
        ? { branchQuestion: parseJson(row.branch_question_json, "workflow branch question") }
        : {}),
      ...(row.metrics_json ? { metrics: parseJson(row.metrics_json, "workflow metrics") } : {}),
      ...(row.comparison_json
        ? { comparison: parseJson(row.comparison_json, "workflow comparison") }
        : {}),
      resultBlockIds: parseJson(row.result_block_ids_json, "workflow result blocks"),
      cancellationRequested: row.cancellation_requested === 1,
      ...(row.error ? { error: row.error } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  get(runId: string): WorkflowRun {
    return this.parseRun(this.row(printable(runId, "Workflow run ID", 200)));
  }

  list(limit = 20): WorkflowRun[] {
    const normalizedLimit = boundedInteger(limit, "Workflow list limit", 1, MAX_WORKFLOW_LIST);
    return (this.store.database.query("SELECT * FROM workflow_runs ORDER BY updated_at DESC LIMIT ?").all(normalizedLimit) as WorkflowRunRow[])
      .map((row) => this.parseRun(row));
  }

  start(input: WorkflowStartInput): WorkflowStartReceipt {
    const normalized = normalizeWorkflowStartInput(input);
    const requestHash = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
    const existing = this.store.database.query(
      "SELECT * FROM workflow_runs WHERE request_id = ?",
    ).get(normalized.requestId) as WorkflowRunRow | null;
    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw new Error("Workflow request ID was already used with different input");
      }
      return { run: this.parseRun(existing), deduplicated: true };
    }
    const invocationSource = sourceBlockId(normalized.invocation);
    if (invocationSource) this.store.requireActive(invocationSource);
    const now = new Date().toISOString();
    const runId = crypto.randomUUID();
    this.store.database.query(
      `INSERT INTO workflow_runs (
        run_id, request_id, request_hash, action_id, invocation_json,
        capabilities_json, limits_json, planner, target_client_id, provenance_json, status,
        route_json, current_step_index, result_block_ids_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planning', '[]', NULL, '[]', ?, ?)`,
    ).run(
      runId,
      normalized.requestId,
      requestHash,
      normalized.actionId,
      JSON.stringify(normalized.invocation),
      JSON.stringify(normalized.capabilities),
      JSON.stringify(normalized.limits),
      normalized.planner,
      normalized.targetClientId ?? null,
      normalized.provenance ? JSON.stringify(normalized.provenance) : null,
      now,
      now,
    );
    return { run: this.get(runId), deduplicated: false };
  }

  structure(runId: string): WorkflowStructure {
    const run = this.get(runId);
    if (run.cancellationRequested || run.status === "cancelled") throw new Error("Workflow run is cancelled");
    if (!run.capabilities.includes("outline.structure")) throw new Error("Workflow run lacks outline.structure capability");
    let blocks: Array<Block & { depth?: number }>;
    let completeness: BlockCollectionCompleteness = { kind: "complete" };
    if (run.invocation.kind === "query") {
      const query = { ...run.invocation.query, limit: Math.min(run.limits.fanOut, run.invocation.query.limit) };
      const result = this.store.queryBlocks(query);
      blocks = result.blocks;
      completeness = result.completeness;
    } else {
      const rootId = sourceBlockId(run.invocation);
      if (!rootId) throw new Error("Workflow command requires a source block");
      const result = this.store.queryBlocks({ subtreeRootId: rootId, limit: run.limits.fanOut });
      blocks = result.blocks;
      completeness = result.completeness;
    }
    const items = blocks.map((block) => structureItem(block, block.depth ?? 0, run.invocation));
    const structure: WorkflowStructure = {
      invocation: run.invocation,
      items,
      completeness,
      contextBytes: 0,
    };
    structure.contextBytes = workflowJsonBytes(structure);
    return structure;
  }

  savePlan(input: WorkflowPlanInput): WorkflowRun {
    const run = this.get(input.runId);
    if (run.status === "cancelled" || run.cancellationRequested) throw new Error("Workflow run is cancelled");
    if (run.status !== "planning" && run.status !== "ready") {
      throw new Error(`Workflow plan cannot be saved from ${run.status}`);
    }
    if (!run.capabilities.includes("outline.route")) throw new Error("Workflow run lacks outline.route capability");
    const route = normalizeRoute(input.route, this.store);
    const metrics = normalizeMetrics(input.metrics);
    if (metrics.planner !== run.planner) throw new Error("Workflow metric planner does not match the run planner");
    const comparison = input.comparison ? normalizeComparison(input.comparison) : undefined;
    if (comparison) {
      const selected = run.planner === "callscript" ? comparison.callscript : comparison.direct;
      if (JSON.stringify(metrics) !== JSON.stringify(selected)) {
        throw new Error("Workflow selected metrics do not match the planner comparison");
      }
    }
    const now = new Date().toISOString();
    this.store.database.query(
      `UPDATE workflow_runs SET status = 'ready', route_json = ?, current_step_index = 0,
       metrics_json = ?, comparison_json = ?, updated_at = ? WHERE run_id = ?`,
    ).run(
      JSON.stringify(route),
      JSON.stringify(metrics),
      comparison ? JSON.stringify(comparison) : null,
      now,
      run.runId,
    );
    return this.get(run.runId);
  }

  retarget(runId: string, targetClientId: string): WorkflowRun {
    const run = this.get(runId);
    if (run.status === "cancelled" || run.status === "failed" || run.status === "completed") {
      throw new Error(`Workflow retarget is unavailable from ${run.status}`);
    }
    if (!run.capabilities.includes("attention.mark")) {
      throw new Error("Workflow run lacks attention.mark capability");
    }
    const target = printable(targetClientId, "Workflow target client ID", 200);
    this.store.database.query(
      "UPDATE workflow_runs SET target_client_id = ?, updated_at = ? WHERE run_id = ?",
    ).run(target, new Date().toISOString(), run.runId);
    return this.get(run.runId);
  }
  transition(input: WorkflowTransitionInput): WorkflowRun {
    const run = this.get(input.runId);
    if (run.status === "cancelled" || run.status === "failed" || run.status === "completed") {
      throw new Error(`Workflow transition is unavailable from ${run.status}`);
    }

    if (run.route.length === 0 || run.currentStepIndex === null) {
      throw new Error("Workflow route is not ready");
    }
    let status: WorkflowRun["status"] = run.status;
    let index: number = run.currentStepIndex;
    let branchQuestion = run.branchQuestion;
    let route = run.route.map((step) => ({ ...step }));
    if (input.action === "pause") {
      status = "paused";
    } else if (input.action === "resume") {
      status = "active";
    } else if (input.action === "branch") {
      branchQuestion = {
        stepId: route[index]!.stepId,
        question: printable(input.question, "Workflow branch question", 1_000),
        createdAt: new Date().toISOString(),
      };
      status = "paused";
    } else if (input.action === "end") {
      status = "completed";
      route = route.map((step) => step.status === "current" ? { ...step, status: "visited" } : step);
    } else {
      if (run.status === "ready" && input.action === "next") {
        index = 0;
      } else if (input.action === "previous") {
        index = Math.max(0, index - 1);
      } else {
        if (input.action === "skip") route[index] = { ...route[index]!, status: "skipped" };
        else if (route[index]!.status === "current") route[index] = { ...route[index]!, status: "visited" };
        index = Math.min(route.length - 1, index + 1);
      }
      status = "active";
      branchQuestion = undefined;
      route = route.map((step, candidateIndex) =>
        candidateIndex === index ? { ...step, status: "current" } : step.status === "current" ? { ...step, status: "visited" } : step
      );
    }
    const now = new Date().toISOString();
    this.store.database.query(
      `UPDATE workflow_runs SET status = ?, route_json = ?, current_step_index = ?,
       branch_question_json = ?, updated_at = ? WHERE run_id = ?`,
    ).run(
      status,
      JSON.stringify(route),
      index,
      branchQuestion ? JSON.stringify(branchQuestion) : null,
      now,
      run.runId,
    );
    return this.get(run.runId);
  }

  cancel(runId: string): WorkflowRun {
    const run = this.get(runId);
    if (run.status === "completed") throw new Error("Completed workflow runs cannot be cancelled");
    const now = new Date().toISOString();
    this.store.database.query(
      "UPDATE workflow_runs SET status = 'cancelled', cancellation_requested = 1, updated_at = ? WHERE run_id = ?",
    ).run(now, run.runId);
    return this.get(run.runId);
  }

  previewPromotion(input: WorkflowPromotionInput): WorkflowPromotionPreview {
    const run = this.get(input.runId);
    if (!run.capabilities.includes("promotion.preview")) throw new Error("Workflow run lacks promotion.preview capability");
    if (!PROMOTION_KINDS.includes(input.kind)) throw new Error(`Unsupported workflow promotion kind: ${String(input.kind)}`);
    const step = run.route.find((candidate) => candidate.stepId === input.stepId);
    if (!step) throw new Error(`Workflow step not found: ${input.stepId}`);
    const annotation = parseAnnotationBlock(this.store.requireActive(input.annotationId));
    if (annotation.target.sourceBlockId !== step.target.sourceBlockId) {
      throw new Error("Workflow promotion annotation does not belong to the selected step source");
    }
    const normalized: WorkflowPromotionInput = {
      runId: run.runId,
      stepId: step.stepId,
      annotationId: annotation.block.id,
      kind: input.kind,
      title: printable(input.title, "Workflow promotion title", 500),
      approvedBy: printable(input.approvedBy, "Workflow promotion approver", 200),
      ...(input.body?.trim() ? { body: input.body.trim() } : {}),
      ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
    };
    const text = promotionText(normalized);
    return { input: normalized, text, approvalToken: promotionToken(normalized, text) };
  }

  commitPromotion(
    input: WorkflowPromotionCommitInput,
    provenance?: BlockProvenance,
  ): WorkflowPromotionReceipt {
    const requestId = printable(input.requestId, "Workflow promotion request ID", 200);
    const preview = this.previewPromotion(input.input);
    if (input.approvalToken !== preview.approvalToken) {
      throw new Error("Workflow promotion approval token does not match the exact preview");
    }
    const commitHash = preview.approvalToken;
    return this.store.database.transaction(() => {
      const existing = this.store.database.query(
        "SELECT block_id, proposal_hash FROM workflow_promotions WHERE request_id = ?",
      ).get(requestId) as PromotionRow | null;
      if (existing) {
        if (existing.proposal_hash !== commitHash) {
          throw new Error("Workflow promotion request ID was already used with different approval");
        }
        return {
          run: this.get(preview.input.runId),
          block: this.store.requireActive(existing.block_id),
          deduplicated: true,
        };
      }
      const run = this.get(preview.input.runId);
      if (!run.capabilities.includes("promotion.commit")) {
        throw new Error("Workflow run lacks promotion.commit capability");
      }
      const parentId = preview.input.parentId ?? sourceBlockId(run.invocation) ?? null;
      if (parentId) this.store.requireActive(parentId);
      const block = this.store.create(preview.text, parentId, "agent", provenance);
      const now = new Date().toISOString();
      this.store.database.query(
        `INSERT INTO workflow_promotions
         (request_id, run_id, step_id, annotation_id, block_id, proposal_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        requestId,
        run.runId,
        preview.input.stepId,
        preview.input.annotationId,
        block.id,
        commitHash,
        now,
      );
      this.store.database.query(
        "UPDATE workflow_runs SET result_block_ids_json = ?, updated_at = ? WHERE run_id = ?",
      ).run(JSON.stringify([...run.resultBlockIds, block.id]), now, run.runId);
      return { run: this.get(run.runId), block, deduplicated: false };
    })();
  }
}
