import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { describe, expect, test } from "bun:test";
import type { TerminalKey } from "../src/terminal";
import type { Block, VisibleBlock } from "../src/types";
import {
  VirtualBranchNavigatorController,
  renderVirtualBranchNavigatorFrame,
  type VirtualBranchNavigatorEffects,
  type VirtualBranchNavigatorPreview,
} from "../src/virtual-branch-navigator";
import type {
  VirtualBranchNavigatorProjection,
  VirtualBranchNavigatorRenderResult,
} from "../src/virtual-branch-navigator";
import type {
  VirtualBranchOccurrenceRow,
  VirtualBranchState,
} from "../src/virtual-branches";

const plainMarkdownTheme: MarkdownTheme = {
  heading: (text) => text,
  link: (text) => text,
  linkUrl: (text) => text,
  code: (text) => text,
  codeBlock: (text) => text,
  codeBlockBorder: (text) => text,
  quote: (text) => text,
  quoteBorder: (text) => text,
  hr: (text) => text,
  listBullet: (text) => text,
  bold: (text) => text,
  italic: (text) => text,
  strikethrough: (text) => text,
  underline: (text) => text,
};

function block(id: string, text = id, properties: Block["properties"] = []): Block {
  return {
    id,
    parentId: null,
    position: 0,
    text,
    author: "user",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    properties,
  };
}

function visibleBlock(id: string, text = id): VisibleBlock {
  return {
    ...block(id, text),
    depth: 0,
    hasChildren: false,
    displayText: text,
  };
}

function preview(
  text: string,
  targetBlockId: string,
  canonicalText = text,
): VirtualBranchNavigatorPreview {
  return {
    document: {
      canonicalText,
      resolvedText: text,
      projectedText: text,
      embedRanges: [],
      workIdPrefix: null,
    },
    target: { blockId: targetBlockId, title: text },
  };
}

function row(
  id: string,
  options: Partial<VirtualBranchOccurrenceRow> = {},
): VirtualBranchOccurrenceRow {
  const item = visibleBlock(id, `Item ${id}`);
  return {
    kind: "occurrence",
    rowId: `view:${id}`,
    canonicalId: id,
    block: item,
    depth: 1,
    hasChildren: false,
    multilineExpanded: false,
    viewId: "view",
    matchRootCanonicalId: id,
    parentRowId: "view",
    relativeDepth: 0,
    collapsed: false,
    ...options,
  };
}

function branchState(overrides: Partial<VirtualBranchState> = {}): VirtualBranchState {
  return {
    config: {
      viewId: "view",
      query: "type=roadmap-item",
      filters: [],
      sort: null,
      limit: 100,
      create: null,
      createParentId: null,
      readOnly: true,
    },
    configurationErrors: [],
    creationErrors: [],
    queryError: null,
    count: 3,
    descendantCount: 0,
    completeness: { kind: "complete" },
    truncation: { rootQuery: false, depth: false, budget: false },
    queried: true,
    ...overrides,
  };
}

interface Harness {
  controller: VirtualBranchNavigatorController;
  calls: {
    collapsed: string[][];
    previews: string[];
    replaced: string[];
    removed: string[];
    firstUnlocked: string[];
    openedNew: Array<{ blockId: string; direction: "right" | "down" }>;
    revealed: string[];
    closes: number;
    invalidations: number;
  };
  setProjection(value: VirtualBranchNavigatorProjection): void;
}

function harness(
  rows: readonly VirtualBranchOccurrenceRow[] = [row("one"), row("two"), row("three")],
  loadPreview?: VirtualBranchNavigatorEffects["loadPreview"],
  loadProjection?: VirtualBranchNavigatorEffects["loadProjection"],
  removable = false,
): Harness {
  let projection: VirtualBranchNavigatorProjection = {
    title: "Next",
    rows,
    state: branchState({ count: rows.length }),
  };
  const calls: Harness["calls"] = {
    collapsed: [],
    previews: [],
    replaced: [],
    firstUnlocked: [],
    removed: [],
    openedNew: [],
    revealed: [],
    closes: 0,
    invalidations: 0,
  };
  const effects: VirtualBranchNavigatorEffects = {
    async loadProjection(collapsed) {
      calls.collapsed.push([...collapsed]);
      if (loadProjection) return loadProjection(collapsed);
      return projection;
    },
    async loadPreview(item) {
      calls.previews.push(item.canonicalId);
      if (loadPreview) return loadPreview(item);
      return preview(`Preview ${item.canonicalId}`, item.canonicalId);
    },
    async replaceTarget(blockId) {
      calls.replaced.push(blockId);
    },
    async openInFirstUnlocked(blockId) {
      calls.firstUnlocked.push(blockId);
      return true;
    },
    async openInNewDetail(blockId, direction) {
      calls.openedNew.push({ blockId, direction });
    },
    async revealSource(blockId) {
      calls.revealed.push(blockId);
    },
    ...(removable
      ? {
        async removeSelectedRecord(item: VirtualBranchOccurrenceRow) {
          calls.removed.push(item.canonicalId);
          projection = {
            ...projection,
            rows: projection.rows.filter((candidate) => candidate.rowId !== item.rowId),
          };
        },
      }
      : {}),
    close() {
      calls.closes += 1;
    },
    invalidate() {
      calls.invalidations += 1;
    },
  };
  return {
    controller: new VirtualBranchNavigatorController("tree", effects),
    calls,
    setProjection(value) {
      projection = value;
    },
  };
}

