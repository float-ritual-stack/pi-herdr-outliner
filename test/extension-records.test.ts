// Wave A of the extension design: a Jira ticket in one step, kept as real
// blocks "as if the person had copied it in". These tests run the repo's Jira
// extension (contract 2 folder) against a loopback fake Jira (test/fake-jira.ts)
// through a real service. Every ticket, person and site is made up.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutlinerClient } from "../src/client";
import { OutlinerServer } from "../src/server";
import { OutlinerStore } from "../src/store";
import { Publisher } from "../src/publish";
import { parsePropertyRecords } from "../src/properties";
import { createBlockComment } from "../src/block-comments";
import { readSavedView } from "../src/saved-view-read";
import type { ResourceProjectionReadResult } from "../src/resource-projection";
import type { BacklinkCollection, Block, ChangeFeedPage, OutlinerServiceStatus, PageAddressResolution } from "../src/types";
import { FAKE_TOKEN, installJira, startFakeJira, type FakeIssue } from "./fake-jira";

const TOKEN_ENV = "OUTLINER_FAKE_JIRA_TOKEN_WAVE_A";
const PERSON = { author: "user" as const };
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const recent = () => new Date(Date.now() - 60_000).toISOString();
const longAgo = "2026-01-05T09:00:00.000Z";

function issues(): FakeIssue[] {
  return [
    {
      id: "20001", key: "PC-1", summary: "Rollout checklist for the depot switch",
      description: "Steps for the switch.\n\nBlocked by PC-2 until the printer is fixed.",
      status: "In Review", assignee: "Dana Ortiz", reporter: "Lee Park", type: "Task", priority: "High",
      labels: ["rollout", "depot"], sprint: "R2-S4", updated: longAgo,
      comments: [
        { id: "501", author: "Lee Park", created: "2026-01-02T10:00:00.000Z", body: "First pass looks fine." },
        { id: "502", author: "Dana Ortiz", created: "2026-01-03T11:30:00.000Z", body: "Waiting on the printer." },
      ],
    },
    {
      id: "20002", key: "PC-2", summary: "Label printer drops the last line",
      description: "Seen on the second shift.", status: "To Do", assignee: "Lee Park", type: "Bug", priority: "Medium",
      updated: longAgo,
    },
  ];
}

