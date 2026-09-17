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
  type ResourceRevisionRef,
  type ResourceSource,
  type WebResourceAnnotation,
  type WebResourceDocument,
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
interface WebResourceCacheRow {
  address_version: number;
  generation: number;
  resource_id: string;
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

interface WebResourceAnnotationRow {
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
}

const DEFAULT_MAXIMUM_WEB_BYTES = 2 * 1024 * 1024;


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
  private readonly pendingWebRefreshes = new Map<string, Promise<ResourceDescription>>();

  constructor(
    private readonly database: Database,
    options: ResourceCatalogOptions = {},
  ) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.webExtractor = options.webExtractor ?? new BasicWebMarkdownExtractor();
    this.now = options.now ?? (() => new Date().toISOString());
    this.maximumWebBytes = options.maximumWebBytes ?? DEFAULT_MAXIMUM_WEB_BYTES;
    this.migrate();
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
        this.database.query("DELETE FROM web_resource_documents WHERE resource_id = ?")
          .run(resource.id);
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
      const cachedWeb = source.policy.deniedCapabilities.includes("read")
        ? null
        : this.webDocumentFromCurrentRead(resource);
      return {
        resource,
        source,
        requestedRevision,
        capabilities: deriveResourceCapabilityReport(
          source,
          destinationHostRegistered,
          resource.provider === "web" ? ["read", "refresh", "open-external"] : [],
        ),
        web: requestedRevision && cachedWeb &&
            !resourceRevisionRefEquals(requestedRevision, cachedWeb.revision)
          ? null
          : cachedWeb,
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
      description.resource.provider !== "web" ||
      description.web ||
      revision !== undefined
    ) {
      return description;
    }
    if (description.source.policy.deniedCapabilities.includes("read")) {
      return { ...description, webError: "Workspace policy denies reading this resource" };
    }
    try {
      return await this.refreshWeb(description.resource.id, destinationHostRegistered);
    } catch (error) {
      return { ...description, webError: errorText(error) };
    }
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
    return this.database.transaction(() => {
      const resource = this.requireFromCurrentRead(resourceId);
      if (resource.provider !== "web") {
        throw new ResourceCatalogError(
          "provider-mismatch",
          "Web annotations require a web resource",
        );
      }
      const document = this.webDocumentFromCurrentRead(resource);
      if (!document) {
        throw new ResourceCatalogError(
          "invalid-input",
          "Web resource has no cached Markdown representation",
        );
      }
      const revision = normalizeResourceRevisionRef(input.revision, resource);
      if (!resourceRevisionRefEquals(revision, document.revision)) {
        throw new ResourceCatalogError(
          "stale-revision",
          "Web annotation revision is not the current cached revision",
        );
      }
      const representation = input.representation;
      if (
        !representation ||
        representation.mediaType !== document.representation.mediaType ||
        representation.adapter.id !== document.representation.adapter.id ||
        representation.adapter.version !== document.representation.adapter.version ||
        representation.contentHash !== document.representation.contentHash
      ) {
        throw new ResourceCatalogError(
          "stale-revision",
          "Web annotation representation is not the current cached representation",
        );
      }
      const anchor = input.anchor;
      if (
        !anchor ||
        !Number.isSafeInteger(anchor.start) ||
        !Number.isSafeInteger(anchor.end) ||
        anchor.start! < 0 ||
        anchor.end! <= anchor.start! ||
        anchor.end! > document.markdown.length ||
        document.markdown.slice(anchor.start, anchor.end) !== anchor.exact
      ) {
        throw new ResourceCatalogError(
          "invalid-input",
          "Web annotation anchor must exactly match the cached Markdown",
        );
      }
      const prefix = document.markdown.slice(Math.max(0, anchor.start! - 64), anchor.start);
      const suffix = document.markdown.slice(anchor.end, anchor.end! + 64);
      if (anchor.prefix !== prefix || anchor.suffix !== suffix) {
        throw new ResourceCatalogError(
          "invalid-input",
          "Web annotation context does not match the cached Markdown",
        );
      }
      const annotation: WebResourceAnnotation = {
        id: crypto.randomUUID(),
        resourceId,
        revision,
        representation: document.representation,
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
      this.database.query(
        "INSERT INTO web_resource_annotations (id, resource_id, revision_json, representation_json, anchor_json, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        annotation.id,
        annotation.resourceId,
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
      const cached = this.webCacheRowFromCurrentRead(resource.id);
      return {
        resource,
        source,
        cache: cached?.address_version === resource.addressVersion ? cached : null,
      };
    })();
    const headers = new Headers({ Accept: "text/html,application/xhtml+xml" });
    if (snapshot.cache?.etag) headers.set("If-None-Match", snapshot.cache.etag);
    if (snapshot.cache?.last_modified) {
      headers.set("If-Modified-Since", snapshot.cache.last_modified);
    }
    const checkedAt = this.now();
    try {
      const { response, url: canonicalUrl } = await this.fetchWeb(
        snapshot.source,
        snapshot.resource.address.url,
        headers,
        AbortSignal.timeout(15_000),
      );
      if (response.status === 304) {
        if (!snapshot.cache) {
          throw new ResourceCatalogError(
            "source-unavailable",
            "Web provider returned not-modified without a cached representation",
          );
        }
        this.database.transaction(() => {
          this.assertWebRefreshCurrent(
            snapshot.resource,
            snapshot.cache?.generation ?? 0,
          );
          this.database.query(
            "UPDATE web_resource_documents SET generation = generation + 1, freshness = 'fresh', checked_at = ?, last_error = NULL WHERE resource_id = ?",
          ).run(checkedAt, snapshot.resource.id);
          this.bumpSequence();
        })();
        return this.describe(snapshot.resource.id, destinationHostRegistered);
      }
      if (!response.ok) {
        throw new ResourceCatalogError(
          "source-unavailable",
          `Web provider returned HTTP ${response.status}`,
        );
      }
      const mediaType = responseMediaType(response);
      if (mediaType !== "text/html" && mediaType !== "application/xhtml+xml") {
        throw new ResourceCatalogError(
          "invalid-input",
          `Web provider returned unsupported media type: ${mediaType || "unknown"}`,
        );
      }
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > this.maximumWebBytes) {
        throw new ResourceCatalogError(
          "invalid-input",
          `Web response exceeds ${this.maximumWebBytes} bytes`,
        );
      }
      const html = await this.readWebBody(response);
      const sourceHash = sha256(html);
      const etag = webEtag(response);
      const lastModified = response.headers.get("last-modified")?.trim() || null;
      const revision = webRevision(snapshot.resource, etag, lastModified, sourceHash);
      const unchanged = snapshot.cache?.source_hash === sourceHash;
      const markdown = unchanged
        ? snapshot.cache!.markdown
        : this.webExtractor.extract({ html, url: canonicalUrl });
      if (!markdown) {
        throw new ResourceCatalogError(
          "invalid-input",
          "Web Markdown extractor returned an empty representation",
        );
      }
      const representationHash = unchanged
        ? snapshot.cache!.representation_hash
        : sha256(markdown);
      const fetchedAt = unchanged ? snapshot.cache!.fetched_at : checkedAt;
      this.database.transaction(() => {
        this.assertWebRefreshCurrent(
          snapshot.resource,
          snapshot.cache?.generation ?? 0,
        );
        this.database.query(`
          INSERT INTO web_resource_documents (
            resource_id, address_version, generation, canonical_url, source_hash,
            markdown, revision_json, adapter_id, adapter_version,
            representation_hash, etag, last_modified, freshness, fetched_at,
            checked_at, last_error
          ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'fresh', ?, ?, NULL)
          ON CONFLICT(resource_id) DO UPDATE SET
            address_version = excluded.address_version,
            generation = web_resource_documents.generation + 1,
            canonical_url = excluded.canonical_url,
            source_hash = excluded.source_hash,
            markdown = excluded.markdown,
            revision_json = excluded.revision_json,
            adapter_id = excluded.adapter_id,
            adapter_version = excluded.adapter_version,
            representation_hash = excluded.representation_hash,
            etag = excluded.etag,
            last_modified = excluded.last_modified,
            freshness = 'fresh',
            fetched_at = excluded.fetched_at,
            checked_at = excluded.checked_at,
            last_error = NULL
        `).run(
          snapshot.resource.id,
          snapshot.resource.addressVersion,
          canonicalUrl,
          sourceHash,
          markdown,
          JSON.stringify(revision),
          this.webExtractor.adapter.id,
          this.webExtractor.adapter.version,
          representationHash,
          etag,
          lastModified,
          fetchedAt,
          checkedAt,
        );
        this.bumpSequence();
      })();
      return this.describe(snapshot.resource.id, destinationHostRegistered);
    } catch (error) {
      if (
        error instanceof ResourceCatalogError &&
        error.code === "version-conflict"
      ) {
        throw error;
      }
      if (!snapshot.cache) {
        if (error instanceof ResourceCatalogError) throw error;
        throw new ResourceCatalogError(
          "source-unavailable",
          `Web refresh failed: ${errorText(error)}`,
        );
      }
      this.database.transaction(() => {
        this.assertWebRefreshCurrent(snapshot.resource, snapshot.cache!.generation);
        this.database.query(
          "UPDATE web_resource_documents SET generation = generation + 1, freshness = 'failed', checked_at = ?, last_error = ? WHERE resource_id = ?",
        ).run(checkedAt, errorText(error), snapshot.resource.id);
        this.bumpSequence();
      })();
      return this.describe(snapshot.resource.id, destinationHostRegistered);
    }
  }

