// Agents addressed while you write (PIE-501): a person's `@name …` line runs the agent an extension
// declares; its patches apply as an attributed edit through draft.patch (edit policy), a failed compare
// becomes a proposal, a reply shows under the line, and a line an agent wrote waits for r. Scratch
// services and made-up notes only.
import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutlinerClient } from "../src/client";
import { OutlinerServer } from "../src/server";
import { OutlinerStore } from "../src/store";
import { requestLines } from "../src/agent-requests";
import { applyLocated, locateSpans } from "../src/draft-patch-compare";
import type { DraftHolderRequest } from "../src/draft-patch";
import { requestPassages } from "../src/note-content";
import type { ExtensionsListResult } from "../src/extension-registry";
import type { ResourceProjection, ResourceProjectionReadResult } from "../src/resource-projection";
import type { Block, OutlinerEvent } from "../src/types";

const PERSON = { author: "user" as const };
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function until<T>(what: string, check: () => T | undefined | null | false | Promise<T | undefined | null | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

async function setup(options: { quietMs?: number } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "outliner-agents-")));
  const previous = { dir: process.env.OUTLINER_EXTENSIONS_DIR, registry: process.env.OUTLINER_RESOURCE_EXTENSIONS };
  process.env.OUTLINER_EXTENSIONS_DIR = join(root, "user-extensions");
  process.env.OUTLINER_RESOURCE_EXTENSIONS = join(root, "no-legacy-registry.json");
  const outline = join(root, "outline");
  const extensions = join(outline, "extensions");
  mkdirSync(extensions, { recursive: true });
  cpSync(join(import.meta.dir, "..", "extensions", "tidy"), join(extensions, "tidy"), { recursive: true });
  const store = new OutlinerStore(join(root, "outliner.sqlite"), { workspaceRoot: outline });
  const socket = join(root, "outliner.sock");
  let server = new OutlinerServer(store, socket, undefined, undefined, { extensionPollMs: 0, agentRequestQuietMs: options.quietMs ?? 80 });
  await server.start();
  const client = new OutlinerClient(socket);
  /** The service stops and starts again on the same outline (the client reconnects). */
  const restart = async (quietMs = 80) => {
    await server.close();
    server = new OutlinerServer(store, socket, undefined, undefined, { extensionPollMs: 0, agentRequestQuietMs: quietMs });
    await server.start();
    await client.request<ExtensionsListResult>({ action: "extensions.list", reload: true });
  };
  cleanups.push(async () => {
    await server.close();
    store.close();
    for (const [key, value] of [["OUTLINER_EXTENSIONS_DIR", previous.dir], ["OUTLINER_RESOURCE_EXTENSIONS", previous.registry]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const create = (text: string, by: "user" | "agent" = "user") =>
    client.request<Block>({ action: "create", text, author: by, ...(by === "agent" ? { provenance: { actorId: "claude-test" } } : {}) });
  const agentOf = async (blockId: string, ready: (projection: ResourceProjection) => boolean) => until("the agent's projection", async () =>
    (await client.request<ResourceProjectionReadResult>({ action: "resources.projection.read", blockId })).projections.find((p) => p.kind === "agent" && ready(p)));
  const writeAgent = async (id: string, code: string) => {
    mkdirSync(join(extensions, id), { recursive: true });
    writeFileSync(join(extensions, id, "extension.json"), JSON.stringify({ contract: 2, id, version: 1, name: id, run: ["bun", "main.ts"], agents: [{ name: id }] }));
    writeFileSync(join(extensions, id, "main.ts"), code);
    await client.request<ExtensionsListResult>({ action: "extensions.list", reload: true });
  };
  /** An agent that tidies nothing and counts its runs (one line per run in `calls`). */
  const counted = async (id: string) => {
    const log = join(root, `${id}.log`);
    await writeAgent(id, `import { appendFileSync } from "node:fs";
const request = await Bun.stdin.json();
appendFileSync(${JSON.stringify(log)}, "run " + request.input.request + "\\n");
process.stdout.write(JSON.stringify({ ok: true, value: { reply: "noted" } }));`);
    return () => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  };
  return { store, client, create, agentOf, writeAgent, restart, counted };
}

/**
 * A stand-in for a door holding a live draft of one note: it answers the service's `draft` reads and patches
 * against its own buffer, with the compare the door vendors.
 */
async function fakeDoor(client: OutlinerClient, clientId: string, block: Block) {
  const door = { text: block.text, holdId: "", requests: [] as DraftHolderRequest[] };
  const connected = Promise.withResolvers<void>();
  const watcher = client.watch({
    client: { clientId, role: "observer", contextId: clientId },
    onConnect: connected.resolve,
    onEvent: async (event: OutlinerEvent) => {
      if (event.domain !== "draft" || !event.draft) return;
      const request = event.draft;
      door.requests.push(request);
      let answer: unknown = { applied: false, reason: "not in this stand-in" };
      if (request.kind === "read") answer = { text: door.text, revision: block.revision };
      else if (request.kind === "patch") {
        const located = locateSpans(door.text, request.patches, request.force);
        if (!located.ok) answer = { applied: false, reason: located.reason };
        else { door.text = applyLocated(door.text, located.spans); answer = { applied: true }; }
      }
      await client.request({ action: "drafts.answer", requestId: request.requestId, clientId, answer: answer as never }).catch(() => undefined);
    },
  });
  cleanups.push(() => watcher.stop());
  await connected.promise;
  door.holdId = (await client.request<{ holdId: string }>({ action: "drafts.hold", blockId: block.id, clientId, revision: block.revision })).holdId;
  return door;
}

test("request lines: an answered @name at a line's start, outside code; unknown names are prose", () => {
  const names = new Set(["tidy"]);
  const lines = requestLines("Plan\n@tidy\n- @tidy: all of it\n`@tidy` in code\n@evan says hi\nmail me @tidy\n```\n@tidy\n```", names);
  expect(lines.map((line) => [line.line, line.agent, line.request])).toEqual([[1, "tidy", ""], [2, "tidy", "all of it"]]);
  expect(lines[0]!.requestKey).not.toBe(lines[1]!.requestKey);
});

test("@tidy: a person's request tidies the paragraph above as an attributed edit, and says so under the line", async () => {
  const { store, client, create, agentOf } = await setup();
  const listed = await client.request<ExtensionsListResult>({ action: "extensions.list" });
  expect(listed.extensions[0]!.agents).toEqual([{ name: "tidy", description: expect.any(String), effects: "read" }]);
  const note = await create("Morning plan\n*  call the  printer people\n-   **  order  ** paper\n@tidy\nstill typing here");
  const done = await agentOf(note.id, (p) => p.status === "ready");
  expect(done).toMatchObject({ provider: "tidy", label: "Tidy", key: "@tidy", anchor: { line: 3 }, summary: "tidied 2 lines above",
    agent: { name: "tidy", status: "applied", requestedBy: "user" } });
  expect(store.get(note.id)!.text).toBe("Morning plan\n- call the printer people\n- **order** paper\n@tidy\nstill typing here");
  const changes = store.changes.since(0, 1000);
  const edit = changes.kind === "changes" ? changes.changes.find((change) => change.kind === "edit" && change.blockId === note.id) : undefined;
  expect(edit?.actor).toMatchObject({ author: "agent", actorId: "ext:tidy" });
  expect(edit?.action).toBe("ext.tidy.agent.tidy");

  // It ran once: a later save of the note (another line) doesn't ask again. r does.
  const current = store.get(note.id)!;
  await client.request({ action: "update", blockId: note.id, text: `${current.text} and more`, expectedRevision: current.revision, mutation: PERSON });
  await Bun.sleep(250);
  expect(store.agentRequests(note.id).map((row) => row.status)).toEqual(["applied"]);
  const again = await client.request<ResourceProjectionReadResult>({ action: "resources.projection.refresh", blockId: note.id, line: 3 });
  expect(again.projections.find((p) => p.kind === "agent")).toMatchObject({ summary: "nothing to tidy above" });
});

test("a request line an agent wrote waits for r; a line still being changed runs once, as finally written", async () => {
  const { store, client, create, agentOf } = await setup();
  const theirs = await create("Draft\n*  messy  line\n@tidy", "agent");
  const waiting = await agentOf(theirs.id, (p) => p.status === "not-run" && p.agent?.status === "waiting");
  expect(waiting.reason).toBe("written by an agent: r asks it");
  await Bun.sleep(250);
  expect(store.get(theirs.id)!.text).toBe("Draft\n*  messy  line\n@tidy");
  await client.request({ action: "resources.projection.refresh", blockId: theirs.id, line: 2 });
  expect(store.get(theirs.id)!.text).toBe("Draft\n- messy line\n@tidy");

  // Typed in two saves inside the quiet window: only the finished request runs.
  const mine = await create("Notes\n*  one  two\n@tidy al");
  await client.request({ action: "update", blockId: mine.id, text: "Notes\n*  one  two\n@tidy all", expectedRevision: mine.revision, mutation: PERSON });
  await agentOf(mine.id, (p) => p.status === "ready");
  expect(store.agentRequests(mine.id).map((row) => row.request)).toEqual(["all"]);
});

test("a patch whose compare fails becomes a proposal under the line; a reply shows under it; a failure says why", async () => {
  const { store, create, agentOf, writeAgent } = await setup();
  await writeAgent("stale", `process.stdout.write(JSON.stringify({ ok: true, value: { patches: [{ observed: "text the note never had", replacement: "x" }] } }));`);
  const note = await create("Plan\nthe real text\n@stale");
  const proposed = await agentOf(note.id, (p) => p.status === "ready");
  const proposalId = proposed.agent!.proposalId!;
  expect(proposed.agent!.status).toBe("proposed");
  expect(proposed.summary).toStartWith("proposed instead: ");
  expect(store.get(proposalId)?.parentId).toBe(note.id);
  expect(store.get(note.id)!.text).toContain("the real text");

  await writeAgent("answer", `const request = await Bun.stdin.json();
process.stdout.write(JSON.stringify({ ok: true, value: { message: "two items", reply: "- [ ] call Dana\\n- [ ] [status::x] stays text", } }));`);
  const asked = await create("Yesterday\n@answer what is left over");
  const replied = await agentOf(asked.id, (p) => p.status === "ready");
  expect(replied.agent!.status).toBe("replied");
  expect(replied.output!.markdown).toBe("- [ ] call Dana\n- [ ] \\[status::x] stays text");
  expect(store.get(asked.id)!.text).toBe("Yesterday\n@answer what is left over");

  await writeAgent("broken", `process.stdout.write(JSON.stringify({ ok: true, value: { patches: "nope" } }));`);
  const bad = await create("x\n@broken");
  const failed = await agentOf(bad.id, (p) => p.status === "unavailable");
  expect(failed.reason).toBe("@broken answered something the service can't apply: patches must be a list of at most 20");
});

test("a request's proposal, applied anyway or dismissed, says so under the line (PIE-510)", async () => {
  const { store, client, create, agentOf, writeAgent } = await setup();
  await writeAgent("stale", `process.stdout.write(JSON.stringify({ ok: true, value: { patches: [{ observed: "two  beans", replacement: "two beans" }] } }));`);
  const dropped = await create("Plan\nthe real text\n@stale");
  const first = await agentOf(dropped.id, (p) => p.agent?.status === "proposed");
  const dismissed = await client.request<{ outcome: string }>({ action: "draft.proposal.dismiss", proposalId: first.agent!.proposalId!, mutation: PERSON });
  expect(dismissed.outcome).toBe("dismissed");
  const after = await agentOf(dropped.id, (p) => p.agent?.status === "dismissed");
  expect(after.summary).toBe("its proposal was dismissed");

  const kept = await create("Plan\nthe real text\n@stale");
  const second = await agentOf(kept.id, (p) => p.agent?.status === "proposed");
  // The passage the agent meant turns up after all; the person applies the proposal anyway.
  const now = store.get(kept.id)!;
  await client.request({ action: "update", blockId: kept.id, text: now.text.replace("the real text", "two  beans"), expectedRevision: now.revision, mutation: PERSON });
  await client.request({ action: "draft.proposal.apply", proposalId: second.agent!.proposalId!, mutation: PERSON });
  const applied = await agentOf(kept.id, (p) => p.agent?.status === "applied");
  expect(applied.summary).toBe("its proposal was applied anyway");
  expect(store.get(kept.id)!.text).toStartWith("Plan\ntwo beans\n@stale");
});

test("only a request a person's save adds runs: lines from before the install wait, note-level r doesn't ask, typing elsewhere still applies", async () => {
  const { store, client, create, agentOf, writeAgent } = await setup();
  // Written while no extension answered @slow: when one appears, an unrelated save doesn't run it.
  const old = await create("Old note\n*  stale  text\n@slow");
  await writeAgent("slow", `const request = await Bun.stdin.json();
await Bun.sleep(400);
const text = request.input.note.text;
const observed = text.split("\\n")[1];
process.stdout.write(JSON.stringify({ ok: true, value: { message: "done", patches: [{ observed, replacement: observed.toUpperCase() }] } }));`);
  const current = store.get(old.id)!;
  await client.request({ action: "update", blockId: old.id, text: `${current.text}\nmore`, expectedRevision: current.revision, mutation: PERSON });
  await Bun.sleep(300);
  expect(store.agentRequests(old.id)).toEqual([]);
  expect((await agentOf(old.id, (p) => p.status === "not-run")).reason).toBe("r asks @slow");

  // A note with no @ lines yet, never read: the person's first request in it is new, and runs.
  const plain = await create("Plain note\nsome  words");
  await client.request({ action: "update", blockId: plain.id, text: "Plain note\nsome  words\n@slow", expectedRevision: plain.revision, mutation: PERSON });
  await until("the first request answered", () => store.agentRequests(plain.id)[0]?.status === "applied");

  // A new request; the person types below it while the agent works: the edit still applies.
  const note = await create("Plan\nfirst line\n@slow\n");
  await until("running", () => store.agentRequests(note.id)[0]?.status === "running");
  const typing = store.get(note.id)!;
  await client.request({ action: "update", blockId: note.id, text: `${typing.text}typing below`, expectedRevision: typing.revision, mutation: PERSON });
  await until("answered", () => store.agentRequests(note.id)[0]?.status === "applied");
  expect(store.get(note.id)!.text).toBe("Plan\nFIRST LINE\n@slow\ntyping below");

  // r on the note refreshes its other lines but never re-asks an agent.
  const answeredAt = store.agentRequests(note.id)[0]!.answeredAt;
  await client.request({ action: "resources.projection.refresh", blockId: note.id });
  await Bun.sleep(600);
  expect(store.agentRequests(note.id)[0]!.answeredAt).toBe(answeredAt);
  expect(store.agentRequests(note.id).map((row) => row.status)).toEqual(["applied"]);
});

test("an agent can't write a request line, and a request reworded while it runs drops the old answer", async () => {
  const { store, client, create, agentOf, writeAgent } = await setup();
  await writeAgent("sneaky", `const text = (await Bun.stdin.json()).input.note.text;
process.stdout.write(JSON.stringify({ ok: true, value: { patches: [{ observed: "harmless", replacement: "@sneaky again" }] } }));`);
  const note = await create("x\nharmless\n@sneaky");
  expect((await agentOf(note.id, (p) => p.status === "unavailable")).reason).toBe("Not applied, nothing was written: it would write a request line (@sneaky again); agents can't ask agents");
  expect(store.get(note.id)!.text).toBe("x\nharmless\n@sneaky");

  await writeAgent("tardy", `await Bun.sleep(400);
process.stdout.write(JSON.stringify({ ok: true, value: { patches: [{ observed: "words", replacement: "WORDS" }] } }));`);
  const asked = await create("y\nwords\n@tardy one");
  await until("running", () => store.agentRequests(asked.id)[0]?.status === "running");
  const now = store.get(asked.id)!;
  await client.request({ action: "update", blockId: asked.id, text: "y\nwords\n@tardy two", expectedRevision: now.revision, mutation: PERSON });
  await until("the new wording answered", () => store.agentRequests(asked.id).some((row) => row.request === "two" && row.status === "applied"));
  expect(store.agentRequests(asked.id).map((row) => row.request)).toEqual(["two"]);
  expect(store.get(asked.id)!.text).toBe("y\nWORDS\n@tardy two");
});

test("an older outline's request table takes the dismissed status, its rows kept", () => {
  const root = mkdtempSync(join(tmpdir(), "outliner-agent-migrate-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "outliner.sqlite");
  const first = new OutlinerStore(path);
  const note = first.create("Plan\n@tidy");
  const row = { blockId: note.id, requestKey: "k1", agent: "tidy", extensionId: "tidy", request: "", status: "proposed" as const, proposalId: "p-1", requestedBy: "user", requestedAt: "2026-01-02T03:04:05.000Z" };
  // The table as it was before PIE-510: its check doesn't know `dismissed`.
  first.database.exec(`DROP TABLE agent_requests; CREATE TABLE agent_requests (
    block_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE, request_key TEXT NOT NULL, agent TEXT NOT NULL, extension_id TEXT NOT NULL,
    request TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('waiting', 'running', 'applied', 'proposed', 'replied', 'nothing', 'failed')),
    message TEXT, reply TEXT, proposal_id TEXT, requested_by TEXT NOT NULL, requested_at TEXT NOT NULL, answered_at TEXT, PRIMARY KEY (block_id, request_key))`);
  first.putAgentRequest(row);
  expect(() => first.putAgentRequest({ ...row, status: "dismissed" })).toThrow();
  first.close();
  const second = new OutlinerStore(path);
  expect(second.agentRequestByProposal("p-1")).toMatchObject({ status: "proposed", requestKey: "k1" });
  second.putAgentRequest({ ...row, status: "dismissed" });
  expect(second.agentRequests(note.id).map((entry) => entry.status)).toEqual(["dismissed"]);
  second.close();
  // Opening it again leaves the migrated table as it is.
  const third = new OutlinerStore(path);
  cleanups.push(() => third.close());
  expect(third.agentRequests(note.id).map((entry) => entry.status)).toEqual(["dismissed"]);
});

const AGENT = { author: "agent" as const, actorId: "claude-test" };

test("one guard: no agent's draft.patch writes or rewords a request line, in a live draft or a saved note (B4)", async () => {
  const { store, client, create } = await setup();
  const held = await create("Errands\nbuy string\nmore words");
  const door = await fakeDoor(client, "door-1", held);
  door.text = `${door.text}\nstill typing`;
  await expect(client.request({ action: "draft.patch", blockId: held.id, revision: held.revision, mutation: AGENT,
    patches: [{ observed: "buy string", replacement: "buy string\n@tidy all" }] })).rejects.toThrow("it would write a request line (@tidy all); agents can't ask agents");
  expect(door.text).toBe("Errands\nbuy string\nmore words\nstill typing");
  await Bun.sleep(250);
  expect(store.agentRequests(held.id)).toEqual([]);

  const saved = await create("Ledger\n@tidy\nentry");
  await expect(client.request({ action: "draft.patch", blockId: saved.id, revision: saved.revision, mutation: AGENT,
    patches: [{ observed: "@tidy", replacement: "@tidy all" }] })).rejects.toThrow("agents can't ask agents");
  expect(store.get(saved.id)!.text).toBe("Ledger\n@tidy\nentry");
  // Other edits, and a person's patch, still apply; `@name` mid-sentence is prose.
  await client.request({ action: "draft.patch", blockId: saved.id, revision: saved.revision, mutation: AGENT, patches: [{ observed: "entry", replacement: "entry for @tidy" }] });
  expect(store.get(saved.id)!.text).toBe("Ledger\n@tidy\nentry for @tidy");
});

test("notes from before agent requests keep their @name lines old; restarts say what they cut off (B5, B17)", async () => {
  const { store, client, create, restart, counted } = await setup({ quietMs: 60_000 });
  const calls = await counted("count");
  // A note as it was before this feature: an `@count` line, no baseline, no rows.
  const old = await create("Old note\n@count from long ago", "agent");
  store.database.query("DELETE FROM agent_request_baseline").run();
  store.database.query("DELETE FROM agent_requests").run();
  store.database.query("DELETE FROM metadata WHERE key = 'agent_request_baseline_seeded'").run();
  // A person's request still waiting for quiet, and one a crash left running.
  const waiting = await create("Fresh\n@count please");
  const crashed = await create("Crashed\n@count halfway");
  store.putAgentRequest({ blockId: crashed.id, requestKey: requestLines(crashed.text, null)[0]!.requestKey, agent: "count", extensionId: "count",
    request: "halfway", status: "running", requestedBy: "user", requestedAt: new Date().toISOString() });
  await restart();

  const current = store.get(old.id)!;
  await client.request({ action: "update", blockId: old.id, text: `${current.text}\nan unrelated line`, expectedRevision: current.revision, mutation: PERSON });
  await Bun.sleep(300);
  expect(calls()).toEqual([]);
  expect(store.agentRequests(old.id)).toEqual([]);

  expect(store.agentRequests(crashed.id)[0]).toMatchObject({ status: "failed", message: "interrupted by a restart: r asks again" });
  expect(store.agentRequests(waiting.id)[0]).toMatchObject({ status: "waiting", message: "the service stopped before @count answered: r asks it", requestedBy: "user" });
  await client.request({ action: "resources.projection.refresh", blockId: waiting.id, line: 1 });
  expect(calls()).toEqual(["run please"]);
});

test("an outline a host opens gets the same start: old @name lines baselined, cut-off requests failed (B5, B17 hosted)", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "outliner-agents-hosted-")));
  const store = new OutlinerStore(join(root, "outliner.sqlite"), { workspaceRoot: join(root, "outline") });
  const old = store.create("Old note\n@tidy from long ago");
  const crashed = store.create("Crashed\n@tidy halfway");
  store.database.query("DELETE FROM agent_request_baseline").run();
  store.putAgentRequest({ blockId: crashed.id, requestKey: requestLines(crashed.text, null)[0]!.requestKey, agent: "tidy", extensionId: "tidy",
    request: "halfway", status: "running", requestedBy: "user", requestedAt: new Date().toISOString() });
  const server = new OutlinerServer(store, join(root, "unused.sock"), undefined, undefined, { extensionPollMs: 0 });
  server.startHosted();
  cleanups.push(async () => {
    await server.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  expect(store.agentRequestBaseline(old.id)).toEqual(requestLines(old.text, null).map((line) => line.requestKey));
  expect(store.agentRequests(crashed.id)[0]).toMatchObject({ status: "failed", message: "interrupted by a restart: r asks again" });
});

test("taking an answered line out and putting it back (undo) doesn't ask again (B18)", async () => {
  const { store, client, create, agentOf, counted } = await setup();
  const calls = await counted("count");
  const note = await create("Note\n@count once\nend");
  await agentOf(note.id, (p) => p.status === "ready");
  expect(calls()).toEqual(["run once"]);
  const save = async (text: string) => {
    const block = store.get(note.id)!;
    await client.request({ action: "update", blockId: note.id, text, expectedRevision: block.revision, mutation: PERSON });
  };
  await save("Note\nend");
  await Bun.sleep(150);
  expect(store.agentRequests(note.id)).toEqual([]);
  await save("Note\n@count once\nend");
  await Bun.sleep(400);
  expect(calls()).toEqual(["run once"]);
  expect(store.agentRequests(note.id).map((row) => row.status)).toEqual(["replied"]);
});

test("r says who asked, an agent's r doesn't release a line an agent wrote, and r on the note asks what isn't answered (C6, E5)", async () => {
  const { store, client, create, agentOf, counted } = await setup();
  const calls = await counted("count");
  const theirs = await create("Shared\n@count from an agent", "agent");
  await agentOf(theirs.id, (p) => p.agent?.status === "waiting");
  await expect(client.request({ action: "resources.projection.refresh", blockId: theirs.id, line: 1, mutation: { author: "agent", actorId: "loki" } }))
    .rejects.toThrow("@count on this line was written by an agent or an import: it waits for a person's r");
  // Who asks is checked as extensions.act checks it: an agent names itself, and no other author passes as a person.
  await expect(client.request({ action: "resources.projection.refresh", blockId: theirs.id, line: 1, mutation: { author: "agent" } }))
    .rejects.toThrow("resources.projection.refresh's mutation names who asks");
  await expect(client.request({ action: "resources.projection.refresh", blockId: theirs.id, mutation: { author: "someone" } } as never))
    .rejects.toThrow("resources.projection.refresh's mutation names who asks");
  // Not on the note either: the agent's note-level r passes it by.
  await client.request({ action: "resources.projection.refresh", blockId: theirs.id, mutation: { author: "agent", actorId: "loki" } });
  expect(calls()).toEqual([]);
  // Detail's r sends only the note: a person's asks the waiting request.
  await client.request({ action: "resources.projection.refresh", blockId: theirs.id });
  expect(calls()).toEqual(["run from an agent"]);
  expect(store.agentRequests(theirs.id)[0]).toMatchObject({ status: "replied", requestedBy: "user" });
  // Released by a person, an agent may ask it again on its line, and is named as who asked.
  await client.request({ action: "resources.projection.refresh", blockId: theirs.id, line: 1, mutation: { author: "agent", actorId: "loki" } });
  expect(store.agentRequests(theirs.id)[0]).toMatchObject({ status: "replied", requestedBy: "agent:loki" });
  // r on the note doesn't ask an answered request again.
  await client.request({ action: "resources.projection.refresh", blockId: theirs.id });
  expect(calls()).toHaveLength(2);
});

test("drafts.touch: a request written in a held draft runs before any save, and the save doesn't run it twice (F1)", async () => {
  const { store, client, create } = await setup();
  const note = await create("Morning plan\n*  call the  printer people");
  const door = await fakeDoor(client, "door-2", note);
  await expect(client.request({ action: "drafts.touch", holdId: "no-such-hold" })).rejects.toThrow("hold the draft again");
  // The person types `@tidy` in the draft and keeps going; the door says so.
  door.text = "Morning plan\n*  call the  printer people\n@tidy\nand then";
  expect(await client.request<{ touched: boolean }>({ action: "drafts.touch", holdId: door.holdId })).toEqual({ touched: true });
  await until("the draft tidied", () => door.text === "Morning plan\n- call the printer people\n@tidy\nand then");
  await until("answered", () => store.agentRequests(note.id)[0]?.status === "applied");
  expect(store.get(note.id)!.text).toBe("Morning plan\n*  call the  printer people");
  const answeredAt = store.agentRequests(note.id)[0]!.answeredAt;
  // The door saves the draft as the person: the request is known, nothing runs again.
  await client.request({ action: "update", blockId: note.id, text: door.text, expectedRevision: note.revision, mutation: PERSON });
  await Bun.sleep(300);
  expect(store.agentRequests(note.id).map((row) => [row.status, row.answeredAt])).toEqual([["applied", answeredAt]]);
  expect(door.requests.filter((request) => request.kind === "patch")).toHaveLength(1);
});

test("note assistance leaves a line addressed to an extension's agent alone (E8)", () => {
  const text = "Plan\n@tidy can you fix the formatting above\nWhat tags do I use most?";
  expect(requestPassages(text, new Set(["tidy"]))).toEqual(["Plan", "What tags do I use most?"]);
  expect(requestPassages(text).join(" ")).toContain("@tidy can you fix the formatting above");
});
