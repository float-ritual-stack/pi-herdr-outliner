import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { createOutlinerClient, OutlinerClient, type OutlinerWatcher } from "../src/client";
import { OutlineChooser, newHostedOutlineName, planChoice, renderChooserFrame } from "../src/outline-chooser";
import { OutlineHost } from "../src/outline-host";
import {
  hostedOutlineClientDir,
  hostedOutlinePaths,
  outlineHostPaths,
  readClientConfig,
  resolveClientConfigPath,
  resolveClientPaths,
  resolvePaths,
  resolveFolderOutline,
  resolveServicePaths,
  writeClientConfig,
} from "../src/paths";
import { detectOutline } from "../src/known-outlines";
import { registeredPaneOutline, resolveInvocationPaths } from "../src/outline-host-client";
import { dispatchNativeSelectionComment } from "../src/herdr-comment-selection";
import { OutlinerServer } from "../src/server";
import { OutlinerStore } from "../src/store";
import type { Block, HostedOutlineAttachment, OutlinerClientRegistration, OutlinerEvent, OutlinerServiceStatus } from "../src/types";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "outline-host-clients-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

async function startHost(stateRoot: string, defaultOutline?: string): Promise<OutlineHost> {
  const host = new OutlineHost({ stateRoot, defaultOutline, log: () => {} });
  await host.start();
  cleanups.push(() => host.close());
  return host;
}

function envFor(root: string, folder: string, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { OUTLINER_STATE_DIR: join(root, "state"), XDG_CONFIG_HOME: join(root, "config"), OUTLINER_WORKSPACE_ROOT: folder, ...extra };
}

test("a client that names its outline reads and watches that outline through the host", async () => {
  const root = scratch();
  const host = await startHost(join(root, "state"), "bob");
  await host.create("bob");
  await host.create("fred");
  const bob = new OutlinerClient(host.socketPath, 3_000, "bob");
  const fred = new OutlinerClient(host.socketPath, 3_000, "fred");
  const fredNote = await fred.request<Block>({ action: "create", text: "Fred's fictional compass" });
  expect((await fred.request<Block>({ action: "get", blockId: fredNote.id })).text).toBe("Fred's fictional compass");
  await expect(bob.request({ action: "get", blockId: fredNote.id })).rejects.toThrow("Block not found");
  expect((await fred.requireCompatibleService(["request.outline"])).outline?.name).toBe("fred");

  const connected = Promise.withResolvers<void>();
  const events: OutlinerEvent[] = [];
  const watcher = fred.watch({
    client: { clientId: "fred-tree", contextId: "fred-context", role: "tree" },
    onConnect: connected.resolve,
    onEvent: event => { events.push(event); },
  });
  cleanups.push(() => watcher.stop());
  await connected.promise;
  await bob.request({ action: "create", text: "Bob's fictional kettle" });
  await fred.request({ action: "create", text: "Fred's fictional lantern" });
  const deadline = Date.now() + 3_000;
  while (!events.some(event => event.domain === "content") && Date.now() < deadline) await Bun.sleep(10);
  await Bun.sleep(50);
  expect(events.filter(event => event.domain === "content")).toHaveLength(1);
  // The Tree's registration is on fred only.
  expect((await fred.request<OutlinerClientRegistration[]>({ action: "clients.list" })).map(client => client.clientId)).toContain("fred-tree");
  expect((await bob.request<OutlinerClientRegistration[]>({ action: "clients.list" })).map(client => client.clientId)).not.toContain("fred-tree");
});

test("a client that names an outline refuses a single-outline service", async () => {
  const root = scratch();
  const store = new OutlinerStore(join(root, "outliner.sqlite"), { workspaceRoot: root });
  const server = new OutlinerServer(store, join(root, "outliner.sock"));
  await server.start();
  cleanups.push(async () => { await server.close(); store.close(); });
  const named = new OutlinerClient(join(root, "outliner.sock"), 3_000, "fred");
  await expect(named.request({ action: "get", blockId: "x" })).rejects.toThrow('cannot route to the outline "fred"');
  await expect(named.requireCompatibleService()).rejects.toThrow("no request.outline capability");
  const errors: Error[] = [];
  const watcher = named.watch({
    client: { clientId: "fred-tree", contextId: "fred-context", role: "tree" },
    onEvent() {},
    onError: error => { errors.push(error); },
  });
  cleanups.push(() => watcher.stop());
  const deadline = Date.now() + 3_000;
  while (errors.length === 0 && Date.now() < deadline) await Bun.sleep(10);
  expect(errors[0]?.message).toContain("cannot route");
  expect(await new OutlinerClient(join(root, "outliner.sock")).request<OutlinerServiceStatus>({ action: "ping" })).toMatchObject({ status: "ready" });
});

