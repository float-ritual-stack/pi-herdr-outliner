import {
  MAX_BLOCK_QUERY_LIMIT,
  parsePropertyFilterClause,
  parsePropertyFilterExpression,
} from "./block-query";
import { parsePropertyRecords, patchPropertyText } from "./properties";
import type {
  BlockQuerySort,
  Block,
  BlockCollectionCompleteness,
  BlockProperty,
  BlockSearchQuery,
  PropertyFilter,
  VisibleBlock,
  VisibleBlockCollection,
  VirtualOccurrenceRank,
} from "./types";

const DEFAULT_VIRTUAL_BRANCH_LIMIT = 200;
const MAX_VIRTUAL_BRANCH_LIMIT = MAX_BLOCK_QUERY_LIMIT;
const VIRTUAL_BRANCH_TYPE = "virtual-branch";
export const VIRTUAL_BRANCH_MAX_RELATIVE_DEPTH = 2;
export const VIRTUAL_BRANCH_MAX_ROWS = 1_000;

interface TreeRowBase {
  readonly rowId: string;
  readonly canonicalId: string;
  readonly block: VisibleBlock;
  readonly depth: number;
  readonly hasChildren: boolean;
  readonly multilineExpanded: boolean;
}

export interface TreePresentationState {
  readonly collapsedBlockIds: ReadonlySet<string>;
  readonly collapsedOccurrenceRowIds?: ReadonlySet<string>;
  readonly multilineExpandedRowIds: ReadonlySet<string>;
}

const EMPTY_TREE_PRESENTATION_STATE: TreePresentationState = {
  collapsedBlockIds: new Set(),
  collapsedOccurrenceRowIds: new Set(),
  multilineExpandedRowIds: new Set(),
};

export interface PhysicalTreeRow extends TreeRowBase {
  readonly kind: "physical";
  readonly collapsed: boolean;
}

export interface VirtualBranchOccurrenceRow extends TreeRowBase {
  readonly kind: "occurrence";
  readonly viewId: string;
  readonly matchRootCanonicalId: string;
  readonly parentRowId: string;
  readonly relativeDepth: number;
  readonly collapsed: boolean;
}

export type TreeRow = PhysicalTreeRow | VirtualBranchOccurrenceRow;

export interface VirtualBranchConfig {
  viewId: string;
  query: string;
  filters: PropertyFilter[];
  sort: BlockQuerySort | null;
  limit: number;
  create: BlockProperty | null;
  createParentId: string | null;
  readOnly: boolean;
}

export interface VirtualBranchConfigResult {
  config: VirtualBranchConfig | null;
  configurationErrors: string[];
  creationErrors: string[];
}

export interface VirtualBranchTruncation {
  readonly rootQuery: boolean;
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
}

export interface VirtualBranchProjection {
  rows: TreeRow[];
  branchStates: Map<string, VirtualBranchState>;
  physicalRowCount: number;
  occurrenceRowCount: number;
}

export type VirtualBranchQueryEffect = (
  query: BlockSearchQuery,
) => Promise<VisibleBlockCollection>;

