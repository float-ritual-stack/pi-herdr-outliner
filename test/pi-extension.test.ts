import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

  expect(commands).toEqual(["outliner", "outliner-filter"]);
  expect(registeredTools.map((definition) => definition.name)).toEqual([
    "outliner_create",
    "outliner_annotate_file",
    "outliner_update",
    "outliner_property_patch",
    "outliner_property_catalog",
    "outliner_query",
    "outliner_move",
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

test("requires protocol v3 and presents bounded query results", async () => {
  const collection: VisibleBlockCollection = {
    blocks: [
      {
        id: "match-id",
        parentId: null,
        position: 0,
        text: "Matching block",
        author: "user",
        collapsed: false,
        createdAt: "2026-08-22T00:00:00.000Z",
        updatedAt: "2026-08-22T00:00:00.000Z",
        properties: [{ key: "status", value: "open" }],
        depth: 0,
        multilineExpanded: false,
        hasChildren: false,
        displayText: "Matching block",
      },
    ],
    completeness: { kind: "truncated", limit: 20 },
  };
  let protocolVersion = 3;
  let queryCollection = collection;
  const requests: RequestInput[] = [];
  const originalRequest = OutlinerClient.prototype.request;
  OutlinerClient.prototype.request = async function <T>(input: RequestInput): Promise<T> {
    requests.push(input);
    if (input.action === "blocks.query") return queryCollection as unknown as T;
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
      params: { text?: string; limit?: number },
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

  try {
    outlinerExtension(pi);
    await commands.get("outliner-filter")!.handler("status=open", {
      ui: {
        setWidget(id, lines) {
          widgets.push({ id, lines });
        },
      },
    });
    const result = await tools.get("outliner_query")!.execute("query-id", { text: "Matching" });

    expect(requests.filter((request) => request.action === "blocks.query")).toEqual([
      {
        action: "blocks.query",
        query: { filters: [{ key: "status", value: "open" }], limit: 20 },
      },
      {
        action: "blocks.query",
        query: { text: "Matching", limit: 100 },
      },
    ]);
    expect(widgets).toEqual([
      {
        id: "pi-outliner-filter",
        lines: ["• Matching block", "Results truncated at 20 blocks"],
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
    protocolVersion = 2;
    await expect(tools.get("outliner_query")!.execute("incompatible-query", {})).rejects.toThrow(
      "Incompatible outliner protocol 2; expected 3",
    );
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
    collapsed: false,
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