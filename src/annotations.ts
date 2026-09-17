import { createHash } from "node:crypto";
import { normalizeRetainedResourceRevisionRef } from "./resources";
import { getProperty, stripProperties } from "./properties";
import type {
  AnnotationAnchor,
  AnnotationCreateInput,
  AnnotationLifecycle,
  AnnotationRepresentation,
  AnnotationResolutionEvent,
  AnnotationResolutionMethod,
  AnnotationResolutionCandidate,
  AnnotationResolutionReviewer,
  AnnotationSource,
  AnnotationSourceSnapshot,
  AnnotationSubject,
  AnnotationTarget,
  AttentionTextAnchor,
  Block,
  RenderedPassageObservation,
  PdfRegion,
  RenderedPassageProjection,
} from "./types";

const DEFAULT_CONTEXT_UNITS = 32;
const ANNOTATION_TYPE = "annotation";
const ANNOTATION_REPLY_TYPE = "annotation-reply";
export const OBSOLETE_ANNOTATION_PROPERTY_KEYS: Readonly<Record<string, true>> = {
  "target-kind": true,
  "source-block": true,
  "anchor-state": true,
  "anchor-start": true,
  "anchor-end": true,
  "anchor-excerpt": true,
  "anchor-before": true,
  "anchor-after": true,
  "source-version": true,
  "source-hash": true,
  "rendered-quote": true,
  "observed-at": true,
  "observed-pane": true,
  "observed-revision": true,
  "observed-context": true,
  "observed-client": true,
  "observed-validation": true,
  "observed-projection": true,
  "target-file": true,
  "line-start": true,
  "line-end": true,
};

