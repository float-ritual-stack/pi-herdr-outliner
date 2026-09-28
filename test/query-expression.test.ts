import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BlockQuerySyntaxError,
  compileQueryExpression,
  normalizeBlockSearchQuery,
  parsePropertyFilterExpression,
  parseQueryExpression,
  parseSearchExpression,
  queryRequestProblem,
} from "../src/block-query";
import { OutlinerClient, OutlinerRequestError } from "../src/client";
import { readSavedView } from "../src/saved-view-read";
import { OutlinerServer } from "../src/server";
import { OutlinerStore } from "../src/store";
import type { Block, QueryExpression, VisibleBlockCollection } from "../src/types";

const p = (key: string, value?: string): QueryExpression => ({ kind: "property", key, ...(value === undefined ? {} : { value }) });

function syntaxPosition(input: string): number {
  try {
    parseSearchExpression(input);
  } catch (error) {
    if (error instanceof BlockQuerySyntaxError) return error.index;
    throw error;
  }
  throw new Error(`Expected a syntax error: ${input}`);
}

describe("query grammar", () => {
  test("every existing clause list keeps its exact filter meaning", () => {
    for (const query of [
      "status=open priority",
      'status="in progress" project=pi-outliner',
      "work-stage::review type::roadmap-item",
      "title=f(x) note=a)",
      "deleted=true",
      'label="(quoted) OR not"',
      "Status=Open",
    ]) {
      expect(parseSearchExpression(query)).toEqual({ filters: parsePropertyFilterExpression(query) });
    }
  });

  test("NOT binds tighter than AND, which binds tighter than OR", () => {
    expect(parseQueryExpression("a OR b c")).toEqual({ kind: "or", operands: [p("a"), { kind: "and", operands: [p("b"), p("c")] }] });
    expect(parseQueryExpression("not a b")).toEqual({ kind: "and", operands: [{ kind: "not", operand: p("a") }, p("b")] });
    expect(parseQueryExpression("a AND NOT b=x or c")).toEqual({ kind: "or", operands: [
      { kind: "and", operands: [p("a"), { kind: "not", operand: p("b", "x") }] }, p("c"),
    ] });
    expect(parseQueryExpression("NOT (a OR b)")).toEqual({ kind: "not", operand: { kind: "or", operands: [p("a"), p("b")] } });
    expect(parseQueryExpression("NOT NOT a")).toEqual({ kind: "not", operand: { kind: "not", operand: p("a") } });
    expect(parseQueryExpression("((a=x) OR (b=\"y )\")) c")).toEqual({ kind: "and", operands: [
      { kind: "or", operands: [p("a", "x"), p("b", "y )")] }, p("c"),
    ] });
  });

  test("a group's closing parens never take a paren that balances one inside the value", () => {
    expect(parseQueryExpression("((k=f(x)))")).toEqual(p("k", "f(x)"));
    expect(parseQueryExpression("(k=f(x) OR a)")).toEqual({ kind: "or", operands: [p("k", "f(x)"), p("a")] });
    expect(parseQueryExpression("((k=f(x)) OR a) b")).toEqual({ kind: "and", operands: [{ kind: "or", operands: [p("k", "f(x)"), p("a")] }, p("b")] });
    expect(parseQueryExpression("(a OR k=g(f(x)))")).toEqual({ kind: "or", operands: [p("a"), p("k", "g(f(x))")] });
    // Quoted parens are value text; an unbalanced trailing ")" inside a group closes it.
    expect(parseQueryExpression('(k="f(x" OR a)')).toEqual({ kind: "or", operands: [p("k", "f(x"), p("a")] });
    expect(parseQueryExpression("(k=:) OR a")).toEqual({ kind: "or", operands: [p("k", ":"), p("a")] });
    expect(parseQueryExpression('(k=":)" OR a)')).toEqual({ kind: "or", operands: [p("k", ":)"), p("a")] });
    // Clause lists without grammar keep the whole unquoted value.
    expect(parseSearchExpression("k=f(x))")).toEqual({ filters: [{ key: "k", value: "f(x))" }] });
  });

  test("ranges accept created and updated with or without spaces", () => {
    const range = (field: "created" | "updated", op: "<" | "<=" | ">" | ">=", value: string): QueryExpression => ({ kind: "time", field, op, value });
    expect(parseQueryExpression("updated>2026-09-20")).toEqual(range("updated", ">", "2026-09-20"));
    expect(parseQueryExpression("updated > 2026-09-20")).toEqual(range("updated", ">", "2026-09-20"));
    expect(parseQueryExpression("Created >=-7d")).toEqual(range("created", ">=", "-7d"));
    expect(parseQueryExpression("updated< 2026-09-20T12:30:00Z type=task")).toEqual({ kind: "and", operands: [
      range("updated", "<", "2026-09-20T12:30:00Z"), p("type", "task"),
    ] });
    // Equality on a property named updated keeps its property meaning.
    expect(parseSearchExpression("updated=2026-09-20")).toEqual({ filters: [{ key: "updated", value: "2026-09-20" }] });
  });

  test("invalid queries fail with the character position instead of matching nothing", () => {
    expect(syntaxPosition("a OR")).toBe(4);
    expect(syntaxPosition("OR a")).toBe(0);
    expect(syntaxPosition("a (b OR c")).toBe(2);
    expect(syntaxPosition("a ()")).toBe(2);
    expect(syntaxPosition("status=open NOT")).toBe(15);
    expect(syntaxPosition("due < 2026-10-01")).toBe(0);
    expect(syntaxPosition("updated > soon")).toBe(10);
    expect(syntaxPosition("updated > 2026-02-30")).toBe(10);
    // Impossible datetimes fail instead of rolling over (2026-02-30T10:00Z is not March 2).
    expect(syntaxPosition("updated >= 2026-02-30T10:00Z")).toBe(11);
    expect(syntaxPosition("a updated<2026-04-31T00:00")).toBe(10);
    expect(syntaxPosition("updated > 2026-09-27T24:00Z")).toBe(10);
    expect(syntaxPosition("updated > 2026-09-27T10:60")).toBe(10);
    expect(() => parseSearchExpression("updated >= 2026-02-30T10:00Z")).toThrow("Invalid date");
    expect(parseSearchExpression("updated >= 2026-02-28T23:59:59.999+05:30").where).toEqual({ kind: "time", field: "updated", op: ">=", value: "2026-02-28T23:59:59.999+05:30" });
    expect(syntaxPosition("updated >")).toBe(9);
    expect(syntaxPosition("a OR > 2026-01-01")).toBe(5);
    expect(syntaxPosition("deleted=true OR a")).toBe(0);
    expect(syntaxPosition("a OR b=")).toBe(7);
    expect(() => parseSearchExpression("a OR")).toThrow("at character 5");
  });

  test("request problems name the field only where the request's expression was parsed", () => {
    const expressionError = (() => { try { normalizeBlockSearchQuery({ expression: "a OR", limit: 5 }); } catch (error) { return error; } })();
    expect(queryRequestProblem(expressionError)).toEqual({ code: "query-syntax", field: "expression", position: 4, message: expect.stringContaining("at character 5") });
    // Other parsers (a checklist view's [query::...], a saved definition) have no request field to index.
    const otherError = (() => { try { parsePropertyFilterExpression('status="open'); } catch (error) { return error; } })();
    expect(queryRequestProblem(otherError)).toEqual({ code: "query-syntax", message: expect.stringContaining("Unterminated quoted filter value") });
  });

  test("date values are whole UTC days; relative values resolve at evaluation time", () => {
    const now = Date.parse("2026-09-27T15:00:00Z");
    const at = (updatedAt: string) => ({ createdAt: updatedAt, updatedAt });
    const check = (query: string, updatedAt: string) => compileQueryExpression(parseQueryExpression(query), now)(at(updatedAt), []);
    expect(check("updated > 2026-09-20", "2026-09-20T23:59:59.999Z")).toBe(false);
    expect(check("updated > 2026-09-20", "2026-09-21T00:00:00.000Z")).toBe(true);
    expect(check("updated >= 2026-09-20", "2026-09-20T00:00:00.000Z")).toBe(true);
    expect(check("updated < 2026-09-20", "2026-09-19T23:59:59.999Z")).toBe(true);
    expect(check("updated <= 2026-09-20", "2026-09-20T23:59:59.999Z")).toBe(true);
    expect(check("updated <= 2026-09-20", "2026-09-21T00:00:00.000Z")).toBe(false);
    expect(check("updated >= -7d", "2026-09-20T15:00:00.000Z")).toBe(true);
    expect(check("updated >= -7d", "2026-09-20T14:59:59.999Z")).toBe(false);
    expect(check("updated >= today", "2026-09-27T00:00:00.000Z")).toBe(true);
    expect(check("updated < yesterday", "2026-09-26T00:00:00.000Z")).toBe(false);
    expect(check("updated > 2026-09-27T14:00", "2026-09-27T14:30:00.000Z")).toBe(true);
    expect(check("updated < -2w", "2026-09-12T00:00:00.000Z")).toBe(true);
  });

  test("normalization parses expression text, validates structured where and ANDs both with filters", () => {
    expect(normalizeBlockSearchQuery({ expression: "a OR b", where: { kind: "not", operand: p("C") }, filters: [{ key: "d" }], limit: 5 })).toEqual({
      filters: [{ key: "d" }],
      where: { kind: "and", operands: [{ kind: "or", operands: [p("a"), p("b")] }, { kind: "not", operand: p("c") }] },
      limit: 5,
    });
    expect(normalizeBlockSearchQuery({ expression: "deleted=true", limit: 5 })).toEqual({ includeDeleted: "roots", limit: 5 });
    expect(normalizeBlockSearchQuery({ where: { kind: "or", operands: [p("a")] }, limit: 5 })).toEqual({ where: p("a"), limit: 5 });
    expect(() => normalizeBlockSearchQuery({ where: { kind: "time", field: "updated", op: ">", value: "later" }, limit: 5 })).toThrow("Invalid time value");
    expect(() => normalizeBlockSearchQuery({ where: { kind: "or", operands: [] }, limit: 5 })).toThrow("at least one operand");
    expect(() => normalizeBlockSearchQuery({ where: p("deleted", "true"), limit: 5 })).toThrow("deleted=true");
    expect(() => normalizeBlockSearchQuery({ expression: "a OR", limit: 5 })).toThrow(BlockQuerySyntaxError);
  });
});

