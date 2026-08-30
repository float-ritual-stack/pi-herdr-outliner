import { getOsc8LinkAtColumn, stripTerminalSequences } from "@earendil-works/pi-tui";
import { describe, expect, test } from "bun:test";
import type { TreeView } from "../src/tree-controller";
import { renderTreeFrame } from "../src/tree-renderer";
import type { VisibleBlock } from "../src/types";
import type {
  PhysicalTreeRow,
  TreeRow,
  VirtualBranchConfig,
  VirtualBranchOccurrenceRow,
  VirtualBranchState,
} from "../src/virtual-branches";

function block(id: string, overrides: Partial<VisibleBlock> = {}): VisibleBlock {
  return {
    id,
    parentId: null,
    position: 0,
    text: id,
    author: "user",
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
    properties: [],
    depth: 0,
    hasChildren: false,
    displayText: id,
    ...overrides,
  };
}

function physical(
  block: VisibleBlock,
  presentation: { collapsed?: boolean; multilineExpanded?: boolean } = {},
): PhysicalTreeRow {
  return {
    kind: "physical",
    rowId: block.id,
    canonicalId: block.id,
    block,
    depth: block.depth,
    hasChildren: block.hasChildren,
    collapsed: presentation.collapsed ?? false,
    multilineExpanded: presentation.multilineExpanded ?? false,
  };
}

function occurrence(
  viewId: string,
  canonical: VisibleBlock,
  depth = 1,
  multilineExpanded = false,
): VirtualBranchOccurrenceRow {
  return {
    kind: "occurrence",
    rowId: `occurrence:${viewId}:${canonical.id}`,
    canonicalId: canonical.id,
    viewId,
    block: canonical,
    depth,
    hasChildren: false,
    multilineExpanded,
  };
}

function isTreeRow(row: VisibleBlock | TreeRow): row is TreeRow {
  return "rowId" in row;
}

const branchConfig: VirtualBranchConfig = {
  viewId: "definition",
  query: "",
  filters: [],
  limit: 200,
  create: null,
  createParentId: null,
  readOnly: false,
};

function branchState(overrides: Partial<VirtualBranchState> = {}): VirtualBranchState {
  return {
    config: branchConfig,
    configurationErrors: [],
    creationErrors: [],
    queryError: null,
    count: 0,
    completeness: { kind: "complete" },
    queried: true,
    ...overrides,
  };
}

function view(
  inputRows: ReadonlyArray<VisibleBlock | TreeRow>,
  overrides: Partial<TreeView> = {},
): TreeView {
  const rows = inputRows.map((row) => (isTreeRow(row) ? row : physical(row)));
  return {
    workspaceRoot: "/w",
    rows,
    physicalBlocksById: new Map(
      rows.filter((row): row is PhysicalTreeRow => row.kind === "physical").map((row) => [
        row.canonicalId,
        row.block,
      ]),
    ),
    workIdPrefix: "PIE",
    visibleCompleteness: { kind: "complete" },
    branchStates: new Map(),
    selectedIndex: 0,
    activeFilter: "",
    mode: "browse",
    quickInput: "",
    quickColumn: 0,
    quickRow: 0,
    quickLineCount: 1,
    quickCompletion: null,
    viewerLines: [],
    viewerPath: "",
    viewerOffset: 0,
    expandedBlockOffset: 0,
    status: "ready",
    refreshPending: false,
    ...overrides,
    workspaceContextBlockId: overrides.workspaceContextBlockId ?? null,
  };
}

const HELP =
  "↑↓ browse/preview  Enter read  e edit  D new Detail  o open next unlocked  R reveal  g goto";
