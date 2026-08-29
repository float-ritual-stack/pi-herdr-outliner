import { expect, test } from "bun:test";
import type {
  DetailController,
  DetailIntent,
  DetailState,
} from "../src/detail-controller";
import { createDetailKeyHandler } from "../src/detail-keymap";
import { TextBuffer } from "../src/text-buffer";
import type { TerminalKey } from "../src/terminal";

function state(): DetailState {
  return {
    context: { selected: null, ancestors: [], children: [] },
    targetBlockId: null,
    targetFragmentId: null,
    connectionMode: "unlocked",
    canNavigateBack: false,
    canNavigateForward: false,
    resolvedSelectedText: "",
    projectedSelectedText: "",
    embedStates: [],
    workIdPrefix: null,
    resolvedBreadcrumb: "",
    mode: "edit",
    buffer: new TextBuffer("alpha beta"),
    referencedFile: null,
    previewOffset: 0,
    editorVisualOffset: 0,
    fileOffset: 0,
    fileCursor: 0,
    selectionAnchor: null,
    annotationRange: null,
    completion: null,
    status: "",
    busy: false,
    refreshPending: false,
    backlinks: {
      expanded: false,
      loading: false,
      collection: null,
      selectedIndex: 0,
      error: "",
      filter: "",
      filterDraft: null,
      sortField: "updated",
      sortDirection: "desc",
      expandedSourceIds: new Set(),
    },
  };
}

function harness(
  detailState: DetailState = state(),
  bufferMode = true,
): {
  intents: DetailIntent[];
  press(key: TerminalKey, str?: string): Promise<void>;
} {
  const intents: DetailIntent[] = [];
  const controller: DetailController = {
    state: detailState,
    async initialize() {},
    isBufferMode: () => bufferMode,
    async dispatch(intent) {
      intents.push(intent);
    },
    async onServiceEvent() {},
    async onServiceConnect() {},
    onServiceDisconnect() {},
    onServiceError() {},
    async refreshPendingSelection() {},
  };
  const handler = createDetailKeyHandler({
    controller,
    viewport: () => ({ width: 80, height: 24 }),
    stop() {},
  });
  return {
    intents,
    press: (key, str = "") => handler(str, key, "pass"),
  };
}

test("maps word, line, selection, and select-all controls to explicit intents", async () => {
  const detail = harness();

  await detail.press({ name: "left", meta: true });
  await detail.press({ name: "b", meta: true });
  await detail.press({ name: "f", meta: true });
  await detail.press({ name: "right", ctrl: true, shift: true });
  await detail.press({ name: "home", shift: true });
  await detail.press({ name: "a", ctrl: true });
  await detail.press({ name: "a", meta: true });

  expect(detail.intents).toEqual([
    { type: "buffer.move", direction: "word-left", extend: undefined },
    { type: "buffer.move", direction: "word-left", extend: undefined },
    { type: "buffer.move", direction: "word-right", extend: undefined },
    { type: "buffer.move", direction: "word-right", extend: true },
    { type: "buffer.move", direction: "home", extend: true },
    { type: "buffer.move", direction: "home", extend: undefined },
    { type: "buffer.select-all" },
  ]);
});

test("maps platform undo and redo shortcuts", async () => {
  const detail = harness();

  await detail.press({ name: "z", ctrl: true });
  await detail.press({ name: "z", ctrl: true, shift: true });
  await detail.press({ name: "y", ctrl: true });
  await detail.press({ name: "z", meta: true });
  await detail.press({ name: "z", meta: true, shift: true });

  expect(detail.intents).toEqual([
    { type: "buffer.undo" },
    { type: "buffer.redo" },
    { type: "buffer.redo" },
    { type: "buffer.undo" },
    { type: "buffer.redo" },
  ]);
});

test("retains save, completion, insertion, and delete bindings", async () => {
  const detail = harness();

  await detail.press({ name: "s", ctrl: true });
  await detail.press({ name: "tab" });
  await detail.press({ name: "x" }, "x");
  await detail.press({ name: "delete" });

  expect(detail.intents).toEqual([
    { type: "buffer.save" },
    { type: "completion.open" },
    { type: "buffer.insert", text: "x" },
    { type: "buffer.delete" },
  ]);
});

test("restores direct Trash roots from file mode", async () => {
  const detailState = state();
  detailState.mode = "file";
  detailState.context.selected = {
    id: "deleted-file",
    parentId: null,
    position: 0,
    text: "Deleted file [file::example.ts]",
    author: "user",
    createdAt: "created",
    updatedAt: "updated",
    deletedAt: "deleted",
    effectiveDeletedRootId: "deleted-file",
    properties: [{ key: "file", value: "example.ts" }],
  };
  const detail = harness(detailState, false);

  await detail.press({ name: "r" }, "r");

  expect(detail.intents).toEqual([{ type: "trash.restore" }]);
});

