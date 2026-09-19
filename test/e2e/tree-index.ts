import assert from "node:assert/strict";
import type { Block, BrowsingContextState, TreeIndexCollection, TreeIndexSnapshot, VisibleBlockCollection, WorkspaceSnapshot } from "../../src/types";
import { projectVirtualBranches } from "../../src/virtual-branches";
import { runHerdrScenario } from "./herdr-runner";

const transport = process.argv.includes("--forwarded") ? "forwarded" : "direct";
const result = await runHerdrScenario({
  name: `tree-index-${transport}`,
  async prepare() {},
  async run(session) {
    // Prepare data through the real service. Leave the original views in input
    // mode so fixture creation does not queue a thousand unrelated UI reloads.
    await session.keys(session.panes.tree, "a");
    await session.waitVisible(session.panes.tree, "↵ save");
    await session.keys(session.panes.detail, "e");
    await session.waitVisible(session.panes.detail, "⌃S save");
    const initial = await session.client.request<WorkspaceSnapshot>({ action: "workspace.snapshot" });
    const create = (text: string, parentId: string | null = null) => session.client.request<Block>({ action: "create", text, parentId });
    const root = await create("PIE-269 fixture");
    const long = await create("PIE-269 long document [probe::tree-index]\nEXPANDED BODY CHECKPOINT\n" + "Exact source paragraph. ".repeat(120), root.id);
    const editText = "PIE-269 exact edit " + "unabridged text ".repeat(90) + "END-OF-EXACT-EDIT";
    const editable = await create(editText, root.id);
    const card = await create("PIE-269 card [probe::tree-index]", root.id);
    const child = await create("PIE-269 contextual child", card.id);
    const board = await create("PIE-269 board [type::virtual-branch] [query::probe=tree-index]", root.id);
    const sizes = [120, 700, 2100, 7000, 20000];
    const paragraph = "A synthetic document paragraph with exact editable source text. ";
    for (let i = initial.physical.blocks.length + 6; i < 1000; i++) {
      const bucket = i % 100;
      const size = sizes[bucket < 19 ? 0 : bucket < 51 ? 1 : bucket < 91 ? 2 : bucket < 99 ? 3 : 4]!;
      await create(`Document ${i}${i % 2 === 0 ? " [status::planned] [type::note]" : ""}\n${paragraph.repeat(Math.ceil(size / paragraph.length)).slice(0, size)}\nExact body ending ${i}`, root.id);
    }
    await session.keys(session.panes.detail, "escape");
    await session.keys(session.panes.tree, "escape");
    await session.waitVisible(session.panes.tree, "1000 physical blocks");

    const started = performance.now();
    const baseline = await session.client.request<WorkspaceSnapshot>({ action: "workspace.snapshot" });
    const snapshotRequestMs = performance.now() - started;
    const indexStarted = performance.now();
    const index = await session.client.request<TreeIndexSnapshot>({ action: "tree.index" });
    const indexRequestMs = performance.now() - indexStarted;
    const encoded = JSON.stringify(index);
    const parseStarted = performance.now();
    JSON.parse(encoded);
    const indexParseMs = performance.now() - parseStarted;
    const baselineBytes = Buffer.byteLength(JSON.stringify(baseline));
    const indexBytes = Buffer.byteLength(encoded);
    assert.equal(index.physicalBlockIds.length, 1000);
    assert.ok(indexBytes < 1_000_000 && indexBytes <= baselineBytes * 0.25);
    const byId = new Map(index.blocks.map(block => [block.id, block]));
    const projectionStarted = performance.now();
    const projected = await projectVirtualBranches(index.visible.rows.map(row => ({ ...byId.get(row.id)!, ...row })), index.physicalBlockIds.map(id => byId.get(id)!),
      query => session.client.request<TreeIndexCollection>({ action: "tree.query", query }), index.virtualOccurrenceRanks);
    const projectionMs = performance.now() - projectionStarted;
    const previous = await projectVirtualBranches(baseline.visible.blocks, baseline.physical.blocks,
      query => session.client.request<VisibleBlockCollection>({ action: "blocks.query", query }), baseline.virtualOccurrenceRanks);
    assert.deepEqual(projected.rows.map(row => [row.rowId, row.depth]), previous.rows.map(row => [row.rowId, row.depth]));
    await session.record("compact-index-measurements", { transport, baselineBytes, indexBytes, snapshotRequestMs, indexRequestMs, indexParseMs, projectionMs,
      blockCount: 1000, bodySizeBands: sizes, bandPercentages: [19, 32, 40, 8, 1], taggedFillers: "every other document", fixtureExceptions: "seeded documents and six navigation/edit/projection targets",
      timingScope: "direct service request/parse and client projection, before independent Tree launch; same host" });

    const remote = await session.openRemoteBrowsingContext("pi-tui", transport);
    await session.waitVisible(remote.tree, "1000 physical blocks");
    const coldRequests = session.forwardedTreeRequests();
    if (transport === "forwarded") {
      assert.ok(coldRequests.some(request => request.action === "tree.index"));
      assert.ok(!coldRequests.some(request => request.action === "get" || request.action === "workspace.snapshot"));
    }
    await session.record("cold-tree", { firstObservedFrameMs: remote.firstTreeFrameMs, requests: coldRequests });
    await session.checkpoint("01-cold-complete-index");
    const tree = (await session.registrations()).find(client => client.runtime?.paneId === remote.tree);
    assert.ok(tree?.contextId);
    const context = () => session.client.request<BrowsingContextState>({ action: "browsing-context.get", contextId: tree.contextId! });
    const selected = (id: string) => session.waitFor("Tree canonical selection", context, value => value.target?.kind === "block" && value.target.blockId === id);
    const goto = async (query: string, id: string) => {
      await session.keys(remote.tree, "g");
      await session.waitVisible(remote.tree, "Goto:");
      await session.text(remote.tree, query);
      await session.waitFor("goto matching candidate", () => session.visible(remote.tree), frame => frame.includes("Goto:") && frame.includes(id.slice(0, 8)));
      await session.keys(remote.tree, "enter");
      await selected(id);
    };
    await goto("END-OF-EXACT-EDIT", editable.id);
    await session.keys(remote.tree, "e");
    await session.waitVisible(remote.tree, "END-OF-EXACT-EDIT");
    await session.text(remote.tree, " APPENDED");
    await session.keys(remote.tree, "enter");
    await session.waitFor("exact quick edit persisted", () => session.client.request<Block>({ action: "get", blockId: editable.id }), block => block.text === editText + " APPENDED");
    await session.checkpoint("02-exact-edit-beyond-preview");

    await goto(board.id, board.id);
    await session.keys(remote.tree, "down");
    await selected(long.id);
    const beforeExpand = session.forwardedTreeRequests().length;
    await session.keys(remote.tree, ".");
    await session.waitVisible(remote.tree, "EXPANDED BODY CHECKPOINT");
    if (transport === "forwarded") {
      assert.equal(session.forwardedTreeRequests().slice(beforeExpand).filter(request => request.action === "get" && request.blockId === long.id).length, 1);
    }
    await session.checkpoint("03-expanded-virtual-source");
    const updated = await session.client.request<Block>({ action: "update", blockId: long.id, expectedRevision: long.revision,
      mutation: { author: "agent", actorId: "pie-269-fixture-writer" },
      text: long.text.replace("EXPANDED BODY CHECKPOINT", "REMOTE BODY CHECKPOINT") });
    await session.waitVisible(remote.tree, "REMOTE BODY CHECKPOINT");
    await session.client.request({ action: "move", blockId: card.id, parentId: root.id, position: 0 });
    await selected(long.id);
    await session.waitVisible(remote.tree, "REMOTE BODY CHECKPOINT");
    assert.equal((await session.client.request<Block>({ action: "get", blockId: long.id })).revision, updated.revision);
    await session.keys(remote.tree, ".");
    await session.waitVisible(remote.tree, "Block detail collapsed");
    await goto(board.id, board.id);
    await session.keys(remote.tree, "down");
    await selected(card.id);
    await session.keys(remote.tree, "down");
    await selected(child.id);
    await session.checkpoint("04-revalidated-selection-and-context");
    await session.record("tree-read-journey", { longId: long.id, editId: editable.id, cardId: card.id, childId: child.id, boardId: board.id,
      requests: session.forwardedTreeRequests(), limitation: "same-host private socket forwarding; no two-host SSH claim" });
  },
});
process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.status === "failed") process.exitCode = 1;
