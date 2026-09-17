import type { Database } from "bun:sqlite";
import {
  ResourceCatalogError,
  normalizeResourceId,
  normalizeRetainedResourceRevisionRef,
  resourceRevisionRefEquals,
  type PurgedResourceArtifact,
  type ResourceRetentionArtifact,
  type ResourceRetentionArtifactKind,
  type ResourceRetentionArtifactRef,
  type ResourceRetentionCollectionReceipt,
  type ResourceRetentionPin,
  type ResourceRetentionPolicy,
  type ResourceRetentionReference,
  type ResourceRetentionReferenceOwner,
  type ResourceRetentionReport,
  type ResourceRetentionState,
  type ResourceRevisionRef,
  type ResourceRepresentationAdapter,
} from "./resources";

const DEFAULT_RETAINED_SNAPSHOTS = 5;
const DEFAULT_RETAINED_REPRESENTATIONS = 5;
const DEFAULT_MINIMUM_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_PURGE_GRACE_MS = 30 * 24 * 60 * 60 * 1_000;
const STATE_ORDER: readonly Exclude<ResourceRetentionState, "purged">[] = [
  "current",
  "hot",
  "referenced",
  "pinned",
  "evictable",
  "evicted",
];

interface RetentionPolicyRow {
  retain_newest_source_snapshots: number;
  retain_newest_representations_per_adapter: number;
  minimum_age_ms: number;
  purge_grace_ms: number;
  updated_at: string;
}

interface SnapshotRetentionRow {
  kind: "source-snapshot";
  storage: "web" | "pdf";
  id: string;
  resource_id: string;
  source_snapshot_id: null;
  adapter_id: null;
  adapter_version: null;
  captured_at: string | null;
  revision_json: string;
  payload_state: "available" | "evicted";
  payload_bytes: number;
  evicted_at: string | null;
}

interface RepresentationRetentionRow {
  kind: "representation";
  storage: "web" | "pdf";
  id: string;
  resource_id: string;
  source_snapshot_id: string;
  adapter_id: string;
  adapter_version: number;
  captured_at: string | null;
  revision_json: null;
  payload_state: "available" | "evicted";
  payload_bytes: number;
  evicted_at: string | null;
}

type RetentionRow = SnapshotRetentionRow | RepresentationRetentionRow;

interface PinRow {
  id: string;
  resource_id: string;
  artifact_kind: ResourceRetentionArtifactKind;
  artifact_id: string;
  label: string | null;
  created_at: string;
}

interface ReferenceRow {
  id: string;
  resource_id: string;
  artifact_kind: ResourceRetentionArtifactKind;
  artifact_id: string;
  owner_kind: ResourceRetentionReferenceOwner["kind"];
  owner_id: string;
  created_at: string;
}

interface EvidenceReferenceRow {
  source_snapshot_id: string | null;
  representation_id: string | null;
  pdf_source_snapshot_id: string | null;
  pdf_representation_id: string | null;
}

interface CurrentPointerRow {
  resource_id: string;
  source_snapshot_id: string | null;
  representation_id: string | null;
}

interface PurgedRow {
  artifact_kind: ResourceRetentionArtifactKind;
  artifact_id: string;
  resource_id: string;
  occurred_at: string;
  metadata_json: string;
}

export interface ResourceRetentionOptions {
  readonly now?: () => string;
  readonly activeRepresentationAdapters?: readonly ResourceRepresentationAdapter[];
  readonly markMutation?: () => void;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ResourceCatalogError("invalid-input", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function identity(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 500 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new ResourceCatalogError("invalid-input", `${label} must be 1-500 printable characters`);
  }
  return value.trim();
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ResourceCatalogError("invalid-input", `${label} must be a non-negative safe integer`);
  }
  return value;
}

function normalizeArtifact(value: unknown): ResourceRetentionArtifactRef {
  const artifact = record(value, "Resource retention artifact");
  if (artifact.kind !== "source-snapshot" && artifact.kind !== "representation") {
    throw new ResourceCatalogError(
      "invalid-input",
      `Unsupported Resource retention artifact kind: ${String(artifact.kind)}`,
    );
  }
  return { kind: artifact.kind, id: identity(artifact.id, "Resource retention artifact ID") };
}

