import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  currentPaneRuntime,
  focusCurrentPane,
  removeLegacyClientPaneStates,
  resolveServicePaneId,
} from "../src/pane-control";

test("keeps standalone focus inert and treats failed Herdr metadata as optional", () => {
  const originalHerdrEnv = process.env.HERDR_ENV;
  try {
    delete process.env.HERDR_ENV;
    expect(() => focusCurrentPane("/missing/herdr")).not.toThrow();

    process.env.HERDR_ENV = "1";
    expect(currentPaneRuntime("/missing/herdr")).toBeUndefined();
    expect(() => focusCurrentPane("/missing/herdr")).toThrow(
      "Current Herdr pane identity is unavailable",
    );
  } finally {
    if (originalHerdrEnv === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = originalHerdrEnv;
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
