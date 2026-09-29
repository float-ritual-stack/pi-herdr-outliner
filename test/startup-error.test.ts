import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolvePaths } from "../src/paths";
import { OutlinerStore } from "../src/store";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("a constructor failure retains its cause and notifies Herdr before the service pane exits", async () => {
  const directory = mkdtempSync(join(tmpdir(), "outliner-startup-error-"));
  directories.push(directory);
  const env = {
    ...process.env,
    OUTLINER_STATE_DIR: directory,
    OUTLINER_WORKSPACE_ROOT: directory,
    OUTLINER_REMOTE: "0",
    OUTLINER_SOCKET_PATH: undefined,
    OUTLINER_INBOX_AGENT: "0",
    HERDR_ENV: "1",
    HERDR_SOCKET_PATH: undefined,
    HERDR_BIN_PATH: join(directory, "herdr"),
  };
  const paths = resolvePaths(env);
  const store = new OutlinerStore(paths.database);
  const root = store.bookmarksRoot();
  store.update(root.id, root.text.replace("type::virtual-branch", "type::wrong"), root.revision,
    { author: "user", actorId: "test" });
  store.close();
  const calls = join(directory, "notification.json");
  writeFileSync(env.HERDR_BIN_PATH, `#!${process.execPath}\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)));\n`);
  chmodSync(env.HERDR_BIN_PATH, 0o755);
  const child = Bun.spawn([process.execPath, "run", resolve("src/server-main.ts")], {
    env, stdout: "pipe", stderr: "pipe", timeout: 5_000,
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect(code).toBe(1);
  expect(stdout).not.toContain('"status":"ready"');
  const expected = `Bookmarks root ${root.id} has invalid reserved configuration`;
  const logPath = join(paths.stateDir, "service-startup-error.log");
  expect(stderr).toContain(expected);
  expect(stderr).toContain(logPath);
  expect(readFileSync(logPath, "utf8")).toContain(expected);
  const args = JSON.parse(readFileSync(calls, "utf8"));
  expect(args.slice(0, 4)).toEqual(["notification", "show", "Outliner service failed to start", "--body"]);
  expect(args[4]).toContain(expected);
  expect(args[4]).toContain(logPath);
});

test("opening errors survive a failed Herdr notification without exposing forwarded secrets", async () => {
  const directory = mkdtempSync(join(tmpdir(), "outliner-open-error-"));
  directories.push(directory);
  const secret = "not-a-real-credential-12345";
  const env = {
    ...process.env, OUTLINER_STATE_DIR: directory, OUTLINER_WORKSPACE_ROOT: directory,
    HERDR_ENV: "1", HERDR_BIN_PATH: join(directory, "missing-herdr"), TYPESAFE_API_KEY: secret,
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_cwd: join(directory, "invoking-project") }),
  };
  const child = Bun.spawn([process.execPath, "run", resolve("src/herdr-open.ts"), "--mode", secret], {
    env, stdout: "pipe", stderr: "pipe", timeout: 5_000,
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(code).toBe(1);
  expect(stderr).toContain("Invalid outliner open mode: <REDACTED>");
  expect(stderr).not.toContain(secret);
  // Opening must not create the invoking folder's state directory; the log goes to the state root.
  expect(existsSync(resolvePaths({ ...env, OUTLINER_WORKSPACE_ROOT: join(directory, "invoking-project") }).stateDir)).toBe(false);
  const log = readFileSync(join(directory, "open-startup-error.log"), "utf8");
  expect(log).toContain("Invalid outliner open mode: <REDACTED>");
  expect(log).not.toContain(secret);
});
