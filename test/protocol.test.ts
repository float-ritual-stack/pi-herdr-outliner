import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutlinerClient } from "../src/client";
import { OutlinerServer } from "../src/server";
import { OutlinerStore } from "../src/store";
import { OUTLINER_PROTOCOL_VERSION } from "../src/types";
import type {
  Block,
  CaptureReceipt,
  OutlinerEvent,
  OutlinerClientRegistration,
  OutlinerRequest,
  NavigationState,
  PageAddressCollection,
  PageAddressFollowResult,
  PageAddressRecord,
  PageAddressResolution,
  PageAddressRemoval,
  OutlinerServiceStatus,
  PropertyCatalogItem,
  VisibleBlockCollection,
  WorkIdAllocation,
  WorkIdAllocatorStatus,
  WorkspaceSnapshot,
} from "../src/types";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
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
  expect(service.protocolVersion).toBe(12);
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
  });
  expect(patched.text).toBe(
    "Waiting for user [type::question] [status::doing]\n[priority::high]",
  );
  const catalog = await client.request<PropertyCatalogItem[]>({
    action: "properties.catalog",
    key: "status",
    prefix: "do",
  });
  expect(catalog).toEqual([{ key: "status", value: "doing", count: 1 }]);
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
    client: { clientId: "event-detail", role: "detail" },
    onConnect: connected.resolve,
    onEvent: (event) => {
      events.push(event);
      if (events.length === 10) received.resolve();
    },
  });
  cleanups.push(async () => {
    watcher.stop();
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
  await client.request({ action: "view.toggleMultiline", blockId: block.id });
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
    ["view", "view.toggleMultiline"],
    ["view", "virtual.occurrences.reorder"],
    ["ui", "ui.command.send"],
  ]);
  expect(events[1].blockId).toBe(block.id);
  expect(events[2].blockId).toBe(capture.block.id);
  expect(events[3].blockId).toBe(block.id);
  expect(events[9].command).toEqual({
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

test("registers multiple live clients, targets one recipient, broadcasts content, and cleans up exact connections", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-clients-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  const socket = join(directory, "outliner.sock");
  const server = new OutlinerServer(store, socket);
  await server.start();
  const client = new OutlinerClient(socket);
  const registrations = [
    {
      clientId: "tree-a",
      role: "tree" as const,
      runtime: { paneId: "pane-tree-a", workspaceId: "workspace-a", tabId: "tab-a" },
    },
    {
      clientId: "tree-b",
      role: "tree" as const,
      runtime: { paneId: "pane-tree-b", workspaceId: "workspace-b", tabId: "tab-b" },
    },
    {
      clientId: "detail-a",
      role: "detail" as const,
      runtime: { paneId: "pane-detail-a", workspaceId: "workspace-a", tabId: "tab-a" },
    },
    {
      clientId: "detail-b",
      role: "detail" as const,
      runtime: { paneId: "pane-detail-b", workspaceId: "workspace-b", tabId: "tab-b" },
    },
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
    client: { clientId: " normalized-client ", role: "detail", runtime: {} },
  })).toEqual({
    subscribed: true,
    client: { clientId: "normalized-client", role: "detail" },
  });
  await expect(client.request({
    action: "clients.list",
    role: "unknown" as never,
  })).rejects.toThrow("Invalid client role: unknown");
  await expect(client.request({
    action: "events.subscribe",
    client: registrations[0],
  })).rejects.toThrow("Client ID is already registered: tree-a");
  await expect(client.request({
    action: "events.subscribe",
    client: {
      clientId: "invalid-runtime",
      role: "tree",
      runtime: { obsoletePaneState: "pane" },
    } as unknown as OutlinerClientRegistration,
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
    client: {
      clientId: "tree-a-restarted",
      role: "tree",
      runtime: { paneId: "pane-tree-a-next", workspaceId: "workspace-a", tabId: "tab-a" },
    },
    onConnect: replacementConnected.resolve,
    onEvent: (event) => {
      replacementEvents.push(event);
      if (event.domain === "content") replacementReceived.resolve();
    },
  });
  watchers.push(replacement);
  await replacementConnected.promise;
  const cleanupDeadline = Date.now() + 1_000;
  let clientsAfterRestart: Array<{ clientId: string }> = [];
  do {
    clientsAfterRestart = await client.request<Array<{ clientId: string }>>({
      action: "clients.list",
    });
    if (!clientsAfterRestart.some(({ clientId }) => clientId === "tree-a")) break;
    await Bun.sleep(10);
  } while (Date.now() < cleanupDeadline);
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
    client: { clientId: "reconnecting-tree", role: "tree" },
    onConnect: () => {
      connectionCount += 1;
      if (connectionCount === 1) firstConnection.resolve();
      if (connectionCount === 2) reconnected.resolve();
    },
    onDisconnect: disconnected.resolve,
    onEvent: () => {},
  });
  cleanups.push(async () => {
    watcher.stop();
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
    client: { clientId: "ack-tree", role: "tree" },
    onConnect: reconnected.resolve,
    onEvent: () => {},
  });
  cleanups.push(async () => {
    watcher.stop();
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
    client: { clientId: "stop-tree", role: "tree" },
    onConnect: connected.resolve,
    onDisconnect: () => {
      disconnectCount += 1;
    },
    onEvent: () => {},
  });
  cleanups.push(async () => {
    watcher.stop();
    const closed = Promise.withResolvers<void>();
    server.close((error) => (error ? closed.reject(error) : closed.resolve()));
    await closed.promise;
    rmSync(directory, { recursive: true, force: true });
  });

  await connected.promise;
  watcher.stop();
  await connectionClosed.promise;

  expect(disconnectCount).toBe(0);
});
