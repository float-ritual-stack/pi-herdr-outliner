import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { OutlinerClient } from "./client";
import { socketAbsent } from "./known-outlines";
import { type OutlinerClientPaths, outlineHostConfigured, outlineHostPaths, resolveClientPaths, resolveStateRoot } from "./paths";
import type { HostedOutlineAttachment, HostedOutlineList, HostedPaneOutline } from "./types";

/**
 * A client for the outline host's own requests (`outlines.*`), when a host
 * answers under this state root; undefined when none runs. It names no outline.
 */
export async function outlineHostClient(stateRoot: string, timeoutMs = 3_000): Promise<OutlinerClient | undefined> {
  const { socket } = outlineHostPaths(stateRoot);
  if (await socketAbsent(socket, 500)) return undefined;
  return new OutlinerClient(socket, timeoutMs);
}

/**
 * The host client once the host answers, waiting up to `waitMs` like a remote
 * client waits for its tunnel: a host that is restarting comes back. Undefined
 * when it never answers.
 */
export async function waitForOutlineHost(stateRoot: string, waitMs = 60_000): Promise<OutlinerClient | undefined> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const host = await outlineHostClient(stateRoot);
    if (host || Date.now() >= deadline) return host;
    await sleep(250);
  }
}

export function listHostedOutlines(host: OutlinerClient): Promise<HostedOutlineList> {
  return host.request<HostedOutlineList>({ action: "outlines.list" });
}

/**
 * Opens a session's outline on the host; `create` makes it first when missing
 * (session openers only), recording `root`, the folder it is for.
 */
export function attachHostedOutline(host: OutlinerClient, name: string, create: boolean, root?: string): Promise<HostedOutlineAttachment> {
  return host.request<HostedOutlineAttachment>({ action: "outlines.attach", name, create, ...(root ? { root } : {}) });
}

/** The outline a live pane on this machine is registered on, per the host; undefined when none is. */
export async function registeredPaneOutline(host: OutlinerClient, paneId: string): Promise<string | undefined> {
  return (await host.request<HostedPaneOutline>({ action: "outlines.pane", paneId, hostname: hostname() })).outline;
}

/**
 * Where a Herdr action invoked from `paneId` connects: the outline that pane
 * is registered on, when it is an outliner pane on this machine's host
 * (outlineSource `pane`), else the usual resolution of `env`. So an action
 * from a pane on `fred` stays on `fred` after its folder was rebound, and a
 * Detail opened by name works in a folder with no binding. `OUTLINER_OUTLINE`
 * and `OUTLINER_REMOTE` still win.
 */
export async function resolveInvocationPaths(env: NodeJS.ProcessEnv, paneId: string | undefined, waitMs = 60_000): Promise<OutlinerClientPaths> {
  const stateRoot = resolveStateRoot(env);
  if (paneId && !env.OUTLINER_OUTLINE?.trim() && env.OUTLINER_REMOTE?.trim() === undefined && outlineHostConfigured(stateRoot)) {
    const host = await waitForOutlineHost(stateRoot, waitMs);
    const outline = host ? await registeredPaneOutline(host, paneId).catch(() => undefined) : undefined;
    if (outline) return { ...resolveClientPaths({ ...env, OUTLINER_OUTLINE: outline }), outlineSource: "pane" };
  }
  return resolveClientPaths(env);
}
