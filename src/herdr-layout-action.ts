import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { OutlinerClient } from "./client";
import { listLiveClients } from "./client-target";
import {
  buildOutlinerLayout,
  reshapeOutlinerLayout,
  resolveOutlinerLayoutPanes,
  translateOutlinerLayoutPanes,
  type HerdrLayoutApi,
  type HerdrMoveDestination,
  type HerdrMoveResult,
  type OutlinerLayoutName,
  type OutlinerLayoutPanes,
  type ResolvedOutlinerClient,
} from "./herdr-layout";
import { resolvePaths } from "./paths";
import type { OutlinerClientRegistration } from "./types";

interface HerdrPane {
  pane_id: string;
  terminal_id?: string;
  workspace_id: string;
  tab_id: string;
  cwd?: string;
  foreground_cwd?: string;
}

interface HerdrPaneLayout {
  workspace_id: string;
  tab_id: string;
  zoomed: boolean;
  panes: Array<{ pane_id: string }>;
}

interface ExplicitLayoutArgs extends OutlinerLayoutPanes {
  focusPaneId?: string;
}

const herdr = process.env.HERDR_BIN_PATH ?? "herdr";
const HERDR_TIMEOUT_MS = 5_000;

function invokeHerdr(args: string[]): unknown {
  const output = execFileSync(herdr, args, {
    encoding: "utf8",
    timeout: HERDR_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(output);
}

function resultRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw new Error("Herdr returned an invalid response");
  const result = (value as Record<string, unknown>).result;
  if (typeof result !== "object" || result === null) throw new Error("Herdr response has no result");
  return result as Record<string, unknown>;
}

function readPane(value: unknown): HerdrPane {
  const pane = resultRecord(value).pane;
  if (typeof pane !== "object" || pane === null) throw new Error("Herdr response has no pane");
  return pane as HerdrPane;
}

class HerdrCli implements HerdrLayoutApi {
  getPane(paneId: string): HerdrPane {
    return readPane(invokeHerdr(["pane", "get", paneId]));
  }

  listPanes(workspaceId: string): HerdrPane[] {
    const panes = resultRecord(invokeHerdr(["pane", "list", "--workspace", workspaceId])).panes;
    if (!Array.isArray(panes)) throw new Error("Herdr response has no pane list");
    return panes as HerdrPane[];
  }

  layoutForPane(paneId: string): HerdrPaneLayout {
    const layout = resultRecord(invokeHerdr(["pane", "layout", "--pane", paneId])).layout;
    if (typeof layout !== "object" || layout === null) throw new Error("Herdr response has no pane layout");
    return layout as HerdrPaneLayout;
  }

  unzoom(paneId: string): void {
    invokeHerdr(["pane", "zoom", "--pane", paneId, "--off"]);
  }

  movePane(paneId: string, destination: HerdrMoveDestination, focus: boolean): HerdrMoveResult {
    const args = ["pane", "move", paneId];
    if (destination.type === "new_tab") {
      args.push("--new-tab");
      if (destination.workspaceId) args.push("--workspace", destination.workspaceId);
      if (destination.label) args.push("--label", destination.label);
    } else {
      args.push("--tab", destination.tabId!);
      if (destination.targetPaneId) args.push("--target-pane", destination.targetPaneId);
      args.push("--split", destination.split!, "--ratio", String(destination.ratio!));
    }
    args.push(focus ? "--focus" : "--no-focus");
    const result = resultRecord(invokeHerdr(args));
    const move = (typeof result.move_result === "object" && result.move_result !== null
      ? result.move_result
      : result) as Record<string, unknown>;
    if (move.changed === false) {
      throw new Error(`Herdr refused to move pane ${paneId}: ${String(move.reason ?? "unknown reason")}`);
    }
    const pane = move.pane;
    if (typeof pane !== "object" || pane === null) throw new Error("Herdr move response has no pane");
    const movedPaneId = (pane as Record<string, unknown>).pane_id;
    if (typeof movedPaneId !== "string") throw new Error("Herdr move response has no pane id");
    const createdTab = move.created_tab;
    const createdTabId = typeof createdTab === "object" && createdTab !== null
      ? (createdTab as Record<string, unknown>).tab_id
      : undefined;
    return {
      paneId: movedPaneId,
      ...(typeof createdTabId === "string" ? { createdTabId } : {}),
    };
  }

  listPaneIds(workspaceId: string, tabId: string): string[] {
    return this.listPanes(workspaceId)
      .filter((pane) => pane.tab_id === tabId)
      .map((pane) => pane.pane_id);
  }
}

function parseLayoutName(value: string | undefined): OutlinerLayoutName {
  if (value === "detail-a" || value === "detail-b" || value === "tree-wide") return value;
  throw new Error("Layout must be detail-a, detail-b, or tree-wide");
}

function parseExplicitArgs(args: readonly string[]): ExplicitLayoutArgs | undefined {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const key = args[index]!;
    if (!key.startsWith("--") || key === "--lock-held") continue;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${key} requires a pane id`);
    values.set(key, value);
    index++;
  }
  const keys = ["--tree", "--detail-a", "--detail-b", "--shell"] as const;
  if (!keys.some((key) => values.has(key))) return undefined;
  for (const key of keys) {
    if (!values.has(key)) throw new Error(`Explicit layout requires ${key}`);
  }
  return {
    tree: values.get("--tree")!,
    detailA: values.get("--detail-a")!,
    detailB: values.get("--detail-b")!,
    shell: values.get("--shell")!,
    ...(values.has("--focus") ? { focusPaneId: values.get("--focus") } : {}),
  };
}

function workspaceRootForPane(api: HerdrCli, paneId: string): string {
  const pane = api.getPane(paneId);
  return pane.foreground_cwd ?? pane.cwd ?? process.cwd();
}

function resolveClientPane(
  registration: OutlinerClientRegistration,
  panes: readonly HerdrPane[],
): HerdrPane | undefined {
  if (registration.runtime?.terminalId) {
    const terminalMatch = panes.find((pane) => pane.terminal_id === registration.runtime!.terminalId);
    if (terminalMatch) return terminalMatch;
  }
  if (registration.runtime?.paneId) {
    return panes.find((pane) => pane.pane_id === registration.runtime!.paneId);
  }
  return undefined;
}

async function resolveLiveComposition(
  api: HerdrCli,
  invocationPaneId: string,
): Promise<{
  workspaceId: string;
  tabId: string;
  panes: OutlinerLayoutPanes;
  focusPaneId?: string;
}> {
  const invocationPane = api.getPane(invocationPaneId);
  const workspaceRoot = workspaceRootForPane(api, invocationPaneId);
  const paths = resolvePaths({ ...process.env, OUTLINER_WORKSPACE_ROOT: workspaceRoot });
  const registrations = await listLiveClients(new OutlinerClient(paths.socket));
  const workspacePanes = api.listPanes(invocationPane.workspace_id);
  const resolved = registrations.flatMap((registration): ResolvedOutlinerClient[] => {
    const livePane = resolveClientPane(registration, workspacePanes);
    return livePane
      ? [{ role: registration.role, contextId: registration.contextId, paneId: livePane.pane_id }]
      : [];
  });

  const clientsByTab = new Map<string, ResolvedOutlinerClient[]>();
  for (const client of resolved) {
    const tabId = workspacePanes.find((pane) => pane.pane_id === client.paneId)!.tab_id;
    const group = clientsByTab.get(tabId) ?? [];
    group.push(client);
    clientsByTab.set(tabId, group);
  }
  let tabId = invocationPane.tab_id;
  if ((clientsByTab.get(tabId)?.length ?? 0) !== 3) {
    const candidates = [...clientsByTab.entries()]
      .filter(([, clients]) =>
        clients.filter((client) => client.role === "tree").length === 1 &&
        clients.filter((client) => client.role === "detail").length === 2
      );
    if (candidates.length !== 1) {
      throw new Error(
        `Could not select one Outliner working tab in this workspace; found ${candidates.length}`,
      );
    }
    tabId = candidates[0]![0];
  }

  const clients = clientsByTab.get(tabId) ?? [];
  const tree = clients.find((client) => client.role === "tree");
  if (!tree) throw new Error("The selected tab has no live Outliner Tree");
  const layout = api.layoutForPane(tree.paneId);
  const panes = resolveOutlinerLayoutPanes(
    clients,
    layout.panes.map((pane) => pane.pane_id),
    invocationPaneId,
  );
  const paneIds = new Set(Object.values(panes));
  return {
    workspaceId: layout.workspace_id,
    tabId: layout.tab_id,
    panes,
    ...(paneIds.has(invocationPaneId) ? { focusPaneId: invocationPaneId } : {}),
  };
}

async function applyLayout(name: OutlinerLayoutName, args: readonly string[]): Promise<object> {
  const api = new HerdrCli();
  const explicit = parseExplicitArgs(args);
  let workspaceId: string;
  let tabId: string;
  let panes: OutlinerLayoutPanes;
  let focusPaneId: string | undefined;

  if (explicit) {
    const treePane = api.getPane(explicit.tree);
    const paneRecords = Object.values(explicit).filter((value): value is string => typeof value === "string")
      .filter((paneId) => paneId !== explicit.focusPaneId)
      .map((paneId) => api.getPane(paneId));
    if (paneRecords.some((pane) => pane.workspace_id !== treePane.workspace_id || pane.tab_id !== treePane.tab_id)) {
      throw new Error("All explicit Outliner layout panes must be in the same tab");
    }
    workspaceId = treePane.workspace_id;
    tabId = treePane.tab_id;
    panes = explicit;
    focusPaneId = explicit.focusPaneId;
  } else {
    const invocationPaneId = process.env.HERDR_PANE_ID;
    if (!invocationPaneId) throw new Error("Outliner layout action requires Herdr pane context");
    ({ workspaceId, tabId, panes, focusPaneId } = await resolveLiveComposition(api, invocationPaneId));
  }

  const currentLayout = api.layoutForPane(panes.tree);
  if (currentLayout.zoomed) api.unzoom(panes.tree);
  const renames = reshapeOutlinerLayout(
    api,
    workspaceId,
    tabId,
    buildOutlinerLayout(name, panes),
    focusPaneId,
  );
  const livePanes = translateOutlinerLayoutPanes(panes, renames);
  return { layout: name, workspaceId, tabId, panes: livePanes };
}

async function main(): Promise<void> {
  if (process.env.HERDR_ENV !== "1") throw new Error("Outliner layout action must run inside Herdr");
  const args = process.argv.slice(2);
  const name = parseLayoutName(args[0]);
  if (!args.includes("--lock-held")) {
    const socketPath = process.env.HERDR_SOCKET_PATH ?? `${homedir()}/.config/herdr/herdr.sock`;
    const output = execFileSync(
      "flock",
      [
        "-x",
        `${socketPath}.layout.lock`,
        process.execPath,
        "run",
        fileURLToPath(import.meta.url),
        ...args,
        "--lock-held",
      ],
      { encoding: "utf8", env: process.env, timeout: 30_000 },
    );
    process.stdout.write(output);
    return;
  }
  process.stdout.write(`${JSON.stringify(await applyLayout(name, args))}\n`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`outliner layout: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
