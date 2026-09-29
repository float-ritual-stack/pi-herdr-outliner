import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createOutlinerClient } from "./client";
import { listLiveClients, sendClientCommand } from "./client-target";
import {
  invocationPaneRoot,
  selectLinkedDetailClient,
  selectTreeClientForInvocation,
} from "./herdr-open-policy";
import {
  pluginInvocationPaneId,
  pluginInvocationWorkspaceRootSource,
  type PaneEntrypoint,
  resolveServicePaneId,
} from "./pane-control";
import { relaunchArgs, relaunchEnvironment } from "./herdr-open-relaunch";
import { detectOutline, localOutlineOwner, socketAbsent } from "./known-outlines";
import { resolveClientConfigRoot, resolveStateRoot } from "./paths";
import type { OutlineChooserContext } from "./outline-chooser";
import { waitForCompatibleService } from "./service-compatibility";
import {
  clientSupportsRole,
  type OutlinerClientRegistration,
  type NavigationLinkState,
} from "./types";

import { reportStartupErrors } from "./startup-error";

await reportStartupErrors("open", async () => {
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
    mode !== "open-tree" &&
    mode !== "open-composed" &&
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
    (mode === "open-tree" || mode === "open-here" || mode === "open-composed" || mode === "service-only")
  ) {
    throw new Error(`--client cannot be used with --mode ${mode}`);
  }
  if (process.env.HERDR_ENV !== "1") throw new Error("The outliner workspace action must run inside Herdr");

  // The outline chooser continues an open with the folder it was asked about.
  const chosenRoot = process.env.OUTLINER_OPEN_WORKSPACE_ROOT?.trim();
  const invocationRoot = pluginInvocationWorkspaceRootSource();
  let workspaceRoot = chosenRoot || invocationRoot.root;
  let rootSource = chosenRoot
    ? "the folder the outline chooser was opened for"
    : { pane: "the invoking pane's directory", workspace: "the Herdr workspace root", fallback: "the launcher's working directory" }[invocationRoot.source];
  let invocationPane: NonNullable<PaneDetailsResponse["result"]>["pane"];
  if (currentPaneId) {
    const paneOutput = execFileSync(herdr, ["pane", "get", currentPaneId], {
      encoding: "utf8",
      timeout: HERDR_SYNC_TIMEOUT_MS,
    });
    invocationPane = (JSON.parse(paneOutput) as PaneDetailsResponse).result?.pane;
    // Outliner panes report their project through OSC 7; their running process
    // remains in the plugin checkout. A new Tree must inherit the project.
    const picked = chosenRoot ? undefined : invocationPaneRoot(invocationPane, mode, resolve(import.meta.dir, ".."));
    if (picked) {
      workspaceRoot = picked.root;
      rootSource = `the invoking pane's ${picked.field}`;
    }
  }

  const presence = detectOutline({ ...process.env, OUTLINER_WORKSPACE_ROOT: workspaceRoot });
  if (presence.kind === "missing") {
    // Opening never creates an outline by itself: ask which one this folder uses.
    if (mode === "service-only") {
      throw new Error(`No outline for ${presence.paths.workspaceRoot} (resolved from ${rootSource}). Open the Outliner from Herdr in that folder to choose an outline or create one there.`);
    }
    const context: OutlineChooserContext = {
      mode,
      workspaceRoot: presence.paths.workspaceRoot,
      rootSource,
      ...(currentPaneId ? { paneId: currentPaneId } : {}),
      ...(requestedClientId ? { clientId: requestedClientId } : {}),
    };
    const args = [
      "plugin", "pane", "open", "--plugin", pluginId, "--entrypoint", "choose-outline",
      "--env", `OUTLINER_WORKSPACE_ROOT=${presence.paths.workspaceRoot}`,
      "--env", `OUTLINER_CHOOSER_CONTEXT=${JSON.stringify(context)}`,
      "--focus",
    ];
    for (const name of ["OUTLINER_STATE_DIR", "OUTLINER_CONFIG_PATH", "OUTLINER_KEYBINDINGS_PATH", "XDG_CONFIG_HOME"] as const) {
      if (process.env[name] !== undefined) args.push("--env", `${name}=${process.env[name]}`);
    }
    execFileSync(herdr, args, { stdio: "ignore", timeout: HERDR_SYNC_TIMEOUT_MS });
    process.stdout.write(`${JSON.stringify({ outline: "missing", chooser: "choose-outline", workspaceRoot: presence.paths.workspaceRoot, rootSource })}\n`);
    return;
  }
  const paths = presence.paths;
  // A folder the chooser aliased to another local outline records that outline's
  // socket. After a restart nobody runs its service, so start it from its own folder.
  if (paths.mode === "remote" && process.env.OUTLINER_REMOTE?.trim() === undefined) {
    const owner = localOutlineOwner(paths.socket, {
      stateRoot: resolveStateRoot(process.env),
      configRoot: resolveClientConfigRoot(process.env),
    });
    // Only a missing or refusing socket means stopped: a slow answer from a busy
    // service must not start a second one or fail the open.
    if (owner && await socketAbsent(paths.socket)) {
      if (!owner.root) {
        throw new Error(`The outline this folder uses (${owner.stateDir}) is not running, and the folder it belongs to is unknown. Open the Outliner from that outline's own folder to start it, then retry.`);
      }
      // OUTLINER_REMOTE=0 makes the owner's own open local, so this cannot recurse.
      execFileSync(process.execPath, relaunchArgs("service-only"), {
        env: { ...relaunchEnvironment(process.env, owner.root), OUTLINER_REMOTE: "0" },
        stdio: ["ignore", "ignore", "pipe"],
        timeout: 30_000,
      });
    }
  }
  // Remote outlines keep their state on the service host; nothing is created here.
  if (paths.mode === "local") mkdirSync(paths.stateDir, { recursive: true });

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
    const remote = paths.mode === "remote";
    await waitForCompatibleService(createOutlinerClient(paths), {
      timeoutMs: remote ? 60_000 : 15_000,
      pingTimeoutMs: remote ? undefined : 300,
    }).catch((error: unknown) => {
      const lastResponse = (error instanceof Error ? error.message : String(error)).replace(/\.$/, "");
      throw new Error(`Compatible outliner service did not become ready at ${paths.socket}. ${lastResponse}. ${remote
        ? "Check the configured SSH tunnel and remote service."
        : `Service startup details: ${join(paths.stateDir, "service-startup-error.log")} (check its timestamp).`}`);
    });
  }

  const servicePane = paths.mode === "remote"
    ? null
    : resolveServicePaneId(paths.stateDir, herdr) ??
      openPane("service", {
        placement: "tab",
        env: process.env.TYPESAFE_API_KEY === undefined
          ? undefined
          : { TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY },
      });
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
      command: "focus", targetRegion: "tree",
    });
    return { servicePane, focusedClientId: selected.clientId, workspaceRoot };
  }

  async function waitForClientPane(
    paneId: string,
    role: "tree" | "detail" | "composed",
  ): Promise<OutlinerClientRegistration> {
    const client = createOutlinerClient(paths);
    const deadline = Date.now() + (paths.mode === "remote" ? 60_000 : 5_000);
    while (Date.now() < deadline) {
      try {
        const registration = localHerdrClients(await listLiveClients(client, role))
          .find((candidate) => candidate.runtime?.paneId === paneId);
        if (registration) return registration;
      } catch {
        // Retry until the pane has initialized and registered.
      }
      await sleep(100);
    }
    throw new Error(`Outliner ${role} did not become ready in pane ${paneId}`);
  }

  async function openTreeOnly() {
    if (!currentPaneId) throw new Error("open-tree requires Herdr invocation pane context");
    const browsingContextId = crypto.randomUUID();
    const outlinerPane = openPane("outliner", {
      placement: "split", targetPane: currentPaneId, direction: "right",
      env: { OUTLINER_BROWSING_CONTEXT_ID: browsingContextId },
    });
    await waitForClientPane(outlinerPane, "tree");
    execFileSync(herdr, ["plugin", "pane", "focus", outlinerPane], {stdio: "ignore", timeout: HERDR_SYNC_TIMEOUT_MS});
    return {servicePane, outlinerPane, browsingContextId, workspaceRoot};
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
    const [treeView, detailView] = await Promise.all([
      waitForClientPane(outlinerPane, "tree"),
      waitForClientPane(detailPane, "detail"),
    ]);
    await createOutlinerClient(paths).request({action: "navigation.link.set", source: {clientId: treeView.clientId, region: "tree"}, destination: {clientId: detailView.clientId, region: "detail"}});
    execFileSync(herdr, ["plugin", "pane", "focus", outlinerPane], {
      stdio: "ignore",
      timeout: HERDR_SYNC_TIMEOUT_MS,
    });
    return { servicePane, outlinerPane, detailPane, browsingContextId, workspaceRoot };
  }

  async function openComposed() {
    if (!currentPaneId) throw new Error("open-composed requires Herdr invocation pane context");
    const browsingContextId = crypto.randomUUID();
    const pane = openPane("composed", {placement: "split", targetPane: currentPaneId, direction: "right", env: {OUTLINER_BROWSING_CONTEXT_ID: browsingContextId}});
    const view = await waitForClientPane(pane, "composed");
    await createOutlinerClient(paths).request({action: "navigation.link.set", source: {clientId: view.clientId, region: "tree"}, destination: {clientId: view.clientId, region: "detail"}});
    execFileSync(herdr, ["plugin", "pane", "focus", pane], {stdio: "ignore", timeout: HERDR_SYNC_TIMEOUT_MS});
    return {servicePane, outlinerPane: pane, detailPane: pane, browsingContextId, workspaceRoot};
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
    const trees = clients.filter((candidate) => clientSupportsRole(candidate, "tree"));
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
    const link = await client.request<NavigationLinkState>({action: "navigation.link.get", source: {clientId: tree.clientId, region: "tree"}});
    const existing = selectLinkedDetailClient(clients, link.destination);
    if (existing) {
      await sendClientCommand(client, existing.clientId, { command: "focus", targetRegion: "detail" });
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
    const detailView = await waitForClientPane(detailPane, "detail");
    await createOutlinerClient(paths).request({action: "navigation.link.set", source: {clientId: tree.clientId, region: "tree"}, destination: {clientId: detailView.clientId, region: "detail"}});
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
  } else if (mode === "open-composed") {
    result = await openComposed();
  } else if (mode === "open-tree") {
    result = await openTreeOnly();
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
});
