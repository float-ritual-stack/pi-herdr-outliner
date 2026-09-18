import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  resolveClientPaths,
  resolvePaths,
  resolveServicePaths,
} from "../src/paths";

const workspaceRoot = join(tmpdir(), "outliner-workspace");
const stateRoot = join(tmpdir(), "outliner-state");
const forwardedSocket = join(tmpdir(), "outliner-forwarded.sock");
const localEnvironment = {
  OUTLINER_WORKSPACE_ROOT: workspaceRoot,
  OUTLINER_STATE_DIR: stateRoot,
};

test("remote clients use an explicit socket without changing canonical storage paths", () => {
  const canonical = resolvePaths(localEnvironment);
  const client = resolveClientPaths({
    ...localEnvironment,
    OUTLINER_REMOTE: "1",
    OUTLINER_SOCKET_PATH: forwardedSocket,
  });

  expect(client).toEqual({
    ...canonical,
    mode: "remote",
    socket: forwardedSocket,
  });
  expect(resolveClientPaths(localEnvironment)).toEqual({
    ...canonical,
    mode: "local",
  });
});

test("remote client configuration rejects missing, relative, and unpaired socket paths", () => {
  expect(() => resolveClientPaths({
    ...localEnvironment,
    OUTLINER_REMOTE: "1",
  })).toThrow("OUTLINER_REMOTE=1 requires OUTLINER_SOCKET_PATH");
  expect(() => resolveClientPaths({
    ...localEnvironment,
    OUTLINER_REMOTE: "1",
    OUTLINER_SOCKET_PATH: "relative/outliner.sock",
  })).toThrow("OUTLINER_SOCKET_PATH must be an absolute Unix socket path");
  expect(() => resolveClientPaths({
    ...localEnvironment,
    OUTLINER_SOCKET_PATH: forwardedSocket,
  })).toThrow("OUTLINER_SOCKET_PATH requires OUTLINER_REMOTE=1");
});

test("persistent client config supports Herdr processes with stale environments", () => {
  const directory = mkdtempSync(join(tmpdir(), "outliner-client-config-"));
  const configPath = join(directory, "client.json");
  try {
    writeFileSync(configPath, JSON.stringify({
      remote: true,
      socketPath: forwardedSocket,
    }));
    expect(resolveClientPaths({
      ...localEnvironment,
      OUTLINER_CONFIG_PATH: configPath,
    })).toEqual({
      ...resolvePaths(localEnvironment),
      mode: "remote",
      socket: forwardedSocket,
    });
    expect(() => resolveServicePaths({
      ...localEnvironment,
      OUTLINER_CONFIG_PATH: configPath,
    })).toThrow("The Outliner service cannot start in remote client mode");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("canonical service startup rejects remote client mode", () => {
  expect(() => resolveServicePaths({
    ...localEnvironment,
    OUTLINER_REMOTE: "1",
    OUTLINER_SOCKET_PATH: forwardedSocket,
  })).toThrow("The Outliner service cannot start in remote client mode");
  expect(resolveServicePaths(localEnvironment)).toEqual(resolvePaths(localEnvironment));
});
