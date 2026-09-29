import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { OutlinerClient } from "../src/client";
import { byNameSocketPath, listKnownOutlines, readOutlineDescriptor, type OutlineDescriptor } from "../src/known-outlines";
import {
  prepareOutlineIdentity,
  publishByNameSocket,
  renameOutline,
  resolveOutlineServicePaths,
  setOutlineRoot,
  slugifyOutlineName,
  uniqueOutlineName,
  withdrawByNameSocket,
  writeOutlineDescriptor,
} from "../src/outline-names";
import { resolvePaths, writeClientConfig } from "../src/paths";
import type { OutlinerServiceStatus } from "../src/types";
import { launchService, scratchServiceEnv } from "./service-process";

const directories: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(closed => server.close(() => closed()))));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "outline-names-"));
  directories.push(directory);
  const stateRoot = join(directory, "state");
  const configHome = join(directory, "config");
  const env = (root: string): NodeJS.ProcessEnv => ({ OUTLINER_WORKSPACE_ROOT: root, OUTLINER_STATE_DIR: stateRoot, XDG_CONFIG_HOME: configHome });
  return { directory, stateRoot, configHome, configRoot: join(configHome, "pi-herdr-outliner", "projects"), env };
}

/** A stored outline: SQLite is never opened by these paths, so an empty file stands in. */
function storedOutline(env: NodeJS.ProcessEnv, descriptor?: Partial<OutlineDescriptor>) {
  const paths = resolvePaths(env);
  mkdirSync(paths.stateDir, { recursive: true });
  writeFileSync(paths.database, "");
  if (descriptor) {
    writeOutlineDescriptor(paths.stateDir, {
      name: "jam-shelf", root: paths.workspaceRoot, host: "fixture-host",
      created: "2026-01-01T00:00:00.000Z", updated: "2026-01-01T00:00:00.000Z", ...descriptor,
    });
  }
  return paths;
}

/** Something listening on a socket, standing in for a live service. */
async function listen(socket: string): Promise<void> {
  const server = createServer(connection => connection.destroy());
  servers.push(server);
  await new Promise<void>(ready => server.listen(socket, ready));
}

const now = new Date("2026-09-01T12:00:00.000Z");

test("names are short slugs derived from the folder, with a numeric suffix on collision", () => {
  expect(slugifyOutlineName("Jam Shelf")).toBe("jam-shelf");
  expect(slugifyOutlineName("Tïn_Drawer!!")).toBe("tin-drawer");
  expect(slugifyOutlineName("---")).toBe("outline");
  expect(slugifyOutlineName("a".repeat(40))).toHaveLength(32);
  expect(uniqueOutlineName("jam-shelf", new Set())).toBe("jam-shelf");
  expect(uniqueOutlineName("jam-shelf", new Set(["jam-shelf", "jam-shelf-2"]))).toBe("jam-shelf-3");
  const long = "b".repeat(32);
  expect(uniqueOutlineName(long, new Set([long]))).toBe(`${"b".repeat(30)}-2`);
});

test("a new outline gets a descriptor named from its folder; an existing descriptor keeps its name and takes the current root", async () => {
  const { directory, stateRoot, env } = fixture();
  const root = join(directory, "Jam Shelf");
  const paths = resolvePaths(env(root));
  const before = existsSync(stateRoot);
  const identity = await prepareOutlineIdentity({ stateRoot, stateDir: paths.stateDir, workspaceRoot: root, now, host: "fixture-host" });
  // Preparing reads only.
  expect(existsSync(stateRoot)).toBe(before);
  expect(identity).toEqual({
    descriptor: { name: "jam-shelf", root, host: "fixture-host", created: now.toISOString(), updated: now.toISOString() },
    descriptorPath: join(paths.stateDir, "outline.json"),
    byNameSocket: join(stateRoot, "by-name", "jam-shelf.sock"),
  });

  storedOutline(env(root), { name: "tin-drawer", label: "Tin drawer", root: "/tmp/fixture/elsewhere" });
  const later = new Date("2026-09-02T00:00:00.000Z");
  const refreshed = await prepareOutlineIdentity({
    stateRoot, stateDir: paths.stateDir, workspaceRoot: root, requestedName: "ignored-name", now: later, host: "fixture-host",
  });
  expect(refreshed.descriptor).toEqual({
    name: "tin-drawer", root, label: "Tin drawer", host: "fixture-host", created: "2026-01-01T00:00:00.000Z", updated: later.toISOString(),
  });
  writeOutlineDescriptor(paths.stateDir, refreshed.descriptor);
  expect(readOutlineDescriptor(paths.stateDir)).toEqual({ kind: "ok", descriptor: refreshed.descriptor });
  // The write is atomic: no temporary file is left beside it.
  expect(readdirSync(paths.stateDir).sort()).toEqual(["outline.json", "outliner.sqlite"]);
});

