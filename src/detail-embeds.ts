import type { RequestInput } from "./client";
import { MAX_BLOCK_QUERY_LIMIT } from "./block-query";
import { resolveFragmentSlice, stripFragmentAnchors } from "./fragments";
import { propertyReferenceOccurrences } from "./reference-occurrences";
import { blockDisplayTitle } from "./references";
import {
  isRelationViewDefinition,
  parseRelationViewConfig,
} from "./relation-views";
import type {
  Block,
  BlockCollectionCompleteness,
  VisibleBlock,
  VisibleBlockCollection,
  WorkspaceSnapshot,
} from "./types";
import {
  isVirtualBranchDefinition,
  parseVirtualBranchConfig,
} from "./virtual-branches";

const DETAIL_EMBED_PATTERN =
  /!\(\(([A-Za-z0-9_-]{8,})(?:\^([A-Za-z0-9][A-Za-z0-9_-]{0,63}))?\)\)/g;
const MAX_DETAIL_EMBEDS = 16;
const MAX_ERROR_LENGTH = 240;

export interface DetailEmbedRequester {
  request<T>(input: RequestInput, timeoutMs?: number): Promise<T>;
}

export type DetailEmbedStatus =
  | "ready"
  | "empty"
  | "truncated"
  | "invalid"
  | "missing"
  | "deleted"
  | "fragment-missing"
  | "fragment-duplicate"
  | "failed"
  | "limit";

export interface DetailEmbedState {
  blockId: string;
  fragmentId?: string;
  status: DetailEmbedStatus;
  count: number;
  completeness?: BlockCollectionCompleteness;
}

export interface DetailReadProjection {
  text: string;
  embeds: DetailEmbedState[];
}

interface ProjectedEmbed {
  text: string;
  state: DetailEmbedState;
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, MAX_ERROR_LENGTH);
}

function linkedHeading(blockId: string, suffix: string): string {
  return `Embedded view: ((${blockId})) · ${suffix}`;
}

function embedReference(blockId: string, fragmentId?: string): string {
  return `${blockId}${fragmentId ? `^${fragmentId}` : ""}`;
}

function explicitFallback(
  blockId: string,
  status: DetailEmbedStatus,
  detail: string,
  fragmentId?: string,
): ProjectedEmbed {
  const reference = embedReference(blockId, fragmentId);
  return {
    text: `!((${reference})) · ${detail}`,
    state: { blockId, ...(fragmentId ? { fragmentId } : {}), status, count: 0 },
  };
}

function eligibleResults(
  definition: Block,
  collection: VisibleBlockCollection,
  limit: number,
): { blocks: VisibleBlock[]; completeness: BlockCollectionCompleteness } {
  const seen = new Set<string>([definition.id]);
  const blocks: VisibleBlock[] = [];
  for (const block of collection.blocks) {
    if (seen.has(block.id)) continue;
    seen.add(block.id);
    blocks.push(block);
  }
  const truncated = blocks.length > limit || collection.completeness.kind === "truncated";
  return {
    blocks: blocks.slice(0, limit),
    completeness: truncated ? { kind: "truncated", limit } : { kind: "complete" },
  };
}

async function projectVirtualBranch(
  requester: DetailEmbedRequester,
  definition: Block,
  physicalBlocks: readonly Block[],
): Promise<ProjectedEmbed> {
  const parsed = parseVirtualBranchConfig(definition, physicalBlocks);
  if (!parsed.config) {
    const detail = parsed.configurationErrors.join("; ") || "Invalid virtual branch configuration";
    return {
      text: `${linkedHeading(definition.id, "CONFIG ERROR")}\n  ${detail}`,
      state: { blockId: definition.id, status: "invalid", count: 0 },
    };
  }

  try {
    const collection = await requester.request<VisibleBlockCollection>({
      action: "blocks.query",
      query: {
        filters: parsed.config.filters,
        rankViewId: definition.id,
        limit: Math.min(MAX_BLOCK_QUERY_LIMIT, parsed.config.limit + 2),
      },
    });
    const projected = eligibleResults(definition, collection, parsed.config.limit);
    if (projected.blocks.length === 0) {
      return {
        text: linkedHeading(definition.id, "EMPTY"),
        state: {
          blockId: definition.id,
          status: "empty",
          count: 0,
          completeness: projected.completeness,
        },
      };
    }
    const resultLabel =
      `${projected.blocks.length} result${projected.blocks.length === 1 ? "" : "s"}`;
    const suffix = projected.completeness.kind === "truncated"
      ? `${resultLabel} · TRUNCATED at ${projected.completeness.limit}`
      : resultLabel;
    return {
      text: [
        linkedHeading(definition.id, suffix),
        ...projected.blocks.map((block) => `- ((${block.id}))`),
      ].join("\n"),
      state: {
        blockId: definition.id,
        status: projected.completeness.kind === "truncated" ? "truncated" : "ready",
        count: projected.blocks.length,
        completeness: projected.completeness,
      },
    };
  } catch (error) {
    return {
      text: `${linkedHeading(definition.id, "QUERY FAILED")}\n  ${boundedError(error)}`,
      state: { blockId: definition.id, status: "failed", count: 0 },
    };
  }
}

