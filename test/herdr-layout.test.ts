import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { withLayoutLock } from "../src/herdr-layout-action";
import {
  buildOutlinerLayout,
  reshapeOutlinerLayout,
  resolveOutlinerLayoutPanes,
  type HerdrLayoutApi,
  type HerdrLayoutNode,
  type HerdrMoveDestination,
  type HerdrMoveResult,
  type OutlinerLayoutName,
  type OutlinerLayoutPanes,
} from "../src/herdr-layout";

const panes: OutlinerLayoutPanes = {
  tree: "tree",
  detailA: "detail-a",
  detailB: "detail-b",
  shell: "shell",
};

function removePane(
  node: HerdrLayoutNode,
  paneId: string,
): { node?: HerdrLayoutNode; removed: boolean } {
  if (node.type === "pane") {
    return node.paneId === paneId ? { removed: true } : { node, removed: false };
  }
  const first = removePane(node.first, paneId);
  if (first.removed) {
    return first.node
      ? { node: { ...node, first: first.node }, removed: true }
      : { node: node.second, removed: true };
  }
  const second = removePane(node.second, paneId);
  if (second.removed) {
    return second.node
      ? { node: { ...node, second: second.node }, removed: true }
      : { node: node.first, removed: true };
  }
  return { node, removed: false };
}

function insertPane(
  node: HerdrLayoutNode,
  targetPaneId: string,
  movedPaneId: string,
  destination: HerdrMoveDestination,
): HerdrLayoutNode {
  if (node.type === "pane") {
    if (node.paneId !== targetPaneId) return node;
    return {
      type: "split",
      direction: destination.split!,
      ratio: destination.ratio!,
      first: node,
      second: { type: "pane", paneId: movedPaneId },
    };
  }
  return {
    ...node,
    first: insertPane(node.first, targetPaneId, movedPaneId, destination),
    second: insertPane(node.second, targetPaneId, movedPaneId, destination),
  };
}

function translate(node: HerdrLayoutNode, renames: ReadonlyMap<string, string>): HerdrLayoutNode {
  if (node.type === "pane") {
    return { type: "pane", paneId: renames.get(node.paneId) ?? node.paneId };
  }
  return {
    ...node,
    first: translate(node.first, renames),
    second: translate(node.second, renames),
  };
}

function countPanes(node: HerdrLayoutNode): number {
  return node.type === "pane" ? 1 : countPanes(node.first) + countPanes(node.second);
}

class FakeHerdr implements HerdrLayoutApi {
  readonly tabs = new Map<string, HerdrLayoutNode>();
  moves = 0;
  failAt = 0;

  constructor(initial: HerdrLayoutNode) {
    this.tabs.set("tab", initial);
  }

  movePane(
    paneId: string,
    destination: HerdrMoveDestination,
    _focus: boolean,
  ): HerdrMoveResult {
    this.moves++;
    if (this.moves === this.failAt) throw new Error(`injected failure ${this.moves}`);
    let sourceTabId: string | undefined;
    for (const [tabId, root] of this.tabs) {
      const removed = removePane(root, paneId);
      if (!removed.removed) continue;
      sourceTabId = tabId;
      if (removed.node) this.tabs.set(tabId, removed.node);
      else this.tabs.delete(tabId);
      break;
    }
    if (!sourceTabId) throw new Error(`missing pane ${paneId}`);

    const movedPaneId = `m${this.moves}`;
    if (destination.type === "new_tab") {
      const createdTabId = `staging-${this.moves}`;
      this.tabs.set(createdTabId, { type: "pane", paneId: movedPaneId });
      return { paneId: movedPaneId, createdTabId };
    }
    const target = this.tabs.get(destination.tabId!);
    if (!target) throw new Error(`missing target tab ${destination.tabId}`);
    this.tabs.set(
      destination.tabId!,
      insertPane(target, destination.targetPaneId!, movedPaneId, destination),
    );
    return { paneId: movedPaneId };
  }

  listPaneIds(_workspaceId: string, tabId: string): string[] {
    const root = this.tabs.get(tabId);
    if (!root) return [];
    const ids: string[] = [];
    const visit = (node: HerdrLayoutNode): void => {
      if (node.type === "pane") ids.push(node.paneId);
      else {
        visit(node.first);
        visit(node.second);
      }
    };
    visit(root);
    return ids;
  }
}

test("semantic roles resolve Detail A from the Tree browsing context", () => {
  expect(resolveOutlinerLayoutPanes(
    [
      { role: "detail", contextId: "secondary", paneId: "detail-b" },
      { role: "tree", contextId: "hub", paneId: "tree" },
      { role: "detail", contextId: "hub", paneId: "detail-a" },
    ],
    ["tree", "detail-a", "detail-b", "shell"],
  )).toEqual(panes);
});

