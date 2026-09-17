import { Type, type Static } from "typebox";
import { Parse } from "typebox/value";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WINDOWS_ABSOLUTE_PATH = /^(?:[a-z]:[\\/]|[\\/]{2})/i;
const ENCODED_PATH_ESCAPE = /%(?:2e|2f|5c)/i;
const MAX_NAME_LENGTH = 200;
const MAX_LOCATOR_LENGTH = 4_096;
const MAX_MEDIA_TYPE_LENGTH = 255;

export const RESOURCE_CAPABILITIES = [
  "read",
  "write",
  "refresh",
  "watch",
  "query",
  "history",
  "open-external",
  "embed",
  "command",
] as const;

export const RESOURCE_CAPABILITY_FACTORS = [
  "provider",
  "credentials",
  "workspace-policy",
  "destination-host",
  "connectivity",
] as const;

export type ResourceProvider =
  | "filesystem"
  | "web"
  | "github"
  | "jira"
  | "linear"
  | "application"
  | "computed";
export type ResourceCapability = typeof RESOURCE_CAPABILITIES[number];
export type ResourceCapabilityFactor = typeof RESOURCE_CAPABILITY_FACTORS[number];

export interface ResourcePolicy {
  readonly deniedCapabilities: readonly ResourceCapability[];
}

