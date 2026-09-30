import { matchesFilters, normalizePropertyKey } from "./properties";
import { isPropertyKey, PROPERTY_KEY_SOURCE } from "./property-grammar";
import type {
  BlockProperty,
  BlockSearchQuery,
  PropertyFilter,
  PropertyQueryScope,
  PropertyRecord,
  QueryComparison,
  OutlinerRequestProblem,
  QueryExpression,
} from "./types";

export const MAX_BLOCK_QUERY_LIMIT = 1000;
const KEYED_RANGE = new RegExp(`^(${PROPERTY_KEY_SOURCE})(<=|>=|<|>)(.*)$`, "s");

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
  /** Request field whose text was parsed, set where a request field is parsed; `index` is within it. */
  field?: string;

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

export function normalizePropertyFilter(filter: PropertyFilter): PropertyFilter {
  if (!filter || typeof filter.key !== "string" || (filter.value !== undefined && typeof filter.value !== "string")) {
    throw new Error("Property filter requires a string key and optional string value");
  }
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
    return normalizePropertyFilter({ key, value });
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
    .map(normalizePropertyFilter)
    .map((filter) =>
      filter.value === undefined
        ? filter.key
        : `${filter.key}=${serializePropertyFilterValue(filter.value)}`,
    )
    .join(" ");
}

// ---------------------------------------------------------------------------
// Boolean query grammar (OR, NOT, grouping, created/updated ranges).
//
//   expression := or
//   or         := and ( OR and )*
//   and        := unary ( [AND] unary )*        juxtaposition is AND
//   unary      := NOT unary | primary
//   primary    := "(" expression ")" | range | clause
//   range      := (created | updated) (< | <= | > | >=) time
//
// Keywords are case-insensitive. Every clause keeps the existing presence and
// equality syntax, so a query without operators, parentheses or ranges parses
// to exactly the positive-AND filters it always meant. Those words and prefixes
// were syntax errors before, so no previously valid query changes meaning.
// ---------------------------------------------------------------------------

const MAX_QUERY_EXPRESSION_DEPTH = 32;
const MAX_QUERY_EXPRESSION_LEAVES = 200;
const COMPARISONS = new Set<QueryComparison>(["<", "<=", ">", ">="]);
const DAY_MS = 86_400_000;

/**
 * Structured detail for a rejected query. A syntax position is reported only with
 * the request field it indexes; syntax errors from other text (for example a
 * saved definition) carry just the message.
 */
export function queryRequestProblem(error: unknown): OutlinerRequestProblem | undefined {
  if (error instanceof BlockQuerySyntaxError) {
    return {
      code: "query-syntax", message: error.message,
      ...(error.field ? { field: error.field, position: error.index } : {}),
    };
  }
  if (error instanceof BlockQueryError) return { code: "query-invalid", message: error.message };
  return undefined;
}

export class BlockQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockQueryError";
  }
}

type ExpressionToken =
  | { kind: "lparen" | "rparen" | "and" | "or" | "not"; start: number }
  | { kind: "cmp"; op: QueryComparison; start: number }
  | { kind: "word"; text: string; start: number };

function lexQueryExpression(input: string): { tokens: ExpressionToken[]; simple: boolean } {
  const tokens: ExpressionToken[] = [];
  let depth = 0;
  let simple = true;
  for (const word of tokenizeFilterExpression(input)) {
    let text = word.text;
    let start = word.start;
    while (text.startsWith("(")) {
      tokens.push({ kind: "lparen", start });
      depth += 1;
      simple = false;
      text = text.slice(1);
      start += 1;
    }
    // A trailing ")" closes a group only while one is open and it does not
    // balance a "(" earlier in the same unquoted value, so `(k=f(x))` keeps
    // `f(x)`. At depth 0 it stays part of an unquoted value exactly as before.
    const closing = Math.min(depth, trailingUnbalancedParens(text));
    text = text.slice(0, text.length - closing);
    if (text) {
      const lower = text.toLowerCase();
      const keyedRange = KEYED_RANGE.exec(text);
      const bareRange = /^(<=|>=|<|>)(.*)$/s.exec(text);
      if (lower === "and" || lower === "or" || lower === "not") {
        tokens.push({ kind: lower, start });
        simple = false;
      } else if (keyedRange) {
        tokens.push({ kind: "word", text: keyedRange[1]!, start });
        tokens.push({ kind: "cmp", op: keyedRange[2] as QueryComparison, start: start + keyedRange[1]!.length });
        if (keyedRange[3]) tokens.push({ kind: "word", text: keyedRange[3], start: start + keyedRange[1]!.length + keyedRange[2]!.length });
        simple = false;
      } else if (bareRange) {
        tokens.push({ kind: "cmp", op: bareRange[1] as QueryComparison, start });
        if (bareRange[2]) tokens.push({ kind: "word", text: bareRange[2], start: start + bareRange[1]!.length });
        simple = false;
      } else {
        tokens.push({ kind: "word", text, start });
      }
    }
    for (let index = 0; index < closing; index += 1) {
      tokens.push({ kind: "rparen", start: start + text.length + index });
      depth -= 1;
    }
  }
  return { tokens, simple };
}

