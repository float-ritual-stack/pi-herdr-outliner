import { expect, test } from "bun:test";
import { externalOpenCommand } from "../src/open-external";

test("external web opening uses argument arrays and rejects executable schemes", () => {
  expect(externalOpenCommand("https://example.com/a?b=c", "linux")).toEqual([
    "xdg-open",
    "https://example.com/a?b=c",
  ]);
  expect(externalOpenCommand("https://example.com/", "darwin")).toEqual([
    "open",
    "https://example.com/",
  ]);
  expect(() => externalOpenCommand("file:///tmp/payload", "linux")).toThrow(
    "External web resources must use HTTP or HTTPS",
  );
});
