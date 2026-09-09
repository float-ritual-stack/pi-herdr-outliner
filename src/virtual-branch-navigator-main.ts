import { emitKeypressEvents } from "node:readline";
import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { OutlinerClient } from "./client";
import { listLiveClients } from "./client-target";
import { projectDetailRead } from "./detail-embeds";
import type { DetailReadPreviewDocument } from "./detail-pi-preview";
import { OutlinerActionKeymap } from "./outliner-actions";
import { currentPaneRuntime, openDetailPane } from "./pane-control";
import { resolvePaths } from "./paths";
import { ALL_DETAILS_LOCKED_ERROR } from "./navigation-routes";
import { openDestinationTimeoutFromEnvironment } from "./open-destination-chooser";
import { blockDisplayTitle } from "./references";
import {
  BRACKETED_PASTE_DISABLE,
  BRACKETED_PASTE_ENABLE,
  TerminalInputDecoder,
  type TerminalKey,
} from "./terminal";
import { isTreeMouseSequence } from "./tree-mouse";
import type {
  Block,
  BookmarkResolution,
  BookmarkRemoveReceipt,
  OutlinerClientRole,
  ResolvedBlockReferences,
  VisibleBlockCollection,
  WorkspaceSnapshot,
} from "./types";
import {
  bookmarkProjectionRows,
  VirtualBranchNavigatorController,
  renderVirtualBranchNavigatorFrame,
  type VirtualBranchNavigatorLaunch,
  type VirtualBranchNavigatorPreview,
  type VirtualBranchNavigatorRenderResult,
} from "./virtual-branch-navigator";
import {
  isVirtualBranchDefinition,
  projectVirtualBranches,
  type TreePresentationState,
  type VirtualBranchOccurrenceRow,
} from "./virtual-branches";

