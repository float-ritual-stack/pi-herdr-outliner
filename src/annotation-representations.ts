import {annotationSourceHash} from "./annotations";
import type {AnnotationRepresentation, Block} from "./types";
import type {ResourceDescription} from "./resources";

export function blockAnnotationRepresentation(block: Block): AnnotationRepresentation {
  const contentHash = annotationSourceHash(block.text);
  return {
    id: `block:${block.id}:${contentHash}`,
    subject: { kind: "block", blockId: block.id },
    sourceSnapshot: {
      kind: "block",
      blockId: block.id,
      updatedAt: block.updatedAt,
      contentHash,
    },
    adapter: { id: "outliner.block-text", version: 1 },
    mediaType: "text/markdown",
    contentHash,
    capturedAt: block.updatedAt,
  };
}

export function resourceAnnotationRepresentation(
  description: ResourceDescription,
): AnnotationRepresentation | null {
  const pdf = description.pdf;
  if (pdf) {
    return {
      id: pdf.representation.id,
      subject: { kind: "resource", resourceId: description.resource.id },
      sourceSnapshot: {
        kind: "resource",
        resourceId: description.resource.id,
        sourceSnapshotId: pdf.sourceSnapshot.id,
        revision: pdf.sourceSnapshot.revision,
      },
      adapter: pdf.representation.adapter,
      mediaType: pdf.representation.mediaType,
      contentHash: pdf.representation.contentHash,
      capturedAt: pdf.representation.derivedAt,
    };
  }
  const filesystem = description.filesystem;
  if (filesystem) {
    const revision = filesystem.revision.revision;
    if (revision.kind !== "filesystem") {
      throw new Error("Filesystem Resource has a non-filesystem revision");
    }
    return {
      id: `filesystem:${description.resource.id}:${revision.mtimeNs}:${revision.size}:${filesystem.contentHash}`,
      subject: { kind: "resource", resourceId: description.resource.id },
      sourceSnapshot: {
        kind: "resource",
        resourceId: description.resource.id,
        sourceSnapshotId: null,
        revision: filesystem.revision,
      },
      adapter: { id: "filesystem.text", version: 1 },
      mediaType: description.resource.mediaType ?? "text/plain",
      contentHash: filesystem.contentHash,
      capturedAt: filesystem.capturedAt,
    };
  }
  const web = description.web;
  if (!web) return null;
  return {
    id: web.representation.id,
    subject: { kind: "resource", resourceId: description.resource.id },
    sourceSnapshot: {
      kind: "resource",
      resourceId: description.resource.id,
      sourceSnapshotId: web.sourceSnapshot.id,
      revision: web.sourceSnapshot.revision,
    },
    adapter: web.representation.adapter,
    mediaType: web.representation.mediaType,
    contentHash: web.representation.contentHash,
    capturedAt: web.representation.derivedAt ??
      web.sourceSnapshot.fetchedAt ??
      description.resource.updatedAt,
  };
}
