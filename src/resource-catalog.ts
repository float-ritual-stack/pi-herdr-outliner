import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync, type BigIntStats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Type, type Static } from "typebox";
import { Parse } from "typebox/value";
import {
  BasicWebMarkdownExtractor,
  sha256,
  type WebMarkdownExtractor,
} from "./web-markdown";
import { PdfJsTextExtractor, type PdfTextExtractor } from "./pdf-text";
import { ResourceRetentionRepository } from "./resource-retention";
import {
  DefaultRemoteEntityProviderClient,
  REMOTE_ENTITY_MARKDOWN_ADAPTER,
  type RemoteEntityProviderClient,
} from "./remote-entity";
import {
  ComputedProducerError,
  canonicalJson,
  canonicalJsonHash,
  createDefaultComputedProducerRegistry,
  type ComputedProducerOutput,
  type ComputedProducerRegistry,
} from "./computed-resources";
import {
  ResourceCatalogError,
  deriveResourceCapabilityReport,
  normalizeInternResourceInput,
  normalizeRelocateResourceInput,
  normalizeResourceAddress,
  normalizeResourceId,
  normalizeRetainedResourceRevisionRef,
  normalizeResourceRevisionRef,
  resourceRevisionRefEquals,
  normalizeResourceSourceInput,
  type CreateResourceSourceInput,
  type ComputedExecutionHistory,
  type ComputedExecutionReceipt,
  type ComputedExecutionRecord,
  type ComputedHandlerResolution,
  type ComputedInvocation,
  type ComputedProducerDeclarationSnapshot,
  type ComputedResourceDocument,
  type ComputedResourceFailure,
  type ComputedResourceStatus,
  type CreateComputedInvocationInput,
  type ReviseComputedInvocationInput,
  type FilesystemResourceDocument,
  type PdfPageText,
  type PdfRepresentationProvenance,
  type PdfResourceDocument,
  type PdfResourceHistory,
  type PdfSourceSnapshotProvenance,
  type InternFilesystemResourceInput,
  type InternResourceReceipt,
  type Resource,
  type ResourceAddress,
  type ResourceDescription,
  type ResourceNativePayload,
  type ResourceFreshness,
  type ResourceRetentionCollectionReceipt,
  type ResourceRetentionPin,
  type ResourceRetentionPolicy,
  type ResourceRetentionReference,
  type ResourceRetentionReport,
  type ResourceRevisionRef,
  type ResourceSource,
  type WebRepresentationProvenance,
  type WebResourceHistory,
  type WebResourceDocument,
  type WebResourceStatus,
  type WebSourceSnapshotProvenance,
  type RemoteEntityDocument,
  type RemoteEntityProvider,
  type ResourceProviderCommandInput,
  type ResourceProviderCommandReceipt,
} from "./resources";

const MAX_FILESYSTEM_RESOURCE_BYTES = 2 * 1024 * 1024;

interface SourceRow {
  id: string;
  name: string;
  provider: string;
  boundary_json: string;
  policy_json: string;
  root_binding: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

interface ResourceRow {
  id: string;
  source_id: string;
  provider: string;
  address_json: string;
  canonical_key: string;
  media_type: string | null;
  address_version: number;
  version: number;
  created_at: string;
  updated_at: string;
}

interface ComputedInvocationRow {
  id: string;
  resource_id: string;
  source_id: string;
  producer_id: string;
  producer_version: number;
  input_version: number;
  inputs_json: string;
  dependencies_json: string;
  declaration_json: string;
  version: number;
  created_at: string;
  updated_at: string;
}

interface ComputedRepresentationRow {
  id: string;
  cache_key: string | null;
  producer_id: string;
  producer_version: number;
  input_version: number;
  dependency_fingerprint: string;
  media_type: string;
  content_hash: string;
  content: string;
  created_at: string;
}

interface ComputedExecutionRow {
  id: string;
  invocation_id: string;
  resource_id: string;
  generation: number;
  producer_id: string;
  producer_version: number;
  input_version: number;
  dependency_fingerprint: string;
  dependencies_json: string;
  cache_hit: number;
  status: "executing" | "succeeded" | "failed";
  output_kind:
    | "transient-representation"
    | "immutable-snapshot"
    | "durable-resource"
    | "failure"
    | null;
  media_type: string | null;
  output_content_hash: string | null;
  representation_id: string | null;
  durable_resource_id: string | null;
  failure_code: string | null;
  failure_message: string | null;
  started_at: string;
  completed_at: string | null;
}

interface ComputedResourceStateRow {
  resource_id: string;
  invocation_id: string;
  generation: number;
  status: "idle" | "executing" | "succeeded" | "failed";
  selected_execution_id: string | null;
  representation_id: string | null;
  durable_resource_id: string | null;
  last_failure_execution_id: string | null;
  started_at: string | null;
  completed_at: string | null;
}

interface ComputedExecutionInitial {
  readonly id: string;
  readonly generation: number;
  readonly invocationVersion: number;
  readonly resource: Extract<Resource, { provider: "computed" }>;
  readonly source: Extract<ResourceSource, { provider: "computed" }>;
  readonly invocation: ComputedInvocation;
  readonly dependencyFingerprint: string;
  readonly startedAt: string;
}
interface WebSourceSnapshotRow {
  id: string;
  resource_id: string;
  address_version: number;
  canonical_url: string | null;
  content_hash: string | null;
  revision_json: string;
  etag: string | null;
  last_modified: string | null;
  html: string | null;
  evicted_at: string | null;
  fetched_at: string | null;
}

interface WebRepresentationRow {
  id: string;
  source_snapshot_id: string;
  media_type: "text/markdown";
  adapter_id: string;
  adapter_version: number;
  content_hash: string;
  markdown: string | null;
  evicted_at: string | null;
  derived_at: string | null;
}

interface WebResourceStateRow {
  resource_id: string;
  address_version: number;
  generation: number;
  source_snapshot_id: string | null;
  representation_id: string | null;
  freshness: ResourceFreshness;
  checked_at: string | null;
  last_error: string | null;
}

interface PdfSourceSnapshotRow {
  id: string;
  resource_id: string;
  address_version: number;
  locator: string;
  content_hash: string;
  revision_json: string;
  etag: string | null;
  last_modified: string | null;
  bytes: Uint8Array | null;
  payload_state: "available" | "evicted";
  payload_bytes: number;
  evicted_at: string | null;
  captured_at: string;
}

interface PdfRepresentationRow {
  id: string;
  source_snapshot_id: string;
  media_type: "application/pdf" | "text/markdown";
  adapter_id: string;
  adapter_version: number;
  content_hash: string;
  markdown: string | null;
  pages_json: string | null;
  derived_at: string;
  payload_state: "available" | "evicted";
  payload_bytes: number;
  evicted_at: string | null;
}

interface PdfResourceStateRow {
  resource_id: string;
  address_version: number;
  generation: number;
  source_snapshot_id: string | null;
  representation_id: string | null;
}

interface RemoteEntitySourceSnapshotRow {
  id: string;
  resource_id: string;
  address_version: number;
  provider: RemoteEntityProvider;
  entity_id: string;
  revision_json: string;
  payload_json: string | null;
  captured_at: string;
  payload_state: "available" | "evicted";
  payload_bytes: number;
  evicted_at: string | null;
}

interface RemoteEntityRepresentationRow {
  id: string;
  source_snapshot_id: string;
  media_type: "text/markdown";
  adapter_id: string;
  version: number;
  content_hash: string;
  markdown: string | null;
  derived_at: string;
  payload_state: "available" | "evicted";
  payload_bytes: number;
  evicted_at: string | null;
}

interface RemoteEntityResourceStateRow {
  resource_id: string;
  address_version: number;
  generation: number;
  source_snapshot_id: string | null;
  representation_id: string | null;
  freshness: ResourceFreshness;
  checked_at: string | null;
  last_error: string | null;
}

interface PdfObservation {
  readonly locator: string;
  readonly contentHash: string;
  readonly revision: ResourceRevisionRef;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly bytes: Uint8Array;
  readonly capturedAt: string;
}


interface WebObservation {
  readonly canonicalUrl: string;
  readonly contentHash: string;
  readonly revision: ResourceRevisionRef;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly html: string;
  readonly fetchedAt: string;
}

interface LegacyRepresentationEvidence {
  readonly mediaType: "text/markdown";
  readonly adapter: {
    readonly id: string;
    readonly version: number;
  };
  readonly contentHash: string;
}

interface LegacyWebResourceDocumentRow {
  resource_id: string;
  address_version: number;
  generation: number;
  canonical_url: string;
  source_hash: string;
  markdown: string;
  revision_json: string;
  adapter_id: string;
  adapter_version: number;
  representation_hash: string;
  etag: string | null;
  last_modified: string | null;
  freshness: "fresh" | "failed";
  fetched_at: string;
  checked_at: string;
  last_error: string | null;
}

interface LegacyWebResourceAnnotationRow {
  id: string;
  resource_id: string;
  revision_json: string;
  representation_json: string;
  anchor_json: string;
  body: string;
  created_at: string;
}

export interface ResourceCatalogOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly webExtractor?: WebMarkdownExtractor;
  readonly pdfExtractor?: PdfTextExtractor;
  readonly now?: () => string;
  readonly maximumWebBytes?: number;
  readonly webStaleAfterMs?: number;
  readonly workspaceRoot?: string;
  readonly maximumPdfBytes?: number;
  readonly remoteEntityClient?: RemoteEntityProviderClient;
  readonly computedProducerRegistry?: ComputedProducerRegistry;
}

const DEFAULT_MAXIMUM_WEB_BYTES = 2 * 1024 * 1024;
const DEFAULT_WEB_STALE_AFTER_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAXIMUM_PDF_BYTES = 16 * 1024 * 1024;
const PDF_NATIVE_ADAPTER = { id: "builtin.pdf-native", version: 1 } as const;
const COMPUTED_MARKDOWN_ADAPTER = { id: "builtin.computed-markdown", version: 1 } as const;

interface LegacySourceRow {
  id: string;
  name: string;
  provider: string;
  root_locator: string;
  capabilities_json: string;
  created_at: string;
  updated_at: string;
}

interface LegacyResourceRow {
  id: string;
  source_id: string;
  locator: string;
  media_type: string | null;
  provider_revision: string | null;
  created_at: string;
  updated_at: string;
}

function parsedJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new ResourceCatalogError("invalid-input", `${label} contains invalid JSON`);
  }
}
const InternIdentitySchema = Type.Object({
  sourceId: Type.String(),
});

