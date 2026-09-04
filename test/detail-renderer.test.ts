import { getOsc8LinkAtColumn, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "bun:test";
import { DEFAULT_OUTLINER_ACTION_KEYMAP } from "../src/outliner-actions";
import type { DetailState } from "../src/detail-controller";
import {
  parseDetailHeaderPropertyKeys,
  renderDetailAnsi,
  renderDetailLines,
} from "../src/detail-renderer";
import { createOpenDestinationChooserState } from "../src/open-destination-chooser";
import { TextBuffer } from "../src/text-buffer";
import type { Block } from "../src/types";
const ACTION_MENU = "\x1b]8;;pi-outliner-action:detail.menu.open\x1b\\\x1b[2;36m[⋯]\x1b[0m\x1b]8;;\x1b\\";
const UNLOCKED = "\x1b]8;;pi-outliner-action:detail.lock.toggle\x1b\\\x1b[32m🔓\x1b[0m\x1b]8;;\x1b\\";
const detailHeader = (title: string, width: number): string[] => {
  const controls = `${UNLOCKED} ${ACTION_MENU}`;
  return [
    `\x1b[1;97m${title}\x1b[0m${
      " ".repeat(Math.max(1, width - visibleWidth(title) - visibleWidth(controls)))
    }${controls}`,
    "",
    `\x1b[2m${"─".repeat(width)}\x1b[0m`,
  ];
};
const detailHelp = (mode: "preview" | "edit", width: number): string =>
  `\x1b[2m${truncateToWidth(
    DEFAULT_OUTLINER_ACTION_KEYMAP.helpText("detail", mode),
    width,
    "…",
  ).replaceAll("\x1b[0m", "")}\x1b[0m`;

function block(text: string, properties: Block["properties"] = []): Block {
  return {
    id: "block-1",
    parentId: null,
    position: 0,
    text,
    author: "user",
    createdAt: "created",
    updatedAt: "updated",
    properties,
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

describe("detail ANSI renderer", () => {
  test("renders the fixed no-selection frame", () => {
    const width = 64;
    const rendered = renderDetailAnsi(state(), { width, height: 8 });

    const [header, metadata, rule] = detailHeader("No block selected", width);
    expect(rendered).toBe([
      `\x1b[H\x1b[2J${header}`,
      metadata,
      rule,
      "Select a block in the outliner pane.",
      "",
      "",
      "",
      detailHelp("preview", 64),
    ].join("\n"));
  });
  test("right-aligns clickable lock and action-menu controls", () => {
    const header = renderDetailLines(state(), { width: 64, height: 8 })[0]!;
    const visible = stripTerminalSequences(header);
    expect(visible.endsWith("🔓 [⋯]")).toBe(true);
    expect(getOsc8LinkAtColumn(header, visible.indexOf("🔓"))).toBe(
      "pi-outliner-action:detail.lock.toggle",
    );
    expect(getOsc8LinkAtColumn(header, visible.indexOf("[⋯]") + 1)).toBe(
      "pi-outliner-action:detail.menu.open",
    );
  });

  test("puts configured properties on one compact line beneath the title", () => {
    const selected = block("Roadmap item", [
      { key: "status", value: "planned" },
      { key: "work-stage", value: "doing" },
      { key: "priority", value: "high" },
      { key: "track", value: "interactive-documents" },
    ]);
    const detail = state({
      context: {
        selected,
        ancestors: [block("Pi Outliner Workboard")],
        children: [],
      },
      resolvedSelectedText: selected.text,
    });

    const lines = renderDetailLines(detail, { width: 100, height: 8 });
    expect(stripTerminalSequences(lines[0]!)).toStartWith("Roadmap item");
    expect(stripTerminalSequences(lines[1]!)).toBe(
      "status planned · stage doing · priority high · track interactive-documents" +
        "  ·  Pi Outliner Workboard",
    );
    expect(lines.every((line) => visibleWidth(line) <= 100)).toBe(true);

    const configured = renderDetailLines(
      detail,
      { width: 28, height: 8 },
      { header: { propertyKeys: ["work-stage"] } },
    );
    expect(stripTerminalSequences(configured[1]!)).toStartWith("stage doing  ·  ");
  });


  test("renders resolved preview text while retaining the fixed viewport height", () => {
    const selected = block("raw one\nraw two\nraw three\nraw four");
    const rendered = renderDetailAnsi(state({
      context: { selected, ancestors: [], children: [] },
      resolvedSelectedText: "resolved one\nresolved two\nresolved three\nresolved four",
      resolvedBreadcrumb: "Resolved title",
      targetFragmentId: "resolved-section",
      previewOffset: 1,
      status: "Ready",
    }), { width: 64, height: 8 });

    const [header, metadata, rule] = detailHeader(
      "Resolved title · ^resolved-section",
      64,
    );
    expect(rendered).toBe([
      `\x1b[H\x1b[2J${header}`,
      metadata,
      rule,
      "resolved two",
      "resolved three",
      "resolved four",
      "Ready",
      detailHelp("preview", 64),
    ].join("\n"));
  });

  test("renders full-width embed backgrounds only inside projected line ranges", () => {
    const selected = block("raw");
    const detail = state({
      context: { selected, ancestors: [], children: [] },
      resolvedSelectedText: "Before\nEmbedded block\nProjected body\nAfter",
      resolvedBreadcrumb: "Embed demo",
      embedRanges: [{ startLine: 1, endLine: 2 }],
    });

    let rendered = renderDetailLines(detail, { width: 32, height: 10 });
    expect(rendered[3]).toBe("Before");
    expect(rendered[4]).toContain("\x1b[48;5;236m");
    expect(rendered[4]).toContain("Embedded block");
    expect(rendered[5]).toContain("\x1b[48;5;236m");
    expect(rendered[6]).toBe("After");

    detail.embedBackgroundEnabled = false;
    rendered = renderDetailLines(detail, { width: 32, height: 10 });
    expect(rendered.slice(3, 7).some((line) => line.includes("\x1b[48;5;236m"))).toBe(false);
  });

  test("fits the cursor and completion inside the exact viewport height", () => {
    const selected = block("one\ntwo\nthree\nfour\nfive\nsix\nseven");
    const buffer = new TextBuffer(selected.text);
    buffer.row = 3;
    buffer.column = 4;
    const detail = state({
      context: { selected, ancestors: [], children: [] },
      resolvedBreadcrumb: "Block",
      mode: "edit",
      buffer,
      editorVisualOffset: 3,
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
      editorVisualOffset: detail.editorVisualOffset,
      row: detail.buffer.row,
      column: detail.buffer.column,
      completionIndex: detail.completion?.index,
    };

    const rendered = renderDetailAnsi(detail, { width: 32, height: 9 });

    const [header, metadata, rule] = detailHeader("Block", 32);
    expect(rendered).toBe([
      `\x1b[H\x1b[2J${header}`,
      metadata,
      rule,
      "   4 four▏",
      "\x1b[2mCompletions 2/2\x1b[0m",
      "  First",
      "\x1b[7m› Second\x1b[0m",
      "",
      detailHelp("edit", 32),
    ].join("\n"));
    expect(rendered.split("\n")).toHaveLength(9);
    expect({
      editorVisualOffset: detail.editorVisualOffset,
      row: detail.buffer.row,
      column: detail.buffer.column,
      completionIndex: detail.completion?.index,
    }).toEqual(before);
  });

  test("omits completion output when the viewport has no completion item row", () => {
    const selected = block("alpha");
    const buffer = new TextBuffer(selected.text);
    buffer.column = 5;

    const rendered = renderDetailAnsi(state({
      context: { selected, ancestors: [], children: [] },
      resolvedBreadcrumb: "Block",
      mode: "edit",
      buffer,
      completion: {
        start: 0,
        end: 5,
        index: 0,
        items: [{ label: "First", insertion: "first" }],
      },
    }), { width: 32, height: 6 });

    const [header, metadata, rule] = detailHeader("Block", 32);
    expect(rendered).toBe([
      `\x1b[H\x1b[2J${header}`,
      metadata,
      rule,
      "   1 alpha▏",
      "",
      detailHelp("edit", 32),
    ].join("\n"));
    expect(rendered.split("\n")).toHaveLength(6);
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

test("sanitizes dynamic terminal controls and respects compact viewport heights", () => {
  const selected = block(
    "safe\x1b[2Jtext\x9b?1049lrest\x1b]0;owned\x07done\x90payload\x1b\\tail",
  );
  const detail = state({
    context: { selected, ancestors: [], children: [] },
    resolvedSelectedText: selected.text,
    resolvedBreadcrumb: "Title\x1b[?1049lnext\x9dwindow title\x9cafter",
    status: "Status\x9b2Jdone\x1b_apc payload\x1b\\tail",
  });

  const lines = renderDetailLines(detail, { width: 80, height: 8 });
  const rendered = lines.join("\n");
  expect(rendered).toContain("safetextrestdonetail");
  expect(rendered).toContain("Titlenextafter");
  expect(rendered).toContain("Statusdonetail");
  expect(rendered).not.toContain("\x1b[2J");
  expect(rendered).not.toContain("[2J");
  expect(rendered).not.toContain("2J");
  expect(rendered).not.toContain("\x1b[?1049l");
  expect(rendered).not.toContain("[?1049l");
  expect(rendered).not.toContain("?1049l");
  expect(rendered).not.toContain("owned");
  expect(rendered).not.toContain("payload");
  expect(rendered).not.toContain("window title");
  expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
  expect(lines.every((line) => !/[\n\r\x07\x80-\x9f]/.test(line))).toBe(true);

  for (let height = 1; height <= 5; height += 1) {
    expect(renderDetailLines(detail, { width: 80, height })).toHaveLength(height);
  }
});

test("wraps wide edit text while reserving one cell for the software cursor", () => {
  const selected = block("\t界界");
  const buffer = new TextBuffer(selected.text);
  buffer.moveEnd();
  const lines = renderDetailLines(state({
    context: { selected, ancestors: [], children: [] },
    mode: "edit",
    buffer,
  }), { width: 10, height: 8 });

  expect(lines.every((line) => visibleWidth(line) <= 10)).toBe(true);
  expect(lines[3]).toBe("   1     ");
  expect(lines[4]).toBe("     界界▏");
});

test("keeps a joined emoji intact when its grapheme exactly fills a wrapped row", () => {
  const family = "👨‍👩‍👧‍👦";
  const selected = block(`${family}x`);
  const buffer = new TextBuffer(selected.text);
  buffer.moveEnd();
  const lines = renderDetailLines(state({
    context: { selected, ancestors: [], children: [] },
    mode: "edit",
    buffer,
  }), { width: 8, height: 8 });

  expect(lines[3]).toBe(`   1 ${family}`);
  expect(lines[4]).toBe("     x▏");
  expect(lines.slice(3, 5).every((line) => visibleWidth(line) <= 8)).toBe(true);
});

test("wraps a long physical editor line without ellipsizing or changing its source", () => {
  const selected = block("alpha beta gamma delta epsilon");
  const buffer = new TextBuffer(selected.text);
  buffer.moveEnd();
  const lines = renderDetailLines(state({
    context: { selected, ancestors: [], children: [] },
    mode: "edit",
    buffer,
  }), { width: 18, height: 10 });

  const editorLines = lines.slice(3, 6);
  expect(editorLines).toEqual([
    "   1 alpha beta ",
    "     gamma delta ",
    "     epsilon▏",
  ]);
  expect(editorLines.join("\n")).not.toContain("…");
  expect(buffer.text).toBe(selected.text);
});

test("renders a selection across wrapped rows with the cursor at its active edge", () => {
  const selected = block("alpha beta gamma delta epsilon");
  const buffer = new TextBuffer(selected.text);
  buffer.moveWordRight();
  buffer.moveWordRight(true);
  buffer.moveWordRight(true);
  const lines = renderDetailLines(state({
    context: { selected, ancestors: [], children: [] },
    mode: "edit",
    buffer,
  }), { width: 18, height: 10 });

  expect(lines[3]).toBe("   1 alpha \x1b[7mbeta \x1b[0m");
  expect(lines[4]).toBe("     \x1b[7mgamma \x1b[0m▏delta ");
  expect(lines.slice(3, 6).every((line) => visibleWidth(line) <= 18)).toBe(true);
});

test("renders lock state as a compact clickable icon", () => {
  const unlocked = renderDetailLines(
    state({ connectionMode: "unlocked" }),
    { width: 80, height: 8 },
  )[0]!;
  const locked = renderDetailLines(
    state({ connectionMode: "locked" }),
    { width: 80, height: 8 },
  )[0]!;

  expect(stripTerminalSequences(unlocked)).toContain("🔓");
  expect(stripTerminalSequences(locked)).toContain("🔒");
  expect(unlocked).not.toContain("Detail");
  expect(unlocked).not.toContain("Unlocked");
});

test("parses configured Detail header properties deterministically", () => {
  expect(parseDetailHeaderPropertyKeys(undefined)).toBeUndefined();
  expect(parseDetailHeaderPropertyKeys("work-stage, owner, work-stage")).toEqual([
    "work-stage",
    "owner",
  ]);
  expect(parseDetailHeaderPropertyKeys("")).toEqual([]);
});

test("renders the shared destination prompt over ordinary Detail help", () => {
  const detailState = state({
    status: "Ordinary status",
    destinationChooser: {
      active: true,
      loading: false,
      target: { blockId: "target-1", title: "Target" },
      status: "Choose destination",
    },
  });

  const rendered = renderDetailLines(detailState, { width: 100, height: 8 }).map(
    stripTerminalSequences,
  );
  expect(rendered.at(-2)).toContain("Choose destination");
  expect(rendered.at(-1)).toContain("f first unlocked");
  expect(rendered.at(-1)).toContain("Enter default");
});
