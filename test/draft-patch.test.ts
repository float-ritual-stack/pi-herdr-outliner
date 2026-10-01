// draft.patch (PIE-501): compare-and-swap on a span of a note's text, routed to the door holding a live
// draft or to the saved note, with a failure landing as an embedded proposal. Fictional notes only.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutlinerClient } from "../src/client";
import { applyLocated, blockStartAt, locateSpan, locateSpanForced, locateSpans, mapOffset, markStart, spanContext, utf16Range, type DraftPatchSpan } from "../src/draft-patch-compare";
import { DRAFT_PROPOSAL_MAX_PAYLOAD, DraftHolds, draftPatchPolicy, draftPatchTextPolicy, parseProposal, structuralTokens, type DraftHolderRequest, type DraftPatchResult } from "../src/draft-patch";
import { tidyAboveMark, tidyLine } from "../src/draft-patch-demo";
import { OutlinerServer } from "../src/server";
import { OutlinerStore } from "../src/store";
import type { Block, OutlinerEvent, OutlinerServiceStatus } from "../src/types";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function service() {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-draft-patch-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  const socket = join(directory, "outliner.sock");
  const server = new OutlinerServer(store, socket);
  await server.start();
  cleanups.push(async () => { await server.close(); store.close(); });
  return { store, server, client: new OutlinerClient(socket, 10_000), socket };
}

const TIDY = { author: "agent" as const, actorId: "tidy" };

/**
 * A stand-in for a door: it subscribes, holds a draft of one note and answers the service's `draft`
 * events against its own buffer, with the same compare the door vendors.
 */
async function fakeDoor(client: OutlinerClient, clientId: string, blockId: string, text: string, revision: number, options: { leaseMs?: number; answer?: boolean; refuse?: string; slowPatchMs?: number } = {}) {
  const door = { text, revision, requests: [] as DraftHolderRequest[], holdId: "" };
  const connected = Promise.withResolvers<void>();
  const patches = new Map<string, { before: string }>();
  const watcher = client.watch({
    client: { clientId, role: "observer", contextId: clientId },
    onConnect: connected.resolve,
    onEvent: async (event: OutlinerEvent) => {
      if (event.domain !== "draft" || !event.draft) return;
      const request = event.draft;
      door.requests.push(request);
      if (options.answer === false) return;
      let answer: unknown;
      if (request.kind === "read") answer = { text: door.text, revision: door.revision };
      else if (request.kind === "patch") {
        if (options.refuse) answer = { applied: false, reason: options.refuse };
        else {
          const located = locateSpans(door.text, request.patches, request.force);
          if (!located.ok) answer = { applied: false, reason: located.reason };
          else { patches.set(request.patchId, { before: door.text }); door.text = applyLocated(door.text, located.spans); answer = { applied: true }; }
        }
      } else if (request.kind === "revert") {
        const was = patches.get(request.patchId);
        if (was) door.text = was.before;
        answer = { reverted: !!was };
      } else {
        door.text = `${door.text}\n${request.line}`;
        answer = { applied: true };
      }
      // A slow door: it applies the patch at once, but its answer comes after the service stopped waiting.
      if (request.kind === "patch" && options.slowPatchMs) await Bun.sleep(options.slowPatchMs);
      await client.request({ action: "drafts.answer", requestId: request.requestId, clientId, answer: answer as never }).catch(() => undefined);
    },
  });
  cleanups.push(() => watcher.stop());
  await connected.promise;
  const hold = await client.request<{ holdId: string }>({ action: "drafts.hold", blockId, clientId, revision, ...(options.leaseMs ? { leaseMs: options.leaseMs } : {}) });
  door.holdId = hold.holdId;
  return door;
}

function spanOf(text: string, observed: string, replacement: string): DraftPatchSpan {
  const start = text.indexOf(observed);
  return { observed, replacement, range: { start, end: start + observed.length }, unit: "utf16" };
}

