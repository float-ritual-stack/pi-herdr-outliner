import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { annotationSourceHash } from "../../src/annotations";
import type { InternResourceReceipt, ResourceDescription } from "../../src/resources";
import type { AnnotationThread, Block } from "../../src/types";
import { runHerdrScenario } from "./herdr-runner";

const transport = process.argv.includes("--forwarded") ? "forwarded" : "direct";
const resourceText = "# Progressive Resource\nPROVIDER PRIMARY CONTENT\nExact provider source selection.";
const result = await runHerdrScenario({
  name: `detail-progressive-${transport}`,
  async prepare(root) {
    await writeFile(join(root, "progressive.md"), resourceText);
  },
  async run(session) {
    const create = (text: string) => session.client.request<Block>({ action: "create", text, parentId: null });
    const b = await create("Progressive B\nB PRIMARY CONTENT");
    const a = await create(`Progressive A\nA PRIMARY CONTENT\n((${b.id}|Related B))`);
    const obsolete = await create(`Progressive obsolete\nOBSOLETE PRIMARY CONTENT\n((${b.id}|Related B))`);
    const failed = await create(`Progressive failure\nFAILURE PRIMARY CONTENT\n((${b.id}|Related B))`);
    const source = await create(`Progressive source\nSOURCE PRIMARY CONTENT\n((${b.id}|Related B))`);
    const file = await create("Progressive file [file::progressive.md]");
    // Resource creation is fixture setup. Reading and selecting its exact source
    // below use the real UI; the catalog must remain unchanged during those reads.
    const receipt = await session.client.request<InternResourceReceipt>({
      action: "resources.intern-filesystem", input: { path: "progressive.md" },
    });
    const identities = () => ({
      sources: session.database.query("SELECT id FROM resource_sources ORDER BY id").all(),
      resources: session.database.query("SELECT id FROM resources ORDER BY id").all(),
    });
    const baseline = identities();
    const remote = await session.openRemoteBrowsingContext({ detailTransport: transport });
    const registration = (await session.registrations()).find(client => client.runtime?.paneId === remote.detail);
    assert.ok(registration);
    const target = () => session.registrations().then(clients => clients.find(client => client.clientId === registration.clientId));
    const unlock = async () => {
      if ((await target())?.locked) {
        await session.keys(remote.detail, "i");
        await session.waitFor("Detail unlocked", target, value => value?.locked === false);
      }
    };
    const goto = async (block: Block, body: string) => {
      await unlock();
      await session.keys(remote.tree, "g");
      await session.waitVisible(remote.tree, "Goto:");
      await session.text(remote.tree, block.id);
      await session.waitFor("exact goto candidate", () => session.visible(remote.tree), frame =>
        frame.includes("Goto:") && frame.includes(block.id.slice(0, 8)));
      const started = performance.now();
      await session.keys(remote.tree, "enter");
      await session.waitVisible(remote.detail, body);
      await session.waitFor("Detail target registration", target, value =>
        value?.currentTarget?.kind === "block" && value.currentTarget.blockId === block.id);
      return performance.now() - started;
    };
    const hold = (action: "references.resolve" | "annotations.reconcile", contains: string) =>
      transport === "forwarded" ? session.holdDetailResponse({ action, contains }) : null;
    const held = async (barrier: ReturnType<typeof hold>) => {
      if (barrier) await session.waitFor("optional reply held", () => barrier.state, state => state === "held");
    };
    const read = (id: string) => session.client.request<Block>({ action: "get", blockId: id });

    const cold = hold("references.resolve", "A PRIMARY CONTENT");
    const primaryMs = await goto(a, "A PRIMARY CONTENT");
    await held(cold);
    if (cold) {
      await session.keys(remote.detail, "o");
      await session.waitVisible(remote.detail, "References are not ready");
      assert.equal(cold.state, "held");
    }
    await session.record("cold-primary", { primaryMs, transport, barrier: cold?.state,
      timingScope: "Tree goto Enter to observed primary body and exact target registration; includes host/polling overhead",
      requests: session.forwardedDetailRequests() });
    await session.checkpoint("01-primary-before-optional-reply");
    await session.keys(remote.detail, "e");
    await session.waitVisible(remote.detail, "Locked for editing");
    await session.text(remote.detail, " DRAFT-SURVIVES");
    await session.waitVisible(remote.detail, "DRAFT-SURVIVES");
    cold?.release();
    await session.keys(remote.detail, "ctrl+s");
    const saved = await session.waitFor("draft saved with exact source", () => read(a.id), value => value.text === a.text + " DRAFT-SURVIVES");
    assert.equal(saved.revision, a.revision + 1);
    await session.waitVisible(remote.detail, "e edit");
    await session.record("draft-preserved", { originalRevision: a.revision, savedRevision: saved.revision, text: saved.text });
    await session.checkpoint("02-draft-saved-after-late-reply");

    const old = hold("references.resolve", "OBSOLETE PRIMARY CONTENT");
    await goto(obsolete, "OBSOLETE PRIMARY CONTENT");
    await held(old);
    await goto(b, "B PRIMARY CONTENT");
    old?.release();
    // A subsequent real input must operate on B, regardless of late A replies.
    await session.keys(remote.detail, "v");
    await session.waitVisible(remote.detail, "extend the rendered selection");
    const bFrame = await session.visible(remote.detail);
    assert.ok(bFrame.includes("B PRIMARY CONTENT") && !bFrame.includes("OBSOLETE PRIMARY CONTENT"));
    await session.keys(remote.detail, "escape");
    await session.waitVisible(remote.detail, "e edit");
    await session.checkpoint("03-obsolete-result-rejected");

    const failure = hold("references.resolve", "FAILURE PRIMARY CONTENT");
    await goto(failed, "FAILURE PRIMARY CONTENT");
    await held(failure);
    if (failure) {
      failure.release("fixture optional read failure");
      await session.waitVisible(remote.detail, "Preview enrichment failed");
      await session.waitVisible(remote.detail, "FAILURE PRIMARY CONTENT");
      await session.checkpoint("04-optional-error-primary-retained");
      await session.keys(remote.detail, "o");
      await session.waitVisible(remote.detail, "References are not ready");
    }
    await session.keys(remote.detail, "e");
    await session.waitVisible(remote.detail, "Locked for editing");
    await session.text(remote.detail, " CANCELLED-DRAFT");
    await session.waitVisible(remote.detail, "CANCELLED-DRAFT");
    await session.keys(remote.detail, "escape");
    await session.waitVisible(remote.detail, "e edit");
    assert.equal((await read(failed.id)).text, failed.text);
    await session.checkpoint("04-failure-retains-readable-editable-content");

    const revisitMs = await goto(saved, "A PRIMARY CONTENT");
    await session.waitVisible(remote.detail, "DRAFT-SURVIVES");
    await session.keys(remote.detail, "o");
    await session.waitVisible(remote.detail, "Choose destination");
    await session.keys(remote.detail, "escape");
    await session.record("cached-revisit", { revisitMs, requests: session.forwardedDetailRequests() });

    const selection = hold("references.resolve", "SOURCE PRIMARY CONTENT");
    await goto(source, "SOURCE PRIMARY CONTENT");
    await held(selection);
    await session.keys(remote.detail, "v");
    await session.waitVisible(remote.detail, "extend the rendered selection");
    await session.keys(remote.detail, "alt+a");
    selection?.release();
    await session.keys(remote.detail, "c");
    await session.waitVisible(remote.detail, "Comment on selection");
    await session.text(remote.detail, "COMMENT EXACT SOURCE");
    await session.keys(remote.detail, "ctrl+s");
    const annotations = await session.waitFor("exact source annotation", () => session.client.request<AnnotationThread[]>({
      action: "annotations.list", query: { subject: { kind: "block", blockId: source.id } },
    }), values => values.some(value => value.body === "COMMENT EXACT SOURCE"));
    const annotation = annotations.find(value => value.body === "COMMENT EXACT SOURCE")!;
    const anchor = annotation.originalTarget.anchor;
    assert.equal(anchor.kind, "text-quote");
    if (anchor.kind !== "text-quote") throw new Error("Expected source quote");
    assert.equal(anchor.start, 0);
    assert.equal(anchor.end, source.text.length);
    assert.equal(anchor.exact, source.text);
    assert.equal(annotation.originalTarget.representation.contentHash, annotationSourceHash(source.text));
    await session.record("canonical-source-selection", annotation.originalTarget);
    await session.waitVisible(remote.detail, "e edit");
    await session.checkpoint("05-source-coordinates-survive-enrichment");

    await goto(file, "PROVIDER PRIMARY CONTENT");
    const resourceBarrier = hold("annotations.reconcile", receipt.resource.id);
    await session.keys(remote.tree, "?");
    await session.waitVisible(remote.tree, "Find:");
    await session.text(remote.tree, "Show authored links");
    await session.waitVisible(remote.tree, "Show or hide this block");
    await session.keys(remote.tree, "enter");
    await session.keys(remote.tree, "down");
    await session.waitVisible(remote.tree, "1 authored Resources");
    await session.keys(remote.tree, "down");
    await session.keys(remote.tree, "enter");
    await session.waitFor("provider Resource selected", target, value =>
      value?.currentTarget?.kind === "resource" && value.currentTarget.resourceId === receipt.resource.id);
    await held(resourceBarrier);
    await session.waitVisible(remote.detail, "PROVIDER PRIMARY CONTENT");
    await session.record("provider-primary-before-annotations", { barrier: resourceBarrier?.state, resourceId: receipt.resource.id });
    await session.checkpoint("06-provider-primary-before-annotations");
    await session.keys(remote.detail, "v");
    await session.waitVisible(remote.detail, "extend the rendered selection");
    await session.keys(remote.detail, "alt+a");
    resourceBarrier?.release();
    await session.keys(remote.detail, "c");
    await session.waitVisible(remote.detail, "Comment on Resource selection");
    await session.text(remote.detail, "COMMENT EXACT RESOURCE");
    await session.keys(remote.detail, "ctrl+s");
    const threads = await session.waitFor("provider annotation", () => session.client.request<AnnotationThread[]>({
      action: "annotations.list", query: { subject: { kind: "resource", resourceId: receipt.resource.id } },
    }), values => values.some(value => value.body === "COMMENT EXACT RESOURCE"));
    const resourceTarget = threads.find(value => value.body === "COMMENT EXACT RESOURCE")!.originalTarget;
    assert.equal(resourceTarget.anchor.kind, "text-quote");
    if (resourceTarget.anchor.kind !== "text-quote") throw new Error("Expected Resource quote");
    assert.equal(resourceTarget.anchor.exact, resourceText);
    assert.equal(resourceTarget.anchor.start, 0);
    assert.equal(resourceTarget.anchor.end, resourceText.length);
    const description = await session.client.request<ResourceDescription>({
      action: "resources.describe", target: { kind: "resource", resourceId: receipt.resource.id }, destinationClientId: registration.clientId,
    });
    assert.equal(resourceTarget.representation.sourceSnapshot.kind, "resource");
    if (resourceTarget.representation.sourceSnapshot.kind !== "resource") throw new Error("Expected Resource snapshot");
    assert.deepEqual(resourceTarget.representation.sourceSnapshot.revision, description.filesystem!.revision);
    assert.equal(resourceTarget.representation.contentHash, description.filesystem!.contentHash);
    assert.deepEqual(identities(), baseline);
    await session.record("provider-representation", { resourceTarget, baseline, after: identities() });
    await session.checkpoint("06-provider-primary-and-exact-annotation");
    await session.record("detail-requests", { transport, requests: session.forwardedDetailRequests(),
      requestObservation: transport === "forwarded" ? "all requests from the remote Detail proxy" : "direct requests are not instrumented",
      limitations: "same-host private direct/forwarded sockets; no two-host SSH, host mouse, or OSC 8 click claim" });
  },
});
process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.status === "failed") process.exitCode = 1;
