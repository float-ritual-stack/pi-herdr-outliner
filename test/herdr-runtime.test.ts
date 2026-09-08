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
    version: "0.9.0", protocol: 22,
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

test("runner accepts compatible JSON discovery across numbered protocol changes", async () => {
  const registry = new HerdrRuntimeRegistry();
  let subscription: FakeSocket | null = null;
  const factory: HerdrSocketFactory = async () => new FakeSocket((request, socket) => {
    if (request.method === "ping") {
      const line = `${JSON.stringify(response(request, {
        type: "pong", version: "future", protocol: 99, extra: { supported: true },
      }))}\n`;
      socket.send(line.slice(0, 9), line.slice(9));
    } else if (request.method === "session.snapshot") {
      socket.sendJson(response(request, {
        type: "session_snapshot",
        snapshot: { ...snapshot("one"), version: "future", protocol: 99, extra: true },
      }));
    } else {
      subscription = socket;
      const line = `${JSON.stringify(response(request, { type: "subscription_started" }))}\n`;
      socket.send(line.slice(0, 5), line.slice(5, 17), line.slice(17));
    }
  });
  const runner = new HerdrRegistryRunner(registry, "fake", {
    socketFactory: factory,
    diagnostic: (record) => {
      if (record.status === "herdr_registry_ready") subscription?.send(
        `${JSON.stringify({ event: "pane_focused", data: { type: "pane_focused", pane_id: "p-one", workspace_id: "w-one" } })}\n` +
        `${JSON.stringify({ event: "pane.agent_status_changed", data: { pane_id: "p-one", workspace_id: "w-one", agent_status: "working", agent: "claude" } })}\n`,
      );
    },
  });
  runner.start();
  try {
    await flushUntil(() => registry.panes.get("p-one")?.agent_status === "working");
    expect(registry.phase).toBe("ready");
    expect(registry.paneIdForTerminal("term-one")).toBe("p-one");
    expect(registry.focusedPaneId).toBe("p-one");
    expect(registry.agents.get("term-one")?.agent_status).toBe("working");
  } finally {
    await runner.stop();
  }
});

test("events buffered during the authoritative snapshot are applied before discovery is ready", async () => {
  const registry = new HerdrRuntimeRegistry();
  const initial = snapshot("buffered");
  let subscription: FakeSocket | null = null;
  let snapshotRequests = 0;
  let statusAtReady: unknown;
  const factory: HerdrSocketFactory = async () => new FakeSocket((request, socket) => {
    if (request.method === "ping") {
      socket.sendJson(response(request, { type: "pong", version: "0.9.0", protocol: 22 }));
    } else if (request.method === "session.snapshot") {
      snapshotRequests += 1;
      if (snapshotRequests === 2) {
        if (!subscription) throw new Error("authoritative snapshot preceded subscription ACK");
        subscription.sendJson({
          event: "pane_updated",
          data: {
            type: "pane_updated",
            pane: { ...initial.panes[0]!, label: "Updated while snapshot was in flight" },
          },
        });
        subscription.sendJson({
          event: "pane.agent_status_changed",
          data: { pane_id: "p-buffered", workspace_id: "w-buffered", agent_status: "working" },
        });
      }
      socket.sendJson(response(request, { type: "session_snapshot", snapshot: initial }));
    } else {
      subscription = socket;
      socket.sendJson(response(request, { type: "subscription_started" }));
    }
  });
  const runner = new HerdrRegistryRunner(registry, "fake", {
    socketFactory: factory,
    diagnostic: (record) => {
      if (record.status === "herdr_registry_ready") {
        statusAtReady = registry.panes.get("p-buffered")?.agent_status;
      }
    },
  });
  runner.start();
  try {
    await flushUntil(() => statusAtReady !== undefined);
    expect(statusAtReady).toBe("working");
    expect(registry.panes.get("p-buffered")?.label).toBe("Updated while snapshot was in flight");
  } finally {
    await runner.stop();
  }
});

test("panes added during bootstrap receive subsequent agent-status updates", async () => {
  const registry = new HerdrRuntimeRegistry();
  const initial = snapshot("bootstrap");
  const addedPane = { ...initial.panes[0]!, pane_id: "p-added", terminal_id: "term-added" };
  const expanded: HerdrSessionSnapshot = {
    ...initial,
    panes: [...initial.panes, addedPane],
    layouts: [{ ...initial.layouts[0]!, panes: [...initial.layouts[0]!.panes, { pane_id: addedPane.pane_id }] }],
  };
  let snapshotRequests = 0;
  let subscription: FakeSocket | null = null;
  let watchesAddedPane = false;
  const factory: HerdrSocketFactory = async () => new FakeSocket((request, socket) => {
    if (request.method === "ping") {
      socket.sendJson(response(request, { type: "pong", version: "0.9.0", protocol: 22 }));
    } else if (request.method === "session.snapshot") {
      socket.sendJson(response(request, {
        type: "session_snapshot",
        snapshot: ++snapshotRequests === 1 ? initial : expanded,
      }));
    } else {
      subscription = socket;
      const params = request.params as { subscriptions: Array<{ type: string; pane_id?: string }> };
      watchesAddedPane = params.subscriptions.some(
        (item) => item.type === "pane.agent_status_changed" && item.pane_id === addedPane.pane_id,
      );
      socket.sendJson(response(request, { type: "subscription_started" }));
    }
  });
  const runner = new HerdrRegistryRunner(registry, "fake", {
    socketFactory: factory,
    diagnostic: (record) => {
      if (record.status === "herdr_registry_ready" && watchesAddedPane) subscription?.sendJson({
        event: "pane.agent_status_changed",
        data: { pane_id: addedPane.pane_id, workspace_id: addedPane.workspace_id, agent_status: "working" },
      });
    },
  });
  runner.start();
  try {
    await flushUntil(() => registry.panes.get(addedPane.pane_id)?.agent_status === "working");
    expect(registry.paneIdForTerminal(addedPane.terminal_id)).toBe(addedPane.pane_id);
    expect(registry.phase).toBe("ready");
  } finally {
    await runner.stop();
  }
});

