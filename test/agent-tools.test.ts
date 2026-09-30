// The CLI's `agent` command (src/agent-tools.ts), which the Claude mod's outline_* tools run: each operation
// against a private scratch service, as a spawned CLI the way the mod calls it. Fictional notes only.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { droppedStructure } from "../src/draft-patch";
import { changesSince, READ_CHILDREN_MAX_CHARS, referenceTarget, shortDiff } from "../src/agent-tools";
import { requireCapabilities } from "../src/service-compatibility";
import type { OutlinerServiceStatus } from "../src/types";
import { resolvePaths } from "../src/paths";
import { OutlinerServer } from "../src/server";
import { OutlinerStore } from "../src/store";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

/** The spawned CLI's environment: this fixture only, never a Herdr session or a real outline. */
function isolatedEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("HERDR_") && !key.startsWith("OUTLINER_") && !key.startsWith("EP0CH_")) env[key] = value;
  }
  return { ...env, ...extra };
}

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "outliner-agent-tools-"));
  const env = { OUTLINER_STATE_DIR: join(root, "state"), OUTLINER_WORKSPACE_ROOT: root };
  const paths = resolvePaths(env);
  const store = new OutlinerStore(paths.database, { workspaceRoot: root });
  const server = new OutlinerServer(store, paths.socket);
  await server.start();
  cleanups.push(async () => {
    await server.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const cliEnv = isolatedEnv(env);
  /** One `agent` operation as the mod runs it: JSON on stdin, as the garden agent. */
  const agent = async (operation: string, input: unknown, actor = "garden-agent") => {
    const child = Bun.spawn(["bun", "src/cli.ts", "agent", operation, "--stdin", "--actor", actor, "--session", "s-9"], {
      cwd: join(import.meta.dir, ".."), env: cliEnv, stdin: new Blob([JSON.stringify(input)]), stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { exitCode, stderr, json: exitCode === 0 ? JSON.parse(stdout) : undefined, stdout };
  };
  const cli = async (args: string[]) => {
    const child = Bun.spawn(["bun", "src/cli.ts", ...args], { cwd: join(import.meta.dir, ".."), env: cliEnv, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { exitCode, stdout, stderr };
  };
  return { store, agent, cli, root };
}

const LONG_NOTE = "Seed swap plan [page::Seed Swap] [kind::plan]\n\n## Beans\n\nBorlotti and runner beans. ^beans\n\n## Squash\n\nButternut only.";

test("read gives the full text, properties, revision and bounded children with a completeness flag", async () => {
  const { store, agent } = await setup();
  const note = store.create(LONG_NOTE);
  const child = store.create("Bring labels", note.id);
  store.create("Masking tape and a pen", child.id);
  store.create("Tables from the hall", note.id);

  const shallow = await agent("read", { ref: `((${note.id}))` });
  expect(shallow.exitCode).toBe(0);
  expect(shallow.json.text).toBe(LONG_NOTE); // never the title alone
  expect(shallow.json.revision).toBe(note.revision);
  expect(shallow.json.properties).toMatchObject({ page: "Seed Swap", kind: "plan" });
  expect(shallow.json.children.map((c: any) => c.text)).toEqual(["Bring labels", "Tables from the hall"]);
  expect(shallow.json.children[0].more).toBe(true);
  expect(shallow.json.complete).toBe(false);

  const deep = await agent("read", { ref: note.id, depth: 2 });
  expect(deep.json.children[0].children[0].text).toBe("Masking tape and a pen");
  expect(deep.json.complete).toBe(true);

  const capped = await agent("read", { ref: note.id, depth: 2, limit: 1 });
  expect(capped.json.children).toHaveLength(1);
  expect(capped.json.complete).toBe(false);

  const byPage = await agent("read", { ref: "[[Seed Swap]]", depth: 0 });
  expect(byPage.json.id).toBe(note.id);
  expect(byPage.json.children).toEqual([]);
  expect(byPage.json.complete).toBe(false);
});

test("resolve takes ids, ((refs)), [[pages]] and Work IDs, and refuses a title", async () => {
  const { store, agent, cli } = await setup();
  store.configureWorkIdPrefix("PIE");
  store.create("Work [type::work-queue] [project::garden]");
  const note = store.create("Compost rota [page::Compost]");
  const created = await cli(["work", "create", "--title", "Turn the heap", "--project", "garden", "--arc", "beds",
    "--track", "beds", "--priority", "low", "--author", "agent", "--actor", "garden-agent"]);
  const item = JSON.parse(created.stdout);
  expect((await agent("resolve", { ref: "[[Compost]]" })).json).toMatchObject({ id: note.id, title: "Compost rota" });
  expect((await agent("resolve", { ref: `((${note.id}))` })).json.id).toBe(note.id);
  expect((await agent("resolve", { ref: item.workId })).json).toMatchObject({ id: item.blockId, workId: item.workId });
  expect((await agent("resolve", { ref: `[[${item.workId}]]` })).json.id).toBe(item.blockId);
  const title = await agent("resolve", { ref: "Compost rota" });
  expect(title.exitCode).toBe(1);
  expect(title.stderr).toContain("titles aren't accepted");
  expect((await agent("resolve", { ref: "[[No such page]]" })).exitCode).toBe(1);
});

test("find by text, property, key, query and under", async () => {
  const { store, agent } = await setup();
  const beds = store.create("Raised beds [kind::area]");
  store.create("Carrots in bed one [crop::carrot]", beds.id);
  store.create("Leeks in bed two [crop::leek]", beds.id);
  store.create("Carrot cake recipe");
  const text = await agent("find", { text: "carrot" });
  expect(text.json.blocks.length).toBeGreaterThanOrEqual(2);
  expect((await agent("find", { property: "crop=leek" })).json.blocks.map((b: any) => b.title)).toEqual(["Leeks in bed two"]);
  expect((await agent("find", { hasKey: "crop" })).json.blocks).toHaveLength(2);
  expect((await agent("find", { query: "crop=carrot" })).json.blocks.map((b: any) => b.title)).toEqual(["Carrots in bed one"]);
  const under = await agent("find", { text: "carrot", under: beds.id });
  expect(under.json.blocks.map((b: any) => b.title)).toEqual(["Carrots in bed one"]);
  const capped = await agent("find", { hasKey: "crop", limit: 1 });
  expect(capped.json).toMatchObject({ complete: false });
  expect((await agent("find", {})).exitCode).toBe(1);
});

test("edit refuses an empty write and a stale revision, and writes nothing", async () => {
  const { store, agent } = await setup();
  const note = store.create("Shed keys: hook by the door");
  for (const text of ["", "   \n ", null]) {
    const refused = await agent("edit", { ref: note.id, expectedRevision: note.revision, text });
    expect(refused.exitCode).toBe(1);
  }
  expect((await agent("edit", { ref: note.id, expectedRevision: note.revision, text: " " })).stderr).toContain("empty");
  store.update(note.id, "Shed keys: under the pot", note.revision);
  const stale = await agent("edit", { ref: note.id, expectedRevision: note.revision, text: "Shed keys: lost" });
  expect(stale.exitCode).toBe(1);
  expect(stale.stderr).toContain("changed since you read it");
  expect(store.get(note.id)!.text).toBe("Shed keys: under the pot");
});

test("edit writes the whole text, a section or an addition as the agent, and returns the revision and a diff", async () => {
  const { store, agent, cli } = await setup();
  const note = store.create(LONG_NOTE);
  const whole = await agent("edit", { ref: note.id, expectedRevision: note.revision, text: LONG_NOTE.replace("Butternut only.", "Butternut and crown prince.") });
  expect(whole.exitCode).toBe(0);
  expect(whole.json.revision).toBe(note.revision + 1);
  expect(whole.json.diff).toContain("-Butternut only.");
  expect(whole.json.diff).toContain("+Butternut and crown prince.");

  const section = await agent("edit", { ref: note.id, expectedRevision: whole.json.revision, replaceSection: { heading: "## Squash", body: "None this year." } });
  expect(section.exitCode).toBe(0);
  expect(section.json.section).toEqual({ heading: "## Squash", previous: "Butternut and crown prince." });

  const appended = await agent("edit", { ref: note.id, expectedRevision: section.json.revision, append: "Swap starts at ten." });
  expect(store.get(note.id)!.text.endsWith("None this year.\n\nSwap starts at ten.")).toBe(true);

  const edited = store.get(note.id)!;
  expect(edited.revision).toBe(appended.json.revision);
  const activity = JSON.parse((await cli(["activity", "--author", "agent", "--actor", "garden-agent", "--limit", "5"])).stdout);
  expect(activity.entries.map((e: any) => [e.block.id, e.author, e.actorId, e.sessionId])).toEqual([[note.id, "agent", "garden-agent", "s-9"]]);
});

test("edit refuses dropping a [page::] or a linked anchor unless allowStructural", async () => {
  const { store, agent } = await setup();
  const note = store.create(LONG_NOTE);
  const noPage = await agent("edit", { ref: note.id, expectedRevision: note.revision, text: LONG_NOTE.replace(" [page::Seed Swap]", "") });
  expect(noPage.exitCode).toBe(1);
  expect(noPage.stderr).toContain("[page::Seed Swap]");

  // An anchor nobody links to may go; one another note links to may not.
  const unlinked = await agent("edit", { ref: note.id, expectedRevision: note.revision, text: LONG_NOTE.replace(" ^beans", "") });
  expect(unlinked.exitCode).toBe(0);
  const back = await agent("edit", { ref: note.id, expectedRevision: unlinked.json.revision, text: LONG_NOTE });
  store.create(`Bean list: ((${note.id}^beans))`);
  const linked = await agent("edit", { ref: note.id, expectedRevision: back.json.revision, text: LONG_NOTE.replace(" ^beans", "") });
  expect(linked.exitCode).toBe(1);
  expect(linked.stderr).toContain("^beans (1 note links to it)");
  for (const allowStructural of ["true", 1]) {
    expect((await agent("edit", { ref: note.id, expectedRevision: back.json.revision, text: LONG_NOTE.replace(" ^beans", ""), allowStructural })).exitCode).toBe(1);
  }
  const allowed = await agent("edit", { ref: note.id, expectedRevision: back.json.revision, text: LONG_NOTE.replace(" ^beans", ""), allowStructural: true });
  expect(allowed.exitCode).toBe(0);
  // What it let go is said in the result.
  expect(allowed.json.dropped).toEqual(["^beans"]);
});

test("an agent's note section or item body can't drop them either; the person's can", async () => {
  const { store, cli, root } = await setup();
  const note = store.create(LONG_NOTE);
  store.create(`Bean list: ((${note.id}^beans))`);
  const body = join(root, "body.md");
  writeFileSync(body, "Runner beans only.");
  const asAgent = await cli(["note", "section", note.id, "Beans", "--file", body, "--author", "agent", "--actor", "garden-agent"]);
  expect(asAgent.exitCode).toBe(1);
  expect(asAgent.stderr).toContain("^beans (1 note links to it)");
  expect(store.get(note.id)!.text).toBe(LONG_NOTE);
  const itemBody = await cli(["work", "body", note.id, "--file", body, "--author", "agent", "--actor", "garden-agent"]);
  expect(itemBody.exitCode).toBe(1);
  expect(itemBody.stderr).toContain("^beans (1 note links to it)");
  expect(store.get(note.id)!.text).toBe(LONG_NOTE);
  const asPerson = await cli(["note", "section", note.id, "Beans", "--file", body]);
  expect(asPerson.exitCode).toBe(0);
  expect(store.get(note.id)!.text).toContain("## Beans\n\nRunner beans only.");
});

test("read stops at a budget of children's text, saying it is incomplete", async () => {
  const { store, agent } = await setup();
  const note = store.create("Seed catalogue");
  store.create(`Tomatoes ${"x".repeat(READ_CHILDREN_MAX_CHARS - 100)}`, note.id);
  store.create(`Peppers ${"y".repeat(500)}`, note.id);
  const read = await agent("read", { ref: note.id, limit: 500 });
  expect(read.json.children).toHaveLength(1);
  expect(read.json.complete).toBe(false);
});

test("create puts a block under a parent at a position, as the agent", async () => {
  const { store, agent } = await setup();
  const list = store.create("Jobs");
  store.create("Water the seedlings", list.id);
  const created = await agent("create", { parent: `((${list.id}))`, text: "Open the greenhouse", position: 0 });
  expect(created.exitCode).toBe(0);
  const block = store.get(created.json.id)!;
  expect(block).toMatchObject({ parentId: list.id, author: "agent", actorId: "garden-agent" });
  expect(store.children(list.id).map(child => child.text)).toEqual(["Open the greenhouse", "Water the seedlings"]);
  expect((await agent("create", { parent: list.id, text: "  " })).exitCode).toBe(1);
});

test("a comment, a reply and resolving the thread are the agent's", async () => {
  const { store, agent } = await setup();
  const note = store.create("Order more twine before May");
  const comment = await agent("comment", { ref: note.id, quote: "twine", body: "Jute or sisal?" });
  expect(comment.exitCode).toBe(0);
  expect(comment.json).toMatchObject({ author: "agent", actorId: "garden-agent", blockId: note.id, lifecycle: "open" });
  const thread = store.get(comment.json.thread)!;
  expect(thread).toMatchObject({ author: "agent", actorId: "garden-agent" });

  const reply = await agent("reply", { thread: comment.json.thread, body: "Jute, it composts." }, "helper-agent");
  expect(reply.json).toMatchObject({ thread: comment.json.thread, author: "agent", actorId: "helper-agent" });
  const resolved = await agent("resolve-thread", { thread: comment.json.thread, resolved: true });
  expect(resolved.json).toMatchObject({ thread: comment.json.thread, lifecycle: "resolved" });

  const whole = await agent("comment", { ref: note.id, whole: true, body: "Due this week." });
  expect(whole.exitCode).toBe(0);
  expect((await agent("comment", { ref: note.id, body: "Neither quote nor whole" })).exitCode).toBe(1);
});

test("the CLI's comment records an agent author with --author agent --actor, and the person's by default", async () => {
  const { store, cli } = await setup();
  const note = store.create("Fence posts need creosote");
  const asAgent = await cli(["comment", "--id", note.id, "--expected", String(note.revision), "--request-id", "c-1", "--whole", "--text", "Try linseed.", "--author", "agent", "--actor", "garden-agent"]);
  expect(asAgent.exitCode).toBe(0);
  const record = JSON.parse(asAgent.stdout).annotations[0];
  expect(record).toMatchObject({ source: "agent", block: { author: "agent", actorId: "garden-agent" } });
  const asPerson = await cli(["comment", "--id", note.id, "--expected", String(note.revision), "--request-id", "c-2", "--whole", "--text", "Fine."]);
  expect(JSON.parse(asPerson.stdout).annotations[0]).toMatchObject({ source: "user", block: { author: "user" } });
  const noActor = await cli(["comment", "--id", note.id, "--expected", String(note.revision), "--request-id", "c-3", "--whole", "--text", "x", "--author", "agent"]);
  expect(noActor.exitCode).not.toBe(0);
});

test("changes since a time or cursor, narrowed by author or actor", async () => {
  const { store, agent, cli } = await setup();
  const start = new Date(Date.now() - 1000).toISOString();
  const mine = store.create("Sow lettuce");
  await cli(["update", "--id", mine.id, "--text", "Sow lettuce, little gem", "--expected", String(mine.revision)]);
  const note = store.create("Mulch the roses");
  await agent("edit", { ref: note.id, expectedRevision: note.revision, text: "Mulch the roses with bark" });
  const other = store.create("Prune the apple");
  await agent("edit", { ref: other.id, expectedRevision: other.revision, text: "Prune the apple in winter" }, "helper-agent");

  const all = await agent("changes", { since: start });
  expect(all.json.entries.map((e: any) => e.id)).toEqual(expect.arrayContaining([mine.id, note.id, other.id]));
  const byActor = await agent("changes", { since: start, actor: "garden-agent" });
  expect(byActor.json.entries.map((e: any) => [e.id, e.actorId])).toEqual([[note.id, "garden-agent"]]);
  const people = await agent("changes", { since: start, author: "user" });
  expect(people.json.entries.map((e: any) => e.id)).toContain(mine.id);
  expect(people.json.entries.map((e: any) => e.id)).not.toContain(note.id);

  expect(all.json.complete).toBe(true);
  // A cut answer pages back with `before` until complete: every block once, none skipped.
  const seen: string[] = [];
  let page = await agent("changes", { since: start, limit: 2 });
  expect(page.json.entries).toHaveLength(2);
  expect(page.json.complete).toBe(false);
  for (let calls = 0; ; calls++) {
    seen.push(...page.json.entries.map((e: any) => e.id));
    expect(page.json.cursor).toBe(all.json.cursor);
    if (page.json.complete) break;
    expect(calls).toBeLessThan(5);
    page = await agent("changes", { since: start, limit: 2, before: page.json.before });
  }
  expect(seen.sort()).toEqual(all.json.entries.map((e: any) => e.id).sort());
  const later = await agent("changes", { since: all.json.cursor });
  expect(later.json.entries).toEqual([]);
  expect(later.json.complete).toBe(true);
  expect((await agent("changes", { since: "last tuesday" })).exitCode).toBe(1);
});

test("patch swaps a span of the saved note as the agent, and a structural change becomes a proposal", async () => {
  const { store, agent } = await setup();
  const note = store.create("Beds: two  raised beds by the fence. ^beds");
  const applied = await agent("patch", { ref: note.id, revision: note.revision, patches: [{ observed: "two  raised", replacement: "two raised" }] });
  expect(applied.exitCode).toBe(0);
  expect(applied.json.outcome).toBe("applied");
  expect(store.get(note.id)!.text).toBe("Beds: two raised beds by the fence. ^beds");
  const current = store.get(note.id)!;
  const proposed = await agent("patch", { ref: note.id, revision: current.revision, patches: [{ observed: "fence. ^beds", replacement: "fence." }] });
  // Not applied: the proposal is a reply block, embedded under the note for the person to apply or not.
  expect(proposed.json.outcome).toBe("proposed");
  expect(proposed.json.reason).toContain("^beds");
  expect(store.get(note.id)!.text).toBe(`${current.text}\n!((${proposed.json.proposalId}))`);
});

test("writes without an actor are refused; reads need none", async () => {
  const { store, cli } = await setup();
  const note = store.create("Hose reel");
  const edit = await cli(["agent", "edit", "--json", JSON.stringify({ ref: note.id, expectedRevision: note.revision, text: "Hose" })]);
  expect(edit.exitCode).toBe(1);
  expect(edit.stderr).toContain("--actor");
  expect(store.get(note.id)!.text).toBe("Hose reel");
  const read = await cli(["agent", "read", "--json", JSON.stringify({ ref: note.id })]);
  expect(read.exitCode).toBe(0);
  expect(JSON.parse(read.stdout).text).toBe("Hose reel");
});

test("references, dropped structure and the short diff", () => {
  expect(referenceTarget("((0f3c2a1b-1111-4222-8333-444455556666^beans))")).toEqual({ kind: "block", value: "0f3c2a1b-1111-4222-8333-444455556666", fragmentId: "beans" });
  expect(referenceTarget("[[PIE-12]]")).toEqual({ kind: "work", value: "PIE-012" });
  expect(referenceTarget("[[Seed Swap]]")).toEqual({ kind: "page", value: "Seed Swap" });
  expect(() => referenceTarget("seed swap notes")).toThrow("titles aren't accepted");
  expect(droppedStructure("A [page::X] ^a\nB [kind::y] ^b", "A ^a\nB [kind::z]")).toEqual({ pages: ["[page::X]"], anchors: ["b"] });
  expect(shortDiff("a\nb\nc", "a\nB\nc")).toBe("@@ line 2\n-b\n+B");
  expect(shortDiff("same", "same")).toBe("");
});

test("the service advertises activity.actor, and an actor filter is never sent to one without it", async () => {
  const { cli } = await setup();
  // The scratch service offers it: the CLI checks before asking.
  expect((await cli(["activity", "--author", "agent", "--actor", "garden-agent"])).exitCode).toBe(0);

  const status = { protocolVersion: 82, capabilities: ["mutations.provenance"] } as unknown as OutlinerServiceStatus;
  const sent: unknown[] = [];
  const older = {
    request: async <T>(input: unknown) => { sent.push(input); return { entries: [], cursor: 0 } as T; },
    requireCompatibleService: async (needed: readonly string[] = []) => requireCapabilities(status, needed as never),
  };
  await expect(changesSince(older, { since: "2026-03-01T00:00:00Z", actor: "garden-agent" })).rejects.toThrow("does not support activity.actor");
  expect(sent).toEqual([]);
  // Without an actor, an older service is asked as before.
  await changesSince(older, { since: "2026-03-01T00:00:00Z", author: "agent" });
  expect(sent).toHaveLength(1);
});
