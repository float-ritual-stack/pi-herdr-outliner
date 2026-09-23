import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxWorker } from "../src/inbox-worker";
import { OutlinerStore } from "../src/store";
import { OutlinerServer } from "../src/server";
import { OutlinerClient } from "../src/client";
import type { InboxModel, InboxModelContext, InboxPlan, InboxResult, InboxStatus, InboxUsage } from "../src/inbox-types";
import type { CaptureReceipt } from "../src/types";

const fixtures: Array<{ root: string; store: OutlinerStore; worker?: InboxWorker; server?: OutlinerServer }> = [];
const usage: InboxUsage = { provider: "fixture", model: "fixture", inputTokens: 1, outputTokens: 1, cost: 0, jevCalls: 0, elapsedMs: 1 };
const plan = (text: string): InboxPlan => ({ summary: "Filed a useful note", source: { text, disposition: "file" }, notes: [], tasks: [], updates: [] });
function fixture(model: InboxModel) {
  const root = mkdtempSync(join(tmpdir(), "outliner-inbox-worker-"));
  const store = new OutlinerStore(join(root, "outline.sqlite"));
  const worker = new InboxWorker(store, model, () => {}, { settleMs: 1 });
  const value = { root, store, worker }; fixtures.push(value); return value;
}
async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) { if (condition()) return; await Bun.sleep(5); }
  throw new Error("Inbox worker did not reach expected state");
}
afterEach(async () => {
  for (const value of fixtures.splice(0)) {
    await value.worker?.stop(); await value.server?.close(); value.store.close(); rmSync(value.root, { recursive: true, force: true });
  }
});

test("automatically drains the existing pile and newly captured notes without a product quota", async () => {
  const { store, worker } = fixture(async context => ({ plan: plan(`Clean ${context.source.id}`), usage }));
  for (let index = 0; index < 8; index++) store.capture(`old-${index}`, `Old note ${index}`, "cli");
  worker.wake();
  await until(() => worker.status().results.length === 8);
  expect(worker.status().pending).toBe(0);
  const next = store.capture("new", "New saved note", "tree");
  worker.wake();
  await until(() => worker.status().results.length === 9);
  expect(store.get(next.block.id)?.text).toContain("Clean");
});

test("Pause acknowledges before an uncooperative late model can commit, and Resume uses a fresh call", async () => {
  const entered = Promise.withResolvers<InboxModelContext>();
  const late = Promise.withResolvers<Awaited<ReturnType<InboxModel>>>();
  let calls = 0;
  const { store, worker } = fixture(async context => {
    if (++calls === 1) { entered.resolve(context); return late.promise; }
    return { plan: plan("The resumed result"), usage };
  });
  const source = store.capture("pause", "Original saved note", "tree").block;
  worker.wake();
  await entered.promise;
  expect(worker.pause().paused).toBe(true);
  late.resolve({ plan: plan("Late unwanted result"), usage });
  await until(() => !worker.status().current);
  expect(store.get(source.id)?.text).toBe(source.text);
  expect(worker.status().results).toHaveLength(1);
  expect(worker.status().results[0]!.state).toBe("canceled");
  expect(worker.status().attentionCount).toBe(0);
  worker.resume();
  await until(() => worker.status().results.some(result => result.state === "applied"));
  expect(store.get(source.id)?.text).toContain("The resumed result");
  expect(worker.status().results[0]!.attempt?.trigger).toBe("resume");
});

test("an intervening target edit rejects the whole cleanup and preserves the source and attempted prompt evidence", async () => {
  let targetId = "";
  const inspected = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const prompt = { path: "/workspace/prompts/inbox-editor.md", sha256: "captured-hash", text: "Instructions used by the rejected cleanup" };
  const returnedUsage: InboxUsage = { ...usage, cost:0.25, promptRevisions: [prompt], piSessions:[{
    id:"one-attempt",path:"/workspace/sessions/one.jsonl",startedAt:"2026-09-22T00:00:00Z",phase:"Editing",outcome:"completed",
  }] };
  const { root, store, worker } = fixture(async context => {
    const target = context.read(targetId)!;
    inspected.resolve(); await release.promise;
    context.reportUsage?.(returnedUsage);
    return { plan: { ...plan("Should not be saved"), updates: [{ blockId: target.id, expectedRevision: target.revision, text: "Overwritten" }] }, usage: returnedUsage };
  });
  const target = store.create("An existing note"); targetId = target.id;
  const source = store.capture("stale", "Original captured thought", "tree").block;
  worker.wake(); await inspected.promise;
  const editedTarget = store.update(target.id, "Newer human edit", target.revision, { author: "user" });
  release.resolve();
  await until(() => worker.status().results.length === 1);
  const failed = worker.status().results[0]!;
  expect(failed.state).toBe("failed");
  expect(failed.failureKind).toBe("conflict");
  expect(store.require(source.id)).toEqual(source);
  expect(store.require(targetId)).toEqual(editedTarget);
  expect(failed.usage?.promptRevisions).toEqual([{ path: prompt.path, sha256: prompt.sha256 }]);
  const server = new OutlinerServer(store, join(root, "failed-receipt.sock"));
  fixtures[fixtures.length - 1]!.server = server;
  await server.start();
  const receipt = await new OutlinerClient(server.socketPath).request<InboxResult>({ action: "inbox.result", resultId: failed.id });
  expect(receipt.state).toBe("failed");
  expect(receipt.usage).toEqual(returnedUsage);
});

