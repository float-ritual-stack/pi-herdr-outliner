import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  byNameLinkTarget,
  byNameSocketPath,
  findOutlinesByName,
  type NamedStoredOutline,
  OUTLINE_NAME_PATTERN,
  type OutlineDescriptor,
  outlineDescriptorPath,
  pingOutline,
  readOutlineDescriptor,
  scanStoredOutlines,
  socketAbsent,
  type StoredOutline,
} from "./known-outlines";
import { type OutlinerPaths, resolveServicePaths, resolveStateRoot, stateDirPaths, WORKSPACE_KEY_PATTERN, workspaceKey } from "./paths";
import type { OutlinerServiceOutline } from "./types";

/*
 * Outline names (PIE-457). An outline is addressed by the name in its
 * descriptor; the 12-character hash directory is only where it is stored.
 * Reading and listing live in known-outlines.ts; this module owns every write:
 * the descriptor, the by-name link, and the explicit rename and set-root.
 *
 * Until clients resolve names (PIE-457 slice 2), nothing depends on the
 * descriptor or the link, so failing to write either never stops a service.
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

/** Names whose by-name link points at a socket, so a lost descriptor's name can be recovered. */
function namesLinkedTo(stateRoot: string, socket: string): string[] {
  const directory = dirname(byNameSocketPath(stateRoot, "x"));
  let entries: string[];
  try { entries = readdirSync(directory); } catch { return []; }
  const own = resolve(socket);
  return entries
    .filter(entry => entry.endsWith(".sock") && isOutlineName(entry.slice(0, -".sock".length)))
    .filter(entry => byNameLinkTarget(join(directory, entry)) === own)
    .map(entry => entry.slice(0, -".sock".length))
    .sort();
}

