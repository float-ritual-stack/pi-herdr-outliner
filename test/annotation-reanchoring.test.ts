import { describe, expect, test } from "bun:test";
import { reanchorAnnotationTarget } from "../src/annotation-reanchoring";
import {
  annotationSourceHash,
  createPdfPageRegionAnchor,
  createTextQuoteAnchor,
} from "../src/annotations";
import type { AnnotationRepresentation, AnnotationTarget } from "../src/types";

function representation(id: string, content: string): AnnotationRepresentation {
  return {
    id,
    subject: { kind: "resource", resourceId: "resource-1" },
    sourceSnapshot: {
      kind: "resource",
      resourceId: "resource-1",
      sourceSnapshotId: `snapshot-${id}`,
      revision: null,
    },
    adapter: { id: "web.markdown", version: 1 },
    mediaType: "text/markdown",
    contentHash: annotationSourceHash(content),
    capturedAt: "2026-01-01T00:00:00.000Z",
  };
}

function target(content: string, selected: string): AnnotationTarget {
  const start = content.indexOf(selected);
  return {
    representation: representation("old", content),
    anchor: createTextQuoteAnchor(content, start, start + selected.length),
  };
}

function reconcile(oldContent: string, selected: string, newContent: string) {
  return reanchorAnnotationTarget(
    target(oldContent, selected),
    representation("new", newContent),
    newContent,
  );
}

