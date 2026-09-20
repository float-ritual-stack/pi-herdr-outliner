import { sendClientCommand, type OutlinerRequester } from "./client-target";
import type {
  OutlinerNavigationDispatch,
  OutlinerNavigationIntent,
  OutlinerNavigationResolution,
  OutlinerNavigationTarget,
  BrowsingContextPublication,
} from "./types";

export const PRIMARY_DETAIL_LOCKED_ERROR =
  "The primary Detail is locked · unlock it or choose an explicit detached destination";

export const ALL_DETAILS_LOCKED_ERROR =
  "All Details in this tab are locked · unlock one or open another Detail";

export interface NavigationRouteOptions {
  preserveSource?: boolean;
  focusTarget?: boolean;
}

export interface TreeNavigation {
  readonly readerLabel: string;
  publish(target: OutlinerNavigationTarget | null, preview: boolean, rowId: string | null): Promise<BrowsingContextPublication>;
  resolve(intent: OutlinerNavigationIntent, options?: NavigationRouteOptions): Promise<OutlinerNavigationResolution>;
  dispatch(target: OutlinerNavigationTarget, intent: OutlinerNavigationIntent, options?: NavigationRouteOptions): Promise<OutlinerNavigationDispatch>;
  edit(blockId: string): Promise<void>;
}

export function serviceTreeNavigation(requester: OutlinerRequester, clientId: string, contextId: string): TreeNavigation {
  return {
    readerLabel: "first unlocked Detail",
    publish: (target, preview) => requester.request({action: "browsing-context.publish", sourceClientId: clientId, contextId, target, ...(preview ? {} : {dispatchPreview: false})}),
    resolve: (intent, options) => resolveNavigationDestination(requester, clientId, intent, options),
    dispatch: (target, intent, options) => dispatchNavigation(requester, clientId, target, intent, options),
    async edit(blockId) {
      const destination = await resolveNavigationDestination(requester, clientId, "open");
      await sendClientCommand(requester, destination.targetClientId, {command: "edit", targetRegion: "detail", target: {kind: "block", blockId}});
    },
  };
}

export async function resolveNavigationDestination(
  requester: OutlinerRequester,
  sourceClientId: string,
  intent: OutlinerNavigationIntent,
  options: NavigationRouteOptions = {},
): Promise<OutlinerNavigationResolution> {
  return requester.request<OutlinerNavigationResolution>({
    action: "navigation.resolve",
    sourceClientId,
    intent,
    ...(options.preserveSource ? { preserveSource: true } : {}),
  });
}

export async function focusTreeForClient(
  requester: OutlinerRequester,
  sourceClientId: string,
): Promise<string> {
  const route = await resolveNavigationDestination(requester, sourceClientId, "reveal");
  await sendClientCommand(requester, route.targetClientId, { command: "focus", targetRegion: "tree" });
  return route.targetClientId;
}

export async function dispatchNavigation(
  requester: OutlinerRequester,
  sourceClientId: string,
  target: OutlinerNavigationTarget,
  intent: OutlinerNavigationIntent,
  options: NavigationRouteOptions = {},
): Promise<OutlinerNavigationDispatch> {
  return requester.request<OutlinerNavigationDispatch>({
    action: "navigation.dispatch",
    sourceClientId,
    target,
    intent,
    ...(options.preserveSource ? { preserveSource: true } : {}),
    ...(options.focusTarget ? { focusTarget: true } : {}),
  });
}
