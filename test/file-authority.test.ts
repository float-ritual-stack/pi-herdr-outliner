import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOutlinerClient } from "../src/client";
import type { FileContents, ReferencedPathCandidate } from "../src/files";
import { resolveClientPaths } from "../src/paths";
import { OutlinerServer } from "../src/server";
import { OutlinerStore } from "../src/store";

test("remote file references read service bytes without registering a Resource", async () => {
  const root = mkdtempSync(join(tmpdir(), "file-authority-"));
  const serviceRoot = join(root, "service");
  const clientRoot = join(root, "client");
  mkdirSync(serviceRoot);
  mkdirSync(clientRoot);
  writeFileSync(join(serviceRoot, "today.txt"), "SERVER VERSION\nsecond line");
  writeFileSync(join(clientRoot, "today.txt"), "CLIENT VERSION");
  const store = new OutlinerStore(join(serviceRoot, "outliner.sqlite"));
  const socket = join(root, "outliner.sock");
  const server = new OutlinerServer(store, socket);
  try {
    await server.start();
    const client = createOutlinerClient(resolveClientPaths({
      OUTLINER_WORKSPACE_ROOT: clientRoot, OUTLINER_REMOTE: "1", OUTLINER_SOCKET_PATH: socket,
      XDG_CONFIG_HOME: join(root, "config"),
    }));
    const sequence = store.sequence;
    const sources = store.resources.listSources();
    const read = await client.request<FileContents>({ action: "files.read", path: "today.txt" });
    expect(read.text).toBe("SERVER VERSION\nsecond line");
    expect(read.absolutePath).toBe(join(serviceRoot, "today.txt"));
    expect(store.sequence).toBe(sequence);
    expect(store.resources.listSources()).toEqual(sources);
    expect(store.resources.resolveAuthoredReference({ kind: "filesystem", path: "today.txt" }).kind)
      .toBe("unregistered");
    const { resource } = store.resources.internFilesystem({ path: "today.txt" });
    const document = store.resources.describe(resource.id, true).filesystem!;
    expect(document.text).toBe(read.text);
    expect(document.revision.revision).toEqual(read.revision);
  } finally {
    await server.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("file completions name the service workspace without creating Sources", async () => {
  const root = mkdtempSync(join(tmpdir(), "file-completion-authority-"));
  const serviceRoot = join(root, "service"), clientRoot = join(root, "client");
  mkdirSync(serviceRoot); mkdirSync(clientRoot);
  writeFileSync(join(serviceRoot, "server-only.md"), "service");
  writeFileSync(join(clientRoot, "client-only.md"), "client");
  const store = new OutlinerStore(join(root, "db.sqlite"), { workspaceRoot: serviceRoot });
  const socket = join(root, "outliner.sock"), server = new OutlinerServer(store, socket);
  try {
    await server.start();
    const client = createOutlinerClient(resolveClientPaths({
      OUTLINER_WORKSPACE_ROOT: clientRoot, OUTLINER_REMOTE: "1", OUTLINER_SOCKET_PATH: socket,
      XDG_CONFIG_HOME: join(root, "config"),
    }));
    const sequence = store.sequence, sources = store.resources.listSources();
    expect(await client.request<ReferencedPathCandidate[]>({ action: "files.complete", prefix: "" }))
      .toEqual([{ sourcePath: "server-only.md", isDirectory: false }]);
    expect(store.sequence).toBe(sequence);
    expect(store.resources.listSources()).toEqual(sources);
  } finally {
    await server.close(); store.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("passive file reads preserve configured read policy and symlink confinement", async () => {
  const root = mkdtempSync(join(tmpdir(), "file-reference-policy-"));
  const restricted = join(root, "restricted");
  mkdirSync(restricted);
  writeFileSync(join(restricted, "secret.txt"), "DENIED CONTENT");
  symlinkSync(join(restricted, "secret.txt"), join(root, "escape.txt"));
  const store = new OutlinerStore(join(root, "db.sqlite"));
  store.resources.createSource({ name: "Restricted", provider: "filesystem", boundary: { root: restricted }, policy: { deniedCapabilities: ["read"] } });
  const socket = join(root, "outliner.sock"), server = new OutlinerServer(store, socket);
  try {
    await server.start();
    const client = createOutlinerClient(resolveClientPaths({ OUTLINER_REMOTE: "1", OUTLINER_SOCKET_PATH: socket, OUTLINER_WORKSPACE_ROOT: root, XDG_CONFIG_HOME: join(root, "config") }));
    const sequence = store.sequence;
    await expect(client.request({ action: "files.read", path: "restricted/secret.txt" }))
      .rejects.toThrow("Workspace policy denies reading");
    await expect(client.request({ action: "files.read", path: "escape.txt" }))
      .rejects.toThrow("symbolic link");
    expect(store.sequence).toBe(sequence);
  } finally {
    await server.close(); store.close(); rmSync(root, { recursive: true, force: true });
  }
});
