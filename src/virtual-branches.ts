import {
  BlockQuerySyntaxError,
  MAX_BLOCK_QUERY_LIMIT,
  parsePropertyFilterClause,
  parsePropertyFilterExpression,
} from "./block-query";
import { matchesFilters, parsePropertyRecords, patchPropertyText } from "./properties";
import { parsePropertySummaryKeys } from "./property-summary";
import type {
  BlockQuerySort,
  Block,
  BlockCollectionCompleteness,
  BlockProperty,
  BlockSearchQuery,
  PropertyFilter,
  VisibleBlock,
  VirtualOccurrenceRank,
} from "./types";

const DEFAULT_VIRTUAL_BRANCH_LIMIT = 200;
const MAX_VIRTUAL_BRANCH_LIMIT = MAX_BLOCK_QUERY_LIMIT;
const VIRTUAL_BRANCH_TYPE = "virtual-branch";
export const VIRTUAL_BRANCH_MAX_RELATIVE_DEPTH = 2;
export const VIRTUAL_BRANCH_MAX_NESTING_DEPTH = 4;
export const VIRTUAL_BRANCH_MAX_ROWS = 1_000;

export type ProjectionBlock = Pick<VisibleBlock, "id" | "parentId" | "properties" | "depth" | "hasChildren">;

interface TreeRowBase<T extends ProjectionBlock = VisibleBlock> {
  readonly rowId: string;
  readonly canonicalId: string;
  readonly block: T;
  readonly depth: number;
  readonly hasChildren: boolean;
  readonly multilineExpanded: boolean;
}

export interface TreePresentationState {
  readonly collapsedBlockIds: ReadonlySet<string>;
  /** Temporary search reveals bounded descendants without changing authored defaults. */
  readonly revealCollapsed?: boolean;
  readonly collapsedOccurrenceRowIds?: ReadonlySet<string>;
  readonly expandedOccurrenceRowIds?: ReadonlySet<string>;
  readonly multilineExpandedRowIds: ReadonlySet<string>;
}

const EMPTY_TREE_PRESENTATION_STATE: TreePresentationState = {
  collapsedBlockIds: new Set(),
  collapsedOccurrenceRowIds: new Set(),
  multilineExpandedRowIds: new Set(),
};

export interface PhysicalTreeRow<T extends ProjectionBlock = VisibleBlock> extends TreeRowBase<T> {
  readonly kind: "physical";
  readonly collapsed: boolean;
}

export interface VirtualBranchOccurrenceRow<T extends ProjectionBlock = VisibleBlock> extends TreeRowBase<T> {
  readonly kind: "occurrence";
  readonly viewId: string;
  readonly matchRootCanonicalId: string;
  readonly parentRowId: string;
  readonly relativeDepth: number;
  readonly defaultCollapsed?: boolean;
  readonly attention?: boolean;
  readonly collapsed: boolean;
}

export type TreeRow<T extends ProjectionBlock = VisibleBlock> = PhysicalTreeRow<T> | VirtualBranchOccurrenceRow<T>;

export interface VirtualBranchConfig {
  viewId: string;
  query: string;
  filters: PropertyFilter[];
  sort: BlockQuerySort | null;
  limit: number;
  create: BlockProperty | null;
  createParentId: string | null;
  readOnly: boolean;
  childDepth?: number;
  expanded?: boolean;
  expandWhen?: readonly PropertyFilter[];
  summaryPropertyKeys?: readonly string[];
}

/** A configuration error with its source property and 0-based syntax position when known. */
export interface VirtualBranchConfigurationProblem {
  message: string;
  property?: string;
  position?: number;
}

export interface VirtualBranchConfigResult {
  config: VirtualBranchConfig | null;
  configurationErrors: string[];
  /** The same errors as configurationErrors, with structure for protocol callers. */
  configurationProblems?: VirtualBranchConfigurationProblem[];
  creationErrors: string[];
}

export interface VirtualBranchTruncation {
  readonly rootQuery: boolean;
  readonly nesting?: boolean;
  readonly depth: boolean;
  readonly budget: boolean;
}

export interface VirtualBranchState extends VirtualBranchConfigResult {
  queryError: string | null;
  count: number;
  descendantCount: number;
  completeness: BlockCollectionCompleteness | null;
  truncation: VirtualBranchTruncation;
  queried: boolean;
  attentionCount?: number;
}

export interface VirtualBranchProjection<T extends ProjectionBlock = VisibleBlock> {
  rows: TreeRow<T>[];
  branchStates: Map<string, VirtualBranchState>;
  physicalRowCount: number;
  occurrenceRowCount: number;
}

export type VirtualBranchQueryEffect<T extends ProjectionBlock = VisibleBlock> = (
  query: BlockSearchQuery,
) => Promise<{ blocks: T[]; completeness: BlockCollectionCompleteness }>;

