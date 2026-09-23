import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "bun:test";
import { PreviewSelection } from "../src/preview-selection";

const rect = {x: 6, y: 1, width: 8, height: 2};
const lines = ["TREE  HEADER  OTHER", "TREE  abcdefghOTHER", "TREE  ijklmnopOTHER", "TREE  FOOTER  OTHER"];

test("Preview clicks are consumed without copying, while outside starts remain unclaimed", () => {
  const selection = new PreviewSelection();
  expect(selection.pointer({phase: "down", column: 7, row: 1}, rect, lines)).toEqual({consumed: true});
  expect(selection.pointer({phase: "up", column: 7, row: 1}, rect, lines)).toEqual({consumed: true});
  for (const [column, row] of [[5, 1], [14, 1], [7, 0], [7, 3]]) {
    expect(selection.pointer({phase: "down", column: column!, row: row!}, rect, lines)).toEqual({consumed: false});
    expect(selection.pointer({phase: "up", column: 9, row: 2}, rect, lines)).toEqual({consumed: false});
  }
});

test("cross-pane drags clamp to Preview content and exclude Tree, header, footer, and ANSI", () => {
  const selection = new PreviewSelection();
  const styled = lines.map(line => `\x1b[31m${line}\x1b[0m`);
  selection.pointer({phase: "down", column: 8, row: 1}, rect, styled);
  expect(selection.pointer({phase: "drag", column: 90, row: 9}, rect, styled)).toEqual({consumed: true});
  expect(selection.pointer({phase: "up", column: 90, row: 9}, rect, styled)).toEqual({consumed: true, copy: "cdefgh\nijklmnop"});
  selection.pointer({phase: "down", column: 10, row: 2}, rect, styled);
  expect(selection.pointer({phase: "up", column: 0, row: 0}, rect, styled)).toEqual({consumed: true, copy: "abcdefgh\nijkl"});
});

test("copy keeps Unicode graphemes intact and removes hyperlinks and terminal controls", () => {
  const selection = new PreviewSelection();
  const unicodeRect = {x: 2, y: 0, width: 8, height: 1};
  const unicode = ["T \x1b]8;;https://example.test\x1b\\界é👩‍💻Z  \x1b]8;;\x1b\\O"];
  selection.pointer({phase: "down", column: 2, row: 0}, unicodeRect, unicode);
  expect(selection.pointer({phase: "up", column: 10, row: 0}, unicodeRect, unicode)).toEqual({consumed: true, copy: "界é👩‍💻Z"});
});

test("clear and resize cancel copying but consume the remainder of an owned drag", () => {
  for (const resize of [false, true]) {
    const selection = new PreviewSelection();
    selection.pointer({phase: "down", column: 7, row: 1}, rect, lines);
    if (!resize) selection.clear();
    const nextRect = resize ? {...rect, width: 4} : rect;
    expect(selection.pointer({phase: "drag", column: 0, row: 2}, nextRect, lines)).toEqual({consumed: true});
    expect(selection.pointer({phase: "up", column: 0, row: 2}, nextRect, lines)).toEqual({consumed: true});
    expect(selection.highlight(lines, nextRect)).toEqual(lines);
    expect(selection.pointer({phase: "up", column: 8, row: 1}, rect, lines)).toEqual({consumed: false});
  }
});

test("highlight preserves frame text, width, and surrounding regions", () => {
  const selection = new PreviewSelection();
  selection.pointer({phase: "down", column: 8, row: 1}, rect, lines);
  selection.pointer({phase: "drag", column: 10, row: 2}, rect, lines);
  const highlighted = selection.highlight(lines, rect);
  expect(highlighted.map(stripTerminalSequences)).toEqual(lines);
  expect(highlighted.map(visibleWidth)).toEqual(lines.map(visibleWidth));
  expect(highlighted[0]).toBe(lines[0]);
  expect(highlighted[3]).toBe(lines[3]);
  expect(highlighted[1]).toBe("TREE  ab\x1b[7mcdefgh\x1b[27mOTHER");
  expect(highlighted[2]).toBe("TREE  \x1b[7mijkl\x1b[27mmnopOTHER");
});

test("partial wide-glyph drags copy complete graphemes without deleting frame columns", () => {
  const selection = new PreviewSelection();
  const unicodeRect = {x: 2, y: 0, width: 6, height: 1};
  const unicode = ["T 界é👩‍💻Z O"];
  selection.pointer({phase: "down", column: 3, row: 0}, unicodeRect, unicode);
  selection.pointer({phase: "drag", column: 6, row: 0}, unicodeRect, unicode);
  const highlighted = selection.highlight(unicode, unicodeRect);
  expect(highlighted.map(stripTerminalSequences)).toEqual(unicode);
  expect(highlighted.map(visibleWidth)).toEqual(unicode.map(visibleWidth));
  expect(highlighted[0]).toContain("\x1b[7m界é👩‍💻\x1b[27m");
  expect(selection.pointer({phase: "up", column: 6, row: 0}, unicodeRect, unicode)).toEqual({consumed: true, copy: "界é👩‍💻"});
});
