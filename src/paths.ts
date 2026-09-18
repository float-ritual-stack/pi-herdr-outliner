import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface OutlinerPaths {
  stateDir: string;
  database: string;
  socket: string;
  workspaceRoot: string;
}

export interface OutlinerClientPaths extends OutlinerPaths {
  mode: "local" | "remote";
}

interface OutlinerClientConfig {
  remote: boolean;
  socketPath?: string;
}

function clientConfigPath(env: NodeJS.ProcessEnv): string {
  const configuredPath = env.OUTLINER_CONFIG_PATH?.trim();
  if (configuredPath) return configuredPath;
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(configHome, "pi-herdr-outliner", "client.json");
}

function readClientConfig(env: NodeJS.ProcessEnv): OutlinerClientConfig | undefined {
  const path = clientConfigPath(env);
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
  const unknownKey = Object.keys(record).find(
    (key) => key !== "remote" && key !== "socketPath",
  );
  if (unknownKey) {
    throw new Error(`Unknown Outliner client config key ${unknownKey} at ${path}`);
  }
  if (typeof record.remote !== "boolean") {
    throw new Error(`Outliner client config at ${path} requires boolean remote`);
  }
  if (record.socketPath !== undefined && typeof record.socketPath !== "string") {
    throw new Error(`Outliner client config socketPath at ${path} must be a string`);
  }
  return {
    remote: record.remote,
    ...(record.socketPath === undefined ? {} : { socketPath: record.socketPath }),
  };
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): OutlinerPaths {
  const workspaceRoot = resolve(env.OUTLINER_WORKSPACE_ROOT ?? process.cwd());
  const baseStateDir =
    env.OUTLINER_STATE_DIR ?? join(homedir(), ".local", "state", "pi-herdr-outliner");
  const workspaceKey = createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 12);
  const stateDir = join(baseStateDir, workspaceKey);

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
  const config = envRemote === undefined ? readClientConfig(env) : undefined;
  const remote = envRemote ?? (config === undefined ? "" : config.remote ? "1" : "0");
  const configuredSocket = (
    env.OUTLINER_SOCKET_PATH ??
    (envRemote === undefined ? config?.socketPath : undefined) ??
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
