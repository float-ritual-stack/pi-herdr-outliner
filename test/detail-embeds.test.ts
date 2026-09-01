import { expect, test } from "bun:test";
import type { RequestInput } from "../src/client";
import {
  detailEmbedIds,
  projectDetailRead,
  type DetailEmbedRequester,
} from "../src/detail-embeds";
import { parseProperties } from "../src/properties";
import type {
  Block,
  VisibleBlock,
  VisibleBlockCollection,
  WorkspaceSnapshot,
} from "../src/types";

const timestamp = "2026-08-29T00:00:00.000Z";

function block(id: string, text: string, properties: Block["properties"] = []): Block {
  return {
    id,
    parentId: null,
    position: 0,
    text,
    author: "user",
    createdAt: timestamp,
    updatedAt: timestamp,
    properties,
  };
}

function visible(source: Block): VisibleBlock {
  return { ...source, depth: 0, hasChildren: false, displayText: source.text };
}

function snapshot(blocks: readonly Block[]): WorkspaceSnapshot {
  const projected = blocks.map(visible);
  return {
    visible: { blocks: projected, completeness: { kind: "complete" } },
    physical: { blocks: projected, completeness: { kind: "complete" } },
    selection: { selected: null, ancestors: [], children: [] },
    virtualOccurrenceRanks: [],
    sequence: 1,
  };
}

class FakeRequester implements DetailEmbedRequester {
  readonly calls: RequestInput[] = [];

  constructor(
    private readonly blocks: Map<string, Block>,
    private readonly collections: Map<string, VisibleBlockCollection | Error>,
    private readonly getFailures = new Map<string, Error>(),
    private readonly snapshotFailure: Error | null = null,
  ) {}

  async request<T>(input: RequestInput): Promise<T> {
    this.calls.push(input);
    if (input.action === "workspace.snapshot") {
      if (this.snapshotFailure) throw this.snapshotFailure;
      return snapshot([...this.blocks.values()]) as T;
    }
    if (input.action === "get") {
      const failure = this.getFailures.get(input.blockId);
      if (failure) throw failure;
      const result = this.blocks.get(input.blockId);
      if (!result) throw new Error(`Block not found: ${input.blockId}`);
      return result as T;
    }
    if (input.action === "blocks.query") {
      const viewId = input.query.rankViewId ?? "";
      const result = this.collections.get(viewId);
      if (result instanceof Error) throw result;
      if (!result) throw new Error(`Unexpected query: ${viewId}`);
      return result as T;
    }
    throw new Error(`Unexpected action: ${input.action}`);
  }
}

function virtualBranch(id: string, query = "status=next", limit?: number): Block {
  return block(id, `View [type::virtual-branch] [query::${query}]${limit ? ` [limit::${limit}]` : ""}`, [
    { key: "type", value: "virtual-branch" },
    { key: "query", value: query },
    ...(limit ? [{ key: "limit", value: String(limit) }] : []),
  ]);
}

function relationView(id: string, text: string): Block {
  return block(id, text, parseProperties(text));
}

test("renders a bounded virtual-branch embed without changing authored source", async () => {
  const definition = virtualBranch("view-next", "status=next", 2);
  const first = block("result-one", "First !((nested-target)) [status::next]", [{ key: "status", value: "next" }]);
  const second = block("result-two", "Second [status::next]", [{ key: "status", value: "next" }]);
  const third = block("result-three", "Third [status::next]", [{ key: "status", value: "next" }]);
  const requester = new FakeRequester(
    new Map([definition, first, second, third].map((item) => [item.id, item])),
    new Map([[definition.id, {
      blocks: [visible(definition), visible(first), visible(second), visible(third)],
      completeness: { kind: "complete" },
    }]]),
  );
  const authored = `Recommendation\n!((view-next))\nConclusion`;

  const projection = await projectDetailRead(requester, authored);

  expect(authored).toBe(`Recommendation\n!((view-next))\nConclusion`);
  expect(projection.text).toBe([
    "Recommendation",
    "Embedded view: ((view-next)) · 2 results · TRUNCATED at 2",
    "- ((result-one))",
    "- ((result-two))",
    "Conclusion",
  ].join("\n"));
  expect(projection.embeds).toEqual([{
    blockId: definition.id,
    status: "truncated",
    count: 2,
    completeness: { kind: "truncated", limit: 2 },
  }]);
  expect(projection.embedRanges).toEqual([{ startLine: 1, endLine: 3 }]);
  expect(requester.calls).toContainEqual({
    action: "blocks.query",
    query: { filters: [{ key: "status", value: "next" }], rankViewId: definition.id, limit: 4 },
  });
  expect(requester.calls).not.toContainEqual({ action: "get", blockId: "nested-target" });
});

