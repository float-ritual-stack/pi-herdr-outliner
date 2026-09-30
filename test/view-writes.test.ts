// views.planWrite (PIE-490): what moving a block into a saved view, or creating one there, must change.
// The planning is pure and tested on fictional definitions; the service test crosses a real socket.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutlinerClient } from "../src/client";
import { parseProperties } from "../src/properties";
import { OutlinerServer } from "../src/server";
import { OutlinerStore } from "../src/store";
import type { Block, OutlinerServiceStatus, ViewWritePlanResult } from "../src/types";
import { planCreateInView, planMoveIntoView, writeView, type WriteSubject } from "../src/view-writes";

const def = (name: string, query: string, extra = "") => {
  const text = `${name} [type::virtual-branch] [query::${query}]${extra ? ` ${extra}` : ""}`;
  return { id: `view-${name}`, text, properties: parseProperties(text) };
};
const view = (name: string, query: string, extra = "") => writeView(`view-${name}`, def(name, query, extra));
const note = (text: string, over: Partial<WriteSubject> = {}): WriteSubject => ({
  id: "n1", text, revision: 3, properties: parseProperties(text), createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", ...over,
});
const ALL_WORK = (stage: string) => `type=roadmap-item (project=pi-outliner OR project=ep0ch-door) work-stage=${stage}`;

describe("planning a move", () => {
  test("one clause: replace the differing value, at its token's ordinal", () => {
    expect(planMoveIntoView(view("Doing", "stage=doing"), note("Paint the shed [stage::queued]"))).toEqual({
      kind: "patch", revision: 3, changes: [{ key: "stage", to: "doing", from: "queued" }], operations: [{ op: "replace", ordinal: 0, value: "doing" }],
    });
  });
  test("several clauses: only the values that differ, appending what's missing", () => {
    const p = planMoveIntoView(view("Review", "stage=review track=door owner::sam"), note("Oil the gate [stage::queued] [track::door]"));
    expect(p).toMatchObject({ kind: "patch", changes: [{ key: "stage", to: "review", from: "queued" }, { key: "owner", to: "sam", from: null }] });
    expect(p.kind === "patch" && p.operations).toEqual([{ op: "replace", ordinal: 0, value: "review" }, { op: "append", key: "owner", value: "sam" }]);
  });
  test("child: clauses read the note's children as they are; a move patches only the note", () => {
    const closed = { childProperties: () => [parseProperties("Ticket [jira.status::Closed]")] };
    const drift = view("Drift", "status=done child:jira.status=Closed");
    expect(planMoveIntoView(drift, note("Depot [status::doing]", closed))).toMatchObject({ kind: "patch", changes: [{ key: "status", to: "done" }] });
    expect(planMoveIntoView(drift, note("Depot [status::doing]")).kind).toBe("refused");
    const notClosed = view("Open", "status=done NOT child:jira.status=Closed");
    expect(planMoveIntoView(notClosed, note("Depot [status::doing]", closed)).kind).toBe("refused");
    expect(planMoveIntoView(notClosed, note("Depot [status::doing]"))).toMatchObject({ kind: "patch" });
    expect(planMoveIntoView(drift, note("Depot [status::done]", closed))).toEqual({ kind: "already" });
  });
  test("values compare case-insensitively; a note already there is already there", () => {
    expect(planMoveIntoView(view("Done", "stage=done"), note("Mend [stage::Done]"))).toEqual({ kind: "already" });
  });
  test("a presence clause the note satisfies is fine; one it lacks is refused", () => {
    expect(planMoveIntoView(view("Mine", "owner stage=doing"), note("Mend [stage::queued] [owner::sam]")).kind).toBe("patch");
    expect(planMoveIntoView(view("Owned", "owner"), note("Mend [stage::queued]"))).toEqual({ kind: "refused", reason: "Owned asks for any owner:: value; a move can't choose one" });
  });
  test("two values for one key, or a note with two values, aren't guessed at", () => {
    expect(planMoveIntoView(view("Odd", "stage=a stage=b"), note("Mend [stage::queued]"))).toEqual({ kind: "refused", reason: "Odd asks for stage to be a and b at once; a move sets one value" });
    const p = planMoveIntoView(view("Done", "stage=done"), note("Mend [stage::queued] [stage::doing]"));
    expect(p.kind === "refused" && p.reason).toContain("the note has 2 stage:: values (queued, doing)");
  });
  test("an OR group must already hold after the patch; a note in one of its projects moves by the plain clause alone", () => {
    const doing = view("Doing", ALL_WORK("doing"));
    expect(planMoveIntoView(doing, note("Tune [type::roadmap-item] [project::ep0ch-door] [work-stage::queued]"))).toMatchObject({ kind: "patch", changes: [{ key: "work-stage", to: "doing", from: "queued" }] });
    expect(planMoveIntoView(doing, note("Tune [type::roadmap-item] [project::garden] [work-stage::queued]"))).toEqual({
      kind: "refused", reason: "Doing needs (project=pi-outliner OR project=ep0ch-door) and the note has project=garden; a move sets only the plain clauses beside it",
    });
  });
  test("an invalid view, a Trash view and a missing one are refused with the reason", () => {
    expect(planMoveIntoView(view("Weird", "stage=done or"), note("x"))).toMatchObject({ kind: "refused", reason: expect.stringContaining("Weird is invalid: Invalid virtual branch query") });
    expect(planMoveIntoView(view("Trash", "deleted=true type=card"), note("x [type::card]"))).toEqual({ kind: "refused", reason: "Trash's query selects Trash (deleted=true); a note goes there by trashing it, not by a write" });
    expect(planMoveIntoView(writeView("gone", undefined), note("x"))).toEqual({ kind: "refused", reason: "view gone is missing: Saved view not found in the active workspace" });
  });
});

