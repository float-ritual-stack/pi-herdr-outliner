import assert from "node:assert/strict";
import {visibleWidth} from "@earendil-works/pi-tui";
import type {Block, NavigationLinkState, OutlinerClientRegistration} from "../../src/types";
import {runHerdrScenario} from "./herdr-runner";

const composed = process.argv.includes("--composed");
const result = await runHerdrScenario({
  name: `navigation-flow${composed ? "-composed" : ""}`,
  layout: composed ? "composed" : "separate",
  async prepare() {},
  async run(s) {
    const terminal = await s.attachClient();
    await terminal.resize(composed ? 600 : 360, 62);
    const original = await s.registrations();
    const tree = original.find(c => c.runtime?.paneId === s.panes.tree && c.role === (composed ? "composed" : "tree"))!;
    const detail = original.find(c => c.runtime?.paneId === s.panes.detail && c.role === (composed ? "composed" : "detail"))!;
    assert.ok(tree && detail);
    const create = (text: string) => s.client.request<Block>({action: "create", text});
    const current = await create("FIRST CURRENT NOTE\n\nFirst reader retained body.\n\n[status::open]");
    const secondDoc = await create("SECOND CURRENT NOTE\n\nSecond reader retained body.");
    const inspection = await create("TREE INSPECTION NOTE\n\n# Rich local heading\n\nPASSIVE TREE PREVIEW BODY\n\n- A rich list item");
    const nextInspection = await create("NEXT TREE INSPECTION\n\nSECOND PASSIVE PREVIEW BODY");
    const registration = async (clientId: string) => (await s.registrations()).find(c => c.clientId === clientId)!;
    const isCurrent = (c: OutlinerClientRegistration, id: string) => c.currentTarget?.kind === "block" && c.currentTarget.blockId === id;
    const isPreview = (c: OutlinerClientRegistration, id: string) => c.previewTarget?.kind === "block" && c.previewTarget.blockId === id;
    const focus = async (region: "tree" | "detail") => {
      await s.focus(region === "tree" ? s.panes.tree : s.panes.detail);
      if (composed && (await registration(tree.clientId)).focusedRegion !== region) {
        await s.client.request({action: "ui.command.send", command: {command: "focus", targetClientId: tree.clientId, targetRegion: region}});
        await s.waitFor("composed region focused", () => registration(tree.clientId), c => c.focusedRegion === region);
      }
    };
    const link = (source: "tree" | "detail", clientId = source === "tree" ? tree.clientId : detail.clientId) => s.client.request<NavigationLinkState>({action: "navigation.link.get", source: {clientId, region: source}});
    const finishChoice = async (pane: string, source: "tree" | "detail", query: string, expected: string | null, sourceClientId?: string) => {
      await s.waitVisible(pane, "Link destination");
      await s.text(pane, query);
      await s.waitVisible(pane, `Find: ${query}`);
      await s.keys(pane, "enter");
      await s.waitFor("chosen link stored", () => link(source, sourceClientId), value => (value.destination?.clientId ?? null) === expected);
      await s.waitFor("picker closed", () => s.visible(pane), frame => !frame.includes("Link destination ·"));
    };
    // Header clicks use the attached native terminal, including pane offsets.
    const clickLinkHeader = async (pane: string, destinationTitle: string) => {
      await s.focus(pane);
      // Composed Tree headers may truncate the title; a unique visible prefix
      // identifies the same logical destination without assuming pane width.
      const label = `Opens in: ${destinationTitle.slice(0, 9)}`;
      const frame = await s.waitFor("persistent link header", terminal.visible, text => text.includes(label));
      const rows = frame.split("\n");
      const row = rows.findIndex(line => line.includes(label));
      assert.ok(row >= 0, `Native frame contains ${label}`);
      const column = visibleWidth(rows[row]!.slice(0, rows[row]!.indexOf(label))) + 3;
      await s.record("native-link-header", {pane, row, column, frame});
      await terminal.write(`\x1b[<0;${column + 1};${row + 1}M\x1b[<0;${column + 1};${row + 1}m`);
      await s.waitVisible(pane, "Link destination");
    };

    await s.revealTree(s.panes.tree, current.id);
    await focus("tree"); await s.keys(s.panes.tree, "enter");
    await s.waitFor("initial linked Current", () => registration(detail.clientId), c => isCurrent(c, current.id));
    await focus("detail"); await s.keys(s.panes.detail, "alt+shift+right");
    const added = await s.waitFor("second smaller Detail", s.registrations, values => values.some(c => c.role === "detail" && !original.some(old => old.clientId === c.clientId)));
    const second = added.find(c => c.role === "detail" && !original.some(old => old.clientId === c.clientId))!;
    const secondPane = await s.adoptDetached(second.clientId, "detail");
    await s.client.request({action: "ui.command.send", command: {command: "open", targetClientId: second.clientId, target: {kind: "block", blockId: secondDoc.id}}});
    await s.waitVisible(secondPane, "Second reader retained body.");
    const beforePassive = {first: await registration(detail.clientId), second: await registration(second.clientId)};
    await s.revealTree(s.panes.tree, inspection.id);
    await s.waitFor("source-local Preview identity", () => registration(tree.clientId), c => isPreview(c, inspection.id));
    if (composed) {
      await focus("detail"); await s.keys(s.panes.detail, "alt+p");
      await s.waitVisible(s.panes.detail, "PASSIVE TREE PREVIEW BODY");
    } else {
      const frame = await s.waitFor("rich Preview beside wide Tree", () => s.visible(s.panes.tree), text => text.split("\n").some(line => line.includes("PASSIVE TREE PREVIEW BODY") && !line.includes("↵")));
      assert.ok(frame.includes("Rich local heading") && frame.includes("A rich list item"));
      const first = await registration(detail.clientId);
      assert.deepEqual(first.previewTarget, beforePassive.first.previewTarget, "Passive standalone Tree navigation must not alter Detail Preview");
      assert.deepEqual(first.currentTarget, beforePassive.first.currentTarget);
    }
    const secondAfter = await registration(second.clientId);
    assert.deepEqual(secondAfter.currentTarget, beforePassive.second.currentTarget);
    assert.deepEqual(secondAfter.previewTarget, beforePassive.second.previewTarget);
    await s.checkpoint("01-local-preview-with-two-details");

    await focus("tree"); await s.keys(s.panes.tree, "shift+l");
    await finishChoice(s.panes.tree, "tree", "SECOND CURRENT", second.clientId);
    await s.revealTree(s.panes.tree, nextInspection.id);
    await s.waitFor("Preview follows selection independently of link", () => registration(tree.clientId), c => isPreview(c, nextInspection.id));
    assert.ok(isCurrent(await registration(second.clientId), secondDoc.id), "Changing a link does not send passive Preview to the destination");
    await focus("tree"); await s.keys(s.panes.tree, "enter");
    await s.waitFor("explicit Open follows changed link", () => registration(second.clientId), c => isCurrent(c, nextInspection.id));
    assert.ok(isCurrent(await registration(detail.clientId), current.id));
    await s.checkpoint("02-explicit-open-follows-link");

    await focus("tree"); await clickLinkHeader(s.panes.tree, "NEXT TREE INSPECTION");
    await finishChoice(s.panes.tree, "tree", "Unlink destination", null);
    await s.keys(s.panes.tree, "shift+l");
    await finishChoice(s.panes.tree, "tree", "FIRST CURRENT", detail.clientId);
    await focus("detail"); await s.keys(s.panes.detail, "shift+l");
    await finishChoice(s.panes.detail, "detail", "NEXT TREE INSPECTION", second.clientId);
    await s.waitVisible(s.panes.detail, "Opens in: NEXT TREE INSPECTION");
    await clickLinkHeader(s.panes.detail, "NEXT TREE INSPECTION");
    await finishChoice(s.panes.detail, "detail", "Unlink destination", null);
    await s.waitVisible(s.panes.detail, "Opens in: Not linked");
    await s.checkpoint("03-link-headers-change-and-unlink");

    // Dedicated Properties has the same reader-level link entry point.
    await focus("detail");
    const beforeProperties = await s.registrations();
    await s.keys(s.panes.detail, "shift+p");
    const propertiesClients = await s.waitFor("dedicated Properties reader", s.registrations, values => values.some(c => c.role === "detail" && !beforeProperties.some(old => old.clientId === c.clientId)));
    const properties = propertiesClients.find(c => c.role === "detail" && !beforeProperties.some(old => old.clientId === c.clientId))!;
    const propertiesPane = await s.adoptDetached(properties.clientId, "detail");
    await s.waitVisible(propertiesPane, "Properties");
    await s.focus(propertiesPane); await s.keys(propertiesPane, "shift+l");
    await finishChoice(propertiesPane, "detail", "NEXT TREE INSPECTION", second.clientId, properties.clientId);
    await s.checkpoint("04-properties-link-entry-point");
    for (const doc of [current, secondDoc, inspection, nextInspection]) {
      const after = await s.client.request<Block>({action: "get", blockId: doc.id});
      assert.equal(after.text, doc.text); assert.equal(after.revision, doc.revision);
    }
    await s.record("navigation-flow-evidence", {composed, tree: tree.clientId, detail: detail.clientId, second: second.clientId, properties: properties.clientId, canonicalUnchanged: true});
    await s.closeDetached(propertiesPane); await s.closeDetached(secondPane);
  },
});
console.log(JSON.stringify(result, null, 2));
if (result.status !== "passed") process.exitCode = 1;
