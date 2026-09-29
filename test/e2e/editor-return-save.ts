import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {join} from "node:path";
import type {Block} from "../../src/types";
import type {EditRecovery} from "../../src/edit-recovery";
import {runHerdrScenario} from "./herdr-runner";

// PIE-365 field incident (September 24): Neovim `:w`, then `:w <other file>`, then quit.
// Returning from the editor imports the writing into an unsaved Detail draft; it is not
// a save. Check that the draft is visibly unsaved, that leaving it keeps the writing
// reachable, and that one save commits exactly the returned text.
const nvim=Bun.which("nvim");if(!nvim)throw Error("Neovim is required for the editor return journey");
const result=await runHerdrScenario({name:"editor-return-save",editor:`${nvim} --clean`,async prepare(){},async run(s){
  const terminal=await s.attachClient();await terminal.resize(160,50);
  const note=await s.client.request<Block>({action:"create",text:"EVENING PLACEHOLDER\n\nplaceholder"});
  await s.revealTree(s.panes.tree,note.id);await s.keys(s.panes.tree,"alt+enter");
  await s.waitVisible(s.panes.detail,"placeholder");await s.focus(s.panes.detail);
  await s.keys(s.panes.detail,"ctrl+e");await s.waitVisible(s.panes.detail,"draft.md");
  const copy=join(s.projectRoot,"second-copy.md");
  // Replace the placeholder line, write, write a second named copy, then quit.
  await terminal.write(`Gccvalidation notes: lantern route checked 日本語\x1b:w\r:w ${copy}\r:q\r`);
  const imported=await s.waitFor("editor return imported",()=>s.visible(s.panes.detail),f=>f.includes("lantern route checked"));
  await s.checkpoint("01-returned-draft");
  const status=await s.waitFor("unsaved status",()=>s.visible(s.panes.detail),f=>f.includes("Ctrl+S saves"));
  assert.equal((await s.client.request<Block>({action:"get",blockId:note.id})).text,note.text,"Editor return alone does not save");
  assert.equal(await readFile(copy,"utf8"),"EVENING PLACEHOLDER\n\nvalidation notes: lantern route checked 日本語\n");
  // `?` in the draft is text, not the reading menu; remove it again.
  await s.keys(s.panes.detail,"?");
  await s.waitFor("? typed into the draft",()=>s.visible(s.panes.detail),f=>/validation \?/u.test(f)&&!f.includes("Find:"));
  await s.keys(s.panes.detail,"backspace");
  await s.waitFor("? removed",()=>s.visible(s.panes.detail),f=>!/validation \?/u.test(f));
  await s.checkpoint("02-question-mark-is-text");
  // Escape leaves editing without saving; the returned writing must stay reachable.
  await s.keys(s.panes.detail,"escape");
  const left=await s.waitFor("left editing",()=>s.visible(s.panes.detail),f=>f.includes("Writing retained · Alt+R")&&f.includes("placeholder"));
  await s.checkpoint("03-after-escape");
  assert.equal((await s.client.request<Block>({action:"get",blockId:note.id})).text,note.text);
  const retained=await s.client.request<EditRecovery[]>({action:"edit-recovery.list",blockId:note.id});
  assert.ok(retained.some(r=>r.draftText.includes("lantern route checked 日本語")),"Escape retains the returned writing");
  // The actions menu reaches Writing history too; close it again without choosing.
  await s.keys(s.panes.detail,"?");await s.text(s.panes.detail,"Writing history");await s.keys(s.panes.detail,"enter");
  await s.waitFor("menu opens Writing history",()=>s.visible(s.panes.detail),f=>f.includes("Recoverable writing")&&f.includes("lantern route checked"));
  await s.keys(s.panes.detail,"escape");
  await s.waitFor("history closed",()=>s.visible(s.panes.detail),f=>!f.includes("Recoverable writing"));
  // Writing history (Alt+R) shows it; choose the draft action with the mouse, then save once.
  await s.keys(s.panes.detail,"alt+r");
  const review=await s.waitFor("history shows the writing",()=>s.visible(s.panes.detail),f=>f.includes("lantern route checked")&&/Edit draft|Restore draft/.test(f));
  await s.checkpoint("04-history-shows-writing");
  const label=review.includes("Edit draft")?"Edit draft":"Restore draft";
  const frame=await s.waitFor("attached history",terminal.visible,f=>f.includes(label));
  const rows=frame.split("\n"),row=rows.findIndex(l=>l.includes(label)),column=rows[row]!.indexOf(label)+2;
  await terminal.write(`\x1b[<0;${column};${row+1}M\x1b[<0;${column};${row+1}m`);
  await s.waitFor("draft editable again",()=>s.visible(s.panes.detail),f=>f.includes("⌃S save")&&f.includes("lantern route checked"));
  await s.keys(s.panes.detail,"ctrl+s");
  const saved=await s.waitFor("one save commits the returned writing",()=>s.client.request<Block>({action:"get",blockId:note.id}),b=>b.revision>note.revision);
  assert.equal(saved.text,"EVENING PLACEHOLDER\n\nvalidation notes: lantern route checked 日本語\n");
  await s.checkpoint("05-saved");
  await s.record("editor-return-evidence",{
    returnedStatus:status.split("\n").find(l=>l.includes("Ctrl+S saves"))?.trim(),
    importedVisible:imported.includes("lantern route checked"),
    canonicalUnchangedAfterReturn:true,
    secondNamedWriteIsSeparateFile:copy,
    questionMarkInDraftIsText:true,
    afterEscape:left.split("\n").find(l=>l.includes("Writing retained"))?.trim(),
    historyAction:label,
    savedRevision:saved.revision,
    input:"real Neovim in a private Herdr pane; injected keys; attached-terminal mouse click on the history action",
  });
}});console.log(JSON.stringify(result));if(result.status!=="passed")process.exitCode=1;