const NARROW_HELP =
  "↑↓ browse/preview  Enter read  e edit  D new Detail  o open next unlocked  R re…";

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
        "\x1b[2m2 physical blocks · 0 projected occurrences\x1b[0m",
        "─".repeat(80),
        "\x1b[48;5;238m\x1b[1m▾ Root   \x1b[0m",
        "  • Child  A",
        "",
        "ready",
        `\x1b[2m${NARROW_HELP}\x1b[0m`,
      ].join("\n"),
    });
  });

  test("renders work IDs and canonical UUIDs as OSC 8 outliner links", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    const linked = block(id, {
      text: `PIE-133 links [decision::${id}]`,
      displayText: `PIE-133 links [decision::${id}]`,
    });
    const frame = renderTreeFrame(view([linked]), 120, 8).frame;
    const line = frame.split("\n").find((candidate) =>
      stripTerminalSequences(candidate).includes("PIE-133 links")
    );
    expect(line).toBeDefined();
    const visible = stripTerminalSequences(line!);
    expect(visible).toBe(`• PIE-133 links [decision::${id}]   `);

    expect(getOsc8LinkAtColumn(line!, visible.indexOf("PIE-133") + 2)).toBe(
      "pi-outliner://work/PIE-133",
    );
    expect(getOsc8LinkAtColumn(line!, visible.indexOf(id) + 2)).toBe(
      `pi-outliner://block/${id}`,
    );
  });
  test("links only Work IDs for the configured project prefix", () => {
    const linked = block("custom-work", {
      text: "ABC-001 and PIE-001",
      displayText: "ABC-001 and PIE-001",
    });
    const frame = renderTreeFrame(
      view([linked], { workIdPrefix: "ABC" }),
      80,
      8,
    ).frame;
    const line = frame.split("\n").find((candidate) =>
      stripTerminalSequences(candidate).includes("ABC-001 and")
    )!;
    const visible = stripTerminalSequences(line);
    expect(getOsc8LinkAtColumn(line, visible.indexOf("ABC-001") + 2)).toBe(
      "pi-outliner://work/ABC-001",
    );
    expect(getOsc8LinkAtColumn(line, visible.indexOf("PIE-001") + 2)).toBeUndefined();
  });


  test("renders expanded physical rows and markdown continuation styling", () => {
    const expanded = block("expanded", {
      text: "# Heading\n- item",
      displayText: "# Heading\n- item",
      author: "system",
    });

    const rendered = renderTreeFrame(
      view([physical(expanded, { multilineExpanded: true })]),
      40,
      9,
    ).frame.split("\n");

    expect(rendered.slice(4, 6)).toEqual([
      "\x1b[48;5;238m\x1b[1m• # Heading  S\x1b[0m",
      "  │ \x1b[33m-\x1b[0m item",
    ]);
    expect(rendered.at(-2)).toBe("ready");
  });

  test("renders a selected expanded block from its intra-block offset", () => {
    const text = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");
    const expanded = block("expanded", {
      text,
      displayText: text,
    });

    const rendered = renderTreeFrame(
      view([physical(expanded, { multilineExpanded: true })], {
        expandedBlockOffset: 4,
        status: "",
      }),
      40,
      10,
    ).frame.split("\n");

    expect(rendered.slice(4, 8)).toEqual([
      "\x1b[48;5;238m\x1b[1m  │ line 5\x1b[0m",
      "  │ line 6",
      "  │ line 7",
      "  │ line 8",
    ]);
    expect(rendered.at(-2)).toBe("Expanded block rows 5-8/12");
    expect(rendered.at(-1)).toBe(
      "\x1b[2mEnter read  e edit  D new Detail  PgUp/…\x1b[0m",
    );
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

    expect(rendered).toContain(
      "1 physical block · 0 projected occurrences\u001b[0m  \u001b[33mWARNING: truncated at 500\u001b[0m",
    );
    expect(rendered).toContain("Completions 1/1 · Showing first 20 matches");
  });

  test("renders virtual definition states and projected counts without changing canonical text", () => {
    const valid = block("valid", {
      text: "Valid",
      displayText: "Valid",
      hasChildren: true,
    });
    const card = block("card", {
      text: "Card",
      displayText: "Card",
      hasChildren: true,
    });
    const limited = block("limited", { text: "Limited", displayText: "Limited" });
    const invalid = block("invalid", { text: "Invalid", displayText: "Invalid" });
    const failed = block("failed", { text: "Failed", displayText: "Failed" });
    const readOnly = block("read-only", { text: "Read only", displayText: "Read only" });
    const rows: TreeRow[] = [
      physical(valid),
      occurrence("valid", card),
      physical(limited),
      physical(invalid),
      physical(failed),
      physical(readOnly),
    ];
    const branchStates = new Map<string, VirtualBranchState>([
      ["valid", branchState({ count: 1 })],
      [
        "limited",
        branchState({ count: 2, completeness: { kind: "truncated", limit: 2 } }),
      ],
      [
        "invalid",
        branchState({
          config: null,
          configurationErrors: ["missing [view::query]"],
          completeness: null,
          queried: false,
        }),
      ],
      [
        "failed",
        branchState({ queryError: "query unavailable", completeness: null }),
      ],
      [
        "read-only",
        branchState({ config: { ...branchConfig, readOnly: true } }),
      ],
    ]);

    const rendered = renderTreeFrame(view(rows, { branchStates }), 200, 12);

    expect(rendered).toEqual({
      scrollStartEntryIndex: 0,
      frame: [
        "\x1b[H\x1b[2J",
        "\x1b[1;36mOutliner\x1b[0m  \x1b[2m/w\x1b[0m",
        "\x1b[2m5 physical blocks · 1 projected occurrence\x1b[0m",
        "─".repeat(200),
        "\x1b[48;5;238m\x1b[1m▾ Valid [V:1]   \x1b[0m",
        "  ◇ Card   ",
        "• Limited [V:2 · TRUNCATED]   ",
        "• Invalid [V:0 · CONFIG ERROR]   ",
        "• Failed [V:0 · QUERY ERROR]   ",
        "• Read only [V:0 · READ-ONLY]   ",
        "ready",
        `\x1b[2m${HELP}\x1b[0m`,
      ].join("\n"),
    });
    expect(valid.displayText).toBe("Valid");
  });

  test("highlights an occurrence as a leaf with a distinct marker", () => {
    const definition = block("definition", {
      text: "Definition",
      displayText: "Definition",
      hasChildren: true,
    });
    const canonical = block("canonical", {
      text: "Canonical",
      displayText: "Canonical",
      hasChildren: true,
    });
    const rows = [physical(definition), occurrence(definition.id, canonical)];
    const rendered = renderTreeFrame(
      view(rows, {
        selectedIndex: 1,
        branchStates: new Map([["definition", branchState({ count: 1 })]]),
      }),
      80,
      8,
    );

    expect(rendered).toEqual({
      scrollStartEntryIndex: 0,
      frame: [
        "\x1b[H\x1b[2J",
        "\x1b[1;36mOutliner\x1b[0m  \x1b[2m/w\x1b[0m",
        "\x1b[2m1 physical block · 1 projected occurrence\x1b[0m",
        "─".repeat(80),
        "▾ Definition [V:1]   ",
        "\x1b[48;5;238m\x1b[1m  ◇ Canonical   \x1b[0m",
        "ready",
        "\x1b[2m◇ occurrence  Enter read  e edit  D new Detail  o open next unlocked  R reveal\x1b[0m",
      ].join("\n"),
    });
    expect(rendered.frame).not.toContain("▸ Canonical");
    expect(rendered.frame).not.toContain("▾ Canonical");
  });

  test("makes canonical deletion scope explicit for an occurrence", () => {
    const definition = block("definition", { text: "Next", displayText: "Next" });
    const canonical = block("canonical", { text: "Card", displayText: "Card" });
    const rows = [physical(definition), occurrence(definition.id, canonical)];
    const frame = renderTreeFrame(view(rows, {
      selectedIndex: 1,
      mode: "delete",
    }), 120, 8).frame;

    expect(frame).toContain(
      "Move canonical block “Card” and its descendants to Trash? y/N",
    );
  });

  test("explains property-aware creation destination and mutation", () => {
    const parent = block("parent", { text: "Inbox", displayText: "Inbox" });
    const definition = block("definition", { text: "Doing", displayText: "Doing" });
    const writable: VirtualBranchConfig = {
      ...branchConfig,
      viewId: definition.id,
      create: { key: "status", value: "active" },
      createParentId: parent.id,
      readOnly: false,
    };
    const frame = renderTreeFrame(view([physical(parent), physical(definition)], {
      selectedIndex: 1,
      mode: "add-child",
      branchStates: new Map([
        [definition.id, branchState({ config: writable })],
      ]),
    }), 120, 8).frame;

    expect(frame).toContain(
      "Create canonical under Inbox · sets [status::active] · Enter save · Esc cancel",
    );
  });

  test("reserves compact branch state and exposes full selected error", () => {
    const definition = block("definition", {
      text: "A very long virtual branch title that would otherwise hide its state",
      displayText: "A very long virtual branch title that would otherwise hide its state",
    });
    const state = branchState({
      config: null,
      configurationErrors: ["missing [query::status=next]"],
      completeness: null,
      queried: false,
    });
    const frame = renderTreeFrame(view([physical(definition)], {
      status: "",
      branchStates: new Map([[definition.id, state]]),
    }), 60, 8).frame;
    expect(frame).toContain("[V:0 · CONFIG ERROR]");
    const wideFrame = renderTreeFrame(view([physical(definition)], {
      status: "",
      branchStates: new Map([[definition.id, state]]),
    }), 120, 8).frame;
    expect(wideFrame).toContain("CONFIG ERROR: missing [query::status=next]");
  });

  test("places a physical sibling editor after projected rows nested under its ancestor", () => {
    const ancestor = block("ancestor", {
      text: "Ancestor",
      displayText: "Ancestor",
      hasChildren: true,
    });
    const definition = block("definition", {
      parentId: ancestor.id,
      text: "Definition",
      displayText: "Definition",
      depth: 1,
      hasChildren: true,
    });
    const card = block("card", { text: "Card", displayText: "Card" });
    const sibling = block("sibling", {
      text: "Sibling",
      displayText: "Sibling",
      position: 1,
    });
    const rows = [
      physical(ancestor),
      physical(definition),
      occurrence(definition.id, card, 2),
      physical(sibling),
    ];
    const rendered = renderTreeFrame(
      view(rows, {
        mode: "add-sibling",
        branchStates: new Map([["definition", branchState({ count: 1 })]]),
      }),
      100,
      11,
    ).frame.split("\n");

    expect(rendered.slice(4, 9)).toEqual([
      "▾ Ancestor   ",
      "  ▾ Definition [V:1]   ",
      "    ◇ Card   ",
      "\x1b[48;5;238m\x1b[1m• ▏   \x1b[0m",
      "• Sibling   ",
    ]);
  });

  test("renders filter, delete, and viewer mode-specific frames", () => {
    const selected = block("selected");
    const filterFrame = renderTreeFrame(
      view([selected], { mode: "filter", quickInput: "type=page", status: "" }),
      80,
      8,
    ).frame.split("\n");
    expect(filterFrame.at(-2)).toBe("\x1b[1mFilter:\x1b[0m type=page▏");
    const invalidFilterFrame = renderTreeFrame(
      view([selected], {
        mode: "filter",
        quickInput: 'status="in progress',
        status: "Invalid filter: Unterminated quoted filter value at character 8",
      }),
      120,
      8,
    ).frame.split("\n");
    expect(invalidFilterFrame.at(-2)).toContain(
      "Invalid filter: Unterminated quoted filter value at character 8",
    );

    const captureFrame = renderTreeFrame(
      view([selected], {
        mode: "capture",
        quickInput: "Second line",
        quickRow: 1,
        quickLineCount: 2,
        status: "",
      }),
      100,
      8,
    ).frame.split("\n");
    expect(captureFrame.at(-2)).toBe("\x1b[1mCapture 2/2:\x1b[0m Second line▏");
    expect(captureFrame.at(-1)).toContain(
      "type/paste  ↑↓ lines  Shift+Enter/Ctrl+E newline  Enter capture  Esc cancel",
    );

    const gotoFrame = renderTreeFrame(
      view([selected], {
        mode: "goto",
        quickInput: "road rev",
        quickColumn: 8,
        quickCompletion: {
          start: 0,
          end: 8,
          index: 0,
          truncatedLimit: null,
          items: [
            {
              label: "40bd0864 · Roadmap review after the graveyard walk",
              insertion: "40bd0864-913a-4537-9535-8f96e1b63ef7",
              blockId: "40bd0864-913a-4537-9535-8f96e1b63ef7",
            },
          ],
        },
      }),
      100,
      8,
    ).frame.split("\n");
    expect(gotoFrame.at(-2)).toContain(
      "Goto:\x1b[0m road rev▏  1/1 40bd0864 · Roadmap review after the graveyard walk",
    );
    expect(gotoFrame.at(-1)).toBe(
      "\x1b[2mtype ID/text  ↑↓ choose  Tab cycle  Enter jump  Esc cancel\x1b[0m",
    );

    const deleteFrame = renderTreeFrame(view([selected], { mode: "delete" }), 80, 8).frame.split("\n");
    expect(deleteFrame.at(-2)).toBe("\x1b[33;1mMove this block and its descendants to Trash? y/N\x1b[0m");

    const deletedSelected = block("deleted", {
      text: "PIE-999 deleted [work-id::PIE-999]",
      displayText: "PIE-999 deleted [work-id::PIE-999]",
      properties: [{ key: "work-id", value: "PIE-999" }],
      deletedAt: "deleted-at",
      effectiveDeletedRootId: "deleted",
    });
    const purgeFrame = renderTreeFrame(
      view([deletedSelected], { mode: "purge", quickInput: "PIE-" }),
      80,
      8,
    ).frame.split("\n");
    expect(purgeFrame.at(-2)).toContain("Purge PIE-999:");
    expect(purgeFrame.at(-1)).toContain("type exact identifier");

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
