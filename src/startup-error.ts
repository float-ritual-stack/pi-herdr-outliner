import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePaths, resolveClientPaths, resolveClientConfigPath } from "./paths";
import { pluginInvocationWorkspaceRoot } from "./pane-control";
import { sanitizeDynamicText } from "./terminal";

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
      const { stateDir, workspaceRoot } = resolvePaths(operation === "open" ? {
        ...process.env,
        OUTLINER_WORKSPACE_ROOT: pluginInvocationWorkspaceRoot(process.env,
          process.env.OUTLINER_WORKSPACE_ROOT ?? process.cwd()),
      } : process.env);
      mkdirSync(stateDir, { recursive: true });
      const logPath = join(stateDir, `${operation}-startup-error.log`);
      let connection = '';
      try {
        const env={...process.env,OUTLINER_WORKSPACE_ROOT:workspaceRoot};
        const paths=resolveClientPaths(env);
        connection=`Config: ${resolveClientConfigPath(env)}\nConnection: ${paths.mode}\nEndpoint: ${paths.socket}\n${paths.mode==='local'?`Database: ${paths.database}`:'Database: on the remote service host'}\nRead-only diagnosis: bun src/cli.ts doctor (from the plugin checkout with OUTLINER_WORKSPACE_ROOT set to this workspace)\n`;
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
