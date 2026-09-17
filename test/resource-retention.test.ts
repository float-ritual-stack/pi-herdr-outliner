import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTextQuoteAnchor } from "../src/annotations";
import { OutlinerStore } from "../src/store";
import {
  BasicWebMarkdownExtractor,
  type WebMarkdownExtractor,
} from "../src/web-markdown";
import type {
  AnnotationRepresentation,
  ResourceDescription,
  ResourceRetentionArtifact,
} from "../src/types";

function annotationRepresentation(description: ResourceDescription): AnnotationRepresentation {
  const web = description.web;
  if (!web) throw new Error("Fixture web representation is unavailable");
  const capturedAt = web.representation.derivedAt ?? web.sourceSnapshot.fetchedAt;
  if (!capturedAt) throw new Error("Fixture web representation has no capture time");
  return {
    id: web.representation.id,
    subject: { kind: "resource", resourceId: description.resource.id },
    sourceSnapshot: {
      kind: "resource",
      resourceId: description.resource.id,
      sourceSnapshotId: web.sourceSnapshot.id,
      revision: web.sourceSnapshot.revision,
    },
    adapter: web.representation.adapter,
    mediaType: web.representation.mediaType,
    contentHash: web.representation.contentHash,
    capturedAt,
  };
}

function artifact(
  artifacts: readonly ResourceRetentionArtifact[],
  kind: ResourceRetentionArtifact["artifact"]["kind"],
  id: string,
): ResourceRetentionArtifact {
  const result = artifacts.find((candidate) =>
    candidate.artifact.kind === kind && candidate.artifact.id === id
  );
  if (!result) throw new Error(`Missing retention artifact ${kind} ${id}`);
  return result;
}

