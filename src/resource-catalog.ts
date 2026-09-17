import { Database } from "bun:sqlite";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { Type, type Static } from "typebox";
import { Parse } from "typebox/value";
import {
  BasicWebMarkdownExtractor,
  sha256,
  type WebMarkdownExtractor,
} from "./web-markdown";
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
  type CreateWebResourceAnnotationInput,
  type InternResourceReceipt,
  type Resource,
  type ResourceAddress,
  type ResourceDescription,
  type ResourceFreshness,
  type ResourceRevisionRef,
  type ResourceSource,
  type WebRepresentationProvenance,
  type WebResourceAnnotation,
  type WebResourceHistory,
  type WebResourceDocument,
  type WebResourceStatus,
  type WebSourceSnapshotProvenance,
} from "./resources";

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
interface WebResourceAnnotationRow {
  id: string;
  resource_id: string;
  source_snapshot_id: string;
  representation_id: string;
  revision_json: string;
  representation_json: string;
  anchor_json: string;
  body: string;
  created_at: string;
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
  readonly now?: () => string;
  readonly maximumWebBytes?: number;
  readonly webStaleAfterMs?: number;
}

const DEFAULT_MAXIMUM_WEB_BYTES = 2 * 1024 * 1024;
const DEFAULT_WEB_STALE_AFTER_MS = 24 * 60 * 60 * 1_000;

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
const LegacyRepresentationEvidenceSchema = Type.Object({
  mediaType: Type.Literal("text/markdown"),
  adapter: Type.Object({
    id: Type.String(),
    version: Type.Integer({ minimum: 1 }),
  }),
  contentHash: Type.String(),
});
const WebResourceAnnotationAnchorSchema = Type.Object({
  start: Type.Integer({ minimum: 0 }),
  end: Type.Integer({ minimum: 1 }),
  exact: Type.String(),
  prefix: Type.String(),
  suffix: Type.String(),
});
type InternIdentity = Static<typeof InternIdentitySchema>;
type RelocationIdentity = Static<typeof RelocationIdentitySchema>;

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

