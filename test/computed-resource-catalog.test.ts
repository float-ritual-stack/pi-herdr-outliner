import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import {
  BUILTIN_MARKDOWN_PRODUCER_ID,
  ComputedProducerRegistry,
  defineComputedProducer,
} from "../src/computed-resources";
import { OutlinerStore } from "../src/store";
import type { ResourceRevisionRef } from "../src/resources";

async function withStore(
  registry: ComputedProducerRegistry | undefined,
  run: (store: OutlinerStore, root: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "computed-resource-catalog-"));
  const store = new OutlinerStore(join(root, "workspace.sqlite"), {
    ...(registry ? { computedProducerRegistry: registry } : {}),
  });
  try {
    await run(store, root);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function computedSource(
  store: OutlinerStore,
  allowedPermissions: readonly string[] = [],
) {
  return store.resources.createSource({
    name: "Computed fixtures",
    provider: "computed",
    boundary: { registry: "fixtures", allowedPermissions },
  });
}

function filesystemDependency(
  store: OutlinerStore,
  root: string,
  name: string,
  content: string,
): { readonly resourceId: string; readonly revision: ResourceRevisionRef } {
  const directory = join(root, "dependencies");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, name), content);
  const resource = store.resources.internFilesystem({
    path: join("dependencies", name),
    mediaType: "text/plain",
  }).resource;
  const document = store.resources.describe(resource.id, true).filesystem;
  if (!document) throw new Error("Expected filesystem dependency document");
  return { resourceId: resource.id, revision: document.revision };
}

test("computed handlers resolve only persisted invocations and local open never executes", async () => {
  await withStore(undefined, async (store) => {
    const source = computedSource(store);
    expect(() =>
      store.resources.intern({
        sourceId: source.id,
        address: {
          kind: "computed",
          invocationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        },
      })
    ).toThrow("registered producer invocation");
    const invocation = store.resources.createComputedInvocation({
      sourceId: source.id,
      producerId: BUILTIN_MARKDOWN_PRODUCER_ID,
      inputs: { title: "Computed", body: "Local and cached." },
      dependencies: [],
    });

    expect(store.resources.resolveComputedHandler(`producer:${invocation.id}`)).toEqual({
      reference: `producer:${invocation.id}`,
      invocationId: invocation.id,
      resourceId: invocation.resourceId,
      producerId: BUILTIN_MARKDOWN_PRODUCER_ID,
      producerVersion: 1,
    });
    expect(store.resources.resolveComputedHandler("producer:not-a-uuid")).toBeNull();
    expect(store.resources.resolveComputedHandler(`prefix producer:${invocation.id}`)).toBeNull();

    const before = await store.resources.open(invocation.resourceId, true);
    expect(before.computed).toBeNull();
    expect(before.computedStatus).toMatchObject({ state: "idle" });
    expect(store.resources.computedExecutionHistory(invocation.resourceId).executions).toEqual([]);

    const first = await store.resources.executeComputedResource(invocation.resourceId, true);
    expect(first).toMatchObject({
      cacheHit: false,
      output: {
        kind: "immutable-snapshot",
        mediaType: "text/markdown",
        content: "# Computed\n\nLocal and cached.",
      },
    });
    const opened = await store.resources.open(invocation.resourceId, true);
    expect(opened.computed).toMatchObject({
      markdown: "# Computed\n\nLocal and cached.",
      revision: {
        revision: {
          kind: "computed",
          producerId: BUILTIN_MARKDOWN_PRODUCER_ID,
          producerVersion: 1,
          inputVersion: 1,
        },
      },
      dependencies: [],
    });
    expect(store.resources.computedExecutionHistory(invocation.resourceId).executions).toHaveLength(1);

    const second = await store.resources.executeComputedResource(invocation.resourceId, true);
    expect(second.cacheHit).toBe(true);
    expect(second.output).toEqual(first.output);
    expect((await store.resources.open(invocation.resourceId, true)).computed?.representationId)
      .toBe(opened.computed?.representationId);
  });
});