test("OUTLINER_OUTLINE_NAME names a new outline, a derived name takes a suffix, and a broken descriptor stops the start", async () => {
  const { directory, stateRoot, env } = fixture();
  storedOutline(env(join(directory, "a", "jam-shelf")), { name: "jam-shelf" });
  const second = resolvePaths(env(join(directory, "b", "jam-shelf")));
  const derived = await prepareOutlineIdentity({ stateRoot, stateDir: second.stateDir, workspaceRoot: second.workspaceRoot });
  expect(derived.descriptor.name).toBe("jam-shelf-2");

  const requested = await prepareOutlineIdentity({ stateRoot, stateDir: second.stateDir, workspaceRoot: second.workspaceRoot, requestedName: "tin-drawer" });
  expect(requested.descriptor.name).toBe("tin-drawer");
  await expect(prepareOutlineIdentity({ stateRoot, stateDir: second.stateDir, workspaceRoot: second.workspaceRoot, requestedName: "Tin Drawer" }))
    .rejects.toThrow("OUTLINER_OUTLINE_NAME must be a short slug");
  // An explicit name is a request, not a suggestion: taken means refused.
  await expect(prepareOutlineIdentity({ stateRoot, stateDir: second.stateDir, workspaceRoot: second.workspaceRoot, requestedName: "jam-shelf" }))
    .rejects.toThrow(`already belongs to the stopped outline for ${join(directory, "a", "jam-shelf")}`);

  const broken = storedOutline(env(join(directory, "c")));
  writeFileSync(join(broken.stateDir, "outline.json"), "{not json");
  await expect(prepareOutlineIdentity({ stateRoot, stateDir: broken.stateDir, workspaceRoot: broken.workspaceRoot })).rejects.toThrow("Could not read");
});

test("a name held by another outline refuses the start, naming both roots, whether that outline is live or stopped", async () => {
  const { directory, stateRoot, env } = fixture();
  const first = storedOutline(env(join(directory, "one", "jam-shelf")), { name: "jam-shelf" });
  // A copied state directory carries the same name.
  const copy = storedOutline(env(join(directory, "two", "jam-shelf")), { name: "jam-shelf" });
  const attempt = () => prepareOutlineIdentity({ stateRoot, stateDir: copy.stateDir, workspaceRoot: copy.workspaceRoot });
  await expect(attempt()).rejects.toThrow(`already belongs to the stopped outline for ${first.workspaceRoot}`);
  await expect(attempt()).rejects.toThrow(copy.workspaceRoot);

  await listen(first.socket);
  const live = await attempt().catch((error: Error) => error.message);
  expect(live).toContain(`already served by a running service for ${first.workspaceRoot}`);
  expect(live).toContain(copy.workspaceRoot);
});

