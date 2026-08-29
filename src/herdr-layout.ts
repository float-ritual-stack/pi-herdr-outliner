import type { OutlinerClientRole } from "./types";

export type OutlinerLayoutName = "detail-a" | "detail-b" | "tree-wide";

export interface OutlinerLayoutPanes {
  tree: string;
  detailA: string;
  detailB: string;
  shell: string;
}

export type HerdrLayoutNode =
  | { type: "pane"; paneId: string }
  | {
      type: "split";
      direction: "right" | "down";
      ratio: number;
      first: HerdrLayoutNode;
      second: HerdrLayoutNode;
    };

export interface HerdrMoveDestination {
  type: "new_tab" | "tab";
  workspaceId?: string;
  tabId?: string;
  targetPaneId?: string;
  split?: "right" | "down";
  ratio?: number;
  label?: string;
}

export interface HerdrMoveResult {
  paneId: string;
  createdTabId?: string;
}

export interface HerdrLayoutApi {
  movePane(paneId: string, destination: HerdrMoveDestination, focus: boolean): HerdrMoveResult;
  listPaneIds(workspaceId: string, tabId: string): string[];
}

export interface ResolvedOutlinerClient {
  role: OutlinerClientRole;
  contextId: string;
  paneId: string;
}

interface InsertionStep {
  targetPaneId: string;
  sourcePaneId: string;
  direction: "right" | "down";
  ratio: number;
}

const OUTLINER_WIDTH = 0.62;

function pane(paneId: string): HerdrLayoutNode {
  return { type: "pane", paneId };
}

function split(
  direction: "right" | "down",
  ratio: number,
  first: HerdrLayoutNode,
  second: HerdrLayoutNode,
): HerdrLayoutNode {
  return { type: "split", direction, ratio, first, second };
}

export function buildOutlinerLayout(
  name: OutlinerLayoutName,
  panes: OutlinerLayoutPanes,
): HerdrLayoutNode {
  const tree = pane(panes.tree);
  const detailA = pane(panes.detailA);
  const detailB = pane(panes.detailB);
  const shell = pane(panes.shell);

  if (name === "tree-wide") {
    return split(
      "right",
      OUTLINER_WIDTH,
      split("down", 0.5, tree, split("right", 0.5, detailA, detailB)),
      shell,
    );
  }

  const secondaryDetail = name === "detail-a" ? detailB : detailA;
  const fullHeightDetail = name === "detail-a" ? detailA : detailB;
  return split(
    "right",
    OUTLINER_WIDTH,
    split(
      "right",
      0.5,
      split("down", 0.5, tree, secondaryDetail),
      fullHeightDetail,
    ),
    shell,
  );
}

export function resolveOutlinerLayoutPanes(
  clients: readonly ResolvedOutlinerClient[],
  layoutPaneIds: readonly string[],
  invocationPaneId?: string,
): OutlinerLayoutPanes {
  const trees = clients.filter((client) => client.role === "tree");
  if (trees.length !== 1) {
    throw new Error(`Outliner layout needs exactly one Tree in this tab; found ${trees.length}`);
  }
  const details = clients.filter((client) => client.role === "detail");
  if (details.length !== 2) {
    throw new Error(`Outliner layout needs exactly two Details in this tab; found ${details.length}`);
  }

  const tree = trees[0]!;
  const matchingDetails = details.filter((detail) => detail.contextId === tree.contextId);
  if (matchingDetails.length !== 1) {
    throw new Error(
      `Outliner layout needs one Detail A sharing the Tree browsing context; found ${matchingDetails.length}`,
    );
  }
  const detailA = matchingDetails[0]!;
  const detailB = details.find((detail) => detail !== detailA)!;
  const clientPaneIds = new Set([tree.paneId, detailA.paneId, detailB.paneId]);
  let shellPaneIds = layoutPaneIds.filter((paneId) => !clientPaneIds.has(paneId));
  if (
    shellPaneIds.length === 2 &&
    invocationPaneId !== undefined &&
    shellPaneIds.includes(invocationPaneId)
  ) {
    shellPaneIds = shellPaneIds.filter((paneId) => paneId !== invocationPaneId);
  }
  if (shellPaneIds.length !== 1) {
    throw new Error(
      `Outliner layout needs exactly one non-Outliner pane in this tab; found ${shellPaneIds.length}`,
    );
  }
  return {
    tree: tree.paneId,
    detailA: detailA.paneId,
    detailB: detailB.paneId,
    shell: shellPaneIds[0]!,
  };
}

