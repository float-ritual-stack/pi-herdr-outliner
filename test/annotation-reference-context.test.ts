import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { annotationSourceHash, createAnnotationReferenceContext, createTextQuoteAnchor } from "../src/annotations";
import { OutlinerStore } from "../src/store";
import type { AnnotationRepresentation, AnnotationTarget, Block } from "../src/types";

const fixtures: Array<{ root: string; store: OutlinerStore }> = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function fixture(text = "References\n\nFirst use [file::same.txt].\nSecond use [file::same.txt].") {
  const root = mkdtempSync("/tmp/outliner-reference-context-");
  writeFileSync(join(root, "same.txt"), "Shared file passage\nStable second line");
  const store = new OutlinerStore(join(root, "outline.sqlite"));
  const entry = { root, store };
  fixtures.push(entry);
  const host = store.create(text);
  const resource = store.resources.internFilesystem({ path: join(root, "same.txt") }).resource;
  const file = store.resources.describe(resource.id, true).filesystem!;
  const representation: AnnotationRepresentation = {
    id: `filesystem:${resource.id}:${file.contentHash}`,
    subject: { kind: "resource", resourceId: resource.id },
    sourceSnapshot: { kind: "resource", resourceId: resource.id, sourceSnapshotId: null, revision: file.revision },
    adapter: { id: "filesystem.text", version: 1 }, mediaType: "text/plain",
    contentHash: file.contentHash, capturedAt: file.capturedAt,
  };
  const passage: AnnotationTarget = { representation, anchor: createTextQuoteAnchor(file.text, 0, 19) };
  return { entry, host, resource, passage };
}

function hostRepresentation(host: Block): AnnotationRepresentation {
  const contentHash = annotationSourceHash(host.text);
  return {
    id: `block:${host.id}:${contentHash}`, subject: { kind: "block", blockId: host.id },
    sourceSnapshot: { kind: "block", blockId: host.id, updatedAt: host.updatedAt, contentHash },
    adapter: { id: "outliner.block-text", version: 1 }, mediaType: "text/markdown",
    contentHash, capturedAt: host.updatedAt,
  };
}

function context(host: Block, start: number) {
  return { representation: hostRepresentation(host), anchor: createTextQuoteAnchor(host.text, start, start + 16), sourceText: host.text };
}

test("separate uses of one Resource retain context, global scope, replies and lifecycle after restart", () => {
  const { entry, host, resource, passage } = fixture();
  const firstTarget = { ...passage, referenceContext: context(host, host.text.indexOf("[file::")) };
  const secondTarget = { ...passage, referenceContext: context(host, host.text.lastIndexOf("[file::")) };
  const first = entry.store.createAnnotation("first", { target: firstTarget, body: "First use", source: "user" }).annotations[0]!;
  const second = entry.store.createAnnotation("second", { target: secondTarget, body: "Second use", source: "user" }).annotations[0]!;
  const global = entry.store.createAnnotation("global", { target: passage, body: "About the file", source: "user" }).annotations[0]!;
  expect(first.originalTarget).toEqual(firstTarget);
  expect(second.originalTarget).toEqual(secondTarget);
  entry.store.replyToAnnotation("reply", { annotationId: second.block.id, body: "Context reply", source: "agent" });
  entry.store.setAnnotationLifecycle({ annotationId: second.block.id, lifecycle: "resolved" }, { author: "user", actorId: "test" });
  entry.store.close();
  entry.store = new OutlinerStore(join(entry.root, "outline.sqlite"));
  const hostThreads = entry.store.listAnnotationThreads({ subject: { kind: "block", blockId: host.id }, includeResolved: true });
  expect(hostThreads.map(thread => thread.block.id).sort()).toEqual([first.block.id, second.block.id].sort());
  const resourceThreads = entry.store.listAnnotationThreads({ subject: { kind: "resource", resourceId: resource.id }, includeResolved: true });
  expect(resourceThreads).toHaveLength(3);
  expect(resourceThreads.find(thread => thread.block.id === global.block.id)!.originalTarget).toEqual(passage);
  const reopened = resourceThreads.find(thread => thread.block.id === second.block.id)!;
  expect(reopened.originalTarget).toEqual(secondTarget);
  expect(reopened.resolvedTarget).toEqual(secondTarget);
  expect(reopened.lifecycle).toBe("resolved");
  expect(reopened.replies.map(reply => reply.body)).toEqual(["Context reply"]);
  expect(entry.store.require(host.id).text).toBe(host.text);
});

