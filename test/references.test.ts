import { describe, expect, test } from "bun:test";
import {
  blockDisplayTitle,
  blockReferenceIds,
  blockReferenceOccurrences,
  resolveBlockReferences,
  resolveBlockReferencesWithStatus,
} from "../src/references";
import { outlinerReferenceOccurrences } from "../src/reference-occurrences";
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
  test("keeps titled reference identity separate from authored presentation", () => {
    const label = "the **decision** | PIE-123";
    const raw = `See ((${target.id}|${label}))`;
    const resolved = resolveBlockReferencesWithStatus(
      raw,
      (id) => id === target.id ? target : null,
    );

    expect(resolved).toEqual({
      text: `See ((${label}))`,
      references: [{
        blockId: target.id,
        label,
        status: "resolved",
        title: "Referenced decision",
      }],
    });
    expect(blockReferenceOccurrences(raw)).toEqual([{
      blockId: target.id,
      label,
      start: 4,
      end: raw.length,
    }]);
    expect(outlinerReferenceOccurrences(raw, "PIE")).toEqual([{
      kind: "block",
      blockId: target.id,
      label,
      start: 4,
      end: raw.length,
    }]);
    for (const invalid of [
      `((${target.id}|))`,
      `((${target.id}|   ))`,
      `((${target.id}|line one\nline two))`,
    ]) {
      expect(blockReferenceOccurrences(invalid)).toEqual([]);
      expect(resolveBlockReferences(invalid, () => target)).toBe(invalid);
    }
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
  test("keeps missing titled references raw and labels deleted targets explicitly", () => {
    const missing = "22222222-2222-4222-8222-222222222222";
    const rawMissing = `((${missing}|still understandable))`;
    expect(resolveBlockReferencesWithStatus(rawMissing, () => null)).toEqual({
      text: rawMissing,
      references: [{
        blockId: missing,
        label: "still understandable",
        status: "missing",
      }],
    });

    const deleted = { ...target, effectiveDeletedRootId: "trash-root" };
    expect(
      resolveBlockReferencesWithStatus(
        `((${target.id}|deleted explanation))`,
        () => deleted,
      ),
    ).toEqual({
      text: "((deleted explanation · Trash))",
      references: [{
        blockId: target.id,
        label: "deleted explanation",
        status: "deleted",
        title: "Referenced decision",
        deletionRootId: "trash-root",
      }],
    });
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
  test("retains titled fragment diagnostics without treating labels as identity", () => {
    const anchored = {
      ...target,
      text: "Referenced decision\n\n## Durable section ^durable-section",
    };
    const resolved = resolveBlockReferencesWithStatus(
      [
        `((${target.id}^durable-section|why this boundary exists))`,
        `((${target.id}^stale-section|stale explanation))`,
      ].join(" "),
      () => anchored,
    );

    expect(resolved.text).toBe(
      "((why this boundary exists)) ((stale explanation · Missing fragment))",
    );
    expect(resolved.references).toEqual([
      {
        blockId: target.id,
        fragmentId: "durable-section",
        label: "why this boundary exists",
        status: "resolved",
        title: "Referenced decision",
      },
      {
        blockId: target.id,
        fragmentId: "stale-section",
        label: "stale explanation",
        status: "stale",
        title: "Referenced decision",
      },
    ]);
  });
});

describe("reference occurrence Markdown protection", () => {
  test("finds nested-list references without exposing multiline indented code", () => {
    const blockId = "22222222-2222-4222-8222-222222222222";
    const text = [
      "- Parent item",
      `    - Nested item ((${blockId}))`,
      `    continuation ((${blockId}))`,
      "",
      "      nested literal code",
      `      ((${blockId}))`,
      "      nested literal tail",
      "Outside paragraph",
      "",
      "    literal code",
      `    ((${blockId}))`,
      "    literal tail",
    ].join("\n");

    expect(outlinerReferenceOccurrences(text)).toEqual([
      expect.objectContaining({ kind: "block", blockId }),
      expect.objectContaining({ kind: "block", blockId }),
    ]);
  });
  test("does not scan nested references in malformed titled envelopes", () => {
    const invalid = `((${target.id}|line one\n[[Page]] PIE-123))`;

    expect(blockReferenceOccurrences(invalid)).toEqual([]);
    expect(resolveBlockReferences(invalid, () => target)).toBe(invalid);
    expect(outlinerReferenceOccurrences(invalid, "PIE")).toEqual([]);
  });

  test("excludes titled references in protected spans without leaking label syntax", () => {
    const visibleId = "23232323-2323-4232-8232-232323232323";
    const hiddenId = "24242424-2424-4242-8242-242424242424";
    const visible = `((${visibleId}|visible **context** PIE-123))`;
    const text = [
      `\`((${hiddenId}|hidden PIE-999))\``,
      "```md",
      `((${hiddenId}|hidden [[Page]]))`,
      "```",
      visible,
    ].join("\n");

    expect(outlinerReferenceOccurrences(text, "PIE")).toEqual([{
      kind: "block",
      blockId: visibleId,
      label: "visible **context** PIE-123",
      start: text.indexOf(visible),
      end: text.indexOf(visible) + visible.length,
    }]);
  });

  test("excludes references inside fences nested through multiple list levels", () => {
    const beforeId = "33333333-3333-4333-8333-333333333333";
    const hiddenId = "44444444-4444-4444-8444-444444444444";
    const afterId = "55555555-5555-4555-8555-555555555555";
    const beforeReference = `((${beforeId}))`;
    const afterReference = `((${afterId}))`;
    const text = [
      `- Parent prose ${beforeReference}`,
      "  - Nested item",
      "    - Deep item",
      "         ```md",
      `      hidden ((${hiddenId}))`,
      `         still hidden ((${hiddenId}))`,
      "        ```",
      `      Adjacent prose ${afterReference}`,
    ].join("\n");

    expect(outlinerReferenceOccurrences(text)).toEqual([
      {
        kind: "block",
        blockId: beforeId,
        start: text.indexOf(beforeReference),
        end: text.indexOf(beforeReference) + beforeReference.length,
      },
      {
        kind: "block",
        blockId: afterId,
        start: text.indexOf(afterReference),
        end: text.indexOf(afterReference) + afterReference.length,
      },
    ]);
  });

  test("protects a nested list item's fenced body until its relative closing fence", () => {
    const hiddenId = "66666666-6666-4666-8666-666666666666";
    const adjacentId = "77777777-7777-4777-8777-777777777777";
    const adjacentReference = `((${adjacentId}))`;
    const text = [
      "- Parent item",
      "  - Nested item",
      "    - ~~~",
      `      hidden ((${hiddenId}))`,
      "        ~~~",
      `    - Adjacent item ${adjacentReference}`,
    ].join("\n");

    expect(outlinerReferenceOccurrences(text)).toEqual([
      {
        kind: "block",
        blockId: adjacentId,
        start: text.indexOf(adjacentReference),
        end: text.indexOf(adjacentReference) + adjacentReference.length,
      },
    ]);
  });

  test("keeps top-level fences protected while emitting following prose references", () => {
    const hiddenId = "88888888-8888-4888-8888-888888888888";
    const visibleId = "99999999-9999-4999-8999-999999999999";
    const visibleReference = `((${visibleId}))`;
    const text = [
      "   ```md",
      `hidden ((${hiddenId}))`,
      " ```",
      `Visible ${visibleReference}`,
    ].join("\n");

    expect(outlinerReferenceOccurrences(text)).toEqual([
      {
        kind: "block",
        blockId: visibleId,
        start: text.indexOf(visibleReference),
        end: text.indexOf(visibleReference) + visibleReference.length,
      },
    ]);
  });

  test("handles CRLF fence endings and blank lines", () => {
    const hiddenId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const visibleId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const visibleReference = `((${visibleId}))`;
    const text = [
      "```md",
      `hidden ((${hiddenId}))`,
      "```",
      "",
      `Visible ${visibleReference}`,
    ].join("\r\n");

    expect(outlinerReferenceOccurrences(text)).toEqual([
      {
        kind: "block",
        blockId: visibleId,
        start: text.indexOf(visibleReference),
        end: text.indexOf(visibleReference) + visibleReference.length,
      },
    ]);
  });
});