export function virtualBranchStateLabel(state: VirtualBranchState): string {
  const indicators = [`V:${state.count}`];
  if (state.config?.expandWhen) {
    indicators.push(state.queryError ? "ATTENTION UNAVAILABLE" : `ATTENTION ${state.attentionCount ?? 0}`);
    if (state.truncation.depth || state.truncation.nesting || state.truncation.budget || state.truncation.rootQuery) indicators.push("ATTENTION LIMITED");
  }
  if (state.truncation.rootQuery) indicators.push("ROOT TRUNCATED");
  if (state.truncation.depth) indicators.push(state.config?.childDepth !== undefined ? `CHILD DEPTH ${state.config.childDepth} · DEPTH LIMITED` : "DEPTH TRUNCATED");
  if (state.truncation.nesting) indicators.push("NESTING LIMITED");
  if (state.truncation.budget) indicators.push("BUDGET TRUNCATED");
  if (state.configurationErrors.length > 0) indicators.push("CONFIG ERROR");
  if (state.queryError) indicators.push("QUERY ERROR");
  if (state.config?.readOnly) indicators.push("READ-ONLY");
  return ` [${indicators.join(" · ")}]`;
}

export function decorateVirtualBranchDefinitionText(
  text: string,
  state: VirtualBranchState | undefined,
): string {
  if (!state) return text;
  const newlineIndex = text.search(/\r?\n/);
  if (newlineIndex < 0) return `${text}${virtualBranchStateLabel(state)}`;
  return `${text.slice(0, newlineIndex)}${virtualBranchStateLabel(state)}${text.slice(newlineIndex)}`;
}

function propertiesNamed(block: Pick<Block, "properties">, key: string): BlockProperty[] {
  return block.properties.filter((property) => property.key.toLowerCase() === key);
}

function propertyCountError(key: string, expected: string, count: number): string {
  return `Virtual branch ${key} property must appear ${expected}; found ${count}`;
}

