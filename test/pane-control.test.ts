import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeLegacyClientPaneStates, resolveServicePaneId } from "../src/pane-control";


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
      `${JSON.stringify({ paneId: "w1:p1", terminalId: "term-1", workspaceRoot: "/workspace" })}\n`,
    );

    expect(resolveServicePaneId(stateDir, herdr)).toBe("w2:p9");
    expect(JSON.parse(readFileSync(join(stateDir, "service-pane.json"), "utf8")).paneId).toBe("w2:p9");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
