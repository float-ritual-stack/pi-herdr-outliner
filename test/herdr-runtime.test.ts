import { expect, test } from "bun:test";
import { Duplex } from "node:stream";
import { HerdrRuntimeRegistry, type HerdrSessionSnapshot } from "../src/herdr-registry";
import { HerdrRegistryRunner, type HerdrSocketFactory } from "../src/herdr-runtime";

class FakeSocket extends Duplex {
  constructor(private readonly receive: (request: Record<string, unknown>, socket: FakeSocket) => void) { super(); }
  _read(): void {}
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try { this.receive(JSON.parse(chunk.toString().trim()), this); callback(); }
    catch (error) { callback(error as Error); }
  }
  send(...parts: string[]): void { for (const part of parts) this.push(part); }
  sendJson(value: unknown): void { this.push(`${JSON.stringify(value)}\n`); }
  eof(): void { this.push(null); }
}

function snapshot(suffix: string): HerdrSessionSnapshot {
  const workspace = `w-${suffix}`, tab = `t-${suffix}`, pane = `p-${suffix}`;
  return {
    version: "0.8.2", protocol: 20,
    focused_workspace_id: workspace, focused_tab_id: tab, focused_pane_id: pane,
    workspaces: [{ workspace_id: workspace, active_tab_id: tab }],
    tabs: [{ tab_id: tab, workspace_id: workspace }],
    panes: [{ pane_id: pane, terminal_id: `term-${suffix}`, workspace_id: workspace, tab_id: tab, agent_status: "idle" }],
    layouts: [{ workspace_id: workspace, tab_id: tab, focused_pane_id: pane, panes: [{ pane_id: pane }] }],
    agents: [],
  };
}

function response(request: Record<string, unknown>, result: unknown): Record<string, unknown> {
  return { id: request.id, result };
}

