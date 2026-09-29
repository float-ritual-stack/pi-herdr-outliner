import { resolve } from "node:path";
import { clientSupportsRole } from "./types";
import type { OutlinerClientRegistration, OutlinerViewAddress } from "./types";

export function selectTreeClient(
  clients: OutlinerClientRegistration[],
  requestedClientId?: string,
): OutlinerClientRegistration {
  if (requestedClientId) {
    const selected = clients.find((client) => client.clientId === requestedClientId);
    if (!selected) {
      throw new Error(`Requested Tree client is not registered: ${requestedClientId}`);
    }
    return selected;
  }
  if (clients.length === 0) throw new Error("No live Tree client is registered");
  if (clients.length > 1) {
    throw new Error(
      `Multiple live Tree clients are registered; choose --client: ${clients
        .map((client) => client.clientId)
        .join(", ")}`,
    );
  }
  return clients[0]!;
}

export interface TreeInvocationTarget {
  paneId?: string;
  tabId?: string;
  workspaceId?: string;
}

export function selectTreeClientForInvocation(
  clients: OutlinerClientRegistration[],
  target: TreeInvocationTarget,
  requestedClientId?: string,
): OutlinerClientRegistration {
  if (requestedClientId) return selectTreeClient(clients, requestedClientId);
  if (target.paneId) {
    const paneTree = clients.find((client) => client.runtime?.paneId === target.paneId);
    if (paneTree) return paneTree;
  }
  if (target.tabId) {
    const tabTrees = clients.filter((client) => client.runtime?.tabId === target.tabId);
    if (tabTrees.length === 1) return tabTrees[0]!;
    if (tabTrees.length > 1) {
      throw new Error(`Multiple live Tree clients are registered in tab ${target.tabId}`);
    }
  }
  if (target.workspaceId) {
    const workspaceTrees = clients.filter(
      (client) => client.runtime?.workspaceId === target.workspaceId,
    );
    if (workspaceTrees.length === 1) return workspaceTrees[0]!;
    if (workspaceTrees.length > 1) {
      throw new Error(
        `Multiple live Tree clients are registered in workspace ${target.workspaceId}`,
      );
    }
  }
  return selectTreeClient(clients);
}

/** Reuse only the explicitly linked live view, regardless of host geometry. */
export function selectLinkedDetailClient(
  clients: OutlinerClientRegistration[],
  destination: OutlinerViewAddress | null,
): OutlinerClientRegistration | undefined {
  if (!destination) return undefined;
  const client = clients.find(candidate => candidate.clientId === destination.clientId);
  if (!client || destination.region !== "detail" || !clientSupportsRole(client, "detail")) {
    throw new Error("Linked destination is unavailable · choose a destination or create a new Detail");
  }
  return client;
}

/**
 * The folder an invoking pane stands for. Shells report it as their foreground
 * cwd; Outliner panes run from the plugin checkout and report their project
 * through OSC 7 as `cwd`, so a foreground cwd equal to the plugin root is skipped.
 * `open-tree` prefers `cwd` outright, as a new Tree inherits its source's project.
 */
export function invocationPaneRoot(
  pane: { cwd?: string; foreground_cwd?: string } | undefined,
  mode: string,
  pluginRoot: string,
): { root: string; field: "cwd" | "foreground cwd" } | undefined {
  const foreground = pane?.foreground_cwd && !(pane.cwd && resolve(pane.foreground_cwd) === resolve(pluginRoot))
    ? { root: pane.foreground_cwd, field: "foreground cwd" as const }
    : undefined;
  const cwd = pane?.cwd ? { root: pane.cwd, field: "cwd" as const } : undefined;
  return mode === "open-tree" ? cwd ?? foreground : foreground ?? cwd;
}
