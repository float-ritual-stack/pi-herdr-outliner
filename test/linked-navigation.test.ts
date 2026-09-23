import { initTheme } from "@earendil-works/pi-coding-agent";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { navigationDestinationItems, navigationDestinationStatus, NavigationDestinationPreview, renderNavigationDestinationPreview } from "../src/navigation-destination-menu";

test("Open once cannot offer a create-only action that loses the pending target", () => {
  const state = {source: {clientId: "source", region: "tree" as const}, destination: null, destinations: []};
  expect(navigationDestinationItems(state, false)).toEqual([]);
  expect(navigationDestinationStatus(state, "open")).toContain("cancel and open a Detail first");
});
import { OutlinerClient } from "../src/client";
import { OutlinerServer } from "../src/server";
import { HerdrRuntimeRegistry } from "../src/herdr-registry";
import { OutlinerStore } from "../src/store";
import type { NavigationLinkState, OutlinerClientRegistration, OutlinerEvent, OutlinerNavigationDispatch, OutlinerViewAddress } from "../src/types";

test("explicit logical links fan in, never forward receipt, preserve one-off choices, and reject protected or closed destinations", async () => {
  const root = mkdtempSync("/tmp/outliner-links-");
  const store = new OutlinerStore(join(root, "db.sqlite"));
  const server = new OutlinerServer(store, join(root, "app.sock"));
  await server.start();
  const client = new OutlinerClient(join(root, "app.sock"));
  const events: OutlinerEvent[] = [];
  const yReceived = Promise.withResolvers<void>();
  const watchers = [];
  const view = (clientId: string, region: "tree" | "detail" = "detail"): OutlinerViewAddress => ({clientId, region});
  const source = view("A", "tree");
  const registrations: OutlinerClientRegistration[] = [
    ...["A", "B", "C"].map(clientId => ({clientId, role: "tree" as const, contextId: clientId})),
    ...["X", "Y"].map(clientId => ({clientId, role: "detail" as const, contextId: clientId})),
    {clientId: "composed", role: "composed", contextId: "composed"},
  ].map(client => ({...client, runtime: {hostname: "test-host", workspaceId: "workspace", tabId: "tab"}})) as OutlinerClientRegistration[];
  try {
    for (const registration of registrations) {
      const connected = Promise.withResolvers<void>();
      watchers.push(client.watch({client: registration, onConnect: connected.resolve, onError: connected.reject, onEvent: event => { events.push(event); if (event.command?.targetClientId === "Y") yReceived.resolve(); }}));
      await connected.promise;
    }
    const block = store.create("Target");
    const target = {kind: "block" as const, blockId: block.id};
    const open = (clientId: string, extra = {}) => client.request<OutlinerNavigationDispatch>({action: "navigation.dispatch", sourceClientId: clientId, intent: "open", target, ...extra});
    await expect(open("A")).rejects.toThrow("No linked destination");
    for (const clientId of ["A", "B", "C"]) await client.request({action: "navigation.link.set", source: view(clientId, "tree"), destination: view("X")});
    await client.request({action: "navigation.link.set", source: view("X"), destination: view("Y")});
    for (const clientId of ["A", "B", "C"]) expect((await open(clientId)).targetClientId).toBe("X");
    expect(events.filter(e => e.command?.targetClientId === "Y")).toHaveLength(0);
    expect((await open("X")).targetClientId).toBe("Y");
    await yReceived.promise;
    expect(events.filter(e => e.command?.targetClientId === "Y")).toHaveLength(1);
    expect((await open("A", {destination: view("Y")})).resolution).toBe("chosen");
    expect((await client.request<NavigationLinkState>({action: "navigation.link.get", source})).destination).toEqual(view("X"));
    await client.request({action: "clients.update", clientId: "X", runtime: {paneX: 999, tabId: "moved"}});
    expect((await open("A")).targetClientId).toBe("X");
    await client.request({action: "clients.update", clientId: "X", navigationProtection: "active draft"});
    await expect(open("A")).rejects.toThrow("active draft");
    await client.request({action: "clients.update", clientId: "X", navigationProtection: null});
    await client.request({action: "navigation.link.set", source: view("composed", "tree"), destination: view("X")});
    await client.request({action: "navigation.link.set", source: view("composed"), destination: view("Y")});
    await expect(open("composed")).rejects.toThrow("sourceRegion");
    expect((await open("composed", {sourceRegion: "tree"})).targetClientId).toBe("X");
    expect((await open("composed", {sourceRegion: "detail"})).targetClientId).toBe("Y");
    writeFileSync(join(root, "source.md"), "Pinned bytes");
    const resource = store.resources.internFilesystem({path: join(root, "source.md")});
    const description = store.resources.describe(resource.resource.id, true);
    const resourceTarget = {kind: "resource" as const, resourceId: resource.resource.id, revision: description.filesystem!.revision};
    const dispatched = await client.request<OutlinerNavigationDispatch>({action: "navigation.dispatch", sourceClientId: "A", intent: "open", target: resourceTarget});
    expect(dispatched.command).toMatchObject({target: resourceTarget, targetClientId: "X"});
    await watchers[3]!.stop();
    await expect(open("A")).rejects.toThrow("No linked destination");
    expect(store.require(block.id).text).toBe("Target");
  } finally {
    for (const watcher of watchers) await watcher.stop();
    await server.close(); store.close(); rmSync(root, {recursive: true, force: true});
  }
});

