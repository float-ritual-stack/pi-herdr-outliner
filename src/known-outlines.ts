import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { OutlinerClient } from "./client";
import { probeSocket } from "./socket-probe";
import {
  OUTLINE_NAME_PATTERN,
  nearestFolderBinding,
  type OutlinerClientPaths,
  readClientConfig,
  resolveClientConfigPath,
  resolveClientPaths,
  stateDirPaths,
  WORKSPACE_KEY_PATTERN,
} from "./paths";
import type { OutlinerServiceStatus } from "./types";

/**
 * Whether opening a workspace may proceed without asking. Only an explicit
 * connection (remote mode or a client config) or an existing database counts;
 * a folder with none of these gets the outline chooser instead of a new database.
 */
export type OutlinePresence =
  | { kind: "present"; paths: OutlinerClientPaths; because: "remote" | "config" | "database" | "host" }
  | { kind: "missing"; paths: OutlinerClientPaths; configPath: string };

export function detectOutline(env: NodeJS.ProcessEnv): OutlinePresence {
  const paths = resolveClientPaths(env);
  if (paths.mode === "remote") return { kind: "present", paths, because: "remote" };
  // A host outline is named (by env, a binding or a guess); opening attaches to it, creating it if needed.
  // A folder too broad to guess a name for ($HOME, /tmp) gets the chooser.
  if (paths.mode === "host") {
    return paths.outline
      ? { kind: "present", paths, because: "host" }
      : { kind: "missing", paths, configPath: resolveClientConfigPath(env) };
  }
  // An explicit config path is the user's own choice, whether or not the file exists.
  if (env.OUTLINER_CONFIG_PATH?.trim()) return { kind: "present", paths, because: "config" };
  if (paths.configPath) return { kind: "present", paths, because: "config" };
  // resolveClientPaths reads no config under OUTLINER_REMOTE=0, which forces
  // local mode; it does not undo a recorded local choice here or above.
  if (env.OUTLINER_REMOTE?.trim() !== undefined) {
    let binding;
    try { binding = nearestFolderBinding(paths.workspaceRoot, env); } catch { binding = undefined; }
    if (binding?.config.mode === "local" && binding.folder === paths.workspaceRoot) return { kind: "present", paths, because: "config" };
  }
  if (existsSync(paths.database)) return { kind: "present", paths, because: "database" };
  return { kind: "missing", paths, configPath: resolveClientConfigPath(env) };
}

export { OUTLINE_NAME_PATTERN } from "./paths";

/**
 * What a database says about itself (`outline.json`). The service writes it on
 * start; `outliner outline rename|set-root` change it explicitly. Nobody keeps a
 * registry of these: a list of outlines is always a scan of the state root.
 */
export interface OutlineDescriptor {
  name: string;
  /** The folder the outline currently belongs to. Storage never moves with it. */
  root: string;
  label?: string;
  /** The machine whose service last wrote the descriptor. */
  host: string;
  created: string;
  updated: string;
}

export type OutlineDescriptorRead =
  | { kind: "missing" }
  | { kind: "ok"; descriptor: OutlineDescriptor }
  | { kind: "invalid"; error: string };

export function outlineDescriptorPath(stateDir: string): string {
  return stateDirPaths(stateDir).descriptor;
}

/** The name-addressed socket: a symlink the running service keeps to its real socket. */
export function byNameSocketPath(stateRoot: string, name: string): string {
  return join(resolve(stateRoot), "by-name", `${name}.sock`);
}