interface ResourceSourceHeader {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly policy: ResourcePolicy;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ResourceSource =
  | ResourceSourceHeader & {
      readonly provider: "filesystem";
      readonly boundary: { readonly kind: "filesystem"; readonly root: string };
    }
  | ResourceSourceHeader & {
      readonly provider: "web";
      readonly boundary: { readonly kind: "web"; readonly baseUrl: string };
    }
  | ResourceSourceHeader & {
      readonly provider: "github";
      readonly boundary: {
        readonly kind: "github";
        readonly origin: string;
        readonly owner: string;
        readonly repository: string;
      };
    }
  | ResourceSourceHeader & {
      readonly provider: "jira";
      readonly boundary: {
        readonly kind: "jira";
        readonly origin: string;
        readonly project: string;
        readonly credentialEnv: string;
      };
    }
  | ResourceSourceHeader & {
      readonly provider: "linear";
      readonly boundary: {
        readonly kind: "linear";
        readonly origin: string;
        readonly workspace: string;
        readonly credentialEnv: string;
      };
    }
  | ResourceSourceHeader & {
      readonly provider: "application";
      readonly boundary: {
        readonly kind: "application";
        readonly scheme: string;
        readonly authority: string;
        readonly namespace: string;
      };
    }
  | ResourceSourceHeader & {
      readonly provider: "computed";
      readonly boundary: {
        readonly kind: "computed";
        readonly registry: string;
        readonly allowedPermissions: readonly string[];
      };
    };

export type CreateResourceSourceInput =
  | {
      readonly name: string;
      readonly provider: "filesystem";
      readonly boundary: { readonly root: string };
      readonly policy?: { readonly deniedCapabilities?: readonly ResourceCapability[] };
    }
  | {
      readonly name: string;
      readonly provider: "web";
      readonly boundary: { readonly baseUrl: string };
      readonly policy?: { readonly deniedCapabilities?: readonly ResourceCapability[] };
    }
  | {
      readonly name: string;
      readonly provider: "github";
      readonly boundary: {
        readonly origin?: string;
        readonly owner: string;
        readonly repository: string;
      };
      readonly policy?: { readonly deniedCapabilities?: readonly ResourceCapability[] };
    }
  | {
      readonly name: string;
      readonly provider: "jira";
      readonly boundary: {
        readonly origin: string;
        readonly project: string;
        readonly credentialEnv: string;
      };
      readonly policy?: { readonly deniedCapabilities?: readonly ResourceCapability[] };
    }
  | {
      readonly name: string;
      readonly provider: "linear";
      readonly boundary: {
        readonly origin: string;
        readonly workspace: string;
        readonly credentialEnv: string;
      };
      readonly policy?: { readonly deniedCapabilities?: readonly ResourceCapability[] };
    }
  | {
      readonly name: string;
      readonly provider: "application";
      readonly boundary: {
        readonly scheme: string;
        readonly authority: string;
        readonly namespace: string;
      };
      readonly policy?: { readonly deniedCapabilities?: readonly ResourceCapability[] };
    }
  | {
      readonly name: string;
      readonly provider: "computed";
      readonly boundary: {
        readonly registry: string;
        readonly allowedPermissions: readonly string[];
      };
      readonly policy?: { readonly deniedCapabilities?: readonly ResourceCapability[] };
    };

type NormalizedResourceSourceInput =
  | {
      readonly name: string;
      readonly provider: "filesystem";
      readonly boundary: { readonly root: string };
      readonly policy: ResourcePolicy;
    }
  | {
      readonly name: string;
      readonly provider: "web";
      readonly boundary: { readonly baseUrl: string };
      readonly policy: ResourcePolicy;
    }
  | {
      readonly name: string;
      readonly provider: "github";
      readonly boundary: {
        readonly origin: string;
        readonly owner: string;
        readonly repository: string;
      };
      readonly policy: ResourcePolicy;
    }
  | {
      readonly name: string;
      readonly provider: "jira";
      readonly boundary: {
        readonly origin: string;
        readonly project: string;
        readonly credentialEnv: string;
      };
      readonly policy: ResourcePolicy;
    }
  | {
      readonly name: string;
      readonly provider: "linear";
      readonly boundary: {
        readonly origin: string;
        readonly workspace: string;
        readonly credentialEnv: string;
      };
      readonly policy: ResourcePolicy;
    }
  | {
      readonly name: string;
      readonly provider: "application";
      readonly boundary: {
        readonly scheme: string;
        readonly authority: string;
        readonly namespace: string;
      };
      readonly policy: ResourcePolicy;
    }
  | {
      readonly name: string;
      readonly provider: "computed";
      readonly boundary: {
        readonly registry: string;
        readonly allowedPermissions: readonly string[];
      };
      readonly policy: ResourcePolicy;
    };

export type ResourceAddress =
  | { readonly kind: "filesystem"; readonly path: string }
  | { readonly kind: "web"; readonly url: string }
  | {
      readonly kind: "github";
      readonly entity: "issue" | "pull-request";
      readonly number: number;
    }
  | {
      readonly kind: "jira";
      readonly entityId: string;
      readonly key: string;
    }
  | {
      readonly kind: "linear";
      readonly entityId: string;
      readonly identifier: string;
    }
  | { readonly kind: "application"; readonly uri: string }
  | { readonly kind: "computed"; readonly invocationId: string };

interface ResourceHeader {
  readonly id: string;
  readonly sourceId: string;
  readonly version: number;
  readonly addressVersion: number;
  readonly mediaType: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type Resource =
  | ResourceHeader & { readonly provider: "filesystem"; readonly address: Extract<ResourceAddress, { kind: "filesystem" }> }
  | ResourceHeader & { readonly provider: "web"; readonly address: Extract<ResourceAddress, { kind: "web" }> }
  | ResourceHeader & { readonly provider: "github"; readonly address: Extract<ResourceAddress, { kind: "github" }> }
  | ResourceHeader & { readonly provider: "jira"; readonly address: Extract<ResourceAddress, { kind: "jira" }> }
  | ResourceHeader & { readonly provider: "linear"; readonly address: Extract<ResourceAddress, { kind: "linear" }> }
  | ResourceHeader & { readonly provider: "application"; readonly address: Extract<ResourceAddress, { kind: "application" }> }
  | ResourceHeader & { readonly provider: "computed"; readonly address: Extract<ResourceAddress, { kind: "computed" }> };

export type ResourceRevision =
  | {
      readonly kind: "filesystem";
      readonly mtimeNs: string;
      readonly size: string;
    }
  | {
      readonly kind: "web";
      readonly validator:
        | { readonly kind: "etag"; readonly value: string; readonly weak: boolean }
        | { readonly kind: "last-modified"; readonly value: string }
        | { readonly kind: "content-hash"; readonly value: string };
    }
  | {
      readonly kind: "github";
      readonly validator:
        | { readonly kind: "etag"; readonly value: string }
        | { readonly kind: "updated-at"; readonly value: string };
    }
  | {
      readonly kind: "jira";
      readonly validator: { readonly kind: "updated-at"; readonly value: string };
    }
  | {
      readonly kind: "linear";
      readonly validator: { readonly kind: "updated-at"; readonly value: string };
    }
  | {
      readonly kind: "computed";
      readonly executionId: string;
      readonly producerId: string;
      readonly producerVersion: number;
      readonly inputVersion: number;
      readonly dependencyFingerprint: string;
    };

export interface ResourceRevisionRef {
  readonly resourceId: string;
  readonly addressVersion: number;
  readonly revision: ResourceRevision;
}

export interface ComputedProducerDeclarationSnapshot {
  readonly id: string;
  readonly version: number;
  readonly permissions: readonly string[];
  readonly determinism: "deterministic" | "nondeterministic";
  readonly cachePolicy: "none" | "content-addressed";
  readonly outputMediaTypes: readonly string[];
}

export interface CreateComputedInvocationInput {
  readonly sourceId: string;
  readonly producerId: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly dependencies: readonly ResourceRevisionRef[];
}

export interface ReviseComputedInvocationInput {
  readonly invocationId: string;
  readonly expectedVersion: number;
  readonly inputs?: Readonly<Record<string, unknown>>;
  readonly dependencies?: readonly ResourceRevisionRef[];
}

export interface ComputedInvocation {
  readonly id: string;
  readonly resourceId: string;
  readonly sourceId: string;
  readonly producerId: string;
  readonly producerVersion: number;
  readonly inputVersion: number;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly dependencies: readonly ResourceRevisionRef[];
  readonly declaration: ComputedProducerDeclarationSnapshot;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ComputedHandlerResolution {
  readonly reference: string;
  readonly invocationId: string;
  readonly resourceId: string;
  readonly producerId: string;
  readonly producerVersion: number;
}

export type ComputedExecutionReceiptOutput =
  | {
      readonly kind: "transient-representation";
      readonly mediaType: string;
      readonly content: string;
    }
  | {
      readonly kind: "immutable-snapshot";
      readonly mediaType: string;
      readonly content: string;
      readonly contentHash: string;
      readonly representationId: string;
    }
  | { readonly kind: "durable-resource"; readonly resourceId: string }
  | { readonly kind: "failure"; readonly code: string; readonly message: string };

export type ComputedExecutionRecordOutput =
  | { readonly kind: "transient-representation"; readonly mediaType: string }
  | {
      readonly kind: "immutable-snapshot";
      readonly mediaType: string;
      readonly contentHash: string;
      readonly representationId: string;
    }
  | { readonly kind: "durable-resource"; readonly resourceId: string }
  | { readonly kind: "failure"; readonly code: string; readonly message: string };

export interface ComputedExecutionReceipt {
  readonly id: string;
  readonly invocationId: string;
  readonly resourceId: string;
  readonly producerId: string;
  readonly producerVersion: number;
  readonly inputVersion: number;
  readonly dependencyFingerprint: string;
  readonly cacheHit: boolean;
  readonly output: ComputedExecutionReceiptOutput;
  readonly startedAt: string;
  readonly completedAt: string;
}

export interface ComputedExecutionRecord {
  readonly id: string;
  readonly invocationId: string;
  readonly resourceId: string;
  readonly producerId: string;
  readonly producerVersion: number;
  readonly inputVersion: number;
  readonly dependencyFingerprint: string;
  readonly dependencies: readonly ResourceRevisionRef[];
  readonly cacheHit: boolean;
  readonly output: ComputedExecutionRecordOutput;
  readonly startedAt: string;
  readonly completedAt: string;
}

export interface ComputedExecutionHistory {
  readonly resourceId: string;
  readonly executions: readonly ComputedExecutionRecord[];
}

export interface ComputedResourceDocument {
  readonly markdown: string;
  readonly mediaType: "text/markdown";
  readonly contentHash: string;
  readonly representationId: string;
  readonly revision: ResourceRevisionRef;
  readonly dependencies: readonly ResourceRevisionRef[];
  readonly adapter: ResourceRepresentationAdapter;
  readonly derivedAt: string;
}

export interface ComputedResourceStatus {
  readonly state: "idle" | "executing" | "succeeded" | "failed";
  readonly generation: number;
  readonly lastExecutionAt: string | null;
}

export interface ComputedResourceFailure {
  readonly executionId: string;
  readonly code: string;
  readonly message: string;
  readonly failedAt: string;
}

export interface InternResourceInput {
  readonly sourceId: string;
  readonly address: ResourceAddress;
  readonly mediaType?: string;
}

export interface InternResourceReceipt {
  readonly resource: Resource;
  readonly created: boolean;
}
export interface InternFilesystemResourceInput {
  readonly path: string;
  readonly mediaType?: string;
}

export interface RelocateResourceInput {
  readonly resourceId: string;
  readonly expectedVersion: number;
  readonly destinationSourceId: string;
  readonly address: ResourceAddress;
}

export type CapabilityAssessment =
  | { readonly state: "satisfied" | "not-required" }
  | {
      readonly state: "blocked" | "unknown";
      readonly reason: string;
      readonly detail: string;
    };

export interface ResourceCapabilityDecision {
  readonly status: "available" | "unavailable" | "indeterminate";
  readonly factors: Readonly<Record<ResourceCapabilityFactor, CapabilityAssessment>>;
}

export type ResourceCapabilityReport = Readonly<
  Record<ResourceCapability, ResourceCapabilityDecision>
>;
export interface ResourceRepresentationAdapter {
  readonly id: string;
  readonly version: number;
}

export type ResourceFreshness =
  | "fresh"
  | "stale"
  | "unknown"
  | "refreshing"
  | "failed";

export type ResourceRetentionArtifactKind = "source-snapshot" | "representation";
export type ResourceRetentionState =
  | "current"
  | "hot"
  | "referenced"
  | "pinned"
  | "evictable"
  | "evicted"
  | "purged";

export interface ResourceRetentionPolicy {
  readonly retainNewestSourceSnapshots: number;
  readonly retainNewestRepresentationsPerAdapter: number;
  readonly minimumAgeMs: number;
  readonly purgeGraceMs: number;
  readonly updatedAt: string;
}

export interface ResourceRetentionPolicyInput {
  readonly retainNewestSourceSnapshots: number;
  readonly retainNewestRepresentationsPerAdapter: number;
  readonly minimumAgeMs: number;
  readonly purgeGraceMs: number;
}

export interface ResourceRetentionPinInput {
  readonly artifact: ResourceRetentionArtifactRef;
  readonly label?: string | null;
}

export interface ResourceRetentionReferenceInput {
  readonly artifact: ResourceRetentionArtifactRef;
  readonly owner: ResourceRetentionReferenceOwner;
}

export interface ResourceRetentionArtifactRef {
  readonly kind: ResourceRetentionArtifactKind;
  readonly id: string;
}

export interface ResourceRetentionArtifact {
  readonly artifact: ResourceRetentionArtifactRef;
  readonly resourceId: string;
  readonly sourceSnapshotId: string | null;
  readonly adapter: ResourceRepresentationAdapter | null;
  readonly states: readonly Exclude<ResourceRetentionState, "purged">[];
  readonly payloadAvailable: boolean;
  readonly payloadBytes: number;
  readonly capturedAt: string | null;
  readonly evictedAt: string | null;
}

export interface ResourceRetentionPin {
  readonly id: string;
  readonly resourceId: string;
  readonly artifact: ResourceRetentionArtifactRef;
  readonly label: string | null;
  readonly createdAt: string;
}

export interface ResourceRetentionReferenceOwner {
  readonly kind: "review" | "publication";
  readonly id: string;
}

export interface ResourceRetentionReference {
  readonly id: string;
  readonly resourceId: string;
  readonly artifact: ResourceRetentionArtifactRef;
  readonly owner: ResourceRetentionReferenceOwner;
  readonly createdAt: string;
}

export interface PurgedResourceArtifact {
  readonly artifact: ResourceRetentionArtifactRef;
  readonly resourceId: string;
  readonly state: "purged";
  readonly purgedAt: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ResourceRetentionReport {
  readonly policy: ResourceRetentionPolicy;
  readonly artifacts: readonly ResourceRetentionArtifact[];
  readonly pins: readonly ResourceRetentionPin[];
  readonly references: readonly ResourceRetentionReference[];
  readonly purged: readonly PurgedResourceArtifact[];
}

export interface ResourceRetentionCollectionReceipt {
  readonly mode: "evict" | "purge";
  readonly resourceId: string | null;
  readonly evicted: readonly ResourceRetentionArtifactRef[];
  readonly purged: readonly PurgedResourceArtifact[];
  readonly collectedAt: string;
}

export interface WebSourceSnapshotProvenance {
  readonly id: string;
  readonly resourceId: string;
  readonly addressVersion: number;
  readonly canonicalUrl: string | null;
  readonly contentHash: string | null;
  readonly revision: ResourceRevisionRef;
  readonly fetchedAt: string | null;
  readonly bodyAvailable: boolean;
  readonly evictedAt: string | null;
}

export interface WebRepresentationProvenance {
  readonly id: string;
  readonly sourceSnapshotId: string;
  readonly mediaType: "text/markdown";
  readonly adapter: ResourceRepresentationAdapter;
  readonly contentHash: string;
  readonly derivedAt: string | null;
  readonly contentAvailable: boolean;
  readonly evictedAt: string | null;
}

export interface WebResourceProvenance {
  readonly sourceSnapshots: readonly WebSourceSnapshotProvenance[];
  readonly representations: readonly WebRepresentationProvenance[];
}
export type WebResourceHistory = WebResourceProvenance;


export interface WebResourceStatus {
  readonly freshness: ResourceFreshness;
  readonly checkedAt: string | null;
  readonly lastError: string | null;
}


export interface WebResourceDocument {
  readonly markdown: string;
  readonly sourceSnapshot: WebSourceSnapshotProvenance;
  readonly representation: WebRepresentationProvenance;
}
export const MAX_REMOTE_ENTITY_COMMENT_LENGTH = 10_000;

export type RemoteEntityProvider = "jira" | "linear";
export type RemoteEntityMetadataValue = string | readonly string[] | null;
export type RemoteEntityMetadata = Readonly<Record<string, RemoteEntityMetadataValue>>;

interface CommentCreateDescriptor {
  readonly command: "comment.create";
  readonly label: string;
  readonly input: {
    readonly body: {
      readonly type: "string";
      readonly required: true;
      readonly maxLength: 10_000;
    };
  };
}

export type ResourceProviderCommandDescriptor =
  | CommentCreateDescriptor & { readonly provider: "jira" }
  | CommentCreateDescriptor & { readonly provider: "linear" };

export type ResourceProviderCommandInput =
  | {
      readonly provider: "jira";
      readonly command: "comment.create";
      readonly payload: { readonly body: string };
    }
  | {
      readonly provider: "linear";
      readonly command: "comment.create";
      readonly payload: { readonly body: string };
    };

export interface ResourceProviderCommandReceipt {
  readonly resourceId: string;
  readonly provider: RemoteEntityProvider;
  readonly command: "comment.create";
  readonly entityId: string;
  readonly externalId: string | null;
  readonly executedAt: string;
}

export interface RemoteEntitySourceSnapshotProvenance {
  readonly provider: RemoteEntityProvider;
  readonly resourceId: string;
  readonly addressVersion: number;
  readonly entityId: string;
  readonly locator: string;
  readonly contentHash: string;
  readonly revision: ResourceRevisionRef;
  readonly fetchedAt: string;
}

export interface RemoteEntityRepresentationProvenance {
  readonly mediaType: "text/markdown";
  readonly adapter: ResourceRepresentationAdapter;
  readonly contentHash: string;
  readonly derivedAt: string;
}

export interface RemoteEntityDocument {
  readonly title: string;
  readonly metadata: RemoteEntityMetadata;
  readonly markdown: string;
  readonly externalUrl: string;
  readonly sourceSnapshot: RemoteEntitySourceSnapshotProvenance;
  readonly representation: RemoteEntityRepresentationProvenance;
  readonly commandDescriptors: readonly ResourceProviderCommandDescriptor[];
}

export interface FilesystemResourceDocument {
  readonly text: string;
  readonly contentHash: string;
  readonly capturedAt: string;
  readonly revision: ResourceRevisionRef;
}

export interface PdfRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PdfTextSpan {
  readonly start: number;
  readonly end: number;
  readonly region: PdfRegion;
}

export interface PdfPageText {
  readonly page: number;
  readonly width: number;
  readonly height: number;
  readonly start: number;
  readonly end: number;
  readonly spans: readonly PdfTextSpan[];
}

export interface PdfSourceSnapshotProvenance {
  readonly id: string;
  readonly resourceId: string;
  readonly addressVersion: number;
  readonly locator: string;
  readonly contentHash: string;
  readonly revision: ResourceRevisionRef;
  readonly capturedAt: string;
  readonly bytesAvailable: boolean;
  readonly evictedAt: string | null;
}

export interface PdfRepresentationProvenance {
  readonly id: string;
  readonly sourceSnapshotId: string;
  readonly mediaType: "application/pdf" | "text/markdown";
  readonly adapter: ResourceRepresentationAdapter;
  readonly contentHash: string;
  readonly derivedAt: string;
  readonly contentAvailable: boolean;
  readonly evictedAt: string | null;
}
export interface PdfResourceDocument {
  readonly markdown: string;
  readonly pages: readonly PdfPageText[];
  readonly sourceSnapshot: PdfSourceSnapshotProvenance;
  readonly representation: PdfRepresentationProvenance;
  readonly nativeRepresentation: PdfRepresentationProvenance;
}

export interface PdfResourceHistory {
  readonly sourceSnapshots: readonly PdfSourceSnapshotProvenance[];
  readonly representations: readonly PdfRepresentationProvenance[];
}
export interface ResourceNativePayload {
  readonly representationId: string;
  readonly mediaType: "application/pdf";
  readonly contentHash: string;
  readonly encoding: "base64";
  readonly data: string;
}



export type ResourceKind = "document" | "entity" | "application";
export type ResourceSurface = "tui" | "gui" | "native" | "external";
export type ResourcePlacement = "inline" | "pane" | "window" | "external";
export type ResourceRenderer =
  | "markdown"
  | "embedded-browser"
  | "native-document"
  | "metadata"
  | "external-open";
export type ResourceRepresentationKind =
  | "cached-markdown"
  | "embedded-browser"
  | "native-document"
  | "metadata"
  | "external-link";
export type ResourceAccessState = "available" | "unavailable" | "unknown";

export interface ResourceProviderAccess {
  readonly credentials: ResourceAccessState;
  readonly connectivity: ResourceAccessState;
}

export interface ResourcePresentationHost {
  readonly id: string;
  readonly renderers: readonly ResourceRenderer[];
  readonly placements: readonly ResourcePlacement[];
  readonly capabilities: readonly ResourceCapability[];
}

export interface ResourcePresentationContext {
  readonly surface: ResourceSurface;
  readonly placement: ResourcePlacement;
  readonly host: ResourcePresentationHost;
  readonly providerAccess: ResourceProviderAccess;
}

export interface ResourcePresentationAttempt {
  readonly representation: ResourceRepresentationKind;
  readonly renderer: ResourceRenderer;
  readonly placement: ResourcePlacement;
  readonly status: "available" | "indeterminate" | "unavailable";
  readonly reason: string;
}

export interface ResourcePresentationSelection extends ResourcePresentationAttempt {
  readonly mediaType: string | null;
  readonly adapter: ResourceRepresentationAdapter | null;
  readonly externalUrl: string | null;
}

export interface ResourcePresentationDecision {
  readonly resourceId: string;
  readonly resourceKind: ResourceKind;
  readonly surface: ResourceSurface;
  readonly requestedPlacement: ResourcePlacement;
  readonly capabilities: ResourceCapabilityReport;
  readonly selected: ResourcePresentationSelection | null;
  readonly attempts: readonly ResourcePresentationAttempt[];
}


export interface ResourceDescription {
  readonly resource: Resource;
  readonly source: ResourceSource;
  readonly requestedRevision: ResourceRevisionRef | null;
  readonly capabilities: ResourceCapabilityReport;
  readonly filesystem?: FilesystemResourceDocument | null;
  readonly pdf?: PdfResourceDocument | null;
  readonly pdfHistory?: PdfResourceHistory | null;
  readonly nativePayload?: ResourceNativePayload;
  readonly pdfError?: string;
  readonly web: WebResourceDocument | null;
  readonly webHistory: WebResourceHistory | null;
  readonly webStatus: WebResourceStatus | null;
  readonly webError?: string;
  readonly remoteEntity: RemoteEntityDocument | null;
  readonly remoteStatus: WebResourceStatus | null;
  readonly remoteError?: string;
  readonly computed?: ComputedResourceDocument | null;
  readonly computedStatus?: ComputedResourceStatus | null;
  readonly computedFailure?: ComputedResourceFailure | null;
  readonly availableCommands: readonly ResourceProviderCommandDescriptor[];
  readonly presentation?: ResourcePresentationDecision;
}

export type ResourceCatalogErrorCode =
  | "missing-source"
  | "missing-resource"
  | "provider-mismatch"
  | "outside-source"
  | "symlink-disallowed"
  | "source-unavailable"
  | "version-conflict"
  | "address-conflict"
  | "invalid-input"
  | "stale-revision";

export class ResourceCatalogError extends Error {
  constructor(
    readonly code: ResourceCatalogErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ResourceCatalogError";
  }
}

export interface NormalizedResourceAddress {
  readonly address: ResourceAddress;
  readonly canonicalKey: string;
}

function invalid(message: string): never {
  throw new ResourceCatalogError("invalid-input", message);
}
const ResourceProviderCommandInputSchema = Type.Union([
  Type.Object({
    provider: Type.Literal("jira"),
    command: Type.Literal("comment.create"),
    payload: Type.Object({
      body: Type.String(),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  Type.Object({
    provider: Type.Literal("linear"),
    command: Type.Literal("comment.create"),
    payload: Type.Object({
      body: Type.String(),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
]);

const COMMENT_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export function normalizeResourceProviderCommandInput(
  value: unknown,
): ResourceProviderCommandInput {
  let input: Static<typeof ResourceProviderCommandInputSchema>;
  try {
    input = Parse(ResourceProviderCommandInputSchema, value);
  } catch {
    invalid(
      "Resource provider command must be a known command with exactly the expected fields",
    );
  }
  const body = input.payload.body.trim();
  if (
    !body ||
    body.length > MAX_REMOTE_ENTITY_COMMENT_LENGTH ||
    COMMENT_CONTROL_CHARACTERS.test(body)
  ) {
    invalid(
      `Comment body must be 1-${MAX_REMOTE_ENTITY_COMMENT_LENGTH} printable characters`,
    );
  }
  return {
    provider: input.provider,
    command: input.command,
    payload: { body },
  };
}

const UnknownRecordSchema = Type.Record(Type.String(), Type.Unknown());
type UnknownRecord = Static<typeof UnknownRecordSchema>;

function record(value: unknown, label: string): UnknownRecord {
  try {
    return Parse(UnknownRecordSchema, value);
  } catch {
    invalid(`${label} must be an object`);
  }
}

function printable(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") invalid(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || CONTROL_CHARACTERS.test(normalized)) {
    invalid(`${label} must be 1-${maximum} printable characters`);
  }
  return normalized;
}

export function normalizeResourceId(value: unknown, label = "Resource ID"): string {
  const id = printable(value, label, 36).toLowerCase();
  if (!UUID_PATTERN.test(id)) invalid(`${label} must be a canonical UUID`);
  return id;
}

function normalizeVersion(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    invalid(`${label} must be a positive safe integer`);
  }
  return Number(value);
}

function isResourceCapability(value: string): value is ResourceCapability {
  return RESOURCE_CAPABILITIES.some((capability) => capability === value);
}

function normalizeCapability(value: unknown): ResourceCapability {
  if (typeof value === "string" && isResourceCapability(value)) return value;
  invalid(`Unsupported resource capability: ${String(value)}`);
}

function normalizePolicy(value: unknown): ResourcePolicy {
  if (value === undefined) return { deniedCapabilities: [] };
  const input = record(value, "Resource policy");
  const denied = input.deniedCapabilities ?? [];
  if (!Array.isArray(denied)) invalid("Resource policy deniedCapabilities must be an array");
  const values = denied.map(normalizeCapability);
  return {
    deniedCapabilities: RESOURCE_CAPABILITIES.filter((capability) =>
      values.includes(capability)
    ),
  };
}

function normalizeComputedPermissions(value: unknown): readonly string[] {
  if (!Array.isArray(value)) invalid("Computed source allowedPermissions must be an array");
  const normalized = value.map((permission) =>
    printable(permission, "Computed source permission", 255)
  );
  return [...new Set(normalized)].sort();
}

function normalizeHttpUrl(value: unknown, label: string): URL {
  const raw = printable(value, label, MAX_LOCATOR_LENGTH);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    invalid(`${label} must be an absolute URL`);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    invalid(`${label} must use HTTP or HTTPS without embedded credentials`);
  }
  if (url.hash) invalid(`${label} cannot contain a fragment`);
  if (ENCODED_PATH_ESCAPE.test(url.pathname)) {
    invalid(`${label} cannot contain encoded traversal or path separators`);
  }
  return url;
}

function normalizedPathPrefix(pathname: string): string {
  const normalized = pathname.replace(/\/{2,}/g, "/");
  if (normalized === "/") return "/";
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}
function githubSegment(value: unknown, label: string): string {
  const segment = printable(value, label, 200);
  if (!/^[A-Za-z0-9_.-]+$/.test(segment)) {
    invalid(`${label} must be a single GitHub path segment`);
  }
  return segment;
}
function normalizeRemoteOrigin(value: unknown, label: string): string {
  const origin = normalizeHttpUrl(value, label);
  if (origin.pathname !== "/" || origin.search) {
    invalid(`${label} cannot contain a path or query`);
  }
  return origin.origin;
}

function credentialEnvironmentName(value: unknown): string {
  const name = printable(value, "Credential environment variable", 255);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    invalid("Credential environment variable name is invalid");
  }
  return name;
}

function remoteEntityId(value: unknown, provider: "Jira" | "Linear"): string {
  return printable(value, `${provider} entity ID`, 255);
}

function normalizeJiraAddress(
  source: Extract<ResourceSource, { provider: "jira" }>,
  value: unknown,
): NormalizedResourceAddress {
  const input = record(value, "Jira resource address");
  if (input.kind !== "jira") invalid("Jira resource address kind must be jira");
  const entityId = remoteEntityId(input.entityId, "Jira");
  const key = printable(input.key, "Jira issue key", 255).toUpperCase();
  if (!key.startsWith(`${source.boundary.project}-`)) {
    throw new ResourceCatalogError(
      "outside-source",
      "Jira issue key is outside its source project",
    );
  }
  return {
    address: { kind: "jira", entityId, key },
    canonicalKey: entityId,
  };
}

function normalizeLinearAddress(value: unknown): NormalizedResourceAddress {
  const input = record(value, "Linear resource address");
  if (input.kind !== "linear") invalid("Linear resource address kind must be linear");
  const entityId = remoteEntityId(input.entityId, "Linear");
  const identifier = printable(input.identifier, "Linear issue identifier", 255).toUpperCase();
  return {
    address: { kind: "linear", entityId, identifier },
    canonicalKey: entityId,
  };
}


function normalizeFilesystemAddress(value: unknown): NormalizedResourceAddress {
  const input = record(value, "Filesystem resource address");
  if (input.kind !== "filesystem") invalid("Filesystem resource address kind must be filesystem");
  const path = printable(input.path, "Filesystem resource path", MAX_LOCATOR_LENGTH);
  if (path.startsWith("/") || WINDOWS_ABSOLUTE_PATH.test(path) || path.startsWith("~")) {
    throw new ResourceCatalogError("outside-source", "Filesystem resource path must be relative");
  }
  const parts: string[] = [];
  for (const segment of path.replaceAll("\\", "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) {
        throw new ResourceCatalogError(
          "outside-source",
          "Filesystem resource path cannot escape its source root",
        );
      }
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  const normalized = parts.join("/") || ".";
  return {
    address: { kind: "filesystem", path: normalized },
    canonicalKey: normalized,
  };
}

function normalizeWebAddress(
  source: Extract<ResourceSource, { provider: "web" }>,
  value: unknown,
): NormalizedResourceAddress {
  const input = record(value, "Web resource address");
  if (input.kind !== "web") invalid("Web resource address kind must be web");
  const base = normalizeHttpUrl(source.boundary.baseUrl, "Web source base URL");
  const url = normalizeHttpUrl(input.url, "Web resource URL");
  const basePrefix = normalizedPathPrefix(base.pathname);
  if (
    url.origin !== base.origin ||
    !(url.pathname === base.pathname || url.pathname.startsWith(basePrefix))
  ) {
    throw new ResourceCatalogError("outside-source", "Web resource URL is outside its source boundary");
  }
  return {
    address: { kind: "web", url: url.href },
    canonicalKey: url.href,
  };
}

function normalizeGithubAddress(value: unknown): NormalizedResourceAddress {
  const input = record(value, "GitHub resource address");
  if (input.kind !== "github") invalid("GitHub resource address kind must be github");
  if (input.entity !== "issue" && input.entity !== "pull-request") {
    invalid("GitHub resource entity must be issue or pull-request");
  }
  if (!Number.isSafeInteger(input.number) || Number(input.number) < 1) {
    invalid("GitHub resource number must be a positive safe integer");
  }
  const address: Extract<ResourceAddress, { kind: "github" }> = {
    kind: "github",
    entity: input.entity,
    number: Number(input.number),
  };
  return { address, canonicalKey: `${address.entity}:${address.number}` };
}

function normalizeApplicationNamespace(value: unknown): string {
  const namespace = printable(value, "Application source namespace", 255)
    .replaceAll("\\", "/")
    .replace(/^\/+|\/+$/g, "");
  const segments = namespace.split("/");
  if (!namespace || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    invalid("Application source namespace must be a non-empty relative path");
  }
  return segments.join("/");
}

function normalizeApplicationAddress(
  source: Extract<ResourceSource, { provider: "application" }>,
  value: unknown,
): NormalizedResourceAddress {
  const input = record(value, "Application resource address");
  if (input.kind !== "application") {
    invalid("Application resource address kind must be application");
  }
  const uri = printable(input.uri, "Application resource URI", MAX_LOCATOR_LENGTH);
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    invalid("Application resource URI must be absolute");
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    ENCODED_PATH_ESCAPE.test(parsed.pathname)
  ) {
    invalid("Application resource URI cannot contain credentials, a fragment, or encoded traversal");
  }
  const namespacePath = `/${
    source.boundary.namespace.split("/").map((segment) => encodeURIComponent(segment)).join("/")
  }`;
  if (
    parsed.protocol.slice(0, -1).toLowerCase() !== source.boundary.scheme ||
    parsed.host.toLowerCase() !== source.boundary.authority ||
    (parsed.pathname !== namespacePath && !parsed.pathname.startsWith(`${namespacePath}/`))
  ) {
    throw new ResourceCatalogError(
      "outside-source",
      "Application resource URI is outside its source boundary",
    );
  }
  return {
    address: { kind: "application", uri: parsed.href },
    canonicalKey: parsed.href,
  };
}

function normalizeComputedAddress(value: unknown): NormalizedResourceAddress {
  const input = record(value, "Computed resource address");
  if (input.kind !== "computed") {
    invalid("Computed resource address kind must be computed");
  }
  const invocationId = normalizeResourceId(input.invocationId, "Computed invocation ID");
  return {
    address: { kind: "computed", invocationId },
    canonicalKey: invocationId,
  };
}

export function normalizeResourceSourceInput(value: unknown): NormalizedResourceSourceInput {
  const input = record(value, "Resource source input");
  const name = printable(input.name, "Resource source name", MAX_NAME_LENGTH);
  const boundary = record(input.boundary, "Resource source boundary");
  const policy = normalizePolicy(input.policy);
  switch (input.provider) {
    case "filesystem": {
      const root = printable(boundary.root, "Filesystem source root", MAX_LOCATOR_LENGTH);
      if (!root.startsWith("/") || WINDOWS_ABSOLUTE_PATH.test(root)) {
        invalid("Filesystem source root must be an absolute POSIX path");
      }
      return { name, provider: "filesystem", boundary: { root }, policy };
    }
    case "web": {
      const base = normalizeHttpUrl(boundary.baseUrl, "Web source base URL");
      base.pathname = normalizedPathPrefix(base.pathname);
      return { name, provider: "web", boundary: { baseUrl: base.href }, policy };
    }
    case "github": {
      const origin = normalizeHttpUrl(
        boundary.origin ?? "https://github.com",
        "GitHub source origin",
      );
      if (origin.pathname !== "/" || origin.search) {
        invalid("GitHub source origin cannot contain a path or query");
      }
      return {
        name,
        provider: "github",
        boundary: {
          origin: origin.origin,
          owner: githubSegment(boundary.owner, "GitHub source owner"),
          repository: githubSegment(boundary.repository, "GitHub source repository"),
        },
        policy,
      };
    }
    case "jira":
      return {
        name,
        provider: "jira",
        boundary: {
          origin: normalizeRemoteOrigin(boundary.origin, "Jira source origin"),
          project: printable(boundary.project, "Jira source project", 255).toUpperCase(),
          credentialEnv: credentialEnvironmentName(boundary.credentialEnv),
        },
        policy,
      };
    case "linear":
      return {
        name,
        provider: "linear",
        boundary: {
          origin: normalizeRemoteOrigin(boundary.origin, "Linear source origin"),
          workspace: printable(boundary.workspace, "Linear source workspace", 255),
          credentialEnv: credentialEnvironmentName(boundary.credentialEnv),
        },
        policy,
      };
    case "application": {
      const scheme = printable(boundary.scheme, "Application source scheme", 64)
        .toLowerCase().replace(/:$/, "");
      if (!/^[a-z][a-z0-9+.-]*$/.test(scheme)) {
        invalid("Application source scheme is invalid");
      }
      return {
        name,
        provider: "application",
        boundary: {
          scheme,
          authority: printable(boundary.authority, "Application source authority", 255)
            .toLowerCase(),
          namespace: normalizeApplicationNamespace(boundary.namespace),
        },
        policy,
      };
    }
    case "computed":
      return {
        name,
        provider: "computed",
        boundary: {
          registry: printable(boundary.registry, "Computed source registry", 255),
          allowedPermissions: normalizeComputedPermissions(boundary.allowedPermissions),
        },
        policy,
      };
    default:
      invalid(`Unsupported resource provider: ${String(input.provider)}`);
  }
}

export function normalizeResourceAddress(
  source: ResourceSource,
  value: unknown,
): NormalizedResourceAddress {
  switch (source.provider) {
    case "filesystem":
      return normalizeFilesystemAddress(value);
    case "web":
      return normalizeWebAddress(source, value);
    case "github":
      return normalizeGithubAddress(value);
    case "jira":
      return normalizeJiraAddress(source, value);
    case "linear":
      return normalizeLinearAddress(value);
    case "application":
      return normalizeApplicationAddress(source, value);
    case "computed":
      return normalizeComputedAddress(value);
  }
}

export function normalizeInternResourceInput(
  value: unknown,
  source: ResourceSource,
): InternResourceInput & NormalizedResourceAddress {
  const input = record(value, "Resource intern input");
  const sourceId = normalizeResourceId(input.sourceId, "Resource source ID");
  if (sourceId !== source.id) invalid("Resource source ID does not match the resolved source");
  const normalized = normalizeResourceAddress(source, input.address);
  const mediaType = input.mediaType === undefined
    ? undefined
    : printable(input.mediaType, "Resource media type", MAX_MEDIA_TYPE_LENGTH);
  return { sourceId, ...normalized, ...(mediaType ? { mediaType } : {}) };
}

export function normalizeRelocateResourceInput(
  value: unknown,
  resource: Resource,
  destination: ResourceSource,
): RelocateResourceInput & NormalizedResourceAddress {
  const input = record(value, "Resource relocation input");
  const resourceId = normalizeResourceId(input.resourceId);
  if (resourceId !== resource.id) invalid("Resource ID does not match the resolved resource");
  const destinationSourceId = normalizeResourceId(
    input.destinationSourceId,
    "Destination source ID",
  );
  if (destinationSourceId !== destination.id) {
    invalid("Destination source ID does not match the resolved source");
  }
  if (resource.provider !== destination.provider) {
    throw new ResourceCatalogError(
      "provider-mismatch",
      `Cannot relocate ${resource.provider} resource into ${destination.provider} source`,
    );
  }
  const expectedVersion = normalizeVersion(input.expectedVersion, "Expected resource version");
  if (expectedVersion !== resource.version) {
    throw new ResourceCatalogError(
      "version-conflict",
      `Resource version changed: expected ${expectedVersion}, found ${resource.version}`,
    );
  }
  const normalized = normalizeResourceAddress(destination, input.address);
  if (
    resource.provider === "jira" &&
    (
      destination.id !== resource.sourceId ||
      normalized.address.kind !== "jira" ||
      normalized.address.entityId !== resource.address.entityId
    )
  ) {
    throw new ResourceCatalogError(
      "provider-mismatch",
      "Jira relocation cannot change provider instance or immutable entity identity",
    );
  }
  if (
    resource.provider === "linear" &&
    (
      destination.id !== resource.sourceId ||
      normalized.address.kind !== "linear" ||
      normalized.address.entityId !== resource.address.entityId
    )
  ) {
    throw new ResourceCatalogError(
      "provider-mismatch",
      "Linear relocation cannot change provider instance or immutable entity identity",
    );
  }
  if (
    resource.provider === "computed" &&
    (
      normalized.address.kind !== "computed" ||
      normalized.address.invocationId !== resource.address.invocationId
    )
  ) {
    throw new ResourceCatalogError(
      "provider-mismatch",
      "Computed relocation cannot change immutable invocation identity",
    );
  }
  return {
    resourceId,
    expectedVersion,
    destinationSourceId,
    ...normalized,
  };
}

function decimalInteger(value: unknown, label: string): string {
  const normalized = printable(value, label, 100);
  if (!/^(?:0|[1-9][0-9]*)$/.test(normalized)) invalid(`${label} must be a decimal integer`);
  return normalized;
}

function isoTimestamp(value: unknown, label: string): string {
  const normalized = printable(value, label, 100);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})$/.test(
      normalized,
    )
  ) {
    invalid(`${label} must be an ISO timestamp`);
  }
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) invalid(`${label} must be an ISO timestamp`);
  return new Date(timestamp).toISOString();
}

function normalizeProviderRevision(
  resourceId: string,
  addressVersion: number,
  revision: Record<string, unknown>,
): ResourceRevisionRef {
  if (revision.kind === "filesystem") {
    return {
      resourceId,
      addressVersion,
      revision: {
        kind: "filesystem",
        mtimeNs: decimalInteger(revision.mtimeNs, "Filesystem revision mtimeNs"),
        size: decimalInteger(revision.size, "Filesystem revision size"),
      },
    };
  }
  if (revision.kind === "computed") {
    const dependencyFingerprint = printable(
      revision.dependencyFingerprint,
      "Computed dependency fingerprint",
      64,
    ).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(dependencyFingerprint)) {
      invalid("Computed dependency fingerprint must be SHA-256");
    }
    return {
      resourceId,
      addressVersion,
      revision: {
        kind: "computed",
        executionId: normalizeResourceId(revision.executionId, "Computed execution ID"),
        producerId: printable(revision.producerId, "Computed producer ID", 255),
        producerVersion: normalizeVersion(
          revision.producerVersion,
          "Computed producer version",
        ),
        inputVersion: normalizeVersion(revision.inputVersion, "Computed input version"),
        dependencyFingerprint,
      },
    };
  }
  const validator = record(revision.validator, "Resource revision validator");
  if (revision.kind === "web") {
    if (validator.kind === "etag") {
      if (typeof validator.weak !== "boolean") invalid("Web ETag weak must be boolean");
      return {
        resourceId,
        addressVersion,
        revision: {
          kind: "web",
          validator: {
            kind: "etag",
            value: printable(validator.value, "Web ETag", 1_000),
            weak: validator.weak,
          },
        },
      };
    }
    if (validator.kind === "last-modified") {
      return {
        resourceId,
        addressVersion,
        revision: {
          kind: "web",
          validator: {
            kind: "last-modified",
            value: printable(validator.value, "Web Last-Modified", 1_000),
          },
        },
      };
    }
    if (validator.kind === "content-hash") {
      const value = printable(validator.value, "Web content hash", 64).toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(value)) invalid("Web content hash must be SHA-256");
      return {
        resourceId,
        addressVersion,
        revision: {
          kind: "web",
          validator: { kind: "content-hash", value },
        },
      };
    }
    invalid("Unsupported web revision validator");
  }
  if (revision.kind === "github") {
    if (validator.kind === "etag") {
      return {
        resourceId,
        addressVersion,
        revision: {
          kind: "github",
          validator: {
            kind: "etag",
            value: printable(validator.value, "GitHub ETag", 1_000),
          },
        },
      };
    }
    if (validator.kind === "updated-at") {
      return {
        resourceId,
        addressVersion,
        revision: {
          kind: "github",
          validator: {
            kind: "updated-at",
            value: isoTimestamp(validator.value, "GitHub updated-at"),
          },
        },
      };
    }
    invalid("Unsupported GitHub revision validator");
  }
  if (revision.kind === "jira" || revision.kind === "linear") {
    if (validator.kind !== "updated-at") {
      invalid(`Unsupported ${revision.kind} revision validator`);
    }
    const kind = revision.kind;
    return {
      resourceId,
      addressVersion,
      revision: {
        kind,
        validator: {
          kind: "updated-at",
          value: isoTimestamp(validator.value, `${kind} updated-at`),
        },
      },
    };
  }
  invalid(
    "Resource revision provider must be filesystem, web, github, jira, linear, or computed",
  );
}

export function normalizeRetainedResourceRevisionRef(value: unknown): ResourceRevisionRef {
  const input = record(value, "Resource revision reference");
  return normalizeProviderRevision(
    normalizeResourceId(input.resourceId),
    normalizeVersion(input.addressVersion, "Revision address version"),
    record(input.revision, "Resource revision"),
  );
}

export function normalizeResourceRevisionRef(
  value: unknown,
  resource: Resource,
): ResourceRevisionRef {
  const input = record(value, "Resource revision reference");
  const resourceId = normalizeResourceId(input.resourceId);
  const addressVersion = normalizeVersion(input.addressVersion, "Revision address version");
  if (resourceId !== resource.id || addressVersion !== resource.addressVersion) {
    throw new ResourceCatalogError(
      "stale-revision",
      "Resource revision reference does not match the current resource address",
    );
  }
  const revision = record(input.revision, "Resource revision");
  if (revision.kind !== resource.provider || resource.provider === "application") {
    throw new ResourceCatalogError(
      "provider-mismatch",
      "Resource revision provider does not match the resource",
    );
  }
  return normalizeProviderRevision(resourceId, addressVersion, revision);
}
export function resourceRevisionRefEquals(
  left: ResourceRevisionRef,
  right: ResourceRevisionRef,
): boolean {
  if (
    left.resourceId !== right.resourceId ||
    left.addressVersion !== right.addressVersion ||
    left.revision.kind !== right.revision.kind
  ) {
    return false;
  }
  if (left.revision.kind === "filesystem" && right.revision.kind === "filesystem") {
    return left.revision.mtimeNs === right.revision.mtimeNs &&
      left.revision.size === right.revision.size;
  }
  if (left.revision.kind === "web" && right.revision.kind === "web") {
    const leftValidator = left.revision.validator;
    const rightValidator = right.revision.validator;
    if (leftValidator.kind !== rightValidator.kind) return false;
    return leftValidator.kind === "etag" && rightValidator.kind === "etag"
      ? leftValidator.value === rightValidator.value &&
        leftValidator.weak === rightValidator.weak
      : leftValidator.value === rightValidator.value;
  }
  if (left.revision.kind === "github" && right.revision.kind === "github") {
    return left.revision.validator.kind === right.revision.validator.kind &&
      left.revision.validator.value === right.revision.validator.value;
  }
  if (
    (left.revision.kind === "jira" && right.revision.kind === "jira") ||
    (left.revision.kind === "linear" && right.revision.kind === "linear")
  ) {
    return left.revision.validator.value === right.revision.validator.value;
  }
  if (left.revision.kind === "computed" && right.revision.kind === "computed") {
    return left.revision.executionId === right.revision.executionId &&
      left.revision.producerId === right.revision.producerId &&
      left.revision.producerVersion === right.revision.producerVersion &&
      left.revision.inputVersion === right.revision.inputVersion &&
      left.revision.dependencyFingerprint === right.revision.dependencyFingerprint;
  }
  return false;
}

export function resourceAddressLabel(address: ResourceAddress): string {
  switch (address.kind) {
    case "filesystem":
      return address.path;
    case "web":
      return address.url;
    case "github":
      return `${address.entity} #${address.number}`;
    case "jira":
      return address.key;
    case "linear":
      return address.identifier;
    case "application":
      return address.uri;
    case "computed":
      return `producer:${address.invocationId}`;
  }
}

const PROVIDER_CAPABILITIES: Readonly<
  Record<ResourceProvider, Partial<Record<ResourceCapability, true>>>
> = {
  filesystem: {
    read: true,
    write: true,
    refresh: true,
    watch: true,
    history: true,
    "open-external": true,
  },
  web: {
    read: true,
    refresh: true,
    history: true,
    "open-external": true,
    embed: true,
  },
  github: {
    read: true,
    write: true,
    refresh: true,
    query: true,
    history: true,
    "open-external": true,
  },
  jira: {
    read: true,
    refresh: true,
    history: true,
    "open-external": true,
    command: true,
  },
  linear: {
    read: true,
    refresh: true,
    history: true,
    "open-external": true,
    command: true,
  },
  application: {
    "open-external": true,
    command: true,
  },
  computed: {
    read: true,
    refresh: true,
    history: true,
  },
};

function blocked(reason: string, detail: string): CapabilityAssessment {
  return { state: "blocked", reason, detail };
}

function unknown(reason: string, detail: string): CapabilityAssessment {
  return { state: "unknown", reason, detail };
}

function capabilityStatus(
  factors: Readonly<Record<ResourceCapabilityFactor, CapabilityAssessment>>,
): ResourceCapabilityDecision["status"] {
  if (RESOURCE_CAPABILITY_FACTORS.some((factor) => factors[factor].state === "blocked")) {
    return "unavailable";
  }
  if (RESOURCE_CAPABILITY_FACTORS.some((factor) => factors[factor].state === "unknown")) {
    return "indeterminate";
  }
  return "available";
}

function accessAssessment(
  state: ResourceAccessState,
  factor: "credentials" | "connectivity",
): CapabilityAssessment {
  if (state === "available") return { state: "satisfied" };
  const label = factor === "credentials" ? "credentials" : "provider connectivity";
  return state === "unavailable"
    ? blocked(`${factor}-unavailable`, `${label} is unavailable`)
    : unknown(`${factor}-not-observed`, `${label} has not been observed`);
}

function resourceCapabilityDecision(
  source: ResourceSource,
  destinationHostRegistered: boolean,
  destinationCapabilities: readonly ResourceCapability[],
  capability: ResourceCapability,
  providerAccess: ResourceProviderAccess,
): ResourceCapabilityDecision {
  const providerSupports = PROVIDER_CAPABILITIES[source.provider][capability] === true;
  const policyDenied = source.policy.deniedCapabilities.includes(capability);
  const remote = source.provider === "web" ||
    source.provider === "github" ||
    source.provider === "jira" ||
    source.provider === "linear";
  const factors: Record<ResourceCapabilityFactor, CapabilityAssessment> = {
    provider: providerSupports
      ? { state: "satisfied" }
      : blocked("unsupported-operation", `${source.provider} does not support ${capability}`),
    credentials: remote && capability !== "open-external" && capability !== "embed"
      ? accessAssessment(providerAccess.credentials, "credentials")
      : { state: "not-required" },
    "workspace-policy": policyDenied
      ? blocked("policy-denied", `Workspace policy denies ${capability}`)
      : { state: "satisfied" },
    "destination-host": destinationHostRegistered
      ? destinationCapabilities.includes(capability)
        ? { state: "satisfied" }
        : blocked(
            "implementation-not-installed",
            `This Detail host has no ${capability} executor`,
          )
      : unknown("destination-host-not-observed", "Destination host is not registered"),
    connectivity: remote && capability !== "open-external"
      ? accessAssessment(providerAccess.connectivity, "connectivity")
      : { state: "not-required" },
  };
  return { status: capabilityStatus(factors), factors };
}

export function deriveResourceCapabilityReport(
  source: ResourceSource,
  destinationHostRegistered: boolean,
  destinationCapabilities: readonly ResourceCapability[] = [],
  providerAccess: ResourceProviderAccess = {
    credentials: "unknown",
    connectivity: "unknown",
  },
): ResourceCapabilityReport {
  const decision = (capability: ResourceCapability) =>
    resourceCapabilityDecision(
      source,
      destinationHostRegistered,
      destinationCapabilities,
      capability,
      providerAccess,
    );
  return {
    read: decision("read"),
    write: decision("write"),
    refresh: decision("refresh"),
    watch: decision("watch"),
    query: decision("query"),
    history: decision("history"),
    "open-external": decision("open-external"),
    embed: decision("embed"),
    command: decision("command"),
  };
}
