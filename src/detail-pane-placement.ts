import {execFile} from "node:child_process";
import {setTimeout as sleep} from "node:timers/promises";
import {promisify} from "node:util";
import type {OutlinerRequester} from "./client-target";
import {openDetailPane} from "./pane-control";
import {openDetailSidebar} from "./sidebar-placement";
import type {OutlinerClientRegistration, OutlinerNavigationTarget, OutlinerViewAddress} from "./types";

/** Create a reader in a chosen layout scope without changing any saved Open link. */
async function openOutlinerDetailSidebar(
  client: OutlinerRequester,
  sourceClientId: string,
  options: {workspaceRoot: string; initialTarget: OutlinerNavigationTarget; scope: "outliner" | "tab"; side: "left" | "right"; browsingContextId: string},
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
  const paneId = await openDetailSidebar({
    sourcePaneId: runtime.paneId, outlinerPaneIds, scope: options.scope, side: options.side,
    async createDetail(anchorPaneId) {
      return openDetailPane({workspaceRoot: options.workspaceRoot, browsingContextId: options.browsingContextId, initialTarget: options.initialTarget, targetPaneId: anchorPaneId, direction: "right", deferFocus: true});
    },
  });
  return paneId;
}

export type DetailDestinationPlacement =
  | {kind: "split"; direction: "right" | "down"; targetPaneId?: string}
  | {kind: "sidebar"; scope: "outliner" | "tab"; side: "left" | "right"};

/** Creation is complete only when this exact new reader can be chosen as a destination.
 * The caller uses the ordinary link operation; failure never changes its old link. */
export async function createDetailDestination(
  client: OutlinerRequester,
  sourceClientId: string,
  options: {workspaceRoot: string; initialTarget: OutlinerNavigationTarget; placement: DetailDestinationPlacement; timeoutMs?: number},
): Promise<OutlinerViewAddress> {
  const browsingContextId = crypto.randomUUID();
  const {placement} = options;
  const paneId = placement.kind === "sidebar"
    ? await openOutlinerDetailSidebar(client, sourceClientId, {...options, ...placement, browsingContextId})
    : openDetailPane({workspaceRoot: options.workspaceRoot, initialTarget: options.initialTarget,
        browsingContextId, direction: placement.direction, targetPaneId: placement.targetPaneId, deferFocus: true});
  const deadline = Date.now() + (options.timeoutMs ?? 5000);
  do {
    const clients = await client.request<OutlinerClientRegistration[]>({action: "clients.list"});
    // A fresh context identifies this launch even when other hosts reuse pane IDs.
    const reader = clients.find(item => item.role === "detail" && item.contextId === browsingContextId && item.runtime?.paneId === paneId);
    if (reader) {
      // Focus is presentation, not part of whether creation/linking succeeded.
      await promisify(execFile)(process.env.HERDR_BIN_PATH ?? "herdr", ["plugin", "pane", "focus", paneId], {timeout: 5000}).catch(() => {});
      return {clientId: reader.clientId, region: "detail"};
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(100, deadline - Date.now()));
  } while (Date.now() < deadline);
  throw new Error(`Detail created in ${paneId}, but did not become ready to link. Previous destination unchanged; choose it with Change once ready.`);
}
