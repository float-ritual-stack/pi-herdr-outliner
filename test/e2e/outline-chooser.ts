import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { OutlinerClient } from "../../src/client";
import { listLiveClients } from "../../src/client-target";
import { resolveClientConfigPath, resolvePaths } from "../../src/paths";
import type { OutlinerServiceStatus } from "../../src/types";
import { visibleWidth } from "@earendil-works/pi-tui";
import { runHerdrScenario } from "./herdr-runner";

// PIE-458: opening from a folder with no outline asks which outline to use and creates nothing by itself.
const result = await runHerdrScenario({
  name: "outline-chooser",
  commandKeys: [{ key: "prefix+u", command: "float.pi-outliner.open-here" }],
  async prepare() {},
  async run(s) {
    const runRoot = dirname(s.projectRoot);
    const stateRoot = join(runRoot, "outliner-state");
    const env = (root: string) => ({ OUTLINER_WORKSPACE_ROOT: root, OUTLINER_STATE_DIR: stateRoot, XDG_CONFIG_HOME: join(runRoot, "xdg-config") });
    const configFor = (root: string) => resolveClientConfigPath(env(root));
    const stateFor = (root: string) => resolvePaths(env(root));
    const projectSocket = stateFor(s.projectRoot).socket;
    const stateEntries = () => readdirSync(stateRoot).sort();
    const [jam, attic, fern] = ["jam-shelf", "quiet-attic", "fern-ledger"].map(name => join(runRoot, name));
    for (const folder of [jam, attic, fern]) await mkdir(folder!);
    const terminal = await s.attachClient();
    await terminal.resize(160, 48);
    const baseline = stateEntries();

    // The chooser is a Herdr popup: read and drive it through the attached terminal, as the goto journey does.
    const popup = () => terminal.visible();
    const closed = (label: string) => s.waitFor(label, popup, frame => !frame.includes("No outline for"));
    const openChooser = async (folder: string) => {
      const shell = await s.openShellTab(folder);
      await s.waitFor(`shell in ${folder}`, () => s.visible(shell), text => text.trim().length > 0);
      const output = await s.invokeAction("open-here");
      assert.deepEqual(output, { outline: "missing", chooser: "choose-outline", workspaceRoot: folder, rootSource: "the invoking pane's foreground cwd" });
      const frame = await s.waitFor("known outlines listed", popup, text => text.includes("New outline here") && !text.includes("Looking for outlines"));
      assert.ok(frame.includes(`No outline for ${folder}`), frame);
      assert.ok(frame.includes("Resolved from the invoking pane's foreground cwd"), frame);
      // Showing the chooser created neither state nor a config.
      assert.deepEqual(stateEntries(), baseline);
      assert.equal(existsSync(stateFor(folder).stateDir), false);
      assert.equal(existsSync(configFor(folder)), false);
      return { shell, frame };
    };
    const newTree = async (client: OutlinerClient, before: Set<string>, label: string) => {
      const trees = await s.waitFor(label, () => listLiveClients(client, "tree").catch(() => []), clients => clients.some(c => !before.has(c.clientId)));
      return trees.find(c => !before.has(c.clientId))!;
    };
    const projectClient = new OutlinerClient(projectSocket);
    const treeIds = async (client: OutlinerClient) => new Set((await listLiveClients(client, "tree")).map(c => c.clientId));

    // 1. Choose the running scratch outline by mouse: a click on its row chooses it.
    const first = await openChooser(jam!);
    await s.record("chooser-jam-shelf", first.frame);
    await s.checkpoint("00-chooser-shown");
    const lines = first.frame.split("\n");
    const row = lines.findIndex(line => line.includes("project") && line.includes("running"));
    assert.ok(row >= 0, first.frame);
    const column = visibleWidth(lines[row]!.slice(0, lines[row]!.indexOf("project")));
    const before = await treeIds(projectClient);
    await s.record("click project row", { row, column });
    await terminal.write(`\x1b[<0;${column + 1};${row + 1}M\x1b[<0;${column + 1};${row + 1}m`);
    await closed("chooser closed after click");
    const jamTree = await newTree(projectClient, before, "Tree opened on the chosen outline");
    assert.equal(jamTree.runtime?.paneId !== undefined, true);
    const jamConfig = JSON.parse(readFileSync(configFor(jam!), "utf8"));
    assert.deepEqual(jamConfig, { workspaceRoot: jam, mode: "remote", socketPath: projectSocket, label: "project" });
    assert.equal(existsSync(stateFor(jam!).stateDir), false);
    const jamPane = await s.adoptDetached(jamTree.clientId, "tree");
    await s.waitVisible(jamPane, "Tree [Note]");
    await s.checkpoint("01-mouse-choice-opened-tree");

    // 2. Ctrl-b u again in that folder opens directly, without a chooser.
    // Focus the shell by clicking its prompt, as a person would, then press Ctrl-b u.
    const prompt = await s.waitFor("shell prompt", popup, text => text.includes("jam-shelf$"));
    const promptRow = prompt.split("\n").findIndex(line => line.includes("jam-shelf$"));
    const promptColumn = visibleWidth(prompt.split("\n")[promptRow]!.slice(0, prompt.split("\n")[promptRow]!.indexOf("jam-shelf$")));
    await terminal.write(`\x1b[<0;${promptColumn + 1};${promptRow + 1}M\x1b[<0;${promptColumn + 1};${promptRow + 1}m`);
    const beforeAgain = await treeIds(projectClient);
    await terminal.write("\x02");
    await s.waitFor("prefix", terminal.visible, text => text.includes("PREFIX"));
    await terminal.write("u");
    const again = await newTree(projectClient, beforeAgain, "Ctrl-b u opened directly");
    const againPane = await s.adoptDetached(again.clientId, "tree");
    await s.waitVisible(againPane, "Tree [Note]");
    const logs = await s.pluginActionLogs();
    assert.equal(logs.find(log => log.actionId === "open-here")?.status, "succeeded");
    assert.equal(existsSync(stateFor(jam!).stateDir), false);
    await s.checkpoint("02-second-open-direct");

    // 3. Esc closes the chooser and creates nothing.
    const second = await openChooser(attic!);
    assert.ok(second.frame.includes(`also ${jam}`), second.frame);
    await terminal.write("\x1b");
    await closed("chooser closed by Esc");
    assert.deepEqual(stateEntries(), baseline);
    assert.equal(existsSync(configFor(attic!)), false);

    // 4. "New outline here" by keys creates a local outline for the folder.
    const third = await openChooser(fern!);
    await s.record("chooser-fern-ledger", third.frame);
    for (let i = 0; i < 4; i++) await terminal.write("j");
    await s.waitFor("new outline selected", popup, text => text.includes("› + New outline here"));
    await terminal.write("\r");
    await closed("chooser closed after Enter");
    const fernPaths = stateFor(fern!);
    const fernClient = new OutlinerClient(fernPaths.socket);
    await s.waitFor("new outline service", () => fernClient.request<OutlinerServiceStatus>({ action: "ping" }, 500).catch(() => null), value => value?.status === "ready");
    await newTree(fernClient, new Set(), "Tree opened on the new outline");
    assert.ok(existsSync(fernPaths.database));
    assert.deepEqual(JSON.parse(readFileSync(configFor(fern!), "utf8")), { workspaceRoot: fern, mode: "local" });
    await s.record("state-after", { entries: stateEntries(), baseline });
    assert.deepEqual(stateEntries(), [...baseline, fernPaths.stateDir.split("/").at(-1)!].sort());
  },
});
console.log(JSON.stringify(result));
if (result.status !== "passed") process.exitCode = 1;
