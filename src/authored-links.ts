import { createHash } from "node:crypto";
import { isFragmentId } from "./fragments";
import {
  outlinerReferenceOccurrences,
  protectedCodeRanges,
  rangesOverlap,
  type OutlinerReferenceOccurrence,
} from "./reference-occurrences";
import {
  authoredResourceReferenceKey,
  authoredResourceReferenceOccurrences,
  type AuthoredResourceReference,
  type AuthoredResourceReferenceOccurrence,
  type AuthoredResourceReferenceLookup,
} from "./resource-references";
import { blockDisplayTitle } from "./references";
import {
  normalizeResourceId,
  resourceAddressLabel,
  type Resource,
  type ResourceProvider,
  type ResourceSource,
} from "./resources";
import type {
  Block,
  BlockTarget,
  PageAddressResolution,
  ResourceTarget,
  WorkIdAllocatorStatus,
} from "./types";

export const AUTHORED_LINKS_MAX_TEXT_UNITS = 65_536;
export const AUTHORED_LINKS_MAX_CANDIDATES = 256;
export const AUTHORED_LINKS_MAX_ENTRIES_PER_GROUP = 50;
export const AUTHORED_LINKS_MAX_DIAGNOSTICS_PER_GROUP = 3;
export const AUTHORED_LINKS_MAX_DIAGNOSTIC_UNITS = 160;
export const AUTHORED_LINKS_MAX_PRESENTATION_UNITS = 240;

export type AuthoredLinkGroupName = "outlinks" | "resources";

export interface AuthoredLinkSpan {
  readonly start: number;
  readonly end: number;
}

export interface AuthoredLinkDiagnostic {
  readonly span: AuthoredLinkSpan;
  readonly message: string;
}

export type AuthoredLinkCompleteness =
  | { readonly kind: "complete" }
  | {
      readonly kind: "limited";
      readonly reason: "candidate-limit" | "entry-limit";
      readonly shown: number;
    };

interface AuthoredLinkEntryBase {
  readonly key: string;
  readonly label: string;
  readonly firstSpan: AuthoredLinkSpan;
  readonly occurrenceCount: number;
}

export type AuthoredOutlinkResolution =
  | {
      readonly kind: "ready";
      readonly target: BlockTarget;
      readonly title: string;
    }
  | {
      readonly kind: "deleted";
      readonly blockId: string;
      readonly fragmentId?: string;
      readonly title: string;
      readonly reason: string;
    }
  | {
      readonly kind: "unregistered-page";
      readonly address: string;
      readonly reason: string;
    }
  | {
      readonly kind: "missing";
      readonly reason: string;
    };

export interface AuthoredOutlink extends AuthoredLinkEntryBase {
  readonly kind: "outlink";
  readonly referenceKind: "block" | "page" | "work-id";
  readonly resolution: AuthoredOutlinkResolution;
}

export type AuthoredResourceResolution =
  | {
      readonly kind: "ready";
      readonly target: ResourceTarget;
      readonly sourceName: string;
      readonly provider: ResourceProvider;
      readonly addressLabel: string;
    }
  | {
      readonly kind: "unregistered";
      readonly reference: AuthoredResourceReference;
      readonly reason: string;
    }
  | {
      readonly kind: "missing";
      readonly reason: string;
    };

export interface AuthoredResourceLink extends AuthoredLinkEntryBase {
  readonly kind: "resource";
  readonly resourceId?: string;
  readonly resolution: AuthoredResourceResolution;
}

export interface AuthoredLinkGroup<Entry extends AuthoredOutlink | AuthoredResourceLink> {
  readonly entries: readonly Entry[];
  readonly completeness: AuthoredLinkCompleteness;
  readonly invalidCount: number;
  readonly diagnostics: readonly AuthoredLinkDiagnostic[];
}

