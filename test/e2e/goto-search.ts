import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Block, BrowsingContextState, GotoSearchCollection } from "../../src/types";
import { runHerdrScenario } from "./herdr-runner";

const composed = process.argv.includes("--composed");
const result = await runHerdrScenario({
  name: `goto-search${composed ? "-composed" : ""}`, layout: composed ? "composed" : "separate",
  async prepare() {},
  async run(session) {
    const terminal = await session.attachClient();
    const pane = session.panes.tree;
    const create = (text: string, parentId: string | null = null) => session.client.request<Block>({action: "create", parentId, text});
    const root = await create("PIE230 search fixtures");
    const first = await create("Saffron reference alpha\n\nALPHA-PREVIEW-BODY\n\n" + Array.from({length: 70}, (_, index) => `Preview paragraph ${index}: readable canonical text.\n`).join("\n"), root.id);
    const second = await create("Saffron reference beta\n\nBETA-PREVIEW-BODY", root.id);
    for (let index = 0; index < 40; index++) await create(`PIE230 scroll context ${index}`);
    const origin = await create("PIE230 original selection\n\nORIGINAL-DETAIL-BODY");
    const current = async () => (await session.registrations()).find(entry => entry.role === (composed ? "composed" : "tree"))!;
    const detail = async () => (await session.registrations()).find(entry => entry.role === (composed ? "composed" : "detail"))!;
    const selection = async () => {
      const tree = await current();
      return (await session.client.request<BrowsingContextState>({action: "browsing-context.get", contextId: tree.contextId!})).target;
    };
    const begin = async (query: string) => {
      await session.focus(pane);
      await session.keys(pane, "g");
      await session.text(pane, query);
    };
    await begin(origin.id);
    await session.keys(pane, "enter");
    await session.waitVisible(session.panes.detail, "ORIGINAL-DETAIL-BODY");
    const before = await selection();
    const detailBefore = (await detail()).currentTarget;
    const contextLines = (frame: string) => frame.split("\n").filter(line => line.includes("PIE230 scroll context")).map(line => line.slice(0, 30));
    const scrollBefore = contextLines(await session.visible(pane));
    assert.ok(scrollBefore.length > 0);

    await begin("saffron");
    await session.waitVisible(pane, "ALPHA-PREVIEW-BODY");
    await session.waitVisible(pane, "Jev is not configured");
    assert.deepEqual(await selection(), before);
    assert.deepEqual((await detail()).currentTarget, detailBefore);
    await session.keys(pane, "down");
    await session.waitVisible(pane, "BETA-PREVIEW-BODY");
    // Use the real terminal's coordinates rather than an assumed Herdr border offset.
    const frame = (await terminal.visible()).split("\n");
    const row = frame.findIndex(line => line.includes("Saffron reference alpha"));
    assert.ok(row >= 0);
    const column = visibleWidth(frame[row]!.slice(0, frame[row]!.indexOf("Saffron reference alpha")));
    await terminal.write(`\x1b[<0;${column + 1};${row + 1}M\x1b[<0;${column + 1};${row + 1}m`);
    await session.waitVisible(pane, "ALPHA-PREVIEW-BODY");
    assert.deepEqual(await selection(), before);
    await terminal.write("\x1b[6~");
    await session.waitFor("preview scrolls", () => session.visible(pane), text => !text.includes("ALPHA-PREVIEW-BODY") && text.includes("Preview paragraph"));
    await session.checkpoint("01-query-preview-and-pointer");
    await session.keys(pane, "escape");
    await session.waitVisible(pane, "PIE230 original selection");
    assert.deepEqual(await selection(), before);
    assert.deepEqual((await detail()).currentTarget, detailBefore);
    assert.deepEqual(contextLines(await session.visible(pane)), scrollBefore);
    await session.checkpoint("02-cancel-preserves-context");

    await begin("saffron beta");
    await session.waitVisible(pane, "BETA-PREVIEW-BODY");
    await session.keys(pane, "enter");
    await session.waitFor("Enter reveals result", selection, target => target?.kind === "block" && target.blockId === second.id);
    await session.waitVisible(session.panes.detail, "BETA-PREVIEW-BODY");
    const selected = await selection();
    await begin(first.id);
    await session.waitVisible(pane, "ALPHA-PREVIEW-BODY");
    await terminal.write("\x1b\r");
    await session.waitFor("Alt Enter opens Detail", detail, entry => entry.currentTarget?.kind === "block" && entry.currentTarget.blockId === first.id);
    assert.deepEqual(await selection(), selected);
    await session.checkpoint("03-independent-detail-open");
    if (composed) {
      await session.keys(pane, "q");
      await session.waitFor("return to Tree", current, entry => entry.focusedRegion === "tree");
    }

    await begin("saffron");
    await session.waitVisible(pane, "ALPHA-PREVIEW-BODY");
    await terminal.resize(76, 34);
    await session.waitVisible(pane, "ALPHA-PREVIEW-BODY");
    await session.checkpoint("04-narrow-stacked");
    await terminal.resize(240, 52);
    await session.waitVisible(pane, "ALPHA-PREVIEW-BODY");
    await session.checkpoint("05-wide-preview");
    await session.keys(pane, "escape");
    await session.waitFor("resize modal closed", () => session.visible(pane), frame => !frame.includes("Go to  "));
    const longList = await session.client.request<GotoSearchCollection>({action: "tree.search", query: "PIE230 scroll context"});
    assert.equal(longList.matches.length, 30); assert.equal(longList.completeness.kind, "truncated");
    await begin("PIE230 scroll context");
    await session.waitVisible(pane, longList.matches[0]!.title);
    await session.keys(pane, ...Array.from({length: 29}, () => "down"));
    await session.waitVisible(pane, `› ${longList.matches[29]!.title}`);
    await session.checkpoint("06-long-results-scroll");
    await session.keys(pane, "enter");
    await session.waitFor("last visible match opens", selection, target => target?.kind === "block" && target.blockId === longList.matches[29]!.block.id);
    const results = await session.client.request<GotoSearchCollection>({action: "tree.search", query: "saffron", semantic: true});
    assert.equal(results.semantic.status, "unavailable");
    assert.deepEqual(results.matches.slice(0, 2).map(match => match.block.id), [first.id, second.id]);
    await session.record("goto-evidence", {layout: composed ? "composed" : "separate", origin: origin.id, first: first.id, second: second.id, scrollBefore, previewNeverNavigates: true, cancelPreservesSelectionAndScroll: true, independentDetailOpen: true, longListNavigation: true, offlineSearch: true});
  },
});
console.log(JSON.stringify(result));
if (result.status !== "passed") process.exitCode = 1;
