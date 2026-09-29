import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { join } from "node:path";
import { createOutlinerClient } from "./client";
import { listLiveClients } from "./client-target";
import { navigateOutlinerLink } from "./outliner-links";
import {
  pluginClickedUrl,
  pluginInvocationPaneId,
  pluginInvocationWorkspaceRoot,
} from "./pane-control";
import { resolveInvocationPaths } from "./outline-host-client";
import { resolveClientPaths } from "./paths";

if (process.env.HERDR_ENV !== "1") {
  throw new Error("Outliner action must run inside Herdr");
}

const clickedUrl = pluginClickedUrl();
const clientPaths = resolveClientPaths();
if (!clickedUrl) {
  const output = execFileSync(
    process.execPath,
    ["run", join(import.meta.dir, "herdr-open.ts"), "--mode", "focus-or-open"],
    {
      encoding: "utf8",
      env: process.env,
      timeout: clientPaths.mode === "remote" ? 150_000 : 30_000,
    },
  );
  process.stdout.write(output);
} else {
  const workspaceRoot = pluginInvocationWorkspaceRoot();
  const paneId = pluginInvocationPaneId();
  if (!paneId) throw new Error("Herdr plugin link context has no source pane");
  // The link was clicked in a pane: follow it on the outline that pane is on.
  const paths = await resolveInvocationPaths({ ...process.env, OUTLINER_WORKSPACE_ROOT: workspaceRoot }, paneId);
  const client = createOutlinerClient(paths);
  const localHostname = hostname();
  const source = (await listLiveClients(client)).find(
    (registration) =>
      registration.runtime?.hostname === localHostname &&
      registration.runtime.paneId === paneId,
  );
  if (!source) throw new Error("The source Outliner pane is not registered");
  const navigation = await navigateOutlinerLink(client, clickedUrl, {
    sourceClientId: source.clientId,
    ...(source.role === "composed" ? {sourceRegion: source.focusedRegion ?? "tree"} : {}),
    intent: "open",
  });
  process.stdout.write(`${JSON.stringify({
    dispatched: true,
    target: navigation.kind,
    id: navigation.id,
    title: navigation.title,
    destinationClientId: navigation.targetClientId,
    resolution: navigation.resolution,
  })}\n`);
}
