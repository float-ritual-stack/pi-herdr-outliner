import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, fchmodSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { ResourceCatalogError, type ResourceRevision } from "./resources";

type FileRevision = Extract<ResourceRevision, { kind: "filesystem" }>;

function hash(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function pendingPath(path: string): string {
  return join(dirname(path), `.outliner-save-${hash(basename(path)).slice(0, 24)}.pending`);
}

function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function sync(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function writeDurable(path: string, text: string, mode = 0o600): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, text, "utf8");
    fchmodSync(fd, mode);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

function restoreAbsentTarget(path: string, directory: string): void {
  const original = join(directory, "original");
  try {
    // A hard link publishes only into an absent pathname. An external writer's
    // new file always wins; never "recover" by renaming over it.
    linkSync(original, path);
    sync(dirname(path));
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") return;
    if (missing(error)) return; // Interruption before the source was displaced.
    throw error;
  }
}

/** Finish only this file's interrupted save. Caller verifies Source confinement. */
export function recoverFilesystemSave(path: string): void {
  const pending = pendingPath(path);
  let name: string;
  try {
    const fd = openSync(pending, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { name = readFileSync(fd, "utf8"); } finally { closeSync(fd); }
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  if (!/^\.outliner-save-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name)) {
    throw new Error("Invalid filesystem save recovery marker");
  }
  const directory = join(dirname(path), name);
  if (!lstatSync(directory).isDirectory()) throw new Error("Filesystem save recovery directory is unavailable");
  const metadataPath = join(directory, "save.json");
  const fd = openSync(metadataPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let metadata: { target?: unknown };
  try { metadata = JSON.parse(readFileSync(fd, "utf8")); } finally { closeSync(fd); }
  if (metadata.target !== basename(path)) throw new Error("Filesystem save recovery target disagrees");
  restoreAbsentTarget(path, directory);
  unlinkSync(pending);
  sync(dirname(path));
}

/**
 * Preserve the displaced inode, then publish without replacing any new target.
 * There is deliberately no automatic recovery-file deletion: another editor
 * can keep writing through an fd opened before our rename, even after we return.
 */
export function commitFilesystemText(
  path: string,
  text: string,
  expected: FileRevision,
  assertConfinement: () => void,
): void {
  recoverFilesystemSave(path);
  const directory = join(dirname(path), `.outliner-save-${randomUUID()}`);
  const original = join(directory, "original");
  const staged = join(directory, "staged");
  const pending = pendingPath(path);
  let pendingCreated = false;
  try {
    mkdirSync(directory, { mode: 0o700 });
    writeDurable(join(directory, "draft"), text);
    writeDurable(staged, text, Number(lstatSync(path).mode & 0o777));
    writeDurable(join(directory, "save.json"), `${JSON.stringify({
      target: basename(path), expectedRevision: expected, draftHash: hash(text),
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`);
    // Refuse filesystems without hard links before displacing anything.
    const probe = join(directory, "link-probe");
    linkSync(staged, probe);
    unlinkSync(probe);
    sync(directory);
    // Publish the recovery pointer durably before the first namespace change.
    writeDurable(pending, basename(directory));
    pendingCreated = true;
    sync(dirname(path));
    assertConfinement();
    sync(path);
    renameSync(path, original);
    sync(directory);
    sync(dirname(path));
    const displaced = lstatSync(original, { bigint: true });
    if (!displaced.isFile()) throw new Error("Filesystem Resource is no longer a regular file");
    sync(original);
    const unchanged = () => {
      const stat = lstatSync(original, { bigint: true });
      return stat.isFile() && stat.mtimeNs.toString() === expected.mtimeNs &&
        stat.size.toString() === expected.size && hash(readFileSync(original)) === expected.contentHash;
    };
    if (!unchanged()) throw new ResourceCatalogError("stale-revision", "Filesystem Resource changed during save");
    assertConfinement();
    try { linkSync(staged, path); } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
        throw new ResourceCatalogError("stale-revision", "Filesystem Resource changed during save");
      }
      throw error;
    }
    sync(dirname(path));
    if (!unchanged() || hash(readFileSync(path)) !== hash(text)) {
      throw new ResourceCatalogError("stale-revision", "Filesystem Resource changed during save");
    }
    unlinkSync(staged);
    sync(directory);
    unlinkSync(pending);
    sync(dirname(path));
  } catch (error) {
    let recoveryError = "";
    if (pendingCreated) {
      try {
        assertConfinement();
        recoverFilesystemSave(path);
      } catch (failure) {
        recoveryError = ` Recovery remains pending: ${failure instanceof Error ? failure.message : String(failure)}.`;
      }
    }
    throw new ResourceCatalogError(
      error instanceof ResourceCatalogError ? error.code : "source-unavailable",
      `${error instanceof Error ? error.message : String(error)}. Recoverable files: ${directory}.${recoveryError}`,
    );
  }
}