test("destination menu renders untrusted labels and protection as inert text", () => {
  const escape = "\x1b[2J\x1b]52;c;c2VjcmV0\x07";
  const items = navigationDestinationItems({
    source: {clientId: "source", region: "tree"}, destination: null,
    destinations: [{view: {clientId: `target${escape}`, region: "detail"}, label: `Detail${escape}`, protection: `Draft${escape}\r\n` }],
  }, false);
  expect(items[0]!.label).toBe("Detail");
  expect(items[0]!.description).toContain("target / detail · protected: Draft");
  expect(items[0]!.description).not.toMatch(/[\x00-\x1f\x7f]/);
});


test("destination picker names documents and puts nearby panes ahead of unlocated clients", async () => {
  const root = mkdtempSync("/tmp/outliner-destination-labels-");
  const store = new OutlinerStore(join(root, "db.sqlite"));
  const server = new OutlinerServer(store, join(root, "app.sock"));
  await server.start();
  const client = new OutlinerClient(join(root, "app.sock"));
  const watchers = [];
  const source = {clientId: "source", region: "tree" as const};
  const document = store.create("# Recognizable destination\nBody");
  const registrations: OutlinerClientRegistration[] = [
    {clientId: "source", role: "tree", contextId: "source", runtime: {hostname: "here", paneId: "p1", tabId: "tab"}},
    {clientId: "aaa-unlocated", role: "detail", contextId: "old-prototype", currentTarget: {kind: "block", blockId: document.id}},
    {clientId: "zzz-nearby", role: "detail", contextId: "reader", runtime: {hostname: "here", paneId: "p2", tabId: "tab"}, currentTarget: {kind: "block", blockId: document.id}},
    {clientId: "remote", role: "detail", contextId: "remote", runtime: {hostname: "other-host", paneId: "remote-pane"}},
  ];
  try {
    for (const registration of registrations) {
      const connected = Promise.withResolvers<void>();
      watchers.push(client.watch({client: registration, onConnect: connected.resolve, onError: connected.reject, onEvent() {}}));
      await connected.promise;
    }
    const state = await client.request<NavigationLinkState>({action: "navigation.link.get", source});
    expect(state.destinations[0]?.view.clientId).toBe("zzz-nearby");
    expect(state.destinations[0]?.label).toContain("Recognizable destination");
    expect(state.destinations[0]?.description).toContain("here");
    expect(state.destinations[0]?.description).toContain("p2");
    expect(state.destinations[0]?.target).toEqual({kind: "block", blockId: document.id});
    const preview = new NavigationDestinationPreview(client, () => {});
    await preview.select(state.destinations[0]);
    expect(preview.document?.resolvedText).toContain("Recognizable destination");
    expect(preview.document?.resolvedText).toContain("Body");
    preview.clear();
    expect((await client.request<NavigationLinkState>({action: "navigation.link.get", source})).destination).toBeNull();
    expect(state.destinations.find(item => item.view.clientId === "aaa-unlocated")?.description).toContain("Location unavailable");
    expect(state.destinations.find(item => item.view.clientId === "aaa-unlocated")?.otherLocation).toBe(true);
    expect(state.destinations[0]?.otherLocation).toBeUndefined();
    expect(state.destinations.find(item => item.view.clientId === "remote")?.label).toBe("Empty Detail");
    await client.request({action: "navigation.link.set", source, destination: {clientId: "remote", region: "detail"}});
    expect((await client.request<NavigationLinkState>({action: "navigation.link.get", source})).destinations[0]?.view.clientId).toBe("remote");
    expect(store.require(document.id).text).toBe(document.text);
  } finally {
    for (const watcher of watchers) await watcher.stop();
    await server.close(); store.close(); rmSync(root, {recursive: true, force: true});
  }
});

