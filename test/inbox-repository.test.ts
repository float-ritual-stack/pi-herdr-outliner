import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { annotationSourceHash, createAnnotationReferenceContext, createTextQuoteAnchor } from "../src/annotations";
import { InboxRepository } from "../src/inbox-repository";
import type { InboxPlan, InboxUsage } from "../src/inbox-types";
import { NoteAssistanceRepository } from "../src/note-assistance-repository";
import type { NotePlan } from "../src/note-assistance-types";
import { OutlinerStore } from "../src/store";
import type { Block } from "../src/types";

const fixtures: Array<{ store: OutlinerStore; directory: string }> = [];

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "outliner-inbox-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  fixtures.push({ store, directory });
  store.configureWorkIdPrefix("PIE");
  const workQueue = store.create("Work [type::work-queue] [project::test]");
  const inbox = store.queryBlocks({ filters: [{ key: "system-view", value: "inbox" }], limit: 10 }).blocks[0]!;
  return { store, repository: new InboxRepository(store), inbox, workQueue };
}

function restart(store: OutlinerStore) {
  const entry = fixtures.find(entry => entry.store === store)!;
  store.close();
  entry.store = new OutlinerStore(join(entry.directory, "outliner.sqlite"));
  return { store: entry.store, repository: new InboxRepository(entry.store) };
}

function capture(store: OutlinerStore, value = "My rough idea\n\nThe original detail remains recoverable.") {
  return store.capture(crypto.randomUUID(), value, "cli").block;
}

function plan(changes: Partial<InboxPlan> = {}): InboxPlan {
  return {
    summary: "Filed a clearer note.",
    source: { disposition: "file", text: "A clear note\n\nAn edited explanation." },
    notes: [], tasks: [], updates: [], ...changes,
  };
}

const task = { title: "Build a useful thing", body: "Observable outcome and acceptance.", priority: "medium" as const, project: "test", arc: "workflow", tracks: ["workflow"] };
const usage: InboxUsage = { provider: "test", model: "test", inputTokens: 12, outputTokens: 8, cost: 0.002, jevCalls: 1, elapsedMs: 100 };

function folder(store: OutlinerStore, kind: string) {
  return store.queryBlocks({ filters: [{ key: "inbox-folder", value: kind }], limit: 10 }).blocks;
}

function annotate(store: OutlinerStore, source: Block) {
  const contentHash = annotationSourceHash(source.text);
  return store.createAnnotation(crypto.randomUUID(), {
    body: "Keep the original evidence.", source: "user",
    target: {
      representation: {
        id: crypto.randomUUID(), subject: { kind: "block", blockId: source.id },
        sourceSnapshot: { kind: "block", blockId: source.id, updatedAt: source.updatedAt, contentHash },
        adapter: null, mediaType: "text/plain", contentHash, capturedAt: source.updatedAt,
      },
      anchor: createTextQuoteAnchor(source.text, 0, 2),
    },
  }, "user").annotations[0]!;
}

