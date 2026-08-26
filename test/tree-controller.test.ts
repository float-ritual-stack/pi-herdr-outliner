import { describe, expect, test } from "bun:test";
import type { RequestInput } from "../src/client";
import { createTreeController, type TreeControllerEffects } from "../src/tree-controller";
import { layoutExpandedBlock } from "../src/tree-layout";
import { decorateVirtualBranchDefinitionText } from "../src/virtual-branches";
import type {
  Block,
  BlockCollectionCompleteness,
  OutlinerEvent,
  VisibleBlock,
  VirtualOccurrenceRank,
  WorkspaceSnapshot,
} from "../src/types";

function block(
  id: string,
  overrides: Partial<VisibleBlock> = {},
): VisibleBlock {
  return {
    id,
    parentId: null,
    position: 0,
    text: id,
    author: "user",
    collapsed: false,
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
    properties: [],
    depth: 0,
    multilineExpanded: false,
    hasChildren: false,
    displayText: id,
    ...overrides,
  };
}

function snapshot(
  blocks: VisibleBlock[],
  selected: Block | null = null,
  options: {
    physicalBlocks?: VisibleBlock[];
    visibleCompleteness?: BlockCollectionCompleteness;
    physicalCompleteness?: BlockCollectionCompleteness;
    virtualOccurrenceRanks?: VirtualOccurrenceRank[];
  } = {},
): WorkspaceSnapshot {
  return {
    visible: {
      blocks,
      completeness: options.visibleCompleteness ?? { kind: "complete" },
    },
    physical: {
      blocks: options.physicalBlocks ?? blocks,
      completeness: options.physicalCompleteness ?? { kind: "complete" },
    },
    selection: { selected, ancestors: [], children: [] },
    virtualOccurrenceRanks: options.virtualOccurrenceRanks ?? [],
    sequence: 1,
  };
}

interface Harness {
  readonly calls: RequestInput[];
  effects: TreeControllerEffects;
  readonly focused: Array<"detail" | "outliner">;
  invalidations: number;
  stops: number;
}

function harness(respond: (input: RequestInput) => unknown | Promise<unknown>): Harness {
  const result: Harness = {
    calls: [],
    focused: [],
    invalidations: 0,
    stops: 0,
    effects: {
      workspaceRoot: "/workspace",
      request: async <T>(input: RequestInput): Promise<T> => {
        result.calls.push(input);
        return (await respond(input)) as T;
      },
      filesystem: {
        completeReferencedPaths: () => [],
        readReferencedFile: () => {
          throw new Error("not configured");
        },
      },
      focusPane: (pane: "detail" | "outliner") => result.focused.push(pane),
      terminalWidth: () => 80,
      terminalHeight: () => 12,
      stop: () => {
        result.stops += 1;
      },
      invalidate: () => {
        result.invalidations += 1;
      },
    },
  };
  return result;
}

function event(domain: OutlinerEvent["domain"], blockId?: string): OutlinerEvent {
  return { id: "event", domain, action: "changed", sequence: 2, blockId };
}

function lastCall(calls: readonly RequestInput[], action: RequestInput["action"]): RequestInput | undefined {
  return [...calls].reverse().find((call) => call.action === action);
}