function parseWebResourceAnnotationAnchor(
  value: unknown,
): WebResourceAnnotation["anchor"] {
  try {
    return Parse(WebResourceAnnotationAnchorSchema, value);
  } catch {
    throw new ResourceCatalogError(
      "invalid-input",
      "Stored web annotation anchor is invalid",
    );
  }
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
    case "application":
      return {
        ...header,
        provider: "application",
        boundary: { kind: "application", ...normalized.boundary },
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
    case "application":
      return { ...header, provider: "application", address: normalized.address };
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

function annotationText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") {
    throw new ResourceCatalogError("invalid-input", `${label} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new ResourceCatalogError(
      "invalid-input",
      `${label} must be 1-${maximum} characters`,
    );
  }
  return normalized;
}


export class ResourceCatalog {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly webExtractor: WebMarkdownExtractor;
  private readonly now: () => string;
  private readonly maximumWebBytes: number;
  private readonly webStaleAfterMs: number;
  private readonly pendingWebRefreshes = new Map<string, Promise<ResourceDescription>>();

  constructor(
    private readonly database: Database,
    options: ResourceCatalogOptions = {},
  ) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.webExtractor = options.webExtractor ?? new BasicWebMarkdownExtractor();
    this.now = options.now ?? (() => new Date().toISOString());
    this.maximumWebBytes = options.maximumWebBytes ?? DEFAULT_MAXIMUM_WEB_BYTES;
    this.webStaleAfterMs = options.webStaleAfterMs ?? DEFAULT_WEB_STALE_AFTER_MS;
    if (!Number.isFinite(this.webStaleAfterMs) || this.webStaleAfterMs < 0) {
      throw new ResourceCatalogError(
        "invalid-input",
        "Web stale age must be a non-negative finite number",
      );
    }
    this.migrate();
    this.recoverInterruptedWebRefreshes();
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

  intern(value: unknown): InternResourceReceipt {
    const identity = parseInternIdentity(value);
    const sourceId = normalizeResourceId(identity.sourceId, "Resource source ID");
    return this.database.transaction(() => {
      const sourceRow = this.requireSourceRowFromCurrentRead(sourceId);
      const source = sourceFromRow(sourceRow);
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
      if (resource.provider === "web") {
        const relocated = this.requireFromCurrentRead(resource.id);
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
      this.bumpSequence();
      return this.requireFromCurrentRead(resource.id);
    })();
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
      const webRead = resource.provider === "web" && !readingDenied
        ? this.webReadFromCurrentRead(resource, requestedRevision)
        : null;
      return {
        resource,
        source,
        requestedRevision,
        capabilities: deriveResourceCapabilityReport(
          source,
          destinationHostRegistered,
          resource.provider === "web" ? ["read", "refresh", "open-external"] : [],
        ),
        web: webRead?.document ?? null,
        webHistory: webRead?.history ?? null,
        webStatus: resource.provider === "web"
          ? this.webStatusFromCurrentRead(resource)
          : null,
      };
    })();
  }

  async open(
    resourceId: string,
    destinationHostRegistered: boolean,
    revision?: unknown,
  ): Promise<ResourceDescription> {
    const description = this.describe(resourceId, destinationHostRegistered, revision);
    if (
      description.resource.provider === "web" &&
      description.source.policy.deniedCapabilities.includes("read")
    ) {
      return { ...description, webError: "Workspace policy denies reading this resource" };
    }
    return description;
  }

  refreshWeb(
    resourceId: string,
    destinationHostRegistered: boolean,
  ): Promise<ResourceDescription> {
    const normalized = normalizeResourceId(resourceId);
    const pending = this.pendingWebRefreshes.get(normalized);
    if (pending) return pending;
    const refresh = this.performWebRefresh(normalized, destinationHostRegistered)
      .finally(() => this.pendingWebRefreshes.delete(normalized));
    this.pendingWebRefreshes.set(normalized, refresh);
    return refresh;
  }

  createWebAnnotation(value: unknown): WebResourceAnnotation {
    if (typeof value !== "object" || value === null) {
      throw new ResourceCatalogError("invalid-input", "Web annotation input must be an object");
    }
    const input = value as Partial<CreateWebResourceAnnotationInput>;
    const resourceId = normalizeResourceId(input.resourceId);
    const sourceSnapshotId = normalizeResourceId(
      input.sourceSnapshotId,
      "Web source snapshot ID",
    );
    const representationId = normalizeResourceId(
      input.representationId,
      "Web representation ID",
    );
    return this.database.transaction(() => {
      const resource = this.requireFromCurrentRead(resourceId);
      if (resource.provider !== "web") {
        throw new ResourceCatalogError(
          "provider-mismatch",
          "Web annotations require a web resource",
        );
      }
      const source = this.requireSourceFromCurrentRead(resource.sourceId);
      if (source.policy.deniedCapabilities.includes("read")) {
        throw new ResourceCatalogError(
          "invalid-input",
          "Workspace policy denies reading this resource",
        );
      }
      const sourceSnapshot = this.webSourceSnapshotRowFromCurrentRead(sourceSnapshotId);
      const representation = this.webRepresentationRowFromCurrentRead(representationId);
      if (
        !sourceSnapshot ||
        sourceSnapshot.resource_id !== resourceId ||
        !representation ||
        representation.source_snapshot_id !== sourceSnapshotId
      ) {
        throw new ResourceCatalogError(
          "stale-revision",
          "Web annotation snapshot and representation IDs do not match this resource",
        );
      }
      if (representation.markdown === null) {
        throw new ResourceCatalogError(
          "invalid-input",
          "Web annotation representation content is unavailable",
        );
      }
      const anchor = input.anchor;
      if (
        !anchor ||
        !Number.isSafeInteger(anchor.start) ||
        !Number.isSafeInteger(anchor.end) ||
        anchor.start < 0 ||
        anchor.end <= anchor.start ||
        anchor.end > representation.markdown.length ||
        representation.markdown.slice(anchor.start, anchor.end) !== anchor.exact
      ) {
        throw new ResourceCatalogError(
          "invalid-input",
          "Web annotation anchor must exactly match the immutable Markdown representation",
        );
      }
      const prefix = representation.markdown.slice(
        Math.max(0, anchor.start - 64),
        anchor.start,
      );
      const suffix = representation.markdown.slice(anchor.end, anchor.end + 64);
      if (anchor.prefix !== prefix || anchor.suffix !== suffix) {
        throw new ResourceCatalogError(
          "invalid-input",
          "Web annotation context does not match the immutable Markdown representation",
        );
      }
      const revision = normalizeRetainedResourceRevisionRef(
        parsedJson(sourceSnapshot.revision_json, "Web source snapshot revision"),
      );
      const representationProvenance = this.webRepresentationProvenance(representation);
      const annotation: WebResourceAnnotation = {
        id: crypto.randomUUID(),
        resourceId,
        sourceSnapshotId,
        representationId,
        revision,
        representation: representationProvenance,
        anchor: {
          start: anchor.start,
          end: anchor.end,
          exact: anchor.exact,
          prefix,
          suffix,
        },
        body: annotationText(input.body, "Web annotation body", 10_000),
        createdAt: this.now(),
      };
      this.database.query(`
        INSERT INTO web_resource_annotations (
          id, resource_id, source_snapshot_id, representation_id,
          revision_json, representation_json, anchor_json, body, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        annotation.id,
        annotation.resourceId,
        annotation.sourceSnapshotId,
        annotation.representationId,
        JSON.stringify(annotation.revision),
        JSON.stringify(annotation.representation),
        JSON.stringify(annotation.anchor),
        annotation.body,
        annotation.createdAt,
      );
      this.bumpSequence();
      return annotation;
    })();
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
               revision_json, etag, last_modified, html, fetched_at
        FROM web_source_snapshots
        WHERE resource_id = ? AND address_version = ? AND canonical_url = ?
          AND content_hash = ? AND revision_json = ? AND html IS NOT NULL
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
            revision_json, etag, last_modified, html, fetched_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        );
        sourceSnapshot = this.webSourceSnapshotRowFromCurrentRead(sourceSnapshotId);
      }
      if (!sourceSnapshot) {
        throw new ResourceCatalogError(
          "source-unavailable",
          "Web source snapshot could not be persisted",
        );
      }
      let representation = this.database.query(`
        SELECT id, source_snapshot_id, media_type, adapter_id, adapter_version,
               content_hash, markdown, derived_at
        FROM web_representations
        WHERE source_snapshot_id = ? AND media_type = 'text/markdown'
          AND adapter_id = ? AND adapter_version = ? AND content_hash = ?
          AND markdown IS NOT NULL
        ORDER BY derived_at, id
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
            content_hash, markdown, derived_at
          ) VALUES (?, ?, 'text/markdown', ?, ?, ?, ?, ?)
        `).run(
          representationId,
          sourceSnapshot.id,
          this.webExtractor.adapter.id,
          this.webExtractor.adapter.version,
          representationHash,
          markdown,
          checkedAt,
        );
        representation = this.webRepresentationRowFromCurrentRead(representationId);
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
             revision_json, etag, last_modified, html, fetched_at
      FROM web_source_snapshots
      WHERE id = ?
    `).get(sourceSnapshotId) as WebSourceSnapshotRow | null;
  }

  private webRepresentationRowFromCurrentRead(
    representationId: string,
  ): WebRepresentationRow | null {
    return this.database.query(`
      SELECT id, source_snapshot_id, media_type, adapter_id, adapter_version,
             content_hash, markdown, derived_at
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
    };
  }

  private webAnnotationFromRow(row: WebResourceAnnotationRow): WebResourceAnnotation {
    const representation = this.webRepresentationRowFromCurrentRead(row.representation_id);
    if (!representation) {
      throw new ResourceCatalogError(
        "invalid-input",
        `Web annotation ${row.id} references a missing representation`,
      );
    }
    return {
      id: row.id,
      resourceId: row.resource_id,
      sourceSnapshotId: row.source_snapshot_id,
      representationId: row.representation_id,
      revision: normalizeRetainedResourceRevisionRef(
        parsedJson(row.revision_json, "Web annotation revision"),
      ),
      representation: this.webRepresentationProvenance(representation),
      anchor: parseWebResourceAnnotationAnchor(
        parsedJson(row.anchor_json, "Web annotation anchor"),
      ),
      body: row.body,
      createdAt: row.created_at,
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
             revision_json, etag, last_modified, html, fetched_at
      FROM web_source_snapshots
      WHERE resource_id = ?
      ORDER BY fetched_at, id
    `).all(resource.id) as WebSourceSnapshotRow[];
    const representationRows = this.database.query(`
      SELECT wr.id, wr.source_snapshot_id, wr.media_type, wr.adapter_id,
             wr.adapter_version, wr.content_hash, wr.markdown, wr.derived_at
      FROM web_representations wr
      JOIN web_source_snapshots ws ON ws.id = wr.source_snapshot_id
      WHERE ws.resource_id = ?
      ORDER BY wr.derived_at, wr.id
    `).all(resource.id) as WebRepresentationRow[];
    const annotations = (this.database.query(`
      SELECT id, resource_id, source_snapshot_id, representation_id,
             revision_json, representation_json, anchor_json, body, created_at
      FROM web_resource_annotations
      WHERE resource_id = ?
      ORDER BY created_at, id
    `).all(resource.id) as WebResourceAnnotationRow[]).map((annotation) =>
      this.webAnnotationFromRow(annotation)
    );
    const history: WebResourceHistory = {
      sourceSnapshots: sourceRows.map((row) => this.webSourceSnapshotProvenance(row)),
      representations: representationRows.map((row) =>
        this.webRepresentationProvenance(row)
      ),
      annotations,
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
    } else if (
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

  private migrate(): void {
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
          provider TEXT NOT NULL CHECK (provider IN ('filesystem', 'web', 'github', 'application')),
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
          provider TEXT NOT NULL CHECK (provider IN ('filesystem', 'web', 'github', 'application')),
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
          fetched_at TEXT
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
          derived_at TEXT
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
        CREATE TABLE IF NOT EXISTS web_resource_annotations (
          id TEXT PRIMARY KEY,
          resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE RESTRICT,
          source_snapshot_id TEXT NOT NULL
            REFERENCES web_source_snapshots(id) ON DELETE RESTRICT,
          representation_id TEXT NOT NULL
            REFERENCES web_representations(id) ON DELETE RESTRICT,
          revision_json TEXT NOT NULL,
          representation_json TEXT NOT NULL,
          anchor_json TEXT NOT NULL,
          body TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS web_resource_annotations_resource
          ON web_resource_annotations(resource_id, created_at, id);
        CREATE INDEX IF NOT EXISTS web_resource_annotations_evidence
          ON web_resource_annotations(source_snapshot_id, representation_id, created_at, id);
      `);
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