test("computed permission and producer failures persist without bypassing preconditions", async () => {
  let permissionCalls = 0;
  const registry = new ComputedProducerRegistry([
    defineComputedProducer({
      id: "fixture.permission",
      version: 1,
      inputSchema: Type.Object({}, { additionalProperties: false }),
      permissions: ["workspace.read"],
      determinism: "nondeterministic",
      cachePolicy: "none",
      outputMediaTypes: ["text/plain"],
      async execute() {
        permissionCalls += 1;
        return { kind: "transient-representation", mediaType: "text/plain", content: "no" };
      },
    }),
    defineComputedProducer({
      id: "fixture.throws",
      version: 1,
      inputSchema: Type.Object({}, { additionalProperties: false }),
      permissions: [],
      determinism: "nondeterministic",
      cachePolicy: "none",
      outputMediaTypes: ["text/plain"],
      async execute() {
        throw new Error("fixture exploded");
      },
    }),
  ]);

  await withStore(registry, async (store) => {
    const source = computedSource(store);
    const denied = store.resources.createComputedInvocation({
      sourceId: source.id,
      producerId: "fixture.permission",
      inputs: {},
      dependencies: [],
    });
    const deniedReceipt = await store.resources.executeComputedResource(denied.resourceId, true);
    expect(deniedReceipt.output).toMatchObject({ kind: "failure", code: "permission-denied" });
    expect(permissionCalls).toBe(0);
    expect(store.resources.describe(denied.resourceId, true).computedFailure).toMatchObject({
      executionId: deniedReceipt.id,
      code: "permission-denied",
    });

    const failing = store.resources.createComputedInvocation({
      sourceId: source.id,
      producerId: "fixture.throws",
      inputs: {},
      dependencies: [],
    });
    const failureReceipt = await store.resources.executeComputedResource(failing.resourceId, true);
    expect(failureReceipt.output).toMatchObject({
      kind: "failure",
      code: "execution-failed",
    });
    expect(store.resources.describe(failing.resourceId, true).computedFailure).toMatchObject({
      executionId: failureReceipt.id,
      code: "execution-failed",
      message: expect.stringContaining("fixture exploded"),
    });
    expect(store.resources.computedExecutionHistory(failing.resourceId).executions.at(-1)?.output)
      .toEqual(failureReceipt.output);
  });
});

