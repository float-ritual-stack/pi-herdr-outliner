import { cleanExtensionText, inertBlockdown } from "./extension-records";

/**
 * The shared primitive catalogue a rich component (kind 3 of the extension
 * design) is composed from, and its render targets.
 *
 * A component is headless: its **data** is the truth, and its **view** is a
 * tree of primitives every client already knows how to draw (box, card,
 * table, stat, bar, checklist, sparkline, badge, text, with stack and row to
 * arrange them). So a new component needs no client code. The service renders
 * the text targets here (markdown, blockdown, html, json, csv and a plain
 * `terminal` text); a client that draws primitives natively (the door) takes
 * `view` instead.
 *
 * Fallback chain, for one target:
 *   1. the component's own rendering for that target (`targets`, an escape hatch);
 *   2. the version composed from its primitives;
 *   3. the fallback the *requester* names (default `json`: the data itself).
 * An unknown primitive never breaks a reader: it degrades to its text.
 */

export const PRIMITIVE_TYPES = ["text", "badge", "stat", "bar", "table", "checklist", "sparkline", "card", "box", "stack", "row"] as const;
export type PrimitiveType = typeof PRIMITIVE_TYPES[number];
export const RENDER_TARGETS = ["terminal", "markdown", "blockdown", "html", "json", "csv"] as const;
export type RenderTarget = typeof RENDER_TARGETS[number];
export const TONES = ["default", "good", "warn", "bad", "dim", "accent"] as const;
export type Tone = typeof TONES[number];

export type Primitive =
  | { type: "text"; text: string; tone?: Tone; strong?: boolean }
  | { type: "badge"; label: string; tone?: Tone }
  | { type: "stat"; label: string; value: string | number; unit?: string; tone?: Tone }
  | { type: "bar"; label: string; value: number; max: number; tone?: Tone }
  /** `links`: a block id per row (or null) that a client opens on Enter or a click. */
  | { type: "table"; columns: string[]; rows: (string | number)[][]; links?: (string | null)[] }
  | { type: "checklist"; items: { label: string; done: boolean }[] }
  | { type: "sparkline"; label?: string; values: number[] }
  | { type: "card"; title: string; subtitle?: string; badge?: { label: string; tone?: Tone }; link?: string; children?: Primitive[] }
  | { type: "box"; title?: string; children: Primitive[] }
  | { type: "stack"; children: Primitive[] }
  | { type: "row"; children: Primitive[] };

export interface ComponentOutput {
  /** The truth: what `json` (and `csv`, for rows) returns. */
  readonly data: unknown;
  readonly view: Primitive;
  /** Escape hatch: the component's own rendering for some targets. */
  readonly targets?: Partial<Record<RenderTarget, string>>;
}

export interface RenderedComponent {
  readonly target: RenderTarget;
  readonly body: string;
  /** Which step of the fallback chain answered. */
  readonly via: "component" | "primitives" | "fallback";
  readonly contentType: string;
}

const MAX_DEPTH = 8;
const MAX_NODES = 400;
const MAX_TEXT = 2_000;
const MAX_CHILDREN = 100;
const MAX_ROWS = 200;
const MAX_COLUMNS = 12;
const MAX_VALUES = 200;
const MAX_DATA_BYTES = 256 * 1024;
const BLOCK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CONTENT_TYPES: Record<RenderTarget, string> = {
  terminal: "text/plain; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  blockdown: "text/blockdown; charset=utf-8",
  html: "text/html; charset=utf-8",
  json: "application/json",
  csv: "text/csv; charset=utf-8",
};

export class ComponentError extends Error {}

function fail(path: string, message: string): never {
  throw new ComponentError(`${path || "view"} ${message}`);
}

function text(value: unknown, path: string, optional = false): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string") fail(path, "must be text");
  if (value.length > MAX_TEXT) fail(path, `is longer than ${MAX_TEXT} characters`);
  // Kept clean: terminal escapes and control characters never reach a reader (the door's own drawing, `terminal`).
  return cleanExtensionText(value, true);
}

