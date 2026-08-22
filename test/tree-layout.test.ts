import { describe, expect, test } from "bun:test";
import { layoutExpandedBlock, type TreeLayoutRow } from "../src/tree-layout";

function rendered(row: TreeLayoutRow): string {
  return `${row.prefix}${row.text}${row.suffix}`;
}

describe("layoutExpandedBlock", () => {
  test("wraps on word boundaries while accounting for tree decorations", () => {
    const rows = layoutExpandedBlock({
      text: "alpha beta gamma",
      width: 14,
      depth: 0,
      marker: "▾",
      author: "A",
    });

    expect(rows.map((row) => row.text)).toEqual(["alpha", "beta gamma"]);
    expect(rows[0]).toEqual({ prefix: "▾ ", text: "alpha", suffix: "  A" });
    expect(rows[1]).toEqual({ prefix: "  │ ", text: "beta gamma", suffix: "" });
    expect(rows.every((row) => rendered(row).length <= 14)).toBe(true);
  });

  test("keeps short single-line detail on one row", () => {
    const rows = layoutExpandedBlock({
      text: "short",
      width: 30,
      depth: 1,
      marker: "•",
      author: "A",
    });

    expect(rows).toEqual([{ prefix: "  • ", text: "short", suffix: "  A" }]);
  });

  test("preserves explicit blank and trailing lines", () => {
    const rows = layoutExpandedBlock({
      text: "first\n\nlast\n",
      width: 30,
      depth: 1,
      marker: "•",
      author: " ",
    });

    expect(rows.map((row) => row.text)).toEqual(["first", "", "last", ""]);
    expect(rows.map((row) => row.prefix)).toEqual(["  • ", "    │ ", "    │ ", "    │ "]);
  });

  test("hard-splits long tokens using each row's available width", () => {
    const rows = layoutExpandedBlock({
      text: "abcdefghijk",
      width: 8,
      depth: 0,
      marker: "▾",
      author: "A",
    });

    expect(rows.map((row) => row.text)).toEqual(["abc", "defg", "hijk"]);
    expect(rows.every((row) => rendered(row).length <= 8)).toBe(true);
  });

  test("always advances at widths narrower than the tree decorations", () => {
    const rows = layoutExpandedBlock({
      text: "long",
      width: 1,
      depth: 4,
      marker: "▾",
      author: "A",
    });

    expect(rows.map(rendered)).toEqual(["l", "o", "n", "g"]);
  });

  test("retains indentation, marker, and author suffix when they fit", () => {
    const rows = layoutExpandedBlock({
      text: "first line\nsecond line",
      width: 30,
      depth: 2,
      marker: "▸",
      author: "S",
    });

    expect(rows[0]).toEqual({ prefix: "    ▸ ", text: "first line", suffix: "  S" });
    expect(rows[1]).toEqual({ prefix: "      │ ", text: "second line", suffix: "" });
  });
});
