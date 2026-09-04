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

  test("extends pointer placement into an exact multiline copy range", () => {
    const buffer = new TextBuffer("alpha beta\ngamma");
    buffer.placeCursor(0, 2);
    buffer.placeCursor(1, 3, true);

    expect(buffer.selectionRange).toEqual({
      start: { row: 0, column: 2 },
      end: { row: 1, column: 3 },
    });
    expect(buffer.selectedText).toBe("pha beta\ngam");

    buffer.placeCursor(0, 1);
    expect(buffer.selectionRange).toBeNull();
    expect(buffer.selectedText).toBeNull();
  });

  test("typing replaces the selected range and select-all covers the full buffer", () => {
    const buffer = new TextBuffer("alpha beta\ngamma");
    buffer.selectAll();
    expect(buffer.hasSelection).toBe(true);

    buffer.insert("replacement");
    expect(buffer.text).toBe("replacement");
    expect(buffer.selectionRange).toBeNull();
  });

  test("does not retain a collapsed select-all anchor in an empty buffer", () => {
    const buffer = new TextBuffer();
    buffer.selectAll();
    expect(buffer.hasSelection).toBe(false);

    buffer.insert("a");
    buffer.insert("b");
    expect(buffer.text).toBe("ab");
  });
});

describe("TextBuffer undo and redo", () => {
  test("replaces an arbitrary line as an undoable edit without moving another-line cursor", () => {
    const buffer = new TextBuffer("first\nsecond");
    buffer.moveEnd();

    buffer.replaceLine(1, "second ^stable");

    expect(buffer.text).toBe("first\nsecond ^stable");
    expect({ row: buffer.row, column: buffer.column }).toEqual({ row: 0, column: 5 });
    expect(buffer.undo()).toBe(true);
    expect(buffer.text).toBe("first\nsecond");
  });

  test("coalesces consecutive grapheme typing and restores it with one undo", () => {
    const buffer = new TextBuffer();
    buffer.insert("a");
    buffer.insert("👨‍👩‍👧‍👦");
    buffer.insert("b");

    expect(buffer.text).toBe("a👨‍👩‍👧‍👦b");
    expect(buffer.undo()).toBe(true);
    expect(buffer.text).toBe("");
    expect({ row: buffer.row, column: buffer.column }).toEqual({ row: 0, column: 0 });

    expect(buffer.redo()).toBe(true);
    expect(buffer.text).toBe("a👨‍👩‍👧‍👦b");
    expect(buffer.column).toBe(buffer.text.length);
  });

  test("breaks typing coalescence after cursor movement", () => {
    const buffer = new TextBuffer();
    buffer.insert("a");
    buffer.insert("b");
    buffer.insert("c");
    buffer.moveLeft();
    buffer.insert("X");
    expect(buffer.text).toBe("abXc");

    expect(buffer.undo()).toBe(true);
    expect(buffer.text).toBe("abc");
    expect(buffer.column).toBe(2);
    expect(buffer.undo()).toBe(true);
    expect(buffer.text).toBe("");
  });

  test("restores selection and cursor around selection deletion", () => {
    const buffer = new TextBuffer("alpha beta");
    buffer.moveWordRight();
    buffer.moveEnd(true);
    expect(buffer.selectionRange).toEqual({
      start: { row: 0, column: 6 },
      end: { row: 0, column: 10 },
    });

    buffer.deleteForward();
    expect(buffer.text).toBe("alpha ");
    expect(buffer.undo()).toBe(true);
    expect(buffer.text).toBe("alpha beta");
    expect(buffer.selectionRange).toEqual({
      start: { row: 0, column: 6 },
      end: { row: 0, column: 10 },
    });

    expect(buffer.redo()).toBe(true);
    expect(buffer.text).toBe("alpha ");
    expect(buffer.selectionRange).toBeNull();
  });

  test("invalidates redo after a divergent edit", () => {
    const buffer = new TextBuffer();
    buffer.insert("a");
    buffer.insert("b");
    expect(buffer.undo()).toBe(true);

    buffer.insert("x");
    expect(buffer.redo()).toBe(false);
    expect(buffer.text).toBe("x");
  });

  test("bounds history to the most recent one hundred edit groups", () => {
    const buffer = new TextBuffer();
    for (let index = 0; index < 101; index += 1) {
      buffer.insert("x");
      buffer.moveHome();
      buffer.moveEnd();
    }

    let undoCount = 0;
    while (buffer.undo()) undoCount += 1;
    expect(undoCount).toBe(100);
    expect(buffer.text).toBe("x");
  });
});
