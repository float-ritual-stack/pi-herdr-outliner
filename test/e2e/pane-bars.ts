import assert from "node:assert/strict";
import {visibleWidth} from "@earendil-works/pi-tui";
import type {Block} from "../../src/types";
import {runHerdrScenario, type HerdrScenarioSession} from "./herdr-runner";

/** Rows of fixture content in a Tree pane: Tree rows plus Preview document rows. */
export function contentRows(frame: string): {tree: number; preview: number; height: number; width: number} {
  const lines = frame.replace(/\n+$/, "").split("\n");
  // A Preview docked right shares rows with Tree, split at the divider.
  const parts = lines.filter(line => !line.includes("[⋯]") && !line.includes("⌂") && !line.includes("Opens in:")).map(line => {
    const divider = line.indexOf("│");
    return divider < 0 ? {tree: line, preview: line} : {tree: line.slice(0, divider), preview: line.slice(divider + 1)};
  });
  return {
    tree: parts.filter(part => /ROW \d\d|BAR FIXTURE/.test(part.tree) && !part.tree.includes("Preview ·")).length,
    preview: parts.filter(part => /^\s*(BODY LINE \d\d|ROW 01 BAR NOTE)\s*$/.test(part.preview)).length,
    height: lines.length,
    width: Math.max(...lines.map(line => visibleWidth(line))),
  };
}

/** A focused branch of 40 rows whose first row is a long note shown in Preview. */
export async function prepareFixture(s: HerdrScenarioSession): Promise<{parent: Block; note: Block}> {
  const parent = await s.client.request<Block>({action: "create", text: "BAR FIXTURE"});
  const note = await s.client.request<Block>({action: "create", parentId: parent.id,
    text: ["ROW 01 BAR NOTE", "", ...Array.from({length: 80}, (_, i) => `BODY LINE ${String(i + 1).padStart(2, "0")}`)].join("\n")});
  for (let index = 2; index <= 40; index += 1) {
    await s.client.request<Block>({action: "create", parentId: parent.id, text: `ROW ${String(index).padStart(2, "0")}`});
  }
  await s.focus(s.panes.tree);
  await s.revealTree(s.panes.tree, parent.id);
  await s.keys(s.panes.tree, "?");
  await s.waitVisible(s.panes.tree, "Find:");
  await s.text(s.panes.tree, "focus branch");
  await s.waitVisible(s.panes.tree, "Find: focus branch");
  await s.keys(s.panes.tree, "enter");
  await s.waitFor("Tree rooted at the fixture", () => s.visible(s.panes.tree), frame => frame.includes("ROW 01") && !frame.includes("Find:"));
  await s.revealTree(s.panes.tree, note.id);
  await s.waitFor("Preview shows the note", () => s.visible(s.panes.tree), frame => /^BODY LINE 01/m.test(frame));
  return {parent, note};
}

