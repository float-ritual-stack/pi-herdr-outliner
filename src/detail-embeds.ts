import {presentedSource, projectedBlockReference} from './document-source';
import {atomicDocument, concatDocuments, observeDocument, sourceDocument, sliceDocument, withDocumentOccurrence,
  generatedDocument, type MappedDocument, type SourceSlice} from './document-provenance';
import type { RequestInput } from "./client";
import {isChecklistView,projectChecklistView} from './checklist-views';
import { resolveFragmentSlice, stripFragmentAnchors } from "./fragments";
import { embedMatches, MAX_EMBEDS_PER_DOCUMENT, TRANSCLUSION_WORDING } from "./transclusions";
import { propertyReferenceOccurrences } from "./reference-occurrences";
import { blockDisplayTitle } from "./references";
import { propertySummarySegments } from "./property-summary";
import {
  isRelationViewDefinition,
  parseRelationViewConfig,
} from "./relation-views";
import { checkServiceCompatibility } from "./service-compatibility";
import { outlinerLinkUri } from "./outliner-links";
import { mayHaveResourceProjections } from "./resource-references";
import { mayHaveHandlerLines } from "./extension-handlers";
import type { ResourceProjection, ResourceProjectionReadResult } from "./resource-projection";
import type {
  Block,
  BlockCollectionCompleteness,
  OutlinerCapability,
  OutlinerServiceStatus,
  SavedViewReadResult,
  WorkspaceSnapshot,
} from "./types";
import {
  isVirtualBranchDefinition,
  parseVirtualBranchConfig,
} from "./virtual-branches";

// The syntax (never inside code), the per-document limit and the wording are the service's
// (src/transclusions.ts), so Detail and every other client that asks `transclusions.read` agree.
const MAX_DETAIL_EMBEDS = MAX_EMBEDS_PER_DOCUMENT;
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
  /**
   * A generated region inserted after an authored line (a resource projection)
   * rather than replacing an embed token. `lineCount` includes any separator
   * line after `endLine`, so authored-line mapping stays exact.
   */
  inserted?: { afterSourceLine: number; lineCount: number };
  /** A resource projection's region: its focus target and the line the reader paints its age after. */
  resource?: { resourceId?: string; fetchedAt?: string; fetchedLine?: number };
}

