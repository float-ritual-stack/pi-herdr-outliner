import {
  annotationSourceHash,
  normalizeAnnotationTarget,
} from "./annotations";
import type {
  AttentionClientState,
  AttentionMark,
  AttentionMarkInput,
  AnnotationAnchor,
  AttentionRole,
  AttentionSourceState,
  AttentionTarget,
  Block,
  OutlinerClientRegistration,
} from "./types";

export const ATTENTION_DEFAULT_EXPIRY_MS = 5 * 60 * 1_000;
export const ATTENTION_MIN_EXPIRY_MS = 100;
export const ATTENTION_MAX_EXPIRY_MS = 60 * 60 * 1_000;
export const ATTENTION_MAX_SUPPORTING_MARKS = 8;

function printable(value: unknown, label: string, maximum = 500): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (
    !normalized ||
    normalized.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new Error(`${label} must be 1-${maximum} printable characters`);
  }
  return normalized;
}

function normalizeExpiry(value: number | undefined): number {
  const expiry = value ?? ATTENTION_DEFAULT_EXPIRY_MS;
  if (
    !Number.isFinite(expiry) ||
    !Number.isInteger(expiry) ||
    expiry < ATTENTION_MIN_EXPIRY_MS ||
    expiry > ATTENTION_MAX_EXPIRY_MS
  ) {
    throw new Error(
      `Attention expiry must be an integer from ${ATTENTION_MIN_EXPIRY_MS} to ${ATTENTION_MAX_EXPIRY_MS} milliseconds`,
    );
  }
  return expiry;
}

function normalizeRole(value: AttentionRole | undefined): AttentionRole {
  if (value === undefined || value === "current") return "current";
  if (value === "supporting") return value;
  throw new Error(`Unsupported attention role: ${String(value)}`);
}

function normalizeTarget(
  input: AttentionMarkInput["target"],
  source: Block,
): AttentionTarget {
  if (!input || typeof input !== "object") throw new Error("Attention target is required");
  const sourceBlockId = printable(input.sourceBlockId, "Attention source block ID", 200);
  if (sourceBlockId !== source.id) throw new Error("Attention source block does not match resolved source");

  if (input.kind === "file") {
    const target = normalizeAnnotationTarget({
      kind: "file",
      sourceBlockId,
      filePath: input.filePath,
      startLine: input.startLine,
      endLine: input.endLine,
      anchor: input.anchor,
    });
    if (target.kind !== "file") throw new Error("Invalid file attention target");
    return target;
  }
  if (input.kind !== "block") {
    throw new Error(`Unsupported attention target kind: ${String((input as { kind?: unknown }).kind)}`);
  }

  const actualHash = annotationSourceHash(source.text);
  const sourceVersion = input.anchor?.sourceVersion ?? input.sourceVersion ?? source.updatedAt;
  const sourceHash = input.anchor?.sourceHash ?? input.sourceHash ?? actualHash;
  if (sourceVersion !== source.updatedAt || sourceHash !== actualHash) {
    throw new Error("Attention source evidence does not match the current block");
  }
  let anchor: AnnotationAnchor | undefined;
  if (input.anchor) {
    const target = normalizeAnnotationTarget({
      kind: "block",
      sourceBlockId,
      anchor: input.anchor,
    });
    if (target.kind !== "block") throw new Error("Invalid block attention target");
    if (source.text.slice(target.anchor.start, target.anchor.end) !== target.anchor.excerpt) {
      throw new Error("Attention excerpt does not match the current block range");
    }
    anchor = target.anchor;
  }
  const fragmentId = input.fragmentId === undefined
    ? undefined
    : printable(input.fragmentId, "Attention fragment ID", 200);
  return {
    kind: "block",
    sourceBlockId,
    sourceVersion,
    sourceHash,
    ...(fragmentId ? { fragmentId } : {}),
    ...(anchor ? { anchor } : {}),
  };
}

