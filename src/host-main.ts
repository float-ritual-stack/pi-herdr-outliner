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

  async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    let exitCode = 0;
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
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("SIGHUP", stop);
} catch (error) {
  console.error(`Outline host failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
}
