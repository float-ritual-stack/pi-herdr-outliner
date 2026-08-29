import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Parse } from "typebox/value";
import type { OutlinerClientRuntime } from "./types";

export type PaneEntrypoint = "service" | "outliner" | "detail";

const PaneStateSchema = Type.Object({
  paneId: Type.String(),
  terminalId: Type.Optional(Type.String()),
  workspaceRoot: Type.Optional(Type.String()),
  herdrSocketPath: Type.Optional(Type.String()),
  hostname: Type.Optional(Type.String()),
});
type PaneState = Static<typeof PaneStateSchema>;

const HerdrPaneSchema = Type.Object({
  pane_id: Type.String(),
  terminal_id: Type.Optional(Type.String()),
  label: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String()),
  foreground_cwd: Type.Optional(Type.String()),
  workspace_id: Type.Optional(Type.String()),
  tab_id: Type.Optional(Type.String()),
});
type HerdrPane = Static<typeof HerdrPaneSchema>;

const PaneGetResponseSchema = Type.Object({
  result: Type.Object({ pane: HerdrPaneSchema }),
});
const PaneCurrentResponseSchema = Type.Object({
  result: Type.Object({ pane: HerdrPaneSchema }),
});
const WorkspaceListResponseSchema = Type.Object({
  result: Type.Object({
    workspaces: Type.Array(Type.Object({ workspace_id: Type.String() })),
  }),
});
const PaneListResponseSchema = Type.Object({
  result: Type.Object({ panes: Type.Array(HerdrPaneSchema) }),
});
const PaneLayoutResponseSchema = Type.Object({
  result: Type.Object({
    layout: Type.Object({
      panes: Type.Array(Type.Object({
        pane_id: Type.String(),
        rect: Type.Object({
          x: Type.Number(),
          y: Type.Number(),
        }),
      })),
    }),
  }),
});

const SERVICE_PANE_LABEL = "Outliner Service";
const HERDR_COMMAND_TIMEOUT_MS = 2_000;

function invokeHerdr(herdr: string, args: string[]): string {
  return execFileSync(herdr, args, {
    encoding: "utf8",
    timeout: HERDR_COMMAND_TIMEOUT_MS,
  });
}

function runtimeFromPane(pane: HerdrPane): OutlinerClientRuntime {
  return {
    paneId: pane.pane_id,
    ...(pane.terminal_id ? { terminalId: pane.terminal_id } : {}),
    ...(pane.workspace_id ? { workspaceId: pane.workspace_id } : {}),
    ...(pane.tab_id ? { tabId: pane.tab_id } : {}),
  };
}

export function currentPaneRuntime(
  herdr = process.env.HERDR_BIN_PATH ?? "herdr",
): OutlinerClientRuntime | undefined {
  if (process.env.HERDR_ENV !== "1") return undefined;
  try {
    const output = invokeHerdr(herdr, ["pane", "current", "--current"]);
    const pane = Parse(PaneCurrentResponseSchema, JSON.parse(output)).result.pane;
    const runtime = runtimeFromPane(pane);
    try {
      const layoutOutput = invokeHerdr(herdr, ["pane", "layout", "--pane", pane.pane_id]);
      const layout = Parse(PaneLayoutResponseSchema, JSON.parse(layoutOutput)).result.layout;
      const positioned = layout.panes.find((candidate) => candidate.pane_id === pane.pane_id);
      if (positioned) {
        runtime.paneX = positioned.rect.x;
        runtime.paneY = positioned.rect.y;
      }
    } catch {
      // Pane identity remains useful when spatial metadata is unavailable.
    }
    return runtime;
  } catch {
    return undefined;
  }
}

export function paneLabel(
  paneId: string,
  herdr = process.env.HERDR_BIN_PATH ?? "herdr",
): string | null {
  if (process.env.HERDR_ENV !== "1") return null;
  try {
    const output = invokeHerdr(herdr, ["pane", "get", paneId]);
    const pane = Parse(PaneGetResponseSchema, JSON.parse(output)).result.pane;
    return pane.label?.trim() || null;
  } catch {
    return null;
  }
}

