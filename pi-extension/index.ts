import { execFile, spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatFileAnnotation } from "../src/annotations";
import {
  focusBlockByQuery,
  formatBlockFocusMatch,
} from "../src/block-focus";
import {
  BlockQuerySyntaxError,
  parsePropertyFilterExpression,
} from "../src/block-query";
import { parseStandaloneDispatchMarker } from "../src/dispatch-marker";
import { OutlinerClient } from "../src/client";
import { resolvePaths } from "../src/paths";
import { getProperty } from "../src/properties";
import { blockDisplayTitle } from "../src/references";
import {
  OUTLINER_PROTOCOL_VERSION,
  type Block,
  type BlockProvenance,
  type CaptureReceipt,
  type CaptureSource,
  type OutlinerClientRegistration,
  type OutlinerServiceStatus,
  type PropertyCatalogItem,
  type SelectionContext,
  type VisibleBlockCollection,
} from "../src/types";

const execFileAsync = promisify(execFile);
const extensionRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const paths = resolvePaths();
const client = new OutlinerClient(paths.socket);
let headlessServer: ChildProcess | null = null;

const HOST_ACTOR_ID = process.env.OMPCODE ? "omp" : "pi";

function toolProvenance(
  context: ExtensionContext,
  toolCallId: string,
): BlockProvenance {
  return {
    actorId: HOST_ACTOR_ID,
    sessionId: context.sessionManager.getSessionId(),
    taskId: toolCallId,
  };
}

function hostCaptureSource(): CaptureSource {
  return HOST_ACTOR_ID === "omp" ? "omp" : "pi";
}

function compactCaptureReceipt(receipt: CaptureReceipt, source: CaptureSource) {
  const capturedFromBlockId = receipt.block.properties.find(
    (property) => property.key === "captured-from",
  )?.value;
  return {
    blockId: receipt.block.id,
    inboxBlockId: receipt.inboxBlockId,
    source,
    ...(capturedFromBlockId ? { capturedFromBlockId } : {}),
    deduplicated: receipt.deduplicated,
  };
}

async function selectedBlockId(): Promise<string | undefined> {
  const selection = await client.request<SelectionContext>({ action: "selection.get" });
  return selection.selected?.id;
}

const propertyPatchOperationSchema = Type.Union([
  Type.Object({
    op: Type.Literal("replace"),
    ordinal: Type.Integer({ minimum: 0 }),
    key: Type.Optional(Type.String()),
    value: Type.String(),
  }),
  Type.Object({
    op: Type.Literal("remove"),
    ordinal: Type.Integer({ minimum: 0 }),
  }),
  Type.Object({
    op: Type.Literal("append"),
    key: Type.String(),
    value: Type.String(),
  }),
]);

const MAX_TOOL_RESULT_CHARS = 12_000;

function textToolResult(text: string): AgentToolResult<Record<string, never>> {
  return {
    content: [{ type: "text", text }],
    details: {},
  };
}

