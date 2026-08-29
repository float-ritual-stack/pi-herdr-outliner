import { expect, test } from "bun:test";
import { selectTreeClient } from "../src/herdr-open-policy";
import type { OutlinerClientRegistration } from "../src/types";

const trees: OutlinerClientRegistration[] = [
  { clientId: "tree-a", role: "tree", contextId: "tree-a", runtime: { paneId: "pane-a" } },
  { clientId: "tree-b", role: "tree", contextId: "tree-b", runtime: { paneId: "pane-b" } },
];

test("focus-existing requires an explicit Tree when several are live", () => {
  expect(() => selectTreeClient(trees)).toThrow(
    "Multiple live Tree clients are registered; choose --client: tree-a, tree-b",
  );
  expect(selectTreeClient(trees, "tree-b")).toBe(trees[1]);
});

test("focus-existing rejects missing and stale Tree client identities", () => {
  expect(() => selectTreeClient([])).toThrow("No live Tree client is registered");
  expect(() => selectTreeClient(trees, "tree-stale")).toThrow(
    "Requested Tree client is not registered: tree-stale",
  );
});