test("adding the context lookup index preserves ordered block and Resource threads across repeated startup", () => {
  const { entry, host, resource, passage } = fixture();
  const referenceContext = context(host, host.text.indexOf("[file::"));
  const targets: AnnotationTarget[] = [
    { representation: hostRepresentation(host), anchor: createTextQuoteAnchor(host.text, 0, 10) },
    { ...passage, referenceContext },
    { representation: referenceContext.representation, anchor: referenceContext.anchor, referenceContext },
    passage,
  ];
  const records = targets.map((target, index) => entry.store.createAnnotation(`indexed-${index}`, {
    target, body: `Thread ${index}`, source: "user",
  }).annotations[0]!);
  const blockQuery = { subject: { kind: "block" as const, blockId: host.id }, includeResolved: true };
  const resourceQuery = { subject: { kind: "resource" as const, resourceId: resource.id }, includeResolved: true };
  const blockThreads = entry.store.listAnnotationThreads(blockQuery);
  const resourceThreads = entry.store.listAnnotationThreads(resourceQuery);
  const orderedIds = (members: typeof records) => [...members]
    .sort((left, right) => left.block.createdAt.localeCompare(right.block.createdAt) || left.block.id.localeCompare(right.block.id))
    .map(record => record.block.id);
  expect(blockThreads.map(thread => thread.block.id)).toEqual(orderedIds(records.slice(0, 3)));
  expect(resourceThreads.map(thread => thread.block.id)).toEqual(orderedIds([records[1]!, records[3]!]));

  // Simulate an existing workspace before the derived lookup index was added.
  entry.store.database.exec("DROP INDEX IF EXISTS annotation_targets_reference_context");
  for (let restart = 0; restart < 2; restart += 1) {
    entry.store.close();
    entry.store = new OutlinerStore(join(entry.root, "outline.sqlite"));
    expect(entry.store.listAnnotationThreads(blockQuery)).toEqual(blockThreads);
    expect(entry.store.listAnnotationThreads(resourceQuery)).toEqual(resourceThreads);
    expect(entry.store.require(host.id)).toEqual(host);
  }
});

test("context capture rejects stale hosts and a different canonical Resource without creating a thread", () => {
  const { entry, host, resource, passage } = fixture();
  const referenceContext = context(host, host.text.indexOf("[file::"));
  writeFileSync(join(entry.root, "other.txt"), "Shared file passage\nStable second line");
  const other = entry.store.resources.internFilesystem({ path: join(entry.root, "other.txt") }).resource;
  const otherFile = entry.store.resources.describe(other.id, true).filesystem!;
  const wrongTarget = {
    ...passage, referenceContext,
    representation: { ...passage.representation, subject: { kind: "resource" as const, resourceId: other.id },
      sourceSnapshot: { kind: "resource" as const, resourceId: other.id, sourceSnapshotId: null, revision: otherFile.revision } },
  };
  expect(() => entry.store.createAnnotation("wrong-resource", { target: wrongTarget, body: "Wrong", source: "user" }))
    .toThrow("Reference context does not resolve to the annotation Resource");
  entry.store.update(host.id, `${host.text}\nChanged`, host.revision, { author: "user", actorId: "test" });
  expect(() => entry.store.createAnnotation("stale-context", { target: { ...passage, referenceContext }, body: "Stale", source: "user" }))
    .toThrow("Reference context block snapshot is stale");
  expect(entry.store.listAnnotationThreads({ subject: { kind: "resource", resourceId: resource.id } })).toEqual([]);
  expect(entry.store.listAnnotationThreads({ subject: { kind: "resource", resourceId: other.id } })).toEqual([]);
});

test("moving identifiable reference lines reconciles host anchors without changing Resource passage evidence", () => {
  const { entry, host, passage } = fixture();
  const target = { ...passage, referenceContext: context(host, host.text.lastIndexOf("[file::")) };
  const annotation = entry.store.createAnnotation("moving-use", { target, body: "Second use", source: "user" }).annotations[0]!;
  const moved = entry.store.update(host.id, "Added heading\nSecond use [file::same.txt].\nReferences\n\nFirst use [file::same.txt].", host.revision,
    { author: "user", actorId: "test" });
  const receipt = entry.store.reconcileAnnotationThreads({ subject: { kind: "block", blockId: host.id }, newRepresentation: hostRepresentation(moved) });
  expect(receipt.changed).toBe(true);
  const after = entry.store.getAnnotation(annotation.block.id);
  expect(after.resolvedTarget?.representation).toEqual(passage.representation);
  expect(after.resolvedTarget?.anchor).toEqual(passage.anchor);
  expect(after.resolvedTarget?.referenceContext).toEqual(context(moved, 25));
  expect(after.originalTarget).toEqual(target);
  expect(after.resolutionHistory).toHaveLength(2);
  expect(entry.store.reconcileAnnotationThreads({ subject: { kind: "block", blockId: host.id }, newRepresentation: hostRepresentation(moved) }).changed).toBe(false);
});

