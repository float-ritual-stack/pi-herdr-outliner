import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { detectOutline, listKnownOutlines, localOutlineOwner, type KnownOutline } from "../src/known-outlines";
import { invocationPaneRoot } from "../src/herdr-open-policy";
import {
  chooserKey,
  chooserMouse,
  OutlineChooser,
  planChoice,
  renderChooserFrame,
} from "../src/outline-chooser";
import { resolveClientConfigPath, resolveClientPaths, resolvePaths, writeClientConfig } from "../src/paths";
import type { OutlinerServiceStatus } from "../src/types";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "known-outlines-"));
  directories.push(directory);
  const stateRoot = join(directory, "state");
  const configHome = join(directory, "config");
  const env = (root: string): NodeJS.ProcessEnv => ({
    OUTLINER_WORKSPACE_ROOT: root,
    OUTLINER_STATE_DIR: stateRoot,
    XDG_CONFIG_HOME: configHome,
  });
  return { directory, stateRoot, configHome, configRoot: join(configHome, "pi-herdr-outliner", "projects"), env };
}

/** Every path under a directory, so a test can prove nothing was created. */
function tree(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true }).map(entry => relative(root, join(root, String(entry)))).sort();
}

/** A state directory that looks like an outline: SQLite is never opened, so an empty file suffices. */
function outlineAt(env: NodeJS.ProcessEnv, options: { paneRoot?: string; socket?: boolean } = {}) {
  const paths = resolvePaths(env);
  mkdirSync(paths.stateDir, { recursive: true });
  writeFileSync(paths.database, "");
  if (options.socket) writeFileSync(paths.socket, "");
  if (options.paneRoot) writeFileSync(join(paths.stateDir, "service-pane.json"), JSON.stringify({ paneId: "w:1", workspaceRoot: options.paneRoot }));
  return paths;
}

const status = (workspaceRoot?: string): OutlinerServiceStatus => ({
  status: "ready", protocolVersion: 1,
  ...(workspaceRoot ? { location: { hostname: "fixture-host", workspaceRoot, database: "", stateDirectory: "" } } : {}),
});

test("a folder with no config and no database has no outline, and deciding creates nothing", () => {
  const { directory, env } = fixture();
  const root = join(directory, "jam-shelf");
  const before = tree(directory);
  const presence = detectOutline(env(root));
  expect(presence.kind).toBe("missing");
  expect(presence.paths.workspaceRoot).toBe(root);
  expect(tree(directory)).toEqual(before);
  expect(existsSync(presence.paths.stateDir)).toBe(false);
});

test("an existing database, an explicit config or remote mode each count as an outline", () => {
  const { directory, env } = fixture();
  const stored = join(directory, "jam-shelf");
  outlineAt(env(stored));
  expect(detectOutline(env(stored))).toMatchObject({ kind: "present", because: "database" });

  const chosen = join(directory, "fern-ledger");
  writeClientConfig(env(chosen), { mode: "local", workspaceRoot: chosen });
  expect(detectOutline(env(chosen))).toMatchObject({ kind: "present", because: "config" });
  expect(existsSync(resolvePaths(env(chosen)).stateDir)).toBe(false);

  const aliased = join(directory, "quiet-attic");
  writeClientConfig(env(aliased), { mode: "remote", workspaceRoot: aliased, socketPath: "/tmp/fixture-outline.sock" });
  expect(detectOutline(env(aliased))).toMatchObject({ kind: "present", because: "remote" });

  const forced = join(directory, "tin-lantern");
  expect(detectOutline({ ...env(forced), OUTLINER_REMOTE: "1", OUTLINER_SOCKET_PATH: "/tmp/fixture-outline.sock" }))
    .toMatchObject({ kind: "present", because: "remote" });
  // Forcing local mode alone is not a choice to create an outline.
  expect(detectOutline({ ...env(forced), OUTLINER_REMOTE: "0" }).kind).toBe("missing");
});