test("resolution: OUTLINER_OUTLINE, then a folder's binding, then the folder's name when a host runs", () => {
  const root = scratch();
  const stateRoot = join(root, "state");
  const jam = join(root, "Jam Shelf");
  const fredFolder = join(root, "fred-folder");
  const oldFolder = join(root, "uncle-folder");
  for (const folder of [jam, fredFolder, oldFolder]) mkdirSync(folder, { recursive: true });
  const hostSocket = outlineHostPaths(stateRoot).socket;

  // No host: an unbound folder resolves by its hash, as before.
  expect(resolveClientPaths(envFor(root, jam))).toMatchObject({ mode: "local", socket: resolvePaths(envFor(root, jam)).socket });
  expect(resolveClientPaths(envFor(root, jam)).outline).toBeUndefined();

  // OUTLINER_OUTLINE names a host outline even without a host.
  expect(resolveClientPaths(envFor(root, jam, { OUTLINER_OUTLINE: "bandit" }))).toMatchObject({
    mode: "host", socket: hostSocket, outline: "bandit", outlineSource: "env", stateDir: hostedOutlineClientDir(stateRoot, "bandit"),
  });
  expect(() => resolveClientPaths(envFor(root, jam, { OUTLINER_OUTLINE: "Not A Name" }))).toThrow("OUTLINER_OUTLINE must be an outline name");

  // A binding: { workspaceRoot, outline }.
  writeClientConfig(envFor(root, fredFolder), { mode: "host", workspaceRoot: fredFolder, outline: "fred" });
  expect(JSON.parse(readFileSync(resolveClientConfigPath(envFor(root, fredFolder)), "utf8"))).toEqual({ workspaceRoot: fredFolder, outline: "fred" });
  expect(resolveClientPaths(envFor(root, fredFolder))).toMatchObject({ mode: "host", outline: "fred", outlineSource: "bound" });
  // The environment wins over the binding.
  expect(resolveClientPaths(envFor(root, fredFolder, { OUTLINER_OUTLINE: "bob" }))).toMatchObject({ mode: "host", outline: "bob", outlineSource: "env" });
  // The switcher replaces a binding; a first choice never does.
  expect(() => writeClientConfig(envFor(root, fredFolder), { mode: "host", workspaceRoot: fredFolder, outline: "bob" })).toThrow();
  writeClientConfig(envFor(root, fredFolder), { mode: "host", workspaceRoot: fredFolder, outline: "bob" }, { replace: true });
  expect(resolveClientPaths(envFor(root, fredFolder)).outline).toBe("bob");

  // A remote host may be asked for an outline too; a local config may not name one.
  const remoteConfig = join(root, "remote.json");
  writeFileSync(remoteConfig, JSON.stringify({ mode: "remote", socketPath: "/fictional/tunnel.sock", outline: "fred" }));
  expect(resolveClientPaths(envFor(root, jam, { OUTLINER_CONFIG_PATH: remoteConfig }))).toMatchObject({ mode: "remote", socket: "/fictional/tunnel.sock", outline: "fred", outlineSource: "bound" });
  const localNamed = join(root, "local.json");
  writeFileSync(localNamed, JSON.stringify({ mode: "local", outline: "fred" }));
  expect(() => readClientConfig(localNamed, jam)).toThrow("must not name an outline");

  // A host is set up (its outlines/ folder, whether or not it answers): an unbound folder is the outline named after it...
  mkdirSync(outlineHostPaths(stateRoot).outlines, { recursive: true });
  expect(existsSync(hostSocket)).toBe(false);
  expect(resolveClientPaths(envFor(root, jam))).toMatchObject({ mode: "host", outline: "jam-shelf", outlineSource: "folder", workspaceRoot: jam });
  // ...unless that outline records another folder of the same name: no silent merge, and no local fallback either.
  const otherJam = join(root, "elsewhere", "Jam Shelf");
  mkdirSync(otherJam, { recursive: true });
  writeFileSync(join(outlineHostPaths(stateRoot).outlines, "jam-shelf.json"), JSON.stringify({ root: jam }));
  expect(resolveClientPaths(envFor(root, jam))).toMatchObject({ mode: "host", outline: "jam-shelf", outlineSource: "folder" });
  const elsewhere = resolveClientPaths(envFor(root, otherJam));
  expect(elsewhere.mode).toBe("host");
  expect(elsewhere.outline).toBeUndefined();
  expect(elsewhere.unnamed).toContain(`belongs to ${jam}`);
  // ...but a folder that already has a hash database keeps it, and OUTLINER_REMOTE=0 forces the hash.
  const old = resolvePaths(envFor(root, oldFolder));
  mkdirSync(old.stateDir, { recursive: true });
  writeFileSync(old.database, "");
  expect(resolveClientPaths(envFor(root, oldFolder)).mode).toBe("local");
  expect(resolveClientPaths(envFor(root, jam, { OUTLINER_REMOTE: "0" })).mode).toBe("local");

  // The single-outline service never starts for a folder that belongs to the host: bound, guessed or unnamed.
  expect(() => resolveServicePaths(envFor(root, jam))).toThrow("belongs to the outline host");
  expect(() => resolveServicePaths(envFor(root, otherJam))).toThrow("belongs to the outline host");
  expect(() => resolveServicePaths(envFor(root, fredFolder))).toThrow('bound to the outline "bob"');
  expect(resolveServicePaths(envFor(root, oldFolder)).database).toBe(old.database);
});

