import { Database } from "bun:sqlite";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { Type, type Static } from "typebox";
import { Parse } from "typebox/value";
import {
  ResourceCatalogError,
  deriveResourceCapabilityReport,
  normalizeInternResourceInput,
  normalizeRelocateResourceInput,
  normalizeResourceAddress,
  normalizeResourceId,
  normalizeResourceRevisionRef,
  normalizeResourceSourceInput,
  type CreateResourceSourceInput,
  type InternResourceReceipt,
  type Resource,
  type ResourceAddress,
  type ResourceDescription,
  type ResourceRevisionRef,
  type ResourceSource,
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

export class ResourceCatalog {
  constructor(private readonly database: Database) {
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
      return {
        resource,
        source,
        requestedRevision,
        capabilities: deriveResourceCapabilityReport(source, destinationHostRegistered),
      };
    })();
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
