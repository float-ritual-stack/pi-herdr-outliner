// Agents addressed while you write (PIE-501): a person's `@name …` line runs the agent an extension
// declares; its patches apply as an attributed edit through draft.patch (edit policy), a failed compare
// becomes a proposal, a reply shows under the line, and a line an agent wrote waits for r. Scratch
// services and made-up notes only.
import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutlinerClient } from "../src/client";
import { OutlinerServer } from "../src/server";
import { OutlinerStore } from "../src/store";
import { requestLines } from "../src/agent-requests";
import type { ExtensionsListResult } from "../src/extension-registry";
import type { ResourceProjection, ResourceProjectionReadResult } from "../src/resource-projection";
import type { Block } from "../src/types";

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

async function setup() {
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
  const server = new OutlinerServer(store, socket, undefined, undefined, { extensionPollMs: 0, agentRequestQuietMs: 80 });
  await server.start();
  const client = new OutlinerClient(socket);
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
  return { store, client, create, agentOf, writeAgent };
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
  expect((await agentOf(note.id, (p) => p.status === "unavailable")).reason).toBe("@sneaky tried to write an @request line; agents can't ask agents");
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
