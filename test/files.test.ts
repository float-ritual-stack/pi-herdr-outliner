import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readReferencedFile, resolveReferencedPath } from "../src/files";
import { OutlinerStore } from "../src/store";

test("reads the line range declared by a file-reference block", () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-outliner-files-"));
  mkdirSync(join(workspace, "docs"));
  writeFileSync(join(workspace, "docs", "plan.md"), "# Plan\nFirst\nSecond\nThird\n");
  const store = new OutlinerStore(join(workspace, "outliner.sqlite"));

  try {
    const block = store.create("Plan [file::docs/plan.md] [line-start::2] [line-end::3]");
    const file = readReferencedFile(block, workspace);

    expect(file.sourcePath).toBe("docs/plan.md");
    expect(file.firstLine).toBe(2);
    expect(file.lines).toEqual(["First", "Second"]);
  } finally {
    store.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("expands current-user home references without treating the tilde as a workspace directory", () => {
  expect(resolveReferencedPath("~/test/plan.md", "/workspace", "/home/evan")).toBe(
    "/home/evan/test/plan.md",
  );
  expect(() => resolveReferencedPath("~other/plan.md", "/workspace", "/home/evan")).toThrow(
    "Only current-user home paths",
  );
});
