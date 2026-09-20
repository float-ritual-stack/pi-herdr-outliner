import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutlinerStore } from "../src/store";
import { parsePropertyRecords } from "../src/properties";
import { treeSemanticState } from "../src/tree-renderer";
import { migrateRoadmapText } from "../src/roadmap-migration";

const fixtures: Array<{ store: OutlinerStore; directory: string }> = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "outliner-roadmap-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  fixtures.push({ store, directory });
  store.configureWorkIdPrefix("PIE");
  store.create("Work [type::work-queue] [project::test]");
  return store;
}
afterEach(() => {
  for (const { store, directory } of fixtures.splice(0)) {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
const input = { title: "An outcome", project: "test", arc: "workflow", tracks: ["workflow"], priority: "high" as const };

test("roadmap creation and edits have one lifecycle authority; other block statuses survive", () => {
  const store = fixture();
  const { block } = store.createRoadmapItem(input);
  expect(block.properties).not.toContainEqual({ key: "status", value: "planned" });
  expect(block.properties).toContainEqual({ key: "work-stage", value: "unprioritized" });
  expect(() => store.patchProperties(block.id, block.revision, [{ op: "append", key: "status", value: "complete" }])).toThrow("work-stage");
  expect(store.require(block.id).revision).toBe(block.revision);
  expect(() => store.create("Bad [type::roadmap-item] [work-stage::doing] [work-stage::done]")).toThrow("work-stage");
  expect(store.create("Capture [type::capture] [status::unprocessed]").properties).toContainEqual({ key: "status", value: "unprocessed" });
});

test("batch membership survives delivery, reopening and restart without absorbing new backlog", () => {
  let store = fixture();
  const batch = store.create("Commitment [type::work-batch] [project::test]");
  const members = [1, 2, 3].map(n => store.createRoadmapItem({ ...input, title: `Item ${n}`, workBatchId: batch.id }).block);
  const followup = store.createRoadmapItem({ ...input, title: "Discovered follow-up" }).block;
  expect(members[0]!.properties).toContainEqual({ key: "work-stage", value: "queued" });
  for (const [index, stage] of [[1, "doing"], [0, "review"], [1, "validate"], [1, "done"], [1, "doing"]] as const) {
    const block = store.require(members[index]!.id);
    const property = parsePropertyRecords(block.text).find(p => p.scope === "block" && p.key === "work-stage")!;
    store.patchProperties(block.id, block.revision, [{ op: "replace", ordinal: property.ordinal, value: stage }]);
  }
  const entry = fixtures[0]!;
  store.close();
  store = entry.store = new OutlinerStore(join(entry.directory, "outliner.sqlite"));
  const result = store.queryBlocks({ filters: [{ key: "work-batch", value: batch.id }], propertyScope: "block", limit: 10 });
  expect(result.completeness.kind).toBe("complete");
  expect(result.blocks.map(b => b.id).sort()).toEqual(members.map(b => b.id).sort());
  expect(result.blocks.map(b => b.id)).not.toContain(followup.id);
});

test("invalid batch membership cannot consume a work ID or attach to another project", () => {
  const store = fixture();
  const other = store.create("Other batch [type::work-batch] [project::other]");
  expect(() => store.createRoadmapItem({ ...input, workBatchId: other.id })).toThrow("project");
  const note = store.create("Not a batch [project::test]");
  expect(() => store.createRoadmapItem({ ...input, workBatchId: note.id })).toThrow("work-batch");
  expect(store.workIdAllocatorStatus().nextWorkId).toBe("PIE-001");
});

test("roadmap styling follows stage alone and superseded work never looks delivered", () => {
  const properties = [{ key: "type", value: "roadmap-item" }, { key: "status", value: "complete" }];
  expect(treeSemanticState({ properties: [...properties, { key: "work-stage", value: "unprioritized" }] })).toBe("unprioritized");
  expect(treeSemanticState({ properties: [...properties, { key: "work-stage", value: "superseded" }] })).not.toBe("done");
  expect(treeSemanticState({ properties: [{ key: "status", value: "complete" }] })).toBe("done");
});

test("migration preserves supersession, historical prose and idempotence; conflicts stop it", () => {
  const text = "Old task [type::roadmap-item] [status::superseded] [work-stage::done] [superseded-by::replacement]\n\nHistory: `status=planned` described the old model.";
  const migrated = migrateRoadmapText({ id: "old", text });
  expect(migrated).toContain("[work-stage::superseded]");
  expect(migrated).not.toContain("[status::");
  expect(migrated).toContain("History: `status=planned` described the old model.");
  expect(migrateRoadmapText({ id: "old", text: migrated })).toBe(migrated);
  expect(migrateRoadmapText({ id: "next", text: "Next [type::roadmap-item] [status::planned] [work-stage::next]" })).toContain("[work-stage::queued]");
  expect(() => migrateRoadmapText({ id: "conflict", text: "Bad [type::roadmap-item] [status::complete] [work-stage::review]" })).toThrow("disagree");
  expect(() => migrateRoadmapText({ id: "unknown", text: "Bad [type::roadmap-item] [status::planned]" })).toThrow("ambiguous");
  const capture = "Note [type::capture] [status::unprocessed]";
  expect(migrateRoadmapText({ id: "capture", text: capture })).toBe(capture);
});

test("restoring a legacy task does not reintroduce its removed lifecycle property", () => {
  const store = fixture();
  const legacy = store.create("Legacy task");
  store.delete(legacy.id);
  store.database.query("UPDATE blocks SET text = ? WHERE id = ?").run(
    "Legacy [type::roadmap-item] [status::planned] [work-stage::next]", legacy.id,
  );
  const restored = store.restore(legacy.id);
  expect(restored.properties).toContainEqual({ key: "work-stage", value: "queued" });
  expect(restored.properties.some(property => property.key === "status")).toBe(false);
});
