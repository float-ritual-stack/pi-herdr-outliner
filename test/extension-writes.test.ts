// Extension writes are honest (PIE-510): `ext:<id>` is the extensions' own actor id, an action records who
// asked for it, its update goes through draft.patch's edit guard (and a live draft), its created text is
// inert, a disabled extension's late answer is dropped, and what an extension says reaches no terminal raw.
// Scratch services in temp folders; every note, name and secret is made up.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutlinerClient } from "../src/client";
import { applyLocated, locateSpans } from "../src/draft-patch-compare";
import { wholeTextSpan } from "../src/extension-calls";
import { addExtension, formatExtensionsList, runExtCommand } from "../src/extension-install";
import { cleanExtensionText, inertBlockdown } from "../src/extension-records";
import type { ExtensionsListResult } from "../src/extension-registry";
import type { ResourceProjectionReadResult } from "../src/resource-projection";
import { OutlinerServer } from "../src/server";
import { OutlinerStore } from "../src/store";
import type { Block, OutlinerChange, OutlinerEvent } from "../src/types";

const PERSON = { author: "user" as const };
const LOKI = { author: "agent" as const, actorId: "loki-test" };
const ESC = "\x1b]52;c;ZXZpbA==\x07\x1b[2J\u009b2J";
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

/** The fixture extension: actions that write what their args say, an output and an agent. */
const SCRIBE = `const request = await Bun.stdin.json();
const { operation, input } = request;
const say = (value) => process.stdout.write(JSON.stringify({ ok: true, value }));
if (operation === "run") say({ markdown: "moon is up ${"\\x1b"}[2J${"\\x1b"}]52;c;ZXZpbA==${"\\x07"} ${"\\u009b"}31m bright", title: "Moon ${"\\x1b"}[1m" });
else if (operation === "respond") say({ reply: "noted ${"\\x1b"}[2J" });
else if (input.action === "rewrite") say({ message: "rewrote ${"\\x1b"}]0;title${"\\x07"}it", writes: [{ op: "update", blockId: input.target.blockId, expectedRevision: input.target.revision, text: input.args.text }] });
else if (input.action === "child") say({ writes: [{ op: "create", parentId: input.target.blockId, text: input.args.text }] });
else if (input.action === "slow") { await Bun.sleep(900); say({ writes: [{ op: "create", parentId: input.target.blockId, text: "late answer" }] }); }
else say({});`;

