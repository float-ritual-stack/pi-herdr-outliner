import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { OutlinerClient } from "./client";
import { listLiveClients, sendClientCommand } from "./client-target";
import { selectTreeClient } from "./herdr-open-policy";
import { type PaneEntrypoint, resolveServicePaneId } from "./pane-control";
import { resolvePaths } from "./paths";
import {
  OUTLINER_PROTOCOL_VERSION,
  type OutlinerClientRegistration,
  type OutlinerServiceStatus,
} from "./types";

interface OpenPaneResponse {
  result?: { plugin_pane?: { pane?: { pane_id?: string } } };
}

interface PaneDetailsResponse {
  result?: { pane?: { foreground_cwd?: string; cwd?: string } };
}

const herdr = process.env.HERDR_BIN_PATH ?? "herdr";
const pluginId = process.env.HERDR_PLUGIN_ID ?? "float.pi-outliner";
const currentPaneId = process.env.HERDR_PANE_ID;
const HERDR_SYNC_TIMEOUT_MS = 2_000;
const modeArgument = process.argv.indexOf("--mode");
const mode =
  modeArgument < 0
    ? "focus-or-open"
    : process.argv[modeArgument + 1];
if (
  mode !== "focus-or-open" &&
  mode !== "open-here" &&
  mode !== "focus-existing" &&
  mode !== "service-only"
) {
  throw new Error(`Invalid outliner open mode: ${String(mode)}`);
}
const clientArgument = process.argv.indexOf("--client");
const requestedClientId =
  clientArgument < 0 ? undefined : process.argv[clientArgument + 1];
if (clientArgument >= 0 && !requestedClientId) {
  throw new Error("--client requires a client ID");
}
if (requestedClientId && (mode === "open-here" || mode === "service-only")) {
  throw new Error(`--client cannot be used with --mode ${mode}`);
}
if (process.env.HERDR_ENV !== "1") throw new Error("The outliner workspace action must run inside Herdr");

let workspaceRoot = process.cwd();
if (currentPaneId) {
  const paneOutput = execFileSync(herdr, ["pane", "get", currentPaneId], {
    encoding: "utf8",
    timeout: HERDR_SYNC_TIMEOUT_MS,
  });
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
    "--env",
    `OUTLINER_WORKSPACE_ROOT=${workspaceRoot}`,
    "--placement",
    options.placement,
    "--cwd",
    workspaceRoot,
    "--no-focus",
  ];
  if (process.env.OUTLINER_STATE_DIR) {
    args.push("--env", `OUTLINER_STATE_DIR=${process.env.OUTLINER_STATE_DIR}`);
  }
  if (options.direction) args.push("--direction", options.direction);
  if (options.targetPane) args.push("--target-pane", options.targetPane);
  const output = execFileSync(herdr, args, {
    encoding: "utf8",
    timeout: HERDR_SYNC_TIMEOUT_MS,
  });
  const paneId = (JSON.parse(output) as OpenPaneResponse).result?.plugin_pane?.pane?.pane_id;
  if (!paneId) throw new Error(`Herdr did not return a pane id for ${entrypoint}`);
  if (entrypoint === "service") rememberPane(entrypoint, paneId);
  return paneId;
}

async function waitForService(): Promise<void> {
  const client = new OutlinerClient(paths.socket);
  const deadline = Date.now() + 15_000;
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
  resolveServicePaneId(paths.stateDir, herdr) ??
  openPane("service", { placement: "tab" });
await waitForService();

async function focusExisting(
  trees?: OutlinerClientRegistration[],
): Promise<{
  servicePane: string;
  focusedClientId: string;
  workspaceRoot: string;
}> {
  const liveTrees =
    trees ?? await listLiveClients(new OutlinerClient(paths.socket), "tree");
  const selected = selectTreeClient(liveTrees, requestedClientId);
  await sendClientCommand(new OutlinerClient(paths.socket), selected.clientId, {
    command: "focus",
  });
  return { servicePane, focusedClientId: selected.clientId, workspaceRoot };
}

function openHere(): {
  servicePane: string;
  outlinerPane: string;
  detailPane: string;
  workspaceRoot: string;
} {
  if (!currentPaneId) {
    throw new Error("open-here requires Herdr invocation pane context");
  }
  const outlinerPane = openPane("outliner", {
    placement: "split",
    targetPane: currentPaneId,
    direction: "right",
  });
  const detailPane = openPane("detail", {
    placement: "split",
    targetPane: outlinerPane,
    direction: "down",
  });
  execFileSync(herdr, ["plugin", "pane", "focus", outlinerPane], {
    stdio: "ignore",
    timeout: HERDR_SYNC_TIMEOUT_MS,
  });
  return { servicePane, outlinerPane, detailPane, workspaceRoot };
}

let result: object;
if (mode === "service-only") {
  result = { servicePane, workspaceRoot };
} else if (mode === "open-here") {
  result = openHere();
} else if (mode === "focus-existing") {
  result = await focusExisting();
} else {
  const trees = await listLiveClients(new OutlinerClient(paths.socket), "tree");
  result = trees.length === 0 && !requestedClientId
    ? openHere()
    : await focusExisting(trees);
}
process.stdout.write(`${JSON.stringify(result)}\n`);
