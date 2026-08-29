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
    connectionMode: "follow",
    canNavigateBack: false,
    canNavigateForward: false,
    resolvedSelectedText: "",
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
    { type: "connection.toggle" },
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
    { type: "connection.toggle" },
  ]);
});
