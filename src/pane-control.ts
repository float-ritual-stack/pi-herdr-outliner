import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Parse } from "typebox/value";
import type { OutlinerClientRuntime } from "./types";

export type PaneEntrypoint = "service" | "outliner" | "detail" | "capture" | "backlink-peek";
export type OutlinerRightClickOwnership = "herdr" | "outliner";

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
const PluginPaneOpenResponseSchema = Type.Object({
  result: Type.Object({
    plugin_pane: Type.Object({ pane: HerdrPaneSchema }),
  }),
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
const OUTLINER_PLUGIN_ID = "float.pi-outliner";

interface HerdrPluginContext {
  clicked_url?: string;
  focused_pane_cwd?: string;
  focused_pane_id?: string;
  workspace_cwd?: string;
}

function pluginContext(
  env: NodeJS.ProcessEnv,
): HerdrPluginContext {
  const encoded = env.HERDR_PLUGIN_CONTEXT_JSON;
  if (!encoded) return {};
  try {
    const parsed: unknown = JSON.parse(encoded);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("context must be an object");
    }
    return parsed as HerdrPluginContext;
  } catch {
    throw new Error("Herdr supplied invalid plugin context");
  }
}

export function pluginInvocationPaneId(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return pluginContext(env).focused_pane_id?.trim() ||
    env.HERDR_PANE_ID?.trim() ||
    undefined;
}

export function pluginInvocationWorkspaceRoot(
  env: NodeJS.ProcessEnv = process.env,
  fallback = process.cwd(),
): string {
  const context = pluginContext(env);
  return context.focused_pane_cwd?.trim() ||
    context.workspace_cwd?.trim() ||
    fallback;
}

export function pluginClickedUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return pluginContext(env).clicked_url?.trim() ||
    env.HERDR_PLUGIN_CLICKED_URL?.trim() ||
    undefined;
}

