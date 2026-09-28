import { describe, expect, test } from "bun:test";
import {
  backlinkGroupRows,
  backlinkView,
  DEFAULT_BACKLINK_VIEW_OPTIONS,
  nextBacklinkKindFilter,
  nextBacklinkSort,
  nextBacklinkStageFilter,
  parseBacklinkViewOptions,
  type BacklinkViewOptions,
} from "../src/backlink-view";
import type { BacklinkCollection, BacklinkSource, BacklinkSourceFacets } from "../src/types";

// A fictional garden-club ticket with twelve sources.
function source(
  blockId: string,
  title: string,
  updatedAt: string,
  facets: BacklinkSourceFacets | undefined,
): BacklinkSource {
  return {
    blockId,
    title,
    parentContext: "Club › Tickets",
    createdAt: `2031-01-${blockId.padStart(2, "0").slice(-2)}T00:00:00.000Z`,
    updatedAt,
    occurrenceCount: 1,
    referenceGroups: [{ kind: "work-id", count: 1 }],
    occurrences: [{ kind: "work-id", label: "GC-001", snippet: `${title} GC-001`, start: 0, end: 6 }],
    occurrencesTruncated: false,
    ...(facets ? { facets } : {}),
  };
}

const letter = (stage: "waiting" | "draft" | "done"): BacklinkSourceFacets => ({
  kind: "letter", kindLabel: "Letter", placement: "other",
  stage: { property: "outbox", value: stage, bucket: stage },
});

function collection(): BacklinkCollection {
  return {
    targetBlockId: "target",
    completeness: { kind: "complete" },
    sources: [
      source("1", "Thank-you note", "2031-02-01T00:00:00.000Z", letter("done")),
      source("2", "Ask for trays", "2031-02-02T00:00:00.000Z", letter("waiting")),
      source("3", "Fence quote", "2031-02-09T00:00:00.000Z", letter("done")),
      source("4", "Draft invite", "2031-02-03T00:00:00.000Z", letter("draft")),
      source("5", "Ticket itself", "2031-02-10T00:00:00.000Z", { kind: "note", kindLabel: "Note", placement: "self" }),
      source("6", "Its checklist", "2031-02-10T00:00:00.000Z", { kind: "note", kindLabel: "Note", placement: "descendant" }),
      source("7", "Old question", "2031-02-04T00:00:00.000Z", { kind: "comment", kindLabel: "Comment", placement: "other", comment: { resolved: true } }),
      source("8", "Open question", "2031-02-05T00:00:00.000Z", { kind: "comment", kindLabel: "Comment", placement: "other", comment: { resolved: false } }),
      source("9", "Monday", "2031-02-06T00:00:00.000Z", { kind: "day-page", kindLabel: "Day page", placement: "other" }),
      source("10", "Tuesday", "2031-02-11T00:00:00.000Z", { kind: "day-page", kindLabel: "Day page", placement: "other" }),
      source("11", "Planting plan", "2031-02-07T00:00:00.000Z", {
        kind: "plan", kindLabel: "Plan", placement: "other", stage: { property: "stage", value: "mulling" },
      }),
      source("12", "Status board", "2031-02-08T00:00:00.000Z", { kind: "status", kindLabel: "Status", placement: "other" }),
    ],
  };
}

const view = (options: Partial<BacklinkViewOptions> = {}) =>
  backlinkView(collection(), { ...DEFAULT_BACKLINK_VIEW_OPTIONS, ...options });

describe("backlink view defaults", () => {
  test("hides the target, its descendants and resolved comments, and the counts add up", () => {
    const result = view();
    expect(result.faceted).toBe(true);
    expect(result.total).toBe(12);
    expect(result.hiddenRelated).toBe(2);
    expect(result.hiddenResolved).toBe(1);
    expect(result.filtered).toBe(0);
    expect(result.matching.map((item) => item.title)).not.toContain("Ticket itself");
    expect(result.matching.map((item) => item.title)).not.toContain("Its checklist");
    expect(result.matching.map((item) => item.title)).not.toContain("Old question");
    expect(result.matching.length + result.hiddenRelated + result.hiddenResolved + result.filtered)
      .toBe(result.total);
  });

  test("groups by kind with stage counts; groups with open items lead, then the most recently updated", () => {
    const result = view();
    expect(result.groups.map((group) => [group.label, group.sources.length])).toEqual([
      ["Letter", 4],
      ["Day page", 2],
      ["Status", 1],
      ["Plan", 1],
      ["Comment", 1],
    ]);
    expect(result.groups[0]!.stageCounts).toEqual({ waiting: 1, draft: 1, done: 2 });
    expect(result.groups[0]!.openCount).toBe(2);
  });

  test("lists open items first inside a group, then by the chosen sort", () => {
    expect(view().groups[0]!.sources.map((item) => item.title)).toEqual([
      "Draft invite", "Ask for trays", "Fence quote", "Thank-you note",
    ]);
    expect(view({ sortField: "title", sortDirection: "asc" }).groups[0]!.sources.map((item) => item.title))
      .toEqual(["Ask for trays", "Draft invite", "Fence quote", "Thank-you note"]);
    expect(view({ sortField: "created", sortDirection: "desc" }).groups[1]!.sources.map((item) => item.title))
      .toEqual(["Tuesday", "Monday"]);
  });

  test("a collapsed group renders only its open rows; an expanded one renders all", () => {
    const letters = view().groups[0]!;
    expect(backlinkGroupRows(letters, false).map((item) => item.title)).toEqual(["Draft invite", "Ask for trays"]);
    expect(backlinkGroupRows(letters, true)).toHaveLength(4);
    expect(backlinkGroupRows(view().groups[1]!, false)).toEqual([]);
  });
});

