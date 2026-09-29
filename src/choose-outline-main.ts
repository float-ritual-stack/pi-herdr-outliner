import { spawn } from "node:child_process";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, ProcessTerminal } from "@earendil-works/pi-tui";
import { decodePiDetailInput } from "./detail-pi-input";
import { relaunchArgs, relaunchEnvironment } from "./herdr-open-relaunch";
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

function runLauncher(mode: string, workspaceRoot: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const child = spawn(process.execPath, relaunchArgs(mode), {
      env: relaunchEnvironment(process.env, workspaceRoot),
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
    try {
      writeClientConfig(process.env, plan.config);
    } catch (error) {
      // Another chooser (or an earlier choice) already recorded this folder's outline: honour it.
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
  } catch (error) {
    chooser.busy = false;
    chooser.status = error instanceof Error ? error.message : String(error);
    draw();
    return;
  }
  // The popup closes before the panes open; the launcher reports its own failures.
  spawn(process.execPath, relaunchArgs(context.mode, context.clientId), {
    env: relaunchEnvironment(process.env, context.workspaceRoot, context.paneId),
    detached: true,
    stdio: "ignore",
  }).unref();
  await stop();
}

/** Waits for an in-progress choice so a started service always gets its client config. */
function queueStop(exitCode = 0): void {
  workQueue = workQueue.then(() => stop(exitCode), () => stop(exitCode));
}

function apply(intent: ChooserIntent): void {
  if (intent === "close") queueStop();
  else if (intent === "choose") workQueue = workQueue.then(choose).catch(error => {
    chooser.busy = false;
    chooser.status = error instanceof Error ? error.message : String(error);
    draw();
  });
  else if (intent === "changed") draw();
}

initTheme(undefined, false);
terminal.write("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h");
terminal.start(data => {
  try {
    if (isKeyRelease(data)) return;
    if (isTreeMouseSequence(data)) {
      apply(chooserMouse(chooser, data, terminal.columns, terminal.rows));
      return;
    }
    const input = decodePiDetailInput(data);
    if (input.kind === "paste" || input.inputAction === "suppress") return;
    apply(chooserKey(chooser, input.key));
  } catch (error) {
    // Never leave the popup's terminal in the alternate screen with mouse reporting on.
    console.error(error);
    void stop(1);
  }
}, draw);
process.on("SIGINT", () => queueStop(130));
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
