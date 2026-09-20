import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { OutlinerClient } from "../../src/client";
import { parsePropertyRecords } from "../../src/properties";
import type { Block, RoadmapItemCreateReceipt, VisibleBlockCollection } from "../../src/types";
import { runHerdrScenario } from "./herdr-runner";

const result = await runHerdrScenario({
  name: "roadmap-batches",
  async prepare(projectRoot) {
    for (const args of [["init", "-b", "main"], ["config", "user.name", "Batch fixture"],
      ["config", "user.email", "fixture@example.invalid"], ["commit", "--allow-empty", "-m", "Fixture"],
      ["remote", "add", "origin", "https://github.com/fixture/outliner-batch-test.git"]]) {
      const command = Bun.spawnSync(["git", ...args], { cwd: projectRoot });
      assert.equal(command.exitCode, 0, command.stderr.toString());
    }
  },
  async run(session) {
    const create = (text: string, parentId: string | null = null) => session.client.request<Block>({ action: "create", text, parentId });
    await session.client.request({ action: "work-ids.configure", prefix: "PIE" });
    const queue = await create("PIE-289 fixture queue [type::work-queue] [project::batch-fixture]");
    const batch = await create("PIE-289 agreed scope [type::work-batch] [project::batch-fixture]");
    const board = await create(`PIE-289 batch members [type::virtual-branch] [query::type=roadmap-item work-batch=${batch.id}] [summary-properties::work-stage,priority]`, batch.id);
    const input = { project: "batch-fixture", arc: "workflow", tracks: ["workflow"], priority: "high" as const };
    const items: Block[] = [];
    for (const title of ["First outcome", "Second outcome", "Third outcome"]) {
      items.push((await session.client.request<RoadmapItemCreateReceipt>({ action: "roadmap.items.create", input: { ...input, title, workBatchId: batch.id,
        ...(items.length === 2 ? { dependsOn: [items[1]!.id] } : {}) } })).block);
    }
    await session.client.request({ action: "virtual.occurrences.reorder", viewId: board.id, orderedBlockIds: items.map(item => item.id) });
    const followup = (await session.client.request<RoadmapItemCreateReceipt>({ action: "roadmap.items.create", input: { ...input, title: "Discovered future work" } })).block;
    const members = async (client = session.client) => client.request<VisibleBlockCollection>({ action: "blocks.query", query: { filters: [{ key: "work-batch", value: batch.id }], propertyScope: "block", limit: 10 } });
    const verifyMembers = async (client = session.client) => {
      const result = await members(client);
      assert.equal(result.completeness.kind, "complete");
      assert.deepEqual(result.blocks.map(block => block.id).sort(), items.map(block => block.id).sort());
      assert.ok(result.blocks.every(block => !block.properties.some(property => property.key === "status")));
    };
    const goto = async (pane: string, id: string) => {
      await session.keys(pane, "g");
      await session.waitVisible(pane, "Goto:");
      await session.text(pane, id);
      await session.waitVisible(pane, id.slice(0, 8));
      await session.keys(pane, "enter");
    };
    const stage = async (block: Block, value: string) => {
      const current = await session.client.request<Block>({ action: "get", blockId: block.id });
      const property = parsePropertyRecords(current.text).find(property => property.scope === "block" && property.key === "work-stage")!;
      await session.client.request({ action: "properties.patch", mutation: { author: "agent", actorId: "batch-harness" }, blockId: current.id, expectedRevision: current.revision, operations: [{ op: "replace", ordinal: property.ordinal, value }] });
      await verifyMembers();
    };
    const batchFrame = (pane: string, stages: string[]) => session.waitFor("batch occurrences show current stages", () => session.visible(pane), frame => {
      const start = frame.indexOf("PIE-289 batch members [V:3");
      const rows = start < 0 ? "" : frame.slice(start);
      return ["First outcome", "Second outcome", "Third outcome", ...stages].every(text => rows.includes(text));
    });
    await goto(session.panes.tree, board.id);
    await session.waitVisible(session.panes.tree, "batch members [V:3");
    await session.keys(session.panes.tree, "down", "down", "down");
    await batchFrame(session.panes.tree, ["queued"]);
    await session.checkpoint("01-committed-scope");
    const agentProcess = async (mode: string, sessionFile?: string) => {
      const process = Bun.spawn(["bun", fileURLToPath(new URL("./roadmap-agent-session.ts", import.meta.url)),
        mode, session.artifactDirectory, batch.id, items[0]!.id, items[1]!.id, ...(sessionFile ? [sessionFile] : [])], {
        cwd: session.projectRoot, env: { ...Bun.env, HERDR_ENV: "0", OUTLINER_REMOTE: "1",
          OUTLINER_SOCKET_PATH: session.client.socketPath, OUTLINER_WORKSPACE_ROOT: session.projectRoot,
          OUTLINER_CONFIG_PATH: `${session.artifactDirectory}/absent-client-config.json` }, stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
      await session.record(`pi-session-${mode}`, { stdout, stderr, code });
      assert.equal(code, 0, stderr);
      return JSON.parse(stdout.trim().split("\n").at(-1)!);
    };
    const started = await agentProcess("start");
    const resumed = await agentProcess("resume", started.sessionFile);
    assert.notEqual(started.pid, resumed.pid);
    assert.deepEqual(resumed.status, started.status);
    await verifyMembers();
    await session.waitVisible(session.panes.tree, "validate");
    await session.waitVisible(session.panes.tree, "review");
    await session.waitVisible(session.panes.tree, "queued");
    await batchFrame(session.panes.tree, ["review", "validate", "queued"]);
    await session.checkpoint("02-independent-stage-and-membership");
    const hub = await create(`PIE-289 batch overview\n\n!((${board.id}))`);
    await goto(session.panes.tree, hub.id);
    await session.keys(session.panes.tree, "enter");
    await session.waitVisible(session.panes.detail, "stage review");
    await session.waitVisible(session.panes.detail, "stage validate");
    await session.waitVisible(session.panes.detail, "stage queued");
    await session.checkpoint("02b-batch-overview-shows-next-actions");
    await goto(session.panes.tree, items[0]!.id);
    await session.keys(session.panes.tree, "enter");
    await session.waitVisible(session.panes.detail, "stage review");
    await session.checkpoint("03-detail-agrees");
    const retired = await create(`Retired contract [type::roadmap-item] [project::batch-fixture] [work-stage::superseded] [superseded-by::${items[0]!.id}]`, queue.id);
    const doneView = await create("PIE-289 accepted delivery [type::virtual-branch] [query::type=roadmap-item project=batch-fixture work-stage=done]");
    const current = await session.client.request<Block>({ action: "get", blockId: items[1]!.id });
    const proof = await create("PIE-289 fixture acceptance evidence", current.id);
    await session.client.request({ action: "properties.patch", mutation: { author: "agent", actorId: "batch-harness" }, blockId: current.id, expectedRevision: current.revision, operations: [{ op: "append", key: "proof", value: proof.id }] });
    await stage(items[1]!, "done");
    await goto(session.panes.tree, doneView.id);
    await session.waitVisible(session.panes.tree, "accepted delivery [V:1");
    assert.equal((await session.client.request<VisibleBlockCollection>({ action: "blocks.query", query: { filters: [{ key: "project", value: "batch-fixture" }, { key: "work-stage", value: "done" }], limit: 10 } })).blocks[0]!.id, items[1]!.id);
    const fresh = new OutlinerClient(session.client.socketPath);
    await verifyMembers(fresh);
    const remote = await session.openRemoteBrowsingContext();
    await goto(remote.tree, board.id);
    await session.keys(remote.tree, "down", "down", "down", "down", "down", "down");
    await batchFrame(remote.tree, ["review", "done", "queued"]);
    await session.checkpoint("04-fresh-reader-retains-scope");
    await assert.rejects(() => session.client.request({ action: "properties.patch", mutation: { author: "agent", actorId: "batch-harness" }, blockId: followup.id, expectedRevision: followup.revision, operations: [{ op: "append", key: "status", value: "planned" }] }), /work-stage/);
    await session.client.request({ action: "delete", blockId: board.id });
    await verifyMembers();
    await session.record("batch-contract", { batch: batch.id, members: items.map(item => item.id), followup: followup.id, superseded: retired.id, proof: proof.id, viewRemovalPreservedItems: true,
      evidence: "Actual Tree keyboard navigation and Detail rendering; real Pi SDK processes start tasks in a different order from authored rank and restore the same persisted binding and report. Stage advancement is production RPC fixture input, not a live PR/merge; third item depends on the second and remains queued. No model request is made. Service restart is covered by a focused regression." });
  },
});
console.log(JSON.stringify(result));
if (result.status === "failed") process.exitCode = 1;
