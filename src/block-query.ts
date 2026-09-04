import { normalizePropertyKey } from "./properties";
import type { BlockSearchQuery, PropertyFilter, PropertyQueryScope } from "./types";

export const MAX_BLOCK_QUERY_LIMIT = 1000;

const BOOLEAN_OPERATORS = new Set(["and", "not", "or"]);
const PROPERTY_QUERY_SCOPES = new Set<PropertyQueryScope>([
  "block",
  "line",
  "inline",
  "all",
]);

export function normalizePropertyQueryScope(value: unknown): PropertyQueryScope {
  if (typeof value !== "string" || !PROPERTY_QUERY_SCOPES.has(value as PropertyQueryScope)) {
    throw new Error(`Invalid property scope: ${String(value)}`);
  }
  return value as PropertyQueryScope;
}


export class BlockQuerySyntaxError extends Error {
  constructor(
    message: string,
    readonly index: number,
  ) {
    super(`${message} at character ${index + 1}`);
    this.name = "BlockQuerySyntaxError";
  }
}

export interface FilterCompletionTarget {
  kind: "key" | "value";
  start: number;
  end: number;
  prefix: string;
  key?: string;
}

function syntaxError(message: string, index: number): never {
  throw new BlockQuerySyntaxError(message, index);
}

function separatorIn(clause: string): { index: number; length: number } | null {
  const equals = clause.indexOf("=");
  const doubleColon = clause.indexOf("::");
  if (equals < 0 && doubleColon < 0) return null;
  if (equals < 0) return { index: doubleColon, length: 2 };
  if (doubleColon < 0) return { index: equals, length: 1 };
  return equals < doubleColon
    ? { index: equals, length: 1 }
    : { index: doubleColon, length: 2 };
}

function normalizeFilterValue(value: string, key: string): string {
  const normalized = value.trim();
  if (!normalized)
    throw new Error(`Property filter value cannot be empty: ${key}`);
  if (/[\]\r\n]/.test(normalized)) {
    throw new Error(
      `Property filter value cannot contain ], CR, or LF: ${key}`,
    );
  }
  return normalized;
}

function normalizeFilter(filter: PropertyFilter): PropertyFilter {
  const key = normalizePropertyKey(filter.key);
  if (BOOLEAN_OPERATORS.has(key)) {
    throw new Error(
      `Boolean operator is not supported in block filters: ${filter.key}`,
    );
  }
  return filter.value === undefined
    ? { key }
    : { key, value: normalizeFilterValue(filter.value, key) };
}

function parseQuotedValue(raw: string, offset: number): string {
  let value = "";
  for (let index = 1; index < raw.length; index += 1) {
    const character = raw[index]!;
    if (character === '"') {
      if (raw.slice(index + 1).trim()) {
        syntaxError(
          "Unexpected text after quoted filter value",
          offset + index + 1,
        );
      }
      return value;
    }
    if (character !== "\\") {
      value += character;
      continue;
    }
    const escaped = raw[index + 1];
    if (escaped !== "\\" && escaped !== '"') {
      syntaxError('Only \\\\ and \\" escapes are supported', offset + index);
    }
    value += escaped;
    index += 1;
  }
  syntaxError("Unterminated quoted filter value", offset);
}

export function parsePropertyFilterClause(
  input: string,
  offset = 0,
): PropertyFilter {
  const clause = input.trim();
  const leadingWhitespace = input.length - input.trimStart().length;
  const clauseOffset = offset + leadingWhitespace;
  if (!clause)
    syntaxError("Property filter clause cannot be empty", clauseOffset);

  const separator = separatorIn(clause);
  const rawKey = separator ? clause.slice(0, separator.index).trim() : clause;
  let key: string;
  try {
    key = normalizePropertyKey(rawKey);
  } catch {
    syntaxError(
      `Invalid property filter key: ${rawKey || "(empty)"}`,
      clauseOffset,
    );
  }
  if (BOOLEAN_OPERATORS.has(key)) {
    syntaxError(`Boolean operator ${rawKey} is not supported`, clauseOffset);
  }
  if (!separator) {
    if (/\s/.test(clause))
      syntaxError(
        "Property presence filter cannot contain whitespace",
        clauseOffset,
      );
    return { key };
  }

  const valueOffset = clauseOffset + separator.index + separator.length;
  const rawValue = clause.slice(separator.index + separator.length).trim();
  if (!rawValue)
    syntaxError(`Property filter value cannot be empty: ${key}`, valueOffset);
  const value = rawValue.startsWith('"')
    ? parseQuotedValue(
        rawValue,
        valueOffset +
          clause.slice(separator.index + separator.length).indexOf(rawValue),
      )
    : rawValue;
  try {
    return normalizeFilter({ key, value });
  } catch (error) {
    syntaxError(
      error instanceof Error ? error.message : String(error),
      valueOffset,
    );
  }
}

