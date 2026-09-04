import { describe, expect, test } from "bun:test";
import {
  BlockQuerySyntaxError,
  filterCompletionTargetAtCursor,
  MAX_BLOCK_QUERY_LIMIT,
  normalizeBlockSearchQuery,
  parsePropertyFilterClause,
  parsePropertyFilterExpression,
  serializePropertyFilters,
} from "../src/block-query";

describe("property filter expressions", () => {
  test("parses equality, presence, quoted values, and double-colon input", () => {
    expect(
      parsePropertyFilterExpression(
        'status="in progress" project::pi-outliner priority',
      ),
    ).toEqual([
      { key: "status", value: "in progress" },
      { key: "project", value: "pi-outliner" },
      { key: "priority" },
    ]);
  });

  test("normalizes clauses passed as separate CLI arguments without splitting spaces", () => {
    expect(parsePropertyFilterClause(" STATUS = in progress ")).toEqual({
      key: "status",
      value: "in progress",
    });
  });

  test("round-trips canonical quoted values and escapes", () => {
    const filters = [
      { key: "status", value: "in progress" },
      { key: "quote", value: 'say "hello" \\ again' },
      { key: "priority" },
    ];
    const serialized = serializePropertyFilters(filters);
    expect(serialized).toBe(
      'status="in progress" quote="say \\"hello\\" \\\\ again" priority',
    );
    expect(parsePropertyFilterExpression(serialized)).toEqual(filters);
  });

  test("rejects malformed or unsupported expressions with positions", () => {
    for (const expression of [
      'status="in progress',
      "status=",
      "OR status=open",
      "status>open",
      'status="open"junk',
      'status="bad\\nescape"',
    ]) {
      expect(() => parsePropertyFilterExpression(expression)).toThrow(
        BlockQuerySyntaxError,
      );
      expect(() => parsePropertyFilterExpression(expression)).toThrow(
        /character \d+/,
      );
    }
  });
});

describe("block query normalization", () => {
  test("normalizes keys, values, duplicate clauses, text, and deleted compatibility", () => {
    expect(
      normalizeBlockSearchQuery({
        filters: [
          { key: " STATUS ", value: " in progress " },
          { key: "status", value: "IN PROGRESS" },
          { key: "priority" },
          { key: "deleted", value: "true" },
        ],
        text: "  route snapshot  ",
        subtreeRootId: " root-id ",
        limit: 20,
      }),
    ).toEqual({
      filters: [{ key: "status", value: "in progress" }, { key: "priority" }],
      text: "route snapshot",
      subtreeRootId: "root-id",
      includeDeleted: "roots",
      limit: 20,
    });
  });

  test("normalizes timestamp sorting and rejects rank conflicts", () => {
    expect(normalizeBlockSearchQuery({
      filters: [{ key: "status", value: "done" }],
      sort: { field: "updated", direction: "desc" },
      limit: 20,
    })).toEqual({
      filters: [{ key: "status", value: "done" }],
      sort: { field: "updated", direction: "desc" },
      limit: 20,
    });
    expect(() => normalizeBlockSearchQuery({
      rankViewId: "view",
      sort: { field: "created", direction: "asc" },
      limit: 20,
    })).toThrow("Block search cannot combine rankViewId with timestamp sorting");
  });

  test("rejects invalid limits rather than clamping", () => {
    for (const limit of [0, -1, 1.5, Number.NaN, MAX_BLOCK_QUERY_LIMIT + 1]) {
      expect(() => normalizeBlockSearchQuery({ limit })).toThrow(
        `Block search limit must be an integer from 1 through ${MAX_BLOCK_QUERY_LIMIT}`,
      );
    }
  });

  test("rejects empty values and invalid property keys", () => {
    expect(() =>
      normalizeBlockSearchQuery({
        filters: [{ key: "status", value: " " }],
        limit: 20,
      }),
    ).toThrow("Property filter value cannot be empty");
    expect(() =>
      normalizeBlockSearchQuery({
        filters: [{ key: "bad key", value: "open" }],
        limit: 20,
      }),
    ).toThrow("Invalid property key");
  });

  test("rejects malformed protocol payload shapes explicitly", () => {
    expect(() =>
      normalizeBlockSearchQuery({
        filters: {} as never,
        limit: 20,
      }),
    ).toThrow("Block search filters must be an array");
    expect(() =>
      normalizeBlockSearchQuery({
        filters: [{ key: "status", value: 3 as never }],
        limit: 20,
      }),
    ).toThrow("Block search filter 1 value must be a string");
    expect(() =>
      normalizeBlockSearchQuery({
        text: 42 as never,
        limit: 20,
      }),
    ).toThrow("Block search text must be a string");
  });

  test("rejects malformed timestamp sort payloads explicitly", () => {
    expect(() => normalizeBlockSearchQuery({
      sort: "updated" as never,
      limit: 20,
    })).toThrow("Block search sort must be an object");
    expect(() => normalizeBlockSearchQuery({
      sort: { field: "title", direction: "desc" } as never,
      limit: 20,
    })).toThrow("Block search sort field must be created or updated");
    expect(() => normalizeBlockSearchQuery({
      sort: { field: "updated", direction: "newest" } as never,
      limit: 20,
    })).toThrow("Block search sort direction must be asc or desc");
  });
});

describe("filter completion targeting", () => {
  test("identifies key and value prefixes with replacement ranges", () => {
    expect(filterCompletionTargetAtCursor("sta", 3)).toEqual({
      kind: "key",
      start: 0,
      end: 3,
      prefix: "sta",
    });
    expect(
      filterCompletionTargetAtCursor('type=note status="in pr', 23),
    ).toEqual({
      kind: "value",
      start: 10,
      end: 23,
      key: "status",
      prefix: "in pr",
    });
  });
});
