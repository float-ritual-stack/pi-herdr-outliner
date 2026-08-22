import { createConnection } from "node:net";
import type { Duplex } from "node:stream";
import { HerdrRuntimeRegistry, type HerdrSessionSnapshot } from "./herdr-registry";

const HERDR_PROTOCOL = 20;
const STRUCTURAL_SUBSCRIPTIONS = [
  "workspace.created",
  "workspace.updated",
  "workspace.metadata_updated",
  "workspace.renamed",
  "workspace.moved",
  "workspace.reordered",
  "workspace.closed",
  "workspace.focused",
  "tab.created",
  "tab.closed",
  "tab.focused",
  "tab.renamed",
  "tab.moved",
  "pane.created",
  "pane.closed",
  "pane.updated",
  "pane.focused",
  "pane.moved",
  "pane.exited",
  "pane.agent_detected",
  "layout.updated",
] as const;

export type HerdrSocketFactory = (
  path: string,
  onSocket?: (socket: Duplex) => void,
) => Promise<Duplex>;

const socketHandoffErrorListeners = new WeakMap<Duplex, (error: Error) => void>();

export interface HerdrRegistryRunnerOptions {
  socketFactory?: HerdrSocketFactory;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  ackTimeoutMs?: number;
  replayQuietMs?: number;
  replayMaxMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  diagnostic?: (record: Record<string, unknown>) => void;
}

interface WireRecord {
  [key: string]: unknown;
}

function isRecord(value: unknown): value is WireRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultSocketFactory(
  path: string,
  onSocket?: (socket: Duplex) => void,
): Promise<Duplex> {
  const { promise, resolve, reject } = Promise.withResolvers<Duplex>();
  const socket = createConnection(path);
  const onError = (error: Error): void => reject(error);
  socket.once("error", onError);
  socketHandoffErrorListeners.set(socket, onError);
  onSocket?.(socket);
  socket.once("connect", () => resolve(socket));
  return promise;
}

class MessageQueue {
  private values: unknown[] = [];
  private waiters: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }> = [];
  private failure: Error | null = null;

  push(value: unknown): void {
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.values.push(value);
    else waiter.resolve(value);
  }

  fail(error: Error): void {
    if (this.failure !== null) return;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  next(timeoutMs: number, label: string): Promise<unknown> {
    if (this.values.length > 0) return Promise.resolve(this.values.shift());
    if (this.failure !== null) return Promise.reject(this.failure);
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const waiter = { resolve, reject };
    this.waiters.push(waiter);
    const timeout = setTimeout(() => {
      const index = this.waiters.indexOf(waiter);
      if (index !== -1) this.waiters.splice(index, 1);
      reject(new Error(`${label} timeout`));
    }, timeoutMs);
    waiter.resolve = (value) => {
      clearTimeout(timeout);
      resolve(value);
    };
    waiter.reject = (error) => {
      clearTimeout(timeout);
      reject(error);
    };
    return promise;
  }
  async discardUntilQuiet(quietMs: number, maxMs: number): Promise<void> {
    this.values.length = 0;
    if (quietMs <= 0) return;
    const deadline = Date.now() + maxMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Herdr retained event replay did not settle");
      try {
        await this.next(Math.min(quietMs, remaining), "Herdr retained event replay");
        this.values.length = 0;
      } catch (error) {
        if (error instanceof Error && error.message === "Herdr retained event replay timeout") return;
        throw error;
      }
    }
  }
}

class NdjsonConnection {
  readonly messages = new MessageQueue();
  private buffer = "";

  constructor(readonly socket: Duplex) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.accept(chunk));
    socket.once("end", () => this.end("Herdr subscription EOF"));
    socket.once("close", () => this.end("Herdr socket closed"));
    socket.once("error", (error) => this.messages.fail(error));
  }

  send(value: unknown): void {
    this.socket.write(`${JSON.stringify(value)}\n`);
  }

  destroy(): void {
    this.socket.destroy();
  }

  private accept(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length === 0) continue;
      try {
        this.messages.push(JSON.parse(line));
      } catch {
        this.messages.fail(new Error("malformed Herdr NDJSON"));
        this.destroy();
        return;
      }
    }
  }

  private end(message: string): void {
    if (this.buffer.trim().length > 0) this.messages.fail(new Error("truncated Herdr NDJSON"));
    else this.messages.fail(new Error(message));
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  const timeout = setTimeout(done, ms);
  function done(): void {
    clearTimeout(timeout);
    signal.removeEventListener("abort", done);
    resolve();
  }
  signal.addEventListener("abort", done, { once: true });
  return promise;
}

