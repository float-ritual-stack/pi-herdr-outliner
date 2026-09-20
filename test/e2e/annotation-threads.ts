import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAnnotationReferenceContext, createTextQuoteAnchor } from "../../src/annotations";
import type { AnnotationBatchReceipt, AnnotationRecord, AnnotationTarget, AnnotationThread, Block, InternResourceReceipt, OutlinerClientRegistration, ResourceDescription } from "../../src/types";
import { runHerdrScenario } from "./herdr-runner";

const originalText = ["# Thread document", "", "GLOBAL PASSAGE", ...Array.from({ length: 22 }, (_, i) => `Source line ${i + 1}`), "CONTEXT PASSAGE", ...Array.from({ length: 20 }, (_, i) => `ORPHAN evidence ${i + 1}`)].join("\n");
const changedText = originalText.slice(0, originalText.indexOf("ORPHAN evidence")) + "Replacement tail";
const result = await runHerdrScenario({
  name: "annotation-threads",
  async prepare(root) { await writeFile(join(root, "threads.md"), originalText); },
  async run(s) {
    const terminal = await s.attachClient();
    const { tree, detail } = s.panes;
    const registration = (await s.registrations()).find(c => c.runtime?.paneId === detail)!;
    assert.ok(registration);
    const current = async (): Promise<OutlinerClientRegistration> => (await s.registrations()).find(c => c.clientId === registration.clientId)!;
    const host = await s.client.request<Block>({ action: "create", parentId: null,
      text: "Thread host\n\nFirst use [file::threads.md].\nSecond use [file::threads.md]." });
    const { resource } = await s.client.request<InternResourceReceipt>({ action: "resources.intern-filesystem", input: { path: "threads.md" } });
    const description = await s.client.request<ResourceDescription>({ action: "resources.describe", destinationClientId: registration.clientId,
      target: { kind: "resource", resourceId: resource.id } });
    const file = description.filesystem;
    assert.ok(file && file.revision.revision.kind === "filesystem");
    const revision = file.revision.revision;
    const representation = { id: `filesystem:${resource.id}:${revision.mtimeNs}:${revision.size}:${file.contentHash}`,
      subject: { kind: "resource" as const, resourceId: resource.id },
      sourceSnapshot: { kind: "resource" as const, resourceId: resource.id, sourceSnapshotId: null, revision: file.revision },
      adapter: { id: "filesystem.text", version: 1 }, mediaType: resource.mediaType, contentHash: file.contentHash, capturedAt: file.capturedAt };
    const context = (start: number) => createAnnotationReferenceContext(host, start, start + "[file::threads.md]".length);
    const add = async (body: string, exact: string, referenceContext?: AnnotationTarget["referenceContext"]) => {
      const start = originalText.indexOf(exact);
      const receipt = await s.client.request<AnnotationBatchReceipt>({ action: "annotations.create", requestId: crypto.randomUUID(), input: {
        target: { representation, anchor: createTextQuoteAnchor(originalText, start, start + exact.length), ...(referenceContext ? { referenceContext } : {}) }, body, source: "agent",
      } });
      return receipt.annotations[0]!;
    };
    const global = await add("File-wide thread", "GLOBAL PASSAGE");
    const selected = await add("Second reference thread", "CONTEXT PASSAGE", context(host.text.lastIndexOf("[file::")));
    const other = await add("Other reference thread", "CONTEXT PASSAGE", context(host.text.indexOf("[file::")));
    const orphan = await add("Orphan final comment sentinel", originalText.slice(originalText.indexOf("ORPHAN evidence")));
    await s.client.request({ action: "annotations.reply", requestId: crypto.randomUUID(), input: { annotationId: selected.block.id, body: "Existing agent reply", source: "agent" } });
    await writeFile(join(s.projectRoot, "threads.md"), changedText);
    const threads = () => s.client.request<AnnotationThread[]>({ action: "annotations.list", query: { subject: { kind: "resource", resourceId: resource.id }, includeResolved: true } });
    const thread = async (id: string) => (await threads()).find(t => t.block.id === id)!;
    const goto = async (blockId: string, panes = { tree, detail }) => {
      await s.focus(panes.tree); await s.keys(panes.tree, "g"); await s.waitVisible(panes.tree, "Goto:");
      await s.text(panes.tree, blockId); await s.waitVisible(panes.tree, blockId.slice(0, 8)); await s.keys(panes.tree, "enter");
      await s.waitFor("target published", s.registrations, cs => cs.some(c => c.runtime?.paneId === panes.detail && c.currentTarget?.kind === "block" && c.currentTarget.blockId === blockId));
      await s.focus(panes.detail);
    };
    await goto(host.id);
    await s.keys(detail, "o"); await s.waitVisible(detail, "Choose a reference");
    await s.keys(detail, "tab", "o"); await s.waitVisible(detail, "Choose destination");
    await s.keys(detail, "enter"); await s.waitVisible(detail, "GLOBAL PASSAGE");
    await s.waitFor("all threads loaded", threads, ts => ts.length === 4 && ts.find(t => t.block.id === orphan.block.id)?.resolvedTarget === null);
    const target = (await current()).currentTarget;
    assert.ok(target?.kind === "resource" && target.referenceContext);
    await s.checkpoint("01-contextual-resource-and-orphan");
    await s.keys(detail, "]"); await s.waitVisible(detail, "File-wide thread"); await s.waitVisible(detail, "Resource-wide");
    await s.keys(detail, "]"); await s.waitVisible(detail, "Second reference thread"); await s.waitVisible(detail, "This reference");
    await s.waitVisible(detail, "Existing agent reply");
    const beforeReply = await s.visible(detail);
    await s.checkpoint("02-selected-contextual-thread");
    await s.keys(detail, "C"); await s.waitVisible(detail, "Reply to comment");
    await terminal.write("\u0013"); await s.waitVisible(detail, "Reply body cannot be empty");
    await s.checkpoint("03-empty-reply-keeps-composer");
    await s.text(detail, "Human reply first line\nHuman reply second line"); await terminal.write("\u0013");
    await s.waitFor("human reply persisted", () => thread(selected.block.id), t => t.replies.some(r => r.body === "Human reply first line\nHuman reply second line" && r.source === "user"));
    await s.waitVisible(detail, "Human reply second line");
    assert.deepEqual((await current()).currentTarget, target);
    assert.equal((await s.visible(detail)).split("\n")[3], beforeReply.split("\n")[3]);
    await s.checkpoint("04-human-and-agent-replies-in-place");
    await s.keys(detail, "D"); await s.waitFor("thread resolved", () => thread(selected.block.id), t => t.lifecycle === "resolved");
    await s.waitVisible(detail, "Reopen");
    assert.equal((await s.visible(detail)).split("\n")[3], beforeReply.split("\n")[3]);
    await s.checkpoint("05-resolved-in-place");
    await s.keys(detail, "D"); await s.waitFor("thread reopened", () => thread(selected.block.id), t => t.lifecycle === "open");
    await s.waitVisible(detail, "Resolve");
    await s.keys(detail, "C"); await s.waitVisible(detail, "Reply to comment"); await s.text(detail, "Discard this reply"); await s.keys(detail, "esc");
    await s.waitVisible(detail, "Reply cancelled");
    assert.equal((await thread(selected.block.id)).replies.length, 2);
    assert.deepEqual((await current()).currentTarget, target);
    await s.keys(detail, "]"); await s.waitVisible(detail, "Other reference thread"); await s.waitVisible(detail, "Other reference");
    await s.checkpoint("06-other-occurrence-reachable");
    await s.keys(detail, "]"); await s.waitVisible(detail, "Comment 4 of 4"); await s.keys(detail, "G"); await s.waitVisible(detail, "Orphan final comment sentinel");
    await s.checkpoint("07-orphan-reachable");
    await s.keys(detail, "]"); await s.waitVisible(detail, "wrapped"); await s.waitVisible(detail, "File-wide thread");
    await s.keys(detail, "["); await s.waitVisible(detail, "Comment 4 of 4"); await s.keys(detail, "G"); await s.waitVisible(detail, "Orphan final comment sentinel");
    await terminal.resize(100, 32);
    await s.waitFor("narrow viewport", () => s.visible(detail), frame => frame.split("\n")[0]!.length < 70);
    await s.keys(detail, "["); await s.waitVisible(detail, "Comment 3 of 4"); await s.waitVisible(detail, "Reply");
    await s.checkpoint("08a-narrow-thread-controls");
    await s.keys(detail, "down", "down", "down"); await s.waitVisible(detail, "Other reference thread");
    await s.checkpoint("08-narrow-thread-body-reachable");
    assert.equal((await s.client.request<Block>({ action: "get", blockId: host.id })).text, host.text);
    const afterFile = await s.client.request<ResourceDescription>({ action: "resources.describe", destinationClientId: registration.clientId, target: { kind: "resource", resourceId: resource.id } });
    assert.equal(afterFile.filesystem?.text, changedText);
    const ansi = await s.openRemoteBrowsingContext({ renderer: "ansi" });
    await goto(orphan.block.id, ansi);
    await s.waitVisible(ansi.detail, "Original target:");
    await s.keys(ansi.detail, "G"); await s.waitVisible(ansi.detail, "Orphan final comment sentinel");
    await s.checkpoint("09-ansi-evidence-bottom-reachable");
    await s.record("thread-controls-result", { target, global, selected, other, orphan, threads: await threads(), beforeReply,
      input: "Real Tree goto and Resource chooser; [/] navigation; C multiline reply and cancel; D resolve/reopen; narrow resize; ANSI G evidence navigation",
      limits: "Initial threads and one agent reply are fixtures through public APIs. Pointer action URIs have renderer/controller coverage; no native pointer activation claimed." });
    const original = await s.client.request<AnnotationRecord>({ action: "annotations.get", annotationId: selected.block.id });
    assert.deepEqual(original.originalTarget, selected.originalTarget);
  },
});
process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.status === "failed") process.exitCode = 1;
