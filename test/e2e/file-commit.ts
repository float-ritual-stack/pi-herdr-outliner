import assert from "node:assert/strict";
import {
  closeSync, fsyncSync, ftruncateSync, openSync, readFileSync, readdirSync,
  statSync, writeFileSync, writeSync,
} from "node:fs";
import { join } from "node:path";
import type { InternResourceReceipt } from "../../src/types";
import { runHerdrScenario } from "./herdr-runner";

const result = await runHerdrScenario({
  name: "file-commit",
  async prepare(root) {
    writeFileSync(join(root, "save.txt"), "ORIGINAL", { mode: 0o640 });
  },
  async run(session) {
    const terminal = await session.attachClient();
    const path = join(session.projectRoot, "save.txt");
    const { resource } = await session.client.request<InternResourceReceipt>({
      action: "resources.intern-filesystem", input: { path: "save.txt", mediaType: "text/plain" },
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
    await session.focus(session.panes.detail);
    await session.keys(session.panes.detail, "e");
    await session.waitVisible(session.panes.detail, "Locked for editing filesystem Resource");
    await session.text(session.panes.detail, " SAVED");
    await session.waitVisible(session.panes.detail, "ORIGINAL SAVED");
    await session.checkpoint("01-open-draft");

    // Another editor still holds the original inode when the user saves.
    const oldDescriptor = openSync(path, "r+");
    try {
      await terminal.write("\u0013");
      await session.waitFor("file save committed", () => readFileSync(path, "utf8"), text => text === "ORIGINAL SAVED");
      await session.waitFor("saved preview", () => session.visible(session.panes.detail), frame =>
        frame.includes("ORIGINAL SAVED") && frame.includes("e edit") && !frame.includes("⌃S save"));
      assert.equal(readFileSync(path, "utf8"), "ORIGINAL SAVED");
      assert.equal(statSync(path).mode & 0o777, 0o640);
      const directories = readdirSync(session.projectRoot).filter(name =>
        name.startsWith(".outliner-save-") && statSync(join(session.projectRoot, name)).isDirectory());
      assert.equal(directories.length, 1);
      const recovery = join(session.projectRoot, directories[0]!);
      assert.equal(readFileSync(join(recovery, "original"), "utf8"), "ORIGINAL");
      assert.equal(readFileSync(join(recovery, "draft"), "utf8"), "ORIGINAL SAVED");
      ftruncateSync(oldDescriptor, 0);
      writeSync(oldDescriptor, "LATE-EXTERNAL");
      fsyncSync(oldDescriptor);
      assert.equal(readFileSync(path, "utf8"), "ORIGINAL SAVED");
      assert.equal(readFileSync(join(recovery, "original"), "utf8"), "LATE-EXTERNAL");
      await session.record("saved-and-late-external-write", {
        resourceId: resource.id, source: readFileSync(path, "utf8"), recovery,
        lateExternal: readFileSync(join(recovery, "original"), "utf8"),
        submitted: readFileSync(join(recovery, "draft"), "utf8"), mode: "0640",
      });
      await session.checkpoint("02-save-and-late-writer-preserved");
    } finally { closeSync(oldDescriptor); }

    await session.focus(session.panes.detail);
    await session.keys(session.panes.detail, "e");
    await session.waitVisible(session.panes.detail, "Locked for editing filesystem Resource");
    await session.text(session.panes.detail, " SECOND-DRAFT");
    await session.waitVisible(session.panes.detail, "ORIGINAL SAVED SECOND-DRAFT");
    writeFileSync(path, "EXTERNAL-CURRENT");
    await terminal.write("\u0013");
    await session.waitVisible(session.panes.detail, "Filesystem Resource changed after the edit began");
    await session.waitVisible(session.panes.detail, "ORIGINAL SAVED SECOND-DRAFT");
    assert.equal(readFileSync(path, "utf8"), "EXTERNAL-CURRENT");
    await session.checkpoint("03-stale-draft-retained");
    await terminal.write("\u001b");
    await session.waitVisible(session.panes.detail, "Edit cancelled");
    await session.waitFor("cancel returned focus to Tree", () => session.registrations(), registrations =>
      registrations.some(c => c.clientId === tree.clientId && c.runtime?.focused));
    await session.focus(session.panes.detail);
    await session.keys(session.panes.detail, "r");
    await session.waitVisible(session.panes.detail, "EXTERNAL-CURRENT");
    await session.record("stale-save-cancelled", { current: readFileSync(path, "utf8"), draftWasPreserved: true });
    await session.checkpoint("04-refreshed-external-source");
  },
});
process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.status === "failed") process.exitCode = 1;
