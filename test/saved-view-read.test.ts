import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutlinerClient, type RequestInput } from "../src/client";
import { OutlinerServer } from "../src/server";
import { OutlinerStore } from "../src/store";
import { readSavedView, type SavedViewReadResult } from "../src/saved-view-read";
import { evaluateVirtualBranchMatches, isVirtualBranchDefinition, projectVirtualBranches } from "../src/virtual-branches";
import type { Block, TreeIndexBlock, VisibleBlockCollection, WorkspaceSnapshot } from "../src/types";

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

test("views.read is one atomic service read with paging, exact totals, tree entries and structured errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "saved-view-service-"));
  const store = new OutlinerStore(join(root, "outline.sqlite"));
  const server = new OutlinerServer(store, join(root, "service.sock"));
  await server.start();
  const client = new OutlinerClient(join(root, "service.sock"));
  const create = (text: string, parentId?: string) => client.request<Block>({action: "create", text, parentId});
  try {
    const view = await create("Drafts [type::virtual-branch] [query::outbox=draft] [limit::2]");
    const items: Block[] = [];
    for (const name of ["One", "Two", "Three", "Four", "Five"]) items.push(await create(`${name} [outbox::draft]`));
    const calls: string[] = [];
    const counted = {request<T>(input: RequestInput) { calls.push(input.action); return client.request<T>(input); }};
    const first = await readSavedView(counted, view.id);
    expect(calls).toEqual(["views.read"]);
    expect([first.status, first.total, first.offset, first.nextOffset, first.completeness]).toEqual(["ready", 5, 0, 2, {kind: "truncated", limit: 2}]);
    expect(first.blocks.map(block => block.id)).toEqual(items.slice(0, 2).map(block => block.id));
    const last = await readSavedView(client, view.id, {offset: 4});
    expect([last.blocks.map(block => block.id), last.total, last.nextOffset, last.completeness])
      .toEqual([[items[4]!.id], 5, undefined, {kind: "complete"}]);
    expect((await readSavedView(client, view.id, {offset: 9})).blocks).toEqual([]);
    const tree = await client.request<SavedViewReadResult<TreeIndexBlock>>({action: "views.read", viewId: view.id, format: "tree"});
    expect(tree.blocks.map(block => [block.id, block.preview, "text" in block])).toEqual(items.slice(0, 2).map(block => [block.id, expect.any(String), false]));
    expect((await readSavedView(client, view.id, {expectedRevision: view.revision + 1})).problems).toEqual([{code: "view-changed", message: expect.stringContaining("revision changed")}]);

    const invalid = await client.request<Block>({action: "update", mutation: {author: "user"}, blockId: view.id, expectedRevision: view.revision,
      text: 'Broken [type::virtual-branch] [query::outbox="draft]'});
    const broken = await readSavedView(client, invalid.id);
    expect([broken.status, broken.blocks, broken.completeness]).toEqual(["invalid", [], null]);
    expect(broken.problems).toEqual([{code: "view-invalid", property: "query", position: 7, message: broken.errors[0]!}]);
    expect(broken.errors[0]).toContain("at character 8");
    await client.request({action: "delete", blockId: view.id});
    expect((await readSavedView(client, view.id)).problems).toEqual([{code: "view-missing", message: expect.any(String)}]);
    await expect(readSavedView(client, view.id, {offset: -1})).rejects.toThrow("non-negative");
    await expect(client.request({action: "views.read", viewId: view.id, offset: -1})).rejects.toThrow("non-negative");
  } finally { await server.close(); store.close(); rmSync(root, {recursive: true, force: true}); }
});

// Parity with the evaluator Tree used before views.read: blocks.query plus the
// shared membership selection, over every saved view in a mixed fixture.
test("views.read matches the client evaluator for every saved view in a fixture", async () => {
  const root = mkdtempSync(join(tmpdir(), "saved-view-parity-"));
  const store = new OutlinerStore(join(root, "outline.sqlite"));
  const server = new OutlinerServer(store, join(root, "service.sock"));
  await server.start();
  const client = new OutlinerClient(join(root, "service.sock"));
  const create = (text: string, parentId?: string) => client.request<Block>({action: "create", text, parentId});
  try {
    const hub = await create("Hub");
    const ranked = await create("Ranked [type::virtual-branch] [query::type=task] [limit::3]", hub.id);
    await create("Sorted [type::virtual-branch] [query::type=task] [sort::updated] [direction::asc]", hub.id);
    await create("Created [type::virtual-branch] [query::type=task status=open] [sort::created]", hub.id);
    await create("Self match [type::virtual-branch] [type::task] [query::type]", hub.id);
    await create("Presence [type::virtual-branch] [query::priority]", hub.id);
    await create("Empty [type::virtual-branch] [query::type=nothing]", hub.id);
    await create("Invalid [type::virtual-branch] [query::=]", hub.id);
    await create("Bad limit [type::virtual-branch] [query::type=task] [limit::0]", hub.id);
    const tasks: Block[] = [];
    for (let index = 0; index < 8; index += 1) {
      const parent = index % 3 === 0 ? undefined : tasks[index - 1]?.id;
      tasks.push(await create(`Task ${index} [type::task] [status::${index % 2 ? "open" : "done"}]${index % 4 ? "" : " [priority::high]"}`, parent));
    }
    await create("Body only\n\n[type::task] in the body", hub.id);
    await client.request({action: "virtual.occurrences.reorder", viewId: ranked.id, orderedBlockIds: [tasks[5]!.id, tasks[2]!.id]});
    const trashed = await create("Trashed [type::task]");
    await client.request({action: "delete", blockId: trashed.id});
    await create("Trash [type::virtual-branch] [query::deleted=true]", hub.id);

    const snapshot = await client.request<WorkspaceSnapshot>({action: "workspace.snapshot"});
    const definitions = snapshot.physical.blocks.filter(isVirtualBranchDefinition);
    expect(definitions.length).toBeGreaterThanOrEqual(10); // plus seeded system views
    for (const definition of definitions) {
      for (const limit of [undefined, 1, 1000]) {
        const expected = await evaluateVirtualBranchMatches(definition, snapshot.physical.blocks,
          query => client.request<VisibleBlockCollection>({action: "blocks.query", query}), snapshot.virtualOccurrenceRanks, limit);
        const actual = await readSavedView(client, definition.id, limit === undefined ? {} : {limit});
        const label = `${definition.text.split(" [")[0]} limit=${limit}`;
        if (!expected.state.config) {
          expect([label, actual.status, actual.errors]).toEqual([label, "invalid", expected.state.configurationErrors]);
          continue;
        }
        expect([label, actual.status, actual.blocks.map(block => block.id), actual.completeness])
          .toEqual([label, "ready", expected.roots.map(block => block.id), expected.state.completeness]);
        expect(actual.blocks).toEqual(expected.roots);
      }
    }
  } finally { await server.close(); store.close(); rmSync(root, {recursive: true, force: true}); }
});
