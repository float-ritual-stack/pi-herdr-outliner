import { describe, expect, test } from "bun:test";
import { blockDisplayTitle, blockReferenceIds, resolveBlockReferences } from "../src/references";
import type { Block } from "../src/types";

const target: Block = {
  id: "11111111-1111-4111-8111-111111111111",
  parentId: null,
  position: 0,
  text: "Referenced decision [type::decision]\nAdditional detail",
  author: "user",
  collapsed: false,
  createdAt: "2026-08-22T00:00:00.000Z",
  updatedAt: "2026-08-22T00:00:00.000Z",
  properties: [{ key: "type", value: "decision" }],
};

describe("block reference rendering", () => {
  test("renders known IDs as readable titles without exposing title properties", () => {
    const text = `See ((${target.id})) for context`;
    const rendered = resolveBlockReferences(text, (id) => (id === target.id ? target : null));

    expect(rendered).toBe("See ((Referenced decision)) for context");
    expect(blockDisplayTitle(target)).toBe("Referenced decision");
  });

  test("chooses a title after whole-block indexed-span stripping", () => {
    const literalTitle = {
      ...target,
      text: "[status::open]\n`[example::literal title]`",
      properties: [{ key: "status", value: "open" }],
    };

    expect(blockDisplayTitle(literalTitle)).toBe("`[example::literal title]`");
  });

  test("preserves fenced property-shaped source in display titles", () => {
    const fenced = {
      ...target,
      text: "[status::open]\n```ts [example::literal]\n```",
      properties: [{ key: "status", value: "open" }],
    };

    expect(blockDisplayTitle(fenced)).toBe("```ts [example::literal]");
  });

  test("keeps unresolved IDs intact so broken references remain diagnosable", () => {
    const missing = "22222222-2222-4222-8222-222222222222";
    const text = `Missing ((${missing}))`;

    expect(resolveBlockReferences(text, () => null)).toBe(text);
    expect(blockReferenceIds(text)).toEqual([missing]);
  });
});
