import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type ToolCall } from "@earendil-works/pi-ai";
import { checkInboxModelConfiguration, inboxEditingBudget, createInboxModel, InboxModelUnavailableError, type InboxModelOptions } from "../src/inbox-model";
import type { InboxModelContext, InboxPlan, InboxUsage } from "../src/inbox-types";
import type { Block } from "../src/types";
import { DEFAULT_AI_PROMPT_DIRECTORY, PromptFileError } from "../src/ai-prompts";
import { InboxWorker } from "../src/inbox-worker";
import { OutlinerStore } from "../src/store";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

function block(id: string, text: string, overrides: Partial<Block> = {}): Block {
  return { id, text, parentId: null, revision: 1, position: 0, properties: [], author: "user", createdAt: "2026-09-20", updatedAt: "2026-09-20", ...overrides };
}
const source = block("capture", "Shopping\nuh, oats and limes");
const filed: InboxPlan = {
  summary: "Cleaned the shopping list", source: { disposition: "file", text: "Shopping\n- Oats\n- Limes" },
  notes: [], tasks: [], updates: [],
};
const call = (name: string, args: Record<string, unknown>): ToolCall => ({ type: "toolCall", id: crypto.randomUUID(), name, arguments: args });

function message(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "toolUse"): AssistantMessage {
  return {
    role: "assistant", api: "openai-responses", provider: "openai", model: "gpt-4.1", content, stopReason, timestamp: Date.now(),
    usage: { input: 100, output: 20, cacheRead: 10, cacheWrite: 0, totalTokens: 130, cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 } },
  };
}
function streamMessage(value: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  if (value.stopReason === "error" || value.stopReason === "aborted") stream.push({ type: "error", reason: value.stopReason, error: value });
  else stream.push({ type: "done", reason: value.stopReason as "toolUse", message: value });
  return stream;
}
function scripted(steps: Array<ToolCall[] | ((context: Context) => ToolCall[])>): NonNullable<InboxModelOptions["stream"]> {
  let turn = 0;
  return (_model, context) => {
    const step = steps[turn++];
    if (!step) throw new Error("Unexpected model continuation");
    return streamMessage(message(typeof step === "function" ? step(context) : step));
  };
}
function lastResult(context: Context) {
  const last = context.messages.at(-1)!;
  if (last.role !== "toolResult") throw new Error("Expected tool result");
  return { last, value: JSON.parse(last.content.filter(c => c.type === "text").map(c => c.text).join("")) };
}

async function rejected(promise: Promise<unknown>): Promise<Error & { usage?: InboxUsage }> {
  try { await promise; }
  catch (error) { if (error instanceof Error) return error; throw error; }
  throw new Error("Expected the editor to reject this request");
}

async function fixture(options: Partial<InboxModelOptions> = {}, values: Partial<InboxModelContext> = {}) {
  const root = await mkdtemp(join(tmpdir(), "inbox-model-")); roots.push(root);
  const agentDir = join(root, "agent"); await mkdir(agentDir);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-4.1", defaultThinkingLevel: "off" }));
  // A local fixture credential satisfies discovery. Every provider stream is replaced below.
  await writeFile(join(agentDir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "inbox-test-not-a-real-key" } }));
  const modelOptions: InboxModelOptions = {
    workspaceRoot: root, agentDir, sessionDirectory: join(root, "sessions"), jevApiKey: "", stream: scripted([[call("search_notes", { query: "shopping" })], [call("finish_cleanup", filed as unknown as Record<string, unknown>)]]),
    ...options,
  };
  const context: InboxModelContext = { source, read: () => null, search: () => [], signal: new AbortController().signal, progress() {}, ...values };
  return { root, agentDir, options: modelOptions, context, run: () => createInboxModel(modelOptions)(context) };
}

