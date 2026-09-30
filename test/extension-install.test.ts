// `outliner ext add` (wave A): copies a built-in into the user folder and seeds config.json from an
// existing resource-extensions.json entry. Made-up paths and names only.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addExtension } from "../src/extension-install";
import { ResourceExtensionRuntime } from "../src/resource-extensions";

test("ext add copies the Jira extension and keeps the old registry's email and keychain reference, never a secret", async () => {
  const root = mkdtempSync(join(tmpdir(), "outliner-ext-add-"));
  const saved = { dir: process.env.OUTLINER_EXTENSIONS_DIR, registry: process.env.OUTLINER_RESOURCE_EXTENSIONS };
  try {
    process.env.OUTLINER_EXTENSIONS_DIR = join(root, "extensions");
    process.env.OUTLINER_RESOURCE_EXTENSIONS = join(root, "resource-extensions.json");
    writeFileSync(join(root, "resource-extensions.json"), JSON.stringify({ version: 1, providers: { jira: {
      manifest: "/opt/example/jira/manifest.json", enabled: true,
      config: { authMode: "basic", email: "someone@example.test" },
      credentials: { token: { keychainService: "jira-api-token" } },
    } } }));
    const lines = await addExtension("jira");
    expect(lines[0]).toContain("installed jira");
    const config = JSON.parse(readFileSync(join(root, "extensions", "jira", "config.json"), "utf8"));
    expect(config).toEqual({ config: { authMode: "basic", email: "someone@example.test" }, secrets: { token: { keychainService: "jira-api-token" } } });
    expect(statSync(join(root, "extensions", "jira", "config.json")).mode & 0o077).toBe(0);

    const described = await new ResourceExtensionRuntime(undefined, undefined, [join(root, "extensions")]).describe("jira");
    expect(described).toMatchObject({ id: "jira", name: "Jira", contract: 2, handlers: [{ key: "jira", pollEvery: "12m" }] });

    // A second add updates the code and keeps the person's config.
    expect((await addExtension("jira")).join("\n")).toContain("kept");
    expect(await new ResourceExtensionRuntime(join(root, "none.json"), undefined, [join(root, "empty")]).describe("jira")).toBeNull();
  } finally {
    for (const [key, value] of [["OUTLINER_EXTENSIONS_DIR", saved.dir], ["OUTLINER_RESOURCE_EXTENSIONS", saved.registry]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
