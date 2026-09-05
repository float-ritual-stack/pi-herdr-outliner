import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAnnotationAnchor } from "../src/annotations";
import { OutlinerClient } from "../src/client";
import { HerdrRuntimeRegistry, type HerdrSessionSnapshot } from "../src/herdr-registry";
import { OutlinerServer } from "../src/server";
import { OutlinerStore } from "../src/store";
import { OUTLINER_PROTOCOL_VERSION } from "../src/types";
import type {
  AnnotationBatchReceipt,
  AnnotationThread,
  BacklinkCollection,
  BlockEditActivityPage,
  Block,
  CaptureReceipt,
  DeliveryReceipt,
  BrowsingContextPublication,
  OutlinerEvent,
  OutlinerClientRegistration,
  OutlinerRequest,
  OutlinerResponse,
  OutlinerNavigationDispatch,
  NavigationState,
  PageAddressCollection,
  PageAddressFollowResult,
  PageAddressRecord,
  PageAddressResolution,
  PageAddressRemoval,
  OutlinerServiceStatus,
  PropertyCatalogItem,
  SelectionContext,
  VisibleBlockCollection,
  RoadmapItemCreateReceipt,
  WorkIdAllocation,
  WorkIdAllocatorStatus,
  WorkspaceSnapshot,
} from "../src/types";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});


