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
    const popup = () => terminal.visible();
    const waitPopup = (text: string) => session.waitFor(`popup: ${text}`, popup, frame => frame.includes(text));
    const closed = () => session.waitFor("Goto popup closed", popup, frame => !frame.includes("Go to  "));
    const begin = async (query: string) => {
      await closed();
      await session.focus(pane);
      await session.keys(pane, "g");
      await waitPopup("Go to  ");
      await terminal.write(`\x1b[200~${query}\x1b[201~`);
    };
    await begin(origin.id);
    await terminal.write("\r");
    await closed();
    await session.waitVisible(session.panes.detail, "ORIGINAL-DETAIL-BODY");
    const before = await selection();
    const detailBefore = (await detail()).currentTarget;
    const contextLines = (frame: string) => frame.split("\n").filter(line => line.includes("PIE230 scroll context")).map(line => line.slice(0, 30));
    const scrollBefore = contextLines(await session.visible(pane));
    assert.ok(scrollBefore.length > 0);

    await begin("saffron");
    await waitPopup("ALPHA-PREVIEW-BODY");
    await waitPopup("Jev is not configured");
    assert.deepEqual(await selection(), before);
    assert.deepEqual((await detail()).currentTarget, detailBefore);
    await terminal.write("\x1b[B");
    await waitPopup("BETA-PREVIEW-BODY");
    // Use the real terminal's coordinates rather than an assumed Herdr border offset.
    const frame = (await terminal.visible()).split("\n");
    const row = frame.findIndex(line => line.includes("Saffron reference alpha"));
    assert.ok(row >= 0);
    const column = visibleWidth(frame[row]!.slice(0, frame[row]!.indexOf("Saffron reference alpha")));
    await terminal.write(`\x1b[<0;${column + 1};${row + 1}M\x1b[<0;${column + 1};${row + 1}m`);
    await waitPopup("ALPHA-PREVIEW-BODY");
    assert.deepEqual(await selection(), before);
    await terminal.write("\x1b[6~");
    await session.waitFor("preview scrolls", popup, text => !text.includes("ALPHA-PREVIEW-BODY") && text.includes("Preview paragraph"));
    const popupBorder = (await popup()).split("\n").find(line => line.includes("┌──"));
    assert.ok(popupBorder && (popupBorder.match(/─/g)?.length ?? 0) > 120, "Popup must span more than the narrow Tree pane");
    assert.equal((await session.registrations()).length, composed ? 1 : 2, "A transient popup must not register as a navigation destination");
    await session.checkpoint("01-query-preview-and-pointer");
    await terminal.write("\x1b");
    await closed();
    await session.waitVisible(pane, "PIE230 original selection");
    assert.deepEqual(await selection(), before);
    assert.deepEqual((await detail()).currentTarget, detailBefore);
    assert.deepEqual(contextLines(await session.visible(pane)), scrollBefore);
    // Cancellation must return actual keyboard focus, not just restore pixels.
    await terminal.write("\x1b[A");
    await session.waitFor("Tree receives keys after cancel", selection, value => JSON.stringify(value) !== JSON.stringify(before));
    await terminal.write("\x1b[B");
    await session.waitFor("Tree restored after focus check", selection, value => JSON.stringify(value) === JSON.stringify(before));
    await session.checkpoint("02-cancel-preserves-context");

    await begin("saffron beta");
    await waitPopup("BETA-PREVIEW-BODY");
    await terminal.write("\r");
    await closed();
    await session.waitFor("Enter reveals result", selection, target => target?.kind === "block" && target.blockId === second.id);
    await session.waitVisible(session.panes.detail, "BETA-PREVIEW-BODY");
    const selected = await selection();
    await begin(first.id);
    await waitPopup("ALPHA-PREVIEW-BODY");
    // Pi negotiates Kitty: ESC-CR means Shift+Enter there, so use explicit Alt.
    await terminal.write("\x1b[13;3u");
    await closed();
    await session.waitFor("Alt Enter opens Detail", detail, entry => entry.currentTarget?.kind === "block" && entry.currentTarget.blockId === first.id);
    assert.deepEqual(await selection(), selected);
    await session.waitFor("Detail ready for keyboard input", detail,
      entry => composed ? entry.focusedRegion === "detail" : entry.runtime?.focused === true);
    await terminal.write("L");
    await session.waitFor("Detail receives keys after popup open", detail, entry => entry.locked === true);
    await terminal.write("L");
    await session.waitFor("Detail unlocked after focus check", detail, entry => entry.locked === false);
    await session.checkpoint("03-independent-detail-open");
    if (composed) {
      await session.keys(pane, "q");
      await session.waitFor("return to Tree", current, entry => entry.focusedRegion === "tree");
    }

    await begin("saffron");
    await waitPopup("ALPHA-PREVIEW-BODY");
    await terminal.resize(76, 34);
    await session.waitFor("narrow popup stacks preview below results", popup, frame => {
      const lines = frame.split("\n");
      const resultRow = lines.findIndex(line => line.includes("› Saffron reference alpha"));
      const previewRow = lines.findIndex(line => line.includes("│Saffron reference alpha"));
      // Assert popup geometry, not host emoji widths under a different Unicode table.
      return lines.length === 34 && resultRow >= 0 && previewRow > resultRow &&
        lines.some(line => line.includes("ALPHA-PREVIEW-BODY"));
    });
    await session.checkpoint("04-narrow-stacked");
    await terminal.resize(240, 52);
    await session.waitFor("wide popup puts preview beside results", popup, frame =>
      frame.split("\n").some(line => line.includes("› Saffron reference alpha") && line.includes("│Saffron reference alpha")));
    await session.checkpoint("05-wide-preview");
    await terminal.write("\x1b");
    await closed();
    const longList = await session.client.request<GotoSearchCollection>({action: "tree.search", query: "PIE230 scroll context"});
    assert.equal(longList.matches.length, 30); assert.equal(longList.completeness.kind, "truncated");
    await begin("PIE230 scroll context");
    await waitPopup(longList.matches[0]!.title);
    await terminal.write("\x1b[B".repeat(29));
    await waitPopup(`› ${longList.matches[29]!.title}`);
    await session.checkpoint("06-long-results-scroll");
    await terminal.write("\r");
    await closed();
    await session.waitFor("last visible match opens", selection, target => target?.kind === "block" && target.blockId === longList.matches[29]!.block.id);
    const results = await session.client.request<GotoSearchCollection>({action: "tree.search", query: "saffron", semantic: true});
    assert.equal(results.semantic.status, "unavailable");
    assert.deepEqual(results.matches.slice(0, 2).map(match => match.block.id), [first.id, second.id]);
    await session.record("goto-evidence", {layout: composed ? "composed" : "separate", origin: origin.id, first: first.id, second: second.id, scrollBefore, previewNeverNavigates: true, cancelPreservesSelectionAndScroll: true, independentDetailOpen: true, longListNavigation: true, offlineSearch: true});
  },
});
console.log(JSON.stringify(result));
if (result.status !== "passed") process.exitCode = 1;
