import assert from "node:assert/strict";
import type { Block, BlockCollectionCompleteness, BrowsingContextState } from "../../src/types";
import { runHerdrScenario } from "./herdr-runner";

const result = await runHerdrScenario({
  name: "documentation-seed",
  async prepare() {},
  async run(session) {
    // Use the service's actual empty-workspace seed, not a separately authored fixture.
    const query = async (key: string, value: string) => {
      const collection = await session.client.request<{ blocks: Block[]; completeness: BlockCollectionCompleteness }>({
        action: "blocks.query", query: { filters: [{ key, value }], limit: 10 },
      });
      assert.equal(collection.completeness.kind, "complete");
      assert.equal(collection.blocks.length, 1);
      return collection.blocks[0]!;
    };
    const tour = await query("system-doc", "feature-tour");
    const reader = await query("demo-kind", "reader");
    const source = await query("demo-kind", "source");
    const children = await session.client.request<Block[]>({ action: "children", parentId: tour.id });
    const view = children.find(block => block.text.startsWith("Ranked example notes"))!;
    assert.ok(view);
    const terminal = await session.attachClient();
    const tree = (await session.registrations()).find(client => client.role === "tree")!;
    const selection = async () => (await session.client.request<BrowsingContextState>({
      action: "browsing-context.get", contextId: tree.contextId!,
    })).target;
    const go = async (text: string, block: Block) => {
      await session.focus(session.panes.tree);
      await session.keys(session.panes.tree, "g");
      await session.waitFor("Goto opens", () => terminal.visible(), frame => frame.includes("Go to  "));
      await terminal.write(`\x1b[200~${text}\x1b[201~`);
      const title = block.text.split("\n")[0]!.split(" [")[0]!;
      await session.waitFor("Goto selects seeded documentation", () => terminal.visible(), frame => frame.includes(`› ${title}`));
      await terminal.write("\r");
      await session.waitFor("Goto closes", () => terminal.visible(), frame => !frame.includes("Go to  "));
      await session.waitFor("seeded block selected", selection, target => target?.kind === "block" && target.blockId === block.id);
    };

    // Goto's Enter reveals in Tree; Tree's Enter opens through the linked Detail (PIE-306, #189).
    await go("outliner-tour", tour);
    await session.keys(session.panes.tree, "enter");
    await session.waitVisible(session.panes.detail, "Explore the Outliner");
    await session.waitVisible(session.panes.detail, "Find and keep your place");
    await session.checkpoint("01-find-seeded-tour");
    await go(reader.id, reader);
    await session.keys(session.panes.tree, "enter");
    await session.waitVisible(session.panes.detail, "This is one ordinary editable note");
    assert.equal((await session.client.request<Block>({ action: "get", blockId: source.id })).text, source.text);
    await session.checkpoint("02-reader-renders-source-fragment");
    await go(view.id, view);
    await session.keys(session.panes.tree, "right");
    await session.waitVisible(session.panes.tree, "◇ A canonical source note");
    await session.waitFor("first projected root selected", selection, target => target?.kind === "block" && target.blockId === source.id);
    await session.keys(session.panes.tree, "down");
    await session.waitFor("second projected root selected", selection, target => target?.kind === "block" && target.blockId === reader.id);
    await session.waitVisible(session.panes.tree, "◇ A reader with two references");
    await session.checkpoint("03-ranked-example-view");
    await session.keys(session.panes.tree, "left");
    await session.waitFor("return to ranked branch", selection, target => target?.kind === "block" && target.blockId === view.id);
    await session.keys(session.panes.tree, "left");
    await session.waitFor("collapsed branch removes projected rows", () => session.visible(session.panes.tree),
      frame => frame.includes("▸ Ranked example notes") && !frame.includes("◇ A reader with two references"));
    await session.record("documentation-evidence", {
      tourId: tour.id, readerId: reader.id, sourceId: source.id, viewId: view.id,
      freshSeed: true, gotoByPageAddress: true, fragmentRendered: true,
      queryExamplesVisible: true, sourceUnchanged: true,
    });
  },
});
console.log(JSON.stringify(result));
if (result.status !== "passed") process.exitCode = 1;
