import assert from "node:assert/strict";
import type { InboxStatus } from "../../src/inbox-types";
import type { Block, CaptureReceipt, RoadmapItemCreateReceipt } from "../../src/types";
import { runHerdrScenario } from "./herdr-runner";

// Explicitly opt in: unlike baseline journeys this spends real Pi/Jev inference.
const result = await runHerdrScenario({
  name: "inbox-agent", allowInboxAgent: true, allowJev: true,
  async prepare() {},
  async run(session) {
    const state = () => session.client.request<InboxStatus>({ action: "inbox.status" });
    await session.waitFor("configured Inbox agent", state, value => value.enabled, 20_000);
    const terminal = await session.attachClient();
    const pane = session.panes.tree;
    const closeInbox = async () => {
      await session.keys(pane, "esc");
      await session.waitFor("Tree returns after Escape", () => session.visible(pane), frame => !frame.includes("Inbox agent ·") && frame.includes("Outliner"));
    };
    const create = (text: string) => session.client.request<Block>({ action: "create", text });
    await session.client.request({ action: "work-ids.configure", prefix: "PIE" });
    await create("Inbox trial work queue [type::work-queue] [project::pi-outliner]");
    const task = await session.client.request<RoadmapItemCreateReceipt>({ action: "roadmap.items.create", input: {
      title: "Select several notes in Goto", body: "Space marks several Goto results; Enter opens each selected note once. Acceptance: marks survive cursor movement and each target opens once.",
      project: "pi-outliner", priority: "medium", arc: "navigation", tracks: ["interactive-documents"],
    } });
    const meeting = await create("Maya reading group\nMaya hosts on Fridays. Our previous book was Kindred; the next book has not been chosen.");
    const origin = await create("Inbox trial browsing context\nKeep browsing while the agent works.");
    await session.revealTree(pane, origin.id);
    await session.keys(pane, "I");
    await session.waitVisible(pane, "Inbox agent");
    await session.keys(pane, "p");
    await session.waitFor("keyboard Pause acknowledged", state, value => value.paused);
    await closeInbox();
    const old = await session.client.request<CaptureReceipt>({ action: "capture.create", requestId: "inbox-e2e-existing", source: "cli", text: "Library errand\nReturn The Left Hand of Darkness on Monday. This is a personal reminder, not a software task." });

    await session.focus(pane);
    await session.keys(pane, "c");
    await session.waitFor("Quick Capture opens", () => terminal.visible(), frame => frame.includes("Quick capture"));
    const text = "Weekend review\n[ctx::2026-09-20 @ 11:00 AM]\n\nShopping: oats, limes, coffee beans. Oh yes, the same list: oats, limes, coffee beans.\n\nFriday reading group with Maya: we agreed on The Dispossessed, chapters 1–3. Maya brings tea; I bring snacks.\n\nOutliner idea: use Space to mark several Goto results, Enter opens them once. I think this is already recorded; link the existing ticket instead of duplicating it.";
    await terminal.write(`\x1b[200~${text}\x1b[201~`);
    await terminal.write("\x13");
    await session.waitFor("Capture commits and closes", () => terminal.visible(), frame => !frame.includes("Quick capture"));
    const saved = session.database.query("SELECT id, text, parent_id FROM blocks WHERE text LIKE 'Weekend review%' AND effective_deleted_root_id IS NULL").get() as { id: string; text: string; parent_id: string };
    assert.ok(saved);
    assert.ok(saved.text.includes("coffee beans"));
    assert.equal((await state()).pending, 2);
    await session.keys(pane, "I");
    await session.waitVisible(pane, "2 pending");
    await session.keys(pane, "p");
    await session.waitFor("agent starts", state, value => value.state === "working");
    await session.checkpoint("01-captured-and-running");
    await closeInbox();
    await session.keys(pane, "down");
    // The user has left the result view. Work must still finish without an open observer.
    const finished = await session.waitFor("both notes automatically processed", state,
      value => value.results.length >= 2 && !value.current, 180_000);
    assert.ok(finished.results.every(value => value.state === "applied"), JSON.stringify(finished.results));
    assert.equal(finished.pending, 0);
    assert.ok(finished.results.every(value => value.usage && value.usage.inputTokens > 0));
    const shoppingResult = finished.results.find(value => value.sourceId === saved.id)!;
    const outputs = await Promise.all([...new Set([saved.id, ...shoppingResult.outputIds])].map(blockId => session.client.request<Block>({ action: "get", blockId })));
    const combined = outputs.map(value => value.text).join("\n");
    for (const phrase of ["oats", "limes", "coffee", "Dispossessed"]) assert.ok(combined.toLowerCase().includes(phrase.toLowerCase()), `Missing ${phrase}`);
    const taskNow = await session.client.request<Block>({ action: "get", blockId: task.block.id });
    assert.equal(taskNow.properties.find(value => value.key === "work-stage")?.value, "unprioritized");
    const count = session.database.query("SELECT COUNT(*) AS count FROM block_properties WHERE key = 'work-id'").get() as { count: number };
    assert.equal(count.count, 1, "The existing task should not be duplicated");
    await session.keys(pane, "I");
    await session.waitVisible(pane, "Weekend review");
    await session.waitVisible(pane, "applied");
    await session.checkpoint("02-return-to-real-results");
    // Event refresh preserves selection; locate the result by its rendered identity.
    if (!(await session.visible(pane)).includes("› applied · Weekend review")) await session.keys(pane, "up");
    await session.waitVisible(pane, "› applied · Weekend review");
    await session.keys(pane, "u");
    await session.waitFor("keyboard Undo restores source", state, value => value.results.find(item => item.id === shoppingResult.id)?.state === "undone");
    const restored = await session.client.request<Block>({ action: "get", blockId: saved.id });
    assert.equal(restored.text, saved.text);
    assert.equal(restored.parentId, saved.parent_id);
    assert.equal((await state()).pending, 0, "Undo must hold the restored note");
    await session.checkpoint("03-undone-without-auto-repeat");
    await session.keys(pane, "r");
    await session.text(pane, "Hold this capture for my decision about where these notes belong.");
    await session.keys(pane, "enter");
    const reconsidered = await session.waitFor("reconsidered note returns a decision", state,
      value => value.results.length === 3 && !value.current, 150_000);
    assert.equal(reconsidered.results[0]!.state, "held", JSON.stringify(reconsidered.results[0]));
    assert.equal(reconsidered.attentionCount, 1);
    await session.keys(pane, "a");
    await session.waitVisible(pane, "Needs attention: 1");
    await session.waitVisible(pane, "held · Weekend review");
    await session.checkpoint("04-directed-reconsideration");
    await session.keys(pane, "a");
    await session.waitVisible(pane, "Recent results: 1–3");
    await session.keys(pane, "p");
    await session.waitFor("final Pause acknowledged", state, value => value.paused);
    await session.record("inbox-evidence", {
      oldSource: old.block.id, capturedSource: saved.id, existingTask: task.block.id, meeting: meeting.id,
      results: reconsidered.results, outputs, originalRecovered: true, hiddenViewContinues: true,
      actualPiAndJev: true, evidence: "Private Herdr service and real keyboard capture, pause/resume, close/reopen, Undo, and directed reconsideration. Fixture metadata setup uses RPC; assertions use service reads and readonly SQLite. No model mocks.",
    });
  },
});
console.log(JSON.stringify(result));
if (result.status !== "passed") process.exitCode = 1;
