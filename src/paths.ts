import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface OutlinerPaths {
  stateDir: string;
  database: string;
  socket: string;
  workspaceRoot: string;
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): OutlinerPaths {
  const workspaceRoot = resolve(env.OUTLINER_WORKSPACE_ROOT ?? process.cwd());
  const baseStateDir =
    env.OUTLINER_STATE_DIR ?? join(homedir(), ".local", "state", "pi-herdr-outliner");
  const workspaceKey = createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 12);
  const stateDir = join(baseStateDir, workspaceKey);

  return {
    stateDir,
    database: join(stateDir, "outliner.sqlite"),
    socket: join(stateDir, "outliner.sock"),
    workspaceRoot,
  };
}
