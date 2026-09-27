import assert from "node:assert/strict";
import {writeFile} from "node:fs/promises";
import {join} from "node:path";
import {visibleWidth} from "@earendil-works/pi-tui";
import {createTextQuoteAnchor} from "../../src/annotations";
import type {AnnotationBatchReceipt, AnnotationThread, Block, InternResourceReceipt, ResourceDescription} from "../../src/types";
import {runHerdrScenario} from "./herdr-runner";

const sourceText = "# Preview annotation source\n\nEXACT PREVIEW PASSAGE\n";
const result = await runHerdrScenario({
  name: "preview-annotation-action",
  async prepare(root) {await writeFile(join(root, "source.md"), sourceText);},
  async run(s) {
    const terminal = await s.attachClient(); await terminal.resize(340, 62);
    const clients = await s.registrations();
    const detail = clients.find(c => c.role === "detail")!;
    const current = async () => (await s.registrations()).find(c => c.clientId === detail.clientId)!;
    const retained = await s.client.request<Block>({action: "create", text: "RETAINED UNRELATED DOCUMENT"});
    await s.revealTree(s.panes.tree, retained.id); await s.keys(s.panes.tree, "enter");
    await s.waitFor("retained Current", current, c => c.currentTarget?.kind === "block" && c.currentTarget.blockId === retained.id);
    const {resource} = await s.client.request<InternResourceReceipt>({action: "resources.intern-filesystem", input: {path: join(s.projectRoot, "source.md")}});
    const description = await s.client.request<ResourceDescription>({action: "resources.describe", destinationClientId: detail.clientId, target: {kind: "resource", resourceId: resource.id}});
    const file = description.filesystem!;
    assert.equal(file.revision.revision.kind, "filesystem");
    const revision = file.revision.revision;
    assert.ok(revision.kind === "filesystem");
    const representation = {id: `filesystem:${resource.id}:${revision.mtimeNs}:${revision.size}:${file.contentHash}`, subject: {kind: "resource" as const, resourceId: resource.id}, sourceSnapshot: {kind: "resource" as const, resourceId: resource.id, sourceSnapshotId: null, revision: file.revision}, adapter: {id: "filesystem.text", version: 1}, mediaType: resource.mediaType, contentHash: file.contentHash, capturedAt: file.capturedAt};
    const start = sourceText.indexOf("EXACT PREVIEW PASSAGE");
    const created = await s.client.request<AnnotationBatchReceipt>({action: "annotations.create", requestId: crypto.randomUUID(), input: {target: {representation, anchor: createTextQuoteAnchor(sourceText, start, start + "EXACT PREVIEW PASSAGE".length)}, body: "PREVIEW THREAD BODY", source: "agent"}});
    const annotationId = created.annotations[0]!.block.id;
    const thread = async () => (await s.client.request<AnnotationThread[]>({action: "annotations.list", query: {subject: {kind: "resource", resourceId: resource.id}, includeResolved: true}})).find(t => t.block.id === annotationId)!;
    const target = {kind: "resource" as const, resourceId: resource.id, revision: file.revision};
    await s.client.request({action: "navigation.dispatch", sourceClientId: detail.clientId, intent: "preview", target});
    await s.waitFor("Resource Preview ready", current, c => c.previewTarget?.kind === "resource");
    await s.focus(s.panes.detail); await s.keys(s.panes.detail, "f7");
    await s.waitFor("Preview comment marker rendered", () => s.visible(s.panes.detail), frame => frame.includes("+ EXACT PREVIEW PASSAGE"));
    await s.keys(s.panes.detail, "]");
    await s.waitVisible(s.panes.detail, "PREVIEW THREAD BODY");
    const frame = await s.waitFor("native Preview reply control", () => terminal.visible(), frame => frame.includes("Reply · Resolve"));
    const lines = frame.split("\n");
    const row = lines.findIndex(line => line.includes("Reply · Resolve"));
    const column = visibleWidth(lines[row]!.slice(0, lines[row]!.indexOf("Reply")));
    await s.record("preview-native-reply-click", {row, column, frame, annotationId, target});
    await terminal.write(`\x1b[<0;${column + 1};${row + 1}M`); await terminal.write(`\x1b[<0;${column + 1};${row + 1}m`);
    await s.waitVisible(s.panes.detail, "Reply to comment");
    assert.deepEqual((await current()).currentTarget, {kind: "block", blockId: retained.id});
    assert.deepEqual((await current()).previewTarget, target);
    await s.text(s.panes.detail, "EXACT PREVIEW NATIVE REPLY"); await s.keys(s.panes.detail, "ctrl+s");
    await s.waitFor("reply saved to clicked thread", thread, t => t.replies.some(r => r.body === "EXACT PREVIEW NATIVE REPLY"));
    assert.deepEqual((await current()).currentTarget, {kind: "block", blockId: retained.id});
    assert.deepEqual((await current()).previewTarget, target);
    assert.equal((await s.client.request<Block>({action: "get", blockId: retained.id})).text, retained.text);
    assert.equal((await s.client.request<ResourceDescription>({action: "resources.describe", destinationClientId: detail.clientId, target})).filesystem?.text, sourceText);
    await s.waitVisible(s.panes.detail, "user: EXACT PREVIEW NATIVE REPLY");
    await s.checkpoint("native-reply-stays-in-preview");
    await s.keys(s.panes.detail, "c");
    await s.waitVisible(s.panes.detail, "Comment on whole note");
    await s.text(s.panes.detail, "WHOLE RESOURCE FEEDBACK");
    await s.waitVisible(s.panes.detail, "WHOLE RESOURCE FEEDBACK");
    await terminal.resize(150, 58);
    await s.waitFor("narrow Preview composer rendered", () => s.visible(s.panes.detail), frame =>
      frame.split("\n").some(line => line.startsWith("● Preview")) && frame.includes("WHOLE RESOURCE FEEDBACK"));
    await s.checkpoint("preview-general-comment-draft");
    await s.keys(s.panes.detail, "ctrl+s");
    await s.waitFor("whole Resource comment saved", () => s.client.request<AnnotationThread[]>({
      action: "annotations.list", query: {subject: {kind: "resource", resourceId: resource.id}, includeResolved: true},
    }), threads => threads.some(t => t.body === "WHOLE RESOURCE FEEDBACK" && t.originalTarget.anchor.kind === "whole-subject"));
    await s.keys(s.panes.detail, "]");
    await s.waitVisible(s.panes.detail, "WHOLE RESOURCE FEEDBACK");
    await s.checkpoint("preview-general-comment-saved");
    assert.deepEqual((await current()).currentTarget, {kind: "block", blockId: retained.id});
    assert.deepEqual((await current()).previewTarget, target);

  },
});
console.log(JSON.stringify(result)); if(result.status !== "passed") process.exitCode = 1;