export type AuthoredLinksSnapshot =
  | {
      readonly kind: "ready";
      readonly ownerId: string;
      readonly ownerTextDigest: string;
      readonly outlinks: AuthoredLinkGroup<AuthoredOutlink>;
      readonly resources: AuthoredLinkGroup<AuthoredResourceLink>;
    }
  | {
      readonly kind: "owner-unavailable";
      readonly ownerId: string;
      readonly reason: "missing" | "deleted";
    }
  | {
      readonly kind: "source-too-large";
      readonly ownerId: string;
      readonly maximumUtf16Units: number;
    };

export interface AuthoredLinksDataSource {
  get(blockId: string): Block | null;
  resolvePageAddress(address: string): PageAddressResolution;
  workIdAllocatorStatus(): WorkIdAllocatorStatus;
  readonly resources: {
    get(resourceId: string): Resource | null;
    getSource(sourceId: string): ResourceSource | null;
    resolveAuthoredReference(reference: AuthoredResourceReference): AuthoredResourceReferenceLookup;
  };
}

type ResourceReferenceCandidate =
  | {
      readonly kind: "resource";
      readonly resourceId: string;
      readonly label: string | null;
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly kind: "invalid-resource";
      readonly start: number;
      readonly end: number;
      readonly message: string;
    }
  | AuthoredResourceReferenceOccurrence;

type AuthoredCandidate = OutlinerReferenceOccurrence | ResourceReferenceCandidate;

const BLOCK_ID_PATTERN = /^[A-Za-z0-9_-]{8,}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const RESOURCE_DESTINATION_PREFIX = "pi-outliner://resource/";
const INLINE_MARKDOWN_LINK_PATTERN = /(?<!!)\[([^\[\]\r\n]*)\]\(([^)\r\n]*)\)/g;
const RESOURCE_PROVIDERS: Record<ResourceProvider, true> = {
  filesystem: true,
  web: true,
  github: true,
  jira: true,
  linear: true,
  application: true,
  computed: true,
};

function isResourceProvider(value: string): value is ResourceProvider {
  return value in RESOURCE_PROVIDERS;
}

export function normalizeAuthoredLinksOwnerId(value: unknown): string {
  if (typeof value !== "string") throw new Error("Authored-links owner block ID must be a string");
  const ownerId = value.trim();
  if (!BLOCK_ID_PATTERN.test(ownerId)) {
    throw new Error("Authored-links owner block ID must use the canonical block ID grammar");
  }
  return ownerId;
}

export function authoredTextDigest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function clip(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return `${value.slice(0, maximum - 1)}…`;
}

function presentation(value: string): string {
  return clip(value.replace(/[\r\n]+/g, " ").replace(/\s{2,}/g, " ").trim(), AUTHORED_LINKS_MAX_PRESENTATION_UNITS);
}

function diagnostic(message: string): string {
  return clip(message, AUTHORED_LINKS_MAX_DIAGNOSTIC_UNITS);
}

function resourceReferenceCandidates(text: string): ResourceReferenceCandidate[] {
  const protectedRanges = protectedCodeRanges(text);
  const candidates: ResourceReferenceCandidate[] = [];
  for (const match of text.matchAll(INLINE_MARKDOWN_LINK_PATTERN)) {
    const range = { start: match.index, end: match.index + match[0].length };
    if (protectedRanges.some((protectedRange) => rangesOverlap(range, protectedRange))) continue;
    const destination = match[2]!;
    const looksLikeResource = destination.toLowerCase().includes(RESOURCE_DESTINATION_PREFIX);
    if (!looksLikeResource) continue;
    if (!destination.startsWith(RESOURCE_DESTINATION_PREFIX)) {
      candidates.push({
        kind: "invalid-resource",
        ...range,
        message: diagnostic("Invalid Resource link: the destination must start with pi-outliner://resource/"),
      });
      continue;
    }
    const rawId = destination.slice(RESOURCE_DESTINATION_PREFIX.length);
    let resourceId: string;
    try {
      resourceId = normalizeResourceId(rawId, "Authored Resource ID");
    } catch {
      candidates.push({
        kind: "invalid-resource",
        ...range,
        message: diagnostic("Invalid Resource link: the destination must end with one canonical UUID and no title, query, fragment, or revision"),
      });
      continue;
    }
    candidates.push({
      kind: "resource",
      resourceId,
      label: match[1]!.trim() || null,
      ...range,
    });
  }
  candidates.push(...authoredResourceReferenceOccurrences(text));
  return candidates;
}

