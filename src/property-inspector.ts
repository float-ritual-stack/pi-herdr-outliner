import {concatDocuments, generatedDocument, sliceDocument, type MappedDocument} from './document-provenance';
import {marked, type Token} from "marked";
import {linkOutlinerMarkdown, parseOutlinerLinkUri} from "./outliner-links";
import type { DetailState } from "./detail-controller";
import type { PreviewRegion } from "./detail-preview-regions";
import { pageAddressReferences, tryNormalizePageAddress } from "./page-addresses";
import { parsePropertyRecords } from "./properties";
import { blockReferenceOccurrences } from "./references";
import type { PropertyPlacement, PropertyRecord, PropertyScope, PropertySyntax } from "./types";
import { isCanonicalWorkId } from "./work-ids";
import { authoredResourceReferenceOccurrences } from "./resource-references";

const CANONICAL_BLOCK_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type PropertyInspectorTarget =
  | { readonly kind: "link"; readonly uri: string; readonly source: "value" }
  | { readonly kind: "resource-reference"; readonly source: "authored-reference" }
  | {
      readonly kind: "block";
      readonly blockId: string;
      readonly fragmentId?: string;
      readonly source: "value" | "authored-reference";
    }
  | {
      readonly kind: "work-id";
      readonly workId: string;
      readonly source: "value";
    }
  | {
      readonly kind: "page";
      readonly address: string;
      readonly normalizedAddress: string;
      readonly source: "value" | "authored-reference";
    };

export type PropertyInspectorValueKind = PropertyInspectorTarget["kind"] | "plain";

export interface PropertyValuePart {
  readonly text: string;
  readonly regionId: string;
  readonly uri?: string;
}

export interface PropertyInspectorEntry {
  readonly occurrenceId: string;
  readonly key: string;
  readonly value: string;
  readonly ordinal: number;
  readonly raw: string;
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly column: number;
  readonly placement: PropertyPlacement;
  readonly scope: PropertyScope;
  readonly syntax: PropertySyntax;
  readonly target: PropertyInspectorTarget | null;
  readonly valueParts: readonly PropertyValuePart[];
}

export interface PropertyInspectorModel {
  readonly blockId: string;
  readonly canonicalText: string;
  readonly entries: readonly PropertyInspectorEntry[];
}

export interface PropertyInspectorFilter {
  readonly query?: string;
  readonly keys?: readonly string[];
  readonly scopes?: readonly PropertyScope[];
  readonly targetKinds?: readonly PropertyInspectorValueKind[];
}

export type PropertyInspectorGroupBy = "key" | "scope" | "target";

export interface PropertyInspectorGroup {
  readonly id: string;
  readonly label: string;
  readonly entries: readonly PropertyInspectorEntry[];
}

export function propertyInspectorOccurrenceId(
  blockId: string,
  record: Pick<PropertyRecord, "key" | "ordinal" | "start" | "end">,
): string {
  return `property:${encodeURIComponent(blockId)}:${record.key}:${record.ordinal}:${record.start}-${record.end}`;
}

function authoredReferenceTarget(value: string): PropertyInspectorTarget | null {
  const blockReferences = blockReferenceOccurrences(value);
  const pageReferences = pageAddressReferences(value);
  const block = blockReferences[0];
  const page = pageReferences[0];

  if (block && (!page || block.start < page.start)) {
    return {
      kind: "block",
      blockId: block.blockId,
      ...(block.fragmentId ? { fragmentId: block.fragmentId } : {}),
      source: "authored-reference",
    };
  }
  if (page) {
    return {
      kind: "page",
      address: page.displayAddress,
      normalizedAddress: page.normalizedAddress,
      source: "authored-reference",
    };
  }
  return null;
}

