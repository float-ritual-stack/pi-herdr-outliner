import { describe, expect, test } from "bun:test";
import { extractFileAnnotationComment, formatFileAnnotation } from "../src/annotations";
import { parseProperties, stripProperties } from "../src/properties";
import { isDetailToggle, isModifiedEnter, isPrintableInput, TerminalInputDecoder } from "../src/terminal";
import { TextBuffer } from "../src/text-buffer";

describe("TextBuffer", () => {
  test("edits multiline content without flattening it", () => {
    const buffer = new TextBuffer("first\nthird");
    buffer.moveEnd();
    buffer.newline();
    buffer.insert("second");
    buffer.moveDown();
    buffer.moveEnd();
    buffer.insert(" line");

    expect(buffer.text).toBe("first\nsecond\nthird line");
  });

  test("joins adjacent lines when backspacing at column zero", () => {
    const buffer = new TextBuffer("one\ntwo");
    buffer.moveDown();
    buffer.backspace();

    expect(buffer.text).toBe("onetwo");
    expect({ row: buffer.row, column: buffer.column }).toEqual({ row: 0, column: 3 });
  });

  test("replaces an active reference token with a completion", () => {
    const buffer = new TextBuffer("See [[rel");
    buffer.moveEnd();
    buffer.replaceCurrentLine(4, buffer.column, "[[Release Notes]]");

    expect(buffer.text).toBe("See [[Release Notes]]");
    expect(buffer.column).toBe(21);
  });

  test("strips indexed properties from page completion labels", () => {
    expect(stripProperties("Release Notes [type::page] [status::active]")).toBe("Release Notes");
  });
});

describe("terminal input", () => {
  test("accepts text but rejects control and modified-key escape sequences", () => {
    expect(isPrintableInput("hello", { name: "h", sequence: "h" })).toBe(true);
    expect(isModifiedEnter("13~", { sequence: "13~" })).toBe(true);
    expect(isModifiedEnter("", { name: "return", shift: true })).toBe(true);
    expect(isPrintableInput("13~", { sequence: "13~" })).toBe(false);
    expect(isPrintableInput("[13;2u", { sequence: "\x1b[13;2u", shift: true })).toBe(false);
    expect(isPrintableInput("q", { name: "q", ctrl: true, sequence: "\x11" })).toBe(false);
    expect(isDetailToggle(".", { name: ".", ctrl: true })).toBe(true);
    expect(isDetailToggle(".", { name: ".", meta: true })).toBe(true);
    expect(isDetailToggle(".", { name: "." })).toBe(true);
  });

  test("reassembles Herdr's fragmented Shift-Enter sequence", () => {
    const decoder = new TerminalInputDecoder();
    expect(decoder.consume("", { sequence: "\x1b[27;2;" })).toBe("suppress");
    expect(decoder.consume("1", { name: "1", sequence: "1" })).toBe("suppress");
    expect(decoder.consume("3", { name: "3", sequence: "3" })).toBe("suppress");
    expect(decoder.consume("~", { sequence: "~" })).toBe("modified-enter");
    expect(decoder.consume("x", { name: "x", sequence: "x" })).toBe("pass");
  });
});

describe("file annotations", () => {
  test("records source block, file, range, and multiline comment as indexed properties", () => {
    const comment = "This assumption needs evidence.\nCould the agent verify it?";
    const text = formatFileAnnotation({
      sourceBlockId: "block-123",
      filePath: "docs/plan.md",
      startLine: 12,
      endLine: 15,
      comment,
    });

    expect(text).toContain("Comment on docs/plan.md:12-15");
    expect(text).toContain(comment);
    expect(parseProperties(text)).toEqual([
      { key: "type", value: "annotation" },
      { key: "file", value: "docs/plan.md" },
      { key: "line-start", value: "12" },
      { key: "line-end", value: "15" },
      { key: "source-block", value: "block-123" },
    ]);
    expect(extractFileAnnotationComment(text)).toBe(comment);
  });
});
