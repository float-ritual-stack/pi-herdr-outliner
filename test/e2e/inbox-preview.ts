import {readFile} from "node:fs/promises";
import {join} from "node:path";
import { mkdir } from "node:fs/promises";
import { OutlinerClient } from "../../src/client";
import { OutlinerServer } from "../../src/server";
import { OutlinerStore } from "../../src/store";
import type { InboxStatus } from "../../src/inbox-types";
import type { CaptureReceipt } from "../../src/types";
import { runHerdrScenario } from "./herdr-runner";

let failedSourceId = "";
const result = await runHerdrScenario({
  name: "inbox-preview",
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
          summary: "Filed fixture note", source: { text: source.text, disposition: "file" },
          notes: [{text:"Output one\n\n> [!summary] Output callout\n> This is rich output with wrapping.\n\n"+Array.from({length:50},(_,i)=>`Paragraph ${i} of the long note.`).join("\n\n")},{text:"Output two\n\nSecond output body"}], tasks: [], updates: [],
        }, usage: { provider: "fixture", model: "fixture", inputTokens: 0, outputTokens: 0, cost: 0, jevCalls: 0, elapsedMs: 0 } };
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
    await session.focus(pane);
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
    await session.keys(pane,'down');await session.keys(pane,'esc');await session.waitFor('reader returned focus to list',()=>session.visible(pane),text=>text.includes('○ Preview') && !text.includes('● Preview'));
    await session.keys(pane,'down');await session.waitVisible(pane,'filed note 29');
    await session.checkpoint('03-reader-focus-list-navigation');
    await terminal.resize(160,60);
    await session.waitFor('compact geometry settled',()=>session.visible(pane),text=>text.includes('Inbox agent') && Math.max(...text.split('\n').map(line=>line.length))<80);
    await session.keys(pane,'alt+p');
    await session.waitFor('compact Preview focused',()=>session.visible(pane),text=>text.includes('● Preview'));
    await session.checkpoint('04-narrow-preview');
    await session.keys(pane,'esc');
    await session.keys(pane,'alt+enter');
    await session.waitVisible(session.panes.detail,'Output callout');
    await session.checkpoint('05-explicit-open');
    await session.focus(pane);await terminal.resize(240,74);
    await session.waitFor('wide geometry settled',()=>session.visible(pane),text=>text.includes('Preview') && Math.max(...text.split('\n').map(line=>line.length))>100);
    if ((await session.visible(pane)).includes('● Preview')) {await session.keys(pane,'esc');await session.waitFor('Preview focus released',()=>session.visible(pane),text=>text.includes('○ Preview') && !text.includes('● Preview'));}
    await session.keys(pane,'esc');await session.waitVisible(pane,'[Indent:');
    await session.record('preview-contract',{richSource:true,multipleOutputs:true,nativeRoleClicks:true,previewFocus:true,explicitOpen:true,fixtureModel:true});
  },
});
console.log(JSON.stringify(result));
if(result.status!=='passed')process.exitCode=1;
