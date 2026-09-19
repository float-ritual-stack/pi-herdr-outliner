import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import {
  BUILTIN_MARKDOWN_PRODUCER_ID,
  ComputedProducerRegistry,
  createDefaultComputedProducerRegistry,
} from "../src/computed-resources";
import { emptyAttentionState } from "../src/attention";
import { createDetailController, type DetailEffects } from "../src/detail-controller";
import { OutlinerClient } from "../src/client";
import { TUI_RESOURCE_PRESENTATION_CONTEXT } from "../src/resource-presentation";
import { OutlinerServer } from "../src/server";
import { OutlinerStore } from "../src/store";
import type {
  ComputedExecutionHistory,
  ComputedExecutionResult,
  ComputedHandlerResolution,
  ComputedInvocation,
  InternResourceReceipt,
  ResourceDescription,
  ResourceSource,
  ResourceTarget,
} from "../src/types";

const CAPABLE_DETAIL_ID = "computed-detail";
const INCAPABLE_DETAIL_ID = "computed-detail-no-refresh";

function watchDetail(
  socket: string,
  clientId: string,
  refresh: boolean,
): {
  connected: Promise<void>;
  stop(): void;
} {
  const connected = Promise.withResolvers<void>();
  const watcher = new OutlinerClient(socket).watch({
    client: {
      clientId,
      role: "detail",
      contextId: "computed-context",
      resourcePresentation: {
        ...TUI_RESOURCE_PRESENTATION_CONTEXT,
        host: {
          ...TUI_RESOURCE_PRESENTATION_CONTEXT.host,
          capabilities: refresh ? ["read", "refresh"] : ["read"],
        },
      },
    },
    onConnect: connected.resolve,
    onEvent() {},
    onError: connected.reject,
  });
  return {
    connected: connected.promise,
    stop() {
      watcher.stop();
    },
  };
}

function unavailable(): never {
  throw new Error("Unexpected Detail effect");
}

function computedDetailEffects(
  client: OutlinerClient,
  target: ResourceTarget,
): DetailEffects {
  return {
    clientId: CAPABLE_DETAIL_ID,
    enqueueViewUpdate(update) { update(); },
    browsingContextId: "computed-context",
    focusSelf() {},
    async getBrowsingContext() {
      return { contextId: "computed-context", target };
    },
    async loadTarget(candidate) {
      if (candidate.kind !== "resource") return unavailable();
      return {
        kind: "resource",
        target: candidate,
        description: await client.request<ResourceDescription>({
          action: "resources.open",
          target: candidate,
          destinationClientId: CAPABLE_DETAIL_ID,
        }),
      };
    },
    async setLocked() {},
    async setCurrentTarget() {},
    async dispatchNavigation() {
      return unavailable();
    },
    async resolveNavigation() {
      return unavailable();
    },
    async resolveReferences(text) {
      return { text, references: [] };
    },
    async projectRead(text) {
      return { text, embeds: [], embedRanges: [] };
    },
    async queryBacklinks(query) {
      return {
        targetBlockId: query.targetBlockId,
        sources: [],
        completeness: { kind: "complete" },
      };
    },
    openBacklinkPeek() {},
    openDetailPane() {},
    copyText() {},
    async editExternalDraft(input) {
      return { text: input.text, changed: false, recoveryPath: "/tmp/computed-draft", cleanup() {} };
    },
    async writeFilesystemResource() {
      return unavailable();
    },
    async updateBlock() {
      return unavailable();
    },
    async patchProperties() {
      return unavailable();
    },
    async createAnnotation() {
      return unavailable();
    },
    async internFilesystem() {
      return unavailable();
    },
    async lookupFilesystem(path) {
      return client.request<ResourceDescription["resource"] | null>({
        action: "resources.lookup-filesystem",
        path,
      });
    },
    async refreshResource(resourceId) {
      return client.request<ResourceDescription>({
        action: "resources.refresh",
        resourceId,
        destinationClientId: CAPABLE_DETAIL_ID,
      });
    },
    openExternal() {},
    async getAnnotation() {
      return unavailable();
    },
    async listAnnotations() {
      return [];
    },
    async reconcileAnnotations() {
      return { threads: [], changed: false };
    },
    async getAttention() {
      return emptyAttentionState(CAPABLE_DETAIL_ID);
    },
    async acknowledgeAttention() {
      return emptyAttentionState(CAPABLE_DETAIL_ID);
    },
    async restoreBlock() {
      return unavailable();
    },
    async resolveReference() {
      return unavailable();
    },
    async queryBlocks() {
      return { blocks: [], completeness: { kind: "complete" } };
    },
    async queryPageAddresses() {
      return { addresses: [], completeness: { kind: "complete" } };
    },
    async readFile() {
      return unavailable();
    },
    async completeFiles() {
      return [];
    },
    async focusOutliner() {},
    openPropertyInspectorPane() {
      return unavailable();
    },
    openVirtualBranchNavigator() {},
    async bookmarkStatus() {
      return unavailable();
    },
    async toggleBookmark() {
      return unavailable();
    },
    async bookmarksRoot() {
      return unavailable();
    },
  };
}