function paneIds(node: HerdrLayoutNode): string[] {
  if (node.type === "pane") return [node.paneId];
  return [...paneIds(node.first), ...paneIds(node.second)];
}

function firstPane(node: HerdrLayoutNode): string {
  while (node.type === "split") node = node.first;
  return node.paneId;
}

function insertionPlan(node: HerdrLayoutNode): InsertionStep[] {
  if (node.type === "pane") return [];
  return [
    {
      targetPaneId: firstPane(node.first),
      sourcePaneId: firstPane(node.second),
      direction: node.direction,
      ratio: node.ratio,
    },
    ...insertionPlan(node.first),
    ...insertionPlan(node.second),
  ];
}

function recoverStaged(
  api: HerdrLayoutApi,
  workspaceId: string,
  stagingTabId: string,
  originalTabId: string,
  targetPaneId: string,
): void {
  for (const paneId of api.listPaneIds(workspaceId, stagingTabId)) {
    api.movePane(
      paneId,
      {
        type: "tab",
        tabId: originalTabId,
        targetPaneId,
        split: "right",
        ratio: 0.5,
      },
      false,
    );
  }
}

export function reshapeOutlinerLayout(
  api: HerdrLayoutApi,
  workspaceId: string,
  tabId: string,
  target: HerdrLayoutNode,
  focusPaneId?: string,
): ReadonlyMap<string, string> {
  const originalIds = paneIds(target);
  if (originalIds.length < 2) return new Map();
  const anchor = firstPane(target);
  const staged = originalIds.filter((paneId) => paneId !== anchor);
  const liveIds = new Map(originalIds.map((paneId) => [paneId, paneId]));
  const renames = new Map<string, string>();
  let stagingTabId: string | undefined;

  const live = (paneId: string): string => liveIds.get(paneId)!;
  const track = (originalPaneId: string, movedPaneId: string): void => {
    if (movedPaneId === live(originalPaneId)) return;
    liveIds.set(originalPaneId, movedPaneId);
    renames.set(originalPaneId, movedPaneId);
  };

  try {
    const firstStaged = staged[0]!;
    const firstMove = api.movePane(
      firstStaged,
      {
        type: "new_tab",
        workspaceId,
        label: `outliner-layout-staging-${process.pid}`,
      },
      false,
    );
    stagingTabId = firstMove.createdTabId;
    if (!stagingTabId) throw new Error("Herdr did not create a staging tab");
    track(firstStaged, firstMove.paneId);

    const stagingTarget = live(firstStaged);
    for (const paneId of staged.slice(1)) {
      const moved = api.movePane(
        live(paneId),
        {
          type: "tab",
          tabId: stagingTabId,
          targetPaneId: stagingTarget,
          split: "right",
          ratio: 0.5,
        },
        false,
      );
      track(paneId, moved.paneId);
    }

    for (const step of insertionPlan(target)) {
      const moved = api.movePane(
        live(step.sourcePaneId),
        {
          type: "tab",
          tabId,
          targetPaneId: live(step.targetPaneId),
          split: step.direction,
          ratio: step.ratio,
        },
        step.sourcePaneId === focusPaneId,
      );
      track(step.sourcePaneId, moved.paneId);
    }
    return renames;
  } catch (error) {
    if (stagingTabId !== undefined) {
      try {
        recoverStaged(api, workspaceId, stagingTabId, tabId, live(anchor));
      } catch (recoveryError) {
        throw new AggregateError([error, recoveryError], "Outliner layout failed and recovery was incomplete");
      }
    }
    throw error;
  }
}

export function translateOutlinerLayoutPanes(
  panes: OutlinerLayoutPanes,
  renames: ReadonlyMap<string, string>,
): OutlinerLayoutPanes {
  return {
    tree: renames.get(panes.tree) ?? panes.tree,
    detailA: renames.get(panes.detailA) ?? panes.detailA,
    detailB: renames.get(panes.detailB) ?? panes.detailB,
    shell: renames.get(panes.shell) ?? panes.shell,
  };
}
