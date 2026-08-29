import { expect, test } from "bun:test";
import type { RequestInput } from "../src/client";
import { listOpenRouteDestinations } from "../src/navigation-routes";
import type { OutlinerClientRegistration } from "../src/types";

function requester(clients: OutlinerClientRegistration[]) {
  return {
    async request<T>(input: RequestInput): Promise<T> {
      if (input.action !== "clients.list") throw new Error(`Unexpected action ${input.action}`);
      return clients as T;
    },
  };
}

test("lists only same-tab Detail destinations with disambiguated human pane labels", async () => {
  const clients: OutlinerClientRegistration[] = [
    { clientId: "tree-a", role: "tree", contextId: "context-a", runtime: { workspaceId: "ws", tabId: "tab-1", paneId: "pane-a" } },
    { clientId: "detail-c", role: "detail", contextId: "context-a", runtime: { workspaceId: "ws", tabId: "tab-1", paneId: "pane-c" } },
    { clientId: "detail-d", role: "detail", contextId: "context-d", runtime: { workspaceId: "ws", tabId: "tab-1", paneId: "pane-d" } },
    { clientId: "detail-oi", role: "detail", contextId: "context-oi", runtime: { workspaceId: "ws", tabId: "tab-oi", paneId: "pane-oi" } },
    { clientId: "detail-other-workspace", role: "detail", contextId: "context-other", runtime: { workspaceId: "other", tabId: "tab-1", paneId: "pane-other" } },
  ];
  const labels = new Map([
    ["pane-c", "[C] Detail"],
    ["pane-d", "[C] Detail"],
    ["pane-oi", "[OI] Detail"],
    ["pane-other", "Other Detail"],
  ]);

  const destinations = await listOpenRouteDestinations(
    requester(clients),
    "tree-a",
    (paneId) => labels.get(paneId) ?? null,
  );

  expect(destinations).toEqual([
    { targetClientId: "detail-c", label: "[C] Detail (1)" },
    { targetClientId: "detail-d", label: "[C] Detail (2)" },
  ]);
  expect(JSON.stringify(destinations)).not.toContain("detail-oi");
  expect(JSON.stringify(destinations)).not.toContain("detail-other-workspace");
});

test("a Detail source excludes itself from its same-tab destination picker", async () => {
  const clients: OutlinerClientRegistration[] = [
    { clientId: "detail-c", role: "detail", contextId: "context-c", runtime: { workspaceId: "ws", tabId: "tab", paneId: "pane-c" } },
    { clientId: "detail-d", role: "detail", contextId: "context-d", runtime: { workspaceId: "ws", tabId: "tab", paneId: "pane-d" } },
  ];

  expect(await listOpenRouteDestinations(
    requester(clients),
    "detail-c",
    (paneId) => paneId === "pane-d" ? "[D] Detail" : "[C] Detail",
  )).toEqual([{ targetClientId: "detail-d", label: "[D] Detail" }]);
});