function singleProperty(
  block: Pick<Block, "properties">,
  key: string,
  required: boolean,
  errors: string[],
): BlockProperty | null {
  const properties = propertiesNamed(block, key);
  const hasInvalidCount = required ? properties.length !== 1 : properties.length > 1;
  if (hasInvalidCount) {
    errors.push(
      propertyCountError(key, required ? "exactly once" : "at most once", properties.length),
    );
    return null;
  }
  return properties[0] ?? null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isVirtualBranchDefinition(block: Pick<Block, "properties">): boolean {
  return propertiesNamed(block, "type").some(
    (property) => property.value.toLowerCase() === VIRTUAL_BRANCH_TYPE,
  );
}

export function isVirtualBranchOccurrence<T extends ProjectionBlock>(row: TreeRow<T>): row is VirtualBranchOccurrenceRow<T> {
  return row.kind === "occurrence";
}

export function isVirtualBranchRootOccurrence<T extends ProjectionBlock>(
  row: TreeRow<T>,
): row is VirtualBranchOccurrenceRow<T> {
  return row.kind === "occurrence" && row.relativeDepth === 0;
}

function physicalTreeRow<T extends ProjectionBlock>(
  block: T,
  presentation: TreePresentationState,
): PhysicalTreeRow<T> {
  return {
    kind: "physical",
    rowId: block.id,
    canonicalId: block.id,
    block,
    depth: block.depth,
    hasChildren: block.hasChildren,
    collapsed: presentation.collapsedBlockIds.has(block.id),
    multilineExpanded: presentation.multilineExpandedRowIds.has(block.id),
  };
}

export function buildPhysicalTreeRows<T extends ProjectionBlock>(
  blocks: readonly T[],
  presentation: TreePresentationState = EMPTY_TREE_PRESENTATION_STATE,
): PhysicalTreeRow<T>[] {
  return blocks.map((block) => physicalTreeRow(block, presentation));
}

export function parseVirtualBranchConfig(
  definition: Pick<Block, "id" | "properties">,
  physicalBlocks: readonly Pick<Block, "id">[],
): VirtualBranchConfigResult {
  const configurationErrors: string[] = [];
  const creationErrors: string[] = [];
  const syntaxProblems = new Map<string, { property: string; position: number }>();

  const typeProperties = propertiesNamed(definition, "type");
  if (
    typeProperties.length !== 1 ||
    typeProperties[0]?.value.toLowerCase() !== VIRTUAL_BRANCH_TYPE
  ) {
    configurationErrors.push(
      "Virtual branch must have exactly one [type::virtual-branch] property",
    );
  }

  const queryProperty = singleProperty(definition, "query", true, configurationErrors);
  let query = "";
  let filters: PropertyFilter[] = [];
  if (queryProperty) {
    query = queryProperty.value;
    try {
      filters = parsePropertyFilterExpression(query);
      if (filters.length === 0) configurationErrors.push("Virtual branch query cannot be empty");
    } catch (error) {
      const message = `Invalid virtual branch query: ${errorMessage(error)}`;
      configurationErrors.push(message);
      if (error instanceof BlockQuerySyntaxError) syntaxProblems.set(message, { property: "query", position: error.index });
    }
  }

  const sortProperty = singleProperty(definition, "sort", false, configurationErrors);
  const directionProperty = singleProperty(definition, "direction", false, configurationErrors);
  let sort: BlockQuerySort | null = null;
  if (!sortProperty && directionProperty) {
    configurationErrors.push("Virtual branch direction requires a sort property");
  }
  if (sortProperty) {
    const field = sortProperty.value.toLowerCase();
    const direction = directionProperty?.value.toLowerCase() ?? "desc";
    if (field !== "created" && field !== "updated") {
      configurationErrors.push(`Virtual branch sort must be created or updated: ${sortProperty.value}`);
    }
    if (direction !== "asc" && direction !== "desc") {
      configurationErrors.push(
        `Virtual branch direction must be asc or desc: ${directionProperty?.value}`,
      );
    }
    if (
      (field === "created" || field === "updated") &&
      (direction === "asc" || direction === "desc")
    ) {
      sort = { field, direction };
    }
  }

  const limitProperty = singleProperty(definition, "limit", false, configurationErrors);
  let limit = DEFAULT_VIRTUAL_BRANCH_LIMIT;
  if (limitProperty) {
    const parsed = Number(limitProperty.value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_VIRTUAL_BRANCH_LIMIT) {
      configurationErrors.push("Virtual branch limit must be an integer from 1 through 1000");
    } else {
      limit = parsed;
    }
  }

  const depthProperty = singleProperty(definition, "child-depth", false, configurationErrors);
  const childDepth = depthProperty ? Number(depthProperty.value) : undefined;
  if (childDepth !== undefined && (!/^\d+$/.test(depthProperty!.value) || !Number.isInteger(childDepth) || childDepth < 0 || childDepth > 8)) {
    configurationErrors.push("Virtual branch child-depth must be an integer from 0 through 8");
  }
  const expandedProperty = singleProperty(definition, "expanded", false, configurationErrors);
  if (expandedProperty && !["true", "false"].includes(expandedProperty.value)) configurationErrors.push("Virtual branch expanded must be true or false");

  const expandWhenProperty = singleProperty(definition, "expand-when", false, configurationErrors);
  let expandWhen: PropertyFilter[] | undefined;
  if (expandWhenProperty) {
    try {
      expandWhen = parsePropertyFilterExpression(expandWhenProperty.value);
      if (!expandWhen.length) configurationErrors.push("Virtual branch expand-when cannot be empty");
    } catch (error) {
      const message = `Invalid virtual branch expand-when: ${errorMessage(error)}`;
      configurationErrors.push(message);
      if (error instanceof BlockQuerySyntaxError) syntaxProblems.set(message, { property: "expand-when", position: error.index });
    }
  }

  const summaryProperties = singleProperty(
    definition,
    "summary-properties",
    false,
    configurationErrors,
  );
  const summaryPropertyKeys = summaryProperties
    ? parsePropertySummaryKeys(summaryProperties.value) ?? []
    : undefined;

  const createProperty = singleProperty(definition, "create", false, creationErrors);
  let create: BlockProperty | null = null;
  if (createProperty) {
    try {
      const parsed = [parsePropertyFilterClause(createProperty.value)];
      if (parsed.length !== 1 || parsed[0]?.value === undefined || parsed[0].value.length === 0) {
        creationErrors.push(
          "Virtual branch create must contain exactly one property with a value",
        );
      } else {
        create = { key: parsed[0].key, value: parsed[0].value };
      }
    } catch (error) {
      creationErrors.push(`Invalid virtual branch create property: ${errorMessage(error)}`);
    }
  }

  const createParentProperty = singleProperty(
    definition,
    "create-parent",
    false,
    creationErrors,
  );
  let createParentId: string | null = null;
  if (createParentProperty) {
    const candidate = createParentProperty.value;
    if (physicalBlocks.some((block) => block.id === candidate)) {
      createParentId = candidate;
    } else {
      creationErrors.push(`Virtual branch create-parent block does not exist: ${candidate}`);
    }
  }

  if (configurationErrors.length > 0) {
    const configurationProblems = configurationErrors.map(message => ({ message, ...syntaxProblems.get(message) }));
    return { config: null, configurationErrors, configurationProblems, creationErrors };
  }

  return {
    config: {
      viewId: definition.id,
      query,
      filters,
      sort,
      limit,
      ...(expandWhen ? {expandWhen} : {}),
      ...(childDepth === undefined ? {} : {childDepth}),
      ...(expandedProperty ? {expanded: expandedProperty.value === "true"} : {}),
      ...(summaryPropertyKeys === undefined ? {} : { summaryPropertyKeys }),
      create,
      createParentId,
      readOnly: create === null || createParentId === null || creationErrors.length > 0,
    },
    configurationErrors,
    creationErrors,
  };
}

export function buildVirtualBranchCreationText(
  text: string,
  config: VirtualBranchConfig,
): string {
  const createProperty = config.create;
  if (config.readOnly || !createProperty || !config.createParentId) {
    throw new Error("Virtual branch is read-only");
  }

  const matchingTokens = parsePropertyRecords(text).filter(
    (token) => token.scope === "block" && token.key === createProperty.key,
  );
  if (matchingTokens.length > 1) {
    throw new Error(`Creation text has more than one ${createProperty.key} property`);
  }
  if (matchingTokens.length === 1) {
    return patchPropertyText(text, [
      { op: "replace", ordinal: matchingTokens[0]!.ordinal, value: createProperty.value },
    ]);
  }
  return patchPropertyText(text, [
    { op: "append", key: createProperty.key, value: createProperty.value },
  ]);
}

const NO_VIRTUAL_BRANCH_TRUNCATION: VirtualBranchTruncation = {
  rootQuery: false,
  depth: false,
  budget: false,
};

function initialBranchState(result: VirtualBranchConfigResult): VirtualBranchState {
  return {
    ...result,
    queryError: null,
    count: 0,
    descendantCount: 0,
    completeness: null,
    truncation: NO_VIRTUAL_BRANCH_TRUNCATION,
    queried: false,
  };
}

interface ContextualDescendant<T extends ProjectionBlock = VisibleBlock> {
  readonly block: T;
  readonly parentCanonicalId: string;
  readonly relativeDepth: number;
}

interface CanonicalContext<T extends ProjectionBlock = VisibleBlock> {
  readonly descendants: readonly ContextualDescendant<T>[];
  readonly depthTruncated: boolean;
  readonly overflow: boolean;
}

interface CanonicalAdjacency<T extends ProjectionBlock = VisibleBlock> {
  readonly definitions: ReadonlyMap<string,T>;
  readonly childrenByParentId: ReadonlyMap<string, readonly T[]>;
  readonly contextByRootId: Map<string, CanonicalContext<T>>;
}

function buildCanonicalAdjacency<T extends ProjectionBlock>(blocks: readonly T[]): CanonicalAdjacency<T> {
  const childrenByParentId = new Map<string, T[]>();
  const definitions = new Map<string,T>();
  for (const block of blocks) {
    if(isVirtualBranchDefinition(block)) definitions.set(block.id,block);
    if (!block.parentId) continue;
    const siblings = childrenByParentId.get(block.parentId);
    if (siblings) siblings.push(block);
    else childrenByParentId.set(block.parentId, [block]);
  }
  return { childrenByParentId, definitions, contextByRootId: new Map() };
}

function rootOccurrenceRowId(viewId: string, canonicalId: string): string {
  return `occurrence:${viewId}:${canonicalId}`;
}

function descendantOccurrenceRowId(
  viewId: string,
  matchRootCanonicalId: string,
  canonicalId: string,
): string {
  return `occurrence:${viewId}:${matchRootCanonicalId}:${canonicalId}`;
}

function rankedDeduplicatedRoots<T extends Pick<ProjectionBlock, "id">>(
  definitionId: string,
  matches: readonly T[],
  ranks: readonly VirtualOccurrenceRank[],
): T[] {
  const seenCanonicalIds = new Set<string>();
  const roots: T[] = [];
  for (const block of matches) {
    if (block.id === definitionId || seenCanonicalIds.has(block.id)) continue;
    seenCanonicalIds.add(block.id);
    roots.push(block);
  }
  const rankByBlockId = new Map(
    ranks
      .filter((entry) => entry.viewId === definitionId)
      .map((entry) => [entry.blockId, entry.rank]),
  );
  roots.sort((left, right) => {
    const leftRank = rankByBlockId.get(left.id);
    const rightRank = rankByBlockId.get(right.id);
    if (leftRank === undefined && rightRank === undefined) return 0;
    if (leftRank === undefined) return 1;
    if (rightRank === undefined) return -1;
    return leftRank - rightRank || left.id.localeCompare(right.id);
  });
  return roots;
}

function canonicalContext<T extends ProjectionBlock>(
  root: T,
  adjacency: CanonicalAdjacency<T>,
  maxDepth: number,
): CanonicalContext<T> {
  const cached = adjacency.contextByRootId.get(`${root.id}:${maxDepth}`);
  if (cached) return cached;

  const descendants: ContextualDescendant<T>[] = [];
  let depthTruncated = false;
  let overflow = false;

  function visit(block: T, relativeDepth: number): boolean {
    if (relativeDepth > 0 && adjacency.definitions.has(block.id)) return false;
    const children = adjacency.childrenByParentId.get(block.id) ?? [];
    if (relativeDepth >= maxDepth) {
      if (children.length > 0) depthTruncated = true;
      return overflow && depthTruncated;
    }
    for (const child of children) {
      if (descendants.length <= VIRTUAL_BRANCH_MAX_ROWS) {
        descendants.push({
          block: child,
          parentCanonicalId: block.id,
          relativeDepth: relativeDepth + 1,
        });
      } else {
        overflow = true;
      }
      if (visit(child, relativeDepth + 1)) return true;
    }
    return overflow && depthTruncated;
  }

  visit(root, 0);
  const context = { descendants, depthTruncated, overflow };
  adjacency.contextByRootId.set(`${root.id}:${maxDepth}`, context);
  return context;
}

interface AllocatedOccurrence<T extends ProjectionBlock = VisibleBlock> {
  readonly rowId: string;
  readonly canonicalId: string;
  readonly viewId: string;
  readonly matchRootCanonicalId: string;
  readonly parentRowId: string;
  readonly relativeDepth: number;
  readonly block: T;
}

function allocateOccurrenceRows<T extends ProjectionBlock>(
  definition: PhysicalTreeRow<T>,
  roots: readonly T[],
  adjacency: CanonicalAdjacency<T>,
  presentation: TreePresentationState,
  config: VirtualBranchConfig,
): {
  readonly rows: VirtualBranchOccurrenceRow<T>[];
  readonly descendantCount: number;
  readonly depthTruncated: boolean;
  readonly budgetTruncated: boolean;
} {
  const viewId = definition.canonicalId;
  const allocatedRoots: AllocatedOccurrence<T>[] = roots.map((block) => ({
    rowId: rootOccurrenceRowId(viewId, block.id),
    canonicalId: block.id,
    viewId,
    matchRootCanonicalId: block.id,
    parentRowId: definition.rowId,
    relativeDepth: 0,
    block,
  }));
  const descendantCapacity = VIRTUAL_BRANCH_MAX_ROWS - allocatedRoots.length;
  const allocatedDescendants: AllocatedOccurrence<T>[] = [];
  let depthTruncated = false;
  let budgetTruncated = false;

  for (const root of roots) {
    const context = canonicalContext(root, adjacency, config.childDepth ?? VIRTUAL_BRANCH_MAX_RELATIVE_DEPTH);
    if (context.depthTruncated) depthTruncated = true;
    const remaining = descendantCapacity - allocatedDescendants.length;
    const take = Math.min(remaining, context.descendants.length);
    if (context.overflow || take < context.descendants.length) budgetTruncated = true;
    const rootRowId = rootOccurrenceRowId(viewId, root.id);
    for (let index = 0; index < take; index += 1) {
      const contextual = context.descendants[index]!;
      const parentRowId = contextual.relativeDepth === 1
        ? rootRowId
        : descendantOccurrenceRowId(viewId, root.id, contextual.parentCanonicalId);
      allocatedDescendants.push({
        rowId: descendantOccurrenceRowId(viewId, root.id, contextual.block.id),
        canonicalId: contextual.block.id,
        viewId,
        matchRootCanonicalId: root.id,
        parentRowId,
        relativeDepth: contextual.relativeDepth,
        block: contextual.block,
      });
    }
  }

  const childCountByParentRowId = new Map<string, number>();
  for (const descendant of allocatedDescendants) {
    childCountByParentRowId.set(
      descendant.parentRowId,
      (childCountByParentRowId.get(descendant.parentRowId) ?? 0) + 1,
    );
  }
  const allocated = [...allocatedRoots, ...allocatedDescendants];
  // Inspect only the already bounded canonical allocation. Never follow external Resources
  // or run another query: attention cannot enlarge membership or escape child-depth.
  const allocatedById = new Map(allocated.map(row => [row.rowId, row]));
  const attentionPaths = new Set<string>();
  const attentionAncestors = new Set<string>();
  for (const row of allocated) {
    if (!config.expandWhen || !matchesFilters(row.block.properties, config.expandWhen)) continue;
    let current: AllocatedOccurrence<T> | undefined = row;
    while (current && !attentionPaths.has(current.rowId)) {
      attentionPaths.add(current.rowId);
      current = allocatedById.get(current.parentRowId);
      if (current) attentionAncestors.add(current.rowId);
    }
  }
  const rowById = new Map<string, VirtualBranchOccurrenceRow<T>>();
  const childrenByParentRowId = new Map<string, VirtualBranchOccurrenceRow<T>[]>();
  for (const occurrence of allocated) {
    const hasChildren = (childCountByParentRowId.get(occurrence.rowId) ?? 0) > 0;
    const row: VirtualBranchOccurrenceRow<T> = {
      kind: "occurrence",
      ...occurrence,
      ...(config.expanded === false && (occurrence.relativeDepth === 0 || config.expandWhen)
        && !attentionAncestors.has(occurrence.rowId) ? {defaultCollapsed: true} : {}),
      ...(attentionPaths.has(occurrence.rowId) ? {attention: true} : {}),
      depth: definition.depth + 1 + occurrence.relativeDepth,
      hasChildren,
      collapsed: hasChildren &&
        (presentation.collapsedOccurrenceRowIds?.has(occurrence.rowId) ?? false),
      multilineExpanded: presentation.multilineExpandedRowIds.has(occurrence.rowId),
    };
    rowById.set(row.rowId, row);
    const siblings = childrenByParentRowId.get(row.parentRowId);
    if (siblings) siblings.push(row);
    else childrenByParentRowId.set(row.parentRowId, [row]);
  }

  const rows: VirtualBranchOccurrenceRow<T>[] = [];
  function appendAllocated(row: VirtualBranchOccurrenceRow<T>): void {
    rows.push(row);
    for (const child of childrenByParentRowId.get(row.rowId) ?? []) appendAllocated(child);
  }
  for (const root of allocatedRoots) {
    const row = rowById.get(root.rowId);
    if (row) appendAllocated(row);
  }
  return {
    rows,
    descendantCount: allocatedDescendants.length,
    depthTruncated,
    budgetTruncated,
  };
}

interface ProjectedVirtualBranch<T extends ProjectionBlock = VisibleBlock> {
  readonly definitionId: string;
  readonly rows: VirtualBranchOccurrenceRow<T>[];
  readonly state: VirtualBranchState;
}

/** The canonical query whose results a saved view ranks, deduplicates and bounds. */
export function virtualBranchMembershipQuery(
  viewId: string,
  config: Pick<VirtualBranchConfig, "filters" | "sort">,
  limit: number = MAX_BLOCK_QUERY_LIMIT,
): BlockSearchQuery {
  return { filters: config.filters, ...(config.sort ? { sort: config.sort } : { rankViewId: viewId }), limit };
}

export interface VirtualBranchMembers<T> {
  /** The requested page of eligible members, in branch order. */
  readonly members: T[];
  /** Eligible members known from the query; a lower bound when the query was truncated. */
  readonly eligible: number;
  /** More eligible members follow this page, or the query itself was truncated. */
  readonly truncated: boolean;
}

/**
 * Branch order over one query result: the definition is excluded, duplicates are
 * removed, and unsorted branches place persisted manual ranks first.
 */
export function selectVirtualBranchMembers<T extends Pick<ProjectionBlock, "id">>(
  definitionId: string,
  config: Pick<VirtualBranchConfig, "sort">,
  result: { blocks: readonly T[]; completeness: BlockCollectionCompleteness },
  ranks: readonly VirtualOccurrenceRank[],
  limit: number,
  offset = 0,
): VirtualBranchMembers<T> {
  const eligible = rankedDeduplicatedRoots(definitionId, result.blocks, config.sort ? [] : ranks);
  return {
    members: eligible.slice(offset, offset + limit),
    eligible: eligible.length,
    truncated: eligible.length > offset + limit || result.completeness.kind === "truncated",
  };
}

function assertViewReadLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_VIRTUAL_BRANCH_LIMIT) {
    throw new Error("View read limit must be an integer from 1 through 1000");
  }
}