function toolResult(value: unknown): AgentToolResult<Record<string, never>> {
  const text = JSON.stringify(value, null, 2);
  return textToolResult(
    text.length > MAX_TOOL_RESULT_CHARS ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n…` : text,
  );
}

function serializeQueryResult(
  collection: VisibleBlockCollection,
  blocks: VisibleBlockCollection["blocks"],
): string {
  return JSON.stringify(
    {
      blocks,
      completeness: collection.completeness,
      presentation: {
        returned: collection.blocks.length,
        presented: blocks.length,
        omitted: collection.blocks.length - blocks.length,
      },
    },
    null,
    2,
  );
}

function queryToolResult(
  collection: VisibleBlockCollection,
): AgentToolResult<Record<string, never>> {
  const blocks: VisibleBlockCollection["blocks"] = [];
  let text = serializeQueryResult(collection, blocks);
  for (const block of collection.blocks) {
    blocks.push(block);
    const candidate = serializeQueryResult(collection, blocks);
    if (candidate.length > MAX_TOOL_RESULT_CHARS) {
      blocks.pop();
      break;
    }
    text = candidate;
  }
  return textToolResult(text);
}

function assertCompatibleProtocol(service: OutlinerServiceStatus): void {
  if (service.protocolVersion !== OUTLINER_PROTOCOL_VERSION) {
    throw new Error(
      `Incompatible outliner protocol ${service.protocolVersion}; expected ${OUTLINER_PROTOCOL_VERSION}`,
    );
  }
}

async function pingService(timeoutMs: number): Promise<void> {
  const service = await client.request<OutlinerServiceStatus>({ action: "ping" }, timeoutMs);
  assertCompatibleProtocol(service);
}

async function waitForService(timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await pingService(400);
      return;
    } catch (error) {
      lastError = error;
      await sleep(100);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Outliner service did not start");
}

async function ensureService(focus: boolean): Promise<void> {
  const service = await client
    .request<OutlinerServiceStatus>({ action: "ping" }, 300)
    .catch(() => null);
  if (service) {
    assertCompatibleProtocol(service);
    if (!focus || process.env.HERDR_ENV !== "1") return;
  }

  if (process.env.HERDR_ENV === "1") {
    await execFileAsync(process.execPath, [
      "run",
      join(extensionRoot, "src", "herdr-open.ts"),
      "--mode",
      focus ? "focus-or-open" : "service-only",
    ], {
      cwd: paths.workspaceRoot,
      env: {
        ...process.env,
        HERDR_PLUGIN_ID: "float.pi-outliner",
        OUTLINER_WORKSPACE_ROOT: paths.workspaceRoot,
      },
    });
  } else if (!headlessServer) {
    headlessServer = spawn("bun", ["run", join(extensionRoot, "src", "server-main.ts")], {
      cwd: extensionRoot,
      stdio: "ignore",
      env: { ...process.env, OUTLINER_WORKSPACE_ROOT: paths.workspaceRoot },
    });
  }
  await waitForService();
}

const MAX_SELECTION_CONTEXT_CHARS = 4_000;

export function formatSelection(context: SelectionContext): string {
  const { selected } = context;
  if (!selected) return "";
  const selectedTitle = `[${selected.id}] ${blockDisplayTitle(selected)}`;
  const path = [...context.ancestors, selected].map(blockDisplayTitle).join(" > ");
  const properties = selected.properties
    .slice(0, 20)
    .map((property) => `${property.key}=${property.value}`)
    .join(", ");
  const children = context.children
    .slice(0, 20)
    .map((block) => `- [${block.id}] ${blockDisplayTitle(block)}`)
    .join("\n");
  const content = [
    "Outliner workspace context:",
    `Selected: ${selectedTitle}`,
    `Path: ${path}`,
    properties ? `Properties: ${properties}` : "Properties: none",
    children ? `Children:\n${children}` : "Children: none",
    "Use outliner_selection/get/query for full block text.",
  ].join("\n");
  if (content.length <= MAX_SELECTION_CONTEXT_CHARS) return content;
  const suffix = "\n… context truncated; use outliner tools for full text.";
  return content.slice(0, MAX_SELECTION_CONTEXT_CHARS - suffix.length) + suffix;
}

export default function outlinerExtension(pi: ExtensionAPI): void {
  pi.registerCommand("outliner", {
    description: "Open or focus the persistent Herdr outliner pane",
    handler: async (_args, ctx) => {
      try {
        await ensureService(true);
        ctx.ui.notify("Outliner ready", "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("capture", {
    description: "Capture text to the shared Inbox without starting an agent turn",
    handler: async (args, ctx) => {
      const text = args.trim();
      if (!text) {
        ctx.ui.notify("Usage: /capture <text>", "warning");
        return;
      }
      try {
        await ensureService(false);
        const source = hostCaptureSource();
        const receipt = await client.request<CaptureReceipt>({
          action: "capture.create",
          requestId: crypto.randomUUID(),
          text,
          source,
          capturedFromBlockId: await selectedBlockId(),
          author: "user",
        });
        const summary = compactCaptureReceipt(receipt, source);
        ctx.ui.notify(
          `${receipt.deduplicated ? "Capture already saved" : "Captured to Inbox"} · ${summary.blockId.slice(0, 8)}`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("outliner-goto", {
    description: "Focus a block by full ID, short ID prefix, or fuzzy text",
    handler: async (args, ctx) => {
      const query = args.trim();
      if (!query) {
        ctx.ui.notify("Usage: /outliner-goto <block-id, short prefix, or text>", "warning");
        return;
      }
      try {
        await ensureService(true);
        const result = await focusBlockByQuery(client, query, 10);
        if (result.resolution.kind === "none") {
          ctx.ui.notify(`No block matches: ${query}`, "warning");
          return;
        }
        if (result.resolution.kind === "ambiguous") {
          const candidates = result.resolution.matches
            .slice(0, 5)
            .map((match) => formatBlockFocusMatch(match, match.block.id))
            .join("\n");
          ctx.ui.notify(`Ambiguous block query; retry with a full UUID:\n${candidates}`, "warning");
          return;
        }
        const match = result.resolution.match;
        ctx.ui.notify(`Focused ${formatBlockFocusMatch(match)}`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("outliner-filter", {
    description:
      'Preview blocks matching AND property filters such as type=question status="in progress"',
    handler: async (args, ctx) => {
      await ensureService(false);
      try {
        const filters = parsePropertyFilterExpression(args);
        const { blocks, completeness } = await client.request<VisibleBlockCollection>({
          action: "blocks.query",
          query: { filters, limit: 20 },
        });
        const lines = blocks.length
          ? blocks.map((block) => `${"  ".repeat(block.depth)}• ${block.text}`)
          : ["No matching blocks"];
        if (completeness.kind === "truncated") {
          lines.push(`Results truncated at ${completeness.limit} blocks`);
        }
        ctx.ui.setWidget("pi-outliner-filter", lines, { placement: "belowEditor" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const label = error instanceof BlockQuerySyntaxError ? "Invalid filter" : "Filter failed";
        ctx.ui.setWidget("pi-outliner-filter", [`${label}: ${message}`], {
          placement: "belowEditor",
        });
      }
    },
  });

  pi.registerTool({
    name: "outliner_create",
    label: "Outliner Create",
    description: "Create a durable outliner block for a note, progress update, open question, decision, or artifact",
    promptSnippet: "Create a durable block in the shared outliner workspace",
    parameters: Type.Object({
      text: Type.String({ description: "Block text, optionally containing [property::value] markers" }),
      parentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, context) {
      await ensureService(false);
      const block = await client.request<Block>({
        action: "create",
        text: params.text,
        parentId: params.parentId,
        author: "agent",
        provenance: toolProvenance(context, toolCallId),
      });
      return toolResult(block);
    },
  });

  pi.registerTool({
    name: "outliner_capture",
    label: "Outliner Capture",
    description: "Capture durable text to the shared Inbox without routing or changing selection",
    promptSnippet: "Capture text to the shared outliner Inbox",
    parameters: Type.Object({
      text: Type.String(),
      requestId: Type.Optional(Type.String()),
      capturedFromBlockId: Type.Optional(Type.String()),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, context) {
      await ensureService(false);
      const source = hostCaptureSource();
      const receipt = await client.request<CaptureReceipt>({
        action: "capture.create",
        requestId:
          params.requestId ?? `${context.sessionManager.getSessionId()}:${toolCallId}`,
        text: params.text,
        source,
        capturedFromBlockId: params.capturedFromBlockId ?? await selectedBlockId(),
        author: "agent",
        provenance: toolProvenance(context, toolCallId),
      });
      return textToolResult(JSON.stringify(compactCaptureReceipt(receipt, source), null, 2));
    },
  });

  pi.registerTool({
    name: "outliner_annotate_file",
    label: "Outliner Annotate File",
    description: "Attach a durable line-range comment beneath a file-reference block",
    promptSnippet: "Annotate specific lines of a referenced text or Markdown file",
    parameters: Type.Object({
      sourceBlockId: Type.String({ description: "Block containing the [file::path] property" }),
      startLine: Type.Integer({ minimum: 1 }),
      endLine: Type.Integer({ minimum: 1 }),
      comment: Type.String(),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, context) {
      await ensureService(false);
      const source = await client.request<Block>({ action: "get", blockId: params.sourceBlockId });
      const filePath = getProperty(source.properties, "file");
      if (!filePath) throw new Error(`Block has no [file::path] property: ${source.id}`);
      const text = formatFileAnnotation({ ...params, filePath });
      const annotation = await client.request<Block>({
        action: "create",
        parentId: source.id,
        text,
        author: "agent",
        provenance: toolProvenance(context, toolCallId),
      });
      return toolResult(annotation);
    },
  });

  pi.registerTool({
    name: "outliner_update",
    label: "Outliner Update",
    description: "Update an existing outliner block only if it is still the version the agent read",
    promptSnippet: "Optimistically update a shared outliner block using its updatedAt version",
    parameters: Type.Object({
      blockId: Type.String(),
      text: Type.String(),
      expectedUpdatedAt: Type.String(),
    }),
    async execute(_id, params) {
      await ensureService(false);
      return toolResult(
        await client.request<Block>({
          action: "update",
          blockId: params.blockId,
          text: params.text,
          expectedUpdatedAt: params.expectedUpdatedAt,
        }),
      );
    },
  });

  pi.registerTool({
    name: "outliner_property_patch",
    label: "Outliner Property Patch",
    description: "Replace, remove, or append property tokens without rewriting unrelated block prose",
    promptSnippet: "Patch indexed outliner properties with optimistic concurrency",
    parameters: Type.Object({
      blockId: Type.String(),
      expectedUpdatedAt: Type.String(),
      operations: Type.Array(propertyPatchOperationSchema, { minItems: 1 }),
    }),
    async execute(_id, params) {
      await ensureService(false);
      return toolResult(
        await client.request<Block>({
          action: "properties.patch",
          blockId: params.blockId,
          expectedUpdatedAt: params.expectedUpdatedAt,
          operations: params.operations,
        }),
      );
    },
  });

  pi.registerTool({
    name: "outliner_property_catalog",
    label: "Outliner Property Catalog",
    description: "List observed property key/value pairs with occurrence counts",
    promptSnippet: "Inspect observed outliner property keys and values",
    parameters: Type.Object({
      key: Type.Optional(Type.String()),
      prefix: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    async execute(_id, params) {
      await ensureService(false);
      return toolResult(
        await client.request<PropertyCatalogItem[]>({
          action: "properties.catalog",
          ...params,
        }),
      );
    },
  });

  pi.registerTool({
    name: "outliner_page",
    label: "Outliner Page Address",
    description: "Resolve, follow, complete, rename, alias, or remove a unique symbolic page address",
    promptSnippet: "Use the shared symbolic page-address registry",
    parameters: Type.Object({
      operation: Type.Union([
        Type.Literal("resolve"),
        Type.Literal("follow"),
        Type.Literal("complete"),
        Type.Literal("rename"),
        Type.Literal("alias"),
        Type.Literal("remove"),
      ]),
      address: Type.Optional(
        Type.String({ description: "Required for resolve, follow, rename, alias, and remove" }),
      ),
      blockId: Type.Optional(Type.String({ description: "Required for rename, alias, and remove" })),
      expectedUpdatedAt: Type.Optional(
        Type.String({ description: "Required for rename and remove" }),
      ),
      query: Type.Optional(Type.String({ description: "Optional substring filter for complete" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, context) {
      await ensureService(false);
      const requireField = (value: string | undefined, field: string): string => {
        if (value === undefined || value === "") {
          throw new Error(`outliner_page ${params.operation} requires ${field}`);
        }
        return value;
      };
      switch (params.operation) {
        case "resolve":
          return toolResult(await client.request({
            action: "pages.resolve",
            address: requireField(params.address, "address"),
          }));
        case "follow":
          return toolResult(await client.request({
            action: "pages.follow",
            address: requireField(params.address, "address"),
            author: "agent",
            provenance: toolProvenance(context, toolCallId),
          }));
        case "complete":
          return toolResult(await client.request({
            action: "pages.complete",
            query: params.query,
            limit: params.limit ?? 50,
          }));
        case "rename":
          return toolResult(await client.request({
            action: "pages.rename",
            blockId: requireField(params.blockId, "blockId"),
            address: requireField(params.address, "address"),
            expectedUpdatedAt: requireField(params.expectedUpdatedAt, "expectedUpdatedAt"),
          }));
        case "alias":
          return toolResult(await client.request({
            action: "pages.alias",
            blockId: requireField(params.blockId, "blockId"),
            address: requireField(params.address, "address"),
          }));
        case "remove":
          return toolResult(await client.request({
            action: "pages.remove",
            blockId: requireField(params.blockId, "blockId"),
            address: requireField(params.address, "address"),
            expectedUpdatedAt: requireField(params.expectedUpdatedAt, "expectedUpdatedAt"),
          }));
        default: {
          const unsupported: never = params.operation;
          throw new Error(`Unsupported page operation: ${String(unsupported)}`);
        }
      }
    },
  });

  pi.registerTool({
    name: "outliner_work_id",
    label: "Outliner Work ID",
    description: "Read allocator state or transactionally assign the next immutable project Work ID",
    promptSnippet: "Allocate project-scoped Work IDs through the canonical outliner service",
    parameters: Type.Object({
      operation: Type.Union([
        Type.Literal("status"),
        Type.Literal("configure"),
        Type.Literal("allocate"),
      ]),
      blockId: Type.Optional(Type.String({ description: "Required for allocate" })),
      expectedUpdatedAt: Type.Optional(
        Type.String({ description: "Required for allocate" }),
      ),
      prefix: Type.Optional(
        Type.String({ description: "Required for configure" }),
      ),
    }),
    async execute(_id, params) {
      await ensureService(false);
      if (params.operation === "status") {
        return toolResult(await client.request({ action: "work-ids.status" }));
      }
      if (params.operation === "configure") {
        if (!params.prefix) {
          throw new Error("outliner_work_id configure requires prefix");
        }
        return toolResult(await client.request({
          action: "work-ids.configure",
          prefix: params.prefix,
        }));
      }
      if (!params.blockId || !params.expectedUpdatedAt) {
        throw new Error("outliner_work_id allocate requires blockId and expectedUpdatedAt");
      }
      return toolResult(await client.request({
        action: "work-ids.allocate",
        blockId: params.blockId,
        expectedUpdatedAt: params.expectedUpdatedAt,
      }));
    },
  });

  pi.registerTool({
    name: "outliner_query",
    label: "Outliner Query",
    description:
      "Query blocks by text and indexed inline properties; returns completeness metadata for bounded results",
    promptSnippet: "Query shared blocks by text or [property::value]",
    parameters: Type.Object({
      text: Type.Optional(Type.String()),
      filters: Type.Optional(
        Type.Array(
          Type.Object({
            key: Type.String(),
            value: Type.Optional(Type.String()),
          }),
        ),
      ),
      subtreeRootId: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    async execute(_id, params) {
      await ensureService(false);
      const collection = await client.request<VisibleBlockCollection>({
        action: "blocks.query",
        query: { ...params, limit: params.limit ?? 100 },
      });
      return queryToolResult(collection);
    },
  });

  pi.registerTool({
    name: "outliner_move",
    label: "Outliner Move",
    description: "Move a block to another parent and optional sibling position",
    promptSnippet: "Move a shared outliner block",
    parameters: Type.Object({
      blockId: Type.String(),
      parentId: Type.Union([Type.String(), Type.Null()]),
      position: Type.Optional(Type.Integer({ minimum: 0 })),
    }),
    async execute(_id, params) {
      await ensureService(false);
      return toolResult(await client.request<Block>({ action: "move", ...params }));
    },
  });

  pi.registerTool({
    name: "outliner_clients",
    label: "Outliner Clients",
    description: "List live Tree and Detail client IDs for explicit targeting",
    promptSnippet: "List live outliner client instances",
    parameters: Type.Object({
      role: Type.Optional(Type.Union([Type.Literal("tree"), Type.Literal("detail")])),
    }),
    async execute(_id, params) {
      await ensureService(false);
      return toolResult(
        await client.request<OutlinerClientRegistration[]>({
          action: "clients.list",
          ...(params.role ? { role: params.role } : {}),
        }),
      );
    },
  });

  pi.registerTool({
    name: "outliner_selection",
    label: "Outliner Selection",
    description: "Read the user's selected block with its ancestors and children",
    promptSnippet: "Read the current shared outliner selection",
    parameters: Type.Object({}),
    async execute() {
      await ensureService(false);
      return toolResult(await client.request<SelectionContext>({ action: "selection.get" }));
    },
  });

  pi.on("input", async (event, ctx) => {
    if (
      event.source === "extension" ||
      event.streamingBehavior !== undefined ||
      (event.images?.length ?? 0) > 0
    ) {
      return { action: "continue" };
    }
    const marker = parseStandaloneDispatchMarker(event.text);
    if (marker.kind === "none") return { action: "continue" };
    if (marker.kind === "invalid") {
      ctx.ui.notify(marker.error, "warning");
      return { action: "continue" };
    }
    try {
      await ensureService(false);
      const source = hostCaptureSource();
      const receipt = await client.request<CaptureReceipt>({
        action: "capture.create",
        requestId: crypto.randomUUID(),
        text: marker.payload,
        source,
        capturedFromBlockId: await selectedBlockId(),
        author: "user",
      });
      const summary = compactCaptureReceipt(receipt, source);
      ctx.ui.notify(
        `${receipt.deduplicated ? "Capture already saved" : "Captured to Inbox"} · ${summary.blockId.slice(0, 8)}`,
        "info",
      );
      return { action: "handled" };
    } catch (error) {
      ctx.ui.notify(
        `Dispatch failed; input preserved: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      return { action: "continue" };
    }
  });

  pi.on("before_agent_start", async (event) => {
    try {
      const selection = await client.request<SelectionContext>({ action: "selection.get" }, 250);
      const context = formatSelection(selection);
      if (context) return { systemPrompt: `${event.systemPrompt}\n\n${context}` };
    } catch {
      // The outliner is optional until explicitly opened.
    }
  });

  pi.on("session_shutdown", async () => {
    if (headlessServer) {
      headlessServer.kill("SIGTERM");
      headlessServer = null;
    }
  });
}
