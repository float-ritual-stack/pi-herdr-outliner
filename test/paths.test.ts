import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "bun:test";
import {
  resolveClientConfigPath,
  resolveClientPaths,
  resolvePaths,
  resolveServicePaths,
} from "../src/paths";

interface PathsSandbox {
  directory: string;
  environment: NodeJS.ProcessEnv & {
    XDG_CONFIG_HOME: string;
    OUTLINER_STATE_DIR: string;
  };
}

function withPathsSandbox(run: (sandbox: PathsSandbox) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "outliner-paths-"));
  try {
    run({
      directory,
      environment: {
        XDG_CONFIG_HOME: join(directory, "config"),
        OUTLINER_STATE_DIR: join(directory, "state"),
      },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function writeConfig(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

test("only the configured project uses its remote endpoint", () => {
  withPathsSandbox(({ directory, environment }) => {
    const projectAEnvironment = {
      ...environment,
      OUTLINER_WORKSPACE_ROOT: join(directory, "clients", "project-a"),
    };
    const projectBEnvironment = {
      ...environment,
      OUTLINER_WORKSPACE_ROOT: join(directory, "clients", "project-b"),
    };
    const projectCEnvironment = {
      ...environment,
      OUTLINER_WORKSPACE_ROOT: join(directory, "other", "project-c"),
    };
    const remoteSocket = join(directory, "remote", "outliner.sock");
    writeConfig(resolveClientConfigPath(projectAEnvironment), {
      workspaceRoot: resolve(projectAEnvironment.OUTLINER_WORKSPACE_ROOT),
      mode: "remote",
      socketPath: remoteSocket,
      label: "Project A",
    });

    expect(resolveClientPaths(projectAEnvironment)).toEqual({
      ...resolvePaths(projectAEnvironment),
      mode: "remote",
      socket: remoteSocket,
    });
    expect(resolveClientPaths(projectBEnvironment)).toEqual({
      ...resolvePaths(projectBEnvironment),
      mode: "local",
    });
    expect(resolveClientPaths(projectCEnvironment)).toEqual({
      ...resolvePaths(projectCEnvironment),
      mode: "local",
    });
  });
});

test("explicit remote environment values take precedence over project config", () => {
  withPathsSandbox(({ directory, environment }) => {
    const projectEnvironment = {
      ...environment,
      OUTLINER_WORKSPACE_ROOT: join(directory, "project"),
    };
    const configuredSocket = join(directory, "configured.sock");
    const overriddenSocket = join(directory, "overridden.sock");
    writeConfig(resolveClientConfigPath(projectEnvironment), {
      mode: "remote",
      socketPath: configuredSocket,
    });

    expect(resolveClientPaths({
      ...projectEnvironment,
      OUTLINER_SOCKET_PATH: overriddenSocket,
    }).socket).toBe(overriddenSocket);
    expect(resolveClientPaths({
      ...projectEnvironment,
      OUTLINER_REMOTE: "0",
    })).toEqual({
      ...resolvePaths(projectEnvironment),
      mode: "local",
    });
    expect(resolveClientPaths({
      ...projectEnvironment,
      OUTLINER_REMOTE: "1",
      OUTLINER_SOCKET_PATH: overriddenSocket,
    })).toEqual({
      ...resolvePaths(projectEnvironment),
      mode: "remote",
      socket: overriddenSocket,
    });
  });
});

test("OUTLINER_CONFIG_PATH takes precedence over the derived project config", () => {
  withPathsSandbox(({ directory, environment }) => {
    const projectEnvironment = {
      ...environment,
      OUTLINER_WORKSPACE_ROOT: join(directory, "project"),
    };
    const projectSocket = join(directory, "project.sock");
    const explicitSocket = join(directory, "explicit.sock");
    writeConfig(resolveClientConfigPath(projectEnvironment), {
      mode: "remote",
      socketPath: projectSocket,
    });
    const explicitPath = join(directory, "selected-client.json");
    writeConfig(explicitPath, {
      mode: "remote",
      socketPath: explicitSocket,
    });

    expect(resolveClientConfigPath({
      ...projectEnvironment,
      OUTLINER_CONFIG_PATH: explicitPath,
    })).toBe(explicitPath);
    expect(resolveClientPaths({
      ...projectEnvironment,
      OUTLINER_CONFIG_PATH: explicitPath,
    }).socket).toBe(explicitSocket);
  });
});

test("derived config paths are stable, readable, and collision-resistant", () => {
  withPathsSandbox(({ directory, environment }) => {
    const firstEnvironment = {
      ...environment,
      OUTLINER_WORKSPACE_ROOT: join(directory, "customers", "alpha", "workspace"),
    };
    const secondEnvironment = {
      ...environment,
      OUTLINER_WORKSPACE_ROOT: join(directory, "customers", "beta", "workspace"),
    };
    const firstPath = resolveClientConfigPath(firstEnvironment);
    const secondPath = resolveClientConfigPath(secondEnvironment);

    expect(firstPath).toBe(resolveClientConfigPath(firstEnvironment));
    expect(firstPath).toMatch(
      /\/pi-herdr-outliner\/projects\/workspace--[0-9a-f]{12}\/client\.json$/,
    );
    expect(secondPath).toMatch(
      /\/pi-herdr-outliner\/projects\/workspace--[0-9a-f]{12}\/client\.json$/,
    );
    expect(firstPath).not.toBe(secondPath);
  });
});

test("project client config is strictly validated", () => {
  withPathsSandbox(({ directory, environment }) => {
    const projectEnvironment = {
      ...environment,
      OUTLINER_WORKSPACE_ROOT: join(directory, "project"),
    };
    const configPath = resolveClientConfigPath(projectEnvironment);
    const absoluteSocket = join(directory, "remote.sock");
    const invalidConfigs: ReadonlyArray<readonly [unknown, string]> = [
      [{ mode: "local", unexpected: true }, "Unknown Outliner client config key unexpected"],
      [{ mode: "legacy" }, 'must be "local" or "remote"'],
      [{ mode: "remote" }, "must be an absolute Unix socket path"],
      [{ mode: "remote", socketPath: "relative.sock" }, "must be an absolute Unix socket path"],
      [{ mode: "local", socketPath: absoluteSocket }, "must not set socketPath"],
      [{
        mode: "remote",
        socketPath: absoluteSocket,
        workspaceRoot: join(directory, "other-project"),
      }, "does not match invoking workspace"],
      [{ mode: "local", workspaceRoot: 42 }, "workspaceRoot"],
      [{ mode: "local", label: "" }, "label"],
    ];

    for (const [config, expectedError] of invalidConfigs) {
      writeConfig(configPath, config);
      expect(() => resolveClientPaths(projectEnvironment)).toThrow(expectedError);
    }

    writeFileSync(configPath, "{");
    expect(() => resolveClientPaths(projectEnvironment)).toThrow("Invalid JSON");
    writeConfig(configPath, []);
    expect(() => resolveClientPaths(projectEnvironment)).toThrow("must be a JSON object");
  });
});

test("a legacy global config produces a migration error and remains untouched", () => {
  withPathsSandbox(({ directory, environment }) => {
    const projectEnvironment = {
      ...environment,
      OUTLINER_WORKSPACE_ROOT: join(directory, "project"),
    };
    const legacyPath = join(
      environment.XDG_CONFIG_HOME,
      "pi-herdr-outliner",
      "client.json",
    );
    const legacySource = JSON.stringify({
      remote: true,
      socketPath: join(directory, "legacy.sock"),
    });
    mkdirSync(dirname(legacyPath), { recursive: true });
    writeFileSync(legacyPath, legacySource);

    expect(() => resolveClientPaths(projectEnvironment)).toThrow(
      "Legacy Outliner client config found",
    );
    expect(() => resolveClientPaths(projectEnvironment)).toThrow(
      "set OUTLINER_CONFIG_PATH explicitly",
    );
    expect(readFileSync(legacyPath, "utf8")).toBe(legacySource);
  });
});

test("local state and database path derivation is unchanged", () => {
  withPathsSandbox(({ directory, environment }) => {
    const workspaceRoot = resolve(join(directory, "project"));
    const localEnvironment = {
      ...environment,
      OUTLINER_WORKSPACE_ROOT: workspaceRoot,
    };
    const workspaceKey = createHash("sha256")
      .update(workspaceRoot)
      .digest("hex")
      .slice(0, 12);
    const stateDir = join(environment.OUTLINER_STATE_DIR, workspaceKey);
    const canonical = resolvePaths(localEnvironment);

    expect(canonical).toEqual({
      workspaceRoot,
      stateDir,
      database: join(stateDir, "outliner.sqlite"),
      socket: join(stateDir, "outliner.sock"),
    });
    expect(resolveClientPaths(localEnvironment)).toEqual({
      ...canonical,
      mode: "local",
    });
  });
});

test("explicit remote environment rejects missing, relative, and unpaired socket paths", () => {
  withPathsSandbox(({ directory, environment }) => {
    const localEnvironment = {
      ...environment,
      OUTLINER_WORKSPACE_ROOT: join(directory, "project"),
    };
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
      OUTLINER_SOCKET_PATH: join(directory, "forwarded.sock"),
    })).toThrow("OUTLINER_SOCKET_PATH requires OUTLINER_REMOTE=1");
  });
});

test("canonical service startup rejects project remote client mode", () => {
  withPathsSandbox(({ directory, environment }) => {
    const projectEnvironment = {
      ...environment,
      OUTLINER_WORKSPACE_ROOT: join(directory, "project"),
    };
    writeConfig(resolveClientConfigPath(projectEnvironment), {
      mode: "remote",
      socketPath: join(directory, "forwarded.sock"),
    });

    expect(() => resolveServicePaths(projectEnvironment)).toThrow(
      "The Outliner service cannot start in remote client mode",
    );
    expect(resolveServicePaths({
      ...projectEnvironment,
      OUTLINER_REMOTE: "0",
    })).toEqual(resolvePaths(projectEnvironment));
  });
});
