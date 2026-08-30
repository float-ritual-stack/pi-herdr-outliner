import { isFragmentId } from "./fragments";
import type { Block } from "./types";

const BLOCK_ID_PATTERN = /^[A-Za-z0-9_-]{8,}$/;
const RELATION_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_RELATION_KEYS = 8;
export const MAX_RELATION_VIEW_LIMIT = 25;

export type RelationViewSource =
  | { kind: "block"; blockId: string }
  | { kind: "embedding-source" };

export interface RelationViewConfig {
  source: RelationViewSource;
  relationKeys: string[];
  fragmentIds: string[];
  order: "source" | "target-id";
  limit: number;
}

export interface RelationViewParseResult {
  config: RelationViewConfig | null;
  errors: string[];
}

function values(block: Block, key: string): string[] {
  return block.properties
    .filter((property) => property.key === key)
    .map((property) => property.value.trim());
}

export function isRelationViewDefinition(block: Block): boolean {
  return values(block, "type").some((value) => value.toLowerCase() === "relation-view");
}

export function parseRelationViewConfig(block: Block): RelationViewParseResult {
  const errors: string[] = [];
  const sources = values(block, "source");
  const types = values(block, "type");
  const relationLists = values(block, "relations");
  const fragments = values(block, "fragment");
  const orders = values(block, "order");
  const limits = values(block, "limit");

  if (types.length !== 1 || types[0]?.toLowerCase() !== "relation-view") {
    errors.push("Relation view must have exactly one [type::relation-view] property");
  }
  if (sources.length !== 1) {
    errors.push(`Relation view source property must appear exactly once; found ${sources.length}`);
  }
  if (relationLists.length !== 1) {
    errors.push(
      `Relation view relations property must appear exactly once; found ${relationLists.length}`,
    );
  }
  if (orders.length > 1) errors.push(`Relation view order property appears ${orders.length} times`);
  if (limits.length > 1) errors.push(`Relation view limit property appears ${limits.length} times`);
  if (fragments.length > 8) errors.push("Relation view supports at most 8 fragment selectors");

  let source: RelationViewSource | null = null;
  if (sources.length === 1) {
    const value = sources[0]!;
    if (value === "embedding-source") source = { kind: "embedding-source" };
    else if (BLOCK_ID_PATTERN.test(value)) source = { kind: "block", blockId: value };
    else errors.push(`Invalid relation view source: ${value || "(empty)"}`);
  }

  let relationKeys: string[] = [];
  if (relationLists.length === 1) {
    relationKeys = [...new Set(
      relationLists[0]!.split(",").map((key) => key.trim().toLowerCase()).filter(Boolean),
    )];
    if (relationKeys.length === 0) errors.push("Relation view requires at least one relation key");
    if (relationKeys.length > MAX_RELATION_KEYS) {
      errors.push(`Relation view supports at most ${MAX_RELATION_KEYS} relation keys`);
    }
    const invalid = relationKeys.find((key) => !RELATION_KEY_PATTERN.test(key));
    if (invalid) errors.push(`Invalid relation key: ${invalid}`);
  }

  const invalidFragment = fragments.find((fragmentId) => !isFragmentId(fragmentId));
  if (invalidFragment !== undefined) {
    errors.push(`Invalid relation fragment ID: ${invalidFragment || "(empty)"}`);
  }
  const fragmentIds = [...new Set(fragments)];

  const orderValue = orders[0] || "source";
  let order: RelationViewConfig["order"] = "source";
  if (orderValue === "source" || orderValue === "target-id") order = orderValue;
  else errors.push(`Relation view order must be source or target-id: ${orderValue}`);

  let limit = 10;
  if (limits.length === 1) {
    limit = Number(limits[0]);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RELATION_VIEW_LIMIT) {
      errors.push(`Relation view limit must be an integer from 1 through ${MAX_RELATION_VIEW_LIMIT}`);
    }
  }

  if (errors.length > 0 || !source) return { config: null, errors };
  return {
    config: {
      source,
      relationKeys,
      fragmentIds,
      order,
      limit,
    },
    errors: [],
  };
}
