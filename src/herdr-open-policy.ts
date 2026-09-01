import type { OutlinerClientRegistration } from "./types";

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

export function selectExistingDetailClient(
  clients: OutlinerClientRegistration[],
  tree: OutlinerClientRegistration,
): OutlinerClientRegistration | undefined {
  const candidates = clients
    .filter((client) =>
      client.role === "detail" &&
      (!tree.runtime?.tabId || client.runtime?.tabId === tree.runtime.tabId)
    )
    .sort((left, right) => {
      const leftContext = left.contextId === tree.contextId ? 0 : 1;
      const rightContext = right.contextId === tree.contextId ? 0 : 1;
      if (leftContext !== rightContext) return leftContext - rightContext;
      if (left.locked !== right.locked) return left.locked ? 1 : -1;
      const vertical = (left.runtime?.paneY ?? Number.MAX_SAFE_INTEGER) -
        (right.runtime?.paneY ?? Number.MAX_SAFE_INTEGER);
      if (vertical !== 0) return vertical;
      return (left.runtime?.paneX ?? Number.MAX_SAFE_INTEGER) -
        (right.runtime?.paneX ?? Number.MAX_SAFE_INTEGER);
    });
  return candidates[0];
}
