import { HerdrRuntimeRegistry } from "./herdr-registry";
import { HerdrRegistryRunner } from "./herdr-runtime";
import { OutlineHost } from "./outline-host";
import { startOutlineInbox } from "./outline-inbox";
import { resolveStateRoot } from "./paths";

/*
 * The outline host: one per user and machine, on `<state root>/outliner.sock`.
 * `OUTLINER_DEFAULT_OUTLINE` names the outline that requests without `outline`
 * reach; it must already be in `outlines/` (created or adopted). Outlines open
 * on their first request. A failure to start is said on stderr only: the host
 * has no per-folder state directory to log into, and makes none.
 */
// One outline's fault must not take the others down: log it and keep serving.
// A request's own failure is already answered as an error to that request.
// Faults that keep coming mean the host itself is unwell: after
// FAULT_LIMIT within FAULT_WINDOW_MS it exits with 1, so systemd restarts it clean.
const FAULT_LIMIT = 5;
const FAULT_WINDOW_MS = 60_000;
const faults: number[] = [];
let stopHost: ((failure: number) => Promise<void>) | undefined;
function contain(kind: string, detail: string): void {
  console.error(`Outline host: ${kind}, contained: ${detail}`);
  const now = Date.now();
  faults.push(now);
  while (faults.length > 0 && faults[0]! <= now - FAULT_WINDOW_MS) faults.shift();
  if (faults.length < FAULT_LIMIT) return;
  console.error(`Outline host: ${faults.length} contained faults within ${FAULT_WINDOW_MS / 1_000}s; exiting for a clean restart.`);
  if (stopHost) void stopHost(1);
  else process.exit(1);
  // A stop that hangs must not keep an unwell host alive.
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("uncaughtException", error => contain("uncaught error", error.stack ?? error.message));
process.on("unhandledRejection", reason => contain("unhandled rejection", reason instanceof Error ? reason.stack ?? reason.message : String(reason)));

try {
  const stateRoot = resolveStateRoot();
  const herdrSocketPath = process.env.HERDR_SOCKET_PATH;
  const herdrRegistry = herdrSocketPath === undefined ? undefined : new HerdrRuntimeRegistry();
  const herdrRunner = herdrRegistry && herdrSocketPath ? new HerdrRegistryRunner(herdrRegistry, herdrSocketPath) : null;
  let stopping = false;
  const defaultOutline = process.env.OUTLINER_DEFAULT_OUTLINE?.trim() || undefined;
  const host = new OutlineHost({
    stateRoot,
    defaultOutline,
    herdrRegistry,
    promptDirectory: process.env.OUTLINER_PROMPT_DIR,
    // The listener is the host: without it nothing is served, so exit for systemd to restart.
    onListenerError: error => {
      console.error(`Outline host listener failed: ${error.stack ?? error.message}`);
      void stop(1);
    },
    onOpen: outline => {
      console.error(`Outline "${outline.name}" open: ${outline.database}`);
      startOutlineInbox(outline.server, {
        workspaceRoot: outline.workspaceRoot, promptDirectory: outline.promptDirectory,
        stateDirectory: outline.stateDirectory, stopped: () => stopping,
      });
    },
  });
  await host.start();
  herdrRunner?.start();
  console.log(JSON.stringify({ status: "ready", socket: host.socketPath, outlines: host.outlinesFolder, ...(defaultOutline ? { defaultOutline } : {}) }));

  async function stop(failure = 0): Promise<void> {
    if (stopping) return;
    stopping = true;
    let exitCode = failure;
    try {
      await herdrRunner?.stop();
    } catch (error) {
      exitCode = 1;
      console.error(`Failed to stop Herdr registry: ${String(error)}`);
    }
    try {
      await host.close();
    } catch (error) {
      exitCode = 1;
      console.error(`Failed to close the outline host: ${String(error)}`);
    }
    process.exit(exitCode);
  }
  stopHost = stop;
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  process.on("SIGHUP", () => void stop());
} catch (error) {
  console.error(`Outline host failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
}
