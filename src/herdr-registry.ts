export type HerdrRegistryPhase = "empty" | "ready" | "stale";

interface HerdrRecord {
  [key: string]: unknown;
}

interface ExitedPaneIdentity {
  terminal_id: string;
  workspace_id: string;
}

const EXITED_PANE_LIMIT = 512;

export interface HerdrWorkspace extends HerdrRecord {
  workspace_id: string;
  active_tab_id: string;
}

export interface HerdrTab extends HerdrRecord {
  tab_id: string;
  workspace_id: string;
}

export interface HerdrPane extends HerdrRecord {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  agent_status?: string;
}

export interface HerdrLayoutPane extends HerdrRecord {
  pane_id: string;
}

export interface HerdrLayout extends HerdrRecord {
  workspace_id: string;
  tab_id: string;
  focused_pane_id: string;
  panes: HerdrLayoutPane[];
}

export interface HerdrAgent extends HerdrRecord {
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  pane_id: string;
  agent_status?: string;
}

export interface HerdrSessionSnapshot {
  version: string;
  protocol: number;
  focused_workspace_id?: string | null;
  focused_tab_id?: string | null;
  focused_pane_id?: string | null;
  workspaces: HerdrWorkspace[];
  tabs: HerdrTab[];
  panes: HerdrPane[];
  layouts: HerdrLayout[];
  agents: HerdrAgent[];
}

export type HerdrApplyResult =
  | { kind: "applied"; topologyChanged: boolean }
  | { kind: "resync"; reason: string };

export class HerdrSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HerdrSnapshotError";
  }
}

interface RegistryState {
  workspaces: Map<string, HerdrWorkspace>;
  tabs: Map<string, HerdrTab>;
  panes: Map<string, HerdrPane>;
  layouts: Map<string, HerdrLayout>;
  agents: Map<string, HerdrAgent>;
  terminalIndex: Map<string, string>;
  exitedPanes: Map<string, ExitedPaneIdentity>;
  focusedWorkspaceId: string | null;
  focusedTabId: string | null;
  focusedPaneId: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, name: string): string {
  const value = record[name];
  if (typeof value !== "string" || value.length === 0) throw new HerdrSnapshotError(`invalid ${name}`);
  return value;
}

function optionalId(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0) throw new HerdrSnapshotError(`invalid ${name}`);
  return value;
}

function recordMap<T extends HerdrRecord>(
  value: unknown,
  idName: string,
  validate: (record: Record<string, unknown>) => T,
): Map<string, T> {
  if (!Array.isArray(value)) throw new HerdrSnapshotError(`${idName} records must be an array`);
  const result = new Map<string, T>();
  for (const item of value) {
    if (!isRecord(item)) throw new HerdrSnapshotError(`invalid ${idName} record`);
    const record = validate(item);
    const id = stringField(record, idName);
    if (result.has(id)) throw new HerdrSnapshotError(`duplicate ${idName}: ${id}`);
    result.set(id, record);
  }
  return result;
}

function workspaceRecord(record: Record<string, unknown>): HerdrWorkspace {
  stringField(record, "workspace_id");
  stringField(record, "active_tab_id");
  return record as HerdrWorkspace;
}

function tabRecord(record: Record<string, unknown>): HerdrTab {
  stringField(record, "tab_id");
  stringField(record, "workspace_id");
  return record as HerdrTab;
}

function paneRecord(record: Record<string, unknown>): HerdrPane {
  stringField(record, "pane_id");
  stringField(record, "terminal_id");
  stringField(record, "workspace_id");
  stringField(record, "tab_id");
  return record as HerdrPane;
}

function hasTerminalIdentity(pane: HerdrPane | undefined, terminalId: string): boolean {
  return pane?.terminal_id === terminalId;
}

function layoutRecord(record: Record<string, unknown>): HerdrLayout {
  stringField(record, "workspace_id");
  stringField(record, "tab_id");
  stringField(record, "focused_pane_id");
  if (!Array.isArray(record.panes)) throw new HerdrSnapshotError("layout panes must be an array");
  for (const pane of record.panes) {
    if (!isRecord(pane)) throw new HerdrSnapshotError("invalid layout pane");
    stringField(pane, "pane_id");
  }
  return record as unknown as HerdrLayout;
}