async function flushUntil(predicate: () => boolean): Promise<void> {
  for (let turn = 0; turn < 100; turn += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("condition was not reached");
}

test("runner parses fragmented and coalesced NDJSON after a settling snapshot", async () => {
  const registry = new HerdrRuntimeRegistry();
  let subscription: FakeSocket | null = null;
  const diagnostics: Record<string, unknown>[] = [];
  const factory: HerdrSocketFactory = async () => new FakeSocket((request, socket) => {
    if (request.method === "ping") {
      const line = `${JSON.stringify(response(request, { type: "pong", version: "0.8.2", protocol: 20 }))}\n`;
      socket.send(line.slice(0, 9), line.slice(9));
    } else if (request.method === "session.snapshot") {
      socket.sendJson(response(request, { type: "session_snapshot", snapshot: snapshot("one") }));
    } else {
      subscription = socket;
      const line = `${JSON.stringify(response(request, { type: "subscription_started" }))}\n`;
      socket.send(line.slice(0, 5), line.slice(5, 17), line.slice(17));
    }
  });
  const runner = new HerdrRegistryRunner(registry, "fake", {
    socketFactory: factory, replayQuietMs: 0,
    diagnostic: (record) => {
      diagnostics.push(record);
      if (record.status === "herdr_registry_ready") subscription?.send(
        `${JSON.stringify({ event: "pane_focused", data: { type: "pane_focused", pane_id: "p-one", workspace_id: "w-one" } })}\n` +
        `${JSON.stringify({ event: "pane.agent_status_changed", data: { pane_id: "p-one", workspace_id: "w-one", agent_status: "working", agent: "claude" } })}\n`,
      );
    },
  });
  runner.start();
  await flushUntil(() => registry.panes.get("p-one")?.agent_status === "working");
  expect(registry.focusedPaneId).toBe("p-one");
  expect(diagnostics.some((record) => record.status === "herdr_registry_ready")).toBe(true);
  await runner.stop();
});

test("runner can subscribe only to pane focus events", async () => {
  const registry = new HerdrRuntimeRegistry();
  const ready = Promise.withResolvers<void>();
  let subscriptionParams: unknown;
  const factory: HerdrSocketFactory = async () => new FakeSocket((request, socket) => {
    if (request.method === "ping") {
      socket.sendJson(response(request, { type: "pong", version: "0.8.2", protocol: 20 }));
    } else if (request.method === "session.snapshot") {
      socket.sendJson(response(request, { type: "session_snapshot", snapshot: snapshot("focus") }));
    } else {
      subscriptionParams = request.params;
      socket.sendJson(response(request, { type: "subscription_started" }));
    }
  });
  const runner = new HerdrRegistryRunner(registry, "fake", {
    socketFactory: factory,
    replayQuietMs: 0,
    eventTypes: ["pane.focused"],
    includePaneAgentStatus: false,
    diagnostic: (record) => {
      if (record.status === "herdr_registry_ready") ready.resolve();
    },
  });

  runner.start();
  await ready.promise;
  expect(subscriptionParams).toEqual({
    subscriptions: [{ type: "pane.focused" }],
  });
  await runner.stop();
});

test("subscription ACK timeout marks stale and reconnects with bounded delay", async () => {
  const registry = new HerdrRuntimeRegistry();
  const ready = Promise.withResolvers<void>();
  let subscriptions = 0;
  const diagnostics: Record<string, unknown>[] = [];
  const factory: HerdrSocketFactory = async () => new FakeSocket((request, socket) => {
    if (request.method === "ping") socket.sendJson(response(request, { type: "pong", version: "0.8.2", protocol: 20 }));
    else if (request.method === "session.snapshot") socket.sendJson(response(request, { type: "session_snapshot", snapshot: snapshot("retry") }));
    else if (++subscriptions > 1) socket.sendJson(response(request, { type: "subscription_started" }));
  });
  const runner = new HerdrRegistryRunner(registry, "fake", {
    socketFactory: factory, ackTimeoutMs: 5, replayQuietMs: 0, minBackoffMs: 1, maxBackoffMs: 2,
    diagnostic: (record) => {
      diagnostics.push(record);
      if (record.status === "herdr_registry_ready") ready.resolve();
    },
  });
  runner.start();
  await ready.promise;
  expect(subscriptions).toBe(2);
  expect(diagnostics.some((record) => record.status === "herdr_registry_stale" && record.retry_ms === 1)).toBe(true);
  await runner.stop();
});

test("EOF reconnect replaces prior registry state from a fresh snapshot", async () => {
  const registry = new HerdrRuntimeRegistry();
  const replaced = Promise.withResolvers<void>();
  let snapshotRequests = 0;
  let firstSubscription: FakeSocket | null = null;
  const factory: HerdrSocketFactory = async () => new FakeSocket((request, socket) => {
    if (request.method === "ping") socket.sendJson(response(request, { type: "pong", version: "0.8.2", protocol: 20 }));
    else if (request.method === "session.snapshot") {
      snapshotRequests += 1;
      socket.sendJson(response(request, { type: "session_snapshot", snapshot: snapshot(snapshotRequests <= 2 ? "old" : "new") }));
    } else {
      socket.sendJson(response(request, { type: "subscription_started" }));
      firstSubscription ??= socket;
    }
  });
  const runner = new HerdrRegistryRunner(registry, "fake", {
    socketFactory: factory, replayQuietMs: 0, minBackoffMs: 1, maxBackoffMs: 2,
    diagnostic: (record) => {
      if (record.status === "herdr_registry_ready" && record.generation === 1) firstSubscription?.eof();
      if (record.status === "herdr_registry_ready" && record.generation === 2) replaced.resolve();
    },
  });
  runner.start();
  await replaced.promise;
  expect([...registry.panes.keys()]).toEqual(["p-new"]);
  expect(registry.paneIdForTerminal("term-old")).toBeUndefined();
  expect(registry.paneIdForTerminal("term-new")).toBe("p-new");
  await runner.stop();
});

test("connect timeout retries without waiting for the socket factory and destroys a late socket", async () => {
  const registry = new HerdrRuntimeRegistry();
  const late = Promise.withResolvers<Duplex>();
  const stale = Promise.withResolvers<void>();
  let attempts = 0;
  const runner = new HerdrRegistryRunner(registry, "fake", {
    socketFactory: async () => {
      attempts += 1;
      return late.promise;
    },
    connectTimeoutMs: 0,
    minBackoffMs: 10_000,
    diagnostic: (record) => {
      if (record.status === "herdr_registry_stale" && record.reason === "Herdr connect timeout") stale.resolve();
    },
  });
  runner.start();
  await stale.promise;
  const socket = new FakeSocket(() => {});
  late.resolve(socket);
  await flushUntil(() => socket.destroyed);
  expect(attempts).toBe(1);
  await runner.stop();
});

test("stop interrupts a pending connect and destroys its socket if it resolves later", async () => {
  const registry = new HerdrRuntimeRegistry();
  const late = Promise.withResolvers<Duplex>();
  const connecting = Promise.withResolvers<void>();
  const runner = new HerdrRegistryRunner(registry, "fake", {
    socketFactory: async () => {
      connecting.resolve();
      return late.promise;
    },
    connectTimeoutMs: 60_000,
  });
  runner.start();
  await connecting.promise;
  await runner.stop();
  const socket = new FakeSocket(() => {});
  late.resolve(socket);
  await flushUntil(() => socket.destroyed);
});

test("socket errors stay handled while ownership passes from the factory to NDJSON", async () => {
  const registry = new HerdrRuntimeRegistry();
  const first = Promise.withResolvers<Duplex>();
  const nextConnect = Promise.withResolvers<void>();
  const never = Promise.withResolvers<Duplex>();
  let connects = 0;
  const diagnostics: Record<string, unknown>[] = [];
  const socket = new FakeSocket(() => {});
  const runner = new HerdrRegistryRunner(registry, "fake", {
    socketFactory: async (_path, onSocket) => {
      connects += 1;
      if (connects === 1) {
        const connected = await first.promise;
        onSocket?.(connected);
        return connected;
      }
      nextConnect.resolve();
      return never.promise;
    },
    connectTimeoutMs: 60_000,
    diagnostic: (record) => {
      diagnostics.push(record);
    },
  });
  runner.start();
  first.resolve(socket);
  queueMicrotask(() => socket.emit("error", new Error("handoff failure")));
  await nextConnect.promise;
  expect(diagnostics).toContainEqual(expect.objectContaining({
    status: "herdr_registry_stale",
    reason: "handoff failure",
  }));
  await runner.stop();
});
