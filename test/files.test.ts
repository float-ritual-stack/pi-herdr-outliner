import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeReferencedPaths, readReferencedFile, resolveReferencedPath } from "../src/files";
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

test("completes referenced paths with directories first and preserves path style", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-outliner-completion-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  mkdirSync(join(workspace, "misc-dir"), { recursive: true });
  mkdirSync(join(home, "notes"), { recursive: true });
  writeFileSync(join(workspace, "misc-feedback.md"), "");
  writeFileSync(join(workspace, "misc-dir", "nested.md"), "");
  writeFileSync(join(workspace, "misc-plan.md"), "");
  writeFileSync(join(home, "notes", "home.md"), "");

  try {
    expect(completeReferencedPaths("mis", workspace, home)).toEqual([
      { sourcePath: "misc-dir/", isDirectory: true },
      { sourcePath: "misc-feedback.md", isDirectory: false },
      { sourcePath: "misc-plan.md", isDirectory: false },
    ]);
    expect(completeReferencedPaths("misc-dir/n", workspace, home)).toEqual([
      { sourcePath: "misc-dir/nested.md", isDirectory: false },
    ]);
    expect(completeReferencedPaths("~/notes/h", workspace, home)).toEqual([
      { sourcePath: "~/notes/home.md", isDirectory: false },
    ]);
    expect(completeReferencedPaths(`${workspace}/misc-f`, workspace, home)).toEqual([
      { sourcePath: `${workspace}/misc-feedback.md`, isDirectory: false },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("filters by basename and caps path candidates after directory-first sorting", () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-outliner-completion-limit-"));
  mkdirSync(join(workspace, "z-dir"));
  writeFileSync(join(workspace, "a-file"), "");
  writeFileSync(join(workspace, "b-file"), "");

  try {
    expect(completeReferencedPaths("", workspace, "/home/evan", 2)).toEqual([
      { sourcePath: "z-dir/", isDirectory: true },
      { sourcePath: "a-file", isDirectory: false },
    ]);
    expect(() => completeReferencedPaths("~other/file", workspace, "/home/evan")).toThrow(
      "Only current-user home paths",
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("follows usable symlinks and skips dangling candidates", () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-outliner-completion-symlinks-"));
  mkdirSync(join(workspace, "real-dir"));
  writeFileSync(join(workspace, "real-file"), "");
  symlinkSync("real-dir", join(workspace, "dir-link"));
  symlinkSync("real-file", join(workspace, "file-link"));
  symlinkSync("missing-target", join(workspace, "dangling-link"));

  try {
    const candidates = completeReferencedPaths("", workspace, "/home/evan");
    expect(candidates).toContainEqual({ sourcePath: "dir-link/", isDirectory: true });
    expect(candidates).toContainEqual({ sourcePath: "file-link", isDirectory: false });
    expect(candidates.some((candidate) => candidate.sourcePath.startsWith("dangling-link"))).toBe(false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
