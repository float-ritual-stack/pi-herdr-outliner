import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxWorker, assistantActivity, completePropertyInventory } from "../src/inbox-worker";
import { NoteAssistanceRepository } from "../src/note-assistance-repository";
import { InboxRepository } from "../src/inbox-repository";
import type { NoteModel, NoteModelContext } from "../src/note-assistance-model";
import type { InboxModel, InboxUsage, InboxStatus, InboxResult } from "../src/inbox-types";
import { OutlinerStore } from "../src/store";
import { OutlinerServer } from "../src/server";
import { OutlinerClient } from "../src/client";

const fixtures: Array<{ store: OutlinerStore; root: string; worker?: InboxWorker; server?: OutlinerServer }> = [];
const usage: InboxUsage = { provider: "fixture", model: "fixture", inputTokens: 1, outputTokens: 0, cost: 0, jevCalls: 1, elapsedMs: 1 };
const organized = { plan: { summary: "Grouped", type: "note", tags: ["navigation"] }, usage };
const file: InboxModel = async ({ source }) => ({ plan: {
  summary: "Filed", source: { text: source.text, disposition: "file" }, notes: [], tasks: [], updates: [],
}, usage });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "note-worker-"));
  const store = new OutlinerStore(join(root, "outline.sqlite"));
  const value: typeof fixtures[number] = { root, store };
  fixtures.push(value); return value;
}
async function until(condition: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 400; i++) { if (await condition()) return; await Bun.sleep(5); }
  throw new Error("Note worker did not settle");
}
afterEach(async () => {
  for (const value of fixtures.splice(0)) {
    await value.worker?.stop(); await value.server?.close(); value.store.close(); rmSync(value.root, { recursive: true, force: true });
  }
});

test("filed captures and fresh agent notes use one loop without reacting to their own edits", async () => {
  const value = fixture(); const { store } = value;
  const calls: string[] = [];
  value.worker = new InboxWorker(store, file, () => {}, { settleMs: 1, noteModel: async context => {
    calls.push(context.candidate.source.id); return organized;
  } });
  const capture = store.capture("fresh", "Please organize this thought", "cli");
  const authored = store.create("Agent navigation notes", null, "agent", { actorId: "test-agent" });
  value.worker.wake();
  await until(() => value.worker!.status().pending === 0 && !value.worker!.status().current);
  expect(calls.sort()).toEqual([capture.block.id, authored.id].sort());
  expect(value.worker.status().results.filter(result => result.kind === "organized")).toHaveLength(2);
  value.worker.wake(); await Bun.sleep(30);
  expect(calls).toHaveLength(2);
});

test("held Inbox captures cannot escape into note assistance and restart the editorial loop", async () => {
  const value = fixture(); const { store } = value;
  let noteCalls = 0;
  value.worker = new InboxWorker(store, async ({ source }) => ({ plan: {
    summary: "Need direction", source: { text: source.text, disposition: "hold", reason: "Where does this go?" }, notes: [], tasks: [], updates: [],
  }, usage }), () => {}, { settleMs: 1, noteModel: async () => { noteCalls++; return organized; } });
  store.capture("held", "Something unclear", "cli"); value.worker.wake();
  await until(() => value.worker!.status().attentionCount === 1 && !value.worker!.status().current);
  expect(value.worker.status().pending).toBe(0);
  value.worker.wake(); await Bun.sleep(20);
  expect(noteCalls).toBe(1);
});

test("service baselines before provider startup so intervening new notes are still processed", async () => {
  const value = fixture(); const { store, root } = value;
  const old = store.create("An old instruction: enumerate the system");
  const server = value.server = new OutlinerServer(store, join(root, "outline.sock"));
  await server.start();
  const fresh = store.create("A fresh request while the provider loads");
  const seen: string[] = [];
  server.enableInbox(file, async ({ candidate }) => { seen.push(candidate.source.id); return organized; });
  const client = new OutlinerClient(server.socketPath);
  await until(async () => (await client.request<InboxStatus>({ action: "inbox.status" })).results.some(result => result.sourceId === fresh.id));
  expect(seen).toEqual([fresh.id]);
  expect(store.require(old.id)).toEqual(old);
});

