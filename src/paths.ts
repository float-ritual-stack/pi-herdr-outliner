import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export interface OutlinerPaths {
  stateDir: string;
  database: string;
  socket: string;
  workspaceRoot: string;
}

/**
 * How a client reaches its outline: `local` (the folder's hash socket),
 * `remote` (a configured socket) or `host` (this machine's outline host,
 * addressed by `outline`). `stateDir` is where the client keeps its own files
 * (editor drafts); in host mode it is `<state root>/clients/<outline>/`.
 */
export interface OutlinerClientPaths extends OutlinerPaths {
  mode: "local" | "remote" | "host";
  /** The outline every request names. Always set in host mode; optional for a remote host. */
  outline?: string;
  /** How `outline` was chosen: `OUTLINER_OUTLINE`, the folder's config (bound), or the folder's name. */
  outlineSource?: "env" | "bound" | "folder";
}

export type OutlinerClientConfig =
  | {
    mode: "local";
    workspaceRoot?: string;
    label?: string;
  }
  | {
    mode: "remote";
    socketPath: string;
    /** The outline to ask for when the socket is an outline host. */
    outline?: string;
    workspaceRoot?: string;
    label?: string;
  }
  | {
    /** Written without `mode`: `{ workspaceRoot, outline }` binds a folder to a host outline. */
    mode: "host";
    outline: string;
    workspaceRoot?: string;
    label?: string;
  };

const CLIENT_CONFIG_KEYS: Readonly<Record<string, true>> = {
  workspaceRoot: true,
  mode: true,
  socketPath: true,
  outline: true,
  label: true,
};

/** A short slug that addresses an outline, unique per state root. */
export const OUTLINE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** A name derived from a folder: its basename as a slug. */
export function slugifyOutlineName(text: string): string {
  const slug = text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "");
  return slug || "outline";
}

function requireOutlineName(name: string, what: string): string {
  if (!OUTLINE_NAME_PATTERN.test(name)) {
    throw new Error(`${what} must be an outline name (${OUTLINE_NAME_PATTERN.source}); got ${JSON.stringify(name)}`);
  }
  return name;
}

/** Where a client keeps its own files for one host outline (editor drafts), apart from the host's. */
export function hostedOutlineClientDir(stateRoot: string, name: string): string {
  return join(resolve(stateRoot), "clients", name);
}

export function workspaceKey(workspaceRoot: string): string {
  return createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 12);
}

/** A state folder's name: the first 12 hex characters of its root's SHA-256. */
export const WORKSPACE_KEY_PATTERN = /^[0-9a-f]{12}$/;

/** The files inside one outline's state folder. */
export function stateDirPaths(stateDir: string): { database: string; socket: string; descriptor: string } {
  return {
    database: join(stateDir, "outliner.sqlite"),
    socket: join(stateDir, "outliner.sock"),
    descriptor: join(stateDir, "outline.json"),
  };
}

/** Where the host keeps its socket and outlines under a state root. */
export function outlineHostPaths(stateRoot: string): { socket: string; outlines: string } {
  const root = resolve(stateRoot);
  return { socket: join(root, "outliner.sock"), outlines: join(root, "outlines") };
}

/**
 * One outline's entries in `outlines/`: `<name>.sqlite` (the database, or for an
 * adopted outline a symlink to it) and `<name>/`, the side folder of an outline
 * the host created (prompts, assistant sessions). An adopted outline has no side
 * folder here: its side files stay beside its database.
 */
export function hostedOutlinePaths(stateRoot: string, name: string): { database: string; sideFolder: string } {
  const { outlines } = outlineHostPaths(stateRoot);
  return { database: join(outlines, `${name}.sqlite`), sideFolder: join(outlines, name) };
}

function readableWorkspaceName(workspaceRoot: string): string {
  const name = basename(workspaceRoot) || "root";
  return name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
}

/** Where per-workspace state directories live; the hash-named directories sit beneath it. */
export function resolveStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.OUTLINER_STATE_DIR ?? join(homedir(), ".local", "state", "pi-herdr-outliner");
}

