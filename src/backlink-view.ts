import { isOpenBacklinkStage } from "./backlink-facets";
import { matchesSearchText, prepareSearchQuery, type SearchQuery } from "./search-match";
import {
  BACKLINK_STAGE_BUCKETS,
  type BacklinkCollection,
  type BacklinkSource,
  type BacklinkStageBucket,
} from "./types";

/**
 * Presentation of a backlink collection from the service's facets: default
 * hiding, filters, grouping by kind and ordering. Detail and Backlink Peek use
 * this one function so a Peek snapshot matches the panel it came from.
 */

/** Detail and Peek read the same bounded source set so their counts agree. */
export const BACKLINK_QUERY_LIMIT = 200;

export type BacklinkSortField = "updated" | "created" | "title";
export type BacklinkSortDirection = "asc" | "desc";
export type BacklinkStageFilter = "all" | "open" | BacklinkStageBucket;
export const BACKLINK_STAGE_FILTERS: readonly BacklinkStageFilter[] = [
  "all",
  "open",
  ...BACKLINK_STAGE_BUCKETS,
];
export const BACKLINK_SORT_ORDER: ReadonlyArray<readonly [BacklinkSortField, BacklinkSortDirection]> = [
  ["updated", "desc"],
  ["updated", "asc"],
  ["created", "desc"],
  ["created", "asc"],
  ["title", "asc"],
  ["title", "desc"],
];

export interface BacklinkViewOptions {
  filter: string;
  sortField: BacklinkSortField;
  sortDirection: BacklinkSortDirection;
  /** Show the target itself and its descendants. */
  showRelated: boolean;
  /** Show resolved comments and replies in resolved threads. */
  showResolved: boolean;
  /** Only this kind, or every kind. */
  kind: string | null;
  stage: BacklinkStageFilter;
}

export const DEFAULT_BACKLINK_VIEW_OPTIONS: Readonly<BacklinkViewOptions> = {
  filter: "",
  sortField: "updated",
  sortDirection: "desc",
  showRelated: false,
  showResolved: false,
  kind: null,
  stage: "all",
};

export type BacklinkStageCounts = Partial<Record<BacklinkStageBucket, number>>;

export interface BacklinkViewGroup {
  kind: string;
  label: string;
  /** Every matching source in the group, open first, then by the chosen sort. */
  sources: BacklinkSource[];
  stageCounts: BacklinkStageCounts;
  openCount: number;
}

export interface BacklinkView {
  /** False when the service returned no facets; the view is then one flat list. */
  faceted: boolean;
  total: number;
  /** Sources hidden by default rules, reported so the counts add up. */
  hiddenRelated: number;
  hiddenResolved: number;
  /** Sources excluded by the text, kind or stage filter. */
  filtered: number;
  groups: BacklinkViewGroup[];
  /** Matching sources in display order: groups in order, each group's sources in order. */
  matching: BacklinkSource[];
  /** Kinds present after default hiding, in group order, for the kind toggle. */
  kinds: Array<{ kind: string; label: string }>;
}

function matchesText(source: BacklinkSource, query: SearchQuery | null): boolean {
  return matchesSearchText(query, [
    source.title,
    source.parentContext,
    source.facets?.kindLabel ?? "",
    source.facets?.stage?.value ?? "",
    ...source.referenceGroups.map((group) =>
      group.kind === "property" ? group.propertyKey : group.kind
    ),
    ...source.occurrences.map((occurrence) => occurrence.snippet),
  ]);
}

function matchesStage(source: BacklinkSource, stage: BacklinkStageFilter): boolean {
  if (stage === "all") return true;
  const bucket = source.facets?.stage?.bucket;
  return stage === "open" ? isOpenBacklinkStage(bucket) : bucket === stage;
}

function compareSources(options: BacklinkViewOptions, faceted: boolean) {
  const direction = options.sortDirection === "asc" ? 1 : -1;
  const field = options.sortField;
  return (left: BacklinkSource, right: BacklinkSource): number => {
    if (faceted) {
      const open = Number(isOpenBacklinkStage(right.facets?.stage?.bucket)) -
        Number(isOpenBacklinkStage(left.facets?.stage?.bucket));
      if (open) return open;
    }
    const primary = field === "title"
      ? left.title.localeCompare(right.title, undefined, { sensitivity: "base" })
      : left[field === "created" ? "createdAt" : "updatedAt"]
        .localeCompare(right[field === "created" ? "createdAt" : "updatedAt"]);
    return direction * primary ||
      left.title.localeCompare(right.title) ||
      left.blockId.localeCompare(right.blockId);
  };
}