function finite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "must be a number");
  return value;
}

function tone(value: unknown, path: string): Tone | undefined {
  if (value === undefined) return undefined;
  if (!TONES.includes(value as Tone)) fail(path, `must be one of ${TONES.join(", ")}`);
  return value as Tone;
}

function only(object: Record<string, unknown>, keys: readonly string[], path: string): void {
  for (const key of Object.keys(object)) if (!keys.includes(key)) fail(path, `has a field it doesn't know: ${key}`);
}

/** Checks a view tree against the catalogue and its bounds; returns a clean copy. */
export function validatePrimitive(value: unknown, path = "view", depth = 0, count = { nodes: 0 }): Primitive {
  if (depth > MAX_DEPTH) fail(path, `nests deeper than ${MAX_DEPTH}`);
  if (++count.nodes > MAX_NODES) fail(path, `has more than ${MAX_NODES} primitives`);
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "must be a primitive object");
  const node = value as Record<string, unknown>;
  const children = (key = "children"): Primitive[] => {
    const list = node[key];
    if (!Array.isArray(list)) fail(`${path}.${key}`, "must be a list");
    if (list.length > MAX_CHILDREN) fail(`${path}.${key}`, `has more than ${MAX_CHILDREN} items`);
    return list.map((child, index) => validatePrimitive(child, `${path}.${key}[${index}]`, depth + 1, count));
  };
  switch (node.type) {
    case "text":
      only(node, ["type", "text", "tone", "strong"], path);
      if (node.strong !== undefined && typeof node.strong !== "boolean") fail(`${path}.strong`, "must be true or false");
      return { type: "text", text: text(node.text, `${path}.text`)!, ...(tone(node.tone, `${path}.tone`) ? { tone: node.tone as Tone } : {}), ...(node.strong ? { strong: true } : {}) };
    case "badge":
      only(node, ["type", "label", "tone"], path);
      return { type: "badge", label: text(node.label, `${path}.label`)!, ...(tone(node.tone, `${path}.tone`) ? { tone: node.tone as Tone } : {}) };
    case "stat": {
      only(node, ["type", "label", "value", "unit", "tone"], path);
      const statValue = typeof node.value === "number" ? finite(node.value, `${path}.value`) : text(node.value, `${path}.value`)!;
      return { type: "stat", label: text(node.label, `${path}.label`)!, value: statValue,
        ...(node.unit !== undefined ? { unit: text(node.unit, `${path}.unit`)! } : {}),
        ...(tone(node.tone, `${path}.tone`) ? { tone: node.tone as Tone } : {}) };
    }
    case "bar": {
      only(node, ["type", "label", "value", "max", "tone"], path);
      const max = finite(node.max, `${path}.max`);
      if (max <= 0) fail(`${path}.max`, "must be more than 0");
      return { type: "bar", label: text(node.label, `${path}.label`)!, value: finite(node.value, `${path}.value`), max,
        ...(tone(node.tone, `${path}.tone`) ? { tone: node.tone as Tone } : {}) };
    }
    case "table": {
      only(node, ["type", "columns", "rows", "links"], path);
      if (!Array.isArray(node.columns) || node.columns.length === 0 || node.columns.length > MAX_COLUMNS) fail(`${path}.columns`, `must list 1 to ${MAX_COLUMNS} columns`);
      const columns = node.columns.map((column, index) => text(column, `${path}.columns[${index}]`)!);
      if (!Array.isArray(node.rows) || node.rows.length > MAX_ROWS) fail(`${path}.rows`, `must be a list of at most ${MAX_ROWS} rows`);
      const rows = node.rows.map((row, index) => {
        if (!Array.isArray(row) || row.length !== columns.length) fail(`${path}.rows[${index}]`, `must have ${columns.length} cells`);
        return row.map((cell, column) => typeof cell === "number" ? finite(cell, `${path}.rows[${index}][${column}]`) : text(cell, `${path}.rows[${index}][${column}]`)!);
      });
      let links: (string | null)[] | undefined;
      if (node.links !== undefined) {
        if (!Array.isArray(node.links) || node.links.length !== rows.length) fail(`${path}.links`, "must have one entry per row");
        links = node.links.map((link, index) => {
          if (link === null) return null;
          if (typeof link !== "string" || !BLOCK_ID.test(link)) fail(`${path}.links[${index}]`, "must be a block id or null");
          return link;
        });
      }
      return { type: "table", columns, rows, ...(links ? { links } : {}) };
    }
    case "checklist": {
      only(node, ["type", "items"], path);
      if (!Array.isArray(node.items) || node.items.length > MAX_ROWS) fail(`${path}.items`, `must be a list of at most ${MAX_ROWS} items`);
      return { type: "checklist", items: node.items.map((item, index) => {
        if (!item || typeof item !== "object") fail(`${path}.items[${index}]`, "must be { label, done }");
        const entry = item as Record<string, unknown>;
        only(entry, ["label", "done"], `${path}.items[${index}]`);
        if (typeof entry.done !== "boolean") fail(`${path}.items[${index}].done`, "must be true or false");
        return { label: text(entry.label, `${path}.items[${index}].label`)!, done: entry.done };
      }) };
    }
    case "sparkline": {
      only(node, ["type", "label", "values"], path);
      if (!Array.isArray(node.values) || node.values.length === 0 || node.values.length > MAX_VALUES) fail(`${path}.values`, `must list 1 to ${MAX_VALUES} numbers`);
      return { type: "sparkline", ...(node.label !== undefined ? { label: text(node.label, `${path}.label`)! } : {}),
        values: node.values.map((entry, index) => finite(entry, `${path}.values[${index}]`)) };
    }
    case "card": {
      only(node, ["type", "title", "subtitle", "badge", "link", "children"], path);
      let badge: { label: string; tone?: Tone } | undefined;
      if (node.badge !== undefined) {
        if (!node.badge || typeof node.badge !== "object") fail(`${path}.badge`, "must be { label, tone? }");
        const raw = node.badge as Record<string, unknown>;
        only(raw, ["label", "tone"], `${path}.badge`);
        badge = { label: text(raw.label, `${path}.badge.label`)!, ...(tone(raw.tone, `${path}.badge.tone`) ? { tone: raw.tone as Tone } : {}) };
      }
      if (node.link !== undefined && (typeof node.link !== "string" || !BLOCK_ID.test(node.link))) fail(`${path}.link`, "must be a block id");
      return { type: "card", title: text(node.title, `${path}.title`)!,
        ...(node.subtitle !== undefined ? { subtitle: text(node.subtitle, `${path}.subtitle`)! } : {}),
        ...(badge ? { badge } : {}),
        ...(node.link !== undefined ? { link: node.link as string } : {}),
        ...(node.children !== undefined ? { children: children() } : {}) };
    }
    case "box":
      only(node, ["type", "title", "children"], path);
      return { type: "box", ...(node.title !== undefined ? { title: text(node.title, `${path}.title`)! } : {}), children: children() };
    case "stack":
    case "row":
      only(node, ["type", "children"], path);
      return { type: node.type, children: children() };
    default:
      fail(`${path}.type`, `must be one of ${PRIMITIVE_TYPES.join(", ")}`);
  }
}

