// PIE-424, PIE-295: fragment completion searches every note through the service, and anchors are written by
// it. Fictional notes only.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutlinerClient } from "../src/client";
import { searchFragmentCandidates, type FragmentCandidateCollection } from "../src/fragment-search";
import { ReferenceCompletionSession, referenceCompletionProvider } from "../src/reference-completion";
import { OutlinerServer } from "../src/server";
import { OutlinerStore } from "../src/store";
import { TextBuffer } from "../src/text-buffer";
import type { Block, OutlinerServiceStatus } from "../src/types";

const note = (id: string, text: string, updatedAt = "2026-09-01T00:00:00Z"): Block =>
  ({ id, text, revision: 1, parentId: null, position: 0, author: "user", createdAt: updatedAt, updatedAt, properties: [] } as unknown as Block);

test("candidates: headings anchored or not (with the anchor they'd get), anchors by id, code left out, the draft first", () => {
  const garden = note("garden01", "Garden\n## Beds ^beds\n## Paths\n```\n## not a heading\n```\n- [ ] Stake the beans ^t-b3a515");
  const shed = note("shed0001", "Shed\n## Paths ^shed-paths", "2026-09-02T00:00:00Z");
  const r = searchFragmentCandidates([garden, shed], { noteQuery: "garden", fragmentQuery: "", mode: "heading" });
  expect(r.items.map(i => [i.label, i.fragmentId ?? null, i.anchor ?? null])).toEqual([
    ["Beds", "beds", null],
    ["Paths", null, { fragmentId: "paths", line: "## Paths ^paths" }],
    ["[ ] Stake the beans", "t-b3a515", null],
  ]);
  expect(searchFragmentCandidates([garden, shed], { fragmentQuery: "b3a", mode: "id" }).items.map(i => i.fragmentId)).toEqual(["t-b3a515"]);
  // Newest first without a note part; the draft's own text (as typed) comes first.
  expect(searchFragmentCandidates([garden, shed], { fragmentQuery: "paths" }).items.map(i => i.blockId)).toEqual(["shed0001", "garden01"]);
  const draft = { blockId: "garden01", text: "Garden\n## Harvest" };
  expect(searchFragmentCandidates([garden, shed], { fragmentQuery: "", draft }).items[0]).toMatchObject({ blockId: "garden01", label: "Harvest", anchor: { fragmentId: "harvest" } });
  expect(() => searchFragmentCandidates([garden], { limit: 0 })).toThrow("between 1 and");
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

async function service() {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-fragment-search-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  const socket = join(directory, "outliner.sock");
  const server = new OutlinerServer(store, socket);
  await server.start();
  cleanups.push(async () => { await server.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, client: new OutlinerClient(socket) };
}

test("fragments.candidates finds a fragment past the first 500 notes; fragments.ensure writes the anchor it offered, revision-checked", async () => {
  const { client } = await service();
  const ping = await client.request<OutlinerServiceStatus>({ action: "ping" });
  expect(ping.capabilities).toEqual(expect.arrayContaining(["fragments.candidates", "fragments.ensure"]));
  // 640 notes; the one with the wanted heading is written first, so it's the oldest.
  const target = await client.request<Block>({ action: "create", text: "Seed catalogue\n## Winter squash\nKeep the seed dry." });
  for (let i = 0; i < 640; i++) await client.request<Block>({ action: "create", text: `Filler note ${i}\n## Section ${i}\nSome prose.` });
  const found = await client.request<FragmentCandidateCollection>({ action: "fragments.candidates", query: { fragmentQuery: "winter squ", mode: "heading" } });
  expect(found.items).toEqual([expect.objectContaining({ blockId: target.id, label: "Winter squash", anchor: { fragmentId: "winter-squash", line: "## Winter squash ^winter-squash" } })]);
  const written = await client.request<{ fragmentId: string; created: boolean; block: Block }>({
    action: "fragments.ensure", blockId: target.id, lineIndex: 1, expectedRevision: target.revision, mutation: { author: "user", actorId: "fixture" },
  });
  expect(written).toMatchObject({ fragmentId: "winter-squash", created: true });
  expect(written.block.text).toBe("Seed catalogue\n## Winter squash ^winter-squash\nKeep the seed dry.");
  await expect(client.request({ action: "fragments.ensure", blockId: target.id, lineIndex: 1, expectedRevision: target.revision, mutation: { author: "user", actorId: "fixture" } }))
    .rejects.toThrow("changed since the fragment was offered");
}, 60_000);

test("Detail's completion (the shared session) finds a heading in a 600+ note outline and adds its anchor through the service", async () => {
  const { client } = await service();
  const target = await client.request<Block>({ action: "create", text: "Orchard log\n## Pruning the plums" });
  for (let i = 0; i < 620; i++) await client.request<Block>({ action: "create", text: `Filler note ${i}\n## Heading ${i}` });
  const buffer = new TextBuffer("See ((Orchard#prun"); buffer.moveEnd();
  const session = new ReferenceCompletionSession(referenceCompletionProvider(client, "detail"), () => buffer, () => null, () => {}, () => true);
  await session.refresh();
  expect(session.state?.message ?? "").not.toContain("Searched only");
  expect(session.state?.items[0]).toMatchObject({ blockId: target.id, fragmentId: "pruning-the-plums", anchor: { lineIndex: 1 } });
  expect(await session.accept()).toBe(true);
  expect(buffer.text).toBe(`See ((${target.id}^pruning-the-plums))`);
  expect((await client.request<Block>({ action: "get", blockId: target.id })).text).toBe("Orchard log\n## Pruning the plums ^pruning-the-plums");
}, 60_000);