function identity(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} cannot be empty`);
  return value.trim();
}

function evidenceText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} cannot be empty`);
  }
  return value;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  const normalized = evidenceText(value, label).trim();
  if (normalized.length > maximum) throw new Error(`${label} must be at most ${maximum} characters`);
  return normalized;
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} must be an integer >= ${minimum}`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const normalized = identity(value, label);
  if (new Date(normalized).toISOString() !== normalized) throw new Error(`${label} must be an ISO timestamp`);
  return normalized;
}

function optionalText(value: unknown, label: string): string | null {
  if (value === null) return null;
  return identity(value, label);
}

function source(value: unknown): AnnotationSource {
  if (value !== "user" && value !== "agent") throw new Error("Annotation source must be user or agent");
  return value;
}

export function annotationSourceHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
export function createAnnotationAnchor(
  text: string,
  start: number,
  end: number,
  sourceVersion: string,
  sourceHash = annotationSourceHash(text),
  contextUnits = DEFAULT_CONTEXT_UNITS,
): AttentionTextAnchor {
  integer(start, "Annotation start");
  integer(end, "Annotation end");
  integer(contextUnits, "Annotation context size");
  if (end <= start || end > text.length) {
    throw new Error("Annotation range must select non-empty UTF-16 source text");
  }
  return {
    start,
    end,
    excerpt: text.slice(start, end),
    contextBefore: text.slice(Math.max(0, start - contextUnits), start),
    contextAfter: text.slice(end, end + contextUnits),
    sourceVersion: identity(sourceVersion, "Annotation source version"),
    sourceHash: identity(sourceHash, "Annotation source hash"),
  };
}


export function createTextQuoteAnchor(
  text: string,
  start: number,
  end: number,
  contextUnits = DEFAULT_CONTEXT_UNITS,
): Extract<AnnotationAnchor, { kind: "text-quote" }> {
  integer(start, "Annotation start");
  integer(end, "Annotation end");
  integer(contextUnits, "Annotation context size");
  if (end <= start || end > text.length) {
    throw new Error("Annotation range must select non-empty UTF-16 source text");
  }
  return {
    kind: "text-quote",
    start,
    end,
    exact: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - contextUnits), start),
    suffix: text.slice(end, end + contextUnits),
  };
}

export function createPdfPageRegionAnchor(
  text: string,
  start: number,
  end: number,
  page: number,
  regions: readonly PdfRegion[],
): Extract<AnnotationAnchor, { kind: "pdf-page-region" }> {
  const quote = createTextQuoteAnchor(text, start, end);
  return {
    kind: "pdf-page-region",
    page,
    regions,
    start: quote.start,
    end: quote.end,
    exact: quote.exact,
    prefix: quote.prefix,
    suffix: quote.suffix,
  };
}

function normalizeObservation(value: unknown): RenderedPassageObservation {
  if (!value || typeof value !== "object") throw new Error("Rendered passage observation is required");
  const observation = value as Record<string, unknown>;
  const projection = observation.projection;
  if (projection !== "canonical" && projection !== "resolved" && projection !== "generated" && projection !== "mixed") {
    throw new Error(`Unsupported rendered passage projection: ${String(projection)}`);
  }
  if (observation.validation !== "herdr-keybinding") {
    throw new Error("Rendered passage must come from a revision-validated Herdr keybinding");
  }
  return {
    quote: evidenceText(observation.quote, "Rendered passage quote"),
    capturedAt: timestamp(observation.capturedAt, "Rendered passage capture time"),
    hostBlockId: identity(observation.hostBlockId, "Rendered passage host block"),
    paneId: identity(observation.paneId, "Rendered passage pane"),
    contentRevision: integer(observation.contentRevision, "Rendered passage content revision"),
    contextId: identity(observation.contextId, "Rendered passage context"),
    detailClientId: identity(observation.detailClientId, "Rendered passage Detail client"),
    validation: "herdr-keybinding",
    projection,
  };
}

export function normalizeAnnotationSubject(value: unknown, allowLegacy = false): AnnotationSubject {
  if (!value || typeof value !== "object") throw new Error("Annotation subject must be an object");
  const subject = value as Record<string, unknown>;
  if (subject.kind === "block") return { kind: "block", blockId: identity(subject.blockId, "Annotation block") };
  if (subject.kind === "resource") return { kind: "resource", resourceId: identity(subject.resourceId, "Annotation resource") };
  if (subject.kind === "legacy-file" && allowLegacy) {
    return {
      kind: "legacy-file",
      sourceBlockId: identity(subject.sourceBlockId, "Legacy annotation source block"),
      filePath: identity(subject.filePath, "Legacy annotation file path"),
    };
  }
  throw new Error(`Unsupported annotation subject: ${String(subject.kind)}`);
}

export function normalizeAnnotationSourceSnapshot(
  value: unknown,
  allowLegacy = false,
): AnnotationSourceSnapshot {
  if (!value || typeof value !== "object") throw new Error("Annotation source snapshot must be an object");
  const snapshot = value as Record<string, unknown>;
  if (snapshot.kind === "block") {
    return {
      kind: "block",
      blockId: identity(snapshot.blockId, "Snapshot block"),
      updatedAt: timestamp(snapshot.updatedAt, "Snapshot update time"),
      contentHash: identity(snapshot.contentHash, "Snapshot content hash"),
    };
  }
  if (snapshot.kind === "resource") {
    const sourceSnapshotId = snapshot.sourceSnapshotId === null
      ? null
      : identity(snapshot.sourceSnapshotId, "Resource source snapshot");
    return {
      kind: "resource",
      resourceId: identity(snapshot.resourceId, "Snapshot resource"),
      sourceSnapshotId,
      revision: snapshot.revision === null || snapshot.revision === undefined
        ? null
        : normalizeRetainedResourceRevisionRef(snapshot.revision),
    };
  }
  if (snapshot.kind === "rendered") return { kind: "rendered", observation: normalizeObservation(snapshot.observation) };
  if (snapshot.kind === "unknown" && allowLegacy) {
    return { kind: "unknown", reason: identity(snapshot.reason, "Unknown snapshot reason") };
  }
  throw new Error(`Unsupported annotation source snapshot: ${String(snapshot.kind)}`);
}

export function normalizeAnnotationRepresentation(
  value: unknown,
  allowLegacy = false,
): AnnotationRepresentation {
  if (!value || typeof value !== "object") throw new Error("Annotation representation must be an object");
  const representation = value as Record<string, unknown>;
  const adapterValue = representation.adapter;
  let adapter: AnnotationRepresentation["adapter"] = null;
  if (adapterValue !== null) {
    if (!adapterValue || typeof adapterValue !== "object") {
      throw new Error("Annotation adapter must be an object or null");
    }
    const adapterRecord = adapterValue as Record<string, unknown>;
    adapter = {
      id: identity(adapterRecord.id, "Annotation adapter ID"),
      version: integer(adapterRecord.version, "Annotation adapter version", 1),
    };
  }
  const normalized: AnnotationRepresentation = {
    id: identity(representation.id, "Annotation representation ID"),
    subject: normalizeAnnotationSubject(representation.subject, allowLegacy),
    sourceSnapshot: normalizeAnnotationSourceSnapshot(representation.sourceSnapshot, allowLegacy),
    adapter,
    mediaType: optionalText(representation.mediaType, "Annotation media type"),
    contentHash: optionalText(representation.contentHash, "Annotation content hash"),
    capturedAt: timestamp(representation.capturedAt, "Annotation capture time"),
  };
  if (normalized.subject.kind === "block") {
    if (
      normalized.sourceSnapshot.kind === "block" &&
      normalized.sourceSnapshot.blockId !== normalized.subject.blockId
    ) throw new Error("Block snapshot does not belong to the annotation subject");
    if (
      normalized.sourceSnapshot.kind === "rendered" &&
      normalized.sourceSnapshot.observation.hostBlockId !== normalized.subject.blockId
    ) throw new Error("Rendered snapshot does not belong to the annotation subject");
  }
  if (
    normalized.subject.kind === "resource" &&
    normalized.sourceSnapshot.kind === "resource" &&
    normalized.sourceSnapshot.resourceId !== normalized.subject.resourceId
  ) throw new Error("Resource snapshot does not belong to the annotation subject");
  if (representation.observation !== undefined) {
    const observation = normalizeObservation(representation.observation);
    if (
      normalized.subject.kind === "block" &&
      observation.hostBlockId !== normalized.subject.blockId
    ) throw new Error("Rendered observation does not belong to the annotation subject");
    return { ...normalized, observation };
  }
  return normalized;
}

export function normalizeAnnotationAnchor(value: unknown): AnnotationAnchor {
  if (!value || typeof value !== "object") throw new Error("Annotation anchor must be an object");
  const anchor = value as Record<string, unknown>;
  if (anchor.kind === "text-quote") {
    const start = anchor.start === null ? null : integer(anchor.start, "Annotation start");
    const end = anchor.end === null ? null : integer(anchor.end, "Annotation end");
    if ((start === null) !== (end === null) || (start !== null && end !== null && end <= start)) {
      throw new Error("Text quote positions must be null together or form a non-empty range");
    }
    const exact = evidenceText(anchor.exact, "Annotation quote");
    if (start !== null && end !== null && end - start !== exact.length) {
      throw new Error("Annotation quote length must match its UTF-16 range");
    }
    if (typeof anchor.prefix !== "string" || typeof anchor.suffix !== "string") {
      throw new Error("Annotation quote context must be strings");
    }
    return { kind: "text-quote", start, end, exact, prefix: anchor.prefix, suffix: anchor.suffix };
  }
  if (anchor.kind === "dom-range") {
    const point = (raw: unknown, label: string) => {
      if (!raw || typeof raw !== "object") throw new Error(`${label} must be an object`);
      const record = raw as Record<string, unknown>;
      return { selector: identity(record.selector, `${label} selector`), textNode: integer(record.textNode, `${label} text node`), offset: integer(record.offset, `${label} offset`) };
    };
    return { kind: "dom-range", start: point(anchor.start, "DOM start"), end: point(anchor.end, "DOM end"), exact: evidenceText(anchor.exact, "DOM exact text") };
  }
  if (anchor.kind === "pdf-page-region") {
    if (!Array.isArray(anchor.regions) || anchor.regions.length === 0) {
      throw new Error("PDF anchor requires at least one region");
    }
    const quoteFields = ["start", "end", "prefix", "suffix"] as const;
    const presentQuoteFields = quoteFields.filter((key) => anchor[key] !== undefined);
    const legacyEvidence = presentQuoteFields.length === 0;
    const regions = anchor.regions.map((raw) => {
      if (!raw || typeof raw !== "object") throw new Error("PDF region must be an object");
      const region = raw as Record<string, unknown>;
      for (const key of ["x", "y", "width", "height"] as const) {
        if (typeof region[key] !== "number" || !Number.isFinite(region[key])) {
          throw new Error(`PDF region ${key} must be finite`);
        }
      }
      if (!legacyEvidence) {
        if ((region.x as number) < 0 || (region.y as number) < 0) {
          throw new Error("PDF region coordinates cannot be negative");
        }
        if ((region.width as number) <= 0 || (region.height as number) <= 0) {
          throw new Error("PDF region dimensions must be positive");
        }
      }
      return {
        x: region.x as number,
        y: region.y as number,
        width: region.width as number,
        height: region.height as number,
      };
    });
    const page = integer(anchor.page, "PDF page", 1);
    if (legacyEvidence) {
      if (anchor.exact !== null && typeof anchor.exact !== "string") {
        throw new Error("Legacy PDF exact text must be a string or null");
      }
      return {
        kind: "pdf-page-region",
        page,
        regions,
        start: null,
        end: null,
        exact: anchor.exact as string | null,
        prefix: null,
        suffix: null,
      };
    }
    if (presentQuoteFields.length !== quoteFields.length) {
      throw new Error("PDF quote evidence must include range and context together");
    }
    const quote = normalizeAnnotationAnchor({ ...anchor, kind: "text-quote" });
    if (quote.kind !== "text-quote") throw new Error("PDF quote normalization failed");
    return {
      kind: "pdf-page-region",
      page,
      regions,
      start: quote.start,
      end: quote.end,
      exact: quote.exact,
      prefix: quote.prefix,
      suffix: quote.suffix,
    };
  }
  if (anchor.kind === "structured-entity-field") {
    if (!Array.isArray(anchor.fieldPath) || anchor.fieldPath.length === 0) throw new Error("Structured field path cannot be empty");
    return { kind: "structured-entity-field", entityType: identity(anchor.entityType, "Entity type"), entityId: identity(anchor.entityId, "Entity ID"), fieldPath: anchor.fieldPath.map((part) => identity(part, "Field path component")), valueHash: identity(anchor.valueHash, "Field value hash") };
  }
  if (anchor.kind === "provider-comment-id") return { kind: "provider-comment-id", provider: identity(anchor.provider, "Comment provider"), commentId: identity(anchor.commentId, "Provider comment ID") };
  throw new Error(`Unsupported annotation anchor: ${String(anchor.kind)}`);
}

export function normalizeAnnotationTarget(value: unknown, allowLegacy = false): AnnotationTarget {
  if (!value || typeof value !== "object") throw new Error("Annotation target must be an object");
  const target = value as Record<string, unknown>;
  return {
    representation: normalizeAnnotationRepresentation(target.representation, allowLegacy),
    anchor: normalizeAnnotationAnchor(target.anchor),
  };
}

export function normalizeAnnotationCreateInput(
  input: unknown,
  allowLegacy = false,
): AnnotationCreateInput {
  if (!input || typeof input !== "object") throw new Error("Annotation create input must be an object");
  const record = input as Record<string, unknown>;
  return {
    target: normalizeAnnotationTarget(record.target, allowLegacy),
    body: identity(record.body, "Annotation body"),
    source: source(record.source),
  };
}

export function normalizeResolutionMethod(value: unknown): AnnotationResolutionMethod {
  if (!value || typeof value !== "object") throw new Error("Resolution method must be an object");
  const method = value as Record<string, unknown>;
  if (method.kind === "human") {
    return {
      kind: "human",
      method: identity(method.method, "Human resolution method"),
      ...(method.proposalEventId === undefined
        ? {}
        : { proposalEventId: identity(method.proposalEventId, "Proposal event ID") }),
    };
  }
  if (method.kind === "codec") return { kind: "codec", codecId: identity(method.codecId, "Codec ID"), codecVersion: integer(method.codecVersion, "Codec version", 1), method: identity(method.method, "Codec method") };
  if (method.kind === "agent") {
    if (method.method !== "semantic-reconciliation") {
      throw new Error("Unsupported agent resolution method");
    }
    if (!Array.isArray(method.evidence) || method.evidence.length === 0 || method.evidence.length > 8) {
      throw new Error("Agent resolution evidence must contain 1-8 entries");
    }
    return {
      kind: "agent",
      modelId: boundedText(method.modelId, "Agent model ID", 200),
      method: "semantic-reconciliation",
      rationale: boundedText(method.rationale, "Agent rationale", 4_000),
      evidence: method.evidence.map((item) => boundedText(item, "Agent evidence", 1_000)),
    };
  }
  throw new Error(`Unsupported resolution method: ${String(method.kind)}`);
}

export function normalizeResolutionReviewer(value: unknown): AnnotationResolutionReviewer {
  if (!value || typeof value !== "object") throw new Error("Resolution reviewer must be an object");
  const reviewer = value as Record<string, unknown>;
  if (reviewer.kind !== "system" && reviewer.kind !== "user" && reviewer.kind !== "agent") throw new Error(`Unsupported resolution reviewer: ${String(reviewer.kind)}`);
  return { kind: reviewer.kind, id: identity(reviewer.id, "Resolution reviewer ID") };
}

export function normalizeResolutionCandidate(value: unknown): AnnotationResolutionCandidate {
  if (!value || typeof value !== "object") throw new Error("Resolution candidate must be an object");
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.confidence !== "number" ||
    !Number.isFinite(candidate.confidence) ||
    candidate.confidence < 0 ||
    candidate.confidence > 1
  ) throw new Error("Resolution candidate confidence must be between 0 and 1");
  return {
    target: normalizeAnnotationTarget(candidate.target, true),
    method: normalizeResolutionMethod(candidate.method),
    confidence: candidate.confidence,
  };
}

export function parseStoredTarget(json: string): AnnotationTarget {
  try {
    return normalizeAnnotationTarget(JSON.parse(json), true);
  } catch (error) {
    throw new Error(`Invalid stored annotation target: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function parseStoredRepresentation(json: string): AnnotationRepresentation {
  try {
    return normalizeAnnotationRepresentation(JSON.parse(json), true);
  } catch (error) {
    throw new Error(`Invalid stored annotation representation: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function parseStoredResolutionEvent(json: string): AnnotationResolutionEvent {
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new Error("Invalid stored annotation resolution event JSON"); }
  if (!value || typeof value !== "object") throw new Error("Stored annotation resolution event must be an object");
  const event = value as Record<string, unknown>;
  const status = event.status;
  if (
    status !== "resolved" &&
    status !== "probable" &&
    status !== "unresolved" &&
    status !== "ambiguous" &&
    status !== "orphaned" &&
    status !== "unsupported" &&
    status !== "rejected"
  ) throw new Error("Stored annotation resolution status is invalid");
  const confidence = event.confidence === null ? null : event.confidence;
  if (confidence !== null && (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)) throw new Error("Stored annotation confidence is invalid");
  return {
    id: identity(event.id, "Resolution event ID"),
    annotationId: identity(event.annotationId, "Resolution annotation ID"),
    sequence: integer(event.sequence, "Resolution sequence"),
    sourceRepresentation: normalizeAnnotationRepresentation(event.sourceRepresentation, true),
    targetRepresentation: normalizeAnnotationRepresentation(event.targetRepresentation, true),
    resolvedTarget: event.resolvedTarget === null ? null : normalizeAnnotationTarget(event.resolvedTarget, true),
    method: normalizeResolutionMethod(event.method),
    reviewer: normalizeResolutionReviewer(event.reviewer),
    confidence,
    candidates: event.candidates === undefined
      ? []
      : Array.isArray(event.candidates)
        ? event.candidates.map(normalizeResolutionCandidate)
        : (() => { throw new Error("Stored annotation candidates must be an array"); })(),
    status,
    appliesCurrent: event.appliesCurrent === true,
    createdAt: timestamp(event.createdAt, "Resolution event time"),
  };
}

function quoteForHeading(target: AnnotationTarget): string {
  if (target.anchor.kind === "text-quote") return target.anchor.exact;
  if (target.anchor.kind === "dom-range") return target.anchor.exact;
  if (target.anchor.kind === "pdf-page-region") return target.anchor.exact ?? `page ${target.anchor.page}`;
  if (target.anchor.kind === "structured-entity-field") return `${target.anchor.entityType}.${target.anchor.fieldPath.join(".")}`;
  return `${target.anchor.provider} comment ${target.anchor.commentId}`;
}

export function formatAnnotationBlock(
  input: AnnotationCreateInput,
  parentAnnotationId?: string,
  options: {
    readonly lifecycle?: AnnotationLifecycle;
    readonly promotedBlockIds?: readonly string[];
    readonly allowLegacy?: boolean;
  } = {},
): string {
  const normalized = normalizeAnnotationCreateInput(input, options.allowLegacy ?? false);
  const parent = parentAnnotationId === undefined ? undefined : identity(parentAnnotationId, "Parent annotation ID");
  const quote = quoteForHeading(normalized.target).replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\s+/g, " ").trim();
  const heading = `Comment on “${quote.length > 72 ? `${quote.slice(0, 71)}…` : quote}”`;
  const metadata = [
    `[type::${parent ? ANNOTATION_REPLY_TYPE : ANNOTATION_TYPE}]`,
    `[annotation-source::${normalized.source}]`,
    `[annotation-status::${options.lifecycle ?? "open"}]`,
  ];
  if (parent) metadata.push(`[parent-annotation::${parent}]`);
  for (const promotedBlockId of options.promotedBlockIds ?? []) metadata.push(`[promoted-block::${identity(promotedBlockId, "Promoted block ID")}]`);
  return [heading, metadata.join(" "), normalized.body].join("\n");
}

export function extractAnnotationBody(text: string): string {
  const lines = text.split(/\r?\n/);
  let bodyStart = lines[0]?.startsWith("Comment on ") ? 1 : 0;
  while (bodyStart < lines.length) {
    const line = lines[bodyStart]!;
    if (line.trim() && stripProperties(line)) break;
    bodyStart += 1;
  }
  return lines.slice(bodyStart).join("\n").trim();
}

export interface AnnotationBlockContent {
  readonly block: Block;
  readonly body: string;
  readonly source: AnnotationSource;
  readonly lifecycle: AnnotationLifecycle;
  readonly promotedBlockIds: readonly string[];
  readonly parentAnnotationId?: string;
}

export function parseAnnotationBlockContent(block: Block): AnnotationBlockContent {
  const type = getProperty(block.properties, "type");
  if (type !== ANNOTATION_TYPE && type !== ANNOTATION_REPLY_TYPE) throw new Error(`Block is not an annotation: ${block.id}`);
  const lifecycle = getProperty(block.properties, "annotation-status") ?? "open";
  if (lifecycle !== "open" && lifecycle !== "resolved") throw new Error(`Unsupported annotation lifecycle: ${lifecycle}`);
  const content: AnnotationBlockContent = {
    block,
    body: extractAnnotationBody(block.text),
    source: source(getProperty(block.properties, "annotation-source")),
    lifecycle,
    promotedBlockIds: block.properties.filter((property) => property.key === "promoted-block").map((property) => property.value),
  };
  const parentAnnotationId = getProperty(block.properties, "parent-annotation")?.trim();
  return parentAnnotationId ? { ...content, parentAnnotationId } : content;
}

function decodeLegacy(value: string | undefined, label: string): string {
  if (!value?.startsWith("v1-")) throw new Error(`Annotation has invalid ${label}`);
  return Buffer.from(value.slice(3), "base64url").toString("utf8");
}

export interface LegacyAnnotationEvidence extends AnnotationBlockContent {
  readonly kind: "block" | "file" | "passage";
  readonly sourceBlockId: string;
  readonly state: "anchored" | "ambiguous" | "orphaned" | "observed";
  readonly anchor: Extract<AnnotationAnchor, { kind: "text-quote" }>;
  readonly sourceVersion: string | null;
  readonly sourceHash: string | null;
  readonly filePath?: string;
  readonly observation?: RenderedPassageObservation;
}

export function parseLegacyAnnotationBlock(block: Block): LegacyAnnotationEvidence {
  const content = parseAnnotationBlockContent(block);
  const kind = getProperty(block.properties, "target-kind");
  if (kind !== "block" && kind !== "file" && kind !== "passage") throw new Error(`Annotation has invalid target kind: ${block.id}`);
  const sourceBlockId = identity(getProperty(block.properties, "source-block"), "Annotation source block");
  const rawState = getProperty(block.properties, "anchor-state") ?? (kind === "passage" ? "observed" : "anchored");
  if (rawState !== "anchored" && rawState !== "ambiguous" && rawState !== "orphaned" && rawState !== "observed") throw new Error(`Annotation has invalid anchor state: ${block.id}`);
  let observation: RenderedPassageObservation | undefined;
  const projection = getProperty(block.properties, "observed-projection") as RenderedPassageProjection | undefined;
  if (projection) {
    observation = normalizeObservation({
      quote: decodeLegacy(getProperty(block.properties, "rendered-quote"), "rendered quote"),
      capturedAt: decodeLegacy(getProperty(block.properties, "observed-at"), "observation time"),
      hostBlockId: sourceBlockId,
      paneId: decodeLegacy(getProperty(block.properties, "observed-pane"), "observation pane"),
      contentRevision: Number(getProperty(block.properties, "observed-revision")),
      contextId: decodeLegacy(getProperty(block.properties, "observed-context"), "observation context"),
      detailClientId: decodeLegacy(getProperty(block.properties, "observed-client"), "observation client"),
      validation: getProperty(block.properties, "observed-validation"),
      projection,
    });
  }
  const exact = kind === "passage"
    ? observation?.quote ?? ""
    : decodeLegacy(getProperty(block.properties, "anchor-excerpt"), "anchor excerpt");
  const start = kind === "passage" ? null : Number(getProperty(block.properties, "anchor-start"));
  const end = kind === "passage" ? null : Number(getProperty(block.properties, "anchor-end"));
  const evidence: LegacyAnnotationEvidence = {
    ...content,
    kind,
    sourceBlockId,
    state: rawState,
    anchor: {
      kind: "text-quote",
      start,
      end,
      exact,
      prefix: kind === "passage" ? "" : decodeLegacy(getProperty(block.properties, "anchor-before"), "anchor prefix"),
      suffix: kind === "passage" ? "" : decodeLegacy(getProperty(block.properties, "anchor-after"), "anchor suffix"),
    },
    sourceVersion: kind === "passage" ? null : decodeLegacy(getProperty(block.properties, "source-version"), "source version"),
    sourceHash: kind === "passage" ? null : identity(getProperty(block.properties, "source-hash"), "Annotation source hash"),
  };
  if (kind === "file") return { ...evidence, filePath: decodeLegacy(getProperty(block.properties, "target-file"), "target file") };
  return observation ? { ...evidence, observation } : evidence;
}