/**
 * Client-side membership over a query effect. Saved views are read through the
 * service's views.read; this remains for hypothetical plans (virtual-child
 * admission) and scoped adapters that alter the query.
 */
export async function evaluateVirtualBranchMatches<T extends ProjectionBlock>(
  definition: T,
  physicalBlocks: readonly T[],
  queryBlocks: VirtualBranchQueryEffect<T>,
  ranks: readonly VirtualOccurrenceRank[] = [],
  limitOverride?: number,
): Promise<{ roots: T[]; state: VirtualBranchState }> {
  const parsed = parseVirtualBranchConfig(definition, physicalBlocks);
  const state = initialBranchState(parsed);
  if (!parsed.config) return { roots: [], state };
  const limit = limitOverride ?? parsed.config.limit;
  assertViewReadLimit(limit);
  try {
    const result = await queryBlocks(virtualBranchMembershipQuery(definition.id, parsed.config));
    const selected = selectVirtualBranchMembers(definition.id, parsed.config, result, ranks, limit);
    return { roots: selected.members, state: membershipState(state, selected.members.length, selected.truncated, limit) };
  } catch (error) {
    return { roots: [], state: { ...state, queryError: errorMessage(error), queried: true } };
  }
}

function membershipState(state: VirtualBranchState, count: number, truncated: boolean, limit: number): VirtualBranchState {
  return {
    ...state, count, queried: true,
    completeness: truncated ? { kind: "truncated", limit } : { kind: "complete" },
    truncation: { rootQuery: truncated, depth: false, budget: false },
  };
}

