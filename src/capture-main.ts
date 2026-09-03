import { emitKeypressEvents } from "node:readline";
import { OutlinerClient } from "./client";
import {
  CapturePopupController,
  renderCapturePopupFrame,
} from "./capture-popup";
import { resolvePaths } from "./paths";
import {
  BRACKETED_PASTE_DISABLE,
  BRACKETED_PASTE_ENABLE,
  TerminalInputDecoder,
  type TerminalKey,
} from "./terminal";

if (process.env.HERDR_ENV !== "1") {
  throw new Error("Quick capture popup requires Herdr");
}

const paths = resolvePaths();
const client = new OutlinerClient(paths.socket);
const requestId = process.env.OUTLINER_CAPTURE_REQUEST_ID?.trim() || crypto.randomUUID();
const capturedFromBlockId = process.env.OUTLINER_CAPTURE_FROM_BLOCK_ID?.trim() || undefined;
let stopping = false;
let workQueue = Promise.resolve();

function stop(exitCode = 0): void {
  if (stopping) return;
  stopping = true;
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdout.off("resize", draw);
  process.stdout.write(`${BRACKETED_PASTE_DISABLE}\x1b[?25h\x1b[?1049l`);
  process.exit(exitCode);
}

const controller = new CapturePopupController({
  async save(input) {
    await client.request({
      action: "capture.create",
      requestId: input.requestId,
      text: input.text,
      source: "tree",
      capturedFromBlockId: input.capturedFromBlockId,
      author: "user",
    });
  },
  close() {
    stop();
  },
  invalidate() {
    draw();
  },
}, {
  requestId,
  capturedFromBlockId,
});

function draw(): void {
  process.stdout.write(renderCapturePopupFrame(
    controller,
    process.stdout.columns ?? 80,
    process.stdout.rows ?? 20,
  ));
}

function enqueueWork(task: () => void | Promise<void>): void {
  workQueue = workQueue.then(task).catch((error) => {
    controller.status = error instanceof Error ? error.message : String(error);
    draw();
  });
}

const inputDecoder = new TerminalInputDecoder((text) => controller.handlePaste(text));
emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdout.write(`\x1b[?1049h\x1b[?25l${BRACKETED_PASTE_ENABLE}`);
process.stdin.on("keypress", (str: string | undefined, key: TerminalKey) => {
  const text = str ?? "";
  const sequence = key.sequence ?? text;
  if (!sequence && !key.name) return;
  const inputAction = inputDecoder.consume(text, key);
  enqueueWork(() => controller.handleKeypress(text, key, inputAction));
});
process.stdout.on("resize", draw);
process.on("SIGINT", () => stop(130));
process.on("SIGTERM", () => stop(143));
process.on("SIGHUP", () => stop(129));
draw();
