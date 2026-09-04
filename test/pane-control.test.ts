import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  configureCurrentPaneRightClick,
  currentPaneIdentity,
  currentPaneRuntime,
  focusCurrentPane,
  openBacklinkPeekPopup,
  openCapturePopup,
  openDetailPane,
  outlinerRightClickOwnership,
  pluginClickedUrl,
  pluginInvocationPaneId,
  pluginInvocationWorkspaceRoot,
  removeLegacyClientPaneStates,
  resolveServicePaneId,
} from "../src/pane-control";
test("recovers action context from the underlying pane when a modal has no pane env", () => {
  const env = {
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
      clicked_url: "pi-outliner://block/target",
      focused_pane_id: "w1:p7",
      focused_pane_cwd: "/workspace/project",
      workspace_cwd: "/workspace",
    }),
  };

  expect(pluginInvocationPaneId(env)).toBe("w1:p7");
  expect(pluginInvocationWorkspaceRoot(env, "/plugin/root")).toBe("/workspace/project");
  expect(pluginInvocationPaneId({
    ...env,
    HERDR_PANE_ID: "w1:p8",
  })).toBe("w1:p7");
});

test("rejects malformed plugin action context instead of using the plugin cwd", () => {
  expect(() => pluginInvocationPaneId({
    HERDR_PLUGIN_CONTEXT_JSON: "[]",
  })).toThrow("Herdr supplied invalid plugin context");
});
test("validates Outliner right-click ownership", () => {
  expect(outlinerRightClickOwnership({})).toBe("herdr");
  expect(outlinerRightClickOwnership({ OUTLINER_RIGHT_CLICK: "OUTLINER" })).toBe("outliner");
  expect(() => outlinerRightClickOwnership({ OUTLINER_RIGHT_CLICK: "menu" })).toThrow(
    "OUTLINER_RIGHT_CLICK must be herdr or outliner",
  );
});
test("registers and restores Herdr pane-owned secondary click", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-right-click-"));
  const herdr = join(directory, "fake-herdr");
  const logPath = join(directory, "calls.jsonl");
  const originalHerdrEnv = process.env.HERDR_ENV;
  try {
    process.env.HERDR_ENV = "1";
    writeFileSync(
      herdr,
      `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");
`,
    );
    chmodSync(herdr, 0o755);
    configureCurrentPaneRightClick("outliner", herdr);
    configureCurrentPaneRightClick("herdr", herdr);
    const calls = readFileSync(logPath, "utf8").trim().split("\n").map(
      (line) => JSON.parse(line) as string[],
    );
    expect(calls).toEqual([
      ["pane", "input", "--current", "--right-click", "pane"],
      ["pane", "input", "--current", "--right-click", "herdr"],
    ]);
  } finally {
    if (originalHerdrEnv === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = originalHerdrEnv;
    rmSync(directory, { recursive: true, force: true });
  }
});


