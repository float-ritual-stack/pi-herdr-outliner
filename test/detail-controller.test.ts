import { describe, expect, test } from "bun:test";
import {
  createDetailController,
  type DetailEffects,
  type DetailViewport,
} from "../src/detail-controller";
import type { ReferencedFile } from "../src/files";
import type {
  Block,
  BlockSearchQuery,
  OutlinerEvent,
  SelectionContext,
  VisibleBlock,
  VisibleBlockCollection,
} from "../src/types";

const viewport: DetailViewport = { width: 60, height: 12 };

function makeBlock(overrides: Partial<Block> = {}): Block {
  return {
    id: "block-1",
    parentId: null,
    position: 0,
    text: "Raw block text",
    author: "user",
    collapsed: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "version-1",
    properties: [],
    ...overrides,
  };
}

function makeVisibleBlock(overrides: Partial<VisibleBlock> = {}): VisibleBlock {
  return {
    ...makeBlock(overrides),
    depth: 0,
    multilineExpanded: false,
    hasChildren: false,
    displayText: overrides.text ?? "Raw block text",
    ...overrides,
  };
}

function filePreview(overrides: Partial<ReferencedFile> = {}): ReferencedFile {
  return {
    absolutePath: "/workspace/src/example.ts",
    displayPath: "src/example.ts",
    sourcePath: "src/example.ts",
    lines: ["one", "two", "three", "four", "five", "six", "seven", "eight"],
    firstLine: 10,
    ...overrides,
  };
}

interface Harness {
  controller: ReturnType<typeof createDetailController>;
  calls: {
    selections: number;
    setSelections: string[];
    updates: Array<{ blockId: string; text: string; expectedUpdatedAt: string }>;
    creates: Array<{ parentId: string; text: string; author: "user" }>;
    queries: BlockSearchQuery[];
    focuses: number;
  };
  setSelection(selection: SelectionContext): void;
  setUpdate(implementation: DetailEffects["updateBlock"]): void;
  setQueryResults(results: VisibleBlockCollection[]): void;
  setFocusError(error: Error | null): void;
}

function createHarness(
  initial: Block,
  referencedFile: ReferencedFile | null = null,
  resolveReferences: DetailEffects["resolveReferences"] = async (text) => `resolved:${text}`,
): Harness {
  let selection: SelectionContext = { selected: initial, ancestors: [], children: [] };
  let update: DetailEffects["updateBlock"] = async (input) => makeBlock({
    id: input.blockId,
    text: input.text,
    updatedAt: "version-2",
    properties: initial.properties,
  });
  let queryResults: VisibleBlockCollection[] = [];
  let focusError: Error | null = null;
  const calls: Harness["calls"] = {
    selections: 0,
    setSelections: [],
    updates: [],
    creates: [],
    queries: [],
    focuses: 0,
  };
  const effects: DetailEffects = {
    async getSelection() {
      calls.selections += 1;
      return selection;
    },
    async setSelection(blockId) {
      calls.setSelections.push(blockId);
    },
    resolveReferences,
    async updateBlock(input) {
      calls.updates.push(input);
      return update(input);
    },
    async createBlock(input) {
      calls.creates.push(input);
      return makeBlock({ id: "annotation-1" });
    },
    async queryBlocks(query) {
      calls.queries.push(query);
      return queryResults.shift() ?? { blocks: [], completeness: { kind: "complete" } };
    },
    readFile() {
      if (!referencedFile) throw new Error("file unavailable");
      return referencedFile;
    },
    completeFiles(query) {
      return query === "src/"
        ? [
            { sourcePath: "src/components/", isDirectory: true },
            { sourcePath: "src/detail.ts", isDirectory: false },
          ]
        : [];
    },
    focusOutliner() {
      calls.focuses += 1;
      if (focusError) throw focusError;
    },
  };
  return {
    controller: createDetailController(effects),
    calls,
    setSelection(next) {
      selection = next;
    },
    setUpdate(implementation) {
      update = implementation;
    },
    setQueryResults(next) {
      queryResults = [...next];
    },
    setFocusError(error) {
      focusError = error;
    },
  };
}

function event(domain: OutlinerEvent["domain"], command?: OutlinerEvent["command"]): OutlinerEvent {
  return { id: "event-1", domain, action: "changed", sequence: 1, command };
}

