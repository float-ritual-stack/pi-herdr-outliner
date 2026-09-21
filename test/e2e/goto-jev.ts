import assert from "node:assert/strict";
import type { Block, BrowsingContextState, GotoSearchCollection } from "../../src/types";
import { runHerdrScenario } from "./herdr-runner";

// Opt-in network proof: only this private fixture workspace reaches TypeSafe.
const result = await runHerdrScenario({
  name: "goto-jev", layout: "composed", allowJev: true,
  async prepare() {},
  async run(session) {
    await session.attachClient();
    const river = await session.client.request<Block>({action: "create", parentId: null, text: "Detail river browser experiment\nA browser arranges terminal panes beside their source. Clicking a note opens another split. RIVER-PREVIEW-PROOF"});
    await session.client.request({action: "create", parentId: null, text: "Terminal configuration\nKeyboard preferences and font colors for Herdr."});
    const query = "the browser experiment with terminal panes";
    const pane = session.panes.tree;
    await session.focus(pane); await session.keys(pane, "g"); await session.text(pane, query);
    await session.waitVisible(pane, "Jev ranked");
    await session.waitVisible(pane, "RIVER-PREVIEW-PROOF");
    await session.checkpoint("01-real-jev-preview");
    await session.keys(pane, "enter");
    const primary = (await session.registrations())[0]!;
    await session.waitFor("ranked choice reveals canonical note", () => session.client.request<BrowsingContextState>({action: "browsing-context.get", contextId: primary.contextId!}), value => value.target?.kind === "block" && value.target.blockId === river.id);
    const result = await session.client.request<GotoSearchCollection>({action: "tree.search", query, semantic: true});
    assert.equal(result.semantic.status, "ranked"); assert.equal(result.matches[0]!.block.id, river.id);
    await session.record("real-jev", {query, topId: river.id, semantic: result.semantic});
    await session.checkpoint("02-real-jev-open");
  },
});
console.log(JSON.stringify(result));
if (result.status !== "passed") process.exitCode = 1;