/** The part of a views.read result that membership needs; see SavedViewReadResult. */
export interface SavedViewMembership<T> {
  status: "ready" | "invalid" | "unsupported" | "missing" | "changed" | "failed";
  blocks: T[];
  completeness: BlockCollectionCompleteness | null;
  errors: string[];
}

/** Membership effect backed by the service's saved-view read. */
export type VirtualBranchMembershipEffect<T extends ProjectionBlock = VisibleBlock> = (
  definition: T,
  physicalBlocks: readonly T[],
) => Promise<{ roots: T[]; state: VirtualBranchState }>;

export function savedViewMembership<T extends ProjectionBlock>(
  readView: (viewId: string) => Promise<SavedViewMembership<T>>,
): VirtualBranchMembershipEffect<T> {
  return async (definition, physicalBlocks) => {
    // Local configuration still supplies presentation (depth, disclosure, attention).
    const parsed = parseVirtualBranchConfig(definition, physicalBlocks);
    const state = initialBranchState(parsed);
    if (!parsed.config) return { roots: [], state };
    try {
      const read = await readView(definition.id);
      if (read.status !== "ready" || !read.completeness) {
        return { roots: [], state: { ...state, queryError: read.errors.join("; ") || `View read ${read.status}`, queried: true } };
      }
      return { roots: read.blocks, state: membershipState(state, read.blocks.length, read.completeness.kind === "truncated", parsed.config.limit) };
    } catch (error) {
      return { roots: [], state: { ...state, queryError: errorMessage(error), queried: true } };
    }
  };
}

