import { describe, expect, test } from "bun:test";
import {
  focusBlockByQuery,
  formatBlockFocusMatch,
  rankBlockFocusMatches,
  resolveBlockFocus,
  uniqueBlockFocusIdentifier,
} from "../src/block-focus";
import type { RequestInput } from "../src/client";
import type { VisibleBlock, WorkspaceSnapshot } from "../src/types";

function block(id: string, text: string, position = 0): VisibleBlock {
  return {
    id,
    parentId: null,
    position,
    text,
    author: "user",
    collapsed: false,
    createdAt: "created",
    updatedAt: "updated",
    properties: [],
    depth: 0,
    multilineExpanded: false,
    hasChildren: false,
    displayText: text,
  };
}

const roadmap = block(
  "40bd0864-913a-4537-9535-8f96e1b63ef7",
  "Roadmap review after the graveyard walk [type::roadmap-review]",
);
const other = block(
  "40bd9999-1111-4222-8333-444455556666",
  "Another roadmap note",
  1,
);
const blocks = [roadmap, other, block("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "Fantasia note necromancy", 2)];

describe("block focus resolution", () => {
  test("prefers exact IDs, unique prefixes, and exact title phrases", () => {
    expect(resolveBlockFocus(blocks, roadmap.id)).toMatchObject({
      kind: "match",
      match: { block: { id: roadmap.id }, kind: "exact-id" },
    });
    expect(resolveBlockFocus(blocks, "40bd0864")).toMatchObject({
      kind: "match",
      match: { block: { id: roadmap.id }, kind: "id-prefix" },
    });
    expect(resolveBlockFocus(blocks, "Roadmap review after the graveyard walk")).toMatchObject({
      kind: "match",
      match: { block: { id: roadmap.id }, kind: "exact-title" },
    });
  });

  test("keeps duplicate exact titles ambiguous", () => {
    const duplicates = [
      block("11111111-1111-4111-8111-111111111111", "Same title"),
      block("22222222-2222-4222-8222-222222222222", "Same title"),
    ];
    const resolution = resolveBlockFocus(duplicates, "Same title");
    expect(resolution.kind).toBe("ambiguous");
    expect(resolution.matches).toHaveLength(2);
  });

  test("reports ambiguous shared prefixes before applying the display limit", () => {
    const resolution = resolveBlockFocus(blocks, "40bd");
    expect(resolution.kind).toBe("ambiguous");
    expect(resolution.matches.map((match) => match.block.id).sort()).toEqual([
      roadmap.id,
      other.id,
    ]);

    const limited = resolveBlockFocus(blocks, "40bd", 1);
    expect(limited.kind).toBe("ambiguous");
    expect(limited.matches).toHaveLength(1);
  });

  test("extends colliding convenience IDs until each candidate is unique", () => {
    const collisions = [
      block("deadbeef-1111-4222-8333-444455556666", "First"),
      block("deadbeef-2222-4333-8444-555566667777", "Second"),
    ];
    const matches = rankBlockFocusMatches(collisions, "deadbeef");
    expect(matches.map((match) => uniqueBlockFocusIdentifier(match.block.id, matches))).toEqual([
      "deadbeef-1",
      "deadbeef-2",
    ]);
  });

  test("ranks token and subsequence fuzzy content matches", () => {
    expect(rankBlockFocusMatches(blocks, "graveyard roadmap")[0]).toMatchObject({
      block: { id: roadmap.id },
      kind: "title-terms",
    });
    expect(rankBlockFocusMatches(blocks, "rdmp reviw")[0]).toMatchObject({
      block: { id: roadmap.id },
      kind: "title-fuzzy",
    });
    expect(formatBlockFocusMatch(rankBlockFocusMatches(blocks, "Fantasia")[0])).toBe(
      "aaaaaaaa · Fantasia note necromancy",
    );
  });
});

test("focuses only an unambiguous match through selection and Tree reveal", async () => {
  const calls: RequestInput[] = [];
  const snapshot: WorkspaceSnapshot = {
    visible: { blocks, completeness: { kind: "complete" } },
    physical: { blocks, completeness: { kind: "complete" } },
    selection: { selected: null, ancestors: [], children: [] },
    virtualOccurrenceRanks: [],
    sequence: 1,
  };
  const requester = {
    async request<T>(input: RequestInput): Promise<T> {
      calls.push(input);
      if (input.action === "workspace.snapshot") return snapshot as T;
      if (input.action === "clients.list") {
        return [{ clientId: "tree-client", role: "tree" }] as T;
      }
      return {} as T;
    },
  };

  const ambiguous = await focusBlockByQuery(requester, "40bd");
  expect(ambiguous.focused).toBe(false);
  expect(calls.map((call) => call.action)).toEqual(["workspace.snapshot"]);

  calls.length = 0;
  const focused = await focusBlockByQuery(requester, "40bd0864");
  expect(focused.focused).toBe(true);
  expect(calls).toEqual([
    { action: "workspace.snapshot" },
    { action: "clients.list", role: "tree" },
    { action: "selection.set", blockId: roadmap.id },
    {
      action: "ui.command.send",
      command: { targetClientId: "tree-client", command: "focus", blockId: roadmap.id },
    },
  ]);
});

test("rejects an explicit goto target that is not a live Tree client", async () => {
  const calls: RequestInput[] = [];
  const requester = {
    async request<T>(input: RequestInput): Promise<T> {
      calls.push(input);
      if (input.action === "workspace.snapshot") {
        return {
          visible: { blocks, completeness: { kind: "complete" } },
          physical: { blocks, completeness: { kind: "complete" } },
          selection: { selected: null, ancestors: [], children: [] },
          virtualOccurrenceRanks: [],
          sequence: 1,
        } as T;
      }
      if (input.action === "clients.list") {
        return [{ clientId: "tree-client", role: "tree" }] as T;
      }
      return {} as T;
    },
  };

  await expect(focusBlockByQuery(requester, "40bd0864", 20, "detail-client")).rejects.toThrow(
    "Target client is not a registered tree client: detail-client",
  );
  expect(calls.map((call) => call.action)).toEqual(["workspace.snapshot", "clients.list"]);
});

test("refuses an implicit goto when multiple Tree clients are live", async () => {
  const calls: RequestInput[] = [];
  const requester = {
    async request<T>(input: RequestInput): Promise<T> {
      calls.push(input);
      if (input.action === "workspace.snapshot") {
        return {
          visible: { blocks, completeness: { kind: "complete" } },
          physical: { blocks, completeness: { kind: "complete" } },
          selection: { selected: null, ancestors: [], children: [] },
          virtualOccurrenceRanks: [],
          sequence: 1,
        } as T;
      }
      if (input.action === "clients.list") {
        return [
          { clientId: "tree-a", role: "tree" },
          { clientId: "tree-b", role: "tree" },
        ] as T;
      }
      return {} as T;
    },
  };

  await expect(focusBlockByQuery(requester, "40bd0864")).rejects.toThrow(
    "Multiple live tree clients are registered; choose clientId: tree-a, tree-b",
  );
  expect(calls.map((call) => call.action)).toEqual([
    "workspace.snapshot",
    "clients.list",
  ]);
});