describe("query expressions through the service", () => {
  test("blocks.query and views.read evaluate OR, NOT, negated presence and date ranges", async () => {
    const root = mkdtempSync(join(tmpdir(), "query-expression-"));
    const store = new OutlinerStore(join(root, "outline.sqlite"));
    const server = new OutlinerServer(store, join(root, "service.sock"));
    await server.start();
    const client = new OutlinerClient(join(root, "service.sock"));
    const create = (text: string) => client.request<Block>({ action: "create", text });
    const query = (expression: string, extra: object = {}) =>
      client.request<VisibleBlockCollection>({ action: "blocks.query", query: { expression, limit: 50, ...extra } });
    const names = (collection: { blocks: Block[] }) => collection.blocks.map(block => block.text.split(" [")[0]);
    try {
      const review = await create("Review card [type::task] [work-stage::review] [priority::high]");
      const validate = await create("Validate card [type::task] [work-stage::validate]");
      const done = await create("Done card [type::task] [work-stage::done] [status::done]");
      const queued = await create("Queued card [type::task] [work-stage::queued] [status::open]");
      await create("Unrelated note [type::note] [work-stage::review]");
      const setUpdated = (block: Block, at: string) =>
        store.database.query("UPDATE blocks SET updated_at = ?, created_at = ? WHERE id = ?").run(at, at, block.id);
      setUpdated(review, "2026-09-25T10:00:00.000Z");
      setUpdated(validate, "2026-09-18T10:00:00.000Z");
      setUpdated(done, "2026-09-21T00:00:00.000Z");
      setUpdated(queued, "2026-09-20T23:00:00.000Z");

      expect(names(await query("type=task (work-stage=review OR work-stage=validate)"))).toEqual(["Review card", "Validate card"]);
      expect(names(await query("type=task NOT status=done"))).toEqual(["Review card", "Validate card", "Queued card"]);
      expect(names(await query("type=task NOT status"))).toEqual(["Review card", "Validate card"]);
      expect(names(await query("type=task updated > 2026-09-20"))).toEqual(["Review card", "Done card"]);
      expect(names(await query("type=task created <= 2026-09-20"))).toEqual(["Validate card", "Queued card"]);
      expect(names(await query("work-stage=review OR priority=high OR status=open", { filters: [{ key: "type", value: "task" }] })))
        .toEqual(["Review card", "Queued card"]);
      // Sorting and limits apply to the expression's full match set.
      const sorted = await query("type=task NOT work-stage=queued", { sort: { field: "updated", direction: "desc" }, limit: 2 });
      expect([names(sorted), sorted.completeness]).toEqual([["Review card", "Done card"], { kind: "truncated", limit: 2 }]);
      // Broader scopes report match context for positive clauses only.
      const scoped = await query("type=task (priority=high OR status=open)", { propertyScope: "all" });
      expect(scoped.blocks.map(block => block.propertyMatches?.map(match => match.key))).toEqual([["type", "priority"], ["type", "status"]]);

      const failure = await query("type=task OR").catch(error => error);
      expect(failure).toBeInstanceOf(OutlinerRequestError);
      expect(failure.problem).toEqual({ code: "query-syntax", field: "expression", position: 12, message: expect.stringContaining("at character 13") });
      const invalid = await client.request<never>({ action: "blocks.query", query: { where: { kind: "time", field: "updated", op: ">", value: "soon" }, limit: 5 } })
        .catch((error: OutlinerRequestError) => error);
      expect(invalid.problem).toEqual({ code: "query-invalid", message: expect.stringContaining("Invalid time value") });

      const view = await create("Active review [type::virtual-branch] [query::type=task (work-stage=review OR work-stage=validate OR NOT status)] [limit::2]");
      await client.request({ action: "virtual.occurrences.reorder", viewId: view.id, orderedBlockIds: [validate.id] });
      const read = await readSavedView(client, view.id);
      expect([read.status, names(read), read.total, read.completeness]).toEqual(["ready", ["Validate card", "Review card"], 2, { kind: "complete" }]);
      const recent = await create("Recent [type::virtual-branch] [query::type=task updated >= 2026-09-21] [sort::updated] [direction::asc]");
      expect(names(await readSavedView(client, recent.id))).toEqual(["Done card", "Review card"]);
      const broken = await create("Broken [type::virtual-branch] [query::type=task OR (status=done]");
      const brokenRead = await readSavedView(client, broken.id);
      expect([brokenRead.status, brokenRead.blocks]).toEqual(["invalid", []]);
      expect(brokenRead.problems).toEqual([{ code: "view-invalid", property: "query", position: 13, message: expect.stringContaining("Unclosed (") }]);
      const trash = await create("Trash copy [type::virtual-branch] [query::deleted=true]");
      await client.request({ action: "delete", blockId: queued.id });
      expect(names(await readSavedView(client, trash.id))).toEqual(["Queued card"]);
    } finally {
      await server.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ranked views with expressions keep manual ranks first, then canonical order", async () => {
    const root = mkdtempSync(join(tmpdir(), "query-expression-rank-"));
    const store = new OutlinerStore(join(root, "outline.sqlite"));
    try {
      const view = store.create("Lane [type::virtual-branch] [query::lane=a OR lane=b]");
      const parent = store.create("Parent [lane::a]");
      const child = store.create("Child [lane::b]", parent.id);
      const second = store.create("Second [lane::a]");
      const third = store.create("Third [lane::b]");
      store.reorderVirtualOccurrences(view.id, [third.id, child.id]);
      const read = store.readSavedView(view.id);
      expect(read.blocks.map(block => block.id)).toEqual([third.id, child.id, parent.id, second.id]);
      // The same order the ranked SQL path produces for an equivalent single clause.
      const flat = store.queryBlocks({ filters: [{ key: "lane" }], rankViewId: view.id, limit: 10 });
      expect(read.blocks.map(block => block.id)).toEqual(flat.blocks.filter(block => block.id !== view.id).map(block => block.id));
      expect(store.virtualBranchOrder(view.id).blockIds).toEqual(read.blocks.map(block => block.id));
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("roadmap receipts list the same OR and NOT views that views.read lists", () => {
    const root = mkdtempSync(join(tmpdir(), "query-expression-receipt-"));
    const store = new OutlinerStore(join(root, "outline.sqlite"));
    try {
      store.configureWorkIdPrefix("DEMO");
      store.create("Sample work [type::work-queue] [project::sample]");
      const either = store.create("Triage [type::virtual-branch] [query::work-stage=unprioritized OR work-stage=review]");
      const notDone = store.create("Open [type::virtual-branch] [query::type=roadmap-item NOT work-stage=done]");
      const unowned = store.create("Unowned [type::virtual-branch] [query::type=roadmap-item NOT owner]");
      const recent = store.create("Recent [type::virtual-branch] [query::type=roadmap-item updated >= -1d]");
      const excluded = store.create("Done [type::virtual-branch] [query::type=roadmap-item NOT (work-stage=unprioritized OR work-stage=review)]");
      const invalid = store.create("Broken [type::virtual-branch] [query::(work-stage=review]");
      const receipt = store.createRoadmapItem({ title: "Sample item", priority: "medium", project: "sample", arc: "sample-arc", tracks: ["sample"] });
      const expected = [either, notDone, unowned, recent].map(view => ({ viewId: view.id, title: view.text.split(" [")[0] }));
      expect(receipt.memberships).toEqual(expected);
      // Receipts and views.read agree for every view, including the excluded and invalid ones.
      for (const view of [either, notDone, unowned, recent, excluded, invalid]) {
        const read = store.readSavedView(view.id);
        const listed = read.blocks.some(block => block.id === receipt.block.id);
        expect([view.text, listed]).toEqual([view.text, receipt.memberships.some(entry => entry.viewId === view.id)]);
      }
      expect(store.readSavedView(invalid.id).status).toBe("invalid");
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
