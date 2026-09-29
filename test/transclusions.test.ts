// PIE-424: the service owns fragment slices and nested transclusion rules. Fictional notes only.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutlinerClient } from "../src/client";
import { resolveFragmentSlice } from "../src/fragments";
import { OutlinerServer } from "../src/server";
import { OutlinerStore } from "../src/store";
import {
  MAX_EMBEDS_PER_DOCUMENT, readFragment, readTransclusions, TRANSCLUSION_DEFAULT_DEPTH, TRANSCLUSION_MAX_DEPTH,
  TRANSCLUSION_MAX_BYTES, TRANSCLUSION_MAX_NODES, TRANSCLUSION_WORDING, type FragmentRead, type TransclusionNode, type TransclusionRead,
} from "../src/transclusions";
import { OUTLINER_CAPABILITIES, type Block, type ChecklistUpdateReceipt, type OutlinerServiceStatus } from "../src/types";

const block = (id: string, text: string, extra: Partial<Block> = {}): Block => ({
  id, text, parentId: null, position: 0, revision: 1, createdAt: "", updatedAt: "", author: "user", properties: [],
  ...extra,
} as unknown as Block);

const garden = [
  "Allotment checklist",
  "## Spring ^spring",
  "1. [x] Turn the compost ^t-a1b2c3",
  "2. [ ] Sow the beans ^t-d4e5f6",
  "   Soak them overnight first.",
  "   - [~] Buy canes ^t-0a0b0c",
  "3. [!] Fix the water butt",
  "```sh",
  "# not a heading",
  "```",
  "Still spring.",
  "## Summer",
  "- [ ] Net the brassicas",
].join("\n");

test("a fragment's slice: a step with its continuation and nested steps, offsets, and anchors hidden", () => {
  const read = readFragment(block("g1g1g1g1", garden), "t-d4e5f6");
  expect(read).toMatchObject({ status: "resolved", fragment: { kind: "list-item", startLine: 3, endLine: 5 } });
  const f = (read as Extract<FragmentRead, { status: "resolved" }>).fragment;
  expect(f.text).toBe("2. [ ] Sow the beans\n   Soak them overnight first.\n   - [~] Buy canes");
  expect(garden.slice(f.start, f.end)).toBe(garden.split("\n").slice(3, 6).join("\n"));
  const nested = readFragment(block("g1g1g1g1", garden), "t-0a0b0c") as Extract<FragmentRead, { status: "resolved" }>;
  expect(nested.fragment.text).toBe("- [~] Buy canes");   // stands alone: its indentation dropped
});

test("a heading's section runs past a `#` line inside a code fence (the PIE-424 fence bug)", () => {
  const r = resolveFragmentSlice(garden, "spring");
  expect(r).toMatchObject({ status: "resolved", slice: { startLine: 1, endLine: 10 } });
  const read = readFragment(block("g1g1g1g1", garden), "spring") as Extract<FragmentRead, { status: "resolved" }>;
  expect(read.fragment.text.split("\n").at(-1)).toBe("Still spring.");
  expect(read.fragment.text.split("\n")).toHaveLength(10);
});

test("missing and duplicate fragments say so", () => {
  expect(readFragment(block("g1g1g1g1", garden), "t-nothere")).toMatchObject({ status: "missing" });
  const twice = readFragment(block("g1g1g1g1", `${garden}\n- [ ] Again ^spring`), "spring");
  expect(twice).toMatchObject({ status: "duplicate", duplicates: [{ kind: "heading", line: 1 }, { kind: "list-item", line: 13 }] });
});

/** The steps a projection shows: its note's steps (sent once per read) between the lines it shows. */
const stepsIn = (read: TransclusionRead, node: TransclusionNode) =>
  (read.checklists[node.blockId] ?? []).filter(i => i.span.startLine >= node.shownLines!.start && i.span.startLine <= node.shownLines!.end);