describe("deterministic annotation reanchoring", () => {
  test("stops at the first reliable deterministic pass", () => {
    const content = "Intro\nStable passage\nOutro";
    const original = target(content, "Stable passage");
    const unchanged = reanchorAnnotationTarget(
      original,
      representation("new", content),
      content,
    );
    expect(unchanged).toMatchObject({
      status: "resolved",
      confidence: 1,
      method: { method: "unchanged-representation" },
    });

    const shifted = reconcile(content, "Stable passage", `Preface\n${content}`);
    expect(shifted).toMatchObject({
      status: "resolved",
      confidence: 1,
      method: { method: "unique-exact-quote" },
      resolvedTarget: { anchor: { start: 14, exact: "Stable passage" } },
    });
  });

  test("uses provider identity and verifies text structural replay", () => {
    const oldRepresentation = representation("old", "old");
    const native = reanchorAnnotationTarget({
      representation: oldRepresentation,
      anchor: { kind: "provider-comment-id", provider: "linear", commentId: "comment-7" },
    }, representation("new", "changed"), null);
    expect(native).toMatchObject({
      status: "resolved",
      method: { codecId: "provider-native", method: "stable-comment-id" },
      resolvedTarget: { anchor: { commentId: "comment-7" } },
    });

    const content = "alpha selected omega";
    const replayed = reconcile(content, "selected", content.replace("alpha", "bravo"));
    expect(replayed).toMatchObject({
      status: "resolved",
      method: { method: "structural-replay" },
      resolvedTarget: { anchor: { start: 6, exact: "selected" } },
    });
  });

  test("ranks duplicate exact quotes by captured context", () => {
    const original = "Intro alpha target omega Outro";
    const changed = "Noise target elsewhere\nIntro alpha target omega Outro";
    const contextual = reconcile(original, "target", changed);
    expect(contextual).toMatchObject({
      status: "resolved",
      method: { method: "quote-context" },
      resolvedTarget: { anchor: { start: 35, exact: "target" } },
    });
    expect(contextual.candidates).toHaveLength(2);
    expect(contextual.candidates[0]!.confidence).toBeGreaterThan(
      contextual.candidates[1]!.confidence,
    );

    const ambiguous = reconcile(
      "alpha target omega",
      "target",
      "x\nalpha target omega\nalpha target omega",
    );
    expect(ambiguous.status).toBe("ambiguous");
    expect(ambiguous.confidence).toBeNull();
    expect(ambiguous.candidates.map(({ confidence }) => confidence)).toEqual([1, 1]);
  });

  test("separates automatic, probable, unresolved, and orphaned fuzzy outcomes", () => {
    const oldContent = "Intro\nThe system stores durable annotation evidence\nOutro";
    const high = reconcile(
      oldContent,
      "The system stores durable annotation evidence",
      "Intro changed\nThe system preserves durable annotation evidence\nOutro changed",
    );
    expect(high).toMatchObject({ status: "resolved", method: { method: "local-fuzzy" } });
    expect(high.confidence).toBeGreaterThanOrEqual(0.8);

    const medium = reconcile(
      oldContent,
      "The system stores durable annotation evidence",
      "Intro changed\nThe system retains durable annotation records\nOutro changed",
    );
    expect(medium).toMatchObject({ status: "probable", resolvedTarget: null });
    expect(medium.confidence).toBeGreaterThanOrEqual(0.65);
    expect(medium.confidence).toBeLessThan(0.9);
    expect(medium.candidates[0]!.target.anchor).toMatchObject({
      kind: "text-quote",
      exact: "The system retains durable annotation records",
    });

    const low = reconcile(
      oldContent,
      "The system stores durable annotation evidence",
      "Intro changed\nAnnotation evidence remains available\nOutro changed",
    );
    expect(low).toMatchObject({ status: "unresolved", resolvedTarget: null });
    expect(low.confidence).toBeGreaterThanOrEqual(0.25);
    expect(low.confidence).toBeLessThan(0.65);

    const orphaned = reconcile(
      oldContent,
      "The system stores durable annotation evidence",
      "Completely unrelated replacement.",
    );
    expect(orphaned).toMatchObject({
      status: "orphaned",
      confidence: null,
      candidates: [],
    });
  });

  test("normalizes PDF candidates without page regions to unscored unresolved results", () => {
    const oldContent = "Intro\nThe system stores durable annotation evidence\nOutro";
    const selected = "The system stores durable annotation evidence";
    const start = oldContent.indexOf(selected);
    const region = { x: 10, y: 10, width: 200, height: 20 };
    const original: AnnotationTarget = {
      representation: representation("old", oldContent),
      anchor: createPdfPageRegionAnchor(
        oldContent, start, start + selected.length, 1, [region],
      ),
    };
    for (const [newContent, status] of [
      ["Intro changed\nThe system retains durable annotation records\nOutro changed", "probable"],
      ["Intro changed\nAnnotation evidence remains available\nOutro changed", "unresolved"],
    ] as const) {
      const textResult = reconcile(oldContent, selected, newContent);
      expect(textResult.status).toBe(status);
      expect(textResult.confidence).not.toBeNull();
      expect(textResult.candidates.length).toBeGreaterThan(0);
      const page = { page: 1, width: 300, height: 400, start: 0, end: newContent.length };
      const result = reanchorAnnotationTarget(
        original,
        representation("new", newContent),
        newContent,
        [{ ...page, spans: [] }],
      );
      expect(result).toMatchObject({
        resolvedTarget: null,
        status: "unresolved",
        confidence: null,
        candidates: [],
        method: { codecId: "pdf-page-region", method: "page-region-unavailable" },
      });

      const mapped = reanchorAnnotationTarget(
        original,
        representation("new", newContent),
        newContent,
        [{ ...page, spans: [{ start: 0, end: newContent.length, region }] }],
      );
      expect(mapped.status).toBe(textResult.status);
      expect(mapped.confidence).toBe(textResult.confidence);
      expect(mapped.candidates).toHaveLength(textResult.candidates.length);
      expect(mapped.candidates.every(({ target }) =>
        target.anchor.kind === "pdf-page-region"
      )).toBe(true);
    }
  });

  test("centers bounded fuzzy search and reports incomplete misses as unresolved", () => {
    const prefix = "zzzz\n".repeat(512);
    const selected = "The system stores durable annotation evidence";
    const centered = reconcile(
      `${prefix}${selected}`,
      selected,
      `${prefix}The system preserves durable annotation evidence`,
    );
    expect(centered).toMatchObject({
      status: "resolved",
      method: { method: "local-fuzzy" },
    });

    const longOriginal = `${"alpha ".repeat(100)}${"beta ".repeat(10_000)}`;
    const longReplacement = `${"alpha ".repeat(100)}${"gamma ".repeat(10_000)}`;
    const incomplete = reconcile(longOriginal, longOriginal, longReplacement);
    expect(incomplete).toMatchObject({
      status: "unresolved",
      resolvedTarget: null,
      confidence: null,
      candidates: [],
    });
  });

  test("retains only the bounded best duplicate exact candidates", () => {
    const bounded = reconcile("ba", "a", `bb${"a".repeat(20_000)}`);
    expect(bounded).toMatchObject({ status: "resolved", method: { method: "quote-context" } });
    expect(bounded.candidates).toHaveLength(8);
    expect(bounded.candidates.every(({ target }) =>
      target.anchor.kind === "text-quote" && target.anchor.exact === "a"
    )).toBe(true);
  });
});
