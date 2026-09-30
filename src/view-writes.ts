// What a write has to change for a note to be in a saved view (`views.planWrite`, PIE-490): moving an
// existing block into a view, and what a new block created in a view is born with. Clients (ep0ch-door's
// kanban lanes, agents) ask here rather than porting the query language to plan writes themselves.
//
// A view's query is split for writing:
//   - its plain top-level clauses (`key` present, or `key=value`, case-insensitive) are what a write
//     sets: a value clause replaces the block's one block-scope token for that key, or appends one;
//     clauses the block already satisfies are left alone;
//   - everything else (an OR group, a NOT, a created/updated range) must already hold. The whole query
//     is evaluated on the block as the patch would leave it, so a group that mentions a patched key
//     can't be broken by the patch;
//   - anything a patch can't satisfy is refused, with the reason, and nothing is planned.
// A bare word is a presence clause (`urgent` means "has an urgent:: property"): a write would have to
// invent the value, so a move is refused and a new block's text must say it.
//
// Planning only reads. The client applies a move with `properties.patch` at the revision the plan was
// made at, so a block that changed in between is refused there, never overwritten.
import { compileQueryExpression, serializePropertyFilterValue } from "./block-query";
import { firstLineWithoutPropertyTokens, formatProperty, parsePropertyRecords } from "./properties";
import type {
  Block,
  BlockProperty,
  PropertyFilter,
  PropertyPatchOperation,
  QueryExpression,
  RoadmapItemCreateInput,
  RoadmapItemPriority,
} from "./types";
import { isVirtualBranchDefinition, parseVirtualBranchConfig } from "./virtual-branches";

/** Stages a roadmap item is never created in: it's created in Queued or Doing, then moved. */
export const ROADMAP_NOT_CREATED_IN: ReadonlySet<string> = new Set(["review", "validate", "done", "superseded"]);
/** The keys the roadmap allocator writes itself; a roadmap item's title and body don't carry them. */
const ALLOCATOR_KEYS = new Set(["type", "status", "priority", "work-stage", "work-batch", "project", "arc", "track", "depends-on", "related-to", "source-block", "work-id"]);
const PRIORITIES: readonly RoadmapItemPriority[] = ["high", "medium", "low"];
const ALLOCATOR_REQUIRED = ["project", "priority", "arc", "track"] as const;
const BLOCK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ViewWriteChange { key: string; to: string; from: string | null }

/** A move of one block into one view. */
export type ViewMovePlan =
  | { kind: "patch"; revision: number; changes: ViewWriteChange[]; operations: PropertyPatchOperation[] }
  | { kind: "already" }
  | { kind: "refused"; reason: string };

/** A new block in one view. */
export type ViewCreatePlan =
  | {
      kind: "create";
      /** The properties the block is born with: the view's plain value clauses. */
      born: BlockProperty[];
      /** The view's `[create::key=value]` default, added only when the text doesn't set that key. */
      defaults: BlockProperty[];
      /** Terms the born-with properties and defaults don't meet, in the query's words: the text must. */
      needs: string[];
      /**
       * The view lists roadmap items (a plain `type=roadmap-item`): a new one is made by the workboard's
       * allocator (`roadmap.items.create`, with `item`), never by a plain create.
       */
      roadmap: boolean;
      /** With text: what a plain create saves (the text with the properties it needs appended). */
      text?: string;
      /** With text in a roadmap view: what `roadmap.items.create` is called with. */
      item?: RoadmapItemCreateInput;
      /** With text: what the block will be born with beyond what was typed. */
      bornWith?: BlockProperty[];
    }
  | { kind: "refused"; reason: string };

/** A saved view read for writing: its query split into what a write sets and what must already hold. */
export type WriteView =
  | { ok: true; id: string; name: string; expr: QueryExpression; plain: PropertyFilter[]; rest: QueryExpression[]; create: BlockProperty | null; createError?: string }
  | { ok: false; id: string; name: string; reason: string };

