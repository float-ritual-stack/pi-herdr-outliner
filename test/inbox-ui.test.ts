import { describe, expect, test } from "bun:test";
import { setImmediate } from "node:timers/promises";
import { getOsc8LinkAtColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { InboxController } from "../src/inbox-controller";
import { inboxStatusCue, renderInboxFrame } from "../src/inbox-renderer";
import type { RequestInput } from "../src/client";
import type { InboxResult, InboxStatus } from "../src/inbox-types";
import type { Block } from "../src/types";

function result(id: string, overrides: Partial<InboxResult> = {}): InboxResult {
  return {
    id, sourceId: `source-${id}`, sourceTitle: `Capture ${id}`, summary: "Created a task and filed the note.",
    state: "applied", outputIds: [`output-${id}`, `second-${id}`], createdAt: "2026-09-20T10:00:00Z",
    usage: { provider: "provider", model: "editor-model", inputTokens: 1234, outputTokens: 321, cost: 0.0123, jevCalls: 2, elapsedMs: 1000 },
    ...overrides,
  };
}

function status(overrides: Partial<InboxStatus> = {}): InboxStatus {
  return { enabled: true, paused: false, state: "idle", message: "Ready for captures", pending: 0, attentionCount: 1, attentionOnly: false, resultsOffset: 0, results: [result("result-one"), result("result-two", { state: "held", summary: "Which project should own this?", outputIds: [] })], resultsTruncated: false, ...overrides };
}

function harness(respond?: (request: RequestInput) => unknown | Promise<unknown>) {
  const requests: RequestInput[] = [];
  const opened: Array<{ id: string; destination: string }> = [];
  let snapshot = status();
  let closed = 0;
  let invalidations = 0;
  const controller = new InboxController({
    async request<T>(request: RequestInput): Promise<T> {
      requests.push(request);
      const response = await respond?.(request);
      if (response !== undefined) return response as T;
      switch (request.action) {
        case "inbox.status": return { ...snapshot, attentionOnly: request.attentionOnly === true, results: request.attentionOnly ? snapshot.results.filter(value => value.state === "held" || value.state === "failed") : snapshot.results } as T;
        case "inbox.pause": snapshot = { ...snapshot, paused: true, state: "paused" }; return snapshot as T;
        case "inbox.resume": snapshot = { ...snapshot, paused: false, state: "idle" }; return snapshot as T;
        case "inbox.undo": snapshot = { ...snapshot, results: snapshot.results.map(value => value.id === request.resultId ? { ...value, state: "undone" } : value) }; return snapshot as T;
        case "inbox.retry": return { ...snapshot, pending: 1 } as T;
        case "get": return { id: request.blockId, text: "Available block", revision: 1 } as T;
        default: throw new Error(`Unexpected ${request.action}`);
      }
    },
    invalidate() { invalidations++; },
    async open(id, destination) { opened.push({ id, destination }); },
    close() { closed++; },
  });
  return { controller, requests, opened, get closed() { return closed; }, get invalidations() { return invalidations; } };
}

async function startRecent(controller: InboxController): Promise<void> {
  await controller.start();
  if (controller.attentionOnly) await controller.input("a", { name: "a" });
}

describe("Inbox controls", () => {
  test("opening with no outstanding items shows recent results", async () => {
    const h = harness(request => request.action === "inbox.status" ? status({
      attentionCount: 0, attentionOnly: request.attentionOnly === true,
      results: request.attentionOnly ? [] : [result("recent-success")],
    }) : undefined);
    await h.controller.start();
    expect(h.controller.attentionOnly).toBe(false);
    expect(h.controller.selected?.id).toBe("recent-success");
  });

  test("closing during the opening read does not start a late history fallback", async () => {
    const pending = Promise.withResolvers<InboxStatus>();
    const h = harness(request => request.action === "inbox.status" ? pending.promise : undefined);
    const opening = h.controller.start();
    await h.controller.close();
    pending.resolve(status({ attentionOnly: true, attentionCount: 0, results: [] }));
    await opening;
    expect(h.requests).toEqual([{ action: "inbox.status", attentionOnly: true }]);
    expect(h.closed).toBe(1);
  });

  test("opening Inbox reveals an outstanding failure before newer successful results", async () => {
    const failed = result("older-failure", {
      state: "failed", sourceTitle: "Unfinished capture", outputIds: [],
      summary: "Cleanup failed; the source is unchanged.", error: "Needs a valid task destination",
    });
    const recent = Array.from({ length: 30 }, (_, index) => result("success-" + index));
    const h = harness(request => request.action === "inbox.status" ? status({
      message: "Inbox is caught up", attentionCount: 1,
      attentionOnly: request.attentionOnly === true,
      results: request.attentionOnly ? [failed] : recent,
      resultsTruncated: !request.attentionOnly,
    }) : undefined);
    await h.controller.start();
    expect(h.controller.selected?.id).toBe(failed.id);
    const frame = stripTerminalSequences(renderInboxFrame(h.controller, 80, 26, "a attention/recent").join("\n"));
    expect(frame).toContain("Needs attention: 1");
    expect(frame).toContain("Unfinished capture");
    expect(frame).not.toContain("Inbox is caught up");
    // Choosing history is deliberate; subsequent status events must not steal it.
    await h.controller.input("a", { name: "a" });
    await h.controller.refresh();
    expect(h.controller.attentionOnly).toBe(false);
    expect(h.controller.selected?.id).toBe("success-0");
    await h.controller.close();
    await h.controller.start();
    expect(h.controller.selected?.id).toBe(failed.id);
  });

  test("outstanding questions remain reachable beyond 30 newer successes and mutations retain the attention view", async () => {
    const question = result("old-question", { state: "held", summary: "Which project should own this?" });
    const recent = Array.from({ length: 30 }, (_, index) => result(`success-${index}`));
    let answered = false;
    const h = harness(request => {
      const snapshot = status({ results: recent, resultsTruncated: true, attentionCount: answered ? 0 : 1 });
      if (request.action === "inbox.status" && request.attentionOnly) return { ...snapshot, attentionOnly: true, results: answered ? [] : [question], resultsTruncated: false };
      if (request.action === "inbox.retry") { answered = true; return { ...snapshot, attentionCount: 0 }; }
      if (request.action.startsWith("inbox.")) return snapshot;
    });
    await startRecent(h.controller);
    expect(h.controller.results).toHaveLength(30);
    expect(inboxStatusCue(h.controller.snapshot)).toContain("1 need attention");
    await h.controller.input("a", { name: "a" });
    expect(h.requests.at(-1)).toEqual({ action: "inbox.status", attentionOnly: true });
    expect(h.controller.selected?.id).toBe(question.id);
    await h.controller.input("", { name: "tab" });
    const target = h.controller.targets[h.controller.targetIndex]?.id;
    await h.controller.input("p", { name: "p" });
    expect(h.controller.attentionOnly).toBe(true);
    expect(h.controller.selected?.id).toBe(question.id);
    expect(h.controller.targets[h.controller.targetIndex]?.id).toBe(target);
    expect(h.requests.at(-1)).toEqual({ action: "inbox.status", attentionOnly: true });
    await h.controller.input("r", { name: "r" });
    h.controller.paste("Use project alpha");
    await h.controller.input("", { name: "return" });
    expect(h.controller.results).toEqual([]);
    expect(h.controller.snapshot?.attentionCount).toBe(0);
    expect(h.controller.attentionOnly).toBe(true);
    await h.controller.close();
    await h.controller.start();
    expect(h.requests.at(-1)).toEqual({ action: "inbox.status" });
    expect(h.controller.results).toHaveLength(30);
    expect(h.controller.attentionOnly).toBe(false);
  });

  test("older applied results can be undone by exact identity without returning to the first page", async () => {
    const recent = Array.from({ length: 30 }, (_, index) => result(`new-success-${index}`));
    let older = result("older-applied");
    const h = harness(request => {
      const firstPage = status({ results: recent, resultsTruncated: true, attentionCount: 0 });
      if (request.action === "inbox.status" && request.attentionOnly) return { ...firstPage, attentionOnly: true, results: [], resultsTruncated: false };
      if (request.action === "inbox.status" && request.resultsOffset === 30) return { ...firstPage, resultsOffset: 30, results: [older], resultsTruncated: false };
      if (request.action === "inbox.undo") { expect(request.resultId).toBe(older.id); older = { ...older, state: "undone" }; }
      if (request.action.startsWith("inbox.")) return firstPage;
    });
    await startRecent(h.controller);
    await h.controller.input("", { name: "right" });
    expect(h.controller.selected?.id).toBe("older-applied");
    expect(h.controller.resultsOffset).toBe(30);
    const reads = h.requests.length;
    await h.controller.input("", { name: "right" });
    expect(h.requests).toHaveLength(reads);
    await h.controller.input("u", { name: "u" });
    expect(h.controller.selected?.state).toBe("undone");
    expect(h.controller.selected?.id).toBe("older-applied");
    expect(h.requests.at(-1)).toEqual({ action: "inbox.status", resultsOffset: 30 });
    expect(stripTerminalSequences(renderInboxFrame(h.controller, 120, 26, "a questions/recent").join("\n"))).toContain("Recent results: 31–31");
    await h.controller.input("", { name: "left" });
    expect(h.controller.resultsOffset).toBe(0);
    expect(h.controller.selected?.id).toBe("new-success-0");
    await h.controller.input("", { name: "right" });
    await h.controller.input("a", { name: "a" });
    expect(h.controller.attentionOnly).toBe(true);
    expect(h.controller.resultsOffset).toBe(0);
    await h.controller.input("a", { name: "a" });
    expect(h.controller.resultsOffset).toBe(0);
    expect(h.controller.selected?.id).toBe("new-success-0");
  });

  test("a late recent response cannot replace a newly requested attention collection", async () => {
    const recent = Promise.withResolvers<InboxStatus>();
    const question = result("old-question", { state: "held" });
    let requests = 0;
    const h = harness(request => {
      if (request.action === "inbox.status" && request.attentionOnly) return status({ attentionOnly: true, results: [question] });
      if (request.action === "inbox.status" && ++requests > 1) return recent.promise;
    });
    await startRecent(h.controller);
    const refreshing = h.controller.refresh();
    const switching = h.controller.input("a", { name: "a" });
    expect(h.controller.results).toEqual([]);
    recent.resolve(status());
    await Promise.all([refreshing, switching]);
    expect(h.controller.attentionOnly).toBe(true);
    expect(h.controller.selected?.id).toBe(question.id);
  });

  test("attention mutation responses never flash recent rows while the filtered read is pending", async () => {
    const filteredRead = Promise.withResolvers<InboxStatus>();
    const question = result("question-one", { state: "held" });
    let afterMutation = false;
    const h = harness(request => {
      if (request.action === "inbox.status" && request.attentionOnly) return afterMutation ? filteredRead.promise : status({ attentionOnly: true, results: [question] });
      if (request.action === "inbox.pause") { afterMutation = true; return status({ paused: true, state: "paused" }); }
    });
    await startRecent(h.controller);
    await h.controller.input("a", { name: "a" });
    const pausing = h.controller.input("p", { name: "p" });
    await setImmediate();
    expect(h.controller.results.map(value => value.id)).toEqual([question.id]);
    expect(h.controller.busy).toBe(true);
    filteredRead.resolve(status({ paused: true, state: "paused", attentionOnly: true, results: [question] }));
    await pausing;
    expect(h.controller.selected?.id).toBe(question.id);
    expect(h.controller.busy).toBe(false);
  });

  test("pause/resume and undo address the canonical service, and reopening restores results", async () => {
    const h = harness();
    await startRecent(h.controller);
    await h.controller.input("p", { name: "p" });
    expect(h.controller.snapshot?.state).toBe("paused");
    await h.controller.input("p", { name: "p" });
    expect(h.controller.snapshot?.state).toBe("idle");
    await h.controller.input("u", { name: "u" });
    expect(h.requests.at(-1)).toEqual({ action: "inbox.undo", resultId: "result-one" });
    expect(h.controller.selected?.state).toBe("undone");
    await h.controller.close();
    expect(h.closed).toBe(1);
    await startRecent(h.controller);
    expect(h.controller.selected?.state).toBe("undone");
    expect(h.requests.map(request => request.action)).toEqual(["inbox.status", "inbox.status", "inbox.pause", "inbox.resume", "inbox.undo", "inbox.status", "inbox.status"]);
  });

  test("reconsider captures bounded instructions and never treats typed commands as actions", async () => {
    const h = harness();
    await startRecent(h.controller);
    await h.controller.input("r", { name: "r" });
    expect(h.controller.steering).toBe(false);
    expect(h.controller.notice).toContain("Undo");
    h.controller.move(1);
    await h.controller.input("r", { name: "r" });
    expect(h.controller.steering).toBe(true);
    await h.controller.input("p", { name: "p" });
    h.controller.paste("ut in project alpha\nKeep the original.\x1b]52;;malicious\x07");
    await h.controller.input("", { name: "return" });
    expect(h.requests.at(-1)).toEqual({ action: "inbox.retry", sourceId: "source-result-two", instructions: "put in project alpha Keep the original." });
    expect(h.controller.steering).toBe(false);
    expect(h.controller.snapshot?.pending).toBe(1);
    expect(h.requests.some(request => request.action === "inbox.pause")).toBe(false);
    await h.controller.input("r", { name: "r" });
    h.controller.paste("x".repeat(499) + "😀");
    expect(h.controller.instructions).toBe("x".repeat(499));
    await h.controller.input("", { name: "escape" });
    expect(h.controller.steering).toBe(false);
    expect(h.closed).toBe(0);
  });

  test("refresh preserves selected result and target while new results arrive", async () => {
    let snapshot = status();
    const h = harness(request => request.action === "inbox.status" ? snapshot : undefined);
    await startRecent(h.controller);
    await h.controller.input("", { name: "tab" });
    const target = h.controller.targets[h.controller.targetIndex]?.id;
    snapshot = { ...snapshot, results: [result("newest-result"), ...snapshot.results] };
    await h.controller.refresh();
    expect(h.controller.selected?.id).toBe("result-one");
    expect(h.controller.targets[h.controller.targetIndex]?.id).toBe(target);
    expect(h.controller.index).toBe(1);
    await h.controller.close();
    snapshot = { ...snapshot, paused: true, state: "paused" };
    await h.controller.refresh();
    expect(inboxStatusCue(h.controller.snapshot)).toContain("paused");
  });

  test("an older status read cannot overwrite a pause response", async () => {
    const pending = Promise.withResolvers<InboxStatus>();
    let reads = 0;
    const h = harness(request => request.action === "inbox.status" && !request.attentionOnly && ++reads > 1 ? pending.promise : undefined);
    await startRecent(h.controller);
    const refreshing = h.controller.refresh();
    await h.controller.input("p", { name: "p" });
    pending.resolve(status());
    await refreshing;
    expect(h.controller.snapshot?.state).toBe("paused");
  });

  test("coalesces status events without polling and keeps failures visible", async () => {
    const pending = Promise.withResolvers<InboxStatus>();
    let reads = 0;
    const h = harness(request => {
      if (request.action === "inbox.status") return ++reads === 1 ? pending.promise : status();
      if (request.action === "inbox.undo") throw new Error("Source was edited; cannot undo safely");
    });
    const initial = h.controller.refresh();
    const refreshes = [h.controller.refresh(), h.controller.refresh(), h.controller.refresh()];
    pending.resolve(status());
    await Promise.all([initial, ...refreshes]);
    expect(reads).toBe(2);
    await startRecent(h.controller);
    await h.controller.input("u", { name: "u" });
    expect(h.controller.notice).toContain("Source was edited");
    expect(h.controller.selected?.state).toBe("applied");
    h.controller.disconnected();
    expect(inboxStatusCue(h.controller.snapshot, h.controller.error)).toBe("Inbox unavailable");
    await h.controller.refresh();
    expect(h.controller.error).toBe("");
  });

  test("opens chosen output or source through Tree/Detail and ignores late opens after close", async () => {
    const h = harness();
    await startRecent(h.controller);
    await h.controller.input("", { name: "tab" });
    await h.controller.input("", { name: "return", meta: true });
    expect(h.opened).toEqual([{ id: "second-result-one", destination: "detail" }]);
    await startRecent(h.controller);
    await h.controller.input("s", { name: "s" });
    expect(h.opened.at(-1)).toEqual({ id: "source-result-one", destination: "tree" });
    const pending = Promise.withResolvers<Block | null>();
    const delayed = harness(request => request.action === "get" ? pending.promise : undefined);
    await startRecent(delayed.controller);
    const opening = delayed.controller.input("", { name: "return" });
    await delayed.controller.close();
    pending.resolve({ id: "output-result-one" } as Block);
    await opening;
    expect(delayed.opened).toEqual([]);
  });

  test("deleted results cannot navigate and undo never runs for held results", async () => {
    const h = harness(request => request.action === "get" ? { id: request.blockId, deletedAt: "today" } : undefined);
    await startRecent(h.controller);
    await h.controller.input("", { name: "return" });
    expect(h.controller.notice).toContain("no longer available");
    expect(h.opened).toEqual([]);
    h.controller.move(1);
    await h.controller.input("u", { name: "u" });
    expect(h.requests.some(request => request.action === "inbox.undo")).toBe(false);
  });
});

describe("Inbox rendering", () => {
  test("attention counts use the service total and Jev degradation remains visible", async () => {
    expect(inboxStatusCue(status({ attentionCount: 0 }))).not.toContain("need attention");
    const h = harness(request => request.action === "inbox.status" ? status({ attentionCount: 41, results: [result("usage-result", {
      usage: { provider: "provider", model: "editor", inputTokens: 10, outputTokens: 20, cost: 0, jevCalls: 3, jevSuccessfulCalls: 1, jevWarning: "Some Jev comparisons unavailable", elapsedMs: 2000 },
    })] }) : undefined);
    await startRecent(h.controller);
    const text = stripTerminalSequences(renderInboxFrame(h.controller, 150, 30, "a questions/recent").join("\n"));
    expect(text).toContain("Needs attention: 41");
    expect(text).toContain("Jev 3 attempted / 1 successful");
    expect(text).toContain("Some Jev comparisons unavailable");
    expect(inboxStatusCue(h.controller.snapshot)).toContain("41 need attention");
  });

  test("renders progress, questions, usage and linked outputs without terminal injection", async () => {
    const h = harness(request => request.action === "inbox.status" ? status({
      state: "working", pending: 3, message: "Looking for related notes\x1b]52;;secret\x07", current: { id: "current-source", title: "New capture" }, resultsTruncated: true,
      results: [result("result-one", { sourceTitle: "Capture 界 😀", summary: "Created a task.", error: "Review project choice.\x1b[2J" })],
    }) : undefined);
    await startRecent(h.controller);
    for (const width of [12, 24, 40, 80, 120, 150]) {
      for (const height of [8, 12, 26]) {
        const lines = renderInboxFrame(h.controller, width, height, "Esc close · p pause · r reconsider\nTab link · ? actions");
        expect(lines).toHaveLength(height);
        expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
        expect(lines.join("\n")).not.toContain("\x1b]52");
        expect(lines.join("\n")).not.toContain("\x1b[2J");
      }
    }
    const lines = renderInboxFrame(h.controller, 150, 26, "Esc close · p pause · r reconsider\nTab link · ? actions");
    const text = stripTerminalSequences(lines.join("\n"));
    for (const content of ["working", "3 pending", "Looking for related notes", "Current: New capture", "Review project choice", "Output 1", "Source", "provider", "editor-model", "estimated $0.0123", "Jev 2 calls"]) expect(text).toContain(content);
    const output = lines.find(line => stripTerminalSequences(line).includes("Output 1"))!;
    const column = stripTerminalSequences(output).indexOf("Output 1");
    expect(getOsc8LinkAtColumn(output, column)).toBe("pi-outliner://block/output-result-one");
  });

  test("explicitly exposes bounded history, disabled state, and unavailable state", async () => {
    for (const snapshot of [status({ enabled: false }), status({ enabled: false, state: "unavailable", message: "Configure the Inbox model" })]) {
      const h = harness(request => request.action === "inbox.status" ? { ...snapshot, resultsTruncated: true } : undefined);
      await startRecent(h.controller);
      const text = stripTerminalSequences(renderInboxFrame(h.controller, 120, 26, "Esc close").join("\n"));
      expect(text).toContain(snapshot.state === "unavailable" ? "unavailable" : "disabled");
      expect(text).toContain("older results available");
    }
  });
});
