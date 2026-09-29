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
// An unbound folder gets the outline named after it (created on first open); a bound folder opens its outline;
// a subfolder of a bound folder opens the bound outline; a git repository's subfolder opens the repository's.
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
    // A subfolder of the bound folder, and a fictional git repository with a subfolder.
    const fredDrafts = join(fredFolder!, "notes", "drafts");
    const repository = join(runRoot, "code", "lantern-lab");
    const repositorySubfolder = join(repository, "src", "widgets");
    for (const folder of [fredDrafts, join(repository, ".git"), repositorySubfolder]) await mkdir(folder, { recursive: true });
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

    // 3. A subfolder of the folder bound to fred: Ctrl-b u walks up to the binding and opens fred, creating nothing.
    const fredTreesBefore = (await liveOn("fred", "tree")).map(client => client.clientId);
    await ctrlBU(fredDrafts, "drafts$");
    const [draftsTree] = await s.waitFor("subfolder: a new Tree on fred", async () => (await liveOn("fred", "tree")).filter(client => !fredTreesBefore.includes(client.clientId)), clients => clients.length > 0, 30_000);
    assert.ok(draftsTree, "a second Tree opened on fred");
    assert.deepEqual(host.list().outlines.map(outline => outline.name), ["bob", "fred", "jam-shelf"]);
    assert.deepEqual(await liveOn("bob", "tree"), []);
    await s.record("drafts-tree", draftsTree);
    await s.checkpoint("02-subfolder-of-bound-folder-opened-fred");

    // 4. A git repository's subfolder: Ctrl-b u opens (and creates) the outline named after the repository root.
    await ctrlBU(repositorySubfolder, "widgets$");
    const labViews = await openedOn("lantern-lab", "repository subfolder");
    const lab = host.list().outlines.find(outline => outline.name === "lantern-lab");
    assert.equal(lab?.root, repository, "the created outline records the repository root as its folder");
    assert.deepEqual(host.list().outlines.map(outline => outline.name), ["bob", "fred", "jam-shelf", "lantern-lab"]);
    const labTree = await s.adoptDetached(labViews.tree.clientId, "tree", outlineClient("lantern-lab"));
    await s.waitVisible(labTree, "Tree");
    await s.record("lantern-lab-views", labViews);
    await s.checkpoint("03-repository-subfolder-opened-lantern-lab");

    // No folder got a hash database, and no service pane was opened for them.
    for (const folder of [jam!, fredFolder!, fredDrafts, repository, repositorySubfolder]) {
      assert.equal(existsSync(resolvePaths({ ...configEnv, OUTLINER_WORKSPACE_ROOT: folder }).stateDir), false);
    }
    assert.ok(!host.list().outlines.some(outline => ["drafts", "widgets", "src", "notes"].includes(outline.name)), "no outline named after a subfolder");
    const logs = await s.pluginActionLogs();
    assert.equal(logs.filter(log => log.actionId === "open-here" && log.status === "succeeded").length >= 4, true, JSON.stringify(logs));
    await s.record("state-after", { entries: readdirSync(stateRoot).sort(), outlines: host.list() });
  },
});
await host?.close().catch(() => undefined);
console.log(JSON.stringify(result));
if (result.status !== "passed") process.exitCode = 1;
