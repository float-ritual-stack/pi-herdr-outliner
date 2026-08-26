import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROPERTY_PARSER_VERSION } from "../src/properties";
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
    const workspace = store
      .traversePreorder({ collapsedDescendants: "prune" })
      .find((block) => block.properties.some((property) => property.value === "workspace"));
    expect(workspace).toBeDefined();

    store.create("Choose protocol [type::question] [status::open]", workspace!.id, "agent");
    store.create("Resolved question [type::question] [status::answered]", workspace!.id, "user");

    const matches = store.queryBlocks({
      filters: [
        { key: "type", value: "question" },
        { key: "status", value: "open" },
      ],
      limit: 10,
    }).blocks;
    expect(matches).toHaveLength(1);
    expect(matches[0].text).toContain("Choose protocol");
    expect(matches[0].author).toBe("agent");
  });

  test("keeps literal property examples out of indexed queries", () => {
    const store = makeStore();
    const block = store.create([
      "Examples `[status::inline]`",
      String.raw`Escaped \[status::escaped]`,
      "```text",
      "[status::fenced]",
      "```",
      "[status::real]",
    ].join("\n"));

    expect(store.require(block.id).properties).toEqual([{ key: "status", value: "real" }]);
    for (const value of ["inline", "escaped", "fenced"]) {
      expect(store.queryBlocks({
        filters: [{ key: "status", value }],
        limit: 10,
      }).blocks).toEqual([]);
    }
    expect(store.queryBlocks({
      filters: [{ key: "status", value: "real" }],
      limit: 10,
    }).blocks.map(({ id }) => id)).toContain(block.id);
  });

  test("preserves multiline block content and indexes properties across lines", () => {
    const store = makeStore();
    const text = `Investigation notes
[type::progress] [status::active]
Second paragraph`;
    const block = store.create(text, null, "agent");

    expect(store.require(block.id).text).toBe(text);
    expect(
      store.queryBlocks({
        filters: [
          { key: "type", value: "progress" },
          { key: "status", value: "active" },
        ],
        limit: 10,
      }).blocks[0].id,
    ).toBe(block.id);
  });

  test("persists the multiline expansion state independently from block content", () => {
    const store = makeStore();
    const block = store.create("First line\nSecond line");

    expect(
      store
        .traversePreorder({ collapsedDescendants: "prune" })
        .find((candidate) => candidate.id === block.id)?.multilineExpanded,
    ).toBe(false);
    expect(store.toggleMultilineExpanded(block.id)).toBe(true);
    expect(
      store
        .traversePreorder({ collapsedDescendants: "prune" })
        .find((candidate) => candidate.id === block.id)?.multilineExpanded,
    ).toBe(true);
    expect(store.toggleMultilineExpanded(block.id)).toBe(false);
  });

  test("retains nonmatching branch ranks and cascades ranks with either endpoint", () => {
    let store = makeStore();
    const view = store.create(
      "Next [type::virtual-branch] [query::status=next]",
    );
    const first = store.create("First [status::next]");
    const nonmatching = store.create("Hidden [status::doing]");
    const second = store.create("Second [status::next]");

    expect(
      store.reorderVirtualOccurrences(view.id, [first.id, nonmatching.id, second.id]),
    ).toEqual([
      { viewId: view.id, blockId: first.id, rank: 0 },
      { viewId: view.id, blockId: nonmatching.id, rank: 1 },
      { viewId: view.id, blockId: second.id, rank: 2 },
    ]);
    const persistedStore = stores.at(-1)!;
    store.close();
    store = new OutlinerStore(join(persistedStore.directory, "outliner.sqlite"));
    persistedStore.store = store;
    expect(store.readWorkspaceSnapshot().virtualOccurrenceRanks).toEqual([
      { viewId: view.id, blockId: first.id, rank: 0 },
      { viewId: view.id, blockId: nonmatching.id, rank: 1 },
      { viewId: view.id, blockId: second.id, rank: 2 },
    ]);
    store.reorderVirtualOccurrences(view.id, [second.id, first.id]);
    expect(store.readWorkspaceSnapshot().virtualOccurrenceRanks).toEqual([
      { viewId: view.id, blockId: second.id, rank: 0 },
      { viewId: view.id, blockId: nonmatching.id, rank: 1 },
      { viewId: view.id, blockId: first.id, rank: 2 },
    ]);
    const newlyMatching = store.create("New [status::next]");
    const ranked = store.queryBlocks({
      filters: [{ key: "status", value: "next" }],
      rankViewId: view.id,
      limit: 2,
    });
    expect(ranked.blocks.map((block) => block.id)).toEqual([second.id, first.id]);
    expect(ranked.completeness).toEqual({ kind: "truncated", limit: 2 });
    expect(ranked.blocks.some((block) => block.id === newlyMatching.id)).toBe(false);
    expect(() =>
      store.reorderVirtualOccurrences(view.id, [first.id, first.id])
    ).toThrow("duplicate block IDs");
    expect(() =>
      store.reorderVirtualOccurrences(first.id, [second.id])
    ).toThrow("not a virtual branch");

    store.delete(first.id);
    expect(store.readWorkspaceSnapshot().virtualOccurrenceRanks).toEqual([
      { viewId: view.id, blockId: second.id, rank: 0 },
      { viewId: view.id, blockId: nonmatching.id, rank: 1 },
    ]);
    store.delete(view.id);
    expect(store.readWorkspaceSnapshot().virtualOccurrenceRanks).toEqual([]);
  });

  test("can include descendants of collapsed blocks for completion queries", () => {
    const store = makeStore();
    const parent = store.create("Collapsed parent");
    const child = store.create("Hidden child", parent.id);
    store.toggle(parent.id);

    expect(
      store
        .traversePreorder({ collapsedDescendants: "prune" })
        .some((block) => block.id === child.id),
    ).toBe(false);
    expect(
      store
        .traversePreorder({ collapsedDescendants: "traverse" })
        .some((block) => block.id === child.id),
    ).toBe(true);
  });

  test("traverses a subtree with physical depth and hydrated display metadata", () => {
    const store = makeStore();
    const target = store.create("Referenced title");
    const root = store.create("Subtree root");
    const child = store.create(`See ((${target.id}))`, root.id);

    const rows = store.traversePreorder({
      subtreeRootId: root.id,
      collapsedDescendants: "traverse",
    });
    expect(rows).toEqual([
      expect.objectContaining({
        id: root.id,
        depth: 0,
        hasChildren: true,
      }),
      expect.objectContaining({
        id: child.id,
        depth: 1,
        hasChildren: false,
        displayText: "See ((Referenced title))",
      }),
    ]);
  });

  test("bounds search explicitly and reports when more matching blocks exist", () => {
    const store = makeStore();
    const parent = store.create("Collapsed parent");
    const first = store.create("Matching child one", parent.id);
    const second = store.create("Matching child two", parent.id);
    store.toggle(parent.id);

    expect(store.queryBlocks({ text: "matching child", limit: 1 })).toEqual({
      blocks: [
        expect.objectContaining({
          id: first.id,
          depth: 1,
        }),
      ],
      completeness: { kind: "truncated", limit: 1 },
    });
    expect(store.queryBlocks({ text: "matching child", limit: 2 })).toEqual({
      blocks: [
        expect.objectContaining({ id: first.id }),
        expect.objectContaining({ id: second.id }),
      ],
      completeness: { kind: "complete" },
    });
    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => store.queryBlocks({ text: "matching", limit })).toThrow(
        "Block search limit must be a positive integer",
      );
    }
    expect(() =>
      store.queryBlocks({ text: "matching" } as Parameters<OutlinerStore["queryBlocks"]>[0]),
    ).toThrow("Block search limit must be a positive integer");
  });

  test("reads complete visible and physical snapshots without a row cap", () => {
    const store = makeStore();
    store.database.exec(`
      WITH RECURSIVE roots(n) AS (
        SELECT 1
        UNION ALL
        SELECT n + 1 FROM roots WHERE n < 501
      )
      INSERT INTO blocks (
        id, parent_id, position, text, author, collapsed, created_at, updated_at
      )
      SELECT
        'bulk-root-' || n,
        NULL,
        1000 + n,
        'Bulk root ' || n,
        'user',
        0,
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z'
      FROM roots;
    `);

    const snapshot = store.readWorkspaceSnapshot();
    expect(snapshot.visible.completeness).toEqual({ kind: "complete" });
    expect(snapshot.physical.completeness).toEqual({ kind: "complete" });
    expect(snapshot.visible.blocks).toHaveLength(506);
    expect(snapshot.physical.blocks).toHaveLength(506);
    expect(snapshot.visible.blocks.some((block) => block.id === "bulk-root-501")).toBe(true);
    expect(snapshot.physical.blocks.some((block) => block.id === "bulk-root-501")).toBe(true);
  });

  test("filtered snapshots traverse collapsed ancestors while preserving physical depth", () => {
    const store = makeStore();
    const parent = store.create("Collapsed parent");
    const child = store.create("Filtered child [kind::snapshot-target]", parent.id);
    store.toggle(parent.id);

    const unfiltered = store.readWorkspaceSnapshot();
    expect(unfiltered.visible.blocks.some((block) => block.id === child.id)).toBe(false);
    expect(unfiltered.physical.blocks.find((block) => block.id === child.id)?.depth).toBe(1);

    const filtered = store.readWorkspaceSnapshot({
      filters: [{ key: "kind", value: "snapshot-target" }],
    });
    expect(filtered.visible.blocks).toEqual([
      expect.objectContaining({
        id: child.id,
        depth: 1,
      }),
    ]);
    expect(filtered.physical.blocks.find((block) => block.id === child.id)?.depth).toBe(1);
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

  test("rebuilds property indexes once when the parser schema version is stale", () => {
    const originalStore = makeStore();
    const directory = stores[stores.length - 1].directory;
    const path = join(directory, "outliner.sqlite");
    const block = originalStore.create([
      "Migration target",
      "```ts",
      "[obsolete::literal]",
      "```",
      "[status::current]",
    ].join("\n"));
    const updatedAt = block.updatedAt;

    originalStore.database.query("DELETE FROM block_properties WHERE block_id = ?").run(block.id);
    originalStore.database
      .query(
        "INSERT INTO block_properties (block_id, key, value, ordinal) VALUES (?, 'obsolete', 'literal', 0)",
      )
      .run(block.id);
    originalStore.database
      .query(
        "INSERT INTO metadata (key, value) VALUES ('property_parser_version', '0') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run();
    originalStore.database
      .query("UPDATE metadata SET value = '41' WHERE key = 'sequence'")
      .run();
    originalStore.close();

    const reopened = new OutlinerStore(path);
    stores[stores.length - 1].store = reopened;
    expect(reopened.sequence).toBe(42);
    expect(reopened.require(block.id)).toEqual(
      expect.objectContaining({
        updatedAt,
        properties: [{ key: "status", value: "current" }],
      }),
    );
    expect(reopened.queryBlocks({
      filters: [{ key: "obsolete", value: "literal" }],
      limit: 10,
    }).blocks).toEqual([]);
    expect(reopened.queryBlocks({
      filters: [{ key: "status", value: "current" }],
      limit: 10,
    }).blocks.map(({ id }) => id)).toContain(block.id);
    const versionRow = reopened.database
      .query("SELECT value FROM metadata WHERE key = 'property_parser_version'")
      .get() as { value: string };
    expect(versionRow.value).toBe(String(PROPERTY_PARSER_VERSION));

    reopened.close();
    const reopenedAgain = new OutlinerStore(path);
    stores[stores.length - 1].store = reopenedAgain;
    expect(reopenedAgain.sequence).toBe(42);
    expect(reopenedAgain.require(block.id).updatedAt).toBe(updatedAt);
  });

  test("reindexes existing blocks when the parser version metadata is missing", () => {
    const store = makeStore();
    const directory = stores[stores.length - 1].directory;
    const path = join(directory, "outliner.sqlite");
    const block = store.create("Existing [status::open]");
    store.database.query("DELETE FROM metadata WHERE key = 'property_parser_version'").run();
    store.database.query("UPDATE metadata SET value = '9' WHERE key = 'sequence'").run();
    store.close();

    const reopened = new OutlinerStore(path);
    stores[stores.length - 1].store = reopened;
    expect(reopened.sequence).toBe(10);
    expect(reopened.require(block.id)).toEqual(
      expect.objectContaining({
        updatedAt: block.updatedAt,
        properties: [{ key: "status", value: "open" }],
      }),
    );
  });

  test("rejects databases from a newer property parser schema", () => {
    const store = makeStore();
    const directory = stores[stores.length - 1].directory;
    const path = join(directory, "outliner.sqlite");
    store.database
      .query("UPDATE metadata SET value = ? WHERE key = 'property_parser_version'")
      .run(String(PROPERTY_PARSER_VERSION + 1));
    store.close();

    expect(() => new OutlinerStore(path)).toThrow("newer than supported");
    stores.pop();
    rmSync(directory, { recursive: true, force: true });
  });

});
