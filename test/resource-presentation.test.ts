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
      evictedAt: null,
    },
    representation: {
      id: "representation-1",
      sourceSnapshotId: "snapshot-1",
      mediaType: "text/markdown",
      adapter: { id: "fixture.extractor", version: 3 },
      contentHash: "b".repeat(64),
      derivedAt: "2026-01-01T00:00:00.000Z",
      contentAvailable: true,
      evictedAt: null,
    },
  },
  webHistory: null,
  webStatus: { freshness: "fresh", checkedAt: "2026-01-01T00:00:00.000Z", lastError: null },
  remoteEntity: null,
  remoteStatus: null,
  availableCommands: [],
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

test("negotiates Jira and Linear entities plus application deep links without fabricating content", () => {
  const jiraSource: ResourceSource = {
    id: "10000000-0000-4000-8000-000000000003",
    name: "Product Jira",
    version: 1,
    provider: "jira",
    boundary: {
      kind: "jira",
      origin: "https://jira.example.test",
      project: "PIE",
      credentialEnv: "JIRA_TOKEN",
    },
    policy: { deniedCapabilities: [] },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const jiraDescription: ResourceDescription = {
    resource: {
      id: "20000000-0000-4000-8000-000000000003",
      sourceId: jiraSource.id,
      version: 1,
      addressVersion: 1,
      provider: "jira",
      address: { kind: "jira", entityId: "10042", key: "PIE-255" },
      mediaType: "text/markdown",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    source: jiraSource,
    requestedRevision: null,
    capabilities: deriveResourceCapabilityReport(jiraSource, true),
    web: null,
    webHistory: null,
    webStatus: null,
    remoteEntity: {
      title: "Remote entities",
      metadata: { status: "In Progress", labels: ["resources", "providers"], parent: null },
      markdown: "# Remote entities\n\nRetained Jira body.",
      externalUrl: "https://jira.example.test/browse/OLD-1",
      sourceSnapshot: {
        provider: "jira",
        resourceId: "20000000-0000-4000-8000-000000000003",
        addressVersion: 1,
        entityId: "10042",
        locator: "PIE-255",
        contentHash: "c".repeat(64),
        revision: {
          resourceId: "20000000-0000-4000-8000-000000000003",
          addressVersion: 1,
          revision: {
            kind: "jira",
            validator: { kind: "updated-at", value: "2026-01-01T00:00:00.000Z" },
          },
        },
        fetchedAt: "2026-01-01T00:00:01.000Z",
      },
      representation: {
        mediaType: "text/markdown",
        adapter: { id: "jira.issue-markdown", version: 1 },
        contentHash: "d".repeat(64),
        derivedAt: "2026-01-01T00:00:02.000Z",
      },
      commandDescriptors: [],
    },
    remoteStatus: {
      freshness: "fresh",
      checkedAt: "2026-01-01T00:00:03.000Z",
      lastError: null,
    },
    availableCommands: [],
  };
  const context: ResourcePresentationContext = {
    ...TUI_RESOURCE_PRESENTATION_CONTEXT,
    providerAccess: { credentials: "available", connectivity: "available" },
  };
  expect(negotiateResourcePresentation(jiraDescription, context)).toMatchObject({
    resourceKind: "entity",
    selected: {
      representation: "cached-markdown",
      renderer: "markdown",
      adapter: { id: "jira.issue-markdown", version: 1 },
      externalUrl: "https://jira.example.test/browse/PIE-255",
    },
  });
  const linearSource: ResourceSource = {
    id: "10000000-0000-4000-8000-000000000005",
    name: "Product Linear",
    version: 1,
    provider: "linear",
    boundary: {
      kind: "linear",
      origin: "https://api.linear.app",
      workspace: "float",
      credentialEnv: "LINEAR_TOKEN",
    },
    policy: { deniedCapabilities: [] },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const linearDescription: ResourceDescription = {
    resource: {
      id: "20000000-0000-4000-8000-000000000005",
      sourceId: linearSource.id,
      version: 1,
      addressVersion: 1,
      provider: "linear",
      address: {
        kind: "linear",
        entityId: "5a726eff-a292-4f23-b755-9bd9ff1b1241",
        identifier: "PIE-256",
      },
      mediaType: "text/markdown",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    source: linearSource,
    requestedRevision: null,
    capabilities: deriveResourceCapabilityReport(linearSource, true),
    web: null,
    webHistory: null,
    webStatus: null,
    remoteEntity: {
      title: "PIE-256",
      metadata: { state: "In Progress" },
      markdown: "# PIE-256",
      externalUrl: "https://linear.app/float/issue/PIE-256",
      sourceSnapshot: {
        provider: "linear",
        resourceId: "20000000-0000-4000-8000-000000000005",
        addressVersion: 1,
        entityId: "5a726eff-a292-4f23-b755-9bd9ff1b1241",
        locator: "PIE-256",
        contentHash: "c".repeat(64),
        revision: {
          resourceId: "20000000-0000-4000-8000-000000000005",
          addressVersion: 1,
          revision: {
            kind: "linear",
            validator: { kind: "updated-at", value: "2026-01-01T00:00:00.000Z" },
          },
        },
        fetchedAt: "2026-01-01T00:00:00.000Z",
      },
      representation: {
        mediaType: "text/markdown",
        adapter: { id: "remote-entity-markdown", version: 1 },
        contentHash: "d".repeat(64),
        derivedAt: "2026-01-01T00:00:00.000Z",
      },
      commandDescriptors: [],
    },
    remoteStatus: {
      freshness: "unknown",
      checkedAt: null,
      lastError: null,
    },
    availableCommands: [],
  };
  expect(negotiateResourcePresentation(linearDescription, context)).toMatchObject({
    resourceKind: "entity",
    selected: {
      representation: "cached-markdown",
      renderer: "markdown",
      externalUrl: "https://linear.app/float/issue/PIE-256",
    },
  });

  const applicationSource: ResourceSource = {
    id: "10000000-0000-4000-8000-000000000004",
    name: "Local application",
    version: 1,
    provider: "application",
    boundary: {
      kind: "application",
      scheme: "slack",
      authority: "channel",
      namespace: "workspace",
    },
    policy: { deniedCapabilities: [] },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const applicationDescription: ResourceDescription = {
    resource: {
      id: "20000000-0000-4000-8000-000000000004",
      sourceId: applicationSource.id,
      version: 1,
      addressVersion: 1,
      provider: "application",
      address: { kind: "application", uri: "slack://channel/workspace/C0123" },
      mediaType: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    source: applicationSource,
    requestedRevision: null,
    capabilities: deriveResourceCapabilityReport(applicationSource, true),
    web: null,
    webHistory: null,
    webStatus: null,
    remoteEntity: null,
    remoteStatus: null,
    availableCommands: [],
  };
  expect(negotiateResourcePresentation(
    applicationDescription,
    TUI_RESOURCE_PRESENTATION_CONTEXT,
  )).toMatchObject({
    resourceKind: "application",
    selected: {
      representation: "metadata",
      renderer: "metadata",
      externalUrl: "slack://channel/workspace/C0123",
    },
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
    remoteEntity: null,
    remoteStatus: null,
    availableCommands: [],
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

test("selects retained HTTP PDF bytes for native hosts while the provider is offline", () => {
  const web = webDescription.web!;
  const sourceSnapshot = {
    id: web.sourceSnapshot.id,
    resourceId: webDescription.resource.id,
    addressVersion: webDescription.resource.addressVersion,
    locator: "https://example.com/document.pdf",
    contentHash: web.sourceSnapshot.contentHash!,
    revision: web.sourceSnapshot.revision,
    capturedAt: web.sourceSnapshot.fetchedAt!,
    bytesAvailable: true,
    evictedAt: null,
  };
  const representation = {
    ...web.representation,
    mediaType: "text/markdown" as const,
    derivedAt: web.representation.derivedAt!,
  };
  const nativeRepresentation = {
    ...representation,
    id: "representation-native-pdf",
    mediaType: "application/pdf" as const,
    adapter: { id: "builtin.pdf-native", version: 1 },
    contentHash: sourceSnapshot.contentHash,
  };
  const description: ResourceDescription = {
    ...webDescription,
    resource: {
      ...webDescription.resource,
      provider: "web",
      address: { kind: "web", url: "https://example.com/document.pdf" },
      mediaType: "application/pdf",
    },
    pdf: {
      markdown: "## Page 1\n\nRetained PDF",
      pages: [{
        page: 1,
        width: 300,
        height: 400,
        start: 0,
        end: 24,
        spans: [{
          start: 11,
          end: 23,
          region: { x: 36, y: 40, width: 100, height: 16 },
        }],
      }],
      sourceSnapshot,
      representation,
      nativeRepresentation,
    },
    pdfHistory: {
      sourceSnapshots: [sourceSnapshot],
      representations: [representation, nativeRepresentation],
    },
    web: null,
    webHistory: null,
  };
  const context: ResourcePresentationContext = {
    surface: "native",
    placement: "window",
    host: {
      id: "offline-native-pdf",
      renderers: ["native-document", "metadata"],
      placements: ["window"],
      capabilities: ["read"],
    },
    providerAccess: { credentials: "unavailable", connectivity: "unavailable" },
  };
  expect(negotiateResourcePresentation(description, context).selected).toMatchObject({
    representation: "native-document",
    renderer: "native-document",
  });
  expect(negotiateResourcePresentation({
    ...description,
    source: {
      ...description.source,
      policy: { deniedCapabilities: ["read"] },
    },
  }, context).selected).toMatchObject({
    representation: "metadata",
    renderer: "metadata",
  });
});
