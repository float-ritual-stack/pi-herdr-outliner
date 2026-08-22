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
function isDescendant(candidateId: string, ancestorId: string): boolean {
  let parentId = parents[candidateId];
  while (parentId) {
    if (parentId === ancestorId) return true;
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
