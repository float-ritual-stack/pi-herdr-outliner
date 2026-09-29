import { join } from "node:path";

/**
 * Runs the Herdr launcher again for one folder, as if the action had been
 * invoked from `paneId` in that folder. The outline chooser uses it to continue
 * an open, and the launcher uses it to start a stopped local outline's service.
 */
export function relaunchEnvironment(
  env: NodeJS.ProcessEnv,
  workspaceRoot: string,
  paneId?: string,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {
    ...env,
    OUTLINER_OPEN_WORKSPACE_ROOT: workspaceRoot,
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
      ...(paneId ? { focused_pane_id: paneId } : {}),
      focused_pane_cwd: workspaceRoot,
    }),
  };
  delete next.OUTLINER_CHOOSER_CONTEXT;
  // The caller's own pane (a popup, or none) must never pass for the invoking pane.
  delete next.HERDR_PANE_ID;
  return next;
}

export function relaunchArgs(mode: string, clientId?: string): string[] {
  return ["run", join(import.meta.dir, "herdr-open.ts"), "--mode", mode, ...(clientId ? ["--client", clientId] : [])];
}