/** Count the trailing ")" in one clause that close no "(" of the clause itself (quotes excluded). */
function trailingUnbalancedParens(text: string): number {
  const unbalanced = new Set<number>();
  let open = 0;
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === "\\") index += 1;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "(") open += 1;
    else if (character === ")") {
      if (open > 0) open -= 1;
      else unbalanced.add(index);
    }
  }
  let count = 0;
  while (unbalanced.has(text.length - 1 - count)) count += 1;
  return count;
}

type ParsedTime = { kind: "instant"; at: (now: number) => number } | { kind: "day"; start: (now: number) => number };

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-](\d{2}):(\d{2}))?$/;

function utcDay(year: number, month: number, day: number): number | null {
  const start = Date.UTC(year, month - 1, day);
  const date = new Date(start);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? start : null;
}

function startOfUtcDay(now: number): number {
  return Math.floor(now / DAY_MS) * DAY_MS;
}

/** Parse a range value; relative values resolve against the evaluation time. */
export function parseQueryTime(value: string): ParsedTime {
  const normalized = value.trim().toLowerCase();
  const date = ISO_DATE.exec(normalized);
  if (date) {
    const start = utcDay(Number(date[1]), Number(date[2]), Number(date[3]));
    if (start === null) throw new BlockQueryError(`Invalid date: ${value}`);
    return { kind: "day", start: () => start };
  }
  const datetime = ISO_DATETIME.exec(value.trim());
  if (datetime) {
    const text = value.trim();
    // Date.parse rolls impossible fields over (2026-02-30 becomes March 2), so
    // validate the calendar day and clock fields first.
    const [, year, month, day, hour, minute, second = "0", zone, offsetHour = "0", offsetMinute = "0"] = datetime;
    if (utcDay(Number(year), Number(month), Number(day)) === null) throw new BlockQueryError(`Invalid date: ${value}`);
    if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 || Number(offsetHour) > 23 || Number(offsetMinute) > 59) {
      throw new BlockQueryError(`Invalid time: ${value}`);
    }
    const at = Date.parse(zone ? text : `${text}Z`);
    if (!Number.isFinite(at)) throw new BlockQueryError(`Invalid datetime: ${value}`);
    return { kind: "instant", at: () => at };
  }
  if (normalized === "now") return { kind: "instant", at: now => now };
  if (normalized === "today") return { kind: "day", start: now => startOfUtcDay(now) };
  if (normalized === "yesterday") return { kind: "day", start: now => startOfUtcDay(now) - DAY_MS };
  const relative = /^-(\d{1,6})([hdw])$/.exec(normalized);
  if (relative) {
    const unit = relative[2] === "h" ? 3_600_000 : relative[2] === "d" ? DAY_MS : 7 * DAY_MS;
    const offset = Number(relative[1]) * unit;
    return { kind: "instant", at: now => now - offset };
  }
  throw new BlockQueryError(
    `Invalid time value: ${value}; use YYYY-MM-DD, an ISO datetime, now, today, yesterday or -N followed by h, d or w`,
  );
}

class ExpressionParser {
  private index = 0;
  private leaves = 0;

  constructor(
    private readonly tokens: readonly ExpressionToken[],
    private readonly inputLength: number,
    private readonly rejectDeleted: boolean,
  ) {}

  parse(): QueryExpression {
    if (this.tokens.length === 0) syntaxError("Query cannot be empty", 0);
    const expression = this.parseOr(0);
    const extra = this.tokens[this.index];
    if (extra) syntaxError(extra.kind === "rparen" ? "Unmatched )" : "Unexpected query text", extra.start);
    return expression;
  }

  private peek(): ExpressionToken | undefined {
    return this.tokens[this.index];
  }

  private position(): number {
    return this.peek()?.start ?? this.inputLength;
  }

  private parseOr(depth: number): QueryExpression {
    const operands = [this.parseAnd(depth)];
    while (this.peek()?.kind === "or") {
      this.index += 1;
      operands.push(this.parseAnd(depth));
    }
    return operands.length === 1 ? operands[0]! : { kind: "or", operands };
  }

