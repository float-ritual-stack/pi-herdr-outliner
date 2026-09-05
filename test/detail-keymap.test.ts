import { expect, test } from "bun:test";
import { OutlinerActionKeymap, type OutlinerActionMenuItem } from "../src/outliner-actions";
import type {
  DetailController,
  DetailIntent,
  DetailState,
} from "../src/detail-controller";
import { createDetailKeyHandler } from "../src/detail-keymap";
import { createOpenDestinationChooserState } from "../src/open-destination-chooser";
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
    embedRanges: [],
    embedBackgroundEnabled: true,
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
    annotationThreads: [],
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
    propertyInspector: {
      presentation: "inline",
      model: null,
      expanded: false,
      groupBy: null,
      filter: "",
      filterDraft: null,
      viewportOffset: 0,
      edit: null,
    },
    previewRegions: {
      regions: [],
      focusedRegionId: null,
      disclosureOverrides: new Map(),
    },
    destinationChooser: createOpenDestinationChooserState(),
  };
}

function harness(
  detailState: DetailState = state(),
  bufferMode = true,
  options: {
    actionKeymap?: OutlinerActionKeymap;
    openActionMenu?: (
      items: readonly OutlinerActionMenuItem[],
      invoke: (actionId: string) => Promise<void>,
    ) => void;
    navigatePreview?: (direction: "up" | "down" | "pageup" | "pagedown" | "top" | "bottom") => void;
    previewFocused?: () => boolean;
  } = {},
): {
  intents: DetailIntent[];
  press(key: TerminalKey, str?: string, inputAction?: "pass" | "suppress"): Promise<void>;
  invoke(actionId: string): Promise<void>;
  chooserInputs: Array<{ str: string; key: TerminalKey }>;
  stops: { count: number };
} {
  const intents: DetailIntent[] = [];
  const chooserInputs: Array<{ str: string; key: TerminalKey }> = [];
  const stops = { count: 0 };
  const controller: DetailController = {
    state: detailState,
    async initialize() {},
    isBufferMode: () => bufferMode,
    async dispatch(intent) {
      intents.push(intent);
    },
    setPreviewRegions() {},
    async handleDestinationChooserKeypress(str, key) {
      chooserInputs.push({ str, key });
      return true;
    },
    destinationChooserHelpText() {
      return "";
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
    stop() {
      stops.count += 1;
    },
    ...options,
  });
  return {
    chooserInputs,
    intents,
    invoke: (actionId) => handler.invoke(actionId),
    press: (key, str = "", inputAction = "pass") => handler(str, key, inputAction),
    stops,
  };
}

test("remaps preview and editor actions while suppressing stale defaults", async () => {
  const editKeymap = new OutlinerActionKeymap("<test>", {
    "detail.buffer.save": ["x"],
  });
  const editor = harness(state(), true, { actionKeymap: editKeymap });
  await editor.press({ name: "x" }, "x");
  await editor.press({ name: "s", ctrl: true });
  expect(editor.intents).toEqual([{ type: "buffer.save" }]);

  const previewState = state();
  previewState.mode = "preview";
  const directions: string[] = [];
  const previewKeymap = new OutlinerActionKeymap("<test>", {
    "detail.edit.begin": ["x"],
    "detail.preview.down": ["j"],
  });
  const preview = harness(previewState, false, {
    actionKeymap: previewKeymap,
    navigatePreview: (direction) => directions.push(direction),
  });
  await preview.press({ name: "x" }, "x");
  await preview.press({ name: "e" }, "e");
  await preview.press({ name: "j" }, "j");
  await preview.press({ name: "down" });
  expect(preview.intents).toEqual([{ type: "edit.begin" }]);
  expect(directions).toEqual(["down"]);
});

test("routes the draft scroll link toggle through the action registry", async () => {
  const editor = harness();
  await editor.press({ name: "l", ctrl: true });
  expect(editor.intents).toEqual([{ type: "draft-preview.link.toggle" }]);
  expect(new OutlinerActionKeymap("<test>").menuItems("detail", "edit")).toContainEqual(
    expect.objectContaining({
      id: "detail.split.link",
      binding: "⌃L",
    }),
  );
});

