import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Block, BookmarkToggleReceipt } from "../../src/types";
import { runHerdrScenario } from "./herdr-runner";

const result = await runHerdrScenario({
  name: "bookmark-mouse",
  async prepare() {},
  async run(session) {
    const targets: Block[] = [];
    const receipts: BookmarkToggleReceipt[] = [];
    for (const label of ["One", "Two"]) {
      const target = await session.client.request<Block>({
        action: "create", text: `Bookmark ${label} target\n\n${label.toUpperCase()} BOOKMARK BODY\n\n` +
          Array.from({ length: 70 }, (_, index) => `${label} paragraph ${index + 1}`).join("\n\n"),
      });
      targets.push(target);
      receipts.push(await session.client.request<BookmarkToggleReceipt>({
        action: "bookmarks.toggle", targetBlockId: target.id, expectedRecordId: null,
        label: `Bookmark ${label}`,
      }));
    }
    const records = () => session.client.request<Block[]>({
      action: "children", parentId: receipts[0]!.root.id,
    });
    const originalIds = (await records()).map((record) => record.id).sort();
    const terminal = await session.attachClient();
    await session.focus(session.panes.tree);
    await session.waitFor("attached Outliner", terminal.visible, (frame) => frame.includes("Outliner"));
    await terminal.write("M");
    const initial = await session.waitFor("bookmark popup with first preview", terminal.visible,
      (frame) => frame.includes("Bookmarks · split") && frame.includes("ONE BOOKMARK BODY"));
    await session.record("initial-bookmarks", { targets, receipts, originalIds, frame: initial });
    await session.checkpoint("01-bookmark-popup");

    const lines = initial.split("\n");
    const row = lines.findIndex((line) => line.includes("Bookmark Two"));
    assert.ok(row >= 0);
    const column = visibleWidth(lines[row]!.slice(0, lines[row]!.indexOf("Bookmark Two"))) + 3;
    await terminal.write(`\x1b[<0;${column + 1};${row + 1}M\x1b[<0;${column + 1};${row + 1}m`);
    await session.waitFor("click processed", terminal.visible,
      (frame) => frame.includes("TWO BOOKMARK BODY") || frame.includes("Bookmark removed"));
    const after = await records();
    await session.record("bookmarks-after-click", { records: after, frame: await terminal.visible(), row, column });
    await session.checkpoint("02-click-second-bookmark");
    assert.deepEqual(after.map((record) => record.id).sort(), originalIds, "A mouse click removed a bookmark");
    assert.ok((await terminal.visible()).includes("TWO BOOKMARK BODY"));

    // Inspect only the popup, excluding an underlying Detail's copy of a target.
    const popup = (frame: string) => {
      const lines = frame.split("\n");
      const top = lines.findIndex((line) => line.includes("Bookmarks · split"));
      if (top < 0) return "";
      const left = lines[top]!.indexOf("Bookmarks · split");
      const right = lines[top]!.indexOf("│", left);
      const bottom = lines.findIndex((line, index) => index > top && line[left - 1] === "└");
      assert.ok(right > left && bottom > top, "Popup bounds come from its rendered border");
      return lines.slice(top, bottom).map((line) => line.slice(left, right)).join("\n");
    };
    const waitPopup = (text: string) => session.waitFor(`popup: ${text}`, terminal.visible,
      (frame) => popup(frame).includes(text));
    const assertRecords = async () => {
      const current = await records();
      assert.deepEqual(current.map((record) => record.id).sort(), originalIds);
      for (const { record } of receipts) {
        assert.deepEqual(current.find((candidate) => candidate.id === record.id), record);
      }
    };
    const click = async (label: string, fragmented = false) => {
      const frame = await terminal.visible();
      const lines = frame.split("\n");
      const top = lines.findIndex((line) => line.includes("Bookmarks · split"));
      const row = lines.findIndex((line, index) => index > top && line.includes(label));
      assert.ok(row > top);
      const column = visibleWidth(lines[row]!.slice(0, lines[row]!.indexOf(label))) + 3;
      const press = `\x1b[<0;${column + 1};${row + 1}M`;
      const release = `\x1b[<0;${column + 1};${row + 1}m`;
      if (fragmented) {
        for (const chunk of [press.slice(0, 5), press.slice(5), release.slice(0, -1), release.slice(-1)]) {
          await terminal.write(chunk);
        }
      } else {
        await terminal.write(press + release);
      }
      return { row, column };
    };

    for (const source of ["tree", "detail"] as const) {
      if (source === "detail") {
        await session.focus(session.panes.detail);
        await terminal.write("M");
        await waitPopup("ONE BOOKMARK BODY");
      }
      await click("Bookmark One", true);
      await waitPopup("ONE BOOKMARK BODY");
      const point = await click("Bookmark Two", true);
      await waitPopup("TWO BOOKMARK BODY");
      await click("Bookmark Two");

      // Releases and clicks over the list, preview, and unused list space are not keys.
      const lines = (await terminal.visible()).split("\n");
      const divider = lines[point.row]!.indexOf("│", point.column);
      const previewColumn = visibleWidth(lines[point.row]!.slice(0, divider)) + 4;
      for (const [column, row] of [[point.column, point.row], [previewColumn, point.row], [point.column, point.row + 5]]) {
        await terminal.write(`\x1b[<0;${column! + 1};${row! + 1}M\x1b[<0;${column! + 1};${row! + 1}m`);
      }
      // Bracketed paste remains inert; pasting m must not be a removal command.
      await terminal.write("\x1b[200~m\x1b[201~");
      await terminal.write("/");
      await waitPopup("Filter:"); // This key also fences all preceding pointer input.
      await assertRecords();
      await terminal.write("Two");
      await waitPopup("Filter: Two");
      assert.ok(!popup(await terminal.visible()).includes("Bookmark One"));
      await terminal.write("\x1b");
      await waitPopup("Bookmark One");

      await terminal.write("\x1b[A");
      await waitPopup("ONE BOOKMARK BODY");
      await terminal.write(`\x1b[<65;${point.column + 1};${point.row + 1}M`);
      await waitPopup("TWO BOOKMARK BODY");
      await terminal.write(`\x1b[<65;${previewColumn + 1};${point.row + 1}M`);
      await session.waitFor("wheel scrolls the preview", terminal.visible,
        (frame) => popup(frame).includes("Two paragraph") && !popup(frame).includes("TWO BOOKMARK BODY"));
      await terminal.write(`\x1b[<64;${previewColumn + 1};${point.row + 1}M`);
      await waitPopup("TWO BOOKMARK BODY");
      await terminal.write("\r");
      await waitPopup("Choose destination");
      await terminal.write("\x1b");
      await waitPopup("Enter choose");
      await assertRecords();
      await session.checkpoint(`03-${source}-mouse-keyboard-and-chooser`);

      // A literal keyboard command still removes exactly the selected bookmark.
      await terminal.write("m");
      await waitPopup("Bookmark removed");
      assert.deepEqual((await records()).map((record) => record.id), [receipts[0]!.record.id]);
      for (const target of targets) {
        assert.deepEqual(await session.client.request<Block>({ action: "get", blockId: target.id }), target);
      }
      await session.checkpoint(`04-${source}-explicit-removal`);
      await terminal.write("\x1b");
      await session.waitFor("popup closes on Escape", terminal.visible, (frame) => !popup(frame));
      if (source === "tree") {
        receipts[1] = await session.client.request<BookmarkToggleReceipt>({
          action: "bookmarks.toggle", targetBlockId: targets[1]!.id, expectedRecordId: null, label: "Bookmark Two",
        });
        originalIds.splice(0, originalIds.length, ...receipts.map(({ record }) => record.id).sort());
      }
    }
    await session.record("bookmark-input-invariants", {
      sources: ["tree", "detail"], targets, finalRecords: await records(),
      literalRemovalOnly: true, targetDocumentsUnchanged: true,
    });
  },
});
process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.status === "failed") process.exitCode = 1;