/** The directory holding one `<name>--<key>/client.json` per configured workspace. */
export function resolveClientConfigRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(
    env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"),
    "pi-herdr-outliner",
    "projects",
  );
}

export function resolveClientConfigPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configuredPath = env.OUTLINER_CONFIG_PATH?.trim();
  if (configuredPath) return configuredPath;
  const workspaceRoot = resolve(env.OUTLINER_WORKSPACE_ROOT ?? process.cwd());
  return join(
    resolveClientConfigRoot(env),
    `${readableWorkspaceName(workspaceRoot)}--${workspaceKey(workspaceRoot)}`,
    "client.json",
  );
}

/**
 * Records a workspace's explicit connection choice. It creates only the config
 * directory, never state, and refuses to replace an existing choice unless
 * `replace` is asked for (the outline switcher).
 */
export function writeClientConfig(
  env: NodeJS.ProcessEnv,
  config: OutlinerClientConfig & { workspaceRoot: string },
  options: { replace?: boolean } = {},
): string {
  if (env.OUTLINER_CONFIG_PATH?.trim()) {
    // That file is the user's own, possibly shared by several folders; never pin it to one.
    throw new Error("OUTLINER_CONFIG_PATH is set explicitly, so the Outliner will not write a project config through it; edit that file instead");
  }
  const workspaceRoot = resolve(config.workspaceRoot);
  const path = resolveClientConfigPath({ ...env, OUTLINER_WORKSPACE_ROOT: workspaceRoot });
  if (config.mode === "remote" && !isAbsolute(config.socketPath)) {
    throw new Error("Remote Outliner client config socketPath must be an absolute Unix socket path");
  }
  if (config.mode === "host" || (config.mode === "remote" && config.outline !== undefined)) {
    requireOutlineName(config.outline!, "The config's outline");
  }
  const label = config.label?.trim() ? { label: config.label } : {};
  const value = config.mode === "remote"
    ? { workspaceRoot, mode: "remote", socketPath: config.socketPath, ...(config.outline ? { outline: config.outline } : {}), ...label }
    : config.mode === "host"
      ? { workspaceRoot, outline: config.outline, ...label }
      : { workspaceRoot, mode: "local", ...label };
  mkdirSync(dirname(path), { recursive: true });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (options.replace) {
    // Switching a folder's outline: written beside, then renamed over, so a reader never sees half a file.
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, text, { mode: 0o600 });
    renameSync(temporary, path);
  } else {
    writeFileSync(path, text, { flag: "wx", mode: 0o600 });
  }
  // Validate with the same reader every process uses.
  readClientConfig(path, workspaceRoot);
  return path;
}

