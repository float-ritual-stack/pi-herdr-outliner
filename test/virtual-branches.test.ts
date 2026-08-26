import { describe, expect, test } from "bun:test";
import {
  buildPhysicalTreeRows,
  buildVirtualBranchCreationText,
  isVirtualBranchDefinition,
  isVirtualBranchOccurrence,
  parseVirtualBranchConfig,
  projectVirtualBranches,
  type VirtualBranchConfig,
} from "../src/virtual-branches";
import type { BlockProperty, VisibleBlock, VisibleBlockCollection } from "../src/types";

const timestamp = "2026-08-24T00:00:00.000Z";

function visibleBlock(
  id: string,
  properties: BlockProperty[] = [],
  overrides: Partial<VisibleBlock> = {},
): VisibleBlock {
  return {
    id,
    parentId: null,
    position: 0,
    text: id,
    author: "user",
    collapsed: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    properties,
    depth: 0,
    multilineExpanded: false,
    hasChildren: false,
    displayText: id,
    ...overrides,
  };
}

function complete(blocks: VisibleBlock[]): VisibleBlockCollection {
  return { blocks, completeness: { kind: "complete" } };
}

describe("virtual branch definitions", () => {
  test("builds identity-preserving physical rows and recognizes definition candidates", () => {
    const ordinary = visibleBlock("ordinary", [], { depth: 1, hasChildren: true });
    const definition = visibleBlock("view", [
      { key: "type", value: "virtual-branch" },
      { key: "query", value: "status=Next" },
    ]);

    const rows = buildPhysicalTreeRows([ordinary, definition]);

    expect(rows[0]).toEqual(expect.objectContaining({
      kind: "physical",
      rowId: "ordinary",
      canonicalId: "ordinary",
      block: ordinary,
      depth: 1,
      hasChildren: true,
    }));
    expect(rows[0]!.block).toBe(ordinary);
    expect(isVirtualBranchDefinition(ordinary)).toBe(false);
    expect(isVirtualBranchDefinition(definition)).toBe(true);
  });

  test("parses bounded query and creation configuration without coupling filters to statuses", () => {
    const parent = visibleBlock("inbox");
    const definition = visibleBlock("doing-view", [
      { key: "type", value: "virtual-branch" },
      { key: "query", value: "status=Doing project::float priority" },
      { key: "create", value: "status=Doing" },
      { key: "create-parent", value: parent.id },
      { key: "limit", value: "40" },
    ]);

    expect(parseVirtualBranchConfig(definition, [definition, parent])).toEqual({
      config: {
        viewId: "doing-view",
        query: "status=Doing project::float priority",
        filters: [
          { key: "status", value: "Doing" },
          { key: "project", value: "float" },
          { key: "priority" },
        ],
        limit: 40,
        create: { key: "status", value: "Doing" },
        createParentId: "inbox",
        readOnly: false,
      },
      configurationErrors: [],
      creationErrors: [],
    });
  });

  test("keeps missing creation settings read-only while retaining a valid query", () => {
    const definition = visibleBlock("done-view", [
      { key: "type", value: "virtual-branch" },
      { key: "query", value: "status=Done" },
    ]);

    const parsed = parseVirtualBranchConfig(definition, [definition]);

    expect(parsed.configurationErrors).toEqual([]);
    expect(parsed.creationErrors).toEqual([]);
    expect(parsed.config).toEqual(expect.objectContaining({
      filters: [{ key: "status", value: "Done" }],
      limit: 200,
      readOnly: true,
    }));
  });

  test("reports malformed definition and creation properties without mutating physical rows", async () => {
    const invalidDefinition = visibleBlock("invalid", [
      { key: "type", value: "virtual-branch" },
      { key: "query", value: "status=Next" },
      { key: "query", value: "status=Doing" },
      { key: "limit", value: "1001" },
    ]);
    const creationInvalid = visibleBlock("creation-invalid", [
      { key: "type", value: "virtual-branch" },
      { key: "query", value: "status=Next" },
      { key: "create", value: "status" },
      { key: "create-parent", value: "missing" },
    ]);
    let queryCalls = 0;

    const projection = await projectVirtualBranches(
      [invalidDefinition, creationInvalid],
      [invalidDefinition, creationInvalid],
      async () => {
        queryCalls += 1;
        return complete([]);
      },
    );

    expect(queryCalls).toBe(1);
    expect(projection.rows.map((row) => row.rowId)).toEqual(["invalid", "creation-invalid"]);
    expect(projection.rows[0]!.block).toBe(invalidDefinition);
    expect(projection.branchStates.get("invalid")).toEqual(expect.objectContaining({
      config: null,
      queried: false,
      count: 0,
      configurationErrors: [
        "Virtual branch query property must appear exactly once; found 2",
        "Virtual branch limit must be an integer from 1 through 1000",
      ],
    }));
    expect(projection.branchStates.get("creation-invalid")).toEqual(expect.objectContaining({
      queried: true,
      count: 0,
      creationErrors: [
        "Virtual branch create must contain exactly one property with a value",
        "Virtual branch create-parent block does not exist: missing",
      ],
      config: expect.objectContaining({ readOnly: true }),
    }));
  });
});

