// PIE-451: who moved, trashed or restored a block. `move`, `delete` and `trash.restore` accept an
// optional `mutation` (capability `mutations.provenance`), recorded like an update's in the change
// feed and in activity. Without it, nothing changes for older clients.
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutlinerClient } from "../src/client";
import { detailRestoreRequest } from "../src/detail-controller";
import { EditRecoveryRepository } from "../src/edit-recovery";
import { OutlinerServer } from "../src/server";
import { requireCapabilities } from "../src/service-compatibility";
import { OutlinerStore } from "../src/store";
import type {
  Block,
  BlockEditActivityPage,
  ChangeFeedPage,
  OutlinerChange,
  OutlinerServiceStatus,
} from "../src/types";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-mutation-provenance-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function service() {
  const directory = workspace();
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  const server = new OutlinerServer(store, join(directory, "outliner.sock"));
  await server.start();
  cleanups.push(async () => { await server.close(); store.close(); });
  return { store, client: new OutlinerClient(join(directory, "outliner.sock")) };
}

const gardenAgent = { author: "agent" as const, actorId: "garden-agent", sessionId: "s-7", taskId: "t-3" };

async function changesSince(client: OutlinerClient, sequence: number): Promise<OutlinerChange[]> {
  const page = await client.request<ChangeFeedPage>({ action: "changes.since", sequence });
  if (page.kind !== "changes") throw new Error(`Unexpected reset: ${page.reason}`);
  return page.changes;
}

const activity = (client: OutlinerClient, request: Record<string, unknown>) =>
  client.request<BlockEditActivityPage>({ action: "activity.recent", limit: 50, ...request } as never);

test("the service advertises mutations.provenance", async () => {
  const { client } = await service();
  const status = await client.request<OutlinerServiceStatus>({ action: "ping" });
  expect(status.capabilities).toContain("mutations.provenance");
  expect(() => requireCapabilities(status, ["mutations.provenance"])).not.toThrow();
  expect(() => requireCapabilities({ ...status, capabilities: ["changes.since"] }, ["mutations.provenance"]))
    .toThrow("does not support mutations.provenance");
});

test("an agent's move, trash and restore are attributed to the agent in the change feed and activity", async () => {
  const { store, client } = await service();
  const beds = store.create("Raised beds");
  const seedlings = store.create("Seedlings to plant out");
  const start = store.sequence;

  await client.request<Block>({ action: "move", blockId: seedlings.id, parentId: beds.id, mutation: gardenAgent });
  const moved = await activity(client, { author: "agent", kinds: ["move"] });
  expect(moved.entries.map(entry => [entry.block.id, entry.kind, entry.actorId, entry.sessionId, entry.taskId]))
    .toEqual([[seedlings.id, "move", "garden-agent", "s-7", "t-3"]]);

  await client.request<Block>({ action: "delete", blockId: seedlings.id, mutation: gardenAgent });
  const trashed = await activity(client, { author: "agent", kinds: ["move", "delete", "restore"] });
  // The trashed block is listed for the entry that trashed it.
  expect(trashed.entries.map(entry => [entry.block.id, entry.kind, Boolean(entry.block.deletedAt)]))
    .toEqual([[seedlings.id, "delete", true]]);

  await client.request<Block>({ action: "trash.restore", blockId: seedlings.id, mutation: gardenAgent });
  const restored = await activity(client, { author: "agent", kinds: ["move", "delete", "restore"] });
  expect(restored.entries.map(entry => [entry.block.id, entry.kind, entry.actorId]))
    .toEqual([[seedlings.id, "restore", "garden-agent"]]);

  const changes = await changesSince(client, start);
  expect(changes.map(change => [change.action, change.kind, change.blockId, change.actor])).toEqual([
    ["move", "move", seedlings.id, gardenAgent],
    ["delete", "delete", seedlings.id, gardenAgent],
    ["trash.restore", "restore", seedlings.id, gardenAgent],
  ]);
  // Nothing is recorded as the person's.
  expect((await activity(client, { author: "user", kinds: ["move", "delete", "restore"] })).entries).toEqual([]);
});

test("an agent's move without an actor is refused, and nothing moves or is recorded", async () => {
  const { store, client } = await service();
  const shed = store.create("Shed");
  const trowel = store.create("Trowel");
  const start = store.sequence;
  await expect(client.request({ action: "move", blockId: trowel.id, parentId: shed.id, mutation: { author: "agent" } }))
    .rejects.toThrow("Agent mutation provenance requires actorId");
  await expect(client.request({ action: "delete", blockId: trowel.id, mutation: { author: "robot" } as never }))
    .rejects.toThrow("Mutation provenance must identify user, agent, or system");
  expect(store.get(trowel.id)!.parentId).toBeNull();
  expect(store.get(trowel.id)!.deletedAt).toBeFalsy();
  expect(store.sequence).toBe(start);
  expect(await changesSince(client, start)).toEqual([]);
});

