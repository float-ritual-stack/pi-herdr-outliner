import {
  createContextResolver,
  subjectLineIndex,
  type ContextBlock,
  type ContextKeyMatcher,
  type ContextResolution,
  type ContextResolutionStep,
} from "./context-resolution";
import { parsePropertyRecords } from "./properties";
import {
  providerKeyOccurrences,
  resourceDirectiveOccurrences,
  resourceDirectiveProvider,
  RESOURCE_DIRECTIVE_PROVIDERS,
  type ResourceDirectiveOptions,
  type ResourceDirectiveProvider,
} from "./resource-references";
import type { AuthoredResourceReferenceLookup } from "./resource-references";
import type { ResourceDescription, ResourceSource } from "./resources";
import type { Block } from "./types";

/**
 * `resources.projection.read`: a resource projection is a Resource's stored
 * details shown where a provider line (`jira::`) or a block's own provider
 * property names it, with the key found from context. A Jira ticket is the
 * first kind. It reads only what the catalog already stores. It never
 * registers, refreshes or contacts a provider; only an explicit refresh
 * fetches.
 */

export type ResourceProjectionStatus =
  /** A stored snapshot is shown. */
  | "ready"
  /** A stored snapshot is shown, but the last refresh failed. */
  | "stale"
  /** An extension's handler line that hasn't run: `reason` says when it will. */
  | "not-run"
  /** Registered, but nothing has been fetched yet. */
  | "not-fetched"
  /** The key is known, but no Resource exists for it yet. */
  | "not-registered"
  | "ambiguous"
  | "no-key"
  /** No Source, several Sources, or policy denies reading. */
  | "unavailable";

export interface ResourceProjectionAnchor {
  /**
   * `directive`: a provider line; `page`: the block's own property; `line`: a
   * requested line; `record`: the block is the extension's record of it.
   */
  readonly kind: "directive" | "page" | "line" | "record";
  /** The line the projection follows, as an index into the block's text. */
  readonly line: number;
  readonly start: number;
  readonly end: number;
}

export interface ResourceProjectionField {
  readonly label: string;
  readonly value: string;
}

/**
 * What an extension's handler line returned (capability `extensions.outputs`):
 * an output's markdown, or a component's data and view with its markdown
 * rendering. `markdown` is inert BlockDown: it never adds properties.
 */
export interface ExtensionProjectionOutput {
  readonly markdown: string;
  readonly ranAt: string;
  readonly title?: string;
  /** A component's data and its view in the shared primitives (src/component-primitives.ts). */
  readonly component?: { readonly data: unknown; readonly view: unknown };
  /** The block changed since this ran. */
  readonly inputsChanged?: true;
  /** The extension's version changed since this ran. */
  readonly versionChanged?: true;
}