function targetKey(target: BlockTarget | ResourceTarget): string {
  return target.kind === "block"
    ? JSON.stringify(["block", target.blockId, target.fragmentId ?? null])
    : JSON.stringify(["resource", target.resourceId]);
}

function addressKey(normalizedAddress: string): string {
  return JSON.stringify(["address", normalizedAddress]);
}

function withIncrementedCount<Entry extends AuthoredOutlink | AuthoredResourceLink>(entry: Entry): Entry {
  return { ...entry, occurrenceCount: entry.occurrenceCount + 1 };
}

function resolveOutlink(
  source: AuthoredLinksDataSource,
  candidate: Exclude<AuthoredCandidate, ResourceReferenceCandidate>,
): AuthoredOutlink {
  if (candidate.kind === "block") {
    const target: BlockTarget = {
      kind: "block",
      blockId: candidate.blockId,
      ...(candidate.fragmentId ? { fragmentId: candidate.fragmentId } : {}),
    };
    const block = source.get(candidate.blockId);
    if (!block) {
      return {
        kind: "outlink",
        key: targetKey(target),
        referenceKind: "block",
        label: presentation(candidate.label ?? candidate.blockId),
        firstSpan: { start: candidate.start, end: candidate.end },
        occurrenceCount: 1,
        resolution: { kind: "missing", reason: `Block not found: ${candidate.blockId}` },
      };
    }
    const title = presentation(blockDisplayTitle(block));
    if (block.effectiveDeletedRootId) {
      return {
        kind: "outlink",
        key: targetKey(target),
        referenceKind: "block",
        label: presentation(candidate.label ?? title),
        firstSpan: { start: candidate.start, end: candidate.end },
        occurrenceCount: 1,
        resolution: {
          kind: "deleted",
          blockId: block.id,
          ...(candidate.fragmentId ? { fragmentId: candidate.fragmentId } : {}),
          title,
          reason: "Block is in Trash",
        },
      };
    }
    return {
      kind: "outlink",
      key: targetKey(target),
      referenceKind: "block",
      label: presentation(candidate.label ?? title),
      firstSpan: { start: candidate.start, end: candidate.end },
      occurrenceCount: 1,
      resolution: { kind: "ready", target, title },
    };
  }

  const resolution = source.resolvePageAddress(candidate.address);
  const referenceKind = candidate.kind;
  const authoredLabel = candidate.kind === "page" ? candidate.label : undefined;
  if (resolution.block) {
    const target: BlockTarget = { kind: "block", blockId: resolution.block.id };
    const title = presentation(blockDisplayTitle(resolution.block));
    if (resolution.status === "deleted" || resolution.block.effectiveDeletedRootId) {
      return {
        kind: "outlink",
        key: targetKey(target),
        referenceKind,
        label: presentation(authoredLabel ?? candidate.address),
        firstSpan: { start: candidate.start, end: candidate.end },
        occurrenceCount: 1,
        resolution: {
          kind: "deleted",
          blockId: resolution.block.id,
          title,
          reason: "Block is in Trash",
        },
      };
    }
    return {
      kind: "outlink",
      key: targetKey(target),
      referenceKind,
      label: presentation(authoredLabel ?? candidate.address),
      firstSpan: { start: candidate.start, end: candidate.end },
      occurrenceCount: 1,
      resolution: { kind: "ready", target, title },
    };
  }

  return {
    kind: "outlink",
    key: addressKey(resolution.normalizedAddress),
    referenceKind,
    label: presentation(authoredLabel ?? candidate.address),
    firstSpan: { start: candidate.start, end: candidate.end },
    occurrenceCount: 1,
    resolution: referenceKind === "page"
      ? {
          kind: "unregistered-page",
          address: candidate.address,
          reason: `Page is not registered: ${candidate.address}`,
        }
      : {
          kind: "missing",
          reason: `Work ID is not registered: ${candidate.address}`,
        },
  };
}