test("OUTLINER_REMOTE=0 keeps a recorded local choice, so New outline here does not loop back to the chooser", () => {
  const { directory, env } = fixture();
  const root = join(directory, "jam-shelf");
  writeClientConfig({ ...env(root), OUTLINER_REMOTE: "0" }, { mode: "local", workspaceRoot: root });
  expect(detectOutline({ ...env(root), OUTLINER_REMOTE: "0" })).toMatchObject({ kind: "present", because: "config", paths: { mode: "local" } });
  // A recorded remote choice is overridden by OUTLINER_REMOTE=0 and is no local consent.
  const aliased = join(directory, "quiet-attic");
  writeClientConfig(env(aliased), { mode: "remote", workspaceRoot: aliased, socketPath: "/tmp/fixture-outline.sock" });
  expect(detectOutline({ ...env(aliased), OUTLINER_REMOTE: "0" }).kind).toBe("missing");
  // A second choice for the same folder reports EEXIST, which the chooser treats as already chosen.
  expect(() => writeClientConfig(env(root), { mode: "local", workspaceRoot: root })).toThrow(expect.objectContaining({ code: "EEXIST" }));
});

test("an explicit OUTLINER_CONFIG_PATH is the user's choice and is never written through", () => {
  const { directory, env } = fixture();
  const root = join(directory, "jam-shelf");
  const shared = join(directory, "shared-client.json");
  const explicit = { ...env(root), OUTLINER_CONFIG_PATH: shared };
  expect(detectOutline(explicit)).toMatchObject({ kind: "present", because: "config", paths: { mode: "local" } });
  expect(() => writeClientConfig(explicit, { mode: "local", workspaceRoot: root })).toThrow("OUTLINER_CONFIG_PATH");
  expect(existsSync(shared)).toBe(false);
  expect(existsSync(resolveClientConfigPath(env(root)))).toBe(false);
});

test("a socket in the state root belongs to a local outline whose folder comes from its pane record or local config", () => {
  const { directory, stateRoot, configRoot, env } = fixture();
  const kiln = join(directory, "kiln");
  const recorded = outlineAt(env(kiln), { paneRoot: kiln });
  expect(localOutlineOwner(recorded.socket, { stateRoot, configRoot })).toEqual({
    stateDir: recorded.stateDir, stateKey: recorded.stateDir.split("/").at(-1)!, root: kiln,
  });
  const moss = join(directory, "moss-desk");
  const configured = outlineAt(env(moss));
  writeClientConfig(env(moss), { mode: "local", workspaceRoot: moss });
  expect(localOutlineOwner(configured.socket, { stateRoot, configRoot })?.root).toBe(moss);
  const orphan = outlineAt(env(join(directory, "old-hash")));
  const owner = localOutlineOwner(orphan.socket, { stateRoot, configRoot });
  expect(owner?.stateDir).toBe(orphan.stateDir);
  expect(owner?.root).toBeUndefined();
  // Genuinely remote sockets and state directories without a database are not local outlines.
  expect(localOutlineOwner(join(directory, "tunnel", "outliner.sock"), { stateRoot, configRoot })).toBeUndefined();
  expect(localOutlineOwner(resolvePaths(env(join(directory, "empty"))).socket, { stateRoot, configRoot })).toBeUndefined();
});

test("an Outliner pane's folder comes from its OSC 7 cwd, not the plugin checkout it runs in", () => {
  const plugin = "/tmp/fixture/plugin-checkout";
  const tree = { foreground_cwd: plugin, cwd: "/tmp/fixture/jam-shelf" };
  expect(invocationPaneRoot(tree, "open-here", plugin)).toEqual({ root: "/tmp/fixture/jam-shelf", field: "cwd" });
  expect(invocationPaneRoot(tree, "ensure-detail", `${plugin}/`)).toEqual({ root: "/tmp/fixture/jam-shelf", field: "cwd" });
  const shell = { foreground_cwd: "/tmp/fixture/jam-shelf/notes", cwd: "/tmp/fixture/jam-shelf" };
  expect(invocationPaneRoot(shell, "open-here", plugin)).toEqual({ root: "/tmp/fixture/jam-shelf/notes", field: "foreground cwd" });
  expect(invocationPaneRoot(shell, "open-tree", plugin)).toEqual({ root: "/tmp/fixture/jam-shelf", field: "cwd" });
  expect(invocationPaneRoot({ foreground_cwd: plugin }, "open-here", plugin)).toEqual({ root: plugin, field: "foreground cwd" });
  expect(invocationPaneRoot(undefined, "open-here", plugin)).toBeUndefined();
});

