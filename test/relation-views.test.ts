import { expect, test } from "bun:test";
import { parseProperties } from "../src/properties";
import {
  isRelationViewDefinition,
  parseRelationViewConfig,
} from "../src/relation-views";
import type { Block } from "../src/types";

function block(text: string): Block {
  return {
    id: "relation-view",
    parentId: null,
    position: 0,
    text,
    author: "user",
    createdAt: "created",
    updatedAt: "updated",
    properties: parseProperties(text),
  };
}

test("parses bounded explicit relation-view configuration", () => {
  const definition = block([
    "Dependencies [type::relation-view]",
    "[source::source-block]",
    "[relations::depends-on, related-to, depends-on]",
    "[fragment::description]",
    "[fragment::research]",
    "[order::target-id]",
    "[limit::12]",
  ].join("\n"));

  expect(isRelationViewDefinition(definition)).toBe(true);
  expect(parseRelationViewConfig(definition)).toEqual({
    config: {
      source: { kind: "block", blockId: "source-block" },
      relationKeys: ["depends-on", "related-to"],
      fragmentIds: ["description", "research"],
      order: "target-id",
      limit: 12,
    },
    errors: [],
  });
});

test("supports embedding-source and rejects unbounded or ambiguous definitions", () => {
  expect(parseRelationViewConfig(block(
    "Relations [type::relation-view] [source::embedding-source] [relations::depends-on]",
  ))).toMatchObject({
    config: {
      source: { kind: "embedding-source" },
      order: "source",
      limit: 10,
    },
  });

  const invalid = parseRelationViewConfig(block([
    "Invalid [type::relation-view]",
    "[source::bad id]",
    "[relations::depends-on, bad key]",
    "[fragment::bad fragment]",
    "[order::title]",
    "[limit::100]",
  ].join("\n")));
  expect(invalid.config).toBeNull();
  expect(invalid.errors).toEqual([
    "Invalid relation view source: bad id",
    "Invalid relation key: bad key",
    "Invalid relation fragment ID: bad fragment",
    "Relation view order must be source or target-id: title",
    "Relation view limit must be an integer from 1 through 25",
  ]);

  const ambiguousType = block(
    "Relations [type::relation-view] [type::relation-view] [source::embedding-source] [relations::depends-on]",
  );
  expect(isRelationViewDefinition(ambiguousType)).toBe(true);
  expect(parseRelationViewConfig(ambiguousType).errors).toContain(
    "Relation view must have exactly one [type::relation-view] property",
  );
});