export function backlinkView(
  collection: BacklinkCollection | null,
  options: Readonly<BacklinkViewOptions>,
): BacklinkView {
  const all = collection?.sources ?? [];
  const faceted = all.length > 0 && all.every((source) => source.facets !== undefined);
  const query = prepareSearchQuery(options.filter);
  let hiddenRelated = 0;
  let hiddenResolved = 0;
  const shown: BacklinkSource[] = [];
  for (const source of all) {
    if (faceted && !options.showRelated && source.facets!.placement !== "other") hiddenRelated += 1;
    else if (faceted && !options.showResolved && source.facets!.comment?.resolved) hiddenResolved += 1;
    else shown.push(source);
  }
  const compare = compareSources(options, faceted);
  if (!faceted) {
    const matching = shown.filter((source) => matchesText(source, query)).sort(compare);
    return {
      faceted,
      total: all.length,
      hiddenRelated,
      hiddenResolved,
      filtered: shown.length - matching.length,
      groups: [],
      matching,
      kinds: [],
    };
  }

  const group = (sources: readonly BacklinkSource[]): Map<string, BacklinkViewGroup> => {
    const groups = new Map<string, BacklinkViewGroup>();
    for (const source of sources) {
      const facets = source.facets!;
      let entry = groups.get(facets.kind);
      if (!entry) {
        entry = { kind: facets.kind, label: facets.kindLabel, sources: [], stageCounts: {}, openCount: 0 };
        groups.set(facets.kind, entry);
      }
      entry.sources.push(source);
      const bucket = facets.stage?.bucket;
      if (bucket) entry.stageCounts[bucket] = (entry.stageCounts[bucket] ?? 0) + 1;
      if (isOpenBacklinkStage(bucket)) entry.openCount += 1;
    }
    return groups;
  };
  const byKind = group(shown.filter((source) =>
    (options.kind === null || source.facets!.kind === options.kind) &&
    matchesStage(source, options.stage) &&
    matchesText(source, query)
  ));
  const latest = (group: BacklinkViewGroup): string =>
    group.sources.reduce((max, source) => source.updatedAt > max ? source.updatedAt : max, "");
  const orderGroups = (left: BacklinkViewGroup, right: BacklinkViewGroup): number =>
    Number(right.openCount > 0) - Number(left.openCount > 0) ||
    latest(right).localeCompare(latest(left)) ||
    left.label.localeCompare(right.label);
  const groups = [...byKind.values()].sort(orderGroups);
  for (const group of groups) group.sources.sort(compare);
  const matching = groups.flatMap((group) => group.sources);
  return {
    faceted,
    total: all.length,
    hiddenRelated,
    hiddenResolved,
    filtered: shown.length - matching.length,
    groups,
    matching,
    kinds: [...group(shown).values()].sort(orderGroups).map(({ kind, label }) => ({ kind, label })),
  };
}

/** Sources that render as rows: an expanded group lists every source; a collapsed one only its open sources. */
export function backlinkGroupRows(group: BacklinkViewGroup, expanded: boolean): BacklinkSource[] {
  return expanded
    ? group.sources
    : group.sources.filter((source) => isOpenBacklinkStage(source.facets?.stage?.bucket));
}

export function nextBacklinkSort(
  field: BacklinkSortField,
  direction: BacklinkSortDirection,
): readonly [BacklinkSortField, BacklinkSortDirection] {
  const current = BACKLINK_SORT_ORDER.findIndex(([candidateField, candidateDirection]) =>
    candidateField === field && candidateDirection === direction
  );
  return BACKLINK_SORT_ORDER[(current + 1) % BACKLINK_SORT_ORDER.length]!;
}

export function nextBacklinkStageFilter(stage: BacklinkStageFilter): BacklinkStageFilter {
  const index = BACKLINK_STAGE_FILTERS.indexOf(stage);
  return BACKLINK_STAGE_FILTERS[(index + 1) % BACKLINK_STAGE_FILTERS.length]!;
}

export function nextBacklinkKindFilter(kind: string | null, kinds: readonly { kind: string }[]): string | null {
  if (kinds.length === 0) return null;
  const index = kind === null ? -1 : kinds.findIndex((candidate) => candidate.kind === kind);
  return index + 1 < kinds.length ? kinds[index + 1]!.kind : null;
}

/** Validates options carried across a process boundary (Backlink Peek's launch). */
export function parseBacklinkViewOptions(input: unknown): BacklinkViewOptions {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Backlink view options must be an object");
  }
  const value = input as Record<string, unknown>;
  const sort = BACKLINK_SORT_ORDER.find(([field, direction]) =>
    field === value.sortField && direction === value.sortDirection
  );
  if (!sort) throw new Error("Backlink sort must be updated, created or title with asc or desc");
  if (typeof value.filter !== "string") throw new Error("Backlink filter must be text");
  if (typeof value.showRelated !== "boolean" || typeof value.showResolved !== "boolean") {
    throw new Error("Backlink showRelated and showResolved must be booleans");
  }
  if (value.kind !== null && typeof value.kind !== "string") throw new Error("Backlink kind must be text or null");
  if (!BACKLINK_STAGE_FILTERS.includes(value.stage as BacklinkStageFilter)) {
    throw new Error(`Backlink stage must be one of ${BACKLINK_STAGE_FILTERS.join(", ")}`);
  }
  return {
    filter: value.filter,
    sortField: sort[0],
    sortDirection: sort[1],
    showRelated: value.showRelated,
    showResolved: value.showResolved,
    kind: value.kind as string | null,
    stage: value.stage as BacklinkStageFilter,
  };
}
