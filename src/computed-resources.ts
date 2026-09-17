import { createHash } from "node:crypto";
import { Compile, type Validator } from "typebox/compile";
import { IsSchema, Type, type Static, type TSchema } from "typebox";
import type {
  ComputedProducerDeclarationSnapshot,
  ResourceRevisionRef,
} from "./resources";

export type { ComputedProducerDeclarationSnapshot } from "./resources";

const MAX_IDENTIFIER_LENGTH = 200;
const MAX_MEDIA_TYPE_LENGTH = 255;
const MAX_FAILURE_MESSAGE_LENGTH = 4_096;
const PRINTABLE_IDENTIFIER = /^[\x21-\x7e]+$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const MEDIA_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const DEFAULT_MAX_COMPUTED_INPUT_BYTES = 256 * 1024;
export const DEFAULT_MAX_COMPUTED_OUTPUT_BYTES = 1024 * 1024;
export const DEFAULT_COMPUTED_EXECUTION_TIMEOUT_MS = 15_000;
export const BUILTIN_MARKDOWN_PRODUCER_ID = "builtin.markdown-template";
export const BUILTIN_MARKDOWN_MEDIA_TYPE = "text/markdown";

export type ComputedProducerDeterminism = "deterministic" | "nondeterministic";
export type ComputedProducerCachePolicy = "none" | "content-addressed";

export type ComputedProducerOutput =
  | {
      readonly kind: "transient-representation";
      readonly mediaType: string;
      readonly content: string;
    }
  | {
      readonly kind: "immutable-snapshot";
      readonly mediaType: string;
      readonly content: string;
    }
  | {
      readonly kind: "durable-resource";
      readonly resourceId: string;
    }
  | {
      readonly kind: "failure";
      readonly code: string;
      readonly message: string;
    };

export interface ComputedProducerExecutionContext<Input = unknown> {
  readonly inputs: Input;
  readonly dependencies: readonly ResourceRevisionRef[];
  readonly signal: AbortSignal;
}

export interface ComputedProducerDeclaration<InputSchema extends TSchema = TSchema> {
  readonly id: string;
  readonly version: number;
  readonly inputSchema: InputSchema;
  readonly permissions: readonly string[];
  readonly determinism: ComputedProducerDeterminism;
  readonly cachePolicy: ComputedProducerCachePolicy;
  readonly outputMediaTypes: readonly string[];
  execute(
    context: ComputedProducerExecutionContext<Static<InputSchema>>,
  ): Promise<ComputedProducerOutput>;
}

export function defineComputedProducer<const InputSchema extends TSchema>(
  declaration: ComputedProducerDeclaration<InputSchema>,
): ComputedProducerDeclaration<InputSchema> {
  return declaration;
}

export interface ComputedProducerDefinition
  extends ComputedProducerDeclarationSnapshot {
  readonly inputSchema: TSchema;
}

export interface ExecuteComputedProducerInput {
  readonly producerId: string;
  readonly producerVersion: number;
  readonly inputs: unknown;
  readonly allowedPermissions: readonly string[];
  readonly dependencies?: readonly ResourceRevisionRef[];
}

export type ComputedProducerErrorCode =
  | "invalid-declaration"
  | "duplicate-producer"
  | "missing-producer"
  | "version-mismatch"
  | "permission-denied"
  | "invalid-input"
  | "execution-timeout"
  | "execution-failed"
  | "invalid-output";

export class ComputedProducerError extends Error {
  constructor(
    readonly code: ComputedProducerErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ComputedProducerError";
  }
}

export interface ComputedProducerRegistryOptions {
  readonly maximumInputBytes?: number;
  readonly maximumOutputBytes?: number;
  readonly executionTimeoutMs?: number;
}

interface RegisteredProducer {
  readonly definition: ComputedProducerDefinition;
  readonly validator: Validator;
  readonly prepare: (
    inputs: unknown,
    dependencies: readonly ResourceRevisionRef[],
  ) => ((signal: AbortSignal) => Promise<ComputedProducerOutput>) | undefined;
}

