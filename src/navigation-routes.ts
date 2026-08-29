import type { OutlinerRequester } from "./client-target";
import { listLiveClients } from "./client-target";
import { paneLabel } from "./pane-control";
import type {
  OutlinerClientRegistration,
  OutlinerNavigationDispatch,
  OutlinerNavigationIntent,
  OutlinerNavigationResolution,
  OutlinerOpenRoute,
} from "./types";

export interface OpenRouteDestination {
  targetClientId: string;
  label: string;
}

type PaneLabelResolver = (paneId: string) => string | null;

function sharesTab(
  source: OutlinerClientRegistration,
  target: OutlinerClientRegistration,
): boolean {
  return Boolean(
    source.runtime?.workspaceId &&
    source.runtime.tabId &&
    source.runtime.workspaceId === target.runtime?.workspaceId &&
    source.runtime.tabId === target.runtime?.tabId
  );
}

export async function listOpenRouteDestinations(
  requester: OutlinerRequester,
  sourceClientId: string,
  resolvePaneLabel: PaneLabelResolver = paneLabel,
): Promise<OpenRouteDestination[]> {
  const clients = await listLiveClients(requester);
  const source = clients.find((client) => client.clientId === sourceClientId);
  if (!source) throw new Error("Current Outliner pane is not registered");
  const candidates = clients.filter((client) =>
    client.role === "detail" &&
    client.clientId !== sourceClientId &&
    sharesTab(source, client)
  );
  const baseLabels = candidates.map((client, index) =>
    client.runtime?.paneId ? resolvePaneLabel(client.runtime.paneId) ?? `Detail pane ${index + 1}` : `Detail pane ${index + 1}`
  );
  const totals = new Map<string, number>();
  for (const label of baseLabels) totals.set(label, (totals.get(label) ?? 0) + 1);
  const seen = new Map<string, number>();
  return candidates
    .map((client, index) => {
      const base = baseLabels[index]!;
      const occurrence = (seen.get(base) ?? 0) + 1;
      seen.set(base, occurrence);
      return {
        targetClientId: client.clientId,
        label: totals.get(base) === 1 ? base : `${base} (${occurrence})`,
      };
    })
    .sort((left, right) => left.label.localeCompare(right.label));
}

export async function getOpenRoute(
  requester: OutlinerRequester,
  sourceClientId: string,
): Promise<OutlinerOpenRoute | null> {
  return requester.request<OutlinerOpenRoute | null>({
    action: "routes.get",
    sourceClientId,
  });
}

export async function setOpenRoute(
  requester: OutlinerRequester,
  sourceClientId: string,
  targetClientId: string | null,
): Promise<OutlinerOpenRoute | null> {
  return requester.request<OutlinerOpenRoute | null>({
    action: "routes.set",
    sourceClientId,
    targetClientId,
  });
}

export async function resolveNavigationDestination(
  requester: OutlinerRequester,
  sourceClientId: string,
  intent: OutlinerNavigationIntent,
): Promise<OutlinerNavigationResolution> {
  return requester.request<OutlinerNavigationResolution>({
    action: "navigation.resolve",
    sourceClientId,
    intent,
  });
}

export async function dispatchNavigation(
  requester: OutlinerRequester,
  sourceClientId: string,
  blockId: string,
  intent: OutlinerNavigationIntent,
): Promise<OutlinerNavigationDispatch> {
  return requester.request<OutlinerNavigationDispatch>({
    action: "navigation.dispatch",
    sourceClientId,
    blockId,
    intent,
  });
}
