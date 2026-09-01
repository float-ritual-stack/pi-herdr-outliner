import { execFile, spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { formatFileAnnotation } from "../src/annotations";
import {
  focusBlockByQuery,
  formatBlockFocusMatch,
  resolveBlockFocus,
} from "../src/block-focus";
import {
  BlockQuerySyntaxError,
  parsePropertyFilterExpression,
} from "../src/block-query";
import { parseStandaloneDispatchMarker } from "../src/dispatch-marker";
import { OutlinerClient } from "../src/client";
import { HerdrRuntimeRegistry } from "../src/herdr-registry";
import { HerdrRegistryRunner } from "../src/herdr-runtime";
import { resolvePaths } from "../src/paths";
import { currentPaneIdentity } from "../src/pane-control";
import { getProperty, parsePropertyRecords } from "../src/properties";
import { blockDisplayTitle } from "../src/references";
import {
  containsWorkIdPlaceholder,
  formatWorkIdPlaceholder,
} from "../src/work-ids";
import {
  OUTLINER_PROTOCOL_VERSION,
  type Block,
  type BlockEditActivityPage,
  type BlockProvenance,
  type BrowsingContextState,
  type CaptureReceipt,
  type CaptureSource,
  type OutlinerClientRegistration,
  type OutlinerServiceStatus,
  type MutationProvenance,
  type PropertyCatalogItem,
  type PageAddressResolution,
  type PropertyPatchOperation,
  type SelectionContext,
  type RoadmapItemCreateReceipt,
  type VirtualOccurrenceRank,
  type VisibleBlockCollection,
  type WorkIdAllocatorStatus,
  type WorkspaceSnapshot,
} from "../src/types";

const execFileAsync = promisify(execFile);
const extensionRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const paths = resolvePaths();
const client = new OutlinerClient(paths.socket);
let headlessServer: ChildProcess | null = null;

export type OutlinerHostActorId = "omp" | "pi";

function toolProvenance(
  actorId: OutlinerHostActorId,
  context: ExtensionContext,
  toolCallId: string,
): BlockProvenance {
  return {
    actorId,
    sessionId: context.sessionManager.getSessionId(),
    taskId: toolCallId,
  };
}

function agentMutation(
  actorId: OutlinerHostActorId,
  context: ExtensionContext,
  taskId?: string,
): MutationProvenance {
  return {
    author: "agent",
    actorId,
    sessionId: context.sessionManager.getSessionId(),
    ...(taskId ? { taskId } : {}),
  };
}

function hostCaptureSource(actorId: OutlinerHostActorId): CaptureSource {
  return actorId;
}

export function latestAssistantResponse(entries: readonly unknown[]): string | null {
  let startIndex = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      "type" in entry &&
      entry.type === "message" &&
      "message" in entry &&
      entry.message &&
      typeof entry.message === "object" &&
      !Array.isArray(entry.message) &&
      "role" in entry.message &&
      entry.message.role === "user"
    ) {
      startIndex = index + 1;
      break;
    }
  }

  const segments: string[] = [];
  for (let index = startIndex; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || !("type" in entry)) continue;
    if (
      entry.type === "custom_message" &&
      "customType" in entry &&
      entry.customType === "advisor" &&
      segments.length > 0
    ) break;
    if (entry.type !== "message" || !("message" in entry)) continue;
    const message = entry.message;
    if (
      !message ||
      typeof message !== "object" ||
      Array.isArray(message) ||
      !("role" in message) ||
      message.role !== "assistant" ||
      !("content" in message)
    ) continue;
    const content = message.content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.flatMap((part) => {
          if (
            !part ||
            typeof part !== "object" ||
            Array.isArray(part) ||
            !("type" in part) ||
            part.type !== "text" ||
            !("text" in part) ||
            typeof part.text !== "string"
          ) return [];
          return [part.text];
        }).join("")
        : "";
    if (text.trim()) segments.push(text.trim());
  }
  return segments.length > 0 ? segments.join("\n\n") : null;
}


function compactCaptureReceipt(receipt: CaptureReceipt, source: CaptureSource) {
  const capturedFromBlockId = receipt.block.properties.find(
    (property) => property.key === "captured-from",
  )?.value;
  return {
    blockId: receipt.block.id,
    inboxBlockId: receipt.inboxBlockId,
    source,
    ...(capturedFromBlockId ? { capturedFromBlockId } : {}),
    deduplicated: receipt.deduplicated,
  };
}

async function selectedBlockId(): Promise<string | undefined> {
  const selection = await client.request<SelectionContext>({ action: "selection.get" });
  return selection.selected?.id;
}

const propertyPatchOperationSchema = Type.Union([
  Type.Object({
    op: Type.Literal("replace"),
    ordinal: Type.Integer({ minimum: 0 }),
    key: Type.Optional(Type.String()),
    value: Type.String(),
  }),
  Type.Object({
    op: Type.Literal("remove"),
    ordinal: Type.Integer({ minimum: 0 }),
  }),
  Type.Object({
    op: Type.Literal("append"),
    key: Type.String(),
    value: Type.String(),
  }),
]);

const MAX_TOOL_RESULT_CHARS = 12_000;
const WORK_PLACEHOLDER_SKILL = "work-placeholder-resolver";
const OUTLINER_CAPTURE_RECEIPT_ENTRY = "outliner-capture-receipt";

interface OutlinerCaptureReceiptEntry {
  blockId: string;
  title: string;
  source: CaptureSource;
  deduplicated: boolean;
  detail: "opened" | "no-tree" | "unavailable";
  capturedAt: number;
}

export { containsWorkIdPlaceholder as containsConfiguredWorkPlaceholder } from "../src/work-ids";

export function formatWorkPlaceholderNudge(prefix: string): string {
  return [
    `Work placeholder detected (${formatWorkIdPlaceholder(prefix)}).`,
    `Use the ${WORK_PLACEHOLDER_SKILL} skill: search existing work first;`,
    "reuse and connect one confident match, otherwise create and allocate;",
    "then optimistically replace only the exact marker.",
    "Ambiguous or failed resolution leaves XXX unchanged.",
    "Detection alone never mutates canonical state.",
  ].join(" ");
}

function textToolResult(text: string): AgentToolResult<Record<string, never>> {
  return {
    content: [{ type: "text", text }],
    details: {},
  };
}