test("one model failure stops provider calls instead of failing the entire Inbox", async () => {
  let calls = 0;
  const { store, worker } = fixture(async () => { calls++; throw new Error("Provider unavailable"); });
  store.capture("one", "First note", "tree"); store.capture("two", "Second note", "tree");
  worker.wake();
  await until(() => worker.status().state === "unavailable");
  worker.wake(); await Bun.sleep(20);
  expect(calls).toBe(1);
  expect(worker.status().paused).toBe(true);
  expect(worker.status().results).toHaveLength(1);
  expect(worker.status().pending).toBe(1);
});

test("a held decision stays quiet while other notes are processed", async () => {
  const { store, worker } = fixture(async context => ({
    plan: context.source.text.includes("Undecided")
      ? { ...plan(context.source.text), source: { text: context.source.text, disposition: "hold", reason: "Which project does this belong to?" } }
      : plan("Clean ordinary note"), usage,
  }));
  const held = store.capture("held", "Undecided project", "tree").block;
  store.capture("ordinary", "An ordinary thought", "tree");
  worker.wake(); await until(() => worker.status().results.length === 2);
  expect(worker.status().pending).toBe(0);
  expect(store.get(held.id)?.text).toBe(held.text);
  worker.wake(); await Bun.sleep(20);
  expect(worker.status().results).toHaveLength(2);
});

test("new direction invalidates an in-flight decision before it can consume that direction", async () => {
  const first = Promise.withResolvers<void>();
  const late = Promise.withResolvers<Awaited<ReturnType<InboxModel>>>();
  const directions: Array<string | undefined> = [];
  const { store, worker } = fixture(async context => {
    directions.push(context.instructions);
    if (directions.length === 1) { first.resolve(); return late.promise; }
    return { plan: plan(`New direction: ${context.instructions}`), usage };
  });
  const source = store.capture("direction", "Original thought", "tree").block;
  worker.wake(); await first.promise;
  worker.reconsider(source.id, "Keep this as one personal note");
  late.resolve({ plan: plan("Obsolete decision"), usage });
  await until(() => worker.status().results.some(result => result.state === "applied"));
  expect(store.get(source.id)?.text).toContain("Keep this as one personal note");
  expect(directions).toEqual([undefined, "Keep this as one personal note"]);
});

test("removing a failed source cannot prevent Resume processing the rest of the Inbox", async () => {
  let calls = 0;
  const { store, worker } = fixture(async () => {
    if (++calls === 1) throw new Error("Temporary provider failure");
    return { plan: plan("Remaining note processed"), usage };
  });
  store.capture("failed", "The failed capture", "tree");
  store.capture("remaining", "The remaining capture", "tree");
  worker.wake(); await until(() => worker.status().state === "unavailable");
  store.delete(worker.status().results[0]!.sourceId);
  expect(worker.resume().paused).toBe(false);
  await until(() => worker.status().results.length === 2);
  expect(worker.status().results[0]!.state).toBe("applied");
});

test("a per-note size or reasoning limit holds that note and continues the pile", async () => {
  const { store, worker } = fixture(async context => {
    if (context.source.text.length > 60_000) {
      const error = new Error("Inbox note exceeds the editor's 60,000-character input limit");
      error.name = "InboxNoteError"; throw error;
    }
    return { plan: plan("A useful ordinary note"), usage };
  });
  store.capture("oversize", "x".repeat(60_001), "tree");
  store.capture("small", "An ordinary thought", "tree");
  worker.wake(); await until(() => worker.status().results.length === 2);
  expect(worker.status().paused).toBe(false);
  expect(worker.status().results.map(value => value.state).sort()).toEqual(["applied", "failed"]);
  expect(worker.status().attentionCount).toBe(1);
});

