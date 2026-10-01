import { createHash } from "node:crypto";
import type { ExtensionHandler, ExtensionOptionSpec } from "./extension-manifest";
import type { BoundHandler } from "./extension-registry";
import { parsePropertyDirectiveLines } from "./properties";

/**
 * Handler lines: `key:: [argument] [--option[=value]]` for a key an
 * extension serves (one grammar for every extension; the extension never
 * parses its own line). The host checks the argument and the options against
 * the manifest and hands the extension typed values.
 *
 * - **fetch** options (the default scope) are part of the call: two lines that
 *   differ by one are two calls.
 * - **display** options never reach the extension: lines that differ only by
 *   one share a result (PIE-445's thrash rule).
 * - An unknown `--flag` is a warning, not a failure.
 */

export type OptionValue = boolean | number | string;

export interface HandlerCall {
  readonly extensionId: string;
  readonly handlerKey: string;
  readonly kind: ExtensionHandler["kind"];
  readonly effects: ExtensionHandler["effects"];
  /** The words that aren't options, or null when there are none. */
  readonly argument: string | null;
  readonly options: Readonly<Record<string, OptionValue>>;
  readonly display: Readonly<Record<string, OptionValue>>;
  readonly unknown: readonly string[];
  /** Why the line can't run as written; empty when it can. */
  readonly problems: readonly string[];
  /** Whether the argument (a data handler's key) is well formed, whatever the options say. */
  readonly argumentOk: boolean;
  /** Identifies the call within its block: handler, argument and fetch options. */
  readonly callKey: string;
  readonly line: number;
  readonly start: number;
  readonly end: number;
  readonly indent: string;
}

export interface HandlerTable {
  handler(key: string): BoundHandler | undefined;
  handlerKeys(): ReadonlySet<string>;
}

const MAX_CALLS = 16;

function optionValue(name: string, spec: ExtensionOptionSpec, raw: string | undefined): OptionValue | string[] {
  if (spec.type === "boolean") {
    if (raw === undefined || raw === "true") return true;
    if (raw === "false") return false;
    return [`--${name} takes true or false`];
  }
  if (raw === undefined) {
    if (spec.default !== undefined && typeof spec.default !== "boolean") return spec.default;
    return [`--${name} needs a value (--${name}=…)`];
  }
  if (spec.type === "integer") {
    if (!/^-?[0-9]{1,9}$/.test(raw)) return [`--${name} takes a whole number`];
    const value = Number(raw);
    if (spec.min !== undefined && value < spec.min) return [`--${name} is at least ${spec.min}`];
    if (spec.max !== undefined && value > spec.max) return [`--${name} is at most ${spec.max}`];
    return value;
  }
  if (raw.length > 200) return [`--${name} is longer than 200 characters`];
  if (spec.pattern && !new RegExp(spec.pattern, "u").test(raw)) return [`--${name} doesn't match ${spec.pattern}`];
  return raw;
}

/** The handler lines in a block's text that a registered extension serves, in order. */
export function handlerCalls(text: string, table: HandlerTable): HandlerCall[] {
  const keys = table.handlerKeys();
  if (!keys.size || !text.includes("::")) return [];
  const calls: HandlerCall[] = [];
  for (const line of parsePropertyDirectiveLines(text, keys)) {
    const bound = table.handler(line.key);
    if (!bound || bound.handler.kind === "resource") continue;
    const { handler, extension } = bound;
    const words = line.value.split(/[ \t]+/).filter(Boolean);
    const positional: string[] = [];
    const options: Record<string, OptionValue> = {};
    const display: Record<string, OptionValue> = {};
    const unknown: string[] = [];
    const problems: string[] = [];
    for (const word of words) {
      const option = /^--([a-z][a-z0-9-]{0,31})(?:=(.*))?$/.exec(word);
      if (!option) {
        positional.push(word);
        continue;
      }
      const spec = handler.options?.[option[1]!];
      if (!spec) {
        unknown.push(word);
        continue;
      }
      const value = optionValue(option[1]!, spec, option[2]);
      if (Array.isArray(value)) problems.push(...value);
      else (spec.scope === "display" ? display : options)[option[1]!] = value;
    }
    for (const [name, spec] of Object.entries(handler.options ?? {})) {
      const target = spec.scope === "display" ? display : options;
      if (target[name] === undefined && spec.default !== undefined) target[name] = spec.default;
    }
    const argument = positional.length ? positional.join(" ") : null;
    const name = handler.argument?.name ?? "an argument";
    const argumentProblems: string[] = [];
    if (argument === null && (handler.argument?.required || handler.kind === "data")) argumentProblems.push(`${handler.key}:: needs ${name}`);
    const pattern = handler.kind === "data" ? handler.keyPattern ?? handler.argument?.pattern : handler.argument?.pattern;
    if (argument !== null && pattern && !new RegExp(pattern, "u").test(argument)) argumentProblems.push(`${argument} isn't ${handler.argument?.description ?? `a ${name} ${handler.key}:: knows`}`);
    if (argument !== null && argument.length > 500) argumentProblems.push(`${name} is longer than 500 characters`);
    problems.push(...argumentProblems);
    const sorted = Object.fromEntries(Object.entries(options).sort(([left], [right]) => left.localeCompare(right)));
    calls.push({
      extensionId: extension.id,
      handlerKey: handler.key,
      kind: handler.kind,
      effects: handler.effects,
      argument,
      options: sorted,
      display,
      unknown,
      problems,
      argumentOk: argumentProblems.length === 0,
      callKey: createHash("sha256").update(JSON.stringify([handler.key, argument, sorted])).digest("hex").slice(0, 32),
      line: line.line,
      start: line.start,
      end: line.end,
      indent: line.indent,
    });
    if (calls.length >= MAX_CALLS) break;
  }
  return calls;
}

/** Cheap guard for readers: could this text hold a handler line (any `key::` line)? The service decides. */
export function mayHaveHandlerLines(text: string): boolean {
  return text.includes("::") && /^[ \t]*(?:[-*+][ \t]+)?[A-Za-z][A-Za-z0-9_.-]*::/m.test(text);
}
