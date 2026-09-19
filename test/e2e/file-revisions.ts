import assert from "node:assert/strict";
import { readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InternResourceReceipt, ResourceDescription } from "../../src/types";
import { runHerdrScenario } from "./herdr-runner";

const STAMP = 1_700_000_000;
const result = await runHerdrScenario({
  name: "file-revisions",
  async prepare(root) {
    const path = join(root, "file-conflict.txt");
    writeFileSync(path, "ORIGINAL");
    utimesSync(path, STAMP, STAMP);
  },
  async run(session) {
    const terminal = await session.attachClient();
    const path = join(session.projectRoot, "file-conflict.txt");
    const { resource } = await session.client.request<InternResourceReceipt>({
      action: "resources.intern-filesystem", input: { path: "file-conflict.txt", mediaType: "text/plain" },
    });
    const clients = await session.registrations();
    const tree = clients.find(c => c.role === "tree" && c.runtime?.paneId === session.panes.tree);
    const detail = clients.find(c => c.role === "detail" && c.runtime?.paneId === session.panes.detail);
    assert.ok(tree && detail);
    await session.client.request({
      action: "navigation.dispatch", sourceClientId: tree.clientId,
      target: { kind: "resource", resourceId: resource.id }, intent: "open",
    });
    await session.waitVisible(session.panes.detail, "ORIGINAL");
    const opened = await session.client.request<ResourceDescription>({ action: "resources.describe", destinationClientId: detail.clientId, target: { kind: "resource", resourceId: resource.id } });
    assert.ok(opened.filesystem);
    const before = statSync(path, { bigint: true });
    await session.focus(session.panes.detail);
    await session.keys(session.panes.detail, "e");
    await session.waitVisible(session.panes.detail, "Locked for editing filesystem Resource");
    await session.text(session.panes.detail, " LOCAL-DRAFT");
    await session.waitVisible(session.panes.detail, "ORIGINAL LOCAL-DRAFT");
    await session.checkpoint("01-open-filesystem-draft");

    // This fixture owns the file; a second writer changes it without a service mutation.
    writeFileSync(path, "REPLACED");
    utimesSync(path, STAMP, STAMP);
    const replaced = statSync(path, { bigint: true });
    assert.equal(replaced.size, before.size);
    assert.equal(replaced.mtimeNs, before.mtimeNs);
    await terminal.write("\u0013");
    await session.waitVisible(session.panes.detail, "Filesystem Resource changed after the edit began");
    await session.waitVisible(session.panes.detail, "ORIGINAL LOCAL-DRAFT");
    assert.equal(readFileSync(path, "utf8"), "REPLACED");
    await assert.rejects(session.client.request({
      action: "resources.describe", destinationClientId: detail.clientId, target: { kind: "resource", resourceId: resource.id, revision: opened.filesystem.revision },
    }), /Filesystem Resource revision is unavailable/);
    const current = await session.client.request<ResourceDescription>({ action: "resources.describe", destinationClientId: detail.clientId, target: { kind: "resource", resourceId: resource.id } });
    assert.ok(current.filesystem);
    assert.notDeepEqual(current.filesystem.revision, opened.filesystem.revision);
    await session.record("same-metadata-conflict", {
      opened: opened.filesystem, current: current.filesystem,
      size: before.size.toString(), mtimeNs: before.mtimeNs.toString(), draftPreserved: true,
    });
    await session.checkpoint("02-stale-file-save-rejected");

    await terminal.write("\u001b");
    await session.waitVisible(session.panes.detail, "Edit cancelled");
    await session.waitFor("cancel returned focus to Tree", () => session.registrations(), registrations =>
      registrations.some(c => c.clientId === tree.clientId && c.runtime?.focused === true));
    await session.focus(session.panes.detail);
    await session.waitFor("Detail focus after cancellation", () => session.registrations(), registrations =>
      registrations.some(c => c.clientId === detail.clientId && c.runtime?.focused === true));
    await session.keys(session.panes.detail, "r");
    await session.waitVisible(session.panes.detail, "REPLACED");
    await session.checkpoint("03-explicit-cancel-and-refresh");
    await session.keys(session.panes.detail, "e");
    await session.waitVisible(session.panes.detail, "Locked for editing filesystem Resource");
    await session.text(session.panes.detail, " AFTER-RELOAD");
    await session.waitVisible(session.panes.detail, "REPLACED AFTER-RELOAD");
    await terminal.write("\u0013");
    await session.waitFor("fresh file save", () => readFileSync(path, "utf8"), text => text === "REPLACED AFTER-RELOAD");
    await session.waitFor("Detail returned to the saved preview", () => session.visible(session.panes.detail), frame =>
      frame.includes("REPLACED AFTER-RELOAD") && frame.includes("e edit") && !frame.includes("⌃S save"));
    await session.record("fresh-file-save", { text: readFileSync(path, "utf8") });
    await session.checkpoint("04-fresh-file-save-accepted");
  },
});
process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.status === "failed") process.exitCode = 1;
