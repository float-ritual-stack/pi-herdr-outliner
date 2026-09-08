import { createHash } from "node:crypto";
import { getProperty, stripProperties } from "./properties";
import type {
  AnnotationAnchor,
  AnnotationAnchorState,
  AnnotationCreateInput,
  AnnotationLifecycle,
  AnnotationRecord,
  AnnotationSource,
  AnnotationTarget,
  Block,
} from "./types";

const DEFAULT_CONTEXT_UNITS = 32;
const ANNOTATION_TYPE = "annotation";
const ANNOTATION_REPLY_TYPE = "annotation-reply";

function encodePropertyValue(value: string): string {
  return `v1-${Buffer.from(value, "utf8").toString("base64url")}`;
}

function decodePropertyValue(value: string | undefined, label: string): string {
  if (value === undefined || !value.startsWith("v1-")) {
    throw new Error(`Annotation has invalid ${label}`);
  }
  try {
    return Buffer.from(value.slice(3), "base64url").toString("utf8");
  } catch {
    throw new Error(`Annotation has invalid ${label}`);
  }
}

function finiteInteger(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) {
    throw new Error(`${label} must be an integer >= ${minimum}`);
  }
  return value;
}

function propertyInteger(block: Block, key: string, minimum = 0): number {
  const value = getProperty(block.properties, key);
  const parsed = value === undefined ? Number.NaN : Number(value);
  return finiteInteger(parsed, key, minimum);
}

function normalizeSource(source: AnnotationSource): AnnotationSource {
  if (source !== "user" && source !== "agent") {
    throw new Error("Annotation source must be user or agent");
  }
  return source;
}

function normalizeLifecycle(lifecycle: string | undefined): AnnotationLifecycle {
  if (lifecycle === undefined || lifecycle === "open") return "open";
  if (lifecycle === "resolved") return lifecycle;
  throw new Error(`Unsupported annotation lifecycle: ${lifecycle}`);
}

function normalizeAnchorState(state: string | undefined): AnnotationAnchorState {
  if (state === undefined || state === "anchored") return "anchored";
  if (state === "ambiguous" || state === "orphaned") return state;
  throw new Error(`Unsupported annotation anchor state: ${state}`);
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
): AnnotationAnchor {
  const normalizedStart = finiteInteger(start, "Annotation start");
  const normalizedEnd = finiteInteger(end, "Annotation end");
  if (normalizedEnd <= normalizedStart || normalizedEnd > text.length) {
    throw new Error("Annotation range must select non-empty UTF-16 source text");
  }
  const version = sourceVersion.trim();
  if (!version) throw new Error("Annotation source version cannot be empty");
  const hash = sourceHash.trim();
  if (!hash) throw new Error("Annotation source hash cannot be empty");
  const context = finiteInteger(contextUnits, "Annotation context size");
  return {
    start: normalizedStart,
    end: normalizedEnd,
    excerpt: text.slice(normalizedStart, normalizedEnd),
    contextBefore: text.slice(Math.max(0, normalizedStart - context), normalizedStart),
    contextAfter: text.slice(normalizedEnd, normalizedEnd + context),
    sourceVersion: version,
    sourceHash: hash,
  };
}

export function normalizeAnnotationTarget(target: AnnotationTarget): AnnotationTarget {
  const sourceBlockId = target.sourceBlockId.trim();
  if (!sourceBlockId) throw new Error("Annotation source block cannot be empty");
  const anchor = target.anchor;
  const start = finiteInteger(anchor.start, "Annotation start");
  const end = finiteInteger(anchor.end, "Annotation end");
  if (end <= start) throw new Error("Annotation range must be non-empty");
  if (!anchor.excerpt || anchor.excerpt.length !== end - start) {
    throw new Error("Annotation excerpt must exactly match its UTF-16 range length");
  }

  if (!anchor.sourceVersion.trim() || !anchor.sourceHash.trim()) {
    throw new Error("Annotation source version and hash are required");
  }
  const normalizedAnchor: AnnotationAnchor = {
    start,
    end,
    excerpt: anchor.excerpt,
    contextBefore: anchor.contextBefore,
    contextAfter: anchor.contextAfter,
    sourceVersion: anchor.sourceVersion.trim(),
    sourceHash: anchor.sourceHash.trim(),
  };
  if (target.kind === "block") return { kind: "block", sourceBlockId, anchor: normalizedAnchor };
  const filePath = target.filePath.trim();
  if (!filePath) throw new Error("Annotation file path cannot be empty");
  const startLine = finiteInteger(target.startLine, "Annotation start line", 1);
  const endLine = finiteInteger(target.endLine, "Annotation end line", 1);
  if (endLine < startLine) throw new Error("Annotation end line cannot precede its start line");
  return { kind: "file", sourceBlockId, filePath, startLine, endLine, anchor: normalizedAnchor };
}
export function annotationOffsetsForLineRange(
  text: string,
  startLine: number,
  endLine: number,
): { start: number; end: number } {
  const normalizedStartLine = finiteInteger(startLine, "Annotation start line", 1);
  const normalizedEndLine = finiteInteger(endLine, "Annotation end line", 1);
  if (normalizedEndLine < normalizedStartLine) {
    throw new Error("Annotation end line cannot precede its start line");
  }
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  if (normalizedEndLine > starts.length) {
    throw new Error(`Annotation line ${normalizedEndLine} exceeds source line count ${starts.length}`);
  }
  const start = starts[normalizedStartLine - 1]!;
  const nextLineStart = starts[normalizedEndLine];
  let end = nextLineStart === undefined ? text.length : nextLineStart - 1;
  if (end > start && text.charCodeAt(end - 1) === 13) end -= 1;
  if (end <= start) throw new Error("Annotation line range must contain source text");
  return { start, end };
}

