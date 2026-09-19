import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HerdrRuntimeRegistry } from "./herdr-registry";
import { HerdrRegistryRunner } from "./herdr-runtime";
import { registerServicePaneState, removeLegacyClientPaneStates } from "./pane-control";
import { resolveServicePaths } from "./paths";
import { OutlinerServer } from "./server";
import { OutlinerStore } from "./store";

const paths = resolveServicePaths();
mkdirSync(paths.stateDir, { recursive: true });
const paneStatePath = join(paths.stateDir, "service-pane.json");
const store = new OutlinerStore(paths.database, { workspaceRoot: paths.workspaceRoot });
const herdrRegistry = new HerdrRuntimeRegistry();
const herdrSocketPath = process.env.HERDR_SOCKET_PATH;
const herdrRunner = herdrSocketPath === undefined ? null : new HerdrRegistryRunner(herdrRegistry, herdrSocketPath);
const server = new OutlinerServer(store, paths.socket, herdrRunner ? herdrRegistry : undefined);
let ownsPaneState = false;
try {
  await server.start();
  ownsPaneState = true;
  removeLegacyClientPaneStates(paths.stateDir);
  registerServicePaneState(paths.stateDir, paths.workspaceRoot);
  herdrRunner?.start();
} catch (error) {
  try {
    await server.close();
  } catch (closeError) {
    console.error(`Failed to close outliner service after startup error: ${String(closeError)}`);
  }
  if (ownsPaneState) rmSync(paneStatePath, { force: true });
  store.close();
  throw error;
}
console.log(JSON.stringify({ status: "ready", socket: paths.socket, database: paths.database }));

let stopping = false;
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
    await server.close();
  } catch (error) {
    exitCode = 1;
    console.error(`Failed to close outliner service: ${String(error)}`);
  } finally {
    rmSync(paneStatePath, { force: true });
    store.close();
    process.exit(exitCode);
  }
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("SIGHUP", stop);
