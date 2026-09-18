import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createOutlinerClient } from "./client";
import { listLiveClients } from "./client-target";
import { navigateOutlinerLink } from "./outliner-links";
import {
  pluginClickedUrl,
  pluginInvocationPaneId,
  pluginInvocationWorkspaceRoot,
} from "./pane-control";
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
  const paths = resolveClientPaths({ ...process.env, OUTLINER_WORKSPACE_ROOT: workspaceRoot });
  const client = createOutlinerClient(paths);
  const paneId = pluginInvocationPaneId();
  if (!paneId) throw new Error("Herdr plugin link context has no source pane");
  const source = (await listLiveClients(client)).find(
    (registration) => registration.runtime?.paneId === paneId,
  );
  if (!source) throw new Error("The source Outliner pane is not registered");
  const navigation = await navigateOutlinerLink(client, clickedUrl, {
    sourceClientId: source.clientId,
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