if (import.meta.main) {
  const result = await runHerdrScenario({name: "pane-bars", async prepare() {}, async run(s) {
    const terminal = await s.attachClient();
    await terminal.resize(160, 45);
    const {note} = await prepareFixture(s);
    const before = await s.client.request<Block>({action: "get", blockId: note.id});
    const tree = s.panes.tree;
    const frame = () => s.visible(tree);
    const screen = () => terminal.visible();
    /** Clicks text in the attached Herdr client, the way a person's mouse does. */
    const click = async (text: string, button = 0, offset = 0) => {
      const lines = (await s.waitFor(`pointer target ${text}`, screen, f => f.includes(text))).split("\n");
      const row = lines.findIndex(line => line.includes(text));
      const column = visibleWidth(lines[row]!.slice(0, lines[row]!.indexOf(text))) + offset + 2;
      await terminal.write(`\x1b[<${button};${column};${row + 1}M\x1b[<${button};${column};${row + 1}m`);
    };
    const measure = async (label: string) => {
      const rows = contentRows(await frame());
      await s.record(`rows-${label}`, rows);
      return rows;
    };

    // Default: compact Tree and Preview, glyph dock buttons on the Preview bar.
    const initial = await s.waitFor("default Preview bar", frame, f => f.includes("[▐][▄][◙][×][⋯]"));
    const header = initial.split("\n")[0]!;
    assert.ok(/● (Tree|BAR FIXTURE)/.test(header) && header.includes("[⋯]"), "one Tree header row: identity and its bar");
    assert.ok(initial.split("\n")[1]!.includes("BAR FIXTURE"), "content starts on the second row");
    assert.ok(!initial.includes("physical block") && !initial.includes("Opens in:"), "stats and destination live in the menu");
    const compact = await measure("compact-default");
    await s.checkpoint("01-compact-default");

    // Dock right, then below, by clicking the Preview bar.
    await click("[▐]");
    await s.waitFor("Preview docked right", frame, f => f.split("\n")[0]!.includes("Preview ·"));
    const right = await measure("compact-right");
    await s.checkpoint("02-docked-right-by-click");
    await click("[▄]");
    await s.waitFor("Preview docked below", frame, f => !f.split("\n")[0]!.includes("Preview ·") && /^[●○] Preview ·/m.test(f) && f.includes("[○]"));
    await s.checkpoint("03-docked-below-by-click");
    await click("[○]");
    await s.waitVisible(tree, "[◙]");
    await click("[×]");
    await s.waitFor("Preview closed by click", frame, f => !f.includes("Preview ·") && !/^BODY LINE/m.test(f));
    await s.checkpoint("04-closed-by-click");
    await s.keys(tree, "alt+shift+p");
    await s.waitFor("Preview shown again by key", frame, f => /^BODY LINE 01/m.test(f));

    // Pin by right-click in the Tree menu, unpin and pin again by Alt+Enter.
    const item = "Navigate · toggle indentation follow";
    const pinnedTree = async () => (await s.readUiConfig() as {bar: {tree: string[]}}).bar.tree;
    await s.keys(tree, "?");
    await s.text(tree, "indentation");
    await s.waitFor("menu filtered", frame, f => f.includes("Find: indentation") && f.includes("pin to Tree bar") && f.includes(item));
    await s.waitFor("attached client shows the filtered menu", screen, f => f.includes("Find: indentation▏"));
    await click(item, 2);
    await s.waitFor("pinned by right-click", frame, f => f.includes(`♦ ${item}`));
    assert.equal((await pinnedTree()).at(-1), "tree.indentation.toggle");
    await s.checkpoint("05-pinned-by-right-click");
    await s.keys(tree, "alt+enter");
    await s.waitFor("unpinned by Alt+Enter", frame, f => f.includes("Unpinned toggle indentation follow") && !f.includes(`♦ ${item}`));
    assert.ok(!(await pinnedTree()).includes("tree.indentation.toggle"));
    await s.keys(tree, "alt+enter");
    await s.waitFor("pinned by Alt+Enter", frame, f => f.includes(`♦ ${item}`));
    await s.keys(tree, "escape");
    await s.waitFor("pin on the Tree bar", frame, f => f.split("\n")[0]!.includes("[Indent: viewport]"));
    await click("[Indent: viewport]");
    await s.waitFor("pinned button runs its action", frame, f => f.split("\n")[0]!.includes("[Indent: selection]"));
    await s.checkpoint("06-pinned-button-runs-from-bar");

    // The Preview's [⋯] opens its own menu: pins from it go on the Preview bar.
    await s.waitFor("back in Tree", frame, f => f.includes("[▐][▄][◙][×][⋯]") && !f.includes("Find:"));
    await click("[×][⋯]", 0, 3);
    await s.waitFor("Preview menu", frame, f => f.includes("pin to Preview bar"));
    await s.text(tree, "Grow Preview");
    await s.waitVisible(tree, "Find: Grow Preview");
    await s.keys(tree, "alt+enter");
    await s.waitFor("grow pinned to Preview", frame, f => f.includes("♦ View · Grow Preview"));
    await s.keys(tree, "escape");
    await s.waitFor("Preview bar shows [+]", frame, f => f.includes("[▐][▄][◙][×][+][⋯]"));
    await s.checkpoint("07-preview-pin-by-key");

    // Hand-edit ui.json, then Ctrl+R: Preview keeps only close; Tree and Preview go full.
    await s.setUiConfig({bar: {preview: ["tree.preview.close"]}, chrome: {tree: "full", preview: "full"}});
    await s.keys(tree, "ctrl+r");
    await s.waitFor("hand edit reloaded", frame, f => f.includes("[×][⋯]") && !f.includes("[▐]") && f.includes("physical block") && f.includes("Opens in:"));
    const full = await measure("full-after-hand-edit");
    await s.checkpoint("08-hand-edit-full-chrome");
    // A broken edit keeps what is shown.
    await s.setUiConfig("{\"bar\": ");
    await s.keys(tree, "ctrl+r");
    await s.waitVisible(tree, "Bars unchanged");
    assert.ok((await frame()).includes("physical block"));
    await s.checkpoint("09-broken-edit-kept");

    // Back to compact from the menu.
    await s.setUiConfig({bar: {preview: ["tree.preview.close"]}, chrome: {tree: "full", preview: "full"}});
    await s.keys(tree, "ctrl+r");
    await s.waitVisible(tree, "Keymap and bars reloaded");
    for (const kind of ["Tree", "Preview"]) {
      await s.keys(tree, "?");
      await s.text(tree, `${kind} chrome`);
      await s.waitVisible(tree, `${kind} chrome: full → compact`);
      await s.keys(tree, "enter");
      await s.waitFor(`${kind} compact`, frame, f => !f.includes("Find:") && f.includes(`${kind} chrome: compact`));
    }
    assert.deepEqual((await s.readUiConfig() as {chrome: unknown}).chrome, {tree: "compact", preview: "compact"});
    await s.waitFor("compact again", frame, f => !f.includes("physical block"));
    await s.checkpoint("10-compact-from-menu");

    // Detail: pin from its menu by key and by right-click; pins persist in the same file.
    await s.focus(s.panes.detail);
    await s.revealTree(tree, note.id);
    await s.keys(tree, "alt+enter");
    await s.waitVisible(s.panes.detail, "BODY LINE 01");
    await s.keys(s.panes.detail, "?");
    await s.waitFor("Detail menu open", () => s.visible(s.panes.detail), f => f.includes("Find:") && f.includes("pin to Detail bar"));
    await s.text(s.panes.detail, "bookmark");
    await s.waitFor("Detail menu filtered", () => s.visible(s.panes.detail), f => f.includes("pin to Detail bar") && f.includes("bookmark"));
    await s.keys(s.panes.detail, "alt+enter");
    await s.waitFor("bookmark pinned in Detail by key", () => s.visible(s.panes.detail), f => f.includes("Pinned bookmark"));
    for (let i = 0; i < "bookmark".length; i += 1) await s.keys(s.panes.detail, "backspace");
    await s.text(s.panes.detail, "mentions");
    await s.waitFor("Detail menu filtered to mentions", () => s.visible(s.panes.detail), f => f.includes("Find: mentions▏") && f.includes("recent mentions"));
    await s.waitFor("attached client shows the filtered menu", screen, f => f.includes("Find: mentions▏"));
    await click("recent mentions", 2);
    await s.waitFor("mentions pinned in Detail by right-click", () => s.visible(s.panes.detail), f => f.includes("Pinned recent mentions"));
    await s.checkpoint("11-detail-menu-pins");
    await s.keys(s.panes.detail, "escape");
    await s.waitFor("Detail bar shows the pin", () => s.visible(s.panes.detail), f => f.split("\n")[0]!.includes("[bookmark]"));
    const pins = await s.readUiConfig() as {bar: Record<string, string[]>};
    assert.deepEqual(pins.bar.detail?.slice(-2), ["detail.bookmark.toggle", "detail.mentions.open"]);
    await s.checkpoint("12-detail-bar");

    const after = await s.client.request<Block>({action: "get", blockId: note.id});
    assert.equal(after.text, before.text);
    assert.equal(after.revision, before.revision);
    await s.record("content-rows", {compact, right, full});
    console.error(JSON.stringify({compact, right, full}));
  }});
  console.log(JSON.stringify(result));
  if (result.status !== "passed") process.exitCode = 1;
}
