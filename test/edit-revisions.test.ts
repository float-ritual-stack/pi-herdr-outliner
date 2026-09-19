import { afterEach, expect, setSystemTime, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutlinerStore } from "../src/store";

const fixtures: Array<{ root: string; store: OutlinerStore }> = [];
function fixture(): OutlinerStore {
  const root = mkdtempSync(join(tmpdir(), "outliner-edit-revisions-"));
  const store = new OutlinerStore(join(root, "outliner.sqlite"));
  fixtures.push({ root, store });
  return store;
}
afterEach(() => {
  setSystemTime();
  for (const { store, root } of fixtures.splice(0)) {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("normal text updates cannot omit the revision and overwrite a newer edit", () => {
  const store = fixture();
  const block = store.create("Newer content must survive");
  expect(() => store.update(block.id, "Unversioned stale draft", undefined as never))
    .toThrow("revision");
  expect(store.require(block.id).text).toBe("Newer content must survive");
});

test("moving a sibling preserves the version of an unchanged text draft", () => {
  const store = fixture();
  const parent = store.create("Parent");
  const a = store.create("A", parent.id);
  const b = store.create("B", parent.id);
  setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
  store.move(a.id, parent.id, 1);
  expect(store.require(b.id).position).toBe(0);
  expect(store.require(b.id).revision).toBe(b.revision);
  const saved = store.update(b.id, "B edited from the open draft", b.revision);
  expect(saved.text).toBe("B edited from the open draft");
  expect(saved.revision).toBe(b.revision + 1);
});

test("frozen and backwards clocks cannot make an old edit valid again after a move", () => {
  const store = fixture();
  setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
  const original = store.create("Original");
  const edited = store.update(original.id, "Newer edit", original.revision);
  expect(edited.updatedAt).toBe(original.updatedAt);
  expect(edited.revision).toBe(original.revision + 1);
  for (const time of ["2026-01-02T00:00:00.000Z", "2026-01-01T00:00:00.000Z"]) {
    setSystemTime(new Date(time));
    store.move(original.id, null, 0);
    expect(() => store.update(original.id, "Stale draft", original.revision))
      .toThrow("changed since editing began");
    expect(store.require(original.id).text).toBe("Newer edit");
  }
});

test("every specialized body writer invalidates the old text draft", () => {
  const store = fixture();
  store.configureWorkIdPrefix("PIE");
  const cases = [
    { block: store.create("Subject [status::planned]"), write: (id: string, revision: number) =>
      store.patchProperties(id, revision, [{ op: "replace", ordinal: 0, value: "complete" }]) },
    { block: store.create("Page [page::Original]"), write: (id: string, revision: number) =>
      store.renamePageAddress(id, "Renamed", revision) },
    { block: store.create("Page [page::Remove Me]"), write: (id: string, revision: number) =>
      store.removePageAddress(id, "Remove Me", revision) },
    { block: store.create("Work [work-id::PIE-XXX]"), write: (id: string, revision: number) =>
      store.allocateWorkId(id, revision) },
    { block: store.capture("retitle", "Capture body", "cli").block,
      write: (id: string, revision: number) => store.retitleCapture(id, revision, "New title", { author: "user" }) },
  ];
  for (const { block, write } of cases) {
    write(block.id, block.revision);
    const changed = store.require(block.id);
    expect(changed.revision).toBe(block.revision + 1);
    expect(() => store.update(block.id, block.text, block.revision))
      .toThrow("changed since editing began");
    expect(store.require(block.id).text).toBe(changed.text);
  }
});

test("text writes require an active block; moving or restoring unchanged text preserves its revision", () => {
  const store = fixture();
  const parent = store.create("Parent");
  const child = store.create("Child", parent.id);
  store.delete(parent.id);
  expect(() => store.update(child.id, "Draft", child.revision)).toThrow("is in Trash");
  expect(() => store.move(child.id, null)).toThrow("is in Trash");
  expect(() => store.restore(child.id)).toThrow("not a direct Trash root");
  store.restore(parent.id);
  expect(store.require(child.id).revision).toBe(child.revision);
  expect(store.update(child.id, "Draft", child.revision).text).toBe("Draft");
});

test("reopening an old database twice preserves identities, timestamps, text, and the migrated revision", () => {
  const root = mkdtempSync(join(tmpdir(), "outliner-old-revisions-"));
  const path = join(root, "outliner.sqlite");
  const old = new Database(path);
  old.exec(`CREATE TABLE blocks (
    id TEXT PRIMARY KEY, parent_id TEXT REFERENCES blocks(id), position INTEGER NOT NULL,
    text TEXT NOT NULL, author TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  old.query("INSERT INTO blocks VALUES (?, NULL, 0, ?, 'user', ?, ?)")
    .run("legacy-block", "Preserve these bytes 🧭", "2020-01-01T00:00:00.000Z", "2020-02-01T00:00:00.000Z");
  old.close();
  try {
    for (let reopen = 0; reopen < 2; reopen += 1) {
      const store = new OutlinerStore(path);
      try {
        expect(store.require("legacy-block")).toMatchObject({
          id: "legacy-block", parentId: null, position: 0,
          text: "Preserve these bytes 🧭", revision: 1,
          createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-02-01T00:00:00.000Z",
        });
      } finally {
        store.close();
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
