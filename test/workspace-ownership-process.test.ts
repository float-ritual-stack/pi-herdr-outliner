import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutlinerClient, type OutlinerWatcher } from "../src/client";
import { resolvePaths } from "../src/paths";
import { TUI_RESOURCE_PRESENTATION_CONTEXT } from "../src/resource-presentation";
import type { InternResourceReceipt, ResourceSource } from "../src/types";

function launchService(root: string) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/server-main.ts")], {
    env: {
      PATH: process.env.PATH,
      OUTLINER_WORKSPACE_ROOT: join(root, "project"),
      OUTLINER_STATE_DIR: join(root, "state"),
      OUTLINER_REMOTE: "0",
      XDG_CONFIG_HOME: join(root, "config"),
    },
    stdout: "pipe", stderr: "pipe", stdin: "ignore",
    timeout: 15_000, killSignal: "SIGKILL",
  });
  const stderr = new Response(child.stderr).text();
  async function startup(): Promise<boolean> {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let output = "";
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return false;
        output += decoder.decode(chunk.value, { stream: true });
        if (output.includes('"status":"ready"')) return true;
      }
    } finally {
      reader.releaseLock();
    }
  }
  return { child, stderr, startup };
}

for (const phase of ["startup", "shutdown"] as const) {
  test(`${phase} pane-state cleanup failure still releases ownership and exits`, async () => {
    const root = mkdtempSync(join(tmpdir(), "outliner-service-cleanup-"));
    const { stateDir } = resolvePaths({
      OUTLINER_WORKSPACE_ROOT: join(root, "project"),
      OUTLINER_STATE_DIR: join(root, "state"),
    });
    const paneStatePath = join(stateDir, "service-pane.json");
    const legacyPaneStatePath = join(stateDir, "outliner-pane.json");
    const services: ReturnType<typeof launchService>[] = [];
    try {
      mkdirSync(join(root, "project"));
      mkdirSync(stateDir, { recursive: true });
      // Directories make non-recursive pane-state removal fail deterministically.
      mkdirSync(paneStatePath);
      if (phase === "startup") mkdirSync(legacyPaneStatePath);
      const service = launchService(root);
      services.push(service);
      expect(await service.startup()).toBe(phase === "shutdown");
      if (phase === "shutdown") service.child.kill("SIGTERM");
      expect(await service.child.exited).toBe(1);
      expect(await service.stderr).toContain("Failed to remove outliner service pane state");

      rmSync(paneStatePath, { recursive: true });
      if (phase === "startup") rmSync(legacyPaneStatePath, { recursive: true });
      const successor = launchService(root);
      services.push(successor);
      expect(await successor.startup()).toBe(true);
      successor.child.kill("SIGTERM");
      expect(await successor.child.exited).toBe(0);
    } finally {
      for (const service of services) {
        if (service.child.exitCode === null) service.child.kill("SIGKILL");
      }
      await Promise.all(services.map((service) => service.child.exited));
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
}

test("simultaneous services elect one owner and recover a real refresh after SIGKILL", async () => {
  const root = mkdtempSync(join(tmpdir(), "outliner-service-owner-"));
  mkdirSync(join(root, "project"));
  const paths = resolvePaths({
    OUTLINER_WORKSPACE_ROOT: join(root, "project"),
    OUTLINER_STATE_DIR: join(root, "state"),
  });
  const received = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const http = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch() {
      received.resolve();
      await release.promise;
      return new Response("<h1>Held operation</h1>", { headers: { "content-type": "text/html" } });
    },
  });
  const services = [launchService(root), launchService(root)];
  let watcher: OutlinerWatcher | undefined;
  let observer: Database | undefined;
  let pending: Promise<unknown> | undefined;
  try {
    const ready = await Promise.all(services.map((service) => service.startup()));
    if (!ready.some(Boolean)) throw new Error((await Promise.all(services.map((service) => service.stderr))).join("\n"));
    expect(ready.filter(Boolean)).toHaveLength(1);
    const winner = services[ready.indexOf(true)]!;
    const loser = services[ready.indexOf(false)]!;
    expect(await loser.child.exited).toBe(1);
    expect(await loser.stderr).toContain("already owned");

    const client = new OutlinerClient(paths.socket);
    const connected = Promise.withResolvers<void>();
    watcher = client.watch({
      client: {
        clientId: "ownership-proof", role: "detail", contextId: "ownership-proof",
        resourcePresentation: TUI_RESOURCE_PRESENTATION_CONTEXT,
      },
      onConnect: connected.resolve,
      onError: connected.reject,
      onEvent() {},
    });
    await connected.promise;
    const source = await client.request<ResourceSource>({
      action: "resource-sources.create",
      input: { name: "Crash fixture", provider: "web", boundary: { baseUrl: http.url.href } },
    });
    const { resource } = await client.request<InternResourceReceipt>({
      action: "resources.intern",
      input: { sourceId: source.id, address: { kind: "web", url: new URL("held", http.url).href } },
    });
    pending = client.request({
      action: "resources.refresh", resourceId: resource.id, destinationClientId: "ownership-proof",
    }).catch((error) => error);
    await Promise.race([
      received.promise,
      pending.then((result) => { throw new Error(`Refresh ended before the HTTP barrier: ${String(result)}`); }),
    ]);
    observer = new Database(paths.database, { readonly: true, create: false });
    expect(observer.query("SELECT freshness FROM web_resource_state WHERE resource_id = ?").get(resource.id))
      .toEqual({ freshness: "refreshing" });
    await watcher.stop();
    winner.child.kill("SIGKILL");
    await winner.child.exited;
    release.resolve();
    await pending;

    const successor = launchService(root);
    services.push(successor);
    expect(await successor.startup()).toBe(true);
    expect(observer.query("SELECT freshness, last_error FROM web_resource_state WHERE resource_id = ?").get(resource.id))
      .toEqual({ freshness: "failed", last_error: "Refresh interrupted before completion" });
    expect(await new OutlinerClient(paths.socket).request({ action: "resources.get", resourceId: resource.id }))
      .toMatchObject({ id: resource.id });
  } finally {
    release.resolve();
    await watcher?.stop();
    for (const service of services) {
      if (service.child.exitCode === null) service.child.kill("SIGKILL");
    }
    await Promise.all(services.map((service) => service.child.exited));
    await pending;
    observer?.close();
    await http.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