async function setup(options: { extraSources?: { origin: string; project: string }[] } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "outliner-ext-records-")));
  const fake = startFakeJira(issues());
  const previous = {
    dir: process.env.OUTLINER_EXTENSIONS_DIR,
    registry: process.env.OUTLINER_RESOURCE_EXTENSIONS,
    token: process.env[TOKEN_ENV],
  };
  process.env.OUTLINER_EXTENSIONS_DIR = join(root, "extensions");
  process.env.OUTLINER_RESOURCE_EXTENSIONS = join(root, "no-legacy-registry.json");
  process.env[TOKEN_ENV] = FAKE_TOKEN;
  const installed = await installJira(join(root, "extensions"), fake.origin, TOKEN_ENV);
  if (options.extraSources) {
    const config = JSON.parse(readFileSync(join(installed, "config.json"), "utf8"));
    config.sources = [...options.extraSources, ...config.sources];
    writeFileSync(join(installed, "config.json"), JSON.stringify(config));
  }
  const store = new OutlinerStore(join(root, "outliner.sqlite"), { workspaceRoot: root });
  const socket = join(root, "outliner.sock");
  const server = new OutlinerServer(store, socket, undefined, undefined, { extensionPollMs: 0 });
  await server.start();
  const client = new OutlinerClient(socket);
  cleanups.push(async () => {
    await server.close();
    store.close();
    fake.stop();
    for (const [key, value] of [["OUTLINER_EXTENSIONS_DIR", previous.dir], ["OUTLINER_RESOURCE_EXTENSIONS", previous.registry], [TOKEN_ENV, previous.token]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const create = (text: string, parentId?: string) =>
    client.request<Block>({ action: "create", text, ...(parentId ? { parentId } : {}) });
  const until = async (what: string, ready: () => boolean, ms = 10_000) => {
    const end = Date.now() + ms;
    while (!ready()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await Bun.sleep(20);
    }
  };
  /** The one active record block for a key, wherever it sits. */
  const recordsFor = (key: string) => store.extensionRecords({ extensionId: "jira", role: "record", itemKey: key });
  const recordOf = async (pageId: string) => {
    const end = Date.now() + 10_000;
    for (;;) {
      const row = store.extensionRecords({ parentBlockId: pageId, role: "record" })[0];
      if (row) return store.get(row.blockId)!;
      if (Date.now() > end) throw new Error("no record block appeared");
      await Bun.sleep(20);
    }
  };
  const commentsOf = (recordId: string) =>
    store.extensionRecords({ parentBlockId: recordId, role: "comment" }).map((row) => store.get(row.blockId)!);
  const visibleChangesSince = (sequence: number) =>
    (store.changes.since(sequence, 1000) as Extract<ChangeFeedPage, { kind: "changes" }>).changes;
  const edit = async (blockId: string, change: (text: string) => string) => {
    const current = store.get(blockId)!;
    return client.request<Block>({ action: "update", blockId, text: change(current.text), expectedRevision: current.revision, mutation: PERSON });
  };
  return { root, fake, store, server, client, create, edit, until, recordsFor, recordOf, commentsOf, visibleChangesSince };
}

test("saving a ticket page fetches the ticket in the background, as a real child block the extension owns", async () => {
  const { fake, store, client, create, recordOf, visibleChangesSince } = await setup();
  const status = await client.request<OutlinerServiceStatus>({ action: "ping" });
  expect(status.capabilities).toEqual(expect.arrayContaining([
    "extensions.records", "resources.projection.materialize", "resources.projection.refresh",
    "resources.observer-reads", "resources.follow-authored.provenance", "blocks.authored-links", "activity.extensions",
  ]));

  fake.delayMs = 400;
  const before = store.sequence;
  const started = performance.now();
  const page = await create("PC-1 Rollout [jira::PC-1]\nMy own notes: call the depot first.");
  // The save answered before the fetch could have.
  expect(performance.now() - started).toBeLessThan(350);
  fake.delayMs = 0;

  const record = await recordOf(page.id);
  expect(record.parentId).toBe(page.id);
  expect(record.author).toBe("agent");
  expect(record.actorId).toBe("ext:jira");
  expect(record.text.split("\n")[0]).toBe("Rollout checklist for the depot switch");
  expect(record.properties).toEqual(expect.arrayContaining([
    { key: "jira.key", value: "PC-1" },
    { key: "jira.status", value: "In Review" },
    { key: "jira.assignee", value: "Dana Ortiz" },
    { key: "jira.sprint", value: "R2-S4" },
    { key: "jira.priority", value: "High" },
    { key: "jira.label", value: "rollout" },
    { key: "jira.label", value: "depot" },
    { key: "jira.updated", value: longAgo },
  ]));
  expect(record.text).toContain("Steps for the switch.");
  // The person's page is untouched: their notes stay theirs.
  expect(store.get(page.id)!.text).toBe(page.text);
  // No --comments: no comment blocks.
  expect(store.extensionRecords({ parentBlockId: record.id, role: "comment" })).toEqual([]);

  const extensionChanges = visibleChangesSince(before).filter((change) => change.blockId === record.id);
  expect(extensionChanges.length).toBeGreaterThan(0);
  for (const change of extensionChanges) expect(change.actor).toMatchObject({ author: "agent", actorId: "ext:jira" });

  const projection = await client.request<ResourceProjectionReadResult>({ action: "resources.projection.read", blockId: page.id });
  expect(projection.projections[0]).toMatchObject({ key: "PC-1", status: "ready", record: { blockId: record.id, pageBlockId: page.id } });
  const links = await client.request<{ resources: { entries: { recordBlockId?: string }[] } }>({ action: "blocks.authored-links", ownerBlockId: page.id });
  expect(links.resources.entries[0]?.recordBlockId).toBe(record.id);
  const own = await client.request<ResourceProjectionReadResult>({ action: "resources.projection.read", blockId: record.id });
  expect(own.projections[0]).toMatchObject({ key: "PC-1", anchor: { kind: "record" }, record: { blockId: record.id } });
});

test("removing the jira:: line moves its ticket block to Trash; the person's notes stay", async () => {
  const { store, client, create, recordOf } = await setup();
  const meeting = await create("Vendor call about PC-1\njira::\nNotes from the call.");
  const record = await recordOf(meeting.id);
  const current = store.get(meeting.id)!;
  await client.request({ action: "update", blockId: meeting.id, text: "Vendor call about PC-1\nNotes from the call.", expectedRevision: current.revision, mutation: PERSON });
  const end = Date.now() + 5000;
  while (!store.get(record.id)!.deletedAt && Date.now() < end) await Bun.sleep(20);
  expect(store.get(record.id)!.deletedAt).toBeTruthy();
  expect(store.get(meeting.id)!.text).toContain("Notes from the call.");
});

test("a jira:: line under a key fetches that ticket with its latest comments as child blocks", async () => {
  const { create, recordOf, commentsOf } = await setup();
  const meeting = await create("Vendor call\nPC-1 came up again\n- jira:: --comments");
  const record = await recordOf(meeting.id);
  expect(record.properties).toContainEqual({ key: "jira.key", value: "PC-1" });
  const end = Date.now() + 5000;
  while (commentsOf(record.id).length < 2 && Date.now() < end) await Bun.sleep(20);
  const comments = commentsOf(record.id);
  expect(comments.map((comment) => comment.text.split("\n")[0])).toEqual([
    "Lee Park · 2026-01-02 10:00",
    "Dana Ortiz · 2026-01-03 11:30",
  ]);
  expect(comments[1]!.properties).toEqual(expect.arrayContaining([
    { key: "jira.comment", value: "502" }, { key: "jira.author", value: "Dana Ortiz" },
  ]));
  expect(comments.every((comment) => comment.actorId === "ext:jira")).toBe(true);
});

test("jira.* properties are queryable in a view beside hand-written ones, and a child: view shows drift", async () => {
  const { store, client, create, recordOf } = await setup();
  const page = await create("PC-1 Rollout [jira::PC-1] [status::done]");
  const record = await recordOf(page.id);
  const handwritten = await create("Copied by hand last week [jira.status::In Review]");

  const inReview = await create('In review in Jira [type::virtual-branch] [query::jira.status="In Review"]');
  expect((await readSavedView(client, inReview.id)).blocks.map((block) => block.id).sort())
    .toEqual([record.id, handwritten.id].sort());

  // Drift: the person says done, Jira doesn't. `child:` compares a page with the record under it.
  const drift = await create('Done here, not in Jira [type::virtual-branch] [query::status=done child:jira.status NOT child:jira.status=Done]');
  expect((await readSavedView(client, drift.id)).blocks.map((block) => block.id)).toEqual([page.id]);
  const reverse = await create('Done in Jira, not here [type::virtual-branch] [query::child:jira.status=Done NOT status=done]');
  expect((await readSavedView(client, reverse.id)).blocks).toEqual([]);
  expect(store.get(page.id)!.properties).toContainEqual({ key: "status", value: "done" });
});

test("a ticket key in ticket text is a soft link: it resolves to its ticket page and shows in that page's backlinks", async () => {
  const { client, create, recordOf } = await setup();
  const printer = await create("PC-2 Printer [jira::PC-2]");
  const rollout = await create("PC-1 Rollout [jira::PC-1]");
  const record = await recordOf(rollout.id);
  expect(record.text).toContain("Blocked by PC-2");

  const resolved = await client.request<PageAddressResolution>({ action: "pages.resolve", address: "PC-2" });
  expect(resolved).toMatchObject({ status: "resolved", block: { id: printer.id } });
  const backlinks = await client.request<BacklinkCollection>({ action: "references.backlinks", query: { targetBlockId: printer.id, limit: 50 } });
  expect(backlinks.sources.map((source) => source.blockId)).toContain(record.id);
});

test("the ticket's fields and body belong to Jira: a person's or agent's write is refused, and their own [status::] stays theirs", async () => {
  const { store, client, create, recordOf } = await setup();
  const page = await create("PC-1 Rollout [jira::PC-1] [status::doing]");
  const record = await recordOf(page.id);

  const statusEdit = record.text.replace("[jira.status::In Review]", "[jira.status::Done]");
  await expect(client.request({ action: "update", blockId: record.id, text: statusEdit, expectedRevision: record.revision, mutation: PERSON }))
    .rejects.toThrow("jira.status comes from Jira");
  const ordinal = record.properties.findIndex((property) => property.key === "jira.status");
  await expect(client.request({
    action: "properties.patch", blockId: record.id, expectedRevision: record.revision,
    operations: [{ op: "replace", ordinal: parsePropertyRecords(record.text).find((token) => token.key === "jira.status")!.ordinal, value: "Done" }],
    mutation: { author: "agent", actorId: "helper-agent" },
  })).rejects.toThrow("jira.status comes from Jira");
  expect(ordinal).toBeGreaterThanOrEqual(0);
  await expect(client.request({ action: "update", blockId: record.id, text: `${record.text}\nmy note`, expectedRevision: record.revision, mutation: PERSON }))
    .rejects.toThrow("write your own notes on the parent block");
  // Adding the person's own status to the ticket block is refused too: it goes on the page.
  await expect(client.request({ action: "update", blockId: record.id, text: `${record.text} [status::done]`, expectedRevision: record.revision, mutation: PERSON }))
    .rejects.toThrow("comes from Jira");
  expect(store.get(record.id)!.revision).toBe(record.revision);

  // The page is the person's: their status changes freely and a refresh leaves it alone.
  const current = store.get(page.id)!;
  await client.request({ action: "update", blockId: page.id, text: current.text.replace("[status::doing]", "[status::review]"), expectedRevision: current.revision, mutation: PERSON });
  await client.request({ action: "resources.projection.refresh", blockId: page.id });
  expect(store.get(page.id)!.properties).toContainEqual({ key: "status", value: "review" });
  expect(store.get(record.id)!.properties).toContainEqual({ key: "jira.status", value: "In Review" });
});

test("the poll applies a changed ticket; a poll or refresh that finds nothing new writes nothing", async () => {
  const { fake, store, server, client, create, recordOf, visibleChangesSince } = await setup();
  const page = await create("PC-1 Rollout [jira::PC-1]");
  const record = await recordOf(page.id);

  // Nothing changed at Jira: no change events at all.
  let before = store.sequence;
  expect(await server.extensionSync.poll()).toEqual({ checked: 1, changed: 0 });
  expect(visibleChangesSince(before)).toEqual([]);
  before = store.sequence;
  await client.request({ action: "resources.projection.refresh", blockId: page.id });
  expect(visibleChangesSince(before)).toEqual([]);
  expect(fake.requests.some((request) => request.startsWith("JQL key in (PC-1) AND updated >= -"))).toBe(true);

  const issue = fake.issues.get("PC-1")!;
  issue.status = "Done";
  issue.updated = recent();
  before = store.sequence;
  expect(await server.extensionSync.poll()).toEqual({ checked: 1, changed: 1 });
  expect(store.get(record.id)!.properties).toContainEqual({ key: "jira.status", value: "Done" });
  const changes = visibleChangesSince(before);
  expect(changes.map((change) => change.blockId)).toEqual([record.id]);
  expect(changes[0]!.actor).toMatchObject({ author: "agent", actorId: "ext:jira" });

  // "What changed" surfaces can leave the extension's writes out.
  const people = await client.request<{ entries: { block: Block }[] }>({ action: "activity.recent", author: "agent", extensions: "exclude", limit: 50 });
  expect(people.entries.map((entry) => entry.block.id)).not.toContain(record.id);
  const extensions = await client.request<{ entries: { block: Block }[] }>({ action: "activity.recent", author: "agent", extensions: "only", limit: 50 });
  expect(extensions.entries.map((entry) => entry.block.id)).toContain(record.id);
});

test("a comment on ticket text follows the text when Jira edits it, and says when it lost its place", async () => {
  const { fake, store, client, create, recordOf } = await setup();
  const page = await create("PC-1 Rollout [jira::PC-1]");
  const record = await recordOf(page.id);
  await createBlockComment(client, {
    requestId: "wave-a-comment",
    input: { blockId: record.id, expectedRevision: record.revision, body: "Check with the depot", source: "user",
      passage: { quote: "until the printer is fixed" } },
  });
  const thread = () => store.listAnnotationThreads({ subject: { kind: "block", blockId: record.id }, includeResolved: true })[0]!;
  const startBefore = (thread().resolvedTarget!.anchor as { start: number }).start;

  const issue = fake.issues.get("PC-1")!;
  issue.description = `Context first.\n\n${issue.description}`;
  issue.updated = recent();
  await client.request({ action: "resources.projection.refresh", blockId: page.id });
  expect(store.get(record.id)!.text).toContain("Context first.");
  expect(thread().currentResolution.status).toBe("resolved");
  expect((thread().resolvedTarget!.anchor as { start: number }).start).toBeGreaterThan(startBefore);

  issue.description = "Steps for the switch.";
  issue.updated = new Date().toISOString();
  await client.request({ action: "resources.projection.refresh", blockId: page.id });
  expect(thread().currentResolution.status).not.toBe("resolved");
  expect(thread().resolvedTarget).toBeNull();
});

test("the publisher leaves ticket blocks off a published page unless the page opts in with [publish.ext::jira]", async () => {
  const { store, client, create, recordOf } = await setup();
  const page = await create("Depot rollout PC-1 [jira::PC-1] [publish::true] [page::Depot rollout]\nOur plan for the switch.");
  const record = await recordOf(page.id);
  const host = await create(`Weekly summary [publish::true] [page::Weekly summary]\n!((${record.id}))`);
  // An embed in a child of the page: the page's opt-in covers it.
  await create(`Quoted ticket\n!((${record.id}))`, page.id);
  const publisher = new Publisher({ client });
  cleanups.push(() => publisher.stop());
  await publisher.start();
  const get = async (path: string) => (await publisher.handle(new Request(`http://127.0.0.1${path}`))).text();

  const plain = await get("/p/depot-rollout");
  expect(plain).toContain("Our plan for the switch.");
  expect(plain).not.toContain("Rollout checklist for the depot switch");
  const embedded = await get("/p/weekly-summary");
  expect(embedded).not.toContain("Steps for the switch.");
  expect(embedded).toContain("jira data, not published");

  const current = store.get(page.id)!;
  await client.request({ action: "update", blockId: page.id, text: current.text.replace("[publish::true]", "[publish::true] [publish.ext::jira]"), expectedRevision: current.revision, mutation: PERSON });
  const hostNow = store.get(host.id)!;
  await client.request({ action: "update", blockId: host.id, text: hostNow.text.replace("[publish::true]", "[publish::true] [publish.ext::jira]"), expectedRevision: hostNow.revision, mutation: PERSON });
  await Bun.sleep(50);
  const opted = await get("/p/depot-rollout");
  expect(opted).toContain("Rollout checklist for the depot switch");
  expect(opted).not.toContain("jira data, not published");
  expect(await get("/p/weekly-summary")).toContain("Steps for the switch.");
});

test("a machine without Jira credentials says so and keeps working", async () => {
  const { client, store, create } = await setup();
  delete process.env[TOKEN_ENV];
  const page = await create("PC-1 Rollout [jira::PC-1]\nNotes still save.");
  expect(store.get(page.id)!.text).toContain("Notes still save.");
  let projection: ResourceProjectionReadResult | undefined;
  const end = Date.now() + 5000;
  do {
    await Bun.sleep(30);
    projection = await client.request<ResourceProjectionReadResult>({ action: "resources.projection.read", blockId: page.id });
  } while (!projection.projections[0]?.fetchError && Date.now() < end);
  expect(projection.projections[0]!.fetchError).toContain("no Jira credentials on this machine");
  expect(store.extensionRecords({ parentBlockId: page.id })).toEqual([]);
});

test("follow-authored records who registered, and describe/refresh work without a Detail client", async () => {
  const { client, create, recordOf } = await setup();
  // The first page creates the Source from the extension's config.
  await recordOf((await create("PC-1 Rollout [jira::PC-1]")).id);
  const receipt = await client.request<{ resource: { id: string }; provenance?: unknown }>({
    action: "resources.follow-authored", reference: { kind: "jira", key: "PC-2" },
    mutation: { author: "agent", actorId: "helper-agent" },
  });
  expect(receipt.provenance).toEqual({ author: "agent", actorId: "helper-agent" });
  await expect(client.request({ action: "resources.follow-authored", reference: { kind: "jira", key: "PC-2" }, mutation: { author: "agent" } }))
    .rejects.toThrow("requires actorId");

  const refreshed = await client.request<{ remoteEntity: { title: string } | null; capabilities: { refresh: { status: string } } }>({
    action: "resources.refresh", resourceId: receipt.resource.id,
  });
  expect(refreshed.remoteEntity?.title).toBe("Label printer drops the last line");
  const described = await client.request<{ remoteEntity: { title: string } | null; capabilities: { refresh: { status: string } } }>({
    action: "resources.describe", target: { kind: "resource", resourceId: receipt.resource.id },
  });
  expect(described.remoteEntity?.title).toBe("Label printer drops the last line");
  expect(typeof described.capabilities.refresh.status).toBe("string");
});

test("a fetch that failed (offline) is tried again on the next open, and one failing ticket doesn't hold up the poll", async () => {
  const { fake, store, server, client, create, recordOf } = await setup();
  const page = await create("PC-1 Rollout [jira::PC-1]");
  const record = await recordOf(page.id);
  const printer = await create("PC-2 Printer [jira::PC-2]");
  const other = await recordOf(printer.id);
  fake.status = 503;
  await client.request({ action: "resources.projection.refresh", blockId: page.id });
  fake.status = null;
  fake.issues.get("PC-1")!.status = "Blocked";
  fake.issues.get("PC-1")!.updated = new Date().toISOString();
  await client.request({ action: "resources.projection.read", blockId: page.id, materialize: true });
  const end = Date.now() + 5000;
  while (!store.get(record.id)!.properties.some((p) => p.value === "Blocked") && Date.now() < end) await Bun.sleep(20);
  expect(store.get(record.id)!.properties).toContainEqual({ key: "jira.status", value: "Blocked" });

  // PC-1 now fails to read (gone from Jira); PC-2 changed: the poll still applies PC-2.
  fake.issues.get("PC-1")!.updated = new Date().toISOString();
  const pc1 = fake.issues.get("PC-1")!;
  fake.issues.get("PC-2")!.status = "Done";
  fake.issues.get("PC-2")!.updated = new Date().toISOString();
  const originalId = pc1.id;
  pc1.id = "29999";
  await server.extensionSync.poll();
  pc1.id = originalId;
  expect(store.get(other.id)!.properties).toContainEqual({ key: "jira.status", value: "Done" });
});

test("one ticket, one block: every block that asks for a key shows the one record under the ticket page", async () => {
  const { store, client, create, until, recordsFor, recordOf, commentsOf } = await setup();
  const page = await create("PC-1 Rollout [jira::PC-1]\nOur plan.");
  const record = await recordOf(page.id);
  const standup = await create("Standup\nPC-1 slipped again\njira:: --comments=1");
  const review = await create("Review notes\njira:: PC-1");
  await client.request({ action: "resources.projection.read", blockId: standup.id, materialize: true });
  await client.request({ action: "resources.projection.read", blockId: review.id, materialize: true });
  // The standup asked for a comment: the one record gets it, and still there is one record.
  await until("the asked-for comment", () => commentsOf(record.id).length === 1);
  expect(recordsFor("PC-1").map((row) => row.blockId)).toEqual([record.id]);
  expect(store.children(standup.id)).toEqual([]);
  expect(store.children(review.id)).toEqual([]);
  expect(commentsOf(record.id)[0]!.text).toContain("Waiting on the printer.");

  // Each asker's projection names that block; so do its authored links.
  for (const asker of [page, standup, review]) {
    const read = await client.request<ResourceProjectionReadResult>({ action: "resources.projection.read", blockId: asker.id });
    expect(read.projections.find((projection) => projection.key === "PC-1")?.record?.blockId).toBe(record.id);
  }
  const links = await client.request<{ resources: { entries: { recordBlockId?: string }[] } }>({ action: "blocks.authored-links", ownerBlockId: review.id });
  expect(links.resources.entries[0]?.recordBlockId).toBe(record.id);

  // A query sees the ticket once, and a key its body names is one backlink, not one per asker.
  const inReview = await create('In review [type::virtual-branch] [query::jira.status="In Review"]');
  expect((await readSavedView(client, inReview.id)).blocks.map((block) => block.id)).toEqual([record.id]);
  const printer = await create("PC-2 Printer [jira::PC-2]");
  const backlinks = await client.request<BacklinkCollection>({ action: "references.backlinks", query: { targetBlockId: printer.id, limit: 50 } });
  expect(backlinks.sources.filter((source) => source.blockId === record.id)).toHaveLength(1);
}, 30_000);

test("the record moves to its home and keeps its identity; it goes to Trash only when nothing asks, and comes back the same block", async () => {
  const { store, client, create, edit, until, recordsFor, recordOf, visibleChangesSince } = await setup();
  const call = await create("Vendor call\njira:: PC-1\nNotes from the call.");
  const record = await recordOf(call.id);
  await createBlockComment(client, {
    requestId: "home-comment",
    input: { blockId: record.id, expectedRevision: record.revision, body: "Ask about the van", source: "user", passage: { quote: "Steps for the switch." } },
  });
  const threads = (blockId: string) => store.listAnnotationThreads({ subject: { kind: "block", blockId }, includeResolved: true });
  expect(threads(record.id)).toHaveLength(1);
  const highlight = (threads(record.id)[0] as unknown as { block: Block }).block.id;

  // A ticket page written later is the ticket's home: the same block moves there.
  const page = await create("PC-1 Rollout [jira::PC-1]");
  await until("the record under the page", () => store.get(record.id)!.parentId === page.id);
  expect(recordsFor("PC-1").map((row) => row.blockId)).toEqual([record.id]);
  expect(threads(record.id)).toHaveLength(1);

  // A page named for the key comes first of all (after the next refresh of the ticket).
  const named = await create("Depot switch [page::PC-1]\nThe page for PC-1.");
  await client.request({ action: "resources.projection.refresh", blockId: page.id });
  expect(store.get(record.id)!.parentId).toBe(named.id);

  // The call stops asking: the page still does, so nothing moves.
  await edit(call.id, (text) => text.replace("jira:: PC-1\n", ""));
  await Bun.sleep(200);
  expect(store.get(record.id)!.effectiveDeletedRootId).toBeFalsy();
  // The page stops asking too: nothing asks, so the record goes to Trash, said as the extension's drop.
  const before = store.sequence;
  await edit(page.id, (text) => text.replace(" [jira::PC-1]", ""));
  await until("the record in Trash", () => !!store.get(record.id)!.deletedAt);
  const dropped = visibleChangesSince(before).filter((change) => change.blockId === record.id);
  expect(dropped.map((change) => [change.action, change.kind])).toContainEqual(["ext.jira.drop-record", "delete"]);
  expect(dropped.every((change) => change.actor?.actorId === "ext:jira")).toBe(true);
  // The person's highlight is kept, in Trash with it (a thread lives under the block it is on).
  expect(store.get(highlight)).toMatchObject({ effectiveDeletedRootId: record.id });

  // Asking again brings the same block back, highlight and all.
  await create("Follow-up\njira:: PC-1");
  await until("the record restored", () => !store.get(record.id)!.effectiveDeletedRootId);
  expect(recordsFor("PC-1").map((row) => row.blockId)).toEqual([record.id]);
  expect(threads(record.id)).toHaveLength(1);
}, 30_000);

test("a comment that leaves the newest-N window goes to Trash with the person's highlight on it, restorable, and said", async () => {
  const { fake, store, client, create, until, recordOf, commentsOf, visibleChangesSince } = await setup();
  const page = await create("PC-1 Rollout [jira::PC-1]\njira:: --comments=2");
  const record = await recordOf(page.id);
  await until("two comments", () => commentsOf(record.id).length === 2);
  const oldest = commentsOf(record.id)[0]!;
  expect(oldest.text).toContain("First pass looks fine.");
  await createBlockComment(client, {
    requestId: "comment-on-comment",
    input: { blockId: oldest.id, expectedRevision: oldest.revision, body: "I disagree, see the depot notes", source: "user", passage: { quote: "First pass" } },
  });
  const highlight = (store.listAnnotationThreads({ subject: { kind: "block", blockId: oldest.id }, includeResolved: true })[0] as unknown as { block: Block }).block.id;
  // The person's own block under the ticket goes wherever the ticket goes.
  const mine = await client.request<Block>({ action: "create", parentId: record.id, text: "My aside on the ticket", author: "user" });

  const issue = fake.issues.get("PC-1")!;
  issue.comments = [...issue.comments!, { id: "503", author: "Lee Park", created: "2026-01-04T08:00:00.000Z", body: "Printer fixed." }];
  issue.updated = new Date().toISOString();
  const before = store.sequence;
  await client.request({ action: "resources.projection.refresh", blockId: page.id });
  expect(commentsOf(record.id).map((comment) => comment.text.split("\n")[0])).toEqual(["Dana Ortiz · 2026-01-03 11:30", "Lee Park · 2026-01-04 08:00"]);
  const gone = store.get(oldest.id)!;
  expect(gone.deletedAt).toBeTruthy();
  expect(visibleChangesSince(before).filter((change) => change.blockId === oldest.id).map((change) => [change.action, change.actor?.actorId]))
    .toContainEqual(["ext.jira.drop-comment", "ext:jira"]);
  expect(store.get(mine.id)!.effectiveDeletedRootId).toBeFalsy();
  // The person's highlight and reply are kept, in Trash with the comment (a thread lives under the block it is on).
  expect(store.get(highlight)).toMatchObject({ effectiveDeletedRootId: oldest.id });

  // Restored by the person, it is back where it was with the highlight on it.
  await client.request({ action: "trash.restore", blockId: oldest.id, mutation: PERSON });
  expect(store.get(oldest.id)!.effectiveDeletedRootId).toBeFalsy();
  expect(store.listAnnotationThreads({ subject: { kind: "block", blockId: oldest.id }, includeResolved: true })).toHaveLength(1);
}, 30_000);

test("401, 403 and 429 pause the automatic fetches (saves, opens, the poll); r still fetches; success resumes", async () => {
  const { fake, store, server, client, create, until, recordOf } = await setup();
  const page = await create("PC-1 Rollout [jira::PC-1]");
  await recordOf(page.id);
  for (const status of [401, 403, 429]) {
    fake.status = status;
    const issue = fake.issues.get("PC-1")!;
    issue.updated = new Date().toISOString();
    await client.request({ action: "resources.projection.refresh", blockId: page.id });
    // An automatic attempt that meets the refusal pauses the sync.
    await server.extensionSync.materialize(page.id);
    const other = await create(`PC-2 Printer ${status} [jira::PC-2]`);
    await Bun.sleep(100);
    // Paused: a new page doesn't reach Jira at all, and says why.
    const requests = fake.requests.length;
    await server.extensionSync.materialize(other.id);
    expect(fake.requests.length).toBe(requests);
    expect(server.extensionSync.paused()).toBeTruthy();
    const read = await client.request<ResourceProjectionReadResult>({ action: "resources.projection.read", blockId: other.id });
    expect(read.projections[0]!.fetchError).toContain("paused, r tries now");
    expect(await server.extensionSync.poll()).toEqual({ checked: 0, changed: 0 });
    expect(server.extensionSync.lastPollResult?.error).toContain("paused");
    // r tries now; once Jira answers, the pause is over.
    fake.status = null;
    await client.request({ action: "resources.projection.refresh", blockId: other.id });
    expect(server.extensionSync.paused()).toBeUndefined();
    await until("the other ticket's record", () => store.extensionRecords({ extensionId: "jira", role: "record", itemKey: "PC-2" }).length === 1);
    await client.request({ action: "update", blockId: other.id, text: "gone", expectedRevision: store.get(other.id)!.revision, mutation: PERSON });
    await until("PC-2 released", () => store.extensionRecords({ extensionId: "jira", role: "record", itemKey: "PC-2" }).length === 0);
  }
}, 60_000);

test("a failed search keeps the poll's window, and one bad source in config.json doesn't stop the others", async () => {
  const { fake, server, create, recordOf } = await setup({ extraSources: [{ origin: "not a url", project: "ZZ" }] });
  const page = await create("PC-1 Rollout [jira::PC-1]");
  await recordOf(page.id);
  const sync = server.extensionSync as unknown as { lastPoll: number | null };
  await server.extensionSync.poll();
  const first = sync.lastPoll;
  expect(first).not.toBeNull();
  fake.status = 503;
  await server.extensionSync.poll();
  expect(server.extensionSync.lastPollResult?.error).toBeTruthy();
  expect(sync.lastPoll).toBe(first);
  fake.status = null;
  await server.extensionSync.poll();
  expect(sync.lastPoll).toBeGreaterThan(first!);
});

test("a ticket deleted at Jira doesn't stop the poll: the refused key search is answered by one project search", async () => {
  const { fake, store, server, create, recordOf } = await setup();
  const rollout = await create("PC-1 Rollout [jira::PC-1]");
  const record = await recordOf(rollout.id);
  await recordOf((await create("PC-2 Printer [jira::PC-2]")).id);
  fake.issues.delete("PC-2");
  const issue = fake.issues.get("PC-1")!;
  issue.status = "Done";
  issue.updated = new Date().toISOString();
  expect(await server.extensionSync.poll()).toEqual({ checked: 2, changed: 1 });
  expect(store.get(record.id)!.properties).toContainEqual({ key: "jira.status", value: "Done" });
  expect(fake.requests.filter((request) => request.startsWith('JQL project = "PC"'))).toHaveLength(1);
  // A missing ticket is not a refusal: nothing pauses.
  expect(server.extensionSync.paused()).toBeUndefined();
}, 30_000);