test("context approval cannot erase scope or substitute stale evidence", () => {
  const { entry, host, passage } = fixture();
  const referenceContext = context(host, host.text.indexOf("[file::"));
  const target = { ...passage, referenceContext };
  const record = entry.store.createAnnotation("approval", { target, body: "Use here", source: "user" }).annotations[0]!;
  expect(() => entry.store.approveAnnotationResolution({ annotationId: record.block.id, target: passage }))
    .toThrow("Approved context must preserve the original host");
  entry.store.update(host.id, `${host.text}\nChanged`, host.revision, { author: "user", actorId: "test" });
  expect(() => entry.store.approveAnnotationResolution({ annotationId: record.block.id, target }))
    .toThrow("Reference context block snapshot is stale");
  expect(entry.store.getAnnotation(record.block.id).resolutionHistory).toHaveLength(1);
});

test("an occurrence-only comment works without file content and a deleted identical mention cannot inherit it", () => {
  const { entry, host } = fixture("References\n\n[file::missing.txt]\n[file::missing.txt]");
  const referenceContext = createAnnotationReferenceContext(host, 12, 31);
  const target = { representation: referenceContext.representation, anchor: referenceContext.anchor, referenceContext };
  const record = entry.store.createAnnotation("missing-file-use", { target, body: "First mention only", source: "user" }).annotations[0]!;
  expect(record.resolvedTarget).toEqual(target);
  const surviving = entry.store.update(host.id, "References\n\n[file::missing.txt]", host.revision, { author: "user", actorId: "test" });
  const receipt = entry.store.reconcileAnnotationThreads({ subject: { kind: "block", blockId: host.id }, newRepresentation: hostRepresentation(surviving) });
  expect(receipt.threads[0]!.currentResolution.status).toBe("ambiguous");
  expect(receipt.threads[0]!.resolvedTarget).toBeNull();
  expect(receipt.threads[0]!.originalTarget).toEqual(target);
});

test("observed ambiguity stays unpositioned after a duplicate is deleted until explicit reattachment", () => {
  const { entry, host, passage } = fixture();
  const target = { ...passage, referenceContext: context(host, host.text.indexOf("[file::")) };
  const record = entry.store.createAnnotation("duplicate-then-delete", { target, body: "First use", source: "user" }).annotations[0]!;
  const duplicate = entry.store.update(host.id, `${host.text}\nFirst use [file::same.txt].`, host.revision, { author: "user", actorId: "test" });
  const ambiguous = entry.store.reconcileAnnotationThreads({ subject: { kind: "block", blockId: host.id }, newRepresentation: hostRepresentation(duplicate) });
  expect(ambiguous.threads[0]!.currentResolution.status).toBe("ambiguous");
  const restored = entry.store.update(host.id, host.text, duplicate.revision, { author: "user", actorId: "test" });
  entry.store.reconcileAnnotationThreads({ subject: { kind: "block", blockId: host.id }, newRepresentation: hostRepresentation(restored) });
  entry.store.reconcileAnnotationThreads({ subject: passage.representation.subject as { kind: "resource"; resourceId: string }, newRepresentation: passage.representation });
  expect(entry.store.getAnnotation(record.block.id).resolvedTarget).toBeNull();
  const approved = entry.store.approveAnnotationResolution({ annotationId: record.block.id,
    target: { ...passage, referenceContext: context(restored, restored.text.indexOf("[file::")) } });
  expect(approved.currentResolution.status).toBe("resolved");
  expect(approved.originalTarget).toEqual(target);
  expect(approved.resolutionHistory.map(event => event.method.kind)).toEqual(["codec", "codec", "human"]);
});

test("Resource reconciliation preserves both anchors and cannot repair a deleted occurrence", () => {
  const { entry, host, resource, passage } = fixture();
  const target = { ...passage, referenceContext: context(host, host.text.indexOf("[file::")) };
  const record = entry.store.createAnnotation("file-refresh", { target, body: "Passage at first use", source: "user" }).annotations[0]!;
  writeFileSync(join(entry.root, "same.txt"), "Intro\nShared file passage\nStable second line");
  // Reading the annotation never silently substitutes a newer Resource version.
  expect(entry.store.getAnnotation(record.block.id).resolvedTarget).toEqual(target);
  const file = entry.store.resources.describe(resource.id, true).filesystem!;
  const representation: AnnotationRepresentation = {
    ...passage.representation, id: `filesystem:${resource.id}:${file.contentHash}`,
    contentHash: file.contentHash, capturedAt: file.capturedAt,
    sourceSnapshot: { kind: "resource", resourceId: resource.id, sourceSnapshotId: null, revision: file.revision },
  };
  const updated = entry.store.reconcileAnnotationThreads({ subject: { kind: "resource", resourceId: resource.id }, newRepresentation: representation });
  expect(updated.threads[0]!.resolvedTarget?.anchor).toMatchObject({ start: 6, end: 25, exact: "Shared file passage" });
  expect(updated.threads[0]!.resolvedTarget?.referenceContext).toEqual(target.referenceContext);
  expect(updated.threads[0]!.originalTarget).toEqual(target);
  const deleted = entry.store.update(host.id, "References\n\nSecond use [file::same.txt].", host.revision, { author: "user", actorId: "test" });
  const orphaned = entry.store.reconcileAnnotationThreads({ subject: { kind: "block", blockId: host.id }, newRepresentation: hostRepresentation(deleted) });
  expect(orphaned.threads[0]!.currentResolution.status).toBe("orphaned");
  expect(orphaned.threads[0]!.resolvedTarget).toBeNull();
  expect(entry.store.listAnnotationThreads({ subject: { kind: "resource", resourceId: resource.id } })[0]!.originalTarget).toEqual(target);
});