function toolResult<T>(value: T): AgentToolResult<T> {
  const text = JSON.stringify(value, null, 2);
  return {
    content: [{
      type: "text",
      text: text.length > MAX_TOOL_RESULT_CHARS ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n…` : text,
    }],
    details: value,
  };
}

function textualToolResult(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((item): item is { type: "text"; text: string } =>
      item.type === "text" && typeof item.text === "string"
    )
    .map((item) => item.text)
    .join("\n");
}

function queryDetails(
  collection: VisibleBlockCollection,
  blocks: VisibleBlockCollection["blocks"],
) {
  return {
    blocks,
    completeness: collection.completeness,
    presentation: {
      returned: collection.blocks.length,
      presented: blocks.length,
      omitted: collection.blocks.length - blocks.length,
    },
  };
}

function serializeQueryResult(
  collection: VisibleBlockCollection,
  blocks: VisibleBlockCollection["blocks"],
): string {
  return JSON.stringify(queryDetails(collection, blocks), null, 2);
}

function queryToolResult(collection: VisibleBlockCollection) {
  const blocks: VisibleBlockCollection["blocks"] = [];
  let text = serializeQueryResult(collection, blocks);
  for (const block of collection.blocks) {
    blocks.push(block);
    const candidate = serializeQueryResult(collection, blocks);
    if (candidate.length > MAX_TOOL_RESULT_CHARS) {
      blocks.pop();
      break;
    }
    text = candidate;
  }
  return {
    content: [{ type: "text" as const, text }],
    details: queryDetails(collection, blocks),
  };
}


function firstDisplayLine(value: unknown, limit = 72): string {
  if (typeof value !== "string") return "";
  const line = value.split("\n", 1)[0]?.trim() ?? "";
  return line.length <= limit ? line : `${line.slice(0, limit - 1)}…`;
}

function shortBlockId(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 8) : "";
}

function summarizeToolDetails(details: unknown): { text: string; tone: "success" | "warning" | "muted" } {
  if (Array.isArray(details)) {
    return { text: `${details.length} ${details.length === 1 ? "item" : "items"}`, tone: "success" };
  }
  if (!details || typeof details !== "object") return { text: "Completed", tone: "success" };
  const value = details as Record<string, unknown>;

  if (value.presentation && typeof value.presentation === "object") {
    const presentation = value.presentation as Record<string, unknown>;
    const completeness = value.completeness && typeof value.completeness === "object"
      ? value.completeness as Record<string, unknown>
      : undefined;
    const count = typeof presentation.returned === "number" ? presentation.returned : 0;
    const omitted = presentation.omitted;
    const suffix = completeness?.kind === "truncated" || (typeof omitted === "number" && omitted > 0)
      ? " · bounded"
      : " · complete";
    return { text: `${count} ${count === 1 ? "match" : "matches"}${suffix}`, tone: "success" };
  }

  if (typeof value.focused === "boolean") {
    if (!value.focused) {
      const resolution = typeof value.resolution === "string" ? ` · ${value.resolution}` : "";
      return { text: `Not focused${resolution}`, tone: "warning" };
    }
    const title = firstDisplayLine(value.title);
    return {
      text: `Focused${title ? ` · ${title}` : ""}${value.blockId ? ` · ${shortBlockId(value.blockId)}` : ""}`,
      tone: "success",
    };
  }

  if (value.selected && typeof value.selected === "object") {
    const selected = value.selected as Record<string, unknown>;
    const title = firstDisplayLine(selected.text);
    return {
      text: `Selected${title ? ` · ${title}` : ""}${selected.id ? ` · ${shortBlockId(selected.id)}` : ""}`,
      tone: "success",
    };
  }
  if ("selected" in value && value.selected === null) {
    return { text: "No selection", tone: "muted" };
  }

  if (typeof value.workId === "string") {
    const state = [value.stage, value.status].filter((item) => typeof item === "string").join(" · ");
    return { text: `${value.workId}${state ? ` · ${state}` : ""}`, tone: "success" };
  }

  if (typeof value.id === "string") {
    const title = firstDisplayLine(value.text) || firstDisplayLine(value.title);
    return {
      text: `${title || "Block"} · ${shortBlockId(value.id)}`,
      tone: "success",
    };
  }

  if (typeof value.blockId === "string") {
    const title = firstDisplayLine(value.title);
    return {
      text: `${title || "Block"} · ${shortBlockId(value.blockId)}`,
      tone: "success",
    };
  }

  if (typeof value.status === "string") {
    return { text: value.status, tone: value.status === "missing" ? "warning" : "success" };
  }
  return { text: "Completed", tone: "success" };
}
function summarizeToolCall(args: object): string {
  const value = args as Record<string, unknown>;
  const operation = typeof value.operation === "string" ? value.operation : "";
  const target = firstDisplayLine(value.query) ||
    firstDisplayLine(value.address) ||
    shortBlockId(value.blockId) ||
    firstDisplayLine(value.text);
  if (operation && target) return `${operation} · ${target}`;
  if (operation) return operation;
  if (target) return target;
  if (Array.isArray(value.filters)) return `${value.filters.length} filters`;
  if (typeof value.role === "string") return value.role;
  return "";
}

function renderOutlinerResult(
  result: AgentToolResult<unknown>,
  { expanded, isPartial }: ToolRenderResultOptions,
  theme: Theme,
) {
  if (isPartial) return new Text(theme.fg("warning", "Working…"), 0, 0);
  const summary = summarizeToolDetails(result.details);
  let text = theme.fg(summary.tone, summary.text);
  if (expanded) {
    const emptyDetails = result.details !== null &&
      typeof result.details === "object" &&
      !Array.isArray(result.details) &&
      Object.keys(result.details).length === 0;
    const serialized = emptyDetails
      ? textualToolResult(result.content)
      : JSON.stringify(result.details, null, 2);
    const lines = serialized.split("\n");
    for (const line of lines.slice(0, 24)) text += `\n${theme.fg("dim", line)}`;
    if (lines.length > 24) text += `\n${theme.fg("muted", `… ${lines.length - 24} more lines`)}`;
  }
  return new Text(text, 0, 0);
}

function outlinerToolPresentation(label: string) {
  return {
    renderCall(args: object, theme: Theme) {
      const summary = summarizeToolCall(args);
      const text = theme.fg("toolTitle", theme.bold(label)) +
        (summary ? theme.fg("dim", ` · ${summary}`) : "");
      return new Text(text, 0, 0);
    },
    renderResult: renderOutlinerResult,
  };
}

function assertCompatibleProtocol(service: OutlinerServiceStatus): void {
  if (service.protocolVersion !== OUTLINER_PROTOCOL_VERSION) {
    throw new Error(
      `Outliner protocol ${service.protocolVersion} does not match this session's extension protocol ${OUTLINER_PROTOCOL_VERSION}. Run /reload, then retry.`,
    );
  }
}

async function pingService(timeoutMs: number): Promise<void> {
  const service = await client.request<OutlinerServiceStatus>({ action: "ping" }, timeoutMs);
  assertCompatibleProtocol(service);
}

async function waitForService(timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await pingService(400);
      return;
    } catch (error) {
      lastError = error;
      await sleep(100);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Outliner service did not start");
}

async function ensureService(focus: boolean): Promise<void> {
  const service = await client
    .request<OutlinerServiceStatus>({ action: "ping" }, 300)
    .catch(() => null);
  if (service) {
    assertCompatibleProtocol(service);
    if (!focus || process.env.HERDR_ENV !== "1") return;
  }

  if (process.env.HERDR_ENV === "1") {
    await execFileAsync("bun", [
      "run",
      join(extensionRoot, "src", "herdr-open.ts"),
      "--mode",
      focus ? "focus-or-open" : "service-only",
    ], {
      cwd: paths.workspaceRoot,
      env: {
        ...process.env,
        HERDR_PLUGIN_ID: "float.pi-outliner",
        OUTLINER_WORKSPACE_ROOT: paths.workspaceRoot,
      },
    });
  } else if (!headlessServer) {
    headlessServer = spawn("bun", ["run", join(extensionRoot, "src", "server-main.ts")], {
      cwd: extensionRoot,
      stdio: "ignore",
      env: { ...process.env, OUTLINER_WORKSPACE_ROOT: paths.workspaceRoot },
    });
  }
  await waitForService();
}

const MAX_SELECTION_CONTEXT_CHARS = 4_000;
const ACTIVE_TASK_ENTRY_TYPE = "pi-outliner.active-task";
const ACTIVITY_WATERMARK_ENTRY_TYPE = "pi-outliner.activity-watermark";
const INITIAL_ACTIVITY_HORIZON_MS = 7 * 24 * 60 * 60 * 1_000;
const OUTLINER_PRESENCE_SOURCE = "float.pi-outliner.agent";
const OUTLINER_PRESENCE_TTL_MS = 600_000;
const HERDR_METADATA_DIAGNOSTIC_LIMIT = 512;
let herdrMetadataSequence = 0;

function reportHerdrMetadataFailure(error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  const diagnostic = `Pi Outliner Herdr metadata unavailable: ${reason}`;
  console.error(
    diagnostic.length <= HERDR_METADATA_DIAGNOSTIC_LIMIT
      ? diagnostic
      : `${diagnostic.slice(0, HERDR_METADATA_DIAGNOSTIC_LIMIT - 1)}…`,
  );
}

type DurableArtifactType =
  | "field-note"
  | "finding"
  | "decision"
  | "implementation-proof"
  | "synthesis"
  | "roadmap-review"
  | "progress";

interface ActiveTaskEntryData {
  version: 1;
  blockId: string | null;
}

interface ActivityWatermarkEntryData {
  version: 1;
  cursor: number;
}

function restoredActivityCursor(entries: readonly unknown[]): number | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (record.type !== "custom" || record.customType !== ACTIVITY_WATERMARK_ENTRY_TYPE) continue;
    const data = record.data;
    if (typeof data !== "object" || data === null) return null;
    const state = data as Partial<ActivityWatermarkEntryData>;
    return state.version === 1 && Number.isSafeInteger(state.cursor) && (state.cursor ?? -1) >= 0
      ? state.cursor!
      : null;
  }
  return null;
}

function restoredActiveTaskId(entries: readonly unknown[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (record.type !== "custom" || record.customType !== ACTIVE_TASK_ENTRY_TYPE) continue;
    const data = record.data;
    if (typeof data !== "object" || data === null) return null;
    const state = data as Partial<ActiveTaskEntryData>;
    if (state.version !== 1) return null;
    return typeof state.blockId === "string" && state.blockId.length > 0
      ? state.blockId
      : null;
  }
  return null;
}

