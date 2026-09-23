import {initTheme} from "@earendil-works/pi-coding-agent";
initTheme(undefined,false);
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
        case "references.resolve": return {text:request.text,workIdPrefix:null} as T;
        case "get": return { id: request.blockId, text: "Available block", revision: 1 } as T;
        default: throw new Error(`Unexpected ${request.action}`);
      }
    },
    invalidate() { invalidations++; },
    async open(id, destination) { opened.push({ id, destination }); },
    async openResource(id) { opened.push({ id, destination: "resource" }); },
    close() { closed++; },
  });
  return { controller, requests, opened, get closed() { return closed; }, get invalidations() { return invalidations; } };
}

async function startRecent(controller: InboxController): Promise<void> {
  await controller.start();
  if (controller.attentionOnly) await controller.input("a", { name: "a" });
}

describe("Inbox controls", () => {
  test("opens a saved session through the service Resource API rather than the client's filesystem", async () => {
    const sessionPath = "/service-only/state/assistant-sessions/attempt.jsonl";
    const receipt = result("with-session", {usage:{
      provider:"pi", model:"fixture", inputTokens:0, outputTokens:0, cost:0, jevCalls:0, elapsedMs:10,
      piSessions:[{id:"session-id",path:sessionPath,startedAt:"2026-09-22",finishedAt:"2026-09-22",phase:"Tool: search_notes",outcome:"failed"}],
    }});
    const h = harness(request => {
      if(request.action === "inbox.status")return status({attentionCount:0,attentionOnly:request.attentionOnly===true,results:request.attentionOnly?[]:[receipt]});
      if(request.action === "resources.intern-filesystem"){
        expect(request.input.path).toBe(sessionPath);
        return {resource:{id:"server-owned-resource"}};
      }
    });
    await startRecent(h.controller);
    await h.controller.input("t",{name:"t"});
    expect(h.opened).toEqual([{id:"server-owned-resource",destination:"resource"}]);
    expect(h.requests.filter(r=>r.action==="resources.intern-filesystem")).toHaveLength(1);
  });

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
    expect(h.requests.filter(request=>request.action.startsWith("inbox.")).at(-1)).toEqual({ action: "inbox.status", attentionOnly: true });
    expect(h.controller.selected?.id).toBe(question.id);
    await h.controller.input("", { name: "tab" });
    const target = h.controller.targets[h.controller.targetIndex]?.id;
    await h.controller.input("p", { name: "p" });
    expect(h.controller.attentionOnly).toBe(true);
    expect(h.controller.selected?.id).toBe(question.id);
    expect(h.controller.targets[h.controller.targetIndex]?.id).toBe(target);
    expect(h.requests.filter(request=>request.action.startsWith("inbox.")).at(-1)).toEqual({ action: "inbox.status", attentionOnly: true });
    await h.controller.input("r", { name: "r" });
    h.controller.paste("Use project alpha");
    await h.controller.input("", { name: "return" });
    expect(h.controller.results).toEqual([]);
    expect(h.controller.snapshot?.attentionCount).toBe(0);
    expect(h.controller.attentionOnly).toBe(true);
    await h.controller.close();
    await h.controller.start();
    expect(h.requests.filter(request=>request.action.startsWith("inbox.")).at(-1)).toEqual({ action: "inbox.status" });
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
    expect(h.requests.filter(request=>request.action.startsWith("inbox.")).at(-1)).toEqual({ action: "inbox.status", resultsOffset: 30 });
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
    expect(h.requests.filter(request=>request.action.startsWith("inbox.")).at(-1)).toEqual({ action: "inbox.undo", resultId: "result-one" });
    expect(h.controller.selected?.state).toBe("undone");
    await h.controller.close();
    expect(h.closed).toBe(1);
    await startRecent(h.controller);
    expect(h.controller.selected?.state).toBe("undone");
    expect(h.requests.filter(request=>request.action.startsWith("inbox.")).map(request => request.action)).toEqual(["inbox.status", "inbox.status", "inbox.pause", "inbox.resume", "inbox.undo", "inbox.status", "inbox.status"]);
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
    expect(h.requests.filter(request=>request.action.startsWith("inbox.")).at(-1)).toEqual({ action: "inbox.retry", sourceId: "source-result-two", instructions: "put in project alpha Keep the original." });
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
    h.controller.showActivity();
    h.controller.technicalDetails = true;
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
    h.controller.showActivity();
    h.controller.technicalDetails = true;
    const lines = renderInboxFrame(h.controller, 150, 26, "Esc close · p pause · r reconsider\nTab link · ? actions");
    const text = stripTerminalSequences(lines.join("\n"));
    for (const content of ["working", "3 pending", "Looking for related notes", "Current: New capture", "Review project choice", "Output 1", "Source", "provider", "editor-model", "estimated $0.0123", "Jev 2 calls"]) expect(text).toContain(content);
    const output = lines.find(line => stripTerminalSequences(line).includes("Output 1 ·"))!;
    const column = stripTerminalSequences(output).indexOf("Output 1");
    expect(getOsc8LinkAtColumn(output, column)).toBe("pi-outliner-action:tree.inbox.open-target:0");
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

test('in-place cleanup defaults to Source even with a saved session; Escape closes the view',async()=>{
 const receipt=result('in-place',{outputIds:[],usage:{provider:'pi',model:'fixture',inputTokens:0,outputTokens:0,cost:0,jevCalls:0,elapsedMs:0,piSessions:[{id:'trace',path:'/trace.jsonl',startedAt:'2026-09-23',phase:'complete',outcome:'completed'}]}});
 const h=harness(r=>r.action==='inbox.status'?status({attentionOnly:!!r.attentionOnly,attentionCount:0,results:r.attentionOnly?[]:[receipt]}):undefined);
 await startRecent(h.controller);expect(h.controller.targets[0]).toMatchObject({id:receipt.sourceId,role:'source'});
 await h.controller.input('',{name:'return',meta:true});expect(h.opened).toEqual([{id:receipt.sourceId,destination:'detail'}]);
 await h.controller.input('',{name:'escape'});expect(h.closed).toBe(1);
});

test("default open skips missing and trashed outputs, but preserves transport errors", async () => {
  let disconnected = false;
  const h = harness(request => {
    if (request.action !== "get") return undefined;
    if (disconnected) throw new Error("Workspace disconnected");
    if (request.blockId === "output-result-one") throw new Error(`Block not found: ${request.blockId}`);
    if (request.blockId === "second-result-one") return {id: request.blockId, effectiveDeletedRootId: "trash"};
    return undefined;
  });
  await startRecent(h.controller);
  await h.controller.input("", {name: "return", meta: true});
  expect(h.opened).toEqual([{id: "source-result-one", destination: "detail"}]);
  disconnected = true;
  h.controller.targetIndex = 0;
  await h.controller.input("", {name: "return", meta: true});
  expect(h.opened).toHaveLength(1);
  expect(h.controller.notice).toBe("Workspace disconnected");
});

describe("shared Inbox document preview", () => {
  test("Source and separate Outputs render rich current content without opening or mutating", async () => {
    const h = harness(request => request.action === "get" ? {id:request.blockId,revision:1,text:`# ${request.blockId}\n\n> [!summary] Readable callout\n> Current note body\n\n${Array.from({length:40},(_,i)=>`line ${i}`).join('\n')}`} : undefined);
    await startRecent(h.controller); await setImmediate();
    expect(h.controller.reader.state?.target).toEqual({kind:"block",blockId:"output-result-one"});
    let frame=renderInboxFrame(h.controller,140,32,"help");
    expect(stripTerminalSequences(frame.join('\n'))).toContain('Output 1 · current');
    expect(stripTerminalSequences(frame.join('\n'))).toContain('Readable callout');
    h.controller.reader.focus(true); h.controller.scrollPreview(8);
    await h.controller.refresh(); await setImmediate();
    expect(h.controller.reader.state?.offset).toBe(8);
    h.controller.selectTarget(2); await setImmediate();
    frame=renderInboxFrame(h.controller,140,32,"help");
    expect(stripTerminalSequences(frame.join('\n'))).toContain('Source · current');
    expect(h.controller.reader.state?.target).toEqual({kind:"block",blockId:"source-result-one"});
    h.controller.selectResult(1); await setImmediate();
    expect(h.controller.reader.state?.focused).toBe(false);
    expect(h.controller.reader.state?.target).toEqual({kind:"block",blockId:"source-result-two"});
    expect(h.opened).toHaveLength(0);
    expect(h.requests.every(request=>['get','inbox.status','references.resolve'].includes(request.action))).toBe(true);
  });

  test("compact reading is explicit and all rendered hit regions remain inside the frame", async () => {
    const h=harness();await startRecent(h.controller);await setImmediate();
    for (const [width,height] of [[22,12],[40,17],[80,25],[140,32]]) {
      h.controller.reader.focus(false);
      let frame=renderInboxFrame(h.controller,width!,height!,"help");
      expect(frame).toHaveLength(height!);
      expect(frame.every(line=>visibleWidth(line)<=width!)).toBe(true);
      h.controller.reader.focus(true);frame=renderInboxFrame(h.controller,width!,height!,"help");
      expect(frame).toHaveLength(height!);
      const geometry=h.controller.previewFrame;
      if(geometry){expect(geometry.content.y+geometry.content.height).toBeLessThanOrEqual(height!);expect(geometry.content.x+geometry.content.width).toBeLessThanOrEqual(width!);}
    }
  });

  test("Activity wheel scrolls its own receipt; Escape exits preview focus before closing", async()=>{
    const h=harness();await startRecent(h.controller);await setImmediate();
    h.controller.showActivity();
    h.controller.technicalDetails = true;renderInboxFrame(h.controller,130,32,"help");
    const rect=h.controller.activityRect!;
    expect(h.controller.handleActivityMouse(`\x1b[<65;${rect.x+2};${rect.y+2}M`)).toBe(true);
    expect(h.controller.detailOffset).toBe(3);expect(h.controller.index).toBe(0);
    h.controller.selectTarget(0);await setImmediate();h.controller.reader.focus(true);
    await h.controller.input('',{name:'escape'});expect(h.closed).toBe(0);expect(h.controller.reader.state?.focused).toBe(false);
    await h.controller.input('',{name:'escape'});expect(h.closed).toBe(1);
  });
});

test('Activity preserves invalidation and reloads current Source on return',async()=>{
 let body='Old source';const h=harness(request=>request.action==='get'?{id:request.blockId,text:body,revision:1}:undefined);
 await startRecent(h.controller);await setImmediate();h.controller.selectTarget(2);await setImmediate();
 h.controller.showActivity();body='Updated source';h.controller.contentChanged();h.controller.selectTarget(2);await setImmediate();
 expect(h.controller.reader.state?.document.projectedText).toBe('Updated source');
 for(const width of [20,40,80]){
  const lines=renderInboxFrame(h.controller,width,25,'help');
  const actions=lines.flatMap(line=>Array.from({length:width},(_,col)=>getOsc8LinkAtColumn(line,col))).filter(Boolean);
  expect(actions).toContain('pi-outliner-action:tree.inbox.preview.source');
  expect(actions).toContain('pi-outliner-action:tree.inbox.preview.activity');
  if(width<65)expect(actions).toContain('pi-outliner-action:tree.inbox.preview.next-output');
 }
});

 test('output tabs switch to cycling whenever all individual choices would overflow',async()=>{
 const outputs=Array.from({length:6},(_,index)=>`output-${index}`);
 const h=harness(request=>request.action==='inbox.status'?status({attentionCount:0,attentionOnly:request.attentionOnly===true,results:request.attentionOnly?[]:[result('many',{outputIds:outputs})]}):undefined);
 await startRecent(h.controller);await setImmediate();
 const lines=renderInboxFrame(h.controller,80,30,'help');
 const actions=lines.flatMap(line=>Array.from({length:80},(_,col)=>getOsc8LinkAtColumn(line,col))).filter(Boolean);
 expect(actions).toContain('pi-outliner-action:tree.inbox.preview.next-output');
 const visited=new Set<string>();
 for(let i=0;i<outputs.length;i++){h.controller.nextOutput();visited.add(h.controller.targets[h.controller.targetIndex]!.id);}
 expect([...visited].sort()).toEqual([...outputs].sort());
 });

function searchCollection(receipts: InboxResult[], semantic: 'lexical'|'ranked'|'unavailable' = 'lexical') {
 return {matches:receipts.map(result=>({result,revisions:[],title:result.sourceTitle,path:'',snippet:result.summary,exact:false})),completeness:{kind:'complete'},semantic:{status:semantic}};
}
async function until(check:()=>boolean):Promise<void>{const end=Date.now()+2000;while(!check()){if(Date.now()>end)throw new Error('Condition did not settle');await new Promise(resolve=>setTimeout(resolve,2));}}

test('history search ignores obsolete queries and restores the previous browse target and scroll',async()=>{
 const pending=new Map<string,(value:unknown)=>void>();
 const h=harness(request=>{
  if(request.action==='inbox.search')return new Promise(resolve=>pending.set(request.query,resolve));
  if(request.action==='get')return{id:request.blockId,text:'Title\n\n'+Array.from({length:100},(_,i)=>`Paragraph ${i}.`).join('\n\n'),revision:1};
 });
 await startRecent(h.controller);await setImmediate();h.controller.selectTarget(1);await setImmediate();
 renderInboxFrame(h.controller,130,32,'help');h.controller.scrollPreview(20);
 const offset=h.controller.reader.state!.offset;expect(offset).toBeGreaterThan(0);
 h.controller.startSearch();h.controller.paste('old');h.controller.paste('new');
 pending.get('oldnew')!(searchCollection([result('new-match')]));await setImmediate();
 pending.get('old')!(searchCollection([result('obsolete-match')]));pending.get('')!(searchCollection([]));await setImmediate();
 expect(h.controller.selected?.id).toBe('new-match');
 await h.controller.cancelSearch();
 expect(h.controller.selected?.id).toBe('result-one');expect(h.controller.targetIndex).toBe(1);
 expect(h.controller.reader.state?.offset).toBe(offset);
 await h.controller.close();
});

test('semantic ranking retains an explicitly selected attempt, current target and query',async()=>{
 let completeRank:((value:unknown)=>void)|undefined;
 const receipts=[result('first'),result('second')];
 const h=harness(request=>request.action==='inbox.search'?(request.semantic?new Promise(resolve=>completeRank=resolve):searchCollection(receipts)):undefined);
 await startRecent(h.controller);h.controller.startSearch();h.controller.paste('typed query');
 await until(()=>!!completeRank);
 await h.controller.input('',{name:'down'});h.controller.selectTarget(1);
 completeRank!(searchCollection([receipts[1]!,receipts[0]!],'ranked'));await setImmediate();
 expect(h.controller.selected?.id).toBe('second');expect(h.controller.targetIndex).toBe(1);expect(h.controller.searchQuery).toBe('typed query');
 await h.controller.close();
});

test('search UI has mouse entry and clear even for long queries; keyboard choosing opens content',async()=>{
 const receipt=result('found',{sourceTitle:'Original capture title'});
 const h=harness(request=>request.action==='inbox.search'?searchCollection([receipt],'unavailable'):undefined);
 await startRecent(h.controller);h.controller.startSearch();h.controller.paste('x'.repeat(200));await setImmediate();
 const lines=renderInboxFrame(h.controller,80,32,'help');
 const links=lines.flatMap(line=>Array.from({length:80},(_,col)=>getOsc8LinkAtColumn(line,col)));
 expect(links).toContain('pi-outliner-action:tree.inbox.search.clear');
 expect(stripTerminalSequences(lines.join('\n'))).toContain('found');
 await h.controller.input('',{name:'return',meta:true});
 expect(h.opened).toEqual([{id:'output-found',destination:'detail'}]);
 await h.controller.cancelSearch();expect(h.controller.searching).toBe(false);await h.controller.close();
});

test('undo from search refreshes receipt state without losing search context',async()=>{
 let undone=false;
 const h=harness(request=>{
  if(request.action==='inbox.search')return searchCollection([result('found',{state:undone?'undone':'applied'})]);
  if(request.action==='inbox.undo'){undone=true;return status();}
 });
 await startRecent(h.controller);h.controller.startSearch();h.controller.paste('query');await setImmediate();
 await h.controller.input('',{name:'return'});await h.controller.input('u',{name:'u'});await setImmediate();
 expect(h.controller.searching).toBe(true);expect(h.controller.selected?.state).toBe('undone');
 await h.controller.close();
});

test('choosing Source on the initial match owns that receipt while semantic ranking finishes',async()=>{
 let finish:((value:unknown)=>void)|undefined;const receipts=[result('first'),result('second')];
 const h=harness(request=>request.action==='inbox.search'?(request.semantic?new Promise(resolve=>finish=resolve):searchCollection(receipts)):undefined);
 await startRecent(h.controller);h.controller.startSearch();h.controller.paste('query');await until(()=>!!finish);
 h.controller.selectTarget(2);await setImmediate();
 finish!(searchCollection([receipts[1]!,receipts[0]!],'ranked'));await setImmediate();
 expect(h.controller.selected?.id).toBe('first');expect(h.controller.targets[h.controller.targetIndex]?.id).toBe('source-first');
 h.controller.notice='Pane startup timed out';
 expect(stripTerminalSequences(renderInboxFrame(h.controller,120,32,'help').join('\n'))).toContain('Pane startup timed out');
 await h.controller.close();
});

test('combined review shows activity and independent source/output readers with mouse resizing and focus',async()=>{
 const h=harness(request=>{
  if(request.action==='get')return {id:request.blockId,text:request.blockId+'\n\n'+Array.from({length:70},(_,i)=>`Paragraph ${i}`).join('\n\n'),revision:2};
  if(request.action==='inbox.result')return {...result(request.resultId),beforeSource:{id:'source-result-one',revision:1,text:'Original rough capture\n\n> [!note] Saved words\n> Before cleanup'}};
 });
 await startRecent(h.controller);await setImmediate();
 let lines=renderInboxFrame(h.controller,160,55,'help');
 expect(h.controller.comparison).toBe(true);
 expect(stripTerminalSequences(lines.join('\n'))).toContain('Created a task and filed');
 expect(h.controller.sourceFrame!.rect.y).toBe(h.controller.outputFrame!.rect.y);
 expect(h.controller.sourceFrame!.rect.y).toBeGreaterThan(h.controller.activityRect!.y+h.controller.activityRect!.height);
 const click=(x:number,y:number)=>h.controller.handlePreviewMouse(`\x1b[<0;${x+1};${y+1}M`,()=>{});
 const source=h.controller.sourceFrame!,output=h.controller.outputFrame!;
 click(source.content.x+2,source.content.y+2);expect(h.controller.sourceReader.state?.focused).toBe(true);expect(h.controller.outputReader.state?.focused).toBe(false);
 await h.controller.input('',{name:'down'});expect(h.controller.sourceReader.state!.offset).toBe(1);expect(h.controller.outputReader.state!.offset).toBe(0);
 click(output.content.x+2,output.content.y+2);expect(h.controller.outputReader.state?.focused).toBe(true);expect(h.controller.sourceReader.state?.focused).toBe(false);
 await h.controller.input('',{name:'down'});expect(h.controller.outputReader.state!.offset).toBe(1);
 click(4,6);expect(h.controller.outputReader.state?.focused).toBe(false);
 const divider=h.controller.horizontalDivider!;click(divider.x,divider.y);
 h.controller.handlePreviewMouse(`\x1b[<32;10;30M`,()=>{});h.controller.handlePreviewMouse(`\x1b[<0;10;30m`,()=>{});
 renderInboxFrame(h.controller,160,55,'help');expect(h.controller.sourceFrame!.rect.y).toBeGreaterThan(source.rect.y);
 const split=h.controller.verticalDivider!;click(split.x,split.y+3);
 h.controller.handlePreviewMouse(`\x1b[<32;105;40M`,()=>{});h.controller.handlePreviewMouse(`\x1b[<0;105;40m`,()=>{});
 renderInboxFrame(h.controller,160,55,'help');expect(h.controller.sourceFrame!.rect.width).toBeGreaterThan(source.rect.width);
 h.controller.setSourceVersion('before');await setImmediate();
 lines=renderInboxFrame(h.controller,160,55,'help');expect(stripTerminalSequences(lines.join('\n'))).toContain('before this attempt');expect(stripTerminalSequences(lines.join('\n'))).toContain('Saved words');
 expect(h.controller.sourceReader.state!.document.projectedText).toContain('Original rough capture');
 h.controller.setSourceVersion('current');await setImmediate();expect(h.controller.sourceReader.state!.document.projectedText).toContain('source-result-one');
 await h.controller.close();
});

test.each(['horizontal','vertical'] as const)('cancels %s divider resizing when comparison disappears',async(axis)=>{
 const h=harness();await startRecent(h.controller);await setImmediate();
 const mouse=(phase:string,x:number,y:number)=>h.controller.handlePreviewMouse(`\x1b[<${phase==='move'?32:0};${x+1};${y+1}${phase==='up'?'m':'M'}`,()=>{});
 for(const phase of ['move','up']){
  renderInboxFrame(h.controller,160,55,'help');
  const divider=axis==='horizontal'?h.controller.horizontalDivider!:h.controller.verticalDivider!;
  mouse('down',divider.x,divider.y);
  const fractions=[h.controller.reviewFraction,h.controller.sourceFraction];
  renderInboxFrame(h.controller,90,34,'help');expect(h.controller.reviewBody).toBeUndefined();
  mouse(phase,4,6);
  renderInboxFrame(h.controller,160,55,'help');
  expect(mouse('down',4,6)).toBe(false);
  expect([h.controller.reviewFraction,h.controller.sourceFraction]).toEqual(fractions);
  mouse('up',4,6);
 }
 await h.controller.close();
});

test('releasing a divider over the source toolbar ends resizing',async()=>{
 const h=harness();await startRecent(h.controller);await setImmediate();
 const lines=renderInboxFrame(h.controller,160,55,'help');
 const source=h.controller.sourceFrame!,divider=h.controller.verticalDivider!;
 const row=source.rect.y+1;
 let column=source.rect.x;
 while(column<source.rect.x+source.rect.width&&getOsc8LinkAtColumn(lines[row]!,column)!=='pi-outliner-action:tree.inbox.preview.before')column++;
 expect(column).toBeLessThan(source.rect.x+source.rect.width);
 h.controller.handlePreviewMouse(`\x1b[<0;${divider.x+1};${divider.y+1}M`,()=>{});
 h.controller.handlePreviewMouse(`\x1b[<0;${column+1};${row+1}m`,()=>{});
 const fraction=h.controller.sourceFraction;
 expect(h.controller.handlePreviewMouse('\x1b[<0;5;7M',()=>{})).toBe(false);
 expect(h.controller.sourceFraction).toBe(fraction);
 expect(h.controller.sourceVersion).toBe('current');
 await h.controller.close();
});

test('source-only comparison spans bottom; missing historical source is explicit and stale notices clear',async()=>{
 const h=harness(request=>request.action==='inbox.result'?result(request.resultId):undefined);
 await h.controller.start();await setImmediate();
 h.controller.nextOutput();expect(h.controller.notice).toContain('No separate output');
 h.controller.selectTarget(0);expect(h.controller.notice).toBe('');
 renderInboxFrame(h.controller,150,50,'help');expect(h.controller.outputFrame).toBeUndefined();expect(h.controller.sourceFrame!.rect.width).toBe(146);
 h.controller.setSourceVersion('before');await setImmediate();expect(h.controller.sourceReader.state!.document.projectedText).toContain('No saved source before this attempt');
 for(const [width,height] of [[40,20],[90,34],[120,20]]){
  const lines=renderInboxFrame(h.controller,width!,height!,'help');expect(lines.length).toBe(height!);expect(lines.every(line=>visibleWidth(line)<=width!)).toBe(true);expect(h.controller.comparison).toBe(false);
 }
 await h.controller.close();
});

test('comparison cancel restores both offsets, output choice and source version; historical scrolling survives live events',async()=>{
 const receipts=[result('match')];
 const h=harness(request=>{
  if(request.action==='get')return {id:request.blockId,text:request.blockId+'\n\n'+Array.from({length:100},(_,i)=>`Paragraph ${i}`).join('\n\n'),revision:2};
  if(request.action==='inbox.search')return searchCollection(receipts);
  if(request.action==='inbox.result')return {...result(request.resultId),beforeSource:{id:'before',revision:1,text:Array.from({length:100},(_,i)=>`Old paragraph ${i}`).join('\n\n')}};
 });
 await startRecent(h.controller);await setImmediate();h.controller.selectTarget(1);await setImmediate();
 renderInboxFrame(h.controller,160,55,'help');
 h.controller.sourceReader.scroll(5,77,24);h.controller.outputReader.scroll(8,78,24);
 h.controller.selectTarget(2);h.controller.focusReader(true);h.controller.startSearch();h.controller.paste('match');await setImmediate();
 h.controller.setSourceVersion('before');await setImmediate();await h.controller.cancelSearch();
 expect(h.controller.sourceVersion).toBe('current');expect(h.controller.outputTarget?.id).toBe('second-result-one');
 expect(h.controller.sourceReader.state?.offset).toBe(5);expect(h.controller.outputReader.state?.offset).toBe(8);expect(h.controller.sourceReader.state?.focused).toBe(true);
 h.controller.setSourceVersion('before');await setImmediate();renderInboxFrame(h.controller,160,55,'help');h.controller.scrollPreview(15);
 const document=h.controller.sourceReader.state!.document;h.controller.contentChanged();await setImmediate();
 expect(h.controller.sourceReader.state?.offset).toBe(15);expect(h.controller.sourceReader.state?.document).toBe(document);
 await h.controller.close();
});

test('copy retains the originating reader across the other reader and source toolbar',async()=>{
 const h=harness(request=>request.action==='get'?{id:request.blockId,text:request.blockId+'\n\nDistinct content words',revision:1}:undefined);
 await startRecent(h.controller);await setImmediate();renderInboxFrame(h.controller,160,55,'help');
 const source=h.controller.sourceFrame!,output=h.controller.outputFrame!;const copies:string[]=[];
 const mouse=(phase:string,x:number,y:number)=>h.controller.handlePreviewMouse(`\x1b[<${phase==='move'?32:0};${x+1};${y+1}${phase==='up'?'m':'M'}`,text=>copies.push(text));
 mouse('down',output.content.x+8,output.content.y);mouse('move',source.content.x+5,source.content.y);mouse('up',source.content.x+5,source.content.y);
 expect(copies).toHaveLength(1);expect(copies[0]).not.toContain('source-');expect(h.controller.outputReader.state?.focused).toBe(true);
 renderInboxFrame(h.controller,160,55,'help');
 mouse('down',source.content.x+8,source.content.y);mouse('move',source.rect.x+2,source.rect.y+1);mouse('up',source.rect.x+2,source.rect.y+1);
 expect(copies).toHaveLength(2);expect(h.controller.sourceVersion).toBe('current');
 const count=h.invalidations;h.controller.toggleTechnicalDetails();expect(h.invalidations).toBeGreaterThan(count);
 await h.controller.close();
});

test.each([{outputIds:[]},{outputIds:['output-result-one','second-result-one']}])('cancel restores absolute historical offset for reused receipt %j',async({outputIds})=>{
 const receipt=result('result-one',{outputIds:[...outputIds]});
 const h=harness(request=>{
  if(request.action==='inbox.status')return status({attentionCount:0,attentionOnly:request.attentionOnly===true,results:request.attentionOnly?[]:[receipt]});
  if(request.action==='inbox.search')return searchCollection([receipt]);
  if(request.action==='inbox.result')return {...receipt,beforeSource:{id:receipt.sourceId,revision:1,text:Array.from({length:100},(_,i)=>`Old paragraph ${i}`).join('\n\n')}};
 });
 await startRecent(h.controller);h.controller.setSourceVersion('before');await setImmediate();renderInboxFrame(h.controller,160,55,'help');h.controller.scrollPreview(5);
 h.controller.startSearch();h.controller.paste('same receipt');await setImmediate();h.controller.selectTarget(outputIds.length);await setImmediate();renderInboxFrame(h.controller,160,55,'help');h.controller.scrollPreview(3);
 await h.controller.cancelSearch();expect(h.controller.sourceReader.state?.offset).toBe(5);await h.controller.close();
});

test('divider drag ends when comparison disappears before pointer release', async()=>{
 const h=harness();await startRecent(h.controller);await setImmediate();
 renderInboxFrame(h.controller,160,55,'help');
 const divider=h.controller.horizontalDivider!;
 h.controller.handlePreviewMouse(`\x1b[<0;${divider.x+1};${divider.y+1}M`,()=>{});
 renderInboxFrame(h.controller,65,25,'help');
 h.controller.handlePreviewMouse('\x1b[<0;10;10m',()=>{});
 renderInboxFrame(h.controller,160,55,'help');
 const before=h.controller.reviewFraction;
 expect(h.controller.handlePreviewMouse('\x1b[<0;5;7M',()=>{})).toBe(false);
 expect(h.controller.reviewFraction).toBe(before);
 await h.controller.close();
});
