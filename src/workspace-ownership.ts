import { Database } from "bun:sqlite";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export function acquireWorkspaceOwnership(databasePath: string): () => void {
  const canonicalPath = existsSync(databasePath)
    ? realpathSync(databasePath)
    : join(realpathSync(dirname(databasePath)), basename(databasePath));
  // One SQLite writer reservation owns the workspace; the sidecar stores no data.
  // Keep its inode: unlinking it would let contenders lock different files.
  const ownership = new Database(`${canonicalPath}.owner.sqlite`, { create: true });
  try {
    ownership.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;");
    return () => ownership.close();
  } catch (error) {
    ownership.close();
    if (error instanceof Error && "code" in error && error.code === "SQLITE_BUSY") {
      throw new Error(`Outliner workspace is already owned: ${canonicalPath}`, { cause: error });
    }
    throw error;
  }
}
