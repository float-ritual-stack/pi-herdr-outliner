import { describe, expect, test } from "bun:test";
import { TextBuffer } from "../src/text-buffer";

describe("TextBuffer grapheme movement", () => {
  test("moves across and deletes a joined emoji as one grapheme", () => {
    const family = "👨‍👩‍👧‍👦";
    const buffer = new TextBuffer(`a${family}b`);
    buffer.moveEnd();

    buffer.moveLeft();
    expect(buffer.column).toBe(1 + family.length);
    buffer.backspace();

    expect(buffer.text).toBe("ab");
    expect(buffer.column).toBe(1);
  });
});

describe("TextBuffer word motion and selection", () => {
  test("moves between word starts across physical lines", () => {
    const buffer = new TextBuffer("alpha beta\ngamma");
    buffer.row = 1;
    buffer.moveEnd();

    buffer.moveWordLeft();
    expect({ row: buffer.row, column: buffer.column }).toEqual({ row: 1, column: 0 });
    buffer.moveWordLeft();
    expect({ row: buffer.row, column: buffer.column }).toEqual({ row: 0, column: 6 });
    buffer.moveWordLeft();
    expect({ row: buffer.row, column: buffer.column }).toEqual({ row: 0, column: 0 });

    buffer.moveWordRight();
    expect({ row: buffer.row, column: buffer.column }).toEqual({ row: 0, column: 6 });
    buffer.moveWordRight();
    expect({ row: buffer.row, column: buffer.column }).toEqual({ row: 1, column: 0 });
    buffer.moveWordRight();
    expect({ row: buffer.row, column: buffer.column }).toEqual({ row: 1, column: 5 });
  });

  test("extends a selection across lines and deletes it as one range", () => {
    const buffer = new TextBuffer("alpha beta\ngamma");
    buffer.moveWordRight();
    buffer.moveWordRight(true);

    expect(buffer.selectionRange).toEqual({
      start: { row: 0, column: 6 },
      end: { row: 1, column: 0 },
    });

    buffer.backspace();
    expect(buffer.text).toBe("alpha gamma");
    expect({ row: buffer.row, column: buffer.column }).toEqual({ row: 0, column: 6 });
    expect(buffer.selectionRange).toBeNull();
  });

  test("typing replaces the selected range and select-all covers the full buffer", () => {
    const buffer = new TextBuffer("alpha beta\ngamma");
    buffer.selectAll();
    expect(buffer.hasSelection).toBe(true);

    buffer.insert("replacement");
    expect(buffer.text).toBe("replacement");
    expect(buffer.selectionRange).toBeNull();
  });
});
