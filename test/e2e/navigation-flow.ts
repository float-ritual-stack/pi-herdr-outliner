import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {promisify} from "node:util";
import {openDetailSidebar} from "../../src/sidebar-placement";
import {visibleWidth} from "@earendil-works/pi-tui";
import {outlinerLinkUri} from "../../src/outliner-links";
import type {Block, NavigationLinkState, OutlinerClientRegistration} from "../../src/types";
import {runHerdrScenario} from "./herdr-runner";

type Rect = {x: number; y: number; width: number; height: number};
type NativeSnapshot = {
  panes: Array<{pane_id: string; terminal_id: string; tab_id: string}>;
  layouts: Array<{tab_id: string; area: Rect; panes: Array<{pane_id: string; rect: Rect}>}>;
};
const composed = process.argv.includes("--composed");
const result = await runHerdrScenario({
  name: `navigation-flow${composed ? "-composed" : ""}`,
  layout: composed ? "composed" : "separate",
  async prepare(root) {
    await writeFile(join(root, "view-events.txt"), Array.from({length: 60}, (_, index) => `VIEW EVENT LINE ${index + 1}`).join("\n"));
  },
  async run(s) {
    const terminal = await s.attachClient();
    await terminal.resize(composed ? 600 : 360, 62);
    const original = await s.registrations();
    const tree = original.find(c => c.runtime?.paneId === s.panes.tree && c.role === (composed ? "composed" : "tree"))!;
    const detail = original.find(c => c.runtime?.paneId === s.panes.detail && c.role === (composed ? "composed" : "detail"))!;
    assert.ok(tree && detail);
    const create = (text: string) => s.client.request<Block>({action: "create", text});
    const followed = await create("FOLLOWED THROUGH NEW SIDEBAR\n\nNEW SIDEBAR LINK ACTIVATION PROOF");
    const current = await create(`FIRST CURRENT NOTE\n\nFirst reader retained body.\n\n[Open linked proof](${outlinerLinkUri("block", followed.id)})\n\n[status::open]`);
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
    assert.equal((await link("detail")).destination, null, "Ordinary split commands keep the invoking Detail unlinked");
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
    await s.closeDetached(propertiesPane);
    if (composed) {
      const before = await s.registrations();
      const treeLink = (await link("tree")).destination;
      await focus("detail"); await s.keys(s.panes.detail, "shift+l");
      await s.waitVisible(s.panes.detail, "Link destination");
      await s.text(s.panes.detail, "New Detail right");
      await s.waitVisible(s.panes.detail, "Find: New Detail right");
      await s.keys(s.panes.detail, "enter");
      const withCreated = await s.waitFor("composed Detail creates linked reader", s.registrations, values => values.some(c => c.role === "detail" && !!c.runtime?.paneId && !before.some(old => old.clientId === c.clientId)));
      const created = withCreated.find(c => c.role === "detail" && !before.some(old => old.clientId === c.clientId))!;
      const pane = await s.adoptDetached(created.clientId, "detail");
      await s.waitFor("composed Detail source linked", () => link("detail"), state => state.destination?.clientId === created.clientId);
      assert.deepEqual((await link("tree")).destination, treeLink, "Composed Tree has a separate saved link");
      assert.equal((await link("detail", created.clientId)).destination, null);
      await s.waitFor("created reader retained invoking Current", () => registration(created.clientId), c => isCurrent(c, current.id));
      await focus("tree"); await s.keys(s.panes.tree, "enter");
      await s.waitFor("Tree still opens into composed Detail", () => registration(detail.clientId), c => isCurrent(c, nextInspection.id));
      assert.ok(isCurrent(await registration(created.clientId), current.id), "Receiving a Tree open must not forward it through Detail's new link");
      await s.checkpoint("05-composed-source-specific-created-link");
      await s.closeDetached(pane);
    }
    if (!composed) {
      // This bounded native oracle is pinned to the fixture's private socket/session.
      const isolation = JSON.parse(await readFile(join(s.artifactDirectory, "isolation.json"), "utf8")) as {runRoot: string; sessionName: string; effectiveEnvironment: Record<string, string>};
      const readiness = JSON.parse(await readFile(join(s.artifactDirectory, "herdr-readiness.json"), "utf8")) as {status: {session: string; socket: string}};
      assert.equal(readiness.status.session, isolation.sessionName);
      assert.ok(readiness.status.socket.startsWith(`${isolation.runRoot}/`));
      const execute = promisify(execFile);
      const native = async (args: string[]): Promise<unknown> => {
        const {stdout} = await execute(isolation.effectiveEnvironment.HERDR_BIN_PATH!, ["--session", isolation.sessionName, ...args], {
          env: {...process.env, ...isolation.effectiveEnvironment}, timeout: 5000, maxBuffer: 1024 * 1024,
        });
        return stdout.trim() ? JSON.parse(stdout) : undefined;
      };
      const status = await native(["status", "server", "--json"]) as {session: string; socket: string};
      assert.equal(status.session, readiness.status.session);
      assert.equal(status.socket, readiness.status.socket);
      await s.record("placement-native-provenance", status);
      const snapshot = async () => (await native(["api", "snapshot"]) as {result: {snapshot: NativeSnapshot}}).result.snapshot;
      const layout = (state: NativeSnapshot) => state.layouts.find(item => item.panes.some(p => p.pane_id === s.panes.tree))!;
      const rect = (state: NativeSnapshot, pane: string) => layout(state).panes.find(p => p.pane_id === pane)!.rect;
      const identities = (state: NativeSnapshot) => state.panes.map(p => [p.pane_id, p.terminal_id]).sort();
      const sameOldTerminals = (before: NativeSnapshot, after: NativeSnapshot) => {
        for (const pane of before.panes) assert.equal(after.panes.find(p => p.pane_id === pane.pane_id)?.terminal_id, pane.terminal_id, `Existing PTY ${pane.pane_id} survives placement`);
      };
      const chooseAction = async (source: "tree" | "detail", query: string) => {
        const pane = source === "tree" ? s.panes.tree : s.panes.detail;
        await focus(source); await s.keys(pane, "shift+l"); await s.waitVisible(pane, "Link destination");
        await s.text(pane, query); await s.waitVisible(pane, `Find: ${query}`); await s.keys(pane, "enter");
      };
      // Seed live previous destinations so creation must replace only its source
      // link, while cancellation and failed creation must preserve the old link.
      await focus("detail"); await s.keys(s.panes.detail, "shift+l");
      await finishChoice(s.panes.detail, "detail", "NEXT TREE INSPECTION", second.clientId);
      const baselineLinks = {tree: (await link("tree")).destination, detail: (await link("detail")).destination};
      const assertLinks = async () => {
        assert.deepEqual((await link("tree")).destination, baselineLinks.tree);
        assert.deepEqual((await link("detail")).destination, baselineLinks.detail);
      };
      for (const source of ["tree", "detail"] as const) {
        const beforeCancel = await snapshot();
        await chooseAction(source, "New Detail right of another");
        const pane = source === "tree" ? s.panes.tree : s.panes.detail;
        await s.waitVisible(pane, "New Detail placement");
        await s.keys(pane, "escape");
        await s.waitFor("placement cancelled", () => s.visible(pane), frame => !frame.includes("New Detail placement"));
        await assertLinks();
        assert.deepEqual(identities(await snapshot()), identities(beforeCancel));
      }
      await s.checkpoint("05-cancel-keeps-existing-links");
      const beforeFailure = await snapshot();
      const failureClients = await s.registrations();
      const vanishedAnchor = await create("TEMP PLACEMENT ANCHOR");
      await focus("detail"); await s.keys(s.panes.detail, "alt+shift+right");
      const anchorClients = await s.waitFor("temporary placement anchor", s.registrations, values => values.some(c => c.role === "detail" && !!c.runtime?.paneId && !failureClients.some(old => old.clientId === c.clientId)));
      const anchorClient = anchorClients.find(c => c.role === "detail" && !failureClients.some(old => old.clientId === c.clientId))!;
      const anchorPane = await s.adoptDetached(anchorClient.clientId, "detail");
      await s.client.request({action: "ui.command.send", command: {command: "open", targetClientId: anchorClient.clientId, target: {kind: "block", blockId: vanishedAnchor.id}}});
      await s.waitVisible(anchorPane, "TEMP PLACEMENT ANCHOR");
      await assertLinks();
      await chooseAction("tree", "New Detail right of another");
      await s.waitVisible(s.panes.tree, "New Detail placement");
      await s.text(s.panes.tree, "TEMP PLACEMENT ANCHOR");
      await s.waitVisible(s.panes.tree, "Find: TEMP PLACEMENT ANCHOR");
      await s.closeDetached(anchorPane);
      await s.waitFor("chosen anchor gone", s.registrations, values => !values.some(c => c.clientId === anchorClient.clientId));
      await s.keys(s.panes.tree, "enter");
      const failedFrame = await s.waitFor("unavailable anchor failure reported", () => s.visible(s.panes.tree), frame => !frame.includes("New Detail placement") && !frame.includes("Creating Detail") && frame.split("\n").some(line => !line.includes("Inbox unavailable") && /not found|not exist|failed|unavailable|not.*live/i.test(line)));
      await assertLinks();
      assert.deepEqual(identities(await snapshot()), identities(beforeFailure), "Failed creation leaves the original panes intact");
      await s.record("failed-creation-keeps-link", {frame: failedFrame, previousLinks: baselineLinks});
      await s.checkpoint("05-failed-creation-keeps-existing-link");
      const placementCases = [
        {source: "tree", label: "New Detail right", direction: "right", anchor: "source"},
        {source: "detail", label: "New Detail below", direction: "down", anchor: "source"},
        {source: "tree", label: "New Detail right of another", direction: "right", anchor: "other"},
        {source: "detail", label: "New Detail below another", direction: "down", anchor: "other"},
        {source: "detail", label: "Sidebar left · Outliner area", side: "left", scope: "outliner"},
        {source: "tree", label: "Sidebar right · Outliner area", side: "right", scope: "outliner"},
        {source: "tree", label: "Sidebar left · Whole Herdr tab", side: "left", scope: "tab"},
        {source: "detail", label: "Sidebar right · Whole Herdr tab", side: "right", scope: "tab"},
      ] as const;
      for (const [index, placement] of placementCases.entries()) {
        const before = await snapshot();
        const beforeClients = await s.registrations();
        const sourceClient = placement.source === "tree" ? tree : detail;
        const sourceBefore = await registration(sourceClient.clientId);
        await chooseAction(placement.source, placement.label);
        if ("direction" in placement && placement.anchor === "other") {
          const pane = placement.source === "tree" ? s.panes.tree : s.panes.detail;
          await s.waitVisible(pane, "New Detail placement");
          await s.text(pane, "NEXT TREE INSPECTION");
          await s.waitVisible(pane, "Find: NEXT TREE INSPECTION");
          await s.keys(pane, "enter");
        }
        const withNew = await s.waitFor("placed Detail has native pane identity", s.registrations, values => {
          const primary = values.find(c => c.clientId === tree.clientId);
          return !!primary?.runtime?.workspaceId && values.some(c => c.role === "detail" && !!c.runtime?.paneId && c.runtime.workspaceId === primary.runtime?.workspaceId && !beforeClients.some(old => old.clientId === c.clientId));
        });
        const created = withNew.find(c => c.role === "detail" && !beforeClients.some(old => old.clientId === c.clientId))!;
        const pane = await s.adoptDetached(created.clientId, "detail");
        const after = await s.waitFor("native placement completed", snapshot, value => value.panes.length === before.panes.length + 1 && layout(value).panes.length === layout(before).panes.length + 1);
        sameOldTerminals(before, after);
        const placed = rect(after, pane);
        if ("direction" in placement) {
          const anchorPane = placement.anchor === "other" ? secondPane : placement.source === "tree" ? s.panes.tree : s.panes.detail;
          const oldAnchor = rect(before, anchorPane), anchor = rect(after, anchorPane);
          assert.equal(placement.direction === "right" ? placed.x : placed.y, placement.direction === "right" ? anchor.x + anchor.width : anchor.y + anchor.height);
          assert.equal(placed.x + placed.width, oldAnchor.x + oldAnchor.width);
          assert.equal(placed.y + placed.height, oldAnchor.y + oldAnchor.height);
          for (const old of layout(before).panes.filter(p => p.pane_id !== anchorPane)) assert.deepEqual(rect(after, old.pane_id), old.rect);
        } else {
          const area = placement.scope === "tab" ? layout(before).area : {
            x: Math.min(...layout(before).panes.filter(p => p.pane_id !== s.panes.launcher).map(p => p.rect.x)),
            y: layout(before).area.y,
            width: layout(before).area.width - rect(before, s.panes.launcher).width,
            height: layout(before).area.height,
          };
          assert.equal(placed.y, area.y); assert.equal(placed.height, area.height);
          assert.equal(placement.side === "left" ? placed.x : placed.x + placed.width, placement.side === "left" ? area.x : area.x + area.width);
          if (placement.scope === "outliner") assert.deepEqual(rect(after, s.panes.launcher), rect(before, s.panes.launcher), "Unrelated launcher geometry is untouched by Outliner-only placement");
        }
        await s.waitFor("new reader retains invoking target", () => registration(created.clientId), c => isCurrent(c, placement.source === "tree" ? nextInspection.id : current.id));
        await s.waitVisible(pane, placement.source === "tree" ? "SECOND PASSIVE PREVIEW BODY" : "First reader retained body.");
        const sourceAfter = await registration(sourceClient.clientId);
        assert.deepEqual(sourceAfter.currentTarget, sourceBefore.currentTarget);
        assert.deepEqual(sourceAfter.previewTarget, sourceBefore.previewTarget);
        await s.waitFor("creation links its invoking source", () => link(placement.source), state => state.destination?.clientId === created.clientId);
        const otherSource = placement.source === "tree" ? "detail" : "tree";
        assert.deepEqual((await link(otherSource)).destination, baselineLinks[otherSource], "Other saved links stay unchanged");
        assert.equal((await link("detail", second.clientId)).destination, null);
        assert.equal((await link("detail", created.clientId)).destination, null, "Creation must not install a reverse link");
        if (placement.source === "detail" && "scope" in placement && placement.scope === "outliner" && placement.side === "left") {
          // Both panes initially display this source. The original reader is the
          // lower pane beneath Tree; click its authored link, not the sidebar copy.
          await focus("detail");
          await s.waitVisible(s.panes.detail, "Open linked proof");
          const frame = await s.waitFor("original Detail authored link visible", terminal.visible, text => text.split("\n").filter(line => line.includes("Open linked proof")).length >= 2);
          const rows = frame.split("\n");
          const row = rows.reduce((last, line, index) => line.includes("Open linked proof") ? index : last, -1);
          assert.ok(row >= rect(after, s.panes.detail).y);
          const column = visibleWidth(rows[row]!.slice(0, rows[row]!.indexOf("Open linked proof"))) + 3;
          await terminal.write(`\x1b[<0;${column + 1};${row + 1}M\x1b[<0;${column + 1};${row + 1}m`);
          await s.waitFor("original Detail link opens new sidebar", () => registration(created.clientId), c => isCurrent(c, followed.id));
          await s.waitVisible(pane, "NEW SIDEBAR LINK ACTIVATION PROOF");
          assert.ok(isCurrent(await registration(detail.clientId), current.id), "Original Detail retains its document");
          assert.ok(isCurrent(await registration(second.clientId), nextInspection.id), "Prior destination receives no open");
          await s.record("original-detail-link-opens-new-sidebar", {source: detail.clientId, destination: created.clientId, target: followed.id, row, column, frame});
        }
        await s.record(`placement-${index}`, {placement, before, after, created: created.clientId, pane, sourceBefore, sourceAfter});
        await s.checkpoint(`05-placement-${index}`);
        await s.closeDetached(pane);
        await s.waitFor("created reader unregistered", s.registrations, values => !values.some(c => c.clientId === created.clientId));
        const restored = await s.waitFor("placement removal restores pane set", snapshot, value => value.panes.length === before.panes.length);
        assert.deepEqual(identities(restored), identities(before));
        for (const old of layout(before).panes) assert.deepEqual(rect(restored, old.pane_id), old.rect);
        // Reset only after the creation/link/activation assertions and close, so
        // the next isolated case starts from the same live previous destination.
        await s.client.request({action: "navigation.link.set", source: {clientId: sourceClient.clientId, region: placement.source}, destination: baselineLinks[placement.source]});
      }
      // Exercise real host rollback after the existing Outliner leaves are parked.
      // Only the create callback fails; no user pane or global server is involved.
      const beforeRecovery = await snapshot();
      let rejectedCreation = false;
      await assert.rejects(openDetailSidebar({sourcePaneId: s.panes.tree,
        outlinerPaneIds: [s.panes.tree, s.panes.detail, secondPane], scope: "outliner", side: "left",
        async createDetail() { rejectedCreation = true; throw new Error("Injected private fixture creation failure"); },
      }, native), /original layout restored/);
      assert.ok(rejectedCreation, "Failure occurs after native layout parking, not during preflight");
      const recovered = await snapshot();
      assert.deepEqual(identities(recovered), identities(beforeRecovery));
      for (const old of layout(beforeRecovery).panes) assert.deepEqual(rect(recovered, old.pane_id), old.rect);
      await assertLinks();
      await s.record("sidebar-recovery", {before: beforeRecovery, after: recovered});
      await s.checkpoint("06-sidebar-recovery");

      // A link/header event must not reload the file beneath an active selection.
      const selectionDoc = await create("VIEW EVENT FILE [file::view-events.txt]");
      await s.client.request({action: "ui.command.send", command: {command: "open", targetClientId: detail.clientId, target: {kind: "block", blockId: selectionDoc.id}}});
      await s.waitFor("file source opened", () => registration(detail.clientId), c => isCurrent(c, selectionDoc.id));
      await focus("detail"); await s.keys(s.panes.detail, "f");
      await s.waitVisible(s.panes.detail, "VIEW EVENT LINE 1");
      await s.keys(s.panes.detail, "v", "shift+g");
      const selectedEnd = (frame: string) => />\s*60\s+│\s+VIEW EVENT LINE 60/.test(frame);
      const selectionBefore = await s.waitFor("file selection scrolled to line60", () => s.visible(s.panes.detail), selectedEnd);
      await s.keys(s.panes.detail, "shift+l");
      await finishChoice(s.panes.detail, "detail", "VIEW EVENT FILE", detail.clientId);
      await s.waitVisible(s.panes.detail, "Opens in: VIEW EVENT FILE");
      const selectionAfter = await s.waitFor("selection retained after link event", () => s.visible(s.panes.detail), selectedEnd);
      await s.keys(s.panes.detail, "c");
      await s.waitVisible(s.panes.detail, "view-events.txt:1-60");
      await s.record("file-selection-survives-link-event", {selectionBefore, selectionAfter, source: selectionDoc.id});
      await s.checkpoint("07-link-event-preserves-file-selection");
      await s.keys(s.panes.detail, "escape");
      assert.equal((await s.client.request<Block>({action: "get", blockId: selectionDoc.id})).text, selectionDoc.text);

    }
    await s.closeDetached(secondPane);
  },
});
console.log(JSON.stringify(result, null, 2));
if (result.status !== "passed") process.exitCode = 1;
