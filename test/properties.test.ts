import { expect, test } from "bun:test";
import {
  parsePropertyTokens,
  patchPropertyText,
  stripProperties,
  stripPropertyTokens,
  validateProperty,
} from "../src/properties";
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

test("ignores fenced code while indexing properties after a closing fence", () => {
  const text = [
    "```ts",
    "[fake::backtick]",
    "````",
    "[real::after-backtick]",
    "  ~~~ language",
    "[fake::tilde]",
    "  ~~~",
    "[also-real::after-tilde]",
    "    [indented::eligible]",
  ].join("\n");

  expect(parsePropertyTokens(text).map(({ key, value }) => ({ key, value }))).toEqual([
    { key: "real", value: "after-backtick" },
    { key: "also-real", value: "after-tilde" },
    { key: "indented", value: "eligible" },
  ]);
});

test("treats an unclosed fence as literal through the end of the block", () => {
  expect(parsePropertyTokens("Title [real::yes]\n~~~js\n[fake::no]\n[still-fake::no]")).toEqual([
    expect.objectContaining({ key: "real", ordinal: 0 }),
  ]);
});

test("ignores equal-length inline code spans, including spans crossing lines", () => {
  const text = [
    "`[fake::single]` [first::real]",
    "``[fake::cross]",
    "still literal`` [second::real]",
    "`[fake::unmatched]",
    "[third::real]",
  ].join("\n");

  expect(parsePropertyTokens(text).map(({ key, ordinal, line }) => ({ key, ordinal, line }))).toEqual([
    { key: "first", ordinal: 0, line: 0 },
    { key: "second", ordinal: 1, line: 2 },
    { key: "third", ordinal: 2, line: 4 },
  ]);
});

test("uses odd and even backslash parity for escaped property openers", () => {
  const text = String.raw`\[odd::no] \\[even::yes] \\\[odd-three::no] \\\\[even-four::yes]`;
  expect(parsePropertyTokens(text).map(({ key }) => key)).toEqual(["even", "even-four"]);
});

test("preserves UTF-16 CRLF offsets and exact spans beside inline literals", () => {
  const text = "😀\r\n`[fake::x]`[real::yes]\r\n[second::ok]";
  const tokens = parsePropertyTokens(text);

  expect(tokens.map(({ key, ordinal, line, column, start, end, placement }) => ({
    key,
    ordinal,
    line,
    column,
    start,
    end,
    placement,
  }))).toEqual([
    {
      key: "real",
      ordinal: 0,
      line: 1,
      column: 11,
      start: text.indexOf("[real::yes]"),
      end: text.indexOf("[real::yes]") + "[real::yes]".length,
      placement: "trailing-metadata",
    },
    {
      key: "second",
      ordinal: 1,
      line: 2,
      column: 0,
      start: text.indexOf("[second::ok]"),
      end: text.indexOf("[second::ok]") + "[second::ok]".length,
      placement: "metadata-line",
    },
  ]);
  for (const token of tokens) expect(text.slice(token.start, token.end)).toBe(token.raw);
});

test("strips only indexed spans while preserving literals and line structure", () => {
  const text = [
    "Title [status::open]",
    "```",
    "[example::literal]",
    "```",
    "[owner::evan]",
  ].join("\r\n");

  expect(stripPropertyTokens(text)).toBe(
    ["Title ", "```", "[example::literal]", "```", ""].join("\r\n"),
  );
  expect(stripProperties("Title `[example::literal]` [status::open]")).toBe(
    "Title `[example::literal]`",
  );
});

test("patch ordinals exclude literal tokens and preserve exact adjacent source", () => {
  const text = "`[literal::one]`[status::open] [owner::evan]";
  expect(patchPropertyText(text, [
    { op: "replace", ordinal: 0, value: "done" },
    { op: "remove", ordinal: 1 },
  ])).toBe("`[literal::one]`[status::done] ");
});

test("appends to eligible metadata instead of property-shaped literals", () => {
  const text = "Title\n`[fake::literal]`\n[status::open]\nBody";
  expect(patchPropertyText(text, [{ op: "append", key: "owner", value: "evan" }])).toBe(
    "Title\n`[fake::literal]`\n[status::open] [owner::evan]\nBody",
  );
});

test("inserts metadata before a code-only first-line fence", () => {
  const text = "```ts\r\n[example::literal]\r\n```";
  expect(patchPropertyText(text, [{ op: "append", key: "status", value: "open" }])).toBe(
    "[status::open]\r\n```ts\r\n[example::literal]\r\n```",
  );
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
