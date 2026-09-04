import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "bun:test";
import type { DetailState } from "../src/detail-controller";
import {
  createPiDetailInputListener,
  decodePiDetailInput,
  PiDetailInputStreamDecoder,
  detailChooserOwnsPiInput,
  piDetailChooserInput,
  piDetailLinkClick,
} from "../src/detail-pi-input";
import {
  DETAIL_DRAFT_SPLIT_MIN_WIDTH,
  DetailPiComponent,
  DetailPiDraftSplitLayout,
  detailDraftSplitWidths,
} from "../src/detail-pi-renderer";
import { createOpenDestinationChooserState } from "../src/open-destination-chooser";
import { TextBuffer } from "../src/text-buffer";
import { osc52ClipboardWrite } from "../src/terminal";
import type { Block } from "../src/types";

function block(text: string): Block {
  return {
    id: "block-1",
    parentId: null,
    position: 0,
    text,
    author: "user",
    createdAt: "created",
    updatedAt: "updated",
    properties: [],
  };
}

function state(overrides: Partial<DetailState> = {}): DetailState {
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
    mode: "preview",
    buffer: new TextBuffer(),
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
    ...overrides,
  };
}

describe("Pi TUI Detail input", () => {
  test("preserves plain, Ctrl, and Meta click routing across the Pi input boundary", () => {
    expect(piDetailLinkClick("\x1b[<0;4;3M")).toEqual({
      activate: false,
      routing: "first-unlocked",
      suppress: false,
    });
    expect(piDetailLinkClick("\x1b[<16;4;3M")).toEqual({
      activate: true,
      routing: "chooser",
      suppress: false,
    });
    expect(piDetailLinkClick("\x1b[<8;4;3M")).toEqual({
      activate: true,
      routing: "chooser",
      suppress: false,
    });
  });

  test("decodes paste, control, navigation, modified Enter, and printable input", () => {
    expect(decodePiDetailInput("\x1b[200~first\nsecond\x1b[201~")).toEqual({
      kind: "paste",
      text: "first\nsecond",
    });
    expect(decodePiDetailInput("\x13")).toMatchObject({
      kind: "key",
      key: { name: "s", ctrl: true },
    });
    expect(decodePiDetailInput("\x1a")).toMatchObject({
      kind: "key",
      key: { name: "z", ctrl: true },
    });
    expect(decodePiDetailInput("\x19")).toMatchObject({
      kind: "key",
      key: { name: "y", ctrl: true },
    });
    expect(decodePiDetailInput("\x1b[A")).toMatchObject({
      kind: "key",
      key: { name: "up" },
    });
    expect(decodePiDetailInput("\x1b[13;2u")).toMatchObject({
      kind: "key",
      key: { name: "return", shift: true },
      inputAction: "modified-enter",
    });
    expect(decodePiDetailInput("G")).toMatchObject({
      kind: "key",
      str: "G",
      key: { name: "G", sequence: "G" },
    });
    expect(decodePiDetailInput("\x1b[27;2;65~")).toMatchObject({
      kind: "key",
      str: "A",
      key: { name: "A", sequence: "A" },
    });
    expect(decodePiDetailInput("\x1b[1;3D")).toMatchObject({
      kind: "key",
      key: { name: "left", meta: true },
    });
    expect(decodePiDetailInput("\x1b[1;2C")).toMatchObject({
      kind: "key",
      key: { name: "right", shift: true },
    });
    expect(decodePiDetailInput("\x1b[1;6C")).toMatchObject({
      kind: "key",
      key: { name: "right", ctrl: true, shift: true },
    });
    expect(decodePiDetailInput("\x1bb")).toMatchObject({
      kind: "key",
      key: { name: "b", meta: true },
    });
    expect(decodePiDetailInput("\x1b[99;9u")).toMatchObject({
      kind: "key",
      key: { name: "c", meta: true },
    });
  });

  test("reassembles bracketed paste across marker and payload chunks", () => {
    const decoder = new PiDetailInputStreamDecoder();
    expect(decoder.push("\x1b[200~")).toEqual([]);
    expect(decoder.push("first\n")).toEqual([]);
    expect(decoder.push("second\x1b[20")).toEqual([]);
    expect(decoder.push("1~")).toEqual([{
      kind: "paste",
      text: "first\nsecond",
    }]);
    expect(new PiDetailInputStreamDecoder().push("\x1b")).toMatchObject([{
      kind: "key",
      key: { name: "escape" },
    }]);
  });

  test("encodes copied source text for the terminal clipboard", () => {
    const text = "pha\n界";
    expect(osc52ClipboardWrite(text)).toBe(
      `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`,
    );
  });
});

