import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { annotationSourceHash, createTextQuoteAnchor } from "../src/annotations";
import {
  RESOURCE_CAPABILITIES,
  RESOURCE_CAPABILITY_FACTORS,
  ResourceCatalogError,
  deriveResourceCapabilityReport,
  normalizeResourceAddress,
  type ResourceSource,
} from "../src/resources";
import { OutlinerStore } from "../src/store";
import {
  BasicWebMarkdownExtractor,
  type WebMarkdownExtractor,
} from "../src/web-markdown";

function withWorkspace(run: (root: string, store: OutlinerStore) => void): void {
  const root = mkdtempSync(join(tmpdir(), "outliner-resources-"));
  const store = new OutlinerStore(join(root, "workspace.sqlite"));
  try {
    run(root, store);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function expectCatalogError(
  operation: () => unknown,
  code: ResourceCatalogError["code"],
): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(ResourceCatalogError);
    expect((error as ResourceCatalogError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ResourceCatalogError: ${code}`);
}

function filesystemSource(store: OutlinerStore, name: string, root: string): ResourceSource {
  mkdirSync(root, { recursive: true });
  return store.resources.createSource({
    name,
    provider: "filesystem",
    boundary: { root },
  });
}

test("web Markdown preserves out-of-range numeric entities without aborting extraction", () => {
  const extractor = new BasicWebMarkdownExtractor();
  const markdown = extractor.extract({
    url: "https://example.com/",
    html: "<p>&#65; &#x41; &amp; &#1114111; &#x10ffff; &#1114112; &#x110000;</p>",
  });
  expect(markdown).toBe("A A & \u{10ffff} \u{10ffff} &#1114112; &#x110000;");
});

test("resource identity is source-scoped and persists independently of blocks", () => {
  withWorkspace((root, store) => {
    const firstSource = filesystemSource(store, "First", join(root, "first"));
    const secondSource = filesystemSource(store, "Second", join(root, "second"));
    const first = store.resources.intern({
      sourceId: firstSource.id,
      address: { kind: "filesystem", path: "notes/today.md" },
      mediaType: "text/markdown",
    });
    const repeated = store.resources.intern({
      sourceId: firstSource.id,
      address: { kind: "filesystem", path: "./notes/today.md" },
    });
    const second = store.resources.intern({
      sourceId: secondSource.id,
      address: { kind: "filesystem", path: "notes/today.md" },
    });

    expect(repeated).toEqual({ resource: first.resource, created: false });
    expect(second.resource.id).not.toBe(first.resource.id);
    expect(store.resources.require(first.resource.id).sourceId).toBe(firstSource.id);
    expect(store.get(first.resource.id)).toBeNull();
  });
});

test("filesystem interning creates a reusable source for the file's directory", () => {
  withWorkspace((root, store) => {
    const directory = join(root, "notes");
    const path = join(directory, "today.md");
    mkdirSync(directory);
    writeFileSync(path, "# Today\n");

    const first = store.resources.internFilesystem({
      path: "notes/today.md",
      mediaType: "text/markdown",
    });
    const repeated = store.resources.internFilesystem({ path });

    expect(first).toMatchObject({
      created: true,
      resource: {
        provider: "filesystem",
        address: { kind: "filesystem", path: "today.md" },
        mediaType: "text/markdown",
      },
    });
    expect(store.resources.requireSource(first.resource.sourceId)).toMatchObject({
      provider: "filesystem",
      boundary: { kind: "filesystem", root: directory },
    });
    expect(repeated).toEqual({ resource: first.resource, created: false });
  });
});

test("filesystem descriptions expose immutable text evidence and reject stale revisions", () => {
  withWorkspace((root, store) => {
    const directory = join(root, "notes");
    const path = join(directory, "today.md");
    mkdirSync(directory);
    writeFileSync(path, "# Today\n");
    const resource = store.resources.internFilesystem({
      path: "notes/today.md",
      mediaType: "text/markdown",
    }).resource;

    const first = store.resources.describe(resource.id, true);
    expect(first.filesystem).toMatchObject({
      text: "# Today\n",
      revision: {
        resourceId: resource.id,
        addressVersion: resource.addressVersion,
        revision: { kind: "filesystem", size: "8" },
      },
    });
    expect(first.capabilities.read.status).toBe("available");

    writeFileSync(path, "# Today\n\nChanged\n");
    expectCatalogError(
      () => store.resources.describe(resource.id, true, first.filesystem!.revision),
      "stale-revision",
    );
    const current = store.resources.describe(resource.id, true);
    expect(current.filesystem?.text).toBe("# Today\n\nChanged\n");
    expect(current.filesystem?.revision).not.toEqual(first.filesystem?.revision);
  });
});

test("filesystem annotation capture enforces Resource read policy", () => {
  withWorkspace((root, store) => {
    const directory = join(root, "restricted");
    mkdirSync(directory);
    const text = "Restricted evidence";
    writeFileSync(join(directory, "evidence.txt"), text);
    const source = store.resources.createSource({
      name: "Restricted",
      provider: "filesystem",
      boundary: { root: directory },
      policy: { deniedCapabilities: ["read"] },
    });
    const resource = store.resources.intern({
      sourceId: source.id,
      address: { kind: "filesystem", path: "evidence.txt" },
      mediaType: "text/plain",
    }).resource;

    expect(() => store.createAnnotation("restricted-annotation", {
      target: {
        representation: {
          id: "restricted-representation",
          subject: { kind: "resource", resourceId: resource.id },
          sourceSnapshot: {
            kind: "resource",
            resourceId: resource.id,
            sourceSnapshotId: null,
            revision: null,
          },
          adapter: { id: "filesystem.text", version: 1 },
          mediaType: "text/plain",
          contentHash: annotationSourceHash(text),
          capturedAt: "2026-01-01T00:00:00.000Z",
        },
        anchor: createTextQuoteAnchor(text, 0, text.length),
      },
      body: "Must not bypass policy.",
      source: "agent",
    }, "agent")).toThrow("Annotation Resource representation evidence is unavailable");
  });
});

test("relocation preserves identity and rejects stale or occupied destinations atomically", () => {
  withWorkspace((root, store) => {
    const source = filesystemSource(store, "Source", join(root, "source"));
    const destination = filesystemSource(store, "Destination", join(root, "destination"));
    const moving = store.resources.intern({
      sourceId: source.id,
      address: { kind: "filesystem", path: "draft.md" },
    }).resource;
    store.resources.intern({
      sourceId: destination.id,
      address: { kind: "filesystem", path: "occupied.md" },
    });

    const relocated = store.resources.relocate({
      resourceId: moving.id,
      expectedVersion: moving.version,
      destinationSourceId: destination.id,
      address: { kind: "filesystem", path: "archive/final.md" },
    });
    expect(relocated).toMatchObject({
      id: moving.id,
      sourceId: destination.id,
      version: moving.version + 1,
      addressVersion: moving.addressVersion + 1,
      address: { kind: "filesystem", path: "archive/final.md" },
    });

    expectCatalogError(() => store.resources.relocate({
      resourceId: relocated.id,
      expectedVersion: moving.version,
      destinationSourceId: source.id,
      address: { kind: "filesystem", path: "stale.md" },
    }), "version-conflict");
    expect(store.resources.require(moving.id)).toEqual(relocated);

    expectCatalogError(() => store.resources.relocate({
      resourceId: relocated.id,
      expectedVersion: relocated.version,
      destinationSourceId: destination.id,
      address: { kind: "filesystem", path: "occupied.md" },
    }), "address-conflict");
    expect(store.resources.require(moving.id)).toEqual(relocated);
  });
});

test("filesystem confinement rejects traversal, symlinks, and root identity drift", () => {
  withWorkspace((root, store) => {
    const sourceRoot = join(root, "source");
    const outside = join(root, "outside");
    mkdirSync(outside);
    const source = filesystemSource(store, "Files", sourceRoot);

    expectCatalogError(() => store.resources.intern({
      sourceId: source.id,
      address: { kind: "filesystem", path: "../outside/secret.txt" },
    }), "outside-source");

    symlinkSync(outside, join(sourceRoot, "linked"));
    expectCatalogError(() => store.resources.intern({
      sourceId: source.id,
      address: { kind: "filesystem", path: "linked/secret.txt" },
    }), "symlink-disallowed");

    const missing = store.resources.intern({
      sourceId: source.id,
      address: { kind: "filesystem", path: "future/nested/file.md" },
    }).resource;
    expect(missing.address).toEqual({ kind: "filesystem", path: "future/nested/file.md" });

    renameSync(sourceRoot, `${sourceRoot}-moved`);
    expectCatalogError(() => store.resources.intern({
      sourceId: source.id,
      address: { kind: "filesystem", path: "after-drift.md" },
    }), "source-unavailable");
  });
});

test("provider boundaries and revisions remain provider-qualified", () => {
  withWorkspace((_root, store) => {
    const source = store.resources.createSource({
      name: "Docs",
      provider: "web",
      boundary: { baseUrl: "https://example.com/docs/" },
    });
    const resource = store.resources.intern({
      sourceId: source.id,
      address: { kind: "web", url: "https://example.com/docs/guide" },
    }).resource;

    expectCatalogError(() => normalizeResourceAddress(
      source,
      { kind: "web", url: "https://example.com/other" },
    ), "outside-source");

    const revision = {
      resourceId: resource.id,
      addressVersion: resource.addressVersion,
      revision: {
        kind: "web" as const,
        validator: { kind: "etag" as const, value: "abc", weak: false },
      },
    };
    expect(store.resources.describe(resource.id, true, revision).requestedRevision).toEqual(revision);
    expectCatalogError(() => store.resources.describe(resource.id, true, {
      ...revision,
      addressVersion: resource.addressVersion + 1,
    }), "stale-revision");

    const githubSource = store.resources.createSource({
      name: "Repository",
      provider: "github",
      boundary: { owner: "float", repository: "outliner" },
    });
    const issue = store.resources.intern({
      sourceId: githubSource.id,
      address: { kind: "github", entity: "issue", number: 247 },
    }).resource;
    const githubDescription = store.resources.describe(issue.id, true, {
      resourceId: issue.id,
      addressVersion: issue.addressVersion,
      revision: {
        kind: "github",
        validator: { kind: "updated-at", value: "2026-09-17T04:00:00Z" },
      },
    });
    expect(githubDescription.requestedRevision).toMatchObject({
      revision: {
        validator: { kind: "updated-at", value: "2026-09-17T04:00:00.000Z" },
      },
    });
  });
});

test("capability reports preserve every causal factor and unknown facts never grant access", () => {
  const source: ResourceSource = {
    id: "20000000-0000-4000-8000-000000000001",
    name: "Remote docs",
    provider: "web",
    boundary: { kind: "web", baseUrl: "https://example.com/docs/" },
    policy: { deniedCapabilities: ["embed"] },
    version: 1,
    createdAt: "2026-09-17T00:00:00.000Z",
    updatedAt: "2026-09-17T00:00:00.000Z",
  };
  const report = deriveResourceCapabilityReport(source, true);

  expect(Object.keys(report)).toEqual([...RESOURCE_CAPABILITIES]);
  for (const capability of RESOURCE_CAPABILITIES) {
    expect(Object.keys(report[capability].factors)).toEqual([...RESOURCE_CAPABILITY_FACTORS]);
  }
  expect(report.read.status).toBe("unavailable");
  expect(report.read.factors.credentials.state).toBe("unknown");
  expect(report.read.factors.connectivity.state).toBe("unknown");
  expect(report.read.factors["destination-host"]).toMatchObject({
    state: "blocked",
    reason: "implementation-not-installed",
  });
  expect(report.embed.factors["workspace-policy"]).toMatchObject({
    state: "blocked",
    reason: "policy-denied",
  });
});

test("web refresh owns immutable history, five-state freshness, and local-only open", async () => {
  const root = mkdtempSync(join(tmpdir(), "outliner-web-resource-"));
  const database = join(root, "workspace.sqlite");
  let online = true;
  let etag = '"v1"';
  let html = "<html><body><h1>First</h1><p>Stable quote in version one.</p></body></html>";
  let requests = 0;
  let clock = Date.parse("2026-09-17T12:00:00.000Z");
  let releaseFirstRequest: (() => void) | null = null;
  const firstRequestGate = new Promise<void>((resolve) => {
    releaseFirstRequest = resolve;
  });
  const requestEtags: Array<string | null> = [];
  const fetcher = async (
    _input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    requests += 1;
    if (requests === 1) await firstRequestGate;
    if (!online) throw new Error("fixture offline");
    const requestEtag = new Headers(init?.headers).get("if-none-match");
    requestEtags.push(requestEtag);
    if (requestEtag === etag) return new Response(null, { status: 304 });
    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        etag,
      },
    });
  };
  let store = new OutlinerStore(database, {
    fetch: fetcher as typeof fetch,
    now: () => new Date(clock).toISOString(),
    webStaleAfterMs: 1_000,
  });
  try {
    const source = store.resources.createSource({
      name: "Fixture",
      provider: "web",
      boundary: { baseUrl: "https://example.com/articles/" },
    });
    const resource = store.resources.intern({
      sourceId: source.id,
      address: { kind: "web", url: "https://example.com/articles/one" },
    }).resource;

    const empty = await store.resources.open(resource.id, true);
    expect(empty.web).toBeNull();
    expect(empty.webStatus).toEqual({
      freshness: "unknown",
      checkedAt: null,
      lastError: null,
    });
    expect(requests).toBe(0);

    const pending = store.resources.refreshWeb(resource.id, true);
    expect(store.resources.describe(resource.id, true).webStatus?.freshness).toBe(
      "refreshing",
    );
    releaseFirstRequest!();
    const first = await pending;
    expect(first.webStatus?.freshness).toBe("fresh");
    expect(first.web?.markdown).toBe("# First\n\nStable quote in version one.");
    expect(first.web?.sourceSnapshot).toMatchObject({
      resourceId: resource.id,
      addressVersion: 1,
      canonicalUrl: "https://example.com/articles/one",
      bodyAvailable: true,
    });
    expect(first.web?.representation).toMatchObject({
      sourceSnapshotId: first.web!.sourceSnapshot.id,
      mediaType: "text/markdown",
      contentAvailable: true,
    });
    expect(first.webHistory?.sourceSnapshots).toHaveLength(1);
    expect(first.webHistory?.representations).toHaveLength(1);

    const local = await store.resources.open(resource.id, true);
    expect(local.web?.representation.id).toBe(first.web?.representation.id);
    expect(requests).toBe(1);
    clock += 1_001;
    expect(store.resources.describe(resource.id, true).webStatus?.freshness).toBe(
      "stale",
    );

    const unchanged = await store.resources.refreshWeb(resource.id, true);
    expect(requestEtags.at(-1)).toBe('"v1"');
    expect(unchanged.webStatus?.freshness).toBe("fresh");
    expect(unchanged.web?.sourceSnapshot.id).toBe(first.web?.sourceSnapshot.id);
    expect(unchanged.web?.representation.id).toBe(first.web?.representation.id);
    expect(unchanged.webHistory?.sourceSnapshots).toHaveLength(1);
    expect(unchanged.webHistory?.representations).toHaveLength(1);

    etag = '"v1-new-validator"';
    clock += 1_000;
    const sameBody = await store.resources.refreshWeb(resource.id, true);
    expect(sameBody.web?.sourceSnapshot.id).not.toBe(first.web?.sourceSnapshot.id);
    expect(sameBody.web?.representation.id).not.toBe(first.web?.representation.id);
    expect(sameBody.webHistory?.sourceSnapshots).toHaveLength(2);
    expect(sameBody.webHistory?.representations).toHaveLength(2);


    etag = '"v2"';
    html = "<html><body><h1>Second</h1><p>Changed page without the old passage.</p></body></html>";
    clock += 1_000;
    const changed = await store.resources.refreshWeb(resource.id, true);
    expect(changed.web?.markdown).toBe("# Second\n\nChanged page without the old passage.");
    expect(changed.web?.sourceSnapshot.id).not.toBe(first.web?.sourceSnapshot.id);
    expect(changed.web?.representation.id).not.toBe(first.web?.representation.id);
    expect(changed.webHistory?.sourceSnapshots).toHaveLength(3);
    expect(changed.webHistory?.representations).toHaveLength(3);

    online = false;
    clock += 1_000;
    const failed = await store.resources.refreshWeb(resource.id, true);
    expect(failed.webStatus).toMatchObject({
      freshness: "failed",
      lastError: "fixture offline",
    });
    expect(failed.web?.markdown).toBe(changed.web?.markdown);
    expect(failed.web?.representation.id).toBe(changed.web?.representation.id);

    store.close();
    online = true;
    const basicExtractor = new BasicWebMarkdownExtractor();
    const replacementExtractor: WebMarkdownExtractor = {
      adapter: { id: "fixture.markdown", version: 2 },
      extract: (snapshot) => `Replacement\n\n${basicExtractor.extract(snapshot)}`,
    };
    store = new OutlinerStore(database, {
      fetch: fetcher as typeof fetch,
      webExtractor: replacementExtractor,
      now: () => new Date(clock).toISOString(),
      webStaleAfterMs: 1_000,
    });
    const beforeReopen = requests;
    const reopened = await store.resources.open(resource.id, true);
    expect(requests).toBe(beforeReopen);
    expect(reopened.web?.representation.id).toBe(changed.web?.representation.id);
    const rederived = await store.resources.refreshWeb(resource.id, true);
    expect(rederived.web?.sourceSnapshot.id).toBe(changed.web?.sourceSnapshot.id);
    expect(rederived.web?.representation.id).not.toBe(changed.web?.representation.id);
    expect(rederived.web?.representation.adapter).toEqual({
      id: "fixture.markdown",
      version: 2,
    });
    expect(rederived.webHistory?.sourceSnapshots).toHaveLength(3);
    expect(rederived.webHistory?.representations).toHaveLength(4);

    store.database.query("UPDATE resource_sources SET policy_json = ? WHERE id = ?")
      .run(JSON.stringify({ deniedCapabilities: ["read"] }), source.id);
    expect(store.resources.describe(resource.id, true).web).toBeNull();
    expect(store.resources.describe(resource.id, true).webHistory).toBeNull();
    expect(await store.resources.open(resource.id, true)).toMatchObject({
      web: null,
      webError: "Workspace policy denies reading this resource",
    });
    await expect(store.resources.refreshWeb(resource.id, true)).rejects.toThrow(
      "Workspace policy denies reading or refreshing this resource",
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("web relocation preserves history and invalidates an in-flight refresh", async () => {
  const root = mkdtempSync(join(tmpdir(), "outliner-web-relocation-"));
  let etag = '"before"';
  let html = "<p>Before relocation</p>";
  let gate: Promise<void> | null = null;
  let release: (() => void) | null = null;
  const store = new OutlinerStore(join(root, "workspace.sqlite"), {
    fetch: (async (_input, init) => {
      if (gate) await gate;
      if (new Headers(init?.headers).get("if-none-match") === etag) {
        return new Response(null, { status: 304 });
      }
      return new Response(html, {
        headers: { "content-type": "text/html", etag },
      });
    }) as typeof fetch,
  });
  try {
    const source = store.resources.createSource({
      name: "Relocation",
      provider: "web",
      boundary: { baseUrl: "https://example.com/" },
    });
    const resource = store.resources.intern({
      sourceId: source.id,
      address: { kind: "web", url: "https://example.com/before" },
    }).resource;
    const before = await store.resources.refreshWeb(resource.id, true);
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = store.resources.refreshWeb(resource.id, true);
    const relocated = store.resources.relocate({
      resourceId: resource.id,
      expectedVersion: resource.version,
      destinationSourceId: source.id,
      address: { kind: "web", url: "https://example.com/after" },
    });
    const afterRelocation = store.resources.describe(resource.id, true);
    expect(afterRelocation).toMatchObject({
      web: null,
      webStatus: { freshness: "unknown" },
    });
    expect(afterRelocation.webHistory?.sourceSnapshots).toHaveLength(1);
    expect(afterRelocation.webHistory?.representations).toHaveLength(1);
    release!();
    await expect(pending).rejects.toMatchObject({ code: "version-conflict" });

    gate = null;
    etag = '"after"';
    html = "<p>After relocation</p>";
    const after = await store.resources.refreshWeb(relocated.id, true);
    expect(after.web?.sourceSnapshot.addressVersion).toBe(2);
    expect(after.webHistory?.sourceSnapshots).toHaveLength(2);
    expect(after.webHistory?.sourceSnapshots.some(
      (snapshot) => snapshot.id === before.web?.sourceSnapshot.id,
    )).toBe(true);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("PIE-251 web cache migration preserves current snapshot and representation", async () => {
  const root = mkdtempSync(join(tmpdir(), "outliner-web-migration-"));
  const path = join(root, "workspace.sqlite");
  let store = new OutlinerStore(path, {
    fetch: (async () =>
      new Response("<p>Current evidence</p>", {
        headers: { "content-type": "text/html", etag: '"current"' },
      })) as unknown as typeof fetch,
  });
  const source = store.resources.createSource({
    name: "Migration",
    provider: "web",
    boundary: { baseUrl: "https://example.com/" },
  });
  const resource = store.resources.intern({
    sourceId: source.id,
    address: { kind: "web", url: "https://example.com/page" },
  }).resource;
  const current = await store.resources.refreshWeb(resource.id, true);
  store.close();

  const database = new Database(path);
  try {
    database.exec(`
      DROP TABLE web_resource_state;
      DROP TABLE web_representations;
      DROP TABLE web_source_snapshots;
      CREATE TABLE web_resource_documents (
        resource_id TEXT PRIMARY KEY,
        address_version INTEGER NOT NULL,
        generation INTEGER NOT NULL,
        canonical_url TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        markdown TEXT NOT NULL,
        revision_json TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        adapter_version INTEGER NOT NULL,
        representation_hash TEXT NOT NULL,
        etag TEXT,
        last_modified TEXT,
        freshness TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        checked_at TEXT NOT NULL,
        last_error TEXT
      );
    `);
    const representationEvidence = {
      mediaType: "text/markdown",
      adapter: current.web!.representation.adapter,
      contentHash: current.web!.representation.contentHash,
    };
    database.query(`
      INSERT INTO web_resource_documents (
        resource_id, address_version, generation, canonical_url, source_hash,
        markdown, revision_json, adapter_id, adapter_version,
        representation_hash, etag, last_modified, freshness, fetched_at,
        checked_at, last_error
      ) VALUES (?, 1, 7, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'fresh', ?, ?, NULL)
    `).run(
      resource.id,
      current.web!.sourceSnapshot.canonicalUrl,
      current.web!.sourceSnapshot.contentHash,
      current.web!.markdown,
      JSON.stringify(current.web!.sourceSnapshot.revision),
      representationEvidence.adapter.id,
      representationEvidence.adapter.version,
      representationEvidence.contentHash,
      '"current"',
      current.web!.sourceSnapshot.fetchedAt,
      current.webStatus!.checkedAt,
    );
  } finally {
    database.close();
  }

  store = new OutlinerStore(path, {
    fetch: (() => {
      throw new Error("migration open must remain local");
    }) as unknown as typeof fetch,
  });
  try {
    const migrated = await store.resources.open(resource.id, true);
    expect(migrated.webHistory?.sourceSnapshots).toHaveLength(1);
    expect(migrated.webHistory?.representations).toHaveLength(1);
    expect(migrated.web?.sourceSnapshot.bodyAvailable).toBe(false);
    expect(migrated.web?.representation.contentAvailable).toBe(true);
    const migratedSnapshotIds = migrated.webHistory!.sourceSnapshots.map(
      (snapshot) => snapshot.id,
    );
    const migratedRepresentationIds = migrated.webHistory!.representations.map(
      (representation) => representation.id,
    );
    expect(store.database.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'web_resource_documents'",
    ).get()).toBeNull();
    store.database.query(
      "UPDATE web_resource_state SET freshness = 'refreshing' WHERE resource_id = ?",
    ).run(resource.id);
    store.close();
    store = new OutlinerStore(path, {
      fetch: (() => {
        throw new Error("recovery must remain local");
      }) as unknown as typeof fetch,
    });
    expect(store.resources.describe(resource.id, true)).toMatchObject({
      web: { markdown: "Current evidence" },
      webStatus: {
        freshness: "failed",
        lastError: "Refresh interrupted before completion",
      },
    });
    const reopenedMigration = store.resources.describe(resource.id, true);
    expect(reopenedMigration.webHistory?.sourceSnapshots.map(
      (snapshot) => snapshot.id,
    )).toEqual(migratedSnapshotIds);
    expect(reopenedMigration.webHistory?.representations.map(
      (representation) => representation.id,
    )).toEqual(migratedRepresentationIds);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("web refresh preserves redirect confinement and canonical extraction context", async () => {
  const root = mkdtempSync(join(tmpdir(), "outliner-web-redirect-"));
  const html = '<html><body><a href="./next">Next</a></body></html>';
  let finalPath = "/first/page";
  const store = new OutlinerStore(join(root, "workspace.sqlite"), {
    fetch: (async (input, init) => {
      if (String(input).endsWith("/entry")) {
        return new Response(null, {
          status: 302,
          headers: { location: finalPath },
        });
      }
      if (new Headers(init?.headers).get("if-none-match") === '"stable"') {
        return new Response(null, { status: 304 });
      }
      return new Response(html, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          etag: '"stable"',
        },
      });
    }) as typeof fetch,
  });
  try {
    const source = store.resources.createSource({
      name: "Redirect",
      provider: "web",
      boundary: { baseUrl: "https://example.com/" },
    });
    const resource = store.resources.intern({
      sourceId: source.id,
      address: { kind: "web", url: "https://example.com/entry" },
    }).resource;
    const first = await store.resources.refreshWeb(resource.id, true);
    expect(first.web?.markdown).toBe("[Next](https://example.com/first/next)");
    expect(first.web?.sourceSnapshot.canonicalUrl).toBe(
      "https://example.com/first/page",
    );

    finalPath = "/second/page";
    const redirected = await store.resources.refreshWeb(resource.id, true);
    expect(redirected.web?.markdown).toBe("[Next](https://example.com/second/next)");
    expect(redirected.web?.sourceSnapshot.canonicalUrl).toBe(
      "https://example.com/second/page",
    );
    expect(redirected.webHistory?.sourceSnapshots).toHaveLength(2);
    const pinned = await store.resources.open(
      resource.id,
      true,
      redirected.web!.sourceSnapshot.revision,
    );
    expect(pinned.web?.sourceSnapshot.id).toBe(redirected.web?.sourceSnapshot.id);
    expect(pinned.web?.markdown).toBe("[Next](https://example.com/second/next)");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("web refresh validates redirects before requests and stops oversized streams", async () => {
  const root = mkdtempSync(join(tmpdir(), "outliner-web-boundary-"));
  const requested: string[] = [];
  let chunks = 0;
  let rejectedCancellations = 0;
  const rejectedBody = (): ReadableStream<Uint8Array> =>
    new ReadableStream({
      cancel() {
        rejectedCancellations += 1;
      },
    });
  const store = new OutlinerStore(join(root, "workspace.sqlite"), {
    maximumWebBytes: 10,
    fetch: (async (input) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith("/redirect")) {
        return new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/private" },
        });
      }
      if (url.endsWith("/status")) {
        return new Response(rejectedBody(), { status: 500 });
      }
      if (url.endsWith("/binary")) {
        return new Response(rejectedBody(), {
          headers: { "content-type": "application/octet-stream" },
        });
      }
      if (url.endsWith("/declared-large")) {
        return new Response(rejectedBody(), {
          headers: { "content-type": "text/html", "content-length": "11" },
        });
      }
      return new Response(new ReadableStream({
        pull(controller) {
          chunks += 1;
          controller.enqueue(new Uint8Array(8));
        },
      }), {
        headers: { "content-type": "text/html" },
      });
    }) as typeof fetch,
  });
  try {
    const source = store.resources.createSource({
      name: "Boundary",
      provider: "web",
      boundary: { baseUrl: "https://example.com/" },
    });
    const redirect = store.resources.intern({
      sourceId: source.id,
      address: { kind: "web", url: "https://example.com/redirect" },
    }).resource;
    const redirected = await store.resources.refreshWeb(redirect.id, true);
    expect(redirected.web).toBeNull();
    expect(redirected.webStatus?.lastError).toContain("outside its source boundary");
    expect(requested).toEqual(["https://example.com/redirect"]);
    for (
      const [path, error] of [
        ["/status", "Web provider returned HTTP 500"],
        ["/binary", "Web provider returned unsupported media type"],
        ["/declared-large", "Web response exceeds 10 bytes"],
      ] as const
    ) {
      const rejected = store.resources.intern({
        sourceId: source.id,
        address: { kind: "web", url: `https://example.com${path}` },
      }).resource;
      expect(
        (await store.resources.refreshWeb(rejected.id, true)).webStatus?.lastError,
      ).toContain(error);
    }
    expect(rejectedCancellations).toBe(3);


    const large = store.resources.intern({
      sourceId: source.id,
      address: { kind: "web", url: "https://example.com/large" },
    }).resource;
    const oversized = await store.resources.refreshWeb(large.id, true);
    expect(oversized.webStatus?.lastError).toBe("Web response exceeds 10 bytes");
    expect(chunks).toBeLessThanOrEqual(3);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
