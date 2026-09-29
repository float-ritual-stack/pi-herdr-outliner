import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePaths, resolveClientPaths, resolveClientConfigPath, resolveStateRoot } from "./paths";
import { pluginInvocationWorkspaceRoot } from "./pane-control";
import { sanitizeDynamicText } from "./terminal";

/**
 * Opening must not create a workspace's state directory, so its log goes into
 * that directory only when it already exists, else into the state root, else
 * nowhere (stderr and the Herdr notification still carry the error).
 */
export function openStartupErrorLogPath(env: NodeJS.ProcessEnv): string | undefined {
  const { stateDir } = resolvePaths(env);
  if (existsSync(stateDir)) return join(stateDir, "open-startup-error.log");
  const stateRoot = resolveStateRoot(env);
  return existsSync(stateRoot) ? join(stateRoot, "open-startup-error.log") : undefined;
}

/** Startup panes can disappear on exit; keep the failure available outside them. */
export async function reportStartupErrors(
  operation: "service" | "open",
  start: () => Promise<void>,
): Promise<void> {
  try {
    await start();
  } catch (error) {
    let details = error instanceof Error ? error.stack ?? error.message : String(error);
    // A failed child command can include its arguments, including forwarded credentials.
    for (const [name, value] of Object.entries(process.env)) {
      if (value && /(?:KEY|TOKEN|PASSWORD|SECRET)$/.test(name)) {
        details = details.replaceAll(value, "<REDACTED>");
      }
    }
    details = sanitizeDynamicText(details, true);
    const title = operation === "service" ? "Outliner service failed to start" : "Outliner could not open";
    let location = "See herdr plugin log list --plugin float.pi-outliner --limit 1";
    try {
      const pathEnv = operation === "open" ? {
        ...process.env,
        OUTLINER_WORKSPACE_ROOT: process.env.OUTLINER_OPEN_WORKSPACE_ROOT?.trim() ||
          pluginInvocationWorkspaceRoot(process.env, process.env.OUTLINER_WORKSPACE_ROOT ?? process.cwd()),
      } : process.env;
      const { stateDir, workspaceRoot } = resolvePaths(pathEnv);
      let logPath: string | undefined;
      if (operation === "service") {
        mkdirSync(stateDir, { recursive: true });
        logPath = join(stateDir, "service-startup-error.log");
      } else {
        logPath = openStartupErrorLogPath(pathEnv);
      }
      if (!logPath) throw new Error("No existing state directory for the open log");
      let connection = '';
      try {
        const env={...process.env,OUTLINER_WORKSPACE_ROOT:workspaceRoot};
        const paths=resolveClientPaths(env);
        connection=`Config: ${resolveClientConfigPath(env)}\nConnection: ${paths.mode}\nEndpoint: ${paths.socket}\n${paths.mode==='local'?`Database: ${paths.database}`:paths.mode==='host'?`Outline: ${paths.outline} on the outline host`:'Database: on the remote service host'}\nRead-only diagnosis: bun src/cli.ts doctor (from the plugin checkout with OUTLINER_WORKSPACE_ROOT set to this workspace)\n`;
      } catch { /* The original configuration failure remains the primary error. */ }
      writeFileSync(logPath, `${new Date().toISOString()} ${title}\nWorkspace: ${workspaceRoot}\n${connection}${details}\n`, { mode: 0o600 });
      location = `Details: ${logPath}`;
    } catch {
      // Failure to save diagnostics must not hide the original error.
    }
    const message = `${title}: ${details.split("\n")[0]}\n${location}`;
    console.error(`${message}\n${details}`);
    if (process.env.HERDR_ENV === "1") {
      try {
        execFileSync(process.env.HERDR_BIN_PATH ?? "herdr", [
          "notification", "show", title, "--body", `${details.split("\n")[0]?.slice(0, 300)}\n${location}`,
        ], { stdio: "ignore", timeout: 2_000 });
      } catch {
        // Stderr and the retained log still work when Herdr itself is unavailable.
      }
    }
    process.exitCode = 1;
  }
}