/** Checks a component handler's result: `{ data, view, targets? }`. */
export function validateComponent(value: unknown): ComponentOutput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ComponentError("a component returns { data, view }");
  const raw = value as Record<string, unknown>;
  if (!("data" in raw)) throw new ComponentError("a component returns data (the truth its view shows)");
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(raw.data ?? null));
  } catch {
    throw new ComponentError("data must be plain JSON");
  }
  if (size > MAX_DATA_BYTES) throw new ComponentError("data is larger than 256 KiB");
  const view = validatePrimitive(raw.view);
  let targets: Partial<Record<RenderTarget, string>> | undefined;
  if (raw.targets !== undefined) {
    if (!raw.targets || typeof raw.targets !== "object" || Array.isArray(raw.targets)) throw new ComponentError("targets must map a target to its text");
    targets = {};
    for (const [target, body] of Object.entries(raw.targets as Record<string, unknown>)) {
      if (!RENDER_TARGETS.includes(target as RenderTarget)) throw new ComponentError(`targets.${target} is not a render target (${RENDER_TARGETS.join(", ")})`);
      if (typeof body !== "string" || Buffer.byteLength(body) > MAX_DATA_BYTES) throw new ComponentError(`targets.${target} must be text up to 256 KiB`);
      targets[target as RenderTarget] = cleanExtensionText(body, true);
    }
  }
  return { data: raw.data ?? null, view, ...(targets ? { targets } : {}) };
}

