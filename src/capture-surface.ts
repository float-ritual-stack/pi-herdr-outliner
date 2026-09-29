import {execFile} from "node:child_process";
import {mkdir, mkdtemp, readFile, rename, rm, writeFile} from "node:fs/promises";
import {hostname} from "node:os";
import {join} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {promisify} from "node:util";
import {Type, type Static} from "typebox";
import {Parse} from "typebox/value";
import type {OutlinerRequester} from "./client-target";
import {openSidebar} from "./sidebar-placement";
import type {OutlinerClientRegistration, QuickCaptureDraft} from "./types";

export type CapturePlacement = "popup" | "left" | "right" | "bottom";
const HandoffSchema = Type.Object({
  transferToken: Type.Optional(Type.String()),
  requestId: Type.String(), revision: Type.Integer({minimum: 1}),
  placement: Type.Union([Type.Literal("popup"), Type.Literal("left"), Type.Literal("right"), Type.Literal("bottom")]),
  originPaneId: Type.String({minLength: 1}), editor: Type.Boolean(), deadline: Type.Number(),
});
export type CaptureHandoff = Static<typeof HandoffSchema>;
const execute = promisify(execFile);
async function herdr(args: string[]): Promise<unknown> {
  try {
    const {stdout} = await execute(process.env.HERDR_BIN_PATH ?? "herdr", args,
      {encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024});
    return stdout.trim() ? JSON.parse(stdout) : undefined;
  } catch (error) {
    if (error instanceof Error && "stderr" in error && typeof error.stderr === "string") {
      let response;
      try { response = JSON.parse(error.stderr); } catch { /* Preserve the process error below. */ }
      if (typeof response?.error?.message === "string") throw Error(response.error.message);
    }
    throw error;
  }
}
async function publish(directory: string, name: string, value: unknown): Promise<void> {
  const path = join(directory, name);
  await writeFile(`${path}.pending`, JSON.stringify(value), {mode: 0o600});
  await rename(`${path}.pending`, path);
}
async function waitFor(directory: string, name: string, handoff: CaptureHandoff): Promise<void> {
  while (Date.now() < handoff.deadline) {
    try {
      const value = JSON.parse(await readFile(join(directory, name), "utf8"));
      if (value.requestId !== handoff.requestId || value.revision !== handoff.revision) throw Error("Capture handoff identity changed");
      return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await delay(50);
  }
  throw Error("Capture destination did not become ready; the draft is retained");
}

/** A local presentation handshake, not another draft store. Canonical writing and
 * ownership revisions stay with the service; both surfaces must load that version. */
export async function loadCaptureHandoff(directory: string): Promise<CaptureHandoff> {
  return Parse(HandoffSchema, JSON.parse(await readFile(join(directory, "request"), "utf8")));
}
export async function acceptCaptureHandoff(directory: string, handoff: CaptureHandoff, draft: QuickCaptureDraft | null): Promise<void> {
  if (draft?.requestId !== handoff.requestId || draft.revision !== handoff.revision) {
    throw Error("Capture changed during handoff; reopen its current draft");
  }
  await publish(directory, "ready", handoff);
  await waitFor(directory, "activate", handoff);
}
export async function confirmCaptureHandoff(directory: string, handoff: CaptureHandoff): Promise<void> {
  await publish(directory, "active", handoff);
}

export async function openCaptureSurface(client: OutlinerRequester, options: {
  workspaceRoot: string; stateDir: string; draft: QuickCaptureDraft;
  originPaneId: string; placement: CapturePlacement; editor?: boolean; ownerClientId?: string;
}): Promise<void> {
  if (process.env.HERDR_ENV !== "1") throw Error("Capture docking requires Herdr");
  const transfer = options.ownerClientId ? await client.request<{token: string}>({action: "capture.owner.handoff",
    clientId: options.ownerClientId, requestId: options.draft.requestId, expectedDraftRevision: options.draft.revision}) : undefined;
  await mkdir(options.stateDir, {recursive: true, mode: 0o700});
  const directory = await mkdtemp(join(options.stateDir, "capture-handoff-"));
  const handoff: CaptureHandoff = {...(transfer ? {transferToken: transfer.token} : {}), requestId: options.draft.requestId, revision: options.draft.revision,
    placement: options.placement, originPaneId: options.originPaneId, editor: options.editor ?? false, deadline: Date.now() + 25_000};
  let paneId: string | undefined;
  let activated = false;
  try {
    await publish(directory, "request", handoff);
    const launch = async (anchor: string, direction?: "right" | "down"): Promise<string | undefined> => {
      const args = ["plugin", "pane", "open", "--plugin", "float.pi-outliner", "--entrypoint", "capture",
        "--env", `OUTLINER_WORKSPACE_ROOT=${options.workspaceRoot}`,
        "--env", `OUTLINER_CAPTURE_HANDOFF=${directory}`,
        ...(direction ? ["--target-pane", anchor, "--placement", "split", "--direction", direction, "--no-focus"] : ["--focus"])];
      for (const name of ["OUTLINER_STATE_DIR", "OUTLINER_CONFIG_PATH", "OUTLINER_REMOTE", "OUTLINER_SOCKET_PATH", "OUTLINER_OUTLINE", "OUTLINER_KEYBINDINGS_PATH"] as const) {
        if (process.env[name] !== undefined) args.push("--env", `${name}=${process.env[name]}`);
      }
      const opened = await herdr(args);
      const id = direction ? Parse(Type.Object({result: Type.Object({plugin_pane: Type.Object({pane: Type.Object({pane_id: Type.String({minLength: 1})})})})}), opened).result.plugin_pane.pane.pane_id : undefined;
      paneId = id;
      await waitFor(directory, "ready", handoff);
      return id;
    };
    if (options.placement === "popup") await launch(options.originPaneId);
    else {
      const origin = Parse(Type.Object({result: Type.Object({pane: Type.Object({tab_id: Type.String(), workspace_id: Type.String()})})}),
        await herdr(["pane", "get", options.originPaneId])).result.pane;
      const clients = await client.request<OutlinerClientRegistration[]>({action: "clients.list"});
      const outlinerPaneIds = [...new Set(clients.filter(c => ["tree", "detail", "composed"].includes(c.role) &&
        c.runtime?.hostname === hostname() && c.runtime.workspaceId === origin.workspace_id && c.runtime.tabId === origin.tab_id)
        .flatMap(c => c.runtime?.paneId ? [c.runtime.paneId] : []))];
      paneId = await openSidebar({sourcePaneId: options.originPaneId, outlinerPaneIds,
        scope: outlinerPaneIds.includes(options.originPaneId) ? "outliner" : "tab", side: options.placement,
        async createPane(anchor, direction) { return (await launch(anchor, direction))!; },
      });
    }
    await publish(directory, "activate", handoff);
    await waitFor(directory, "active", handoff);
    activated = true;
    if (paneId) await herdr(["plugin", "pane", "focus", paneId]).catch(() => {});
  } catch (error) {
    if (paneId && !activated) await herdr(["pane", "close", paneId]).catch(() => {});
    throw error;
  } finally {
    await rm(directory, {recursive: true, force: true}).catch(() => {});
  }
}
