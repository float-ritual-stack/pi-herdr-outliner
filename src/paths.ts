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
  /** The outline every request names. Set in host mode unless `unnamed`; optional for a remote host. */
  outline?: string;
  /**
   * How `outline` was chosen: `OUTLINER_OUTLINE`, the nearest bound folder's
   * config, a guess from the repository's or the folder's name, or the
   * outline the invoking pane is registered on (Herdr actions).
   */
  outlineSource?: "env" | "bound" | "repository" | "folder" | "pane";
  /** The `client.json` that chose this endpoint: the folder's own, or its nearest bound ancestor's. */
  configPath?: string;
  /**
   * Host mode with no outline: the folder needs an explicit name (see
   * `resolveFolderOutline`). Says why; a client for these paths refuses every request.
   */
  unnamed?: string;
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

/**
 * Whether an outline host is set up under this state root: its `outlines/`
 * folder exists (the host makes it when it starts). It does not ask whether the
 * host answers right now, so resolution does not flip while the host restarts.
 */
export function outlineHostConfigured(stateRoot: string): boolean {
  return existsSync(outlineHostPaths(stateRoot).outlines);
}

/**
 * The folder `outlines/<name>.json` records for a host outline (`root`), or
 * undefined when none is recorded. An unreadable record throws.
 */