  private parseAnd(depth: number): QueryExpression {
    const operands = [this.parseUnary(depth)];
    for (;;) {
      const next = this.peek();
      if (!next || next.kind === "or" || next.kind === "rparen") break;
      if (next.kind === "and") this.index += 1;
      operands.push(this.parseUnary(depth));
    }
    return operands.length === 1 ? operands[0]! : { kind: "and", operands };
  }

  private parseUnary(depth: number): QueryExpression {
    const token = this.peek();
    if (token?.kind === "not") {
      this.index += 1;
      if (!this.startsOperand()) syntaxError("NOT requires a clause or group after it", this.position());
      return { kind: "not", operand: this.parseUnary(depth) };
    }
    return this.parsePrimary(depth);
  }

  private startsOperand(): boolean {
    const kind = this.peek()?.kind;
    return kind === "word" || kind === "lparen" || kind === "not";
  }

  private parsePrimary(depth: number): QueryExpression {
    const token = this.peek();
    if (!token) syntaxError("Expected a clause or group", this.inputLength);
    if (token.kind === "lparen") {
      if (depth >= MAX_QUERY_EXPRESSION_DEPTH) syntaxError("Query groups are nested too deeply", token.start);
      this.index += 1;
      if (this.peek()?.kind === "rparen") syntaxError("Empty group", token.start);
      const inner = this.parseOr(depth + 1);
      if (this.peek()?.kind !== "rparen") syntaxError("Unclosed (", token.start);
      this.index += 1;
      return inner;
    }
    if (token.kind === "cmp") syntaxError("A range needs created or updated before its comparison", token.start);
    if (token.kind !== "word") {
      syntaxError(`${token.kind.toUpperCase()} needs a clause before it`, token.start);
    }
    this.index += 1;
    if ((this.leaves += 1) > MAX_QUERY_EXPRESSION_LEAVES) syntaxError("Query has too many clauses", token.start);
    const comparison = this.peek();
    if (comparison?.kind === "cmp") {
      this.index += 1;
      const field = token.text.toLowerCase();
      if (field !== "created" && field !== "updated") {
        syntaxError("Range comparisons support only created and updated", token.start);
      }
      const value = this.peek();
      if (value?.kind !== "word") syntaxError(`${field} ${comparison.op} requires a time value`, value?.start ?? this.inputLength);
      this.index += 1;
      try {
        parseQueryTime(value.text);
      } catch (error) {
        syntaxError(error instanceof Error ? error.message : String(error), value.start);
      }
      return { kind: "time", field, op: comparison.op, value: value.text };
    }
    const clause = parsePropertyFilterClause(token.text, token.start);
    if (this.rejectDeleted && clause.key === "deleted") {
      syntaxError("deleted=true selects Trash and cannot be combined with OR, NOT, groups or ranges", token.start);
    }
    return { kind: "property", ...clause };
  }
}

/** Parse query text in the documented grammar into a boolean expression. */
export function parseQueryExpression(input: string): QueryExpression {
  const { tokens } = lexQueryExpression(input);
  return new ExpressionParser(tokens, input.length, true).parse();
}

/**
 * Parse saved or typed query text. Positive-AND clause lists stay flat filters
 * (preserving deleted=true and every existing meaning); anything using the
 * boolean grammar becomes a `where` expression.
 */
export function parseSearchExpression(input: string): { filters: PropertyFilter[]; where?: QueryExpression } {
  const { tokens, simple } = lexQueryExpression(input);
  if (simple) return { filters: parsePropertyFilterExpression(input) };
  return { filters: [], where: new ExpressionParser(tokens, input.length, true).parse() };
}

function normalizeQueryExpression(expression: QueryExpression, depth = 0, leaves = { count: 0 }): QueryExpression {
  if (!expression || typeof expression !== "object") throw new BlockQueryError("Query expression must be an object");
  if (depth > MAX_QUERY_EXPRESSION_DEPTH) throw new BlockQueryError("Query expression is nested too deeply");
  switch (expression.kind) {
    case "property": {
      if ((leaves.count += 1) > MAX_QUERY_EXPRESSION_LEAVES) throw new BlockQueryError("Query expression has too many clauses");
      const filter = normalizePropertyFilter({ key: expression.key, ...(expression.value === undefined ? {} : { value: expression.value }) });
      if (filter.key === "deleted") throw new BlockQueryError("deleted=true cannot appear inside a query expression; use filters or includeDeleted");
      return { kind: "property", ...filter };
    }
    case "time": {
      if ((leaves.count += 1) > MAX_QUERY_EXPRESSION_LEAVES) throw new BlockQueryError("Query expression has too many clauses");
      if (expression.field !== "created" && expression.field !== "updated") {
        throw new BlockQueryError(`Query range field must be created or updated: ${String(expression.field)}`);
      }
      if (!COMPARISONS.has(expression.op)) throw new BlockQueryError(`Query range comparison must be <, <=, > or >=: ${String(expression.op)}`);
      if (typeof expression.value !== "string") throw new BlockQueryError("Query range value must be a string");
      parseQueryTime(expression.value);
      return { kind: "time", field: expression.field, op: expression.op, value: expression.value.trim() };
    }
    case "not":
      return { kind: "not", operand: normalizeQueryExpression(expression.operand, depth + 1, leaves) };
    case "and":
    case "or": {
      if (!Array.isArray(expression.operands) || expression.operands.length === 0) {
        throw new BlockQueryError(`Query ${expression.kind} requires at least one operand`);
      }
      const operands = expression.operands.map(operand => normalizeQueryExpression(operand, depth + 1, leaves));
      return operands.length === 1 ? operands[0]! : { kind: expression.kind, operands };
    }
    default:
      throw new BlockQueryError(`Unknown query expression kind: ${String((expression as { kind?: unknown }).kind)}`);
  }
}

