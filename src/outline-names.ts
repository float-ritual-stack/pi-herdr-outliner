import { existsSync, lstatSync, mkdirSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  byNameLinkTarget,
  byNameSocketPath,
  findOutlineByName,
  OUTLINE_NAME_PATTERN,
  type OutlineDescriptor,
  outlineDescriptorPath,
  pingOutline,
  readOutlineDescriptor,
  scanStoredOutlines,
  socketAbsent,
} from "./known-outlines";
import { type OutlinerPaths, resolveServicePaths, resolveStateRoot, workspaceKey } from "./paths";
import type { OutlinerServiceOutline } from "./types";

/*
 * Outline names (PIE-457). An outline is addressed by the name in its
 * descriptor; the 12-character hash directory is only where it is stored.
 * Reading and listing live in known-outlines.ts; this module owns every write:
 * the descriptor, the by-name link, and the explicit rename and set-root.
 */

export function isOutlineName(name: string): boolean {
  return OUTLINE_NAME_PATTERN.test(name);
}

function requireOutlineName(name: string, what = "An outline name"): string {
  if (!isOutlineName(name)) {
    throw new Error(`${what} must be a short slug of lowercase letters, digits and hyphens (${OUTLINE_NAME_PATTERN.source}); got ${JSON.stringify(name)}`);
  }
  return name;
}

/** A name derived from a folder: its basename as a slug. */
export function slugifyOutlineName(text: string): string {
  const slug = text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "");
  return slug || "outline";
}

/** `base`, or `base-2`, `base-3`… the first one nobody else has, kept within 32 characters. */
export function uniqueOutlineName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, 32 - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The other databases in the state root that carry a name. */
function otherNamedOutlines(stateRoot: string, stateDir: string) {
  const own = resolve(stateDir);
  return scanStoredOutlines(stateRoot).flatMap(stored =>
    stored.stateDir !== own && stored.descriptor.kind === "ok" ? [{ ...stored, descriptor: stored.descriptor.descriptor }] : []);
}

export interface OutlineIdentity {
  descriptor: OutlineDescriptor;
  descriptorPath: string;
  byNameSocket: string;
}

export function serviceOutline(identity: OutlineIdentity): OutlinerServiceOutline {
  return { name: identity.descriptor.name, descriptorPath: identity.descriptorPath, byNameSocket: identity.byNameSocket };
}

export interface PrepareOutlineIdentityOptions {
  stateRoot: string;
  stateDir: string;
  workspaceRoot: string;
  /** `OUTLINER_OUTLINE_NAME`: the name for an outline that has no descriptor yet. */
  requestedName?: string;
  now?: Date;
  host?: string;
}

/**
 * Decides the descriptor a starting service will write, and refuses when its
 * name belongs to another outline. It reads only: nothing is written until the
 * service owns its database and socket.
 *
 * An existing descriptor keeps its name (only `outline rename` changes it) and
 * takes the current root. Without one, the name is `requestedName`, or the root's
 * basename as a slug with a numeric suffix if another outline has it.
 */
export async function prepareOutlineIdentity(options: PrepareOutlineIdentityOptions): Promise<OutlineIdentity> {
  const stateRoot = resolve(options.stateRoot);
  const stateDir = resolve(options.stateDir);
  const root = resolve(options.workspaceRoot);
  const existing = readOutlineDescriptor(stateDir);
  if (existing.kind === "invalid") {
    throw new Error(`${existing.error}. Fix or remove it; the service rewrites a missing descriptor on start.`);
  }
  const others = otherNamedOutlines(stateRoot, stateDir);
  const requested = options.requestedName?.trim();
  let name: string;
  if (existing.kind === "ok") name = existing.descriptor.name;
  else if (requested) name = requireOutlineName(requested, "OUTLINER_OUTLINE_NAME");
  else name = uniqueOutlineName(slugifyOutlineName(basename(root)), new Set(others.map(other => other.descriptor.name)));

  for (const other of others.filter(other => other.descriptor.name === name)) {
    const live = !await socketAbsent(other.socket);
    throw new Error(live
      ? `The outline name "${name}" is already served by a running service for ${other.descriptor.root} (${other.stateDir}); refusing to start a second "${name}" for ${root}.`
      : `The outline name "${name}" already belongs to the stopped outline for ${other.descriptor.root} (${other.stateDir}), so this outline for ${root} cannot use it. Rename one with \`outliner outline rename ${name} <new-name>\`.`);
  }

  const byNameSocket = byNameSocketPath(stateRoot, name);
  const target = byNameLinkTarget(byNameSocket);
  const ownSocket = join(stateDir, "outliner.sock");
  if (target && target !== ownSocket && !await socketAbsent(target)) {
    throw new Error(`${byNameSocket} already points at a running service (${target}); refusing to take the name "${name}" for ${root}.`);
  }

  const now = (options.now ?? new Date()).toISOString();
  const previous = existing.kind === "ok" ? existing.descriptor : undefined;
  return {
    descriptor: {
      name,
      root,
      ...(previous?.label ? { label: previous.label } : {}),
      host: options.host ?? hostname(),
      created: previous?.created ?? now,
      updated: now,
    },
    descriptorPath: outlineDescriptorPath(stateDir),
    byNameSocket,
  };
}

