import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { OutlinerStore } from "./store";
import {
  OUTLINER_PROTOCOL_VERSION,
  type Block,
  type CaptureReceipt,
  type OutlinerEvent,
  type OutlinerClientRegistration,
  type OutlinerClientRuntime,
  type OutlinerClientRole,
  type OutlinerEventEnvelope,
  type NavigationState,
  type PageAddressFollowResult,
  type OutlinerRequest,
  type OutlinerResponse,
} from "./types";

export class OutlinerServer {
  private server: Server | null = null;
  private readonly subscribers = new Map<Socket, OutlinerClientRegistration>();
  private readonly browsingContextTargets = new Map<string, string | null>();

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
    try {
      await started.promise;
    } catch (error) {
      this.server = null;
      throw error;
    }
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    for (const subscriber of this.subscribers.keys()) subscriber.destroy();
    this.subscribers.clear();
    this.browsingContextTargets.clear();
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

  private pruneDestroyedSubscribers(): void {
    for (const socket of this.subscribers.keys()) {
      if (socket.destroyed) this.removeSubscriber(socket);
    }
  }


  private normalizeContextId(value: string): string {
    const contextId = value?.trim();
    if (
      !contextId ||
      contextId.length > 200 ||
      /[\u0000-\u001f\u007f]/.test(contextId)
    ) {
      throw new Error("Browsing context ID must be 1-200 printable characters");
    }
    return contextId;
  }

  private removeSubscriber(socket: Socket): void {
    const removed = this.subscribers.get(socket);
    this.subscribers.delete(socket);
    if (
      removed &&
      ![...this.subscribers.values()].some((client) => client.contextId === removed.contextId)
    ) {
      this.browsingContextTargets.delete(removed.contextId);
    }
  }

  private registerSubscriber(
    socket: Socket,
    registration: OutlinerClientRegistration,
  ): OutlinerClientRegistration {
    if (!registration || typeof registration !== "object") {
      throw new Error("Client registration is required");
    }
    const clientId = registration.clientId?.trim();
    if (
      !clientId ||
      clientId.length > 200 ||
      /[\u0000-\u001f\u007f]/.test(clientId)
    ) {
      throw new Error("Client registration clientId must be 1-200 printable characters");
    }
    if (registration.role !== "tree" && registration.role !== "detail") {
      throw new Error(`Invalid client role: ${String(registration.role)}`);
    }
    const contextId = this.normalizeContextId(registration.contextId);
    this.pruneDestroyedSubscribers();
    if (this.subscribers.has(socket)) {
      throw new Error("Socket already owns a client registration");
    }
    for (const [owner, client] of this.subscribers) {
      if (owner !== socket && client.clientId === clientId) {
        throw new Error(`Client ID is already registered: ${clientId}`);
      }
    }
    let runtime: OutlinerClientRuntime | undefined;
    if (registration.runtime !== undefined) {
      if (
        !registration.runtime ||
        typeof registration.runtime !== "object" ||
        Array.isArray(registration.runtime)
      ) {
        throw new Error("Client runtime must be an object");
      }
      const runtimeKeys = ["paneId", "terminalId", "workspaceId", "tabId"] as const;
      const unknownKey = Object.keys(registration.runtime)
        .find((key) => !runtimeKeys.includes(key as typeof runtimeKeys[number]));
      if (unknownKey) throw new Error(`Invalid client runtime ${unknownKey}`);
      const entries = runtimeKeys.flatMap((key) => {
        const value = registration.runtime?.[key];
        if (value === undefined) return [];
        if (
          typeof value !== "string" ||
          !value.trim() ||
          value.length > 500 ||
          /[\u0000-\u001f\u007f]/.test(value)
        ) {
          throw new Error(`Invalid client runtime ${key}`);
        }
        return [[key, value.trim()] as const];
      });
      if (entries.length > 0) runtime = Object.fromEntries(entries);
    }
    const normalized: OutlinerClientRegistration = {
      clientId,
      role: registration.role,
      contextId,
      ...(runtime ? { runtime } : {}),
    };
    this.subscribers.set(socket, normalized);
    return normalized;
  }