/** The block a move plans against: its text (for token ordinals), properties and times. */
export type WriteSubject = Pick<Block, "id" | "text" | "revision" | "properties" | "createdAt" | "updatedAt">;

const viewName = (definition: Pick<Block, "text">) => firstLineWithoutPropertyTokens(definition.text)?.trim() || "the view";

/** A saved view's definition as a write sees it, or why there is nothing to plan against. */
export function writeView(id: string, definition: Pick<Block, "id" | "text" | "properties"> | undefined): WriteView {
  if (!definition) return { ok: false, id, name: "the view", reason: `view ${id} is missing: Saved view not found in the active workspace` };
  const name = viewName(definition);
  if (!isVirtualBranchDefinition(definition)) return { ok: false, id, name, reason: `${name} is unsupported: only type=virtual-branch views plan writes` };
  const parsed = parseVirtualBranchConfig(definition, []);
  if (!parsed.config) return { ok: false, id, name, reason: `${name} is invalid: ${parsed.configurationErrors[0] ?? "no reason given"}` };
  const { filters, where } = parsed.config;
  if (filters.some(f => f.key === "deleted")) {
    return { ok: false, id, name, reason: `${name}'s query selects Trash (deleted=true); a note goes there by trashing it, not by a write` };
  }
  const expr: QueryExpression = where ?? { kind: "and", operands: filters.map(f => ({ kind: "property" as const, ...f })) };
  const plain: PropertyFilter[] = [], rest: QueryExpression[] = [];
  for (const term of expr.kind === "and" ? expr.operands : [expr]) {
    // A `child:` clause is about the block's children: a patch to the block can't make it hold.
    if (term.kind === "property" && !term.relation) plain.push(term.value === undefined ? { key: term.key } : { key: term.key, value: term.value });
    else rest.push(term);
  }
  // Where a new block goes (create-parent) is the caller's choice; what it is born with is the view's.
  const creation = parseVirtualBranchConfig({ ...definition, properties: definition.properties.filter(p => p.key !== "create-parent") }, []);
  let create = creation.config?.create ?? null;
  let createError = creation.creationErrors[0];
  if (create?.key === "deleted") { create = null; createError = "deleted=true selects Trash; it isn't a property to set"; }
  return { ok: true, id, name, expr, plain, rest, create, ...(createError ? { createError } : {}) };
}

/** The expression in the query's own words: `(project=a OR project=b)`, `NOT stage=done`. */
export function showQueryExpression(e: QueryExpression, nested = false): string {
  switch (e.kind) {
    case "property": return `${e.relation ? `${e.relation}:` : ""}${e.value === undefined ? e.key : `${e.key}=${serializePropertyFilterValue(e.value)}`}`;
    case "time": return `${e.field} ${e.op} ${e.value}`;
    case "not": return `NOT ${showQueryExpression(e.operand, true)}`;
    case "and": { const s = e.operands.map(o => showQueryExpression(o, true)).join(" "); return nested ? `(${s})` : s; }
    case "or": { const s = e.operands.map(o => showQueryExpression(o, true)).join(" OR "); return nested ? `(${s})` : s; }
  }
}

function keysOf(e: QueryExpression): string[] {
  switch (e.kind) {
    case "property": return e.relation ? [] : [e.key];
    case "time": return [];
    case "not": return keysOf(e.operand);
    default: return [...new Set(e.operands.flatMap(keysOf))];
  }
}

interface Subject { properties: readonly BlockProperty[]; createdAt: string; updatedAt: string }
const holds = (e: QueryExpression, s: Subject, now: number) => compileQueryExpression(e, now)(s, s.properties);
const unmet = (rest: readonly QueryExpression[], s: Subject, now: number) => rest.filter(term => !holds(term, s, now));
const sameValue = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** "project=garden", "no project": what the properties have for the keys a term names. */
function has(properties: readonly BlockProperty[], term: QueryExpression): string {
  return keysOf(term).map(k => {
    const values = properties.filter(p => p.key === k).map(p => p.value);
    return values.length ? `${k}=${values.join(",")}` : `no ${k}`;
  }).join(", ");
}

