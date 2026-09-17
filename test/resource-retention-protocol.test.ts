import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutlinerClient } from "../src/client";
import { OutlinerServer } from "../src/server";
import { OutlinerStore } from "../src/store";
import type {
  InternResourceReceipt,
  OutlinerEvent,
  ResourceDescription,
  ResourceRetentionCollectionReceipt,
  ResourceRetentionReport,
  ResourceSource,
} from "../src/types";

test("retention protocol protects exact revisions held by live Detail clients", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-retention-protocol-"));
  const socket = join(directory, "outliner.sock");
  let now = "2026-09-17T14:00:00.000Z";
  let version = 1;
  const store = new OutlinerStore(join(directory, "outliner.sqlite"), {
    now: () => now,
    fetch: (async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(`<h1>Version ${version}</h1>`, {
        headers: { "content-type": "text/html", etag: `"v${version}"` },
      })) as typeof fetch,
  });
  const server = new OutlinerServer(store, socket);
  await server.start();
  const connected = Promise.withResolvers<void>();
  const events: OutlinerEvent[] = [];
  const watcher = new OutlinerClient(socket).watch({
    client: {
      clientId: "retention-detail",
      role: "detail",
      contextId: "retention-context",
    },
    onConnect: connected.resolve,
    onEvent(event) {
      events.push(event);
    },
    onError: connected.reject,
  });
  try {
    await connected.promise;
    const client = new OutlinerClient(socket);
    const source = await client.request<ResourceSource>({
      action: "resource-sources.create",
      input: {
        name: "Retention protocol",
        provider: "web",
        boundary: { baseUrl: "https://example.com/" },
      },
    });
    const resource = (await client.request<InternResourceReceipt>({
      action: "resources.intern",
      input: {
        sourceId: source.id,
        address: { kind: "web", url: "https://example.com/protocol-retention" },
      },
    })).resource;
    const revisions: ResourceDescription[] = [];
    for (version = 1; version <= 3; version += 1) {
      now = `2026-09-17T14:0${version}:00.000Z`;
      revisions.push(await client.request<ResourceDescription>({
        action: "resources.refresh",
        resourceId: resource.id,
        destinationClientId: "retention-detail",
      }));
    }
    const first = revisions[0]!.web!;
    const second = revisions[1]!.web!;
    const current = revisions[2]!.web!;

    await client.request({
      action: "resources.retention.configure",
      input: {
        retainNewestSourceSnapshots: 1,
        retainNewestRepresentationsPerAdapter: 1,
        minimumAgeMs: 0,
        purgeGraceMs: 0,
      },
    });
    const pin = await client.request<{ pin: { id: string }; created: boolean }>({
      action: "resources.retention.pin",
      input: {
        artifact: { kind: "source-snapshot", id: first.sourceSnapshot.id },
        label: "Protocol pin",
      },
    });
    const reference = await client.request<{ reference: { id: string }; created: boolean }>({
      action: "resources.retention.reference",
      input: {
        artifact: { kind: "representation", id: second.representation.id },
        owner: { kind: "review", id: "retention-review" },
      },
    });
    expect(pin.created).toBe(true);
    expect(reference.created).toBe(true);
    await client.request({ action: "resources.retention.unpin", pinId: pin.pin.id });
    await client.request({
      action: "resources.retention.unreference",
      referenceId: reference.reference.id,
    });
    await client.request({
      action: "clients.update",
      clientId: "retention-detail",
      currentTarget: {
        kind: "resource",
        resourceId: resource.id,
        revision: first.sourceSnapshot.revision,
      },
    });

    const protectedReport = await client.request<ResourceRetentionReport>({
      action: "resources.retention.inspect",
      resourceId: resource.id,
    });
    expect(protectedReport.artifacts.find(({ artifact }) =>
      artifact.id === first.representation.id
    )?.states).toContain("referenced");
    expect(protectedReport.artifacts.find(({ artifact }) =>
      artifact.id === second.representation.id
    )?.states).toEqual(["evictable"]);
    expect(protectedReport.artifacts.find(({ artifact }) =>
      artifact.id === current.representation.id
    )?.states).toEqual(expect.arrayContaining(["current", "hot"]));

    const firstEviction = await client.request<ResourceRetentionCollectionReceipt>({
      action: "resources.collect",
      mode: "evict",
      resourceId: resource.id,
    });
    expect(firstEviction.evicted.map(({ id }) => id)).toEqual(expect.arrayContaining([
      second.sourceSnapshot.id,
      second.representation.id,
    ]));
    expect(firstEviction.evicted.some(({ id }) => id === first.representation.id)).toBe(false);

    await client.request({
      action: "clients.update",
      clientId: "retention-detail",
      currentTarget: null,
    });
    const secondEviction = await client.request<ResourceRetentionCollectionReceipt>({
      action: "resources.collect",
      mode: "evict",
      resourceId: resource.id,
    });
    expect(secondEviction.evicted.map(({ id }) => id)).toEqual(expect.arrayContaining([
      first.sourceSnapshot.id,
      first.representation.id,
    ]));
    const purge = await client.request<ResourceRetentionCollectionReceipt>({
      action: "resources.collect",
      mode: "purge",
      resourceId: resource.id,
    });
    expect(purge.purged.map(({ artifact }) => artifact.id)).toEqual(expect.arrayContaining([
      first.sourceSnapshot.id,
      first.representation.id,
      second.sourceSnapshot.id,
      second.representation.id,
    ]));
    expect(events.map(({ action }) => action)).toEqual(expect.arrayContaining([
      "resources.retention.configure",
      "resources.retention.pin",
      "resources.retention.reference",
      "resources.retention.unpin",
      "resources.retention.unreference",
      "resources.collect",
    ]));
  } finally {
    watcher.stop();
    await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
