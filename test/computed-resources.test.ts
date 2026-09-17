import { expect, test } from "bun:test";
import { Type } from "typebox";
import {
  BUILTIN_MARKDOWN_MEDIA_TYPE,
  BUILTIN_MARKDOWN_PRODUCER_ID,
  ComputedProducerError,
  ComputedProducerRegistry,
  canonicalJson,
  canonicalJsonHash,
  createDefaultComputedProducerRegistry,
  type ComputedProducerDeclaration,
  type ComputedProducerErrorCode,
} from "../src/computed-resources";

async function expectProducerError(
  operation: () => unknown | Promise<unknown>,
  code: ComputedProducerErrorCode,
): Promise<ComputedProducerError> {
  try {
    await operation();
  } catch (error) {
    expect(error).toBeInstanceOf(ComputedProducerError);
    if (!(error instanceof ComputedProducerError)) throw error;
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`Expected ComputedProducerError: ${code}`);
}

const EmptyInputSchema = Type.Object({}, { additionalProperties: false });
const ValidDeclaration = {
  id: "test.valid",
  version: 1,
  inputSchema: EmptyInputSchema,
  permissions: [],
  determinism: "deterministic",
  cachePolicy: "content-addressed",
  outputMediaTypes: ["text/plain"],
  async execute() {
    return { kind: "immutable-snapshot", mediaType: "text/plain", content: "ok" };
  },
} satisfies ComputedProducerDeclaration<typeof EmptyInputSchema>;

test("producer declarations reject invalid identity, version, caching, and duplicate outputs", async () => {
  await expectProducerError(
    () => new ComputedProducerRegistry([{ ...ValidDeclaration, id: "not printable" }]),
    "invalid-declaration",
  );
  await expectProducerError(
    () => new ComputedProducerRegistry([{ ...ValidDeclaration, id: "test.version", version: 0 }]),
    "invalid-declaration",
  );
  await expectProducerError(
    () => new ComputedProducerRegistry([{
      ...ValidDeclaration,
      id: "test.cache",
      determinism: "nondeterministic",
    }]),
    "invalid-declaration",
  );
  await expectProducerError(
    () => new ComputedProducerRegistry([{
      ...ValidDeclaration,
      id: "test.outputs",
      outputMediaTypes: ["text/plain", "TEXT/PLAIN"],
    }]),
    "invalid-declaration",
  );

  const registry = new ComputedProducerRegistry([ValidDeclaration]);
  await expectProducerError(() => registry.register(ValidDeclaration), "duplicate-producer");
});

test("permissions are checked before schema validation and callback execution", async () => {
  const InputSchema = Type.Object({ count: Type.Integer({ minimum: 1 }) }, {
    additionalProperties: false,
  });
  let calls = 0;
  const registry = new ComputedProducerRegistry();
  registry.register({
    id: "test.secured",
    version: 1,
    inputSchema: InputSchema,
    permissions: ["workspace.read"],
    determinism: "deterministic",
    cachePolicy: "none",
    outputMediaTypes: ["text/plain"],
    async execute({ inputs }) {
      calls += 1;
      return {
        kind: "transient-representation",
        mediaType: "text/plain",
        content: String(inputs.count),
      };
    },
  });

  await expectProducerError(
    () => registry.execute({
      producerId: "test.secured",
      producerVersion: 1,
      inputs: { count: 0 },
      allowedPermissions: [],
    }),
    "permission-denied",
  );
  expect(calls).toBe(0);

  await expectProducerError(
    () => registry.execute({
      producerId: "test.secured",
      producerVersion: 1,
      inputs: { count: 0 },
      allowedPermissions: ["workspace.read"],
    }),
    "invalid-input",
  );
  expect(calls).toBe(0);

  await expect(
    registry.execute({
      producerId: "test.secured",
      producerVersion: 1,
      inputs: { count: 2 },
      allowedPermissions: ["workspace.read"],
    }),
  ).resolves.toEqual({
    kind: "transient-representation",
    mediaType: "text/plain",
    content: "2",
  });
  expect(calls).toBe(1);
});

test("registry validates output contracts and wraps callback failures", async () => {
  const invalidOutput = new ComputedProducerRegistry([{
    ...ValidDeclaration,
    id: "test.invalid-output",
    async execute() {
      return { kind: "immutable-snapshot", mediaType: "text/html", content: "no" };
    },
  }]);
  await expectProducerError(
    () => invalidOutput.execute({
      producerId: "test.invalid-output",
      producerVersion: 1,
      inputs: {},
      allowedPermissions: [],
    }),
    "invalid-output",
  );

  const failing = new ComputedProducerRegistry([{
    ...ValidDeclaration,
    id: "test.throwing",
    async execute() {
      throw new Error("adapter unavailable");
    },
  }]);
  const failure = await expectProducerError(
    () => failing.execute({
      producerId: "test.throwing",
      producerVersion: 1,
      inputs: {},
      allowedPermissions: [],
    }),
    "execution-failed",
  );
  expect(failure.message).toContain("adapter unavailable");
});

