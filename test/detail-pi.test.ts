import { describe, expect, test } from "bun:test";
import type { DetailState } from "../src/detail-controller";
import { decodePiDetailInput } from "../src/detail-pi-input";
import { DetailPiComponent } from "../src/detail-pi-renderer";
import { TextBuffer } from "../src/text-buffer";

function state(overrides: Partial<DetailState> = {}): DetailState {
  return {
    context: { selected: null, ancestors: [], children: [] },
    resolvedSelectedText: "",
    resolvedBreadcrumb: "",
    mode: "preview",
    buffer: new TextBuffer(),
    referencedFile: null,
    previewOffset: 0,
    editorOffset: 0,
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
  test("returns fixed-height component lines without terminal-control escapes", () => {
    const detailState = state();
    const inputs: string[] = [];
    const component = new DetailPiComponent({
      state: detailState,
      height: () => 8,
      onInput: (data) => inputs.push(data),
    });

    const lines = component.render(64);

    expect(lines).toHaveLength(8);
    expect(lines[0]).toBe("");
    expect(lines.some((line) => line.includes("\x1b[2J"))).toBe(false);
    expect(lines[1]).toContain("Detail");
    component.handleInput("q");
    expect(inputs).toEqual(["q"]);
  });
});
