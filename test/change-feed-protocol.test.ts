import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutlinerClient } from "../src/client";
import { OutlinerServer } from "../src/server";
import { OutlinerStore } from "../src/store";
import type { Block, ChangeFeedPage, OutlinerChange, OutlinerEvent } from "../src/types";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function workspace(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function service(directory: string, database = join(directory, "outliner.sqlite")) {
  const store = new OutlinerStore(database);
  const socket = join(directory, "outliner.sock");
  const server = new OutlinerServer(store, socket);
  await server.start();
  let open = true;
  const stop = async () => {
    if (!open) return;
    open = false;
    await server.close();
    store.close();
  };
  cleanups.push(stop);
  /** Simulates a process that exits without closing its store. */
  const crash = async () => {
    open = false;
    await server.close();
    store.database.close();
    (store as unknown as { releaseOwnership(): void }).releaseOwnership();
  };
  return { store, server, client: new OutlinerClient(socket), socket, stop, crash };
}

async function watch(client: OutlinerClient, clientId: string) {
  const connected = Promise.withResolvers<void>();
  const events: OutlinerEvent[] = [];
  const watcher = client.watch({
    client: { clientId, role: "observer", contextId: clientId },
    onConnect: connected.resolve,
    onEvent: event => { events.push(event); },
  });
  cleanups.push(() => watcher.stop());
  await connected.promise;
  return { events, watcher };
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for events");
    await Bun.sleep(5);
  }
}

async function readAll(client: OutlinerClient, sequence: number, limit: number): Promise<OutlinerChange[]> {
  const changes: OutlinerChange[] = [];
  for (;;) {
    const page = await client.request<ChangeFeedPage>({ action: "changes.since", sequence, limit });
    if (page.kind !== "changes") throw new Error(`Unexpected reset: ${page.reason}`);
    changes.push(...page.changes);
    if (page.completeness.kind === "complete") return changes;
    expect(page.nextSequence).toBeGreaterThan(sequence);
    sequence = page.nextSequence;
  }
}

test("content events carry parent, revision, actor and kind while keeping existing fields", async () => {
  const { client, store } = await service(workspace("pi-outliner-change-events-"));
  const start = store.sequence;
  const { events } = await watch(client, "change-observer");
  const project = await client.request<Block>({ action: "create", text: "Fictional project" });
  const archive = await client.request<Block>({ action: "create", text: "Fictional archive" });
  const task = await client.request<Block>({
    action: "create", parentId: project.id, text: "Draft the orbit schedule",
    author: "agent", provenance: { actorId: "planner-bot", sessionId: "session-7" },
  });
  const edited = await client.request<Block>({
    action: "update", blockId: task.id, text: "Draft the orbit schedule [status::ready]",
    expectedRevision: task.revision, mutation: { author: "agent", actorId: "planner-bot", taskId: "task-3" },
  });
  await client.request({ action: "move", blockId: task.id, parentId: archive.id });
  await client.request({ action: "delete", blockId: task.id });
  await client.request({ action: "trash.restore", blockId: task.id });
  await client.request({ action: "delete", blockId: task.id });
  await client.request({ action: "trash.purge", blockId: task.id, confirmation: task.id.slice(0, 8) });
  await until(() => events.filter(event => event.domain === "content").length === 9);

  const content = events.filter(event => event.domain === "content");
  // Existing subscribers still receive domain, action, sequence and blockId.
  expect(content.map(event => [event.action, event.blockId])).toEqual([
    ["create", project.id], ["create", archive.id], ["create", task.id], ["update", task.id],
    ["move", task.id], ["delete", task.id], ["trash.restore", task.id], ["delete", task.id],
    ["trash.purge", task.id],
  ]);
  const changes = content.map(event => event.change!);
  expect(changes.map(change => change.kind)).toEqual([
    "create", "create", "create", "edit", "move", "delete", "restore", "delete", "purge",
  ]);
  expect(changes[2]).toMatchObject({
    blockId: task.id, parentId: project.id, revision: 1, deleted: false,
    actor: { author: "agent", actorId: "planner-bot", sessionId: "session-7" },
  });
  expect(changes[3]).toMatchObject({
    parentId: project.id, revision: edited.revision,
    actor: { author: "agent", actorId: "planner-bot", taskId: "task-3" },
  });
  expect(changes[4]).toMatchObject({ parentId: archive.id, previousParentId: project.id, revision: edited.revision });
  expect(changes[4]!.actor).toBeUndefined();
  expect(changes[5]).toMatchObject({ kind: "delete", deleted: true, parentId: archive.id });
  expect(changes[6]).toMatchObject({ kind: "restore", deleted: false });
  expect(changes[8]).toEqual({
    sequence: content[8]!.sequence, changeId: changes[8]!.changeId, action: "trash.purge",
    kind: "purge", blockId: task.id, recordedAt: changes[8]!.recordedAt,
  });
  for (const event of content) expect(event.change!.sequence).toBe(event.sequence);
  // Tree relies on every outline change advancing the sequence.
  content.slice(1).forEach((event, index) => expect(event.sequence).toBeGreaterThan(content[index]!.sequence));
  // The live event and the durable feed entry are the same record.
  expect(await readAll(client, start, 1000)).toEqual(changes);
  expect(store.sequence).toBe(content.at(-1)!.sequence);
});