test("routes Ctrl+C and Command+C to copy while editing", async () => {
  const detailState = state();
  detailState.buffer.placeCursor(0, 1);
  detailState.buffer.placeCursor(0, 5, true);
  const detail = harness(detailState);

  await detail.press({ name: "c", ctrl: true });
  await detail.press({ name: "c", meta: true });

  expect(detail.intents).toEqual([
    { type: "buffer.copy" },
    { type: "buffer.copy" },
  ]);
});

test("opens direction-aware Detail splits from preview bindings", async () => {
  const detailState = state();
  detailState.mode = "preview";
  detailState.context.selected = {
    id: "block-1",
    parentId: null,
    position: 0,
    text: "Block",
    author: "user",
    createdAt: "created",
    updatedAt: "updated",
    properties: [],
  };
  const detail = harness(detailState, false);

  await detail.press({ name: "right", meta: true, shift: true });
  await detail.press({ name: "down", meta: true, shift: true });

  expect(detail.intents).toEqual([
    { type: "pane.open", direction: "right" },
    { type: "pane.open", direction: "down" },
  ]);
});

test("uses q to close a dedicated Property Detail without changing ordinary q", async () => {
  const propertyState = state();
  propertyState.mode = "preview";
  propertyState.propertyInspector.presentation = "dedicated";
  const property = harness(propertyState, false);
  await property.press({ name: "q" }, "q");
  expect(property.stops.count).toBe(1);
  expect(property.intents).toEqual([]);

  const ordinaryState = state();
  ordinaryState.mode = "preview";
  const ordinary = harness(ordinaryState, false);
  await ordinary.press({ name: "q" }, "q");
  expect(ordinary.stops.count).toBe(0);
  expect(ordinary.intents).toEqual([{ type: "focus.outliner", announce: true }]);
});

test("opens the contextual menu and invokes its selected action through effective bindings", async () => {
  const detailState = state();
  detailState.mode = "preview";
  let menuItems: readonly OutlinerActionMenuItem[] = [];
  let invoke: (actionId: string) => Promise<void> = async () => {
    throw new Error("Action menu did not open");
  };
  const detail = harness(detailState, false, {
    openActionMenu: (items, nextInvoke) => {
      menuItems = items;
      invoke = nextInvoke;
    },
  });

  await detail.press({ name: "?" }, "?");
  expect(menuItems.some((item) => item.id === "detail.edit.begin")).toBe(true);
  await invoke("detail.edit.begin");
  await invoke("detail.pane.right");
  expect(detail.intents).toEqual([
    { type: "edit.begin" },
    { type: "pane.open", direction: "right" },
  ]);
});

test("invokes semantic actions directly regardless of bindings and reports invalid contexts", async () => {
  const previewState = state();
  previewState.mode = "preview";
  const detail = harness(previewState, false, {
    actionKeymap: new OutlinerActionKeymap("<test>", {
      "detail.edit.begin": [],
    }),
  });

  await detail.invoke("detail.edit.begin");
  await detail.press({ name: "e" }, "e");
  await detail.invoke("detail.buffer.save");
  await detail.invoke("detail.missing");

  expect(detail.intents).toEqual([
    { type: "edit.begin" },
    { type: "status.set", message: "save is unavailable here" },
    { type: "status.set", message: "Unknown Detail action: detail.missing" },
  ]);
});