test("keeps standalone pane behavior compatible and fails live lookup visibly", () => {
  const originalHerdrEnv = process.env.HERDR_ENV;
  const originalPaneId = process.env.HERDR_PANE_ID;
  try {
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_ENV;
    expect(currentPaneRuntime("/missing/herdr")).toBeUndefined();
    expect(() => focusCurrentPane("/missing/herdr")).not.toThrow();

    process.env.HERDR_ENV = "1";
    expect(() => currentPaneRuntime("/missing/herdr")).toThrow(
      "Current Herdr pane identity is unavailable",
    );
    expect(() => focusCurrentPane("/missing/herdr")).toThrow(
      "Current Herdr pane identity is unavailable",
    );
  } finally {
    if (originalHerdrEnv === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = originalHerdrEnv;
    if (originalPaneId === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = originalPaneId;
  }
});

test("never focuses the launch pane after a transient live identity failure", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-pane-fallback-"));
  const herdr = join(directory, "fake-herdr");
  const logPath = join(directory, "calls.jsonl");
  const originalHerdrEnv = process.env.HERDR_ENV;
  const originalPaneId = process.env.HERDR_PANE_ID;
  try {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "w1:launch";
    writeFileSync(
      herdr,
      `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
if (args[0] === "pane" && args[1] === "current") process.exit(1);
console.log(JSON.stringify({ result: { type: "ok" } }));
`,
    );
    chmodSync(herdr, 0o755);
    expect(() => focusCurrentPane(herdr)).toThrow(
      "Current Herdr pane identity is unavailable",
    );
    expect(readFileSync(logPath, "utf8").trim().split("\n").map(
      (line) => JSON.parse(line) as string[],
    )).toEqual([
      ["pane", "current", "--current"],
    ]);
  } finally {
    if (originalHerdrEnv === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = originalHerdrEnv;
    if (originalPaneId === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = originalPaneId;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("never splits from the launch pane after a malformed live identity response", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-pane-malformed-"));
  const herdr = join(directory, "fake-herdr");
  const logPath = join(directory, "calls.jsonl");
  const originalHerdrEnv = process.env.HERDR_ENV;
  const originalPaneId = process.env.HERDR_PANE_ID;
  try {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "w1:launch";
    writeFileSync(
      herdr,
      `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
console.log(JSON.stringify({ result: { pane: { pane_id: 42 } } }));
`,
    );
    chmodSync(herdr, 0o755);

    expect(() => openDetailPane({
      workspaceRoot: "/workspace",
      browsingContextId: "context",
    }, herdr)).toThrow("Current Herdr pane identity is unavailable");
    expect(readFileSync(logPath, "utf8").trim().split("\n").map(
      (line) => JSON.parse(line) as string[],
    )).toEqual([
      ["pane", "current", "--current"],
    ]);
  } finally {
    if (originalHerdrEnv === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = originalHerdrEnv;
    if (originalPaneId === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = originalPaneId;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ignores focus misses for manual panes outside the plugin registry", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-pane-focus-"));
  const logPath = join(directory, "calls.jsonl");
  const herdr = join(directory, "herdr");
  const originalHerdrEnv = process.env.HERDR_ENV;
  try {
    process.env.HERDR_ENV = "1";
    writeFileSync(
      herdr,
      `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
if (args[0] === "pane" && args[1] === "current") {
  console.log(JSON.stringify({ result: { pane: { pane_id: "w1:p2" } } }));
} else if (args[0] === "plugin") {
  console.error(JSON.stringify({ error: { code: "plugin_pane_not_found" } }));
  process.exit(1);
}
`,
    );
    chmodSync(herdr, 0o755);

    expect(() => focusCurrentPane(herdr)).not.toThrow();
    const probe = spawnSync(
      process.execPath,
      ["--eval", `import { focusCurrentPane } from "./src/pane-control.ts"; focusCurrentPane(${JSON.stringify(herdr)});`],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, HERDR_ENV: "1" },
      },
    );
    expect(probe.status).toBe(0);
    const calls = readFileSync(logPath, "utf8").trim().split("\n").map(
      (line) => JSON.parse(line) as string[],
    );
    expect(calls.filter((args) => args[0] === "pane" && args[1] === "layout")).toEqual([]);
    expect(probe.stderr).toBe("");
  } finally {
    if (originalHerdrEnv === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = originalHerdrEnv;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("opens a property inspector from the moved pane's live identity", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-detail-pane-"));
  const herdr = join(directory, "fake-herdr");
  const logPath = join(directory, "calls.jsonl");
  const originalHerdrEnv = process.env.HERDR_ENV;
  const originalPaneId = process.env.HERDR_PANE_ID;
  const originalStateDir = process.env.OUTLINER_STATE_DIR;
  const originalHeaderProperties = process.env.OUTLINER_DETAIL_HEADER_PROPERTIES;
  const originalDestinationTimeout = process.env.OUTLINER_OPEN_DESTINATION_TIMEOUT_MS;
  try {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "w1:p2";
    process.env.OUTLINER_STATE_DIR = "/tmp/outliner-state";
    process.env.OUTLINER_DETAIL_HEADER_PROPERTIES = "work-stage,status";
    process.env.OUTLINER_OPEN_DESTINATION_TIMEOUT_MS = "9000";
    writeFileSync(
      herdr,
      `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
if (args[0] === "pane" && args[1] === "current") {
  console.log(JSON.stringify({ result: { pane: { pane_id: "w1:p9", terminal_id: "term-live", workspace_id: "w1", tab_id: "w1:t1" } } }));
} else if (args[0] === "plugin" && args[1] === "pane" && args[2] === "open") {
  console.log(JSON.stringify({ result: { plugin_pane: { pane: { pane_id: "w1:p3", workspace_id: "w1", tab_id: "w1:t1" } } } }));
} else if (args[0] === "plugin" && args[1] === "pane" && args[2] === "focus") {
  console.log(JSON.stringify({ result: { type: "ok" } }));
}
`,
    );
    chmodSync(herdr, 0o755);

    expect(openDetailPane({
      workspaceRoot: "/workspace",
      browsingContextId: "independent-context",
      propertyInspectorBlockId: "block-property-heavy",
      direction: "right",
    }, herdr)).toBe("w1:p3");

    const calls = readFileSync(logPath, "utf8").trim().split("\n").map(
      (line) => JSON.parse(line) as string[],
    );
    expect(calls).toContainEqual([
      "plugin",
      "pane",
      "open",
      "--plugin",
      "float.pi-outliner",
      "--entrypoint",
      "detail",
      "--env",
      "OUTLINER_WORKSPACE_ROOT=/workspace",
      "--env",
      "OUTLINER_BROWSING_CONTEXT_ID=independent-context",
      "--env",
      "OUTLINER_DETAIL_PRESENTATION=property-inspector",
      "--env",
      "OUTLINER_DETAIL_TARGET_BLOCK_ID=block-property-heavy",
      "--env",
      "OUTLINER_DETAIL_RENDERER=pi-tui",
      "--placement",
      "split",
      "--target-pane",
      "w1:p9",
      "--direction",
      "right",
      "--cwd",
      "/workspace",
      "--no-focus",
      "--env",
      "OUTLINER_STATE_DIR=/tmp/outliner-state",
      "--env",
      "OUTLINER_DETAIL_HEADER_PROPERTIES=work-stage,status",
      "--env",
      "OUTLINER_OPEN_DESTINATION_TIMEOUT_MS=9000",
    ]);
    expect(calls.at(-1)).toEqual(["plugin", "pane", "focus", "w1:p3"]);
    expect(calls.filter((args) => args[0] === "pane" && args[1] === "layout")).toEqual([]);

    openDetailPane({
      workspaceRoot: "/workspace",
      browsingContextId: "new-context",
      targetPaneId: "w1:explicit-source",
      direction: "right",
    }, herdr);
    const explicitTargetCalls = readFileSync(logPath, "utf8").trim().split("\n").map(
      (line) => JSON.parse(line) as string[],
    );
    const explicitTargetOpen = explicitTargetCalls.at(-2)!;
    expect(explicitTargetOpen).toContain("OUTLINER_BROWSING_CONTEXT_ID=new-context");
    expect(explicitTargetOpen.slice(
      explicitTargetOpen.indexOf("--target-pane"),
      explicitTargetOpen.indexOf("--target-pane") + 2,
    )).toEqual(["--target-pane", "w1:explicit-source"]);
  } finally {
    if (originalHerdrEnv === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = originalHerdrEnv;
    if (originalPaneId === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = originalPaneId;
    if (originalStateDir === undefined) delete process.env.OUTLINER_STATE_DIR;
    else process.env.OUTLINER_STATE_DIR = originalStateDir;
    if (originalHeaderProperties === undefined) {
      delete process.env.OUTLINER_DETAIL_HEADER_PROPERTIES;
    } else {
      process.env.OUTLINER_DETAIL_HEADER_PROPERTIES = originalHeaderProperties;
    }
    if (originalDestinationTimeout === undefined) {
      delete process.env.OUTLINER_OPEN_DESTINATION_TIMEOUT_MS;
    } else {
      process.env.OUTLINER_OPEN_DESTINATION_TIMEOUT_MS = originalDestinationTimeout;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("captures current pane coordinates for spatial Detail ordering", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-pane-layout-"));
  const herdr = join(directory, "fake-herdr");
  const logPath = join(directory, "calls.jsonl");
  const originalHerdrEnv = process.env.HERDR_ENV;
  try {
    process.env.HERDR_ENV = "1";
    writeFileSync(
      herdr,
      `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
if (args[0] === "pane" && args[1] === "current") {
  console.log(JSON.stringify({ result: { pane: { pane_id: "w1:p2", terminal_id: "term-2", workspace_id: "w1", tab_id: "w1:t1" } } }));
} else if (args[0] === "pane" && args[1] === "layout") {
  console.log(JSON.stringify({ result: { layout: { panes: [{ pane_id: "w1:p2", rect: { x: 42, y: 7 } }] } } }));
}
`,
    );
    chmodSync(herdr, 0o755);

    expect(currentPaneIdentity(herdr)).toEqual({
      paneId: "w1:p2",
      terminalId: "term-2",
      workspaceId: "w1",
      tabId: "w1:t1",
    });
    expect(readFileSync(logPath, "utf8").trim().split("\n").map(
      (line) => JSON.parse(line) as string[],
    )).toEqual([["pane", "current", "--current"]]);

    expect(currentPaneRuntime(herdr)).toEqual({
      paneId: "w1:p2",
      terminalId: "term-2",
      workspaceId: "w1",
      tabId: "w1:t1",
      paneX: 42,
      paneY: 7,
    });
  } finally {
    if (originalHerdrEnv === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = originalHerdrEnv;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects service pane state from another Herdr server endpoint", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "pi-outliner-server-state-"));
  const originalSocketPath = process.env.HERDR_SOCKET_PATH;
  try {
    process.env.HERDR_SOCKET_PATH = "/current/herdr.sock";
    writeFileSync(
      join(stateDir, "service-pane.json"),
      `${JSON.stringify({
        paneId: "w1:p1",
        terminalId: "term-1",
        workspaceRoot: "/workspace",
        herdrSocketPath: "/different/herdr.sock",
        hostname: hostname(),
      })}\n`,
    );

    expect(resolveServicePaneId(stateDir, "/missing/herdr")).toBeNull();
  } finally {
    if (originalSocketPath === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = originalSocketPath;
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("removes obsolete role-keyed pane state without touching the service singleton", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "pi-outliner-pane-state-"));
  try {
    writeFileSync(join(stateDir, "outliner-pane.json"), "{}\n");
    writeFileSync(join(stateDir, "detail-pane.json"), "{}\n");
    writeFileSync(join(stateDir, "service-pane.json"), "{\"paneId\":\"w1:p1\"}\n");

    removeLegacyClientPaneStates(stateDir);

    expect(existsSync(join(stateDir, "outliner-pane.json"))).toBe(false);
    expect(existsSync(join(stateDir, "detail-pane.json"))).toBe(false);
    expect(existsSync(join(stateDir, "service-pane.json"))).toBe(true);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("recovers a moved service pane by stable terminal identity", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "pi-outliner-service-pane-"));
  const herdr = join(stateDir, "fake-herdr");
  const previousSocketPath = process.env.HERDR_SOCKET_PATH;
  process.env.HERDR_SOCKET_PATH = join(stateDir, "herdr.sock");
  try {
    writeFileSync(
      herdr,
      `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args[0] === "pane" && args[1] === "get") process.exit(1);
if (args[0] === "workspace") console.log(JSON.stringify({ result: { workspaces: [{ workspace_id: "w2" }] } }));
if (args[0] === "pane" && args[1] === "list") console.log(JSON.stringify({ result: { panes: [{ pane_id: "w2:p9", terminal_id: "term-1", label: "Outliner Service", cwd: "/workspace" }] } }));
`,
    );
    chmodSync(herdr, 0o755);
    writeFileSync(
      join(stateDir, "service-pane.json"),
      `${JSON.stringify({
        paneId: "w1:p1",
        terminalId: "term-1",
        workspaceRoot: "/workspace",
        herdrSocketPath: process.env.HERDR_SOCKET_PATH,
        hostname: hostname(),
      })}\n`,
    );

    expect(resolveServicePaneId(stateDir, herdr)).toBe("w2:p9");
    expect(JSON.parse(readFileSync(join(stateDir, "service-pane.json"), "utf8")).paneId).toBe("w2:p9");
  } finally {
    if (previousSocketPath === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = previousSocketPath;
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("opens transient panes through manifest-owned Herdr popup placement", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-capture-pane-"));
  const herdr = join(directory, "fake-herdr");
  const logPath = join(directory, "calls.jsonl");
  const originalHerdrEnv = process.env.HERDR_ENV;
  const originalPaneId = process.env.HERDR_PANE_ID;
  const originalStateDir = process.env.OUTLINER_STATE_DIR;
  const originalDestinationTimeout = process.env.OUTLINER_OPEN_DESTINATION_TIMEOUT_MS;
  try {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "w1:p2";
    process.env.OUTLINER_STATE_DIR = "/tmp/outliner-state";
    process.env.OUTLINER_OPEN_DESTINATION_TIMEOUT_MS = "9000";
    writeFileSync(
      herdr,
      `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
if (args[0] === "plugin" && args[1] === "pane" && args[2] === "open") {
  console.log(JSON.stringify({ result: { type: "ok" } }));
}
`,
    );
    chmodSync(herdr, 0o755);

    openCapturePopup({
      workspaceRoot: "/workspace",
      capturedFromBlockId: "origin",
    }, herdr);

    const calls = readFileSync(logPath, "utf8").trim().split("\n").map(
      (line) => JSON.parse(line) as string[],
    );
    const openCall = calls.find(
      (args) => args[0] === "plugin" && args[1] === "pane" && args[2] === "open",
    )!;
    expect(openCall).toContain("capture");
    expect(openCall).toContain("OUTLINER_WORKSPACE_ROOT=/workspace");
    expect(openCall).toContain("OUTLINER_CAPTURE_FROM_BLOCK_ID=origin");
    expect(openCall.find((argument) => argument.startsWith("OUTLINER_CAPTURE_REQUEST_ID=")))
      .toMatch(/^OUTLINER_CAPTURE_REQUEST_ID=[0-9a-f-]{36}$/);
    expect(openCall).toContain("--focus");
    expect(openCall).not.toContain("--placement");

    openBacklinkPeekPopup({
      workspaceRoot: "/workspace",
      browsingContextId: "context-one",
      sourceClientId: "detail-one",
      targetBlockId: "hub",
      selectedSourceBlockId: "source-two",
      filter: "road map",
      sortField: "created",
      sortDirection: "asc",
    }, herdr);
    const backlinkCalls = readFileSync(logPath, "utf8").trim().split("\n").map(
      (line) => JSON.parse(line) as string[],
    );
    const backlinkOpen = backlinkCalls.at(-1)!;
    expect(backlinkOpen).toContain("backlink-peek");
    expect(backlinkOpen).toContain("OUTLINER_WORKSPACE_ROOT=/workspace");
    expect(backlinkOpen).toContain("OUTLINER_BROWSING_CONTEXT_ID=context-one");
    expect(backlinkOpen).toContain("OUTLINER_BACKLINK_SOURCE_CLIENT_ID=detail-one");
    expect(backlinkOpen).toContain("OUTLINER_BACKLINK_TARGET_BLOCK_ID=hub");
    expect(backlinkOpen).toContain("OUTLINER_BACKLINK_SELECTED_SOURCE_ID=source-two");
    expect(backlinkOpen).toContain("OUTLINER_BACKLINK_FILTER=road map");
    expect(backlinkOpen).toContain("OUTLINER_BACKLINK_SORT_FIELD=created");
    expect(backlinkOpen).toContain("OUTLINER_BACKLINK_SORT_DIRECTION=asc");
    expect(backlinkOpen).toContain("OUTLINER_OPEN_DESTINATION_TIMEOUT_MS=9000");
    expect(backlinkOpen).toContain("--focus");
    expect(backlinkOpen).not.toContain("--placement");
  } finally {
    if (originalHerdrEnv === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = originalHerdrEnv;
    if (originalPaneId === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = originalPaneId;
    if (originalStateDir === undefined) delete process.env.OUTLINER_STATE_DIR;
    else process.env.OUTLINER_STATE_DIR = originalStateDir;
    if (originalDestinationTimeout === undefined) {
      delete process.env.OUTLINER_OPEN_DESTINATION_TIMEOUT_MS;
    } else {
      process.env.OUTLINER_OPEN_DESTINATION_TIMEOUT_MS = originalDestinationTimeout;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
