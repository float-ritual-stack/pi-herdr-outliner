import { expect, test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import outlinerExtension, { formatSelection } from "../pi-extension/index";
import { OutlinerClient, type RequestInput } from "../src/client";
import type { Block, SelectionContext, VisibleBlockCollection } from "../src/types";

test("registers the workspace commands and annotation-aware tools", () => {
  const registeredTools: Array<{ name: string; parameters: unknown }> = [];
  const commands: string[] = [];
  const pi = {
    registerTool(definition: { name: string; parameters: unknown }) {
      registeredTools.push(definition);
    },
    registerCommand(name: string) {
      commands.push(name);
    },
    on() {},
  } as unknown as ExtensionAPI;

  outlinerExtension(pi);

  expect(commands).toEqual(["outliner", "capture", "outliner-goto", "outliner-filter"]);
  expect(registeredTools.map((definition) => definition.name)).toEqual([
    "outliner_create",
    "outliner_capture",
    "outliner_annotate_file",
    "outliner_update",
    "outliner_property_patch",
    "outliner_property_catalog",
    "outliner_page",
    "outliner_work_id",
    "outliner_query",
    "outliner_move",
    "outliner_clients",
    "outliner_selection",
  ]);
  const createSchema = JSON.stringify(
    registeredTools.find((definition) => definition.name === "outliner_create")?.parameters,
  );
  const updateSchema = JSON.stringify(
    registeredTools.find((definition) => definition.name === "outliner_update")?.parameters,
  );
  expect(createSchema).not.toContain("author");
  expect(updateSchema).toContain("expectedUpdatedAt");
});

test("requires protocol v13, attributes agent creates and page follows, and presents bounded query results", async () => {
  const collection: VisibleBlockCollection = {
    blocks: [
      {
        id: "match-id",
        parentId: null,
        position: 0,
        text: "Matching block",
        author: "user",
        createdAt: "2026-08-22T00:00:00.000Z",
        updatedAt: "2026-08-22T00:00:00.000Z",
        properties: [{ key: "status", value: "open" }],
        depth: 0,
        hasChildren: false,
        displayText: "Matching block",
      },
    ],
    completeness: { kind: "truncated", limit: 20 },
  };
  let protocolVersion = 13;
  let queryCollection = collection;
  let queryError: Error | undefined;
  const requests: RequestInput[] = [];
  const originalRequest = OutlinerClient.prototype.request;
  OutlinerClient.prototype.request = async function <T>(input: RequestInput): Promise<T> {
    requests.push(input);
    if (input.action === "blocks.query") {
      if (queryError) throw queryError;
      return queryCollection as unknown as T;
    }
    if (input.action === "create") return {} as T;
    if (input.action === "pages.follow") return { created: true } as T;
    if (input.action === "work-ids.status") return { prefix: "PIE" } as T;
    if (input.action === "work-ids.configure") return { prefix: input.prefix } as T;
    if (input.action === "work-ids.allocate") return { workId: "PIE-152" } as T;
    if (input.action === "clients.list") {
      const clients = [
        { clientId: "tree-client", role: "tree" },
        { clientId: "detail-client", role: "detail" },
      ];
      return (input.role
        ? clients.filter((client) => client.role === input.role)
        : clients) as T;
    }
    if (input.action === "ping") {
      return { status: "ready", protocolVersion } as unknown as T;
    }
    throw new Error(`Unexpected request: ${input.action}`);
  };

  type CommandDefinition = {
    handler(
      args: string,
      ctx: {
        ui: {
          setWidget(id: string, lines: string[], options: { placement: string }): void;
        };
      },
    ): Promise<void>;
  };
  type ToolDefinition = {
    name: string;
    execute(
      id: string,
      params: {
        text?: string;
        limit?: number;
        parentId?: string | null;
        operation?: "follow" | "status" | "configure" | "allocate";
        address?: string;
        blockId?: string;
        expectedUpdatedAt?: string;
        prefix?: string;
        role?: "tree" | "detail";
      },
      signal?: AbortSignal,
      onUpdate?: unknown,
      context?: ExtensionContext,
    ): Promise<{ content: Array<{ type: string; text: string }> }>;
  };
  const commands = new Map<string, CommandDefinition>();
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    registerCommand(name: string, definition: CommandDefinition) {
      commands.set(name, definition);
    },
    registerTool(definition: ToolDefinition) {
      tools.set(definition.name, definition);
    },
    on() {},
  } as unknown as ExtensionAPI;
  const widgets: Array<{ id: string; lines: string[] }> = [];
  const context = {
    sessionManager: {
      getSessionId: () => "session-test",
    },
  } as unknown as ExtensionContext;

  try {
    outlinerExtension(pi);
    await commands.get("outliner-filter")!.handler("status=open", {
      ui: {
        setWidget(id, lines) {
          widgets.push({ id, lines });
        },
      },
    });
    await commands.get("outliner-filter")!.handler('status="in progress"', {
      ui: {
        setWidget(id, lines) {
          widgets.push({ id, lines });
        },
      },
    });
    await commands.get("outliner-filter")!.handler('status="in progress', {
      ui: {
        setWidget(id, lines) {
          widgets.push({ id, lines });
        },
      },
    });
    queryError = new Error("Service unavailable");
    await commands.get("outliner-filter")!.handler("status=open", {
      ui: {
        setWidget(id, lines) {
          widgets.push({ id, lines });
        },
      },
    });
    queryError = undefined;
    const result = await tools.get("outliner_query")!.execute("query-id", { text: "Matching" });
    await tools.get("outliner_create")!.execute(
      "tool-call-test",
      { text: "Agent-created artifact", parentId: null },
      undefined,
      undefined,
      context,
    );
    await tools.get("outliner_page")!.execute(
      "page-follow-test",
      { operation: "follow", address: "Agent Page" },
      undefined,
      undefined,
      context,
    );
    await tools.get("outliner_work_id")!.execute("work-status", {
      operation: "status",
    });
    await tools.get("outliner_work_id")!.execute("work-configure", {
      operation: "configure",
      prefix: "PIE",
    });
    await tools.get("outliner_work_id")!.execute("work-allocate", {
      operation: "allocate",
      blockId: "work-block",
      expectedUpdatedAt: "version-1",
    });
    const clientsResult = await tools.get("outliner_clients")!.execute("clients", {
      role: "tree",
    });
    expect(JSON.parse(clientsResult.content[0]!.text)).toEqual([
      { clientId: "tree-client", role: "tree" },
    ]);
    const allClientsResult = await tools.get("outliner_clients")!.execute("all-clients", {});
    expect(JSON.parse(allClientsResult.content[0]!.text)).toEqual([
      { clientId: "tree-client", role: "tree" },
      { clientId: "detail-client", role: "detail" },
    ]);
    await expect(
      tools.get("outliner_page")!.execute(
        "unknown-page-op",
        { operation: "unknown" } as never,
        undefined,
        undefined,
        context,
      ),
    ).rejects.toThrow("Unsupported page operation: unknown");

    expect(requests.filter((request) => request.action === "blocks.query")).toEqual([
      {
        action: "blocks.query",
        query: { filters: [{ key: "status", value: "open" }], limit: 20 },
      },
      {
        action: "blocks.query",
        query: { filters: [{ key: "status", value: "in progress" }], limit: 20 },
      },
      {
        action: "blocks.query",
        query: { filters: [{ key: "status", value: "open" }], limit: 20 },
      },
      {
        action: "blocks.query",
        query: { text: "Matching", limit: 100 },
      },
    ]);
    expect(requests.find((request) => request.action === "create")).toEqual({
      action: "create",
      text: "Agent-created artifact",
      parentId: null,
      author: "agent",
      provenance: {
        actorId: process.env.OMPCODE ? "omp" : "pi",
        sessionId: "session-test",
        taskId: "tool-call-test",
      },
    });
    expect(requests.find((request) => request.action === "pages.follow")).toEqual({
      action: "pages.follow",
      address: "Agent Page",
      author: "agent",
      provenance: {
        actorId: process.env.OMPCODE ? "omp" : "pi",
        sessionId: "session-test",
        taskId: "page-follow-test",
      },
    });
    expect(requests.find((request) => request.action === "work-ids.status")).toEqual({
      action: "work-ids.status",
    });
    expect(requests.find((request) => request.action === "work-ids.configure")).toEqual({
      action: "work-ids.configure",
      prefix: "PIE",
    });
    expect(requests.find((request) => request.action === "work-ids.allocate")).toEqual({
      action: "work-ids.allocate",
      blockId: "work-block",
      expectedUpdatedAt: "version-1",
    });
    expect(requests.find((request) => request.action === "clients.list")).toEqual({
      action: "clients.list",
      role: "tree",
    });
    expect(widgets).toEqual([
      {
        id: "pi-outliner-filter",
        lines: ["• Matching block", "Results truncated at 20 blocks"],
      },
      {
        id: "pi-outliner-filter",
        lines: ["• Matching block", "Results truncated at 20 blocks"],
      },
      {
        id: "pi-outliner-filter",
        lines: ["Invalid filter: Unterminated quoted filter value at character 8"],
      },
      {
        id: "pi-outliner-filter",
        lines: ["Filter failed: Service unavailable"],
      },
    ]);
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      ...collection,
      presentation: { returned: 1, presented: 1, omitted: 0 },
    });

    queryCollection = {
      blocks: Array.from({ length: 100 }, (_, index) => ({
        ...collection.blocks[0],
        id: `large-${index}`,
        text: `Large ${index} ${"content ".repeat(100)}`,
        displayText: `Large ${index} ${"content ".repeat(100)}`,
      })),
      completeness: { kind: "truncated", limit: 100 },
    };
    const largeResult = await tools.get("outliner_query")!.execute("large-query", {});
    const largeEnvelope = JSON.parse(largeResult.content[0]!.text) as {
      blocks: unknown[];
      completeness: unknown;
      presentation: { returned: number; presented: number; omitted: number };
    };
    expect(largeResult.content[0]!.text.length).toBeLessThanOrEqual(12_000);
    expect(largeEnvelope.completeness).toEqual({ kind: "truncated", limit: 100 });
    expect(largeEnvelope.presentation.returned).toBe(100);
    expect(largeEnvelope.presentation.presented).toBe(largeEnvelope.blocks.length);
    expect(largeEnvelope.presentation.omitted).toBeGreaterThan(0);
    protocolVersion = 5;
    await expect(tools.get("outliner_query")!.execute("incompatible-query", {})).rejects.toThrow(
      "Incompatible outliner protocol 5; expected 13",
    );
  } finally {
    OutlinerClient.prototype.request = originalRequest;
  }
});