const RelocationIdentitySchema = Type.Object({
  resourceId: Type.String(),
  destinationSourceId: Type.String(),
});
const ComputedInvocationInputSchema = Type.Object({
  sourceId: Type.String(),
  producerId: Type.String(),
  inputs: Type.Record(Type.String(), Type.Unknown()),
  dependencies: Type.Array(Type.Unknown()),
}, { additionalProperties: false });
const ComputedInvocationRevisionSchema = Type.Object({
  invocationId: Type.String(),
  expectedVersion: Type.Integer({ minimum: 1 }),
  inputs: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  dependencies: Type.Optional(Type.Array(Type.Unknown())),
}, { additionalProperties: false });
const ComputedProducerDeclarationSnapshotSchema = Type.Object({
  id: Type.String(),
  version: Type.Integer({ minimum: 1 }),
  permissions: Type.Array(Type.String()),
  determinism: Type.Union([
    Type.Literal("deterministic"),
    Type.Literal("nondeterministic"),
  ]),
  cachePolicy: Type.Union([
    Type.Literal("none"),
    Type.Literal("content-addressed"),
  ]),
  outputMediaTypes: Type.Array(Type.String()),
}, { additionalProperties: false });
const LegacyRepresentationEvidenceSchema = Type.Object({
  mediaType: Type.Literal("text/markdown"),
  adapter: Type.Object({
    id: Type.String(),
    version: Type.Integer({ minimum: 1 }),
  }),
  contentHash: Type.String(),
});
const RemoteEntityCommandDescriptorSchema = Type.Union([
  Type.Object({
    provider: Type.Literal("jira"),
    command: Type.Literal("comment.create"),
    label: Type.String(),
    input: Type.Object({
      body: Type.Object({
        type: Type.Literal("string"),
        required: Type.Literal(true),
        maxLength: Type.Literal(10_000),
      }, { additionalProperties: false }),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  Type.Object({
    provider: Type.Literal("linear"),
    command: Type.Literal("comment.create"),
    label: Type.String(),
    input: Type.Object({
      body: Type.Object({
        type: Type.Literal("string"),
        required: Type.Literal(true),
        maxLength: Type.Literal(10_000),
      }, { additionalProperties: false }),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
]);
const RemoteEntitySnapshotPayloadSchema = Type.Object({
  title: Type.String(),
  metadata: Type.Record(
    Type.String(),
    Type.Union([Type.String(), Type.Array(Type.String()), Type.Null()]),
  ),
  externalUrl: Type.String(),
  locator: Type.String(),
  contentHash: Type.String(),
  commandDescriptors: Type.Array(RemoteEntityCommandDescriptorSchema),
}, { additionalProperties: false });
interface RemoteEntitySnapshotPayload {
  readonly title: string;
  readonly metadata: RemoteEntityDocument["metadata"];
  readonly externalUrl: string;
  readonly locator: string;
  readonly contentHash: string;
  readonly commandDescriptors: RemoteEntityDocument["commandDescriptors"];
}
type InternIdentity = Static<typeof InternIdentitySchema>;
type RelocationIdentity = Static<typeof RelocationIdentitySchema>;
type ParsedComputedInvocationInput = Static<typeof ComputedInvocationInputSchema>;
type ParsedComputedInvocationRevision = Static<typeof ComputedInvocationRevisionSchema>;

function parseInternIdentity(value: unknown): InternIdentity {
  try {
    return Parse(InternIdentitySchema, value);
  } catch {
    throw new ResourceCatalogError("invalid-input", "Resource source ID must be a string");
  }
}

function parseRelocationIdentity(value: unknown): RelocationIdentity {
  try {
    return Parse(RelocationIdentitySchema, value);
  } catch {
    throw new ResourceCatalogError(
      "invalid-input",
      "Resource ID and destination source ID must be strings",
    );
  }
}

function parseLegacyRepresentationEvidence(
  value: unknown,
): LegacyRepresentationEvidence {
  try {
    return Parse(LegacyRepresentationEvidenceSchema, value);
  } catch {
    throw new ResourceCatalogError(
      "invalid-input",
      "Legacy web annotation representation provenance is invalid",
    );
  }
}

function parseRemoteEntitySnapshotPayload(value: unknown): RemoteEntitySnapshotPayload {
  try {
    return Parse(RemoteEntitySnapshotPayloadSchema, value);
  } catch {
    throw new ResourceCatalogError(
      "source-unavailable",
      "Stored remote entity snapshot payload is invalid",
    );
  }
}

function parseComputedInvocationInput(value: unknown): ParsedComputedInvocationInput {
  try {
    return Parse(ComputedInvocationInputSchema, value);
  } catch {
    throw new ResourceCatalogError(
      "invalid-input",
      "Computed invocation input must contain sourceId, producerId, structured inputs, and dependencies",
    );
  }
}

function parseComputedInvocationRevision(value: unknown): ParsedComputedInvocationRevision {
  let parsed: ParsedComputedInvocationRevision;
  try {
    parsed = Parse(ComputedInvocationRevisionSchema, value);
  } catch {
    throw new ResourceCatalogError(
      "invalid-input",
      "Computed invocation revision is invalid",
    );
  }
  if (parsed.inputs === undefined && parsed.dependencies === undefined) {
    throw new ResourceCatalogError(
      "invalid-input",
      "Computed invocation revision must change inputs or dependencies",
    );
  }
  return parsed;
}

function parseComputedDeclaration(value: unknown): ComputedProducerDeclarationSnapshot {
  try {
    return Parse(ComputedProducerDeclarationSnapshotSchema, value);
  } catch {
    throw new ResourceCatalogError(
      "invalid-input",
      "Stored computed producer declaration is invalid",
    );
  }
}

function computedInvocationFromRow(row: ComputedInvocationRow): ComputedInvocation {
  const inputs = parsedJson(row.inputs_json, "Computed invocation inputs");
  let structuredInputs: Readonly<Record<string, unknown>>;
  try {
    structuredInputs = Parse(Type.Record(Type.String(), Type.Unknown()), inputs);
  } catch {
    throw new ResourceCatalogError("invalid-input", "Stored computed inputs are invalid");
  }
  const dependenciesValue = parsedJson(
    row.dependencies_json,
    "Computed invocation dependencies",
  );
  if (!Array.isArray(dependenciesValue)) {
    throw new ResourceCatalogError("invalid-input", "Stored computed dependencies are invalid");
  }
  return {
    id: normalizeResourceId(row.id, "Computed invocation ID"),
    resourceId: normalizeResourceId(row.resource_id),
    sourceId: normalizeResourceId(row.source_id, "Resource source ID"),
    producerId: row.producer_id,
    producerVersion: row.producer_version,
    inputVersion: row.input_version,
    inputs: structuredInputs,
    dependencies: dependenciesValue.map(normalizeRetainedResourceRevisionRef),
    declaration: parseComputedDeclaration(
      parsedJson(row.declaration_json, "Computed producer declaration"),
    ),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}




function computedExecutionRecordFromRow(row: ComputedExecutionRow): ComputedExecutionRecord {
  if (!row.completed_at || !row.output_kind) {
    throw new ResourceCatalogError("invalid-input", "Stored computed execution is incomplete");
  }
  const dependenciesValue = parsedJson(
    row.dependencies_json,
    "Computed execution dependencies",
  );
  if (!Array.isArray(dependenciesValue)) {
    throw new ResourceCatalogError(
      "invalid-input",
      "Stored computed execution dependencies are invalid",
    );
  }
  const dependencies = dependenciesValue.map(normalizeRetainedResourceRevisionRef);
  let output: ComputedExecutionRecord["output"];
  switch (row.output_kind) {
    case "transient-representation":
      if (!row.media_type) {
        throw new ResourceCatalogError("invalid-input", "Stored transient output is invalid");
      }
      output = { kind: "transient-representation", mediaType: row.media_type };
      break;
    case "immutable-snapshot": {
      if (!row.media_type || !row.representation_id || !row.output_content_hash) {
        throw new ResourceCatalogError("invalid-input", "Stored immutable output is invalid");
      }
      output = {
        kind: "immutable-snapshot",
        mediaType: row.media_type,
        contentHash: row.output_content_hash,
        representationId: row.representation_id,
      };
      break;
    }
    case "durable-resource":
      if (!row.durable_resource_id) {
        throw new ResourceCatalogError("invalid-input", "Stored durable output is invalid");
      }
      output = { kind: "durable-resource", resourceId: row.durable_resource_id };
      break;
    case "failure":
      if (!row.failure_code || !row.failure_message) {
        throw new ResourceCatalogError("invalid-input", "Stored computed failure is invalid");
      }
      output = {
        kind: "failure",
        code: row.failure_code,
        message: row.failure_message,
      };
      break;
  }
  return {
    id: row.id,
    invocationId: row.invocation_id,
    resourceId: row.resource_id,
    producerId: row.producer_id,
    producerVersion: row.producer_version,
    inputVersion: row.input_version,
    dependencyFingerprint: row.dependency_fingerprint,
    dependencies,
    cacheHit: row.cache_hit === 1,
    output,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function sourceFromRow(row: SourceRow): ResourceSource {
  const boundary = parsedJson(row.boundary_json, "Resource source boundary");
  const policy = parsedJson(row.policy_json, "Resource source policy");
  const normalized = normalizeResourceSourceInput({
    name: row.name,
    provider: row.provider,
    boundary,
    policy,
  });
  const header = {
    id: normalizeResourceId(row.id, "Resource source ID"),
    name: normalized.name,
    version: row.version,
    policy: {
      deniedCapabilities: normalized.policy.deniedCapabilities,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  switch (normalized.provider) {
    case "filesystem":
      return {
        ...header,
        provider: "filesystem",
        boundary: { kind: "filesystem", root: normalized.boundary.root },
      };
    case "web":
      return {
        ...header,
        provider: "web",
        boundary: { kind: "web", baseUrl: normalized.boundary.baseUrl },
      };
    case "github":
      return {
        ...header,
        provider: "github",
        boundary: { kind: "github", ...normalized.boundary },
      };
    case "jira":
      return {
        ...header,
        provider: "jira",
        boundary: { kind: "jira", ...normalized.boundary },
      };
    case "linear":
      return {
        ...header,
        provider: "linear",
        boundary: { kind: "linear", ...normalized.boundary },
      };
    case "application":
      return {
        ...header,
        provider: "application",
        boundary: { kind: "application", ...normalized.boundary },
      };
    case "computed":
      return {
        ...header,
        provider: "computed",
        boundary: { kind: "computed", ...normalized.boundary },
      };
  }
}

function resourceFromRow(row: ResourceRow, source: ResourceSource): Resource {
  if (row.provider !== source.provider) {
    throw new ResourceCatalogError(
      "provider-mismatch",
      `Stored resource provider ${row.provider} does not match source ${source.provider}`,
    );
  }
  const normalized = normalizeResourceAddress(
    source,
    parsedJson(row.address_json, "Resource address"),
  );
  if (normalized.canonicalKey !== row.canonical_key) {
    throw new ResourceCatalogError(
      "invalid-input",
      `Stored resource canonical key is invalid: ${row.id}`,
    );
  }
  const header = {
    id: normalizeResourceId(row.id),
    sourceId: normalizeResourceId(row.source_id, "Resource source ID"),
    version: row.version,
    addressVersion: row.address_version,
    mediaType: row.media_type,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  switch (normalized.address.kind) {
    case "filesystem":
      return { ...header, provider: "filesystem", address: normalized.address };
    case "web":
      return { ...header, provider: "web", address: normalized.address };
    case "github":
      return { ...header, provider: "github", address: normalized.address };
    case "jira":
      return { ...header, provider: "jira", address: normalized.address };
    case "linear":
      return { ...header, provider: "linear", address: normalized.address };
    case "application":
      return { ...header, provider: "application", address: normalized.address };
    case "computed":
      return { ...header, provider: "computed", address: normalized.address };
  }
}

function filesystemRootBinding(root: string): string {
  try {
    const canonical = realpathSync(root);
    const stat = statSync(canonical, { bigint: true });
    if (!stat.isDirectory()) throw new Error("root is not a directory");
    return JSON.stringify({
      path: canonical,
      device: stat.dev.toString(),
      inode: stat.ino.toString(),
    });
  } catch (error) {
    throw new ResourceCatalogError(
      "source-unavailable",
      `Filesystem source root is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function assertFilesystemConfinement(
  source: Extract<ResourceSource, { provider: "filesystem" }>,
  rootBinding: string | null,
  address: Extract<ResourceAddress, { kind: "filesystem" }>,
): void {
  if (!rootBinding) {
    throw new ResourceCatalogError("source-unavailable", "Filesystem source has no root binding");
  }
  const currentBinding = filesystemRootBinding(source.boundary.root);
  if (currentBinding !== rootBinding) {
    throw new ResourceCatalogError(
      "source-unavailable",
      "Filesystem source root no longer resolves to its bound directory identity",
    );
  }
  const boundRoot = realpathSync(source.boundary.root);
  const candidate = join(boundRoot, ...address.path.split("/"));
  const fromRoot = relative(boundRoot, candidate);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new ResourceCatalogError(
      "outside-source",
      "Filesystem resource path cannot escape its source root",
    );
  }
  let current = boundRoot;
  for (const segment of address.path.split("/")) {
    if (segment === ".") continue;
    current = join(current, segment);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new ResourceCatalogError(
          "symlink-disallowed",
          `Filesystem resource path contains a symbolic link: ${segment}`,
        );
      }
      if (!stat.isDirectory() && current !== candidate) {
        throw new ResourceCatalogError(
          "outside-source",
          `Filesystem resource path descends through a non-directory: ${segment}`,
        );
      }
    } catch (error) {
      if (error instanceof ResourceCatalogError) throw error;
      if (
        typeof error === "object" && error !== null && "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      throw new ResourceCatalogError(
        "source-unavailable",
        `Filesystem resource prefix is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
function webEtag(response: Response): string | null {
  const value = response.headers.get("etag")?.trim();
  return value || null;
}

function webRevision(
  resource: Extract<Resource, { provider: "web" }>,
  etag: string | null,
  lastModified: string | null,
  sourceHash: string,
): ResourceRevisionRef {
  if (etag) {
    const weak = etag.startsWith("W/");
    const value = weak ? etag.slice(2) : etag;
    return {
      resourceId: resource.id,
      addressVersion: resource.addressVersion,
      revision: { kind: "web", validator: { kind: "etag", value, weak } },
    };
  }
  if (lastModified) {
    return {
      resourceId: resource.id,
      addressVersion: resource.addressVersion,
      revision: {
        kind: "web",
        validator: { kind: "last-modified", value: lastModified },
      },
    };
  }
  return {
    resourceId: resource.id,
    addressVersion: resource.addressVersion,
    revision: {
      kind: "web",
      validator: { kind: "content-hash", value: sourceHash },
    },
  };
}

function responseMediaType(response: Response): string {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}
async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Preserve the provider validation error when a body cannot be cancelled.
  }
}


function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function byteHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}


export class ResourceCatalog {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly webExtractor: WebMarkdownExtractor;
  private readonly pdfExtractor: PdfTextExtractor;
  private readonly remoteEntityClient: RemoteEntityProviderClient;
  private readonly computedProducerRegistry: ComputedProducerRegistry;
  private readonly now: () => string;
  private readonly maximumWebBytes: number;
  private readonly maximumPdfBytes: number;
  private readonly webStaleAfterMs: number;
  private readonly workspaceRoot: string;
  private readonly pendingWebRefreshes = new Map<string, Promise<ResourceDescription>>();
  private readonly pendingPdfRefreshes = new Map<string, Promise<ResourceDescription>>();
  private readonly pendingRemoteEntityRefreshes =
    new Map<string, Promise<ResourceDescription>>();
  readonly retention: ResourceRetentionRepository;

  constructor(
    private readonly database: Database,
    options: ResourceCatalogOptions = {},
  ) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.webExtractor = options.webExtractor ?? new BasicWebMarkdownExtractor();
    this.pdfExtractor = options.pdfExtractor ?? new PdfJsTextExtractor();
    this.now = options.now ?? (() => new Date().toISOString());
    this.remoteEntityClient = options.remoteEntityClient ??
      new DefaultRemoteEntityProviderClient({
        fetch: this.fetcher,
        resolveCredential: (name) => process.env[name],
        now: this.now,
      });
    this.computedProducerRegistry = options.computedProducerRegistry ??
      createDefaultComputedProducerRegistry();
    this.maximumWebBytes = options.maximumWebBytes ?? DEFAULT_MAXIMUM_WEB_BYTES;
    this.maximumPdfBytes = options.maximumPdfBytes ?? DEFAULT_MAXIMUM_PDF_BYTES;
    this.webStaleAfterMs = options.webStaleAfterMs ?? DEFAULT_WEB_STALE_AFTER_MS;
    this.workspaceRoot = resolve(options.workspaceRoot ?? ".");
    if (!Number.isFinite(this.webStaleAfterMs) || this.webStaleAfterMs < 0) {
      throw new ResourceCatalogError(
        "invalid-input",
        "Web stale age must be a non-negative finite number",
      );
    }
    this.migrate();
    this.retention = new ResourceRetentionRepository(this.database, {
      now: this.now,
      activeRepresentationAdapters: [
        this.webExtractor.adapter,
        this.pdfExtractor.adapter,
        PDF_NATIVE_ADAPTER,
        REMOTE_ENTITY_MARKDOWN_ADAPTER,
        COMPUTED_MARKDOWN_ADAPTER,
      ],
      markMutation: () => this.bumpSequence(),
    });
    this.recoverInterruptedWebRefreshes();
    this.recoverInterruptedRemoteEntityRefreshes();
    this.recoverInterruptedComputedExecutions();
  }

  createSource(value: unknown): ResourceSource {
    const input = normalizeResourceSourceInput(value);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const rootBinding = input.provider === "filesystem"
      ? filesystemRootBinding(input.boundary.root)
      : null;
    return this.database.transaction(() => {
      this.database.query(
        "INSERT INTO resource_sources (id, name, provider, boundary_json, policy_json, root_binding, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)",
      ).run(
        id,
        input.name,
        input.provider,
        JSON.stringify(input.boundary),
        JSON.stringify(input.policy ?? { deniedCapabilities: [] }),
        rootBinding,
        now,
        now,
      );
      this.bumpSequence();
      return this.requireSourceFromCurrentRead(id);
    })();
  }

  listSources(): ResourceSource[] {
    return this.database.transaction(() =>
      (this.database.query(
        "SELECT id, name, provider, boundary_json, policy_json, root_binding, version, created_at, updated_at FROM resource_sources ORDER BY name, id",
      ).all() as SourceRow[]).map(sourceFromRow)
    )();
  }

  getSource(sourceId: string): ResourceSource | null {
    const normalized = normalizeResourceId(sourceId, "Resource source ID");
    return this.database.transaction(() => this.getSourceFromCurrentRead(normalized))();
  }

  requireSource(sourceId: string): ResourceSource {
    const normalized = normalizeResourceId(sourceId, "Resource source ID");
    return this.database.transaction(() => this.requireSourceFromCurrentRead(normalized))();
  }

  createComputedInvocation(value: CreateComputedInvocationInput): ComputedInvocation {
    const input = parseComputedInvocationInput(value);
    const sourceId = normalizeResourceId(input.sourceId, "Resource source ID");
    const definition = this.computedProducerRegistry.require(input.producerId);
    this.computedProducerRegistry.validateInputs(definition, input.inputs);
    const declaration = this.computedProducerRegistry.snapshot(
      definition.id,
      definition.version,
    );
    return this.database.transaction(() => {
      const source = this.requireSourceFromCurrentRead(sourceId);
      if (source.provider !== "computed") {
        throw new ResourceCatalogError(
          "provider-mismatch",
          "Computed invocation source must use the computed provider",
        );
      }
      const dependencies = this.normalizeComputedDependenciesFromCurrentRead(
        input.dependencies,
      );
      const invocationId = crypto.randomUUID();
      const resourceId = crypto.randomUUID();
      const now = this.now();
      this.database.query(`
        INSERT INTO resources (
          id, source_id, provider, address_json, canonical_key, media_type,
          address_version, version, created_at, updated_at
        ) VALUES (?, ?, 'computed', ?, ?, NULL, 1, 1, ?, ?)
      `).run(
        resourceId,
        source.id,
        canonicalJson({ kind: "computed", invocationId }),
        invocationId,
        now,
        now,
      );
      this.database.query(`
        INSERT INTO computed_invocations (
          id, resource_id, source_id, producer_id, producer_version, input_version,
          inputs_json, dependencies_json, declaration_json, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, 1, ?, ?)
      `).run(
        invocationId,
        resourceId,
        source.id,
        definition.id,
        definition.version,
        canonicalJson(input.inputs),
        canonicalJson(dependencies),
        canonicalJson(declaration),
        now,
        now,
      );
      this.database.query(`
        INSERT INTO computed_resource_state (
          resource_id, invocation_id, generation, status, selected_execution_id,
          representation_id, durable_resource_id, last_failure_execution_id,
          started_at, completed_at
        ) VALUES (?, ?, 1, 'idle', NULL, NULL, NULL, NULL, NULL, NULL)
      `).run(resourceId, invocationId);
      this.bumpSequence();
      return this.requireComputedInvocationFromCurrentRead(invocationId);
    })();
  }

  reviseComputedInvocation(value: ReviseComputedInvocationInput): ComputedInvocation {
    const input = parseComputedInvocationRevision(value);
    const invocationId = normalizeResourceId(input.invocationId, "Computed invocation ID");
    return this.database.transaction(() => {
      const current = this.requireComputedInvocationFromCurrentRead(invocationId);
      if (current.version !== input.expectedVersion) {
        throw new ResourceCatalogError(
          "version-conflict",
          `Computed invocation version conflict: expected ${input.expectedVersion}, found ${current.version}`,
        );
      }
      const definition = this.computedProducerRegistry.require(
        current.producerId,
        current.producerVersion,
      );
      const inputs = input.inputs ?? current.inputs;
      this.computedProducerRegistry.validateInputs(definition, inputs);
      const dependencies = input.dependencies === undefined
        ? current.dependencies
        : this.normalizeComputedDependenciesFromCurrentRead(input.dependencies);
      const inputsChanged = canonicalJson(inputs) !== canonicalJson(current.inputs);
      const now = this.now();
      const update = this.database.query(`
        UPDATE computed_invocations
        SET inputs_json = ?,
            dependencies_json = ?,
            input_version = input_version + ?,
            version = version + 1,
            updated_at = ?
        WHERE id = ? AND version = ?
      `).run(
        canonicalJson(inputs),
        canonicalJson(dependencies),
        inputsChanged ? 1 : 0,
        now,
        invocationId,
        input.expectedVersion,
      );
      if (update.changes !== 1) {
        throw new ResourceCatalogError(
          "version-conflict",
          "Computed invocation changed during revision",
        );
      }
      this.database.query(
        "UPDATE resources SET version = version + 1, updated_at = ? WHERE id = ?",
      ).run(now, current.resourceId);
      this.database.query(`
        UPDATE computed_resource_state
        SET generation = generation + 1,
            status = 'idle',
            selected_execution_id = NULL,
            representation_id = NULL,
            durable_resource_id = NULL,
            last_failure_execution_id = NULL,
            started_at = NULL,
            completed_at = NULL
        WHERE resource_id = ?
      `).run(current.resourceId);
      this.bumpSequence();
      return this.requireComputedInvocationFromCurrentRead(invocationId);
    })();
  }

  resolveComputedHandler(reference: string): ComputedHandlerResolution | null {
    const match =
      /^producer:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i
        .exec(reference);
    if (!match?.[1]) return null;
    const invocationId = normalizeResourceId(match[1], "Computed invocation ID");
    return this.database.transaction(() => {
      const row = this.computedInvocationRowFromCurrentRead(invocationId);
      if (!row) return null;
      return {
        reference: `producer:${invocationId}`,
        invocationId,
        resourceId: row.resource_id,
        producerId: row.producer_id,
        producerVersion: row.producer_version,
      };
    })();
  }

  computedExecutionHistory(resourceId: string): ComputedExecutionHistory {
    const normalized = normalizeResourceId(resourceId);
    return this.database.transaction(() => {
      const resource = this.requireFromCurrentRead(normalized);
      if (resource.provider !== "computed") {
        throw new ResourceCatalogError(
          "provider-mismatch",
          "Computed execution history requires a computed Resource",
        );
      }
      const executions = this.database.query(`
        SELECT id, invocation_id, resource_id, generation, producer_id,
               producer_version, input_version, dependency_fingerprint,
               dependencies_json, cache_hit, status, output_kind, media_type,
               output_content_hash, representation_id, durable_resource_id,
               failure_code, failure_message, started_at, completed_at
        FROM computed_executions
        WHERE resource_id = ? AND status != 'executing'
        ORDER BY started_at, id
      `).all(normalized) as ComputedExecutionRow[];
      return {
        resourceId: normalized,
        executions: executions.map(computedExecutionRecordFromRow),
      };
    })();
  }

  executeComputedResource(
    resourceId: string,
    destinationHostRegistered: boolean,
  ): Promise<ComputedExecutionReceipt> {
    return this.performComputedExecution(
      normalizeResourceId(resourceId),
      destinationHostRegistered,
    );
  }

  intern(value: unknown): InternResourceReceipt {
    const identity = parseInternIdentity(value);
    const sourceId = normalizeResourceId(identity.sourceId, "Resource source ID");
    return this.database.transaction(() => {
      const sourceRow = this.requireSourceRowFromCurrentRead(sourceId);
      const source = sourceFromRow(sourceRow);
      if (source.provider === "computed") {
        throw new ResourceCatalogError(
          "invalid-input",
          "Computed Resources must be created through a registered producer invocation",
        );
      }
      const normalized = normalizeInternResourceInput(value, source);
      this.assertConfinement(source, sourceRow.root_binding, normalized.address);
      const existing = this.resourceRowByKeyFromCurrentRead(source.id, normalized.canonicalKey);
      if (existing) return { resource: resourceFromRow(existing, source), created: false };
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      this.database.query(
        "INSERT INTO resources (id, source_id, provider, address_json, canonical_key, media_type, address_version, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)",
      ).run(
        id,
        source.id,
        source.provider,
        JSON.stringify(normalized.address),
        normalized.canonicalKey,
        normalized.mediaType ?? null,
        now,
        now,
      );
      this.bumpSequence();
      return { resource: this.requireFromCurrentRead(id), created: true };
    })();
  }
  internFilesystem(value: InternFilesystemResourceInput): InternResourceReceipt {
    if (!value || typeof value !== "object") {
      throw new ResourceCatalogError("invalid-input", "Filesystem resource input must be an object");
    }
    if (typeof value.path !== "string" || !value.path.trim()) {
      throw new ResourceCatalogError("invalid-input", "Filesystem resource path cannot be empty");
    }
    const absolutePath = resolve(this.workspaceRoot, value.path);
    try {
      if (!statSync(absolutePath).isFile()) {
        throw new ResourceCatalogError("invalid-input", "Filesystem resource must be a regular file");
      }
    } catch (error) {
      if (error instanceof ResourceCatalogError) throw error;
      throw new ResourceCatalogError(
        "source-unavailable",
        `Filesystem resource is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const candidates = this.listSources()
      .filter((source): source is Extract<ResourceSource, { provider: "filesystem" }> =>
        source.provider === "filesystem"
      )
      .filter((source) => {
        const pathFromRoot = relative(source.boundary.root, absolutePath);
        return pathFromRoot !== ".." &&
          !pathFromRoot.startsWith(`..${sep}`) &&
          !isAbsolute(pathFromRoot);
      })
      .sort((left, right) =>
        right.boundary.root.length - left.boundary.root.length ||
        left.id.localeCompare(right.id)
      );
    const source = candidates[0] ?? this.createSource({
      name: `Filesystem · ${basename(dirname(absolutePath)) || dirname(absolutePath)}`,
      provider: "filesystem",
      boundary: { root: dirname(absolutePath) },
      policy: { deniedCapabilities: [] },
    });
    if (source.provider !== "filesystem") {
      throw new ResourceCatalogError("provider-mismatch", "Filesystem source interning failed");
    }
    return this.intern({
      sourceId: source.id,
      address: {
        kind: "filesystem",
        path: relative(source.boundary.root, absolutePath).replaceAll(sep, "/"),
      },
      mediaType: value.mediaType ?? (/\.pdf$/i.test(absolutePath) ? "application/pdf" : undefined),
    });
  }

  get(resourceId: string): Resource | null {
    const normalized = normalizeResourceId(resourceId);
    return this.database.transaction(() => this.getFromCurrentRead(normalized))();
  }

  require(resourceId: string): Resource {
    const normalized = normalizeResourceId(resourceId);
    return this.database.transaction(() => this.requireFromCurrentRead(normalized))();
  }

  find(sourceId: string, address: unknown): Resource | null {
    const normalizedSourceId = normalizeResourceId(sourceId, "Resource source ID");
    return this.database.transaction(() => {
      const sourceRow = this.requireSourceRowFromCurrentRead(normalizedSourceId);
      const source = sourceFromRow(sourceRow);
      const normalized = normalizeResourceAddress(source, address);
      this.assertConfinement(source, sourceRow.root_binding, normalized.address);
      const row = this.resourceRowByKeyFromCurrentRead(source.id, normalized.canonicalKey);
      return row ? resourceFromRow(row, source) : null;
    })();
  }

  relocate(value: unknown): Resource {
    const identity = parseRelocationIdentity(value);
    const resourceId = normalizeResourceId(identity.resourceId);
    const destinationSourceId = normalizeResourceId(
      identity.destinationSourceId,
      "Destination source ID",
    );
    return this.database.transaction(() => {
      const resource = this.requireFromCurrentRead(resourceId);
      const destinationRow = this.requireSourceRowFromCurrentRead(destinationSourceId);
      const destination = sourceFromRow(destinationRow);
      const normalized = normalizeRelocateResourceInput(value, resource, destination);
      if (resource.version !== normalized.expectedVersion) {
        throw new ResourceCatalogError(
          "version-conflict",
          `Resource version conflict: expected ${normalized.expectedVersion}, found ${resource.version}`,
        );
      }
      this.assertConfinement(destination, destinationRow.root_binding, normalized.address);
      const occupying = this.resourceRowByKeyFromCurrentRead(
        destination.id,
        normalized.canonicalKey,
      );
      if (occupying && occupying.id !== resource.id) {
        throw new ResourceCatalogError(
          "address-conflict",
          `Resource address is already occupied in source ${destination.id}`,
        );
      }
      this.database.query(
        "UPDATE resources SET source_id = ?, provider = ?, address_json = ?, canonical_key = ?, address_version = address_version + 1, version = version + 1, updated_at = ? WHERE id = ? AND version = ?",
      ).run(
        destination.id,
        destination.provider,
        JSON.stringify(normalized.address),
        normalized.canonicalKey,
        new Date().toISOString(),
        resource.id,
        normalized.expectedVersion,
      );
      const relocated = this.requireFromCurrentRead(resource.id);
      if (relocated.provider === "web") {
        this.database.query(`
          INSERT INTO web_resource_state (
            resource_id, address_version, generation, source_snapshot_id,
            representation_id, freshness, checked_at, last_error
          ) VALUES (?, ?, 1, NULL, NULL, 'unknown', NULL, NULL)
          ON CONFLICT(resource_id) DO UPDATE SET
            address_version = excluded.address_version,
            generation = web_resource_state.generation + 1,
            source_snapshot_id = NULL,
            representation_id = NULL,
            freshness = 'unknown',
            checked_at = NULL,
            last_error = NULL
        `).run(resource.id, relocated.addressVersion);
      }
      if (relocated.provider === "jira" || relocated.provider === "linear") {
        this.database.query(`
          INSERT INTO remote_entity_resource_state (
            resource_id, address_version, generation, source_snapshot_id,
            representation_id, freshness, checked_at, last_error
          ) VALUES (?, ?, 1, NULL, NULL, 'unknown', NULL, NULL)
          ON CONFLICT(resource_id) DO UPDATE SET
            address_version = excluded.address_version,
            generation = remote_entity_resource_state.generation + 1,
            source_snapshot_id = NULL,
            representation_id = NULL,
            freshness = 'unknown',
            checked_at = NULL,
            last_error = NULL
        `).run(resource.id, relocated.addressVersion);
      }
      if (relocated.provider === "computed") {
        const now = this.now();
        this.database.query(`
          UPDATE computed_invocations
          SET source_id = ?, version = version + 1, updated_at = ?
          WHERE resource_id = ?
        `).run(destination.id, now, resource.id);
        this.database.query(`
          UPDATE computed_resource_state
          SET generation = generation + 1,
              status = 'idle',
              selected_execution_id = NULL,
              representation_id = NULL,
              durable_resource_id = NULL,
              last_failure_execution_id = NULL,
              started_at = NULL,
              completed_at = NULL
          WHERE resource_id = ?
        `).run(resource.id);
      }
      if (relocated.mediaType === "application/pdf") {
        this.database.query(`
          INSERT INTO pdf_resource_state (
            resource_id, address_version, generation, source_snapshot_id, representation_id
          ) VALUES (?, ?, 1, NULL, NULL)
          ON CONFLICT(resource_id) DO UPDATE SET
            address_version = excluded.address_version,
            generation = pdf_resource_state.generation + 1,
            source_snapshot_id = NULL,
            representation_id = NULL
        `).run(resource.id, relocated.addressVersion);
      }
      this.bumpSequence();
      return this.requireFromCurrentRead(resource.id);
    })();
  }

  private filesystemReadFromCurrentRead(
    resource: Resource,
    source: ResourceSource,
    requestedRevision: ResourceRevisionRef | null,
  ): FilesystemResourceDocument {
    if (
      resource.provider !== "filesystem" ||
      source.provider !== "filesystem" ||
      resource.address.kind !== "filesystem"
    ) {
      throw new ResourceCatalogError(
        "provider-mismatch",
        "Filesystem resource identity is inconsistent",
      );
    }
    const sourceRow = this.requireSourceRowFromCurrentRead(source.id);
    this.assertConfinement(source, sourceRow.root_binding, resource.address);
    const absolutePath = resolve(source.boundary.root, resource.address.path);
    let stat: BigIntStats;
    try {
      stat = statSync(absolutePath, { bigint: true });
    } catch {
      throw new ResourceCatalogError("source-unavailable", "Filesystem Resource is unavailable");
    }
    if (!stat.isFile()) {
      throw new ResourceCatalogError("source-unavailable", "Filesystem Resource is not a regular file");
    }
    if (stat.size > BigInt(MAX_FILESYSTEM_RESOURCE_BYTES)) {
      throw new ResourceCatalogError(
        "source-unavailable",
        `Filesystem Resource exceeds ${MAX_FILESYSTEM_RESOURCE_BYTES / 1024 / 1024} MiB`,
      );
    }
    const revision: ResourceRevisionRef = {
      resourceId: resource.id,
      addressVersion: resource.addressVersion,
      revision: {
        kind: "filesystem",
        mtimeNs: stat.mtimeNs.toString(),
        size: stat.size.toString(),
      },
    };
    if (requestedRevision && !resourceRevisionRefEquals(requestedRevision, revision)) {
      throw new ResourceCatalogError("stale-revision", "Filesystem Resource revision is unavailable");
    }
    let text: string;
    try {
      text = readFileSync(absolutePath, "utf8");
    } catch {
      throw new ResourceCatalogError("source-unavailable", "Filesystem Resource is unreadable");
    }
    return {
      text,
      contentHash: sha256(text),
      capturedAt: new Date(Number(stat.mtimeMs)).toISOString(),
      revision,
    };
  }

  private pdfStateFromCurrentRead(resourceId: string): PdfResourceStateRow | null {
    return this.database.query(
      "SELECT * FROM pdf_resource_state WHERE resource_id = ?",
    ).get(resourceId) as PdfResourceStateRow | null;
  }

  private pdfSnapshotProvenance(row: PdfSourceSnapshotRow): PdfSourceSnapshotProvenance {
    return {
      id: row.id,
      resourceId: row.resource_id,
      addressVersion: row.address_version,
      locator: row.locator,
      contentHash: row.content_hash,
      revision: normalizeRetainedResourceRevisionRef(
        parsedJson(row.revision_json, "PDF source snapshot revision"),
      ),
      capturedAt: row.captured_at,
      bytesAvailable: row.payload_state === "available" && row.bytes !== null,
      evictedAt: row.evicted_at,
    };
  }

  private pdfRepresentationProvenance(
    row: PdfRepresentationRow,
  ): PdfRepresentationProvenance {
    return {
      id: row.id,
      sourceSnapshotId: row.source_snapshot_id,
      mediaType: row.media_type,
      adapter: { id: row.adapter_id, version: row.adapter_version },
      contentHash: row.content_hash,
      derivedAt: row.derived_at,
      contentAvailable: row.payload_state === "available" &&
        (
          row.media_type === "application/pdf" ||
          row.markdown !== null && row.pages_json !== null
        ),
      evictedAt: row.evicted_at,
    };
  }
  private pdfReadFromCurrentRead(
    resource: Resource,
    requestedRevision: ResourceRevisionRef | null,
  ): { document: PdfResourceDocument | null; history: PdfResourceHistory } {
    const snapshots = this.database.query(`
      SELECT *
      FROM pdf_source_snapshots
      WHERE resource_id = ? AND address_version = ?
      ORDER BY captured_at DESC, id DESC
    `).all(resource.id, resource.addressVersion) as PdfSourceSnapshotRow[];
    const representations = this.database.query(`
      SELECT representation.*
      FROM pdf_representations representation
      JOIN pdf_source_snapshots snapshot
        ON snapshot.id = representation.source_snapshot_id
      WHERE snapshot.resource_id = ? AND snapshot.address_version = ?
      ORDER BY representation.derived_at DESC, representation.id DESC
    `).all(resource.id, resource.addressVersion) as PdfRepresentationRow[];
    const history = {
      sourceSnapshots: snapshots.map((row) => this.pdfSnapshotProvenance(row)),
      representations: representations.map((row) => this.pdfRepresentationProvenance(row)),
    };
    let snapshot: PdfSourceSnapshotRow | null = null;
    if (requestedRevision) {
      snapshot = snapshots.find((candidate) =>
        resourceRevisionRefEquals(
          normalizeRetainedResourceRevisionRef(
            parsedJson(candidate.revision_json, "PDF source snapshot revision"),
          ),
          requestedRevision,
        )
      ) ?? null;
      if (!snapshot) {
        throw new ResourceCatalogError("stale-revision", "PDF Resource revision is unavailable");
      }
    } else {
      const state = this.pdfStateFromCurrentRead(resource.id);
      if (state?.address_version === resource.addressVersion && state.source_snapshot_id) {
        snapshot = snapshots.find(({ id }) => id === state.source_snapshot_id) ?? null;
      }
    }
    if (
      !snapshot ||
      snapshot.payload_state !== "available" ||
      snapshot.bytes === null
    ) return { document: null, history };
    const textRepresentation = representations.find((candidate) =>
      candidate.source_snapshot_id === snapshot!.id &&
      candidate.media_type === "text/markdown" &&
      candidate.payload_state === "available" &&
      candidate.adapter_id === this.pdfExtractor.adapter.id &&
      candidate.adapter_version === this.pdfExtractor.adapter.version &&
      candidate.markdown !== null &&
      candidate.pages_json !== null
    ) ?? representations.find((candidate) =>
      candidate.source_snapshot_id === snapshot!.id &&
      candidate.payload_state === "available" &&
      candidate.media_type === "text/markdown" &&
      candidate.markdown !== null &&
      candidate.pages_json !== null
    ) ?? null;
    const nativeRepresentation = representations.find((candidate) =>
      candidate.source_snapshot_id === snapshot!.id &&
      candidate.media_type === "application/pdf"
    ) ?? null;
    if (
      !textRepresentation ||
      !nativeRepresentation ||
      textRepresentation.markdown === null ||
      textRepresentation.pages_json === null
    ) {
      return { document: null, history };
    }
    const pages = parsedJson(
      textRepresentation.pages_json,
      "PDF text representation pages",
    );
    if (!Array.isArray(pages)) {
      throw new ResourceCatalogError("source-unavailable", "PDF page map is invalid");
    }
    return {
      document: {
        markdown: textRepresentation.markdown,
        pages: pages as PdfPageText[],
        sourceSnapshot: this.pdfSnapshotProvenance(snapshot),
        representation: this.pdfRepresentationProvenance(textRepresentation),
        nativeRepresentation: this.pdfRepresentationProvenance(nativeRepresentation),
      },
      history,
    };
  }

  private pdfActiveRepresentationAvailable(sourceSnapshotId: string): boolean {
    return this.database.query(`
      SELECT 1
      FROM pdf_representations text
      WHERE text.source_snapshot_id = ? AND text.media_type = 'text/markdown'
        AND text.adapter_id = ? AND text.adapter_version = ?
        AND text.markdown IS NOT NULL AND text.pages_json IS NOT NULL
        AND text.payload_state = 'available'
        AND EXISTS (
          SELECT 1 FROM pdf_representations native
          WHERE native.source_snapshot_id = text.source_snapshot_id
            AND native.media_type = 'application/pdf'
            AND native.payload_state = 'available'
        )
      LIMIT 1
    `).get(
      sourceSnapshotId,
      this.pdfExtractor.adapter.id,
      this.pdfExtractor.adapter.version,
    ) !== null;
  }

  private remoteEntityStateFromCurrentRead(
    resourceId: string,
  ): RemoteEntityResourceStateRow | null {
    return this.database.query(`
      SELECT resource_id, address_version, generation, source_snapshot_id,
             representation_id, freshness, checked_at, last_error
      FROM remote_entity_resource_state
      WHERE resource_id = ?
    `).get(resourceId) as RemoteEntityResourceStateRow | null;
  }

  private remoteEntityStatusFromCurrentRead(
    resource: Extract<Resource, { provider: RemoteEntityProvider }>,
  ): WebResourceStatus {
    const state = this.remoteEntityStateFromCurrentRead(resource.id);
    if (!state || state.address_version !== resource.addressVersion) {
      return { freshness: "unknown", checkedAt: null, lastError: null };
    }
    return {
      freshness: state.freshness,
      checkedAt: state.checked_at,
      lastError: state.last_error,
    };
  }

  private remoteEntityReadFromCurrentRead(
    resource: Extract<Resource, { provider: RemoteEntityProvider }>,
    requestedRevision: ResourceRevisionRef | null,
  ): RemoteEntityDocument | null {
    let snapshot: RemoteEntitySourceSnapshotRow | null;
    let representation: RemoteEntityRepresentationRow | null = null;
    if (requestedRevision) {
      snapshot = this.database.query(`
        SELECT id, resource_id, address_version, provider, entity_id, revision_json,
               payload_json, captured_at, payload_state, payload_bytes, evicted_at
        FROM remote_entity_source_snapshots
        WHERE resource_id = ? AND address_version = ? AND revision_json = ?
        ORDER BY captured_at DESC, id DESC
        LIMIT 1
      `).get(
        resource.id,
        requestedRevision.addressVersion,
        JSON.stringify(requestedRevision),
      ) as RemoteEntitySourceSnapshotRow | null;
      if (snapshot) {
        representation = this.database.query(`
          SELECT id, source_snapshot_id, media_type, adapter_id, version, content_hash,
                 markdown, derived_at, payload_state, payload_bytes, evicted_at
          FROM remote_entity_representations
          WHERE source_snapshot_id = ?
          ORDER BY derived_at DESC, id DESC
          LIMIT 1
        `).get(snapshot.id) as RemoteEntityRepresentationRow | null;
      }
    } else {
      const state = this.remoteEntityStateFromCurrentRead(resource.id);
      if (
        !state ||
        state.address_version !== resource.addressVersion ||
        !state.source_snapshot_id ||
        !state.representation_id
      ) return null;
      snapshot = this.database.query(`
        SELECT id, resource_id, address_version, provider, entity_id, revision_json,
               payload_json, captured_at, payload_state, payload_bytes, evicted_at
        FROM remote_entity_source_snapshots
        WHERE id = ?
      `).get(state.source_snapshot_id) as RemoteEntitySourceSnapshotRow | null;
      representation = this.database.query(`
        SELECT id, source_snapshot_id, media_type, adapter_id, version, content_hash,
               markdown, derived_at, payload_state, payload_bytes, evicted_at
        FROM remote_entity_representations
        WHERE id = ?
      `).get(state.representation_id) as RemoteEntityRepresentationRow | null;
    }
    if (
      !snapshot ||
      snapshot.provider !== resource.provider ||
      snapshot.entity_id !== resource.address.entityId ||
      snapshot.payload_state !== "available" ||
      snapshot.payload_json === null ||
      !representation ||
      representation.source_snapshot_id !== snapshot.id ||
      representation.payload_state !== "available" ||
      representation.markdown === null
    ) return null;
    const payload = parseRemoteEntitySnapshotPayload(
      parsedJson(snapshot.payload_json, "Remote entity snapshot payload"),
    );
    const revision = normalizeResourceRevisionRef(
      parsedJson(snapshot.revision_json, "Remote entity snapshot revision"),
      resource,
    );
    return {
      title: payload.title,
      metadata: payload.metadata,
      markdown: representation.markdown,
      externalUrl: payload.externalUrl,
      sourceSnapshot: {
        provider: snapshot.provider,
        resourceId: snapshot.resource_id,
        addressVersion: snapshot.address_version,
        entityId: snapshot.entity_id,
        locator: payload.locator,
        contentHash: payload.contentHash,
        revision,
        fetchedAt: snapshot.captured_at,
      },
      representation: {
        mediaType: representation.media_type,
        adapter: {
          id: representation.adapter_id,
          version: representation.version,
        },
        contentHash: representation.content_hash,
        derivedAt: representation.derived_at,
      },
      commandDescriptors: payload.commandDescriptors,
    };
  }

  describe(
    resourceId: string,
    destinationHostRegistered: boolean,
    revision?: unknown,
  ): ResourceDescription {
    return this.database.transaction(() => {
      const resource = this.requireFromCurrentRead(normalizeResourceId(resourceId));
      const source = this.requireSourceFromCurrentRead(resource.sourceId);
      const requestedRevision: ResourceRevisionRef | null = revision === undefined
        ? null
        : normalizeResourceRevisionRef(revision, resource);
      const readingDenied = source.policy.deniedCapabilities.includes("read");
      let filesystem: FilesystemResourceDocument | null = null;
      if (
        resource.provider === "filesystem" &&
        resource.mediaType !== "application/pdf" &&
        !readingDenied
      ) {
        try {
          filesystem = this.filesystemReadFromCurrentRead(resource, source, requestedRevision);
        } catch (error) {
          if (
            requestedRevision ||
            !(error instanceof ResourceCatalogError) ||
            error.code !== "source-unavailable"
          ) throw error;
        }
      }
      const pdfRead = resource.mediaType === "application/pdf" && !readingDenied
        ? this.pdfReadFromCurrentRead(resource, requestedRevision)
        : null;
      const webRead =
        resource.provider === "web" &&
          resource.mediaType !== "application/pdf" &&
          !readingDenied
          ? this.webReadFromCurrentRead(resource, requestedRevision)
          : null;
      const capabilities = deriveResourceCapabilityReport(
        source,
        destinationHostRegistered,
        resource.provider === "web"
          ? ["read", "refresh", "open-external"]
          : resource.provider === "filesystem"
            ? ["read"]
            : resource.provider === "jira" || resource.provider === "linear"
              ? ["read", "refresh", "open-external", "command"]
              : resource.provider === "computed"
                ? ["read", "refresh", "history"]
                : [],
      );
      const remoteEntity =
        (resource.provider === "jira" || resource.provider === "linear") &&
          !readingDenied
          ? this.remoteEntityReadFromCurrentRead(resource, requestedRevision)
          : null;
      const remoteStatus =
        resource.provider === "jira" || resource.provider === "linear"
          ? this.remoteEntityStatusFromCurrentRead(resource)
          : null;
      const computedRead = resource.provider === "computed"
        ? this.computedDescriptionFromCurrentRead(resource, requestedRevision)
        : null;
      return {
        resource,
        source,
        requestedRevision,
        capabilities,
        filesystem,
        pdf: pdfRead?.document ?? null,
        pdfHistory: pdfRead?.history ?? null,
        web: webRead?.document ?? null,
        webHistory: webRead?.history ?? null,
        webStatus: resource.provider === "web"
          ? this.webStatusFromCurrentRead(resource)
          : null,
        remoteEntity,
        remoteStatus,
        ...(remoteStatus?.lastError ? { remoteError: remoteStatus.lastError } : {}),
        computed: readingDenied ? null : computedRead?.document ?? null,
        computedStatus: computedRead?.status ?? null,
        computedFailure: computedRead?.failure ?? null,
        availableCommands:
          capabilities.command.status === "available" &&
            requestedRevision === null
            ? remoteEntity?.commandDescriptors ?? []
            : [],
      };
    })();
  }

  async open(
    resourceId: string,
    destinationHostRegistered: boolean,
    revision?: unknown,
  ): Promise<ResourceDescription> {
    const resource = this.require(resourceId);
    if (resource.mediaType === "application/pdf" && revision === undefined) {
      const source = this.requireSource(resource.sourceId);
      if (source.policy.deniedCapabilities.includes("read")) {
        return {
          ...this.describe(resource.id, destinationHostRegistered),
          pdfError: "Workspace policy denies reading this PDF Resource",
        };
      }
      try {
        await this.derivePdfFromRetained(resource.id, destinationHostRegistered);
      } catch (error) {
        const cached = this.describe(resource.id, destinationHostRegistered);
        if (!cached.pdf) throw error;
        return { ...cached, pdfError: errorText(error) };
      }
      if (resource.provider === "filesystem") {
        return this.refreshPdf(resource.id, destinationHostRegistered);
      }
    }
    const description = this.describe(resource.id, destinationHostRegistered, revision);
    if (
      description.resource.provider === "web" &&
      description.source.policy.deniedCapabilities.includes("read")
    ) {
      return { ...description, webError: "Workspace policy denies reading this resource" };
    }
    return description;
  }

  async refresh(
    resourceId: string,
    destinationHostRegistered: boolean,
  ): Promise<ResourceDescription> {
    const resource = this.require(resourceId);
    if (resource.provider === "computed") {
      await this.executeComputedResource(resource.id, destinationHostRegistered);
      return this.describe(resource.id, destinationHostRegistered);
    }
    if (resource.provider === "jira" || resource.provider === "linear") {
      return this.refreshRemoteEntity(resource.id, destinationHostRegistered);
    }
    if (resource.provider === "web" || resource.mediaType === "application/pdf") {
      return this.refreshWeb(resource.id, destinationHostRegistered);
    }
    throw new ResourceCatalogError(
      "provider-mismatch",
      `${resource.provider} Resources do not support explicit refresh`,
    );
  }

  refreshWeb(
    resourceId: string,
    destinationHostRegistered: boolean,
  ): Promise<ResourceDescription> {
    const resource = this.require(resourceId);
    if (resource.mediaType === "application/pdf") {
      return this.refreshPdf(resource.id, destinationHostRegistered);
    }
    const normalized = normalizeResourceId(resourceId);
    const pending = this.pendingWebRefreshes.get(normalized);
    if (pending) return pending;
    const refresh = this.performWebRefresh(normalized, destinationHostRegistered)
      .finally(() => this.pendingWebRefreshes.delete(normalized));
    this.pendingWebRefreshes.set(normalized, refresh);
    return refresh;
  }

  refreshPdf(
    resourceId: string,
    destinationHostRegistered: boolean,
  ): Promise<ResourceDescription> {
    const normalized = normalizeResourceId(resourceId);
    const { resource, source } = this.database.transaction(() => {
      const resource = this.requireFromCurrentRead(normalized);
      return {
        resource,
        source: this.requireSourceFromCurrentRead(resource.sourceId),
      };
    })();
    if (
      source.policy.deniedCapabilities.includes("read") ||
      source.policy.deniedCapabilities.includes("refresh")
    ) {
      throw new ResourceCatalogError(
        "invalid-input",
        "Workspace policy denies reading or refreshing this PDF Resource",
      );
    }
    const pending = this.pendingPdfRefreshes.get(normalized);
    if (pending) return pending;
    const refresh = this.performPdfRefresh(normalized, destinationHostRegistered)
      .catch((error) =>
        this.pdfRefreshFailure(resource, destinationHostRegistered, error)
      )
      .finally(() => this.pendingPdfRefreshes.delete(normalized));
    this.pendingPdfRefreshes.set(normalized, refresh);
    return refresh;
  }

  refreshRemoteEntity(
    resourceId: string,
    destinationHostRegistered: boolean,
  ): Promise<ResourceDescription> {
    const normalized = normalizeResourceId(resourceId);
    const resource = this.require(normalized);
    if (resource.provider !== "jira" && resource.provider !== "linear") {
      throw new ResourceCatalogError(
        "provider-mismatch",
        "Remote entity refresh requires a Jira or Linear Resource",
      );
    }
    const source = this.requireSource(resource.sourceId);
    if (
      source.policy.deniedCapabilities.includes("read") ||
      source.policy.deniedCapabilities.includes("refresh")
    ) {
      throw new ResourceCatalogError(
        "invalid-input",
        "Workspace policy denies reading or refreshing this remote entity",
      );
    }
    const pending = this.pendingRemoteEntityRefreshes.get(normalized);
    if (pending) return pending;
    const refresh = this.performRemoteEntityRefresh(
      resource,
      destinationHostRegistered,
    ).catch((error) => {
      const failed = this.remoteEntityRefreshFailure(
        resource,
        destinationHostRegistered,
        error,
      );
      if (
        error instanceof ResourceCatalogError &&
        (error.code === "provider-mismatch" || error.code === "version-conflict")
      ) throw error;
      return failed;
    }).finally(() => this.pendingRemoteEntityRefreshes.delete(normalized));
    this.pendingRemoteEntityRefreshes.set(normalized, refresh);
    return refresh;
  }

  async executeRemoteEntityCommand(
    resourceId: string,
    input: ResourceProviderCommandInput,
  ): Promise<ResourceProviderCommandReceipt> {
    const normalized = normalizeResourceId(resourceId);
    const { resource, source, commands } = this.database.transaction(() => {
      const resource = this.requireFromCurrentRead(normalized);
      const source = this.requireSourceFromCurrentRead(resource.sourceId);
      if (
        (resource.provider !== "jira" && resource.provider !== "linear") ||
        (source.provider !== "jira" && source.provider !== "linear")
      ) {
        throw new ResourceCatalogError(
          "provider-mismatch",
          "Resource provider commands require a Jira or Linear Resource",
        );
      }
      if (resource.provider !== source.provider || input.provider !== resource.provider) {
        throw new ResourceCatalogError(
          "provider-mismatch",
          "Resource provider command does not match the resolved Resource",
        );
      }
      if (source.policy.deniedCapabilities.includes("command")) {
        throw new ResourceCatalogError(
          "invalid-input",
          "Workspace policy denies this Resource provider command",
        );
      }
      const document = this.remoteEntityReadFromCurrentRead(resource, null);
      return {
        resource,
        source,
        commands: document?.commandDescriptors ?? [],
      };
    })();
    if (
      !commands.some((descriptor) =>
        descriptor.provider === input.provider &&
        descriptor.command === input.command
      )
    ) {
      throw new ResourceCatalogError(
        "invalid-input",
        "Resource provider command is not available for this entity",
      );
    }
    const receipt = await this.remoteEntityClient.execute(resource, source, input);
    if (
      receipt.resourceId !== resource.id ||
      receipt.provider !== resource.provider ||
      receipt.command !== input.command ||
      receipt.entityId !== resource.address.entityId
    ) {
      throw new ResourceCatalogError(
        "provider-mismatch",
        "Resource provider command receipt does not match the resolved Resource",
      );
    }
    return receipt;
  }

  nativePdfPayload(
    resourceId: string,
    representationId: string,
  ): ResourceNativePayload {
    const normalizedResourceId = normalizeResourceId(resourceId);
    const normalizedRepresentationId = representationId.trim();
    if (!normalizedRepresentationId) {
      throw new ResourceCatalogError("invalid-input", "PDF representation ID is required");
    }
    return this.database.transaction((): ResourceNativePayload => {
      const row = this.database.query(`
        SELECT pr.id, pr.content_hash, pr.payload_state AS representation_state,
               ps.bytes, ps.payload_state AS snapshot_state
        FROM pdf_representations pr
        JOIN pdf_source_snapshots ps ON ps.id = pr.source_snapshot_id
        WHERE ps.resource_id = ? AND pr.id = ?
          AND pr.media_type = 'application/pdf'
      `).get(normalizedResourceId, normalizedRepresentationId) as {
        id: string;
        content_hash: string;
        representation_state: "available" | "evicted";
        bytes: Uint8Array | null;
        snapshot_state: "available" | "evicted";
      } | null;
      if (
        !row ||
        row.representation_state !== "available" ||
        row.snapshot_state !== "available" ||
        row.bytes === null
      ) {
        throw new ResourceCatalogError(
          "source-unavailable",
          "Native PDF representation payload is unavailable",
        );
      }
      return {
        representationId: row.id,
        mediaType: "application/pdf",
        contentHash: row.content_hash,
        encoding: "base64",
        data: Buffer.from(row.bytes).toString("base64"),
      };
    })();
  }


  retentionPolicy(): ResourceRetentionPolicy {
    return this.retention.policy();
  }

  configureRetention(value: unknown): ResourceRetentionPolicy {
    return this.retention.configure(value);
  }

  inspectRetention(
    resourceId?: unknown,
    activeRevisions: readonly ResourceRevisionRef[] = [],
  ): ResourceRetentionReport {
    return this.retention.inspect(resourceId, activeRevisions);
  }

  pinRetention(value: unknown): { pin: ResourceRetentionPin; created: boolean } {
    return this.retention.pin(value);
  }

  unpinRetention(pinId: unknown): { pinId: string; removed: boolean } {
    return this.retention.unpin(pinId);
  }

  referenceRetention(
    value: unknown,
  ): { reference: ResourceRetentionReference; created: boolean } {
    return this.retention.reference(value);
  }

  unreferenceRetention(
    referenceId: unknown,
  ): { referenceId: string; removed: boolean } {
    return this.retention.unreference(referenceId);
  }

  collectRetention(
    mode: unknown,
    resourceId?: unknown,
    activeRevisions: readonly ResourceRevisionRef[] = [],
  ): ResourceRetentionCollectionReceipt {
    return this.retention.collect(mode, resourceId, activeRevisions);
  }



  private async fetchWeb(
    source: Extract<ResourceSource, { provider: "web" }>,
    initialUrl: string,
    headers: Headers,
    signal: AbortSignal,
  ): Promise<{ response: Response; url: string }> {
    let url = initialUrl;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      const normalized = normalizeResourceAddress(source, { kind: "web", url });
      if (normalized.address.kind !== "web") {
        throw new ResourceCatalogError("provider-mismatch", "Web redirect changed provider");
      }
      url = normalized.address.url;
      const response = await this.fetcher(url, {
        headers,
        redirect: "manual",
        signal,
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        return { response, url };
      }
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) {
        throw new ResourceCatalogError(
          "source-unavailable",
          "Web redirect omitted its Location header",
        );
      }
      if (redirects === 5) {
        throw new ResourceCatalogError(
          "source-unavailable",
          "Web redirect exceeded five hops",
        );
      }
      url = new URL(location, url).href;
    }
    throw new ResourceCatalogError("source-unavailable", "Web redirect could not be resolved");
  }

  private async readWebBody(response: Response): Promise<string> {
    if (!response.body) return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let received = 0;
    let body = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += chunk.value.byteLength;
        if (received > this.maximumWebBytes) {
          await reader.cancel();
          throw new ResourceCatalogError(
            "invalid-input",
            `Web response exceeds ${this.maximumWebBytes} bytes`,
          );
        }
        body += decoder.decode(chunk.value, { stream: true });
      }
      return body + decoder.decode();
    } finally {
      reader.releaseLock();
    }
  }

  private async readPdfBody(response: Response): Promise<Uint8Array> {
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > this.maximumPdfBytes) {
      await cancelResponseBody(response);
      throw new ResourceCatalogError(
        "invalid-input",
        `PDF response exceeds ${this.maximumPdfBytes} bytes`,
      );
    }
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += chunk.value.byteLength;
        if (received > this.maximumPdfBytes) {
          await reader.cancel();
          throw new ResourceCatalogError(
            "invalid-input",
            `PDF response exceeds ${this.maximumPdfBytes} bytes`,
          );
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  private assertPdfRefreshCurrent(
    resource: Resource,
    expectedGeneration: number,
  ): void {
    const current = this.requireFromCurrentRead(resource.id);
    const state = this.pdfStateFromCurrentRead(resource.id);
    if (
      current.version !== resource.version ||
      current.addressVersion !== resource.addressVersion ||
      state?.generation !== expectedGeneration ||
      state.address_version !== resource.addressVersion
    ) {
      throw new ResourceCatalogError(
        "version-conflict",
        "PDF Resource changed while refresh was in flight",
      );
    }
  }

  private async persistPdfObservation(
    resource: Resource,
    expectedGeneration: number,
    observation: PdfObservation,
    destinationHostRegistered: boolean,
    providerChecked = true,
  ): Promise<ResourceDescription> {
    const extraction = await this.pdfExtractor.extract(new Uint8Array(observation.bytes));
    if (!extraction.markdown.trim() || extraction.pages.length === 0) {
      throw new ResourceCatalogError(
        "source-unavailable",
        "PDF extractor returned no page-aware text",
      );
    }
    const representationHash = sha256(extraction.markdown);
    this.database.transaction(() => {
      this.assertPdfRefreshCurrent(resource, expectedGeneration);
      let sourceSnapshot = this.database.query(`
        SELECT *
        FROM pdf_source_snapshots
        WHERE resource_id = ? AND address_version = ?
          AND content_hash = ? AND revision_json = ?
      `).get(
        resource.id,
        resource.addressVersion,
        observation.contentHash,
        JSON.stringify(observation.revision),
      ) as PdfSourceSnapshotRow | null;
      if (!sourceSnapshot) {
        const sourceSnapshotId = crypto.randomUUID();
        this.database.query(`
          INSERT INTO pdf_source_snapshots (
            id, resource_id, address_version, locator, content_hash, revision_json,
            etag, last_modified, bytes, captured_at,
            payload_state, payload_bytes, evicted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', ?, NULL)
        `).run(
          sourceSnapshotId,
          resource.id,
          resource.addressVersion,
          observation.locator,
          observation.contentHash,
          JSON.stringify(observation.revision),
          observation.etag,
          observation.lastModified,
          observation.bytes,
          observation.capturedAt,
          observation.bytes.byteLength,
        );
        sourceSnapshot = this.database.query(
          "SELECT * FROM pdf_source_snapshots WHERE id = ?",
        ).get(sourceSnapshotId) as PdfSourceSnapshotRow;
      } else if (sourceSnapshot.bytes === null) {
        this.database.query(`
          UPDATE pdf_source_snapshots
          SET locator = ?, etag = ?, last_modified = ?, bytes = ?, captured_at = ?,
              payload_state = 'available', payload_bytes = ?, evicted_at = NULL
          WHERE id = ?
        `).run(
          observation.locator,
          observation.etag,
          observation.lastModified,
          observation.bytes,
          observation.capturedAt,
          observation.bytes.byteLength,
          sourceSnapshot.id,
        );
      }
      let nativeRepresentation = this.database.query(`
        SELECT *
        FROM pdf_representations
        WHERE source_snapshot_id = ? AND media_type = 'application/pdf'
          AND adapter_id = ? AND adapter_version = ? AND content_hash = ?
      `).get(
        sourceSnapshot.id,
        PDF_NATIVE_ADAPTER.id,
        PDF_NATIVE_ADAPTER.version,
        observation.contentHash,
      ) as PdfRepresentationRow | null;
      if (!nativeRepresentation) {
        const nativeId = crypto.randomUUID();
        this.database.query(`
          INSERT INTO pdf_representations (
            id, source_snapshot_id, media_type, adapter_id, adapter_version,
            content_hash, markdown, pages_json, derived_at,
            payload_state, payload_bytes, evicted_at
          ) VALUES (?, ?, 'application/pdf', ?, ?, ?, NULL, NULL, ?, 'available', 0, NULL)
        `).run(
          nativeId,
          sourceSnapshot.id,
          PDF_NATIVE_ADAPTER.id,
          PDF_NATIVE_ADAPTER.version,
          observation.contentHash,
          observation.capturedAt,
        );
        nativeRepresentation = this.database.query(
          "SELECT * FROM pdf_representations WHERE id = ?",
        ).get(nativeId) as PdfRepresentationRow;
      }
      else if (nativeRepresentation.payload_state === "evicted") {
        this.database.query(`
          UPDATE pdf_representations
          SET payload_state = 'available', evicted_at = NULL
          WHERE id = ?
        `).run(nativeRepresentation.id);
      }
      let textRepresentation = this.database.query(`
        SELECT *
        FROM pdf_representations
        WHERE source_snapshot_id = ? AND media_type = 'text/markdown'
          AND adapter_id = ? AND adapter_version = ? AND content_hash = ?
      `).get(
        sourceSnapshot.id,
        this.pdfExtractor.adapter.id,
        this.pdfExtractor.adapter.version,
        representationHash,
      ) as PdfRepresentationRow | null;
      if (!textRepresentation) {
        const representationId = crypto.randomUUID();
        this.database.query(`
          INSERT INTO pdf_representations (
            id, source_snapshot_id, media_type, adapter_id, adapter_version,
            content_hash, markdown, pages_json, derived_at,
            payload_state, payload_bytes, evicted_at
          ) VALUES (?, ?, 'text/markdown', ?, ?, ?, ?, ?, ?, 'available', ?, NULL)
        `).run(
          representationId,
          sourceSnapshot.id,
          this.pdfExtractor.adapter.id,
          this.pdfExtractor.adapter.version,
          representationHash,
          extraction.markdown,
          JSON.stringify(extraction.pages),
          observation.capturedAt,
          Buffer.byteLength(extraction.markdown, "utf8"),
        );
        textRepresentation = this.database.query(
          "SELECT * FROM pdf_representations WHERE id = ?",
        ).get(representationId) as PdfRepresentationRow;
      }
      else if (
        textRepresentation.payload_state === "evicted" ||
        textRepresentation.markdown === null ||
        textRepresentation.pages_json === null
      ) {
        this.database.query(`
          UPDATE pdf_representations
          SET markdown = ?, pages_json = ?, derived_at = ?,
              payload_state = 'available', payload_bytes = ?, evicted_at = NULL
          WHERE id = ?
        `).run(
          extraction.markdown,
          JSON.stringify(extraction.pages),
          observation.capturedAt,
          Buffer.byteLength(extraction.markdown, "utf8"),
          textRepresentation.id,
        );
      }
      this.database.query(`
        UPDATE pdf_resource_state
        SET source_snapshot_id = ?, representation_id = ?
        WHERE resource_id = ? AND generation = ?
      `).run(
        sourceSnapshot.id,
        textRepresentation.id,
        resource.id,
        expectedGeneration,
      );
      if (resource.provider === "web" && providerChecked) {
        this.database.query(`
          UPDATE web_resource_state
          SET freshness = 'fresh', checked_at = ?, last_error = NULL
          WHERE resource_id = ?
        `).run(observation.capturedAt, resource.id);
      }
      this.bumpSequence();
    })();
    return this.describe(resource.id, destinationHostRegistered);
  }
  private async derivePdfFromRetained(
    resourceId: string,
    destinationHostRegistered: boolean,
  ): Promise<ResourceDescription | null> {
    const retained = this.database.transaction(() => {
      const resource = this.requireFromCurrentRead(resourceId);
      const source = this.requireSourceFromCurrentRead(resource.sourceId);
      if (
        resource.mediaType !== "application/pdf" ||
        source.policy.deniedCapabilities.includes("read")
      ) return null;
      const state = this.pdfStateFromCurrentRead(resource.id);
      if (
        !state ||
        state.address_version !== resource.addressVersion ||
        !state.source_snapshot_id
      ) return null;
      const snapshot = this.database.query(
        "SELECT * FROM pdf_source_snapshots WHERE id = ?",
      ).get(state.source_snapshot_id) as PdfSourceSnapshotRow | null;
      if (
        !snapshot ||
        snapshot.payload_state !== "available" ||
        snapshot.bytes === null ||
        this.pdfActiveRepresentationAvailable(snapshot.id)
      ) return null;
      return { resource, snapshot };
    })();
    if (!retained) return null;
    const generation = this.database.transaction(() =>
      this.beginPdfRefresh(retained.resource, retained.snapshot, false)
    )();
    return this.persistPdfObservation(
      retained.resource,
      generation,
      {
        locator: retained.snapshot.locator,
        contentHash: retained.snapshot.content_hash,
        revision: normalizeRetainedResourceRevisionRef(
          parsedJson(retained.snapshot.revision_json, "PDF source snapshot revision"),
        ),
        etag: retained.snapshot.etag,
        lastModified: retained.snapshot.last_modified,
        bytes: new Uint8Array(retained.snapshot.bytes as Uint8Array),
        capturedAt: retained.snapshot.captured_at,
      },
      destinationHostRegistered,
      false,
    );
  }

  private remoteEntityRefreshFailure(
    resource: Extract<Resource, { provider: RemoteEntityProvider }>,
    destinationHostRegistered: boolean,
    error: unknown,
  ): ResourceDescription {
    const message = errorText(error);
    this.database.transaction(() => {
      this.database.query(`
        INSERT INTO remote_entity_resource_state (
          resource_id, address_version, generation, source_snapshot_id,
          representation_id, freshness, checked_at, last_error
        ) VALUES (?, ?, 1, NULL, NULL, 'failed', ?, ?)
        ON CONFLICT(resource_id) DO UPDATE SET
          freshness = 'failed',
          checked_at = excluded.checked_at,
          last_error = excluded.last_error
        WHERE remote_entity_resource_state.address_version = excluded.address_version
      `).run(resource.id, resource.addressVersion, this.now(), message);
      this.bumpSequence();
    })();
    return {
      ...this.describe(resource.id, destinationHostRegistered),
      remoteError: message,
    };
  }

  private async performRemoteEntityRefresh(
    resource: Extract<Resource, { provider: RemoteEntityProvider }>,
    destinationHostRegistered: boolean,
  ): Promise<ResourceDescription> {
    const initial = this.database.transaction(() => {
      const current = this.requireFromCurrentRead(resource.id);
      const source = this.requireSourceFromCurrentRead(current.sourceId);
      if (
        (current.provider !== "jira" && current.provider !== "linear") ||
        (source.provider !== "jira" && source.provider !== "linear") ||
        current.provider !== source.provider
      ) {
        throw new ResourceCatalogError(
          "provider-mismatch",
          "Remote entity Resource and source do not match",
        );
      }
      if (
        source.policy.deniedCapabilities.includes("read") ||
        source.policy.deniedCapabilities.includes("refresh")
      ) {
        throw new ResourceCatalogError(
          "invalid-input",
          "Workspace policy denies reading or refreshing this remote entity",
        );
      }
      this.database.query(`
        INSERT INTO remote_entity_resource_state (
          resource_id, address_version, generation, source_snapshot_id,
          representation_id, freshness, checked_at, last_error
        ) VALUES (?, ?, 1, NULL, NULL, 'refreshing', ?, NULL)
        ON CONFLICT(resource_id) DO UPDATE SET
          source_snapshot_id = CASE
            WHEN remote_entity_resource_state.address_version = excluded.address_version
              THEN remote_entity_resource_state.source_snapshot_id
            ELSE NULL
          END,
          representation_id = CASE
            WHEN remote_entity_resource_state.address_version = excluded.address_version
              THEN remote_entity_resource_state.representation_id
            ELSE NULL
          END,
          address_version = excluded.address_version,
          generation = remote_entity_resource_state.generation + 1,
          freshness = 'refreshing',
          checked_at = excluded.checked_at,
          last_error = NULL
      `).run(current.id, current.addressVersion, this.now());
      const state = this.remoteEntityStateFromCurrentRead(current.id);
      if (!state) {
        throw new ResourceCatalogError(
          "source-unavailable",
          "Remote entity refresh state was not created",
        );
      }
      return { resource: current, source, generation: state.generation };
    })();
    const observed = await this.remoteEntityClient.observe(
      initial.resource,
      initial.source,
    );
    if (
      observed.sourceSnapshot.provider !== initial.resource.provider ||
      observed.sourceSnapshot.resourceId !== initial.resource.id ||
      observed.sourceSnapshot.entityId !== initial.resource.address.entityId ||
      observed.sourceSnapshot.addressVersion !== initial.resource.addressVersion ||
      observed.sourceSnapshot.revision.resourceId !== initial.resource.id ||
      observed.sourceSnapshot.revision.addressVersion !== initial.resource.addressVersion ||
      observed.sourceSnapshot.revision.revision.kind !== initial.resource.provider
    ) {
      throw new ResourceCatalogError(
        "provider-mismatch",
        "Remote entity observation does not match the resolved Resource identity",
      );
    }
    if (observed.representation.contentHash !== sha256(observed.markdown)) {
      throw new ResourceCatalogError(
        "source-unavailable",
        "Remote entity Markdown representation hash is invalid",
      );
    }
    const refreshedId = this.database.transaction(() => {
      const current = this.requireFromCurrentRead(initial.resource.id);
      if (current.provider !== "jira" && current.provider !== "linear") {
        throw new ResourceCatalogError(
          "provider-mismatch",
          "Remote entity Resource provider changed while refresh was in flight",
        );
      }
      if (
        current.provider !== initial.resource.provider ||
        current.version !== initial.resource.version ||
        current.addressVersion !== initial.resource.addressVersion ||
        current.address.entityId !== initial.resource.address.entityId
      ) {
        throw new ResourceCatalogError(
          "version-conflict",
          "Remote entity Resource changed while refresh was in flight",
        );
      }
      const locatorAddress = current.provider === "jira"
        ? {
            kind: "jira" as const,
            entityId: current.address.entityId,
            key: observed.sourceSnapshot.locator,
          }
        : {
            kind: "linear" as const,
            entityId: current.address.entityId,
            identifier: observed.sourceSnapshot.locator,
          };
      const normalized = normalizeResourceAddress(initial.source, locatorAddress);
      const currentRow = this.database.query(
        "SELECT canonical_key FROM resources WHERE id = ?",
      ).get(current.id) as { canonical_key: string } | null;
      if (!currentRow || normalized.canonicalKey !== currentRow.canonical_key) {
        throw new ResourceCatalogError(
          "provider-mismatch",
          "Remote entity observation attempted to change canonical identity",
        );
      }
      if (JSON.stringify(normalized.address) !== JSON.stringify(current.address)) {
        const updated = this.database.query(`
          UPDATE resources
          SET address_json = ?,
              address_version = address_version + 1,
              version = version + 1,
              updated_at = ?
          WHERE id = ? AND version = ?
        `).run(
          JSON.stringify(normalized.address),
          this.now(),
          current.id,
          current.version,
        );
        if (updated.changes !== 1) {
          throw new ResourceCatalogError(
            "version-conflict",
            "Remote entity locator changed concurrently",
          );
        }
      }
      const refreshed = this.requireFromCurrentRead(current.id);
      if (refreshed.provider !== "jira" && refreshed.provider !== "linear") {
        throw new ResourceCatalogError(
          "provider-mismatch",
          "Remote entity Resource provider changed during refresh",
        );
      }
      const revision = normalizeResourceRevisionRef({
        resourceId: refreshed.id,
        addressVersion: refreshed.addressVersion,
        revision: observed.sourceSnapshot.revision.revision,
      }, refreshed);
      const payload: RemoteEntitySnapshotPayload = {
        title: observed.title,
        metadata: observed.metadata,
        externalUrl: observed.externalUrl,
        locator: observed.sourceSnapshot.locator,
        contentHash: observed.sourceSnapshot.contentHash,
        commandDescriptors: observed.commandDescriptors,
      };
      const payloadJson = JSON.stringify(payload);
      const revisionJson = JSON.stringify(revision);
      const snapshotId = crypto.randomUUID();
      this.database.query(`
        INSERT OR IGNORE INTO remote_entity_source_snapshots (
          id, resource_id, address_version, provider, entity_id, revision_json,
          payload_json, captured_at, payload_state, payload_bytes, evicted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'available', ?, NULL)
      `).run(
        snapshotId,
        refreshed.id,
        refreshed.addressVersion,
        refreshed.provider,
        refreshed.address.entityId,
        revisionJson,
        payloadJson,
        observed.sourceSnapshot.fetchedAt,
        Buffer.byteLength(payloadJson),
      );
      const snapshot = this.database.query(`
        SELECT id, resource_id, address_version, provider, entity_id, revision_json,
               payload_json, captured_at, payload_state, payload_bytes, evicted_at
        FROM remote_entity_source_snapshots
        WHERE resource_id = ? AND address_version = ? AND provider = ?
          AND entity_id = ? AND revision_json = ?
      `).get(
        refreshed.id,
        refreshed.addressVersion,
        refreshed.provider,
        refreshed.address.entityId,
        revisionJson,
      ) as RemoteEntitySourceSnapshotRow | null;
      if (!snapshot || snapshot.payload_json !== payloadJson) {
        throw new ResourceCatalogError(
          "source-unavailable",
          "Remote entity provider reused a revision for different content",
        );
      }
      const representationId = crypto.randomUUID();
      this.database.query(`
        INSERT OR IGNORE INTO remote_entity_representations (
          id, source_snapshot_id, media_type, adapter_id, version, content_hash,
          markdown, derived_at, payload_state, payload_bytes, evicted_at
        ) VALUES (?, ?, 'text/markdown', ?, ?, ?, ?, ?, 'available', ?, NULL)
      `).run(
        representationId,
        snapshot.id,
        observed.representation.adapter.id,
        observed.representation.adapter.version,
        observed.representation.contentHash,
        observed.markdown,
        observed.representation.derivedAt,
        Buffer.byteLength(observed.markdown),
      );
      const representation = this.database.query(`
        SELECT id
        FROM remote_entity_representations
        WHERE source_snapshot_id = ? AND media_type = 'text/markdown'
          AND adapter_id = ? AND version = ? AND content_hash = ?
      `).get(
        snapshot.id,
        observed.representation.adapter.id,
        observed.representation.adapter.version,
        observed.representation.contentHash,
      ) as { id: string } | null;
      if (!representation) {
        throw new ResourceCatalogError(
          "source-unavailable",
          "Remote entity Markdown representation was not retained",
        );
      }
      const stateUpdate = this.database.query(`
        UPDATE remote_entity_resource_state
        SET address_version = ?,
            source_snapshot_id = ?,
            representation_id = ?,
            freshness = 'fresh',
            checked_at = ?,
            last_error = NULL
        WHERE resource_id = ? AND generation = ?
      `).run(
        refreshed.addressVersion,
        snapshot.id,
        representation.id,
        observed.sourceSnapshot.fetchedAt,
        refreshed.id,
        initial.generation,
      );
      if (stateUpdate.changes !== 1) {
        throw new ResourceCatalogError(
          "version-conflict",
          "Remote entity refresh was superseded",
        );
      }
      this.bumpSequence();
      return refreshed.id;
    })();
    return this.describe(refreshedId, destinationHostRegistered);
  }

  private pdfRefreshFailure(
    resource: Resource,
    destinationHostRegistered: boolean,
    error: unknown,
  ): ResourceDescription {
    const message = errorText(error);
    if (resource.provider === "web") {
      this.database.transaction(() => {
        this.database.query(`
          UPDATE web_resource_state
          SET freshness = 'failed', checked_at = ?, last_error = ?
          WHERE resource_id = ?
        `).run(this.now(), message, resource.id);
        this.bumpSequence();
      })();
    }
    const description = this.describe(resource.id, destinationHostRegistered);
    if (resource.provider === "web" || description.pdf) {
      return { ...description, pdfError: message };
    }
    throw error;
  }


  private async performPdfRefresh(
    resourceId: string,
    destinationHostRegistered: boolean,
  ): Promise<ResourceDescription> {
    const initial = this.database.transaction(() => {
      const resource = this.requireFromCurrentRead(resourceId);
      const source = this.requireSourceFromCurrentRead(resource.sourceId);
      if (
        resource.mediaType !== "application/pdf" ||
        (resource.provider !== "filesystem" && resource.provider !== "web")
      ) {
        throw new ResourceCatalogError(
          "provider-mismatch",
          "PDF refresh requires a filesystem or web PDF Resource",
        );
      }
      if (
        source.policy.deniedCapabilities.includes("read") ||
        source.policy.deniedCapabilities.includes("refresh")
      ) {
        throw new ResourceCatalogError(
          "invalid-input",
          "Workspace policy denies reading or refreshing this PDF Resource",
        );
      }
      const state = this.pdfStateFromCurrentRead(resource.id);
      const sourceSnapshot = state?.address_version === resource.addressVersion &&
          state.source_snapshot_id
        ? this.database.query(
            "SELECT * FROM pdf_source_snapshots WHERE id = ?",
          ).get(state.source_snapshot_id) as PdfSourceSnapshotRow | null
        : null;
      return { resource, source, state, sourceSnapshot };
    })();

    let observation: PdfObservation;
    if (
      initial.resource.provider === "filesystem" &&
      initial.source.provider === "filesystem" &&
      initial.resource.address.kind === "filesystem"
    ) {
      const sourceRow = this.database.transaction(() =>
        this.requireSourceRowFromCurrentRead(initial.source.id)
      )();
      this.assertConfinement(initial.source, sourceRow.root_binding, initial.resource.address);
      const absolutePath = resolve(
        initial.source.boundary.root,
        initial.resource.address.path,
      );
      let stat: BigIntStats;
      try {
        stat = statSync(absolutePath, { bigint: true });
      } catch {
        throw new ResourceCatalogError("source-unavailable", "PDF Resource is unavailable");
      }
      if (!stat.isFile()) {
        throw new ResourceCatalogError("source-unavailable", "PDF Resource is not a regular file");
      }
      if (stat.size > BigInt(this.maximumPdfBytes)) {
        throw new ResourceCatalogError(
          "source-unavailable",
          `PDF Resource exceeds ${this.maximumPdfBytes} bytes`,
        );
      }
      const revision: ResourceRevisionRef = {
        resourceId: initial.resource.id,
        addressVersion: initial.resource.addressVersion,
        revision: {
          kind: "filesystem",
          mtimeNs: stat.mtimeNs.toString(),
          size: stat.size.toString(),
        },
      };
      if (
        initial.sourceSnapshot &&
        resourceRevisionRefEquals(
          normalizeRetainedResourceRevisionRef(
            parsedJson(initial.sourceSnapshot.revision_json, "PDF source snapshot revision"),
          ),
          revision,
        ) &&
        this.pdfActiveRepresentationAvailable(initial.sourceSnapshot.id)
      ) {
        return this.describe(initial.resource.id, destinationHostRegistered);
      }
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(readFileSync(absolutePath));
      } catch {
        throw new ResourceCatalogError("source-unavailable", "PDF Resource is unreadable");
      }
      observation = {
        locator: initial.resource.address.path,
        contentHash: byteHash(bytes),
        revision,
        etag: null,
        lastModified: null,
        bytes,
        capturedAt: new Date(Number(stat.mtimeMs)).toISOString(),
      };
    } else if (
      initial.resource.provider === "web" &&
      initial.source.provider === "web" &&
      initial.resource.address.kind === "web"
    ) {
      const headers = new Headers({ Accept: "application/pdf" });
      if (initial.sourceSnapshot?.etag) headers.set("If-None-Match", initial.sourceSnapshot.etag);
      if (initial.sourceSnapshot?.last_modified) {
        headers.set("If-Modified-Since", initial.sourceSnapshot.last_modified);
      }
      const signal = AbortSignal.timeout(15_000);
      let { response, url: canonicalUrl } = await this.fetchWeb(
        initial.source,
        initial.resource.address.url,
        headers,
        signal,
      );
      const currentAvailable = initial.sourceSnapshot !== null &&
        initial.sourceSnapshot.bytes !== null &&
        this.pdfActiveRepresentationAvailable(initial.sourceSnapshot.id);
      if (
        response.status === 304 &&
        initial.sourceSnapshot &&
        initial.sourceSnapshot.bytes !== null
      ) {
        if (currentAvailable) {
          const generation = this.database.transaction(() =>
            this.beginPdfRefresh(initial.resource, initial.sourceSnapshot)
          )();
          this.database.transaction(() => {
            this.assertPdfRefreshCurrent(initial.resource, generation);
            this.database.query(`
              UPDATE web_resource_state
              SET freshness = 'fresh', checked_at = ?, last_error = NULL
              WHERE resource_id = ?
            `).run(this.now(), initial.resource.id);
            this.bumpSequence();
          })();
          return this.describe(initial.resource.id, destinationHostRegistered);
        }
        observation = {
          locator: initial.sourceSnapshot.locator,
          contentHash: initial.sourceSnapshot.content_hash,
          revision: normalizeRetainedResourceRevisionRef(
            parsedJson(initial.sourceSnapshot.revision_json, "PDF source snapshot revision"),
          ),
          etag: initial.sourceSnapshot.etag,
          lastModified: initial.sourceSnapshot.last_modified,
          bytes: new Uint8Array(initial.sourceSnapshot.bytes),
          capturedAt: this.now(),
        };
      } else {
        if (response.status === 304) {
          await cancelResponseBody(response);
          ({ response, url: canonicalUrl } = await this.fetchWeb(
            initial.source,
            initial.resource.address.url,
            new Headers({ Accept: "application/pdf" }),
            signal,
          ));
        }
        if (!response.ok) {
          await cancelResponseBody(response);
          throw new ResourceCatalogError(
            "source-unavailable",
            `Web provider returned HTTP ${response.status}`,
          );
        }
        const mediaType = responseMediaType(response);
        if (mediaType !== "application/pdf") {
          await cancelResponseBody(response);
          throw new ResourceCatalogError(
            "invalid-input",
            `Web provider returned unsupported PDF media type: ${mediaType || "unknown"}`,
          );
        }
        const bytes = await this.readPdfBody(response);
        const contentHash = byteHash(bytes);
        const etag = webEtag(response);
        const lastModified = response.headers.get("last-modified")?.trim() || null;
        observation = {
          locator: canonicalUrl,
          contentHash,
          revision: webRevision(initial.resource, etag, lastModified, contentHash),
          etag,
          lastModified,
          bytes,
          capturedAt: this.now(),
        };
      }
    } else {
      throw new ResourceCatalogError("provider-mismatch", "PDF provider identity is inconsistent");
    }

    const generation = this.database.transaction(() =>
      this.beginPdfRefresh(initial.resource, initial.sourceSnapshot)
    )();
    try {
      return await this.persistPdfObservation(
        initial.resource,
        generation,
        observation,
        destinationHostRegistered,
      );
    } catch (error) {
      if (initial.resource.provider === "web") {
        this.database.transaction(() => {
          this.assertPdfRefreshCurrent(initial.resource, generation);
          this.database.query(`
            UPDATE web_resource_state
            SET freshness = 'failed', checked_at = ?, last_error = ?
            WHERE resource_id = ?
          `).run(this.now(), errorText(error), initial.resource.id);
          this.bumpSequence();
        })();
        return {
          ...this.describe(initial.resource.id, destinationHostRegistered),
          pdfError: errorText(error),
        };
      }
      throw error;
    }
  }

  private beginPdfRefresh(
    resource: Resource,
    sourceSnapshot: PdfSourceSnapshotRow | null,
    updateWebStatus = true,
  ): number {
    const state = this.pdfStateFromCurrentRead(resource.id);
    const generation = (state?.generation ?? 0) + 1;
    this.database.query(`
      INSERT INTO pdf_resource_state (
        resource_id, address_version, generation, source_snapshot_id, representation_id
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(resource_id) DO UPDATE SET
        address_version = excluded.address_version,
        generation = excluded.generation,
        source_snapshot_id = excluded.source_snapshot_id,
        representation_id = excluded.representation_id
    `).run(
      resource.id,
      resource.addressVersion,
      generation,
      sourceSnapshot?.id ?? null,
      state?.address_version === resource.addressVersion ? state.representation_id : null,
    );
    if (resource.provider === "web" && updateWebStatus) {
      this.database.query(`
        INSERT INTO web_resource_state (
          resource_id, address_version, generation, source_snapshot_id,
          representation_id, freshness, checked_at, last_error
        ) VALUES (?, ?, 1, NULL, NULL, 'refreshing', ?, NULL)
        ON CONFLICT(resource_id) DO UPDATE SET
          address_version = excluded.address_version,
          generation = web_resource_state.generation + 1,
          source_snapshot_id = NULL,
          representation_id = NULL,
          freshness = 'refreshing',
          checked_at = excluded.checked_at,
          last_error = NULL
      `).run(resource.id, resource.addressVersion, this.now());
    }
    this.bumpSequence();
    return generation;
  }

  private async performWebRefresh(
    resourceId: string,
    destinationHostRegistered: boolean,
  ): Promise<ResourceDescription> {
    const snapshot = this.database.transaction(() => {
      const resource = this.requireFromCurrentRead(resourceId);
      const source = this.requireSourceFromCurrentRead(resource.sourceId);
      if (resource.provider !== "web" || source.provider !== "web") {
        throw new ResourceCatalogError(
          "provider-mismatch",
          "Only web resources can be fetched through the HTTP provider",
        );
      }
      if (
        source.policy.deniedCapabilities.includes("read") ||
        source.policy.deniedCapabilities.includes("refresh")
      ) {
        throw new ResourceCatalogError(
          "invalid-input",
          "Workspace policy denies reading or refreshing this resource",
        );
      }
      const storedState = this.webStateRowFromCurrentRead(resource.id);
      const state = storedState?.address_version === resource.addressVersion
        ? storedState
        : null;
      const generation = (state?.generation ?? 0) + 1;
      this.database.query(`
        INSERT INTO web_resource_state (
          resource_id, address_version, generation, source_snapshot_id,
          representation_id, freshness, checked_at, last_error
        ) VALUES (?, ?, ?, ?, ?, 'refreshing', ?, NULL)
        ON CONFLICT(resource_id) DO UPDATE SET
          address_version = excluded.address_version,
          generation = excluded.generation,
          source_snapshot_id = excluded.source_snapshot_id,
          representation_id = excluded.representation_id,
          freshness = 'refreshing',
          checked_at = excluded.checked_at,
          last_error = NULL
      `).run(
        resource.id,
        resource.addressVersion,
        generation,
        state?.source_snapshot_id ?? null,
        state?.representation_id ?? null,
        state?.checked_at ?? null,
      );
      this.bumpSequence();
      const sourceSnapshot = state?.source_snapshot_id
        ? this.webSourceSnapshotRowFromCurrentRead(state.source_snapshot_id)
        : null;
      const representation = state?.representation_id
        ? this.webRepresentationRowFromCurrentRead(state.representation_id)
        : null;
      return { resource, source, generation, sourceSnapshot, representation };
    })();
    const headers = new Headers({ Accept: "text/html,application/xhtml+xml" });
    if (snapshot.sourceSnapshot?.etag) {
      headers.set("If-None-Match", snapshot.sourceSnapshot.etag);
    }
    if (snapshot.sourceSnapshot?.last_modified) {
      headers.set("If-Modified-Since", snapshot.sourceSnapshot.last_modified);
    }
    const checkedAt = this.now();
    try {
      const signal = AbortSignal.timeout(15_000);
      let { response, url: canonicalUrl } = await this.fetchWeb(
        snapshot.source,
        snapshot.resource.address.url,
        headers,
        signal,
      );
      const representationMatchesExtractor =
        snapshot.representation?.source_snapshot_id === snapshot.sourceSnapshot?.id &&
        snapshot.representation?.adapter_id === this.webExtractor.adapter.id &&
        snapshot.representation?.adapter_version === this.webExtractor.adapter.version &&
        snapshot.representation?.markdown !== null;
      const canUseNotModified =
        snapshot.sourceSnapshot !== null &&
        snapshot.sourceSnapshot.canonical_url === canonicalUrl &&
        (representationMatchesExtractor || snapshot.sourceSnapshot.html !== null);
      if (response.status === 304 && !canUseNotModified) {
        await cancelResponseBody(response);
        ({ response, url: canonicalUrl } = await this.fetchWeb(
          snapshot.source,
          snapshot.resource.address.url,
          new Headers({ Accept: "text/html,application/xhtml+xml" }),
          signal,
        ));
      }
      if (response.status === 304) {
        if (!snapshot.sourceSnapshot) {
          throw new ResourceCatalogError(
            "source-unavailable",
            "Web provider returned not-modified without a local source snapshot",
          );
        }
        if (snapshot.sourceSnapshot.canonical_url !== canonicalUrl) {
          throw new ResourceCatalogError(
            "source-unavailable",
            "Web provider returned not-modified after its canonical URL changed",
          );
        }
        if (representationMatchesExtractor && snapshot.representation) {
          const sourceSnapshotId = snapshot.sourceSnapshot.id;
          const representationId = snapshot.representation.id;
          this.database.transaction(() => {
            this.assertWebRefreshCurrent(snapshot.resource, snapshot.generation);
            this.database.query(`
              UPDATE web_resource_state
              SET source_snapshot_id = ?, representation_id = ?,
                  freshness = 'fresh', checked_at = ?, last_error = NULL
              WHERE resource_id = ?
            `).run(
              sourceSnapshotId,
              representationId,
              checkedAt,
              snapshot.resource.id,
            );
            this.bumpSequence();
          })();
        } else if (
          snapshot.sourceSnapshot.html !== null &&
          snapshot.sourceSnapshot.canonical_url !== null &&
          snapshot.sourceSnapshot.content_hash !== null &&
          snapshot.sourceSnapshot.fetched_at !== null
        ) {
          this.persistWebObservation(
            snapshot.resource,
            snapshot.generation,
            checkedAt,
            {
              canonicalUrl: snapshot.sourceSnapshot.canonical_url,
              contentHash: snapshot.sourceSnapshot.content_hash,
              revision: normalizeRetainedResourceRevisionRef(
                parsedJson(
                  snapshot.sourceSnapshot.revision_json,
                  "Web source snapshot revision",
                ),
              ),
              etag: snapshot.sourceSnapshot.etag,
              lastModified: snapshot.sourceSnapshot.last_modified,
              html: snapshot.sourceSnapshot.html,
              fetchedAt: snapshot.sourceSnapshot.fetched_at,
            },
          );
        } else {
          throw new ResourceCatalogError(
            "source-unavailable",
            "Web provider returned not-modified but local source bytes are unavailable",
          );
        }
        return this.describe(snapshot.resource.id, destinationHostRegistered);
      }
      if (!response.ok) {
        await cancelResponseBody(response);
        throw new ResourceCatalogError(
          "source-unavailable",
          `Web provider returned HTTP ${response.status}`,
        );
      }
      const mediaType = responseMediaType(response);
      if (mediaType !== "text/html" && mediaType !== "application/xhtml+xml") {
        await cancelResponseBody(response);
        throw new ResourceCatalogError(
          "invalid-input",
          `Web provider returned unsupported media type: ${mediaType || "unknown"}`,
        );
      }
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > this.maximumWebBytes) {
        await cancelResponseBody(response);
        throw new ResourceCatalogError(
          "invalid-input",
          `Web response exceeds ${this.maximumWebBytes} bytes`,
        );
      }
      const html = await this.readWebBody(response);
      const contentHash = sha256(html);
      const etag = webEtag(response);
      const lastModified = response.headers.get("last-modified")?.trim() || null;
      this.persistWebObservation(
        snapshot.resource,
        snapshot.generation,
        checkedAt,
        {
          canonicalUrl,
          contentHash,
          revision: webRevision(snapshot.resource, etag, lastModified, contentHash),
          etag,
          lastModified,
          html,
          fetchedAt: checkedAt,
        },
      );
      return this.describe(snapshot.resource.id, destinationHostRegistered);
    } catch (error) {
      if (
        error instanceof ResourceCatalogError &&
        error.code === "version-conflict"
      ) {
        throw error;
      }
      this.database.transaction(() => {
        this.assertWebRefreshCurrent(snapshot.resource, snapshot.generation);
        this.database.query(`
          UPDATE web_resource_state
          SET freshness = 'failed', checked_at = ?, last_error = ?
          WHERE resource_id = ?
        `).run(checkedAt, errorText(error), snapshot.resource.id);
        this.bumpSequence();
      })();
      return this.describe(snapshot.resource.id, destinationHostRegistered);
    }
  }

  private persistWebObservation(
    resource: Extract<Resource, { provider: "web" }>,
    expectedGeneration: number,
    checkedAt: string,
    observation: WebObservation,
  ): void {
    const markdown = this.webExtractor.extract({
      html: observation.html,
      url: observation.canonicalUrl,
    });
    if (!markdown) {
      throw new ResourceCatalogError(
        "invalid-input",
        "Web Markdown extractor returned an empty representation",
      );
    }
    const representationHash = sha256(markdown);
    const revisionJson = JSON.stringify(observation.revision);
    this.database.transaction(() => {
      this.assertWebRefreshCurrent(resource, expectedGeneration);
      let sourceSnapshot = this.database.query(`
        SELECT id, resource_id, address_version, canonical_url, content_hash,
               revision_json, etag, last_modified, html, evicted_at, fetched_at
        FROM web_source_snapshots
        WHERE resource_id = ? AND address_version = ? AND canonical_url = ?
          AND content_hash = ? AND revision_json = ?
        ORDER BY CASE WHEN html IS NULL THEN 1 ELSE 0 END, fetched_at, id
        LIMIT 1
      `).get(
        resource.id,
        resource.addressVersion,
        observation.canonicalUrl,
        observation.contentHash,
        revisionJson,
      ) as WebSourceSnapshotRow | null;
      if (!sourceSnapshot) {
        const sourceSnapshotId = crypto.randomUUID();
        this.database.query(`
          INSERT INTO web_source_snapshots (
            id, resource_id, address_version, canonical_url, content_hash,
            revision_json, etag, last_modified, html, fetched_at,
            payload_state, payload_bytes, evicted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', ?, NULL)
        `).run(
          sourceSnapshotId,
          resource.id,
          resource.addressVersion,
          observation.canonicalUrl,
          observation.contentHash,
          revisionJson,
          observation.etag,
          observation.lastModified,
          observation.html,
          observation.fetchedAt,
          Buffer.byteLength(observation.html, "utf8"),
        );
        sourceSnapshot = this.webSourceSnapshotRowFromCurrentRead(sourceSnapshotId);
      } else if (sourceSnapshot.html === null) {
        this.database.query(`
          UPDATE web_source_snapshots
          SET html = ?, payload_state = 'available', payload_bytes = ?, evicted_at = NULL
          WHERE id = ?
        `).run(
          observation.html,
          Buffer.byteLength(observation.html, "utf8"),
          sourceSnapshot.id,
        );
        sourceSnapshot = this.webSourceSnapshotRowFromCurrentRead(sourceSnapshot.id);
      }
      if (!sourceSnapshot) {
        throw new ResourceCatalogError(
          "source-unavailable",
          "Web source snapshot could not be persisted",
        );
      }
      let representation = this.database.query(`
        SELECT id, source_snapshot_id, media_type, adapter_id, adapter_version,
               content_hash, markdown, evicted_at, derived_at
        FROM web_representations
        WHERE source_snapshot_id = ? AND media_type = 'text/markdown'
          AND adapter_id = ? AND adapter_version = ? AND content_hash = ?
        ORDER BY CASE WHEN markdown IS NULL THEN 1 ELSE 0 END, derived_at, id
        LIMIT 1
      `).get(
        sourceSnapshot.id,
        this.webExtractor.adapter.id,
        this.webExtractor.adapter.version,
        representationHash,
      ) as WebRepresentationRow | null;
      if (!representation) {
        const representationId = crypto.randomUUID();
        this.database.query(`
          INSERT INTO web_representations (
            id, source_snapshot_id, media_type, adapter_id, adapter_version,
            content_hash, markdown, derived_at, payload_state, payload_bytes, evicted_at
          ) VALUES (?, ?, 'text/markdown', ?, ?, ?, ?, ?, 'available', ?, NULL)
        `).run(
          representationId,
          sourceSnapshot.id,
          this.webExtractor.adapter.id,
          this.webExtractor.adapter.version,
          representationHash,
          markdown,
          checkedAt,
          Buffer.byteLength(markdown, "utf8"),
        );
        representation = this.webRepresentationRowFromCurrentRead(representationId);
      } else if (representation.markdown === null) {
        this.database.query(`
          UPDATE web_representations
          SET markdown = ?, payload_state = 'available', payload_bytes = ?, evicted_at = NULL
          WHERE id = ?
        `).run(markdown, Buffer.byteLength(markdown, "utf8"), representation.id);
        representation = this.webRepresentationRowFromCurrentRead(representation.id);
      }
      if (!representation) {
        throw new ResourceCatalogError(
          "source-unavailable",
          "Web representation could not be persisted",
        );
      }
      this.database.query(`
        UPDATE web_resource_state
        SET source_snapshot_id = ?, representation_id = ?,
            freshness = 'fresh', checked_at = ?, last_error = NULL
        WHERE resource_id = ?
      `).run(sourceSnapshot.id, representation.id, checkedAt, resource.id);
      this.bumpSequence();
    })();
  }

  private assertWebRefreshCurrent(
    snapshotResource: Extract<Resource, { provider: "web" }>,
    expectedGeneration: number,
  ): void {
    const resource = this.requireFromCurrentRead(snapshotResource.id);
    const state = this.webStateRowFromCurrentRead(snapshotResource.id);
    if (
      resource.provider !== "web" ||
      resource.addressVersion !== snapshotResource.addressVersion ||
      state?.address_version !== resource.addressVersion ||
      state.generation !== expectedGeneration
    ) {
      throw new ResourceCatalogError(
        "version-conflict",
        "Web resource changed while its refresh was in flight",
      );
    }
  }

  private webStateRowFromCurrentRead(resourceId: string): WebResourceStateRow | null {
    return this.database.query(`
      SELECT resource_id, address_version, generation, source_snapshot_id,
             representation_id, freshness, checked_at, last_error
      FROM web_resource_state
      WHERE resource_id = ?
    `).get(resourceId) as WebResourceStateRow | null;
  }

  private webSourceSnapshotRowFromCurrentRead(
    sourceSnapshotId: string,
  ): WebSourceSnapshotRow | null {
    return this.database.query(`
      SELECT id, resource_id, address_version, canonical_url, content_hash,
             revision_json, etag, last_modified, html, evicted_at, fetched_at
      FROM web_source_snapshots
      WHERE id = ?
    `).get(sourceSnapshotId) as WebSourceSnapshotRow | null;
  }

  private webRepresentationRowFromCurrentRead(
    representationId: string,
  ): WebRepresentationRow | null {
    return this.database.query(`
      SELECT id, source_snapshot_id, media_type, adapter_id, adapter_version,
             content_hash, markdown, evicted_at, derived_at
      FROM web_representations
      WHERE id = ?
    `).get(representationId) as WebRepresentationRow | null;
  }

  private webSourceSnapshotProvenance(
    row: WebSourceSnapshotRow,
  ): WebSourceSnapshotProvenance {
    return {
      id: row.id,
      resourceId: row.resource_id,
      addressVersion: row.address_version,
      canonicalUrl: row.canonical_url,
      contentHash: row.content_hash,
      revision: normalizeRetainedResourceRevisionRef(
        parsedJson(row.revision_json, "Web source snapshot revision"),
      ),
      fetchedAt: row.fetched_at,
      bodyAvailable: row.html !== null,
      evictedAt: row.evicted_at ?? null,
    };
  }

  private webRepresentationProvenance(
    row: WebRepresentationRow,
  ): WebRepresentationProvenance {
    return {
      id: row.id,
      sourceSnapshotId: row.source_snapshot_id,
      mediaType: "text/markdown",
      adapter: { id: row.adapter_id, version: row.adapter_version },
      contentHash: row.content_hash,
      derivedAt: row.derived_at,
      contentAvailable: row.markdown !== null,
      evictedAt: row.evicted_at ?? null,
    };
  }


  private webStatusFromCurrentRead(resource: Resource): WebResourceStatus {
    if (resource.provider !== "web") {
      return { freshness: "unknown", checkedAt: null, lastError: null };
    }
    const state = this.webStateRowFromCurrentRead(resource.id);
    if (!state || state.address_version !== resource.addressVersion) {
      return { freshness: "unknown", checkedAt: null, lastError: null };
    }
    let freshness = state.freshness;
    if (freshness === "fresh" && state.checked_at !== null) {
      const checkedAt = Date.parse(state.checked_at);
      const current = Date.parse(this.now());
      if (
        Number.isFinite(checkedAt) &&
        Number.isFinite(current) &&
        current - checkedAt >= this.webStaleAfterMs
      ) {
        freshness = "stale";
      }
    }
    return {
      freshness,
      checkedAt: state.checked_at,
      lastError: state.last_error,
    };
  }

  private webReadFromCurrentRead(
    resource: Extract<Resource, { provider: "web" }>,
    requestedRevision: ResourceRevisionRef | null,
  ): { document: WebResourceDocument | null; history: WebResourceHistory } {
    const state = this.webStateRowFromCurrentRead(resource.id);
    const sourceRows = this.database.query(`
      SELECT id, resource_id, address_version, canonical_url, content_hash,
             revision_json, etag, last_modified, html, evicted_at, fetched_at
      FROM web_source_snapshots
      WHERE resource_id = ?
      ORDER BY fetched_at, id
    `).all(resource.id) as WebSourceSnapshotRow[];
    const representationRows = this.database.query(`
      SELECT wr.id, wr.source_snapshot_id, wr.media_type, wr.adapter_id,
             wr.adapter_version, wr.content_hash, wr.markdown, wr.evicted_at, wr.derived_at
      FROM web_representations wr
      JOIN web_source_snapshots ws ON ws.id = wr.source_snapshot_id
      WHERE ws.resource_id = ?
      ORDER BY wr.derived_at, wr.id
    `).all(resource.id) as WebRepresentationRow[];
    const history: WebResourceHistory = {
      sourceSnapshots: sourceRows.map((row) => this.webSourceSnapshotProvenance(row)),
      representations: representationRows.map((row) =>
        this.webRepresentationProvenance(row)
      ),
    };
    let sourceRow: WebSourceSnapshotRow | null = null;
    let representationRow: WebRepresentationRow | null = null;
    if (requestedRevision) {
      const matchesRequestedRevision = (candidate: WebSourceSnapshotRow): boolean =>
        candidate.address_version === resource.addressVersion &&
        resourceRevisionRefEquals(
          normalizeRetainedResourceRevisionRef(
            parsedJson(candidate.revision_json, "Web source snapshot revision"),
          ),
          requestedRevision,
        );
      sourceRow = sourceRows.find((candidate) =>
        candidate.id === state?.source_snapshot_id &&
        matchesRequestedRevision(candidate)
      ) ?? null;
      if (!sourceRow) {
        for (let index = sourceRows.length - 1; index >= 0; index -= 1) {
          const candidate = sourceRows[index];
          if (candidate && matchesRequestedRevision(candidate)) {
            sourceRow = candidate;
            break;
          }
        }
      }
      if (sourceRow) {
        const sourceSnapshotId = sourceRow.id;
        representationRow = representationRows.find((candidate) =>
          candidate.id === state?.representation_id &&
          candidate.source_snapshot_id === sourceSnapshotId &&
          candidate.markdown !== null
        ) ?? null;
        if (!representationRow) {
          for (let index = representationRows.length - 1; index >= 0; index -= 1) {
            const candidate = representationRows[index];
            if (
              candidate?.source_snapshot_id === sourceSnapshotId &&
              candidate.markdown !== null
            ) {
              representationRow = candidate;
              break;
            }
          }
        }
      }
    } else {
      if (
        state?.address_version === resource.addressVersion &&
        state.source_snapshot_id &&
        state.representation_id
      ) {
        sourceRow = sourceRows.find((candidate) =>
          candidate.id === state.source_snapshot_id &&
          candidate.address_version === resource.addressVersion
        ) ?? null;
        representationRow = representationRows.find((candidate) =>
          candidate.id === state.representation_id &&
          candidate.source_snapshot_id === sourceRow?.id &&
          candidate.markdown !== null
        ) ?? null;
      }
      if (!sourceRow || !representationRow) {
        const selectNewest = (activeAdapterOnly: boolean): boolean => {
          for (let index = representationRows.length - 1; index >= 0; index -= 1) {
            const candidate = representationRows[index];
            if (
              !candidate ||
              candidate.markdown === null ||
              (
                activeAdapterOnly &&
                (
                  candidate.adapter_id !== this.webExtractor.adapter.id ||
                  candidate.adapter_version !== this.webExtractor.adapter.version
                )
              )
            ) continue;
            const candidateSource = sourceRows.find((sourceCandidate) =>
              sourceCandidate.id === candidate.source_snapshot_id &&
              sourceCandidate.address_version === resource.addressVersion
            ) ?? null;
            if (!candidateSource) continue;
            sourceRow = candidateSource;
            representationRow = candidate;
            return true;
          }
          return false;
        };
        selectNewest(true) || selectNewest(false);
      }
    }
    if (!sourceRow || !representationRow || representationRow.markdown === null) {
      return { document: null, history };
    }
    return {
      document: {
        markdown: representationRow.markdown,
        sourceSnapshot: this.webSourceSnapshotProvenance(sourceRow),
        representation: this.webRepresentationProvenance(representationRow),
      },
      history,
    };
  }

  private async performComputedExecution(
    resourceId: string,
    destinationHostRegistered: boolean,
  ): Promise<ComputedExecutionReceipt> {
    const initial = this.database.transaction((): ComputedExecutionInitial => {
      const resource = this.requireFromCurrentRead(resourceId);
      if (resource.provider !== "computed") {
        throw new ResourceCatalogError(
          "provider-mismatch",
          "Computed execution requires a computed Resource",
        );
      }
      const source = this.requireSourceFromCurrentRead(resource.sourceId);
      if (source.provider !== "computed") {
        throw new ResourceCatalogError(
          "provider-mismatch",
          "Computed Resource source does not use the computed provider",
        );
      }
      const invocation = this.requireComputedInvocationFromCurrentRead(
        resource.address.invocationId,
      );
      if (
        invocation.resourceId !== resource.id ||
        invocation.sourceId !== source.id
      ) {
        throw new ResourceCatalogError(
          "invalid-input",
          "Computed invocation ownership does not match its Resource",
        );
      }
      const state = this.computedStateRowFromCurrentRead(resource.id);
      if (!state) {
        throw new ResourceCatalogError(
          "invalid-input",
          "Computed Resource state is unavailable",
        );
      }
      const generation = state.generation + 1;
      const id = crypto.randomUUID();
      const startedAt = this.now();
      const dependencyFingerprint = canonicalJsonHash(invocation.dependencies);
      this.database.query(`
        UPDATE computed_resource_state
        SET generation = ?,
            status = 'executing',
            last_failure_execution_id = NULL,
            started_at = ?,
            completed_at = NULL
        WHERE resource_id = ?
      `).run(generation, startedAt, resource.id);
      this.database.query(`
        INSERT INTO computed_executions (
          id, invocation_id, resource_id, generation, producer_id,
          producer_version, input_version, dependency_fingerprint,
          dependencies_json, cache_hit, status, output_kind, media_type,
          output_content_hash, representation_id, durable_resource_id,
          failure_code, failure_message, started_at, completed_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'executing', NULL, NULL,
          NULL, NULL, NULL, NULL, NULL, ?, NULL
        )
      `).run(
        id,
        invocation.id,
        resource.id,
        generation,
        invocation.producerId,
        invocation.producerVersion,
        invocation.inputVersion,
        dependencyFingerprint,
        canonicalJson(invocation.dependencies),
        startedAt,
      );
      this.bumpSequence();
      return {
        id,
        generation,
        invocationVersion: invocation.version,
        resource,
        source,
        invocation,
        dependencyFingerprint,
        startedAt,
      };
    })();

    try {
      if (!destinationHostRegistered) {
        return this.completeComputedFailure(
          initial,
          "destination-unavailable",
          "Computed execution requires a registered Detail destination",
        );
      }
      if (
        initial.source.policy.deniedCapabilities.includes("read") ||
        initial.source.policy.deniedCapabilities.includes("refresh")
      ) {
        return this.completeComputedFailure(
          initial,
          "permission-denied",
          "Workspace policy denies computed execution",
        );
      }
      const definition = this.computedProducerRegistry.require(
        initial.invocation.producerId,
        initial.invocation.producerVersion,
      );
      this.computedProducerRegistry.validatePermissions(
        definition,
        initial.source.boundary.allowedPermissions,
      );
      this.computedProducerRegistry.validateInputs(
        definition,
        initial.invocation.inputs,
      );
      const cacheKey =
        initial.invocation.declaration.determinism === "deterministic" &&
          initial.invocation.declaration.cachePolicy === "content-addressed"
          ? canonicalJsonHash({
            producerId: initial.invocation.producerId,
            producerVersion: initial.invocation.producerVersion,
            inputs: initial.invocation.inputs,
            dependencies: initial.invocation.dependencies,
          })
          : null;
      if (cacheKey) {
        const cached = this.database.transaction(() =>
          this.database.query(`
            SELECT id, cache_key, producer_id, producer_version, input_version,
                   dependency_fingerprint, media_type, content_hash, content, created_at
            FROM computed_representations
            WHERE cache_key = ?
          `).get(cacheKey) as ComputedRepresentationRow | null
        )();
        if (cached) {
          return this.completeComputedSuccess(
            initial,
            {
              kind: "immutable-snapshot",
              mediaType: cached.media_type,
              content: cached.content,
            },
            true,
            cacheKey,
            cached,
          );
        }
      }
      const output = await this.computedProducerRegistry.execute({
        producerId: initial.invocation.producerId,
        producerVersion: initial.invocation.producerVersion,
        inputs: initial.invocation.inputs,
        allowedPermissions: initial.source.boundary.allowedPermissions,
        dependencies: initial.invocation.dependencies,
      });
      if (output.kind === "failure") {
        return this.completeComputedFailure(initial, output.code, output.message);
      }
      return this.completeComputedSuccess(initial, output, false, cacheKey);
    } catch (error) {
      if (error instanceof ComputedProducerError) {
        return this.completeComputedFailure(initial, error.code, error.message);
      }
      if (error instanceof ResourceCatalogError) {
        return this.completeComputedFailure(initial, error.code, error.message);
      }
      return this.completeComputedFailure(initial, "execution-failed", errorText(error));
    }
  }

  private computedExecutionIsCurrentFromCurrentRead(
    initial: ComputedExecutionInitial,
  ): boolean {
    const state = this.computedStateRowFromCurrentRead(initial.resource.id);
    const invocation = this.computedInvocationRowFromCurrentRead(initial.invocation.id);
    return state?.generation === initial.generation &&
      state.status === "executing" &&
      invocation?.version === initial.invocationVersion;
  }

  private completeComputedFailure(
    initial: ComputedExecutionInitial,
    code: string,
    message: string,
  ): ComputedExecutionReceipt {
    return this.database.transaction((): ComputedExecutionReceipt => {
      const current = this.computedExecutionIsCurrentFromCurrentRead(initial);
      const failureCode = current ? code : "execution-superseded";
      const failureMessage = current
        ? message
        : "Computed execution was superseded by a newer invocation generation";
      const completedAt = this.now();
      this.database.query(`
        UPDATE computed_executions
        SET status = 'failed',
            output_kind = 'failure',
            failure_code = ?,
            failure_message = ?,
            completed_at = ?
        WHERE id = ? AND status = 'executing'
      `).run(failureCode, failureMessage, completedAt, initial.id);
      if (current) {
        this.database.query(`
          UPDATE computed_resource_state
          SET status = 'failed',
              last_failure_execution_id = ?,
              completed_at = ?
          WHERE resource_id = ? AND generation = ?
        `).run(initial.id, completedAt, initial.resource.id, initial.generation);
      }
      this.bumpSequence();
      return {
        id: initial.id,
        invocationId: initial.invocation.id,
        resourceId: initial.resource.id,
        producerId: initial.invocation.producerId,
        producerVersion: initial.invocation.producerVersion,
        inputVersion: initial.invocation.inputVersion,
        dependencyFingerprint: initial.dependencyFingerprint,
        cacheHit: false,
        output: {
          kind: "failure",
          code: failureCode,
          message: failureMessage,
        },
        startedAt: initial.startedAt,
        completedAt,
      };
    })();
  }

  private completeComputedSuccess(
    initial: ComputedExecutionInitial,
    output: Exclude<ComputedProducerOutput, { kind: "failure" }>,
    cacheHit: boolean,
    cacheKey: string | null,
    cachedRepresentation: ComputedRepresentationRow | null = null,
  ): ComputedExecutionReceipt {
    return this.database.transaction((): ComputedExecutionReceipt => {
      if (!this.computedExecutionIsCurrentFromCurrentRead(initial)) {
        return this.completeComputedFailure(
          initial,
          "execution-superseded",
          "Computed execution was superseded by a newer invocation generation",
        );
      }
      const completedAt = this.now();
      if (output.kind === "transient-representation") {
        this.database.query(`
          UPDATE computed_executions
          SET status = 'succeeded',
              output_kind = 'transient-representation',
              media_type = ?,
              completed_at = ?
          WHERE id = ? AND status = 'executing'
        `).run(output.mediaType, completedAt, initial.id);
        this.database.query(`
          UPDATE computed_resource_state
          SET status = 'succeeded',
              selected_execution_id = ?,
              representation_id = NULL,
              durable_resource_id = NULL,
              last_failure_execution_id = NULL,
              completed_at = ?
          WHERE resource_id = ? AND generation = ?
        `).run(initial.id, completedAt, initial.resource.id, initial.generation);
        this.bumpSequence();
        return {
          id: initial.id,
          invocationId: initial.invocation.id,
          resourceId: initial.resource.id,
          producerId: initial.invocation.producerId,
          producerVersion: initial.invocation.producerVersion,
          inputVersion: initial.invocation.inputVersion,
          dependencyFingerprint: initial.dependencyFingerprint,
          cacheHit,
          output,
          startedAt: initial.startedAt,
          completedAt,
        };
      }
      if (output.kind === "durable-resource") {
        const durable = this.requireFromCurrentRead(output.resourceId);
        if (durable.id === initial.resource.id) {
          return this.completeComputedFailure(
            initial,
            "invalid-output",
            "Computed durable output cannot reference its own Resource",
          );
        }
        this.database.query(`
          UPDATE computed_executions
          SET status = 'succeeded',
              output_kind = 'durable-resource',
              durable_resource_id = ?,
              completed_at = ?
          WHERE id = ? AND status = 'executing'
        `).run(durable.id, completedAt, initial.id);
        this.database.query(`
          UPDATE computed_resource_state
          SET status = 'succeeded',
              selected_execution_id = ?,
              representation_id = NULL,
              durable_resource_id = ?,
              last_failure_execution_id = NULL,
              completed_at = ?
          WHERE resource_id = ? AND generation = ?
        `).run(
          initial.id,
          durable.id,
          completedAt,
          initial.resource.id,
          initial.generation,
        );
        this.bumpSequence();
        return {
          id: initial.id,
          invocationId: initial.invocation.id,
          resourceId: initial.resource.id,
          producerId: initial.invocation.producerId,
          producerVersion: initial.invocation.producerVersion,
          inputVersion: initial.invocation.inputVersion,
          dependencyFingerprint: initial.dependencyFingerprint,
          cacheHit,
          output: { kind: "durable-resource", resourceId: durable.id },
          startedAt: initial.startedAt,
          completedAt,
        };
      }
      const contentHash = byteHash(new TextEncoder().encode(output.content));
      let representation = cachedRepresentation;
      if (!representation) {
        const representationId = crypto.randomUUID();
        if (cacheKey) {
          this.database.query(`
            INSERT OR IGNORE INTO computed_representations (
              id, cache_key, producer_id, producer_version, input_version,
              dependency_fingerprint, media_type, content_hash, content, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            representationId,
            cacheKey,
            initial.invocation.producerId,
            initial.invocation.producerVersion,
            initial.invocation.inputVersion,
            initial.dependencyFingerprint,
            output.mediaType,
            contentHash,
            output.content,
            completedAt,
          );
          representation = this.database.query(`
            SELECT id, cache_key, producer_id, producer_version, input_version,
                   dependency_fingerprint, media_type, content_hash, content, created_at
            FROM computed_representations
            WHERE cache_key = ?
          `).get(cacheKey) as ComputedRepresentationRow | null;
        } else {
          this.database.query(`
            INSERT INTO computed_representations (
              id, cache_key, producer_id, producer_version, input_version,
              dependency_fingerprint, media_type, content_hash, content, created_at
            ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            representationId,
            initial.invocation.producerId,
            initial.invocation.producerVersion,
            initial.invocation.inputVersion,
            initial.dependencyFingerprint,
            output.mediaType,
            contentHash,
            output.content,
            completedAt,
          );
          representation = this.database.query(`
            SELECT id, cache_key, producer_id, producer_version, input_version,
                   dependency_fingerprint, media_type, content_hash, content, created_at
            FROM computed_representations
            WHERE id = ?
          `).get(representationId) as ComputedRepresentationRow | null;
        }
      }
      if (!representation) {
        return this.completeComputedFailure(
          initial,
          "execution-failed",
          "Computed representation could not be persisted",
        );
      }
      this.database.query(`
        UPDATE computed_executions
        SET status = 'succeeded',
            output_kind = 'immutable-snapshot',
            media_type = ?,
            output_content_hash = ?,
            representation_id = ?,
            cache_hit = ?,
            completed_at = ?
        WHERE id = ? AND status = 'executing'
      `).run(
        representation.media_type,
        representation.content_hash,
        representation.id,
        cacheHit ? 1 : 0,
        completedAt,
        initial.id,
      );
      this.database.query(`
        UPDATE computed_resource_state
        SET status = 'succeeded',
            selected_execution_id = ?,
            representation_id = ?,
            durable_resource_id = NULL,
            last_failure_execution_id = NULL,
            completed_at = ?
        WHERE resource_id = ? AND generation = ?
      `).run(
        initial.id,
        representation.id,
        completedAt,
        initial.resource.id,
        initial.generation,
      );
      this.database.query(
        "UPDATE resources SET media_type = ?, updated_at = ? WHERE id = ?",
      ).run(representation.media_type, completedAt, initial.resource.id);
      this.bumpSequence();
      return {
        id: initial.id,
        invocationId: initial.invocation.id,
        resourceId: initial.resource.id,
        producerId: initial.invocation.producerId,
        producerVersion: initial.invocation.producerVersion,
        inputVersion: initial.invocation.inputVersion,
        dependencyFingerprint: initial.dependencyFingerprint,
        cacheHit,
        output: {
          kind: "immutable-snapshot",
          mediaType: representation.media_type,
          content: representation.content,
          contentHash: representation.content_hash,
          representationId: representation.id,
        },
        startedAt: initial.startedAt,
        completedAt,
      };
    })();
  }

  private computedInvocationRowFromCurrentRead(
    invocationId: string,
  ): ComputedInvocationRow | null {
    return this.database.query(`
      SELECT id, resource_id, source_id, producer_id, producer_version, input_version,
             inputs_json, dependencies_json, declaration_json, version, created_at, updated_at
      FROM computed_invocations
      WHERE id = ?
    `).get(invocationId) as ComputedInvocationRow | null;
  }

  private requireComputedInvocationFromCurrentRead(
    invocationId: string,
  ): ComputedInvocation {
    const row = this.computedInvocationRowFromCurrentRead(invocationId);
    if (!row) {
      throw new ResourceCatalogError(
        "missing-resource",
        `Computed invocation not found: ${invocationId}`,
      );
    }
    return computedInvocationFromRow(row);
  }

  private normalizeComputedDependenciesFromCurrentRead(
    values: readonly unknown[],
  ): readonly ResourceRevisionRef[] {
    const dependencies = values.map((value) => {
      if (
        typeof value !== "object" ||
        value === null ||
        !("resourceId" in value)
      ) {
        throw new ResourceCatalogError(
          "invalid-input",
          "Computed dependency must be a Resource revision reference",
        );
      }
      const resource = this.requireFromCurrentRead(
        normalizeResourceId(value.resourceId, "Dependency Resource ID"),
      );
      return normalizeResourceRevisionRef(value, resource);
    }).sort((left, right) => {
      const byResource = left.resourceId.localeCompare(right.resourceId);
      return byResource || canonicalJson(left).localeCompare(canonicalJson(right));
    });
    for (let index = 1; index < dependencies.length; index += 1) {
      if (dependencies[index]?.resourceId === dependencies[index - 1]?.resourceId) {
        throw new ResourceCatalogError(
          "invalid-input",
          `Computed dependencies contain Resource more than once: ${dependencies[index]?.resourceId}`,
        );
      }
    }
    return dependencies;
  }


  private computedStateRowFromCurrentRead(
    resourceId: string,
  ): ComputedResourceStateRow | null {
    return this.database.query(`
      SELECT resource_id, invocation_id, generation, status, selected_execution_id,
             representation_id, durable_resource_id, last_failure_execution_id,
             started_at, completed_at
      FROM computed_resource_state
      WHERE resource_id = ?
    `).get(resourceId) as ComputedResourceStateRow | null;
  }

  private computedDescriptionFromCurrentRead(
    resource: Extract<Resource, { provider: "computed" }>,
    requestedRevision: ResourceRevisionRef | null,
  ): {
    readonly document: ComputedResourceDocument | null;
    readonly status: ComputedResourceStatus;
    readonly failure: ComputedResourceFailure | null;
  } {
    const invocation = this.requireComputedInvocationFromCurrentRead(
      resource.address.invocationId,
    );
    const state = this.computedStateRowFromCurrentRead(resource.id);
    if (!state || state.invocation_id !== invocation.id) {
      throw new ResourceCatalogError(
        "invalid-input",
        `Computed Resource state is unavailable: ${resource.id}`,
      );
    }
    let execution: ComputedExecutionRow | null = null;
    let representation: ComputedRepresentationRow | null = null;
    if (requestedRevision) {
      const revision = requestedRevision.revision;
      if (revision.kind !== "computed") {
        throw new ResourceCatalogError(
          "provider-mismatch",
          "Requested revision is not computed",
        );
      }
      execution = this.database.query(`
        SELECT id, invocation_id, resource_id, generation, producer_id,
               producer_version, input_version, dependency_fingerprint,
               dependencies_json, cache_hit, status, output_kind, media_type,
               output_content_hash, representation_id, durable_resource_id,
               failure_code, failure_message, started_at, completed_at
        FROM computed_executions
        WHERE resource_id = ?
          AND id = ?
          AND producer_id = ?
          AND producer_version = ?
          AND input_version = ?
          AND dependency_fingerprint = ?
          AND status = 'succeeded'
          AND output_kind = 'immutable-snapshot'
        ORDER BY completed_at DESC, id DESC
        LIMIT 1
      `).get(
        resource.id,
        revision.executionId,
        revision.producerId,
        revision.producerVersion,
        revision.inputVersion,
        revision.dependencyFingerprint,
      ) as ComputedExecutionRow | null;
    } else if (state.representation_id) {
      execution = this.database.query(`
        SELECT id, invocation_id, resource_id, generation, producer_id,
               producer_version, input_version, dependency_fingerprint,
               dependencies_json, cache_hit, status, output_kind, media_type,
               output_content_hash, representation_id, durable_resource_id,
               failure_code, failure_message, started_at, completed_at
        FROM computed_executions
        WHERE id = ?
      `).get(state.selected_execution_id) as ComputedExecutionRow | null;
    }
    if (execution?.representation_id) {
      representation = this.database.query(`
        SELECT id, cache_key, producer_id, producer_version, input_version,
               dependency_fingerprint, media_type, content_hash, content, created_at
        FROM computed_representations
        WHERE id = ?
      `).get(execution.representation_id) as ComputedRepresentationRow | null;
    }
    let document: ComputedResourceDocument | null = null;
    if (
      execution &&
      representation &&
      representation.media_type === "text/markdown"
    ) {
      const dependenciesValue = parsedJson(
        execution.dependencies_json,
        "Computed execution dependencies",
      );
      if (!Array.isArray(dependenciesValue)) {
        throw new ResourceCatalogError(
          "invalid-input",
          "Stored computed execution dependencies are invalid",
        );
      }
      const dependencies = dependenciesValue.map(normalizeRetainedResourceRevisionRef);
      document = {
        markdown: representation.content,
        mediaType: "text/markdown",
        contentHash: representation.content_hash,
        representationId: representation.id,
        revision: {
          resourceId: resource.id,
          addressVersion: resource.addressVersion,
          revision: {
            kind: "computed",
            executionId: execution.id,
            producerId: execution.producer_id,
            producerVersion: execution.producer_version,
            inputVersion: execution.input_version,
            dependencyFingerprint: execution.dependency_fingerprint,
          },
        },
        dependencies,
        adapter: COMPUTED_MARKDOWN_ADAPTER,
        derivedAt: representation.created_at,
      };
    }
    let failure: ComputedResourceFailure | null = null;
    if (state.last_failure_execution_id) {
      const row = this.database.query(`
        SELECT id, failure_code, failure_message, completed_at
        FROM computed_executions
        WHERE id = ? AND status = 'failed'
      `).get(state.last_failure_execution_id) as Pick<
        ComputedExecutionRow,
        "id" | "failure_code" | "failure_message" | "completed_at"
      > | null;
      if (row?.failure_code && row.failure_message && row.completed_at) {
        failure = {
          executionId: row.id,
          code: row.failure_code,
          message: row.failure_message,
          failedAt: row.completed_at,
        };
      }
    }
    return {
      document,
      status: {
        state: state.status,
        generation: state.generation,
        lastExecutionAt: state.completed_at,
      },
      failure,
    };
  }

  private assertConfinement(
    source: ResourceSource,
    rootBinding: string | null,
    address: ResourceAddress,
  ): void {
    if (source.provider === "filesystem" && address.kind === "filesystem") {
      assertFilesystemConfinement(source, rootBinding, address);
      return;
    }
    if (source.provider !== address.kind) {
      throw new ResourceCatalogError(
        "provider-mismatch",
        `Resource address ${address.kind} does not match source ${source.provider}`,
      );
    }
  }

  private getSourceFromCurrentRead(sourceId: string): ResourceSource | null {
    const row = this.database.query(
      "SELECT id, name, provider, boundary_json, policy_json, root_binding, version, created_at, updated_at FROM resource_sources WHERE id = ?",
    ).get(sourceId) as SourceRow | null;
    return row ? sourceFromRow(row) : null;
  }

  private requireSourceFromCurrentRead(sourceId: string): ResourceSource {
    const source = this.getSourceFromCurrentRead(sourceId);
    if (!source) {
      throw new ResourceCatalogError("missing-source", `Resource source not found: ${sourceId}`);
    }
    return source;
  }

  private requireSourceRowFromCurrentRead(sourceId: string): SourceRow {
    const row = this.database.query(
      "SELECT id, name, provider, boundary_json, policy_json, root_binding, version, created_at, updated_at FROM resource_sources WHERE id = ?",
    ).get(sourceId) as SourceRow | null;
    if (!row) {
      throw new ResourceCatalogError("missing-source", `Resource source not found: ${sourceId}`);
    }
    return row;
  }

  private resourceRowByKeyFromCurrentRead(
    sourceId: string,
    canonicalKey: string,
  ): ResourceRow | null {
    return this.database.query(
      "SELECT id, source_id, provider, address_json, canonical_key, media_type, address_version, version, created_at, updated_at FROM resources WHERE source_id = ? AND canonical_key = ?",
    ).get(sourceId, canonicalKey) as ResourceRow | null;
  }

  private getFromCurrentRead(resourceId: string): Resource | null {
    const row = this.database.query(
      "SELECT id, source_id, provider, address_json, canonical_key, media_type, address_version, version, created_at, updated_at FROM resources WHERE id = ?",
    ).get(resourceId) as ResourceRow | null;
    if (!row) return null;
    return resourceFromRow(row, this.requireSourceFromCurrentRead(row.source_id));
  }

  private requireFromCurrentRead(resourceId: string): Resource {
    const resource = this.getFromCurrentRead(resourceId);
    if (!resource) {
      throw new ResourceCatalogError("missing-resource", `Resource not found: ${resourceId}`);
    }
    return resource;
  }

  private bumpSequence(): void {
    this.database.query(
      "UPDATE metadata SET value = CAST(value AS INTEGER) + 1 WHERE key = 'sequence'",
    ).run();
  }

  private upgradeResourceProviderConstraints(): void {
    const schemas = this.database.query(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('resource_sources', 'resources')",
    ).all() as Array<{ name: string; sql: string | null }>;
    if (schemas.length !== 2) return;
    const sourceColumns = this.database.query("PRAGMA table_info(resource_sources)").all() as
      Array<{ name: string }>;
    if (!sourceColumns.some(({ name }) => name === "boundary_json")) return;
    if (
      schemas.every(({ sql }) =>
        sql?.includes("'jira'") &&
        sql.includes("'linear'") &&
        sql.includes("'computed'")
      )
    ) return;

    const foreignKeyState = this.database.query("PRAGMA foreign_keys").get() as {
      foreign_keys: number;
    };
    const legacyAlterTableState = this.database.query("PRAGMA legacy_alter_table").get() as {
      legacy_alter_table: number;
    };
    const foreignKeys = foreignKeyState.foreign_keys;
    const legacyAlterTable = legacyAlterTableState.legacy_alter_table;
    this.database.exec("PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = ON;");
    try {
      this.database.transaction(() => {
        this.database.exec(`
          CREATE TABLE resource_sources_pie255 (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            provider TEXT NOT NULL
              CHECK (provider IN ('filesystem', 'web', 'github', 'application', 'jira', 'linear', 'computed')),
            boundary_json TEXT NOT NULL,
            policy_json TEXT NOT NULL,
            root_binding TEXT,
            version INTEGER NOT NULL CHECK (version >= 1),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          INSERT INTO resource_sources_pie255
            (id, name, provider, boundary_json, policy_json, root_binding, version, created_at, updated_at)
          SELECT id, name, provider, boundary_json, policy_json, root_binding, version, created_at, updated_at
          FROM resource_sources;

          CREATE TABLE resources_pie255 (
            id TEXT PRIMARY KEY,
            source_id TEXT NOT NULL REFERENCES resource_sources(id) ON DELETE RESTRICT,
            provider TEXT NOT NULL
              CHECK (provider IN ('filesystem', 'web', 'github', 'application', 'jira', 'linear', 'computed')),
            address_json TEXT NOT NULL,
            canonical_key TEXT NOT NULL,
            media_type TEXT,
            address_version INTEGER NOT NULL CHECK (address_version >= 1),
            version INTEGER NOT NULL CHECK (version >= 1),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE (source_id, canonical_key)
          );
          INSERT INTO resources_pie255
            (id, source_id, provider, address_json, canonical_key, media_type,
             address_version, version, created_at, updated_at)
          SELECT id, source_id, provider, address_json, canonical_key, media_type,
                 address_version, version, created_at, updated_at
          FROM resources;

          DROP TABLE resources;
          DROP TABLE resource_sources;
          ALTER TABLE resource_sources_pie255 RENAME TO resource_sources;
          ALTER TABLE resources_pie255 RENAME TO resources;
          CREATE INDEX resource_sources_provider
            ON resource_sources(provider, name, id);
        `);
        const violations = this.database.query("PRAGMA foreign_key_check").all();
        if (violations.length > 0) {
          throw new ResourceCatalogError(
            "invalid-input",
            "Resource provider migration would leave broken foreign keys",
          );
        }
      })();
    } finally {
      this.database.exec(
        `PRAGMA legacy_alter_table = ${legacyAlterTable === 0 ? "OFF" : "ON"};`,
      );
      this.database.exec(`PRAGMA foreign_keys = ${foreignKeys === 0 ? "OFF" : "ON"};`);
    }
  }

  private migrate(): void {
    this.upgradeResourceProviderConstraints();
    this.database.transaction(() => {
      const sourceColumns = this.database.query("PRAGMA table_info(resource_sources)").all() as
        Array<{ name: string }>;
      const legacy = sourceColumns.length > 0 &&
        !sourceColumns.some(({ name }) => name === "boundary_json");
      if (legacy) {
        this.database.exec(`
          ALTER TABLE resources RENAME TO resources_legacy_pie247;
          ALTER TABLE resource_sources RENAME TO resource_sources_legacy_pie247;
        `);
      }
      const documentColumns = this.database.query(
        "PRAGMA table_info(web_resource_documents)",
      ).all() as Array<{ name: string }>;
      const annotationColumns = this.database.query(
        "PRAGMA table_info(web_resource_annotations)",
      ).all() as Array<{ name: string }>;
      const migratePie251Documents = documentColumns.length > 0;
      const migratePie251Annotations = annotationColumns.length > 0 &&
        !annotationColumns.some(({ name }) => name === "source_snapshot_id");
      if (migratePie251Documents) {
        this.database.exec(
          "ALTER TABLE web_resource_documents RENAME TO web_resource_documents_legacy_pie251",
        );
      }
      if (migratePie251Annotations) {
        this.database.exec(`
          DROP INDEX IF EXISTS web_resource_annotations_resource;
          ALTER TABLE web_resource_annotations
            RENAME TO web_resource_annotations_legacy_pie251;
        `);
      }
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS resource_sources (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          provider TEXT NOT NULL CHECK (provider IN ('filesystem', 'web', 'github', 'application', 'jira', 'linear', 'computed')),
          boundary_json TEXT NOT NULL,
          policy_json TEXT NOT NULL,
          root_binding TEXT,
          version INTEGER NOT NULL CHECK (version >= 1),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS resource_sources_provider
          ON resource_sources(provider, name, id);
        CREATE TABLE IF NOT EXISTS resources (
          id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL REFERENCES resource_sources(id) ON DELETE RESTRICT,
          provider TEXT NOT NULL CHECK (provider IN ('filesystem', 'web', 'github', 'application', 'jira', 'linear', 'computed')),
          address_json TEXT NOT NULL,
          canonical_key TEXT NOT NULL,
          media_type TEXT,
          address_version INTEGER NOT NULL CHECK (address_version >= 1),
          version INTEGER NOT NULL CHECK (version >= 1),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (source_id, canonical_key)
        );
        CREATE TABLE IF NOT EXISTS web_source_snapshots (
          id TEXT PRIMARY KEY,
          resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE RESTRICT,
          address_version INTEGER NOT NULL CHECK (address_version >= 1),
          canonical_url TEXT,
          content_hash TEXT,
          revision_json TEXT NOT NULL,
          etag TEXT,
          last_modified TEXT,
          html TEXT,
          fetched_at TEXT,
          payload_state TEXT NOT NULL DEFAULT 'available'
            CHECK (payload_state IN ('available','evicted')),
          payload_bytes INTEGER NOT NULL DEFAULT 0 CHECK (payload_bytes >= 0),
          evicted_at TEXT
        );
        CREATE INDEX IF NOT EXISTS web_source_snapshots_resource
          ON web_source_snapshots(resource_id, address_version, fetched_at, id);
        CREATE UNIQUE INDEX IF NOT EXISTS web_source_snapshots_available_content
          ON web_source_snapshots(
            resource_id, address_version, canonical_url, content_hash, revision_json
          )
          WHERE html IS NOT NULL AND canonical_url IS NOT NULL AND content_hash IS NOT NULL;
        CREATE TABLE IF NOT EXISTS web_representations (
          id TEXT PRIMARY KEY,
          source_snapshot_id TEXT NOT NULL
            REFERENCES web_source_snapshots(id) ON DELETE RESTRICT,
          media_type TEXT NOT NULL CHECK (media_type = 'text/markdown'),
          adapter_id TEXT NOT NULL,
          adapter_version INTEGER NOT NULL CHECK (adapter_version >= 1),
          content_hash TEXT NOT NULL,
          markdown TEXT,
          derived_at TEXT,
          payload_state TEXT NOT NULL DEFAULT 'available'
            CHECK (payload_state IN ('available','evicted')),
          payload_bytes INTEGER NOT NULL DEFAULT 0 CHECK (payload_bytes >= 0),
          evicted_at TEXT
        );
        CREATE INDEX IF NOT EXISTS web_representations_snapshot
          ON web_representations(source_snapshot_id, derived_at, id);
        CREATE UNIQUE INDEX IF NOT EXISTS web_representations_available_content
          ON web_representations(
            source_snapshot_id, media_type, adapter_id, adapter_version, content_hash
          )
          WHERE markdown IS NOT NULL;
        CREATE TABLE IF NOT EXISTS web_resource_state (
          resource_id TEXT PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
          address_version INTEGER NOT NULL CHECK (address_version >= 1),
          generation INTEGER NOT NULL CHECK (generation >= 1),
          source_snapshot_id TEXT REFERENCES web_source_snapshots(id) ON DELETE RESTRICT,
          representation_id TEXT REFERENCES web_representations(id) ON DELETE RESTRICT,
          freshness TEXT NOT NULL
            CHECK (freshness IN ('fresh', 'stale', 'unknown', 'refreshing', 'failed')),
          checked_at TEXT,
          last_error TEXT
        );
        CREATE TABLE IF NOT EXISTS pdf_source_snapshots (
          id TEXT PRIMARY KEY,
          resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE RESTRICT,
          address_version INTEGER NOT NULL CHECK (address_version >= 1),
          locator TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          revision_json TEXT NOT NULL,
          etag TEXT,
          last_modified TEXT,
          bytes BLOB,
          captured_at TEXT NOT NULL,
          payload_state TEXT NOT NULL DEFAULT 'available'
            CHECK (payload_state IN ('available','evicted')),
          payload_bytes INTEGER NOT NULL DEFAULT 0 CHECK (payload_bytes >= 0),
          evicted_at TEXT
        );
        CREATE INDEX IF NOT EXISTS pdf_source_snapshots_resource
          ON pdf_source_snapshots(resource_id, address_version, captured_at, id);
        CREATE UNIQUE INDEX IF NOT EXISTS pdf_source_snapshots_content
          ON pdf_source_snapshots(resource_id, address_version, content_hash, revision_json);
        CREATE TABLE IF NOT EXISTS pdf_representations (
          id TEXT PRIMARY KEY,
          source_snapshot_id TEXT NOT NULL
            REFERENCES pdf_source_snapshots(id) ON DELETE RESTRICT,
          media_type TEXT NOT NULL
            CHECK (media_type IN ('application/pdf', 'text/markdown')),
          adapter_id TEXT NOT NULL,
          adapter_version INTEGER NOT NULL CHECK (adapter_version >= 1),
          content_hash TEXT NOT NULL,
          markdown TEXT,
          pages_json TEXT,
          derived_at TEXT NOT NULL,
          payload_state TEXT NOT NULL DEFAULT 'available'
            CHECK (payload_state IN ('available','evicted')),
          payload_bytes INTEGER NOT NULL DEFAULT 0 CHECK (payload_bytes >= 0),
          evicted_at TEXT,
          CHECK (
            (media_type = 'application/pdf' AND markdown IS NULL AND pages_json IS NULL) OR
            (
              media_type = 'text/markdown' AND
              (
                (payload_state = 'available' AND markdown IS NOT NULL AND pages_json IS NOT NULL) OR
                (payload_state = 'evicted' AND markdown IS NULL AND pages_json IS NULL)
              )
            )
          )
        );
        CREATE INDEX IF NOT EXISTS pdf_representations_snapshot
          ON pdf_representations(source_snapshot_id, derived_at, id);
        CREATE UNIQUE INDEX IF NOT EXISTS pdf_representations_content
          ON pdf_representations(
            source_snapshot_id, media_type, adapter_id, adapter_version, content_hash
          );
        CREATE TABLE IF NOT EXISTS pdf_resource_state (
          resource_id TEXT PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
          address_version INTEGER NOT NULL CHECK (address_version >= 1),
          generation INTEGER NOT NULL CHECK (generation >= 1),
          source_snapshot_id TEXT REFERENCES pdf_source_snapshots(id) ON DELETE RESTRICT,
          representation_id TEXT REFERENCES pdf_representations(id) ON DELETE RESTRICT
        );
        CREATE TABLE IF NOT EXISTS remote_entity_source_snapshots (
          id TEXT PRIMARY KEY,
          resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE RESTRICT,
          address_version INTEGER NOT NULL CHECK (address_version >= 1),
          provider TEXT NOT NULL CHECK (provider IN ('jira', 'linear')),
          entity_id TEXT NOT NULL,
          revision_json TEXT NOT NULL,
          payload_json TEXT,
          captured_at TEXT NOT NULL,
          payload_state TEXT NOT NULL DEFAULT 'available'
            CHECK (payload_state IN ('available','evicted')),
          payload_bytes INTEGER NOT NULL DEFAULT 0 CHECK (payload_bytes >= 0),
          evicted_at TEXT
        );
        CREATE INDEX IF NOT EXISTS remote_entity_source_snapshots_resource
          ON remote_entity_source_snapshots(resource_id, address_version, captured_at, id);
        CREATE UNIQUE INDEX IF NOT EXISTS remote_entity_source_snapshots_revision
          ON remote_entity_source_snapshots(
            resource_id, address_version, provider, entity_id, revision_json
          );
        CREATE TABLE IF NOT EXISTS remote_entity_representations (
          id TEXT PRIMARY KEY,
          source_snapshot_id TEXT NOT NULL
            REFERENCES remote_entity_source_snapshots(id) ON DELETE RESTRICT,
          media_type TEXT NOT NULL CHECK (media_type = 'text/markdown'),
          adapter_id TEXT NOT NULL,
          version INTEGER NOT NULL CHECK (version >= 1),
          content_hash TEXT NOT NULL,
          markdown TEXT,
          derived_at TEXT NOT NULL,
          payload_state TEXT NOT NULL DEFAULT 'available'
            CHECK (payload_state IN ('available','evicted')),
          payload_bytes INTEGER NOT NULL DEFAULT 0 CHECK (payload_bytes >= 0),
          evicted_at TEXT
        );
        CREATE INDEX IF NOT EXISTS remote_entity_representations_snapshot
          ON remote_entity_representations(source_snapshot_id, derived_at, id);
        CREATE UNIQUE INDEX IF NOT EXISTS remote_entity_representations_content
          ON remote_entity_representations(
            source_snapshot_id, media_type, adapter_id, version, content_hash
          );
        CREATE TABLE IF NOT EXISTS remote_entity_resource_state (
          resource_id TEXT PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
          address_version INTEGER NOT NULL CHECK (address_version >= 1),
          generation INTEGER NOT NULL CHECK (generation >= 1),
          source_snapshot_id TEXT
            REFERENCES remote_entity_source_snapshots(id) ON DELETE RESTRICT,
          representation_id TEXT
            REFERENCES remote_entity_representations(id) ON DELETE RESTRICT,
          freshness TEXT NOT NULL
            CHECK (freshness IN ('fresh', 'stale', 'unknown', 'refreshing', 'failed')),
          checked_at TEXT,
          last_error TEXT
        );
        CREATE TABLE IF NOT EXISTS computed_invocations (
          id TEXT PRIMARY KEY,
          resource_id TEXT NOT NULL UNIQUE REFERENCES resources(id) ON DELETE RESTRICT,
          source_id TEXT NOT NULL REFERENCES resource_sources(id) ON DELETE RESTRICT,
          producer_id TEXT NOT NULL,
          producer_version INTEGER NOT NULL CHECK (producer_version >= 1),
          input_version INTEGER NOT NULL CHECK (input_version >= 1),
          inputs_json TEXT NOT NULL,
          dependencies_json TEXT NOT NULL,
          declaration_json TEXT NOT NULL,
          version INTEGER NOT NULL CHECK (version >= 1),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS computed_invocations_source
          ON computed_invocations(source_id, producer_id, id);
        CREATE TABLE IF NOT EXISTS computed_representations (
          id TEXT PRIMARY KEY,
          cache_key TEXT,
          producer_id TEXT NOT NULL,
          producer_version INTEGER NOT NULL CHECK (producer_version >= 1),
          input_version INTEGER NOT NULL CHECK (input_version >= 1),
          dependency_fingerprint TEXT NOT NULL,
          media_type TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS computed_representations_cache_key
          ON computed_representations(cache_key)
          WHERE cache_key IS NOT NULL;
        CREATE TABLE IF NOT EXISTS computed_executions (
          id TEXT PRIMARY KEY,
          invocation_id TEXT NOT NULL
            REFERENCES computed_invocations(id) ON DELETE RESTRICT,
          resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE RESTRICT,
          generation INTEGER NOT NULL CHECK (generation >= 1),
          producer_id TEXT NOT NULL,
          producer_version INTEGER NOT NULL CHECK (producer_version >= 1),
          input_version INTEGER NOT NULL CHECK (input_version >= 1),
          dependency_fingerprint TEXT NOT NULL,
          dependencies_json TEXT NOT NULL,
          cache_hit INTEGER NOT NULL DEFAULT 0 CHECK (cache_hit IN (0, 1)),
          status TEXT NOT NULL CHECK (status IN ('executing', 'succeeded', 'failed')),
          output_kind TEXT CHECK (
            output_kind IS NULL OR output_kind IN (
              'transient-representation',
              'immutable-snapshot',
              'durable-resource',
              'failure'
            )
          ),
          media_type TEXT,
          output_content_hash TEXT,
          representation_id TEXT
            REFERENCES computed_representations(id) ON DELETE RESTRICT,
          durable_resource_id TEXT REFERENCES resources(id) ON DELETE RESTRICT,
          failure_code TEXT,
          failure_message TEXT,
          started_at TEXT NOT NULL,
          completed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS computed_executions_resource
          ON computed_executions(resource_id, started_at, id);
        CREATE TABLE IF NOT EXISTS computed_resource_state (
          resource_id TEXT PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
          invocation_id TEXT NOT NULL UNIQUE
            REFERENCES computed_invocations(id) ON DELETE RESTRICT,
          generation INTEGER NOT NULL CHECK (generation >= 1),
          status TEXT NOT NULL CHECK (status IN ('idle', 'executing', 'succeeded', 'failed')),
          selected_execution_id TEXT
            REFERENCES computed_executions(id) ON DELETE RESTRICT,
          representation_id TEXT
            REFERENCES computed_representations(id) ON DELETE RESTRICT,
          durable_resource_id TEXT REFERENCES resources(id) ON DELETE RESTRICT,
          last_failure_execution_id TEXT
            REFERENCES computed_executions(id) ON DELETE RESTRICT,
          started_at TEXT,
          completed_at TEXT
        );
      `);
      if (migratePie251Annotations) {
        this.database.exec(`
          CREATE TABLE web_resource_annotations (
            id TEXT PRIMARY KEY,
            resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE RESTRICT,
            source_snapshot_id TEXT NOT NULL REFERENCES web_source_snapshots(id) ON DELETE RESTRICT,
            representation_id TEXT NOT NULL REFERENCES web_representations(id) ON DELETE RESTRICT,
            revision_json TEXT NOT NULL,
            representation_json TEXT NOT NULL,
            anchor_json TEXT NOT NULL,
            body TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
          CREATE INDEX web_resource_annotations_resource
            ON web_resource_annotations(resource_id, created_at, id);
          CREATE INDEX web_resource_annotations_evidence
            ON web_resource_annotations(source_snapshot_id, representation_id, created_at, id);
        `);
      }
      if (legacy) this.migrateLegacyRows();
      if (migratePie251Documents || migratePie251Annotations) {
        this.migratePie251WebRows(
          migratePie251Documents,
          migratePie251Annotations,
        );
      }
      this.upgradeFilesystemRootBindings();
    })();
  }

  private recoverInterruptedWebRefreshes(): void {
    this.database.transaction(() => {
      const recovered = this.database.query(`
        UPDATE web_resource_state
        SET freshness = 'failed',
            last_error = 'Refresh interrupted before completion'
        WHERE freshness = 'refreshing'
      `).run();
      if (recovered.changes > 0) this.bumpSequence();
    })();
  }

  private recoverInterruptedRemoteEntityRefreshes(): void {
    this.database.transaction(() => {
      const recovered = this.database.query(`
        UPDATE remote_entity_resource_state
        SET freshness = 'failed',
            last_error = 'Refresh interrupted before completion'
        WHERE freshness = 'refreshing'
      `).run();
      if (recovered.changes > 0) this.bumpSequence();
    })();
  }

  private recoverInterruptedComputedExecutions(): void {
    this.database.transaction(() => {
      const interrupted = this.database.query(`
        SELECT id, resource_id, generation
        FROM computed_executions
        WHERE status = 'executing'
        ORDER BY started_at, id
      `).all() as Array<{ id: string; resource_id: string; generation: number }>;
      if (interrupted.length === 0) return;
      const completedAt = this.now();
      for (const execution of interrupted) {
        this.database.query(`
          UPDATE computed_executions
          SET status = 'failed',
              output_kind = 'failure',
              failure_code = 'execution-interrupted',
              failure_message = 'Computed execution interrupted before completion',
              completed_at = ?
          WHERE id = ? AND status = 'executing'
        `).run(completedAt, execution.id);
        this.database.query(`
          UPDATE computed_resource_state
          SET status = 'failed',
              last_failure_execution_id = ?,
              completed_at = ?
          WHERE resource_id = ?
            AND generation = ?
            AND status = 'executing'
        `).run(
          execution.id,
          completedAt,
          execution.resource_id,
          execution.generation,
        );
      }
      this.bumpSequence();
    })();
  }

  private migratePie251WebRows(
    migrateDocuments: boolean,
    migrateAnnotations: boolean,
  ): void {
    if (migrateDocuments) {
      const documents = this.database.query(`
        SELECT resource_id, address_version, generation, canonical_url, source_hash,
               markdown, revision_json, adapter_id, adapter_version,
               representation_hash, etag, last_modified, freshness, fetched_at,
               checked_at, last_error
        FROM web_resource_documents_legacy_pie251
        ORDER BY resource_id
      `).all() as LegacyWebResourceDocumentRow[];
      for (const row of documents) {
        const revision = normalizeRetainedResourceRevisionRef(
          parsedJson(row.revision_json, "Legacy web resource revision"),
        );
        const sourceSnapshotId = crypto.randomUUID();
        const representationId = crypto.randomUUID();
        this.database.query(`
          INSERT INTO web_source_snapshots (
            id, resource_id, address_version, canonical_url, content_hash,
            revision_json, etag, last_modified, html, fetched_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
        `).run(
          sourceSnapshotId,
          row.resource_id,
          row.address_version,
          row.canonical_url,
          row.source_hash,
          JSON.stringify(revision),
          row.etag,
          row.last_modified,
          row.fetched_at,
        );
        this.database.query(`
          INSERT INTO web_representations (
            id, source_snapshot_id, media_type, adapter_id, adapter_version,
            content_hash, markdown, derived_at
          ) VALUES (?, ?, 'text/markdown', ?, ?, ?, ?, ?)
        `).run(
          representationId,
          sourceSnapshotId,
          row.adapter_id,
          row.adapter_version,
          row.representation_hash,
          row.markdown,
          row.fetched_at,
        );
        this.database.query(`
          INSERT INTO web_resource_state (
            resource_id, address_version, generation, source_snapshot_id,
            representation_id, freshness, checked_at, last_error
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          row.resource_id,
          row.address_version,
          row.generation,
          sourceSnapshotId,
          representationId,
          row.freshness,
          row.checked_at,
          row.last_error,
        );
      }
    }
    if (migrateAnnotations) {
      const annotations = this.database.query(`
        SELECT id, resource_id, revision_json, representation_json,
               anchor_json, body, created_at
        FROM web_resource_annotations_legacy_pie251
        ORDER BY created_at, id
      `).all() as LegacyWebResourceAnnotationRow[];
      for (const row of annotations) {
        const resource = this.requireFromCurrentRead(row.resource_id);
        if (resource.provider !== "web") {
          throw new ResourceCatalogError(
            "provider-mismatch",
            `Legacy web annotation ${row.id} references a non-web resource`,
          );
        }
        const revision = normalizeRetainedResourceRevisionRef(
          parsedJson(row.revision_json, "Legacy web annotation revision"),
        );
        const evidence = parseLegacyRepresentationEvidence(
          parsedJson(
            row.representation_json,
            "Legacy web annotation representation",
          ),
        );
        const sourceRows = this.database.query(`
          SELECT id, resource_id, address_version, canonical_url, content_hash,
                 revision_json, etag, last_modified, html, fetched_at
          FROM web_source_snapshots
          WHERE resource_id = ?
          ORDER BY fetched_at, id
        `).all(row.resource_id) as WebSourceSnapshotRow[];
        let sourceSnapshot = sourceRows.find((candidate) =>
          resourceRevisionRefEquals(
            normalizeRetainedResourceRevisionRef(
              parsedJson(candidate.revision_json, "Web source snapshot revision"),
            ),
            revision,
          )
        ) ?? null;
        if (!sourceSnapshot) {
          const sourceSnapshotId = crypto.randomUUID();
          const contentHash =
            revision.revision.kind === "web" &&
              revision.revision.validator.kind === "content-hash"
              ? revision.revision.validator.value
              : null;
          this.database.query(`
            INSERT INTO web_source_snapshots (
              id, resource_id, address_version, canonical_url, content_hash,
              revision_json, etag, last_modified, html, fetched_at
            ) VALUES (?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, NULL)
          `).run(
            sourceSnapshotId,
            row.resource_id,
            revision.addressVersion,
            contentHash,
            JSON.stringify(revision),
          );
          sourceSnapshot = this.webSourceSnapshotRowFromCurrentRead(sourceSnapshotId);
        }
        if (!sourceSnapshot) {
          throw new ResourceCatalogError(
            "invalid-input",
            `Legacy web annotation ${row.id} source evidence could not be migrated`,
          );
        }
        let representation = this.database.query(`
          SELECT id, source_snapshot_id, media_type, adapter_id, adapter_version,
                 content_hash, markdown, derived_at
          FROM web_representations
          WHERE source_snapshot_id = ? AND media_type = ?
            AND adapter_id = ? AND adapter_version = ? AND content_hash = ?
          ORDER BY derived_at, id
          LIMIT 1
        `).get(
          sourceSnapshot.id,
          evidence.mediaType,
          evidence.adapter.id,
          evidence.adapter.version,
          evidence.contentHash,
        ) as WebRepresentationRow | null;
        if (!representation) {
          const representationId = crypto.randomUUID();
          this.database.query(`
            INSERT INTO web_representations (
              id, source_snapshot_id, media_type, adapter_id, adapter_version,
              content_hash, markdown, derived_at
            ) VALUES (?, ?, 'text/markdown', ?, ?, ?, NULL, NULL)
          `).run(
            representationId,
            sourceSnapshot.id,
            evidence.adapter.id,
            evidence.adapter.version,
            evidence.contentHash,
          );
          representation = this.webRepresentationRowFromCurrentRead(representationId);
        }
        if (!representation) {
          throw new ResourceCatalogError(
            "invalid-input",
            `Legacy web annotation ${row.id} representation evidence could not be migrated`,
          );
        }
        const representationProvenance = this.webRepresentationProvenance(representation);
        this.database.query(`
          INSERT INTO web_resource_annotations (
            id, resource_id, source_snapshot_id, representation_id,
            revision_json, representation_json, anchor_json, body, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          row.id,
          row.resource_id,
          sourceSnapshot.id,
          representation.id,
          JSON.stringify(revision),
          JSON.stringify(representationProvenance),
          row.anchor_json,
          row.body,
          row.created_at,
        );
      }
    }
    if (migrateAnnotations) {
      this.database.exec("DROP TABLE web_resource_annotations_legacy_pie251");
    }
    if (migrateDocuments) {
      this.database.exec("DROP TABLE web_resource_documents_legacy_pie251");
    }
  }

  private upgradeFilesystemRootBindings(): void {
    const rows = this.database.query(
      "SELECT id, name, provider, boundary_json, policy_json, root_binding, version, created_at, updated_at FROM resource_sources WHERE provider = 'filesystem'",
    ).all() as SourceRow[];
    for (const row of rows) {
      if (row.root_binding?.startsWith("{")) continue;
      const source = sourceFromRow(row);
      if (source.provider !== "filesystem") continue;
      this.database.query("UPDATE resource_sources SET root_binding = ? WHERE id = ?")
        .run(filesystemRootBinding(source.boundary.root), source.id);
    }
  }

  private migrateLegacyRows(): void {
    const sources = this.database.query(
      "SELECT id, name, provider, root_locator, capabilities_json, created_at, updated_at FROM resource_sources_legacy_pie247 ORDER BY id",
    ).all() as LegacySourceRow[];
    for (const row of sources) {
      const provider = row.provider === "git" ? "github" : row.provider;
      let input: CreateResourceSourceInput;
      if (provider === "filesystem") {
        input = {
          name: row.name,
          provider: "filesystem",
          boundary: { root: row.root_locator },
        };
      } else if (provider === "web") {
        input = { name: row.name, provider: "web", boundary: { baseUrl: row.root_locator } };
      } else {
        throw new ResourceCatalogError(
          "invalid-input",
          `Cannot migrate provisional resource source provider: ${row.provider}`,
        );
      }
      const normalized = normalizeResourceSourceInput(input);
      const rootBinding = normalized.provider === "filesystem"
        ? filesystemRootBinding(normalized.boundary.root)
        : null;
      this.database.query(
        "INSERT INTO resource_sources (id, name, provider, boundary_json, policy_json, root_binding, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)",
      ).run(
        normalizeResourceId(row.id, "Resource source ID"),
        normalized.name,
        normalized.provider,
        JSON.stringify(normalized.boundary),
        JSON.stringify({ deniedCapabilities: [] }),
        rootBinding,
        row.created_at,
        row.updated_at,
      );
    }
    const resources = this.database.query(
      "SELECT id, source_id, locator, media_type, provider_revision, created_at, updated_at FROM resources_legacy_pie247 ORDER BY id",
    ).all() as LegacyResourceRow[];
    for (const row of resources) {
      if (row.provider_revision !== null) {
        throw new ResourceCatalogError(
          "invalid-input",
          `Cannot migrate provisional scalar provider revision for resource ${row.id}`,
        );
      }
      const sourceRow = this.requireSourceRowFromCurrentRead(row.source_id);
      const source = sourceFromRow(sourceRow);
      const address: ResourceAddress = source.provider === "filesystem"
        ? { kind: "filesystem", path: row.locator }
        : source.provider === "web"
        ? { kind: "web", url: row.locator }
        : (() => {
            throw new ResourceCatalogError(
              "invalid-input",
              `Cannot migrate provisional locator for ${source.provider}`,
            );
          })();
      const normalized = normalizeResourceAddress(source, address);
      this.assertConfinement(source, sourceRow.root_binding, normalized.address);
      this.database.query(
        "INSERT INTO resources (id, source_id, provider, address_json, canonical_key, media_type, address_version, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)",
      ).run(
        normalizeResourceId(row.id),
        source.id,
        source.provider,
        JSON.stringify(normalized.address),
        normalized.canonicalKey,
        row.media_type,
        row.created_at,
        row.updated_at,
      );
    }
    this.database.exec(`
      DROP TABLE resources_legacy_pie247;
      DROP TABLE resource_sources_legacy_pie247;
    `);
  }
}
