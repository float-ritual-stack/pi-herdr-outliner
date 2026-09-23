import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoteAssistanceRepository } from "../src/note-assistance-repository";
import type { NoteCandidate, NotePlan } from "../src/note-assistance-types";
import { passageKey } from "../src/note-content";
import { OutlinerStore } from "../src/store";
import type { Block } from "../src/types";

const fixtures: Array<{ store: OutlinerStore; directory: string }> = [];
const user = { author: "user" as const };
const agent = { author: "agent" as const, actorId: "another-agent" };

function fixture(initialize = true) {
  const directory = mkdtempSync(join(tmpdir(), "outliner-note-assistance-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  fixtures.push({ store, directory });
  const repository = new NoteAssistanceRepository(store);
  if (initialize) repository.initialize();
  return { store, repository };
}

function restart(store: OutlinerStore) {
  const entry = fixtures.find(entry => entry.store === store)!;
  store.close();
  entry.store = new OutlinerStore(join(entry.directory, "outliner.sqlite"));
  const repository = new NoteAssistanceRepository(entry.store);
  repository.initialize();
  return { store: entry.store, repository };
}

function candidate(repository: NoteAssistanceRepository, block: Block): NoteCandidate {
  const candidate = repository.pending().find(candidate => candidate.source.id === block.id);
  expect(candidate).toBeDefined();
  return candidate!;
}

function plan(changes: Partial<NotePlan> = {}): NotePlan {
  return { summary: "Grouped a useful note", type: "note", tags: ["navigation"], ...changes };
}

function values(block: Block, key: string): string[] {
  return block.properties.filter(property => property.key === key).map(property => property.value);
}

afterEach(() => {
  for (const { store, directory } of fixtures.splice(0)) {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("NoteAssistanceRepository", () => {
  test("baselines the whole existing store once, including Trash, without sweeping historical requests", () => {
    const { store, repository } = fixture(false);
    const old = store.create("Please list every note type");
    const oldTrash = store.create("An old request in Trash");
    store.delete(oldTrash.id);
    expect(() => repository.pending()).toThrow("Initialize note assistance");
    const sequence = store.sequence;
    repository.initialize();
    expect(store.sequence).toBe(sequence);
    expect(repository.pending()).toEqual([]);
    store.restore(oldTrash.id);
    expect(repository.pending()).toEqual([]);
    const fresh = store.create("A new request");
    repository.initialize();
    expect(repository.pending().map(value => value.source.id)).toEqual([fresh.id]);
    expect(store.require(old.id)).toEqual(old);
  });

  test("discovers new user and agent notes and derives user request permission from fresh text edits", () => {
    const { store, repository } = fixture();
    const human = store.create("Please explain this note");
    const createdByAgent = store.create("Agent-authored reference", null, "agent", agent);
    expect(candidate(repository, human).requestAllowed).toBe(true);
    expect(candidate(repository, human).explicitReconsideration).toBe(false);
    expect(candidate(repository, createdByAgent).requestAllowed).toBe(false);
    repository.apply("agent-note", candidate(repository, createdByAgent), plan());
    expect(repository.pending().map(value => value.source.id)).toEqual([human.id]);
    const current = store.require(createdByAgent.id);
    store.update(current.id, `${current.text}\n\nPlease collect the references.`, current.revision, user);
    const edited = candidate(repository, createdByAgent);
    expect(edited.source.author).toBe("agent");
    expect(edited.requestAllowed).toBe(true);
  });

  test("later user edits to assistant-created notes are eligible instead of permanently excluding their creator", () => {
    const { store, repository } = fixture();
    const source = store.create("An assistant-created note", null, "agent", { actorId: "note-assistant" });
    repository.apply("first", candidate(repository, source), plan());
    expect(repository.pending()).toEqual([]);
    const current = store.require(source.id);
    store.update(source.id, `${current.text}\n\nA new human thought.`, current.revision, user);
    expect(candidate(repository, source).requestAllowed).toBe(true);
  });

  test("historical request passages remain observed after unrelated edits, including same-line additions", () => {
    let { store, repository } = fixture(false);
    const request = "Please list every note type.";
    const source = store.create(`${request}\n\nHistorical context.`);
    repository.initialize();
    ({ store, repository } = restart(store));
    store.update(source.id, `${request} The date is Wednesday.\n\nHistorical context.\n\nAn unrelated addition.`, source.revision, user);
    const pending = candidate(repository, source);
    expect(pending.requestAllowed).toBe(true);
    expect(pending.explicitReconsideration).toBe(false);
    expect(pending.seenRequestPassages).toContain(passageKey(request));
    expect(pending.seenRequestPassages).not.toContain(passageKey("An unrelated addition."));
    repository.reconsider(source.id);
    expect(candidate(repository, source).explicitReconsideration).toBe(true);
    expect(candidate(repository, source).seenRequestPassages).toContain(passageKey(request));
  });

  test("new requests start unobserved and checkpoints retain every passage rather than the model window", () => {
    const { store, repository } = fixture();
    const paragraphs = Array.from({ length: 24 }, (_, i) => `Please explain idea ${i + 1}.`);
    const source = store.create(paragraphs.join("\n\n"));
    expect(candidate(repository, source).seenRequestPassages).toEqual([]);
    repository.apply("observed", candidate(repository, source), plan());
    const current = store.require(source.id);
    store.update(source.id, `${current.text}\n\nAn unrelated thought.`, current.revision, user);
    const pending = candidate(repository, source);
    expect(pending.seenRequestPassages).toHaveLength(24);
    expect(pending.seenRequestPassages).toContain(passageKey(paragraphs[23]!));
  });

  test("changing a prose hashtag changes the request target and is a meaningful edit", () => {
    const { store, repository } = fixture();
    const source = store.create("Please summarize #navigation.");
    repository.apply("initial-target", candidate(repository, source), plan({ tags: [] }));
    const current = store.require(source.id);
    store.update(source.id, current.text.replace("#navigation", "#workboard"), current.revision, user);
    const changed = candidate(repository, source);
    expect(changed.seenRequestPassages).toContain(passageKey("Please summarize #navigation."));
    expect(changed.seenRequestPassages).not.toContain(passageKey("Please summarize #workboard."));
  });

  test("organizes metadata only, preserving authored tags, type, provenance and hierarchy", () => {
    const { store, repository } = fixture();
    const parent = store.create("Parent");
    const source = store.create("My decision [type::decision] [tag::#Rabbit-Hole] [project::personal]\n\nExact authored prose.", parent.id);
    const child = store.create("Attached material", source.id);
    const originalCount = store.database.query("SELECT COUNT(*) AS n FROM blocks").get();
    const pending = candidate(repository, source);
    expect(pending.typeLocked).toBe(true);
    const result = repository.apply("organize", pending, plan({ type: "reference", tags: ["y2026/q1"] }));
    const after = store.require(source.id);
    expect(values(after, "type")).toEqual(["decision"]);
    expect(values(after, "tag")).toEqual(["#Rabbit-Hole", "y2026/q1"]);
    expect(after.text.split("\n\n")[1]).toBe("Exact authored prose.");
    expect(after.parentId).toBe(parent.id);
    expect(after.author).toBe(source.author);
    expect(store.require(child.id)).toEqual(child);
    expect(result.summary).toBe("added 1 tag (y2026/q1)");
    expect(result.kind).toBe("organized");
    expect(result.outputIds).toEqual([]);
    expect(store.database.query("SELECT COUNT(*) AS n FROM blocks").get()).toEqual(originalCount);
  });

  test("can replace automatic capture and known agent legacy types, while a user legacy type stays locked", () => {
    const { store, repository } = fixture();
    const captured = store.capture("capture-note", "Interesting history", "cli").block;
    const legacy = store.create("Design history [type::design-context]", null, "agent", agent);
    const authored = store.create("My own label [type::design-context]");
    expect(candidate(repository, captured).typeLocked).toBe(false);
    expect(candidate(repository, legacy).typeLocked).toBe(false);
    expect(candidate(repository, authored).typeLocked).toBe(true);
    repository.apply("capture-type", candidate(repository, captured), plan());
    repository.apply("legacy-type", candidate(repository, legacy), plan({ type: "design-note" }));
    expect(values(store.require(captured.id), "type")).toEqual(["note"]);
    expect(values(store.require(captured.id), "capture-source")).toEqual(["cli"]);
    expect(values(store.require(legacy.id), "type")).toEqual(["design-note"]);
  });

  test("new agent type inventions remain classifiable without an ever-growing alias map", () => {
    const { store, repository } = fixture();
    const source = store.create("Interesting detour [type::rabbit-hole]", null, "agent", agent);
    const pending = candidate(repository, source);
    expect(pending.typeLocked).toBe(false);
    repository.apply("canonicalize", pending, plan({ tags: ["rabbit-hole"] }));
    expect(values(store.require(source.id), "type")).toEqual(["note"]);
    expect(values(store.require(source.id), "tag")).toEqual(["rabbit-hole"]);
    const multiple = store.create("Another detour [type::agent-invented] [type::random-label]", null, "agent", agent);
    expect(candidate(repository, multiple).typeLocked).toBe(false);
    repository.apply("one-type", candidate(repository, multiple), plan());
    expect(values(store.require(multiple.id), "type")).toEqual(["note"]);
  });

  test("agent-added or changed types are not mistaken for human corrections, including property-only edits", () => {
    const { store, repository } = fixture(false);
    const source = store.create("An old untyped note");
    repository.initialize();
    store.patchProperties(source.id, source.revision, [{ op: "append", key: "type", value: "rabbit-hole" }], agent);
    let pending = candidate(repository, source);
    expect(pending.typeLocked).toBe(false);
    repository.apply("fix-agent-addition", pending, plan());
    let current = store.require(source.id);
    store.update(source.id, current.text.replace("[type::note]", "[type::another-invention]"), current.revision, agent);
    pending = candidate(repository, source);
    expect(pending.typeLocked).toBe(false);
    repository.apply("fix-agent-change", pending, plan());
    current = store.require(source.id);
    store.update(source.id, `${current.text.replace("[type::note]", "[type::decision]")}\n\nA human correction.`, current.revision, user);
    expect(candidate(repository, source).typeLocked).toBe(true);
    repository.apply("respect-human", candidate(repository, source), plan({ type: "reference" }));
    expect(values(store.require(source.id), "type")).toEqual(["decision"]);
  });

  test("an agent body edit does not unlock an unchanged manually assigned type", () => {
    let { store, repository } = fixture(false);
    const source = store.create("A deliberate category [type::decision]");
    repository.initialize();
    ({ store, repository } = restart(store));
    store.update(source.id, `${source.text}\n\nAgent-authored supporting material.`, source.revision, agent);
    expect(candidate(repository, source).typeLocked).toBe(true);
    repository.apply("keep-human-type", candidate(repository, source), plan({ type: "reference" }));
    expect(values(store.require(source.id), "type")).toEqual(["decision"]);
  });

  test.each([false, true])("a later agent prose edit cannot erase an unobserved human type correction (checkpointed=%s)", checkpointed => {
    const { store, repository } = fixture();
    const source = store.create("An agent draft [type::note]", null, "agent", agent);
    if (checkpointed) repository.apply("initial", candidate(repository, source), plan());
    let current = store.require(source.id);
    current = store.patchProperties(current.id, current.revision, [{ op: "replace", ordinal: 0, key: "type", value: "decision" }], user);
    store.update(current.id, `${current.text}\n\nAgent-added supporting prose.`, current.revision, agent);
    const pending = candidate(repository, source);
    expect(pending.typeLocked).toBe(true);
    repository.apply("respect-correction", pending, plan({ type: "reference" }));
    expect(values(store.require(source.id), "type")).toEqual(["decision"]);
  });

  test("a user's original typed note stays locked when an agent edits prose before first observation", () => {
    const { store, repository } = fixture();
    const source = store.create("A deliberate decision [type::decision]");
    store.update(source.id, `${source.text}\n\nAgent-added evidence.`, source.revision, agent);
    expect(candidate(repository, source).typeLocked).toBe(true);
    repository.apply("keep-created-type", candidate(repository, source), plan({ type: "reference" }));
    expect(values(store.require(source.id), "type")).toEqual(["decision"]);
  });

  test("candidateFor reads historical and explicitly reconsidered context without consuming or checkpointing it", () => {
    const { store, repository } = fixture(false);
    const source = store.create("Please inventory the note types.");
    repository.initialize();
    const before = store.database.query("SELECT * FROM note_assistance_state WHERE block_id = ?").get(source.id);
    expect(repository.candidateFor(source.id)).toMatchObject({ requestAllowed: false, explicitReconsideration: false });
    expect(repository.candidateFor(source.id)?.seenRequestPassages).toEqual([passageKey(source.text)]);
    expect(store.database.query("SELECT * FROM note_assistance_state WHERE block_id = ?").get(source.id)).toEqual(before);
    repository.reconsider(source.id, "Use the whole inventory.");
    expect(repository.candidateFor(source.id)).toMatchObject({ requestAllowed: true, explicitReconsideration: true, instructions: "Use the whole inventory." });
    expect(repository.pending().map(value => value.source.id)).toEqual([source.id]);
    expect(repository.candidateFor("missing")).toBeUndefined();
    const managed = store.create("Roadmap [type::roadmap-item] [work-stage::unprioritized]");
    expect(repository.candidateFor(managed.id)).toBeUndefined();
  });

  test("records removed inferred tags and a corrected type through restart and subsequent body edits", () => {
    let { store, repository } = fixture();
    const source = store.create("A navigation thought");
    repository.apply("labels", candidate(repository, source), plan({ tags: ["navigation", "terminals"] }));
    let current = store.require(source.id);
    store.update(source.id, current.text.replace("[tag::navigation]", "").replace("[type::note]", "[type::decision]"), current.revision, user);
    expect(repository.pending()).toEqual([]);
    ({ store, repository } = restart(store));
    current = store.require(source.id);
    store.update(source.id, `${current.text}\n\nA related new detail.`, current.revision, user);
    const next = candidate(repository, source);
    expect(next.rejectedTags).toContain("navigation");
    expect(next.typeLocked).toBe(true);
    repository.apply("updated-labels", next, plan({ type: "reference", tags: ["navigation", "terminals", "knowledge"] }));
    const after = store.require(source.id);
    expect(values(after, "tag")).toEqual(["terminals", "knowledge"]);
    expect(values(after, "type")).toEqual(["decision"]);
  });

  test("does not churn revisions for unchanged classifications or wake on whitespace-only edits", () => {
    const { store, repository } = fixture();
    const source = store.create("A useful thought");
    repository.apply("first", candidate(repository, source), plan());
    let current = store.require(source.id);
    store.update(source.id, `${current.text}\n\n`, current.revision, user);
    expect(repository.pending()).toEqual([]);
    current = store.require(source.id);
    repository.reconsider(source.id);
    repository.apply("same", candidate(repository, source), plan());
    expect(store.require(source.id).revision).toBe(current.revision);
    expect(repository.pending()).toEqual([]);
  });

  test("fulfills a supported request in the same note and keeps managed metadata authoritative", () => {
    const { store, repository } = fixture();
    const source = store.create("System type inventory [tag::reference] [project::personal]\n\nList the distinct note types.");
    const child = store.create("Related context", source.id);
    const requested = candidate(repository, source);
    const fulfillment: NonNullable<NotePlan["fulfillment"]> = {
      key: "types/block", operation: "property-inventory", summary: "Listed every live type.",
      text: "System type inventory [work-stage::done] [project::wrong]\n\nObserved today.\n\n- note: 1",
    };
    const result = repository.apply("inventory", requested, plan({ fulfillment }));
    const after = store.require(source.id);
    expect(after.text).toContain("- note: 1");
    expect(values(after, "project")).toEqual(["personal"]);
    expect(values(after, "work-stage")).toEqual([]);
    expect(values(after, "request-status")).toEqual(["fulfilled"]);
    expect(store.require(child.id)).toEqual(child);
    expect(result.summary).toBe("Fulfilled: Listed every live type.");
    expect(result.kind).toBe("fulfilled");
    expect(repository.apply("inventory", requested, plan({ fulfillment }))).toEqual(result);
    expect(repository.pending()).toEqual([expect.objectContaining({ source: child })]);
    const edited = store.update(after.id, `${after.text}\n\nAdditional context.`, after.revision, user);
    expect(candidate(repository, edited).lastRequestKey).toBe("types/block");
    const duplicate = repository.apply("not-again", candidate(repository, edited), plan({ fulfillment }));
    expect(duplicate.summary).toBe("No metadata changes");
    expect(store.require(source.id).text).toContain("Additional context.");
  });

  test("agent imports can be organized but cannot execute requests without explicit reconsideration", () => {
    const { store, repository } = fixture();
    const source = store.create("Old imported request: explain the navigation design", null, "agent", agent);
    const fulfillment: NonNullable<NotePlan["fulfillment"]> = { key: "explain", operation: "answer", summary: "Answered", text: "The explanation." };
    expect(() => repository.apply("forbidden", candidate(repository, source), plan({ fulfillment }))).toThrow("fresh user intent");
    expect(store.require(source.id)).toEqual(source);
    expect(repository.reconsider(source.id)).toBe(true);
    expect(candidate(repository, source).requestAllowed).toBe(true);
    expect(candidate(repository, source).explicitReconsideration).toBe(true);
    repository.apply("allowed", candidate(repository, source), plan({ fulfillment }));
    expect(store.require(source.id).text).toContain("The explanation.");
  });

  test("a new unsupported request reopens an older fulfilled note, remains visible in attention, and can be undone", () => {
    let { store, repository } = fixture();
    const source = store.create("Please list every note type.");
    repository.apply("first-request", candidate(repository, source), plan({ fulfillment: {
      key: "inventory/type", operation: "property-inventory", text: "Types\n\n- note: 1", summary: "Listed note types",
    } }));
    const fulfilled = store.require(source.id);
    const edited = store.update(source.id, `${fulfilled.text}\n\nNow deploy the application.`, fulfilled.revision, user);
    const pending = candidate(repository, edited);
    expect(pending.lastRequestKey).toBe("inventory/type");
    const result = repository.apply("unsupported-request", pending, plan({
      unfulfilledRequest: { key: "deploy/application", reason: "Deployment is outside the available note operations." },
    }));
    expect(result).toMatchObject({ state: "applied", kind: "unfulfilled" });
    expect(result.summary).toContain("Deployment is outside");
    expect(values(store.require(source.id), "request-status")).toEqual(["open"]);
    expect(store.require(source.id).text).toContain("Now deploy the application.");
    expect(repository.pending()).toEqual([]);
    ({ store, repository } = restart(store));
    expect(repository.attention()).toMatchObject({ total: 1, results: [{ id: "unsupported-request", kind: "unfulfilled" }] });
    expect(repository.undo(result.id)).toMatchObject({ state: "undone", kind: "unfulfilled" });
    expect(store.require(source.id).text).toBe(edited.text);
    expect(values(store.require(source.id), "request-status")).toEqual(["fulfilled"]);
    expect(repository.attention()).toEqual({ total: 0, results: [] });
    const restored = store.require(source.id);
    store.update(source.id, `${restored.text}\n\nMore context.`, restored.revision, user);
    expect(candidate(repository, source).lastRequestKey).toBe("inventory/type");
  });

  test("unfulfilled request decisions require fresh user intent and cannot accompany a fulfillment", () => {
    const { store, repository } = fixture();
    const imported = store.create("Old transcript: deploy the service", null, "agent", agent);
    const unsupported = { key: "deploy", reason: "No deployment operation is available." };
    expect(() => repository.apply("imported-request", candidate(repository, imported), plan({ unfulfilledRequest: unsupported })))
      .toThrow("fresh user intent");
    const source = store.create("Please deploy this service");
    expect(() => repository.apply("contradiction", candidate(repository, source), plan({
      unfulfilledRequest: unsupported,
      fulfillment: { key: "deploy", operation: "answer", summary: "Answered", text: "An answer" },
    }))).toThrow("both fulfilled and unfulfilled");
    expect(store.require(source.id)).toEqual(source);
    expect(store.require(imported.id)).toEqual(imported);
    expect(repository.results()).toEqual([]);
  });

  test("fulfillment retains authored hashtag positions and temporal meaning without duplicating them", () => {
    const { store, repository } = fixture();
    const source = store.create("Explain this idea\n\nMy #rabbit-hole belongs to #y2026/q1, not its import date.");
    repository.apply("hashtag-answer", candidate(repository, source), plan({
      tags: ["time"], fulfillment: {
        key: "explain-time", operation: "answer", summary: "Explained the period",
        text: `${source.text}\n\nA quarter is a period of #time, not a made-up day.`,
      },
    }));
    const after = store.require(source.id);
    expect(after.text).toContain("My #rabbit-hole belongs to #y2026/q1, not its import date.");
    expect(values(after, "tag")).toEqual(["rabbit-hole", "y2026/q1", "time"]);
  });

  test("restart retains unprocessed changes, own-write suppression, failures and reconsideration", () => {
    let { store, repository } = fixture();
    const unprocessed = store.create("Unprocessed note");
    const applied = store.create("Organized note");
    const failed = store.create("Failed note");
    repository.apply("applied", candidate(repository, applied), plan());
    repository.fail("failed", candidate(repository, failed), "Provider unavailable");
    ({ store, repository } = restart(store));
    expect(repository.pending().map(value => value.source.id)).toEqual([unprocessed.id]);
    expect(repository.getResult("applied").state).toBe("applied");
    expect(repository.getResult("failed").state).toBe("failed");
    expect(repository.reconsider(failed.id)).toBe(true);
    ({ store, repository } = restart(store));
    expect(candidate(repository, failed).requestAllowed).toBe(true);
  });

  test("explicit reconsideration direction survives restart and is consumed by success or failure", () => {
    let { store, repository } = fixture();
    const source = store.create("An imported note", null, "agent", agent);
    repository.apply("classified", candidate(repository, source), plan());
    expect(repository.reconsider(source.id, "  Explain the tradeoff in this note.  ")).toBe(true);
    ({ store, repository } = restart(store));
    let pending = candidate(repository, source);
    expect(pending.instructions).toBe("Explain the tradeoff in this note.");
    expect(pending.requestAllowed).toBe(true);
    repository.apply("steered", pending, plan());
    let current = store.require(source.id);
    store.update(source.id, `${current.text}\n\nA fresh edit.`, current.revision, user);
    expect(candidate(repository, source).instructions).toBeUndefined();
    repository.reconsider(source.id, "Try a different explanation.");
    pending = candidate(repository, source);
    repository.fail("steering-failed", pending, "The provider failed");
    ({ store, repository } = restart(store));
    repository.reconsider(source.id);
    expect(candidate(repository, source).instructions).toBeUndefined();
    expect(() => repository.reconsider(source.id, "x".repeat(2001))).toThrow("at most 2000");
    repository.apply("clear-retry", candidate(repository, source), plan());
    current = store.require(source.id);
    store.update(source.id, `${current.text}\n\nAnother edit.`, current.revision, agent);
    expect(candidate(repository, source).instructions).toBeUndefined();
    expect(candidate(repository, source).requestAllowed).toBe(false);
  });

  test("an older attempt cannot consume replacement reconsideration direction", () => {
    const { store, repository } = fixture();
    const source = store.create("A note needing direction");
    repository.reconsider(source.id, "First direction");
    const old = candidate(repository, source);
    repository.reconsider(source.id, "New direction");
    expect(() => repository.apply("old-direction", old, plan())).toThrow("reconsideration changed");
    repository.fail("old-failure", old, "Stale direction");
    expect(candidate(repository, source).instructions).toBe("New direction");
    expect(store.require(source.id)).toEqual(source);
  });

  test("attention returns only latest unchanged eligible failures with exact pagination and receipt lookup", () => {
    const { store, repository } = fixture();
    const first = store.create("First failed note");
    const second = store.create("Second failed note");
    const third = store.create("Third failed note");
    repository.fail("first-failure", candidate(repository, first), "First failure");
    repository.fail("second-failure", candidate(repository, second), "Second failure");
    repository.fail("third-failure", candidate(repository, third), "Third failure");
    expect(repository.hasResult("first-failure")).toBe(true);
    expect(repository.hasResult("missing")).toBe(false);
    expect(repository.attention(1)).toMatchObject({ total: 3, results: [{ id: "first-failure" }] });
    expect(repository.attention(1, 1)).toMatchObject({ total: 3, results: [{ id: "second-failure" }] });
    repository.reconsider(first.id);
    repository.fail("replacement-failure", candidate(repository, first), "Different failure");
    expect(repository.attention().results.map(result => result.id)).toEqual(["second-failure", "third-failure", "replacement-failure"]);
    repository.reconsider(second.id);
    repository.apply("second-success", candidate(repository, second), plan());
    expect(repository.attention().results.map(result => result.id)).toEqual(["third-failure", "replacement-failure"]);
    store.update(third.id, "Third note changed", third.revision, user);
    expect(repository.attention().results.map(result => result.id)).toEqual(["replacement-failure"]);
    store.delete(first.id);
    expect(repository.attention()).toEqual({ total: 0, results: [] });
    expect(repository.results()).toHaveLength(5);
    expect(() => repository.attention(0)).toThrow("Invalid note attention page");
    expect(() => repository.attention(1, -1)).toThrow("Invalid note attention page");
  });

  test("attention stops following a failed note after a parent move and excludes newly managed records", () => {
    const { store, repository } = fixture();
    const source = store.create("A note with a failed result");
    repository.fail("before-move", candidate(repository, source), "Failed");
    expect(repository.attention().total).toBe(1);
    store.move(source.id, store.create("A different parent").id);
    expect(repository.attention().total).toBe(0);
    const managed = store.update(source.id, "Managed view [type::virtual-branch] [query::tag=help]", source.revision, user);
    repository.fail("managed-failure", { source: managed, inferredTags: [], rejectedTags: [], typeLocked: true, requestAllowed: false }, "Rejected");
    expect(repository.attention().total).toBe(0);
  });

  test.each(["edit", "move", "delete"])("rejects a stale result after a source %s without suppressing newer text", change => {
    const { store, repository } = fixture();
    const source = store.create("Original note");
    const pending = candidate(repository, source);
    if (change === "edit") store.update(source.id, "Newer authored text", source.revision, user);
    if (change === "move") store.move(source.id, store.create("New parent").id);
    if (change === "delete") store.delete(source.id);
    expect(() => repository.apply("stale", pending, plan())).toThrow();
    repository.fail("stale-failure", pending, "Stale result");
    if (change === "edit") expect(candidate(repository, source).source.text).toBe("Newer authored text");
    expect(repository.results().map(value => value.id)).toEqual(["stale-failure"]);
  });

  test("rolls back content and checkpoint when the result receipt cannot commit, then retries once", () => {
    const { store, repository } = fixture();
    const source = store.create("Atomic note");
    const pending = candidate(repository, source);
    store.database.exec("CREATE TRIGGER reject_note_result BEFORE INSERT ON note_assistance_results BEGIN SELECT RAISE(ABORT, 'receipt failed'); END;");
    expect(() => repository.apply("atomic", pending, plan())).toThrow("receipt failed");
    expect(store.require(source.id)).toEqual(source);
    expect(candidate(repository, source).source.revision).toBe(source.revision);
    expect(repository.results()).toEqual([]);
    store.database.exec("DROP TRIGGER reject_note_result");
    repository.apply("atomic", pending, plan());
    expect(repository.pending()).toEqual([]);
    expect(repository.results()).toHaveLength(1);
    expect(() => repository.apply("atomic", pending, plan({ tags: ["different"] }))).toThrow("different input");
  });

  test("undo restores original content, suppresses immediate redo and preserves correction memory", () => {
    let { store, repository } = fixture();
    const source = store.create("Please explain this idea [tag::mine]");
    const original = candidate(repository, source);
    const decision = plan({ fulfillment: { key: "answer/idea", operation: "answer", text: "A useful explanation.", summary: "Explained the idea" } });
    repository.apply("answered", original, decision);
    ({ store, repository } = restart(store));
    expect(repository.undo("answered")).toMatchObject({ state: "undone", kind: "fulfilled" });
    expect(store.require(source.id).text).toBe(source.text);
    expect(repository.pending()).toEqual([]);
    expect(repository.undo("answered").state).toBe("undone");
    expect(repository.apply("answered", original, decision).state).toBe("undone");
    const current = store.require(source.id);
    store.update(source.id, `${current.text}\n\nA human addition.`, current.revision, user);
    const edited = candidate(repository, source);
    expect(edited.rejectedTags).toContain("navigation");
    expect(edited.typeLocked).toBe(true);
    expect(edited.lastRequestKey).toBe("answer/idea");
  });

  test.each(["edit", "move", "delete"])("undo refuses a later %s", change => {
    const { store, repository } = fixture();
    const source = store.create("An original note");
    repository.apply("organized", candidate(repository, source), plan());
    const current = store.require(source.id);
    if (change === "edit") store.update(source.id, "A later edit", current.revision, user);
    if (change === "move") store.move(source.id, store.create("Another parent").id);
    if (change === "delete") store.delete(source.id);
    expect(() => repository.undo("organized")).toThrow();
    expect(repository.getResult("organized").state).toBe("applied");
  });

  test("a later no-op decision still owns its processing state when an older result is undone", () => {
    const { store, repository } = fixture();
    const source = store.create("Unchanged metadata [type::note] [tag::mine]");
    const unchanged = plan({ tags: [] });
    repository.apply("older", candidate(repository, source), unchanged);
    repository.reconsider(source.id);
    repository.apply("newer", candidate(repository, source), unchanged);
    expect(store.require(source.id).revision).toBe(source.revision);
    expect(() => repository.undo("older")).toThrow("changed since assistance");
    expect(repository.undo("newer").state).toBe("undone");
  });

  test("checkpoints managed or empty blocks and respects exclusions without consuming excluded work", () => {
    const { store, repository } = fixture();
    const managed = store.create("A view [type::virtual-branch] [query::tag=help]");
    const empty = store.create("   ");
    const excluded = store.create("Currently owned by Inbox editing");
    expect(repository.pending(new Set([excluded.id]))).toEqual([]);
    expect(repository.pending().map(value => value.source.id)).toEqual([excluded.id]);
    repository.reconsider(excluded.id, "Assist this note explicitly");
    expect(repository.pending(new Set([excluded.id]))).toEqual([expect.objectContaining({
      source: excluded, explicitReconsideration: true, instructions: "Assist this note explicitly",
    })]);
    expect(repository.reconsider(managed.id)).toBe(false);
    expect(repository.reconsider(empty.id)).toBe(false);
    expect(() => repository.apply("managed", { source: managed, inferredTags: [], rejectedTags: [], typeLocked: false, requestAllowed: true }, plan())).toThrow("eligible");
  });
});

test('note assistance exposes the selected attempt before-text across restart and later edits',()=>{
 const {store,repository}=fixture();const source=store.create('Remember this thought');
 repository.apply('before-organizing',candidate(repository,source),plan());
 const reopened=restart(store);
 const current=reopened.store.require(source.id);
 reopened.store.update(source.id,'A later human rewrite',current.revision,user);
 expect(reopened.repository.beforeSource('before-organizing')).toEqual({id:source.id,text:source.text,revision:source.revision});
 const next=candidate(reopened.repository,reopened.store.require(source.id));
 reopened.repository.fail('failed-without-snapshot',next,'Unavailable model');
 expect(reopened.repository.beforeSource('failed-without-snapshot')).toBeUndefined();
});