test("renders explicit empty, invalid, failed, missing, deleted, and ordinary states", async () => {
  const empty = virtualBranch("view-empty");
  const invalid = block("view-invalid", "Invalid [type::virtual-branch]", [
    { key: "type", value: "virtual-branch" },
  ]);
  const failed = virtualBranch("view-failed");
  const targetFailed = virtualBranch("view-target-failed");
  const deleted = {
    ...virtualBranch("view-trash"),
    deletedAt: timestamp,
    effectiveDeletedRootId: "view-trash",
  };
  const ordinary = block("ordinary-block", "Ordinary");
  const requester = new FakeRequester(
    new Map([empty, invalid, failed, targetFailed, deleted, ordinary].map((item) => [item.id, item])),
    new Map<string, VisibleBlockCollection | Error>([
      [empty.id, { blocks: [], completeness: { kind: "complete" } }],
      [failed.id, new Error("query backend unavailable\nretry later")],
    ]),
    new Map([[targetFailed.id, new Error("service transport unavailable")]]),
  );
  const source = [
    "!((view-empty))",
    "!((view-invalid))",
    "!((view-failed))",
    "!((view-target-failed))",
    "!((view-missing))",
    "!((view-trash))",
    "!((ordinary-block))",
  ].join("\n");

  const projection = await projectDetailRead(requester, source);

  expect(projection.embeds.map(({ status }) => status)).toEqual([
    "empty",
    "invalid",
    "failed",
    "failed",
    "missing",
    "deleted",
    "ready",
  ]);
  expect(projection.text).toContain("Embedded view: ((view-empty)) · EMPTY");
  expect(projection.text).toContain("Embedded view: ((view-invalid)) · CONFIG ERROR");
  expect(projection.text).toContain("Virtual branch query property must appear exactly once; found 0");
  expect(projection.text).toContain("Embedded view: ((view-failed)) · QUERY FAILED");
  expect(projection.text).toContain("!((view-target-failed)) · TARGET FAILED · service transport unavailable");
  expect(projection.text).toContain("query backend unavailable retry later");
  expect(projection.text).toContain("!((view-missing)) · MISSING TARGET");
  expect(projection.text).toContain("!((view-trash)) · IN TRASH");
  expect(projection.text).toContain("Embedded block: ((ordinary-block))\nOrdinary");
});

test("renders ordinary block Markdown without loading a workspace snapshot or nested embeds", async () => {
  const ordinary = block(
    "ordinary-block",
    "Ordinary title\n\nBody with **Markdown** and !((nested-target))",
  );
  const requester = new FakeRequester(
    new Map([[ordinary.id, ordinary]]),
    new Map(),
    new Map(),
    new Error("snapshot must not be loaded"),
  );

  const projection = await projectDetailRead(
    requester,
    "Before\n!((ordinary-block))\nAfter",
  );

  expect(projection).toEqual({
    text: [
      "Before",
      "Embedded block: ((ordinary-block))",
      "Ordinary title",
      "",
      "Body with **Markdown** and !((nested-target))",
      "After",
    ].join("\n"),
    embeds: [{ blockId: ordinary.id, status: "ready", count: 1 }],
    embedRanges: [{ startLine: 1, endLine: 4 }],
  });
  expect(requester.calls).not.toContainEqual({ action: "workspace.snapshot" });
  expect(requester.calls).not.toContainEqual({ action: "get", blockId: "nested-target" });
});