function resolveResource(
  source: AuthoredLinksDataSource,
  candidate: Exclude<
    ResourceReferenceCandidate,
    { kind: "invalid-resource" | "invalid-authored-resource" }
  >,
): AuthoredResourceLink {
  let resourceId: string;
  let authoredLabel: string;
  if (candidate.kind === "resource") {
    resourceId = candidate.resourceId;
    authoredLabel = candidate.label ?? candidate.resourceId;
  } else {
    authoredLabel = candidate.label;
    let lookup: AuthoredResourceReferenceLookup;
    try {
      lookup = source.resources.resolveAuthoredReference(candidate.reference);
    } catch (error) {
      return {
        kind: "resource",
        key: authoredResourceReferenceKey(candidate.reference),
        label: presentation(candidate.label),
        firstSpan: { start: candidate.start, end: candidate.end },
        occurrenceCount: 1,
        resolution: {
          kind: "missing",
          reason: presentation(error instanceof Error ? error.message : String(error)),
        },
      };
    }
    if (lookup.kind === "unregistered") {
      return {
        kind: "resource",
        key: authoredResourceReferenceKey(candidate.reference),
        label: presentation(candidate.label),
        firstSpan: { start: candidate.start, end: candidate.end },
        occurrenceCount: 1,
        resolution: {
          kind: "unregistered",
          reference: candidate.reference,
          reason: presentation(lookup.reason),
        },
      };
    }
    if (lookup.kind === "unavailable") {
      return {
        kind: "resource",
        key: authoredResourceReferenceKey(candidate.reference),
        label: presentation(candidate.label),
        firstSpan: { start: candidate.start, end: candidate.end },
        occurrenceCount: 1,
        resolution: { kind: "missing", reason: presentation(lookup.reason) },
      };
    }
    resourceId = lookup.resourceId;
  }
  const key = targetKey({ kind: "resource", resourceId });
  const resource = source.resources.get(resourceId);
  if (!resource) {
    return {
      kind: "resource",
      key,
      resourceId,
      label: presentation(authoredLabel),
      firstSpan: { start: candidate.start, end: candidate.end },
      occurrenceCount: 1,
      resolution: { kind: "missing", reason: `Resource is not cataloged: ${resourceId}` },
    };
  }
  const resourceSource = source.resources.getSource(resource.sourceId);
  if (!resourceSource) {
    return {
      kind: "resource",
      key,
      resourceId,
      label: presentation(authoredLabel || resourceAddressLabel(resource.address)),
      firstSpan: { start: candidate.start, end: candidate.end },
      occurrenceCount: 1,
      resolution: { kind: "missing", reason: `Resource Source is missing: ${resource.sourceId}` },
    };
  }
  const addressLabel = presentation(resourceAddressLabel(resource.address));
  return {
    kind: "resource",
    key,
    resourceId,
    label: presentation(authoredLabel || addressLabel),
    firstSpan: { start: candidate.start, end: candidate.end },
    occurrenceCount: 1,
    resolution: {
      kind: "ready",
      target: { kind: "resource", resourceId: resource.id },
      sourceName: presentation(resourceSource.name),
      provider: resource.provider,
      addressLabel,
    },
  };
}

