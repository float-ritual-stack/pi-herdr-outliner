import { Database } from "bun:sqlite";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Holds `lockPath` (a SQLite writer reservation) until the returned release is
 * called; throws `SQLITE_BUSY` wrapped as "already owned" while another holder
 * has it. The file stores no data. Never unlink it: contenders would then lock
 * different files.
 */
export function acquireLockFile(lockPath: string, what = "Outliner workspace"): () => void {
  const ownership = new Database(lockPath, { create: true });
  try {
    ownership.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;");
    return () => ownership.close();
  } catch (error) {
    ownership.close();
    if (error instanceof Error && "code" in error && error.code === "SQLITE_BUSY") {
      throw new Error(`${what} is already owned: ${lockPath.replace(/\.owner\.sqlite$/, "")}`, { cause: error });
    }
    throw error;
  }
}

export function acquireWorkspaceOwnership(databasePath: string): () => void {
  const canonicalPath = existsSync(databasePath)
    ? realpathSync(databasePath)
    : join(realpathSync(dirname(databasePath)), basename(databasePath));
  // One SQLite writer reservation owns the workspace; the sidecar stores no data.
  // Keep its inode: unlinking it would let contenders lock different files.
  return acquireLockFile(`${canonicalPath}.owner.sqlite`);
}
