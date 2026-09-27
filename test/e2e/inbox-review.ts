import assert from 'node:assert/strict';
import {annotationSourceHash} from '../../src/annotations';
import {visibleWidth} from "@earendil-works/pi-tui";
import {readFile} from "node:fs/promises";
import {join} from "node:path";
import { mkdir } from "node:fs/promises";
import { OutlinerClient } from "../../src/client";
import { OutlinerServer } from "../../src/server";
import { OutlinerStore } from "../../src/store";
import type { InboxResultDetail, InboxStatus } from "../../src/inbox-types";
import type { AnnotationThread, CaptureReceipt } from "../../src/types";
import { runHerdrScenario } from "./herdr-runner";

let failedSourceId = "";
const result = await runHerdrScenario({
  name: "inbox-review",
  async prepare(projectRoot, paths) {
    // Seed historical receipts through the real service and worker. The synthetic
    // model provides deterministic fixture data; no claim about AI judgments.
    await mkdir(paths.stateDir, { recursive: true });
    const store = new OutlinerStore(paths.database, { workspaceRoot: projectRoot });
    const server = new OutlinerServer(store, paths.socket);
    const client = new OutlinerClient(paths.socket);
    try {
      await server.start();
      const failed = await client.request<CaptureReceipt>({ action: "capture.create",
        requestId: "attention-failure", source: "cli", text: "PIE301 unresolved capture\nKeep this original note.\n\n> [!summary] Source callout\n> Source preview wraps rich content." });
      failedSourceId = failed.block.id;
      server.enableInbox(async ({ source }) => {
        if (source.id === failedSourceId) throw Object.assign(new Error("Choose a valid task destination"), { name: "InboxNoteError" });
        return { plan: {
          summary: "Filed fixture note", source: { text: "Cleaned source after editorial pass\n\nCurrent wording.", disposition: "file" },
          notes: [{text:"Output one\n\n> [!summary] Output callout\n> This is rich output with wrapping.\n\n"+Array.from({length:50},(_,i)=>`Paragraph ${i} of the long note.`).join("\n\n")},{text:"Output two\n\nSecond output body"}], tasks: [], updates: [],
        }, usage: { provider: "fixture", model: "fixture", inputTokens: 0, outputTokens: 0, cost: 0, jevCalls: 3, jevSuccessfulCalls: 2, elapsedMs: 135000, notChecked:[{area:"relationships",reason:"Some comparisons were skipped for budget"}] } };
      });
      const waitCount = async (count: number) => {
        for (let attempt = 0; attempt < 200; attempt++) {
          const status = await client.request<InboxStatus>({ action: "inbox.status", resultsOffset: count > 30 ? 30 : 0 });
          if (status.results.length === (count > 30 ? count - 30 : count) && !status.current) return;
          await Bun.sleep(50);
        }
        throw new Error("Inbox fixture did not finish");
      };
      await waitCount(1);
      for (let index = 0; index < 31; index++) {
        await client.request({ action: "capture.create", requestId: "success-" + index, source: "cli", text: "PIE301 filed note " + index });
      }
      await waitCount(32);
    } finally {
      await server.close();
      store.close();
    }
  },
  async run(session) {
    const terminal=await session.attachClient();const pane=session.panes.tree;
    await session.focus(pane);await terminal.resize(300,100);
    const clickLabel=async(label:string)=>{
      const text=await session.waitFor(`native ${label}`,terminal.visible,value=>value.includes(label));
      const lines=text.split('\n');const row=lines.findIndex(line=>line.includes(label));const col=lines[row]!.indexOf(label)+1;
      await terminal.write(`\x1b[<0;${col+1};${row+1}M\x1b[<0;${col+1};${row+1}m`);
    };
    await session.keys(pane,'I');
    await session.waitVisible(pane,'Source · current');
    await session.waitVisible(pane,'Source callout');
    await session.checkpoint('01-source-rich-preview');
    await clickLabel('[Activity');await session.waitVisible(pane,'Needs attention: Choose a valid task destination');
    await clickLabel('[Source');await session.waitVisible(pane,'Source · current');
    await session.keys(pane,'a');await session.waitVisible(pane,'Output 1 · current');
    await session.waitVisible(pane,'Cleaned source after editorial pass');
    await clickLabel('[Before');await session.waitVisible(pane,'before this attempt');
    await session.waitVisible(pane,'PIE301 filed note');
    const recent=await session.client.request<InboxStatus>({action:'inbox.status'});
    const receipt=await session.client.request<InboxResultDetail>({action:'inbox.result',resultId:recent.results[0]!.id});
    assert.ok(receipt.beforeSource?.updatedAt);
    // Focus the saved Source reader and compose without a Detail destination.
    await session.keys(pane,'alt+p');
    await session.keys(pane,'c');
    await session.waitVisible(pane,'Comment on note');
    await session.text(pane,'FEEDBACK ON SAVED SOURCE');
    await session.waitVisible(pane,'FEEDBACK ON SAVED SOURCE');
    await clickLabel('[Current');
    await clickLabel('[Activity');
    await session.waitVisible(pane,'Comment draft retained');
    await session.waitVisible(pane,'FEEDBACK ON SAVED SOURCE');
    await session.keys(pane,'ctrl+s');
    const historical=await session.waitFor('saved-source comment persisted',()=>session.client.request<AnnotationThread[]>({
      action:'annotations.list',query:{subject:{kind:'block',blockId:receipt.sourceId},includeResolved:true},
    }),threads=>threads.some(thread=>thread.body==='FEEDBACK ON SAVED SOURCE'));
    const comment=historical.find(thread=>thread.body==='FEEDBACK ON SAVED SOURCE')!;
    assert.deepEqual(comment.originalTarget.representation.sourceSnapshot,{
      kind:'block',blockId:receipt.sourceId,inboxAttemptId:receipt.id,
      updatedAt:receipt.beforeSource.updatedAt,contentHash:annotationSourceHash(receipt.beforeSource.text),
    });
    await session.keys(pane,']');
    await session.waitVisible(pane,'FEEDBACK ON SAVED SOURCE');
    await session.checkpoint('historical-source-comment');

    await clickLabel('[Current');await session.waitVisible(pane,'Current wording.');
    const layout=await terminal.visible();const layoutRows=layout.split('\n');
    const sourceRow=layoutRows.findIndex(line=>line.includes('Source · current'));
    const outputRow=layoutRows.findIndex(line=>line.includes('Output 1 · current'));
    if(sourceRow!==outputRow||sourceRow<10)throw Error('Expected side-by-side documents beneath activity');
    await clickLabel('▸ Technical details');await session.waitVisible(pane,'▾ Technical details');
    await clickLabel('[Activity');await terminal.write('\x1b[6~');
    await session.waitVisible(pane,'fixture · fixture');
    await session.waitVisible(pane,'model work 135.0s');
    await terminal.write('\x1b[5~');
    await session.waitFor('native activity scroll restored',terminal.visible,text=>text.includes('│APPLIED ·'));
    await clickLabel('▾ Technical details');
    await session.waitFor('technical details collapse immediately',()=>session.visible(pane),text=>!text.includes('fixture · fixture'));
    await session.waitVisible(pane,'Not checked:');
    await session.waitVisible(pane,'Some comparisons were skipped for budget');
    await session.checkpoint('combined-activity-source-output');
    const dividerRow=layoutRows.findIndex(line=>line.includes('drag─to─resize'));
    if(dividerRow<0)throw Error('No draggable activity divider');
    const dividerCol=layoutRows[dividerRow]!.indexOf("drag─to─resize")+3;
    await terminal.write(`\x1b[<0;${dividerCol};${dividerRow+1}M\x1b[<32;${dividerCol};${dividerRow+5}M\x1b[<0;${dividerCol};${dividerRow+5}m`);
    await session.waitFor('activity divider changes reader height',terminal.visible,text=>text.split('\n').findIndex(line=>line.includes('Source · current'))>sourceRow);
    await session.checkpoint('resized-activity-height');
    const resized=await terminal.visible();const resizedRows=resized.split('\n');
    const readerRow=resizedRows.findIndex(line=>line.includes('Preview · Output'));
    const outputColumn=resizedRows[readerRow]!.indexOf('Preview · Output');
    const splitColumn=outputColumn-3;
    await terminal.write(`\x1b[<0;${splitColumn+1};${readerRow+4}M\x1b[<32;${splitColumn+10};${readerRow+4}M\x1b[<0;${splitColumn+10};${readerRow+4}m`);
    await session.waitFor('source/output divider changes reader widths',terminal.visible,text=>text.split('\n').some(line=>line.indexOf('Preview · Output')>outputColumn));
    await session.checkpoint('resized-document-widths');
    await session.waitVisible(pane,'Output callout');
    await clickLabel('[Output 2');await session.waitVisible(pane,'Output 2 · current');await session.waitVisible(pane,'Second output body');
    await clickLabel('[Source');await session.waitVisible(pane,'Source · current');
    await session.keys(pane,'2');await session.waitVisible(pane,'Output 1 · current');
    await session.checkpoint('02-role-switching');
    const copyFrame=await session.waitFor('native copy text',terminal.visible,text=>text.includes('Output callout'));
    const copyLines=copyFrame.split('\n');const copyRow=copyLines.findIndex(line=>line.includes('Output callout'));const copyCol=copyLines[copyRow]!.indexOf('Output callout');
    await terminal.write(`\x1b[<0;${copyCol+1};${copyRow+1}M\x1b[<32;${copyCol+15};${copyRow+1}M\x1b[<0;${copyCol+15};${copyRow+1}m`);
    await session.waitFor('native clipboard contains selected Preview text',()=>readFile(join(session.artifactDirectory,'attached-client.ansi'),'utf8'),text=>[...text.matchAll(/\x1b\]52;[^;]*;([A-Za-z0-9+/=]+)/g)].some(match=>Buffer.from(match[1]!,'base64').toString().includes('Output callout')));
    // Wheel inside the reader scrolls content without selecting another result.
    await terminal.write(`\x1b[<65;${copyCol+1};${copyRow+1}M`);
    await session.checkpoint('native-preview-copy-and-wheel');

    // Native content click must focus the rich reader, then Escape returns to the list.
    await session.keys(pane,'1');await session.keys(pane,'2');
    await clickLabel('Paragraph 0');await session.waitFor('Output owns keyboard focus',terminal.visible,text=>text.includes('● Preview · Output'));
    await session.keys(pane,'down');await session.keys(pane,'esc');await session.waitFor('reader releases focus',terminal.visible,text=>!text.includes('● Preview'));
    await session.keys(pane,'down');await session.waitVisible(pane,'filed note');
    await session.checkpoint('03-reader-focus-list-navigation');
    await terminal.resize(90,34);
    await session.waitFor('compact layout settles',()=>session.visible(pane),text=>text.includes('Inbox agent') && Math.max(...text.split('\n').map(visibleWidth))<80);
    await session.keys(pane,'alt+p');
    await session.checkpoint('04-narrow-preview');
    await session.keys(pane,'esc');
    await session.keys(pane,'alt+enter');
    await session.waitVisible(session.panes.detail,'Output callout');
    await session.checkpoint('05-explicit-open');
    await session.focus(pane);await terminal.resize(240,74);
    await session.waitVisible(pane,'Preview');
    if ((await session.visible(pane)).includes('● Preview')) {await session.keys(pane,'esc');await session.waitFor('reader releases focus',terminal.visible,text=>!text.includes('● Preview'));}
    await session.keys(pane,'esc');await session.waitVisible(pane,'Tree [Note] [View] [Links]');
    await session.record('preview-contract',{richSource:true,multipleOutputs:true,nativeRoleClicks:true,previewFocus:true,explicitOpen:true,fixtureModel:true});
  },
});
console.log(JSON.stringify(result));
if(result.status!=='passed')process.exitCode=1;