test("semantic role errors name the missing working-layout contract", () => {
  expect(() => resolveOutlinerLayoutPanes(
    [{ role: "tree", contextId: "hub", paneId: "tree" }],
    ["tree", "shell"],
  )).toThrow("exactly two Details");
});

test("each explicit layout reaches its target while pane processes retain identity", () => {
  const names: OutlinerLayoutName[] = ["detail-a", "detail-b", "tree-wide"];
  for (const name of names) {
    const fake = new FakeHerdr(buildOutlinerLayout("detail-b", panes));
    const target = buildOutlinerLayout(name, panes);
    const renames = reshapeOutlinerLayout(fake, "workspace", "tab", target, panes.shell);
    expect(fake.tabs.size).toBe(1);
    expect(fake.tabs.get("tab")).toEqual(translate(target, renames));
    expect(new Set(renames.keys())).toEqual(new Set([panes.detailA, panes.detailB, panes.shell]));
  }
});

test("a failed reshape returns every staged process to the original tab", () => {
  const fake = new FakeHerdr(buildOutlinerLayout("detail-b", panes));
  fake.failAt = 4;
  expect(() => reshapeOutlinerLayout(
    fake,
    "workspace",
    "tab",
    buildOutlinerLayout("tree-wide", panes),
  )).toThrow("injected failure");
  expect(fake.tabs.size).toBe(1);
  expect(countPanes(fake.tabs.get("tab")!)).toBe(4);
});

test("layout locking excludes concurrent mutation and always releases ownership", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-layout-lock-"));
  const lockPath = join(directory, "layout.lock");
  let unblock: (() => void) | undefined;
  try {
    const held = withLayoutLock(lockPath, () => new Promise<void>((resolve) => {
      unblock = resolve;
    }));
    expect(existsSync(lockPath)).toBe(true);

    let ranUnlocked = false;
    await expect(withLayoutLock(
      lockPath,
      () => {
        ranUnlocked = true;
      },
      { waitTimeoutMs: 20, pollIntervalMs: 5, staleAfterMs: 1 },
    )).rejects.toThrow("Timed out waiting 20ms");
    expect(ranUnlocked).toBe(false);

    unblock!();
    await held;
    expect(existsSync(lockPath)).toBe(false);
  } finally {
    unblock?.();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("layout locking recovers a dead owner and releases after failure", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-layout-stale-"));
  const lockPath = join(directory, "layout.lock");
  try {
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner.json"), `${JSON.stringify({
      token: "dead-owner",
      pid: 99_999_999,
      hostname: hostname(),
      startedAt: Date.now(),
    })}\n`);
    let ranLocked = false;
    await expect(withLayoutLock(lockPath, () => {
      ranLocked = true;
      throw new Error("injected layout failure");
    }, { waitTimeoutMs: 50, pollIntervalMs: 5 })).rejects.toThrow("injected layout failure");
    expect(ranLocked).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stale replacement serializes two waiters through recovery and mutation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-layout-stale-race-"));
  const lockPath = join(directory, "layout.lock");
  const startingLine = Promise.withResolvers<void>();
  const firstEntered = Promise.withResolvers<void>();
  const firstMutationHeld = Promise.withResolvers<void>();
  try {
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner.json"), `${JSON.stringify({
      token: "dead-owner",
      pid: 99_999_999,
      hostname: hostname(),
      startedAt: Date.now(),
    })}\n`);

    let activeMutations = 0;
    let maximumActiveMutations = 0;
    const entries: string[] = [];
    const waiter = (label: string) => startingLine.promise.then(() => withLayoutLock(
      lockPath,
      async () => {
        activeMutations += 1;
        maximumActiveMutations = Math.max(maximumActiveMutations, activeMutations);
        entries.push(label);
        if (entries.length === 1) {
          firstEntered.resolve();
          await firstMutationHeld.promise;
        }
        activeMutations -= 1;
      },
      { waitTimeoutMs: 500, pollIntervalMs: 2 },
    ));

    const left = waiter("left");
    const right = waiter("right");
    startingLine.resolve();
    await firstEntered.promise;
    expect(entries).toHaveLength(1);
    expect(activeMutations).toBe(1);

    firstMutationHeld.resolve();
    await Promise.all([left, right]);
    expect(entries).toHaveLength(2);
    expect(maximumActiveMutations).toBe(1);
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(`${lockPath}.recovery`)).toBe(false);
  } finally {
    firstMutationHeld.resolve();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("orphaned recovery ownership cannot block fast or stale lock acquisition", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-layout-orphaned-recovery-"));
  try {
    for (const mainLockExists of [false, true]) {
      const lockPath = join(directory, mainLockExists ? "stale-main.lock" : "free-main.lock");
      const recoveryPath = `${lockPath}.recovery`;
      mkdirSync(recoveryPath);
      writeFileSync(join(recoveryPath, "owner.json"), `${JSON.stringify({
        token: "dead-recovery-owner",
        pid: 99_999_999,
        hostname: hostname(),
        startedAt: Date.now(),
      })}\n`);
      if (mainLockExists) {
        mkdirSync(lockPath);
        writeFileSync(join(lockPath, "owner.json"), `${JSON.stringify({
          token: "dead-main-owner",
          pid: 99_999_999,
          hostname: hostname(),
          startedAt: Date.now(),
        })}\n`);
      }

      let ranWithOwnership = false;
      await withLayoutLock(lockPath, () => {
        ranWithOwnership = existsSync(lockPath);
      }, { waitTimeoutMs: 100, pollIntervalMs: 2 });
      expect(ranWithOwnership).toBe(true);
      expect(existsSync(lockPath)).toBe(false);
      expect(existsSync(recoveryPath)).toBe(false);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("layout lock release rejects missing, malformed, and mismatched ownership", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-layout-release-owner-"));
  try {
    const cases = [
      {
        name: "missing",
        mutate(ownerPath: string) {
          rmSync(ownerPath);
        },
        expected: "ownership is missing or unreadable",
      },
      {
        name: "malformed",
        mutate(ownerPath: string) {
          writeFileSync(ownerPath, "{not-json");
        },
        expected: "ownership is malformed",
      },
      {
        name: "mismatched",
        mutate(ownerPath: string) {
          const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<string, unknown>;
          writeFileSync(ownerPath, `${JSON.stringify({ ...owner, token: "replacement-owner" })}\n`);
        },
        expected: "ownership token changed",
      },
    ];

    for (const testCase of cases) {
      const lockPath = join(directory, `${testCase.name}.lock`);
      await expect(withLayoutLock(lockPath, () => {
        testCase.mutate(join(lockPath, "owner.json"));
      })).rejects.toThrow(testCase.expected);
      expect(existsSync(lockPath)).toBe(true);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("layout locking preserves operation and release failures together", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-layout-double-failure-"));
  const lockPath = join(directory, "layout.lock");
  try {
    let caught: unknown;
    try {
      await withLayoutLock(lockPath, () => {
        writeFileSync(join(lockPath, "owner.json"), "{not-json");
        throw new Error("injected operation failure");
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    const failures = (caught as AggregateError).errors;
    expect(failures).toHaveLength(2);
    expect((failures[0] as Error).message).toBe("injected operation failure");
    expect((failures[1] as Error).message).toContain("ownership is malformed");
    expect(existsSync(lockPath)).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("explicit role validation checks a focused role pane without flock", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-layout-explicit-"));
  const fakeHerdr = join(directory, "fake-herdr");
  const callLog = join(directory, "calls.jsonl");
  try {
    writeFileSync(
      fakeHerdr,
      `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callLog)}, JSON.stringify(args) + "\\n");
