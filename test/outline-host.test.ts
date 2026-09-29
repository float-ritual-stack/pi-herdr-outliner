import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutlinerClient } from "../src/client";
import { OutlineHost } from "../src/outline-host";
import { hostedOutlinePaths } from "../src/paths";
import { OutlinerStore } from "../src/store";
import type { Block, HostedOutlineList, HostedOutlineSummary, OutlinerEvent, OutlinerResponse, OutlinerServiceStatus } from "../src/types";
import { launchService, scratchServiceEnv } from "./service-process";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "outline-host-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

async function startHost(stateRoot: string, defaultOutline?: string): Promise<OutlineHost> {
  const host = new OutlineHost({ stateRoot, defaultOutline, log: () => {} });
  await host.start();
  cleanups.push(() => host.close());
  return host;
}

/** One request on its own connection, as clients send it, with any fields (such as `outline`). */
function send<T = unknown>(socketPath: string, request: Record<string, unknown>): Promise<OutlinerResponse & { result?: T }> {
  const answered = Promise.withResolvers<OutlinerResponse & { result?: T }>();
  const socket = createConnection(socketPath);
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("error", answered.reject);
  socket.once("connect", () => socket.write(`${JSON.stringify({ id: crypto.randomUUID(), ...request })}\n`));
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    socket.destroy();
    answered.resolve(JSON.parse(buffer.slice(0, newline)));
  });
  return answered.promise;
}

async function ok<T>(socketPath: string, request: Record<string, unknown>): Promise<T> {
  const response = await send<T>(socketPath, request);
  if (!response.ok) throw new Error(response.error);
  return response.result as T;
}

/** A subscription to one outline (or the default), collecting its events. */
async function subscribe(socketPath: string, outline?: string) {
  const events: OutlinerEvent[] = [];
  const socket = createConnection(socketPath);
  socket.setEncoding("utf8");
  const acknowledged = Promise.withResolvers<void>();
  const id = crypto.randomUUID();
  let buffer = "";
  socket.on("error", acknowledged.reject);
  socket.once("connect", () => socket.write(`${JSON.stringify({
    id, action: "events.subscribe", ...(outline ? { outline } : {}),
    client: { clientId: `watcher-${outline ?? "default"}`, contextId: `context-${outline ?? "default"}`, role: "tree" },
  })}\n`));
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      if ("event" in message) events.push(message.event);
      else if (message.id === id) message.ok ? acknowledged.resolve() : acknowledged.reject(new Error(message.error));
    }
  });
  cleanups.push(() => { socket.destroy(); });
  await acknowledged.promise;
  return { events, stop: () => socket.destroy() };
}

