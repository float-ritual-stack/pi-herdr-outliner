import {attachCaptureInput} from './capture-input';
import {referenceCompletionProvider} from './reference-completion';
import {parseTreePlainClick,treeLinkAtClick} from './tree-mouse';
import { reportCurrentPaneWorkspace } from "./pane-control";
import { createOutlinerClient } from "./client";
import {
  CapturePopupController,
  renderCapturePopupFrame,
} from "./capture-popup";
import { resolveClientPaths } from "./paths";
import {
  BRACKETED_PASTE_DISABLE,
  BRACKETED_PASTE_ENABLE,
} from "./terminal";
import type { QuickCaptureDraft, WorkIdAllocatorStatus } from "./types";

if (process.env.HERDR_ENV !== "1") {
  throw new Error("Quick capture popup requires Herdr");
}

const paths = resolveClientPaths();
reportCurrentPaneWorkspace(paths.workspaceRoot);
const client = createOutlinerClient(paths);
await client.requireCompatibleService();
const requestId = process.env.OUTLINER_CAPTURE_REQUEST_ID?.trim() || crypto.randomUUID();
const capturedFromBlockId = process.env.OUTLINER_CAPTURE_FROM_BLOCK_ID?.trim() || undefined;
const draft = await client.request<QuickCaptureDraft | null>({ action: "capture.draft.get" });
const workIds=await client.request<WorkIdAllocatorStatus>({action:'work-ids.status'});
let detachInput:(()=>void)|undefined;
let renderedLines:string[]=[];
let stopping = false;
let workQueue = Promise.resolve();

function stop(exitCode = 0): void {
  if (stopping) return;
  stopping = true;
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdout.off("resize", draw);
  detachInput?.();
  process.stdout.write(`${BRACKETED_PASTE_DISABLE}\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l`);
  process.exit(exitCode);
}

let shutdownRequested = false;
function stopAfterRetainingDraft(exitCode: number): void {
  if (shutdownRequested || stopping) return;
  shutdownRequested = true;
  workQueue = workQueue
    .then(() => controller.retainDraft())
    .finally(() => stop(exitCode));
}

const controller = new CapturePopupController({
  completionProvider:referenceCompletionProvider(client,"capture"),
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
  async persistDraft(input) {
    return await client.request<QuickCaptureDraft>({
      action: "capture.draft.save",
      input,
    });
  },
  async clearDraft(expectedRevision) {
    await client.request({
      action: "capture.draft.clear",
      expectedRevision,
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
  workIdPrefix:workIds.prefix,
  capturedFromBlockId,
  draft: draft ?? undefined,
});

function draw(): void {
  const frame=renderCapturePopupFrame(
    controller,
    process.stdout.columns ?? 80,
    process.stdout.rows ?? 20,
  );
  renderedLines=frame.replace(/^\x1b\[H\x1b\[2J/,"").split("\n");
  process.stdout.write(frame);
}

function enqueueWork(task: () => void | Promise<void>): void {
  workQueue = workQueue.then(task).catch((error) => {
    controller.status = error instanceof Error ? error.message : String(error);
    draw();
  });
}

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdout.write(`\x1b[?1049h\x1b[?25l${BRACKETED_PASTE_ENABLE}\x1b[?1000h\x1b[?1006h`);
detachInput=attachCaptureInput(process.stdin,{
 keypress:(text,key,action)=>enqueueWork(()=>controller.handleKeypress(text,key,action)),
 paste:text=>enqueueWork(()=>controller.handlePaste(text)),
 mouse:sequence=>{
  if(!parseTreePlainClick(sequence))return;
  const uri=treeLinkAtClick(renderedLines,sequence);
  const match=uri?.match(/^pi-outliner-action:completion.choose:(\d+):(\d+)$/);
  if(match)enqueueWork(()=>controller.chooseCompletion(Number(match[1]),Number(match[2])));
 },
});
process.stdout.on("resize", draw);
process.on("SIGINT", () => stopAfterRetainingDraft(130));
process.on("SIGTERM", () => stopAfterRetainingDraft(143));
process.on("SIGHUP", () => stopAfterRetainingDraft(129));
draw();