describe("createTreeController", () => {
  test("uses snapshot selection initially and preserves the current visible selection on refresh", async () => {
    const first = block("first");
    const second = block("second", { position: 1 });
    let snapshotCount = 0;
    const fake = harness((input) => {
      if (input.action === "workspace.snapshot") {
        snapshotCount += 1;
        return snapshotCount === 1
          ? snapshot([first, second], second)
          : snapshot([second, first], first);
      }
      return undefined;
    });
    const controller = createTreeController(fake.effects);

    await controller.initialize();
    expect(controller.view().rows[controller.view().selectedIndex]?.canonicalId).toBe("second");
    expect(fake.calls.some((call) => call.action === "selection.set")).toBe(false);

    await controller.handleServiceEvent(event("content"));
    expect(controller.view().rows[controller.view().selectedIndex]?.canonicalId).toBe("second");
    expect(fake.calls.some((call) => call.action === "selection.set")).toBe(false);
  });

  test("fuzzy goto previews candidates and reveals the selected block", async () => {
    const first = block("first", { text: "Inbox", displayText: "Inbox" });
    const target = block("40bd0864-913a-4537-9535-8f96e1b63ef7", {
      position: 1,
      text: "Roadmap review after the graveyard walk",
      displayText: "Roadmap review after the graveyard walk",
    });
    const other = block("other", {
      position: 2,
      text: "Unrelated note",
      displayText: "Unrelated note",
    });
    const fake = harness((input) =>
      input.action === "workspace.snapshot"
        ? snapshot([first, target, other], first)
        : undefined,
    );
    const controller = createTreeController(fake.effects);
    await controller.initialize();

    await controller.handleKeypress("g", { name: "g" }, "pass");
    await controller.handleKeypress(
      "rdmp reviw",
      { sequence: "rdmp reviw" },
      "pass",
    );

    expect(controller.view().mode).toBe("goto");
    expect(controller.view().quickCompletion?.items[0]).toMatchObject({
      blockId: target.id,
      label: `40bd0864 · Roadmap review after the graveyard walk`,
    });

    await controller.handleKeypress("", { name: "return" }, "pass");
    expect(controller.view().mode).toBe("browse");
    expect(controller.view().rows[controller.view().selectedIndex]?.canonicalId).toBe(target.id);
    expect(lastCall(fake.calls, "selection.set")).toEqual({
      action: "selection.set",
      blockId: target.id,
    });
  });
  test("follows the first block reference and navigates service history", async () => {
    const source = block("source01", {
      text: "Source points to ((target01))",
      displayText: "Source points to ((target01))",
    });
    const target = block("target01", { position: 1, text: "Target", displayText: "Target" });
    let selected = source;
    const fake = harness((input) => {
      if (input.action === "workspace.snapshot") return snapshot([source, target], selected);
      if (input.action === "selection.set") {
        selected = input.blockId === target.id ? target : source;
        return { selected, ancestors: [], children: [] };
      }
      if (input.action === "get") return target;
      if (input.action === "navigation.back") {
        selected = source;
        return {
          selection: { selected, ancestors: [], children: [] },
          canBack: false,
          canForward: true,
        };
      }
      return undefined;
    });
    const controller = createTreeController(fake.effects);
    await controller.initialize();

    await controller.handleKeypress("o", { name: "o" }, "pass");
    expect(controller.view().rows[controller.view().selectedIndex]?.canonicalId).toBe(target.id);
    expect(lastCall(fake.calls, "selection.set")).toMatchObject({
      action: "selection.set",
      blockId: target.id,
    });

    await controller.handleKeypress("", { name: "left", meta: true }, "pass");
    expect(controller.view().rows[controller.view().selectedIndex]?.canonicalId).toBe(source.id);
    expect(lastCall(fake.calls, "navigation.back")).toBeDefined();
  });

  test("opens deleted reference and history targets read-only in Detail", async () => {
    const source = block("source01", {
      text: "Source points to ((deleted1))",
      displayText: "Source points to ((deleted1))",
    });
    const deleted = block("deleted1", {
      deletedAt: "2026-08-22T01:00:00.000Z",
      effectiveDeletedRootId: "deleted1",
    });
    let selected: Block = source;
    const fake = harness((input) => {
      if (input.action === "workspace.snapshot") return snapshot([source], selected);
      if (input.action === "get") return deleted;
      if (input.action === "selection.set") {
        selected = input.blockId === deleted.id ? deleted : source;
        return { selected, ancestors: [], children: [] };
      }
      if (input.action === "navigation.back") {
        selected = deleted;
        return {
          selection: { selected, ancestors: [], children: [] },
          canBack: false,
          canForward: true,
        };
      }
      return undefined;
    });
    const controller = createTreeController(fake.effects);
    await controller.initialize();

    await controller.handleKeypress("o", { name: "o" }, "pass");
    expect(fake.focused).toEqual(["detail"]);
    expect(lastCall(fake.calls, "ui.command.send")).toMatchObject({
      action: "ui.command.send",
      command: { target: "detail", blockId: deleted.id },
    });

    selected = source;
    await controller.handleKeypress("", { name: "left", meta: true }, "pass");
    expect(fake.focused).toEqual(["detail", "detail"]);
    expect(controller.view().status).toContain("deleted block read-only");
  });


  test("cycles goto candidates across both Tab boundaries", async () => {
    const review = block("40bd0864-913a-4537-9535-8f96e1b63ef7", {
      text: "Roadmap review",
      displayText: "Roadmap review",
    });
    const triage = block("a089afe5-6535-40ca-8164-25f8a299ac5e", {
      position: 1,
      text: "Roadmap triage",
      displayText: "Roadmap triage",
    });
    const fake = harness((input) =>
      input.action === "workspace.snapshot"
        ? snapshot([review, triage], review)
        : undefined,
    );
    const controller = createTreeController(fake.effects);
    await controller.initialize();
    await controller.handleKeypress("g", { name: "g" }, "pass");
    await controller.handleKeypress("roadmap", { sequence: "roadmap" }, "pass");

    expect(controller.view().quickCompletion?.index).toBe(0);
    await controller.handleKeypress("", { name: "tab", shift: true }, "pass");
    expect(controller.view().quickCompletion?.index).toBe(1);
    await controller.handleKeypress("", { name: "tab" }, "pass");
    expect(controller.view().quickCompletion?.index).toBe(0);
  });

  test("installs a complete 501-block snapshot and selects its last block", async () => {
    const blocks = Array.from({ length: 501 }, (_, index) =>
      block(`block-${index}`, { position: index }),
    );
    const selected = blocks.at(-1)!;
    const fake = harness((input) =>
      input.action === "workspace.snapshot" ? snapshot(blocks, selected) : undefined,
    );
    const controller = createTreeController(fake.effects);

    await controller.initialize();

    expect(fake.calls[0]).toEqual({
      action: "workspace.snapshot",
      view: { filters: [] },
    });
    expect(controller.view().rows).toHaveLength(501);
    expect(controller.view().physicalBlocksById.size).toBe(501);
    expect(controller.view().visibleCompleteness).toEqual({ kind: "complete" });
    expect(controller.view().rows[controller.view().selectedIndex]?.canonicalId).toBe("block-500");
    expect(fake.calls.some((call) => call.action === "selection.set")).toBe(false);
  });

  test("installs visible completeness and the distinct complete physical collection", async () => {
    const visible = block("visible");
    const hidden = block("hidden", { parentId: "visible", depth: 1 });
    const fake = harness((input) =>
      input.action === "workspace.snapshot"
        ? snapshot([visible], visible, {
            physicalBlocks: [visible, hidden],
            visibleCompleteness: { kind: "truncated", limit: 1 },
          })
        : undefined,
    );
    const controller = createTreeController(fake.effects);

    await controller.initialize();

    expect(controller.view().rows.map((row) => row.canonicalId)).toEqual(["visible"]);
    expect([...controller.view().physicalBlocksById.keys()]).toEqual(["visible", "hidden"]);
    expect(controller.view().visibleCompleteness).toEqual({ kind: "truncated", limit: 1 });
  });

  test("publishes the first visible row only when the service has no selection", async () => {
    const first = block("first");
    const fake = harness((input) =>
      input.action === "workspace.snapshot" ? snapshot([first], null) : undefined,
    );
    const controller = createTreeController(fake.effects);

    await controller.initialize();

    expect(fake.calls.at(-1)).toEqual({ action: "selection.set", blockId: "first" });
  });

  test("preserves a valid hidden service selection without publishing a visual fallback", async () => {
    const parent = block("parent", { collapsed: true, hasChildren: true });
    const hidden = block("hidden", { parentId: parent.id, depth: 1 });
    const fake = harness((input) =>
      input.action === "workspace.snapshot"
        ? snapshot([parent], hidden, { physicalBlocks: [parent, hidden] })
        : undefined,
    );
    const controller = createTreeController(fake.effects);

    await controller.initialize();
    await controller.handleServiceEvent(event("content"));

    expect(controller.view().rows[controller.view().selectedIndex]?.canonicalId).toBe("parent");
    expect(fake.calls.some((call) => call.action === "selection.set")).toBe(false);
  });

  test("reveals a hidden target by expanding canonical ancestors before selecting it", async () => {
    let collapsed = true;
    const fake = harness((input) => {
      const parent = block("parent", { collapsed, hasChildren: true });
      const hidden = block("hidden", { parentId: parent.id, depth: 1 });
      if (input.action === "workspace.snapshot") {
        return snapshot(collapsed ? [parent] : [parent, hidden], parent, {
          physicalBlocks: [parent, hidden],
        });
      }
      if (input.action === "toggle") {
        collapsed = false;
        return parent;
      }
      return undefined;
    });
    const controller = createTreeController(fake.effects);
    await controller.initialize();

    await controller.handleServiceEvent({
      id: "reveal",
      domain: "ui",
      action: "ui.command.send",
      sequence: 2,
      command: { target: "tree", command: "reveal", blockId: "hidden" },
    });

    expect(fake.calls.filter((call) => call.action === "toggle")).toEqual([
      { action: "toggle", blockId: "parent" },
    ]);
    expect(fake.calls.at(-1)).toEqual({ action: "selection.set", blockId: "hidden" });
    expect(controller.view().rows[controller.view().selectedIndex]?.canonicalId).toBe("hidden");
  });

  test("indents only beneath a canonical sibling in a filtered projection", async () => {
    const first = block("first", { parentId: "parent-a", depth: 1 });
    const selected = block("selected", { parentId: "parent-b", depth: 1, position: 1 });
    const parentA = block("parent-a", { hasChildren: true });
    const parentB = block("parent-b", { position: 1, hasChildren: true });
    const fake = harness((input) =>
      input.action === "workspace.snapshot"
        ? snapshot([first, selected], selected, {
            physicalBlocks: [parentA, first, parentB, selected],
          })
        : undefined,
    );
    const controller = createTreeController(fake.effects);
    await controller.initialize();

    await controller.handleKeypress("", { name: "tab" }, "pass");

    expect(fake.calls.some((call) => call.action === "move")).toBe(false);
    expect(controller.view().status).toBe("No previous sibling to indent beneath");
  });

  test("refuses an initial snapshot with truncated physical ancestry", async () => {
    const selected = block("selected");
    const fake = harness((input) =>
      input.action === "workspace.snapshot"
        ? snapshot([selected], selected, {
            physicalCompleteness: { kind: "truncated", limit: 500 },
          })
        : undefined,
    );
    const controller = createTreeController(fake.effects);

    await expect(controller.initialize()).rejects.toThrow(
      "Workspace snapshot physical blocks are truncated at 500; canonical ancestry is unavailable",
    );
    expect(controller.view().rows).toEqual([]);
    expect(controller.view().physicalBlocksById.size).toBe(0);
    expect(fake.calls.some((call) => call.action === "selection.set")).toBe(false);
  });

  test("retains the prior complete tree when a refresh has truncated physical ancestry", async () => {
    const stable = block("stable");
    const replacement = block("replacement");
    let snapshotCount = 0;
    const fake = harness((input) => {
      if (input.action !== "workspace.snapshot") return undefined;
      snapshotCount += 1;
      return snapshotCount === 1
        ? snapshot([stable], stable)
        : snapshot([replacement], replacement, {
            physicalCompleteness: { kind: "truncated", limit: 1 },
          });
    });
    const controller = createTreeController(fake.effects);
    await controller.initialize();
    const completeView = controller.view();

    await expect(controller.handleServiceEvent(event("content"))).rejects.toThrow(
      "Workspace snapshot physical blocks are truncated at 1; canonical ancestry is unavailable",
    );

    expect(controller.view().rows).toBe(completeView.rows);
    expect(controller.view().physicalBlocksById).toBe(completeView.physicalBlocksById);
    expect(controller.view().rows[controller.view().selectedIndex]?.canonicalId).toBe("stable");
  });

  test("commits a quick child before selection handoff, command dispatch, and detail focus", async () => {
    const parent = block("parent", { hasChildren: true });
    const created = block("child", { parentId: "parent", text: "Child", displayText: "Child", depth: 1 });
    let snapshotCount = 0;
    const effectOrder: string[] = [];
    const fake = harness((input) => {
      effectOrder.push(input.action);
      if (input.action === "workspace.snapshot") {
        snapshotCount += 1;
        return snapshotCount === 1 ? snapshot([parent], parent) : snapshot([parent, created], parent);
      }
      if (input.action === "create") return created;
      return undefined;
    });
    fake.effects.focusPane = (pane) => {
      effectOrder.push(`focus:${pane}`);
      fake.focused.push(pane);
    };
    const controller = createTreeController(fake.effects);
    await controller.initialize();
    effectOrder.length = 0;

    await controller.handleKeypress("a", { name: "a" }, "pass");
    await controller.handleKeypress("Child", { sequence: "Child" }, "pass");
    await controller.handleKeypress("", { name: "e", ctrl: true }, "pass");

    expect(effectOrder).toEqual([
      "create",
      "move",
      "workspace.snapshot",
      "selection.set",
      "ui.command.send",
      "focus:detail",
    ]);
    expect(fake.calls.find((call) => call.action === "move")).toEqual({
      action: "move",
      blockId: "child",
      parentId: "parent",
      position: 0,
    });
    expect(controller.view().mode).toBe("browse");
    expect(controller.view().status).toBe("Multiline editor opened in detail pane");
  });

  test("defers service events during editing and reloads once editing is cancelled", async () => {
    const selected = block("selected");
    const fake = harness((input) => input.action === "workspace.snapshot" ? snapshot([selected], selected) : undefined);
    const controller = createTreeController(fake.effects);
    await controller.initialize();

    await controller.handleKeypress("", { name: "return" }, "pass");
    const callsBeforeEvent = fake.calls.length;
    await controller.handleServiceEvent(event("content", "selected"));
    expect(fake.calls).toHaveLength(callsBeforeEvent);
    expect(controller.view().refreshPending).toBe(true);

    await controller.handleKeypress("", { name: "escape" }, "pass");
    expect(fake.calls.slice(callsBeforeEvent).map((call) => call.action)).toEqual(["workspace.snapshot"]);
    expect(controller.view().mode).toBe("browse");
    expect(controller.view().refreshPending).toBe(false);
  });

  test("applies page completion after the page-only query falls back to all blocks", async () => {
    const selected = block("selected", { text: "[[ho", displayText: "[[ho" });
    const home = block("home", {
      text: "Home [type::page]",
      displayText: "Home [type::page]",
      properties: [{ key: "type", value: "page" }],
    });
    const fake = harness((input) => {
      if (input.action === "workspace.snapshot") return snapshot([selected], selected);
      if (input.action === "blocks.query" && input.query.filters) {
        return { blocks: [], completeness: { kind: "complete" } };
      }
      if (input.action === "blocks.query") {
        return { blocks: [home], completeness: { kind: "truncated", limit: 20 } };
      }
      return undefined;
    });
    const controller = createTreeController(fake.effects);
    await controller.initialize();
    await controller.handleKeypress("", { name: "return" }, "pass");

    await controller.handleKeypress("", { name: "tab" }, "pass");
    expect(fake.calls.filter((call) => call.action === "blocks.query")).toEqual([
      {
        action: "blocks.query",
        query: { text: "ho", filters: [{ key: "type", value: "page" }], limit: 20 },
      },
      {
        action: "blocks.query",
        query: { text: "ho", limit: 20 },
      },
    ]);
    expect(controller.view().quickCompletion?.items[0]).toEqual({
      label: "Home",
      insertion: "[[Home]]",
    });
    expect(controller.view().quickCompletion?.truncatedLimit).toBe(20);

    await controller.handleKeypress("", { name: "tab" }, "pass");
    expect(controller.view().quickInput).toBe("[[Home]]");
  });

  test("honors key precedence for close and detail-toggle inputs", async () => {
    const selected = block("selected");
    const fake = harness((input) => {
      if (input.action === "workspace.snapshot") return snapshot([selected], selected);
      if (input.action === "view.toggleMultiline") return { expanded: true };
      return undefined;
    });
    const controller = createTreeController(fake.effects);
    await controller.initialize();

    const callsBeforeClose = fake.calls.length;
    await controller.handleKeypress("q", { name: "q", ctrl: true }, "pass");
    expect(fake.stops).toBe(1);
    expect(fake.calls).toHaveLength(callsBeforeClose);

    await controller.handleKeypress(".", { name: "." }, "modified-enter");
    expect(fake.calls.some((call) => call.action === "view.toggleMultiline")).toBe(true);
    expect(fake.calls.some((call) => call.action === "ui.command.send")).toBe(false);
    expect(controller.view().status).toBe("Block detail expanded");
  });

  test("pages within one expanded block and resets on reconnect or selection change", async () => {
    const text = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
    const expanded = block("expanded", {
      text,
      displayText: text,
      multilineExpanded: true,
    });
    const next = block("next", { position: 1 });
    const fake = harness((input) =>
      input.action === "workspace.snapshot"
        ? snapshot([expanded, next], expanded)
        : undefined,
    );
    const controller = createTreeController(fake.effects);
    await controller.initialize();

    await controller.handleKeypress("", { name: "pagedown" }, "pass");
    expect(controller.view().expandedBlockOffset).toBe(6);
    expect(controller.view().status).toBe("Expanded block rows 7-12/20");
    await controller.handleKeypress("", { name: "pagedown" }, "pass");
    await controller.handleKeypress("", { name: "pagedown" }, "pass");
    expect(controller.view().expandedBlockOffset).toBe(14);
    expect(controller.view().status).toBe("Expanded block rows 15-20/20");

    await controller.handleKeypress("", { name: "pageup" }, "pass");
    expect(controller.view().expandedBlockOffset).toBe(8);
    expect(controller.view().status).toBe("Expanded block rows 9-14/20");

    await controller.handleConnect();
    expect(controller.view().expandedBlockOffset).toBe(0);
    expect(controller.view().status).toBe("");
    await controller.handleKeypress("", { name: "pagedown" }, "pass");
    expect(controller.view().expandedBlockOffset).toBe(6);

    await controller.handleKeypress("", { name: "down" }, "pass");
    expect(controller.view().rows[controller.view().selectedIndex]?.canonicalId).toBe("next");
    expect(controller.view().expandedBlockOffset).toBe(0);
    expect(controller.view().status).toBe("");
  });

  test("pages through the decorated rows of an expanded virtual branch", async () => {
    const text = [
      "A".repeat(70),
      ...Array.from({ length: 10 }, (_, index) => `detail ${index + 1}`),
      "[type::virtual-branch] [query::status=Next]",
    ].join("\n");
    const definition = block("view", {
      text,
      displayText: text,
      multilineExpanded: true,
      properties: [
        { key: "type", value: "virtual-branch" },
        { key: "query", value: "status=Next" },
      ],
    });
    const match = block("match", {
      properties: [{ key: "status", value: "Next" }],
    });
    const fake = harness((input) => {
      if (input.action === "workspace.snapshot") return snapshot([definition], definition);
      if (input.action === "blocks.query") {
        return { blocks: [match], completeness: { kind: "complete" } };
      }
      return undefined;
    });
    const controller = createTreeController(fake.effects);
    await controller.initialize();
    const branchState = controller.view().branchStates.get("view")!;
    const decoratedText = decorateVirtualBranchDefinitionText(text, branchState);
    const totalRows = layoutExpandedBlock({
      text: decoratedText,
      width: 80,
      depth: 0,
      marker: "•",
      author: " ",
    }).length;
    const pageSize = 6;

    for (let index = 0; index < 10; index += 1) {
      await controller.handleKeypress("", { name: "pagedown" }, "pass");
    }

    const expectedOffset = totalRows - pageSize;
    expect(controller.view().expandedBlockOffset).toBe(expectedOffset);
    expect(controller.view().status).toBe(
      `Expanded block rows ${expectedOffset + 1}-${totalRows}/${totalRows}`,
    );
  });

  test("projects generic Next, Doing, and Done branches and requeries on content and connect", async () => {
    const nextView = block("next-view", {
      properties: [
        { key: "type", value: "virtual-branch" },
        { key: "query", value: "status=Next" },
      ],
    });
    const doingView = block("doing-view", {
      properties: [
        { key: "type", value: "virtual-branch" },
        { key: "query", value: "status=Doing" },
      ],
    });
    const doneView = block("done-view", {
      properties: [
        { key: "type", value: "virtual-branch" },
        { key: "query", value: "status=Done" },
      ],
    });
    const next = block("next", { properties: [{ key: "status", value: "Next" }] });
    const doing = block("doing", { properties: [{ key: "status", value: "Doing" }] });
    const done = block("done", { properties: [{ key: "status", value: "Done" }] });
    const physical = [nextView, doingView, doneView, next, doing, done];
    let queryCount = 0;
    const fake = harness((input) => {
      if (input.action === "workspace.snapshot") return snapshot(physical, nextView);
      if (input.action === "blocks.query") {
        queryCount += 1;
        const status = input.query.filters?.[0]?.value;
        const match = physical.find((candidate) =>
          candidate.properties.some((property) => property.key === "status" && property.value === status)
        );
        return { blocks: match ? [match] : [], completeness: { kind: "complete" } };
      }
      return undefined;
    });
    const controller = createTreeController(fake.effects);

    await controller.initialize();

    expect(controller.view().rows.map((row) => row.rowId)).toEqual([
      "next-view",
      "occurrence:next-view:next",
      "doing-view",
      "occurrence:doing-view:doing",
      "done-view",
      "occurrence:done-view:done",
      "next",
      "doing",
      "done",
    ]);
    expect(controller.view().branchStates.get("doing-view")).toEqual(expect.objectContaining({
      queried: true,
      count: 1,
      queryError: null,
      completeness: { kind: "complete" },
    }));
    expect(controller.view().physicalBlocksById.size).toBe(6);

    await controller.handleServiceEvent(event("content"));
    await controller.handleConnect();
    expect(queryCount).toBe(9);
  });

  test("creates one property-aware canonical child beneath the configured parent", async () => {
    const parent = block("cards");
    const definition = block("doing-view", {
      properties: [
        { key: "type", value: "virtual-branch" },
        { key: "query", value: "status=Doing" },
        { key: "create", value: "status=Doing" },
        { key: "create-parent", value: parent.id },
      ],
    });
    let created: VisibleBlock | null = null;
    const effectOrder: string[] = [];
    const fake = harness((input) => {
      effectOrder.push(input.action);
      if (input.action === "workspace.snapshot") {
        const physical = created ? [definition, parent, created] : [definition, parent];
        return snapshot(physical, definition);
      }
      if (input.action === "blocks.query") {
        return {
          blocks: created ? [created] : [],
          completeness: { kind: "complete" },
        };
      }
      if (input.action === "create") {
        created = block("created", {
          parentId: input.parentId,
          text: input.text,
          displayText: input.text,
          properties: [{ key: "status", value: "Doing" }],
        });
        return created;
      }
      return undefined;
    });
    const controller = createTreeController(fake.effects);
    await controller.initialize();
    effectOrder.length = 0;

    await controller.handleKeypress("a", { name: "a" }, "pass");
    await controller.handleKeypress("Task [status::Next]", { sequence: "Task [status::Next]" }, "pass");
    await controller.handleKeypress("", { name: "return" }, "pass");

    expect(fake.calls.filter((call) => call.action === "create")).toEqual([{
      action: "create",
      parentId: "cards",
      text: "Task [status::Doing]",
      author: "user",
    }]);
    expect(effectOrder).toEqual([
      "create",
      "workspace.snapshot",
      "blocks.query",
      "selection.set",
    ]);
    expect(fake.calls.some((call) => call.action === "move")).toBe(false);
    expect(controller.view().rows[controller.view().selectedIndex]?.rowId).toBe("created");
  });

  test("keeps occurrence identity while editing and routes allowed effects to the canonical block", async () => {
    const definition = block("view", {
      properties: [
        { key: "type", value: "virtual-branch" },
        { key: "query", value: "status=Doing" },
      ],
    });
    let card: VisibleBlock | null = block("card", {
      text: "Card",
      displayText: "Card",
      properties: [{ key: "status", value: "Doing" }],
    });
    let openedFileId = "";
    const fake = harness((input) => {
      const physical = card ? [definition, card] : [definition];
      if (input.action === "workspace.snapshot") return snapshot(physical, definition);
      if (input.action === "blocks.query") {
        return { blocks: card ? [card] : [], completeness: { kind: "complete" } };
      }
      if (input.action === "update" && card) {
        card = { ...card, text: input.text, displayText: input.text };
        return card;
      }
      if (input.action === "view.toggleMultiline" && card) {
        card = { ...card, multilineExpanded: true };
        return { expanded: true };
      }
      if (input.action === "delete") {
        card = null;
        return undefined;
      }
      return undefined;
    });
    fake.effects.filesystem.readReferencedFile = (selected) => {
      openedFileId = selected.id;
      return {
        absolutePath: "/workspace/card.txt",
        displayPath: "card.txt",
        sourcePath: "card.txt",
        firstLine: 1,
        lines: ["card"],
      };
    };
    const controller = createTreeController(fake.effects);
    await controller.initialize();
    await controller.handleKeypress("", { name: "down" }, "pass");

    await controller.handleKeypress(".", { name: "." }, "modified-enter");
    expect(lastCall(fake.calls, "view.toggleMultiline")).toEqual({
      action: "view.toggleMultiline",
      blockId: "card",
    });
    expect(controller.view().rows[controller.view().selectedIndex]?.rowId).toBe(
      "occurrence:view:card",
    );
    expect(controller.view().rows[controller.view().selectedIndex]?.multilineExpanded).toBe(true);

    await controller.handleKeypress("f", { name: "f" }, "pass");
    expect(openedFileId).toBe("card");
    await controller.handleKeypress("", { name: "escape" }, "pass");

    await controller.handleKeypress("", { name: "return" }, "pass");
    await controller.handleKeypress("!", { sequence: "!" }, "pass");
    await controller.handleKeypress("", { name: "return" }, "pass");
    expect(lastCall(fake.calls, "update")).toEqual({
      action: "update",
      blockId: "card",
      text: "Card!",
      expectedUpdatedAt: "2026-08-22T00:00:00.000Z",
    });
    expect(controller.view().rows[controller.view().selectedIndex]?.rowId).toBe(
      "occurrence:view:card",
    );

    await controller.handleKeypress("", { name: "e", ctrl: true }, "pass");
    expect(lastCall(fake.calls, "ui.command.send")).toEqual({
      action: "ui.command.send",
      command: { target: "detail", command: "edit", blockId: "card" },
    });
    await controller.handleKeypress("", { name: "up" }, "pass");
    expect(controller.view().rows[controller.view().selectedIndex]?.rowId).toBe(
      "occurrence:view:card",
    );

    await controller.handleKeypress("d", { name: "d" }, "pass");
    await controller.handleKeypress("y", { name: "y" }, "pass");
    expect(lastCall(fake.calls, "delete")).toEqual({
      action: "delete",
      blockId: "card",
    });
    expect(JSON.stringify(fake.calls)).not.toContain("occurrence:");
  });

  test("falls back from a disappeared occurrence to its still-visible canonical row", async () => {
    const definition = block("view", {
      properties: [
        { key: "type", value: "virtual-branch" },
        { key: "query", value: "status=Doing" },
      ],
    });
    const card = block("card", { properties: [{ key: "status", value: "Doing" }] });
    let matches = true;
    const fake = harness((input) => {
      if (input.action === "workspace.snapshot") return snapshot([definition, card], definition);
      if (input.action === "blocks.query") {
        return { blocks: matches ? [card] : [], completeness: { kind: "complete" } };
      }
      return undefined;
    });
    const controller = createTreeController(fake.effects);
    await controller.initialize();
    await controller.handleKeypress("", { name: "down" }, "pass");
    expect(controller.view().rows[controller.view().selectedIndex]?.rowId).toBe(
      "occurrence:view:card",
    );

    matches = false;
    await controller.handleServiceEvent(event("content"));

    expect(controller.view().rows[controller.view().selectedIndex]?.rowId).toBe("card");
    expect(controller.view().rows[controller.view().selectedIndex]?.canonicalId).toBe("card");
  });

  test("prefers the physical row when one of several occurrences disappears", async () => {
    const firstView = block("first-view", {
      properties: [
        { key: "type", value: "virtual-branch" },
        { key: "query", value: "lane=first" },
      ],
    });
    const secondView = block("second-view", {
      properties: [
        { key: "type", value: "virtual-branch" },
        { key: "query", value: "lane=second" },
      ],
    });
    const card = block("card");
    let secondMatches = true;
    const fake = harness((input) => {
      if (input.action === "workspace.snapshot") {
        return snapshot([firstView, secondView, card], firstView);
      }
      if (input.action === "blocks.query") {
        const lane = input.query.filters?.[0]?.value;
        return {
          blocks: lane === "first" || secondMatches ? [card] : [],
          completeness: { kind: "complete" },
        };
      }
      return undefined;
    });
    const controller = createTreeController(fake.effects);
    await controller.initialize();
    await controller.handleKeypress("", { name: "down" }, "pass");
    await controller.handleKeypress("", { name: "down" }, "pass");
    await controller.handleKeypress("", { name: "down" }, "pass");
    expect(controller.view().rows[controller.view().selectedIndex]?.rowId).toBe(
      "occurrence:second-view:card",
    );

    secondMatches = false;
    await controller.handleServiceEvent(event("content"));

    expect(controller.view().rows[controller.view().selectedIndex]?.rowId).toBe("card");
  });

  test("exposes truncated, failed, read-only, and invalid branch state with explicit status", async () => {
    const parent = block("parent");
    const limited = block("limited", {
      properties: [
        { key: "type", value: "virtual-branch" },
        { key: "query", value: "status=Doing" },
        { key: "limit", value: "2" },
      ],
    });
    const failed = block("failed", {
      properties: [
        { key: "type", value: "virtual-branch" },
        { key: "query", value: "status=Next" },
      ],
    });
    const readOnly = block("readonly", {
      properties: [
        { key: "type", value: "virtual-branch" },
        { key: "query", value: "status=Done" },
      ],
    });
    const invalid = block("invalid", {
      properties: [
        { key: "type", value: "virtual-branch" },
        { key: "query", value: "status=Next" },
        { key: "query", value: "status=Doing" },
      ],
    });
    const matches = [block("one"), block("two"), block("three")];
    const physical = [limited, failed, readOnly, invalid, parent, ...matches];
    const fake = harness((input) => {
      if (input.action === "workspace.snapshot") return snapshot(physical, readOnly);
      if (input.action === "blocks.query") {
        const status = input.query.filters?.[0]?.value;
        if (status === "Next") throw new Error("query unavailable");
        return {
          blocks: status === "Doing" ? matches : [],
          completeness: { kind: "complete" },
        };
      }
      return undefined;
    });
    const controller = createTreeController(fake.effects);
    await controller.initialize();

    expect(controller.view().branchStates.get("limited")).toEqual(expect.objectContaining({
      count: 2,
      completeness: { kind: "truncated", limit: 2 },
    }));
    expect(controller.view().branchStates.get("failed")?.queryError).toBe("query unavailable");
    expect(controller.view().branchStates.get("invalid")?.queried).toBe(false);

    await controller.handleKeypress("a", { name: "a" }, "pass");
    expect(controller.view().status).toBe(
      "Virtual branch is read-only: configure create and create-parent",
    );
    await controller.handleServiceEvent(event("selection", "invalid"));
    await controller.handleKeypress("a", { name: "a" }, "pass");
    expect(controller.view().status).toContain("Virtual branch is invalid:");
  });

  test("preserves occurrence identity after selection echoes and reorders only that branch", async () => {
    const definition = block("view", {
      properties: [
        { key: "type", value: "virtual-branch" },
        { key: "query", value: "status=Doing" },
      ],
    });
    const first = block("first", {
      properties: [{ key: "status", value: "Doing" }],
    });
    const second = block("second", {
      position: 1,
      properties: [{ key: "status", value: "Doing" }],
    });
    let ranks: VirtualOccurrenceRank[] = [];
    const fake = harness((input) => {
      if (input.action === "workspace.snapshot") {
        return snapshot([definition, first, second], definition, {
          virtualOccurrenceRanks: ranks,
        });
      }
      if (input.action === "blocks.query") {
        return { blocks: [first, second], completeness: { kind: "complete" } };
      }
      if (input.action === "virtual.occurrences.reorder") {
        ranks = input.orderedBlockIds.map((blockId, rank) => ({
          viewId: input.viewId,
          blockId,
          rank,
        }));
        return ranks;
      }
      return undefined;
    });
    const controller = createTreeController(fake.effects);
    await controller.initialize();
    await controller.handleKeypress("", { name: "down" }, "pass");
    await controller.handleServiceEvent(event("selection", first.id));
    expect(controller.view().rows[controller.view().selectedIndex]?.rowId).toBe(
      "occurrence:view:first",
    );
    fake.calls.length = 0;

    await controller.handleKeypress("", { name: "down", shift: true }, "pass");

    expect(lastCall(fake.calls, "virtual.occurrences.reorder")).toEqual({
      action: "virtual.occurrences.reorder",
      viewId: definition.id,
      orderedBlockIds: [second.id, first.id],
    });
    expect(
      controller.view().rows
        .filter((row) => row.kind === "physical")
        .map((row) => row.canonicalId),
    ).toEqual([definition.id, first.id, second.id]);
    expect(controller.view().rows[controller.view().selectedIndex]?.rowId).toBe(
      "occurrence:view:first",
    );
    expect(controller.view().status).toBe(
      "Moved down within virtual branch; canonical order unchanged",
    );
    expect(fake.calls.some((call) => call.action === "move")).toBe(false);

    fake.calls.length = 0;
    await controller.handleKeypress("", { name: "down", shift: true }, "pass");
    expect(controller.view().status).toBe(
      "Already last in virtual branch; canonical order unchanged",
    );
    expect(fake.calls.some((call) => call.action === "virtual.occurrences.reorder")).toBe(false);
  });

  test("keeps occurrence hierarchy effects disabled and left selects its definition", async () => {
    const definition = block("view", {
      properties: [
        { key: "type", value: "virtual-branch" },
        { key: "query", value: "status=Doing" },
      ],
    });
    const card = block("card", { properties: [{ key: "status", value: "Doing" }] });
    const fake = harness((input) => {
      if (input.action === "workspace.snapshot") {
        return snapshot([definition, card], definition);
      }
      if (input.action === "blocks.query") {
        return { blocks: [card], completeness: { kind: "complete" } };
      }
      return undefined;
    });
    const controller = createTreeController(fake.effects);
    await controller.initialize();
    await controller.handleKeypress("", { name: "down" }, "pass");
    fake.calls.length = 0;

    await controller.handleKeypress("", { name: "right" }, "pass");
    await controller.handleKeypress("", { name: "space" }, "pass");
    await controller.handleKeypress("a", { name: "a" }, "pass");
    await controller.handleKeypress("s", { name: "s" }, "pass");
    await controller.handleKeypress("", { name: "tab" }, "pass");
    await controller.handleKeypress("", { name: "tab", shift: true }, "pass");

    expect(controller.view().status).toBe(
      "Virtual occurrence outdent is disabled; canonical hierarchy unchanged",
    );
    expect(fake.calls.some((call) =>
      ["toggle", "move", "create", "get", "children"].includes(call.action)
    )).toBe(false);

    await controller.handleKeypress("", { name: "left" }, "pass");
    expect(controller.view().rows[controller.view().selectedIndex]?.rowId).toBe("view");
    expect(fake.calls.at(-1)).toEqual({ action: "selection.set", blockId: "view" });
  });

  test("restores Trash roots and requires the exact identifier for permanent purge", async () => {
    const definition = block("trash-view", {
      text: "Trash [type::virtual-branch] [query::deleted=true]",
      properties: [
        { key: "type", value: "virtual-branch" },
        { key: "query", value: "deleted=true" },
      ],
    });
    const deleted = block("deleted-block", {
      text: "PIE-999 deleted [work-id::PIE-999]",
      properties: [{ key: "work-id", value: "PIE-999" }],
      deletedAt: "deleted-at",
      effectiveDeletedRootId: "deleted-block",
    });
    const makeTrashHarness = () => {
      let present = true;
      const fake = harness((input) => {
        if (input.action === "workspace.snapshot") {
          return snapshot([definition], definition);
        }
        if (input.action === "blocks.query") {
          return {
            blocks: present ? [deleted] : [],
            completeness: { kind: "complete" },
          };
        }
        if (input.action === "trash.restore" || input.action === "trash.purge") {
          present = false;
          return deleted;
        }
        return undefined;
      });
      return fake;
    };

    const restoreFake = makeTrashHarness();
    const restoreController = createTreeController(restoreFake.effects);
    await restoreController.initialize();
    await restoreController.handleKeypress("", { name: "down" }, "pass");
    restoreFake.calls.length = 0;
    await restoreController.handleKeypress("r", { name: "r" }, "pass");
    expect(restoreFake.calls).toContainEqual({
      action: "trash.restore",
      blockId: deleted.id,
    });
    expect(restoreController.view().status).toBe("Restored from Trash");

    const purgeFake = makeTrashHarness();
    const purgeController = createTreeController(purgeFake.effects);
    await purgeController.initialize();
    await purgeController.handleKeypress("", { name: "down" }, "pass");
    await purgeController.handleKeypress("p", { name: "p" }, "pass");
    expect(purgeController.view().mode).toBe("purge");
    for (const character of "PIE-999") {
      await purgeController.handleKeypress(character, { name: character }, "pass");
    }
    await purgeController.handleKeypress("", { name: "return" }, "pass");
    expect(purgeFake.calls).toContainEqual({
      action: "trash.purge",
      blockId: deleted.id,
      confirmation: "PIE-999",
    });
    expect(purgeFake.calls.at(-1)).toEqual({
      action: "selection.set",
      blockId: definition.id,
    });
    expect(purgeController.view().status).toBe("Permanently purged");
  });
});