test("the folder rule: nearest bound folder, else the repository's name, else the folder's, never $HOME, / or /tmp", async () => {
  const root = scratch();
  const home = join(root, "home");
  const env = (extra: Record<string, string> = {}) => ({ ...envFor(root, root), HOME: home, ...extra });
  const bound = join(home, "fred-folder");
  const deep = join(bound, "notes", "drafts");
  const repository = join(home, "code", "Jam Shelf");
  const worktree = join(home, "code", "jam-worktree");
  const inRepository = join(repository, "src", "lib");
  const plain = join(home, "bandit-camp");
  for (const folder of [deep, inRepository, join(worktree, "src"), plain]) mkdirSync(folder, { recursive: true });
  mkdirSync(join(repository, ".git"));
  writeFileSync(join(worktree, ".git"), "gitdir: /fictional/jam/.git/worktrees/jam-worktree\n");

  // 1. A subfolder of a bound folder uses the binding, whatever its own name.
  writeClientConfig(env(), { mode: "host", workspaceRoot: bound, outline: "fred" });
  expect(resolveFolderOutline(deep, env())).toMatchObject({ kind: "bound", folder: bound, config: { mode: "host", outline: "fred" } });
  // A local or remote choice binds its subfolders too.
  const localFolder = join(home, "uncle-local");
  mkdirSync(join(localFolder, "inner"), { recursive: true });
  writeClientConfig(env(), { mode: "local", workspaceRoot: localFolder });
  expect(resolveFolderOutline(join(localFolder, "inner"), env())).toMatchObject({ kind: "bound", folder: localFolder, config: { mode: "local" } });
  // 2. Inside a git work tree (a .git folder, or a worktree's .git file): the repository root's name.
  expect(resolveFolderOutline(inRepository, env())).toEqual({ kind: "guess", folder: repository, outline: "jam-shelf", from: "repository" });
  expect(resolveFolderOutline(join(worktree, "src"), env())).toEqual({ kind: "guess", folder: worktree, outline: "jam-worktree", from: "repository" });
  // 3. Otherwise the folder's own name.
  expect(resolveFolderOutline(plain, env())).toEqual({ kind: "guess", folder: plain, outline: "bandit-camp", from: "folder" });
  // 4. Never $HOME, / or a folder directly under /.
  for (const folder of [home, "/", "/tmp", "/opt"]) {
    const result = resolveFolderOutline(folder, env());
    expect(result.kind).toBe("unnamed");
    if (result.kind === "unnamed") expect(result.reason).toContain("too broad to name an outline after");
  }
  // A repository rooted at $HOME (dotfiles) gives no name: its subfolders fall back to their own.
  mkdirSync(join(home, ".git"));
  expect(resolveFolderOutline(plain, env())).toEqual({ kind: "guess", folder: plain, outline: "bandit-camp", from: "folder" });
  expect(resolveFolderOutline(home, env()).kind).toBe("unnamed");

  // Through resolveClientPaths, with a host set up: the bound or guessed folder is the workspace root.
  mkdirSync(outlineHostPaths(join(root, "state")).outlines, { recursive: true });
  expect(resolveClientPaths({ ...env(), OUTLINER_WORKSPACE_ROOT: deep })).toMatchObject({ mode: "host", outline: "fred", outlineSource: "bound", workspaceRoot: bound });
  expect(resolveClientPaths({ ...env(), OUTLINER_WORKSPACE_ROOT: inRepository })).toMatchObject({ mode: "host", outline: "jam-shelf", outlineSource: "repository", workspaceRoot: repository });
  const unnamed = resolveClientPaths({ ...env(), OUTLINER_WORKSPACE_ROOT: home });
  expect(unnamed.mode).toBe("host");
  expect(unnamed.outline).toBeUndefined();
  // A client for an unnamed folder refuses rather than reach the host's default outline.
  await expect(createOutlinerClient(unnamed).request({ action: "ping" })).rejects.toThrow("too broad");
  expect(detectOutline({ ...env(), OUTLINER_WORKSPACE_ROOT: home }).kind).toBe("missing");
  expect(detectOutline({ ...env(), OUTLINER_WORKSPACE_ROOT: deep })).toMatchObject({ kind: "present", because: "host" });
});