function agentRecord(record: Record<string, unknown>): HerdrAgent {
  stringField(record, "terminal_id");
  stringField(record, "workspace_id");
  stringField(record, "tab_id");
  stringField(record, "pane_id");
  return record as HerdrAgent;
}

function buildTerminalIndex(panes: ReadonlyMap<string, HerdrPane>): Map<string, string> {
  const index = new Map<string, string>();
  for (const pane of panes.values()) {
    const existingPaneId = index.get(pane.terminal_id);
    if (existingPaneId !== undefined && existingPaneId !== pane.pane_id) {
      throw new HerdrSnapshotError(`duplicate terminal_id: ${pane.terminal_id}`);
    }
    index.set(pane.terminal_id, pane.pane_id);
  }
  return index;
}

function validateState(state: RegistryState): void {
  for (const tab of state.tabs.values()) {
    if (!state.workspaces.has(tab.workspace_id)) {
      throw new HerdrSnapshotError(`tab ${tab.tab_id} references missing workspace ${tab.workspace_id}`);
    }
  }
  for (const workspace of state.workspaces.values()) {
    if (state.tabs.get(workspace.active_tab_id)?.workspace_id !== workspace.workspace_id) {
      throw new HerdrSnapshotError(
        `workspace ${workspace.workspace_id} references invalid active tab ${workspace.active_tab_id}`,
      );
    }
  }
  for (const pane of state.panes.values()) {
    const tab = state.tabs.get(pane.tab_id);
    if (!state.workspaces.has(pane.workspace_id) || tab?.workspace_id !== pane.workspace_id) {
      throw new HerdrSnapshotError(`pane ${pane.pane_id} has invalid workspace/tab references`);
    }
  }
  state.terminalIndex = buildTerminalIndex(state.panes);
  for (const layout of state.layouts.values()) {
    const tab = state.tabs.get(layout.tab_id);
    if (tab?.workspace_id !== layout.workspace_id) {
      throw new HerdrSnapshotError(`layout ${layout.tab_id} has invalid workspace/tab references`);
    }
    if (state.panes.get(layout.focused_pane_id)?.tab_id !== layout.tab_id) {
      throw new HerdrSnapshotError(`layout ${layout.tab_id} references invalid focused pane`);
    }
    for (const item of layout.panes) {
      const pane = state.panes.get(item.pane_id);
      if (pane?.tab_id !== layout.tab_id) {
        throw new HerdrSnapshotError(`layout ${layout.tab_id} references invalid pane ${item.pane_id}`);
      }
    }
  }
  for (const [terminalId, agent] of state.agents) {
    const paneId = state.terminalIndex.get(terminalId);
    const pane = paneId === undefined ? undefined : state.panes.get(paneId);
    if (
      pane === undefined ||
      agent.pane_id !== pane.pane_id ||
      agent.workspace_id !== pane.workspace_id ||
      agent.tab_id !== pane.tab_id
    ) {
      throw new HerdrSnapshotError(`agent ${terminalId} has invalid pane references`);
    }
  }
  if (state.focusedWorkspaceId !== null && !state.workspaces.has(state.focusedWorkspaceId)) {
    throw new HerdrSnapshotError("focused workspace is missing");
  }
  if (state.focusedTabId !== null) {
    const tab = state.tabs.get(state.focusedTabId);
    if (tab === undefined || (state.focusedWorkspaceId !== null && tab.workspace_id !== state.focusedWorkspaceId)) {
      throw new HerdrSnapshotError("focused tab is missing or outside the focused workspace");
    }
  }
  if (state.focusedPaneId !== null) {
    const pane = state.panes.get(state.focusedPaneId);
    if (pane === undefined || (state.focusedTabId !== null && pane.tab_id !== state.focusedTabId)) {
      throw new HerdrSnapshotError("focused pane is missing or outside the focused tab");
    }
  }
}

function cloneState(
  registry: HerdrRuntimeRegistry,
  exitedPanes: ReadonlyMap<string, ExitedPaneIdentity>,
): RegistryState {
  return {
    workspaces: new Map(registry.workspaces),
    tabs: new Map(registry.tabs),
    panes: new Map(registry.panes),
    layouts: new Map(registry.layouts),
    agents: new Map(registry.agents),
    terminalIndex: new Map(registry.terminalIndex),
    exitedPanes: new Map(exitedPanes),
    focusedWorkspaceId: registry.focusedWorkspaceId,
    focusedTabId: registry.focusedTabId,
    focusedPaneId: registry.focusedPaneId,
  };
}