describe("virtual branch projection", () => {
  test("projects generic query results directly after each definition in physical order", async () => {
    const next = visibleBlock("next-view", [
      { key: "type", value: "virtual-branch" },
      { key: "query", value: "status=Next" },
    ], { depth: 1 });
    const doing = visibleBlock("doing-view", [
      { key: "type", value: "virtual-branch" },
      { key: "query", value: "status=Doing" },
    ], { depth: 1 });
    const nextCard = visibleBlock("next-card", [{ key: "status", value: "Next" }], {
      depth: 4,
      hasChildren: true,
      multilineExpanded: true,
    });
    const doingCard = visibleBlock("doing-card", [{ key: "status", value: "Doing" }], { depth: 2 });
    const after = visibleBlock("after");

    const projection = await projectVirtualBranches(
      [next, doing, nextCard, doingCard, after],
      [next, doing, nextCard, doingCard, after],
      async ({ filters, limit }) => {
        expect(limit).toBe(6);
        const status = filters?.[0]?.value;
        if (status === "Next") return complete([next, nextCard, nextCard]);
        if (status === "Doing") return complete([doingCard]);
        throw new Error(`Unexpected status: ${status}`);
      },
    );

    expect(projection.rows.map((row) => row.rowId)).toEqual([
      "next-view",
      "occurrence:next-view:next-card",
      "doing-view",
      "occurrence:doing-view:doing-card",
      "next-card",
      "doing-card",
      "after",
    ]);
    const occurrence = projection.rows[1]!;
    expect(isVirtualBranchOccurrence(occurrence)).toBe(true);
    if (!isVirtualBranchOccurrence(occurrence)) throw new Error("Expected occurrence");
    expect(occurrence).toEqual(expect.objectContaining({
      canonicalId: "next-card",
      viewId: "next-view",
      depth: 2,
      hasChildren: false,
      multilineExpanded: true,
    }));
    expect(occurrence.block).toBe(nextCard);
    expect(occurrence.block.parentId).toBe(nextCard.parentId);
    expect(projection.branchStates.get("next-view")).toEqual(expect.objectContaining({
      count: 1,
      queried: true,
      queryError: null,
      completeness: { kind: "complete" },
    }));
  });

  test("applies branch-local ranks before limits without changing another branch", async () => {
    const firstView = visibleBlock("first-view", [
      { key: "type", value: "virtual-branch" },
      { key: "query", value: "status=Next" },
      { key: "limit", value: "2" },
    ]);
    const secondView = visibleBlock("second-view", [
      { key: "type", value: "virtual-branch" },
      { key: "query", value: "status=Next" },
      { key: "limit", value: "2" },
    ]);
    const first = visibleBlock("first");
    const second = visibleBlock("second");
    const third = visibleBlock("third");
    const physical = [firstView, secondView, first, second, third];

    const projection = await projectVirtualBranches(
      physical,
      physical,
      async ({ limit }) => {
        expect(limit).toBe(6);
        return complete([first, second, third]);
      },
      [
        { viewId: firstView.id, blockId: second.id, rank: 0 },
        { viewId: firstView.id, blockId: first.id, rank: 1 },
      ],
    );

    function occurrenceIds(viewId: string): string[] {
      return projection.rows
        .filter(
          (row) => isVirtualBranchOccurrence(row) && row.viewId === viewId,
        )
        .map((row) => row.canonicalId);
    }
    expect(occurrenceIds(firstView.id)).toEqual([second.id, first.id]);
    expect(occurrenceIds(secondView.id)).toEqual([first.id, second.id]);
    expect(projection.branchStates.get(firstView.id)?.completeness).toEqual({
      kind: "truncated",
      limit: 2,
    });
  });

  test("does not query collapsed definitions", async () => {
    const collapsed = visibleBlock("collapsed-view", [
      { key: "type", value: "virtual-branch" },
      { key: "query", value: "status=Done" },
    ], { collapsed: true });

    const projection = await projectVirtualBranches([collapsed], [collapsed], async () => {
      throw new Error("collapsed branch queried");
    });

    expect(projection.rows.map((row) => row.rowId)).toEqual(["collapsed-view"]);
    expect(projection.branchStates.get("collapsed-view")).toEqual(expect.objectContaining({
      queried: false,
      count: 0,
      queryError: null,
      completeness: null,
    }));
  });

  test("captures query failures and enforces the configured result bound", async () => {
    const failed = visibleBlock("failed-view", [
      { key: "type", value: "virtual-branch" },
      { key: "query", value: "status=Next" },
    ]);
    const limited = visibleBlock("limited-view", [
      { key: "type", value: "virtual-branch" },
      { key: "query", value: "status=Doing" },
      { key: "limit", value: "2" },
    ]);
    const matches = [visibleBlock("one"), visibleBlock("two"), visibleBlock("three")];

    const physical = [failed, limited, ...matches];
    const projection = await projectVirtualBranches(physical, physical, async ({ filters }) => {
      if (filters?.[0]?.value === "Next") throw new Error("query service unavailable");
      return complete(matches);
    });

    expect(projection.branchStates.get("failed-view")).toEqual(expect.objectContaining({
      queried: true,
      queryError: "query service unavailable",
      count: 0,
      completeness: null,
    }));
    expect(projection.branchStates.get("limited-view")).toEqual(expect.objectContaining({
      queryError: null,
      count: 2,
      completeness: { kind: "truncated", limit: 2 },
    }));
    expect(projection.rows.filter(isVirtualBranchOccurrence).map((row) => row.rowId)).toEqual([
      "occurrence:limited-view:one",
      "occurrence:limited-view:two",
    ]);
  });

  test("excludes the definition before applying the configured occurrence limit", async () => {
    const definition = visibleBlock("self-view", [
      { key: "type", value: "virtual-branch" },
      { key: "query", value: "status=next" },
      { key: "limit", value: "2" },
    ]);
    const first = visibleBlock("first");
    const second = visibleBlock("second");
    const physical = [definition, first, second];

    const projection = await projectVirtualBranches(physical, physical, async ({ limit }) => {
      expect(limit).toBe(4);
      return complete([definition, first, second]);
    });

    expect(projection.rows.filter(isVirtualBranchOccurrence).map((row) => row.canonicalId)).toEqual([
      "first",
      "second",
    ]);
    expect(projection.branchStates.get("self-view")?.completeness).toEqual({ kind: "complete" });
  });

  test("validates creation parents against the complete physical collection", async () => {
    const definition = visibleBlock("view", [
      { key: "type", value: "virtual-branch" },
      { key: "query", value: "status=next" },
      { key: "create", value: "status=next" },
      { key: "create-parent", value: "hidden-parent" },
    ]);
    const hiddenParent = visibleBlock("hidden-parent");

    const projection = await projectVirtualBranches(
      [definition],
      [definition, hiddenParent],
      async () => complete([]),
    );

    expect(projection.branchStates.get("view")?.config).toEqual(expect.objectContaining({
      createParentId: "hidden-parent",
      readOnly: false,
    }));
    expect(projection.branchStates.get("view")?.creationErrors).toEqual([]);
  });
});

describe("virtual branch creation text", () => {
  const writableConfig: VirtualBranchConfig = {
    viewId: "doing-view",
    query: "status=Doing",
    filters: [{ key: "status", value: "Doing" }],
    limit: 200,
    create: { key: "status", value: "Doing" },
    createParentId: "inbox",
    readOnly: false,
  };

  test("appends or replaces the creation property through the property patcher", () => {
    expect(buildVirtualBranchCreationText("New task\nDetails", writableConfig)).toBe(
      "New task\n[status::Doing]\nDetails",
    );
    expect(buildVirtualBranchCreationText("New task [status::Next]", writableConfig)).toBe(
      "New task [status::Doing]",
    );
    expect(buildVirtualBranchCreationText("`[status::literal]`", writableConfig)).toBe(
      "`[status::literal]`\n[status::Doing]",
    );
  });

  test("rejects read-only branches and ambiguous creation text", () => {
    expect(() => buildVirtualBranchCreationText("New task", {
      ...writableConfig,
      createParentId: null,
      readOnly: true,
    })).toThrow("Virtual branch is read-only");
    expect(() => buildVirtualBranchCreationText(
      "[status::Next] [status::Done]",
      writableConfig,
    )).toThrow("more than one status property");
  });
});