describe("planning a new note", () => {
  test("born with the plain clauses; an OR group is left for the text or the create:: default", () => {
    expect(planCreateInView(view("Doing", "stage=doing track=door"), undefined)).toEqual({ kind: "create", born: [{ key: "stage", value: "doing" }, { key: "track", value: "door" }], defaults: [], needs: [], roadmap: false });
    expect(planCreateInView(view("Doing", ALL_WORK("doing")), undefined)).toEqual({
      kind: "create", born: [{ key: "type", value: "roadmap-item" }, { key: "work-stage", value: "doing" }], defaults: [], needs: ["(project=pi-outliner OR project=ep0ch-door)"], roadmap: true,
    });
    expect(planCreateInView(view("Queued", ALL_WORK("queued"), "[create::project=ep0ch-door]"), "")).toEqual({
      kind: "create", born: [{ key: "type", value: "roadmap-item" }, { key: "work-stage", value: "queued" }], defaults: [{ key: "project", value: "ep0ch-door" }], needs: [], roadmap: true,
    });
    for (const s of ["review", "validate", "done", "superseded"]) {
      expect(planCreateInView(view("Late", ALL_WORK(s)), undefined)).toEqual({ kind: "refused", reason: `Late lists work-stage=${s}: roadmap items are created in Queued or Doing, then moved` });
    }
    expect(planCreateInView(view("Odd", "stage=a stage=b"), undefined)).toEqual({ kind: "refused", reason: "Odd asks for stage to be a and b at once; a note has one value" });
    expect(planCreateInView(view("Old", "stage=doing created < 2020-01-01"), undefined)).toEqual({ kind: "refused", reason: "Old needs created < 2020-01-01, which a new note doesn't meet" });
    expect(planCreateInView(view("Clash", "stage=doing", "[create::stage=done]"), undefined)).toEqual({ kind: "refused", reason: "Clash's create:: default stage=done contradicts its query (stage=doing)" });
    expect(planCreateInView(view("Bin", "stage=doing", "[create::deleted=true]"), undefined)).toEqual({ kind: "refused", reason: "Bin's create:: default is unusable: deleted=true selects Trash; it isn't a property to set" });
    // Where a new note goes is the caller's choice: a create-parent the service can't resolve doesn't block planning.
    expect(planCreateInView(view("Doing", "stage=doing", "[create-parent::((not-a-block))]"), undefined).kind).toBe("create");
  });

  test("the text: needed properties go on the first line unless the text says so; a contradiction is refused; the whole query decides", () => {
    const doing = view("Doing", "type=task stage=doing");
    expect(planCreateInView(doing, "Mend the fence\nThe north side.")).toMatchObject({ text: "Mend the fence [type::task] [stage::doing]\nThe north side.", bornWith: [{ key: "type", value: "task" }, { key: "stage", value: "doing" }] });
    expect(planCreateInView(doing, "Mend the fence [stage::Doing]")).toMatchObject({ text: "Mend the fence [stage::Doing] [type::task]" });
    expect(planCreateInView(doing, "Mend the fence [stage::queued]")).toEqual({ kind: "refused", reason: "the text sets stage::queued, but Doing needs stage=doing" });
    const chores = view("Chores", "type=chore (area=kitchen OR area=garden) stage=todo", "[create::area=kitchen]");
    expect(planCreateInView(chores, "Weed the beds [area::garden]")).toMatchObject({ text: "Weed the beds [area::garden] [type::chore] [stage::todo]" });
    expect(planCreateInView(chores, "Wipe the counters")).toMatchObject({ text: "Wipe the counters [type::chore] [stage::todo] [area::kitchen]" });
    expect(planCreateInView(chores, "Sweep [area::attic]")).toEqual({ kind: "refused", reason: "Chores needs (area=kitchen OR area=garden) and the note would have area=attic" });
    // A token in a code span is text, as the service reads it: the view's property is still added.
    expect(planCreateInView(doing, "Explain `[stage::doing]`")).toMatchObject({ text: "Explain `[stage::doing]` [type::task] [stage::doing]" });
  });

  test("a roadmap item: typed tokens, else the view's clauses, else its default; missing fields named at once", () => {
    const queued = view("Queued", "type=roadmap-item work-stage=queued", "[create::project=ep0ch-door]");
    const DEP = "0a0b0c0d-1111-4222-8333-444455556666";
    expect(planCreateInView(queued, "Oil the hinges\nThe back door squeaks.")).toEqual({
      kind: "refused", reason: "Queued makes roadmap items through the workboard's allocator, which needs priority, arc and a track: add [priority::high|medium|low] [arc::…] [track::…] to the text",
    });
    const ok = planCreateInView(queued, `Oil the hinges [priority::Medium] [arc::home] [track::doors] [track::metal] [room::hall] [depends-on::((${DEP}))]\nThe back door squeaks.`);
    expect(ok.kind === "create" && ok.item).toEqual({ title: "Oil the hinges [room::hall]", body: "The back door squeaks.", priority: "medium", workStage: "queued", project: "ep0ch-door", arc: "home", tracks: ["doors", "metal"], dependsOn: [DEP] });
    expect(ok.kind === "create" && ok.text).toBeUndefined();
    expect(planCreateInView(queued, "Oil it [priority::low] [arc::a] [track::t]\nAfter [depends-on::((b-1))] lands.")).toEqual({ kind: "refused", reason: "[depends-on::((b-1))] on line 2 belongs to that line, not the item; put it on the title line" });
    // A bare property line in the preamble is the item's too: it goes to the allocator, not into the body.
    expect(planCreateInView(queued, "Oil it [arc::a] [track::t]\npriority:: high\nThe back door.")).toMatchObject({ item: { title: "Oil it", body: "The back door.", priority: "high" } });
    expect(planCreateInView(queued, "Oil it [priority::low] [arc::a] [track::t] [depends-on::((b-1))]")).toEqual({ kind: "refused", reason: "depends-on must be a block id (a UUID), not b-1" });
    expect(planCreateInView(queued, "Tune it [project::pi-outliner] [priority::low] [arc::a] [track::t]")).toMatchObject({ item: { project: "pi-outliner" } });
    expect(planCreateInView(queued, "Tune it [work-stage::doing] [priority::low] [arc::a] [track::t]")).toEqual({ kind: "refused", reason: "the text sets work-stage::doing, but Queued needs work-stage=queued" });
    expect(planCreateInView(queued, "Tune it [work-id::HOME-9] [priority::low] [arc::a] [track::t]")).toEqual({ kind: "refused", reason: "the workboard's allocator issues the work-id; take [work-id::] out of the text" });
    expect(planCreateInView(queued, "Tune it [priority::urgent] [arc::a] [track::t]")).toEqual({ kind: "refused", reason: "priority must be high, medium or low, not urgent" });
    const any = view("Everything", "type=roadmap-item");
    expect(planCreateInView(any, "Tune it [work-stage::done] [project::p] [priority::low] [arc::a] [track::t]")).toEqual({ kind: "refused", reason: "roadmap items aren't created in done: create in Queued or Doing, then move" });
  });
});

