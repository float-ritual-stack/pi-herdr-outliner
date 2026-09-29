import { spawn } from "node:child_process";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, ProcessTerminal } from "@earendil-works/pi-tui";
import { decodePiDetailInput } from "./detail-pi-input";
import { listKnownOutlines } from "./known-outlines";
import {
  chooserKey,
  chooserMouse,
  OutlineChooser,
  parseOutlineChooserContext,
  planChoice,
  renderChooserFrame,
  type ChooserIntent,
} from "./outline-chooser";
import { reportCurrentPaneWorkspace } from "./pane-control";
import { resolveClientConfigRoot, resolveStateRoot, writeClientConfig } from "./paths";
import { isTreeMouseSequence } from "./tree-mouse";

if (process.env.HERDR_ENV !== "1") throw new Error("The outline chooser requires Herdr");
const context = parseOutlineChooserContext(process.env.OUTLINER_CHOOSER_CONTEXT);
reportCurrentPaneWorkspace(context.workspaceRoot);
const chooser = new OutlineChooser(context);
const terminal = new ProcessTerminal();
let stopping = false;
let workQueue = Promise.resolve();

function draw(): void {
  if (stopping) return;
  terminal.write("\x1b[H\x1b[2J" + renderChooserFrame(chooser, terminal.columns, terminal.rows).join("\r\n"));
}

async function stop(exitCode = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  await terminal.drainInput();
  terminal.stop();
  terminal.write("\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l");
  process.exit(exitCode);
}

/** Runs the launcher again for the chosen folder, as if the user had invoked the action there. */
function launcherEnvironment(workspaceRoot: string, paneId: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OUTLINER_OPEN_WORKSPACE_ROOT: workspaceRoot,
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
      ...(paneId ? { focused_pane_id: paneId } : {}),
      focused_pane_cwd: workspaceRoot,
    }),
  };
  delete env.OUTLINER_CHOOSER_CONTEXT;
  // This popup's own pane must never be mistaken for the invoking pane.
  delete env.HERDR_PANE_ID;
  return env;
}

function launcherArgs(mode: string, clientId?: string): string[] {
  return ["run", join(import.meta.dir, "herdr-open.ts"), "--mode", mode, ...(clientId ? ["--client", clientId] : [])];
}

function runLauncher(mode: string, workspaceRoot: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const child = spawn(process.execPath, launcherArgs(mode), {
      env: launcherEnvironment(workspaceRoot, undefined),
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", code => code === 0
      ? resolve()
      : reject(new Error(stderr.trim().split("\n")[0] || `Starting the outline service exited ${code}`)));
  });
}

async function choose(): Promise<void> {
  const row = chooser.selected;
  if (!row || chooser.busy) return;
  const plan = planChoice(row, context.workspaceRoot);
  if (plan.kind === "refuse") { chooser.status = plan.message; draw(); return; }
  chooser.busy = true;
  try {
    if (plan.startServiceFor) {
      chooser.status = `Starting the outline for ${plan.startServiceFor}…`;
      draw();
      await runLauncher("service-only", plan.startServiceFor);
    }
    writeClientConfig(process.env, plan.config);
  } catch (error) {
    chooser.busy = false;
    chooser.status = error instanceof Error ? error.message : String(error);
    draw();
    return;
  }
  // The popup closes before the panes open; the launcher reports its own failures.
  spawn(process.execPath, launcherArgs(context.mode, context.clientId), {
    env: launcherEnvironment(context.workspaceRoot, context.paneId),
    detached: true,
    stdio: "ignore",
  }).unref();
  await stop();
}

function apply(intent: ChooserIntent): void {
  if (intent === "close") void stop();
  else if (intent === "choose") workQueue = workQueue.then(choose);
  else if (intent === "changed") draw();
}

initTheme(undefined, false);
terminal.write("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h");
terminal.start(data => {
  if (isKeyRelease(data)) return;
  if (isTreeMouseSequence(data)) {
    apply(chooserMouse(chooser, data, terminal.columns, terminal.rows));
    return;
  }
  const input = decodePiDetailInput(data);
  if (input.kind === "paste" || input.inputAction === "suppress") return;
  apply(chooserKey(chooser, input.key));
}, draw);
process.on("SIGINT", () => void stop(130));
process.on("SIGTERM", () => void stop(143));
process.on("SIGHUP", () => void stop(129));
draw();
void listKnownOutlines({ stateRoot: resolveStateRoot(), configRoot: resolveClientConfigRoot() })
  .then(outlines => { chooser.setOutlines(outlines); draw(); })
  .catch(error => {
    chooser.loading = false;
    chooser.status = `Could not list outlines: ${error instanceof Error ? error.message : String(error)}`;
    draw();
  });