test("round-trips idempotent delivery identity over protocol v30", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-delivery-protocol-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  const socket = join(directory, "outliner.sock");
  const server = new OutlinerServer(store, socket);
  await server.start();
  cleanups.push(async () => {
    await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const task = store.create(
    "PIE-182 lifecycle [type::roadmap-item] [work-id::PIE-182] [work-stage::next]",
  );
  const sequenceBefore = store.sequence;
  const client = new OutlinerClient(socket);
  const input = {
    taskBlockId: task.id,
    deliveryKey: "PIE-182/enforcement",
    repository: "float-ritual-stack/pi-herdr-outliner",
    baseBranch: "main",
    workBranch: "feature/pie-182-lifecycle-enforcement",
  };

  const created = await client.request<DeliveryReceipt>({
    action: "deliveries.ensure",
    input,
    author: "agent",
    provenance: { actorId: "omp", sessionId: "session-1", taskId: "start" },
  });
  const reused = await client.request<DeliveryReceipt>({
    action: "deliveries.ensure",
    input,
  });

  expect(created.created).toBe(true);
  expect(reused.created).toBe(false);
  expect(reused.delivery.id).toBe(created.delivery.id);
  expect(store.sequence).toBe(sequenceBefore + 1);
});



test("serves atomic idempotent annotation threads over protocol v30", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-annotation-protocol-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  const socket = join(directory, "outliner.sock");
  const server = new OutlinerServer(store, socket);
  await server.start();
  cleanups.push(async () => {
    await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const client = new OutlinerClient(socket);
  const source = await client.request<Block>({
    action: "create",
    text: "alpha βeta gamma",
  });
  const operations = [{
    operationId: "comment-1",
    type: "create" as const,
    input: {
      target: {
        kind: "block" as const,
        sourceBlockId: source.id,
        anchor: createAnnotationAnchor(source.text, 6, 10, source.updatedAt),
      },
      body: "Check this range.",
      source: "agent" as const,
    },
  }];
  const created = await client.request<AnnotationBatchReceipt>({
    action: "annotations.batch",
    requestId: "protocol-annotation-batch-1",
    operations,
    author: "agent",
    provenance: { actorId: "omp", sessionId: "session-1", taskId: "call-1" },
  });
  const replayed = await client.request<AnnotationBatchReceipt>({
    action: "annotations.batch",
    requestId: "protocol-annotation-batch-1",
    operations,
    author: "agent",
    provenance: { actorId: "omp", sessionId: "session-1", taskId: "call-2" },
  });
  const threads = await client.request<AnnotationThread[]>({
    action: "annotations.list",
    query: { sourceBlockId: source.id, includeResolved: true },
  });
  expect(created.deduplicated).toBe(false);
  expect(replayed.deduplicated).toBe(true);
  expect(replayed.annotations[0]!.block.id).toBe(created.annotations[0]!.block.id);
  expect(threads).toHaveLength(1);
  expect(threads[0]!.target.anchor.excerpt).toBe("βeta");
});

test("serves mutations and property queries over the local socket", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-protocol-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  const socket = join(directory, "outliner.sock");
  const server = new OutlinerServer(store, socket);
  await server.start();
  cleanups.push(async () => {
    await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const client = new OutlinerClient(socket);
  const service = await client.request<OutlinerServiceStatus>({ action: "ping" });
  expect(service).toEqual({ status: "ready", protocolVersion: OUTLINER_PROTOCOL_VERSION });
  expect(service.protocolVersion).toBe(30);
  const provenance = {
    actorId: "omp",
    sessionId: "session-1",
    taskId: "tool-call-1",
  };
  const block = await client.request<Block>({
    action: "create",
    text: "Waiting for user [type::question] [status::open]",
    author: "agent",
    provenance,
  });
  expect(block).toEqual(expect.objectContaining({
    author: "agent",
    ...provenance,
  }));
  await client.request<Block>({
    action: "create",
    text: "Another question [type::question] [status::open]",
  });
  const matches = await client.request<VisibleBlockCollection>({
    action: "blocks.query",
    query: { filters: [{ key: "type", value: "question" }], limit: 1 },
  });
  const spaced = await client.request<Block>({
    action: "create",
    text: "Active protocol work [status::in progress] [project::pi-outliner]",
  });
  const spacedMatches = await client.request<VisibleBlockCollection>({
    action: "blocks.query",
    query: {
      filters: [
        { key: " STATUS ", value: " in progress " },
        { key: "project", value: "PI-OUTLINER" },
      ],
      limit: 20,
    },
  });
  expect(spacedMatches).toEqual({
    blocks: [expect.objectContaining({ id: spaced.id })],
    completeness: { kind: "complete" },
  });
  const allocatorBefore = await client.request<WorkIdAllocatorStatus>({
    action: "work-ids.status",
  });
  expect(allocatorBefore).toEqual({
    prefix: null,
    nextNumber: null,
    nextWorkId: null,
    reservedCount: 0,
    observedPrefixes: [],
  });
  await client.request({ action: "work-ids.configure", prefix: "pie" });
  const workTarget = await client.request<Block>({
    action: "create",
    text: "Protocol work target",
  });
  const allocation = await client.request<WorkIdAllocation>({
    action: "work-ids.allocate",
    blockId: workTarget.id,
    expectedUpdatedAt: workTarget.updatedAt,
  });
  expect(allocation).toMatchObject({
    workId: "PIE-001",
    block: {
      id: workTarget.id,
      properties: [{ key: "work-id", value: "PIE-001" }],
    },
  });
  expect(await client.request<WorkIdAllocatorStatus>({
    action: "work-ids.status",
  })).toEqual({
    prefix: "PIE",
    nextNumber: 2,
    nextWorkId: "PIE-002",
    reservedCount: 1,
    observedPrefixes: ["PIE"],
  });
  const workQueue = await client.request<Block>({
    action: "create",
    text: "Protocol work queue [type::work-queue] [project::pi-outliner]",
  });
  const lane = await client.request<Block>({
    action: "create",
    text: "Unprioritized [type::virtual-branch] [query::work-stage=unprioritized]",
  });
  const roadmapReceipt = await client.request<RoadmapItemCreateReceipt>({
    action: "roadmap.items.create",
    input: {
      title: "Round-trip atomic roadmap creation",
      priority: "high",
      project: "pi-outliner",
      arc: "protocol",
      tracks: ["core"],
    },
    author: "agent",
    provenance,
  });
  expect(roadmapReceipt).toMatchObject({
    workId: "PIE-002",
    workQueueId: workQueue.id,
    block: {
      parentId: workQueue.id,
      actorId: "omp",
      properties: expect.arrayContaining([
        { key: "work-stage", value: "unprioritized" },
        { key: "work-id", value: "PIE-002" },
      ]),
    },
    memberships: [{ viewId: lane.id, title: "Unprioritized" }],
  });

  expect(matches.blocks.some((candidate) => candidate.id === block.id)).toBe(true);
  expect(matches.completeness).toEqual({ kind: "truncated", limit: 1 });
  await client.request({ action: "selection.set", blockId: block.id });
  const context = await client.request<{ selected: Block }>({ action: "selection.get" });
  expect(context.selected.id).toBe(block.id);
  const navigation = await client.request<NavigationState>({ action: "navigation.state" });
  expect(navigation).toMatchObject({
    selection: { selected: { id: block.id } },
    canBack: true,
    canForward: false,
  });
  expect((await client.request<NavigationState>({
    action: "navigation.back",
  })).selection.selected?.id).not.toBe(block.id);
  expect((await client.request<NavigationState>({
    action: "navigation.forward",
  })).selection.selected?.id).toBe(block.id);
  const resolved = await client.request<{ text: string; workIdPrefix?: string }>({
    action: "references.resolve",
    text: `See ((${block.id}))`,
  });
  expect(resolved.workIdPrefix).toBe("PIE");
  expect(resolved.text).toBe("See ((Waiting for user))");
  const backlinkSource = await client.request<Block>({
    action: "create",
    text: `Protocol backlink source\n((${block.id}))`,
  });
  const backlinks = await client.request<BacklinkCollection>({
    action: "references.backlinks",
    query: { targetBlockId: block.id, limit: 10 },
  });
  expect(backlinks).toMatchObject({
    targetBlockId: block.id,
    sources: [{
      blockId: backlinkSource.id,
      title: "Protocol backlink source",
      occurrenceCount: 1,
    }],
    completeness: { kind: "complete" },
  });
  const dangling = await client.request<PageAddressResolution>({
    action: "pages.resolve",
    address: "Protocol Page",
  });
  expect(dangling).toEqual({
    address: "Protocol Page",
    normalizedAddress: "protocol page",
    status: "missing",
  });
  const followedPage = await client.request<PageAddressFollowResult>({
    action: "pages.follow",
    address: "Protocol Page",
  });
  expect(followedPage).toMatchObject({
    status: "resolved",
    created: true,
    registeredAddress: "Protocol Page",
    block: { text: "Protocol Page [page::Protocol Page]" },
  });
  expect(await client.request<PageAddressCollection>({
    action: "pages.complete",
    query: "protocol",
    limit: 20,
  })).toMatchObject({
    addresses: [{
      address: "Protocol Page",
      blockId: followedPage.block!.id,
      kind: "page",
    }],
    completeness: { kind: "complete" },
  });
  expect(await client.request<PageAddressRecord>({
    action: "pages.rename",
    blockId: followedPage.block!.id,
    address: "Renamed Protocol Page",
    expectedUpdatedAt: followedPage.block!.updatedAt,
  })).toMatchObject({ address: "Renamed Protocol Page", kind: "page" });
  expect(await client.request<PageAddressRecord>({
    action: "pages.alias",
    blockId: followedPage.block!.id,
    address: "Protocol Alias",
  })).toMatchObject({ address: "Protocol Alias", kind: "alias" });
  const renamedPageBlock = await client.request<Block>({
    action: "get",
    blockId: followedPage.block!.id,
  });
  expect(await client.request<PageAddressRemoval>({
    action: "pages.remove",
    blockId: followedPage.block!.id,
    address: "Protocol Alias",
    expectedUpdatedAt: renamedPageBlock.updatedAt,
  })).toMatchObject({ removed: { address: "Protocol Alias", kind: "alias" } });
  expect(await client.request<PageAddressResolution>({
    action: "pages.resolve",
    address: "Protocol Page",
  })).toMatchObject({ status: "resolved", kind: "alias", block: { id: followedPage.block!.id } });
  const invalidPatch = server.handle({
    id: "invalid-patch",
    action: "properties.patch",
    blockId: block.id,
    expectedUpdatedAt: block.updatedAt,
    operations: [{ op: "bogus", ordinal: 0 }],
  } as unknown as OutlinerRequest);
  expect(invalidPatch.ok).toBe(false);
  expect(store.require(block.id).text).toBe(block.text);
  const unsupported = server.handle({
    id: "unsupported-action",
    action: "future.action",
  } as unknown as OutlinerRequest);
  expect(unsupported.ok).toBe(false);
  if (!unsupported.ok) expect(unsupported.error).toBe("Unsupported action: future.action");
  const oldList = server.handle({
    id: "old-list",
    action: "list",
  } as unknown as OutlinerRequest);
  expect(oldList.ok).toBe(false);
  if (!oldList.ok) expect(oldList.error).toBe("Unsupported action: list");
  const invalidLimit = server.handle({
    id: "invalid-query-limit",
    action: "blocks.query",
    query: { limit: 0 },
  });
  expect(invalidLimit.ok).toBe(false);
  if (!invalidLimit.ok) {
    expect(invalidLimit.error).toBe("Block search limit must be an integer from 1 through 1000");
  }
  const patched = await client.request<Block>({
    action: "properties.patch",
    blockId: block.id,
    expectedUpdatedAt: block.updatedAt,
    operations: [
      { op: "replace", ordinal: 1, value: "doing" },
      { op: "append", key: "priority", value: "high" },
    ],
    mutation: { author: "agent", ...provenance },
  });
  expect(patched.text).toBe(
    "Waiting for user [type::question] [status::doing]\n[priority::high]",
  );
  const userUpdated = await client.request<Block>({
    action: "update",
    blockId: patched.id,
    text: `${patched.text}\nUser note`,
    expectedUpdatedAt: patched.updatedAt,
    mutation: { author: "user", actorId: "detail" },
  });
  const activity = await client.request<BlockEditActivityPage>({
    action: "activity.recent",
    author: "user",
    limit: 5,
  });
  expect(activity.entries).toHaveLength(1);
  expect(activity.entries[0]).toMatchObject({
    block: { id: userUpdated.id, text: userUpdated.text },
    author: "user",
    actorId: "detail",
    kind: "text",
  });
  const catalog = await client.request<PropertyCatalogItem[]>({
    action: "properties.catalog",
    key: "status",
    prefix: "do",
  });
  expect(catalog).toEqual([{ key: "status", value: "doing", count: 1 }]);
  const scoped = await client.request<Block>({
    action: "create",
    text: "Scoped protocol\n\nBody [note::detail]",
  });
  expect((await client.request<VisibleBlockCollection>({
    action: "blocks.query",
    query: { filters: [{ key: "note", value: "detail" }], limit: 10 },
  })).blocks).toEqual([]);
  expect((await client.request<VisibleBlockCollection>({
    action: "blocks.query",
    query: {
      filters: [{ key: "note", value: "detail" }],
      propertyScope: "inline",
      limit: 10,
    },
  })).blocks).toEqual([
    expect.objectContaining({
      id: scoped.id,
      propertyMatches: [
        expect.objectContaining({ key: "note", scope: "inline", line: 2 }),
      ],
    }),
  ]);
  expect(await client.request<PropertyCatalogItem[]>({
    action: "properties.catalog",
    key: "note",
    propertyScope: "all",
  })).toEqual([{ key: "note", value: "detail", count: 1 }]);
  const trashTarget = await client.request<Block>({
    action: "create",
    text: "Protocol Trash target [work-id::PIE-998]",
  });
  const trashed = await client.request<Block>({
    action: "delete",
    blockId: trashTarget.id,
  });
  expect(trashed.effectiveDeletedRootId).toBe(trashTarget.id);
  expect((await client.request<VisibleBlockCollection>({
    action: "blocks.query",
    query: { text: "Protocol Trash target", limit: 10 },
  })).blocks).toEqual([]);
  await client.request({ action: "trash.restore", blockId: trashTarget.id });
  await client.request({ action: "delete", blockId: trashTarget.id });
  await client.request({
    action: "trash.purge",
    blockId: trashTarget.id,
    confirmation: "PIE-998",
  });
  await expect(
    client.request({ action: "get", blockId: trashTarget.id }),
  ).rejects.toThrow("Block not found");
});


test("rejects malformed socket responses instead of crashing the client", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-malformed-"));
  const socketPath = join(directory, "outliner.sock");
  const server = createServer((socket) => socket.end("not-json\n"));
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(socketPath, listening.resolve);
  await listening.promise;
  cleanups.push(async () => {
    const closed = Promise.withResolvers<void>();
    server.close((error) => (error ? closed.reject(error) : closed.resolve()));
    await closed.promise;
    rmSync(directory, { recursive: true, force: true });
  });

  const client = new OutlinerClient(socketPath);
  await expect(client.request({ action: "ping" })).rejects.toThrow();
});

test("streams workspace mutations and transient UI commands to subscribers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-events-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  const socket = join(directory, "outliner.sock");
  const server = new OutlinerServer(store, socket);
  await server.start();
  const view = store.create("Doing [type::virtual-branch] [query::status=doing]");
  const other = store.create("Other [status::doing]");
  const client = new OutlinerClient(socket);
  const connected = Promise.withResolvers<void>();
  const received = Promise.withResolvers<void>();
  const events: OutlinerEvent[] = [];
  const watcher = client.watch({
    client: { clientId: "event-detail", role: "detail", contextId: "event-detail" },
    onConnect: connected.resolve,
    onEvent: (event) => {
      events.push(event);
      if (events.length === 9) received.resolve();
    },
  });
  cleanups.push(async () => {
    await watcher.stop();
    await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  await connected.promise;
  await client.request({ action: "work-ids.configure", prefix: "EVT" });
  const block = await client.request<Block>({ action: "create", text: "Reactive block" });
  const capture = await client.request<CaptureReceipt>({
    action: "capture.create",
    requestId: "event-capture",
    text: "Reactive capture",
    source: "tree",
    capturedFromBlockId: block.id,
  });
  const replay = await client.request<CaptureReceipt>({
    action: "capture.create",
    requestId: "event-capture",
    text: "Ignored retry",
    source: "tree",
    capturedFromBlockId: block.id,
  });
  expect(capture).toEqual({
    block: expect.objectContaining({
      parentId: capture.inboxBlockId,
      properties: expect.arrayContaining([
        { key: "type", value: "capture" },
        { key: "captured-from", value: block.id },
      ]),
    }),
    inboxBlockId: expect.any(String),
    deduplicated: false,
  });
  expect(replay).toEqual({
    block: expect.objectContaining({ id: capture.block.id }),
    inboxBlockId: capture.inboxBlockId,
    deduplicated: true,
  });
  await client.request({
    action: "work-ids.allocate",
    blockId: block.id,
    expectedUpdatedAt: block.updatedAt,
  });
  await client.request({ action: "selection.set", blockId: block.id });
  await client.request({ action: "navigation.back" });
  await client.request({ action: "navigation.forward" });
  await client.request({
    action: "virtual.occurrences.reorder",
    viewId: view.id,
    orderedBlockIds: [other.id, block.id],
  });
  await client.request({
    action: "ui.command.send",
    command: { targetClientId: "event-detail", command: "edit", blockId: block.id },
  });
  await received.promise;

  expect(events.map((event) => [event.domain, event.action])).toEqual([
    ["content", "work-ids.configure"],
    ["content", "create"],
    ["content", "capture.create"],
    ["content", "work-ids.allocate"],
    ["selection", "selection.set"],
    ["selection", "navigation.back"],
    ["selection", "navigation.forward"],
    ["view", "virtual.occurrences.reorder"],
    ["ui", "ui.command.send"],
  ]);
  expect(events[1].blockId).toBe(block.id);
  expect(events[2].blockId).toBe(capture.block.id);
  expect(events[3].blockId).toBe(block.id);
  expect(events[8].command).toEqual({
    targetClientId: "event-detail",
    command: "edit",
    blockId: block.id,
  });

  const children = await client.request<Block[]>({ action: "children", parentId: null });
  expect(children.some((candidate) => candidate.id === block.id)).toBe(true);
  const snapshot = await client.request<WorkspaceSnapshot>({ action: "workspace.snapshot" });
  expect(snapshot.visible.blocks.some((candidate) => candidate.id === block.id)).toBe(true);
  expect(snapshot.visible.completeness).toEqual({ kind: "complete" });
  expect(snapshot.workIdPrefix).toBe("EVT");
  expect(snapshot.physical.blocks.some((candidate) => candidate.id === block.id)).toBe(true);
  expect(snapshot.physical.completeness).toEqual({ kind: "complete" });
  expect(snapshot.selection.selected?.id).toBe(block.id);
  expect(snapshot.virtualOccurrenceRanks).toEqual([
    { viewId: view.id, blockId: other.id, rank: 0 },
    { viewId: view.id, blockId: block.id, rank: 1 },
  ]);
});

test("isolates browsing-context targets and events across same-workspace client pairs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-contexts-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  const socket = join(directory, "outliner.sock");
  const server = new OutlinerServer(store, socket);
  await server.start();
  const first = store.create("First context target");
  const second = store.create("Second context target");
  const client = new OutlinerClient(socket);
  const firstConnected = Promise.withResolvers<void>();
  const secondConnected = Promise.withResolvers<void>();
  const firstReceived = Promise.withResolvers<void>();
  const secondReceived = Promise.withResolvers<void>();
  const firstEvents: OutlinerEvent[] = [];
  const secondEvents: OutlinerEvent[] = [];
  const firstWatcher = client.watch({
    client: { clientId: "detail-first", role: "detail", contextId: "context-first" },
    onConnect: firstConnected.resolve,
    onEvent: (event) => {
      firstEvents.push(event);
      if (event.domain === "ui") firstReceived.resolve();
    },
  });
  const secondWatcher = client.watch({
    client: { clientId: "detail-second", role: "detail", contextId: "context-second" },
    onConnect: secondConnected.resolve,
    onEvent: (event) => {
      if (event.domain !== "ui") return;
      secondEvents.push(event);
      secondReceived.resolve();
    },
  });
  cleanups.push(async () => {
    await Promise.all([firstWatcher.stop(), secondWatcher.stop()]);
    await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  await Promise.all([firstConnected.promise, secondConnected.promise]);
  await client.request({
    action: "browsing-context.publish",
    sourceClientId: "detail-first",
    contextId: "context-first",
    blockId: first.id,
  });
  await firstReceived.promise;
  await Bun.sleep(20);
  expect(firstEvents).toEqual([
    expect.objectContaining({
      domain: "browsing-context",
      contextId: "context-first",
      blockId: first.id,
    }),
    expect.objectContaining({
      domain: "ui",
      blockId: first.id,
      command: expect.objectContaining({
        targetClientId: "detail-first",
        command: "preview",
      }),
    }),
  ]);
  expect(secondEvents).toEqual([]);

  await client.request({
    action: "browsing-context.publish",
    sourceClientId: "detail-second",
    contextId: "context-second",
    blockId: second.id,
  });
  await secondReceived.promise;
  const firstContext = await client.request<{
    contextId: string;
    target: SelectionContext;
  }>({ action: "browsing-context.get", contextId: "context-first" });
  const secondContext = await client.request<{
    contextId: string;
    target: SelectionContext;
  }>({ action: "browsing-context.get", contextId: "context-second" });
  expect(firstContext.target.selected?.id).toBe(first.id);
  expect(secondContext.target.selected?.id).toBe(second.id);

  store.delete(first.id);
  store.purge(first.id, first.id.slice(0, 8));
  const purgedContext = await client.request<{
    contextId: string;
    target: SelectionContext;
  }>({ action: "browsing-context.get", contextId: "context-first" });
  expect(purgedContext.target).toEqual({ selected: null, ancestors: [], children: [] });
});

test("prunes destroyed client registrations before listing or targeting", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-destroyed-client-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  const server = new OutlinerServer(store, join(directory, "outliner.sock"));
  const sequence = store.sequence;
  const socket = new Socket();
  socket.destroy();
  const subscribers = (server as unknown as {
    subscribers: Map<Socket, OutlinerClientRegistration>;
  }).subscribers;
  subscribers.set(socket, { clientId: "destroyed-tree", role: "tree", contextId: "destroyed-tree" });

  expect(server.handle({ id: "list", action: "clients.list" })).toEqual({
    id: "list",
    ok: true,
    result: [],
    sequence,
  });
  expect(server.handle({
    id: "focus",
    action: "ui.command.send",
    command: { targetClientId: "destroyed-tree", command: "focus" },
  })).toEqual({
    id: "focus",
    ok: false,
    error: "Target client is not registered: destroyed-tree",
    sequence,
  });

  store.close();
  rmSync(directory, { recursive: true, force: true });
});

test("validates direct popup commands and targets only the invoking Detail", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-popup-commands-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  const target = store.create("Backlink target");
  const source = store.create(`Backlink source ((${target.id}))`);
  const socket = join(directory, "outliner.sock");
  const server = new OutlinerServer(store, socket);
  await server.start();
  const client = new OutlinerClient(socket);
  const connected = Promise.withResolvers<void>();
  const received = Promise.withResolvers<void>();
  const replaced = Promise.withResolvers<void>();
  const events: OutlinerEvent[] = [];
  let connectionCount = 0;
  const registrations: OutlinerClientRegistration[] = [
    {
      clientId: "popup-detail",
      role: "detail",
      contextId: "popup-context",
      locked: false,
      runtime: { paneId: "detail-pane", workspaceId: "workspace", tabId: "tab" },
    },
    {
      clientId: "popup-tree",
      role: "tree",
      contextId: "tree-context",
      runtime: { paneId: "tree-pane", workspaceId: "workspace", tabId: "tab" },
    },
  ];
  const watchers = registrations.map((registration) =>
    new OutlinerClient(socket).watch({
      client: registration,
      onConnect: () => {
        connectionCount += 1;
        if (connectionCount === registrations.length) connected.resolve();
      },
      onEvent: (event) => {
        if (registration.clientId !== "popup-detail" || event.domain !== "ui") return;
        events.push(event);
        if (events.length === 2) received.resolve();
        if (events.length === 3) replaced.resolve();
      },
    })
  );
  cleanups.push(async () => {
    await Promise.all(watchers.map((watcher) => watcher.stop()));
    await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await connected.promise;

  for (const invalid of ["false", null]) {
    await expect(client.request({
      action: "browsing-context.publish",
      sourceClientId: "popup-detail",
      contextId: `invalid-dispatch-${String(invalid)}`,
      blockId: source.id,
      dispatchPreview: invalid,
    } as never)).rejects.toThrow("Browsing context dispatchPreview must be boolean");
  }

  const seeded = await client.request<BrowsingContextPublication>({
    action: "browsing-context.publish",
    sourceClientId: "popup-detail",
    contextId: "seeded-detail-context",
    blockId: source.id,
    dispatchPreview: false,
  });
  expect(seeded).toEqual({
    contextId: "seeded-detail-context",
    target: store.blockContext(source.id),
  });
  expect(await client.request<{ contextId: string; target: SelectionContext }>({
    action: "browsing-context.get",
    contextId: "seeded-detail-context",
  })).toEqual({
    contextId: "seeded-detail-context",
    target: store.blockContext(source.id),
  });

  await client.request({
    action: "ui.command.send",
    command: { targetClientId: "popup-detail", command: "open", blockId: source.id },
  });
  await client.request({
    action: "ui.command.send",
    command: {
      targetClientId: "popup-detail",
      command: "backlinks.select",
      targetBlockId: target.id,
      sourceBlockId: source.id,
    },
  });
  await received.promise;
  expect(events.map((event) => event.command)).toEqual([
    { targetClientId: "popup-detail", command: "open", blockId: source.id },
    {
      targetClientId: "popup-detail",
      command: "backlinks.select",
      targetBlockId: target.id,
      sourceBlockId: source.id,
    },
  ]);
  expect(events[1]?.blockId).toBe(target.id);

  await expect(client.request({
    action: "ui.command.send",
    command: { targetClientId: "popup-tree", command: "open", blockId: source.id },
  })).rejects.toThrow("Direct open target must be a Detail client");
  await expect(client.request({
    action: "ui.command.send",
    command: {
      targetClientId: "popup-tree",
      command: "backlinks.select",
      targetBlockId: target.id,
      sourceBlockId: source.id,
    },
  })).rejects.toThrow("Backlink selection target must be a Detail client");
  await expect(client.request({
    action: "ui.command.send",
    command: { targetClientId: "popup-detail", command: "open", blockId: "missing-block" },
  })).rejects.toThrow("Block not found: missing-block");
  await expect(client.request({
    action: "ui.command.send",
    command: {
      targetClientId: "popup-detail",
      command: "backlinks.select",
      targetBlockId: target.id,
    } as never,
  })).rejects.toThrow("Backlink selection requires target and source block IDs");

  await client.request({
    action: "clients.update",
    clientId: "popup-detail",
    locked: true,
  });
  await expect(client.request({
    action: "ui.command.send",
    command: { targetClientId: "popup-detail", command: "open", blockId: source.id },
  })).rejects.toThrow("Invoking Detail is locked");
  await client.request({
    action: "ui.command.send",
    command: { targetClientId: "popup-detail", command: "replace", blockId: source.id },
  });
  await replaced.promise;
  expect(events[2]?.command).toEqual({
    targetClientId: "popup-detail",
    command: "replace",
    blockId: source.id,
  });
});

test("registers multiple live clients, targets one recipient, broadcasts content, and cleans up exact connections", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-clients-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  const socket = join(directory, "outliner.sock");
  const server = new OutlinerServer(store, socket);
  await server.start();
  const client = new OutlinerClient(socket);
  const registrations = [
    { clientId: "tree-a", role: "tree" as const, contextId: "tree-a", runtime: { paneId: "pane-tree-a", workspaceId: "workspace-a", tabId: "tab-a" } },
    { clientId: "tree-b", role: "tree" as const, contextId: "tree-b", runtime: { paneId: "pane-tree-b", workspaceId: "workspace-b", tabId: "tab-b" } },
    { clientId: "detail-a", role: "detail" as const, contextId: "detail-a", locked: false, runtime: { paneId: "pane-detail-a", workspaceId: "workspace-a", tabId: "tab-a" } },
    { clientId: "detail-b", role: "detail" as const, contextId: "detail-b", locked: false, runtime: { paneId: "pane-detail-b", workspaceId: "workspace-b", tabId: "tab-b" } },
  ];
  const events = new Map(registrations.map(({ clientId }) => [clientId, [] as OutlinerEvent[]]));
  const connected = Promise.withResolvers<void>();
  const targeted = Promise.withResolvers<void>();
  const broadcastReceived = Promise.withResolvers<void>();
  let broadcastCount = 0;
  let connectionCount = 0;
  const watchers = registrations.map((registration) =>
    new OutlinerClient(socket).watch({
      client: registration,
      onConnect: () => {
        connectionCount += 1;
        if (connectionCount === registrations.length) connected.resolve();
      },
      onEvent: (event) => {
        events.get(registration.clientId)!.push(event);
        if (event.domain === "content") {
          broadcastCount += 1;
          if (broadcastCount === registrations.length) broadcastReceived.resolve();
        }
        if (registration.clientId === "detail-b" && event.domain === "ui") {
          targeted.resolve();
        }
      },
    })
  );
  cleanups.push(async () => {
    await Promise.all(watchers.map((watcher) => watcher.stop()));
    await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  await connected.promise;
  expect(await client.request<OutlinerClientRegistration[]>({ action: "clients.list" })).toEqual([
    registrations[2],
    registrations[3],
    registrations[0],
    registrations[1],
  ]);
  expect(await client.request<OutlinerClientRegistration[]>({ action: "clients.list", role: "tree" })).toEqual([
    registrations[0],
    registrations[1],
  ]);
  expect(await client.request<{ subscribed: boolean; client: OutlinerClientRegistration }>({
    action: "events.subscribe",
    client: { clientId: " normalized-client ", role: "detail", contextId: " normalized-client ", locked: false, runtime: {} },
  })).toEqual({
    subscribed: true,
    client: { clientId: "normalized-client", role: "detail", contextId: "normalized-client", locked: false },
  });
  await expect(client.request({
    action: "clients.list",
    role: "unknown" as never,
  })).rejects.toThrow("Invalid client role: unknown");
  await expect(client.request({
    action: "events.subscribe",
    client: registrations[0],
  })).rejects.toThrow("Client ID is already registered: tree-a");
  const correlatedResponse = Promise.withResolvers<OutlinerResponse>();
  const duplicateSocket = createConnection(socket);
  duplicateSocket.setEncoding("utf8");
  duplicateSocket.once("error", correlatedResponse.reject);
  duplicateSocket.once("connect", () => {
    duplicateSocket.write(`${JSON.stringify({
      id: "duplicate-registration",
      action: "events.subscribe",
      client: registrations[0],
    })}\n`);
  });
  duplicateSocket.once("data", (line) => {
    correlatedResponse.resolve(JSON.parse(String(line)) as OutlinerResponse);
    duplicateSocket.end();
  });
  expect(await correlatedResponse.promise).toMatchObject({
    id: "duplicate-registration",
    ok: false,
    error: "Client ID is already registered: tree-a",
  });
  await expect(client.request({
    action: "events.subscribe",
    client: { clientId: "invalid-runtime", role: "tree", contextId: "invalid-runtime", runtime: { obsoletePaneState: "pane" } } as unknown as OutlinerClientRegistration,
  })).rejects.toThrow("Invalid client runtime obsoletePaneState");
  await expect(client.request({
    action: "ui.command.send",
    command: { targetClientId: "missing-client", command: "focus" },
  })).rejects.toThrow("Target client is not registered: missing-client");

  await client.request({ action: "create", text: "Broadcast to every live client" });
  await broadcastReceived.promise;
  await client.request({
    action: "ui.command.send",
    command: { targetClientId: "detail-b", command: "edit", blockId: "target-block" },
  });
  await targeted.promise;
  expect(registrations.map(({ clientId }) =>
    events.get(clientId)!.filter((event) => event.domain === "ui").length
  )).toEqual([0, 0, 0, 1]);

  await watchers[0]!.stop();
  const replacementConnected = Promise.withResolvers<void>();
  const replacementEvents: OutlinerEvent[] = [];
  const replacementReceived = Promise.withResolvers<void>();
  const replacement = new OutlinerClient(socket).watch({
    client: { clientId: "tree-a-restarted", role: "tree", contextId: "tree-a-restarted", runtime: { paneId: "pane-tree-a-next", workspaceId: "workspace-a", tabId: "tab-a" } },
    onConnect: replacementConnected.resolve,
    onEvent: (event) => {
      replacementEvents.push(event);
      if (event.domain === "content") replacementReceived.resolve();
    },
  });
  watchers.push(replacement);
  await replacementConnected.promise;
  const clientsAfterRestart = await client.request<Array<{ clientId: string }>>({
    action: "clients.list",
  });
  expect(clientsAfterRestart.some(({ clientId }) => clientId === "tree-a")).toBe(false);
  expect(clientsAfterRestart).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ clientId: "tree-a-restarted" }),
      expect.objectContaining({ clientId: "tree-b" }),
      expect.objectContaining({ clientId: "detail-a" }),
      expect.objectContaining({ clientId: "detail-b" }),
    ]),
  );
  await client.request({ action: "create", text: "Broadcast after client restart" });
  await replacementReceived.promise;
});