export function annotationLineRangeForOffsets(
  text: string,
  start: number,
  end: number,
): { startLine: number; endLine: number } {
  const normalizedStart = finiteInteger(start, "Annotation start");
  const normalizedEnd = finiteInteger(end, "Annotation end");
  if (normalizedEnd <= normalizedStart || normalizedEnd > text.length) {
    throw new Error("Annotation range must select non-empty UTF-16 source text");
  }
  const lineAt = (offset: number): number => {
    let line = 1;
    for (let index = 0; index < offset; index += 1) {
      if (text.charCodeAt(index) === 10) line += 1;
    }
    return line;
  };
  return {
    startLine: lineAt(normalizedStart),
    endLine: lineAt(Math.max(normalizedStart, normalizedEnd - 1)),
  };
}

export function normalizeAnnotationCreateInput(input: AnnotationCreateInput): AnnotationCreateInput {
  const body = input.body.trim();
  if (!body) throw new Error("Annotation body cannot be empty");
  return { target: normalizeAnnotationTarget(input.target), body, source: normalizeSource(input.source) };
}

function annotationHeading(target: AnnotationTarget): string {
  const excerpt = target.anchor.excerpt.replace(/\s+/g, " ").trim();
  const quoted = `“${excerpt.length > 72 ? `${excerpt.slice(0, 71)}…` : excerpt}”`;
  if (target.kind === "file") {
    const range = target.startLine === target.endLine
      ? `${target.startLine}`
      : `${target.startLine}-${target.endLine}`;
    return `Comment on ${target.filePath}:${range} · ${quoted}`;
  }
  return `Comment on ${quoted}`;
}

function annotationMetadata(
  input: AnnotationCreateInput,
  parentAnnotationId: string | undefined,
  lifecycle: AnnotationLifecycle,
  anchorState: AnnotationAnchorState,
  promotedBlockIds: readonly string[],
): string {
  const { target, source } = input;
  const values = [
    `[type::${parentAnnotationId ? ANNOTATION_REPLY_TYPE : ANNOTATION_TYPE}]`,
    `[target-kind::${target.kind}]`,
    `[source-block::${target.sourceBlockId}]`,
    `[anchor-start::${target.anchor.start}]`,
    `[anchor-end::${target.anchor.end}]`,
    `[anchor-excerpt::${encodePropertyValue(target.anchor.excerpt)}]`,
    `[anchor-before::${encodePropertyValue(target.anchor.contextBefore)}]`,
    `[anchor-after::${encodePropertyValue(target.anchor.contextAfter)}]`,
    `[source-version::${encodePropertyValue(target.anchor.sourceVersion)}]`,
    `[source-hash::${target.anchor.sourceHash}]`,
    `[annotation-source::${source}]`,
    `[annotation-status::${lifecycle}]`,
    `[anchor-state::${anchorState}]`,
  ];
  if (target.kind === "file") {
    values.push(
      `[target-file::${encodePropertyValue(target.filePath)}]`,
      `[line-start::${target.startLine}]`,
      `[line-end::${target.endLine}]`,
    );
  }
  if (parentAnnotationId) values.push(`[parent-annotation::${parentAnnotationId}]`);
  for (const promotedBlockId of promotedBlockIds) {
    const normalized = promotedBlockId.trim();
    if (!normalized || normalized.includes("]")) {
      throw new Error("Promoted block ID cannot be empty or contain ]");
    }
    values.push(`[promoted-block::${normalized}]`);
  }
  return values.join(" ");
}