test("resolution does not flip while the host restarts, and a client reconnects when it is back", async () => {
  const root = scratch();
  const stateRoot = join(root, "state");
  const jam = join(root, "jam-shelf");
  mkdirSync(jam);
  let host = new OutlineHost({ stateRoot, log: () => {} });
  await host.start();
  await host.create("jam-shelf", jam);
  const paths = resolveClientPaths(envFor(root, jam));
  expect(paths).toMatchObject({ mode: "host", outline: "jam-shelf" });
  const connects: number[] = [];
  const client = createOutlinerClient(paths);
  const watcher = client.watch({ client: { clientId: "jam-tree", contextId: "jam-context", role: "tree" }, onConnect: () => { connects.push(Date.now()); }, onEvent() {} });
  cleanups.push(() => watcher.stop());
  const waitFor = async (condition: () => boolean) => {
    const deadline = Date.now() + 5_000;
    while (!condition() && Date.now() < deadline) await Bun.sleep(20);
    expect(condition()).toBe(true);
  };
  await waitFor(() => connects.length === 1);

  // The host stops mid-run: its socket is gone, but the folder still resolves to the host.
  await host.close();
  expect(existsSync(outlineHostPaths(stateRoot).socket)).toBe(false);
  expect(resolveClientPaths(envFor(root, jam))).toMatchObject({ mode: "host", outline: "jam-shelf" });
  const unbound = join(root, "bandit-camp");
  mkdirSync(unbound);
  expect(resolveClientPaths(envFor(root, unbound))).toMatchObject({ mode: "host", outline: "bandit-camp" });
  // Nothing may start a hash database for it meanwhile.
  expect(() => resolveServicePaths(envFor(root, unbound))).toThrow("belongs to the outline host");
  expect(existsSync(resolvePaths(envFor(root, unbound)).stateDir)).toBe(false);
  expect(existsSync(resolvePaths(envFor(root, jam)).stateDir)).toBe(false);

  // The host is back: the same client reconnects to the same outline.
  host = new OutlineHost({ stateRoot, log: () => {} });
  await host.start();
  cleanups.push(() => host.close());
  await waitFor(() => connects.length === 2);
  expect((await client.request<OutlinerClientRegistration[]>({ action: "clients.list" })).map(registration => [registration.clientId, registration.outline])).toEqual([["jam-tree", "jam-shelf"]]);
}, 20_000);

test("attach creates only when asked, and a plain CLI read never creates", async () => {
  const root = scratch();
  const stateRoot = join(root, "state");
  const host = await startHost(stateRoot);
  const control = new OutlinerClient(host.socketPath);
  await expect(control.request({ action: "outlines.attach", name: "uncle" })).rejects.toThrow('No outline named "uncle"');
  expect(existsSync(hostedOutlinePaths(stateRoot, "uncle").database)).toBe(false);
  const first = await control.request<HostedOutlineAttachment>({ action: "outlines.attach", name: "uncle", create: true });
  expect(first).toMatchObject({ created: true, outline: { name: "uncle", open: true } });
  const again = await control.request<HostedOutlineAttachment>({ action: "outlines.attach", name: "uncle", create: true });
  expect(again).toMatchObject({ created: false, outline: { name: "uncle", open: true } });
  // A session opener passes the folder the outline is for: it is recorded and used as the outline's root.
  const auntFolder = join(root, "aunt-folder");
  mkdirSync(auntFolder);
  const aunt = await control.request<HostedOutlineAttachment>({ action: "outlines.attach", name: "aunt", create: true, root: auntFolder });
  expect(aunt.outline.root).toBe(auntFolder);
  expect(JSON.parse(readFileSync(join(outlineHostPaths(stateRoot).outlines, "aunt.json"), "utf8"))).toEqual({ root: auntFolder });
  const auntPing = await new OutlinerClient(host.socketPath, 3_000, "aunt").request<OutlinerServiceStatus>({ action: "ping" });
  expect(auntPing.location?.workspaceRoot).toBe(auntFolder);
  await expect(control.request({ action: "outlines.create", name: "cousin", root: join(root, "missing-folder") })).rejects.toThrow("is not a folder");
  expect(existsSync(hostedOutlinePaths(stateRoot, "cousin").database)).toBe(false);
  // Created without a root, an outline's root is its side folder.
  expect(first.outline.root).toBe(hostedOutlinePaths(stateRoot, "uncle").sideFolder);
  await control.request({ action: "outlines.delete", name: "aunt" });

  // Asynchronous: the host answers from this test's own event loop.
  const cli = async (...args: string[]) => {
    const run = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args], {
      env: { PATH: process.env.PATH, OUTLINER_STATE_DIR: stateRoot, XDG_CONFIG_HOME: join(root, "config"), OUTLINER_WORKSPACE_ROOT: root },
      cwd: root, timeout: 15_000, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()]);
    return { code, stdout, stderr };
  };
  const created = await cli("--outline", "uncle", "create", "--text", "Uncle's fictional hat");
  expect(created.stderr).toBe("");
  expect(created.code).toBe(0);
  const listed = await cli("--outline=uncle", "list", "--text", "fictional hat");
  expect(listed.code).toBe(0);
  expect(listed.stdout).toContain("Uncle's fictional hat");
  // --outline is a global flag before the command: never another flag's value.
  const asValue = await cli("--outline", "uncle", "create", "--text=--outline=bandit");
  expect(asValue.stderr).toBe("");
  expect(asValue.stdout).toContain("--outline=bandit");
  expect(existsSync(hostedOutlinePaths(stateRoot, "bandit").database)).toBe(false);
  const afterCommand = await cli("list", "--outline", "uncle");
  expect(afterCommand.code).not.toBe(0);
  const missing = await cli("--outline", "bandit", "list");
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain('No outline named "bandit"');
  const doctor = await cli("--outline", "bandit", "doctor");
  expect(doctor.stdout).toContain(`Host: ${host.socketPath}`);
  expect(doctor.stdout).toContain("Outline name: bandit (OUTLINER_OUTLINE)");
  expect(existsSync(hostedOutlinePaths(stateRoot, "bandit").database)).toBe(false);
  expect(host.list().outlines.map(outline => outline.name)).toEqual(["uncle"]);

  // close and delete, for session tools: delete moves a created outline aside and never erases it.
  expect((await control.request<{ open: boolean }>({ action: "outlines.close", name: "uncle" })).open).toBe(false);
  const deleted = await control.request<{ movedTo: string }>({ action: "outlines.delete", name: "uncle" });
  expect(existsSync(join(deleted.movedTo, "uncle.sqlite"))).toBe(true);
  expect(host.list().outlines).toEqual([]);
});