describe("the compare", () => {
  const text = "Garden notes\nThe beans  go  along the fence.\n\n@tidy tidy this\nStill typing here";

  test("finds the observed text at its range, or near it, and says why when it can't", () => {
    const span = spanOf(text, "The beans  go  along the fence.", "The beans go along the fence.");
    expect(locateSpan(text, span)).toEqual(span.range!);
    const moved = "Garden notes, spring\n" + text.slice("Garden notes\n".length);
    expect(locateSpan(moved, span)).toEqual({ start: span.range!.start + 8, end: span.range!.end + 8 });
    expect(locateSpan(text.replace("beans", "peas"), span)).toEqual({ reason: "the observed text isn't there any more" });
    expect(locateSpan("x".repeat(600) + text, span)).toEqual({ reason: "the observed text has moved away from its range" });
    expect(locateSpan("ab ab", { observed: "ab", replacement: "c" })).toEqual({ reason: "the observed text is in the note more than once; give its range" });
    expect(locateSpan(text, { observed: "", replacement: "x" })).toHaveProperty("reason");
  });

  test("reads a byte range as UTF-8 and refuses one inside a character", () => {
    const text = "Crème brûlée ^dessert";
    expect(utf16Range(text, { start: 7, end: 15 }, "utf8")).toEqual({ start: 6, end: 12 });
    expect(utf16Range(text, { start: 3, end: 5 }, "utf8")).toBeNull();
    expect(locateSpan(text, { observed: "brûlée", replacement: "brulee", range: { start: 7, end: 15 }, unit: "utf8" })).toEqual({ start: 6, end: 12 });
  });

  test("moves a position after the span by the change in length, and one inside it to its end", () => {
    const located = locateSpans(text, [spanOf(text, "beans  go  along", "beans go along")]);
    expect(located.ok).toBe(true);
    if (!located.ok) return;
    const after = text.indexOf("Still");
    expect(mapOffset(after, located.spans)).toBe(after - 2);
    expect(mapOffset(3, located.spans)).toBe(3);
    const inside = text.indexOf("go");
    expect(mapOffset(inside, located.spans)).toBe(located.spans[0]!.start + "beans go along".length);
    expect(locateSpans(text, [spanOf(text, "beans  go", "a"), spanOf(text, "go  along", "b")])).toMatchObject({ ok: false, reason: "two spans of the patch overlap" });
  });

  test("apply anyway places a changed passage between the text kept around it, a line at a time", () => {
    const read = "Rounds\n\nthe leeks   go by the  shed\n\n@tidy go\nand the";
    const start = read.indexOf("the leeks");
    const observed = "the leeks   go by the  shed";
    const span: DraftPatchSpan = { observed, replacement: "the leeks go by the shed", range: { start, end: start + observed.length }, ...spanContext(read, start, start + observed.length) };
    // The person changed the passage, the proposal's embed went in under the mark, and typing went on.
    const now = "Rounds\n\nthe tall leeks   go by the  shed\n\n@tidy go\n!((p-1))\nand the onions";
    const at = locateSpanForced(now, span);
    expect("start" in at && now.slice(at.start, at.end)).toBe("the tall leeks   go by the  shed");
    expect(locateSpanForced("Elsewhere entirely", span)).toEqual({ reason: "the text before the passage isn't there any more" });
  });

  test("finds the mark line and the start of the cursor's block", () => {
    expect(markStart(text, "  @tidy tidy this ")).toBe(text.indexOf("@tidy"));
    expect(markStart(text, "@nobody")).toBe(-1);
    const list = "Intro line\nsecond line\n- item one\n- item two";
    expect(blockStartAt(list, list.indexOf("second") + 2)).toBe(0);
    expect(blockStartAt(list, list.indexOf("two"))).toBe(list.indexOf("- item two"));
  });
});

describe("the policy", () => {
  test("a prose edit keeps every anchor, link, reference and property, and adds none", () => {
    expect(structuralTokens("Beds [[Seed list]] ((0f3c2a1b-seed^beans)) [kind::plan] ^beds\nnot an ^anchor here")).toEqual(
      ["((0f3c2a1b-seed^beans))", "[[Seed list]]", "[kind::plan]", "^beds"].sort(),
    );
    expect(draftPatchPolicy({ observed: "Two  raised beds. ^beds", replacement: "Two raised beds. ^beds" })).toBeNull();
    expect(draftPatchPolicy({ observed: "Two raised beds. ^beds", replacement: "Two raised beds." }, () => 2))
      .toBe("it would drop ^beds (2 notes link to ^beds); a prose edit keeps them");
    expect(draftPatchPolicy({ observed: "see [[Seed list]]", replacement: "see the seed list" })).toContain("drop [[Seed list]]");
    expect(draftPatchPolicy({ observed: "see ((0f3c2a1b-seed))", replacement: "see it" })).toContain("drop ((0f3c2a1b-seed))");
    expect(draftPatchPolicy({ observed: "Plan [kind::plan]", replacement: "Plan" })).toContain("drop [kind::plan]");
    expect(draftPatchPolicy({ observed: "Plan", replacement: "Plan [kind::plan]" })).toContain("add [kind::plan]");
  });
});

describe("holds", () => {
  test("a lease runs out unless it is renewed, and a gone client loses its holds", () => {
    let now = 1_000;
    const holds = new DraftHolds(() => now);
    const hold = holds.hold("note-1", "door-a", 3, 2_000);
    expect(holds.holderOf("note-1", () => true)?.clientId).toBe("door-a");
    now += 1_500;
    holds.heartbeat(hold.holdId);
    now += 1_500;
    expect(holds.holderOf("note-1", () => true)?.holdId).toBe(hold.holdId);
    now += 2_001;
    expect(holds.holderOf("note-1", () => true)).toBeNull();
    expect(() => holds.heartbeat(hold.holdId)).toThrow("expired");
    holds.hold("note-1", "door-b", 3);
    expect(holds.holderOf("note-1", clientId => clientId !== "door-b")).toBeNull();
  });
});

