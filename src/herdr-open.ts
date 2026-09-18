import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createOutlinerClient } from "./client";
import { listLiveClients, sendClientCommand } from "./client-target";
import {
  selectExistingDetailClient,
  selectTreeClientForInvocation,
} from "./herdr-open-policy";
import {
  pluginInvocationPaneId,
  pluginInvocationWorkspaceRoot,
  type PaneEntrypoint,
  resolveServicePaneId,
} from "./pane-control";
import { resolveClientPaths } from "./paths";
import {
  OUTLINER_PROTOCOL_VERSION,
  type OutlinerClientRegistration,
  type OutlinerServiceStatus,
} from "./types";

interface OpenPaneResponse {
  result?: { plugin_pane?: { pane?: { pane_id?: string } } };
}

interface PaneDetailsResponse {
  result?: {
    pane?: {
      pane_id?: string;
      label?: string;
      foreground_cwd?: string;
      cwd?: string;
      workspace_id?: string;
      tab_id?: string;
    };
  };
}

const herdr = process.env.HERDR_BIN_PATH ?? "herdr";
const pluginId = process.env.HERDR_PLUGIN_ID ?? "float.pi-outliner";
const currentPaneId = pluginInvocationPaneId();
const HERDR_SYNC_TIMEOUT_MS = 2_000;
const modeArgument = process.argv.indexOf("--mode");
const mode =
  modeArgument < 0
    ? "focus-or-open"
    : process.argv[modeArgument + 1];
if (
  mode !== "focus-or-open" &&
  mode !== "ensure-detail" &&
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
if (
  requestedClientId &&
  (mode === "open-here" || mode === "service-only")
) {
  throw new Error(`--client cannot be used with --mode ${mode}`);
}
if (process.env.HERDR_ENV !== "1") throw new Error("The outliner workspace action must run inside Herdr");

let workspaceRoot = pluginInvocationWorkspaceRoot();
let invocationPane: NonNullable<PaneDetailsResponse["result"]>["pane"];
if (currentPaneId) {
  const paneOutput = execFileSync(herdr, ["pane", "get", currentPaneId], {
    encoding: "utf8",
    timeout: HERDR_SYNC_TIMEOUT_MS,
  });
  invocationPane = (JSON.parse(paneOutput) as PaneDetailsResponse).result?.pane;
  workspaceRoot = invocationPane?.foreground_cwd ?? invocationPane?.cwd ?? workspaceRoot;
}

const paths = resolveClientPaths({ ...process.env, OUTLINER_WORKSPACE_ROOT: workspaceRoot });
mkdirSync(paths.stateDir, { recursive: true });

const localHostname = hostname();
function localHerdrClients(
  clients: OutlinerClientRegistration[],
): OutlinerClientRegistration[] {
  return clients.filter((client) => client.runtime?.hostname === localHostname);
}

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
  options: {
    placement: "split" | "tab";
    targetPane?: string;
    direction?: "right" | "down";
    env?: Record<string, string>;
  },
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
    "--no-focus",
  ];
  for (const name of [
    "OUTLINER_STATE_DIR",
    "OUTLINER_CONFIG_PATH",
    "OUTLINER_REMOTE",
    "OUTLINER_SOCKET_PATH",
  ] as const) {
    if (process.env[name] !== undefined) {
      args.push("--env", `${name}=${process.env[name]}`);
    }
  }
  for (const [key, value] of Object.entries(options.env ?? {})) {
    args.push("--env", `${key}=${value}`);
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
  const client = createOutlinerClient(paths);
  const remote = paths.mode === "remote";
  const deadline = Date.now() + (remote ? 60_000 : 15_000);
  while (Date.now() < deadline) {
    try {
      const service = await client.request<OutlinerServiceStatus>(
        { action: "ping" },
        paths.mode === "remote" ? undefined : 300,
      );
      if (service.protocolVersion === OUTLINER_PROTOCOL_VERSION) return;
    } catch {
      // Retry until the startup deadline.
    }
    await sleep(100);
  }
  throw new Error(`Compatible outliner service did not become ready at ${paths.socket}`);
}

const servicePane = paths.mode === "remote"
  ? null
  : resolveServicePaneId(paths.stateDir, herdr) ??
    openPane("service", { placement: "tab" });
await waitForService();

function invocationTarget(): {
  paneId?: string;
  tabId?: string;
  workspaceId?: string;
} {
  return {
    ...(currentPaneId ? { paneId: currentPaneId } : {}),
    ...(invocationPane?.tab_id ? { tabId: invocationPane.tab_id } : {}),
    ...(invocationPane?.workspace_id ? { workspaceId: invocationPane.workspace_id } : {}),
  };
}