test("empty destination menus offer explicit creation and do not pretend there is an unlinkable destination", () => {
  const items = navigationDestinationItems({source: {clientId: "source", region: "tree"}, destination: null, destinations: []}, true);
  expect(items.map(item => item.id)).toEqual(["destination:new-right", "destination:new-below"]);
  expect(items[0]?.label).toBe("New Detail right");
});


test("destination discovery hides only local terminals disproved by a ready registry", async () => {
  const root = mkdtempSync("/tmp/outliner-destination-topology-");
  const store = new OutlinerStore(join(root, "db.sqlite"));
  const registry = new HerdrRuntimeRegistry();
  const server = new OutlinerServer(store, join(root, "app.sock"), registry);
  await server.start();
  const client = new OutlinerClient(join(root, "app.sock"));
  const watchers = [];
  const source = {clientId: "source", region: "tree" as const};
  try {
    for (const registration of [
      {clientId: "source", role: "tree", contextId: "source"},
      {clientId: "vanished", role: "detail", contextId: "vanished", runtime: {terminalId: "gone"}},
      {clientId: "visible", role: "detail", contextId: "visible", runtime: {terminalId: "present"}},
      {clientId: "non-herdr", role: "detail", contextId: "non-herdr"},
      {clientId: "remote", role: "detail", contextId: "remote", runtime: {hostname: "remote-other-host", terminalId: "remote-terminal"}},
    ] as OutlinerClientRegistration[]) {
      const connected = Promise.withResolvers<void>();
      watchers.push(client.watch({client: registration, onConnect: connected.resolve, onError: connected.reject, onEvent() {}}));
      await connected.promise;
    }
    const destinations = async () => (await client.request<NavigationLinkState>({action: "navigation.link.get", source})).destinations.map(item => item.view.clientId);
    expect(await destinations()).toContain("vanished");
    registry.replaceSnapshot({version: "test", protocol: 1,
      workspaces: [{workspace_id: "w1", active_tab_id: "t1", label: "Research"}],
      tabs: [{tab_id: "t1", workspace_id: "w1", label: "Writing"}],
      panes: [{pane_id: "p1", terminal_id: "present", workspace_id: "w1", tab_id: "t1"}], layouts: [], agents: []});
    expect(await destinations()).toEqual(["visible", "non-herdr", "remote"]);
    const visible = (await client.request<NavigationLinkState>({action: "navigation.link.get", source})).destinations[0]!;
    expect(visible.groupLabel).toBe("Research › Writing");
    expect(visible.description).toContain("Research › Writing");
    expect(visible.description).toContain("pane p1");
  } finally {
    for (const watcher of watchers) await watcher.stop();
    await server.close(); store.close(); rmSync(root, {recursive: true, force: true});
  }
});

