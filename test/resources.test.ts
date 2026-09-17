import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RESOURCE_CAPABILITIES,
  RESOURCE_CAPABILITY_FACTORS,
  ResourceCatalogError,
  deriveResourceCapabilityReport,
  normalizeResourceAddress,
  type ResourceSource,
} from "../src/resources";
import { OutlinerStore } from "../src/store";
import { BasicWebMarkdownExtractor } from "../src/web-markdown";

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

test("web resources cache Markdown, refresh conditionally, and retain annotation evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "outliner-web-resource-"));
  const database = join(root, "workspace.sqlite");
  let online = true;
  let etag = "\"v1\"";
  let html = "<html><body><h1>First</h1><p>Stable quote in version one.</p></body></html>";
  let requests = 0;
  const requestEtags: Array<string | null> = [];
  let clock = Date.parse("2026-09-17T12:00:00.000Z");
  const fetcher = async (
    _input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    requests += 1;
    if (!online) throw new Error("fixture offline");
    const requestEtag = new Headers(init?.headers).get("if-none-match");
    requestEtags.push(requestEtag);
    if (requestEtag === etag) return new Response(null, { status: 304 });
    return new Response(html, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        etag,
      },
    });
  };
  const options = {
    fetch: fetcher as typeof fetch,
    now: () => new Date(clock += 1_000).toISOString(),
  };
  let store = new OutlinerStore(database, options);
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

    const first = await store.resources.open(resource.id, true);
    expect(first.web?.markdown).toBe("# First\n\nStable quote in version one.");
    expect(first.web?.freshness).toBe("fresh");
    expect(first.web?.canonicalUrl).toBe("https://example.com/articles/one");
    expect(requests).toBe(1);

    online = false;
    const offline = await store.resources.open(resource.id, true);
    expect(offline.web?.markdown).toBe(first.web?.markdown);
    expect(requests).toBe(1);
    online = true;

    const unchanged = await store.resources.refreshWeb(resource.id, true);
    expect(requestEtags.at(-1)).toBe("\"v1\"");
    expect(unchanged.web?.fetchedAt).toBe(first.web?.fetchedAt);
    expect(unchanged.web?.checkedAt).not.toBe(first.web?.checkedAt);

    const markdown = unchanged.web!.markdown;
    const start = markdown.indexOf("Stable quote");
    const end = start + "Stable quote".length;
    const annotation = store.resources.createWebAnnotation({
      resourceId: resource.id,
      revision: unchanged.web!.revision,
      representation: unchanged.web!.representation,
      anchor: {
        start,
        end,
        exact: markdown.slice(start, end),
        prefix: markdown.slice(Math.max(0, start - 64), start),
        suffix: markdown.slice(end, end + 64),
      },
      body: "This evidence must survive refresh.",
    });

    etag = "\"v2\"";
    html = "<html><body><h1>Second</h1><p>Changed page without the old passage.</p></body></html>";
    const changed = await store.resources.refreshWeb(resource.id, true);
    expect(changed.resource.id).toBe(resource.id);
    expect(changed.web?.markdown).toBe("# Second\n\nChanged page without the old passage.");
    expect(changed.web?.annotations).toHaveLength(1);
    expect(changed.web?.annotations[0]).toEqual(annotation);
    expect(changed.web?.annotations[0]?.representation.contentHash).toBe(
      unchanged.web?.representation.contentHash,
    );

    online = false;
    const failed = await store.resources.refreshWeb(resource.id, true);
    expect(failed.web).toMatchObject({
      freshness: "failed",
      markdown: "# Second\n\nChanged page without the old passage.",
      lastError: "fixture offline",
    });

    store.close();
    store = new OutlinerStore(database, {
      fetch: (() => {
        throw new Error("cached reopen must not fetch");
      }) as unknown as typeof fetch,
    });
    const reopened = await store.resources.open(resource.id, true);
    expect(reopened.web?.markdown).toBe(changed.web?.markdown);
    expect(reopened.web?.annotations[0]?.anchor.exact).toBe("Stable quote");

    store.database.query("UPDATE resource_sources SET policy_json = ? WHERE id = ?")
      .run(JSON.stringify({ deniedCapabilities: ["read"] }), source.id);
    expect(store.resources.describe(resource.id, true).web).toBeNull();
    const denied = await store.resources.open(resource.id, true);
    expect(denied).toMatchObject({
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

test("web refresh validates redirects before requests and stops oversized streams", async () => {
  const root = mkdtempSync(join(tmpdir(), "outliner-web-boundary-"));
  const requested: string[] = [];
  let chunks = 0;
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
    const redirected = await store.resources.open(redirect.id, true);
    expect(redirected.web).toBeNull();
    expect(redirected.webError).toContain("outside its source boundary");
    expect(requested).toEqual(["https://example.com/redirect"]);

    const large = store.resources.intern({
      sourceId: source.id,
      address: { kind: "web", url: "https://example.com/large" },
    }).resource;
    const oversized = await store.resources.open(large.id, true);
    expect(oversized.webError).toBe("Web response exceeds 10 bytes");
    expect(chunks).toBeLessThanOrEqual(3);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
