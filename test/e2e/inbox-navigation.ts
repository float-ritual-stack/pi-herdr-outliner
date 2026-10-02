import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { OutlinerClient } from "../../src/client";
import { OutlinerServer } from "../../src/server";
import { OutlinerStore } from "../../src/store";
import type { InboxStatus } from "../../src/inbox-types";
import type { CaptureReceipt } from "../../src/types";
import { runHerdrScenario } from "./herdr-runner";

let failedSourceId = "";
const result = await runHerdrScenario({
  name: "inbox-navigation",
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
        requestId: "attention-failure", source: "cli", text: "PIE301 unresolved capture\nKeep this original note." });
      failedSourceId = failed.block.id;
      server.enableInbox(async ({ source }) => {
        if (source.id === failedSourceId) throw Object.assign(new Error("Choose a valid task destination"), { name: "InboxNoteError" });
        return { plan: {
          summary: "Filed fixture note", source: { text: source.text, disposition: "file" },
          notes: [], tasks: [], updates: [],
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
    const terminal = await session.attachClient();
    const pane = session.panes.tree;
    const detail = (await session.registrations()).find(client => client.runtime?.paneId === session.panes.detail && client.role === "detail")!;
    assert.ok(detail);
    assert.notDeepEqual(detail.currentTarget, {kind: "block", blockId: failedSourceId});
    const recent = await session.client.request<InboxStatus>({ action: "inbox.status" });
    assert.equal(recent.attentionCount, 1);
    assert.equal(recent.results.length, 30);
    assert.ok(recent.results.every(result => result.state === "applied"));
    const older = await session.client.request<InboxStatus>({action: "inbox.status", resultsOffset: 30});
    const attention = await session.client.request<InboxStatus>({ action: "inbox.status", attentionOnly: true });
    assert.equal(attention.results[0]!.sourceId, failedSourceId);
    await session.keys(pane, "I");
    await session.waitVisible(pane, "Needs attention: 1");
    await session.waitVisible(pane, "failed · PIE301 unresolved capture");
    await session.waitVisible(pane, "Choose a valid task destination");
    await session.waitVisible(pane, "a show recent results");
    await session.checkpoint("01-older-failure-visible-on-open");
    await session.keys(pane, "a");
    await session.waitVisible(pane, "Recent results: 1–30");
    await session.waitVisible(pane, "a needs attention (1)");
    await session.keys(pane, "right");
    await session.waitVisible(pane, "Recent results: 31–32");
    await session.keys(pane, "esc");
    await session.waitVisible(pane, "physical blocks");
    await session.keys(pane, "I");
    await session.waitVisible(pane, "Needs attention: 1 · Showing 1");
    await session.waitVisible(pane, "Choose a valid task destination");
    await session.checkpoint("02-reentry-returns-to-attention");
    // The displayed shortcut must follow user configuration.
    await session.keys(pane, "esc");
    await session.waitVisible(pane, "physical blocks");
    await session.setKeybindings({ "tree.inbox.attention": ["z"] });
    await session.keys(pane, "ctrl+r");
    await session.waitVisible(pane, "Keymap and bars reloaded");
    await session.keys(pane, "I");
    await session.waitVisible(pane, "z show recent results");
    await session.keys(pane, "z");
    await session.waitVisible(pane, "z needs attention (1)");
    await session.keys(pane, "z");
    await session.waitVisible(pane, "failed · PIE301 unresolved capture");
    await session.checkpoint("03-configured-shortcut");
    const tree=(await session.registrations()).find(c=>c.runtime?.paneId===pane&&c.role==='tree')!;
    await session.client.request({action:'navigation.link.set',source:{clientId:tree.clientId,region:'tree'},destination:null});
    await session.keys(pane,'alt+enter');await session.waitVisible(pane,'Find:');
    await session.keys(pane,'esc');await session.waitVisible(pane,'Inbox agent');
    // Pointer action uses the same chooser as Alt+L.
    await session.focus(pane);
    const frame=await session.waitFor('visible link action',terminal.visible,t=>t.includes('[Link destination]'));
    const rows=frame.split('\n'), row=rows.findIndex(l=>l.includes('[Link destination]'));
    const column=rows[row]!.indexOf('[Link destination]')+3;
    await terminal.write(`\x1b[<0;${column};${row+1}M\x1b[<0;${column};${row+1}m`);
    await session.waitVisible(pane,'Find:');await session.keys(pane,'esc');await session.waitVisible(pane,'Inbox agent');
    await session.keys(pane,'alt+l');await session.waitVisible(pane,'Find:');
    // Select the existing Detail by its title in the searchable destination menu.
    await session.text(pane,'Workspace');await session.keys(pane,'enter');
    await session.waitVisible(pane,'Inbox agent');
    await session.checkpoint('inbox-link-chooser-retains-result');
    await session.keys(pane, "alt+enter");
    await session.waitFor("Inbox source opens in linked Detail", session.registrations, clients =>
      clients.some(client => client.clientId === detail.clientId && client.currentTarget?.kind === "block" && client.currentTarget.blockId === failedSourceId));
    await session.waitVisible(session.panes.detail, "Keep this original note.");
    await session.checkpoint("04-inbox-source-opens-linked-detail");
    await session.focus(pane);await session.keys(pane,'esc');await session.waitVisible(pane,'physical blocks');
    assert.ok((await session.registrations()).some(c=>c.clientId===tree.clientId));
    await session.checkpoint('escape-restores-tree-without-closing-pane');
    assert.deepEqual((await session.client.request<InboxStatus>({action: "inbox.status"})).results, recent.results);
    assert.deepEqual((await session.client.request<InboxStatus>({action: "inbox.status", resultsOffset: 30})).results, older.results);
    const unchanged = await session.client.request<InboxStatus>({ action: "inbox.status", attentionOnly: true });
    assert.deepEqual(unchanged.results, attention.results);
    await session.record("inbox-attention-evidence", { failedSourceId, olderSuccesses: 31,
      opensOutstandingFailure: true, historyAndReentry: true, configuredKeyWorks: true, linkedDetailOpen: {clientId: detail.clientId, sourceId: failedSourceId}, receiptsUnchanged: true,
      boundary: "Real Herdr and service with synthetic model used only to seed historical receipts; no external inference." });
  },
});
console.log(JSON.stringify(result));
if (result.status !== "passed") process.exitCode = 1;
