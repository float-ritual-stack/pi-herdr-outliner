import {expect, test} from "bun:test";
import {NavigationDestinationDisplay, navigationDestinationItems, navigationPlacementItems} from "../src/navigation-destination-menu";
import type {NavigationLinkState, OutlinerEvent} from "../src/types";

const source = {clientId: "source", region: "detail" as const};
const destination = {clientId: "reader", region: "detail" as const};
function linked(label: string): NavigationLinkState {
  return {source, destination, destinations: [{view: destination, label, target: {kind: "block", blockId: "document"}}]};
}
function event(action: string, clientId?: string): OutlinerEvent {
  return {id: "event", sequence: 1, domain: "view", action, clientId};
}

test("placement choices use local pane anchors and remain separate from Open once", () => {
  const state = linked("Local reader");
  state.destinations.unshift({view: {clientId: "remote", region: "detail"}, label: "Remote reader"});
  state.destinations[1]!.placementPaneId = "w1:p4";
  const links = navigationDestinationItems(state, true);
  expect(links.filter(item => item.id.startsWith("destination:place-")).map(item => item.id)).toEqual(["destination:place-right", "destination:place-below"]);
  expect(navigationDestinationItems(state, false).some(item => item.id.startsWith("destination:place-"))).toBe(false);
  expect(navigationPlacementItems(state).map(item => item.id)).toEqual(["placement:1", "placement:back"]);
  expect(navigationPlacementItems(state)[0]!.label).toBe("Local reader");
});

test("sidebar choices name their edge and area explicitly and never appear in Open once", () => {
  const state = linked("Reader");
  const sidebars = navigationDestinationItems(state, true).filter(item => item.id.startsWith("destination:sidebar-"));
  expect(sidebars.map(({id, label}) => ({id, label}))).toEqual([
    {id: "destination:sidebar-outliner-left", label: "Sidebar left · Outliner area"},
    {id: "destination:sidebar-outliner-right", label: "Sidebar right · Outliner area"},
    {id: "destination:sidebar-tab-left", label: "Sidebar left · Whole Herdr tab"},
    {id: "destination:sidebar-tab-right", label: "Sidebar right · Whole Herdr tab"},
  ]);
  expect(navigationDestinationItems(state, false).some(item => item.id.startsWith("destination:sidebar-"))).toBe(false);
});

test("destination display follows service link, target and closure events without fetching during reads", async () => {
  let state = linked("Research notes"); let requests = 0; let renders = 0;
  const display = new NavigationDestinationDisplay({request: async () => {requests++; return state as never;}}, source, () => renders++);
  await display.refresh();
  expect(display.text).toBe("Research notes");
  expect(display.text).toBe("Research notes");
  expect(requests).toBe(1);
  await display.onEvent(event("clients.update", "unrelated"));
  await display.onEvent(event("navigation.link.set", "unrelated"));
  expect(requests).toBe(1);
  state = linked("New document");
  await display.onEvent(event("clients.update", "reader"));
  expect(display.text).toBe("New document");
  state = linked("Renamed document");
  await display.onEvent({...event("update"), domain: "content", blockId: "document"});
  expect(display.text).toBe("Renamed document");
  state = {...state, destinations: []};
  await display.onEvent(event("clients.unregister", "reader"));
  expect(display.text).toBe("Destination unavailable");
  state = {source, destination: null, destinations: []};
  await display.onEvent(event("navigation.link.set", "source"));
  expect(display.text).toBe("Not linked");
  expect(renders).toBe(5);
  display.dispose();
  await display.refresh();
  expect(requests).toBe(5);
});

test("pending refresh cannot publish an obsolete destination after a newer event", async () => {
  const first = Promise.withResolvers<NavigationLinkState>();
  let requests = 0; const shown: string[] = [];
  const display = new NavigationDestinationDisplay({request: async () => (++requests === 1 ? await first.promise : linked("Latest")) as never}, source, () => shown.push(display.text));
  const pending = display.refresh();
  const changed = display.onEvent(event("navigation.link.set", "source"));
  first.resolve(linked("Obsolete"));
  await Promise.all([pending, changed]);
  expect(shown).toEqual(["Latest"]);
  expect(requests).toBe(2);
});