test("the chooser lists the host's outlines and New outline here creates the folder's name", () => {
  const chooser = new OutlineChooser({ mode: "open-here", workspaceRoot: "/fictional/Jam Shelf", rootSource: "the invoking pane's foreground cwd" });
  chooser.setHostedOutlines("/fictional/state/outliner.sock", [
    { name: "bob", database: "/fictional/state/outlines/bob.sqlite", adopted: false, open: true, default: true, root: "/fictional/bob" },
    { name: "jam-shelf", database: "/fictional/state/outlines/jam-shelf.sqlite", adopted: false, open: false, default: false },
  ]);
  const frame = renderChooserFrame(chooser, 100, 20).join("\n");
  expect(frame).toContain("bob");
  expect(frame).toContain('Creates the outline "jam-shelf-2" on the outline host');
  expect(planChoice(chooser.rows[0]!, "/fictional/Jam Shelf", chooser.host)).toEqual({ kind: "write", config: { mode: "host", workspaceRoot: "/fictional/Jam Shelf", outline: "bob" } });
  expect(planChoice({ kind: "new" }, "/fictional/Jam Shelf", chooser.host)).toEqual({
    kind: "write", config: { mode: "host", workspaceRoot: "/fictional/Jam Shelf", outline: "jam-shelf-2" }, createOutline: "jam-shelf-2",
  });
  expect(newHostedOutlineName("/fictional/fred", new Set())).toBe("fred");
  // Without a host, "new" is today's local outline.
  expect(planChoice({ kind: "new" }, "/fictional/fred")).toEqual({ kind: "write", config: { mode: "local", workspaceRoot: "/fictional/fred" } });
});

/**
 * herdr-open against a fake Herdr. Each pane Herdr is asked to open registers,
 * as a real pane would, on the outline its `OUTLINER_OUTLINE` names (Tree for
 * `outliner`, Detail for `detail`), in pane `workspace:<entrypoint>`.
 */
async function openWithFakeHerdr(options: { root: string; host: OutlineHost; folder: string; mode?: string; paneId?: string; env?: Record<string, string> }) {
  const { root, host, folder } = options;
  const herdr = join(root, "fake-herdr");
  const logPath = join(root, "herdr-calls.jsonl");
  writeFileSync(logPath, "");
  writeFileSync(herdr, `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
if (args[0] === "pane" && args[1] === "get") {
  console.log(JSON.stringify({ result: { pane: { pane_id: args[2], foreground_cwd: ${JSON.stringify(folder)}, cwd: ${JSON.stringify(folder)}, workspace_id: "workspace", tab_id: "workspace:tab" } } }));
} else if (args[0] === "plugin" && args[1] === "pane" && args[2] === "open") {
  console.log(JSON.stringify({ result: { plugin_pane: { pane: { pane_id: "workspace:" + args[args.indexOf("--entrypoint") + 1] } } } }));
} else {
  console.log(JSON.stringify({ result: { type: "ok" } }));
}
`);
  chmodSync(herdr, 0o755);
  let stop = false;
  const watchers: OutlinerWatcher[] = [];
  const panes = (async () => {
    let seen = 0;
    while (!stop) {
      const calls = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]);
      for (const call of calls.slice(seen)) {
        if (call[0] !== "plugin" || call[2] !== "open") continue;
        const entrypoint = call[call.indexOf("--entrypoint") + 1]!;
        const role = entrypoint === "outliner" ? "tree" : entrypoint === "detail" ? "detail" : undefined;
        const outline = call.find(argument => argument.startsWith("OUTLINER_OUTLINE="))?.slice("OUTLINER_OUTLINE=".length);
        const context = call.find(argument => argument.startsWith("OUTLINER_BROWSING_CONTEXT_ID="))?.slice("OUTLINER_BROWSING_CONTEXT_ID=".length) ?? "opened-context";
        if (!role || !outline) continue;
        watchers.push(new OutlinerClient(host.socketPath, 3_000, outline).watch({
          client: { clientId: `${outline}-${role}-${watchers.length}`, role, contextId: context, runtime: { hostname: hostname(), paneId: `workspace:${entrypoint}`, workspaceId: "workspace", tabId: "workspace:tab" } },
          onEvent() {},
        }));
      }
      seen = calls.length;
      await Bun.sleep(10);
    }
  })();
  try {
    const child = Bun.spawn(["bun", "run", "src/herdr-open.ts", "--mode", options.mode ?? "open-here"], {
      cwd: join(import.meta.dir, ".."),
      env: {
        PATH: process.env.PATH, HOME: root, HERDR_ENV: "1", HERDR_BIN_PATH: herdr, HERDR_PANE_ID: options.paneId ?? "workspace:pane",
        OUTLINER_STATE_DIR: join(root, "state"), XDG_CONFIG_HOME: join(root, "config"), ...options.env,
      },
      stdout: "pipe", stderr: "pipe", timeout: 15_000, killSignal: "SIGKILL",
    });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const calls = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]);
    return { exitCode, stdout, stderr, calls };
  } finally {
    stop = true;
    await panes;
    await Promise.all(watchers.map(watcher => watcher.stop()));
  }
}

