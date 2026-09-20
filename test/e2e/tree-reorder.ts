import assert from "node:assert/strict";
import type { Block, BrowsingContextState, WorkspaceSnapshot } from "../../src/types";
import { runHerdrScenario } from "./herdr-runner";

const result = await runHerdrScenario({
  name: "tree-reorder",
  async prepare() {},
  async run(session) {
    const create = (text: string, parentId: string | null = null) =>
      session.client.request<Block>({ action: "create", text, parentId });
    const parent = await create("REORDER-SOURCES");
    const first = await create("REORDER-A [probe::reorder]", parent.id);
    const second = await create("REORDER-B [probe::reorder]", parent.id);
    const branch = await create("REORDER-VIEW [type::virtual-branch] [query::probe=reorder]");
    const treePane = session.panes.tree;
    const tree = (await session.registrations()).find(client => client.runtime?.paneId === treePane);
    assert.ok(tree?.contextId);
    const context = () => session.client.request<BrowsingContextState>({ action: "browsing-context.get", contextId: tree.contextId! });
    const selected = (id: string) => session.waitFor("selected block", context,
      value => value.target?.kind === "block" && value.target.blockId === id);
    const goto = async (id: string) => {
      await session.keys(treePane, "g");
      await session.waitVisible(treePane, "Goto:");
      await session.text(treePane, id);
      await session.waitVisible(treePane, id.slice(0, 8));
      await session.keys(treePane, "enter");
      await selected(id);
    };
    const siblings = async () => (await session.client.request<Block[]>({ action: "children", parentId: parent.id })).map(block => block.id);
    const rankOrder = async () => (await session.client.request<WorkspaceSnapshot>({ action: "workspace.snapshot" }))
      .virtualOccurrenceRanks.filter(rank => rank.viewId === branch.id).sort((a, b) => a.rank - b.rank).map(rank => rank.blockId);
    const ranked = (ids: string[]) => session.waitFor("persisted branch order", rankOrder,
      actual => JSON.stringify(actual) === JSON.stringify(ids));
    const registrationsBefore = (await session.registrations()).map(client => client.clientId).sort();

    await goto(second.id);
    await session.keys(treePane, "alt+up");
    await session.waitVisible(treePane, "Moved up among siblings");
    assert.deepEqual(await siblings(), [second.id, first.id]);
    await selected(second.id);
    await session.checkpoint("01-canonical-up");
    await session.keys(treePane, "alt+down");
    await session.waitVisible(treePane, "Moved down among siblings");
    assert.deepEqual(await siblings(), [first.id, second.id]);
    await selected(second.id);

    await goto(branch.id);
    await session.keys(treePane, "down");
    await selected(first.id);
    await session.keys(treePane, "alt+down");
    await ranked([second.id, first.id]);
    await selected(first.id);
    await session.keys(treePane, "?");
    await session.waitVisible(treePane, "Find:");
    await session.text(treePane, "Move item");
    const menu = await session.waitVisible(treePane, "Move item down");
    assert.ok(menu.includes("Move item up") && menu.includes("⌥↑") && menu.includes("⌥↓"));
    await session.checkpoint("02-discoverable-reorder");
    await session.text(treePane, " up");
    await session.keys(treePane, "enter");
    await ranked([first.id, second.id]);
    await selected(first.id);
    assert.deepEqual(await siblings(), [first.id, second.id]);

    await session.setKeybindings({ "tree.reorder.up": ["Shift+ArrowUp"], "tree.reorder.down": ["Shift+ArrowDown"] });
    await session.keys(treePane, "ctrl+r");
    await session.waitVisible(treePane, "Outliner keymap reloaded");
    await session.keys(treePane, "shift+down");
    await ranked([second.id, first.id]);
    await session.setKeybindings({ "tree.reorder.down": ["Shift+ArrowDown"], "tree.detail.below": ["Shift+ArrowDown"] });
    await session.keys(treePane, "ctrl+r");
    await session.waitVisible(treePane, "Keymap unchanged:");
    await session.checkpoint("03-conflicting-reload-rejected");
    await session.keys(treePane, "shift+up");
    await ranked([first.id, second.id]);
    await selected(first.id);
    assert.deepEqual((await session.registrations()).map(client => client.clientId).sort(), registrationsBefore);
    for (const original of [first, second]) {
      const saved = await session.client.request<Block>({ action: "get", blockId: original.id });
      assert.equal(saved.text, original.text);
      assert.equal(saved.revision, original.revision);
      assert.equal(saved.parentId, original.parentId);
    }
    await session.record("reorder-invariants", { first: first.id, second: second.id, branch: branch.id,
      canonicalOrder: await siblings(), branchOrder: await rankOrder(), noExtraClients: true });
    await session.setKeybindings({});
    await session.keys(treePane, "ctrl+r");
    await session.waitVisible(treePane, "Outliner keymap reloaded");

    for (const [key, direction] of [["alt+shift+down", "down"], ["alt+shift+right", "right"]] as const) {
      await session.keys(treePane, key);
      const clients = await session.waitFor("independent Detail registered", session.registrations,
        values => values.some(client => !registrationsBefore.includes(client.clientId)));
      const detached = clients.find(client => !registrationsBefore.includes(client.clientId))!;
      const pane = await session.adoptDetached(detached.clientId);
      await session.waitVisible(treePane, `Opened new independent Detail ${direction}`);
      await session.waitVisible(pane, "REORDER-A");
      await session.checkpoint(`04-split-${direction}`);
      await session.closeDetached(pane);
      await session.waitFor("detached client removed", session.registrations,
        values => !values.some(client => client.clientId === detached.clientId));
      await session.focus(treePane);
    }
  },
});
console.log(JSON.stringify(result));
if (result.status !== "passed") process.exitCode = 1;
