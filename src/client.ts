import { createConnection, type Socket } from "node:net";
import { requireCapabilities } from "./service-compatibility";
import type { OutlinerCapability, OutlinerRequestProblem, OutlinerServiceStatus } from "./types";
import type {
  OutlinerClientRegistration,
  OutlinerEvent,
  OutlinerEventEnvelope,
  OutlinerRequest,
  OutlinerResponse,
} from "./types";

export type RequestInput = OutlinerRequest extends infer Request
  ? Request extends { id: string }
    ? Omit<Request, "id">
    : never
  : never;

const LOCAL_REQUEST_TIMEOUT_MS = 3_000;
const REMOTE_REQUEST_TIMEOUT_MS = 30_000;

export interface OutlinerClientEndpoint {
  socket: string;
  mode: "local" | "remote" | "host";
  /** The outline every request names; the socket must be an outline host. */
  outline?: string;
  /** Host mode without an outline (`resolveFolderOutline` rule 4): why none is named. */
  unnamed?: string;
}

export function createOutlinerClient(endpoint: OutlinerClientEndpoint): OutlinerClient {
  return new OutlinerClient(
    endpoint.socket,
    endpoint.mode === "remote" ? REMOTE_REQUEST_TIMEOUT_MS : LOCAL_REQUEST_TIMEOUT_MS,
    endpoint.outline,
    // On the host, a client without a name would reach the default outline: refuse instead.
    endpoint.mode === "host" && !endpoint.outline ? endpoint.unnamed ?? "No outline is named for this folder" : undefined,
  );
}

/**
 * A service that does not advertise `request.outline` ignores the field, so a
 * client that names an outline refuses it rather than read the wrong outline.
 */
export function requireOutlineRouting(service: OutlinerServiceStatus, socketPath: string, outline: string): void {
  if (!service.capabilities?.includes("request.outline")) {
    throw new Error(`The Outliner service at ${socketPath} serves one outline and cannot route to the outline "${outline}" (no request.outline capability). Start the outline host, or unset OUTLINER_OUTLINE / the folder's outline binding.`);
  }
  if (service.outline?.name !== undefined && service.outline.name !== outline) {
    throw new Error(`The outline host at ${socketPath} answered for "${service.outline.name}", not "${outline}"`);
  }
}

export interface OutlinerWatchHandlers {
  client: OutlinerClientRegistration;
  onConnect?: () => void | Promise<void>;
  onDisconnect?: () => void;
  onEvent: (event: OutlinerEvent) => void | Promise<void>;
  onError?: (error: Error) => void;
}

export class OutlinerWatcher {
  private socket: Socket | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private retryDelayMs = 250;

  constructor(
    private readonly socketPath: string,
    private readonly handlers: OutlinerWatchHandlers,
    private readonly acknowledgementTimeoutMs = LOCAL_REQUEST_TIMEOUT_MS,
    /** Names the outline on the subscribe line; `verify` confirms the service routes by it first. */
    private readonly outline?: string,
    private readonly verify?: () => Promise<void>,
  ) {
    this.connect();
  }

  stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retryTimer ?? undefined);
    this.retryTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (!socket) return Promise.resolve();
    const closed = Promise.withResolvers<void>();
    socket.once("close", () => closed.resolve());
    socket.destroy();
    return closed.promise;
  }

  private connect(): void {
    if (this.stopped) return;
    if (this.verify) {
      this.verify().then(() => this.open(), error => {
        this.reportError(error);
        this.scheduleReconnect();
      });
      return;
    }
    this.open();
  }

  private open(): void {
    if (this.stopped) return;
    const socket = createConnection(this.socketPath);
    this.socket = socket;
    socket.setEncoding("utf8");
    let buffer = "";
    let subscribed = false;
    const subscriptionId = crypto.randomUUID();
    let acknowledgementTimer: Timer | null = null;

    function clearAcknowledgementTimer(): void {
      clearTimeout(acknowledgementTimer ?? undefined);
      acknowledgementTimer = null;
    }

    socket.once("connect", () => {
      const request: OutlinerRequest = {
        id: subscriptionId,
        action: "events.subscribe",
        // A pane registers the outline it is on, so Herdr actions invoked from it use that outline.
        client: this.outline ? { ...this.handlers.client, outline: this.outline } : this.handlers.client,
      };
      if (this.outline) (request as { outline?: string }).outline = this.outline;
      socket.write(`${JSON.stringify(request)}\n`);
      acknowledgementTimer = setTimeout(() => {
        socket.destroy(new Error("Outliner subscription was not acknowledged"));
      }, this.acknowledgementTimeoutMs);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;

        try {
          const message = JSON.parse(line) as OutlinerEventEnvelope | OutlinerResponse;
          if ("event" in message) {
            this.invoke(() => this.handlers.onEvent(message.event));
          } else if (message.id === subscriptionId) {
            if (!message.ok) {
              socket.destroy(new Error(message.error));
              continue;
            }
            subscribed = true;
            clearAcknowledgementTimer();
            this.retryDelayMs = 250;
            if (this.handlers.onConnect) this.invoke(this.handlers.onConnect);
          }
        } catch (error) {
          this.reportError(error);
        }
      }
    });
    socket.on("error", (error) => this.reportError(error));
    socket.once("close", () => {
      clearAcknowledgementTimer();
      if (this.socket === socket) this.socket = null;
      if (subscribed && !this.stopped) this.handlers.onDisconnect?.();
      this.scheduleReconnect();
    });
  }

  private invoke(callback: () => void | Promise<void>): void {
    Promise.resolve()
      .then(callback)
      .catch((error) => this.reportError(error));
  }

  private reportError(error: unknown): void {
    this.handlers.onError?.(error instanceof Error ? error : new Error(String(error)));
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retryTimer) return;
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(2_000, this.retryDelayMs * 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }
}

