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
    resolvedSelectedText: "",
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

function harness(): {
  intents: DetailIntent[];
  press(key: TerminalKey, str?: string): Promise<void>;
} {
  const intents: DetailIntent[] = [];
  const detailState = state();
  const controller: DetailController = {
    state: detailState,
    async initialize() {},
    isBufferMode: () => true,
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
  await detail.press({ name: "right", ctrl: true, shift: true });
  await detail.press({ name: "home", shift: true });
  await detail.press({ name: "a", ctrl: true });
  await detail.press({ name: "a", meta: true });

  expect(detail.intents).toEqual([
    { type: "buffer.move", direction: "word-left", extend: undefined },
    { type: "buffer.move", direction: "word-right", extend: true },
    { type: "buffer.move", direction: "home", extend: true },
    { type: "buffer.move", direction: "home", extend: undefined },
    { type: "buffer.select-all" },
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
