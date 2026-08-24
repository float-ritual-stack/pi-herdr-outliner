import { expect, test } from "bun:test";
import { quickInsertionPoint } from "../src/quick-edit";

const rows = [
  { id: "parent", depth: 0 },
  { id: "child", depth: 1 },
  { id: "grandchild", depth: 2 },
  { id: "sibling", depth: 0 },
];
const parents: Record<string, string | undefined> = {
  child: "parent",
  grandchild: "child",
};
function isDescendant(
  candidate: { id: string },
  ancestor: { id: string },
): boolean {
  let parentId = parents[candidate.id];
  while (parentId) {
    if (parentId === ancestor.id) return true;
    parentId = parents[parentId];
  }
  return false;
}

test("places a new child directly beneath its parent", () => {
  expect(quickInsertionPoint(rows, 0, "add-child", isDescendant)).toEqual({ gap: 1, depth: 1 });
});

test("places a new sibling after the selected block subtree", () => {
  expect(quickInsertionPoint(rows, 0, "add-sibling", isDescendant)).toEqual({ gap: 3, depth: 0 });
  expect(quickInsertionPoint(rows, 1, "add-sibling", isDescendant)).toEqual({ gap: 3, depth: 1 });
});

test("does not treat a filtered deeper row from another subtree as a descendant", () => {
  const filteredRows = [
    { id: "selected", depth: 1 },
    { id: "other-child", depth: 2 },
  ];
  expect(quickInsertionPoint(filteredRows, 0, "add-sibling", () => false)).toEqual({
    gap: 1,
    depth: 1,
  });
});

test("uses row-aware visual ancestry to skip occurrences nested below a physical ancestor", () => {
  type Row =
    | { kind: "physical"; id: string; depth: number; parentId?: string }
    | { kind: "occurrence"; id: string; depth: number; viewId: string };
  const projectedRows: Row[] = [
    { kind: "physical", id: "ancestor", depth: 0 },
    { kind: "physical", id: "definition", depth: 1, parentId: "ancestor" },
    { kind: "occurrence", id: "projected-card", depth: 2, viewId: "definition" },
    { kind: "physical", id: "sibling", depth: 0 },
  ];
  const visuallyDescends = (candidate: Row, ancestor: Row): boolean => {
    if (ancestor.kind === "occurrence") return false;
    if (candidate.kind === "occurrence") {
      if (candidate.viewId === ancestor.id) return true;
      const definition = projectedRows.find((row) => row.id === candidate.viewId);
      return definition?.kind === "physical" && definition.parentId === ancestor.id;
    }
    return candidate.parentId === ancestor.id;
  };

  expect(quickInsertionPoint(projectedRows, 0, "add-sibling", visuallyDescends)).toEqual({
    gap: 3,
    depth: 0,
  });
  expect(quickInsertionPoint(projectedRows, 1, "add-sibling", visuallyDescends)).toEqual({
    gap: 3,
    depth: 1,
  });
});
