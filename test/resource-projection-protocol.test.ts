import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutlinerClient } from "../src/client";
import { projectDetailRead } from "../src/detail-embeds";
import type { RemoteEntityProviderClient, RemoteEntityResource, RemoteEntitySource } from "../src/remote-entity";
import type { ResourceProjection, ResourceProjectionReadResult } from "../src/resource-projection";
import { OutlinerServer } from "../src/server";
import { OutlinerStore } from "../src/store";
import { readResourceProjections, type ResourceProjectionDataSource } from "../src/resource-projection";
import type { OutlinerServiceStatus, RemoteEntityDocument, ResourceSource } from "../src/types";

// Fictional project and tickets. Nothing here contacts a provider.
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

class TicketFixture implements RemoteEntityProviderClient {
  observeCalls = 0;
  resolveCalls = 0;
  observeError: string | null = null;

  async resolveLocator(_source: RemoteEntitySource, locator: string) {
    this.resolveCalls += 1;
    return { entityId: `entity-${locator}`, locator };
  }

  async observe(resource: RemoteEntityResource): Promise<RemoteEntityDocument> {
    this.observeCalls += 1;
    if (this.observeError) throw new Error(this.observeError);
    if (resource.address.kind !== "jira") throw new Error("Tickets are Jira fixtures");
    const key = resource.address.key;
    const fetchedAt = "2026-09-20T10:00:00.000Z";
    const markdown = `# Rollout checklist\n\nDetails for ${key}.`;
    return {
      title: "Rollout checklist",
      metadata: { key, type: "Task", status: "In progress", assignee: "A. Person", labels: ["rollout", "vendor"], reporter: "B. Person" },
      markdown,
      externalUrl: `https://issues.example.test/browse/${key}`,
      sourceSnapshot: {
        provider: "jira",
        resourceId: resource.id,
        addressVersion: resource.addressVersion,
        entityId: resource.address.entityId,
        locator: key,
        contentHash: createHash("sha256").update(key).digest("hex"),
        revision: {
          resourceId: resource.id,
          addressVersion: resource.addressVersion,
          revision: { kind: "jira", validator: { kind: "updated-at", value: "2026-09-19T08:30:00.000Z" } },
        },
        fetchedAt,
      },
      representation: {
        mediaType: "text/markdown",
        adapter: { id: "test.tickets", version: 1 },
        contentHash: createHash("sha256").update(markdown).digest("hex"),
        derivedAt: fetchedAt,
      },
      commandDescriptors: [],
    };
  }

  async execute(): Promise<never> {
    throw new Error("Tickets are read-only");
  }
}

