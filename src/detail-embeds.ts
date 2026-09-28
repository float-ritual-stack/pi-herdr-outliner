import {presentedSource, projectedBlockReference} from './document-source';
import {atomicDocument, concatDocuments, observeDocument, sourceDocument, sliceDocument, withDocumentOccurrence,
  generatedDocument, type MappedDocument, type SourceSlice} from './document-provenance';
import type { RequestInput } from "./client";
import {isChecklistView,projectChecklistView} from './checklist-views';
import { resolveFragmentSlice, stripFragmentAnchors } from "./fragments";
import { propertyReferenceOccurrences } from "./reference-occurrences";
import { blockDisplayTitle } from "./references";
import { propertySummarySegments } from "./property-summary";
import {
  isRelationViewDefinition,
  parseRelationViewConfig,
} from "./relation-views";
import { checkServiceCompatibility } from "./service-compatibility";
import type {
  Block,
  BlockCollectionCompleteness,
  OutlinerServiceStatus,
  SavedViewReadResult,
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

export interface DetailEmbedSource {
  block:Block; startLine:number; endLine:number; contentStartLine:number;
  /** Query matches are controls; unmatched nested text remains context. */
  itemStarts?: readonly number[];
}

export interface DetailEmbedRange {
  startLine: number;
  endLine: number;
  /** Observed canonical content rendered inside this occurrence. Never inferred from paint. */
  source?: DetailEmbedSource;
  sources?: DetailEmbedSource[];
}

export interface DetailReadProjection {
  text: string;
  provenance: MappedDocument;
  embeds: DetailEmbedState[];
  embedRanges: DetailEmbedRange[];
}

interface ProjectedEmbed {
  text: string;
  provenance?: MappedDocument;
  state: DetailEmbedState;
  source?: {block: Block; startLine: number; endLine: number};
  sources?: DetailEmbedSource[];
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, MAX_ERROR_LENGTH);
}