test("the config writer records a choice every process reads the same way, and never replaces one", () => {
  const { directory, env } = fixture();
  const root = join(directory, "jam-shelf");
  const socket = join(directory, "elsewhere", "outliner.sock");
  const path = writeClientConfig(env(root), { mode: "remote", workspaceRoot: root, socketPath: socket, label: "Kiln notes" });
  expect(path).toBe(resolveClientConfigPath(env(root)));
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ workspaceRoot: root, mode: "remote", socketPath: socket, label: "Kiln notes" });
  expect(resolveClientPaths(env(root))).toMatchObject({ mode: "remote", socket, workspaceRoot: root });
  expect(() => writeClientConfig(env(root), { mode: "local", workspaceRoot: root })).toThrow();
  expect(() => writeClientConfig(env(join(directory, "x")), { mode: "remote", workspaceRoot: join(directory, "x"), socketPath: "relative.sock" })).toThrow();
  expect(existsSync(join(directory, "state"))).toBe(false);
});

test("known outlines list state directories and configs, dedupe aliases by socket and report status without creating anything", async () => {
  const { directory, stateRoot, configRoot, env } = fixture();
  const jam = join(directory, "jam-shelf");
  const running = outlineAt(env(jam), { paneRoot: jam, socket: true });
  const learned = outlineAt(env(join(directory, "moss-desk")), { socket: true });
  const unknown = outlineAt(env(join(directory, "old-hash")));
  mkdirSync(resolvePaths(env(join(directory, "not-an-outline"))).stateDir, { recursive: true });
  const hanging = outlineAt(env(join(directory, "slow-well")), { paneRoot: join(directory, "slow-well"), socket: true });
  for (const alias of ["fern-ledger", "quiet-attic"]) {
    const root = join(directory, alias);
    writeClientConfig(env(root), { mode: "remote", workspaceRoot: root, socketPath: running.socket, label: "Jam shelf" });
  }
  writeClientConfig(env(join(directory, "far-away")), {
    mode: "remote", workspaceRoot: join(directory, "far-away"), socketPath: join(directory, "tunnel", "remote.sock"), label: "Remote kiln",
  });
  mkdirSync(join(configRoot, "broken--000000000000"), { recursive: true });
  writeFileSync(join(configRoot, "broken--000000000000", "client.json"), "{not json");

  const before = tree(directory);
  const pinged: string[] = [];
  const started = Date.now();
  const outlines = await listKnownOutlines({
    stateRoot, configRoot, pingTimeoutMs: 100,
    async ping(socket) {
      pinged.push(socket);
      if (socket === running.socket) return status();
      if (socket === learned.socket) return status(join(directory, "moss-desk"));
      return new Promise<OutlinerServiceStatus>(() => {});
    },
  });
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(tree(directory)).toEqual(before);
  // Missing sockets are not pinged at all.
  expect(pinged.sort()).toEqual([hanging.socket, learned.socket, running.socket].sort());

  const bySocket = new Map(outlines.map(outline => [outline.socket, outline]));
  expect(outlines).toHaveLength(5);
  expect(bySocket.get(running.socket)).toMatchObject({
    label: "Jam shelf", root: jam, status: "running", location: "local",
    aliases: [join(directory, "fern-ledger"), join(directory, "quiet-attic")],
  });
  expect(bySocket.get(learned.socket)).toMatchObject({ label: "moss-desk", root: join(directory, "moss-desk"), status: "running" });
  expect(bySocket.get(unknown.socket)).toMatchObject({ status: "stopped", stateKey: resolve(unknown.stateDir).split("/").at(-1) });
  expect(bySocket.get(unknown.socket)?.root).toBeUndefined();
  expect(bySocket.get(hanging.socket)).toMatchObject({ status: "stopped", root: join(directory, "slow-well") });
  expect(bySocket.get(join(directory, "tunnel", "remote.sock"))).toMatchObject({
    label: "Remote kiln", location: "remote", status: "stopped", aliases: [join(directory, "far-away")],
  });
  // Running outlines come first.
  expect(outlines.slice(0, 2).every(outline => outline.status === "running")).toBe(true);
});

