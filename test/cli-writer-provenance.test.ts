// The CLI records who wrote: `create`, `update`, `move`, `delete` and `restore` take --author/--actor/--session,
// and `activity` reads the record back. An agent's write through the CLI is attributed to the agent, not to the person.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePaths } from "../src/paths";
import { OutlinerServer } from "../src/server";
import { OutlinerStore } from "../src/store";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function runCli(args: string[], env: Record<string, string>) {
  const p = Bun.spawn(["bun", "src/cli.ts", ...args], {
    cwd: join(import.meta.dir, ".."), env: { ...process.env, ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { stdout, stderr, exitCode };
}

async function setup() {
  const stateDir = mkdtempSync(join(tmpdir(), "pi-outliner-cli-writer-state-"));
  const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-outliner-cli-writer-workspace-"));
  const env = { OUTLINER_STATE_DIR: stateDir, OUTLINER_WORKSPACE_ROOT: workspaceRoot };
  const paths = resolvePaths(env);
  const store = new OutlinerStore(paths.database);
  const server = new OutlinerServer(store, paths.socket);
  await server.start();
  cleanups.push(async () => {
    await server.close();
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  });
  return { env, store };
}

const entryFor = (activity: any, blockId: string) => (activity.entries as any[]).find(e => e.block?.id === blockId);

test("update --author agent --actor records the agent, and activity reads it back", async () => {
  const { env, store } = await setup();
  const note = store.create("Seed packets");
  const updated = await runCli(["update", "--id", note.id, "--text", "Seed packets, sorted", "--expected", String(note.revision), "--author", "agent", "--actor", "garden-agent", "--session", "s-1"], env);
  expect(updated.exitCode).toBe(0);
  const activity = await runCli(["activity", "--limit", "20", "--author", "agent"], env);
  expect(activity.exitCode).toBe(0);
  const entry = entryFor(JSON.parse(activity.stdout), note.id);
  expect(entry).toBeDefined();
  expect(entry.author).toBe("agent");
  expect(entry.actorId).toBe("garden-agent");
});

test("update without --author stays the person's, as before", async () => {
  const { env, store } = await setup();
  const note = store.create("Compost rota");
  expect((await runCli(["update", "--id", note.id, "--text", "Compost rota, weekly", "--expected", String(note.revision)], env)).exitCode).toBe(0);
  const entry = entryFor(JSON.parse((await runCli(["activity", "--limit", "20"], env)).stdout), note.id);
  expect(entry.author).toBe("user");
  expect(entry.actorId).toBe("cli");
});

test("create --author agent --actor records the agent as the creator", async () => {
  const { env, store } = await setup();
  const created = await runCli(["create", "--text", "Net the brassicas", "--author", "agent", "--actor", "garden-agent"], env);
  expect(created.exitCode).toBe(0);
  const id = JSON.parse(created.stdout).id;
  const block = store.get(id)!;
  expect(block.author).toBe("agent");
  expect(block.actorId).toBe("garden-agent");
});

test("a bad --author is refused before anything is written", async () => {
  const { env, store } = await setup();
  const note = store.create("Shed keys");
  const r = await runCli(["update", "--id", note.id, "--text", "x", "--expected", String(note.revision), "--author", "robot"], env);
  expect(r.exitCode).not.toBe(0);
  expect(r.stderr).toContain("--author must be user, agent, or system");
  expect(store.get(note.id)!.text).toBe("Shed keys");
});

test("move, delete and restore --author agent --actor record the agent, and activity --kinds reads them back", async () => {
  const { env, store } = await setup();
  const bed = store.create("North bed");
  const garlic = store.create("Garlic cloves");
  const agent = ["--author", "agent", "--actor", "garden-agent", "--session", "s-2"];
  const kinds = ["activity", "--limit", "20", "--author", "agent", "--kinds", "move,delete,restore"];

  expect((await runCli(["move", "--id", garlic.id, "--parent", bed.id, ...agent], env)).exitCode).toBe(0);
  expect(store.get(garlic.id)!.parentId).toBe(bed.id);
  let entry = entryFor(JSON.parse((await runCli(kinds, env)).stdout), garlic.id);
  expect([entry.kind, entry.author, entry.actorId, entry.sessionId]).toEqual(["move", "agent", "garden-agent", "s-2"]);

  expect((await runCli(["delete", "--id", garlic.id, ...agent], env)).exitCode).toBe(0);
  entry = entryFor(JSON.parse((await runCli(kinds, env)).stdout), garlic.id);
  expect([entry.kind, entry.actorId]).toEqual(["delete", "garden-agent"]);

  const restored = await runCli(["restore", "--id", garlic.id, ...agent], env);
  expect(restored.exitCode).toBe(0);
  expect(JSON.parse(restored.stdout).deletedAt).toBeFalsy();
  entry = entryFor(JSON.parse((await runCli(kinds, env)).stdout), garlic.id);
  expect([entry.kind, entry.actorId]).toEqual(["restore", "garden-agent"]);
});

test("move and delete without --author stay the person's, through the CLI", async () => {
  const { env, store } = await setup();
  const shelf = store.create("Potting shelf");
  const twine = store.create("Twine");
  expect((await runCli(["move", "--id", twine.id, "--parent", shelf.id], env)).exitCode).toBe(0);
  const entry = entryFor(JSON.parse((await runCli(["activity", "--kinds", "move"], env)).stdout), twine.id);
  expect([entry.kind, entry.author, entry.actorId]).toEqual(["move", "user", "cli"]);
  const bad = await runCli(["delete", "--id", twine.id, "--author", "robot"], env);
  expect(bad.exitCode).not.toBe(0);
  expect(bad.stderr).toContain("--author must be user, agent, or system");
  expect(store.get(twine.id)!.deletedAt).toBeFalsy();
});

test("--author agent without --actor is refused for every write, before anything is written", async () => {
  const { env, store } = await setup();
  const bench = store.create("Workbench");
  const gloves = store.create("Gloves");
  const cases = [
    ["create", "--text", "Unsigned note", "--author", "agent"],
    ["update", "--id", gloves.id, "--text", "Gloves, mended", "--expected", String(gloves.revision), "--author", "agent"],
    ["move", "--id", gloves.id, "--parent", bench.id, "--author", "agent"],
    ["delete", "--id", gloves.id, "--author", "agent"],
    ["restore", "--id", gloves.id, "--author", "agent", "--actor", " "],
  ];
  for (const args of cases) {
    const r = await runCli(args, env);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("--author agent requires --actor");
  }
  const after = store.get(gloves.id)!;
  expect([after.text, after.parentId, Boolean(after.deletedAt)]).toEqual(["Gloves", null, false]);
  expect(store.recentEditActivity({ author: "agent", kinds: ["text", "properties", "move", "delete", "restore"] }).entries).toEqual([]);
});
