import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, Socket } from "node:net";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  annotationSourceHash,
  createAnnotationAnchor,
  createTextQuoteAnchor,
} from "../src/annotations";
import { decodeAuthoredLinksSnapshot } from "../src/authored-links";
import { createOutlinerClient, OutlinerClient } from "../src/client";
import { HerdrRuntimeRegistry, type HerdrSessionSnapshot } from "../src/herdr-registry";
import { OutlinerServer } from "../src/server";
import { OutlinerStore } from "../src/store";
import { orchestrateWorkflowRun } from "../src/workflow-orchestrator";
import { createPdfFixture } from "./pdf-fixture";
import { OUTLINER_PROTOCOL_VERSION } from "../src/types";
import type {
  AnnotationBatchReceipt,
  AnnotationAgentEvidenceSummary,
  AnnotationAgentPromptPackage,
  AnnotationAgentProposalReceipt,
  AnnotationRecord,
  AnnotationReconcileReceipt,
  AnnotationRepresentation,
  AnnotationTarget,
  AttentionClientState,
  AnnotationThread,
  BacklinkCollection,
  BlockEditActivityPage,
  Block,
  BookmarkRemoveReceipt,
  BookmarkToggleReceipt,
  CaptureReceipt,
  DeliveryReceipt,
  BrowsingContextPublication,
  BrowsingContextState,
  OutlinerEvent,
  OutlinerClientRegistration,
  OutlinerRequest,
  OutlinerResponse,
  OutlinerNavigationDispatch,
  NavigationState,
  PageAddressCollection,
  PageAddressFollowResult,
  PageAddressRecord,
  PageAddressResolution,
  PageAddressRemoval,
  OutlinerServiceStatus,
  PropertyCatalogItem,
  QuickCaptureDraft,
  VisibleBlockCollection,
  Resource,
  InternResourceReceipt,
  ResourceDescription,
  ResourceSource,
  RoadmapItemCreateReceipt,
  WorkIdAllocation,
  WorkIdAllocatorStatus,
  WorkspaceSnapshot,
  WorkflowRun,
  WorkflowStartReceipt,
  WorkflowPromotionPreview,
  WorkflowPromotionReceipt,
} from "../src/types";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});