function key(name: string, overrides: Partial<TerminalKey> = {}): TerminalKey {
  return { name, ...overrides };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("virtual branch navigator", () => {
  test("shows projected hierarchy and only the selected row preview", async () => {
    const child = row("child", {
      rowId: "view:one/child",
      parentRowId: "view:one",
      matchRootCanonicalId: "one",
      relativeDepth: 1,
      depth: 2,
    });
    const state = harness([row("one", { hasChildren: true }), child, row("two")]);

    await state.controller.initialize();
    await settle();

    expect(state.controller.visibleRows.map((item) => item.rowId)).toEqual([
      "view:one",
      "view:one/child",
      "view:two",
    ]);
    expect(state.calls.previews).toEqual(["one"]);
    expect(state.controller.preview?.resolvedText).toBe("Preview one");
  });

  test("ignores stale preview completions after rapid movement", async () => {
    const pending = new Map<string, Deferred<VirtualBranchNavigatorPreview>>();
    const state = harness(undefined, (item) => {
      const result = deferred<VirtualBranchNavigatorPreview>();
      pending.set(item.canonicalId, result);
      return result.promise;
    });

    await state.controller.initialize();
    await state.controller.handleKeypress("", key("down"), "pass", 20, false);
    pending.get("two")!.resolve(preview("Current preview", "two"));
    await settle();
    pending.get("one")!.resolve(preview("Stale preview", "one"));
    await settle();

    expect(state.controller.selectedRow?.canonicalId).toBe("two");
    expect(state.controller.preview?.resolvedText).toBe("Current preview");
  });

  test("invalidates an old preview as soon as projection refresh begins", async () => {
    const oldPreview = deferred<VirtualBranchNavigatorPreview>();
    const refreshedProjection = deferred<VirtualBranchNavigatorProjection>();
    let projectionLoads = 0;
    let previewLoads = 0;
    const initialProjection: VirtualBranchNavigatorProjection = {
      title: "Next",
      rows: [row("one")],
      state: branchState({ count: 1 }),
    };
    const state = harness(
      initialProjection.rows,
      async () => {
        previewLoads += 1;
        return previewLoads === 1 ? oldPreview.promise : preview("Fresh preview", "one");
      },
      async () => {
        projectionLoads += 1;
        return projectionLoads === 1 ? initialProjection : refreshedProjection.promise;
      },
    );
    await state.controller.initialize();

    const refresh = state.controller.refresh();
    oldPreview.resolve(preview("Outdated preview", "one"));
    await settle();
    expect(state.controller.preview).toBeNull();

    refreshedProjection.resolve(initialProjection);
    await refresh;
    await settle();
    expect(state.controller.preview?.resolvedText).toBe("Fresh preview");
  });

  test("refresh retains the exact occurrence then chooses the deterministic neighbor", async () => {
    const state = harness();
    await state.controller.initialize();
    await state.controller.handleKeypress("", key("down"), "pass", 20, false);
    expect(state.controller.selectedRow?.canonicalId).toBe("two");

    state.setProjection({
      title: state.controller.title,
      rows: [row("zero"), row("one"), row("two"), row("three")],
      state: branchState({ count: 4 }),
    });
    await state.controller.refresh();
    expect(state.controller.selectedRow?.canonicalId).toBe("two");

    state.setProjection({
      title: state.controller.title,
      rows: [row("zero"), row("one"), row("three")],
      state: branchState(),
    });
    await state.controller.refresh();
    expect(state.controller.selectedRow?.canonicalId).toBe("three");
  });

  test("filters live, restores an escaped draft, and exposes empty results", async () => {

    const state = harness();
    await state.controller.initialize();
    await state.controller.handleKeypress("/", key("/"), "pass", 20, false);
    await state.controller.handleKeypress("t", key("t"), "pass", 20, false);
    await state.controller.handleKeypress("w", key("w"), "pass", 20, false);
    expect(state.controller.visibleRows.map((item) => item.canonicalId)).toEqual(["two"]);

    await state.controller.handleKeypress("", key("escape"), "pass", 20, false);
    expect(state.controller.visibleRows).toHaveLength(3);

    await state.controller.handleKeypress("/", key("/"), "pass", 20, false);
    for (const character of "missing") {
      await state.controller.handleKeypress(character, key(character), "pass", 20, false);
    }
    await state.controller.handleKeypress("", key("return"), "pass", 20, false);
    expect(state.controller.notice()).toBe("No rows match “missing”");
  });
  test("routes adapted targets and removes records with deterministic adjacent selection", async () => {
    const state = harness(
      [row("record-one"), row("record-two"), row("record-three")],
      async (item) => preview(
        `Target ${item.canonicalId}`,
        `target-${item.canonicalId}`,
      ),
      undefined,
      true,
    );
    await state.controller.initialize();
    await settle();
    await state.controller.handleKeypress("", key("down"), "pass", 20, false);
    await settle();

    await state.controller.handleKeypress("R", key("r", { shift: true }), "pass", 20, false);
    expect(state.calls.revealed).toEqual(["target-record-two"]);
  });

  test("removes the selected bookmark record and chooses the next surviving row", async () => {
    const state = harness(
      [row("one"), row("two"), row("three")],
      undefined,
      undefined,
      true,
    );
    await state.controller.initialize();
    await settle();
    await state.controller.handleKeypress("", key("down"), "pass", 20, false);
    await settle();

    await state.controller.handleKeypress("", key("m", { meta: true }), "pass", 20, false);
    await settle();

    expect(state.calls.removed).toEqual(["two"]);
    expect(state.controller.visibleRows.map((item) => item.canonicalId)).toEqual(["one", "three"]);
    expect(state.controller.selectedRow?.canonicalId).toBe("three");
    expect(state.controller.status).toBe("Bookmark removed");
  });

  test("keeps unavailable bookmark targets inert but removable", async () => {
    const state = harness(
      [row("missing-record")],
      async () => ({
        document: preview("Unavailable bookmark", "unavailable").document,
        target: null,
        unavailableReason: "Bookmark target is missing",
      }),
      undefined,
      true,
    );
    await state.controller.initialize();
    await settle();

    await state.controller.handleKeypress("", key("return"), "pass", 20, false);
    expect(state.controller.destinationChooserState.active).toBe(false);
    expect(state.controller.status).toBe("Bookmark target is missing");

    await state.controller.handleKeypress("", key("m", { meta: true }), "pass", 20, false);
    expect(state.calls.removed).toEqual(["missing-record"]);
  });

  test("uses the shared destination chooser and closes only after a successful open", async () => {
    const state = harness();
    await state.controller.initialize();
    await state.controller.handleKeypress("", key("return"), "pass", 20, false);
    expect(state.controller.destinationChooserState.active).toBe(true);

    await state.controller.handleKeypress("f", key("f"), "pass", 20, false);
    expect(state.calls.firstUnlocked).toEqual(["one"]);
    expect(state.calls.closes).toBe(1);
  });

  test("Reveal dispatches the selected canonical source and closes", async () => {
    const state = harness();
    await state.controller.initialize();
    await state.controller.handleKeypress("", key("down"), "pass", 20, false);
    await state.controller.handleKeypress("R", key("r", { shift: true }), "pass", 20, false);

    expect(state.calls.revealed).toEqual(["two"]);
    expect(state.calls.closes).toBe(1);
  });

  test("cancel leaves all destination and reveal effects untouched", async () => {
    const state = harness();
    await state.controller.initialize();
    await state.controller.handleKeypress("q", key("q"), "pass", 20, false);

    expect(state.calls.closes).toBe(1);
    expect(state.calls.replaced).toEqual([]);
    expect(state.calls.firstUnlocked).toEqual([]);
    expect(state.calls.openedNew).toEqual([]);
    expect(state.calls.revealed).toEqual([]);
  });

  test("reports empty, configuration, query, and truncation states", async () => {
    const state = harness([]);
    await state.controller.initialize();
    expect(state.controller.notice()).toBe("No projected rows");

    state.setProjection({
      title: state.controller.title,
      rows: [],
      state: branchState({ configurationErrors: ["missing query"], config: null }),
    });
    await state.controller.refresh();
    expect(state.controller.notice()).toContain("CONFIG ERROR: missing query");

    state.setProjection({
      title: state.controller.title,
      rows: [],
      state: branchState({ queryError: "socket closed" }),
    });
    await state.controller.refresh();
    expect(state.controller.notice()).toBe("QUERY ERROR: socket closed");

    state.setProjection({
      title: state.controller.title,
      rows: [row("one")],
      state: branchState({ truncation: { rootQuery: true, depth: true, budget: true } }),
    });
    await state.controller.refresh();
    expect(state.controller.notice()).toContain("ROOT TRUNCATED · DEPTH TRUNCATED · BUDGET TRUNCATED");
  });

  test("renders a wide split and a usable narrow list/preview toggle", async () => {
    const state = harness();
    await state.controller.initialize();
    await settle();

    const wide = renderVirtualBranchNavigatorFrame(state.controller, 100, 12, plainMarkdownTheme);
    expect(wide.narrow).toBe(false);
    expect(wide.frame).toContain("│");
    expect(wide.frame).toContain("Preview one");

    let narrow = renderVirtualBranchNavigatorFrame(state.controller, 60, 12, plainMarkdownTheme);
    expect(narrow.narrow).toBe(true);
    expect(narrow.frame).toContain("Item one");
    await state.controller.handleKeypress("", key("tab"), "pass", 12, true);
    narrow = renderVirtualBranchNavigatorFrame(state.controller, 60, 12, plainMarkdownTheme);
    expect(narrow.frame).toContain("Preview one");
  });

  test("uses Detail read rendering for block metadata and callouts", async () => {
    const content = [
      "Rendered title",
      "[type::roadmap-item]",
      "",
      "> [!note]+ Shared preview",
      "> Rendered callout body",
    ].join("\n");
    const state = harness([row("one")], async () => preview(content, "one", content));
    await state.controller.initialize();
    await settle();

    const rendered = renderVirtualBranchNavigatorFrame(
      state.controller,
      100,
      16,
      plainMarkdownTheme,
    );
    expect(rendered.frame).toContain("Rendered title");
    expect(rendered.frame).toContain("Shared preview");
    expect(rendered.frame).toContain("Rendered callout body");
    expect(rendered.frame).not.toContain("[type::roadmap-item]");
  });

  test("strips authored terminal controls from definition and occurrence titles", async () => {
    const dangerousRow = row("danger", {
      block: {
        ...visibleBlock("danger", "Unsafe \u001b[31mred\u001b[0m \u001b]52;c;payload\u0007"),
        displayText: "Unsafe \u001b[31mred\u001b[0m \u001b]52;c;payload\u0007",
      },
    });
    const state = harness([dangerousRow]);
    state.setProjection({
      title: "Next \u001b]52;c;header\u0007",
      rows: [dangerousRow],
      state: branchState({ count: 1 }),
    });
    await state.controller.initialize();
    await settle();

    const rendered = renderVirtualBranchNavigatorFrame(
      state.controller,
      100,
      12,
      plainMarkdownTheme,
    );
    expect(rendered.frame).not.toContain("\u001b[31m");
    expect(rendered.frame).not.toContain("\u001b]52;c;payload\u0007");
    expect(rendered.frame).not.toContain("\u001b]52;c;header\u0007");
  });

  test("mouse selection, activation, disclosure, and scrolling use projected rows", async () => {
    const parent = row("one", { hasChildren: true });
    const child = row("child", {
      rowId: "view:one/child",
      parentRowId: parent.rowId,
      matchRootCanonicalId: "one",
      relativeDepth: 1,
      depth: 2,
    });
    const state = harness([parent, child, row("two")]);
    await state.controller.initialize();
    const rendered: VirtualBranchNavigatorRenderResult = renderVirtualBranchNavigatorFrame(
      state.controller,
      100,
      12,
      plainMarkdownTheme,
    );
    const childScreenRow = rendered.mouseTargets.findIndex((target) => target?.rowId === child.rowId);
    await state.controller.handleMouse(`\x1b[<0;4;${childScreenRow + 1}M`, rendered);
    expect(state.controller.selectedRow?.canonicalId).toBe("child");
    await settle();

    await state.controller.handleMouse(`\x1b[<16;4;${childScreenRow + 1}M`, rendered);
    expect(state.controller.destinationChooserState.active).toBe(true);
    await state.controller.handleKeypress("", key("escape"), "pass", 20, false);

    await state.controller.handleMouse("\x1b[<64;2;5M", rendered);
    expect(state.controller.selectedRow?.canonicalId).toBe("one");

    const parentScreenRow = rendered.mouseTargets.findIndex((target) => target?.rowId === parent.rowId);
    const disclosureColumn = rendered.mouseTargets[parentScreenRow]!.disclosureColumn;
    await state.controller.handleMouse(
      `\x1b[<0;${disclosureColumn + 1};${parentScreenRow + 1}M`,
      rendered,
    );
    expect(state.calls.collapsed.at(-1)).toEqual([parent.rowId]);
  });
});
