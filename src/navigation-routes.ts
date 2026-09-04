import { sendClientCommand, type OutlinerRequester } from "./client-target";
import type {
  OutlinerNavigationDispatch,
  OutlinerNavigationIntent,
  OutlinerNavigationResolution,
} from "./types";

export interface NavigationRouteOptions {
  preserveSource?: boolean;
  fragmentId?: string;
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
  await sendClientCommand(requester, route.targetClientId, { command: "focus" });
  return route.targetClientId;
}

export async function dispatchNavigation(
  requester: OutlinerRequester,
  sourceClientId: string,
  blockId: string,
  intent: OutlinerNavigationIntent,
  options: NavigationRouteOptions = {},
): Promise<OutlinerNavigationDispatch> {
  return requester.request<OutlinerNavigationDispatch>({
    action: "navigation.dispatch",
    sourceClientId,
    blockId,
    intent,
    ...(options.fragmentId ? { fragmentId: options.fragmentId } : {}),
    ...(options.preserveSource ? { preserveSource: true } : {}),
  });
}
