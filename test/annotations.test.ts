import { describe, expect, test } from "bun:test";
import {
  annotationOffsetsForLineRange,
  createAnnotationAnchor,
  formatAnnotation,
  parseAnnotationBlock,
  reanchorAnnotation,
} from "../src/annotations";
import { parseProperties } from "../src/properties";
import type { Block } from "../src/types";

function annotationBlock(text: string): Block {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    parentId: "22222222-2222-4222-8222-222222222222",
    position: 0,
    text,
    author: "agent",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    properties: parseProperties(text),
  };
}

describe("durable annotation anchors", () => {
  test("round-trips multiline Unicode block ranges in UTF-16 units", () => {
    const source = "first\nemoji 🧭 and é\nlast";
    const start = source.indexOf("🧭");
    const end = source.indexOf("\nlast");
    const anchor = createAnnotationAnchor(source, start, end, "block-version-1");
    const text = formatAnnotation({
      target: {
        kind: "block",
        sourceBlockId: "22222222-2222-4222-8222-222222222222",
        anchor,
      },
      body: "Keep the grapheme and combining mark exact.",
      source: "agent",
    });

    expect(text.split("\n")[0]).toBe("Comment on “🧭 and é”");
    expect(text.split("\n")[0]).not.toContain("22222222-2222-4222-8222-222222222222");

    const parsed = parseAnnotationBlock(annotationBlock(text));
    expect(parsed.target.kind).toBe("block");
    expect(parsed.target.anchor).toEqual(anchor);
    expect(parsed.target.anchor.end - parsed.target.anchor.start).toBe(anchor.excerpt.length);
    expect(parsed.body).toBe("Keep the grapheme and combining mark exact.");
  });

  test("computes exact CRLF file offsets without including delimiters", () => {
    const source = "one\r\ntwo α\r\nthree\r\n";
    const range = annotationOffsetsForLineRange(source, 2, 3);
    expect(source.slice(range.start, range.end)).toBe("two α\r\nthree");
  });

  test("keeps offsets when the excerpt is unchanged at its original location", () => {
    const source = "prefix target suffix";
    const anchor = createAnnotationAnchor(source, 7, 13, "v1");
    const result = reanchorAnnotation(anchor, source, "v2");
    expect(result.state).toBe("anchored");
    expect(result.anchor.start).toBe(7);
    expect(result.anchor.sourceVersion).toBe("v2");
  });

  test("reanchors uniquely after text is inserted before the range", () => {
    const source = "prefix target suffix";
    const anchor = createAnnotationAnchor(source, 7, 13, "v1");
    const current = "new " + source;
    const result = reanchorAnnotation(anchor, current, "v2");
    expect(result.state).toBe("anchored");
    expect(result.anchor.start).toBe(11);
    expect(result.anchor.excerpt).toBe("target");
  });

  test("uses captured context to distinguish repeated excerpts", () => {
    const source = "left-A target right-A | left-B target right-B";
    const start = source.lastIndexOf("target");
    const anchor = createAnnotationAnchor(source, start, start + 6, "v1", undefined, 8);
    const current = "left-B target right-B | left-A target right-A";
    const result = reanchorAnnotation(anchor, current, "v2");
    expect(result.state).toBe("anchored");
    expect(current.slice(result.anchor.start, result.anchor.end)).toBe("target");
    expect(current.slice(result.anchor.end, result.anchor.end + 8)).toBe(" right-B");
  });

  test("reports ambiguity and orphaning instead of guessing", () => {
    const repeated = "x target y x target y";
    const anchor = createAnnotationAnchor(repeated, 2, 8, "v1", undefined, 1);
    const moved = reanchorAnnotation(anchor, "zz target q zz target q", "v2");
    expect(moved.state).toBe("ambiguous");
    expect(reanchorAnnotation(anchor, "gone", "v3").state).toBe("orphaned");
  });
});