function completeness(
  shown: number,
  candidateLimited: boolean,
  entryLimited: boolean,
): AuthoredLinkCompleteness {
  if (candidateLimited) return { kind: "limited", reason: "candidate-limit", shown };
  if (entryLimited) return { kind: "limited", reason: "entry-limit", shown };
  return { kind: "complete" };
}

export function readAuthoredLinks(
  source: AuthoredLinksDataSource,
  ownerBlockId: unknown,
): AuthoredLinksSnapshot {
  const ownerId = normalizeAuthoredLinksOwnerId(ownerBlockId);
  const owner = source.get(ownerId);
  if (!owner) return { kind: "owner-unavailable", ownerId, reason: "missing" };
  if (owner.effectiveDeletedRootId) {
    return { kind: "owner-unavailable", ownerId, reason: "deleted" };
  }
  if (owner.text.length > AUTHORED_LINKS_MAX_TEXT_UNITS) {
    return {
      kind: "source-too-large",
      ownerId,
      maximumUtf16Units: AUTHORED_LINKS_MAX_TEXT_UNITS,
    };
  }

  const workIdPrefix = source.workIdAllocatorStatus().prefix;
  const candidates: AuthoredCandidate[] = [
    ...outlinerReferenceOccurrences(owner.text, workIdPrefix),
    ...resourceReferenceCandidates(owner.text),
  ].sort((left, right) => left.start - right.start || left.end - right.end);
  const candidateLimited = candidates.length > AUTHORED_LINKS_MAX_CANDIDATES;
  const scanned = candidates.slice(0, AUTHORED_LINKS_MAX_CANDIDATES);
  const outlinks: AuthoredOutlink[] = [];
  const resources: AuthoredResourceLink[] = [];
  const outlinkIndex = new Map<string, number>();
  const resourceIndex = new Map<string, number>();
  const resourceDiagnostics: AuthoredLinkDiagnostic[] = [];
  let resourceInvalidCount = 0;
  let outlinkEntryLimited = false;
  let resourceEntryLimited = false;

  for (const candidate of scanned) {
    if (candidate.kind === "invalid-resource" || candidate.kind === "invalid-authored-resource") {
      resourceInvalidCount += 1;
      if (resourceDiagnostics.length < AUTHORED_LINKS_MAX_DIAGNOSTICS_PER_GROUP) {
        resourceDiagnostics.push({
          span: { start: candidate.start, end: candidate.end },
          message: candidate.message,
        });
      }
      continue;
    }
    if (candidate.kind === "resource" || candidate.kind === "authored-resource") {
      const resolved = resolveResource(source, candidate);
      const existing = resourceIndex.get(resolved.key);
      if (existing !== undefined) {
        resources[existing] = withIncrementedCount(resources[existing]!);
      } else if (resources.length < AUTHORED_LINKS_MAX_ENTRIES_PER_GROUP) {
        resourceIndex.set(resolved.key, resources.length);
        resources.push(resolved);
      } else {
        resourceEntryLimited = true;
      }
      continue;
    }

    const resolved = resolveOutlink(source, candidate);
    const existing = outlinkIndex.get(resolved.key);
    if (existing !== undefined) {
      outlinks[existing] = withIncrementedCount(outlinks[existing]!);
    } else if (outlinks.length < AUTHORED_LINKS_MAX_ENTRIES_PER_GROUP) {
      outlinkIndex.set(resolved.key, outlinks.length);
      outlinks.push(resolved);
    } else {
      outlinkEntryLimited = true;
    }
  }

  return {
    kind: "ready",
    ownerId,
    ownerTextDigest: authoredTextDigest(owner.text),
    outlinks: {
      entries: outlinks,
      completeness: completeness(outlinks.length, candidateLimited, outlinkEntryLimited),
      invalidCount: 0,
      diagnostics: [],
    },
    resources: {
      entries: resources,
      completeness: completeness(resources.length, candidateLimited, resourceEntryLimited),
      invalidCount: resourceInvalidCount,
      diagnostics: resourceDiagnostics,
    },
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum) {
    throw new Error(`${label} must be a string no longer than ${maximum} UTF-16 units`);
  }
  return value;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return Number(value);
}

