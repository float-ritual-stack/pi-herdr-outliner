import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { InternResourceReceipt, ResourceDescription, ResourceSource } from "../../src/types";
import { runHerdrScenario } from "./herdr-runner";

const SENTINEL = "S1-ORIGINAL-OWNER-COMPLETED";
const received = Promise.withResolvers<void>();
const release = Promise.withResolvers<void>();
const http = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch() {
    received.resolve();
    await release.promise;
    return new Response(`<h1>${SENTINEL}</h1>`, { headers: { "content-type": "text/html" } });
  },
});

try {
  const result = await runHerdrScenario({
    name: "workspace-ownership",
    async prepare() {},
    async run(session) {
      const clients = await session.registrations();
      const detail = clients.find((client) => client.role === "detail" && client.runtime?.paneId === session.panes.detail);
      const tree = clients.find((client) => client.role === "tree" && client.runtime?.paneId === session.panes.tree);
      assert.ok(detail && tree, "The real Tree and Detail must be registered");
      const source = await session.client.request<ResourceSource>({
        action: "resource-sources.create",
        input: { name: "Ownership fixture", provider: "web", boundary: { baseUrl: http.url.href } },
      });
      const { resource } = await session.client.request<InternResourceReceipt>({
        action: "resources.intern",
        input: { sourceId: source.id, address: { kind: "web", url: new URL("held", http.url).href } },
      });
      const refresh = session.client.request<ResourceDescription>({
        action: "resources.refresh", resourceId: resource.id, destinationClientId: detail.clientId,
      }, 30_000);
      // Attach rejection handling before waiting on another condition.
      const settled = refresh.then((value) => ({ value }), (error: unknown) => ({ error }));
      try {
        await Promise.race([
          received.promise,
          settled.then((value) => { throw new Error(`Refresh ended before the HTTP barrier: ${JSON.stringify(value)}`); }),
        ]);
        const readState = () => session.database.query(
          "SELECT freshness, last_error FROM web_resource_state WHERE resource_id = ?",
        ).get(resource.id);
        const before = readState();
        assert.deepEqual(before, { freshness: "refreshing", last_error: null });
        const sequence = session.database.query("SELECT value FROM metadata WHERE key = 'sequence'").get();
        const paneStatePath = join(dirname(session.client.socketPath), "service-pane.json");
        const paneState = await readFile(paneStatePath, "utf8");
        await session.checkpoint("01-original-owner-refreshing");

        const rejected = await session.rejectCompetingService();
        assert.match(rejected.stderr, /Outliner workspace is already owned/);
        assert.equal(rejected.stdout.includes('"status":"ready"'), false);
        assert.deepEqual(readState(), before, "Rejected startup changed the live refresh");
        assert.deepEqual(session.database.query("SELECT value FROM metadata WHERE key = 'sequence'").get(), sequence);
        assert.equal(await readFile(paneStatePath, "utf8"), paneState, "Rejected startup changed the owner's pane registration");
        await session.record("competing-startup-rejected", { rejected, state: readState(), sequence, paneStateUnchanged: true });
        await session.checkpoint("02-contender-rejected");

        release.resolve();
        const completed = await refresh;
        assert.equal(completed.webStatus?.freshness, "fresh");
        assert.equal(completed.web?.markdown, `# ${SENTINEL}`);
        await session.client.request({
          action: "navigation.dispatch", sourceClientId: tree.clientId,
          target: { kind: "resource", resourceId: resource.id }, intent: "open",
        });
        await session.waitVisible(session.panes.detail, SENTINEL);
        await session.record("original-owner-completed", {
          resourceId: resource.id, state: readState(), markdown: completed.web?.markdown,
          detailPane: session.panes.detail, sentinelVisible: true,
        });
        await session.checkpoint("03-original-result-visible");
      } finally {
        release.resolve();
        await settled;
      }
    },
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === "failed") process.exitCode = 1;
} finally {
  release.resolve();
  await http.stop(true);
}