export function virtualBranchStateLabel(state: VirtualBranchState): string {
  const indicators = [`V:${state.count}`];
  if (state.truncation.rootQuery) indicators.push("ROOT TRUNCATED");
  if (state.truncation.depth) indicators.push("DEPTH TRUNCATED");
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

function propertiesNamed(block: Block, key: string): BlockProperty[] {
  return block.properties.filter((property) => property.key.toLowerCase() === key);
}

function propertyCountError(key: string, expected: string, count: number): string {
  return `Virtual branch ${key} property must appear ${expected}; found ${count}`;
}

function singleProperty(
  block: Block,
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

export function isVirtualBranchDefinition(block: Block): boolean {
  return propertiesNamed(block, "type").some(
    (property) => property.value.toLowerCase() === VIRTUAL_BRANCH_TYPE,
  );
}

export function isVirtualBranchOccurrence(row: TreeRow): row is VirtualBranchOccurrenceRow {
  return row.kind === "occurrence";
}

export function isVirtualBranchRootOccurrence(
  row: TreeRow,
): row is VirtualBranchOccurrenceRow {
  return row.kind === "occurrence" && row.relativeDepth === 0;
}

function physicalTreeRow(
  block: VisibleBlock,
  presentation: TreePresentationState,
): PhysicalTreeRow {
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

export function buildPhysicalTreeRows(
  blocks: readonly VisibleBlock[],
  presentation: TreePresentationState = EMPTY_TREE_PRESENTATION_STATE,
): PhysicalTreeRow[] {
  return blocks.map((block) => physicalTreeRow(block, presentation));
}

export function parseVirtualBranchConfig(
  definition: Block,
  physicalBlocks: readonly Block[],
): VirtualBranchConfigResult {
  const configurationErrors: string[] = [];
  const creationErrors: string[] = [];

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
      configurationErrors.push(`Invalid virtual branch query: ${errorMessage(error)}`);
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
    return { config: null, configurationErrors, creationErrors };
  }

  return {
    config: {
      viewId: definition.id,
      query,
      filters,
      sort,
      limit,
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

interface ContextualDescendant {
  readonly block: VisibleBlock;
  readonly parentCanonicalId: string;
  readonly relativeDepth: number;
}

interface CanonicalContext {
  readonly descendants: readonly ContextualDescendant[];
  readonly depthTruncated: boolean;
  readonly overflow: boolean;
}

interface CanonicalAdjacency {
  readonly childrenByParentId: ReadonlyMap<string, readonly VisibleBlock[]>;
  readonly contextByRootId: Map<string, CanonicalContext>;
}

function buildCanonicalAdjacency(blocks: readonly VisibleBlock[]): CanonicalAdjacency {
  const childrenByParentId = new Map<string, VisibleBlock[]>();
  for (const block of blocks) {
    if (!block.parentId) continue;
    const siblings = childrenByParentId.get(block.parentId);
    if (siblings) siblings.push(block);
    else childrenByParentId.set(block.parentId, [block]);
  }
  return { childrenByParentId, contextByRootId: new Map() };
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

function rankedDeduplicatedRoots(
  definitionId: string,
  matches: readonly VisibleBlock[],
  ranks: readonly VirtualOccurrenceRank[],
): VisibleBlock[] {
  const seenCanonicalIds = new Set<string>();
  const roots: VisibleBlock[] = [];
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

function canonicalContext(
  root: VisibleBlock,
  adjacency: CanonicalAdjacency,
): CanonicalContext {
  const cached = adjacency.contextByRootId.get(root.id);
  if (cached) return cached;

  const descendants: ContextualDescendant[] = [];
  let depthTruncated = false;
  let overflow = false;

  function visit(block: VisibleBlock, relativeDepth: number): boolean {
    if (relativeDepth > 0 && isVirtualBranchDefinition(block)) return false;
    const children = adjacency.childrenByParentId.get(block.id) ?? [];
    if (relativeDepth >= VIRTUAL_BRANCH_MAX_RELATIVE_DEPTH) {
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
  adjacency.contextByRootId.set(root.id, context);
  return context;
}

interface AllocatedOccurrence {
  readonly rowId: string;
  readonly canonicalId: string;
  readonly viewId: string;
  readonly matchRootCanonicalId: string;
  readonly parentRowId: string;
  readonly relativeDepth: number;
  readonly block: VisibleBlock;
}

function allocateOccurrenceRows(
  definition: PhysicalTreeRow,
  roots: readonly VisibleBlock[],
  adjacency: CanonicalAdjacency,
  presentation: TreePresentationState,
): {
  readonly rows: VirtualBranchOccurrenceRow[];
  readonly descendantCount: number;
  readonly depthTruncated: boolean;
  readonly budgetTruncated: boolean;
} {
  const viewId = definition.canonicalId;
  const allocatedRoots: AllocatedOccurrence[] = roots.map((block) => ({
    rowId: rootOccurrenceRowId(viewId, block.id),
    canonicalId: block.id,
    viewId,
    matchRootCanonicalId: block.id,
    parentRowId: definition.rowId,
    relativeDepth: 0,
    block,
  }));
  const descendantCapacity = VIRTUAL_BRANCH_MAX_ROWS - allocatedRoots.length;
  const allocatedDescendants: AllocatedOccurrence[] = [];
  let depthTruncated = false;
  let budgetTruncated = false;

  for (const root of roots) {
    const context = canonicalContext(root, adjacency);
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
  const rowById = new Map<string, VirtualBranchOccurrenceRow>();
  const childrenByParentRowId = new Map<string, VirtualBranchOccurrenceRow[]>();
  for (const occurrence of allocated) {
    const hasChildren = (childCountByParentRowId.get(occurrence.rowId) ?? 0) > 0;
    const row: VirtualBranchOccurrenceRow = {
      kind: "occurrence",
      ...occurrence,
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

  const rows: VirtualBranchOccurrenceRow[] = [];
  function appendVisible(row: VirtualBranchOccurrenceRow): void {
    rows.push(row);
    if (row.collapsed) return;
    for (const child of childrenByParentRowId.get(row.rowId) ?? []) appendVisible(child);
  }
  for (const root of allocatedRoots) {
    const row = rowById.get(root.rowId);
    if (row) appendVisible(row);
  }
  return {
    rows,
    descendantCount: allocatedDescendants.length,
    depthTruncated,
    budgetTruncated,
  };
}

interface ProjectedVirtualBranch {
  readonly definitionId: string;
  readonly rows: VirtualBranchOccurrenceRow[];
  readonly state: VirtualBranchState;
}

async function projectVirtualBranch(
  definition: PhysicalTreeRow,
  physicalBlocks: readonly VisibleBlock[],
  adjacency: CanonicalAdjacency,
  queryBlocks: VirtualBranchQueryEffect,
  ranks: readonly VirtualOccurrenceRank[],
  presentation: TreePresentationState,
): Promise<ProjectedVirtualBranch> {
  const definitionId = definition.canonicalId;
  const parsed = parseVirtualBranchConfig(definition.block, physicalBlocks);
  const initialState = initialBranchState(parsed);
  if (!parsed.config) return { definitionId, rows: [], state: initialState };

  try {
    const result = await queryBlocks({
      filters: parsed.config.filters,
      ...(parsed.config.sort
        ? { sort: parsed.config.sort }
        : { rankViewId: definitionId }),
      limit: MAX_BLOCK_QUERY_LIMIT,
    });
    const eligibleRoots = rankedDeduplicatedRoots(
      definitionId,
      result.blocks,
      parsed.config.sort ? [] : ranks,
    );
    const roots = eligibleRoots.slice(
      0,
      Math.min(parsed.config.limit, VIRTUAL_BRANCH_MAX_ROWS),
    );
    const rootQueryTruncated =
      eligibleRoots.length > parsed.config.limit || result.completeness.kind === "truncated";
    const allocated = allocateOccurrenceRows(definition, roots, adjacency, presentation);
    const completeness: BlockCollectionCompleteness = rootQueryTruncated
      ? { kind: "truncated", limit: parsed.config.limit }
      : { kind: "complete" };
    return {
      definitionId,
      rows: allocated.rows,
      state: {
        ...initialState,
        count: roots.length,
        descendantCount: allocated.descendantCount,
        completeness,
        truncation: {
          rootQuery: rootQueryTruncated,
          depth: allocated.depthTruncated,
          budget: allocated.budgetTruncated,
        },
        queried: true,
      },
    };
  } catch (error) {
    return {
      definitionId,
      rows: [],
      state: {
        ...initialState,
        queryError: errorMessage(error),
        queried: true,
      },
    };
  }
}

function pruneCollapsedPhysicalBlocks(
  blocks: readonly VisibleBlock[],
  collapsedBlockIds: ReadonlySet<string>,
): readonly VisibleBlock[] {
  if (collapsedBlockIds.size === 0) return blocks;
  let hiddenBelowDepth: number | null = null;
  const visible: VisibleBlock[] = [];
  for (const block of blocks) {
    if (hiddenBelowDepth !== null && block.depth > hiddenBelowDepth) continue;
    hiddenBelowDepth = null;
    visible.push(block);
    if (collapsedBlockIds.has(block.id)) hiddenBelowDepth = block.depth;
  }
  return visible;
}

export async function projectVirtualBranches(
  visibleBlocks: readonly VisibleBlock[],
  physicalBlocks: readonly VisibleBlock[],
  queryBlocks: VirtualBranchQueryEffect,
  ranks: readonly VirtualOccurrenceRank[] = [],
  presentation: TreePresentationState = EMPTY_TREE_PRESENTATION_STATE,
): Promise<VirtualBranchProjection> {
  const physicalRows = buildPhysicalTreeRows(
    pruneCollapsedPhysicalBlocks(visibleBlocks, presentation.collapsedBlockIds),
    presentation,
  );
  const definitions = physicalRows.filter((row) => isVirtualBranchDefinition(row.block));
  const adjacency = buildCanonicalAdjacency(physicalBlocks);
  const projected = await Promise.all(
    definitions.map((definition) =>
      projectVirtualBranch(
        definition,
        physicalBlocks,
        adjacency,
        queryBlocks,
        ranks,
        presentation,
      )
    ),
  );
  const branchStates = new Map<string, VirtualBranchState>();
  const occurrences = new Map<string, readonly VirtualBranchOccurrenceRow[]>();
  for (const branch of projected) {
    branchStates.set(branch.definitionId, branch.state);
    occurrences.set(branch.definitionId, branch.rows);
  }

  const rows: TreeRow[] = [];
  let occurrenceRowCount = 0;
  for (const physical of physicalRows) {
    rows.push(physical);
    if (physical.collapsed) continue;
    const branchRows = occurrences.get(physical.canonicalId) ?? [];
    rows.push(...branchRows);
    occurrenceRowCount += branchRows.length;
  }
  return {
    rows,
    branchStates,
    physicalRowCount: physicalRows.length,
    occurrenceRowCount,
  };
}
