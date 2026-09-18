import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

export interface OutlinerPaths {
  stateDir: string;
  database: string;
  socket: string;
  workspaceRoot: string;
}

export interface OutlinerClientPaths extends OutlinerPaths {
  mode: "local" | "remote";
}

type OutlinerClientConfig =
  | {
    mode: "local";
    workspaceRoot?: string;
    label?: string;
  }
  | {
    mode: "remote";
    socketPath: string;
    workspaceRoot?: string;
    label?: string;
  };

const CLIENT_CONFIG_KEYS: Readonly<Record<string, true>> = {
  workspaceRoot: true,
  mode: true,
  socketPath: true,
  label: true,
};

function workspaceKey(workspaceRoot: string): string {
  return createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 12);
}

function readableWorkspaceName(workspaceRoot: string): string {
  const name = basename(workspaceRoot) || "root";
  return name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
}

export function resolveClientConfigPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configuredPath = env.OUTLINER_CONFIG_PATH?.trim();
  if (configuredPath) return configuredPath;
  const workspaceRoot = resolve(env.OUTLINER_WORKSPACE_ROOT ?? process.cwd());
  return join(
    env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"),
    "pi-herdr-outliner",
    "projects",
    `${readableWorkspaceName(workspaceRoot)}--${workspaceKey(workspaceRoot)}`,
    "client.json",
  );
}

function readClientConfig(
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
  if (record.mode !== "local" && record.mode !== "remote") {
    throw new Error(`Outliner client config mode at ${path} must be "local" or "remote"`);
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
  if (record.mode === "local") {
    if (record.socketPath !== undefined) {
      throw new Error(`Local Outliner client config at ${path} must not set socketPath`);
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
  const baseStateDir =
    env.OUTLINER_STATE_DIR ?? join(homedir(), ".local", "state", "pi-herdr-outliner");
  const workspaceKeyPart = workspaceKey(workspaceRoot);
  const stateDir = join(baseStateDir, workspaceKeyPart);

  return {
    stateDir,
    database: join(stateDir, "outliner.sqlite"),
    socket: join(stateDir, "outliner.sock"),
    workspaceRoot,
  };
}

export function resolveClientPaths(
  env: NodeJS.ProcessEnv = process.env,
): OutlinerClientPaths {
  const paths = resolvePaths(env);
  const envRemote = env.OUTLINER_REMOTE?.trim();
  const explicitConfigPath = env.OUTLINER_CONFIG_PATH?.trim();
  const configPath = resolveClientConfigPath(env);
  const config = envRemote === undefined
    ? readClientConfig(configPath, paths.workspaceRoot)
    : undefined;
  if (envRemote === undefined && config === undefined && !explicitConfigPath) {
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
    return { ...paths, mode: "local" };
  }
  if (!configuredSocket) {
    throw new Error("OUTLINER_REMOTE=1 requires OUTLINER_SOCKET_PATH");
  }
  if (!isAbsolute(configuredSocket)) {
    throw new Error("OUTLINER_SOCKET_PATH must be an absolute Unix socket path");
  }
  return { ...paths, mode: "remote", socket: configuredSocket };
}

export function resolveServicePaths(
  env: NodeJS.ProcessEnv = process.env,
): OutlinerPaths {
  const { mode, ...paths } = resolveClientPaths(env);
  if (mode === "remote") {
    throw new Error(
      "The Outliner service cannot start in remote client mode; start the canonical service on the remote host",
    );
  }
  return paths;
}