export interface QueryExpressionSubject {
  createdAt: string;
  updatedAt: string;
}

export type CompiledQueryExpression = (
  subject: QueryExpressionSubject,
  properties: readonly (BlockProperty | PropertyRecord)[],
  propertyScope?: PropertyQueryScope,
) => boolean;

/** Resolve relative times once, at `now`, and return a predicate over one block. */
export function compileQueryExpression(expression: QueryExpression, now = Date.now()): CompiledQueryExpression {
  switch (expression.kind) {
    case "property": {
      const filter = [{ key: expression.key, ...(expression.value === undefined ? {} : { value: expression.value }) }];
      return (_subject, properties, scope) => matchesFilters(properties, filter, scope);
    }
    case "time": {
      const time = parseQueryTime(expression.value);
      const field = expression.field === "created" ? "createdAt" : "updatedAt";
      let test: (at: number) => boolean;
      if (time.kind === "instant") {
        const bound = time.at(now);
        test = expression.op === "<" ? at => at < bound
          : expression.op === "<=" ? at => at <= bound
          : expression.op === ">" ? at => at > bound
          : at => at >= bound;
      } else {
        // A day is an interval: > D starts after that day, <= D includes all of it.
        const start = time.start(now);
        const end = start + DAY_MS;
        test = expression.op === "<" ? at => at < start
          : expression.op === "<=" ? at => at < end
          : expression.op === ">" ? at => at >= end
          : at => at >= start;
      }
      return subject => {
        const at = Date.parse(subject[field]);
        return Number.isFinite(at) && test(at);
      };
    }
    case "not": {
      const operand = compileQueryExpression(expression.operand, now);
      return (subject, properties, scope) => !operand(subject, properties, scope);
    }
    case "and": {
      const operands = expression.operands.map(operand => compileQueryExpression(operand, now));
      return (subject, properties, scope) => operands.every(operand => operand(subject, properties, scope));
    }
    case "or": {
      const operands = expression.operands.map(operand => compileQueryExpression(operand, now));
      return (subject, properties, scope) => operands.some(operand => operand(subject, properties, scope));
    }
  }
}

/** Property clauses that can contribute match context (not under NOT). */
export function positivePropertyFilters(expression: QueryExpression): PropertyFilter[] {
  switch (expression.kind) {
    case "property": return [{ key: expression.key, ...(expression.value === undefined ? {} : { value: expression.value }) }];
    case "time":
    case "not": return [];
    default: return expression.operands.flatMap(positivePropertyFilters);
  }
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

  if (query.expression !== undefined && typeof query.expression !== "string") {
    throw new Error("Block search expression must be a string");
  }
  const parts: QueryExpression[] = [];
  // Plain clause lists keep their filter meaning, including deleted=true.
  let parsedExpression: ReturnType<typeof parseSearchExpression> | null = null;
  try {
    parsedExpression = query.expression?.trim() ? parseSearchExpression(query.expression) : null;
  } catch (error) {
    if (error instanceof BlockQuerySyntaxError) error.field = "expression";
    throw error;
  }
  if (parsedExpression?.where) parts.push(parsedExpression.where);
  if (query.where !== undefined) parts.push(normalizeQueryExpression(query.where));
  const where = parts.length === 0 ? undefined
    : parts.length === 1 ? parts[0]! : { kind: "and" as const, operands: parts };

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
  for (const candidate of [...(query.filters ?? []), ...(parsedExpression?.filters ?? [])]) {
    const filter = normalizePropertyFilter(candidate);
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
    ...(where ? { where } : {}),
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
    if (prefix && !isPropertyKey(prefix)) return null;
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
