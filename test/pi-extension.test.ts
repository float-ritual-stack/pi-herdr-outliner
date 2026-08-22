import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import outlinerExtension, { formatSelection } from "../pi-extension/index";
import type { Block, SelectionContext } from "../src/types";

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