function removePane(state: RegistryState, paneId: string): void {
  const pane = state.panes.get(paneId);
  if (pane === undefined) return;
  state.panes.delete(paneId);
  state.agents.delete(pane.terminal_id);
  state.layouts.delete(pane.tab_id);
  if (state.focusedPaneId === paneId) state.focusedPaneId = null;
}

function removeTab(state: RegistryState, tabId: string): void {
  if (!state.tabs.has(tabId)) return;
  for (const pane of state.panes.values()) {
    if (pane.tab_id === tabId) removePane(state, pane.pane_id);
  }
  state.tabs.delete(tabId);
  state.layouts.delete(tabId);
  if (state.focusedTabId === tabId) {
    state.focusedTabId = null;
    state.focusedPaneId = null;
  }
}

function removeWorkspace(state: RegistryState, workspaceId: string): void {
  if (!state.workspaces.has(workspaceId)) return;
  for (const tab of state.tabs.values()) {
    if (tab.workspace_id === workspaceId) removeTab(state, tab.tab_id);
  }
  state.workspaces.delete(workspaceId);
  if (state.focusedWorkspaceId === workspaceId) {
    state.focusedWorkspaceId = null;
    state.focusedTabId = null;
    state.focusedPaneId = null;
  }
}

function markFocused<T extends HerdrRecord>(records: Map<string, T>, focusedId: string): void {
  for (const [id, record] of records) {
    records.set(id, { ...record, focused: id === focusedId });
  }
}

function setFocusedWorkspace(state: RegistryState, workspaceId: string): void {
  if (!state.workspaces.has(workspaceId)) throw new HerdrSnapshotError(`unknown workspace ${workspaceId}`);
  markFocused(state.workspaces, workspaceId);
  state.focusedWorkspaceId = workspaceId;
  if (state.focusedTabId !== null && state.tabs.get(state.focusedTabId)?.workspace_id !== workspaceId) {
    state.focusedTabId = null;
    state.focusedPaneId = null;
  }
}

function setFocusedTab(state: RegistryState, tabId: string, workspaceId: string): void {
  const tab = state.tabs.get(tabId);
  if (tab?.workspace_id !== workspaceId) throw new HerdrSnapshotError(`unknown tab ${tabId}`);
  setFocusedWorkspace(state, workspaceId);
  const workspace = state.workspaces.get(workspaceId);
  if (workspace === undefined) throw new HerdrSnapshotError(`unknown workspace ${workspaceId}`);
  state.workspaces.set(workspaceId, { ...workspace, active_tab_id: tabId });
  markFocused(state.tabs, tabId);
  state.focusedTabId = tabId;
  if (state.focusedPaneId !== null && state.panes.get(state.focusedPaneId)?.tab_id !== tabId) {
    state.focusedPaneId = null;
  }
}

function setFocusedPane(state: RegistryState, paneId: string, workspaceId: string): void {
  const pane = state.panes.get(paneId);
  if (pane?.workspace_id !== workspaceId) throw new HerdrSnapshotError(`unknown pane ${paneId}`);
  setFocusedTab(state, pane.tab_id, workspaceId);
  markFocused(state.panes, paneId);
  state.focusedPaneId = paneId;
}

function objectField(record: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = record[name];
  if (!isRecord(value)) throw new HerdrSnapshotError(`invalid ${name}`);
  return value;
}

function arrayField(record: Record<string, unknown>, name: string): Record<string, unknown>[] {
  const value = record[name];
  if (!Array.isArray(value) || value.some((item) => !isRecord(item))) {
    throw new HerdrSnapshotError(`invalid ${name}`);
  }
  return value as Record<string, unknown>[];
}

function mergeStatus<T extends HerdrPane | HerdrAgent>(record: T, data: Record<string, unknown>): T {
  const patch: Record<string, unknown> = {};
  for (const name of ["agent_status", "agent", "title", "display_agent", "state_labels"]) {
    if (name in data) patch[name] = data[name];
  }
  if (typeof patch.agent_status !== "string") throw new HerdrSnapshotError("invalid agent_status");
  return { ...record, ...patch };
}