  private assertWebRefreshCurrent(
    snapshotResource: Extract<Resource, { provider: "web" }>,
    expectedGeneration: number,
  ): void {
    const resource = this.requireFromCurrentRead(snapshotResource.id);
    const cache = this.webCacheRowFromCurrentRead(snapshotResource.id);
    const currentGeneration =
      cache?.address_version === resource.addressVersion ? cache.generation : 0;
    if (
      resource.provider !== "web" ||
      resource.addressVersion !== snapshotResource.addressVersion ||
      currentGeneration !== expectedGeneration
    ) {
      throw new ResourceCatalogError(
        "version-conflict",
        "Web resource changed while its refresh was in flight",
      );
    }
  }

  private webCacheRowFromCurrentRead(resourceId: string): WebResourceCacheRow | null {
    return this.database.query(
      "SELECT resource_id, address_version, generation, canonical_url, source_hash, markdown, revision_json, adapter_id, adapter_version, representation_hash, etag, last_modified, freshness, fetched_at, checked_at, last_error FROM web_resource_documents WHERE resource_id = ?",
    ).get(resourceId) as WebResourceCacheRow | null;
  }

  private webAnnotationFromRow(row: WebResourceAnnotationRow): WebResourceAnnotation {
    return {
      id: row.id,
      resourceId: row.resource_id,
      revision: normalizeRetainedResourceRevisionRef(
        parsedJson(row.revision_json, "Web annotation revision"),
      ),
      representation: parsedJson(
        row.representation_json,
        "Web annotation representation",
      ) as WebResourceAnnotation["representation"],
      anchor: parsedJson(
        row.anchor_json,
        "Web annotation anchor",
      ) as WebResourceAnnotation["anchor"],
      body: row.body,
      createdAt: row.created_at,
    };
  }

