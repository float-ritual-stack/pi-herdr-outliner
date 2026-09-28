import {
  blockPropertyKeys,
  resolveContextKey,
  subjectLineIndex,
  type ContextBlock,
  type ContextKeyMatcher,
  type ContextResolutionStep,
} from "./context-resolution";
import { parsePropertyRecords } from "./properties";
import {
  providerKeyOccurrences,
  resourceDirectiveOccurrences,
  RESOURCE_DIRECTIVE_PROVIDERS,
  type ResourceDirectiveOptions,
  type ResourceDirectiveProvider,
} from "./resource-references";
import type { AuthoredResourceReferenceLookup } from "./resource-references";
import type { ResourceDescription, ResourceSource } from "./resources";
import type { Block } from "./types";

/**
 * `resources.projection.read`: a ticket's stored details for a provider line
 * (`jira::`) or a ticket page, found from context. It reads only what the
 * catalog already stores. It never registers, refreshes or contacts a
 * provider; only an explicit refresh fetches.
 */

export type ResourceProjectionStatus =
  /** A stored snapshot is shown. */
  | "ready"
  /** A stored snapshot is shown, but the last refresh failed. */
  | "stale"
  /** Registered, but nothing has been fetched yet. */
  | "not-fetched"
  /** The key is known, but no Resource exists for it yet. */
  | "not-registered"
  | "ambiguous"
  | "no-key"
  /** No Source, several Sources, or policy denies reading. */
  | "unavailable";

export interface ResourceProjectionAnchor {
  /** `directive`: a provider line; `page`: the block's own property; `line`: a requested line. */
  readonly kind: "directive" | "page" | "line";
  /** The line the projection follows, as an index into the block's text. */
  readonly line: number;
  readonly start: number;
  readonly end: number;
}

export interface ResourceProjectionField {
  readonly label: string;
  readonly value: string;
}

export interface ResourceProjection {
  readonly anchor: ResourceProjectionAnchor;
  readonly provider: ResourceDirectiveProvider["provider"];
  readonly propertyKey: string;
  readonly options: ResourceDirectiveOptions;
  readonly status: ResourceProjectionStatus;
  /** Why the status is not `ready`, in words for the reader. */
  readonly reason?: string;
  readonly key?: string;
  /** Both keys when `ambiguous`. */
  readonly candidates?: readonly string[];
  readonly resolvedFrom?: {
    readonly step: ContextResolutionStep;
    readonly blockId: string;
    readonly line: number;
  };
  readonly resourceId?: string;
  readonly sourceId?: string;
  readonly summary?: string;
  /** Snapshot metadata in provider order, status and assignee first. */
  readonly fields: readonly ResourceProjectionField[];
  readonly updatedAt?: string;
  readonly fetchedAt?: string;
  readonly externalUrl?: string;
}

export interface ResourceProjectionRequest {
  readonly blockId: string;
  /** Only the projection for this line; a line without a provider line resolves from its context. */
  readonly line?: number;
}

export interface ResourceProjectionReadResult {
  readonly blockId: string;
  readonly revision: number;
  readonly projections: readonly ResourceProjection[];
}

export interface ResourceProjectionDataSource {
  blockContext(blockId: string): { selected: Block | null; ancestors: readonly Block[] };
  readonly resources: {
    listSources(): ResourceSource[];
    resolveAuthoredReference(reference: { kind: "jira"; key: string }): AuthoredResourceReferenceLookup;
    describe(resourceId: string, destinationHostRegistered: boolean): ResourceDescription;
  };
}

const MAX_PROJECTIONS = 16;
const MAX_FIELDS = 8;
const MAX_FIELD_UNITS = 160;
const MAX_TEXT_UNITS = 65_536;
const LEADING_FIELDS = ["status", "assignee"];

function bounded(value: string): string {
  const single = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return single.length > MAX_FIELD_UNITS ? `${single.slice(0, MAX_FIELD_UNITS - 1)}…` : single;
}