afterEach(() => {
  for (const { store, directory } of fixtures.splice(0)) {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("InboxRepository", () => {
  test("derives pending work from direct Inbox notes without creating folders or touching unrelated notes", () => {
    const { store, repository, inbox } = fixture();
    const source = capture(store);
    const direct = store.create("Unprocessed user note", inbox.id);
    const legitimateAgentCapture = store.capture(crypto.randomUUID(), "Captured on my behalf", "pi", undefined, "agent").block;
    store.create("Guide [type::inbox-guide]", inbox.id);
    store.create("Help text", inbox.id, "system");
    store.create("Agent output", inbox.id, "agent");
    store.create("Processed note [status::processed]", inbox.id);
    store.create("Descendant note", source.id);
    const unrelated = store.create("Personal journal entry");
    const generalTask = store.createRoadmapItem(task).block;
    const before = store.sequence;

    const expected = [source, direct, legitimateAgentCapture].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    expect(repository.pending().map(block => block.id)).toEqual(expected.map(block => block.id));
    expect(repository.settings()).toEqual({ paused: false });
    expect(repository.results()).toEqual([]);
    expect(store.sequence).toBe(before);
    expect(folder(store, "filed")).toHaveLength(0);
    expect(folder(store, "processed")).toHaveLength(0);
    expect(store.require(unrelated.id)).toEqual(unrelated);
    expect(store.require(generalTask.id)).toEqual(generalTask);
  });

  test("files in place, preserves children and original annotation identity, and allocates only explicit tasks", () => {
    const { store, repository, inbox, workQueue } = fixture();
    const source = capture(store);
    const child = store.create("Authored child stays attached", source.id);
    const annotation = annotate(store, source);
    const sequence = store.sequence;
    const result = repository.apply("file", source, plan({ notes: [{ text: "Extracted ordinary idea [topic::research]" }], tasks: [task] }), usage);
    const filed = store.require(source.id);
    expect(result.state).toBe("applied");
    expect(result.usage).toEqual(usage);
    expect(filed.parentId).toBe(folder(store, "filed")[0]!.id);
    expect(filed.text).toContain("A clear note");
    expect(filed.properties).toContainEqual({ key: "status", value: "processed" });
    expect(filed.properties).toContainEqual({ key: "capture-source", value: "cli" });
    expect(filed.properties.some(property => property.key === "work-id")).toBe(false);
    expect(store.require(child.id)).toEqual(child);
    expect(store.getAnnotation(annotation.block.id).originalTarget).toEqual(annotation.originalTarget);
    expect(store.require(annotation.block.id)).toEqual(annotation.block);
    expect(store.children(inbox.id).map(block => block.id)).not.toContain(source.id);
    const outputs = result.outputIds.map(id => store.require(id));
    expect(outputs[0]!.properties.some(property => property.key === "work-id")).toBe(false);
    expect(outputs[0]!.text).toContain(`((${source.id}))`);
    expect(outputs[1]!.parentId).toBe(workQueue.id);
    expect(outputs[1]!.properties).toContainEqual({ key: "work-id", value: "PIE-001" });
    expect(outputs[1]!.properties).toContainEqual({ key: "work-stage", value: "unprioritized" });
    expect(outputs[1]!.properties.some(property => property.key === "work-batch")).toBe(false);
    expect(outputs[1]!.text).toContain(`((${source.id}))`);
    expect(store.sequence).toBeGreaterThan(sequence);
    expect(repository.pending()).toEqual([]);
  });

  test("combined filing and organization survives restart with one receipt and one complete Undo", () => {
    let { store, repository, inbox } = fixture();
    let notes = new NoteAssistanceRepository(store);
    notes.initialize();
    const source = capture(store, "Rough #Rabbit-Hole thought [tag::y2026/q3]\n\nOriginal author wording.");
    const originalChild = store.create("Attached context", source.id);
    const sourceCandidate = notes.candidateFor(source.id)!;
    const assistance: NotePlan = { summary: "Grouped a navigation idea", type: "idea", tags: ["navigation"] };
    const editorial = plan({ notes: [{ text: "A supporting design [type::design-note]" }] });
    const result = store.database.transaction(() => {
      const result = repository.apply("combined", source, editorial, usage, { candidate: sourceCandidate, plan: assistance });
      notes.checkpointEditorial(result, sourceCandidate, assistance);
      return result;
    })();
    const filed = store.require(source.id);
    expect(filed.properties).toContainEqual({ key: "type", value: "idea" });
    expect(filed.properties).toContainEqual({ key: "status", value: "processed" });
    expect(filed.properties).toContainEqual({ key: "tag", value: "Rabbit-Hole" });
    expect(filed.properties).toContainEqual({ key: "tag", value: "y2026/q3" });
    expect(filed.properties).toContainEqual({ key: "tag", value: "navigation" });
    expect(store.require(originalChild.id)).toEqual(originalChild);
    expect(result.kind).toBe("organized");
    expect(result.summary).toBe("type capture → idea; added 1 tag (navigation) · Filed a clearer note.");
    expect(repository.results()).toHaveLength(1);
    expect(notes.results()).toEqual([]);
    expect(notes.pending(repository.sourceIds()).map(value => value.source.id)).not.toContain(source.id);
    expect(notes.pending(repository.sourceIds()).map(value => value.source.id)).not.toContain(result.outputIds[0]);
    expect(notes.candidateFor(source.id)?.inferredTags).toEqual(["navigation"]);
    ({ store, repository } = restart(store));
    notes = new NoteAssistanceRepository(store);
    notes.initialize();
    expect(notes.pending(repository.sourceIds()).map(value => value.source.id)).not.toContain(source.id);
    expect(repository.undo(result.id)).toMatchObject({ state: "undone", kind: "organized" });
    expect(store.require(source.id)).toMatchObject({ text: source.text, parentId: inbox.id });
    expect(store.require(result.outputIds[0]!).effectiveDeletedRootId).not.toBeNull();
    expect(notes.pending(repository.sourceIds()).map(value => value.source.id)).not.toContain(source.id);
  });

  test("fulfillment is filed into the original source before recovery is captured, preserving status and request identity", () => {
    const { store, repository } = fixture();
    const notes = new NoteAssistanceRepository(store);
    notes.initialize();
    const source = capture(store, "List note types [tag::reference]");
    const sourceCandidate = notes.candidateFor(source.id)!;
    const assistance: NotePlan = { summary: "Inventory request", type: "reference", tags: ["inventory"], fulfillment: {
      key: "type-inventory", operation: "property-inventory", text: "Note types\n\n- note: 3", summary: "Listed all note types.",
    } };
    const editorial = plan({ source: { disposition: "file", text: assistance.fulfillment!.text } });
    const result = store.database.transaction(() => {
      const result = repository.apply("answer-inbox", source, editorial, undefined, { candidate: sourceCandidate, plan: assistance });
      notes.checkpointEditorial(result, sourceCandidate, assistance);
      return result;
    })();
    expect(result).toMatchObject({ kind: "fulfilled", summary: "Fulfilled: Listed all note types.", outputIds: [] });
    const final = store.require(source.id);
    expect(final.text).toContain("- note: 3");
    expect(final.properties).toContainEqual({ key: "status", value: "processed" });
    expect(final.properties).toContainEqual({ key: "request-status", value: "fulfilled" });
    expect(notes.candidateFor(source.id)).toMatchObject({ lastRequestKey: "type-inventory", requestAllowed: false, inferredType: "reference", inferredTags: ["inventory"] });
    expect(() => repository.apply("answer-inbox", source, editorial, undefined, { candidate: sourceCandidate, plan: { ...assistance, tags: [] } }))
      .toThrow("different source revision or plan");
    expect(repository.undo(result.id).state).toBe("undone");
    expect(store.require(source.id).text).toBe(source.text);
  });

  test("editor tags cannot override a rejection after Undo, and new editor tags remain inferred across restart", () => {
    let { store, repository } = fixture();
    let notes = new NoteAssistanceRepository(store);
    notes.initialize();
    const source = capture(store, "A rough thought #Authored");
    const organize: NotePlan = { summary: "Grouped the note", type: "note", tags: ["navigation"] };
    let candidate = notes.candidateFor(source.id)!;
    const first = store.database.transaction(() => {
      const result = repository.apply("first-tags", source, plan(), undefined, { candidate, plan: organize });
      notes.checkpointEditorial(result, candidate, organize);
      return result;
    })();
    repository.undo(first.id, restored => notes.checkpointRestored(restored));
    let current = store.require(source.id);
    expect(notes.candidateFor(source.id)?.rejectedTags).toEqual(["navigation"]);
    current = store.update(current.id, `${current.text}\n\nA new human sentence.`, current.revision, { author: "user" });
    candidate = notes.candidateFor(source.id)!;
    const retry: NotePlan = { summary: "Grouped again", type: "note", tags: [] };
    store.database.transaction(() => {
      const result = repository.apply("retry-tags", current, plan({ source: {
        disposition: "file", text: "A cleaned note on #Authored [tag::navigation] [tag::editor-only]\n\nUseful explanation.",
      } }), undefined, { candidate, plan: retry });
      expect(result.summary).toContain("editor-only");
      expect(result.summary).not.toContain("No metadata changes");
      notes.checkpointEditorial(result, candidate, retry);
    })();
    current = store.require(source.id);
    expect(current.properties).not.toContainEqual({ key: "tag", value: "navigation" });
    expect(current.properties).toContainEqual({ key: "tag", value: "Authored" });
    expect(current.text).toContain("A cleaned note on #Authored");
    expect(current.text).not.toContain("[tag::Authored]");
    expect(current.properties).toContainEqual({ key: "tag", value: "editor-only" });
    expect(notes.candidateFor(source.id)).toMatchObject({ rejectedTags: ["navigation"], inferredTags: ["editor-only"] });
    store.update(current.id, current.text.replace("[tag::editor-only]", ""), current.revision, { author: "user" });
    expect(notes.pending()).toEqual([]);
    ({ store, repository } = restart(store));
    notes = new NoteAssistanceRepository(store);
    notes.initialize();
    current = store.require(source.id);
    store.update(current.id, `${current.text}\n\nA later human addition.`, current.revision, { author: "user" });
    candidate = notes.candidateFor(source.id)!;
    expect(candidate.rejectedTags).toEqual(["navigation", "editor-only"]);
    notes.apply("respect-editor-correction", candidate, { ...organize, tags: ["navigation", "editor-only", "fresh"] });
    expect(store.require(source.id).properties.filter(property => property.key === "tag")).toEqual([
      { key: "tag", value: "Authored" }, { key: "tag", value: "fresh" },
    ]);
  });

  test("an editorial hold checkpoints assistance without changing source text or retaining one-shot direction", () => {
    const { store, repository } = fixture();
    const source = capture(store, "Please carry out a remote deployment.");
    const notes = new NoteAssistanceRepository(store);
    notes.initialize();
    notes.reconsider(source.id, "Try this request again.");
    const sourceCandidate = notes.candidateFor(source.id)!;
    const assistance: NotePlan = { summary: "Unsupported request", tags: ["operations"], unfulfilledRequest: { key: "deploy", reason: "Remote deployment is outside note assistance." } };
    const result = store.database.transaction(() => {
      const result = repository.apply("hold-assisted", source, plan({ source: { disposition: "hold", text: source.text, reason: assistance.unfulfilledRequest!.reason } }), undefined,
        { candidate: sourceCandidate, plan: assistance });
      notes.checkpointEditorial(result, sourceCandidate, assistance);
      return result;
    })();
    expect(result).toMatchObject({ state: "held", kind: "unfulfilled" });
    expect(store.require(source.id)).toEqual(source);
    expect(notes.candidateFor(source.id)).toMatchObject({ requestAllowed: false, explicitReconsideration: false });
    expect(notes.candidateFor(source.id)?.instructions).toBeUndefined();
    expect(repository.sourceIds().has(source.id)).toBe(true);
    expect(notes.pending(repository.sourceIds())).toEqual([]);
    expect(notes.results()).toEqual([]);
    expect(repository.attention().results.map(result => result.id)).toEqual(["hold-assisted"]);
  });

  test("checkpoint failure rolls back the entire combined Inbox operation and retry remains undoable", () => {
    const { store, repository } = fixture();
    const notes = new NoteAssistanceRepository(store);
    notes.initialize();
    const source = capture(store);
    const sourceCandidate = notes.candidateFor(source.id)!;
    const assistance: NotePlan = { summary: "An idea", type: "idea", tags: ["navigation"] };
    const beforeSequence = store.sequence;
    const beforeIds = store.readWorkspaceSnapshot().physical.blocks.map(block => block.id).sort();
    const run = () => store.database.transaction(() => {
      const result = repository.apply("atomic-combined", source, plan({ notes: [{ text: "A supporting note" }] }), undefined, { candidate: sourceCandidate, plan: assistance });
      notes.checkpointEditorial(result, sourceCandidate, assistance);
      return result;
    })();
    store.database.exec("CREATE TRIGGER fail_note_checkpoint BEFORE INSERT ON note_assistance_state BEGIN SELECT RAISE(ABORT, 'injected checkpoint failure'); END;");
    expect(run).toThrow("injected checkpoint failure");
    expect(store.require(source.id)).toEqual(source);
    expect(store.sequence).toBe(beforeSequence);
    expect(store.readWorkspaceSnapshot().physical.blocks.map(block => block.id).sort()).toEqual(beforeIds);
    expect(repository.results()).toEqual([]);
    expect(notes.results()).toEqual([]);
    expect(notes.candidateFor(source.id)?.inferredTags).toEqual([]);
    store.database.exec("DROP TRIGGER fail_note_checkpoint");
    const result = run();
    expect(repository.undo(result.id).state).toBe("undone");
    expect(store.require(source.id).text).toBe(source.text);
  });

  test("a classifier result cannot hide an editorial hold reason or claim the source was organized", () => {
    const { store, repository } = fixture();
    const notes = new NoteAssistanceRepository(store);
    notes.initialize();
    const source = capture(store);
    const sourceCandidate = notes.candidateFor(source.id)!;
    const assistance: NotePlan = { summary: "Looks like a navigation idea", type: "idea", tags: ["navigation"] };
    const reason = "Two possible targets need a choice.";
    const result = store.database.transaction(() => {
      const result = repository.apply("editorial-hold", source, plan({ source: { disposition: "hold", text: source.text, reason } }), undefined,
        { candidate: sourceCandidate, plan: assistance });
      notes.checkpointEditorial(result, sourceCandidate, assistance);
      return result;
    })();
    expect(result).toMatchObject({ state: "held", summary: reason });
    expect(result.kind).toBeUndefined();
    expect(store.require(source.id)).toEqual(source);
    expect(notes.pending(repository.sourceIds())).toEqual([]);
  });

  test("Undo atomically checkpoints restored existing targets without forgetting corrections or replaying old requests", () => {
    const { store, repository } = fixture();
    const notes = new NoteAssistanceRepository(store);
    notes.initialize();
    let target = store.create("Please list the type values.");
    notes.apply("old-request", notes.candidateFor(target.id)!, { summary: "An inventory", type: "note", tags: ["navigation"], fulfillment: {
      key: "old-types", operation: "property-inventory", text: `${target.text}\n\nOriginal answer.`, summary: "Answered.",
    } });
    target = store.require(target.id);
    target = store.update(target.id, target.text.replace("[tag::navigation]", "").replace("[type::note]", "[type::decision]"), target.revision, { author: "user" });
    expect(notes.pending()).toEqual([]);
    const source = capture(store, "More context for the existing note.");
    const candidate = notes.candidateFor(source.id)!;
    const assistance: NotePlan = { summary: "Related context", type: "note", tags: [] };
    const result = store.database.transaction(() => {
      const result = repository.apply("update-existing", source, plan({ updates: [{ blockId: target.id, expectedRevision: target.revision,
        text: `${target.text}\n\nContext supplied by this capture.`,
      }] }), undefined, { candidate, plan: assistance });
      notes.checkpointEditorial(result, candidate, assistance);
      return result;
    })();
    const afterTarget = store.require(target.id);
    const afterSource = store.require(source.id);
    const afterSequence = store.sequence;
    const undo = () => repository.undo(result.id, restored => notes.checkpointRestored(restored));
    store.database.exec("CREATE TRIGGER fail_undo_checkpoint BEFORE UPDATE ON note_assistance_state BEGIN SELECT RAISE(ABORT, 'injected undo checkpoint failure'); END;");
    expect(undo).toThrow("injected undo checkpoint failure");
    expect(store.require(target.id)).toEqual(afterTarget);
    expect(store.require(source.id)).toEqual(afterSource);
    expect(store.sequence).toBe(afterSequence);
    expect(repository.getResult(result.id).state).toBe("applied");
    store.database.exec("DROP TRIGGER fail_undo_checkpoint");
    expect(undo().state).toBe("undone");
    expect(store.require(target.id).text).toBe(target.text);
    expect(notes.pending(repository.sourceIds())).toEqual([]);
    expect(notes.candidateFor(target.id)).toMatchObject({ typeLocked: true, rejectedTags: ["navigation"], lastRequestKey: "old-types", requestAllowed: false });
  });

  test("a filed unsupported request retains its task-triage summary and appears in attention until changed or undone", () => {
    const { store, repository, inbox } = fixture();
    const notes = new NoteAssistanceRepository(store);
    notes.initialize();
    const source = capture(store, "Fix the bookmark bug.");
    const candidate = notes.candidateFor(source.id)!;
    const assistance: NotePlan = { summary: "A code request", type: "note", tags: [], unfulfilledRequest: {
      key: "bookmark-fix", reason: "Note assistance does not execute code changes.",
    } };
    const result = store.database.transaction(() => {
      const result = repository.apply("record-request", source, plan({ summary: "Recorded the bookmark bug as a Backlog task.", tasks: [task] }), undefined,
        { candidate, plan: assistance });
      notes.checkpointEditorial(result, candidate, assistance);
      return result;
    })();
    expect(result).toMatchObject({ state: "applied", kind: "unfulfilled" });
    expect(result.summary).toContain("Unfulfilled: Note assistance does not execute code changes.");
    expect(result.summary).toContain("Recorded the bookmark bug as a Backlog task.");
    expect(store.require(source.id).parentId).not.toBe(inbox.id);
    expect(store.require(source.id).properties).toContainEqual({ key: "request-status", value: "open" });
    expect(repository.attention()).toMatchObject({ total: 1, results: [{ id: result.id }] });
    repository.undo(result.id, restored => notes.checkpointRestored(restored));
    expect(repository.attention()).toEqual({ results: [], total: 0 });
    expect(notes.pending(repository.sourceIds())).toEqual([]);
  });

  test("archives a concise linked source and keeps original text only in recovery", () => {
    const { store, repository } = fixture();
    const source = capture(store, "Verbose capture\n\nOriginal-only secret wording for recovery.");
    const result = repository.apply("archive", source, plan({
      summary: "Extracted one useful observation.",
      source: { disposition: "archive", text: "Extracted one useful observation." },
      notes: [{ text: "The extracted observation." }],
    }));
    const archived = store.require(source.id);
    expect(archived.parentId).toBe(folder(store, "processed")[0]!.id);
    expect(archived.text).toContain(`((${result.outputIds[0]}))`);
    expect(archived.text).not.toContain("Original-only");
    expect(store.queryBlocks({ text: "Original-only", limit: 10 }).blocks).toEqual([]);
    repository.undo(result.id);
    expect(store.require(source.id).text).toBe(source.text);
    expect(store.require(source.id).parentId).toBe(source.parentId);
  });

  test("holds, failures and undo suppress only unchanged source revisions, with explicit reconsideration", () => {
    const { store, repository } = fixture();
    const source = capture(store);
    const sequence = store.sequence;
    const held = repository.apply("held", source, plan({ source: { disposition: "hold", text: "", reason: "Needs a concrete intent." } }));
    expect(held.state).toBe("held");
    expect(held.summary).toBe("Needs a concrete intent.");
    expect(store.require(source.id)).toEqual(source);
    expect(store.sequence).toBe(sequence);
    expect(repository.pending()).toEqual([]);
    expect(() => repository.apply("repeat-held", source, plan())).toThrow("held");
    repository.reconsider(source.id);
    expect(repository.pending().map(block => block.id)).toEqual([source.id]);
    repository.fail("failed", source, "Model request interrupted.");
    expect(repository.pending()).toEqual([]);
    expect(store.require(source.id)).toEqual(source);
    const revised = store.update(source.id, source.text + "\n\nMore context.", source.revision);
    expect(repository.pending().map(block => block.id)).toEqual([source.id]);
    const applied = repository.apply("after-edit", revised, plan());
    repository.undo(applied.id);
    expect(repository.pending()).toEqual([]);
    const restored = store.require(source.id);
    expect(restored.text).toBe(revised.text);
    store.update(source.id, restored.text + "\nNext intent.", restored.revision);
    expect(repository.pending().map(block => block.id)).toEqual([source.id]);
  });

  test("attention retains older unresolved notes beyond recent successes and counts a bounded oldest-first view", () => {
    const { store, repository } = fixture();
    const heldSource = capture(store, "Needs the user's choice");
    const held = repository.apply("attention-held", heldSource, plan({
      source: { disposition: "hold", text: heldSource.text, reason: "Choose the intended project." },
    }));
    for (let index = 0; index < 31; index++) {
      const source = capture(store, `Ordinary note ${index}`);
      repository.apply(`success-${index}`, source, plan());
    }
    expect(repository.results().map(result => result.id)).not.toContain(held.id);
    expect(repository.attention()).toEqual({ results: [held], total: 1 });
    const failedSource = capture(store, "Needs another model attempt");
    const failed = repository.fail("attention-failed", failedSource, "Provider temporarily unavailable");
    expect(repository.attention(1)).toEqual({ results: [held], total: 2 });
    expect(repository.attention().results.map(result => result.id)).toEqual([held.id, failed.id]);
    store.update(heldSource.id, heldSource.text + "\n\nThe project is now clear.", heldSource.revision);
    expect(repository.attention()).toEqual({ results: [failed], total: 1 });
    expect(repository.reconsider(failedSource.id)).toBe(true);
    expect(repository.attention()).toEqual({ results: [], total: 0 });
  });

  test("attention shows only the latest unresolved receipt for an active direct Inbox source and excludes undo holds", () => {
    const { store, repository } = fixture();
    const source = capture(store);
    repository.fail("earlier-failure", source, "First failure");
    const latest = repository.fail("later-failure", source, "Latest failure");
    expect(repository.attention()).toEqual({ results: [latest], total: 1 });
    store.move(source.id, null);
    expect(repository.attention()).toEqual({ results: [], total: 0 });
    store.move(source.id, source.parentId);
    store.delete(source.id);
    expect(repository.attention()).toEqual({ results: [], total: 0 });
    const undoneSource = capture(store, "Undone cleanup is intentionally held");
    const applied = repository.apply("attention-undo", undoneSource, plan());
    repository.undo(applied.id);
    expect(repository.pending()).toEqual([]);
    expect(repository.attention()).toEqual({ results: [], total: 0 });
  });

  test("result offsets retrieve older receipts in the established newest-first order and reject invalid bounds", () => {
    const { store, repository } = fixture();
    const source = capture(store);
    const receipts = Array.from({ length: 5 }, (_, index) => repository.fail(`page-${index}`, source, `Failure ${index}`));
    expect(repository.results(2)).toEqual([receipts[4]!, receipts[3]!]);
    expect(repository.results(2, 2)).toEqual([receipts[2]!, receipts[1]!]);
    expect(repository.results(2, 4)).toEqual([receipts[0]!]);
    expect(repository.results(2, 6)).toEqual([]);
    for (const offset of [-1, 0.5, NaN, Infinity]) expect(() => repository.results(2, offset)).toThrow("offset");
    for (const limit of [0, 1001, 1.5]) expect(() => repository.results(limit)).toThrow("limit");
  });

  test("retries after restart replay receipts and bind operation IDs to the exact source revision and plan", () => {
    let { store, repository } = fixture();
    const source = capture(store);
    const decision = plan({ notes: [{ text: "A durable output" }], tasks: [task] });
    const result = repository.apply("durable", source, decision, usage);
    repository.setPaused(true);
    const sequence = store.sequence;
    ({ store, repository } = restart(store));
    expect(repository.settings()).toEqual({ paused: true });
    expect(repository.apply("durable", source, decision)).toEqual(result);
    expect(repository.results()).toEqual([result]);
    expect(store.sequence).toBe(sequence);
    expect(store.workIdAllocatorStatus().nextWorkId).toBe("PIE-002");
    expect(() => repository.apply("durable", source, { ...decision, summary: "Changed meaning" })).toThrow("different source revision or plan");
    expect(() => repository.apply("durable", { ...source, revision: source.revision + 1 }, decision)).toThrow("different source revision or plan");
    expect(repository.undo(result.id).state).toBe("undone");
    const restored = store.require(source.id);
    expect(restored.text).toBe(source.text);
    expect(restored.parentId).toBe(source.parentId);
    expect(result.outputIds.every(id => store.require(id).effectiveDeletedRootId !== undefined)).toBe(true);
    expect(store.workIdAllocatorStatus().nextWorkId).toBe("PIE-002");
    expect(repository.undo(result.id).state).toBe("undone");
    expect(repository.apply("durable", source, decision).state).toBe("undone");
    expect(repository.pending()).toEqual([]);
    expect(folder(store, "filed")).toHaveLength(0);
  });

  test("paused reconsideration instructions survive restart and failure, and successful apply or hold consumes them", () => {
    let { store, repository } = fixture();
    const source = capture(store);
    repository.fail("initial-failure", source, "Unavailable model");
    repository.setPaused(true);
    repository.reconsider(source.id, "Keep this as one ordinary note.");
    ({ store, repository } = restart(store));
    expect(repository.settings().paused).toBe(true);
    expect(repository.instructions(source.id)).toBe("Keep this as one ordinary note.");
    expect(repository.pending().map(block => block.id)).toEqual([source.id]);
    repository.fail("network-failure", source, "Network unavailable");
    expect(repository.instructions(source.id)).toBe("Keep this as one ordinary note.");
    repository.reconsider(source.id);
    expect(repository.instructions(source.id)).toBe("Keep this as one ordinary note.");
    const applied = repository.apply("steered-apply", source, plan());
    expect(repository.instructions(source.id)).toBeUndefined();
    expect(repository.reconsider(source.id, "Cannot requeue a processed note.")).toBe(false);
    repository.undo(applied.id);
    repository.reconsider(source.id, "Hold this for now.");
    const restored = store.require(source.id);
    repository.apply("steered-hold", restored, plan({ source: { disposition: "hold", text: "", reason: "Waiting for user." } }));
    expect(repository.instructions(source.id)).toBeUndefined();
    repository.reconsider(source.id, "First direction");
    repository.reconsider(source.id, "Replacement direction");
    expect(repository.instructions(source.id)).toBe("Replacement direction");
    repository.reconsider(source.id);
    expect(repository.instructions(source.id)).toBe("Replacement direction");
    repository.reconsider(source.id, "");
    expect(repository.instructions(source.id)).toBeUndefined();
  });

  test("a real receipt insert failure rolls back outputs, source edits, folders, sequence and Work ID allocation", () => {
    const { store, repository } = fixture();
    const source = capture(store);
    const target = store.create("Existing information");
    const sequence = store.sequence;
    const blocks = store.readWorkspaceSnapshot().physical.blocks.map(block => block.id).sort();
    store.database.exec(`CREATE TRIGGER fail_inbox_receipt BEFORE INSERT ON inbox_agent_results BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END;`);
    expect(() => repository.apply("rollback", source, plan({
      notes: [{ text: "Would be created" }], tasks: [task],
      updates: [{ blockId: target.id, expectedRevision: target.revision, text: "Would be changed" }],
    }))).toThrow("injected receipt failure");
    expect(store.require(source.id)).toEqual(source);
    expect(store.require(target.id)).toEqual(target);
    expect(store.readWorkspaceSnapshot().physical.blocks.map(block => block.id).sort()).toEqual(blocks);
    expect(store.sequence).toBe(sequence);
    expect(store.workIdAllocatorStatus().nextWorkId).toBe("PIE-001");
    expect(repository.results()).toEqual([]);
    expect(repository.pending().map(block => block.id)).toEqual([source.id]);
    store.database.exec("DROP TRIGGER fail_inbox_receipt");
    expect(repository.apply("rollback", source, plan({ tasks: [task] })).state).toBe("applied");
  });

  test("undo restores updated targets and protects lifecycle, batch membership, Work ID and annotation identities", () => {
    const { store, repository } = fixture();
    const source = capture(store);
    const batch = store.create("Committed work [type::work-batch] [project::test]");
    const target = store.createRoadmapItem({ ...task, workBatchId: batch.id, workStage: "doing" }).block;
    const annotation = annotate(store, target);
    const result = repository.apply("protected", source, plan({ updates: [{
      blockId: target.id, expectedRevision: target.revision,
      text: "Clarified task [type::note] [work-id::PIE-999] [work-stage::done] [work-batch::invented] [project::other]\n\nClarified acceptance.",
    }] }));
    const updated = store.require(target.id);
    expect(updated.text).toContain("Clarified acceptance");
    expect(updated.properties.filter(p=>p.key!=="raw-capture"&&p.key!=="before-rewrite")).toEqual(target.properties);
    expect(store.getAnnotation(annotation.block.id).originalTarget).toEqual(annotation.originalTarget);
    expect(store.require(annotation.block.id)).toEqual(annotation.block);
    expect(store.workIdAllocatorStatus().nextWorkId).toBe("PIE-002");
    repository.undo(result.id);
    expect(store.require(target.id).text).toBe(target.text);
    expect(store.require(target.id).parentId).toBe(target.parentId);
    expect(store.require(annotation.block.id)).toEqual(annotation.block);
  });

  test("source and task rewrites preserve inline and line-scoped examples while protecting block metadata", () => {
    const { store, repository } = fixture();
    const source = capture(store);
    const target = store.createRoadmapItem({ ...task, workStage: "doing" }).block;
    const examples = "The literal token [status::done] belongs in this example.\nwork-stage:: done\nwork-id:: PIE-999";
    repository.apply("scoped-rewrite", source, plan({
      source: { disposition: "file", text: `Workflow note [status::done]\n\n${examples}` },
      updates: [{
        blockId: target.id, expectedRevision: target.revision,
        text: `Task explanation [type::note] [work-stage::done] [work-id::PIE-999]\n\n${examples}`,
      }],
    }));
    const filed = store.require(source.id);
    const updated = store.require(target.id);
    expect(filed.text).toContain(examples);
    expect(updated.text).toContain(examples);
    expect(filed.properties).toContainEqual({ key: "status", value: "processed" });
    expect(filed.properties).not.toContainEqual({ key: "status", value: "done" });
    expect(updated.properties.filter(p=>p.key!=="raw-capture"&&p.key!=="before-rewrite")).toEqual(target.properties);
    const lineExamples = store.queryBlocks({ filters: [{ key: "work-stage", value: "done" }], propertyScope: "line", limit: 10 });
    expect(lineExamples.blocks.map(block => block.id).sort()).toEqual([source.id, target.id].sort());
    const inlineExamples = store.queryBlocks({ filters: [{ key: "status", value: "done" }], propertyScope: "inline", limit: 10 });
    expect(inlineExamples.blocks.map(block => block.id).sort()).toEqual([source.id, target.id].sort());
    expect(store.workIdAllocatorStatus().nextWorkId).toBe("PIE-002");
  });

  test("new ordinary notes may include inline and line-scoped workflow examples without acquiring managed metadata", () => {
    const { store, repository } = fixture();
    const source = capture(store);
    const examples = "The literal token [status::done] belongs in this example.\nwork-stage:: done\nwork-id:: PIE-999";
    const result = repository.apply("scoped-note", source, plan({
      notes: [{ text: `Workflow examples [type::note]\n\n${examples}` }],
    }));
    const note = store.require(result.outputIds[0]!);
    expect(note.text).toContain(examples);
    expect(note.properties.filter(p=>p.key!=="raw-capture")).toEqual([{ key: "type", value: "note" }]);
    expect(store.queryBlocks({ filters: [{ key: "work-id", value: "PIE-999" }], propertyScope: "line", limit: 10 }).blocks.map(block => block.id)).toEqual([note.id]);
    expect(store.queryBlocks({ filters: [{ key: "work-id", value: "PIE-999" }], propertyScope: "block", limit: 10 }).blocks).toEqual([]);
    expect(store.workIdAllocatorStatus().nextWorkId).toBe("PIE-001");
  });

  test.each([
    "Managed declaration [status::done]",
    "Managed declaration\n[work-id::PIE-999]\n\nBody.",
    "Managed declaration\nwork-stage:: done\n\nBody.",
  ])("new ordinary notes still reject block-scoped managed metadata: %s", value => {
    const { store, repository } = fixture();
    const source = capture(store);
    const sequence = store.sequence;
    expect(() => repository.apply("managed-note", source, plan({ notes: [{ text: value }] }))).toThrow("managed property");
    expect(store.require(source.id)).toEqual(source);
    expect(store.sequence).toBe(sequence);
    expect(repository.results()).toEqual([]);
  });

  test("rejects source overlap, duplicate updates, stale targets, managed annotation edits and notes masquerading as tasks", () => {
    const { store, repository } = fixture();
    const source = capture(store);
    const target = store.create("Existing note");
    const annotation = annotate(store, source);
    const update = { blockId: target.id, expectedRevision: target.revision, text: "Revised note" };
    const cases: InboxPlan[] = [
      plan({ updates: [{ ...update, blockId: source.id }] }),
      plan({ updates: [update, update] }),
      plan({ updates: [{ ...update, expectedRevision: target.revision + 1 }] }),
      plan({ updates: [{ ...update, blockId: annotation.block.id, expectedRevision: annotation.block.revision }] }),
      plan({ notes: [{ text: "Bypass allocator [work-id::PIE-009]" }] }),
      plan({ source: { disposition: "hold", text: "", reason: "Wait" }, notes: [{ text: "Do not create this" }] }),
      plan({ notes: [{ text: "Invalid destination", parentId: "missing" }] }),
    ];
    const sequence = store.sequence;
    for (const [index, invalid] of cases.entries()) expect(() => repository.apply(`invalid-${index}`, source, invalid)).toThrow();
    expect(store.require(source.id)).toEqual(source);
    expect(store.require(target.id)).toEqual(target);
    expect(store.require(annotation.block.id)).toEqual(annotation.block);
    expect(store.sequence).toBe(sequence);
    expect(repository.results()).toEqual([]);
  });

  test.each(["edit", "move", "delete", "new child", "child edit", "annotation"])("undo refuses a later %s without partial restoration", change => {
    const { store, repository } = fixture();
    const source = capture(store);
    const child = store.create("Existing child", source.id);
    const result = repository.apply(`conflict-${change}`, source, plan({ notes: [{ text: "Created output" }] }));
    const output = store.require(result.outputIds[0]!);
    if (change === "edit") store.update(output.id, "Later human edit", output.revision);
    if (change === "move") store.move(output.id, null);
    if (change === "delete") store.delete(output.id);
    if (change === "new child") store.create("New valuable child", output.id);
    if (change === "child edit") store.update(child.id, "Later edit to source child", child.revision);
    if (change === "annotation") annotate(store, output);
    const sequence = store.sequence;
    const currentSource = store.require(source.id);
    const currentOutput = store.require(output.id);
    expect(() => repository.undo(result.id)).toThrow("changed since cleanup");
    expect(store.require(source.id)).toEqual(currentSource);
    expect(store.require(output.id)).toEqual(currentOutput);
    expect(store.sequence).toBe(sequence);
    expect(repository.results()[0]!.state).toBe("applied");
  });

  test("undo rolls back when its receipt update fails and retains helper folders reused by later cleanups", () => {
    const { store, repository } = fixture();
    const source = capture(store);
    const result = repository.apply("first", source, plan({ notes: [{ text: "First output" }] }));
    const secondSource = capture(store, "Second capture");
    const second = repository.apply("second", secondSource, plan());
    const filedFolder = folder(store, "filed")[0]!;
    const current = store.require(source.id);
    const sequence = store.sequence;
    store.database.exec(`CREATE TRIGGER fail_inbox_undo BEFORE UPDATE ON inbox_agent_results BEGIN SELECT RAISE(ABORT, 'injected undo failure'); END;`);
    expect(() => repository.undo(result.id)).toThrow("injected undo failure");
    expect(store.require(source.id)).toEqual(current);
    expect(store.require(result.outputIds[0]!).effectiveDeletedRootId).toBeUndefined();
    expect(store.sequence).toBe(sequence);
    store.database.exec("DROP TRIGGER fail_inbox_undo");
    repository.undo(result.id);
    expect(store.require(filedFolder.id).effectiveDeletedRootId).toBeUndefined();
    expect(store.require(second.sourceId).parentId).toBe(filedFolder.id);
    expect(store.require(source.id).text).toBe(source.text);
  });

  test.each(["UUID", "Work ID", "property", "annotation elsewhere", "Resource occurrence annotation"])("undo refuses a new external %s reference to an output", kind => {
    const { store, repository } = fixture();
    const source = capture(store);
    const result = repository.apply(`linked-${kind}`, source, plan({
      ...(kind === "Work ID" ? { tasks: [task] } : { notes: [{ text: "Useful output\n\nFile evidence [file::evidence.txt]" }] }),
    }));
    const output = store.require(result.outputIds[0]!);
    let linked: Block;
    if (kind === "annotation elsewhere") {
      const annotation = annotate(store, output);
      linked = store.move(annotation.block.id, null);
    } else if (kind === "Resource occurrence annotation") {
      const directory = fixtures.find(entry => entry.store === store)!.directory;
      writeFileSync(join(directory, "evidence.txt"), "Original file evidence");
      const resource = store.resources.internFilesystem({ path: join(directory, "evidence.txt") }).resource;
      const file = store.resources.describe(resource.id, true).filesystem!;
      const start = output.text.indexOf("[file::evidence.txt]");
      linked = store.createAnnotation("resource-occurrence", {
        source: "user", body: "This reference is important.", target: {
          representation: {
            id: `filesystem:${resource.id}:${file.contentHash}`,
            subject: { kind: "resource", resourceId: resource.id },
            sourceSnapshot: { kind: "resource", resourceId: resource.id, sourceSnapshotId: null, revision: file.revision },
            adapter: { id: "filesystem.text", version: 1 }, mediaType: "text/plain", contentHash: file.contentHash, capturedAt: file.capturedAt,
          },
          anchor: createTextQuoteAnchor(file.text, 0, 8),
          referenceContext: createAnnotationReferenceContext(output, start, start + "[file::evidence.txt]".length),
        },
      }, "user").annotations[0]!.block;
      expect(linked.parentId).not.toBe(output.id);
    } else {
      linked = store.create(kind === "Work ID" ? "New use of [[PIE-001]]" :
        kind === "property" ? `Depends on this [related-to::${output.id}]` : `New use of ((${output.id}))`);
    }
    const currentSource = store.require(source.id);
    const sequence = store.sequence;
    expect(() => repository.undo(result.id)).toThrow("Cannot undo Inbox cleanup");
    expect(store.require(output.id).effectiveDeletedRootId).toBeUndefined();
    expect(store.require(linked.id)).toEqual(linked);
    expect(store.require(source.id)).toEqual(currentSource);
    expect(store.sequence).toBe(sequence);
  });

  test("undo allows its own output links and later references to the source whose identity survives", () => {
    const { store, repository } = fixture();
    const source = capture(store);
    const result = repository.apply("own-links", source, plan({
      source: { disposition: "archive", text: "Material extracted." }, notes: [{ text: "Useful extracted material" }],
    }));
    const reference = store.create(`This stable capture still matters: ((${source.id}))`);
    repository.undo(result.id);
    expect(store.require(reference.id)).toEqual(reference);
    expect(store.require(source.id).text).toBe(source.text);
    expect(store.require(source.id).effectiveDeletedRootId).toBeUndefined();
  });

  test("reconsider reports no longer eligible sources without preventing other work from resuming", () => {
    const { store, repository } = fixture();
    const source = capture(store);
    repository.fail("failed-source", source, "Temporary failure");
    store.delete(source.id);
    expect(repository.reconsider(source.id)).toBe(false);
    expect(repository.reconsider("missing")).toBe(false);
    const moved = capture(store, "Manually filed source");
    store.move(moved.id, null);
    expect(repository.reconsider(moved.id)).toBe(false);
    const active = capture(store, "Still eligible");
    expect(repository.reconsider(active.id, "User direction")).toBe(true);
    expect(repository.pending().map(block => block.id)).toEqual([active.id]);
  });
});

test('before source survives edits, restart and undo without creating a canonical copy',()=>{
 const {store,repository}=fixture();const source=capture(store);
 const saved=repository.apply('history-before',source,plan());
 expect(repository.beforeSource(saved.id)).toEqual({id:source.id,text:source.text,revision:source.revision,updatedAt:source.updatedAt});
 const restarted=restart(store);
 expect(restarted.repository.beforeSource(saved.id)?.text).toBe(source.text);
 restarted.repository.undo(saved.id);
 expect(restarted.repository.beforeSource(saved.id)?.text).toBe(source.text);
 const current=restarted.store.require(source.id);
 restarted.store.update(source.id,'A later edit',current.revision,{author:'user'});
 expect(restarted.repository.beforeSource(saved.id)?.text).toBe(source.text);
});

test('plan preflight checks allocator metadata without reserving IDs or writing',()=>{
 const {store,repository}=fixture();const source=capture(store);
 const before=store.sequence;
 const invalid=plan({tasks:[{...task,tracks:[]}]});
 expect(()=>repository.validate(invalid,source)).toThrow('tasks[0]');
 repository.validate(plan({tasks:[task]}),source);repository.validate(plan({tasks:[task]}),source);
 expect(store.sequence).toBe(before);
 const created=store.createRoadmapItem(task);expect(created.workId).toBe('PIE-001');
});

test('preflight rejects managed update targets before the editor terminates',()=>{
 const {store,repository}=fixture(),source=capture(store);
 const target=store.create('Managed guide [system-doc::guide]');
 expect(()=>repository.validate(plan({updates:[{blockId:target.id,expectedRevision:target.revision,text:'replacement'}]}),source)).toThrow('updates[0]: Inbox cannot rewrite managed');
 expect(store.require(target.id)).toEqual(target);
});
