import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutlinerClient } from "../src/client";
import { detailServiceCapabilities } from "../src/composed-surface";
import { TREE_SERVICE_CAPABILITIES } from "../src/tree-controller";
import { OutlinerServer } from "../src/server";
import { checkServiceCompatibility, waitForCompatibleService } from "../src/service-compatibility";
import { OutlinerStore } from "../src/store";
import {
  OUTLINER_CAPABILITIES,
  OUTLINER_MIN_CLIENT_PROTOCOL,
  OUTLINER_MIN_SERVICE_PROTOCOL,
  OUTLINER_PROTOCOL_VERSION,
  type OutlinerServiceStatus,
} from "../src/types";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "outliner-capabilities-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** A service stand-in that answers ping with `status` and records every action. */
async function fakeService(status: Record<string, unknown>): Promise<{ socket: string; actions: string[] }> {
  const socket = join(temporaryDirectory(), "service.sock");
  const actions: string[] = [];
  const server: Server = createServer(connection => {
    let text = "";
    connection.on("data", chunk => {
      text += chunk;
      if (!text.includes("\n")) return;
      const request = JSON.parse(text.slice(0, text.indexOf("\n")));
      actions.push(request.action);
      connection.end(`${JSON.stringify(request.action === "ping"
        ? { id: request.id, ok: true, result: { status: "ready", ...status } }
        : { id: request.id, ok: false, error: `Unknown action: ${request.action}` })}\n`);
    });
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  return { socket, actions };
}

test("the service advertises its protocol floor and every additive capability", async () => {
  const directory = temporaryDirectory();
  const socket = join(directory, "outliner.sock");
  const store = new OutlinerStore(join(directory, "outliner.sqlite"), { workspaceRoot: directory });
  const server = new OutlinerServer(store, socket);
  await server.start();
  cleanups.push(async () => { await server.close(); store.close(); });

  const block = store.create("Capability fixture");
  const client = new OutlinerClient(socket);
  const service = await client.requireCompatibleService(["blocks.read", "properties.preview"]);
  expect(service).toMatchObject({
    protocolVersion: OUTLINER_PROTOCOL_VERSION,
    minClientProtocol: OUTLINER_MIN_CLIENT_PROTOCOL,
    capabilities: [...OUTLINER_CAPABILITIES],
  });
  expect(OUTLINER_CAPABILITIES).toEqual(expect.arrayContaining(["blocks.read", "properties.preview"]));
  // Advertised capabilities are real actions on this service.
  await expect(client.request({ action: "blocks.read", ids: [block.id] })).resolves.toBeDefined();
  await expect(client.request({ action: "properties.preview", text: "[status::draft]" })).resolves.toBeDefined();
  await expect(client.request({ action: "views.read", viewId: block.id })).resolves.toMatchObject({ status: "unsupported" });
  const staged = store.create("Expression fixture [stage::review]");
  const matched = await client.request<{ blocks: Array<{ id: string }> }>({
    action: "blocks.query", query: { expression: "stage=validate OR stage=review", limit: 5 },
  });
  expect(matched.blocks.map(entry => entry.id)).toEqual([staged.id]);
});

test("a client needing a capability rejects a current service that lacks it, before sending the request", async () => {
  const { socket, actions } = await fakeService({ protocolVersion: OUTLINER_PROTOCOL_VERSION, capabilities: ["blocks.read"] });
  const client = new OutlinerClient(socket);
  await expect(client.requireCompatibleService(["blocks.read"])).resolves.toMatchObject({ capabilities: ["blocks.read"] });
  await expect(client.requireCompatibleService()).resolves.toBeDefined();
  await expect(client.requireCompatibleService(["blocks.read", "properties.preview"])).rejects.toThrow(
    `Connected Outliner service (protocol ${OUTLINER_PROTOCOL_VERSION}) does not support properties.preview. Restart the service from a checkout that provides it.`,
  );
  expect(actions).toEqual(["ping", "ping", "ping"]);
});

test("the CLI checks the capability it uses and does not send an unsupported action", async () => {
  const { socket, actions } = await fakeService({ protocolVersion: OUTLINER_PROTOCOL_VERSION, capabilities: [] });
  const root = temporaryDirectory();
  const child = Bun.spawn([process.execPath, "src/cli.ts", "properties-preview", "--text", "[a::b]"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, OUTLINER_REMOTE: "1", OUTLINER_SOCKET_PATH: socket,
      OUTLINER_WORKSPACE_ROOT: root, OUTLINER_STATE_DIR: join(root, "state") },
    stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5_000,
  });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(exitCode).toBe(1);
  expect(stderr).toContain("does not support properties.preview");
  expect(actions).toEqual(["ping"]);
});

test("CLI view requires views.read before sending the read", async () => {
  const run = async (capabilities: string[]) => {
    const { socket, actions } = await fakeService({ protocolVersion: OUTLINER_PROTOCOL_VERSION, capabilities });
    const root = temporaryDirectory();
    const child = Bun.spawn([process.execPath, "src/cli.ts", "view", "00000000-0000-4000-8000-000000000000"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, OUTLINER_REMOTE: "1", OUTLINER_SOCKET_PATH: socket,
        OUTLINER_WORKSPACE_ROOT: root, OUTLINER_STATE_DIR: join(root, "state") },
      stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5_000,
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    return { exitCode, stderr, actions };
  };
  const without = await run(["blocks.read", "properties.preview"]);
  expect(without.exitCode).toBe(1);
  expect(without.stderr).toContain("does not support views.read. Restart the service");
  expect(without.actions).toEqual(["ping"]);
  // With the capability the request is sent (the stand-in rejects it, proving it was attempted).
  const withCapability = await run(["views.read"]);
  expect(withCapability.stderr).toContain("Unknown action: views.read");
  expect(withCapability.actions).toEqual(["ping", "views.read"]);
});

test("CLI list --query requires query.expression so an older service cannot ignore it", async () => {
  const run = async (capabilities: string[], args: string[]) => {
    const { socket, actions } = await fakeService({ protocolVersion: OUTLINER_PROTOCOL_VERSION, capabilities });
    const root = temporaryDirectory();
    const child = Bun.spawn([process.execPath, "src/cli.ts", "list", ...args], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, OUTLINER_REMOTE: "1", OUTLINER_SOCKET_PATH: socket,
        OUTLINER_WORKSPACE_ROOT: root, OUTLINER_STATE_DIR: join(root, "state") },
      stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5_000,
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    return { exitCode, stderr, actions };
  };
  const without = await run(["views.read"], ["--query", "status=open OR status=review"]);
  expect(without.exitCode).toBe(1);
  expect(without.stderr).toContain("does not support query.expression. Restart the service");
  expect(without.actions).toEqual(["ping"]);
  // A plain clause list still goes straight to the older service.
  const plain = await run(["views.read"], ["--filter", "status=open"]);
  expect(plain.actions).toEqual(["blocks.query"]);
  const withCapability = await run(["query.expression"], ["--query", "status=open OR status=review"]);
  expect(withCapability.actions).toEqual(["ping", "blocks.query"]);
});

test("every Tree host, including composed Detail, requires query.expression at startup", async () => {
  // Virtual-child admission sends a saved view's parsed `where` with tree.query.
  expect(TREE_SERVICE_CAPABILITIES).toEqual(["views.read", "query.expression"]);
  expect(detailServiceCapabilities(true)).toEqual(TREE_SERVICE_CAPABILITIES);
  expect(detailServiceCapabilities(false)).toEqual(["views.read"]);
  const { socket, actions } = await fakeService({ protocolVersion: OUTLINER_PROTOCOL_VERSION, capabilities: ["views.read"] });
  const client = new OutlinerClient(socket);
  await expect(waitForCompatibleService(client, { timeoutMs: 150, needed: detailServiceCapabilities(true) })).rejects.toThrow(
    "does not support query.expression. Restart the service",
  );
  await expect(waitForCompatibleService(client, { timeoutMs: 150, needed: detailServiceCapabilities(false) })).resolves.toBeDefined();
  expect(new Set(actions)).toEqual(new Set(["ping"]));
});

test("CLI changes requires changes.since before asking for the feed", async () => {
  const run = async (capabilities: string[]) => {
    const { socket, actions } = await fakeService({ protocolVersion: OUTLINER_PROTOCOL_VERSION, capabilities });
    const root = temporaryDirectory();
    const child = Bun.spawn([process.execPath, "src/cli.ts", "changes", "--since", "0"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, OUTLINER_REMOTE: "1", OUTLINER_SOCKET_PATH: socket,
        OUTLINER_WORKSPACE_ROOT: root, OUTLINER_STATE_DIR: join(root, "state") },
      stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5_000,
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    return { exitCode, stderr, actions };
  };
  const without = await run(["blocks.read"]);
  expect(without.exitCode).toBe(1);
  expect(without.stderr).toContain("does not support changes.since. Restart the service");
  expect(without.actions).toEqual(["ping"]);
  const withCapability = await run(["changes.since"]);
  expect(withCapability.actions).toEqual(["ping", "changes.since"]);
});

test("a newer service is accepted; a service below the minimum is rejected", () => {
  const newer: OutlinerServiceStatus = {
    status: "ready", protocolVersion: OUTLINER_PROTOCOL_VERSION + 3,
    minClientProtocol: OUTLINER_MIN_CLIENT_PROTOCOL, capabilities: [...OUTLINER_CAPABILITIES, "later.feature"],
  };
  expect(checkServiceCompatibility(newer, ["blocks.read"])).toBeUndefined();

  // Protocol 81 predates negotiation: exact-match services report no capabilities.
  const old = { status: "ready", protocolVersion: OUTLINER_MIN_SERVICE_PROTOCOL - 1 } as OutlinerServiceStatus;
  expect(checkServiceCompatibility(old)).toEqual({
    reason: "service-too-old",
    message: `Connected Outliner service uses protocol ${OUTLINER_MIN_SERVICE_PROTOCOL - 1}; this client requires at least ${OUTLINER_MIN_SERVICE_PROTOCOL}. Restart the service from the current checkout.`,
  });
});

test("a service that no longer serves this client's protocol asks the client to restart", () => {
  const problem = checkServiceCompatibility({
    status: "ready", protocolVersion: OUTLINER_PROTOCOL_VERSION + 1,
    minClientProtocol: OUTLINER_PROTOCOL_VERSION + 1, capabilities: [...OUTLINER_CAPABILITIES],
  });
  expect(problem?.reason).toBe("client-too-old");
  expect(problem?.message).toContain("Restart this client");
});

function scriptedPing(responses: Array<OutlinerServiceStatus | Error>) {
  let calls = 0;
  return {
    get calls() { return calls; },
    async request<T>(): Promise<T> {
      const response = responses[Math.min(calls++, responses.length - 1)]!;
      if (response instanceof Error) throw response;
      return response as T;
    },
  };
}

test("the launcher wait accepts a service that restarts onto a newer protocol", async () => {
  const current: OutlinerServiceStatus = {
    status: "ready", protocolVersion: OUTLINER_PROTOCOL_VERSION + 1, capabilities: [...OUTLINER_CAPABILITIES],
  };
  const client = scriptedPing([
    new Error("connect ENOENT"),
    { status: "ready", protocolVersion: OUTLINER_MIN_SERVICE_PROTOCOL - 1 },
    current,
  ]);
  await expect(waitForCompatibleService(client, { timeoutMs: 5_000 })).resolves.toBe(current);
  expect(client.calls).toBe(3);
});

test("the launcher wait still reports a genuinely old service at its deadline", async () => {
  const client = scriptedPing([{ status: "ready", protocolVersion: OUTLINER_MIN_SERVICE_PROTOCOL - 1 }]);
  await expect(waitForCompatibleService(client, { timeoutMs: 250 })).rejects.toThrow(
    `this client requires at least ${OUTLINER_MIN_SERVICE_PROTOCOL}. Restart the service`,
  );
  expect(client.calls).toBeGreaterThan(1);
});

test("the launcher wait reports a missing capability it was asked for", async () => {
  const client = scriptedPing([{ status: "ready", protocolVersion: OUTLINER_PROTOCOL_VERSION, capabilities: [] }]);
  await expect(waitForCompatibleService(client, { timeoutMs: 150, needed: ["blocks.read"] })).rejects.toThrow(
    "does not support blocks.read",
  );
});