function label(key: string): string {
  const words = key.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function projectionFields(metadata: Readonly<Record<string, string | readonly string[] | null>>): ResourceProjectionField[] {
  const entries = Object.entries(metadata).filter(([key]) => key !== "key");
  entries.sort(([left], [right]) => {
    const rank = (key: string) => {
      const index = LEADING_FIELDS.indexOf(key.toLowerCase());
      return index < 0 ? LEADING_FIELDS.length : index;
    };
    return rank(left) - rank(right);
  });
  return entries.flatMap(([key, value]) => {
    const text = Array.isArray(value) ? value.join(", ") : typeof value === "string" ? value : "";
    return text.trim() ? [{ label: label(key), value: bounded(text) }] : [];
  }).slice(0, MAX_FIELDS);
}

/** Keys count in context only when a Source of this provider claims their project. */
function contextMatcher(provider: ResourceDirectiveProvider, sources: readonly ResourceSource[]): ContextKeyMatcher {
  const projects = sources.flatMap((source) =>
    source.provider === provider.provider && "project" in source.boundary
      ? [`${String(source.boundary.project)}-`]
      : []
  );
  return {
    propertyKey: provider.propertyKey,
    keysIn: (text) => providerKeyOccurrences(provider, text)
      .filter((occurrence) => projects.some((prefix) => occurrence.key.startsWith(prefix))),
    keyFromProperty: (value) => {
      const key = value.trim().toUpperCase();
      return provider.keyPattern.test(key) ? key : null;
    },
  };
}

/** The last line of the subject and its preamble: the top of the body. */
function pageAnchorLine(text: string): number {
  const subject = Math.max(0, subjectLineIndex(text));
  const metadataLines = new Set(parsePropertyRecords(text)
    .filter((record) => record.scope === "block" && record.syntax !== "hashtag")
    .map((record) => record.line));
  const lines = text.split("\n");
  let anchor = subject;
  for (let line = subject + 1; line < lines.length; line += 1) {
    if (!lines[line]!.trim()) continue;
    if (!metadataLines.has(line)) break;
    anchor = line;
  }
  return anchor;
}

function lineRange(text: string, line: number): { start: number; end: number } {
  let start = 0;
  for (let index = 0; index < line; index += 1) {
    const newline = text.indexOf("\n", start);
    if (newline < 0) return { start: text.length, end: text.length };
    start = newline + 1;
  }
  const newline = text.indexOf("\n", start);
  let end = newline < 0 ? text.length : newline;
  if (end > start && text[end - 1] === "\r") end -= 1;
  return { start, end };
}

type Base = Pick<ResourceProjection, "anchor" | "provider" | "propertyKey" | "options">;

function keyedProjection(
  source: ResourceProjectionDataSource,
  base: Base,
  key: string,
  resolvedFrom: ResourceProjection["resolvedFrom"],
): ResourceProjection {
  const keyed = { ...base, key, ...(resolvedFrom ? { resolvedFrom } : {}), fields: [] };
  const lookup = source.resources.resolveAuthoredReference({ kind: base.provider, key });
  if (lookup.kind === "unavailable") return { ...keyed, status: "unavailable", reason: lookup.reason };
  if (lookup.kind === "unregistered") {
    // Registration today is an explicit follow of an authored `jira::` reference.
    const written = resolvedFrom?.step === "explicit" || resolvedFrom?.step === "block-property" ||
      resolvedFrom?.step === "ancestor-property";
    return {
      ...keyed,
      status: "not-registered",
      reason: written
        ? `${key} is not registered yet. Open it where it is written as ${base.propertyKey}:: (its link, Props then o, or Tree's authored links) to register it; r in the opened Resource fetches it.`
        : `${key} is not registered yet. Write ${base.propertyKey}:: ${key} and open that link to register it; r in the opened Resource fetches it.`,
    };
  }
  const description = source.resources.describe(lookup.resourceId, false);
  const registered = { ...keyed, resourceId: description.resource.id, sourceId: description.source.id };
  if (description.source.policy.deniedCapabilities.includes("read")) {
    return { ...registered, status: "unavailable", reason: "Workspace policy denies reading this Source" };
  }
  const document = description.remoteEntity;
  if (!document) {
    return {
      ...registered,
      status: "not-fetched",
      reason: description.remoteStatus?.lastError
        ? `Nothing fetched yet; the last refresh failed: ${bounded(description.remoteStatus.lastError)}`
        : `Nothing fetched yet. Open ${key} (the link above) and press r to fetch it.`,
    };
  }
  const validator = document.sourceSnapshot.revision.revision;
  const updatedAt = "validator" in validator && validator.validator.kind === "updated-at"
    ? validator.validator.value
    : undefined;
  const failed = description.remoteStatus?.freshness === "failed";
  return {
    ...registered,
    status: failed ? "stale" : "ready",
    ...(failed
      ? { reason: `Showing the stored copy; the last refresh failed: ${bounded(description.remoteStatus?.lastError ?? "unknown error")}` }
      : {}),
    key: document.sourceSnapshot.locator,
    summary: bounded(document.title),
    fields: projectionFields(document.metadata),
    ...(updatedAt ? { updatedAt } : {}),
    fetchedAt: document.sourceSnapshot.fetchedAt,
    externalUrl: document.externalUrl,
  };
}

export function readResourceProjections(
  source: ResourceProjectionDataSource,
  request: ResourceProjectionRequest,
): ResourceProjectionReadResult {
  const context = source.blockContext(request.blockId);
  const block = context.selected;
  if (!block) throw new Error(`Block not found: ${request.blockId}`);
  const result = (projections: ResourceProjection[]): ResourceProjectionReadResult =>
    ({ blockId: block.id, revision: block.revision, projections: projections.slice(0, MAX_PROJECTIONS) });
  if (block.text.length > MAX_TEXT_UNITS) return result([]);

  const sources = source.resources.listSources();
  const self: ContextBlock = { id: block.id, text: block.text };
  const ancestors: ContextBlock[] = [...context.ancestors].reverse()
    .map((ancestor) => ({ id: ancestor.id, text: ancestor.text }));
  const directives = resourceDirectiveOccurrences(block.text)
    .filter((directive) => request.line === undefined || directive.line === request.line);
  const projections: ResourceProjection[] = [];
  const directiveKeys = new Set<string>();

  for (const directive of directives) {
    const provider = RESOURCE_DIRECTIVE_PROVIDERS.find((candidate) => candidate.propertyKey === directive.propertyKey)!;
    const base: Base = {
      anchor: { kind: "directive", line: directive.line, start: directive.start, end: directive.end },
      provider: provider.provider,
      propertyKey: provider.propertyKey,
      options: directive.options,
    };
    const resolution = resolveContextKey({
      block: self,
      line: directive.line,
      ancestors,
      matcher: contextMatcher(provider, sources),
      ...(directive.explicitKey ? { explicitKey: directive.explicitKey } : {}),
    });
    if (resolution.kind === "none") {
      projections.push({
        ...base,
        status: "no-key",
        reason: "No ticket key on this line, above it, in this block or in its ancestors. Write the key after jira::",
        fields: [],
      });
      continue;
    }
    if (resolution.kind === "ambiguous") {
      projections.push({
        ...base,
        status: "ambiguous",
        candidates: resolution.keys,
        resolvedFrom: resolution.site,
        reason: `${resolution.keys.length} tickets at the nearest level: ${resolution.keys.join(", ")}. Write the key after jira::`,
        fields: [],
      });
      continue;
    }
    directiveKeys.add(resolution.key);
    projections.push(keyedProjection(source, base, resolution.key, resolution.site));
  }

  if (request.line === undefined) {
    // A ticket page shows its ticket at the top of the body, unless a provider
    // line in the page already shows that ticket where the author placed it.
    for (const provider of RESOURCE_DIRECTIVE_PROVIDERS) {
      const matcher = contextMatcher(provider, sources);
      const line = pageAnchorLine(block.text);
      for (const key of blockPropertyKeys(block.text, matcher)) {
        if (directiveKeys.has(key)) continue;
        projections.push(keyedProjection(source, {
          anchor: { kind: "page", line, ...lineRange(block.text, line) },
          provider: provider.provider,
          propertyKey: provider.propertyKey,
          options: { unknown: [] },
        }, key, { step: "block-property", blockId: block.id, line }));
      }
    }
  } else if (directives.length === 0) {
    const provider = RESOURCE_DIRECTIVE_PROVIDERS[0]!;
    const base: Base = {
      anchor: { kind: "line", line: request.line, ...lineRange(block.text, request.line) },
      provider: provider.provider,
      propertyKey: provider.propertyKey,
      options: { unknown: [] },
    };
    const resolution = resolveContextKey({ block: self, line: request.line, ancestors, matcher: contextMatcher(provider, sources) });
    if (resolution.kind === "resolved") projections.push(keyedProjection(source, base, resolution.key, resolution.site));
    else if (resolution.kind === "ambiguous") {
      projections.push({ ...base, status: "ambiguous", candidates: resolution.keys, resolvedFrom: resolution.site,
        reason: `${resolution.keys.length} tickets at the nearest level: ${resolution.keys.join(", ")}`, fields: [] });
    } else projections.push({ ...base, status: "no-key", reason: "No ticket key on this line or in its context", fields: [] });
  }
  return result(projections.sort((left, right) => left.anchor.line - right.anchor.line));
}

export function normalizeResourceProjectionRequest(value: { blockId?: unknown; line?: unknown }): ResourceProjectionRequest {
  if (typeof value.blockId !== "string" || !value.blockId.trim()) {
    throw new Error("resources.projection.read requires blockId");
  }
  if (value.line !== undefined && (!Number.isSafeInteger(value.line) || (value.line as number) < 0)) {
    throw new Error("resources.projection.read line must be a non-negative integer");
  }
  return { blockId: value.blockId, ...(value.line !== undefined ? { line: value.line as number } : {}) };
}
