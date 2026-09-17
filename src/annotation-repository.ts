import { Database } from "bun:sqlite";
import { isAbsolute, resolve } from "node:path";
import {
  annotationSourceHash,
  formatAnnotationBlock,
  normalizeAnnotationCreateInput,
  normalizeAnnotationRepresentation,
  normalizeAnnotationSubject,
  normalizeAnnotationTarget,
  normalizeResolutionMethod,
  normalizeResolutionReviewer,
  OBSOLETE_ANNOTATION_PROPERTY_KEYS,
  parseAnnotationBlockContent,
  parseLegacyAnnotationBlock,
  parseStoredRepresentation,
  parseStoredTarget,
  type AnnotationBlockContent,
  type LegacyAnnotationEvidence,
  normalizeResolutionCandidate,
} from "./annotations";
import { parsePropertyRecords } from "./properties";
import { reanchorAnnotationTarget } from "./annotation-reanchoring";
import type { ResourceCatalog } from "./resource-catalog";
import { normalizeRetainedResourceRevisionRef } from "./resources";
import type {
  AnnotationAgentEvidenceSample,
  AnnotationAgentEvidenceSummary,
  AnnotationAgentPromptPackage,
  AnnotationAgentProposalInput,
  AnnotationAgentProposalReceipt,
  AnnotationAgentReviewInput,
  AnnotationApproveResolutionInput,
  AnnotationBatchOperation,
  AnnotationBatchReceipt,
  AnnotationCreateInput,
  AnnotationLifecycleInput,
  AnnotationListQuery,
  AnnotationRecord,
  AnnotationReconcileInput,
  AnnotationReconcileReceipt,
  AnnotationRepresentation,
  AnnotationResolutionCandidate,
  AnnotationResolutionEvent,
  AnnotationResolutionMethod,
  AnnotationResolutionReviewer,
  AnnotationResolutionStatus,
  AnnotationSource,
  AnnotationSubject,
  AnnotationTarget,
  AnnotationThread,
  Block,
  BlockAuthor,
  BlockProvenance,
  MutationProvenance,
  Resource,
} from "./types";

const SYSTEM_ANNOTATIONS_ROOT_ID = "7674db6f-6639-4d49-bb63-9ed50cdbba08";
const MIGRATION_MARKER = "pie250_annotation_repository";
const TEXT_CODEC = { kind: "codec", codecId: "text-quote", codecVersion: 1 } as const;
const TARGET_PROPERTY_KEYS = OBSOLETE_ANNOTATION_PROPERTY_KEYS;
const AGENT_AUTOMATIC_THRESHOLD = 0.95;
const AGENT_BODY_LIMIT = 4_000;
const AGENT_PASSAGE_LIMIT = 2_000;
const AGENT_CONTEXT_LIMIT = 1_000;
const AGENT_PACKAGE_LIMIT = 24_000;

interface AnnotationTargetRow {
  annotation_block_id: string;
  block_id: string | null;
  resource_id: string | null;
  legacy_source_block_id: string | null;
  legacy_file_path: string | null;
  original_target_json: string;
  created_at: string;
}

interface ResolutionRow {
  id: string;
  annotation_block_id: string;
  sequence: number;
  source_representation_json: string;
  target_representation_json: string;
  resolved_target_json: string | null;
  method_json: string;
  reviewer_json: string;
  candidates_json: string;
  confidence: number | null;
  status: AnnotationResolutionStatus;
  applies_current: number;
  created_at: string;
}

type AnnotationResourceEvidenceRole =
  | "original-target"
  | "event-source"
  | "event-target"
  | "event-resolved"
  | "event-candidate";

interface AnnotationRequestRow {
  payload_hash: string | null;
  annotation_ids: string;
}

interface AgentRequestRow {
  payload_hash: string;
  event_id: string;
}

interface WebAnnotationRow {
  id: string;
  resource_id: string;
  source_snapshot_id: string;
  representation_id: string;

  revision_json: string;
  representation_json: string;
  anchor_json: string;
  body: string;
  created_at: string;
}
interface AgentEvidenceRow extends ResolutionRow {
  accepted_by: "automatic" | "human";
  accepted_target_json: string | null;
  accepted_count: number;
  automatic_count: number;
}

interface RepositoryBlocks {
  readonly create: (
    text: string,
    parentId: string | null,
    author: BlockAuthor,
    provenance?: BlockProvenance,
  ) => Block;
  readonly update: (
    blockId: string,
    text: string,
    expectedUpdatedAt: string,
    mutation: MutationProvenance,
  ) => Block;
  readonly insertCanonical: (
    id: string,
    text: string,
    parentId: string | null,
    author: BlockAuthor,
    createdAt: string,
  ) => Block;
  readonly replaceCanonicalText: (blockId: string, text: string) => Block;
  readonly markMutation: () => void;
  readonly requireActive: (blockId: string) => Block;
  readonly get: (blockId: string) => Block | null;
  readonly listAnnotations: () => Block[];
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} cannot be empty`);
  return value.trim();
}

function iso(value: string, label: string): string {
  if (new Date(value).toISOString() !== value) throw new Error(`${label} must be an ISO timestamp`);
  return value;
}

function json(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} contains invalid JSON`);
  }
}

function sameSubject(left: AnnotationSubject, right: AnnotationSubject): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "block" && right.kind === "block") return left.blockId === right.blockId;
  if (left.kind === "resource" && right.kind === "resource") return left.resourceId === right.resourceId;
  return left.kind === "legacy-file" &&
    right.kind === "legacy-file" &&
    left.sourceBlockId === right.sourceBlockId &&
    left.filePath === right.filePath;
}

