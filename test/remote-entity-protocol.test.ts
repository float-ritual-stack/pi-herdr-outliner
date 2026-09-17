import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutlinerClient, type OutlinerWatcher } from "../src/client";
import type {
  RemoteEntityProviderClient,
  RemoteEntityResource,
  RemoteEntitySource,
} from "../src/remote-entity";
import { OutlinerServer } from "../src/server";
import { OutlinerStore } from "../src/store";
import type {
  OutlinerClientRegistration,
  RemoteEntityDocument,
  ResourceCapability,
  ResourceDescription,
  ResourceProviderCommandDescriptor,
  ResourceProviderCommandInput,
  ResourceProviderCommandReceipt,
  ResourceProviderCommandResult,
  ResourceSource,
} from "../src/types";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function commandDescriptor(
  provider: "jira" | "linear",
): ResourceProviderCommandDescriptor {
  const descriptor = {
    command: "comment.create",
    label: "Add comment",
    input: {
      body: { type: "string", required: true, maxLength: 10_000 },
    },
  } as const;
  return provider === "jira"
    ? { ...descriptor, provider: "jira" }
    : { ...descriptor, provider: "linear" };
}

class RemoteEntityFixture implements RemoteEntityProviderClient {
  observeCalls = 0;
  executeCalls = 0;
  locator = "PIE-256";
  observeError: string | null = null;
  receiptEntityId: string | null = null;

  async observe(
    resource: RemoteEntityResource,
    _source: RemoteEntitySource,
  ): Promise<RemoteEntityDocument> {
    this.observeCalls += 1;
    if (this.observeError) throw new Error(this.observeError);
    const observedAt = "2026-09-17T12:00:00.000Z";
    const markdown = `# Remote entity\n\n${this.locator}`;
    return {
      title: "Remote entity",
      metadata: { state: "In Progress", labels: ["remote"] },
      markdown,
      externalUrl: `https://issues.example.test/browse/${this.locator}`,
      sourceSnapshot: {
        provider: resource.provider,
        resourceId: resource.id,
        addressVersion: resource.addressVersion,
        entityId: resource.address.entityId,
        locator: this.locator,
        contentHash: hash(`${resource.provider}:${resource.address.entityId}:${observedAt}`),
        revision: {
          resourceId: resource.id,
          addressVersion: resource.addressVersion,
          revision: resource.provider === "jira"
            ? {
                kind: "jira",
                validator: { kind: "updated-at", value: observedAt },
              }
            : {
                kind: "linear",
                validator: { kind: "updated-at", value: observedAt },
              },
        },
        fetchedAt: observedAt,
      },
      representation: {
        mediaType: "text/markdown",
        adapter: { id: "test.remote-entity", version: 1 },
        contentHash: hash(markdown),
        derivedAt: observedAt,
      },
      commandDescriptors: [commandDescriptor(resource.provider)],
    };
  }

  async execute(
    resource: RemoteEntityResource,
    _source: RemoteEntitySource,
    input: ResourceProviderCommandInput,
  ): Promise<ResourceProviderCommandReceipt> {
    this.executeCalls += 1;
    return {
      resourceId: resource.id,
      provider: resource.provider,
      command: input.command,
      entityId: this.receiptEntityId ?? resource.address.entityId,
      externalId: "comment-1",
      executedAt: "2026-09-17T12:01:00.000Z",
    };
  }
}

function detailRegistration(
  clientId: string,
  capabilities: readonly ResourceCapability[],
  credentials: "available" | "unavailable" | "unknown" = "available",
  connectivity: "available" | "unavailable" | "unknown" = "available",
): OutlinerClientRegistration {
  return {
    clientId,
    role: "detail",
    contextId: "remote-entity",
    resourcePresentation: {
      surface: "tui",
      placement: "pane",
      host: {
        id: clientId,
        renderers: ["markdown", "metadata", "external-open"],
        placements: ["pane", "external"],
        capabilities,
      },
      providerAccess: { credentials, connectivity },
    },
  };
}

async function registerDetail(
  client: OutlinerClient,
  registration: OutlinerClientRegistration,
): Promise<OutlinerWatcher> {
  const connected = Promise.withResolvers<void>();
  const watcher = client.watch({
    client: registration,
    onConnect: connected.resolve,
    onEvent() {},
  });
  await connected.promise;
  return watcher;
}