function invokeHerdr(herdr: string, args: string[]): string {
  return execFileSync(herdr, args, {
    encoding: "utf8",
    timeout: HERDR_COMMAND_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
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

export function currentPaneIdentity(
  herdr = process.env.HERDR_BIN_PATH ?? "herdr",
): OutlinerClientRuntime | undefined {
  if (process.env.HERDR_ENV !== "1") return undefined;
  try {
    const output = invokeHerdr(herdr, ["pane", "current", "--current"]);
    const pane = Parse(PaneCurrentResponseSchema, JSON.parse(output)).result.pane;
    if (!pane.pane_id.trim()) throw new Error("Herdr returned an empty current pane ID");
    return runtimeFromPane(pane);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Current Herdr pane identity is unavailable: ${reason}`);
  }
}

export function currentPaneRuntime(
  herdr = process.env.HERDR_BIN_PATH ?? "herdr",
): OutlinerClientRuntime | undefined {
  const runtime = currentPaneIdentity(herdr);
  if (!runtime) return undefined;
  const paneId = runtime.paneId;
  if (!paneId) return runtime;
  try {
    const layoutOutput = invokeHerdr(herdr, ["pane", "layout", "--pane", paneId]);
    const layout = Parse(PaneLayoutResponseSchema, JSON.parse(layoutOutput)).result.layout;
    const positioned = layout.panes.find((candidate) => candidate.pane_id === paneId);
    if (positioned) {
      runtime.paneX = positioned.rect.x;
      runtime.paneY = positioned.rect.y;
    }
  } catch {
    // Pane identity remains useful when spatial metadata is unavailable.
  }
  return runtime;
}

export function outlinerRightClickOwnership(
  env: NodeJS.ProcessEnv = process.env,
): OutlinerRightClickOwnership {
  const value = env.OUTLINER_RIGHT_CLICK?.trim().toLowerCase() || "herdr";
  if (value === "herdr" || value === "outliner") return value;
  throw new Error("OUTLINER_RIGHT_CLICK must be herdr or outliner");
}

export function configureCurrentPaneRightClick(
  ownership: OutlinerRightClickOwnership,
  herdr = process.env.HERDR_BIN_PATH ?? "herdr",
): void {
  if (process.env.HERDR_ENV !== "1") return;
  invokeHerdr(herdr, [
    "pane",
    "input",
    "--current",
    "--right-click",
    ownership === "outliner" ? "pane" : "herdr",
  ]);
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
  const paneId = currentPaneIdentity(herdr)?.paneId;
  if (!paneId) throw new Error("Current Herdr pane identity is unavailable");
  try {
    invokeHerdr(herdr, ["plugin", "pane", "focus", paneId]);
  } catch (error) {
    const stderr = typeof error === "object" && error !== null && "stderr" in error
      ? String(error.stderr)
      : "";
    if (!stderr.includes('"code":"plugin_pane_not_found"')) throw error;
    // Manual panes can receive navigation but have no plugin focus handle.
  }
}

export interface OpenDetailPaneOptions {
  workspaceRoot: string;
  browsingContextId: string;
  propertyInspectorBlockId?: string;
  targetFragmentId?: string;
  targetPaneId?: string;
  direction?: "right" | "down";
}

export function openDetailPane(
  options: OpenDetailPaneOptions,
  herdr = process.env.HERDR_BIN_PATH ?? "herdr",
): string {
  if (process.env.HERDR_ENV !== "1") {
    throw new Error("Creating a Detail pane requires Herdr");
  }
  const sourcePaneId = options.targetPaneId?.trim() || currentPaneIdentity(herdr)?.paneId;
  if (!sourcePaneId) throw new Error("Target Herdr pane identity is unavailable");
  const args = [
    "plugin",
    "pane",
    "open",
    "--plugin",
    OUTLINER_PLUGIN_ID,
    "--entrypoint",
    "detail",
    "--env",
    `OUTLINER_WORKSPACE_ROOT=${options.workspaceRoot}`,
    "--env",
    `OUTLINER_BROWSING_CONTEXT_ID=${options.browsingContextId}`,
  ];
  if (options.propertyInspectorBlockId !== undefined) {
    const blockId = options.propertyInspectorBlockId.trim();
    if (!blockId) throw new Error("Property inspector block ID cannot be empty");
    args.push(
      "--env",
      "OUTLINER_DETAIL_PRESENTATION=property-inspector",
      "--env",
      `OUTLINER_DETAIL_TARGET_BLOCK_ID=${blockId}`,
      "--env",
      "OUTLINER_DETAIL_RENDERER=pi-tui",
    );
  }
  if (options.targetFragmentId !== undefined) {
    const fragmentId = options.targetFragmentId.trim();
    if (!fragmentId) throw new Error("Detail target fragment ID cannot be empty");
    args.push("--env", `OUTLINER_DETAIL_TARGET_FRAGMENT_ID=${fragmentId}`);
  }
  args.push(
    "--placement",
    "split",
    "--target-pane",
    sourcePaneId,
    "--direction",
    options.direction ?? "down",
    "--cwd",
    options.workspaceRoot,
    "--no-focus",
  );
  for (const name of [
    "OUTLINER_STATE_DIR",
    "OUTLINER_KEYBINDINGS_PATH",
    "OUTLINER_RIGHT_CLICK",
    "OUTLINER_PROPERTY_SUMMARY_KEYS",
    "OUTLINER_OPEN_DESTINATION_TIMEOUT_MS",
  ] as const) {
    if (process.env[name] !== undefined) {
      args.push("--env", `${name}=${process.env[name]}`);
    }
  }
  const output = invokeHerdr(herdr, args);
  const pane = Parse(PluginPaneOpenResponseSchema, JSON.parse(output)).result.plugin_pane.pane;
  invokeHerdr(herdr, ["plugin", "pane", "focus", pane.pane_id]);
  return pane.pane_id;
}

export interface OpenBacklinkPeekPopupOptions {
  workspaceRoot: string;
  browsingContextId: string;
  sourceClientId: string;
  targetBlockId: string;
  selectedSourceBlockId: string;
  filter: string;
  sortField: "created" | "updated";
  sortDirection: "asc" | "desc";
}

export function openBacklinkPeekPopup(
  options: OpenBacklinkPeekPopupOptions,
  herdr = process.env.HERDR_BIN_PATH ?? "herdr",
): void {
  if (process.env.HERDR_ENV !== "1") {
    throw new Error("Backlink peek popup requires Herdr");
  }
  const args = [
    "plugin",
    "pane",
    "open",
    "--plugin",
    OUTLINER_PLUGIN_ID,
    "--entrypoint",
    "backlink-peek",
    "--env",
    `OUTLINER_WORKSPACE_ROOT=${options.workspaceRoot}`,
    "--env",
    `OUTLINER_BROWSING_CONTEXT_ID=${options.browsingContextId}`,
    "--env",
    `OUTLINER_BACKLINK_SOURCE_CLIENT_ID=${options.sourceClientId}`,
    "--env",
    `OUTLINER_BACKLINK_TARGET_BLOCK_ID=${options.targetBlockId}`,
    "--env",
    `OUTLINER_BACKLINK_SELECTED_SOURCE_ID=${options.selectedSourceBlockId}`,
    "--env",
    `OUTLINER_BACKLINK_FILTER=${options.filter}`,
    "--env",
    `OUTLINER_BACKLINK_SORT_FIELD=${options.sortField}`,
    "--env",
    `OUTLINER_BACKLINK_SORT_DIRECTION=${options.sortDirection}`,
    "--cwd",
    options.workspaceRoot,
    "--focus",
  ];
  for (const name of [
    "OUTLINER_STATE_DIR",
    "OUTLINER_OPEN_DESTINATION_TIMEOUT_MS",
  ] as const) {
    if (process.env[name] !== undefined) {
      args.push("--env", `${name}=${process.env[name]}`);
    }
  }
  invokeHerdr(herdr, args);
}

export interface OpenCapturePopupOptions {
  workspaceRoot: string;
  capturedFromBlockId: string;
}

export function openCapturePopup(
  options: OpenCapturePopupOptions,
  herdr = process.env.HERDR_BIN_PATH ?? "herdr",
): void {
  if (process.env.HERDR_ENV !== "1") {
    throw new Error("Quick capture popup requires Herdr");
  }
  const args = [
    "plugin",
    "pane",
    "open",
    "--plugin",
    OUTLINER_PLUGIN_ID,
    "--entrypoint",
    "capture",
    "--env",
    `OUTLINER_WORKSPACE_ROOT=${options.workspaceRoot}`,
    "--env",
    `OUTLINER_CAPTURE_FROM_BLOCK_ID=${options.capturedFromBlockId}`,
    "--env",
    `OUTLINER_CAPTURE_REQUEST_ID=${crypto.randomUUID()}`,
    "--cwd",
    options.workspaceRoot,
    "--focus",
  ];
  if (process.env.OUTLINER_STATE_DIR) {
    args.push("--env", `OUTLINER_STATE_DIR=${process.env.OUTLINER_STATE_DIR}`);
  }
  invokeHerdr(herdr, args);
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
