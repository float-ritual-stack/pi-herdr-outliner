import { describe, expect, test } from "bun:test";
import type { DetailState } from "../src/detail-controller";
import { renderDetailAnsi } from "../src/detail-renderer";
import { TextBuffer } from "../src/text-buffer";
import type { Block } from "../src/types";

function block(text: string, properties: Block["properties"] = []): Block {
  return {
    id: "block-1",
    parentId: null,
    position: 0,
    text,
    author: "user",
    collapsed: false,
    createdAt: "created",
    updatedAt: "updated",
    properties,
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

describe("detail ANSI renderer", () => {
  test("renders the fixed no-selection frame", () => {
    const width = 64;
    const rendered = renderDetailAnsi(state(), { width, height: 8 });

    expect(rendered).toBe([
      "\x1b[H\x1b[2J",
      "\x1b[1;36mDetail\x1b[0m  \x1b[2mNo block selected\x1b[0m",
      "─".repeat(width),
      "Select a block in the outliner pane.",
      "",
      "",
      "",
      "\x1b[2m↑↓ scroll  Enter/e edit  f file  q tree  Ctrl+Q close\x1b[0m",
    ].join("\n"));
  });

  test("renders resolved preview text while retaining the fixed viewport height", () => {
    const selected = block("raw one\nraw two\nraw three\nraw four");
    const rendered = renderDetailAnsi(state({
      context: { selected, ancestors: [], children: [] },
      resolvedSelectedText: "resolved one\nresolved two\nresolved three\nresolved four",
      resolvedBreadcrumb: "Resolved title",
      previewOffset: 1,
      status: "Ready",
    }), { width: 64, height: 8 });

    expect(rendered).toBe([
      "\x1b[H\x1b[2J",
      "\x1b[1;36mDetail\x1b[0m  \x1b[2mResolved title\x1b[0m",
      "─".repeat(64),
      "resolved two",
      "resolved three",
      "resolved four",
      "Ready",
      "\x1b[2m↑↓ scroll  Enter/e edit  f file  q tree  Ctrl+Q close\x1b[0m",
    ].join("\n"));
  });

  test("renders editor cursor and completion without mutating controller-owned offsets", () => {
    const selected = block("alpha\nbeta");
    const buffer = new TextBuffer("alpha\nbeta");
    buffer.row = 1;
    buffer.column = 4;
    const detail = state({
      context: { selected, ancestors: [], children: [] },
      resolvedBreadcrumb: "Block",
      mode: "edit",
      buffer,
      editorOffset: 1,
      completion: {
        start: 0,
        end: 4,
        index: 1,
        items: [
          { label: "First", insertion: "first" },
          { label: "Second", insertion: "second" },
        ],
      },
    });
    const before = {
      editorOffset: detail.editorOffset,
      row: detail.buffer.row,
      column: detail.buffer.column,
      completionIndex: detail.completion?.index,
    };

    const rendered = renderDetailAnsi(detail, { width: 32, height: 9 });

    expect(rendered).toContain("   2 beta▏");
    expect(rendered).toContain("\x1b[2mCompletions 2/2\x1b[0m");
    expect(rendered).toContain("\x1b[7m› Second\x1b[0m");
    expect({
      editorOffset: detail.editorOffset,
      row: detail.buffer.row,
      column: detail.buffer.column,
      completionIndex: detail.completion?.index,
    }).toEqual(before);
  });

  test("renders file range selection and annotation source/comment frames", () => {
    const fileBlock = block("Source", [{ key: "file", value: "src/example.ts" }]);
    const referencedFile = {
      absolutePath: "/workspace/src/example.ts",
      displayPath: "src/example.ts",
      sourcePath: "src/example.ts",
      lines: ["const one = 1;", "const two = 2;", "return one + two;"],
      firstLine: 10,
    };
    const fileState = state({
      context: { selected: fileBlock, ancestors: [], children: [] },
      resolvedBreadcrumb: "Source",
      resolvedSelectedText: "Source",
      mode: "file",
      referencedFile,
      fileCursor: 2,
      selectionAnchor: 0,
    });

    const fileFrame = renderDetailAnsi(fileState, { width: 48, height: 9 });
    expect(fileFrame).toContain(" 10 │ const one = 1;");
    expect(fileFrame).toContain("\x1b[48;5;238m>12 │ return one + two;\x1b[0m");

    const annotationBlock = block(
      "Comment on src/example.ts:10-12\n[type::annotation] [file::src/example.ts]\nNeeds a guard.",
      [
        { key: "type", value: "annotation" },
        { key: "file", value: "src/example.ts" },
      ],
    );
    const annotationState = state({
      context: { selected: annotationBlock, ancestors: [], children: [] },
      resolvedBreadcrumb: "Annotation",
      resolvedSelectedText: annotationBlock.text,
      mode: "annotation",
      referencedFile,
    });
    const beforeOffset = annotationState.previewOffset;

    const annotationFrame = renderDetailAnsi(annotationState, { width: 48, height: 12 });
    expect(annotationFrame).toContain("\x1b[2mSource: src/example.ts:10-12\x1b[0m");
    expect(annotationFrame).toContain("\x1b[1mComment\x1b[0m\nNeeds a guard.");
    expect(annotationState.previewOffset).toBe(beforeOffset);
  });
});