export interface DetailReadProjection {
  text: string;
  provenance: MappedDocument;
  embeds: DetailEmbedState[];
  embedRanges: DetailEmbedRange[];
  /** Resource projections shown in this read, for change matching. Absent when none were read. */
  resourceProjections?: readonly ResourceProjection[];
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
const capabilityChecks = new WeakMap<DetailEmbedRequester, Map<OutlinerCapability, Promise<string | undefined>>>();

/**
 * Every surface that projects embeds (Detail, backlink peek, Goto and the other
 * previews) reaches `views.read` and `resources.projection.read` here, so the
 * capability is checked here before the first read: an older service yields
 * its restart instruction, not an unknown-action error. A missing capability
 * is re-checked on the next projection so a restarted service is picked up.
 */
function serviceIncompatibility(requester: DetailEmbedRequester, capability: OutlinerCapability): Promise<string | undefined> {
  let checks = capabilityChecks.get(requester);
  if (!checks) capabilityChecks.set(requester, checks = new Map());
  let pending = checks.get(capability);
  if (!pending) {
    pending = requester.request<OutlinerServiceStatus>({ action: "ping" })
      .then(service => checkServiceCompatibility(service, [capability])?.message);
    checks.set(capability, pending);
    const check = pending;
    const forget = () => { if (checks.get(capability) === check) checks.delete(capability); };
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
    const incompatibility = await serviceIncompatibility(requester, "views.read");
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
      ? explicitFallback(blockId, "missing", TRANSCLUSION_WORDING.missing, fragmentId)
      : explicitFallback(blockId, "failed", TRANSCLUSION_WORDING.failed(message), fragmentId);
  }
  if (target.effectiveDeletedRootId) {
    return explicitFallback(
      blockId,
      "deleted",
      TRANSCLUSION_WORDING.deleted(blockDisplayTitle(target)),
      fragmentId,
    );
  }
  if (fragmentId) {
    const resolution = resolveFragmentSlice(target.text, fragmentId);
    if (resolution.status === "missing") {
      return explicitFallback(blockId, "fragment-missing", TRANSCLUSION_WORDING.fragmentMissing, fragmentId);
    }
    if (resolution.status === "duplicate") {
      return explicitFallback(blockId, "fragment-duplicate", TRANSCLUSION_WORDING.fragmentDuplicate, fragmentId);
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
      withoutDraftPatchPayload(presentedSource(observeDocument({kind: 'block', blockId: target.id}, target.text, target.revision))),
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

/**
 * A draft proposal's hidden patch (`[draft-patch::…]`, PIE-501) is machine data, never shown: an embed of the
 * proposal keeps the line (so the embed's line mapping holds) but not the payload.
 */
function withoutDraftPatchPayload(document: MappedDocument): MappedDocument {
  const match = /\[draft-patch::[A-Za-z0-9_-]*\]/.exec(document.text);
  if (!match) return document;
  return concatDocuments([sliceDocument(document, 0, match.index), sliceDocument(document, match.index + match[0].length)]);
}

/** Generated text that no parser reads as a property, hashtag, reference or Markdown control. */
function generatedInline(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\[/g, "(").replace(/\]/g, ")")
    .replace(/\(\(/g, "( (")
    .replace(/([\\`*_<>~#|])/g, "\\$1")
    .trim();
}

/** "12 min ago": painted by the reader, never stored in projected text. */
export function relativeAge(fromIso: string, now: number): string {
  const elapsed = now - Date.parse(fromIso);
  if (!Number.isFinite(elapsed)) return "";
  const minutes = Math.max(0, Math.floor(elapsed / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

function localTime(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const STATUS_LABELS: Readonly<Record<string, string>> = {
  "not-fetched": "not fetched yet",
  "not-registered": "not registered",
  "no-key": "no key found",
  "not-run": "not run yet",
  unavailable: "unavailable",
};

export interface ResourceProjectionLayout {
  lines: string[];
  /** The line, within `lines`, that ends with the fetched time; the reader paints the age after it. */
  fetchedLine?: number;
}

/**
 * The read-only lines Detail shows for one resource projection. The service
 * decides the status, label and reason wording; Detail only lays them out. A
 * status this client does not know renders generically with its reason.
 */
export function resourceProjectionLayout(projection: ResourceProjection): ResourceProjectionLayout {
  const key = projection.key ? generatedInline(projection.key) : "";
  const head = projection.resourceId && key
    ? `[${key}](${outlinerLinkUri("resource", projection.resourceId)})`
    : key;
  const title = [generatedInline(projection.label ?? projection.provider), head].filter(Boolean).join(" ");
  const reason = projection.reason ? generatedInline(projection.reason) : "";
  const lines: string[] = [];
  let fetchedLine: number | undefined;
  if ((projection.status === "ready" || projection.status === "stale") && projection.output) {
    // An extension's output or component (PIE-507): its markdown under the line, with when it ran.
    lines.push(`- ${title} · ran ${localTime(projection.output.ranAt)}${projection.fetching ? " · running" : ""}`);
    fetchedLine = 0;
    for (const line of projection.output.markdown.split("\n")) lines.push(line.trim() ? `  ${line}` : "");
    while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    if (projection.status === "stale" && reason) lines.push(`  ${reason}`);
  } else if ((projection.status === "ready" || projection.status === "stale") && projection.summary !== undefined) {
    const fetched = projection.fetchedAt ? `${projection.kind === "agent" ? "answered" : "fetched"} ${localTime(projection.fetchedAt)}` : "";
    lines.push(`- ${title} · ${generatedInline(projection.summary)}${projection.options.compact && fetched ? ` · ${fetched}` : ""}`);
    if (projection.options.compact && fetched) fetchedLine = 0;
    if (!projection.options.compact) {
      const fields = projection.fields.map(field => `${generatedInline(field.label)}: ${generatedInline(field.value)}`);
      if (projection.updatedAt) fields.push(`Updated: ${localTime(projection.updatedAt)}`);
      if (fields.length) lines.push(`  ${fields.join(" · ")}`);
      if (fetched) { fetchedLine = lines.length; lines.push(`  ${fetched}`); }
    }
    if (projection.status === "stale" && reason) lines.push(`  ${reason}`);
  } else {
    const status = projection.status === "ambiguous"
      ? `ambiguous: ${(projection.candidates ?? []).map(generatedInline).join(", ")}`
      : STATUS_LABELS[projection.status] ?? generatedInline(String(projection.status));
    lines.push(`- ${title} · ${status}`);
    if (reason) lines.push(`  ${reason}`);
  }
  if (projection.options.comments !== undefined) {
    lines.push("  Comments are not stored yet; --comments shows them once the provider returns them.");
  }
  for (const option of projection.options.unknown) lines.push(`  unknown option ${generatedInline(option)}`);
  return { lines, ...(fetchedLine !== undefined ? { fetchedLine } : {}) };
}

export function resourceProjectionLines(projection: ResourceProjection): string[] {
  return resourceProjectionLayout(projection).lines;
}

/**
 * Resource projections for a Detail read. Any failure, including an older or
 * unreachable service, leaves the note as authored: a note without provider
 * lines never gains a failure path, and one with them degrades like an embed.
 */
async function readDetailResourceProjections(
  requester: DetailEmbedRequester,
  text: string,
  blockId: string,
  revision: number | undefined,
): Promise<readonly ResourceProjection[] | null> {
  if (!mayHaveResourceProjections(text) && !mayHaveHandlerLines(text)) return null;
  try {
    if (await serviceIncompatibility(requester, "resources.projection")) return null;
    // `materialize`: a stale ticket or extension line is fetched or run in the background on open (an older
    // service ignores the field and answers the same).
    const read = await requester.request<ResourceProjectionReadResult>({ action: "resources.projection.read", blockId, materialize: true });
    // A newer revision arrives with its own change event and read.
    if (revision !== undefined && read.revision !== revision) return null;
    return read.projections;
  } catch {
    return null;
  }
}

interface ProjectedBase {
  text: string;
  provenance: MappedDocument;
  embedRanges: DetailEmbedRange[];
}

/**
 * Inserts each projection after its anchor line, one range per projection.
 * `embedSourceLines[i]` is the authored line of `embedRanges[i]`, so anchors
 * map through expanded embeds.
 */
function insertResourceProjections(
  base: ProjectedBase,
  embedSourceLines: readonly number[],
  projections: readonly ResourceProjection[],
): ProjectedBase {
  const byLine = new Map<number, ResourceProjection[]>();
  for (const projection of projections) {
    const group = byLine.get(projection.anchor.line) ?? [];
    group.push(projection);
    byLine.set(projection.anchor.line, group);
  }
  let { text, provenance } = base;
  let ranges = [...base.embedRanges];
  for (const [sourceLine, group] of [...byLine].sort((left, right) => right[0] - left[0])) {
    let outputLine = sourceLine;
    embedSourceLines.forEach((line, index) => {
      const range = base.embedRanges[index];
      if (range && line <= sourceLine) outputLine += range.endLine - range.startLine;
    });
    let lineStart = 0;
    for (let line = 0; line < outputLine; line += 1) {
      const newline = text.indexOf("\n", lineStart);
      if (newline < 0) { lineStart = -1; break; }
      lineStart = newline + 1;
    }
    if (lineStart < 0) continue;
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline < 0 ? text.length : newline > lineStart && text[newline - 1] === "\r" ? newline - 1 : newline;
    const indent = /^[ \t]*/.exec(text.slice(lineStart, lineEnd))![0];
    const layouts = group.map(projection => ({ projection, layout: resourceProjectionLayout(projection) }));
    const regionLines = layouts.flatMap(({ layout }) => layout.lines.map(line => indent + line));
    // A blank separator keeps the next authored line out of the generated list item.
    const separated = newline >= 0 && text.slice(newline + 1).split("\n", 1)[0]!.trim().length > 0;
    const inserted = `\n${regionLines.join("\n")}${separated ? "\n" : ""}`;
    const lineCount = regionLines.length + (separated ? 1 : 0);
    provenance = concatDocuments([
      sliceDocument(provenance, 0, lineEnd),
      generatedDocument(inserted, "resource projection"),
      sliceDocument(provenance, lineEnd),
    ]);
    text = provenance.text;
    ranges = ranges.map(range => range.startLine > outputLine
      ? { ...range, startLine: range.startLine + lineCount, endLine: range.endLine + lineCount,
        ...(range.source ? { source: { ...range.source, contentStartLine: range.source.contentStartLine + lineCount } } : {}),
        ...(range.sources ? { sources: range.sources.map(source => ({ ...source, contentStartLine: source.contentStartLine + lineCount })) } : {}) }
      : range);
    let next = outputLine + 1;
    layouts.forEach(({ projection, layout }, index) => {
      const last = index === layouts.length - 1;
      ranges.push({ startLine: next, endLine: next + layout.lines.length - 1,
        inserted: { afterSourceLine: sourceLine, lineCount: layout.lines.length + (last && separated ? 1 : 0) },
        resource: {
          ...(projection.resourceId ? { resourceId: projection.resourceId } : {}),
          ...(projection.fetchedAt && layout.fetchedLine !== undefined
            ? { fetchedAt: projection.fetchedAt, fetchedLine: layout.fetchedLine } : {}),
        } });
      next += layout.lines.length;
    });
  }
  return { text, provenance, embedRanges: ranges.sort((left, right) => left.startLine - right.startLine) };
}

export function detailEmbedIds(text: string): string[] {
  return embedMatches(text).map((match) => match[1]!);
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
  const pendingProjections = options.hostBlockId
    ? readDetailResourceProjections(requester, text, options.hostBlockId, options.hostRevision)
    : Promise.resolve(null);
  const matches = embedMatches(projectedSource, text);
  if (matches.length === 0 && !isChecklistView(text)) {
    const projections = await pendingProjections;
    if (!projections?.length) return { text: projectedSource, provenance: source, embeds: [], embedRanges: [] };
    const inserted = insertResourceProjections({ text: projectedSource, provenance: source, embedRanges: [] }, [],
      projections);
    return { ...inserted, embeds: [], resourceProjections: projections };
  }

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
  let mappedParts: MappedDocument[] = [];
  let outputLine = 0;
  const embeds: DetailEmbedState[] = [];
  let embedRanges: DetailEmbedRange[] = [];
  const embedSourceLines: number[] = [];

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
        TRANSCLUSION_WORDING.limit,
        fragmentId,
      );
    } else {
      const pending = cache.get(embedReference(blockId, fragmentId))!;
      projected = await pending;
    }
    const startLine = outputLine;
    embedSourceLines.push(newlineCount(projectedSource.slice(0, start)));
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
  const projections = await pendingProjections;
  if (projections?.length) {
    const inserted = insertResourceProjections({ text: output, provenance: concatDocuments(mappedParts), embedRanges },
      embedSourceLines, projections);
    output = inserted.text;
    mappedParts = [inserted.provenance];
    embedRanges = inserted.embedRanges;
  }
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
  return { text: output, provenance: concatDocuments(mappedParts), embeds, embedRanges,
    ...(projections?.length ? { resourceProjections: projections } : {}) };
}