describe("detail controller projection and deferred refresh", () => {
  test("chooses annotation before file and preserves raw text for editing", async () => {
    const block = makeBlock({
      text: "Raw ((reference))",
      properties: [
        { key: "file", value: "src/example.ts" },
        { key: "type", value: "annotation" },
      ],
    });
    const harness = createHarness(block, filePreview());

    await harness.controller.initialize();
    expect(harness.controller.state.mode).toBe("annotation");
    expect(harness.controller.state.resolvedSelectedText).toBe("resolved:Raw ((reference))");

    await harness.controller.dispatch({ type: "edit.begin" }, viewport);
    expect(harness.controller.state.buffer.text).toBe("Raw ((reference))");
    expect(harness.controller.state.mode).toBe("edit");
  });

  test("defaults ordinary file blocks to file mode and other blocks to preview", async () => {
    const fileHarness = createHarness(
      makeBlock({ properties: [{ key: "file", value: "src/example.ts" }] }),
      filePreview(),
    );
    const previewHarness = createHarness(makeBlock());

    await fileHarness.controller.initialize();
    await previewHarness.controller.initialize();

    expect(fileHarness.controller.state.mode).toBe("file");
    expect(previewHarness.controller.state.mode).toBe("preview");
  });

  test("navigates every line introduced by resolved references", async () => {
    const resolvedLines = ["Reference", "expanded line one", "expanded line two", "expanded line three"];
    const harness = createHarness(
      makeBlock({ text: "((reference))" }),
      null,
      async () => resolvedLines.join("\n"),
    );
    await harness.controller.initialize();

    expect(harness.controller.state.context.selected?.text.split(/\r?\n/)).toHaveLength(1);
    for (let line = 1; line < resolvedLines.length; line += 1) {
      await harness.controller.dispatch({ type: "preview.navigate", direction: "down" }, viewport);
      expect(harness.controller.state.previewOffset).toBe(line);
    }
  });

  test("defers content and detail UI commands while editing, then refreshes after cancel", async () => {
    const harness = createHarness(makeBlock());
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "edit.begin" }, viewport);
    await harness.controller.dispatch({ type: "buffer.insert", text: "!" }, viewport);
    const protectedText = harness.controller.state.buffer.text;
    const selectionLoads = harness.calls.selections;

    await harness.controller.onServiceEvent(event("content"), viewport);
    await harness.controller.onServiceEvent(
      event("ui", { target: "detail", command: "edit", blockId: "other-block" }),
      viewport,
    );

    expect(harness.controller.state.refreshPending).toBe(true);
    expect(harness.controller.state.buffer.text).toBe(protectedText);
    expect(harness.calls.selections).toBe(selectionLoads);
    expect(harness.calls.setSelections).toEqual([]);

    await harness.controller.dispatch({ type: "buffer.cancel" }, viewport);
    expect(harness.controller.state.mode).toBe("preview");
    await harness.controller.refreshPendingSelection();
    expect(harness.calls.selections).toBe(selectionLoads + 1);
    expect(harness.controller.state.refreshPending).toBe(false);
  });

  test("connect marks a comment buffer pending without replacing it", async () => {
    const block = makeBlock({ properties: [{ key: "file", value: "src/example.ts" }] });
    const harness = createHarness(block, filePreview());
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "comment.begin" }, viewport);
    await harness.controller.dispatch({ type: "buffer.insert", text: "keep me" }, viewport);
    const loads = harness.calls.selections;

    await harness.controller.onServiceConnect(viewport);

    expect(harness.controller.state.mode).toBe("comment");
    expect(harness.controller.state.buffer.text).toBe("keep me");
    expect(harness.controller.state.refreshPending).toBe(true);
    expect(harness.calls.selections).toBe(loads);
  });
});

