import { blockDisplayTitle } from "./references";
import {
  BLOCK_READ_FIELDS,
  DEFAULT_BLOCK_READ_FIELDS,
  type Block,
  type BlockReadField,
  type ProjectedBlock,
} from "./types";

export const MAX_BLOCK_READ_IDS = 1000;

const knownFields = new Set<string>(BLOCK_READ_FIELDS);

/** Validates requested fields and returns them in canonical order. */
export function normalizeBlockReadFields(fields: unknown): BlockReadField[] {
  if (fields === undefined) return [...DEFAULT_BLOCK_READ_FIELDS];
  if (!Array.isArray(fields)) throw new Error("fields must be an array of block field names");
  for (const field of fields) {
    if (typeof field !== "string" || !knownFields.has(field)) {
      throw new Error(`Unknown block field: ${String(field)}; expected ${BLOCK_READ_FIELDS.join(", ")}`);
    }
  }
  const requested = new Set<string>(fields);
  return BLOCK_READ_FIELDS.filter((field) => field === "id" || requested.has(field));
}

/** Validates a batch of block IDs; duplicates collapse to their first occurrence. */
export function normalizeBlockReadIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) throw new Error("ids must be an array of block IDs");
  if (ids.length === 0) throw new Error("ids must contain at least one block ID");
  if (ids.length > MAX_BLOCK_READ_IDS) {
    throw new Error(`ids can contain at most ${MAX_BLOCK_READ_IDS} block IDs`);
  }
  for (const id of ids) {
    if (typeof id !== "string" || !id) throw new Error("ids must contain only non-empty strings");
  }
  return [...new Set(ids as string[])];
}

export function projectBlock(
  block: Block,
  hasChildren: boolean,
  fields: readonly BlockReadField[],
): ProjectedBlock {
  const projected: ProjectedBlock = { id: block.id };
  for (const field of fields) {
    switch (field) {
      case "id":
        break;
      case "parent":
        projected.parentId = block.parentId;
        projected.position = block.position;
        break;
      case "title":
        projected.title = blockDisplayTitle(block);
        break;
      case "properties":
        projected.properties = block.properties;
        break;
      case "revision":
        projected.revision = block.revision;
        break;
      case "timestamps":
        projected.createdAt = block.createdAt;
        projected.updatedAt = block.updatedAt;
        break;
      case "author":
        projected.author = block.author;
        if (block.actorId) projected.actorId = block.actorId;
        if (block.sessionId) projected.sessionId = block.sessionId;
        if (block.taskId) projected.taskId = block.taskId;
        break;
      case "hasChildren":
        projected.hasChildren = hasChildren;
        break;
      case "text":
        projected.text = block.text;
        break;
    }
  }
  return projected;
}
