import { expect, test } from "bun:test";
import {
  formatWorkId,
  normalizeWorkIdPrefix,
  parseWorkId,
} from "../src/work-ids";

test("normalizes project prefixes and formats monotonic Work IDs", () => {
  expect(normalizeWorkIdPrefix(" pie ")).toBe("PIE");
  expect(formatWorkId("pie", 1)).toBe("PIE-001");
  expect(formatWorkId("PIE", 1_000)).toBe("PIE-1000");
  expect(() => normalizeWorkIdPrefix("bad-prefix")).toThrow("1-16 ASCII");
  expect(() => formatWorkId("PIE", 0)).toThrow("positive safe integer");
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
  expect(parseWorkId("PIE-000")).toBeNull();
  expect(parseWorkId("PIE-x")).toBeNull();
});