function workId(block: Block): string | undefined {
  return getProperty(block.properties, "work-id");
}

function requireRoadmapTask(block: Block): string {
  if (getProperty(block.properties, "type") !== "roadmap-item") {
    throw new Error(`Block is not a roadmap item: ${block.id}`);
  }
  const identifier = workId(block);
  if (!identifier) throw new Error(`Roadmap item has no Work ID: ${block.id}`);
  return identifier;
}

export function selectRecentFocusedOutlinerClient(
  clients: readonly OutlinerClientRegistration[],
  recentPaneIds: readonly string[],
): OutlinerClientRegistration | undefined {
  const clientsByPaneId = new Map(
    clients.flatMap((registration) =>
      registration.runtime?.paneId ? [[registration.runtime.paneId, registration] as const] : []
    ),
  );
  for (const paneId of recentPaneIds) {
    const registration = clientsByPaneId.get(paneId);
    if (registration) return registration;
  }
  return undefined;
}

function boundAgentContext(content: string): string {
  if (content.length <= MAX_SELECTION_CONTEXT_CHARS) return content;
  const suffix = "\n… context truncated; use outliner tools for full text.";
  return content.slice(0, MAX_SELECTION_CONTEXT_CHARS - suffix.length) + suffix;
}

function propertyTransition(
  block: Block,
  key: string,
  value: string,
): PropertyPatchOperation {
  let ordinal: number | undefined;
  for (const property of parsePropertyRecords(block.text)) {
    if (property.scope !== "block" || property.key !== key) continue;
    if (ordinal !== undefined) {
      throw new Error(`Roadmap item has duplicate [${key}::…] properties: ${block.id}`);
    }
    ordinal = property.ordinal;
  }
  return ordinal === undefined
    ? { op: "append", key, value }
    : { op: "replace", ordinal, value };
}

function formatContext(
  context: SelectionContext,
  options: {
    heading: string;
    selectedLabel: string;
    dependencies?: readonly Block[];
    includeContent?: boolean;
    workflowReminder?: boolean;
  },
): string {
  const { selected } = context;
  if (!selected) return "";
  const selectedTitle = `[${selected.id}] ${blockDisplayTitle(selected)}`;
  const path = [...context.ancestors, selected].map(blockDisplayTitle).join(" > ");
  const properties = selected.properties
    .slice(0, 20)
    .map((property) => `${property.key}=${property.value}`)
    .join(", ");
  const selectedContent = options.includeContent
    ? selected.text.length <= 2_400
      ? selected.text
      : `${selected.text.slice(0, 2_400)}\n… focused block body truncated`
    : "";
  const children = context.children
    .slice(0, 20)
    .map((block) => `- [${block.id}] ${blockDisplayTitle(block)}`)
    .join("\n");
  const dependencies = options.dependencies
    ?.slice(0, 8)
    .map((block) => {
      const status = getProperty(block.properties, "status");
      return `- [${block.id}] ${blockDisplayTitle(block)}${status ? ` · status=${status}` : ""}`;
    })
    .join("\n");
  return boundAgentContext([
    options.heading,
    `${options.selectedLabel}: ${selectedTitle}`,
    `Path: ${path}`,
    properties ? `Properties: ${properties}` : "Properties: none",
    selectedContent ? `Content:\n${selectedContent}` : "",
    dependencies ? `Dependencies:\n${dependencies}` : "",
    children ? `Children:\n${children}` : "Children: none",
    "Use outliner_selection/outliner_query for additional block text.",
    options.workflowReminder
      ? "Workflow: publish durable plans, roadmap reviews, findings, decisions, handoffs, and proof with outliner_publish; keep ordinary conversational explanation in chat. Use outliner_focus to present the relevant block before narrating it. Never infer task completion from agent lifecycle events."
      : "",
  ].filter(Boolean).join("\n"));
}

export function formatSelection(context: SelectionContext): string {
  return formatContext(context, {
    heading: "Outliner workspace context:",
    selectedLabel: "Selected",
    includeContent: true,
  });
}

function formatActiveTask(
  context: SelectionContext,
  dependencies: readonly Block[],
): string {
  return formatContext(context, {
    heading: "Outliner active task context:",
    selectedLabel: "Active task",
    dependencies,
    workflowReminder: true,
  });
}

function formatFocusedPane(context: SelectionContext): string {
  return formatContext(context, {
    heading: "Outliner last-focused pane context:",
    selectedLabel: "Focused block",
    includeContent: true,
    workflowReminder: true,
  });
}

async function resolveRoadmapTask(address: string): Promise<Block> {
  const symbolic = await client.request<PageAddressResolution>({
    action: "pages.resolve",
    address,
  });
  if (symbolic.status === "resolved" && symbolic.block) {
    requireRoadmapTask(symbolic.block);
    return symbolic.block;
  }
  if (symbolic.status === "deleted") {
    throw new Error(`Task address resolves to a block in Trash: ${address}`);
  }
  const snapshot = await client.request<WorkspaceSnapshot>({ action: "workspace.snapshot" });
  const resolution = resolveBlockFocus(snapshot.physical.blocks, address, 10);
  if (resolution.kind === "none") throw new Error(`No block matches task address: ${address}`);
  if (resolution.kind === "ambiguous") {
    const candidates = resolution.matches
      .slice(0, 5)
      .map((match) => formatBlockFocusMatch(match, match.block.id))
      .join("\n");
    throw new Error(`Ambiguous task address; retry with a full UUID:\n${candidates}`);
  }
  requireRoadmapTask(resolution.match.block);
  return resolution.match.block;
}

async function focusOutlinerAddress(
  query: string,
  limit: number,
  targetClientId?: string,
) {
  const symbolic = await client.request<PageAddressResolution>({
    action: "pages.resolve",
    address: query,
  });
  if (symbolic.status === "deleted") {
    throw new Error(`Outliner address resolves to a block in Trash: ${query}`);
  }
  return focusBlockByQuery(
    client,
    symbolic.status === "resolved" && symbolic.block ? symbolic.block.id : query,
    limit,
    targetClientId,
  );
}

function durableArtifactText(
  text: string,
  type: DurableArtifactType,
  parentId: string | null,
): string {
  const body = text.trim();
  if (!body) throw new Error("Durable artifact text cannot be empty");
  const metadata = [`[type::${type}]`];
  if (parentId) metadata.push(`[source-block::${parentId}]`);
  return `${body}\n${metadata.join(" ")}`;
}

async function reportHerdrTask(
  task: Block | null,
  activity: "working" | "idle" | "clear",
): Promise<boolean> {
  if (process.env.HERDR_ENV !== "1") return false;
  let paneId: string;
  try {
    const identity = currentPaneIdentity();
    if (!identity?.paneId) throw new Error("Current Herdr pane identity is unavailable");
    paneId = identity.paneId;
  } catch (error) {
    reportHerdrMetadataFailure(error);
    return false;
  }
  const args = [
    "pane",
    "report-metadata",
    paneId,
    "--source",
    OUTLINER_PRESENCE_SOURCE,
    "--seq",
    String(++herdrMetadataSequence),
  ];
  if (task && activity !== "clear") {
    args.push(
      "--token",
      `task=${workId(task) ?? task.id.slice(0, 8)}`,
      "--token",
      `task-id=${task.id}`,
      "--token",
      `activity=${activity}`,
      "--ttl-ms",
      String(OUTLINER_PRESENCE_TTL_MS),
    );
  } else {
    args.push(
      "--clear-token",
      "task",
      "--clear-token",
      "task-id",
      "--clear-token",
      "activity",
    );
  }
  try {
    await execFileAsync(process.env.HERDR_BIN_PATH ?? "herdr", args, {
      cwd: paths.workspaceRoot,
      timeout: 1_000,
    });
    return true;
  } catch (error) {
    reportHerdrMetadataFailure(error);
    return false;
  }
}