interface FilterToken {
  text: string;
  start: number;
}

function tokenizeFilterExpression(input: string): FilterToken[] {
  const tokens: FilterToken[] = [];
  let start = -1;
  let quoteStart = -1;
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (start < 0) {
      if (/\s/.test(character)) continue;
      start = index;
    }
    if (quoteStart >= 0) {
      if (escaped) {
        if (character !== "\\" && character !== '"') {
          syntaxError('Only \\\\ and \\" escapes are supported', index - 1);
        }
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        quoteStart = -1;
      }
      continue;
    }
    if (character === '"') {
      quoteStart = index;
      continue;
    }
    if (/\s/.test(character)) {
      tokens.push({ text: input.slice(start, index), start });
      start = -1;
    }
  }

  if (escaped)
    syntaxError("Dangling escape in quoted filter value", input.length - 1);
  if (quoteStart >= 0)
    syntaxError("Unterminated quoted filter value", quoteStart);
  if (start >= 0) tokens.push({ text: input.slice(start), start });
  return tokens;
}

export function parsePropertyFilterExpression(input: string): PropertyFilter[] {
  return tokenizeFilterExpression(input).map((token) =>
    parsePropertyFilterClause(token.text, token.start),
  );
}

export function serializePropertyFilterValue(value: string): string {
  const normalized = normalizeFilterValue(value, "value");
  if (!/[\s"\\]/.test(normalized)) return normalized;
  return `"${normalized.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function serializePropertyFilters(
  filters: readonly PropertyFilter[],
): string {
  return filters
    .map(normalizeFilter)
    .map((filter) =>
      filter.value === undefined
        ? filter.key
        : `${filter.key}=${serializePropertyFilterValue(filter.value)}`,
    )
    .join(" ");
}

export function normalizeBlockSearchQuery(
  query: BlockSearchQuery,
): BlockSearchQuery {
  if (!query || typeof query !== "object")
    throw new Error("Block search query is required");
  if (
    typeof query.limit !== "number" ||
    !Number.isInteger(query.limit) ||
    query.limit < 1 ||
    query.limit > MAX_BLOCK_QUERY_LIMIT
  ) {
    throw new Error(
      `Block search limit must be an integer from 1 through ${MAX_BLOCK_QUERY_LIMIT}`,
    );
  }
  if (query.filters !== undefined && !Array.isArray(query.filters)) {
    throw new Error("Block search filters must be an array");
  }
  for (const [index, filter] of (query.filters ?? []).entries()) {
    if (
      !filter ||
      typeof filter !== "object" ||
      typeof filter.key !== "string"
    ) {
      throw new Error(`Block search filter ${index + 1} requires a string key`);
    }
    if (filter.value !== undefined && typeof filter.value !== "string") {
      throw new Error(
        `Block search filter ${index + 1} value must be a string`,
      );
    }
  }
  for (const [field, value] of [
    ["text", query.text],
    ["subtreeRootId", query.subtreeRootId],
    ["rankViewId", query.rankViewId],
  ] as const) {
    if (value !== undefined && typeof value !== "string") {
      throw new Error(`Block search ${field} must be a string`);
    }
  }

  let sort: BlockSearchQuery["sort"];
  if (query.sort !== undefined) {
    if (!query.sort || typeof query.sort !== "object" || Array.isArray(query.sort)) {
      throw new Error("Block search sort must be an object");
    }
    if (query.sort.field !== "created" && query.sort.field !== "updated") {
      throw new Error(`Block search sort field must be created or updated: ${String(query.sort.field)}`);
    }
    if (query.sort.direction !== "asc" && query.sort.direction !== "desc") {
      throw new Error(
        `Block search sort direction must be asc or desc: ${String(query.sort.direction)}`,
      );
    }
    sort = { field: query.sort.field, direction: query.sort.direction };
  }

  const filters: PropertyFilter[] = [];
  const seen = new Set<string>();
  let includeDeleted = query.includeDeleted;
  for (const candidate of query.filters ?? []) {
    const filter = normalizeFilter(candidate);
    if (filter.key === "deleted" && filter.value?.toLowerCase() === "true") {
      includeDeleted ??= "roots";
      continue;
    }
    const identity = `${filter.key}\0${filter.value === undefined ? "presence" : `value:${filter.value.toLowerCase()}`}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    filters.push(filter);
  }

  if (
    includeDeleted !== undefined &&
    includeDeleted !== "roots" &&
    includeDeleted !== "all"
  ) {
    throw new Error(`Invalid deleted-content mode: ${String(includeDeleted)}`);
  }
  const text = query.text?.trim() || undefined;
  const subtreeRootId = query.subtreeRootId?.trim() || undefined;
  const rankViewId = query.rankViewId?.trim() || undefined;
  const propertyScope = query.propertyScope === undefined
    ? undefined
    : normalizePropertyQueryScope(query.propertyScope);
  if (rankViewId && sort) {
    throw new Error("Block search cannot combine rankViewId with timestamp sorting");
  }

  return {
    ...(filters.length > 0 ? { filters } : {}),
    ...(text ? { text } : {}),
    ...(subtreeRootId ? { subtreeRootId } : {}),
    ...(rankViewId ? { rankViewId } : {}),
    ...(propertyScope ? { propertyScope } : {}),
    ...(includeDeleted ? { includeDeleted } : {}),
    ...(sort ? { sort } : {}),
    limit: query.limit,
  };
}

function clauseRangeAtCursor(
  input: string,
  cursor: number,
): { start: number; end: number } {
  const boundedCursor = Math.max(0, Math.min(cursor, input.length));
  let start = 0;
  let quote = false;
  let escaped = false;
  for (let index = 0; index < boundedCursor; index += 1) {
    const character = input[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quote = false;
    } else if (character === '"') quote = true;
    else if (/\s/.test(character)) start = index + 1;
  }

  let end = input.length;
  quote = false;
  escaped = false;
  for (let index = start; index < input.length; index += 1) {
    const character = input[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quote = false;
    } else if (character === '"') quote = true;
    else if (/\s/.test(character)) {
      end = index;
      break;
    }
  }
  return { start, end };
}

function partialValuePrefix(raw: string): string {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith('"')) return trimmed;
  let result = "";
  for (let index = 1; index < trimmed.length; index += 1) {
    const character = trimmed[index]!;
    if (character === '"') break;
    if (character === "\\" && index + 1 < trimmed.length) {
      const escaped = trimmed[index + 1]!;
      if (escaped === "\\" || escaped === '"') {
        result += escaped;
        index += 1;
        continue;
      }
    }
    result += character;
  }
  return result;
}

export function filterCompletionTargetAtCursor(
  input: string,
  cursor: number,
): FilterCompletionTarget | null {
  const range = clauseRangeAtCursor(input, cursor);
  const beforeCursor = input.slice(
    range.start,
    Math.max(range.start, Math.min(cursor, input.length)),
  );
  const separator = separatorIn(beforeCursor);
  if (!separator) {
    const prefix = beforeCursor.trim();
    if (prefix && !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(prefix)) return null;
    return {
      kind: "key",
      start: range.start,
      end: range.end,
      prefix: prefix.toLowerCase(),
    };
  }

  const rawKey = beforeCursor.slice(0, separator.index).trim();
  let key: string;
  try {
    key = normalizePropertyKey(rawKey);
  } catch {
    return null;
  }
  const rawValue = beforeCursor.slice(separator.index + separator.length);
  return {
    kind: "value",
    start: range.start,
    end: range.end,
    key,
    prefix: partialValuePrefix(rawValue),
  };
}
