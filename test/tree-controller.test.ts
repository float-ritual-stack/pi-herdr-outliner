import { describe, expect, test } from "bun:test";
import {
  attentionClientState,
  emptyAttentionState,
  normalizeAttentionMark,
} from "../src/attention";
import type { RequestInput } from "../src/client";
import { OutlinerActionKeymap } from "../src/outliner-actions";
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
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
    properties: [],
    depth: 0,
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
    workIdPrefix?: string;
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
    workIdPrefix: options.workIdPrefix,
  };
}

interface Harness {
  readonly calls: RequestInput[];
  effects: TreeControllerEffects;
  readonly focused: Array<"detail" | "outliner">;
  readonly createdDetails: string[];
  readonly createdDetailDirections: Array<"right" | "down">;
  readonly openedCaptures: string[];
  invalidations: number;
  stops: number;
}

function harness(
  respond: (input: RequestInput) => unknown | Promise<unknown>,
  clientId = "tree-test",
): Harness {
  const result: Harness = {
    calls: [],
    focused: [],
    createdDetails: [],
    createdDetailDirections: [],
    openedCaptures: [],
    invalidations: 0,
    stops: 0,
    effects: {
      clientId,
      browsingContextId: `${clientId}-context`,
      workspaceRoot: "/workspace",
      request: async <T>(input: RequestInput): Promise<T> => {
        result.calls.push(input);
        const response = await respond(input);
        if (response === undefined && input.action === "clients.list") {
          return [{
            clientId: input.role === "tree" ? clientId : "detail-test",
            role: input.role ?? "tree",
            contextId: `${clientId}-context`,
          }] as T;
        }
        if (response === undefined && input.action === "attention.get") {
          return emptyAttentionState(input.targetClientId) as T;
        }
        if (response === undefined && input.action === "attention.acknowledge") {
          return emptyAttentionState(input.input.targetClientId) as T;
        }
        if (response === undefined && input.action === "browsing-context.publish") {
          return {
            contextId: input.contextId,
            target: { selected: null, ancestors: [], children: [] },
          } as T;
        }
        if (response === undefined && input.action === "navigation.dispatch") {
          const targetClientId = input.intent === "reveal" ? clientId : "detail-test";
          return {
            sourceClientId: input.sourceClientId,
            targetClientId,
            intent: input.intent,
            resolution: input.intent === "reveal" ? "self" : "unlocked",
            command: {
              targetClientId,
              command: input.intent,
              blockId: input.blockId,
            },
          } as T;
        }
        if (response === undefined && input.action === "navigation.resolve") {
          return {
            sourceClientId: input.sourceClientId,
            targetClientId: "detail-test",
            intent: input.intent,
            resolution: "unlocked",
          } as T;
        }
        return response as T;
      },
      filesystem: {
        completeReferencedPaths: () => [],
        readReferencedFile: () => {
          throw new Error("not configured");
        },
      },
      createDetailPane: async (blockId, direction = "down") => {
        result.createdDetails.push(blockId);
        result.createdDetailDirections.push(direction);
      },
      openCapturePopup: async (capturedFromBlockId) => {
        result.openedCaptures.push(capturedFromBlockId);
      },
      focusSelf: () => result.focused.push("outliner"),
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
  test("remaps browse actions, suppresses stale defaults, and invokes the action menu", async () => {
    const first = block("first");
    const second = block("second", { position: 1 });
    const fake = harness((input) =>
      input.action === "workspace.snapshot" ? snapshot([first, second], first) : undefined
    );
    fake.effects = {
      ...fake.effects,
      actionKeymap: new OutlinerActionKeymap("<test>", {
        "tree.move.down": ["j"],
      }),
    };
    const controller = createTreeController(fake.effects);
    await controller.initialize();

    await controller.handleKeypress("j", { name: "j" }, "pass");
    expect(controller.view().rows[controller.view().selectedIndex]?.canonicalId).toBe("second");
    await controller.handleKeypress("", { name: "down" }, "pass");
    expect(controller.view().rows[controller.view().selectedIndex]?.canonicalId).toBe("second");

    await controller.handleAction("tree.menu.open");
    expect(controller.view().mode).toBe("action-menu");
    expect(controller.view().actionMenuItems?.length).toBeGreaterThan(0);
    await controller.handleKeypress("dtrt", {}, "pass");
    expect(controller.view().actionMenuQuery).toBe("dtrt");
    expect(controller.view().actionMenuItems?.[0]?.id).toBe("tree.detail.right");
    expect(controller.view().actionMenuItems?.length).toBeLessThan(
      fake.effects.actionKeymap!.menuItems("tree", "browse").length,
    );
    await controller.handleKeypress("", { name: "backspace" }, "pass");
    expect(controller.view().actionMenuQuery).toBe("dtr");
    await controller.handleAction("tree.detail.right");
    expect(fake.createdDetailDirections).toEqual(["right"]);
    expect(controller.view().mode).toBe("browse");
  });

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
    expect(fake.calls.filter((call) => call.action === "browsing-context.publish")).toHaveLength(1);

    await controller.handleServiceEvent(event("content"));
    expect(controller.view().rows[controller.view().selectedIndex]?.canonicalId).toBe("second");
    expect(fake.calls.filter((call) => call.action === "browsing-context.publish")).toHaveLength(1);
  });

  test("selects clicked rows and opens a modified-click row in Detail", async () => {
    const first = block("first");
    const second = block("second", { position: 1 });
    const fake = harness((input) =>
      input.action === "workspace.snapshot" ? snapshot([first, second], first) : undefined
    );
    const controller = createTreeController(fake.effects);
    await controller.initialize();
    fake.calls.length = 0;

    await controller.handleRowClick(second.id);
    expect(controller.view().rows[controller.view().selectedIndex]?.canonicalId).toBe(second.id);
    expect(lastCall(fake.calls, "browsing-context.publish")).toMatchObject({
      blockId: second.id,
    });

    fake.calls.length = 0;
    await controller.handleRowClick(first.id, true);
    expect(controller.view().rows[controller.view().selectedIndex]?.canonicalId).toBe(first.id);
    expect(lastCall(fake.calls, "navigation.dispatch")).toMatchObject({
      blockId: first.id,
      intent: "open",
    });
    expect(controller.view().status).toBe("Reader opened in first unlocked Detail");
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
    expect(lastCall(fake.calls, "browsing-context.publish")).toEqual({ action: "browsing-context.publish", sourceClientId: "tree-test", contextId: "tree-test-context", blockId: target.id });
  });
  test("opens the first block reference without moving Tree-local selection", async () => {
    const source = block("source01", {
      text: "Source points to ((target01))",
      displayText: "Source points to ((target01))",
    });
    const target = block("target01", { position: 1, text: "Target", displayText: "Target" });
    const fake = harness((input) => {
      if (input.action === "workspace.snapshot") return snapshot([source, target], source);
      if (input.action === "get") return input.blockId === source.id ? source : target;
      return undefined;
    });
    const controller = createTreeController(fake.effects);
    await controller.initialize();

    await controller.handleKeypress("o", { name: "o" }, "pass");
    expect(controller.view().rows[controller.view().selectedIndex]?.canonicalId).toBe(source.id);
    expect(lastCall(fake.calls, "navigation.dispatch")).toEqual({
      action: "navigation.dispatch",
      sourceClientId: "tree-test",
      blockId: target.id,
      intent: "open",
    });
    expect(controller.view().status).toBe("Opened Target in first unlocked Detail");

    await controller.handleKeypress("R", { name: "r", shift: true }, "pass");
    expect(fake.calls.filter((call) => call.action === "navigation.dispatch")).toEqual([
      expect.objectContaining({ blockId: target.id, intent: "open" }),
      expect.objectContaining({ blockId: target.id, intent: "reveal" }),
    ]);
    expect(controller.view().rows[controller.view().selectedIndex]?.canonicalId).toBe(source.id);

    await controller.handleKeypress("", { name: "b", meta: true }, "pass");
    expect(controller.view().rows[controller.view().selectedIndex]?.canonicalId).toBe(source.id);
    expect(fake.calls.some((call) => call.action === "navigation.back")).toBe(false);
  });

  test("creates and follows a dangling symbolic reference only on explicit open", async () => {
    const source = block("source01", {
      text: "Source points to [[Future Page]]",
      displayText: "Source points to [[Future Page]]",
    });
    const target = block("target01", {
      position: 1,
      text: "Future Page [page::Future Page]",
      displayText: "Future Page [page::Future Page]",
    });
    let selected = source;
    const fake = harness((input) => {
      if (input.action === "workspace.snapshot") return snapshot([source, target], selected);
      if (input.action === "pages.resolve") {
        return {
          address: input.address,
          normalizedAddress: "future page",
          status: "missing",
        };
      }
      if (input.action === "pages.follow") {
        return {
          address: input.address,
          normalizedAddress: "future page",
          registeredAddress: "Future Page",
          status: "resolved",
          kind: "page",
          block: target,
          created: true,
        };
      }
      if (input.action === "browsing-context.publish") {
        selected = input.blockId === target.id ? target : source;
        return { selected, ancestors: [], children: [] };
      }
      return undefined;
    });
    const controller = createTreeController(fake.effects);
    await controller.initialize();

    await controller.handleKeypress("o", { name: "o" }, "pass");

    expect(lastCall(fake.calls, "pages.follow")).toEqual({
      action: "pages.follow",
      address: "Future Page",
    });
    expect(controller.view().rows[controller.view().selectedIndex]?.canonicalId).toBe(source.id);
    expect(controller.view().status).toBe("Created and opened Future Page in first unlocked Detail");
  });

  test("follows a bare Work ID for the configured project prefix", async () => {
    const source = block("source01", {
      text: "Source points to ABC-001 and PIE-001",
      displayText: "Source points to ABC-001 and PIE-001",
    });
    const target = block("target01", { position: 1, text: "Target", displayText: "Target" });
    let selected = source;
    const fake = harness((input) => {
      if (input.action === "workspace.snapshot") {
        return snapshot([source, target], selected, { workIdPrefix: "ABC" });
      }
      if (input.action === "pages.resolve") {
        return {
          address: input.address,
          normalizedAddress: "abc-001",
          registeredAddress: "ABC-001",
          status: "resolved",
          kind: "work-id",
          block: target,
        };
      }
      if (input.action === "browsing-context.publish") {
        selected = input.blockId === target.id ? target : source;
      }
      return undefined;
    });
    const controller = createTreeController(fake.effects);
    await controller.initialize();

    await controller.handleKeypress("o", { name: "o" }, "pass");

    expect(lastCall(fake.calls, "pages.resolve")).toEqual({
      action: "pages.resolve",
      address: "ABC-001",
    });
    expect(controller.view().rows[controller.view().selectedIndex]?.canonicalId).toBe(source.id);
    expect(lastCall(fake.calls, "navigation.dispatch")).toMatchObject({
      sourceClientId: "tree-test",
      blockId: target.id,
      intent: "open",
    });
  });

  test("opens a deleted reference read-only in Detail", async () => {
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
      if (input.action === "browsing-context.publish") {
        selected = input.blockId === deleted.id ? deleted : source;
        return { selected, ancestors: [], children: [] };
      }
      return undefined;
    });
    const controller = createTreeController(fake.effects);
    await controller.initialize();

    await controller.handleKeypress("o", { name: "o" }, "pass");
    expect(fake.focused).toEqual([]);
    expect(lastCall(fake.calls, "navigation.dispatch")).toEqual({
      action: "navigation.dispatch",
      sourceClientId: "tree-test",
      blockId: deleted.id,
      intent: "open",
    });

  });
  test("keeps Detail locking out of the Tree command surface", async () => {
    const root = block("root", { text: "Root", displayText: "Root" });
    const fake = harness((input) =>
      input.action === "workspace.snapshot" ? snapshot([root], root) : undefined
    );
    const controller = createTreeController(fake.effects);
    await controller.initialize();

    await controller.handleKeypress("L", { name: "l", shift: true }, "pass");

    expect(controller.view().mode).toBe("browse");
    expect(controller.view().status).toBe("Lock or unlock from a Detail pane");
    expect(fake.calls.some(({ action }) => action === "navigation.resolve")).toBe(false);
  });
  test("opens right and lower Details while Delete retains confirmation", async () => {
    const root = block("root", { text: "Root", displayText: "Root" });
    const fake = harness((input) =>
      input.action === "workspace.snapshot" ? snapshot([root], root) : undefined
    );
    const controller = createTreeController(fake.effects);
    await controller.initialize();

    await controller.handleKeypress("d", { name: "d" }, "pass");
    await controller.handleKeypress("D", { name: "d", shift: true }, "pass");
    await controller.handleKeypress("", { name: "delete" }, "pass");

    expect(fake.createdDetails).toEqual([root.id, root.id]);
    expect(fake.createdDetailDirections).toEqual(["right", "down"]);
    expect(controller.view().mode).toBe("delete");
    expect(fake.calls.some(({ action }) => action === "delete")).toBe(false);
    expect(fake.calls.some(({ action }) => action === "navigation.dispatch")).toBe(false);
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
      view: undefined,
    });
    expect(controller.view().rows).toHaveLength(501);
    expect(controller.view().physicalBlocksById.size).toBe(501);
    expect(controller.view().visibleCompleteness).toEqual({ kind: "complete" });
    expect(controller.view().rows[controller.view().selectedIndex]?.canonicalId).toBe("block-500");
    expect(fake.calls.filter((call) => call.action === "browsing-context.publish")).toHaveLength(1);
  });

  test("completes quoted property filters and preserves the prior view on parse errors", async () => {
    const alpha = block("alpha", {
      text: "Alpha [status::in progress]",
      properties: [{ key: "status", value: "in progress" }],
    });
    const beta = block("beta", {
      position: 1,
      text: "Beta [status::in review]",
      properties: [{ key: "status", value: "in review" }],
    });
    const fake = harness((input) => {
      if (input.action === "workspace.snapshot") {
        const filtered = input.view?.query?.filters?.[0]?.value === "in progress";
        return snapshot(filtered ? [alpha] : [alpha, beta], alpha, {
          physicalBlocks: [alpha, beta],
        });
      }
      if (input.action === "properties.catalog") {
        return input.key === "status"
          ? [{ key: "status", value: "in progress", count: 4 }]
          : [
              { key: "status", value: "in progress", count: 4 },
              { key: "status", value: "in review", count: 2 },
              { key: "stage", value: "next", count: 1 },
            ];
      }
      if (input.action === "browsing-context.publish") {
        return { selected: alpha, ancestors: [], children: [] };
      }
      return undefined;
    });
    const controller = createTreeController(fake.effects);
    await controller.initialize();

    await controller.handleKeypress("/", { name: "/" }, "pass");
    await controller.handleKeypress("sta", { sequence: "sta" }, "pass");
    await controller.handleKeypress("", { name: "tab" }, "pass");
    expect(lastCall(fake.calls, "properties.catalog")).toEqual({
      action: "properties.catalog",
      prefix: "sta",
      limit: 100,
    });
    expect(controller.view().quickCompletion?.items[0]).toEqual({
      label: "status (6)",
      insertion: "status=",
    });
    await controller.handleKeypress("", { name: "tab" }, "pass");
    await controller.handleKeypress("in", { sequence: "in" }, "pass");
    await controller.handleKeypress("", { name: "tab" }, "pass");
    expect(lastCall(fake.calls, "properties.catalog")).toEqual({
      action: "properties.catalog",
      key: "status",
      prefix: "in",
      limit: 20,
    });
    await controller.handleKeypress("", { name: "tab" }, "pass");
    expect(controller.view().quickInput).toBe('status="in progress"');
    await controller.handleKeypress("", { name: "return" }, "pass");

    expect(controller.view().activeFilter).toBe('status="in progress"');
    expect(controller.view().rows.map((row) => row.canonicalId)).toEqual(["alpha"]);
    expect(lastCall(fake.calls, "workspace.snapshot")).toEqual({
      action: "workspace.snapshot",
      view: {
        query: {
          filters: [{ key: "status", value: "in progress" }],
          limit: 500,
        },
      },
    });

    await controller.handleKeypress("/", { name: "/" }, "pass");
    await controller.handleKeypress('"', { sequence: '"' }, "pass");
    await controller.handleKeypress("", { name: "return" }, "pass");
    expect(controller.view().mode).toBe("filter");
    expect(controller.view().activeFilter).toBe('status="in progress"');
    expect(controller.view().rows.map((row) => row.canonicalId)).toEqual(["alpha"]);
    expect(controller.view().status).toContain("Invalid filter:");
  });

  test("opens a Herdr capture popup without moving the selected Tree row", async () => {
    const origin = block("origin", { text: "Deep origin" });
    const fake = harness((input) =>
      input.action === "workspace.snapshot" ? snapshot([origin], origin) : undefined
    );
    const controller = createTreeController(fake.effects);
    await controller.initialize();

    await controller.handleKeypress("c", { name: "c" }, "pass");

    expect(fake.openedCaptures).toEqual([origin.id]);
    expect(fake.calls.some((call) => call.action === "capture.create")).toBe(false);
    expect(controller.view().mode).toBe("browse");
    expect(controller.view().rows[controller.view().selectedIndex]?.rowId).toBe(origin.id);
    expect(controller.view().status).toBe("Opened quick capture popup");
    expect(fake.calls.filter((call) => call.action === "browsing-context.publish")).toHaveLength(1);
  });

  test("keeps Tree selection stable when the capture popup cannot open", async () => {
    const origin = block("origin");
    const fake = harness((input) =>
      input.action === "workspace.snapshot" ? snapshot([origin], origin) : undefined
    );
    fake.effects.openCapturePopup = async () => {
      throw new Error("popup unavailable");
    };
    const controller = createTreeController(fake.effects);
    await controller.initialize();

    await controller.handleKeypress("c", { name: "c" }, "pass");

    expect(controller.view().mode).toBe("browse");
    expect(controller.view().rows[controller.view().selectedIndex]?.rowId).toBe(origin.id);
    expect(controller.view().status).toBe("popup unavailable");
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

    expect(fake.calls.at(-1)).toEqual({ action: "browsing-context.publish", sourceClientId: "tree-test", contextId: "tree-test-context", blockId: "first" });
  });

  test("receives workspace context publication without moving the local cursor", async () => {
    const first = block("first");
    const second = block("second", { position: 1 });
    const fake = harness((input) =>
      input.action === "workspace.snapshot" ? snapshot([first, second], first) : undefined,
    );
    const controller = createTreeController(fake.effects);

    await controller.initialize();
    await controller.handleKeypress("", { name: "down" }, "pass");
    await controller.handleServiceEvent(event("browsing-context", first.id));

    expect(controller.view().rows[controller.view().selectedIndex]?.canonicalId).toBe(second.id);
    expect(controller.view().workspaceContextBlockId).toBe(first.id);
  });

  test("keeps presentation, cursor, history, and filters independent across two Trees", async () => {
    const rootText = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
    const root = block("root", {
      text: rootText,
      displayText: rootText,
      hasChildren: true,
    });
    const child = block("child", { parentId: root.id, depth: 1 });
    const peer = block("peer", {
      position: 1,
      properties: [{ key: "kind", value: "peer" }],
    });
    let workspaceSelection: Block = root;
    const respond = (input: RequestInput): unknown => {
      if (input.action === "workspace.snapshot") {
        const visible = input.view ? [peer] : [root, child, peer];
        return snapshot(visible, workspaceSelection, {
          physicalBlocks: [root, child, peer],
        });
      }
      if (input.action === "browsing-context.publish") {
        workspaceSelection =
          [root, child, peer].find((candidate) => candidate.id === input.blockId) ?? root;
        return { selected: workspaceSelection, ancestors: [], children: [] };
      }
      if (input.action === "get") {
        return [root, child, peer].find((candidate) => candidate.id === input.blockId);
      }
      return undefined;
    };
    const firstHarness = harness(respond, "tree-first");
    const secondHarness = harness(respond, "tree-second");
    const first = createTreeController(firstHarness.effects);
    const second = createTreeController(secondHarness.effects);
    await first.initialize();
    await second.initialize();

    await first.handleKeypress(".", { name: "." }, "modified-enter");
    await first.handleKeypress("", { name: "pagedown" }, "pass");
    expect(first.view().expandedBlockOffset).toBeGreaterThan(0);
    expect(second.view().expandedBlockOffset).toBe(0);
    expect(first.view().rows[0]?.multilineExpanded).toBe(true);
    expect(second.view().rows[0]?.multilineExpanded).toBe(false);

    await first.handleKeypress("", { name: "space" }, "pass");
    expect(first.view().rows.map((row) => row.canonicalId)).toEqual(["root", "peer"]);
    expect(second.view().rows.map((row) => row.canonicalId)).toEqual(["root", "child", "peer"]);
    await first.handleKeypress("", { name: "down" }, "pass");
    await second.handleServiceEvent(event("browsing-context", peer.id));
    expect(second.view().rows[second.view().selectedIndex]?.canonicalId).toBe(root.id);
    expect(second.view().workspaceContextBlockId).toBe(peer.id);

    await second.handleServiceEvent({
      id: "target-second",
      domain: "ui",
      action: "ui.command.send",
      sequence: 3,
      command: {
        targetClientId: "tree-second",
        command: "reveal",
        blockId: child.id,
      },
    });
    await first.handleServiceEvent(event("browsing-context", child.id));
    expect(second.view().rows[second.view().selectedIndex]?.canonicalId).toBe(child.id);
    expect(first.view().rows[first.view().selectedIndex]?.canonicalId).toBe(peer.id);
    expect(first.view().rows.map((row) => row.canonicalId)).toEqual(["root", "peer"]);

    await second.handleKeypress("", { name: "left", meta: true }, "pass");
    expect(second.view().rows[second.view().selectedIndex]?.canonicalId).toBe(root.id);
    expect(firstHarness.calls.map((call) => String(call.action))).not.toContain("navigation.back");
    expect(secondHarness.calls.map((call) => String(call.action))).not.toContain("navigation.back");

    await first.handleKeypress("/", { name: "/" }, "pass");
    await first.handleKeypress("kind=peer", { sequence: "kind=peer" }, "pass");
    await first.handleKeypress("", { name: "return" }, "pass");
    expect(first.view().activeFilter).toBe("kind=peer");
    expect(second.view().activeFilter).toBe("");
  });

  test("reveals a target by expanding only this Tree's collapsed ancestors", async () => {
    const parent = block("parent", { hasChildren: true });
    const hidden = block("hidden", { parentId: parent.id, depth: 1 });
    const fake = harness((input) =>
      input.action === "workspace.snapshot"
        ? snapshot([parent, hidden], parent)
        : undefined,
    );
    const controller = createTreeController(fake.effects);
    await controller.initialize();
    await controller.handleKeypress("", { name: "space" }, "pass");
    expect(controller.view().rows.map((row) => row.canonicalId)).toEqual(["parent"]);

    await controller.handleServiceEvent({
      id: "reveal",
      domain: "ui",
      action: "ui.command.send",
      sequence: 2,
      command: { targetClientId: "tree-test", command: "reveal", blockId: "hidden" },
    });

    expect(fake.calls.map((call) => String(call.action))).not.toContain("toggle");
    expect(fake.calls.at(-1)).toEqual({ action: "browsing-context.publish", sourceClientId: "tree-test", contextId: "tree-test-context", blockId: "hidden" });
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
    expect(fake.calls.some((call) => call.action === "browsing-context.publish")).toBe(false);
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

  test("commits a quick child before targeted Detail handoff", async () => {
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
      "browsing-context.publish",
      "navigation.resolve",
      "ui.command.send",
    ]);
    expect(fake.calls.find((call) => call.action === "move")).toEqual({
      action: "move",
      blockId: "child",
      parentId: "parent",
      position: 0,
    });
    expect(controller.view().mode).toBe("browse");
    expect(controller.view().status).toBe("Multiline editor opened and locked in first unlocked Detail");
  });

  test("Enter opens the first unlocked Detail while e explicitly edits and locks", async () => {
    const selected = block("selected", {
      text: "First line\nSecond line",
      displayText: "First line\nSecond line",
    });
    const fake = harness((input) =>
      input.action === "workspace.snapshot" ? snapshot([selected], selected) : undefined
    );
    const controller = createTreeController(fake.effects);
    await controller.initialize();

    await controller.handleKeypress("", { name: "return" }, "pass");
    expect(controller.view().mode).toBe("browse");
    expect(lastCall(fake.calls, "navigation.dispatch")).toEqual({
      action: "navigation.dispatch",
      sourceClientId: "tree-test",
      blockId: selected.id,
      intent: "open",
    });
    expect(controller.view().status).toBe("Reader opened in first unlocked Detail");

    await controller.handleKeypress("e", { name: "e" }, "pass");
    expect(lastCall(fake.calls, "ui.command.send")).toEqual({
      action: "ui.command.send",
      command: { targetClientId: "detail-test", command: "edit", blockId: selected.id },
    });
    expect(controller.view().status).toBe(
      "Multiline editor opened and locked in first unlocked Detail",
    );
  });

  test("single-line Enter stays reader-only until explicit e", async () => {
    const selected = block("selected", { text: "One line", displayText: "One line" });
    const fake = harness((input) =>
      input.action === "workspace.snapshot" ? snapshot([selected], selected) : undefined
    );
    const controller = createTreeController(fake.effects);
    await controller.initialize();

    await controller.handleKeypress("", { name: "return" }, "pass");
    expect(controller.view().mode).toBe("browse");
    expect(controller.view().quickInput).toBe("");

    await controller.handleKeypress("e", { name: "e" }, "pass");
    expect(controller.view().mode).toBe("edit");
    expect(controller.view().quickInput).toBe("One line");
  });

  test("defers service events during editing and reloads once editing is cancelled", async () => {
    const selected = block("selected");
    const fake = harness((input) => input.action === "workspace.snapshot" ? snapshot([selected], selected) : undefined);
    const controller = createTreeController(fake.effects);
    await controller.initialize();

    await controller.handleKeypress("e", { name: "e" }, "pass");
    const callsBeforeEvent = fake.calls.length;
    await controller.handleServiceEvent(event("content", "selected"));
    expect(fake.calls).toHaveLength(callsBeforeEvent);
    expect(controller.view().refreshPending).toBe(true);

    await controller.handleKeypress("", { name: "escape" }, "pass");
    expect(fake.calls.slice(callsBeforeEvent).map((call) => call.action)).toEqual(["workspace.snapshot"]);
    expect(controller.view().mode).toBe("browse");
    expect(controller.view().refreshPending).toBe(false);
  });

  test("applies registered symbolic-address completion without generic block fallback", async () => {
    const selected = block("selected", { text: "[[ho", displayText: "[[ho" });
    const fake = harness((input) => {
      if (input.action === "workspace.snapshot") return snapshot([selected], selected);
      if (input.action === "pages.complete") {
        return {
          addresses: [{
            address: "home",
            normalizedAddress: "home",
            blockId: "home-id",
            kind: "page",
            title: "Home",
          }],
          completeness: { kind: "truncated", limit: 20 },
        };
      }
      return undefined;
    });
    const controller = createTreeController(fake.effects);
    await controller.initialize();
    await controller.handleKeypress("e", { name: "e" }, "pass");

    await controller.handleKeypress("", { name: "tab" }, "pass");
    expect(fake.calls.filter((call) => call.action === "pages.complete")).toEqual([{
      action: "pages.complete",
      query: "ho",
      limit: 20,
    }]);
    expect(fake.calls.some((call) => call.action === "blocks.query")).toBe(false);
    expect(controller.view().quickCompletion?.items[0]).toEqual({
      label: "home — Home",
      insertion: "[[home]]",
      blockId: "home-id",
    });
    expect(controller.view().quickCompletion?.truncatedLimit).toBe(20);

    await controller.handleKeypress("", { name: "tab" }, "pass");
    expect(controller.view().quickInput).toBe("[[home]]");
  });
  test("normalizes Work-ID convenience completion to a titled canonical wikilink", async () => {
    const selected = block("selected", {
      text: "[[some title - PIE-175",
      displayText: "[[some title - PIE-175",
    });
    const fake = harness((input) => {
      if (input.action === "workspace.snapshot") {
        return { ...snapshot([selected], selected), workIdPrefix: "PIE" };
      }
      if (input.action === "pages.complete") {
        return {
          addresses: [{
            address: "PIE-175",
            normalizedAddress: "pie-175",
            blockId: "pie-175-id",
            kind: "work-id",
            title: "PIE-175 — Stable links",
          }],
          completeness: { kind: "complete" },
        };
      }
      return undefined;
    });
    const controller = createTreeController(fake.effects);
    await controller.initialize();
    await controller.handleKeypress("e", { name: "e" }, "pass");

    await controller.handleKeypress("", { name: "tab" }, "pass");
    expect(fake.calls.filter((call) => call.action === "pages.complete")).toContainEqual({
      action: "pages.complete",
      query: "PIE-175",
      limit: 20,
    });
    await controller.handleKeypress("", { name: "tab" }, "pass");
    expect(controller.view().quickInput).toBe(
      "[[PIE-175|some title - PIE-175]]",
    );
  });


  test("honors key precedence for close and detail-toggle inputs", async () => {
    const selected = block("selected");
    const fake = harness((input) => {
      if (input.action === "workspace.snapshot") return snapshot([selected], selected);
      return undefined;
    });
    const controller = createTreeController(fake.effects);
    await controller.initialize();

    const callsBeforeClose = fake.calls.length;
    await controller.handleKeypress("q", { name: "q", ctrl: true }, "pass");
    expect(fake.stops).toBe(1);
    expect(fake.calls).toHaveLength(callsBeforeClose);

    await controller.handleKeypress(".", { name: "." }, "modified-enter");
    expect(fake.calls.map((call) => String(call.action))).not.toContain("view.toggleMultiline");
    expect(controller.view().rows[0]?.multilineExpanded).toBe(true);
    expect(fake.calls.some((call) => call.action === "ui.command.send")).toBe(false);
    expect(controller.view().status).toBe("Block detail expanded");
  });

  test("pages within one expanded block and resets on reconnect or selection change", async () => {
    const text = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
    const expanded = block("expanded", {
      text,
      displayText: text,
    });
    const next = block("next", { position: 1 });
    const fake = harness((input) =>
      input.action === "workspace.snapshot"
        ? snapshot([expanded, next], expanded)
        : undefined,
    );
    const controller = createTreeController(fake.effects);
    await controller.initialize();
    await controller.handleKeypress(".", { name: "." }, "modified-enter");

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
    await controller.handleKeypress(".", { name: "." }, "modified-enter");
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
      "browsing-context.publish",
    ]);
    expect(fake.calls.some((call) => call.action === "move")).toBe(false);
    expect(controller.view().rows[controller.view().selectedIndex]?.rowId).toBe("created");
  });

  test("selects the visual successor beyond a deleted physical subtree before deletion", async () => {
    const parent = block("parent", { hasChildren: true });
    const child = block("child", { parentId: parent.id, depth: 1 });
    const successor = block("successor", { position: 1 });
    let physical = [parent, child, successor];
    let selected: Block | null = parent;
    const fake = harness((input) => {
      if (input.action === "workspace.snapshot") return snapshot(physical, selected);
      if (input.action === "browsing-context.publish") {
        selected = physical.find((candidate) => candidate.id === input.blockId) ?? null;
        return undefined;
      }
      if (input.action === "delete") {
        physical = physical.filter((candidate) => candidate.id === successor.id);
        return undefined;
      }
      return undefined;
    });
    const controller = createTreeController(fake.effects);
    await controller.initialize();

    await controller.handleKeypress("", { name: "delete" }, "pass");
    await controller.handleKeypress("y", { name: "y" }, "pass");

    const deleteIndex = fake.calls.findIndex((call) => call.action === "delete");
    expect(fake.calls[deleteIndex - 1]).toEqual({ action: "browsing-context.publish", sourceClientId: "tree-test", contextId: "tree-test-context", blockId: successor.id });
    expect(controller.view().rows[controller.view().selectedIndex]?.rowId).toBe(successor.id);
  });

  test("accounts for removed projected rows above a deleted physical row", async () => {
    const definition = block("view", {
      properties: [
        { key: "type", value: "virtual-branch" },
        { key: "query", value: "status=Doing" },
      ],
    });
    const card = block("card", {
      position: 1,
      properties: [{ key: "status", value: "Doing" }],
    });
    const successor = block("successor", { position: 2 });
    const tail = block("tail", { position: 3 });
    let cardPresent = true;
    let physical = [definition, card, successor, tail];
    let selected: Block | null = card;
    const fake = harness((input) => {
      if (input.action === "workspace.snapshot") return snapshot(physical, selected);
      if (input.action === "blocks.query") {
        return {
          blocks: cardPresent ? [card] : [],
          completeness: { kind: "complete" },
        };
      }
      if (input.action === "browsing-context.publish") {
        selected = physical.find((candidate) => candidate.id === input.blockId) ?? null;
        return undefined;
      }
      if (input.action === "delete") {
        cardPresent = false;
        physical = [definition, successor, tail];
        return undefined;
      }
      return undefined;
    });
    const controller = createTreeController(fake.effects);
    await controller.initialize();
    await controller.handleKeypress("", { name: "down" }, "pass");
    expect(controller.view().rows[controller.view().selectedIndex]?.rowId).toBe(card.id);

    await controller.handleKeypress("", { name: "delete" }, "pass");
    await controller.handleKeypress("y", { name: "y" }, "pass");

    expect(controller.view().rows[controller.view().selectedIndex]?.rowId).toBe(successor.id);
  });

  test("reloads deferred content when delete confirmation is cancelled", async () => {
    const selected = block("selected");
    const added = block("added", { position: 1 });
    let physical = [selected];
    const fake = harness((input) =>
      input.action === "workspace.snapshot" ? snapshot(physical, selected) : undefined
    );
    const controller = createTreeController(fake.effects);
    await controller.initialize();
    await controller.handleKeypress("", { name: "delete" }, "pass");

    physical = [selected, added];
    await controller.handleServiceEvent(event("content", added.id));
    expect(controller.view().refreshPending).toBe(true);
    await controller.handleKeypress("n", { name: "n" }, "pass");

    expect(controller.view().mode).toBe("browse");
    expect(controller.view().refreshPending).toBe(false);
    expect(controller.view().rows.map((row) => row.rowId)).toEqual([selected.id, added.id]);
    expect(fake.calls.some((call) => call.action === "delete")).toBe(false);
  });

  test("selects the previous visual row when deleting the final row", async () => {
    const previous = block("previous");
    const deleted = block("deleted", { position: 1 });
    let physical = [previous, deleted];
    let selected: Block | null = deleted;
    const fake = harness((input) => {
      if (input.action === "workspace.snapshot") return snapshot(physical, selected);
      if (input.action === "browsing-context.publish") {
        selected = physical.find((candidate) => candidate.id === input.blockId) ?? null;
        return undefined;
      }
      if (input.action === "delete") {
        physical = [previous];
        return undefined;
      }
      return undefined;
    });
    const controller = createTreeController(fake.effects);
    await controller.initialize();

    await controller.handleKeypress("", { name: "delete" }, "pass");
    await controller.handleKeypress("y", { name: "y" }, "pass");

    expect(controller.view().rows[controller.view().selectedIndex]?.rowId).toBe(previous.id);
    expect(fake.calls.findIndex((call) => call.action === "browsing-context.publish")).toBeLessThan(
      fake.calls.findIndex((call) => call.action === "delete"),
    );
  });

  test("skips projected rows owned by a deleted virtual-branch definition", async () => {
    const definition = block("view", {
      properties: [
        { key: "type", value: "virtual-branch" },
        { key: "query", value: "status=Doing" },
      ],
    });
    const successor = block("successor", { position: 1 });
    const card = block("card", {
      position: 2,
      properties: [{ key: "status", value: "Doing" }],
    });
    let physical = [definition, successor, card];
    let selected: Block | null = definition;
    const fake = harness((input) => {
      if (input.action === "workspace.snapshot") return snapshot(physical, selected);
      if (input.action === "blocks.query") {
        return { blocks: [card], completeness: { kind: "complete" } };
      }
      if (input.action === "browsing-context.publish") {
        selected = physical.find((candidate) => candidate.id === input.blockId) ?? null;
        return undefined;
      }
      if (input.action === "delete") {
        physical = [successor, card];
        return undefined;
      }
      return undefined;
    });
    const controller = createTreeController(fake.effects);
    await controller.initialize();

    await controller.handleKeypress("", { name: "delete" }, "pass");
    await controller.handleKeypress("y", { name: "y" }, "pass");

    expect(lastCall(fake.calls, "browsing-context.publish")).toEqual({ action: "browsing-context.publish", sourceClientId: "tree-test", contextId: "tree-test-context", blockId: successor.id });
    expect(controller.view().rows[controller.view().selectedIndex]?.rowId).toBe(successor.id);
  });

  test("keeps deletion focus at the visual position when the fallback row vanishes with a surviving occurrence", async () => {
    const laneView = block("lane-view", {
      properties: [
        { key: "type", value: "virtual-branch" },
        { key: "query", value: "lane=first" },
      ],
    });
    const target = block("target", { position: 1 });
    const card = block("card", {
      position: 2,
      properties: [{ key: "lane", value: "first" }],
    });
    const tail = block("tail", { position: 3 });
    let deleted = false;
    let serviceSelected: Block | null = laneView;
    const fake = harness((input) => {
      if (input.action === "workspace.snapshot") {
        // The fallback row's canonical block also disappears externally, while its
        // occurrence in the lane view survives.
        return snapshot(deleted ? [laneView, tail] : [laneView, target, card, tail], serviceSelected);
      }
      if (input.action === "blocks.query") {
        return { blocks: [card], completeness: { kind: "complete" } };
      }
      if (input.action === "browsing-context.publish") {
        serviceSelected = input.blockId === tail.id ? tail : serviceSelected;
        return undefined;
      }
      if (input.action === "delete") {
        deleted = true;
        return undefined;
      }
      return undefined;
    });
    const controller = createTreeController(fake.effects);
    await controller.initialize();
    await controller.handleKeypress("", { name: "down" }, "pass");
    await controller.handleKeypress("", { name: "down" }, "pass");
    expect(controller.view().rows[controller.view().selectedIndex]?.rowId).toBe("target");

    await controller.handleKeypress("", { name: "delete" }, "pass");
    await controller.handleKeypress("y", { name: "y" }, "pass");

    expect(lastCall(fake.calls, "delete")).toEqual({ action: "delete", blockId: "target" });
    expect(controller.view().rows[controller.view().selectedIndex]?.rowId).toBe("tail");
    expect(controller.view().rows[controller.view().selectedIndex]?.rowId).not.toBe(
      "occurrence:lane-view:card",
    );
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
    expect(fake.calls.map((call) => String(call.action))).not.toContain("view.toggleMultiline");
    expect(controller.view().rows[controller.view().selectedIndex]?.rowId).toBe(
      "occurrence:view:card",
    );
    expect(controller.view().rows[controller.view().selectedIndex]?.multilineExpanded).toBe(true);

    await controller.handleKeypress("f", { name: "f" }, "pass");
    expect(openedFileId).toBe("card");
    await controller.handleKeypress("", { name: "escape" }, "pass");

    await controller.handleKeypress("e", { name: "e" }, "pass");
    await controller.handleKeypress("!", { sequence: "!" }, "pass");
    await controller.handleKeypress("", { name: "return" }, "pass");
    expect(lastCall(fake.calls, "update")).toEqual({
      action: "update",
      blockId: "card",
      text: "Card!",
      expectedUpdatedAt: "2026-08-22T00:00:00.000Z",
      mutation: { author: "user", actorId: "tree" },
    });
    expect(controller.view().rows[controller.view().selectedIndex]?.rowId).toBe(
      "occurrence:view:card",
    );

    await controller.handleKeypress("", { name: "e", ctrl: true }, "pass");
    expect(lastCall(fake.calls, "ui.command.send")).toEqual({
      action: "ui.command.send",
      command: { targetClientId: "detail-test", command: "edit", blockId: "card" },
    });
    await controller.handleKeypress("", { name: "up" }, "pass");
    expect(controller.view().rows[controller.view().selectedIndex]?.rowId).toBe(
      "occurrence:view:card",
    );

    await controller.handleKeypress("", { name: "delete" }, "pass");
    await controller.handleKeypress("y", { name: "y" }, "pass");
    expect(lastCall(fake.calls, "delete")).toEqual({
      action: "delete",
      blockId: "card",
    });
    const deleteIndex = fake.calls.findIndex((call) => call.action === "delete");
    expect(fake.calls[deleteIndex - 1]).toEqual({ action: "browsing-context.publish", sourceClientId: "tree-test", contextId: "tree-test-context", blockId: "view" });
    expect(controller.view().rows[controller.view().selectedIndex]?.rowId).toBe("view");
    expect(controller.view().status).toBe("Moved to Trash");
    expect(JSON.stringify(fake.calls)).not.toContain("occurrence:");
  });

  test("falls back at a vanished occurrence's visual position instead of its physical row", async () => {
    const definition = block("view", {
      properties: [
        { key: "type", value: "virtual-branch" },
        { key: "query", value: "status=Doing" },
      ],
    });
    const context = block("context", { position: 1 });
    const card = block("card", {
      position: 2,
      properties: [{ key: "status", value: "Doing" }],
    });
    let matches = true;
    const fake = harness((input) => {
      if (input.action === "workspace.snapshot") {
        return snapshot([definition, context, card], definition);
      }
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

    expect(controller.view().rows[controller.view().selectedIndex]?.rowId).toBe("context");
    expect(lastCall(fake.calls, "browsing-context.publish")).toEqual({ action: "browsing-context.publish", sourceClientId: "tree-test", contextId: "tree-test-context", blockId: "context" });
  });

  test("does not retarget a vanished occurrence to its Trash occurrence", async () => {
    const doingView = block("doing-view", {
      properties: [
        { key: "type", value: "virtual-branch" },
        { key: "query", value: "status=Doing" },
      ],
    });
    const trashView = block("trash-view", {
      position: 1,
      properties: [
        { key: "type", value: "virtual-branch" },
        { key: "system-view", value: "trash" },
        { key: "query", value: "deleted=true" },
      ],
    });
    const context = block("context", { position: 2 });
    const card = block("card", {
      position: 3,
      properties: [{ key: "status", value: "Doing" }],
    });
    const trashedCard = {
      ...card,
      deletedAt: "deleted",
      effectiveDeletedRootId: card.id,
    };
    let deleted = false;
    let serviceSelected: Block | null = doingView;
    const fake = harness((input) => {
      if (input.action === "workspace.snapshot") {
        const active = deleted ? [doingView, trashView, context] : [doingView, trashView, context, card];
        return snapshot(active, serviceSelected);
      }
      if (input.action === "blocks.query") {
        if (input.query.includeDeleted) {
          return {
            blocks: deleted ? [trashedCard] : [],
            completeness: { kind: "complete" },
          };
        }
        return {
          blocks: deleted ? [] : [card],
          completeness: { kind: "complete" },
        };
      }
      if (input.action === "browsing-context.publish") {
        serviceSelected = input.blockId === trashView.id
          ? trashView
          : input.blockId === card.id
            ? card
            : serviceSelected;
      }
      return undefined;
    });
    const controller = createTreeController(fake.effects);
    await controller.initialize();
    await controller.handleKeypress("", { name: "down" }, "pass");
    expect(controller.view().rows[controller.view().selectedIndex]?.rowId).toBe(
      "occurrence:doing-view:card",
    );

    deleted = true;
    serviceSelected = trashedCard;
    await controller.handleServiceEvent(event("content", card.id));

    expect(controller.view().rows[controller.view().selectedIndex]?.rowId).toBe(trashView.id);
    expect(controller.view().rows[controller.view().selectedIndex]?.rowId).not.toBe(
      "occurrence:trash-view:card",
    );
    expect(lastCall(fake.calls, "browsing-context.publish")).toEqual({ action: "browsing-context.publish", sourceClientId: "tree-test", contextId: "tree-test-context", blockId: trashView.id });
  });

  test("uses the same visual index when one of several occurrences disappears", async () => {
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
    await controller.handleServiceEvent({
      id: "reveal-invalid",
      domain: "ui",
      action: "ui.command.send",
      sequence: 2,
      command: {
        targetClientId: "tree-test",
        command: "reveal",
        blockId: "invalid",
      },
    });
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
    await controller.handleServiceEvent(event("browsing-context", first.id));
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

  test("disables manual occurrence reorder for timestamp-sorted branches", async () => {
    const definition = block("sorted-view", {
      properties: [
        { key: "type", value: "virtual-branch" },
        { key: "query", value: "status=Done" },
        { key: "sort", value: "updated" },
        { key: "direction", value: "desc" },
      ],
    });
    const first = block("newest", { properties: [{ key: "status", value: "Done" }] });
    const second = block("older", {
      position: 1,
      properties: [{ key: "status", value: "Done" }],
    });
    const fake = harness((input) => {
      if (input.action === "workspace.snapshot") return snapshot([definition, first, second]);
      if (input.action === "blocks.query") {
        expect(input.query.sort).toEqual({ field: "updated", direction: "desc" });
        return { blocks: [first, second], completeness: { kind: "complete" } };
      }
      return undefined;
    });
    const controller = createTreeController(fake.effects);
    await controller.initialize();
    await controller.handleKeypress("", { name: "down" }, "pass");
    fake.calls.length = 0;

    await controller.handleKeypress("", { name: "down", shift: true }, "pass");

    expect(controller.view().status).toBe(
      "Virtual branch is sorted by updated desc; manual reorder is disabled",
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
    expect(fake.calls.at(-1)).toEqual({ action: "browsing-context.publish", sourceClientId: "tree-test", contextId: "tree-test-context", blockId: "view" });
  });


  test("navigates and discloses contextual descendants by row identity", async () => {
    const definition = block("view", {
      properties: [
        { key: "type", value: "virtual-branch" },
        { key: "query", value: "status=Doing" },
      ],
    });
    const first = block("first", {
      hasChildren: true,
      properties: [{ key: "status", value: "Doing" }],
    });
    const child = block("child", {
      parentId: first.id,
      depth: 1,
    });
    const second = block("second", {
      position: 1,
      properties: [{ key: "status", value: "Doing" }],
    });
    const physical = [definition, first, child, second];
    const fake = harness((input) => {
      if (input.action === "workspace.snapshot") return snapshot(physical, definition);
      if (input.action === "blocks.query") {
        return { blocks: [first, second], completeness: { kind: "complete" } };
      }
      return undefined;
    });
    const controller = createTreeController(fake.effects);
    const rootRowId = "occurrence:view:first";
    const childRowId = "occurrence:view:first:child";

    await controller.initialize();
    await controller.handleKeypress("", { name: "down" }, "pass");
    await controller.handleKeypress("", { name: "right" }, "pass");
    expect(controller.view().rows[controller.view().selectedIndex]?.rowId).toBe(childRowId);

    await controller.handleServiceEvent(event("content"));
    expect(controller.view().rows[controller.view().selectedIndex]?.rowId).toBe(childRowId);
    fake.calls.length = 0;
    await controller.handleKeypress("", { name: "down", shift: true }, "pass");
    expect(controller.view().status).toBe(
      "Virtual occurrence reorder is disabled; canonical hierarchy unchanged",
    );
    expect(fake.calls.some((call) => call.action === "virtual.occurrences.reorder")).toBe(false);

    await controller.handleKeypress("", { name: "left" }, "pass");
    expect(controller.view().rows[controller.view().selectedIndex]?.rowId).toBe(rootRowId);
    await controller.handleKeypress("", { name: "left" }, "pass");
    expect(controller.view().rows[controller.view().selectedIndex]).toEqual(
      expect.objectContaining({ rowId: rootRowId, collapsed: true, hasChildren: true }),
    );
    expect(controller.view().rows.some((row) => row.rowId === childRowId)).toBe(false);
    await controller.handleKeypress("", { name: "right" }, "pass");
    await controller.handleKeypress("", { name: "right" }, "pass");
    expect(controller.view().rows[controller.view().selectedIndex]?.rowId).toBe(childRowId);

    await controller.handleDisclosure(rootRowId);
    expect(controller.view().rows[controller.view().selectedIndex]?.rowId).toBe(rootRowId);
    expect(controller.view().rows.some((row) => row.rowId === childRowId)).toBe(false);
    await controller.handleDisclosure(rootRowId);
    expect(controller.view().rows.some((row) => row.rowId === childRowId)).toBe(true);
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
    expect(purgeFake.calls.at(-1)).toEqual({ action: "browsing-context.publish", sourceClientId: "tree-test", contextId: "tree-test-context", blockId: definition.id });
    expect(purgeController.view().status).toBe("Permanently purged");
  });
});

test("isolates Tree attention and reveals only on explicit instruction", async () => {
  const first = block("first");
  const target = block("target", { position: 1 });
  const fake = harness((input) =>
    input.action === "workspace.snapshot" ? snapshot([first, target], first) : undefined
  );
  const controller = createTreeController(fake.effects);
  await controller.initialize();
  const mark = normalizeAttentionMark({
    markId: "tree-attention",
    targetClientId: "tree-test",
    target: { kind: "block", sourceBlockId: target.id },
    tone: "info",
    sender: "agent-test",
  }, {
    clientId: "tree-test",
    role: "tree",
    contextId: "tree-test-context",
  }, target);
  const attention = attentionClientState("tree-test", [mark], 1);

  await controller.handleServiceEvent({
    id: "other-attention",
    domain: "attention",
    action: "attention.mark",
    sequence: 2,
    attention: { ...attention, targetClientId: "other-tree" },
  });
  expect(controller.view().attention.marks).toEqual([]);
  expect(controller.view().rows[controller.view().selectedIndex]?.canonicalId).toBe(first.id);

  await controller.handleServiceEvent({
    id: "targeted-attention",
    domain: "attention",
    action: "attention.mark",
    sequence: 3,
    blockId: target.id,
    attention,
    attentionInstruction: { markId: mark.markId, reveal: true, focus: true },
  });
  expect(controller.view().attention.currentMarkId).toBe(mark.markId);
  expect(controller.view().rows[controller.view().selectedIndex]?.canonicalId).toBe(target.id);
  expect(fake.focused).toEqual(["outliner"]);
  expect(fake.calls.some((call) => call.action === "selection.set")).toBe(false);

  await controller.handleKeypress("", { name: "x", ctrl: true }, "pass");
  expect(controller.view().attention.marks).toEqual([]);
  expect(controller.view().status).toBe("Attention cue acknowledged; active marks remain");
});