const outline = (blocks: Block[]) => {
  const byId = new Map(blocks.map(b => [b.id, b]));
  return (id: string) => byId.get(id) ?? null;
};

test("transclusions nest, carry the steps they show, and stop at a cycle with the service's words", () => {
  const plan = block("plan0001", "Week plan\n!((garden01))\n!((garden01^t-d4e5f6))\n!((hub00001))");
  const hub = block("hub00001", "Hub\n!((leaf0001))\n!((plan0001))");
  const leaf = block("leaf0001", "Leaf\n- [ ] Water the seedlings ^t-leaf01");
  const load = outline([plan, block("garden01", garden), hub, leaf]);
  const r = readTransclusions(load, [{ blockId: "garden01" }, { blockId: "garden01", fragmentId: "t-d4e5f6" }, { blockId: "hub00001" }], { hostBlockId: "plan0001" });
  expect(r.limits).toEqual({ maxDepth: TRANSCLUSION_DEFAULT_DEPTH, maxPerDocument: MAX_EMBEDS_PER_DOCUMENT, maxNodes: TRANSCLUSION_MAX_NODES });
  const [whole, step, nested] = r.results;
  expect(whole).toMatchObject({ status: "ready", kind: "note", title: "Allotment checklist", depth: 1 });
  expect(stepsIn(r, whole!).map(i => i.status)).toEqual(["done", "todo", "waiting", "problem", "todo"]);
  expect(step).toMatchObject({ status: "ready", kind: "fragment", fragment: { startLine: 3, endLine: 5 } });
  // Only the steps inside the slice, as checklist.query reads them.
  expect(stepsIn(r, step!).map(i => [i.itemId, i.status, i.span.startLine])).toEqual([["t-d4e5f6", "todo", 3], ["t-0a0b0c", "waiting", 5]]);
  expect(nested!.embeds!.map(e => [e.blockId, e.status, e.depth])).toEqual([["leaf0001", "ready", 2], ["plan0001", "cycle", 2]]);
  expect(nested!.embeds![1]!.message).toBe(TRANSCLUSION_WORDING.cycle);
  expect(stepsIn(r, nested!.embeds![0]!)[0]).toMatchObject({ itemId: "t-leaf01", status: "todo" });
  expect(new Set(r.dependencies)).toEqual(new Set(["garden01", "hub00001", "leaf0001", "plan0001"]));
});

test("a self-embed and a two-note loop end at the note already open; siblings may repeat a target", () => {
  const a = block("aaaaaaaa", "A\n!((bbbbbbbb))\n!((bbbbbbbb))"), b = block("bbbbbbbb", "B\n!((aaaaaaaa))");
  const r = readTransclusions(outline([a, b]), [{ blockId: "bbbbbbbb" }, { blockId: "bbbbbbbb" }], { hostBlockId: "aaaaaaaa" });
  for (const node of r.results) expect(node.embeds![0]).toMatchObject({ blockId: "aaaaaaaa", status: "cycle" });
  const self = readTransclusions(outline([a]), [{ blockId: "aaaaaaaa" }], { hostBlockId: "aaaaaaaa" });
  expect(self.results[0]).toMatchObject({ status: "cycle" });
});

