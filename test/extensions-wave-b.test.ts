// Wave B of the extension design (PIE-507): watched extension folders with hot reload, clear load
// errors, `ext add|remove|ls|act`, and one working example of each of the four kinds (moon: data,
// horoscope: inline output, fancy-horror: rich component, tarot: a whole tile). Every service here is
// a scratch service in a temp folder; every note, sign and date is made up.
import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutlinerClient } from "../src/client";
import { OutlinerServer } from "../src/server";
import { OutlinerStore } from "../src/store";
import { runExtCommand } from "../src/extension-install";
import type { ExtensionsListResult } from "../src/extension-registry";
import type { ResourceProjection, ResourceProjectionReadResult } from "../src/resource-projection";
import type { Block, OutlinerServiceStatus } from "../src/types";

const REPO_EXTENSIONS = join(import.meta.dir, "..", "extensions");
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

/** A scratch service whose outline root (and so its `extensions/` folder) is a temp folder. */
async function setup(options: { install?: string[]; userInstall?: string[] } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "outliner-ext-b-")));
  const previous = { dir: process.env.OUTLINER_EXTENSIONS_DIR, registry: process.env.OUTLINER_RESOURCE_EXTENSIONS };
  process.env.OUTLINER_EXTENSIONS_DIR = join(root, "user-extensions");
  process.env.OUTLINER_RESOURCE_EXTENSIONS = join(root, "no-legacy-registry.json");
  const outlineFolder = join(root, "outline");
  mkdirSync(join(outlineFolder, "extensions"), { recursive: true });
  for (const name of options.install ?? []) cpSync(join(REPO_EXTENSIONS, name), join(outlineFolder, "extensions", name), { recursive: true });
  for (const name of options.userInstall ?? []) cpSync(join(REPO_EXTENSIONS, name), join(root, "user-extensions", name), { recursive: true });
  const store = new OutlinerStore(join(root, "outliner.sqlite"), { workspaceRoot: outlineFolder });
  const socket = join(root, "outliner.sock");
  const server = new OutlinerServer(store, socket, undefined, undefined, { extensionPollMs: 0 });
  await server.start();
  const client = new OutlinerClient(socket);
  const events: Array<{ domain: string; action: string; blockId?: string }> = [];
  const connected = Promise.withResolvers<void>();
  const watcher = client.watch({
    client: { clientId: "ext-test-observer", role: "observer", contextId: "ext-test-observer" },
    onConnect: connected.resolve, onError: connected.reject, onEvent: (event) => { events.push(event); },
  });
  await connected.promise;
  cleanups.push(async () => {
    await watcher.stop();
    await server.close();
    store.close();
    for (const [key, value] of [["OUTLINER_EXTENSIONS_DIR", previous.dir], ["OUTLINER_RESOURCE_EXTENSIONS", previous.registry]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const create = (text: string, parentId?: string, by?: { author: "user" | "agent"; actorId?: string }) =>
    client.request<Block>({ action: "create", text, ...(parentId ? { parentId } : {}),
      ...(by ? { author: by.author, ...(by.actorId ? { provenance: { actorId: by.actorId } } : {}) } : {}) });
  const list = (reload = false) => client.request<ExtensionsListResult>({ action: "extensions.list", ...(reload ? { reload: true } : {}) });
  const projections = async (blockId: string) =>
    (await client.request<ResourceProjectionReadResult>({ action: "resources.projection.read", blockId })).projections;
  const projection = (blockId: string, kind: string, ready: (projection: ResourceProjection) => boolean = (p) => p.status === "ready") =>
    until(`${kind} projection`, async () => (await projections(blockId)).find((p) => p.kind === kind && ready(p)));
  const extensionsFolder = join(outlineFolder, "extensions");
  return { root, outlineFolder, extensionsFolder, store, server, client, events, create, list, projections, projection };
}

function writeExtension(folder: string, id: string, manifest: Record<string, unknown>, code?: string): void {
  mkdirSync(join(folder, id), { recursive: true });
  writeFileSync(join(folder, id, "extension.json"), JSON.stringify({ contract: 2, id, version: 1, name: id, ...manifest }, null, 2));
  if (code !== undefined) writeFileSync(join(folder, id, "main.ts"), code);
}

const ECHO = `const request = await Bun.stdin.json();
process.stdout.write(JSON.stringify({ ok: true, value: { markdown: "echo " + (request.input.argument ?? "") + " v" + (globalThis.VERSION ?? 1) } }));`;

// ── Folders, hot reload and errors ───────────────────────────────────────

test("the service watches its extension folders: a folder added, broken, fixed and deleted applies without a restart", async () => {
  const { extensionsFolder, list, events, create, projection, projections } = await setup();
  const status = await (new OutlinerClient(join(extensionsFolder, "..", "..", "outliner.sock"))).request<OutlinerServiceStatus>({ action: "ping" });
  expect(status.capabilities).toEqual(expect.arrayContaining(["extensions.list", "extensions.outputs", "extensions.render", "extensions.act"]));
  expect((await list()).extensions).toEqual([]);

  // Added: the handler is there once the folder is quiet, and an extensions event says so.
  writeExtension(extensionsFolder, "echo", { run: ["bun", "main.ts"], handlers: [{ key: "echo", kind: "output", effects: "read" }] }, ECHO);
  await until("echo to load", async () => (await list()).extensions.find((entry) => entry.id === "echo" && entry.state === "active"));
  expect(events.some((event) => event.domain === "extensions" && event.action === "extensions.changed")).toBe(true);
  const block = await create("Notes\necho:: hello");
  expect((await projection(block.id, "output")).output?.markdown).toBe("echo hello v1");

  // Broken: it keeps serving the last good version and says exactly what is wrong, naming the file and field.
  writeFileSync(join(extensionsFolder, "echo", "extension.json"), JSON.stringify({ contract: 2, id: "echo", version: 2, name: "echo", run: ["bun", "main.ts"],
    handlers: [{ key: "echo", kind: "outptu", effects: "read" }] }));
  const failed = await until("echo to fail", async () => (await list()).extensions.find((entry) => entry.id === "echo" && entry.state === "failed"));
  expect(failed.error).toContain("extension.json: handlers/0/kind must be one of resource, data, output, component");
  expect(failed.error).toContain("still serving version 1");
  expect(failed.handlers.map((handler) => handler.key)).toEqual(["echo"]);
  const stillRuns = await (new OutlinerClient(join(extensionsFolder, "..", "..", "outliner.sock"))).request<ResourceProjectionReadResult>(
    { action: "resources.projection.refresh", blockId: block.id });
  expect(stillRuns.projections[0]).toMatchObject({ status: "ready", output: { markdown: "echo hello v1" } });

  // Fixed, as version 2: the line runs again on its own (a new version reruns a read handler on open).
  writeFileSync(join(extensionsFolder, "echo", "main.ts"), ECHO.replace("globalThis.VERSION ?? 1", "2"));
  writeFileSync(join(extensionsFolder, "echo", "extension.json"), JSON.stringify({ contract: 2, id: "echo", version: 2, name: "echo", run: ["bun", "main.ts"],
    handlers: [{ key: "echo", kind: "output", effects: "read" }] }));
  await until("echo v2", async () => (await list()).extensions.find((entry) => entry.id === "echo" && entry.state === "active" && entry.version === 2));
  await until("the rerun", async () => {
    const read = await (new OutlinerClient(join(extensionsFolder, "..", "..", "outliner.sock"))).request<ResourceProjectionReadResult>({ action: "resources.projection.read", blockId: block.id, materialize: true });
    return read.projections.find((p) => p.output?.markdown === "echo hello v2");
  });

  // Deleted: everything it declared goes; the line is plain text again.
  rmSync(join(extensionsFolder, "echo"), { recursive: true });
  await until("echo to go", async () => !(await list()).extensions.some((entry) => entry.id === "echo"));
  expect(await projections(block.id)).toEqual([]);
});

test("a folder that never loaded serves nothing and says why; contract 1, a wrong id and an unknown field are named", async () => {
  const { extensionsFolder, list } = await setup();
  writeExtension(extensionsFolder, "typo", { run: ["bun", "main.ts"], handlers: [{ key: "typo", kind: "output", effects: "read", efects: "read" }] }, ECHO);
  writeExtension(extensionsFolder, "mismatch", { id: "other", run: ["bun", "main.ts"], handlers: [{ key: "mismatch", kind: "output", effects: "read" }] }, ECHO);
  mkdirSync(join(extensionsFolder, "old"));
  writeFileSync(join(extensionsFolder, "old", "extension.json"), JSON.stringify({ contract: 1, id: "old", version: 1, command: ["x"], configSchema: {} }));
  mkdirSync(join(extensionsFolder, "nojson"));
  writeFileSync(join(extensionsFolder, "nojson", "extension.json"), "{ \"contract\": 2,");
  writeExtension(extensionsFolder, "taken", { run: ["bun", "main.ts"], handlers: [{ key: "status", kind: "output", effects: "read" }] }, ECHO);
  const { extensions } = await list(true);
  const byId = Object.fromEntries(extensions.map((entry) => [entry.id, entry]));
  expect(byId.typo).toMatchObject({ state: "failed", handlers: [], error: "extension.json: handlers/0 has a field it doesn't know: efects" });
  expect(byId.mismatch!.error).toBe("extension.json: id other must match the folder's name (mismatch)");
  expect(byId.old!.error).toContain("contract 1");
  expect(byId.nojson!.error).toMatch(/^extension.json is not valid JSON/);
  expect(byId.taken!.error).toContain("status is a property the outline already uses");
});

test("the outline's own folder wins over the user folder; two extensions can't serve one key", async () => {
  const { root, extensionsFolder, list } = await setup({ install: ["horoscope"], userInstall: ["horoscope"] });
  writeExtension(join(root, "user-extensions"), "stars", { run: ["bun", "main.ts"], handlers: [{ key: "horoscope", kind: "output", effects: "read" }] }, ECHO);
  const { extensions } = await list(true);
  const outline = extensions.find((entry) => entry.id === "horoscope" && entry.origin === "outline");
  const user = extensions.find((entry) => entry.id === "horoscope" && entry.origin === "user");
  expect(outline).toMatchObject({ state: "active", directory: join(extensionsFolder, "horoscope") });
  expect(user).toMatchObject({ state: "shadowed" });
  const stars = extensions.find((entry) => entry.id === "stars")!;
  expect(stars.handlers).toEqual([]);
  expect(stars.error).toContain("handler horoscope:: is already served by horoscope");
});

// ── Kind 1: data ─────────────────────────────────────────────────────────

test("moon (data): a record put into a block as if copied in, queryable, owned, one per key, to Trash when unused", async () => {
  const { root, extensionsFolder, store, client, create, list, projection } = await setup({ install: ["moon"] });
  const page = await create("Garden plan\nmoon:: 2026-10-26");
  const shown = await projection(page.id, "data");
  expect(shown).toMatchObject({ provider: "moon", label: "Moon", key: "2026-10-26" });
  expect(shown.fields).toEqual([{ label: "phase", value: "Full Moon" }, { label: "illumination", value: "100%" }]);
  const record = store.get(shown.record!.blockId)!;
  expect(record.parentId).toBe(page.id);
  expect(record.text).toStartWith("Moon on 2026-10-26: Full Moon\n[moon.key::2026-10-26] [moon.phase::Full Moon]");
  expect(record.actorId).toBe("ext:moon");

  // Queryable like any block.
  const found = await client.request<{ blocks: { id: string }[] }>({ action: "blocks.query", query: { expression: "moon.phase=\"Full Moon\"", limit: 10 } });
  expect(found.blocks.map((match) => match.id)).toEqual([record.id]);

  // Owned: a person's edit is refused with a reason; their own notes go on the asking block.
  await expect(client.request({ action: "update", blockId: record.id, text: `${record.text}\nmine`, expectedRevision: record.revision, mutation: PERSON }))
    .rejects.toThrow(/comes from Moon/);

  // A second line for the same date shares the one record.
  const other = await create("Other note\nmoon:: 2026-10-26");
  const again = await projection(other.id, "data");
  expect(again.record!.blockId).toBe(record.id);

  // The extension removed: its record stays, as data, even when the asking note is saved again.
  const moonFolder = join(extensionsFolder, "moon");
  const kept = join(root, "moon-aside");
  cpSync(moonFolder, kept, { recursive: true });
  rmSync(moonFolder, { recursive: true });
  await until("moon to go", async () => !(await list()).extensions.length);
  const asking = store.get(page.id)!;
  await client.request({ action: "update", blockId: page.id, text: `${asking.text}\nmore notes`, expectedRevision: asking.revision, mutation: PERSON });
  await Bun.sleep(200);
  expect(store.get(record.id)!.effectiveDeletedRootId).toBeFalsy();
  cpSync(kept, moonFolder, { recursive: true });
  await until("moon back", async () => (await list()).extensions.some((entry) => entry.state === "active"));

  // When nothing asks, the record goes to Trash.
  for (const id of [page.id, other.id]) {
    const current = store.get(id)!;
    await client.request({ action: "update", blockId: id, text: current.text.split("\n")[0], expectedRevision: current.revision, mutation: PERSON });
  }
  await until("the record in Trash", () => store.get(record.id)?.effectiveDeletedRootId);
});

// ── Kind 2: inline output ────────────────────────────────────────────────

test("horoscope (inline output): runs on save, is shown under its line, kept as a block on keep, and refreshed on r", async () => {
  const { store, client, create, projection, events } = await setup({ install: ["horoscope"] });
  const block = await create("Morning\nhoroscope:: virgo\nhoroscope:: virgo --short\nhoroscope:: leo --day=tomorrow");
  const first = await projection(block.id, "output");
  expect(first).toMatchObject({ provider: "horoscope", propertyKey: "horoscope", key: "virgo", anchor: { line: 1 },
    extension: { id: "horoscope", handler: "horoscope", effects: "read" } });
  expect(first.output!.markdown).toMatch(/^\*\*Virgo, \d{4}-\d{2}-\d{2}\.\*\* /);
  expect(events.some((event) => event.domain === "resource-catalog" && event.action === "extensions.output" && event.blockId === block.id)).toBe(true);

  // A display option (--short) never reaches the extension: the two virgo lines share one result.
  const all = await until("all three", async () => {
    const read = (await client.request<ResourceProjectionReadResult>({ action: "resources.projection.read", blockId: block.id })).projections;
    return read.length === 3 && read.every((p) => p.status === "ready") ? read : null;
  });
  expect(all[1]!.output!.markdown).toBe(all[0]!.output!.markdown);
  expect(all[1]!.extension!.display).toEqual({ short: true });
  expect(store.extensionOutputs(block.id)).toHaveLength(2);

  // keep: the output as a real block under the note, attributed to the extension.
  const kept = await client.request<{ written: string[] }>({ action: "extensions.act", extension: "horoscope", extensionAction: "keep", blockId: block.id, line: 1 });
  const keptBlock = store.get(kept.written[0]!)!;
  expect(keptBlock).toMatchObject({ parentId: block.id, author: "agent", actorId: "ext:horoscope" });
  expect(keptBlock.text).toContain("Lucky number:");

  // r: runs the line now (ranAt moves).
  await Bun.sleep(20);
  const refreshed = await client.request<ResourceProjectionReadResult>({ action: "resources.projection.refresh", blockId: block.id, line: 1 });
  expect(Date.parse(refreshed.projections.find((p) => p.anchor.line === 1)!.output!.ranAt)).toBeGreaterThan(Date.parse(first.output!.ranAt));

  // Rendered to other targets.
  const rendered = await client.request<{ results: { rendered: { body: string; contentType: string } }[] }>({ action: "extensions.render", blockId: block.id, line: 1, target: "blockdown" });
  expect(rendered.results[0]!.rendered.body).toContain("Lucky number:");
  // A bad argument is a reason on the line, not a run.
  const bad = await create("horoscope:: Wednesday");
  expect((await projection(bad.id, "output", (p) => p.status === "unavailable")).reason).toBe("Wednesday isn't a zodiac sign, in lowercase");
});

test("effects: a spend handler runs once when a person writes it, waits for r when an agent does, and a write handler only on r", async () => {
  const { extensionsFolder, store, client, create, list, projection } = await setup();
  writeExtension(extensionsFolder, "costly", { run: ["bun", "main.ts"], handlers: [
    { key: "costly", kind: "output", effects: "spend" },
    { key: "risky", kind: "output", effects: "write" },
  ] }, ECHO);
  await list(true);
  const mine = await create("costly:: mine", undefined, { author: "user" });
  expect((await projection(mine.id, "output")).output!.markdown).toBe("echo mine v1");
  // Edited afterwards (still typing), a spend line waits for r instead of spending on every save.
  await client.request({ action: "update", blockId: mine.id, text: "costly:: mine, longer", expectedRevision: mine.revision, mutation: PERSON });
  await projection(mine.id, "output", (p) => p.status === "not-run");
  await Bun.sleep(150);
  expect(store.extensionOutputs(mine.id)).toEqual([]);
  const theirs = await create("costly:: theirs", undefined, { author: "agent", actorId: "claude-test" });
  const waiting = await projection(theirs.id, "output", (p) => p.status === "not-run");
  expect(waiting.reason).toContain("r runs it");
  await Bun.sleep(150);
  expect(store.extensionOutputs(theirs.id)).toEqual([]);
  const risky = await create("risky:: now");
  await Bun.sleep(150);
  expect(store.extensionOutputs(risky.id)).toEqual([]);
  const ran = await client.request<ResourceProjectionReadResult>({ action: "resources.projection.refresh", blockId: risky.id });
  expect(ran.projections[0]!.output!.markdown).toBe("echo now v1");
});

// ── Kind 3: rich component ───────────────────────────────────────────────

test("fancy-horror (rich component): data plus a primitive view, rendered to every target; ward writes a block and the view follows", async () => {
  const { store, client, create, projection } = await setup({ install: ["fancy-horror"] });
  const block = await create("This week\nfancy-horror:: virgo");
  const shown = await projection(block.id, "component");
  const component = shown.output!.component as { data: { omens: { omen: string; warded: boolean }[] }; view: { type: string } };
  expect(component.view.type).toBe("card");
  expect(component.data.omens).toHaveLength(3);
  expect(component.data.omens.every((omen) => !omen.warded)).toBe(true);
  expect(shown.output!.markdown).toContain("- [ ] ");

  const render = async (target: string) => (await client.request<{ results: { rendered: { body: string; via: string; contentType: string } }[] }>(
    { action: "extensions.render", blockId: block.id, target })).results[0]!.rendered;
  expect(await render("json")).toMatchObject({ via: "primitives", contentType: "application/json" });
  expect(JSON.parse((await render("json")).body).sign).toBe("virgo");
  expect((await render("html")).body).toContain('<section class="ext-card">');
  expect((await render("terminal")).body).toContain("▌ Virgo: week of");
  // No table and data that isn't rows: csv falls back to the requester's fallback (json by default).
  expect(await render("csv")).toMatchObject({ via: "fallback", contentType: "application/json" });

  // Its behaviour: ward writes a child block as the extension, and the component reads it back.
  const warded = await client.request<{ message: string; written: string[] }>({ action: "extensions.act", extension: "fancy-horror", extensionAction: "ward", blockId: block.id });
  expect(warded.message).toStartWith("Warded off ");
  expect(store.get(warded.written[0]!)).toMatchObject({ parentId: block.id, actorId: "ext:fancy-horror", text: warded.message });
  const after = (await client.request<ResourceProjectionReadResult>({ action: "resources.projection.read", blockId: block.id })).projections[0]!;
  const omens = (after.output!.component as typeof component).data.omens;
  expect(omens.filter((omen) => omen.warded).map((omen) => `Warded off ${omen.omen}`)).toEqual([warded.message]);
  const changes = store.changes.since(0, 1000);
  expect(changes.kind === "changes" && changes.changes.some((change) => change.action === "ext.fancy-horror.ward" && change.actor?.actorId === "ext:fancy-horror")).toBe(true);
});

test("an action's writes stay inside the block it acts on, apply together or not at all, and a read-only action can't write", async () => {
  const { extensionsFolder, store, client, create, list } = await setup();
  writeExtension(extensionsFolder, "sly", {
    run: ["bun", "main.ts"],
    actions: [{ id: "escape", label: "Escape", effects: "write" }, { id: "peek", label: "Peek" }, { id: "half", label: "Half", effects: "write" }],
  }, `const request = await Bun.stdin.json();
const { action, target, args } = request.input;
const writes = action === "half"
  ? [{ op: "create", parentId: target.blockId, text: "first" }, { op: "update", blockId: target.blockId, expectedRevision: 999, text: "nope" }]
  : [{ op: "create", parentId: args?.parent ?? target.blockId, text: "sneaky" }];
process.stdout.write(JSON.stringify({ ok: true, value: { writes } }));`);
  await list(true);
  const mine = await create("Mine");
  const elsewhere = await create("Elsewhere");
  await expect(client.request({ action: "extensions.act", extension: "sly", extensionAction: "escape", blockId: mine.id, args: { parent: elsewhere.id } }))
    .rejects.toThrow("tried to write outside the block it acts on");
  await expect(client.request({ action: "extensions.act", extension: "sly", extensionAction: "peek", blockId: mine.id }))
    .rejects.toThrow("declared read-only");
  await expect(client.request({ action: "extensions.act", extension: "sly", extensionAction: "half", blockId: mine.id })).rejects.toThrow();
  expect(store.children(mine.id)).toEqual([]);
  expect(store.children(elsewhere.id)).toEqual([]);
});

// ── Kind 4: a whole tile ─────────────────────────────────────────────────

test("tarot (a tile kind): listed for the door's registry; its program keeps a reading through the service's action, attributed", async () => {
  const { store, client, create, list } = await setup({ install: ["tarot"] });
  const { tileKinds, extensions } = await list(true);
  expect(extensions.find((entry) => entry.id === "tarot")?.state).toBe("active");
  const tile = tileKinds.find((kind) => kind.kind === "tarot.reading")!;
  expect(tile).toMatchObject({
    extension: "tarot", name: "Tarot", save: "args", accepts: [],
    policy: { resizable: true, collapsible: true, droppable: false },
    args: { block: { type: "block" } },
    actions: [{ name: "ext.tarot.draw", key: "d", on: "tile:reading" }, { name: "ext.tarot.keep", key: "k", on: "block" }],
  });
  expect(tile.command[0]).toBe(process.execPath);
  expect(tile.env.OUTLINER_SOCKET_PATH).toBeDefined();

  // An agent draws without a tile.
  const drawn = await client.request<{ message: string }>({ action: "extensions.act", extension: "tarot", extensionAction: "draw" });
  expect(drawn.message).toMatch(/^The /);

  // The tile program, run as the door would run it (its command, cwd, env and saved args), keeps a reading.
  const journal = await create("Journal");
  const program = Bun.spawn([...tile.command, `--block=${journal.id}`], { cwd: tile.cwd, env: { ...process.env, ...tile.env }, stdin: "pipe", stdout: "pipe" });
  await Bun.sleep(300);
  program.stdin.write("k");
  await program.stdin.flush();
  const kept = await until("a kept reading", () => store.children(journal.id)[0]);
  expect(kept).toMatchObject({ author: "agent", actorId: "ext:tarot" });
  expect(kept.text).toMatch(/^Tarot, \d{4}-\d{2}-\d{2}: /);
  program.stdin.write("q");
  await program.stdin.flush();
  expect(await program.exited).toBe(0);
});

// ── The CLI ──────────────────────────────────────────────────────────────

test("ext add, ls and remove: a built-in or a folder in, the service told; a broken folder refused with its reason", async () => {
  const { root, client, list } = await setup();
  const logs: string[] = [];
  const errors: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
  console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
  const connect = async () => client;
  try {
    expect(await runExtCommand(["add", "horoscope"], connect)).toBe(0);
    expect(logs.join("\n")).toContain(`installed horoscope in ${join(root, "user-extensions", "horoscope")}`);
    expect(logs.join("\n")).toContain("service: horoscope is active");

    const own = join(root, "my-ext", "jokes");
    writeExtension(join(root, "my-ext"), "jokes", { run: ["bun", "main.ts"], handlers: [{ key: "joke", kind: "output", effects: "read" }] }, ECHO);
    expect(await runExtCommand(["add", own], connect)).toBe(0);
    expect(readFileSync(join(root, "user-extensions", "jokes", "main.ts"), "utf8")).toBe(ECHO);

    writeExtension(join(root, "my-ext"), "broken", { handlers: [{ key: "broken", kind: "output", effects: "read" }] });
    expect(await runExtCommand(["add", join(root, "my-ext", "broken")], connect)).toBe(1);
    expect(errors.join("\n")).toContain("handlers and actions need run");

    logs.length = 0;
    expect(await runExtCommand(["ls"], connect)).toBe(0);
    expect(logs.join("\n")).toMatch(/horoscope\tactive\tuser\tv1/);
    expect(logs.join("\n")).toContain("serves joke:: (output, read)");

    expect(await runExtCommand(["remove", "horoscope"], connect)).toBe(0);
    expect(logs.join("\n")).toContain("service: horoscope is gone");
    expect((await list()).extensions.map((entry) => entry.id)).toEqual(["jokes"]);
    expect(await runExtCommand(["remove", "horoscope"], connect)).toBe(1);
  } finally {
    console.log = log;
    console.error = error;
  }
});