function decodeSpan(value: unknown, label: string): AuthoredLinkSpan {
  const input = record(value, label);
  const start = integer(input.start, `${label} start`, 0, AUTHORED_LINKS_MAX_TEXT_UNITS);
  const end = integer(input.end, `${label} end`, start, AUTHORED_LINKS_MAX_TEXT_UNITS);
  return { start, end };
}

function decodeBlockTarget(value: unknown, label: string): BlockTarget {
  const input = record(value, label);
  if (input.kind !== "block") throw new Error(`${label} must be a block target`);
  const blockId = normalizeAuthoredLinksOwnerId(input.blockId);
  const fragmentId = input.fragmentId === undefined
    ? undefined
    : string(input.fragmentId, `${label} fragment ID`, 64);
  if (fragmentId !== undefined && !isFragmentId(fragmentId)) {
    throw new Error(`${label} fragment ID is invalid`);
  }
  return { kind: "block", blockId, ...(fragmentId ? { fragmentId } : {}) };
}

function decodeResourceTarget(value: unknown, label: string): ResourceTarget {
  const input = record(value, label);
  if (input.kind !== "resource") throw new Error(`${label} must be a Resource target`);
  if (input.revision !== undefined) throw new Error(`${label} must not contain a Resource revision`);
  return { kind: "resource", resourceId: normalizeResourceId(input.resourceId) };
}

function decodeAuthoredResourceReference(
  value: unknown,
  label: string,
): AuthoredResourceReference {
  const input = record(value, label);
  if (input.kind === "filesystem") {
    return {
      kind: "filesystem",
      path: string(input.path, `${label} path`, 4_096),
    };
  }
  if (input.kind === "web") {
    return {
      kind: "web",
      url: string(input.url, `${label} URL`, 4_096),
    };
  }
  if (input.kind === "jira") {
    return {
      kind: "jira",
      key: string(input.key, `${label} key`, 255),
    };
  }
  if (input.kind === "application") {
    return {
      kind: "application",
      uri: string(input.uri, `${label} URI`, 4_096),
    };
  }
  throw new Error(`${label} kind is invalid`);
}

function decodeEntryBase(value: Record<string, unknown>, label: string): AuthoredLinkEntryBase {
  return {
    key: string(value.key, `${label} key`, 1_024),
    label: string(value.label, `${label} label`, AUTHORED_LINKS_MAX_PRESENTATION_UNITS),
    firstSpan: decodeSpan(value.firstSpan, `${label} first span`),
    occurrenceCount: integer(value.occurrenceCount, `${label} occurrence count`, 1, AUTHORED_LINKS_MAX_CANDIDATES),
  };
}

