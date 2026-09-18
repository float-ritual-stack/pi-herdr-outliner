import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { OutlinerClient, type OutlinerWatcher } from "../src/client";
import { resolvePaths } from "../src/paths";
import { OutlinerServer } from "../src/server";
import { OutlinerStore } from "../src/store";
import type { OutlinerClientRegistration } from "../src/types";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("remote Herdr startup opens both client panes before waiting for registration", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-remote-herdr-"));
  temporaryDirectories.push(directory);
  const workspaceRoot = join(directory, "workspace");
  const stateRoot = join(directory, "state");
  mkdirSync(workspaceRoot);
  const canonical = resolvePaths({
    OUTLINER_WORKSPACE_ROOT: workspaceRoot,
    OUTLINER_STATE_DIR: stateRoot,
  });
  mkdirSync(canonical.stateDir, { recursive: true });
  const store = new OutlinerStore(canonical.database, { workspaceRoot });
  const server = new OutlinerServer(store, canonical.socket);
  await server.start();
  const foreignConnected = Promise.withResolvers<void>();
  const foreignWatcher = new OutlinerClient(canonical.socket).watch({
    client: {
      clientId: "float-box-tree",
      role: "tree",
      contextId: "float-box",
      runtime: {
        hostname: "float-box.invalid",
        paneId: "float-box-pane",
        workspaceId: "workspace",
        tabId: "tab",
      },
    } satisfies OutlinerClientRegistration,
    onConnect: foreignConnected.resolve,
    onEvent() {},
  });
  await foreignConnected.promise;

  const herdr = join(directory, "fake-herdr");
  const logPath = join(directory, "herdr-calls.jsonl");
  const configPath = join(directory, "client.json");
  writeFileSync(configPath, JSON.stringify({
    mode: "remote",
    socketPath: canonical.socket,
  }));
  writeFileSync(
    herdr,
    `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
if (args[0] === "pane" && args[1] === "get") {
  console.log(JSON.stringify({ result: { pane: {
    pane_id: "workspace:pane",
    foreground_cwd: ${JSON.stringify(workspaceRoot)},
    workspace_id: "workspace",
    tab_id: "workspace:tab",
  } } }));
} else if (args[0] === "plugin" && args[1] === "pane" && args[2] === "open") {
  const entrypoint = args[args.indexOf("--entrypoint") + 1];
  console.log(JSON.stringify({ result: { plugin_pane: { pane: {
    pane_id: "workspace:" + entrypoint,
  } } } }));
} else {
  console.log(JSON.stringify({ result: { type: "ok" } }));
}
`,
  );
  chmodSync(herdr, 0o755);

  let stopPaneRegistration = false;
  const registerOpenedPanes = (async (): Promise<OutlinerWatcher[]> => {
    const watchers: OutlinerWatcher[] = [];
    async function register(role: "tree" | "detail", paneId: string): Promise<void> {
      const connected = Promise.withResolvers<void>();
      watchers.push(new OutlinerClient(canonical.socket).watch({
        client: {
          clientId: `opened-local-${role}`,
          role,
          contextId: "opened-local-context",
          ...(role === "detail" ? { locked: false } : {}),
          runtime: {
            hostname: hostname(),
            paneId,
            workspaceId: "workspace",
            tabId: "workspace:tab",
          },
        },
        onConnect: connected.resolve,
        onEvent() {},
      }));
      await connected.promise;
    }
    while (!stopPaneRegistration) {
      const calls = (() => {
        try {
          return readFileSync(logPath, "utf8");
        } catch {
          return "";
        }
      })();
      // Neither client can become ready until both panes have been opened.
      if (
        calls.includes('"--entrypoint","outliner"') &&
        calls.includes('"--entrypoint","detail"')
      ) {
        await register("tree", "workspace:outliner");
        await register("detail", "workspace:detail");
        return watchers;
      }
      await Bun.sleep(10);
    }
    return watchers;
  })();

  try {
    const child = Bun.spawn([
      "bun",
      "run",
      "src/herdr-open.ts",
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HERDR_ENV: "1",
        HERDR_BIN_PATH: herdr,
        HERDR_PANE_ID: "workspace:pane",
        OUTLINER_WORKSPACE_ROOT: workspaceRoot,
        OUTLINER_STATE_DIR: stateRoot,
        OUTLINER_REMOTE: undefined,
        OUTLINER_SOCKET_PATH: undefined,
        OUTLINER_CONFIG_PATH: configPath,
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5_000,
      killSignal: "SIGKILL",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const result = JSON.parse(stdout) as Record<string, unknown>;
    expect(result.servicePane).toBeNull();
    expect(result.outlinerPane).toBe("workspace:outliner");
    expect(result.detailPane).toBe("workspace:detail");

    const calls = readFileSync(logPath, "utf8").trim().split("\n").map(
      (line) => JSON.parse(line) as string[],
    );
    const openedEntrypoints = calls
      .filter((args) => args[0] === "plugin" && args[1] === "pane" && args[2] === "open")
      .map((args) => args[args.indexOf("--entrypoint") + 1]);
    expect(openedEntrypoints).toEqual(["outliner", "detail"]);
    for (const args of calls.filter((call) => call.includes("--entrypoint"))) {
      expect(args).toContain(`OUTLINER_CONFIG_PATH=${configPath}`);
      expect(args).not.toContain("OUTLINER_REMOTE=1");
      expect(args).not.toContain(`OUTLINER_SOCKET_PATH=${canonical.socket}`);
    }
  } finally {
    stopPaneRegistration = true;
    const openedPaneWatchers = await registerOpenedPanes;
    await Promise.all(openedPaneWatchers.map((watcher) => watcher.stop()));
    await foreignWatcher.stop();
    await server.close();
    store.close();
  }
}, 10_000);