function membershipEffect<T extends ProjectionBlock>(
  source: VirtualBranchQueryEffect<T> | { readonly members: VirtualBranchMembershipEffect<T> },
  ranks: readonly VirtualOccurrenceRank[],
): VirtualBranchMembershipEffect<T> {
  if (typeof source !== "function") return source.members;
  return (definition, physicalBlocks) => evaluateVirtualBranchMatches(definition, physicalBlocks, source, ranks);
}

async function projectVirtualBranch<T extends ProjectionBlock>(
  definition: PhysicalTreeRow<T>,
  physicalBlocks: readonly T[],
  adjacency: CanonicalAdjacency<T>,
  members: VirtualBranchMembershipEffect<T>,
  presentation: TreePresentationState,
): Promise<ProjectedVirtualBranch<T>> {
  const { roots, state } = await members(definition.block, physicalBlocks);
  const definitionId = definition.canonicalId;
  if (!state.config || state.queryError) return { definitionId, rows: [], state };
  const allocated = allocateOccurrenceRows(definition, roots, adjacency, presentation, state.config);
  return {
    definitionId, rows: allocated.rows,
    state: {
      ...state, descendantCount: allocated.descendantCount,
      ...(state.config.expandWhen ? { attentionCount: allocated.rows.filter(row =>
        matchesFilters(row.block.properties, state.config!.expandWhen!)).length } : {}),
      truncation: { ...state.truncation, depth: allocated.depthTruncated, budget: allocated.budgetTruncated },
    },
  };
}
interface NestedOccurrenceComposition<T extends ProjectionBlock = VisibleBlock> {
  readonly rows: VirtualBranchOccurrenceRow<T>[];
  readonly nestingTruncated: boolean;
  readonly depthTruncated: boolean;
  readonly budgetTruncated: boolean;
}

