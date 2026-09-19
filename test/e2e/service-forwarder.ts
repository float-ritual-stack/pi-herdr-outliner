import { createConnection, createServer, type Socket } from "node:net";

export interface ForwardedRequest {
  action: string;
  blockId?: string;
  requestBytes: number;
  responseBytes: number;
  elapsedMs: number;
  observationParseMs: number;
  ok: boolean;
  held?: boolean;
  injectedError?: string;
}

export interface OptionalResponseMatch {
  action: "references.resolve" | "annotations.reconcile";
  contains: string;
}

export interface ResponseBarrier {
  readonly state: "armed" | "requested" | "held" | "released";
  readonly received: Promise<void>;
  release(error?: string): void;
}

// Private clients use the existing newline protocol. Only explicitly armed
// optional-read replies can be held; subscription events always pass through.
export async function forwardService(socketPath: string, upstreamPath: string) {
  const sockets = new Set<Socket>();
  const requests: ForwardedRequest[] = [];
  const errors: string[] = [];
  const barriers: Array<{
    match: OptionalResponseMatch;
    state: ResponseBarrier["state"];
    deliver: ((error?: string) => void) | null;
    received: ReturnType<typeof Promise.withResolvers<void>>;
  }> = [];
  const server = createServer(downstream => {
    const upstream = createConnection(upstreamPath);
    const pending = new Map<string, { action: string; blockId?: string; bytes: number; started: number; barrier?: typeof barriers[number] }>();
    for (const socket of [downstream, upstream]) {
      sockets.add(socket);
      socket.on("close", () => { sockets.delete(socket); });
      socket.on("error", () => { downstream.destroy(); upstream.destroy(); });
      socket.setEncoding("utf8");
    }
    const observe = (socket: Socket, receive: (line: string) => void) => {
      let buffer = "";
      socket.on("data", (chunk: string) => {
        try {
          buffer += chunk;
          if (buffer.length > 64 * 1024 * 1024) throw new Error("Forwarded frame exceeded 64 MiB");
          let newline: number;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            receive(line);
          }
        } catch (error) {
          errors.push(String(error));
          downstream.destroy();
          upstream.destroy();
        }
      });
    };
    observe(downstream, line => {
      const request = JSON.parse(line);
      if (pending.size >= 100 || requests.length >= 20_000) throw new Error("Forwarder evidence budget exceeded");
      const barrier = barriers.find(candidate => candidate.state === "armed" &&
        candidate.match.action === request.action && line.includes(candidate.match.contains));
      if (barrier) barrier.state = "requested";
      pending.set(request.id, { action: request.action, blockId: request.blockId, bytes: Buffer.byteLength(line) + 1, started: performance.now(), barrier });
    });
    observe(upstream, line => {
      const started = performance.now();
      const response = JSON.parse(line);
      const observationParseMs = performance.now() - started;
      const request = pending.get(response.id);
      if (!request) {
        downstream.write(`${line}\n`);
        return;
      }
      pending.delete(response.id);
      const deliver = (error?: string) => {
        const delivered = error === undefined ? line : JSON.stringify({ id: response.id, ok: false, error });
        requests.push({
          action: request.action,
          ...(request.blockId ? { blockId: request.blockId } : {}),
          requestBytes: request.bytes,
          responseBytes: Buffer.byteLength(delivered) + 1,
          elapsedMs: performance.now() - request.started,
          observationParseMs,
          ok: error === undefined && response.ok === true,
          ...(request.barrier ? { held: true } : {}),
          ...(error === undefined ? {} : { injectedError: error }),
        });
        if (!downstream.destroyed) downstream.write(`${delivered}\n`);
      };
      if (request.barrier) {
        request.barrier.state = "held";
        request.barrier.deliver = deliver;
        request.barrier.received.resolve();
      } else deliver();
    });
    downstream.pipe(upstream);
    downstream.on("close", () => upstream.destroy());
    upstream.on("close", () => downstream.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    socketPath,
    holdNext(match: OptionalResponseMatch): ResponseBarrier {
      if (!match.contains || barriers.length >= 16) throw new Error("Invalid or excessive response barriers");
      const barrier: typeof barriers[number] = { match, state: "armed", deliver: null, received: Promise.withResolvers<void>() };
      barriers.push(barrier);
      return {
        get state() { return barrier.state; },
        received: barrier.received.promise,
        release(error) {
          if (!barrier.deliver || barrier.state !== "held") throw new Error("Response barrier has no held reply");
          barrier.deliver(error);
          barrier.deliver = null;
          barrier.state = "released";
        },
      };
    },
    measurements(): readonly ForwardedRequest[] {
      if (errors.length) throw new Error(errors.join("; "));
      return requests.map(request => ({ ...request }));
    },
    async close(): Promise<void> {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
