import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { OutlinerClient } from "./client";
import { type PaneEntrypoint, resolvePluginPaneId } from "./pane-control";
import { resolvePaths } from "./paths";
import { OUTLINER_PROTOCOL_VERSION, type OutlinerServiceStatus } from "./types";

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

function rememberPane(entrypoint: PaneEntrypoint, paneId: string): void {
  const statePath = join(paths.stateDir, `${entrypoint}-pane.json`);
  let terminalId: string | undefined;
  try {
    const existing = JSON.parse(readFileSync(statePath, "utf8")) as {
      paneId?: string;
      terminalId?: string;
    };
    if (existing.paneId === paneId) terminalId = existing.terminalId;
  } catch {
    // No usable state exists yet.
  }
  const state = { paneId, terminalId, workspaceRoot };
  writeFileSync(statePath, `${JSON.stringify(state)}\n`);
}

function openPane(
  entrypoint: PaneEntrypoint,
  options: { placement: "split" | "tab"; targetPane?: string; direction?: "right" | "down" },
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
    options.placement,
    "--cwd",
    workspaceRoot,
    "--no-focus",
  ];
  if (options.direction) args.push("--direction", options.direction);
  if (options.targetPane) args.push("--target-pane", options.targetPane);
  const output = execFileSync(herdr, args, { encoding: "utf8" });
  const paneId = (JSON.parse(output) as OpenPaneResponse).result?.plugin_pane?.pane?.pane_id;
  if (!paneId) throw new Error(`Herdr did not return a pane id for ${entrypoint}`);
  rememberPane(entrypoint, paneId);
  return paneId;
}

async function waitForService(): Promise<void> {
  const client = new OutlinerClient(paths.socket);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const service = await client.request<OutlinerServiceStatus>({ action: "ping" }, 300);
      if (service.protocolVersion === OUTLINER_PROTOCOL_VERSION) return;
    } catch {
      // Retry until the startup deadline.
    }
    await sleep(100);
  }
  throw new Error(`Compatible outliner service did not become ready at ${paths.socket}`);
}
const servicePane =
  resolvePluginPaneId(paths.stateDir, "service", herdr) ??
  openPane("service", { placement: "tab" });
await waitForService();
const outlinerPane =
  resolvePluginPaneId(paths.stateDir, "outliner", herdr) ??
  openPane("outliner", { placement: "split", targetPane: currentPaneId, direction: "right" });
const detailPane =
  resolvePluginPaneId(paths.stateDir, "detail", herdr) ??
  openPane("detail", { placement: "split", targetPane: outlinerPane, direction: "down" });
if (process.env.OUTLINER_FOCUS !== "0") {
  execFileSync(herdr, ["plugin", "pane", "focus", outlinerPane], { stdio: "ignore" });
}
process.stdout.write(`${JSON.stringify({ servicePane, outlinerPane, detailPane, workspaceRoot })}\n`);
