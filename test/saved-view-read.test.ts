import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutlinerClient, type RequestInput } from "../src/client";
import { OutlinerServer } from "../src/server";
import { OutlinerStore } from "../src/store";
import { readSavedView, type SavedViewReadResult } from "../src/saved-view-read";
import { projectVirtualBranches } from "../src/virtual-branches";
import type { Block, VisibleBlockCollection, WorkspaceSnapshot } from "../src/types";

// The public helper and CLI cross a real service: this owns membership, bounds,
// read-only behavior and consistency. Existing Tree tests own descendant layout.
test("saved-view reads match Tree root order while preserving pane-independent membership and honest limits", async () => {
  const root = mkdtempSync(join(tmpdir(), "saved-view-read-"));
  const store = new OutlinerStore(join(root, "outline.sqlite"));
  const socket = join(root, "service.sock");
  const server = new OutlinerServer(store, socket);
  await server.start();
  const client = new OutlinerClient(socket);
  const create = (text: string, parentId?: string) => client.request<Block>({action: "create", text, parentId});
  const update = (block: Block, text: string) => client.request<Block>({action: "update", mutation: {author: "user"}, blockId: block.id, expectedRevision: block.revision, text});
  try {
    const a = await create("First [outbox::draft] [project::sample]");
    const b = await create("Second [outbox::draft] [project::sample]");
    await create("Other [outbox::draft] [project::other]");
    await create("Context only", a.id);
    await create("Inline only\n\nText [outbox::draft] [project::sample]");
    let view = await create("Drafts [type::virtual-branch] [query::outbox=draft project=sample] [limit::1] [expanded::false]");
    await client.request({action: "virtual.occurrences.reorder", viewId: view.id, orderedBlockIds: [b.id, a.id]});
    await client.request({action: "selection.set", blockId: a.id});
    const before = await client.request<WorkspaceSnapshot>({action: "workspace.snapshot"});
    const bounded = await readSavedView(client, view.id);
    expect([bounded.status, bounded.configuredLimit, bounded.effectiveLimit, bounded.revision]).toEqual(["ready", 1, 1, view.revision]);
    expect(bounded.blocks.map(block => block.id)).toEqual([b.id]);
    expect(bounded.completeness).toEqual({kind: "truncated", limit: 1});
    const projection = await projectVirtualBranches([before.physical.blocks.find(block => block.id === view.id)!],
      before.physical.blocks, query => client.request<VisibleBlockCollection>({action: "blocks.query", query}), before.virtualOccurrenceRanks);
    expect(projection.rows.filter(row => row.kind === "occurrence" && row.relativeDepth === 0).map(row => row.canonicalId)).toEqual([b.id]);
    const full = await readSavedView(client, view.id, {limit: 10});
    expect(full.blocks.map(block => block.id)).toEqual([b.id, a.id]);
    expect(full.completeness).toEqual({kind: "complete"});
    expect(await client.request<WorkspaceSnapshot>({action: "workspace.snapshot"})).toEqual(before);
    const proc = Bun.spawn([process.execPath, "run", "src/cli.ts", "view", view.id, "--limit", "10"], {
      cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
      env: {...process.env, OUTLINER_WORKSPACE_ROOT: root, OUTLINER_REMOTE: "1", OUTLINER_SOCKET_PATH: socket},
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited, stderr).toBe(0);
    const cli: SavedViewReadResult = JSON.parse(stdout);
    expect(cli.blocks.map(block => block.id)).toEqual([b.id, a.id]);
    expect(cli.completeness).toEqual({kind: "complete"});
    await update(b, b.text.replace("outbox::draft", "outbox::waiting"));
    expect((await readSavedView(client, view.id)).blocks.map(block => block.id)).toEqual([a.id]);
    await update(a, a.text.replace("outbox::draft", "outbox::waiting"));
    const empty = await readSavedView(client, view.id);
    expect([empty.status, empty.blocks, empty.completeness]).toEqual(["ready", [], {kind: "complete"}]);
    view = await update(view, "Invalid [type::virtual-branch] [query::=]");
    const invalid = await readSavedView(client, view.id);
    expect([invalid.status, invalid.blocks, invalid.completeness]).toEqual(["invalid", [], null]);
    expect(invalid.errors.length).toBeGreaterThan(0);
    expect((await readSavedView(client, a.id)).status).toBe("unsupported");
    expect((await readSavedView(client, "missing")).status).toBe("missing");
    await expect(readSavedView(client, view.id, {limit: 1001})).rejects.toThrow("1 through 1000");
  } finally { await server.close(); store.close(); rmSync(root, {recursive: true, force: true}); }
});

test("saved-view read discards a mixed snapshot when definition changes during its query", async () => {
  const root = mkdtempSync(join(tmpdir(), "saved-view-race-"));
  const store = new OutlinerStore(join(root, "outline.sqlite"));
  const server = new OutlinerServer(store, join(root, "service.sock"));
  await server.start();
  const client = new OutlinerClient(join(root, "service.sock"));
  try {
    const view = await client.request<Block>({action: "create", text: "Drafts [type::virtual-branch] [query::outbox=draft]"});
    await client.request({action: "create", text: "Draft [outbox::draft]"});
    const interleaved = {async request<T>(input: RequestInput): Promise<T> {
      const result = await client.request<T>(input);
      if (input.action === "blocks.query") await client.request({action: "update", mutation: {author: "user"}, blockId: view.id,
        expectedRevision: view.revision, text: view.text.replace("outbox=draft", "outbox=waiting")});
      return result;
    }};
    const changed = await readSavedView(interleaved, view.id);
    expect([changed.status, changed.blocks, changed.completeness]).toEqual(["changed", [], null]);
    expect(changed.errors[0]).toContain("retry");
    expect((await readSavedView(client, view.id, {expectedRevision: view.revision})).status).toBe("changed");
    const failed = await readSavedView({async request<T>(input: RequestInput): Promise<T> {
      if (input.action === "blocks.query") throw new Error("Transport interrupted");
      return client.request<T>(input);
    }}, view.id);
    expect([failed.status, failed.blocks, failed.completeness, failed.errors]).toEqual(["failed", [], null, ["Transport interrupted"]]);
  } finally { await server.close(); store.close(); rmSync(root, {recursive: true, force: true}); }
});