test("watchers reconnect and resubscribe after the service restarts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-reconnect-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  const socket = join(directory, "outliner.sock");
  const server = new OutlinerServer(store, socket);
  await server.start();
  let running = true;
  let connectionCount = 0;
  const firstConnection = Promise.withResolvers<void>();
  const disconnected = Promise.withResolvers<void>();
  const reconnected = Promise.withResolvers<void>();
  const watcher = new OutlinerClient(socket).watch({
    client: { clientId: "reconnecting-tree", role: "tree", contextId: "reconnecting-tree" },
    onConnect: () => {
      connectionCount += 1;
      if (connectionCount === 1) firstConnection.resolve();
      if (connectionCount === 2) reconnected.resolve();
    },
    onDisconnect: disconnected.resolve,
    onEvent: () => {},
  });
  cleanups.push(async () => {
    await watcher.stop();
    if (running) await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  await firstConnection.promise;
  await server.close();
  running = false;
  await disconnected.promise;
  await server.start();
  running = true;
  await reconnected.promise;

  expect(connectionCount).toBe(2);
});

test("watchers reconnect when a subscription is not acknowledged", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-stuck-subscription-"));
  const socketPath = join(directory, "outliner.sock");
  let connectionCount = 0;
  const reconnected = Promise.withResolvers<void>();
  const server = createServer((socket) => {
    const connectionNumber = ++connectionCount;
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0 || connectionNumber === 1) return;
      const request = JSON.parse(buffer.slice(0, newline)) as OutlinerRequest;
      socket.write(`${JSON.stringify({ id: request.id, ok: true, result: { subscribed: true } })}\n`);
    });
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(socketPath, listening.resolve);
  await listening.promise;

  const watcher = new OutlinerClient(socketPath).watch({
    client: { clientId: "ack-tree", role: "tree", contextId: "ack-tree" },
    onConnect: reconnected.resolve,
    onEvent: () => {},
  });
  cleanups.push(async () => {
    await watcher.stop();
    const closed = Promise.withResolvers<void>();
    server.close((error) => (error ? closed.reject(error) : closed.resolve()));
    await closed.promise;
    rmSync(directory, { recursive: true, force: true });
  });

  await reconnected.promise;

  expect(connectionCount).toBe(2);
}, 6_000);