test("computed output kinds preserve only durable state and immutable snapshots", async () => {
  let durableResourceId = "";
  let snapshotExecutions = 0;
  const schema = Type.Object({}, { additionalProperties: false });
  const registry = new ComputedProducerRegistry([
    defineComputedProducer({
      id: "fixture.transient",
      version: 1,
      inputSchema: schema,
      permissions: [],
      determinism: "nondeterministic",
      cachePolicy: "none",
      outputMediaTypes: ["text/plain"],
      async execute() {
        return { kind: "transient-representation", mediaType: "text/plain", content: "ephemeral" };
      },
    }),
    defineComputedProducer({
      id: "fixture.snapshot",
      version: 1,
      inputSchema: schema,
      permissions: [],
      determinism: "nondeterministic",
      cachePolicy: "none",
      outputMediaTypes: ["text/markdown"],
      async execute() {
        snapshotExecutions += 1;
        return {
          kind: "immutable-snapshot",
          mediaType: "text/markdown",
          content: `# Snapshot ${snapshotExecutions}`,
        };
      },
    }),
    defineComputedProducer({
      id: "fixture.durable",
      version: 1,
      inputSchema: schema,
      permissions: [],
      determinism: "nondeterministic",
      cachePolicy: "none",
      outputMediaTypes: ["text/plain"],
      async execute() {
        return { kind: "durable-resource", resourceId: durableResourceId };
      },
    }),
    defineComputedProducer({
      id: "fixture.failure",
      version: 1,
      inputSchema: schema,
      permissions: [],
      determinism: "nondeterministic",
      cachePolicy: "none",
      outputMediaTypes: ["text/plain"],
      async execute() {
        return { kind: "failure", code: "fixture-failure", message: "Expected failure" };
      },
    }),
  ]);

  await withStore(registry, async (store, root) => {
    durableResourceId = filesystemDependency(store, root, "durable.txt", "durable").resourceId;
    const source = computedSource(store);
    const invoke = (producerId: string) => store.resources.createComputedInvocation({
      sourceId: source.id,
      producerId,
      inputs: {},
      dependencies: [],
    });

    const transient = invoke("fixture.transient");
    const transientReceipt = await store.resources.executeComputedResource(transient.resourceId, true);
    expect(transientReceipt.output).toEqual({
      kind: "transient-representation",
      mediaType: "text/plain",
      content: "ephemeral",
    });
    expect(store.resources.describe(transient.resourceId, true).computed).toBeNull();
    expect(store.resources.computedExecutionHistory(transient.resourceId).executions[0]?.output)
      .toEqual({ kind: "transient-representation", mediaType: "text/plain" });

    const snapshot = invoke("fixture.snapshot");
    const snapshotReceipt = await store.resources.executeComputedResource(snapshot.resourceId, true);
    expect(snapshotReceipt.output.kind).toBe("immutable-snapshot");
    const firstSnapshot = store.resources.describe(snapshot.resourceId, true).computed;
    expect(firstSnapshot?.markdown).toBe("# Snapshot 1");
    await store.resources.executeComputedResource(snapshot.resourceId, true);
    expect(store.resources.describe(snapshot.resourceId, true).computed?.markdown)
      .toBe("# Snapshot 2");
    expect(
      store.resources.describe(snapshot.resourceId, true, firstSnapshot!.revision).computed?.markdown,
    ).toBe("# Snapshot 1");

    const durable = invoke("fixture.durable");
    const durableReceipt = await store.resources.executeComputedResource(durable.resourceId, true);
    expect(durableReceipt.output).toEqual({ kind: "durable-resource", resourceId: durableResourceId });
    expect(store.resources.describe(durable.resourceId, true).computed).toBeNull();

    const failure = invoke("fixture.failure");
    const failureReceipt = await store.resources.executeComputedResource(failure.resourceId, true);
    expect(failureReceipt.output).toEqual({
      kind: "failure",
      code: "fixture-failure",
      message: "Expected failure",
    });
    expect(store.resources.describe(failure.resourceId, true).computedFailure).toMatchObject({
      code: "fixture-failure",
    });
  });
});

test("dependency revision invalidation is scoped to the revised invocation", async () => {
  await withStore(undefined, async (store, root) => {
    const firstDependency = filesystemDependency(store, root, "first.txt", "first");
    const secondDependency = filesystemDependency(store, root, "second.txt", "second");
    const source = computedSource(store);
    const create = (title: string) => store.resources.createComputedInvocation({
      sourceId: source.id,
      producerId: BUILTIN_MARKDOWN_PRODUCER_ID,
      inputs: { title, body: "Body" },
      dependencies: [firstDependency.revision],
    });
    const first = create("First");
    const second = create("Second");
    await store.resources.executeComputedResource(first.resourceId, true);
    await store.resources.executeComputedResource(second.resourceId, true);
    const secondBefore = store.resources.describe(second.resourceId, true).computed;

    const revised = store.resources.reviseComputedInvocation({
      invocationId: first.id,
      expectedVersion: first.version,
      dependencies: [secondDependency.revision],
    });
    expect(revised.version).toBe(first.version + 1);
    expect(revised.inputVersion).toBe(first.inputVersion);
    expect(store.resources.describe(first.resourceId, true).computed).toBeNull();
    expect(store.resources.describe(second.resourceId, true).computed?.representationId)
      .toBe(secondBefore?.representationId);

    const receipt = await store.resources.executeComputedResource(first.resourceId, true);
    const description = store.resources.describe(first.resourceId, true);
    expect(description.computed?.dependencies).toEqual([secondDependency.revision]);
    expect(description.computed?.revision.revision).toMatchObject({
      kind: "computed",
      producerVersion: 1,
      inputVersion: 1,
      dependencyFingerprint: receipt.dependencyFingerprint,
    });
    const history = store.resources.computedExecutionHistory(first.resourceId).executions;
    expect(history).toHaveLength(2);
    expect(history[0]?.dependencies).toEqual([firstDependency.revision]);
    expect(history[1]?.dependencies).toEqual([secondDependency.revision]);
  });
});

