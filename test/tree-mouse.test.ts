import { hyperlink } from "@earendil-works/pi-tui";
import { describe, expect, test } from "bun:test";
import {
  isTreeMouseSequence,
  parseTreePlainClick,
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
