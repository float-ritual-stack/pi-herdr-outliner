import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutlinerStore } from "../src/store";
import { Type } from "typebox";
import { ComputedProducerRegistry, defineComputedProducer } from "../src/computed-resources";
import { DefaultRemoteEntityProviderClient } from "../src/remote-entity";

test("a second writable store cannot recover another owner's live web refresh", async () => {
  const root = mkdtempSync(join(tmpdir(), "outliner-ownership-"));
  const path = join(root, "outliner.sqlite");
  const response = Promise.withResolvers<Response>();
  const owner = new OutlinerStore(path, {
    fetch: (() => response.promise) as unknown as typeof fetch,
  });
  let contender: OutlinerStore | undefined;
  let rejected: unknown;
  let pending: ReturnType<typeof owner.resources.refreshWeb> | undefined;
  try {
    const source = owner.resources.createSource({
      name: "Ownership fixture",
      provider: "web",
      boundary: { baseUrl: "https://example.com/" },
    });
    const { resource } = owner.resources.intern({
      sourceId: source.id,
      address: { kind: "web", url: "https://example.com/ownership" },
    });
    pending = owner.resources.refreshWeb(resource.id, true);
    const sequence = owner.sequence;
    try {
      contender = new OutlinerStore(path);
    } catch (error) {
      rejected = error;
    }
    const stateAfterAttempt = owner.resources.describe(resource.id, true);
    const sequenceAfterAttempt = owner.sequence;
    response.resolve(new Response("<h1>Original owner's result</h1>", {
      headers: { "content-type": "text/html" },
    }));
    const result = await pending;

    expect(stateAfterAttempt.webStatus?.freshness).toBe("refreshing");
    expect(rejected).toBeInstanceOf(Error);
    expect(sequenceAfterAttempt).toBe(sequence);
    expect(result.webStatus?.freshness).toBe("fresh");
    expect(result.web?.markdown).toBe("# Original owner's result");
  } finally {
    response.resolve(new Response("cleanup"));
    await Promise.allSettled([pending]);
    contender?.close();
    owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a competing owner cannot interrupt computed execution or remote entity refresh", async () => {
  const root = mkdtempSync(join(tmpdir(), "outliner-ownership-providers-"));
  const path = join(root, "outliner.sqlite");
  const release = Promise.withResolvers<void>();
  const executing = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();
  const pending: Promise<unknown>[] = [];
  const registry = new ComputedProducerRegistry([defineComputedProducer({
    id: "fixture.ownership",
    version: 1,
    inputSchema: Type.Object({}),
    permissions: [],
    determinism: "nondeterministic",
    cachePolicy: "none",
    outputMediaTypes: ["text/markdown"],
    async execute() {
      executing.resolve();
      await release.promise;
      return { kind: "immutable-snapshot", mediaType: "text/markdown", content: "Owner result" };
    },
  })]);
  const owner = new OutlinerStore(path, {
    computedProducerRegistry: registry,
    remoteEntityClient: new DefaultRemoteEntityProviderClient({
      fetch: (() => response.promise) as unknown as typeof fetch,
      resolveCredential: () => "fixture-only",
    }),
  });
  try {
    const computedSource = owner.resources.createSource({
      name: "Computed fixture", provider: "computed",
      boundary: { registry: "fixtures", allowedPermissions: [] },
    });
    const invocation = owner.resources.createComputedInvocation({
      sourceId: computedSource.id, producerId: "fixture.ownership", inputs: {}, dependencies: [],
    });
    const remoteSource = owner.resources.createSource({
      name: "Remote fixture", provider: "jira",
      boundary: { origin: "https://example.com", project: "OWN", credentialEnv: "FIXTURE_TOKEN" },
    });
    const remote = owner.resources.intern({
      sourceId: remoteSource.id,
      address: { kind: "jira", entityId: "10001", key: "OWN-1" },
    }).resource;
    const computation = owner.resources.executeComputedResource(invocation.resourceId, true);
    const refresh = owner.resources.refreshRemoteEntity(remote.id, true);
    pending.push(computation, refresh);
    await executing.promise;
    const sequence = owner.sequence;
    let contender: OutlinerStore | undefined;
    try {
      expect(() => { contender = new OutlinerStore(path); }).toThrow("already owned");
    } finally {
      contender?.close();
    }
    expect(owner.sequence).toBe(sequence);
    expect(owner.resources.describe(invocation.resourceId, true).computedStatus?.state).toBe("executing");
    expect(owner.resources.describe(remote.id, true).remoteStatus?.freshness).toBe("refreshing");
    release.resolve();
    response.resolve(Response.json({
      id: "10001", key: "OWN-1",
      fields: {
        summary: "Owner remote result", description: null, status: null, issuetype: null,
        priority: null, assignee: null, labels: [], updated: "2026-09-19T12:00:00.000Z",
      },
    }));
    expect((await computation).output.kind).toBe("immutable-snapshot");
    const refreshed = await refresh;
    expect(refreshed.remoteStatus?.freshness).toBe("fresh");
    expect(refreshed.remoteEntity?.title).toBe("Owner remote result");
  } finally {
    release.resolve();
    response.resolve(new Response("cleanup", { status: 500 }));
    await Promise.allSettled(pending);
    owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ownership follows filesystem aliases, permits read-only observation, and releases on close", () => {
  const root = mkdtempSync(join(tmpdir(), "outliner-ownership-alias-"));
  const path = join(root, "outliner.sqlite");
  const alias = join(root, "alias.sqlite");
  const owner = new OutlinerStore(path);
  try {
    const block = owner.create("Retained canonical text");
    symlinkSync(path, alias);
    let contender: OutlinerStore | undefined;
    try {
      expect(() => { contender = new OutlinerStore(alias); }).toThrow("already owned");
    } finally {
      contender?.close();
    }
    const observer = new Database(path, { readonly: true, create: false });
    try {
      expect(observer.query("SELECT text FROM blocks WHERE id = ?").get(block.id)).toEqual({ text: block.text });
    } finally {
      observer.close();
    }
    owner.close();
    const successor = new OutlinerStore(alias);
    try {
      expect(successor.get(block.id)?.text).toBe(block.text);
    } finally {
      successor.close();
    }
  } finally {
    owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed store initialization releases ownership for a valid retry", () => {
  const root = mkdtempSync(join(tmpdir(), "outliner-ownership-failure-"));
  const path = join(root, "outliner.sqlite");
  try {
    expect(() => new OutlinerStore(path, { webStaleAfterMs: -1 })).toThrow("Web stale age");
    const owner = new OutlinerStore(path);
    try {
      expect(owner.create("Retry succeeded").text).toBe("Retry succeeded");
    } finally {
      owner.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