export interface OutlineIdentity {
  /** Absent when the service runs unnamed (its own descriptor is unreadable and no link names it). */
  name?: string;
  /** What to write; absent when an unreadable descriptor is left in place for the operator. */
  descriptor?: OutlineDescriptor;
  /** Said once at start: what was recovered, ignored or tolerated. */
  warnings: string[];
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
 * Decides the name a starting service runs under and the descriptor it will
 * write. It reads only: nothing is written until the service owns its database
 * and socket.
 *
 * An existing descriptor keeps its name (only `outline rename` changes it) and
 * takes the current root. Without one, the name is `requestedName`, or the root's
 * basename as a slug with a numeric suffix if another outline has it. An
 * unreadable descriptor is left in place: the name comes from a by-name link to
 * this outline if there is one, otherwise the service runs unnamed.
 *
 * It refuses only when another running service has the name, or when a new
 * outline asks for a name another outline holds. A stopped copy holding the name
 * this outline already has is a warning.
 */
export async function prepareOutlineIdentity(options: PrepareOutlineIdentityOptions): Promise<OutlineIdentity> {
  const stateRoot = resolve(options.stateRoot);
  const stateDir = resolve(options.stateDir);
  const root = resolve(options.workspaceRoot);
  const ownSocket = stateDirPaths(stateDir).socket;
  const existing = readOutlineDescriptor(stateDir);
  const others = otherNamedOutlines(stateRoot, stateDir);
  const requested = options.requestedName?.trim();
  const warnings: string[] = [];
  let name: string;
  let established: boolean;
  if (existing.kind === "ok") {
    name = existing.descriptor.name;
    established = true;
    if (requested && requested !== name) {
      warnings.push(`OUTLINER_OUTLINE_NAME=${requested} is ignored: this outline is already named "${name}". Rename it with \`outliner outline rename ${name} ${requested}\` while it is stopped.`);
    }
  } else if (existing.kind === "invalid") {
    const linked = namesLinkedTo(stateRoot, ownSocket);
    if (linked.length !== 1) {
      warnings.push(`${existing.error}. It is left in place; serving unnamed until it is fixed or removed (the service then writes a new one).`);
      return { warnings };
    }
    name = linked[0]!;
    established = true;
    warnings.push(`${existing.error}. It is left in place; serving as "${name}", the name its by-name link gives. Fix or remove the file to have it rewritten.`);
  } else if (requested) {
    name = requireOutlineName(requested, "OUTLINER_OUTLINE_NAME");
    established = false;
  } else {
    name = uniqueOutlineName(slugifyOutlineName(basename(root)), new Set(others.map(other => other.descriptor.name)));
    established = false;
  }

  for (const other of others.filter(other => other.descriptor.name === name)) {
    if (!await socketAbsent(other.socket)) {
      throw new Error(`The outline name "${name}" is already served by a running service for ${other.descriptor.root} (${other.stateDir}); refusing to start a second "${name}" for ${root}.`);
    }
    const message = `The outline name "${name}" also belongs to the stopped outline for ${other.descriptor.root} (${other.stateDir})`;
    if (!established) throw new Error(`${message}, so this outline for ${root} cannot take it. Rename one with \`outliner outline rename ${other.stateKey} <new-name>\`.`);
    warnings.push(`${message}. Serving as "${name}" anyway; rename one with \`outliner outline rename <storage key> <new-name>\` so the name is unambiguous.`);
  }

  if (existing.kind === "invalid") return { name, warnings };
  const now = (options.now ?? new Date()).toISOString();
  const previous = existing.kind === "ok" ? existing.descriptor : undefined;
  return {
    name,
    descriptor: {
      name,
      root,
      ...(previous?.label ? { label: previous.label } : {}),
      host: options.host ?? hostname(),
      created: previous?.created ?? now,
      updated: now,
    },
    warnings,
  };
}

/** Removes `<file>.<pid>[.<time>].tmp` leftovers from a crashed writer. */
function removeLeftoverTemporaries(path: string): void {
  const directory = dirname(path);
  const prefix = `${basename(path)}.`;
  let entries: string[];
  try { entries = readdirSync(directory); } catch { return; }
  for (const entry of entries) {
    if (entry.startsWith(prefix) && /^\d+(\.\d+)?\.tmp$/.test(entry.slice(prefix.length))) rmSync(join(directory, entry), { force: true });
  }
}

function fsyncPath(path: string): void {
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

/**
 * Writes `outline.json` durably and atomically: the temporary file is synced
 * before it is renamed over the descriptor, and the folder after.
 */
export function writeOutlineDescriptor(stateDir: string, descriptor: OutlineDescriptor): string {
  const path = outlineDescriptorPath(stateDir);
  removeLeftoverTemporaries(path);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    const file = openSync(temporary, "wx", 0o600);
    try {
      writeSync(file, `${JSON.stringify(descriptor, null, 2)}\n`);
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporary, path);
    fsyncPath(dirname(path));
  } finally {
    rmSync(temporary, { force: true });
  }
  return path;
}

function sameExceptUpdated(a: OutlineDescriptor, b: OutlineDescriptor): boolean {
  return a.name === b.name && a.root === b.root && a.label === b.label && a.host === b.host && a.created === b.created;
}

/** Writes the descriptor unless only `updated` would change, so restarts stay quiet. */
export function refreshOutlineDescriptor(stateDir: string, descriptor: OutlineDescriptor): "written" | "unchanged" {
  const current = readOutlineDescriptor(stateDir);
  if (current.kind === "ok" && sameExceptUpdated(current.descriptor, descriptor)) return "unchanged";
  writeOutlineDescriptor(stateDir, descriptor);
  return "written";
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
  removeLeftoverTemporaries(link);
  // Relative, so the link survives moving the whole state root.
  const temporary = `${link}.${process.pid}.tmp`;
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

/**
 * After the service owns its database and socket: writes the descriptor and
 * publishes the by-name link. Neither failure stops the service, which keeps
 * serving on its hash socket; `log` says what went wrong. The result is what
 * `ping` reports, with only the parts that exist.
 */
export async function establishOutlineIdentity(options: {
  stateRoot: string;
  stateDir: string;
  socket: string;
  identity: OutlineIdentity;
  log: (message: string) => void;
}): Promise<OutlinerServiceOutline | undefined> {
  const { identity, log } = options;
  for (const warning of identity.warnings) log(warning);
  if (!identity.name) return undefined;
  let descriptorPath: string | undefined;
  if (identity.descriptor) {
    try {
      refreshOutlineDescriptor(options.stateDir, identity.descriptor);
      descriptorPath = outlineDescriptorPath(options.stateDir);
    } catch (error) {
      log(`Could not write ${outlineDescriptorPath(options.stateDir)}: ${errorText(error)}. Serving without it.`);
    }
  }
  let byNameSocket: string | undefined;
  try {
    byNameSocket = await publishByNameSocket(options.stateRoot, identity.name, options.socket);
  } catch (error) {
    log(`Could not publish the by-name socket for "${identity.name}": ${errorText(error)}. Serving on ${options.socket} only.`);
  }
  return {
    name: identity.name,
    ...(descriptorPath ? { descriptorPath } : {}),
    ...(byNameSocket ? { byNameSocket } : {}),
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The stored outline an operator means: a storage key (the 12-hex folder name)
 * or a name. A name that more than one outline carries is refused with their
 * storage folders, so the operator can pick one by key.
 */
export function selectStoredOutline(stateRoot: string, nameOrKey: string): NamedStoredOutline {
  const root = resolve(stateRoot);
  if (WORKSPACE_KEY_PATTERN.test(nameOrKey)) {
    const stored: StoredOutline | undefined = scanStoredOutlines(root).find(entry => entry.stateKey === nameOrKey);
    if (stored) {
      if (stored.descriptor.kind === "ok") return stored as NamedStoredOutline;
      throw new Error(stored.descriptor.kind === "invalid"
        ? `${stored.descriptor.error}. Fix or remove it first.`
        : `The outline stored at ${stored.stateDir} has no descriptor yet; start its service once to write one.`);
    }
  }
  const matches = findOutlinesByName(root, nameOrKey);
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new Error(`No outline named "${nameOrKey}" in ${root}. \`outliner outlines\` lists them.`);
  throw new Error(`The name "${nameOrKey}" is ambiguous: ${matches.map(match => `${match.stateKey} (${match.descriptor.descriptor.root})`).join(", ")} all carry it. Use a storage key instead of the name.`);
}

export interface OutlineServicePaths extends OutlinerPaths {
  stateRoot: string;
}

/**
 * Where a starting service keeps its outline. `OUTLINER_OUTLINE=<name or key>`
 * selects the database whose descriptor has that name, wherever its hash
 * directory is, and defaults the root to the descriptor's. Otherwise the root's
 * hash decides, as before; if that directory has no database but another
 * outline's descriptor already claims the root (it was moved there with
 * `set-root`), the service refuses rather than create a second outline for the
 * same folder.
 */
export function resolveOutlineServicePaths(env: NodeJS.ProcessEnv = process.env): OutlineServicePaths {
  const stateRoot = resolve(resolveStateRoot(env));
  const selected = env.OUTLINER_OUTLINE?.trim();
  if (selected) {
    let stored: NamedStoredOutline;
    try {
      stored = selectStoredOutline(stateRoot, selected);
    } catch (error) {
      throw new Error(`OUTLINER_OUTLINE=${selected}: ${errorText(error)} OUTLINER_OUTLINE never creates an outline.`);
    }
    const workspaceRoot = resolve(env.OUTLINER_WORKSPACE_ROOT?.trim() || stored.descriptor.descriptor.root);
    // The same checks as a service started by folder (remote mode is refused), then this outline's storage.
    resolveServicePaths({ ...env, OUTLINER_WORKSPACE_ROOT: workspaceRoot });
    const { database, socket } = stateDirPaths(stored.stateDir);
    return { stateRoot, stateDir: stored.stateDir, database, socket, workspaceRoot };
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

export interface OutlineCommandOptions {
  stateRoot: string;
  now?: Date;
  pingTimeoutMs?: number;
}

/**
 * `outliner outline set-root <name|key> <path>`: records the folder an outline
 * now belongs to. Storage never moves. It refuses while the outline's service is
 * running, unless that service already serves `path`.
 */
export async function setOutlineRoot(options: OutlineCommandOptions & { name: string; root: string }): Promise<OutlineDescriptor> {
  const stored = selectStoredOutline(options.stateRoot, options.name);
  const current = stored.descriptor.descriptor;
  const root = resolve(options.root);
  let isDirectory = false;
  try { isDirectory = statSync(root).isDirectory(); } catch { isDirectory = false; }
  if (!isDirectory) throw new Error(`${root} is not a folder; move the outline's folder there first.`);
  if (!await socketAbsent(stored.socket)) {
    const status = await pingOutline(stored.socket, options.pingTimeoutMs);
    const serving = status?.location?.workspaceRoot;
    if (serving === undefined || resolve(serving) !== root) {
      throw new Error(`The outline "${current.name}" is running${serving ? ` for ${serving}` : ""}; stop its service before changing its root.`);
    }
  }
  for (const other of otherNamedOutlines(options.stateRoot, stored.stateDir)) {
    if (resolve(other.descriptor.root) === root) {
      throw new Error(`${root} already belongs to the outline "${other.descriptor.name}" (${other.stateDir}).`);
    }
  }
  const hashed = join(resolve(options.stateRoot), workspaceKey(root));
  if (hashed !== stored.stateDir && existsSync(stateDirPaths(hashed).database)) {
    throw new Error(`${root} already has its own database at ${hashed}; starting there by folder would open that one, not "${current.name}".`);
  }
  const descriptor = { ...current, root, updated: (options.now ?? new Date()).toISOString() };
  writeOutlineDescriptor(stored.stateDir, descriptor);
  return descriptor;
}

/**
 * `outliner outline rename <old|key> <new>`: renames a stopped outline. The old
 * by-name link goes; the service makes the new one on its next start.
 */
export async function renameOutline(options: OutlineCommandOptions & { from: string; to: string }): Promise<OutlineDescriptor> {
  requireOutlineName(options.to, "The new name");
  const stored = selectStoredOutline(options.stateRoot, options.from);
  const current = stored.descriptor.descriptor;
  if (current.name === options.to) return current;
  const holder = findOutlinesByName(options.stateRoot, options.to)[0];
  if (holder) throw new Error(`The name "${options.to}" already belongs to the outline for ${holder.descriptor.descriptor.root} (${holder.stateDir}).`);
  if (!await socketAbsent(stored.socket)) {
    throw new Error(`The outline "${current.name}" is running; stop its service before renaming it.`);
  }
  const descriptor = { ...current, name: options.to, updated: (options.now ?? new Date()).toISOString() };
  writeOutlineDescriptor(stored.stateDir, descriptor);
  withdrawByNameSocket(options.stateRoot, current.name, stored.socket);
  return descriptor;
}
