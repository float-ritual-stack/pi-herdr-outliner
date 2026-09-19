import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutlinerClient } from "../src/client";
import { OutlinerServer } from "../src/server";
import { OutlinerStore } from "../src/store";
import type { Block, TreeFocusCollection, TreeIndexCollection, TreeIndexSnapshot } from "../src/types";
import { projectVirtualBranches } from "../src/virtual-branches";
import { readAuthoredLinks } from "../src/authored-links";
import { createOutlinerTextLinker, outlinerLinkUri } from "../src/outliner-links";
import { getOsc8LinkAtColumn } from "@earendil-works/pi-tui";

test("compact references retain source identity after hidden properties and repeated labels", () => {
  const directory = mkdtempSync(join(tmpdir(), "outliner-tree-index-reference-source-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  try {
    const hidden = store.create("Hidden target");
    const visible = store.create("Visible target");
    const source = store.create(`[related::((${hidden.id}|same))]\nLiteral ((same)) then ((${visible.id}|same))`);
    const entry = store.readTreeIndex().blocks.find(block => block.id === source.id)!;
    expect(entry.preview).toBe("Literal ((same)) then ((same))");
    expect(entry.previewReferences.map(reference => reference.target?.blockId)).toEqual([visible.id]);
    const rendered = createOutlinerTextLinker(entry, () => true).link(entry.preview);
    expect(getOsc8LinkAtColumn(rendered, entry.preview.indexOf("same"))).toBeUndefined();
    expect(getOsc8LinkAtColumn(rendered, entry.preview.lastIndexOf("same"))).toBe(outlinerLinkUri("block", visible.id));
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("preview truncation retains nonactionable reference provenance", () => {
  const directory = mkdtempSync(join(tmpdir(), "outliner-tree-index-partial-reference-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  try {
    const target = store.create("Reference target without the requested fragment");
    const alias = store.create("Unrelated live block");
    const source = store.create(`((${target.id}^gone|${alias.id} ${"x".repeat(600)}))`);
    const entry = store.readTreeIndex().blocks.find(block => block.id === source.id)!;
    expect(entry.previewReferences).toEqual([{ start: 0, end: 511, target: null }]);
    const rendered = createOutlinerTextLinker(entry, () => true).link(entry.preview);
    expect(getOsc8LinkAtColumn(rendered, 2)).toBeUndefined();
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("preview newline flattening cannot create a reference absent from authored text", () => {
  const directory = mkdtempSync(join(tmpdir(), "outliner-tree-index-authored-reference-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  try {
    const target = store.create("Reference target");
    const source = store.create(`See ((${target.id}|line\nbreak))`);
    const entry = store.readTreeIndex().blocks.find(block => block.id === source.id)!;
    expect(entry.preview).toBe(`See ((${target.id}|line ↵ break))`);
    expect(entry.previewReferences).toEqual([]);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("removing properties inside a reference label preserves its original target or disabled state", () => {
  const directory = mkdtempSync(join(tmpdir(), "outliner-tree-index-reference-property-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  try {
    const target = store.create("Reference target without the requested fragment");
    const alias = store.create("Unrelated live block");
    for (const fragment of ["^gone", ""]) {
      const source = store.create(`((${target.id}${fragment}|${alias.id} [tag::x])) [type::note]`);
      const entry = store.readTreeIndex().blocks.find(block => block.id === source.id)!;
      const preview = `((${alias.id} ${fragment ? " · Missing fragment" : ""}))`;
      expect(entry.preview).toBe(preview);
      expect(entry.previewReferences).toEqual([{ start: 0, end: preview.length, target: fragment ? null : { blockId: target.id } }]);
      const rendered = createOutlinerTextLinker(entry, id => store.get(id) !== null).link(entry.preview);
      expect(getOsc8LinkAtColumn(rendered, 2)).toBe(fragment ? undefined : outlinerLinkUri("block", target.id));
    }
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("trimming a partially hidden reference does not turn its label into another link", () => {
  const directory = mkdtempSync(join(tmpdir(), "outliner-tree-index-reference-trim-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  try {
    const target = store.create("Reference target");
    const alias = store.create("Unrelated live block");
    const source = store.create(`[tag::((${target.id}|discard]  ${alias.id})) [type::note]`);
    const entry = store.readTreeIndex().blocks.find(block => block.id === source.id)!;
    expect(entry.preview).toBe(`${alias.id}))`);
    expect(entry.previewReferences).toEqual([{ start: 0, end: 38, target: null }]);
    const rendered = createOutlinerTextLinker(entry, id => store.get(id) !== null).link(entry.preview);
    expect(getOsc8LinkAtColumn(rendered, 0)).toBeUndefined();
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Tree receives complete structure and bounded previews while exact bodies remain available", async () => {
  const directory = mkdtempSync(join(tmpdir(), "outliner-tree-index-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  const socket = join(directory, "outliner.sock");
  const server = new OutlinerServer(store, socket);
  try {
    const initialCount = store.readWorkspaceSnapshot().physical.blocks.length;
    const root = store.create("Project [type::project]");
    const text = "Long document\n" + "Full source text. ".repeat(5_000) + "FINAL SOURCE SENTINEL";
    const child = store.create(text, root.id);
    const sibling = store.create("Sibling", root.id);
    store.setSelection(child.id);
    await server.start();
    const client = new OutlinerClient(socket);
    const index = await client.request<TreeIndexSnapshot>({ action: "tree.index" });

    const fixtureIds = new Set([root.id, child.id, sibling.id]);
    expect(index.physicalBlockIds).toHaveLength(initialCount + 3);
    expect(index.visible.completeness).toEqual({ kind: "complete" });
    expect(index.blocks.filter(block => fixtureIds.has(block.id))
      .map(block => [block.id, block.parentId, block.depth, block.hasChildren]))
      .toEqual([[root.id, null, 0, true], [child.id, root.id, 1, false], [sibling.id, root.id, 1, false]]);
    expect(index.selectedBlockId).toBe(child.id);
    expect(index.blocks.find(block => block.id === child.id)?.revision).toBe(child.revision);
    expect(index.blocks.every(block => block.preview.length <= 512)).toBe(true);
    expect(JSON.stringify(index)).not.toContain("FINAL SOURCE SENTINEL");
    expect(Buffer.byteLength(JSON.stringify(index))).toBeLessThan(50_000);
    expect((await client.request<Block>({ action: "get", blockId: child.id })).text).toBe(text);

    const matches = await client.request<TreeIndexCollection>({
      action: "tree.query", query: { text: "FINAL SOURCE SENTINEL", limit: 1 },
    });
    expect(matches.completeness).toEqual({ kind: "complete" });
    expect(matches.blocks.map(block => block.id)).toEqual([child.id]);
    expect(matches.blocks[0]!.preview).not.toContain("FINAL SOURCE SENTINEL");
  } finally {
    await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a bounded filtered view keeps canonical ancestry and its own relative depth", () => {
  const directory = mkdtempSync(join(tmpdir(), "outliner-tree-index-query-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  try {
    const parent = store.create("Parent");
    const child = store.create("Child [status::planned]", parent.id);
    const grandchild = store.create("Grandchild [status::planned]", child.id);
    const index = store.readTreeIndex({ query: {
      subtreeRootId: child.id, filters: [{ key: "status", value: "planned" }], limit: 1,
    } });
    expect(index.visible).toEqual({ rows: [{ id: child.id, depth: 0 }], completeness: { kind: "truncated", limit: 1 } });
    expect(index.physicalBlockIds).toContain(parent.id);
    expect(index.physicalBlockIds).toContain(grandchild.id);
    expect(index.blocks.find(block => block.id === child.id)?.depth).toBe(1);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Tree goto ranks full source text without sending bodies and reports bounded results", async () => {
  const directory = mkdtempSync(join(tmpdir(), "outliner-tree-focus-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  const server = new OutlinerServer(store, join(directory, "outliner.sock"));
  try {
    const match = store.create("Research notes\n" + "ordinary text ".repeat(100) + "violet octopus");
    const deleted = store.create("violet octopus deleted");
    store.delete(deleted.id);
    await server.start();
    const client = new OutlinerClient(join(directory, "outliner.sock"));
    const result = await client.request<TreeFocusCollection>({ action: "tree.focus", query: "violet octopus" });
    expect(result.matches[0]).toEqual({ block: { id: match.id }, title: "Research notes" });
    expect(result.completeness).toEqual({ kind: "complete" });
    expect(result.matches.some(item => item.block.id === deleted.id)).toBe(false);
    for (let i = 0; i < 22; i++) store.create(`violet octopus ${String(i).padStart(2, "0")}`);
    const bounded = await client.request<TreeFocusCollection>({ action: "tree.focus", query: "violet octopus" });
    expect(bounded.completeness).toEqual({ kind: "truncated", limit: 20 });
    expect(bounded.matches).toHaveLength(20);
    expect(bounded.matches[0]!.title).toBe("violet octopus 00");
    expect(JSON.stringify(bounded)).not.toContain("ordinary text");
  } finally {
    await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("compact structure projects canonical children without requiring document bodies", async () => {
  const directory = mkdtempSync(join(tmpdir(), "outliner-tree-index-projection-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  try {
    const parent = store.create("Parent");
    const child = store.create("Child [status::planned]", parent.id);
    const grandchild = store.create("Grandchild", child.id);
    const board = store.create("Queue [type::virtual-branch] [query::status=planned]");
    const index = store.readTreeIndex();
    const byId = new Map(index.blocks.map(block => [block.id, block]));
    const projection = await projectVirtualBranches(
      [byId.get(board.id)!],
      index.physicalBlockIds.map(id => byId.get(id)!),
      async query => {
        const matched = store.queryBlocks(query);
        return { ...matched, blocks: matched.blocks.map(block => byId.get(block.id)!) };
      },
      index.virtualOccurrenceRanks,
    );
    expect(projection.rows.map(row => [row.canonicalId, row.depth, row.kind])).toEqual([
      [board.id, 0, "physical"], [child.id, 1, "occurrence"], [grandchild.id, 2, "occurrence"],
    ]);
    expect(projection.branchStates.get(board.id)?.queryError).toBeNull();
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("compact previews retain resolved fragment links and the exact authored-text identity", () => {
  const directory = mkdtempSync(join(tmpdir(), "outliner-tree-index-links-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  try {
    const target = store.create("Target title\nAnchored paragraph ^anchor");
    const source = store.create(`See ((${target.id}^anchor|the paragraph)) [type::note]\n` + "Unshown body ".repeat(1_000));
    const entry = store.readTreeIndex().blocks.find(block => block.id === source.id)!;
    expect(entry.preview).toBe("See ((the paragraph))");
    expect(entry.previewReferences).toEqual([{
      start: 4, end: 21, target: { blockId: target.id, fragmentId: "anchor" },
    }]);
    const authored = readAuthoredLinks(store, source.id);
    expect(authored.kind).toBe("ready");
    if (authored.kind === "ready") expect(entry.textDigest).toBe(authored.ownerTextDigest);
    expect(JSON.stringify(entry)).not.toContain("Unshown body");
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("compact previews retain references by source span rather than matching labels", () => {
  const directory = mkdtempSync(join(tmpdir(), "outliner-tree-index-reference-spans-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  try {
    const hidden = store.create("Shared title");
    const visible = store.create("Shared title");
    const hiddenRef = `((${hidden.id}|same))`;
    const visibleRef = `((${visible.id}|same))`;
    const cases = [
      {
        text: `[related::${hiddenRef}] See ${visibleRef} [type::note]`,
        preview: "See ((same))", ids: [visible.id],
      },
      {
        text: `[related::${hiddenRef}]\r\n  See ${visibleRef}  \r\n${hiddenRef}`,
        preview: "See ((same))", ids: [visible.id],
      },
      {
        text: `[related::${hiddenRef}] Literal ((same)) [type::note]`,
        preview: "Literal ((same))", ids: [],
      },
      {
        text: `See ${visibleRef} [related::${hiddenRef}] then ${visibleRef} [type::note]`,
        preview: "See ((same))  then ((same))", ids: [visible.id, visible.id],
      },
      {
        text: `[related::((${hidden.id}))] See ((${visible.id})) [type::note]`,
        preview: "See ((Shared title))", ids: [visible.id],
      },
      {
        text: `Header\r\n${visibleRef}\n${hiddenRef}`,
        preview: "Header ↵ ((same)) ↵ ((same))", ids: [visible.id, hidden.id],
      },
      {
        text: `((same)) ${"x".repeat(496)}${hiddenRef}`,
        preview: `((same)) ${"x".repeat(496)}((same…`, ids: [],
      },
      {
        text: `${"x".repeat(503)}${visibleRef}tail`,
        preview: `${"x".repeat(503)}((same))…`, ids: [visible.id],
      },
      {
        text: `[related::${hiddenRef}]`,
        ids: [],
      },
    ];
    const sources = cases.map(fixture => store.create(fixture.text));
    const index = store.readTreeIndex();
    for (const [i, fixture] of cases.entries()) {
      const source = sources[i]!;
      const entry = index.blocks.find(block => block.id === source.id)!;
      expect(entry.preview).toBe(fixture.preview ?? source.id);
      expect(entry.previewReferences.flatMap(reference => reference.target ? [reference.target.blockId] : [])).toEqual(fixture.ids);
    }
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("bounded Tree previews preserve graphemes and do not transfer an aliased target's long title", () => {
  const directory = mkdtempSync(join(tmpdir(), "outliner-tree-index-bounds-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  try {
    const family = "👨‍👩‍👧‍👦";
    const text = "x".repeat(510) + family + "last";
    const source = store.create(text);
    const target = store.create("z".repeat(20_000));
    const alias = store.create(`Open ((${target.id}|short))`);
    const index = store.readTreeIndex();
    expect(index.blocks.find(block => block.id === source.id)!.preview).toBe("x".repeat(510) + "…");
    const aliased = index.blocks.find(block => block.id === alias.id)!;
    expect(aliased.preview).toBe("Open ((short))");
    expect(aliased.previewReferences).toEqual([{ start: 5, end: 14, target: { blockId: target.id } }]);
    expect(Buffer.byteLength(JSON.stringify(aliased))).toBeLessThan(1_000);
    const focused = store.focusTree(target.id);
    expect(focused.matches[0]!.title).toHaveLength(512);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
