import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutlinerStore } from "../src/store";

const stores: Array<{ store: OutlinerStore; directory: string }> = [];

function makeStore(): OutlinerStore {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  stores.push({ store, directory });
  return store;
}

afterEach(() => {
  for (const entry of stores.splice(0)) {
    entry.store.close();
    rmSync(entry.directory, { recursive: true, force: true });
  }
});

describe("OutlinerStore", () => {
  test("indexes inline properties and combines filters", () => {
    const store = makeStore();
    const workspace = store.list().find((block) => block.properties.some((property) => property.value === "workspace"));
    expect(workspace).toBeDefined();

    store.create("Choose protocol [type::question] [status::open]", workspace!.id, "agent");
    store.create("Resolved question [type::question] [status::answered]", workspace!.id, "user");

    const matches = store.list({
      filters: [
        { key: "type", value: "question" },
        { key: "status", value: "open" },
      ],
    });
    expect(matches).toHaveLength(1);
    expect(matches[0].text).toContain("Choose protocol");
    expect(matches[0].author).toBe("agent");
  });

  test("preserves multiline block content and indexes properties across lines", () => {
    const store = makeStore();
    const text = `Investigation notes
[type::progress] [status::active]
Second paragraph`;
    const block = store.create(text, null, "agent");

    expect(store.require(block.id).text).toBe(text);
    expect(
      store.list({
        filters: [
          { key: "type", value: "progress" },
          { key: "status", value: "active" },
        ],
      })[0].id,
    ).toBe(block.id);
  });

  test("persists the multiline expansion state independently from block content", () => {
    const store = makeStore();
    const block = store.create("First line\nSecond line");

    expect(store.list().find((candidate) => candidate.id === block.id)?.multilineExpanded).toBe(false);
    expect(store.toggleMultilineExpanded(block.id)).toBe(true);
    expect(store.list().find((candidate) => candidate.id === block.id)?.multilineExpanded).toBe(true);
    expect(store.toggleMultilineExpanded(block.id)).toBe(false);
  });

  test("can include descendants of collapsed blocks for completion queries", () => {
    const store = makeStore();
    const parent = store.create("Collapsed parent");
    const child = store.create("Hidden child", parent.id);
    store.toggle(parent.id);

    expect(store.list().some((block) => block.id === child.id)).toBe(false);
    expect(store.list({ includeCollapsed: true }).some((block) => block.id === child.id)).toBe(true);
  });

  test("resolves references for display without changing canonical block text", () => {
    const store = makeStore();
    const target = store.create("Decision title [type::decision]");
    const rawText = `See ((${target.id}))`;
    const source = store.create(rawText);

    expect(store.resolveBlockReferences(source.text)).toBe("See ((Decision title))");
    expect(store.require(source.id).text).toBe(rawText);
  });

  test("patches properties optimistically and catalogs observed values", () => {
    const store = makeStore();
    const first = store.create("First [status::open] [type::task]");
    store.create("Second [status::open] [type::task]");
    store.create("Third [status::done] [type::task]");
    expect(() => store.patchProperties(first.id, first.updatedAt, [])).toThrow(
      "requires at least one operation",
    );
    expect(store.require(first.id).updatedAt).toBe(first.updatedAt);

    const patched = store.patchProperties(first.id, first.updatedAt, [
      { op: "replace", ordinal: 0, value: "doing" },
      { op: "append", key: "owner", value: "evan" },
    ]);
    expect(patched.text).toBe("First [status::doing] [type::task]\n[owner::evan]");
    expect(store.propertyCatalog("status")).toEqual([
      { key: "status", value: "open", count: 2 },
      { key: "status", value: "doing", count: 1 },
      { key: "status", value: "done", count: 1 },
    ]);
    expect(store.propertyCatalog("status", "do")).toEqual([
      { key: "status", value: "doing", count: 1 },
      { key: "status", value: "done", count: 1 },
    ]);
    store.create("Percent [status::100%]");
    expect(store.propertyCatalog("status", "100%")).toEqual([
      { key: "status", value: "100%", count: 1 },
    ]);
    expect(() =>
      store.patchProperties(first.id, first.updatedAt, [{ op: "append", key: "late", value: "no" }]),
    ).toThrow("Block changed since editing began");
  });

  test("rejects a stale editor save instead of overwriting a newer change", () => {
    const store = makeStore();
    const original = store.create("Original");
    const updated = store.update(original.id, "Agent update", original.updatedAt);

    expect(() => store.update(original.id, "Stale user edit", original.updatedAt)).toThrow(
      "Block changed since editing began",
    );
    expect(store.require(original.id).text).toBe("Agent update");
    expect(updated.updatedAt).not.toBe(original.updatedAt);
  });

  test("moves blocks without allowing hierarchy cycles", () => {
    const store = makeStore();
    const root = store.create("Root");
    const child = store.create("Child", root.id);
    const sibling = store.create("Sibling");

    expect(store.move(sibling.id, child.id).parentId).toBe(child.id);
    expect(() => store.move(root.id, sibling.id)).toThrow("beneath itself");
  });

  test("reorders root siblings at final zero-based positions", () => {
    const store = makeStore();
    const first = store.create("First root");
    const second = store.create("Second root");
    const third = store.create("Third root");

    const original = store.children(null);
    store.move(third.id, null, original.findIndex((block) => block.id === second.id));
    expect(
      store
        .children(null)
        .filter((block) => [first.id, second.id, third.id].includes(block.id))
        .map((block) => block.id),
    ).toEqual([first.id, third.id, second.id]);

    const reordered = store.children(null);
    store.move(first.id, null, reordered.findIndex((block) => block.id === first.id) + 1);
    expect(
      store
        .children(null)
        .filter((block) => [first.id, second.id, third.id].includes(block.id))
        .map((block) => block.id),
    ).toEqual([third.id, first.id, second.id]);
  });

  test("reorders nested siblings without changing their parent", () => {
    const store = makeStore();
    const parent = store.create("Parent");
    const first = store.create("First child", parent.id);
    const second = store.create("Second child", parent.id);
    const third = store.create("Third child", parent.id);

    store.move(second.id, parent.id, 0);
    store.move(first.id, parent.id, 2);

    const children = store.children(parent.id);
    expect(children.map((block) => block.id)).toEqual([second.id, third.id, first.id]);
    expect(children.every((block) => block.parentId === parent.id)).toBe(true);
  });

  test("returns selected block context", () => {
    const store = makeStore();
    const root = store.create("Task [type::task]");
    const question = store.create("Need input [type::question] [status::open]", root.id, "agent");
    store.create("Option A", question.id);
    store.setSelection(question.id);

    const context = store.getSelection();
    expect(context.selected?.id).toBe(question.id);
    expect(context.ancestors.at(-1)?.id).toBe(root.id);
    expect(context.children.map((block) => block.text)).toEqual(["Option A"]);
  });
});
