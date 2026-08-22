import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import outlinerExtension from "../pi-extension/index";

test("registers the workspace commands and annotation-aware tools", () => {
  const tools: string[] = [];
  const commands: string[] = [];
  const pi = {
    registerTool(definition: { name: string }) {
      tools.push(definition.name);
    },
    registerCommand(name: string) {
      commands.push(name);
    },
    on() {},
  } as unknown as ExtensionAPI;

  outlinerExtension(pi);

  expect(commands).toEqual(["outliner", "outliner-filter"]);
  expect(tools).toEqual([
    "outliner_create",
    "outliner_annotate_file",
    "outliner_update",
    "outliner_property_patch",
    "outliner_property_catalog",
    "outliner_query",
    "outliner_move",
    "outliner_selection",
  ]);
});
