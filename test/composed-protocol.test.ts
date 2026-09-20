import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { OutlinerClient } from "../src/client";
import { HerdrRuntimeRegistry } from "../src/herdr-registry";
import { OutlinerServer } from "../src/server";
import { OutlinerStore } from "../src/store";
import type { OutlinerClientRegistration, OutlinerNavigationDispatch } from "../src/types";

test("a composed client has one registration and independently addressable Tree and Detail regions without host discovery", async () => {
  const root = mkdtempSync("/tmp/outliner-composed-");
  const store = new OutlinerStore(join(root, "db.sqlite"));
  const server = new OutlinerServer(store, join(root, "app.sock"), new HerdrRuntimeRegistry());
  await server.start();
  const client = new OutlinerClient(join(root, "app.sock"));
  const connected = Promise.withResolvers<void>();
  const watcher = client.watch({
    client: {clientId: "primary", role: "composed", contextId: "application", focusedRegion: "tree"},
    onConnect: connected.resolve, onError: connected.reject, onEvent() {},
  });
  try {
    await connected.promise;
    const treeBlock = await client.request<{id: string}>({action: "create", text: "Tree context"});
    const detailBlock = await client.request<{id: string}>({action: "create", text: "Pinned Detail"});
    await client.request({action: "clients.update", clientId: "primary", currentTarget: {kind: "block", blockId: detailBlock.id},
      treeSelection: {target: {kind: "block", blockId: treeBlock.id}, rowId: `physical:${treeBlock.id}`}, focusedRegion: "tree"});
    const all = await client.request<OutlinerClientRegistration[]>({action: "clients.list"});
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({role: "composed", focusedRegion: "tree", currentTarget: {blockId: detailBlock.id}, treeSelection: {target: {blockId: treeBlock.id}}});
    expect(await client.request({action: "clients.list", role: "tree"})).toHaveLength(1);
    expect(await client.request({action: "clients.list", role: "detail"})).toHaveLength(1);
    await expect(client.request({action: "ui.command.send", command: {targetClientId: "primary", command: "focus"}})).rejects.toThrow(/region/);
    const opened = await client.request<OutlinerNavigationDispatch>({action: "navigation.dispatch", sourceClientId: "primary", target: {kind: "block", blockId: detailBlock.id}, intent: "open"});
    expect(opened.command).toMatchObject({targetClientId: "primary", targetRegion: "detail", command: "open"});
    const revealed = await client.request<OutlinerNavigationDispatch>({action: "navigation.dispatch", sourceClientId: "primary", target: {kind: "block", blockId: treeBlock.id}, intent: "reveal"});
    expect(revealed.command).toMatchObject({targetClientId: "primary", targetRegion: "tree", command: "reveal"});
    await expect(client.request({action: "attention.mark", input: {markId: "ambiguous", targetClientId: "primary", target: {kind: "block", sourceBlockId: treeBlock.id}, tone: "current", sender: "test", reveal: true}})).rejects.toThrow(/region/);
    await client.request({action: "attention.mark", input: {markId: "explicit", targetClientId: "primary", targetRegion: "tree", target: {kind: "block", sourceBlockId: treeBlock.id}, tone: "current", sender: "test", reveal: true}});
    await client.request({action: "clients.update", clientId: "primary", locked: true});
    await expect(client.request({action: "navigation.dispatch", sourceClientId: "primary", target: {kind: "block", blockId: treeBlock.id}, intent: "open"})).rejects.toThrow(/locked/);
  } finally {
    await watcher.stop(); await server.close(); store.close(); rmSync(root, {recursive: true, force: true});
  }
});

test("a composed Detail protects its retained Resource revision until that region releases it", async () => {
  const root = mkdtempSync("/tmp/outliner-composed-retention-");
  let version = 1;
  let now = "2026-09-19T12:00:00.000Z";
  const store = new OutlinerStore(join(root, "db.sqlite"), {
    now: () => now,
    fetch: (async (_input: string | URL | Request, _init?: RequestInit) => new Response(`<h1>Revision ${version}</h1><p>Evidence ${version}</p>`, {headers: {"content-type": "text/html"}})) as typeof fetch,
  });
  const server = new OutlinerServer(store, join(root, "app.sock"));
  await server.start();
  const client = new OutlinerClient(join(root, "app.sock"));
  const connected = Promise.withResolvers<void>();
  const watcher = client.watch({client: {clientId: "primary", role: "composed", contextId: "application"}, onConnect: connected.resolve, onError: connected.reject, onEvent() {}});
  try {
    await connected.promise;
    const source = await client.request<{id: string}>({action: "resource-sources.create", input: {name: "Composed retention", provider: "web", boundary: {baseUrl: "https://example.com/"}}});
    const {resource} = await client.request<import("../src/types").InternResourceReceipt>({action: "resources.intern", input: {sourceId: source.id, address: {kind: "web", url: "https://example.com/history"}}});
    const first = await client.request<import("../src/types").ResourceDescription>({action: "resources.refresh", resourceId: resource.id, destinationClientId: "primary"});
    const oldSnapshot = first.web!.sourceSnapshot;
    await client.request({action: "clients.update", clientId: "primary", currentTarget: {kind: "resource", resourceId: resource.id, revision: oldSnapshot.revision}});
    version++;
    now = "2026-09-20T12:00:00.000Z";
    await client.request({action: "resources.refresh", resourceId: resource.id, destinationClientId: "primary"});
    await client.request({action: "resources.retention.configure", input: {retainNewestSourceSnapshots: 1, retainNewestRepresentationsPerAdapter: 1, minimumAgeMs: 0, purgeGraceMs: 0}});
    const retained = await client.request<import("../src/resources").ResourceRetentionReport>({action: "resources.retention.inspect", resourceId: resource.id});
    expect(retained.artifacts.find(item => item.artifact.id === oldSnapshot.id)?.states).toContain("referenced");
    const protectedCollection = await client.request<import("../src/resources").ResourceRetentionCollectionReceipt>({action: "resources.collect", mode: "evict", resourceId: resource.id});
    expect(protectedCollection.evicted).not.toContainEqual({kind: "source-snapshot", id: oldSnapshot.id});
    await client.request({action: "clients.update", clientId: "primary", currentTarget: null});
    const released = await client.request<import("../src/resources").ResourceRetentionCollectionReceipt>({action: "resources.collect", mode: "evict", resourceId: resource.id});
    expect(released.evicted).toContainEqual({kind: "source-snapshot", id: oldSnapshot.id});
  } finally {
    await watcher.stop(); await server.close(); store.close(); rmSync(root, {recursive: true, force: true});
  }
});
