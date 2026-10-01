// The extension kinds in a real Detail pane (PIE-507): handler lines drawn under their lines, `r`
// running them again, and a folder removed while Detail shows it. A private Herdr session and a
// scratch outline; every note is made up.
import assert from "node:assert/strict";
import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { runHerdrScenario } from "./herdr-runner";

let projectRoot = "";
const result = await runHerdrScenario({
  name: "extension-kinds",
  async prepare(root) {
    projectRoot = root;
    await mkdir(join(root, "extensions"), { recursive: true });
    for (const name of ["horoscope", "fancy-horror", "moon"]) {
      await cp(join(import.meta.dir, "../../extensions", name), join(root, "extensions", name), { recursive: true });
    }
  },
  async run(s) {
    const terminal = await s.attachClient();
    await terminal.resize(200, 60);
    const note: any = await s.client.request({
      action: "create",
      text: "Extension kinds tour\nhoroscope:: virgo\nfancy-horror:: virgo\nmoon:: 2026-10-26",
    });
    const clients = await s.registrations();
    const detail = clients.find((c) => c.runtime?.paneId === s.panes.detail)!;
    const tree = clients.find((c) => c.runtime?.paneId === s.panes.tree)!;
    await s.client.request({
      action: "navigation.dispatch", sourceClientId: tree.clientId, destination: { clientId: detail.clientId, region: "detail" },
      intent: "open", target: { kind: "block", blockId: note.id },
    });
    await s.waitVisible(s.panes.detail, "Extension kinds tour");
    await s.waitVisible(s.panes.detail, "Horoscope virgo · ran");
    await s.waitVisible(s.panes.detail, "Lucky number:");
    await s.waitVisible(s.panes.detail, "Fancy Horror virgo · ran");
    await s.waitVisible(s.panes.detail, "Moon on 2026-10-26: Full Moon");
    await s.checkpoint("extension-kinds-drawn");

    // r on the note runs its extension lines again (keyboard path; outputs have no click target yet).
    await s.focus(s.panes.detail);
    await s.keys(s.panes.detail, "r");
    await s.waitVisible(s.panes.detail, "Refreshed this note's tickets and extension lines");
    await s.checkpoint("extension-kinds-refreshed");

    // The folder goes; the service drops the handler and Detail redraws the line as plain text.
    await rm(join(projectRoot, "extensions", "horoscope"), { recursive: true, force: true });
    await s.waitFor("horoscope gone from Detail", () => s.visible(s.panes.detail), (text) => !text.includes("Horoscope virgo · ran") && text.includes("Fancy Horror virgo · ran"));
    assert.equal((await s.client.request<any>({ action: "get", blockId: note.id })).text, note.text);
    await s.checkpoint("extension-kinds-removed");
  },
});
console.log(JSON.stringify(result));
if (result.status !== "passed") process.exitCode = 1;
