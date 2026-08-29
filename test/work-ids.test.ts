import { expect, test } from "bun:test";
import {
  containsWorkIdPlaceholder,
  formatWorkId,
  formatWorkIdPlaceholder,
  isCanonicalWorkId,
  isConfiguredWorkIdPlaceholder,
  normalizeWorkIdPrefix,
  parseWorkId,
  workIdReferences,
} from "../src/work-ids";

test("normalizes project prefixes and formats monotonic Work IDs", () => {
  expect(normalizeWorkIdPrefix(" pie ")).toBe("PIE");
  expect(formatWorkId("pie", 1)).toBe("PIE-001");
  expect(formatWorkId("PIE", 1_000)).toBe("PIE-1000");
  expect(() => normalizeWorkIdPrefix("bad-prefix")).toThrow("1-16 ASCII");
  expect(() => formatWorkId("PIE", 0)).toThrow("positive safe integer");
});

test("recognizes only the configured canonical placeholder token", () => {
  expect(formatWorkIdPlaceholder("pie")).toBe("PIE-XXX");
  expect(containsWorkIdPlaceholder("[work-id::PIE-XXX]", "PIE")).toBe(true);
  expect(containsWorkIdPlaceholder("[[PIE-XXX]]", "PIE")).toBe(true);
  expect(containsWorkIdPlaceholder("[issue::PIE-XXX]", "PIE")).toBe(true);
  expect(containsWorkIdPlaceholder("OTHER-XXX PIE-XXXX XPIE-XXX", "PIE")).toBe(false);
  expect(isConfiguredWorkIdPlaceholder(" PIE-XXX ", "PIE")).toBe(true);
  expect(isConfiguredWorkIdPlaceholder("OTHER-XXX", "PIE")).toBe(false);
});

test("parses canonical project Work-ID components", () => {
  expect(parseWorkId("PIE-001")).toEqual({
    workId: "PIE-001",
    prefix: "PIE",
    number: 1,
  });
  expect(parseWorkId("pie-123")).toEqual({
    workId: "PIE-123",
    prefix: "PIE",
    number: 123,
  });
  expect(parseWorkId("PIE-1")).toEqual({
    workId: "PIE-001",
    prefix: "PIE",
    number: 1,
  });
  expect(parseWorkId("PIE-0001")).toEqual({
    workId: "PIE-001",
    prefix: "PIE",
    number: 1,
  });
  expect(parseWorkId("PIE-7")).toEqual({
    workId: "PIE-007",
    prefix: "PIE",
    number: 7,
  });
  expect(isCanonicalWorkId("PIE-007")).toBe(true);
  expect(isCanonicalWorkId("PIE-7")).toBe(false);
  expect(parseWorkId("PIE-000")).toBeNull();
  expect(parseWorkId("PIE-x")).toBeNull();
});

test("finds only canonical IDs for the configured project prefix", () => {
  const text = "RFC-2119 PIE-001 ABC-002 UTF-8";
  expect(workIdReferences(text, "PIE").map((reference) => reference.workId)).toEqual([
    "PIE-001",
  ]);
  expect(workIdReferences(text, "ABC").map((reference) => reference.workId)).toEqual([
    "ABC-002",
  ]);
});
