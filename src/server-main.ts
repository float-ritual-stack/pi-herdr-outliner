import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HerdrRuntimeRegistry } from "./herdr-registry";
import { HerdrRegistryRunner } from "./herdr-runtime";
import { reportCurrentPaneWorkspace, registerServicePaneState, removeLegacyClientPaneStates } from "./pane-control";
import { prepareOutlineIdentity, publishByNameSocket, resolveOutlineServicePaths, serviceOutline, withdrawByNameSocket, writeOutlineDescriptor } from "./outline-names";
import { OutlinerServer } from "./server";
import { OutlinerStore } from "./store";
import { createInboxModel, checkInboxModelConfiguration, inboxEditingBudget } from "./inbox-model";
import { createNoteModel } from "./note-assistance-model";
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
  const outlineName = identity.descriptor.name;
  mkdirSync(paths.stateDir, { recursive: true });
  const paneStatePath = join(paths.stateDir, "service-pane.json");
  const store = new OutlinerStore(paths.database, { workspaceRoot: paths.workspaceRoot });
  const promptDirectory = aiPromptDirectory(process.env.OUTLINER_PROMPT_DIR ?? join(paths.stateDir, "prompts"));
  const herdrRegistry = new HerdrRuntimeRegistry();
  const herdrSocketPath = process.env.HERDR_SOCKET_PATH;
  const herdrRunner = herdrSocketPath === undefined ? null : new HerdrRegistryRunner(herdrRegistry, herdrSocketPath);
  const server = new OutlinerServer(store, paths.socket, herdrRunner ? herdrRegistry : undefined, promptDirectory);
  server.setOutline(serviceOutline(identity));
  let ownsPaneState = false;
  let ownsByNameSocket = false;
  try {
    if (process.env.OUTLINER_PROMPT_DIR === undefined) await initializeAiPrompts(promptDirectory);
    await server.start();
    ownsPaneState = true;
    writeOutlineDescriptor(paths.stateDir, identity.descriptor);
    ownsByNameSocket = true;
    await publishByNameSocket(paths.stateRoot, outlineName, paths.socket);
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
      if (ownsByNameSocket) withdrawByNameSocket(paths.stateRoot, outlineName, paths.socket);
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
  console.log(JSON.stringify({ status: "ready", socket: paths.socket, database: paths.database, outline: outlineName, byNameSocket: identity.byNameSocket }));

  let stopping = false;
  // Loading provider configuration does not delay socket readiness or capture saves.
  if (process.env.OUTLINER_INBOX_AGENT !== "0") {
    server.setInboxUnavailable("Checking Inbox agent configuration");
    void checkInboxModelConfiguration({ workspaceRoot: paths.workspaceRoot }).then(configuration => {
      if (stopping) return;
      if (configuration.configured) {
        let timeoutMs: number;
        try { timeoutMs = inboxEditingBudget(); }
        catch (error) { server.setInboxUnavailable((error as Error).message); return; }
        const options = { timeoutMs, workspaceRoot: paths.workspaceRoot, promptDirectory, sessionDirectory: join(paths.stateDir, "assistant-sessions") };
        server.enableInbox(createInboxModel(options), process.env.TYPESAFE_API_KEY && process.env.OUTLINER_NOTE_ASSISTANCE !== "0"
          ? createNoteModel(options) : undefined);
      }
      else server.setInboxUnavailable(configuration.message);
    }).catch(() => {
      if (!stopping) server.setInboxUnavailable("Inbox model configuration could not be loaded");
    });
  }
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
      withdrawByNameSocket(paths.stateRoot, outlineName, paths.socket);
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