export function readOutlineDescriptor(stateDir: string): OutlineDescriptorRead {
  const path = outlineDescriptorPath(stateDir);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { kind: "missing" };
    return { kind: "invalid", error: `Could not read ${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const text = (key: string) => typeof record[key] === "string" && (record[key] as string).trim() !== "";
  if (!text("name") || !OUTLINE_NAME_PATTERN.test(record.name as string)) {
    return { kind: "invalid", error: `${path} has no valid name (a slug matching ${OUTLINE_NAME_PATTERN.source})` };
  }
  for (const key of ["root", "host", "created", "updated"]) {
    if (!text(key)) return { kind: "invalid", error: `${path} is missing ${key}` };
  }
  if (record.label !== undefined && !text("label")) return { kind: "invalid", error: `${path} has an empty label` };
  return {
    kind: "ok",
    descriptor: {
      name: record.name as string,
      root: record.root as string,
      ...(record.label === undefined ? {} : { label: record.label as string }),
      host: record.host as string,
      created: record.created as string,
      updated: record.updated as string,
    },
  };
}

/** A state directory that holds a database, with what its descriptor says. */
export interface StoredOutline {
  stateKey: string;
  stateDir: string;
  socket: string;
  descriptor: OutlineDescriptorRead;
}

/**
 * Every database in a state root, in folders named like a workspace key. A
 * backup or copy under another folder name is not an outline. Reads only;
 * never creates the root.
 */
export function scanStoredOutlines(stateRoot: string): StoredOutline[] {
  const root = resolve(stateRoot);
  return directories(root)
    .filter(stateKey => WORKSPACE_KEY_PATTERN.test(stateKey))
    .map(stateKey => join(root, stateKey))
    .filter(stateDir => existsSync(stateDirPaths(stateDir).database))
    .map(stateDir => ({
      stateKey: basename(stateDir),
      stateDir,
      socket: stateDirPaths(stateDir).socket,
      descriptor: readOutlineDescriptor(stateDir),
    }));
}

export type NamedStoredOutline = StoredOutline & { descriptor: { kind: "ok"; descriptor: OutlineDescriptor } };

/** Every stored outline whose descriptor carries a name; more than one means the name is ambiguous. */
export function findOutlinesByName(stateRoot: string, name: string): NamedStoredOutline[] {
  return scanStoredOutlines(stateRoot).filter((stored): stored is NamedStoredOutline =>
    stored.descriptor.kind === "ok" && stored.descriptor.descriptor.name === name);
}

/** Where a by-name link points, resolved against its directory, or undefined when it is not a symlink. */
export function byNameLinkTarget(link: string): string | undefined {
  try {
    if (!lstatSync(link).isSymbolicLink()) return undefined;
    return resolve(dirname(link), readlinkSync(link));
  } catch {
    return undefined;
  }
}

export interface KnownOutline {
  /** The socket clients connect to; outlines are deduplicated by it. */
  socket: string;
  label: string;
  /** The outline's name from its descriptor: the way to address it. */
  name?: string;
  /** `<stateRoot>/by-name/<name>.sock`, which answers while the outline runs. */
  byNameSocket?: string;
  /** For a stored outline: whether its database describes itself yet. */
  descriptor?: "present" | "missing" | "invalid";
  /** The folder the outline belongs to, when a pane record, config or live service says so. */
  root?: string;
  /** Other folders whose client config points at this outline. */
  aliases: string[];
  /** The 12-character state directory name for an outline stored on this machine. */
  stateKey?: string;
  stateDir?: string;
  location: "local" | "remote";
  status: "running" | "stopped";
}

export interface ListKnownOutlinesOptions {
  stateRoot: string;
  configRoot: string;
  pingTimeoutMs?: number;
  ping?: (socket: string, timeoutMs: number) => Promise<OutlinerServiceStatus>;
}

interface Candidate {
  socket: string;
  label?: string;
  name?: string;
  descriptor?: OutlineDescriptorRead;
  root?: string;
  aliases: Set<string>;
  stateKey?: string;
  stateDir?: string;
}

function directories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** Pane records written by the launcher and service remember the folder they served. */
function recordedRoot(stateDir: string): string | undefined {
  let names: string[];
  try {
    names = readdirSync(stateDir).filter(name => name.endsWith("-pane.json")).sort();
  } catch {
    return undefined;
  }
  // The service's own record is the most direct statement of its folder.
  names.sort((a, b) => Number(b === "service-pane.json") - Number(a === "service-pane.json"));
  for (const name of names) {
    try {
      const value = JSON.parse(readFileSync(join(stateDir, name), "utf8")) as { workspaceRoot?: unknown };
      if (typeof value.workspaceRoot === "string" && value.workspaceRoot.trim()) return value.workspaceRoot;
    } catch {
      // An unreadable record says nothing about the folder.
    }
  }
  return undefined;
}

/**
 * The local outline that owns a socket in the state root, if any, with the folder
 * it belongs to when a pane record or a local project config says so.
 */
export function localOutlineOwner(
  socket: string,
  options: { stateRoot: string; configRoot: string },
): { stateDir: string; stateKey: string; root?: string } | undefined {
  const stateDir = dirname(resolve(socket));
  const layout = stateDirPaths(stateDir);
  if (resolve(socket) !== layout.socket || dirname(stateDir) !== resolve(options.stateRoot)) return undefined;
  if (!existsSync(layout.database)) return undefined;
  const stateKey = basename(stateDir);
  let root = recordedRoot(stateDir);
  for (const name of root ? [] : directories(options.configRoot).filter(name => name.endsWith(`--${stateKey}`))) {
    try {
      const path = join(options.configRoot, name, "client.json");
      const raw = JSON.parse(readFileSync(path, "utf8")) as { workspaceRoot?: unknown };
      if (typeof raw.workspaceRoot !== "string") continue;
      const config = readClientConfig(path, resolve(raw.workspaceRoot));
      if (config?.mode === "local" && config.workspaceRoot) { root = resolve(config.workspaceRoot); break; }
    } catch {
      // An unreadable config says nothing about the owner.
    }
  }
  return { stateDir, stateKey, ...(root ? { root } : {}) };
}

/**
 * Whether nothing is serving a socket: its file is missing or a connection is
 * refused. A slow or busy service counts as present, so a loaded machine is
 * never mistaken for a stopped outline.
 */
export async function socketAbsent(socket: string, timeoutMs = 1_000): Promise<boolean> {
  const probe = await probeSocket(socket, timeoutMs);
  return probe === "absent" || probe === "refused";
}

function defaultPing(socket: string, timeoutMs: number): Promise<OutlinerServiceStatus> {
  return new OutlinerClient(socket, timeoutMs).request<OutlinerServiceStatus>({ action: "ping" }, timeoutMs);
}

async function boundedPing(
  ping: NonNullable<ListKnownOutlinesOptions["ping"]>,
  socket: string,
  timeoutMs: number,
): Promise<OutlinerServiceStatus | null> {
  if (!existsSync(socket)) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      ping(socket, timeoutMs),
      new Promise<null>(resolveTimeout => { timer = setTimeout(() => resolveTimeout(null), timeoutMs + 50); }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** A short ping that answers null when nothing replies in time. */
export function pingOutline(socket: string, timeoutMs = 400): Promise<OutlinerServiceStatus | null> {
  return boundedPing(defaultPing, socket, timeoutMs);
}

/**
 * Lists the outlines this machine knows about: state directories that hold a
 * database (named by their `outline.json` when they have one), and client
 * configs that point at a socket, as aliases. It is derived by scanning; it
 * never creates a directory, opens SQLite or starts a service, and a short
 * ping reports status.
 */
export async function listKnownOutlines(options: ListKnownOutlinesOptions): Promise<KnownOutline[]> {
  const stateRoot = resolve(options.stateRoot);
  const candidates = new Map<string, Candidate>();
  const candidate = (socket: string): Candidate => {
    const key = resolve(socket);
    let entry = candidates.get(key);
    if (!entry) candidates.set(key, entry = { socket: key, aliases: new Set() });
    return entry;
  };
  const byNameDir = join(stateRoot, "by-name");
  const named = new Map<string, string>();

  for (const stored of scanStoredOutlines(stateRoot)) {
    const entry = candidate(stored.socket);
    entry.stateKey = stored.stateKey;
    entry.stateDir = stored.stateDir;
    entry.descriptor = stored.descriptor;
    if (stored.descriptor.kind === "ok") {
      const { descriptor } = stored.descriptor;
      entry.name = descriptor.name;
      entry.root = descriptor.root;
      if (descriptor.label) entry.label = descriptor.label;
      named.set(descriptor.name, stored.socket);
    } else {
      entry.root ??= recordedRoot(stored.stateDir);
    }
  }

  for (const name of directories(options.configRoot)) {
    const path = join(options.configRoot, name, "client.json");
    if (!existsSync(path)) continue;
    let config;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as { workspaceRoot?: unknown };
      config = readClientConfig(path, typeof raw.workspaceRoot === "string" ? resolve(raw.workspaceRoot) : "");
    } catch {
      continue;
    }
    if (!config) continue;
    const configRoot = config.workspaceRoot === undefined ? undefined : resolve(config.workspaceRoot);
    if (config.mode === "remote") {
      // A by-name socket is the same outline as the database that carries the name.
      const socket = resolve(config.socketPath);
      const byName = dirname(socket) === byNameDir && socket.endsWith(".sock")
        ? named.get(basename(socket, ".sock"))
        : undefined;
      const entry = candidate(byName ?? socket);
      if (configRoot) entry.aliases.add(configRoot);
      entry.label ??= config.label;
      continue;
    }
    // A local config names its own state directory through the same hash suffix.
    const stateKey = name.slice(name.lastIndexOf("--") + 2);
    const stateDir = join(stateRoot, stateKey);
    if (!existsSync(stateDirPaths(stateDir).database)) continue;
    const entry = candidate(stateDirPaths(stateDir).socket);
    entry.stateKey = stateKey;
    entry.stateDir = stateDir;
    // The database's own descriptor says where it lives now; an older folder is an alias.
    if (configRoot && entry.descriptor?.kind === "ok") entry.aliases.add(configRoot);
    else if (configRoot) entry.root = configRoot;
    if (config.label) entry.label = config.label;
  }

  const timeoutMs = options.pingTimeoutMs ?? 400;
  const ping = options.ping ?? defaultPing;
  const listed = await Promise.all([...candidates.values()].map(async (entry): Promise<KnownOutline> => {
    const local = entry.stateDir !== undefined || entry.socket.startsWith(`${stateRoot}${sep}`);
    // Together, so a busy local service costs one timeout, not two. A service too
    // busy to answer the ping still holds its socket.
    const [status, absent] = await Promise.all([
      boundedPing(ping, entry.socket, timeoutMs),
      local ? socketAbsent(entry.socket, timeoutMs) : Promise.resolve(true),
    ]);
    const serviceRoot = status?.location?.workspaceRoot;
    const root = entry.root ?? (serviceRoot?.trim() ? serviceRoot : undefined);
    const aliases = [...entry.aliases].filter(alias => alias !== root).sort();
    const running = status !== null || !absent;
    return {
      socket: entry.socket,
      label: entry.label ?? entry.name ?? (root ? basename(root) || root : entry.stateKey ? `outline ${entry.stateKey}` : basename(entry.socket)),
      ...(entry.name ? { name: entry.name, byNameSocket: byNameSocketPath(stateRoot, entry.name) } : {}),
      ...(entry.descriptor ? { descriptor: entry.descriptor.kind === "ok" ? "present" as const : entry.descriptor.kind } : {}),
      ...(root ? { root } : {}),
      aliases,
      ...(entry.stateKey ? { stateKey: entry.stateKey } : {}),
      ...(entry.stateDir ? { stateDir: entry.stateDir } : {}),
      location: local ? "local" : "remote",
      status: running ? "running" : "stopped",
    };
  }));
  return listed.sort((a, b) =>
    Number(b.status === "running") - Number(a.status === "running") || a.label.localeCompare(b.label) || a.socket.localeCompare(b.socket));
}
