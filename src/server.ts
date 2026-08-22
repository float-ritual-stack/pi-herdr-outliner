import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { OutlinerStore } from "./store";
import type { OutlinerRequest, OutlinerResponse } from "./types";

export class OutlinerServer {
  private server: Server | null = null;

  constructor(
    readonly store: OutlinerStore,
    readonly socketPath: string,
  ) {}

  async start(): Promise<void> {
    mkdirSync(dirname(this.socketPath), { recursive: true });
    if (existsSync(this.socketPath)) {
      if (await this.socketIsActive()) throw new Error(`Outliner service is already running at ${this.socketPath}`);
      unlinkSync(this.socketPath);
    }
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    const started = Promise.withResolvers<void>();
    server.once("error", started.reject);
    server.listen(this.socketPath, () => {
      server.off("error", started.reject);
      started.resolve();
    });
    await started.promise;
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    const closed = Promise.withResolvers<void>();
    server.close((error) => (error ? closed.reject(error) : closed.resolve()));
    await closed.promise;
    this.server = null;
    if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
  }

  private async socketIsActive(): Promise<boolean> {
    const connected = Promise.withResolvers<boolean>();
    const socket = createConnection(this.socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      connected.resolve(false);
    }, 250);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      connected.resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      connected.resolve(false);
    });
    return connected.promise;
  }

  handle(request: OutlinerRequest): OutlinerResponse {
    try {
      let result: unknown;
      switch (request.action) {
        case "ping":
          result = { status: "ready" };
          break;
        case "list":
          result = this.store.list(request.query);
          break;
        case "get":
          result = this.store.require(request.blockId);
          break;
        case "create":
          result = this.store.create(request.text, request.parentId, request.author);
          break;
        case "update":
          result = this.store.update(request.blockId, request.text, request.expectedUpdatedAt);
          break;
        case "move":
          result = this.store.move(request.blockId, request.parentId, request.position);
          break;
        case "delete":
          this.store.delete(request.blockId);
          result = { deleted: request.blockId };
          break;
        case "toggle":
          result = this.store.toggle(request.blockId);
          break;
        case "view.toggleMultiline":
          result = { expanded: this.store.toggleMultilineExpanded(request.blockId) };
          break;
        case "references.resolve":
          result = { text: this.store.resolveBlockReferences(request.text) };
          break;
        case "properties.patch":
          result = this.store.patchProperties(
            request.blockId,
            request.expectedUpdatedAt,
            request.operations,
          );
          break;
        case "properties.catalog":
          result = this.store.propertyCatalog(request.key, request.prefix, request.limit);
          break;
        case "selection.get":
          result = this.store.getSelection();
          break;
        case "selection.set":
          result = this.store.setSelection(request.blockId);
          break;
      }
      return { id: request.id, ok: true, result, sequence: this.store.sequence };
    } catch (error) {
      return {
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        sequence: this.store.sequence,
      };
    }
  }

  private accept(socket: Socket): void {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) {
          let response: OutlinerResponse;
          try {
            const request = JSON.parse(line) as OutlinerRequest;
            response = this.handle(request);
          } catch (error) {
            response = {
              id: "invalid",
              ok: false,
              error: error instanceof Error ? error.message : String(error),
              sequence: this.store.sequence,
            };
          }
          socket.write(`${JSON.stringify(response)}\n`);
        }
        newline = buffer.indexOf("\n");
      }
    });
  }
}