test("Pause prevents late answers; an explicit retry of an old note uses the same controls", async () => {
  const value = fixture(); const { store } = value;
  const old = store.create("Old request");
  const entered = Promise.withResolvers<NoteModelContext>();
  const late = Promise.withResolvers<Awaited<ReturnType<NoteModel>>>();
  let calls = 0;
  value.worker = new InboxWorker(store, file, () => {}, { settleMs: 1, noteModel: async context => {
    if (++calls === 1) { entered.resolve(context); return late.promise; }
    expect(context.candidate.instructions).toBe("Answer this now");
    return { plan: { ...organized.plan, fulfillment: { key: "request", operation: "answer", text: "Old request\n\nThe supported answer", summary: "Answered" } }, usage };
  } });
  value.worker.reconsider(old.id, "Answer this now"); await entered.promise;
  value.worker.pause(); late.resolve(organized);
  await until(() => !value.worker!.status().current);
  expect(store.require(old.id)).toEqual(old);
  value.worker.resume();
  await until(() => value.worker!.status().results.some(result => result.kind === "fulfilled"));
  expect(store.require(old.id).text).toContain("The supported answer");
  expect(store.require(old.id).properties).toContainEqual({ key: "request-status", value: "fulfilled" });
});

test("an answer cannot commit after a read dependency changes, even if it rereads that dependency", async () => {
  const value = fixture(); const { store } = value;
  const evidence = store.create("Evidence before");
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  value.worker = new InboxWorker(store, file, () => {}, { settleMs: 1, noteModel: async context => {
    if (context.candidate.source.text.startsWith("Question")) {
      context.read(evidence.id); entered.resolve(); await release.promise;
      context.read(evidence.id);
      return { plan: { ...organized.plan, fulfillment: { key: "question", operation: "answer", text: "Wrong answer", summary: "Answered" } }, usage };
    }
    return organized;
  } });
  const source = store.create("Question about the evidence"); value.worker.wake(); await entered.promise;
  store.update(evidence.id, "Evidence changed", evidence.revision, { author: "user" }); release.resolve();
  await until(() => value.worker!.status().results.some(result => result.sourceId === source.id));
  const result = value.worker.status().results.find(result => result.sourceId === source.id)!;
  expect(result.state).toBe("failed"); expect(store.require(source.id)).toEqual(source);
  expect(value.worker.status().paused).toBe(false);
});

test("combined history paginates globally and note undo survives a model-free restart", async () => {
  const value = fixture(); const { store, root } = value;
  const inbox = new InboxRepository(store); const notes = new NoteAssistanceRepository(store); notes.initialize();
  const expected: string[] = [];
  for (let i = 0; i < 40; i++) {
    if (i % 2) {
      const source = store.create(`Note ${i}`);
      notes.apply(`note-${i}`, notes.pending().find(candidate => candidate.source.id === source.id)!, organized.plan, usage);
      expected.push(`note-${i}`);
    } else {
      const source = store.capture(`capture-${i}`, `Capture ${i}`, "cli").block;
      inbox.fail(`inbox-${i}`, source, "Fixture failure"); expected.push(`inbox-${i}`);
    }
  }
  const first = assistantActivity(store, inbox, notes).results.slice(0, 30);
  const second = assistantActivity(store, inbox, notes, false, 30).results;
  expect([...first, ...second].map(result => result.id).sort()).toEqual(expected.sort());
  const server = value.server = new OutlinerServer(store, join(root, "outline.sock")); await server.start();
  const client = new OutlinerClient(server.socketPath);
  const receipt = await client.request<InboxResult>({ action: "inbox.result", resultId: "note-39" });
  expect(receipt.kind).toBe("organized");
  const status = await client.request<InboxStatus>({ action: "inbox.undo", resultId: receipt.id });
  expect(status.results.find(result => result.id === receipt.id)?.state).toBe("undone");
  expect(notes.pending().some(candidate => candidate.source.id === receipt.sourceId)).toBe(false);
});