test("renders exact fragment slices with explicit fragment failures and no recursion", async () => {
  const target = block(
    "fragment-target",
    [
      "# Long source",
      "",
      "## Chosen section ^chosen-section",
      "Chosen body with !((nested-target)).",
      "",
      "### Nested section",
      "Nested body.",
      "",
      "## Outside section",
      "Outside body.",
      "",
      "Paragraph first line",
      "paragraph final line. ^paragraph-note",
      "",
      "Duplicate one. ^duplicate-note",
      "Duplicate two. ^duplicate-note",
    ].join("\n"),
  );
  const requester = new FakeRequester(new Map([[target.id, target]]), new Map());

  const projection = await projectDetailRead(requester, [
    `!((fragment-target^chosen-section))`,
    `!((fragment-target^paragraph-note))`,
    `!((fragment-target^missing-note))`,
    `!((fragment-target^duplicate-note))`,
  ].join("\n"));

  expect(projection.text).toBe([
    "Embedded fragment: ((fragment-target^chosen-section))",
    "## Chosen section",
    "Chosen body with !((nested-target)).",
    "",
    "### Nested section",
    "Nested body.",
    "Embedded fragment: ((fragment-target^paragraph-note))",
    "Paragraph first line",
    "paragraph final line.",
    "!((fragment-target^missing-note)) · MISSING FRAGMENT",
    "!((fragment-target^duplicate-note)) · DUPLICATE FRAGMENT",
  ].join("\n"));
  expect(projection.text).not.toContain("Outside body.");
  expect(projection.embeds).toEqual([
    {
      blockId: target.id,
      fragmentId: "chosen-section",
      status: "ready",
      count: 1,
    },
    {
      blockId: target.id,
      fragmentId: "paragraph-note",
      status: "ready",
      count: 1,
    },
    {
      blockId: target.id,
      fragmentId: "missing-note",
      status: "fragment-missing",
      count: 0,
    },
    {
      blockId: target.id,
      fragmentId: "duplicate-note",
      status: "fragment-duplicate",
      count: 0,
    },
  ]);
  expect(projection.embedRanges).toEqual([
    { startLine: 0, endLine: 5 },
    { startLine: 6, endLine: 8 },
    { startLine: 9, endLine: 9 },
    { startLine: 10, endLine: 10 },
  ]);
  expect(requester.calls).not.toContainEqual({ action: "get", blockId: "nested-target" });
  expect(requester.calls.filter((call) =>
    call.action === "get" && call.blockId === target.id
  )).toHaveLength(1);
});