test("depth is bounded (the caller's depth clamped to the ceiling); the per-document limit and the read's budget fail locally", () => {
  const chain = Array.from({ length: 9 }, (_, i) => block(`chain00${i}`, `Level ${i}\n!((chain00${i + 1}))`));
  const load = outline(chain);
  const levels = (n: { embeds?: any[]; status: string }): string[] => [n.status, ...(n.embeds?.[0] ? levels(n.embeds[0]) : [])];
  expect(levels(readTransclusions(load, [{ blockId: "chain000" }]).results[0]!)).toEqual(["ready", "ready", "ready", "depth-limit"]);
  expect(levels(readTransclusions(load, [{ blockId: "chain000" }], { maxDepth: 1 }).results[0]!)).toEqual(["ready", "depth-limit"]);
  const deep = readTransclusions(load, [{ blockId: "chain000" }], { maxDepth: 99 });
  expect(deep.limits.maxDepth).toBe(TRANSCLUSION_MAX_DEPTH);
  expect(levels(deep.results[0]!).filter(s => s === "ready")).toHaveLength(TRANSCLUSION_MAX_DEPTH);
  expect(levels(readTransclusions(load, [{ blockId: "chain000" }]).results[0]!).includes("depth-limit")).toBe(true);

  const many = block("many0001", ["Many", ...Array.from({ length: MAX_EMBEDS_PER_DOCUMENT + 2 }, () => "!((leaf0001))")].join("\n"));
  const r = readTransclusions(outline([many, block("leaf0001", "Leaf")]), [{ blockId: "many0001" }]);
  // The 17th says EMBED LIMIT; the note isn't scanned past it (the reader draws the rest as the limit too).
  expect(r.results[0]!.embeds!).toHaveLength(MAX_EMBEDS_PER_DOCUMENT + 1);
  expect(r.results[0]!.embeds!.slice(-2).map(e => e.status)).toEqual(["ready", "limit"]);
  expect(r.results[0]!.embeds!.at(-1)!.message).toBe(`EMBED LIMIT · maximum ${MAX_EMBEDS_PER_DOCUMENT}`);

  const wide = Array.from({ length: 8 }, (_, i) => block(`wide000${i}`, ["W", ...Array.from({ length: 12 }, () => "!((leaf0001))")].join("\n")));
  const budget = readTransclusions(outline([...wide, block("leaf0001", "Leaf")]), wide.map(w => ({ blockId: w.id })));
  const statuses = budget.results.flatMap(n => [n.status, ...(n.embeds ?? []).map(e => e.status)]);
  expect(statuses.filter(s => s !== "budget")).toHaveLength(TRANSCLUSION_MAX_NODES);
  expect(statuses).toContain("budget");
});

test("embed syntax inside fenced or indented code is shown as written: no load, no dependency, no budget", () => {
  const guide = block("guide001", [
    "How to embed",
    "## Syntax ^syntax",
    "!((leaf0001))",
    "```md",
    "!((ghost001))",
    "```",
    "",
    "    !((ghost002^t-ghost))",
    "",
    "## After",
  ].join("\n"));
  const loaded: string[] = [];
  const byId = outline([guide, block("leaf0001", "Leaf")]);
  const r = readTransclusions(id => { loaded.push(id); return byId(id); }, [{ blockId: "guide001" }, { blockId: "guide001", fragmentId: "syntax" }]);
  const [whole, section] = r.results;
  expect(section).toMatchObject({ status: "ready", kind: "fragment", fragment: { startLine: 1, endLine: 8 } });
  for (const node of [whole!, section!]) expect(node.embeds!.map(e => [e.blockId, e.status])).toEqual([["leaf0001", "ready"]]);
  expect(new Set(r.dependencies)).toEqual(new Set(["guide001", "leaf0001"]));
  expect(loaded).not.toContain("ghost001");
  expect(loaded).not.toContain("ghost002");
});

test("each note is sent once however often it's embedded, and a read stops sending past its byte budget", () => {
  const big = (n: number) => block(`big0000${n}`, `Big ${n}\n${"A long line of prose with words in it.\n".repeat(3900)}`);   // about 150 KB each
  const notes = [big(1), big(2), big(3), big(4), big(5)];
  const r = readTransclusions(outline(notes), [...notes, notes[0]!].map(n => ({ blockId: n.id })));
  expect(r.results.map(n => n.status)).toEqual(["ready", "ready", "ready", "too-large", "too-large", "ready"]);
  expect(r.results[3]!.message).toStartWith("EMBED TOO LARGE · ");
  expect(Object.keys(r.blocks)).toEqual(notes.slice(0, 3).map(n => n.id));
  expect(Object.values(r.blocks).reduce((n, b) => n + b.text.length, 0)).toBeLessThanOrEqual(TRANSCLUSION_MAX_BYTES);
  // A note whose steps alone would overrun the budget is too large as well.
  const steps = block("steps001", `Steps\n${"- [ ] a step\n".repeat(4000)}`);
  expect(readTransclusions(outline([steps]), [{ blockId: steps.id }]).results[0]!.status).toBe("too-large");
});