/** A live pane already on `outline`, as a Tree or Detail registers it. */
async function livePane(host: OutlineHost, outline: string, role: "tree" | "detail", paneId: string, contextId = `${outline}-context`) {
  const connected = Promise.withResolvers<void>();
  const watcher = new OutlinerClient(host.socketPath, 3_000, outline).watch({
    client: { clientId: `${outline}-${role}-${paneId}`, role, contextId, runtime: { hostname: hostname(), paneId, workspaceId: "workspace", tabId: "workspace:tab" } },
    onConnect: connected.resolve,
    onEvent() {},
  });
  cleanups.push(() => watcher.stop());
  await connected.promise;
  return watcher;
}

test("herdr-open in host mode creates the folder's outline, passes its name to every pane and opens no service pane", async () => {
  const root = scratch();
  const stateRoot = join(root, "state");
  const host = await startHost(stateRoot);
  await host.create("fred");
  const jam = join(root, "jam-shelf");
  const fredFolder = join(root, "fred-folder");
  mkdirSync(jam);
  mkdirSync(fredFolder);

  // An unbound folder: the outline named after it is created and opened.
  const unbound = await openWithFakeHerdr({ root, host, folder: jam });
  expect(unbound.stderr).toBe("");
  expect(unbound.exitCode).toBe(0);
  const opened = JSON.parse(unbound.stdout.trim().split("\n").at(-1)!);
  expect(opened).toMatchObject({ servicePane: null, outline: "jam-shelf", outlineCreated: true, workspaceRoot: jam });
  const entrypoints = (calls: string[][]) => calls.filter(call => call[0] === "plugin" && call[2] === "open").map(call => call[call.indexOf("--entrypoint") + 1]);
  expect(entrypoints(unbound.calls)).toEqual(["outliner", "detail"]);
  for (const call of unbound.calls.filter(call => call.includes("--entrypoint"))) expect(call).toContain("OUTLINER_OUTLINE=jam-shelf");
  expect(unbound.calls.some(call => call[0] === "notification" && call.includes("Created outline jam-shelf"))).toBe(true);
  expect(host.list().outlines.map(outline => outline.name)).toEqual(["fred", "jam-shelf"]);
  // Nothing was made at the folder's hash path.
  expect(existsSync(resolvePaths(envFor(root, jam)).stateDir)).toBe(false);

  // A folder bound to fred opens fred, even with a stale hash database and no service-pane.json there.
  writeClientConfig(envFor(root, fredFolder), { mode: "host", workspaceRoot: fredFolder, outline: "fred" });
  const hashed = resolvePaths(envFor(root, fredFolder));
  mkdirSync(hashed.stateDir, { recursive: true });
  writeFileSync(hashed.database, "");
  const bound = await openWithFakeHerdr({ root, host, folder: fredFolder });
  expect(bound.stderr).toBe("");
  expect(JSON.parse(bound.stdout.trim().split("\n").at(-1)!)).toMatchObject({ servicePane: null, outline: "fred", outlineCreated: false });
  expect(entrypoints(bound.calls)).toEqual(["outliner", "detail"]);
  for (const call of bound.calls.filter(call => call.includes("--entrypoint"))) expect(call).toContain("OUTLINER_OUTLINE=fred");
  expect(bound.calls.some(call => call[0] === "notification")).toBe(false);
  expect(existsSync(join(hashed.stateDir, "service-pane.json"))).toBe(false);
}, 30_000);

test("createOutlinerClient carries the resolved outline", () => {
  const client = createOutlinerClient({ socket: "/fictional/state/outliner.sock", mode: "host", outline: "bandit" });
  expect(client.outline).toBe("bandit");
  expect(createOutlinerClient({ socket: "/fictional/hash.sock", mode: "local" }).outline).toBeUndefined();
});