test("topology changes resubscribe without making the validated registry unavailable", async () => {
  const registry = new HerdrRuntimeRegistry();
  const initial = snapshot("topology");
  const addedPane = {
    ...initial.panes[0]!,
    pane_id: "p-topology-added",
    terminal_id: "term-topology-added",
  };
  const expanded: HerdrSessionSnapshot = {
    ...initial,
    panes: [...initial.panes, addedPane],
    layouts: [{
      ...initial.layouts[0]!,
      panes: [...initial.layouts[0]!.panes, { pane_id: addedPane.pane_id }],
    }],
  };
  const resubscribed = Promise.withResolvers<void>();
  const diagnostics: Record<string, unknown>[] = [];
  let topologyChanged = false;
  let subscriptions = 0;
  let firstSubscription: FakeSocket | null = null;
  const factory: HerdrSocketFactory = async () => new FakeSocket((request, socket) => {
    if (request.method === "ping") {
      socket.sendJson(response(request, { type: "pong", version: "0.8.2", protocol: 20 }));
    } else if (request.method === "session.snapshot") {
      socket.sendJson(response(request, {
        type: "session_snapshot",
        snapshot: topologyChanged ? expanded : initial,
      }));
    } else {
      subscriptions += 1;
      socket.sendJson(response(request, { type: "subscription_started" }));
      firstSubscription ??= socket;
    }
  });
  const runner = new HerdrRegistryRunner(registry, "fake", {
    socketFactory: factory,
    minBackoffMs: 10_000,
    diagnostic: (record) => {
      diagnostics.push(record);
      if (record.status !== "herdr_registry_ready") return;
      if (record.generation === 1) {
        topologyChanged = true;
        firstSubscription?.sendJson({
          event: "pane_created",
          data: { type: "pane_created", pane: addedPane },
        });
      } else if (record.generation === 2) {
        resubscribed.resolve();
      }
    },
  });

  runner.start();
  await resubscribed.promise;
  expect(subscriptions).toBe(2);
  expect(diagnostics.some((record) => record.status === "herdr_registry_stale")).toBe(false);
  expect(registry.phase).toBe("ready");
  expect(registry.paneIdForTerminal(addedPane.terminal_id)).toBe(addedPane.pane_id);
  await runner.stop();
});

test("focus-only discovery follows live focus without per-pane status subscriptions", async () => {
  const registry = new HerdrRuntimeRegistry();
  const initial = snapshot("focus");
  initial.panes.push({ ...initial.panes[0]!, pane_id: "p-other", terminal_id: "term-other" });
  initial.layouts[0]!.panes.push({ pane_id: "p-other" });
  let subscription: FakeSocket | null = null;
  const factory: HerdrSocketFactory = async () => new FakeSocket((request, socket) => {
    if (request.method === "ping") {
      socket.sendJson(response(request, { type: "pong", version: "0.9.0", protocol: 22 }));
    } else if (request.method === "session.snapshot") {
      socket.sendJson(response(request, { type: "session_snapshot", snapshot: initial }));
    } else {
      subscription = socket;
      socket.sendJson(response(request, { type: "subscription_started" }));
    }
  });
  const runner = new HerdrRegistryRunner(registry, "fake", {
    socketFactory: factory,
    eventTypes: ["pane.focused"],
    includePaneAgentStatus: false,
    diagnostic: (record) => {
      if (record.status === "herdr_registry_ready") subscription?.sendJson({
        event: "pane_focused",
        data: { type: "pane_focused", pane_id: "p-other", workspace_id: "w-focus" },
      });
    },
  });
  runner.start();
  try {
    await flushUntil(() => registry.focusedPaneId === "p-other");
    expect(registry.recentFocusedPaneIds()).toEqual(["p-other", "p-focus"]);
  } finally {
    await runner.stop();
  }
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
    socketFactory: factory, ackTimeoutMs: 5, minBackoffMs: 1, maxBackoffMs: 2,
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
    socketFactory: factory, minBackoffMs: 1, maxBackoffMs: 2,
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
