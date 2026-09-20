import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { AnnotationRecord, AnnotationThread, Block, OutlinerClientRegistration } from "../../src/types";
import { runHerdrScenario } from "./herdr-runner";

const composed = process.argv.includes("--composed");
const result = await runHerdrScenario({
  name: composed ? "reference-annotations-composed" : "reference-annotations",
  layout: composed ? "composed" : "separate",
  async prepare(root) {
    await writeFile(join(root, "same.md"), "Shared file passage\nSecond file line");
  },
  async run(s) {
    const terminal = await s.attachClient();
    const { tree, detail } = s.panes;
    const registration = (await s.registrations()).find(c => c.runtime?.paneId === detail)!;
    assert.ok(registration);
    const current = async (): Promise<OutlinerClientRegistration> =>
      (await s.registrations()).find(c => c.clientId === registration.clientId)!;
    const focusView = async (region: "tree" | "detail") => {
      await s.focus(region === "tree" ? tree : detail);
      if (composed && (await current()).focusedRegion !== region) {
        await terminal.write("\u001b[17~");
        await s.waitFor(`internal ${region} focus`, current, c => c.focusedRegion === region);
      }
    };
    const text = "Occurrence annotation fixture\n\nFirst use [file::same.md].\nSecond use [file::same.md].";
    const host = await s.client.request<Block>({ action: "create", parentId: null, text });
    const hostThreads = () => s.client.request<AnnotationThread[]>({
      action: "annotations.list", query: { subject: { kind: "block", blockId: host.id }, includeResolved: true },
    });
    const thread = (id: string) => s.client.request<AnnotationRecord>({ action: "annotations.get", annotationId: id });
    const goto = async () => {
      if ((await current()).locked) {
        await focusView("detail"); await s.keys(detail, "L");
        await s.waitFor("reader unlocked", current, c => !c.locked);
      }
      await focusView("tree"); await s.keys(tree, "g"); await s.waitVisible(tree, "Goto:");
      await s.text(tree, host.id); await s.waitVisible(tree, host.id.slice(0, 8));
      await s.keys(tree, "enter");
      await s.waitFor("Goto accepted", () => s.visible(tree), frame => !frame.includes("Goto:"));
      await s.waitFor("source opened", current, c => c.currentTarget?.kind === "block" && c.currentTarget.blockId === host.id);
      await focusView("detail");
      const frame = await s.waitVisible(detail, "Occurrence annotation fixture");
      if (frame.includes("▾ Properties")) {
        await s.keys(detail, "p");
        await s.waitFor("Properties closed", () => s.visible(detail), frame => !frame.includes("▾ Properties"));
      }
      await s.waitVisible(detail, "First use");
    };
    const saveComment = async (body: string) => {
      await s.waitVisible(detail, "Ctrl+S save");
      await s.text(detail, body); await terminal.write("\u0013");
      const rows = await s.waitFor("comment persisted", hostThreads, ts => ts.some(t => t.body === body));
      return rows.find(t => t.body === body)!;
    };
    await goto();
    await s.keys(detail, "o"); await s.waitVisible(detail, "Choose a reference");
    await s.keys(detail, "c");
    const first = await saveComment("Comment about the first use");
    assert.equal(first.originalTarget.referenceContext?.anchor.start, text.indexOf("[file::"));
    await s.checkpoint("01-first-occurrence-comment");
    await goto();
    await s.keys(detail, "o"); await s.waitVisible(detail, "Choose a reference");
    await s.keys(detail, "tab", "c");
    const second = await saveComment("Comment about the second use");
    assert.equal(second.originalTarget.referenceContext?.anchor.start, text.lastIndexOf("[file::"));
    assert.notEqual(first.block.id, second.block.id);
    assert.equal((s.database.query("SELECT count(*) AS n FROM resources").get() as { n: number }).n, 0);
    assert.equal((await s.client.request<Block>({ action: "get", blockId: host.id })).text, text);
    await s.checkpoint("02-independent-occurrence-comments");

    await goto();
    await s.keys(detail, "o"); await s.waitVisible(detail, "Choose a reference");
    await s.keys(detail, "tab", "o"); await s.waitVisible(detail, "Choose destination");
    await s.keys(detail, "enter"); await s.waitVisible(detail, "Shared file passage");
    const target = (await current()).currentTarget;
    assert.ok(target?.kind === "resource" && target.referenceContext);
    assert.equal(target.referenceContext.anchor.start, text.lastIndexOf("[file::"));
    await s.keys(detail, "v"); await s.waitVisible(detail, "⎋ cancel");
    await s.keys(detail, ...Array(19).fill("shift+right")); await s.keys(detail, "c");
    const passage = await saveComment("File passage in the second reference context");
    assert.equal(passage.originalTarget.representation.subject.kind, "resource");
    assert.equal(passage.originalTarget.referenceContext?.anchor.start, second.originalTarget.referenceContext?.anchor.start);
    assert.ok(passage.originalTarget.representation.sourceSnapshot.kind === "resource" && passage.originalTarget.representation.sourceSnapshot.revision);
    await s.checkpoint("03-resource-passage-keeps-both-anchors");

    // Set up the explicit file-global view; the annotation itself uses real input.
    await s.client.request({ action: "ui.command.send", command: {
      targetClientId: registration.clientId, ...(composed ? { targetRegion: "detail" as const } : {}), command: "replace",
      target: { kind: "resource", resourceId: target.resourceId },
    } });
    await s.waitFor("file-global target", current, c => c.currentTarget?.kind === "resource" && !c.currentTarget.referenceContext);
    await s.waitVisible(detail, "Shared file passage");
    await s.keys(detail, "v"); await s.waitVisible(detail, "⎋ cancel");
    await s.keys(detail, ...Array(19).fill("shift+right")); await s.keys(detail, "c");
    await s.waitVisible(detail, "Ctrl+S save"); await s.text(detail, "File-global comment"); await terminal.write("\u0013");
    const resourceThreads = await s.waitFor("file-global comment persisted", () => s.client.request<AnnotationThread[]>({
      action: "annotations.list", query: { subject: { kind: "resource", resourceId: target.resourceId }, includeResolved: true },
    }), ts => ts.some(t => t.body === "File-global comment"));
    assert.equal(resourceThreads.find(t => t.body === "File-global comment")?.originalTarget.referenceContext, undefined);
    assert.equal(resourceThreads.filter(t => t.originalTarget.referenceContext).length, 1);
    assert.equal((s.database.query("SELECT count(*) AS n FROM resources").get() as { n: number }).n, 1);
    await s.checkpoint("04-global-and-contextual-comments");

    const openOccurrence = async (referenceContext: NonNullable<typeof target.referenceContext>) => {
      await s.client.request({ action: "ui.command.send", command: {
        targetClientId: registration.clientId, ...(composed ? { targetRegion: "detail" as const } : {}), command: "replace",
        target: { kind: "resource", resourceId: target.resourceId, referenceContext },
      } });
      await s.waitFor("occurrence target applied", current, c => c.currentTarget?.kind === "resource" &&
        c.currentTarget.referenceContext?.anchor.start === referenceContext.anchor.start);
      await s.waitVisible(detail, "Shared file passage");
    };
    await openOccurrence(first.originalTarget.referenceContext!);
    await focusView("detail");
    const pointerFrame = await s.waitFor("attached Resource frame", () => terminal.visible(),
      frame => frame.includes("Shared file passage") && frame.includes("line 3"));
    const lines = pointerFrame.split("\n");
    const quote = "Shared file passage";
    const row = lines.findIndex(line => line.includes(quote));
    const column = visibleWidth(lines[row]!.slice(0, lines[row]!.indexOf(quote)));
    await terminal.write(`\u001b[<0;${column + 1};${row + 1}M`);
    await terminal.write(`\u001b[<32;${column + quote.length + 1};${row + 1}M`);
    await terminal.write(`\u001b[<0;${column + quote.length + 1};${row + 1}m`);
    // A visible composer acknowledges the PTY selection before a separate RPC
    // channel navigates. Keep the drag and initial key on the same input stream.
    await terminal.write("c");
    await s.waitVisible(detail, "Comment on this reference");
    await terminal.write("\u001b");
    await s.waitVisible(detail, "Comment cancelled");
    await focusView("detail");
    await openOccurrence(second.originalTarget.referenceContext!);
    await s.keys(detail, "c");
    await s.waitVisible(detail, "reference context changed");
    assert.equal((await hostThreads()).length, 3);
    await s.checkpoint("04b-pointer-selection-cannot-switch-occurrence");
    await openOccurrence(first.originalTarget.referenceContext!);
    await s.keys(detail, "c");
    await s.waitVisible(detail, "Comment on this reference");
    await terminal.write("\u001b");
    await s.waitVisible(detail, "Comment cancelled");
    await s.record("pointer-occurrence-evidence", { row, column, quote,
      selectedContext: first.originalTarget.referenceContext, rejectedContext: second.originalTarget.referenceContext });

    await goto(); await s.keys(detail, "e"); await s.waitVisible(detail, "⌃S save");
    await terminal.write("\u001ba");
    await s.text(detail, "Occurrence annotation fixture\n\nFirst use [file::same.md].\nFirst use [file::same.md].");
    await terminal.write("\u0013");
    const changed = await s.waitFor("ambiguous and missing uses retained", hostThreads,
      ts => ts.length === 3 && ts.every(t => t.currentResolution.status !== "resolved"));
    assert.ok(changed.some(t => t.currentResolution.status === "ambiguous"));
    assert.deepEqual((await thread(first.block.id)).originalTarget, first.originalTarget);
    assert.deepEqual((await thread(second.block.id)).originalTarget, second.originalTarget);
    await s.waitVisible(detail, "Unpositioned comments");
    await s.checkpoint("05-ambiguous-and-deleted-uses-recoverable");
    await openOccurrence(second.originalTarget.referenceContext!);
    await s.waitVisible(detail, "Unpositioned comments (1)");
    await s.checkpoint("05b-resource-history-does-not-restore-deleted-occurrence");
    await s.record("reference-annotation-result", { hostId: host.id, first, second, passage, changed,
      resourceThreads, input: "Real Properties occurrence selection, comment typing/save/reopen, Resource selection, source edit causing duplicate/deleted references",
      limits: "File-global and pointer-transition views set up through existing UI commands. Native pointer drag and comment/cancel keys exercised. Restart/replies/lifecycle additionally covered through public protocol tests and PIE-265." });
  },
});
process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.status === "failed") process.exitCode = 1;