function composeNestedOccurrences<T extends ProjectionBlock>(
  rootViewId: string,
  rootDefinitionDepth: number,
  childrenByView: ReadonlyMap<string, ReadonlyMap<string, readonly VirtualBranchOccurrenceRow<T>[]>>,
  presentation: TreePresentationState,
  states: ReadonlyMap<string, VirtualBranchState>,
): NestedOccurrenceComposition<T> {
  const composed: VirtualBranchOccurrenceRow<T>[] = [];
  let nestingTruncated = false;
  let depthTruncated = false;
  let budgetTruncated = false;

  function appendBranch(
    viewId: string,
    parentRowId: string,
    parentDepth: number,
    nestingDepth: number,
    rowIdPrefix: string,
    activeViewIds: ReadonlySet<string>,
    remainingDepth: number,
  ): void {
    const children = childrenByView.get(viewId);
    if (!children) return;
    for (const root of children.get(viewId) ?? []) {
      appendOccurrence(
        root,
        children,
        parentRowId,
        parentDepth + 1,
        nestingDepth,
        rowIdPrefix,
        activeViewIds,
        Math.min(remainingDepth, states.get(viewId)?.config?.childDepth ?? Infinity),
      );
    }
  }

  function appendOccurrence(
    source: VirtualBranchOccurrenceRow<T>,
    sourceChildren: ReadonlyMap<string, readonly VirtualBranchOccurrenceRow<T>[]>,
    parentRowId: string,
    depth: number,
    nestingDepth: number,
    rowIdPrefix: string,
    activeViewIds: ReadonlySet<string>,
    remainingDepth: number,
  ): void {
    if (composed.length >= VIRTUAL_BRANCH_MAX_ROWS) {
      budgetTruncated = true;
      return;
    }
    const rowId = rowIdPrefix ? `${rowIdPrefix}/${source.rowId}` : source.rowId;
    const physicalChildren = sourceChildren.get(source.rowId) ?? [];
    const nestedRoots = childrenByView.get(source.canonicalId)?.get(source.canonicalId) ?? [];
    const cycle = activeViewIds.has(source.canonicalId);
    const canNest = remainingDepth > 0 && nestedRoots.length > 0 && !cycle &&
      nestingDepth < VIRTUAL_BRANCH_MAX_NESTING_DEPTH;
    if (nestedRoots.length > 0 && remainingDepth > 0 && !canNest) nestingTruncated = true;
    if (remainingDepth === 0 && (physicalChildren.length > 0 || nestedRoots.length > 0)) depthTruncated = true;
    const hasChildren = remainingDepth > 0 && (source.hasChildren || canNest);
    const collapsed = !presentation.revealCollapsed && hasChildren && (
      (presentation.collapsedOccurrenceRowIds?.has(rowId) ?? false) ||
      (!!source.defaultCollapsed && !(presentation.expandedOccurrenceRowIds?.has(rowId) ?? false))
    );
    const row: VirtualBranchOccurrenceRow<T> = {
      ...source,
      rowId,
      parentRowId,
      depth,
      hasChildren,
      collapsed,
      multilineExpanded: presentation.multilineExpandedRowIds.has(rowId),
    };
    composed.push(row);
    if (collapsed || remainingDepth === 0) return;

    for (const child of physicalChildren) {
      appendOccurrence(
        child,
        sourceChildren,
        rowId,
        depth + 1,
        nestingDepth,
        rowIdPrefix,
        activeViewIds,
        remainingDepth - 1,
      );
    }
    if (!canNest) return;
    const nestedActiveViewIds = new Set(activeViewIds);
    nestedActiveViewIds.add(source.canonicalId);
    appendBranch(
      source.canonicalId,
      rowId,
      depth,
      nestingDepth + 1,
      rowId,
      nestedActiveViewIds,
      remainingDepth - 1,
    );
  }

  appendBranch(rootViewId, rootViewId, rootDefinitionDepth, 0, "", new Set([rootViewId]), Infinity);
  return { rows: composed, depthTruncated, nestingTruncated, budgetTruncated };
}

function pruneCollapsedPhysicalBlocks<T extends ProjectionBlock>(
  blocks: readonly T[],
  collapsedBlockIds: ReadonlySet<string>,
): readonly T[] {
  if (collapsedBlockIds.size === 0) return blocks;
  let hiddenBelowDepth: number | null = null;
  const visible: T[] = [];
  for (const block of blocks) {
    if (hiddenBelowDepth !== null && block.depth > hiddenBelowDepth) continue;
    hiddenBelowDepth = null;
    visible.push(block);
    if (collapsedBlockIds.has(block.id)) hiddenBelowDepth = block.depth;
  }
  return visible;
}

