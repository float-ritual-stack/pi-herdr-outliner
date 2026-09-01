import { pageAddressReferences, tryNormalizePageAddress } from "./page-addresses";
import { parsePropertyRecords } from "./properties";
import { blockReferenceOccurrences } from "./references";
import type { PropertyPlacement, PropertyRecord, PropertyScope, PropertySyntax } from "./types";
import { isCanonicalWorkId } from "./work-ids";

const CANONICAL_BLOCK_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type PropertyInspectorTarget =
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

export function createPropertyInspectorModel(
  blockId: string,
  canonicalText: string,
): PropertyInspectorModel {
  const entries = parsePropertyRecords(canonicalText).map((record) => ({
    ...record,
    occurrenceId: propertyInspectorOccurrenceId(blockId, record),
    target: classifyPropertyInspectorTarget(record.key, record.value),
  }));
  return { blockId, canonicalText, entries };
}

/**
 * Removes block-scoped metadata from the authored preview without changing the
 * canonical block text. Inline and line-scoped properties remain in context.
 */
export function propertyInspectorAuthoredText(canonicalText: string): string {
  const records = parsePropertyRecords(canonicalText).filter((record) => record.scope === "block");
  if (records.length === 0) return canonicalText;

  let stripped = canonicalText;
  for (const record of [...records].reverse()) {
    stripped = stripped.slice(0, record.start) + stripped.slice(record.end);
  }

  const newline = canonicalText.includes("\r\n") ? "\r\n" : "\n";
  const touchedLines = new Set(records.map((record) => record.line));
  const lines = stripped.split(/\r?\n/);
  const output: string[] = [];
  let removedMetadataLine = false;
  for (let index = 0; index < lines.length; index += 1) {
    const touched = touchedLines.has(index);
    const line = touched ? lines[index]!.trimEnd() : lines[index]!;
    if (touched && line.trim().length === 0) {
      removedMetadataLine = true;
      continue;
    }
    if (
      removedMetadataLine &&
      line.trim().length === 0 &&
      (output.length === 0 || output.at(-1)?.trim().length === 0)
    ) {
      removedMetadataLine = false;
      continue;
    }
    output.push(line);
    removedMetadataLine = false;
  }
  return output.join(newline);
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