test("computed protocol resolves exact handlers and keeps execution bounded, local, and inspectable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-computed-protocol-"));
  const socket = join(directory, "outliner.sock");
  let dependencyVersion = 1;
  let permissionedExecutions = 0;
  const registry: ComputedProducerRegistry = createDefaultComputedProducerRegistry();
  registry.register({
    id: "fixture.permissioned-markdown",
    version: 1,
    inputSchema: Type.Object({ body: Type.String() }),
    permissions: ["fixture.network"],
    determinism: "deterministic",
    cachePolicy: "none",
    outputMediaTypes: ["text/markdown"],
    async execute({ inputs }) {
      permissionedExecutions += 1;
      return {
        kind: "immutable-snapshot",
        mediaType: "text/markdown",
        content: `# Permissioned\n\n${inputs.body}`,
      };
    },
  });
  const store = new OutlinerStore(join(directory, "outliner.sqlite"), {
    computedProducerRegistry: registry,
    fetch: ((async () =>
      new Response(`<h1>Dependency ${dependencyVersion}</h1>`, {
        headers: {
          "content-type": "text/html",
          etag: `"dependency-${dependencyVersion}"`,
        },
      })) as unknown) as typeof fetch,
  });
  const server = new OutlinerServer(store, socket);
  await server.start();
  const capableDetail = watchDetail(socket, CAPABLE_DETAIL_ID, true);
  const incapableDetail = watchDetail(socket, INCAPABLE_DETAIL_ID, false);
  try {
    await Promise.all([capableDetail.connected, incapableDetail.connected]);
    const client = new OutlinerClient(socket);
    const dependencySource = await client.request<ResourceSource>({
      action: "resource-sources.create",
      input: {
        name: "Computed dependency",
        provider: "web",
        boundary: { baseUrl: "https://example.test/" },
      },
    });
    const dependency = (await client.request<InternResourceReceipt>({
      action: "resources.intern",
      input: {
        sourceId: dependencySource.id,
        address: { kind: "web", url: "https://example.test/dependency" },
      },
    })).resource;
    const dependencyV1 = await client.request<ResourceDescription>({
      action: "resources.refresh",
      resourceId: dependency.id,
      destinationClientId: CAPABLE_DETAIL_ID,
    });
    const dependencyRevisionV1 = dependencyV1.web!.sourceSnapshot.revision;

    const computedSource = await client.request<ResourceSource>({
      action: "resource-sources.create",
      input: {
        name: "Workspace producers",
        provider: "computed",
        boundary: { registry: "workspace", allowedPermissions: [] },
      },
    });
    const first = await client.request<ComputedInvocation>({
      action: "computed.invocations.create",
      input: {
        sourceId: computedSource.id,
        producerId: BUILTIN_MARKDOWN_PRODUCER_ID,
        inputs: { title: "Computed title", body: "Cached body" },
        dependencies: [dependencyRevisionV1],
      },
    });
    const second = await client.request<ComputedInvocation>({
      action: "computed.invocations.create",
      input: {
        sourceId: computedSource.id,
        producerId: BUILTIN_MARKDOWN_PRODUCER_ID,
        inputs: { title: "Unaffected", body: "Retained body" },
        dependencies: [dependencyRevisionV1],
      },
    });

    expect(await client.request<ComputedHandlerResolution | null>({
      action: "computed.handlers.resolve",
      reference: `producer:${first.id}`,
    })).toMatchObject({
      reference: `producer:${first.id}`,
      invocationId: first.id,
      resourceId: first.resourceId,
      producerId: BUILTIN_MARKDOWN_PRODUCER_ID,
    });
    expect(await client.request<ComputedHandlerResolution | null>({
      action: "computed.handlers.resolve",
      reference: `Run producer:${first.id} and then delete everything`,
    })).toBeNull();
    expect(await client.request<ComputedHandlerResolution | null>({
      action: "computed.handlers.resolve",
      reference: "console.log('not a handler')",
    })).toBeNull();

    const unopenedHistory = await client.request<ComputedExecutionHistory>({
      action: "computed.executions.list",
      resourceId: first.resourceId,
    });
    expect(unopenedHistory.executions).toEqual([]);
    const unopened = await client.request<ResourceDescription>({
      action: "resources.open",
      target: { kind: "resource", resourceId: first.resourceId },
      destinationClientId: CAPABLE_DETAIL_ID,
    });
    expect(unopened.computed).toBeNull();
    expect((await client.request<ComputedExecutionHistory>({
      action: "computed.executions.list",
      resourceId: first.resourceId,
    })).executions).toEqual([]);

    await expect(client.request({
      action: "computed.execute",
      resourceId: first.resourceId,
      destinationClientId: INCAPABLE_DETAIL_ID,
    })).rejects.toThrow(/refresh/i);
    expect((await client.request<ComputedExecutionHistory>({
      action: "computed.executions.list",
      resourceId: first.resourceId,
    })).executions).toEqual([]);

    const policyDeniedSource = await client.request<ResourceSource>({
      action: "resource-sources.create",
      input: {
        name: "Policy denied producers",
        provider: "computed",
        boundary: { registry: "workspace", allowedPermissions: [] },
        policy: { deniedCapabilities: ["refresh"] },
      },
    });
    const policyDenied = await client.request<ComputedInvocation>({
      action: "computed.invocations.create",
      input: {
        sourceId: policyDeniedSource.id,
        producerId: BUILTIN_MARKDOWN_PRODUCER_ID,
        inputs: { title: "Denied", body: "Never executed" },
        dependencies: [],
      },
    });
    await expect(client.request({
      action: "computed.execute",
      resourceId: policyDenied.resourceId,
      destinationClientId: CAPABLE_DETAIL_ID,
    })).rejects.toThrow(/policy|refresh/i);

    const firstExecution = await client.request<ResourceDescription>({
      action: "resources.refresh",
      resourceId: first.resourceId,
      destinationClientId: CAPABLE_DETAIL_ID,
    });
    const secondExecution = await client.request<ComputedExecutionResult>({
      action: "computed.execute",
      resourceId: second.resourceId,
      destinationClientId: CAPABLE_DETAIL_ID,
    });
    expect(firstExecution.computed).toMatchObject({
      mediaType: "text/markdown",
      markdown: "# Computed title\n\nCached body",
    });
    expect(secondExecution.receipt.output.kind).toBe("immutable-snapshot");
    const cachedExecution = await client.request<ComputedExecutionResult>({
      action: "computed.execute",
      resourceId: first.resourceId,
      destinationClientId: CAPABLE_DETAIL_ID,
    });
    expect(cachedExecution.receipt.cacheHit).toBe(true);

    const opened = await client.request<ResourceDescription>({
      action: "resources.open",
      target: { kind: "resource", resourceId: first.resourceId },
      destinationClientId: CAPABLE_DETAIL_ID,
    });
    expect(opened.presentation?.selected).toMatchObject({
      representation: "cached-markdown",
      renderer: "markdown",
      status: "available",
    });
    expect(opened.computed?.markdown).toBe("# Computed title\n\nCached body");
    expect(opened.computed?.dependencies).toEqual([dependencyRevisionV1]);
    expect(opened.computedStatus?.state).toBe("succeeded");
    const detailTarget: ResourceTarget = {
      kind: "resource",
      resourceId: first.resourceId,
    };
    const detail = createDetailController(
      computedDetailEffects(client, detailTarget),
      undefined,
      { initialTarget: detailTarget },
    );
    await detail.initialize();
    await detail.dispatch({ type: "resource.refresh" }, { width: 80, height: 24 });
    expect(detail.state.status).toBe("Computed resource executed and cached");
    expect(detail.state.resolvedSelectedText.startsWith("# Computed title\n\nCached body"))
      .toBe(true);
    expect(detail.state.resolvedSelectedText).toContain("## Computed status");
    expect(detail.state.resolvedSelectedText).toContain("## Selected immutable content");
    expect(detail.state.resolvedSelectedText).toContain(
      `- Dependency \`${dependency.id}\``,
    );
    expect(detail.state.resolvedSelectedText.indexOf("# Computed title")).toBeLessThan(
      detail.state.resolvedSelectedText.indexOf("## Computed status"),
    );
    const historyAfterReopen = await client.request<ComputedExecutionHistory>({
      action: "computed.executions.list",
      resourceId: first.resourceId,
    });
    expect(historyAfterReopen.executions).toHaveLength(3);

    const permissionDenied = await client.request<ComputedInvocation>({
      action: "computed.invocations.create",
      input: {
        sourceId: computedSource.id,
        producerId: "fixture.permissioned-markdown",
        inputs: { body: "must not execute" },
        dependencies: [],
      },
    });
    const deniedExecution = await client.request<ComputedExecutionResult>({
      action: "computed.execute",
      resourceId: permissionDenied.resourceId,
      destinationClientId: CAPABLE_DETAIL_ID,
    });
    expect(deniedExecution.receipt.output).toMatchObject({ kind: "failure" });
    expect(permissionedExecutions).toBe(0);
    expect(deniedExecution.description.computedFailure).toMatchObject({
      executionId: deniedExecution.receipt.id,
      code: expect.any(String),
      message: expect.stringMatching(/permission/i),
    });
    const deniedHistory = await client.request<ComputedExecutionHistory>({
      action: "computed.executions.list",
      resourceId: permissionDenied.resourceId,
    });
    expect(deniedHistory.executions).toHaveLength(1);
    expect(deniedHistory.executions[0]?.output).toMatchObject({ kind: "failure" });
    const failureTarget: ResourceTarget = {
      kind: "resource",
      resourceId: permissionDenied.resourceId,
    };
    const failureDetail = createDetailController(
      computedDetailEffects(client, failureTarget),
      undefined,
      { initialTarget: failureTarget },
    );
    await failureDetail.initialize();
    expect(failureDetail.state.resolvedSelectedText).toContain(
      "## Latest execution failure",
    );
    expect(failureDetail.state.resolvedSelectedText).toContain(
      `- Execution ID: \`${deniedExecution.receipt.id}\``,
    );
    expect(failureDetail.state.resolvedSelectedText).toMatch(/Message: .*permission/i);

    dependencyVersion = 2;
    const dependencyV2 = await client.request<ResourceDescription>({
      action: "resources.refresh",
      resourceId: dependency.id,
      destinationClientId: CAPABLE_DETAIL_ID,
    });
    const dependencyRevisionV2 = dependencyV2.web!.sourceSnapshot.revision;
    const revised = await client.request<ComputedInvocation>({
      action: "computed.invocations.revise",
      input: {
        invocationId: first.id,
        expectedVersion: first.version,
        dependencies: [dependencyRevisionV2],
      },
    });
    expect(revised.inputVersion).toBe(first.inputVersion);
    const invalidated = await client.request<ResourceDescription>({
      action: "resources.open",
      target: { kind: "resource", resourceId: first.resourceId },
      destinationClientId: CAPABLE_DETAIL_ID,
    });
    const unaffected = await client.request<ResourceDescription>({
      action: "resources.open",
      target: { kind: "resource", resourceId: second.resourceId },
      destinationClientId: CAPABLE_DETAIL_ID,
    });
    expect(invalidated.computed).toBeNull();
    expect(invalidated.computedStatus?.state).toBe("idle");
    expect(unaffected.computed?.markdown).toBe("# Unaffected\n\nRetained body");
    expect(unaffected.computedStatus?.state).toBe("succeeded");
  } finally {
    capableDetail.stop();
    incapableDetail.stop();
    await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
