import { describe, expect, test } from "bun:test";
import type { TreeView } from "../src/tree-controller";
import { renderTreeFrame } from "../src/tree-renderer";
import type { VisibleBlock } from "../src/types";

function block(id: string, overrides: Partial<VisibleBlock> = {}): VisibleBlock {
  return {
    id,
    parentId: null,
    position: 0,
    text: id,
    author: "user",
    collapsed: false,
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
    properties: [],
    depth: 0,
    multilineExpanded: false,
    hasChildren: false,
    displayText: id,
    ...overrides,
  };
}

function view(rows: VisibleBlock[], overrides: Partial<TreeView> = {}): TreeView {
  return {
    workspaceRoot: "/w",
    rows,
    physicalBlocksById: new Map(rows.map((row) => [row.id, row])),
    visibleCompleteness: { kind: "complete" },
    selectedIndex: 0,
    activeFilter: "",
    mode: "browse",
    quickInput: "",
    quickColumn: 0,
    quickCompletion: null,
    viewerLines: [],
    viewerPath: "",
    viewerOffset: 0,
    status: "ready",
    refreshPending: false,
    ...overrides,
  };
}

const HELP = "↑↓ navigate  Shift+↑↓ reorder  . / ⌘. detail  Enter inline  Ctrl+Q close";

describe("renderTreeFrame", () => {
  test("renders a representative browse frame exactly", () => {
    const root = block("root", { text: "Root", displayText: "Root", hasChildren: true });
    const child = block("child", {
      parentId: "root",
      position: 0,
      text: "Child",
      displayText: "Child",
      author: "agent",
      depth: 1,
    });

    const rendered = renderTreeFrame(view([root, child]), 80, 9);

    expect(rendered).toEqual({
      scrollStartEntryIndex: 0,
      frame: [
        "\x1b[H\x1b[2J",
        "\x1b[1;36mOutliner\x1b[0m  \x1b[2m/w\x1b[0m",
        "\x1b[2m2 blocks\x1b[0m",
        "─".repeat(80),
        "\x1b[48;5;238m\x1b[1m▾ Root   \x1b[0m",
        "  • Child  A",
        "",
        "ready",
        `\x1b[2m${HELP}\x1b[0m`,
      ].join("\n"),
    });
  });

  test("renders expanded physical rows and markdown continuation styling", () => {
    const expanded = block("expanded", {
      text: "# Heading\n- item",
      displayText: "# Heading\n- item",
      author: "system",
      multilineExpanded: true,
    });

    const rendered = renderTreeFrame(view([expanded]), 40, 9).frame.split("\n");

    expect(rendered.slice(4, 6)).toEqual([
      "\x1b[48;5;238m\x1b[1m• # Heading  S\x1b[0m",
      "  │ \x1b[33m-\x1b[0m item",
    ]);
    expect(rendered.at(-2)).toBe("ready");
  });

  test("places an add-child editor before existing descendants and renders completion rows", () => {
    const parent = block("parent", { text: "Parent", displayText: "Parent", hasChildren: true });
    const child = block("child", {
      parentId: "parent",
      text: "Existing",
      displayText: "Existing",
      depth: 1,
    });
    const rendered = renderTreeFrame(
      view([parent, child], {
        mode: "add-child",
        quickInput: "[[h",
        quickColumn: 3,
        quickCompletion: {
          start: 0,
          end: 3,
          index: 0,
          items: [{ label: "Home", insertion: "[[Home]]" }],
          truncatedLimit: null,
        },
      }),
      80,
      11,
    ).frame.split("\n");

    expect(rendered.slice(4, 8)).toEqual([
      "▾ Parent   ",
      "\x1b[48;5;238m\x1b[1m  • [[h▏   \x1b[0m",
      "      \x1b[2mCompletions 1/1\x1b[0m",
      "      \x1b[7m› Home\x1b[0m",
    ]);
    expect(rendered[8]).toBe("  • Existing   ");
    expect(rendered.at(-2)).toBe(
      "Quick edit: ←→ cursor  Tab complete  Enter save  Shift+Enter/Ctrl+E multiline  Esc cancel",
    );
  });

  test("renders explicit snapshot and completion truncation warnings", () => {
    const selected = block("selected");
    const rendered = renderTreeFrame(
      view([selected], {
        visibleCompleteness: { kind: "truncated", limit: 500 },
        mode: "edit",
        quickInput: "[[s",
        quickColumn: 3,
        quickCompletion: {
          start: 0,
          end: 3,
          index: 0,
          truncatedLimit: 20,
          items: [{ label: "Selected", insertion: "[[Selected]]" }],
        },
      }),
      100,
      10,
    ).frame;

    expect(rendered).toContain("1 blocks\u001b[0m  \u001b[33mWARNING: truncated at 500\u001b[0m");
    expect(rendered).toContain("Completions 1/1 · Showing first 20 matches");
  });

  test("renders filter, delete, and viewer mode-specific frames", () => {
    const selected = block("selected");
    const filterFrame = renderTreeFrame(
      view([selected], { mode: "filter", quickInput: "type=page" }),
      80,
      8,
    ).frame.split("\n");
    expect(filterFrame.at(-2)).toBe("\x1b[1mFilter:\x1b[0m type=page▏");

    const deleteFrame = renderTreeFrame(view([selected], { mode: "delete" }), 80, 8).frame.split("\n");
    expect(deleteFrame.at(-2)).toBe("\x1b[31;1mDelete this block and all descendants? y/N\x1b[0m");

    const viewer = renderTreeFrame(
      view([selected], {
        mode: "viewer",
        viewerPath: "notes.md:3",
        viewerLines: ["# Heading", "- item"],
        viewerOffset: 0,
      }),
      20,
      7,
    );
    expect(viewer.frame).toBe([
      "\x1b[H\x1b[2J",
      "\x1b[1mnotes.md:3\x1b[0m",
      "─".repeat(20),
      "\x1b[1;36m# Heading\x1b[0m",
      "\x1b[33m-\x1b[0m item",
      "",
      "\x1b[2m↑↓ scroll  g/G ends  Esc close  1/2\x1b[0m",
    ].join("\n"));
  });

  test("returns logical scroll state that keeps the selected row visible in either direction", () => {
    const rows = Array.from({ length: 6 }, (_, index) => block(`row-${index}`, { position: index }));

    const down = renderTreeFrame(view(rows, { selectedIndex: 5 }), 40, 8, 0);
    expect(down.scrollStartEntryIndex).toBe(4);
    expect(down.frame).toContain("• row-4");
    expect(down.frame).toContain("\x1b[48;5;238m\x1b[1m• row-5");
    expect(down.frame).not.toContain("• row-3");

    const up = renderTreeFrame(view(rows, { selectedIndex: 0 }), 40, 8, down.scrollStartEntryIndex);
    expect(up.scrollStartEntryIndex).toBe(0);
    expect(up.frame).toContain("\x1b[48;5;238m\x1b[1m• row-0");
  });
});