export interface ResourceProjection {
  readonly anchor: ResourceProjectionAnchor;
  /** The provider (`jira`) or, for an extension's handler line, the extension's id. */
  readonly provider: ResourceDirectiveProvider["provider"] | (string & {});
  /**
   * Which kind of extension line this is (capability `extensions.outputs`):
   * absent for a Jira projection; `data`, `output` or `component` for a
   * handler an extension folder serves.
   */
  readonly kind?: "data" | "output" | "component";
  readonly extension?: {
    readonly id: string;
    readonly handler: string;
    readonly effects: "read" | "spend" | "write";
    /** Display options from the line (they never reach the extension). */
    readonly display: Readonly<Record<string, boolean | number | string>>;
    readonly version?: number;
  };
  readonly output?: ExtensionProjectionOutput;
  /** How readers name this kind of resource, e.g. "Jira". */
  readonly label: string;
  readonly propertyKey: string;
  readonly options: ResourceDirectiveOptions;
  /** Clients render a status they do not know generically, with its reason. */
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
  /** Snapshot metadata the provider allows, in the provider's order. */
  readonly fields: readonly ResourceProjectionField[];
  readonly updatedAt?: string;
  readonly fetchedAt?: string;
  readonly externalUrl?: string;
  /** The stored copy's age class: `stale` after the provider's stale age (15 minutes for Jira). */
  readonly freshness?: "fresh" | "stale" | "unknown" | "refreshing" | "failed";
  /** Capability `resources.projection.materialize`: a fetch for it is running now. */
  readonly fetching?: boolean;
  /** Why the service's last fetch for it failed, in words for the reader. */
  readonly fetchError?: string;
  /** The block that holds the ticket (an extension record), its comments and when it was last written or confirmed. */
  readonly record?: {
    readonly blockId: string;
    readonly pageBlockId: string;
    readonly syncedAt: string;
    readonly commentBlockIds: readonly string[];
  };
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
  /** When the block is an extension's record (or one of its comments), what it shows. */
  extensionOwner?(blockId: string): { role: "record" | "comment"; itemKey: string; parentBlockId: string; extensionId: string } | null;
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

function bounded(value: string): string {
  const single = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return single.length > MAX_FIELD_UNITS ? `${single.slice(0, MAX_FIELD_UNITS - 1)}…` : single;
}

function label(key: string): string {
  const words = key.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function projectionFields(
  provider: ResourceDirectiveProvider,
  metadata: Readonly<Record<string, string | readonly string[] | null>>,
): ResourceProjectionField[] {
  const values = new Map(Object.entries(metadata).map(([key, value]) => [key.toLowerCase(), value]));
  return provider.fields.flatMap((key) => {
    const value = values.get(key);
    const text = Array.isArray(value) ? value.join(", ") : typeof value === "string" ? value : "";
    return text.trim() ? [{ label: label(key), value: bounded(text) }] : [];
  }).slice(0, MAX_FIELDS);
}

/** Keys count in context only when a Source of this provider claims them. */
function contextMatcher(provider: ResourceDirectiveProvider, sources: readonly ResourceSource[]): ContextKeyMatcher {
  return {
    propertyKey: provider.propertyKey,
    keysIn: (text) => providerKeyOccurrences(provider, text)
      .filter((occurrence) => sources.some((source) => provider.claims(source, occurrence.key))),
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

type Base = Pick<ResourceProjection, "anchor" | "provider" | "label" | "propertyKey" | "options">;

function baseFor(provider: ResourceDirectiveProvider, anchor: ResourceProjectionAnchor, options: ResourceDirectiveOptions): Base {
  return { anchor, provider: provider.provider, label: provider.label, propertyKey: provider.propertyKey, options };
}

/** One unreadable stored copy makes its own projection unavailable, not the whole read. */
function keyedProjection(
  source: ResourceProjectionDataSource,
  provider: ResourceDirectiveProvider,
  base: Base,
  key: string,
  resolvedFrom: ResourceProjection["resolvedFrom"],
): ResourceProjection {
  try {
    return storedProjection(source, provider, base, key, resolvedFrom);
  } catch {
    return { ...base, key, ...(resolvedFrom ? { resolvedFrom } : {}), fields: [],
      status: "unavailable", reason: "Stored copy unreadable" };
  }
}

function storedProjection(
  source: ResourceProjectionDataSource,
  provider: ResourceDirectiveProvider,
  base: Base,
  key: string,
  resolvedFrom: ResourceProjection["resolvedFrom"],
): ResourceProjection {
  const keyed = { ...base, key, ...(resolvedFrom ? { resolvedFrom } : {}), fields: [] };
  const lookup = source.resources.resolveAuthoredReference({ kind: provider.provider, key });
  if (lookup.kind === "unavailable") return { ...keyed, status: "unavailable", reason: lookup.reason };
  if (lookup.kind === "unregistered") {
    // Saving the line (or opening the note) registers and fetches it in the background.
    return {
      ...keyed,
      status: "not-registered",
      reason: `${key} isn't fetched yet; saving the ${base.propertyKey}:: line or opening the note fetches it, and r fetches it now.`,
    };
  }
  const description = source.resources.describe(lookup.resourceId, false);
  const registered = { ...keyed, resourceId: description.resource.id, sourceId: description.source.id };
  if (description.source.policy.deniedCapabilities.includes("read")) {
    return { ...registered, status: "unavailable", reason: "Workspace policy denies reading this Source" };
  }
  const document = description.remoteEntity;
  const freshness = description.remoteStatus?.freshness;
  if (!document) {
    return {
      ...registered,
      ...(freshness ? { freshness } : {}),
      status: "not-fetched",
      reason: description.remoteStatus?.lastError
        ? `Nothing fetched yet; the last fetch failed: ${bounded(description.remoteStatus.lastError)}`
        : `Nothing fetched yet; r fetches it now.`,
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
    fields: projectionFields(provider, document.metadata),
    ...(updatedAt ? { updatedAt } : {}),
    fetchedAt: description.remoteStatus?.checkedAt ?? document.sourceSnapshot.fetchedAt,
    externalUrl: document.externalUrl,
    ...(freshness ? { freshness } : {}),
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
  if (request.line !== undefined && request.line >= block.text.split("\n").length) {
    throw new Error(`resources.projection.read line ${request.line} is outside the block`);
  }

  const sources = source.resources.listSources();
  // An extension's record block (or a comment in it) shows the ticket it holds.
  const owner = source.extensionOwner?.(block.id);
  const record = owner?.role === "comment" ? source.extensionOwner?.(owner.parentBlockId) : owner;
  const recordProvider = record ? resourceDirectiveProvider(record.extensionId) : undefined;
  if (record && recordProvider) {
    const base = baseFor(recordProvider, { kind: "record", line: 0, ...lineRange(block.text, 0) }, { unknown: [] });
    return result([keyedProjection(source, recordProvider, base, record.itemKey, { step: "explicit", blockId: block.id, line: 0 })]);
  }
  const self: ContextBlock = { id: block.id, text: block.text };
  const ancestors: ContextBlock[] = [...context.ancestors].reverse()
    .map((ancestor) => ({ id: ancestor.id, text: ancestor.text }));
  // One resolver per provider parses this block once, however many lines it resolves.
  const resolvers = new Map(RESOURCE_DIRECTIVE_PROVIDERS.map((provider) =>
    [provider.propertyKey, createContextResolver({ block: self, ancestors, matcher: contextMatcher(provider, sources) })] as const));
  // Only the first MAX_PROJECTIONS provider lines are resolved; the rest would be dropped anyway.
  const directives = resourceDirectiveOccurrences(block.text)
    .filter((directive) => request.line === undefined || directive.line === request.line)
    .slice(0, MAX_PROJECTIONS);
  const projections: ResourceProjection[] = [];
  const directiveKeys = new Set<string>();
  const contextual = (provider: ResourceDirectiveProvider, base: Base, resolution: ContextResolution): ResourceProjection => {
    if (resolution.kind === "resolved") {
      directiveKeys.add(resolution.key);
      return keyedProjection(source, provider, base, resolution.key, resolution.site);
    }
    if (resolution.kind === "ambiguous") {
      return { ...base, status: "ambiguous", candidates: resolution.keys, resolvedFrom: resolution.site, fields: [],
        reason: `${resolution.keys.length} ${provider.label} keys at the nearest level: ${resolution.keys.join(", ")}. Write the key after ${provider.propertyKey}::` };
    }
    return { ...base, status: "no-key", fields: [],
      reason: `No ${provider.label} key on this line, above it, in this block or in its ancestors. Write the key after ${provider.propertyKey}::` };
  };

  for (const directive of directives) {
    if (projections.length >= MAX_PROJECTIONS) break;
    const provider = resourceDirectiveProvider(directive.propertyKey)!;
    const base = baseFor(provider, { kind: "directive", line: directive.line, start: directive.start, end: directive.end }, directive.options);
    projections.push(contextual(provider, base, resolvers.get(provider.propertyKey)!.resolve(directive.line, directive.explicitKey)));
  }

  if (request.line === undefined) {
    // A page shows its resource at the top of the body, unless a provider line
    // in the page already shows that resource where the author placed it.
    const line = pageAnchorLine(block.text);
    for (const provider of RESOURCE_DIRECTIVE_PROVIDERS) {
      for (const key of resolvers.get(provider.propertyKey)!.ownPropertyKeys()) {
        if (directiveKeys.has(key) || projections.length >= MAX_PROJECTIONS) continue;
        projections.push(keyedProjection(source, provider,
          baseFor(provider, { kind: "page", line, ...lineRange(block.text, line) }, { unknown: [] }),
          key, { step: "block-property", blockId: block.id, line }));
      }
    }
  } else if (directives.length === 0) {
    const provider = RESOURCE_DIRECTIVE_PROVIDERS[0]!;
    const base = baseFor(provider, { kind: "line", line: request.line, ...lineRange(block.text, request.line) }, { unknown: [] });
    projections.push(contextual(provider, base, resolvers.get(provider.propertyKey)!.resolve(request.line)));
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
