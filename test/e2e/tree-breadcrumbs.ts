import assert from "node:assert/strict";
import {visibleWidth} from "@earendil-works/pi-tui";
import type {Block} from "../../src/types";
import {runHerdrScenario} from "./herdr-runner";

const result=await runHerdrScenario({
  name:"tree-breadcrumbs",layout:process.argv.includes("--composed") ? "composed" : "separate",
  async prepare(){},
  async run(s){
    const terminal=await s.attachClient();await terminal.resize(process.argv.includes("--composed") ? 320 : 130,process.argv.includes("--composed") ? 16 : 30);
    const tree=s.panes.tree;
    const create=(text:string,parentId:string|null=null)=>s.client.request<Block>({action:"create",text,parentId});
    const source=await create("304 canonical storage");
    const query=await create("304 Nested query\n[type::virtual-branch] [query::fixture=deep] [fixture::query]",source.id);
    let ancestor=await create("304 Path 0");
    for(let i=1;i<=12;i++) ancestor=await create(`304 Path ${i}`,ancestor.id);
    const hub=await create("304 Displayed hub\n[type::virtual-branch] [query::fixture=query]",ancestor.id);
    const top=await create("304 Deep root\n[fixture::deep]");
    let parent=top;
    for(let i=1;i<=2;i++) parent=await create(`304 Level ${i} readable title`,parent.id);
    await s.setKeybindings({"tree.root.focus":["Alt+F"],"tree.breadcrumb.left":["Alt+J"],"tree.breadcrumb.right":["Alt+K"]});
    await s.keys(tree,"ctrl+r");await s.waitVisible(tree,"Keymap and bars reloaded");
    await s.revealTree(tree,hub.id);
    // Follow the displayed query occurrence, not its physical storage parent.
    for(let i=0;i<4;i++) await s.keys(tree,"down");
    await s.waitVisible(tree,"304 Level 2 readable");
    await s.checkpoint("01-deep-projection-reclaims-indentation");
    const deep=await s.visible(tree);
    assert.ok(!deep.includes("304 canonical storage"));
    // Scroll the sticky strip to its ancestry; it must leave the selected leaf alone.
    for(let i=0;i<22;i++) await s.keys(tree,"alt+j");
    await s.waitVisible(tree,"⌂ < 304 Path 0");
    for(let i=0;i<13;i++) await s.keys(tree,"alt+k");
    await s.waitVisible(tree,"⌂ < 304 Displayed hub");
    await s.checkpoint("02-strip-scroll-keeps-leaf");
    const read=await terminal.visible();
    const lines=read.split("\n");
    const row=lines.findIndex(line=>line.includes("⌂ < 304 Displayed hub"));
    assert.ok(row>=0);
    const column=visibleWidth(lines[row]!.slice(0,lines[row]!.indexOf("304 Displayed hub")));
    await s.record("native-ancestor-click",{row,column,frame:read});
    await terminal.write(`\x1b[<0;${column+1};${row+1}M\x1b[<0;${column+1};${row+1}m`);
    await s.waitVisible(tree,"Focused branch: 304 Displayed hub");
    await s.keys(tree,"alt+left");
    await s.waitVisible(tree,"304 Level 2 readable");
    await s.checkpoint("03-ancestor-click-back-restores-leaf");
    await terminal.resize(process.argv.includes("--composed") ? 220 : 100,process.argv.includes("--composed") ? 16 : 26);
    await s.waitVisible(tree,"304 Level 2 readable");
    await s.checkpoint("04-narrow-reflow");
    const resizedLines=(await terminal.visible()).split("\n");
    const stripRow=resizedLines.findIndex(line=>line.includes("⌂ <"));
    assert.ok(stripRow>=0);
    const leftColumn=visibleWidth(resizedLines[stripRow]!.slice(0,resizedLines[stripRow]!.indexOf("⌂ <")))+2;
    await terminal.write(`\x1b[<0;${leftColumn+1};${stripRow+1}M\x1b[<0;${leftColumn+1};${stripRow+1}m`);
    await s.waitVisible(tree,"⌂ < ◇ 304 Level 1");
    await s.checkpoint("05-resized-strip-pointer");
    assert.equal((await s.client.request<Block>({action:"get",blockId:query.id})).parentId,source.id);
  }
});
console.log(JSON.stringify(result));if(result.status!=="passed")process.exitCode=1;