test("destination preview preserves Resource identity and ignores superseded or cancelled reads", async () => {
  const calls: unknown[] = [];
  const held = Promise.withResolvers<void>();
  const requester = {async request<T>(input: any): Promise<T> {
    calls.push(input);
    if (input.target.resourceId === "older") await held.promise;
    return {filesystem: {text: `# ${input.target.resourceId}\n\n**Rich content**`}} as T;
  }};
  const preview = new NavigationDestinationPreview(requester, () => {});
  const entry = (id: string): NavigationLinkState["destinations"][number] => ({view: {clientId: `reader-${id}`, region: "detail"}, label: id, target: {kind: "resource", resourceId: id, revision: {resourceId: id, addressVersion: 1, revision: {kind: "filesystem", mtimeNs: "1", size: "4", contentHash: "a".repeat(64)}}}});
  const older = preview.select(entry("older"));
  await preview.select(entry("newer"));
  held.resolve(); await older;
  expect(preview.document?.resolvedText).toContain("newer");
  expect(calls).toEqual(["older", "newer"].map(id => ({action: "resources.describe", destinationClientId: `reader-${id}`, target: entry(id).target})));
  initTheme(undefined, false);
  expect(renderNavigationDestinationPreview(preview, 35, 6)).toHaveLength(6);
  expect(renderNavigationDestinationPreview(preview, 35, 6).join("\n")).toContain("Rich content");
  const cancelled = preview.select(entry("cancelled"));
  preview.clear(); await cancelled;
  expect(preview.document).toBeNull();
  expect(preview.loading).toBe(false);
  expect(calls.every((call: any) => call.action === "resources.describe")).toBe(true);
});

test("destination guidance is visible, names the source and linked reader, and sanitizes preview failures", async () => {
  const state: NavigationLinkState = {source: {clientId: "source", region: "tree"}, destination: null, destinations: []};
  expect(navigationDestinationStatus(state)).toContain("Tree has no linked destination");
  expect(navigationDestinationStatus(state)).toContain("No available readers");
  const view = {clientId: "reader", region: "detail" as const};
  state.destination = view;
  state.destinations = [{view, label: "Project notes"}];
  expect(navigationDestinationStatus(state)).toContain("Tree → Project notes");
  expect(navigationDestinationStatus(state)).toContain("Enter to link");
  expect(navigationDestinationStatus(state, "open")).toContain("Enter to open once");
  expect(navigationDestinationStatus(state)).toContain("Esc cancels");
  expect(navigationDestinationItems(state, true)[0]?.label).toContain("← linked");
  const preview = new NavigationDestinationPreview({async request<T>(): Promise<T> {throw new Error("missing\x1b[2J");}}, () => {});
  await preview.select({view, label: "Missing", target: {kind: "block", blockId: "missing"}});
  expect(preview.error).toBe("missing");
  expect(preview.document).toBeNull();
});


test("known-pane pickers collapse other connected views without removing their destinations", () => {
  const local = {view: {clientId: "local", region: "detail" as const}, label: "Visible notes"};
  const elsewhere = {view: {clientId: "remote", region: "detail" as const}, label: "Remote notes", otherLocation: true};
  const state: NavigationLinkState = {source: {clientId: "source", region: "tree"}, destination: elsewhere.view, destinations: [elsewhere, local]};
  const normal = navigationDestinationItems(state, true);
  expect(normal.some(item => item.id === "destination:0")).toBe(false);
  expect(normal.find(item => item.id === "destination:1")?.label).toBe("Visible notes");
  expect(normal.find(item => item.id === "destination:other")?.label).toBe("Show other connected views (1)");
  const expanded = navigationDestinationItems(state, true, true);
  expect(expanded.find(item => item.id === "destination:0")?.label).toBe("Remote notes ← linked");
  expect(expanded.find(item => item.id === "destination:other")?.label).toBe("Hide other connected views (1)");
  expect(state.destinations).toHaveLength(2);
  expect(navigationDestinationStatus(state)).toContain("Remote notes");
});