test("round-trips idempotent delivery identity over the current protocol", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-delivery-protocol-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  const socket = join(directory, "outliner.sock");
  const server = new OutlinerServer(store, socket);
  await server.start();
  cleanups.push(async () => {
    await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const task = store.create(
    "PIE-182 lifecycle [type::roadmap-item] [work-id::PIE-182] [work-stage::next]",
  );
  const sequenceBefore = store.sequence;
  const client = new OutlinerClient(socket);
  const input = {
    taskBlockId: task.id,
    deliveryKey: "PIE-182/enforcement",
    repository: "float-ritual-stack/pi-herdr-outliner",
    baseBranch: "main",
    workBranch: "feature/pie-182-lifecycle-enforcement",
  };

  const created = await client.request<DeliveryReceipt>({
    action: "deliveries.ensure",
    input,
    author: "agent",
    provenance: { actorId: "omp", sessionId: "session-1", taskId: "start" },
  });
  const reused = await client.request<DeliveryReceipt>({
    action: "deliveries.ensure",
    input,
  });

  expect(created.created).toBe(true);
  expect(reused.created).toBe(false);
  expect(reused.delivery.id).toBe(created.delivery.id);
  expect(store.sequence).toBe(sequenceBefore + 1);
});
test("serves bounded authored links without loading Resources or mutating storage", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-authored-links-protocol-"));
  let providerCalls = 0;
  const store = new OutlinerStore(join(directory, "outliner.sqlite"), {
    fetch: (async () => {
      providerCalls += 1;
      throw new Error("Authored-link enumeration must not contact a provider");
    }) as unknown as typeof fetch,
  });
  const source = store.resources.createSource({
    name: "Protocol docs",
    provider: "web",
    boundary: { baseUrl: "https://example.test/" },
  });
  const resource = store.resources.intern({
    sourceId: source.id,
    address: { kind: "web", url: "https://example.test/guide" },
  }).resource;
  const target = store.create("Protocol target");
  const owner = store.create(
    `Owner ((${target.id}|Target)) [Guide](pi-outliner://resource/${resource.id})`,
  );
  const blockIdsBefore = store.traversePreorder({}).map((block) => block.id);
  const sequenceBefore = store.sequence;
  const socket = join(directory, "outliner.sock");
  const server = new OutlinerServer(store, socket);
  await server.start();
  cleanups.push(async () => {
    await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const client = new OutlinerClient(socket);
  const result = decodeAuthoredLinksSnapshot(await client.request<unknown>({
    action: "blocks.authored-links",
    ownerBlockId: owner.id,
  }));

  if (result.kind !== "ready") throw new Error(`Expected ready result, got ${result.kind}`);
  expect(result.outlinks.entries[0]?.resolution).toMatchObject({
    kind: "ready",
    target: { kind: "block", blockId: target.id },
  });
  expect(result.resources.entries[0]?.resolution).toMatchObject({
    kind: "ready",
    target: { kind: "resource", resourceId: resource.id },
  });
  expect(providerCalls).toBe(0);
  expect(store.sequence).toBe(sequenceBefore);
  expect(store.traversePreorder({}).map((block) => block.id)).toEqual(blockIdsBefore);
});


test("persists resources and dispatches resource targets without synthetic blocks", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-resource-protocol-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  const socket = join(directory, "outliner.sock");
  const server = new OutlinerServer(store, socket);
  await server.start();
  const treeConnected = Promise.withResolvers<void>();
  const detailConnected = Promise.withResolvers<void>();
  const resourceOpened = Promise.withResolvers<OutlinerEvent>();
  let reconnectWatcher: ReturnType<OutlinerClient["watch"]> | null = null;
  const treeWatcher = new OutlinerClient(socket).watch({
    client: { clientId: "resource-tree", role: "tree", contextId: "resource-context" },
    onConnect: treeConnected.resolve,
    onEvent() {},
  });
  const detailWatcher = new OutlinerClient(socket).watch({
    client: { clientId: "resource-detail", role: "detail", contextId: "resource-context" },
    onConnect: detailConnected.resolve,
    onEvent(event) {
      if (
        event.domain === "ui" &&
        event.command?.command === "open" &&
        event.command.target.kind === "resource"
      ) {
        resourceOpened.resolve(event);
      }
    },
  });
  cleanups.push(async () => {
    treeWatcher.stop();
    detailWatcher.stop();
    await reconnectWatcher?.stop();
    await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await Promise.all([treeConnected.promise, detailConnected.promise]);

  const client = new OutlinerClient(socket);
  const root = join(directory, "external-notes");
  mkdirSync(root);
  mkdirSync(join(root, "daily"));
  writeFileSync(join(root, "daily/2026-09-17.md"), "# Daily\n\nDurable evidence.\n");
  const source = await client.request<ResourceSource>({
    action: "resource-sources.create",
    input: {
      name: "External notes",
      provider: "filesystem",
      boundary: { root },
      policy: { deniedCapabilities: ["watch"] },
    },
  });
  const receipt = await client.request<InternResourceReceipt>({
    action: "resources.intern",
    input: {
      sourceId: source.id,
      address: { kind: "filesystem", path: "daily/2026-09-17.md" },
      mediaType: "text/markdown",
    },
  });
  const resource = receipt.resource;

  expect(receipt.created).toBe(true);
  expect(await client.request<Resource>({
    action: "resources.get",
    resourceId: resource.id,
  })).toEqual(resource);
  expect(await client.request<ResourceSource[]>({ action: "resource-sources.list" }))
    .toContainEqual(source);
  const description = await client.request<ResourceDescription>({
    action: "resources.describe",
    target: { kind: "resource", resourceId: resource.id },
    destinationClientId: "resource-detail",
  });
  expect(description).toMatchObject({
    resource: { id: resource.id },
    source: { id: source.id },
    requestedRevision: null,
  });
  expect(description.filesystem).toMatchObject({
    text: "# Daily\n\nDurable evidence.\n",
    revision: {
      resourceId: resource.id,
      addressVersion: resource.addressVersion,
      revision: { kind: "filesystem", size: "27" },
    },
  });
  expect(description.capabilities.watch).toMatchObject({
    status: "unavailable",
    factors: {
      "workspace-policy": { state: "blocked" },
    },
  });
  const written = await client.request<ResourceDescription>({
    action: "resources.write-filesystem",
    input: {
      resourceId: resource.id,
      expectedRevision: description.filesystem!.revision,
      text: "# Daily\n\nEdited through Detail.\n",
    },
    destinationClientId: "resource-detail",
  });
  expect(written.filesystem?.text).toBe("# Daily\n\nEdited through Detail.\n");
  expect(readFileSync(join(root, "daily/2026-09-17.md"), "utf8")).toBe(
    "# Daily\n\nEdited through Detail.\n",
  );

  const dispatch = await client.request<OutlinerNavigationDispatch>({
    action: "navigation.dispatch",
    sourceClientId: "resource-tree",
    target: { kind: "resource", resourceId: resource.id },
    intent: "open",
  });
  expect(dispatch).toMatchObject({
    targetClientId: "resource-detail",
    command: {
      targetClientId: "resource-detail",
      command: "open",
      target: { kind: "resource", resourceId: resource.id },
    },
  });
  const openedEvent = await resourceOpened.promise;
  expect(openedEvent).toMatchObject({
    resourceId: resource.id,
  });
  expect(openedEvent.blockId).toBeUndefined();
  await client.request({
    action: "clients.update",
    clientId: "resource-detail",
    currentTarget: { kind: "resource", resourceId: resource.id },
  });
  expect(
    (await client.request<OutlinerClientRegistration[]>({ action: "clients.list" }))
      .find(({ clientId }) => clientId === "resource-detail")?.currentTarget,
  ).toEqual({ kind: "resource", resourceId: resource.id });

  const pinnedTarget = {
    kind: "resource" as const,
    resourceId: resource.id,
    revision: {
      resourceId: resource.id,
      addressVersion: resource.addressVersion,
      revision: { kind: "filesystem" as const, mtimeNs: "1", size: "0" },
    },
  };
  await client.request({
    action: "clients.update",
    clientId: "resource-detail",
    currentTarget: pinnedTarget,
  });
  await client.request<Resource>({
    action: "resources.relocate",
    input: {
      resourceId: resource.id,
      expectedVersion: resource.version,
      destinationSourceId: source.id,
      address: { kind: "filesystem", path: "daily/relocated.md" },
    },
  });
  await expect(client.request({
    action: "navigation.dispatch",
    sourceClientId: "resource-tree",
    target: pinnedTarget,
    intent: "open",
  })).rejects.toThrow("Resource revision reference does not match the current resource address");
  await client.request({
    action: "clients.update",
    clientId: "resource-detail",
    currentTarget: pinnedTarget,
  });
  expect(
    (await client.request<OutlinerClientRegistration[]>({ action: "clients.list" }))
      .find(({ clientId }) => clientId === "resource-detail")?.currentTarget,
  ).toEqual(pinnedTarget);

  const reconnected = Promise.withResolvers<void>();
  reconnectWatcher = client.watch({
    client: {
      clientId: "resource-detail-reconnected",
      role: "detail",
      contextId: "resource-context",
      currentTarget: pinnedTarget,
    },
    onConnect: reconnected.resolve,
    onEvent() {},
    onError: reconnected.reject,
  });
  await reconnected.promise;
  expect(
    (await client.request<OutlinerClientRegistration[]>({ action: "clients.list" }))
      .find(({ clientId }) => clientId === "resource-detail-reconnected")?.currentTarget,
  ).toEqual(pinnedTarget);

  const unavailableBlockTarget = {
    kind: "block" as const,
    blockId: "purged-block",
    fragmentId: "former-anchor",
  };
  await client.request({
    action: "clients.update",
    clientId: "resource-detail",
    currentTarget: unavailableBlockTarget,
  });
  expect(
    (await client.request<OutlinerClientRegistration[]>({ action: "clients.list" }))
      .find(({ clientId }) => clientId === "resource-detail")?.currentTarget,
  ).toEqual(unavailableBlockTarget);
});

test("delivers native PDF bytes only to a native-capable Detail", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-pdf-protocol-"));
  const databasePath = join(directory, "outliner.sqlite");
  const pdfPath = join(directory, "native.pdf");
  const bytes = createPdfFixture([{
    width: 300,
    height: 400,
    lines: [{ text: "Native protocol payload", x: 36, y: 350 }],
  }]);
  writeFileSync(pdfPath, bytes);
  const store = new OutlinerStore(databasePath, { workspaceRoot: directory });
  const socket = join(directory, "outliner.sock");
  const server = new OutlinerServer(store, socket);
  await server.start();
  const connected = Promise.withResolvers<void>();
  const watcher = new OutlinerClient(socket).watch({
    client: {
      clientId: "pdf-native-detail",
      role: "detail",
      contextId: "pdf-native",
      resourcePresentation: {
        surface: "native",
        placement: "window",
        host: {
          id: "protocol-native-pdf",
          renderers: ["native-document", "metadata"],
          placements: ["window"],
          capabilities: ["read", "refresh"],
        },
        providerAccess: { credentials: "available", connectivity: "available" },
      },
    },
    onConnect: connected.resolve,
    onEvent() {},
  });
  cleanups.push(async () => {
    watcher.stop();
    await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await connected.promise;
  const client = new OutlinerClient(socket);
  const source = await client.request<ResourceSource>({
    action: "resource-sources.create",
    input: {
      name: "Native PDF protocol",
      provider: "filesystem",
      boundary: { root: directory },
    },
  });
  const resource = (await client.request<InternResourceReceipt>({
    action: "resources.intern",
    input: {
      sourceId: source.id,
      address: { kind: "filesystem", path: "native.pdf" },
      mediaType: "application/pdf",
    },
  })).resource;
  const description = await client.request<ResourceDescription>({
    action: "resources.refresh",
    resourceId: resource.id,
    destinationClientId: "pdf-native-detail",
  });
  expect(description.presentation?.selected).toMatchObject({
    representation: "native-document",
    renderer: "native-document",
  });
  expect(description.nativePayload).toMatchObject({
    representationId: description.pdf?.nativeRepresentation.id,
    mediaType: "application/pdf",
    encoding: "base64",
  });
  expect(Buffer.from(description.nativePayload!.data, "base64")).toEqual(Buffer.from(bytes));
});

test("serves local web snapshots, explicit refresh, and unified annotation resolution", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-web-protocol-"));
  let etag = "\"v1\"";
  let html = "<h1>Protocol</h1><p>Quoted evidence.</p><p>Exact evidence remains.</p><p>Intro alpha target phrase omega Outro.</p><p>Twin before Semantic candidate Twin after.</p><p>The system stores durable annotation evidence.</p>";
  let providerAccessCount = 0;
  const requestEtags: Array<string | null> = [];
  const store = new OutlinerStore(join(directory, "outliner.sqlite"), {
    fetch: (async (_input, init) => {
      providerAccessCount += 1;
      const requestEtag = new Headers(init?.headers).get("if-none-match");
      requestEtags.push(requestEtag);
      if (requestEtag === etag) {
        return new Response(null, { status: 304 });
      }
      return new Response(html, {
        headers: { "content-type": "text/html", etag },
      });
    }) as typeof fetch,
  });
  const socket = join(directory, "outliner.sock");
  const server = new OutlinerServer(store, socket);
  await server.start();
  const connected = Promise.withResolvers<void>();
  const events: OutlinerEvent[] = [];
  const annotationEvent = Promise.withResolvers<void>();
  const reconcileEvent = Promise.withResolvers<void>();
  const refreshEvents = Promise.withResolvers<void>();
  const watcher = new OutlinerClient(socket).watch({
    client: {
      clientId: "web-detail",
      role: "detail",
      contextId: "web-context",
      resourcePresentation: {
        surface: "tui",
        placement: "pane",
        host: {
          id: "protocol-tui",
          renderers: ["markdown", "metadata", "external-open"],
          placements: ["pane", "external"],
          capabilities: ["read", "refresh", "open-external"],
        },
        providerAccess: { credentials: "unknown", connectivity: "unknown" },
      },
    },
    onConnect: connected.resolve,
    onEvent(event) {
      events.push(event);
      if (event.action === "annotations.create") annotationEvent.resolve();
      if (event.action === "annotations.reconcile") reconcileEvent.resolve();
      if (
        event.action === "resources.refresh" &&
        events.filter(({ action }) => action === "resources.refresh").length === 3
      ) {
        refreshEvents.resolve();
      }
    },
  });
  cleanups.push(async () => {
    watcher.stop();
    await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await connected.promise;
  const client = new OutlinerClient(socket);
  const source = await client.request<ResourceSource>({
    action: "resource-sources.create",
    input: {
      name: "Protocol web",
      provider: "web",
      boundary: { baseUrl: "https://example.com/" },
    },
  });
  const resource = (await client.request<InternResourceReceipt>({
    action: "resources.intern",
    input: {
      sourceId: source.id,
      address: { kind: "web", url: "https://example.com/article" },
    },
  })).resource;

  const initiallyOpened = await client.request<ResourceDescription>({
    action: "resources.open",
    target: { kind: "resource", resourceId: resource.id },
    destinationClientId: "web-detail",
  });
  expect(initiallyOpened.web).toBeNull();
  expect(initiallyOpened.webStatus).toEqual({
    freshness: "unknown",
    checkedAt: null,
    lastError: null,
  });
  expect(initiallyOpened.presentation).toMatchObject({
    surface: "tui",
    selected: { representation: "metadata", renderer: "metadata" },
  });
  expect(providerAccessCount).toBe(0);
  expect(events.some((event) => event.action === "resources.open")).toBe(false);

  const acquired = await client.request<ResourceDescription>({
    action: "resources.refresh",
    resourceId: resource.id,
    destinationClientId: "web-detail",
  });
  if (!acquired.web) throw new Error("Explicit refresh did not acquire the web document");
  expect(providerAccessCount).toBe(1);
  expect(requestEtags).toEqual([null]);
  expect(acquired.webStatus).toEqual({
    freshness: "fresh",
    checkedAt: expect.any(String),
    lastError: null,
  });
  const firstSnapshot = acquired.web.sourceSnapshot;
  const firstRepresentation = acquired.web.representation;
  expect(firstSnapshot).toEqual({
    id: expect.any(String),
    resourceId: resource.id,
    addressVersion: resource.addressVersion,
    canonicalUrl: "https://example.com/article",
    contentHash: expect.any(String),
    revision: {
      resourceId: resource.id,
      addressVersion: resource.addressVersion,
      revision: {
        kind: "web",
        validator: { kind: "etag", value: "\"v1\"", weak: false },
      },
    },
    fetchedAt: expect.any(String),
    bodyAvailable: true,
    evictedAt: null,
  });
  expect(firstRepresentation).toEqual({
    id: expect.any(String),
    sourceSnapshotId: firstSnapshot.id,
    mediaType: "text/markdown",
    adapter: { id: "builtin.basic-html-to-markdown", version: 1 },
    contentHash: expect.any(String),
    derivedAt: expect.any(String),
    contentAvailable: true,
    evictedAt: null,
  });
  expect(acquired.web).toEqual({
    markdown: "# Protocol\n\nQuoted evidence.\n\nExact evidence remains.\n\nIntro alpha target phrase omega Outro.\n\nTwin before Semantic candidate Twin after.\n\nThe system stores durable annotation evidence.",
    sourceSnapshot: firstSnapshot,
    representation: firstRepresentation,
  });
  expect(acquired.webHistory).toEqual({
    sourceSnapshots: [firstSnapshot],
    representations: [firstRepresentation],
  });
  expect(acquired.presentation).toMatchObject({
    resourceId: resource.id,
    surface: "tui",
    selected: {
      representation: "cached-markdown",
      renderer: "markdown",
      adapter: { id: "builtin.basic-html-to-markdown", version: 1 },
    },
  });

  const locallyOpened = await client.request<ResourceDescription>({
    action: "resources.open",
    target: { kind: "resource", resourceId: resource.id },
    destinationClientId: "web-detail",
  });
  expect(locallyOpened.web).toEqual(acquired.web);
  expect(providerAccessCount).toBe(1);
  expect(events.some((event) => event.action === "resources.open")).toBe(false);
  const guiConnected = Promise.withResolvers<void>();
  const guiWatcher = new OutlinerClient(socket).watch({
    client: {
      clientId: "web-gui-detail",
      role: "detail",
      contextId: "web-gui-context",
      resourcePresentation: {
        surface: "gui",
        placement: "pane",
        host: {
          id: "protocol-gui",
          renderers: ["embedded-browser", "markdown", "metadata", "external-open"],
          placements: ["pane", "external"],
          capabilities: ["read", "embed", "open-external"],
        },
        providerAccess: { credentials: "available", connectivity: "available" },
      },
    },
    onConnect: guiConnected.resolve,
    onEvent() {},
  });
  await guiConnected.promise;
  const guiOpened = await client.request<ResourceDescription>({
    action: "resources.open",
    target: { kind: "resource", resourceId: resource.id },
    destinationClientId: "web-gui-detail",
  });
  expect(guiOpened.resource.id).toBe(resource.id);
  expect(guiOpened.presentation?.selected).toMatchObject({
    representation: "embedded-browser",
    renderer: "embedded-browser",
    placement: "pane",
  });
  guiWatcher.stop();

  const externalConnected = Promise.withResolvers<void>();
  const externalWatcher = new OutlinerClient(socket).watch({
    client: {
      clientId: "web-external-detail",
      role: "detail",
      contextId: "web-external-context",
      resourcePresentation: {
        surface: "external",
        placement: "external",
        host: {
          id: "protocol-external",
          renderers: ["external-open"],
          placements: ["external"],
          capabilities: ["open-external"],
        },
        providerAccess: { credentials: "unknown", connectivity: "available" },
      },
    },
    onConnect: externalConnected.resolve,
    onEvent() {},
  });
  await externalConnected.promise;
  const externalOpened = await client.request<ResourceDescription>({
    action: "resources.open",
    target: { kind: "resource", resourceId: resource.id },
    destinationClientId: "web-external-detail",
  });
  expect(externalOpened.resource.id).toBe(resource.id);
  expect(externalOpened.presentation?.selected).toMatchObject({
    representation: "external-link",
    renderer: "external-open",
    placement: "external",
    externalUrl: "https://example.com/article",
  });
  externalWatcher.stop();

  const firstCapturedAt = firstRepresentation.derivedAt ?? firstSnapshot.fetchedAt;
  if (!firstCapturedAt) throw new Error("Acquired web representation has no capture time");
  const firstAnnotationRepresentation: AnnotationRepresentation = {
    id: firstRepresentation.id,
    subject: { kind: "resource", resourceId: resource.id },
    sourceSnapshot: {
      kind: "resource",
      resourceId: resource.id,
      sourceSnapshotId: firstSnapshot.id,
      revision: firstSnapshot.revision,
    },
    adapter: firstRepresentation.adapter,
    mediaType: firstRepresentation.mediaType,
    contentHash: firstRepresentation.contentHash,
    capturedAt: firstCapturedAt,
  };
  const start = acquired.web.markdown.indexOf("Quoted");
  const end = start + "Quoted".length;
  const originalTarget: AnnotationTarget = {
    representation: firstAnnotationRepresentation,
    anchor: createTextQuoteAnchor(acquired.web.markdown, start, end),
  };
  await expect(client.request<AnnotationBatchReceipt>({
    action: "annotations.create",
    requestId: "protocol-resource-annotation-invalid",
    input: {
      target: {
        ...originalTarget,
        representation: {
          ...firstAnnotationRepresentation,
          id: "missing-web-representation",
        },
      },
      body: "Unverified evidence",
      source: "agent",
    },
  })).rejects.toThrow("Annotation Resource representation evidence is unavailable");

  const annotationReceipt = await client.request<AnnotationBatchReceipt>({
    action: "annotations.create",
    requestId: "protocol-resource-annotation-1",
    input: {
      target: originalTarget,
      body: "Protocol evidence",
      source: "user",
    },
  });
  await annotationEvent.promise;
  const annotation = annotationReceipt.annotations[0]!;
  expect(annotationReceipt.deduplicated).toBe(false);
  expect(annotation).toMatchObject({
    originalTarget,
    resolvedTarget: originalTarget,
    body: "Protocol evidence",
    source: "user",
    currentResolution: {
      sequence: 0,
      sourceRepresentation: firstAnnotationRepresentation,
      targetRepresentation: firstAnnotationRepresentation,
      resolvedTarget: originalTarget,
      status: "resolved",
      appliesCurrent: true,
    },
  });
  expect(annotation.resolutionHistory).toHaveLength(1);
  const createFixtureAnnotation = async (requestId: string, quote: string) => {
    const quoteStart = acquired.web!.markdown.indexOf(quote);
    return (await client.request<AnnotationBatchReceipt>({
      action: "annotations.create",
      requestId,
      input: {
        target: {
          representation: firstAnnotationRepresentation,
          anchor: createTextQuoteAnchor(
            acquired.web!.markdown,
            quoteStart,
            quoteStart + quote.length,
          ),
        },
        body: requestId,
        source: "user",
      },
    })).annotations[0]!;
  };
  const exactAnnotation = await createFixtureAnnotation(
    "protocol-reanchor-exact",
    "Exact evidence remains",
  );
  const contextualAnnotation = await createFixtureAnnotation(
    "protocol-reanchor-context",
    "target phrase",
  );
  const fuzzyAnnotation = await createFixtureAnnotation(
    "protocol-reanchor-fuzzy",
    "The system stores durable annotation evidence",
  );
  const semanticAnnotation = await createFixtureAnnotation(
    "protocol-reanchor-semantic",
    "Semantic candidate",
  );
  const automaticSemanticAnnotation = await createFixtureAnnotation(
    "protocol-reanchor-semantic-automatic",
    "Semantic candidate",
  );
  const orphanSemanticAnnotation = await createFixtureAnnotation(
    "protocol-reanchor-semantic-orphan",
    "Semantic candidate",
  );
  const listedAnnotations = await client.request<AnnotationThread[]>({
    action: "annotations.list",
    query: {
      subject: { kind: "resource", resourceId: resource.id },
      includeResolved: true,
    },
  });
  expect(listedAnnotations).toHaveLength(7);
  expect(listedAnnotations).toEqual(expect.arrayContaining([
    expect.objectContaining({
      block: expect.objectContaining({ id: annotation.block.id }),
      originalTarget,
      resolvedTarget: originalTarget,
    }),
  ]));

  const unchanged = await client.request<ResourceDescription>({
    action: "resources.refresh",
    resourceId: resource.id,
    destinationClientId: "web-detail",
  });
  if (!unchanged.web) throw new Error("Unchanged refresh lost the web document");
  expect(unchanged.webStatus?.freshness).toBe("fresh");
  expect(providerAccessCount).toBe(2);
  expect(requestEtags).toEqual([null, "\"v1\""]);
  expect(unchanged.web.sourceSnapshot.id).toBe(firstSnapshot.id);
  expect(unchanged.web.representation.id).toBe(firstRepresentation.id);
  expect(unchanged.webHistory).toEqual({
    sourceSnapshots: [firstSnapshot],
    representations: [firstRepresentation],
  });

  etag = "\"v2\"";
  html = "<h1>Protocol changed</h1><p>New body.</p><p>Exact evidence remains.</p><p>Noise target phrase elsewhere.</p><p>Intro alpha target phrase omega Outro.</p><p>Twin before Semantic candidate Twin after.</p><p>Twin before Semantic candidate Twin after.</p><p>The system preserves durable annotation evidence.</p>";
  const changed = await client.request<ResourceDescription>({
    action: "resources.refresh",
    resourceId: resource.id,
    destinationClientId: "web-detail",
  });
  if (!changed.web) throw new Error("Changed refresh lost the web document");
  expect(changed.webStatus?.freshness).toBe("fresh");
  await refreshEvents.promise;
  expect(providerAccessCount).toBe(3);
  expect(requestEtags).toEqual([null, "\"v1\"", "\"v1\""]);
  expect(changed.web.markdown).toBe("# Protocol changed\n\nNew body.\n\nExact evidence remains.\n\nNoise target phrase elsewhere.\n\nIntro alpha target phrase omega Outro.\n\nTwin before Semantic candidate Twin after.\n\nTwin before Semantic candidate Twin after.\n\nThe system preserves durable annotation evidence.");
  expect(changed.web.sourceSnapshot.id).not.toBe(firstSnapshot.id);
  expect(changed.web.representation.id).not.toBe(firstRepresentation.id);
  expect(changed.web.representation.sourceSnapshotId).toBe(changed.web.sourceSnapshot.id);
  expect(changed.webHistory?.sourceSnapshots).toHaveLength(2);
  expect(changed.webHistory?.sourceSnapshots).toEqual(
    expect.arrayContaining([firstSnapshot, changed.web.sourceSnapshot]),
  );
  expect(changed.webHistory?.representations).toHaveLength(2);
  expect(changed.webHistory?.representations).toEqual(
    expect.arrayContaining([firstRepresentation, changed.web.representation]),
  );
  const secondCapturedAt = changed.web.representation.derivedAt ??
    changed.web.sourceSnapshot.fetchedAt;
  if (!secondCapturedAt) throw new Error("Refreshed web representation has no capture time");
  const secondAnnotationRepresentation: AnnotationRepresentation = {
    id: changed.web.representation.id,
    subject: { kind: "resource", resourceId: resource.id },
    sourceSnapshot: {
      kind: "resource",
      resourceId: resource.id,
      sourceSnapshotId: changed.web.sourceSnapshot.id,
      revision: changed.web.sourceSnapshot.revision,
    },
    adapter: changed.web.representation.adapter,
    mediaType: changed.web.representation.mediaType,
    contentHash: changed.web.representation.contentHash,
    capturedAt: secondCapturedAt,
  };
  const reconciled = await client.request<AnnotationReconcileReceipt>({
    action: "annotations.reconcile",
    input: {
      subject: { kind: "resource", resourceId: resource.id },
      newRepresentation: secondAnnotationRepresentation,
    },
  });
  expect(reconciled.changed).toBe(true);
  expect(reconciled.threads).toHaveLength(7);
  const reconciledById = new Map(reconciled.threads.map((thread) => [thread.block.id, thread]));
  const orphanedAnnotation = reconciledById.get(annotation.block.id)!;
  expect(orphanedAnnotation).toMatchObject({
    originalTarget,
    resolvedTarget: null,
    currentResolution: {
      sequence: 1,
      sourceRepresentation: firstAnnotationRepresentation,
      targetRepresentation: secondAnnotationRepresentation,
      resolvedTarget: null,
      status: "orphaned",
      appliesCurrent: true,
      candidates: [],
    },
  });
  expect(orphanedAnnotation.resolutionHistory.map(({ status }) => status)).toEqual([
    "resolved",
    "orphaned",
  ]);
  expect(reconciledById.get(exactAnnotation.block.id)).toMatchObject({
    currentResolution: {
      status: "resolved",
      method: { method: "unique-exact-quote" },
      confidence: 1,
    },
  });
  const contextualResolution = reconciledById.get(contextualAnnotation.block.id)!.currentResolution;
  expect(contextualResolution).toMatchObject({
    status: "resolved",
    method: { method: "quote-context" },
  });
  expect(contextualResolution.confidence).toBeGreaterThanOrEqual(0.8);
  expect(contextualResolution.candidates).toHaveLength(2);
  const fuzzyResolution = reconciledById.get(fuzzyAnnotation.block.id)!.currentResolution;
  expect(fuzzyResolution).toMatchObject({
    status: "resolved",
    method: { method: "local-fuzzy" },
  });
  expect(fuzzyResolution.candidates[0]!.confidence).toBeGreaterThanOrEqual(0.8);
  const semanticResolution = reconciledById.get(semanticAnnotation.block.id)!.currentResolution;
  expect(semanticResolution).toMatchObject({
    status: "ambiguous",
    resolvedTarget: null,
    appliesCurrent: true,
  });
  expect(semanticResolution.candidates).toHaveLength(2);
  const semanticPackage = await client.request<AnnotationAgentPromptPackage>({
    action: "annotations.agent-package",
    annotationId: semanticAnnotation.block.id,
  });
  expect(semanticPackage).toMatchObject({
    annotationId: semanticAnnotation.block.id,
    baseEventId: semanticResolution.id,
    annotationBody: "protocol-reanchor-semantic",
    originalPassage: "Semantic candidate",
    candidates: [
      expect.objectContaining({ index: 0, passage: "Semantic candidate" }),
      expect.objectContaining({ index: 1, passage: "Semantic candidate" }),
    ],
  });
  expect(semanticPackage.characterCount).toBeLessThanOrEqual(24_000);
  await expect(client.request({
    action: "annotations.agent-package",
    annotationId: exactAnnotation.block.id,
  })).rejects.toThrow("Only failed deterministic reconciliations");

  const ambiguousInput = {
    annotationId: semanticAnnotation.block.id,
    baseEventId: semanticPackage.baseEventId,
    modelId: "test/semantic-model",
    result: {
      status: "ambiguous" as const,
      candidateIndexes: [0, 1],
      confidence: 0.72,
      rationale: "Both passages preserve the original local context.",
      evidence: ["Candidate 0 and candidate 1 have identical text and context."],
    },
  };
  const ambiguousProposal = await client.request<AnnotationAgentProposalReceipt>({
    action: "annotations.propose-agent",
    requestId: "semantic-ambiguous-1",
    input: ambiguousInput,
  });
  expect(ambiguousProposal).toMatchObject({
    deduplicated: false,
    proposal: {
      status: "ambiguous",
      appliesCurrent: false,
      confidence: 0.72,
      reviewer: { kind: "agent", id: "test/semantic-model" },
    },
    annotation: {
      currentResolution: { id: semanticPackage.baseEventId, status: "ambiguous" },
    },
  });
  const rejectedProposal = await client.request<AnnotationRecord>({
    action: "annotations.review-agent",
    input: {
      annotationId: semanticAnnotation.block.id,
      proposalEventId: ambiguousProposal.proposal.id,
      decision: "reject",
    },
  });
  expect(rejectedProposal.currentResolution.id).toBe(semanticPackage.baseEventId);
  expect(rejectedProposal.resolutionHistory.at(-1)).toMatchObject({
    status: "rejected",
    appliesCurrent: false,
    method: {
      kind: "human",
      method: "rejected-agent-proposal",
      proposalEventId: ambiguousProposal.proposal.id,
    },
  });

  const reviewableInput = {
    annotationId: semanticAnnotation.block.id,
    baseEventId: semanticPackage.baseEventId,
    modelId: "test/semantic-model",
    result: {
      status: "reanchored" as const,
      candidateIndex: 0,
      confidence: 0.9,
      rationale: "The first candidate follows the document's logical section order.",
      evidence: ["The first candidate precedes the duplicate in the revised representation."],
    },
  };
  const reviewableProposal = await client.request<AnnotationAgentProposalReceipt>({
    action: "annotations.propose-agent",
    requestId: "semantic-reviewable-1",
    input: reviewableInput,
  });
  expect(reviewableProposal.proposal).toMatchObject({
    status: "probable",
    appliesCurrent: false,
    resolvedTarget: null,
    confidence: 0.9,
  });
  const replayedProposal = await client.request<AnnotationAgentProposalReceipt>({
    action: "annotations.propose-agent",
    requestId: "semantic-reviewable-1",
    input: {
      ...reviewableInput,
      result: {
        ...reviewableInput.result,
        confidence: 0.2,
        rationale: "A retried model response must not replace the durable first result.",
      },
    },
  });
  expect(replayedProposal).toMatchObject({
    deduplicated: true,
    proposal: { id: reviewableProposal.proposal.id, confidence: 0.9 },
  });
  const acceptedProposal = await client.request<AnnotationRecord>({
    action: "annotations.review-agent",
    input: {
      annotationId: semanticAnnotation.block.id,
      proposalEventId: reviewableProposal.proposal.id,
      decision: "accept",
    },
  });
  expect(acceptedProposal.currentResolution).toMatchObject({
    status: "resolved",
    appliesCurrent: true,
    method: {
      kind: "human",
      method: "accepted-agent-proposal",
      proposalEventId: reviewableProposal.proposal.id,
    },
  });
  expect(acceptedProposal.originalTarget).toEqual(semanticAnnotation.originalTarget);

  const automaticPackage = await client.request<AnnotationAgentPromptPackage>({
    action: "annotations.agent-package",
    annotationId: automaticSemanticAnnotation.block.id,
  });
  const automaticInput = {
    annotationId: automaticSemanticAnnotation.block.id,
    baseEventId: automaticPackage.baseEventId,
    modelId: "test/semantic-model",
    result: {
      status: "reanchored" as const,
      candidateIndex: 1,
      confidence: 0.97,
      rationale: "The second candidate is supported by the revised section sequence.",
      evidence: ["Candidate 1 occupies the intended semantic section."],
    },
  };
  const automaticProposal = await client.request<AnnotationAgentProposalReceipt>({
    action: "annotations.propose-agent",
    requestId: "semantic-automatic-1",
    input: automaticInput,
  });
  expect(automaticProposal).toMatchObject({
    deduplicated: false,
    proposal: {
      status: "resolved",
      appliesCurrent: true,
      confidence: 0.97,
      method: {
        kind: "agent",
        modelId: "test/semantic-model",
        method: "semantic-reconciliation",
      },
    },
    annotation: {
      currentResolution: { status: "resolved" },
    },
  });
  expect(await client.request<AnnotationAgentProposalReceipt | null>({
    action: "annotations.agent-receipt",
    requestId: "semantic-automatic-1",
  })).toMatchObject({
    deduplicated: true,
    proposal: { id: automaticProposal.proposal.id },
  });

  const orphanPackage = await client.request<AnnotationAgentPromptPackage>({
    action: "annotations.agent-package",
    annotationId: orphanSemanticAnnotation.block.id,
  });
  expect(orphanPackage.candidates).toHaveLength(2);
  const orphanProposal = await client.request<AnnotationAgentProposalReceipt>({
    action: "annotations.propose-agent",
    requestId: "semantic-orphaned-1",
    input: {
      annotationId: orphanSemanticAnnotation.block.id,
      baseEventId: orphanPackage.baseEventId,
      modelId: "test/semantic-model",
      result: {
        status: "orphaned",
        confidence: 0.91,
        rationale: "No candidate preserves the quoted claim.",
        evidence: ["The revised representation contains no matching passage."],
      },
    },
  });
  expect(orphanProposal.proposal).toMatchObject({
    status: "orphaned",
    appliesCurrent: false,
    confidence: 0.91,
  });
  await client.request<AnnotationRecord>({
    action: "annotations.review-agent",
    input: {
      annotationId: orphanSemanticAnnotation.block.id,
      proposalEventId: orphanProposal.proposal.id,
      decision: "accept",
    },
  });
  await expect(client.request({
    action: "annotations.agent-package",
    annotationId: orphanSemanticAnnotation.block.id,
  })).rejects.toThrow("Only failed deterministic reconciliations");
  const agentEvidence = await client.request<AnnotationAgentEvidenceSummary>({
    action: "annotations.agent-evidence",
    limit: 10,
  });
  expect(agentEvidence).toMatchObject({
    acceptedCount: 3,
    automaticCount: 1,
    humanReviewedCount: 2,
    truncated: false,
  });
  expect(agentEvidence.samples).toEqual(expect.arrayContaining([
    expect.objectContaining({
      proposalEventId: reviewableProposal.proposal.id,
      acceptedBy: "human",
      outcome: "reanchored",
      originalPassage: "Semantic candidate",
      resolvedPassage: "Semantic candidate",
    }),
    expect.objectContaining({
      proposalEventId: automaticProposal.proposal.id,
      acceptedBy: "automatic",
      outcome: "reanchored",
    }),
    expect.objectContaining({
      proposalEventId: orphanProposal.proposal.id,
      acceptedBy: "human",
      outcome: "orphaned",
      resolvedPassage: null,
    }),
  ]));
  await reconcileEvent.promise;
  const reconcileEventCount = events.filter(({ action }) =>
    action === "annotations.reconcile"
  ).length;
  const unchangedReconcile = await client.request<AnnotationReconcileReceipt>({
    action: "annotations.reconcile",
    input: {
      subject: { kind: "resource", resourceId: resource.id },
      newRepresentation: secondAnnotationRepresentation,
    },
  });
  expect(unchangedReconcile.changed).toBe(false);
  expect(
    unchangedReconcile.threads.find(({ block }) => block.id === exactAnnotation.block.id)!
      .resolutionHistory,
  ).toHaveLength(2);
  await Bun.sleep(20);
  expect(events.filter(({ action }) =>
    action === "annotations.reconcile"
  )).toHaveLength(reconcileEventCount);
  const approvedStart = changed.web.markdown.indexOf("New body");
  const approvedTarget: AnnotationTarget = {
    representation: secondAnnotationRepresentation,
    anchor: createTextQuoteAnchor(
      changed.web.markdown,
      approvedStart,
      approvedStart + "New body".length,
    ),
  };
  const approved = await client.request<AnnotationRecord>({
    action: "annotations.approve-resolution",
    input: {
      annotationId: annotation.block.id,
      target: approvedTarget,
    },
  });
  expect(approved).toMatchObject({
    originalTarget,
    resolvedTarget: approvedTarget,
    currentResolution: {
      sequence: 2,
      sourceRepresentation: secondAnnotationRepresentation,
      targetRepresentation: secondAnnotationRepresentation,
      resolvedTarget: approvedTarget,
      method: { kind: "human", method: "approved-target" },
      reviewer: { kind: "user", id: "protocol" },
      confidence: 1,
      status: "resolved",
      appliesCurrent: true,
    },
  });
  expect(approved.resolutionHistory.map(({ status }) => status)).toEqual([
    "resolved",
    "orphaned",
    "resolved",
  ]);
  expect(events.filter(({ action }) => action === "resources.refresh")).toEqual([
    expect.objectContaining({
      domain: "resource-catalog",
      action: "resources.refresh",
      resourceId: resource.id,
    }),
    expect.objectContaining({
      domain: "resource-catalog",
      action: "resources.refresh",
      resourceId: resource.id,
    }),
    expect.objectContaining({
      domain: "resource-catalog",
      action: "resources.refresh",
      resourceId: resource.id,
    }),
  ]);
  expect(events.some((event) => event.action === "resources.open")).toBe(false);
});

test("rejects agent selections omitted from a bounded candidate package", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-agent-package-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  cleanups.push(async () => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const passage = "semantic ".repeat(500).trim();
  const originalText = `before ${passage} after`;
  const source = store.create(originalText, null, "user");
  const originalRepresentation: AnnotationRepresentation = {
    id: "bounded-package-original",
    subject: { kind: "block", blockId: source.id },
    sourceSnapshot: {
      kind: "block",
      blockId: source.id,
      updatedAt: source.updatedAt,
      contentHash: annotationSourceHash(originalText),
    },
    adapter: null,
    mediaType: "text/plain",
    contentHash: annotationSourceHash(originalText),
    capturedAt: source.updatedAt,
  };
  const start = originalText.indexOf(passage);
  const annotation = store.createAnnotation("bounded-agent-create", {
    target: {
      representation: originalRepresentation,
      anchor: createTextQuoteAnchor(originalText, start, start + passage.length),
    },
    body: "\u0001".repeat(4_000),
    source: "user",
  }).annotations[0]!;
  const revisedText = `header\n${Array.from(
    { length: 8 },
    () => `before ${passage} after`,
  ).join("\n")}`;
  const revised = store.update(source.id, revisedText, source.updatedAt, {
    author: "user",
    actorId: "protocol-test",
    sessionId: "bounded-package",
  });
  const revisedRepresentation: AnnotationRepresentation = {
    id: "bounded-package-revised",
    subject: { kind: "block", blockId: source.id },
    sourceSnapshot: {
      kind: "block",
      blockId: source.id,
      updatedAt: revised.updatedAt,
      contentHash: annotationSourceHash(revisedText),
    },
    adapter: null,
    mediaType: "text/plain",
    contentHash: annotationSourceHash(revisedText),
    capturedAt: revised.updatedAt,
  };
  const reconciled = store.reconcileAnnotationThreads({
    subject: { kind: "block", blockId: source.id },
    newRepresentation: revisedRepresentation,
    content: revisedText,
  });
  const failed = reconciled.threads.find(({ block }) => block.id === annotation.block.id)!;
  expect(failed.currentResolution.status).toBe("ambiguous");
  expect(failed.currentResolution.candidates).toHaveLength(8);
  const promptPackage = store.getAnnotationAgentPackage(annotation.block.id);
  expect(promptPackage.truncated).toBe(true);
  expect(promptPackage.candidates.length).toBeLessThan(failed.currentResolution.candidates.length);
  expect(JSON.stringify(promptPackage)).toHaveLength(promptPackage.characterCount);
  expect(promptPackage.characterCount).toBeLessThanOrEqual(24_000);
  expect(() => store.proposeAnnotationAgentResolution("bounded-agent-proposal", {
    annotationId: annotation.block.id,
    baseEventId: promptPackage.baseEventId,
    modelId: "test/model",
    result: {
      status: "reanchored",
      candidateIndex: failed.currentResolution.candidates.length - 1,
      confidence: 0.99,
      rationale: "This candidate was not actually supplied.",
      evidence: ["An omitted passage cannot support a model decision."],
    },
  })).toThrow("not supplied in its prompt package");
  const reviewable = store.proposeAnnotationAgentResolution("bounded-agent-valid", {
    annotationId: annotation.block.id,
    baseEventId: promptPackage.baseEventId,
    modelId: "test/model",
    result: {
      status: "reanchored",
      candidateIndex: 0,
      confidence: 0.9,
      rationale: "The first supplied candidate preserves source order.",
      evidence: ["Candidate 0 was present in the bounded package."],
    },
  });
  store.reviewAnnotationAgentResolution({
    annotationId: annotation.block.id,
    proposalEventId: reviewable.proposal.id,
    decision: "accept",
  });
  const evidence = store.summarizeAnnotationAgentEvidence(1);
  expect(evidence).toMatchObject({
    acceptedCount: 1,
    humanReviewedCount: 1,
    truncated: true,
  });
  expect(evidence.samples[0]!.originalPassage).toHaveLength(2_000);
  expect(evidence.samples[0]!.resolvedPassage).toHaveLength(2_000);
});



test("serves atomic idempotent annotation threads over the current protocol", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-annotation-protocol-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  const socket = join(directory, "outliner.sock");
  const server = new OutlinerServer(store, socket);
  await server.start();
  cleanups.push(async () => {
    await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const client = new OutlinerClient(socket);
  const source = await client.request<Block>({
    action: "create",
    text: "alpha βeta gamma",
  });
  const contentHash = annotationSourceHash(source.text);
  const representation: AnnotationRepresentation = {
    id: `block:${source.id}:${source.updatedAt}`,
    subject: { kind: "block", blockId: source.id },
    sourceSnapshot: {
      kind: "block",
      blockId: source.id,
      updatedAt: source.updatedAt,
      contentHash,
    },
    adapter: null,
    mediaType: "text/markdown",
    contentHash,
    capturedAt: source.updatedAt,
  };
  const target: AnnotationTarget = {
    representation,
    anchor: createTextQuoteAnchor(source.text, 6, 10),
  };
  const operations = [{
    operationId: "comment-1",
    type: "create" as const,
    input: {
      target,
      body: "Check this range.",
      source: "agent" as const,
    },
  }];
  const created = await client.request<AnnotationBatchReceipt>({
    action: "annotations.batch",
    requestId: "protocol-annotation-batch-1",
    operations,
    author: "agent",
    provenance: { actorId: "omp", sessionId: "session-1", taskId: "call-1" },
  });
  const replayed = await client.request<AnnotationBatchReceipt>({
    action: "annotations.batch",
    requestId: "protocol-annotation-batch-1",
    operations,
    author: "agent",
    provenance: { actorId: "omp", sessionId: "session-1", taskId: "call-2" },
  });
  const threads = await client.request<AnnotationThread[]>({
    action: "annotations.list",
    query: {
      subject: { kind: "block", blockId: source.id },
      includeResolved: true,
    },
  });
  expect(created.deduplicated).toBe(false);
  expect(replayed.deduplicated).toBe(true);
  expect(replayed.annotations[0]!.block.id).toBe(created.annotations[0]!.block.id);
  expect(threads).toHaveLength(1);
  expect(threads[0]).toMatchObject({
    originalTarget: target,
    resolvedTarget: target,
    currentResolution: {
      sequence: 0,
      sourceRepresentation: representation,
      targetRepresentation: representation,
      resolvedTarget: target,
      status: "resolved",
      appliesCurrent: true,
    },
  });
  expect(threads[0]!.resolutionHistory).toHaveLength(1);
});

test("serves mutations and property queries over the local socket", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-protocol-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  const socket = join(directory, "outliner.sock");
  const server = new OutlinerServer(store, socket);
  await server.start();
  cleanups.push(async () => {
    await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const client = new OutlinerClient(socket);
  const service = await client.request<OutlinerServiceStatus>({ action: "ping" });
  expect(service).toEqual({ status: "ready", protocolVersion: OUTLINER_PROTOCOL_VERSION });
  const provenance = {
    actorId: "omp",
    sessionId: "session-1",
    taskId: "tool-call-1",
  };
  const block = await client.request<Block>({
    action: "create",
    text: "Waiting for user [type::question] [status::open]",
    author: "agent",
    provenance,
  });
  expect(block).toEqual(expect.objectContaining({
    author: "agent",
    ...provenance,
  }));
  await client.request<Block>({
    action: "create",
    text: "Another question [type::question] [status::open]",
  });
  const matches = await client.request<VisibleBlockCollection>({
    action: "blocks.query",
    query: { filters: [{ key: "type", value: "question" }], limit: 1 },
  });
  const spaced = await client.request<Block>({
    action: "create",
    text: "Active protocol work [status::in progress] [project::pi-outliner]",
  });
  const spacedMatches = await client.request<VisibleBlockCollection>({
    action: "blocks.query",
    query: {
      filters: [
        { key: " STATUS ", value: " in progress " },
        { key: "project", value: "PI-OUTLINER" },
      ],
      limit: 20,
    },
  });
  expect(spacedMatches).toEqual({
    blocks: [expect.objectContaining({ id: spaced.id })],
    completeness: { kind: "complete" },
  });
  const allocatorBefore = await client.request<WorkIdAllocatorStatus>({
    action: "work-ids.status",
  });
  expect(allocatorBefore).toEqual({
    prefix: null,
    nextNumber: null,
    nextWorkId: null,
    reservedCount: 0,
    observedPrefixes: [],
  });
  await client.request({ action: "work-ids.configure", prefix: "pie" });
  const workTarget = await client.request<Block>({
    action: "create",
    text: "Protocol work target",
  });
  const allocation = await client.request<WorkIdAllocation>({
    action: "work-ids.allocate",
    blockId: workTarget.id,
    expectedUpdatedAt: workTarget.updatedAt,
  });
  expect(allocation).toMatchObject({
    workId: "PIE-001",
    block: {
      id: workTarget.id,
      properties: [{ key: "work-id", value: "PIE-001" }],
    },
  });
  expect(await client.request<WorkIdAllocatorStatus>({
    action: "work-ids.status",
  })).toEqual({
    prefix: "PIE",
    nextNumber: 2,
    nextWorkId: "PIE-002",
    reservedCount: 1,
    observedPrefixes: ["PIE"],
  });
  const workQueue = await client.request<Block>({
    action: "create",
    text: "Protocol work queue [type::work-queue] [project::pi-outliner]",
  });
  const lane = await client.request<Block>({
    action: "create",
    text: "Unprioritized [type::virtual-branch] [query::work-stage=unprioritized]",
  });
  const roadmapReceipt = await client.request<RoadmapItemCreateReceipt>({
    action: "roadmap.items.create",
    input: {
      title: "Round-trip atomic roadmap creation",
      priority: "high",
      project: "pi-outliner",
      arc: "protocol",
      tracks: ["core"],
    },
    author: "agent",
    provenance,
  });
  expect(roadmapReceipt).toMatchObject({
    workId: "PIE-002",
    workQueueId: workQueue.id,
    block: {
      parentId: workQueue.id,
      actorId: "omp",
      properties: expect.arrayContaining([
        { key: "work-stage", value: "unprioritized" },
        { key: "work-id", value: "PIE-002" },
      ]),
    },
    memberships: [{ viewId: lane.id, title: "Unprioritized" }],
  });

  expect(matches.blocks.some((candidate) => candidate.id === block.id)).toBe(true);
  expect(matches.completeness).toEqual({ kind: "truncated", limit: 1 });
  await client.request({ action: "selection.set", blockId: block.id });
  const context = await client.request<{ selected: Block }>({ action: "selection.get" });
  expect(context.selected.id).toBe(block.id);
  const navigation = await client.request<NavigationState>({ action: "navigation.state" });
  expect(navigation).toMatchObject({
    selection: { selected: { id: block.id } },
    canBack: true,
    canForward: false,
  });
  expect((await client.request<NavigationState>({
    action: "navigation.back",
  })).selection.selected?.id).not.toBe(block.id);
  expect((await client.request<NavigationState>({
    action: "navigation.forward",
  })).selection.selected?.id).toBe(block.id);
  const resolved = await client.request<{ text: string; workIdPrefix?: string }>({
    action: "references.resolve",
    text: `See ((${block.id}))`,
  });
  expect(resolved.workIdPrefix).toBe("PIE");
  expect(resolved.text).toBe("See ((Waiting for user))");
  const backlinkSource = await client.request<Block>({
    action: "create",
    text: `Protocol backlink source\n((${block.id}))`,
  });
  const backlinks = await client.request<BacklinkCollection>({
    action: "references.backlinks",
    query: { targetBlockId: block.id, limit: 10 },
  });
  expect(backlinks).toMatchObject({
    targetBlockId: block.id,
    sources: [{
      blockId: backlinkSource.id,
      title: "Protocol backlink source",
      occurrenceCount: 1,
    }],
    completeness: { kind: "complete" },
  });
  const dangling = await client.request<PageAddressResolution>({
    action: "pages.resolve",
    address: "Protocol Page",
  });
  expect(dangling).toEqual({
    address: "Protocol Page",
    normalizedAddress: "protocol page",
    status: "missing",
  });
  const followedPage = await client.request<PageAddressFollowResult>({
    action: "pages.follow",
    address: "Protocol Page",
  });
  expect(followedPage).toMatchObject({
    status: "resolved",
    created: true,
    registeredAddress: "Protocol Page",
    block: { text: "Protocol Page [page::Protocol Page]" },
  });
  expect(await client.request<PageAddressCollection>({
    action: "pages.complete",
    query: "protocol",
    limit: 20,
  })).toMatchObject({
    addresses: [{
      address: "Protocol Page",
      blockId: followedPage.block!.id,
      kind: "page",
    }],
    completeness: { kind: "complete" },
  });
  expect(await client.request<PageAddressRecord>({
    action: "pages.rename",
    blockId: followedPage.block!.id,
    address: "Renamed Protocol Page",
    expectedUpdatedAt: followedPage.block!.updatedAt,
  })).toMatchObject({ address: "Renamed Protocol Page", kind: "page" });
  expect(await client.request<PageAddressRecord>({
    action: "pages.alias",
    blockId: followedPage.block!.id,
    address: "Protocol Alias",
  })).toMatchObject({ address: "Protocol Alias", kind: "alias" });
  const renamedPageBlock = await client.request<Block>({
    action: "get",
    blockId: followedPage.block!.id,
  });
  expect(await client.request<PageAddressRemoval>({
    action: "pages.remove",
    blockId: followedPage.block!.id,
    address: "Protocol Alias",
    expectedUpdatedAt: renamedPageBlock.updatedAt,
  })).toMatchObject({ removed: { address: "Protocol Alias", kind: "alias" } });
  expect(await client.request<PageAddressResolution>({
    action: "pages.resolve",
    address: "Protocol Page",
  })).toMatchObject({ status: "resolved", kind: "alias", block: { id: followedPage.block!.id } });
  const invalidPatch = server.handle({
    id: "invalid-patch",
    action: "properties.patch",
    blockId: block.id,
    expectedUpdatedAt: block.updatedAt,
    operations: [{ op: "bogus", ordinal: 0 }],
  } as unknown as OutlinerRequest);
  expect(invalidPatch.ok).toBe(false);
  expect(store.require(block.id).text).toBe(block.text);
  const unsupported = server.handle({
    id: "unsupported-action",
    action: "future.action",
  } as unknown as OutlinerRequest);
  expect(unsupported.ok).toBe(false);
  if (!unsupported.ok) expect(unsupported.error).toBe("Unsupported action: future.action");
  const oldList = server.handle({
    id: "old-list",
    action: "list",
  } as unknown as OutlinerRequest);
  expect(oldList.ok).toBe(false);
  if (!oldList.ok) expect(oldList.error).toBe("Unsupported action: list");
  const invalidLimit = server.handle({
    id: "invalid-query-limit",
    action: "blocks.query",
    query: { limit: 0 },
  });
  expect(invalidLimit.ok).toBe(false);
  if (!invalidLimit.ok) {
    expect(invalidLimit.error).toBe("Block search limit must be an integer from 1 through 1000");
  }
  const patched = await client.request<Block>({
    action: "properties.patch",
    blockId: block.id,
    expectedUpdatedAt: block.updatedAt,
    operations: [
      { op: "replace", ordinal: 1, value: "doing" },
      { op: "append", key: "priority", value: "high" },
    ],
    mutation: { author: "agent", ...provenance },
  });
  expect(patched.text).toBe(
    "Waiting for user [type::question] [status::doing]\n[priority::high]",
  );
  const userUpdated = await client.request<Block>({
    action: "update",
    blockId: patched.id,
    text: `${patched.text}\nUser note`,
    expectedUpdatedAt: patched.updatedAt,
    mutation: { author: "user", actorId: "detail" },
  });
  const activity = await client.request<BlockEditActivityPage>({
    action: "activity.recent",
    author: "user",
    limit: 5,
  });
  expect(activity.entries).toHaveLength(1);
  expect(activity.entries[0]).toMatchObject({
    block: { id: userUpdated.id, text: userUpdated.text },
    author: "user",
    actorId: "detail",
    kind: "text",
  });
  const catalog = await client.request<PropertyCatalogItem[]>({
    action: "properties.catalog",
    key: "status",
    prefix: "do",
  });
  expect(catalog).toEqual([{ key: "status", value: "doing", count: 1 }]);
  const scoped = await client.request<Block>({
    action: "create",
    text: "Scoped protocol\n\nBody [note::detail]",
  });
  expect((await client.request<VisibleBlockCollection>({
    action: "blocks.query",
    query: { filters: [{ key: "note", value: "detail" }], limit: 10 },
  })).blocks).toEqual([]);
  expect((await client.request<VisibleBlockCollection>({
    action: "blocks.query",
    query: {
      filters: [{ key: "note", value: "detail" }],
      propertyScope: "inline",
      limit: 10,
    },
  })).blocks).toEqual([
    expect.objectContaining({
      id: scoped.id,
      propertyMatches: [
        expect.objectContaining({ key: "note", scope: "inline", line: 2 }),
      ],
    }),
  ]);
  expect(await client.request<PropertyCatalogItem[]>({
    action: "properties.catalog",
    key: "note",
    propertyScope: "all",
  })).toEqual([{ key: "note", value: "detail", count: 1 }]);
  const trashTarget = await client.request<Block>({
    action: "create",
    text: "Protocol Trash target [work-id::PIE-998]",
  });
  const trashed = await client.request<Block>({
    action: "delete",
    blockId: trashTarget.id,
  });
  expect(trashed.effectiveDeletedRootId).toBe(trashTarget.id);
  expect((await client.request<VisibleBlockCollection>({
    action: "blocks.query",
    query: { text: "Protocol Trash target", limit: 10 },
  })).blocks).toEqual([]);
  await client.request({ action: "trash.restore", blockId: trashTarget.id });
  await client.request({ action: "delete", blockId: trashTarget.id });
  await client.request({
    action: "trash.purge",
    blockId: trashTarget.id,
    confirmation: "PIE-998",
  });
  await expect(
    client.request({ action: "get", blockId: trashTarget.id }),
  ).rejects.toThrow("Block not found");
});


test("rejects malformed socket responses instead of crashing the client", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-malformed-"));
  const socketPath = join(directory, "outliner.sock");
  const server = createServer((socket) => socket.end("not-json\n"));
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(socketPath, listening.resolve);
  await listening.promise;
  cleanups.push(async () => {
    const closed = Promise.withResolvers<void>();
    server.close((error) => (error ? closed.reject(error) : closed.resolve()));
    await closed.promise;
    rmSync(directory, { recursive: true, force: true });
  });

  const client = new OutlinerClient(socketPath);
  await expect(client.request({ action: "ping" })).rejects.toThrow();
});

test("streams workspace mutations and transient UI commands to subscribers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-events-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  const socket = join(directory, "outliner.sock");
  const server = new OutlinerServer(store, socket);
  await server.start();
  const view = store.create("Doing [type::virtual-branch] [query::status=doing]");
  const other = store.create("Other [status::doing]");
  const client = new OutlinerClient(socket);
  const connected = Promise.withResolvers<void>();
  const received = Promise.withResolvers<void>();
  const events: OutlinerEvent[] = [];
  const watcher = client.watch({
    client: { clientId: "event-detail", role: "detail", contextId: "event-detail" },
    onConnect: connected.resolve,
    onEvent: (event) => {
      events.push(event);
      if (events.length === 10) received.resolve();
    },
  });
  cleanups.push(async () => {
    await watcher.stop();
    await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  await connected.promise;
  await client.request({ action: "work-ids.configure", prefix: "EVT" });
  const block = await client.request<Block>({ action: "create", text: "Reactive block" });
  const capture = await client.request<CaptureReceipt>({
    action: "capture.create",
    requestId: "event-capture",
    text: "Reactive capture",
    source: "tree",
    capturedFromBlockId: block.id,
  });
  const replay = await client.request<CaptureReceipt>({
    action: "capture.create",
    requestId: "event-capture",
    text: "Reactive capture",
    source: "tree",
    capturedFromBlockId: block.id,
  });
  expect(capture).toEqual({
    block: expect.objectContaining({
      parentId: capture.inboxBlockId,
      properties: expect.arrayContaining([
        { key: "type", value: "capture" },
        { key: "captured-from", value: block.id },
      ]),
    }),
    inboxBlockId: expect.any(String),
    deduplicated: false,
  });
  expect(replay).toEqual({
    block: expect.objectContaining({ id: capture.block.id }),
    inboxBlockId: capture.inboxBlockId,
    deduplicated: true,
  });
  const retainedDraft = await client.request<QuickCaptureDraft>({
    action: "capture.draft.save",
    input: {
      requestId: "retained-event-capture",
      text: "Retained before capture",
      cursorRow: 0,
      cursorColumn: 8,
      capturedFromBlockId: block.id,
      expectedRevision: null,
    },
  });
  expect(await client.request<QuickCaptureDraft | null>({
    action: "capture.draft.get",
  })).toEqual(retainedDraft);
  await client.request({
    action: "capture.draft.clear",
    expectedRevision: retainedDraft.revision,
  });
  expect(await client.request<QuickCaptureDraft | null>({
    action: "capture.draft.get",
  })).toBeNull();
  const retitledCapture = await client.request<Block>({
    action: "capture.retitle",
    blockId: capture.block.id,
    expectedUpdatedAt: capture.block.updatedAt,
    title: "Concise reactive title",
    mutation: { author: "agent", actorId: "omp" },
  });
  expect(retitledCapture.text).toMatch(
    /^Concise reactive title \[type::capture] .*\[captured-from::.*]\n?$/,
  );
  expect(retitledCapture.position).toBe(capture.block.position);
  await client.request({
    action: "work-ids.allocate",
    blockId: block.id,
    expectedUpdatedAt: block.updatedAt,
  });
  await client.request({ action: "selection.set", blockId: block.id });
  await client.request({ action: "navigation.back" });
  await client.request({ action: "navigation.forward" });
  await client.request({
    action: "virtual.occurrences.reorder",
    viewId: view.id,
    orderedBlockIds: [other.id, block.id],
  });
  await client.request({
    action: "ui.command.send",
    command: { targetClientId: "event-detail", command: "edit", target: { kind: "block", blockId: block.id } },
  });
  await received.promise;

  expect(events.map((event) => [event.domain, event.action])).toEqual([
    ["content", "work-ids.configure"],
    ["content", "create"],
    ["content", "capture.create"],
    ["content", "capture.retitle"],
    ["content", "work-ids.allocate"],
    ["selection", "selection.set"],
    ["selection", "navigation.back"],
    ["selection", "navigation.forward"],
    ["view", "virtual.occurrences.reorder"],
    ["ui", "ui.command.send"],
  ]);
  expect(events[1].blockId).toBe(block.id);
  expect(events[2].blockId).toBe(capture.block.id);
  expect(events[3].blockId).toBe(capture.block.id);
  expect(events[4].blockId).toBe(block.id);
  expect(events[9].command).toEqual({ targetClientId: "event-detail", command: "edit", target: { kind: "block", blockId: block.id },  });

  const children = await client.request<Block[]>({ action: "children", parentId: null });
  expect(children.some((candidate) => candidate.id === block.id)).toBe(true);
  const snapshot = await client.request<WorkspaceSnapshot>({ action: "workspace.snapshot" });
  expect(snapshot.visible.blocks.some((candidate) => candidate.id === block.id)).toBe(true);
  expect(snapshot.visible.completeness).toEqual({ kind: "complete" });
  expect(snapshot.workIdPrefix).toBe("EVT");
  expect(snapshot.physical.blocks.some((candidate) => candidate.id === block.id)).toBe(true);
  expect(snapshot.physical.completeness).toEqual({ kind: "complete" });
  expect(snapshot.selection.selected?.id).toBe(block.id);
  expect(snapshot.virtualOccurrenceRanks).toEqual([
    { viewId: view.id, blockId: other.id, rank: 0 },
    { viewId: view.id, blockId: block.id, rank: 1 },
  ]);
});

test("streams bookmark toggles and removals as content events", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-bookmark-events-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  const socket = join(directory, "outliner.sock");
  const server = new OutlinerServer(store, socket);
  await server.start();
  const target = store.create("Bookmark event target");
  const client = new OutlinerClient(socket);
  const connected = Promise.withResolvers<void>();
  const received = Promise.withResolvers<void>();
  const events: OutlinerEvent[] = [];
  const watcher = client.watch({
    client: { clientId: "bookmark-event-detail", role: "detail", contextId: "bookmark-event-detail" },
    onConnect: connected.resolve,
    onEvent: (event) => {
      events.push(event);
      if (events.length === 2) received.resolve();
    },
  });
  cleanups.push(async () => {
    await watcher.stop();
    await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await connected.promise;

  const added = await client.request<BookmarkToggleReceipt>({
    action: "bookmarks.toggle",
    targetBlockId: target.id,
    expectedRecordId: null,
  });
  const removed = await client.request<BookmarkRemoveReceipt>({
    action: "bookmarks.remove",
    recordId: added.record.id,
    expectedUpdatedAt: added.record.updatedAt,
  });
  await received.promise;

  expect(removed.record.deletedAt).toBeDefined();
  expect(events.map((event) => [event.domain, event.action, event.blockId])).toEqual([
    ["content", "bookmarks.toggle", added.record.id],
    ["content", "bookmarks.remove", added.record.id],
  ]);
});

test("isolates browsing-context targets and events across same-workspace client pairs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-contexts-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  const socket = join(directory, "outliner.sock");
  const server = new OutlinerServer(store, socket);
  await server.start();
  const first = store.create("First context target");
  const second = store.create("Second context target");
  const client = new OutlinerClient(socket);
  const firstConnected = Promise.withResolvers<void>();
  const secondConnected = Promise.withResolvers<void>();
  const firstReceived = Promise.withResolvers<void>();
  const secondReceived = Promise.withResolvers<void>();
  const firstEvents: OutlinerEvent[] = [];
  const secondEvents: OutlinerEvent[] = [];
  const firstWatcher = client.watch({
    client: { clientId: "detail-first", role: "detail", contextId: "context-first" },
    onConnect: firstConnected.resolve,
    onEvent: (event) => {
      firstEvents.push(event);
      if (event.domain === "ui") firstReceived.resolve();
    },
  });
  const secondWatcher = client.watch({
    client: { clientId: "detail-second", role: "detail", contextId: "context-second" },
    onConnect: secondConnected.resolve,
    onEvent: (event) => {
      if (event.domain !== "ui") return;
      secondEvents.push(event);
      secondReceived.resolve();
    },
  });
  cleanups.push(async () => {
    await Promise.all([firstWatcher.stop(), secondWatcher.stop()]);
    await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  await Promise.all([firstConnected.promise, secondConnected.promise]);
  await client.request({ action: "browsing-context.publish", sourceClientId: "detail-first",
  contextId: "context-first", target: { kind: "block", blockId: first.id },  });
  await firstReceived.promise;
  await Bun.sleep(20);
  expect(firstEvents).toEqual([
    expect.objectContaining({
      domain: "browsing-context",
      contextId: "context-first",
      blockId: first.id,
    }),
    expect.objectContaining({
      domain: "ui",
      blockId: first.id,
      command: expect.objectContaining({
        targetClientId: "detail-first",
        command: "preview",
      }),
    }),
  ]);
  expect(secondEvents).toEqual([]);

  await client.request({ action: "browsing-context.publish", sourceClientId: "detail-second",
  contextId: "context-second", target: { kind: "block", blockId: second.id },  });
  await secondReceived.promise;
  const firstContext = await client.request<BrowsingContextState>({
    action: "browsing-context.get",
    contextId: "context-first",
  });
  const secondContext = await client.request<BrowsingContextState>({
    action: "browsing-context.get",
    contextId: "context-second",
  });
  expect(firstContext.target).toEqual({ kind: "block", blockId: first.id });
  expect(secondContext.target).toEqual({ kind: "block", blockId: second.id });

  store.delete(first.id);
  store.purge(first.id, first.id.slice(0, 8));
  const purgedContext = await client.request<BrowsingContextState>({
    action: "browsing-context.get",
    contextId: "context-first",
  });
  expect(purgedContext.target).toEqual({ kind: "block", blockId: first.id });
});

test("prunes destroyed client registrations before listing or targeting", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-destroyed-client-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  const server = new OutlinerServer(store, join(directory, "outliner.sock"));
  const sequence = store.sequence;
  const socket = new Socket();
  socket.destroy();
  const subscribers = (server as unknown as {
    subscribers: Map<Socket, OutlinerClientRegistration>;
  }).subscribers;
  subscribers.set(socket, { clientId: "destroyed-tree", role: "tree", contextId: "destroyed-tree" });

  expect(server.handle({ id: "list", action: "clients.list" })).toEqual({
    id: "list",
    ok: true,
    result: [],
    sequence,
  });
  expect(server.handle({
    id: "focus",
    action: "ui.command.send",
    command: { targetClientId: "destroyed-tree", command: "focus" },
  })).toEqual({
    id: "focus",
    ok: false,
    error: "Target client is not registered: destroyed-tree",
    sequence,
  });

  store.close();
  rmSync(directory, { recursive: true, force: true });
});

test("validates direct popup commands and targets only the invoking Detail", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-popup-commands-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  const target = store.create("Backlink target");
  const source = store.create(`Backlink source ((${target.id}))`);
  const socket = join(directory, "outliner.sock");
  const server = new OutlinerServer(store, socket);
  await server.start();
  const client = new OutlinerClient(socket);
  const connected = Promise.withResolvers<void>();
  const received = Promise.withResolvers<void>();
  const replaced = Promise.withResolvers<void>();
  const events: OutlinerEvent[] = [];
  let connectionCount = 0;
  const registrations: OutlinerClientRegistration[] = [
    {
      clientId: "popup-detail",
      role: "detail",
      contextId: "popup-context",
      locked: false,
      runtime: { paneId: "detail-pane", workspaceId: "workspace", tabId: "tab" },
    },
    {
      clientId: "popup-tree",
      role: "tree",
      contextId: "tree-context",
      runtime: { paneId: "tree-pane", workspaceId: "workspace", tabId: "tab" },
    },
  ];
  const watchers = registrations.map((registration) =>
    new OutlinerClient(socket).watch({
      client: registration,
      onConnect: () => {
        connectionCount += 1;
        if (connectionCount === registrations.length) connected.resolve();
      },
      onEvent: (event) => {
        if (registration.clientId !== "popup-detail" || event.domain !== "ui") return;
        events.push(event);
        if (events.length === 2) received.resolve();
        if (events.length === 3) replaced.resolve();
      },
    })
  );
  cleanups.push(async () => {
    await Promise.all(watchers.map((watcher) => watcher.stop()));
    await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await connected.promise;

  for (const invalid of ["false", null]) {
    await expect(client.request({ action: "browsing-context.publish", sourceClientId: "popup-detail",
    contextId: `invalid-dispatch-${String(invalid)}`, target: { kind: "block", blockId: source.id }, dispatchPreview: invalid, } as never)).rejects.toThrow("Browsing context dispatchPreview must be boolean");
  }

  const seeded = await client.request<BrowsingContextPublication>({ action: "browsing-context.publish", sourceClientId: "popup-detail",
  contextId: "seeded-detail-context", target: { kind: "block", blockId: source.id }, dispatchPreview: false, });
  expect(seeded).toEqual({
    contextId: "seeded-detail-context",
    target: { kind: "block", blockId: source.id },
  });
  expect(await client.request<BrowsingContextState>({
    action: "browsing-context.get",
    contextId: "seeded-detail-context",
  })).toEqual({
    contextId: "seeded-detail-context",
    target: { kind: "block", blockId: source.id },
  });

  await client.request({
    action: "ui.command.send",
    command: { targetClientId: "popup-detail", command: "open", target: { kind: "block", blockId: source.id } },
  });
  await client.request({
    action: "ui.command.send",
    command: {
      targetClientId: "popup-detail",
      command: "backlinks.select",
      targetBlockId: target.id,
      sourceBlockId: source.id,
    },
  });
  await received.promise;
  expect(events.map((event) => event.command)).toEqual([
    { targetClientId: "popup-detail", command: "open", target: { kind: "block", blockId: source.id } },
    {
      targetClientId: "popup-detail",
      command: "backlinks.select",
      targetBlockId: target.id,
      sourceBlockId: source.id,
    },
  ]);
  expect(events[1]?.blockId).toBe(target.id);

  await expect(client.request({
    action: "ui.command.send",
    command: { targetClientId: "popup-tree", command: "open", target: { kind: "block", blockId: source.id } },
  })).rejects.toThrow("Direct open target must be a Detail client");
  await expect(client.request({
    action: "ui.command.send",
    command: {
      targetClientId: "popup-tree",
      command: "backlinks.select",
      targetBlockId: target.id,
      sourceBlockId: source.id,
    },
  })).rejects.toThrow("Backlink selection target must be a Detail client");
  await expect(client.request({
    action: "ui.command.send",
    command: { targetClientId: "popup-detail", command: "open", target: { kind: "block", blockId: "missing-block" } },
  })).rejects.toThrow("Block not found: missing-block");
  await expect(client.request({
    action: "ui.command.send",
    command: {
      targetClientId: "popup-detail",
      command: "backlinks.select",
      targetBlockId: target.id,
    } as never,
  })).rejects.toThrow("Backlink selection requires target and source block IDs");

  await client.request({
    action: "clients.update",
    clientId: "popup-detail",
    locked: true,
    currentTarget: { kind: "block", blockId: source.id },
  });
  await expect(client.request({
    action: "ui.command.send",
    command: { targetClientId: "popup-detail", command: "open", target: { kind: "block", blockId: source.id } },
  })).rejects.toThrow("Invoking Detail is locked");
  await client.request({
    action: "ui.command.send",
    command: { targetClientId: "popup-detail", command: "replace", target: { kind: "block", blockId: source.id } },
  });
  await replaced.promise;
  expect(events[2]?.command).toEqual({ targetClientId: "popup-detail", command: "replace", target: { kind: "block", blockId: source.id },  });
  const renderedSelection = {
    quote: "Backlink source",
    capturedAt: "2026-01-02T03:04:05.000Z",
    hostBlockId: source.id,
    paneId: "detail-pane",
    contentRevision: 42,
    contextId: "popup-context",
    detailClientId: "popup-detail",
    validation: "herdr-keybinding" as const,
    snapshotText: "Block Detail\n\nBacklink source",
  };
  await expect(client.request({
    action: "ui.command.send",
    command: {
      targetClientId: "popup-detail",
      command: "comment.selection",
      renderedSelection: { ...renderedSelection, contentRevision: -1 },
    },
  })).rejects.toThrow("Rendered selection evidence is invalid");
  await expect(client.request({
    action: "ui.command.send",
    command: {
      targetClientId: "popup-detail",
      command: "comment.selection",
      renderedSelection: { ...renderedSelection, capturedAt: "not-a-timestamp" },
    },
  })).rejects.toThrow("Rendered selection evidence is invalid");
  await expect(client.request({
    action: "ui.command.send",
    command: {
      targetClientId: "popup-detail",
      command: "comment.selection",
      renderedSelection: { ...renderedSelection, hostBlockId: target.id },
    },
  })).rejects.toThrow("no longer matches the target Detail");
  await client.request({
    action: "ui.command.send",
    command: {
      targetClientId: "popup-detail",
      command: "comment.selection",
      renderedSelection,
    },
  });
});

test("registers multiple live clients, targets one recipient, broadcasts content, and cleans up exact connections", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-clients-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  const socket = join(directory, "outliner.sock");
  const server = new OutlinerServer(store, socket);
  await server.start();
  const client = new OutlinerClient(socket);
  const registrations = [
    { clientId: "tree-a", role: "tree" as const, contextId: "tree-a", runtime: { paneId: "pane-tree-a", workspaceId: "workspace-a", tabId: "tab-a" } },
    { clientId: "tree-b", role: "tree" as const, contextId: "tree-b", runtime: { paneId: "pane-tree-b", workspaceId: "workspace-b", tabId: "tab-b" } },
    { clientId: "detail-a", role: "detail" as const, contextId: "detail-a", locked: false, runtime: { paneId: "pane-detail-a", workspaceId: "workspace-a", tabId: "tab-a" } },
    { clientId: "detail-b", role: "detail" as const, contextId: "detail-b", locked: false, runtime: { paneId: "pane-detail-b", workspaceId: "workspace-b", tabId: "tab-b" } },
  ];
  const events = new Map(registrations.map(({ clientId }) => [clientId, [] as OutlinerEvent[]]));
  const connected = Promise.withResolvers<void>();
  const targeted = Promise.withResolvers<void>();
  const broadcastReceived = Promise.withResolvers<void>();
  let broadcastCount = 0;
  let connectionCount = 0;
  const watchers = registrations.map((registration) =>
    new OutlinerClient(socket).watch({
      client: registration,
      onConnect: () => {
        connectionCount += 1;
        if (connectionCount === registrations.length) connected.resolve();
      },
      onEvent: (event) => {
        events.get(registration.clientId)!.push(event);
        if (event.domain === "content") {
          broadcastCount += 1;
          if (broadcastCount === registrations.length) broadcastReceived.resolve();
        }
        if (registration.clientId === "detail-b" && event.domain === "ui") {
          targeted.resolve();
        }
      },
    })
  );
  cleanups.push(async () => {
    await Promise.all(watchers.map((watcher) => watcher.stop()));
    await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  await connected.promise;
  expect(await client.request<OutlinerClientRegistration[]>({ action: "clients.list" })).toEqual([
    registrations[2],
    registrations[3],
    registrations[0],
    registrations[1],
  ]);
  expect(await client.request<OutlinerClientRegistration[]>({ action: "clients.list", role: "tree" })).toEqual([
    registrations[0],
    registrations[1],
  ]);
  expect(await client.request<{ subscribed: boolean; client: OutlinerClientRegistration }>({
    action: "events.subscribe",
    client: { clientId: " normalized-client ", role: "detail", contextId: " normalized-client ", locked: false, runtime: {} },
  })).toEqual({
    subscribed: true,
    client: { clientId: "normalized-client", role: "detail", contextId: "normalized-client", locked: false },
  });
  await expect(client.request({
    action: "clients.list",
    role: "unknown" as never,
  })).rejects.toThrow("Invalid client role: unknown");
  await expect(client.request({
    action: "events.subscribe",
    client: registrations[0],
  })).rejects.toThrow("Client ID is already registered: tree-a");
  const correlatedResponse = Promise.withResolvers<OutlinerResponse>();
  const duplicateSocket = createConnection(socket);
  duplicateSocket.setEncoding("utf8");
  duplicateSocket.once("error", correlatedResponse.reject);
  duplicateSocket.once("connect", () => {
    duplicateSocket.write(`${JSON.stringify({
      id: "duplicate-registration",
      action: "events.subscribe",
      client: registrations[0],
    })}\n`);
  });
  duplicateSocket.once("data", (line) => {
    correlatedResponse.resolve(JSON.parse(String(line)) as OutlinerResponse);
    duplicateSocket.end();
  });
  expect(await correlatedResponse.promise).toMatchObject({
    id: "duplicate-registration",
    ok: false,
    error: "Client ID is already registered: tree-a",
  });
  await expect(client.request({
    action: "events.subscribe",
    client: { clientId: "invalid-runtime", role: "tree", contextId: "invalid-runtime", runtime: { obsoletePaneState: "pane" } } as unknown as OutlinerClientRegistration,
  })).rejects.toThrow("Invalid client runtime obsoletePaneState");
  await expect(client.request({
    action: "ui.command.send",
    command: { targetClientId: "missing-client", command: "focus" },
  })).rejects.toThrow("Target client is not registered: missing-client");

  const broadcastBlock = await client.request<Block>({
    action: "create",
    text: "Broadcast to every live client",
  });
  await broadcastReceived.promise;
  await client.request({
    action: "ui.command.send",
    command: {
      targetClientId: "detail-b",
      command: "edit",
      target: { kind: "block", blockId: broadcastBlock.id },
    },
  });
  await targeted.promise;
  expect(registrations.map(({ clientId }) =>
    events.get(clientId)!.filter((event) => event.domain === "ui").length
  )).toEqual([0, 0, 0, 1]);

  await watchers[0]!.stop();
  const replacementConnected = Promise.withResolvers<void>();
  const replacementEvents: OutlinerEvent[] = [];
  const replacementReceived = Promise.withResolvers<void>();
  const replacement = new OutlinerClient(socket).watch({
    client: { clientId: "tree-a-restarted", role: "tree", contextId: "tree-a-restarted", runtime: { paneId: "pane-tree-a-next", workspaceId: "workspace-a", tabId: "tab-a" } },
    onConnect: replacementConnected.resolve,
    onEvent: (event) => {
      replacementEvents.push(event);
      if (event.domain === "content") replacementReceived.resolve();
    },
  });
  watchers.push(replacement);
  await replacementConnected.promise;
  const clientsAfterRestart = await client.request<Array<{ clientId: string }>>({
    action: "clients.list",
  });
  expect(clientsAfterRestart.some(({ clientId }) => clientId === "tree-a")).toBe(false);
  expect(clientsAfterRestart).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ clientId: "tree-a-restarted" }),
      expect.objectContaining({ clientId: "tree-b" }),
      expect.objectContaining({ clientId: "detail-a" }),
      expect.objectContaining({ clientId: "detail-b" }),
    ]),
  );
  await client.request({ action: "create", text: "Broadcast after client restart" });
  await replacementReceived.promise;
});

test("watchers reconnect and resubscribe after the service restarts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-reconnect-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  const socket = join(directory, "outliner.sock");
  const server = new OutlinerServer(store, socket);
  await server.start();
  let running = true;
  let connectionCount = 0;
  const firstConnection = Promise.withResolvers<void>();
  const disconnected = Promise.withResolvers<void>();
  const reconnected = Promise.withResolvers<void>();
  const watcher = new OutlinerClient(socket).watch({
    client: { clientId: "reconnecting-tree", role: "tree", contextId: "reconnecting-tree" },
    onConnect: () => {
      connectionCount += 1;
      if (connectionCount === 1) firstConnection.resolve();
      if (connectionCount === 2) reconnected.resolve();
    },
    onDisconnect: disconnected.resolve,
    onEvent: () => {},
  });
  cleanups.push(async () => {
    await watcher.stop();
    if (running) await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  await firstConnection.promise;
  await server.close();
  running = false;
  await disconnected.promise;
  await server.start();
  running = true;
  await reconnected.promise;

  expect(connectionCount).toBe(2);
});

test("watchers reconnect when a subscription is not acknowledged", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-stuck-subscription-"));
  const socketPath = join(directory, "outliner.sock");
  let connectionCount = 0;
  const reconnected = Promise.withResolvers<void>();
  const server = createServer((socket) => {
    const connectionNumber = ++connectionCount;
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0 || connectionNumber === 1) return;
      const request = JSON.parse(buffer.slice(0, newline)) as OutlinerRequest;
      socket.write(`${JSON.stringify({ id: request.id, ok: true, result: { subscribed: true } })}\n`);
    });
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(socketPath, listening.resolve);
  await listening.promise;

  const watcher = new OutlinerClient(socketPath).watch({
    client: { clientId: "ack-tree", role: "tree", contextId: "ack-tree" },
    onConnect: reconnected.resolve,
    onEvent: () => {},
  });
  cleanups.push(async () => {
    await watcher.stop();
    const closed = Promise.withResolvers<void>();
    server.close((error) => (error ? closed.reject(error) : closed.resolve()));
    await closed.promise;
    rmSync(directory, { recursive: true, force: true });
  });

  await reconnected.promise;

  expect(connectionCount).toBe(2);
}, 6_000);

test.each(["remote", "custom"] as const)(
  "%s client timeout allows subscription acknowledgements beyond the local deadline",
  async (mode) => {
    const directory = mkdtempSync(join(tmpdir(), "pi-outliner-delayed-subscription-"));
    const socketPath = join(directory, "outliner.sock");
    const connected = Promise.withResolvers<void>();
    const errors: Error[] = [];
    let connectionCount = 0;
    const server = createServer((socket) => {
      connectionCount += 1;
      let buffer = "";
      let acknowledgementTimer: ReturnType<typeof setTimeout> | undefined;
      socket.setEncoding("utf8");
      socket.once("close", () => clearTimeout(acknowledgementTimer));
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0 || acknowledgementTimer) return;
        const request = JSON.parse(buffer.slice(0, newline)) as OutlinerRequest;
        acknowledgementTimer = setTimeout(() => {
          socket.write(`${JSON.stringify({ id: request.id, ok: true, result: { subscribed: true } })}\n`);
        }, 3_200);
      });
    });
    const listening = Promise.withResolvers<void>();
    server.once("error", listening.reject);
    server.listen(socketPath, listening.resolve);
    await listening.promise;

    const client = mode === "remote"
      ? createOutlinerClient({ socket: socketPath, mode })
      : new OutlinerClient(socketPath, 5_000);
    const watcher = client.watch({
      client: { clientId: "delayed-tree", role: "tree", contextId: "delayed-tree" },
      onConnect: connected.resolve,
      onEvent: () => {},
      onError: (error) => {
        errors.push(error);
        connected.reject(error);
      },
    });
    cleanups.push(async () => {
      await watcher.stop();
      const closed = Promise.withResolvers<void>();
      server.close((error) => (error ? closed.reject(error) : closed.resolve()));
      await closed.promise;
      rmSync(directory, { recursive: true, force: true });
    });

    await connected.promise;
    expect(connectionCount).toBe(1);
    expect(errors).toEqual([]);
  },
  6_000,
);

test("stopping a connected watcher does not report a disconnect", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-stop-watcher-"));
  const socketPath = join(directory, "outliner.sock");
  const connected = Promise.withResolvers<void>();
  const connectionClosed = Promise.withResolvers<void>();
  let disconnectCount = 0;
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.once("close", connectionClosed.resolve);
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline)) as OutlinerRequest;
      socket.write(`${JSON.stringify({ id: request.id, ok: true, result: { subscribed: true } })}\n`);
    });
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(socketPath, listening.resolve);
  await listening.promise;

  const watcher = new OutlinerClient(socketPath).watch({
    client: { clientId: "stop-tree", role: "tree", contextId: "stop-tree" },
    onConnect: connected.resolve,
    onDisconnect: () => {
      disconnectCount += 1;
    },
    onEvent: () => {},
  });
  cleanups.push(async () => {
    await watcher.stop();
    const closed = Promise.withResolvers<void>();
    server.close((error) => (error ? closed.reject(error) : closed.resolve()));
    await closed.promise;
    rmSync(directory, { recursive: true, force: true });
  });

  await connected.promise;
  await watcher.stop();
  await connectionClosed.promise;

  expect(disconnectCount).toBe(0);
});