/** The view's plain clauses by key, in query order. */
function clausesByKey(plain: readonly PropertyFilter[]): Map<string, PropertyFilter[]> {
  const byKey = new Map<string, PropertyFilter[]>();
  for (const f of plain) byKey.set(f.key, [...(byKey.get(f.key) ?? []), f]);
  return byKey;
}
const distinctValues = (clauses: readonly PropertyFilter[]) =>
  [...new Map(clauses.filter(c => c.value !== undefined).map(c => [c.value!.toLowerCase(), c.value!])).values()];

function applyChanges(properties: readonly BlockProperty[], changes: readonly ViewWriteChange[]): BlockProperty[] {
  const out = properties.map(p => ({ ...p }));
  for (const c of changes) {
    const at = out.findIndex(p => p.key === c.key);
    if (at >= 0) out[at] = { key: c.key, value: c.to }; else out.push({ key: c.key, value: c.to });
  }
  return out;
}

/** What moving `block` into `view` would patch, or why it can't. */
export function planMoveIntoView(view: WriteView, block: WriteSubject, now = Date.now()): ViewMovePlan {
  if (!view.ok) return { kind: "refused", reason: view.reason };
  const properties = block.properties;
  if (holds(view.expr, block, now)) return { kind: "already" };
  const changes: ViewWriteChange[] = [];
  for (const [key, clauses] of clausesByKey(view.plain)) {
    const have = properties.filter(p => p.key === key);
    if (clauses.every(c => have.some(p => c.value === undefined || sameValue(p.value, c.value)))) continue;
    const values = distinctValues(clauses);
    if (values.length === 0) return { kind: "refused", reason: `${view.name} asks for any ${key}:: value; a move can't choose one` };
    if (values.length > 1) return { kind: "refused", reason: `${view.name} asks for ${key} to be ${values.join(" and ")} at once; a move sets one value` };
    if (have.length > 1) {
      return { kind: "refused", reason: `the note has ${have.length} ${key}:: values (${have.map(h => h.value).join(", ")}); a move won't guess which one changes` };
    }
    changes.push({ key, to: values[0]!, from: have[0]?.value ?? null });
  }
  // The rest of the query must hold on the block as the patch leaves it, and a patch makes it updated now.
  const after = applyChanges(properties, changes);
  const missing = unmet(view.rest, { properties: after, createdAt: block.createdAt, updatedAt: new Date(now).toISOString() }, now);
  if (missing.length) {
    const term = missing[0]!, what = has(after, term);
    return { kind: "refused", reason: `${view.name} needs ${showQueryExpression(term, true)}${what ? ` and the note has ${what}` : ""}; a move sets only the plain clauses beside it` };
  }
  if (!changes.length) return { kind: "already" };
  const tokens = parsePropertyRecords(block.text).filter(t => t.scope === "block");
  const operations: PropertyPatchOperation[] = changes.map(c => {
    const token = tokens.find(t => t.key === c.key);
    return token ? { op: "replace", ordinal: token.ordinal, value: c.to } : { op: "append", key: c.key, value: c.to };
  });
  return { kind: "patch", revision: block.revision, changes, operations };
}

/**
 * What a new block in `view` is born with. Without text (a composer opening): the view's side only.
 * With text: the text as it would be saved (or the allocator's input for a roadmap view), checked against
 * the view's whole query as the service reads it.
 */
