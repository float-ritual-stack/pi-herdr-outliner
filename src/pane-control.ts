import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Parse } from "typebox/value";

export type PaneEntrypoint = "outliner" | "detail";

const PaneStateSchema = Type.Object({
  paneId: Type.String(),
  terminalId: Type.Optional(Type.String()),
  workspaceRoot: Type.Optional(Type.String()),
});
type PaneState = Static<typeof PaneStateSchema>;

const HerdrPaneSchema = Type.Object({
  pane_id: Type.String(),
  terminal_id: Type.Optional(Type.String()),
  label: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String()),
  foreground_cwd: Type.Optional(Type.String()),
});
type HerdrPane = Static<typeof HerdrPaneSchema>;

const PaneGetResponseSchema = Type.Object({
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

const DetailEditCommandSchema = Type.Object({
  id: Type.String(),
  action: Type.Literal("edit"),
  blockId: Type.String(),
  createdAt: Type.Number(),
});
export type DetailEditCommand = Static<typeof DetailEditCommandSchema>;

const LABEL_BY_ENTRYPOINT: Record<PaneEntrypoint, string> = {
  outliner: "Outliner",
  detail: "Outliner Detail",
};

function paneMatchesState(
  pane: HerdrPane,
  state: PaneState,
  entrypoint: PaneEntrypoint,
): boolean {
  if (state.terminalId) return pane.terminal_id === state.terminalId;
  if (pane.label !== LABEL_BY_ENTRYPOINT[entrypoint]) return false;
  return pane.foreground_cwd === state.workspaceRoot || pane.cwd === state.workspaceRoot;
}

function writeJsonAtomic(path: string, value: unknown): void {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`);
  renameSync(temporaryPath, path);
}

function readPaneState(stateDir: string, entrypoint: PaneEntrypoint): PaneState | null {
  const path = join(stateDir, `${entrypoint}-pane.json`);
  if (!existsSync(path)) return null;
  try {
    return Parse(PaneStateSchema, JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

export function readPaneId(stateDir: string, entrypoint: PaneEntrypoint): string | null {
  return readPaneState(stateDir, entrypoint)?.paneId ?? null;
}

export function registerPaneState(
  stateDir: string,
  entrypoint: PaneEntrypoint,
  workspaceRoot: string,
  herdr = process.env.HERDR_BIN_PATH ?? "herdr",
): void {
  const inheritedPaneId = process.env.HERDR_PANE_ID;
  if (!inheritedPaneId) return;
  const output = execFileSync(herdr, ["pane", "get", inheritedPaneId], { encoding: "utf8" });
  const pane = Parse(PaneGetResponseSchema, JSON.parse(output)).result.pane;
  writeJsonAtomic(join(stateDir, `${entrypoint}-pane.json`), {
    paneId: pane.pane_id,
    terminalId: pane.terminal_id,
    workspaceRoot,
  } satisfies PaneState);
}

function listWorkspaces(herdr: string): string[] {
  const output = execFileSync(herdr, ["workspace", "list"], { encoding: "utf8" });
  return Parse(WorkspaceListResponseSchema, JSON.parse(output)).result.workspaces.map(
    (workspace) => workspace.workspace_id,
  );
}

function listPanes(herdr: string, workspaceId: string): HerdrPane[] {
  const output = execFileSync(herdr, ["pane", "list", "--workspace", workspaceId], { encoding: "utf8" });
  return Parse(PaneListResponseSchema, JSON.parse(output)).result.panes;
}

function recoverMovedPane(
  state: PaneState,
  entrypoint: PaneEntrypoint,
  herdr: string,
): HerdrPane | null {
  for (const workspaceId of listWorkspaces(herdr)) {
    const match = listPanes(herdr, workspaceId).find((pane) =>
      paneMatchesState(pane, state, entrypoint),
    );
    if (match) return match;
  }
  return null;
}

export function focusPluginPane(
  stateDir: string,
  entrypoint: PaneEntrypoint,
  herdr = process.env.HERDR_BIN_PATH ?? "herdr",
): void {
  const state = readPaneState(stateDir, entrypoint);
  if (!state) throw new Error(`${entrypoint} pane is not open`);
  try {
    execFileSync(herdr, ["plugin", "pane", "focus", state.paneId], { stdio: "ignore" });
    return;
  } catch {
    const movedPane = recoverMovedPane(state, entrypoint, herdr);
    if (!movedPane) throw new Error(`${entrypoint} pane moved or closed and could not be located`);
    state.paneId = movedPane.pane_id;
    state.terminalId = movedPane.terminal_id;
    writeJsonAtomic(join(stateDir, `${entrypoint}-pane.json`), state);
    execFileSync(herdr, ["plugin", "pane", "focus", state.paneId], { stdio: "ignore" });
  }
}

export function requestDetailEdit(stateDir: string, blockId: string): DetailEditCommand {
  const command: DetailEditCommand = {
    id: crypto.randomUUID(),
    action: "edit",
    blockId,
    createdAt: Date.now(),
  };
  writeJsonAtomic(join(stateDir, "detail-command.json"), command);
  return command;
}

export function readDetailEditCommand(stateDir: string): DetailEditCommand | null {
  const path = join(stateDir, "detail-command.json");
  if (!existsSync(path)) return null;
  try {
    return Parse(DetailEditCommandSchema, JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}
