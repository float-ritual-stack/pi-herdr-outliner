import { expect, test } from "bun:test";
import { parsePropertyTokens, patchPropertyText, validateProperty } from "../src/properties";
import type { PropertyPatchOperation } from "../src/types";

test("records lossless property spans and placement", () => {
  const text = [
    "Title [type::feedback] middle [project::skippy]",
    "[status::open] [owner::evan]",
    "Body [inline::yes] after",
  ].join("\n");
  const tokens = parsePropertyTokens(text);

  expect(tokens.map(({ key, ordinal, line, column, placement }) => ({
    key,
    ordinal,
    line,
    column,
    placement,
  }))).toEqual([
    { key: "type", ordinal: 0, line: 0, column: 6, placement: "inline" },
    { key: "project", ordinal: 1, line: 0, column: 30, placement: "trailing-metadata" },
    { key: "status", ordinal: 2, line: 1, column: 0, placement: "metadata-line" },
    { key: "owner", ordinal: 3, line: 1, column: 15, placement: "metadata-line" },
    { key: "inline", ordinal: 4, line: 2, column: 5, placement: "inline" },
  ]);
  for (const token of tokens) expect(text.slice(token.start, token.end)).toBe(token.raw);
});

test("patches exact tokens and appends to an existing metadata line", () => {
  const text = [
    "Title [type::feedback]",
    "[status::open]",
    "Body [project::skippy] remains",
  ].join("\n");
  const patched = patchPropertyText(text, [
    { op: "replace", ordinal: 0, value: "bug" },
    { op: "remove", ordinal: 2 },
    { op: "append", key: "priority", value: "high" },
    { op: "append", key: "owner", value: "evan" },
  ]);

  expect(patched).toBe([
    "Title [type::bug]",
    "[status::open] [priority::high] [owner::evan]",
    "Body  remains",
  ].join("\n"));
});

test("inserts a new metadata line after the title", () => {
  expect(patchPropertyText("Title\nBody", [{ op: "append", key: "status", value: "open" }])).toBe(
    "Title\n[status::open]\nBody",
  );
  expect(patchPropertyText("Title", [{ op: "append", key: "status", value: "open" }])).toBe(
    "Title\n[status::open]",
  );
});

test("preserves CRLF line endings while appending metadata", () => {
  expect(patchPropertyText("Title\r\n[status::open]\r\nBody", [
    { op: "append", key: "owner", value: "evan" },
  ])).toBe("Title\r\n[status::open] [owner::evan]\r\nBody");
  expect(patchPropertyText("Title\r\nBody", [
    { op: "append", key: "status", value: "open" },
  ])).toBe("Title\r\n[status::open]\r\nBody");
});

test("rejects invalid values and conflicting token edits", () => {
  expect(() => validateProperty("bad key", "value")).toThrow("Invalid property key");
  expect(() => validateProperty("status", "bad]value")).toThrow("cannot contain");
  expect(() => patchPropertyText("[status::open]", [{ op: "remove", ordinal: 9 }])).toThrow(
    "Property token not found",
  );
  expect(() => patchPropertyText("[status::open]", [
    { op: "remove", ordinal: 0 },
    { op: "replace", ordinal: 0, value: "done" },
  ])).toThrow("patched more than once");
  expect(() => patchPropertyText("[status::open]", [
    { op: "bogus", ordinal: 0 } as unknown as PropertyPatchOperation,
  ])).toThrow("Unknown property patch operation");
});