export function planCreateInView(view: WriteView, text: string | undefined, now = Date.now()): ViewCreatePlan {
  if (!view.ok) return { kind: "refused", reason: view.reason };
  if (view.createError) return { kind: "refused", reason: `${view.name}'s create:: default is unusable: ${view.createError}` };
  const dflt = view.create;
  const born: BlockProperty[] = [];
  const needs: QueryExpression[] = [];
  for (const [key, clauses] of clausesByKey(view.plain)) {
    const values = distinctValues(clauses);
    if (values.length > 1) return { kind: "refused", reason: `${view.name} asks for ${key} to be ${values.join(" and ")} at once; a note has one value` };
    if (values.length === 1) born.push({ key, value: values[0]! });
    else if (dflt?.key !== key) needs.push({ kind: "property", key });      // a presence clause: the text has to say which value
  }
  const defaults: BlockProperty[] = [];
  if (dflt) {
    const same = born.find(p => p.key === dflt.key);
    if (same && !sameValue(same.value, dflt.value)) {
      return { kind: "refused", reason: `${view.name}'s create:: default ${dflt.key}=${dflt.value} contradicts its query (${dflt.key}=${same.value})` };
    }
    if (!same) defaults.push(dflt);
  }
  const roadmap = born.some(p => p.key === "type" && sameValue(p.value, "roadmap-item"));
  const stage = born.find(p => p.key === "work-stage")?.value.toLowerCase();
  if (roadmap && stage && ROADMAP_NOT_CREATED_IN.has(stage)) {
    return { kind: "refused", reason: `${view.name} lists work-stage=${stage}: roadmap items are created in Queued or Doing, then moved` };
  }
  const at = new Date(now).toISOString();
  const missing = unmet(view.rest, { properties: [...born, ...defaults], createdAt: at, updatedAt: at }, now);
  const timeOnly = missing.find(term => !keysOf(term).length);
  if (timeOnly) return { kind: "refused", reason: `${view.name} needs ${showQueryExpression(timeOnly, true)}, which a new note doesn't meet` };
  needs.push(...missing);
  const plan = { kind: "create" as const, born, defaults, needs: needs.map(t => showQueryExpression(t, true)), roadmap };
  if (text === undefined || !text.trim()) return plan;

  const typed = parsePropertyRecords(text).filter(t => t.scope === "block").map(({ key, value }) => ({ key, value }));
  if (roadmap) {
    const item = planRoadmapItem(view.name, text, born, defaults, typed);
    if ("refused" in item) return { kind: "refused", reason: item.refused };
    const miss = createMisses(view, item.properties, now);
    if (miss) return { kind: "refused", reason: miss };
    return { ...plan, item: item.input, bornWith: item.properties.filter(p => !typed.some(t => t.key === p.key && sameValue(t.value, p.value))) };
  }
  const composed = composeText(view.name, text, born, typed, defaults);
  if ("refused" in composed) return { kind: "refused", reason: composed.refused };
  const final = parsePropertyRecords(composed.text).filter(t => t.scope === "block").map(({ key, value }) => ({ key, value }));
  const miss = createMisses(view, final, now);
  if (miss) return { kind: "refused", reason: miss };
  const bornWith = [...born, ...defaults].filter(p => !typed.some(t => t.key === p.key));
  return { ...plan, text: composed.text, bornWith };
}

/** Why a new block with `properties` isn't one the view lists, or null when it is. */
function createMisses(view: Extract<WriteView, { ok: true }>, properties: readonly BlockProperty[], now: number): string | null {
  const at = new Date(now).toISOString();
  const s = { properties, createdAt: at, updatedAt: at };
  for (const f of view.plain) {
    const have = properties.filter(p => p.key === f.key);
    if (f.value !== undefined && have.length && !have.some(p => sameValue(p.value, f.value!))) {
      return `the text sets ${f.key}::${have.map(p => p.value).join(",")}, but ${view.name} needs ${f.key}=${f.value}`;
    }
  }
  if (holds(view.expr, s, now)) return null;
  const miss = unmet(view.rest, s, now)[0];
  const plainMiss = view.plain.find(f => !properties.some(p => p.key === f.key && (f.value === undefined || sameValue(p.value, f.value))));
  const term: QueryExpression = miss ?? (plainMiss ? { kind: "property", ...plainMiss } : view.expr);
  const what = has(properties, term);
  return `${view.name} needs ${showQueryExpression(term, true)}${what ? ` and the note would have ${what}` : ""}`;
}

