import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  ResourceSource,
  ResourceDescription,
  InternResourceReceipt,
} from "../../src/types";
import { runHerdrScenario } from "./herdr-runner";
let configPath = "",
  manifestPath = "",
  entryPath = "";
const installation = {
  version: 1,
  providers: {
    jira: { manifest: "", enabled: true, config: {}, credentials: {} },
  },
};
const declaration = {
  contract: 1,
  id: "fixture.external",
  version: 1,
  command: [] as string[],
  configSchema: { type: "object", additionalProperties: false },
};
const script = (title: string) =>
  `const r=await Bun.stdin.json();console.log(JSON.stringify({ok:true,value:r.operation==='resolve'?{entityId:'10001',locator:'PC-762'}:{entityId:'10001',locator:'PC-762',title:"Extension fixture",markdown:${JSON.stringify("# " + title + "\n\nInstalled outside the checkout.")},sourceContent:'fixture-source-v1',metadata:{status:'Doing'},externalUrl:'https://jira.example.test/browse/PC-762',updatedAt:'2026-09-25T12:00:00Z'}}));`;
const result = await runHerdrScenario({
  name: "resource-extensions",
  async prepare(root) {
    const configDir = join(dirname(root), "xdg-config", "pi-herdr-outliner");
    await mkdir(configDir, { recursive: true });
    const extensionDir = join(root, "external-fixture");
    await mkdir(extensionDir);
    entryPath = join(extensionDir, "handler.ts");
    manifestPath = join(extensionDir, "manifest.json");
    configPath = join(configDir, "resource-extensions.json");
    declaration.command = [process.execPath, entryPath];
    installation.providers.jira.manifest = manifestPath;
    await writeFile(entryPath, script("Extension first version"));
    await writeFile(manifestPath, JSON.stringify(declaration));
    await writeFile(configPath, JSON.stringify(installation));
  },
  async run(s) {
    const terminal = await s.attachClient();
    // Wide enough that Detail's status line shows a whole refresh failure.
    await terminal.resize(400, 55);
    const detail = s.panes.detail;
    const destination = (await s.registrations()).find(
      (c) => c.runtime?.paneId === detail,
    )!;
    assert(destination);
    await s.client.request<ResourceSource>({
      action: "resource-sources.create",
      input: {
        name: "External fixture",
        provider: "jira",
        boundary: {
          origin: "https://jira.example.test",
          project: "PC",
          credentialEnv: "UNUSED_EXTENSION_FIXTURE",
        },
      },
    });
    const receipt = await s.client.request<InternResourceReceipt>({
      action: "resources.follow-authored",
      reference: { kind: "jira", key: "PC-762" },
    });
    const source = (await s.registrations()).find(
      (c) => c.runtime?.paneId === s.panes.tree,
    )!;
    await s.client.request({
      action: "navigation.dispatch",
      sourceClientId: source.clientId,
      destination: { clientId: destination.clientId, region: "detail" },
      intent: "open",
      target: { kind: "resource", resourceId: receipt.resource.id },
    });
    const refresh = () =>
      s.client.request<ResourceDescription>({
        action: "resources.refresh",
        destinationClientId: destination.clientId,
        resourceId: receipt.resource.id,
      });
    assert.equal((await refresh()).remoteStatus?.freshness, "fresh");
    await s.waitVisible(detail, "Extension first version");
    await s.checkpoint("01-installed-provider");
    await writeFile(entryPath, script("Extension updated version"));
    declaration.version = 2;
    await writeFile(manifestPath, JSON.stringify(declaration));
    await s.keys(detail, "r");
    await s.waitVisible(detail, "Extension updated version");
    await s.checkpoint("02-update-no-restart");
    const showFailure = async (message: string) => {
      await s.keys(detail, "r");
      await s.waitFor(
        "failed refresh recorded",
        () =>
          s.client.request<ResourceDescription>({
            action: "resources.describe",
            target: { kind: "resource", resourceId: receipt.resource.id },
            destinationClientId: destination.clientId,
          }),
        (d) =>
          d.remoteStatus?.freshness === "failed" &&
          !!d.remoteStatus.lastError?.includes(message),
        25000,
      );
      // A failed refresh reloads Detail; wait out loading, then scan down a line
      // at a time (a key can move the reading focus without scrolling). The
      // message may wrap, so compare with whitespace collapsed.
      const shows = (frame: string) => frame.replace(/\s+/g, " ").includes(message);
      // First the status line the refresh leaves; then the document's Local status.
      let seen = await s.waitFor("refresh status", () => s.visible(detail), shows, 5000).then(() => true, () => false);
      if (!seen) {
        await s.waitFor("Detail reloaded after refresh", () => s.visible(detail), (f) => !f.includes("Loading target"), 20000);
        await s.keys(detail, ...Array(80).fill("up"));
      }
      const scanned: string[] = [];
      for (let step = 0; step < 400 && !seen; step++) {
        const frame = await s.visible(detail);
        scanned.push(frame);
        if (shows(frame)) seen = true;
        else if (frame.includes("Loading target")) await Bun.sleep(100);
        else await s.keys(detail, "down");
      }
      if (!seen) await s.record("unseen-failure-scan", { message, frames: scanned });
      assert.ok(seen, `Detail shows the refresh failure: ${message}`);
    };
    installation.providers.jira.enabled = false;
    await writeFile(configPath, JSON.stringify(installation));
    await showFailure("disabled");
    await s.checkpoint("03-disabled-visible");
    installation.providers.jira.enabled = true;
    await writeFile(configPath, JSON.stringify(installation));
    await s.keys(detail, ...Array(50).fill("up"), "r");
    await s.waitFor(
      "reenabled",
      () => s.visible(detail),
      (f) => f.includes("Extension updated version") && !f.includes("disabled"),
    );
    await writeFile(
      manifestPath,
      JSON.stringify({ ...declaration, contract: 99 }),
    );
    await showFailure("contract 1");
    await s.checkpoint("04-incompatible-visible");
    await writeFile(manifestPath, JSON.stringify(declaration));
    await writeFile(
      configPath,
      JSON.stringify({
        ...installation,
        providers: {
          jira: {
            ...installation.providers.jira,
            credentials: { token: { env: "OUTLINER_ABSENT_FIXTURE_TOKEN" } },
          },
        },
      }),
    );
    await showFailure("credentials are unavailable");
    await s.checkpoint("05-missing-secret-visible");
    await writeFile(configPath, JSON.stringify(installation));
    await writeFile(manifestPath, "{broken");
    await showFailure("invalid");
    await s.checkpoint("06-malformed-manifest-visible");
    await writeFile(manifestPath, JSON.stringify(declaration));
    await writeFile(
      entryPath,
      `await Bun.stdin.json();console.log(JSON.stringify({ok:false,code:'forbidden'}));`,
    );
    await showFailure("403");
    await s.checkpoint("07-provider-failure-visible");
    await writeFile(
      entryPath,
      `await Bun.stdin.json();await new Promise(()=>{});`,
    );
    await showFailure("timed out");
    await s.checkpoint("08-timeout-visible");
    await writeFile(entryPath, script("Extension updated version"));

    await writeFile(configPath, JSON.stringify(installation));
    await s.keys(detail, ...Array(50).fill("up"), "r");
    await s.waitVisible(detail, "Extension updated version");
  },
});
console.log(JSON.stringify(result));
if (result.status !== "passed") process.exitCode = 1;