test("renders bounded one-hop relation views over selected stable fragments", async () => {
  const source = block(
    "source-block",
    [
      "Roadmap source",
      "[depends-on::target-beta]",
      "[related-to::target-alpha]",
      "[depends-on::target-beta]",
      "[depends-on::missing-target]",
    ].join("\n"),
  );
  const targetBeta = block(
    "target-beta",
    [
      "# Beta",
      "## Description ^description",
      "Beta body with !((nested-target)).",
      "### Detail",
      "Nested detail.",
      "## Outside",
      "Must not project.",
    ].join("\n"),
  );
  const targetAlpha = block("target-alpha", "# Alpha\n\nNo selected fragment.");
  const embedded = relationView(
    "relation-embedded",
    [
      "Relations [type::relation-view]",
      "[source::embedding-source]",
      "[relations::depends-on, related-to]",
      "[fragment::description]",
      "[limit::2]",
    ].join("\n"),
  );
  const explicit = relationView(
    "relation-explicit",
    [
      "Dependencies [type::relation-view]",
      "[source::source-block]",
      "[relations::depends-on]",
      "[fragment::description]",
    ].join("\n"),
  );
  const requester = new FakeRequester(
    new Map([source, targetBeta, targetAlpha, embedded, explicit].map((item) => [item.id, item])),
    new Map(),
  );

  const projection = await projectDetailRead(
    requester,
    "!((relation-embedded))\n!((relation-explicit))",
    { hostBlockId: source.id },
  );

  expect(projection.text).toContain(
    "Embedded view: ((relation-embedded)) · RELATION · 2 targets · TRUNCATED at 2",
  );
  expect(projection.text).toContain([
    "- ((target-beta))",
    "  - ((target-beta^description))",
    "    ## Description",
    "    Beta body with !((nested-target)).",
    "    ### Detail",
    "    Nested detail.",
  ].join("\n"));
  expect(projection.text).toContain(
    "- ((target-alpha))\n  - ((target-alpha^description)) · MISSING FRAGMENT",
  );
  expect(projection.text).toContain(
    "- ((missing-target)) · MISSING TARGET",
  );
  expect(projection.text).not.toContain("Must not project.");
  expect(projection.embeds).toEqual([
    {
      blockId: embedded.id,
      status: "truncated",
      count: 2,
      completeness: { kind: "truncated", limit: 2 },
    },
    {
      blockId: explicit.id,
      status: "ready",
      count: 2,
      completeness: { kind: "complete" },
    },
  ]);
  expect(requester.calls.filter((call) =>
    call.action === "get" && call.blockId === targetBeta.id
  )).toHaveLength(1);
  expect(requester.calls).not.toContainEqual({ action: "get", blockId: "nested-target" });
  expect(projection.embedRanges).toEqual([
    { startLine: 0, endLine: 8 },
    { startLine: 9, endLine: 16 },
  ]);
});

test("hides fragment anchor markers only in the generated read projection", async () => {
  const requester = new FakeRequester(new Map(), new Map());
  const authored = "# Heading ^stable-heading\n\nParagraph ^stable-paragraph";

  const projection = await projectDetailRead(requester, authored);

  expect(projection).toEqual({
    text: "# Heading\n\nParagraph",
    embeds: [],
    embedRanges: [],
  });
  expect(authored).toContain("^stable-heading");
  expect(requester.calls).toEqual([]);
});

test("renders workspace projection failures instead of hiding the document", async () => {
  const definition = virtualBranch("view-next");
  const requester = new FakeRequester(
    new Map([[definition.id, definition]]),
    new Map(),
    new Map(),
    new Error("snapshot unavailable"),
  );

  const projection = await projectDetailRead(requester, "Before\n!((view-next))\nAfter");

  expect(projection.embeds).toEqual([{ blockId: "view-next", status: "failed", count: 0 }]);
  expect(projection.text).toBe(
    "Before\n!((view-next)) · PROJECTION FAILED · snapshot unavailable\nAfter",
  );
});

test("reuses a repeated target projection and bounds the embed count", async () => {
  const definition = virtualBranch("view-repeat");
  const requester = new FakeRequester(
    new Map([[definition.id, definition]]),
    new Map([[definition.id, { blocks: [], completeness: { kind: "complete" } }]]),
  );
  const source = Array.from({ length: 18 }, () => "!((view-repeat))").join("\n");

  const projection = await projectDetailRead(requester, source);

  expect(projection.embeds).toHaveLength(18);
  expect(projection.embeds.filter(({ status }) => status === "empty")).toHaveLength(16);
  expect(projection.embeds.filter(({ status }) => status === "limit")).toHaveLength(2);
  expect(requester.calls.filter(({ action }) => action === "get")).toHaveLength(1);
  expect(requester.calls.filter(({ action }) => action === "blocks.query")).toHaveLength(1);
  expect(detailEmbedIds(source)).toHaveLength(18);
});