test("maps preview and file navigation history and reference-follow bindings", async () => {
  const previewState = state();
  previewState.mode = "preview";
  const preview = harness(previewState, false);

  await preview.press({ name: "left", meta: true });
  await preview.press({ name: "right", meta: true });
  await preview.press({ name: "b", meta: true });
  await preview.press({ name: "f", meta: true });
  await preview.press({ name: "o" }, "o");
  await preview.press({ name: "i" }, "i");

  expect(preview.intents).toEqual([
    { type: "navigation.back" },
    { type: "navigation.forward" },
    { type: "navigation.back" },
    { type: "navigation.forward" },
    { type: "reference.follow" },
    { type: "lock.toggle" },
  ]);

  const fileState = state();
  fileState.mode = "file";
  fileState.referencedFile = {
    absolutePath: "/workspace/example.ts",
    displayPath: "example.ts",
    sourcePath: "example.ts",
    lines: ["example"],
    firstLine: 1,
  };
  const file = harness(fileState, false);

  await file.press({ name: "left", meta: true });
  await file.press({ name: "o" }, "o");
  await file.press({ name: "i" }, "i");

  expect(file.intents).toEqual([
    { type: "navigation.back" },
    { type: "reference.follow" },
    { type: "lock.toggle" },
  ]);
});

test("keeps reader Enter inert and reserves e for editing", async () => {
  const previewState = state();
  previewState.mode = "preview";
  const preview = harness(previewState, false);

  await preview.press({ name: "return" });
  await preview.press({ name: "e" }, "e");

  expect(preview.intents).toEqual([
    { type: "redraw" },
    { type: "edit.begin" },
  ]);
});

test("maps preview b to the lazy backlink section", async () => {
  const previewState = state();
  previewState.mode = "preview";
  const preview = harness(previewState, false);

  await preview.press({ name: "b" }, "b");

  expect(preview.intents).toEqual([{ type: "backlinks.toggle" }]);
});

test("selects, inspects, and reveals expanded backlink rows", async () => {
  const previewState = state();
  previewState.mode = "preview";
  previewState.backlinks = {
    expanded: true,
    loading: false,
    selectedIndex: 0,
    error: "",
    filter: "",
    filterDraft: null,
    sortField: "updated",
    sortDirection: "desc",
    expandedSourceIds: new Set(),
    collection: {
      targetBlockId: "target-block",
      sources: [{
        blockId: "source-block",
        title: "Source",
        parentContext: "Top level",
        occurrenceCount: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        referenceGroups: [{ kind: "block", count: 1 }],
        occurrences: [],
        occurrencesTruncated: false,
      }],
      completeness: { kind: "complete" },
    },
  };
  const preview = harness(previewState, false);

  await preview.press({ name: "tab" });
  await preview.press({ name: "tab", shift: true });
  await preview.press({ name: "return" });
  await preview.press({ name: "r", shift: true }, "R");

  expect(preview.intents).toEqual([
    { type: "backlinks.move", delta: 1 },
    { type: "backlinks.move", delta: -1 },
    { type: "backlinks.open" },
    { type: "backlinks.reveal" },
  ]);
});

test("maps backlink filter, sort, and disclosure controls", async () => {
  const previewState = state();
  previewState.mode = "preview";
  previewState.backlinks.expanded = true;
  const preview = harness(previewState, false);

  await preview.press({ name: "/" }, "/");
  previewState.backlinks.filterDraft = "";
  await preview.press({ name: "g" }, "g");
  await preview.press({ name: "backspace" });
  await preview.press({ name: "return" });
  previewState.backlinks.filterDraft = null;
  await preview.press({ name: "s" }, "s");
  await preview.press({ name: "." }, ".");

  expect(preview.intents).toEqual([
    { type: "backlinks.filter.begin" },
    { type: "backlinks.filter.input", text: "g" },
    { type: "backlinks.filter.backspace" },
    { type: "backlinks.filter.commit" },
    { type: "backlinks.sort.cycle" },
    { type: "backlinks.source.toggle" },
  ]);
});

test("maps lock shortcuts and reveal without a destination picker", async () => {
  const previewState = state();
  previewState.mode = "preview";
  const preview = harness(previewState, false);

  await preview.press({ name: "r", shift: true }, "R");
  await preview.press({ name: "l", shift: true }, "L");
  await preview.press({ name: "i" }, "i");
  await preview.press({ name: "l", ctrl: true });
  await preview.press({ name: "l", meta: true });

  expect(preview.intents).toEqual([
    { type: "reference.reveal" },
    { type: "lock.toggle" },
    { type: "lock.toggle" },
    { type: "lock.toggle" },
    { type: "lock.toggle" },
  ]);
});
