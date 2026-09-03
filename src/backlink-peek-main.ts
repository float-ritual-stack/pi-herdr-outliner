import { emitKeypressEvents } from "node:readline";
import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import {
  BacklinkPeekController,
  renderBacklinkPeekFrame,
  type BacklinkPeekLaunch,
  type BacklinkPeekPreview,
} from "./backlink-peek";
import { OutlinerClient } from "./client";
import { projectedSourceLine } from "./detail-pi-preview";
import { listLiveClients } from "./client-target";
import { visibleBacklinkSources, type DetailBacklinkState } from "./detail-controller";
import { projectDetailRead } from "./detail-embeds";
import { openDetailPane } from "./pane-control";
import { resolvePaths } from "./paths";
import {
  BRACKETED_PASTE_DISABLE,
  BRACKETED_PASTE_ENABLE,
  TerminalInputDecoder,
  type TerminalKey,
} from "./terminal";
import type {
  BacklinkCollection,
  BacklinkSource,
  Block,
  ResolvedBlockReferences,
} from "./types";

if (process.env.HERDR_ENV !== "1") {
  throw new Error("Backlink peek popup requires Herdr");
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseLaunch(): BacklinkPeekLaunch {
  const sortField = requiredEnvironment("OUTLINER_BACKLINK_SORT_FIELD");
  const sortDirection = requiredEnvironment("OUTLINER_BACKLINK_SORT_DIRECTION");
  if (sortField !== "created" && sortField !== "updated") {
    throw new Error("OUTLINER_BACKLINK_SORT_FIELD must be created or updated");
  }
  if (sortDirection !== "asc" && sortDirection !== "desc") {
    throw new Error("OUTLINER_BACKLINK_SORT_DIRECTION must be asc or desc");
  }
  return {
    sourceClientId: requiredEnvironment("OUTLINER_BACKLINK_SOURCE_CLIENT_ID"),
    browsingContextId: requiredEnvironment("OUTLINER_BROWSING_CONTEXT_ID"),
    targetBlockId: requiredEnvironment("OUTLINER_BACKLINK_TARGET_BLOCK_ID"),
    selectedSourceBlockId: requiredEnvironment("OUTLINER_BACKLINK_SELECTED_SOURCE_ID"),
    filter: process.env.OUTLINER_BACKLINK_FILTER ?? "",
    sortField,
    sortDirection,
  };
}

const launch = parseLaunch();
const paths = resolvePaths();
const client = new OutlinerClient(paths.socket);
const collection = await client.request<BacklinkCollection>({
  action: "references.backlinks",
  query: { targetBlockId: launch.targetBlockId, limit: 50 },
});
const backlinkState: DetailBacklinkState = {
  expanded: true,
  loading: false,
  collection,
  selectedIndex: 0,
  error: "",
  filter: launch.filter,
  filterDraft: null,
  sortField: launch.sortField,
  sortDirection: launch.sortDirection,
  expandedSourceIds: new Set(),
};
const sources = visibleBacklinkSources(backlinkState);
if (!sources.some((source) => source.blockId === launch.selectedSourceBlockId)) {
  throw new Error("Selected backlink source is no longer in the filtered snapshot");
}
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

async function sourcePreview(source: BacklinkSource): Promise<BacklinkPeekPreview> {
  const block = await client.request<Block>({ action: "get", blockId: source.blockId });
  const projection = await projectDetailRead(client, block.text, { hostBlockId: block.id });
  const resolved = await client.request<ResolvedBlockReferences>({
    action: "references.resolve",
    text: projection.text,
  });
  const occurrence = source.occurrences[0];
  const authoredSourceLine = occurrence
    ? block.text.slice(0, occurrence.start).split(/\r?\n/).length - 1
    : 0;
  const sourceLine = projectedSourceLine(block.text, projection.embedRanges, authoredSourceLine);
  return { block, text: resolved.text, sourceLine };
}

const controller = new BacklinkPeekController(
  launch.targetBlockId,
  sources,
  launch.selectedSourceBlockId,
  {
    loadSource: sourcePreview,
    async restoreSelection(sourceBlockId) {
      await client.request({
        action: "ui.command.send",
        command: {
          targetClientId: launch.sourceClientId,
          command: "backlinks.select",
          targetBlockId: launch.targetBlockId,
          sourceBlockId,
        },
      });
    },
    async openInSource(sourceBlockId) {
      await client.request({
        action: "ui.command.send",
        command: {
          targetClientId: launch.sourceClientId,
          command: "open",
          blockId: sourceBlockId,
        },
      });
    },
    async openInNewDetail(sourceBlockId) {
      const sourceClient = (await listLiveClients(client, "detail"))
        .find((candidate) => candidate.clientId === launch.sourceClientId);
      if (!sourceClient) throw new Error("Invoking Detail is no longer available");
      const targetPaneId = sourceClient.runtime?.paneId;
      if (!targetPaneId) throw new Error("Invoking Detail has no live Herdr pane");
      const contextId = crypto.randomUUID();
      await client.request({
        action: "browsing-context.publish",
        sourceClientId: launch.sourceClientId,
        contextId,
        blockId: sourceBlockId,
        dispatchPreview: false,
      });
      openDetailPane({
        workspaceRoot: paths.workspaceRoot,
        browsingContextId: contextId,
        targetPaneId,
        direction: "right",
      });
    },
    close() {
      stop();
    },
    invalidate() {
      draw();
    },
  },
);

function draw(): void {
  process.stdout.write(renderBacklinkPeekFrame(
    controller,
    process.stdout.columns ?? 100,
    process.stdout.rows ?? 30,
    getMarkdownTheme(),
  ));
}

function enqueueWork(task: () => void | Promise<void>): void {
  workQueue = workQueue.then(task).catch((error) => {
    controller.status = error instanceof Error ? error.message : String(error);
    draw();
  });
}

initTheme(undefined, false);
const inputDecoder = new TerminalInputDecoder();
emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdout.write(`\x1b[?1049h\x1b[?25l${BRACKETED_PASTE_ENABLE}`);
process.stdin.on("keypress", (str: string | undefined, key: TerminalKey) => {
  const text = str ?? "";
  const sequence = key.sequence ?? text;
  if (!sequence && !key.name) return;
  const action = inputDecoder.consume(text, key);
  enqueueWork(() =>
    controller.handleKeypress(text, key, action, process.stdout.rows ?? 30)
  );
});
process.stdout.on("resize", draw);
process.on("SIGINT", () => stop(130));
process.on("SIGTERM", () => stop(143));
process.on("SIGHUP", () => stop(129));
await controller.initialize();
draw();
