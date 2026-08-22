import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPaneId, resolvePluginPaneId } from "../src/pane-control";


test("reads pane ids and treats malformed state as unavailable", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "pi-outliner-pane-state-"));
  try {
    writeFileSync(join(stateDir, "detail-pane.json"), '{"paneId":"w1:p2"}\n');
    expect(readPaneId(stateDir, "detail")).toBe("w1:p2");

    writeFileSync(join(stateDir, "detail-pane.json"), "not-json");
    expect(readPaneId(stateDir, "detail")).toBeNull();
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

    expect(resolvePluginPaneId(stateDir, "service", herdr)).toBe("w2:p9");
    expect(JSON.parse(readFileSync(join(stateDir, "service-pane.json"), "utf8")).paneId).toBe("w2:p9");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
