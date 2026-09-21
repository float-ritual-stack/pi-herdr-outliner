import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createAnnotationReferenceContext, createTextQuoteAnchor } from "../../src/annotations";
import type { AnnotationBatchReceipt, AnnotationRecord, AnnotationTarget, AnnotationThread, Block, InternResourceReceipt, OutlinerClientRegistration, ResourceDescription } from "../../src/types";
import { runHerdrScenario } from "./herdr-runner";

const originalText = ["# Thread document", "", "GLOBAL PASSAGE", ...Array.from({ length: 22 }, (_, i) => `Source line ${i + 1}`), "CONTEXT PASSAGE", ...Array.from({ length: 20 }, (_, i) => `ORPHAN evidence ${i + 1}`)].join("\n");
const changedText = originalText.slice(0, originalText.indexOf("ORPHAN evidence")) + "Replacement tail";
const composed = process.argv.includes("--composed");
const result = await runHerdrScenario({
  name: composed ? "annotation-threads-composed" : "annotation-threads",
  layout: composed ? "composed" : "separate",
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
    const reveal = async (blockId: string, panes = { tree, detail }) => {
      await s.revealTree(panes.tree, blockId);
      await s.waitFor("target published", s.registrations, cs => cs.some(c => c.runtime?.paneId === panes.detail && c.currentTarget?.kind === "block" && c.currentTarget.blockId === blockId));
      await s.focus(panes.detail);
      if (composed && panes.detail === detail && (await current()).focusedRegion !== "detail") {
        await terminal.write("\u001b[17~");
        await s.waitFor("Detail region focused", current, c => c.focusedRegion === "detail");
      }
    };
    await reveal(host.id);
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
    const pointerFrame = await s.waitFor("selected thread controls in attached client", () => terminal.visible(), frame => {
      const panel = frame.slice(frame.indexOf("▶ Comment 2"));
      return frame.includes("▶ Comment 2") && panel.includes("‹ Select › · Reply · Resolve");
    });
    const pointerLines = pointerFrame.split("\n");
    const panelStart = pointerLines.findIndex(line => line.includes("▶ Comment 2"));
    const panelEnd = pointerLines.findIndex((line, index) => index > panelStart && line.includes("╰"));
    const row = pointerLines.findIndex((line, index) => index > panelStart && index < panelEnd && line.includes("‹ Select › · Reply · Resolve"));
    assert.ok(row > panelStart, "Reply control belongs to the selected contextual thread");
    const column = visibleWidth(pointerLines[row]!.slice(0, pointerLines[row]!.indexOf("Reply")));
    await s.record("native-thread-reply-click", { row, column, frame: pointerFrame });
    await terminal.write(`\u001b[<0;${column + 1};${row + 1}M`);
    await terminal.write(`\u001b[<0;${column + 1};${row + 1}m`);
    await s.waitVisible(detail, "Reply to comment");
    await s.waitVisible(detail, "“Second reference thread”");
    await s.checkpoint("02a-native-reply-control");
    await s.keys(detail, "esc"); await s.waitVisible(detail, "Reply cancelled");
    assert.deepEqual((await current()).currentTarget, target);
    assert.equal((await s.visible(detail)).split("\n")[3], beforeReply.split("\n")[3]);
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
    if (composed) {
      assert.deepEqual((await current()).currentTarget, target);
      assert.equal((await s.client.request<Block>({ action: "get", blockId: host.id })).text, host.text);
      assert.deepEqual((await s.client.request<AnnotationRecord>({ action: "annotations.get", annotationId: selected.block.id })).originalTarget, selected.originalTarget);
      await s.record("composed-thread-controls", { target, beforeReply, threads: await threads(),
        input: "Internal F6 focus, contextual Resource opening, native Reply click, multiline reply, resolve/reopen, cancellation, other occurrence and orphan navigation",
        limits: "Standalone companion journey covers full ANSI appendix and narrow thread scrolling; composed-surface companion covers narrow/wide allocation." });
      return;
    }

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
    await terminal.resize(220, 60);
    const ansi = await s.openRemoteBrowsingContext({ renderer: "ansi" });
    // API focus does not replace the attached client's independently active tab.
    const tabFrame = await s.waitFor("third tab is visible", () => terminal.visible(), frame => /\s3\s/.test(frame.split("\n")[0]!));
    const tabColumn = visibleWidth(tabFrame.split("\n")[0]!.slice(0, tabFrame.split("\n")[0]!.indexOf("3")));
    await terminal.write(`\u001b[<0;${tabColumn + 1};1M`);
    await terminal.write(`\u001b[<0;${tabColumn + 1};1m`);
    await s.waitFor("attached client displays ANSI tab", () => terminal.visible(), frame => frame.includes("client-project"));
    await reveal(orphan.block.id, ansi);
    await s.waitVisible(ansi.detail, "Original target:");
    await s.keys(ansi.detail, "G"); await s.waitVisible(ansi.detail, "Orphan final comment sentinel");
    await s.checkpoint("09-ansi-evidence-bottom-reachable");
    const evidenceRow = (await s.visible(ansi.detail)).split("\n")[3];
    for (const lifecycle of ["resolved", "open"] as const) {
      await s.keys(ansi.detail, "D");
      await s.waitFor(`direct annotation ${lifecycle}`, () => thread(orphan.block.id), t => t.lifecycle === lifecycle);
      await s.waitVisible(ansi.detail, "Orphan final comment sentinel");
      assert.equal((await s.visible(ansi.detail)).split("\n")[3], evidenceRow);
    }
    await s.checkpoint("09a-annotation-lifecycle-keeps-evidence-viewport");
    await reveal(host.id, ansi);
    await s.keys(ansi.detail, "o"); await s.waitVisible(ansi.detail, "Choose a reference");
    await s.keys(ansi.detail, "tab", "o"); await s.waitVisible(ansi.detail, "Choose destination");
    await s.keys(ansi.detail, "enter"); await s.waitVisible(ansi.detail, "GLOBAL PASSAGE");
    const ansiCurrent = async () => (await s.registrations()).find(c => c.runtime?.paneId === ansi.detail)!;
    const ansiTarget = (await ansiCurrent()).currentTarget;
    assert.ok(ansiTarget?.kind === "resource" && ansiTarget.referenceContext);
    await s.keys(ansi.detail, "]"); await s.waitVisible(ansi.detail, "▶ Comment 1"); await s.waitVisible(ansi.detail, "File-wide thread");
    await s.keys(ansi.detail, "]"); await s.waitVisible(ansi.detail, "▶ Comment 2"); await s.waitVisible(ansi.detail, "This reference");
    await s.waitVisible(ansi.detail, "Human reply second line");
    const ansiBeforeReply = await s.visible(ansi.detail);
    await s.checkpoint("10-ansi-contextual-thread-and-replies");
    await s.keys(ansi.detail, "v"); await s.waitVisible(ansi.detail, "Scroll to source text");
    await s.keys(ansi.detail, "C"); await s.waitVisible(ansi.detail, "Reply to selected comment");
    await s.text(ansi.detail, "ANSI reply first line"); await s.keys(ansi.detail, "enter");
    await s.text(ansi.detail, "ANSI reply final line"); await s.keys(ansi.detail, "ctrl+s");
    await s.waitFor("ANSI reply persisted", () => thread(selected.block.id), t => t.replies.some(r => r.body === "ANSI reply first line\nANSI reply final line"));
    await s.waitVisible(ansi.detail, "ANSI reply final line");
    assert.deepEqual((await ansiCurrent()).currentTarget, ansiTarget);
    assert.equal((await s.visible(ansi.detail)).split("\n")[3], ansiBeforeReply.split("\n")[3]);
    await s.keys(ansi.detail, "D"); await s.waitFor("ANSI resolves selected thread", () => thread(selected.block.id), t => t.lifecycle === "resolved");
    await s.waitVisible(ansi.detail, "D reopen");
    await s.keys(ansi.detail, "D"); await s.waitFor("ANSI reopens selected thread", () => thread(selected.block.id), t => t.lifecycle === "open");
    await s.waitVisible(ansi.detail, "D resolve");
    await s.keys(ansi.detail, "C"); await s.waitVisible(ansi.detail, "Reply to selected comment");
    await s.text(ansi.detail, "Discard ANSI reply"); await s.keys(ansi.detail, "esc"); await s.waitVisible(ansi.detail, "Reply cancelled");
    assert.equal((await thread(selected.block.id)).replies.length, 3);
    assert.deepEqual((await ansiCurrent()).currentTarget, ansiTarget);
    assert.equal((await s.visible(ansi.detail)).split("\n")[3], ansiBeforeReply.split("\n")[3]);
    await s.checkpoint("11-ansi-reply-and-lifecycle-preserve-reader");
    await s.keys(ansi.detail, "]"); await s.waitVisible(ansi.detail, "▶ Comment 3"); await s.waitVisible(ansi.detail, "Other reference thread");
    await s.keys(ansi.detail, "]"); await s.waitVisible(ansi.detail, "▶ Comment 4"); await s.waitVisible(ansi.detail, "unpositioned");
    await terminal.resize(80, 28);
    await s.waitFor("narrow ANSI viewport", () => s.visible(ansi.detail), frame => frame.split("\n")[0]!.length < 70);
    await s.keys(ansi.detail, "G"); await s.waitVisible(ansi.detail, "Orphan final comment sentinel");
    await s.checkpoint("12-ansi-narrow-orphan-body-reachable");
    assert.equal((await s.client.request<Block>({ action: "get", blockId: host.id })).text, host.text);
    await s.record("thread-controls-result", { target, global, selected, other, orphan, threads: await threads(), beforeReply,
      input: "RPC Tree reveal setup; real Resource chooser; [/] navigation; native Pi Reply click and cancel; C multiline reply and cancel; D resolve/reopen; narrow resize; ANSI ordinary-thread and evidence navigation",
      limits: "Initial threads and one agent reply are fixtures through public APIs. Native pointer activation proved through attached Herdr client; two-host SSH behavior not exercised." });
    const original = await s.client.request<AnnotationRecord>({ action: "annotations.get", annotationId: selected.block.id });
    assert.deepEqual(original.originalTarget, selected.originalTarget);
  },
});
process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.status === "failed") process.exitCode = 1;
