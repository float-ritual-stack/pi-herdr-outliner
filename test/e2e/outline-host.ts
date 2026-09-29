import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { OutlinerClient } from "../../src/client";
import { listLiveClients } from "../../src/client-target";
import { OutlineHost } from "../../src/outline-host";
import { resolvePaths, writeClientConfig } from "../../src/paths";
import type { OutlinerClientRegistration } from "../../src/types";
import { runHerdrScenario } from "./herdr-runner";

// PIE-457 step 3: with an outline host running, Ctrl-b u opens the folder's outline by name.
// An unbound folder gets the outline named after it (created on first open); a bound folder opens its outline.
let host: OutlineHost | undefined;
const result = await runHerdrScenario({
  name: "outline-host",
  commandKeys: [{ key: "prefix+u", command: "float.pi-outliner.open-here" }],
  async prepare() {},
  async run(s) {
    const runRoot = dirname(s.projectRoot);
    const stateRoot = join(runRoot, "outliner-state");
    const configEnv = { OUTLINER_STATE_DIR: stateRoot, XDG_CONFIG_HOME: join(runRoot, "xdg-config") };
    host = new OutlineHost({ stateRoot, log: message => void s.record("host-log", message) });
    await host.start();
    await host.create("bob");
    await host.create("fred");
    const outlineClient = (name: string) => new OutlinerClient(host!.socketPath, 3_000, name);
    await outlineClient("bob").request({ action: "create", text: "Bob's fictional kettle" });
    await outlineClient("fred").request({ action: "create", text: "Fred's fictional compass" });

    const [jam, fredFolder] = ["jam-shelf", "fred-folder"].map(name => join(runRoot, name));
    for (const folder of [jam, fredFolder]) await mkdir(folder!);
    writeClientConfig({ ...configEnv, OUTLINER_WORKSPACE_ROOT: fredFolder }, { mode: "host", workspaceRoot: fredFolder!, outline: "fred" });
    const terminal = await s.attachClient();
    await terminal.resize(160, 48);

    const liveOn = async (name: string, role: "tree" | "detail") =>
      (await listLiveClients(outlineClient(name), role).catch(() => [] as OutlinerClientRegistration[])).filter(client => client.runtime?.paneId);
    // Ctrl-b u from a shell in `folder`, as a person would: click its prompt, then the prefix and u.
    const ctrlBU = async (folder: string, prompt: string) => {
      const shell = await s.openShellTab(folder);
      await s.waitFor(`shell in ${folder}`, () => s.visible(shell), text => text.includes(prompt));
      const screen = await s.waitFor(`${prompt} on screen`, terminal.visible, text => text.includes(prompt));
      const lines = screen.split("\n");
      const row = lines.findIndex(line => line.includes(prompt));
      const column = visibleWidth(lines[row]!.slice(0, lines[row]!.indexOf(prompt)));
      await terminal.write(`\x1b[<0;${column + 1};${row + 1}M\x1b[<0;${column + 1};${row + 1}m`);
      await terminal.write("\x02");
      await s.waitFor("prefix", terminal.visible, text => text.includes("PREFIX"));
      await terminal.write("u");
    };
    const openedOn = async (name: string, label: string) => {
      const [tree] = await s.waitFor(`${label}: Tree on ${name}`, () => liveOn(name, "tree"), clients => clients.length > 0, 30_000);
      const [detail] = await s.waitFor(`${label}: Detail on ${name}`, () => liveOn(name, "detail"), clients => clients.length > 0, 30_000);
      return { tree: tree!, detail: detail! };
    };

    // 1. An unbound folder: Ctrl-b u creates the outline named after it and opens Tree and Detail on it, with no chooser.
    await ctrlBU(jam!, "jam-shelf$");
    const jamViews = await openedOn("jam-shelf", "unbound folder");
    assert.deepEqual(host.list().outlines.map(outline => outline.name), ["bob", "fred", "jam-shelf"]);
    assert.ok(!(await terminal.visible()).includes("No outline for"), "no chooser on the default path");
    const jamTree = await s.adoptDetached(jamViews.tree.clientId, "tree", outlineClient("jam-shelf"));
    await s.waitVisible(jamTree, "Tree");
    await s.record("jam-shelf-views", jamViews);
    await s.checkpoint("00-unbound-folder-created-and-opened");

    // 2. A folder bound to fred: Ctrl-b u opens fred, not bob.
    await ctrlBU(fredFolder!, "fred-folder$");
    const fredViews = await openedOn("fred", "bound folder");
    const fredTree = await s.adoptDetached(fredViews.tree.clientId, "tree", outlineClient("fred"));
    // The pane's Tree registered with fred's outline on the host: it reads fred, and bob has no views.
    await s.waitVisible(fredTree, "Tree");
    await s.record("fred-tree-visible", await s.visible(fredTree));
    assert.deepEqual(await liveOn("bob", "tree"), []);
    assert.deepEqual(await liveOn("bob", "detail"), []);
    await s.checkpoint("01-bound-folder-opened-fred");

    // Neither folder got a hash database, and no service pane was opened for them.
    for (const folder of [jam!, fredFolder!]) assert.equal(existsSync(resolvePaths({ ...configEnv, OUTLINER_WORKSPACE_ROOT: folder }).stateDir), false);
    const logs = await s.pluginActionLogs();
    assert.equal(logs.filter(log => log.actionId === "open-here" && log.status === "succeeded").length >= 2, true, JSON.stringify(logs));
    await s.record("state-after", { entries: readdirSync(stateRoot).sort(), outlines: host.list() });
  },
});
await host?.close().catch(() => undefined);
console.log(JSON.stringify(result));
if (result.status !== "passed") process.exitCode = 1;
