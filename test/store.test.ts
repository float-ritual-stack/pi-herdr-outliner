import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  annotationSourceHash,
  createTextQuoteAnchor,
} from "../src/annotations";
import { PROPERTY_PARSER_VERSION } from "../src/properties";
import { PAGE_ADDRESS_REGISTRY_VERSION } from "../src/page-addresses";
import { OutlinerStore } from "../src/store";
import type {
  AnnotationCreateInput,
  AnnotationRepresentation,
  AnnotationTarget,
  Block,
  RenderedPassageObservation,
} from "../src/types";
import {
  isVirtualBranchOccurrence,
  projectVirtualBranches,
} from "../src/virtual-branches";

const stores: Array<{ store: OutlinerStore; directory: string }> = [];

function makeStore(): OutlinerStore {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  stores.push({ store, directory });
  return store;
}
function insertIndexedProperty(
  store: OutlinerStore,
  blockId: string,
  key: string,
  value: string,
  ordinal: number,
): void {
  const raw = `[${key}::${value}]`;
  store.database.query(
    "INSERT INTO block_properties (block_id, key, value, ordinal, raw, start, end, line, column, placement, scope, syntax) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'metadata-line', 'block', 'bracket')",
  ).run(blockId, key, value, ordinal, raw, ordinal * 100, ordinal * 100 + raw.length, ordinal);
}

function blockAnnotationRepresentation(
  block: Block,
  id: string,
): AnnotationRepresentation {
  const contentHash = annotationSourceHash(block.text);
  return {
    id,
    subject: { kind: "block", blockId: block.id },
    sourceSnapshot: {
      kind: "block",
      blockId: block.id,
      updatedAt: block.updatedAt,
      contentHash,
    },
    adapter: null,
    mediaType: "text/plain",
    contentHash,
    capturedAt: block.updatedAt,
  };
}

function blockAnnotationTarget(
  block: Block,
  start: number,
  end: number,
  representationId: string,
): AnnotationTarget {
  return {
    representation: blockAnnotationRepresentation(block, representationId),
    anchor: createTextQuoteAnchor(block.text, start, end),
  };
}


afterEach(() => {
  for (const entry of stores.splice(0)) {
    entry.store.close();
    rmSync(entry.directory, { recursive: true, force: true });
  }
});

