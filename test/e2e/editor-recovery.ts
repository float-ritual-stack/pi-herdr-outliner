import assert from "node:assert/strict";
import {visibleWidth} from "@earendil-works/pi-tui";
import type {Block} from "../../src/types";
import type {EditRecovery} from "../../src/edit-recovery";
import {runHerdrScenario} from "./herdr-runner";
const composed=process.argv.includes("--composed"),ansi=process.argv.includes("--ansi");
const nvim=Bun.which("nvim");if(!nvim)throw Error("Neovim is required for the editor recovery journey");
const result=await runHerdrScenario({name:`editor-recovery-${composed?"composed":ansi?"ansi":"pi"}`,layout:composed?"composed":"separate",detailRenderer:ansi?"ansi":"pi-tui",editor:`${nvim} --clean`,async prepare(){},async run(s){
  const terminal=await s.attachClient();await terminal.resize(160,55);
  const base=await s.client.request<Block>({action:"create",text:"RECOVERY JOURNEY\n\nOriginal paragraph\n\nEnding paragraph"});
  await s.revealTree(s.panes.tree,base.id);await s.keys(s.panes.tree,"enter");await s.waitVisible(s.panes.detail,"Original paragraph");await s.focus(s.panes.detail);
  await s.checkpoint("01-writing-before-editor");
  await s.keys(s.panes.detail,"ctrl+e");await s.waitVisible(s.panes.detail,"draft.md");
  const latest=await s.client.request<Block>({action:"update",blockId:base.id,text:base.text.replace("RECOVERY JOURNEY","RECOVERY JOURNEY [type::note]"),expectedRevision:base.revision,mutation:{author:"agent",actorId:"fixture-assistance"}});
  await terminal.write("GoLong returned writing 日本語 — preserved.\x1b:wq\r");
  await s.waitVisible(s.panes.detail,"Recoverable writing");await s.checkpoint("02-concurrent-metadata-review");
  assert.equal((await s.client.request<Block>({action:"get",blockId:base.id})).text,latest.text);
  const records=await s.client.request<EditRecovery[]>({action:"edit-recovery.list",blockId:base.id});
  assert.equal(records.length,1);assert.ok(records[0]!.originalDraft.includes("Long returned writing 日本語"));
  // Escape retains, and Alt+R opens the same durable record without saving.
  await s.keys(s.panes.detail,"escape");await s.waitVisible(s.panes.detail,"Writing retained");
  await s.keys(s.panes.detail,"alt+r");await s.waitVisible(s.panes.detail,"Recoverable writing");
  if(!ansi){
    const frame=await s.waitFor("attached recovery action",terminal.visible,text=>text.includes("Use proposal"));
    const lines=frame.split("\n"),row=lines.findIndex(line=>line.includes("Use proposal"));
    const column=visibleWidth(lines[row]!.slice(0,lines[row]!.indexOf("Use proposal")))+2;
    await terminal.write(`\x1b[<0;${column+1};${row+1}M\x1b[<0;${column+1};${row+1}m`);
  }else await s.keys(s.panes.detail,"tab","enter");
  await s.waitVisible(s.panes.detail,"Review recovered draft");
  await s.keys(s.panes.detail,"ctrl+s");
  await s.waitFor("both writers survive",()=>s.client.request<Block>({action:"get",blockId:base.id}),b=>b.text.includes("[type::note]")&&b.text.includes("Long returned writing 日本語"));
  await s.checkpoint("03-reviewed-merged-save");
  assert.equal((await s.client.request<EditRecovery[]>({action:"edit-recovery.list",blockId:base.id})).length,0);
}});console.log(JSON.stringify(result));if(result.status!=="passed")process.exitCode=1;
