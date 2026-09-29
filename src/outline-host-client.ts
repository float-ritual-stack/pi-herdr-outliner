import { OutlinerClient } from "./client";
import { socketAbsent } from "./known-outlines";
import { outlineHostPaths } from "./paths";
import type { HostedOutlineAttachment, HostedOutlineList } from "./types";

/**
 * A client for the outline host's own requests (`outlines.*`), when a host
 * answers under this state root; undefined when none runs. It names no outline.
 */
export async function outlineHostClient(stateRoot: string, timeoutMs = 3_000): Promise<OutlinerClient | undefined> {
  const { socket } = outlineHostPaths(stateRoot);
  if (await socketAbsent(socket, 500)) return undefined;
  return new OutlinerClient(socket, timeoutMs);
}

export function listHostedOutlines(host: OutlinerClient): Promise<HostedOutlineList> {
  return host.request<HostedOutlineList>({ action: "outlines.list" });
}

/**
 * Opens a session's outline on the host; `create` makes it first when missing
 * (session openers only). `folder` records the folder a name was taken from.
 */
export function attachHostedOutline(host: OutlinerClient, name: string, create: boolean, folder?: string): Promise<HostedOutlineAttachment> {
  return host.request<HostedOutlineAttachment>({ action: "outlines.attach", name, create, ...(folder ? { folder } : {}) });
}
