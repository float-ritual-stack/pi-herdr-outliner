import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutlinerClient } from "../src/client";
import { resolvePaths } from "../src/paths";
import { assignPaths, publishIntent, Publisher, renderSubtreeMarkdown, servePublisher, slugify, type PublishedIndex } from "../src/publish";
import { canonicalPublishRoots, checkAttachment, type AttachmentPolicy } from "../src/publish-attachments";
import { OutlinerServer } from "../src/server";
import { OutlinerStore } from "../src/store";
import type { Block, ProjectedBlockCollection, ProjectedVisibleBlock } from "../src/types";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function scratchDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** A throwaway service over a fictional outline, and a publisher reading it. */
async function setup(options: { maxBytes?: number; roots?: string[]; basePath?: string; serviceHostname?: string } = {}) {
  const root = scratchDirectory("outliner-publish-");
  const workspace = join(root, "garden");
  mkdirSync(workspace);
  const paths = resolvePaths({ OUTLINER_STATE_DIR: join(root, "state"), OUTLINER_WORKSPACE_ROOT: workspace });
  const store = new OutlinerStore(paths.database, { workspaceRoot: workspace });
  const server = new OutlinerServer(store, paths.socket);
  await server.start();
  const client = new OutlinerClient(paths.socket);
  const { serviceHostname, ...publisherOptions } = options;
  // A service on another machine: the same socket, but ping names another host.
  const publisherClient = serviceHostname === undefined ? client : Object.assign(Object.create(client) as OutlinerClient, {
    requireCompatibleService: async () => {
      const status = await client.requireCompatibleService();
      return { ...status, location: { ...status.location!, hostname: serviceHostname } };
    },
  });
  const publisher = new Publisher({ client: publisherClient, ...publisherOptions });
  cleanups.push(async () => {
    await publisher.stop();
    await server.close();
    store.close();
  });
  await publisher.start();
  const get = (path: string, headers: Record<string, string> = {}) =>
    publisher.handle(new Request(`http://127.0.0.1${path}`, { headers }));
  const write = (relative: string, text: string) => {
    const file = join(workspace, relative);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, text);
    return file;
  };
  return { root, workspace, store, client, publisher, get, write };
}