test("an inventory read by Pi cannot become fulfilled after the property population changes", async () => {
  const value = fixture(); const { store } = value;
  const counted = store.create("Counted [type::before]");
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  value.worker = new InboxWorker(store, file, () => {}, { settleMs: 1, noteModel: async context => {
    if (!context.candidate.source.text.startsWith("Inventory request")) return organized;
    const inventory = context.inventory("type"); entered.resolve(); await release.promise;
    return { plan: { ...organized.plan, fulfillment: { key: "inventory", operation: "answer",
      text: `Old values: ${inventory.items.map(item => item.value).join(", ")}`, summary: "Inventory answer" } }, usage };
  } });
  const request = store.create("Inventory request"); value.worker.wake(); await entered.promise;
  store.update(counted.id, "Counted [type::after]", counted.revision, { author: "user" }); release.resolve();
  await until(() => value.worker!.status().results.some(result => result.sourceId === request.id));
  expect(value.worker.status().results.find(result => result.sourceId === request.id)?.state).toBe("failed");
  expect(store.require(request.id)).toEqual(request);
});

test("the bounded inventory request consumes all pages in one complete observation", () => {
  const { store } = fixture();
  store.create(`Many classifications\n${Array.from({ length: 1035 }, (_, i) => `[type::value-${i}]`).join(" ")}\n\nBody`);
  const inventory = completePropertyInventory(store, "type");
  expect(inventory.items.length).toBe(inventory.totalValues);
  expect(inventory.items.length).toBeGreaterThan(1000);
  expect(inventory.nextOffset).toBeNull(); expect(inventory.complete).toBe(true);
});

test("explicit Assist processes an ordinary agent note in Inbox when editorial reconsideration refuses it", async () => {
  const value = fixture(); const { store } = value;
  let calls = 0;
  value.worker = new InboxWorker(store, file, () => {}, { settleMs: 1, noteModel: async context => {
    calls++;
    expect(context.candidate.explicitReconsideration).toBe(true);
    expect(context.candidate.instructions).toBe("Answer the request now");
    return { plan: { ...organized.plan, fulfillment: {
      key: "direct-inbox-request", operation: "answer", text: `${context.candidate.source.text}\n\nThe requested answer.`, summary: "Answered",
    } }, usage };
  } });
  const inbox = store.queryBlocks({ filters: [{ key: "system-view", value: "inbox" }], limit: 1 }).blocks[0]!;
  const source = store.create("Agent-authored Inbox note [type::note]", inbox.id, "agent", { actorId: "test-agent" });
  expect(value.worker.reconsider(source.id, "Answer the request now").pending).toBe(1);
  await until(() => value.worker!.status().results.some(result => result.sourceId === source.id && result.kind === "fulfilled"));
  expect(calls).toBe(1);
  expect(store.require(source.id).text).toContain("The requested answer.");
  expect(store.require(source.id).parentId).toBe(inbox.id);
  expect(value.worker.status().pending).toBe(0);
  value.worker.wake(); await Bun.sleep(20);
  expect(calls).toBe(1);
});

test("one Inbox receipt undoes filing, splitting and metadata after automatic work drains", async () => {
  const value = fixture(); const { store } = value;
  value.worker = new InboxWorker(store, async () => ({ plan: {
    summary: "Split the mixed note", source: { text: "Cleaned primary note", disposition: "file" },
    notes: [{ text: "Secondary design [type::design-note]\n\nPreserve the design rationale." }], tasks: [], updates: [],
  }, usage }), () => {}, { settleMs: 1, noteModel: async () => organized });
  const source = store.capture("single-undo", "Original messy note", "cli").block;
  value.worker.wake(); await until(() => !value.worker!.status().pending && !value.worker!.status().current);
  const results = value.worker.status().results;
  expect(results).toHaveLength(1);
  const result = results[0]!;
  expect(result.outputIds).toHaveLength(1);
  expect(store.require(source.id).text).toContain("[tag::navigation]");
  value.worker.repository.undo(result.id, blocks => value.worker!.notes!.checkpointRestored(blocks));
  expect(store.require(source.id).text).toBe(source.text);
  expect(store.require(source.id).parentId).toBe(source.parentId);
  expect(store.get(result.outputIds[0]!)?.effectiveDeletedRootId).toBeTruthy();
  expect(value.worker.status().pending).toBe(0);
});

