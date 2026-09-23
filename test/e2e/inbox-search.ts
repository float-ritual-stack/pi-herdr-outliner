import { mkdir } from "node:fs/promises";
import { OutlinerClient } from "../../src/client";
import { OutlinerServer } from "../../src/server";
import { OutlinerStore } from "../../src/store";
import type { InboxStatus } from "../../src/inbox-types";
import type { CaptureReceipt } from "../../src/types";
import { runHerdrScenario } from "./herdr-runner";

let failedSourceId = "";
const result = await runHerdrScenario({
  name: "inbox-search",
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
        requestId: "attention-failure", source: "cli", text: "so what is stopping me from\nAn idea about interactive notes." });
      failedSourceId = failed.block.id;
      server.enableInbox(async ({ source }) => {

        return { plan: {
          summary: "Filed fixture note", source: { text: source.id === failedSourceId ? "Dynamically generated TUI views\n\n> [!summary] Authored interactive content\n> Queries can compose a useful interface." : source.text, disposition: "file" },
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
    await session.focus(pane);await session.keys(pane,'I');
    await session.waitVisible(pane,'Output 1 · current');
    const recent=await session.client.request<InboxStatus>({action:'inbox.status'});
    if(recent.results.some(result=>result.sourceId===failedSourceId))throw new Error('Special note must be outside first thirty receipts');
    const click=async(label:string)=>{
      const text=await session.waitFor(`mouse ${label}`,terminal.visible,value=>value.includes(label));
      const lines=text.split('\n');const row=lines.findIndex(line=>line.includes(label));const col=lines[row]!.indexOf(label);
      await terminal.write(`\x1b[<0;${col+1};${row+1}M\x1b[<0;${col+1};${row+1}m`);
    };
    const query=async(text:string)=>{await terminal.write(`\x1b[200~${text}\x1b[201~`);await session.waitVisible(pane,`Search: ${text}`);};
    await click('[Search /]');await query('what is stopping me');
    await session.waitVisible(pane,'so what is stopping');await session.waitVisible(pane,'Jev is not configured');
    await session.checkpoint('01-original-title-beyond-first-page');
    await click('[Source]');await session.waitVisible(pane,'Authored interactive content');
    await session.checkpoint('02-current-rich-source-from-original-title');
    // Escape restores recent history; query changes cannot leak into Tree filtering.
    await session.keys(pane,'esc');await session.waitVisible(pane,'Recent results:');
    await session.keys(pane,'/');await query('Dynamically generated TUI views');
    await session.waitVisible(pane,'so what is stopping');
    await session.keys(pane,'enter');await click('[Source]');
    await session.keys(pane,'alt+enter');await session.waitVisible(session.panes.detail,'Authored interactive content');
    await session.checkpoint('03-cleaned-title-and-explicit-linked-open');
    await session.focus(pane);await session.keys(pane,'esc');await session.waitVisible(pane,'Recent results:');
    await session.keys(pane,'/');await query('qqq-unmatchable-zzz');await session.waitVisible(pane,'No matching results');
    await session.checkpoint('04-empty-search');
    await click('[×]');await session.waitVisible(pane,'Recent results:');
    await session.keys(pane,'/');await query('filed note');await session.waitVisible(pane,'more matches omitted');
    await session.checkpoint('05-bounded-results');
    await session.keys(pane,'esc');await session.waitVisible(pane,'Recent results:');
    await session.keys(pane,'esc');await session.waitVisible(pane,'[Indent:');
    await session.record('search-contract',{wholeHistory:true,originalAndCleanedTitles:true,richSource:true,offlineFallback:true,mouseAndKeyboard:true,explicitOpen:true,emptyAndTruncated:true});
  },
});
console.log(JSON.stringify(result));
if(result.status!=='passed')process.exitCode=1;