function paneForDetection(
  state: RegistryState,
  data: Record<string, unknown>,
): HerdrPane {
  const pane = state.panes.get(stringField(data, "pane_id"));
  if (pane === undefined || stringField(data, "workspace_id") !== pane.workspace_id) {
    throw new HerdrSnapshotError("detection references an unknown pane");
  }
  return pane;
}

function storePane(state: RegistryState, pane: HerdrPane): void {
  state.panes.set(pane.pane_id, pane);
  state.exitedPanes.delete(pane.pane_id);
  const agent = state.agents.get(pane.terminal_id);
  if (agent !== undefined) {
    state.agents.set(pane.terminal_id, {
      ...agent,
      pane_id: pane.pane_id,
      tab_id: pane.tab_id,
      workspace_id: pane.workspace_id,
    });
  }
}

function agentDetectionPatch(data: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if ("agent" in data) {
    if (data.agent !== null && typeof data.agent !== "string") {
      throw new HerdrSnapshotError("invalid agent");
    }
    patch.agent = data.agent;
  }
  if ("final_status" in data) {
    if (data.final_status !== null && typeof data.final_status !== "string") {
      throw new HerdrSnapshotError("invalid final_status");
    }
    if (data.final_status !== null) patch.agent_status = data.final_status;
  }
  return patch;
}

export class HerdrRuntimeRegistry {
  phase: HerdrRegistryPhase = "empty";
  generation = 0;
  version: string | null = null;
  protocol: number | null = null;
  workspaces: ReadonlyMap<string, HerdrWorkspace> = new Map();
  tabs: ReadonlyMap<string, HerdrTab> = new Map();
  panes: ReadonlyMap<string, HerdrPane> = new Map();
  layouts: ReadonlyMap<string, HerdrLayout> = new Map();
  agents: ReadonlyMap<string, HerdrAgent> = new Map();
  terminalIndex: ReadonlyMap<string, string> = new Map();
  focusedWorkspaceId: string | null = null;
  focusedTabId: string | null = null;
  focusedPaneId: string | null = null;
  private exitedPanes = new Map<string, ExitedPaneIdentity>();

  replaceSnapshot(snapshot: HerdrSessionSnapshot): void {
    if (!isRecord(snapshot) || typeof snapshot.version !== "string" || typeof snapshot.protocol !== "number") {
      throw new HerdrSnapshotError("invalid session snapshot header");
    }
    const state: RegistryState = {
      workspaces: recordMap(snapshot.workspaces, "workspace_id", workspaceRecord),
      tabs: recordMap(snapshot.tabs, "tab_id", tabRecord),
      panes: recordMap(snapshot.panes, "pane_id", paneRecord),
      layouts: recordMap(snapshot.layouts, "tab_id", layoutRecord),
      agents: recordMap(snapshot.agents, "terminal_id", agentRecord),
      terminalIndex: new Map(),
      exitedPanes: new Map(),
      focusedWorkspaceId: optionalId(snapshot.focused_workspace_id, "focused_workspace_id"),
      focusedTabId: optionalId(snapshot.focused_tab_id, "focused_tab_id"),
      focusedPaneId: optionalId(snapshot.focused_pane_id, "focused_pane_id"),
    };
    validateState(state);
    this.version = snapshot.version;
    this.protocol = snapshot.protocol;
    this.commit(state);
    this.generation += 1;
    this.phase = "ready";
  }

  markStale(): void {
    this.phase = "stale";
  }

  paneIdForTerminal(terminalId: string): string | undefined {
    return this.terminalIndex.get(terminalId);
  }

