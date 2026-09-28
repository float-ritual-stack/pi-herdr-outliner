// The CLI records who wrote: `create` and `update` take --author/--actor/--session, and `activity` reads
// the record back. An agent's write through the CLI is attributed to the agent, not to the person.
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