test("interrupted computed execution is recovered as immutable failure history", () => {
  const root = mkdtempSync(join(tmpdir(), "computed-resource-recovery-"));
  const path = join(root, "workspace.sqlite");
  let store = new OutlinerStore(path);
  try {
    const source = computedSource(store);
    const invocation = store.resources.createComputedInvocation({
      sourceId: source.id,
      producerId: BUILTIN_MARKDOWN_PRODUCER_ID,
      inputs: { title: "Interrupted", body: "Body" },
      dependencies: [],
    });
    const executionId = crypto.randomUUID();
    const startedAt = "2026-09-17T12:00:00.000Z";
    store.database.query(`
      UPDATE computed_resource_state
      SET generation = 2, status = 'executing', started_at = ?
      WHERE resource_id = ?
    `).run(startedAt, invocation.resourceId);
    store.database.query(`
      INSERT INTO computed_executions (
        id, invocation_id, resource_id, generation, producer_id,
        producer_version, input_version, dependency_fingerprint,
        dependencies_json, cache_hit, status, output_kind, media_type,
        output_content_hash, representation_id, durable_resource_id,
        failure_code, failure_message, started_at, completed_at
      ) VALUES (
        ?, ?, ?, 2, ?, ?, ?, ?, '[]', 0, 'executing', NULL, NULL,
        NULL, NULL, NULL, NULL, NULL, ?, NULL
      )
    `).run(
      executionId,
      invocation.id,
      invocation.resourceId,
      invocation.producerId,
      invocation.producerVersion,
      invocation.inputVersion,
      "0".repeat(64),
      startedAt,
    );
    store.close();
    store = new OutlinerStore(path);

    expect(store.resources.describe(invocation.resourceId, true).computedFailure).toMatchObject({
      executionId,
      code: "execution-interrupted",
    });
    expect(store.resources.computedExecutionHistory(invocation.resourceId).executions).toEqual([
      expect.objectContaining({
        id: executionId,
        output: {
          kind: "failure",
          code: "execution-interrupted",
          message: "Computed execution interrupted before completion",
        },
      }),
    ]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("superseded computed execution cannot overwrite a revised generation", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const registry = new ComputedProducerRegistry([
    defineComputedProducer({
      id: "fixture.generation",
      version: 1,
      inputSchema: Type.Object({ value: Type.String() }, { additionalProperties: false }),
      permissions: [],
      determinism: "nondeterministic",
      cachePolicy: "none",
      outputMediaTypes: ["text/markdown"],
      async execute({ inputs }) {
        await gate;
        return {
          kind: "immutable-snapshot",
          mediaType: "text/markdown",
          content: inputs.value,
        };
      },
    }),
  ]);

  await withStore(registry, async (store) => {
    const source = computedSource(store);
    const invocation = store.resources.createComputedInvocation({
      sourceId: source.id,
      producerId: "fixture.generation",
      inputs: { value: "old" },
      dependencies: [],
    });
    const execution = store.resources.executeComputedResource(invocation.resourceId, true);
    const revised = store.resources.reviseComputedInvocation({
      invocationId: invocation.id,
      expectedVersion: invocation.version,
      inputs: { value: "new" },
    });
    release?.();
    const receipt = await execution;

    expect(receipt.output).toMatchObject({
      kind: "failure",
      code: "execution-superseded",
    });
    expect(revised.inputVersion).toBe(2);
    expect(store.resources.describe(invocation.resourceId, true)).toMatchObject({
      computed: null,
      computedStatus: { state: "idle" },
      computedFailure: null,
    });
    expect(store.resources.computedExecutionHistory(invocation.resourceId).executions[0]?.output)
      .toEqual(receipt.output);
  });
});
