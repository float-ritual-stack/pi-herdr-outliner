import { OutlinerServer } from "./server";
import { OutlinerStore } from "./store";
import { resolvePaths } from "./paths";

const paths = resolvePaths();
const store = new OutlinerStore(paths.database);
const server = new OutlinerServer(store, paths.socket);
await server.start();
console.log(JSON.stringify({ status: "ready", socket: paths.socket, database: paths.database }));

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await server.close();
  store.close();
  process.exit(0);
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