describe("OutlinerStore", () => {
  test("creates one immutable delivery identity per task and delivery key", () => {
    const store = makeStore();
    const task = store.create(
      "PIE-182 lifecycle [type::roadmap-item] [work-id::PIE-182] [work-stage::next]",
    );
    const input = {
      taskBlockId: task.id,
      deliveryKey: "PIE-182/enforcement",
      repository: "float-ritual-stack/pi-herdr-outliner",
      baseBranch: "main",
      workBranch: "feature/pie-182-lifecycle-enforcement",
    };

    const created = store.ensureDelivery(input, "agent", {
      actorId: "omp",
      sessionId: "session-1",
      taskId: "start",
    });
    expect(created.created).toBe(true);
    expect(created.delivery.parentId).toBe(task.id);
    expect(created.delivery.properties).toEqual([
      { key: "type", value: "delivery" },
      { key: "delivery-key", value: "PIE-182/enforcement" },
      { key: "repository", value: "float-ritual-stack/pi-herdr-outliner" },
      { key: "base-branch", value: "main" },
      { key: "work-branch", value: "feature/pie-182-lifecycle-enforcement" },
      { key: "delivery-stage", value: "work" },
    ]);
    expect(created.delivery.properties.some((property) => property.key === "work-id")).toBe(false);

    const reused = store.ensureDelivery(input);
    expect(reused.created).toBe(false);
    expect(reused.delivery.id).toBe(created.delivery.id);
    expect(() => store.ensureDelivery({
      ...input,
      workBranch: "feature/pie-182-conflict",
    })).toThrow("Delivery PIE-182/enforcement has conflicting work-branch");
    expect(() => store.ensureDelivery({
      ...input,
      deliveryKey: "PIE-182/invalid",
      workBranch: "feature//pie-182",
    })).toThrow("Invalid delivery work branch");
  });

  test("indexes inline properties and combines filters", () => {
    const store = makeStore();
    const workspace = store
      .traversePreorder({})
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

  test("normalizes exact spaced filters and combines them with text and subtree scope", () => {
    const store = makeStore();
    const firstRoot = store.create("First query root");
    const secondRoot = store.create("Second query root");
    const alpha = store.create(
      "Alpha route snapshot [status::in progress] [project::pi-outliner]",
      firstRoot.id,
    );
    store.create(
      "Beta route snapshot [status::in review] [project::pi-outliner]",
      firstRoot.id,
    );
    store.create(
      "Gamma route snapshot [status::in progress] [project::other]",
      secondRoot.id,
    );

    const result = store.queryBlocks({
      filters: [
        { key: " STATUS ", value: " in progress " },
        { key: "status", value: "IN PROGRESS" },
        { key: "project", value: "PI-OUTLINER" },
      ],
      text: "route snapshot",
      subtreeRootId: firstRoot.id,
      limit: 20,
    });
    expect(result).toEqual({
      blocks: [expect.objectContaining({ id: alpha.id, depth: 1 })],
      completeness: { kind: "complete" },
    });
    expect(() => store.queryBlocks({
      subtreeRootId: "missing-query-root",
      limit: 20,
    })).toThrow("Block not found: missing-query-root");
  });

  test("sorts by created or updated time before applying the query limit", () => {
    const store = makeStore();
    const root = store.create("Timestamp query root");
    const first = store.create("Timestamp match first", root.id);
    const second = store.create("Timestamp match second", root.id);
    const third = store.create("Timestamp match third", root.id);
    const timestamps = [
      [first.id, "2026-01-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z"],
      [second.id, "2026-02-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
      [third.id, "2026-03-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z"],
    ] as const;
    for (const [id, createdAt, updatedAt] of timestamps) {
      store.database.query(
        "UPDATE blocks SET created_at = ?, updated_at = ? WHERE id = ?",
      ).run(createdAt, updatedAt, id);
    }

    const newestCreated = store.queryBlocks({
      text: "Timestamp match",
      subtreeRootId: root.id,
      sort: { field: "created", direction: "desc" },
      limit: 2,
    });
    expect(newestCreated.blocks.map((block) => block.id)).toEqual([third.id, second.id]);
    expect(newestCreated.completeness).toEqual({ kind: "truncated", limit: 2 });

    const oldestUpdated = store.readWorkspaceSnapshot({
      query: {
        text: "Timestamp match",
        subtreeRootId: root.id,
        sort: { field: "updated", direction: "asc" },
        limit: 2,
      },
    });
    expect(oldestUpdated.visible.blocks.map((block) => block.id)).toEqual([
      second.id,
      third.id,
    ]);
    expect(oldestUpdated.visible.completeness).toEqual({ kind: "truncated", limit: 2 });
  });


  test("captures idempotently into one canonical Inbox without moving selection", () => {
    const store = makeStore();
    const source = store.create("Deep source");
    store.setSelection(source.id);

    const receipt = store.capture(
      "capture-request-1",
      "First line\nSecond line",
      "tree",
      source.id,
    );
    const inbox = store.queryBlocks({
      filters: [{ key: "system-view", value: "inbox" }],
      limit: 2,
    }).blocks;
    expect(inbox).toHaveLength(1);
    expect(receipt).toEqual({
      block: expect.objectContaining({
        parentId: inbox[0]!.id,
        author: "user",
        text: expect.stringMatching(
          /^First line \[type::capture] .*\nSecond line$/,
        ),
        properties: expect.arrayContaining([
          { key: "type", value: "capture" },
          { key: "status", value: "unprocessed" },
          { key: "capture-source", value: "tree" },
          { key: "captured-from", value: source.id },
        ]),
      }),
      inboxBlockId: inbox[0]!.id,
      deduplicated: false,
    });
    expect(receipt.block.properties.find((property) => property.key === "captured-at")?.value)
      .toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(store.getSelection().selected?.id).toBe(source.id);

    const replay = store.capture(
      "capture-request-1",
      "First line\nSecond line",
      "tree",
      source.id,
    );
    expect(replay).toEqual({
      block: expect.objectContaining({ id: receipt.block.id }),
      inboxBlockId: inbox[0]!.id,
      deduplicated: true,
    });
    expect(store.children(inbox[0]!.id).map((block) => block.id)).toEqual([receipt.block.id]);
    expect(store.getSelection().selected?.id).toBe(source.id);
  });

  test("inserts first-time captures at the top without repositioning replays", () => {
    const store = makeStore();
    const inbox = store.queryBlocks({
      filters: [{ key: "system-view", value: "inbox" }],
      limit: 2,
    }).blocks[0]!;
    const existing = store.create("Existing Inbox child", inbox.id);

    const first = store.capture("capture-newest-1", "First capture", "cli");
    const second = store.capture("capture-newest-2", "Second capture", "pi");
    expect(store.children(inbox.id).map((block) => block.id)).toEqual([
      second.block.id,
      first.block.id,
      existing.id,
    ]);
    expect(store.children(inbox.id).map((block) => block.position)).toEqual([0, 1, 2]);

    const replay = store.capture("capture-newest-1", "First capture", "cli");
    expect(replay.deduplicated).toBe(true);
    expect(replay.block.id).toBe(first.block.id);
    expect(store.children(inbox.id).map((block) => block.id)).toEqual([
      second.block.id,
      first.block.id,
      existing.id,
    ]);
  });

  test("preserves CRLF capture boundaries without adding a carriage return to the title", () => {
    const store = makeStore();

    const receipt = store.capture("capture-request-crlf", "First line\r\nSecond line", "cli");

    expect(receipt.block.text).toMatch(
      /^First line \[type::capture] .*\r\nSecond line$/,
    );
    expect(receipt.block.text).not.toContain("First line\r ");
  });

  test("retitles captures without changing metadata, body, position, or stale revisions", () => {
    const store = makeStore();
    const receipt = store.capture(
      "capture-retitle",
      "Incidental opening\r\nBody with [literal] text",
      "omp",
      undefined,
      "agent",
      { actorId: "omp", sessionId: "session" },
    );
    const originalPosition = receipt.block.position;
    const originalProperties = receipt.block.properties;

    const retitled = store.retitleCapture(
      receipt.block.id,
      receipt.block.updatedAt,
      "Concise generated title",
      { author: "agent", actorId: "omp", sessionId: "session" },
    );
    expect(retitled.text).toBe(
      `Concise generated title ${
        receipt.block.text.slice(receipt.block.text.indexOf("[type::capture]"))
      }`,
    );
    expect(retitled.text).toContain("\r\nBody with [literal] text");
    expect(retitled.properties).toEqual(originalProperties);
    expect(retitled.position).toBe(originalPosition);
    expect(retitled.author).toBe("agent");

    expect(() =>
      store.retitleCapture(
        receipt.block.id,
        receipt.block.updatedAt,
        "Stale replacement",
        { author: "agent", actorId: "omp" },
      )
    ).toThrow("Block changed since editing began");
    expect(() =>
      store.retitleCapture(
        receipt.block.id,
        retitled.updatedAt,
        "Invalid [status::title]",
        { author: "agent", actorId: "omp" },
      )
    ).toThrow("Capture title must be 1-120 plain printable characters");
    expect(store.require(receipt.block.id).text).toBe(retitled.text);
  });

  test("retains one revision-safe Quick Capture draft across popup restarts", () => {
    let store = makeStore();
    const entry = stores.at(-1)!;
    const source = store.create("Original capture context");
    const first = store.saveQuickCaptureDraft({
      requestId: "quick-capture-request",
      text: "First line\nSecond line",
      cursorRow: 1,
      cursorColumn: 6,
      capturedFromBlockId: source.id,
      expectedRevision: null,
    });
    expect(first).toMatchObject({
      requestId: "quick-capture-request",
      text: "First line\nSecond line",
      cursorRow: 1,
      cursorColumn: 6,
      capturedFromBlockId: source.id,
      revision: 1,
    });

    store.close();
    store = new OutlinerStore(join(entry.directory, "outliner.sqlite"));
    entry.store = store;
    expect(store.quickCaptureDraft()).toEqual(first);

    const second = store.saveQuickCaptureDraft({
      requestId: first.requestId,
      text: "First line\nSecond line revised",
      cursorRow: 1,
      cursorColumn: 19,
      capturedFromBlockId: first.capturedFromBlockId,
      expectedRevision: first.revision,
    });
    expect(second.revision).toBe(2);
    expect(() =>
      store.saveQuickCaptureDraft({
        requestId: first.requestId,
        text: "Stale writer",
        cursorRow: 0,
        cursorColumn: 12,
        expectedRevision: first.revision,
      })
    ).toThrow("Quick Capture draft changed");
    expect(() => store.clearQuickCaptureDraft(first.revision)).toThrow(
      "Quick Capture draft changed",
    );
    expect(store.clearQuickCaptureDraft(second.revision)).toBeNull();
    expect(store.quickCaptureDraft()).toBeNull();
  });

  test("rejects invalid capture input and ambiguous Inbox markers without partial writes", () => {
    const store = makeStore();
    const inbox = store.queryBlocks({
      filters: [{ key: "system-view", value: "inbox" }],
      limit: 2,
    }).blocks[0]!;
    expect(() => store.capture(42 as never, "Text", "tree")).toThrow(
      "Capture requestId must be 1-200 printable characters",
    );
    expect(() => store.capture("bad-text", 42 as never, "tree")).toThrow(
      "Capture text must be a string",
    );
    expect(() => store.capture("bad-from", "Text", "tree", 42 as never)).toThrow(
      "Capture capturedFromBlockId must be a string",
    );
    expect(() => store.capture("empty", "   ", "tree")).toThrow("Capture text cannot be empty");
    expect(() => store.capture("bad\nid", "Text", "tree")).toThrow(
      "Capture requestId must be 1-200 printable characters",
    );
    expect(() => store.capture("bad-source", "Text", "unknown" as never)).toThrow(
      "Invalid capture source: unknown",
    );
    expect(() => store.capture("missing-source", "Text", "tree", "missing-block")).toThrow(
      "Block not found: missing-block",
    );
    store.create("Other Inbox [system-view::inbox]");
    expect(() => store.capture("ambiguous", "Text", "tree")).toThrow(
      "Workspace must contain exactly one active [system-view::inbox]; found 2",
    );
    expect(store.children(inbox.id)).toEqual([]);
  });
  test("keeps property-shaped literals out and exposes explicit inline matches", () => {
    const store = makeStore();
    const block = store.create([
      "Examples `[status::inline-literal]`",
      String.raw`Escaped \[status::escaped]`,
      "```text",
      "[status::fenced]",
      "```",
      "[status::body-inline]",
    ].join("\n"));

    expect(store.require(block.id).properties).toEqual([]);
    for (const value of ["inline-literal", "escaped", "fenced", "body-inline"]) {
      expect(store.queryBlocks({
        filters: [{ key: "status", value }],
        limit: 10,
      }).blocks).toEqual([]);
    }
    const explicit = store.queryBlocks({
      filters: [{ key: "status", value: "body-inline" }],
      propertyScope: "inline",
      limit: 10,
    }).blocks;
    expect(explicit).toEqual([
      expect.objectContaining({
        id: block.id,
        propertyMatches: [
          expect.objectContaining({
            key: "status",
            value: "body-inline",
            ordinal: 0,
            line: 5,
            scope: "inline",
          }),
        ],
      }),
    ]);
  });

  test("queries and catalogs line and inline properties only when requested", () => {
    const store = makeStore();
    const block = store.create([
      "Scoped [kind::scope-test]",
      "",
      "Body [status::body-only]",
      "owner:: scoped-owner",
    ].join("\n"));
    const rankView = store.create("Scoped rank [type::virtual-branch]");

    expect(store.require(block.id).properties).toEqual([
      { key: "kind", value: "scope-test" },
    ]);
    for (const filter of [
      { key: "status", value: "body-only" },
      { key: "owner", value: "scoped-owner" },
    ]) {
      expect(store.queryBlocks({ filters: [filter], limit: 10 }).blocks).toEqual([]);
    }
    expect(store.queryBlocks({
      filters: [{ key: "status", value: "body-only" }],
      propertyScope: "inline",
      rankViewId: rankView.id,
      limit: 10,
    }).blocks).toEqual([
      expect.objectContaining({
        id: block.id,
        propertyMatches: [
          expect.objectContaining({ key: "status", scope: "inline", line: 2 }),
        ],
      }),
    ]);
    expect(store.queryBlocks({
      filters: [{ key: "owner", value: "scoped-owner" }],
      propertyScope: "line",
      limit: 10,
    }).blocks).toEqual([
      expect.objectContaining({
        id: block.id,
        propertyMatches: [
          expect.objectContaining({ key: "owner", scope: "line", line: 3 }),
        ],
      }),
    ]);
    expect(store.queryBlocks({
      filters: [
        { key: "status", value: "body-only" },
        { key: "owner", value: "scoped-owner" },
      ],
      propertyScope: "all",
      limit: 10,
    }).blocks).toEqual([
      expect.objectContaining({
        id: block.id,
        propertyMatches: [
          expect.objectContaining({ key: "status", scope: "inline" }),
          expect.objectContaining({ key: "owner", scope: "line" }),
        ],
      }),
    ]);
    expect(store.propertyCatalog("status", "body-only")).toEqual([]);
    expect(store.propertyCatalog("status", "body-only", 50, "all")).toEqual([
      { key: "status", value: "body-only", count: 1 },
    ]);
    expect(store.propertyCatalog("owner", "scoped-owner", 50, "line")).toEqual([
      { key: "owner", value: "scoped-owner", count: 1 },
    ]);
    expect(() => store.queryBlocks({
      filters: [{ key: "status" }],
      propertyScope: "invalid" as never,
      limit: 10,
    })).toThrow("Invalid property scope: invalid");
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

  test("retires persisted Tree presentation state when opening an existing database", () => {
    const store = makeStore();
    const entry = stores[stores.length - 1]!;
    const path = join(entry.directory, "outliner.sqlite");
    store.close();

    const legacy = new Database(path);
    legacy.exec(`
      ALTER TABLE blocks ADD COLUMN collapsed INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE block_view_state (
        block_id TEXT PRIMARY KEY,
        multiline_expanded INTEGER NOT NULL DEFAULT 0
      );
    `);
    legacy.close();

    const reopened = new OutlinerStore(path);
    entry.store = reopened;
    const blockColumns = reopened.database.query("PRAGMA table_info(blocks)").all() as Array<{
      name: string;
    }>;
    expect(blockColumns.some((column) => column.name === "collapsed")).toBe(false);
    expect(
      reopened.database.query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'block_view_state'",
      ).get(),
    ).toBeNull();
  });

  test("soft-deletes subtrees centrally and restores only non-independent descendants", async () => {
    const store = makeStore();
    const categoryView = store.create(
      "Category [type::virtual-branch] [query::category=trash-test]",
    );
    const parent = store.create("Parent [category::trash-test]");
    const child = store.create("Child [category::trash-test]", parent.id);
    const independentlyDeleted = store.create(
      "Independent [category::trash-test] [work-id::PIE-999]",
      child.id,
    );
    const independentChild = store.create(
      "Independent child [category::trash-test]",
      independentlyDeleted.id,
    );
    const emptyDeleted = store.create("Empty [category::trash-test]");

    store.delete(independentlyDeleted.id);
    const deletedParent = store.delete(parent.id);
    store.delete(emptyDeleted.id);
    expect(deletedParent.deletedAt).toBeDefined();
    expect(deletedParent.effectiveDeletedRootId).toBe(parent.id);
    expect(store.require(child.id).effectiveDeletedRootId).toBe(parent.id);
    expect(store.require(independentlyDeleted.id).effectiveDeletedRootId).toBe(
      independentlyDeleted.id,
    );
    expect(store.require(independentChild.id).effectiveDeletedRootId).toBe(
      independentlyDeleted.id,
    );
    expect(store.readWorkspaceSnapshot().physical.blocks.some((block) =>
      [parent.id, child.id, independentlyDeleted.id].includes(block.id)
    )).toBe(false);
    expect(store.queryBlocks({
      filters: [{ key: "category", value: "trash-test" }],
      limit: 10,
    }).blocks).toEqual([]);
    expect(store.propertyCatalog("category")).not.toContainEqual(
      expect.objectContaining({ value: "trash-test" }),
    );
    expect(() => store.update(child.id, "changed")).toThrow("is in Trash");

    const trashRoots = store.queryBlocks({
      filters: [{ key: "deleted", value: "true" }],
      includeDeleted: "roots",
      limit: 10,
    }).blocks;
    expect(trashRoots.map((block) => block.id)).toEqual([
      parent.id,
      independentlyDeleted.id,
      emptyDeleted.id,
    ]);
    expect(trashRoots[0]?.deletedDescendantCount).toBe(1);
    expect(trashRoots[1]?.deletedDescendantCount).toBe(1);
    expect(trashRoots[2]?.deletedDescendantCount).toBe(0);
    expect(store.queryBlocks({
      filters: [{ key: "deleted", value: "true" }],
      includeDeleted: "roots",
      limit: 1,
    }).blocks).toEqual([
      expect.objectContaining({
        id: parent.id,
        deletedDescendantCount: 1,
      }),
    ]);
    const snapshot = store.readWorkspaceSnapshot();
    const projection = await projectVirtualBranches(
      snapshot.visible.blocks,
      snapshot.physical.blocks,
      async (query) => store.queryBlocks(query),
      snapshot.virtualOccurrenceRanks,
    );
    expect(
      projection.rows
        .filter(isVirtualBranchOccurrence)
        .filter((row) => row.viewId === categoryView.id),
    ).toEqual([]);

    expect(() => store.restore(independentlyDeleted.id)).toThrow(
      `Restore enclosing Trash root first: ${parent.id}`,
    );
    expect(store.queryBlocks({
      filters: [{ key: "deleted", value: "true" }],
      includeDeleted: "roots",
      limit: 10,
    }).blocks.map((block) => block.id)).toContain(independentlyDeleted.id);
    store.restore(parent.id);
    expect(store.readWorkspaceSnapshot().physical.blocks.some((block) => block.id === parent.id))
      .toBe(true);
    expect(store.readWorkspaceSnapshot().physical.blocks.some((block) => block.id === child.id))
      .toBe(true);
    expect(store.readWorkspaceSnapshot().physical.blocks.some((block) =>
      block.id === independentlyDeleted.id
    )).toBe(false);


    expect(() => store.purge(independentlyDeleted.id, "wrong")).toThrow("PIE-999");
    store.purge(independentlyDeleted.id, "PIE-999");
    expect(store.get(independentlyDeleted.id)).toBeNull();
    expect(
      store.database.query("SELECT work_id FROM reserved_work_ids WHERE work_id = ?")
        .get("PIE-999"),
    ).toEqual({ work_id: "PIE-999" });
  });
  test("records bounded selection history with back, forward, and branch truncation", () => {
    const store = makeStore();
    const first = store.create("History first");
    const second = store.create("History second");
    const third = store.create("History third");
    store.setSelection(first.id);
    store.setSelection(second.id);
    store.setSelection(third.id);

    expect(store.navigationState()).toMatchObject({
      selection: { selected: { id: third.id } },
      canBack: true,
      canForward: false,
    });
    expect(store.navigateHistory("back")).toMatchObject({
      selection: { selected: { id: second.id } },
      canBack: true,
      canForward: true,
    });
    expect(store.navigateHistory("back")).toMatchObject({
      selection: { selected: { id: first.id } },
      canForward: true,
    });
    expect(store.navigateHistory("forward")).toMatchObject({
      selection: { selected: { id: second.id } },
    });

    store.setSelection(first.id);
    expect(store.navigationState().canForward).toBe(false);
    expect(store.navigateHistory("forward").selection.selected?.id).toBe(first.id);

    store.delete(second.id);
    expect(store.navigateHistory("back")).toMatchObject({
      selection: { selected: { id: second.id, effectiveDeletedRootId: second.id } },
      canForward: true,
    });

    const storeEntry = stores.at(-1)!;
    store.close();
    const reopened = new OutlinerStore(join(storeEntry.directory, "outliner.sqlite"));
    storeEntry.store = reopened;
    expect(reopened.navigationState()).toMatchObject({
      selection: { selected: { id: second.id, effectiveDeletedRootId: second.id } },
      canForward: true,
    });
  });

  test("keeps canonical delete independent from replacement navigation", () => {
    const store = makeStore();
    const parent = store.create("History replacement parent");
    const deleted = store.create("History deleted selection", parent.id);
    const replacement = store.create("History replacement", parent.id);
    const destination = store.create("History destination", parent.id);

    store.setSelection(deleted.id);
    store.delete(deleted.id);
    expect(store.getSelection().selected).toMatchObject({
      id: deleted.id,
      effectiveDeletedRootId: deleted.id,
    });

    store.setSelection(replacement.id);
    store.setSelection(destination.id);
    expect(store.navigateHistory("back").selection.selected?.id).toBe(replacement.id);
  });

  test("persists immutable agent provenance while legacy blocks remain coarse", () => {
    let store = makeStore();
    const agentBlock = store.create(
      "Agent artifact",
      null,
      "agent",
      {
        actorId: " omp ",
        sessionId: " session-1 ",
        taskId: " tool-call-1 ",
      },
    );
    expect(agentBlock).toEqual(expect.objectContaining({
      author: "agent",
      actorId: "omp",
      sessionId: "session-1",
      taskId: "tool-call-1",
    }));
    const updated = store.update(agentBlock.id, "Updated artifact", agentBlock.updatedAt);
    expect(updated).toEqual(expect.objectContaining({
      actorId: "omp",
      sessionId: "session-1",
      taskId: "tool-call-1",
    }));

    const humanBlock = store.create("Human note");
    expect("actorId" in humanBlock).toBe(false);
    expect(() =>
      store.create("Spoofed", null, "user", { actorId: "agent" })
    ).toThrow("Only agent-authored blocks");
    expect(() =>
      store.create("Missing actor", null, "agent", { actorId: " " })
    ).toThrow("actorId cannot be empty");

    const storeEntry = stores.at(-1)!;
    store.close();
    store = new OutlinerStore(join(storeEntry.directory, "outliner.sqlite"));
    storeEntry.store = store;
    expect(store.require(agentBlock.id)).toEqual(expect.objectContaining({
      actorId: "omp",
      sessionId: "session-1",
      taskId: "tool-call-1",
    }));
  });

  test("queries distinct recent edits by mutation provenance and advances a cursor", () => {
    const store = makeStore();
    const agentCreated = store.create("Agent-created note", null, "agent", { actorId: "omp" });
    const userCreated = store.create("User-created note");
    const other = store.create("Other note [status::open]");

    const firstUserEdit = store.update(
      agentCreated.id,
      "Agent-created note edited by user",
      agentCreated.updatedAt,
      { author: "user", actorId: "detail" },
    );
    store.update(
      userCreated.id,
      "User-created note edited by agent",
      userCreated.updatedAt,
      { author: "agent", actorId: "omp", sessionId: "session-1", taskId: "call-1" },
    );
    const secondUserEdit = store.update(
      agentCreated.id,
      "Newest user text",
      firstUserEdit.updatedAt,
      { author: "user", actorId: "tree" },
    );
    const patched = store.patchProperties(
      other.id,
      other.updatedAt,
      [{ op: "replace", ordinal: 0, value: "done" }],
      { author: "user", actorId: "detail" },
    );

    const page = store.recentEditActivity({ author: "user", limit: 5 });
    expect(page.entries.map((entry) => entry.block.id)).toEqual([other.id, agentCreated.id]);
    expect(page.entries[0]).toMatchObject({
      block: { id: other.id, text: patched.text },
      author: "user",
      actorId: "detail",
      kind: "properties",
    });
    expect(page.entries[1]).toMatchObject({
      block: { id: agentCreated.id, text: secondUserEdit.text },
      author: "user",
      actorId: "tree",
      kind: "text",
    });
    expect(page.entries.every((entry) => entry.block.id !== userCreated.id)).toBe(true);

    const next = store.recentEditActivity({ author: "user", afterCursor: page.cursor });
    expect(next).toEqual({ entries: [], cursor: page.cursor });
    const afterWatermark = store.update(
      userCreated.id,
      "Now edited by user",
      store.require(userCreated.id).updatedAt,
      { author: "user", actorId: "detail" },
    );
    const incremental = store.recentEditActivity({
      author: "user",
      afterCursor: page.cursor,
    });
    expect(incremental.entries).toHaveLength(1);
    expect(incremental.entries[0]?.block).toMatchObject({
      id: userCreated.id,
      text: afterWatermark.text,
    });
    expect(incremental.cursor).toBeGreaterThan(page.cursor);
  });

  test("adds provenance columns to an existing block database", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-outliner-legacy-"));
    const path = join(directory, "outliner.sqlite");
    const legacy = new Database(path, { create: true });
    legacy.exec(`
      CREATE TABLE blocks (
        id TEXT PRIMARY KEY,
        parent_id TEXT REFERENCES blocks(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        text TEXT NOT NULL,
        author TEXT NOT NULL CHECK (author IN ('user', 'agent', 'system')),
        collapsed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    legacy.close();

    const store = new OutlinerStore(path);
    stores.push({ store, directory });
    const columnNames = (
      store.database
        .query("PRAGMA table_info(blocks)")
        .all() as Array<{ name: string }>
    ).map((column) => column.name);
    expect(columnNames).toEqual(expect.arrayContaining([
      "actor_id",
      "session_id",
      "task_id",
      "deleted_at",
      "effective_deleted_root_id",
    ]));
    expect(
      store.create("Migrated agent block", null, "agent", { actorId: "pi" }),
    ).toEqual(expect.objectContaining({ author: "agent", actorId: "pi" }));
  });

  test("backfills effective deletion when upgrading a database with direct tombstones", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-outliner-deletion-migration-"));
    const path = join(directory, "outliner.sqlite");
    const legacy = new Database(path, { create: true });
    legacy.exec(`
      CREATE TABLE blocks (
        id TEXT PRIMARY KEY,
        parent_id TEXT REFERENCES blocks(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        text TEXT NOT NULL,
        author TEXT NOT NULL CHECK (author IN ('user', 'agent', 'system')),
        collapsed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      INSERT INTO blocks
        (id, parent_id, position, text, author, collapsed, created_at, updated_at, deleted_at)
      VALUES
        ('deleted-root', NULL, 0, 'Deleted root', 'user', 0, 'created', 'updated', 'deleted'),
        ('deleted-child', 'deleted-root', 0, 'Deleted child', 'user', 0, 'created', 'updated', NULL);
    `);
    legacy.close();

    const store = new OutlinerStore(path);
    stores.push({ store, directory });
    expect(store.require("deleted-root").effectiveDeletedRootId).toBe("deleted-root");
    expect(store.require("deleted-child").effectiveDeletedRootId).toBe("deleted-root");
    expect(store.children(null).some((block) => block.id === "deleted-root")).toBe(false);
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
    expect(ranked.blocks[0]).toEqual(expect.objectContaining({
      id: second.id,
      depth: 0,
      hasChildren: false,
      displayText: second.text,
    }));
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
      { viewId: view.id, blockId: first.id, rank: 2 },
    ]);
    store.purge(first.id, first.id.slice(0, 8));
    expect(store.readWorkspaceSnapshot().virtualOccurrenceRanks).toEqual([
      { viewId: view.id, blockId: second.id, rank: 0 },
      { viewId: view.id, blockId: nonmatching.id, rank: 1 },
    ]);
    store.delete(view.id);
    store.purge(view.id, view.id.slice(0, 8));
    expect(store.readWorkspaceSnapshot().virtualOccurrenceRanks).toEqual([]);
  });

  test("always returns canonical descendants for client-local projection", () => {
    const store = makeStore();
    const parent = store.create("Parent");
    const child = store.create("Child", parent.id);

    expect(store.traversePreorder({}).some((block) => block.id === child.id)).toBe(true);
  });

  test("traverses a subtree with physical depth and hydrated display metadata", () => {
    const store = makeStore();
    const target = store.create("Referenced title");
    const root = store.create("Subtree root");
    const child = store.create(`See ((${target.id}))`, root.id);

    const rows = store.traversePreorder({
      subtreeRootId: root.id,
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
        "Block search limit must be an integer from 1 through 1000",
      );
    }
    expect(() =>
      store.queryBlocks({ text: "matching" } as Parameters<OutlinerStore["queryBlocks"]>[0]),
    ).toThrow("Block search limit must be an integer from 1 through 1000");
  });

  test("reads complete visible and physical snapshots without a row cap", () => {
    const store = makeStore();
    const baseline = store.readWorkspaceSnapshot();
    store.database.exec(`
      WITH RECURSIVE roots(n) AS (
        SELECT 1
        UNION ALL
        SELECT n + 1 FROM roots WHERE n < 501
      )
      INSERT INTO blocks (
        id, parent_id, position, text, author, created_at, updated_at
      )
      SELECT
        'bulk-root-' || n,
        NULL,
        1000 + n,
        'Bulk root ' || n,
        'user',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z'
      FROM roots;
    `);

    const snapshot = store.readWorkspaceSnapshot();
    expect(snapshot.visible.completeness).toEqual({ kind: "complete" });
    expect(snapshot.physical.completeness).toEqual({ kind: "complete" });
    expect(snapshot.visible.blocks).toHaveLength(baseline.visible.blocks.length + 501);
    expect(snapshot.physical.blocks).toHaveLength(baseline.physical.blocks.length + 501);
    expect(snapshot.visible.blocks.some((block) => block.id === "bulk-root-501")).toBe(true);
    expect(snapshot.physical.blocks.some((block) => block.id === "bulk-root-501")).toBe(true);
  });

  test("filtered snapshots preserve canonical physical depth", () => {
    const store = makeStore();
    const parent = store.create("Collapsed parent");
    const child = store.create("Filtered child [kind::snapshot-target]", parent.id);

    const unfiltered = store.readWorkspaceSnapshot();
    expect(unfiltered.visible.blocks.some((block) => block.id === child.id)).toBe(true);
    expect(unfiltered.physical.blocks.find((block) => block.id === child.id)?.depth).toBe(1);

    const filtered = store.readWorkspaceSnapshot({
      query: {
        filters: [{ key: "kind", value: "snapshot-target" }],
        limit: 500,
      },
    });
    expect(filtered.visible.blocks).toEqual([
      expect.objectContaining({
        id: child.id,
        depth: 1,
      }),
    ]);
    expect(filtered.physical.blocks.find((block) => block.id === child.id)?.depth).toBe(1);
  });

  test("bounds filtered workspace snapshots while retaining a complete physical graph", () => {
    const store = makeStore();
    const first = store.create("First [status::in progress]");
    store.create("Second [status::in progress]");

    const snapshot = store.readWorkspaceSnapshot({
      query: {
        filters: [{ key: "status", value: "in progress" }],
        limit: 1,
      },
    });
    expect(snapshot.visible).toEqual({
      blocks: [expect.objectContaining({ id: first.id })],
      completeness: { kind: "truncated", limit: 1 },
    });
    expect(snapshot.physical.completeness).toEqual({ kind: "complete" });
    expect(snapshot.physical.blocks.length).toBeGreaterThan(snapshot.visible.blocks.length);
  });

  test("resolves references for display without changing canonical block text", () => {

    const store = makeStore();
    const target = store.create("Decision title [type::decision]");
    const rawText = `See ((${target.id}))`;
    const source = store.create(rawText);

    expect(store.resolveBlockReferences(source.text)).toEqual({
      text: "See ((Decision title))",
      references: [{
        blockId: target.id,
        status: "resolved",
        title: "Decision title",
      }],
    });
    store.delete(target.id);
    expect(store.resolveBlockReferences(source.text)).toEqual({
      text: "See ((Decision title · Trash))",
      references: [{
        blockId: target.id,
        status: "deleted",
        title: "Decision title",
        deletionRootId: target.id,
      }],
    });
    store.purge(target.id, target.id.slice(0, 8));
    expect(store.resolveBlockReferences(source.text)).toEqual({
      text: rawText,
      references: [{ blockId: target.id, status: "missing" }],
    });
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

    originalStore.database.exec(`
      DROP TABLE block_properties;
      CREATE TABLE block_properties (
        block_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        PRIMARY KEY (block_id, key, ordinal)
      );
    `);
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
        properties: [],
      }),
    );
    expect(reopened.queryBlocks({
      filters: [{ key: "obsolete", value: "literal" }],
      limit: 10,
    }).blocks).toEqual([]);
    expect(reopened.queryBlocks({
      filters: [{ key: "status", value: "current" }],
      limit: 10,
    }).blocks).toEqual([]);
    expect(reopened.queryBlocks({
      filters: [{ key: "status", value: "current" }],
      propertyScope: "inline",
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

  test("correlates legacy Work-ID reservations with matching block-scoped declarations", () => {
    const store = makeStore();
    const directory = stores[stores.length - 1].directory;
    const path = join(directory, "outliner.sqlite");
    const first = store.create("First owner [work-id::PIE-701]");
    const second = store.create("Second owner [work-id::PIE-702]");
    store.create("Inline claim\nBody text [work-id::PIE-703]");
    store.database.exec(`
      DROP TABLE reserved_work_ids;
      CREATE TABLE reserved_work_ids (
        work_id TEXT PRIMARY KEY,
        reserved_at TEXT NOT NULL
      );
      INSERT INTO reserved_work_ids (work_id, reserved_at) VALUES
        ('PIE-701', '2026-01-01T00:00:00.000Z'),
        ('PIE-702', '2026-01-01T00:00:00.000Z'),
        ('PIE-703', '2026-01-01T00:00:00.000Z'),
        ('PIE-799', '2026-01-01T00:00:00.000Z');
    `);
    store.close();

    const reopened = new OutlinerStore(path);
    stores[stores.length - 1].store = reopened;
    expect(
      reopened.database.query(
        "SELECT work_id, block_id FROM reserved_work_ids ORDER BY work_id",
      ).all(),
    ).toEqual([
      { work_id: "PIE-701", block_id: first.id },
      { work_id: "PIE-702", block_id: second.id },
      { work_id: "PIE-703", block_id: null },
      { work_id: "PIE-799", block_id: null },
    ]);
  });

  test("allocates monotonic project Work IDs transactionally", async () => {
    const store = makeStore();
    const first = store.create("First opted-in work item");
    const second = store.create("Second opted-in work item");
    const third = store.create("Third opted-in work item");

    expect(store.workIdAllocatorStatus()).toEqual({
      prefix: null,
      nextNumber: null,
      nextWorkId: null,
      reservedCount: 0,
      observedPrefixes: [],
    });
    expect(() => store.allocateWorkId(first.id, first.updatedAt)).toThrow(
      "Configure the project Work-ID prefix",
    );
    expect(store.configureWorkIdPrefix("pei")).toMatchObject({
      prefix: "PEI",
      nextWorkId: "PEI-001",
    });
    expect(store.configureWorkIdPrefix("pie")).toMatchObject({
      prefix: "PIE",
      nextWorkId: "PIE-001",
    });
    const firstAllocation = store.allocateWorkId(first.id, first.updatedAt);
    const [secondAllocation, thirdAllocation] = await Promise.all([
      Promise.resolve().then(() =>
        store.allocateWorkId(second.id, second.updatedAt)
      ),
      Promise.resolve().then(() =>
        store.allocateWorkId(third.id, third.updatedAt)
      ),
    ]);

    expect(firstAllocation).toMatchObject({
      workId: "PIE-001",
      block: {
        id: first.id,
        properties: [{ key: "work-id", value: "PIE-001" }],
      },
    });
    expect([secondAllocation.workId, thirdAllocation.workId]).toEqual([
      "PIE-002",
      "PIE-003",
    ]);
    expect(secondAllocation.block.text).toContain("[work-id::PIE-002]");
    expect(store.resolvePageAddress("pie-003").block?.id).toBe(third.id);
    expect(store.workIdAllocatorStatus()).toEqual({
      prefix: "PIE",
      nextNumber: 4,
      nextWorkId: "PIE-004",
      reservedCount: 3,
      observedPrefixes: ["PIE"],
    });
  });

  test("atomically replaces the configured self-assignment placeholder", () => {
    const store = makeStore();
    const selfAssignment = store.create(
      "Promote this work [work-id::PIE-XXX] [status::planned]",
    );
    const wrongPrefix = store.create("Other placeholder [work-id::OTHER-XXX]");
    store.configureWorkIdPrefix("PIE");

    expect(() =>
      store.allocateWorkId(selfAssignment.id, "stale")
    ).toThrow("changed since editing began");
    expect(store.get(selfAssignment.id)?.text).toContain("[work-id::PIE-XXX]");

    const allocation = store.allocateWorkId(
      selfAssignment.id,
      selfAssignment.updatedAt,
    );
    expect(allocation).toMatchObject({
      workId: "PIE-001",
      block: {
        properties: [
          { key: "work-id", value: "PIE-001" },
          { key: "status", value: "planned" },
        ],
      },
    });
    expect(allocation.block.text).not.toContain("PIE-XXX");
    expect(allocation.block.properties.filter(({ key }) => key === "work-id")).toHaveLength(1);

    const shiftedPlaceholder = store.create(
      "Body [note::keep] more text\nwork-id:: PIE-XXX",
    );
    const shiftedAllocation = store.allocateWorkId(
      shiftedPlaceholder.id,
      shiftedPlaceholder.updatedAt,
    );
    expect(shiftedAllocation.block.text).toBe(
      "Body [note::keep] more text\nwork-id:: PIE-002",
    );

    expect(() =>
      store.allocateWorkId(wrongPrefix.id, wrongPrefix.updatedAt)
    ).toThrow("already has a Work ID");
    expect(store.get(wrongPrefix.id)?.text).toContain("[work-id::OTHER-XXX]");
  });
  test("protects a configured non-PIE Work-ID namespace from page stubs", () => {
    const store = makeStore();
    const work = store.create("Custom-prefix work");
    store.configureWorkIdPrefix("abc");
    expect(store.followPageAddress("RFC-2119")).toMatchObject({
      created: true,
      kind: "page",
      block: { text: "RFC-2119 [page::RFC-2119]" },
    });
    expect(
      store.allocateWorkId(work.id, work.updatedAt).workId,
    ).toBe("ABC-001");
    expect(store.resolvePageAddress("abc-001").block?.id).toBe(work.id);
    expect(() => store.followPageAddress("ABC-002")).toThrow(
      "Unresolved Work ID cannot create a page stub",
    );
    expect(store.resolvePageAddress("ABC-002").status).toBe("missing");
  });


  test("atomically creates canonical roadmap items with allocator and branch receipts", () => {
    const store = makeStore();
    store.configureWorkIdPrefix("PIE");
    const queue = store.create(
      "Pi Outliner work [type::work-queue] [project::pi-outliner]",
    );
    const unprioritized = store.create(
      "Unprioritized [type::virtual-branch] [query::work-stage=unprioritized]",
    );
    const safety = store.create(
      "Safety [type::virtual-branch] [query::track=safety]",
    );
    const source = store.create("Source note");

    const receipt = store.createRoadmapItem(
      {
        title: "Make roadmap mutation atomic",
        body: "Acceptance: no partial block or consumed Work ID on failure.",
        priority: "high",
        project: "pi-outliner",
        arc: "safety-agency",
        tracks: ["safety", "safety"],
        relatedTo: [source.id],
        sourceBlockId: source.id,
      },
      "agent",
      { actorId: "pi", sessionId: "session", taskId: "tool-call" },
    );

    expect(receipt).toMatchObject({
      workId: "PIE-001",
      workQueueId: queue.id,
      block: {
        parentId: queue.id,
        author: "agent",
        actorId: "pi",
        sessionId: "session",
        taskId: "tool-call",
      },
    });
    expect(receipt.block.text).toStartWith("PIE-001 — Make roadmap mutation atomic ");
    expect(receipt.block.text).toContain(
      "\n\nAcceptance: no partial block or consumed Work ID on failure.",
    );
    expect(receipt.block.properties).toEqual([
      { key: "type", value: "roadmap-item" },
      { key: "status", value: "planned" },
      { key: "priority", value: "high" },
      { key: "work-stage", value: "unprioritized" },
      { key: "project", value: "pi-outliner" },
      { key: "arc", value: "safety-agency" },
      { key: "track", value: "safety" },
      { key: "related-to", value: source.id },
      { key: "source-block", value: source.id },
      { key: "work-id", value: "PIE-001" },
    ]);
    expect(receipt.memberships).toEqual([
      { viewId: unprioritized.id, title: "Unprioritized" },
      { viewId: safety.id, title: "Safety" },
    ]);
    expect(store.workIdAllocatorStatus().nextWorkId).toBe("PIE-002");
    expect(store.resolvePageAddress("PIE-001").block?.id).toBe(receipt.block.id);

    const beforeFailure = store.queryBlocks({
      filters: [{ key: "type", value: "roadmap-item" }],
      limit: 10,
    }).blocks;
    expect(() =>
      store.createRoadmapItem({
        title: "Invalid relationship",
        priority: "medium",
        project: "pi-outliner",
        arc: "safety-agency",
        tracks: ["safety"],
        dependsOn: ["00000000-0000-4000-8000-000000000000"],
      })
    ).toThrow("Relationship target not found");
    expect(store.queryBlocks({
      filters: [{ key: "type", value: "roadmap-item" }],
      limit: 10,
    }).blocks).toEqual(beforeFailure);
    expect(store.workIdAllocatorStatus().nextWorkId).toBe("PIE-002");

    store.create("Duplicate queue [type::work-queue] [project::pi-outliner]");
    expect(() =>
      store.createRoadmapItem({
        title: "Ambiguous queue",
        priority: "low",
        project: "pi-outliner",
        arc: "safety-agency",
        tracks: ["safety"],
      })
    ).toThrow("Expected exactly one active work queue");
    expect(store.workIdAllocatorStatus().nextWorkId).toBe("PIE-002");
  });

  test("rejects reserved roadmap properties without stripping other property text", () => {
    const store = makeStore();
    store.configureWorkIdPrefix("PIE");
    store.create("Pi Outliner work [type::work-queue] [project::pi-outliner]");
    const baseInput = {
      priority: "medium" as const,
      project: "pi-outliner",
      arc: "safety-agency",
      tracks: ["safety"],
    };

    expect(() => store.createRoadmapItem({
      ...baseInput,
      title: "Duplicate priority [priority::low]",
    })).toThrow("reserved property: priority");
    expect(() => store.createRoadmapItem({
      ...baseInput,
      title: "Duplicate Work ID",
      body: "Do not reserve [work-id::PIE-999]",
    })).toThrow("reserved property: work-id");

    const receipt = store.createRoadmapItem({
      ...baseInput,
      title: "Keep metadata [audience::agents]",
      body: "Acceptance [outcome::clear]",
    });
    expect(receipt.block.text).toContain("[audience::agents]");
    expect(receipt.block.text).toContain("[outcome::clear]");
    expect(receipt.workId).toBe("PIE-001");
  });

  test("protects reserved IDs before configuration and does not auto-adopt later typos", () => {
    const store = makeStore();
    const directory = stores[stores.length - 1].directory;
    const path = join(directory, "outliner.sqlite");
    const owner = store.create("Reserved before configuration [work-id::PIE-001]");
    expect(() => store.followPageAddress("PIE-001")).toThrow(
      "Unresolved Work ID cannot create a page stub",
    );
    expect(store.configureWorkIdPrefix("PIE")).toMatchObject({
      prefix: "PIE",
      nextWorkId: "PIE-002",
    });
    expect(store.resolvePageAddress("PIE-001").block?.id).toBe(owner.id);

    store.close();
    const reopened = new OutlinerStore(path);
    stores[stores.length - 1].store = reopened;
    expect(reopened.workIdAllocatorStatus().prefix).toBe("PIE");
  });

  test("does not auto-configure a typo introduced after the v9 migration", () => {
    const store = makeStore();
    const directory = stores[stores.length - 1].directory;
    const path = join(directory, "outliner.sqlite");
    store.create("Typo remains inert [work-id::PEI-001]");
    store.close();

    const reopened = new OutlinerStore(path);
    stores[stores.length - 1].store = reopened;
    expect(reopened.workIdAllocatorStatus()).toMatchObject({
      prefix: null,
      observedPrefixes: ["PEI"],
    });
    expect(reopened.configureWorkIdPrefix("PIE")).toMatchObject({
      prefix: "PIE",
      nextWorkId: "PIE-001",
    });
  });

  test("adopts manual IDs, rejects prefix changes, and never reuses purged IDs", () => {
    const store = makeStore();
    const existing = store.create("Existing work [work-id::PIE-123]");
    const allocated = store.create("Allocated work");
    const afterPurge = store.create("After purge");

    expect(store.workIdAllocatorStatus()).toMatchObject({
      prefix: null,
      nextNumber: null,
      nextWorkId: null,
      observedPrefixes: ["PIE"],
    });
    expect(store.configureWorkIdPrefix("PIE")).toMatchObject({
      prefix: "PIE",
      nextNumber: 124,
      nextWorkId: "PIE-124",
    });
    expect(() => store.configureWorkIdPrefix("OTHER")).toThrow(
      "already has immutable reservations",
    );
    expect(() =>
      store.allocateWorkId(allocated.id, "stale")
    ).toThrow("changed since editing began");
    const allocation = store.allocateWorkId(
      allocated.id,
      allocated.updatedAt,
    );
    const otherPrefix = store.create("Other project [work-id::OTHER-001]");
    const malformed = store.create("Malformed work [work-id::PIE-x]");
    const unpadded = store.create("Unpadded work [work-id::PIE-7]");
    expect(otherPrefix.properties).toContainEqual({ key: "work-id", value: "OTHER-001" });
    expect(malformed.properties).toContainEqual({ key: "work-id", value: "PIE-x" });
    expect(unpadded.properties).toContainEqual({ key: "work-id", value: "PIE-7" });
    expect(store.resolvePageAddress("OTHER-001").status).toBe("missing");
    expect(store.resolvePageAddress("PIE-7").status).toBe("missing");
    expect(allocation.workId).toBe("PIE-124");
    expect(() =>
      store.allocateWorkId(existing.id, existing.updatedAt)
    ).toThrow("already has a Work ID");

    store.delete(allocated.id);
    store.purge(allocated.id, allocation.workId);
    expect(() => store.create("Illegal reuse [work-id::PIE-124]")).toThrow(
      `already belongs to block ${allocated.id}`,
    );
    expect(store.allocateWorkId(afterPurge.id, afterPurge.updatedAt).workId).toBe(
      "PIE-125",
    );
    store.create("Manual future [work-id::PIE-200]");
    expect(store.workIdAllocatorStatus().nextWorkId).toBe("PIE-201");
  });

  test("migrates reservation ownership and adopts the existing sequence", () => {
    const store = makeStore();
    const directory = stores[stores.length - 1].directory;
    const path = join(directory, "outliner.sqlite");
    const existing = store.create("Legacy allocated [work-id::PIE-123]");
    store.database.query(
      "DELETE FROM metadata WHERE key = 'work_id_allocator_migration_version'",
    ).run();
    store.close();

    const legacy = new Database(path);
    legacy.exec(`
      DROP TABLE work_id_allocator;
      CREATE TABLE reserved_work_ids_legacy (
        work_id TEXT PRIMARY KEY,
        reserved_at TEXT NOT NULL
      );
      INSERT INTO reserved_work_ids_legacy (work_id, reserved_at)
        SELECT work_id, reserved_at FROM reserved_work_ids;
      DROP TABLE reserved_work_ids;
      ALTER TABLE reserved_work_ids_legacy RENAME TO reserved_work_ids;
    `);
    legacy.close();

    const reopened = new OutlinerStore(path);
    stores[stores.length - 1].store = reopened;
    expect(reopened.workIdAllocatorStatus()).toMatchObject({
      prefix: "PIE",
      nextNumber: 124,
      nextWorkId: "PIE-124",
      observedPrefixes: ["PIE"],
    });
    expect(
      reopened.database.query(
        "SELECT block_id FROM reserved_work_ids WHERE work_id = 'PIE-123'",
      ).get(),
    ).toEqual({ block_id: existing.id });
  });

  test("migrates dirty legacy Work-ID properties without blocking startup", () => {
    const store = makeStore();
    const directory = stores[stores.length - 1].directory;
    const path = join(directory, "outliner.sqlite");
    const pieOwner = store.create("PIE owner [work-id::PIE-001]");
    store.create("Other prefix [work-id::ABC-001]");
    const duplicate = store.create("Copied legacy value");
    store.database.query(
      "UPDATE blocks SET text = ? WHERE id = ?",
    ).run("Copied [work-id::PIE-001] [work-id::todo-later]", duplicate.id);
    insertIndexedProperty(store, duplicate.id, "work-id", "PIE-001", 0);
    insertIndexedProperty(store, duplicate.id, "work-id", "todo-later", 1);
    store.database.query(
      "DELETE FROM metadata WHERE key = 'work_id_allocator_migration_version'",
    ).run();
    store.close();

    const reopened = new OutlinerStore(path);
    stores[stores.length - 1].store = reopened;
    expect(reopened.workIdAllocatorStatus()).toMatchObject({
      prefix: null,
      observedPrefixes: ["ABC", "PIE"],
      reservedCount: 2,
    });
    expect(reopened.configureWorkIdPrefix("PIE")).toMatchObject({
      prefix: "PIE",
      nextWorkId: "PIE-002",
    });
    expect(reopened.resolvePageAddress("PIE-001").block?.id).toBe(pieOwner.id);
    expect(reopened.require(duplicate.id).properties).toEqual([
      { key: "work-id", value: "PIE-001" },
      { key: "work-id", value: "todo-later" },
    ]);
  });

  test("purges legacy copied and malformed Work-ID properties without ownership adoption", () => {
    const store = makeStore();
    const owner = store.create("Canonical owner [work-id::PIE-123]");
    const legacy = store.create("Legacy Trash source");
    store.database.query(
      "UPDATE blocks SET text = ? WHERE id = ?",
    ).run("Legacy [work-id::PIE-123] [work-id::not-an-id]", legacy.id);
    insertIndexedProperty(store, legacy.id, "work-id", "PIE-123", 0);
    insertIndexedProperty(store, legacy.id, "work-id", "not-an-id", 1);
    store.delete(legacy.id);

    store.purge(legacy.id, "PIE-123");

    expect(store.get(legacy.id)).toBeNull();
    expect(
      store.database.query(
        "SELECT block_id FROM reserved_work_ids WHERE work_id = 'PIE-123'",
      ).get(),
    ).toEqual({ block_id: owner.id });
  });

  test("reserves purged Work IDs without a surviving address row and tolerates legacy values", () => {
    const store = makeStore();
    const directory = stores[stores.length - 1].directory;
    const path = join(directory, "outliner.sqlite");
    const orphan = store.create("Legacy deleted work [work-id::PIE-321]");
    store.delete(orphan.id);
    store.database.query("DELETE FROM page_addresses WHERE block_id = ?").run(orphan.id);
    store.database.query("DELETE FROM reserved_work_ids WHERE work_id = 'PIE-321'").run();
    store.database.query("DELETE FROM work_id_allocator").run();

    store.purge(orphan.id, "PIE-321");
    expect(
      store.database.query(
        "SELECT block_id FROM reserved_work_ids WHERE work_id = 'PIE-321'",
      ).get(),
    ).toEqual({ block_id: orphan.id });
    expect(store.workIdAllocatorStatus()).toMatchObject({
      prefix: null,
      nextWorkId: null,
      observedPrefixes: ["PIE"],
    });
    expect(store.configureWorkIdPrefix("PIE")).toMatchObject({
      prefix: "PIE",
      nextWorkId: "PIE-322",
    });

    const later = store.create("Later deleted work [work-id::PIE-400]");
    store.delete(later.id);
    store.database.query("DELETE FROM page_addresses WHERE block_id = ?").run(later.id);
    store.database.query("DELETE FROM reserved_work_ids WHERE work_id = 'PIE-400'").run();
    store.database.query(
      "UPDATE work_id_allocator SET next_number = 322 WHERE singleton = 1",
    ).run();
    store.purge(later.id, "PIE-400");
    expect(store.workIdAllocatorStatus().nextWorkId).toBe("PIE-401");

    store.database.query(
      "INSERT INTO reserved_work_ids (work_id, reserved_at, block_id) VALUES ('not-an-id', ?, NULL), ('OTHER-004', ?, NULL)",
    ).run(new Date().toISOString(), new Date().toISOString());
    store.close();

    const reopened = new OutlinerStore(path);
    stores[stores.length - 1].store = reopened;
    expect(reopened.workIdAllocatorStatus()).toMatchObject({
      prefix: "PIE",
      nextWorkId: "PIE-401",
      observedPrefixes: ["OTHER", "PIE"],
      reservedCount: 3,
    });
  });

  test("registers normalized page declarations and Work IDs with authored labels", () => {
    const store = makeStore();
    store.configureWorkIdPrefix("PIE");
    const page = store.create("Research hub [page::Research   Notes]");
    const work = store.create("Symbolic registry [work-id::PIE-132]");

    expect(store.resolvePageAddress("  research notes  ")).toMatchObject({
      normalizedAddress: "research notes",
      status: "resolved",
      registeredAddress: "Research   Notes",
      kind: "page",
      block: { id: page.id },
    });
    expect(store.resolvePageAddress("pie-132")).toMatchObject({
      status: "resolved",
      registeredAddress: "PIE-132",
      kind: "work-id",
      block: { id: work.id },
    });
    expect(store.completePageAddresses("pie", 20)).toEqual({
      addresses: [{
        address: "PIE-132",
        normalizedAddress: "pie-132",
        blockId: work.id,
        kind: "work-id",
        title: "Symbolic registry",
      }],
      completeness: { kind: "complete" },
    });
    expect(store.completePageAddresses("notes", 20).addresses[0]).toMatchObject({
      address: "Research   Notes",
      blockId: page.id,
    });
    expect(store.completePageAddresses("]", 20)).toEqual({
      addresses: [],
      completeness: { kind: "complete" },
    });
  });
  test("resolves one embedded configured Work ID after exact page addresses", () => {
    const store = makeStore();
    store.configureWorkIdPrefix("PIE");
    const work = store.create("Work target [work-id::PIE-123]");
    store.create("Other target [work-id::PIE-124]");
    const exact = store.create("Exact authored page [page::PIE-123 - Exact page]");

    expect(store.resolvePageAddress("PIE-123 - some title")).toMatchObject({
      address: "PIE-123 - some title",
      normalizedAddress: "pie-123 - some title",
      status: "resolved",
      registeredAddress: "PIE-123",
      kind: "work-id",
      block: { id: work.id },
    });
    expect(store.resolvePageAddress("some title - PIE-123").block?.id).toBe(work.id);
    expect(store.resolvePageAddress("PIE-123 - Exact page")).toMatchObject({
      kind: "page",
      block: { id: exact.id },
    });
    expect(store.resolvePageAddress("PIE-123 and PIE-124")).toMatchObject({
      status: "missing",
    });
    expect(() => store.followPageAddress("some title - PIE-404")).toThrow(
      "Unresolved Work ID cannot create a page stub: PIE-404",
    );
  });


  test("uses Unicode caseless normalization for symbolic uniqueness", () => {
    const store = makeStore();
    const owner = store.create("Greek address [page::ΟΣ]");

    expect(store.resolvePageAddress("οσ").block?.id).toBe(owner.id);
    expect(() => store.create("Collision [page::οσ]")).toThrow(
      `Page address already belongs to block ${owner.id}`,
    );
  });
  test("does not create on parse or save and creates one stub only on follow", async () => {
    const store = makeStore();
    store.configureWorkIdPrefix("PIE");
    const source = store.create("Source mentions [[Future Page]]");
    const updated = store.update(source.id, "Source still mentions [[Future Page]]");
    const before = store.traversePreorder({}).length;
    expect(updated.text).toContain("[[Future Page]]");
    expect(store.completePageAddresses("future", 20).addresses).toEqual([]);

    expect(store.resolvePageAddress("Future Page")).toEqual({
      address: "Future Page",
      normalizedAddress: "future page",
      status: "missing",
    });
    expect(store.traversePreorder({})).toHaveLength(before);
    expect(() => store.followPageAddress("PIE-404")).toThrow(
      "Unresolved Work ID cannot create a page stub",
    );

    const [first, second] = await Promise.all([
      Promise.resolve().then(() => store.followPageAddress(" Future   Page ")),
      Promise.resolve().then(() => store.followPageAddress("future page")),
    ]);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    expect(first.block?.id).toBe(second.block?.id);
    expect(first.block?.text).toBe("Future   Page [page::Future   Page]");
    expect(
      store.database.query(
        "SELECT COUNT(*) AS count FROM page_addresses WHERE normalized_address = 'future page'",
      ).get(),
    ).toEqual({ count: 1 });
  });

  test("rejects normalized address collisions across page and Work-ID declarations", () => {
    const store = makeStore();
    store.configureWorkIdPrefix("PIE");
    const owner = store.create("Owner [work-id::PIE-132]");
    const count = store.traversePreorder({}).length;

    expect(() => store.create("Collision [page::pie-132]")).toThrow(
      `Page address already belongs to block ${owner.id}`,
    );
    expect(store.traversePreorder({})).toHaveLength(count);
    expect(() => store.create("Duplicate [page::One] [page::Two]")).toThrow(
      "at most one page address",
    );
  });

  test("renames pages explicitly while preserving old and added aliases", () => {
    const store = makeStore();
    const page = store.create("Knowledge [page::Old Address]");

    expect(() => store.renamePageAddress(page.id, "New Address", "stale")).toThrow(
      "Block changed since editing began",
    );
    expect(store.renamePageAddress(page.id, "New Address", page.updatedAt)).toEqual({
      address: "New Address",
      normalizedAddress: "new address",
      blockId: page.id,
      kind: "page",
    });
    expect(store.resolvePageAddress("old address")).toMatchObject({
      status: "resolved",
      kind: "alias",
      block: { id: page.id },
    });
    expect(store.resolvePageAddress("new address")).toMatchObject({
      status: "resolved",
      kind: "page",
      block: { id: page.id },
    });
    expect(store.require(page.id).text).toBe("Knowledge [page::New Address]");

    const updated = store.update(page.id, "Knowledge revised [page::New Address]");
    expect(updated.text).toContain("Knowledge revised");
    expect(() => store.update(page.id, "Knowledge [page::Third Address]")).toThrow(
      "changes require pages.rename",
    );
    expect(store.addPageAlias(page.id, "Knowledge Hub")).toEqual({
      address: "Knowledge Hub",
      normalizedAddress: "knowledge hub",
      blockId: page.id,
      kind: "alias",
    });
    expect(store.resolvePageAddress("knowledge hub").block?.id).toBe(page.id);

    const current = store.require(page.id);
    const removedAlias = store.removePageAddress(page.id, "Knowledge Hub", current.updatedAt);
    expect(removedAlias.removed.kind).toBe("alias");
    const removedPage = store.removePageAddress(
      page.id,
      "New Address",
      removedAlias.block.updatedAt,
    );
    expect(removedPage.removed.kind).toBe("page");
    expect(removedPage.block.text.trimEnd()).toBe("Knowledge revised");
    expect(store.resolvePageAddress("new address").status).toBe("missing");
    expect(store.resolvePageAddress("old address").block?.id).toBe(page.id);
    expect(store.update(page.id, "Knowledge without a primary page").text).toBe(
      "Knowledge without a primary page",
    );
  });

  test("retains deleted symbolic identity and makes purged addresses dangling", () => {
    const store = makeStore();
    const page = store.create("Disposable [page::Disposable Page]");
    store.delete(page.id);

    expect(store.resolvePageAddress("disposable page")).toMatchObject({
      status: "deleted",
      deletionRootId: page.id,
      block: { id: page.id },
    });
    expect(store.followPageAddress("Disposable Page")).toMatchObject({
      status: "deleted",
      created: false,
      block: { id: page.id },
    });

    store.purge(page.id, page.id.slice(0, 8));
    expect(store.resolvePageAddress("Disposable Page")).toEqual({
      address: "Disposable Page",
      normalizedAddress: "disposable page",
      status: "missing",
    });
  });

  test("backfills existing page and Work-ID declarations on migration", () => {
    const store = makeStore();
    const directory = stores[stores.length - 1].directory;
    const path = join(directory, "outliner.sqlite");
    store.configureWorkIdPrefix("PIE");
    const page = store.create("Migrated page [page::Migration Target]");
    const work = store.create("Migrated work [work-id::PIE-777]");
    store.addPageAlias(page.id, "Migrated Alias");
    store.database.query(
      "UPDATE metadata SET value = '0' WHERE key = 'page_address_registry_version'",
    ).run();
    store.close();

    const reopened = new OutlinerStore(path);
    stores[stores.length - 1].store = reopened;
    expect(reopened.resolvePageAddress("migration target").block?.id).toBe(page.id);
    expect(
      reopened.database.query(
        "SELECT value FROM metadata WHERE key = 'page_address_registry_version'",
      ).get(),
    ).toEqual({ value: String(PAGE_ADDRESS_REGISTRY_VERSION) });
    expect(reopened.resolvePageAddress("pie-777").block?.id).toBe(work.id);
    expect(reopened.resolvePageAddress("migrated alias").block?.id).toBe(page.id);
  });

  test("rebuilds registry-v1 addresses after parser-v2 scope migration exactly once", () => {
    const store = makeStore();
    const directory = stores[stores.length - 1].directory;
    const path = join(directory, "outliner.sqlite");
    store.configureWorkIdPrefix("PIE");
    const canonicalPage = store.create("Canonical page [page::Canonical Metadata]");
    const inlinePage = store.create("Inline page\nBody text [page::Inline Metadata]");
    const canonicalWork = store.create("Canonical work\n[work-id::PIE-811]");
    const inlineWork = store.create("Inline work\nBody text [work-id::PIE-812]");

    store.database.query(
      "UPDATE block_properties SET scope = 'block' WHERE block_id IN (?, ?)",
    ).run(inlinePage.id, inlineWork.id);
    store.database.query(
      "INSERT INTO page_addresses (normalized_address, display_address, block_id, kind) VALUES (?, ?, ?, ?)",
    ).run("inline metadata", "Inline Metadata", inlinePage.id, "page");
    store.database.query(
      "INSERT INTO page_addresses (normalized_address, display_address, block_id, kind) VALUES (?, ?, ?, ?)",
    ).run("pie-812", "PIE-812", inlineWork.id, "work-id");
    store.database.query(
      "UPDATE metadata SET value = '1' WHERE key = 'property_parser_version'",
    ).run();
    store.database.query(
      "UPDATE metadata SET value = '1' WHERE key = 'page_address_registry_version'",
    ).run();
    store.close();

    const reopened = new OutlinerStore(path);
    stores[stores.length - 1].store = reopened;
    expect(reopened.resolvePageAddress("Canonical Metadata").block?.id).toBe(
      canonicalPage.id,
    );
    expect(reopened.resolvePageAddress("PIE-811").block?.id).toBe(canonicalWork.id);
    expect(reopened.resolvePageAddress("Inline Metadata").status).toBe("missing");
    expect(reopened.resolvePageAddress("PIE-812").status).toBe("missing");
    expect(reopened.require(inlinePage.id).properties).toEqual([]);
    expect(reopened.require(inlineWork.id).properties).toEqual([]);
    expect(
      reopened.database.query(
        "SELECT key, value FROM metadata WHERE key IN ('property_parser_version', 'page_address_registry_version') ORDER BY key",
      ).all(),
    ).toEqual([
      {
        key: "page_address_registry_version",
        value: String(PAGE_ADDRESS_REGISTRY_VERSION),
      },
      {
        key: "property_parser_version",
        value: String(PROPERTY_PARSER_VERSION),
      },
    ]);
    const migratedSequence = reopened.sequence;
    const migratedAddresses = reopened.database
      .query(
        "SELECT normalized_address, display_address, block_id, kind FROM page_addresses WHERE block_id IN (?, ?, ?, ?) ORDER BY normalized_address",
      )
      .all(canonicalPage.id, inlinePage.id, canonicalWork.id, inlineWork.id);

    reopened.close();
    const reopenedAgain = new OutlinerStore(path);
    stores[stores.length - 1].store = reopenedAgain;
    expect(reopenedAgain.sequence).toBe(migratedSequence);
    expect(
      reopenedAgain.database.query(
        "SELECT normalized_address, display_address, block_id, kind FROM page_addresses WHERE block_id IN (?, ?, ?, ?) ORDER BY normalized_address",
      ).all(canonicalPage.id, inlinePage.id, canonicalWork.id, inlineWork.id),
    ).toEqual(migratedAddresses);
    expect(reopenedAgain.resolvePageAddress("Inline Metadata").status).toBe("missing");
    expect(reopenedAgain.resolvePageAddress("PIE-812").status).toBe("missing");
  });

  test("preserves registered deleted addresses across registry rebuilds", () => {
    const store = makeStore();
    const directory = stores[stores.length - 1].directory;
    const path = join(directory, "outliner.sqlite");
    const page = store.create("Deleted page [page::Deleted Registered]");
    store.delete(page.id);
    store.database.query(
      "UPDATE metadata SET value = '0' WHERE key = 'page_address_registry_version'",
    ).run();
    store.close();

    const reopened = new OutlinerStore(path);
    stores[stores.length - 1].store = reopened;
    expect(reopened.resolvePageAddress("Deleted Registered")).toMatchObject({
      status: "deleted",
      block: { id: page.id },
    });
  });

  test("registers an unambiguous legacy declaration when restoring from Trash", () => {
    const store = makeStore();
    const directory = stores[stores.length - 1].directory;
    const path = join(directory, "outliner.sqlite");
    const legacy = store.create("Legacy page [page::Legacy Restored]");
    store.delete(legacy.id);
    store.database.query("DELETE FROM page_addresses").run();
    store.database.query(
      "UPDATE metadata SET value = '0' WHERE key = 'page_address_registry_version'",
    ).run();
    store.close();

    const reopened = new OutlinerStore(path);
    stores[stores.length - 1].store = reopened;
    expect(reopened.resolvePageAddress("Legacy Restored").status).toBe("missing");
    reopened.restore(legacy.id);
    expect(reopened.resolvePageAddress("Legacy Restored").block?.id).toBe(legacy.id);
  });

  test("restores ambiguous legacy Trash declarations without registering them", () => {
    const store = makeStore();
    const directory = stores[stores.length - 1].directory;
    const path = join(directory, "outliner.sqlite");
    const legacy = store.create("Legacy source");
    const legacyText = "Legacy source [page::One] [page::Two]";
    store.database.query("UPDATE blocks SET text = ? WHERE id = ?").run(legacyText, legacy.id);
    insertIndexedProperty(store, legacy.id, "page", "One", 0);
    insertIndexedProperty(store, legacy.id, "page", "Two", 1);
    store.delete(legacy.id);
    store.database.query("DELETE FROM page_addresses").run();
    store.database.query(
      "UPDATE metadata SET value = '0' WHERE key = 'page_address_registry_version'",
    ).run();
    store.close();

    const reopened = new OutlinerStore(path);
    stores[stores.length - 1].store = reopened;
    expect(reopened.resolvePageAddress("One").status).toBe("missing");
    expect(reopened.resolvePageAddress("Two").status).toBe("missing");
    expect(reopened.restore(legacy.id).effectiveDeletedRootId).toBeUndefined();
    expect(reopened.resolvePageAddress("One").status).toBe("missing");
    reopened.update(legacy.id, "Legacy repaired [page::One]");
    expect(reopened.resolvePageAddress("One").block?.id).toBe(legacy.id);
  });

  test("backfills declarations transactionally and rejects duplicate migration data", () => {
    const store = makeStore();
    const directory = stores[stores.length - 1].directory;
    const path = join(directory, "outliner.sqlite");
    const first = store.create("First");
    const second = store.create("Second");
    insertIndexedProperty(store, first.id, "page", "Same Page", 0);
    insertIndexedProperty(store, second.id, "page", "same   page", 0);
    store.database.query("DELETE FROM page_addresses").run();
    store.database.query("DELETE FROM metadata WHERE key = 'page_address_registry_version'").run();
    store.close();

    expect(() => new OutlinerStore(path)).toThrow("Page address already belongs to block");
    stores.pop();
    rmSync(directory, { recursive: true, force: true });
  });

  test("migrates legacy annotation evidence without changing thread identity", () => {
    const store = makeStore();
    const directory = stores[stores.length - 1].directory;
    const path = join(directory, "outliner.sqlite");
    const source = store.create("alpha beta gamma");
    const promoted = store.create("Promoted decision");
    const ordinary = store.create("Example\nBody [type::annotation]");
    const encode = (value: string): string =>
      `v1-${Buffer.from(value, "utf8").toString("base64url")}`;
    const root = store.create([
      "Comment on “ beta”",
      [
        "[type::annotation]",
        "[annotation-source::user]",
        "[annotation-status::resolved]",
        `[promoted-block::${promoted.id}]`,
        "[project::alpha]",
        "[target-kind::block]",
        `[source-block::${source.id}]`,
        "[anchor-state::anchored]",
        "[anchor-start::5]",
        "[anchor-end::10]",
        `[anchor-excerpt::${encode(" beta")}]`,
        `[anchor-before::${encode("alpha")}]`,
        `[anchor-after::${encode(" gamma")}]`,
        `[source-version::${encode(source.updatedAt)}]`,
        `[source-hash::${annotationSourceHash(source.text)}]`,
      ].join(" "),
      "Legacy root body [source-block::body-reference].",
    ].join("\n"), source.id);
    const reply = store.create([
      "Comment on “beta”",
      `[type::annotation-reply] [annotation-source::agent] [annotation-status::open] [parent-annotation::${root.id}]`,
      "Legacy reply body.",
    ].join("\n"), root.id);
    const legacyFile = store.create([
      "Comment on “ beta”",
      [
        "[type::annotation]",
        "[annotation-source::user]",
        "[annotation-status::open]",
        "[target-kind::file]",
        `[source-block::${source.id}]`,
        `[target-file::${encode("missing.txt")}]`,
        "[anchor-state::anchored]",
        "[anchor-start::5]",
        "[anchor-end::10]",
        `[anchor-excerpt::${encode(" beta")}]`,
        `[anchor-before::${encode("alpha")}]`,
        `[anchor-after::${encode(" gamma")}]`,
        `[source-version::${encode("legacy-version")}]`,
        `[source-hash::${annotationSourceHash(source.text)}]`,
      ].join(" "),
      "Legacy file body.",
    ].join("\n"), source.id);
    const quarantinedText = [
      "Comment on malformed legacy evidence",
      [
        "[type::annotation]",
        "[annotation-source::user]",
        "[annotation-status::invalid]",
        "[target-kind::block]",
        `[source-block::${source.id}]`,
        "[anchor-state::anchored]",
        "[anchor-start::not-a-number]",
        "[anchor-end::10]",
        `[anchor-excerpt::${encode(" beta")}]`,
        `[source-version::${encode(source.updatedAt)}]`,
        `[source-hash::${annotationSourceHash(source.text)}]`,
      ].join(" "),
      "Malformed body must survive.",
    ].join("\n");
    const quarantined = store.create(quarantinedText, source.id);
    const invalidAnchorText = [
      "Comment on invalid legacy offsets",
      [
        "[type::annotation]",
        "[annotation-source::user]",
        "[annotation-status::open]",
        "[target-kind::block]",
        `[source-block::${source.id}]`,
        "[anchor-state::anchored]",
        "[anchor-start::not-a-number]",
        "[anchor-end::10]",
        `[anchor-excerpt::${encode(" beta")}]`,
        `[anchor-before::${encode("alpha")}]`,
        `[anchor-after::${encode(" gamma")}]`,
        `[source-version::${encode(source.updatedAt)}]`,
        `[source-hash::${annotationSourceHash(source.text)}]`,
      ].join(" "),
      "Invalid offsets must not block startup.",
    ].join("\n");
    const invalidAnchor = store.create(invalidAnchorText, source.id);
    const missingEvidenceText = [
      "Comment on missing legacy evidence",
      "[type::annotation] [annotation-source::user] [annotation-status::open] [target-kind::block] [project::retained]",
      "Body without target evidence.",
    ].join("\n");
    const missingEvidence = store.create(missingEvidenceText, source.id);
    const invalidStateText = root.text.replace(
      "[anchor-state::anchored]",
      "[anchor-state::invalid]",
    );
    const invalidState = store.create(invalidStateText, source.id);
    store.database.exec(`
      DELETE FROM metadata WHERE key = 'pie250_annotation_repository';
      DROP TABLE annotation_resource_evidence_refs;
      DROP TABLE annotation_resolution_events;
      DROP TABLE annotation_targets;
    `);
    store.close();

    const reopened = new OutlinerStore(path);
    stores[stores.length - 1].store = reopened;
    const migrated = reopened.getAnnotation(root.id);
    const threads = reopened.listAnnotationThreads({
      subject: { kind: "block", blockId: source.id },
      includeResolved: true,
    });

    expect(migrated.block.id).toBe(root.id);
    expect(migrated.body).toBe("Legacy root body [source-block::body-reference].");
    expect(migrated.lifecycle).toBe("resolved");
    expect(migrated.promotedBlockIds).toEqual([promoted.id]);
    expect(migrated.originalTarget.representation.subject).toEqual({
      kind: "block",
      blockId: source.id,
    });
    expect(migrated.originalTarget.anchor).toMatchObject({
      kind: "text-quote",
      start: 5,
      end: 10,
      exact: " beta",
    });
    expect(migrated.currentResolution).toMatchObject({
      sequence: 0,
      status: "resolved",
      appliesCurrent: true,
    });
    expect(threads[0]!.replies).toHaveLength(1);
    expect(threads[0]!.replies[0]).toMatchObject({
      block: { id: reply.id },
      body: "Legacy reply body.",
      source: "agent",
      parentAnnotationId: root.id,
    });
    const migratedBlock = reopened.require(root.id);
    expect(migratedBlock.updatedAt).toBe(root.updatedAt);
    expect(migratedBlock.properties).toContainEqual({ key: "project", value: "alpha" });
    expect(migratedBlock.properties.some((property) =>
      property.key === "target-kind" ||
      property.key === "source-block" ||
      property.key === "anchor-excerpt"
    )).toBe(false);
    expect(reopened.require(ordinary.id).text).toBe("Example\nBody [type::annotation]");
    const migratedFile = reopened.getAnnotation(legacyFile.id);
    expect(migratedFile.originalTarget.representation.subject).toEqual({
      kind: "legacy-file",
      filePath: "missing.txt",
      sourceBlockId: source.id,
    });
    expect(migratedFile.currentResolution.status).toBe("orphaned");
    const legacyReply = reopened.replyToAnnotation("legacy-file-reply", {
      annotationId: legacyFile.id,
      body: "Still actionable.",
      source: "agent",
    }, "agent").annotations[0]!;
    expect(legacyReply.parentAnnotationId).toBe(legacyFile.id);
    expect(legacyReply.originalTarget).toEqual(migratedFile.originalTarget);
    const resolvedLegacyFile = reopened.setAnnotationLifecycle({
      annotationId: legacyFile.id,
      lifecycle: "resolved",
    }, { author: "agent", actorId: "omp" });
    expect(resolvedLegacyFile.lifecycle).toBe("resolved");
    expect(resolvedLegacyFile.originalTarget).toEqual(migratedFile.originalTarget);
    const quarantinedBlocks = [
      { block: quarantined, text: quarantinedText },
      { block: invalidAnchor, text: invalidAnchorText },
      { block: missingEvidence, text: missingEvidenceText },
      { block: invalidState, text: invalidStateText },
    ];
    for (const entry of quarantinedBlocks) {
      expect(reopened.require(entry.block.id).text).toBe(entry.text);
      const quarantine = reopened.database.query(`
        SELECT raw_text, reason
        FROM annotation_migration_quarantine
        WHERE annotation_block_id = ?
      `).get(entry.block.id) as { raw_text: string; reason: string } | null;
      expect(quarantine?.raw_text).toBe(entry.text);
      expect(quarantine?.reason.length).toBeGreaterThan(0);
      expect(reopened.database.query(`
        SELECT annotation_block_id
        FROM annotation_targets
        WHERE annotation_block_id = ?
      `).get(entry.block.id)).toBeNull();
    }
    expect(reopened.database.query(
      "SELECT COUNT(*) AS count FROM annotation_migration_quarantine",
    ).get()).toEqual({ count: quarantinedBlocks.length });
    reopened.close();

    const reopenedAgain = new OutlinerStore(path);
    stores[stores.length - 1].store = reopenedAgain;
    expect(reopenedAgain.listAnnotationThreads({
      subject: { kind: "block", blockId: source.id },
      includeResolved: true,
    }).map((thread) => thread.block.id)).toEqual([root.id]);
    expect(reopenedAgain.database.query(
      "SELECT COUNT(*) AS count FROM annotation_migration_quarantine",
    ).get()).toEqual({ count: quarantinedBlocks.length });
    for (const entry of quarantinedBlocks) {
      expect(reopenedAgain.require(entry.block.id).text).toBe(entry.text);
    }
  });



  test("loads only replies belonging to the requested annotation roots", () => {
    const store = makeStore();
    const source = store.create("alpha beta");
    const unrelated = store.create("other source");
    const root = store.createAnnotation("scoped-root", {
      target: blockAnnotationTarget(source, 0, 5, "scoped-source"),
      body: "Root.",
      source: "user",
    }).annotations[0]!;
    const otherRoot = store.createAnnotation("other-root", {
      target: blockAnnotationTarget(unrelated, 0, 5, "other-source"),
      body: "Unrelated root.",
      source: "user",
    }).annotations[0]!;
    const reply = store.replyToAnnotation("scoped-reply", {
      annotationId: root.block.id, body: "Reply.", source: "user",
    }).annotations[0]!;
    const deletedReply = store.replyToAnnotation("deleted-reply", {
      annotationId: root.block.id, body: "Deleted.", source: "user",
    }).annotations[0]!;
    store.replyToAnnotation("other-reply", {
      annotationId: otherRoot.block.id, body: "Unrelated reply.", source: "user",
    });
    const quarantined = store.create([
      "Malformed reply",
      `[type::annotation-reply] [parent-annotation::${root.block.id}] [annotation-status::invalid]`,
      "Retained evidence.",
    ].join("\n"), root.block.id);
    store.database.query(`
      INSERT INTO annotation_migration_quarantine (annotation_block_id, raw_text, reason, created_at)
      VALUES (?, ?, 'invalid lifecycle', ?)
    `).run(quarantined.id, quarantined.text, quarantined.createdAt);
    store.delete(deletedReply.block.id);
    store.move(reply.block.id, null);
    store.create("Ordinary child", root.block.id);
    const threads = store.listAnnotationThreads({
      subject: { kind: "block", blockId: source.id },
    });
    expect(threads.map((thread) => thread.block.id)).toEqual([root.block.id]);
    expect(threads[0]!.replies.map((entry) => entry.block.id)).toEqual([reply.block.id]);
    expect(store.listAnnotationThreads({
      subject: { kind: "resource", resourceId: "no-annotations" },
    })).toEqual([]);
  });

  test("purges subject annotations and moved replies with their dependent data", () => {
    const store = makeStore();
    const source = store.create("alpha beta");
    const child = store.create("child text", source.id);
    const unrelated = store.create("other source");
    const annotate = (block: Block, requestId: string) => store.createAnnotation(requestId, {
      target: blockAnnotationTarget(block, 0, 5, requestId),
      body: "Comment.",
      source: "user",
    }).annotations[0]!.block;
    const root = annotate(source, "purge-root");
    const childRoot = annotate(child, "purge-child-root");
    const otherRoot = annotate(unrelated, "retained-root");
    const reply = store.replyToAnnotation("purge-reply", {
      annotationId: root.id, body: "Moved reply.", source: "user",
    }).annotations[0]!.block;
    const otherReply = store.replyToAnnotation("retained-reply", {
      annotationId: otherRoot.id, body: "Retained reply.", source: "user",
    }).annotations[0]!.block;
    store.patchProperties(otherReply.id, otherReply.updatedAt, [
      { op: "append", key: "parent-annotation", value: root.id },
    ]);
    const replyChild = store.create("Reply child", reply.id);
    const replyAnnotation = annotate(reply, "purge-reply-annotation");
    store.move(root.id, null);
    store.move(reply.id, null);
    store.move(replyAnnotation.id, null);
    store.delete(source.id);
    const sequence = store.sequence;
    const doomed = [source, child, root, childRoot, reply, replyChild, replyAnnotation];
    const receipts = store.database.query("SELECT * FROM annotation_requests ORDER BY request_id").all();
    store.database.exec(`
      CREATE TRIGGER prevent_subject_purge BEFORE DELETE ON blocks
      WHEN OLD.id = '${source.id}'
      BEGIN SELECT RAISE(ABORT, 'purge blocked'); END;
    `);
    expect(() => store.purge(source.id, source.id.slice(0, 8))).toThrow("purge blocked");
    for (const block of doomed) expect(store.get(block.id)).not.toBeNull();
    expect(store.database.query("SELECT COUNT(*) AS count FROM annotation_targets").get()).toEqual({ count: 4 });
    expect(store.database.query("SELECT COUNT(*) AS count FROM annotation_resolution_events").get()).toEqual({ count: 4 });
    expect(store.sequence).toBe(sequence);
    expect(store.database.query("SELECT * FROM annotation_requests ORDER BY request_id").all()).toEqual(receipts);
    store.database.exec("DROP TRIGGER prevent_subject_purge");

    store.purge(source.id, source.id.slice(0, 8));

    for (const block of doomed) expect(store.get(block.id)).toBeNull();
    expect(store.listAnnotationThreads({
      subject: { kind: "block", blockId: unrelated.id },
    })[0]!.replies.map((entry) => entry.block.id)).toEqual([otherReply.id]);
    expect(store.database.query("SELECT annotation_block_id FROM annotation_targets").all()).toEqual([
      { annotation_block_id: otherRoot.id },
    ]);
    expect(store.database.query("SELECT annotation_block_id FROM annotation_resolution_events").all()).toEqual([
      { annotation_block_id: otherRoot.id },
    ]);
    expect(store.database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(store.sequence).toBe(sequence + 1);
    expect(store.createAnnotation("purge-root", {
      target: blockAnnotationTarget(source, 0, 5, "purge-root"),
      body: "Comment.",
      source: "user",
    })).toEqual({ annotations: [], deduplicated: true });
    expect(store.replyToAnnotation("purge-reply", {
      annotationId: root.id, body: "Moved reply.", source: "user",
    })).toEqual({ annotations: [], deduplicated: true });
    expect(() => store.replyToAnnotation("purge-reply", {
      annotationId: root.id, body: "Changed reply.", source: "user",
    })).toThrow("already used with different input");
    expect(store.database.query("SELECT * FROM annotation_requests WHERE request_id LIKE 'retained-%' ORDER BY request_id").all()).toEqual(
      (receipts as Array<{ request_id: string }>).filter((receipt) => receipt.request_id.startsWith("retained-")),
    );
  });

  test("replays only surviving batch results after purge without recreating annotations", () => {
    const store = makeStore();
    const source = store.create("alpha beta");
    const operations = ["first", "purged", "last"].map((operationId) => ({
      operationId,
      type: "create" as const,
      input: {
        target: blockAnnotationTarget(source, 0, 5, "batch-purge-source"),
        body: operationId,
        source: "user" as const,
      },
    }));
    const created = store.createAnnotationBatch("partial-purge", operations);
    const purged = created.annotations[1]!.block;
    store.delete(purged.id);
    store.purge(purged.id, purged.id.slice(0, 8));
    const sequence = store.sequence;

    const replayed = store.createAnnotationBatch("partial-purge", operations);

    expect(replayed.deduplicated).toBe(true);
    expect(replayed.annotations.map((entry) => entry.block.id)).toEqual([
      created.annotations[0]!.block.id,
      created.annotations[2]!.block.id,
    ]);
    expect(store.get(purged.id)).toBeNull();
    expect(store.database.query("SELECT COUNT(*) AS count FROM annotation_targets").get()).toEqual({ count: 2 });
    expect(store.sequence).toBe(sequence);
  });

  test("keeps annotation originals immutable while resolutions advance", () => {
    const store = makeStore();
    const source = store.create("alpha βeta gamma");
    const originalTarget = blockAnnotationTarget(source, 6, 10, "block-source-v1");
    const input = {
      target: originalTarget,
      body: "Check Unicode.",
      source: "agent",
    } satisfies AnnotationCreateInput;
    const created = store.createAnnotation(
      "annotation-create-1",
      input,
      "agent",
      { actorId: "omp", sessionId: "session-1", taskId: "call-1" },
    );
    const replayed = store.createAnnotation(
      "annotation-create-1",
      input,
      "agent",
      { actorId: "omp", sessionId: "session-1", taskId: "call-2" },
    );
    const annotation = created.annotations[0]!;

    expect(created.deduplicated).toBe(false);
    expect(replayed.deduplicated).toBe(true);
    expect(replayed.annotations[0]!.block.id).toBe(annotation.block.id);
    expect(annotation.originalTarget).toEqual(originalTarget);
    expect(annotation.resolvedTarget).toEqual(originalTarget);
    expect(annotation.currentResolution.status).toBe("resolved");
    expect(annotation.resolutionHistory.map((event) => event.sequence)).toEqual([0]);

    const reply = store.replyToAnnotation(
      "annotation-reply-1",
      { annotationId: annotation.block.id, body: "Verified.", source: "user" },
      "user",
    ).annotations[0]!;
    expect(reply.parentAnnotationId).toBe(annotation.block.id);
    expect(reply.originalTarget).toEqual(originalTarget);

    const threads = store.listAnnotationThreads({
      subject: { kind: "block", blockId: source.id },
      includeResolved: true,
    });
    expect(threads).toHaveLength(1);
    expect(threads[0]!.block.id).toBe(annotation.block.id);
    expect(threads[0]!.replies.map((entry) => entry.block.id)).toEqual([reply.block.id]);

    const shiftedSource = store.update(
      source.id,
      `new ${source.text}`,
      source.updatedAt,
      { author: "user", actorId: "detail" },
    );
    const shiftedReceipt = store.reconcileAnnotationThreads({
      subject: { kind: "block", blockId: source.id },
      newRepresentation: blockAnnotationRepresentation(shiftedSource, "block-source-v2"),
    });
    expect(shiftedReceipt.changed).toBe(true);
    const shifted = shiftedReceipt.threads;
    const shiftedTarget = shifted[0]!.resolvedTarget;
    if (!shiftedTarget || shiftedTarget.anchor.kind !== "text-quote") {
      throw new Error("Expected a resolved text quote");
    }
    expect(shifted[0]!.originalTarget).toEqual(originalTarget);
    expect(shiftedTarget.anchor.start).toBe(10);
    expect(shifted[0]!.currentResolution.status).toBe("resolved");
    expect(shifted[0]!.resolutionHistory.map((event) => event.status)).toEqual([
      "resolved",
      "resolved",
    ]);
    expect(shifted[0]!.replies[0]!.resolvedTarget).toEqual(shiftedTarget);
    const unchanged = store.reconcileAnnotationThreads({
      subject: { kind: "block", blockId: source.id },
      newRepresentation: blockAnnotationRepresentation(shiftedSource, "block-source-v2"),
    });
    expect(unchanged.changed).toBe(false);
    expect(unchanged.threads[0]!.resolutionHistory).toHaveLength(2);

    const replacedSource = store.update(
      source.id,
      "new alpha delta gamma",
      shiftedSource.updatedAt,
      { author: "user", actorId: "detail" },
    );
    const orphanedReceipt = store.reconcileAnnotationThreads({
      subject: { kind: "block", blockId: source.id },
      newRepresentation: blockAnnotationRepresentation(replacedSource, "block-source-v3"),
    });
    expect(orphanedReceipt.changed).toBe(true);
    const orphaned = orphanedReceipt.threads[0]!;
    expect(orphaned.originalTarget).toEqual(originalTarget);
    expect(orphaned.resolvedTarget).toBeNull();
    expect(orphaned.currentResolution.status).toBe("orphaned");
    expect(orphaned.resolutionHistory.map((event) => event.status)).toEqual([
      "resolved",
      "resolved",
      "orphaned",
    ]);

    const orphanedHistory = [...orphaned.resolutionHistory];
    const approvedTarget = blockAnnotationTarget(
      replacedSource,
      10,
      15,
      "block-source-v3",
    );
    const approved = store.approveAnnotationResolution({
      annotationId: annotation.block.id,
      target: approvedTarget,
    });
    expect(approved.originalTarget).toEqual(originalTarget);
    expect(approved.resolvedTarget).toEqual(approvedTarget);
    expect(approved.currentResolution.status).toBe("resolved");
    expect(approved.currentResolution.method).toEqual({
      kind: "human",
      method: "approved-target",
    });
    expect(approved.resolutionHistory.slice(0, orphanedHistory.length)).toEqual(
      orphanedHistory,
    );
    expect(approved.resolutionHistory.map((event) => event.sequence)).toEqual([
      0,
      1,
      2,
      3,
    ]);

    const persisted = store.getAnnotation(annotation.block.id);
    expect(persisted.originalTarget).toEqual(originalTarget);
    expect(persisted.resolvedTarget).toEqual(approvedTarget);
    expect(persisted.resolutionHistory).toEqual(approved.resolutionHistory);

    const promoted = store.create("Promoted decision");
    const resolved = store.setAnnotationLifecycle({
      annotationId: annotation.block.id,
      lifecycle: "resolved",
      promotedBlockId: promoted.id,
    }, { author: "agent", actorId: "omp" });
    expect(resolved.lifecycle).toBe("resolved");
    expect(resolved.promotedBlockIds).toEqual([promoted.id]);
    expect(resolved.originalTarget).toEqual(originalTarget);
    expect(resolved.resolvedTarget).toEqual(approvedTarget);
    expect(resolved.resolutionHistory).toEqual(approved.resolutionHistory);
    const replayedAfterSourceChange = store.createAnnotation(
      "annotation-create-1",
      input,
      "agent",
    );
    expect(replayedAfterSourceChange.deduplicated).toBe(true);
    expect(replayedAfterSourceChange.annotations[0]!.block.id).toBe(annotation.block.id);
  });

  test("round-trips a text quote beginning at source offset zero", () => {
    const store = makeStore();
    const source = store.create("alpha 🧭 beta");
    const target = blockAnnotationTarget(source, 0, 8, "block-offset-zero");
    const annotation = store.createAnnotation("annotation-at-zero", {
      target,
      body: "Boundary anchor.",
      source: "user",
    }).annotations[0]!;
    const persisted = store.getAnnotation(annotation.block.id);

    expect(persisted.originalTarget).toEqual(target);
    expect(persisted.resolvedTarget).toEqual(target);
    if (
      !persisted.resolvedTarget ||
      persisted.resolvedTarget.anchor.kind !== "text-quote"
    ) {
      throw new Error("Expected a resolved text quote");
    }
    expect(persisted.resolvedTarget.anchor.start).toBe(0);
    expect(persisted.resolvedTarget.anchor.exact).toBe("alpha 🧭");
  });

  test("preserves rendered passage resolution during canonical block reconciliation", () => {
    const store = makeStore();
    const source = store.create("Hub\n!((view-next))");
    const observation = {
      quote: "PIE-300 — Displayed title\nRendered query result",
      capturedAt: "2026-01-02T03:04:05.000Z",
      hostBlockId: source.id,
      paneId: "w1:p2",
      contentRevision: 42,
      contextId: "context-1",
      detailClientId: "detail-1",
      validation: "detail-pointer",
      projection: "generated",
    } satisfies RenderedPassageObservation;
    const originalTarget = {
      representation: {
        id: "rendered-context-1-r42",
        subject: { kind: "block", blockId: source.id },
        sourceSnapshot: { kind: "rendered", observation },
        adapter: null,
        mediaType: "text/plain",
        contentHash: annotationSourceHash(observation.quote),
        capturedAt: observation.capturedAt,
        observation,
      },
      anchor: createTextQuoteAnchor(
        observation.quote,
        0,
        observation.quote.length,
      ),
    } satisfies AnnotationTarget;
    const root = store.createAnnotation("observed-passage", {
      target: originalTarget,
      body: "Discuss the displayed result.",
      source: "user",
    }).annotations[0]!;
    const updated = store.update(
      source.id,
      "Hub\n!((view-next))\nchanged",
      source.updatedAt,
      { author: "user", actorId: "detail" },
    );
    const reconciliation = store.reconcileAnnotationThreads({
      subject: { kind: "block", blockId: source.id },
      newRepresentation: blockAnnotationRepresentation(updated, "block-hub-v2"),
    });
    expect(reconciliation.changed).toBe(false);
    const thread = reconciliation.threads[0]!;
    const reply = store.replyToAnnotation("observed-reply", {
      annotationId: root.block.id,
      body: "Acknowledged.",
      source: "agent",
    }).annotations[0]!;

    expect(thread.originalTarget).toEqual(originalTarget);
    expect(thread.resolvedTarget).toEqual(originalTarget);
    expect(thread.currentResolution.status).toBe("resolved");
    expect(thread.resolutionHistory.map((event) => event.status)).toEqual(["resolved"]);
    expect(reply.originalTarget).toEqual(originalTarget);
    expect(reply.resolvedTarget).toEqual(originalTarget);
    expect(reply.currentResolution.status).toBe("resolved");
    expect(reply.resolutionHistory).toEqual(thread.resolutionHistory);
  });

  test("rejects an invalid annotation batch without creating its valid prefix", () => {
    const store = makeStore();
    const source = store.create("one two");
    const target = blockAnnotationTarget(source, 0, 3, "block-batch-source");

    expect(() =>
      store.createAnnotationBatch("annotation-batch-invalid", [
        {
          operationId: "valid",
          type: "create",
          input: { target, body: "Would be valid.", source: "agent" },
        },
        {
          operationId: "invalid",
          type: "reply",
          input: {
            annotationId: "00000000-0000-4000-8000-000000000000",
            body: "Missing parent.",
            source: "agent",
          },
        },
      ], "agent", { actorId: "omp" })
    ).toThrow();
    expect(store.listAnnotationThreads({
      subject: { kind: "block", blockId: source.id },
      includeResolved: true,
    })).toEqual([]);
  });
});