async function projectRelationView(
  definition: Block,
  embeddingSourceId: string | undefined,
  loadBlock: (blockId: string) => Promise<Block>,
): Promise<ProjectedEmbed> {
  const parsed = parseRelationViewConfig(definition);
  if (!parsed.config) {
    const detail = parsed.errors.join("; ") || "Invalid relation view configuration";
    return {
      text: `${linkedHeading(definition.id, "RELATION CONFIG ERROR")}\n  ${detail}`,
      state: { blockId: definition.id, status: "invalid", count: 0 },
    };
  }
  const sourceId = parsed.config.source.kind === "embedding-source"
    ? embeddingSourceId
    : parsed.config.source.blockId;
  if (!sourceId) {
    return {
      text: `${linkedHeading(definition.id, "RELATION SOURCE ERROR")}\n  Embedding source is unavailable`,
      state: { blockId: definition.id, status: "invalid", count: 0 },
    };
  }

  let source: Block;
  try {
    source = await loadBlock(sourceId);
  } catch (error) {
    const message = boundedError(error);
    const missing = message.startsWith(`Block not found: ${sourceId}`);
    return {
      text: `${linkedHeading(
        definition.id,
        missing ? "RELATION SOURCE MISSING" : "RELATION SOURCE FAILED",
      )}\n  ${missing ? `((${sourceId}))` : message}`,
      state: { blockId: definition.id, status: missing ? "missing" : "failed", count: 0 },
    };
  }
  if (source.effectiveDeletedRootId) {
    return {
      text: `${linkedHeading(definition.id, "RELATION SOURCE IN TRASH")}\n  ((${sourceId}))`,
      state: { blockId: definition.id, status: "deleted", count: 0 },
    };
  }

  const allowedKeys = new Set(parsed.config.relationKeys);
  const seen = new Set<string>();
  const targetIds: string[] = [];
  for (const occurrence of propertyReferenceOccurrences(source.text)) {
    if (!allowedKeys.has(occurrence.propertyKey) || seen.has(occurrence.blockId)) continue;
    seen.add(occurrence.blockId);
    targetIds.push(occurrence.blockId);
  }
  if (parsed.config.order === "target-id") targetIds.sort();
  const truncated = targetIds.length > parsed.config.limit;
  const visibleIds = targetIds.slice(0, parsed.config.limit);
  if (visibleIds.length === 0) {
    return {
      text: linkedHeading(definition.id, "RELATION EMPTY"),
      state: {
        blockId: definition.id,
        status: "empty",
        count: 0,
        completeness: { kind: "complete" },
      },
    };
  }

  const rows: string[] = [];
  for (const targetId of visibleIds) {
    let target: Block;
    try {
      target = await loadBlock(targetId);
    } catch (error) {
      const message = boundedError(error);
      rows.push(
        message.startsWith(`Block not found: ${targetId}`)
          ? `- ((${targetId})) · MISSING TARGET`
          : `- ((${targetId})) · TARGET FAILED · ${message}`,
      );
      continue;
    }
    if (target.effectiveDeletedRootId) {
      rows.push(`- ((${targetId})) · IN TRASH · ${blockDisplayTitle(target)}`);
      continue;
    }
    rows.push(`- ((${targetId}))`);
    for (const fragmentId of parsed.config.fragmentIds) {
      const resolution = resolveFragmentSlice(target.text, fragmentId);
      if (resolution.status === "missing") {
        rows.push(`  - ((${targetId}^${fragmentId})) · MISSING FRAGMENT`);
      } else if (resolution.status === "duplicate") {
        rows.push(`  - ((${targetId}^${fragmentId})) · DUPLICATE FRAGMENT`);
      } else {
        rows.push(`  - ((${targetId}^${fragmentId}))`);
        rows.push(...resolution.slice.text.split(/\r?\n/).map((line) => `    ${line}`));
      }
    }
  }

  const completeness: BlockCollectionCompleteness = truncated
    ? { kind: "truncated", limit: parsed.config.limit }
    : { kind: "complete" };
  const countLabel = `${visibleIds.length} target${visibleIds.length === 1 ? "" : "s"}`;
  const suffix = truncated
    ? `RELATION · ${countLabel} · TRUNCATED at ${parsed.config.limit}`
    : `RELATION · ${countLabel}`;
  return {
    text: [linkedHeading(definition.id, suffix), ...rows].join("\n"),
    state: {
      blockId: definition.id,
      status: truncated ? "truncated" : "ready",
      count: visibleIds.length,
      completeness,
    },
  };
}