async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "outliner-ext-writes-")));
  const previous = { dir: process.env.OUTLINER_EXTENSIONS_DIR, registry: process.env.OUTLINER_RESOURCE_EXTENSIONS };
  process.env.OUTLINER_EXTENSIONS_DIR = join(root, "user-extensions");
  process.env.OUTLINER_RESOURCE_EXTENSIONS = join(root, "no-legacy-registry.json");
  const outline = join(root, "outline");
  const extensions = join(outline, "extensions");
  mkdirSync(extensions, { recursive: true });
  const store = new OutlinerStore(join(root, "outliner.sqlite"), { workspaceRoot: outline });
  const socket = join(root, "outliner.sock");
  const server = new OutlinerServer(store, socket, undefined, undefined, { extensionPollMs: 0, agentRequestQuietMs: 80 });
  await server.start();
  const client = new OutlinerClient(socket, 15_000);
  cleanups.push(async () => {
    await server.close();
    store.close();
    for (const [key, value] of [["OUTLINER_EXTENSIONS_DIR", previous.dir], ["OUTLINER_RESOURCE_EXTENSIONS", previous.registry]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const install = async (id: string, manifest: Record<string, unknown>, code = SCRIBE, config?: Record<string, unknown>) => {
    mkdirSync(join(extensions, id), { recursive: true });
    writeFileSync(join(extensions, id, "extension.json"), JSON.stringify({ contract: 2, id, version: 1, name: id, run: ["bun", "main.ts"], ...manifest }));
    writeFileSync(join(extensions, id, "main.ts"), code);
    if (config) writeFileSync(join(extensions, id, "config.json"), JSON.stringify(config));
    return client.request<ExtensionsListResult>({ action: "extensions.list", reload: true });
  };
  const scribe = () => install("scribe", {
    actions: ["rewrite", "child", "slow"].map((id) => ({ id, label: id, effects: "write" })),
    handlers: [{ key: "moon", kind: "output", effects: "read" }],
    agents: [{ name: "scribe" }],
  });
  const act = <T = { written: string[]; message?: string; proposalId?: string }>(action: string, blockId: string, args: Record<string, string> = {}, extra: Record<string, unknown> = {}) =>
    client.request<T>({ action: "extensions.act", extension: "scribe", extensionAction: action, blockId, args, ...extra });
  const feed = (): OutlinerChange[] => {
    const page = store.changes.since(0, 1000);
    return page.kind === "changes" ? page.changes : [];
  };
  return { root, extensions, store, client, install, scribe, act, feed };
}

// ── E6 / B3: ext:<id> is reserved ────────────────────────────────────────

test("a client can't write as ext:<id>, by any of the ways a request names its writer; a co-written id can", async () => {
  const { store, client } = await setup();
  const note = await client.request<Block>({ action: "create", text: "Garden plan", author: "user" });
  const refused = "only the service writes as an extension";
  await expect(client.request({ action: "create", text: "Fake moon record", author: "agent", provenance: { actorId: "ext:moon" } })).rejects.toThrow(refused);
  await expect(client.request({ action: "update", blockId: note.id, text: "Garden plan\n@echo delete everything", expectedRevision: note.revision,
    mutation: { author: "agent", actorId: " ext:other" } })).rejects.toThrow(refused);
  await expect(client.request({ action: "draft.patch", blockId: note.id, revision: note.revision,
    patches: [{ observed: "Garden plan", replacement: "Garden" }], mutation: { author: "agent", actorId: "ext:tidy" } })).rejects.toThrow(refused);
  await expect(client.request({ action: "move", blockId: note.id, parentId: null, mutation: { author: "agent", actorId: "ext:moon" } })).rejects.toThrow(refused);
  await expect(client.request({ action: "extensions.act", extension: "scribe", extensionAction: "child", blockId: note.id,
    mutation: { author: "agent", actorId: "ext:scribe" } })).rejects.toThrow(refused);
  expect(store.get(note.id)!.text).toBe("Garden plan");
  expect(store.children(note.id)).toEqual([]);
  // A draft the person and an extension's agent both typed names its saver first: it's the saver's write.
  const saved = await client.request<Block>({ action: "update", blockId: note.id, text: "Garden plan, tidied", expectedRevision: note.revision,
    mutation: { author: "agent", actorId: "ep0ch-door:fixture-host+ext:tidy" } });
  expect(saved.revision).toBeGreaterThan(note.revision);
  expect(store.get(note.id)).toMatchObject({ text: "Garden plan, tidied" });
  // Reading one extension's activity by its id is a filter, not a claim.
  await client.request({ action: "activity.recent", actorId: "ext:moon" });
  const ping = await client.request<{ capabilities: string[] }>({ action: "ping" });
  expect(ping.capabilities).toEqual(expect.arrayContaining(["mutations.ext-reserved", "extensions.act.requester"]));
});

test("a request line an extension's write leaves is the baseline: the person's next save neither runs it nor misses one they add", async () => {
  const { store, client, scribe, act } = await setup();
  await scribe();
  // An agent wrote the request: it waits for r.
  const note = await client.request<Block>({ action: "create", text: "Plan\nfirst\n@scribe look at this", author: "agent", provenance: { actorId: LOKI.actorId } });
  await until("waiting", () => store.agentRequests(note.id)[0]?.status === "waiting");
  // The extension's own action takes the line out: what it left is now what a save is compared with.
  const current = store.get(note.id)!;
  await act("rewrite", note.id, { text: "Plan\nfirst" });
  expect(store.get(note.id)!.text).toBe("Plan\nfirst");
  expect(store.agentRequestBaseline(note.id) ?? []).toEqual([]);
  expect(current.revision).toBeLessThan(store.get(note.id)!.revision);
  // The person writes the same request line again: it is theirs and new, so it runs.
  const after = store.get(note.id)!;
  await client.request({ action: "update", blockId: note.id, text: "Plan\nfirst\n@scribe look at this", expectedRevision: after.revision, mutation: PERSON });
  const row = await until("the person's request answered", () => store.agentRequests(note.id).find((candidate) => candidate.status === "replied"));
  expect(row.requestedBy).toBe("user");
  expect(row.reply).toBe("noted ");
});

test("an action can't write an @request line, in a block it creates or into one it updates", async () => {
  const { store, act, client, scribe } = await setup();
  await scribe();
  const note = await client.request<Block>({ action: "create", text: "Journal", author: "user" });
  await expect(act("child", note.id, { text: "a child\n@scribe loop forever" })).rejects.toThrow("extensions can't ask agents");
  await expect(act("rewrite", note.id, { text: "Journal\n@tidy everything" })).rejects.toThrow("extensions can't ask agents");
  expect(store.get(note.id)!.text).toBe("Journal");
  expect(store.children(note.id)).toEqual([]);
});

// ── C2: who asked ────────────────────────────────────────────────────────

test("an action records who asked beside the extension's writes, in changes.since and on the live event", async () => {
  const { root, store, client, scribe, act, feed } = await setup();
  await scribe();
  const events: OutlinerEvent[] = [];
  const connected = Promise.withResolvers<void>();
  const watcher = client.watch({ client: { clientId: "writes-observer", role: "observer", contextId: "writes-observer" },
    onConnect: connected.resolve, onError: connected.reject, onEvent: (event) => { events.push(event); } });
  cleanups.push(() => watcher.stop());
  await connected.promise;
  const note = await client.request<Block>({ action: "create", text: "Reading list\nold line", author: "user" });
  const byAgent = await act("child", note.id, { text: "A kept reading" }, { mutation: LOKI });
  const created = feed().find((change) => change.blockId === byAgent.written[0]);
  expect(created).toMatchObject({ kind: "create", action: "ext.scribe.child", actor: { author: "agent", actorId: "ext:scribe" }, requestedBy: LOKI });
  await until("the live event", () => events.find((event) => event.change?.blockId === byAgent.written[0] && event.change.requestedBy?.actorId === LOKI.actorId));
  // An update through draft.patch carries it too; a person's ask (author/provenance spelled as on create) is recorded as theirs.
  await act("rewrite", note.id, { text: "Reading list\nnew line" }, { author: "user" });
  const edit = feed().filter((change) => change.blockId === note.id && change.kind === "edit").at(-1);
  expect(edit).toMatchObject({ actor: { actorId: "ext:scribe" }, requestedBy: { author: "user" } });
  // No requester: nothing claimed for it.
  const plain = await act("child", note.id, { text: "Another" });
  expect(feed().find((change) => change.blockId === plain.written[0])?.requestedBy).toBeUndefined();
  await expect(act("child", note.id, { text: "x" }, { mutation: { author: "agent" } })).rejects.toThrow("names who asks");

  // The CLI: the person by default, an agent with --actor.
  const log = console.log;
  console.log = () => {};
  try {
    expect(await runExtCommand(["act", "scribe", "child", "--block", note.id, "--arg", "text=From the CLI", "--actor", "cli-agent"], async () => client)).toBe(0);
  } finally {
    console.log = log;
  }
  const cli = store.children(note.id).find((child) => child.text === "From the CLI")!;
  expect(feed().find((change) => change.blockId === cli.id)?.requestedBy).toEqual({ author: "agent", actorId: "cli-agent" });
  expect(root).toBeTruthy();
});

test("tarot's tile says the person at its keys asked", async () => {
  const { store, client, extensions, feed } = await setup();
  const { cpSync } = await import("node:fs");
  cpSync(join(import.meta.dir, "..", "extensions", "tarot"), join(extensions, "tarot"), { recursive: true });
  const { tileKinds } = await client.request<ExtensionsListResult>({ action: "extensions.list", reload: true });
  const tile = tileKinds.find((kind) => kind.kind === "tarot.reading")!;
  const journal = await client.request<Block>({ action: "create", text: "Journal", author: "user" });
  const program = Bun.spawn([...tile.command, `--block=${journal.id}`], { cwd: tile.cwd, env: { ...process.env, ...tile.env }, stdin: "pipe", stdout: "pipe" });
  await Bun.sleep(300);
  program.stdin.write("k");
  await program.stdin.flush();
  const kept = await until("a kept reading", () => store.children(journal.id)[0]);
  expect(feed().find((change) => change.blockId === kept.id)).toMatchObject({ actor: { actorId: "ext:tarot" }, requestedBy: { author: "user" } });
  program.stdin.write("q");
  await program.stdin.flush();
  expect(await program.exited).toBe(0);
});

// ── C5: the edit guard, a live draft, inert created text ─────────────────

test("an action's update goes through draft.patch: the edit guard refuses dropping a page, and a stale revision writes nothing", async () => {
  const { store, client, scribe, act } = await setup();
  await scribe();
  const page = await client.request<Block>({ action: "create", text: "Garden\n[page::Garden plan]\nbeds by the fence", author: "user" });
  await expect(act("rewrite", page.id, { text: "overwritten by ext" })).rejects.toThrow("would drop [page::Garden plan]");
  expect(store.get(page.id)!.text).toBe("Garden\n[page::Garden plan]\nbeds by the fence");
  // Only the changed line is the patch: the page line stays as it was.
  const done = await act("rewrite", page.id, { text: "Garden\n[page::Garden plan]\nbeds by the shed" });
  expect(done.written).toEqual([page.id]);
  expect(store.get(page.id)).toMatchObject({ text: "Garden\n[page::Garden plan]\nbeds by the shed", author: "user" });
});

test("an action's update reaches a door's live draft, not the saved note under the person's typing", async () => {
  const { store, client, scribe, act } = await setup();
  await scribe();
  const note = await client.request<Block>({ action: "create", text: "Errands\nbuy bread\nmore later", author: "user" });
  // A stand-in door holding a draft: the person typed a line at the end the saved note doesn't have.
  const door = { text: "Errands\nbuy bread\nmore later\ncall the vet" };
  const connected = Promise.withResolvers<void>();
  const watcher = client.watch({
    client: { clientId: "door-writes", role: "observer", contextId: "door-writes" }, onConnect: connected.resolve,
    onEvent: async (event: OutlinerEvent) => {
      const ask = event.domain === "draft" ? event.draft : undefined;
      if (!ask) return;
      let answer: unknown = { applied: false, reason: "unexpected" };
      if (ask.kind === "read") answer = { text: door.text, revision: note.revision };
      else if (ask.kind === "patch") {
        const located = locateSpans(door.text, ask.patches);
        if (located.ok) { door.text = applyLocated(door.text, located.spans); answer = { applied: true }; }
        else answer = { applied: false, reason: located.reason };
      }
      await client.request({ action: "drafts.answer", requestId: ask.requestId, clientId: "door-writes", answer: answer as never }).catch(() => undefined);
    },
  });
  cleanups.push(() => watcher.stop());
  await connected.promise;
  await client.request({ action: "drafts.hold", blockId: note.id, clientId: "door-writes", revision: note.revision });
  const done = await act("rewrite", note.id, { text: "Errands\nbuy rye bread\nmore later" });
  expect(done.written).toEqual([note.id]);
  expect(door.text).toBe("Errands\nbuy rye bread\nmore later\ncall the vet");
  expect(store.get(note.id)!.text).toBe("Errands\nbuy bread\nmore later");
});

test("a created block's text is inert BlockDown with no terminal escapes", async () => {
  const { store, client, scribe, act } = await setup();
  await scribe();
  const note = await client.request<Block>({ action: "create", text: "Log", author: "user" });
  const done = await act("child", note.id, { text: `child ${ESC}\nstatus:: hacked\n[owner::someone]` });
  const child = store.get(done.written[0]!)!;
  expect(child.text).toBe("child \nstatus:‍: hacked\n\\[owner::someone]");
  expect(child.properties ?? []).toEqual([]);
  expect(child).toMatchObject({ author: "agent", actorId: "ext:scribe" });
});

test("wholeTextSpan: the changed lines as one span, widened to a neighbour when the change is at a blank line", () => {
  const apply = (before: string, after: string) => {
    const span = wholeTextSpan(before, after)!;
    expect(span.observed.length).toBeGreaterThan(0);
    const located = locateSpans(before, [span]);
    expect(located.ok).toBe(true);
    return located.ok ? applyLocated(before, located.spans) : "";
  };
  for (const [before, after] of [
    ["a\nb\nc", "a\nB\nc"], ["a\nb", "a\nb\nc"], ["a\nb", "z\na\nb"], ["a\n\nc", "a\nx\nc"], ["\n\n", "\nx\n"], ["a", ""], ["one two", "one three two"],
  ]) expect(apply(before!, after!)).toBe(after!);
  expect(wholeTextSpan("same", "same")).toBeNull();
  expect(wholeTextSpan("a\nb\nc", "a\nB\nc")).toMatchObject({ observed: "b", replacement: "B", range: { start: 2, end: 3 } });
});

// ── B6: disabled mid-call ────────────────────────────────────────────────

for (const how of ["disabled", "removed"] as const) {
  test(`an extension ${how} while its action runs: the answer is discarded, nothing is written`, async () => {
    const { store, client, extensions, scribe, act } = await setup();
    await scribe();
    const note = await client.request<Block>({ action: "create", text: "Slow note", author: "user" });
    const running = act("slow", note.id).then(() => null, (error: Error) => error);
    await Bun.sleep(300);
    if (how === "disabled") writeFileSync(join(extensions, "scribe", "config.json"), JSON.stringify({ enabled: false }));
    else rmSync(join(extensions, "scribe"), { recursive: true, force: true });
    const error = await running;
    expect(error?.message).toContain("while it ran; its answer was discarded");
    expect(store.children(note.id)).toEqual([]);
  });
}

test("an @agent disabled while it runs: its reply and patch are dropped", async () => {
  const { store, client, extensions, install } = await setup();
  await install("slowpoke", { agents: [{ name: "slowpoke" }] }, `await Bun.stdin.json(); await Bun.sleep(900);
process.stdout.write(JSON.stringify({ ok: true, value: { patches: [{ observed: "messy", replacement: "TIDIED" }] } }));`);
  const note = await client.request<Block>({ action: "create", text: "N\nmessy\n@slowpoke", author: "user" });
  await until("running", () => store.agentRequests(note.id)[0]?.status === "running");
  writeFileSync(join(extensions, "slowpoke", "config.json"), JSON.stringify({ enabled: false }));
  const row = await until("answered", () => store.agentRequests(note.id).find((candidate) => candidate.status !== "running"));
  expect(row.status).toBe("failed");
  expect(row.message).toContain("was changed, disabled or removed while it ran");
  expect(store.get(note.id)!.text).toBe("N\nmessy\n@slowpoke");
});

// ── C7: clean text ───────────────────────────────────────────────────────

test("what an extension says is kept and shown without terminal escapes: outputs, messages, replies, its manifest's words, ext ls and ext act", async () => {
  const { store, client, install, scribe, act } = await setup();
  const listed = await install("loud", { name: `Loud${ESC}`, description: `says ${ESC}things`,
    actions: [{ id: "shout", label: `Shout${ESC}` }] }, `process.stdout.write(JSON.stringify({ ok: true, value: {} }));`);
  const loud = listed.extensions.find((entry) => entry.id === "loud")!;
  expect(loud.name).toBe("Loud");
  expect(loud.actions.find((action) => action.id === "shout")?.label).toBe("Shout");
  await scribe();
  const note = await client.request<Block>({ action: "create", text: "Sky\nmoon::", author: "user" });
  const read = await until("the output", async () => (await client.request<ResourceProjectionReadResult>({ action: "resources.projection.read", blockId: note.id }))
    .projections.find((projection) => projection.status === "ready"));
  expect(read.output?.markdown).toBe("moon is up   bright");
  expect(read.output?.title).toBe("Moon ");
  const terminal = await client.request<{ results: Array<{ rendered: { body: string } }> }>({ action: "extensions.render", blockId: note.id, target: "terminal" });
  expect(terminal.results[0]!.rendered.body).toBe("moon is up   bright");
  expect(terminal.results[0]!.rendered.body).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  const rewrote = await act("rewrite", note.id, { text: "Sky\nmoon::\nclear tonight" });
  expect(rewrote.message).toBe("rewrote it");

  // The CLI prints what an extension says clean, and a failed folder's name and error too.
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
  try {
    const next = store.get(note.id)!;
    await runExtCommand(["act", "scribe", "rewrite", "--block", note.id, "--arg", `text=${next.text}\nand stars`], async () => client);
  } finally {
    console.log = log;
  }
  expect(lines.join("\n")).toContain("rewrote it");
  const formatted = formatExtensionsList({
    generation: 1, roots: [], tileKinds: [], primitives: [], targets: [], trust: "trusted code",
    extensions: [{ id: `bad${ESC}`, origin: "outline", directory: `/tmp/bad${ESC}`, state: "failed", error: `extension.json is not valid JSON (${ESC})`,
      runsCode: false, handlers: [], actions: [], tiles: [], agents: [] }],
  } as unknown as ExtensionsListResult).join("\n");
  expect(formatted).not.toMatch(/[\x1b\x07\x9b]/);
  expect(formatted).toContain("bad\tfailed");
});

test("the one cleaner: escapes and C1 controls go, tabs stay, line breaks only when asked; inert BlockDown drops them too", () => {
  expect(cleanExtensionText(`a\tb${ESC}c\nd`)).toBe("a\tbcd");
  expect(cleanExtensionText(`a\tb${ESC}c\r\nd`, true)).toBe("a\tbc\nd");
  expect(cleanExtensionText("x\u0085y\u009b31mz")).toBe("xyz");
  expect(inertBlockdown(`body ${ESC}\njira:: KEY-1`)).toBe("body \njira:‍: KEY-1");
});

// ── C8: a secret file's problem, named ───────────────────────────────────

test("a secret file readable by others is refused by name and mode, never its content", async () => {
  const { root, store, client, install } = await setup();
  const secret = join(root, "fixture-token");
  writeFileSync(secret, "fixture-secret-value-123\n");
  chmodSync(secret, 0o644);
  await install("keyed", { secrets: { token: "a made-up token" }, actions: [{ id: "go", label: "Go" }] },
    `process.stdout.write(JSON.stringify({ ok: true, value: { message: "ran" } }));`, { secrets: { token: { file: secret } } });
  const note = await client.request<Block>({ action: "create", text: "Keyed", author: "user" });
  const go = () => client.request<{ message?: string }>({ action: "extensions.act", extension: "keyed", extensionAction: "go", blockId: note.id });
  const error = await go().then(() => null, (failure: Error) => failure.message);
  expect(error).toContain(`keyed's token secret file ${secret} is readable by others (mode 644); chmod 600 it`);
  expect(error).not.toContain("fixture-secret-value");
  chmodSync(secret, 0o600);
  expect((await go()).message).toBe("ran");
  rmSync(secret);
  expect(await go().then(() => null, (failure: Error) => failure.message)).toContain(`${secret} can't be read`);
  expect(store.get(note.id)!.text).toBe("Keyed");
});

// ── Watchers ─────────────────────────────────────────────────────────────

test("ext add over an install never leaves the folder without its extension.json", async () => {
  const { root } = await setup();
  const source = join(root, "source", "jokes");
  mkdirSync(source, { recursive: true });
  const write = (version: number) => {
    writeFileSync(join(source, "extension.json"), JSON.stringify({ contract: 2, id: "jokes", version, name: "Jokes", run: ["bun", "main.ts"], actions: [{ id: "tell", label: "Tell" }] }));
    writeFileSync(join(source, "main.ts"), `// version ${version}\nprocess.stdout.write("{}");`);
  };
  write(1);
  await addExtension(source);
  const installed = join(root, "user-extensions", "jokes");
  let missing = 0;
  let checking = true;
  const watch = (async () => { while (checking) { if (!existsSync(join(installed, "extension.json"))) missing += 1; await new Promise((resolve) => setImmediate(resolve)); } })();
  for (let version = 2; version < 8; version += 1) {
    write(version);
    await addExtension(source);
  }
  checking = false;
  await watch;
  expect(missing).toBe(0);
  expect(readFileSync(join(installed, "main.ts"), "utf8")).toContain("version 7");
  expect(JSON.parse(readFileSync(join(installed, "extension.json"), "utf8")).version).toBe(7);
});
