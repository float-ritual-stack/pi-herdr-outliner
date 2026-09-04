import { describe, expect, test } from "bun:test";
import {
  detailEditorPositionAtVisualPoint,
  layoutDetailEditor,
} from "../src/detail-editor-layout";
import {
  detailEditorPointAtClick,
  detailMouseRegionAt,
} from "../src/detail-mouse";
import {
  parseTreePlainClick,
  parseTreePrimaryPointer,
  parseTreeWheelEvent,
} from "../src/tree-mouse";

describe("Detail mouse input", () => {
  test("decodes SGR click and wheel coordinates", () => {
    expect(parseTreePlainClick("\x1b[<0;7;5M")).toEqual({ column: 6, row: 4 });
    expect(parseTreeWheelEvent("\x1b[<64;51;8M")).toEqual({
      direction: "up",
      column: 50,
      row: 7,
    });
    expect(parseTreeWheelEvent("\x1b[<65;4;9M")).toEqual({
      direction: "down",
      column: 3,
      row: 8,
    });
  });

  test("decodes primary pointer down, drag, and release phases", () => {
    expect(parseTreePrimaryPointer("\x1b[<0;7;5M")).toEqual({
      column: 6,
      row: 4,
      shift: false,
      meta: false,
      ctrl: false,
      phase: "down",
    });
    expect(parseTreePrimaryPointer("\x1b[<36;11;9M")).toEqual({
      column: 10,
      row: 8,
      shift: true,
      meta: false,
      ctrl: false,
      phase: "drag",
    });
    expect(parseTreePrimaryPointer("\x1b[<0;13;10m")).toEqual({
      column: 12,
      row: 9,
      shift: false,
      meta: false,
      ctrl: false,
      phase: "up",
    });
    expect(parseTreePlainClick("\x1b[<32;11;9M")).toBeNull();
  });

  test("routes body input by split region and excludes chrome", () => {
    const layout = { width: 100, height: 24, editorWidth: 50, split: true };
    expect(detailMouseRegionAt({ column: 10, row: 2 }, layout)).toBe("chrome");
    expect(detailMouseRegionAt({ column: 10, row: 3 }, layout)).toBe("editor");
    expect(detailMouseRegionAt({ column: 49, row: 20 }, layout)).toBe("editor");
    expect(detailMouseRegionAt({ column: 50, row: 10 }, layout)).toBe("chrome");
    expect(detailMouseRegionAt({ column: 51, row: 10 }, layout)).toBe("preview");
    expect(detailMouseRegionAt({ column: 51, row: 22 }, layout)).toBe("chrome");
  });

  test("maps editor clicks through headers, wrapping, tabs, and Unicode width", () => {
    const lines = ["alpha beta gamma", "A\t界Z"];
    const layout = layoutDetailEditor(lines, 0, 0, 12);
    const first = detailEditorPointAtClick(
      { column: layout.lineNumberWidth + 1, row: 3 },
      layout,
      0,
    );
    expect(detailEditorPositionAtVisualPoint(
      layout,
      lines,
      first.visualRow,
      first.contentColumn,
    )).toEqual({ row: 0, column: 0 });

    const continuationIndex = layout.rows.findIndex((row) => row.logicalRow === 0 && row.continuation);
    expect(continuationIndex).toBeGreaterThan(0);
    expect(detailEditorPositionAtVisualPoint(layout, lines, continuationIndex, 2).row).toBe(0);
    const lastContinuationIndex = layout.rows.map((row) => row.logicalRow).lastIndexOf(0);
    expect(detailEditorPositionAtVisualPoint(layout, lines, lastContinuationIndex, 200)).toEqual({
      row: 0,
      column: lines[0]!.length,
    });

    const unicodeRow = layout.rows.findIndex((row) => row.logicalRow === 1 && row.text.includes("界"));
    const wideStart = "A\t".length;
    expect(detailEditorPositionAtVisualPoint(layout, lines, unicodeRow, 0)).toEqual({
      row: 1,
      column: wideStart,
    });
    expect(detailEditorPositionAtVisualPoint(layout, lines, unicodeRow, 1)).toEqual({
      row: 1,
      column: wideStart + 1,
    });
  });
});