test("Herdr actions stay on the outline the invoking pane is on, not the folder's current binding", async () => {
  const root = scratch();
  const stateRoot = join(root, "state");
  const host = await startHost(stateRoot);
  const fredFolder = join(root, "fred-folder");
  const nameless = join(root, "bob-scratch");
  mkdirSync(fredFolder);
  mkdirSync(nameless);
  await host.create("fred", fredFolder);
  await host.create("bob");

  // A Tree on fred stays open while choose-outline rebinds its folder to bob.
  await livePane(host, "fred", "tree", "workspace:fred-tree", "fred-context");
  writeClientConfig(envFor(root, fredFolder), { mode: "host", workspaceRoot: fredFolder, outline: "bob" });
  expect(resolveClientPaths(envFor(root, fredFolder)).outline).toBe("bob");
  expect(await registeredPaneOutline(new OutlinerClient(host.socketPath), "workspace:fred-tree")).toBe("fred");
  expect(await registeredPaneOutline(new OutlinerClient(host.socketPath), "workspace:not-an-outliner")).toBeUndefined();
  expect(await resolveInvocationPaths(envFor(root, fredFolder), "workspace:fred-tree")).toMatchObject({ mode: "host", outline: "fred", outlineSource: "pane" });
  // An explicit OUTLINER_OUTLINE still wins; a pane that is no outliner pane falls back to the folder.
  expect((await resolveInvocationPaths(envFor(root, fredFolder, { OUTLINER_OUTLINE: "bob" }), "workspace:fred-tree")).outline).toBe("bob");
  expect(await resolveInvocationPaths(envFor(root, fredFolder), "workspace:shell")).toMatchObject({ outline: "bob", outlineSource: "bound" });

  // ensure-detail from that Tree opens its Detail on fred.
  const detail = await openWithFakeHerdr({ root, host, folder: fredFolder, mode: "ensure-detail", paneId: "workspace:fred-tree" });
  expect(detail.stderr).toBe("");
  expect(detail.exitCode).toBe(0);
  expect(JSON.parse(detail.stdout.trim().split("\n").at(-1)!)).toMatchObject({ outline: "fred", outlineCreated: false, treePane: "workspace:fred-tree", opened: true });
  const opens = detail.calls.filter(call => call[0] === "plugin" && call[2] === "open");
  expect(opens.map(call => call[call.indexOf("--entrypoint") + 1])).toEqual(["detail"]);
  expect(opens[0]).toContain("OUTLINER_OUTLINE=fred");

  // A Detail opened by name in a folder with no binding at all ("bob-scratch" would guess another outline).
  await livePane(host, "fred", "detail", "workspace:named-detail", "named-context");
  expect(resolveClientPaths(envFor(root, nameless)).outline).toBe("bob-scratch");
  const focused = await openWithFakeHerdr({ root, host, folder: nameless, mode: "focus-existing", paneId: "workspace:named-detail" });
  expect(focused.stderr).toBe("");
  expect(JSON.parse(focused.stdout.trim().split("\n").at(-1)!)).toMatchObject({ outline: "fred", outlineCreated: false });
  // No outline was guessed into being for that folder.
  expect(host.list().outlines.map(outline => outline.name)).toEqual(["bob", "fred"]);
}, 40_000);

test("focus-existing opens nothing, so it never creates the folder's outline", async () => {
  const root = scratch();
  const host = await startHost(join(root, "state"));
  const jam = join(root, "jam-shelf");
  mkdirSync(jam);
  const focused = await openWithFakeHerdr({ root, host, folder: jam, mode: "focus-existing" });
  expect(focused.exitCode).not.toBe(0);
  expect(focused.stderr).toContain('No outline named "jam-shelf"');
  expect(host.list().outlines).toEqual([]);
  expect(focused.calls.some(call => call[0] === "plugin" && call[2] === "open")).toBe(false);
}, 30_000);

test("an unnamed folder gets the chooser from Ctrl-b u, and a session opener records the folder it creates for", async () => {
  const root = scratch();
  const stateRoot = join(root, "state");
  const host = await startHost(stateRoot);
  // HOME is `root` in the fake Herdr run: too broad to name an outline after.
  const opened = await openWithFakeHerdr({ root, host, folder: root });
  expect(opened.exitCode).toBe(0);
  expect(JSON.parse(opened.stdout.trim().split("\n").at(-1)!)).toMatchObject({ outline: "missing", chooser: "choose-outline" });
  expect(host.list().outlines).toEqual([]);

  // A git repository's subfolder opens the repository's outline, created with the repository as its root.
  const repository = join(root, "code", "jam-shelf");
  mkdirSync(join(repository, ".git"), { recursive: true });
  mkdirSync(join(repository, "src"));
  const inRepository = await openWithFakeHerdr({ root, host, folder: join(repository, "src") });
  expect(inRepository.stderr).toBe("");
  expect(JSON.parse(inRepository.stdout.trim().split("\n").at(-1)!)).toMatchObject({ outline: "jam-shelf", outlineCreated: true });
  expect(host.list().outlines).toEqual([expect.objectContaining({ name: "jam-shelf", root: repository })]);
  expect(JSON.parse(readFileSync(join(outlineHostPaths(stateRoot).outlines, "jam-shelf.json"), "utf8"))).toEqual({ root: repository });
}, 40_000);

