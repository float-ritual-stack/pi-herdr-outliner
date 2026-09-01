import { hyperlink, StdinBuffer } from "@earendil-works/pi-tui";
import { describe, expect, test } from "bun:test";
import {
  isTreeMouseSequence,
  treeDisclosureAtClick,
  parseTreePlainClick,
  parseTreeSecondaryClick,
  parseTreeWheel,
  treeLinkAtClick,
} from "../src/tree-mouse";

describe("Tree mouse parsing", () => {
  test("accepts only an unmodified primary-button press as a click", () => {
    expect(parseTreePlainClick("\x1b[<0;4;3M")).toEqual({ column: 3, row: 2 });
    for (const sequence of [
      "\x1b[<0;4;3m",
      "\x1b[<2;4;3M",
      "\x1b[<16;4;3M",
      "\x1b[<64;4;3M",
      "not-mouse",
    ]) {
      expect(parseTreePlainClick(sequence)).toBeNull();
    }
  });
  test("recognizes only an unmodified secondary-button press for pane-owned menus", () => {
    expect(parseTreeSecondaryClick("\x1b[<2;9;4M")).toEqual({ column: 8, row: 3 });
    expect(parseTreeSecondaryClick("\x1b[<0;9;4M")).toBeNull();
    expect(parseTreeSecondaryClick("\x1b[<18;9;4M")).toBeNull();
    expect(parseTreeSecondaryClick("\x1b[<2;9;4m")).toBeNull();
  });


  test("maps only unmodified vertical wheel presses", () => {
    expect(parseTreeWheel("\x1b[<64;4;3M")).toBe("up");
    expect(parseTreeWheel("\x1b[<65;4;3M")).toBe("down");
    for (const sequence of [
      "\x1b[<64;4;3m",
      "\x1b[<68;4;3M",
      "\x1b[<72;4;3M",
      "\x1b[<80;4;3M",
      "\x1b[<96;4;3M",
      "\x1b[<66;4;3M",
      "\x1b[<0;4;3M",
      "\x1b[<64;0;3M",
      "\x1b[<65;4;0M",
      "not-mouse",
    ]) {
      expect(parseTreeWheel(sequence)).toBeNull();
    }
  });

  test("identifies complete SGR mouse reports", () => {
    expect(isTreeMouseSequence("\x1b[<64;4;3M")).toBe(true);
    expect(isTreeMouseSequence("down")).toBe(false);
  });
  test("buffers mouse reports away from printable Tree input", () => {
    const input = new StdinBuffer();
    const mouse: string[] = [];
    const keyboard: string[] = [];
    input.on("data", (sequence) => {
      (isTreeMouseSequence(sequence) ? mouse : keyboard).push(sequence);
    });

    input.process("\x1b[<0;30");
    input.process(";2M\x1b[<0;30;2m");
    input.process("x");

    expect(mouse).toEqual(["\x1b[<0;30;2M", "\x1b[<0;30;2m"]);
    expect(keyboard).toEqual(["x"]);
    input.destroy();
  });
});

describe("Tree mouse disclosure hit testing", () => {
  test("returns the contextual row identity only from its disclosure marker", () => {
    const targets = [
      null,
      null,
      { rowId: "occurrence:view:root:child", disclosureColumn: 4 },
    ];

    expect(treeDisclosureAtClick(targets, "\x1b[<0;5;3M")).toBe(
      "occurrence:view:root:child",
    );
    expect(treeDisclosureAtClick(targets, "\x1b[<0;6;3M")).toBeNull();
    expect(treeDisclosureAtClick(targets, "\x1b[<0;5;2M")).toBeNull();
  });
});

describe("Tree mouse link hit testing", () => {
  test("returns the OSC 8 target at the clicked rendered cell", () => {
    const uri = "pi-outliner://goto/PIE-133";
    const lines = ["header", `  ${hyperlink("PIE-133", uri)} rest`];

    expect(treeLinkAtClick(lines, "\x1b[<0;5;2M")).toBe(uri);
    expect(treeLinkAtClick(lines, "\x1b[<0;1;2M")).toBeNull();
    expect(treeLinkAtClick(lines, "\x1b[<16;5;2M")).toBeNull();
  });
});