export function classifyPropertyInspectorTarget(
  key: string,
  value: string,
): PropertyInspectorTarget | null {
  const normalizedValue = value.trim();
  if (!/[\s\u0000-\u001f\u007f]/.test(normalizedValue) && isFollowablePropertyLink(normalizedValue)) {
    return {kind: "link", uri: normalizedValue, source: "value"};
  }
  if (CANONICAL_BLOCK_ID_PATTERN.test(normalizedValue)) {
    return { kind: "block", blockId: normalizedValue, source: "value" };
  }
  if (isCanonicalWorkId(normalizedValue)) {
    return { kind: "work-id", workId: normalizedValue, source: "value" };
  }

  const authoredTarget = authoredReferenceTarget(value);
  if (authoredTarget) return authoredTarget;

  if (key.toLowerCase() === "page") {
    const address = tryNormalizePageAddress(normalizedValue);
    if (address) return { kind: "page", address: address.displayAddress, normalizedAddress: address.normalizedAddress, source: "value" };
  }
  return null;
}

function isFollowablePropertyLink(href: string): boolean {
  if (/^https?:\/\//.test(href)) return URL.canParse(href);
  if (!href.startsWith("pi-outliner:")) return false;
  try {
    parseOutlinerLinkUri(href);
    return true;
  } catch {
    return false;
  }
}

function propertyValueParts(value: string, occurrenceId: string): PropertyValuePart[] {
  const wholeTarget = classifyPropertyInspectorTarget("", value);
  // Markdown does not recognize bare Outliner URIs; preserve their complete address.
  if (wholeTarget?.kind === "link") {
    return [{text: value, regionId: occurrenceId, uri: wholeTarget.uri}];
  }
  let links = 0;
  const parts: PropertyValuePart[] = [];
  const visit = (tokens: Token[]) => {
    for (const token of tokens) {
      if (token.type === "link" && isFollowablePropertyLink(token.href)) {
        const regionId = links++ === 0 ? occurrenceId : `${occurrenceId}:link:${links}`;
        parts.push({text: token.text, uri: token.href, regionId});
      } else if (token.type === "text") {
        // Let Markdown claim URLs first, so Work IDs inside them stay URL text.
        const linked = linkOutlinerMarkdown(token.raw, token.raw);
        if (linked !== token.raw) visit(marked.Lexer.lexInline(linked));
        else parts.push({text: token.raw, regionId: occurrenceId});
      } else if ("tokens" in token && Array.isArray(token.tokens)) {
        visit(token.tokens);
      } else {
        parts.push({text: token.raw, regionId: occurrenceId});
      }
    }
  };
  visit(marked.Lexer.lexInline(value));
  return parts;
}

export function findPropertyInspectorEntry(
  model: PropertyInspectorModel | null | undefined, regionId: string | null | undefined,
): PropertyInspectorEntry | undefined {
  return model?.entries.find(entry => entry.occurrenceId === regionId ||
    entry.valueParts.some(part => part.uri && part.regionId === regionId));
}

export function createPropertyInspectorModel(
  blockId: string,
  canonicalText: string,
): PropertyInspectorModel {
  const resources = new Set(authoredResourceReferenceOccurrences(canonicalText)
    .filter(reference => reference.kind === "authored-resource")
    .map(reference => reference.start));
  const entries = parsePropertyRecords(canonicalText).map((record): PropertyInspectorEntry => {
    const occurrenceId = propertyInspectorOccurrenceId(blockId, record);
    const resource = resources.has(record.start);
    const valueParts = resource ? [] : propertyValueParts(record.value, occurrenceId);
    const firstUri = valueParts.find(part => part.uri)?.uri;
    return {...record, occurrenceId, valueParts,
      target: resource ? {kind: "resource-reference", source: "authored-reference"}
        : classifyPropertyInspectorTarget(record.key, record.value) ??
          (firstUri ? {kind: "link", uri: firstUri, source: "value"} : null)};
  });
  return { blockId, canonicalText, entries };
}

/**
 * Removes block-scoped metadata from the authored preview without changing the
 * canonical block text. Inline and line-scoped properties remain in context.
 * Hashtags stay visible in prose even though they classify the whole block.
 */
export function propertyInspectorAuthoredText(canonicalText: string): string {
  return propertyInspectorAuthoredDocument(generatedDocument(canonicalText, "unobserved property presentation")).text;
}

export function propertyInspectorAuthoredDocument(document: MappedDocument): MappedDocument {
  const canonicalText = document.text;
  const records = parsePropertyRecords(canonicalText).filter((record) => record.scope === "block" && record.syntax !== "hashtag");
  if (records.length === 0) return document;

  const parts: MappedDocument[] = [];
  let cursor = 0;
  for (const record of records) {
    parts.push(sliceDocument(document, cursor, record.start));
    cursor = record.end;
  }
  parts.push(sliceDocument(document, cursor));
  const stripped = concatDocuments(parts);

  const newline = canonicalText.includes("\r\n") ? "\r\n" : "\n";
  const touchedLines = new Set(records.map((record) => record.line));
  const lines = stripped.text.split(/\r?\n/);
  const output: MappedDocument[] = [];
  let offset = 0;
  let previousNewline: MappedDocument | null = null;
  let removedMetadataLine = false;
  for (let index = 0; index < lines.length; index += 1) {
    const touched = touchedLines.has(index);
    const original = lines[index]!;
    const line = touched ? original.trimEnd() : original;
    const mappedLine = sliceDocument(stripped, offset, offset + line.length);
    const newlineStart = offset + original.length;
    const newlineLength = stripped.text.startsWith("\r\n", newlineStart) ? 2 : newlineStart < stripped.text.length ? 1 : 0;
    const mappedNewline = sliceDocument(stripped, newlineStart, newlineStart + newlineLength);
    offset = newlineStart + newlineLength;
    if (touched && line.trim().length === 0) {
      removedMetadataLine = true;
      continue;
    }
    if (
      removedMetadataLine &&
      line.trim().length === 0 &&
      (output.length === 0 || output.at(-1)?.text.trim().length === 0)
    ) {
      removedMetadataLine = false;
      continue;
    }
    if (output.length) {
      // Mixed line endings normalize to the document convention. A synthetic
      // separator must never acquire neighboring prose as its source.
      output.push(previousNewline?.text === newline ? previousNewline : generatedDocument(newline, "metadata line separator"));
    }
    output.push(mappedLine);
    previousNewline = mappedNewline;
    removedMetadataLine = false;
  }
  return concatDocuments(output);
}

export function filterPropertyInspectorEntries(
  entries: readonly PropertyInspectorEntry[],
  filter: PropertyInspectorFilter = {},
): PropertyInspectorEntry[] {
  const query = filter.query?.trim().toLowerCase() ?? "";
  const keys = filter.keys ? new Set(filter.keys.map((key) => key.toLowerCase())) : null;
  const scopes = filter.scopes ? new Set(filter.scopes) : null;
  const targetKinds = filter.targetKinds ? new Set(filter.targetKinds) : null;

  return entries.filter((entry) =>
    (!query ||
      entry.key.toLowerCase().includes(query) ||
      entry.value.toLowerCase().includes(query)) &&
    (!keys || keys.has(entry.key.toLowerCase())) &&
    (!scopes || scopes.has(entry.scope)) &&
    (!targetKinds || targetKinds.has(entry.target?.kind ?? "plain"))
  );
}

function groupLabel(entry: PropertyInspectorEntry, groupBy: PropertyInspectorGroupBy): string {
  if (groupBy === "key") return entry.key;
  if (groupBy === "scope") return entry.scope;
  return entry.target?.kind ?? "plain";
}

export function groupPropertyInspectorEntries(
  entries: readonly PropertyInspectorEntry[],
  groupBy: PropertyInspectorGroupBy,
): PropertyInspectorGroup[] {
  const groups = new Map<string, PropertyInspectorEntry[]>();
  for (const entry of entries) {
    const label = groupLabel(entry, groupBy);
    const group = groups.get(label);
    if (group) group.push(entry);
    else groups.set(label, [entry]);
  }
  return [...groups].map(([label, groupEntries]) => ({
    id: `${groupBy}:${label}`,
    label,
    entries: groupEntries,
  }));
}

function propertyGroupLabel(
  entry: PropertyInspectorEntry,
  groupBy: PropertyInspectorGroupBy,
): string {
  switch (groupBy) {
    case "key":
      return entry.key;
    case "scope":
      return entry.scope;
    case "target":
      return entry.target?.kind ?? "plain";
  }
}

function propertyGroupId(groupBy: PropertyInspectorGroupBy, label: string): string {
  return `property-group:${groupBy}:${encodeURIComponent(label)}`;
}

function propertyEntryParentId(
  state: Readonly<DetailState>,
  entry: PropertyInspectorEntry,
): string {
  const groupBy = state.propertyInspector.groupBy;
  return groupBy
    ? propertyGroupId(groupBy, propertyGroupLabel(entry, groupBy))
    : "property-inspector";
}

export function detailPropertyInspectorRegions(
  state: Readonly<DetailState>,
): PreviewRegion[] {
  if (!state.propertyInspector.model) return [];
  const inspector = state.propertyInspector;
  const expanded = inspector.presentation === "dedicated" || inspector.expanded;
  const entries = expanded ? filterPropertyInspectorEntries(inspector.model?.entries ?? [], { query: inspector.filterDraft ?? inspector.filter }) : [];
  const groupBy = inspector.groupBy;
  const groups = groupBy
    ? groupPropertyInspectorEntries(entries, groupBy)
    : [];
  const childIds = groupBy
    ? groups.map((group) => propertyGroupId(groupBy, group.label))
    : entries.map((entry) => entry.occurrenceId);
  const regions: PreviewRegion[] = [{
    id: "property-inspector",
    kind: "property-inspector",
    sourceSpan: null,
    parentId: null,
    childIds,
    focusable: inspector.presentation === "inline",
    disclosure: {
      defaultExpanded: inspector.presentation === "dedicated",
      expanded,
    },
    activation: inspector.presentation === "dedicated"
      ? null
      : { type: "property-inspector.disclosure.toggle" },
  }];
  if (groupBy) {
    for (const group of groups) {
      regions.push({
        id: propertyGroupId(groupBy, group.label),
        kind: "property-group",
        sourceSpan: null,
        parentId: "property-inspector",
        childIds: group.entries.map((entry) => entry.occurrenceId),
        focusable: false,
        disclosure: null,
        activation: null,
      });
    }
  }
  for (const entry of entries) {
    regions.push({
      id: entry.occurrenceId,
      kind: "property-entry",
      sourceSpan: {
        start: entry.start,
        end: entry.end,
        startLine: entry.line,
        endLine: entry.line + entry.raw.split(/\r?\n/).length - 1,
      },
      parentId: propertyEntryParentId(state, entry),
      childIds: entry.valueParts.filter(part => part.uri && part.regionId !== entry.occurrenceId).map(part => part.regionId),
      focusable: true,
      disclosure: null,
      activation: entry.target || entry.valueParts.some(part => part.uri)
        ? {
          type: "property-inspector.target.open",
          occurrenceId: entry.occurrenceId,
        }
        : {type: "property-inspector.value.copy", occurrenceId: entry.occurrenceId},
    });
    for (const part of entry.valueParts) {
      if (!part.uri || part.regionId === entry.occurrenceId) continue;
      regions.push({id: part.regionId, kind: "property-entry", sourceSpan: null,
        parentId: entry.occurrenceId, childIds: [], focusable: true, disclosure: null,
        activation: {type: "property-inspector.target.open", occurrenceId: part.regionId}});
    }
  }
  return regions;
}