test("the by-name link is created, replaces a stale link, refuses a live one and is removed only by its owner", async () => {
  const { directory, stateRoot, env } = fixture();
  const jam = storedOutline(env(join(directory, "jam-shelf")), { name: "jam-shelf" });
  const tin = storedOutline(env(join(directory, "tin-drawer")), { name: "tin-drawer" });
  const link = byNameSocketPath(stateRoot, "jam-shelf");

  expect(await publishByNameSocket(stateRoot, "jam-shelf", jam.socket)).toBe(link);
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  // Relative, so moving the whole state root keeps it valid.
  expect(readlinkSync(link)).toBe(relative(join(stateRoot, "by-name"), jam.socket));
  // Publishing again over its own link is fine.
  await publishByNameSocket(stateRoot, "jam-shelf", jam.socket);

  // A leftover link to a socket nobody serves is stale and gets replaced.
  rmSync(link);
  symlinkSync(tin.socket, link);
  await publishByNameSocket(stateRoot, "jam-shelf", jam.socket);
  expect(readlinkSync(link)).toBe(relative(join(stateRoot, "by-name"), jam.socket));

  // A link to a live socket is someone else's.
  rmSync(link);
  symlinkSync(tin.socket, link);
  await listen(tin.socket);
  await expect(publishByNameSocket(stateRoot, "jam-shelf", jam.socket)).rejects.toThrow("points at a running service");
  await expect(prepareOutlineIdentity({ stateRoot, stateDir: jam.stateDir, workspaceRoot: jam.workspaceRoot })).rejects.toThrow("already points at a running service");
  expect(withdrawByNameSocket(stateRoot, "jam-shelf", jam.socket)).toBe(false);
  expect(readlinkSync(link)).toBe(tin.socket);

  rmSync(link);
  await publishByNameSocket(stateRoot, "jam-shelf", jam.socket);
  expect(withdrawByNameSocket(stateRoot, "jam-shelf", jam.socket)).toBe(true);
  expect(existsSync(join(stateRoot, "by-name", "jam-shelf.sock"))).toBe(false);

  // A file that is not a link is never replaced.
  writeFileSync(link, "");
  await expect(publishByNameSocket(stateRoot, "jam-shelf", jam.socket)).rejects.toThrow("is not a by-name link");
});

test("outlines are listed by name, with state directories that have no descriptor yet, and client configs as aliases", async () => {
  const { directory, stateRoot, configRoot, env } = fixture();
  const jam = storedOutline(env(join(directory, "jam-shelf")), { name: "jam-shelf", label: "Jam shelf" });
  const tin = storedOutline(env(join(directory, "tin-drawer")), { name: "tin-drawer" });
  const bare = storedOutline(env(join(directory, "old-hash")));
  // A folder that points at the jam shelf by name, and one through its hash socket.
  writeClientConfig(env(join(directory, "fern-ledger")), {
    mode: "remote", workspaceRoot: join(directory, "fern-ledger"), socketPath: byNameSocketPath(stateRoot, "jam-shelf"),
  });
  writeClientConfig(env(join(directory, "quiet-attic")), { mode: "remote", workspaceRoot: join(directory, "quiet-attic"), socketPath: jam.socket });
  writeFileSync(tin.socket, "");
  await listen(jam.socket);

  const outlines = await listKnownOutlines({
    stateRoot, configRoot, pingTimeoutMs: 100,
    async ping(socket): Promise<OutlinerServiceStatus> {
      if (socket === jam.socket) return { status: "ready", protocolVersion: 1 };
      throw new Error("refused");
    },
  });
  expect(outlines).toHaveLength(3);
  const bySocket = new Map(outlines.map(outline => [outline.socket, outline]));
  expect(bySocket.get(jam.socket)).toMatchObject({
    name: "jam-shelf", label: "Jam shelf", root: jam.workspaceRoot, descriptor: "present", status: "running",
    byNameSocket: byNameSocketPath(stateRoot, "jam-shelf"),
    aliases: [join(directory, "fern-ledger"), join(directory, "quiet-attic")],
  });
  expect(bySocket.get(tin.socket)).toMatchObject({ name: "tin-drawer", label: "tin-drawer", root: tin.workspaceRoot, status: "stopped" });
  expect(bySocket.get(bare.socket)).toMatchObject({ descriptor: "missing", status: "stopped" });
  expect(bySocket.get(bare.socket)?.name).toBeUndefined();
});

test("a descriptor's root wins over the folder its hash came from, which becomes an alias", async () => {
  const { directory, stateRoot, configRoot, env } = fixture();
  const old = join(directory, "jam-shelf");
  const stored = storedOutline(env(old), { name: "jam-shelf", root: join(directory, "moved", "jam-shelf") });
  writeClientConfig(env(old), { mode: "local", workspaceRoot: old });
  const [outline] = await listKnownOutlines({ stateRoot, configRoot, pingTimeoutMs: 50 });
  expect(outline).toMatchObject({ socket: stored.socket, name: "jam-shelf", root: join(directory, "moved", "jam-shelf"), aliases: [old] });
});

