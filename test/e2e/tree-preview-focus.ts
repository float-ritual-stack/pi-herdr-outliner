import assert from "node:assert/strict";
import {visibleWidth} from "@earendil-works/pi-tui";
import type {Block, BrowsingContextState} from "../../src/types";
import {runHerdrScenario} from "./herdr-runner";

const result = await runHerdrScenario({
  name: "tree-preview-click-focus",
  async prepare() {},
  async run(session) {
    // This helper launches two local processes in a private tab, giving Tree
    // the full tab width while retaining the production input and rendering paths.
    const panes = await session.openRemoteBrowsingContext({name: "pointer-local"});
    const tree = (await session.registrations()).find(c => c.runtime?.paneId === panes.tree)!;
    const parent = await session.client.request<Block>({action: "create", text: "POINTER FOCUS FIXTURE"});
    const docs: Block[] = [];
    for (const title of ["FOCUS FIRST", "FOCUS SECOND"]) docs.push(await session.client.request<Block>({action: "create", parentId: parent.id, text: `${title}\n\n${Array.from({length: 60}, (_, i) => `PREVIEW ROW ${String(i + 1).padStart(2, "0")}`).join("\n\n")}`}));
    const context = () => session.client.request<BrowsingContextState>({action: "browsing-context.get", contextId: tree.contextId!});
    const selected = async () => (await context()).target;
    // Establish the private tab before attaching the input client. Attaching
    // first can leave Herdr's client displaying the old tab even after CLI
    // focus and pane-local reads have moved to this fixture's Tree.
    await session.focus(panes.tree);
    await session.revealTree(panes.tree, docs[0]!.id);
    const terminal = await session.attachClient();
    await session.waitFor("attached client starts on the fixture Tree", terminal.visible, frame => frame.includes("FOCUS FIRST"));
    const click = async (column: number, row: number) => terminal.write(`\x1b[<0;${column + 1};${row + 1}M\x1b[<0;${column + 1};${row + 1}m`);
    for (const [placement, columns] of [["beside", 140], ["below", 80]] as const) {
      await terminal.resize(columns, 74);
      await session.focus(panes.tree);
      await session.revealTree(panes.tree, docs[0]!.id);
      const paneFrame = await session.waitFor(`${placement} Preview geometry`, () => session.visible(panes.tree), frame => {
        const rows = frame.split("\n");
        const previewRow = rows.findIndex(line => /[●○] Preview · FOCUS FIRST/.test(line));
        const line = rows[previewRow] ?? "";
        return previewRow >= 0 && Math.max(...rows.map(visibleWidth)) < columns && frame.includes("PREVIEW ROW 01") && (placement === "beside" ? visibleWidth(line.slice(0, line.indexOf("Preview"))) > 40 : previewRow > 8);
      });
      // xterm resizes immediately and can briefly show cropped old-width rows.
      // Match header offsets with the settled pane frame before using columns.
      const headerOffset = (frame: string) => {
        const lines = frame.split("\n");
        const heading = lines.findIndex(line => /[●○] Preview · FOCUS FIRST/.test(line));
        const title = lines.findIndex(line => /[●○] Tree/.test(line));
        if (heading < 0 || title < 0) return null;
        return {
          row: heading - title,
          column: visibleWidth(lines[heading]!.slice(0, lines[heading]!.indexOf("Preview"))) - visibleWidth(lines[title]!.slice(0, lines[title]!.search(/[●○] Tree/))),
        };
      };
      const expectedOffset = headerOffset(paneFrame);
      assert.ok(expectedOffset);
      const initial = await session.waitFor("native Preview coordinates", terminal.visible, frame => {
        const lines = frame.split("\n");
        const headingRow = lines.findIndex(line => /[●○] Preview · FOCUS FIRST/.test(line));
        const contentRow = lines.findIndex((line, index) => index > headingRow && line.includes("PREVIEW ROW 01") && !line.includes("↵"));
        const actualOffset = headerOffset(frame);
        return headingRow >= 0 && contentRow > headingRow && actualOffset?.row === expectedOffset.row && actualOffset.column === expectedOffset.column;
      });
      const rows = initial.split("\n");
      const row = rows.findIndex(line => line.includes("PREVIEW ROW 01") && !line.includes("↵"));
      assert.ok(row >= 0);
      const column = visibleWidth(rows[row]!.slice(0, rows[row]!.lastIndexOf("PREVIEW ROW 01"))) + 2;
      const previewHeading = rows.findIndex(line => /[●○] Preview · FOCUS FIRST/.test(line));
      const firstContentRow = (frame: string) => frame.split("\n").findIndex((line, index) => index > previewHeading && line.includes("PREVIEW ROW 01") && visibleWidth(line.slice(0, line.lastIndexOf("PREVIEW ROW 01"))) >= column - 2);
      const before = await context();
      await session.record(`${placement}-settled-pointer-coordinates`, {paneFrame, initial, expectedOffset, column, row});
      await click(column, row);
      await session.waitVisible(panes.tree, "● Preview");
      await session.keys(panes.tree, "down");
      const scrolled = await session.waitFor("Preview Down scrolls its content", terminal.visible, frame => {
        const nextRow = firstContentRow(frame);
        return nextRow === row - 1;
      });
      assert.deepEqual(await context(), before, "Preview arrows must not change Tree selection");
      await session.keys(panes.tree, "up");
      await session.waitFor("Preview Up restores content", terminal.visible, frame => firstContentRow(frame) === row);
      // The exact ESC+p wire form must work after a pointer-owned Preview,
      // as must Herdr's ordinary Alt+P encoder in the other direction.
      await terminal.write("\x1bp");
      await session.waitVisible(panes.tree, "○ Preview");
      await session.keys(panes.tree, "down");
      await session.waitFor("Alt+P returns arrows to Tree after Preview click", selected, target => target?.kind === "block" && target.blockId === docs[1]!.id);
      await session.keys(panes.tree, "up");
      await session.waitFor("Tree returns to first sibling", selected, target => target?.kind === "block" && target.blockId === docs[0]!.id);
      await session.waitVisible(panes.tree, "○ Preview · FOCUS FIRST");
      await session.keys(panes.tree, "alt+p");
      await session.waitVisible(panes.tree, "● Preview");
      await session.keys(panes.tree, "down");
      await session.waitFor("Alt+P into Preview sends Down to content", terminal.visible, frame => firstContentRow(frame) === row - 1);
      assert.deepEqual(await context(), before);
      await session.keys(panes.tree, "up");
      await session.waitFor("Alt+P Preview content returns", terminal.visible, frame => firstContentRow(frame) === row);
      await click(column, row);
      await session.keys(panes.tree, "alt+p");
      await session.waitVisible(panes.tree, "○ Preview");
      await session.keys(panes.tree, "down");
      await session.waitFor("Herdr Alt+P returns arrows to Tree after click", selected, target => target?.kind === "block" && target.blockId === docs[1]!.id);
      await session.keys(panes.tree, "up");
      await session.waitFor("Tree returns again", selected, target => target?.kind === "block" && target.blockId === docs[0]!.id);
      await session.keys(panes.tree, "alt+p");
      await session.waitVisible(panes.tree, "● Preview");
      await session.record(`${placement}-alt-p-round-trip`, {frame: await terminal.visible(), context: await context(), rawReturnKey: "ESC+p"});
      const treeRows = (await terminal.visible()).split("\n");
      const treeRow = treeRows.findIndex(line => line.includes("FOCUS FIRST") && /[•▸▾]/.test(line) && !line.includes("Preview"));
      assert.ok(treeRow >= 0, "Tree row must be visible for a native click");
      const treeColumn = visibleWidth(treeRows[treeRow]!.slice(0, treeRows[treeRow]!.indexOf("FOCUS FIRST"))) + 2;
      await click(treeColumn, treeRow);
      await session.waitVisible(panes.tree, "○ Preview");
      await session.keys(panes.tree, "down");
      await session.waitFor("Tree Down selects next sibling after click", selected, target => target?.kind === "block" && target.blockId === docs[1]!.id);
      await session.keys(panes.tree, "up");
      await session.waitFor("Tree Up selects previous sibling after click", selected, target => target?.kind === "block" && target.blockId === docs[0]!.id);
      await session.record(`${placement}-click-focus`, {before, after: await context(), previewPoint: {column, row}, treePoint: {column: treeColumn, row: treeRow}, initial, scrolled, restored: await terminal.visible()});
      await session.checkpoint(`${placement}-preview-scroll-tree-navigation`);
    }
    for (const doc of docs) assert.equal((await session.client.request<Block>({action: "get", blockId: doc.id})).text, doc.text);
  },
});
console.log(JSON.stringify(result, null, 2));
if (result.status !== "passed") process.exitCode = 1;