  private webDocumentFromCurrentRead(resource: Resource): WebResourceDocument | null {
    if (resource.provider !== "web") return null;
    const row = this.webCacheRowFromCurrentRead(resource.id);
    if (!row || row.address_version !== resource.addressVersion) return null;
    const revision = normalizeResourceRevisionRef(
      parsedJson(row.revision_json, "Web resource revision"),
      resource,
    );
    const annotations = (this.database.query(
      "SELECT id, resource_id, revision_json, representation_json, anchor_json, body, created_at FROM web_resource_annotations WHERE resource_id = ? ORDER BY created_at, id",
    ).all(resource.id) as WebResourceAnnotationRow[]).map((annotation) =>
      this.webAnnotationFromRow(annotation)
    );
    return {
      canonicalUrl: row.canonical_url,
      markdown: row.markdown,
      revision,
      representation: {
        mediaType: "text/markdown",
        adapter: { id: row.adapter_id, version: row.adapter_version },
        contentHash: row.representation_hash,
      },
      freshness: row.freshness,
      fetchedAt: row.fetched_at,
      checkedAt: row.checked_at,
      lastError: row.last_error,
      annotations,
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
      const legacy = sourceColumns.length > 0 && !sourceColumns.some(({ name }) => name === "boundary_json");
      if (legacy) {
        this.database.exec(`
          ALTER TABLE resources RENAME TO resources_legacy_pie247;
          ALTER TABLE resource_sources RENAME TO resource_sources_legacy_pie247;
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
        CREATE TABLE IF NOT EXISTS web_resource_documents (
          resource_id TEXT PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
          address_version INTEGER NOT NULL CHECK (address_version >= 1),
          generation INTEGER NOT NULL CHECK (generation >= 1),
          canonical_url TEXT NOT NULL,
          source_hash TEXT NOT NULL,
          markdown TEXT NOT NULL,
          revision_json TEXT NOT NULL,
          adapter_id TEXT NOT NULL,
          adapter_version INTEGER NOT NULL CHECK (adapter_version >= 1),
          representation_hash TEXT NOT NULL,
          etag TEXT,
          last_modified TEXT,
          freshness TEXT NOT NULL CHECK (freshness IN ('fresh', 'failed')),
          fetched_at TEXT NOT NULL,
          checked_at TEXT NOT NULL,
          last_error TEXT
        );
        CREATE TABLE IF NOT EXISTS web_resource_annotations (
          id TEXT PRIMARY KEY,
          resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE RESTRICT,
          revision_json TEXT NOT NULL,
          representation_json TEXT NOT NULL,
          anchor_json TEXT NOT NULL,
          body TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS web_resource_annotations_resource
          ON web_resource_annotations(resource_id, created_at, id);
      `);
      if (legacy) this.migrateLegacyRows();
      this.upgradeFilesystemRootBindings();
    })();
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
