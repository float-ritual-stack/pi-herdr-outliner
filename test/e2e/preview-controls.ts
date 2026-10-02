import assert from "node:assert/strict";
import {visibleWidth} from "@earendil-works/pi-tui";
import type {Block, BrowsingContextState} from "../../src/types";
import {runHerdrScenario} from "./herdr-runner";

const result = await runHerdrScenario({
  name: "preview-controls",
  // Grow and Show/Hide Preview are menu actions; this journey pins them so every control is one click.
  uiConfig: {bar: {
    tree: ["tree.menu.note", "tree.menu.view", "tree.preview.toggle"],
    preview: ["tree.preview.right", "tree.preview.bottom", "tree.preview.auto", "tree.preview.close", "tree.preview.grow"],
  }},
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
    for (const [placement, columns] of [["beside", 170], ["below", 100]] as const) {
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
      const ready = await session.waitFor("native Preview coordinates", async () => ({frame:await terminal.visible(),currentOffset:headerOffset(await session.visible(panes.tree))}), ({frame,currentOffset}) => {
        const lines = frame.split("\n");
        const headingRow = lines.findIndex(line => /[●○] Preview · FOCUS FIRST/.test(line));
        const contentRow = lines.findIndex((line, index) => index > headingRow && line.includes("PREVIEW ROW 01") && !line.includes("↵"));
        const actualOffset = headerOffset(frame);
        return lines.some(line=>line.includes("┌ Outliner") && line.trimEnd().endsWith("┐")) && headingRow >= 0 && contentRow > headingRow && !!currentOffset && actualOffset?.row === currentOffset.row && actualOffset.column === currentOffset.column;
      });
      const initial = ready.frame;
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
    await terminal.resize(170, 74);
    await session.revealTree(panes.tree, docs[0]!.id);
    await session.waitFor("Auto docks right after the resize", () => session.visible(panes.tree), frame => frame.split("\n")[0]!.includes("Preview ·"));
    // The attached screen can lag the pane; act only once both show the label at the same place.
    const settledLabel = async (label: string) => {
      const position = (frame:string) => {
        const lines=frame.split('\n'), row=lines.findIndex(line=>line.includes(label));
        const origin=lines.findIndex(line=>/[●○] Tree/.test(line));
        if(row<0||origin<0)return null;
        const column=visibleWidth(lines[row]!.slice(0,lines[row]!.indexOf(label)));
        const left=visibleWidth(lines[origin]!.slice(0,lines[origin]!.search(/[●○] Tree/)));
        return {row,column,relativeRow:row-origin,relativeColumn:column-left};
      };
      const ready=await session.waitFor(`native ${label}`,async()=>({native:position(await terminal.visible()),pane:position(await session.visible(panes.tree))}),value=>!!value.native&&!!value.pane&&value.native.relativeRow===value.pane.relativeRow&&value.native.relativeColumn===value.pane.relativeColumn);
      return ready.native!;
    };
    const clickLabel = async (label: string) => {
      const point = await settledLabel(label);
      await click(point.column+1,point.row);
    };
    await clickLabel('[▄]');
    await session.waitFor('explicit bottom', () => session.visible(panes.tree), frame => frame.split('\n').findIndex(line=>line.includes('Preview ·')) > 8);
    await clickLabel('[▐]');
    await session.waitFor('explicit right', () => session.visible(panes.tree), frame => frame.split('\n').findIndex(line=>line.includes('Preview ·')) < 3);
    const beforeResize = await session.visible(panes.tree);
    await clickLabel('[+]');
    const grown = await session.waitFor('grow changes divider', () => session.visible(panes.tree), frame => frame.indexOf('Preview ·') !== beforeResize.indexOf('Preview ·'));
    // Drag the native divider; coordinate offsets come from the attached screen.
    const preview = await settledLabel('Preview · FOCUS');
    const header = preview.row;
    const dividerColumn = preview.column - 3;
    await terminal.write(`\x1b[<0;${dividerColumn+1};${header+5}M\x1b[<32;${dividerColumn+7};${header+5}M\x1b[<0;${dividerColumn+7};${header+5}m`);
    await session.waitFor('drag changes divider', () => session.visible(panes.tree), frame => frame.indexOf('Preview ·') !== grown.indexOf('Preview ·'));
    await session.checkpoint('mouse-dock-grow-drag');
    await clickLabel('[×]');
    await session.waitVisible(panes.tree,'Show Preview');
    await session.keys(panes.tree,'down');
    assert.ok(!(await session.visible(panes.tree)).includes('○ Preview ·'));
    await clickLabel('[Show Preview]');
    await session.waitVisible(panes.tree,'Preview · FOCUS SECOND');
    await session.checkpoint('hidden-through-navigation-and-restored');
    for (const doc of docs) assert.equal((await session.client.request<Block>({action: "get", blockId: doc.id})).text, doc.text);
  },
});
console.log(JSON.stringify(result, null, 2));
if (result.status !== "passed") process.exitCode = 1;