export class HerdrRegistryRunner {
  private readonly socketFactory: HerdrSocketFactory;
  private readonly requestTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly ackTimeoutMs: number;
  private readonly replayQuietMs: number;
  private readonly replayMaxMs: number;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly diagnostic: (record: Record<string, unknown>) => void;
  private readonly abort = new AbortController();
  private readonly active = new Set<NdjsonConnection>();
  private task: Promise<void> | null = null;
  private requestNumber = 0;

  constructor(
    readonly registry: HerdrRuntimeRegistry,
    readonly socketPath: string,
    options: HerdrRegistryRunnerOptions = {},
  ) {
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 1_000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 1_000;
    this.ackTimeoutMs = options.ackTimeoutMs ?? 1_000;
    this.replayQuietMs = options.replayQuietMs ?? 250;
    this.replayMaxMs = options.replayMaxMs ?? 60_000;
    this.minBackoffMs = options.minBackoffMs ?? 250;
    this.maxBackoffMs = options.maxBackoffMs ?? 2_000;
    this.diagnostic = options.diagnostic ?? ((record) => console.log(JSON.stringify(record)));
  }

  start(): void {
    if (this.task !== null) return;
    this.task = this.run();
  }

  async stop(): Promise<void> {
    this.abort.abort();
    for (const connection of this.active) this.close(connection);
    if (this.task !== null) await this.task;
  }

  private async run(): Promise<void> {
    let backoffMs = this.minBackoffMs;
    while (!this.abort.signal.aborted) {
      try {
        await this.connectCycle();
        backoffMs = this.minBackoffMs;
      } catch (error) {
        if (this.abort.signal.aborted) break;
        this.registry.markStale();
        this.diagnostic({
          status: "herdr_registry_stale",
          generation: this.registry.generation,
          reason: error instanceof Error ? error.message : String(error),
          retry_ms: backoffMs,
        });
        for (const connection of this.active) this.close(connection);
        await sleep(backoffMs, this.abort.signal);
        backoffMs = Math.min(this.maxBackoffMs, backoffMs * 2);
      }
    }
  }

  private async connectCycle(): Promise<void> {
    const pong = await this.request("ping");
    if (pong.type !== "pong" || pong.protocol !== HERDR_PROTOCOL) {
      throw new Error("incompatible Herdr protocol");
    }

    const initialSnapshot = await this.snapshot();
    const subscription = await this.subscribe(initialSnapshot);
    try {
      await subscription.messages.discardUntilQuiet(this.replayQuietMs, this.replayMaxMs);
      if (this.abort.signal.aborted) return;
      const settledSnapshot = await this.snapshot();
      const subscribedPaneIds = new Set(initialSnapshot.panes.map((pane) => pane.pane_id));
      if (
        settledSnapshot.panes.length !== subscribedPaneIds.size ||
        settledSnapshot.panes.some((pane) => !subscribedPaneIds.has(pane.pane_id))
      ) {
        throw new Error("Herdr pane topology changed while settling");
      }
      this.registry.replaceSnapshot(settledSnapshot);
      this.diagnostic({
        status: "herdr_registry_ready",
        generation: this.registry.generation,
        workspaces: this.registry.workspaces.size,
        tabs: this.registry.tabs.size,
        panes: this.registry.panes.size,
        agents: this.registry.agents.size,
      });

      while (!this.abort.signal.aborted) {
        const message = await subscription.messages.next(2_147_483_647, "Herdr event");
        const result = this.registry.applyEvent(message);
        if (result.kind === "resync") throw new Error(`Herdr registry resync: ${result.reason}`);
        if (result.topologyChanged) throw new Error("Herdr pane topology changed");
      }
    } finally {
      this.close(subscription);
    }
  }