test("stopping a connected watcher does not report a disconnect", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-stop-watcher-"));
  const socketPath = join(directory, "outliner.sock");
  const connected = Promise.withResolvers<void>();
  const connectionClosed = Promise.withResolvers<void>();
  let disconnectCount = 0;
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.once("close", connectionClosed.resolve);
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline)) as OutlinerRequest;
      socket.write(`${JSON.stringify({ id: request.id, ok: true, result: { subscribed: true } })}\n`);
    });
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(socketPath, listening.resolve);
  await listening.promise;

  const watcher = new OutlinerClient(socketPath).watch({
    client: { clientId: "stop-tree", role: "tree", contextId: "stop-tree" },
    onConnect: connected.resolve,
    onDisconnect: () => {
      disconnectCount += 1;
    },
    onEvent: () => {},
  });
  cleanups.push(async () => {
    await watcher.stop();
    const closed = Promise.withResolvers<void>();
    server.close((error) => (error ? closed.reject(error) : closed.resolve()));
    await closed.promise;
    rmSync(directory, { recursive: true, force: true });
  });

  await connected.promise;
  await watcher.stop();
  await connectionClosed.promise;

  expect(disconnectCount).toBe(0);
});

test("routes previews and opens to the first spatially unlocked Detail", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-routes-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  const target = store.create("Navigation target\n\n## Decision ^durable-decision");
  const socket = join(directory, "outliner.sock");
  const server = new OutlinerServer(store, socket);
  await server.start();

  const registrations: OutlinerClientRegistration[] = [
    { clientId: "tree-a", role: "tree", contextId: "context-a", runtime: { workspaceId: "ws", tabId: "tab-1", paneId: "pane-a", paneX: 0, paneY: 0 } },
    { clientId: "tree-b", role: "tree", contextId: "context-b", runtime: { workspaceId: "ws", tabId: "tab-1", paneId: "pane-b", paneX: 0, paneY: 20 } },
    { clientId: "detail-c", role: "detail", contextId: "context-a", locked: false, runtime: { workspaceId: "ws", tabId: "tab-1", paneId: "pane-c", paneX: 40, paneY: 0 } },
    { clientId: "detail-d", role: "detail", contextId: "context-d", locked: false, runtime: { workspaceId: "ws", tabId: "tab-1", paneId: "pane-d", paneX: 80, paneY: 0 } },
    { clientId: "tree-oi", role: "tree", contextId: "context-oi", runtime: { workspaceId: "ws", tabId: "tab-oi", paneId: "pane-oi-tree", paneX: 0, paneY: 0 } },
    { clientId: "detail-oi", role: "detail", contextId: "context-oi", locked: false, runtime: { workspaceId: "ws", tabId: "tab-oi", paneId: "pane-oi-detail", paneX: 40, paneY: 0 } },
  ];
  const connected = registrations.map(() => Promise.withResolvers<void>());
  const received = new Map<string, OutlinerEvent[]>();
  const pendingCommands: Array<{
    clientId: string;
    command: NonNullable<OutlinerEvent["command"]>["command"];
    resolve: (event: OutlinerEvent) => void;
  }> = [];
  const nextCommand = (
    clientId: string,
    command: NonNullable<OutlinerEvent["command"]>["command"],
  ): Promise<OutlinerEvent> => {
    const received = Promise.withResolvers<OutlinerEvent>();
    pendingCommands.push({ clientId, command, resolve: received.resolve });
    return received.promise;
  };
  const watchers = registrations.map((registration, index) =>
    new OutlinerClient(socket).watch({
      client: registration,
      onConnect: connected[index]!.resolve,
      onEvent: (event) => {
        const events = received.get(registration.clientId) ?? [];
        events.push(event);
        received.set(registration.clientId, events);
        const pendingIndex = pendingCommands.findIndex((pending) =>
          pending.clientId === registration.clientId &&
          event.domain === "ui" &&
          event.command?.command === pending.command
        );
        if (pendingIndex !== -1) pendingCommands.splice(pendingIndex, 1)[0]!.resolve(event);
      },
    })
  );
  cleanups.push(async () => {
    for (const watcher of watchers) await watcher.stop();
    await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await Promise.all(connected.map(({ promise }) => promise));
  const client = new OutlinerClient(socket);

  const launchClients = await client.request<OutlinerClientRegistration[]>({
    action: "clients.list",
  });
  expect(launchClients.find(({ clientId }) => clientId === "tree-a")?.runtime)
    .toEqual(registrations[0]!.runtime);

  const firstOpenReceived = nextCommand("detail-c", "open");
  const firstOpen = await client.request<OutlinerNavigationDispatch>({
    action: "navigation.dispatch",
    sourceClientId: "tree-a",
    blockId: target.id,
    intent: "open",
  });
  await firstOpenReceived;
  expect(firstOpen).toMatchObject({
    targetClientId: "detail-c",
    resolution: "unlocked",
    command: { targetClientId: "detail-c", command: "open", blockId: target.id },
  });
  const fragmentOpenReceived = nextCommand("detail-c", "open");
  const fragmentOpen = await client.request<OutlinerNavigationDispatch>({
    action: "navigation.dispatch",
    sourceClientId: "tree-a",
    blockId: target.id,
    fragmentId: "durable-decision",
    intent: "open",
  });
  await fragmentOpenReceived;
  expect(fragmentOpen.command).toEqual({
    targetClientId: "detail-c",
    command: "open",
    blockId: target.id,
    fragmentId: "durable-decision",
  });
  await expect(client.request({
    action: "navigation.dispatch",
    sourceClientId: "tree-a",
    blockId: target.id,
    fragmentId: "stale-decision",
    intent: "open",
  })).rejects.toThrow(`Fragment not found: ${target.id}^stale-decision`);

  const sourcePreservingOpenReceived = nextCommand("detail-d", "open");
  const sourcePreservingOpen = await client.request<OutlinerNavigationDispatch>({
    action: "navigation.dispatch",
    sourceClientId: "detail-c",
    blockId: target.id,
    intent: "open",
    preserveSource: true,
  });
  await sourcePreservingOpenReceived;
  expect(sourcePreservingOpen).toMatchObject({
    sourceClientId: "detail-c",
    targetClientId: "detail-d",
    resolution: "unlocked",
  });

  await client.request({
    action: "clients.update",
    clientId: "detail-c",
    locked: true,
    currentBlockId: target.id,
  });
  expect(
    (await client.request<OutlinerClientRegistration[]>({ action: "clients.list" }))
      .find(({ clientId }) => clientId === "detail-c"),
  ).toMatchObject({ locked: true, currentBlockId: target.id });
  const nextOpenReceived = nextCommand("detail-d", "open");
  const nextOpen = await client.request<OutlinerNavigationDispatch>({
    action: "navigation.dispatch",
    sourceClientId: "detail-c",
    blockId: target.id,
    intent: "open",
  });
  await nextOpenReceived;
  expect(nextOpen).toMatchObject({
    targetClientId: "detail-d",
    resolution: "unlocked",
  });

  const previewReceived = nextCommand("detail-d", "preview");
  const published = await client.request<BrowsingContextPublication>({
    action: "browsing-context.publish",
    sourceClientId: "tree-a",
    contextId: "context-a",
    blockId: target.id,
  });
  await previewReceived;
  expect(published.preview).toMatchObject({
    targetClientId: "detail-d",
    command: { targetClientId: "detail-d", command: "preview", blockId: target.id },
  });

  const otherTabOpenReceived = nextCommand("detail-oi", "open");
  const otherTab = await client.request<OutlinerNavigationDispatch>({
    action: "navigation.dispatch",
    sourceClientId: "tree-oi",
    blockId: target.id,
    intent: "open",
  });
  await otherTabOpenReceived;
  expect(otherTab.targetClientId).toBe("detail-oi");

  const revealReceived = nextCommand("tree-a", "reveal");
  const reveal = await client.request<OutlinerNavigationDispatch>({
    action: "navigation.dispatch",
    sourceClientId: "tree-a",
    blockId: target.id,
    intent: "reveal",
  });
  await revealReceived;
  expect(reveal).toMatchObject({
    targetClientId: "tree-a",
    resolution: "self",
  });

  await client.request({ action: "clients.update", clientId: "detail-d", locked: true });
  await expect(client.request({
    action: "navigation.dispatch",
    sourceClientId: "tree-b",
    blockId: target.id,
    intent: "open",
  })).rejects.toThrow("All Details in this tab are locked · unlock one or open another Detail");
  await expect(client.request({
    action: "navigation.dispatch",
    sourceClientId: "detail-c",
    blockId: target.id,
    intent: "open",
    preserveSource: true,
  })).rejects.toThrow(
    "No other unlocked Detail is available · unlock one or open another Detail",
  );

  expect(pendingCommands).toEqual([]);
  expect(received.get("detail-c")?.some((event) => event.command?.command === "open")).toBe(true);
  expect(received.get("detail-d")?.some((event) => event.command?.command === "open")).toBe(true);
  expect(received.get("detail-d")?.some((event) => event.command?.command === "preview")).toBe(true);
  expect(received.get("detail-oi")?.some((event) => event.command?.command === "open")).toBe(true);
});

test("reconciles long-lived clients against live Herdr pane topology", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-live-topology-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  const socket = join(directory, "outliner.sock");
  const registry = new HerdrRuntimeRegistry();
  const replaceTopology = (panes: Array<{
    paneId: string;
    terminalId: string;
    workspaceId: string;
    tabId: string;
    x?: number;
    y?: number;
  }>): void => {
    const tabs = [...new Map(panes.map((pane) => [
      pane.tabId,
      { tab_id: pane.tabId, workspace_id: pane.workspaceId },
    ])).values()];
    const workspaces = [...new Map(tabs.map((tab) => [
      tab.workspace_id,
      { workspace_id: tab.workspace_id, active_tab_id: tab.tab_id },
    ])).values()];
    registry.replaceSnapshot({
      version: "test",
      protocol: 1,
      workspaces,
      tabs,
      panes: panes.map((pane) => ({
        pane_id: pane.paneId,
        terminal_id: pane.terminalId,
        workspace_id: pane.workspaceId,
        tab_id: pane.tabId,
      })),
      layouts: tabs.map((tab) => {
        const tabPanes = panes.filter((pane) => pane.tabId === tab.tab_id);
        return {
          workspace_id: tab.workspace_id,
          tab_id: tab.tab_id,
          focused_pane_id: tabPanes[0]!.paneId,
          panes: tabPanes.map((pane) => ({
            pane_id: pane.paneId,
            ...(pane.x !== undefined && pane.y !== undefined
              ? { rect: { x: pane.x, y: pane.y } }
              : {}),
          })),
        };
      }),
      agents: [],
    } satisfies HerdrSessionSnapshot);
  };
  const server = new OutlinerServer(store, socket, registry);
  await server.start();

  const registrations: OutlinerClientRegistration[] = [
    {
      clientId: "tree-live",
      role: "tree",
      contextId: "live",
      runtime: {
        paneId: "tree-pane-at-launch",
        terminalId: "term-tree",
        workspaceId: "ws-at-launch",
        tabId: "tab-at-launch",
        paneX: 900,
        paneY: 900,
      },
    },
    {
      clientId: "detail-a-live",
      role: "detail",
      contextId: "live",
      locked: false,
      runtime: {
        paneId: "detail-a-at-launch",
        terminalId: "term-a",
        workspaceId: "ws-at-launch",
        tabId: "tab-at-launch",
        paneX: 900,
        paneY: 900,
      },
    },
    {
      clientId: "detail-b-live",
      role: "detail",
      contextId: "detail-b-independent",
      locked: false,
      runtime: {
        paneId: "detail-b-at-launch",
        terminalId: "term-b",
        workspaceId: "ws-at-launch",
        tabId: "tab-at-launch",
        paneX: 900,
        paneY: 900,
      },
    },
    {
      clientId: "detail-unresolved",
      role: "detail",
      contextId: "unresolved",
      locked: false,
      runtime: {
        paneId: "fallback-pane",
        terminalId: "term-not-live",
        workspaceId: "fallback-workspace",
        tabId: "fallback-tab",
        paneX: 12,
        paneY: 34,
      },
    },
  ];
  const connected = registrations.map(() => Promise.withResolvers<void>());
  let connectionCount = 0;
  const watchers = registrations.map((registration, index) =>
    new OutlinerClient(socket).watch({
      client: registration,
      onConnect: () => {
        connectionCount += 1;
        connected[index]!.resolve();
      },
      onEvent: () => {},
    })
  );
  cleanups.push(async () => {
    await Promise.all(watchers.map((watcher) => watcher.stop()));
    await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await Promise.all(connected.map(({ promise }) => promise));
  const client = new OutlinerClient(socket);

  const unavailableClients = await client.request<OutlinerClientRegistration[]>({
    action: "clients.list",
  });
  expect(unavailableClients.find(({ clientId }) => clientId === "tree-live")?.runtime)
    .toEqual({ terminalId: "term-tree" });
  await expect(client.request({
    action: "navigation.resolve",
    sourceClientId: "tree-live",
    intent: "open",
  })).rejects.toThrow("No Detail is available in this tab · open another Detail");

  replaceTopology([
    { paneId: "tree-pane-old", terminalId: "term-tree", workspaceId: "ws-old", tabId: "tab-old", x: 0, y: 0 },
    { paneId: "detail-a-old", terminalId: "term-a", workspaceId: "ws-old", tabId: "tab-old", x: 40, y: 0 },
    { paneId: "detail-b-old", terminalId: "term-b", workspaceId: "ws-old", tabId: "tab-old", x: 80, y: 0 },
  ]);

  const initialClients = await client.request<OutlinerClientRegistration[]>({
    action: "clients.list",
  });
  expect(initialClients.find(({ clientId }) => clientId === "tree-live")?.runtime).toEqual({
    paneId: "tree-pane-old",
    terminalId: "term-tree",
    workspaceId: "ws-old",
    tabId: "tab-old",
    paneX: 0,
    paneY: 0,
  });
  expect(initialClients.find(({ clientId }) => clientId === "detail-unresolved")?.runtime)
    .toEqual({ terminalId: "term-not-live" });
  expect(await client.request<OutlinerNavigationDispatch>({
    action: "navigation.resolve",
    sourceClientId: "tree-live",
    intent: "open",
  })).toMatchObject({ targetClientId: "detail-a-live" });
  expect(await client.request<OutlinerNavigationDispatch>({
    action: "navigation.resolve",
    sourceClientId: "detail-b-live",
    intent: "reveal",
  })).toMatchObject({
    targetClientId: "tree-live",
    resolution: "same-tab",
  });

  registry.markStale();
  const staleClients = await client.request<OutlinerClientRegistration[]>({
    action: "clients.list",
  });
  expect(staleClients.find(({ clientId }) => clientId === "tree-live")?.runtime)
    .toEqual({ terminalId: "term-tree" });
  await expect(client.request({
    action: "navigation.resolve",
    sourceClientId: "tree-live",
    intent: "open",
  })).rejects.toThrow("No Detail is available in this tab · open another Detail");

  replaceTopology([
    { paneId: "tree-pane-renamed", terminalId: "term-tree", workspaceId: "ws-new", tabId: "tab-new", x: 0, y: 0 },
    { paneId: "detail-b-renamed", terminalId: "term-b", workspaceId: "ws-new", tabId: "tab-new", x: 30, y: 0 },
    { paneId: "detail-a-renamed", terminalId: "term-a", workspaceId: "ws-old", tabId: "tab-old", x: 10, y: 0 },
  ]);
  const movedClients = await client.request<OutlinerClientRegistration[]>({
    action: "clients.list",
  });
  expect(movedClients.find(({ clientId }) => clientId === "tree-live")?.runtime).toEqual({
    paneId: "tree-pane-renamed",
    terminalId: "term-tree",
    workspaceId: "ws-new",
    tabId: "tab-new",
    paneX: 0,
    paneY: 0,
  });
  expect(await client.request<OutlinerNavigationDispatch>({
    action: "navigation.resolve",
    sourceClientId: "tree-live",
    intent: "open",
  })).toMatchObject({ targetClientId: "detail-b-live" });

  replaceTopology([
    { paneId: "tree-pane-final", terminalId: "term-tree", workspaceId: "ws-new", tabId: "tab-new" },
    { paneId: "detail-b-final", terminalId: "term-b", workspaceId: "ws-new", tabId: "tab-new", x: 80, y: 0 },
    { paneId: "detail-a-final", terminalId: "term-a", workspaceId: "ws-new", tabId: "tab-new", x: 20, y: 0 },
  ]);
  const reorderedClients = await client.request<OutlinerClientRegistration[]>({
    action: "clients.list",
  });
  expect(reorderedClients.find(({ clientId }) => clientId === "tree-live")?.runtime).toEqual({
    paneId: "tree-pane-final",
    terminalId: "term-tree",
    workspaceId: "ws-new",
    tabId: "tab-new",
  });
  expect(await client.request<OutlinerNavigationDispatch>({
    action: "navigation.resolve",
    sourceClientId: "tree-live",
    intent: "open",
  })).toMatchObject({ targetClientId: "detail-a-live" });

  replaceTopology([
    { paneId: "tree-pane-only", terminalId: "term-tree", workspaceId: "ws-new", tabId: "tab-new", x: 0, y: 0 },
  ]);
  const vanishedClients = await client.request<OutlinerClientRegistration[]>({
    action: "clients.list",
  });
  expect(vanishedClients.find(({ clientId }) => clientId === "detail-a-live")?.runtime)
    .toEqual({ terminalId: "term-a" });
  expect(vanishedClients.find(({ clientId }) => clientId === "detail-b-live")?.runtime)
    .toEqual({ terminalId: "term-b" });
  await expect(client.request({
    action: "navigation.resolve",
    sourceClientId: "tree-live",
    intent: "open",
  })).rejects.toThrow("No Detail is available in this tab · open another Detail");
  await expect(client.request({
    action: "navigation.resolve",
    sourceClientId: "detail-a-live",
    intent: "reveal",
  })).rejects.toThrow("No Tree destination is available in this pane's context or tab");
  expect(connectionCount).toBe(registrations.length);
});
