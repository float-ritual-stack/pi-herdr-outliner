import type {OutlinerRequester} from "./client-target";
import {openDetailPane} from "./pane-control";
import {openDetailSidebar} from "./sidebar-placement";
import type {OutlinerClientRegistration, OutlinerNavigationTarget} from "./types";

/** Create a reader in a chosen layout scope without changing any saved Open link. */
export async function openOutlinerDetailSidebar(
  client: OutlinerRequester,
  sourceClientId: string,
  options: {workspaceRoot: string; initialTarget: OutlinerNavigationTarget; scope: "outliner" | "tab"; side: "left" | "right"},
): Promise<string> {
  const clients = await client.request<OutlinerClientRegistration[]>({action: "clients.list"});
  const runtime = clients.find(item => item.clientId === sourceClientId)?.runtime;
  if (!runtime?.paneId || !runtime.hostname || !runtime.workspaceId || !runtime.tabId) {
    throw new Error("Sidebar placement requires this reader's current Herdr pane and tab identity");
  }
  const outlinerPaneIds = [...new Set(clients.filter(item =>
    ["tree", "detail", "composed"].includes(item.role) && item.runtime?.hostname === runtime.hostname &&
    item.runtime?.workspaceId === runtime.workspaceId && item.runtime?.tabId === runtime.tabId,
  ).flatMap(item => item.runtime?.paneId ? [item.runtime.paneId] : []))];
  return openDetailSidebar({
    sourcePaneId: runtime.paneId, outlinerPaneIds, scope: options.scope, side: options.side,
    async createDetail(anchorPaneId) {
      return openDetailPane({workspaceRoot: options.workspaceRoot, browsingContextId: crypto.randomUUID(), initialTarget: options.initialTarget, targetPaneId: anchorPaneId, direction: "right", deferFocus: true});
    },
  });
}