test("listing an absent state root and config root finds nothing and creates neither", async () => {
  const { directory, stateRoot, configRoot } = fixture();
  expect(await listKnownOutlines({ stateRoot, configRoot })).toEqual([]);
  expect(tree(directory)).toEqual([]);
});

const outline = (overrides: Partial<KnownOutline>): KnownOutline => ({
  socket: "/tmp/fixture/a/outliner.sock", label: "Kiln notes", aliases: [], location: "local", status: "running", ...overrides,
});

test("choosing an outline records it as the folder's remote socket; a stopped one starts from its own folder first", () => {
  const root = "/tmp/fixture/jam-shelf";
  expect(planChoice({ kind: "new" }, root)).toEqual({ kind: "write", config: { mode: "local", workspaceRoot: root } });
  expect(planChoice({ kind: "outline", outline: outline({ root: "/tmp/fixture/kiln" }) }, root)).toEqual({
    kind: "write", config: { mode: "remote", workspaceRoot: root, socketPath: "/tmp/fixture/a/outliner.sock", label: "Kiln notes" },
  });
  expect(planChoice({ kind: "outline", outline: outline({ status: "stopped", root: "/tmp/fixture/kiln" }) }, root))
    .toMatchObject({ kind: "write", startServiceFor: "/tmp/fixture/kiln" });
  expect(planChoice({ kind: "outline", outline: outline({ status: "stopped" }) }, root).kind).toBe("refuse");
  expect(planChoice({ kind: "outline", outline: outline({ status: "stopped", location: "remote" }) }, root).kind).toBe("write");
});

test("the chooser moves by keys and mouse, chooses by Enter or a click, and sanitizes what it shows", () => {
  const chooser = new OutlineChooser({ mode: "open-here", workspaceRoot: "/tmp/fixture/jam\x1b[31m-shelf", rootSource: "the invoking pane's foreground cwd" });
  chooser.setOutlines([outline({ label: "Kiln\x1b]0;title\x07 notes", root: "/tmp/fixture/kiln" }), outline({ label: "Moss", socket: "/tmp/fixture/b.sock", status: "stopped" })]);
  expect(chooser.rows.map(row => row.kind)).toEqual(["outline", "outline", "new"]);
  expect(chooserKey(chooser, { name: "j" })).toBe("changed");
  expect(chooserKey(chooser, { name: "down" })).toBe("changed");
  expect(chooser.selected?.kind).toBe("new");
  expect(chooserKey(chooser, { name: "k" })).toBe("changed");
  expect(chooser.index).toBe(1);
  expect(chooserKey(chooser, { name: "return" })).toBe("choose");
  expect(chooserKey(chooser, { name: "escape" })).toBe("close");
  // While a choice is being saved and continued, nothing closes the popup halfway.
  chooser.busy = true;
  expect(chooserKey(chooser, { name: "escape" })).toBeNull();
  expect(chooserKey(chooser, { name: "c", ctrl: true })).toBeNull();
  chooser.busy = false;

  const frame = renderChooserFrame(chooser, 90, 24);
  expect(frame).toHaveLength(24);
  const text = frame.join("\n");
  expect(text).toContain("No outline for");
  expect(text).toContain("the invoking pane's foreground cwd");
  expect(text).toContain("+ New outline here");
  expect(text).not.toContain("\x1b]0;");
  expect(text).not.toContain("\x1b[31m-shelf");

  // The list starts on the sixth row; each outline takes two rows. SGR is 1-based.
  const click = (row: number) => `\x1b[<0;10;${row + 1}M`;
  expect(chooserMouse(chooser, click(6), 90, 24)).toBe("choose");
  expect(chooser.index).toBe(0);
  expect(chooserMouse(chooser, click(9), 90, 24)).toBe("choose");
  expect(chooser.selected?.kind).toBe("new");
  expect(chooserMouse(chooser, "\x1b[<64;10;8M", 90, 24)).toBe("changed");
  expect(chooser.index).toBe(1);
  expect(chooserMouse(chooser, click(2), 90, 24)).toBeNull();
  expect(chooserMouse(chooser, click(20), 90, 24)).toBeNull();
  expect(chooser.index).toBe(1);
});

