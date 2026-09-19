import assert from "node:assert/strict";
import { join } from "node:path";
import type { Block, VisibleBlockCollection } from "../../src/types";
import { runHerdrScenario, type HerdrScenarioSession } from "./herdr-runner";

async function cliUpdate(session: HerdrScenarioSession, id: string, expected?: number) {
  const child = Bun.spawn([
    process.execPath, join(import.meta.dir, "../../src/cli.ts"), "update",
    "--id", id, "--text", "CLI-STALE-DRAFT",
    ...(expected === undefined ? [] : ["--expected", String(expected)]),
  ], {
    cwd: session.projectRoot,
    env: { ...process.env, OUTLINER_REMOTE: "1", OUTLINER_SOCKET_PATH: session.client.socketPath,
      OUTLINER_WORKSPACE_ROOT: session.projectRoot },
    stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10_000,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

const result = await runHerdrScenario({
  name: "edit-conflicts",
  async prepare() {},
  async run(session) {
    const terminal = await session.attachClient();
    await session.focus(session.panes.tree);
    await session.keys(session.panes.tree, "a");
    await session.waitVisible(session.panes.tree, "↵ save");
    await session.text(session.panes.tree, "S3-CONFLICT-TARGET");
    await session.waitVisible(session.panes.tree, "S3-CONFLICT-TARGET");
    await session.keys(session.panes.tree, "enter");
    const matches = await session.waitFor("Tree-authored conflict target", () =>
      session.client.request<VisibleBlockCollection>({
        action: "blocks.query", query: { text: "S3-CONFLICT-TARGET", limit: 2 },
      }), collection => collection.blocks.length === 1);
    assert.equal(matches.blocks.length, 1);
    const original = matches.blocks[0]!;
    const sibling = await session.client.request<Block>({
      action: "create", text: "S3-SIBLING", parentId: original.parentId, author: "user",
    });
    const read = () => session.client.request<Block>({ action: "get", blockId: original.id });
    await session.keys(session.panes.tree, "enter");
    await session.waitVisible(session.panes.detail, "S3-CONFLICT-TARGET");
    await session.focus(session.panes.detail);
    await session.keys(session.panes.detail, "e");
    await session.waitVisible(session.panes.detail, "Locked for editing");
    await session.text(session.panes.detail, " LOCAL-DRAFT");
    await session.waitVisible(session.panes.detail, "S3-CONFLICT-TARGET LOCAL-DRAFT");
    await session.checkpoint("01-open-detail-draft");

    const winner = await session.client.request<Block>({
      action: "update", blockId: original.id, text: "S3-REMOTE-WINNER",
      expectedRevision: original.revision, mutation: { author: "agent", actorId: "e2e-second-client" },
    });
    assert.equal(winner.revision, original.revision + 1);
    await terminal.write("\u0013");
    await session.waitVisible(session.panes.detail, "Block changed since editing began");
    await session.waitVisible(session.panes.detail, "S3-CONFLICT-TARGET LOCAL-DRAFT");
    assert.equal((await read()).text, "S3-REMOTE-WINNER");
    await session.record("stale-detail-save", { original, winner, draftPreserved: true });
    await session.checkpoint("02-stale-save-rejected-draft-retained");

    const unversioned = await cliUpdate(session, original.id);
    assert.equal(unversioned.exitCode, 1);
    assert.match(unversioned.stderr, /--expected must be the positive integer revision/);
    const stale = await cliUpdate(session, original.id, original.revision);
    assert.equal(stale.exitCode, 1);
    assert.match(stale.stderr, /Block changed since editing began/);
    assert.equal((await read()).text, "S3-REMOTE-WINNER");
    await session.record("cli-conflicts", { unversioned, stale });

    // Cancel is explicit; the rejected save must leave the draft available until then.
    await terminal.write("\u001b");
    await session.waitVisible(session.panes.detail, "S3-REMOTE-WINNER");
    await session.checkpoint("03-cancel-refreshes-newer-content");
    await session.focus(session.panes.detail);
    await session.keys(session.panes.detail, "e");
    await session.waitVisible(session.panes.detail, "Locked for editing");
    await session.text(session.panes.detail, " AFTER-REORDER");
    await session.waitVisible(session.panes.detail, "S3-REMOTE-WINNER AFTER-REORDER");
    await session.client.request({ action: "move", blockId: sibling.id, parentId: original.parentId, position: 0 });
    const afterMove = await read();
    assert.notEqual(afterMove.position, winner.position);
    assert.equal(afterMove.revision, winner.revision);
    await session.checkpoint("04-unchanged-draft-after-sibling-move");
    await terminal.write("\u0013");
    const saved = await session.waitFor("Detail save after sibling move", read,
      block => block.text === "S3-REMOTE-WINNER AFTER-REORDER");
    assert.equal(saved.revision, winner.revision + 1);
    await session.waitVisible(session.panes.detail, "S3-REMOTE-WINNER AFTER-REORDER");
    await session.record("reorder-save", { afterMove, saved });
    await session.checkpoint("05-reordered-draft-saved");
  },
});
process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.status === "failed") process.exitCode = 1;