test("an older client's move, trash and restore stay unattributed and add no activity, as before", async () => {
  const { store, client } = await service();
  const orchard = store.create("Orchard");
  const pruning = store.create("Pruning notes");
  // The person edited the note; that is still its latest activity.
  store.update(pruning.id, "Pruning notes, winter", pruning.revision, { author: "user", actorId: "detail" });
  const start = store.sequence;

  // The request shapes an older client sends: no mutation, no kinds.
  await client.request({ action: "move", blockId: pruning.id, parentId: orchard.id });
  await client.request({ action: "delete", blockId: orchard.id });
  await client.request({ action: "trash.restore", blockId: orchard.id });

  const changes = await changesSince(client, start);
  expect(changes.map(change => change.kind)).toEqual(["move", "delete", "restore"]);
  expect(changes.every(change => change.actor === undefined)).toBe(true);
  for (const author of ["user", "agent", "system"]) {
    expect((await activity(client, { author, kinds: ["move", "delete", "restore"] })).entries).toEqual([]);
  }
  const edits = await activity(client, { author: "user" });
  expect(edits.entries.map(entry => [entry.block.id, entry.kind])).toEqual([[pruning.id, "text"]]);
});

test("activity without kinds still returns edits only, even after an attributed move or trash", async () => {
  const { store, client } = await service();
  const compost = store.create("Compost rota");
  const tools = store.create("Tools");
  store.update(compost.id, "Compost rota, weekly", compost.revision, { author: "agent", actorId: "garden-agent" });
  const edited = await activity(client, { author: "agent" });

  await client.request({ action: "move", blockId: compost.id, parentId: tools.id, mutation: gardenAgent });
  await client.request({ action: "delete", blockId: tools.id, mutation: gardenAgent });
  const later = await activity(client, { author: "agent" });
  // An older client sees what it saw before: the edit, not the move; a trashed note is not listed.
  expect(edited.entries.map(entry => [entry.block.id, entry.kind])).toEqual([[compost.id, "text"]]);
  expect(later.entries).toEqual([]);
  expect(later.cursor).toBe(edited.cursor);
  await client.request({ action: "trash.restore", blockId: tools.id });
  expect((await activity(client, { author: "agent" })).entries.map(entry => [entry.block.id, entry.kind]))
    .toEqual([[compost.id, "text"]]);
  await expect(activity(client, { author: "agent", kinds: ["rename"] })).rejects.toThrow("Activity kinds must be");
  await expect(activity(client, { author: "agent", kinds: [] })).rejects.toThrow("Activity kinds must be");
  // Over RPC, a malformed `kinds` gets the same clear error, not a runtime type error.
  for (const kinds of [5, "move", { move: true }, [5]]) {
    await expect(activity(client, { author: "agent", kinds })).rejects.toThrow("Activity kinds must be a non-empty list of text, properties, move, delete, restore");
  }
});

test("an attributed move does not count as the note's latest edit for edit recovery", () => {
  const directory = workspace();
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  cleanups.push(() => store.close());
  const beds = store.create("Beds");
  const note = store.create("Sowing plan");
  const edited = store.update(note.id, "Sowing plan, March", note.revision, { author: "user", actorId: "detail" });
  store.move(note.id, beds.id, undefined, gardenAgent);
  const record = new EditRecoveryRepository(store).start({
    id: crypto.randomUUID(), blockId: note.id, baseText: edited.text, baseRevision: edited.revision,
    prelaunchText: edited.text, draftText: `${edited.text}\nLeeks`, source: "external-editor",
  });
  expect([record.latestEdit?.author, record.latestEdit?.actorId, record.latestEdit?.kind]).toEqual(["user", "detail", "text"]);
});

test("an older workspace's activity table is rebuilt once, keeping its rows and cursor", () => {
  const directory = workspace();
  const database = join(directory, "outliner.sqlite");
  const first = new OutlinerStore(database);
  const note = first.create("Greenhouse");
  first.update(note.id, "Greenhouse, vented", note.revision, { author: "user", actorId: "detail" });
  first.close();

  // Recreate the table as older builds made it, with a cursor already past its rows.
  const raw = new Database(database);
  raw.exec(`
    CREATE TABLE old_activity AS SELECT * FROM block_edit_activity;
    DROP TABLE block_edit_activity;
    CREATE TABLE block_edit_activity (
      activity_id INTEGER PRIMARY KEY AUTOINCREMENT,
      block_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
      author TEXT NOT NULL CHECK (author IN ('user', 'agent', 'system')),
      actor_id TEXT,
      session_id TEXT,
      task_id TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('text', 'properties')),
      edited_at TEXT NOT NULL
    );
    INSERT INTO block_edit_activity SELECT * FROM old_activity;
    DROP TABLE old_activity;
    UPDATE sqlite_sequence SET seq = 40 WHERE name = 'block_edit_activity';
  `);
  const before = raw.query("SELECT * FROM block_edit_activity ORDER BY activity_id").all();
  expect(before.length).toBeGreaterThan(0);
  raw.close();

  const reopened = new OutlinerStore(database);
  expect(reopened.database.query("SELECT * FROM block_edit_activity ORDER BY activity_id").all()).toEqual(before);
  const tray = reopened.create("Seed tray");
  reopened.move(note.id, tray.id, undefined, gardenAgent);
  const moved = reopened.recentEditActivity({ author: "agent", kinds: ["move"] });
  expect(moved.entries.map(entry => [entry.block.id, entry.kind])).toEqual([[note.id, "move"]]);
  // A client holding an older cursor still sees the new entry.
  expect(moved.cursor).toBeGreaterThan(40);
  const schema = (reopened.database.query("SELECT sql FROM sqlite_master WHERE name = 'block_edit_activity'").get() as { sql: string }).sql;
  reopened.close();

  const again = new OutlinerStore(database);
  cleanups.push(() => again.close());
  expect((again.database.query("SELECT sql FROM sqlite_master WHERE name = 'block_edit_activity'").get() as { sql: string }).sql).toBe(schema);
  expect(again.recentEditActivity({ author: "agent", kinds: ["move"] }).entries.length).toBe(1);
  expect(again.recentEditActivity({ author: "user" }).entries.map(entry => [entry.block.id, entry.kind])).toEqual([[note.id, "text"]]);
});

