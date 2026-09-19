import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Block } from "../../src/types";
import { runHerdrScenario } from "./herdr-runner";

const renderer = process.argv.includes("--ansi") ? "ansi" : "pi-tui";
const title = "S5 service-owned reference";
const text = `${title} [file::authority.txt] [line-start::2] [line-end::2]`;
const selected = "SERVICE SELECTED LINE";
const result = await runHerdrScenario({
  name: `file-authority-${renderer}`,
  async prepare(root) {
    await writeFile(join(root, "authority.txt"), `SERVICE FIRST\n${selected}\nSERVICE LAST`);
    await writeFile(join(root, "server-only.txt"), "Service completion target");
  },
  async run(session) {
    await session.attachClient();
    const remote = await session.openRemoteBrowsingContext({ renderer });
    await writeFile(join(remote.workspaceRoot, "authority.txt"), "CLIENT FIRST\nCLIENT WRONG LINE\nCLIENT LAST");
    await writeFile(join(remote.workspaceRoot, "client-only.txt"), "Wrong completion target");
    const identities = () => ({
      sources: session.database.query("SELECT id FROM resource_sources ORDER BY id").all(),
      resources: session.database.query("SELECT id FROM resources ORDER BY id").all(),
    });
    const baseline = identities();
    const registrations = await session.registrations();
    const tree = registrations.find(c => c.runtime?.paneId === remote.tree && c.role === "tree");
    const detail = registrations.find(c => c.runtime?.paneId === remote.detail && c.role === "detail");
    assert.ok(tree && detail);
    await session.focus(remote.tree);
    await session.waitVisible(remote.tree, "Workspace");
    await session.keys(remote.tree, "a");
    await session.waitVisible(remote.tree, "↵ save");
    await session.text(remote.tree, "Completion [file::");
    await session.keys(remote.tree, "tab");
    const completion = await session.waitVisible(remote.tree, "server-only.txt");
    assert.ok(!completion.includes("client-only.txt"));
    await session.checkpoint("01-service-path-completion");
    await session.keys(remote.tree, "escape");
    await session.waitFor("Tree dismissed completion choices", () => session.visible(remote.tree), frame => !frame.includes("server-only.txt"));
    await session.keys(remote.tree, "escape");
    await session.waitFor("Tree cancelled completion draft", () => session.visible(remote.tree), frame => !frame.includes("↵ save"));
    assert.deepEqual(identities(), baseline);

    await session.keys(remote.tree, "a");
    await session.waitVisible(remote.tree, "↵ save");
    await session.text(remote.tree, text);
    await session.keys(remote.tree, "enter");
    await session.waitVisible(remote.tree, title);
    const rows = await session.waitFor("canonical file reference", () => session.database.query("SELECT id, text FROM blocks WHERE text = ?").all(text) as Array<{id: string; text: string}>, rows => rows.length === 1);
    const blockId = rows[0]!.id;
    const detailFrame = await session.waitVisible(remote.detail, selected);
    assert.ok(!detailFrame.includes("CLIENT WRONG LINE"));
    assert.ok(!detailFrame.includes("SERVICE FIRST"));
    assert.ok(!detailFrame.includes("SERVICE LAST"));
    assert.deepEqual(identities(), baseline);
    await session.checkpoint("02-passive-detail-service-bytes");

    await session.keys(remote.tree, "f");
    const treeFrame = await session.waitVisible(remote.tree, selected);
    assert.ok(!treeFrame.includes("CLIENT WRONG LINE"));
    assert.ok(!treeFrame.includes("SERVICE FIRST"));
    assert.ok(!treeFrame.includes("SERVICE LAST"));
    assert.deepEqual(identities(), baseline);
    await session.checkpoint("03-tree-service-bytes");
    await session.keys(remote.tree, "escape");
    await session.waitFor("Tree returned from file", () => session.visible(remote.tree), frame => frame.includes(title) && !frame.includes(selected));

    await session.focus(remote.detail);
    await session.keys(remote.detail, "b");
    await session.waitVisible(remote.detail, "e edit");
    await session.keys(remote.detail, "e");
    await session.waitVisible(remote.detail, "⌃S save");
    await session.text(remote.detail, " [file::serv");
    await session.keys(remote.detail, "tab");
    await session.waitVisible(remote.detail, "server-only.txt");
    await session.checkpoint("04-detail-service-path-completion");
    await session.keys(remote.detail, "escape");
    await session.waitFor("Detail dismissed completion choices", () => session.visible(remote.detail), frame => !frame.includes("server-only.txt"));
    await session.keys(remote.detail, "escape");
    await session.waitVisible(remote.detail, selected);
    assert.equal((await session.client.request<Block>({ action: "get", blockId })).text, text);
    assert.deepEqual(identities(), baseline);
    await session.waitFor("cancel returned focus to remote Tree", () => session.registrations(), clients =>
      clients.some(client => client.clientId === tree.clientId && client.runtime?.focused === true));
    await session.focus(remote.detail);
    await session.keys(remote.detail, "L");
    await session.waitFor("remote Detail unlocked", () => session.registrations(), clients =>
      clients.some(client => client.clientId === detail.clientId && client.locked === false));
    await session.record("passive-file-authority", { serviceRoot: session.projectRoot, clientRoot: remote.workspaceRoot, renderer, blockId, baseline, after: identities() });

    await session.focus(remote.tree);
    await session.keys(remote.tree, "?");
    await session.waitVisible(remote.tree, "Find:");
    await session.text(remote.tree, "Show authored links");
    await session.waitVisible(remote.tree, "Show or hide this block");
    await session.keys(remote.tree, "enter");
    await session.waitVisible(remote.tree, "Resource not registered");
    await session.keys(remote.tree, "down");
    await session.waitVisible(remote.tree, "1 authored Resources");
    await session.keys(remote.tree, "down");
    await session.waitVisible(remote.tree, "Enter creates the Resource");
    assert.deepEqual(identities(), baseline);
    await session.keys(remote.tree, "enter");
    await session.waitFor("explicit Resource creation", identities, ids => ids.resources.length === baseline.resources.length + 1);
    const resourceFrame = await session.waitVisible(remote.detail, selected);
    await session.waitVisible(remote.detail, "SERVICE FIRST");
    await session.waitVisible(remote.detail, "SERVICE LAST");
    assert.ok(!resourceFrame.includes("CLIENT WRONG LINE"));
    const current = await session.registrations();
    assert.equal(current.find(c => c.clientId === detail.clientId)?.currentTarget?.kind, "resource");
    await session.record("explicit-resource-activation", { catalog: identities(), detailClientId: detail.clientId });
    await session.checkpoint("05-resource-service-bytes");
  },
});
process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.status === "failed") process.exitCode = 1;