test("changes.since pages in order, never splits a sequence, and validates its bounds", async () => {
  const { client, store } = await service(workspace("pi-outliner-change-pages-"));
  const start = store.sequence;
  const blocks: Block[] = [];
  for (let index = 0; index < 7; index += 1) {
    blocks.push(await client.request<Block>({ action: "create", text: `Fictional note ${index}` }));
  }
  const all = await readAll(client, start, 1000);
  expect(all.map(change => change.blockId)).toEqual(blocks.map(block => block.id));
  const sequences = all.map(change => change.sequence);
  expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  expect(new Set(sequences).size).toBe(sequences.length);

  const first = await client.request<ChangeFeedPage>({ action: "changes.since", sequence: start, limit: 3 });
  expect(first).toMatchObject({ kind: "changes", completeness: { kind: "truncated", limit: 3 }, sequence: store.sequence });
  if (first.kind !== "changes") throw new Error("expected changes");
  expect(first.changes).toEqual(all.slice(0, 3));
  expect(first.nextSequence).toBe(all[2]!.sequence);
  expect(await readAll(client, start, 2)).toEqual(all);

  const caughtUp = await client.request<ChangeFeedPage>({ action: "changes.since", sequence: store.sequence });
  expect(caughtUp).toEqual({
    kind: "changes", changes: [], nextSequence: store.sequence,
    completeness: { kind: "complete" }, sequence: store.sequence,
  });

  // An internal transaction can report several changes at one sequence.
  const shared = store.sequence;
  store.changes.record({ sequence: shared, action: "fixture.a", kind: "other" });
  store.changes.record({ sequence: shared, action: "fixture.b", kind: "other" });
  const grouped = await client.request<ChangeFeedPage>({ action: "changes.since", sequence: all.at(-1)!.sequence - 1, limit: 2 });
  if (grouped.kind !== "changes") throw new Error("expected changes");
  expect(grouped.changes.map(change => change.action)).toEqual(["create", "fixture.a", "fixture.b"]);
  expect(grouped.nextSequence).toBe(shared);

  for (const request of [
    { sequence: -1 }, { sequence: 1.5 }, { sequence: 0, limit: 0 }, { sequence: 0, limit: 1001 },
  ]) {
    await expect(client.request({ action: "changes.since", ...request })).rejects.toThrow("changes.since");
  }
});

test("a reconnecting client catches up on exactly what it missed, in order", async () => {
  const { client } = await service(workspace("pi-outliner-change-reconnect-"));
  const parent = await client.request<Block>({ action: "create", text: "Fictional inbox" });
  const first = await watch(client, "reconnecting-reader");
  const seen = await client.request<Block>({ action: "create", parentId: parent.id, text: "Seen while connected" });
  await until(() => first.events.some(event => event.blockId === seen.id));
  const cursor = first.events.at(-1)!.sequence;
  await first.watcher.stop();

  const missed = [
    await client.request<Block>({ action: "create", parentId: parent.id, text: "Missed one" }),
    await client.request<Block>({ action: "create", parentId: parent.id, text: "Missed two" }),
  ];
  await client.request({ action: "move", blockId: missed[1]!.id, parentId: parent.id, position: 0 });
  await client.request({
    action: "update", blockId: missed[0]!.id, text: "Missed one, revised",
    expectedRevision: missed[0]!.revision, mutation: { author: "user" },
  });

  // Subscribe first, then read the gap, so nothing falls between the two.
  const second = await watch(client, "reconnecting-reader");
  const page = await client.request<ChangeFeedPage>({ action: "changes.since", sequence: cursor, limit: 50 });
  if (page.kind !== "changes") throw new Error("expected changes");
  expect(page.completeness).toEqual({ kind: "complete" });
  expect(page.changes.map(change => [change.kind, change.blockId, change.parentId])).toEqual([
    ["create", missed[0]!.id, parent.id],
    ["create", missed[1]!.id, parent.id],
    ["move", missed[1]!.id, parent.id],
    ["edit", missed[0]!.id, parent.id],
  ]);
  expect(page.changes.every(change => change.sequence > cursor)).toBe(true);
  expect(page.changes[3]!.revision).toBe(missed[0]!.revision + 1);
  expect(second.events).toEqual([]);

  const after = await client.request<Block>({ action: "create", parentId: parent.id, text: "Live again" });
  await until(() => second.events.some(event => event.blockId === after.id));
  expect(second.events.at(-1)!.change!.sequence).toBeGreaterThan(page.nextSequence);
});