// ── Renderers ────────────────────────────────────────────────────────────

const SPARKS = "▁▂▃▄▅▆▇█";

function sparkline(values: readonly number[]): string {
  const low = Math.min(...values);
  const high = Math.max(...values);
  return values.map((value) => SPARKS[high === low ? 3 : Math.round(((value - low) / (high - low)) * (SPARKS.length - 1))]).join("");
}

function meter(value: number, max: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round((value / max) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

const statText = (node: Extract<Primitive, { type: "stat" }>) => `${node.value}${node.unit ? ` ${node.unit}` : ""}`;
const cell = (value: string | number) => String(value);
/** One line, no control characters: what a terminal cell may hold. */
const oneLine = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ");

/** Plain terminal text: no colour, so any client can show it; the door draws `view` itself. */
function terminalLines(node: Primitive): string[] {
  switch (node.type) {
    case "text": return oneLine(node.text).split(/\n/);
    case "badge": return [`[${oneLine(node.label)}]`];
    case "stat": return [`${oneLine(node.label)}  ${oneLine(statText(node))}`];
    case "bar": return [`${oneLine(node.label)}  ${meter(node.value, node.max)}  ${node.value}/${node.max}`];
    case "sparkline": return [`${node.label ? `${oneLine(node.label)}  ` : ""}${sparkline(node.values)}`];
    case "checklist": return node.items.map((item) => `[${item.done ? "x" : " "}] ${oneLine(item.label)}`);
    case "table": {
      const all = [node.columns, ...node.rows.map((row) => row.map(cell))].map((row) => row.map(oneLine));
      const widths = node.columns.map((_, index) => Math.max(...all.map((row) => row[index]!.length)));
      const line = (row: string[]) => row.map((value, index) => value.padEnd(widths[index]!)).join("  ").trimEnd();
      return [line(all[0]!), widths.map((width) => "─".repeat(width)).join("  "), ...all.slice(1).map(line)];
    }
    case "card": {
      const head = `▌ ${oneLine(node.title)}${node.badge ? `  [${oneLine(node.badge.label)}]` : ""}`;
      return [head, ...(node.subtitle ? [`▌ ${oneLine(node.subtitle)}`] : []), ...(node.children ?? []).flatMap(terminalLines).map((line) => `  ${line}`)];
    }
    case "box": {
      const inner = node.children.flatMap(terminalLines);
      return [`┌─${node.title ? ` ${oneLine(node.title)} ` : ""}`, ...inner.map((line) => `│ ${line}`), "└─"];
    }
    case "stack": return node.children.flatMap(terminalLines);
    case "row": {
      const columns = node.children.map(terminalLines);
      const widths = columns.map((lines) => Math.max(0, ...lines.map((line) => line.length)));
      const height = Math.max(0, ...columns.map((lines) => lines.length));
      return Array.from({ length: height }, (_, row) =>
        columns.map((lines, index) => (lines[row] ?? "").padEnd(widths[index]!)).join("   ").trimEnd());
    }
  }
}

const mdInline = (value: string) => oneLine(value).replace(/([\\`*_|<>])/g, "\\$1");

function markdownLines(node: Primitive): string[] {
  switch (node.type) {
    case "text": return [node.strong ? `**${mdInline(node.text)}**` : mdInline(node.text), ""];
    case "badge": return [`\`${oneLine(node.label).replace(/`/g, "'")}\``, ""];
    case "stat": return [`- **${mdInline(node.label)}:** ${mdInline(statText(node))}`];
    case "bar": return [`- ${mdInline(node.label)}: ${meter(node.value, node.max)} ${node.value}/${node.max}`];
    case "sparkline": return [`- ${node.label ? `${mdInline(node.label)}: ` : ""}${sparkline(node.values)}`];
    case "checklist": return [...node.items.map((item) => `- [${item.done ? "x" : " "}] ${mdInline(item.label)}`), ""];
    case "table": return [
      `| ${node.columns.map(mdInline).join(" | ")} |`,
      `| ${node.columns.map(() => "---").join(" | ")} |`,
      ...node.rows.map((row) => `| ${row.map((value) => mdInline(cell(value))).join(" | ")} |`),
      "",
    ];
    case "card": return [
      `**${mdInline(node.title)}**${node.badge ? ` \`${oneLine(node.badge.label).replace(/`/g, "'")}\`` : ""}${node.subtitle ? ` · _${mdInline(node.subtitle)}_` : ""}`,
      "",
      ...(node.children ?? []).flatMap(markdownLines),
    ];
    case "box": return [...(node.title ? [`**${mdInline(node.title)}**`, ""] : []), ...node.children.flatMap(markdownLines)];
    case "stack":
    case "row": return node.children.flatMap(markdownLines);
  }
}

function markdown(view: Primitive): string {
  const lines = markdownLines(view);
  // A list ends where a paragraph starts; collapse runs of blank lines.
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const html = (value: string | number) => String(value).replace(/[&<>"']/g, (character) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
const toneClass = (value: Tone | undefined) => value && value !== "default" ? ` ext-${value}` : "";

function htmlOf(node: Primitive): string {
  switch (node.type) {
    case "text": return `<p class="ext-text${toneClass(node.tone)}">${node.strong ? `<strong>${html(node.text)}</strong>` : html(node.text)}</p>`;
    case "badge": return `<span class="ext-badge${toneClass(node.tone)}">${html(node.label)}</span>`;
    case "stat": return `<div class="ext-stat${toneClass(node.tone)}"><span class="ext-label">${html(node.label)}</span> <strong>${html(statText(node))}</strong></div>`;
    case "bar": return `<div class="ext-bar${toneClass(node.tone)}"><span class="ext-label">${html(node.label)}</span> <meter min="0" max="${node.max}" value="${node.value}">${node.value}/${node.max}</meter> ${node.value}/${node.max}</div>`;
    case "sparkline": return `<div class="ext-sparkline">${node.label ? `<span class="ext-label">${html(node.label)}</span> ` : ""}${sparkline(node.values)}</div>`;
    case "checklist": return `<ul class="ext-checklist">${node.items.map((item) => `<li><input type="checkbox" disabled${item.done ? " checked" : ""}> ${html(item.label)}</li>`).join("")}</ul>`;
    case "table": return `<table class="ext-table"><thead><tr>${node.columns.map((column) => `<th>${html(column)}</th>`).join("")}</tr></thead><tbody>${
      node.rows.map((row) => `<tr>${row.map((value) => `<td>${html(cell(value))}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
    case "card": return `<section class="ext-card"><header><strong>${html(node.title)}</strong>${node.badge ? ` <span class="ext-badge${toneClass(node.badge.tone)}">${html(node.badge.label)}</span>` : ""}${
      node.subtitle ? `<div class="ext-subtitle">${html(node.subtitle)}</div>` : ""}</header>${(node.children ?? []).map(htmlOf).join("")}</section>`;
    case "box": return `<section class="ext-box">${node.title ? `<h4>${html(node.title)}</h4>` : ""}${node.children.map(htmlOf).join("")}</section>`;
    case "stack": return `<div class="ext-stack">${node.children.map(htmlOf).join("")}</div>`;
    case "row": return `<div class="ext-row">${node.children.map(htmlOf).join("")}</div>`;
  }
}

