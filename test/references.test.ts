import { describe, expect, test } from "bun:test";
import {
  blockDisplayTitle,
  blockReferenceIds,
  blockReferenceOccurrences,
  resolveBlockReferences,
  resolveBlockReferencesWithStatus,
} from "../src/references";
import type { Block } from "../src/types";

const target: Block = {
  id: "11111111-1111-4111-8111-111111111111",
  parentId: null,
  position: 0,
  text: "Referenced decision [type::decision]\nAdditional detail",
  author: "user",
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

  test("resolves durable fragments and reports stale or duplicate anchors explicitly", () => {
    const anchored = {
      ...target,
      text: "Referenced decision\n\n## Durable section ^durable-section",
    };
    const text = [
      `((${target.id}^durable-section))`,
      `((${target.id}^stale-section))`,
    ].join(" ");

    expect(resolveBlockReferencesWithStatus(text, () => anchored)).toEqual({
      text: [
        "((Referenced decision^durable-section))",
        "((Referenced decision^stale-section · Missing fragment))",
      ].join(" "),
      references: [
        {
          blockId: target.id,
          fragmentId: "durable-section",
          status: "resolved",
          title: "Referenced decision",
        },
        {
          blockId: target.id,
          fragmentId: "stale-section",
          status: "stale",
          title: "Referenced decision",
        },
      ],
    });
    expect(blockReferenceOccurrences(text)).toEqual([
      {
        blockId: target.id,
        fragmentId: "durable-section",
        start: 0,
        end: target.id.length + "((^durable-section))".length,
      },
      {
        blockId: target.id,
        fragmentId: "stale-section",
        start: target.id.length + "((^durable-section)) ".length,
        end: text.length,
      },
    ]);

    const duplicate = {
      ...anchored,
      text: `${anchored.text}\nDuplicate ^durable-section`,
    };
    expect(resolveBlockReferencesWithStatus(
      `((${target.id}^durable-section))`,
      () => duplicate,
    ).references[0]?.status).toBe("duplicate");
  });
});