describe("detail controller saves and annotations", () => {
  test("sends the raw buffer with the selected optimistic version", async () => {
    const harness = createHarness(makeBlock({ text: "raw", updatedAt: "original-version" }));
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "edit.begin" }, viewport);
    await harness.controller.dispatch({ type: "buffer.insert", text: " changed" }, viewport);
    await harness.controller.dispatch({ type: "buffer.save" }, viewport);

    expect(harness.calls.updates).toEqual([
      { blockId: "block-1", text: "raw changed", expectedUpdatedAt: "original-version" },
    ]);
    expect(harness.controller.state.context.selected?.updatedAt).toBe("version-2");
    expect(harness.controller.state.resolvedSelectedText).toBe("resolved:raw changed");
    expect(harness.controller.state.mode).toBe("preview");
  });

  test("consumes a pending refresh after a successful optimistic save", async () => {
    const harness = createHarness(makeBlock({ text: "draft" }));
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "edit.begin" }, viewport);
    await harness.controller.dispatch({ type: "buffer.insert", text: "!" }, viewport);
    harness.setSelection({
      selected: makeBlock({ text: "draft!", updatedAt: "version-2" }),
      ancestors: [],
      children: [],
    });
    await harness.controller.onServiceEvent(event("content"), viewport);

    await harness.controller.dispatch({ type: "buffer.save" }, viewport);

    expect(harness.controller.state.refreshPending).toBe(false);
    expect(harness.controller.state.context.selected?.updatedAt).toBe("version-2");
    expect(harness.calls.selections).toBe(2);
  });

  test("keeps the editable buffer and pending refresh on an optimistic conflict", async () => {
    const harness = createHarness(makeBlock({ text: "draft" }));
    harness.setUpdate(async () => {
      throw new Error("Block changed since it was loaded");
    });
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "edit.begin" }, viewport);
    await harness.controller.onServiceEvent(event("content"), viewport);
    await harness.controller.dispatch({ type: "buffer.insert", text: "!" }, viewport);
    await harness.controller.dispatch({ type: "buffer.save" }, viewport);

    expect(harness.controller.state.mode).toBe("edit");
    expect(harness.controller.state.buffer.text).toBe("draft!");
    expect(harness.controller.state.refreshPending).toBe(true);
    expect(harness.controller.state.status).toBe("Block changed since it was loaded");
  });

  test("serializes a normalized reversed file range into a child annotation", async () => {
    const block = makeBlock({ properties: [{ key: "file", value: "src/example.ts" }] });
    const harness = createHarness(block, filePreview());
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "file.navigate", direction: "end" }, viewport);
    await harness.controller.dispatch({ type: "file.selection.toggle" }, viewport);
    await harness.controller.dispatch({ type: "file.navigate", direction: "home" }, viewport);
    await harness.controller.dispatch({ type: "comment.begin" }, viewport);
    await harness.controller.dispatch({ type: "buffer.insert", text: "  Explain this range.  " }, viewport);
    await harness.controller.dispatch({ type: "buffer.save" }, viewport);

    expect(harness.calls.creates).toHaveLength(1);
    expect(harness.calls.creates[0].parentId).toBe("block-1");
    expect(harness.calls.creates[0].author).toBe("user");
    expect(harness.calls.creates[0].text).toContain("[line-start::10] [line-end::17]");
    expect(harness.calls.creates[0].text).toContain("[source-block::block-1]");
    expect(harness.calls.creates[0].text).toContain("Explain this range.");
    expect(harness.controller.state.mode).toBe("file");
    expect(harness.controller.state.selectionAnchor).toBeNull();
    expect(harness.controller.state.status).toBe("Annotation added for lines 10-17");
  });

  test("rejects an empty annotation without leaving comment mode", async () => {
    const block = makeBlock({ properties: [{ key: "file", value: "src/example.ts" }] });
    const harness = createHarness(block, filePreview());
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "comment.begin" }, viewport);
    await harness.controller.dispatch({ type: "buffer.save" }, viewport);

    expect(harness.calls.creates).toEqual([]);
    expect(harness.controller.state.mode).toBe("comment");
    expect(harness.controller.state.status).toBe("Annotation comment cannot be empty");
  });
});

describe("detail controller wrapped editor scrolling", () => {
  test("tracks the cursor by wrapped visual rows across movement and resize", async () => {
    const text = Array.from({ length: 18 }, (_, index) => `item-${index + 1}`).join(" ");
    const harness = createHarness(makeBlock({ text }));
    const narrowViewport = { width: 20, height: 8 };
    await harness.controller.initialize();

    await harness.controller.dispatch({ type: "edit.begin" }, narrowViewport);
    const endOffset = harness.controller.state.editorVisualOffset;
    expect(endOffset).toBeGreaterThan(0);

    await harness.controller.dispatch(
      { type: "buffer.move", direction: "home" },
      narrowViewport,
    );
    expect(harness.controller.state.editorVisualOffset).toBe(0);

    await harness.controller.dispatch(
      { type: "buffer.move", direction: "end" },
      narrowViewport,
    );
    expect(harness.controller.state.editorVisualOffset).toBe(endOffset);

    await harness.controller.dispatch(
      { type: "viewport.changed" },
      { width: 14, height: 8 },
    );
    expect(harness.controller.state.editorVisualOffset).toBeGreaterThan(endOffset);
    expect(harness.controller.state.buffer.text).toBe(text);
  });
});