function firstTable(node: Primitive): Extract<Primitive, { type: "table" }> | null {
  if (node.type === "table") return node;
  const children = node.type === "box" || node.type === "stack" || node.type === "row" ? node.children : node.type === "card" ? node.children ?? [] : [];
  for (const child of children) {
    const found = firstTable(child);
    if (found) return found;
  }
  return null;
}

const csvCell = (value: unknown) => {
  const raw = value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
};

/** Rows, when there are any: the view's first table, else data that is a list of flat objects. */
function csv(output: ComponentOutput): string | null {
  const table = firstTable(output.view);
  if (table) return [table.columns, ...table.rows].map((row) => row.map(csvCell).join(",")).join("\n");
  if (Array.isArray(output.data) && output.data.length && output.data.every((row) => row && typeof row === "object" && !Array.isArray(row))) {
    const columns = [...new Set(output.data.flatMap((row) => Object.keys(row as object)))];
    return [columns.map(csvCell).join(","), ...output.data.map((row) => columns.map((column) => csvCell((row as Record<string, unknown>)[column])).join(","))].join("\n");
  }
  return null;
}

function fromPrimitives(output: ComponentOutput, target: RenderTarget): string | null {
  switch (target) {
    // Clean even for a result kept before the service cleaned what it keeps.
    case "terminal": return cleanExtensionText(terminalLines(output.view).join("\n"), true);
    case "markdown": return markdown(output.view);
    case "blockdown": return inertBlockdown(markdown(output.view));
    case "html": return `<div class="ext-component">${htmlOf(output.view)}</div>`;
    case "json": return JSON.stringify(output.data, null, 2);
    case "csv": return csv(output);
  }
}