if (process.env.HERDR_ENV !== "1") {
  throw new Error("Virtual branch navigator popup requires Herdr");
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseLaunch(): VirtualBranchNavigatorLaunch {
  const sourceRole = requiredEnvironment("OUTLINER_NAVIGATOR_SOURCE_ROLE");
  if (sourceRole !== "tree" && sourceRole !== "detail") {
    throw new Error("OUTLINER_NAVIGATOR_SOURCE_ROLE must be tree or detail");
  }
  const adapter = process.env.OUTLINER_NAVIGATOR_ADAPTER?.trim();
  if (adapter && adapter !== "bookmark") {
    throw new Error("OUTLINER_NAVIGATOR_ADAPTER must be bookmark when provided");
  }
  return {
    sourceClientId: requiredEnvironment("OUTLINER_NAVIGATOR_SOURCE_CLIENT_ID"),
    sourceRole: sourceRole satisfies OutlinerClientRole,
    browsingContextId: requiredEnvironment("OUTLINER_BROWSING_CONTEXT_ID"),
    viewId: requiredEnvironment("OUTLINER_NAVIGATOR_VIEW_ID"),
    ...(adapter === "bookmark" ? { adapter } : {}),
  };
}

const launch = parseLaunch();
const paths = resolvePaths();
const client = new OutlinerClient(paths.socket);
const actionKeymap = OutlinerActionKeymap.load();
const destinationTimeoutMs = openDestinationTimeoutFromEnvironment(
  process.env.OUTLINER_OPEN_DESTINATION_TIMEOUT_MS,
);
let stopping = false;
let workQueue = Promise.resolve();
let rendered: VirtualBranchNavigatorRenderResult | null = null;
let stopWatcher: (() => Promise<void>) | null = null;

async function loadProjection(presentation: TreePresentationState) {
  const snapshot = await client.request<WorkspaceSnapshot>({ action: "workspace.snapshot" });
  const definition = snapshot.physical.blocks.find((block) => block.id === launch.viewId);
  if (!definition) throw new Error(`Virtual branch not found: ${launch.viewId}`);
  if (!isVirtualBranchDefinition(definition)) {
    throw new Error(`Block is not a virtual branch: ${launch.viewId}`);
  }
  const definitions = (launch.adapter === "bookmark"
    ? [definition]
    : snapshot.physical.blocks.filter(isVirtualBranchDefinition))
    .map((block) => ({ ...block, depth: 0 }));
  const projection = await projectVirtualBranches(
    definitions,
    snapshot.physical.blocks,
    (query) => client.request<VisibleBlockCollection>({
      action: "blocks.query",
      query: launch.adapter === "bookmark"
        ? { ...query, subtreeRootId: launch.viewId }
        : query,
    }),
    snapshot.virtualOccurrenceRanks,
    presentation,
  );
  const definitionIndex = projection.rows.findIndex(
    (row) => row.kind === "physical" && row.canonicalId === launch.viewId,
  );
  if (definitionIndex < 0) throw new Error(`Virtual branch projection unavailable: ${launch.viewId}`);
  const rows: VirtualBranchOccurrenceRow[] = [];
  for (const row of projection.rows.slice(definitionIndex + 1)) {
    if (row.kind === "physical") break;
    rows.push(row);
  }
  const state = projection.branchStates.get(launch.viewId);
  if (!state) throw new Error(`Virtual branch state unavailable: ${launch.viewId}`);
  const projectedRows = launch.adapter === "bookmark"
    ? bookmarkProjectionRows(rows, snapshot.physical.blocks, launch.viewId)
    : rows;
  const projectedState = launch.adapter === "bookmark"
    ? {
        ...state,
        count: projectedRows.filter((row) => row.relativeDepth === 0).length,
        descendantCount: projectedRows.filter((row) => row.relativeDepth > 0).length,
      }
    : state;
  return { title: blockDisplayTitle(definition), rows: projectedRows, state: projectedState };
}

async function loadDetailPreviewDocument(block: Block): Promise<DetailReadPreviewDocument> {
  const projection = await projectDetailRead(client, block.text, { hostBlockId: block.id });
  const resolved = await client.request<ResolvedBlockReferences>({
    action: "references.resolve",
    text: projection.text,
  });
  return {
    canonicalText: block.text,
    resolvedText: resolved.text,
    projectedText: projection.text,
    embedRanges: projection.embedRanges,
    workIdPrefix: resolved.workIdPrefix ?? null,
  };
}

async function loadPreview(
  row: VirtualBranchOccurrenceRow,
): Promise<VirtualBranchNavigatorPreview> {
  if (launch.adapter === "bookmark" && row.relativeDepth === 0) {
    const resolution = await client.request<BookmarkResolution>({
      action: "bookmarks.resolve",
      recordId: row.matchRootCanonicalId,
    });
    if (!resolution.target) {
      const unavailableReason = resolution.unavailableReason;
      const text = `${blockDisplayTitle(resolution.record)}\n\n> ${unavailableReason}`;
      return {
        document: {
          canonicalText: text,
          resolvedText: text,
          projectedText: text,
          embedRanges: [],
          workIdPrefix: null,
        },
        target: null,
        unavailableReason,
      };
    }
    return {
      document: await loadDetailPreviewDocument(resolution.target),
      target: {
        blockId: resolution.target.id,
        title: blockDisplayTitle(resolution.target),
      },
    };
  }
  const block = await client.request<Block>({ action: "get", blockId: row.canonicalId });
  return {
    document: await loadDetailPreviewDocument(block),
    target: { blockId: block.id, title: blockDisplayTitle(block) },
  };
}

const controller = new VirtualBranchNavigatorController(launch.sourceRole, {
  loadProjection: (collapsedOccurrenceRowIds) =>
    loadProjection({
      collapsedBlockIds: new Set(),
      collapsedOccurrenceRowIds,
      multilineExpandedRowIds: new Set(),
    }),
  loadPreview,
  async replaceTarget(blockId) {
    if (launch.sourceRole !== "detail") {
      throw new Error("Replace is available only from a Detail-launched navigator");
    }
    await client.request({
      action: "ui.command.send",
      command: { targetClientId: launch.sourceClientId, command: "replace", blockId },
    });
  },
  async openInFirstUnlocked(blockId) {
    try {
      await client.request({
        action: "navigation.dispatch",
        sourceClientId: launch.sourceClientId,
        blockId,
        intent: "open",
      });
      return true;
    } catch (error) {
      if (error instanceof Error && error.message === ALL_DETAILS_LOCKED_ERROR) return false;
      throw error;
    }
  },
  async openInNewDetail(blockId, direction) {
    const sourceClient = (await listLiveClients(client))
      .find((candidate) => candidate.clientId === launch.sourceClientId);
    if (!sourceClient) throw new Error("Invoking Outliner client is no longer available");
    const targetPaneId = sourceClient.runtime?.paneId;
    if (!targetPaneId) throw new Error("Invoking Outliner client has no live Herdr pane");
    const contextId = crypto.randomUUID();
    await client.request({
      action: "browsing-context.publish",
      sourceClientId: launch.sourceClientId,
      contextId,
      blockId,
      dispatchPreview: false,
    });
    openDetailPane({
      workspaceRoot: paths.workspaceRoot,
      browsingContextId: contextId,
      targetPaneId,
      direction,
    });
  },
  async revealSource(blockId) {
    await client.request({
      action: "navigation.dispatch",
      sourceClientId: launch.sourceClientId,
      blockId,
      intent: "reveal",
      focusTarget: true,
    });
  },
  ...(launch.adapter === "bookmark"
    ? {
      async removeSelectedRecord(row: VirtualBranchOccurrenceRow) {
        if (row.relativeDepth !== 0) {
          throw new Error("Select the bookmark record row to remove it");
        }
        const resolution = await client.request<BookmarkResolution>({
          action: "bookmarks.resolve",
          recordId: row.matchRootCanonicalId,
        });
        await client.request<BookmarkRemoveReceipt>({
          action: "bookmarks.remove",
          recordId: resolution.record.id,
          expectedUpdatedAt: resolution.record.updatedAt,
        });
      },
    }
    : {}),
  close() {
    stop();
  },
  invalidate() {
    draw();
  },
}, { destinationTimeoutMs, actionKeymap });

function draw(): void {
  rendered = renderVirtualBranchNavigatorFrame(
    controller,
    process.stdout.columns ?? 100,
    process.stdout.rows ?? 30,
    getMarkdownTheme(),
  );
  process.stdout.write(rendered.frame);
}

function enqueueWork(task: () => void | Promise<void>): void {
  workQueue = workQueue.then(task).catch((error) => {
    controller.status = error instanceof Error ? error.message : String(error);
    draw();
  });
}

function stop(exitCode = 0): void {
  if (stopping) return;
  stopping = true;
  void stopWatcher?.();
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdout.off("resize", draw);
  process.stdout.write(`${BRACKETED_PASTE_DISABLE}\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l`);
  process.exit(exitCode);
}

initTheme(undefined, false);
const inputDecoder = new TerminalInputDecoder();
emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdout.write(`\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h${BRACKETED_PASTE_ENABLE}`);
process.stdin.on("keypress", (str: string | undefined, key: TerminalKey) => {
  const text = str ?? "";
  const sequence = key.sequence ?? text;
  if (!sequence && !key.name) return;
  const clickedFrame = rendered;
  if (isTreeMouseSequence(sequence) && clickedFrame) {
    enqueueWork(() => controller.handleMouse(sequence, clickedFrame));
    return;
  }
  const action = inputDecoder.consume(text, key);
  enqueueWork(() => controller.handleKeypress(
    text,
    key,
    action,
    process.stdout.rows ?? 30,
    (process.stdout.columns ?? 100) < 84,
  ));
});
process.stdout.on("resize", draw);
process.on("SIGINT", () => stop(130));
process.on("SIGTERM", () => stop(143));
process.on("SIGHUP", () => stop(129));

try {
  await controller.initialize();
  const navigatorClientId = `navigator-${crypto.randomUUID()}`;
  const watcher = client.watch({
    client: {
      clientId: navigatorClientId,
      role: "detail",
      contextId: launch.browsingContextId,
      locked: true,
      runtime: currentPaneRuntime(),
    },
    onConnect: () => {
      enqueueWork(async () => {
        if (controller.status.startsWith("Refresh unavailable:")) controller.status = "";
        await controller.refresh();
      });
    },
    onEvent: (event) => {
      if (event.domain === "content" || event.domain === "view") {
        enqueueWork(() => controller.refresh());
      }
    },
    onError: (error) => {
      enqueueWork(() => {
        controller.status = `Refresh unavailable: ${error.message}`;
        draw();
      });
    },
  });
  stopWatcher = () => watcher.stop();
  draw();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  stop(1);
}
