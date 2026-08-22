import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PaneEntrypoint } from "./pane-control";
import { resolvePaths } from "./paths";

interface OpenPaneResponse {
  result?: { plugin_pane?: { pane?: { pane_id?: string } } };
}

interface PaneDetailsResponse {
  result?: { pane?: { foreground_cwd?: string; cwd?: string } };
}

const herdr = process.env.HERDR_BIN_PATH ?? "herdr";
const pluginId = process.env.HERDR_PLUGIN_ID ?? "float.pi-outliner";
const currentPaneId = process.env.HERDR_PANE_ID;
if (process.env.HERDR_ENV !== "1") throw new Error("The outliner workspace action must run inside Herdr");

let workspaceRoot = process.cwd();
if (currentPaneId) {
  const paneOutput = execFileSync(herdr, ["pane", "get", currentPaneId], { encoding: "utf8" });
  const paneResponse = JSON.parse(paneOutput) as PaneDetailsResponse;
  workspaceRoot = paneResponse.result?.pane?.foreground_cwd ?? paneResponse.result?.pane?.cwd ?? workspaceRoot;
}

const paths = resolvePaths({ ...process.env, OUTLINER_WORKSPACE_ROOT: workspaceRoot });
mkdirSync(paths.stateDir, { recursive: true });

function readLivePane(entrypoint: PaneEntrypoint): string | null {
  const statePath = join(paths.stateDir, `${entrypoint}-pane.json`);
  if (!existsSync(statePath)) return null;
  try {
    const saved = JSON.parse(readFileSync(statePath, "utf8")) as { paneId?: string };
    if (!saved.paneId) return null;
    execFileSync(herdr, ["pane", "get", saved.paneId], { stdio: "ignore" });
    return saved.paneId;
  } catch {
    rmSync(statePath, { force: true });
    return null;
  }
}

function openPane(
  entrypoint: PaneEntrypoint,
  targetPane: string | undefined,
  direction: "right" | "down",
): string {
  const args = [
    "plugin",
    "pane",
    "open",
    "--plugin",
    pluginId,
    "--entrypoint",
    entrypoint,
    "--placement",
    "split",
    "--direction",
    direction,
    "--cwd",
    workspaceRoot,
    "--no-focus",
  ];
  if (targetPane) args.push("--target-pane", targetPane);
  const output = execFileSync(herdr, args, { encoding: "utf8" });
  const paneId = (JSON.parse(output) as OpenPaneResponse).result?.plugin_pane?.pane?.pane_id;
  if (!paneId) throw new Error(`Herdr did not return a pane id for ${entrypoint}`);
  writeFileSync(join(paths.stateDir, `${entrypoint}-pane.json`), `${JSON.stringify({ paneId })}\n`);
  return paneId;
}

const outlinerPane = readLivePane("outliner") ?? openPane("outliner", currentPaneId, "right");
const detailPane = readLivePane("detail") ?? openPane("detail", outlinerPane, "down");
if (process.env.OUTLINER_FOCUS !== "0") {
  execFileSync(herdr, ["plugin", "pane", "focus", outlinerPane], { stdio: "ignore" });
}
process.stdout.write(`${JSON.stringify({ outlinerPane, detailPane, workspaceRoot })}\n`);
