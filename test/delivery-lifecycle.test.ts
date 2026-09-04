import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  deliveryIdentities,
  deterministicDeliveryIdentity,
  parseDeliveryIdentity,
  selectActiveDelivery,
  type DeliveryIdentity,
} from "../src/delivery-lifecycle";
import {
  inspectPullRequest,
  orientDeliveryBranch,
} from "../pi-extension/delivery-lifecycle";
import { inspectWorkEnvironment, type ExtensionExec } from "../pi-extension/work-environment";
import type { Block } from "../src/types";

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

async function repository(): Promise<{ root: string; remote: string }> {
  const root = mkdtempSync(join(tmpdir(), "pi-outliner-delivery-worktree-"));
  const remote = mkdtempSync(join(tmpdir(), "pi-outliner-delivery-remote-"));
  directories.push(root, remote);
  await git(remote, "init", "--bare");
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test User");
  writeFileSync(join(root, "tracked.txt"), "initial\n");
  await git(root, "add", "tracked.txt");
  await git(root, "commit", "-m", "initial");
  await git(root, "remote", "add", "origin", remote);
  await git(root, "push", "-u", "origin", "main");
  return { root, remote };
}

function block(id: string, text: string, properties: Block["properties"]): Block {
  return {
    id,
    parentId: "task",
    position: 0,
    text,
    author: "agent",
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
    properties,
  };
}