describe("Inbox editorial model", () => {
  test("configures a finite total editing budget", () => {
    expect(inboxEditingBudget({})).toBe(300_000);
    expect(inboxEditingBudget({OUTLINER_INBOX_TIMEOUT_MS:"420000"})).toBe(420_000);
    for (const value of ["", "0", "-1", "NaN", "Infinity", "1.5", "1800001"]) {
      expect(() => inboxEditingBudget({OUTLINER_INBOX_TIMEOUT_MS:value})).toThrow("OUTLINER_INBOX_TIMEOUT_MS");
    }
  });

  test("deadline fails only A, then the same worker completes B without retrying A", async () => {
    const attempts: string[] = [];
    const f = await fixture({ timeoutMs:80, stream:(_model, context) => {
      const user = context.messages.find(m=>m.role === "user")!;
      const content = typeof user.content === "string" ? user.content : user.content.filter(p=>p.type === "text").map(p=>p.text).join("");
      const input = JSON.parse(content).source;
      if(context.messages.at(-1)?.role === "user") attempts.push(input.id);
      if(input.text.startsWith("A stalls")) return createAssistantMessageEventStream();
      return context.messages.at(-1)?.role === "user"
        ? streamMessage(message([call("search_notes",{query:"shopping"})]))
        : streamMessage(message([call("finish_cleanup",{...filed,source:{text:input.text,disposition:"file"}})]));
    }});
    const store = new OutlinerStore(join(f.root,"worker.sqlite"),{workspaceRoot:f.root});
    const worker = new InboxWorker(store,createInboxModel(f.options),()=>{},{settleMs:1});
    try {
      const a=store.capture("A","A stalls\nKeep original.","cli").block;
      worker.wake();
      for(let i=0;i<200 && !worker.status().results.length;i++) await Bun.sleep(5);
      const b=store.capture("B","B succeeds\nOther work.","cli").block;
      worker.wake();
      for(let i=0;i<200 && worker.status().results.length<2;i++) await Bun.sleep(5);
      const status=worker.status();
      expect(status.results.map(r=>r.state)).toEqual(["applied","failed"]);
      expect(status.results[1]!.error).toContain("timed out");
      expect(status.results[1]!.usage!.piSessions![0]!.path).toBeTruthy();
      expect(status.paused).toBe(false);expect(status.state).toBe("idle");
      expect(status.attentionCount).toBe(1);expect(status.pending).toBe(0);
      expect(store.require(a.id)).toEqual(a);
      expect(store.require(b.id).properties.some(p=>p.key === "status" && p.value === "processed")).toBe(true);
      worker.wake();await Bun.sleep(30);expect(attempts).toEqual([a.id,b.id]);
    } finally {await worker.stop();store.close();}
  });

  test("a configured larger total budget allows the same delayed multi-turn edit to finish", async () => {
    const run=async(timeoutMs:number) => {
      let turn=0;
      const f=await fixture({timeoutMs,stream:()=>{
        const stream=createAssistantMessageEventStream();
        const next=++turn === 1 ? [call("search_notes",{query:"shopping"})] : [call("finish_cleanup",filed as unknown as Record<string,unknown>)];
        setTimeout(()=>{stream.push({type:"done",reason:"toolUse",message:message(next)});stream.end();},50);
        return stream;
      }});
      return f.run();
    };
    const failure=await rejected(run(40));
    expect(failure.name).toBe("InboxNoteError");expect(failure.message).toContain("40 ms");
    const success=await run(500);expect(success.plan).toEqual(filed);
    expect(success.usage.piSessions![0]!.outcome).toBe("completed");
  });

  test("retains distinct native sessions and reopens completed turns in another process", async () => {
    const f = await fixture();
    const first = await f.run();
    // Each attempt creates its own SDK/session, even for the same source revision.
    const second = await createInboxModel({ ...f.options, stream: scripted([
      [call("search_notes", { query: "shopping" })],
      [call("finish_cleanup", filed as unknown as Record<string, unknown>)],
    ]) })(f.context);
    const a = first.usage.piSessions![0]!;
    const b = second.usage.piSessions![0]!;
    expect(a.outcome).toBe("completed");
    expect(a.id).not.toBe(b.id);
    expect(a.path).not.toBe(b.path);
    const child = Bun.spawn([process.execPath, "-e", `
      import {SessionManager} from "@earendil-works/pi-coding-agent";
      const session=SessionManager.open(process.argv[1]);
      console.log(JSON.stringify({id:session.getSessionId(),entries:session.getEntries()}));
    `, a.path!], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
    const reopened = JSON.parse(await new Response(child.stdout).text());
    expect(await child.exited).toBe(0);
    expect(reopened.id).toBe(a.id);
    const messages = reopened.entries.filter((entry: {type:string}) => entry.type === "message");
    expect(messages.some((entry: {message:{role:string}}) => entry.message.role === "user")).toBe(true);
    expect(messages.filter((entry: {message:{role:string}}) => entry.message.role === "assistant")).toHaveLength(2);
    expect(messages.some((entry: {message:{role:string;toolName:string}}) => entry.message.role === "toolResult" && entry.message.toolName === "search_notes")).toBe(true);
  });

  test("a deadline before the first reply preserves only actual native entries", async () => {
    const f = await fixture({ timeoutMs: 80, stream: () => createAssistantMessageEventStream() });
    const failure = await rejected(f.run());
    expect(failure.message).toContain("timed out");
    const retained = failure.usage!.piSessions![0]!;
    expect(retained).toMatchObject({ outcome: "failed", snapshot: true });
    const entries = SessionManager.open(retained.path!).getEntries();
    expect(entries.some(entry => entry.type === "message" && entry.message.role === "user")).toBe(true);
    expect(entries.some(entry => entry.type === "message" && entry.message.role === "assistant")).toBe(false);
    expect(retained.warning).toContain("partial streamed output");
    expect(f.context.source.text).toBe(source.text);
  });

  test("cancellation after a tool preserves its completed transcript and reports it before returning", async () => {
    const abort = new AbortController();
    let reported: InboxUsage | undefined;
    let turn = 0;
    const f = await fixture({ stream: () => {
      if (++turn === 1) return streamMessage(message([call("search_notes", {query:"shopping"})]));
      abort.abort();
      return createAssistantMessageEventStream();
    } }, {signal:abort.signal, reportUsage: value => { reported = value; }});
    const failure = await rejected(f.run());
    expect(failure.message).toContain("canceled");
    const retained = failure.usage!.piSessions![0]!;
    expect(reported?.piSessions?.[0]).toEqual(retained);
    expect(retained.outcome).toBe("canceled");
    const entries = SessionManager.open(retained.path!).getEntries();
    expect(entries.some(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "search_notes")).toBe(true);
    expect(f.context.source.text).toBe(source.text);
  });

  test("the worker retains an early canceled session without suppressing the pending capture", async () => {
    const entered = Promise.withResolvers<void>();
    const f = await fixture({ stream: () => { entered.resolve(); return createAssistantMessageEventStream(); } });
    const store = new OutlinerStore(join(f.root, "worker.sqlite"), {workspaceRoot:f.root});
    const worker = new InboxWorker(store,createInboxModel(f.options),()=>{},{settleMs:1});
    try {
      const captured = store.capture("early-cancel", "Keep this original", "cli").block;
      worker.wake(); await entered.promise; worker.pause();
      for(let i=0;i<100 && worker.status().current;i++)await Bun.sleep(5);
      const status=worker.status();
      expect(status.current).toBeUndefined();
      expect(status.results[0]!.state).toBe("canceled");
      const session=status.results[0]!.usage!.piSessions![0]!;
      expect(session.outcome).toBe("canceled");
      expect(await Bun.file(session.path!).exists()).toBe(true);
      expect(status.pending).toBe(1);
      expect(status.attentionCount).toBe(0);
      expect(store.require(captured.id)).toEqual(captured);
    } finally {await worker.stop();store.close();}
  });

  test("captures prompt files for the entire job and reloads them for the next job", async () => {
    const started = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const instructions: string[] = [];
    const systems: string[] = [];
    let calls = 0;
    const f = await fixture({
      jevApiKey: "fixture",
      fetch: async (_url, init) => {
        const body = JSON.parse(init.body as string);
        instructions.push(body.questions.relationship_0.instructions);
        if (++calls === 1) { started.resolve(); await resume.promise; }
        return Response.json({ answers: {
          relationship_0: { type: "choice", choice: "related", confidence: 0.8, probabilities: { duplicate: 0, related: 1, unrelated: 0 } },
          covered_0: { type: "noul", noul: 0 },
        } });
      },
      stream: scripted([
        context => { systems.push(context.systemPrompt ?? ""); return [call("search_notes", { query: "first" })]; },
        context => { systems.push(context.systemPrompt ?? ""); return [call("search_notes", { query: "second" })]; },
        [call("finish_cleanup", filed as unknown as Record<string, unknown>)],
        context => { systems.push(context.systemPrompt ?? ""); return [call("search_notes", { query: "first" })]; },
        [call("finish_cleanup", filed as unknown as Record<string, unknown>)],
      ]),
    }, { search: query => [block(query, `Shopping ${query}`)] });
    const directory = join(f.root, "prompts");
    await cp(DEFAULT_AI_PROMPT_DIRECTORY, directory, { recursive: true });
    const editor = join(directory, "inbox-editor.md");
    const relationships = join(directory, "inbox-relationships.json");
    const firstEditor = "Edit ordinary notes. Prompt revision A.";
    const secondEditor = "Edit ordinary notes. Prompt revision B.";
    await writeFile(editor, firstEditor);
    const firstQuestions = await readFile(relationships, "utf8");
    const updatedQuestions = JSON.parse(firstQuestions);
    updatedQuestions.relationship.instructions = "Use the revised relationship judgment.";
    const secondQuestions = JSON.stringify(updatedQuestions);
    const model = createInboxModel({ ...f.options, promptDirectory: directory });
    const first = model(f.context);
    await started.promise;
    await writeFile(editor, secondEditor);
    await writeFile(relationships, secondQuestions);
    resume.resolve();
    const a = await first;
    const b = await model(f.context);
    // Pi appends its working-directory context to the supplied system prompt.
    expect(systems[0]).toStartWith(firstEditor + "\n");
    expect(systems[1]).toStartWith(firstEditor + "\n");
    expect(systems[2]).toStartWith(secondEditor + "\n");
    expect(instructions).toHaveLength(3);
    expect(instructions[0]).toBe(instructions[1]);
    expect(instructions[2]).toContain("Use the revised relationship judgment.");
    for (const [result, texts] of [[a, [firstEditor, firstQuestions]], [b, [secondEditor, secondQuestions]]] as const) {
      expect(result.usage.promptRevisions?.map(({packagedSha256,packagedDifferences,...revision})=>revision)).toEqual(texts.map((text, i) => ({
        path: i === 0 ? editor : relationships, text, sha256: createHash("sha256").update(text).digest("hex"),
      })));
    }
  });

  test("an invalid prompt names the file before inference and a corrected file works without recreating the model", async () => {
    const f = await fixture();
    const directory = join(f.root, "prompts");
    await cp(DEFAULT_AI_PROMPT_DIRECTORY, directory, { recursive: true });
    const path = join(directory, "inbox-relationships.json");
    const valid = await readFile(path, "utf8");
    await writeFile(path, "{broken");
    const model = createInboxModel({ ...f.options, promptDirectory: directory });
    const failure = await rejected(model(f.context));
    expect(failure).toBeInstanceOf(PromptFileError);
    expect(failure.message).toContain(path);
    expect(failure.message).toContain("invalid JSON");
    await writeFile(path, valid);
    // The scripted transport is still at its first step: failure made no model call.
    expect((await model(f.context)).plan).toEqual(filed);
  });

  test("runs the real SDK with only bounded note tools and no ambient files, extensions or prompts", async () => {
    const f = await fixture({ stream: scripted([
      context => {
        expect(context.tools?.map(t => t.name).sort()).toEqual(["finish_cleanup", "read_note", "search_notes"]);
        expect(context.systemPrompt).not.toContain("AMBIENT-INJECTION");
        expect(context.systemPrompt).toContain("Most captures are general notes");
        return [call("search_notes", { query: "shopping" })];
      },
      [call("finish_cleanup", filed as unknown as Record<string, unknown>)],
    ]) });
    await writeFile(join(f.root, "AGENTS.md"), "AMBIENT-INJECTION project context");
    await writeFile(join(f.agentDir, "APPEND_SYSTEM.md"), "AMBIENT-INJECTION appended prompt");
    await mkdir(join(f.agentDir, "extensions"));
    await writeFile(join(f.agentDir, "extensions", "never.ts"), "throw new Error('AMBIENT-INJECTION extension executed');");
    const output = await f.run();
    expect(output.plan).toEqual(filed);
    expect(output.usage).toMatchObject({ provider: "openai", model: "gpt-4.1", inputTokens: 220, outputTokens: 40, jevCalls: 0, cost: 0.006 });
    expect(f.context.source.text).toBe(source.text);
  });

  test("requires a search and every current canonical page before accepting replacement text", async () => {
    const existing = block("existing", "a".repeat(12_010), { revision: 4 });
    const merged: InboxPlan = { ...filed, source: { disposition: "archive", text: "Merged shopping detail into ((existing))." }, updates: [{ blockId: existing.id, expectedRevision: 4, text: "Combined note" }] };
    const finish = call("finish_cleanup", merged as unknown as Record<string, unknown>);
    const f = await fixture({ stream: scripted([
      [finish],
      context => { expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", isError: true }); return [call("search_notes", { query: "shopping" })]; },
      [call("read_note", { blockId: "existing" })],
      context => { expect(lastResult(context).value).toMatchObject({ revision: 4, complete: false, nextOffset: 12000 }); return [finish]; },
      context => { expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", isError: true }); return [call("read_note", { blockId: "existing", offset: 12000 })]; },
      [finish],
    ]) }, { read: () => existing, search: () => [existing] });
    expect((await f.run()).plan).toEqual(merged);
    expect(existing.text).toHaveLength(12_010);
  });

  test("does not authorize replacement from pages belonging to different revisions", async () => {
    let reads = 0;
    const merged: InboxPlan = { ...filed, updates: [{ blockId: "existing", expectedRevision: 2, text: "replacement" }] };
    const f = await fixture({ stream: scripted([
      [call("search_notes", { query: "shopping" })],
      [call("read_note", { blockId: "existing" })],
      [call("read_note", { blockId: "existing", offset: 12000 })],
      [call("finish_cleanup", merged as unknown as Record<string, unknown>)],
      context => { expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", isError: true }); return [call("finish_cleanup", filed as unknown as Record<string, unknown>)]; },
    ]) }, { read: () => block("existing", "a".repeat(12_010), { revision: ++reads }) });
    expect((await f.run()).plan.updates).toEqual([]);
  });

  test("asks typed duplicate and coverage questions over actual bounded candidates and accounts for Jev usage", async () => {
    const candidates = Array.from({ length: 8 }, (_, i) => block(`note-${i}`, `Shopping ${i}\nOats and limes, plus detail ${i}.\n` + "More note detail. ".repeat(60)));
    let requests = 0;
    const f = await fixture({
      jevApiKey: "fixture-key",
      fetch: (async (_url, init) => {
        requests++; const body = JSON.parse(init!.body as string);
        expect(body.state.source.text).toBe(source.text);
        expect(body.state.candidates).toHaveLength(6);
        expect(body.state.candidates[0].text).toBe(candidates[0]!.text);
        expect(Object.keys(body.questions)).toHaveLength(12);
        expect(body.questions.relationship_0.type).toBe("choice");
        expect(body.questions.covered_0.type).toBe("noul");
        return Response.json({ answers: Object.fromEntries(candidates.slice(0, 6).flatMap((_, i) => [
          [`relationship_${i}`, { type: "choice", choice: "related", confidence: 0.8, probabilities: { duplicate: 0.1, related: 0.9, unrelated: 0 } }],
          [`covered_${i}`, { type: "noul", noul: 0.15 }],
        ])), usage: { input_tokens: 1000, output_tokens: 100 } });
      }),
      stream: scripted([
        [call("search_notes", { query: "shopping" })],
        context => {
          const value = lastResult(context).value;
          expect(value.candidates).toHaveLength(6);
          expect(value.candidates[0].text).toBe(candidates[0]!.text.slice(0, 900));
          expect(value.candidates[0].complete).toBe(false);
          expect(value.completeness.kind).toBe("bounded");
          expect(value.jev).toMatchObject({ status: "judged", model: "jev-1.13.0" });
          expect(value.jev.relationships[0]).toMatchObject({ blockId: "note-0", relationship: "related", sourceCovered: 0.15 });
          return [call("finish_cleanup", filed as unknown as Record<string, unknown>)];
        },
      ]),
    }, { search: () => [source, block("deleted", "shopping", { deletedAt: "today" }), ...candidates] });
    const output = await f.run();
    expect(requests).toBe(1);
    expect(output.usage).toMatchObject({ inputTokens: 1220, outputTokens: 140, jevCalls: 1 });
    expect(output.usage.cost).toBeCloseTo(0.006042, 8);
    expect(output.usage.notChecked?.some(value=>value.area === "retrieval")).toBe(true);
    expect(output.usage.notChecked?.some(value=>value.area === "Pi candidate reads")).toBe(true);
  });

  test("Jev failures remain an explicit unavailable hint without leaking provider errors", async () => {
    const f = await fixture({ jevApiKey: "fixture", fetch: async () => { throw new Error("SECRET provider body"); },
      stream: scripted([
        [call("search_notes", { query: "shopping" })],
        context => {
          const value = lastResult(context).value;
          expect(value.jev.status).toBe("unavailable");
          expect(JSON.stringify(value)).not.toContain("SECRET");
          return [call("finish_cleanup", filed as unknown as Record<string, unknown>)];
        },
      ]),
    }, { search: () => [block("existing", "Shopping list")] });
    const output = await f.run();
    expect(output.usage.jevCalls).toBe(1);
    expect(output.usage.jevSuccessfulCalls).toBe(0);
    expect(output.usage.jevWarning).toContain("failed");
    expect(output.usage.notChecked).toContainEqual({area:"relationships",reason:output.usage.jevWarning!});
    expect(JSON.stringify(output)).not.toContain("SECRET");
  });

  test("relationship comparisons skipped before a provider call retain the budget omission",async()=>{
    const f=await fixture({jevApiKey:'fixture',maxTotalTokens:12000,fetch:async()=>{throw Error('Should not call the judge');}},
      {search:()=>Array.from({length:6},(_,i)=>block(`budget-note-${i}`,'Long note '+ 'body '.repeat(1500)))});
    const result=await f.run();
    expect(result.usage.jevCalls).toBe(0);
    expect(result.usage.notChecked?.some(value=>value.reason.includes("budget"))).toBe(true);
  });

  test("holds require a precise reason, unchanged source, and no side effects", async () => {
    const hold: InboxPlan = { summary: "Needs a date", source: { text: source.text, disposition: "hold", reason: "Which Saturday does the list refer to?" }, notes: [], tasks: [], updates: [] };
    const invalid = { ...hold, notes: [{ text: "Unexpected extra note" }] };
    const f = await fixture({ stream: scripted([
      [call("finish_cleanup", invalid as unknown as Record<string, unknown>)],
      context => { expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", isError: true }); return [call("finish_cleanup", hold as unknown as Record<string, unknown>)]; },
    ]) });
    expect((await f.run()).plan).toEqual(hold);
  });

  test("turn and token budgets stop the SDK loop and attach observed usage", async () => {
    for (const limit of [{ maxTurns: 1 }, { maxTotalTokens: 100 }]) {
      const f = await fixture({ ...limit, stream: scripted([[call("search_notes", { query: "shopping" })]]) });
      const error = await rejected(f.run());
      expect(error.message).toMatch(/Inbox editor (turn|token) budget exhausted/);
      expect(error.usage).toMatchObject("maxTurns" in limit ? { inputTokens: 110, outputTokens: 20 } : { inputTokens: 0, outputTokens: 0 });
    }
  });

  test("ordinary text is budgeted as tokens rather than one token per source byte", async () => {
    const f = await fixture({ maxTotalTokens: 18_000 }, {
      source: block("capture", "Shopping notes\n" + "Oats and limes. ".repeat(1000)),
    });
    const output = await f.run();
    expect(output.plan).toEqual(filed);
    expect(output.usage.inputTokens).toBe(220);
  });

  test("a research capture can finish after bounded search, Jev comparisons and cached Pi context", async () => {
    const capture = block("capture", "File-record design notes\n" + "Keep Markdown in Git; retain canonical file identities and authored relationships.\n".repeat(180));
    const candidate = block("reference", "Prior file-record design\n" + "One canonical identity per file.\n".repeat(180));
    const plan: InboxPlan = { ...filed, summary: "Filed the design research with its existing reference", source: { disposition: "file", text: "File-record design\nKeep Markdown in Git and retain one canonical identity per file. Related prior design: ((reference))." } };
    let turn = 0;
    const f = await fixture({
      jevApiKey: "fixture",
      fetch: async (_url, init) => {
        const body = JSON.parse(init.body as string);
        return Response.json({ answers: Object.fromEntries(body.state.candidates.flatMap((_candidate: unknown, i: number) => [
          [`relationship_${i}`, { type: "choice", choice: "related", confidence: 0.8, probabilities: { duplicate: 0.1, related: 0.9, unrelated: 0 } }],
          [`covered_${i}`, { type: "noul", noul: 0.1 }],
        ])), usage: { input_tokens: 9000, output_tokens: 100 } });
      },
      stream: () => {
        const calls = turn === 0
          ? Array.from({ length: 4 }, (_, i) => call("search_notes", { query: `file identity ${i}` }))
          : turn === 1 ? [call("read_note", { blockId: "reference" })]
            : [call("finish_cleanup", plan as unknown as Record<string, unknown>)];
        turn++;
        const response = message(calls);
        response.usage = { ...response.usage, input: 6000, cacheRead: 9000, output: 500, totalTokens: 15_500 };
        return streamMessage(response);
      },
    }, {
      source: capture, read: () => candidate,
      search: query => Array.from({ length: 6 }, (_, i) => ({ ...candidate, id: `${query}-${i}` })),
    });
    const output = await f.run();
    expect(output.plan).toEqual(plan);
    expect(output.usage).toMatchObject({ inputTokens: 81_000, outputTokens: 1900, jevCalls: 4, jevSuccessfulCalls: 4 });
    expect(turn).toBe(3);
  });

  test("cancellation aborts a stalled provider and does not return a plan", async () => {
    const controller = new AbortController(); let aborted = false;
    const f = await fixture({ stream: (_model, _context, options) => {
      const stream = createAssistantMessageEventStream();
      options!.signal!.addEventListener("abort", () => { aborted = true; stream.end(message([], "aborted")); }, { once: true });
      queueMicrotask(() => controller.abort());
      return stream;
    } }, { signal: controller.signal });
    const error = await rejected(f.run());
    expect(error.message).toBe("Inbox cleanup canceled"); expect(aborted).toBe(true);
    expect(error.usage?.provider).toBe("openai");
  });

  test("provider failures expose a sanitized unavailable error with observed usage", async () => {
    const f = await fixture({ stream: () => streamMessage({ ...message([], "error"), errorMessage: "SECRET provider response" }) });
    const error = await rejected(f.run());
    expect(error).toBeInstanceOf(InboxModelUnavailableError);
    expect(error.message).not.toContain("SECRET");
    expect(error.usage).toMatchObject({ inputTokens: 110, outputTokens: 20 });
  });

  test("missing configuration is reported before an editor session is started", async () => {
    const f = await fixture(); await rm(join(f.agentDir, "settings.json"));
    expect(await checkInboxModelConfiguration(f.options)).toMatchObject({ configured: false, message: "Inbox needs a configured model in Pi settings" });
    await expect(f.run()).rejects.toBeInstanceOf(InboxModelUnavailableError);
  });

  test("configuration removed after startup leaves a recorded failure and the capture unchanged", async () => {
    const f = await fixture();
    expect(await checkInboxModelConfiguration(f.options)).toMatchObject({ configured: true });
    const store = new OutlinerStore(join(f.root, "outline.sqlite"));
    const finished = Promise.withResolvers<void>();
    const worker = new InboxWorker(store, createInboxModel(f.options), () => {
      if (worker.status().state === "unavailable") finished.resolve();
    }, { settleMs: 1 });
    try {
      const capture = store.capture("configuration-failure", "Remember to return the library book", "cli").block;
      await rm(join(f.agentDir, "settings.json"));
      worker.wake();
      await finished.promise;
      const status = worker.status();
      expect(status.message).toBe("Inbox needs a configured model in Pi settings");
      expect(status.results).toHaveLength(1);
      expect(status.results[0]).toMatchObject({ sourceId: capture.id, state: "failed", error: status.message });
      expect(status.results[0]!.usage).toBeUndefined();
      expect(store.require(capture.id)).toEqual(capture);
    } finally {
      await worker.stop();
      store.close();
    }
  });
});

test("partial Pi reads and bounded Jev input expose distinct limits",async()=>{
 const candidate=block('long','Detail '.repeat(2000));
 const f=await fixture({jevApiKey:'fixture',maxTotalTokens:100000,fetch:async(_url,init)=>{
  const body=JSON.parse(init!.body as string);
  expect(body.state.source.text.length).toBe(18000);
  expect(body.state.candidates[0].text.length).toBe(6000);
  return Response.json({answers:{relationship_0:{type:'choice',choice:'related',confidence:0.9,probabilities:{related:0.9,duplicate:0.05,unrelated:0.05}},covered_0:{type:'noul',noul:0.1}},usage:{input_tokens:100,output_tokens:10}});
 },stream:scripted([
 [call('search_notes',{query:'detail'})],
 [call('read_note',{blockId:'long'})],
 [call('finish_cleanup',filed as unknown as Record<string,unknown>)]
 ])},{source:block('capture','Source '.repeat(3000)),search:()=>[candidate],read:()=>candidate});
 const output=await f.run();
 expect(output.usage.notChecked?.filter(v=>v.area==='Jev input')).toHaveLength(2);
 expect(output.usage.notChecked?.some(v=>v.area==='note reads')).toBe(true);
 expect(output.usage.notChecked?.some(v=>v.area==='Pi candidate reads')).toBe(false);
});

test('finish_cleanup repairs invalid ordinary-note metadata inside one persisted Pi session',async()=>{
 const bad={...filed,notes:[{text:'Wrong [type::field-note] [captured-at::copied]'}]};
 const good={...filed,notes:[{text:'Useful design [type::note]'}]};
 const f=await fixture({stream:scripted([
 [call('search_notes',{query:'design'})],
 [call('finish_cleanup',bad as unknown as Record<string,unknown>)],
 context=>{expect(context.messages.at(-1)).toMatchObject({role:"toolResult",isError:true});return [call('finish_cleanup',good as unknown as Record<string,unknown>)];}
 ])});
 const output=await f.run();expect(output.plan).toEqual(good);
 expect(output.usage.piSessions).toHaveLength(1);
 const log=await readFile(output.usage.piSessions![0]!.path!,'utf8');
 expect(log).toContain('notes[0].text');expect(log).toContain('roadmap allocator');
});