const paneId = args[2];
console.log(JSON.stringify({ result: { pane: {
  pane_id: paneId,
  workspace_id: "workspace",
  tab_id: paneId === "detail-a" ? "other-tab" : "working-tab"
} } }));
`,
    );
    chmodSync(fakeHerdr, 0o755);
    const result = spawnSync(
      process.execPath,
      [
        "run",
        "src/herdr-layout-action.ts",
        "detail-b",
        "--tree",
        "tree",
        "--detail-a",
        "detail-a",
        "--detail-b",
        "detail-b",
        "--shell",
        "shell",
        "--focus",
        "detail-a",
      ],
      {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        env: {
          ...process.env,
          HERDR_ENV: "1",
          HERDR_BIN_PATH: fakeHerdr,
          HERDR_SOCKET_PATH: join(directory, "herdr.sock"),
          PATH: "",
        },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("All explicit Outliner layout panes must be in the same tab");
    expect(readFileSync(callLog, "utf8").trim().split("\n").map(
      (line) => JSON.parse(line) as string[],
    )).toEqual([
      ["pane", "get", "tree"],
      ["pane", "get", "detail-a"],
      ["pane", "get", "detail-b"],
      ["pane", "get", "shell"],
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("manifest exposes both explicit layout entrypoints", () => {
  const manifest = Bun.TOML.parse(
    readFileSync(new URL("../herdr-plugin.toml", import.meta.url), "utf8"),
  ) as {
    actions: Array<{ id: string; command: string[] }>;
  };
  const commands = Object.fromEntries(manifest.actions.map((action) => [action.id, action.command]));
  expect(commands["open-here"]).toEqual([
    "bun",
    "run",
    "src/herdr-open.ts",
    "--mode",
    "open-here",
  ]);
  expect(commands["open-layout"]).toEqual([
    "bun",
    "run",
    "src/herdr-open.ts",
    "--mode",
    "open-layout",
  ]);
});