function decodeOutlink(value: unknown, index: number): AuthoredOutlink {
  const label = `Authored Outlink ${index + 1}`;
  const input = record(value, label);
  if (input.kind !== "outlink") throw new Error(`${label} kind must be outlink`);
  if (input.referenceKind !== "block" && input.referenceKind !== "page" && input.referenceKind !== "work-id") {
    throw new Error(`${label} reference kind is invalid`);
  }
  const resolutionInput = record(input.resolution, `${label} resolution`);
  let resolution: AuthoredOutlinkResolution;
  if (resolutionInput.kind === "ready") {
    resolution = {
      kind: "ready",
      target: decodeBlockTarget(resolutionInput.target, `${label} target`),
      title: string(resolutionInput.title, `${label} title`, AUTHORED_LINKS_MAX_PRESENTATION_UNITS),
    };
  } else if (resolutionInput.kind === "deleted") {
    const fragmentId = resolutionInput.fragmentId === undefined
      ? undefined
      : string(resolutionInput.fragmentId, `${label} fragment ID`, 64);
    if (fragmentId !== undefined && !isFragmentId(fragmentId)) {
      throw new Error(`${label} fragment ID is invalid`);
    }
    resolution = {
      kind: "deleted",
      blockId: normalizeAuthoredLinksOwnerId(resolutionInput.blockId),
      ...(fragmentId ? { fragmentId } : {}),
      title: string(resolutionInput.title, `${label} title`, AUTHORED_LINKS_MAX_PRESENTATION_UNITS),
      reason: string(resolutionInput.reason, `${label} reason`, AUTHORED_LINKS_MAX_PRESENTATION_UNITS),
    };
  } else if (resolutionInput.kind === "unregistered-page") {
    if (input.referenceKind !== "page") {
      throw new Error(`${label} unregistered page must use the page reference kind`);
    }
    resolution = {
      kind: "unregistered-page",
      address: string(
        resolutionInput.address,
        `${label} page address`,
        AUTHORED_LINKS_MAX_PRESENTATION_UNITS,
      ),
      reason: string(
        resolutionInput.reason,
        `${label} reason`,
        AUTHORED_LINKS_MAX_PRESENTATION_UNITS,
      ),
    };
  } else if (resolutionInput.kind === "missing") {
    resolution = {
      kind: "missing",
      reason: string(resolutionInput.reason, `${label} reason`, AUTHORED_LINKS_MAX_PRESENTATION_UNITS),
    };
  } else {
    throw new Error(`${label} resolution kind is invalid`);
  }
  return {
    ...decodeEntryBase(input, label),
    kind: "outlink",
    referenceKind: input.referenceKind,
    resolution,
  };
}

function decodeResource(value: unknown, index: number): AuthoredResourceLink {
  const label = `Authored Resource link ${index + 1}`;
  const input = record(value, label);
  if (input.kind !== "resource") throw new Error(`${label} kind must be resource`);
  const resourceId = input.resourceId === undefined
    ? undefined
    : normalizeResourceId(input.resourceId);
  const resolutionInput = record(input.resolution, `${label} resolution`);
  let resolution: AuthoredResourceResolution;
  if (resolutionInput.kind === "ready") {
    if (!resourceId) throw new Error(`${label} ready resolution requires a Resource ID`);
    const target = decodeResourceTarget(resolutionInput.target, `${label} target`);
    if (target.resourceId !== resourceId) throw new Error(`${label} target does not match its Resource ID`);
    const provider = string(resolutionInput.provider, `${label} provider`, 32);
    if (!isResourceProvider(provider)) throw new Error(`${label} provider is invalid`);
    resolution = {
      kind: "ready",
      target,
      sourceName: string(resolutionInput.sourceName, `${label} Source name`, AUTHORED_LINKS_MAX_PRESENTATION_UNITS),
      provider,
      addressLabel: string(resolutionInput.addressLabel, `${label} address label`, AUTHORED_LINKS_MAX_PRESENTATION_UNITS),
    };
  } else if (resolutionInput.kind === "unregistered") {
    if (resourceId) throw new Error(`${label} unregistered resolution must not contain a Resource ID`);
    resolution = {
      kind: "unregistered",
      reference: decodeAuthoredResourceReference(
        resolutionInput.reference,
        `${label} authored reference`,
      ),
      reason: string(resolutionInput.reason, `${label} reason`, AUTHORED_LINKS_MAX_PRESENTATION_UNITS),
    };
  } else if (resolutionInput.kind === "missing") {
    resolution = {
      kind: "missing",
      reason: string(resolutionInput.reason, `${label} reason`, AUTHORED_LINKS_MAX_PRESENTATION_UNITS),
    };
  } else {
    throw new Error(`${label} resolution kind is invalid`);
  }
  return {
    ...decodeEntryBase(input, label),
    kind: "resource",
    ...(resourceId ? { resourceId } : {}),
    resolution,
  };
}