export async function projectVirtualBranches<T extends ProjectionBlock>(
  visibleBlocks: readonly T[],
  physicalBlocks: readonly T[],
  source: VirtualBranchQueryEffect<T> | { readonly members: VirtualBranchMembershipEffect<T> },
  ranks: readonly VirtualOccurrenceRank[] = [],
  presentation: TreePresentationState = EMPTY_TREE_PRESENTATION_STATE,
): Promise<VirtualBranchProjection<T>> {
  const members = membershipEffect(source, ranks);
  const physicalRows = buildPhysicalTreeRows(
    pruneCollapsedPhysicalBlocks(visibleBlocks, presentation.collapsedBlockIds),
    presentation,
  );
  const adjacency = buildCanonicalAdjacency(physicalBlocks);
  const definitions = adjacency.definitions;
  const branchStates = new Map<string, VirtualBranchState>();
  const childrenByView = new Map<string, Map<string, VirtualBranchOccurrenceRow<T>[]>>();
  let pending = physicalRows.filter(row => isVirtualBranchDefinition(row.block)).map(row => row.block);
  let rows: TreeRow<T>[] = [];
  let occurrenceRowCount = 0;
  // Discover queries from displayed occurrences, not only their physical source.
  // Each definition is queried once; composition retains its cycle/depth/row bounds.
  do {
    const projected = await Promise.all(pending.map(block => projectVirtualBranch(
      physicalTreeRow(block, presentation), physicalBlocks, adjacency, members, presentation,
    )));
    for (const branch of projected) {
      branchStates.set(branch.definitionId, branch.state);
      const children = new Map<string, VirtualBranchOccurrenceRow<T>[]>();
      for (const row of branch.rows) {
        const siblings = children.get(row.parentRowId);
        if (siblings) siblings.push(row); else children.set(row.parentRowId, [row]);
      }
      childrenByView.set(branch.definitionId, children);
    }
    rows = [];
    occurrenceRowCount = 0;
    for (const physical of physicalRows) {
      const hasVirtualChildren = (childrenByView.get(physical.canonicalId)?.get(physical.canonicalId)?.length ?? 0) > 0;
      const row = !physical.hasChildren && hasVirtualChildren
        ? { ...physical, hasChildren: true }
        : physical;
      rows.push(row);
      if (row.collapsed || !hasVirtualChildren) continue;
      const composition = composeNestedOccurrences(
        physical.canonicalId,
        physical.depth,
        childrenByView,
        presentation,
        branchStates,
      );
      rows.push(...composition.rows);
      occurrenceRowCount += composition.rows.length;
      if (composition.depthTruncated || composition.nestingTruncated || composition.budgetTruncated) {
        const state = branchStates.get(physical.canonicalId);
        if (state) {
          branchStates.set(physical.canonicalId, {
            ...state,
            truncation: {
              ...state.truncation,
              depth: state.truncation.depth || composition.depthTruncated,
              ...(composition.nestingTruncated ? {nesting: true} : {}),
              budget: state.truncation.budget || composition.budgetTruncated,
            },
          });
        }
      }
    }
    pending = [...new Set(rows.filter(row => !row.collapsed && definitions.has(row.canonicalId)
      && !branchStates.has(row.canonicalId)).map(row => row.canonicalId))].map(id => definitions.get(id)!);
  } while (pending.length);

  return {
    rows,
    branchStates,
    physicalRowCount: physicalRows.length,
    occurrenceRowCount,
  };
}


/** Check a proposed first child with the same bounded allocation used by Tree. */
export async function planVirtualChild<T extends ProjectionBlock>(
  parent: VirtualBranchOccurrenceRow<T>,
  child: T,
  visibleBlocks: readonly T[],
  physicalBlocks: readonly T[],
  queryBlocks: VirtualBranchQueryEffect<T>,
  ranks: readonly VirtualOccurrenceRank[],
  presentation: TreePresentationState,
): Promise<{ problem: string } | { rowId: (createdId: string) => string }> {
  const parentIndex = physicalBlocks.findIndex(block => block.id === parent.canonicalId);
  if (parentIndex < 0) return { problem: "The canonical parent is no longer available" };
  const physical = [...physicalBlocks];
  physical.splice(parentIndex + 1, 0, child);
  const collapsed = new Set(presentation.collapsedOccurrenceRowIds);
  collapsed.delete(parent.rowId);
  const expanded = new Set(presentation.expandedOccurrenceRowIds);
  expanded.add(parent.rowId);
  const prefix = parent.rowId.slice(0, parent.rowId.lastIndexOf("occurrence:"));
  const rowId = (id: string) => prefix + descendantOccurrenceRowId(parent.viewId, parent.matchRootCanonicalId, id);
  const projected = await projectVirtualBranches(visibleBlocks, physical, async query => {
    const result = await queryBlocks(query);
    // Reserve a matching new root before the limit. This conservative admission
    // also covers a new child that sorts before the parent's current match root.
    return matchesFilters(child.properties, query.filters ?? [])
      ? { ...result, blocks: [child, ...result.blocks] }
      : result;
  }, ranks, { ...presentation, collapsedOccurrenceRowIds: collapsed, expandedOccurrenceRowIds: expanded });
  if (projected.rows.some(row => row.rowId === rowId(child.id))) return { rowId };
  const state = projected.branchStates.get(parent.viewId);
  const depth = state?.config?.childDepth ?? VIRTUAL_BRANCH_MAX_RELATIVE_DEPTH;
  return { problem: `Cannot display a new child here: child-depth ${depth}, result limit ${state?.config?.limit ?? DEFAULT_VIRTUAL_BRANCH_LIMIT}, row budget ${VIRTUAL_BRANCH_MAX_ROWS}, or nested definition boundary. Use Reveal source (Shift+R) to add there, or adjust this view.` };
}
