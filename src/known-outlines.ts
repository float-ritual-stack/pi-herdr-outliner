import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { OutlinerClient } from "./client";
import {
  type OutlinerClientPaths,
  readClientConfig,
  resolveClientConfigPath,
  resolveClientPaths,
} from "./paths";
import type { OutlinerServiceStatus } from "./types";

/**
 * Whether opening a workspace may proceed without asking. Only an explicit
 * connection (remote mode or a client config) or an existing database counts;
 * a folder with none of these gets the outline chooser instead of a new database.
 */
export type OutlinePresence =
  | { kind: "present"; paths: OutlinerClientPaths; because: "remote" | "config" | "database" }
  | { kind: "missing"; paths: OutlinerClientPaths; configPath: string };

export function detectOutline(env: NodeJS.ProcessEnv): OutlinePresence {
  const paths = resolveClientPaths(env);
  if (paths.mode === "remote") return { kind: "present", paths, because: "remote" };
  // An explicit config path is the user's own choice, whether or not the file exists.
  if (env.OUTLINER_CONFIG_PATH?.trim()) return { kind: "present", paths, because: "config" };
  const configPath = resolveClientConfigPath(env);
  if (existsSync(configPath)) {
    // resolveClientPaths reads the project config only when OUTLINER_REMOTE is unset.
    if (env.OUTLINER_REMOTE?.trim() === undefined) return { kind: "present", paths, because: "config" };
    // OUTLINER_REMOTE=0 forces local mode; it does not undo a recorded local choice.
    let config;
    try { config = readClientConfig(configPath, paths.workspaceRoot); } catch { config = undefined; }
    if (config?.mode === "local") return { kind: "present", paths, because: "config" };
  }
  if (existsSync(paths.database)) return { kind: "present", paths, because: "database" };
  return { kind: "missing", paths, configPath };
}

export interface KnownOutline {
  /** The socket clients connect to; outlines are deduplicated by it. */
  socket: string;
  label: string;
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
  if (basename(socket) !== "outliner.sock" || dirname(stateDir) !== resolve(options.stateRoot)) return undefined;
  if (!existsSync(join(stateDir, "outliner.sqlite"))) return undefined;
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

/**
 * Lists the outlines this machine knows about: state directories that hold a
 * database, and client configs that point at a socket. It never creates a
 * directory, opens SQLite or starts a service; a short ping reports status.
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

  for (const name of directories(stateRoot)) {
    const stateDir = join(stateRoot, name);
    if (!existsSync(join(stateDir, "outliner.sqlite"))) continue;
    const entry = candidate(join(stateDir, "outliner.sock"));
    entry.stateKey = name;
    entry.stateDir = stateDir;
    entry.root ??= recordedRoot(stateDir);
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
      const entry = candidate(config.socketPath);
      if (configRoot) entry.aliases.add(configRoot);
      entry.label ??= config.label;
      continue;
    }
    // A local config names its own state directory through the same hash suffix.
    const stateKey = name.slice(name.lastIndexOf("--") + 2);
    const stateDir = join(stateRoot, stateKey);
    if (!existsSync(join(stateDir, "outliner.sqlite"))) continue;
    const entry = candidate(join(stateDir, "outliner.sock"));
    entry.stateKey = stateKey;
    entry.stateDir = stateDir;
    if (configRoot) entry.root = configRoot;
    if (config.label) entry.label = config.label;
  }

  const timeoutMs = options.pingTimeoutMs ?? 400;
  const ping = options.ping ?? defaultPing;
  const listed = await Promise.all([...candidates.values()].map(async (entry): Promise<KnownOutline> => {
    const status = await boundedPing(ping, entry.socket, timeoutMs);
    const serviceRoot = status?.location?.workspaceRoot;
    const root = entry.root ?? (serviceRoot?.trim() ? serviceRoot : undefined);
    const aliases = [...entry.aliases].filter(alias => alias !== root).sort();
    const local = entry.stateDir !== undefined || entry.socket.startsWith(`${stateRoot}${sep}`);
    return {
      socket: entry.socket,
      label: entry.label ?? (root ? basename(root) || root : entry.stateKey ? `outline ${entry.stateKey}` : basename(entry.socket)),
      ...(root ? { root } : {}),
      aliases,
      ...(entry.stateKey ? { stateKey: entry.stateKey } : {}),
      ...(entry.stateDir ? { stateDir: entry.stateDir } : {}),
      location: local ? "local" : "remote",
      status: status ? "running" : "stopped",
    };
  }));
  return listed.sort((a, b) =>
    Number(b.status === "running") - Number(a.status === "running") || a.label.localeCompare(b.label) || a.socket.localeCompare(b.socket));
}