function newlineCount(value: string): number {
  let count = 0;
  for (let index = value.indexOf("\n"); index >= 0; index = value.indexOf("\n", index + 1)) {
    count += 1;
  }
  return count;
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

/** In-flight or positive capability checks per requester; a missing capability is not kept. */
const viewReadChecks = new WeakMap<DetailEmbedRequester, Promise<string | undefined>>();

/**
 * Every surface that projects embeds (Detail, backlink peek, Goto and the other
 * previews) reaches `views.read` here, so the capability is checked here before
 * the first read: an older service yields its restart instruction, not an
 * unknown-action error. A missing capability is re-checked on the next
 * projection so a restarted service is picked up.
 */
function viewReadIncompatibility(requester: DetailEmbedRequester): Promise<string | undefined> {
  let pending = viewReadChecks.get(requester);
  if (!pending) {
    pending = requester.request<OutlinerServiceStatus>({ action: "ping" })
      .then(service => checkServiceCompatibility(service, ["views.read"])?.message);
    viewReadChecks.set(requester, pending);
    const check = pending;
    const forget = () => { if (viewReadChecks.get(requester) === check) viewReadChecks.delete(requester); };
    check.then(message => { if (message) forget(); }, forget);
  }
  return pending;
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
    const incompatibility = await viewReadIncompatibility(requester);
    if (incompatibility) {
      return {
        text: `${linkedHeading(definition.id, "SERVICE NEEDS RESTART")}\n  ${boundedError(incompatibility)}`,
        state: { blockId: definition.id, status: "failed", count: 0 },
      };
    }
    // The service evaluates membership, order and bounds exactly as Tree shows them.
    const projected = await requester.request<SavedViewReadResult>({ action: "views.read", viewId: definition.id });
    if (projected.status === "invalid") {
      return {
        text: `${linkedHeading(definition.id, "CONFIG ERROR")}\n  ${boundedError(projected.errors.join("; "))}`,
        state: { blockId: definition.id, status: "invalid", count: 0 },
      };
    }
    if (projected.status !== "ready" || !projected.completeness) {
      throw new Error(projected.errors.join("; ") || `View read ${projected.status}`);
    }
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
    const pieces: MappedDocument[] = [generatedDocument(linkedHeading(definition.id, suffix), 'view heading')];
    for (const block of projected.blocks) {
      const summary = propertySummarySegments(block.properties, parsed.config.summaryPropertyKeys ?? [])
        .map(segment => segment.plain).join(" · ");
      pieces.push(generatedDocument('\n- ', 'view list marker'), projectedBlockReference(block));
      if (summary) pieces.push(atomicDocument(` · ${summary}`, {kind: 'derived', resultId: `view-summary:${definition.id}:${block.id}`,
        dependencies: [{document: observeDocument({kind: 'block', blockId: block.id}, block.text, block.revision), start: 0, end: block.text.length}]}));
    }
    const provenance = concatDocuments(pieces);
    return {
      text: provenance.text,
      provenance,
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
  const relationTokens = new Map<string, SourceSlice>();
  const observedSource = observeDocument({kind:'block',blockId:source.id}, source.text, source.revision);
  for (const occurrence of propertyReferenceOccurrences(source.text)) {
    if (!allowedKeys.has(occurrence.propertyKey) || seen.has(occurrence.blockId)) continue;
    seen.add(occurrence.blockId);
    targetIds.push(occurrence.blockId);
    relationTokens.set(occurrence.blockId, {document:observedSource,start:occurrence.start,end:occurrence.end});
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

  const rows: MappedDocument[] = [];
  for (const targetId of visibleIds) {
    const token = relationTokens.get(targetId)!;
    const occurrence = {host:token,path:[{token,target:targetId}]};
    const relationReference = (text:string) => withDocumentOccurrence(atomicDocument(text,
      {kind:'reference',token,destination:targetId}), occurrence);
    let target: Block;
    try {
      target = await loadBlock(targetId);
    } catch (error) {
      const message = boundedError(error);
      rows.push(relationReference(
        message.startsWith(`Block not found: ${targetId}`)
          ? `- ((${targetId})) · MISSING TARGET`
          : `- ((${targetId})) · TARGET FAILED · ${message}`,
      ));
      continue;
    }
    if (target.effectiveDeletedRootId) {
      rows.push(relationReference(`- ((${targetId})) · IN TRASH · ${blockDisplayTitle(target)}`));
      continue;
    }
    rows.push(concatDocuments([generatedDocument('- ', 'relation list marker'), withDocumentOccurrence(projectedBlockReference(target), occurrence)]));
    for (const fragmentId of parsed.config.fragmentIds) {
      const resolution = resolveFragmentSlice(target.text, fragmentId);
      if (resolution.status === "missing") {
        rows.push(generatedDocument(`  - ((${targetId}^${fragmentId})) · MISSING FRAGMENT`, 'missing relation fragment'));
      } else if (resolution.status === "duplicate") {
        rows.push(generatedDocument(`  - ((${targetId}^${fragmentId})) · DUPLICATE FRAGMENT`, 'ambiguous relation fragment'));
      } else {
        rows.push(generatedDocument(`  - ((${targetId}^${fragmentId}))`, 'relation fragment heading'));
        const body = presentedSource(observeDocument({kind:'block',blockId:target.id},target.text,target.revision), resolution.slice.startLine,resolution.slice.endLine);
        const bounded = withDocumentOccurrence(sliceDocument(body,0,body.text.trimEnd().length), occurrence);
        let offset = 0;
        for (const line of bounded.text.split('\n')) {
          rows.push(concatDocuments([generatedDocument('    ', 'relation fragment indentation'),sliceDocument(bounded,offset,offset+line.length)]));
          offset += line.length + 1;
        }
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
  const provenance = concatDocuments([generatedDocument(linkedHeading(definition.id,suffix), 'relation result heading'),
    ...rows.flatMap(row=>[generatedDocument('\n','relation row separator'),row])]);
  return {
    text: provenance.text,
    provenance,
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
    const header = `Embedded fragment: ((${embedReference(blockId, fragmentId)}))\n`;
    const observed = observeDocument({kind: 'block', blockId: target.id}, target.text, target.revision);
    const body = presentedSource(observed, resolution.slice.startLine, resolution.slice.endLine, resolution.slice.anchor.kind === 'list-item');
    const provenance = concatDocuments([generatedDocument(header, 'embed heading'), sliceDocument(body, 0, body.text.trimEnd().length)]);
    return {
      text: provenance.text,
      provenance,
      state: { blockId, fragmentId, status: "ready", count: 1 },
      source: {block: target, startLine: resolution.slice.startLine, endLine: resolution.slice.endLine},
    };
  }
  if (isRelationViewDefinition(target)) {
    return projectRelationView(target, embeddingSourceId, loadBlock);
  }
  if(isChecklistView(target.text)){
    try {
      const projection=await projectChecklistView(requester,target.text,sourceDocument(observeDocument({kind:'block',blockId:target.id},target.text,target.revision)));
      return {text:projection.text,provenance:projection.provenance,sources:projection.sources,state:{blockId,status:projection.collection.completeness.kind==='truncated'?'truncated':'ready',count:projection.collection.matches.length,completeness:projection.collection.completeness}};
    }catch(error){return explicitFallback(blockId,'failed',`CHECKLIST VIEW FAILED · ${boundedError(error)}`);}
  }
  if (!isVirtualBranchDefinition(target)) {
    const provenance = concatDocuments([
      generatedDocument(`Embedded block: ((${blockId}))\n`, 'embed heading'),
      presentedSource(observeDocument({kind: 'block', blockId: target.id}, target.text, target.revision)),
    ]);
    return {
      text: provenance.text,
      provenance,
      state: { blockId, status: "ready", count: 1 },
      source: {block: target, startLine: 0, endLine: target.text.split(/\r?\n/).length - 1},
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
  options: { hostBlockId?: string; hostRevision?: number; source?: MappedDocument } = {},
): Promise<DetailReadProjection> {
  if (options.source && options.source.text !== text) throw new Error('Projection source must match its input text');
  const host = options.hostBlockId ? observeDocument({kind: 'block', blockId: options.hostBlockId}, text, options.hostRevision) : null;
  const source = options.source ?? (host ? presentedSource(host) : generatedDocument(stripFragmentAnchors(text), 'host identity unavailable'));
  const projectedSource = source.text;
  const matches = [...projectedSource.matchAll(DETAIL_EMBED_PATTERN)];
  if (matches.length === 0 && !isChecklistView(text)) return { text: projectedSource, provenance: source, embeds: [], embedRanges: [] };

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
  const mappedParts: MappedDocument[] = [];
  let outputLine = 0;
  const embeds: DetailEmbedState[] = [];
  const embedRanges: DetailEmbedRange[] = [];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    const start = match.index;
    const sourceChunk = projectedSource.slice(consumed, start);
    output += sourceChunk;
    mappedParts.push(sliceDocument(source, consumed, start));
    outputLine += newlineCount(sourceChunk);
    const blockId = match[1]!;
    const fragmentId = match[2];
    let projected: ProjectedEmbed;
    if (index >= MAX_DETAIL_EMBEDS) {
      projected = explicitFallback(
        blockId,
        "limit",
        `EMBED LIMIT · maximum ${MAX_DETAIL_EMBEDS}`,
        fragmentId,
      );
    } else {
      const pending = cache.get(embedReference(blockId, fragmentId))!;
      projected = await pending;
    }
    const startLine = outputLine;
    output += projected.text;
    const token = sliceDocument(source, start, start + match[0].length);
    const slices = token.runs.flatMap(run => run.origin.kind === 'source' ? run.origin.slices : []);
    const hostToken: SourceSlice | undefined = slices.length && slices[0]!.document === slices.at(-1)!.document
      ? {...slices[0]!, end: slices.at(-1)!.end} : undefined;
    const origin = hostToken ? {kind: 'reference' as const, token: hostToken, destination: embedReference(blockId, fragmentId)}
      : {kind: 'generated' as const, reason: 'embed source identity unavailable'};
    const fallback = ['missing', 'deleted', 'fragment-missing', 'fragment-duplicate', 'failed', 'limit'].includes(projected.state.status);
    const mapped = projected.provenance ?? (fallback ? atomicDocument(projected.text, origin)
      : generatedDocument(projected.text, 'view projection origin migration pending'));
    mappedParts.push(hostToken ? withDocumentOccurrence(mapped, {host: hostToken,
      path: [{token: hostToken, target: embedReference(blockId, fragmentId)}]}) : mapped);
    outputLine += newlineCount(projected.text);
    embeds.push(projected.state);
    embedRanges.push({ startLine, endLine: outputLine,
      ...(projected.sources?{sources:projected.sources.map(source=>({...source,contentStartLine:source.contentStartLine+startLine}))}:{}),
      ...(projected.source ? {source: {...projected.source, contentStartLine: startLine + 1}} : {}) });
    consumed = start + match[0].length;
  }
  output += projectedSource.slice(consumed);
  mappedParts.push(sliceDocument(source, consumed));
  if(isChecklistView(text)){
    output+='\n\n';
    mappedParts.push(generatedDocument('\n\n', 'checklist separator'));
    const startLine=newlineCount(output);
    try {
      const projection=await projectChecklistView(requester,source.text,source);
      output+=projection.text;
      mappedParts.push(projection.provenance);
      embedRanges.push({startLine,endLine:newlineCount(output),sources:projection.sources.map(source=>({...source,contentStartLine:source.contentStartLine+startLine}))});
      embeds.push({blockId:options.hostBlockId??'',status:projection.collection.completeness.kind==='truncated'?'truncated':'ready',count:projection.collection.matches.length,completeness:projection.collection.completeness});
    }catch(error){const failure=`Checklist view unavailable · ${boundedError(error)}`;output+=failure;mappedParts.push(generatedDocument(failure, 'checklist query failure'));}
  }
  return { text: output, provenance: concatDocuments(mappedParts), embeds, embedRanges };
}
