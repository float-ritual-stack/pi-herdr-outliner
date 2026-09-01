import { expect, test } from "bun:test";
import {
  completionTargetAtCursor,
  completionWindow,
  pageAddressCompletion,
  pageCompletionLookupQuery,
} from "../src/completion";

test("keeps the selected completion inside a fixed-size visible window", () => {
  expect(completionWindow(20, 0, 6)).toEqual({ start: 0, end: 6 });
  expect(completionWindow(20, 5, 6)).toEqual({ start: 2, end: 8 });
  expect(completionWindow(20, 12, 6)).toEqual({ start: 9, end: 15 });
  expect(completionWindow(20, 19, 6)).toEqual({ start: 14, end: 20 });
});

test("clamps empty and oversized completion windows", () => {
  expect(completionWindow(0, 0, 6)).toEqual({ start: 0, end: 0 });
  expect(completionWindow(3, 10, 6)).toEqual({ start: 0, end: 3 });
});

test("finds page, block, and file completion targets at the cursor", () => {
  expect(completionTargetAtCursor("See [[Release No", 16)).toEqual({
    kind: "page",
    start: 4,
    end: 16,
    query: "Release No",
  });
  expect(completionTargetAtCursor("Link ((block-id", 15)).toEqual({
    kind: "block",
    start: 5,
    end: 15,
    query: "block-id",
  });
  expect(completionTargetAtCursor("Open [file::docs/mis", 20)).toEqual({
    kind: "file",
    start: 5,
    end: 20,
    query: "docs/mis",
  });
});
test("normalizes titled Work-ID completion without changing the canonical target", () => {
  const match = {
    address: "PIE-123",
    normalizedAddress: "pie-123",
    blockId: "work-123",
    kind: "work-id" as const,
    title: "PIE-123 — Stable links",
  };
  expect(pageCompletionLookupQuery("some title - PIE-123", "PIE")).toBe("PIE-123");
  expect(pageCompletionLookupQuery("PIE-123|custom", "PIE")).toBe("PIE-123");
  expect(pageAddressCompletion(match, "some title - PIE-123", "PIE")).toEqual({
    label: "PIE-123 — Stable links",
    insertion: "[[PIE-123|some title - PIE-123]]",
  });
  expect(pageAddressCompletion(match, "PIE-12", "PIE").insertion).toBe(
    "[[PIE-123|PIE-123 — Stable links]]",
  );
  expect(pageAddressCompletion(match, "PIE-123|custom label", "PIE").insertion).toBe(
    "[[PIE-123|custom label]]",
  );
});


test("uses the nearest unclosed target on the current line", () => {
  const line = "Closed [[page]] and [file::docs/ with [[nested";
  expect(completionTargetAtCursor(line, line.length)).toEqual({
    kind: "page",
    start: line.lastIndexOf("[["),
    end: line.length,
    query: "nested",
  });
  expect(completionTargetAtCursor("Closed [file::docs/readme.md] text", 34)).toBeNull();
  expect(completionTargetAtCursor("[[page]] then ((block", 21)).toEqual({
    kind: "block",
    start: 14,
    end: 21,
    query: "block",
  });
});
