import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { inspectWorkEnvironment, type ExtensionExec } from "../pi-extension/work-environment";
import {
  classifyWorkEnvironment,
  workEnvironmentStatus,
  workIdFromBranch,
} from "../src/work-environment";

const directories: string[] = [];

const exec: ExtensionExec = async (command, args, options) => {
  const process = Bun.spawn([command, ...args], {
    cwd: options?.cwd,
    env: Bun.env,
    stdout: "pipe",
    stderr: "pipe",
    signal: options?.signal,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { stdout, stderr, code, killed: false };
};

async function git(cwd: string, ...args: string[]): Promise<void> {
  const result = await exec("git", ["-C", cwd, ...args]);
  if (result.code !== 0) throw new Error(result.stderr);
}

async function repository(): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-work-environment-"));
  directories.push(directory);
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.email", "test@example.com");
  await git(directory, "config", "user.name", "Test User");
  writeFileSync(join(directory, "tracked.txt"), "initial\n");
  await git(directory, "add", "tracked.txt");
  await git(directory, "commit", "-m", "initial");
  await git(directory, "remote", "add", "origin", "git@github.com:float-ritual-stack/pi-herdr-outliner.git");
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("work environment orientation", () => {
  test("classifies clean main, the matching Work-ID branch, mismatches, and dirty state", async () => {
    const directory = await repository();
    const main = await inspectWorkEnvironment(exec, directory);
    expect(main).toMatchObject({
      repository: "float-ritual-stack/pi-herdr-outliner",
      branch: "main",
      dirtyCount: 0,
      ahead: 0,
      behind: 0,
    });
    const mainOrientation = classifyWorkEnvironment(main, "PIE-182");
    expect(mainOrientation.classification).toBe("main");
    expect(mainOrientation.guidance).toContain("expected a feature/fix branch containing pie-182");

    await git(directory, "switch", "-c", "feature/pie-182-lifecycle-status");
    const oriented = classifyWorkEnvironment(
      await inspectWorkEnvironment(exec, directory),
      "PIE-182",
    );
    expect(oriented.classification).toBe("oriented");
    expect(oriented.summary).toContain(
      "Work environment: PIE-182 · repo float-ritual-stack/pi-herdr-outliner · branch feature/pie-182-lifecycle-status · clean · ahead 0 · behind 0",
    );
    expect(oriented.guidance).toBeNull();
    expect(workEnvironmentStatus(oriented)).toBe(
      "PIE-182 · feature/pie-182-lifecycle-status · clean",
    );

    writeFileSync(join(directory, "tracked.txt"), "changed\n");
    const dirty = await inspectWorkEnvironment(exec, directory);
    expect(dirty.dirtyCount).toBe(1);
    expect(classifyWorkEnvironment(dirty, "PIE-182").classification).toBe("oriented");

    await git(directory, "switch", "-c", "fix/pie-999-other");
    const mismatch = classifyWorkEnvironment(
      await inspectWorkEnvironment(exec, directory),
      "PIE-182",
    );
    expect(mismatch.classification).toBe("mismatch");
    expect(mismatch.branchWorkId).toBe("PIE-999");
    expect(mismatch.guidance).toContain("current branch fix/pie-999-other");
  });

  test("does not execute the repository fsmonitor command", async () => {
    const directory = await repository();
    const marker = join(directory, "fsmonitor-ran");
    const probe = join(directory, "fsmonitor-probe");
    writeFileSync(probe, `#!/bin/sh\n: > "${marker}"\n`);
    chmodSync(probe, 0o755);
    await git(directory, "config", "core.fsmonitor", probe);

    const snapshot = await inspectWorkEnvironment(exec, directory);

    expect(snapshot.branch).toBe("main");
    expect(existsSync(marker)).toBe(false);
  });

  test("classifies detached, unbound Work-ID, and non-Git contexts without mutation", async () => {
    const directory = await repository();
    await git(directory, "switch", "-c", "feature/pie-188-dogfood");
    const branch = await inspectWorkEnvironment(exec, directory);
    const unbound = classifyWorkEnvironment(branch, null);
    expect(unbound.classification).toBe("unbound-work");
    expect(unbound.guidance).toContain("Resume that roadmap item explicitly");

    await git(directory, "checkout", "--detach");
    const detached = classifyWorkEnvironment(
      await inspectWorkEnvironment(exec, directory),
      "PIE-182",
    );
    expect(detached.classification).toBe("detached");
    expect(detached.guidance).toContain("detached HEAD");

    const outside = mkdtempSync(join(tmpdir(), "pi-outliner-non-git-"));
    directories.push(outside);
    const nonGit = await inspectWorkEnvironment(exec, outside);
    expect(classifyWorkEnvironment(nonGit, "PIE-182").classification).toBe("non-git");
    expect(nonGit.root).toBeNull();
  });

  test("extracts configurable Work-ID prefixes from deterministic branch names", () => {
    expect(workIdFromBranch("feature/pie-182-lifecycle-status")).toBe("PIE-182");
    expect(workIdFromBranch("fix/ABC-42-recovery")).toBe("ABC-42");
    expect(workIdFromBranch("feature/pie-1820-other")).toBe("PIE-1820");
    expect(workIdFromBranch("main")).toBeNull();
  });
});
