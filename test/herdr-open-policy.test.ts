import { expect, test } from "bun:test";
import {
  selectExistingDetailClient,
  selectTreeClient,
  selectTreeClientForInvocation,
} from "../src/herdr-open-policy";
import type { OutlinerClientRegistration } from "../src/types";

const trees: OutlinerClientRegistration[] = [
  {
    clientId: "tree-a",
    role: "tree",
    contextId: "tree-a",
    runtime: { paneId: "pane-a", tabId: "tab-a", workspaceId: "workspace" },
  },
  {
    clientId: "tree-b",
    role: "tree",
    contextId: "tree-b",
    runtime: { paneId: "pane-b", tabId: "tab-b", workspaceId: "workspace" },
  },
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

test("selects the Tree in the invoking tab before considering other live Trees", () => {
  expect(selectTreeClientForInvocation(trees, {
    paneId: "shell-b",
    tabId: "tab-b",
    workspaceId: "workspace",
  })).toBe(trees[1]);
  expect(selectTreeClientForInvocation(trees, {
    paneId: "pane-a",
    tabId: "tab-b",
  })).toBe(trees[0]);
});

test("prefers an unlocked spatially earlier Detail in the Tree browsing context", () => {
  const tree: OutlinerClientRegistration = {
    clientId: "tree",
    role: "tree",
    contextId: "shared",
    runtime: { tabId: "tab", paneId: "tree-pane" },
  };
  const clients: OutlinerClientRegistration[] = [
    tree,
    {
      clientId: "wrong-context",
      role: "detail",
      contextId: "other",
      runtime: { tabId: "tab", paneId: "wrong" },
    },
    {
      clientId: "locked",
      role: "detail",
      contextId: "shared",
      locked: true,
      runtime: { tabId: "tab", paneId: "locked", paneX: 0, paneY: 0 },
    },
    {
      clientId: "available-later",
      role: "detail",
      contextId: "shared",
      locked: false,
      runtime: { tabId: "tab", paneId: "later", paneX: 5, paneY: 10 },
    },
    {
      clientId: "available-first",
      role: "detail",
      contextId: "shared",
      locked: false,
      runtime: { tabId: "tab", paneId: "first", paneX: 2, paneY: 4 },
    },
  ];

  expect(selectExistingDetailClient(clients, tree)?.clientId).toBe("available-first");
  expect(selectExistingDetailClient([tree, clients[1]!], tree)?.clientId)
    .toBe("wrong-context");
});