test("opening from Herdr in a folder with no outline shows the chooser and creates no state", async () => {
  const { directory, stateRoot, configHome } = fixture();
  const root = join(directory, "jam-shelf");
  mkdirSync(root);
  const herdr = join(directory, "fake-herdr");
  const calls = join(directory, "calls.jsonl");
  writeFileSync(herdr, `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
if (args[0] === "pane" && args[1] === "get") console.log(JSON.stringify({ result: { pane: { pane_id: "w:1", foreground_cwd: ${JSON.stringify(root)}, cwd: ${JSON.stringify(root)}, workspace_id: "w", tab_id: "w:t" } } }));
else console.log(JSON.stringify({ result: { plugin_pane: { pane: { pane_id: "w:popup" } } } }));
`);
  chmodSync(herdr, 0o755);
  const run = async (mode: string) => {
    const child = Bun.spawn([process.execPath, "run", resolve("src/herdr-open.ts"), "--mode", mode], {
      env: {
        ...process.env, HERDR_ENV: "1", HERDR_BIN_PATH: herdr, HERDR_PANE_ID: "w:1",
        HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_id: "w:1", focused_pane_cwd: root }),
        OUTLINER_STATE_DIR: stateRoot, XDG_CONFIG_HOME: configHome,
        OUTLINER_WORKSPACE_ROOT: undefined, OUTLINER_CONFIG_PATH: undefined, OUTLINER_REMOTE: undefined, OUTLINER_SOCKET_PATH: undefined,
      },
      stdout: "pipe", stderr: "pipe", timeout: 10_000,
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  };

  const opened = await run("open-here");
  expect(opened.stderr).toBe("");
  expect(opened.code).toBe(0);
  expect(JSON.parse(opened.stdout)).toEqual({ outline: "missing", chooser: "choose-outline", workspaceRoot: root, rootSource: "the invoking pane's foreground cwd" });
  const herdrCalls = readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
  const entrypoints = herdrCalls.filter(args => args[0] === "plugin").map(args => args[args.indexOf("--entrypoint") + 1]);
  expect(entrypoints).toEqual(["choose-outline"]);
  const context = herdrCalls.find(args => args.includes("choose-outline"))!.find(arg => arg.startsWith("OUTLINER_CHOOSER_CONTEXT="))!;
  expect(JSON.parse(context.slice("OUTLINER_CHOOSER_CONTEXT=".length))).toEqual({
    mode: "open-here", workspaceRoot: root, rootSource: "the invoking pane's foreground cwd", paneId: "w:1",
  });
  expect(existsSync(stateRoot)).toBe(false);
  expect(existsSync(configHome)).toBe(false);

  const refused = await run("service-only");
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain(`No outline for ${root}`);
  expect(existsSync(stateRoot)).toBe(false);

  // Aliased to a stopped local outline whose folder is unknown: say so at once, never blame a tunnel.
  const orphan = outlineAt({ OUTLINER_WORKSPACE_ROOT: join(directory, "old-hash"), OUTLINER_STATE_DIR: stateRoot });
  writeClientConfig({ OUTLINER_STATE_DIR: stateRoot, XDG_CONFIG_HOME: configHome }, { mode: "remote", workspaceRoot: root, socketPath: orphan.socket });
  const started = Date.now();
  const stopped = await run("open-here");
  expect(stopped.code).toBe(1);
  expect(stopped.stderr).toContain("is not running, and the folder it belongs to is unknown");
  expect(stopped.stderr).not.toContain("SSH");
  expect(Date.now() - started).toBeLessThan(8_000);
}, 30_000);