function delivery(
  workBranch = "feature/pie-200",
  repository = "repository",
): DeliveryIdentity {
  return {
    block: block("delivery", "Delivery", []),
    key: "PIE-200/primary",
    repository,
    baseBranch: "main",
    workBranch,
    stage: "work",
    pullRequestNumber: null,
    pullRequestUrl: null,
    mergeCommit: null,
    overrideReason: null,
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("delivery lifecycle", () => {
  test("parses strict records and selects the checkout-matching delivery", () => {
    const first = block(
      "first",
      "Delivery PIE-182/status [type::delivery] [delivery-key::PIE-182/status] [repository::org/repo] [base-branch::main] [work-branch::feature/pie-182-status] [delivery-stage::complete]",
      [
        { key: "type", value: "delivery" },
        { key: "delivery-key", value: "PIE-182/status" },
        { key: "repository", value: "org/repo" },
        { key: "base-branch", value: "main" },
        { key: "work-branch", value: "feature/pie-182-status" },
        { key: "delivery-stage", value: "complete" },
      ],
    );
    const second = block(
      "second",
      "Delivery PIE-182/enforcement [type::delivery] [delivery-key::PIE-182/enforcement] [repository::org/repo] [base-branch::main] [work-branch::feature/pie-182-enforcement] [delivery-stage::work]",
      [
        { key: "type", value: "delivery" },
        { key: "delivery-key", value: "PIE-182/enforcement" },
        { key: "repository", value: "org/repo" },
        { key: "base-branch", value: "main" },
        { key: "work-branch", value: "feature/pie-182-enforcement" },
        { key: "delivery-stage", value: "work" },
      ],
    );

    expect(deliveryIdentities([first, second])).toHaveLength(2);
    expect(selectActiveDelivery([first, second], "org/repo", "feature/pie-182-status")?.key)
      .toBe("PIE-182/enforcement");
    expect(selectActiveDelivery([first, second], "org/repo", "main")?.key)
      .toBe("PIE-182/enforcement");
    expect(parseDeliveryIdentity(second).stage).toBe("work");
    expect(deterministicDeliveryIdentity("PIE-200")).toEqual({
      deliveryKey: "PIE-200/primary",
      workBranch: "feature/pie-200",
    });
    expect(() => parseDeliveryIdentity(block(
      "invalid",
      "Delivery invalid",
      second.properties.map((property) =>
        property.key === "work-branch"
          ? { ...property, value: "feature//pie-182" }
          : property
      ),
    ))).toThrow("invalid work branch");
  });

  test("creates and reuses a deterministic local work branch", async () => {
    const { root } = await repository();
    const initial = await inspectWorkEnvironment(exec, root);
    const identity = delivery("feature/pie-200", initial.repository!);

    const created = await orientDeliveryBranch(exec, root, identity, initial);
    expect(created.changed).toBe(true);
    expect(created.snapshot.branch).toBe("feature/pie-200");

    await git(root, "switch", "main");
    const reused = await orientDeliveryBranch(
      exec,
      root,
      identity,
      await inspectWorkEnvironment(exec, root),
    );
    expect(reused.changed).toBe(true);
    expect(reused.snapshot.branch).toBe("feature/pie-200");
  });

  test("attaches an existing remote work branch", async () => {
    const { root } = await repository();
    const initial = await inspectWorkEnvironment(exec, root);
    const identity = delivery("feature/pie-201", initial.repository!);
    await git(root, "switch", "-c", identity.workBranch);
    await git(root, "push", "-u", "origin", identity.workBranch);
    await git(root, "switch", "main");
    await git(root, "branch", "-D", identity.workBranch);

    const oriented = await orientDeliveryBranch(
      exec,
      root,
      identity,
      await inspectWorkEnvironment(exec, root),
    );

    expect(oriented.snapshot.branch).toBe(identity.workBranch);
    const upstream = Bun.spawnSync([
      "git",
      "-C",
      root,
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    ]);
    expect(upstream.stdout.toString().trim()).toBe(`origin/${identity.workBranch}`);
  });

  test("refuses dirty, detached, wrong-repository, missing-base, and occupied switches", async () => {
    const { root } = await repository();
    const initial = await inspectWorkEnvironment(exec, root);
    const identity = delivery("feature/pie-202", initial.repository!);

    writeFileSync(join(root, "tracked.txt"), "dirty\n");
    await expect(orientDeliveryBranch(
      exec,
      root,
      identity,
      await inspectWorkEnvironment(exec, root),
    )).rejects.toThrow("Refusing to switch from dirty branch main");
    await git(root, "restore", "tracked.txt");

    await git(root, "checkout", "--detach");
    await expect(orientDeliveryBranch(
      exec,
      root,
      identity,
      await inspectWorkEnvironment(exec, root),
    )).rejects.toThrow("Detached HEAD");
    await git(root, "switch", "main");

    await expect(orientDeliveryBranch(
      exec,
      root,
      delivery(identity.workBranch, "other/repository"),
      await inspectWorkEnvironment(exec, root),
    )).rejects.toThrow("Wrong repository");

    const missingBase = {
      ...identity,
      key: "PIE-202/missing-base",
      workBranch: "feature/pie-202-missing-base",
      baseBranch: "absent",
    };
    await expect(orientDeliveryBranch(
      exec,
      root,
      missingBase,
      await inspectWorkEnvironment(exec, root),
    )).rejects.toThrow("Resolve base branch absent failed");
    expect((await inspectWorkEnvironment(exec, root)).branch).toBe("main");

    await git(root, "branch", identity.workBranch);
    const occupied = mkdtempSync(join(tmpdir(), "pi-outliner-delivery-occupied-"));
    directories.push(occupied);
    rmSync(occupied, { recursive: true, force: true });
    await git(root, "worktree", "add", occupied, identity.workBranch);
    await expect(orientDeliveryBranch(
      exec,
      root,
      identity,
      await inspectWorkEnvironment(exec, root),
    )).rejects.toThrow(`already attached at ${occupied}`);
  });

  test("reads only the exact repository, base, and head pull request", async () => {
    const identity = delivery("feature/pie-203", "org/repo");
    const calls: Array<{ command: string; args: string[] }> = [];
    const fakeExec: ExtensionExec = async (command, args) => {
      calls.push({ command, args });
      return {
        code: 0,
        killed: false,
        stderr: "",
        stdout: JSON.stringify([
          {
            number: 7,
            url: "https://github.com/org/repo/pull/7",
            state: "MERGED",
            baseRefName: "main",
            headRefName: "feature/pie-203",
            reviewDecision: "APPROVED",
            mergeCommit: { oid: "abc123" },
          },
        ]),
      };
    };

    expect(await inspectPullRequest(fakeExec, identity, "/repo")).toEqual({
      number: 7,
      url: "https://github.com/org/repo/pull/7",
      state: "MERGED",
      baseBranch: "main",
      workBranch: "feature/pie-203",
      reviewDecision: "APPROVED",
      mergeCommit: "abc123",
    });
    expect(calls).toEqual([expect.objectContaining({
      command: "gh",
      args: expect.arrayContaining([
        "--repo",
        "org/repo",
        "--head",
        "feature/pie-203",
      ]),
    })]);
  });
});