/**
 * The text a new block is saved with: what was typed, with each property the view needs appended to the
 * first line as a `[key::value]` token, unless the text already says so. A typed value that contradicts
 * the view is refused, never overwritten. Defaults are only added for keys the text doesn't set.
 */
function composeText(name: string, text: string, born: readonly BlockProperty[], typed: readonly BlockProperty[], defaults: readonly BlockProperty[]): { text: string } | { refused: string } {
  const lines = text.replace(/\s+$/, "").split("\n");
  const own = (key: string) => typed.filter(p => p.key === key).map(p => p.value);
  const add: string[] = [];
  for (const p of born) {
    const have = own(p.key);
    if (have.some(v => sameValue(v, p.value))) continue;
    if (have.length) return { refused: `the text sets ${p.key}::${have.join(",")}, but ${name} needs ${p.key}=${p.value}` };
    add.push(formatProperty(p));
  }
  for (const p of defaults) if (!own(p.key).length && !born.some(b => b.key === p.key)) add.push(formatProperty(p));
  if (add.length) lines[0] = `${lines[0]!.replace(/\s+$/, "")} ${add.join(" ")}`.trimStart();
  return { text: lines.join("\n") };
}

const listed = (xs: readonly string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const idOf = (v: string) => v.replace(/^\(\((.*)\)\)$/, "$1").split("|")[0]!.trim();

/**
 * A new roadmap item in a roadmap view, as the allocator takes it. Each field is the typed text's token,
 * else the view's plain clause, else its create:: default. A typed value that contradicts a plain clause
 * is refused; so is a missing required field (all named at once), a stage items aren't created in, and a
 * work-id (the allocator issues it). The allocator's keys come out of the title and body.
 */
function planRoadmapItem(
  name: string,
  text: string,
  born: readonly BlockProperty[],
  defaults: readonly BlockProperty[],
  typed: readonly BlockProperty[],
): { input: RoadmapItemCreateInput; properties: BlockProperty[] } | { refused: string } {
  const own = (key: string) => typed.filter(p => p.key === key).map(p => p.value);
  for (const p of born) {
    const have = own(p.key);
    if (have.length && !have.some(v => sameValue(v, p.value))) return { refused: `the text sets ${p.key}::${have.join(",")}, but ${name} needs ${p.key}=${p.value}` };
  }
  if (own("work-id").length) return { refused: "the workboard's allocator issues the work-id; take [work-id::] out of the text" };
  if (own("status").length) return { refused: "roadmap items have no status (work-stage owns their stage); take [status::] out of the text" };
  if (own("type").some(v => !sameValue(v, "roadmap-item"))) return { refused: `${name} lists roadmap items; the text sets type::${own("type").join(",")}` };
  const values = (key: string): string[] => {
    const t = own(key);
    if (t.length) return t;
    const b = born.filter(p => p.key === key).map(p => p.value);
    return b.length ? b : defaults.filter(p => p.key === key).map(p => p.value);
  };
  const fields: Record<string, string | undefined> = {};
  for (const key of ["project", "priority", "arc", "work-stage", "work-batch", "source-block"]) {
    const v = [...new Map(values(key).map(x => [x.toLowerCase(), x])).values()];
    if (v.length > 1) return { refused: `the text sets ${key} to ${v.join(" and ")}; a roadmap item has one ${key}` };
    fields[key] = v[0];
  }
  const tracks = [...new Map(values("track").map(x => [x.toLowerCase(), x])).values()];
  const missing = ALLOCATOR_REQUIRED.filter(k => (k === "track" ? !tracks.length : !fields[k]));
  if (missing.length) {
    const hint = missing.map(k => (k === "priority" ? "[priority::high|medium|low]" : `[${k}::…]`)).join(" ");
    return { refused: `${name} makes roadmap items through the workboard's allocator, which needs ${listed(missing.map(k => (k === "track" ? "a track" : k)))}: add ${hint} to the text` };
  }
  // An allocator field the service reads as a line's own property, not the item's, would be lost.
  const stray = parsePropertyRecords(text).find(t => ALLOCATOR_KEYS.has(t.key) && t.scope !== "block");
  if (stray) return { refused: `${stray.raw} on line ${stray.line + 1} belongs to that line, not the item; put it on the title line` };
  const priority = fields.priority!.toLowerCase() as RoadmapItemPriority;
  if (!PRIORITIES.includes(priority)) return { refused: `priority must be high, medium or low, not ${fields.priority}` };
  const stage = fields["work-stage"]?.toLowerCase();
  if (stage && ROADMAP_NOT_CREATED_IN.has(stage)) return { refused: `roadmap items aren't created in ${stage}: create in Queued or Doing, then move` };

  // The title and body without the tokens the allocator writes itself.
  const tokens = parsePropertyRecords(text).filter(t => t.scope === "block" && ALLOCATOR_KEYS.has(t.key)).sort((a, b) => a.start - b.start);
  let stripped = "", cursor = 0;
  for (const t of tokens) {
    let start = t.start;
    while (start > cursor && (text[start - 1] === " " || text[start - 1] === "\t")) start -= 1;
    stripped += text.slice(cursor, start);
    cursor = t.end;
  }
  stripped += text.slice(cursor);
  const [first = "", ...rest] = stripped.split("\n");
  const title = first.trim();
  if (!title) return { refused: "type the item's title on the first line" };
  const body = rest.map(l => l.replace(/[ \t]+$/, "")).join("\n").trim();
  const workBatchId = fields["work-batch"] ? idOf(fields["work-batch"]) : undefined;
  const dependsOn = values("depends-on").map(idOf), relatedTo = values("related-to").map(idOf);
  const sourceBlockId = fields["source-block"] ? idOf(fields["source-block"]) : undefined;
  // The allocator takes only canonical block UUIDs for these.
  const badId = ([["work-batch", workBatchId], ...dependsOn.map(v => ["depends-on", v]), ...relatedTo.map(v => ["related-to", v]), ["source-block", sourceBlockId]] as [string, string | undefined][])
    .find(([, v]) => v !== undefined && !BLOCK_ID.test(v));
  if (badId) return { refused: `${badId[0]} must be a block id (a UUID), not ${badId[1]}` };
  const input: RoadmapItemCreateInput = {
    title, ...(body ? { body } : {}), priority,
    ...(stage ? { workStage: stage as RoadmapItemCreateInput["workStage"] } : {}),
    ...(workBatchId ? { workBatchId } : {}),
    project: fields.project!, arc: fields.arc!, tracks,
    ...(dependsOn.length ? { dependsOn } : {}), ...(relatedTo.length ? { relatedTo } : {}), ...(sourceBlockId ? { sourceBlockId } : {}),
  };
  // As the allocator writes them: no stage means queued with a batch, else unprioritized.
  const properties: BlockProperty[] = [
    { key: "type", value: "roadmap-item" }, { key: "priority", value: priority },
    { key: "work-stage", value: stage ?? (workBatchId ? "queued" : "unprioritized") },
    ...(workBatchId ? [{ key: "work-batch", value: workBatchId }] : []), { key: "project", value: input.project }, { key: "arc", value: input.arc },
    ...tracks.map(value => ({ key: "track", value })), ...dependsOn.map(value => ({ key: "depends-on", value })),
    ...relatedTo.map(value => ({ key: "related-to", value })), ...(sourceBlockId ? [{ key: "source-block", value: sourceBlockId }] : []),
    ...typed.filter(p => !ALLOCATOR_KEYS.has(p.key)),
  ];
  return { input, properties };
}