test("history and Undo remain available after restart without a configured model", async () => {
  const prompt = { path: "/workspace/prompts/inbox-editor.md", text: "Historical editorial instructions", sha256: "historical-hash" };
  const { root, store, worker } = fixture(async () => ({ plan: plan("Clean result"), usage: { ...usage, promptRevisions: [prompt] } }));
  const source = store.capture("offline-recovery", "Recover this original", "tree").block;
  worker.wake(); await until(() => worker.status().results.length === 1);
  const saved = worker.status().results[0]!;
  expect(saved.usage?.promptRevisions).toEqual([{ path: prompt.path, sha256: prompt.sha256 }]);
  await worker.stop(); store.close();
  const reopened = new OutlinerStore(join(root, "outline.sqlite"));
  const server = new OutlinerServer(reopened, join(root, "offline.sock"));
  fixtures[fixtures.length - 1] = { root, store: reopened, server };
  await server.start(); server.setInboxUnavailable("Pi needs authentication");
  const client = new OutlinerClient(server.socketPath);
  const status = await client.request<InboxStatus>({ action: "inbox.status" });
  expect(status.enabled).toBe(false);
  expect(status.results[0]?.id).toBe(saved.id);
  expect(status.results[0]?.usage?.promptRevisions).toEqual([{ path: prompt.path, sha256: prompt.sha256 }]);
  const complete = await client.request<import("../src/inbox-types").InboxResultDetail>({ action: "inbox.result", resultId: saved.id });
  expect(complete.beforeSource).toEqual({id:source.id,text:source.text,revision:source.revision});
  expect(complete.usage?.promptRevisions).toEqual([prompt]);
  await expect(client.request({ action: "inbox.result", resultId: "missing" })).rejects.toThrow("Inbox result not found");
  const undone = await client.request<InboxStatus>({ action: "inbox.undo", resultId: saved.id });
  expect(undone.results[0]?.state).toBe("undone");
  expect(reopened.get(source.id)?.text).toBe(source.text);
});

test("service capture returns durable text before the automatic processor finishes", async () => {
  const root = mkdtempSync(join(tmpdir(), "outliner-inbox-service-"));
  const store = new OutlinerStore(join(root, "outline.sqlite"));
  const server = new OutlinerServer(store, join(root, "outline.sock"));
  fixtures.push({ root, store, server });
  await server.start();
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<Awaited<ReturnType<InboxModel>>>();
  server.enableInbox(async () => { entered.resolve(); return finish.promise; });
  const client = new OutlinerClient(server.socketPath);
  const receipt = await client.request<CaptureReceipt>({ action: "capture.create", requestId: "automatic", text: "Keep my original", source: "tree" });
  expect(receipt.block.text).toContain("Keep my original");
  await entered.promise;
  expect((await client.request<InboxStatus>({ action: "inbox.status" })).state).toBe("working");
  await client.request({ action: "inbox.pause" });
  finish.resolve({ plan: plan("Too late"), usage });
  await Bun.sleep(10);
  expect(store.get(receipt.block.id)?.text).toBe(receipt.block.text);
});

test('failed revision is suppressed and explicit retries retain trigger and prior cost',async()=>{
 let calls=0;
 const {store,worker}=fixture(async()=>{calls++;const error=new Error('Inbox cleanup timed out after 5 ms');error.name='InboxNoteError';Object.assign(error,{usage:{...usage,cost:0.12}});throw error;});
 const source=store.capture('retry','Retry source','tree').block;worker.wake();
 await until(()=>worker.status().results.length===1&&!worker.status().current);
 worker.wake();await Bun.sleep(25);expect(calls).toBe(1);
 const first=worker.status().results[0]!;expect(first.failureKind).toBe('timeout');
 worker.reconsider(source.id);await until(()=>worker.status().results.length===2&&!worker.status().current);
 expect(worker.status().results[0]!.attempt).toMatchObject({trigger:'reconsider',prior:{id:first.id,cost:0.12}});
 worker.resume();await until(()=>worker.status().results.length===3&&!worker.status().current);
 expect(worker.status().results[0]!.attempt?.trigger).toBe('resume');
 const original=store.require(source.id);store.update(source.id,original.text+'\nFresh human addition',original.revision,{author:'user'});worker.wake();
 await until(()=>worker.status().results.length===4&&!worker.status().current);
 expect(worker.status().results[0]!.attempt?.trigger).toBe('source-changed');
});