describe("the service", () => {
  test("views.planWrite and query.matches answer over the socket, read-only; ping reports the property grammar", async () => {
    const root = mkdtempSync(join(tmpdir(), "view-writes-"));
    const store = new OutlinerStore(join(root, "outline.sqlite"));
    const socket = join(root, "service.sock");
    const server = new OutlinerServer(store, socket);
    await server.start();
    const client = new OutlinerClient(socket);
    const create = (text: string) => client.request<Block>({ action: "create", text });
    try {
      const ping = await client.request<OutlinerServiceStatus>({ action: "ping" });
      expect(ping.capabilities).toEqual(expect.arrayContaining(["views.planWrite", "query.matches", "ping.propertyGrammar"]));
      expect(ping.propertyGrammar).toEqual({ version: 1 });
      const card = await create("Paint the shed [type::chore] [stage::todo]");
      const doing = await create("Doing [type::virtual-branch] [query::type=chore stage=doing]");
      const odd = await create("Odd [type::virtual-branch] [query::type=chore (area=garden OR area=kitchen)]");
      const before = await client.request<Block>({ action: "get", blockId: card.id });
      const moves = await client.request<ViewWritePlanResult>({ action: "views.planWrite", viewIds: [doing.id, odd.id, "missing-view"], blockId: card.id });
      expect(moves.revision).toBe(card.revision);
      expect(moves.plans.map(p => [p.viewId, p.plan.kind])).toEqual([[doing.id, "patch"], [odd.id, "refused"], ["missing-view", "refused"]]);
      const patch = moves.plans[0]!.plan;
      if (patch.kind !== "patch") throw new Error("unreachable");
      expect(await client.request<Block>({ action: "get", blockId: card.id })).toEqual(before);
      const moved = await client.request<Block>({ action: "properties.patch", blockId: card.id, expectedRevision: moves.revision!, operations: patch.operations, mutation: { author: "user" } });
      expect(moved.text).toBe("Paint the shed [type::chore] [stage::doing]");
      const again = await client.request<ViewWritePlanResult>({ action: "views.planWrite", viewIds: [doing.id], blockId: card.id });
      expect(again.plans[0]!.plan).toEqual({ kind: "already" });
      const born = await client.request<ViewWritePlanResult>({ action: "views.planWrite", viewIds: [doing.id], text: "Sweep the path" });
      expect(born.plans[0]!.plan).toMatchObject({ kind: "create", text: "Sweep the path [type::chore] [stage::doing]" });
      await expect(client.request({ action: "views.planWrite", viewIds: [doing.id] })).rejects.toThrow("exactly one of blockId or text");
      await expect(client.request({ action: "views.planWrite", viewIds: [doing.id], blockId: "nope" })).rejects.toThrow("Block not found");
      const other = await create("Water [type::chore] [area::garden]");
      const matches = await client.request<{ blockIds: string[] }>({ action: "query.matches", expression: "type=chore (stage=doing OR area=garden)", blockIds: [card.id, other.id, doing.id, "nope"] });
      expect(matches.blockIds).toEqual([card.id, other.id]);
      await expect(client.request({ action: "query.matches", expression: "deleted=true", blockIds: [] })).rejects.toThrow("deleted=true");
    } finally { await server.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
