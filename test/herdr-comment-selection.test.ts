import { expect, test } from "bun:test";
import type { RequestInput } from "../src/client";
import { OutlinerClient } from "../src/client";
import {
  dispatchNativeSelectionComment,
  nativeSelectionInvocation,
  requireInvokingDetail,
} from "../src/herdr-comment-selection";
import type { OutlinerClientRegistration } from "../src/types";

const detail: OutlinerClientRegistration = {
  clientId: "detail-1",
  role: "detail",
  contextId: "context-1",
  currentBlockId: "11111111-1111-4111-8111-111111111111",
  runtime: { paneId: "w1:p2", workspaceId: "w1", tabId: "w1:t1" },
};

test("requires Herdr's revision-validated keybinding selection handoff", () => {
  expect(() => nativeSelectionInvocation({
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
      invocation_source: "api",
      focused_pane_id: "w1:p2",
      selected_text: "selected",
    }),
  })).toThrow("plugin_action keybinding");
  expect(nativeSelectionInvocation({
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
      invocation_source: "keybinding",
      focused_pane_id: "w1:p2",
      selected_text: "  exact rendered quote  ",
    }),
  })).toEqual({ paneId: "w1:p2", quote: "  exact rendered quote  " });
});

test("targets only the live Detail that owns the invoking pane", () => {
  expect(requireInvokingDetail([
    { ...detail, role: "tree", clientId: "tree-1" },
    detail,
    { ...detail, clientId: "detail-2", runtime: { paneId: "w1:p3" } },
  ], "w1:p2")).toEqual(detail);
  expect(() => requireInvokingDetail([], "w1:p2")).toThrow("not in a live Outliner Detail");
});

test("dispatches the immutable quote with pane revision and projection identity inputs", async () => {
  const requests: RequestInput[] = [];
  let paneReads = 0;
  const client = {
    async request<T>(input: RequestInput): Promise<T> {
      requests.push(input);
      if (input.action === "clients.list") return [detail] as T;
      if (input.action === "ui.command.send") return { accepted: true } as T;
      throw new Error(`Unexpected request: ${input.action}`);
    },
  } as OutlinerClient;
  const env = {
    HERDR_ENV: "1",
    HERDR_SOCKET_PATH: "/tmp/herdr.sock",
    OUTLINER_WORKSPACE_ROOT: "/workspace/project",
    OUTLINER_STATE_DIR: "/tmp/outliner-state",
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
      invocation_source: "keybinding",
      focused_pane_id: "w1:p2",
      focused_pane_cwd: "/workspace/project",
      selected_text: "Resolved title\nQuery result",
    }),
  };

  const capture = await dispatchNativeSelectionComment({
    env,
    client,
    now: () => new Date("2026-01-02T03:04:05.000Z"),
    readPane: async (socketPath, paneId) => {
      paneReads += 1;
      expect([socketPath, paneId]).toEqual(["/tmp/herdr.sock", "w1:p2"]);
      return { revision: 42, text: "Detail\n\nResolved title\nQuery result" };
    },
  });
  expect(paneReads).toBe(2);

  expect(capture).toEqual({
    quote: "Resolved title\nQuery result",
    capturedAt: "2026-01-02T03:04:05.000Z",
    hostBlockId: detail.currentBlockId!,
    paneId: "w1:p2",
    contentRevision: 42,
    contextId: "context-1",
    detailClientId: "detail-1",
    validation: "herdr-keybinding",
    snapshotText: "Detail\n\nResolved title\nQuery result",
  });
  expect(requests.at(-1)).toEqual({
    action: "ui.command.send",
    command: {
      targetClientId: "detail-1",
      command: "comment.selection",
      renderedSelection: capture,
    },
  });
});

test("rejects a pane rerender between selection validation and dispatch", async () => {
  const client = {
    async request<T>(input: RequestInput): Promise<T> {
      if (input.action === "clients.list") return [detail] as T;
      throw new Error(`Unexpected request: ${input.action}`);
    },
  } as OutlinerClient;
  let revision = 1;
  await expect(dispatchNativeSelectionComment({
    env: {
      HERDR_ENV: "1",
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
      OUTLINER_WORKSPACE_ROOT: "/workspace/project",
      OUTLINER_STATE_DIR: "/tmp/outliner-state",
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
        invocation_source: "keybinding",
        focused_pane_id: "w1:p2",
        focused_pane_cwd: "/workspace/project",
        selected_text: "Selected passage",
      }),
    },
    client,
    readPane: async () => ({
      revision: revision++,
      text: "Detail\n\nSelected passage",
    }),
  })).rejects.toThrow("changed after Herdr validated");
});