describe("detail controller completion, navigation, and focus", () => {
  test("queries pages first, uses a truncated fallback collection, and applies a candidate", async () => {
    const harness = createHarness(makeBlock({ text: "See [[rel" }));
    harness.setQueryResults([
      { blocks: [], completeness: { kind: "complete" } },
      {
        blocks: [makeVisibleBlock({ id: "release-id", text: "Release Notes [type::page]" })],
        completeness: { kind: "truncated", limit: 20 },
      },
    ]);
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "edit.begin" }, viewport);
    await harness.controller.dispatch({ type: "completion.open" }, viewport);

    expect(harness.calls.queries).toEqual([
      { text: "rel", filters: [{ key: "type", value: "page" }], limit: 20 },
      { text: "rel", limit: 20 },
    ]);
    expect(harness.controller.state.status).toBe("Showing first 20 matches");
    await harness.controller.dispatch({ type: "completion.accept" }, viewport);
    expect(harness.controller.state.buffer.text).toBe("See [[Release Notes]]");
    expect(harness.controller.state.completion).toBeNull();
    expect(harness.controller.state.status).toBe("");
  });

  test("completes directories without closing and files with a closing bracket", async () => {
    const harness = createHarness(makeBlock({ text: "[file::src/" }));
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "edit.begin" }, viewport);
    await harness.controller.dispatch({ type: "completion.open" }, viewport);
    expect(harness.controller.state.completion?.items.map((item) => item.insertion)).toEqual([
      "[file::src/components/",
      "[file::src/detail.ts]",
    ]);
  });

  test("keeps the file cursor visible when the viewport shrinks", async () => {
    const block = makeBlock({ properties: [{ key: "file", value: "src/example.ts" }] });
    const harness = createHarness(block, filePreview());
    const shortViewport = { width: 40, height: 9 };
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "file.navigate", direction: "pagedown" }, shortViewport);
    await harness.controller.dispatch({ type: "file.selection.toggle" }, shortViewport);
    await harness.controller.dispatch({ type: "file.navigate", direction: "end" }, shortViewport);

    expect(harness.controller.state.fileCursor).toBe(7);
    expect(harness.controller.state.fileOffset).toBe(5);
    expect(harness.controller.state.selectionAnchor).toBe(3);

    await harness.controller.dispatch({ type: "viewport.changed" }, { width: 40, height: 6 });
    expect(harness.controller.state.fileOffset).toBe(7);
  });

  test("opens the raw block preview from file mode", async () => {
    const block = makeBlock({ properties: [{ key: "file", value: "src/example.ts" }] });
    const harness = createHarness(block, filePreview());
    await harness.controller.initialize();

    await harness.controller.dispatch({ type: "view.block" }, viewport);

    expect(harness.controller.state.mode).toBe("preview");
    expect(harness.controller.state.previewOffset).toBe(0);
  });

  test("preserves the established focus-status precedence", async () => {
    const harness = createHarness(makeBlock());
    harness.setFocusError(new Error("pane missing"));
    await harness.controller.initialize();

    await harness.controller.dispatch({ type: "focus.outliner" }, viewport);
    expect(harness.controller.state.status).toBe("pane missing");
    await harness.controller.dispatch({ type: "focus.outliner", announce: true }, viewport);
    expect(harness.controller.state.status).toBe("Focus returned to outliner; Ctrl+Q closes detail");
    expect(harness.calls.focuses).toBe(2);
  });

  test("targets a detail UI command without invoking pane focus", async () => {
    const first = makeBlock();
    const second = makeBlock({ id: "block-2", text: "second", updatedAt: "version-2" });
    const harness = createHarness(first);
    await harness.controller.initialize();
    harness.setSelection({ selected: second, ancestors: [], children: [] });

    await harness.controller.onServiceEvent(
      event("ui", { target: "detail", command: "reveal", blockId: "block-2" }),
      viewport,
    );

    expect(harness.calls.setSelections).toEqual(["block-2"]);
    expect(harness.controller.state.context.selected?.id).toBe("block-2");
    expect(harness.calls.focuses).toBe(0);
  });
});