test("resolves shared chords by ordered Detail context", async () => {
  const actionKeymap = new OutlinerActionKeymap("<test>", {
    "detail.edit.begin": ["x"],
    "detail.property.filter": ["x"],
    "detail.backlinks.filter": ["x"],
  });
  const detailState = state();
  detailState.mode = "preview";
  detailState.propertyInspector.expanded = true;
  detailState.backlinks.expanded = true;
  const detail = harness(detailState, false, { actionKeymap });

  await detail.press({ name: "x" }, "x");
  detailState.backlinks.filterDraft = null;
  detailState.previewRegions = {
    regions: [{
      id: "property:source:status:0:0-10",
      kind: "property-entry",
      sourceSpan: { start: 0, end: 10, startLine: 0, endLine: 0 },
      parentId: "property-inspector",
      childIds: [],
      focusable: true,
      disclosure: null,
      activation: {
        type: "property-inspector.target.open",
        occurrenceId: "property:source:status:0:0-10",
      },
    }],
    focusedRegionId: "property:source:status:0:0-10",
    disclosureOverrides: new Map(),
  };
  await detail.press({ name: "x" }, "x");
  detailState.propertyInspector.filterDraft = null;
  detailState.propertyInspector.expanded = false;
  detailState.backlinks.expanded = false;
  detailState.previewRegions = {
    regions: [],
    focusedRegionId: null,
    disclosureOverrides: new Map(),
  };
  await detail.press({ name: "x" }, "x");

  expect(detail.intents).toEqual([
    { type: "backlinks.filter.begin" },
    { type: "property-inspector.filter.begin" },
    { type: "edit.begin" },
  ]);
});