function decodeCompleteness(value: unknown, shown: number, label: string): AuthoredLinkCompleteness {
  const input = record(value, `${label} completeness`);
  if (input.kind === "complete") return { kind: "complete" };
  if (input.kind !== "limited" || (input.reason !== "candidate-limit" && input.reason !== "entry-limit")) {
    throw new Error(`${label} completeness is invalid`);
  }
  const decodedShown = integer(input.shown, `${label} shown count`, 0, AUTHORED_LINKS_MAX_ENTRIES_PER_GROUP);
  if (decodedShown !== shown) throw new Error(`${label} shown count does not match its entries`);
  return { kind: "limited", reason: input.reason, shown: decodedShown };
}

function decodeDiagnostics(value: unknown, invalidCount: number, label: string): AuthoredLinkDiagnostic[] {
  if (!Array.isArray(value) || value.length > AUTHORED_LINKS_MAX_DIAGNOSTICS_PER_GROUP) {
    throw new Error(`${label} diagnostics exceed the protocol bound`);
  }
  if (value.length > invalidCount) throw new Error(`${label} diagnostics exceed the invalid count`);
  return value.map((item, index) => {
    const input = record(item, `${label} diagnostic ${index + 1}`);
    return {
      span: decodeSpan(input.span, `${label} diagnostic ${index + 1} span`),
      message: string(
        input.message,
        `${label} diagnostic ${index + 1} message`,
        AUTHORED_LINKS_MAX_DIAGNOSTIC_UNITS,
      ),
    };
  });
}

function decodeGroup<Entry extends AuthoredOutlink | AuthoredResourceLink>(
  value: unknown,
  label: string,
  decodeEntry: (entry: unknown, index: number) => Entry,
): AuthoredLinkGroup<Entry> {
  const input = record(value, label);
  if (!Array.isArray(input.entries) || input.entries.length > AUTHORED_LINKS_MAX_ENTRIES_PER_GROUP) {
    throw new Error(`${label} entries exceed the protocol bound`);
  }
  const entries = input.entries.map(decodeEntry);
  const invalidCount = integer(input.invalidCount, `${label} invalid count`, 0, AUTHORED_LINKS_MAX_CANDIDATES);
  return {
    entries,
    completeness: decodeCompleteness(input.completeness, entries.length, label),
    invalidCount,
    diagnostics: decodeDiagnostics(input.diagnostics, invalidCount, label),
  };
}

export function decodeAuthoredLinksSnapshot(value: unknown): AuthoredLinksSnapshot {
  const input = record(value, "Authored-links response");
  const ownerId = normalizeAuthoredLinksOwnerId(input.ownerId);
  if (input.kind === "owner-unavailable") {
    if (input.reason !== "missing" && input.reason !== "deleted") {
      throw new Error("Authored-links owner-unavailable reason is invalid");
    }
    return { kind: "owner-unavailable", ownerId, reason: input.reason };
  }
  if (input.kind === "source-too-large") {
    const maximumUtf16Units = integer(
      input.maximumUtf16Units,
      "Authored-links maximum text length",
      AUTHORED_LINKS_MAX_TEXT_UNITS,
      AUTHORED_LINKS_MAX_TEXT_UNITS,
    );
    return { kind: "source-too-large", ownerId, maximumUtf16Units };
  }
  if (input.kind !== "ready") throw new Error("Authored-links response kind is invalid");
  const ownerTextDigest = string(input.ownerTextDigest, "Authored-links owner text digest", 64);
  if (!DIGEST_PATTERN.test(ownerTextDigest)) throw new Error("Authored-links owner text digest is invalid");
  return {
    kind: "ready",
    ownerId,
    ownerTextDigest,
    outlinks: decodeGroup(input.outlinks, "Authored Outlinks", decodeOutlink),
    resources: decodeGroup(input.resources, "Authored Resources", decodeResource),
  };
}