async function focusExisting(
  trees?: OutlinerClientRegistration[],
): Promise<{
  servicePane: string | null;
  focusedClientId: string;
  workspaceRoot: string;
}> {
  const liveTrees =
    trees ?? localHerdrClients(await listLiveClients(createOutlinerClient(paths), "tree"));
  const selected = selectTreeClientForInvocation(
    liveTrees,
    invocationTarget(),
    requestedClientId,
  );
  await sendClientCommand(createOutlinerClient(paths), selected.clientId, {
    command: "focus",
  });
  return { servicePane, focusedClientId: selected.clientId, workspaceRoot };
}

async function waitForClientPane(
  paneId: string,
  role: "tree" | "detail",
): Promise<void> {
  const client = createOutlinerClient(paths);
  const deadline = Date.now() + (paths.mode === "remote" ? 60_000 : 5_000);
  while (Date.now() < deadline) {
    try {
      const registration = localHerdrClients(await listLiveClients(client, role))
        .find((candidate) => candidate.runtime?.paneId === paneId);
      if (registration) return;
    } catch {
      // Retry until the pane has initialized and registered.
    }
    await sleep(100);
  }
  throw new Error(`Outliner ${role} did not become ready in pane ${paneId}`);
}

async function openHere(): Promise<{
  servicePane: string | null;
  outlinerPane: string;
  detailPane: string;
  browsingContextId: string;
  workspaceRoot: string;
}> {
  if (!currentPaneId) {
    throw new Error("open-here requires Herdr invocation pane context");
  }
  const browsingContextId = crypto.randomUUID();
  const outlinerPane = openPane("outliner", {
    placement: "split",
    targetPane: currentPaneId,
    direction: "right",
    env: { OUTLINER_BROWSING_CONTEXT_ID: browsingContextId },
  });
  const detailPane = openPane("detail", {
    placement: "split",
    targetPane: outlinerPane,
    direction: "down",
    env: { OUTLINER_BROWSING_CONTEXT_ID: browsingContextId },
  });
  execFileSync(herdr, ["plugin", "pane", "focus", detailPane], {
    stdio: "ignore",
    timeout: HERDR_SYNC_TIMEOUT_MS,
  });
  await Promise.all([
    waitForClientPane(outlinerPane, "tree"),
    waitForClientPane(detailPane, "detail"),
  ]);
  execFileSync(herdr, ["plugin", "pane", "focus", outlinerPane], {
    stdio: "ignore",
    timeout: HERDR_SYNC_TIMEOUT_MS,
  });
  return { servicePane, outlinerPane, detailPane, browsingContextId, workspaceRoot };
}

async function ensureDetail(): Promise<{
  servicePane: string | null;
  treePane: string;
  detailPane: string;
  browsingContextId: string;
  opened: boolean;
  workspaceRoot: string;
}> {
  const client = createOutlinerClient(paths);
  const clients = localHerdrClients(await listLiveClients(client));
  const trees = clients.filter((candidate) => candidate.role === "tree");
  if (trees.length === 0 && !requestedClientId) {
    const opened = await openHere();
    return {
      servicePane: opened.servicePane,
      treePane: opened.outlinerPane,
      detailPane: opened.detailPane,
      browsingContextId: opened.browsingContextId,
      opened: true,
      workspaceRoot,
    };
  }
  const tree = selectTreeClientForInvocation(
    trees,
    invocationTarget(),
    requestedClientId,
  );
  const treePane = tree.runtime?.paneId;
  if (!treePane) throw new Error("The selected Outliner Tree has no live Herdr pane");
  const existing = selectExistingDetailClient(clients, tree);
  if (existing) {
    await sendClientCommand(client, existing.clientId, { command: "focus" });
    const detailPane = existing.runtime?.paneId;
    if (!detailPane) throw new Error("The selected Outliner Detail has no live Herdr pane");
    return {
      servicePane,
      treePane,
      detailPane,
      browsingContextId: existing.contextId,
      opened: false,
      workspaceRoot,
    };
  }
  const detailPane = openPane("detail", {
    placement: "split",
    targetPane: treePane,
    direction: "down",
    env: { OUTLINER_BROWSING_CONTEXT_ID: tree.contextId },
  });
  execFileSync(herdr, ["plugin", "pane", "focus", detailPane], {
    stdio: "ignore",
    timeout: HERDR_SYNC_TIMEOUT_MS,
  });
  return {
    servicePane,
    treePane,
    detailPane,
    browsingContextId: tree.contextId,
    opened: true,
    workspaceRoot,
  };
}
let result: object;
if (mode === "service-only") {
  result = { servicePane, workspaceRoot };
} else if (mode === "open-here") {
  result = await openHere();
} else if (mode === "ensure-detail") {
  result = await ensureDetail();
} else if (mode === "focus-existing") {
  result = await focusExisting();
} else {
  const trees = localHerdrClients(
    await listLiveClients(createOutlinerClient(paths), "tree"),
  );
  result = trees.length === 0 && !requestedClientId
    ? await openHere()
    : await focusExisting(trees);
}
process.stdout.write(`${JSON.stringify(result)}\n`);
