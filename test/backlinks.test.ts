import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { OutlinerStore } from "../src/store";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function store(): OutlinerStore {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-backlinks-"));
  const result = new OutlinerStore(join(directory, "outliner.sqlite"));
  cleanups.push(() => {
    result.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return result;
}

describe("semantic backlink relation", () => {
  test("groups exact, page, and Work-ID references while excluding protected and unresolved text", () => {
    const workspace = store();
    let target = workspace.create("Target decision [page::Target Page]");
    workspace.configureWorkIdPrefix("PIE");
    target = workspace.allocateWorkId(target.id, target.updatedAt).block;

    const source = workspace.create([
      "Grouped source",
      `((${target.id})) and [[Target Page]] and PIE-001`,
      `\`((${target.id})) [[Target Page]] PIE-001\``,
      "```text",
      `((${target.id})) [[Target Page]] PIE-001`,
      "```",
    ].join("\n"));
    workspace.create("Unresolved source\n[[Missing Page]] and PIE-999");

    const result = workspace.queryBacklinks({ targetBlockId: target.id, limit: 10 });

    expect(result).toMatchObject({
      targetBlockId: target.id,
      completeness: { kind: "complete" },
    });
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({
      blockId: source.id,
      title: "Grouped source",
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
      occurrenceCount: 3,
      occurrencesTruncated: false,
    });
    expect(result.sources[0]!.occurrences.map((occurrence) => occurrence.kind)).toEqual([
      "block",
      "page",
      "work-id",
    ]);
    expect(result.sources[0]!.occurrences.every((occurrence) =>
      occurrence.snippet.includes("and")
    )).toBe(true);
    expect(result.sources[0]!.occurrences[0]!.snippet).toContain("((Target decision))");
    expect(result.sources[0]!.occurrences[0]!.snippet).not.toContain(target.id);
  });

  test("keeps fragment backlinks attached to canonical targets across heading renames", () => {
    const workspace = store();
    const target = workspace.create("Target\n\n## Original heading ^durable-heading");
    const source = workspace.create(`Source\n((${target.id}^durable-heading))`);

    const before = workspace.queryBacklinks({ targetBlockId: target.id, limit: 10 });
    expect(before.sources).toMatchObject([{
      blockId: source.id,
      occurrenceCount: 1,
      referenceGroups: [{ kind: "block", count: 1 }],
    }]);
    expect(before.sources[0]!.occurrences[0]!.snippet).toContain(
      "((Target^durable-heading))",
    );

    workspace.update(
      target.id,
      "Target\n\n## Renamed heading ^durable-heading",
      target.updatedAt,
    );
    const after = workspace.queryBacklinks({ targetBlockId: target.id, limit: 10 });
    expect(after.sources.map((candidate) => candidate.blockId)).toEqual([source.id]);
    expect(after.sources[0]!.occurrences[0]!.snippet).toContain(
      "((Target^durable-heading))",
    );
  });

  test("groups block-valued property backlinks by property key", () => {
    const workspace = store();
    const target = workspace.create("Source document");
    const source = workspace.create([
      "Annotation",
      `[source-block::${target.id}] [source-block::${target.id}]`,
      `[derived-from::${target.id}] [status::open]`,
      `\`[source-block::${target.id}]\``,
    ].join("\n"));

    const result = workspace.queryBacklinks({ targetBlockId: target.id, limit: 10 });

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({
      blockId: source.id,
      occurrenceCount: 3,
      referenceGroups: [
        { kind: "property", propertyKey: "source-block", count: 2 },
        { kind: "property", propertyKey: "derived-from", count: 1 },
      ],
    });
    expect(result.sources[0]!.occurrences).toEqual([
      expect.objectContaining({ kind: "property", propertyKey: "source-block" }),
      expect.objectContaining({ kind: "property", propertyKey: "source-block" }),
      expect.objectContaining({ kind: "property", propertyKey: "derived-from" }),
    ]);
    expect(result.sources[0]!.occurrences.every((occurrence) =>
      occurrence.snippet.includes("Source document") &&
      !occurrence.snippet.includes(target.id)
    )).toBe(true);
  });

  test("includes nested-list references while excluding multiline indented code", () => {
    const workspace = store();
    const target = workspace.create("Nested target");
    const source = workspace.create([
      "Nested source",
      "- Parent item",
      `    - Nested item ((${target.id}))`,
      `    continuation ((${target.id}))`,
      "Outside paragraph",
      "",
      "    literal code",
      `    ((${target.id}))`,
      "    literal tail",
    ].join("\n"));

    const result = workspace.queryBacklinks({ targetBlockId: target.id, limit: 10 });

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({
      blockId: source.id,
      occurrenceCount: 2,
      referenceGroups: [{ kind: "block", count: 2 }],
    });
  });

  test("disambiguates duplicate titles by parent context and truncates source rows", () => {
    const workspace = store();
    const target = workspace.create("Target");
    const parentA = workspace.create("Area A");
    const parentB = workspace.create("Area B");
    workspace.create(`Duplicate\n((${target.id}))`, parentA.id);
    workspace.create(`Duplicate\n((${target.id}))`, parentB.id);
    workspace.create(`Third\n((${target.id}))`);

    const result = workspace.queryBacklinks({ targetBlockId: target.id, limit: 2 });

    expect(result.completeness).toEqual({ kind: "truncated", limit: 2 });
    expect(result.sources).toHaveLength(2);
    expect(result.sources.map((source) => source.title)).toEqual(["Duplicate", "Duplicate"]);
    expect(result.sources.map((source) => source.parentContext)).toEqual(["Area A", "Area B"]);
  });

  test("excludes deleted sources by default and identifies deleted targets without vague missing rows", () => {
    const workspace = store();
    const target = workspace.create("Target");
    const activeSource = workspace.create(`Active source\n((${target.id}))`);
    const deletedSource = workspace.create(`Deleted source\n((${target.id}))`);
    workspace.delete(deletedSource.id);

    const activeOnly = workspace.queryBacklinks({ targetBlockId: target.id, limit: 10 });
    expect(activeOnly.sources.map((source) => source.blockId)).toEqual([activeSource.id]);

    const withDeleted = workspace.queryBacklinks({
      targetBlockId: target.id,
      includeDeleted: true,
      limit: 10,
    });
    expect(withDeleted.sources.map((source) => source.blockId)).toEqual([
      activeSource.id,
      deletedSource.id,
    ]);
    expect(withDeleted.sources[1]!.deletedRootId).toBe(deletedSource.id);

    workspace.delete(target.id);
    const deletedTarget = workspace.queryBacklinks({ targetBlockId: target.id, limit: 10 });
    expect(deletedTarget.targetDeletedRootId).toBe(target.id);
    expect(deletedTarget.sources.map((source) => source.blockId)).toEqual([activeSource.id]);
    expect(() => workspace.queryBacklinks({ targetBlockId: "missing-target", limit: 10 }))
      .toThrow("Block not found: missing-target");
  });
});