test("retention answers too-old and future cursors with an explicit reset", async () => {
  const { client, store } = await service(workspace("pi-outliner-change-retention-"));
  const start = store.sequence;
  store.changes.retention = 3;
  const blocks: Block[] = [];
  for (let index = 0; index < 5; index += 1) {
    blocks.push(await client.request<Block>({ action: "create", text: `Retained note ${index}` }));
  }
  const tooOld = await client.request<ChangeFeedPage>({ action: "changes.since", sequence: start });
  expect(tooOld).toEqual({
    kind: "reset", reason: "history-unavailable", oldestSequence: store.changes.floor, sequence: store.sequence,
  });
  expect(store.changes.floor).toBeGreaterThan(start);
  const oldest = await readAll(client, store.changes.floor, 10);
  expect(oldest.map(change => change.blockId)).toEqual(blocks.slice(2).map(block => block.id));

  const ahead = await client.request<ChangeFeedPage>({ action: "changes.since", sequence: store.sequence + 1 });
  expect(ahead).toMatchObject({ kind: "reset", reason: "sequence-ahead", sequence: store.sequence });
});

test("history survives a clean restart, but not a crash, an offline write or a pre-feed workspace", async () => {
  const directory = workspace("pi-outliner-change-restart-");
  const database = join(directory, "outliner.sqlite");
  let running = await service(directory, database);
  const start = running.store.sequence;
  const note = await running.client.request<Block>({ action: "create", text: "Survives restart" });
  await running.stop();

  running = await service(directory, database);
  expect(await readAll(running.client, start, 10)).toMatchObject([{ kind: "create", blockId: note.id }]);
  const beforeCrash = running.store.sequence;
  await running.client.request<Block>({ action: "create", text: "Written before a crash" });
  await running.crash();

  running = await service(directory, database);
  const afterCrash = running.store.sequence;
  expect(await running.client.request<ChangeFeedPage>({ action: "changes.since", sequence: beforeCrash }))
    .toMatchObject({ kind: "reset", reason: "history-unavailable", oldestSequence: afterCrash });
  expect(await readAll(running.client, afterCrash, 10)).toEqual([]);
  await running.stop();

  // A process other than the service wrote without recording the change.
  const offline = new OutlinerStore(database);
  offline.create("Written by a maintenance script");
  offline.close();
  running = await service(directory, database);
  expect(await running.client.request<ChangeFeedPage>({ action: "changes.since", sequence: afterCrash }))
    .toMatchObject({ kind: "reset", reason: "history-unavailable", oldestSequence: running.store.sequence });
  await running.stop();

  // An existing workspace from before the feed has no history to replay.
  const legacy = new Database(database);
  legacy.exec("DROP TABLE change_feed; DELETE FROM metadata WHERE key LIKE 'change_feed_%';");
  const legacySequence = Number((legacy.query("SELECT value FROM metadata WHERE key = 'sequence'").get() as { value: string }).value);
  const blocksBefore = legacy.query("SELECT id, text, revision, created_at, updated_at FROM blocks ORDER BY id").all();
  legacy.close();
  running = await service(directory, database);
  expect(running.store.sequence).toBe(legacySequence);
  expect(running.store.changes.floor).toBe(legacySequence);
  expect(await running.client.request<ChangeFeedPage>({ action: "changes.since", sequence: 0 }))
    .toMatchObject({ kind: "reset", reason: "history-unavailable", oldestSequence: legacySequence });
  expect(running.store.database.query("SELECT id, text, revision, created_at, updated_at FROM blocks ORDER BY id").all())
    .toEqual(blocksBefore);
  const upgraded = await running.client.request<Block>({ action: "create", text: "First change after upgrade" });
  await running.stop();
  running = await service(directory, database);
  expect(await readAll(running.client, legacySequence, 10)).toMatchObject([{ blockId: upgraded.id }]);
});

test("branch-local rank changes join the feed without changing their view event", async () => {
  const { client } = await service(workspace("pi-outliner-change-ranks-"));
  const view = await client.request<Block>({ action: "create", text: "Fictional lane [type::virtual-branch] [query::lane=next]" });
  const a = await client.request<Block>({ action: "create", text: "Alpha [lane::next]" });
  const b = await client.request<Block>({ action: "create", text: "Beta [lane::next]" });
  const { events } = await watch(client, "rank-observer");
  await client.request({ action: "virtual.occurrences.reorder", viewId: view.id, orderedBlockIds: [b.id, a.id] });
  await until(() => events.length > 0);
  expect(events[0]).toMatchObject({
    domain: "view", action: "virtual.occurrences.reorder", blockId: view.id,
    change: { kind: "reorder", blockId: view.id },
  });
  const page = await client.request<ChangeFeedPage>({ action: "changes.since", sequence: events[0]!.sequence - 1 });
  expect(page).toMatchObject({ kind: "changes", changes: [{ kind: "reorder", blockId: view.id }] });
});