test("captures through command, tool, and exact standalone dispatch without an agent turn", async () => {
  type InputResult = { action: "continue" | "handled" };
  type InputHandler = (
    event: {
      text: string;
      source: "interactive" | "rpc" | "extension";
      images?: unknown[];
      streamingBehavior?: "steer" | "followUp";
    },
    context: ExtensionContext,
  ) => Promise<InputResult>;
  type CommandDefinition = {
    handler(args: string, context: ExtensionContext): Promise<void>;
  };
  type ToolDefinition = {
    name: string;
    execute(
      id: string,
      params: { text: string; requestId?: string; capturedFromBlockId?: string },
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      context: ExtensionContext,
    ): Promise<{ content: Array<{ type: string; text: string }> }>;
  };

  const selectionBlock: Block = {
    id: "selected-context",
    parentId: null,
    position: 0,
    text: "Selected context",
    author: "user",
    createdAt: "created",
    updatedAt: "updated",
    properties: [],
  };
  const commands = new Map<string, CommandDefinition>();
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, InputHandler>();
  const notifications: Array<{ message: string; level: string }> = [];
  const requests: RequestInput[] = [];
  let captureFailure: Error | null = null;
  let captureIndex = 0;
  const originalRequest = OutlinerClient.prototype.request;
  OutlinerClient.prototype.request = async function <T>(input: RequestInput): Promise<T> {
    requests.push(input);
    if (input.action === "ping") {
      return { status: "ready", protocolVersion: 13 } as T;
    }
    if (input.action === "selection.get") {
      return {
        selected: selectionBlock,
        ancestors: [],
        children: [],
      } as T;
    }
    if (input.action === "capture.create") {
      if (captureFailure) throw captureFailure;
      captureIndex += 1;
      return {
        block: {
          ...selectionBlock,
          id: `capture-${captureIndex}`,
          parentId: "inbox",
          text: input.text,
          author: input.author ?? "user",
          properties: [
            { key: "capture-source", value: input.source },
            ...(input.capturedFromBlockId
              ? [{ key: "captured-from", value: input.capturedFromBlockId }]
              : []),
          ],
        },
        inboxBlockId: "inbox",
        deduplicated: false,
      } as T;
    }
    throw new Error(`Unexpected request: ${input.action}`);
  };
  const pi = {
    registerCommand(name: string, definition: CommandDefinition) {
      commands.set(name, definition);
    },
    registerTool(definition: ToolDefinition) {
      tools.set(definition.name, definition);
    },
    on(name: string, handler: InputHandler) {
      if (name === "input") handlers.set(name, handler);
    },
  } as unknown as ExtensionAPI;
  const context = {
    sessionManager: {
      getSessionId: () => "session-capture",
    },
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  } as unknown as ExtensionContext;

  try {
    outlinerExtension(pi);
    await commands.get("capture")!.handler("command capture", context);
    const toolResult = await tools.get("outliner_capture")!.execute(
      "tool-capture",
      { text: "tool capture", requestId: "stable-tool-request" },
      undefined,
      undefined,
      context,
    );
    expect(JSON.parse(toolResult.content[0]!.text)).toEqual({
      blockId: "capture-2",
      inboxBlockId: "inbox",
      source: process.env.OMPCODE ? "omp" : "pi",
      capturedFromBlockId: selectionBlock.id,
      deduplicated: false,
    });

    const input = handlers.get("input")!;
    expect(await input({
      text: "float.dispatch({remember this 🐢})",
      source: "interactive",
      images: [],
    }, context)).toEqual({ action: "handled" });
    expect(await input({
      text: "I mentioned float.dispatch({not standalone})",
      source: "interactive",
      images: [],
    }, context)).toEqual({ action: "continue" });
    expect(await input({
      text: "float.dispatch({unterminated}",
      source: "interactive",
      images: [],
    }, context)).toEqual({ action: "continue" });

    const captures = requests.filter(
      (request): request is Extract<RequestInput, { action: "capture.create" }> =>
        request.action === "capture.create",
    );
    expect(captures).toHaveLength(3);
    expect(captures[0]).toMatchObject({
      text: "command capture",
      source: process.env.OMPCODE ? "omp" : "pi",
      capturedFromBlockId: selectionBlock.id,
      author: "user",
    });
    expect(captures[1]).toEqual(expect.objectContaining({
      requestId: "stable-tool-request",
      text: "tool capture",
      source: process.env.OMPCODE ? "omp" : "pi",
      capturedFromBlockId: selectionBlock.id,
      author: "agent",
      provenance: {
        actorId: process.env.OMPCODE ? "omp" : "pi",
        sessionId: "session-capture",
        taskId: "tool-capture",
      },
    }));
    expect(captures[2]).toMatchObject({
      text: "{remember this 🐢}",
      source: process.env.OMPCODE ? "omp" : "pi",
      author: "user",
    });
    expect(notifications.some(({ message }) => message.includes("Captured to Inbox"))).toBe(true);
    expect(notifications.some(({ message }) => message.includes("Unterminated dispatch marker")))
      .toBe(true);

    captureFailure = new Error("service unavailable");
    expect(await input({
      text: "float.dispatch({preserve me})",
      source: "interactive",
      images: [],
    }, context)).toEqual({ action: "continue" });
    expect(notifications.at(-1)?.message).toContain("Dispatch failed; input preserved");
  } finally {
    OutlinerClient.prototype.request = originalRequest;
  }
});

test("formats compact bounded selection context", () => {
  const baseBlock: Block = {
    id: "selected-id",
    parentId: null,
    position: 0,
    text: `Selected title\n${"full text ".repeat(800)}`,
    author: "user",
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
    properties: [{ key: "status", value: "active" }],
  };
  const context: SelectionContext = {
    selected: baseBlock,
    ancestors: [{ ...baseBlock, id: "parent-id", text: "Parent title" }],
    children: Array.from({ length: 20 }, (_, index) => ({
      ...baseBlock,
      id: `child-${index}`,
      text: `Child ${index}\n${"large ".repeat(200)}`,
    })),
  };
  const formatted = formatSelection(context);

  expect(formatted.length).toBeLessThanOrEqual(4_000);
  expect(formatted).toContain("Selected: [selected-id] Selected title");
  expect(formatted).toContain("- [child-0] Child 0");
  expect(formatted).not.toContain("full text full text");
  expect(formatted).not.toContain("large large");
});