export function readClientConfig(
  path: string,
  workspaceRoot: string,
): OutlinerClientConfig | undefined {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) return undefined;
    throw new Error(`Could not read Outliner client config at ${path}`, { cause: error });
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid JSON in Outliner client config at ${path}`, { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Outliner client config at ${path} must be a JSON object`);
  }
  const record = value as Record<string, unknown>;
  const unknownKey = Object.keys(record).find((key) => CLIENT_CONFIG_KEYS[key] !== true);
  if (unknownKey) {
    throw new Error(`Unknown Outliner client config key ${unknownKey} at ${path}`);
  }
  if (record.outline !== undefined && (typeof record.outline !== "string" || !OUTLINE_NAME_PATTERN.test(record.outline))) {
    throw new Error(`Outliner client config outline at ${path} must be an outline name (${OUTLINE_NAME_PATTERN.source})`);
  }
  if (record.mode === undefined && record.outline !== undefined) record.mode = "host";
  if (record.mode !== "local" && record.mode !== "remote" && record.mode !== "host") {
    throw new Error(`Outliner client config mode at ${path} must be "local" or "remote", or be left out beside an outline`);
  }
  if (
    record.workspaceRoot !== undefined &&
    (typeof record.workspaceRoot !== "string" || record.workspaceRoot.trim() === "")
  ) {
    throw new Error(`Outliner client config workspaceRoot at ${path} must be a non-empty string`);
  }
  if (
    typeof record.workspaceRoot === "string" &&
    resolve(record.workspaceRoot) !== workspaceRoot
  ) {
    throw new Error(
      `Outliner client config workspaceRoot at ${path} does not match invoking workspace ${workspaceRoot}`,
    );
  }
  if (
    record.label !== undefined &&
    (typeof record.label !== "string" || record.label.trim() === "")
  ) {
    throw new Error(`Outliner client config label at ${path} must be a non-empty string`);
  }
  if (record.mode === "host") {
    if (record.socketPath !== undefined) {
      throw new Error(`Outliner client config at ${path} names an outline, so it must not set socketPath unless mode is "remote"`);
    }
    return {
      mode: "host",
      outline: record.outline as string,
      ...(record.workspaceRoot === undefined ? {} : { workspaceRoot: record.workspaceRoot }),
      ...(record.label === undefined ? {} : { label: record.label }),
    };
  }
  if (record.mode === "local") {
    if (record.socketPath !== undefined) {
      throw new Error(`Local Outliner client config at ${path} must not set socketPath`);
    }
    if (record.outline !== undefined) {
      throw new Error(`Local Outliner client config at ${path} must not name an outline; leave mode out to bind the folder to a host outline`);
    }
    return {
      mode: "local",
      ...(record.workspaceRoot === undefined ? {} : { workspaceRoot: record.workspaceRoot }),
      ...(record.label === undefined ? {} : { label: record.label }),
    };
  }
  if (typeof record.socketPath !== "string" || !isAbsolute(record.socketPath)) {
    throw new Error(
      `Remote Outliner client config socketPath at ${path} must be an absolute Unix socket path`,
    );
  }
  return {
    mode: "remote",
    socketPath: record.socketPath,
    ...(record.outline === undefined ? {} : { outline: record.outline as string }),
    ...(record.workspaceRoot === undefined ? {} : { workspaceRoot: record.workspaceRoot }),
    ...(record.label === undefined ? {} : { label: record.label }),
  };
}

function rejectLegacyClientConfig(env: NodeJS.ProcessEnv, projectConfigPath: string): void {
  const legacyPath = join(
    env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"),
    "pi-herdr-outliner",
    "client.json",
  );
  try {
    readFileSync(legacyPath, "utf8");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) return;
    throw new Error(`Could not inspect legacy Outliner client config at ${legacyPath}`, {
      cause: error,
    });
  }
  throw new Error(
    `Legacy Outliner client config found at ${legacyPath}; it is no longer loaded automatically. Create ${projectConfigPath} with mode "local" or "remote" (plus socketPath for remote), or set OUTLINER_CONFIG_PATH explicitly to a config using that schema.`,
  );
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): OutlinerPaths {
  const workspaceRoot = resolve(env.OUTLINER_WORKSPACE_ROOT ?? process.cwd());
  const baseStateDir = resolveStateRoot(env);
  const workspaceKeyPart = workspaceKey(workspaceRoot);
  const stateDir = join(baseStateDir, workspaceKeyPart);
  const { database, socket } = stateDirPaths(stateDir);

  return { stateDir, database, socket, workspaceRoot };
}

/**
 * Where a client connects, in this order:
 *
 * 1. `OUTLINER_REMOTE=1` with `OUTLINER_SOCKET_PATH`: that socket (an outline
 *    host there is asked for `OUTLINER_OUTLINE`, if set). `OUTLINER_REMOTE=0`
 *    forces this machine.
 * 2. `OUTLINER_OUTLINE=<name>`: this machine's outline host, that outline.
 * 3. The folder's `client.json`: an `outline` binds it to a host outline;
 *    `remote` and `local` choices are kept as before.
 * 4. Nothing chosen, an outline host running under the state root, and no
 *    hash database for the folder: the host outline named after the folder.
 * 5. Otherwise the folder's hash socket, as before.
 */