test("an orphaned activity row does not erase the history when the table is rebuilt", () => {
  const directory = workspace();
  const database = join(directory, "outliner.sqlite");
  const first = new OutlinerStore(database);
  const kept = first.create("Cold frame");
  first.update(kept.id, "Cold frame, propped open", kept.revision, { author: "user", actorId: "detail" });
  first.close();

  const raw = new Database(database);
  raw.exec(`
    PRAGMA foreign_keys = OFF;
    CREATE TABLE old_activity AS SELECT * FROM block_edit_activity;
    DROP TABLE block_edit_activity;
    CREATE TABLE block_edit_activity (
      activity_id INTEGER PRIMARY KEY AUTOINCREMENT,
      block_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
      author TEXT NOT NULL CHECK (author IN ('user', 'agent', 'system')),
      actor_id TEXT,
      session_id TEXT,
      task_id TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('text', 'properties')),
      edited_at TEXT NOT NULL
    );
    INSERT INTO block_edit_activity SELECT * FROM old_activity;
    DROP TABLE old_activity;
    -- A row whose block is gone, as a raw delete with foreign keys off leaves behind.
    INSERT INTO block_edit_activity (block_id, author, kind, edited_at)
      VALUES ('00000000-0000-4000-8000-00000000dead', 'user', 'text', '2026-01-01T00:00:00.000Z');
  `);
  const total = (raw.query("SELECT COUNT(*) AS n FROM block_edit_activity").get() as { n: number }).n;
  const live = raw.query(
    "SELECT * FROM block_edit_activity WHERE block_id IN (SELECT id FROM blocks) ORDER BY activity_id",
  ).all();
  expect(live.length).toBe(total - 1);
  raw.close();

  const reopened = new OutlinerStore(database);
  cleanups.push(() => reopened.close());
  // Every row with a block survives; only the orphan, which no reader could show, is dropped.
  expect(reopened.database.query("SELECT * FROM block_edit_activity ORDER BY activity_id").all()).toEqual(live);
  expect(reopened.recentEditActivity({ author: "user" }).entries.map(entry => [entry.block.id, entry.kind]))
    .toEqual([[kept.id, "text"]]);
});

test("an agent's trash entry is hidden once the block is out of Trash, and the person's restore is the latest entry", async () => {
  const { store, client } = await service();
  const mulch = store.create("Mulch order");
  await client.request({ action: "delete", blockId: mulch.id, mutation: gardenAgent });
  const every = { kinds: ["text", "properties", "move", "delete", "restore"] };
  expect((await activity(client, { author: "agent", ...every })).entries.map(entry => entry.kind)).toEqual(["delete"]);

  // An unrecorded restore (an older client): the agent's "delete" no longer describes the block.
  await client.request({ action: "trash.restore", blockId: mulch.id });
  expect((await activity(client, { author: "agent", ...every })).entries).toEqual([]);

  // Trashed again by the agent and restored by the person through the Tree's request shape.
  await client.request({ action: "delete", blockId: mulch.id, mutation: gardenAgent });
  await client.request({ action: "trash.restore", blockId: mulch.id, mutation: { author: "user", actorId: "tree" } });
  expect((await activity(client, { author: "agent", ...every })).entries).toEqual([]);
  expect((await activity(client, { author: "user", ...every })).entries.map(entry => [entry.kind, entry.actorId]))
    .toEqual([["restore", "tree"]]);
});

test("Detail's restore request says the person restored the block through Detail", async () => {
  const { store, client } = await service();
  const trellis = store.create("Trellis plan");
  await client.request({ action: "delete", blockId: trellis.id, mutation: gardenAgent });
  await client.request(detailRestoreRequest(trellis.id));
  const entries = (await activity(client, { author: "user", kinds: ["restore"] })).entries;
  expect(entries.map(entry => [entry.block.id, entry.kind, entry.actorId])).toEqual([[trellis.id, "restore", "detail"]]);
});
