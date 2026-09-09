import { createConnection } from "node:net";
import { listLiveClients, sendClientCommand } from "./client-target";
import { OutlinerClient } from "./client";
import { pluginInvocationWorkspaceRoot } from "./pane-control";
import { resolvePaths } from "./paths";
import type { OutlinerClientRegistration, RenderedSelectionCapture } from "./types";

interface HerdrSelectionContext {
  focused_pane_id?: unknown;
  selected_text?: unknown;
  invocation_source?: unknown;
}

interface HerdrPaneReadResponse {
  id?: unknown;
  result?: {
    type?: unknown;
    read?: { revision?: unknown; text?: unknown };
  };
  error?: { code?: unknown; message?: unknown };
}

export interface HerdrPaneSnapshot {
  revision: number;
  text: string;
}

export interface NativeSelectionInvocation {
  paneId: string;
  quote: string;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is unavailable`);
  }
  return value;
}

export function nativeSelectionInvocation(
  env: NodeJS.ProcessEnv = process.env,
): NativeSelectionInvocation {
  const encoded = env.HERDR_PLUGIN_CONTEXT_JSON;
  if (!encoded) throw new Error("Herdr plugin invocation context is unavailable");
  let context: HerdrSelectionContext;
  try {
    const parsed: unknown = JSON.parse(encoded);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    context = parsed as HerdrSelectionContext;
  } catch {
    throw new Error("Herdr supplied invalid plugin invocation context");
  }
  if (context.invocation_source !== "keybinding") {
    throw new Error(
      "Comment on selection must be invoked through a Herdr plugin_action keybinding",
    );
  }
  return {
    paneId: requiredText(context.focused_pane_id, "Focused Herdr pane"),
    quote: requiredText(context.selected_text, "Rendered selection"),
  };
}

export function requireInvokingDetail(
  clients: readonly OutlinerClientRegistration[],
  paneId: string,
): OutlinerClientRegistration {
  const matches = clients.filter(
    (client) => client.role === "detail" && client.runtime?.paneId === paneId,
  );
  if (matches.length === 0) {
    throw new Error("The selected rendered passage is not in a live Outliner Detail");
  }
  if (matches.length > 1) {
    throw new Error("Multiple Outliner Details claim the invoking Herdr pane");
  }
  const detail = matches[0]!;
  if (!detail.currentBlockId) throw new Error("The invoking Detail has no open block");
  return detail;
}

function sameDetailTarget(
  left: OutlinerClientRegistration,
  right: OutlinerClientRegistration,
): boolean {
  return left.clientId === right.clientId &&
    left.contextId === right.contextId &&
    left.currentBlockId === right.currentBlockId &&
    left.runtime?.paneId === right.runtime?.paneId;
}

export function readHerdrPaneSnapshot(
  socketPath: string,
  paneId: string,
  timeoutMs = 2_000,
): Promise<HerdrPaneSnapshot> {
  const requestId = crypto.randomUUID();
  const received = Promise.withResolvers<HerdrPaneSnapshot>();
  const socket = createConnection(socketPath);
  let buffer = "";
  let settled = false;
  const settle = (callback: () => void): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    socket.destroy();
    callback();
  };
  const fail = (error: unknown): void => settle(() => {
    received.reject(error instanceof Error ? error : new Error(String(error)));
  });
  const timeout = setTimeout(
    () => fail(new Error(`Herdr pane snapshot request timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  socket.setEncoding("utf8");
  socket.once("error", fail);
  socket.once("connect", () => {
    socket.write(`${JSON.stringify({
      id: requestId,
      method: "pane.read",
      params: {
        pane_id: paneId,
        source: "recent",
        lines: 10_000,
        format: "text",
        strip_ansi: true,
      },
    })}\n`);
  });
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    try {
      const response = JSON.parse(buffer.slice(0, newline)) as HerdrPaneReadResponse;
      if (response.error) {
        throw new Error(
          typeof response.error.message === "string"
            ? response.error.message
            : "Herdr pane revision request failed",
        );
      }
      const revision = response.result?.read?.revision;
      const text = response.result?.read?.text;
      if (
        response.id !== requestId ||
        response.result?.type !== "pane_read" ||
        typeof revision !== "number" ||
        !Number.isSafeInteger(revision) ||
        revision < 0 ||
        typeof text !== "string"
      ) {
        throw new Error("Herdr returned invalid pane selection evidence");
      }
      settle(() => received.resolve({ revision, text }));
    } catch (error) {
      fail(error);
    }
  });
  return received.promise;
}

export async function dispatchNativeSelectionComment(options: {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  client?: OutlinerClient;
  readPane?: (socketPath: string, paneId: string) => Promise<HerdrPaneSnapshot>;
} = {}): Promise<RenderedSelectionCapture> {
  const env = options.env ?? process.env;
  if (env.HERDR_ENV !== "1") throw new Error("Comment on selection requires Herdr");
  const herdrSocketPath = requiredText(env.HERDR_SOCKET_PATH, "Herdr socket");
  const invocation = nativeSelectionInvocation(env);
  const workspaceRoot = pluginInvocationWorkspaceRoot(env);
  const paths = resolvePaths({ ...env, OUTLINER_WORKSPACE_ROOT: workspaceRoot });
  const client = options.client ?? new OutlinerClient(paths.socket);
  const detail = requireInvokingDetail(
    await listLiveClients(client, "detail"),
    invocation.paneId,
  );
  const readPane = options.readPane ?? readHerdrPaneSnapshot;
  const before = await readPane(herdrSocketPath, invocation.paneId);
  const confirmedDetail = requireInvokingDetail(
    await listLiveClients(client, "detail"),
    invocation.paneId,
  );
  const after = await readPane(herdrSocketPath, invocation.paneId);
  if (
    !sameDetailTarget(detail, confirmedDetail) ||
    before.revision !== after.revision ||
    before.text !== after.text ||
    !after.text.includes(invocation.quote)
  ) {
    throw new Error("The invoking Detail changed after Herdr validated the selection");
  }
  const capture: RenderedSelectionCapture = {
    quote: invocation.quote,
    capturedAt: (options.now ?? (() => new Date()))().toISOString(),
    hostBlockId: confirmedDetail.currentBlockId!,
    paneId: invocation.paneId,
    contentRevision: after.revision,
    contextId: confirmedDetail.contextId,
    detailClientId: confirmedDetail.clientId,
    validation: "herdr-keybinding",
    snapshotText: after.text,
  };
  await sendClientCommand(client, confirmedDetail.clientId, {
    command: "comment.selection",
    renderedSelection: capture,
  });
  return capture;
}

if (import.meta.main) {
  try {
    const capture = await dispatchNativeSelectionComment();
    console.log(`Opened comment composer for ${capture.quote.length} rendered characters`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
