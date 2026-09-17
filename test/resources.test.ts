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