async function start() {
  const directory = mkdtempSync(join(tmpdir(), "outliner-resource-projection-"));
  const provider = new TicketFixture();
  const store = new OutlinerStore(join(directory, "outliner.sqlite"), { remoteEntityClient: provider });
  const socket = join(directory, "outliner.sock");
  const server = new OutlinerServer(store, socket);
  await server.start();
  const client = new OutlinerClient(socket);
  cleanups.push(async () => {
    await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const source = store.resources.createSource({
    name: "Tickets",
    provider: "jira",
    boundary: { origin: "https://issues.example.test", project: "ACME" },
  }) as ResourceSource;
  const register = (key: string) => store.resources.intern({
    sourceId: source.id,
    address: { kind: "jira", entityId: `entity-${key}`, key },
  }).resource.id;
  return { store, client, provider, source, register };
}

const resourceCount = (store: OutlinerStore) =>
  (store.database.query("SELECT count(*) AS count FROM resources").get() as { count: number }).count;

const read = (client: OutlinerClient, blockId: string, line?: number) =>
  client.request<ResourceProjectionReadResult>({ action: "resources.projection.read", blockId, ...(line === undefined ? {} : { line }) });

test("the service advertises resources.projection and reads stored snapshots without contacting the provider", async () => {
  const { store, client, provider, register } = await start();
  const status = await client.request<OutlinerServiceStatus>({ action: "ping" });
  expect(status.capabilities).toContain("resources.projection");

  const ready = register("ACME-12");
  await store.resources.refresh(ready, true);
  const failed = register("ACME-13");
  await store.resources.refresh(failed, true);
  provider.observeError = "offline";
  await store.resources.refresh(failed, true).catch(() => undefined);
  register("ACME-14");
  const before = { observe: provider.observeCalls, resolve: provider.resolveCalls, resources: resourceCount(store) };

  const note = store.create([
    "Vendor call ACME-12",
    "- jira:: --comments",
    "- ACME-13 follow-up",
    "  jira::",
    "Registered, not fetched: ACME-14",
    "jira::",
    "Unregistered ACME-15",
    "jira::",
    "compare ACME-12 and ACME-13",
    "jira::",
    "jira:: OTHER-1",
  ].join("\n"));
  const result = await read(client, note.id);
  expect(result.revision).toBe(note.revision);
  expect(result.projections.map(({ anchor, status, key, resolvedFrom }) =>
    ({ line: anchor.line, status, key, step: resolvedFrom?.step }))).toEqual([
    { line: 1, status: "ready", key: "ACME-12", step: "subject-line" },
    { line: 3, status: "stale", key: "ACME-13", step: "preceding-line" },
    { line: 5, status: "not-fetched", key: "ACME-14", step: "preceding-line" },
    { line: 7, status: "not-registered", key: "ACME-15", step: "preceding-line" },
    { line: 9, status: "ambiguous", key: undefined, step: "preceding-line" },
    { line: 10, status: "unavailable", key: "OTHER-1", step: "explicit" },
  ]);
  const [first, stale, notFetched, unregistered, ambiguous, noSource] = result.projections as ResourceProjection[];
  // Only the provider's allowed fields are shown, in its order.
  expect(first!.fields.map((field) => field.label)).toEqual(["Status", "Assignee", "Type", "Labels"]);
  expect(first).toMatchObject({
    label: "Jira",
    anchor: { kind: "directive" },
    options: { comments: 5, unknown: [] },
    resourceId: ready,
    summary: "Rollout checklist",
    fields: [
      { label: "Status", value: "In progress" },
      { label: "Assignee", value: "A. Person" },
      { label: "Type", value: "Task" },
      { label: "Labels", value: "rollout, vendor" },
    ],
    updatedAt: "2026-09-19T08:30:00.000Z",
    fetchedAt: "2026-09-20T10:00:00.000Z",
    externalUrl: "https://issues.example.test/browse/ACME-12",
  });
  expect(stale!.summary).toBe("Rollout checklist");
  expect(stale!.reason).toContain("last refresh failed");
  expect(notFetched!.reason).toContain("press r");
  expect(unregistered!.reason).toContain("Write jira:: ACME-15 and open that link to register it");
  expect(unregistered!.resourceId).toBeUndefined();
  expect(ambiguous!.candidates).toEqual(["ACME-12", "ACME-13"]);
  expect(noSource!.reason).toContain("No Jira Source");

  // Reading registered nothing, refreshed nothing and ran no provider call.
  expect({ observe: provider.observeCalls, resolve: provider.resolveCalls, resources: resourceCount(store) }).toEqual(before);
});

test("no key in context is reported, and the workboard prefix never resolves as a ticket", async () => {
  const { store, client } = await start();
  const parent = store.create("Plan for PIE-445 on 2026-09-28");
  const child = store.create("Notes\njira::", parent.id);
  const result = await read(client, child.id);
  expect(result.projections).toMatchObject([{ status: "no-key", anchor: { line: 1 } }]);
  expect(result.projections[0]!.reason).toContain("No Jira key");
});

test("a requested line outside the block is rejected with a clear error", async () => {
  const { store, client } = await start();
  const note = store.create("Notes ACME-1\nsecond\nthird");
  await expect(read(client, note.id, 50)).rejects.toThrow("line 50 is outside the block");
  await expect(read(client, note.id, 3)).rejects.toThrow("line 3 is outside the block");
});

test("only the first provider lines are resolved when a note holds many", async () => {
  const { store, client } = await start();
  const note = store.create(["Notes", ...Array.from({ length: 40 }, (_, index) => `jira:: ACME-${index + 1}`)].join("\n"));
  const result = await read(client, note.id);
  expect(result.projections).toHaveLength(16);
  expect(result.projections.map((projection) => projection.key)).toEqual(
    Array.from({ length: 16 }, (_, index) => `ACME-${index + 1}`),
  );
});

test("a ticket page shows its ticket at the top of the body, and a provider line inside it takes over", async () => {
  const { store, client, register } = await start();
  const id = register("ACME-40");
  await store.resources.refresh(id, true);
  const page = store.create("Rollout ticket [jira::ACME-40]\n[owner::me]\n\nLocal notes");
  expect((await read(client, page.id)).projections).toMatchObject([
    { anchor: { kind: "page", line: 1 }, status: "ready", key: "ACME-40", resolvedFrom: { step: "block-property" } },
  ]);
  // Ancestors supply the key to a child's provider line.
  const child = store.create("Decision log\njira:: --compact", page.id);
  expect((await read(client, child.id)).projections).toMatchObject([
    { anchor: { kind: "directive", line: 1 }, key: "ACME-40", options: { compact: true }, resolvedFrom: { step: "ancestor-property", blockId: page.id } },
  ]);
  const withLine = store.create("Rollout ticket [jira::ACME-40]\nNotes\njira:: --full");
  expect((await read(client, withLine.id)).projections).toMatchObject([
    { anchor: { kind: "directive", line: 2 }, key: "ACME-40", options: { full: true } },
  ]);
  // A line request resolves any line from its context.
  expect((await read(client, withLine.id, 1)).projections).toMatchObject([
    { anchor: { kind: "line", line: 1 }, key: "ACME-40", status: "ready" },
  ]);
});

test("Detail renders a projection from a live service and falls back silently on an older one", async () => {
  const { store, client, register } = await start();
  const id = register("ACME-50");
  await store.resources.refresh(id, true);
  const note = store.create("Vendor call ACME-50\n- jira::\nAfter");
  const projected = await projectDetailRead(client, note.text, { hostBlockId: note.id, hostRevision: note.revision });
  const lines = projected.text.split("\n");
  expect(lines[0]).toBe("Vendor call ACME-50");
  expect(lines[1]).toBe("- jira::");
  expect(lines[2]).toContain(`- Jira [ACME-50](pi-outliner://resource/${id}) · Rollout checklist`);
  expect(lines[3]).toContain("Status: In progress · Assignee: A. Person");
  expect(lines[4]).toMatch(/^  fetched \d{4}-\d\d-\d\d \d\d:\d\d$/);
  expect(lines[5]).toBe("");
  expect(lines[6]).toBe("After");
  expect(projected.embedRanges).toEqual([{ startLine: 2, endLine: 4, inserted: { afterSourceLine: 1, lineCount: 4 },
    resource: { resourceId: id, fetchedAt: "2026-09-20T10:00:00.000Z", fetchedLine: 2 } }]);
  expect(projected.resourceProjections?.[0]?.resourceId).toBe(id);

  // An older service lacks the capability: no read is sent and the note renders as authored.
  const calls: string[] = [];
  const older = {
    async request<T>(input: { action: string }): Promise<T> {
      calls.push(input.action);
      if (input.action === "ping") return { status: "ready", protocolVersion: 82, capabilities: ["views.read"] } as T;
      throw new Error(`Unknown action: ${input.action}`);
    },
  };
  const fallback = await projectDetailRead(older, note.text, { hostBlockId: note.id, hostRevision: note.revision });
  expect(fallback.text).toBe(note.text);
  expect(fallback.embedRanges).toEqual([]);
  expect(calls).toEqual(["ping"]);
});

function fakeSource(text: string, ancestors: { id: string; text: string }[], describe: (id: string) => never | unknown = () => {
  throw new Error("Corrupt stored snapshot");
}): ResourceProjectionDataSource & { lookups: number } {
  const source = {
    lookups: 0,
    blockContext: () => ({
      selected: { id: "note", text, revision: 1, parentId: null, position: 0, author: "user" as const,
        createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z", properties: [] },
      // Root first, as the store returns them.
      ancestors: ancestors.map((ancestor) => ({ ...ancestor, revision: 1, parentId: null, position: 0, author: "user" as const,
        createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z", properties: [] })),
    }),
    resources: {
      listSources: () => [{ id: "tickets", provider: "jira", name: "Tickets",
        boundary: { origin: "https://issues.example.test", project: "ACME" }, policy: { deniedCapabilities: [] } }] as never,
      resolveAuthoredReference: (reference: { key: string }) => {
        source.lookups += 1;
        return reference.key === "ACME-1"
          ? { kind: "ready" as const, resourceId: "11111111-1111-4111-8111-111111111111" }
          : { kind: "unregistered" as const, reason: "not registered" };
      },
      describe: describe as never,
    },
  };
  return source;
}

test("one unreadable stored copy makes only its own projection unavailable", () => {
  const result = readResourceProjections(fakeSource("Vendor call\njira:: ACME-1\njira:: ACME-2", []), { blockId: "note" });
  expect(result.projections.map(({ key, status, reason }) => ({ key, status, reason }))).toEqual([
    { key: "ACME-1", status: "unavailable", reason: "Stored copy unreadable" },
    { key: "ACME-2", status: "not-registered", reason: expect.stringContaining("not registered yet") },
  ]);
});

test("a large note with deep, large ancestors is read within a bounded time", () => {
  // 3,000 provider lines (only 16 are resolved) under 50 ancestors of about 55 KB of keys, properties and tags.
  const text = ["Subject", ...Array.from({ length: 3000 }, () => "jira::")].join("\n");
  const ancestors = Array.from({ length: 50 }, (_, index) => ({
    id: `ancestor-${index}`,
    text: `Ancestor ${index}\n${"body ACME-5 [status::open] #tag note\n".repeat(1500)}`,
  }));
  const source = fakeSource(text, ancestors);
  readResourceProjections(source, { blockId: "note" });
  const started = performance.now();
  const result = readResourceProjections(source, { blockId: "note" });
  const elapsed = performance.now() - started;
  expect(result.projections).toHaveLength(16);
  expect(result.projections.every((projection) => projection.status === "no-key")).toBe(true);
  expect(elapsed).toBeLessThan(200);
});