test("later human edits still prevent Undo of a combined Inbox operation", async () => {
  const value = fixture(); const { store } = value;
  value.worker = new InboxWorker(store, file, () => {}, { settleMs: 1, noteModel: async () => organized });
  const source = store.capture("changed-undo", "Original note", "cli").block;
  value.worker.wake(); await until(() => !value.worker!.status().pending && !value.worker!.status().current);
  const result = value.worker.status().results[0]!;
  const current = store.require(source.id);
  store.update(source.id, `${current.text}\n\nA later human addition`, current.revision, { author: "user" });
  expect(() => value.worker!.repository.undo(result.id)).toThrow("changed");
});

test("a fresh ordinary agent note in Inbox is automatically handled by the note path", async () => {
  const value = fixture(); const { store } = value;
  let calls = 0;
  value.worker = new InboxWorker(store, file, () => {}, { settleMs: 1, noteModel: async () => { calls++; return organized; } });
  const inbox = store.database.query("SELECT block_id FROM block_properties WHERE key = 'system-view' AND value = 'inbox'").get() as { block_id: string };
  const source = store.create("Agent note [type::note]\n\nA useful observation", inbox.block_id, "agent", { actorId: "another-agent" });
  value.worker.wake(); await until(() => value.worker!.status().results.some(result => result.sourceId === source.id));
  expect(calls).toBe(1);
  expect(store.require(source.id).parentId).toBe(inbox.block_id);
});

test("an unsupported execution request can still become backlog work through Inbox triage", async () => {
  const value = fixture(); const { store } = value;
  store.configureWorkIdPrefix("PIE");
  store.create("Work [type::work-queue] [project::test]");
  let editorialCalls = 0;
  value.worker = new InboxWorker(store, async ({ source }) => {
    editorialCalls++;
    return { plan: {
      summary: "Recorded the bookmark bug for future implementation.",
      source: { disposition: "archive", text: source.text }, notes: [], updates: [],
      tasks: [{ title: "Fix bookmark removal", body: "Selecting a bookmark must not remove it.",
        priority: "medium", project: "test", arc: "workflow", tracks: ["workflow"] }],
    }, usage };
  }, () => {}, { settleMs: 1, noteModel: async () => ({ plan: {
    ...organized.plan, unfulfilledRequest: { key: "code-change", reason: "Code changes are not executed by note assistance." },
  }, usage }) });
  const source = store.capture("code-request", "Please fix the bookmark removal bug.", "cli").block;
  value.worker.wake(); await until(() => !value.worker!.status().pending && !value.worker!.status().current);
  expect(editorialCalls).toBe(1);
  const result = value.worker.status().results[0]!;
  expect(result.state).toBe("applied"); expect(result.kind).toBe("unfulfilled");
  expect(result.summary).toContain("Recorded the bookmark bug");
  expect(store.require(result.outputIds[0]!).properties).toContainEqual(expect.objectContaining({ key: "work-stage", value: "unprioritized" }));
  expect(store.require(source.id).properties).toContainEqual(expect.objectContaining({ key: "request-status", value: "open" }));
  expect(value.worker.status().attentionCount).toBe(1);
  expect(value.worker.status().results).toHaveLength(1);
});