export function createOutlinerExtension(actorId: OutlinerHostActorId) {
  return function outlinerExtension(pi: ExtensionAPI): void {
  let activeTaskId: string | null = null;
  let focusRegistry: HerdrRuntimeRegistry | null = null;
  let activityCursor: number | null = null;
  let focusRunner: HerdrRegistryRunner | null = null;
  let workPlaceholderNudgedThisTurn = false;

  if (typeof (pi as { registerEntryRenderer?: unknown }).registerEntryRenderer === "function") {
    pi.registerEntryRenderer<OutlinerCaptureReceiptEntry>(
      OUTLINER_CAPTURE_RECEIPT_ENTRY,
      (entry, { expanded }, theme) => {
        const data = entry.data;
        if (!data) return new Text(theme.fg("warning", "Outliner capture receipt unavailable"), 0, 0);
        const detail = data.detail === "opened"
          ? "opened in Detail"
          : data.detail === "no-tree"
            ? "saved; no unambiguous Tree"
            : "saved; Detail unavailable";
        let text = `${theme.fg("accent", theme.bold("Outliner"))} ` +
          theme.fg("success", `${data.deduplicated ? "Reused" : "Sent"} response to Inbox`) +
          theme.fg("dim", ` · ${shortBlockId(data.blockId)} · ${detail}`);
        if (expanded) {
          text += `\n${theme.fg("text", data.title)}`;
          text += `\n${theme.fg("dim", `Block: ${data.blockId}`)}`;
          text += `\n${theme.fg("dim", `Source: ${data.source}`)}`;
          text += `\n${theme.fg("dim", `Captured: ${new Date(data.capturedAt).toLocaleString()}`)}`;
        }
        return new Text(text, 0, 0);
      },
    );
  }

  function startFocusTracker(): void {
    const socketPath = process.env.HERDR_SOCKET_PATH;
    if (!socketPath || focusRunner) return;
    focusRegistry = new HerdrRuntimeRegistry();
    focusRunner = new HerdrRegistryRunner(focusRegistry, socketPath, {
      diagnostic: () => {},
      eventTypes: ["pane.focused"],
      includePaneAgentStatus: false,
      replayQuietMs: 25,
      replayMaxMs: 500,
    });
    focusRunner.start();
  }

  async function displayCapturedResponse(blockId: string): Promise<boolean> {
    const trees = await client.request<OutlinerClientRegistration[]>({
      action: "clients.list",
      role: "tree",
    });
    const recent = focusRegistry
      ? selectRecentFocusedOutlinerClient(trees, focusRegistry.recentFocusedPaneIds())
      : undefined;
    const target = recent ?? (trees.length === 1 ? trees[0] : undefined);
    if (!target) return false;
    await client.request({ action: "selection.set", blockId });
    await client.request({
      action: "ui.command.send",
      command: { targetClientId: target.clientId, command: "focus", blockId },
    });
    await client.request({
      action: "navigation.dispatch",
      sourceClientId: target.clientId,
      blockId,
      intent: "open",
    });
    return true;
  }

  function persistActiveTask(blockId: string | null): void {
    activeTaskId = blockId;
    pi.appendEntry<ActiveTaskEntryData>(ACTIVE_TASK_ENTRY_TYPE, { version: 1, blockId });
  }

  async function currentTask(): Promise<Block | null> {
    if (!activeTaskId) return null;
    return client.request<Block>({ action: "get", blockId: activeTaskId });
  }

  async function presentTask(
    context: ExtensionContext,
    task: Block | null,
    activity: "working" | "idle" | "clear",
  ): Promise<boolean> {
    context.ui.setStatus("pi-outliner-task", task ? workId(task) ?? task.id.slice(0, 8) : undefined);
    return reportHerdrTask(task, activity);
  }

  async function startTask(address: string, context: ExtensionContext) {
    await ensureService(false);
    const task = await resolveRoadmapTask(address);
    if (activeTaskId && activeTaskId !== task.id) {
      const active = await currentTask();
      throw new Error(
        `Another task is active in this session: ${active ? workId(active) ?? active.id : activeTaskId}. Pause, complete, or clear it before switching.`,
      );
    }
    const stage = getProperty(task.properties, "work-stage");
    if (stage === "done" || stage === "complete") {
      throw new Error(`Cannot start completed task: ${workId(task) ?? task.id}`);
    }
    const updated = stage === "doing"
      ? task
      : await client.request<Block>({
        action: "properties.patch",
        blockId: task.id,
        expectedUpdatedAt: task.updatedAt,
        operations: [propertyTransition(task, "work-stage", "doing")],
        mutation: agentMutation(actorId, context, "outliner-task:start"),
      });
    persistActiveTask(updated.id);
    const activity = context.isIdle?.() === false ? "working" : "idle";
    const presenceReported = await presentTask(context, updated, activity);
    return {
      blockId: updated.id,
      workId: requireRoadmapTask(updated),
      stage: getProperty(updated.properties, "work-stage"),
      presenceReported,
    };
  }

  async function pauseTask(context: ExtensionContext) {
    await ensureService(false);
    const task = await currentTask();
    if (!task) throw new Error("No active Outliner task");
    const updated = await client.request<Block>({
      action: "properties.patch",
      blockId: task.id,
      expectedUpdatedAt: task.updatedAt,
      operations: [propertyTransition(task, "work-stage", "next")],
      mutation: agentMutation(actorId, context, "outliner-task:pause"),
    });
    persistActiveTask(null);
    const presenceReported = await presentTask(context, null, "clear");
    return {
      blockId: updated.id,
      workId: requireRoadmapTask(updated),
      stage: getProperty(updated.properties, "work-stage"),
      presenceReported,
    };
  }

  async function clearTask(context: ExtensionContext) {
    const previousBlockId = activeTaskId;
    persistActiveTask(null);
    const presenceReported = await presentTask(context, null, "clear");
    return { previousBlockId, presenceReported };
  }

  async function completeTask(proofBlockId: string, context: ExtensionContext) {
    await ensureService(false);
    const task = await currentTask();
    if (!task) throw new Error("No active Outliner task");
    const proof = await client.request<Block>({ action: "get", blockId: proofBlockId });
    if (proof.effectiveDeletedRootId) throw new Error(`Proof block is in Trash: ${proof.id}`);
    const linkedProof = proof.parentId === task.id ||
      proof.properties.some((property) =>
        property.key === "source-block" && property.value === task.id
      );
    if (!linkedProof) {
      throw new Error(`Proof block must be a child of or reference the active task: ${task.id}`);
    }
    const operations: PropertyPatchOperation[] = [
      propertyTransition(task, "status", "complete"),
      propertyTransition(task, "work-stage", "done"),
    ];
    if (!task.properties.some((property) => property.key === "proof" && property.value === proof.id)) {
      operations.push({ op: "append", key: "proof", value: proof.id });
    }
    const updated = await client.request<Block>({
      action: "properties.patch",
      blockId: task.id,
      expectedUpdatedAt: task.updatedAt,
      operations,
      mutation: agentMutation(actorId, context, "outliner-task:complete"),
    });
    persistActiveTask(null);
    const presenceReported = await presentTask(context, null, "clear");
    return {
      blockId: updated.id,
      workId: requireRoadmapTask(updated),
      stage: getProperty(updated.properties, "work-stage"),
      status: getProperty(updated.properties, "status"),
      proofBlockId: proof.id,
      presenceReported,
    };
  }

  async function activeTaskContext(): Promise<string> {
    if (!activeTaskId) return "";
    const context = await client.request<SelectionContext>({
      action: "blocks.context",
      blockId: activeTaskId,
    }, 250);
    const dependencyIds = context.selected?.properties
      .filter((property) => property.key === "depends-on")
      .map((property) => property.value)
      .slice(0, 8) ?? [];
    const dependencies = (
      await Promise.all(
        dependencyIds.map((blockId) =>
          client.request<Block>({ action: "get", blockId }, 250).catch(() => null)
        ),
      )
    ).filter((block): block is Block => block !== null);
    return formatActiveTask(context, dependencies);
  }

  async function lastFocusedPaneContext(): Promise<SelectionContext | null> {
    if (!focusRegistry || focusRegistry.phase !== "ready") return null;
    const clients = await client.request<OutlinerClientRegistration[]>({
      action: "clients.list",
    }, 250);
    const focusedClient = selectRecentFocusedOutlinerClient(
      clients,
      focusRegistry.recentFocusedPaneIds(),
    );
    if (!focusedClient) return null;
    if (focusedClient.currentBlockId) {
      return client.request<SelectionContext>({
        action: "blocks.context",
        blockId: focusedClient.currentBlockId,
      }, 250);
    }
    const browsing = await client.request<BrowsingContextState>({
      action: "browsing-context.get",
      contextId: focusedClient.contextId,
    }, 250);
    return browsing.target.selected ? browsing.target : null;
  }

  async function agentWorkspaceContext(): Promise<string> {
    const focused = await lastFocusedPaneContext();
    if (focused?.selected) {
      const sections = [formatFocusedPane(focused)];
      if (activeTaskId && activeTaskId !== focused.selected.id) {
        const task = await currentTask();
        if (task) {
          const taskProperties = [
            getProperty(task.properties, "status") && `status=${getProperty(task.properties, "status")}`,
            getProperty(task.properties, "work-stage") &&
            `work-stage=${getProperty(task.properties, "work-stage")}`,
          ].filter(Boolean).join(", ");
          sections.push(
            `Session active task (separate from the focused block): [${task.id}] ${blockDisplayTitle(task)}${taskProperties ? ` · ${taskProperties}` : ""}`,
          );
        }
      }
      return boundAgentContext(sections.join("\n\n"));
    }
    if (activeTaskId) return activeTaskContext();
    return formatSelection(
      await client.request<SelectionContext>({ action: "selection.get" }, 250),
    );
  }

  async function recentUserActivityContext(): Promise<string> {
    const focused = await lastFocusedPaneContext();
    const selected = focused?.selected ?? (
      activeTaskId
        ? null
        : (await client.request<SelectionContext>({ action: "selection.get" }, 250)).selected
    );
    const excluded = new Set(
      [selected?.id, activeTaskId].filter((id): id is string => Boolean(id)),
    );
    const request = activityCursor === null
      ? {
          action: "activity.recent" as const,
          since: new Date(Date.now() - INITIAL_ACTIVITY_HORIZON_MS).toISOString(),
          limit: 5,
          author: "user" as const,
        }
      : {
          action: "activity.recent" as const,
          afterCursor: activityCursor,
          limit: 5,
          author: "user" as const,
        };
    const activity = await client.request<BlockEditActivityPage>(request, 250);
    if (activity.cursor !== activityCursor) {
      activityCursor = activity.cursor;
      pi.appendEntry<ActivityWatermarkEntryData>(ACTIVITY_WATERMARK_ENTRY_TYPE, {
        version: 1,
        cursor: activity.cursor,
      });
    }
    const entries = activity.entries
      .filter((entry) => !excluded.has(entry.block.id))
      .map((entry) => {
        const summary = entry.kind === "properties" && entry.block.properties.length > 0
          ? entry.block.properties
            .slice(0, 4)
            .map((property) => `${property.key}=${property.value}`)
            .join(", ")
          : entry.block.text.replace(/\s+/g, " ").trim().slice(0, 240);
        return `- [${entry.block.id}] ${blockDisplayTitle(entry.block)} · edited ${entry.editedAt}${summary ? ` · ${summary}` : ""}`;
      });
    return entries.length > 0
      ? `Recently user-edited Outliner blocks:\n${entries.join("\n")}`
      : "";
  }

  async function selectedAgentBlockText(): Promise<string> {
    const focused = await lastFocusedPaneContext();
    if (focused?.selected) return focused.selected.text;
    if (activeTaskId) return (await currentTask())?.text ?? "";
    const selection = await client.request<SelectionContext>({ action: "selection.get" }, 250);
    return selection.selected?.text ?? "";
  }

  pi.on("resources_discover", () => ({
    skillPaths: [
      join(extensionRoot, "pi-extension", "skills", "outliner-workflow", "SKILL.md"),
      join(
        extensionRoot,
        "pi-extension",
        "skills",
        WORK_PLACEHOLDER_SKILL,
        "SKILL.md",
      ),
    ],
    promptPaths: [
      join(extensionRoot, "pi-extension", "prompts", "roadmap-item.md"),
      join(extensionRoot, "pi-extension", "prompts", "roadmap-report.md"),
    ],
  }));

  pi.on("session_start", async (_event, context) => {
    startFocusTracker();
    const sessionEntries = context.sessionManager.getBranch();
    activeTaskId = restoredActiveTaskId(sessionEntries);
    activityCursor = restoredActivityCursor(sessionEntries);
    if (!activeTaskId) {
      await presentTask(context, null, "clear");
      return;
    }
    try {
      await ensureService(false);
      const task = await currentTask();
      if (task) await presentTask(context, task, "idle");
    } catch {
      context.ui.setStatus("pi-outliner-task", activeTaskId.slice(0, 8));
    }
  });
  pi.registerCommand("outliner", {
    description: "Open or focus the persistent Herdr outliner pane",
    handler: async (_args, ctx) => {
      try {
        await ensureService(true);
        ctx.ui.notify("Outliner ready", "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("outliner-task", {
    description: "Start, inspect, pause, complete, or clear the session-scoped Outliner task",
    handler: async (args, context) => {
      const [operation = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      try {
        if (operation === "status") {
          await ensureService(false);
          const task = await currentTask();
          context.ui.notify(
            task
              ? `Active Outliner task: ${workId(task) ?? task.id.slice(0, 8)} · ${blockDisplayTitle(task)}`
              : "No active Outliner task",
            "info",
          );
          return;
        }
        if (operation === "start") {
          const address = rest.join(" ");
          if (!address) throw new Error("Usage: /outliner-task start <Work ID, block ID, or title>");
          const result = await startTask(address, context);
          context.ui.notify(`Started ${result.workId}`, "info");
          return;
        }
        if (operation === "pause") {
          const result = await pauseTask(context);
          context.ui.notify(`Paused ${result.workId}; returned it to Next`, "info");
          return;
        }
        if (operation === "complete") {
          const proofBlockId = rest[0];
          if (!proofBlockId) {
            throw new Error("Usage: /outliner-task complete <proof-block-id>");
          }
          const result = await completeTask(proofBlockId, context);
          context.ui.notify(`Completed ${result.workId}`, "info");
          return;
        }
        if (operation === "clear") {
          await clearTask(context);
          context.ui.notify("Cleared the session task without changing roadmap metadata", "info");
          return;
        }
        throw new Error(
          "Usage: /outliner-task [status|start <address>|pause|complete <proof-block-id>|clear]",
        );
      } catch (error) {
        context.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("capture", {
    description: "Capture text to the shared Inbox without starting an agent turn",
    handler: async (args, ctx) => {
      const text = args.trim();
      if (!text) {
        ctx.ui.notify("Usage: /capture <text>", "warning");
        return;
      }
      try {
        await ensureService(false);
        const source = hostCaptureSource(actorId);
        const receipt = await client.request<CaptureReceipt>({
          action: "capture.create",
          requestId: crypto.randomUUID(),
          text,
          source,
          capturedFromBlockId: await selectedBlockId(),
          author: "user",
        });
        const summary = compactCaptureReceipt(receipt, source);
        ctx.ui.notify(
          `${receipt.deduplicated ? "Capture already saved" : "Captured to Inbox"} · ${summary.blockId.slice(0, 8)}`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("send-to-outline", {
    description: "Save the latest assistant response to Inbox and open it in Detail",
    handler: async (_args, context) => {
      const text = latestAssistantResponse(context.sessionManager.getBranch());
      if (!text) {
        context.ui.notify("No assistant response is available to send", "warning");
        return;
      }
      try {
        await ensureService(false);
        const sessionId = context.sessionManager.getSessionId();
        const source = hostCaptureSource(actorId);
        const receipt = await client.request<CaptureReceipt>({
          action: "capture.create",
          requestId: crypto.randomUUID(),
          text,
          source,
          author: "agent",
          provenance: {
            actorId: actorId,
            sessionId,
            ...(activeTaskId ? { taskId: activeTaskId } : {}),
          },
        });
        let detail: OutlinerCaptureReceiptEntry["detail"] = "unavailable";
        try {
          await ensureService(true);
          const displayed = await displayCapturedResponse(receipt.block.id);
          detail = displayed ? "opened" : "no-tree";
          context.ui.notify(
            displayed
              ? `Sent latest response to Inbox and opened it in Detail · ${receipt.block.id.slice(0, 8)}`
              : `Sent latest response to Inbox · ${receipt.block.id.slice(0, 8)} · no unambiguous Tree was available`,
            displayed ? "info" : "warning",
          );
        } catch (error) {
          context.ui.notify(
            `Sent latest response to Inbox · ${receipt.block.id.slice(0, 8)} · Detail unavailable: ${
              error instanceof Error ? error.message : String(error)
            }`,
            "warning",
          );
        }
        pi.appendEntry<OutlinerCaptureReceiptEntry>(OUTLINER_CAPTURE_RECEIPT_ENTRY, {
          blockId: receipt.block.id,
          title: firstDisplayLine(text, 120),
          source,
          deduplicated: receipt.deduplicated,
          detail,
          capturedAt: Date.now(),
        });
      } catch (error) {
        context.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("outliner-goto", {
    description: "Focus a block by full ID, short ID prefix, or fuzzy text",
    handler: async (args, ctx) => {
      const query = args.trim();
      if (!query) {
        ctx.ui.notify("Usage: /outliner-goto <block-id, short prefix, or text>", "warning");
        return;
      }
      try {
        await ensureService(true);
        const result = await focusOutlinerAddress(query, 10);
        if (result.resolution.kind === "none") {
          ctx.ui.notify(`No block matches: ${query}`, "warning");
          return;
        }
        if (result.resolution.kind === "ambiguous") {
          const candidates = result.resolution.matches
            .slice(0, 5)
            .map((match) => formatBlockFocusMatch(match, match.block.id))
            .join("\n");
          ctx.ui.notify(`Ambiguous block query; retry with a full UUID:\n${candidates}`, "warning");
          return;
        }
        const match = result.resolution.match;
        ctx.ui.notify(`Focused ${formatBlockFocusMatch(match)}`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("outliner-filter", {
    description:
      'Preview blocks matching AND property filters such as type=question status="in progress"',
    handler: async (args, ctx) => {
      await ensureService(false);
      try {
        const filters = parsePropertyFilterExpression(args);
        const { blocks, completeness } = await client.request<VisibleBlockCollection>({
          action: "blocks.query",
          query: { filters, limit: 20 },
        });
        const lines = blocks.length
          ? blocks.map((block) => `${"  ".repeat(block.depth)}• ${block.text}`)
          : ["No matching blocks"];
        if (completeness.kind === "truncated") {
          lines.push(`Results truncated at ${completeness.limit} blocks`);
        }
        ctx.ui.setWidget("pi-outliner-filter", lines, { placement: "belowEditor" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const label = error instanceof BlockQuerySyntaxError ? "Invalid filter" : "Filter failed";
        ctx.ui.setWidget("pi-outliner-filter", [`${label}: ${message}`], {
          placement: "belowEditor",
        });
      }
    },
  });

  pi.registerTool({
    ...outlinerToolPresentation("Outliner Task"),
    name: "outliner_task",
    label: "Outliner Task",
    description:
      "Manage the explicit session-scoped roadmap task; completion requires a linked proof block",
    promptSnippet: "Start, inspect, pause, complete, or clear the active Outliner task",
    parameters: Type.Object({
      operation: Type.Union([
        Type.Literal("status"),
        Type.Literal("start"),
        Type.Literal("pause"),
        Type.Literal("complete"),
        Type.Literal("clear"),
      ]),
      address: Type.Optional(
        Type.String({ description: "Work ID, block ID, or title required for start" }),
      ),
      proofBlockId: Type.Optional(
        Type.String({ description: "Linked proof block required for complete" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, context) {
      if (params.operation === "status") {
        await ensureService(false);
        const task = await currentTask();
        return toolResult(task
          ? {
            blockId: task.id,
            workId: requireRoadmapTask(task),
            stage: getProperty(task.properties, "work-stage"),
            status: getProperty(task.properties, "status"),
          }
          : { blockId: null });
      }
      if (params.operation === "start") {
        if (!params.address) throw new Error("outliner_task start requires address");
        return toolResult(await startTask(params.address, context));
      }
      if (params.operation === "pause") {
        return toolResult(await pauseTask(context));
      }
      if (params.operation === "complete") {
        if (!params.proofBlockId) {
          throw new Error("outliner_task complete requires proofBlockId");
        }
        return toolResult(await completeTask(params.proofBlockId, context));
      }
      return toolResult(await clearTask(context));
    },
  });

  pi.registerTool({
    ...outlinerToolPresentation("Outliner Focus"),
    name: "outliner_focus",
    label: "Outliner Focus",
    description:
      "Focus a block in an explicit or unique live Tree client and return bounded structural context",
    promptSnippet: "Present an Outliner block before narrating or handing it to the user",
    parameters: Type.Object({
      query: Type.String({ description: "Full ID, short ID prefix, symbolic title, or fuzzy text" }),
      clientId: Type.Optional(
        Type.String({ description: "Required when more than one Tree client is live" }),
      ),
    }),
    async execute(_toolCallId, params) {
      await ensureService(true);
      const result = await focusOutlinerAddress(params.query, 10, params.clientId);
      if (result.resolution.kind !== "match") {
        return toolResult({
          focused: false,
          resolution: result.resolution.kind,
          candidates: result.resolution.matches.map((match) => ({
            blockId: match.block.id,
            title: match.title,
            kind: match.kind,
          })),
        });
      }
      const block = result.resolution.match.block;
      const context = await client.request<SelectionContext>({
        action: "blocks.context",
        blockId: block.id,
      });
      return toolResult({
        focused: true,
        blockId: block.id,
        title: result.resolution.match.title,
        matchKind: result.resolution.match.kind,
        context: formatSelection(context),
      });
    },
  });

  pi.registerTool({
    ...outlinerToolPresentation("Outliner Publish"),
    name: "outliner_publish",
    label: "Outliner Publish",
    description:
      "Publish a durable typed workspace artifact beneath the active task or explicit parent and optionally focus it",
    promptSnippet:
      "Publish plans, roadmap reviews, findings, decisions, progress, syntheses, and implementation proof to the Outliner",
    parameters: Type.Object({
      text: Type.String({ description: "Authored artifact body without generated metadata" }),
      type: Type.Union([
        Type.Literal("field-note"),
        Type.Literal("finding"),
        Type.Literal("decision"),
        Type.Literal("implementation-proof"),
        Type.Literal("synthesis"),
        Type.Literal("roadmap-review"),
        Type.Literal("progress"),
      ]),
      parentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      focus: Type.Optional(Type.Boolean({ description: "Defaults to true" })),
      clientId: Type.Optional(
        Type.String({ description: "Tree client to focus when multiple clients are live" }),
      ),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, context) {
      await ensureService(false);
      const parentId = params.parentId !== undefined
        ? params.parentId
        : activeTaskId ?? await selectedBlockId() ?? null;
      const block = await client.request<Block>({
        action: "create",
        text: durableArtifactText(params.text, params.type, parentId),
        parentId,
        author: "agent",
        provenance: toolProvenance(actorId, context, toolCallId),
      });
      if (params.focus === false) {
        return toolResult({
          blockId: block.id,
          parentId,
          type: params.type,
          focused: false,
        });
      }
      try {
        await ensureService(true);
        const focused = await focusOutlinerAddress(block.id, 10, params.clientId);
        return toolResult({
          blockId: block.id,
          parentId,
          type: params.type,
          focused: focused.focused,
        });
      } catch (error) {
        return toolResult({
          blockId: block.id,
          parentId,
          type: params.type,
          focused: false,
          focusError: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });

  pi.registerTool({
    ...outlinerToolPresentation("Outliner Create"),
    name: "outliner_create",
    label: "Outliner Create",
    description: "Create a durable outliner block for a note, progress update, open question, decision, or artifact",
    promptSnippet: "Create a durable block in the shared outliner workspace",
    parameters: Type.Object({
      text: Type.String({ description: "Block text, optionally containing [property::value] markers" }),
      parentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, context) {
      await ensureService(false);
      const block = await client.request<Block>({
        action: "create",
        text: params.text,
        parentId: params.parentId,
        author: "agent",
        provenance: toolProvenance(actorId, context, toolCallId),
      });
      return toolResult(block);
    },
  });

  pi.registerTool({
    ...outlinerToolPresentation("Outliner Roadmap Create"),
    name: "outliner_roadmap_create",
    label: "Outliner Roadmap Create",
    description:
      "Atomically create a canonical roadmap item under the project's work queue with an immutable Work ID and complete routing metadata",
    promptSnippet:
      "Create roadmap work atomically; default new work to unprioritized unless promotion was explicitly requested",
    parameters: Type.Object({
      title: Type.String({ description: "Concise title without a Work ID or property tokens" }),
      body: Type.Optional(Type.String({ description: "Detailed contract, context, and acceptance criteria" })),
      priority: Type.Union([
        Type.Literal("high"),
        Type.Literal("medium"),
        Type.Literal("low"),
      ]),
      workStage: Type.Optional(Type.Union([
        Type.Literal("unprioritized"),
        Type.Literal("next"),
        Type.Literal("doing"),
        Type.Literal("review"),
        Type.Literal("validate"),
        Type.Literal("later"),
      ])),
      project: Type.String(),
      arc: Type.String(),
      tracks: Type.Array(Type.String(), { minItems: 1 }),
      dependsOn: Type.Optional(Type.Array(Type.String())),
      relatedTo: Type.Optional(Type.Array(Type.String())),
      sourceBlockId: Type.Optional(Type.String()),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, context) {
      await ensureService(false);
      const receipt = await client.request<RoadmapItemCreateReceipt>({
        action: "roadmap.items.create",
        input: params,
        author: "agent",
        provenance: toolProvenance(actorId, context, toolCallId),
      });
      return toolResult(receipt);
    },
  });

  pi.registerTool({
    ...outlinerToolPresentation("Outliner Branch Rank"),
    name: "outliner_branch_rank",
    label: "Outliner Branch Rank",
    description:
      "Replace the explicit occurrence order for a virtual branch without moving canonical blocks or changing work-stage",
    promptSnippet:
      "Rank roadmap items inside a virtual lane or track separately from canonical hierarchy and stage",
    parameters: Type.Object({
      viewId: Type.String({ description: "Canonical virtual-branch block UUID" }),
      orderedBlockIds: Type.Array(Type.String(), {
        minItems: 1,
        description:
          "Canonical block UUIDs in desired relative order; omitted existing ranks retain their relative slots",
      }),
    }),
    async execute(_id, params) {
      await ensureService(false);
      const ranks = await client.request<VirtualOccurrenceRank[]>({
        action: "virtual.occurrences.reorder",
        viewId: params.viewId,
        orderedBlockIds: params.orderedBlockIds,
      });
      return toolResult({ viewId: params.viewId, ranks });
    },
  });

  pi.registerTool({
    ...outlinerToolPresentation("Outliner Capture"),
    name: "outliner_capture",
    label: "Outliner Capture",
    description: "Capture durable text to the shared Inbox without routing or changing selection",
    promptSnippet: "Capture text to the shared outliner Inbox",
    parameters: Type.Object({
      text: Type.String(),
      requestId: Type.Optional(Type.String()),
      capturedFromBlockId: Type.Optional(Type.String()),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, context) {
      await ensureService(false);
      const source = hostCaptureSource(actorId);
      const receipt = await client.request<CaptureReceipt>({
        action: "capture.create",
        requestId:
          params.requestId ?? `${context.sessionManager.getSessionId()}:${toolCallId}`,
        text: params.text,
        source,
        capturedFromBlockId: params.capturedFromBlockId ?? await selectedBlockId(),
        author: "agent",
        provenance: toolProvenance(actorId, context, toolCallId),
      });
      return toolResult(compactCaptureReceipt(receipt, source));
    },
  });

  pi.registerTool({
    ...outlinerToolPresentation("Outliner Annotate File"),
    name: "outliner_annotate_file",
    label: "Outliner Annotate File",
    description: "Attach a durable line-range comment beneath a file-reference block",
    promptSnippet: "Annotate specific lines of a referenced text or Markdown file",
    parameters: Type.Object({
      sourceBlockId: Type.String({ description: "Block containing the [file::path] property" }),
      startLine: Type.Integer({ minimum: 1 }),
      endLine: Type.Integer({ minimum: 1 }),
      comment: Type.String(),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, context) {
      await ensureService(false);
      const source = await client.request<Block>({ action: "get", blockId: params.sourceBlockId });
      const filePath = getProperty(source.properties, "file");
      if (!filePath) throw new Error(`Block has no [file::path] property: ${source.id}`);
      const text = formatFileAnnotation({ ...params, filePath });
      const annotation = await client.request<Block>({
        action: "create",
        parentId: source.id,
        text,
        author: "agent",
        provenance: toolProvenance(actorId, context, toolCallId),
      });
      return toolResult(annotation);
    },
  });

  pi.registerTool({
    ...outlinerToolPresentation("Outliner Update"),
    name: "outliner_update",
    label: "Outliner Update",
    description: "Update an existing outliner block only if it is still the version the agent read",
    promptSnippet: "Optimistically update a shared outliner block using its updatedAt version",
    parameters: Type.Object({
      blockId: Type.String(),
      text: Type.String(),
      expectedUpdatedAt: Type.String(),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, context) {
      await ensureService(false);
      return toolResult(
        await client.request<Block>({
          action: "update",
          blockId: params.blockId,
          text: params.text,
          expectedUpdatedAt: params.expectedUpdatedAt,
          mutation: agentMutation(actorId, context, toolCallId),
        }),
      );
    },
  });

  pi.registerTool({
    ...outlinerToolPresentation("Outliner Property Patch"),
    name: "outliner_property_patch",
    label: "Outliner Property Patch",
    description: "Replace, remove, or append property tokens without rewriting unrelated block prose",
    promptSnippet: "Patch indexed outliner properties with optimistic concurrency",
    parameters: Type.Object({
      blockId: Type.String(),
      expectedUpdatedAt: Type.String(),
      operations: Type.Array(propertyPatchOperationSchema, { minItems: 1 }),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, context) {
      await ensureService(false);
      return toolResult(
        await client.request<Block>({
          action: "properties.patch",
          blockId: params.blockId,
          expectedUpdatedAt: params.expectedUpdatedAt,
          operations: params.operations,
          mutation: agentMutation(actorId, context, toolCallId),
        }),
      );
    },
  });

  pi.registerTool({
    ...outlinerToolPresentation("Outliner Property Catalog"),
    name: "outliner_property_catalog",
    label: "Outliner Property Catalog",
    description:
      "List observed property key/value pairs with occurrence counts; defaults to block metadata",
    promptSnippet: "Inspect observed outliner property keys and values by scope",
    parameters: Type.Object({
      key: Type.Optional(Type.String()),
      prefix: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      propertyScope: Type.Optional(
        Type.Union([
          Type.Literal("block"),
          Type.Literal("line"),
          Type.Literal("inline"),
          Type.Literal("all"),
        ]),
      ),
    }),
    async execute(_id, params) {
      await ensureService(false);
      return toolResult(
        await client.request<PropertyCatalogItem[]>({
          action: "properties.catalog",
          ...params,
        }),
      );
    },
  });

  pi.registerTool({
    ...outlinerToolPresentation("Outliner Page"),
    name: "outliner_page",
    label: "Outliner Page Address",
    description: "Resolve, follow, complete, rename, alias, or remove a unique symbolic page address",
    promptSnippet: "Use the shared symbolic page-address registry",
    parameters: Type.Object({
      operation: Type.Union([
        Type.Literal("resolve"),
        Type.Literal("follow"),
        Type.Literal("complete"),
        Type.Literal("rename"),
        Type.Literal("alias"),
        Type.Literal("remove"),
      ]),
      address: Type.Optional(
        Type.String({ description: "Required for resolve, follow, rename, alias, and remove" }),
      ),
      blockId: Type.Optional(Type.String({ description: "Required for rename, alias, and remove" })),
      expectedUpdatedAt: Type.Optional(
        Type.String({ description: "Required for rename and remove" }),
      ),
      query: Type.Optional(Type.String({ description: "Optional substring filter for complete" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, context) {
      await ensureService(false);
      const requireField = (value: string | undefined, field: string): string => {
        if (value === undefined || value === "") {
          throw new Error(`outliner_page ${params.operation} requires ${field}`);
        }
        return value;
      };
      switch (params.operation) {
        case "resolve":
          return toolResult(await client.request({
            action: "pages.resolve",
            address: requireField(params.address, "address"),
          }));
        case "follow":
          return toolResult(await client.request({
            action: "pages.follow",
            address: requireField(params.address, "address"),
            author: "agent",
            provenance: toolProvenance(actorId, context, toolCallId),
          }));
        case "complete":
          return toolResult(await client.request({
            action: "pages.complete",
            query: params.query,
            limit: params.limit ?? 50,
          }));
        case "rename":
          return toolResult(await client.request({
            action: "pages.rename",
            blockId: requireField(params.blockId, "blockId"),
            address: requireField(params.address, "address"),
            expectedUpdatedAt: requireField(params.expectedUpdatedAt, "expectedUpdatedAt"),
          }));
        case "alias":
          return toolResult(await client.request({
            action: "pages.alias",
            blockId: requireField(params.blockId, "blockId"),
            address: requireField(params.address, "address"),
          }));
        case "remove":
          return toolResult(await client.request({
            action: "pages.remove",
            blockId: requireField(params.blockId, "blockId"),
            address: requireField(params.address, "address"),
            expectedUpdatedAt: requireField(params.expectedUpdatedAt, "expectedUpdatedAt"),
          }));
        default: {
          const unsupported: never = params.operation;
          throw new Error(`Unsupported page operation: ${String(unsupported)}`);
        }
      }
    },
  });

  pi.registerTool({
    ...outlinerToolPresentation("Outliner Work ID"),
    name: "outliner_work_id",
    label: "Outliner Work ID",
    description: "Read allocator state or transactionally assign the next immutable project Work ID",
    promptSnippet: "Allocate project-scoped Work IDs through the canonical outliner service",
    parameters: Type.Object({
      operation: Type.Union([
        Type.Literal("status"),
        Type.Literal("configure"),
        Type.Literal("allocate"),
      ]),
      blockId: Type.Optional(Type.String({ description: "Required for allocate" })),
      expectedUpdatedAt: Type.Optional(
        Type.String({ description: "Required for allocate" }),
      ),
      prefix: Type.Optional(
        Type.String({ description: "Required for configure" }),
      ),
    }),
    async execute(_id, params) {
      await ensureService(false);
      if (params.operation === "status") {
        return toolResult(await client.request({ action: "work-ids.status" }));
      }
      if (params.operation === "configure") {
        if (!params.prefix) {
          throw new Error("outliner_work_id configure requires prefix");
        }
        return toolResult(await client.request({
          action: "work-ids.configure",
          prefix: params.prefix,
        }));
      }
      if (!params.blockId || !params.expectedUpdatedAt) {
        throw new Error("outliner_work_id allocate requires blockId and expectedUpdatedAt");
      }
      return toolResult(await client.request({
        action: "work-ids.allocate",
        blockId: params.blockId,
        expectedUpdatedAt: params.expectedUpdatedAt,
      }));
    },
  });

  pi.registerTool({
    ...outlinerToolPresentation("Outliner Query"),
    name: "outliner_query",
    label: "Outliner Query",
    description:
      "Query blocks by text and scoped properties; property filters default to block metadata and return match context for broader scopes",
    promptSnippet: "Query shared blocks by text or scoped property",
    parameters: Type.Object({
      text: Type.Optional(Type.String()),
      filters: Type.Optional(
        Type.Array(
          Type.Object({
            key: Type.String(),
            value: Type.Optional(Type.String()),
          }),
        ),
      ),
      subtreeRootId: Type.Optional(Type.String()),
      propertyScope: Type.Optional(
        Type.Union([
          Type.Literal("block"),
          Type.Literal("line"),
          Type.Literal("inline"),
          Type.Literal("all"),
        ]),
      ),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    async execute(_id, params) {
      await ensureService(false);
      const collection = await client.request<VisibleBlockCollection>({
        action: "blocks.query",
        query: { ...params, limit: params.limit ?? 100 },
      });
      return queryToolResult(collection);
    },
  });

  pi.registerTool({
    ...outlinerToolPresentation("Outliner Move"),
    name: "outliner_move",
    label: "Outliner Move",
    description: "Move a block to another parent and optional sibling position",
    promptSnippet: "Move a shared outliner block",
    parameters: Type.Object({
      blockId: Type.String(),
      parentId: Type.Union([Type.String(), Type.Null()]),
      position: Type.Optional(Type.Integer({ minimum: 0 })),
    }),
    async execute(_id, params) {
      await ensureService(false);
      return toolResult(await client.request<Block>({ action: "move", ...params }));
    },
  });

  pi.registerTool({
    ...outlinerToolPresentation("Outliner Clients"),
    name: "outliner_clients",
    label: "Outliner Clients",
    description: "List live Tree and Detail client IDs for explicit targeting",
    promptSnippet: "List live outliner client instances",
    parameters: Type.Object({
      role: Type.Optional(Type.Union([Type.Literal("tree"), Type.Literal("detail")])),
    }),
    async execute(_id, params) {
      await ensureService(false);
      return toolResult(
        await client.request<OutlinerClientRegistration[]>({
          action: "clients.list",
          ...(params.role ? { role: params.role } : {}),
        }),
      );
    },
  });

  pi.registerTool({
    ...outlinerToolPresentation("Outliner Selection"),
    name: "outliner_selection",
    label: "Outliner Selection",
    description: "Read the user's selected block with its ancestors and children",
    promptSnippet: "Read the current shared outliner selection",
    parameters: Type.Object({}),
    async execute() {
      await ensureService(false);
      return toolResult(await client.request<SelectionContext>({ action: "selection.get" }));
    },
  });

  pi.on("input", async (event, ctx) => {
    if (
      event.source === "extension" ||
      event.streamingBehavior !== undefined ||
      (event.images?.length ?? 0) > 0
    ) {
      return { action: "continue" };
    }
    const marker = parseStandaloneDispatchMarker(event.text);
    if (marker.kind === "none") return { action: "continue" };
    if (marker.kind === "invalid") {
      ctx.ui.notify(marker.error, "warning");
      return { action: "continue" };
    }
    try {
      await ensureService(false);
      const source = hostCaptureSource(actorId);
      const receipt = await client.request<CaptureReceipt>({
        action: "capture.create",
        requestId: crypto.randomUUID(),
        text: marker.payload,
        source,
        capturedFromBlockId: await selectedBlockId(),
        author: "user",
      });
      const summary = compactCaptureReceipt(receipt, source);
      ctx.ui.notify(
        `${receipt.deduplicated ? "Capture already saved" : "Captured to Inbox"} · ${summary.blockId.slice(0, 8)}`,
        "info",
      );
      return { action: "handled" };
    } catch (error) {
      ctx.ui.notify(
        `Dispatch failed; input preserved: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      return { action: "continue" };
    }
  });

  pi.on("tool_result", async (event) => {
    if (workPlaceholderNudgedThisTurn || !event.toolName.startsWith("outliner_")) return;
    const text = textualToolResult(event.content);
    if (!text) return;
    try {
      const status = await client.request<WorkIdAllocatorStatus>({
        action: "work-ids.status",
      }, 250);
      if (!status.prefix || !containsWorkIdPlaceholder(text, status.prefix)) return;
      workPlaceholderNudgedThisTurn = true;
      return {
        content: [
          ...event.content,
          { type: "text" as const, text: `\n\n${formatWorkPlaceholderNudge(status.prefix)}` },
        ],
      };
    } catch {
      // Placeholder detection is advisory; preserve the original tool result if unavailable.
    }
  });

  pi.on("before_agent_start", async (event) => {
    workPlaceholderNudgedThisTurn = false;
    let context = "";
    let activity = "";
    let selectedText = "";
    try {
      context = await agentWorkspaceContext();
    } catch {
      // The outliner remains optional until a task or workspace is explicitly opened.
    }
    try {
      activity = await recentUserActivityContext();
    } catch {
      // Activity context is advisory; a failed query must not advance its watermark.
    }
    try {
      selectedText = await selectedAgentBlockText();
    } catch {
      // Prompt-only detection remains available when no selected block can be read.
    }
    let nudge = "";
    try {
      const status = await client.request<WorkIdAllocatorStatus>({
        action: "work-ids.status",
      }, 250);
      if (
        status.prefix &&
        (
          containsWorkIdPlaceholder(event.prompt, status.prefix) ||
          containsWorkIdPlaceholder(selectedText, status.prefix)
        )
      ) {
        workPlaceholderNudgedThisTurn = true;
        nudge = formatWorkPlaceholderNudge(status.prefix);
      }
    } catch {
      // A missing allocator configuration cannot define the canonical placeholder prefix.
    }
    const workspace = boundAgentContext([context, activity].filter(Boolean).join("\n\n"));
    const additions = [workspace, nudge].filter(Boolean);
    if (additions.length > 0) {
      return { systemPrompt: `${event.systemPrompt}\n\n${additions.join("\n\n")}` };
    }
  });

  pi.on("agent_start", async (_event, context) => {
    try {
      const task = await currentTask();
      if (task) await presentTask(context, task, "working");
    } catch {
      // Presence is a disposable projection; canonical task state remains authoritative.
    }
  });

  pi.on("agent_settled", async (_event, context) => {
    try {
      const task = await currentTask();
      if (task) await presentTask(context, task, "idle");
    } catch {
      // Presence is a disposable projection; canonical task state remains authoritative.
    }
  });

  pi.on("session_shutdown", async (_event, context) => {
    await presentTask(context, null, "clear");
    await focusRunner?.stop();
    focusRunner = null;
    focusRegistry = null;
    if (headlessServer) {
      headlessServer.kill("SIGTERM");
      headlessServer = null;
    }
  });
  };
}

export default createOutlinerExtension("pi");
