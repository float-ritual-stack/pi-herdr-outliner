import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  resolveServicePaths,
  writeClientConfig,
} from "../src/paths";
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

  // A host is running: an unbound folder is the outline named after it...
  mkdirSync(stateRoot, { recursive: true });
  writeFileSync(hostSocket, "");
  expect(resolveClientPaths(envFor(root, jam))).toMatchObject({ mode: "host", outline: "jam-shelf", outlineSource: "folder" });
  // ...unless that outline records another folder of the same name: no silent merge.
  const otherJam = join(root, "elsewhere", "Jam Shelf");
  mkdirSync(otherJam, { recursive: true });
  mkdirSync(outlineHostPaths(stateRoot).outlines, { recursive: true });
  writeFileSync(join(outlineHostPaths(stateRoot).outlines, "jam-shelf.json"), JSON.stringify({ folder: jam }));
  expect(resolveClientPaths(envFor(root, jam))).toMatchObject({ mode: "host", outline: "jam-shelf", outlineSource: "folder" });
  expect(resolveClientPaths(envFor(root, otherJam)).mode).toBe("local");
  // ...but a folder that already has a hash database keeps it, and OUTLINER_REMOTE=0 forces the hash.
  const old = resolvePaths(envFor(root, oldFolder));
  mkdirSync(old.stateDir, { recursive: true });
  writeFileSync(old.database, "");
  expect(resolveClientPaths(envFor(root, oldFolder)).mode).toBe("local");
  expect(resolveClientPaths(envFor(root, jam, { OUTLINER_REMOTE: "0" })).mode).toBe("local");

  // The single-outline service ignores the host: the guess and OUTLINER_OUTLINE's client meaning do not apply, a binding is refused.
  expect(resolveServicePaths(envFor(root, jam)).socket).toBe(resolvePaths(envFor(root, jam)).socket);
  expect(() => resolveServicePaths(envFor(root, fredFolder))).toThrow('bound to the outline "bob"');
});

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
  // A name taken from a folder records that folder beside the outline.
  await control.request({ action: "outlines.attach", name: "aunt", create: true, folder: root });
  expect(JSON.parse(readFileSync(join(outlineHostPaths(stateRoot).outlines, "aunt.json"), "utf8"))).toEqual({ folder: root });
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
  const listed = await cli("list", "--outline=uncle", "--text", "fictional hat");
  expect(listed.code).toBe(0);
  expect(listed.stdout).toContain("Uncle's fictional hat");
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

/** herdr-open against a fake Herdr, with panes that register on `outline` once Herdr is asked to open them. */
async function openWithFakeHerdr(options: { root: string; host: OutlineHost; folder: string; outline: string; env?: Record<string, string> }) {
  const { root, host, folder, outline } = options;
  const herdr = join(root, "fake-herdr");
  const logPath = join(root, "herdr-calls.jsonl");
  writeFileSync(logPath, "");
  writeFileSync(herdr, `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
if (args[0] === "pane" && args[1] === "get") {
  console.log(JSON.stringify({ result: { pane: { pane_id: "workspace:pane", foreground_cwd: ${JSON.stringify(folder)}, cwd: ${JSON.stringify(folder)}, workspace_id: "workspace", tab_id: "workspace:tab" } } }));
} else if (args[0] === "plugin" && args[1] === "pane" && args[2] === "open") {
  console.log(JSON.stringify({ result: { plugin_pane: { pane: { pane_id: "workspace:" + args[args.indexOf("--entrypoint") + 1] } } } }));
} else {
  console.log(JSON.stringify({ result: { type: "ok" } }));
}
`);
  chmodSync(herdr, 0o755);
  let stop = false;
  const panes = (async (): Promise<OutlinerWatcher[]> => {
    while (!stop) {
      const calls = readFileSync(logPath, "utf8");
      if (calls.includes('"--entrypoint","outliner"') && calls.includes('"--entrypoint","detail"')) {
        const client = new OutlinerClient(host.socketPath, 3_000, outline);
        return (["tree", "detail"] as const).map(role => client.watch({
          client: { clientId: `${outline}-${role}`, role, contextId: `${outline}-context`, runtime: { hostname: hostname(), paneId: `workspace:${role === "tree" ? "outliner" : "detail"}`, workspaceId: "workspace", tabId: "workspace:tab" } },
          onEvent() {},
        }));
      }
      await Bun.sleep(10);
    }
    return [];
  })();
  try {
    const child = Bun.spawn(["bun", "run", "src/herdr-open.ts", "--mode", "open-here"], {
      cwd: join(import.meta.dir, ".."),
      env: {
        PATH: process.env.PATH, HOME: root, HERDR_ENV: "1", HERDR_BIN_PATH: herdr, HERDR_PANE_ID: "workspace:pane",
        OUTLINER_STATE_DIR: join(root, "state"), XDG_CONFIG_HOME: join(root, "config"), ...options.env,
      },
      stdout: "pipe", stderr: "pipe", timeout: 15_000, killSignal: "SIGKILL",
    });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const calls = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]);
    return { exitCode, stdout, stderr, calls };
  } finally {
    stop = true;
    await Promise.all((await panes).map(watcher => watcher.stop()));
  }
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
  const unbound = await openWithFakeHerdr({ root, host, folder: jam, outline: "jam-shelf" });
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
  const bound = await openWithFakeHerdr({ root, host, folder: fredFolder, outline: "fred" });
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