test("registry bounds structured inputs, output bytes, and execution time", async () => {
  const InputSchema = Type.Object({ body: Type.String() }, { additionalProperties: false });
  const oversizedInput = new ComputedProducerRegistry([{
    ...ValidDeclaration,
    id: "test.input-bound",
    inputSchema: InputSchema,
    async execute() {
      return { kind: "immutable-snapshot", mediaType: "text/plain", content: "ok" };
    },
  }], { maximumInputBytes: 16 });
  await expectProducerError(
    () => oversizedInput.execute({
      producerId: "test.input-bound",
      producerVersion: 1,
      inputs: { body: "x".repeat(32) },
      allowedPermissions: [],
    }),
    "invalid-input",
  );

  const oversizedOutput = new ComputedProducerRegistry([{
    ...ValidDeclaration,
    id: "test.output-bound",
    async execute() {
      return { kind: "immutable-snapshot", mediaType: "text/plain", content: "large" };
    },
  }], { maximumOutputBytes: 4 });
  await expectProducerError(
    () => oversizedOutput.execute({
      producerId: "test.output-bound",
      producerVersion: 1,
      inputs: {},
      allowedPermissions: [],
    }),
    "invalid-output",
  );

  let aborted = false;
  const timed = new ComputedProducerRegistry([{
    ...ValidDeclaration,
    id: "test.timeout",
    async execute({ signal }) {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve();
        }, { once: true });
      });
      return { kind: "immutable-snapshot", mediaType: "text/plain", content: "late" };
    },
  }], { executionTimeoutMs: 5 });
  await expectProducerError(
    () => timed.execute({
      producerId: "test.timeout",
      producerVersion: 1,
      inputs: {},
      allowedPermissions: [],
    }),
    "execution-timeout",
  );
  expect(aborted).toBe(true);
});

test("registry accepts all four computed producer outcomes", async () => {
  const InputSchema = Type.Object({
    outcome: Type.Union([
      Type.Literal("transient"),
      Type.Literal("snapshot"),
      Type.Literal("durable"),
      Type.Literal("failure"),
    ]),
  }, { additionalProperties: false });
  const registry = new ComputedProducerRegistry();
  registry.register({
    id: "test.outcomes",
    version: 1,
    inputSchema: InputSchema,
    permissions: [],
    determinism: "deterministic",
    cachePolicy: "none",
    outputMediaTypes: ["text/plain"],
    async execute({ inputs }) {
      switch (inputs.outcome) {
        case "transient":
          return { kind: "transient-representation", mediaType: "text/plain", content: "now" };
        case "snapshot":
          return { kind: "immutable-snapshot", mediaType: "text/plain", content: "forever" };
        case "durable":
          return { kind: "durable-resource", resourceId: "12345678-1234-4123-8123-123456789abc" };
        case "failure":
          return { kind: "failure", code: "not-ready", message: "Not ready" };
      }
    },
  });


  await expect(registry.execute({
    producerId: "test.outcomes",
    producerVersion: 1,
    inputs: { outcome: "transient" },
    allowedPermissions: [],
  })).resolves.toEqual({
    kind: "transient-representation",
    mediaType: "text/plain",
    content: "now",
  });
  await expect(registry.execute({
    producerId: "test.outcomes",
    producerVersion: 1,
    inputs: { outcome: "snapshot" },
    allowedPermissions: [],
  })).resolves.toEqual({
    kind: "immutable-snapshot",
    mediaType: "text/plain",
    content: "forever",
  });
  await expect(registry.execute({
    producerId: "test.outcomes",
    producerVersion: 1,
    inputs: { outcome: "durable" },
    allowedPermissions: [],
  })).resolves.toEqual({
    kind: "durable-resource",
    resourceId: "12345678-1234-4123-8123-123456789abc",
  });
  await expect(registry.execute({
    producerId: "test.outcomes",
    producerVersion: 1,
    inputs: { outcome: "failure" },
    allowedPermissions: [],
  })).resolves.toEqual({
    kind: "failure",
    code: "not-ready",
    message: "Not ready",
  });
});

test("canonical JSON sorts object keys recursively and hashes the canonical bytes", async () => {
  const first = { z: [3, { b: true, a: null }], a: "value" };
  const second = { a: "value", z: [3, { a: null, b: true }] };

  expect(canonicalJson(first)).toBe('{"a":"value","z":[3,{"a":null,"b":true}]}');
  expect(canonicalJson(second)).toBe(canonicalJson(first));
  expect(canonicalJsonHash(first)).toBe(
    "34aa98a39b69cd53017d84ad6f9635d59db194a30d8a72f7d1292bcbe6d06074",
  );
  await expectProducerError(() => canonicalJson({ unsupported: undefined }), "invalid-input");
});

test("built-in Markdown producer is deterministic, content-addressed, and schema checked", async () => {
  const registry = createDefaultComputedProducerRegistry();
  expect(registry.snapshot(BUILTIN_MARKDOWN_PRODUCER_ID)).toEqual({
    id: BUILTIN_MARKDOWN_PRODUCER_ID,
    version: 1,
    permissions: [],
    determinism: "deterministic",
    cachePolicy: "content-addressed",
    outputMediaTypes: [BUILTIN_MARKDOWN_MEDIA_TYPE],
  });

  const input = {
    producerId: BUILTIN_MARKDOWN_PRODUCER_ID,
    producerVersion: 1,
    inputs: { title: "Computed note", body: "A stable body." },
    allowedPermissions: [],
  };
  await expect(registry.execute(input)).resolves.toEqual({
    kind: "immutable-snapshot",
    mediaType: "text/markdown",
    content: "# Computed note\n\nA stable body.",
  });
  await expect(registry.execute(input)).resolves.toEqual(await registry.execute(input));

  await expectProducerError(
    () => registry.execute({ ...input, inputs: { title: "Computed note" } }),
    "invalid-input",
  );
});
