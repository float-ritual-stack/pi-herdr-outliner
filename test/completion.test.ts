import { expect, test } from "bun:test";
import { completionWindow } from "../src/completion";

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
