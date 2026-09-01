import { expect, test } from "bun:test";
import {
  ensureHeadingFragment,
  fragmentAnchors,
  fragmentCandidates,
  parseFragmentCompletionQuery,
  resolveFragment,
  resolveFragmentSlice,
  stripFragmentAnchors,
} from "../src/fragments";

const document = [
  "# Stable fragments",
  "",
  "## Durable heading ^durable-heading",
  "Heading content.",
  "",
  "A paragraph that spans",
  "two lines. ^paragraph-note",
  "",
  "## Heading without an anchor",
].join("\n");

test("parses heading and paragraph anchors without changing authored text", () => {
  expect(fragmentAnchors(document)).toEqual([
    {
      id: "durable-heading",
      kind: "heading",
      label: "Durable heading",
      lineIndex: 2,
      markerStart: document.indexOf(" ^durable-heading"),
    },
    {
      id: "paragraph-note",
      kind: "paragraph",
      label: "A paragraph that spans two lines.",
      lineIndex: 6,
      markerStart: document.indexOf(" ^paragraph-note"),
    },
  ]);
  expect(stripFragmentAnchors(document)).toBe(document
    .replace(" ^durable-heading", "")
    .replace(" ^paragraph-note", ""));
});

test("resolves missing and duplicate anchors explicitly", () => {
  expect(resolveFragment(document, "durable-heading")).toMatchObject({
    status: "resolved",
    anchor: { lineIndex: 2, kind: "heading" },
  });
  expect(resolveFragment(document, "missing-anchor")).toEqual({ status: "missing" });
  expect(resolveFragment(`${document}\nDuplicate ^durable-heading`, "durable-heading")).toMatchObject({
    status: "duplicate",
    anchors: [{ lineIndex: 2 }, { lineIndex: 9 }],
  });
});

test("resolves deterministic heading-section and paragraph slices", () => {
  const sliced = [
    "# Document",
    "",
    "## Chosen ^chosen",
    "Chosen body.",
    "",
    "### Nested",
    "Nested body. ^nested-note",
    "",
    "## Next",
    "Next body.",
  ].join("\n");

  expect(resolveFragmentSlice(sliced, "chosen")).toEqual({
    status: "resolved",
    slice: {
      anchor: expect.objectContaining({ id: "chosen", lineIndex: 2 }),
      text: "## Chosen\nChosen body.\n\n### Nested\nNested body.",
      startLine: 2,
      endLine: 7,
    },
  });
  expect(resolveFragmentSlice(sliced, "nested-note")).toEqual({
    status: "resolved",
    slice: {
      anchor: expect.objectContaining({ id: "nested-note", lineIndex: 6 }),
      text: "Nested body.",
      startLine: 6,
      endLine: 6,
    },
  });
  expect(resolveFragmentSlice(sliced, "missing")).toEqual({ status: "missing" });
});

test("offers headings and anchored chunks while exact-id mode excludes unanchored headings", () => {
  expect(fragmentCandidates(document, "heading").map((candidate) => ({
    label: candidate.label,
    fragmentId: candidate.fragmentId,
  }))).toEqual([
    { label: "Durable heading", fragmentId: "durable-heading" },
    { label: "Heading without an anchor", fragmentId: undefined },
  ]);
  expect(fragmentCandidates(document, "paragraph", "id")).toEqual([{
    kind: "paragraph",
    label: "A paragraph that spans two lines.",
    lineIndex: 6,
    fragmentId: "paragraph-note",
  }]);
});

test("creates a stable unique heading anchor only when explicitly requested", () => {
  const first = ensureHeadingFragment(document, 8);
  expect(first).toEqual({
    text: `${document} ^heading-without-an-anchor`,
    fragmentId: "heading-without-an-anchor",
    created: true,
  });
  expect(ensureHeadingFragment(first.text, 8)).toEqual({
    text: first.text,
    fragmentId: first.fragmentId,
    created: false,
  });

  const duplicateHeading = `${document}\n\n## Durable heading`;
  expect(ensureHeadingFragment(duplicateHeading, 10)).toMatchObject({
    fragmentId: "durable-heading-2",
    created: true,
  });
});

test("creates alphanumeric IDs without changing authored line separators", () => {
  const source = "# First\r\n\r\n## _Private\nTail\r\n";
  const created = ensureHeadingFragment(source, 2);

  expect(created.fragmentId).toBe("private");
  expect(created.text).toBe("# First\r\n\r\n## _Private ^private\nTail\r\n");
  expect(fragmentAnchors(created.text)[0]?.markerStart).toBe(
    created.text.indexOf(" ^private"),
  );
});

test("parses heading-search and durable fragment completion queries", () => {
  expect(parseFragmentCompletionQuery("roadmap#decision")).toEqual({
    blockQuery: "roadmap",
    fragmentQuery: "decision",
    mode: "heading",
  });
  expect(parseFragmentCompletionQuery("block-id^durable")).toEqual({
    blockQuery: "block-id",
    fragmentQuery: "durable",
    mode: "id",
  });
  expect(parseFragmentCompletionQuery("ordinary block")).toBeNull();
});