test("missing, trashed, missing and duplicate fragments, and a virtual branch are said, not guessed", () => {
  const view = block("view0001", "Open steps\n[type::virtual-branch] [query::status=open]", { properties: [{ key: "type", value: "virtual-branch" }] } as never);
  const load = outline([block("gone0001", "Gone", { effectiveDeletedRootId: "gone0001" } as never), block("garden01", garden), view]);
  const r = readTransclusions(load, [
    { blockId: "nothere1" }, { blockId: "gone0001" }, { blockId: "garden01", fragmentId: "nope" }, { blockId: "view0001" },
  ]);
  expect(r.results.map(n => [n.status, n.message ?? n.kind])).toEqual([
    ["missing", "MISSING TARGET"], ["deleted", "IN TRASH · Gone"], ["fragment-missing", "MISSING FRAGMENT"], ["ready", "view"],
  ]);
  expect(() => readTransclusions(load, [{ blockId: "garden01", fragmentId: "bad id" }])).toThrow("Not a fragment id");
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

test("fragments.read and transclusions.read round-trip through the service, advertised as capabilities", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-transclusions-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  const socket = join(directory, "outliner.sock");
  const server = new OutlinerServer(store, socket);
  await server.start();
  cleanups.push(async () => { await server.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const client = new OutlinerClient(socket);
  const ping = await client.request<OutlinerServiceStatus>({ action: "ping" });
  expect(ping.capabilities).toEqual(expect.arrayContaining(["fragments.read", "transclusions.read"]));
  expect(OUTLINER_CAPABILITIES).toContain("transclusions.read");

  const source = await client.request<Block>({ action: "create", text: garden });
  const plan = await client.request<Block>({ action: "create", text: `Week plan\n!((${source.id}^t-d4e5f6))` });
  const read = await client.request<FragmentRead>({ action: "fragments.read", blockId: source.id, fragmentId: "t-d4e5f6" });
  expect(read).toMatchObject({ status: "resolved", revision: source.revision, fragment: { startLine: 3, endLine: 5 } });
  await expect(client.request({ action: "fragments.read", blockId: "missing-block-id", fragmentId: "x" })).rejects.toThrow("Block not found");

  const first = await client.request<TransclusionRead>({ action: "transclusions.read", targets: [{ blockId: source.id, fragmentId: "t-d4e5f6" }], hostBlockId: plan.id });
  const step = stepsIn(first, first.results[0]!)[0]!;
  // A step changed through the embed is a change to the source note, and the next read shows it.
  const changed = await client.request<ChecklistUpdateReceipt>({
    action: "checklist.update", blockId: source.id,
    input: { target: { itemId: step.itemId! }, expectedEvidence: step.evidence, change: { kind: "status", status: "done" } },
    mutation: { author: "agent", actorId: "fictional-agent" },
  });
  expect(changed.block.text).toContain("2. [x] Sow the beans ^t-d4e5f6");
  const again = await client.request<TransclusionRead>({ action: "transclusions.read", targets: [{ blockId: source.id, fragmentId: "t-d4e5f6" }], hostBlockId: plan.id });
  expect(again.results[0]).toMatchObject({ revision: changed.block.revision, fragment: { text: expect.stringContaining("[x] Sow the beans") } });
  expect(stepsIn(again, again.results[0]!)[0]!.status).toBe("done");
});