  private async snapshot(): Promise<HerdrSessionSnapshot> {
    const result = await this.request("session.snapshot");
    if (result.type !== "session_snapshot" || !isRecord(result.snapshot)) {
      throw new Error("invalid Herdr snapshot response");
    }
    return result.snapshot as unknown as HerdrSessionSnapshot;
  }

  private async request(method: "ping" | "session.snapshot"): Promise<WireRecord> {
    const connection = await this.open();
    const id = this.nextId(method);
    try {
      connection.send({ id, method, params: {} });
      const message = await connection.messages.next(this.requestTimeoutMs, `${method} response`);
      if (!isRecord(message) || message.id !== id) throw new Error(`invalid ${method} correlation`);
      if (isRecord(message.error)) throw new Error(`Herdr ${method} failed`);
      if (!isRecord(message.result)) throw new Error(`invalid ${method} response`);
      return message.result;
    } finally {
      this.close(connection);
    }
  }

  private async subscribe(snapshot: HerdrSessionSnapshot): Promise<NdjsonConnection> {
    const connection = await this.open();
    const id = this.nextId("events.subscribe");
    const subscriptions = [
      ...STRUCTURAL_SUBSCRIPTIONS.map((type) => ({ type })),
      ...snapshot.panes.map((pane) => ({ type: "pane.agent_status_changed", pane_id: pane.pane_id })),
    ];
    connection.send({ id, method: "events.subscribe", params: { subscriptions } });
    try {
      const deadline = Date.now() + this.ackTimeoutMs;
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("events.subscribe ACK timeout");
        const message = await connection.messages.next(remaining, "events.subscribe ACK");
        if (isRecord(message) && message.id === id) {
          if (isRecord(message.error)) throw new Error("Herdr events.subscribe failed");
          if (isRecord(message.result) && message.result.type === "subscription_started") return connection;
          throw new Error("invalid Herdr subscription ACK");
        }
      }
    } catch (error) {
      this.close(connection);
      throw error;
    }
  }

  private async open(): Promise<NdjsonConnection> {
    if (this.abort.signal.aborted) throw new Error("Herdr runner stopped");
    let discardPendingSocket = false;
    let connectingSocket: Duplex | null = null;
    let pendingSocketError: Error | null = null;
    let captureError: ((error: Error) => void) | null = null;
    const captureSocket = (socket: Duplex): void => {
      if (connectingSocket === socket) return;
      connectingSocket = socket;
      captureError = (error): void => {
        pendingSocketError ??= error;
      };
      socket.on("error", captureError);
      if (discardPendingSocket || this.abort.signal.aborted) socket.destroy();
    };
    const pendingSocket = this.socketFactory(this.socketPath, captureSocket).then((socket) => {
      captureSocket(socket);
      return socket;
    });
    const interrupted = Promise.withResolvers<never>();
    const interrupt = (error: Error): void => {
      discardPendingSocket = true;
      interrupted.reject(error);
    };
    const onAbort = (): void => interrupt(new Error("Herdr runner stopped"));
    const timeout = setTimeout(
      () => interrupt(new Error("Herdr connect timeout")),
      this.connectTimeoutMs,
    );
    this.abort.signal.addEventListener("abort", onAbort, { once: true });
    void pendingSocket.catch(() => {});
    try {
      const socket = await Promise.race([pendingSocket, interrupted.promise]);
      const connection = new NdjsonConnection(socket);
      const factoryErrorListener = socketHandoffErrorListeners.get(socket);
      if (factoryErrorListener !== undefined) {
        socket.off("error", factoryErrorListener);
        socketHandoffErrorListeners.delete(socket);
      }
      if (captureError !== null) socket.off("error", captureError);
      if (pendingSocketError !== null) connection.messages.fail(pendingSocketError);
      this.active.add(connection);
      return connection;
    } finally {
      clearTimeout(timeout);
      this.abort.signal.removeEventListener("abort", onAbort);
    }
  }

  private close(connection: NdjsonConnection): void {
    connection.destroy();
    this.active.delete(connection);
  }

  private nextId(label: string): string {
    this.requestNumber += 1;
    return `pi-outliner:${label}:${this.requestNumber}`;
  }
}