function producerError(
  code: ComputedProducerErrorCode,
  message: string,
): never {
  throw new ComputedProducerError(code, message);
}

function printableIdentifier(
  value: unknown,
  label: string,
  errorCode: ComputedProducerErrorCode = "invalid-declaration",
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    !PRINTABLE_IDENTIFIER.test(value)
  ) {
    producerError(
      errorCode,
      `${label} must be 1-${MAX_IDENTIFIER_LENGTH} printable non-whitespace ASCII characters`,
    );
  }
  return value;
}

function positiveVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    producerError(
      "invalid-declaration",
      "Computed producer version must be a positive safe integer",
    );
  }
  return Number(value);
}

function positiveBound(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    producerError("invalid-declaration", `${label} must be a positive safe integer`);
  }
  return Number(value);
}

function mediaType(
  value: unknown,
  label: string,
  errorCode: ComputedProducerErrorCode = "invalid-declaration",
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_MEDIA_TYPE_LENGTH ||
    !MEDIA_TYPE.test(value)
  ) {
    producerError(
      errorCode,
      `${label} must be a valid media type no longer than ${MAX_MEDIA_TYPE_LENGTH} characters`,
    );
  }
  return value.toLowerCase();
}

function uniqueValues(
  values: readonly string[],
  label: string,
  errorCode: ComputedProducerErrorCode,
): void {
  if (new Set(values).size !== values.length) {
    producerError(errorCode, `${label} must not contain duplicates`);
  }
}


function hasExactKeys<const Key extends string>(
  value: object,
  expected: readonly Key[],
): value is Record<Key, unknown> {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}