export function normalizeAttentionMark(
  input: AttentionMarkInput,
  client: OutlinerClientRegistration,
  source: Block,
  now = Date.now(),
): AttentionMark {
  if (!input || typeof input !== "object") throw new Error("Attention mark input is required");
  const targetClientId = printable(input.targetClientId, "Attention target client ID", 200);
  if (targetClientId !== client.clientId) throw new Error("Attention target client does not match resolved client");
  const markId = printable(input.markId, "Attention mark ID", 200);
  const sender = printable(input.sender, "Attention sender", 200);
  const tones = ["current", "info", "warning", "error", "match", "dim"] as const;
  if (!tones.includes(input.tone)) throw new Error(`Unsupported attention tone: ${String(input.tone)}`);
  if (input.reveal !== undefined && typeof input.reveal !== "boolean") {
    throw new Error("Attention reveal must be boolean");
  }
  if (input.focus !== undefined && typeof input.focus !== "boolean") {
    throw new Error("Attention focus must be boolean");
  }
  const expiry = normalizeExpiry(input.expiresInMs);
  return {
    markId,
    targetClientId,
    target: normalizeTarget(input.target, source),
    tone: input.tone,
    role: normalizeRole(input.role),
    sender,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + expiry).toISOString(),
    returnCuePending: !(input.focus || client.runtime?.focused),
    sourceState: "active",
  };
}

export function attentionSourceState(
  mark: AttentionMark,
  source: Block | null,
): AttentionSourceState {
  if (!source || source.id !== mark.target.sourceBlockId) return "stale";
  if (mark.target.kind === "file") return mark.sourceState;
  return mark.target.sourceVersion === source.updatedAt &&
      mark.target.sourceHash === annotationSourceHash(source.text) &&
      (!mark.target.anchor ||
        source.text.slice(mark.target.anchor.start, mark.target.anchor.end) === mark.target.anchor.excerpt)
    ? "active"
    : "stale";
}

export function attentionSummary(marks: readonly AttentionMark[], pendingCount: number): string {
  if (pendingCount <= 0 || marks.length === 0) return "";
  let latest: AttentionMark | undefined;
  for (let index = marks.length - 1; index >= 0; index -= 1) {
    if (marks[index]!.returnCuePending) {
      latest = marks[index];
      break;
    }
  }
  if (!latest) latest = marks.at(-1);
  if (!latest) return "";
  const count = pendingCount === 1 ? "1 attention cue" : `${pendingCount} attention cues`;
  return `${count} · latest ${latest.tone} on ${latest.target.sourceBlockId.slice(0, 8)}`;
}

export function attentionClientState(
  targetClientId: string,
  marks: readonly AttentionMark[],
  pendingCount: number,
  updatedAt = new Date().toISOString(),
): AttentionClientState {
  const bounded = [...marks].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  let current: AttentionMark | undefined;
  for (let index = bounded.length - 1; index >= 0; index -= 1) {
    if (bounded[index]!.role === "current") {
      current = bounded[index];
      break;
    }
  }
  const boundedPendingCount = Math.min(999, Math.max(0, Math.trunc(pendingCount)));
  return {
    targetClientId,
    marks: bounded,
    ...(current ? { currentMarkId: current.markId } : {}),
    pendingCount: boundedPendingCount,
    summary: attentionSummary(bounded, boundedPendingCount),
    updatedAt,
  };
}

export function emptyAttentionState(targetClientId: string): AttentionClientState {
  return attentionClientState(targetClientId, [], 0);
}

export function currentAttentionMark(
  state: Readonly<AttentionClientState>,
  sourceBlockId?: string | null,
): AttentionMark | null {
  let mark = state.currentMarkId
    ? state.marks.find((candidate) => candidate.markId === state.currentMarkId)
    : undefined;
  if (!mark) {
    for (let index = state.marks.length - 1; index >= 0; index -= 1) {
      if (state.marks[index]!.role === "current") {
        mark = state.marks[index];
        break;
      }
    }
  }
  if (!mark || mark.sourceState !== "active") return null;
  if (sourceBlockId && mark.target.sourceBlockId !== sourceBlockId) return null;
  return mark;
}

export function attentionSourceLine(text: string, mark: AttentionMark): number {
  const offset = mark.target.anchor?.start ?? 0;
  let line = 0;
  for (let index = 0; index < Math.min(offset, text.length); index += 1) {
    if (text[index] === "\n") line += 1;
  }
  return line;
}
