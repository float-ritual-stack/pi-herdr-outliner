import { createConnection, createServer, type Socket } from "node:net";

export interface ForwardedRequest {
  action: string;
  blockId?: string;
  requestBytes: number;
  responseBytes: number;
  elapsedMs: number;
  observationParseMs: number;
  ok: boolean;
}

// The private Tree connects through this socket unchanged. Observe the existing
// newline protocol; forward subscription events without turning them into RPCs.
export async function forwardService(socketPath: string, upstreamPath: string) {
  const sockets = new Set<Socket>();
  const requests: ForwardedRequest[] = [];
  const errors: string[] = [];
  const server = createServer(downstream => {
    const upstream = createConnection(upstreamPath);
    const pending = new Map<string, { action: string; blockId?: string; bytes: number; started: number }>();
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
      pending.set(request.id, { action: request.action, blockId: request.blockId, bytes: Buffer.byteLength(line) + 1, started: performance.now() });
    });
    observe(upstream, line => {
      const started = performance.now();
      const response = JSON.parse(line);
      const observationParseMs = performance.now() - started;
      const request = pending.get(response.id);
      if (!request) return;
      pending.delete(response.id);
      requests.push({
        action: request.action,
        ...(request.blockId ? { blockId: request.blockId } : {}),
        requestBytes: request.bytes,
        responseBytes: Buffer.byteLength(line) + 1,
        elapsedMs: performance.now() - request.started,
        observationParseMs,
        ok: response.ok === true,
      });
    });
    downstream.pipe(upstream).pipe(downstream);
    downstream.on("close", () => upstream.destroy());
    upstream.on("close", () => downstream.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    socketPath,
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
