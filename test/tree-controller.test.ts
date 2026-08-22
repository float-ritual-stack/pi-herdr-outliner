import { describe, expect, test } from "bun:test";
import type { RequestInput } from "../src/client";
import { createTreeController, type TreeControllerEffects } from "../src/tree-controller";
import type { Block, OutlinerEvent, VisibleBlock, WorkspaceSnapshot } from "../src/types";

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

function snapshot(blocks: VisibleBlock[], selected: Block | null = null): WorkspaceSnapshot {
  return {
    blocks,
    allBlocks: blocks,
    selection: { selected, ancestors: [], children: [] },
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
    expect(controller.view().rows[controller.view().selectedIndex]?.id).toBe("second");
    expect(fake.calls.at(-1)).toEqual({ action: "selection.set", blockId: "second" });

    await controller.handleServiceEvent(event("content"));
    expect(controller.view().rows[controller.view().selectedIndex]?.id).toBe("second");
    expect(fake.calls.filter((call) => call.action === "selection.set")).toHaveLength(1);
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
      if (input.action === "list" && input.query?.filters) return [];
      if (input.action === "list") return [home];
      return undefined;
    });
    const controller = createTreeController(fake.effects);
    await controller.initialize();
    await controller.handleKeypress("", { name: "return" }, "pass");

    await controller.handleKeypress("", { name: "tab" }, "pass");
    expect(fake.calls.filter((call) => call.action === "list")).toEqual([
      {
        action: "list",
        query: { text: "ho", filters: [{ key: "type", value: "page" }], limit: 20 },
      },
      {
        action: "list",
        query: { text: "ho", limit: 20, includeCollapsed: true },
      },
    ]);
    expect(controller.view().quickCompletion?.items[0]).toEqual({
      label: "Home",
      insertion: "[[Home]]",
    });

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
});
