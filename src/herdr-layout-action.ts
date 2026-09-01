import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
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
import { pluginInvocationPaneId } from "./pane-control";
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
const LAYOUT_LOCK_WAIT_MS = 30_000;
const LAYOUT_LOCK_POLL_MS = 50;
const LAYOUT_LOCK_STALE_MS = 5_000;
const CURRENT_HOSTNAME = hostname();
const EXPLICIT_LAYOUT_OPTIONS: Record<string, true> = {
  "--tree": true,
  "--detail-a": true,
  "--detail-b": true,
  "--shell": true,
  "--focus": true,
};

interface LayoutLockOwner {
  token: string;
  pid: number;
  hostname: string;
  startedAt: number;
}

interface LayoutLockState {
  device: number;
  inode: number;
  ownerText: string | undefined;
  owner: LayoutLockOwner | undefined;
}

export interface LayoutLockOptions {
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
  staleAfterMs?: number;
}

const recoveryClaimPath = (lockPath: string): string => `${lockPath}.recovery`;

function systemErrorCode(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return error.code;
}

function parseLayoutLockOwner(text: string): LayoutLockOwner | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return undefined;
    const owner = value as Record<string, unknown>;
    if (
      typeof owner.token !== "string" ||
      typeof owner.pid !== "number" ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      typeof owner.hostname !== "string" ||
      typeof owner.startedAt !== "number" ||
      !Number.isFinite(owner.startedAt)
    ) {
      return undefined;
    }
    return {
      token: owner.token,
      pid: owner.pid,
      hostname: owner.hostname,
      startedAt: owner.startedAt,
    };
  } catch {
    return undefined;
  }
}