  applyEvent(message: unknown): HerdrApplyResult {
    try {
      if (!isRecord(message) || typeof message.event !== "string" || !isRecord(message.data)) {
        throw new HerdrSnapshotError("malformed event envelope");
      }
      const dotted = message.event.includes(".");
      const event = dotted ? message.event.replaceAll(".", "_") : message.event;
      const data = message.data;
      if (!dotted && data.type !== event) throw new HerdrSnapshotError("event/data type mismatch");
      if (dotted && event !== "pane_agent_status_changed") {
        throw new HerdrSnapshotError(`unsupported dedicated event ${message.event}`);
      }

      const state = cloneState(this, this.exitedPanes);
      const panesBefore = new Set(state.panes.keys());
      this.reduce(state, event, data);
      validateState(state);
      this.commit(state);
      const topologyChanged =
        panesBefore.size !== state.panes.size || [...panesBefore].some((paneId) => !state.panes.has(paneId));
      return { kind: "applied", topologyChanged };
    } catch (error) {
      return { kind: "resync", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  private reduce(state: RegistryState, event: string, data: Record<string, unknown>): void {
    switch (event) {
      case "workspace_created":
      case "workspace_updated":
      case "workspace_metadata_updated": {
        const workspace = workspaceRecord(objectField(data, "workspace"));
        state.workspaces.set(workspace.workspace_id, workspace);
        return;
      }
      case "workspace_renamed": {
        const id = stringField(data, "workspace_id");
        const workspace = state.workspaces.get(id);
        if (workspace === undefined || typeof data.label !== "string") throw new HerdrSnapshotError("invalid workspace rename");
        state.workspaces.set(id, { ...workspace, label: data.label });
        return;
      }
      case "workspace_moved":
      case "workspace_reordered":
        for (const record of arrayField(data, "workspaces")) {
          const workspace = workspaceRecord(record);
          state.workspaces.set(workspace.workspace_id, workspace);
        }
        return;
      case "workspace_closed":
        removeWorkspace(state, stringField(data, "workspace_id"));
        return;
      case "workspace_focused":
        setFocusedWorkspace(state, stringField(data, "workspace_id"));
        return;
      case "tab_created": {
        const tab = tabRecord(objectField(data, "tab"));
        state.tabs.set(tab.tab_id, tab);
        return;
      }
      case "tab_renamed": {
        const id = stringField(data, "tab_id");
        const tab = state.tabs.get(id);
        if (tab === undefined || typeof data.label !== "string") throw new HerdrSnapshotError("invalid tab rename");
        state.tabs.set(id, { ...tab, label: data.label });
        return;
      }
      case "tab_moved":
        for (const record of arrayField(data, "tabs")) {
          const tab = tabRecord(record);
          state.tabs.set(tab.tab_id, tab);
        }
        return;
      case "tab_closed":
        removeTab(state, stringField(data, "tab_id"));
        return;
      case "tab_focused":
        setFocusedTab(state, stringField(data, "tab_id"), stringField(data, "workspace_id"));
        return;
      case "pane_created": {
        const pane = paneRecord(objectField(data, "pane"));
        const existing = state.panes.get(pane.pane_id);
        if (existing !== undefined && !hasTerminalIdentity(existing, pane.terminal_id)) {
          throw new HerdrSnapshotError("pane create changed terminal identity");
        }
        storePane(state, pane);
        return;
      }
      case "pane_updated": {
        const pane = paneRecord(objectField(data, "pane"));
        const existing = state.panes.get(pane.pane_id);
        if (!hasTerminalIdentity(existing, pane.terminal_id)) {
          throw new HerdrSnapshotError("pane update changed or omitted terminal identity");
        }
        storePane(state, pane);
        return;
      }
      case "pane_closed":
        removePane(state, stringField(data, "pane_id"));
        return;
      case "pane_focused":
        setFocusedPane(state, stringField(data, "pane_id"), stringField(data, "workspace_id"));
        return;
      case "pane_moved": {
        const previousPaneId = stringField(data, "previous_pane_id");
        const pane = paneRecord(objectField(data, "pane"));
        const previous = state.panes.get(previousPaneId);
        const alreadyMoved = previous === undefined && hasTerminalIdentity(state.panes.get(pane.pane_id), pane.terminal_id);
        if (previous !== undefined && !hasTerminalIdentity(previous, pane.terminal_id)) throw new HerdrSnapshotError("pane move changed terminal identity");
        if (previous === undefined && !alreadyMoved) throw new HerdrSnapshotError("pane move source is missing");
        const agent = state.agents.get(pane.terminal_id);
        const wasFocused = state.focusedPaneId === previousPaneId;
        if (data.created_workspace !== undefined) {
          const workspace = workspaceRecord(objectField(data, "created_workspace"));
          state.workspaces.set(workspace.workspace_id, workspace);
        }
        if (data.created_tab !== undefined) {
          const tab = tabRecord(objectField(data, "created_tab"));
          state.tabs.set(tab.tab_id, tab);
        }
        if (data.closed_tab_id !== undefined && data.closed_tab_id !== null) removeTab(state, stringField(data, "closed_tab_id"));
        if (data.closed_workspace_id !== undefined && data.closed_workspace_id !== null) removeWorkspace(state, stringField(data, "closed_workspace_id"));
        if (previousPaneId !== pane.pane_id) state.panes.delete(previousPaneId);
        state.layouts.delete(stringField(data, "previous_tab_id"));
        state.layouts.delete(pane.tab_id);
        storePane(state, pane);
        if (agent !== undefined) {
          state.agents.set(pane.terminal_id, {
            ...agent,
            pane_id: pane.pane_id,
            tab_id: pane.tab_id,
            workspace_id: pane.workspace_id,
          });
        }
        if (wasFocused) {
          state.focusedWorkspaceId = pane.workspace_id;
          state.focusedTabId = pane.tab_id;
          state.focusedPaneId = pane.pane_id;
        }
        return;
      }
      case "pane_exited": {
        const paneId = stringField(data, "pane_id");
        const workspaceId = stringField(data, "workspace_id");
        const pane = state.panes.get(paneId);
        const identity = pane ?? state.exitedPanes.get(paneId);
        if (identity?.workspace_id !== workspaceId) {
          throw new HerdrSnapshotError("exit references an unknown pane");
        }
        if (pane === undefined) return;
        state.exitedPanes.set(paneId, {
          terminal_id: pane.terminal_id,
          workspace_id: pane.workspace_id,
        });
        if (state.exitedPanes.size > EXITED_PANE_LIMIT) {
          const oldestPaneId = state.exitedPanes.keys().next().value;
          if (oldestPaneId !== undefined) state.exitedPanes.delete(oldestPaneId);
        }
        removePane(state, paneId);
        return;
      }
      case "pane_agent_detected": {
        const pane = paneForDetection(state, data);
        if (data.released !== undefined && typeof data.released !== "boolean") {
          throw new HerdrSnapshotError("invalid released");
        }
        const patch = agentDetectionPatch(data);
        if (Object.keys(patch).length > 0) {
          state.panes.set(pane.pane_id, { ...pane, ...patch });
        }
        if (data.released === true) {
          state.agents.delete(pane.terminal_id);
          return;
        }
        const existing = state.agents.get(pane.terminal_id);
        state.agents.set(pane.terminal_id, {
          ...existing,
          terminal_id: pane.terminal_id,
          workspace_id: pane.workspace_id,
          tab_id: pane.tab_id,
          pane_id: pane.pane_id,
          ...patch,
        });
        return;
      }
      case "layout_updated": {
        const layout = layoutRecord(objectField(data, "layout"));
        state.layouts.set(layout.tab_id, layout);
        return;
      }
      case "pane_agent_status_changed": {
        const paneId = stringField(data, "pane_id");
        const pane = state.panes.get(paneId);
        if (pane === undefined || (data.workspace_id !== undefined && data.workspace_id !== pane.workspace_id)) {
          throw new HerdrSnapshotError("status references an unknown pane");
        }
        state.panes.set(paneId, mergeStatus(pane, data));
        const existing = state.agents.get(pane.terminal_id);
        if (existing !== undefined || typeof data.agent === "string") {
          const agent: HerdrAgent = existing ?? { terminal_id: pane.terminal_id, workspace_id: pane.workspace_id, tab_id: pane.tab_id, pane_id: pane.pane_id };
          state.agents.set(pane.terminal_id, mergeStatus(agent, data));
        }
        return;
      }
      default:
        throw new HerdrSnapshotError(`unsupported partial event ${event}`);
    }
  }

  private commit(state: RegistryState): void {
    this.workspaces = state.workspaces;
    this.tabs = state.tabs;
    this.panes = state.panes;
    this.layouts = state.layouts;
    this.agents = state.agents;
    this.exitedPanes = state.exitedPanes;
    this.terminalIndex = state.terminalIndex;
    this.focusedWorkspaceId = state.focusedWorkspaceId;
    this.focusedTabId = state.focusedTabId;
    this.focusedPaneId = state.focusedPaneId;
  }
}
