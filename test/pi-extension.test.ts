import { expect, test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import outlinerExtension, {
  containsConfiguredWorkPlaceholder,
  formatSelection,
  latestAssistantReport,
  formatWorkPlaceholderNudge,
  selectRecentFocusedOutlinerClient,
} from "../pi-extension/index";
import { OutlinerClient, type RequestInput } from "../src/client";
import type {
  Block,
  OutlinerClientRegistration,
  SelectionContext,
  VisibleBlockCollection,
} from "../src/types";

test("extracts only the latest completed assistant text from a session branch", () => {
  const entries = [
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Older" }] } },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "Prompt" }] } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private" },
          { type: "text", text: "Final " },
          { type: "toolCall", name: "noop" },
          { type: "text", text: "report" },
        ],
      },
    },
  ];

  expect(latestAssistantReport(entries)).toBe("Final report");
  expect(latestAssistantReport([
    { type: "message", message: { role: "user", content: "No assistant" } },
  ])).toBeNull();
});

test("publishes only the final assistant message at agent_settled", async () => {
  type EventHandler = (
    event: Record<string, unknown>,
    context: ExtensionContext,
  ) => Promise<unknown> | unknown;
  const handlers = new Map<string, EventHandler>();
  const requests: RequestInput[] = [];
  const originalRequest = OutlinerClient.prototype.request;
  const originalHerdrEnv = process.env.HERDR_ENV;
  process.env.HERDR_ENV = "0";
  OutlinerClient.prototype.request = async function <T>(input: RequestInput): Promise<T> {
    requests.push(input);
    if (input.action === "ping") {
      return { status: "ready", protocolVersion: 20 } as T;
    }
    if (input.action === "reports.publish") {
      return {
        sessionId: input.sessionId,
        rawText: input.text,
        resolvedText: input.text,
        publishedAt: "published",
        revision: 1,
      } as T;
    }
    throw new Error(`Unexpected request: ${input.action}`);
  };
  const pi = {
    registerTool() {},
    registerCommand() {},
    on(name: string, handler: EventHandler) {
      handlers.set(name, handler);
    },
  } as unknown as ExtensionAPI;
  const context = {
    ui: {
      setStatus() {},
      notify() {},
    },
    sessionManager: {
      getSessionId: () => "settled-session",
      getBranch: () => [
        {
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Final settled report" }],
          },
        },
      ],
    },
  } as unknown as ExtensionContext;

  try {
    outlinerExtension(pi);
    await handlers.get("agent_start")!({}, context);
    expect(requests.some(({ action }) => action === "reports.publish")).toBe(false);
    await handlers.get("agent_settled")!({}, context);
    expect(requests).toContainEqual({
      action: "reports.publish",
      sessionId: "settled-session",
      text: "Final settled report",
    });
  } finally {
    OutlinerClient.prototype.request = originalRequest;
    if (originalHerdrEnv === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = originalHerdrEnv;
  }
});

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

  expect(commands).toEqual([
    "outliner",
    "outliner-task",
    "capture",
    "outliner-goto",
    "outliner-filter",
  ]);
  expect(registeredTools.map((definition) => definition.name)).toEqual([
    "outliner_task",
    "outliner_focus",
    "outliner_publish",
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

test("nudges once per turn from prompt, focused block, or outliner tool text", async () => {
  type EventHandler = (
    event: Record<string, unknown>,
    context: ExtensionContext,
  ) => Promise<unknown> | unknown;

  let selectedText = "Focused block without a placeholder";
  const handlers = new Map<string, EventHandler>();
  const requests: RequestInput[] = [];
  const originalRequest = OutlinerClient.prototype.request;
  const originalHerdrEnv = process.env.HERDR_ENV;
  process.env.HERDR_ENV = "0";

  OutlinerClient.prototype.request = async function <T>(input: RequestInput): Promise<T> {
    requests.push(input);
    if (input.action === "selection.get") {
      return {
        selected: {
          id: "focused-block",
          parentId: null,
          position: 0,
          text: selectedText,
          author: "user",
          createdAt: "created",
          updatedAt: "updated",
          properties: [],
        },
        ancestors: [],
        children: [],
      } as T;
    }
    if (input.action === "work-ids.status") {
      return {
        prefix: "PIE",
        nextNumber: 153,
        nextWorkId: "PIE-153",
        reservedCount: 40,
        observedPrefixes: ["PIE"],
      } as T;
    }
    throw new Error(`Unexpected request: ${input.action}`);
  };

  const pi = {
    registerCommand() {},
    registerTool() {},
    on(name: string, handler: EventHandler) {
      handlers.set(name, handler);
    },
    appendEntry() {},
  } as unknown as ExtensionAPI;
  const context = {
    sessionManager: {
      getSessionId: () => "placeholder-session",
      getBranch: () => [],
    },
    ui: {
      setStatus() {},
      notify() {},
    },
  } as unknown as ExtensionContext;

  try {
    outlinerExtension(pi);
    const beforeAgentStart = handlers.get("before_agent_start")!;
    const toolResult = handlers.get("tool_result")!;

    const promptNudge = await beforeAgentStart({
      systemPrompt: "base prompt",
      prompt: "Resolve [work-id::PIE-XXX]",
    }, context) as { systemPrompt: string };
    expect(promptNudge.systemPrompt).toContain(formatWorkPlaceholderNudge("PIE"));
    expect(promptNudge.systemPrompt.match(/Work placeholder detected/g)).toHaveLength(1);

    selectedText = "Focused relation [[PIE-XXX]]";
    const focusedNudge = await beforeAgentStart({
      systemPrompt: "base prompt",
      prompt: "Continue",
    }, context) as { systemPrompt: string };
    expect(focusedNudge.systemPrompt).toContain("work-placeholder-resolver");

    selectedText = "No configured marker";
    const unrelated = await beforeAgentStart({
      systemPrompt: "base prompt",
      prompt: "Ignore [work-id::OTHER-XXX]",
    }, context) as { systemPrompt: string };
    expect(unrelated.systemPrompt).not.toContain("Work placeholder detected");

    const ignoredToolNudge = await toolResult({
      toolName: "read",
      toolCallId: "read-1",
      input: {},
      content: [{ type: "text", text: "Unrelated file contains [issue::PIE-XXX]" }],
      details: {},
      isError: false,
    }, context);
    expect(ignoredToolNudge).toBeUndefined();

    const firstToolNudge = await toolResult({
      toolName: "outliner_query",
      toolCallId: "query-1",
      input: {},
      content: [{ type: "text", text: "Candidate [issue::PIE-XXX]" }],
      details: {},
      isError: false,
    }, context) as { content: Array<{ type: string; text: string }> };
    expect(firstToolNudge.content.at(-1)?.text).toContain("work-placeholder-resolver");

    const duplicateToolNudge = await toolResult({
      toolName: "outliner_selection",
      toolCallId: "selection-1",
      input: {},
      content: [{ type: "text", text: "Again [[PIE-XXX]]" }],
      details: {},
      isError: false,
    }, context);
    expect(duplicateToolNudge).toBeUndefined();

    expect(containsConfiguredWorkPlaceholder("[[PIE-XXX]]", "PIE")).toBe(true);
    expect(containsConfiguredWorkPlaceholder("[[OTHER-XXX]]", "PIE")).toBe(false);
    expect(
      requests.every(({ action }) =>
        action === "selection.get" || action === "work-ids.status"
      ),
    ).toBe(true);
  } finally {
    OutlinerClient.prototype.request = originalRequest;
    if (originalHerdrEnv === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = originalHerdrEnv;
  }
});

test("drives an explicit task through context, focus, durable proof, and completion", async () => {
  interface ToolDefinition {
    name: string;
    execute(
      id: string,
      params: {
        operation?: "status" | "start" | "pause" | "complete" | "clear";
        address?: string;
        proofBlockId?: string;
        query?: string;
        clientId?: string;
        text?: string;
        type?: "implementation-proof";
        focus?: boolean;
        parentId?: string | null;
      },
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      context: ExtensionContext,
    ): Promise<{ content: Array<{ type: string; text: string }> }>;
  }
  type EventHandler = (
    event: Record<string, unknown>,
    context: ExtensionContext,
  ) => Promise<unknown> | unknown;

  let task: Block = {
    id: "task-id",
    parentId: null,
    position: 0,
    text:
      "PIE-144 — Agent workflow [type::roadmap-item] [status::planned] [priority::high] [work-stage::next] [work-id::PIE-144] [depends-on::dependency-id]",
    author: "agent",
    createdAt: "created",
    updatedAt: "v1",
    properties: [
      { key: "type", value: "roadmap-item" },
      { key: "status", value: "planned" },
      { key: "priority", value: "high" },
      { key: "work-stage", value: "next" },
      { key: "work-id", value: "PIE-144" },
      { key: "depends-on", value: "dependency-id" },
    ],
  };
  const dependency: Block = {
    ...task,
    id: "dependency-id",
    text: "Completed dependency",
    updatedAt: "dependency-v1",
    properties: [{ key: "status", value: "complete" }],
  };
  let artifact: Block | null = null;
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, EventHandler>();
  const requests: RequestInput[] = [];
  const sessionEntries: Array<Record<string, unknown>> = [];
  const statuses: Array<string | undefined> = [];
  const originalRequest = OutlinerClient.prototype.request;
  const originalHerdrEnv = process.env.HERDR_ENV;
  process.env.HERDR_ENV = "0";

  OutlinerClient.prototype.request = async function <T>(input: RequestInput): Promise<T> {
    requests.push(input);
    if (input.action === "ping") {
      return { status: "ready", protocolVersion: 20 } as T;
    }
    if (input.action === "pages.resolve") {
      return (input.address === "PIE-144"
        ? {
          address: input.address,
          normalizedAddress: "pie-144",
          status: "resolved",
          registeredAddress: "PIE-144",
          kind: "work-id",
          block: task,
        }
        : {
          address: input.address,
          normalizedAddress: input.address.toLowerCase(),
          status: "missing",
        }) as T;
    }
    if (input.action === "workspace.snapshot") {
      const blocks = [task, dependency, ...(artifact ? [artifact] : [])];
      return {
        physical: {
          blocks: blocks.map((block) => ({
            ...block,
            depth: 0,
            hasChildren: block.id === task.id && artifact !== null,
            displayText: block.text,
          })),
          completeness: { kind: "complete" },
        },
      } as unknown as T;
    }
    if (input.action === "properties.patch") {
      expect(input.blockId).toBe(task.id);
      const properties = task.properties.map((property) => ({ ...property }));
      for (const operation of input.operations) {
        if (operation.op === "replace") {
          properties[operation.ordinal] = {
            key: operation.key ?? properties[operation.ordinal]!.key,
            value: operation.value,
          };
        } else if (operation.op === "append") {
          properties.push({ key: operation.key, value: operation.value });
        }
      }
      task = { ...task, properties, updatedAt: task.updatedAt === "v1" ? "v2" : "v3" };
      return task as T;
    }
    if (input.action === "get") {
      const block = input.blockId === task.id
        ? task
        : input.blockId === dependency.id
        ? dependency
        : artifact?.id === input.blockId
        ? artifact
        : null;
      if (!block) throw new Error(`Unknown block: ${input.blockId}`);
      return block as T;
    }
    if (input.action === "blocks.context") {
      const selected = input.blockId === task.id ? task : artifact;
      if (!selected) throw new Error(`Unknown context block: ${input.blockId}`);
      return {
        selected,
        ancestors: selected.id === task.id ? [] : [task],
        children: selected.id === task.id && artifact ? [artifact] : [],
      } as T;
    }
    if (input.action === "create") {
      artifact = {
        id: "proof-id",
        parentId: input.parentId ?? null,
        position: 0,
        text: input.text,
        author: input.author ?? "agent",
        actorId: input.provenance?.actorId,
        sessionId: input.provenance?.sessionId,
        taskId: input.provenance?.taskId,
        createdAt: "created",
        updatedAt: "proof-v1",
        properties: [
          { key: "type", value: "implementation-proof" },
          { key: "source-block", value: task.id },
        ],
      };
      return artifact as T;
    }
    if (input.action === "clients.list") {
      return [{
        clientId: "tree-client",
        role: "tree",
        contextId: "tree-client",
      }] as T;
    }
    if (
      input.action === "selection.set" ||
      input.action === "ui.command.send"
    ) {
      return {} as T;
    }
    throw new Error(`Unexpected request: ${input.action}`);
  };

  const pi = {
    registerCommand() {},
    registerTool(definition: ToolDefinition) {
      tools.set(definition.name, definition);
    },
    on(name: string, handler: EventHandler) {
      handlers.set(name, handler);
    },
    appendEntry(customType: string, data: unknown) {
      sessionEntries.push({ type: "custom", customType, data });
    },
  } as unknown as ExtensionAPI;
  const context = {
    isIdle: () => false,
    sessionManager: {
      getSessionId: () => "session-workflow",
      getBranch: () => sessionEntries,
    },
    ui: {
      setStatus(_key: string, value: string | undefined) {
        statuses.push(value);
      },
      notify() {},
    },
  } as unknown as ExtensionContext;

  try {
    outlinerExtension(pi);
    const resources = await handlers.get("resources_discover")!({}, context) as {
      skillPaths: string[];
    };
    expect(resources.skillPaths[0]).toEndWith(
      "pi-extension/skills/outliner-workflow/SKILL.md",
    );
    expect(resources.skillPaths[1]).toEndWith(
      "pi-extension/skills/work-placeholder-resolver/SKILL.md",
    );

    const started = JSON.parse(
      (await tools.get("outliner_task")!.execute(
        "start-task",
        { operation: "start", address: "PIE-144" },
        undefined,
        undefined,
        context,
      )).content[0]!.text,
    );
    expect(started).toMatchObject({ blockId: task.id, workId: "PIE-144", stage: "doing" });
    expect(statuses.at(-1)).toBe("PIE-144");

    const beforeResult = await handlers.get("before_agent_start")!({
      systemPrompt: "base prompt",
      prompt: "implement it",
    }, context) as { systemPrompt: string };
    expect(beforeResult.systemPrompt).toContain("Outliner active task context:");
    expect(beforeResult.systemPrompt).toContain("Active task: [task-id] PIE-144 — Agent workflow");
    expect(beforeResult.systemPrompt).toContain("Completed dependency · status=complete");
    expect(beforeResult.systemPrompt).toContain("outliner_publish");

    const focused = JSON.parse(
      (await tools.get("outliner_focus")!.execute(
        "focus-task",
        { query: task.id, clientId: "tree-client" },
        undefined,
        undefined,
        context,
      )).content[0]!.text,
    );
    expect(focused).toMatchObject({ focused: true, blockId: task.id });
    expect(focused.context).toContain("Selected: [task-id]");

    const published = JSON.parse(
      (await tools.get("outliner_publish")!.execute(
        "publish-proof",
        {
          text: "PIE-144 exercised successfully",
          type: "implementation-proof",
          clientId: "tree-client",
        },
        undefined,
        undefined,
        context,
      )).content[0]!.text,
    );
    expect(published).toEqual({
      blockId: "proof-id",
      parentId: task.id,
      type: "implementation-proof",
      focused: true,
    });
    const create = requests.find(
      (request): request is Extract<RequestInput, { action: "create" }> =>
        request.action === "create",
    )!;
    expect(create.parentId).toBe(task.id);
    expect(create.text).toContain("[type::implementation-proof]");
    expect(create.text).toContain(`[source-block::${task.id}]`);

    const completed = JSON.parse(
      (await tools.get("outliner_task")!.execute(
        "complete-task",
        { operation: "complete", proofBlockId: "proof-id" },
        undefined,
        undefined,
        context,
      )).content[0]!.text,
    );
    expect(completed).toMatchObject({
      workId: "PIE-144",
      stage: "done",
      status: "complete",
      proofBlockId: "proof-id",
    });
    expect(sessionEntries.map((entry) => entry.data)).toEqual([
      { version: 1, blockId: task.id },
      { version: 1, blockId: null },
    ]);
    expect(task.properties).toEqual(expect.arrayContaining([
      { key: "work-stage", value: "done" },
      { key: "status", value: "complete" },
      { key: "proof", value: "proof-id" },
    ]));
    expect(statuses.at(-1)).toBeUndefined();
  } finally {
    OutlinerClient.prototype.request = originalRequest;
    if (originalHerdrEnv === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = originalHerdrEnv;
  }
});

test("requires protocol v20, attributes agent creates and page follows, and presents bounded query results", async () => {
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
  let protocolVersion = 20;
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
        { clientId: "tree-client", role: "tree", contextId: "tree-client" },
        { clientId: "detail-client", role: "detail", contextId: "detail-client" },
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
      { clientId: "tree-client", role: "tree", contextId: "tree-client" },
    ]);
    const allClientsResult = await tools.get("outliner_clients")!.execute("all-clients", {});
    expect(JSON.parse(allClientsResult.content[0]!.text)).toEqual([
      { clientId: "tree-client", role: "tree", contextId: "tree-client" },
      { clientId: "detail-client", role: "detail", contextId: "detail-client" },
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
      "Incompatible outliner protocol 5; expected 20",
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
      return { status: "ready", protocolVersion: 20 } as T;
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
  expect(formatted).toContain("Content:\nSelected title");
  expect(formatted).toContain("focused block body truncated");
  expect(formatted).toContain("- [child-0] Child 0");
  expect(formatted).not.toContain("full text ".repeat(300));
  expect(formatted).not.toContain("large large");
});

test("selects the most recently focused registered Outliner client", () => {
  const clients: OutlinerClientRegistration[] = [
    {
      clientId: "detail-follow",
      role: "detail",
      contextId: "follow",
      runtime: { paneId: "pane-follow" },
    },
    {
      clientId: "detail-temp",
      role: "detail",
      contextId: "temp",
      runtime: { paneId: "pane-temp" },
    },
    {
      clientId: "tree-without-runtime",
      role: "tree",
      contextId: "tree",
    },
  ];

  expect(selectRecentFocusedOutlinerClient(
    clients,
    ["agent-pane", "pane-temp", "pane-follow"],
  )).toBe(clients[1]);
  expect(selectRecentFocusedOutlinerClient(
    clients,
    ["agent-pane", "unknown-pane"],
  )).toBeUndefined();
});