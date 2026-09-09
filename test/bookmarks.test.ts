import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBookmarkRecord } from "../src/bookmarks";
import { OutlinerStore } from "../src/store";

const stores: Array<{ store: OutlinerStore; directory: string }> = [];

function makeStore(): OutlinerStore {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-bookmarks-"));
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

describe("canonical bookmarks", () => {
  test("seeds one virtual Bookmarks root and persists it across restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-outliner-bookmark-root-"));
    const path = join(directory, "outliner.sqlite");
    const first = new OutlinerStore(path);
    const root = first.bookmarksRoot();
    expect(root.properties).toContainEqual({ key: "system-view", value: "bookmarks" });
    expect(root.properties).toContainEqual({ key: "type", value: "virtual-branch" });
    expect(root.properties).toContainEqual({ key: "query", value: "type=bookmark" });
    first.close();

    const reopened = new OutlinerStore(path);
    expect(reopened.bookmarksRoot().id).toBe(root.id);
    reopened.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("rejects malformed reserved roots and non-canonical target IDs", () => {
    const store = makeStore();
    const root = store.bookmarksRoot();
    store.update(
      root.id,
      "Bookmarks [system-view::bookmarks] [query::type=bookmark] [limit::1000] [summary-properties::target,bookmark-created]",
      root.updatedAt,
      { author: "user", actorId: "test" },
    );
    expect(() => store.bookmarksRoot()).toThrow(
      `Bookmarks root ${root.id} must contain exactly one [type::…]`,
    );

    const other = makeStore();
    const added = other.toggleBookmark(other.create("Target").id, null);
    const malformed = {
      ...added.record,
      properties: added.record.properties.map((property) =>
        property.key === "target" ? { ...property, value: "not-a-canonical-id" } : property
      ),
    };
    expect(() => parseBookmarkRecord(malformed)).toThrow(
      `Bookmark record ${added.record.id} has invalid canonical target ID`,
    );
  });

  test("toggles one strict record without modifying the target", () => {
    const store = makeStore();
    const target = store.create("Durable target\nNotes stay here");

    const added = store.toggleBookmark(target.id, null);
    const parsed = parseBookmarkRecord(added.record);
    expect(added.bookmarked).toBe(true);
    expect(added.record.parentId).toBe(added.root.id);
    expect(parsed.targetBlockId).toBe(target.id);
    expect(parsed.createdAt).toBe(added.record.createdAt);
    expect(parsed.label).toBe("Durable target");
    expect(store.require(target.id).text).toBe(target.text);
    expect(store.bookmarkStatus(target.id).record?.id).toBe(added.record.id);

    const removed = store.toggleBookmark(target.id, added.record.id);
    expect(removed.bookmarked).toBe(false);
    expect(removed.record.deletedAt).toBeDefined();
    expect(store.bookmarkStatus(target.id).record).toBeNull();
    expect(store.restore(added.record.id).id).toBe(added.record.id);
    expect(store.bookmarkStatus(target.id).record?.id).toBe(added.record.id);
  });

  test("retains target identity through rename and move", () => {
    const store = makeStore();
    const parent = store.create("Parent");
    const target = store.create("Original title");
    const added = store.toggleBookmark(target.id, null);

    const renamed = store.update(target.id, "Renamed target", target.updatedAt, {
      author: "user",
      actorId: "test",
    });
    store.move(target.id, parent.id);
    const resolved = store.resolveBookmark(added.record.id);

    expect(resolved.target?.id).toBe(target.id);
    expect(resolved.target?.text).toBe(renamed.text);
    expect(resolved.target?.parentId).toBe(parent.id);
    expect(parseBookmarkRecord(resolved.record).label).toBe("Original title");
  });

  test("surfaces unavailable targets and removes their records optimistically", () => {
    const store = makeStore();
    const target = store.create("Temporary target");
    const added = store.toggleBookmark(target.id, null);
    store.delete(target.id);

    expect(store.resolveBookmark(added.record.id)).toMatchObject({
      target: null,
      unavailableReason: "Bookmark target is in Trash",
    });
    expect(() => store.removeBookmark(added.record.id, "stale")).toThrow(
      "Bookmark changed; refresh and retry",
    );
    const removed = store.removeBookmark(added.record.id, added.record.updatedAt);
    expect(removed.targetBlockId).toBe(target.id);
    expect(removed.record.deletedAt).toBeDefined();
  });

  test("rejects stale toggles and duplicate active target records", () => {
    const store = makeStore();
    const target = store.create("Target");
    const first = store.toggleBookmark(target.id, null);
    expect(() => store.toggleBookmark(target.id, null)).toThrow(
      "Bookmark changed; refresh and retry",
    );

    store.toggleBookmark(target.id, first.record.id);
    const second = store.toggleBookmark(target.id, null);
    store.restore(first.record.id);
    expect(() => store.bookmarkStatus(target.id)).toThrow(
      `Duplicate active bookmark records for ${target.id}`,
    );
    expect(second.record.id).not.toBe(first.record.id);
  });

  test("ignores bookmark-shaped properties outside the reserved root", () => {
    const store = makeStore();
    store.create("Unrelated block\n[type::bookmark]");
    const target = store.create("Target");

    const added = store.toggleBookmark(target.id, null);

    expect(store.bookmarkStatus(target.id).record?.id).toBe(added.record.id);
  });

  test("validates optional labels before creating property metadata", () => {
    const store = makeStore();

    const target = store.create("Target");
    expect(() => store.toggleBookmark(target.id, null, "bad [label]"))
      .toThrow("Bookmark label cannot contain line breaks or property delimiters");
  });
  test("defaults to creation order and retains optional manual occurrence ranks", () => {
    const store = makeStore();
    const first = store.toggleBookmark(store.create("First").id, null);
    const second = store.toggleBookmark(store.create("Second").id, null);
    const query = () => store.queryBlocks({
      filters: [{ key: "type", value: "bookmark" }],
      rankViewId: first.root.id,
      limit: 1000,
    }).blocks.map((block) => block.id);

    expect(query()).toEqual([first.record.id, second.record.id]);
    store.reorderVirtualOccurrences(first.root.id, [second.record.id, first.record.id]);
    expect(query()).toEqual([second.record.id, first.record.id]);
  });
});
