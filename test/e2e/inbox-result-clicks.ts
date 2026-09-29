import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { OutlinerClient } from "../../src/client";
import { OutlinerServer } from "../../src/server";
import { OutlinerStore } from "../../src/store";
import type { InboxStatus } from "../../src/inbox-types";
import type { CaptureReceipt } from "../../src/types";
import { runHerdrScenario } from "./herdr-runner";

// PIE-314: a click on a result row in Needs attention or Recent results selects
// that result, shows its details, and the next result action applies to it.
// Up/Down keep working from the clicked row.
const failed: Record<string, string> = {};
const filed: Record<string, string> = {};
const result = await runHerdrScenario({
  name: "inbox-result-clicks",
  async prepare(projectRoot, paths) {
    // Real service and worker; the synthetic model only seeds receipts.
    await mkdir(paths.stateDir, { recursive: true });
    const store = new OutlinerStore(paths.database, { workspaceRoot: projectRoot });
    const server = new OutlinerServer(store, paths.socket);
    const client = new OutlinerClient(paths.socket);
    try {
      await server.start();
      for (const title of ["Harbor lantern failure", "Orchard gate failure"]) {
        const receipt = await client.request<CaptureReceipt>({ action: "capture.create", requestId: title, source: "cli", text: `${title}\nBody of ${title}.` });
        failed[title] = receipt.block.id;
      }
      for (const title of ["Meadow kettle note", "Quarry bell note", "Willow ferry note"]) {
        const receipt = await client.request<CaptureReceipt>({ action: "capture.create", requestId: title, source: "cli", text: `${title}\nBody of ${title}.` });
        filed[title] = receipt.block.id;
      }
      server.enableInbox(async ({ source }) => {
        if (Object.values(failed).includes(source.id)) throw Object.assign(new Error("Fixture needs a destination"), { name: "InboxNoteError" });
        return { plan: {
          summary: "Filed fixture note", source: { text: source.text, disposition: "file" },
          notes: [], tasks: [], updates: [],
        }, usage: { provider: "fixture", model: "fixture", inputTokens: 0, outputTokens: 0, cost: 0, jevCalls: 0, elapsedMs: 0 } };
      });
      for (let attempt = 0; ; attempt++) {
        const status = await client.request<InboxStatus>({ action: "inbox.status" });
        if (status.results.length === 5 && !status.current) break;
        if (attempt > 200) throw new Error("Inbox fixture did not finish");
        await Bun.sleep(50);
      }
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
    const click = async (label: string) => {
      const frame = await session.waitFor(`visible ${label}`, terminal.visible, text => text.includes(label));
      const rows = frame.split("\n"), row = rows.findIndex(line => line.includes(label));
      const column = rows[row]!.indexOf(label) + 3;
      await terminal.write(`\x1b[<0;${column};${row + 1}M\x1b[<0;${column};${row + 1}m`);
    };
    const selectedRow = (text: string) => text.split("\n").find(line => /› (failed|filed|applied|[a-z]+) · /.test(line)) ?? "";
    const waitSelected = (title: string) => session.waitFor(`${title} selected`, terminal.visible, text => selectedRow(text).includes(title));

    await session.keys(pane, "I");
    await session.waitVisible(pane, "Needs attention: 2");
    // Link the Inbox to the existing Detail so the source action has a destination.
    await session.keys(pane, "alt+l"); await session.waitVisible(pane, "Find:");
    await session.text(pane, "inbox-result-clicks"); await session.keys(pane, "enter");
    await session.waitVisible(pane, "Inbox agent");
    const initial = selectedRow(await terminal.visible());
    const firstAttention = initial.includes("Harbor lantern") ? "Harbor lantern failure" : "Orchard gate failure";
    const otherAttention = firstAttention === "Harbor lantern failure" ? "Orchard gate failure" : "Harbor lantern failure";
    await session.checkpoint("01-attention-initial-selection");

    // Needs attention: click the row that is not selected.
    await click(otherAttention);
    await waitSelected(otherAttention);
    const attentionFrame = await session.waitVisible(pane, `Body of`);
    await session.checkpoint("02-attention-row-clicked");
    // The following result action (open source in linked Detail) uses the clicked result.
    await session.keys(pane, "alt+enter");
    await session.waitFor("clicked attention source opens in Detail", session.registrations, clients =>
      clients.some(client => client.clientId === detail.clientId && client.currentTarget?.kind === "block" && client.currentTarget.blockId === failed[otherAttention]));
    await session.waitVisible(session.panes.detail, `Body of ${otherAttention}.`);
    await session.checkpoint("03-attention-action-on-clicked");
    await session.focus(pane);
    // Keyboard still works from the clicked row.
    await session.keys(pane, "up");
    await session.keys(pane, "down");
    await session.keys(pane, otherAttention === "Harbor lantern failure" ? "down" : "up");
    await waitSelected(firstAttention);
    await session.checkpoint("04-attention-keyboard-after-click");

    // Recent results.
    await session.keys(pane, "a");
    await session.waitVisible(pane, "Recent results: 1–5");
    const recentInitial = selectedRow(await terminal.visible());
    const target = recentInitial.includes("Quarry bell") ? "Meadow kettle note" : "Quarry bell note";
    await click(target);
    await waitSelected(target);
    await session.checkpoint("05-recent-row-clicked");
    await session.keys(pane, "alt+enter");
    await session.waitFor("clicked recent source opens in Detail", session.registrations, clients =>
      clients.some(client => client.clientId === detail.clientId && client.currentTarget?.kind === "block" && client.currentTarget.blockId === filed[target]));
    await session.waitVisible(session.panes.detail, `Body of ${target}.`);
    await session.checkpoint("06-recent-action-on-clicked");
    await session.focus(pane);
    const before = selectedRow(await terminal.visible());
    await session.keys(pane, "down");
    const moved = await session.waitFor("Down moves from clicked row", terminal.visible, text => selectedRow(text) !== before && selectedRow(text) !== "");
    await session.keys(pane, "up");
    await waitSelected(target);
    await session.checkpoint("07-recent-keyboard-after-click");
    await session.record("inbox-result-click-evidence", {
      attention: { clicked: otherAttention, openedInDetail: failed[otherAttention], keyboardReturnedTo: firstAttention },
      recent: { clicked: target, openedInDetail: filed[target], downMovedTo: selectedRow(moved).trim(), upReturnedTo: target },
      attentionFrameHasBody: attentionFrame.includes("Body of"),
      input: "attached-terminal SGR mouse clicks; injected Herdr keys",
      boundary: "Real Herdr and service; synthetic model only seeds receipts.",
    });
  },
});
console.log(JSON.stringify(result));
if (result.status !== "passed") process.exitCode = 1;
