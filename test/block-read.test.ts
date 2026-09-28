import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutlinerClient, type RequestInput } from "../src/client";
import { MAX_BLOCK_READ_IDS } from "../src/block-projection";
import { OutlinerServer } from "../src/server";
import { OutlinerStore } from "../src/store";
import type {
  BlockReadCollection,
  ProjectedBlockCollection,
  VisibleBlockCollection,
} from "../src/types";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function startService() {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-block-read-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  const socket = join(directory, "outliner.sock");
  const server = new OutlinerServer(store, socket);
  await server.start();
  cleanups.push(async () => {
    await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, client: new OutlinerClient(socket) };
}

const longBody = "\n\n" + "Card details that a list view never renders. ".repeat(200);

test("reads many blocks in request order with a field projection and per-id availability", async () => {
  const { store, client } = await startService();
  const lane = store.create("Lane [type::board-lane]");
  const card = store.create(`Draft the release note [stage::queued] [owner::sam]${longBody}`, lane.id, "agent", {
    actorId: "fixture-agent",
  });
  const child = store.create("Checklist for the note", card.id);
  const trashed = store.create("Retired card [stage::done]", lane.id);
  store.delete(trashed.id);
  const missing = "00000000-0000-4000-8000-000000000000";
  const sequenceBefore = store.sequence;

  const read = await client.request<BlockReadCollection>({
    action: "blocks.read",
    ids: [card.id, missing, lane.id, trashed.id, card.id, child.id],
  });
  expect(read.fields).toEqual(["id", "parent", "title", "properties", "revision", "timestamps", "author", "hasChildren"]);
  expect(read.blocks.map((block) => block.id)).toEqual([card.id, lane.id, child.id]);
  expect(read.blocks[0]).toEqual({
    id: card.id,
    parentId: lane.id,
    position: 0,
    title: "Draft the release note",
    properties: [{ key: "stage", value: "queued" }, { key: "owner", value: "sam" }],
    revision: card.revision,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
    author: "agent",
    actorId: "fixture-agent",
    hasChildren: true,
  });
  expect(read.blocks[1]!.hasChildren).toBe(true);
  expect(read.blocks[2]!.hasChildren).toBe(false);
  expect(read.blocks.some((block) => "text" in block)).toBe(false);
  expect(read.unavailable).toEqual([
    { id: missing, status: "missing" },
    { id: trashed.id, status: "trashed", deletedRootId: trashed.id },
  ]);

  const titles = await client.request<BlockReadCollection>({
    action: "blocks.read", ids: [card.id], fields: ["title"],
  });
  expect(titles.blocks).toEqual([{ id: card.id, title: "Draft the release note" }]);
  const withText = await client.request<BlockReadCollection>({
    action: "blocks.read", ids: [card.id], fields: ["text", "revision"],
  });
  expect(withText.fields).toEqual(["id", "revision", "text"]);
  expect(withText.blocks).toEqual([{ id: card.id, revision: card.revision, text: store.require(card.id).text }]);

  // A trashed parent's subtree is unavailable too, identified by its deletion root.
  store.delete(lane.id);
  const afterTrash = await client.request<BlockReadCollection>({ action: "blocks.read", ids: [child.id], fields: [] });
  expect(afterTrash.blocks).toEqual([]);
  expect(afterTrash.unavailable).toEqual([{ id: child.id, status: "trashed", deletedRootId: lane.id }]);
  expect(store.sequence).toBe(sequenceBefore + 1);
});

test("projects blocks.query without changing its matches, order or completeness", async () => {
  const { store, client } = await startService();
  const board = store.create("Board fixture");
  for (let index = 0; index < 5; index += 1) {
    const card = store.create(`Card ${index} [kind::fixture-card]${longBody}`, board.id);
    if (index === 1) store.create("Nested note", card.id);
  }
  const query = { filters: [{ key: "kind", value: "fixture-card" }], limit: 3 };
  const full = await client.request<VisibleBlockCollection>({ action: "blocks.query", query });
  const projected = await client.request<ProjectedBlockCollection>({
    action: "blocks.query", query, fields: ["title", "properties", "hasChildren"],
  });
  expect(projected.completeness).toEqual(full.completeness);
  expect(projected.completeness).toEqual({ kind: "truncated", limit: 3 });
  expect(projected.fields).toEqual(["id", "title", "properties", "hasChildren"]);
  expect(projected.blocks).toEqual(full.blocks.map((block) => ({
    id: block.id,
    depth: block.depth,
    title: block.text.split(" [")[0],
    properties: block.properties,
    hasChildren: block.hasChildren,
  })));
  expect(JSON.stringify(projected).length * 20).toBeLessThan(JSON.stringify(full).length);
});

test("rejects malformed batch reads before reading", async () => {
  const { client } = await startService();
  const request = (input: unknown) => client.request(input as RequestInput);
  await expect(request({ action: "blocks.read", ids: [] })).rejects.toThrow("at least one block ID");
  await expect(request({ action: "blocks.read", ids: "one" })).rejects.toThrow("ids must be an array");
  await expect(request({ action: "blocks.read", ids: [42] })).rejects.toThrow("non-empty strings");
  await expect(request({
    action: "blocks.read",
    ids: Array.from({ length: MAX_BLOCK_READ_IDS + 1 }, (_, index) => `block-${index}`),
  })).rejects.toThrow(`at most ${MAX_BLOCK_READ_IDS}`);
  await expect(request({ action: "blocks.read", ids: ["x"], fields: ["body"] })).rejects.toThrow("Unknown block field: body");
  await expect(request({ action: "blocks.query", query: { limit: 5 }, fields: "title" })).rejects.toThrow("fields must be an array");
});