test("collects unreachable web history while preserving current, pinned, published, and annotation evidence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-retention-"));
  const databasePath = join(directory, "outliner.sqlite");
  let now = "2026-09-17T12:00:00.000Z";
  let version = 1;
  let providerAccessCount = 0;
  const options = {
    now: () => now,
    fetch: (async (_input: string | URL | Request, _init?: RequestInit) => {
      providerAccessCount += 1;
      return new Response(`<h1>Revision ${version}</h1><p>Protected claim ${version}.</p>`, {
        headers: { "content-type": "text/html", etag: `"v${version}"` },
      });
    }) as typeof fetch,
  };
  let store = new OutlinerStore(databasePath, options);
  try {
    const source = store.resources.createSource({
      name: "Retention fixture",
      provider: "web",
      boundary: { baseUrl: "https://example.com/" },
    });
    const resource = store.resources.intern({
      sourceId: source.id,
      address: { kind: "web", url: "https://example.com/history" },
    }).resource;
    const revisions: ResourceDescription[] = [];
    for (version = 1; version <= 5; version += 1) {
      now = `2026-09-17T12:0${version}:00.000Z`;
      revisions.push(await store.resources.refreshWeb(resource.id, true));
    }
    const first = revisions[0]!;
    const second = revisions[1]!;
    const third = revisions[2]!;
    const fourth = revisions[3]!;
    const current = revisions[4]!;
    if (!first.web || !second.web || !third.web || !fourth.web || !current.web) {
      throw new Error("Fixture refresh did not create retained web history");
    }

    const firstRepresentation = annotationRepresentation(first);
    const quoteStart = first.web.markdown.indexOf("Protected claim 1");
    const annotation = store.annotations.create(
      "retention-annotation",
      {
        target: {
          representation: firstRepresentation,
          anchor: createTextQuoteAnchor(
            first.web.markdown,
            quoteStart,
            quoteStart + "Protected claim 1".length,
          ),
        },
        body: "This evidence must remain inspectable.",
        source: "user",
      },
      "user",
    ).annotations[0]!;
    const reconciliation = store.annotations.reconcile({
      subject: { kind: "resource", resourceId: resource.id },
      newRepresentation: annotationRepresentation(second),
      content: second.web.markdown,
    });
    expect(reconciliation.changed).toBe(true);

    store.resources.configureRetention({
      retainNewestSourceSnapshots: 1,
      retainNewestRepresentationsPerAdapter: 1,
      minimumAgeMs: 0,
      purgeGraceMs: 0,
    });
    const pin = store.resources.pinRetention({
      artifact: { kind: "source-snapshot", id: third.web.sourceSnapshot.id },
      label: "Explicit revision pin",
    });
    const publication = store.resources.referenceRetention({
      artifact: { kind: "representation", id: third.web.representation.id },
      owner: { kind: "publication", id: "published-retention-proof" },
    });
    expect(pin.created).toBe(true);
    expect(publication.created).toBe(true);

    const before = store.resources.inspectRetention(resource.id);
    expect(artifact(
      before.artifacts,
      "source-snapshot",
      first.web.sourceSnapshot.id,
    ).states).toContain("referenced");
    expect(artifact(
      before.artifacts,
      "representation",
      first.web.representation.id,
    ).states).toContain("referenced");
    expect(artifact(
      before.artifacts,
      "source-snapshot",
      second.web.sourceSnapshot.id,
    ).states).toContain("referenced");
    expect(artifact(
      before.artifacts,
      "representation",
      second.web.representation.id,
    ).states).toContain("referenced");
    expect(artifact(
      before.artifacts,
      "source-snapshot",
      third.web.sourceSnapshot.id,
    ).states).toContain("pinned");
    expect(artifact(
      before.artifacts,
      "representation",
      third.web.representation.id,
    ).states).toEqual(expect.arrayContaining(["referenced", "pinned"]));
    expect(artifact(
      before.artifacts,
      "source-snapshot",
      fourth.web.sourceSnapshot.id,
    ).states).toEqual(["evictable"]);
    expect(artifact(
      before.artifacts,
      "representation",
      fourth.web.representation.id,
    ).states).toEqual(["evictable"]);
    expect(artifact(
      before.artifacts,
      "source-snapshot",
      current.web.sourceSnapshot.id,
    ).states).toEqual(expect.arrayContaining(["current", "hot"]));
    expect(artifact(
      before.artifacts,
      "representation",
      current.web.representation.id,
    ).states).toEqual(expect.arrayContaining(["current", "hot"]));

    const sequenceBeforeEviction = store.sequence;
    const eviction = store.resources.collectRetention("evict", resource.id);
    expect(eviction.evicted).toEqual(expect.arrayContaining([
      { kind: "source-snapshot", id: fourth.web.sourceSnapshot.id },
      { kind: "representation", id: fourth.web.representation.id },
    ]));
    expect(store.sequence).toBe(sequenceBeforeEviction + 1);
    const evictedDescription = store.resources.describe(
      resource.id,
      true,
      fourth.web.sourceSnapshot.revision,
    );
    expect(evictedDescription.web).toBeNull();
    const evictedSnapshot = evictedDescription.webHistory?.sourceSnapshots.find(
      ({ id }) => id === fourth.web!.sourceSnapshot.id,
    );
    const evictedRepresentation = evictedDescription.webHistory?.representations.find(
      ({ id }) => id === fourth.web!.representation.id,
    );
    expect(evictedSnapshot).toMatchObject({ bodyAvailable: false, evictedAt: now });
    expect(evictedRepresentation).toMatchObject({ contentAvailable: false, evictedAt: now });
    expect(store.annotations.get(annotation.block.id).originalTarget.representation.id).toBe(
      first.web.representation.id,
    );

    const purge = store.resources.collectRetention("purge", resource.id);
    expect(purge.purged.map(({ artifact }) => artifact)).toEqual(expect.arrayContaining([
      { kind: "source-snapshot", id: fourth.web.sourceSnapshot.id },
      { kind: "representation", id: fourth.web.representation.id },
    ]));
    const after = store.resources.inspectRetention(resource.id);
    expect(after.artifacts.some(({ artifact }) => artifact.id === fourth.web!.sourceSnapshot.id)).toBe(false);
    expect(after.artifacts.some(({ artifact }) => artifact.id === fourth.web!.representation.id)).toBe(false);
    expect(after.purged.map(({ artifact }) => artifact.id)).toEqual(expect.arrayContaining([
      fourth.web.sourceSnapshot.id,
      fourth.web.representation.id,
    ]));
    const providerCountBeforeOpen = providerAccessCount;
    const reopened = await store.resources.open(resource.id, true);
    expect(reopened.web?.representation.id).toBe(current.web.representation.id);
    expect(providerAccessCount).toBe(providerCountBeforeOpen);

    store.close();
    store = new OutlinerStore(databasePath, options);
    expect(store.resources.retentionPolicy()).toMatchObject({
      retainNewestSourceSnapshots: 1,
      retainNewestRepresentationsPerAdapter: 1,
      minimumAgeMs: 0,
      purgeGraceMs: 0,
    });
    expect(store.annotations.get(annotation.block.id).originalTarget.representation.id).toBe(
      first.web.representation.id,
    );
    expect(store.resources.inspectRetention(resource.id).purged).toHaveLength(2);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("young representations keep their older source snapshots available", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-retention-hot-source-"));
  const databasePath = join(directory, "outliner.sqlite");
  let now = "2026-09-01T12:00:00.000Z";
  let version = 1;
  const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
    const etag = `"v${version}"`;
    const requestHeaders = new Headers(init?.headers);
    if (requestHeaders.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers: { etag } });
    }
    return new Response(`<h1>Revision ${version}</h1>`, {
      headers: { "content-type": "text/html", etag },
    });
  }) as typeof fetch;
  const options = { now: () => now, fetch: fetcher };
  let store = new OutlinerStore(databasePath, options);
  try {
    const source = store.resources.createSource({
      name: "Hot representation fixture",
      provider: "web",
      boundary: { baseUrl: "https://example.com/" },
    });
    const resource = store.resources.intern({
      sourceId: source.id,
      address: { kind: "web", url: "https://example.com/hot-representation" },
    }).resource;
    const first = await store.resources.refreshWeb(resource.id, true);
    const firstSourceSnapshotId = first.web!.sourceSnapshot.id;
    store.close();

    now = "2026-09-10T12:00:00.000Z";
    const basicExtractor = new BasicWebMarkdownExtractor();
    const replacementExtractor: WebMarkdownExtractor = {
      adapter: { id: "fixture.retention-markdown", version: 2 },
      extract: (snapshot) => `Replacement\n\n${basicExtractor.extract(snapshot)}`,
    };
    store = new OutlinerStore(databasePath, {
      ...options,
      webExtractor: replacementExtractor,
    });
    const rederived = await store.resources.refreshWeb(resource.id, true);
    expect(rederived.web!.sourceSnapshot.id).toBe(firstSourceSnapshotId);
    const youngRepresentationId = rederived.web!.representation.id;

    version = 2;
    now = "2026-09-10T12:01:00.000Z";
    await store.resources.refreshWeb(resource.id, true);
    store.resources.configureRetention({
      retainNewestSourceSnapshots: 1,
      retainNewestRepresentationsPerAdapter: 1,
      minimumAgeMs: 7 * 24 * 60 * 60 * 1_000,
      purgeGraceMs: 0,
    });

    const before = store.resources.inspectRetention(resource.id);
    expect(artifact(before.artifacts, "representation", youngRepresentationId).states).toContain(
      "hot",
    );
    expect(artifact(before.artifacts, "source-snapshot", firstSourceSnapshotId).states).toContain(
      "hot",
    );
    const collection = store.resources.collectRetention("evict", resource.id);
    expect(collection.evicted).not.toContainEqual({
      kind: "source-snapshot",
      id: firstSourceSnapshotId,
    });
    expect(
      store.resources.inspectRetention(resource.id).artifacts.find(
        ({ artifact: candidate }) => candidate.id === firstSourceSnapshotId,
      ),
    ).toMatchObject({ payloadAvailable: true, evictedAt: null });
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
