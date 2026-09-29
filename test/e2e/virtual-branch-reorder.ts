import assert from "node:assert/strict";
import type { Block, VisibleBlockCollection } from "../../src/types";
import { runHerdrScenario } from "./herdr-runner";

const result = await runHerdrScenario({
  name: "virtual-branch-reorder",
  async prepare() {},
  async run(s) {
    const terminal = await s.attachClient();
    await terminal.resize(190, 55);
    const tree = s.panes.tree;
    const create = (text: string) => s.client.request<Block>({ action: "create", text });
    const outer = await create("View index\n[type::virtual-branch] [query::folder=views]");
    const view = await create("Candidate list\n[type::virtual-branch] [query::fixture=reorder] [folder::views]");
    const first = await create("ALPHA candidate\n[fixture::reorder]");
    const second = await create("BRAVO candidate\n[fixture::reorder]");
    const hub = await create(`Planning hub\n\n!((${view.id}))`);
    const ordered = async () => (await s.client.request<VisibleBlockCollection>({
      action: "blocks.query", query: { filters: [{ key: "fixture", value: "reorder" }], rankViewId: view.id, limit: 10 },
    })).blocks.map(block => block.id);
    const hubOrder = async (before: string, after: string) => s.waitFor(
      "open hub reflects branch order", () => s.visible(s.panes.detail),
      text => text.includes(before) && text.includes(after) && text.indexOf(before) < text.indexOf(after),
    );
    await s.revealTree(tree, hub.id);
    await s.keys(tree, "enter");
    await hubOrder("ALPHA candidate", "BRAVO candidate");
    await s.revealTree(tree, view.id);
    await s.keys(tree, "down");
    await s.checkpoint("01-two-appearances-original-order");
    await s.keys(tree, "alt+down");
    await s.waitVisible(tree, "Moved down within virtual branch");
    assert.deepEqual(await ordered(), [second.id, first.id]);
    await hubOrder("BRAVO candidate", "ALPHA candidate");
    await s.checkpoint("02-direct-reorder-live-hub");
    await s.keys(tree, "alt+down");
    await s.waitVisible(tree, "Already last in virtual branch");
    assert.deepEqual(await ordered(), [second.id, first.id]);

    // Select the nested appearance using the rendered row, then the same reorder action.
    await s.revealTree(tree, outer.id);
    await s.focus(tree);
    const screen = await s.waitFor("nested candidates visible", terminal.visible,
      text => text.split("\n").filter(line => line.includes("BRAVO candidate")).length >= 2);
    const lines = screen.split("\n");
    const y = lines.findIndex(line => line.includes("BRAVO candidate"));
    const x = lines[y]!.indexOf("BRAVO candidate");
    await terminal.write(`\x1b[<0;${x + 2};${y + 1}M\x1b[<0;${x + 2};${y + 1}m`);
    await s.waitFor("pointer selects nested candidate", s.registrations, entries => entries.some(entry =>
      entry.runtime?.paneId === tree && entry.previewTarget?.kind === "block" &&
      entry.previewTarget.blockId === second.id));
    // Compact chrome (the default since PIE-385) hides breadcrumbs; show them to
    // confirm the nested appearance is selected, then return to compact.
    const density = async (label: string) => {
      await s.keys(tree, "?"); await s.text(tree, label); await s.keys(tree, "enter");
    };
    await density("Expanded layout");
    await s.waitVisible(tree, "View index › ◇ Candidate list › ◇ BRAVO candidate");
    await density("Compact layout");
    await s.waitFor("compact Tree", () => s.visible(tree), text => !text.includes("View index › ◇"));
    await s.keys(tree, "alt+down");
    await s.waitVisible(tree, "Moved down within virtual branch");
    assert.deepEqual(await ordered(), [first.id, second.id]);
    await hubOrder("ALPHA candidate", "BRAVO candidate");
    await terminal.resize(150, 48);
    await s.keys(tree, "alt+up");
    await s.waitVisible(tree, "Moved up within virtual branch");
    assert.deepEqual(await ordered(), [second.id, first.id]);
    await hubOrder("BRAVO candidate", "ALPHA candidate");
    await s.checkpoint("03-nested-pointer-reorder-resize");
    for (const original of [first, second]) {
      assert.deepEqual(await s.client.request<Block>({ action: "get", blockId: original.id }), original);
    }
    await s.record("coverage", {
      input: "Herdr-injected Alt+Arrow keys and attached-terminal pointer selection",
      result: "Both appearances reorder; boundary is local; open hub follows; canonical notes unchanged",
      limits: "Physical laptop keyboard and deployment not exercised",
    });
  },
});
console.log(JSON.stringify(result));
if (result.status !== "passed") process.exitCode = 1;