test("set-root and rename change a stopped outline's descriptor and refuse while it is live", async () => {
  const { directory, stateRoot, env } = fixture();
  const jam = storedOutline(env(join(directory, "jam-shelf")), { name: "jam-shelf" });
  storedOutline(env(join(directory, "tin-drawer")), { name: "tin-drawer" });
  mkdirSync(join(directory, "tin-drawer"));
  const moved = join(directory, "moved", "jam-shelf");

  await expect(setOutlineRoot({ stateRoot, name: "jam-shelf", root: moved })).rejects.toThrow("is not a folder");
  mkdirSync(moved, { recursive: true });
  await expect(setOutlineRoot({ stateRoot, name: "no-such", root: moved })).rejects.toThrow('No outline named "no-such"');
  await expect(setOutlineRoot({ stateRoot, name: "jam-shelf", root: join(directory, "tin-drawer") }))
    .rejects.toThrow('already belongs to the outline "tin-drawer"');

  // Live: refused unless the running service already serves that root.
  await listen(jam.socket);
  await expect(setOutlineRoot({ stateRoot, name: "jam-shelf", root: moved, pingTimeoutMs: 50 })).rejects.toThrow("is running");
  await expect(renameOutline({ stateRoot, from: "jam-shelf", to: "fig-crate" })).rejects.toThrow("is running");
  await new Promise<void>(closed => servers.pop()!.close(() => closed()));
  rmSync(jam.socket, { force: true });

  const updated = await setOutlineRoot({ stateRoot, name: "jam-shelf", root: moved, now });
  expect(updated).toMatchObject({ name: "jam-shelf", root: moved, updated: now.toISOString(), created: "2026-01-01T00:00:00.000Z" });
  expect(readOutlineDescriptor(jam.stateDir)).toEqual({ kind: "ok", descriptor: updated });
  // Storage never moves.
  expect(existsSync(jam.database)).toBe(true);

  await expect(renameOutline({ stateRoot, from: "jam-shelf", to: "tin-drawer" })).rejects.toThrow('"tin-drawer" already belongs');
  await expect(renameOutline({ stateRoot, from: "jam-shelf", to: "Fig Crate" })).rejects.toThrow("must be a short slug");
  await publishByNameSocket(stateRoot, "jam-shelf", jam.socket);
  const renamed = await renameOutline({ stateRoot, from: "jam-shelf", to: "fig-crate", now });
  expect(renamed.name).toBe("fig-crate");
  expect(readOutlineDescriptor(jam.stateDir)).toMatchObject({ kind: "ok", descriptor: { name: "fig-crate", root: moved } });
  // The old link goes with the old name; the next start makes the new one.
  expect(existsSync(byNameSocketPath(stateRoot, "jam-shelf"))).toBe(false);
  let linked = true;
  try { lstatSync(byNameSocketPath(stateRoot, "jam-shelf")); } catch { linked = false; }
  expect(linked).toBe(false);
});

test("OUTLINER_OUTLINE selects a database by name, and a moved root is never given a second database", () => {
  const { directory, stateRoot, env } = fixture();
  const old = join(directory, "jam-shelf");
  const moved = join(directory, "moved", "jam-shelf");
  const stored = storedOutline(env(old), { name: "jam-shelf", root: moved });

  const named = resolveOutlineServicePaths({ OUTLINER_STATE_DIR: stateRoot, OUTLINER_OUTLINE: "jam-shelf", XDG_CONFIG_HOME: join(directory, "config") });
  expect(named).toMatchObject({ stateDir: stored.stateDir, database: stored.database, socket: stored.socket, workspaceRoot: moved, stateRoot });
  // An explicit root still wins; the service then records it in the descriptor.
  expect(resolveOutlineServicePaths({ ...env(old), OUTLINER_OUTLINE: "jam-shelf" }).workspaceRoot).toBe(old);
  expect(() => resolveOutlineServicePaths({ OUTLINER_STATE_DIR: stateRoot, OUTLINER_OUTLINE: "tin-drawer" })).toThrow('No outline named "tin-drawer"');
  expect(() => resolveOutlineServicePaths({ OUTLINER_STATE_DIR: stateRoot, OUTLINER_OUTLINE: "jam-shelf", OUTLINER_REMOTE: "1" })).toThrow("remote client mode");

  // Starting by folder at the new root would hash to an empty directory: refused, naming the way in.
  expect(() => resolveOutlineServicePaths(env(moved))).toThrow("start it with OUTLINER_OUTLINE=jam-shelf");
  // Every other folder resolves by its hash exactly as before.
  expect(resolveOutlineServicePaths(env(old))).toMatchObject({ stateDir: stored.stateDir });
  expect(resolveOutlineServicePaths(env(join(directory, "tin-drawer")))).toMatchObject(resolvePaths(env(join(directory, "tin-drawer"))));
});

