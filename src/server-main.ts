import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HerdrRuntimeRegistry } from "./herdr-registry";
import { HerdrRegistryRunner } from "./herdr-runtime";
import { reportCurrentPaneWorkspace, registerServicePaneState, removeLegacyClientPaneStates } from "./pane-control";
import { establishOutlineIdentity, prepareOutlineIdentity, resolveOutlineServicePaths, withdrawByNameSocket } from "./outline-names";
import { OutlinerServer } from "./server";
import type { OutlinerServiceOutline } from "./types";
import { OutlinerStore } from "./store";
import { startOutlineInbox } from "./outline-inbox";
import { aiPromptDirectory, initializeAiPrompts } from "./ai-prompts";

import { reportStartupErrors } from "./startup-error";

await reportStartupErrors("service", async () => {
  const paths = resolveOutlineServicePaths();
  reportCurrentPaneWorkspace(paths.workspaceRoot);
  // Decided before anything is created, so a refused name leaves no new database behind.
  const identity = await prepareOutlineIdentity({
    stateRoot: paths.stateRoot, stateDir: paths.stateDir, workspaceRoot: paths.workspaceRoot,
    requestedName: process.env.OUTLINER_OUTLINE_NAME,
  });
  let outline: OutlinerServiceOutline | undefined;
  mkdirSync(paths.stateDir, { recursive: true });
  const paneStatePath = join(paths.stateDir, "service-pane.json");
  const store = new OutlinerStore(paths.database, { workspaceRoot: paths.workspaceRoot });
  const promptDirectory = aiPromptDirectory(process.env.OUTLINER_PROMPT_DIR ?? join(paths.stateDir, "prompts"));
  const herdrRegistry = new HerdrRuntimeRegistry();
  const herdrSocketPath = process.env.HERDR_SOCKET_PATH;
  const herdrRunner = herdrSocketPath === undefined ? null : new HerdrRegistryRunner(herdrRegistry, herdrSocketPath);
  const server = new OutlinerServer(store, paths.socket, herdrRunner ? herdrRegistry : undefined, promptDirectory);
  let ownsPaneState = false;
  try {
    if (process.env.OUTLINER_PROMPT_DIR === undefined) await initializeAiPrompts(promptDirectory);
    await server.start();
    ownsPaneState = true;
    // Optional in this slice: a failure is logged and the hash socket keeps serving.
    outline = await establishOutlineIdentity({
      stateRoot: paths.stateRoot, stateDir: paths.stateDir, socket: paths.socket, identity,
      log: message => console.error(`Outline name: ${message}`),
    });
    server.setOutline(outline);
    removeLegacyClientPaneStates(paths.stateDir);
    registerServicePaneState(paths.stateDir, paths.workspaceRoot);
    herdrRunner?.start();
  } catch (error) {
    try {
      await server.close();
    } catch (closeError) {
      console.error(`Failed to close outliner service after startup error: ${String(closeError)}`);
    }
    try {
      if (outline?.byNameSocket) withdrawByNameSocket(paths.stateRoot, outline.name, paths.socket);
    } catch (cleanupError) {
      console.error(`Failed to remove the outline's by-name socket after startup error: ${String(cleanupError)}`);
    }
    try {
      if (ownsPaneState) rmSync(paneStatePath, { force: true });
    } catch (cleanupError) {
      console.error(`Failed to remove outliner service pane state after startup error: ${String(cleanupError)}`);
    } finally {
      store.close();
    }
    throw error;
  }
  console.log(JSON.stringify({ status: "ready", socket: paths.socket, database: paths.database, ...(outline ? { outline: outline.name, ...(outline.byNameSocket ? { byNameSocket: outline.byNameSocket } : {}) } : {}) }));

  let stopping = false;
  startOutlineInbox(server, { workspaceRoot: paths.workspaceRoot, promptDirectory, stateDirectory: paths.stateDir, stopped: () => stopping });
  async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    let exitCode = 0;
    if (herdrRunner !== null) {
      try {
        await herdrRunner.stop();
      } catch (error) {
        exitCode = 1;
        console.error(`Failed to stop Herdr registry: ${String(error)}`);
      }
    }
    try {
      if (outline?.byNameSocket) withdrawByNameSocket(paths.stateRoot, outline.name, paths.socket);
    } catch (error) {
      exitCode = 1;
      console.error(`Failed to remove the outline's by-name socket: ${String(error)}`);
    }
    try {
      await server.close();
    } catch (error) {
      exitCode = 1;
      console.error(`Failed to close outliner service: ${String(error)}`);
    } finally {
      try {
        rmSync(paneStatePath, { force: true });
      } catch (error) {
        exitCode = 1;
        console.error(`Failed to remove outliner service pane state: ${String(error)}`);
      } finally {
        try {
          store.close();
        } catch (error) {
          exitCode = 1;
          console.error(`Failed to close outliner store: ${String(error)}`);
        } finally {
          process.exit(exitCode);
        }
      }
    }
  }

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("SIGHUP", stop);
});
