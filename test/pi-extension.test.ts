import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, spyOn, test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import outlinerExtension, {
  containsConfiguredWorkPlaceholder,
  containsTaskStartToolCall,
  createOutlinerExtension,
  formatSelection,
  latestAssistantResponse,
  isLifecycleMutationTool,
  formatWorkPlaceholderNudge,
  selectRecentFocusedOutlinerClient,
  selectCapturedResponseTree,
} from "../pi-extension/index";
import { OutlinerClient, type RequestInput } from "../src/client";
import { parseProperties, patchPropertyText } from "../src/properties";
import { OUTLINER_PROTOCOL_VERSION } from "../src/types";
import type {
  BlockEditActivityPage,
  Block,
  OutlinerClientRegistration,
  RoadmapItemCreateInput,
  SelectionContext,
  VisibleBlockCollection,
} from "../src/types";

test("collects the user response without an advisor follow-up", () => {
  const entries = [
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Older" }] } },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "Prompt" }] } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private" },
          { type: "text", text: "First fragment" },
        ],
      },
    },
    { type: "message", message: { role: "toolResult", content: "tool output" } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Second fragment" }],
      },
    },
    {
      type: "custom_message",
      customType: "advisor",
      content: "Advisory starts a separate follow-up turn",
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Short advisor recap" }],
      },
    },
  ];

  expect(latestAssistantResponse(entries)).toBe("First fragment\n\nSecond fragment");
  expect(latestAssistantResponse([
    { type: "message", message: { role: "user", content: "No assistant" } },
  ])).toBeNull();
});


test("registers the workspace commands and annotation-aware tools", () => {
  const registeredTools: Array<{
    name: string;
    parameters: unknown;
    renderCall?: unknown;
    renderResult?: unknown;
  }> = [];
  const commands: string[] = [];
  const pi = {
    registerTool(definition: { name: string; parameters: unknown }) {
      registeredTools.push(definition);
    },
    registerCommand(name: string) {
      commands.push(name);
    },
    registerEntryRenderer() {},
    appendEntry() {},
    on() {},
  } as unknown as ExtensionAPI;

  outlinerExtension(pi);

  expect(commands).toEqual([
    "outliner",
    "outliner-task",
    "capture",
    "send-to-outline",
    "outliner-goto",
    "outliner-filter",
  ]);
  expect(registeredTools.map((definition) => definition.name)).toEqual([
    "outliner_task",
    "outliner_delivery",
    "outliner_focus",
    "outliner_publish",
    "outliner_create",
    "outliner_roadmap_create",
    "outliner_branch_rank",
    "outliner_capture",
    "outliner_annotations",
    "outliner_annotate",
    "outliner_annotation_reply",
    "outliner_annotation_lifecycle",
    "outliner_annotation_batch",
    "outliner_attention",
    "outliner_workflow",
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
  expect(registeredTools.every((definition) =>
    typeof definition.renderCall === "function" && typeof definition.renderResult === "function"
  )).toBe(true);
  const createSchema = JSON.stringify(
    registeredTools.find((definition) => definition.name === "outliner_create")?.parameters,
  );
  const updateSchema = JSON.stringify(
    registeredTools.find((definition) => definition.name === "outliner_update")?.parameters,
  );
  const attentionSchema = JSON.stringify(
    registeredTools.find((definition) => definition.name === "outliner_attention")?.parameters,
  );
  const workflowSchema = JSON.stringify(
    registeredTools.find((definition) => definition.name === "outliner_workflow")?.parameters,
  );
  expect(createSchema).not.toContain("author");
  expect(updateSchema).toContain("expectedUpdatedAt");
  expect(attentionSchema).toContain("advance");
  expect(attentionSchema).toContain("clientId");
  expect(attentionSchema).toContain("expiresInMs");
  expect(workflowSchema).toContain("walkthrough");
  expect(workflowSchema).toContain("promotion_preview");
  expect(workflowSchema).not.toContain("javascript");
});

test("loads command support without a custom entry renderer", () => {
  const commands: string[] = [];
  const pi = {
    registerTool() {},
    registerCommand(name: string) {
      commands.push(name);
    },
    appendEntry() {},
    on() {},
  } as unknown as ExtensionAPI;

  expect(() => createOutlinerExtension("omp")(pi)).not.toThrow();
  expect(commands).toContain("send-to-outline");
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
    registerEntryRenderer() {},
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
        action === "selection.get" || action === "work-ids.status" ||
        action === "activity.recent"
      ),
    ).toBe(true);
  } finally {
    OutlinerClient.prototype.request = originalRequest;
    if (originalHerdrEnv === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = originalHerdrEnv;
  }
});