/** A service-rejected request; `problem` carries structured detail when the service provides it. */
export class OutlinerRequestError extends Error {
  constructor(message: string, readonly problem?: OutlinerRequestProblem) {
    super(message);
    this.name = "OutlinerRequestError";
  }
}

export class OutlinerClient {
  private routingChecked: Promise<void> | undefined;

  constructor(
    readonly socketPath: string,
    private readonly requestTimeoutMs = LOCAL_REQUEST_TIMEOUT_MS,
    /** Every request names this outline; the service must be an outline host that routes by it. */
    readonly outline?: string,
    /** Set when no outline could be named: every request and subscription fails with it. */
    readonly refusal?: string,
  ) {}

  /** Rejects a service that is too old or lacks a capability the caller will use. */
  async requireCompatibleService(needed: readonly OutlinerCapability[] = []): Promise<OutlinerServiceStatus> {
    const service = await this.request<OutlinerServiceStatus>({ action: "ping" });
    requireCapabilities(service, needed);
    return service;
  }

  /**
   * With an outline, the first request confirms by ping that the service routes
   * by name (`request.outline`); every request then carries `outline`. A ping
   * is itself checked on its answer.
   */
  async request<T>(input: RequestInput, timeoutMs = this.requestTimeoutMs): Promise<T> {
    if (this.refusal) throw new Error(this.refusal);
    if (!this.outline) return this.send<T>(input, timeoutMs);
    if (input.action === "ping") {
      const status = await this.send<OutlinerServiceStatus>(input, timeoutMs);
      requireOutlineRouting(status, this.socketPath, this.outline);
      this.routingChecked ??= Promise.resolve();
      return status as T;
    }
    await this.checkRouting(timeoutMs);
    return this.send<T>(input, timeoutMs);
  }

  private checkRouting(timeoutMs = this.requestTimeoutMs): Promise<void> {
    if (this.refusal) return Promise.reject(new Error(this.refusal));
    if (!this.outline) return Promise.resolve();
    const outline = this.outline;
    this.routingChecked ??= this.send<OutlinerServiceStatus>({ action: "ping" }, timeoutMs)
      .then(status => requireOutlineRouting(status, this.socketPath, outline))
      .catch(error => {
        // A service that was down may come back as the host; ask again next time.
        this.routingChecked = undefined;
        throw error;
      });
    return this.routingChecked;
  }

  private send<T>(input: RequestInput, timeoutMs: number): Promise<T> {
    const request = { ...input, id: crypto.randomUUID(), ...(this.outline ? { outline: this.outline } : {}) } as OutlinerRequest;
    const responseReceived = Promise.withResolvers<T>();
    const socket = createConnection(this.socketPath);
    let buffer = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      responseReceived.reject(new Error(`Outliner request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const fail = (error: Error): void => {
      clearTimeout(timeout);
      responseReceived.reject(error);
      // A failed request never reuses its connection; close it so neither side waits on a half-open socket.
      socket.destroy();
    };
    socket.setEncoding("utf8");
    socket.on("error", fail);
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timeout);
      // One request per connection: the answer is in, so close outright rather than half-close.
      socket.destroy();
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as OutlinerResponse;
        if (!response.ok) responseReceived.reject(new OutlinerRequestError(response.error, response.problem));
        else responseReceived.resolve(response.result as T);
      } catch (error) {
        responseReceived.reject(error);
      }
    });
    return responseReceived.promise;
  }

  watch(handlers: OutlinerWatchHandlers): OutlinerWatcher {
    return new OutlinerWatcher(this.socketPath, handlers, this.requestTimeoutMs, this.outline,
      this.outline || this.refusal ? () => this.checkRouting() : undefined);
  }
}
