import { initTheme } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, ProcessTerminal } from "@earendil-works/pi-tui";
import { createOutlinerClient } from "./client";
import { decodePiDetailInput } from "./detail-pi-input";
import { GotoController } from "./goto-controller";
import { handleGotoMouse, renderGotoFrame } from "./goto-renderer";
import { OutlinerActionKeymap } from "./outliner-actions";
import { resolveClientPaths } from "./paths";
import { isTreeMouseSequence } from "./tree-mouse";

if (process.env.HERDR_ENV !== "1") throw new Error("Goto popup requires Herdr");
const sourceClientId = process.env.OUTLINER_GOTO_SOURCE_CLIENT_ID?.trim();
if (!sourceClientId) throw new Error("OUTLINER_GOTO_SOURCE_CLIENT_ID is required");

const client = createOutlinerClient(resolveClientPaths());
await client.requireCompatibleService();
const keymap = OutlinerActionKeymap.load();
const terminal = new ProcessTerminal();
let stopping = false;
let workQueue = Promise.resolve();

// The popup is a transient reader, not another registered Tree or Detail.
const controller = new GotoController({
  request: input => client.request(input),
  invalidate: draw,
  close: () => stop(),
  async open(blockId, destination) {
    if (destination === "tree") {
      await client.request({ action: "ui.command.send", command: {
        targetClientId: sourceClientId, targetRegion: "tree", command: "focus",
        target: { kind: "block", blockId },
      } });
    } else {
      await client.request({ action: "navigation.dispatch", sourceClientId,
        target: { kind: "block", blockId }, intent: "open" });
    }
    await stop();
  },
});

function draw(): void {
  if (stopping) return;
  terminal.write("\x1b[H\x1b[2J" + renderGotoFrame(controller, terminal.columns, terminal.rows,
    keymap.helpText("tree", "goto")).join("\r\n"));
}

function enqueue(task: () => void | Promise<void>): void {
  workQueue = workQueue.then(async () => { if (!stopping) await task(); }).catch(error => {
    controller.status = error instanceof Error ? error.message : String(error);
    draw();
  });
}

async function stop(exitCode = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  controller.dispose();
  await terminal.drainInput();
  terminal.stop();
  terminal.write("\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l");
  process.exit(exitCode);
}

initTheme(undefined, false);
// Keyboard protocol state belongs to the active screen buffer. Enter it first.
terminal.write("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h");
terminal.start(data => {
  if (isKeyRelease(data)) return;
  if (isTreeMouseSequence(data)) {
    enqueue(() => handleGotoMouse(controller, data, terminal.columns, terminal.rows));
    return;
  }
  // ProcessTerminal already assembles complete keys and bracketed pastes.
  const input = decodePiDetailInput(data);
  if (input.kind === "paste") { enqueue(() => controller.paste(input.text)); return; }
  if (input.inputAction === "suppress") return;
  const mapped = keymap.canonicalize("tree", "goto", input.str, input.key);
  if (mapped.suppressed) return;
  enqueue(() => mapped.actionId === "tree.close" || (mapped.key.ctrl && mapped.key.name === "c")
    ? controller.cancel()
    : controller.input(mapped.str, mapped.key));
}, draw);
process.on("SIGINT", () => void stop(130));
process.on("SIGTERM", () => void stop(143));
process.on("SIGHUP", () => void stop(129));
controller.start();