describe("the proof agent's tidy", () => {
  test("tidies whitespace and markers, never inside a link, reference or token", () => {
    expect(tidyLine("*  beans   along  the [[Seed  list]]  fence   ^beds  ")).toBe("- beans along the [[Seed  list]] fence ^beds");
    expect(tidyLine("#Plan  for ** spring ** [kind::a  b]")).toBe("# Plan for **spring** [kind::a  b]");
    const text = "Plan\nThe beans   go   along  the fence.\nwater  them ^beds\n\n@tidy tidy this\nstill typing";
    const span = tidyAboveMark(text, "@tidy tidy this")!;
    expect(span.observed).toBe("Plan\nThe beans   go   along  the fence.\nwater  them ^beds");
    expect(span.replacement).toBe("Plan\nThe beans go along the fence.\nwater them ^beds");
    expect(span).toMatchObject({ before: "", after: "\n\n@tidy tidy this\nstill typing" });
    expect(text.slice(span.range!.start, span.range!.end)).toBe(span.observed);
    expect(tidyAboveMark("Tidy already.\n@tidy go", "@tidy go")).toBeNull();
  });
});

describe("draft.patch over the protocol", () => {
  test("advertises its capabilities and the compare's version", async () => {
    const { client } = await service();
    const ping = await client.request<OutlinerServiceStatus>({ action: "ping" });
    expect(ping.capabilities).toEqual(expect.arrayContaining(["drafts.hold", "drafts.read", "draft.patch", "draft.proposal.apply", "ping.draftPatchCompare"]));
    expect(ping.draftPatchCompare).toEqual({ version: 1 });
  });

  test("with no live draft it patches the saved note under a revision check, as the agent", async () => {
    const { store, client } = await service();
    const note = store.create("Garden plan\nThe beans   go along  the fence.\n\n@tidy tidy this");
    const span = tidyAboveMark(note.text, "@tidy tidy this")!;
    const result = await client.request<DraftPatchResult>({ action: "draft.patch", blockId: note.id, revision: note.revision, patches: [span], mark: { text: "@tidy tidy this" }, mutation: TIDY });
    expect(result).toEqual({ outcome: "applied", edits: [{ blockId: note.id, route: "saved", revision: note.revision + 1 }] });
    const saved = store.require(note.id);
    expect(saved.text).toBe("Garden plan\nThe beans go along the fence.\n\n@tidy tidy this");
    expect(saved.id).toBe(note.id);
    const feed = await client.request<{ changes: Array<{ blockId?: string; kind: string; actor?: { author: string; actorId?: string } }> }>({ action: "changes.since", sequence: 0 });
    expect([...feed.changes].reverse().find(change => change.blockId === note.id && change.kind === "edit")?.actor).toMatchObject({ author: "agent", actorId: "tidy" });
  });

  test("a stale revision fails cleanly into an embedded proposal, and A applies it anyway", async () => {
    const { store, client } = await service();
    const note = store.create("Garden plan\nThe beans   go along  the fence.\n\n@tidy tidy this");
    const span = tidyAboveMark(note.text, "@tidy tidy this")!;
    // The person changes the same sentence before the patch lands: an overlapping edit.
    const edited = store.update(note.id, note.text.replace("beans   go", "runner beans   go"), note.revision, { author: "user" });
    const result = await client.request<DraftPatchResult>({ action: "draft.patch", blockId: note.id, revision: note.revision, patches: [span], mark: { text: "@tidy tidy this" }, mutation: TIDY });
    expect(result).toMatchObject({ outcome: "proposed", embedded: "saved", embeddedIn: note.id });
    if (result.outcome !== "proposed") return;
    expect(result.reason).toContain("saved since it was read");
    const proposal = store.require(result.proposalId);
    expect(proposal).toMatchObject({ parentId: note.id, author: "agent", actorId: "tidy" });
    expect(proposal.properties).toEqual(expect.arrayContaining([{ key: "type", value: "draft-proposal" }, { key: "proposal-status", value: "open" }]));
    // The proposal's text holds the patch; its fenced passages never read as links or properties.
    expect(parseProposal(proposal.text)?.edits[0]?.patches[0]?.replacement).toBe(span.replacement);
    const withEmbed = store.require(note.id);
    expect(withEmbed.text).toBe(`${edited.text.replace("@tidy tidy this", `@tidy tidy this\n!((${result.proposalId}))`)}`);
    // The person's words are untouched until they choose.
    expect(withEmbed.text).toContain("runner beans   go");

    const applied = await client.request<{ outcome: string; edits: Array<{ route: string }> }>({ action: "draft.proposal.apply", proposalId: result.proposalId, mutation: { author: "user" } });
    expect(applied).toMatchObject({ outcome: "applied", edits: [{ route: "saved" }] });
    expect(store.require(note.id).text).toContain("The beans go along the fence.");
    expect(store.require(result.proposalId).properties).toEqual(expect.arrayContaining([{ key: "proposal-status", value: "applied" }]));
    expect(store.require(result.proposalId).text).toStartWith("Applied anyway: 1 edit from @tidy, which didn't apply at first because the note was saved since it was read");
    await expect(client.request({ action: "draft.proposal.apply", proposalId: result.proposalId, mutation: { author: "user" } })).rejects.toThrow("already applied");
  });

  test("the prose policy refuses a patch that drops a deep-linked anchor, into a proposal", async () => {
    const { store, client } = await service();
    const b = store.create("Note B [page::note b]\nThe fence  bed holds the beans. ^deep-link\n\n@tidy tidy this");
    const a = store.create(`Note A\nsee [[note b]] and ((${b.id}^deep-link))`);
    const span: DraftPatchSpan = { ...spanOf(b.text, "The fence  bed holds the beans. ^deep-link", "The fence bed holds the beans.") };
    const refused = await client.request<DraftPatchResult>({ action: "draft.patch", blockId: b.id, revision: b.revision, patches: [span], mark: { text: "@tidy tidy this" }, mutation: TIDY, policy: "prose" });
    expect(refused.outcome).toBe("proposed");
    if (refused.outcome === "proposed") expect(refused.reason).toBe("it would drop ^deep-link (1 note links to ^deep-link); a prose edit keeps them");
    // The proposal quotes the passage in fences: it holds no anchor, property or page link of its own.
    if (refused.outcome === "proposed") {
      const proposal = store.require(refused.proposalId);
      expect(structuralTokens(proposal.text).filter(token => !token.startsWith(`((${b.id}|`) && !token.startsWith("[type::") && !token.startsWith("[proposal-status::") && !token.startsWith("[draft-patch::"))).toEqual([]);
    }

    // A tidy that keeps the anchor applies, and note A's deep links still resolve to the same block.
    const now = store.require(b.id);
    const tidy = tidyAboveMark(now.text.split(`\n!((`)[0]! + "\n\n@tidy tidy this", "@tidy tidy this")!;
    const applied = await client.request<DraftPatchResult>({ action: "draft.patch", blockId: b.id, revision: now.revision, patches: [{ ...tidy, range: undefined }], mutation: TIDY, policy: "prose" });
    expect(applied.outcome).toBe("applied");
    expect(store.require(b.id).text).toContain("The fence bed holds the beans. ^deep-link");
    const page = await client.request<{ block?: Block }>({ action: "pages.resolve", address: "note b" });
    expect(page.block?.id).toBe(b.id);
    const fragment = await client.request<{ status: string }>({ action: "fragments.read", blockId: b.id, fragmentId: "deep-link" });
    expect(fragment.status).toBe("resolved");
    expect(store.require(a.id).text).toBe(`Note A\nsee [[note b]] and ((${b.id}^deep-link))`);
  });

  test("a live draft gets the patch; the saved note is untouched", async () => {
    const { store, client } = await service();
    const note = store.create("Morning plan\nsaved text");
    const live = "Morning plan\nThe beans   go along  the fence.\n\n@tidy tidy this\nand I keep typi";
    const door = await fakeDoor(client, "door-1", note.id, live, note.revision);
    const read = await client.request<{ route: string; text: string; revision: number }>({ action: "drafts.read", blockId: note.id });
    expect(read).toMatchObject({ route: "draft", text: live, revision: note.revision });
    const span = tidyAboveMark(read.text, "@tidy tidy this")!;
    const result = await client.request<DraftPatchResult>({ action: "draft.patch", blockId: note.id, revision: read.revision, patches: [span], mark: { text: "@tidy tidy this" }, mutation: TIDY });
    expect(result).toEqual({ outcome: "applied", edits: [{ blockId: note.id, route: "draft", holder: "door-1" }] });
    expect(door.text).toBe("Morning plan\nThe beans go along the fence.\n\n@tidy tidy this\nand I keep typi");
    expect(store.require(note.id).revision).toBe(note.revision);
    expect(door.requests.find(request => request.kind === "patch")).toMatchObject({ mark: "@tidy tidy this", mutation: TIDY });
  });

  test("a draft that fails the compare gets the proposal's embed instead, and nothing is written under it", async () => {
    const { store, client } = await service();
    const note = store.create("Morning plan");
    const door = await fakeDoor(client, "door-2", note.id, "Morning plan\nbeans   here\n@tidy go", note.revision, { refuse: "the observed text isn't there any more" });
    const span = spanOf(door.text, "beans   here", "beans here");
    const result = await client.request<DraftPatchResult>({ action: "draft.patch", blockId: note.id, revision: note.revision, patches: [span], mark: { text: "@tidy go" }, mutation: TIDY });
    expect(result).toMatchObject({ outcome: "proposed", reason: "the observed text isn't there any more", embedded: "draft" });
    if (result.outcome === "proposed") expect(door.text).toEndWith(`!((${result.proposalId}))`);
    expect(store.require(note.id).text).toBe("Morning plan");
  });

  test("a lease that runs out sends the patch to the saved note", async () => {
    const { store, client } = await service();
    const note = store.create("Morning plan\nbeans   here");
    const door = await fakeDoor(client, "door-3", note.id, note.text, note.revision, { leaseMs: 1_000 });
    await Bun.sleep(1_100);
    const result = await client.request<DraftPatchResult>({ action: "draft.patch", blockId: note.id, revision: note.revision, patches: [spanOf(note.text, "beans   here", "beans here")], mutation: TIDY });
    expect(result).toMatchObject({ outcome: "applied", edits: [{ route: "saved" }] });
    expect(door.requests).toEqual([]);
    await expect(client.request({ action: "drafts.heartbeat", holdId: door.holdId })).rejects.toThrow("expired");
  });

  test("a door that stops answering keeps its hold: the patch becomes a proposal and nothing is written under its draft", async () => {
    const { store, client } = await service();
    const note = store.create("Morning plan\nbeans   here");
    const door = await fakeDoor(client, "door-4", note.id, note.text, note.revision, { answer: false, leaseMs: 6_000 });
    const result = await client.request<DraftPatchResult>({ action: "draft.patch", blockId: note.id, revision: note.revision, patches: [spanOf(note.text, "beans   here", "beans here")], mutation: TIDY });
    expect(result).toMatchObject({ outcome: "proposed", embedded: null });
    if (result.outcome === "proposed") expect(result.reason).toContain("didn't answer");
    // The person's draft may still be there: the saved note gets neither the patch nor the proposal's embed.
    expect(store.require(note.id).text).toBe(note.text);
    // Asked again while it's still silent, it fails at once, and still nothing is written.
    const started = Date.now();
    const next = await client.request<DraftPatchResult>({ action: "draft.patch", blockId: note.id, revision: note.revision, patches: [spanOf(note.text, "beans   here", "beans here")], mutation: TIDY });
    expect(next).toMatchObject({ outcome: "proposed", embedded: null });
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(store.require(note.id).text).toBe(note.text);
    // Only once its lease runs out (a frozen or dead door stops renewing) does the saved note take patches.
    await Bun.sleep(Math.max(0, 6_100 - (Date.now() - started) - 2_500));
    const later = await client.request<DraftPatchResult>({ action: "draft.patch", blockId: note.id, revision: note.revision, patches: [spanOf(note.text, "beans   here", "beans here")], mutation: TIDY });
    expect(later).toMatchObject({ outcome: "applied", edits: [{ route: "saved" }] });
    expect(door.requests.every(request => request.kind === "read")).toBe(true);
  }, 20_000);

  test("a slow door that applies a patch after the deadline is asked to take it back", async () => {
    const { store, client } = await service();
    const note = store.create("Morning plan");
    const live = "Morning plan\nbeans   here\nstill typing";
    const door = await fakeDoor(client, "door-slow", note.id, live, note.revision, { slowPatchMs: 3_000 });
    const result = await client.request<DraftPatchResult>({ action: "draft.patch", blockId: note.id, revision: note.revision, patches: [spanOf(live, "beans   here", "beans here")], mutation: TIDY });
    expect(result.outcome).toBe("proposed");
    await Bun.sleep(700);
    expect(door.requests.map(request => request.kind)).toEqual(expect.arrayContaining(["patch", "revert"]));
    expect(door.text).toBe(live);
    expect(store.require(note.id).text).toBe("Morning plan");
  }, 15_000);

  test("two doors holding drafts of one note: the patch goes to neither, and nothing is written", async () => {
    const { store, client } = await service();
    const note = store.create("Morning plan\nbeans   here");
    const one = await fakeDoor(client, "door-a2", note.id, note.text, note.revision);
    const two = await fakeDoor(client, "door-b2", note.id, note.text, note.revision);
    const result = await client.request<DraftPatchResult>({ action: "draft.patch", blockId: note.id, revision: note.revision, patches: [spanOf(note.text, "beans   here", "beans here")], mutation: TIDY });
    expect(result).toMatchObject({ outcome: "proposed", embedded: null });
    if (result.outcome === "proposed") expect(result.reason).toContain("more than one door");
    expect(one.text).toBe(note.text);
    expect(two.text).toBe(note.text);
    expect([...one.requests, ...two.requests].filter(request => request.kind === "patch" || request.kind === "embed")).toEqual([]);
    expect(store.require(note.id).text).toBe(note.text);
  });

  test("the guard sees the whole note: an edit inside a token, or a backtick that swallows one, is refused", async () => {
    expect(draftPatchTextPolicy("see [[Seed list]] now", "see [[Weed list]] now")).toContain("[[Seed list]]");
    expect(draftPatchTextPolicy("Plan and [kind::plan]", "Plan` and [kind::plan]")).toContain("[kind::plan]");
    expect(draftPatchTextPolicy("Two  beds ^beds", "Two beds ^beds")).toBeNull();
    const { store, client } = await service();
    const saved = store.create("Beds\nsee [[Seed list]] and the anchor ^beds\nthen `code` [kind::plan]");
    for (const [observed, replacement] of [["Seed", "Weed"], ["bed", "bad"], ["then", "then`"]] as const) {
      const now = store.require(saved.id);
      const result = await client.request<DraftPatchResult>({ action: "draft.patch", blockId: saved.id, revision: now.revision, patches: [spanOf(now.text, observed, replacement)], mutation: TIDY, policy: "prose" });
      expect(result.outcome).toBe("proposed");
    }
    expect(store.require(saved.id).text.split("\n!((")[0]).toBe(saved.text);
    // The same in a live draft: the door is never asked to patch.
    const held = store.create("Held");
    const live = "Held\nsee [[Seed list]] here";
    const door = await fakeDoor(client, "door-guard", held.id, live, held.revision);
    const refused = await client.request<DraftPatchResult>({ action: "draft.patch", blockId: held.id, revision: held.revision, patches: [spanOf(live, "Seed", "Weed")], mutation: TIDY, policy: "prose" });
    expect(refused.outcome).toBe("proposed");
    expect(door.requests.filter(request => request.kind === "patch")).toEqual([]);
    expect(door.text.startsWith(live)).toBe(true);
  });

  test("an agent can't force its own proposal; the person can, and only what the proposal shows", async () => {
    const { store, client } = await service();
    const note = store.create("Beds\nThe fence  bed. ^fence\n\n@tidy go");
    const refused = await client.request<DraftPatchResult>({ action: "draft.patch", blockId: note.id, revision: note.revision, patches: [spanOf(note.text, "The fence  bed. ^fence", "The fence bed.")], mark: { text: "@tidy go" }, mutation: TIDY, policy: "prose" });
    expect(refused.outcome).toBe("proposed");
    if (refused.outcome !== "proposed") return;
    await expect(client.request({ action: "draft.proposal.apply", proposalId: refused.proposalId, mutation: TIDY })).rejects.toThrow("only the person applies that anyway");
    expect(store.require(note.id).text).toContain("^fence");

    // A proposal whose text was changed so it shows something else than it holds isn't applied.
    const proposal = store.require(refused.proposalId);
    const tampered = store.update(proposal.id, proposal.text.replace("becomes:\n```\nThe fence bed.", "becomes:\n```\nThe fence bed. ^fence"), proposal.revision, { author: "agent", actorId: "tidy" });
    await expect(client.request({ action: "draft.proposal.apply", proposalId: tampered.id, mutation: { author: "user" } })).rejects.toThrow("no longer shows");
    store.update(proposal.id, proposal.text, tampered.revision, { author: "user" });
    await client.request({ action: "draft.proposal.apply", proposalId: proposal.id, mutation: { author: "user" } });
    expect(store.require(note.id).text).toContain("The fence bed.\n");
  });

  test("an agent's apply is a patch against the text now: prose only, above the mark", async () => {
    const { store, client } = await service();
    const note = store.create("Plan\nbeans   here\n\n@tidy go");
    const stale = await client.request<DraftPatchResult>({ action: "draft.patch", blockId: note.id, revision: note.revision + 3, patches: [spanOf(note.text, "beans   here", "beans here")], mark: { text: "@tidy go" }, mutation: TIDY });
    expect(stale.outcome).toBe("proposed");
    if (stale.outcome !== "proposed") return;
    const applied = await client.request<{ outcome: string }>({ action: "draft.proposal.apply", proposalId: stale.proposalId, mutation: TIDY });
    expect(applied.outcome).toBe("applied");
    expect(store.require(note.id).text).toStartWith("Plan\nbeans here\n");
  });

  test("a proposal's hidden patch has a size cap: a bigger patch is refused whole, and nothing is written", async () => {
    const { store, client } = await service();
    const big = "word ".repeat(Math.ceil(DRAFT_PROPOSAL_MAX_PAYLOAD / 5));
    const note = store.create(`Plan\n${big}`);
    await expect(client.request({ action: "draft.patch", blockId: note.id, revision: note.revision + 1, patches: [{ observed: big, replacement: big.toUpperCase() }], mutation: TIDY })).rejects.toThrow("too large to keep as a proposal");
    expect(store.require(note.id).text).toBe(`Plan\n${big}`);
    expect(store.require(note.id).revision).toBe(note.revision);
  });

  test("several notes apply together or not at all", async () => {
    const { store, client } = await service();
    const one = store.create("One\nbeans   here");
    const two = store.create("Two\npeas   there");
    const three = store.create("Three\nleeks   everywhere");
    const door = await fakeDoor(client, "door-5", three.id, three.text, three.revision);
    const edits = (twoRevision: number) => [
      { blockId: one.id, revision: store.require(one.id).revision, patches: [spanOf(one.text, "beans   here", "beans here")] },
      { blockId: two.id, revision: twoRevision, patches: [spanOf(two.text, "peas   there", "peas there")] },
      { blockId: three.id, revision: three.revision, patches: [spanOf(three.text, "leeks   everywhere", "leeks everywhere")] },
    ];
    const stale = await client.request<DraftPatchResult>({ action: "draft.patch", edits: edits(two.revision + 5), mutation: TIDY });
    expect(stale.outcome).toBe("proposed");
    // The proposal's embed lands in the first note; its own text is as it was.
    expect(store.require(one.id).text).toStartWith(one.text + "\n!((");
    expect(store.require(two.id).text).toBe(two.text);
    expect(door.text).toBe(three.text);
    // The saved notes are checked before any draft is patched, so the door was never asked to patch.
    expect(door.requests.filter(request => request.kind === "patch")).toEqual([]);

    const ok = await client.request<DraftPatchResult>({ action: "draft.patch", edits: edits(two.revision), mutation: TIDY });
    expect(ok).toMatchObject({ outcome: "applied", edits: [{ blockId: one.id, route: "saved" }, { blockId: two.id, route: "saved" }, { blockId: three.id, route: "draft" }] });
    expect(store.require(one.id).text).toStartWith("One\nbeans here\n!((");
    expect(store.require(two.id).text).toBe("Two\npeas there");
    expect(door.text).toBe("Three\nleeks everywhere");
  });

  test("a draft refusing its part reverts nothing it didn't do, and leaves every saved note alone", async () => {
    const { store, client } = await service();
    const one = store.create("One\nbeans   here");
    const two = store.create("Two\npeas   there");
    const doorA = await fakeDoor(client, "door-6", one.id, one.text, one.revision);
    await fakeDoor(client, "door-7", two.id, two.text, two.revision, { refuse: "the person is typing in it" });
    const result = await client.request<DraftPatchResult>({ action: "draft.patch", mutation: TIDY, edits: [
      { blockId: one.id, revision: one.revision, patches: [spanOf(one.text, "beans   here", "beans here")] },
      { blockId: two.id, revision: two.revision, patches: [spanOf(two.text, "peas   there", "peas there")] },
    ] });
    expect(result).toMatchObject({ outcome: "proposed", reason: "the person is typing in it" });
    expect(doorA.text).toStartWith(one.text + "\n!((");
    expect(doorA.requests.map(request => request.kind)).toEqual(expect.arrayContaining(["patch", "revert"]));
  });

  test("a hold needs a connected client, and an answer only counts from the client asked", async () => {
    const { store, client } = await service();
    const note = store.create("Note");
    await expect(client.request({ action: "drafts.hold", blockId: note.id, clientId: "nobody", revision: 1 })).rejects.toThrow("connected client");
    await expect(client.request({ action: "drafts.answer", requestId: "r-1", clientId: "nobody", answer: { applied: true } })).rejects.toThrow("No draft request waits");
  });
});