  private listClients(role?: OutlinerClientRole): OutlinerClientRegistration[] {
    this.pruneDestroyedSubscribers();
    return [...this.subscribers.values()]
      .filter((client) => role === undefined || client.role === role)
      .sort((left, right) =>
        left.role.localeCompare(right.role) || left.clientId.localeCompare(right.clientId)
      );
  }

  private hasClient(clientId: string): boolean {
    this.pruneDestroyedSubscribers();
    return [...this.subscribers.values()].some((client) => client.clientId === clientId);
  }

  handle(
    request: OutlinerRequest,
    subscribedClient?: OutlinerClientRegistration,
  ): OutlinerResponse {
    try {
      let result: unknown;
      const action = request.action;
      switch (action) {
        case "ping":
          result = { status: "ready", protocolVersion: OUTLINER_PROTOCOL_VERSION };
          break;
        case "blocks.query":
          result = this.store.queryBlocks(request.query);
          break;
        case "children":
          result = this.store.children(request.parentId);
          break;
        case "workspace.snapshot":
          result = this.store.readWorkspaceSnapshot(request.view);
          break;
        case "events.subscribe":
          result = { subscribed: true, client: subscribedClient ?? request.client };
          break;
        case "clients.list":
          if (request.role !== undefined && request.role !== "tree" && request.role !== "detail") {
            throw new Error(`Invalid client role: ${String(request.role)}`);
          }
          result = this.listClients(request.role);
          break;
        case "blocks.context":
          result = this.store.blockContext(request.blockId);
          break;
        case "browsing-context.get": {
          const contextId = this.normalizeContextId(request.contextId);
          const blockId = this.browsingContextTargets.get(contextId) ?? null;
          result = {
            contextId,
            target: blockId
              ? this.store.blockContext(blockId)
              : { selected: null, ancestors: [], children: [] },
          };
          break;
        }
        case "browsing-context.publish": {
          const contextId = this.normalizeContextId(request.contextId);
          const target = request.blockId
            ? this.store.blockContext(request.blockId)
            : { selected: null, ancestors: [], children: [] };
          this.browsingContextTargets.set(contextId, request.blockId);
          result = { contextId, target };
          break;
        }
        case "ui.command.send":
          if (!this.hasClient(request.command.targetClientId)) {
            throw new Error(`Target client is not registered: ${request.command.targetClientId}`);
          }
          result = { accepted: true, command: request.command };
          break;
        case "get":
          result = this.store.require(request.blockId);
          break;
        case "create":
          result = this.store.create(
            request.text,
            request.parentId,
            request.author,
            request.provenance,
          );
          break;
        case "capture.create":
          result = this.store.capture(
            request.requestId,
            request.text,
            request.source,
            request.capturedFromBlockId,
            request.author,
            request.provenance,
          );
          break;
        case "update":
          result = this.store.update(request.blockId, request.text, request.expectedUpdatedAt);
          break;
        case "move":
          result = this.store.move(request.blockId, request.parentId, request.position);
          break;
        case "delete":
          result = this.store.delete(request.blockId);
          break;
        case "trash.restore":
          result = this.store.restore(request.blockId);
          break;
        case "trash.purge":
          this.store.purge(request.blockId, request.confirmation);
          result = { purged: request.blockId };
          break;
        case "virtual.occurrences.reorder":
          result = this.store.reorderVirtualOccurrences(
            request.viewId,
            request.orderedBlockIds,
          );
          break;
        case "references.resolve":
          result = this.store.resolveBlockReferences(request.text);
          break;
        case "pages.resolve":
          result = this.store.resolvePageAddress(request.address);
          break;
        case "pages.follow":
          result = this.store.followPageAddress(
            request.address,
            request.author,
            request.provenance,
          );
          break;
        case "pages.complete":
          result = this.store.completePageAddresses(request.query, request.limit);
          break;
        case "pages.rename":
          result = this.store.renamePageAddress(
            request.blockId,
            request.address,
            request.expectedUpdatedAt,
          );
          break;
        case "pages.alias":
          result = this.store.addPageAlias(request.blockId, request.address);
          break;
        case "pages.remove":
          result = this.store.removePageAddress(
            request.blockId,
            request.address,
            request.expectedUpdatedAt,
          );
          break;
        case "work-ids.status":
          result = this.store.workIdAllocatorStatus();
          break;
        case "work-ids.configure":
          result = this.store.configureWorkIdPrefix(request.prefix);
          break;
        case "work-ids.allocate":
          result = this.store.allocateWorkId(
            request.blockId,
            request.expectedUpdatedAt,
          );
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
        case "navigation.state":
          result = this.store.navigationState();
          break;
        case "navigation.back":
          result = this.store.navigateHistory("back");
          break;
        case "navigation.forward":
          result = this.store.navigateHistory("forward");
          break;
        default: {
          const unsupportedAction: never = action;
          throw new Error(`Unsupported action: ${String(unsupportedAction)}`);
        }
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

  private eventFor(request: OutlinerRequest, response: Extract<OutlinerResponse, { ok: true }>): OutlinerEvent | null {
    let domain: OutlinerEvent["domain"];
    let blockId: string | undefined;
    let contextId: string | undefined;
    let command: OutlinerEvent["command"];
    switch (request.action) {
      case "create":
        domain = "content";
        blockId = (response.result as Block).id;
        break;
      case "capture.create": {
        const receipt = response.result as CaptureReceipt;
        if (receipt.deduplicated) return null;
        domain = "content";
        blockId = receipt.block.id;
        break;
      }
      case "update":
      case "move":
      case "delete":
      case "trash.restore":
      case "trash.purge":
      case "properties.patch":
      case "pages.rename":
      case "pages.alias":
      case "pages.remove":
      case "work-ids.allocate":
        domain = "content";
        blockId = request.blockId;
        break;
      case "work-ids.configure":
        domain = "content";
        break;
      case "pages.follow": {
        const followed = response.result as PageAddressFollowResult;
        if (!followed.created) return null;
        domain = "content";
        blockId = followed.block?.id;
        break;
      }
      case "virtual.occurrences.reorder":
        domain = "view";
        blockId = request.viewId;
        break;
      case "selection.set":
        domain = "selection";
        blockId = request.blockId ?? undefined;
        break;
      case "navigation.back":
      case "navigation.forward":
        domain = "selection";
        blockId = (response.result as NavigationState).selection.selected?.id;
        break;
      case "ui.command.send":
        domain = "ui";
        blockId = request.command.blockId;
        command = request.command;
        break;
      case "browsing-context.publish":
        domain = "browsing-context";
        blockId = request.blockId ?? undefined;
        contextId = request.contextId;
        break;
      default:
        return null;
    }

    return {
      id: crypto.randomUUID(),
      domain,
      action: request.action,
      sequence: response.sequence,
      blockId,
      command,
      contextId,
    };
  }

  private broadcast(event: OutlinerEvent): void {
    this.pruneDestroyedSubscribers();
    const envelope: OutlinerEventEnvelope = { event };
    const line = `${JSON.stringify(envelope)}\n`;
    for (const [subscriber, client] of this.subscribers) {
      if (event.domain === "ui" && event.command?.targetClientId !== client.clientId) {
        continue;
      }
      if (event.domain === "browsing-context" && event.contextId !== client.contextId) {
        continue;
      }
      subscriber.write(line);
    }
  }

  private accept(socket: Socket): void {
    socket.setEncoding("utf8");
    socket.once("close", () => this.removeSubscriber(socket));
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) {
          let request: OutlinerRequest | undefined;
          let response: OutlinerResponse;
          try {
            request = JSON.parse(line) as OutlinerRequest;
            const subscribedClient = request.action === "events.subscribe"
              ? this.registerSubscriber(socket, request.client)
              : undefined;
            response = this.handle(request, subscribedClient);
          } catch (error) {
            response = {
              id: request?.id ?? "invalid",
              ok: false,
              error: error instanceof Error ? error.message : String(error),
              sequence: this.store.sequence,
            };
          }
          socket.write(`${JSON.stringify(response)}\n`);
          if (request && response.ok) {
            const event = this.eventFor(request, response);
            if (event) this.broadcast(event);
          }
        }
        newline = buffer.indexOf("\n");
      }
    });
  }
}