describe("backlink view filters", () => {
  test("toggles reveal the hidden sources", () => {
    expect(view({ showRelated: true }).matching.map((item) => item.title)).toContain("Ticket itself");
    const resolved = view({ showResolved: true });
    expect(resolved.hiddenResolved).toBe(0);
    expect(resolved.matching.map((item) => item.title)).toContain("Old question");
  });

  test("kind, stage and text filters narrow the view and report what they excluded", () => {
    const kind = view({ kind: "day-page" });
    expect(kind.matching.map((item) => item.title)).toEqual(["Tuesday", "Monday"]);
    expect(kind.filtered).toBe(7);
    // The kind toggle still lists every kind while one is selected.
    expect(kind.kinds.map((item) => item.kind)).toEqual(["letter", "day-page", "status", "plan", "comment"]);

    expect(view({ stage: "open" }).matching.map((item) => item.title)).toEqual(["Draft invite", "Ask for trays"]);
    expect(view({ stage: "done" }).matching).toHaveLength(2);
    expect(view({ stage: "waiting" }).matching.map((item) => item.title)).toEqual(["Ask for trays"]);

    const text = view({ filter: "fence" });
    expect(text.matching.map((item) => item.title)).toEqual(["Fence quote"]);
    expect(text.matching.length + text.hiddenRelated + text.hiddenResolved + text.filtered).toBe(text.total);
    // Kind labels are searchable too.
    expect(view({ filter: "day page" }).matching).toHaveLength(2);
  });

  test("toggle order is stable", () => {
    expect(nextBacklinkSort("updated", "desc")).toEqual(["updated", "asc"]);
    expect(nextBacklinkSort("created", "asc")).toEqual(["title", "asc"]);
    expect(nextBacklinkSort("title", "desc")).toEqual(["updated", "desc"]);
    expect(nextBacklinkStageFilter("all")).toBe("open");
    expect(nextBacklinkStageFilter("done")).toBe("all");
    const kinds = [{ kind: "letter" }, { kind: "plan" }];
    expect(nextBacklinkKindFilter(null, kinds)).toBe("letter");
    expect(nextBacklinkKindFilter("plan", kinds)).toBeNull();
    expect(nextBacklinkKindFilter("gone", kinds)).toBe("letter");
  });
});

describe("backlink view without facets", () => {
  test("a service without the facets capability yields one flat list with nothing hidden", () => {
    const legacy = collection();
    legacy.sources = legacy.sources.map(({ facets: _facets, ...rest }) => rest);
    const result = backlinkView(legacy, DEFAULT_BACKLINK_VIEW_OPTIONS);
    expect(result.faceted).toBe(false);
    expect(result.groups).toEqual([]);
    expect(result.hiddenRelated + result.hiddenResolved).toBe(0);
    expect(result.matching).toHaveLength(12);
    expect(result.matching[0]!.title).toBe("Tuesday");
  });
});

test("Peek's launch options are validated", () => {
  expect(parseBacklinkViewOptions({ ...DEFAULT_BACKLINK_VIEW_OPTIONS })).toEqual(DEFAULT_BACKLINK_VIEW_OPTIONS);
  expect(() => parseBacklinkViewOptions({ ...DEFAULT_BACKLINK_VIEW_OPTIONS, sortField: "rank" })).toThrow("sort");
  expect(() => parseBacklinkViewOptions({ ...DEFAULT_BACKLINK_VIEW_OPTIONS, stage: "later" })).toThrow("stage");
  expect(() => parseBacklinkViewOptions({ ...DEFAULT_BACKLINK_VIEW_OPTIONS, showResolved: "yes" })).toThrow("booleans");
});