export function focusCurrentPane(
  herdr = process.env.HERDR_BIN_PATH ?? "herdr",
): void {
  if (process.env.HERDR_ENV !== "1") return;
  const paneId = currentPaneRuntime(herdr)?.paneId;
  if (!paneId) throw new Error("Current Herdr pane identity is unavailable");
  invokeHerdr(herdr, ["plugin", "pane", "focus", paneId]);
}

function paneMatchesState(
  pane: HerdrPane,
  state: PaneState,
): boolean {
  if (state.terminalId) return pane.terminal_id === state.terminalId;
  if (pane.label !== SERVICE_PANE_LABEL) return false;
  return pane.foreground_cwd === state.workspaceRoot || pane.cwd === state.workspaceRoot;
}

function writeJsonAtomic(path: string, value: unknown): void {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`);
  renameSync(temporaryPath, path);
}

function readPaneState(stateDir: string): PaneState | null {
  const path = join(stateDir, "service-pane.json");
  if (!existsSync(path)) return null;
  try {
    return Parse(PaneStateSchema, JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

export function registerServicePaneState(
  stateDir: string,
  workspaceRoot: string,
  herdr = process.env.HERDR_BIN_PATH ?? "herdr",
): void {
  const inheritedPaneId = process.env.HERDR_PANE_ID;
  if (!inheritedPaneId) return;
  const herdrSocketPath = process.env.HERDR_SOCKET_PATH;
  if (!herdrSocketPath) return;
  const output = invokeHerdr(herdr, ["pane", "get", inheritedPaneId]);
  const pane = Parse(PaneGetResponseSchema, JSON.parse(output)).result.pane;
  writeJsonAtomic(join(stateDir, "service-pane.json"), {
    paneId: pane.pane_id,
    terminalId: pane.terminal_id,
    workspaceRoot,
    herdrSocketPath,
    hostname: hostname(),
  } satisfies PaneState);
}

function listWorkspaces(herdr: string): string[] {
  const output = invokeHerdr(herdr, ["workspace", "list"]);
  return Parse(WorkspaceListResponseSchema, JSON.parse(output)).result.workspaces.map(
    (workspace) => workspace.workspace_id,
  );
}

function listPanes(herdr: string, workspaceId: string): HerdrPane[] {
  const output = invokeHerdr(herdr, ["pane", "list", "--workspace", workspaceId]);
  return Parse(PaneListResponseSchema, JSON.parse(output)).result.panes;
}

function recoverMovedPane(
  state: PaneState,
  herdr: string,
): HerdrPane | null {
  for (const workspaceId of listWorkspaces(herdr)) {
    const match = listPanes(herdr, workspaceId).find((pane) =>
      paneMatchesState(pane, state),
    );
    if (match) return match;
  }
  return null;
}

export function removeLegacyClientPaneStates(stateDir: string): void {
  for (const entrypoint of ["outliner", "detail"]) {
    const path = join(stateDir, `${entrypoint}-pane.json`);
    if (existsSync(path)) unlinkSync(path);
  }
}

export function resolveServicePaneId(
  stateDir: string,
  herdr = process.env.HERDR_BIN_PATH ?? "herdr",
): string | null {
  const state = readPaneState(stateDir);
  if (!state) return null;
  if (
    !state.herdrSocketPath ||
    !state.hostname ||
    state.herdrSocketPath !== process.env.HERDR_SOCKET_PATH ||
    state.hostname !== hostname()
  ) return null;

  try {
    const output = invokeHerdr(herdr, ["pane", "get", state.paneId]);
    const pane = Parse(PaneGetResponseSchema, JSON.parse(output)).result.pane;
    const stateHasIdentity = Boolean(state.terminalId || state.workspaceRoot);
    if (!stateHasIdentity || paneMatchesState(pane, state)) {
      return pane.pane_id;
    }
  } catch {
    // Search by stable pane identity below.
  }

  const movedPane = recoverMovedPane(state, herdr);
  if (!movedPane) return null;
  state.paneId = movedPane.pane_id;
  state.terminalId = movedPane.terminal_id;
  writeJsonAtomic(join(stateDir, "service-pane.json"), state);
  return state.paneId;
}