test("routes draft-preview commands without mutating the editor buffer", async () => {
  const directions: string[] = [];
  const detail = harness(state(), true, {
    previewFocused: () => true,
    navigatePreview: (direction) => directions.push(direction),
  });

  await detail.press({ name: "down" });
  await detail.press({ name: "x" }, "x");

  expect(directions).toEqual(["down"]);
  expect(detail.intents).toEqual([{ type: "redraw" }]);
});

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
  await detail.press({}, " ");
  await detail.press({ name: "delete" });

  expect(detail.intents).toEqual([
    { type: "buffer.save" },
    { type: "completion.open" },
    { type: "buffer.insert", text: "x" },
    { type: "buffer.insert", text: " " },
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

test("activates the focused preview region and reserves e for editing", async () => {
  const previewState = state();
  previewState.mode = "preview";
  const preview = harness(previewState, false);

  await preview.press({ name: "return" });
  await preview.press({ name: "e" }, "e");
  await preview.press({ name: "e", shift: true }, "E");

  expect(preview.intents).toEqual([
    { type: "preview.activate" },
    { type: "edit.begin" },
    { type: "embed-background.toggle" },
  ]);
});

test("maps preview b to the lazy backlink section", async () => {
  const previewState = state();
  previewState.mode = "preview";
  const preview = harness(previewState, false);

  await preview.press({ name: "b" }, "b");

  expect(preview.intents).toEqual([{ type: "backlinks.toggle" }]);
});

test("keeps Shift+R pane-level while Backlinks are expanded", async () => {
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
    { type: "preview.focus.move", delta: 1 },
    { type: "preview.focus.move", delta: -1 },
    { type: "preview.activate" },
    { type: "current.reveal" },
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

test("maps Shift+R to current-block reveal without a destination picker", async () => {
  const previewState = state();
  previewState.mode = "preview";
  const preview = harness(previewState, false);

  await preview.press({ name: "r", shift: true }, "R");
  await preview.press({ name: "l", shift: true }, "L");
  await preview.press({ name: "i" }, "i");
  await preview.press({ name: "l", ctrl: true });
  await preview.press({ name: "l", meta: true });

  expect(preview.intents).toEqual([
    { type: "current.reveal" },
    { type: "lock.toggle" },
    { type: "lock.toggle" },
    { type: "lock.toggle" },
    { type: "lock.toggle" },
  ]);
});

test("maps property inspector disclosure, pane, grouping, filtering, target, and viewport keys", async () => {
  const previewState = state();
  previewState.mode = "preview";
  previewState.propertyInspector.expanded = true;
  previewState.previewRegions = {
    regions: [{
      id: "property:source:related-to:0:10-20",
      kind: "property-entry",
      sourceSpan: { start: 10, end: 20, startLine: 1, endLine: 1 },
      parentId: "property-inspector",
      childIds: [],
      focusable: true,
      disclosure: null,
      activation: {
        type: "property-inspector.target.open",
        occurrenceId: "property:source:related-to:0:10-20",
      },
    }],
    focusedRegionId: "property:source:related-to:0:10-20",
    disclosureOverrides: new Map(),
  };
  const preview = harness(previewState, false);

  await preview.press({ name: "return" });
  await preview.press({ name: "e" }, "e");
  await preview.press({ name: "o" }, "o");
  await preview.press({ name: "p" }, "p");
  await preview.press({ name: "p", shift: true }, "P");
  await preview.press({ name: "g", shift: true }, "G");
  await preview.press({ name: "/" }, "/");
  previewState.propertyInspector.filterDraft = "";
  await preview.press({ name: "r" }, "r");
  await preview.press({ name: "backspace" });
  await preview.press({ name: "return" });
  previewState.propertyInspector.filterDraft = null;
  await preview.press({ name: "r", shift: true }, "R");

  expect(preview.intents).toEqual([
    { type: "property-inspector.edit.begin" },
    { type: "property-inspector.edit.begin" },
    {
      type: "property-inspector.target.open",
      occurrenceId: "property:source:related-to:0:10-20",
      intent: "open",
    },
    { type: "property-inspector.disclosure.toggle" },
    { type: "property-inspector.pane.open" },
    { type: "property-inspector.group.cycle" },
    { type: "property-inspector.filter.begin" },
    { type: "property-inspector.filter.input", text: "r" },
    { type: "property-inspector.filter.backspace" },
    { type: "property-inspector.filter.commit" },
    { type: "current.reveal" },
  ]);

  previewState.propertyInspector.presentation = "dedicated";
  const dedicated = harness(previewState, false);
  await dedicated.press({ name: "down" });
  await dedicated.press({ name: "pagedown" });
  await dedicated.press({ name: "g" }, "g");
  await dedicated.press({ name: "r", shift: true }, "R");
  expect(dedicated.intents).toEqual([
    { type: "property-inspector.viewport.navigate", direction: "down" },
    { type: "property-inspector.viewport.navigate", direction: "pagedown" },
    { type: "property-inspector.viewport.navigate", direction: "home" },
    { type: "current.reveal" },
  ]);
});

test("maps property value editing keys without entering the full block editor", async () => {
  const detailState = state();
  detailState.propertyInspector.edit = {
    occurrenceId: "property:block-1:status:0:8-25",
    ordinal: 0,
    blockId: "block-1",
    expectedUpdatedAt: "version-1",
    buffer: new TextBuffer("planned"),
  };
  const detail = harness(detailState, false);

  await detail.press({ name: "a", ctrl: true });
  await detail.press({ name: undefined }, "x");
  await detail.press({ name: "left" });
  await detail.press({ name: "backspace" });
  await detail.press({ name: "delete" });
  await detail.press({ name: "return" });
  await detail.press({ name: "escape" });

  expect(detail.intents).toEqual([
    { type: "property-inspector.edit.select-all" },
    { type: "property-inspector.edit.insert", text: "x" },
    { type: "property-inspector.edit.move", direction: "left" },
    { type: "property-inspector.edit.backspace" },
    { type: "property-inspector.edit.delete" },
    { type: "property-inspector.edit.commit" },
    { type: "property-inspector.edit.cancel" },
  ]);
});

test("an active destination chooser owns input before keymap actions", async () => {
  const detailState = state();
  detailState.mode = "preview";
  detailState.destinationChooser.active = true;
  const stateHarness = harness(detailState, false);

  await stateHarness.press({ name: "o" }, "o");
  await stateHarness.press({ name: "ignored" }, "", "suppress");
  await stateHarness.press({ name: "q", ctrl: true });

  expect(stateHarness.chooserInputs).toEqual([
    { str: "o", key: { name: "o" } },
    { str: "", key: { name: "input" } },
  ]);
  expect(stateHarness.stops.count).toBe(1);
  expect(stateHarness.intents).toEqual([]);
});
