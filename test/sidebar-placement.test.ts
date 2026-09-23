import { expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { openDetailSidebar, SidebarPlacementError } from "../src/sidebar-placement";

type Node = string | {direction: "right" | "down"; ratio: number; first: Node; second: Node};
const split = (first: Node, second: Node, direction: "right" | "down" = "right", ratio = 0.5): Node => ({first, second, direction, ratio});
const ids = (node: Node): string[] => typeof node === "string" ? [node] : [...ids(node.first), ...ids(node.second)];
function remove(node: Node, id: string): Node | undefined {
  if (typeof node === "string") return node === id ? undefined : node;
  const first = remove(node.first, id), second = remove(node.second, id);
  return first === undefined ? second : second === undefined ? first : {...node, first, second};
}
function insert(node: Node, target: string, pane: string, direction: "right" | "down", ratio: number): Node {
  if (typeof node === "string") return node === target ? split(node, pane, direction, ratio) : node;
  return {...node, first: insert(node.first, target, pane, direction, ratio), second: insert(node.second, target, pane, direction, ratio)};
}
function fixture(initial: Node) {
  const tabs = new Map<string, Node>([["original", structuredClone(initial)]]);
  const operations: string[][] = [];
  let failure: ((args: string[]) => boolean) | undefined;
  const tabOf = (pane: string) => [...tabs].find(([, node]) => ids(node).includes(pane))?.[0];
  const detach = (pane: string) => {
    const tab = tabOf(pane); if (!tab) throw new Error(`Missing pane ${pane}`);
    const next = remove(tabs.get(tab)!, pane);
    if (next) tabs.set(tab, next); else tabs.delete(tab);
  };
  const layout = (tab = "original") => {
    const panes: Array<{pane_id: string; rect: Rect}> = [], splits: Array<{id: string; direction: string; ratio: number; rect: Rect}> = [];
    type Rect = {x: number; y: number; width: number; height: number};
    const visit = (node: Node, rect: Rect, path: string) => {
      if (typeof node === "string") {panes.push({pane_id: node, rect}); return;}
      splits.push({id: `split_${splits.length}_${path || "root"}`, direction: node.direction, ratio: node.ratio, rect});
      if (node.direction === "right") {
        const width = Math.round(rect.width * node.ratio);
        visit(node.first, {...rect, width}, `${path}0`);
        visit(node.second, {...rect, x: rect.x + width, width: rect.width - width}, `${path}1`);
      } else {
        const height = Math.round(rect.height * node.ratio);
        visit(node.first, {...rect, height}, `${path}0`);
        visit(node.second, {...rect, y: rect.y + height, height: rect.height - height}, `${path}1`);
      }
    };
    const area = {x: 0, y: 0, width: 200, height: 80};
    visit(tabs.get(tab)!, area, "");
    return {workspace_id: "workspace", tab_id: tab, zoomed: false, area, panes, splits};
  };
  const run = async (args: string[]): Promise<unknown> => {
    operations.push(args);
    if (failure?.(args)) throw new Error("injected host failure");
    const flag = (name: string) => args[args.indexOf(name) + 1]!;
    if (args[0] === "pane" && args[1] === "layout") return {result: {layout: layout(tabOf(flag("--pane")))}};
    if (args[0] === "pane" && args[1] === "get") {
      const tab = tabOf(args[2]!); if (!tab) throw new Error("Missing pane");
      return {result: {pane: {pane_id: args[2], tab_id: tab, workspace_id: "workspace"}}};
    }
    if (args[0] === "tab" && args[1] === "create") {
      tabs.set("parking", "placeholder");
      return {result: {tab: {tab_id: "parking"}, root_pane: {pane_id: "placeholder"}}};
    }
    if (args[0] === "pane" && args[1] === "move") {
      const pane = args[2]!, tab = flag("--tab");
      if (tabOf(pane) === tab) throw new Error("Fixture forbids ineffective same-tab moves");
      detach(pane);
      const target = args.includes("--target-pane") ? flag("--target-pane") : ids(tabs.get(tab)!)[0]!;
      tabs.set(tab, insert(tabs.get(tab)!, target, pane, flag("--split") as "right" | "down", args.includes("--ratio") ? Number(flag("--ratio")) : 0.5));
      return {result: {}};
    }
    if (args[0] === "pane" && args[1] === "close") {detach(args[2]!); return {result: {}};}
    throw new Error(`Unexpected command ${args.join(" ")}`);
  };
  return {tabs, operations, run, layout, fail: (predicate: (args: string[]) => boolean) => {failure = predicate;},
    createDetail: async (anchor: string) => {const tab = tabOf(anchor)!; tabs.set(tab, insert(tabs.get(tab)!, anchor, "new-detail", "right", 0.5)); return "new-detail";}};
}

for (const side of ["left", "right"] as const) {
  test(`Outliner ${side} sidebar preserves outside panes and the original subtree`, async () => {
    const subtree = split("tree", split("detail-a", "detail-b", "right", 0.6), "down", 0.3);
    const f = fixture(split("unrelated-shell", subtree, "right", 0.25));
    const outside = f.layout().panes[0];
    expect(await openDetailSidebar({sourcePaneId: "tree", outlinerPaneIds: ["tree", "detail-a", "detail-b", "another-tab"], scope: "outliner", side, createDetail: f.createDetail}, f.run)).toBe("new-detail");
    expect(f.tabs.get("original")).toEqual(split("unrelated-shell", side === "left" ? split("new-detail", subtree) : split(subtree, "new-detail"), "right", 0.25));
    expect(f.layout().panes.find(pane => pane.pane_id === "unrelated-shell")).toEqual(outside);
    expect([...f.tabs.keys()]).toEqual(["original"]);
    expect(f.operations.some(args => args[1] === "move" && args[2] === "unrelated-shell")).toBe(false);
  });
  test(`whole-tab ${side} sidebar preserves every existing pane identity and split ratio`, async () => {
    const initial = split("shell", split("tree", "detail", "down", 0.7), "right", 0.4);
    const f = fixture(initial);
    await openDetailSidebar({sourcePaneId: "tree", outlinerPaneIds: ["tree", "detail"], scope: "tab", side, createDetail: f.createDetail}, f.run);
    expect(f.tabs.get("original")).toEqual(side === "left" ? split("new-detail", initial) : split(initial, "new-detail"));
    expect(f.layout().panes.find(pane => pane.pane_id === "new-detail")?.rect.height).toBe(80);
    expect([...f.tabs.keys()]).toEqual(["original"]);
  });
}

test("scoped sidebar rejects interleaved unrelated panes before any mutation", async () => {
  const f = fixture(split("tree", split("shell", "detail", "down")));
  await expect(openDetailSidebar({sourcePaneId: "tree", outlinerPaneIds: ["tree", "detail"], scope: "outliner", side: "right", createDetail: f.createDetail}, f.run)).rejects.toThrow("unrelated");
  expect(f.operations.every(args => args[1] === "layout")).toBe(true);
});

test("failed rebuilding restores original panes and ratios without restarting them", async () => {
  const initial = split("shell", split("tree", "detail", "down", 0.3));
  const f = fixture(initial);
  let failed = false;
  f.fail(args => {if (!failed && args[1] === "move" && args[2] === "detail" && args.includes("original")) {failed = true; return true;} return false;});
  await expect(openDetailSidebar({sourcePaneId: "tree", outlinerPaneIds: ["tree", "detail"], scope: "outliner", side: "left", createDetail: f.createDetail}, f.run)).rejects.toThrow("restored");
  expect(f.tabs.get("original")).toEqual(initial);
  expect([...f.tabs.keys()]).toEqual(["original"]);
  expect(f.operations.every(args => !["run", "restart", "kill"].includes(args[1]!))).toBe(true);
});

test("failed recovery retains an actionable original-layout journal", async () => {
  const initial = split("tree", "detail", "down", 0.3);
  const f = fixture(initial);
  f.fail(args => args[1] === "move" && args[2] === "detail" && args.includes("original"));
  try {
    await openDetailSidebar({sourcePaneId: "tree", outlinerPaneIds: ["tree", "detail"], scope: "tab", side: "right", createDetail: f.createDetail}, f.run);
    throw new Error("Expected placement failure");
  } catch (error) {
    expect(error).toBeInstanceOf(SidebarPlacementError);
    const path = (error as SidebarPlacementError).journalPath!;
    expect(existsSync(path)).toBe(true);
    const journal = JSON.parse(readFileSync(path, "utf8"));
    expect(journal.originalLayout.panes.map((pane: {pane_id: string}) => pane.pane_id)).toEqual(["tree", "detail"]);
    expect(journal.rebuild).toEqual([{pane: "detail", target: "tree", direction: "down", ratio: 0.3}]);
    expect(journal.parkingTab).toBe("parking");
    expect(String(error)).toContain(path);
    rmSync(path, {force: true});
  }
});

for (const side of ["left", "right"] as const) {
  test(`single-pane ${side} sidebar needs no existing reader and preserves its process`, async () => {
    const f = fixture("tree");
    await openDetailSidebar({sourcePaneId: "tree", outlinerPaneIds: ["tree"], scope: "outliner", side, createDetail: f.createDetail}, f.run);
    expect(f.tabs.get("original")).toEqual(side === "left" ? split("new-detail", "tree") : split("tree", "new-detail"));
    expect([...f.tabs.keys()]).toEqual(["original"]);
    if (side === "right") expect(f.operations.some(args => args[0] === "tab")).toBe(false);
  });
}

test("a layout change during planning aborts before moving any pane", async () => {
  const f = fixture(split("tree", "detail", "down"));
  let reads = 0;
  const run = async (args: string[]) => {
    if (args[1] === "layout" && ++reads === 2) f.tabs.set("original", split("tree", split("detail", "new-shell"), "down"));
    return f.run(args);
  };
  await expect(openDetailSidebar({sourcePaneId: "tree", outlinerPaneIds: ["tree", "detail"], scope: "outliner", side: "right", createDetail: f.createDetail}, run)).rejects.toThrow("changed during planning");
  expect(f.operations.every(args => args[1] === "layout")).toBe(true);
});

for (const phase of ["park", "return-anchor", "create"] as const) {
  test(`failure during ${phase} restores the complete original subtree`, async () => {
    const initial = split("outside", split("tree", split("a", "b", "down", 0.4), "right", 0.6));
    const f = fixture(initial);
    let failed = false;
    f.fail(args => {
      const matches = phase === "park" ? args[2] === "b" && args.includes("parking") : phase === "return-anchor" && args[2] === "tree" && args.includes("original");
      if (!failed && args[1] === "move" && matches) {failed = true; return true;} return false;
    });
    const createDetail = phase === "create" ? async () => {throw new Error("create rejected");} : f.createDetail;
    await expect(openDetailSidebar({sourcePaneId: "tree", outlinerPaneIds: ["tree", "a", "b"], scope: "outliner", side: "left", createDetail}, f.run)).rejects.toThrow("original layout restored");
    expect(f.tabs.get("original")).toEqual(initial);
    expect([...f.tabs.keys()]).toEqual(["original"]);
    expect(f.operations.filter(args => args[1] === "close").every(args => ["new-detail", "placeholder"].includes(args[2]!))).toBe(true);
  });
}

test("an unreported created pane cannot produce a false successful rollback", async () => {
  const f = fixture(split("tree", "detail", "down"));
  try {
    await openDetailSidebar({sourcePaneId: "tree", outlinerPaneIds: ["tree", "detail"], scope: "outliner", side: "right",
      async createDetail(anchor) {await f.createDetail(anchor); throw new Error("creation returned no identity");}}, f.run);
    throw new Error("Expected failure");
  } catch (error) {
    expect(error).toBeInstanceOf(SidebarPlacementError);
    const path = (error as SidebarPlacementError).journalPath!;
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("unreported pane");
    expect(ids(f.tabs.get("original")!)).toContain("new-detail");
    rmSync(path, {force: true});
  }
});

test("pane chrome does not make native split geometry ambiguous", async () => {
  const f = fixture(split("outside", split("tree", "detail", "down", 0.4), "right", 0.3));
  const run = async (args: string[]) => {
    const response = await f.run(args);
    if (args[1] === "layout") {
      const layout = (response as {result: {layout: ReturnType<typeof f.layout>}}).result.layout;
      layout.panes = layout.panes.map(pane => ({...pane, rect: {...pane.rect, x: pane.rect.x + 1, y: pane.rect.y + 1, width: pane.rect.width - 2, height: pane.rect.height - 2}}));
    }
    return response;
  };
  await openDetailSidebar({sourcePaneId: "tree", outlinerPaneIds: ["tree", "detail"], scope: "outliner", side: "left", createDetail: f.createDetail}, run);
  expect(f.tabs.get("original")).toEqual(split("outside", split("new-detail", split("tree", "detail", "down", 0.4)), "right", 0.3));
});

test("a creation callback using the wrong split direction is detected and rolled back", async () => {
  const f = fixture(split("tree", "detail", "down", 0.3));
  await expect(openDetailSidebar({sourcePaneId: "tree", outlinerPaneIds: ["tree", "detail"], scope: "tab", side: "right",
    async createDetail(anchor) {f.tabs.set("original", insert(f.tabs.get("original")!, anchor, "new-detail", "down", 0.5)); return "new-detail";}}, f.run)).rejects.toThrow("original layout restored");
  expect(f.tabs.get("original")).toEqual(split("tree", "detail", "down", 0.3));
});

for (const failure of ["placeholder", "journal"] as const) {
  test(`successful placement survives ${failure} cleanup failure with an actionable journal`, async () => {
    const original = split("tree", "detail", "down", 0.3);
    const f = fixture(original);
    const warnings = spyOn(console, "warn").mockImplementation(() => {});
    const unlink = failure === "journal" ? spyOn(fsPromises, "unlink").mockRejectedValue(new Error("injected unlink failure")) : undefined;
    let path: string | undefined;
    if (failure === "placeholder") f.fail(args => args[1] === "close" && args[2] === "placeholder");
    try {
      expect(await openDetailSidebar({sourcePaneId: "tree", outlinerPaneIds: ["tree", "detail"], scope: "outliner", side: "left", createDetail: f.createDetail}, f.run)).toBe("new-detail");
      expect(f.tabs.get("original")).toEqual(split("new-detail", original));
      expect(f.operations.some(args => args[1] === "close" && args[2] === "new-detail")).toBe(false);
      expect(warnings).toHaveBeenCalledTimes(1);
      path = String(warnings.mock.calls[0]?.[0]).match(/\/\S+\.json/)?.[0];
      expect(path).toBeDefined();
      const journal = JSON.parse(readFileSync(path!, "utf8"));
      expect(journal.placementVerified).toBe(true);
      expect(journal.sidebar).toBe("new-detail");
      expect(journal.cleanupError).toContain("injected");
      expect(f.tabs.has("parking")).toBe(failure === "placeholder");
    } finally {
      warnings.mockRestore(); unlink?.mockRestore();
      if (path) rmSync(path, {force: true});
    }
  });
}
