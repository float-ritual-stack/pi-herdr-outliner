import { createConnection, type Socket } from "node:net";
import type { OutlinerEvent, OutlinerEventEnvelope, OutlinerRequest, OutlinerResponse } from "./types";

export type RequestInput = OutlinerRequest extends infer Request
  ? Request extends { id: string }
    ? Omit<Request, "id">
    : never
  : never;

export interface OutlinerWatchHandlers {
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
  ) {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer ?? undefined);
    this.retryTimer = null;
    this.socket?.destroy();
    this.socket = null;
  }

  private connect(): void {
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
      const request: OutlinerRequest = { id: subscriptionId, action: "events.subscribe" };
      socket.write(`${JSON.stringify(request)}\n`);
      acknowledgementTimer = setTimeout(() => {
        socket.destroy(new Error("Outliner subscription was not acknowledged"));
      }, 3_000);
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
    socket.once("error", (error) => this.reportError(error));
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

export class OutlinerClient {
  constructor(readonly socketPath: string) {}

  request<T>(input: RequestInput, timeoutMs = 3000): Promise<T> {
    const request = { ...input, id: crypto.randomUUID() } as OutlinerRequest;
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
    };
    socket.setEncoding("utf8");
    socket.once("error", fail);
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timeout);
      socket.end();
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as OutlinerResponse;
        if (!response.ok) responseReceived.reject(new Error(response.error));
        else responseReceived.resolve(response.result as T);
      } catch (error) {
        responseReceived.reject(error);
      }
    });
    return responseReceived.promise;
  }

  watch(handlers: OutlinerWatchHandlers): OutlinerWatcher {
    return new OutlinerWatcher(this.socketPath, handlers);
  }
}