export function formatAnnotation(
  rawInput: AnnotationCreateInput,
  parentAnnotationId?: string,
  options: {
    lifecycle?: AnnotationLifecycle;
    anchorState?: AnnotationAnchorState;
    promotedBlockIds?: readonly string[];
  } = {},
): string {
  const input = normalizeAnnotationCreateInput(rawInput);
  const parent = parentAnnotationId?.trim();
  if (parentAnnotationId !== undefined && !parent) {
    throw new Error("Parent annotation ID cannot be empty");
  }
  return [
    annotationHeading(input.target),
    annotationMetadata(
      input,
      parent,
      options.lifecycle ?? "open",
      options.anchorState ?? "anchored",
      options.promotedBlockIds ?? [],
    ),
    input.body,
  ].join("\n");
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

export function parseAnnotationBlock(block: Block): AnnotationRecord {
  const type = getProperty(block.properties, "type");
  if (type !== ANNOTATION_TYPE && type !== ANNOTATION_REPLY_TYPE) {
    throw new Error(`Block is not an annotation: ${block.id}`);
  }
  const kind = getProperty(block.properties, "target-kind");
  if (kind !== "block" && kind !== "file") {
    throw new Error(`Annotation has invalid target kind: ${block.id}`);
  }
  const sourceBlockId = getProperty(block.properties, "source-block")?.trim();
  if (!sourceBlockId) throw new Error(`Annotation is missing source block: ${block.id}`);
  const anchor: AnnotationAnchor = {
    start: propertyInteger(block, "anchor-start"),
    end: propertyInteger(block, "anchor-end"),
    excerpt: decodePropertyValue(getProperty(block.properties, "anchor-excerpt"), "anchor excerpt"),
    contextBefore: decodePropertyValue(getProperty(block.properties, "anchor-before"), "anchor context before"),
    contextAfter: decodePropertyValue(getProperty(block.properties, "anchor-after"), "anchor context after"),
    sourceVersion: decodePropertyValue(getProperty(block.properties, "source-version"), "source version"),
    sourceHash: getProperty(block.properties, "source-hash")?.trim() ?? "",
  };
  const target: AnnotationTarget = kind === "block"
    ? { kind, sourceBlockId, anchor }
    : {
        kind,
        sourceBlockId,
        filePath: decodePropertyValue(getProperty(block.properties, "target-file"), "target file"),
        startLine: propertyInteger(block, "line-start", 1),
        endLine: propertyInteger(block, "line-end", 1),
        anchor,
      };
  const source = normalizeSource(getProperty(block.properties, "annotation-source") as AnnotationSource);
  const record: AnnotationRecord = {
    block,
    target: normalizeAnnotationTarget(target),
    body: extractAnnotationBody(block.text),
    source,
    lifecycle: normalizeLifecycle(getProperty(block.properties, "annotation-status")),
    promotedBlockIds: block.properties
      .filter((property) => property.key === "promoted-block")
      .map((property) => property.value),
    anchorState: normalizeAnchorState(getProperty(block.properties, "anchor-state")),
  };
  const parentAnnotationId = getProperty(block.properties, "parent-annotation")?.trim();
  if (parentAnnotationId) record.parentAnnotationId = parentAnnotationId;
  return record;
}

export interface AnnotationReanchorResult {
  state: AnnotationAnchorState;
  anchor: AnnotationAnchor;
}

function contextMatchScore(text: string, start: number, end: number, anchor: AnnotationAnchor): number {
  let before = 0;
  while (
    before < anchor.contextBefore.length &&
    start - before - 1 >= 0 &&
    text[start - before - 1] === anchor.contextBefore[anchor.contextBefore.length - before - 1]
  ) before += 1;
  let after = 0;
  while (
    after < anchor.contextAfter.length &&
    end + after < text.length &&
    text[end + after] === anchor.contextAfter[after]
  ) after += 1;
  return before + after;
}

export function reanchorAnnotation(
  anchor: AnnotationAnchor,
  currentText: string,
  sourceVersion: string,
  sourceHash = annotationSourceHash(currentText),
): AnnotationReanchorResult {
  if (
    (anchor.sourceHash === sourceHash || anchor.sourceVersion === sourceVersion) &&
    currentText.slice(anchor.start, anchor.end) === anchor.excerpt
  ) {
    return {
      state: "anchored",
      anchor: createAnnotationAnchor(currentText, anchor.start, anchor.end, sourceVersion, sourceHash),
    };
  }
  const occurrences: number[] = [];
  let cursor = 0;
  while (cursor <= currentText.length - anchor.excerpt.length) {
    const index = currentText.indexOf(anchor.excerpt, cursor);
    if (index < 0) break;
    occurrences.push(index);
    cursor = index + 1;
  }
  if (occurrences.length === 0) return { state: "orphaned", anchor: { ...anchor } };
  if (occurrences.length === 1) {
    const start = occurrences[0]!;
    return {
      state: "anchored",
      anchor: createAnnotationAnchor(currentText, start, start + anchor.excerpt.length, sourceVersion, sourceHash),
    };
  }
  const ranked = occurrences
    .map((start) => ({ start, score: contextMatchScore(currentText, start, start + anchor.excerpt.length, anchor) }))
    .sort((left, right) => right.score - left.score || left.start - right.start);
  if (ranked[0]!.score === ranked[1]!.score) return { state: "ambiguous", anchor: { ...anchor } };
  const start = ranked[0]!.start;
  return {
    state: "anchored",
    anchor: createAnnotationAnchor(currentText, start, start + anchor.excerpt.length, sourceVersion, sourceHash),
  };
}
