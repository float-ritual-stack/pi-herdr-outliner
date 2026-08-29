import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outlinerLinkUri } from "../src/outliner-links";
import { OutlinerClient } from "../src/client";
import { resolvePaths } from "../src/paths";
import { OutlinerServer } from "../src/server";
import { OutlinerStore } from "../src/store";

const repositoryRoot = join(import.meta.dir, "..");

test("Herdr link action delegates an exact block URI to shared focus and reveal", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-link-action-"));
  const workspaceRoot = join(directory, "workspace");
  const stateRoot = join(directory, "state");
  const paths = resolvePaths({
    ...process.env,
    OUTLINER_WORKSPACE_ROOT: workspaceRoot,
    OUTLINER_STATE_DIR: stateRoot,
  });
  const store = new OutlinerStore(paths.database);
  const target = store.create("Clickable target [type::decision]");
  const server = new OutlinerServer(store, paths.socket);
  await server.start();
  const connected = Promise.withResolvers<void>();
  const focused = Promise.withResolvers<void>();
  const watcher = new OutlinerClient(paths.socket).watch({
    client: { clientId: "herdr-link-tree", role: "tree", contextId: "herdr-link-tree" },
    onConnect: connected.resolve,
    onEvent: (event) => {
      if (event.domain === "ui") focused.resolve();
    },
  });
  await connected.promise;

  try {
    const clickedUrl = outlinerLinkUri("block", target.id);
    const processHandle = Bun.spawn(
      [process.execPath, "run", join(repositoryRoot, "src/herdr-link-open.ts")],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          HERDR_ENV: "1",
          HERDR_PLUGIN_CLICKED_URL: clickedUrl,
          HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
            invocation_source: "link_click",
            clicked_url: clickedUrl,
            focused_pane_cwd: workspaceRoot,
          }),
          OUTLINER_STATE_DIR: stateRoot,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const exitCode = await processHandle.exited;
    const stdout = await new Response(processHandle.stdout).text();
    const stderr = await new Response(processHandle.stderr).text();

    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      focused: true,
      target: "block",
      id: target.id,
      title: "Clickable target",
    });
    await focused.promise;
    expect(store.getSelection().selected?.id).toBe(target.id);
  } finally {
    await watcher.stop();
    await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