function canonicalJsonValue(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      producerError("invalid-input", "Canonical JSON does not support non-finite numbers");
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    producerError(
      "invalid-input",
      `Canonical JSON does not support ${typeof value} values`,
    );
  }
  if (ancestors.has(value)) {
    producerError("invalid-input", "Canonical JSON does not support cyclic values");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      if (
        keys.length !== value.length ||
        keys.some((key, index) => key !== String(index)) ||
        Object.getOwnPropertySymbols(value).length > 0
      ) {
        producerError(
          "invalid-input",
          "Canonical JSON arrays must be dense and contain no named properties",
        );
      }
      return `[${value.map((item) => canonicalJsonValue(item, ancestors)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      producerError("invalid-input", "Canonical JSON only supports plain objects");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string")) {
      producerError("invalid-input", "Canonical JSON does not support symbol properties");
    }
    const members: string[] = [];
    for (const key of Object.keys(descriptors).sort()) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable) continue;
      if (!("value" in descriptor)) {
        producerError("invalid-input", "Canonical JSON does not support accessor properties");
      }
      members.push(`${JSON.stringify(key)}:${canonicalJsonValue(descriptor.value, ancestors)}`);
    }
    return `{${members.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return canonicalJsonValue(value, new Set());
}

export function canonicalJsonHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export class ComputedProducerRegistry {
  readonly #producers = new Map<string, RegisteredProducer>();
  readonly #maximumInputBytes: number;
  readonly #maximumOutputBytes: number;
  readonly #executionTimeoutMs: number;

  constructor(
    declarations: readonly ComputedProducerDeclaration[] = [],
    options: ComputedProducerRegistryOptions = {},
  ) {
    this.#maximumInputBytes = positiveBound(
      options.maximumInputBytes ?? DEFAULT_MAX_COMPUTED_INPUT_BYTES,
      "Computed producer maximum input bytes",
    );
    this.#maximumOutputBytes = positiveBound(
      options.maximumOutputBytes ?? DEFAULT_MAX_COMPUTED_OUTPUT_BYTES,
      "Computed producer maximum output bytes",
    );
    this.#executionTimeoutMs = positiveBound(
      options.executionTimeoutMs ?? DEFAULT_COMPUTED_EXECUTION_TIMEOUT_MS,
      "Computed producer execution timeout",
    );
    for (const declaration of declarations) this.register(declaration);
  }

  register<const InputSchema extends TSchema>(
    declaration: ComputedProducerDeclaration<InputSchema>,
  ): void {
    const id = printableIdentifier(declaration.id, "Computed producer ID");
    const version = positiveVersion(declaration.version);
    if (this.#producers.has(id)) {
      producerError("duplicate-producer", `Computed producer is already registered: ${id}`);
    }
    if (!IsSchema(declaration.inputSchema)) {
      producerError("invalid-declaration", `Computed producer ${id} input schema is invalid`);
    }
    if (!Array.isArray(declaration.permissions)) {
      producerError("invalid-declaration", `Computed producer ${id} permissions must be an array`);
    }
    const permissions = declaration.permissions.map((permission, index) =>
      printableIdentifier(permission, `Computed producer ${id} permission ${index + 1}`)
    );
    uniqueValues(permissions, `Computed producer ${id} permissions`, "invalid-declaration");
    if (
      declaration.determinism !== "deterministic" &&
      declaration.determinism !== "nondeterministic"
    ) {
      producerError("invalid-declaration", `Computed producer ${id} determinism is invalid`);
    }
    if (
      declaration.cachePolicy !== "none" &&
      declaration.cachePolicy !== "content-addressed"
    ) {
      producerError("invalid-declaration", `Computed producer ${id} cache policy is invalid`);
    }
    if (
      declaration.cachePolicy === "content-addressed" &&
      declaration.determinism !== "deterministic"
    ) {
      producerError(
        "invalid-declaration",
        `Computed producer ${id} must be deterministic to use content-addressed caching`,
      );
    }
    if (
      !Array.isArray(declaration.outputMediaTypes) ||
      declaration.outputMediaTypes.length === 0
    ) {
      producerError(
        "invalid-declaration",
        `Computed producer ${id} must declare at least one output media type`,
      );
    }
    const outputMediaTypes = declaration.outputMediaTypes.map((value, index) =>
      mediaType(value, `Computed producer ${id} output media type ${index + 1}`)
    );
    uniqueValues(
      outputMediaTypes,
      `Computed producer ${id} output media types`,
      "invalid-declaration",
    );
    if (typeof declaration.execute !== "function") {
      producerError("invalid-declaration", `Computed producer ${id} execute must be a function`);
    }

    let validator: Validator<{}, InputSchema>;
    try {
      validator = Compile(declaration.inputSchema);
    } catch (error) {
      throw new ComputedProducerError(
        "invalid-declaration",
        `Computed producer ${id} input schema cannot be compiled`,
        { cause: error },
      );
    }

    const definition: ComputedProducerDefinition = Object.freeze({
      id,
      version,
      inputSchema: declaration.inputSchema,
      permissions: Object.freeze([...permissions]),
      determinism: declaration.determinism,
      cachePolicy: declaration.cachePolicy,
      outputMediaTypes: Object.freeze([...outputMediaTypes]),
    });
    const prepare = (
      inputs: unknown,
      dependencies: readonly ResourceRevisionRef[],
    ): ((signal: AbortSignal) => Promise<ComputedProducerOutput>) | undefined => {
      if (!validator.Check(inputs)) return undefined;
      return (signal) => declaration.execute({ inputs, dependencies, signal });
    };
    this.#producers.set(id, { definition, validator, prepare });
  }

  get(id: string): ComputedProducerDefinition | undefined {
    return this.#producers.get(id)?.definition;
  }

  require(id: string, version?: number): ComputedProducerDefinition {
    const definition = this.#producers.get(id)?.definition;
    if (!definition) {
      producerError("missing-producer", `Computed producer is not registered: ${id}`);
    }
    if (version !== undefined && definition.version !== version) {
      producerError(
        "version-mismatch",
        `Computed producer ${id} version ${version} is unavailable; registered version is ${definition.version}`,
      );
    }
    return definition;
  }

  snapshot(id: string, version?: number): ComputedProducerDeclarationSnapshot {
    const definition = this.require(id, version);
    return {
      id: definition.id,
      version: definition.version,
      permissions: [...definition.permissions],
      determinism: definition.determinism,
      cachePolicy: definition.cachePolicy,
      outputMediaTypes: [...definition.outputMediaTypes],
    };
  }

  validateInputs(definition: ComputedProducerDefinition, inputs: unknown): void {
    const producer = this.#registered(definition);
    if (!producer.validator.Check(inputs)) {
      producerError(
        "invalid-input",
        `Inputs do not match computed producer ${definition.id} schema`,
      );
    }
    const inputBytes = Buffer.byteLength(canonicalJson(inputs), "utf8");
    if (inputBytes > this.#maximumInputBytes) {
      producerError(
        "invalid-input",
        `Computed producer ${definition.id} inputs exceed ${this.#maximumInputBytes} bytes`,
      );
    }
  }

  validatePermissions(
    definition: ComputedProducerDefinition,
    allowedPermissions: readonly string[],
  ): void {
    if (!Array.isArray(allowedPermissions)) {
      producerError("invalid-input", "Computed source allowed permissions must be an array");
    }
    const allowed = new Set<string>();
    for (const [index, permission] of allowedPermissions.entries()) {
      if (
        typeof permission !== "string" ||
        permission.length === 0 ||
        permission.length > MAX_IDENTIFIER_LENGTH ||
        !PRINTABLE_IDENTIFIER.test(permission)
      ) {
        producerError(
          "invalid-input",
          `Computed source allowed permission ${index + 1} is invalid`,
        );
      }
      allowed.add(permission);
    }
    const denied = definition.permissions.filter((permission) => !allowed.has(permission));
    if (denied.length > 0) {
      producerError(
        "permission-denied",
        `Computed producer ${definition.id} requires disallowed permissions: ${denied.join(", ")}`,
      );
    }
  }

  validateOutput(
    definition: ComputedProducerDefinition,
    output: unknown,
  ): ComputedProducerOutput {
    if (
      typeof output !== "object" ||
      output === null ||
      Array.isArray(output) ||
      !("kind" in output) ||
      typeof output.kind !== "string"
    ) {
      producerError("invalid-output", `Computed producer ${definition.id} returned an invalid output`);
    }

    switch (output.kind) {
      case "transient-representation":
      case "immutable-snapshot": {
        if (!hasExactKeys(output, ["kind", "mediaType", "content"])) {
          producerError(
            "invalid-output",
            `Computed producer ${definition.id} returned an invalid ${output.kind} output`,
          );
        }
        const normalizedMediaType = mediaType(
          output.mediaType,
          `Computed producer ${definition.id} output media type`,
          "invalid-output",
        );
        if (!definition.outputMediaTypes.includes(normalizedMediaType)) {
          producerError(
            "invalid-output",
            `Computed producer ${definition.id} returned undeclared media type: ${normalizedMediaType}`,
          );
        }
        if (typeof output.content !== "string") {
          producerError(
            "invalid-output",
            `Computed producer ${definition.id} output content must be a string`,
          );
        }
        if (Buffer.byteLength(output.content, "utf8") > this.#maximumOutputBytes) {
          producerError(
            "invalid-output",
            `Computed producer ${definition.id} output exceeds ${this.#maximumOutputBytes} bytes`,
          );
        }
        return {
          kind: output.kind,
          mediaType: normalizedMediaType,
          content: output.content,
        };
      }
      case "durable-resource": {
        if (
          !hasExactKeys(output, ["kind", "resourceId"]) ||
          typeof output.resourceId !== "string" ||
          !UUID_PATTERN.test(output.resourceId)
        ) {
          producerError(
            "invalid-output",
            `Computed producer ${definition.id} durable output must contain a canonical Resource UUID`,
          );
        }
        return { kind: "durable-resource", resourceId: output.resourceId };
      }
      case "failure": {
        if (!hasExactKeys(output, ["kind", "code", "message"])) {
          producerError(
            "invalid-output",
            `Computed producer ${definition.id} returned an invalid failure output`,
          );
        }
        const code = printableIdentifier(
          output.code,
          "Computed producer failure code",
          "invalid-output",
        );
        if (
          typeof output.message !== "string" ||
          output.message.length === 0 ||
          output.message.length > MAX_FAILURE_MESSAGE_LENGTH ||
          CONTROL_CHARACTERS.test(output.message)
        ) {
          producerError(
            "invalid-output",
            `Computed producer failure message must be 1-${MAX_FAILURE_MESSAGE_LENGTH} printable characters`,
          );
        }
        return { kind: "failure", code, message: output.message };
      }
      default:
        producerError(
          "invalid-output",
          `Computed producer ${definition.id} returned unsupported output kind: ${output.kind}`,
        );
    }
  }

  async execute(input: ExecuteComputedProducerInput): Promise<ComputedProducerOutput> {
    const producer = this.#producers.get(input.producerId);
    const definition = this.require(input.producerId, input.producerVersion);
    if (!producer) {
      producerError("missing-producer", `Computed producer is not registered: ${input.producerId}`);
    }
    this.validatePermissions(definition, input.allowedPermissions);
    this.validateInputs(definition, input.inputs);
    const execution = producer.prepare(input.inputs, input.dependencies ?? []);
    if (!execution) {
      producerError(
        "invalid-input",
        `Inputs do not match computed producer ${definition.id} schema`,
      );
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new ComputedProducerError(
          "execution-timeout",
          `Computed producer ${definition.id} exceeded ${this.#executionTimeoutMs} ms`,
        ));
        controller.abort();
      }, this.#executionTimeoutMs);
    });
    let output: ComputedProducerOutput;
    try {
      output = await Promise.race([execution(controller.signal), timeout]);
    } catch (error) {
      if (error instanceof ComputedProducerError) throw error;
      throw new ComputedProducerError(
        "execution-failed",
        `Computed producer ${definition.id} execution failed${
          error instanceof Error && error.message ? `: ${error.message}` : ""
        }`,
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
    }
    return this.validateOutput(definition, output);
  }

  #registered(definition: ComputedProducerDefinition): RegisteredProducer {
    const producer = this.#producers.get(definition.id);
    if (!producer) {
      producerError(
        "missing-producer",
        `Computed producer is not registered: ${definition.id}`,
      );
    }
    if (producer.definition.version !== definition.version) {
      producerError(
        "version-mismatch",
        `Computed producer ${definition.id} version ${definition.version} is unavailable`,
      );
    }
    return producer;
  }
}

const BuiltinMarkdownInputSchema = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 200, pattern: "^[^\\r\\n]+$" }),
  body: Type.String(),
}, { additionalProperties: false });

export const BUILTIN_MARKDOWN_PRODUCER = {
  id: BUILTIN_MARKDOWN_PRODUCER_ID,
  version: 1,
  inputSchema: BuiltinMarkdownInputSchema,
  permissions: [],
  determinism: "deterministic",
  cachePolicy: "content-addressed",
  outputMediaTypes: [BUILTIN_MARKDOWN_MEDIA_TYPE],
  async execute({ inputs }) {
    return {
      kind: "immutable-snapshot",
      mediaType: BUILTIN_MARKDOWN_MEDIA_TYPE,
      content: `# ${inputs.title}\n\n${inputs.body}`,
    };
  },
} satisfies ComputedProducerDeclaration<typeof BuiltinMarkdownInputSchema>;

export function createDefaultComputedProducerRegistry(): ComputedProducerRegistry {
  return new ComputedProducerRegistry([BUILTIN_MARKDOWN_PRODUCER]);
}
