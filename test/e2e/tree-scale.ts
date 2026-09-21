import assert from "node:assert/strict";
import type {
  Block, BrowsingContextState, TreeIndexCollection, TreeIndexSnapshot,
  VisibleBlockCollection, WorkspaceSnapshot,
} from "../../src/types";
import { projectVirtualBranches, type ProjectionBlock, type TreeRow } from "../../src/virtual-branches";
import { runHerdrScenario } from "./herdr-runner";

const count = Number(process.argv[2] ?? 5000);
assert.ok(count === 1000 || count === 5000, "Use the declared 1,000 or 5,000 block fixture");
const summarize = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return { samples, p50: sorted[Math.floor(sorted.length / 2)]!, p95: sorted[Math.ceil(sorted.length * .95) - 1]! };
};
const rowIdentity = ({ block: _block, ...row }: TreeRow<ProjectionBlock>) => row;

const result = await runHerdrScenario({
  name: `tree-scale-${count}`,
  async prepare() {},
  async run(s) {
    await s.record("budget", {
      count, parseAndProjectionP95Ms: count === 1000 ? 100 : 250,
      mutationToFrameP95Ms: 1000,
      scope: "Same-host direct service and forwarded client; two active browsing contexts. No SSH/bandwidth claim.",
    });
    // Fixture writes use the service while both original views hold local input.
    await s.keys(s.panes.tree, "a");
    await s.waitVisible(s.panes.tree, "↵ save");
    await s.keys(s.panes.detail, "e");
    await s.waitVisible(s.panes.detail, "⌃S save");
    const initial = await s.client.request<WorkspaceSnapshot>({ action: "workspace.snapshot" });
    const create = (text: string, parentId: string | null = null) =>
      s.client.request<Block>({ action: "create", text, parentId });
    const root = await create("PIE-235 scale fixture");
    const sources: Block[] = [];
    for (let i = 0; i < 12; i++) {
      sources.push(await create(`Scale source ${String(i).padStart(2, "0")} [probe::scale]\nEXACT SOURCE ${i}`, root.id));
    }
    const board = await create("Scale board [type::virtual-branch] [query::probe=scale]", root.id);
    const groups: Block[] = [];
    for (let i = 0; i < 10; i++) groups.push(await create(`Group ${i}`, root.id));
    const bands = [120, 700, 2100, 7000, 20000];
    const paragraph = "Synthetic canonical document with exact editable source text. ";
    const fixtureExceptions = initial.physical.blocks.length + 2 + sources.length + groups.length;
    const histogram = [0, 0, 0, 0, 0];
    for (let i = fixtureExceptions; i < count; i++) {
      const bucket = i % 100;
      const band = bucket < 19 ? 0 : bucket < 51 ? 1 : bucket < 91 ? 2 : bucket < 99 ? 3 : 4;
      const size = bands[band]!;
      histogram[band]!++;
      await create(`Document ${i}${i % 2 === 0 ? " [status::planned] [type::note]" : ""}\n${paragraph.repeat(Math.ceil(size / paragraph.length)).slice(0, size)}\nExact ending ${i}`, groups[i % groups.length]!.id);
    }
    const baseline = await s.client.request<WorkspaceSnapshot>({ action: "workspace.snapshot" });
    assert.equal(baseline.physical.blocks.length, count);
    const legacy = await projectVirtualBranches(baseline.visible.blocks, baseline.physical.blocks,
      query => s.client.request<VisibleBlockCollection>({ action: "blocks.query", query }), baseline.virtualOccurrenceRanks);
    const treeRpc: number[] = [], parse: number[] = [], projection: number[] = [];
    let index!: TreeIndexSnapshot;
    let indexBytes = 0;
    for (let i = 0; i < 13; i++) {
      let started = performance.now();
      index = await s.client.request<TreeIndexSnapshot>({ action: "tree.index" });
      const rpcMs = performance.now() - started;
      const encoded = JSON.stringify(index);
      indexBytes = Buffer.byteLength(encoded);
      started = performance.now();
      JSON.parse(encoded);
      const parseMs = performance.now() - started;
      const byId = new Map(index.blocks.map(block => [block.id, block]));
      started = performance.now();
      const projected = await projectVirtualBranches(index.visible.rows.map(row => ({ ...byId.get(row.id)!, ...row })),
        index.physicalBlockIds.map(id => byId.get(id)!),
        query => s.client.request<TreeIndexCollection>({ action: "tree.query", query }), index.virtualOccurrenceRanks);
      const projectionMs = performance.now() - started;
      assert.deepEqual(projected.rows.map(rowIdentity), legacy.rows.map(rowIdentity));
      assert.deepEqual(projected.branchStates, legacy.branchStates);
      if (i > 0) { treeRpc.push(rpcMs); parse.push(parseMs); projection.push(projectionMs); }
    }
    const baselineBytes = Buffer.byteLength(JSON.stringify(baseline));
    const parseAndProjection = summarize(parse.map((ms, i) => ms + projection[i]!));
    await s.record("tree-scale", { count, baselineBytes, indexBytes, reduction: 1 - indexBytes / baselineBytes,
      treeRpc: summarize(treeRpc), parse: summarize(parse), projection: summarize(projection), parseAndProjection,
      bands, histogram, fixtureExceptions, projectedRows: legacy.rows.length });
    assert.ok(indexBytes < count * 1000 && indexBytes <= baselineBytes * .25);
    await s.keys(s.panes.tree, "escape");
    await s.keys(s.panes.detail, "escape");
    await s.waitVisible(s.panes.tree, `${count} physical blocks`);
    const remote = await s.openRemoteBrowsingContext({ treeTransport: "forwarded", detailTransport: "forwarded" });
    await s.waitVisible(remote.tree, `${count} physical blocks`);
    const coldRequests = [...s.forwardedTreeRequests()];
    assert.ok(coldRequests.some(request => request.action === "tree.index"));
    assert.ok(!coldRequests.some(request => request.action === "get" || request.action === "workspace.snapshot"));
    await s.record("cold-forwarded-tree", { firstObservedFrameMs: remote.firstTreeFrameMs, requests: coldRequests });
    await s.checkpoint("01-complete-index");

    const registrations = await s.registrations();
    const tree = registrations.find(client => client.runtime?.paneId === remote.tree);
    assert.ok(tree?.contextId);
    const context = () => s.client.request<BrowsingContextState>({ action: "browsing-context.get", contextId: tree.contextId! });
    const selected = (id: string) => s.waitFor("Tree canonical selection", context,
      state => state.target?.kind === "block" && state.target.blockId === id);
    await s.revealTree(remote.tree, board.id);
    await s.keys(remote.tree, "down");
    await selected(sources[0]!.id);
    await s.waitVisible(remote.detail, "EXACT SOURCE 0");
    const mutations: number[] = [];
    let editable = sources[0]!;
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      editable = await s.client.request<Block>({ action: "update", blockId: editable.id, expectedRevision: editable.revision,
        text: `Scale source 00 UPDATED-${i} [probe::scale]\nEXACT SOURCE 0`,
        mutation: { author: "agent", actorId: "pie-235-fixture" } });
      await s.waitFor("physical and projected source show the same new text", () => s.visible(remote.tree),
        frame => frame.split(`Scale source 00 UPDATED-${i}`).length - 1 === 2);
      await s.waitVisible(remote.detail, `Scale source 00 UPDATED-${i}`);
      mutations.push(performance.now() - started);
      await s.client.request({ action: "move", blockId: editable.id, parentId: root.id, position: i % 2 });
      await selected(editable.id);
      assert.equal((await s.client.request<Block>({ action: "get", blockId: editable.id })).revision, editable.revision);
    }
    await s.record("mutation-revalidation", { timing: summarize(mutations), exactRevision: editable.revision });
    await s.checkpoint("02-mutated-source-stable-selection");

    // Authored ranks must change only this occurrence order, including after a mutation reload.
    const rankedIds = [sources[1]!.id, editable.id, ...sources.slice(2).map(block => block.id)];
    await s.client.request({ action: "virtual.occurrences.reorder", viewId: board.id, orderedBlockIds: rankedIds });
    await s.waitVisible(remote.tree, "Scale board");
    await selected(editable.id);
    const ranked = await s.client.request<TreeIndexCollection>({ action: "tree.query",
      query: { filters: [{ key: "probe", value: "SCALE" }], rankViewId: board.id, limit: 1000 } });
    assert.deepEqual(ranked.blocks.map(block => block.id), rankedIds);
    assert.deepEqual(ranked.completeness, { kind: "complete" });
    await s.revealTree(remote.tree, board.id);
    await s.keys(remote.tree, "down");
    await selected(sources[1]!.id);
    await s.keys(remote.tree, "down");
    await selected(editable.id);
    await s.waitVisible(remote.detail, "Scale source 00 UPDATED-4");
    await s.checkpoint("03-ranked-occurrences");
    await s.record("forwarded-requests", { tree: s.forwardedTreeRequests(), detail: s.forwardedDetailRequests(),
      limit: "Same-host sockets; no two-host SSH, constrained bandwidth, mouse, or resize evidence." });
    assert.ok(parseAndProjection.p95 < (count === 1000 ? 100 : 250),
      `Parse + projection p95 ${parseAndProjection.p95}ms exceeds the declared budget`);
    assert.ok(summarize(mutations).p95 < 1000, `Mutation-to-frame p95 ${summarize(mutations).p95}ms exceeds 1000ms`);
  },
});
process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.status === "failed") process.exitCode = 1;