test("a real service publishes its name: ping through by-name answers with the outline, and a clean stop removes the link", async () => {
  const root = mkdtempSync(join(tmpdir(), "outline-names-service-"));
  directories.push(root);
  mkdirSync(join(root, "jam-shelf"));
  const env = scratchServiceEnv(root, "jam-shelf");
  const paths = resolvePaths(env);
  const service = launchService(env);
  try {
    const ready = await service.startup();
    if (!ready) throw new Error(await service.stderr);
    const byName = join(root, "state", "by-name", "jam-shelf.sock");
    expect(ready).toMatchObject({ outline: "jam-shelf", byNameSocket: byName });
    const status = await new OutlinerClient(byName).request<OutlinerServiceStatus>({ action: "ping" });
    expect(status.capabilities).toContain("ping.outline");
    expect(status.outline).toEqual({ name: "jam-shelf", descriptorPath: join(paths.stateDir, "outline.json"), byNameSocket: byName });
    expect(JSON.parse(readFileSync(join(paths.stateDir, "outline.json"), "utf8"))).toMatchObject({ name: "jam-shelf", root: join(root, "jam-shelf") });

    // A second service for another folder with the same basename gets a suffixed name.
    mkdirSync(join(root, "other"));
    mkdirSync(join(root, "other", "jam-shelf"));
    const twin = launchService({ ...env, OUTLINER_WORKSPACE_ROOT: join(root, "other", "jam-shelf") });
    const twinReady = await twin.startup();
    expect(twinReady).toMatchObject({ outline: "jam-shelf-2" });
    twin.child.kill("SIGTERM");
    expect(await twin.child.exited).toBe(0);

    service.child.kill("SIGTERM");
    expect(await service.child.exited).toBe(0);
    let linked = true;
    try { lstatSync(byName); } catch { linked = false; }
    expect(linked).toBe(false);
    expect(existsSync(join(root, "state", "by-name", "jam-shelf-2.sock"))).toBe(false);
  } finally {
    if (service.child.exitCode === null) service.child.kill("SIGKILL");
    await service.child.exited;
  }
}, 30_000);

test("a moved root: stop, move the folder, set-root, start by name, and the by-name socket answers from the same database", async () => {
  const root = mkdtempSync(join(tmpdir(), "outline-names-move-"));
  directories.push(root);
  mkdirSync(join(root, "jam-shelf"));
  const env = scratchServiceEnv(root, "jam-shelf");
  const original = resolvePaths(env);
  const byName = join(root, "state", "by-name", "jam-shelf.sock");
  const services: ReturnType<typeof launchService>[] = [];
  const cli = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args], {
      env: { PATH: process.env.PATH, ...env }, stdout: "pipe", stderr: "pipe", timeout: 15_000,
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  };
  try {
    const first = launchService(env);
    services.push(first);
    if (!await first.startup()) throw new Error(await first.stderr);
    const created = await new OutlinerClient(byName).request<{ id: string }>({ action: "create", text: "A note on the jam shelf", parentId: null });

    // Live: set-root and rename are refused.
    mkdirSync(join(root, "moved"));
    const refused = await cli("outline", "rename", "jam-shelf", "fig-crate");
    expect(refused).toMatchObject({ code: 1 });
    expect(refused.stderr).toContain("is running");
    // …unless the running service already serves the root being recorded.
    const same = await cli("outline", "set-root", "jam-shelf", join(root, "jam-shelf"));
    expect(same).toMatchObject({ code: 0, stderr: "" });
    expect((await cli("outline", "set-root", "jam-shelf", join(root, "moved"))).stderr).toContain("is running for");
    const listed = JSON.parse((await cli("outlines", "--json")).stdout) as { outlines: { name?: string; status: string }[] };
    expect(listed.outlines).toEqual([expect.objectContaining({ name: "jam-shelf", status: "running" })]);

    first.child.kill("SIGTERM");
    expect(await first.child.exited).toBe(0);
    renameSync(join(root, "jam-shelf"), join(root, "moved", "jam-shelf"));
    const moved = join(root, "moved", "jam-shelf");
    const setRoot = await cli("outline", "set-root", "jam-shelf", moved, "--json");
    expect(setRoot.stderr).toBe("");
    expect(JSON.parse(setRoot.stdout)).toMatchObject({ name: "jam-shelf", root: moved });

    // Starting by folder at the new root would open a new, empty database: refused.
    const byFolder = launchService({ ...env, OUTLINER_WORKSPACE_ROOT: moved });
    services.push(byFolder);
    expect(await byFolder.startup()).toBeNull();
    expect(await byFolder.stderr).toContain("OUTLINER_OUTLINE=jam-shelf");
    // Only the startup error log is written; no second database.
    expect(existsSync(resolvePaths({ ...env, OUTLINER_WORKSPACE_ROOT: moved }).database)).toBe(false);

    // By name, the service finds the database under the old hash and serves the new root.
    const second = launchService({ ...env, OUTLINER_WORKSPACE_ROOT: undefined, OUTLINER_OUTLINE: "jam-shelf" });
    services.push(second);
    if (!await second.startup()) throw new Error(await second.stderr);
    const status = await new OutlinerClient(byName).request<OutlinerServiceStatus>({ action: "ping" });
    expect(status.location).toMatchObject({ workspaceRoot: moved, stateDirectory: original.stateDir });
    expect(status.outline?.name).toBe("jam-shelf");
    const read = await new OutlinerClient(byName).request<{ id: string; text: string }>({ action: "get", blockId: created.id });
    expect(read).toMatchObject({ id: created.id, text: "A note on the jam shelf" });
    second.child.kill("SIGTERM");
    expect(await second.child.exited).toBe(0);
  } finally {
    for (const service of services) if (service.child.exitCode === null) service.child.kill("SIGKILL");
    await Promise.all(services.map(service => service.child.exited));
  }
}, 45_000);

