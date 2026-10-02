import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { boundFolderOf, hostedOutlinePaths, outlineHostPaths, resolveFolderOutline, resolvePaths, writeClientConfig } from "../src/paths";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A fictional machine: a state root (with an outline host's records) and a config root under one scratch folder. */
function machine() {
  const root = mkdtempSync(join(tmpdir(), "bound-folder-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const env: NodeJS.ProcessEnv = { OUTLINER_STATE_DIR: join(root, "state"), XDG_CONFIG_HOME: join(root, "config"), HOME: home };
  mkdirSync(outlineHostPaths(env.OUTLINER_STATE_DIR!).outlines, { recursive: true });
  const folder = (...parts: string[]) => {
    const path = join(home, ...parts);
    mkdirSync(path, { recursive: true });
    return path;
  };
  /** An outline the host serves, with the root it records. */
  const hosted = (name: string, rootFolder: string, withDatabase = true) => {
    const { database } = hostedOutlinePaths(env.OUTLINER_STATE_DIR!, name);
    if (withDatabase) writeFileSync(database, "");
    writeFileSync(join(outlineHostPaths(env.OUTLINER_STATE_DIR!).outlines, `${name}.json`), JSON.stringify({ root: rootFolder }));
  };
  const bind = (workspaceRoot: string, outline: string) => writeClientConfig(env, { mode: "host", workspaceRoot, outline });
  return { root, home, env, folder, hosted, bind };
}

test("a folder bound by client.json, and its subfolders, use that binding", () => {
  const { env, folder, bind } = machine();
  const garden = folder("garden");
  const deep = folder("garden", "beds", "north");
  bind(garden, "fred-notes");
  expect(boundFolderOf(garden, env)).toMatchObject({ source: "client", folder: garden, mode: "host", outline: "fred-notes" });
  expect(boundFolderOf(deep, env)).toMatchObject({ source: "client", folder: garden, outline: "fred-notes" });
});

test("a nested binding is nearer than its parent's", () => {
  const { env, folder, bind } = machine();
  const garden = folder("garden");
  const shed = folder("garden", "shed", "tools");
  bind(garden, "fred-notes");
  bind(join(garden, "shed"), "shed-log");
  expect(boundFolderOf(shed, env)).toMatchObject({ folder: join(garden, "shed"), outline: "shed-log" });
  expect(boundFolderOf(join(garden), env)).toMatchObject({ folder: garden, outline: "fred-notes" });
});

test("an outline root the host serves binds it and its subfolders, the deeper of root and client.json winning", () => {
  const { env, folder, bind, hosted } = machine();
  const camp = folder("bandit-camp");
  const notes = folder("bandit-camp", "notes", "drafts");
  hosted("jam-shelf", join(camp, "notes"));
  expect(boundFolderOf(notes, env)).toEqual({ source: "host-root", folder: join(camp, "notes"), outline: "jam-shelf" });
  // A client.json above the root: the root is nearer.
  bind(camp, "fred-notes");
  expect(boundFolderOf(notes, env)).toMatchObject({ source: "host-root", outline: "jam-shelf" });
  expect(boundFolderOf(camp, env)).toMatchObject({ source: "client", outline: "fred-notes" });
  // At the same folder, its client.json.
  bind(join(camp, "notes"), "uncle-notes");
  expect(boundFolderOf(notes, env)).toMatchObject({ source: "client", folder: join(camp, "notes"), outline: "uncle-notes" });
});

test("a recorded root without its database, or claimed by two outlines, binds nothing", () => {
  const { env, folder, hosted, bind } = machine();
  const attic = folder("attic");
  hosted("ghost", attic, false);
  expect(boundFolderOf(attic, env)).toBeUndefined();
  hosted("bob", attic);
  hosted("bob-copy", attic);
  expect(boundFolderOf(attic, env)).toBeUndefined();
  // A client.json above an ambiguous root still does not reach past it.
  bind(folder(), "fred-notes");
  expect(boundFolderOf(attic, env)).toBeUndefined();
});

test("an unbound folder is never guessed: not by its repository's or its own name, nor by OUTLINER_OUTLINE or OUTLINER_CONFIG_PATH", () => {
  const { env, folder, hosted, root } = machine();
  const repository = folder("code", "jam-shelf");
  mkdirSync(join(repository, ".git"));
  const plain = folder("scratch-pad");
  // The host serves an outline the repository's name would guess, rooted elsewhere.
  hosted("fred-notes", folder("fred"));
  expect(resolveFolderOutline(join(repository), env).kind).toBe("guess");
  expect(resolveFolderOutline(plain, env).kind).toBe("guess");
  const config = join(root, "explicit-client.json");
  writeFileSync(config, JSON.stringify({ outline: "fred-notes" }));
  for (const extra of [{}, { OUTLINER_OUTLINE: "fred-notes" }, { OUTLINER_CONFIG_PATH: config }]) {
    expect(boundFolderOf(repository, { ...env, ...extra })).toBeUndefined();
    expect(boundFolderOf(plain, { ...env, ...extra })).toBeUndefined();
  }
});

test("`bound-folder` prints the binding as one JSON line, and an unbound folder as bound: false", async () => {
  const { env, folder, bind, hosted } = machine();
  const garden = folder("garden");
  bind(garden, "fred-notes");
  const camp = folder("bandit-camp");
  hosted("jam-shelf", camp);
  const plain = folder("scratch-pad");
  const run = async (args: string[], cwd: string) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "bound-folder", ...args], {
      cwd, env: { ...process.env, ...env, OUTLINER_WORKSPACE_ROOT: undefined, OUTLINER_OUTLINE: undefined, OUTLINER_CONFIG_PATH: undefined }, stdout: "pipe", stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { exitCode, stdout, stderr };
  };
  const inGarden = await run([join(garden, "beds")], plain);
  expect(inGarden.exitCode).toBe(0);
  expect(JSON.parse(inGarden.stdout)).toMatchObject({ bound: true, source: "client", folder: garden, mode: "host", outline: "fred-notes" });
  expect(JSON.parse((await run([], camp)).stdout)).toEqual({ bound: true, source: "host-root", folder: camp, outline: "jam-shelf" });
  expect(JSON.parse((await run([plain], garden)).stdout)).toEqual({ bound: false, folder: plain });
  expect((await run(["--json"], plain)).exitCode).toBe(2);
});

test("a root too broad to name an outline after ($HOME, /) binds nothing by itself; a client.json there still does", () => {
  const { env, home, folder, hosted, bind } = machine();
  const repo = folder("random-repo");
  hosted("inbox", home);
  expect(boundFolderOf(repo, env)).toBeUndefined();
  hosted("everything", "/");
  expect(boundFolderOf(repo, env)).toBeUndefined();
  bind(home, "fred-notes");
  expect(boundFolderOf(repo, env)).toMatchObject({ source: "client", folder: home, outline: "fred-notes" });
});

test("a folder with its own hash database is not its ancestor's binding (every client uses that database there)", () => {
  const { env, folder, bind } = machine();
  const garden = folder("garden");
  const shed = folder("garden", "shed");
  bind(garden, "fred-notes");
  const { database } = resolvePaths({ ...env, OUTLINER_WORKSPACE_ROOT: shed });
  mkdirSync(dirname(database), { recursive: true });
  writeFileSync(database, "");
  expect(boundFolderOf(shed, env)).toBeUndefined();
  expect(boundFolderOf(garden, env)).toMatchObject({ folder: garden });
});
