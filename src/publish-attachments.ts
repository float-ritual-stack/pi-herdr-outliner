import { lstatSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, sep } from "node:path";
import { MAX_TEXT_FILE_BYTES, resolveReferencedPath } from "./files";

/**
 * Which files the publisher may serve. A published block's `[file::path]` is
 * read through the service's `files.read` (the same attachment model Detail
 * uses); this module decides first whether that path may leave the machine.
 */

export type PublishedFileType = "html" | "markdown" | "text";

export const PUBLISHED_FILE_TYPES: Readonly<Record<string, PublishedFileType>> = {
  ".html": "html",
  ".htm": "html",
  ".md": "markdown",
  ".markdown": "markdown",
  ".txt": "text",
};

export type AttachmentRefusal =
  | "parent-segment"
  | "outside-roots"
  | "hidden-path"
  | "missing"
  | "not-a-file"
  | "too-large"
  | "unsupported-type"
  | "no-roots";

export type AttachmentCheck =
  | {
    ok: true;
    /** The canonical path (symlinks resolved) that is inside an allowed root. */
    path: string;
    type: PublishedFileType;
    size: number;
    mtimeNs: string;
    updatedAt: string;
  }
  | { ok: false; refusal: AttachmentRefusal; reason: string };

export interface AttachmentPolicy {
  /** Canonical allowed roots (see `canonicalPublishRoots`). */
  readonly roots: readonly string[];
  /** Relative `[file::]` paths resolve against this, as the service resolves them. */
  readonly workspaceRoot: string;
  readonly maxBytes: number;
  readonly homeDirectory?: string;
}

/**
 * Resolves each configured root to its real path. A root that does not exist is
 * dropped (and reported); `/` is refused outright, since it would allow every file.
 */
export function canonicalPublishRoots(roots: readonly string[]): { roots: string[]; problems: string[] } {
  const canonical: string[] = [];
  const problems: string[] = [];
  for (const root of roots) {
    let real: string;
    try {
      real = realpathSync(root);
      if (!statSync(real).isDirectory()) throw new Error("not a directory");
    } catch (error) {
      problems.push(`publish root ${root} is unavailable: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (real === sep) {
      problems.push(`publish root ${root} is the filesystem root; refused`);
      continue;
    }
    if (!canonical.includes(real)) canonical.push(real);
  }
  return { roots: canonical, problems };
}

function refuse(refusal: AttachmentRefusal, reason: string): AttachmentCheck {
  return { ok: false, refusal, reason };
}

/** The path of `path` below `root`, or null when it is not inside it. */
function inside(root: string, path: string): string | null {
  const fromRoot = relative(root, path);
  if (fromRoot === "") return "";
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) return null;
  return fromRoot;
}

/**
 * Decides whether an attachment may be served. Checks, in order: no `..`
 * segment in the authored path; the real path (every symlink resolved) lies
 * inside an allowed root; no hidden segment below that root (`.git`, `.env`,
 * `.ssh`); a regular file (not a device, FIFO, socket or directory); within the
 * size cap; and a servable type. It reads no content.
 */
export function checkAttachment(sourcePath: string, policy: AttachmentPolicy): AttachmentCheck {
  if (!policy.roots.length) return refuse("no-roots", "No publish roots are configured");
  if (sourcePath.includes("\0")) return refuse("parent-segment", "Attachment path contains a NUL byte");
  if (sourcePath.split(/[\\/]/).includes("..")) {
    return refuse("parent-segment", "Attachment path contains a .. segment");
  }
  let resolved: string;
  try {
    resolved = resolveReferencedPath(sourcePath, policy.workspaceRoot, policy.homeDirectory);
  } catch (error) {
    return refuse("outside-roots", error instanceof Error ? error.message : String(error));
  }
  let real: string;
  try {
    real = realpathSync(resolved);
  } catch {
    // A dangling link or a missing file: say only that it is missing.
    try { lstatSync(resolved); } catch { return refuse("missing", "Attachment does not exist"); }
    return refuse("missing", "Attachment is a dangling link");
  }
  let below: string | null = null;
  for (const root of policy.roots) {
    below = inside(root, real);
    if (below !== null) break;
  }
  if (below === null || below === "") return refuse("outside-roots", "Attachment is outside the publish roots");
  if (below.split(sep).some((segment) => segment.startsWith("."))) {
    return refuse("hidden-path", "Attachment is in a hidden file or folder");
  }
  let stat;
  try {
    stat = statSync(real, { bigint: true });
  } catch {
    return refuse("missing", "Attachment does not exist");
  }
  if (!stat.isFile()) return refuse("not-a-file", "Attachment is not a regular file");
  const cap = Math.min(policy.maxBytes, MAX_TEXT_FILE_BYTES);
  if (stat.size > BigInt(cap)) return refuse("too-large", `Attachment exceeds ${cap} bytes`);
  const type = PUBLISHED_FILE_TYPES[extname(real).toLowerCase()];
  if (!type) return refuse("unsupported-type", `Attachment type ${extname(real) || "(none)"} is not served`);
  return {
    ok: true,
    path: real,
    type,
    size: Number(stat.size),
    mtimeNs: stat.mtimeNs.toString(),
    updatedAt: new Date(Number(stat.mtimeMs)).toISOString(),
  };
}
