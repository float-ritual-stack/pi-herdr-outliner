import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { annotationSourceHash, createTextQuoteAnchor } from "../../src/annotations";
import type { AnnotationBatchReceipt, AnnotationThread, Block, InternResourceReceipt, RenderedSelectionCapture, ResourceDescription, VisibleBlockCollection } from "../../src/types";
import { runHerdrScenario } from "./herdr-runner";

const quote = "CAPTURED-QUOTE";
const renderedComment = "PIE281 captured comment";
const fileComment = "PIE281 file comment";
const result = await runHerdrScenario({
  name: "annotation-identity",
  async prepare(root) {
    await writeFile(join(root, "evidence.txt"), "ORIGINAL-FILE-QUOTE\nOriginal second line");
    await writeFile(join(root, "metadata.bin"), "Available source\n\nHIDDEN-QUOTE");
  },
  async run(session) {
    const terminal = await session.attachClient();
    const { tree, detail } = session.panes;
    const clients = await session.registrations();
    const registration = clients.find(client => client.role === "detail" && client.runtime?.paneId === detail);
    assert.ok(registration);
    const readAnnotation = (annotationId: string) => session.client.request<AnnotationThread>({ action: "annotations.get", annotationId });
    const findComment = async (text: string) => {
      const found = await session.waitFor("saved annotation", () => session.client.request<VisibleBlockCollection>({
        action: "blocks.query", query: { text, filters: [{ key: "type", value: "annotation" }], limit: 2 },
      }), rows => rows.blocks.length === 1);
      return readAnnotation(found.blocks[0]!.id);
    };
    const goto = async (blockId: string) => {
      const current = (await session.registrations()).find(client => client.clientId === registration.clientId);
      if (current?.locked) {
        await session.focus(detail);
        await session.keys(detail, "L");
        await session.waitFor("Detail unlocked", session.registrations, entries => entries.some(client => client.clientId === registration.clientId && !client.locked));
      }
      await session.focus(tree);
      await session.keys(tree, "g");
      await session.text(tree, blockId);
      await session.waitVisible(tree, blockId.slice(0, 8));
      await session.keys(tree, "enter");
      await session.waitFor("Detail target", session.registrations, entries => entries.some(client => client.clientId === registration.clientId && client.currentTarget?.kind === "block" && client.currentTarget.blockId === blockId));
      await session.focus(detail);
    };

    const generated = await session.client.request<Block>({
      action: "create", parentId: null,
      text: `Generated passage\n\n${quote} followed by a deliberately long line that wraps in the actual terminal and remains separate from the host's authored embed syntax.`,
    });
    const host = await session.client.request<Block>({ action: "create", parentId: null, text: `PIE281 Hub\n\n!((${generated.id}))\n\nUNRELATED-END` });
    await goto(host.id);
    await session.waitVisible(detail, quote);
    const snapshot = await session.paneSnapshot(detail);
    assert.ok(snapshot.text.includes(quote));
    assert.ok(snapshot.text.includes("Properties · 0 records"));
    assert.ok(snapshot.text.includes("⌃Q close"));
    assert.ok(!host.text.includes(quote));
    const capture: RenderedSelectionCapture = {
      quote, capturedAt: new Date().toISOString(), hostBlockId: host.id,
      paneId: detail, contentRevision: snapshot.revision, contextId: registration.contextId,
      detailClientId: registration.clientId, validation: "detail-pointer", snapshotText: snapshot.text,
    };
    // Inject the selection handoff at the existing UI-command boundary. The bytes
    // and revision are a real Herdr capture; native mouse selection is not claimed.
    await session.client.request({ action: "ui.command.send", command: {
      targetClientId: registration.clientId, command: "comment.selection", renderedSelection: capture,
    } });
    await session.waitVisible(detail, "Ctrl+S save");
    await session.text(detail, renderedComment);
    await terminal.write("\u0013");
    const saved = await findComment(renderedComment);
    assert.equal(saved.originalTarget.representation.contentHash, annotationSourceHash(snapshot.text));
    assert.equal(saved.originalTarget.anchor.kind, "text-quote");
    if (saved.originalTarget.anchor.kind !== "text-quote") throw new Error("Expected text quote");
    const { start, end } = saved.originalTarget.anchor;
    assert.ok(start !== null && end !== null);
    assert.equal(snapshot.text.slice(start, end), quote);
    assert.notEqual(host.text.slice(start, end), quote);
    await session.waitVisible(detail, "Unpositioned comments");
    await session.keys(detail, "tab", "enter");
    await session.waitVisible(detail, renderedComment);
    await session.waitVisible(detail, "Open thread");
    await session.checkpoint("01-real-capture-unpositioned-thread");

    await goto(saved.block.id);
    await session.waitVisible(detail, "Stored resolution: resolved");
    await session.keys(detail, "r");
    await session.waitVisible(detail, "captured pane quote is unpositioned");
    await session.waitVisible(detail, quote);
    await session.checkpoint("02-reveal-host-without-capture-offset");
    await terminal.resize(100, 32);
    await session.waitFor("narrow Detail frame", () => session.visible(detail), frame => frame.split("\n")[0]!.length < 70);
    await session.keys(detail, "tab");
    await session.checkpoint("03a-narrow-region-focused");
    await session.keys(detail, "enter");
    await session.waitVisible(detail, renderedComment);
    await session.checkpoint("03-narrow-reflow-reachable-comment");
    assert.deepEqual((await readAnnotation(saved.block.id)).originalTarget, saved.originalTarget);
    await terminal.resize(220, 60);
    await session.record("rendered-identity", {
      capture, original: saved.originalTarget, resolved: saved.resolvedTarget,
      afterReflow: await readAnnotation(saved.block.id),
      limits: "Selection handoff injected from real pane bytes; native pointer and copy-mode selection were not exercised.",
    });

    const fileHost = await session.client.request<Block>({ action: "create", parentId: null, text: "PIE281 file [file::evidence.txt]" });
    await goto(fileHost.id);
    await session.waitVisible(detail, "ORIGINAL-FILE-QUOTE");
    await session.keys(detail, "c");
    await session.waitVisible(detail, "Ctrl+S save");
    await session.text(detail, fileComment);
    await terminal.write("\u0013");
    const fileSaved = await findComment(fileComment);
    assert.equal(fileSaved.originalTarget.representation.subject.kind, "resource");
    // A legacy annotation may physically live under a file reference. Its parent
    // cannot authorize new bytes as the annotation's represented source.
    await session.client.request({ action: "move", blockId: fileSaved.block.id, parentId: fileHost.id, position: 0 });
    await goto(fileSaved.block.id);
    await session.waitVisible(detail, "Stored resolution: resolved");
    await writeFile(join(session.projectRoot, "evidence.txt"), "DIFFERENT-FILE-CONTENT\nChanged second line");
    const beforeRefresh = await session.client.request<Block>({ action: "get", blockId: fileSaved.block.id });
    await session.client.request({
      action: "update", blockId: beforeRefresh.id, text: `${beforeRefresh.text}\nAnnotation refreshed`,
      expectedRevision: beforeRefresh.revision, mutation: { author: "agent", actorId: "e2e-annotation-refresh" },
    });
    await session.waitVisible(detail, "Annotation refreshed");
    const annotationFrame = await session.waitVisible(detail, "Stored resolution: resolved");
    assert.ok(annotationFrame.includes("ORIGINAL-FILE-QUOTE"));
    assert.ok(!annotationFrame.includes("DIFFERENT-FILE-CONTENT"));
    await session.checkpoint("04-original-file-evidence-without-stale-preview");
    await session.keys(detail, "r");
    await session.waitVisible(detail, "DIFFERENT-FILE-CONTENT");
    const after = await session.waitFor("changed file reconciled", () => readAnnotation(fileSaved.block.id), value => value.currentResolution.status !== "resolved");
    assert.equal(after.resolvedTarget, null);
    assert.deepEqual(after.originalTarget, fileSaved.originalTarget);
    await session.waitVisible(detail, "Unpositioned comments");
    await session.keys(detail, "tab", "enter");
    await session.waitVisible(detail, fileComment);
    await session.checkpoint("05-changed-file-unpositioned-comment");
    await session.record("file-identity", { original: fileSaved, after, annotationFrame });

    const { resource } = await session.client.request<InternResourceReceipt>({
      action: "resources.intern-filesystem", input: { path: "metadata.bin", mediaType: "application/octet-stream" },
    });
    const description = await session.client.request<ResourceDescription>({
      action: "resources.describe", destinationClientId: registration.clientId,
      target: { kind: "resource", resourceId: resource.id },
    });
    assert.equal(description.presentation?.selected?.representation, "metadata");
    const file = description.filesystem;
    assert.ok(file && file.revision.revision.kind === "filesystem");
    const revision = file.revision.revision;
    const representation = {
      id: `filesystem:${resource.id}:${revision.mtimeNs}:${revision.size}:${file.contentHash}`,
      subject: { kind: "resource" as const, resourceId: resource.id },
      sourceSnapshot: { kind: "resource" as const, resourceId: resource.id, sourceSnapshotId: null, revision: file.revision },
      adapter: { id: "filesystem.text", version: 1 }, mediaType: resource.mediaType,
      contentHash: file.contentHash, capturedAt: file.capturedAt,
    };
    // An existing API-authored comment may reference available source bytes even
    // when this destination's chosen presentation only displays metadata.
    const metadataComment = await session.client.request<AnnotationBatchReceipt>({
      action: "annotations.create", requestId: crypto.randomUUID(), input: {
        target: { representation, anchor: createTextQuoteAnchor(file.text, file.text.indexOf("HIDDEN-QUOTE"), file.text.length) },
        body: "Comment on hidden source", source: "agent",
      },
    });
    await goto(metadataComment.annotations[0]!.block.id);
    await session.waitVisible(detail, "Stored resolution: resolved");
    await session.keys(detail, "r");
    await session.waitVisible(detail, "not displayed in this Resource view");
    await session.keys(detail, "v");
    await session.waitVisible(detail, "This view has no source text to annotate");
    const metadataFrame = await session.visible(detail);
    assert.ok(!metadataFrame.includes("HIDDEN-QUOTE"));
    assert.ok(!metadataFrame.split("\n").some(line => line.startsWith("+ ") && line.includes("metadata.bin")));
    await session.keys(detail, "tab", "enter");
    await session.waitVisible(detail, "Comment on hidden source");
    await session.waitVisible(detail, "HIDDEN-QUOTE");
    await session.checkpoint("06-metadata-only-unpositioned-comment");
    await session.record("metadata-representation", { description, metadataComment, metadataFrame });
  },
});
process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.status === "failed") process.exitCode = 1;