function readLayoutLockState(lockPath: string): LayoutLockState | undefined {
  try {
    const stat = statSync(lockPath);
    let ownerText: string | undefined;
    try {
      ownerText = readFileSync(`${lockPath}/owner.json`, "utf8");
    } catch {
      // A missing or unreadable owner is recoverable only after the lock directory ages out.
    }
    return {
      device: stat.dev,
      inode: stat.ino,
      ownerText,
      owner: ownerText === undefined ? undefined : parseLayoutLockOwner(ownerText),
    };
  } catch (error) {
    if (systemErrorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function sameLayoutLockState(left: LayoutLockState, right: LayoutLockState): boolean {
  return left.device === right.device &&
    left.inode === right.inode &&
    left.ownerText === right.ownerText;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return systemErrorCode(error) === "EPERM";
  }
}

function lockIsStale(lockPath: string, state: LayoutLockState, staleAfterMs: number): boolean {
  if (state.owner?.hostname === CURRENT_HOSTNAME) return !processIsAlive(state.owner.pid);
  const age = Date.now() - (state.owner?.startedAt ?? statSync(lockPath).mtimeMs);
  return age >= staleAfterMs;
}

function recoverStaleLock(lockPath: string, observed: LayoutLockState): boolean {
  const current = readLayoutLockState(lockPath);
  if (!current || !sameLayoutLockState(observed, current)) return false;

  const quarantinePath = `${lockPath}.stale-${process.pid}-${crypto.randomUUID()}`;
  try {
    renameSync(lockPath, quarantinePath);
  } catch (error) {
    const code = systemErrorCode(error);
    if (code === "ENOENT" || code === "EEXIST") return false;
    throw error;
  }
  rmSync(quarantinePath, { recursive: true, force: true });
  return true;
}

function tryAcquireRecoveryClaim(lockPath: string): LayoutLockOwner | undefined {
  const claimPath = recoveryClaimPath(lockPath);
  const owner: LayoutLockOwner = {
    token: crypto.randomUUID(),
    pid: process.pid,
    hostname: CURRENT_HOSTNAME,
    startedAt: Date.now(),
  };
  const candidatePath = `${claimPath}.candidate-${owner.token}`;
  mkdirSync(candidatePath);
  try {
    writeFileSync(`${candidatePath}/owner.json`, `${JSON.stringify(owner)}\n`, { flag: "wx" });
    renameSync(candidatePath, claimPath);
    return owner;
  } catch (error) {
    rmSync(candidatePath, { recursive: true, force: true });
    const code = systemErrorCode(error);
    if (code === "EEXIST" || code === "ENOTEMPTY") return undefined;
    throw error;
  }
}

function recoveryClaimIsOwned(lockPath: string, owner: LayoutLockOwner): boolean {
  return readLayoutLockState(recoveryClaimPath(lockPath))?.owner?.token === owner.token;
}

function releaseRecoveryClaim(lockPath: string, owner: LayoutLockOwner): void {
  const claimPath = recoveryClaimPath(lockPath);
  if (!recoveryClaimIsOwned(lockPath, owner)) {
    throw new Error(`Cannot release Outliner layout recovery claim ${claimPath}: ownership changed`);
  }
  rmSync(claimPath, { recursive: true });
}

function tryAcquireLayoutLock(lockPath: string): LayoutLockOwner | undefined {
  try {
    mkdirSync(lockPath);
  } catch (error) {
    if (systemErrorCode(error) === "EEXIST") return undefined;
    throw error;
  }
  const owner: LayoutLockOwner = {
    token: crypto.randomUUID(),
    pid: process.pid,
    hostname: CURRENT_HOSTNAME,
    startedAt: Date.now(),
  };
  try {
    writeFileSync(`${lockPath}/owner.json`, `${JSON.stringify(owner)}\n`, { flag: "wx" });
    return owner;
  } catch (error) {
    rmSync(lockPath, { recursive: true, force: true });
    throw error;
  }
}

function releaseLayoutLock(lockPath: string, owner: LayoutLockOwner): void {
  let ownerText: string;
  try {
    ownerText = readFileSync(`${lockPath}/owner.json`, "utf8");
  } catch (cause) {
    throw new Error(`Cannot release Outliner layout lock ${lockPath}: ownership is missing or unreadable`, {
      cause,
    });
  }
  const current = parseLayoutLockOwner(ownerText);
  if (!current) {
    throw new Error(`Cannot release Outliner layout lock ${lockPath}: ownership is malformed`);
  }
  if (current.token !== owner.token) {
    throw new Error(`Cannot release Outliner layout lock ${lockPath}: ownership token changed`);
  }
  rmSync(lockPath, { recursive: true });
}

export async function withLayoutLock<T>(
  lockPath: string,
  operation: () => T | Promise<T>,
  options: LayoutLockOptions = {},
): Promise<T> {
  const waitTimeoutMs = options.waitTimeoutMs ?? LAYOUT_LOCK_WAIT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? LAYOUT_LOCK_POLL_MS;
  const staleAfterMs = options.staleAfterMs ?? LAYOUT_LOCK_STALE_MS;
  const deadline = Date.now() + waitTimeoutMs;
  let owner: LayoutLockOwner | undefined;
  while (!owner) {
    const candidate = tryAcquireLayoutLock(lockPath);
    if (candidate) {
      const claimPath = recoveryClaimPath(lockPath);
      const claim = readLayoutLockState(claimPath);
      if (!claim) {
        owner = candidate;
        break;
      }
      if (
        lockIsStale(claimPath, claim, staleAfterMs) &&
        recoverStaleLock(claimPath, claim) &&
        !readLayoutLockState(claimPath)
      ) {
        owner = candidate;
        break;
      }
      releaseLayoutLock(lockPath, candidate);
    }

    const recoveryOwner = tryAcquireRecoveryClaim(lockPath);
    if (recoveryOwner) {
      let replacement: LayoutLockOwner | undefined;
      try {
        const observed = readLayoutLockState(lockPath);
        if (
          observed &&
          lockIsStale(lockPath, observed, staleAfterMs) &&
          recoveryClaimIsOwned(lockPath, recoveryOwner) &&
          recoverStaleLock(lockPath, observed) &&
          recoveryClaimIsOwned(lockPath, recoveryOwner)
        ) {
          replacement = tryAcquireLayoutLock(lockPath);
          if (replacement && !recoveryClaimIsOwned(lockPath, recoveryOwner)) {
            releaseLayoutLock(lockPath, replacement);
            replacement = undefined;
          }
        }
      } finally {
        if (recoveryClaimIsOwned(lockPath, recoveryOwner)) {
          try {
            releaseRecoveryClaim(lockPath, recoveryOwner);
          } catch (error) {
            if (replacement) {
              releaseLayoutLock(lockPath, replacement);
              replacement = undefined;
            }
            throw error;
          }
        } else if (replacement) {
          releaseLayoutLock(lockPath, replacement);
          replacement = undefined;
        }
      }
      if (replacement) {
        owner = replacement;
        break;
      }
    } else {
      const claimPath = recoveryClaimPath(lockPath);
      const claim = readLayoutLockState(claimPath);
      if (claim && lockIsStale(claimPath, claim, staleAfterMs)) {
        recoverStaleLock(claimPath, claim);
      }
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(`Timed out waiting ${waitTimeoutMs}ms for Outliner layout lock ${lockPath}`);
    }
    await sleep(Math.min(pollIntervalMs, remainingMs));
  }

  let result: T | undefined;
  let operationError: unknown;
  let operationFailed = false;
  try {
    result = await operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  let releaseError: unknown;
  let releaseFailed = false;
  try {
    releaseLayoutLock(lockPath, owner);
  } catch (error) {
    releaseFailed = true;
    releaseError = error;
  }

  if (operationFailed && releaseFailed) {
    throw new AggregateError(
      [operationError, releaseError],
      `Outliner layout operation and lock release both failed for ${lockPath}`,
    );
  }
  if (operationFailed) throw operationError;
  if (releaseFailed) throw releaseError;
  return result as T;
}

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
    if (!key.startsWith("--")) continue;
    if (!EXPLICIT_LAYOUT_OPTIONS[key]) throw new Error(`Unknown explicit layout option: ${key}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${key} requires a pane id`);
    if (values.has(key)) throw new Error(`Explicit layout option may only be provided once: ${key}`);
    values.set(key, value);
    index++;
  }
  const keys = ["--tree", "--detail-a", "--detail-b", "--shell"] as const;
  if (!keys.some((key) => values.has(key))) return undefined;
  for (const key of keys) {
    if (!values.has(key)) throw new Error(`Explicit layout requires ${key}`);
  }
  const explicit: ExplicitLayoutArgs = {
    tree: values.get("--tree")!,
    detailA: values.get("--detail-a")!,
    detailB: values.get("--detail-b")!,
    shell: values.get("--shell")!,
    ...(values.has("--focus") ? { focusPaneId: values.get("--focus") } : {}),
  };
  const rolePaneIds = [explicit.tree, explicit.detailA, explicit.detailB, explicit.shell];
  if (new Set(rolePaneIds).size !== rolePaneIds.length) {
    throw new Error("Explicit Outliner layout roles must name four distinct panes");
  }
  if (explicit.focusPaneId && !rolePaneIds.includes(explicit.focusPaneId)) {
    throw new Error("Explicit Outliner layout focus must name one of the four role panes");
  }
  return explicit;
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
    const rolePaneIds = [explicit.tree, explicit.detailA, explicit.detailB, explicit.shell];
    const paneRecords = rolePaneIds.map((paneId) => api.getPane(paneId));
    const treePane = paneRecords[0]!;
    if (paneRecords.some((pane) => pane.workspace_id !== treePane.workspace_id || pane.tab_id !== treePane.tab_id)) {
      throw new Error("All explicit Outliner layout panes must be in the same tab");
    }
    workspaceId = treePane.workspace_id;
    tabId = treePane.tab_id;
    panes = explicit;
    focusPaneId = explicit.focusPaneId;
  } else {
    const invocationPaneId = pluginInvocationPaneId();
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
  const socketPath = process.env.HERDR_SOCKET_PATH ?? `${homedir()}/.config/herdr/herdr.sock`;
  const result = await withLayoutLock(
    `${socketPath}.layout.lock`,
    () => applyLayout(name, args),
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`outliner layout: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
