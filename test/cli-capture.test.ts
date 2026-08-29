import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePaths } from "../src/paths";
import { OutlinerServer } from "../src/server";
import { OutlinerStore } from "../src/store";

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function runCli(
  args: string[],
  env: Record<string, string>,
  stdin?: string,
): Promise<CliResult> {
  const process = Bun.spawn(["bun", "src/cli.ts", ...args], {
    cwd: join(import.meta.dir, ".."),
    env: { ...globalThis.process.env, ...env },
    stdin: stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (stdin !== undefined) {
    const sink = process.stdin;
    if (!sink) throw new Error("CLI stdin pipe was not created");
    sink.write(stdin);
    sink.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function setup() {
  const stateDir = mkdtempSync(join(tmpdir(), "pi-outliner-cli-capture-state-"));
  const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-outliner-cli-capture-workspace-"));
  const env = {
    OUTLINER_STATE_DIR: stateDir,
    OUTLINER_WORKSPACE_ROOT: workspaceRoot,
  };
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

test("captures literal multiline heredoc/stdin content and prints a compact receipt", async () => {
  const { env, store } = await setup();
  const origin = store.create("CLI origin");
  store.setSelection(origin.id);
  const input = [
    "A multiline thought.",
    "",
    "- literal $VARIABLE",
    "- literal $(command)",
    "- queer techno 🐢",
    "",
  ].join("\n");

  const result = await runCli([
    "capture",
    "--stdin",
    "--request-id",
    "cli-heredoc-1",
    "--captured-from",
    origin.id,
  ], env, input);
  expect(result).toEqual(expect.objectContaining({ exitCode: 0, stderr: "" }));
  const receipt = JSON.parse(result.stdout) as {
    blockId: string;
    inboxBlockId: string;
    source: string;
    capturedFromBlockId: string;
    deduplicated: boolean;
  };
  expect(receipt).toEqual(expect.objectContaining({
    source: "cli",
    capturedFromBlockId: origin.id,
    deduplicated: false,
  }));
  expect(store.require(receipt.blockId).text).toContain(
    "A multiline thought.\n\n- literal $VARIABLE\n- literal $(command)\n- queer techno 🐢",
  );
  expect(store.getSelection().selected?.id).toBe(origin.id);

  const replay = await runCli([
    "capture",
    "--text",
    "ignored retry",
    "--request-id",
    "cli-heredoc-1",
  ], env);
  expect(replay.exitCode).toBe(0);
  expect(JSON.parse(replay.stdout)).toEqual({ ...receipt, deduplicated: true });
});

test("auto-reads non-TTY stdin and rejects conflicting input modes", async () => {
  const { env } = await setup();
  const automatic = await runCli(["capture", "--request-id", "auto-stdin"], env, "auto stdin");
  expect(automatic.exitCode).toBe(0);
  expect(JSON.parse(automatic.stdout)).toEqual(expect.objectContaining({
    source: "cli",
    deduplicated: false,
  }));

  const conflict = await runCli([
    "capture",
    "--stdin",
    "--text",
    "conflict",
  ], env, "stdin");
  expect(conflict.exitCode).not.toBe(0);
  expect(conflict.stderr).toContain("capture accepts either --text or --stdin, not both");
});

test("reports service failure without writing a fallback", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "pi-outliner-cli-capture-offline-"));
  const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-outliner-cli-capture-offline-workspace-"));
  cleanups.push(async () => {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  });
  const result = await runCli([
    "capture",
    "--text",
    "offline",
    "--request-id",
    "offline-request",
  ], {
    OUTLINER_STATE_DIR: stateDir,
    OUTLINER_WORKSPACE_ROOT: workspaceRoot,
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("ENOENT");
});
