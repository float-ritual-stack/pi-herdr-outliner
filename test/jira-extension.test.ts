import { test, expect } from "bun:test";
import { cp, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResourceExtensionRuntime } from "../src/resource-extensions";
import { InstalledResourceProviderClient } from "../src/installed-resource-provider";
import type { ResourceSource, Resource } from "../src/resources";

test("installed Jira supports explicit Basic/Bearer, immutable identity, readable ADF and bounded source access", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jira-installed-"));
  const token = "synthetic-jira-test-token";
  const secretName = "OUTLINER_JIRA_EXTENSION_FIXTURE";
  const previous = process.env[secretName];
  process.env[secretName] = token;
  let expectedAuth =
    "Basic " + Buffer.from("reader@example.test:" + token).toString("base64");
  let status = 200,
    wrongIdentity = false,
    requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    // Keep the fixture alive past the provider's 10-second timeout. Otherwise
    // Bun's default idle cutoff races it and tests a socket reset instead.
    idleTimeout: 60,
    fetch(req) {
      if (status === 408) return new Promise<Response>(() => {});
      requests++;
      const url = new URL(req.url);
      if (req.headers.get("authorization") !== expectedAuth)
        return new Response("", { status: 403 });
      if (status !== 200) return new Response("private error text", { status });
      if (!url.pathname.startsWith("/rest/api/3/issue/"))
        return new Response("", { status: 404 });
      return Response.json({
        id: wrongIdentity ? "99999" : "10001",
        key: "PC-762",
        fields: {
          summary: "Transfer *switches*",
          updated: "2026-09-25T12:00:00Z",
          description: {
            type: "doc",
            version: 1,
            content: [
              {
                type: "paragraph",
                content: [
                  {
                    type: "text",
                    text: "`literal`",
                    marks: [{ type: "code" }],
                  },
                ],
              },
              {
                type: "codeBlock",
                content: [{ type: "text", text: "```\n*raw*" }],
              },
              {
                type: "heading",
                attrs: { level: 2 },
                content: [{ type: "text", text: "Plan" }],
              },
              {
                type: "paragraph",
                content: [
                  {
                    type: "text",
                    text: "One safe change",
                    marks: [{ type: "strong" }],
                  },
                ],
              },
              {
                type: "bulletList",
                content: [
                  {
                    type: "listItem",
                    content: [
                      {
                        type: "paragraph",
                        content: [{ type: "text", text: "Verify it" }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
          status: { name: "Doing" },
          issuetype: { name: "Story" },
          labels: ["efax"],
        },
      });
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const source: Extract<ResourceSource, { provider: "jira" }> = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Fixture Jira",
    version: 1,
    provider: "jira",
    boundary: { kind: "jira", origin, project: "PC" },
    policy: { deniedCapabilities: [] },
    createdAt: "2026-09-25T00:00:00Z",
    updatedAt: "2026-09-25T00:00:00Z",
  };
  const resource: Extract<Resource, { provider: "jira" }> = {
    id: "22222222-2222-4222-8222-222222222222",
    sourceId: source.id,
    provider: "jira",
    address: { kind: "jira", entityId: "10001", key: "PC-1" },
    addressVersion: 1,
    version: 1,
    mediaType: null,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
  try {
    // The contract 2 folder, as `outliner ext add jira` installs it.
    const extensions = join(dir, "extensions");
    await cp(join(import.meta.dir, "../extensions/jira"), join(extensions, "jira"), { recursive: true });
    const configPath = join(extensions, "jira", "config.json");
    const folder = {
      config: { authMode: "basic", email: "reader@example.test" } as Record<string, string>,
      secrets: { token: { env: secretName } },
    };
    const config = { providers: { jira: { config: folder.config } } };
    const save = () => writeFile(configPath, JSON.stringify(folder));
    await save();
    const client = new InstalledResourceProviderClient(
      new ResourceExtensionRuntime(join(dir, "no-legacy-registry.json"), 15_000, [extensions]),
    );
    expect(await client.resolveLocator(source, "pc-762")).toEqual({
      entityId: "10001",
      locator: "PC-762",
    });
    const document = await client.observe(resource, source);
    expect(document.markdown).toContain("## Plan");
    expect(document.markdown).toContain("Transfer \\*switches\\*");
    expect(document.markdown).toContain("`` `literal` ``");
    expect(document.markdown).toContain("````\n```\n*raw*\n````");
    expect(document.markdown).toContain("**One safe change**");
    expect(document.markdown).toContain("- Verify it");
    expect(document.externalUrl).toBe(origin + "/browse/PC-762");
    expect(document.sourceSnapshot.entityId).toBe("10001");
    expect(document.commandDescriptors).toEqual([]);
    expect(JSON.stringify(document)).not.toContain(token);
    config.providers.jira.config.authMode = "bearer";
    await save();
    await expect(client.observe(resource, source)).rejects.toThrow("403");
    expectedAuth = "Bearer " + token;
    expect((await client.observe(resource, source)).title).toBe(
      "Transfer *switches*",
    );
    for (const [code, message] of [
      [401, "401"],
      [403, "403"],
      [404, "not found"],
    ] as const) {
      status = code;
      await expect(client.observe(resource, source)).rejects.toThrow(message);
    }
    status = 200;
    status = 408;
    await expect(client.observe(resource, source)).rejects.toThrow("timed out");
    status = 200;
    const before = requests;
    await expect(client.resolveLocator(source, "OTHER-1")).rejects.toThrow(
      "outside",
    );
    expect(requests).toBe(before);
    wrongIdentity = true;
    await expect(client.observe(resource, source)).rejects.toThrow("invalid");
    wrongIdentity = false;
    config.providers.jira.config.authMode = "basic";
    config.providers.jira.config.email = "";
    await save();
    await expect(client.observe(resource, source)).rejects.toThrow("schema");
  } finally {
    server.stop(true);
    if (previous === undefined) delete process.env[secretName];
    else process.env[secretName] = previous;
    await rm(dir, { recursive: true, force: true });
  }
}, 20000);
