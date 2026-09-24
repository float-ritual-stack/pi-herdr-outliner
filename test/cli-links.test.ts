import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutlinerClient, type OutlinerWatcher } from "../src/client";
import { outlinerLinkUri, resourceOccurrenceLink } from "../src/outliner-links";
import { resolvePaths } from "../src/paths";
import { OutlinerServer } from "../src/server";
import { OutlinerStore } from "../src/store";
import type { OutlinerClientRegistration, OutlinerUiCommand } from "../src/types";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "outliner-cli-links-"));
  const env = { OUTLINER_STATE_DIR: join(root, "state"), OUTLINER_WORKSPACE_ROOT: root };
  const paths = resolvePaths(env);
  const store = new OutlinerStore(paths.database, { workspaceRoot: root });
  const server = new OutlinerServer(store, paths.socket);
  const client = new OutlinerClient(paths.socket);
  const watchers: OutlinerWatcher[] = [];
  const commands: OutlinerUiCommand[] = [];
  await server.start();
  cleanups.push(async () => {
    for (const watcher of watchers) await watcher.stop();
    await server.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  async function register(registration: OutlinerClientRegistration) {
    const connected = Promise.withResolvers<void>();
    watchers.push(client.watch({
      client: registration, onConnect: connected.resolve, onError: connected.reject,
      onEvent: event => { if (event.domain === "ui" && event.command) commands.push(event.command); },
    }));
    await connected.promise;
  }
  async function run(args: string[]) {
    const child = Bun.spawn(["bun", "src/cli.ts", "link", ...args], {
      cwd: join(import.meta.dir, ".."), env: { ...process.env, ...env },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return { stdout, stderr, exitCode };
  }
  function reference(filename: string) {
    writeFileSync(join(root, filename), "Resource contents");
    const block = store.create(`Source [file::${filename}]`);
    const target = resourceOccurrenceLink(block, { start: 7, end: block.text.length });
    return outlinerLinkUri(target.kind, target.value, target);
  }
  function resourceCount() {
    return (store.database.query("SELECT count(*) AS count FROM resources").get() as { count: number }).count;
  }
  return { store, client, commands, register, run, reference, resourceCount };
}

test("CLI Resource references require an available explicit Detail before registration", async () => {
  const h = await setup();
  await h.register({ clientId: "reader", role: "detail", contextId: "reader" });
  const uri = h.reference("direct.md");
  const before = h.resourceCount();
  for (const [args, error] of [
    [[], "explicit Detail destination"],
    [["--detail-client", "missing"], "not a live"],
  ] as const) {
    const result = await h.run([uri, ...args]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(error);
    expect(h.resourceCount()).toBe(before);
  }
  await h.client.request({ action: "clients.update", clientId: "reader", navigationProtection: "active draft" });
  const protectedResult = await h.run([uri, "--detail-client", "reader"]);
  expect(protectedResult.exitCode).not.toBe(0);
  expect(protectedResult.stderr).toContain("active draft");
  expect(h.resourceCount()).toBe(before);
  expect(h.commands).toEqual([]);

  await h.client.request({ action: "clients.update", clientId: "reader", navigationProtection: null });
  const opened = await h.run(["--url", uri, "--detail-client", "reader"]);
  expect(opened).toMatchObject({ exitCode: 0, stderr: "" });
  const receipt = JSON.parse(opened.stdout);
  expect(receipt).toMatchObject({ kind: "resource", targetClientId: "reader" });
  expect(h.resourceCount()).toBe(before + 1);
  expect(h.commands.at(-1)).toMatchObject({ command: "open", targetClientId: "reader", target: { kind: "resource", resourceId: receipt.id } });
  const canonical = outlinerLinkUri("resource", receipt.id);
  expect((await h.run([canonical])).stderr).toContain("explicit Detail destination");
  expect((await h.run([canonical, "--detail-client", "reader"])).exitCode).toBe(0);
  expect(h.resourceCount()).toBe(before + 1);
});

test("CLI linked source and composed region preflight Resource creation and select the saved destination", async () => {
  const h = await setup();
  await h.register({ clientId: "source", role: "composed", contextId: "source" });
  await h.register({ clientId: "reader", role: "detail", contextId: "reader" });
  const uri = h.reference("linked.md");
  const args = [uri, "--source-client", "source", "--source-region", "detail"];
  const before = h.resourceCount();
  expect((await h.run([uri, "--source-client", "source"])).exitCode).not.toBe(0);
  expect((await h.run(args)).exitCode).not.toBe(0);
  expect(h.resourceCount()).toBe(before);
  await h.client.request({ action: "navigation.link.set", source: { clientId: "source", region: "detail" }, destination: { clientId: "reader", region: "detail" } });
  await h.client.request({ action: "clients.update", clientId: "reader", navigationProtection: "active source selection" });
  const protectedResult = await h.run(args);
  expect(protectedResult.exitCode).not.toBe(0);
  expect(protectedResult.stderr).toContain("active source selection");
  expect(h.resourceCount()).toBe(before);
  expect(h.commands).toEqual([]);
  await h.client.request({ action: "clients.update", clientId: "reader", navigationProtection: null });
  const opened = await h.run(args);
  expect(opened).toMatchObject({ exitCode: 0, stderr: "" });
  const receipt = JSON.parse(opened.stdout);
  expect(receipt).toMatchObject({ targetClientId: "reader", resolution: "linked", intent: "open" });
  expect(h.commands.at(-1)).toMatchObject({ targetClientId: "reader", target: { kind: "resource", resourceId: receipt.id } });
  const canonical = await h.run([outlinerLinkUri("resource", receipt.id), ...args.slice(1)]);
  expect(canonical.exitCode).toBe(0);
  expect(JSON.parse(canonical.stdout).targetClientId).toBe("reader");
});

test("CLI Tree targeting is exact and unsupported flag combinations fail explicitly", async () => {
  const h = await setup();
  await h.register({ clientId: "tree-a", role: "tree", contextId: "a" });
  await h.register({ clientId: "tree-b", role: "tree", contextId: "b" });
  const block = h.store.create("CLI selected block");
  const uri = outlinerLinkUri("block", block.id);
  expect((await h.run([uri, "--tree-client", "tree-b"])).exitCode).toBe(0);
  expect(h.commands).toHaveLength(1);
  expect(h.commands[0]).toMatchObject({ command: "focus", targetClientId: "tree-b", target: { kind: "block", blockId: block.id } });
  const resource = outlinerLinkUri("resource", "unresolved-resource");
  for (const [args, error] of [
    [[uri, "--source-region", "tree"], "requires --source-client"],
    [[uri, "--source-client", "tree-a", "--source-region", "observer"], "must be tree or detail"],
    [[uri, "--source-client", "tree-a", "--detail-client", "reader"], "Use only one"],
    [[uri, "--tree-client", "tree-a", "--detail-client", "reader"], "Use only one"],
    [[uri, "--detail-client", "reader"], "requires a Resource or reference URL"],
    [[resource, "--tree-client", "tree-a"], "require --detail-client or --source-client"],
    [[outlinerLinkUri("goto", "CLI"), "--source-client", "tree-a"], "goto URLs require --tree-client"],
    [[uri, "--source-client", ""], "requires a client ID"],
    [[uri, "--url", uri], "accepts one URL"],
  ] as const) {
    const result = await h.run([...args]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(error);
  }
  expect(h.commands).toHaveLength(1);
});

test("resolve answers a link's block without navigating or creating a page", async () => {
  const { store } = await setup();
  const ticket = store.create("Ticket [page::HUB-001]");
  const page = store.create("Daily notes [page::Daily notes]");
  const other = store.create("Plain block");
  const env = { ...process.env, OUTLINER_STATE_DIR: join(store.workspaceRoot!, "state"), OUTLINER_WORKSPACE_ROOT: store.workspaceRoot! };
  const resolve = async (url: string) => {
    const child = Bun.spawn(["bun", "src/cli.ts", "resolve", url], {
      cwd: join(import.meta.dir, ".."), env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return { stdout, stderr, exitCode };
  };
  const blocks = () => store.database.query("SELECT count(*) AS count FROM blocks").get() as { count: number };

  expect(JSON.parse((await resolve("pi-outliner://page/HUB-001")).stdout).id).toBe(ticket.id);
  expect(JSON.parse((await resolve("pi-outliner://page/Daily%20notes")).stdout)).toEqual({ id: page.id, title: "Daily notes" });
  expect(JSON.parse((await resolve(`pi-outliner://block/${other.id}`)).stdout).id).toBe(other.id);

  const before = blocks().count;
  const missing = await resolve("pi-outliner://page/Never%20written");
  expect(missing.exitCode).not.toBe(0);
  expect(missing.stderr).toContain("Page address did not resolve: Never written");
  expect(blocks().count).toBe(before);
});