function sameRepresentation(
  left: AnnotationRepresentation,
  right: AnnotationRepresentation,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function payloadHash(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Annotation request payload cannot be serialized");
  return new Bun.CryptoHasher("sha256").update(serialized).digest("hex");
}

function boundedSlice(value: string, maximum: number): { readonly text: string; readonly truncated: boolean } {
  if (value.length <= maximum) return { text: value, truncated: false };
  return { text: value.slice(0, maximum), truncated: true };
}

function targetPassage(target: AnnotationTarget): string {
  const anchor = target.anchor;
  if (anchor.kind === "text-quote" || anchor.kind === "dom-range") return anchor.exact;
  if (anchor.kind === "pdf-page-region") return anchor.exact ?? `PDF page ${anchor.page}`;
  if (anchor.kind === "structured-entity-field") return `${anchor.entityType}/${anchor.entityId}/${anchor.fieldPath.join(".")}`;
  return `${anchor.provider}:${anchor.commentId}`;
}

function eventFromRow(row: ResolutionRow): AnnotationResolutionEvent {
  const status = row.status;
  if (
    status !== "resolved" &&
    status !== "probable" &&
    status !== "unresolved" &&
    status !== "ambiguous" &&
    status !== "orphaned" &&
    status !== "unsupported" &&
    status !== "rejected"
  ) throw new Error(`Invalid stored annotation resolution status: ${String(status)}`);
  const resolvedTarget = row.resolved_target_json === null ? null : parseStoredTarget(row.resolved_target_json);
  const method = normalizeResolutionMethod(json(row.method_json, "Resolution method"));
  const reviewer = normalizeResolutionReviewer(json(row.reviewer_json, "Resolution reviewer"));
  const rawCandidates = json(row.candidates_json, "Resolution candidates");
  if (!Array.isArray(rawCandidates)) throw new Error("Resolution candidates must be an array");
  const candidates = rawCandidates.map(normalizeResolutionCandidate);
  const appliesCurrent = row.applies_current === 1;
  if (row.applies_current !== 0 && !appliesCurrent) throw new Error("Invalid stored appliesCurrent value");
  if (status === "resolved" && (!resolvedTarget || !appliesCurrent || row.confidence === null)) {
    throw new Error("Resolved annotation event is incomplete");
  }
  const isAgentProposal = method.kind === "agent" && !appliesCurrent;
  if (status === "probable" &&
    (resolvedTarget !== null || row.confidence === null || candidates.length === 0 ||
      (!appliesCurrent && !isAgentProposal))) {
    throw new Error("probable annotation event requires scored candidates without applying a target");
  }
  if (status === "unresolved" && (
    resolvedTarget !== null ||
    !appliesCurrent ||
    ((row.confidence === null) !== (candidates.length === 0))
  )) throw new Error("unresolved annotation event evidence is inconsistent");
  if ((status === "ambiguous" || status === "orphaned") && (
    resolvedTarget !== null ||
    (appliesCurrent ? row.confidence !== null : !isAgentProposal || row.confidence === null) ||
    (status === "ambiguous" && isAgentProposal && candidates.length < 2) ||
    (status === "orphaned" && candidates.length > 0)
  )) throw new Error(`${status} annotation event evidence is inconsistent`);
  if (status === "unsupported" && (resolvedTarget !== null || !appliesCurrent || row.confidence !== null)) {
    throw new Error("unsupported annotation event cannot carry a resolved target or confidence");
  }
  if (status === "rejected" && (resolvedTarget !== null || appliesCurrent)) {
    throw new Error("Rejected annotation event cannot apply current or carry a resolved target");
  }
  if (row.confidence !== null && (!Number.isFinite(row.confidence) || row.confidence < 0 || row.confidence > 1)) {
    throw new Error("Stored annotation confidence is outside 0-1");
  }
  return {
    id: text(row.id, "Resolution event ID"),
    annotationId: text(row.annotation_block_id, "Resolution annotation ID"),
    sequence: row.sequence,
    sourceRepresentation: parseStoredRepresentation(row.source_representation_json),
    targetRepresentation: parseStoredRepresentation(row.target_representation_json),
    resolvedTarget,
    method,
    reviewer,
    confidence: row.confidence,
    candidates,
    status,
    appliesCurrent,
    createdAt: iso(row.created_at, "Resolution event time"),
  };
}

export class AnnotationRepository {
  constructor(
    private readonly database: Database,
    private readonly resources: ResourceCatalog,
    private readonly blocks: RepositoryBlocks,
  ) {
    this.migrate();
  }

  create(
    requestId: string,
    input: AnnotationCreateInput,
    author: BlockAuthor = "user",
    provenance?: BlockProvenance,
  ): AnnotationBatchReceipt {
    return this.batch(requestId, [{ operationId: "create", type: "create", input }], author, provenance);
  }

  reply(
    requestId: string,
    input: { readonly annotationId: string; readonly body: string; readonly source: AnnotationSource },
    author: BlockAuthor = "user",
    provenance?: BlockProvenance,
  ): AnnotationBatchReceipt {
    return this.batch(requestId, [{ operationId: "reply", type: "reply", input }], author, provenance);
  }

  batch(
    requestId: string,
    operations: readonly AnnotationBatchOperation[],
    author: BlockAuthor = "user",
    provenance?: BlockProvenance,
  ): AnnotationBatchReceipt {
    const normalizedRequestId = text(requestId, "Annotation request ID");
    if (!Array.isArray(operations) || operations.length === 0 || operations.length > 100) {
      throw new Error("Annotation batch must contain 1-100 operations");
    }
    const hash = payloadHash(operations);
    return this.database.transaction((): AnnotationBatchReceipt => {
      const existing = this.database.query(
        "SELECT payload_hash, annotation_ids FROM annotation_requests WHERE request_id = ?",
      ).get(normalizedRequestId) as AnnotationRequestRow | null;
      if (existing) {
        if (existing.payload_hash !== hash) {
          throw new Error(`Annotation request ID was already used with different input: ${normalizedRequestId}`);
        }
        const ids = json(existing.annotation_ids, "Annotation request receipt");
        if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
          throw new Error(`Corrupt annotation request receipt: ${normalizedRequestId}`);
        }
        return { annotations: ids.map((id) => this.get(id)), deduplicated: true };
      }
      const operationIds = new Set<string>();
      const prepared = operations.map((operation) => {
        const operationId = text(operation.operationId, "Annotation operation ID");
        if (operationIds.has(operationId)) {
          throw new Error(`Duplicate annotation operationId: ${operationId}`);
        }
        operationIds.add(operationId);
        if (operation.type === "create") {
          const input = normalizeAnnotationCreateInput(operation.input);
          this.requireSubject(input.target.representation.subject);
          this.validateCapture(input.target);
          return { type: "create" as const, input };
        }
        if (operation.type !== "reply") throw new Error("Unsupported annotation batch operation");
        const annotationId = text(operation.input.annotationId, "Reply annotation ID");
        this.requireRoot(annotationId);
        return {
          type: "reply" as const,
          input: {
            annotationId,
            body: text(operation.input.body, "Annotation body"),
            source: operation.input.source,
          },
        };
      });
      const records = prepared.map((operation) => {
        if (operation.type === "create") return this.createFromCurrentWrite(operation.input, author, provenance);
        return this.replyFromCurrentWrite(operation.input, author, provenance);
      });
      this.database.query(
        "INSERT INTO annotation_requests (request_id, payload_hash, annotation_ids, created_at) VALUES (?, ?, ?, ?)",
      ).run(normalizedRequestId, hash, JSON.stringify(records.map((record) => record.block.id)), new Date().toISOString());
      return { annotations: records, deduplicated: false };
    })();
  }

  get(annotationId: string): AnnotationRecord {
    const block = this.blocks.requireActive(text(annotationId, "Annotation ID"));
    const content = parseAnnotationBlockContent(block);
    const rootId = content.parentAnnotationId ?? block.id;
    const root = this.targetRow(rootId);
    return this.materialize(content, root);
  }

  list(query: AnnotationListQuery): AnnotationThread[] {
    if (!query || typeof query !== "object") throw new Error("Annotation list query must be an object");
    const subject = normalizeAnnotationSubject(query.subject, false);
    if (subject.kind === "legacy-file") throw new Error("legacy-file subjects are migration-only");
    const rows = subject.kind === "block"
      ? this.database.query("SELECT * FROM annotation_targets WHERE block_id = ? ORDER BY created_at, annotation_block_id").all(subject.blockId)
      : this.database.query("SELECT * FROM annotation_targets WHERE resource_id = ? ORDER BY created_at, annotation_block_id").all(subject.resourceId);
    const rootIds = new Set((rows as AnnotationTargetRow[]).map((row) => row.annotation_block_id));
    if (rootIds.size === 0) return [];
    const replyIds = this.database.query(`
      SELECT DISTINCT parent.block_id AS id
      FROM block_properties parent
      JOIN block_properties type ON type.block_id = parent.block_id
      WHERE parent.scope = 'block' AND parent.key = 'parent-annotation'
        AND parent.value IN (SELECT value FROM json_each(?))
        AND type.scope = 'block' AND type.key = 'type'
        AND type.value IN ('annotation', 'annotation-reply')
        AND NOT EXISTS (
          SELECT 1 FROM annotation_migration_quarantine quarantine
          WHERE quarantine.annotation_block_id = parent.block_id
        )
    `).all(JSON.stringify([...rootIds])) as Array<{ id: string }>;
    const repliesByParent = new Map<string, AnnotationBlockContent[]>();
    for (const { id } of replyIds) {
      const candidate = this.blocks.get(id);
      if (!candidate || candidate.effectiveDeletedRootId) continue;
      const reply = parseAnnotationBlockContent(candidate);
      if (!reply.parentAnnotationId || !rootIds.has(reply.parentAnnotationId)) continue;
      const siblings = repliesByParent.get(reply.parentAnnotationId) ?? [];
      siblings.push(reply);
      repliesByParent.set(reply.parentAnnotationId, siblings);
    }
    for (const replies of repliesByParent.values()) {
      replies.sort((left, right) =>
        left.block.createdAt.localeCompare(right.block.createdAt) ||
        left.block.id.localeCompare(right.block.id)
      );
    }
    return (rows as AnnotationTargetRow[]).flatMap((row) => {
      const block = this.blocks.get(row.annotation_block_id);
      if (!block || block.effectiveDeletedRootId) return [];
      const content = parseAnnotationBlockContent(block);
      if (query.lifecycle && content.lifecycle !== query.lifecycle) return [];
      if (query.includeResolved === false && content.lifecycle === "resolved") return [];
      const root = this.materialize(content, row);
      const replies = (repliesByParent.get(root.block.id) ?? [])
        .map((reply) => this.materialize(reply, row));
      return [{ ...root, replies }];
    });
  }

  reconcile(input: AnnotationReconcileInput): AnnotationReconcileReceipt {
    if (!input || typeof input !== "object") throw new Error("Annotation reconcile input must be an object");
    const subject = normalizeAnnotationSubject(input.subject, false);
    if (subject.kind === "legacy-file") throw new Error("legacy-file subjects are migration-only");
    const representation = normalizeAnnotationRepresentation(input.newRepresentation, false);
    if (!sameSubject(subject, representation.subject)) {
      throw new Error("Reconciliation representation subject does not match the requested subject");
    }
    const content = input.content === undefined ? this.representationContent(representation) : input.content;
    if (content !== null && typeof content !== "string") {
      throw new Error("Annotation reconciliation content must be a string");
    }
    if (
      content !== null &&
      representation.contentHash !== null &&
      annotationSourceHash(content) !== representation.contentHash
    ) throw new Error("Annotation reconciliation content hash does not match the representation");
    const threads = this.list({ subject, includeResolved: true });
    let changed = false;
    this.database.transaction(() => {
      for (const thread of threads) {
        changed = this.reconcileOne(thread, representation, content) || changed;
      }
      if (changed) this.blocks.markMutation();
    })();
    return { threads: this.list({ subject, includeResolved: true }), changed };
  }

  approve(input: AnnotationApproveResolutionInput): AnnotationRecord {
    if (!input || typeof input !== "object") throw new Error("Annotation approval input must be an object");
    const annotationId = text(input.annotationId, "Annotation ID");
    const target = normalizeAnnotationTarget(input.target, false);
    const root = this.requireRoot(annotationId);
    const original = parseStoredTarget(root.original_target_json);
    if (!sameSubject(original.representation.subject, target.representation.subject)) {
      throw new Error("Approved target must belong to the annotation subject");
    }
    this.requireSubject(target.representation.subject);
    return this.database.transaction(() => {
      const current = this.currentEvent(annotationId);
      this.appendEvent({
        annotationId,
        sourceRepresentation: current.targetRepresentation,
        targetRepresentation: target.representation,
        resolvedTarget: target,
        method: { kind: "human", method: "approved-target" },
        reviewer: { kind: "user", id: "protocol" },
        confidence: 1,
        candidates: [],
        status: "resolved",
        appliesCurrent: true,
      });
      this.blocks.markMutation();
      return this.get(annotationId);
    })();
  }

  agentPackage(annotationIdValue: string): AnnotationAgentPromptPackage {
    const annotationId = text(annotationIdValue, "Annotation ID");
    const record = this.get(annotationId);
    if (record.parentAnnotationId) throw new Error("Agent reconciliation belongs to the root annotation");
    const current = record.currentResolution;
    const deterministicFailure =
      current.method.kind === "codec" &&
      current.reviewer.kind === "system" &&
      current.reviewer.id === "annotation-repository" &&
      (current.method.method === "quote-context" || current.method.method === "local-fuzzy") &&
      ["probable", "unresolved", "ambiguous", "orphaned"].includes(current.status);
    if (!deterministicFailure) {
      throw new Error("Only failed deterministic reconciliations can be sent to an agent");
    }
    const original = record.originalTarget.anchor;
    const originalPassage = boundedSlice(targetPassage(record.originalTarget), AGENT_PASSAGE_LIMIT);
    const originalPrefix = boundedSlice(
      original.kind === "text-quote" ? original.prefix : "",
      AGENT_CONTEXT_LIMIT,
    );
    const originalSuffix = boundedSlice(
      original.kind === "text-quote" ? original.suffix : "",
      AGENT_CONTEXT_LIMIT,
    );
    const body = boundedSlice(record.body, AGENT_BODY_LIMIT);
    let annotationBody = body.text;
    let packageOriginalPassage = originalPassage.text;
    let packageOriginalPrefix = originalPrefix.text;
    let packageOriginalSuffix = originalSuffix.text;
    let truncated = body.truncated ||
      originalPassage.truncated ||
      originalPrefix.truncated ||
      originalSuffix.truncated;
    const packageLength = (
      candidates: readonly AnnotationAgentPromptPackage["candidates"][number][],
      packageTruncated: boolean,
    ) => JSON.stringify({
      annotationId,
      baseEventId: current.id,
      annotationBody,
      originalPassage: packageOriginalPassage,
      originalPrefix: packageOriginalPrefix,
      originalSuffix: packageOriginalSuffix,
      candidates,
      truncated: packageTruncated,
      characterCount: AGENT_PACKAGE_LIMIT,
    }).length;
    while (packageLength([], truncated) > AGENT_PACKAGE_LIMIT) {
      const maximum = Math.max(
        annotationBody.length,
        packageOriginalPassage.length,
        packageOriginalPrefix.length,
        packageOriginalSuffix.length,
      );
      if (maximum === 0) throw new Error("Annotation reconciliation package metadata exceeds its limit");
      if (annotationBody.length === maximum) {
        annotationBody = annotationBody.slice(0, Math.floor(annotationBody.length / 2));
      } else if (packageOriginalPassage.length === maximum) {
        packageOriginalPassage = packageOriginalPassage.slice(
          0,
          Math.floor(packageOriginalPassage.length / 2),
        );
      } else if (packageOriginalPrefix.length === maximum) {
        packageOriginalPrefix = packageOriginalPrefix.slice(
          0,
          Math.floor(packageOriginalPrefix.length / 2),
        );
      } else {
        packageOriginalSuffix = packageOriginalSuffix.slice(
          0,
          Math.floor(packageOriginalSuffix.length / 2),
        );
      }
      truncated = true;
    }
    const candidates: AnnotationAgentPromptPackage["candidates"][number][] = [];
    for (let index = 0; index < Math.min(current.candidates.length, 8); index += 1) {
      const candidate = current.candidates[index]!;
      const anchor = candidate.target.anchor;
      const passage = boundedSlice(targetPassage(candidate.target), AGENT_PASSAGE_LIMIT);
      const prefix = boundedSlice(
        anchor.kind === "text-quote" ? anchor.prefix : "",
        AGENT_CONTEXT_LIMIT,
      );
      const suffix = boundedSlice(
        anchor.kind === "text-quote" ? anchor.suffix : "",
        AGENT_CONTEXT_LIMIT,
      );
      const section = {
        index,
        deterministicMethod: candidate.method,
        deterministicConfidence: candidate.confidence,
        passage: passage.text,
        prefix: prefix.text,
        suffix: suffix.text,
      };
      const nextTruncated =
        truncated || passage.truncated || prefix.truncated || suffix.truncated;
      if (packageLength([...candidates, section], nextTruncated) > AGENT_PACKAGE_LIMIT) {
        truncated = true;
        break;
      }
      candidates.push(section);
      truncated = nextTruncated;
    }
    if (candidates.length < current.candidates.length) truncated = true;
    const packageWithoutCount = {
      annotationId,
      baseEventId: current.id,
      annotationBody,
      originalPassage: packageOriginalPassage,
      originalPrefix: packageOriginalPrefix,
      originalSuffix: packageOriginalSuffix,
      candidates,
      truncated,
    };
    let characterCount = 0;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const nextCount = JSON.stringify({ ...packageWithoutCount, characterCount }).length;
      if (nextCount === characterCount) break;
      characterCount = nextCount;
    }
    const promptPackage = { ...packageWithoutCount, characterCount };
    if (JSON.stringify(promptPackage).length > AGENT_PACKAGE_LIMIT) {
      throw new Error("Annotation reconciliation package exceeds its limit");
    }
    return promptPackage;
  }

  agentReceipt(requestIdValue: string): AnnotationAgentProposalReceipt | null {
    const requestId = text(requestIdValue, "Agent reconciliation request ID");
    if (requestId.length > 200) throw new Error("Agent reconciliation request ID must be at most 200 characters");
    const existing = this.database.query(
      "SELECT payload_hash, event_id FROM annotation_agent_requests WHERE request_id = ?",
    ).get(requestId) as AgentRequestRow | null;
    if (!existing) return null;
    const proposal = this.eventById(existing.event_id);
    return {
      annotation: this.get(proposal.annotationId),
      proposal,
      deduplicated: true,
    };
  }

  proposeAgent(requestIdValue: string, input: AnnotationAgentProposalInput): AnnotationAgentProposalReceipt {
    const requestId = text(requestIdValue, "Agent reconciliation request ID");
    if (!input || typeof input !== "object") throw new Error("Agent proposal input must be an object");
    const annotationId = text(input.annotationId, "Annotation ID");
    if (requestId.length > 200) throw new Error("Agent reconciliation request ID must be at most 200 characters");
    const baseEventId = text(input.baseEventId, "Base resolution event ID");
    const modelId = text(input.modelId, "Agent model ID");
    if (modelId.length > 200) throw new Error("Agent model ID must be at most 200 characters");
    if (!input.result || typeof input.result !== "object") throw new Error("Agent result must be an object");
    const result = input.result;
    if (!Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1) {
      throw new Error("Agent confidence must be between 0 and 1");
    }
    const method = normalizeResolutionMethod({
      kind: "agent",
      modelId,
      method: "semantic-reconciliation",
      rationale: result.rationale,
      evidence: result.evidence,
    });
    const normalizedResult = result.status === "reanchored"
      ? {
          status: result.status,
          candidateIndex: Number.isSafeInteger(result.candidateIndex) ? result.candidateIndex : -1,
          confidence: result.confidence,
          rationale: method.kind === "agent" ? method.rationale : "",
          evidence: method.kind === "agent" ? method.evidence : [],
        }
      : result.status === "ambiguous"
        ? {
            status: result.status,
            candidateIndexes: Array.isArray(result.candidateIndexes) &&
                result.candidateIndexes.length >= 2 &&
                result.candidateIndexes.length <= 8
              ? result.candidateIndexes.map((index) => Number.isSafeInteger(index) ? index : -1)
              : [],
            confidence: result.confidence,
            rationale: method.kind === "agent" ? method.rationale : "",
            evidence: method.kind === "agent" ? method.evidence : [],
          }
        : result.status === "orphaned"
          ? {
              status: result.status,
              confidence: result.confidence,
              rationale: method.kind === "agent" ? method.rationale : "",
              evidence: method.kind === "agent" ? method.evidence : [],
            }
          : (() => { throw new Error("Agent result status must be reanchored, ambiguous, or orphaned"); })();
    const hash = payloadHash({ annotationId, baseEventId });
    return this.database.transaction((): AnnotationAgentProposalReceipt => {
      const existing = this.database.query(
        "SELECT payload_hash, event_id FROM annotation_agent_requests WHERE request_id = ?",
      ).get(requestId) as AgentRequestRow | null;
      if (existing) {
        if (existing.payload_hash !== hash) throw new Error("Agent reconciliation request ID was reused with different input");
        const proposal = this.eventById(existing.event_id);
        return { annotation: this.get(annotationId), proposal, deduplicated: true };
      }
      const promptPackage = this.agentPackage(annotationId);
      if (promptPackage.baseEventId !== baseEventId) {
        throw new Error("Agent proposal is stale because the annotation resolution changed");
      }
      const current = this.currentEvent(annotationId);
      let proposal: AnnotationResolutionEvent;
      if (normalizedResult.status === "reanchored") {
        if (normalizedResult.candidateIndex >= promptPackage.candidates.length) {
          throw new Error("Agent selected a candidate that was not supplied in its prompt package");
        }
        const candidate = current.candidates[normalizedResult.candidateIndex];
        if (!candidate) throw new Error("Agent selected an unavailable candidate");
        const automatic = normalizedResult.confidence >= AGENT_AUTOMATIC_THRESHOLD;
        proposal = this.appendEvent({
          annotationId,
          sourceRepresentation: current.targetRepresentation,
          targetRepresentation: current.targetRepresentation,
          resolvedTarget: automatic ? candidate.target : null,
          method,
          reviewer: { kind: "agent", id: modelId },
          confidence: normalizedResult.confidence,
          candidates: [candidate],
          status: automatic ? "resolved" : "probable",
          appliesCurrent: automatic,
        });
      } else if (normalizedResult.status === "ambiguous") {
        const indexes = [...new Set(normalizedResult.candidateIndexes)];
        if (indexes.length < 2) throw new Error("Ambiguous agent result requires at least two candidates");
        if (indexes.some((index) => index >= promptPackage.candidates.length)) {
          throw new Error("Agent selected a candidate that was not supplied in its prompt package");
        }
        const candidates = indexes.map((index) => {
          const candidate = current.candidates[index];
          if (!candidate) throw new Error("Agent selected an unavailable candidate");
          return candidate;
        }).sort((left, right) => right.confidence - left.confidence);
        proposal = this.appendEvent({
          annotationId,
          sourceRepresentation: current.targetRepresentation,
          targetRepresentation: current.targetRepresentation,
          resolvedTarget: null,
          method,
          reviewer: { kind: "agent", id: modelId },
          confidence: normalizedResult.confidence,
          candidates,
          status: "ambiguous",
          appliesCurrent: false,
        });
      } else {
        proposal = this.appendEvent({
          annotationId,
          sourceRepresentation: current.targetRepresentation,
          targetRepresentation: current.targetRepresentation,
          resolvedTarget: null,
          method,
          reviewer: { kind: "agent", id: modelId },
          confidence: normalizedResult.confidence,
          candidates: [],
          status: "orphaned",
          appliesCurrent: false,
        });
      }
      this.database.query(
        "INSERT INTO annotation_agent_requests (request_id, payload_hash, event_id, created_at) VALUES (?, ?, ?, ?)",
      ).run(requestId, hash, proposal.id, new Date().toISOString());
      this.blocks.markMutation();
      return { annotation: this.get(annotationId), proposal, deduplicated: false };
    })();
  }

  reviewAgent(input: AnnotationAgentReviewInput): AnnotationRecord {
    if (!input || typeof input !== "object") throw new Error("Agent review input must be an object");
    const annotationId = text(input.annotationId, "Annotation ID");
    const proposalEventId = text(input.proposalEventId, "Proposal event ID");
    if (input.decision !== "accept" && input.decision !== "reject") {
      throw new Error("Agent review decision must be accept or reject");
    }
    return this.database.transaction(() => {
      this.requireRoot(annotationId);
      const proposal = this.eventById(proposalEventId);
      if (proposal.annotationId !== annotationId || proposal.method.kind !== "agent" || proposal.appliesCurrent) {
        throw new Error("Resolution event is not a reviewable agent proposal");
      }
      const reviewed = this.history(annotationId).some((event) =>
        event.method.kind === "human" && event.method.proposalEventId === proposalEventId
      );
      if (reviewed) throw new Error("Agent proposal was already reviewed");
      const current = this.currentEvent(annotationId);
      if (!sameRepresentation(current.targetRepresentation, proposal.targetRepresentation)) {
        throw new Error("Agent proposal is stale because the annotation representation changed");
      }
      if (input.decision === "reject") {
        this.appendEvent({
          annotationId,
          sourceRepresentation: current.targetRepresentation,
          targetRepresentation: proposal.targetRepresentation,
          resolvedTarget: null,
          method: { kind: "human", method: "rejected-agent-proposal", proposalEventId },
          reviewer: { kind: "user", id: "protocol" },
          confidence: proposal.confidence,
          candidates: proposal.candidates,
          status: "rejected",
          appliesCurrent: false,
        });
      } else if (proposal.status === "orphaned") {
        this.appendEvent({
          annotationId,
          sourceRepresentation: current.targetRepresentation,
          targetRepresentation: proposal.targetRepresentation,
          resolvedTarget: null,
          method: { kind: "human", method: "accepted-agent-proposal", proposalEventId },
          reviewer: { kind: "user", id: "protocol" },
          confidence: null,
          candidates: [],
          status: "orphaned",
          appliesCurrent: true,
        });
      } else {
        const candidateIndex = input.candidateIndex ?? (proposal.candidates.length === 1 ? 0 : -1);
        const candidate = Number.isSafeInteger(candidateIndex) ? proposal.candidates[candidateIndex] : undefined;
        if (!candidate) throw new Error("Agent proposal acceptance requires a valid candidate index");
        this.appendEvent({
          annotationId,
          sourceRepresentation: current.targetRepresentation,
          targetRepresentation: proposal.targetRepresentation,
          resolvedTarget: candidate.target,
          method: { kind: "human", method: "accepted-agent-proposal", proposalEventId },
          reviewer: { kind: "user", id: "protocol" },
          confidence: 1,
          candidates: [],
          status: "resolved",
          appliesCurrent: true,
        });
      }
      this.blocks.markMutation();
      return this.get(annotationId);
    })();
  }

  agentEvidence(limitValue = 50): AnnotationAgentEvidenceSummary {
    if (!Number.isSafeInteger(limitValue) || limitValue < 1 || limitValue > 100) {
      throw new Error("Agent evidence limit must be an integer between 1 and 100");
    }
    const rows = this.database.query(`
      WITH reviews AS (
        SELECT
          json_extract(method_json, '$.proposalEventId') AS proposal_event_id,
          resolved_target_json,
          ROW_NUMBER() OVER (
            PARTITION BY json_extract(method_json, '$.proposalEventId')
            ORDER BY sequence
          ) AS review_order
        FROM annotation_resolution_events
        WHERE json_extract(method_json, '$.kind') = 'human'
          AND json_extract(method_json, '$.method') = 'accepted-agent-proposal'
      )
      SELECT
        agent.*,
        CASE
          WHEN agent.status = 'resolved' AND agent.applies_current = 1 THEN 'automatic'
          ELSE 'human'
        END AS accepted_by,
        CASE
          WHEN agent.status = 'resolved' AND agent.applies_current = 1
            THEN agent.resolved_target_json
          ELSE review.resolved_target_json
        END AS accepted_target_json,
        COUNT(*) OVER () AS accepted_count,
        SUM(CASE
          WHEN agent.status = 'resolved' AND agent.applies_current = 1 THEN 1
          ELSE 0
        END) OVER () AS automatic_count
      FROM annotation_resolution_events agent
      LEFT JOIN reviews review
        ON review.proposal_event_id = agent.id AND review.review_order = 1
      WHERE json_extract(agent.method_json, '$.kind') = 'agent'
        AND agent.confidence IS NOT NULL
        AND (
          (agent.status = 'resolved' AND agent.applies_current = 1) OR
          review.proposal_event_id IS NOT NULL
        )
      ORDER BY agent.created_at, agent.id
      LIMIT ?
    `).all(limitValue) as AgentEvidenceRow[];
    const acceptedCount = rows[0]?.accepted_count ?? 0;
    const automaticCount = rows[0]?.automatic_count ?? 0;
    const humanReviewedCount = acceptedCount - automaticCount;
    let passageTruncated = false;
    const samples = rows.map((row): AnnotationAgentEvidenceSample => {
      const proposal = eventFromRow(row);
      if (proposal.method.kind !== "agent" || proposal.confidence === null) {
        throw new Error("Stored agent evidence row is invalid");
      }
      const original = parseStoredTarget(this.targetRow(proposal.annotationId).original_target_json);
      const resolved = row.accepted_target_json === null
        ? null
        : parseStoredTarget(row.accepted_target_json);
      const originalPassage = boundedSlice(targetPassage(original), AGENT_PASSAGE_LIMIT);
      const resolvedPassage = resolved === null
        ? null
        : boundedSlice(targetPassage(resolved), AGENT_PASSAGE_LIMIT);
      passageTruncated ||= originalPassage.truncated || resolvedPassage?.truncated === true;
      return {
        annotationId: proposal.annotationId,
        proposalEventId: proposal.id,
        modelId: proposal.method.modelId,
        outcome: proposal.status === "ambiguous"
          ? "ambiguous"
          : proposal.status === "orphaned"
            ? "orphaned"
            : "reanchored",
        acceptedBy: row.accepted_by,
        confidence: proposal.confidence,
        originalPassage: originalPassage.text,
        resolvedPassage: resolvedPassage?.text ?? null,
        rationale: proposal.method.rationale,
        evidence: proposal.method.evidence,
      };
    });
    return {
      acceptedCount,
      automaticCount,
      humanReviewedCount,
      samples,
      truncated: acceptedCount > samples.length || passageTruncated,
    };
  }

  setLifecycle(input: AnnotationLifecycleInput, mutation: MutationProvenance): AnnotationRecord {
    if (!input || typeof input !== "object") throw new Error("Annotation lifecycle input must be an object");
    const annotationId = text(input.annotationId, "Annotation ID");
    if (input.lifecycle !== "open" && input.lifecycle !== "resolved") throw new Error("Unsupported annotation lifecycle");
    const record = this.get(annotationId);
    if (record.parentAnnotationId) throw new Error("Annotation lifecycle belongs to the root thread");
    const promotedBlockIds = [...(record.promotedBlockIds ?? [])];
    if (input.promotedBlockId !== undefined) {
      const promotedBlockId = text(input.promotedBlockId, "Promoted block ID");
      this.blocks.requireActive(promotedBlockId);
      if (!promotedBlockIds.includes(promotedBlockId)) promotedBlockIds.push(promotedBlockId);
    }
    const updated = this.blocks.update(
      annotationId,
      formatAnnotationBlock(
        { target: record.resolvedTarget ?? record.originalTarget, body: record.body, source: record.source },
        undefined,
        { lifecycle: input.lifecycle, promotedBlockIds, allowLegacy: true },
      ),
      record.block.updatedAt,
      mutation,
    );
    return this.materialize(parseAnnotationBlockContent(updated), this.targetRow(annotationId));
  }

  private createFromCurrentWrite(
    input: AnnotationCreateInput,
    author: BlockAuthor,
    provenance?: BlockProvenance,
  ): AnnotationRecord {
    const subject = input.target.representation.subject;
    const parentId = subject.kind === "block" ? subject.blockId : this.ensureSystemRoot();
    const block = this.blocks.create(formatAnnotationBlock(input), parentId, author, provenance);
    this.insertTarget(block.id, input.target, block.createdAt);
    this.appendEvent({
      annotationId: block.id,
      sourceRepresentation: input.target.representation,
      targetRepresentation: input.target.representation,
      resolvedTarget: input.target,
      method: { ...TEXT_CODEC, method: "capture" },
      reviewer: { kind: "system", id: "annotation-repository" },
      confidence: 1,
      candidates: [],
      status: "resolved",
      appliesCurrent: true,
      createdAt: block.createdAt,
    });
    return this.get(block.id);
  }

  private replyFromCurrentWrite(
    input: { readonly annotationId: string; readonly body: string; readonly source: AnnotationSource },
    author: BlockAuthor,
    provenance?: BlockProvenance,
  ): AnnotationRecord {
    const root = this.get(input.annotationId);
    if (root.parentAnnotationId) throw new Error("Replies must attach directly to a root annotation");
    const block = this.blocks.create(
      formatAnnotationBlock(
        { target: root.resolvedTarget ?? root.originalTarget, body: input.body, source: input.source },
        root.block.id,
        { allowLegacy: true },
      ),
      root.block.id,
      author,
      provenance,
    );
    return this.materialize(parseAnnotationBlockContent(block), this.targetRow(root.block.id));
  }

  private reconcileOne(
    record: AnnotationRecord,
    representation: AnnotationRepresentation,
    content: string | null,
  ): boolean {
    const sourceRepresentation = record.currentResolution.targetRepresentation;
    if (sameRepresentation(sourceRepresentation, representation)) return false;
    if (
      sourceRepresentation.sourceSnapshot.kind === "rendered" &&
      representation.sourceSnapshot.kind !== "rendered"
    ) return false;
    const result = reanchorAnnotationTarget(
      record.resolvedTarget ?? record.originalTarget,
      representation,
      content,
    );
    this.appendEvent({
      annotationId: record.block.id,
      sourceRepresentation,
      targetRepresentation: representation,
      resolvedTarget: result.resolvedTarget,
      method: result.method,
      reviewer: { kind: "system", id: "annotation-repository" },
      confidence: result.confidence,
      candidates: result.candidates,
      status: result.status,
      appliesCurrent: true,
    });
    return true;
  }

  private validateCapture(target: AnnotationTarget): void {
    const representation = target.representation;
    if (representation.sourceSnapshot.kind === "block") {
      const block = this.blocks.requireActive(representation.sourceSnapshot.blockId);
      if (
        block.updatedAt !== representation.sourceSnapshot.updatedAt ||
        annotationSourceHash(block.text) !== representation.sourceSnapshot.contentHash
      ) throw new Error("Annotation block snapshot is stale");
    }
    const content = this.representationContent(representation);
    if (representation.subject.kind === "resource" && content === null) {
      throw new Error("Annotation Resource representation evidence is unavailable");
    }
    if (
      representation.contentHash !== null &&
      content !== null &&
      annotationSourceHash(content) !== representation.contentHash
    ) throw new Error("Annotation representation content hash does not match captured content");
    if (target.anchor.kind !== "text-quote" || content === null) return;
    const { start, end, exact, prefix, suffix } = target.anchor;
    if (start === null || end === null) {
      if (representation.observation?.quote !== exact) {
        throw new Error("Unpositioned annotation quote must match rendered evidence");
      }
      return;
    }
    if (content.slice(start, end) !== exact) {
      throw new Error("Annotation quote does not match captured representation");
    }
    if (
      content.slice(Math.max(0, start - prefix.length), start) !== prefix ||
      content.slice(end, end + suffix.length) !== suffix
    ) throw new Error("Annotation quote context does not match captured representation");
  }

  private representationContent(representation: AnnotationRepresentation): string | null {
    const subject = representation.subject;
    if (subject.kind === "block") {
      if (representation.sourceSnapshot.kind === "rendered") return null;
      return this.blocks.requireActive(subject.blockId).text;
    }
    if (subject.kind === "legacy-file") return null;
    const snapshot = representation.sourceSnapshot;
    if (snapshot.kind !== "resource" || snapshot.resourceId !== subject.resourceId) {
      throw new Error("Annotation Resource snapshot does not match its subject");
    }
    const description = this.resources.describe(
      subject.resourceId,
      true,
      snapshot.revision ?? undefined,
    );
    if (description.resource.provider === "filesystem") {
      return description.filesystem?.text ?? null;
    }
    if (description.resource.provider === "web") {
      const web = description.web;
      if (
        !web ||
        web.representation.id !== representation.id ||
        snapshot.sourceSnapshotId === null ||
        web.sourceSnapshot.id !== snapshot.sourceSnapshotId
      ) return null;
      return web.markdown;
    }
    return null;
  }

  private materialize(
    content: AnnotationBlockContent,
    targetRow: AnnotationTargetRow,
  ): AnnotationRecord {
    const originalTarget = parseStoredTarget(targetRow.original_target_json);
    const history = this.history(targetRow.annotation_block_id);
    const current = [...history].reverse().find((event) => event.appliesCurrent);
    if (!current) throw new Error(`Annotation has no current resolution: ${targetRow.annotation_block_id}`);
    return {
      block: content.block,
      originalTarget,
      resolvedTarget: current.status === "resolved" ? current.resolvedTarget : null,
      currentResolution: current,
      resolutionHistory: history,
      body: content.body,
      source: content.source,
      lifecycle: content.lifecycle,
      promotedBlockIds: content.promotedBlockIds,
      ...(content.parentAnnotationId ? { parentAnnotationId: content.parentAnnotationId } : {}),
    };
  }

  private history(annotationId: string): AnnotationResolutionEvent[] {
    const rows = this.database.query(
      "SELECT * FROM annotation_resolution_events WHERE annotation_block_id = ? ORDER BY sequence",
    ).all(annotationId) as ResolutionRow[];
    if (rows.length === 0 || rows[0]!.sequence !== 0) throw new Error(`Annotation resolution history is missing sequence 0: ${annotationId}`);
    return rows.map((row, index) => {
      if (row.sequence !== index) throw new Error(`Annotation resolution history has a sequence gap: ${annotationId}`);
      return eventFromRow(row);
    });
  }

  private currentEvent(annotationId: string): AnnotationResolutionEvent {
    const row = this.database.query(
      "SELECT * FROM annotation_resolution_events WHERE annotation_block_id = ? AND applies_current = 1 ORDER BY sequence DESC LIMIT 1",
    ).get(annotationId) as ResolutionRow | null;
    if (!row) throw new Error(`Annotation has no current resolution: ${annotationId}`);
    return eventFromRow(row);
  }

  private eventById(eventId: string): AnnotationResolutionEvent {
    const row = this.database.query(
      "SELECT * FROM annotation_resolution_events WHERE id = ?",
    ).get(eventId) as ResolutionRow | null;
    if (!row) throw new Error(`Annotation resolution event not found: ${eventId}`);
    return eventFromRow(row);
  }

  private appendEvent(input: {
    readonly annotationId: string;
    readonly sourceRepresentation: AnnotationRepresentation;
    readonly targetRepresentation: AnnotationRepresentation;
    readonly resolvedTarget: AnnotationTarget | null;
    readonly method: AnnotationResolutionMethod;
    readonly reviewer: AnnotationResolutionReviewer;
    readonly confidence: number | null;
    readonly candidates: readonly AnnotationResolutionCandidate[];
    readonly status: AnnotationResolutionStatus;
    readonly appliesCurrent: boolean;
    readonly createdAt?: string;
  }): AnnotationResolutionEvent {
    const sequenceRow = this.database.query(
      "SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence FROM annotation_resolution_events WHERE annotation_block_id = ?",
    ).get(input.annotationId) as { sequence: number };
    const event: AnnotationResolutionEvent = {
      id: crypto.randomUUID(),
      annotationId: input.annotationId,
      sequence: sequenceRow.sequence,
      sourceRepresentation: normalizeAnnotationRepresentation(input.sourceRepresentation, true),
      targetRepresentation: normalizeAnnotationRepresentation(input.targetRepresentation, true),
      resolvedTarget: input.resolvedTarget === null ? null : normalizeAnnotationTarget(input.resolvedTarget, true),
      method: normalizeResolutionMethod(input.method),
      reviewer: normalizeResolutionReviewer(input.reviewer),
      confidence: input.confidence,
      candidates: input.candidates.map(normalizeResolutionCandidate),
      status: input.status,
      appliesCurrent: input.appliesCurrent,
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    this.assertEvent(event);
    this.database.query(`
      INSERT INTO annotation_resolution_events (
        id, annotation_block_id, sequence, source_representation_json,
        target_representation_json, resolved_target_json, method_json,
        reviewer_json, confidence, candidates_json, status, applies_current, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.annotationId,
      event.sequence,
      JSON.stringify(event.sourceRepresentation),
      JSON.stringify(event.targetRepresentation),
      event.resolvedTarget === null ? null : JSON.stringify(event.resolvedTarget),
      JSON.stringify(event.method),
      JSON.stringify(event.reviewer),
      event.confidence,
      JSON.stringify(event.candidates),
      event.status,
      event.appliesCurrent ? 1 : 0,
      event.createdAt,
    );
    this.insertEventResourceEvidenceRefs(event);
    return event;
  }

  private assertEvent(event: AnnotationResolutionEvent): void {
    if (event.status === "resolved") {
      if (!event.appliesCurrent || event.resolvedTarget === null || event.confidence === null) {
        throw new Error("Resolved event must apply a target with confidence");
      }
    } else if (event.status === "probable") {
      const proposal = event.method.kind === "agent" && !event.appliesCurrent;
      if (
        (!event.appliesCurrent && !proposal) ||
        event.resolvedTarget !== null ||
        event.confidence === null ||
        event.candidates.length === 0
      ) throw new Error("probable event requires scored candidates without applying a target");
    } else if (event.status === "unresolved") {
      if (
        !event.appliesCurrent ||
        event.resolvedTarget !== null ||
        ((event.confidence === null) !== (event.candidates.length === 0))
      ) throw new Error("unresolved event evidence is inconsistent");
    } else if (event.status === "ambiguous" || event.status === "orphaned") {
      const proposal = event.method.kind === "agent" && !event.appliesCurrent;
      if (
        event.resolvedTarget !== null ||
        (event.appliesCurrent ? event.confidence !== null : !proposal || event.confidence === null) ||
        (event.status === "ambiguous" && proposal && event.candidates.length < 2) ||
        (event.status === "orphaned" && event.candidates.length > 0)
      ) throw new Error(`${event.status} event evidence is inconsistent`);
    } else if (event.status === "rejected") {
      if (event.appliesCurrent || event.resolvedTarget !== null) {
        throw new Error("Rejected event cannot apply current");
      }
    } else if (!event.appliesCurrent || event.resolvedTarget !== null || event.confidence !== null) {
      throw new Error(`${event.status} event must apply a null current target without confidence`);
    }
    if (event.confidence !== null && (!Number.isFinite(event.confidence) || event.confidence < 0 || event.confidence > 1)) {
      throw new Error("Resolution confidence must be between 0 and 1");
    }
    for (let index = 0; index < event.candidates.length; index += 1) {
      const entry = event.candidates[index]!;
      if (!sameRepresentation(entry.target.representation, event.targetRepresentation)) {
        throw new Error("Resolution candidate must belong to the target representation");
      }
      if (index > 0 && event.candidates[index - 1]!.confidence < entry.confidence) {
        throw new Error("Resolution candidates must be ranked by descending confidence");
      }
    }
  }

  private insertTarget(annotationId: string, target: AnnotationTarget, createdAt: string): void {
    const subject = target.representation.subject;
    this.database.query(`
      INSERT INTO annotation_targets (
        annotation_block_id, block_id, resource_id, legacy_source_block_id,
        legacy_file_path, original_target_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      annotationId,
      subject.kind === "block" ? subject.blockId : null,
      subject.kind === "resource" ? subject.resourceId : null,
      subject.kind === "legacy-file" ? subject.sourceBlockId : null,
      subject.kind === "legacy-file" ? subject.filePath : null,
      JSON.stringify(target),
      createdAt,
    );
    this.insertResourceEvidenceRef({
      annotationId,
      resolutionEventId: null,
      role: "original-target",
      value: target,
      createdAt,
    });
  }

  private targetRow(annotationId: string): AnnotationTargetRow {
    const row = this.database.query("SELECT * FROM annotation_targets WHERE annotation_block_id = ?").get(annotationId) as AnnotationTargetRow | null;
    if (!row) throw new Error(`Annotation target not found: ${annotationId}`);
    const target = parseStoredTarget(row.original_target_json);
    const subject = target.representation.subject;
    if (
      (subject.kind === "block" &&
        (row.block_id !== subject.blockId ||
          row.resource_id !== null ||
          row.legacy_source_block_id !== null ||
          row.legacy_file_path !== null)) ||
      (subject.kind === "resource" &&
        (row.resource_id !== subject.resourceId ||
          row.block_id !== null ||
          row.legacy_source_block_id !== null ||
          row.legacy_file_path !== null)) ||
      (subject.kind === "legacy-file" &&
        (row.legacy_source_block_id !== subject.sourceBlockId ||
          row.legacy_file_path !== subject.filePath ||
          row.block_id !== null ||
          row.resource_id !== null))
    ) throw new Error(`Annotation target index disagrees with stored target: ${annotationId}`);
    return row;
  }

  private requireRoot(annotationId: string): AnnotationTargetRow {
    this.blocks.requireActive(annotationId);
    return this.targetRow(annotationId);
  }

  private requireSubject(subject: AnnotationSubject): void {
    if (subject.kind === "legacy-file") throw new Error("legacy-file subjects are migration-only");
    if (subject.kind === "block") this.blocks.requireActive(subject.blockId);
    else this.resources.require(subject.resourceId);
  }

  private ensureSystemRoot(): string {
    const existing = this.blocks.get(SYSTEM_ANNOTATIONS_ROOT_ID);
    if (existing) {
      if (!existing.properties.some((property) =>
        property.key === "type" && property.value === "annotations-root"
      )) throw new Error(`System annotations root ID collision: ${SYSTEM_ANNOTATIONS_ROOT_ID}`);
      return existing.id;
    }
    const now = new Date().toISOString();
    this.blocks.insertCanonical(
      SYSTEM_ANNOTATIONS_ROOT_ID,
      "Annotations [type::annotations-root]",
      null,
      "system",
      now,
    );
    return SYSTEM_ANNOTATIONS_ROOT_ID;
  }


  private migrate(): void {
    this.database.transaction(() => {
      this.createSchema();
      const marker = this.database.query("SELECT value FROM metadata WHERE key = ?").get(MIGRATION_MARKER) as { value: string } | null;
      if (!marker) this.migrateLegacyData();
      this.backfillResourceEvidenceRefs();
      this.database.exec("DROP INDEX IF EXISTS web_resource_annotations_resource; DROP INDEX IF EXISTS web_resource_annotations_evidence; DROP TABLE IF EXISTS web_resource_annotations;");
      this.database.query("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, '1')").run(MIGRATION_MARKER);
      const foreignKeys = this.database.query("PRAGMA foreign_key_check").all();
      if (foreignKeys.length > 0) throw new Error("Annotation migration left foreign-key violations");
    })();
  }

  private createSchema(): void {
    const requestColumns = new Set((this.database.query("PRAGMA table_info(annotation_requests)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!requestColumns.has("payload_hash")) this.database.exec("ALTER TABLE annotation_requests ADD COLUMN payload_hash TEXT");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS annotation_targets (
        annotation_block_id TEXT PRIMARY KEY REFERENCES blocks(id) ON DELETE CASCADE,
        block_id TEXT REFERENCES blocks(id) ON DELETE RESTRICT,
        resource_id TEXT REFERENCES resources(id) ON DELETE RESTRICT,
        legacy_source_block_id TEXT,
        legacy_file_path TEXT,
        original_target_json TEXT NOT NULL CHECK(json_valid(original_target_json)),
        created_at TEXT NOT NULL,
        CHECK (
          (block_id IS NOT NULL AND resource_id IS NULL AND legacy_source_block_id IS NULL AND legacy_file_path IS NULL) OR
          (block_id IS NULL AND resource_id IS NOT NULL AND legacy_source_block_id IS NULL AND legacy_file_path IS NULL) OR
          (block_id IS NULL AND resource_id IS NULL AND legacy_source_block_id IS NOT NULL AND legacy_file_path IS NOT NULL)
        )
      );
      CREATE INDEX IF NOT EXISTS annotation_targets_block ON annotation_targets(block_id, created_at, annotation_block_id);
      CREATE INDEX IF NOT EXISTS annotation_targets_resource ON annotation_targets(resource_id, created_at, annotation_block_id);
      CREATE INDEX IF NOT EXISTS annotation_targets_legacy_file ON annotation_targets(legacy_source_block_id, legacy_file_path, annotation_block_id);
      CREATE TRIGGER IF NOT EXISTS annotation_targets_immutable
      BEFORE UPDATE ON annotation_targets
      BEGIN SELECT RAISE(ABORT, 'annotation original targets are immutable'); END;
      CREATE TABLE IF NOT EXISTS annotation_migration_quarantine (
        annotation_block_id TEXT PRIMARY KEY REFERENCES blocks(id) ON DELETE CASCADE,
        raw_text TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    const resolutionSchema = `
      CREATE TABLE annotation_resolution_events (
        id TEXT PRIMARY KEY,
        annotation_block_id TEXT NOT NULL REFERENCES annotation_targets(annotation_block_id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK(sequence >= 0),
        source_representation_json TEXT NOT NULL CHECK(json_valid(source_representation_json)),
        target_representation_json TEXT NOT NULL CHECK(json_valid(target_representation_json)),
        resolved_target_json TEXT CHECK(resolved_target_json IS NULL OR json_valid(resolved_target_json)),
        method_json TEXT NOT NULL CHECK(json_valid(method_json)),
        reviewer_json TEXT NOT NULL CHECK(json_valid(reviewer_json)),
        confidence REAL CHECK(confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
        candidates_json TEXT NOT NULL CHECK(json_valid(candidates_json) AND json_type(candidates_json) = 'array'),
        status TEXT NOT NULL CHECK(status IN ('resolved','probable','unresolved','ambiguous','orphaned','unsupported','rejected')),
        applies_current INTEGER NOT NULL CHECK(applies_current IN (0,1)),
        created_at TEXT NOT NULL,
        UNIQUE(annotation_block_id, sequence),
        CHECK (
          (status = 'resolved' AND applies_current = 1 AND resolved_target_json IS NOT NULL AND confidence IS NOT NULL) OR
          (status = 'probable' AND resolved_target_json IS NULL AND confidence IS NOT NULL AND json_array_length(candidates_json) > 0 AND (applies_current = 1 OR (applies_current = 0 AND json_extract(method_json, '$.kind') = 'agent'))) OR
          (status = 'unresolved' AND applies_current = 1 AND resolved_target_json IS NULL AND ((confidence IS NULL AND json_array_length(candidates_json) = 0) OR (confidence IS NOT NULL AND json_array_length(candidates_json) > 0))) OR
          (status IN ('ambiguous','orphaned') AND resolved_target_json IS NULL AND ((applies_current = 1 AND confidence IS NULL) OR (applies_current = 0 AND confidence IS NOT NULL AND json_extract(method_json, '$.kind') = 'agent'))) OR
          (status = 'unsupported' AND applies_current = 1 AND resolved_target_json IS NULL AND confidence IS NULL) OR
          (status = 'rejected' AND applies_current = 0 AND resolved_target_json IS NULL)
        )
      );
    `;
    const existingResolution = this.database.query(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'annotation_resolution_events'",
    ).get() as { sql: string } | null;
    const existingResolutionColumns = new Set(
      (this.database.query("PRAGMA table_info(annotation_resolution_events)").all() as Array<{ name: string }>)
        .map(({ name }) => name),
    );
    if (!existingResolution) {
      this.database.exec(resolutionSchema);
    } else if (
      !existingResolution.sql.includes("candidates_json") ||
      !existingResolution.sql.includes("'probable'") ||
      !existingResolution.sql.includes("status = 'unresolved'") ||
      !existingResolution.sql.includes("json_extract(method_json")
    ) {
      this.database.exec(`
        DROP TRIGGER IF EXISTS annotation_resolution_events_append_only;
        DROP INDEX IF EXISTS annotation_resolution_history;
        DROP INDEX IF EXISTS annotation_current_resolution;
        ALTER TABLE annotation_resolution_events RENAME TO annotation_resolution_events_legacy;
        ${resolutionSchema}
        INSERT INTO annotation_resolution_events (
          id, annotation_block_id, sequence, source_representation_json,
          target_representation_json, resolved_target_json, method_json,
          reviewer_json, confidence, candidates_json, status, applies_current, created_at
        )
        SELECT id, annotation_block_id, sequence, source_representation_json,
          target_representation_json, resolved_target_json, method_json,
          reviewer_json, confidence, ${existingResolutionColumns.has("candidates_json") ? "candidates_json" : "'[]'"}, status, applies_current, created_at
        FROM annotation_resolution_events_legacy;
        DROP TABLE annotation_resolution_events_legacy;
      `);
    }
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS annotation_resolution_history ON annotation_resolution_events(annotation_block_id, sequence);
      CREATE INDEX IF NOT EXISTS annotation_current_resolution ON annotation_resolution_events(annotation_block_id, applies_current, sequence DESC);
      CREATE TRIGGER IF NOT EXISTS annotation_resolution_events_append_only
      BEFORE UPDATE ON annotation_resolution_events
      BEGIN SELECT RAISE(ABORT, 'annotation resolution events are append-only'); END;
    `);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS annotation_agent_requests (
        request_id TEXT PRIMARY KEY,
        payload_hash TEXT NOT NULL,
        event_id TEXT NOT NULL REFERENCES annotation_resolution_events(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL
      );
    `);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS annotation_resource_evidence_refs (
        id TEXT PRIMARY KEY,
        annotation_block_id TEXT NOT NULL
          REFERENCES annotation_targets(annotation_block_id) ON DELETE CASCADE,
        resolution_event_id TEXT
          REFERENCES annotation_resolution_events(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (
          role IN (
            'original-target',
            'event-source',
            'event-target',
            'event-resolved',
            'event-candidate'
          )
        ),
        source_snapshot_id TEXT
          REFERENCES web_source_snapshots(id) ON DELETE RESTRICT,
        representation_id TEXT
          REFERENCES web_representations(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL,
        CHECK (source_snapshot_id IS NOT NULL OR representation_id IS NOT NULL)
      );
      CREATE INDEX IF NOT EXISTS annotation_resource_evidence_refs_source_snapshot
        ON annotation_resource_evidence_refs(source_snapshot_id, annotation_block_id)
        WHERE source_snapshot_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS annotation_resource_evidence_refs_representation
        ON annotation_resource_evidence_refs(representation_id, annotation_block_id)
        WHERE representation_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS annotation_resource_evidence_refs_unique
        ON annotation_resource_evidence_refs(
          annotation_block_id,
          ifnull(resolution_event_id, ''),
          role,
          ifnull(source_snapshot_id, ''),
          ifnull(representation_id, '')
        );
    `);
  }

  private insertResourceEvidenceRef(input: {
    readonly annotationId: string;
    readonly resolutionEventId: string | null;
    readonly role: AnnotationResourceEvidenceRole;
    readonly value: AnnotationRepresentation | AnnotationTarget;
    readonly createdAt: string;
  }): void {
    const representation = "representation" in input.value
      ? input.value.representation
      : input.value;
    const subject = representation.subject;
    const snapshot = representation.sourceSnapshot;
    if (
      subject.kind !== "resource" ||
      snapshot.kind !== "resource" ||
      snapshot.resourceId !== subject.resourceId
    ) return;
    const artifacts = this.database.query(`
      SELECT
        (
          SELECT id
          FROM web_source_snapshots
          WHERE id = ? AND resource_id = target.resource_id
        ) AS source_snapshot_id,
        (
          SELECT representation.id
          FROM web_representations representation
          JOIN web_source_snapshots source_snapshot
            ON source_snapshot.id = representation.source_snapshot_id
          WHERE representation.id = ?
            AND source_snapshot.resource_id = target.resource_id
        ) AS representation_id
      FROM annotation_targets target
      WHERE target.annotation_block_id = ? AND target.resource_id = ?
    `).get(
      snapshot.sourceSnapshotId,
      representation.id,
      input.annotationId,
      subject.resourceId,
    ) as {
      source_snapshot_id: string | null;
      representation_id: string | null;
    } | null;
    if (
      !artifacts ||
      (artifacts.source_snapshot_id === null && artifacts.representation_id === null)
    ) return;
    this.database.query(`
      INSERT OR IGNORE INTO annotation_resource_evidence_refs (
        id, annotation_block_id, resolution_event_id, role,
        source_snapshot_id, representation_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      input.annotationId,
      input.resolutionEventId,
      input.role,
      artifacts.source_snapshot_id,
      artifacts.representation_id,
      input.createdAt,
    );
  }

  private insertEventResourceEvidenceRefs(event: AnnotationResolutionEvent): void {
    this.insertResourceEvidenceRef({
      annotationId: event.annotationId,
      resolutionEventId: event.id,
      role: "event-source",
      value: event.sourceRepresentation,
      createdAt: event.createdAt,
    });
    this.insertResourceEvidenceRef({
      annotationId: event.annotationId,
      resolutionEventId: event.id,
      role: "event-target",
      value: event.targetRepresentation,
      createdAt: event.createdAt,
    });
    if (event.resolvedTarget) {
      this.insertResourceEvidenceRef({
        annotationId: event.annotationId,
        resolutionEventId: event.id,
        role: "event-resolved",
        value: event.resolvedTarget,
        createdAt: event.createdAt,
      });
    }
    for (const candidate of event.candidates) {
      this.insertResourceEvidenceRef({
        annotationId: event.annotationId,
        resolutionEventId: event.id,
        role: "event-candidate",
        value: candidate.target,
        createdAt: event.createdAt,
      });
    }
  }

  private backfillResourceEvidenceRefs(): void {
    const targets = this.database.query(`
      SELECT annotation_block_id, original_target_json, created_at
      FROM annotation_targets
    `).all() as Array<Pick<
      AnnotationTargetRow,
      "annotation_block_id" | "original_target_json" | "created_at"
    >>;
    for (const target of targets) {
      this.insertResourceEvidenceRef({
        annotationId: target.annotation_block_id,
        resolutionEventId: null,
        role: "original-target",
        value: parseStoredTarget(target.original_target_json),
        createdAt: target.created_at,
      });
    }
    const events = this.database.query(
      "SELECT * FROM annotation_resolution_events ORDER BY annotation_block_id, sequence",
    ).all() as ResolutionRow[];
    for (const row of events) {
      const event = eventFromRow(row);
      this.insertEventResourceEvidenceRefs(event);
    }
  }

  private migrateLegacyData(): void {
    const blocks = this.blocks.listAnnotations();
    const legacyRoots: LegacyAnnotationEvidence[] = [];
    const quarantinedRootIds = new Set<string>();
    for (const block of blocks) {
      const isReply = block.properties.some((property) => property.key === "parent-annotation");
      if (isReply) continue;
      try {
        const legacy = parseLegacyAnnotationBlock(block);
        normalizeAnnotationTarget({
          representation: this.legacyRepresentation(legacy),
          anchor: legacy.anchor,
        }, true);
        legacyRoots.push(legacy);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.database.query(`
          INSERT INTO annotation_migration_quarantine
            (annotation_block_id, raw_text, reason, created_at)
          VALUES (?, ?, ?, ?)
        `).run(block.id, block.text, reason, block.createdAt);
        quarantinedRootIds.add(block.id);
      }
    }
    const webTable = (
      this.database.query("PRAGMA table_info(web_resource_annotations)").all() as Array<{
        name: string;
      }>
    ).length > 0;
    const webRows = webTable
      ? this.database.query(`
          SELECT id, resource_id, source_snapshot_id, representation_id,
                 revision_json, representation_json, anchor_json, body, created_at
          FROM web_resource_annotations
          ORDER BY created_at, id
        `).all() as WebAnnotationRow[]
      : [];
    for (const legacy of legacyRoots) this.migrateLegacyRoot(legacy);
    for (const block of blocks) {
      if (!quarantinedRootIds.has(block.id)) this.stripLegacyProperties(block);
    }
    for (const row of webRows) this.migrateWebAnnotation(row);
    const targetCount = (
      this.database.query("SELECT COUNT(*) AS count FROM annotation_targets").get() as {
        count: number;
      }
    ).count;
    if (targetCount !== legacyRoots.length + webRows.length) {
      throw new Error("Annotation migration target parity check failed");
    }
  }

  private migrateLegacyRoot(legacy: LegacyAnnotationEvidence): void {
    const representation = this.legacyRepresentation(legacy);
    const target: AnnotationTarget = { representation, anchor: legacy.anchor };
    this.insertTarget(legacy.block.id, target, legacy.block.createdAt);
    const legacyFileOrphan = representation.subject.kind === "legacy-file";
    const resolved = !legacyFileOrphan &&
      (legacy.state === "anchored" || legacy.state === "observed");
    const status: AnnotationResolutionStatus = resolved
      ? "resolved"
      : legacyFileOrphan
        ? "orphaned"
        : legacy.state === "ambiguous"
          ? "ambiguous"
          : "orphaned";
    this.appendEvent({
      annotationId: legacy.block.id,
      sourceRepresentation: representation,
      targetRepresentation: representation,
      resolvedTarget: resolved ? target : null,
      method: { ...TEXT_CODEC, method: "legacy-migration" },
      reviewer: { kind: "system", id: "pie-250-migration" },
      confidence: resolved ? 1 : null,
      candidates: [],
      status,
      appliesCurrent: true,
      createdAt: legacy.block.createdAt,
    });
  }

  private legacyRepresentation(legacy: LegacyAnnotationEvidence): AnnotationRepresentation {
    let subject: AnnotationSubject = { kind: "block", blockId: legacy.sourceBlockId };
    let sourceSnapshot: AnnotationRepresentation["sourceSnapshot"] =
      legacy.sourceVersion && legacy.sourceHash && this.isIso(legacy.sourceVersion)
        ? {
            kind: "block",
            blockId: legacy.sourceBlockId,
            updatedAt: legacy.sourceVersion,
            contentHash: legacy.sourceHash,
          }
        : {
            kind: "unknown",
            reason: "Legacy annotation did not retain complete block snapshot evidence",
          };
    let observation = legacy.observation;
    if (legacy.kind === "file") {
      const resource = this.findLegacyFilesystemResource(legacy.filePath!);
      if (resource) {
        subject = { kind: "resource", resourceId: resource.id };
        sourceSnapshot = { kind: "resource", resourceId: resource.id, sourceSnapshotId: null, revision: null };
      } else {
        subject = { kind: "legacy-file", sourceBlockId: legacy.sourceBlockId, filePath: legacy.filePath! };
        sourceSnapshot = { kind: "unknown", reason: "Legacy file annotation had no uniquely matching filesystem Resource" };
      }
    } else if (legacy.kind === "passage" && observation) {
      sourceSnapshot = { kind: "rendered", observation };
    }
    return {
      id: `legacy:${legacy.block.id}`,
      subject,
      sourceSnapshot,
      adapter: legacy.kind === "passage" ? { id: "herdr-rendered-passage", version: 1 } : { id: "floatty-block-text", version: 1 },
      mediaType: "text/plain",
      contentHash: legacy.sourceHash,
      capturedAt: observation?.capturedAt ?? legacy.block.createdAt,
      ...(observation ? { observation } : {}),
    };
  }

  private findLegacyFilesystemResource(filePath: string): Resource | null {
    const candidates = this.resources.listSources().flatMap((source) => {
      if (source.provider !== "filesystem") return [];
      const rows = this.database.query("SELECT id, address_json FROM resources WHERE source_id = ? AND provider = 'filesystem'").all(source.id) as Array<{ id: string; address_json: string }>;
      return rows.flatMap((row) => {
        const address = json(row.address_json, "Filesystem resource address");
        if (!address || typeof address !== "object" || !("path" in address) || typeof address.path !== "string") return [];
        return [{ resource: this.resources.require(row.id), absolutePath: resolve(source.boundary.root, address.path) }];
      });
    });
    const absoluteLegacy = isAbsolute(filePath) ? resolve(filePath) : null;
    const matches = candidates.filter((candidate) =>
      absoluteLegacy ? candidate.absolutePath === absoluteLegacy : candidate.resource.address.kind === "filesystem" && candidate.resource.address.path === filePath.replaceAll("\\", "/")
    );
    return matches.length === 1 ? matches[0]!.resource : null;
  }

  private stripLegacyProperties(block: Block): void {
    const obsolete = parsePropertyRecords(block.text)
      .filter((property) =>
        property.scope === "block" && TARGET_PROPERTY_KEYS[property.key] === true
      )
      .sort((left, right) => right.start - left.start);
    if (obsolete.length === 0) return;
    let value = block.text;
    for (const property of obsolete) {
      value = `${value.slice(0, property.start)}${value.slice(property.end)}`;
    }
    this.blocks.replaceCanonicalText(block.id, value);
  }

  private migrateWebAnnotation(row: WebAnnotationRow): void {
    const collision = this.blocks.get(row.id);
    if (collision) throw new Error(`Web annotation ID collides with an existing block: ${row.id}`);
    const root = this.ensureSystemRoot();
    const rawProvenance = json(row.representation_json, "Web annotation representation");
    if (!rawProvenance || typeof rawProvenance !== "object") {
      throw new Error(`Web annotation representation is invalid: ${row.id}`);
    }
    const provenance = rawProvenance as Record<string, unknown>;
    if (!provenance.adapter || typeof provenance.adapter !== "object") {
      throw new Error(`Web annotation adapter is invalid: ${row.id}`);
    }
    const adapter = provenance.adapter as Record<string, unknown>;
    const revision = normalizeRetainedResourceRevisionRef(json(row.revision_json, "Web annotation revision"));
    const rawAnchor = json(row.anchor_json, "Web annotation anchor");
    if (!rawAnchor || typeof rawAnchor !== "object") throw new Error(`Web annotation anchor is invalid: ${row.id}`);
    const anchorRecord = rawAnchor as Record<string, unknown>;
    const target: AnnotationTarget = normalizeAnnotationTarget({
      representation: {
        id: row.representation_id,
        subject: { kind: "resource", resourceId: row.resource_id },
        sourceSnapshot: { kind: "resource", resourceId: row.resource_id, sourceSnapshotId: row.source_snapshot_id, revision },
        adapter: { id: adapter.id, version: adapter.version },
        mediaType: provenance.mediaType,
        contentHash: provenance.contentHash,
        capturedAt: provenance.derivedAt ?? row.created_at,
      },
      anchor: {
        kind: "text-quote",
        start: anchorRecord.start,
        end: anchorRecord.end,
        exact: anchorRecord.exact,
        prefix: anchorRecord.prefix,
        suffix: anchorRecord.suffix,
      },
    });
    this.blocks.insertCanonical(
      row.id,
      formatAnnotationBlock({ target, body: text(row.body, "Web annotation body"), source: "user" }),
      root,
      "system",
      iso(row.created_at, "Web annotation creation time"),
    );
    this.insertTarget(row.id, target, row.created_at);
    this.appendEvent({
      annotationId: row.id,
      sourceRepresentation: target.representation,
      targetRepresentation: target.representation,
      resolvedTarget: target,
      method: { ...TEXT_CODEC, method: "legacy-web-migration" },
      reviewer: { kind: "system", id: "pie-250-migration" },
      confidence: 1,
      candidates: [],
      status: "resolved",
      appliesCurrent: true,
      createdAt: row.created_at,
    });
  }

  private isIso(value: string): boolean {
    try {
      return new Date(value).toISOString() === value;
    } catch {
      return false;
    }
  }
}