describe("the edit policy (the default)", () => {
  const AGENT = { author: "agent" as const, actorId: "claude-code" };
  const STATUS = [
    "Claude · now",
    "Working on the seed swap, see [[Seed Swap]]",
    "Next: label the trays",
    "Then: water the leeks",
    "Waiting on: compost delivery",
    "Blocked: nothing",
    "Mood: steady",
  ].join("\n");
  /** An agent's update of its own status page: six changes, the first of which drops an outbound link. */
  const sixChanges = (text: string) => [
    spanOf(text, "Working on the seed swap, see [[Seed Swap]]", "Seed swap sorted"),
    spanOf(text, "label the trays", "sow the peas"),
    spanOf(text, "water the leeks", "thin the carrots"),
    spanOf(text, "compost delivery", "nothing"),
    spanOf(text, "Blocked: nothing", "Blocked: rain"),
    spanOf(text, "Mood: steady", "Mood: busy"),
  ];
  const UPDATED = "Claude · now\nSeed swap sorted\nNext: sow the peas\nThen: thin the carrots\nWaiting on: nothing\nBlocked: rain\nMood: busy";

  test("a note the person is only viewing: six changes that drop a [[link]] apply as one attributed edit, no proposal", async () => {
    const { store, client } = await service();
    store.create("Seed Swap [page::seed swap]");
    const page = store.create(STATUS);
    const result = await client.request<DraftPatchResult>({ action: "draft.patch", blockId: page.id, revision: page.revision, patches: sixChanges(STATUS), mutation: AGENT });
    expect(result).toEqual({ outcome: "applied", edits: [{ blockId: page.id, route: "saved", revision: page.revision + 1 }] });
    expect(store.require(page.id).text).toBe(UPDATED);
    const feed = await client.request<{ changes: Array<{ blockId?: string; kind: string; actor?: { author: string; actorId?: string } }> }>({ action: "changes.since", sequence: 0 });
    expect(feed.changes.filter(change => change.blockId === page.id && change.kind === "edit").map(change => change.actor)).toEqual([{ author: "agent", actorId: "claude-code" }]);
    expect(store.children(page.id)).toEqual([]);
  });

  test("the same edit while the person holds a draft goes into the draft; a compare that fails is one proposal", async () => {
    const { store, client } = await service();
    const page = store.create(STATUS);
    const door = await fakeDoor(client, "door-status", page.id, STATUS, page.revision);
    const result = await client.request<DraftPatchResult>({ action: "draft.patch", blockId: page.id, revision: page.revision, patches: sixChanges(STATUS), mutation: AGENT });
    expect(result).toEqual({ outcome: "applied", edits: [{ blockId: page.id, route: "draft", holder: "door-status" }] });
    expect(door.text).toBe(UPDATED);
    expect(store.require(page.id).text).toBe(STATUS);

    // The person rewrote a line the patch reads: the compare fails, and the whole patch is one proposal.
    const other = store.create(STATUS);
    const typed = STATUS.replace("Mood: steady", "Mood: sleepy");
    const busy = await fakeDoor(client, "door-busy", other.id, typed, other.revision);
    const proposed = await client.request<DraftPatchResult>({ action: "draft.patch", blockId: other.id, revision: other.revision, patches: sixChanges(STATUS), mutation: AGENT });
    expect(proposed.outcome).toBe("proposed");
    if (proposed.outcome !== "proposed") return;
    expect(busy.text.split("\n!((")[0]).toBe(typed);
    const text = store.require(proposed.proposalId).text;
    expect(text).toStartWith("1 proposed edit (6 changes) from @claude-code: not applied, because ");
    expect(text.split("\n")[0]).toContain(" · A applies all [type::draft-proposal]");
    expect(text).toContain("its 6 changes applied together or not at all");
    expect(text).toContain("Change 1 of 6, in Claude · now: this");
    expect(text).toContain("Change 6 of 6, in Claude · now: this");
    expect(text).not.toMatch(/Proposed edit from/);
  });

  test("dropping a linked ^anchor or a [page::] is refused outright, nothing written, unless allowStructural", async () => {
    const { store, client } = await service();
    const page = store.create("Beds [page::beds]\nThe fence bed holds the beans. ^fence\nThe pond bed is empty.");
    store.create(`Plan\nsee ((${page.id}^fence))`);
    const patches = [spanOf(page.text, "pond bed is empty", "pond bed holds mint"), spanOf(page.text, "beans. ^fence", "beans.")];
    await expect(client.request({ action: "draft.patch", blockId: page.id, revision: page.revision, patches, mutation: AGENT }))
      .rejects.toThrow("Not applied, nothing was written: change 2 would drop ^fence (1 note links to it); keep it, or pass allowStructural: true");
    const pageLine = [spanOf(page.text, "Beds [page::beds]", "Beds")];
    await expect(client.request({ action: "draft.patch", blockId: page.id, revision: page.revision, patches: pageLine, mutation: AGENT }))
      .rejects.toThrow("it would drop [page::beds]");
    expect(store.require(page.id)).toMatchObject({ text: page.text, revision: page.revision });
    expect(store.children(page.id)).toEqual([]);

    // In a live draft the same: the door is never asked to patch, and no proposal is embedded.
    const door = await fakeDoor(client, "door-beds", page.id, page.text, page.revision);
    await expect(client.request({ action: "draft.patch", blockId: page.id, revision: page.revision, patches, mutation: AGENT })).rejects.toThrow("^fence");
    expect(door.requests.filter(request => request.kind === "patch" || request.kind === "embed")).toEqual([]);

    const allowed = await client.request<DraftPatchResult>({ action: "draft.patch", blockId: page.id, revision: page.revision, patches, mutation: AGENT, allowStructural: true });
    expect(allowed.outcome).toBe("applied");
    expect(door.text).toBe("Beds [page::beds]\nThe fence bed holds the beans.\nThe pond bed holds mint.");
  });

  test("an ^anchor nobody links to may go; a policy that isn't edit or prose is refused", async () => {
    const { store, client } = await service();
    const page = store.create("Beds\nThe fence bed. ^fence");
    const result = await client.request<DraftPatchResult>({ action: "draft.patch", blockId: page.id, revision: page.revision, patches: [spanOf(page.text, "bed. ^fence", "bed.")], mutation: AGENT });
    expect(result.outcome).toBe("applied");
    await expect(client.request({ action: "draft.patch", blockId: page.id, revision: page.revision + 1, patches: [spanOf("Beds\nThe fence bed.", "fence", "pond")], mutation: AGENT, policy: "tidy" as never }))
      .rejects.toThrow("policy is edit or prose");
  });

  test("the prose policy still refuses dropping a link: one proposal, naming the change at fault", async () => {
    const { store, client } = await service();
    const page = store.create(STATUS);
    const result = await client.request<DraftPatchResult>({ action: "draft.patch", blockId: page.id, revision: page.revision, patches: sixChanges(STATUS), mutation: AGENT, policy: "prose" });
    expect(result.outcome).toBe("proposed");
    if (result.outcome !== "proposed") return;
    expect(result.reason).toBe("change 1 would drop [[Seed Swap]]; a prose edit keeps them");
    expect(store.require(page.id).text).toBe(`${STATUS}\n!((${result.proposalId}))`);
    const proposal = store.require(result.proposalId);
    expect(proposal.text.split("\n")[0]).toBe("1 proposed edit (6 changes) from @claude-code: not applied, because change 1 would drop [[Seed Swap]]; a prose edit keeps them · A applies all [type::draft-proposal] [proposal-status::open]");
    expect(parseProposal(proposal.text)).toMatchObject({ policy: "prose" });
    // The person applies all of it anyway, as one edit.
    await client.request({ action: "draft.proposal.apply", proposalId: proposal.id, mutation: { author: "user" } });
    expect(store.require(page.id).text.split("\n!((")[0]).toBe(UPDATED);
    expect(store.require(proposal.id).text.split("\n")[0]).toBe("Applied anyway: 1 edit (6 changes) from @claude-code, which didn't apply at first because change 1 would drop [[Seed Swap]]; a prose edit keeps them [type::draft-proposal] [proposal-status::applied]");
  });
});