test("comment on selection reaches the Detail on the outline its pane is on", async () => {
  const root = scratch();
  const stateRoot = join(root, "state");
  const host = await startHost(stateRoot);
  const folder = join(root, "fred-folder");
  mkdirSync(folder);
  await host.create("fred", folder);
  await host.create("bob");
  writeClientConfig(envFor(root, folder), { mode: "host", workspaceRoot: folder, outline: "bob" });
  const fred = new OutlinerClient(host.socketPath, 3_000, "fred");
  const note = await fred.request<Block>({ action: "create", text: "Fred's fictional lantern" });
  const connected = Promise.withResolvers<void>();
  const watcher = fred.watch({
    client: { clientId: "fred-detail", role: "detail", contextId: "fred-context", currentTarget: { kind: "block", blockId: note.id }, runtime: { hostname: hostname(), paneId: "workspace:fred-detail", workspaceId: "workspace", tabId: "workspace:tab" } },
    onConnect: connected.resolve,
    onEvent() {},
  });
  cleanups.push(() => watcher.stop());
  await connected.promise;
  const capture = await dispatchNativeSelectionComment({
    env: {
      ...envFor(root, folder), HOME: root, HERDR_ENV: "1", HERDR_SOCKET_PATH: "/fictional/herdr.sock", HERDR_PANE_ID: "workspace:fred-detail",
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_id: "workspace:fred-detail", selected_text: "fictional lantern", invocation_source: "keybinding" }),
    },
    readPane: async () => ({ revision: 7, text: "Fred's fictional lantern" }),
  });
  expect(capture).toMatchObject({ hostBlockId: note.id, detailClientId: "fred-detail" });
}, 20_000);

test("outliner outlines lists an adopted database once, with a status from the host", async () => {
  const root = scratch();
  const stateRoot = join(root, "state");
  const uncleFolder = join(root, "uncle-folder");
  const auntFolder = join(root, "aunt-folder");
  mkdirSync(uncleFolder);
  mkdirSync(auntFolder);
  // Two slice-1 stored outlines; the host adopts one of them.
  for (const folder of [uncleFolder, auntFolder]) {
    const stored = resolvePaths(envFor(root, folder));
    mkdirSync(stored.stateDir, { recursive: true });
    new OutlinerStore(stored.database, { workspaceRoot: folder }).close();
  }
  const host = await startHost(stateRoot);
  await host.adopt(resolvePaths(envFor(root, uncleFolder)).database, "uncle", uncleFolder);
  await host.create("bob");
  const list = async () => {
    const run = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "outlines", "--json"], {
      env: { PATH: process.env.PATH, OUTLINER_STATE_DIR: stateRoot, XDG_CONFIG_HOME: join(root, "config"), OUTLINER_WORKSPACE_ROOT: root },
      cwd: root, timeout: 15_000, stdout: "pipe", stderr: "pipe",
    });
    const [stdout] = await Promise.all([new Response(run.stdout).text(), run.exited]);
    return (JSON.parse(stdout) as { outlines: { hosted: boolean; name?: string; status: string; stateDir?: string }[] }).outlines;
  };
  const rows = await list();
  expect(rows.filter(row => !row.hosted).map(row => row.stateDir)).toEqual([resolvePaths(envFor(root, auntFolder)).stateDir]);
  expect(rows.filter(row => row.hosted).map(row => [row.name, row.status])).toEqual([["bob", "running"], ["uncle", "stopped"]]);
  await host.closeOutline("bob");
  rmSync(realpathSync(hostedOutlinePaths(stateRoot, "uncle").database));
  expect((await list()).filter(row => row.hosted).map(row => [row.name, row.status])).toEqual([["bob", "stopped"], ["uncle", "broken"]]);
}, 30_000);

test("a hosted outline takes mentions from folders bound to it, and refuses other folders", async () => {
  const root = scratch();
  const saved = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, OUTLINER_STATE_DIR: process.env.OUTLINER_STATE_DIR };
  process.env.XDG_CONFIG_HOME = join(root, "config");
  process.env.OUTLINER_STATE_DIR = join(root, "state");
  cleanups.push(() => { for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : process.env[k] = v; });
  const host = await startHost(join(root, "state"), "fred");
  await host.create("fred");
  const bound = join(root, "projects", "jam-shelf");
  const other = join(root, "projects", "tin-drawer");
  mkdirSync(bound, { recursive: true });
  mkdirSync(other, { recursive: true });
  writeClientConfig(envFor(root, bound), { mode: "host", workspaceRoot: bound, outline: "fred" });
  const fred = new OutlinerClient(host.socketPath, 3_000, "fred");
  const message = (workspaceRoot: string, messageId: string) => ({ workspaceRoot, agent: "claude", sessionId: "fictional-session", messageId, text: "Mentions PIE-1 in passing." });
  const accepted = await fred.request({ action: "mentions.ingest", message: message(bound, "m1") }).catch((e: Error) => e.message);
  expect(accepted).not.toBeTypeOf("string");
  await expect(fred.request({ action: "mentions.ingest", message: message(other, "m2") })).rejects.toThrow("Mention workspace does not match");
});