test("a locator reassigned to another Resource cannot retain the old contextual placement", () => {
  const { entry, host, resource, passage } = fixture();
  const target = { ...passage, referenceContext: context(host, host.text.indexOf("[file::")) };
  const record = entry.store.createAnnotation("relocated-resource", { target, body: "Original resource use", source: "user" }).annotations[0]!;
  entry.store.resources.relocate({ resourceId: resource.id, expectedVersion: resource.version,
    destinationSourceId: resource.sourceId, address: { kind: "filesystem", path: "relocated.txt" } });
  const replacement = entry.store.resources.internFilesystem({ path: join(entry.root, "same.txt") }).resource;
  expect(replacement.id).not.toBe(resource.id);
  entry.store.reconcileAnnotationThreads({ subject: { kind: "block", blockId: host.id }, newRepresentation: hostRepresentation(host) });
  expect(entry.store.getAnnotation(record.block.id).resolvedTarget).toBeNull();
  expect(entry.store.getAnnotation(record.block.id).originalTarget).toEqual(target);
});

test("Resource candidate acceptance rechecks its host context before automatic or human placement", () => {
  const { entry, host, resource, passage } = fixture();
  const target = { ...passage, referenceContext: context(host, host.text.indexOf("[file::")) };
  const record = entry.store.createAnnotation("candidate-context", { target, body: "Use here", source: "user" }).annotations[0]!;
  writeFileSync(join(entry.root, "same.txt"), "Changed\nShared file passage\nElsewhere\nShared file passage\nEnd");
  const file = entry.store.resources.describe(resource.id, true).filesystem!;
  const representation: AnnotationRepresentation = {
    ...passage.representation, id: `filesystem:${resource.id}:${file.contentHash}`,
    contentHash: file.contentHash, capturedAt: file.capturedAt,
    sourceSnapshot: { kind: "resource", resourceId: resource.id, sourceSnapshotId: null, revision: file.revision },
  };
  entry.store.reconcileAnnotationThreads({ subject: { kind: "resource", resourceId: resource.id }, newRepresentation: representation });
  const promptPackage = entry.store.getAnnotationAgentPackage(record.block.id);
  expect(promptPackage.candidates.length).toBeGreaterThan(0);
  const proposalInput = {
    annotationId: record.block.id, baseEventId: promptPackage.baseEventId, modelId: "test/model",
    result: { status: "reanchored" as const, candidateIndex: 0, confidence: 0.8,
      rationale: "The candidate retains the original passage.", evidence: ["Candidate 0 contains the original quote."] },
  };
  const proposal = entry.store.proposeAnnotationAgentResolution("context-review", proposalInput);
  const deleted = entry.store.update(host.id, "References\n\nSecond use [file::same.txt].", host.revision, { author: "user", actorId: "test" });
  expect(() => entry.store.proposeAnnotationAgentResolution("context-automatic", {
    ...proposalInput, result: { ...proposalInput.result, confidence: 0.99 },
  })).toThrow("Reference context block snapshot is stale");
  expect(() => entry.store.reviewAnnotationAgentResolution({ annotationId: record.block.id,
    proposalEventId: proposal.proposal.id, decision: "accept" }))
    .toThrow("Reference context block snapshot is stale");
  entry.store.reconcileAnnotationThreads({ subject: { kind: "block", blockId: host.id }, newRepresentation: hostRepresentation(deleted) });
  entry.store.update(host.id, host.text, deleted.revision, { author: "user", actorId: "test" });
  expect(() => entry.store.reviewAnnotationAgentResolution({ annotationId: record.block.id,
    proposalEventId: proposal.proposal.id, decision: "accept" }))
    .toThrow("Agent proposal is stale because the annotation resolution changed");
  expect(entry.store.getAnnotation(record.block.id).resolvedTarget).toBeNull();
});
