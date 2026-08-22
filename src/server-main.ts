import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { registerPaneState } from "./pane-control";
import { resolvePaths } from "./paths";
import { OutlinerServer } from "./server";
import { OutlinerStore } from "./store";

const paths = resolvePaths();
mkdirSync(paths.stateDir, { recursive: true });
const paneStatePath = join(paths.stateDir, "service-pane.json");
const store = new OutlinerStore(paths.database);
const server = new OutlinerServer(store, paths.socket);
let ownsPaneState = false;
try {
  await server.start();
  ownsPaneState = true;
  registerPaneState(paths.stateDir, "service", paths.workspaceRoot);
} catch (error) {
  try {
    await server.close();
  } catch (closeError) {
    console.error(`Failed to close outliner service after startup error: ${String(closeError)}`);
  }
  store.close();
  if (ownsPaneState) rmSync(paneStatePath, { force: true });
  throw error;
}
console.log(JSON.stringify({ status: "ready", socket: paths.socket, database: paths.database }));

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  let exitCode = 0;
  try {
    await server.close();
  } catch (error) {
    exitCode = 1;
    console.error(`Failed to close outliner service: ${String(error)}`);
  } finally {
    store.close();
    rmSync(paneStatePath, { force: true });
    process.exit(exitCode);
  }
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("SIGHUP", stop);
