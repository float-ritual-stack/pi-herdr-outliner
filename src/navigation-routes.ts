import type { OutlinerRequester } from "./client-target";
import type {
  OutlinerNavigationDispatch,
  OutlinerNavigationIntent,
  OutlinerNavigationResolution,
} from "./types";

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