describe("Pi TUI Detail component", () => {
  test("returns fixed-height custom-frame lines without terminal-control escapes", () => {
    const detailState = state();
    const component = new DetailPiComponent({
      state: detailState,
      height: () => 8,
    });

    const lines = component.render(64);

    expect(lines).toHaveLength(8);
    expect(lines[0]).toContain("No block selected");
    expect(lines[0]).not.toContain("Detail");
    expect(lines[0]).not.toContain("Unlocked");
    expect(lines.some((line) => line.includes("\x1b[2J"))).toBe(false);
  });

  test("keeps edit mode on the custom frame and raw buffer source", () => {
    const selected = block("raw ((block-id)) source");
    const detailState = state({
      context: { selected, ancestors: [], children: [] },
      resolvedSelectedText: "resolved display source",
      mode: "edit",
      buffer: new TextBuffer(selected.text),
    });
    const component = new DetailPiComponent({
      state: detailState,
      height: () => 8,
    });

    const rendered = component.render(64).join("\n");
    expect(rendered).toContain("raw ((block-id)) source");
    expect(rendered).not.toContain("resolved display source");
  });

  test("allocates stable equal draft panes above the responsive breakpoint", () => {
    const widths: number[] = [];
    function pane(text: string) {
      return {
        render(width: number): string[] {
          widths.push(width);
          return [text.repeat(width)];
        },
        invalidate(): void {},
      };
    }
    const split = new DetailPiDraftSplitLayout(pane("E"), pane("P"));
    split.setWidth(DETAIL_DRAFT_SPLIT_MIN_WIDTH);

    const rendered = split.render(DETAIL_DRAFT_SPLIT_MIN_WIDTH);

    expect(detailDraftSplitWidths(DETAIL_DRAFT_SPLIT_MIN_WIDTH)).toEqual({
      editor: 50,
      preview: 49,
    });
    expect(widths.slice(-2)).toEqual([50, 49]);
    expect(visibleWidth(rendered[0])).toBe(DETAIL_DRAFT_SPLIT_MIN_WIDTH);
  });

  test("marks the focused split region and advertises local focus routing", () => {
    const detailState = state({
      context: { selected: block("draft"), ancestors: [], children: [] },
      mode: "edit",
      buffer: new TextBuffer("draft"),
      connectionMode: "locked",
    });
    const component = new DetailPiComponent({
      state: detailState,
      height: () => 8,
      header: () => ({ surface: "○ Edit", focused: false }),
      helpPrefix: () => "^W focus",
    });

    const rendered = component.render(50).join("\n");
    const visible = stripTerminalSequences(rendered);

    expect(visible).toContain("○ Edit · draft");
    expect(visible).toContain("🔒");
    expect(rendered).toContain("^W focus");
  });

  test("global input consumes presses, filters releases, and permits Pi overlays", () => {
    const enqueued: string[] = [];
    let overlay = false;
    const listener = createPiDetailInputListener(
      (data) => enqueued.push(data),
      (data) => overlay || !detailChooserOwnsPiInput(data),
    );

    expect(listener("x")).toEqual({ consume: true });
    expect(listener("\x1b[103;1:3u")).toEqual({ consume: true });
    expect(listener("\x1b[<0;80;8M")).toBeUndefined();
    expect(detailChooserOwnsPiInput("\x1b[<0;80;8M")).toBe(false);
    expect(detailChooserOwnsPiInput("f")).toBe(true);
    expect(piDetailChooserInput({
      kind: "key",
      str: "R",
      key: { name: "r", shift: true },
      inputAction: "suppress",
    })).toEqual({ str: "", key: { name: "input" } });
    expect(piDetailChooserInput({ kind: "paste", text: "ignored" })).toEqual({
      str: "",
      key: { name: "paste" },
    });
    overlay = true;
    expect(listener("search")).toBeUndefined();
    expect(enqueued).toEqual(["x"]);
  });
});
