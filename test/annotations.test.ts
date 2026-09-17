import { describe, expect, test } from "bun:test";
import {
  createTextQuoteAnchor,
  formatAnnotationBlock,
  parseAnnotationBlockContent,
} from "../src/annotations";
import { parseProperties } from "../src/properties";
import type { AnnotationCreateInput, AnnotationTarget, Block } from "../src/types";

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

function annotationTarget(): AnnotationTarget {
  const source = "first\nemoji 🧭 and é\nlast";
  const start = source.indexOf("🧭");
  const end = source.indexOf("\nlast");
  return {
    representation: {
      id: "representation-1",
      subject: {
        kind: "block",
        blockId: "22222222-2222-4222-8222-222222222222",
      },
      sourceSnapshot: {
        kind: "block",
        blockId: "22222222-2222-4222-8222-222222222222",
        updatedAt: "2026-01-01T00:00:00.000Z",
        contentHash: "source-hash",
      },
      adapter: null,
      mediaType: "text/plain",
      contentHash: "representation-hash",
      capturedAt: "2026-01-01T00:00:00.000Z",
    },
    anchor: createTextQuoteAnchor(source, start, end),
  };
}

function annotationInput(body: string, source: AnnotationCreateInput["source"]): AnnotationCreateInput {
  return {
    target: annotationTarget(),
    body,
    source,
  };
}

describe("annotation block content", () => {
  test("round-trips root content and lifecycle state", () => {
    const body = "Keep the grapheme and combining mark exact.\nVerify it before resolving.";
    const text = formatAnnotationBlock(annotationInput(body, "agent"), undefined, {
      lifecycle: "resolved",
      promotedBlockIds: [
        "33333333-3333-4333-8333-333333333333",
        "44444444-4444-4444-8444-444444444444",
      ],
    });

    const content = parseAnnotationBlockContent(annotationBlock(text));

    expect({
      body: content.body,
      source: content.source,
      lifecycle: content.lifecycle,
      promotedBlockIds: content.promotedBlockIds,
      parentAnnotationId: content.parentAnnotationId,
    }).toEqual({
      body,
      source: "agent",
      lifecycle: "resolved",
      promotedBlockIds: [
        "33333333-3333-4333-8333-333333333333",
        "44444444-4444-4444-8444-444444444444",
      ],
      parentAnnotationId: undefined,
    });
  });

  test("round-trips reply membership with an open lifecycle", () => {
    const parentAnnotationId = "55555555-5555-4555-8555-555555555555";
    const text = formatAnnotationBlock(
      annotationInput("A follow-up from the reviewer.", "user"),
      parentAnnotationId,
    );

    const content = parseAnnotationBlockContent(annotationBlock(text));

    expect({
      body: content.body,
      source: content.source,
      lifecycle: content.lifecycle,
      parentAnnotationId: content.parentAnnotationId,
    }).toEqual({
      body: "A follow-up from the reviewer.",
      source: "user",
      lifecycle: "open",
      parentAnnotationId,
    });
  });

  test("rejects unsupported lifecycle state", () => {
    const block = annotationBlock(
      "Comment on “selection”\n[type::annotation] [annotation-source::user] [annotation-status::archived]\nBody",
    );

    expect(() => parseAnnotationBlockContent(block)).toThrow();
  });

  test("rejects unknown source snapshots on new annotations", () => {
    const target = annotationTarget();
    const invalidInput = {
      ...annotationInput("New annotation", "agent"),
      target: {
        ...target,
        representation: {
          ...target.representation,
          sourceSnapshot: {
            kind: "unknown" as const,
            label: "unverified input",
          },
        },
      },
    };
    expect(() => formatAnnotationBlock(invalidInput as unknown as AnnotationCreateInput)).toThrow(
      "Unsupported annotation source snapshot: unknown",
    );
  });
});