test("attention follows the latest operation when a filed request is reconsidered without a new revision", () => {
  const { store } = fixture();
  const inbox = new InboxRepository(store); const notes = new NoteAssistanceRepository(store); notes.initialize();
  const source = store.capture("open-request", "Please perform an unsupported action.", "cli").block;
  const candidate = notes.candidateFor(source.id)!;
  const plan = { ...organized.plan, unfulfilledRequest: { key: "unsupported", reason: "Not executed" } };
  store.database.transaction(() => {
    const result = inbox.apply("inbox-open", source, {
      summary: "Filed for follow-up", source: { disposition: "file", text: source.text }, notes: [], tasks: [], updates: [],
    }, usage, { candidate, plan });
    notes.checkpointEditorial(result, candidate, plan);
  })();
  expect(assistantActivity(store, inbox, notes, true).attentionCount).toBe(1);
  notes.reconsider(source.id);
  notes.fail("note-failed", notes.pending()[0]!, "Provider unavailable");
  const attention = assistantActivity(store, inbox, notes, true);
  expect(attention.attentionCount).toBe(1);
  expect(attention.results.map(result => result.id)).toEqual(["note-failed"]);
  notes.reconsider(source.id);
  notes.apply("note-organized", notes.pending()[0]!, organized.plan);
  expect(assistantActivity(store, inbox, notes, true).attentionCount).toBe(0);
});

test('Inbox cheap routes preserve useful content, archive only reversibly, and expose decisions on receipts',async()=>{
 const value=fixture();const {store}=value;let pi=0;
 value.worker=new InboxWorker(store,async context=>{pi++;return file(context);},()=>{},{settleMs:1,noteModel:async ({candidate,routeInbox})=>{
  expect(routeInbox).toEqual({hasChildren:false});
  const route=candidate.source.text.startsWith('aaaa')?'archive':candidate.source.text.startsWith('Reference')?'metadata':'keep';
  return {plan:{summary:'Organized note metadata',tags:route==='metadata'?['sqlite']:[],...(route==='metadata'?{type:'reference'}:{}),inboxRoute:{route,reason:`Fixture ${route}`}},usage};
 }});
 const sources=['aaaa','Milk and coffee [tag::shopping]','Reference: SQLite transactions'].map((text,index)=>store.capture(`routing-${index}`,text,'cli').block);
 value.worker.wake();await until(()=>value.worker!.status().pending===0&&!value.worker!.status().current);
 expect(pi).toBe(0);expect(value.worker.status().results).toHaveLength(3);
 expect(store.require(sources[1]!.id).text).toContain('Milk and coffee');
 expect(store.require(sources[1]!.id).properties.filter(p=>p.key==='tag')).toEqual([{key:'tag',value:'shopping'}]);
 expect(store.require(sources[1]!.id).properties.some(p=>p.key==='type'&&p.value==='note')).toBe(false);
 expect(store.require(sources[2]!.id).properties).toContainEqual({key:'type',value:'reference'});
 const archived=value.worker.repository.results().find(result=>result.sourceId===sources[0]!.id)!;
 expect(archived.routing?.route).toBe('archive');expect(store.require(store.require(sources[0]!.id).parentId!).text).toContain('Processed');
 value.worker.repository.undo(archived.id,blocks=>value.worker!.notes!.checkpointRestored(blocks));
 expect(store.require(sources[0]!.id).text).toBe(sources[0]!.text);expect(store.require(sources[0]!.id).parentId).toBe(sources[0]!.parentId);
 value.worker.wake();await Bun.sleep(20);expect(value.worker.status().pending).toBe(0);
});

test('editorial routing remains visible when Pi fails and does not silently archive the source',async()=>{
 const value=fixture();const {store}=value;
 value.worker=new InboxWorker(store,async()=>{throw Error('provider unavailable');},()=>{},{settleMs:1,noteModel:async()=>({plan:{summary:'Inspect',tags:[],inboxRoute:{route:'editorial',reason:'Ambiguous short note'}},usage})});
 const source=store.capture('unclear','did a thing','cli').block;value.worker.wake();await until(()=>value.worker!.status().state==='unavailable');
 expect(value.worker.status().results[0]?.routing).toEqual({route:'editorial',reason:'Ambiguous short note'});expect(store.require(source.id)).toEqual(source);
});