test("`outliner outlines` prints names, marks a database with no descriptor yet, and creates nothing", async () => {
  const { directory, stateRoot, configHome, env } = fixture();
  const jam = storedOutline(env(join(directory, "jam-shelf")), { name: "jam-shelf" });
  storedOutline(env(join(directory, "old-hash")));
  writeClientConfig(env(join(directory, "fern-ledger")), {
    mode: "remote", workspaceRoot: join(directory, "fern-ledger"), socketPath: byNameSocketPath(stateRoot, "jam-shelf"),
  });
  const listing = () => readdirSync(directory, { recursive: true }).map(String).sort();
  const before = listing();
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "outlines", ...args], {
      env: { PATH: process.env.PATH, OUTLINER_STATE_DIR: stateRoot, XDG_CONFIG_HOME: configHome, OUTLINER_WORKSPACE_ROOT: join(directory, "nowhere") },
      stdout: "pipe", stderr: "pipe", timeout: 15_000,
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  };
  const text = await run();
  expect(text).toMatchObject({ code: 0, stderr: "" });
  expect(text.stdout).toContain("jam-shelf  stopped  local");
  expect(text.stdout).toContain(`  address  ${byNameSocketPath(stateRoot, "jam-shelf")}`);
  expect(text.stdout).toContain(`  storage  ${jam.stateDir}`);
  expect(text.stdout).toContain(`  alias    ${join(directory, "fern-ledger")}`);
  expect(text.stdout).toContain("(no descriptor yet)  stopped  local");
  const json = JSON.parse((await run("--json")).stdout) as { stateRoot: string; outlines: { name?: string; descriptor?: string }[] };
  expect(json.stateRoot).toBe(stateRoot);
  expect(json.outlines.map(outline => outline.descriptor).sort()).toEqual(["missing", "present"]);
  expect(listing()).toEqual(before);
}, 30_000);

test("the outline chooser shows an outline's name beside its label", async () => {
  const { OutlineChooser, renderChooserFrame } = await import("../src/outline-chooser");
  const chooser = new OutlineChooser({ mode: "open-here", workspaceRoot: "/tmp/fixture/fern-ledger", rootSource: "the invoking pane's cwd" });
  chooser.setOutlines([{
    socket: "/tmp/fixture/state/a/outliner.sock", label: "Jam shelf", name: "jam-shelf", root: "/tmp/fixture/jam-shelf",
    aliases: [], location: "local", status: "running",
  }]);
  expect(renderChooserFrame(chooser, 90, 24).join("\n")).toContain("jam-shelf · /tmp/fixture/jam-shelf");
});
