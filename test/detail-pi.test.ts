import { describe, expect, test } from "bun:test";
import type { DetailState } from "../src/detail-controller";
import { createPiDetailInputListener, decodePiDetailInput } from "../src/detail-pi-input";
import { DetailPiComponent } from "../src/detail-pi-renderer";
import { TextBuffer } from "../src/text-buffer";
import type { Block } from "../src/types";

function block(text: string): Block {
  return {
    id: "block-1",
    parentId: null,
    position: 0,
    text,
    author: "user",
    collapsed: false,
    createdAt: "created",
    updatedAt: "updated",
    properties: [],
  };
}

function state(overrides: Partial<DetailState> = {}): DetailState {
  return {
    context: { selected: null, ancestors: [], children: [] },
    resolvedSelectedText: "",
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
    ...overrides,
  };
}

describe("Pi TUI Detail input", () => {
  test("decodes paste, control, navigation, modified Enter, and printable input", () => {
    expect(decodePiDetailInput("\x1b[200~first\nsecond\x1b[201~")).toEqual({
      kind: "paste",
      text: "first\nsecond",
    });
    expect(decodePiDetailInput("\x13")).toMatchObject({
      kind: "key",
      key: { name: "s", ctrl: true },
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
    expect(lines[0]).toBe("");
    expect(lines.some((line) => line.includes("\x1b[2J"))).toBe(false);
    expect(lines[1]).toContain("Detail");
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

  test("global input consumes presses, filters releases, and permits Pi overlays", () => {
    const enqueued: string[] = [];
    let overlay = false;
    const listener = createPiDetailInputListener(
      (data) => enqueued.push(data),
      () => overlay,
    );

    expect(listener("x")).toEqual({ consume: true });
    expect(listener("\x1b[103;1:3u")).toEqual({ consume: true });
    overlay = true;
    expect(listener("search")).toBeUndefined();
    expect(enqueued).toEqual(["x"]);
  });
});