test("routes previews and opens to the first spatially unlocked Detail", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-routes-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  const target = store.create("Navigation target\n\n## Decision ^durable-decision");
  const socket = join(directory, "outliner.sock");
  const server = new OutlinerServer(store, socket);
  await server.start();

  const registrations: OutlinerClientRegistration[] = [
    { clientId: "tree-a", role: "tree", contextId: "context-a", runtime: { hostname: hostname(), workspaceId: "ws", tabId: "tab-1", paneId: "pane-a", paneX: 0, paneY: 0 } },
    { clientId: "tree-b", role: "tree", contextId: "context-b", runtime: { hostname: hostname(), workspaceId: "ws", tabId: "tab-1", paneId: "pane-b", paneX: 0, paneY: 20 } },
    { clientId: "detail-c", role: "detail", contextId: "context-a", locked: false, runtime: { hostname: hostname(), workspaceId: "ws", tabId: "tab-1", paneId: "pane-c", paneX: 40, paneY: 0 } },
    { clientId: "detail-d", role: "detail", contextId: "context-d", locked: false, runtime: { hostname: hostname(), workspaceId: "ws", tabId: "tab-1", paneId: "pane-d", paneX: 80, paneY: 0 } },
    { clientId: "tree-oi", role: "tree", contextId: "context-oi", runtime: { hostname: hostname(), workspaceId: "ws", tabId: "tab-oi", paneId: "pane-oi-tree", paneX: 0, paneY: 0 } },
    { clientId: "detail-oi", role: "detail", contextId: "context-oi", locked: false, runtime: { hostname: hostname(), workspaceId: "ws", tabId: "tab-oi", paneId: "pane-oi-detail", paneX: 40, paneY: 0 } },
  ];
  const connected = registrations.map(() => Promise.withResolvers<void>());
  const received = new Map<string, OutlinerEvent[]>();
  const pendingCommands: Array<{
    clientId: string;
    command: NonNullable<OutlinerEvent["command"]>["command"];
    resolve: (event: OutlinerEvent) => void;
  }> = [];
  const nextCommand = (
    clientId: string,
    command: NonNullable<OutlinerEvent["command"]>["command"],
  ): Promise<OutlinerEvent> => {
    const received = Promise.withResolvers<OutlinerEvent>();
    pendingCommands.push({ clientId, command, resolve: received.resolve });
    return received.promise;
  };
  const watchers = registrations.map((registration, index) =>
    new OutlinerClient(socket).watch({
      client: registration,
      onConnect: connected[index]!.resolve,
      onEvent: (event) => {
        const events = received.get(registration.clientId) ?? [];
        events.push(event);
        received.set(registration.clientId, events);
        const pendingIndex = pendingCommands.findIndex((pending) =>
          pending.clientId === registration.clientId &&
          event.domain === "ui" &&
          event.command?.command === pending.command
        );
        if (pendingIndex !== -1) pendingCommands.splice(pendingIndex, 1)[0]!.resolve(event);
      },
    })
  );
  cleanups.push(async () => {
    for (const watcher of watchers) await watcher.stop();
    await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await Promise.all(connected.map(({ promise }) => promise));
  const client = new OutlinerClient(socket);

  const launchClients = await client.request<OutlinerClientRegistration[]>({
    action: "clients.list",
  });
  expect(launchClients.find(({ clientId }) => clientId === "tree-a")?.runtime)
    .toEqual(registrations[0]!.runtime);

  const firstOpenReceived = nextCommand("detail-c", "open");
  const firstOpen = await client.request<OutlinerNavigationDispatch>({ action: "navigation.dispatch", sourceClientId: "tree-a", target: { kind: "block", blockId: target.id }, intent: "open", });
  await firstOpenReceived;
  expect(firstOpen).toMatchObject({
    targetClientId: "detail-c",
    resolution: "unlocked",
    command: { targetClientId: "detail-c", command: "open", target: { kind: "block", blockId: target.id } },
  });
  const fragmentOpenReceived = nextCommand("detail-c", "open");
  const fragmentOpen = await client.request<OutlinerNavigationDispatch>({
    action: "navigation.dispatch",
    sourceClientId: "tree-a",
    target: { kind: "block", blockId: target.id, fragmentId: "durable-decision" },
    intent: "open",
  });
  await fragmentOpenReceived;
  expect(fragmentOpen.command).toEqual({
    targetClientId: "detail-c",
    command: "open",
    target: { kind: "block", blockId: target.id, fragmentId: "durable-decision" },
  });
  await expect(client.request({
    action: "navigation.dispatch",
    sourceClientId: "tree-a",
    target: { kind: "block", blockId: target.id, fragmentId: "stale-decision" },
    intent: "open",
  })).rejects.toThrow(`Fragment not found: ${target.id}^stale-decision`);

  const sourcePreservingOpenReceived = nextCommand("detail-d", "open");
  const sourcePreservingOpen = await client.request<OutlinerNavigationDispatch>({ action: "navigation.dispatch", sourceClientId: "detail-c", target: { kind: "block", blockId: target.id }, intent: "open",
  preserveSource: true, });
  await sourcePreservingOpenReceived;
  expect(sourcePreservingOpen).toMatchObject({
    sourceClientId: "detail-c",
    targetClientId: "detail-d",
    resolution: "unlocked",
  });

  await client.request({
    action: "clients.update",
    clientId: "detail-c",
    locked: true,
    currentTarget: { kind: "block", blockId: target.id },
  });
  expect(
    (await client.request<OutlinerClientRegistration[]>({ action: "clients.list" }))
      .find(({ clientId }) => clientId === "detail-c"),
  ).toMatchObject({
    locked: true,
    currentTarget: { kind: "block", blockId: target.id },
  });
  const nextOpenReceived = nextCommand("detail-d", "open");
  const nextOpen = await client.request<OutlinerNavigationDispatch>({ action: "navigation.dispatch", sourceClientId: "detail-c", target: { kind: "block", blockId: target.id }, intent: "open", });
  await nextOpenReceived;
  expect(nextOpen).toMatchObject({
    targetClientId: "detail-d",
    resolution: "unlocked",
  });

  const previewReceived = nextCommand("detail-d", "preview");
  const published = await client.request<BrowsingContextPublication>({ action: "browsing-context.publish", sourceClientId: "tree-a",
  contextId: "context-a", target: { kind: "block", blockId: target.id },  });
  await previewReceived;
  expect(published.preview).toMatchObject({
    targetClientId: "detail-d",
    command: { targetClientId: "detail-d", command: "preview", target: { kind: "block", blockId: target.id } },
  });

  const otherTabOpenReceived = nextCommand("detail-oi", "open");
  const otherTab = await client.request<OutlinerNavigationDispatch>({ action: "navigation.dispatch", sourceClientId: "tree-oi", target: { kind: "block", blockId: target.id }, intent: "open", });
  await otherTabOpenReceived;
  expect(otherTab.targetClientId).toBe("detail-oi");

  const revealReceived = nextCommand("tree-a", "reveal");
  const reveal = await client.request<OutlinerNavigationDispatch>({ action: "navigation.dispatch", sourceClientId: "tree-a", target: { kind: "block", blockId: target.id }, intent: "reveal",
  focusTarget: true, });
  const revealEvent = await revealReceived;
  expect(reveal).toMatchObject({
    targetClientId: "tree-a",
    resolution: "self",
    command: { targetClientId: "tree-a", command: "reveal", target: { kind: "block", blockId: target.id }, focus: true },
  });
  expect(revealEvent.command && "focus" in revealEvent.command
    ? revealEvent.command.focus
    : undefined).toBe(true);

  const detailRevealReceived = nextCommand("tree-a", "reveal");
  const detailReveal = await client.request<OutlinerNavigationDispatch>({ action: "navigation.dispatch", sourceClientId: "detail-c", target: { kind: "block", blockId: target.id }, intent: "reveal",
  focusTarget: true, });
  await detailRevealReceived;
  expect(detailReveal).toMatchObject({
    targetClientId: "tree-a",
    resolution: "context",
    command: { targetClientId: "tree-a", command: "reveal", target: { kind: "block", blockId: target.id }, focus: true },
  });
  await expect(client.request({ action: "navigation.dispatch", sourceClientId: "tree-a", target: { kind: "block", blockId: target.id }, intent: "open",
  focusTarget: true, })).rejects.toThrow("Focused navigation dispatch requires reveal intent");

  await client.request({ action: "clients.update", clientId: "detail-d", locked: true });
  await expect(client.request({ action: "navigation.dispatch", sourceClientId: "tree-b", target: { kind: "block", blockId: target.id }, intent: "open", })).rejects.toThrow("All Details in this tab are locked · unlock one or open another Detail");
  await expect(client.request({ action: "navigation.dispatch", sourceClientId: "detail-c", target: { kind: "block", blockId: target.id }, intent: "open",
  preserveSource: true, })).rejects.toThrow(
    "No other unlocked Detail is available · unlock one or open another Detail",
  );

  expect(pendingCommands).toEqual([]);
  expect(received.get("detail-c")?.some((event) => event.command?.command === "open")).toBe(true);
  expect(received.get("detail-d")?.some((event) => event.command?.command === "open")).toBe(true);
  expect(received.get("detail-d")?.some((event) => event.command?.command === "preview")).toBe(true);
  expect(received.get("detail-oi")?.some((event) => event.command?.command === "open")).toBe(true);
});

test("reconciles long-lived clients against live Herdr pane topology", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-live-topology-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  const socket = join(directory, "outliner.sock");
  const registry = new HerdrRuntimeRegistry();
  const replaceTopology = (panes: Array<{
    paneId: string;
    terminalId: string;
    workspaceId: string;
    tabId: string;
    x?: number;
    y?: number;
  }>): void => {
    const tabs = [...new Map(panes.map((pane) => [
      pane.tabId,
      { tab_id: pane.tabId, workspace_id: pane.workspaceId },
    ])).values()];
    const workspaces = [...new Map(tabs.map((tab) => [
      tab.workspace_id,
      { workspace_id: tab.workspace_id, active_tab_id: tab.tab_id },
    ])).values()];
    registry.replaceSnapshot({
      version: "test",
      protocol: 1,
      workspaces,
      tabs,
      panes: panes.map((pane) => ({
        pane_id: pane.paneId,
        terminal_id: pane.terminalId,
        workspace_id: pane.workspaceId,
        tab_id: pane.tabId,
      })),
      layouts: tabs.map((tab) => {
        const tabPanes = panes.filter((pane) => pane.tabId === tab.tab_id);
        return {
          workspace_id: tab.workspace_id,
          tab_id: tab.tab_id,
          focused_pane_id: tabPanes[0]!.paneId,
          panes: tabPanes.map((pane) => ({
            pane_id: pane.paneId,
            ...(pane.x !== undefined && pane.y !== undefined
              ? { rect: { x: pane.x, y: pane.y } }
              : {}),
          })),
        };
      }),
      agents: [],
    } satisfies HerdrSessionSnapshot);
  };
  const server = new OutlinerServer(store, socket, registry);
  await server.start();

  const registrations: OutlinerClientRegistration[] = [
    {
      clientId: "tree-live",
      role: "tree",
      contextId: "live",
      runtime: {
        paneId: "tree-pane-at-launch",
        terminalId: "term-tree",
        workspaceId: "ws-at-launch",
        tabId: "tab-at-launch",
        paneX: 900,
        paneY: 900,
      },
    },
    {
      clientId: "detail-a-live",
      role: "detail",
      contextId: "live",
      locked: false,
      runtime: {
        paneId: "detail-a-at-launch",
        terminalId: "term-a",
        workspaceId: "ws-at-launch",
        tabId: "tab-at-launch",
        paneX: 900,
        paneY: 900,
      },
    },
    {
      clientId: "detail-b-live",
      role: "detail",
      contextId: "detail-b-independent",
      locked: false,
      runtime: {
        paneId: "detail-b-at-launch",
        terminalId: "term-b",
        workspaceId: "ws-at-launch",
        tabId: "tab-at-launch",
        paneX: 900,
        paneY: 900,
      },
    },
    {
      clientId: "detail-unresolved",
      role: "detail",
      contextId: "unresolved",
      locked: false,
      runtime: {
        paneId: "fallback-pane",
        terminalId: "term-not-live",
        workspaceId: "fallback-workspace",
        tabId: "fallback-tab",
        paneX: 12,
        paneY: 34,
      },
    },
  ];
  const connected = registrations.map(() => Promise.withResolvers<void>());
  let connectionCount = 0;
  const watchers = registrations.map((registration, index) =>
    new OutlinerClient(socket).watch({
      client: registration,
      onConnect: () => {
        connectionCount += 1;
        connected[index]!.resolve();
      },
      onEvent: () => {},
    })
  );
  cleanups.push(async () => {
    await Promise.all(watchers.map((watcher) => watcher.stop()));
    await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await Promise.all(connected.map(({ promise }) => promise));
  const client = new OutlinerClient(socket);

  const unavailableClients = await client.request<OutlinerClientRegistration[]>({
    action: "clients.list",
  });
  expect(unavailableClients.find(({ clientId }) => clientId === "tree-live")?.runtime)
    .toEqual({ terminalId: "term-tree" });
  await expect(client.request({
    action: "navigation.resolve",
    sourceClientId: "tree-live",
    intent: "open",
  })).rejects.toThrow();

  replaceTopology([
    { paneId: "tree-pane-old", terminalId: "term-tree", workspaceId: "ws-old", tabId: "tab-old", x: 0, y: 0 },
    { paneId: "detail-a-old", terminalId: "term-a", workspaceId: "ws-old", tabId: "tab-old", x: 40, y: 0 },
    { paneId: "detail-b-old", terminalId: "term-b", workspaceId: "ws-old", tabId: "tab-old", x: 80, y: 0 },
  ]);

  const initialClients = await client.request<OutlinerClientRegistration[]>({
    action: "clients.list",
  });
  expect(initialClients.find(({ clientId }) => clientId === "tree-live")?.runtime).toEqual({
    hostname: hostname(),
    paneId: "tree-pane-old",
    terminalId: "term-tree",
    workspaceId: "ws-old",
    tabId: "tab-old",
    paneX: 0,
    paneY: 0,
    focused: false,
    visible: true,
  });
  expect(initialClients.find(({ clientId }) => clientId === "detail-unresolved")?.runtime)
    .toEqual({ terminalId: "term-not-live" });
  expect(await client.request<OutlinerNavigationDispatch>({
    action: "navigation.resolve",
    sourceClientId: "tree-live",
    intent: "open",
  })).toMatchObject({ targetClientId: "detail-a-live" });
  expect(await client.request<OutlinerNavigationDispatch>({
    action: "navigation.resolve",
    sourceClientId: "detail-b-live",
    intent: "reveal",
  })).toMatchObject({
    targetClientId: "tree-live",
    resolution: "same-tab",
  });

  registry.markStale();
  const staleClients = await client.request<OutlinerClientRegistration[]>({
    action: "clients.list",
  });
  expect(staleClients.find(({ clientId }) => clientId === "tree-live")?.runtime)
    .toEqual({ terminalId: "term-tree" });
  await expect(client.request({
    action: "navigation.resolve",
    sourceClientId: "tree-live",
    intent: "open",
  })).rejects.toThrow();

  replaceTopology([
    { paneId: "tree-pane-renamed", terminalId: "term-tree", workspaceId: "ws-new", tabId: "tab-new", x: 0, y: 0 },
    { paneId: "detail-b-renamed", terminalId: "term-b", workspaceId: "ws-new", tabId: "tab-new", x: 30, y: 0 },
    { paneId: "detail-a-renamed", terminalId: "term-a", workspaceId: "ws-old", tabId: "tab-old", x: 10, y: 0 },
  ]);
  const movedClients = await client.request<OutlinerClientRegistration[]>({
    action: "clients.list",
  });
  expect(movedClients.find(({ clientId }) => clientId === "tree-live")?.runtime).toEqual({
    hostname: hostname(),
    paneId: "tree-pane-renamed",
    terminalId: "term-tree",
    workspaceId: "ws-new",
    tabId: "tab-new",
    paneX: 0,
    paneY: 0,
    focused: false,
    visible: true,
  });
  expect(await client.request<OutlinerNavigationDispatch>({
    action: "navigation.resolve",
    sourceClientId: "tree-live",
    intent: "open",
  })).toMatchObject({ targetClientId: "detail-b-live" });

  replaceTopology([
    { paneId: "tree-pane-final", terminalId: "term-tree", workspaceId: "ws-new", tabId: "tab-new" },
    { paneId: "detail-b-final", terminalId: "term-b", workspaceId: "ws-new", tabId: "tab-new", x: 80, y: 0 },
    { paneId: "detail-a-final", terminalId: "term-a", workspaceId: "ws-new", tabId: "tab-new", x: 20, y: 0 },
  ]);
  const reorderedClients = await client.request<OutlinerClientRegistration[]>({
    action: "clients.list",
  });
  expect(reorderedClients.find(({ clientId }) => clientId === "tree-live")?.runtime).toEqual({
    hostname: hostname(),
    paneId: "tree-pane-final",
    terminalId: "term-tree",
    workspaceId: "ws-new",
    tabId: "tab-new",
    focused: false,
    visible: true,
  });
  expect(await client.request<OutlinerNavigationDispatch>({
    action: "navigation.resolve",
    sourceClientId: "tree-live",
    intent: "open",
  })).toMatchObject({ targetClientId: "detail-a-live" });

  replaceTopology([
    { paneId: "tree-pane-only", terminalId: "term-tree", workspaceId: "ws-new", tabId: "tab-new", x: 0, y: 0 },
  ]);
  const vanishedClients = await client.request<OutlinerClientRegistration[]>({
    action: "clients.list",
  });
  expect(vanishedClients.find(({ clientId }) => clientId === "detail-a-live")?.runtime)
    .toEqual({ terminalId: "term-a" });
  expect(vanishedClients.find(({ clientId }) => clientId === "detail-b-live")?.runtime)
    .toEqual({ terminalId: "term-b" });
  await expect(client.request({
    action: "navigation.resolve",
    sourceClientId: "tree-live",
    intent: "open",
  })).rejects.toThrow("No Detail is available in this tab · open another Detail");
  await expect(client.request({
    action: "navigation.resolve",
    sourceClientId: "detail-a-live",
    intent: "reveal",
  })).rejects.toThrow();
  expect(connectionCount).toBe(registrations.length);
});

test("requires known hostnames for same-tab routing without a registry", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-unknown-host-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  const socket = join(directory, "outliner.sock");
  const server = new OutlinerServer(store, socket);
  await server.start();
  const runtime = { workspaceId: "workspace", tabId: "tab" };
  const registrations: OutlinerClientRegistration[] = [
    { clientId: "tree", role: "tree", contextId: "tree-context", runtime },
    { clientId: "detail", role: "detail", contextId: "detail-context", runtime },
  ];
  const connected = registrations.map(() => Promise.withResolvers<void>());
  const watchers = registrations.map((registration, index) =>
    new OutlinerClient(socket).watch({
      client: registration,
      onConnect: connected[index]!.resolve,
      onEvent() {},
    })
  );
  cleanups.push(async () => {
    await Promise.all(watchers.map((watcher) => watcher.stop()));
    await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await Promise.all(connected.map(({ promise }) => promise));
  const client = new OutlinerClient(socket);

  for (const treeHostname of [undefined, "laptop.invalid"]) {
    await client.request({
      action: "clients.update",
      clientId: "tree",
      runtime: { ...runtime, ...(treeHostname ? { hostname: treeHostname } : {}) },
    });
    await expect(client.request({
      action: "navigation.resolve", sourceClientId: "tree", intent: "open",
    })).rejects.toThrow("No Detail is available in this tab");
    await expect(client.request({
      action: "navigation.resolve", sourceClientId: "detail", intent: "reveal",
    })).rejects.toThrow("No Tree destination is available");
  }

  await client.request({
    action: "clients.update",
    clientId: "detail",
    runtime: { ...runtime, hostname: "laptop.invalid" },
  });
  expect(await client.request<OutlinerNavigationDispatch>({
    action: "navigation.resolve", sourceClientId: "tree", intent: "open",
  })).toMatchObject({ targetClientId: "detail", resolution: "unlocked" });
  expect(await client.request<OutlinerNavigationDispatch>({
    action: "navigation.resolve", sourceClientId: "detail", intent: "reveal",
  })).toMatchObject({ targetClientId: "tree", resolution: "same-tab" });
});

test("preserves client-owned topology and routes only within its host", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-remote-topology-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  const socket = join(directory, "outliner.sock");
  const server = new OutlinerServer(store, socket, new HerdrRuntimeRegistry());
  await server.start();
  const registrations: OutlinerClientRegistration[] = [
    {
      clientId: "remote-tree",
      role: "tree",
      contextId: "remote",
      runtime: {
        hostname: "laptop-a.invalid",
        paneId: "tree-pane",
        terminalId: "tree-terminal",
        workspaceId: "workspace",
        tabId: "tab",
        paneX: 0,
        paneY: 0,
      },
    },
    {
      clientId: "remote-detail",
      role: "detail",
      contextId: "remote",
      locked: false,
      runtime: {
        hostname: "laptop-a.invalid",
        paneId: "detail-pane",
        terminalId: "detail-terminal",
        workspaceId: "workspace",
        tabId: "tab",
        paneX: 40,
        paneY: 0,
      },
    },
    {
      clientId: "other-host-detail",
      role: "detail",
      contextId: "remote",
      locked: false,
      runtime: {
        hostname: "laptop-b.invalid",
        paneId: "other-pane",
        terminalId: "other-terminal",
        workspaceId: "workspace",
        tabId: "tab",
        paneX: 1,
        paneY: 0,
      },
    },
  ];
  const connected = registrations.map(() => Promise.withResolvers<void>());
  const watchers = registrations.map((registration, index) =>
    new OutlinerClient(socket).watch({
      client: registration,
      onConnect: connected[index]!.resolve,
      onEvent() {},
    })
  );
  cleanups.push(async () => {
    await Promise.all(watchers.map((watcher) => watcher.stop()));
    await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await Promise.all(connected.map(({ promise }) => promise));
  const client = new OutlinerClient(socket);

  const clients = await client.request<OutlinerClientRegistration[]>({
    action: "clients.list",
  });
  expect(clients.find(({ clientId }) => clientId === "remote-tree")?.runtime)
    .toEqual(registrations[0]!.runtime);
  expect(await client.request<OutlinerNavigationDispatch>({
    action: "navigation.resolve",
    sourceClientId: "remote-tree",
    intent: "open",
  })).toMatchObject({
    targetClientId: "remote-detail",
    resolution: "unlocked",
  });
  const movedRuntime = {
    ...registrations[1]!.runtime,
    tabId: "other-tab",
    focused: true,
    visible: true,
  };
  await client.request({
    action: "clients.update",
    clientId: "remote-detail",
    runtime: movedRuntime,
  });
  const movedClients = await client.request<OutlinerClientRegistration[]>({
    action: "clients.list",
  });
  expect(movedClients.find(({ clientId }) => clientId === "remote-detail")?.runtime)
    .toEqual(movedRuntime);
  await expect(client.request({
    action: "navigation.resolve",
    sourceClientId: "remote-tree",
    intent: "open",
  })).rejects.toThrow("No Detail is available in this tab");
});

test("targets ephemeral attention, advances atomically, stales on edits, and expires", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-attention-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  const source = store.create("alpha 🧭 beta\nsecond passage");
  const socket = join(directory, "outliner.sock");
  const server = new OutlinerServer(store, socket);
  await server.start();
  const client = new OutlinerClient(socket);
  const connected = Promise.withResolvers<void>();
  const firstAttention = Promise.withResolvers<void>();
  const staleAttention = Promise.withResolvers<void>();
  const expiredAttention = Promise.withResolvers<void>();
  const firstEvents: OutlinerEvent[] = [];
  const secondEvents: OutlinerEvent[] = [];
  let connectionCount = 0;
  const watchers = [
    { clientId: "attention-detail-one", events: firstEvents },
    { clientId: "attention-detail-two", events: secondEvents },
  ].map(({ clientId, events }) =>
    new OutlinerClient(socket).watch({
      client: { clientId, role: "detail", contextId: clientId },
      onConnect: () => {
        connectionCount += 1;
        if (connectionCount === 2) connected.resolve();
      },
      onEvent: (event) => {
        events.push(event);
        if (event.domain !== "attention") return;
        if (event.action === "attention.mark") firstAttention.resolve();
        if (event.action === "attention.stale") staleAttention.resolve();
        if (event.action === "attention.expired") expiredAttention.resolve();
      },
    })
  );
  cleanups.push(async () => {
    await Promise.all(watchers.map((watcher) => watcher.stop()));
    await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await connected.promise;

  const firstAnchor = createAnnotationAnchor(source.text, 6, 13, source.updatedAt);
  const marked = await client.request<AttentionClientState>({
    action: "attention.mark",
    input: {
      markId: "current-one",
      targetClientId: "attention-detail-one",
      target: { kind: "block", sourceBlockId: source.id, anchor: firstAnchor },
      tone: "warning",
      sender: "agent-test",
      expiresInMs: 2_000,
      reveal: true,
    },
  });
  await firstAttention.promise;
  await Bun.sleep(20);
  expect(marked.currentMarkId).toBe("current-one");
  expect(marked.pendingCount).toBe(1);
  expect(marked.marks[0]?.target.anchor?.excerpt).toBe("🧭 beta");
  expect(store.require(source.id).text).toBe(source.text);
  expect(firstEvents.at(-1)).toEqual(expect.objectContaining({
    domain: "attention",
    blockId: source.id,
    attentionInstruction: { markId: "current-one", reveal: true, focus: false },
  }));
  expect(secondEvents).toEqual([]);

  await expect(client.request({
    action: "attention.mark",
    input: {
      markId: "wrong-client",
      targetClientId: "missing-detail",
      target: { kind: "block", sourceBlockId: source.id },
      tone: "current",
      sender: "agent-test",
    },
  })).rejects.toThrow("not registered");
  await expect(client.request({
    action: "attention.mark",
    input: {
      markId: "stale-source",
      targetClientId: "attention-detail-one",
      target: {
        kind: "block",
        sourceBlockId: source.id,
        anchor: { ...firstAnchor, sourceHash: "stale" },
      },
      tone: "current",
      sender: "agent-test",
    },
  })).rejects.toThrow("source evidence");

  for (let index = 0; index < 10; index += 1) {
    await client.request<AttentionClientState>({
      action: "attention.mark",
      input: {
        markId: `support-${index}`,
        targetClientId: "attention-detail-one",
        target: { kind: "block", sourceBlockId: source.id },
        tone: "info",
        role: "supporting",
        sender: "agent-test",
        expiresInMs: 2_000,
      },
    });
  }
  const secondStart = source.text.indexOf("second");
  const advanced = await client.request<AttentionClientState>({
    action: "attention.advance",
    input: {
      markId: "current-two",
      targetClientId: "attention-detail-one",
      target: {
        kind: "block",
        sourceBlockId: source.id,
        anchor: createAnnotationAnchor(
          source.text,
          secondStart,
          secondStart + "second".length,
          source.updatedAt,
        ),
      },
      tone: "current",
      sender: "agent-test",
      expiresInMs: 2_000,
      reveal: true,
      focus: true,
    },
  });
  expect(advanced.currentMarkId).toBe("current-two");
  expect(advanced.marks.filter((mark) => mark.role === "current")).toHaveLength(1);
  expect(advanced.marks.filter((mark) => mark.role === "supporting")).toHaveLength(8);

  const partiallyAcknowledged = await client.request<AttentionClientState>({
    action: "attention.acknowledge",
    input: { targetClientId: "attention-detail-one", markId: "current-two" },
  });
  expect(partiallyAcknowledged.pendingCount).toBe(8);
  expect(
    partiallyAcknowledged.marks.find((mark) => mark.markId === "current-two")?.acknowledgedAt,
  ).toBeDefined();
  expect(partiallyAcknowledged.marks.filter((mark) => !mark.acknowledgedAt)).toHaveLength(8);

  const acknowledged = await client.request<AttentionClientState>({
    action: "attention.acknowledge",
    input: { targetClientId: "attention-detail-one" },
  });
  expect(acknowledged.pendingCount).toBe(0);
  expect(acknowledged.marks.every((mark) => mark.acknowledgedAt)).toBe(true);

  const updated = await client.request<Block>({
    action: "update",
    blockId: source.id,
    text: `prefix ${source.text}`,
    expectedUpdatedAt: source.updatedAt,
    mutation: { author: "user", actorId: "test" },
  });
  await staleAttention.promise;
  const stale = await client.request<AttentionClientState>({
    action: "attention.get",
    targetClientId: "attention-detail-one",
  });
  expect(stale.marks.find((mark) => mark.markId === "current-two")?.sourceState).toBe("stale");
  expect(stale.marks.find((mark) => mark.markId === "current-two")?.target.anchor?.start)
    .toBe(secondStart);

  const cleared = await client.request<AttentionClientState>({
    action: "attention.clear",
    input: { targetClientId: "attention-detail-one" },
  });
  expect(cleared.marks).toEqual([]);
  expect(cleared.pendingCount).toBe(0);

  const expiryStart = updated.text.indexOf("prefix");
  await client.request<AttentionClientState>({
    action: "attention.mark",
    input: {
      markId: "expires",
      targetClientId: "attention-detail-one",
      target: {
        kind: "block",
        sourceBlockId: source.id,
        anchor: createAnnotationAnchor(
          updated.text,
          expiryStart,
          expiryStart + "prefix".length,
          updated.updatedAt,
        ),
      },
      tone: "dim",
      sender: "agent-test",
      expiresInMs: 100,
    },
  });
  await Promise.race([
    expiredAttention.promise,
    Bun.sleep(1_000).then(() => {
      throw new Error("Attention expiry event timed out");
    }),
  ]);
  expect(await client.request<AttentionClientState>({
    action: "attention.get",
    targetClientId: "attention-detail-one",
  })).toEqual(expect.objectContaining({ marks: [], pendingCount: 0 }));
});

test("streams one content event for a fresh workflow promotion and none for its replay", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-promotion-events-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  const source = store.create("Review\n\n## Decision\nKeep the explicit boundary.");
  const start = source.text.indexOf("Decision");
  const promotionContentHash = annotationSourceHash(source.text);
  const promotionRepresentation: AnnotationRepresentation = {
    id: `block:${source.id}:${source.updatedAt}`,
    subject: { kind: "block", blockId: source.id },
    sourceSnapshot: {
      kind: "block",
      blockId: source.id,
      updatedAt: source.updatedAt,
      contentHash: promotionContentHash,
    },
    adapter: null,
    mediaType: "text/markdown",
    contentHash: promotionContentHash,
    capturedAt: source.updatedAt,
  };
  const annotation = store.createAnnotation(
    "promotion-event-annotation",
    {
      target: {
        representation: promotionRepresentation,
        anchor: createTextQuoteAnchor(
          source.text,
          start,
          start + "Decision".length,
        ),
      },
      body: "Promote the approved decision.",
      source: "user",
    },
    "user",
  ).annotations[0]!;
  const socket = join(directory, "outliner.sock");
  const server = new OutlinerServer(store, socket);
  await server.start();
  const client = new OutlinerClient(socket);
  const connected = Promise.withResolvers<void>();
  const barrierReceived = Promise.withResolvers<void>();
  const subscriberEvents: OutlinerEvent[][] = [[], []];
  let connectionCount = 0;
  let barrierCount = 0;
  const watchers = subscriberEvents.map((events, index) =>
    new OutlinerClient(socket).watch({
      client: {
        clientId: `promotion-event-detail-${index + 1}`,
        role: "detail",
        contextId: `promotion-event-detail-${index + 1}`,
      },
      onConnect: () => {
        connectionCount += 1;
        if (connectionCount === subscriberEvents.length) connected.resolve();
      },
      onEvent: (event) => {
        events.push(event);
        if (event.action !== "create") return;
        barrierCount += 1;
        if (barrierCount === subscriberEvents.length) barrierReceived.resolve();
      },
    })
  );
  cleanups.push(async () => {
    await Promise.all(watchers.map((watcher) => watcher.stop()));
    await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await connected.promise;

  const started = await client.request<WorkflowStartReceipt>({
    action: "workflows.start",
    input: {
      requestId: "promotion-event-run",
      actionId: "walkthrough.plan",
      invocation: { kind: "block", sourceBlockId: source.id },
      capabilities: [
        "outline.structure",
        "outline.route",
        "promotion.preview",
        "promotion.commit",
      ],
      limits: { fanOut: 6, calls: 10 },
      planner: "callscript",
    },
  });
  const planned = await orchestrateWorkflowRun(client, started.run.runId);
  const step = planned.run.route[0]!;
  const preview = await client.request<WorkflowPromotionPreview>({
    action: "workflows.promotion.preview",
    input: {
      runId: planned.run.runId,
      stepId: step.stepId,
      annotationId: annotation.block.id,
      kind: "decision",
      title: "Decision: keep explicit publication",
      approvedBy: "owner",
      body: "Owner approved this outcome.",
    },
  });
  const commitInput = {
    requestId: "promotion-event-commit",
    approvalToken: preview.approvalToken,
    input: preview.input,
  };
  const committed = await client.request<WorkflowPromotionReceipt>({
    action: "workflows.promotion.commit",
    input: commitInput,
  });
  const promotionSequence = store.sequence;
  const replayed = await client.request<WorkflowPromotionReceipt>({
    action: "workflows.promotion.commit",
    input: commitInput,
  });
  await expect(client.request({
    action: "workflows.promotion.commit",
    input: { ...commitInput, approvalToken: "invalid" },
  })).rejects.toThrow("exact preview");
  await client.request<Block>({ action: "create", text: "Promotion event barrier" });
  await Promise.race([
    barrierReceived.promise,
    Bun.sleep(1_000).then(() => {
      throw new Error("Promotion event barrier timed out");
    }),
  ]);

  expect(committed.deduplicated).toBe(false);
  expect(replayed).toEqual(expect.objectContaining({
    block: expect.objectContaining({ id: committed.block.id }),
    deduplicated: true,
  }));
  for (const events of subscriberEvents) {
    const promotionEvents = events.filter((event) =>
      event.domain === "content" &&
      event.action === "workflows.promotion.commit"
    );
    expect(promotionEvents).toEqual([
      expect.objectContaining({
        blockId: committed.block.id,
        sequence: promotionSequence,
      }),
    ]);
  }
});

test("runs and navigates a targeted structure-first walkthrough over protocol v37", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-workflow-protocol-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  const source = store.create([
    "Architecture review",
    "",
    "## Problem",
    "Understand the boundary.",
    "",
    "## Decision",
    "Keep execution typed.",
    "",
    "## Next action",
    "Record the result.",
  ].join("\n"));
  const socket = join(directory, "outliner.sock");
  const server = new OutlinerServer(store, socket);
  await server.start();
  const client = new OutlinerClient(socket);
  const connected = Promise.withResolvers<void>();
  const firstEvents: OutlinerEvent[] = [];
  const secondEvents: OutlinerEvent[] = [];
  let connectionCount = 0;
  const watchers = [
    { clientId: "workflow-detail-one", events: firstEvents },
    { clientId: "workflow-detail-two", events: secondEvents },
  ].map(({ clientId, events }) =>
    new OutlinerClient(socket).watch({
      client: { clientId, role: "detail", contextId: clientId },
      onConnect: () => {
        connectionCount += 1;
        if (connectionCount === 2) connected.resolve();
      },
      onEvent: (event) => {
        events.push(event);
      },
    })
  );
  cleanups.push(async () => {
    await Promise.all(watchers.map((watcher) => watcher.stop()));
    await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await connected.promise;
  const textBefore = store.require(source.id).text;
  const selectionBefore = store.getSelection().selected?.id ?? null;

  const started = await client.request<WorkflowStartReceipt>({
    action: "workflows.start",
    input: {
      requestId: "workflow-protocol-start",
      actionId: "walkthrough.plan",
      invocation: { kind: "block", sourceBlockId: source.id },
      capabilities: [
        "outline.structure",
        "outline.route",
        "attention.mark",
        "annotations.create",
        "annotations.reply",
        "annotations.batch",
        "promotion.preview",
        "promotion.commit",
      ],
      limits: { fanOut: 6, calls: 10 },
      planner: "callscript",
      targetClientId: "workflow-detail-one",
    },
  });
  expect(started.run.status).toBe("planning");
  expect(started.run.targetClientId).toBe("workflow-detail-one");
  const planned = await orchestrateWorkflowRun(client, started.run.runId);
  expect(planned.run.status).toBe("ready");
  expect(planned.run.route.map((step) => step.title)).toEqual([
    "Problem",
    "Decision",
    "Next action",
  ]);
  expect(planned.comparison.contextBytesSaved).toBe(0);
  expect(planned.comparison.direct.structureFirst).toBe(true);
  expect(planned.comparison.callscript.structureFirst).toBe(true);

  const active = await client.request<WorkflowRun>({
    action: "workflows.transition",
    input: { runId: started.run.runId, action: "next" },
  });
  await Bun.sleep(50);
  const event = firstEvents.find((candidate) => candidate.domain === "attention");
  expect(active.status).toBe("active");
  expect(active.route[0]?.status).toBe("current");
  expect(event?.attention?.targetClientId).toBe("workflow-detail-one");
  expect(event?.attentionInstruction).toEqual(expect.objectContaining({
    reveal: true,
    focus: false,
  }));
  expect(secondEvents).toEqual([]);
  expect(store.require(source.id).text).toBe(textBefore);
  expect(store.getSelection().selected?.id ?? null).toBe(selectionBefore);

  const branched = await client.request<WorkflowRun>({
    action: "workflows.transition",
    input: {
      runId: started.run.runId,
      action: "branch",
      question: "Should this become a durable decision?",
    },
  });
  expect(branched.status).toBe("paused");
  expect(branched.branchQuestion?.stepId).toBe(active.route[0]?.stepId);
  expect(await client.request<WorkflowRun[]>({
    action: "workflows.list",
    limit: 5,
  })).toEqual([expect.objectContaining({ runId: started.run.runId })]);

  const ended = await client.request<WorkflowRun>({
    action: "workflows.transition",
    input: { runId: started.run.runId, action: "end" },
  });
  expect(ended.status).toBe("completed");
  expect(await client.request<AttentionClientState>({
    action: "attention.get",
    targetClientId: "workflow-detail-one",
  })).toEqual(expect.objectContaining({ marks: [] }));
});
