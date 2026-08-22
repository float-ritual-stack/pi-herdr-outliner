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
  OutlinerEvent,
  OutlinerRequest,
  PropertyCatalogItem,
  VisibleBlock,
  OutlinerServiceStatus,
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
  const block = await client.request<Block>({
    action: "create",
    text: "Waiting for user [type::question] [status::open]",
    author: "agent",
  });
  const matches = await client.request<VisibleBlock[]>({
    action: "list",
    query: { filters: [{ key: "type", value: "question" }] },
  });

  expect(matches.some((candidate) => candidate.id === block.id)).toBe(true);
  await client.request({ action: "selection.set", blockId: block.id });
  const context = await client.request<{ selected: Block }>({ action: "selection.get" });
  expect(context.selected.id).toBe(block.id);
  const resolved = await client.request<{ text: string }>({
    action: "references.resolve",
    text: `See ((${block.id}))`,
  });
  expect(resolved.text).toBe("See ((Waiting for user))");
  const invalidPatch = server.handle({
    id: "invalid-patch",
    action: "properties.patch",
    blockId: block.id,
    expectedUpdatedAt: block.updatedAt,
    operations: [{ op: "bogus", ordinal: 0 }],
  } as unknown as OutlinerRequest);
  expect(invalidPatch.ok).toBe(false);
  expect(store.require(block.id).text).toBe(block.text);
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
  const client = new OutlinerClient(socket);
  const connected = Promise.withResolvers<void>();
  const received = Promise.withResolvers<void>();
  const events: OutlinerEvent[] = [];
  const watcher = client.watch({
    onConnect: connected.resolve,
    onEvent: (event) => {
      events.push(event);
      if (events.length === 4) received.resolve();
    },
  });
  cleanups.push(async () => {
    watcher.stop();
    await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  await connected.promise;
  const block = await client.request<Block>({ action: "create", text: "Reactive block" });
  await client.request({ action: "selection.set", blockId: block.id });
  await client.request({ action: "view.toggleMultiline", blockId: block.id });
  await client.request({
    action: "ui.command.send",
    command: { target: "detail", command: "edit", blockId: block.id },
  });
  await received.promise;

  expect(events.map((event) => [event.domain, event.action])).toEqual([
    ["content", "create"],
    ["selection", "selection.set"],
    ["view", "view.toggleMultiline"],
    ["ui", "ui.command.send"],
  ]);
  expect(events[0].blockId).toBe(block.id);
  expect(events[3].command).toEqual({ target: "detail", command: "edit", blockId: block.id });

  const children = await client.request<Block[]>({ action: "children", parentId: null });
  expect(children.some((candidate) => candidate.id === block.id)).toBe(true);
  const snapshot = await client.request<WorkspaceSnapshot>({ action: "workspace.snapshot" });
  expect(snapshot.blocks.some((candidate) => candidate.id === block.id)).toBe(true);
  expect(snapshot.selection.selected?.id).toBe(block.id);
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
