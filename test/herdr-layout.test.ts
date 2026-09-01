import { expect, test } from "bun:test";
import {
  buildOutlinerLayout,
  reshapeOutlinerLayout,
  resolveOutlinerLayoutPanes,
  type HerdrLayoutApi,
  type HerdrLayoutNode,
  type HerdrMoveDestination,
  type HerdrMoveResult,
  type OutlinerLayoutName,
  type OutlinerLayoutPanes,
} from "../src/herdr-layout";

const panes: OutlinerLayoutPanes = {
  tree: "tree",
  detailA: "detail-a",
  detailB: "detail-b",
  shell: "shell",
};

function removePane(
  node: HerdrLayoutNode,
  paneId: string,
): { node?: HerdrLayoutNode; removed: boolean } {
  if (node.type === "pane") {
    return node.paneId === paneId ? { removed: true } : { node, removed: false };
  }
  const first = removePane(node.first, paneId);
  if (first.removed) {
    return first.node
      ? { node: { ...node, first: first.node }, removed: true }
      : { node: node.second, removed: true };
  }
  const second = removePane(node.second, paneId);
  if (second.removed) {
    return second.node
      ? { node: { ...node, second: second.node }, removed: true }
      : { node: node.first, removed: true };
  }
  return { node, removed: false };
}

function insertPane(
  node: HerdrLayoutNode,
  targetPaneId: string,
  movedPaneId: string,
  destination: HerdrMoveDestination,
): HerdrLayoutNode {
  if (node.type === "pane") {
    if (node.paneId !== targetPaneId) return node;
    return {
      type: "split",
      direction: destination.split!,
      ratio: destination.ratio!,
      first: node,
      second: { type: "pane", paneId: movedPaneId },
    };
  }
  return {
    ...node,
    first: insertPane(node.first, targetPaneId, movedPaneId, destination),
    second: insertPane(node.second, targetPaneId, movedPaneId, destination),
  };
}

function translate(node: HerdrLayoutNode, renames: ReadonlyMap<string, string>): HerdrLayoutNode {
  if (node.type === "pane") {
    return { type: "pane", paneId: renames.get(node.paneId) ?? node.paneId };
  }
  return {
    ...node,
    first: translate(node.first, renames),
    second: translate(node.second, renames),
  };
}

function countPanes(node: HerdrLayoutNode): number {
  return node.type === "pane" ? 1 : countPanes(node.first) + countPanes(node.second);
}

class FakeHerdr implements HerdrLayoutApi {
  readonly tabs = new Map<string, HerdrLayoutNode>();
  moves = 0;
  failAt = 0;

  constructor(initial: HerdrLayoutNode) {
    this.tabs.set("tab", initial);
  }

  movePane(
    paneId: string,
    destination: HerdrMoveDestination,
    _focus: boolean,
  ): HerdrMoveResult {
    this.moves++;
    if (this.moves === this.failAt) throw new Error(`injected failure ${this.moves}`);
    let sourceTabId: string | undefined;
    for (const [tabId, root] of this.tabs) {
      const removed = removePane(root, paneId);
      if (!removed.removed) continue;
      sourceTabId = tabId;
      if (removed.node) this.tabs.set(tabId, removed.node);
      else this.tabs.delete(tabId);
      break;
    }
    if (!sourceTabId) throw new Error(`missing pane ${paneId}`);

    const movedPaneId = `m${this.moves}`;
    if (destination.type === "new_tab") {
      const createdTabId = `staging-${this.moves}`;
      this.tabs.set(createdTabId, { type: "pane", paneId: movedPaneId });
      return { paneId: movedPaneId, createdTabId };
    }
    const target = this.tabs.get(destination.tabId!);
    if (!target) throw new Error(`missing target tab ${destination.tabId}`);
    this.tabs.set(
      destination.tabId!,
      insertPane(target, destination.targetPaneId!, movedPaneId, destination),
    );
    return { paneId: movedPaneId };
  }

  listPaneIds(_workspaceId: string, tabId: string): string[] {
    const root = this.tabs.get(tabId);
    if (!root) return [];
    const ids: string[] = [];
    const visit = (node: HerdrLayoutNode): void => {
      if (node.type === "pane") ids.push(node.paneId);
      else {
        visit(node.first);
        visit(node.second);
      }
    };
    visit(root);
    return ids;
  }
}

test("semantic roles resolve Detail A from the Tree browsing context", () => {
  expect(resolveOutlinerLayoutPanes(
    [
      { role: "detail", contextId: "secondary", paneId: "detail-b" },
      { role: "tree", contextId: "hub", paneId: "tree" },
      { role: "detail", contextId: "hub", paneId: "detail-a" },
    ],
    ["tree", "detail-a", "detail-b", "shell"],
  )).toEqual(panes);
});

test("semantic role errors name the missing working-layout contract", () => {
  expect(() => resolveOutlinerLayoutPanes(
    [{ role: "tree", contextId: "hub", paneId: "tree" }],
    ["tree", "shell"],
  )).toThrow("exactly two Details");
});

test("each explicit layout reaches its target while pane processes retain identity", () => {
  const names: OutlinerLayoutName[] = ["detail-a", "detail-b", "tree-wide"];
  for (const name of names) {
    const fake = new FakeHerdr(buildOutlinerLayout("detail-b", panes));
    const target = buildOutlinerLayout(name, panes);
    const renames = reshapeOutlinerLayout(fake, "workspace", "tab", target, panes.shell);
    expect(fake.tabs.size).toBe(1);
    expect(fake.tabs.get("tab")).toEqual(translate(target, renames));
    expect(new Set(renames.keys())).toEqual(new Set([panes.detailA, panes.detailB, panes.shell]));
  }
});

test("a failed reshape returns every staged process to the original tab", () => {
  const fake = new FakeHerdr(buildOutlinerLayout("detail-b", panes));
  fake.failAt = 4;
  expect(() => reshapeOutlinerLayout(
    fake,
    "workspace",
    "tab",
    buildOutlinerLayout("tree-wide", panes),
  )).toThrow("injected failure");
  expect(fake.tabs.size).toBe(1);
  expect(countPanes(fake.tabs.get("tab")!)).toBe(4);
});