async function eventually(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

test("one socket serves two outlines, routed by the request's outline", async () => {
  const stateRoot = scratch();
  const host = await startHost(stateRoot, "bob");
  await host.create("bob");
  await host.create("fred");

  const bobNote = await ok<Block>(host.socketPath, { action: "create", outline: "bob", text: "Bob's fictional kettle" });
  const fredNote = await ok<Block>(host.socketPath, { action: "create", outline: "fred", text: "Fred's fictional compass" });

  expect((await ok<Block>(host.socketPath, { action: "get", outline: "bob", blockId: bobNote.id })).text).toBe("Bob's fictional kettle");
  expect((await ok<Block>(host.socketPath, { action: "get", outline: "fred", blockId: fredNote.id })).text).toBe("Fred's fictional compass");
  // Each outline has only its own notes.
  const bobInFred = await send(host.socketPath, { action: "get", outline: "fred", blockId: bobNote.id });
  expect(!bobInFred.ok && bobInFred.error).toContain("Block not found");
  const fredInBob = await send(host.socketPath, { action: "get", outline: "bob", blockId: fredNote.id });
  expect(!fredInBob.ok && fredInBob.error).toContain("Block not found");

  // A request without `outline` reaches the default, bob.
  expect((await ok<Block>(host.socketPath, { action: "get", blockId: bobNote.id })).text).toBe("Bob's fictional kettle");

  const fredPing = await ok<OutlinerServiceStatus>(host.socketPath, { action: "ping", outline: "fred" });
  expect(fredPing.outline?.name).toBe("fred");
  expect(fredPing.capabilities).toEqual(expect.arrayContaining(["blocks.read", "request.outline", "ping.host"]));
  expect(fredPing.host).toEqual({ socket: host.socketPath, defaultOutline: "bob", outlines: ["bob", "fred"] });
  expect(fredPing.location?.database).toBe(realpathSync(hostedOutlinePaths(stateRoot, "fred").database));
  expect(fredPing.location?.stateDirectory).toBe(hostedOutlinePaths(stateRoot, "fred").sideFolder);
  // Side files live in the outline's own folder.
  expect(existsSync(join(hostedOutlinePaths(stateRoot, "fred").sideFolder, "prompts"))).toBe(true);
});

test("an unnamed outline, an unknown outline and a bad name are refused without creating anything", async () => {
  const stateRoot = scratch();
  const host = await startHost(stateRoot, "bob");
  const missingDefault = await send(host.socketPath, { action: "get", blockId: "x" });
  expect(missingDefault.ok).toBe(false);
  expect(!missingDefault.ok && missingDefault.error).toContain('No outline named "bob"');
  const unknown = await send(host.socketPath, { action: "get", outline: "uncle", blockId: "x" });
  expect(!unknown.ok && unknown.error).toContain('No outline named "uncle"');
  const invalid = await send(host.socketPath, { action: "get", outline: "Not A Slug", blockId: "x" });
  expect(!invalid.ok && invalid.error).toContain("outline must be an outline name");
  expect(existsSync(hostedOutlinePaths(stateRoot, "bob").database)).toBe(false);
  expect(existsSync(hostedOutlinePaths(stateRoot, "uncle").database)).toBe(false);
  expect(host.list()).toEqual({ defaultOutline: "bob", outlines: [] });

  const noDefault = await startHost(scratch());
  const pong = await ok<OutlinerServiceStatus>(noDefault.socketPath, { action: "ping" });
  expect(pong.capabilities).toEqual(expect.arrayContaining(["outlines.create", "outlines.list", "ping.host"]));
  expect(pong.capabilities).not.toContain("blocks.read");
  expect(pong.host).toEqual({ socket: noDefault.socketPath, outlines: [] });
  const unnamed = await send(noDefault.socketPath, { action: "get", blockId: "x" });
  expect(!unnamed.ok && unnamed.error).toContain("no default outline");
});

test("a subscription on one outline does not see another outline's changes", async () => {
  const host = await startHost(scratch(), "bob");
  await host.create("bob");
  await host.create("fred");
  const bobWatch = await subscribe(host.socketPath);
  const fredWatch = await subscribe(host.socketPath, "fred");

  await ok(host.socketPath, { action: "create", outline: "fred", text: "Fred's fictional lantern" });
  await eventually(() => fredWatch.events.some(event => event.domain === "content"), "fred's content event");
  await ok(host.socketPath, { action: "create", outline: "bob", text: "Bob's fictional teapot" });
  await eventually(() => bobWatch.events.some(event => event.domain === "content"), "bob's content event");
  await Bun.sleep(50);

  const contentEvents = (events: OutlinerEvent[]) => events.filter(event => event.domain === "content");
  expect(contentEvents(bobWatch.events)).toHaveLength(1);
  expect(contentEvents(fredWatch.events)).toHaveLength(1);
});

test("an unmodified OutlinerClient talks to the host's default outline", async () => {
  const host = await startHost(scratch(), "bandit");
  await host.create("bandit");
  const client = new OutlinerClient(host.socketPath);
  const status = await client.requireCompatibleService(["blocks.read", "ping.outline"]);
  expect(status.outline?.name).toBe("bandit");
  expect(status.host?.defaultOutline).toBe("bandit");
  const note = await client.request<Block>({ action: "create", text: "Bandit's fictional bone" });
  expect((await client.request<Block>({ action: "get", blockId: note.id })).text).toBe("Bandit's fictional bone");

  const connected = Promise.withResolvers<void>();
  const events: OutlinerEvent[] = [];
  const watcher = client.watch({
    client: { clientId: "bandit-tree", contextId: "bandit-context", role: "tree" },
    onConnect: connected.resolve,
    onEvent: event => { events.push(event); },
  });
  cleanups.push(() => watcher.stop());
  await connected.promise;
  await client.request({ action: "create", text: "Bandit's second fictional bone" });
  await eventually(() => events.some(event => event.domain === "content"), "a content event on the default outline");
});

test("create makes a new empty outline and refuses a taken name", async () => {
  const stateRoot = scratch();
  const host = await startHost(stateRoot);
  const created = await ok<HostedOutlineSummary>(host.socketPath, { action: "outlines.create", name: "uncle" });
  expect(created).toEqual({ name: "uncle", database: hostedOutlinePaths(stateRoot, "uncle").database, adopted: false, open: true, default: false, root: hostedOutlinePaths(stateRoot, "uncle").sideFolder });

  const again = await send(host.socketPath, { action: "outlines.create", name: "uncle" });
  expect(!again.ok && again.error).toContain('An outline named "uncle" already exists');
  const badName = await send(host.socketPath, { action: "outlines.create", name: "../uncle" });
  expect(!badName.ok && badName.error).toContain("short slug");
  // A leftover side folder is not reused.
  mkdirSync(hostedOutlinePaths(stateRoot, "fred").sideFolder, { recursive: true });
  const leftover = await send(host.socketPath, { action: "outlines.create", name: "fred" });
  expect(!leftover.ok && leftover.error).toContain("refusing to reuse");
  expect(existsSync(hostedOutlinePaths(stateRoot, "fred").database)).toBe(false);
});

test("outlines.list shows each outline, open or not, and creates nothing", async () => {
  const stateRoot = scratch();
  const first = new OutlineHost({ stateRoot, log: () => {} });
  await first.start();
  await first.create("bob");
  await first.create("fred");
  await first.close();

  const host = await startHost(stateRoot, "fred");
  // The default opens with the host, before any request; bob opens on its first.
  expect(host.list().outlines.map(outline => [outline.name, outline.open])).toEqual([["bob", false], ["fred", true]]);
  await ok(host.socketPath, { action: "ping", outline: "bob" });
  const listed = await ok<HostedOutlineList>(host.socketPath, { action: "outlines.list" });
  expect(listed).toEqual({
    defaultOutline: "fred",
    outlines: [
      { name: "bob", database: hostedOutlinePaths(stateRoot, "bob").database, adopted: false, open: true, default: false, root: hostedOutlinePaths(stateRoot, "bob").sideFolder },
      { name: "fred", database: hostedOutlinePaths(stateRoot, "fred").database, adopted: false, open: true, default: true, root: hostedOutlinePaths(stateRoot, "fred").sideFolder },
    ],
  });
  expect(host.list()).toEqual(listed);
});

test("one outline failing to open does not affect the others", async () => {
  const stateRoot = scratch();
  const host = await startHost(stateRoot, "bob");
  await host.create("bob");
  await host.create("bandit");
  // uncle's database is not a database at all.
  writeFileSync(hostedOutlinePaths(stateRoot, "uncle").database, "these are fictional crumbs, not SQLite\n".repeat(200));
  const corrupt = await send(host.socketPath, { action: "ping", outline: "uncle" });
  expect(!corrupt.ok && corrupt.error).toContain('Outline "uncle" could not be opened');

  // fred's database is held by another owner.
  const held = hostedOutlinePaths(stateRoot, "fred").database;
  const owner = new OutlinerStore(held, { workspaceRoot: stateRoot });
  cleanups.push(() => owner.close());
  const locked = await send(host.socketPath, { action: "ping", outline: "fred" });
  expect(!locked.ok && locked.error).toContain("already owned");

  expect((await ok<OutlinerServiceStatus>(host.socketPath, { action: "ping" })).outline?.name).toBe("bob");
  const note = await ok<Block>(host.socketPath, { action: "create", outline: "bandit", text: "Bandit's fictional ball" });
  expect(note.text).toBe("Bandit's fictional ball");
  expect((await ok<HostedOutlineList>(host.socketPath, { action: "outlines.list" })).outlines.map(outline => [outline.name, outline.open]))
    .toEqual([["bandit", true], ["bob", true], ["fred", false], ["uncle", false]]);

  // The failure is not remembered: once the other owner lets go, fred opens.
  owner.close();
  cleanups.pop();
  expect((await ok<OutlinerServiceStatus>(host.socketPath, { action: "ping", outline: "fred" })).outline?.name).toBe("fred");
});

test("adopt serves a standalone service's database where it lies, refused while that service holds it", async () => {
  const elsewhere = scratch();
  const env = scratchServiceEnv(elsewhere, "fred-project");
  mkdirSync(env.OUTLINER_WORKSPACE_ROOT!, { recursive: true });
  const service = launchService({ ...env, OUTLINER_OUTLINE_NAME: "fred-project" });
  cleanups.push(async () => { service.child.kill("SIGKILL"); await service.child.exited; });
  const ready = await service.startup();
  if (!ready) throw new Error(`The standalone service did not start: ${await service.stderr}`);
  const standalone = new OutlinerClient(String(ready.socket));
  const note = await standalone.request<Block>({ action: "create", text: "Fred's fictional map, written before adoption" });
  const database = String(ready.database);

  const stateRoot = scratch();
  const host = await startHost(stateRoot, "fred");
  const refused = await send(host.socketPath, { action: "outlines.adopt", path: database, name: "fred" });
  expect(!refused.ok && refused.error).toContain("in use by another outliner process");
  expect(existsSync(hostedOutlinePaths(stateRoot, "fred").database)).toBe(false);

  service.child.kill("SIGTERM");
  await service.child.exited;
  const adopted = await ok<HostedOutlineSummary>(host.socketPath, { action: "outlines.adopt", path: database, name: "fred" });
  // fred is the default, so adopting it opens it at once and its lock is never left free.
  expect(adopted).toEqual({ name: "fred", database: realpathSync(database), adopted: true, open: true, default: true, root: env.OUTLINER_WORKSPACE_ROOT! });
  expect(JSON.parse(readFileSync(join(stateRoot, "outlines", "fred.json"), "utf8"))).toEqual({ root: env.OUTLINER_WORKSPACE_ROOT! });
  const link = hostedOutlinePaths(stateRoot, "fred").database;
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(readlinkSync(link)).toBe(realpathSync(database));
  // No side folder in the host: the adopted outline's side files stay beside its database.
  expect(existsSync(hostedOutlinePaths(stateRoot, "fred").sideFolder)).toBe(false);

  const client = new OutlinerClient(host.socketPath);
  expect((await client.request<Block>({ action: "get", blockId: note.id })).text).toBe("Fred's fictional map, written before adoption");
  const status = await client.request<OutlinerServiceStatus>({ action: "ping" });
  expect(status.location?.workspaceRoot).toBe(env.OUTLINER_WORKSPACE_ROOT!);
  expect(status.location?.stateDirectory).toBe(realpathSync(join(database, "..")));

  // The same database under a second name, a taken name, and a non-outliner file are refused.
  const twice = await send(host.socketPath, { action: "outlines.adopt", path: database, name: "uncle" });
  expect(!twice.ok && twice.error).toContain('already served by this host as "fred"');
  const taken = await send(host.socketPath, { action: "outlines.adopt", path: database, name: "fred" });
  expect(!taken.ok && taken.error).toContain('An outline named "fred" already exists');
  const notes = join(elsewhere, "fictional-notes.txt");
  writeFileSync(notes, "Uncle's fictional shopping list\n");
  const notSqlite = await send(host.socketPath, { action: "outlines.adopt", path: notes, name: "uncle" });
  expect(!notSqlite.ok && notSqlite.error).toContain("not an outliner database");
  const relative = await send(host.socketPath, { action: "outlines.adopt", path: "fictional.sqlite", name: "uncle" });
  expect(!relative.ok && relative.error).toContain("absolute path");
});

test("adopting a database that does not record its folder needs an explicit root", async () => {
  const elsewhere = scratch();
  const database = join(elsewhere, "bandit-state", "outliner.sqlite");
  const store = new OutlinerStore(database, { workspaceRoot: elsewhere });
  store.create("Bandit's fictional stick");
  store.close();
  const stateRoot = scratch();
  const host = await startHost(stateRoot);
  const guessed = await send(host.socketPath, { action: "outlines.adopt", path: database, name: "bandit" });
  expect(!guessed.ok && guessed.error).toContain("does not record the folder it belongs to");
  expect(existsSync(hostedOutlinePaths(stateRoot, "bandit").database)).toBe(false);
  const notFolder = await send(host.socketPath, { action: "outlines.adopt", path: database, name: "bandit", root: join(elsewhere, "missing-folder") });
  expect(!notFolder.ok && notFolder.error).toContain("is not a folder");
  const adopted = await ok<HostedOutlineSummary>(host.socketPath, { action: "outlines.adopt", path: database, name: "bandit", root: elsewhere });
  expect(adopted.root).toBe(elsewhere);
  expect((await ok<OutlinerServiceStatus>(host.socketPath, { action: "ping", outline: "bandit" })).location?.workspaceRoot).toBe(elsewhere);
});

test("a second host on the same state root is refused, and a connection stays with its first outline", async () => {
  const stateRoot = scratch();
  const host = await startHost(stateRoot, "bob");
  await host.create("bob");
  await host.create("fred");
  const second = new OutlineHost({ stateRoot, log: () => {} });
  await expect(second.start()).rejects.toThrow("outline host lock is already owned");
  expect((await ok<OutlinerServiceStatus>(host.socketPath, { action: "ping" })).outline?.name).toBe("bob");

  // Two lines on one connection: the second names another outline and is refused.
  const answers = await new Promise<OutlinerResponse[]>((settle, reject) => {
    const socket = createConnection(host.socketPath);
    socket.setEncoding("utf8");
    const received: OutlinerResponse[] = [];
    let buffer = "";
    socket.on("error", reject);
    socket.once("connect", () => socket.write(
      `${JSON.stringify({ id: "first", action: "ping", outline: "bob" })}\n${JSON.stringify({ id: "second", action: "ping", outline: "fred" })}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        received.push(JSON.parse(buffer.slice(0, newline)));
        buffer = buffer.slice(newline + 1);
      }
      if (received.length === 2) { socket.destroy(); settle(received); }
    });
  });
  expect(answers[0]!.ok).toBe(true);
  expect(!answers[1]!.ok && answers[1]!.error).toContain('serves the outline "bob"');
});

test("a single-outline service refuses host requests", async () => {
  const root = scratch();
  const store = new OutlinerStore(join(root, "outliner.sqlite"), { workspaceRoot: root });
  const { OutlinerServer } = await import("../src/server");
  const server = new OutlinerServer(store, join(root, "outliner.sock"));
  await server.start();
  cleanups.push(async () => { await server.close(); store.close(); });
  const response = await send(join(root, "outliner.sock"), { action: "outlines.list" });
  expect(!response.ok && response.error).toContain("answered by an outline host");
  const status = await ok<OutlinerServiceStatus>(join(root, "outliner.sock"), { action: "ping" });
  expect(status.host).toBeUndefined();
  expect(status.capabilities).not.toContain("request.outline");
});

test("the host process and the outlines CLI: create, adopt refusals and list go through the host", async () => {
  const root = scratch();
  const env = { PATH: process.env.PATH, OUTLINER_STATE_DIR: join(root, "state"), XDG_CONFIG_HOME: join(root, "config"), OUTLINER_INBOX_AGENT: "0", OUTLINER_DEFAULT_OUTLINE: "bob" };
  const cli = (...args: string[]) => {
    const run = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args], { env, cwd: root, timeout: 15_000 });
    return { code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
  };
  // Without a host, create is refused rather than made some other way.
  const offline = cli("outline", "create", "bob");
  expect(offline.code).toBe(1);
  expect(offline.stderr).toContain("No outline host is running");

  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/host-main.ts")], { env, stdout: "pipe", stderr: "pipe", timeout: 15_000, killSignal: "SIGKILL" });
  cleanups.push(async () => { child.kill("SIGTERM"); await child.exited; });
  const reader = child.stdout.getReader();
  let output = "";
  while (!output.includes("\n")) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`The host exited: ${await new Response(child.stderr).text()}`);
    output += new TextDecoder().decode(chunk.value);
  }
  reader.releaseLock();
  expect(JSON.parse(output.split("\n")[0]!)).toEqual({ status: "ready", socket: join(root, "state", "outliner.sock"), outlines: join(root, "state", "outlines"), defaultOutline: "bob" });

  expect(cli("outline", "create", "bob").code).toBe(0);
  const duplicate = cli("outline", "create", "bob");
  expect(duplicate.code).toBe(1);
  expect(duplicate.stderr).toContain('An outline named "bob" already exists');
  const missing = cli("outline", "adopt", "fictional-missing.sqlite", "fred");
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain(`No database at ${join(root, "fictional-missing.sqlite")}`);

  const listed = cli("outlines", "--json");
  expect(listed.code).toBe(0);
  const parsed = JSON.parse(listed.stdout);
  expect(parsed.host).toEqual({ socket: join(root, "state", "outliner.sock"), defaultOutline: "bob" });
  expect(parsed.outlines.map((outline: HostedOutlineSummary & { hosted: boolean; status: string }) => [outline.name, outline.hosted, outline.default, outline.open, outline.status]))
    .toEqual([["bob", true, true, true, "running"]]);
  expect(cli("outlines").stdout).toContain("bob  hosted  open  default");
});
