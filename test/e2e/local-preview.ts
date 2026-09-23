import assert from "node:assert/strict";
import {readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {visibleWidth} from "@earendil-works/pi-tui";
import type {NavigationLinkState, Block, InternResourceReceipt, OutlinerClientRegistration, ResourceDescription} from "../../src/types";
import {runHerdrScenario} from "./herdr-runner";

const composed = process.argv.includes("--composed");
const ansi = process.argv.includes("--ansi");
const heldReads = process.argv.includes("--held");
const result = await runHerdrScenario({
  name: `local-preview${composed ? "-composed" : ansi ? "-ansi" : ""}`,
  layout: composed ? "composed" : "separate",
  async prepare(root) { await writeFile(join(root, "preview-resource.md"), "RESOURCE PREVIEW EXACT BYTES\n"); },
  async run(session) {
    const terminal = await session.attachClient();
    await terminal.resize(340, 60);
    const panes = ansi || heldReads ? await session.openRemoteBrowsingContext({renderer: ansi ? "ansi" : "pi-tui", detailTransport: heldReads ? "forwarded" : "direct"}) : session.panes;
    if (composed) await session.enableComposedResponseBarriers();
    const clients = await session.registrations();
    const tree = clients.find(c => c.runtime?.paneId === panes.tree && c.role === (composed ? "composed" : "tree"))!;
    const detail = clients.find(c => c.runtime?.paneId === panes.detail && c.role === (composed ? "composed" : "detail"))!;
    assert.ok(tree && detail);
    const docs: Block[] = [];
    for (const text of ["RETAINED CURRENT", "INSPECTION ALPHA", "INSPECTION BETA", "INSPECTION GAMMA"]) docs.push(await session.client.request<Block>({action: "create", text: `${text}\n\n${Array.from({length: 70}, (_, i) => `${text} line ${i + 1}`).join("\n")}`}));
    const state = async () => (await session.registrations()).find(c => c.clientId === detail.clientId)!;
    const inspectDetail = async (blockId: string) => {
      await session.revealTree(panes.tree, blockId);
      // Standalone Tree owns selection Preview. Exercise the independent Detail
      // reader explicitly; composed selection still drives its shared reader.
      if (!composed) await session.client.request({action:"ui.command.send",command:{command:"preview",targetClientId:detail.clientId,target:{kind:"block",blockId}}});
    };
    const current = (c: OutlinerClientRegistration, id: string) => c.currentTarget?.kind === "block" && c.currentTarget.blockId === id;
    const preview = (c: OutlinerClientRegistration, id: string) => c.previewTarget?.kind === "block" && c.previewTarget.blockId === id;
    const focusDetail = async () => {
      await session.focus(panes.detail);
      if (composed) {
        await session.client.request({action: "ui.command.send", command: {command: "focus", targetClientId: detail.clientId, targetRegion: "detail"}});
        await session.waitFor("Detail region focused", state, c => c.focusedRegion === "detail");
      }
    };
    await session.revealTree(panes.tree, docs[0]!.id); await session.keys(panes.tree, "enter");
    await session.waitFor("Current explicitly opened", state, c => current(c, docs[0]!.id));
    await focusDetail(); await session.keys(panes.detail, "e"); await session.text(panes.detail, " DRAFT RETAINED ");
    await session.waitVisible(panes.detail, "DRAFT RETAINED");
    for (const doc of docs.slice(1)) {
      await inspectDetail(doc.id);
      await session.waitFor("local Preview updates", state, c => preview(c, doc.id));
      assert.ok(current(await state(), docs[0]!.id));
    }
    await session.checkpoint("01-current-draft-plus-preview");
    await focusDetail();
    const sizes = composed ? [[340, 35], [240, 38], [200, 22]] : ansi || heldReads ? [[140, 50], [80, 74], [80, 42]] : [[270, 50], [180, 74], [180, 42]];
    for (const [index, size] of sizes.entries()) {
      await terminal.resize(size[0]!, size[1]!);
      const frame = await session.waitFor(`responsive Detail ${index}`, () => session.visible(panes.detail), frame => {
        const lines = frame.split("\n");
        if (index === 0) return lines.some(line => line.includes("Current") && line.includes("Preview") && line.includes("INSPECTION GAMMA")) && frame.includes("DRAFT") && Math.max(...lines.map(visibleWidth)) < (composed ? 160 : ansi || heldReads ? 140 : 130);
        if (index === 1) return frame.includes("DRAFT") && frame.includes("INSPECTION GAMMA") && lines.some(line => (composed ? /[●○] Preview ·/.test(line) : /^[●○]? ?Preview ·/.test(line)) && !line.includes("Current"));
        return frame.includes("Preview ready") && frame.includes("DRAFT");
      });
      await session.record(`responsive-detail-${index}`, {columns: size[0], rows: size[1], frame});
      await session.checkpoint(["detail-beside", "detail-below", "detail-compact"][index]!);
    }
    // Escape from focused Preview must close only that view, not Current's draft.
    await session.keys(panes.detail, "alt+p");
    await session.waitVisible(panes.detail, "INSPECTION GAMMA");
    await session.keys(panes.detail, "escape");
    await session.waitFor("Escape releases only Preview", state, c => !c.previewTarget && !!c.navigationProtection && current(c, docs[0]!.id));
    await session.waitVisible(panes.detail, "DRAFT");
    await inspectDetail(docs[3]!.id);
    await session.waitFor("Preview can reopen after Escape", state, c => preview(c, docs[3]!.id));
    await focusDetail(); await terminal.resize(110, 38);
    await session.keys(panes.detail, "alt+p"); await session.waitFor("Preview visibly focused", () => session.visible(panes.detail), frame => frame.includes(ansi ? "Preview ·" : "● Preview"));
    await (ansi ? session.keys(panes.detail, "alt+enter") : terminal.write("\x1b[13;3u"));
    await session.waitVisible(panes.detail, "Finish or cancel");
    assert.ok(current(await state(), docs[0]!.id));
    await session.keys(panes.detail, "alt+p"); await session.waitVisible(panes.detail, "DRAFT");
    await session.keys(panes.detail, "ctrl+z");
    await session.keys(panes.detail, "escape");
    await session.waitFor("Current draft cancelled", state, c => !c.navigationProtection);
    await focusDetail(); await session.keys(panes.detail, "alt+p");
    await (ansi ? session.keys(panes.detail, "alt+enter") : terminal.write("\x1b[13;3u"));
    await session.waitFor("Keep promotes Preview", state, c => current(c, docs[3]!.id) && !c.previewTarget);
    assert.equal((await session.client.request<Block>({action: "get", blockId: docs[0]!.id})).text, docs[0]!.text);
    await session.checkpoint("02-narrow-return-and-keep");
    await terminal.resize(340, 60);
    const interned = await session.client.request<InternResourceReceipt>({action: "resources.intern-filesystem", input: {path: join(session.projectRoot, "preview-resource.md")}});
    const base = {kind: "resource" as const, resourceId: interned.resource.id};
    const described = await session.client.request<ResourceDescription>({action: "resources.describe", destinationClientId: detail.clientId, target: base});
    const target = {...base, revision: described.filesystem!.revision};
    await session.client.request({action: "navigation.dispatch", sourceClientId: detail.clientId, intent: "preview", target});
    await session.waitFor("Resource Preview identity", state, c => c.previewTarget?.kind === "resource");
    assert.deepEqual((await state()).previewTarget, target);
    assert.ok(current(await state(), docs[3]!.id));
    await focusDetail(); await session.keys(panes.detail, "alt+p"); await session.waitVisible(panes.detail, "RESOURCE PREVIEW EXACT BYTES");
    await session.checkpoint("03-resource-preview-retains-current");
    await session.keys(panes.detail, "escape");
    await session.waitFor("Preview released", state, c => !c.previewTarget);
    assert.ok(current(await state(), docs[3]!.id));
    if (composed || heldReads) {
      const old = await session.client.request<Block>({action: "create", text: "OBSOLETE HELD PREVIEW"});
      const newest = await session.client.request<Block>({action: "create", text: "NEWEST PREVIEW WINS"});
      const hold = composed ? session.holdComposedResponse({action: "blocks.context", contains: old.id}) : session.holdDetailResponse({action: "blocks.context", contains: old.id});
      await inspectDetail(old.id); await hold.received;
      await inspectDetail(newest.id);
      hold.release();
      await session.waitFor("newer Preview wins held read", state, c => preview(c, newest.id));
      assert.ok(current(await state(), docs[3]!.id));
      await session.checkpoint("04-held-read-cannot-change-current");
    }
    await session.revealTree(panes.tree, docs[1]!.id); await session.keys(panes.tree, "enter");
    await session.waitFor("explicit Open still follows link", state, c => current(c, docs[1]!.id));
    await session.checkpoint("04-explicit-open-independent");
    await terminal.resize(340, 60);
    await focusDetail();
    const beforeReaders = await session.registrations();
    await session.keys(panes.detail, "alt+shift+right");
    const withReader = await session.waitFor("independent destination reader", session.registrations, values => values.some(c => c.role === "detail" && !beforeReaders.some(old => old.clientId === c.clientId)));
    const destination = withReader.find(c => c.role === "detail" && !beforeReaders.some(old => old.clientId === c.clientId))!;
    const destinationPane = await session.adoptDetached(destination.clientId, "detail");
    const destinationDoc = await session.client.request<Block>({action: "create", text: "HUMAN DESTINATION NOTE\n\nPICKER DOCUMENT PREVIEW PROOF\n\nA readable paragraph identifies this pane."});
    await session.client.request({action: "ui.command.send", command: {targetClientId: destination.clientId, command: "open", target: {kind: "block", blockId: destinationDoc.id}}});
    await session.waitVisible(destinationPane, "PICKER DOCUMENT PREVIEW PROOF");
    await inspectDetail(docs[2]!.id);
    await focusDetail(); await session.keys(panes.detail, "alt+p");
    await session.waitVisible(panes.detail, "INSPECTION BETA");
    await session.keys(panes.detail, "alt+l");
    await session.waitVisible(panes.detail, "Link destination");
    await session.text(panes.detail, "HUMAN DESTINATION");
    const pickerFrame = await session.waitVisible(panes.detail, "PICKER DOCUMENT PREVIEW PROOF");
    assert.ok(pickerFrame.includes("HUMAN DESTINATION"));
    await session.record("focused-preview-destination-picker", {frame: pickerFrame, destinationId: destination.clientId});
    await session.checkpoint("focused-preview-alt-l-rich-picker");
    await session.keys(panes.detail, "escape");
    await session.waitFor("destination picker cancelled", () => session.visible(panes.detail), frame => !frame.includes("Link destination · preview"));
    const cancelled = await session.client.request<NavigationLinkState>({action: "navigation.link.get", source: {clientId: detail.clientId, region: "detail"}});
    assert.equal(cancelled.destination, null);
    await session.keys(panes.detail, "alt+l"); await session.waitVisible(panes.detail, "Link destination");
    await session.text(panes.detail, "HUMAN DESTINATION");
    if (ansi) await session.keys(panes.detail, "enter");
    else {
      const menuFrame = await session.waitFor("native destination row", terminal.visible, frame => frame.includes("→ HUMAN DESTINATION"));
      const rows = menuFrame.split("\n");
      const row = rows.findIndex(line => line.includes("→ HUMAN DESTINATION"));
      const column = visibleWidth(rows[row]!.slice(0, rows[row]!.indexOf("HUMAN DESTINATION"))) + 3;
      await session.record("preview-picker-native-choice", {row, column, frame: menuFrame});
      await terminal.write(`\x1b[<0;${column + 1};${row + 1}M\x1b[<0;${column + 1};${row + 1}m`);
    }
    await session.waitFor("human destination selected", () => session.client.request<NavigationLinkState>({action: "navigation.link.get", source: {clientId: detail.clientId, region: "detail"}}), link => link.destination?.clientId === destination.clientId);
    await session.waitVisible(panes.detail, "Open → HUMAN DESTINATION");
    await session.waitVisible(panes.detail, ansi ? "Preview ·" : "● Preview");
    await session.closeDetached(destinationPane);
    if (!ansi && !heldReads) {
      await session.setKeybindings({"tree.root.right": ["Alt+T"]});
      await session.focus(panes.tree);
      if (composed) await session.client.request({action: "ui.command.send", command: {command: "focus", targetRegion: "tree", targetClientId: tree.clientId}});
      await session.keys(panes.tree, "ctrl+r");
      await session.waitVisible(panes.tree, "Outliner keymap reloaded");
      await inspectDetail(docs[2]!.id);
      const before = await session.registrations();
      await session.keys(panes.tree, "alt+t");
      const added = await session.waitFor("independent Tree registered", session.registrations, values => values.some(c => c.role === "tree" && !before.some(b => b.clientId === c.clientId)));
      const independent = added.find(c => c.role === "tree" && !before.some(b => b.clientId === c.clientId))!;
      const pane = await session.adoptDetached(independent.clientId, "tree");
      assert.equal(added.filter(c => c.role === "detail").length, before.filter(c => c.role === "detail").length);
      await session.revealTree(pane, docs[2]!.id);
      await session.waitFor("Tree local Preview retained", session.registrations, values => values.find(c => c.clientId === independent.clientId)?.previewTarget?.kind === "block");
      await session.keys(pane, "alt+p");
      await session.waitVisible(pane, "Preview");
      await session.checkpoint("05-independent-tree-local-preview");
      await session.keys(pane, "escape");
      await session.waitFor("Tree Escape releases Preview before pointer", session.registrations, values => !values.find(c => c.clientId === independent.clientId)?.previewTarget);
      await session.revealTree(pane, docs[2]!.id);
      await session.focus(pane); await terminal.resize(600, 60);
      const pointerDoc = await session.client.request<Block>({action: "create", text: "TREE POINTER SOURCE\n\nCOPY ONLY PREVIEW TEXT\nSECOND PREVIEW PASSAGE\nTHIRD PREVIEW PASSAGE"});
      await session.revealTree(pane, pointerDoc.id);
      await session.waitVisible(pane, "COPY ONLY PREVIEW TEXT");
      const pointerFrame = await session.waitFor("Tree Preview visible beside hierarchy", terminal.visible, frame => Math.max(...frame.split("\n").map(visibleWidth)) >= 590 && frame.split("\n").some(line => line.includes("COPY ONLY PREVIEW TEXT") && !line.includes("↵")) && frame.includes("TREE POINTER SOURCE"));
      const lines = pointerFrame.split("\n");
      const row = lines.findIndex(line => line.includes("COPY ONLY PREVIEW TEXT") && !line.includes("↵"));
      const column = visibleWidth(lines[row]!.slice(0, lines[row]!.lastIndexOf("COPY ONLY PREVIEW TEXT")));
      const beforePointer = (await session.registrations()).find(c => c.clientId === independent.clientId)!;
      const beforeSelection = await session.client.request({action: "browsing-context.get", contextId: independent.contextId});
      await terminal.write(`\x1b[<0;${column + 1};${row + 1}M\x1b[<32;${column + 12};${row + 1}M\x1b[<0;${column + 12};${row + 1}m`);
      await session.waitVisible(pane, "● Preview");
      const afterPointer = (await session.registrations()).find(c => c.clientId === independent.clientId)!;
      const afterSelection = await session.client.request({action: "browsing-context.get", contextId: independent.contextId});
      assert.deepEqual(afterSelection, beforeSelection);
      assert.deepEqual(afterPointer.previewTarget, beforePointer.previewTarget);
      const output = await readFile(join(session.artifactDirectory, "attached-client.ansi"), "utf8");
      const copies = [...output.matchAll(/\x1b\]52;[^;]*;([A-Za-z0-9+/=]+)(?:\x07|\x1b\\)/g)].map(match => Buffer.from(match[1]!, "base64").toString("utf8"));
      await session.record("tree-preview-native-containment", {row, column, beforePointer, afterPointer, beforeSelection, afterSelection, pointerFrame, clipboardTransfers: copies});
      await session.checkpoint("tree-preview-native-drag-contained");
      await session.keys(pane, "escape");
      await session.waitFor("Tree Escape releases Preview", session.registrations, values => !values.find(c => c.clientId === independent.clientId)?.previewTarget);
      await session.closeDetached(pane);
      assert.equal((await session.client.request<Block>({action: "get", blockId: docs[2]!.id})).text, docs[2]!.text);
    }
    await session.record("preview-evidence", {current: docs[1]!.id, resourceTarget: target, canonicalUnchanged: true, composed, ansi});
  },
});
console.log(JSON.stringify(result, null, 2));
if (result.status !== "passed") process.exitCode = 1;
