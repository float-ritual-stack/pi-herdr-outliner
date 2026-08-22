import { expect, test } from "bun:test";
import { HerdrRuntimeRegistry, HerdrSnapshotError, type HerdrSessionSnapshot } from "../src/herdr-registry";

function snapshot(paneId = "p1", terminalId = "term-1"): HerdrSessionSnapshot {
  return {
    version: "0.8.2", protocol: 20,
    focused_workspace_id: "w1", focused_tab_id: "t1", focused_pane_id: paneId,
    workspaces: [{ workspace_id: "w1", active_tab_id: "t1", focused: true }],
    tabs: [{ tab_id: "t1", workspace_id: "w1", focused: true }],
    panes: [{ pane_id: paneId, terminal_id: terminalId, workspace_id: "w1", tab_id: "t1", focused: true, agent_status: "idle" }],
    layouts: [{ workspace_id: "w1", tab_id: "t1", focused_pane_id: paneId, panes: [{ pane_id: paneId }] }],
    agents: [{ terminal_id: terminalId, workspace_id: "w1", tab_id: "t1", pane_id: paneId, agent_status: "idle" }],
  };
}

function event(name: string, data: Record<string, unknown>): unknown {
  return { event: name, data: { type: name, ...data } };
}

test("snapshot replacement is atomic and validates references and terminal identity", () => {
  const registry = new HerdrRuntimeRegistry();
  registry.replaceSnapshot(snapshot());
  const invalid = snapshot();
  invalid.panes.push({ pane_id: "p2", terminal_id: "term-1", workspace_id: "w1", tab_id: "t1" });
  expect(() => registry.replaceSnapshot(invalid)).toThrow(HerdrSnapshotError);
  expect(registry.generation).toBe(1);
  expect([...registry.panes.keys()]).toEqual(["p1"]);
  expect(registry.paneIdForTerminal("term-1")).toBe("p1");

  const broken = snapshot("p2", "term-2");
  broken.tabs[0] = { ...broken.tabs[0], workspace_id: "missing" };
  expect(() => registry.replaceSnapshot(broken)).toThrow(HerdrSnapshotError);
  expect(registry.paneIdForTerminal("term-1")).toBe("p1");
});

test("pane moves preserve terminal identity and are idempotent", () => {
  const registry = new HerdrRuntimeRegistry();
  registry.replaceSnapshot(snapshot());
  const moved = event("pane_moved", {
    previous_pane_id: "p1", previous_workspace_id: "w1", previous_tab_id: "t1",
    pane: { pane_id: "p9", terminal_id: "term-1", workspace_id: "w2", tab_id: "t2", focused: true, agent_status: "idle" },
    created_workspace: { workspace_id: "w2", active_tab_id: "t2", focused: true },
    created_tab: { tab_id: "t2", workspace_id: "w2", focused: true },
    closed_workspace_id: "w1", closed_tab_id: "t1",
  });
  expect(registry.applyEvent(moved)).toEqual({ kind: "applied", topologyChanged: true });
  expect(registry.paneIdForTerminal("term-1")).toBe("p9");
  expect(registry.agents.get("term-1")?.pane_id).toBe("p9");
  expect(registry.focusedPaneId).toBe("p9");
  expect(registry.applyEvent(moved)).toEqual({ kind: "applied", topologyChanged: false });
});

test("focus, layout, and dedicated status events update registry state", () => {
  const registry = new HerdrRuntimeRegistry();
  const initial = snapshot();
  initial.panes.push({ pane_id: "p2", terminal_id: "term-2", workspace_id: "w1", tab_id: "t1", focused: false, agent_status: "idle" });
  initial.layouts[0] = { ...initial.layouts[0], panes: [{ pane_id: "p1" }, { pane_id: "p2" }] };
  registry.replaceSnapshot(initial);
  expect(registry.applyEvent(event("pane_focused", { pane_id: "p2", workspace_id: "w1" })).kind).toBe("applied");
  expect(registry.focusedPaneId).toBe("p2");
  expect(registry.applyEvent(event("layout_updated", { layout: { workspace_id: "w1", tab_id: "t1", focused_pane_id: "p2", panes: [{ pane_id: "p2" }, { pane_id: "p1" }] } })).kind).toBe("applied");
  expect(registry.layouts.get("t1")?.focused_pane_id).toBe("p2");

  const status = { event: "pane.agent_status_changed", data: { pane_id: "p2", workspace_id: "w1", agent_status: "working", agent: "claude", title: "Agent" } };
  expect(registry.applyEvent(status)).toEqual({ kind: "applied", topologyChanged: false });
  expect(registry.panes.get("p2")?.agent_status).toBe("working");
  expect(registry.agents.get("term-2")?.agent_status).toBe("working");
  expect(registry.applyEvent(status)).toEqual({ kind: "applied", topologyChanged: false });
});

test("pane updates cannot replace stable terminal identity", () => {
  const registry = new HerdrRuntimeRegistry();
  registry.replaceSnapshot(snapshot());
  const result = registry.applyEvent(event("pane_updated", {
    pane: {
      ...registry.panes.get("p1"),
      terminal_id: "term-replacement",
    },
  }));

  expect(result.kind).toBe("resync");
  expect(registry.panes.get("p1")?.terminal_id).toBe("term-1");
  expect(registry.paneIdForTerminal("term-replacement")).toBeUndefined();
});

test("focused and closed tabs preserve the workspace active-tab invariant", () => {
  const registry = new HerdrRuntimeRegistry();
  const initial = snapshot();
  initial.tabs.push({ tab_id: "t2", workspace_id: "w1", focused: false });
  registry.replaceSnapshot(initial);

  expect(registry.applyEvent(event("tab_focused", {
    tab_id: "t2",
    workspace_id: "w1",
  })).kind).toBe("applied");
  expect(registry.workspaces.get("w1")?.active_tab_id).toBe("t2");

  const close = registry.applyEvent(event("tab_closed", {
    tab_id: "t2",
    workspace_id: "w1",
  }));
  expect(close.kind).toBe("resync");
  expect(registry.tabs.has("t2")).toBe(true);
  expect(registry.workspaces.get("w1")?.active_tab_id).toBe("t2");
});

test("malformed, unknown, and invariant-breaking events request resync without mutation", () => {
  const registry = new HerdrRuntimeRegistry();
  registry.replaceSnapshot(snapshot());
  expect(registry.applyEvent({ nope: true }).kind).toBe("resync");
  expect(registry.applyEvent(event("pane_exited", { pane_id: "p1", workspace_id: "w1" })).kind).toBe("resync");
  expect(registry.applyEvent(event("pane_updated", { pane: { pane_id: "p1", terminal_id: "term-1", workspace_id: "missing", tab_id: "t1" } })).kind).toBe("resync");
  expect(registry.panes.get("p1")?.workspace_id).toBe("w1");
});