export function hostedOutlineRoot(stateRoot: string, name: string): string | undefined {
  let text: string;
  try { text = readFileSync(join(outlineHostPaths(stateRoot).outlines, `${name}.json`), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const value = JSON.parse(text) as { root?: unknown };
  if (value.root === undefined) return undefined;
  if (typeof value.root !== "string" || !isAbsolute(value.root)) throw new Error(`${name}.json records a root that is not an absolute folder`);
  return resolve(value.root);
}

/** A folder whose `client.json` chose its outline, and that choice. */
export interface FolderBinding {
  folder: string;
  configPath: string;
  config: OutlinerClientConfig;
}

/**
 * The nearest folder, from `folder` up to `/`, that has a `client.json` (an
 * `outline` binding, or a `local` or `remote` choice). Reads only.
 */
export function nearestFolderBinding(folder: string, env: NodeJS.ProcessEnv = process.env): FolderBinding | undefined {
  const { OUTLINER_CONFIG_PATH: _explicit, ...folderEnv } = env;
  for (let current = resolve(folder); ; current = dirname(current)) {
    const configPath = resolveClientConfigPath({ ...folderEnv, OUTLINER_WORKSPACE_ROOT: current });
    const config = readClientConfig(configPath, current);
    if (config) return { folder: current, configPath, config };
    if (dirname(current) === current) return undefined;
  }
}

/** The nearest folder, from `folder` up, holding `.git` (a folder, or a worktree's file). */
function repositoryRoot(folder: string): string | undefined {
  for (let current = folder; ; current = dirname(current)) {
    if (existsSync(join(current, ".git"))) return current;
    if (dirname(current) === current) return undefined;
  }
}

/** `$HOME`, `/` and a folder directly under `/` (`/tmp`, `/opt`) never give their name to an outline. */
function tooBroadToName(folder: string, home: string): boolean {
  const parent = dirname(folder);
  return folder === home || parent === folder || dirname(parent) === parent;
}

/**
 * Which outline a folder uses, by the one rule every opener shares (the door
 * mirrors it):
 *
 * 1. The nearest bound folder, walking up from `folder`: a `client.json` with
 *    an `outline`, or a `local` or `remote` choice. Its binding is used.
 * 2. Otherwise, inside a git work tree, a guess: the repository root's name.
 * 3. Otherwise a guess: the folder's own name.
 * 4. Never a guess for `$HOME`, `/` or a folder directly under `/`: those are
 *    `unnamed` and need an explicit name. A repository rooted there falls
 *    through to rule 3.
 *
 * A guess whose outline records another folder (`outlines/<name>.json`) is
 * `unnamed` too: two folders with one name are never merged silently. A guess
 * only attaches, or creates the outline when a session is opened; a read never
 * creates. The chooser's explicit "New outline here" starts from the same name
 * and adds a suffix when it is taken (`newHostedOutlineName`).
 */
export type FolderOutline =
  | ({ kind: "bound" } & FolderBinding)
  | { kind: "guess"; folder: string; outline: string; from: "repository" | "folder" }
  | { kind: "unnamed"; folder: string; reason: string };

export function resolveFolderOutline(folderInput: string, env: NodeJS.ProcessEnv = process.env): FolderOutline {
  const folder = resolve(folderInput);
  const binding = nearestFolderBinding(folder, env);
  if (binding) return { kind: "bound", ...binding };
  const home = resolve(env.HOME?.trim() || homedir());
  const repository = repositoryRoot(folder);
  const candidate = repository && !tooBroadToName(repository, home)
    ? { folder: repository, from: "repository" as const }
    : { folder, from: "folder" as const };
  const how = "Bind it with the choose-outline action, or name one with OUTLINER_OUTLINE / --outline";
  if (tooBroadToName(candidate.folder, home)) {
    return { kind: "unnamed", folder, reason: `${folder} is too broad to name an outline after. ${how}.` };
  }
  const outline = slugifyOutlineName(basename(candidate.folder));
  let recorded: string | undefined;
  try { recorded = hostedOutlineRoot(resolveStateRoot(env), outline); }
  catch { recorded = ""; }
  if (recorded !== undefined && recorded !== candidate.folder) {
    return { kind: "unnamed", folder, reason: `The outline "${outline}" belongs to ${recorded || "a folder its record does not say"}, not ${candidate.folder}. ${how}.` };
  }
  return { kind: "guess", folder: candidate.folder, outline, from: candidate.from };
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
 * 3. `OUTLINER_CONFIG_PATH`, else the nearest bound folder's `client.json`
 *    (`resolveFolderOutline` rule 1): an `outline` binds it to a host outline;
 *    `remote` and `local` choices are kept. `workspaceRoot` is the bound
 *    folder. A folder's own hash database wins over an ancestor's binding.
 * 4. Nothing chosen and no hash database for the folder, with an outline host
 *    set up under the state root (`outlineHostConfigured`, not whether it
 *    answers now): the guessed outline (rules 2-3; `workspaceRoot` is the
 *    guessed folder), or host mode `unnamed` (rule 4). Never local: a client
 *    whose host is restarting waits for it.
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
  const readsConfig = envRemote === undefined && envOutline === undefined;
  let binding: FolderBinding | undefined;
  if (readsConfig && explicitConfigPath) {
    const config = readClientConfig(explicitConfigPath, paths.workspaceRoot);
    if (config) binding = { folder: paths.workspaceRoot, configPath: explicitConfigPath, config };
  } else if (readsConfig) {
    binding = nearestFolderBinding(paths.workspaceRoot, env);
    // A folder's own hash database is its outline; an ancestor's binding does not take it over.
    if (binding && binding.folder !== paths.workspaceRoot && existsSync(paths.database)) binding = undefined;
  }
  const config = binding?.config;
  if (readsConfig && config === undefined && !explicitConfigPath) {
    rejectLegacyClientConfig(env, resolveClientConfigPath(env));
  }
  const bound = binding && binding.folder !== paths.workspaceRoot
    ? { ...resolvePaths({ ...env, OUTLINER_WORKSPACE_ROOT: binding.folder }), configPath: binding.configPath }
    : { ...paths, ...(binding ? { configPath: binding.configPath } : {}) };
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
    const host = (outline: string, outlineSource: NonNullable<OutlinerClientPaths["outlineSource"]>, workspaceRoot: string, configPath?: string): OutlinerClientPaths => ({
      workspaceRoot,
      stateDir: hostedOutlineClientDir(stateRoot, outline),
      database: hostedOutlinePaths(stateRoot, outline).database,
      socket: outlineHostPaths(stateRoot).socket,
      mode: "host",
      outline,
      outlineSource,
      ...(configPath ? { configPath } : {}),
    });
    if (envOutline) return host(envOutline, "env", paths.workspaceRoot);
    if (config?.mode === "host") return host(config.outline, "bound", bound.workspaceRoot, bound.configPath);
    if (config) return { ...bound, mode: "local" };
    if (!explicitConfigPath && envRemote === undefined && !existsSync(paths.database) && outlineHostConfigured(stateRoot)) {
      const folder = resolveFolderOutline(paths.workspaceRoot, env);
      if (folder.kind === "guess") {
        // A repository whose root still has its own hash database keeps using it.
        const guessed = resolvePaths({ ...env, OUTLINER_WORKSPACE_ROOT: folder.folder });
        if (folder.folder !== paths.workspaceRoot && existsSync(guessed.database)) return { ...guessed, mode: "local" };
        return host(folder.outline, folder.from, folder.folder);
      }
      if (folder.kind === "unnamed") {
        return {
          workspaceRoot: paths.workspaceRoot, stateDir: join(resolve(stateRoot), "clients"), database: "",
          socket: outlineHostPaths(stateRoot).socket, mode: "host", unnamed: folder.reason,
        };
      }
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
    ...(envRemote === undefined ? bound : paths), mode: "remote", socket: configuredSocket,
    ...(remoteOutline ? { outline: remoteOutline, outlineSource: envOutline ? "env" as const : "bound" as const } : {}),
  };
}

/**
 * Where the single-outline service keeps its outline: the folder's hash
 * directory. `OUTLINER_OUTLINE` keeps its service meaning (slice 1, see
 * `resolveOutlineServicePaths`). A folder that resolves to the outline host
 * (bound, guessed or unnamed) is refused: while a host is set up the service
 * never makes a hash database for such a folder, even while the host restarts.
 */
export function resolveServicePaths(
  env: NodeJS.ProcessEnv = process.env,
): OutlinerPaths {
  const { OUTLINER_OUTLINE: _serviceSelection, ...clientEnv } = env;
  const { mode, outline, outlineSource, configPath: _configPath, unnamed, ...paths } = resolveClientPaths(clientEnv);
  if (mode === "remote") {
    throw new Error(
      "The Outliner service cannot start in remote client mode; start the canonical service on the remote host",
    );
  }
  if (mode === "host") {
    throw new Error(outlineSource === "bound"
      ? `${paths.workspaceRoot} is bound to the outline "${outline}" on the outline host; the single-outline service does not serve it`
      : `${paths.workspaceRoot} belongs to the outline host (${unnamed ?? `outline "${outline}"`}); the single-outline service does not start a database for it. Open it from Herdr, or start the host.`);
  }
  return paths;
}
