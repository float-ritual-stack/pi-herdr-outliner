import { ANNOTATION_REPLY_TYPE, ANNOTATION_TYPE } from "./annotations";
import { getProperty } from "./properties";
import type { BacklinkSourceFacets, BacklinkStageBucket, Block } from "./types";

/**
 * Data that turns a source block's properties into backlink facets. The
 * resolver contains no workspace-specific type names: a source's own `type::`
 * value (or its containing page's) is its kind, and this table only aliases,
 * labels and buckets values. Pass a different table to change the mapping.
 */
export interface BacklinkFacetRules {
  /** Property whose value names a block's kind. */
  readonly typeProperty: string;
  /** Property that declares a page; the kind search stops at the containing page. */
  readonly pageProperty: string;
  /** Property holding an ISO date that marks a day page. */
  readonly dayProperty: string;
  /** Type values folded onto one kind. */
  readonly kindAliases: Readonly<Record<string, string>>;
  /** Labels for kinds whose humanized key reads poorly. */
  readonly kindLabels: Readonly<Record<string, string>>;
  /** Kind for a day page found through `dayProperty` or a date-prefixed page address. */
  readonly dayPageKind: string;
  /** Kind when neither the source nor its page declares a type or day. */
  readonly fallbackKind: string;
  /** Stage properties, first declared wins. */
  readonly stageProperties: readonly string[];
  /** Stage values (compared case-insensitively) for each bucket. */
  readonly stageBuckets: Readonly<Record<BacklinkStageBucket, readonly string[]>>;
}

export const DEFAULT_BACKLINK_FACET_RULES: BacklinkFacetRules = {
  typeProperty: "type",
  pageProperty: "page",
  dayProperty: "day",
  kindAliases: {
    [ANNOTATION_TYPE]: "comment",
    [ANNOTATION_REPLY_TYPE]: "comment",
  },
  kindLabels: {
    comment: "Comment",
    "day-page": "Day page",
    note: "Note",
  },
  dayPageKind: "day-page",
  fallbackKind: "note",
  stageProperties: ["work-stage", "outbox", "stage", "status"],
  stageBuckets: {
    waiting: ["waiting", "queued", "blocked", "pending", "next", "planned"],
    draft: ["draft", "unprioritized", "idea", "proposed"],
    active: ["active", "doing", "in-progress", "review", "validate", "open", "started"],
    done: [
      "done", "complete", "completed", "closed", "sent", "shipped", "accepted",
      "superseded", "cancelled", "canceled", "archived", "resolved",
    ],
  },
};

const ISO_DAY = /^\d{4}-\d{2}-\d{2}(?![\d])/;

export function isOpenBacklinkStage(bucket: BacklinkStageBucket | undefined): boolean {
  return bucket === "waiting" || bucket === "draft" || bucket === "active";
}

/** `outbox-item` → "Outbox item". */
export function humanizeBacklinkKind(kind: string): string {
  const words = kind.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : kind;
}

function kindForType(value: string, rules: BacklinkFacetRules): string {
  const normalized = value.trim().toLowerCase();
  return rules.kindAliases[normalized] ?? normalized;
}

function isDayBlock(block: Block, rules: BacklinkFacetRules): boolean {
  const day = getProperty(block.properties, rules.dayProperty);
  if (day !== undefined && ISO_DAY.test(day.trim())) return true;
  const page = getProperty(block.properties, rules.pageProperty);
  return page !== undefined && ISO_DAY.test(page.trim());
}

function sourceKind(
  source: Block,
  blocksById: ReadonlyMap<string, Block>,
  rules: BacklinkFacetRules,
): string {
  // Nearest first: the source, then ancestors up to and including its page.
  let block: Block | undefined = source;
  const seen = new Set<string>();
  while (block && !seen.has(block.id)) {
    seen.add(block.id);
    const type = getProperty(block.properties, rules.typeProperty)?.trim();
    if (type) return kindForType(type, rules);
    if (isDayBlock(block, rules)) return rules.dayPageKind;
    if (getProperty(block.properties, rules.pageProperty) !== undefined) break;
    block = block.parentId ? blocksById.get(block.parentId) : undefined;
  }
  return rules.fallbackKind;
}

function sourceStage(source: Block, rules: BacklinkFacetRules): BacklinkSourceFacets["stage"] {
  for (const property of rules.stageProperties) {
    const value = getProperty(source.properties, property)?.trim();
    if (!value) continue;
    const normalized = value.toLowerCase();
    const bucket = (Object.keys(rules.stageBuckets) as BacklinkStageBucket[])
      .find((candidate) => rules.stageBuckets[candidate].includes(normalized));
    return { property, value, ...(bucket ? { bucket } : {}) };
  }
  return undefined;
}

function sourceRelation(
  source: Block,
  target: Block,
  blocksById: ReadonlyMap<string, Block>,
): BacklinkSourceFacets["relation"] {
  if (source.id === target.id) return "self";
  const seen = new Set<string>();
  let parentId = source.parentId;
  while (parentId && !seen.has(parentId)) {
    if (parentId === target.id) return "descendant";
    seen.add(parentId);
    parentId = blocksById.get(parentId)?.parentId ?? null;
  }
  return "other";
}

function commentFacet(
  source: Block,
  blocksById: ReadonlyMap<string, Block>,
): BacklinkSourceFacets["comment"] {
  const type = getProperty(source.properties, "type")?.trim().toLowerCase();
  if (type !== ANNOTATION_TYPE && type !== ANNOTATION_REPLY_TYPE) return undefined;
  // Lifecycle belongs to the root thread; a reply follows its root.
  const rootId = type === ANNOTATION_REPLY_TYPE
    ? getProperty(source.properties, "parent-annotation")?.trim()
    : undefined;
  const root = rootId ? blocksById.get(rootId) ?? source : source;
  return { resolved: getProperty(root.properties, "annotation-status")?.trim() === "resolved" };
}

export function backlinkSourceFacets(
  source: Block,
  target: Block,
  blocksById: ReadonlyMap<string, Block>,
  rules: BacklinkFacetRules = DEFAULT_BACKLINK_FACET_RULES,
): BacklinkSourceFacets {
  const kind = sourceKind(source, blocksById, rules);
  const stage = sourceStage(source, rules);
  const comment = commentFacet(source, blocksById);
  return {
    kind,
    kindLabel: rules.kindLabels[kind] ?? humanizeBacklinkKind(kind),
    relation: sourceRelation(source, target, blocksById),
    ...(stage ? { stage } : {}),
    ...(comment ? { comment } : {}),
  };
}