test("a [publish::true] page with an attached markdown file serves the markdown at its page address", async () => {
  const { store, get, write } = await setup();
  write("notes/moth-garden.md", "# Moth garden plan\n\nNight-scented stock by the fence.\n");
  store.create("Moth garden plan [publish::true] [page::Moth Garden] [file::notes/moth-garden.md]");

  const raw = await get("/p/moth-garden");
  expect(raw.status).toBe(200);
  expect(raw.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
  expect(await raw.text()).toBe("# Moth garden plan\n\nNight-scented stock by the fence.\n");

  const rendered = await get("/p/moth-garden?view=html");
  expect(rendered.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(rendered.headers.get("content-security-policy")).toContain("default-src 'none'");
  const html = await rendered.text();
  expect(html).toContain("<h1>Moth garden plan</h1>");
  expect(html).toContain("Night-scented stock by the fence.");
});

test("an attached html file is served as html", async () => {
  const { store, get, write } = await setup();
  write("site/lanterns.html", "<!doctype html><title>Lanterns</title><p>Paper lanterns for the moth walk</p>");
  store.create("Lantern handout [publish::lanterns] [file::site/lanterns.html]");
  const response = await get("/p/lanterns");
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(await response.text()).toContain("Paper lanterns for the moth walk");
});

test("URL rules: page address, block id, explicit slug with folders", async () => {
  const { store, get } = await setup();
  const page = store.create("Moth garden plan [publish::yes] [page::Moth Garden]");
  const plain = store.create("Pollinator census [publish::true]");
  const slugged = store.create("Luna moth sightings [publish::Field Notes/Luna Moths!]");
  const off = store.create("Private seed order [publish::false]");

  expect((await get("/p/moth-garden")).status).toBe(200);
  expect((await get(`/p/${plain.id}`)).status).toBe(200);
  expect((await get("/p/field-notes/luna-moths")).status).toBe(200);
  // Every published block also answers at its id; an unpublished one never does.
  expect((await get(`/p/${page.id}`)).status).toBe(200);
  expect((await get(`/p/${slugged.id}`)).status).toBe(200);
  expect((await get(`/p/${off.id}`)).status).toBe(404);
});

test("slug collisions resolve by age and show in the index", async () => {
  const { store, get } = await setup();
  const first = store.create("Moth list, spring [publish::moths]");
  const second = store.create("Moth list, autumn [publish::moths]");
  expect(await (await get("/p/moths")).text()).toContain("Moth list, spring");
  const alternate = `/p/moths~${second.id.slice(0, 8)}`;
  expect(await (await get(alternate)).text()).toContain("Moth list, autumn");
  const text = await (await get("/index.txt")).text();
  expect(text).toContain(alternate);
  expect(text).toContain(`collision: moths is held by ${first.id}`);

  const blocks = [second, first].map((block) => ({ ...block, depth: 0 }) as unknown as ProjectedVisibleBlock);
  expect(assignPaths(blocks).map((entry) => entry.slug)).toEqual(["moths", `moths~${second.id.slice(0, 8)}`]);
});

test("a block without an attachment renders its subtree as markdown, leaving out [publish::false] branches", async () => {
  const { store, get } = await setup();
  const hidden = store.create("Neighbour's gate code");
  const census = store.create("Pollinator census [publish::census] [page::Pollinator census]");
  const plan = store.create(`Moth garden plan [publish::true] [page::Moth Garden] [owner::fern]\nPlant for the night shift.`);
  const beds = store.create(`Beds [zone::north]\nsee ((${census.id})) and ((${hidden.id}))`, plan.id);
  store.create("Evening primrose", beds.id);
  const draft = store.create("Budget draft [publish::no]", plan.id);
  store.create("Seed invoice numbers", draft.id);
  store.create("Links to [[Pollinator census]] and [[Nowhere]]", plan.id);

  const response = await get("/p/moth-garden");
  const markdown = await response.text();
  expect(markdown).toBe([
    "# Moth garden plan",
    "Plant for the night shift.",
    "",
    "- Beds",
    `  see [Pollinator census](/p/census) and unpublished note`,
    "  - Evening primrose",
    "- Links to [Pollinator census](/p/census) and Nowhere",
    "",
  ].join("\n"));
  expect(markdown).not.toContain("gate code");
  expect(markdown).not.toContain("Budget");
  expect(markdown).not.toContain("invoice");
  expect(markdown).not.toContain("::");

  const html = await (await get("/p/moth-garden?view=html")).text();
  expect(html).toContain("<li>Evening primrose</li>");
  expect(html).toContain('href="/p/census"');
});

test("the index lists published things in html, text and json", async () => {
  const { store, get, write } = await setup({ basePath: "/pub" });
  write("notes/moth-garden.md", "# Moth garden plan\n");
  store.create("Moth garden plan [publish::true] [page::Moth Garden] [file::notes/moth-garden.md]");
  store.create("Pollinator census [publish::census]");
  store.create("Not published");

  const html = await (await get("/")).text();
  expect(html).toContain('<a href="/pub/p/moth-garden?view=html">Moth garden plan</a>');
  expect(html).toContain("<td>markdown</td>");
  expect(html).not.toContain("Not published");
  // A proxy that keeps its mount prefix reaches the same routes.
  expect(await (await get("/pub/index")).text()).toBe(html);

  const plain = await (await get("/index", { accept: "text/plain" })).text();
  expect(plain.split("\n")[0]).toMatch(/^TYPE\s+UPDATED\s+URL\s+TITLE$/);
  expect(plain).toContain("/pub/p/census");
  expect(plain).toMatch(/markdown\s+\S+ \S+\s+\/pub\/p\/moth-garden\s+Moth garden plan/);
  expect(await (await get("/index.txt")).text()).toBe(plain);

  const json = await (await get("/index.json")).json() as PublishedIndex;
  expect(json.entries.map((entry) => [entry.path, entry.type])).toEqual([["/p/census", "block"], ["/p/moth-garden", "markdown"]]);
});

test("removing [publish::…] removes the URL on the next request", async () => {
  const { store, client, get } = await setup();
  const block = store.create("Moth garden plan [publish::true] [page::Moth Garden]");
  expect((await get("/p/moth-garden")).status).toBe(200);
  await client.request({
    action: "update", blockId: block.id, text: "Moth garden plan [page::Moth Garden]",
    expectedRevision: block.revision, mutation: { author: "user", actorId: "test" },
  });
  const deadline = Date.now() + 2_000;
  let status = 200;
  while (Date.now() < deadline && (status = (await get("/p/moth-garden")).status) !== 404) await Bun.sleep(20);
  expect(status).toBe(404);
  expect(await (await get("/index.txt")).text()).not.toContain("moth-garden");
});

test("the publisher never writes and answers only GET and HEAD on its own routes", async () => {
  const { store, client, publisher, get } = await setup();
  const block: Block = store.create("Moth garden plan [publish::true] [page::Moth Garden]");
  const before = await client.request<{ nextSequence?: number; latestSequence?: number }>({ action: "changes.since", sequence: 0 });
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const response = await publisher.handle(new Request("http://127.0.0.1/p/moth-garden", { method, body: "x" }));
    expect(response.status).toBe(405);
  }
  for (const path of ["/etc/passwd", "/p/../../etc/passwd", "/p/%2e%2e/%2e%2e/etc/passwd", "/files/notes", "/query?text=moth", `/p/${block.id}x`]) {
    expect((await get(path)).status).toBe(404);
  }
  expect((await publisher.handle(new Request("http://127.0.0.1/p/moth-garden", { method: "HEAD" }))).status).toBe(200);
  const after = await client.request<unknown>({ action: "changes.since", sequence: 0 });
  expect(after).toEqual(before);
  expect(store.get(block.id)?.revision).toBe(block.revision);
});

test("servePublisher binds to 127.0.0.1", async () => {
  const { store, publisher } = await setup();
  store.create("Moth garden plan [publish::true] [page::Moth Garden]");
  const server = servePublisher(publisher, 0);
  cleanups.push(() => { server.stop(true); });
  expect(server.hostname).toBe("127.0.0.1");
  const response = await fetch(`http://127.0.0.1:${server.port}/p/moth-garden`);
  expect(await response.text()).toBe("# Moth garden plan\n");
});

test("publishIntent and slugify", () => {
  expect(publishIntent("true")).toBe("auto");
  expect(publishIntent("YES")).toBe("auto");
  for (const off of ["false", "no", "off", "0", "", undefined]) expect(publishIntent(off)).toBe("off");
  expect(publishIntent("Field Notes/Luna Moths!")).toEqual({ slug: "field-notes/luna-moths" });
  expect(publishIntent("../..")).toBe("auto");
  expect(slugify("../../etc/passwd")).toBe("etc/passwd");
  expect(slugify(".hidden/./x")).toBe("hidden/x");
  expect(slugify("Mottenstraße")).toBe("mottenstraße");
});

// Safety: every refusal, first as the policy decides it, then over HTTP.

function policyFor(workspace: string, extra: Partial<AttachmentPolicy> = {}): AttachmentPolicy {
  return { roots: canonicalPublishRoots([workspace]).roots, workspaceRoot: workspace, maxBytes: 1024, ...extra };
}

test("refuses a .. segment even when it would land inside the root", () => {
  const workspace = scratchDirectory("publish-root-");
  mkdirSync(join(workspace, "notes"));
  writeFileSync(join(workspace, "moths.md"), "x");
  const check = checkAttachment("notes/../moths.md", policyFor(workspace));
  expect(check).toMatchObject({ ok: false, refusal: "parent-segment" });
});

test("refuses paths outside the allowed roots, absolute or ~/", () => {
  const workspace = scratchDirectory("publish-root-");
  const elsewhere = scratchDirectory("publish-elsewhere-");
  writeFileSync(join(elsewhere, "seed-order.md"), "private");
  expect(checkAttachment(join(elsewhere, "seed-order.md"), policyFor(workspace))).toMatchObject({ ok: false, refusal: "outside-roots" });
  expect(checkAttachment("~/seed-order.md", policyFor(workspace, { homeDirectory: elsewhere }))).toMatchObject({ ok: false, refusal: "outside-roots" });
  // An explicitly configured root is allowed.
  const both = policyFor(workspace, { roots: canonicalPublishRoots([workspace, elsewhere]).roots });
  expect(checkAttachment(join(elsewhere, "seed-order.md"), both)).toMatchObject({ ok: true, type: "markdown" });
});

test("refuses a symlink that escapes the root, and allows one that stays inside", () => {
  const workspace = scratchDirectory("publish-root-");
  const elsewhere = scratchDirectory("publish-elsewhere-");
  writeFileSync(join(elsewhere, "seed-order.md"), "private");
  symlinkSync(join(elsewhere, "seed-order.md"), join(workspace, "escape.md"));
  symlinkSync(elsewhere, join(workspace, "linked-folder"));
  writeFileSync(join(workspace, "real.md"), "ok");
  symlinkSync(join(workspace, "real.md"), join(workspace, "alias.md"));
  expect(checkAttachment("escape.md", policyFor(workspace))).toMatchObject({ ok: false, refusal: "outside-roots" });
  expect(checkAttachment("linked-folder/seed-order.md", policyFor(workspace))).toMatchObject({ ok: false, refusal: "outside-roots" });
  expect(checkAttachment("alias.md", policyFor(workspace))).toMatchObject({ ok: true });
});

test("refuses hidden files and folders below the root", () => {
  const workspace = scratchDirectory("publish-root-");
  mkdirSync(join(workspace, ".secrets"));
  writeFileSync(join(workspace, ".secrets", "keys.md"), "private");
  writeFileSync(join(workspace, ".env.md"), "private");
  symlinkSync(join(workspace, ".secrets", "keys.md"), join(workspace, "keys.md"));
  for (const path of [".secrets/keys.md", ".env.md", "keys.md"]) {
    expect(checkAttachment(path, policyFor(workspace))).toMatchObject({ ok: false, refusal: "hidden-path" });
  }
});

test("refuses devices, FIFOs and directories", () => {
  const workspace = scratchDirectory("publish-root-");
  const made = Bun.spawnSync(["mkfifo", join(workspace, "pipe.md")]);
  expect(made.exitCode).toBe(0);
  mkdirSync(join(workspace, "folder.md"));
  symlinkSync("/dev/zero", join(workspace, "zero.md"));
  expect(checkAttachment("pipe.md", policyFor(workspace))).toMatchObject({ ok: false, refusal: "not-a-file" });
  expect(checkAttachment("folder.md", policyFor(workspace))).toMatchObject({ ok: false, refusal: "not-a-file" });
  // /dev is outside every root, so a link to a device is refused before its type matters.
  expect(checkAttachment("zero.md", policyFor(workspace))).toMatchObject({ ok: false, refusal: "outside-roots" });
  const devices = policyFor(workspace, { roots: canonicalPublishRoots([workspace, "/dev"]).roots });
  expect(checkAttachment("/dev/zero", devices)).toMatchObject({ ok: false, refusal: "not-a-file" });
});

test("refuses files over the size cap, unsupported types, missing files and no roots", () => {
  const workspace = scratchDirectory("publish-root-");
  writeFileSync(join(workspace, "big.md"), "m".repeat(2048));
  writeFileSync(join(workspace, "photo.png"), "png");
  symlinkSync(join(workspace, "gone.md"), join(workspace, "dangling.md"));
  expect(checkAttachment("big.md", policyFor(workspace))).toMatchObject({ ok: false, refusal: "too-large" });
  expect(checkAttachment("big.md", policyFor(workspace, { maxBytes: 4096 }))).toMatchObject({ ok: true });
  expect(checkAttachment("photo.png", policyFor(workspace))).toMatchObject({ ok: false, refusal: "unsupported-type" });
  expect(checkAttachment("absent.md", policyFor(workspace))).toMatchObject({ ok: false, refusal: "missing" });
  expect(checkAttachment("dangling.md", policyFor(workspace))).toMatchObject({ ok: false, refusal: "missing" });
  expect(checkAttachment("big.md", policyFor(workspace, { roots: [] }))).toMatchObject({ ok: false, refusal: "no-roots" });
  expect(canonicalPublishRoots(["/"]).roots).toEqual([]);
});

test("over HTTP, a refused attachment is never read and the index says why", async () => {
  const { store, get, write, workspace } = await setup({ maxBytes: 64 });
  const elsewhere = scratchDirectory("publish-elsewhere-");
  writeFileSync(join(elsewhere, "seed-order.md"), "PRIVATE-SEED-ORDER");
  symlinkSync(join(elsewhere, "seed-order.md"), join(workspace, "escape.md"));
  write(".secrets/keys.md", "PRIVATE-KEYS");
  write("big.md", "PRIVATE-BIG".repeat(20));
  store.create("Escape [publish::escape] [file::escape.md]");
  store.create("Parent [publish::parent] [file::notes/../escape.md]");
  store.create("Absolute [publish::absolute] [file::" + join(elsewhere, "seed-order.md") + "]");
  store.create("Hidden [publish::hidden] [file::.secrets/keys.md]");
  store.create("Big [publish::big] [file::big.md]");
  for (const slug of ["escape", "parent", "absolute", "hidden", "big"]) {
    const response = await get(`/p/${slug}`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain("PRIVATE");
    expect(body.startsWith(`# ${slug[0]!.toUpperCase()}`)).toBe(true);
  }
  const index = await (await get("/index.json")).json() as PublishedIndex;
  expect(index.entries.every((entry) => entry.type === "block" && entry.attachment?.refused)).toBe(true);
  expect(await (await get("/index.txt")).text()).toContain("attachment not served: Attachment is outside the publish roots");
});

test("an attachment swapped for an escaping link after indexing is refused at request time", async () => {
  const { store, get, write, workspace } = await setup();
  const elsewhere = scratchDirectory("publish-elsewhere-");
  writeFileSync(join(elsewhere, "seed-order.md"), "PRIVATE-SEED-ORDER");
  write("plan.md", "# Moth garden plan\n");
  store.create("Moth garden plan [publish::true] [page::Moth Garden] [file::plan.md]");
  expect(await (await get("/p/moth-garden")).text()).toBe("# Moth garden plan\n");
  // Let the creation's content event arrive, then cache an index that still serves the file.
  await Bun.sleep(100);
  expect((await (await get("/index.json")).json() as PublishedIndex).entries[0]?.type).toBe("markdown");
  rmSync(join(workspace, "plan.md"));
  symlinkSync(join(elsewhere, "seed-order.md"), join(workspace, "plan.md"));
  const response = await get("/p/moth-garden");
  expect(response.status).toBe(403);
  expect(await response.text()).not.toContain("PRIVATE");
});

// Review hardening (PR #252): leaks through titles and embeds, attached HTML, remote services, load.

test("titles and embeds never show an unpublished block's id or text", async () => {
  const { store, get } = await setup();
  const hidden = store.create("Neighbour's gate code 4471\nunder the flowerpot");
  const census = store.create("Pollinator census [publish::census]");
  store.create(`Walk notes ((${hidden.id})) and !((${hidden.id})) and !((${census.id})) [publish::walk]`);

  const markdown = await (await get("/p/walk")).text();
  expect(markdown).toBe("# Walk notes unpublished note and unpublished note and [Pollinator census](/p/census)\n");
  const html = await (await get("/p/walk?view=html")).text();
  expect(html).toContain("<title>Walk notes unpublished note and unpublished note and Pollinator census</title>");
  // An embed is a link, not markdown's image syntax.
  expect(html).not.toContain("<img");
  for (const body of [markdown, html, await (await get("/index.json")).text(), await (await get("/index.txt")).text(), await (await get("/")).text()]) {
    expect(body).not.toContain(hidden.id);
    expect(body).not.toContain("gate code");
    expect(body).not.toContain("flowerpot");
  }
});

test("a [publish::false] branch is left out whatever order the service lists blocks in", () => {
  const block = (id: string, parentId: string | null, depth: number, text: string) =>
    ({ id, parentId, depth, text, properties: text.includes("[publish::no]") ? [{ key: "publish", value: "no" }] : [] }) as unknown as ProjectedVisibleBlock;
  const root = block("root-0001", null, 0, "Moth garden plan");
  const draft = block("draft-001", "root-0001", 1, "Budget draft [publish::no]");
  const invoice = block("invoice-1", "draft-001", 2, "Seed invoice numbers");
  const orphan = block("orphan-01", "elsewhere", 2, "Stray block from outside");
  const beds = block("beds-0001", "root-0001", 1, "Beds");
  const subtree: ProjectedBlockCollection = { blocks: [root, invoice, orphan, draft, beds], completeness: { kind: "complete" }, fields: ["text", "parent", "properties"] };
  const markdown = renderSubtreeMarkdown(subtree, { entries: [], truncated: false, builtAt: "" });
  expect(markdown).toBe("# Moth garden plan\n\n- Beds\n");
});

test("an attached html file runs sandboxed, without the host's origin", async () => {
  const { store, get, write } = await setup();
  write("site/lanterns.html", "<!doctype html><script>fetch('/stash/')</script><p>Paper lanterns</p>");
  store.create("Lantern handout [publish::lanterns] [file::site/lanterns.html]");
  const response = await get("/p/lanterns");
  const csp = response.headers.get("content-security-policy") ?? "";
  expect(csp).toStartWith("sandbox ");
  expect(csp).toContain("allow-scripts");
  expect(csp).not.toContain("allow-same-origin");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
});

test("the index over HTTP never shows where an attached file lives", async () => {
  const { store, get, write, workspace } = await setup();
  write("notes/moth-garden.md", "# Moth garden plan\n");
  store.create("Moth garden plan [publish::true] [page::Moth Garden] [file::notes/moth-garden.md]");
  store.create("Seed order [publish::seeds] [file::~nobody/private-seed-order.md]");
  for (const body of [await (await get("/index.json")).text(), await (await get("/index.txt")).text(), await (await get("/")).text()]) {
    expect(body).not.toContain("notes/moth-garden.md");
    expect(body).not.toContain("private-seed-order");
    expect(body).not.toContain(workspace);
  }
  const index = await (await get("/index.json")).json() as PublishedIndex;
  expect(index.entries.find((entry) => entry.slug === "seeds")?.attachment).toEqual({ refused: "Attachment path is not supported" });
});

test("attachments are not served when the service runs on another machine", async () => {
  const { store, get, write, workspace } = await setup({ serviceHostname: "moth-box.invalid" });
  write("notes/moth-garden.md", "ATTACHED-FILE");
  store.create("Moth garden plan [publish::true] [page::Moth Garden] [file::" + join(workspace, "notes/moth-garden.md") + "]");
  const body = await (await get("/p/moth-garden")).text();
  expect(body).toBe("# Moth garden plan\n");
  const index = await (await get("/index.json")).json() as PublishedIndex;
  expect(index.entries[0]?.attachment).toEqual({ refused: "The service runs on another machine" });
});

test("the home folder is never a publish root", () => {
  const home = scratchDirectory("publish-home-");
  mkdirSync(join(home, "writing"));
  const canonical = canonicalPublishRoots([home, join(home, "writing")], home);
  expect(canonical.roots).toEqual([join(home, "writing")]);
  expect(canonical.problems.join("\n")).toContain("home folder");
});

test("a page with many [[page]] links renders without flooding the service", async () => {
  const { store, get } = await setup();
  store.create("Moth index [publish::moth-index] [page::Moth index]");
  const plan = store.create("Moth list [publish::moth-list]");
  for (let i = 0; i < 600; i++) store.create(`Moth ${i} see [[Moth page ${i}]] and [[Moth index]]`, plan.id);
  const response = await get("/p/moth-list");
  expect(response.status).toBe(200);
  const markdown = await response.text();
  expect(markdown).toContain("- Moth 0 see Moth page 0 and [Moth index](/p/moth-index)");
  expect(markdown).toContain("- Moth 599 see Moth page 599 and [Moth index](/p/moth-index)");
}, 30_000);

test("Trash is never published: a trashed block, a trashed child, a block under a trashed parent", async () => {
  const { store, get } = await setup();
  const heron = store.create("Heron log [publish::heron]");
  const draft = store.create("Draft heron count 17", heron.id);
  const otter = store.create("Old otter notes [publish::otter]");
  const beaverParent = store.create("Beaver notes");
  const dam = store.create("Beaver dam [publish::beaver]", beaverParent.id);
  expect((await get("/p/otter")).status).toBe(200);
  store.delete(draft.id);
  store.delete(otter.id);
  store.delete(beaverParent.id);
  // No wait: the change feed drops the cached index.
  expect(await (await get("/p/heron")).text()).toBe("# Heron log\n");
  for (const path of ["/p/otter", "/p/beaver", `/p/${dam.id}`, `/p/${otter.id}`]) expect((await get(path)).status).toBe(404);
  const index = await (await get("/index.txt")).text();
  expect(index).not.toContain("otter");
  expect(index).not.toContain("Beaver");
});

test("any [publish::false] token wins over another [publish::…] on the same block", async () => {
  const { store, get } = await setup();
  store.create("Two minds [publish::yes] [publish::false]");
  const root = store.create("Pond survey [publish::pond]");
  store.create("Private tally [publish::tally] [publish::no]", root.id);
  // Syntax shown in code or escaped is not a property, so it publishes nothing.
  store.create("How to publish: add `[publish::true]` to a block");
  store.create("Escaped \\[publish::escaped]");
  const index = await (await get("/index.json")).json() as PublishedIndex;
  expect(index.entries.map((entry) => entry.slug)).toEqual(["pond"]);
  expect(await (await get("/p/pond")).text()).toBe("# Pond survey\n");
});

test("rendered pages carry no script: raw html is text, script links are dropped", async () => {
  const { store, get } = await setup();
  const root = store.create("Moth <script>alert(1)</script> [publish::moths]");
  store.create("[a](javascript:alert(1)) [b](JaVaScRiPt:alert(1)) [c](java&#x73;cript:alert(1)) <img src=x onerror=alert(1)> [d](data:text/html,hi) ![e](javascript:alert(1)) [f](vbscript:x)", root.id);
  const response = await get("/p/moths?view=html");
  expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  const html = await response.text();
  expect(html).not.toContain("<script");
  expect(html).not.toContain("<img src=\"x\"");
  expect(html).not.toMatch(/(href|src)="[^"]*(script|data:text)/i);
  expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
});

test("over real HTTP: HEAD has no body, odd paths never reach anything unpublished, foreign Hosts are refused", async () => {
  const { store, publisher } = await setup();
  store.create("Heron log [publish::heron]");
  store.create("Secret otter den");
  const server = servePublisher(publisher, 0);
  cleanups.push(() => { server.stop(true); });
  const base = `http://127.0.0.1:${server.port}`;
  const head = await fetch(`${base}/p/heron`, { method: "HEAD" });
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");
  for (const path of ["/p/%2e%2e/%2e%2e/etc/passwd", "/p/..%2f..%2fetc%2fpasswd", "/p/heron%00", "/p/%2Fheron", "/p/HERON", "/p/..\\..\\etc"]) {
    const response = await fetch(`${base}${path}`);
    expect([404, 200]).toContain(response.status);
    expect(await response.text()).not.toContain("otter");
  }
  // A page on the web that rebinds its own name to 127.0.0.1 still sends that name as Host.
  const rebound = await fetch(`${base}/index.json`, { headers: { host: "attacker.example" } });
  expect(rebound.status).toBe(421);
  expect(await rebound.text()).not.toContain("heron");
  for (const host of [`127.0.0.1:${server.port}`, `localhost:${server.port}`, "moth-box.tail0000.ts.net"]) {
    expect((await fetch(`${base}/index.json`, { headers: { host } })).status).toBe(200);
  }
});

test("--allow-host adds a name besides loopback and the tailnet", async () => {
  const { store, client } = await setup();
  store.create("Heron log [publish::heron]");
  const publisher = new Publisher({ client, allowedHosts: ["garden.example"] });
  await publisher.start();
  cleanups.push(() => publisher.stop());
  const at = (host: string) => publisher.handle(new Request("http://127.0.0.1/index.json", { headers: { host } }));
  expect((await at("garden.example")).status).toBe(200);
  expect((await at("GARDEN.example:8443")).status).toBe(200);
  expect((await at("elsewhere.example")).status).toBe(421);
});
