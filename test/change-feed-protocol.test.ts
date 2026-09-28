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

test("history survives restarts and crashes; unrecorded writes and rebuilds reset it", async () => {
  const directory = workspace("pi-outliner-change-restart-");
  const database = join(directory, "outliner.sqlite");
  let running = await service(directory, database);
  const start = running.store.sequence;
  const note = await running.client.request<Block>({ action: "create", text: "Survives restart" });
  await running.stop();

  running = await service(directory, database);
  expect(await readAll(running.client, start, 10)).toMatchObject([{ kind: "create", blockId: note.id }]);
  // The feed row commits with the change, so a crash cannot lose it.
  const beforeCrash = running.store.sequence;
  const crashed = await running.client.request<Block>({ action: "create", text: "Written before a crash" });
  await running.crash();

  running = await service(directory, database);
  expect(await readAll(running.client, beforeCrash, 10)).toMatchObject([{ kind: "create", blockId: crashed.id }]);
  const offlineStart = running.store.sequence;
  await running.stop();

  // Another process running this code records its writes too.
  const offline = new OutlinerStore(database);
  const maintained = offline.create("Written by a maintenance script");
  offline.close();
  running = await service(directory, database);
  expect(await readAll(running.client, offlineStart, 10)).toMatchObject([
    { kind: "create", blockId: maintained.id, action: "background" },
  ]);
  const beforeRaw = running.store.sequence;
  await running.stop();

  // A writer without the feed (an older build, raw SQL) leaves a sequence with no row.
  const raw = new Database(database);
  raw.exec(`
    UPDATE metadata SET value = CAST(value AS INTEGER) + 1 WHERE key = 'sequence';
    UPDATE blocks SET text = 'Edited without the feed' WHERE id = '${maintained.id}';
  `);
  raw.close();
  running = await service(directory, database);
  const rawSequence = running.store.sequence;
  expect(rawSequence).toBe(beforeRaw + 1);
  expect(await running.client.request<ChangeFeedPage>({ action: "changes.since", sequence: beforeRaw }))
    .toMatchObject({ kind: "reset", reason: "history-unavailable", oldestSequence: rawSequence });
  const later = await running.client.request<Block>({ action: "create", text: "Recorded after the gap" });
  expect(await readAll(running.client, rawSequence, 10)).toMatchObject([{ blockId: later.id }]);
  await running.stop();

  // A property-index rebuild advances the sequence for every block at once.
  const rebuild = new Database(database);
  rebuild.exec("UPDATE metadata SET value = '0' WHERE key = 'property_parser_version'");
  rebuild.close();
  running = await service(directory, database);
  const rebuilt = running.store.sequence;
  expect(rebuilt).toBe(rawSequence + 2);
  expect(await running.client.request<ChangeFeedPage>({ action: "changes.since", sequence: rawSequence }))
    .toMatchObject({ kind: "reset", reason: "history-unavailable", oldestSequence: rebuilt });
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

/** Every sequence after `from` has a feed row (visible, or a hidden sequence-only row). */
function uncoveredSequences(store: OutlinerStore, from: number): number[] {
  const recorded = new Set((store.database.query(
    "SELECT DISTINCT sequence FROM change_feed WHERE sequence > ?",
  ).all(from) as Array<{ sequence: number }>).map(row => row.sequence));
  const missing: number[] = [];
  for (let sequence = from + 1; sequence <= store.sequence; sequence += 1) {
    if (!recorded.has(sequence)) missing.push(sequence);
  }
  return missing;
}

test("every content mutation family is covered by the feed and matches its live events", async () => {
  const { client, store } = await service(workspace("pi-outliner-change-coverage-"));
  const { events } = await watch(client, "coverage-observer");
  const start = store.sequence;
  const expected: Array<{ action: string; from: number; to: number; blockIds: string[] }> = [];
  async function step<T>(action: string, run: () => Promise<T>, blockIds: (result: T) => string[]): Promise<T> {
    const from = store.sequence;
    const result = await run();
    const to = store.sequence;
    expect(to).toBeGreaterThan(from);
    expected.push({ action, from, to, blockIds: blockIds(result) });
    return result;
  }
  const request = <T>(input: Record<string, unknown>) => client.request<T>(input as never);
  const id = (block: Block) => [block.id];

  const project = await step("create", () => request<Block>({ action: "create", text: "Fictional project" }), id);
  const archive = await step("create", () => request<Block>({ action: "create", text: "Fictional archive" }), id);
  let task = await step("create", () => request<Block>({
    action: "create", parentId: project.id, text: "Draft the launch plan\n\n- [ ] Review ^review",
  }), id);
  task = await step("update", () => request<Block>({
    action: "update", blockId: task.id, text: "Draft the launch plan [status::ready]\n\n- [ ] Review ^review",
    expectedRevision: task.revision, mutation: { author: "user" },
  }), id);
  task = await step("properties.patch", () => request<Block>({
    action: "properties.patch", blockId: task.id, expectedRevision: task.revision,
    operations: [{ op: "append", key: "owner", value: "crew" }], mutation: { author: "user" },
  }), id);
  const checklist = await request<{ items: Array<{ evidence: string }> }>({
    action: "checklist.query", blockId: task.id, query: { limit: 10 },
  });
  await step("checklist.update", () => request({
    action: "checklist.update", blockId: task.id,
    input: { target: { itemId: "review" }, expectedEvidence: checklist.items[0]!.evidence, change: { kind: "status", status: "done" } },
    mutation: { author: "agent", actorId: "checklist-bot" },
  }), () => [task.id]);
  task = store.require(task.id);
  await step("move", () => request({ action: "move", blockId: task.id, parentId: archive.id }), () => [task.id]);
  const scratch = await step("create", () => request<Block>({ action: "create", text: "Scratch note" }), id);
  await step("delete", () => request({ action: "delete", blockId: scratch.id }), () => [scratch.id]);
  await step("trash.restore", () => request({ action: "trash.restore", blockId: scratch.id }), () => [scratch.id]);
  await step("delete", () => request({ action: "delete", blockId: scratch.id }), () => [scratch.id]);
  await step("trash.purge", () => request({
    action: "trash.purge", blockId: scratch.id, confirmation: scratch.id.slice(0, 8),
  }), () => [scratch.id]);

  const comment = await step("annotations.create", () => request<{ annotations: Array<{ block: Block }> }>({
    action: "annotations.batch", requestId: "coverage-comment",
    operations: [{ operationId: "one", type: "block-comment", input: {
      blockId: task.id, expectedRevision: store.require(task.id).revision, body: "Check the dates", source: "user",
    } }],
  }), receipt => receipt.annotations.map(record => record.block.id));
  const rootId = comment.annotations[0]!.block.id;
  await step("annotations.reply", () => request<{ annotations: Array<{ block: Block }> }>({
    action: "annotations.reply", requestId: "coverage-reply",
    input: { annotationId: rootId, body: "Dates confirmed", source: "user" },
  }), receipt => receipt.annotations.map(record => record.block.id));
  await step("annotations.lifecycle", () => request({
    action: "annotations.lifecycle", input: { annotationId: rootId, lifecycle: "resolved" }, mutation: { author: "user" },
  }), () => [rootId]);

  const page = await step("pages.follow", () => request<{ block: Block }>({ action: "pages.follow", address: "Launch Page" }),
    result => [result.block.id]);
  const renamed = await step("pages.rename", () => request({
    action: "pages.rename", blockId: page.block.id, address: "Renamed Launch Page", expectedRevision: page.block.revision,
  }), () => [page.block.id]);
  void renamed;
  await step("pages.alias", () => request({ action: "pages.alias", blockId: page.block.id, address: "Launch Alias" }),
    () => [page.block.id]);
  await step("pages.remove", () => request({
    action: "pages.remove", blockId: page.block.id, address: "Launch Alias",
    expectedRevision: store.require(page.block.id).revision,
  }), () => [page.block.id]);

  await step("work-ids.configure", () => request({ action: "work-ids.configure", prefix: "FIC" }), () => []);
  await step("work-ids.allocate", () => request({
    action: "work-ids.allocate", blockId: project.id, expectedRevision: store.require(project.id).revision,
  }), () => [project.id]);
  await request<Block>({ action: "create", text: "Fictional work [type::work-queue] [project::orbit]" });
  const roadmap = await step("roadmap.items.create", () => request<{ block: Block; workId: string }>({
    action: "roadmap.items.create",
    input: { title: "Chart the orbit", priority: "high", project: "orbit", arc: "launch", tracks: ["safety"] },
  }), result => [result.block.id]);
  const delivery = await step("deliveries.ensure", () => request<{ delivery: Block; task: Block }>({
    action: "deliveries.ensure", input: {
      taskBlockId: roadmap.block.id, deliveryKey: `${roadmap.workId}/launch`, repository: "example/orbit",
      baseBranch: "main", workBranch: "feature/launch",
    },
  }), result => [result.delivery.id]);
  await step("deliveries.sync", () => request({
    action: "deliveries.sync", mutation: { author: "agent", actorId: "delivery-bot" }, input: {
      taskBlockId: roadmap.block.id, deliveryBlockId: delivery.delivery.id,
      expectedDeliveryRevision: delivery.delivery.revision, expectedTaskRevision: store.require(roadmap.block.id).revision,
      pullRequest: { number: 7, url: "https://github.com/example/orbit/pull/7", state: "OPEN", mergeCommit: null },
    },
  }), () => [roadmap.block.id]);

  const captured = await step("capture.create", () => request<{ block: Block }>({
    action: "capture.create", requestId: "coverage-capture", text: "Captured idea", source: "cli",
  }), result => [result.block.id]);
  await step("bookmarks.toggle", () => request<{ record: Block }>({
    action: "bookmarks.toggle", targetBlockId: captured.block.id, expectedRecordId: null,
  }), result => [result.record.id]);

  const base = store.require(archive.id);
  const recovery = await request<{ id: string; revision: number }>({ action: "edit-recovery.start", input: {
    id: crypto.randomUUID(), blockId: base.id, baseText: base.text, baseRevision: base.revision,
    prelaunchText: base.text, draftText: `${base.text} revised`, source: "external-editor",
  } });
  await step("edit-recovery.commit", () => request({
    action: "edit-recovery.commit", recoveryId: recovery.id, expectedRevision: recovery.revision,
    text: `${base.text} revised`, basedOnRevision: base.revision, mutation: { author: "user" },
  }), () => [base.id]);

  const lane = await request<Block>({ action: "create", text: "Fictional lane [type::virtual-branch] [query::lane=next]" });
  const alpha = await request<Block>({ action: "create", text: "Alpha [lane::next]" });
  const beta = await request<Block>({ action: "create", text: "Beta [lane::next]" });
  await step("virtual.occurrences.reorder", () => request({
    action: "virtual.occurrences.reorder", viewId: lane.id, orderedBlockIds: [beta.id, alpha.id],
  }), () => [lane.id]);

  // Contiguous: no committed sequence lacks a row, and the page is complete, not a reset.
  expect(uncoveredSequences(store, start)).toEqual([]);
  const feed = await readAll(client, start, 1000);
  for (const entry of expected) {
    const inRange = feed.filter(change => change.sequence > entry.from && change.sequence <= entry.to);
    expect({ action: entry.action, actions: [...new Set(inRange.map(change => change.action))] })
      .toEqual({ action: entry.action, actions: [entry.action === "annotations.create" ? "annotations.batch" : entry.action] });
    const blockIds = new Set(inRange.map(change => change.blockId));
    for (const blockId of entry.blockIds) expect({ action: entry.action, has: blockIds.has(blockId) }).toEqual({ action: entry.action, has: true });
  }
  // The feed is exactly what live subscribers received.
  await until(() => events.filter(event => event.change).length === feed.length);
  expect(events.filter(event => event.change).map(event => event.change)).toEqual(feed);
  for (const event of events.filter(event => event.change)) {
    expect(event.sequence).toBe(event.change!.sequence);
    if (event.change!.blockId) expect(event.blockId).toBe(event.change!.blockId);
  }
});

test("annotations.batch records and publishes one change per affected block", async () => {
  const { client, store } = await service(workspace("pi-outliner-change-batch-"));
  const first = await client.request<Block>({ action: "create", text: "First source" });
  const second = await client.request<Block>({ action: "create", text: "Second source" });
  const root = await client.request<{ annotations: Array<{ block: Block }> }>({
    action: "annotations.batch", requestId: "batch-root", operations: [{ operationId: "root", type: "block-comment",
      input: { blockId: first.id, expectedRevision: first.revision, body: "Earlier thread", source: "user" } }],
  });
  const { events } = await watch(client, "batch-observer");
  const start = store.sequence;
  const receipt = await client.request<{ annotations: Array<{ block: Block }> }>({
    action: "annotations.batch", requestId: "batch-many", operations: [
      { operationId: "a", type: "block-comment", input: { blockId: first.id, expectedRevision: first.revision, body: "On the first", source: "user" } },
      { operationId: "b", type: "block-comment", input: { blockId: second.id, expectedRevision: second.revision, body: "On the second", source: "agent" } },
      { operationId: "c", type: "reply", input: { annotationId: root.annotations[0]!.block.id, body: "A reply", source: "user" } },
    ], author: "agent", provenance: { actorId: "review-bot" },
  });
  const created = receipt.annotations.map(record => record.block);
  expect(created).toHaveLength(3);
  const feed = await readAll(client, start, 100);
  expect(feed.map(change => [change.action, change.kind, change.blockId, change.parentId])).toEqual([
    ["annotations.batch", "annotate", created[0]!.id, first.id],
    ["annotations.batch", "annotate", created[1]!.id, second.id],
    ["annotations.batch", "annotate", created[2]!.id, root.annotations[0]!.block.id],
  ]);
  expect(feed.every(change => change.actor?.actorId === "review-bot")).toBe(true);
  await until(() => events.length === 3);
  expect(events.map(event => [event.domain, event.action, event.blockId])).toEqual(
    created.map(block => ["content", "annotations.batch", block.id]),
  );
  expect(events.map(event => event.change)).toEqual(feed);
});

test("a failure while recording rolls the change back, and a failure after commit keeps it in the feed", async () => {
  const { client, store, server } = await service(workspace("pi-outliner-change-failure-"));
  const { events } = await watch(client, "failure-observer");
  const before = store.sequence;

  // The recording step fails inside the mutation's transaction: nothing commits.
  const record = store.changes.record.bind(store.changes);
  store.changes.record = () => { throw new Error("injected feed failure"); };
  await expect(client.request({ action: "create", text: "Never committed" })).rejects.toThrow("injected feed failure");
  store.changes.record = record;
  expect(store.sequence).toBe(before);
  expect(store.database.query("SELECT COUNT(*) AS count FROM blocks WHERE text = 'Never committed'").get())
    .toEqual({ count: 0 });
  expect(await client.request<ChangeFeedPage>({ action: "changes.since", sequence: before }))
    .toMatchObject({ kind: "changes", changes: [], completeness: { kind: "complete" } });

  // Publishing fails after the commit: the live event is lost, the feed still has the change.
  const internals = server as unknown as { eventFor(...args: unknown[]): unknown };
  const eventFor = internals.eventFor;
  internals.eventFor = () => { throw new Error("injected publish failure"); };
  const committed = await client.request<Block>({ action: "create", text: "Committed before the failure" });
  internals.eventFor = eventFor;
  expect(await readAll(client, before, 10)).toMatchObject([{ action: "create", kind: "create", blockId: committed.id }]);
  expect(events.some(event => event.blockId === committed.id)).toBe(false);

  // A request that commits one transaction and then fails still publishes what it committed.
  const handler = server as unknown as { handleAsync(...args: unknown[]): Promise<unknown> };
  const handleAsync = handler.handleAsync;
  let partial: Block | undefined;
  handler.handleAsync = async () => {
    partial = store.create("First step of a failing request");
    throw new Error("injected second-step failure");
  };
  const afterPublishFailure = store.sequence;
  await expect(client.request({ action: "create", text: "ignored" })).rejects.toThrow("injected second-step failure");
  handler.handleAsync = handleAsync;
  expect(await readAll(client, afterPublishFailure, 10)).toMatchObject([{ action: "create", blockId: partial!.id }]);
  await until(() => events.some(event => event.blockId === partial!.id));
  expect(events.find(event => event.blockId === partial!.id)).toMatchObject({ domain: "content", action: "create" });
  expect(uncoveredSequences(store, before)).toEqual([]);
});

test("writes outside a request are recorded and published as background changes", async () => {
  const { client, store } = await service(workspace("pi-outliner-change-background-"));
  const { events } = await watch(client, "background-observer");
  const before = store.sequence;
  const written = store.create("Written by an in-process job");
  await until(() => events.some(event => event.blockId === written.id));
  const feed = await readAll(client, before, 10);
  expect(feed).toMatchObject([{ action: "background", kind: "create", blockId: written.id }]);
  expect(events.find(event => event.blockId === written.id)).toMatchObject({
    domain: "content", action: "background", change: feed[0],
  });

  // Resource bookkeeping advances the sequence without an outline change: hidden, but covered.
  const resourceStart = store.sequence;
  await client.request({ action: "resources.retention.configure", input: {
    retainNewestSourceSnapshots: 1, retainNewestRepresentationsPerAdapter: 1, minimumAgeMs: 0, purgeGraceMs: 0,
  } });
  expect(store.sequence).toBe(resourceStart + 1);
  expect(uncoveredSequences(store, before)).toEqual([]);
  const page = await client.request<ChangeFeedPage>({ action: "changes.since", sequence: resourceStart });
  expect(page).toMatchObject({ kind: "changes", changes: [], completeness: { kind: "complete" } });
});
