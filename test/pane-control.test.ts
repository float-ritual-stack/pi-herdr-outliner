import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDetailEditCommand, readPaneId, requestDetailEdit } from "../src/pane-control";

test("persists an atomic multiline edit handoff for the detail pane", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "pi-outliner-pane-control-"));
  try {
    const written = requestDetailEdit(stateDir, "block-123");
    const read = readDetailEditCommand(stateDir);

    expect(read).toEqual(written);
    expect(read?.blockId).toBe("block-123");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

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
