import { parseFilter, parsePropertyTokens, patchPropertyText } from "./properties";
import type {
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
const MAX_VIRTUAL_BRANCH_LIMIT = 1_000;
const VIRTUAL_BRANCH_TYPE = "virtual-branch";

interface TreeRowBase {
  readonly rowId: string;
  readonly canonicalId: string;
  readonly block: VisibleBlock;
  readonly depth: number;
  readonly hasChildren: boolean;
  readonly multilineExpanded: boolean;
}

export interface PhysicalTreeRow extends TreeRowBase {
  readonly kind: "physical";
}

export interface VirtualBranchOccurrenceRow extends TreeRowBase {
  readonly kind: "occurrence";
  readonly viewId: string;
  readonly hasChildren: false;
}

export type TreeRow = PhysicalTreeRow | VirtualBranchOccurrenceRow;

export interface VirtualBranchConfig {
  viewId: string;
  query: string;
  filters: PropertyFilter[];
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

export interface VirtualBranchState extends VirtualBranchConfigResult {
  queryError: string | null;
  count: number;
  completeness: BlockCollectionCompleteness | null;
  queried: boolean;
}

export interface VirtualBranchProjection {
  rows: TreeRow[];
  branchStates: Map<string, VirtualBranchState>;
}

export type VirtualBranchQueryEffect = (
  query: BlockSearchQuery,
) => Promise<VisibleBlockCollection>;

export function virtualBranchStateLabel(state: VirtualBranchState): string {
  const indicators = [`V:${state.count}`];
  if (state.completeness?.kind === "truncated") indicators.push("TRUNCATED");
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

function physicalTreeRow(block: VisibleBlock): PhysicalTreeRow {
  return {
    kind: "physical",
    rowId: block.id,
    canonicalId: block.id,
    block,
    depth: block.depth,
    hasChildren: block.hasChildren,
    multilineExpanded: block.multilineExpanded,
  };
}

export function buildPhysicalTreeRows(blocks: readonly VisibleBlock[]): PhysicalTreeRow[] {
  return blocks.map(physicalTreeRow);
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
      filters = parseFilter(query);
      if (filters.length === 0) configurationErrors.push("Virtual branch query cannot be empty");
    } catch (error) {
      configurationErrors.push(`Invalid virtual branch query: ${errorMessage(error)}`);
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
      const parsed = parseFilter(createProperty.value);
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

  const matchingTokens = parsePropertyTokens(text).filter(
    (token) => token.key === createProperty.key,
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

function initialBranchState(result: VirtualBranchConfigResult): VirtualBranchState {
  return {
    ...result,
    queryError: null,
    count: 0,
    completeness: null,
    queried: false,
  };
}

function occurrenceRows(
  definition: PhysicalTreeRow,
  matches: readonly VisibleBlock[],
  limit: number,
  ranks: readonly VirtualOccurrenceRank[],
): { rows: VirtualBranchOccurrenceRow[]; hasMore: boolean } {
  const definitionId = definition.canonicalId;
  const seenCanonicalIds = new Set<string>();
  const eligible: VisibleBlock[] = [];
  for (const block of matches) {
    if (block.id === definitionId || seenCanonicalIds.has(block.id)) continue;
    seenCanonicalIds.add(block.id);
    eligible.push(block);
  }
  const rankByBlockId = new Map(
    ranks
      .filter((entry) => entry.viewId === definitionId)
      .map((entry) => [entry.blockId, entry.rank]),
  );
  eligible.sort((left, right) => {
    const leftRank = rankByBlockId.get(left.id);
    const rightRank = rankByBlockId.get(right.id);
    if (leftRank === undefined && rightRank === undefined) return 0;
    if (leftRank === undefined) return 1;
    if (rightRank === undefined) return -1;
    return leftRank - rightRank || left.id.localeCompare(right.id);
  });
  return {
    rows: eligible.slice(0, limit).map((block) => ({
      kind: "occurrence",
      rowId: `occurrence:${definitionId}:${block.id}`,
      canonicalId: block.id,
      viewId: definitionId,
      block,
      depth: definition.depth + 1,
      hasChildren: false,
      multilineExpanded: block.multilineExpanded,
    })),
    hasMore: eligible.length > limit,
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
  queryBlocks: VirtualBranchQueryEffect,
  ranks: readonly VirtualOccurrenceRank[],
): Promise<ProjectedVirtualBranch> {
  const definitionId = definition.canonicalId;
  const parsed = parseVirtualBranchConfig(definition.block, physicalBlocks);
  const initialState = initialBranchState(parsed);
  if (!parsed.config || definition.block.collapsed) {
    return { definitionId, rows: [], state: initialState };
  }

  try {
    const result = await queryBlocks({
      filters: parsed.config.filters,
      limit: Math.max(1, physicalBlocks.length + 1),
    });
    const projected = occurrenceRows(
      definition,
      result.blocks,
      parsed.config.limit,
      ranks,
    );
    const completeness: BlockCollectionCompleteness =
      projected.hasMore || result.completeness.kind === "truncated"
        ? { kind: "truncated", limit: parsed.config.limit }
        : { kind: "complete" };
    return {
      definitionId,
      rows: projected.rows,
      state: {
        ...initialState,
        count: projected.rows.length,
        completeness,
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

export async function projectVirtualBranches(
  visibleBlocks: readonly VisibleBlock[],
  physicalBlocks: readonly VisibleBlock[],
  queryBlocks: VirtualBranchQueryEffect,
  ranks: readonly VirtualOccurrenceRank[] = [],
): Promise<VirtualBranchProjection> {
  const physicalRows = buildPhysicalTreeRows(visibleBlocks);
  const definitions = physicalRows.filter((row) => isVirtualBranchDefinition(row.block));
  const projected = await Promise.all(
    definitions.map((definition) =>
      projectVirtualBranch(definition, physicalBlocks, queryBlocks, ranks)
    ),
  );
  const branchStates = new Map<string, VirtualBranchState>();
  const occurrences = new Map<string, readonly VirtualBranchOccurrenceRow[]>();
  for (const branch of projected) {
    branchStates.set(branch.definitionId, branch.state);
    occurrences.set(branch.definitionId, branch.rows);
  }

  const rows: TreeRow[] = [];
  for (const physical of physicalRows) {
    rows.push(physical);
    rows.push(...(occurrences.get(physical.canonicalId) ?? []));
  }
  return { rows, branchStates };
}