async function createJiraResource(
  client: OutlinerClient,
  policy?: { deniedCapabilities: readonly ["command"] },
): Promise<{ source: ResourceSource; resourceId: string }> {
  const source = await client.request<ResourceSource>({
    action: "resource-sources.create",
    input: {
      name: "Jira",
      provider: "jira",
      boundary: {
        origin: "https://issues.example.test",
        project: "PIE",
        credentialEnv: "TEST_JIRA_TOKEN",
      },
      policy,
    },
  });
  const receipt = await client.request<{ resource: { id: string } }>({
    action: "resources.intern",
    input: {
      sourceId: source.id,
      address: { kind: "jira", entityId: "immutable-255", key: "PIE-255" },
    },
  });
  return { source, resourceId: receipt.resource.id };
}

test("remote entity open is local-only while refresh and command explicitly use the provider", async () => {
  const directory = mkdtempSync(join(tmpdir(), "outliner-remote-entity-protocol-"));
  const provider = new RemoteEntityFixture();
  const store = new OutlinerStore(join(directory, "outliner.sqlite"), {
    remoteEntityClient: provider,
  });
  const socket = join(directory, "outliner.sock");
  const server = new OutlinerServer(store, socket);
  await server.start();
  const client = new OutlinerClient(socket);
  const watchers = await Promise.all([
    registerDetail(client, detailRegistration(
      "remote-detail",
      ["read", "refresh", "open-external", "command"],
    )),
    registerDetail(client, detailRegistration(
      "tui-detail",
      ["read", "refresh", "open-external"],
      "unknown",
      "unknown",
    )),
  ]);
  cleanups.push(async () => {
    await Promise.all(watchers.map((watcher) => watcher.stop()));
    await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const { source, resourceId } = await createJiraResource(client);
  const initial = store.resources.require(resourceId);
  const canonicalBefore = store.database.query(
    "SELECT canonical_key FROM resources WHERE id = ?",
  ).get(resourceId) as { canonical_key: string };

  const opened = await client.request<ResourceDescription>({
    action: "resources.open",
    target: { kind: "resource", resourceId },
    destinationClientId: "tui-detail",
  });
  expect(opened.remoteEntity).toBeNull();
  expect(opened.remoteStatus).toEqual({
    freshness: "unknown",
    checkedAt: null,
    lastError: null,
  });
  expect(provider.observeCalls).toBe(0);
  expect(provider.executeCalls).toBe(0);

  const refreshed = await client.request<ResourceDescription>({
    action: "resources.refresh",
    resourceId,
    destinationClientId: "tui-detail",
  });
  expect(provider.observeCalls).toBe(1);
  expect(refreshed.remoteEntity?.markdown).toContain("PIE-256");
  expect(refreshed.remoteStatus?.freshness).toBe("fresh");
  expect(refreshed.availableCommands).toEqual([]);
  const relocated = store.resources.require(resourceId);
  expect(relocated).toMatchObject({
    id: initial.id,
    sourceId: initial.sourceId,
    provider: "jira",
    address: { kind: "jira", entityId: "immutable-255", key: "PIE-256" },
    addressVersion: initial.addressVersion + 1,
    version: initial.version + 1,
  });
  expect(store.database.query(
    "SELECT canonical_key FROM resources WHERE id = ?",
  ).get(resourceId)).toEqual(canonicalBefore);

  const commandView = await client.request<ResourceDescription>({
    action: "resources.open",
    target: { kind: "resource", resourceId },
    destinationClientId: "remote-detail",
  });
  expect(commandView.availableCommands).toEqual([commandDescriptor("jira")]);
  store.database.query("UPDATE resource_sources SET policy_json = ? WHERE id = ?")
    .run(JSON.stringify({ deniedCapabilities: ["refresh"] }), source.id);

  const result = await client.request<ResourceProviderCommandResult>({
    action: "resources.command.execute",
    resourceId,
    destinationClientId: "remote-detail",
    input: {
      provider: "jira",
      command: "comment.create",
      payload: { body: "A typed remote comment" },
    },
  });
  expect(result.receipt).toEqual({
    resourceId,
    provider: "jira",
    command: "comment.create",
    entityId: "immutable-255",
    externalId: "comment-1",
    executedAt: "2026-09-17T12:01:00.000Z",
  });
  expect(result.description.remoteEntity?.sourceSnapshot.entityId).toBe("immutable-255");
  expect(provider.executeCalls).toBe(1);
  expect(provider.observeCalls).toBe(1);

  const reopened = await client.request<ResourceDescription>({
    action: "resources.open",
    target: { kind: "resource", resourceId },
    destinationClientId: "remote-detail",
  });
  expect(reopened.remoteEntity).toEqual(result.description.remoteEntity);
  expect(provider.observeCalls).toBe(1);

  store.database.query("UPDATE resource_sources SET policy_json = ? WHERE id = ?")
    .run(JSON.stringify({ deniedCapabilities: [] }), source.id);

  provider.observeError = "provider offline";
  const failed = await client.request<ResourceDescription>({
    action: "resources.refresh",
    resourceId,
    destinationClientId: "remote-detail",
  });
  expect(failed.remoteEntity).toEqual(reopened.remoteEntity);
  expect(failed.remoteStatus).toMatchObject({
    freshness: "failed",
    lastError: "provider offline",
  });
  expect(failed.remoteError).toBe("provider offline");
  expect(provider.observeCalls).toBe(2);

  const current = store.resources.require(resourceId);
  expect(() => store.resources.relocate({
    resourceId,
    expectedVersion: current.version,
    destinationSourceId: current.sourceId,
    address: { kind: "jira", entityId: "different-entity", key: "PIE-257" },
  })).toThrow("immutable entity identity");
  const previousState = store.database.query(
    "SELECT source_snapshot_id FROM remote_entity_resource_state WHERE resource_id = ?",
  ).get(resourceId) as { source_snapshot_id: string };
  const locatorMoved = store.resources.relocate({
    resourceId,
    expectedVersion: current.version,
    destinationSourceId: current.sourceId,
    address: { kind: "jira", entityId: "immutable-255", key: "PIE-257" },
  });
  expect(locatorMoved.address).toEqual({
    kind: "jira",
    entityId: "immutable-255",
    key: "PIE-257",
  });
  expect(store.database.query(`
    SELECT source_snapshot_id, representation_id, freshness
    FROM remote_entity_resource_state
    WHERE resource_id = ?
  `).get(resourceId)).toEqual({
    source_snapshot_id: null,
    representation_id: null,
    freshness: "unknown",
  });
  const retained = store.resources.inspectRetention(resourceId);
  expect(
    retained.artifacts.find(({ artifact }) => artifact.id === previousState.source_snapshot_id)
      ?.states,
  ).not.toContain("current");
});

test("remote commands reject malformed, mismatched, denied, and unavailable requests before provider execution", async () => {
  const directory = mkdtempSync(join(tmpdir(), "outliner-remote-command-policy-"));
  const provider = new RemoteEntityFixture();
  const store = new OutlinerStore(join(directory, "outliner.sqlite"), {
    remoteEntityClient: provider,
  });
  const socket = join(directory, "outliner.sock");
  const server = new OutlinerServer(store, socket);
  await server.start();
  const client = new OutlinerClient(socket);
  const watchers = await Promise.all([
    registerDetail(client, detailRegistration(
      "command-detail",
      ["read", "refresh", "open-external", "command"],
    )),
    registerDetail(client, detailRegistration(
      "host-denied-detail",
      ["read", "refresh", "open-external"],
    )),
    registerDetail(client, detailRegistration(
      "credential-denied-detail",
      ["read", "refresh", "open-external", "command"],
      "unavailable",
    )),
    registerDetail(client, detailRegistration(
      "connectivity-denied-detail",
      ["read", "refresh", "open-external", "command"],
      "available",
      "unavailable",
    )),
  ]);
  cleanups.push(async () => {
    for (const watcher of watchers) await watcher.stop();
    await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const { source, resourceId } = await createJiraResource(client);
  await client.request<ResourceDescription>({
    action: "resources.refresh",
    resourceId,
    destinationClientId: "command-detail",
  });
  expect(provider.executeCalls).toBe(0);

  await expect(client.request<unknown>({
    action: "resources.command.execute",
    resourceId,
    destinationClientId: "command-detail",
    input: { provider: "jira", command: "comment.create", payload: { body: " " } },
  })).rejects.toThrow("Comment body must be");
  await expect(client.request<unknown>({
    action: "resources.command.execute",
    resourceId,
    destinationClientId: "command-detail",
    input: { provider: "linear", command: "comment.create", payload: { body: "No" } },
  })).rejects.toThrow("does not match the resolved Resource");
  for (const destinationClientId of [
    "host-denied-detail",
    "credential-denied-detail",
    "connectivity-denied-detail",
  ]) {
    await expect(client.request<unknown>({
      action: "resources.command.execute",
      resourceId,
      destinationClientId,
      input: { provider: "jira", command: "comment.create", payload: { body: "No" } },
    })).rejects.toThrow("Resource command unavailable");
  }
  expect(provider.executeCalls).toBe(0);

  store.database.query("UPDATE resource_sources SET policy_json = ? WHERE id = ?")
    .run(JSON.stringify({ deniedCapabilities: ["command"] }), source.id);
  await expect(client.request<unknown>({
    action: "resources.command.execute",
    resourceId,
    destinationClientId: "command-detail",
    input: { provider: "jira", command: "comment.create", payload: { body: "No" } },
  })).rejects.toThrow("Workspace policy denies command");
  expect(provider.executeCalls).toBe(0);

  store.database.query("UPDATE resource_sources SET policy_json = ? WHERE id = ?")
    .run(JSON.stringify({ deniedCapabilities: [] }), source.id);
  provider.receiptEntityId = "wrong-entity";
  await expect(client.request<unknown>({
    action: "resources.command.execute",
    resourceId,
    destinationClientId: "command-detail",
    input: { provider: "jira", command: "comment.create", payload: { body: "Wrong receipt" } },
  })).rejects.toThrow("receipt does not match the resolved Resource");
  expect(provider.executeCalls).toBe(1);
});

test("provider constraint migration preserves existing child foreign keys", () => {
  const directory = mkdtempSync(join(tmpdir(), "outliner-remote-migration-"));
  const path = join(directory, "outliner.sqlite");
  let store = new OutlinerStore(path);
  const source = store.resources.createSource({
    name: "Existing web",
    provider: "web",
    boundary: { baseUrl: "https://example.test/" },
  });
  const resource = store.resources.intern({
    sourceId: source.id,
    address: { kind: "web", url: "https://example.test/entity" },
  }).resource;
  store.database.query(`
    INSERT INTO web_resource_state (
      resource_id, address_version, generation, source_snapshot_id,
      representation_id, freshness, checked_at, last_error
    ) VALUES (?, ?, 1, NULL, NULL, 'unknown', NULL, NULL)
  `).run(resource.id, resource.addressVersion);
  store.close();

  const database = new Database(path);
  database.exec("PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = ON;");
  database.transaction(() => {
    database.exec(`
      CREATE TABLE resource_sources_pre255 (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL CHECK (provider IN ('filesystem', 'web', 'github', 'application')),
        boundary_json TEXT NOT NULL,
        policy_json TEXT NOT NULL,
        root_binding TEXT,
        version INTEGER NOT NULL CHECK (version >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO resource_sources_pre255 SELECT * FROM resource_sources;
      CREATE TABLE resources_pre255 (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES resource_sources(id) ON DELETE RESTRICT,
        provider TEXT NOT NULL CHECK (provider IN ('filesystem', 'web', 'github', 'application')),
        address_json TEXT NOT NULL,
        canonical_key TEXT NOT NULL,
        media_type TEXT,
        address_version INTEGER NOT NULL CHECK (address_version >= 1),
        version INTEGER NOT NULL CHECK (version >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (source_id, canonical_key)
      );
      INSERT INTO resources_pre255 SELECT * FROM resources;
      DROP TABLE resources;
      DROP TABLE resource_sources;
      ALTER TABLE resource_sources_pre255 RENAME TO resource_sources;
      ALTER TABLE resources_pre255 RENAME TO resources;
      CREATE INDEX resource_sources_provider ON resource_sources(provider, name, id);
    `);
  })();
  database.close();

  store = new OutlinerStore(path);
  try {
    expect(store.resources.require(resource.id)).toMatchObject({
      id: resource.id,
      sourceId: source.id,
    });
    expect(store.database.query(
      "SELECT resource_id FROM web_resource_state WHERE resource_id = ?",
    ).get(resource.id)).toEqual({ resource_id: resource.id });
    expect(store.database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(store.resources.createSource({
      name: "Migrated Jira",
      provider: "jira",
      boundary: {
        origin: "https://issues.example.test",
        project: "PIE",
        credentialEnv: "TEST_JIRA_TOKEN",
      },
    }).provider).toBe("jira");
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