async function projectEmbed(
  requester: DetailEmbedRequester,
  blockId: string,
  fragmentId: string | undefined,
  embeddingSourceId: string | undefined,
  loadTarget: () => Promise<Block>,
  loadBlock: (blockId: string) => Promise<Block>,
  loadPhysicalBlocks: () => Promise<readonly Block[]>,
): Promise<ProjectedEmbed> {
  let target: Block;
  try {
    target = await loadTarget();
  } catch (error) {
    const message = boundedError(error);
    return message.startsWith(`Block not found: ${blockId}`)
      ? explicitFallback(blockId, "missing", "MISSING TARGET", fragmentId)
      : explicitFallback(blockId, "failed", `TARGET FAILED · ${message}`, fragmentId);
  }
  if (target.effectiveDeletedRootId) {
    return explicitFallback(
      blockId,
      "deleted",
      `IN TRASH · ${blockDisplayTitle(target)}`,
      fragmentId,
    );
  }
  if (fragmentId) {
    const resolution = resolveFragmentSlice(target.text, fragmentId);
    if (resolution.status === "missing") {
      return explicitFallback(blockId, "fragment-missing", "MISSING FRAGMENT", fragmentId);
    }
    if (resolution.status === "duplicate") {
      return explicitFallback(blockId, "fragment-duplicate", "DUPLICATE FRAGMENT", fragmentId);
    }
    return {
      text: `Embedded fragment: ((${embedReference(blockId, fragmentId)}))\n${
        resolution.slice.text
      }`,
      state: { blockId, fragmentId, status: "ready", count: 1 },
    };
  }
  if (isRelationViewDefinition(target)) {
    return projectRelationView(target, embeddingSourceId, loadBlock);
  }
  if (!isVirtualBranchDefinition(target)) {
    return {
      text: `Embedded block: ((${blockId}))\n${target.text}`,
      state: { blockId, status: "ready", count: 1 },
    };
  }
  try {
    return projectVirtualBranch(requester, target, await loadPhysicalBlocks());
  } catch (error) {
    return explicitFallback(
      blockId,
      "failed",
      `PROJECTION FAILED · ${boundedError(error)}`,
    );
  }
}

export function detailEmbedIds(text: string): string[] {
  return [...text.matchAll(DETAIL_EMBED_PATTERN)].map((match) => match[1]!);
}

export async function projectDetailRead(
  requester: DetailEmbedRequester,
  text: string,
  options: { hostBlockId?: string } = {},
): Promise<DetailReadProjection> {
  const projectedSource = stripFragmentAnchors(text);
  const matches = [...projectedSource.matchAll(DETAIL_EMBED_PATTERN)];
  if (matches.length === 0) return { text: projectedSource, embeds: [] };

  const targetCache = new Map<string, Promise<Block>>();
  const loadTarget = (blockId: string): Promise<Block> => {
    let pending = targetCache.get(blockId);
    if (!pending) {
      pending = requester.request<Block>({ action: "get", blockId });
      targetCache.set(blockId, pending);
    }
    return pending;
  };
  let pendingPhysicalBlocks: Promise<readonly Block[]> | null = null;
  const loadPhysicalBlocks = (): Promise<readonly Block[]> => {
    pendingPhysicalBlocks ??= requester.request<WorkspaceSnapshot>({
      action: "workspace.snapshot",
    }).then((snapshot) => snapshot.physical.blocks);
    return pendingPhysicalBlocks;
  };
  const cache = new Map<string, Promise<ProjectedEmbed>>();
  for (const match of matches.slice(0, MAX_DETAIL_EMBEDS)) {
    const blockId = match[1]!;
    const fragmentId = match[2];
    const cacheKey = embedReference(blockId, fragmentId);
    if (cache.has(cacheKey)) continue;
    cache.set(
      cacheKey,
      projectEmbed(
        requester,
        blockId,
        fragmentId,
        options.hostBlockId,
        () => loadTarget(blockId),
        loadTarget,
        loadPhysicalBlocks,
      ),
    );
  }
  let consumed = 0;
  let output = "";
  const embeds: DetailEmbedState[] = [];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    const start = match.index;
    output += projectedSource.slice(consumed, start);
    const blockId = match[1]!;
    const fragmentId = match[2];
    if (index >= MAX_DETAIL_EMBEDS) {
      const limited = explicitFallback(
        blockId,
        "limit",
        `EMBED LIMIT · maximum ${MAX_DETAIL_EMBEDS}`,
        fragmentId,
      );
      output += limited.text;
      embeds.push(limited.state);
    } else {
      const pending = cache.get(embedReference(blockId, fragmentId))!;
      const projected = await pending;
      output += projected.text;
      embeds.push(projected.state);
    }
    consumed = start + match[0].length;
  }
  output += projectedSource.slice(consumed);
  return { text: output, embeds };
}
