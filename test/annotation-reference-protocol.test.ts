import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAnnotationReferenceContext, createTextQuoteAnchor } from "../src/annotations";
import { OutlinerClient } from "../src/client";
import { OutlinerServer } from "../src/server";
import { OutlinerStore } from "../src/store";
import type { AnnotationBatchReceipt, AnnotationTarget, AnnotationThread, Block } from "../src/types";

test("annotation socket requests preserve occurrence scope, provenance and thread state after service restart", async () => {
  const root = mkdtempSync("/tmp/annotation-reference-protocol-");
  const databasePath = join(root, "outliner.sqlite");
  const socketPath = join(root, "outliner.sock");
  writeFileSync(join(root, "same.txt"), "Shared file passage");
  let store = new OutlinerStore(databasePath);
  let server = new OutlinerServer(store, socketPath);
  const client = new OutlinerClient(socketPath);
  try {
    await server.start();
    const host = await client.request<Block>({ action: "create", text: "First [file::same.txt].\nSecond [file::same.txt]." });
    const resource = store.resources.internFilesystem({ path: join(root, "same.txt") }).resource;
    const file = store.resources.describe(resource.id, true).filesystem!;
    const passage: AnnotationTarget = {
      representation: {
        id: `filesystem:${resource.id}:${file.contentHash}`,
        subject: { kind: "resource", resourceId: resource.id },
        sourceSnapshot: { kind: "resource", resourceId: resource.id, sourceSnapshotId: null, revision: file.revision },
        adapter: { id: "filesystem.text", version: 1 }, mediaType: "text/plain",
        contentHash: file.contentHash, capturedAt: file.capturedAt,
      },
      anchor: createTextQuoteAnchor(file.text, 0, file.text.length),
    };
    const contexts = [host.text.indexOf("[file::"), host.text.lastIndexOf("[file::")]
      .map(start => createAnnotationReferenceContext(host, start, start + 16));
    const targets = [...contexts.map(referenceContext => ({ ...passage, referenceContext })), passage];
    const created = await client.request<AnnotationBatchReceipt>({ action: "annotations.batch", requestId: "scoped-threads",
      author: "agent", provenance: { actorId: "test-agent", sessionId: "test-session", taskId: "test-task" },
      operations: targets.map((target, index) => ({ operationId: `thread-${index}`, type: "create",
        input: { target, body: `Thread ${index}`, source: "agent" } })),
    });
    const second = created.annotations[1]!;
    await client.request({ action: "annotations.reply", requestId: "second-reply",
      input: { annotationId: second.block.id, body: "Still the second use", source: "user" } });
    await client.request({ action: "annotations.lifecycle", input: { annotationId: second.block.id, lifecycle: "resolved" },
      mutation: { author: "user", actorId: "test-user" } });
    await server.close();
    store.close();
    store = new OutlinerStore(databasePath);
    server = new OutlinerServer(store, socketPath);
    await server.start();
    const threads = await client.request<AnnotationThread[]>({ action: "annotations.list",
      query: { subject: { kind: "resource", resourceId: resource.id }, includeResolved: true } });
    expect(threads).toHaveLength(3);
    for (const [index, record] of created.annotations.entries()) {
      const reopened = threads.find(thread => thread.block.id === record.block.id)!;
      expect(reopened.originalTarget).toEqual(targets[index]!);
      expect(reopened.resolvedTarget).toEqual(targets[index]!);
      expect(reopened.source).toBe("agent");
      expect(reopened.block.author).toBe("agent");
      expect(reopened.block).toMatchObject({ actorId: "test-agent", sessionId: "test-session", taskId: "test-task" });
      expect(reopened.resolutionHistory).toEqual(record.resolutionHistory);
    }
    const reopenedSecond = threads.find(thread => thread.block.id === second.block.id)!;
    expect(reopenedSecond.lifecycle).toBe("resolved");
    expect(reopenedSecond.replies.map(reply => reply.body)).toEqual(["Still the second use"]);
    expect(reopenedSecond.replies[0]!.originalTarget).toEqual(targets[1]!);
    const hostThreads = await client.request<AnnotationThread[]>({ action: "annotations.list",
      query: { subject: { kind: "block", blockId: host.id }, includeResolved: true } });
    expect(hostThreads.map(thread => thread.block.id).sort()).toEqual(created.annotations.slice(0, 2).map(record => record.block.id).sort());
    expect((await client.request<Block>({ action: "get", blockId: host.id })).text).toBe(host.text);
  } finally {
    await server.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