/** Writes `outline.json` atomically: a temporary file, then a rename over it. */
export function writeOutlineDescriptor(stateDir: string, descriptor: OutlineDescriptor): string {
  const path = outlineDescriptorPath(stateDir);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return path;
}

/**
 * Points `<stateRoot>/by-name/<name>.sock` at the service's real socket. It
 * replaces a link that already points there or at a socket nobody serves, and
 * refuses to replace anything else.
 */
export async function publishByNameSocket(stateRoot: string, name: string, socket: string): Promise<string> {
  const link = byNameSocketPath(stateRoot, name);
  const own = resolve(socket);
  if (pathPresent(link)) {
    const target = byNameLinkTarget(link);
    if (target === undefined) throw new Error(`${link} exists and is not a by-name link; refusing to replace it.`);
    if (target !== own && !await socketAbsent(target)) {
      throw new Error(`${link} points at a running service (${target}); refusing to replace it.`);
    }
  }
  mkdirSync(dirname(link), { recursive: true, mode: 0o700 });
  // Relative, so the link survives moving the whole state root.
  const temporary = `${link}.${process.pid}.tmp`;
  rmSync(temporary, { force: true });
  symlinkSync(relative(dirname(link), own), temporary);
  try {
    renameSync(temporary, link);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return link;
}

function pathPresent(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Removes the by-name link only while it still points at this service's socket. */
export function withdrawByNameSocket(stateRoot: string, name: string, socket: string): boolean {
  const link = byNameSocketPath(stateRoot, name);
  if (byNameLinkTarget(link) !== resolve(socket)) return false;
  unlinkSync(link);
  return true;
}

export interface OutlineServicePaths extends OutlinerPaths {
  stateRoot: string;
}

/**
 * Where a starting service keeps its outline. `OUTLINER_OUTLINE=<name>` selects
 * the database whose descriptor has that name, wherever its hash directory is,
 * and defaults the root to the descriptor's. Otherwise the root's hash decides,
 * as before; if that directory has no database but another outline's descriptor
 * already claims the root (it was moved there with `set-root`), the service
 * refuses rather than create a second outline for the same folder.
 */
export function resolveOutlineServicePaths(env: NodeJS.ProcessEnv = process.env): OutlineServicePaths {
  const stateRoot = resolve(resolveStateRoot(env));
  const selected = env.OUTLINER_OUTLINE?.trim();
  if (selected) {
    if (env.OUTLINER_REMOTE?.trim() === "1") {
      throw new Error("The Outliner service cannot start in remote client mode; start the canonical service on the remote host");
    }
    requireOutlineName(selected, "OUTLINER_OUTLINE");
    const stored = findOutlineByName(stateRoot, selected);
    if (!stored) {
      const names = scanStoredOutlines(stateRoot).flatMap(entry => entry.descriptor.kind === "ok" ? [entry.descriptor.descriptor.name] : []);
      throw new Error(`No outline named "${selected}" in ${stateRoot}${names.length ? `; named outlines there: ${names.sort().join(", ")}` : ""}. OUTLINER_OUTLINE never creates one.`);
    }
    return {
      stateRoot,
      stateDir: stored.stateDir,
      database: join(stored.stateDir, "outliner.sqlite"),
      socket: stored.socket,
      workspaceRoot: resolve(env.OUTLINER_WORKSPACE_ROOT?.trim() || stored.descriptor.descriptor.root),
    };
  }
  const paths = resolveServicePaths(env);
  if (!existsSync(paths.database)) {
    const claimed = scanStoredOutlines(stateRoot).find(stored =>
      stored.descriptor.kind === "ok" && resolve(stored.descriptor.descriptor.root) === paths.workspaceRoot);
    if (claimed?.descriptor.kind === "ok") {
      const { name } = claimed.descriptor.descriptor;
      throw new Error(`The outline "${name}" (${claimed.stateDir}) belongs to ${paths.workspaceRoot}; start it with OUTLINER_OUTLINE=${name} instead of creating a second outline for this folder.`);
    }
  }
  return { ...paths, stateRoot };
}

/** The stored outline with a name, or an error naming what exists. */
function requireNamedOutline(stateRoot: string, name: string) {
  const stored = findOutlineByName(stateRoot, name);
  if (!stored) throw new Error(`No outline named "${name}" in ${resolve(stateRoot)}. \`outliner outlines\` lists them.`);
  return { ...stored, descriptor: stored.descriptor.descriptor };
}

export interface OutlineCommandOptions {
  stateRoot: string;
  now?: Date;
  pingTimeoutMs?: number;
}

/**
 * `outliner outline set-root <name> <path>`: records the folder an outline now
 * belongs to. Storage never moves. It refuses while the outline's service is
 * running, unless that service already serves `path`.
 */
export async function setOutlineRoot(options: OutlineCommandOptions & { name: string; root: string }): Promise<OutlineDescriptor> {
  const stored = requireNamedOutline(options.stateRoot, options.name);
  const root = resolve(options.root);
  let isDirectory = false;
  try { isDirectory = statSync(root).isDirectory(); } catch { isDirectory = false; }
  if (!isDirectory) throw new Error(`${root} is not a folder; move the outline's folder there first.`);
  if (!await socketAbsent(stored.socket)) {
    const status = await pingOutline(stored.socket, options.pingTimeoutMs);
    const serving = status?.location?.workspaceRoot;
    if (serving === undefined || resolve(serving) !== root) {
      throw new Error(`The outline "${options.name}" is running${serving ? ` for ${serving}` : ""}; stop its service before changing its root.`);
    }
  }
  for (const other of otherNamedOutlines(options.stateRoot, stored.stateDir)) {
    if (resolve(other.descriptor.root) === root) {
      throw new Error(`${root} already belongs to the outline "${other.descriptor.name}" (${other.stateDir}).`);
    }
  }
  const hashed = join(resolve(options.stateRoot), workspaceKey(root));
  if (hashed !== stored.stateDir && existsSync(join(hashed, "outliner.sqlite"))) {
    throw new Error(`${root} already has its own database at ${hashed}; starting there by folder would open that one, not "${options.name}".`);
  }
  const descriptor = { ...stored.descriptor, root, updated: (options.now ?? new Date()).toISOString() };
  writeOutlineDescriptor(stored.stateDir, descriptor);
  return descriptor;
}

/**
 * `outliner outline rename <old> <new>`: renames a stopped outline. The old
 * by-name link goes; the service makes the new one on its next start.
 */
export async function renameOutline(options: OutlineCommandOptions & { from: string; to: string }): Promise<OutlineDescriptor> {
  requireOutlineName(options.to, "The new name");
  const stored = requireNamedOutline(options.stateRoot, options.from);
  if (options.from === options.to) return stored.descriptor;
  const holder = findOutlineByName(options.stateRoot, options.to);
  if (holder) throw new Error(`The name "${options.to}" already belongs to the outline for ${holder.descriptor.descriptor.root} (${holder.stateDir}).`);
  if (!await socketAbsent(stored.socket)) {
    throw new Error(`The outline "${options.from}" is running; stop its service before renaming it.`);
  }
  const descriptor = { ...stored.descriptor, name: options.to, updated: (options.now ?? new Date()).toISOString() };
  writeOutlineDescriptor(stored.stateDir, descriptor);
  withdrawByNameSocket(options.stateRoot, options.from, stored.socket);
  return descriptor;
}