/**
 * One component for one target, down the fallback chain: its own rendering,
 * then its primitives, then the requester's `fallback` (default `json`).
 */
export function renderComponent(output: ComponentOutput, target: RenderTarget, fallback: RenderTarget = "json"): RenderedComponent {
  const own = output.targets?.[target];
  if (own !== undefined) return { target, body: target === "blockdown" ? inertBlockdown(own) : cleanExtensionText(own, true), via: "component", contentType: CONTENT_TYPES[target] };
  const composed = fromPrimitives(output, target);
  if (composed !== null) return { target, body: composed, via: "primitives", contentType: CONTENT_TYPES[target] };
  const backup = fromPrimitives(output, fallback === target ? "json" : fallback) ?? JSON.stringify(output.data, null, 2);
  const body = target === "html" ? `<pre class="ext-fallback">${html(backup)}</pre>` : backup;
  return { target, body, via: "fallback", contentType: target === "html" ? CONTENT_TYPES.html : CONTENT_TYPES[fallback === target ? "json" : fallback] };
}

/** Markdown for an output handler's text in a target (kind 2 has no view: markdown is its data). */
export function renderMarkdownOutput(markdownText: string, target: RenderTarget): RenderedComponent {
  switch (target) {
    case "markdown":
    case "terminal":
      return { target, body: cleanExtensionText(markdownText, true), via: "primitives", contentType: CONTENT_TYPES[target] };
    case "blockdown":
      return { target, body: inertBlockdown(markdownText), via: "primitives", contentType: CONTENT_TYPES.blockdown };
    case "html":
      return { target, body: `<pre class="ext-output">${html(markdownText)}</pre>`, via: "fallback", contentType: CONTENT_TYPES.html };
    case "json":
      return { target, body: JSON.stringify({ markdown: markdownText }, null, 2), via: "primitives", contentType: CONTENT_TYPES.json };
    case "csv":
      return { target, body: JSON.stringify({ markdown: markdownText }, null, 2), via: "fallback", contentType: CONTENT_TYPES.json };
  }
}