export function resolveClientPaths(
  env: NodeJS.ProcessEnv = process.env,
): OutlinerClientPaths {
  const paths = resolvePaths(env);
  const envRemote = env.OUTLINER_REMOTE?.trim();
  const requestedOutline = env.OUTLINER_OUTLINE?.trim() || undefined;
  const envOutline = requestedOutline === undefined ? undefined : requireOutlineName(requestedOutline, "OUTLINER_OUTLINE");
  const explicitConfigPath = env.OUTLINER_CONFIG_PATH?.trim();
  const configPath = resolveClientConfigPath(env);
  const config = envRemote === undefined && envOutline === undefined
    ? readClientConfig(configPath, paths.workspaceRoot)
    : undefined;
  if (envRemote === undefined && envOutline === undefined && config === undefined && !explicitConfigPath) {
    rejectLegacyClientConfig(env, configPath);
  }
  const remote = envRemote ?? (config?.mode === "remote" ? "1" : "0");
  const configuredSocket = (
    env.OUTLINER_SOCKET_PATH ??
    (envRemote === undefined && config?.mode === "remote" ? config.socketPath : undefined) ??
    ""
  ).trim();
  if (remote !== "" && remote !== "0" && remote !== "1") {
    throw new Error("OUTLINER_REMOTE must be 1, 0, or unset");
  }
  if (remote !== "1") {
    if (configuredSocket) {
      throw new Error("OUTLINER_SOCKET_PATH requires OUTLINER_REMOTE=1");
    }
    const stateRoot = resolveStateRoot(env);
    const host = (outline: string, outlineSource: "env" | "bound" | "folder"): OutlinerClientPaths => ({
      workspaceRoot: paths.workspaceRoot,
      stateDir: hostedOutlineClientDir(stateRoot, outline),
      database: hostedOutlinePaths(stateRoot, outline).database,
      socket: outlineHostPaths(stateRoot).socket,
      mode: "host",
      outline,
      outlineSource,
    });
    if (envOutline) return host(envOutline, "env");
    if (config?.mode === "host") return host(config.outline, "bound");
    if (
      config === undefined && !explicitConfigPath && envRemote === undefined &&
      existsSync(outlineHostPaths(stateRoot).socket) && !existsSync(paths.database)
    ) {
      return host(slugifyOutlineName(basename(paths.workspaceRoot)), "folder");
    }
    return { ...paths, mode: "local" };
  }
  if (!configuredSocket) {
    throw new Error("OUTLINER_REMOTE=1 requires OUTLINER_SOCKET_PATH");
  }
  if (!isAbsolute(configuredSocket)) {
    throw new Error("OUTLINER_SOCKET_PATH must be an absolute Unix socket path");
  }
  const remoteOutline = envOutline ?? (config?.mode === "remote" ? config.outline : undefined);
  return {
    ...paths, mode: "remote", socket: configuredSocket,
    ...(remoteOutline ? { outline: remoteOutline, outlineSource: envOutline ? "env" as const : "bound" as const } : {}),
  };
}

/**
 * Where the single-outline service keeps its outline: the folder's hash
 * directory. `OUTLINER_OUTLINE` keeps its service meaning (slice 1, see
 * `resolveOutlineServicePaths`), and the host's folder-name guess does not
 * apply; a folder bound to a host outline is refused.
 */
export function resolveServicePaths(
  env: NodeJS.ProcessEnv = process.env,
): OutlinerPaths {
  const { OUTLINER_OUTLINE: _serviceSelection, ...clientEnv } = env;
  const { mode, outline, outlineSource, ...paths } = resolveClientPaths(clientEnv);
  if (mode === "remote") {
    throw new Error(
      "The Outliner service cannot start in remote client mode; start the canonical service on the remote host",
    );
  }
  if (mode === "host") {
    if (outlineSource === "folder") return resolvePaths(clientEnv);
    throw new Error(`${paths.workspaceRoot} is bound to the outline "${outline}" on the outline host; the single-outline service does not serve it`);
  }
  return paths;
}
