import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OutlinerClient } from "../src/client";
import { followResourceOccurrence, resourceOccurrenceLink } from "../src/outliner-links";
import { OutlinerServer } from "../src/server";
import { OutlinerStore } from "../src/store";
import type { OutlinerClientRegistration, ResourceTarget } from "../src/types";

test("navigation retains the particular Resource occurrence across registration and host edits", async () => {
  const root = mkdtempSync("/tmp/reference-context-protocol-");
  writeFileSync(join(root, "same.md"), "Shared Resource bytes");
  const store = new OutlinerStore(join(root, "outliner.sqlite"));
  const server = new OutlinerServer(store, join(root, "outliner.sock"));
  const client = new OutlinerClient(join(root, "outliner.sock"));
  const connected = Promise.withResolvers<void>();
  let watcher: ReturnType<OutlinerClient["watch"]> | undefined;
  try {
    await server.start();
    watcher = client.watch({ client: { clientId: "context-detail", role: "detail", contextId: "context-test" },
      onConnect: connected.resolve, onEvent() {} });
    await connected.promise;
    const source = store.create("Host\n\nFirst [file::same.md].\nSecond [file::same.md].");
    const start = source.text.lastIndexOf("[file::same.md]");
    const followed = await followResourceOccurrence(client, resourceOccurrenceLink(source, { start, end: start + 15 }));
    const target: ResourceTarget = { kind: "resource", resourceId: followed.resource.id,
      referenceContext: followed.referenceContext };
    await client.request({ action: "clients.update", clientId: "context-detail", currentTarget: target });
    const registered = () => client.request<OutlinerClientRegistration[]>({ action: "clients.list" });
    expect((await registered())[0]!.currentTarget).toEqual(target);
    store.update(source.id, "The reference was removed", source.revision, { author: "user", actorId: "test" });
    // Registration retains historical context. Annotation capture separately validates current bytes.
    await client.request({ action: "clients.update", clientId: "context-detail", currentTarget: target });
    expect((await registered())[0]!.currentTarget).toEqual(target);
    const invalid = { ...target, referenceContext: { ...followed.referenceContext, sourceText: "Fabricated context" } };
    await expect(client.request({ action: "clients.update", clientId: "context-detail", currentTarget: invalid }))
      .rejects.toThrow("exact canonical block evidence");
    expect((await registered())[0]!.currentTarget).toEqual(target);
  } finally {
    await watcher?.stop();
    await server.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