test("injects bounded user edit activity, deduplicates selection, and restores its watermark", async () => {
  type EventHandler = (
    event: Record<string, unknown>,
    context: ExtensionContext,
  ) => Promise<unknown> | unknown;
  const handlers = new Map<string, EventHandler>();
  const appended: Array<{ type: string; data: unknown }> = [];
  const activityRequests: RequestInput[] = [];
  const originalRequest = OutlinerClient.prototype.request;
  const originalHerdrEnv = process.env.HERDR_ENV;
  process.env.HERDR_ENV = "0";
  let activityPage: BlockEditActivityPage = {
    cursor: 11,
    entries: [
      {
        cursor: 11,
        block: {
          id: "recent-block",
          parentId: null,
          position: 0,
          text: `Recent title\n${"context ".repeat(100)}`,
          author: "agent",
          actorId: "omp",
          createdAt: "created",
          updatedAt: "updated",
          properties: [],
        },
        author: "user",
        actorId: "detail",
        kind: "text",
        editedAt: "2026-09-01T01:02:03.000Z",
      },
      {
        cursor: 10,
        block: {
          id: "focused-block",
          parentId: null,
          position: 0,
          text: "Focused title",
          author: "user",
          createdAt: "created",
          updatedAt: "updated",
          properties: [],
        },
        author: "user",
        actorId: "tree",
        kind: "text",
        editedAt: "2026-09-01T01:00:00.000Z",
      },
    ],
  };
  OutlinerClient.prototype.request = async function <T>(input: RequestInput): Promise<T> {
    if (input.action === "selection.get") {
      return {
        selected: {
          id: "focused-block",
          parentId: null,
          position: 0,
          text: `Focused title\n${"body ".repeat(500)}`,
          author: "user",
          createdAt: "created",
          updatedAt: "updated",
          properties: [],
        },
        ancestors: [],
        children: [],
      } as T;
    }
    if (input.action === "activity.recent") {
      activityRequests.push(input);
      return activityPage as T;
    }
    if (input.action === "work-ids.status") throw new Error("not configured");
    throw new Error(`Unexpected request: ${input.action}`);
  };
  const pi = {
    registerCommand() {},
    registerTool() {},
    registerEntryRenderer() {},
    on(name: string, handler: EventHandler) {
      handlers.set(name, handler);
    },
    appendEntry(type: string, data: unknown) {
      appended.push({ type, data });
    },
  } as unknown as ExtensionAPI;
  const context = {
    sessionManager: {
      getSessionId: () => "restored-session",
      getBranch: () => [{
        type: "custom",
        customType: "pi-outliner.activity-watermark",
        data: { version: 1, cursor: 7 },
      }],
    },
    ui: {
      setStatus() {},
      notify() {},
    },
  } as unknown as ExtensionContext;

  try {
    createOutlinerExtension("omp")(pi);
    await handlers.get("session_start")!({}, context);
    const first = await handlers.get("before_agent_start")!({
      systemPrompt: "base",
      prompt: "continue",
    }, context) as { systemPrompt: string };
    expect(activityRequests[0]).toMatchObject({
      action: "activity.recent",
      afterCursor: 7,
      limit: 5,
      author: "user",
    });
    expect(first.systemPrompt).toContain("Recently user-edited Outliner blocks:");
    expect(first.systemPrompt).toContain(
      "[recent-block] Recent title · edited 2026-09-01T01:02:03.000Z",
    );
    expect(first.systemPrompt.match(/\[focused-block\]/g)).toHaveLength(1);
    expect(first.systemPrompt.length).toBeLessThanOrEqual(4_010);
    expect(appended).toContainEqual({
      type: "pi-outliner.activity-watermark",
      data: { version: 1, cursor: 11 },
    });

    activityPage = { entries: [], cursor: 11 };
    await handlers.get("before_agent_start")!({
      systemPrompt: "base",
      prompt: "continue",
    }, context);
    expect(activityRequests[1]).toMatchObject({
      action: "activity.recent",
      afterCursor: 11,
    });
    expect(appended).toHaveLength(1);
  } finally {
    OutlinerClient.prototype.request = originalRequest;
    if (originalHerdrEnv === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = originalHerdrEnv;
  }
});

test("orients Pi and OMP sessions from live Git state without mutating the repository", async () => {
  type EventHandler = (event: any, context: ExtensionContext) => Promise<unknown> | unknown;
  const originalRequest = OutlinerClient.prototype.request;
  const originalHerdrEnv = process.env.HERDR_ENV;
  const task: Block = {
    id: "task-pie-182",
    parentId: null,
    position: 0,
    text: "PIE-182 lifecycle [type::roadmap-item] [work-id::PIE-182] [work-stage::doing]",
    author: "agent",
    createdAt: "created",
    updatedAt: "updated",
    properties: [
      { key: "type", value: "roadmap-item" },
      { key: "work-id", value: "PIE-182" },
      { key: "work-stage", value: "doing" },
    ],
  };
  OutlinerClient.prototype.request = async function <T>(input: RequestInput): Promise<T> {
    if (input.action === "ping") {
      return { protocolVersion: OUTLINER_PROTOCOL_VERSION } as T;
    }
    if (input.action === "get") return task as T;
    if (input.action === "blocks.context") {
      return { selected: task, ancestors: [], children: [] } as T;
    }
    if (input.action === "activity.recent") {
      return { entries: [], cursor: 0 } as T;
    }
    if (input.action === "work-ids.status") throw new Error("not configured");
    throw new Error(`Unexpected request: ${input.action}`);
  };
  process.env.HERDR_ENV = "0";

  try {
    for (const actor of ["pi", "omp"] as const) {
      const handlers = new Map<string, EventHandler>();
      const statuses: Array<[string, string | undefined]> = [];
      let branch = "feature/pie-182-lifecycle-status";
      const pi = {
        registerCommand() {},
        registerTool() {},
        registerEntryRenderer() {},
        appendEntry() {},
        on(name: string, handler: EventHandler) {
          handlers.set(name, handler);
        },
        async exec(_command: string, args: string[]) {
          if (args.includes("--show-toplevel")) {
            return { stdout: "/repo\n", stderr: "", code: 0, killed: false };
          }
          if (args.includes("status")) {
            return {
              stdout: [
                "# branch.oid 1234567890abcdef",
                `# branch.head ${branch}`,
                "# branch.ab +0 -0",
                "",
              ].join("\n"),
              stderr: "",
              code: 0,
              killed: false,
            };
          }
          if (args.includes("remote.origin.url")) {
            return {
              stdout: "git@github.com:float-ritual-stack/pi-herdr-outliner.git\n",
              stderr: "",
              code: 0,
              killed: false,
            };
          }
          throw new Error(`Unexpected Git invocation: ${args.join(" ")}`);
        },
      } as unknown as ExtensionAPI;
      const context = {
        cwd: "/repo",
        signal: undefined,
        isIdle: () => true,
        sessionManager: {
          getSessionId: () => `${actor}-session`,
          getBranch: () => [{
            type: "custom",
            customType: "pi-outliner.active-task",
            data: { version: 1, blockId: task.id },
          }],
        },
        ui: {
          setStatus(key: string, value: string | undefined) {
            statuses.push([key, value]);
          },
          notify() {},
        },
      } as unknown as ExtensionContext;

      createOutlinerExtension(actor)(pi);
      await handlers.get("session_start")!({}, context);
      expect(statuses).toContainEqual([
        "pi-outliner-work",
        "PIE-182 · feature/pie-182-lifecycle-status · clean",
      ]);

      const beforeAgentStart = handlers.get("before_agent_start")!;
      const first = await beforeAgentStart({
        systemPrompt: "base",
        prompt: "continue",
      }, context) as { systemPrompt: string };
      expect(first.systemPrompt).toContain(
        "Work environment: PIE-182 · repo float-ritual-stack/pi-herdr-outliner · branch feature/pie-182-lifecycle-status · clean · ahead 0 · behind 0",
      );
      expect(first.systemPrompt).not.toContain("Reorientation required");

      branch = "main";
      const mismatched = await beforeAgentStart({
        systemPrompt: "base",
        prompt: "continue",
      }, context) as { systemPrompt: string };
      expect(mismatched.systemPrompt).toContain(
        "Reorientation required before task work: active task PIE-182; current branch main",
      );
      const repeated = await beforeAgentStart({
        systemPrompt: "base",
        prompt: "continue",
      }, context) as { systemPrompt: string };
      expect(repeated.systemPrompt).toContain("Reorientation required before task work");
    }
  } finally {
    OutlinerClient.prototype.request = originalRequest;
    if (originalHerdrEnv === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = originalHerdrEnv;
  }
});
test("gates Pi and OMP mutation and session changes against durable delivery identity", async () => {
  const originalRequest = OutlinerClient.prototype.request;
  const originalHerdrEnv = process.env.HERDR_ENV;
  process.env.HERDR_ENV = "0";
  const taskText =
    "PIE-182 lifecycle [type::roadmap-item] [work-id::PIE-182] [work-stage::doing]";
  const task: Block = {
    id: "task-pie-182",
    parentId: null,
    position: 0,
    text: taskText,
    author: "agent",
    createdAt: "created",
    updatedAt: "task-v1",
    properties: parseProperties(taskText),
  };

  try {
    for (const actor of ["pi", "omp"] as const) {
      let branch = "feature/pie-182-lifecycle";
      let deliveryText = [
        "Delivery PIE-182/enforcement",
        "[type::delivery] [delivery-key::PIE-182/enforcement]",
        "[repository::org/repo] [base-branch::main]",
        "[work-branch::feature/pie-182-lifecycle] [delivery-stage::work]",
      ].join(" ");
      let delivery: Block = {
        id: `delivery-${actor}`,
        parentId: task.id,
        position: 0,
        text: deliveryText,
        author: "agent",
        createdAt: "created",
        updatedAt: "delivery-v1",
        properties: parseProperties(deliveryText),
      };
      OutlinerClient.prototype.request = async function <T>(input: RequestInput): Promise<T> {
        if (input.action === "ping") {
          return { status: "ready", protocolVersion: OUTLINER_PROTOCOL_VERSION } as T;
        }
        if (input.action === "get") return task as T;
        if (input.action === "children") return [delivery] as T;
        if (input.action === "properties.patch") {
          expect(input.blockId).toBe(delivery.id);
          deliveryText = patchPropertyText(delivery.text, input.operations);
          delivery = {
            ...delivery,
            text: deliveryText,
            properties: parseProperties(deliveryText),
            updatedAt: `${delivery.updatedAt}-next`,
          };
          return delivery as T;
        }
        throw new Error(`Unexpected request: ${input.action}`);
      };

      type EventHandler = (
        event: Record<string, unknown>,
        context: ExtensionContext,
      ) => Promise<unknown> | unknown;
      const handlers = new Map<string, EventHandler>();
      interface LifecycleTool {
        execute(
          id: string,
          params: Record<string, unknown>,
          signal: AbortSignal | undefined,
          onUpdate: unknown,
          context: ExtensionContext,
        ): Promise<{ content: Array<{ type: string; text: string }> }>;
      }
      const tools = new Map<string, LifecycleTool>();
      const sessionEntries: Array<Record<string, unknown>> = [{
        type: "custom",
        customType: "pi-outliner.active-task",
        data: { version: 1, blockId: task.id },
      }];
      const confirmations: string[] = [];
      const pi = {
        registerCommand() {},
        registerTool(definition: { name: string } & LifecycleTool) {
          tools.set(definition.name, definition);
        },
        registerEntryRenderer() {},
        appendEntry() {},
        on(name: string, handler: EventHandler) {
          handlers.set(name, handler);
        },
        async exec(command: string, args: string[]) {
          expect(command).toBe("git");
          if (args.includes("--show-toplevel")) {
            return { stdout: "/repo\n", stderr: "", code: 0, killed: false };
          }
          if (args.includes("status")) {
            return {
              stdout: [
                "# branch.oid abcdef1234567890",
                `# branch.head ${branch}`,
                "# branch.ab +0 -0",
                "",
              ].join("\n"),
              stderr: "",
              code: 0,
              killed: false,
            };
          }
          if (args.includes("remote.origin.url")) {
            return {
              stdout: "git@github.com:org/repo.git\n",
              stderr: "",
              code: 0,
              killed: false,
            };
          }
          throw new Error(`Unexpected Git call: ${args.join(" ")}`);
        },
      } as unknown as ExtensionAPI;
      const context = {
        cwd: "/repo",
        signal: undefined,
        sessionManager: {
          getSessionId: () => `${actor}-session`,
          getBranch: () => sessionEntries,
        },
        ui: {
          setStatus() {},
          notify() {},
          async confirm(_title: string, message: string) {
            confirmations.push(message);
            return true;
          },
        },
      } as unknown as ExtensionContext;

      createOutlinerExtension(actor)(pi);
      await handlers.get("session_start")!({}, context);
      const toolCall = handlers.get("tool_call")!;
      expect(await toolCall({ toolName: "read", input: { path: "src" } }, context)).toBeUndefined();
      expect(await toolCall({ toolName: "write", input: { path: "src/a.ts" } }, context))
        .toBeUndefined();
      expect(await toolCall({
        toolName: "github",
        input: { op: "pr_create", repo: "org/repo", head: "feature/pie-182-lifecycle" },
      }, context)).toEqual(expect.objectContaining({
        block: true,
        reason: expect.stringContaining("base must be explicitly set to main"),
      }));
      expect(await toolCall({
        toolName: "github",
        input: { op: "pr_create", repo: "org/repo", base: "main", head: "wrong" },
      }, context)).toEqual(expect.objectContaining({
        block: true,
        reason: expect.stringContaining("head must be explicitly set to feature/pie-182-lifecycle"),
      }));

      branch = "main";
      expect(await toolCall({ toolName: "write", input: { path: "src/a.ts" } }, context))
        .toEqual(expect.objectContaining({
          block: true,
          reason: expect.stringContaining("requires branch feature/pie-182-lifecycle"),
        }));
      expect(await handlers.get("session_before_switch")!({}, context)).toEqual({ cancel: true });
      expect(await handlers.get("session_before_fork")!({}, context)).toEqual({ cancel: true });
      expect(await handlers.get("session_before_tree")!({}, context)).toEqual({ cancel: true });

      await tools.get("outliner_delivery")!.execute(
        "override",
        { operation: "override", reason: "Owner-approved emergency repair" },
        undefined,
        undefined,
        context,
      );
      expect(confirmations).toEqual([
        "PIE-182/enforcement: Owner-approved emergency repair",
      ]);
      expect(delivery.properties).toEqual(expect.arrayContaining([
        { key: "lifecycle-override", value: "active" },
        { key: "lifecycle-override-reason", value: "Owner-approved emergency repair" },
      ]));
      expect(await toolCall({ toolName: "write", input: { path: "src/a.ts" } }, context))
        .toBeUndefined();
      expect(await handlers.get("session_before_switch")!({}, context)).toBeUndefined();

      sessionEntries.push({
        type: "message",
        message: {
          role: "assistant",
          content: [{
            type: "toolCall",
            name: "outliner_task",
            arguments: { operation: "start", address: "PIE-200" },
          }],
        },
      });
      expect(await toolCall({ toolName: "write", input: { path: "src/a.ts" } }, context))
        .toEqual(expect.objectContaining({
          block: true,
          reason: expect.stringContaining("cannot be sibling tool calls"),
        }));
    }
  } finally {
    OutlinerClient.prototype.request = originalRequest;
    if (originalHerdrEnv === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = originalHerdrEnv;
  }
});

test("recognizes lifecycle mutation tools and nested task-start calls", () => {
  expect(isLifecycleMutationTool("functions.write", {})).toBe(true);
  expect(isLifecycleMutationTool("read", {})).toBe(false);
  expect(isLifecycleMutationTool("github", { op: "pr_create" })).toBe(true);
  expect(containsTaskStartToolCall({
    message: {
      content: [{
        name: "outliner_task",
        input: { operation: "start", address: "PIE-200" },
      }],
    },
  })).toBe(true);
});

test("drives an explicit task through context, focus, durable proof, and completion", async () => {

  interface ToolDefinition {
    name: string;
    execute(
      id: string,
      params: {
        operation?:
          | "status"
          | "start"
          | "pause"
          | "complete"
          | "clear"
          | "ensure"
          | "sync"
          | "override";
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

  const taskText = [
    "PIE-144 — Agent [context::inline-before] workflow [type::roadmap-item]",
    "owner:: evan",
    "[status::planned] [priority::high]",
    "[work-stage::next] [work-id::PIE-144] [depends-on::dependency-id]",
  ].join("\n");

  let task: Block = {
    id: "task-id",
    parentId: null,
    position: 0,
    text: taskText,
    author: "agent",
    createdAt: "created",
    updatedAt: "v1",
    properties: parseProperties(taskText),
  };
  const dependency: Block = {
    ...task,
    id: "dependency-id",
    text: "Completed dependency",
    updatedAt: "dependency-v1",
    properties: [{ key: "status", value: "complete" }],
  };
  let artifact: Block | null = null;
  let deliveryRecord: Block | null = null;
  let pullRequestState: "none" | "open" | "merged" = "none";
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, EventHandler>();
  const requests: RequestInput[] = [];
  const sessionEntries: Array<Record<string, unknown>> = [];
  const statuses: Array<string | undefined> = [];
  const diagnostic = spyOn(console, "error").mockImplementation(() => {});
  const originalRequest = OutlinerClient.prototype.request;
  const originalHerdrEnv = process.env.HERDR_ENV;
  const originalHerdrBinPath = process.env.HERDR_BIN_PATH;
  const originalHerdrPaneId = process.env.HERDR_PANE_ID;
  const herdrDirectory = mkdtempSync(join(tmpdir(), "pi-outliner-extension-herdr-"));
  const herdr = join(herdrDirectory, "fake-herdr");
  const herdrLog = join(herdrDirectory, "calls.jsonl");
  const herdrFailureMarker = join(herdrDirectory, "failed-current-pane");
  writeFileSync(
    herdr,
    [
      "#!/usr/bin/env bun",
      'import { appendFileSync, existsSync, writeFileSync } from "node:fs";',
      "const args = process.argv.slice(2);",
      `appendFileSync(${JSON.stringify(herdrLog)}, JSON.stringify(args) + "\\n");`,
      `if (args[0] === "pane" && args[1] === "current" && !existsSync(${JSON.stringify(herdrFailureMarker)})) { writeFileSync(${JSON.stringify(herdrFailureMarker)}, "failed"); console.error("x".repeat(900)); process.exit(1); }`,
      'console.log(JSON.stringify({ result: { pane: { pane_id: "moved-pane", terminal_id: "stable-terminal", workspace_id: "workspace", tab_id: "tab" } } }));',
      "",
    ].join("\n"),
  );
  chmodSync(herdr, 0o755);
  process.env.HERDR_ENV = "1";
  process.env.HERDR_BIN_PATH = herdr;
  process.env.HERDR_PANE_ID = "launch-pane";

  OutlinerClient.prototype.request = async function <T>(input: RequestInput): Promise<T> {
    requests.push(input);
    if (input.action === "ping") {
      return { status: "ready", protocolVersion: OUTLINER_PROTOCOL_VERSION } as T;
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
      const blocks = [
        task,
        dependency,
        ...(deliveryRecord ? [deliveryRecord] : []),
        ...(artifact ? [artifact] : []),
      ];
      return {
        physical: {
          blocks: blocks.map((block) => ({
            ...block,
            depth: 0,
            hasChildren: block.id === task.id && (artifact !== null || deliveryRecord !== null),
            displayText: block.text,
          })),
          completeness: { kind: "complete" },
        },
      } as unknown as T;
    }
    if (input.action === "properties.patch") {
      const target = input.blockId === task.id
        ? task
        : input.blockId === deliveryRecord?.id
        ? deliveryRecord
        : null;
      if (!target) throw new Error(`Unknown patch target: ${input.blockId}`);
      const text = patchPropertyText(target.text, input.operations);
      const updated = {
        ...target,
        text,
        properties: parseProperties(text),
        updatedAt: `v${Number(target.updatedAt.slice(1)) + 1}`,
      };
      if (target.id === task.id) task = updated;
      else deliveryRecord = updated;
      return updated as T;
    }
    if (input.action === "deliveries.ensure") {
      if (deliveryRecord) {
        return { task, delivery: deliveryRecord, created: false } as T;
      }
      const { deliveryKey, repository, baseBranch, workBranch } = input.input;
      const text = [
        `Delivery ${deliveryKey}`,
        `[type::delivery] [delivery-key::${deliveryKey}]`,
        `[repository::${repository}] [base-branch::${baseBranch}]`,
        `[work-branch::${workBranch}] [delivery-stage::work]`,
      ].join(" ");
      deliveryRecord = {
        id: "delivery-id",
        parentId: task.id,
        position: 0,
        text,
        author: "agent",
        createdAt: "created",
        updatedAt: "v1",
        properties: parseProperties(text),
      };
      return { task, delivery: deliveryRecord, created: true } as T;
    }
    if (input.action === "children") {
      return [
        ...(deliveryRecord ? [deliveryRecord] : []),
        ...(artifact ? [artifact] : []),
      ] as T;
    }
    if (input.action === "get") {
      const block = input.blockId === task.id
        ? task
        : input.blockId === dependency.id
        ? dependency
        : deliveryRecord?.id === input.blockId
        ? deliveryRecord
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
    registerEntryRenderer() {},
    on(name: string, handler: EventHandler) {
      handlers.set(name, handler);
    },
    appendEntry(customType: string, data: unknown) {
      sessionEntries.push({ type: "custom", customType, data });
    },
    async exec(command: string, args: string[]) {
      if (command === "gh") {
        return {
          stdout: pullRequestState === "none"
            ? "[]"
            : JSON.stringify([{
              number: 44,
              url: "https://github.com/org/repo/pull/44",
              state: pullRequestState === "merged" ? "MERGED" : "OPEN",
              baseRefName: "main",
              headRefName: "feature/pie-144-lifecycle",
              reviewDecision: pullRequestState === "merged" ? "APPROVED" : "",
              mergeCommit: pullRequestState === "merged" ? { oid: "merge-commit" } : null,
            }]),
          stderr: "",
          code: 0,
          killed: false,
        };
      }
      if (args.includes("--show-toplevel")) {
        return { stdout: "/repo\n", stderr: "", code: 0, killed: false };
      }
      if (args.includes("status")) {
        return {
          stdout: [
            "# branch.oid 1234567890abcdef",
            "# branch.head feature/pie-144-lifecycle",
            "# branch.ab +0 -0",
            "",
          ].join("\n"),
          stderr: "",
          code: 0,
          killed: false,
        };
      }
      if (args.includes("remote.origin.url")) {
        return {
          stdout: "git@github.com:org/repo.git\n",
          stderr: "",
          code: 0,
          killed: false,
        };
      }
      if (args.includes("symbolic-ref")) {
        return { stdout: "origin/main\n", stderr: "", code: 0, killed: false };
      }
      throw new Error(`Unexpected lifecycle command: ${command} ${args.join(" ")}`);
    },
  } as unknown as ExtensionAPI;
  const context = {
    cwd: "/repo",
    signal: undefined,
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
      promptPaths: string[];
    };
    expect(resources.skillPaths[0]).toEndWith(
      "pi-extension/skills/outliner-workflow/SKILL.md",
    );
    expect(resources.skillPaths[1]).toEndWith(
      "pi-extension/skills/work-placeholder-resolver/SKILL.md",
    );
    expect(resources.promptPaths).toHaveLength(2);
    expect(resources.promptPaths[0]).toEndWith(
      "pi-extension/prompts/roadmap-item.md",
    );
    expect(resources.promptPaths[1]).toEndWith(
      "pi-extension/prompts/roadmap-report.md",
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
    expect(started).toMatchObject({
      blockId: task.id,
      workId: "PIE-144",
      stage: "doing",
      presenceReported: false,
    });
    expect(statuses.at(-1)).toBe("PIE-144");
    const paused = JSON.parse(
      (await tools.get("outliner_task")!.execute(
        "pause-task",
        { operation: "pause" },
        undefined,
        undefined,
        context,
      )).content[0]!.text,
    );
    expect(paused).toMatchObject({
      blockId: task.id,
      workId: "PIE-144",
      stage: "next",
      presenceReported: true,
    });

    const restarted = JSON.parse(
      (await tools.get("outliner_task")!.execute(
        "restart-task",
        { operation: "start", address: "PIE-144" },
        undefined,
        undefined,
        context,
      )).content[0]!.text,
    );
    expect(restarted).toMatchObject({
      blockId: task.id,
      workId: "PIE-144",
      stage: "doing",
      presenceReported: true,
    });

    const beforeResult = await handlers.get("before_agent_start")!({
      systemPrompt: "base prompt",
      prompt: "implement it",
    }, context) as { systemPrompt: string };
    expect(beforeResult.systemPrompt).toContain("Outliner active task context:");
    expect(beforeResult.systemPrompt).toContain("Active task: [task-id] PIE-144 — Agent workflow");
    expect(beforeResult.systemPrompt).toContain("Completed dependency · status=complete");
    expect(beforeResult.systemPrompt).toContain("outliner_publish");

    pullRequestState = "open";
    const reviewing = JSON.parse(
      (await tools.get("outliner_delivery")!.execute(
        "sync-open-pr",
        { operation: "sync" },
        undefined,
        undefined,
        context,
      )).content[0]!.text,
    );
    expect(reviewing.pullRequest).toMatchObject({ number: 44, state: "OPEN" });
    expect(reviewing.task.properties).toContainEqual({ key: "work-stage", value: "review" });
    expect(reviewing.delivery.stage).toBe("review");

    process.env.HERDR_ENV = "0";
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
    const uiCommandsBeforePublish = requests.filter(
      (request) => request.action === "ui.command.send",
    ).length;

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
      focused: false,
    });
    expect(requests.filter((request) => request.action === "ui.command.send")).toHaveLength(
      uiCommandsBeforePublish,
    );
    process.env.HERDR_ENV = "1";
    const create = requests.find(
      (request): request is Extract<RequestInput, { action: "create" }> =>
        request.action === "create",
    )!;
    expect(create.parentId).toBe(task.id);
    expect(create.text).toContain("[type::implementation-proof]");
    expect(create.text).toContain(`[source-block::${task.id}]`);

    pullRequestState = "merged";
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
    expect(completed.presenceReported).toBe(true);
    expect(sessionEntries.map((entry) => entry.data)).toEqual([
      { version: 1, blockId: task.id },
      { version: 1, blockId: null },
      { version: 1, blockId: task.id },
      { version: 1, blockId: null },
    ]);
    expect(task.properties).toEqual(expect.arrayContaining([
      { key: "work-stage", value: "done" },
      { key: "status", value: "complete" },
      { key: "proof", value: "proof-id" },
    ]));
    expect(task.text).toContain("[context::inline-before]");
    expect(task.properties).toEqual(expect.arrayContaining([
      { key: "priority", value: "high" },
      { key: "owner", value: "evan" },
    ]));
    const transitions = requests.filter(
      (request): request is Extract<RequestInput, { action: "properties.patch" }> =>
        request.action === "properties.patch" && request.blockId === task.id,
    );
    expect(transitions.map(({ operations }) => operations)).toEqual([
      [{ op: "replace", ordinal: 5, value: "doing" }],
      [{ op: "replace", ordinal: 5, value: "next" }],
      [{ op: "replace", ordinal: 5, value: "doing" }],
      [{ op: "replace", ordinal: 5, value: "review" }],
      [{ op: "replace", ordinal: 5, value: "validate" }],
      [
        { op: "replace", ordinal: 3, value: "complete" },
        { op: "replace", ordinal: 5, value: "done" },
        { op: "append", key: "proof", value: "proof-id" },
      ],
    ]);
    const herdrCalls = readFileSync(herdrLog, "utf8").trim().split("\n").map(
      (line) => JSON.parse(line) as string[],
    );
    const currentPaneCalls = herdrCalls.filter(
      (args) => args[0] === "pane" && args[1] === "current",
    );
    expect(currentPaneCalls).toHaveLength(4);
    const metadataCalls = herdrCalls.filter(
      (args) => args[0] === "pane" && args[1] === "report-metadata",
    );
    expect(metadataCalls).toHaveLength(3);
    expect(metadataCalls.map((args) => args[2])).toEqual([
      "moved-pane",
      "moved-pane",
      "moved-pane",
    ]);
    expect(metadataCalls.some((args) => args.includes("launch-pane"))).toBe(false);
    expect(diagnostic).toHaveBeenCalledTimes(1);
    const identityDiagnostic = String(diagnostic.mock.calls[0]![0]);
    expect(identityDiagnostic).toContain("Current Herdr pane identity is unavailable");
    expect(identityDiagnostic).toHaveLength(512);
    expect(identityDiagnostic).toEndWith("…");
    expect(statuses.at(-1)).toBeUndefined();
  } finally {
    OutlinerClient.prototype.request = originalRequest;
    diagnostic.mockRestore();
    if (originalHerdrEnv === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = originalHerdrEnv;
    if (originalHerdrBinPath === undefined) delete process.env.HERDR_BIN_PATH;
    else process.env.HERDR_BIN_PATH = originalHerdrBinPath;
    if (originalHerdrPaneId === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = originalHerdrPaneId;
    rmSync(herdrDirectory, { recursive: true, force: true });
  }
});

test("requires the current protocol, attributes agent creates and page follows, and presents bounded query results", async () => {
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
  let protocolVersion: number = OUTLINER_PROTOCOL_VERSION;
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
    if (input.action === "properties.catalog") return [] as T;
    if (input.action === "create") return {} as T;
    if (input.action === "roadmap.items.create") {
      return {
        workId: "PIE-153",
        workQueueId: "work-queue",
        block: { id: "roadmap-block" },
        memberships: [{ viewId: "next-view", title: "Next" }],
      } as T;
    }
    if (input.action === "virtual.occurrences.reorder") {
      return input.orderedBlockIds.map((blockId, rank) => ({
        viewId: input.viewId,
        blockId,
        rank,
      })) as T;
    }
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
      params: Partial<RoadmapItemCreateInput> & {
        text?: string;
        limit?: number;
        key?: string;
        propertyScope?: "block" | "line" | "inline" | "all";
        parentId?: string | null;
        operation?: "follow" | "status" | "configure" | "allocate";
        address?: string;
        blockId?: string;
        expectedUpdatedAt?: string;
        prefix?: string;
        role?: "tree" | "detail";
        viewId?: string;
        orderedBlockIds?: string[];
      },
      signal?: AbortSignal,
      onUpdate?: unknown,
      context?: ExtensionContext,
    ): Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;
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
    registerEntryRenderer() {},
    appendEntry() {},
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
    const result = await tools.get("outliner_query")!.execute("query-id", {
      text: "Matching",
      propertyScope: "inline",
    });
    await tools.get("outliner_property_catalog")!.execute("catalog-id", {
      key: "status",
      propertyScope: "all",
    });
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
    const roadmapResult = await tools.get("outliner_roadmap_create")!.execute(
      "roadmap-create-test",
      {
        title: "Atomic roadmap",
        body: "Complete contract",
        priority: "high",
        project: "pi-outliner",
        arc: "safety-agency",
        tracks: ["interactive-documents"],
        relatedTo: ["related-block"],
      },
      undefined,
      undefined,
      context,
    );
    const rankResult = await tools.get("outliner_branch_rank")!.execute(
      "rank-test",
      {
        viewId: "next-view",
        orderedBlockIds: ["roadmap-block", "other-block"],
      },
    );
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
        query: { text: "Matching", propertyScope: "inline", limit: 100 },
      },
    ]);
    expect(requests.find((request) => request.action === "properties.catalog")).toEqual({
      action: "properties.catalog",
      key: "status",
      propertyScope: "all",
    });
    expect(requests.find((request) => request.action === "create")).toEqual({
      action: "create",
      text: "Agent-created artifact",
      parentId: null,
      author: "agent",
      provenance: {
        actorId: "pi",
        sessionId: "session-test",
        taskId: "tool-call-test",
      },
    });
    expect(requests.find((request) => request.action === "pages.follow")).toEqual({
      action: "pages.follow",
      address: "Agent Page",
      author: "agent",
      provenance: {
        actorId: "pi",
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
    expect(requests.find((request) => request.action === "roadmap.items.create")).toEqual({
      action: "roadmap.items.create",
      input: {
        title: "Atomic roadmap",
        body: "Complete contract",
        priority: "high",
        project: "pi-outliner",
        arc: "safety-agency",
        tracks: ["interactive-documents"],
        relatedTo: ["related-block"],
      },
      author: "agent",
      provenance: {
        actorId: "pi",
        sessionId: "session-test",
        taskId: "roadmap-create-test",
      },
    });
    expect(requests.find((request) =>
      request.action === "virtual.occurrences.reorder"
    )).toEqual({
      action: "virtual.occurrences.reorder",
      viewId: "next-view",
      orderedBlockIds: ["roadmap-block", "other-block"],
    });
    expect(JSON.parse(roadmapResult.content[0]!.text)).toMatchObject({
      workId: "PIE-153",
      workQueueId: "work-queue",
    });
    expect(JSON.parse(rankResult.content[0]!.text)).toEqual({
      viewId: "next-view",
      ranks: [
        { viewId: "next-view", blockId: "roadmap-block", rank: 0 },
        { viewId: "next-view", blockId: "other-block", rank: 1 },
      ],
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
    expect(result.details).toEqual({
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
      "Outliner protocol 5 does not match this session's extension protocol 32. Run /reload, then retry.",
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
    ): Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;
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
  const appendedEntries: Array<{ customType: string; data: unknown }> = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const requests: RequestInput[] = [];
  let captureFailure: Error | null = null;
  let captureIndex = 0;
  const originalHerdrEnv = process.env.HERDR_ENV;
  process.env.HERDR_ENV = "0";
  const originalRequest = OutlinerClient.prototype.request;
  OutlinerClient.prototype.request = async function <T>(input: RequestInput): Promise<T> {
    requests.push(input);
    if (input.action === "ping") {
      return { status: "ready", protocolVersion: OUTLINER_PROTOCOL_VERSION } as T;
    }
    if (input.action === "selection.get") {
      return {
        selected: selectionBlock,
        ancestors: [],
        children: [],
      } as T;
    }
    if (input.action === "clients.list") {
      return [{
        clientId: "tree-client",
        role: "tree",
        contextId: "tree-context",
      }] as T;
    }
    if (input.action === "selection.set") {
      return { selected: selectionBlock, ancestors: [], children: [] } as T;
    }
    if (input.action === "ui.command.send") return { delivered: true } as T;
    if (input.action === "navigation.dispatch") {
      return {
        sourceClientId: input.sourceClientId,
        targetClientId: "detail-client",
        command: "open",
        intent: "open",
        blockId: input.blockId,
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
    registerEntryRenderer() {},
    appendEntry(customType: string, data: unknown) {
      appendedEntries.push({ customType, data });
    },
    on(name: string, handler: InputHandler) {
      if (name === "input") handlers.set(name, handler);
    },
  } as unknown as ExtensionAPI;
  const context = {
    sessionManager: {
      getSessionId: () => "session-capture",
      getBranch: () => [
        {
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Roadmap analysis before the advisory." }],
          },
        },
        {
          type: "custom_message",
          customType: "advisor",
          content: "Synthesize without more queries",
        },
        {
          type: "message",
          message: {
            role: "assistant",
            content: [{
              type: "text",
              text:
                "Latest assistant response with [[page]], ((block-ref)), and !((embed-ref))\n[type::virtual-branch]",
            }],
          },
        },
      ],
    },
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  } as unknown as ExtensionContext;

  try {
    createOutlinerExtension("omp")(pi);
    await commands.get("capture")!.handler("command capture", context);
    await commands.get("send-to-outline")!.handler("", context);
    const toolResult = await tools.get("outliner_capture")!.execute(
      "tool-capture",
      { text: "tool capture", requestId: "stable-tool-request" },
      undefined,
      undefined,
      context,
    );
    expect(JSON.parse(toolResult.content[0]!.text)).toEqual({
      blockId: "capture-3",
      inboxBlockId: "inbox",
      source: "omp",
      capturedFromBlockId: selectionBlock.id,
      deduplicated: false,
    });
    expect(toolResult.details).toEqual({
      blockId: "capture-3",
      inboxBlockId: "inbox",
      source: "omp",
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
    expect(captures).toHaveLength(4);
    expect(captures[0]).toMatchObject({
      text: "command capture",
      source: "omp",
      capturedFromBlockId: selectionBlock.id,
      author: "user",
    });
    expect(captures[1]).toEqual(expect.objectContaining({
      text: "Roadmap analysis before the advisory.",
      source: "omp",
      author: "agent",
      provenance: {
        actorId: "omp",
        sessionId: "session-capture",
      },
    }));
    expect(captures[2]).toEqual(expect.objectContaining({
      requestId: "stable-tool-request",
      text: "tool capture",
      source: "omp",
      capturedFromBlockId: selectionBlock.id,
      author: "agent",
      provenance: {
        actorId: "omp",
        sessionId: "session-capture",
        taskId: "tool-capture",
      },
    }));
    expect(captures[3]).toMatchObject({
      text: "{remember this 🐢}",
      source: "omp",
      author: "user",
    });
    expect(notifications.some(({ message }) => message.includes("Captured to Inbox"))).toBe(true);
    expect(notifications.some(({ message }) =>
      message.includes("Sent latest response to Inbox and opened it in Detail")
    )).toBe(true);
    expect(appendedEntries).toHaveLength(1);
    expect(appendedEntries[0]).toEqual({
      customType: "outliner-capture-receipt",
      data: expect.objectContaining({
        blockId: "capture-2",
        title: "Roadmap analysis before the advisory.",
        source: "omp",
        deduplicated: false,
        detail: "opened",
      }),
    });
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
    if (originalHerdrEnv === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = originalHerdrEnv;
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

test("prefers the unique Tree in the host tab before cross-tab focus history", () => {
  const trees: OutlinerClientRegistration[] = [
    {
      clientId: "same-tab",
      role: "tree",
      contextId: "same",
      runtime: { paneId: "pane-same", workspaceId: "workspace", tabId: "tab-a" },
    },
    {
      clientId: "other-tab",
      role: "tree",
      contextId: "other",
      runtime: { paneId: "pane-other", workspaceId: "workspace", tabId: "tab-b" },
    },
  ];

  expect(selectCapturedResponseTree(
    trees,
    { paneId: "host", workspaceId: "workspace", tabId: "tab-a" },
    ["pane-other"],
  )).toBe(trees[0]);
});

test("uses same-tab focus history only when that tab has multiple Trees", () => {
  const trees: OutlinerClientRegistration[] = [
    {
      clientId: "first",
      role: "tree",
      contextId: "first",
      runtime: { paneId: "pane-first", workspaceId: "workspace", tabId: "tab-a" },
    },
    {
      clientId: "second",
      role: "tree",
      contextId: "second",
      runtime: { paneId: "pane-second", workspaceId: "workspace", tabId: "tab-a" },
    },
    {
      clientId: "other-tab",
      role: "tree",
      contextId: "other",
      runtime: { paneId: "pane-other", workspaceId: "workspace", tabId: "tab-b" },
    },
  ];
  const host = { paneId: "host", workspaceId: "workspace", tabId: "tab-a" };

  expect(selectCapturedResponseTree(trees, host, ["pane-other", "pane-second"])).toBe(trees[1]);
  expect(selectCapturedResponseTree(trees, host, ["pane-other"])).toBeUndefined();
});