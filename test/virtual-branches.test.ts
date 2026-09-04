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
    createdAt: timestamp,
    updatedAt: timestamp,
    properties,
    depth: 0,
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
        sort: null,
        limit: 40,
        create: { key: "status", value: "Doing" },
        createParentId: "inbox",
        readOnly: false,
      },
      configurationErrors: [],
      creationErrors: [],
    });
  });

  test("preserves exact spaced values in durable virtual branch queries", () => {
    const definition = visibleBlock("spaced-view", [
      { key: "type", value: "virtual-branch" },
      { key: "query", value: 'status="in progress" project=pi-outliner' },
    ]);

    const parsed = parseVirtualBranchConfig(definition, [definition]);
    expect(parsed.configurationErrors).toEqual([]);
    expect(parsed.config).toEqual(expect.objectContaining({
      query: 'status="in progress" project=pi-outliner',
      filters: [
        { key: "status", value: "in progress" },
        { key: "project", value: "pi-outliner" },
      ],
    }));
  });

  test("parses created and updated sorting with explicit or default direction", () => {
    const newestUpdated = visibleBlock("newest-updated", [
      { key: "type", value: "virtual-branch" },
      { key: "query", value: "status=Done" },
      { key: "sort", value: "updated" },
    ]);
    expect(parseVirtualBranchConfig(newestUpdated, [newestUpdated]).config?.sort).toEqual({
      field: "updated",
      direction: "desc",
    });

    const oldestCreated = visibleBlock("oldest-created", [
      { key: "type", value: "virtual-branch" },
      { key: "query", value: "status=Done" },
      { key: "sort", value: "created" },
      { key: "direction", value: "asc" },
    ]);
    expect(parseVirtualBranchConfig(oldestCreated, [oldestCreated]).config?.sort).toEqual({
      field: "created",
      direction: "asc",
    });
  });

  test("rejects invalid or unpaired virtual branch sort properties", () => {
    const invalid = visibleBlock("invalid-sort", [
      { key: "type", value: "virtual-branch" },
      { key: "query", value: "status=Done" },
      { key: "sort", value: "title" },
      { key: "direction", value: "newest" },
    ]);
    expect(parseVirtualBranchConfig(invalid, [invalid]).configurationErrors).toEqual([
      "Virtual branch sort must be created or updated: title",
      "Virtual branch direction must be asc or desc: newest",
    ]);

    const orphanDirection = visibleBlock("orphan-direction", [
      { key: "type", value: "virtual-branch" },
      { key: "query", value: "status=Done" },
      { key: "direction", value: "desc" },
    ]);
    expect(parseVirtualBranchConfig(orphanDirection, [orphanDirection]).configurationErrors)
      .toContain("Virtual branch direction requires a sort property");
  });

  test("reports positioned diagnostics for malformed quoted queries", () => {
    const definition = visibleBlock("malformed-view", [
      { key: "type", value: "virtual-branch" },
      { key: "query", value: 'status="in progress' },
    ]);

    const parsed = parseVirtualBranchConfig(definition, [definition]);
    expect(parsed.config).toBeNull();
    expect(parsed.configurationErrors).toEqual([
      "Invalid virtual branch query: Unterminated quoted filter value at character 8",
    ]);
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
    });
    const doingCard = visibleBlock("doing-card", [{ key: "status", value: "Doing" }], { depth: 2 });
    const after = visibleBlock("after");

    const projection = await projectVirtualBranches(
      [next, doing, nextCard, doingCard, after],
      [next, doing, nextCard, doingCard, after],
      async ({ filters, limit, rankViewId }) => {
        expect(limit).toBe(1_000);
        const status = filters?.[0]?.value;
        if (status === "Next") {
          expect(rankViewId).toBe(next.id);
          return complete([next, nextCard, nextCard]);
        }
        if (status === "Doing") {
          expect(rankViewId).toBe(doing.id);
          return complete([doingCard]);
        }
        throw new Error(`Unexpected status: ${status}`);
      },
      [],
      {
        collapsedBlockIds: new Set(),
        multilineExpandedRowIds: new Set(["occurrence:next-view:next-card"]),
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
    expect(projection.physicalRowCount).toBe(5);
    expect(projection.occurrenceRowCount).toBe(2);
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
      async ({ limit, rankViewId }) => {
        expect(limit).toBe(1_000);
        expect(rankViewId === firstView.id || rankViewId === secondView.id).toBe(true);
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

  test("uses timestamp query ordering instead of persisted manual ranks", async () => {
    const sortedView = visibleBlock("sorted-view", [
      { key: "type", value: "virtual-branch" },
      { key: "query", value: "status=Done" },
      { key: "sort", value: "updated" },
      { key: "direction", value: "desc" },
      { key: "limit", value: "2" },
    ]);
    const newest = visibleBlock("newest");
    const older = visibleBlock("older");
    const projection = await projectVirtualBranches(
      [sortedView],
      [sortedView, newest, older],
      async (query) => {
        expect(query).toEqual({
          filters: [{ key: "status", value: "Done" }],
          sort: { field: "updated", direction: "desc" },
          limit: 1_000,
        });
        return complete([newest, older]);
      },
      [{ viewId: sortedView.id, blockId: older.id, rank: 0 }],
    );

    expect(
      projection.rows
        .filter((row) => isVirtualBranchOccurrence(row))
        .map((row) => row.canonicalId),
    ).toEqual([newest.id, older.id]);
  });

  test("allocates collapsed definitions independently before applying disclosure", async () => {
    const collapsed = visibleBlock("collapsed-view", [
      { key: "type", value: "virtual-branch" },
      { key: "query", value: "status=Done" },
    ]);
    const match = visibleBlock("match");
    let queryCalls = 0;

    const projection = await projectVirtualBranches(
      [collapsed],
      [collapsed, match],
      async ({ limit }) => {
        queryCalls += 1;
        expect(limit).toBe(1_000);
        return complete([match]);
      },
      [],
      {
        collapsedBlockIds: new Set([collapsed.id]),
        multilineExpandedRowIds: new Set(),
      },
    );

    expect(queryCalls).toBe(1);
    expect(projection.rows.map((row) => row.rowId)).toEqual(["collapsed-view"]);
    expect(projection.occurrenceRowCount).toBe(0);
    expect(projection.branchStates.get("collapsed-view")).toEqual(expect.objectContaining({
      queried: true,
      count: 1,
      descendantCount: 0,
      queryError: null,
      completeness: { kind: "complete" },
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
      truncation: { rootQuery: true, depth: false, budget: false },
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
      expect(limit).toBe(1_000);
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

  test("keeps contextual identity while preserving a descendant as an independent root", async () => {
    const definition = visibleBlock("view", [
      { key: "type", value: "virtual-branch" },
      { key: "query", value: "status=next" },
    ]);
    const root = visibleBlock("root", [], { hasChildren: true });
    const child = visibleBlock("child", [], {
      parentId: root.id,
      position: 0,
      depth: 1,
      hasChildren: true,
    });
    const grandchild = visibleBlock("grandchild", [], {
      parentId: child.id,
      position: 0,
      depth: 2,
      hasChildren: true,
    });
    const tooDeep = visibleBlock("too-deep", [], {
      parentId: grandchild.id,
      position: 0,
      depth: 3,
    });
    const inertDefinition = visibleBlock("inert-view", [
      { key: "type", value: "virtual-branch" },
      { key: "query", value: "status=other" },
    ], {
      parentId: root.id,
      position: 1,
      depth: 1,
      hasChildren: true,
    });
    const inertChild = visibleBlock("inert-child", [], {
      parentId: inertDefinition.id,
      depth: 2,
    });
    const physical = [
      definition,
      root,
      child,
      grandchild,
      tooDeep,
      inertDefinition,
      inertChild,
    ];

    const projection = await projectVirtualBranches(
      [definition, root],
      physical,
      async () => complete([root, child]),
    );
    const occurrences = projection.rows.filter(isVirtualBranchOccurrence);

    expect(occurrences.map((row) => row.rowId)).toEqual([
      "occurrence:view:root",
      "occurrence:view:root:child",
      "occurrence:view:root:grandchild",
      "occurrence:view:root:inert-view",
      "occurrence:view:child",
      "occurrence:view:child:grandchild",
      "occurrence:view:child:too-deep",
    ]);
    expect(occurrences[1]).toEqual(expect.objectContaining({
      canonicalId: child.id,
      matchRootCanonicalId: root.id,
      parentRowId: "occurrence:view:root",
      relativeDepth: 1,
      hasChildren: true,
    }));
    expect(occurrences[4]).toEqual(expect.objectContaining({
      canonicalId: child.id,
      matchRootCanonicalId: child.id,
      parentRowId: definition.id,
      relativeDepth: 0,
      hasChildren: true,
    }));
    expect(occurrences.some((row) => row.canonicalId === inertChild.id)).toBe(false);
    expect(occurrences.some((row) =>
      row.matchRootCanonicalId === root.id && row.canonicalId === tooDeep.id
    )).toBe(false);
    expect(projection.branchStates.get(definition.id)).toEqual(expect.objectContaining({
      count: 2,
      descendantCount: 5,
      truncation: { rootQuery: false, depth: true, budget: false },
    }));
  });

  test("reserves roots before deterministic descendant allocation independent of disclosure", async () => {
    const definition = visibleBlock("budget-view", [
      { key: "type", value: "virtual-branch" },
      { key: "query", value: "status=next" },
      { key: "limit", value: "2" },
    ]);
    const firstRoot = visibleBlock("first-root", [], { hasChildren: true });
    const secondRoot = visibleBlock("second-root", [], { hasChildren: true });
    const firstChildren = Array.from({ length: 600 }, (_, index) =>
      visibleBlock(`first-${index}`, [], {
        parentId: firstRoot.id,
        position: index,
        depth: 1,
      })
    );
    const secondChildren = Array.from({ length: 600 }, (_, index) =>
      visibleBlock(`second-${index}`, [], {
        parentId: secondRoot.id,
        position: index,
        depth: 1,
      })
    );
    const physical = [definition, firstRoot, ...firstChildren, secondRoot, ...secondChildren];
    const query = async () => complete([firstRoot, secondRoot]);

    const expanded = await projectVirtualBranches(physical, physical, query);
    const collapsed = await projectVirtualBranches(
      physical,
      physical,
      query,
      [],
      {
        collapsedBlockIds: new Set(),
        collapsedOccurrenceRowIds: new Set(["occurrence:budget-view:first-root"]),
        multilineExpandedRowIds: new Set(),
      },
    );
    const expandedOccurrences = expanded.rows.filter(isVirtualBranchOccurrence);
    const collapsedOccurrences = collapsed.rows.filter(isVirtualBranchOccurrence);

    expect(expandedOccurrences).toHaveLength(1_000);
    expect(expandedOccurrences[0]?.canonicalId).toBe(firstRoot.id);
    expect(expandedOccurrences[601]?.canonicalId).toBe(secondRoot.id);
    expect(expandedOccurrences.at(-1)?.canonicalId).toBe("second-397");
    expect(collapsedOccurrences.map((row) => row.rowId)).toEqual(
      expandedOccurrences
        .filter((row) =>
          row.rowId === "occurrence:budget-view:first-root" ||
          row.matchRootCanonicalId !== firstRoot.id
        )
        .map((row) => row.rowId),
    );
    expect(collapsedOccurrences[0]).toEqual(expect.objectContaining({
      rowId: "occurrence:budget-view:first-root",
      collapsed: true,
      hasChildren: true,
    }));
    expect(expanded.branchStates.get(definition.id)).toEqual(expect.objectContaining({
      count: 2,
      descendantCount: 998,
      truncation: { rootQuery: false, depth: false, budget: true },
    }));
    expect(collapsed.branchStates.get(definition.id)).toEqual(
      expanded.branchStates.get(definition.id),
    );
  });

  test("reuses one bounded canonical context traversal across branches with the same root", async () => {
    const firstView = visibleBlock("first-view", [
      { key: "type", value: "virtual-branch" },
      { key: "query", value: "status=next" },
    ]);
    const secondView = visibleBlock("second-view", [
      { key: "type", value: "virtual-branch" },
      { key: "query", value: "status=next" },
    ]);
    const root = visibleBlock("shared-root", [], { hasChildren: true });
    const child = visibleBlock("shared-child", [], {
      parentId: root.id,
      depth: 1,
      hasChildren: true,
    });
    const grandchild = visibleBlock("shared-grandchild", [], {
      parentId: child.id,
      depth: 2,
    });
    let childPropertyReads = 0;
    let grandchildPropertyReads = 0;
    Object.defineProperty(child, "properties", {
      configurable: true,
      get() {
        childPropertyReads += 1;
        return [];
      },
    });
    Object.defineProperty(grandchild, "properties", {
      configurable: true,
      get() {
        grandchildPropertyReads += 1;
        return [];
      },
    });
    const physical = [firstView, secondView, root, child, grandchild];

    const projection = await projectVirtualBranches(
      [firstView, secondView],
      physical,
      async () => complete([root]),
    );

    expect(projection.branchStates.get(firstView.id)?.descendantCount).toBe(2);
    expect(projection.branchStates.get(secondView.id)?.descendantCount).toBe(2);
    expect(childPropertyReads).toBe(1);
    expect(grandchildPropertyReads).toBe(1);
  });
});

describe("virtual branch creation text", () => {
  const writableConfig: VirtualBranchConfig = {
    viewId: "doing-view",
    query: "status=Doing",
    filters: [{ key: "status", value: "Doing" }],
    sort: null,
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
