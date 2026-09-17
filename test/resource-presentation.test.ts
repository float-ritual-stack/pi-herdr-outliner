import { expect, test } from "bun:test";
import {
  negotiateResourcePresentation,
  TUI_RESOURCE_PRESENTATION_CONTEXT,
} from "../src/resource-presentation";
import {
  deriveResourceCapabilityReport,
  type ResourceDescription,
  type ResourcePresentationContext,
  type ResourceSource,
} from "../src/resources";

const webSource: ResourceSource = {
  id: "10000000-0000-4000-8000-000000000001",
  name: "Example web",
  version: 1,
  provider: "web",
  boundary: { kind: "web", baseUrl: "https://example.com/" },
  policy: { deniedCapabilities: [] },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const webDescription: ResourceDescription = {
  resource: {
    id: "20000000-0000-4000-8000-000000000001",
    sourceId: webSource.id,
    version: 1,
    addressVersion: 1,
    provider: "web",
    address: { kind: "web", url: "https://example.com/article" },
    mediaType: "text/html",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  source: webSource,
  requestedRevision: null,
  capabilities: deriveResourceCapabilityReport(webSource, true, [
    "read",
    "refresh",
    "open-external",
  ]),
  web: {
    markdown: "# Cached article",
    sourceSnapshot: {
      id: "snapshot-1",
      resourceId: "20000000-0000-4000-8000-000000000001",
      addressVersion: 1,
      canonicalUrl: "https://example.com/article",
      contentHash: "a".repeat(64),
      revision: {
        resourceId: "20000000-0000-4000-8000-000000000001",
        addressVersion: 1,
        revision: {
          kind: "web",
          validator: { kind: "etag", value: "v1", weak: false },
        },
      },
      fetchedAt: "2026-01-01T00:00:00.000Z",
      bodyAvailable: true,
    },
    representation: {
      id: "representation-1",
      sourceSnapshotId: "snapshot-1",
      mediaType: "text/markdown",
      adapter: { id: "fixture.extractor", version: 3 },
      contentHash: "b".repeat(64),
      derivedAt: "2026-01-01T00:00:00.000Z",
      contentAvailable: true,
    },
  },
  webHistory: null,
  webStatus: { freshness: "fresh", checkedAt: "2026-01-01T00:00:00.000Z", lastError: null },
};

function guiContext(overrides: Partial<ResourcePresentationContext["host"]> = {}): ResourcePresentationContext {
  return {
    surface: "gui",
    placement: "pane",
    host: {
      id: "gui-host",
      renderers: ["embedded-browser", "markdown", "metadata", "external-open"],
      placements: ["pane", "window", "external"],
      capabilities: ["read", "embed", "open-external"],
      ...overrides,
    },
    providerAccess: { credentials: "available", connectivity: "available" },
  };
}

test("negotiates one web Resource across TUI, GUI, and external-only hosts", () => {
  const tui = negotiateResourcePresentation(
    webDescription,
    TUI_RESOURCE_PRESENTATION_CONTEXT,
  );
  expect(tui).toMatchObject({
    resourceId: webDescription.resource.id,
    resourceKind: "document",
    surface: "tui",
    requestedPlacement: "pane",
    selected: {
      representation: "cached-markdown",
      renderer: "markdown",
      placement: "pane",
      adapter: { id: "fixture.extractor", version: 3 },
    },
  });

  const gui = negotiateResourcePresentation(webDescription, guiContext());
  expect(gui).toMatchObject({
    resourceId: webDescription.resource.id,
    surface: "gui",
    selected: {
      representation: "embedded-browser",
      renderer: "embedded-browser",
      placement: "pane",
      externalUrl: "https://example.com/article",
    },
  });

  const external = negotiateResourcePresentation(webDescription, {
    surface: "external",
    placement: "external",
    host: {
      id: "external-host",
      renderers: ["external-open"],
      placements: ["external"],
      capabilities: ["open-external"],
    },
    providerAccess: { credentials: "unknown", connectivity: "available" },
  });
  expect(external).toMatchObject({
    resourceId: webDescription.resource.id,
    selected: {
      representation: "external-link",
      renderer: "external-open",
      placement: "external",
      externalUrl: "https://example.com/article",
    },
  });
});

test("keeps pinned revisions on their exact retained representation", () => {
  const requestedRevision = webDescription.web!.sourceSnapshot.revision;
  const pinned = negotiateResourcePresentation(
    { ...webDescription, requestedRevision },
    guiContext(),
  );
  expect(pinned.attempts[1]).toMatchObject({
    representation: "embedded-browser",
    status: "unavailable",
    reason: "Pinned revisions cannot use a live embedded browser",
  });
  expect(pinned.selected).toMatchObject({
    representation: "cached-markdown",
    renderer: "markdown",
    adapter: { id: "fixture.extractor", version: 3 },
  });
});

test("falls back deterministically without coupling cached Markdown to live provider access", () => {
  const offline = negotiateResourcePresentation(webDescription, {
    ...guiContext(),
    providerAccess: { credentials: "unavailable", connectivity: "unavailable" },
  });
  expect(offline.selected).toMatchObject({
    representation: "cached-markdown",
    renderer: "markdown",
    status: "available",
  });
  expect(offline.attempts[0]).toMatchObject({
    representation: "native-document",
    status: "unavailable",
  });
  expect(offline.attempts[1]).toMatchObject({
    representation: "embedded-browser",
    status: "unavailable",
    reason: "provider connectivity is unavailable",
  });

  const metadataOnly = negotiateResourcePresentation(
    { ...webDescription, web: null },
    {
      surface: "tui",
      placement: "pane",
      host: {
        id: "metadata-host",
        renderers: ["metadata"],
        placements: ["pane"],
        capabilities: [],
      },
      providerAccess: { credentials: "unknown", connectivity: "unknown" },
    },
  );
  expect(metadataOnly.selected).toMatchObject({
    representation: "metadata",
    renderer: "metadata",
    status: "available",
  });
});

test("honors workspace read policy for retained Markdown without requiring live access", () => {
  const deniedSource: ResourceSource = {
    ...webSource,
    policy: { deniedCapabilities: ["read"] },
  };
  const denied = negotiateResourcePresentation(
    { ...webDescription, source: deniedSource },
    TUI_RESOURCE_PRESENTATION_CONTEXT,
  );
  expect(denied.attempts[0]).toMatchObject({
    representation: "cached-markdown",
    status: "unavailable",
    reason: "Workspace policy denies read",
  });
  expect(denied.selected).toMatchObject({
    representation: "metadata",
    renderer: "metadata",
  });
});

test("treats PDF as media type while selecting a native GUI renderer", () => {
  const filesystemSource: ResourceSource = {
    id: "10000000-0000-4000-8000-000000000002",
    name: "Documents",
    version: 1,
    provider: "filesystem",
    boundary: { kind: "filesystem", root: "/workspace" },
    policy: { deniedCapabilities: [] },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const pdfDescription: ResourceDescription = {
    resource: {
      id: "20000000-0000-4000-8000-000000000002",
      sourceId: filesystemSource.id,
      version: 1,
      addressVersion: 1,
      provider: "filesystem",
      address: { kind: "filesystem", path: "/workspace/design.pdf" },
      mediaType: "application/pdf",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    source: filesystemSource,
    requestedRevision: null,
    capabilities: deriveResourceCapabilityReport(filesystemSource, true, ["read"]),
    filesystem: {
      text: "%PDF-1.7",
      contentHash: "c".repeat(64),
      capturedAt: "2026-01-01T00:00:00.000Z",
      revision: {
        resourceId: "20000000-0000-4000-8000-000000000002",
        addressVersion: 1,
        revision: { kind: "filesystem", mtimeNs: "1", size: "8" },
      },
    },
    web: null,
    webHistory: null,
    webStatus: null,
  };
  const negotiated = negotiateResourcePresentation(pdfDescription, {
    surface: "native",
    placement: "window",
    host: {
      id: "native-document-host",
      renderers: ["native-document", "metadata"],
      placements: ["window"],
      capabilities: ["read"],
    },
    providerAccess: { credentials: "available", connectivity: "available" },
  });
  expect(negotiated).toMatchObject({
    resourceKind: "document",
    selected: {
      representation: "native-document",
      renderer: "native-document",
      placement: "window",
      mediaType: "application/pdf",
    },
  });
  expect(pdfDescription.resource.provider).toBe("filesystem");
  const missing = negotiateResourcePresentation(
    { ...pdfDescription, filesystem: null },
    {
      surface: "native",
      placement: "window",
      host: {
        id: "native-document-host",
        renderers: ["native-document", "metadata"],
        placements: ["window"],
        capabilities: ["read"],
      },
      providerAccess: { credentials: "available", connectivity: "available" },
    },
  );
  expect(missing.selected).toMatchObject({
    representation: "metadata",
    renderer: "metadata",
  });

  const tui = negotiateResourcePresentation(pdfDescription, TUI_RESOURCE_PRESENTATION_CONTEXT);
  expect(tui.selected).toMatchObject({
    representation: "metadata",
    renderer: "metadata",
  });
});