function normalizeOwner(value: unknown): ResourceRetentionReferenceOwner {
  const owner = record(value, "Resource retention reference owner");
  if (owner.kind !== "review" && owner.kind !== "publication") {
    throw new ResourceCatalogError(
      "invalid-input",
      `Unsupported Resource retention reference owner: ${String(owner.kind)}`,
    );
  }
  return { kind: owner.kind, id: identity(owner.id, "Resource retention owner ID") };
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} contains invalid JSON`);
  }
}

function key(kind: ResourceRetentionArtifactKind, id: string): string {
  return `${kind}:${id}`;
}

function pinFromRow(row: PinRow): ResourceRetentionPin {
  return {
    id: row.id,
    resourceId: row.resource_id,
    artifact: { kind: row.artifact_kind, id: row.artifact_id },
    label: row.label,
    createdAt: row.created_at,
  };
}

function referenceFromRow(row: ReferenceRow): ResourceRetentionReference {
  return {
    id: row.id,
    resourceId: row.resource_id,
    artifact: { kind: row.artifact_kind, id: row.artifact_id },
    owner: { kind: row.owner_kind, id: row.owner_id },
    createdAt: row.created_at,
  };
}

function purgedFromRow(row: PurgedRow): PurgedResourceArtifact {
  const metadata = parseJson(row.metadata_json, "Purged Resource artifact metadata");
  return {
    artifact: { kind: row.artifact_kind, id: row.artifact_id },
    resourceId: row.resource_id,
    state: "purged",
    purgedAt: row.occurred_at,
    metadata: metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? metadata as Record<string, unknown>
      : {},
  };
}

function timestampAge(now: string, timestamp: string | null): number {
  const current = Date.parse(now);
  const captured = timestamp === null ? Number.NEGATIVE_INFINITY : Date.parse(timestamp);
  if (!Number.isFinite(current)) throw new Error("Retention clock returned an invalid timestamp");
  return Number.isFinite(captured) ? Math.max(0, current - captured) : Number.POSITIVE_INFINITY;
}

export class ResourceRetentionRepository {
  private readonly now: () => string;
  private readonly activeAdapters: ReadonlySet<string>;
  private readonly markMutation: () => void;

  constructor(
    private readonly database: Database,
    options: ResourceRetentionOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.activeAdapters = new Set(
      (options.activeRepresentationAdapters ?? []).map(({ id, version }) => `${id}@${version}`),
    );
    this.markMutation = options.markMutation ?? (() => {});
    this.migrate();
  }

  policy(): ResourceRetentionPolicy {
    return this.database.transaction(() => this.policyFromCurrentRead())();
  }

  configure(value: unknown): ResourceRetentionPolicy {
    const input = record(value, "Resource retention policy");
    const policy = {
      retainNewestSourceSnapshots: nonNegativeInteger(
        input.retainNewestSourceSnapshots,
        "Newest source snapshot count",
      ),
      retainNewestRepresentationsPerAdapter: nonNegativeInteger(
        input.retainNewestRepresentationsPerAdapter,
        "Newest representation count",
      ),
      minimumAgeMs: nonNegativeInteger(input.minimumAgeMs, "Minimum retention age"),
      purgeGraceMs: nonNegativeInteger(input.purgeGraceMs, "Purge grace age"),
    };
    return this.database.transaction(() => {
      const updatedAt = this.now();
      this.database.query(`
        UPDATE resource_retention_policy
        SET retain_newest_source_snapshots = ?,
            retain_newest_representations_per_adapter = ?,
            minimum_age_ms = ?, purge_grace_ms = ?, updated_at = ?
        WHERE singleton = 1
      `).run(
        policy.retainNewestSourceSnapshots,
        policy.retainNewestRepresentationsPerAdapter,
        policy.minimumAgeMs,
        policy.purgeGraceMs,
        updatedAt,
      );
      this.markMutation();
      return { ...policy, updatedAt };
    })();
  }

  pin(value: unknown): { pin: ResourceRetentionPin; created: boolean } {
    const input = record(value, "Resource retention pin");
    const artifact = normalizeArtifact(input.artifact);
    const label = input.label === undefined || input.label === null
      ? null
      : identity(input.label, "Resource retention pin label");
    return this.database.transaction(() => {
      const row = this.requireArtifactFromCurrentRead(artifact);
      const existing = this.database.query(`
        SELECT id, resource_id, artifact_kind, artifact_id, label, created_at
        FROM resource_retention_pins
        WHERE artifact_kind = ? AND artifact_id = ?
      `).get(artifact.kind, artifact.id) as PinRow | null;
      if (existing) return { pin: pinFromRow(existing), created: false };
      const id = crypto.randomUUID();
      const createdAt = this.now();
      this.database.query(`
        INSERT INTO resource_retention_pins
          (id, resource_id, artifact_kind, artifact_id, label, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, row.resource_id, artifact.kind, artifact.id, label, createdAt);
      this.markMutation();
      return {
        pin: { id, resourceId: row.resource_id, artifact, label, createdAt },
        created: true,
      };
    })();
  }

  unpin(pinId: unknown): { pinId: string; removed: boolean } {
    const normalized = identity(pinId, "Resource retention pin ID");
    return this.database.transaction(() => {
      const removed = this.database.query(
        "DELETE FROM resource_retention_pins WHERE id = ?",
      ).run(normalized).changes > 0;
      if (removed) this.markMutation();
      return { pinId: normalized, removed };
    })();
  }

  reference(value: unknown): { reference: ResourceRetentionReference; created: boolean } {
    const input = record(value, "Resource retention reference");
    const artifact = normalizeArtifact(input.artifact);
    const owner = normalizeOwner(input.owner);
    return this.database.transaction(() => {
      const row = this.requireArtifactFromCurrentRead(artifact);
      const existing = this.database.query(`
        SELECT id, resource_id, artifact_kind, artifact_id, owner_kind, owner_id, created_at
        FROM resource_retention_references
        WHERE artifact_kind = ? AND artifact_id = ? AND owner_kind = ? AND owner_id = ?
      `).get(artifact.kind, artifact.id, owner.kind, owner.id) as ReferenceRow | null;
      if (existing) return { reference: referenceFromRow(existing), created: false };
      const id = crypto.randomUUID();
      const createdAt = this.now();
      this.database.query(`
        INSERT INTO resource_retention_references
          (id, resource_id, artifact_kind, artifact_id, owner_kind, owner_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, row.resource_id, artifact.kind, artifact.id, owner.kind, owner.id, createdAt);
      this.markMutation();
      return {
        reference: { id, resourceId: row.resource_id, artifact, owner, createdAt },
        created: true,
      };
    })();
  }

  unreference(referenceId: unknown): { referenceId: string; removed: boolean } {
    const normalized = identity(referenceId, "Resource retention reference ID");
    return this.database.transaction(() => {
      const removed = this.database.query(
        "DELETE FROM resource_retention_references WHERE id = ?",
      ).run(normalized).changes > 0;
      if (removed) this.markMutation();
      return { referenceId: normalized, removed };
    })();
  }

  inspect(
    resourceId?: unknown,
    activeRevisions: readonly ResourceRevisionRef[] = [],
  ): ResourceRetentionReport {
    const normalized = resourceId === undefined ? null : normalizeResourceId(resourceId);
    return this.database.transaction(() =>
      this.reportFromCurrentRead(normalized, activeRevisions)
    )();
  }

  collect(
    mode: unknown,
    resourceId?: unknown,
    activeRevisions: readonly ResourceRevisionRef[] = [],
  ): ResourceRetentionCollectionReceipt {
    if (mode !== "evict" && mode !== "purge") {
      throw new ResourceCatalogError("invalid-input", `Unsupported Resource collection mode: ${String(mode)}`);
    }
    const collectionMode: ResourceRetentionCollectionReceipt["mode"] = mode;
    const normalized = resourceId === undefined ? null : normalizeResourceId(resourceId);
    return this.database.transaction(() => {
      const collectedAt = this.now();
      const report = this.reportFromCurrentRead(normalized, activeRevisions);
      const evicted: ResourceRetentionArtifactRef[] = [];
      const purged: PurgedResourceArtifact[] = [];
      if (collectionMode === "evict") {
        const candidates = report.artifacts
          .filter(({ states }) => states.includes("evictable"))
          .sort((left, right) =>
            Number(left.artifact.kind === "source-snapshot") -
              Number(right.artifact.kind === "source-snapshot") ||
            left.artifact.id.localeCompare(right.artifact.id)
          );
        for (const candidate of candidates) {
          const row = this.requireArtifactFromCurrentRead(candidate.artifact);
          const changed = row.storage === "web"
            ? this.database.query(
                candidate.artifact.kind === "representation"
                  ? `UPDATE web_representations
                     SET markdown = NULL, payload_state = 'evicted',
                         payload_bytes = 0, evicted_at = ?
                     WHERE id = ? AND payload_state = 'available'`
                  : `UPDATE web_source_snapshots
                     SET html = NULL, payload_state = 'evicted',
                         payload_bytes = 0, evicted_at = ?
                     WHERE id = ? AND payload_state = 'available'`,
              ).run(collectedAt, candidate.artifact.id).changes
            : this.database.query(
                candidate.artifact.kind === "representation"
                  ? `UPDATE pdf_representations
                     SET markdown = NULL, pages_json = NULL,
                         payload_state = 'evicted', payload_bytes = 0, evicted_at = ?
                     WHERE id = ? AND payload_state = 'available'`
                  : `UPDATE pdf_source_snapshots
                     SET bytes = NULL, payload_state = 'evicted',
                         payload_bytes = 0, evicted_at = ?
                     WHERE id = ? AND payload_state = 'available'`,
              ).run(collectedAt, candidate.artifact.id).changes;
          if (changed === 0) continue;
          if (row.storage === "pdf" && candidate.artifact.kind === "source-snapshot") {
            this.database.query(`
              UPDATE pdf_representations
              SET payload_state = 'evicted', evicted_at = ?
              WHERE source_snapshot_id = ? AND media_type = 'application/pdf'
            `).run(collectedAt, candidate.artifact.id);
          }
          evicted.push(candidate.artifact);
          this.recordTransition(
            candidate.artifact,
            candidate.resourceId,
            "evicted",
            collectedAt,
            { bytesFreed: candidate.payloadBytes, capturedAt: candidate.capturedAt },
          );
        }
      } else {
        const candidates = report.artifacts
          .filter(({ states, evictedAt, capturedAt }) =>
            states.length === 1 &&
            states[0] === "evicted" &&
            timestampAge(collectedAt, evictedAt ?? capturedAt) >= report.policy.purgeGraceMs
          )
          .sort((left, right) =>
            Number(left.artifact.kind === "source-snapshot") -
              Number(right.artifact.kind === "source-snapshot") ||
            left.artifact.id.localeCompare(right.artifact.id)
          );
        for (const candidate of candidates) {
          const row = this.requireArtifactFromCurrentRead(candidate.artifact);
          if (candidate.artifact.kind === "source-snapshot") {
            const childTable = row.storage === "web"
              ? "web_representations"
              : "pdf_representations";
            const child = this.database.query(
              `SELECT 1 FROM ${childTable}
               WHERE source_snapshot_id = ?
                 ${row.storage === "pdf" ? "AND media_type = 'text/markdown'" : ""}
               LIMIT 1`,
            ).get(candidate.artifact.id);
            if (child) continue;
          }
          const metadata = {
            sourceSnapshotId: candidate.sourceSnapshotId,
            adapter: candidate.adapter,
            capturedAt: candidate.capturedAt,
            evictedAt: candidate.evictedAt,
          };
          const table = row.storage === "web"
            ? candidate.artifact.kind === "representation"
              ? "web_representations"
              : "web_source_snapshots"
            : candidate.artifact.kind === "representation"
              ? "pdf_representations"
              : "pdf_source_snapshots";
          if (row.storage === "pdf" && candidate.artifact.kind === "source-snapshot") {
            this.database.query(
              "DELETE FROM pdf_representations WHERE source_snapshot_id = ? AND media_type = 'application/pdf'",
            ).run(candidate.artifact.id);
          }
          const changed = this.database.query(`DELETE FROM ${table} WHERE id = ?`).run(
            candidate.artifact.id,
          ).changes;
          if (changed === 0) continue;
          this.recordTransition(
            candidate.artifact,
            candidate.resourceId,
            "purged",
            collectedAt,
            metadata,
          );
          purged.push({
            artifact: candidate.artifact,
            resourceId: candidate.resourceId,
            state: "purged",
            purgedAt: collectedAt,
            metadata,
          });
        }
      }
      if (evicted.length > 0 || purged.length > 0) this.markMutation();
      return { mode: collectionMode, resourceId: normalized, evicted, purged, collectedAt };
    })();
  }

  private reportFromCurrentRead(
    resourceId: string | null,
    activeRevisions: readonly ResourceRevisionRef[],
  ): ResourceRetentionReport {
    if (resourceId !== null) this.requireResourceFromCurrentRead(resourceId);
    const policy = this.policyFromCurrentRead();
    const now = this.now();
    const snapshots = this.database.query(`
      SELECT 'source-snapshot' AS kind, 'web' AS storage, id, resource_id,
             NULL AS source_snapshot_id, NULL AS adapter_id, NULL AS adapter_version,
             fetched_at AS captured_at, revision_json,
             payload_state, payload_bytes, evicted_at
      FROM web_source_snapshots
      WHERE ? IS NULL OR resource_id = ?
      UNION ALL
      SELECT 'source-snapshot' AS kind, 'pdf' AS storage, id, resource_id,
             NULL AS source_snapshot_id, NULL AS adapter_id, NULL AS adapter_version,
             captured_at, revision_json, payload_state, payload_bytes, evicted_at
      FROM pdf_source_snapshots
      WHERE ? IS NULL OR resource_id = ?
    `).all(resourceId, resourceId, resourceId, resourceId) as SnapshotRetentionRow[];
    const representations = this.database.query(`
      SELECT 'representation' AS kind, 'web' AS storage, wr.id, ws.resource_id,
             wr.source_snapshot_id, wr.adapter_id, wr.adapter_version,
             wr.derived_at AS captured_at, NULL AS revision_json,
             wr.payload_state, wr.payload_bytes, wr.evicted_at
      FROM web_representations wr
      JOIN web_source_snapshots ws ON ws.id = wr.source_snapshot_id
      WHERE ? IS NULL OR ws.resource_id = ?
      UNION ALL
      SELECT 'representation' AS kind, 'pdf' AS storage, pr.id, ps.resource_id,
             pr.source_snapshot_id, pr.adapter_id, pr.adapter_version,
             pr.derived_at AS captured_at, NULL AS revision_json,
             pr.payload_state, pr.payload_bytes, pr.evicted_at
      FROM pdf_representations pr
      JOIN pdf_source_snapshots ps ON ps.id = pr.source_snapshot_id
      WHERE ? IS NULL OR ps.resource_id = ?
    `).all(resourceId, resourceId, resourceId, resourceId) as RepresentationRetentionRow[];
    snapshots.sort((left, right) =>
      left.resource_id.localeCompare(right.resource_id) ||
      (right.captured_at ?? "").localeCompare(left.captured_at ?? "") ||
      right.id.localeCompare(left.id)
    );
    representations.sort((left, right) =>
      left.resource_id.localeCompare(right.resource_id) ||
      (right.captured_at ?? "").localeCompare(left.captured_at ?? "") ||
      right.id.localeCompare(left.id)
    );
    const rows: RetentionRow[] = [...snapshots, ...representations];
    const byKey = new Map(rows.map((row) => [key(row.kind, row.id), row]));
    const states = new Map<string, Set<Exclude<ResourceRetentionState, "purged">>>();
    const protect = (
      artifact: ResourceRetentionArtifactRef,
      state: "current" | "hot" | "referenced" | "pinned",
    ): void => {
      if (!byKey.has(key(artifact.kind, artifact.id))) return;
      const values = states.get(key(artifact.kind, artifact.id)) ?? new Set();
      values.add(state);
      states.set(key(artifact.kind, artifact.id), values);
    };

    const pointers = this.database.query(`
      SELECT resource_id, source_snapshot_id, representation_id
      FROM web_resource_state
      WHERE ? IS NULL OR resource_id = ?
      UNION ALL
      SELECT resource_id, source_snapshot_id, representation_id
      FROM pdf_resource_state
      WHERE ? IS NULL OR resource_id = ?
    `).all(resourceId, resourceId, resourceId, resourceId) as CurrentPointerRow[];
    for (const pointer of pointers) {
      if (pointer.source_snapshot_id) {
        protect({ kind: "source-snapshot", id: pointer.source_snapshot_id }, "current");
      }
      if (pointer.representation_id) {
        protect({ kind: "representation", id: pointer.representation_id }, "current");
      }
    }

    const snapshotsByResource = new Map<string, SnapshotRetentionRow[]>();
    for (const snapshot of snapshots) {
      if (snapshot.payload_state !== "available") continue;
      const group = snapshotsByResource.get(snapshot.resource_id) ?? [];
      group.push(snapshot);
      snapshotsByResource.set(snapshot.resource_id, group);
    }
    for (const group of snapshotsByResource.values()) {
      for (const snapshot of group.slice(0, policy.retainNewestSourceSnapshots)) {
        protect({ kind: "source-snapshot", id: snapshot.id }, "hot");
      }
    }

    const representationsByAdapter = new Map<string, RepresentationRetentionRow[]>();
    for (const representation of representations) {
      if (
        representation.payload_state !== "available" ||
        !this.activeAdapters.has(`${representation.adapter_id}@${representation.adapter_version}`)
      ) continue;
      const groupKey = `${representation.resource_id}:${representation.adapter_id}@${representation.adapter_version}`;
      const group = representationsByAdapter.get(groupKey) ?? [];
      group.push(representation);
      representationsByAdapter.set(groupKey, group);
    }
    for (const group of representationsByAdapter.values()) {
      for (const representation of group.slice(0, policy.retainNewestRepresentationsPerAdapter)) {
        protect({ kind: "representation", id: representation.id }, "hot");
      }
    }

    const pins = this.pinRowsFromCurrentRead(resourceId);
    for (const pin of pins) protect({ kind: pin.artifact_kind, id: pin.artifact_id }, "pinned");
    const references = this.referenceRowsFromCurrentRead(resourceId);
    for (const reference of references) {
      protect({ kind: reference.artifact_kind, id: reference.artifact_id }, "referenced");
    }
    for (const evidence of this.evidenceReferencesFromCurrentRead(resourceId)) {
      if (evidence.source_snapshot_id) {
        protect({ kind: "source-snapshot", id: evidence.source_snapshot_id }, "referenced");
      }
      if (evidence.pdf_source_snapshot_id) {
        protect(
          { kind: "source-snapshot", id: evidence.pdf_source_snapshot_id },
          "referenced",
        );
      }
      if (evidence.pdf_representation_id) {
        protect(
          { kind: "representation", id: evidence.pdf_representation_id },
          "referenced",
        );
      }
      if (evidence.representation_id) {
        protect({ kind: "representation", id: evidence.representation_id }, "referenced");
      }
    }
    for (const revisionValue of activeRevisions) {
      const revision = normalizeRetainedResourceRevisionRef(revisionValue);
      for (const snapshot of snapshots) {
        if (
          snapshot.resource_id === revision.resourceId &&
          resourceRevisionRefEquals(
            normalizeRetainedResourceRevisionRef(
              parseJson(snapshot.revision_json, "Web source snapshot revision"),
            ),
            revision,
          )
        ) {
          protect({ kind: "source-snapshot", id: snapshot.id }, "referenced");
          for (const representation of representations) {
            if (representation.source_snapshot_id === snapshot.id) {
              protect({ kind: "representation", id: representation.id }, "referenced");
            }
          }
        }
      }
    }
    for (const row of rows) {
      if (
        row.payload_state === "available" &&
        timestampAge(now, row.captured_at) < policy.minimumAgeMs
      ) {
        protect({ kind: row.kind, id: row.id }, "hot");
      }
    }


    for (const representation of representations) {
      const childStates = states.get(key("representation", representation.id));
      if (!childStates) continue;
      for (const state of childStates) {
        if (
          state === "current" ||
          state === "hot" ||
          state === "referenced" ||
          state === "pinned"
        ) {
          protect({ kind: "source-snapshot", id: representation.source_snapshot_id }, state);
        }
      }
    }
    for (const pin of pins) {
      if (pin.artifact_kind !== "source-snapshot") continue;
      for (const representation of representations) {
        if (representation.source_snapshot_id === pin.artifact_id) {
          protect({ kind: "representation", id: representation.id }, "pinned");
        }
      }
    }

    const artifacts = rows.map((row): ResourceRetentionArtifact => {
      const artifactStates = states.get(key(row.kind, row.id)) ?? new Set();
      if (artifactStates.size === 0 && row.payload_state === "available") {
        artifactStates.add("evictable");
      }
      if (row.payload_state === "evicted") artifactStates.add("evicted");
      return {
        artifact: { kind: row.kind, id: row.id },
        resourceId: row.resource_id,
        sourceSnapshotId: row.source_snapshot_id,
        adapter: row.kind === "representation"
          ? { id: row.adapter_id, version: row.adapter_version }
          : null,
        states: STATE_ORDER.filter((state) => artifactStates.has(state)),
        payloadAvailable: row.payload_state === "available",
        payloadBytes: row.payload_bytes,
        capturedAt: row.captured_at,
        evictedAt: row.evicted_at,
      };
    }).sort((left, right) =>
      left.resourceId.localeCompare(right.resourceId) ||
      left.artifact.kind.localeCompare(right.artifact.kind) ||
      left.artifact.id.localeCompare(right.artifact.id)
    );
    return {
      policy,
      artifacts,
      pins: pins.map(pinFromRow),
      references: references.map(referenceFromRow),
      purged: this.purgedRowsFromCurrentRead(resourceId).map(purgedFromRow),
    };
  }

  private requireResourceFromCurrentRead(resourceId: string): void {
    const row = this.database.query(
      "SELECT 1 FROM resources WHERE id = ?",
    ).get(resourceId);
    if (!row) throw new ResourceCatalogError("missing-resource", `Resource not found: ${resourceId}`);
  }

  private requireArtifactFromCurrentRead(artifact: ResourceRetentionArtifactRef): RetentionRow {
    const row = artifact.kind === "source-snapshot"
      ? this.database.query(`
          SELECT 'source-snapshot' AS kind, 'web' AS storage, id, resource_id,
                 NULL AS source_snapshot_id, NULL AS adapter_id, NULL AS adapter_version,
                 fetched_at AS captured_at, revision_json, payload_state,
                 payload_bytes, evicted_at
          FROM web_source_snapshots WHERE id = ?
          UNION ALL
          SELECT 'source-snapshot' AS kind, 'pdf' AS storage, id, resource_id,
                 NULL AS source_snapshot_id, NULL AS adapter_id, NULL AS adapter_version,
                 captured_at, revision_json, payload_state, payload_bytes, evicted_at
          FROM pdf_source_snapshots WHERE id = ?
        `).get(artifact.id, artifact.id) as SnapshotRetentionRow | null
      : this.database.query(`
          SELECT 'representation' AS kind, 'web' AS storage, wr.id, ws.resource_id,
                 wr.source_snapshot_id, wr.adapter_id, wr.adapter_version,
                 wr.derived_at AS captured_at, NULL AS revision_json,
                 wr.payload_state, wr.payload_bytes, wr.evicted_at
          FROM web_representations wr
          JOIN web_source_snapshots ws ON ws.id = wr.source_snapshot_id
          WHERE wr.id = ?
          UNION ALL
          SELECT 'representation' AS kind, 'pdf' AS storage, pr.id, ps.resource_id,
                 pr.source_snapshot_id, pr.adapter_id, pr.adapter_version,
                 pr.derived_at AS captured_at, NULL AS revision_json,
                 pr.payload_state, pr.payload_bytes, pr.evicted_at
          FROM pdf_representations pr
          JOIN pdf_source_snapshots ps ON ps.id = pr.source_snapshot_id
          WHERE pr.id = ?
        `).get(artifact.id, artifact.id) as RepresentationRetentionRow | null;
    if (!row) {
      throw new ResourceCatalogError(
        "invalid-input",
        `Resource retention artifact not found: ${artifact.kind} ${artifact.id}`,
      );
    }
    return row;
  }

  private policyFromCurrentRead(): ResourceRetentionPolicy {
    const row = this.database.query(`
      SELECT retain_newest_source_snapshots,
             retain_newest_representations_per_adapter,
             minimum_age_ms, purge_grace_ms, updated_at
      FROM resource_retention_policy WHERE singleton = 1
    `).get() as RetentionPolicyRow | null;
    if (!row) throw new Error("Resource retention policy is unavailable");
    return {
      retainNewestSourceSnapshots: row.retain_newest_source_snapshots,
      retainNewestRepresentationsPerAdapter: row.retain_newest_representations_per_adapter,
      minimumAgeMs: row.minimum_age_ms,
      purgeGraceMs: row.purge_grace_ms,
      updatedAt: row.updated_at,
    };
  }

  private pinRowsFromCurrentRead(resourceId: string | null): PinRow[] {
    return this.database.query(`
      SELECT id, resource_id, artifact_kind, artifact_id, label, created_at
      FROM resource_retention_pins
      WHERE ? IS NULL OR resource_id = ?
      ORDER BY created_at, id
    `).all(resourceId, resourceId) as PinRow[];
  }

  private referenceRowsFromCurrentRead(resourceId: string | null): ReferenceRow[] {
    return this.database.query(`
      SELECT id, resource_id, artifact_kind, artifact_id, owner_kind, owner_id, created_at
      FROM resource_retention_references
      WHERE ? IS NULL OR resource_id = ?
      ORDER BY created_at, id
    `).all(resourceId, resourceId) as ReferenceRow[];
  }

  private evidenceReferencesFromCurrentRead(resourceId: string | null): EvidenceReferenceRow[] {
    const exists = this.database.query(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'annotation_resource_evidence_refs'",
    ).get();
    if (!exists) return [];
    return this.database.query(`
      SELECT evidence.source_snapshot_id, evidence.representation_id,
             evidence.pdf_source_snapshot_id, evidence.pdf_representation_id
      FROM annotation_resource_evidence_refs evidence
      JOIN annotation_targets target
        ON target.annotation_block_id = evidence.annotation_block_id
      WHERE ? IS NULL OR target.resource_id = ?
      ORDER BY evidence.id
    `).all(resourceId, resourceId) as EvidenceReferenceRow[];
  }

  private purgedRowsFromCurrentRead(resourceId: string | null): PurgedRow[] {
    return this.database.query(`
      SELECT artifact_kind, artifact_id, resource_id, occurred_at, metadata_json
      FROM resource_retention_events
      WHERE transition = 'purged' AND (? IS NULL OR resource_id = ?)
      ORDER BY occurred_at, id
    `).all(resourceId, resourceId) as PurgedRow[];
  }

  private recordTransition(
    artifact: ResourceRetentionArtifactRef,
    resourceId: string,
    transition: "evicted" | "purged",
    occurredAt: string,
    metadata: Readonly<Record<string, unknown>>,
  ): void {
    this.database.query(`
      INSERT INTO resource_retention_events
        (id, artifact_kind, artifact_id, resource_id, transition, occurred_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      artifact.kind,
      artifact.id,
      resourceId,
      transition,
      occurredAt,
      JSON.stringify(metadata),
    );
  }

  private migrate(): void {
    this.database.transaction(() => {
      const snapshotColumns = new Set(
        (this.database.query("PRAGMA table_info(web_source_snapshots)").all() as Array<{ name: string }>)
          .map(({ name }) => name),
      );
      const representationColumns = new Set(
        (this.database.query("PRAGMA table_info(web_representations)").all() as Array<{ name: string }>)
          .map(({ name }) => name),
      );
      if (!snapshotColumns.has("payload_state")) {
        this.database.exec("ALTER TABLE web_source_snapshots ADD COLUMN payload_state TEXT NOT NULL DEFAULT 'available' CHECK(payload_state IN ('available','evicted'))");
      }
      if (!snapshotColumns.has("payload_bytes")) {
        this.database.exec("ALTER TABLE web_source_snapshots ADD COLUMN payload_bytes INTEGER NOT NULL DEFAULT 0 CHECK(payload_bytes >= 0)");
      }
      if (!snapshotColumns.has("evicted_at")) {
        this.database.exec("ALTER TABLE web_source_snapshots ADD COLUMN evicted_at TEXT");
      }
      if (!representationColumns.has("payload_state")) {
        this.database.exec("ALTER TABLE web_representations ADD COLUMN payload_state TEXT NOT NULL DEFAULT 'available' CHECK(payload_state IN ('available','evicted'))");
      }
      if (!representationColumns.has("payload_bytes")) {
        this.database.exec("ALTER TABLE web_representations ADD COLUMN payload_bytes INTEGER NOT NULL DEFAULT 0 CHECK(payload_bytes >= 0)");
      }
      if (!representationColumns.has("evicted_at")) {
        this.database.exec("ALTER TABLE web_representations ADD COLUMN evicted_at TEXT");
      }
      const payloadMigration = this.database.query(
        "SELECT value FROM metadata WHERE key = 'resource_retention_payload_migration'",
      ).get();
      if (!payloadMigration) {
        this.database.exec(`
          UPDATE web_source_snapshots
          SET payload_state = CASE WHEN html IS NULL THEN 'evicted' ELSE 'available' END,
              payload_bytes = CASE WHEN html IS NULL THEN 0 ELSE length(CAST(html AS BLOB)) END
          WHERE evicted_at IS NULL;
          UPDATE web_representations
          SET payload_state = CASE WHEN markdown IS NULL THEN 'evicted' ELSE 'available' END,
              payload_bytes = CASE WHEN markdown IS NULL THEN 0 ELSE length(CAST(markdown AS BLOB)) END
          WHERE evicted_at IS NULL;
        `);
        this.database.query(
          "INSERT INTO metadata (key, value) VALUES ('resource_retention_payload_migration', '1')",
        ).run();
      }
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS resource_retention_policy (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
          retain_newest_source_snapshots INTEGER NOT NULL CHECK(retain_newest_source_snapshots >= 0),
          retain_newest_representations_per_adapter INTEGER NOT NULL CHECK(retain_newest_representations_per_adapter >= 0),
          minimum_age_ms INTEGER NOT NULL CHECK(minimum_age_ms >= 0),
          purge_grace_ms INTEGER NOT NULL CHECK(purge_grace_ms >= 0),
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS resource_retention_pins (
          id TEXT PRIMARY KEY,
          resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE RESTRICT,
          artifact_kind TEXT NOT NULL CHECK(artifact_kind IN ('source-snapshot','representation')),
          artifact_id TEXT NOT NULL,
          label TEXT,
          created_at TEXT NOT NULL,
          UNIQUE(artifact_kind, artifact_id)
        );
        CREATE INDEX IF NOT EXISTS resource_retention_pins_resource
          ON resource_retention_pins(resource_id, created_at, id);
        CREATE TABLE IF NOT EXISTS resource_retention_references (
          id TEXT PRIMARY KEY,
          resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE RESTRICT,
          artifact_kind TEXT NOT NULL CHECK(artifact_kind IN ('source-snapshot','representation')),
          artifact_id TEXT NOT NULL,
          owner_kind TEXT NOT NULL CHECK(owner_kind IN ('review','publication')),
          owner_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(artifact_kind, artifact_id, owner_kind, owner_id)
        );
        CREATE INDEX IF NOT EXISTS resource_retention_references_resource
          ON resource_retention_references(resource_id, created_at, id);
        CREATE TABLE IF NOT EXISTS resource_retention_events (
          id TEXT PRIMARY KEY,
          artifact_kind TEXT NOT NULL CHECK(artifact_kind IN ('source-snapshot','representation')),
          artifact_id TEXT NOT NULL,
          resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE RESTRICT,
          transition TEXT NOT NULL CHECK(transition IN ('evicted','purged')),
          occurred_at TEXT NOT NULL,
          metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json))
        );
        CREATE INDEX IF NOT EXISTS resource_retention_events_resource
          ON resource_retention_events(resource_id, occurred_at, id);
      `);
      this.database.query(`
        INSERT OR IGNORE INTO resource_retention_policy (
          singleton, retain_newest_source_snapshots,
          retain_newest_representations_per_adapter,
          minimum_age_ms, purge_grace_ms, updated_at
        ) VALUES (1, ?, ?, ?, ?, ?)
      `).run(
        DEFAULT_RETAINED_SNAPSHOTS,
        DEFAULT_RETAINED_REPRESENTATIONS,
        DEFAULT_MINIMUM_AGE_MS,
        DEFAULT_PURGE_GRACE_MS,
        this.now(),
      );
    })();
  }
}
