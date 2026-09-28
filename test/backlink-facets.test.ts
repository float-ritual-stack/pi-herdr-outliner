import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_BACKLINK_FACET_RULES,
  humanizeBacklinkKind,
} from "../src/backlink-facets";
import { resolveBacklinkRelation } from "../src/backlinks";
import { OutlinerClient } from "../src/client";
import { OutlinerServer } from "../src/server";
import { requireCapabilities } from "../src/service-compatibility";
import { OutlinerStore } from "../src/store";
import { ROADMAP_WORK_STAGES, type BacklinkCollection, type BacklinkSource, type Block } from "../src/types";

// Fictional workspace: a garden-club ticket and the notes that mention it.

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function store(): OutlinerStore {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-backlink-facets-"));
  const result = new OutlinerStore(join(directory, "outliner.sqlite"));
  cleanups.push(() => {
    result.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return result;
}

function facetsOf(collection: BacklinkCollection, source: Block) {
  const found = collection.sources.find((candidate) => candidate.blockId === source.id);
  if (!found) throw new Error(`No backlink from ${source.text}`);
  return found.facets;
}

function comment(workspace: OutlinerStore, host: Block, body: string, requestId: string): Block {
  return workspace.createAnnotationBatch(requestId, [{
    operationId: "comment",
    type: "block-comment",
    input: { blockId: host.id, expectedRevision: host.revision, body, source: "user" },
  }]).annotations[0]!.block;
}

describe("backlink source facets", () => {
  test("a source's own type names its kind, with a humanized label", () => {
    const workspace = store();
    const target = workspace.create("Seed swap [page::Seed Swap]");
    const letter = workspace.create("Ask about tomatoes for [[Seed Swap]] [type::letter-draft]");
    const facets = facetsOf(workspace.queryBacklinks({ targetBlockId: target.id, limit: 10 }), letter);
    expect(facets).toMatchObject({ kind: "letter-draft", kindLabel: "Letter draft", placement: "other" });
  });

  test("an untyped block takes the type of its containing page, and stops at that page", () => {
    const workspace = store();
    const target = workspace.create("Seed swap [page::Seed Swap]");
    const typedOuter = workspace.create("Club archive [type::archive]");
    const meeting = workspace.create("Spring meeting [page::Spring meeting] [type::meeting]");
    const takeaway = workspace.create("Takeaways: [[Seed Swap]] needs a table", meeting.id);
    const plainPage = workspace.create("Loose page [page::Loose page]", typedOuter.id);
    const inside = workspace.create("Mentions [[Seed Swap]]", plainPage.id);
    const collection = workspace.queryBacklinks({ targetBlockId: target.id, limit: 10 });
    expect(facetsOf(collection, takeaway)).toMatchObject({ kind: "meeting", kindLabel: "Meeting" });
    // The typed block above the page does not leak through it.
    expect(facetsOf(collection, inside)).toMatchObject({ kind: "note", kindLabel: "Note" });
  });

  test("only a page is a day page: a day:: date on it, or an address that is exactly a date", () => {
    const workspace = store();
    const target = workspace.create("Seed swap [page::Seed Swap]");
    const datedPage = workspace.create("Journal [page::2031-04-03]");
    const inDatedPage = workspace.create("Watered, then [[Seed Swap]]", datedPage.id);
    const dayProperty = workspace.create("Tuesday [page::Tuesday notes] [day::2031-04-04]");
    const inDayProperty = workspace.create("Bring [[Seed Swap]] labels", dayProperty.id);
    // Not day pages: a date-prefixed slug page, and a day:: on a block that is not a page.
    const slug = workspace.create("Recap of [[Seed Swap]] [page::2031-04-04-club-recap]");
    const untypedDay = workspace.create("Checklist for [[Seed Swap]] [day::2031-04-02]");
    const collection = workspace.queryBacklinks({ targetBlockId: target.id, limit: 10 });
    for (const source of [inDatedPage, inDayProperty]) {
      expect(facetsOf(collection, source)).toMatchObject({ kind: "day-page", kindLabel: "Day page" });
    }
    expect(facetsOf(collection, slug)?.kind).toBe("note");
    expect(facetsOf(collection, untypedDay)?.kind).toBe("note");
  });

  test("every roadmap work stage, and todo/unprocessed, has a bucket", () => {
    const buckets = Object.values(DEFAULT_BACKLINK_FACET_RULES.stageBuckets).flat();
    for (const stage of ROADMAP_WORK_STAGES) expect(buckets).toContain(stage);
    expect(DEFAULT_BACKLINK_FACET_RULES.stageBuckets.waiting).toEqual(
      expect.arrayContaining(["later", "todo", "unprocessed"]),
    );
  });

  test("a child takes the stage of the block that gave it its kind, unless it has its own", () => {
    const workspace = store();
    const target = workspace.create("Seed swap [page::Seed Swap]");
    const letter = workspace.create("Letter [type::letter] [outbox::waiting]");
    const line = workspace.create("Mentions [[Seed Swap]]", letter.id);
    const doneLine = workspace.create("Sent part about [[Seed Swap]] [outbox::done]", letter.id);
    const collection = workspace.queryBacklinks({ targetBlockId: target.id, limit: 10 });
    expect(facetsOf(collection, line)).toMatchObject({
      kind: "letter", stage: { property: "outbox", value: "waiting", bucket: "waiting" },
    });
    expect(facetsOf(collection, doneLine)?.stage).toEqual({ property: "outbox", value: "done", bucket: "done" });
  });

  test("stage comes from the first configured property and buckets known values", () => {
    const workspace = store();
    const target = workspace.create("Seed swap [page::Seed Swap]");
    const waiting = workspace.create("Letter about [[Seed Swap]] [type::letter] [outbox::waiting]");
    const doing = workspace.create("Plan for [[Seed Swap]] [type::plan] [status::done] [work-stage::doing]");
    const odd = workspace.create("Idea for [[Seed Swap]] [type::plan] [stage::mulling]");
    const none = workspace.create("Note about [[Seed Swap]]");
    const collection = workspace.queryBacklinks({ targetBlockId: target.id, limit: 10 });
    expect(facetsOf(collection, waiting)?.stage).toEqual({ property: "outbox", value: "waiting", bucket: "waiting" });
    // work-stage precedes status in the rule table.
    expect(facetsOf(collection, doing)?.stage).toEqual({ property: "work-stage", value: "doing", bucket: "active" });
    expect(facetsOf(collection, odd)?.stage).toEqual({ property: "stage", value: "mulling" });
    expect(facetsOf(collection, none)?.stage).toBeUndefined();
  });

  test("marks the target itself and its descendants", () => {
    const workspace = store();
    const target = workspace.create("Seed swap, see [[Seed Swap]] [page::Seed Swap]");
    const child = workspace.create("Checklist for [[Seed Swap]]", target.id);
    const grandchild = workspace.create("Sub-step of [[Seed Swap]]", child.id);
    const elsewhere = workspace.create("Elsewhere [[Seed Swap]]");
    const collection = workspace.queryBacklinks({ targetBlockId: target.id, limit: 10 });
    expect(facetsOf(collection, target)?.placement).toBe("self");
    expect(facetsOf(collection, child)?.placement).toBe("descendant");
    expect(facetsOf(collection, grandchild)?.placement).toBe("descendant");
    expect(facetsOf(collection, elsewhere)?.placement).toBe("other");
  });

  test("comments report whether their thread is resolved; a reply follows its thread", () => {
    const workspace = store();
    const target = workspace.create("Seed swap [page::Seed Swap]");
    const host = workspace.create("Volunteer rota");
    const open = comment(workspace, host, "Who brings [[Seed Swap]] labels?", "open-comment");
    const hostAfter = workspace.get(host.id)!;
    const resolved = comment(workspace, hostAfter, "[[Seed Swap]] table booked", "resolved-comment");
    const reply = workspace.replyToAnnotation("reply", {
      annotationId: resolved.id, body: "Confirmed for [[Seed Swap]]", source: "user",
    }).annotations[0]!.block;
    workspace.setAnnotationLifecycle(
      { annotationId: resolved.id, lifecycle: "resolved" },
      { author: "user", actorId: "test" },
    );
    const collection = workspace.queryBacklinks({ targetBlockId: target.id, limit: 10 });
    expect(facetsOf(collection, open)).toMatchObject({ kind: "comment", kindLabel: "Comment", comment: { resolved: false } });
    expect(facetsOf(collection, resolved)).toMatchObject({ kind: "comment", comment: { resolved: true } });
    // The reply's own status stays open; the thread decides.
    expect(facetsOf(collection, reply)).toMatchObject({ kind: "comment", comment: { resolved: true } });
  });

  test("keeps the existing reference groups and timestamps beside the facets", () => {
    const workspace = store();
    workspace.configureWorkIdPrefix("GC");
    let target = workspace.create("Seed swap [page::Seed Swap]");
    target = workspace.allocateWorkId(target.id, target.revision).block;
    const source = workspace.create("Update: GC-001 and GC-001 and [[Seed Swap]]");
    const found = workspace.queryBacklinks({ targetBlockId: target.id, limit: 10 }).sources
      .find((candidate) => candidate.blockId === source.id)!;
    expect(found.referenceGroups).toEqual([
      { kind: "work-id", count: 2 },
      { kind: "page", count: 1 },
    ]);
    expect(found.updatedAt).toBe(source.updatedAt);
    expect(found.facets?.kind).toBe("note");
  });

  test("a malformed comment keeps its kind but gets no comment facet instead of failing the query", () => {
    const workspace = store();
    const target = workspace.create("Seed swap [page::Seed Swap]");
    const odd = workspace.create("Comment on [[Seed Swap]] [type::annotation] [annotation-status::archived]");
    const facets = facetsOf(workspace.queryBacklinks({ targetBlockId: target.id, limit: 10 }), odd);
    expect(facets?.kind).toBe("comment");
    expect(facets?.comment).toBeUndefined();
  });

  test("the rule table is data: another table changes kinds and stages without code", () => {
    const TARGET_ID = "0f3a3c52-8d5e-4b8e-9a53-6f1d2c7b9e10";
    const target: Block = {
      id: TARGET_ID, parentId: null, position: 0, text: "Target", revision: 1, author: "user",
      createdAt: "2031-01-01T00:00:00.000Z", updatedAt: "2031-01-01T00:00:00.000Z", properties: [],
    };
    const source: Block = {
      ...target, id: "source", text: `Mentions ((${TARGET_ID})) [category::parcel] [phase::shipped]`,
      properties: [{ key: "category", value: "parcel" }, { key: "phase", value: "shipped" }],
    };
    const collection = resolveBacklinkRelation({
      query: { targetBlockId: TARGET_ID, limit: 10 },
      target,
      orderedBlocks: [target, source],
      blocksById: new Map([[target.id, target], [source.id, source]]),
      addressTargets: new Map(),
      workIdPrefix: null,
      facetRules: {
        ...DEFAULT_BACKLINK_FACET_RULES,
        typeProperty: "category",
        kindLabels: { parcel: "Parcels" },
        stageProperties: ["phase"],
        stageBuckets: { ...DEFAULT_BACKLINK_FACET_RULES.stageBuckets, done: ["shipped"] },
      },
    });
    expect(collection.sources[0]!.facets).toEqual({
      kind: "parcel",
      kindLabel: "Parcels",
      placement: "other",
      stage: { property: "phase", value: "shipped", bucket: "done" },
    });
    expect(humanizeBacklinkKind("day_page-summary")).toBe("Day page summary");
  });
});

describe("backlink facet protocol", () => {
  async function service() {
    const directory = mkdtempSync(join(tmpdir(), "pi-outliner-backlink-facets-service-"));
    const workspace = new OutlinerStore(join(directory, "outliner.sqlite"));
    const socket = join(directory, "outliner.sock");
    const server = new OutlinerServer(workspace, socket);
    await server.start();
    cleanups.push(async () => {
      await server.close();
      workspace.close();
      rmSync(directory, { recursive: true, force: true });
    });
    return { workspace, client: new OutlinerClient(socket) };
  }

  test("the service advertises references.backlinks.facets and returns facets over the socket", async () => {
    const { workspace, client } = await service();
    const status = await client.requireCompatibleService(["references.backlinks.facets"]);
    expect(status.capabilities).toContain("references.backlinks.facets");
    expect(() => requireCapabilities({ ...status, capabilities: ["blocks.read"] }, ["references.backlinks.facets"]))
      .toThrow("references.backlinks.facets");

    const target = workspace.create("Seed swap [page::Seed Swap]");
    const source = workspace.create("Letter about [[Seed Swap]] [type::letter] [outbox::draft]");
    const collection = await client.request<BacklinkCollection>({
      action: "references.backlinks",
      query: { targetBlockId: target.id, limit: 10 },
    });
    expect(collection.sources[0]!.facets).toEqual({
      kind: "letter",
      kindLabel: "Letter",
      placement: "other",
      stage: { property: "outbox", value: "draft", bucket: "draft" },
    });
    // An older client reads the same fields it always did; facets are only added.
    const legacyFields: Array<keyof BacklinkSource> = [
      "blockId", "title", "parentContext", "createdAt", "updatedAt",
      "occurrenceCount", "referenceGroups", "occurrences", "occurrencesTruncated",
    ];
    for (const field of legacyFields) expect(collection.sources[0]).toHaveProperty(field);
    expect(collection.sources[0]).toMatchObject({ blockId: source.id, title: "Letter about [[Seed Swap]]", occurrenceCount: 1 });
  });
});
