import assert from "node:assert/strict";
import {visibleWidth} from "@earendil-works/pi-tui";
import type {Block} from "../../src/types";
import {runHerdrScenario} from "./herdr-runner";

const ansi = process.argv.includes("--ansi");
const nvim = Bun.which("nvim");
if (!nvim) throw Error("Neovim is required for this journey");

const result = await runHerdrScenario({
  name: `checklist-identity-${ansi ? "ansi" : "pi"}`,
  detailRenderer: ansi ? "ansi" : "pi-tui",
  editor: `${nvim} --clean`,
  async prepare() {},
  async run(s) {
    const terminal = await s.attachClient();
    await terminal.resize(180, 60);
    const source = await s.client.request<Block>({action: "create", text:
      "CHECKLIST IDENTITY\n\n- [ ] First step ^first\n- [~] Keep this step ^second\n"});
    await s.revealTree(s.panes.tree, source.id);
    await s.keys(s.panes.tree, "alt+enter");
    await s.waitVisible(s.panes.detail, "Keep this step");
    await s.focus(s.panes.detail);
    await s.keys(s.panes.detail, "ctrl+e");
    await s.waitVisible(s.panes.detail, "draft.md");
    await terminal.write(":%s/ \\^first//\r:wq\r");
    await s.waitVisible(s.panes.detail, "Imported $EDITOR changes");
    await s.keys(s.panes.detail, "ctrl+s");
    await s.waitVisible(s.panes.detail, "Save and remove 1 item address");
    assert.equal((await s.client.request<Block>({action: "get", blockId: source.id})).text, source.text);
    await s.checkpoint("01-explicit-removal-choice");
    // Enter defaults to retaining the unsaved draft, not removing its addresses.
    await s.keys(s.panes.detail, "enter");
    await s.waitVisible(s.panes.detail, "Draft kept open");
    assert.equal((await s.client.request<Block>({action: "get", blockId: source.id})).revision, source.revision);
    await s.keys(s.panes.detail, "ctrl+s");
    await s.waitVisible(s.panes.detail, "Save and remove 1 item address");
    await terminal.resize(120, 50);
    await s.waitVisible(s.panes.detail, "Keep editing");
    await s.keys(s.panes.detail, "escape");
    await s.waitVisible(s.panes.detail, "Draft kept open");
    await s.checkpoint("02-cancel-after-resize");
    await s.keys(s.panes.detail, "ctrl+s");
    await s.waitVisible(s.panes.detail, "Save and remove 1 item address");
    if (ansi) {
      await s.keys(s.panes.detail, "down", "enter");
    } else {
      const label = "Save and remove 1 item address";
      const frame = await s.waitFor("attached removal menu", terminal.visible, f => f.includes(label));
      const rows = frame.split("\n"), row = rows.findIndex(line => line.includes(label));
      const column = visibleWidth(rows[row]!.slice(0, rows[row]!.indexOf(label)));
      await terminal.write(`\x1b[<0;${column + 2};${row + 1}M\x1b[<0;${column + 2};${row + 1}m`);
    }
    const saved = await s.waitFor("explicit address removal saved", () => s.client.request<Block>({action: "get", blockId: source.id}),
      block => block.revision > source.revision);
    assert.equal(saved.text, source.text.replace(" ^first", ""));
    assert.ok(saved.text.includes("^second"));
    await s.waitVisible(s.panes.detail, "Keep this step");
    await s.checkpoint("03-only-confirmed-address-removed");
    await s.record("coverage", {input: ansi ? "Injected keyboard" : "Injected keyboard and attached-terminal pointer", physicalKeyboard: false});
  },
});
console.log(JSON.stringify(result));
if (result.status !== "passed") process.exitCode = 1;
