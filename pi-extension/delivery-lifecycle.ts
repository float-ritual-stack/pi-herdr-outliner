import type { ExecResult } from "@earendil-works/pi-coding-agent";
import type { DeliveryIdentity } from "../src/delivery-lifecycle";
import type { WorkEnvironmentSnapshot } from "../src/work-environment";
import { inspectWorkEnvironment, type ExtensionExec } from "./work-environment";

const LOCAL_TIMEOUT_MS = 3_000;
const NETWORK_TIMEOUT_MS = 10_000;
const GIT_PREFIX = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"] as const;

async function run(
  exec: ExtensionExec,
  command: string,
  args: string[],
  signal: AbortSignal | undefined,
  timeout: number,
): Promise<ExecResult> {
  return exec(command, args, { signal, timeout });
}

async function git(
  exec: ExtensionExec,
  cwd: string,
  args: string[],
  signal?: AbortSignal,
  timeout = LOCAL_TIMEOUT_MS,
): Promise<ExecResult> {
  return run(exec, "git", [...GIT_PREFIX, "-C", cwd, ...args], signal, timeout);
}

function failure(result: ExecResult, operation: string): Error {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
  return new Error(`${operation} failed: ${detail}`);
}

async function requireGit(
  exec: ExtensionExec,
  cwd: string,
  args: string[],
  operation: string,
  signal?: AbortSignal,
): Promise<ExecResult> {
  const result = await git(exec, cwd, args, signal);
  if (result.code !== 0) throw failure(result, operation);
  return result;
}

export async function discoverBaseBranch(
  exec: ExtensionExec,
  snapshot: WorkEnvironmentSnapshot,
  signal?: AbortSignal,
): Promise<string> {
  if (!snapshot.root) throw new Error("Cannot discover a base branch outside a Git repository");
  const remoteHead = await git(
    exec,
    snapshot.root,
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    signal,
  );
  if (remoteHead.code === 0) {
    const value = remoteHead.stdout.trim().replace(/^origin\//, "");
    if (value) return value;
  }
  if (snapshot.branch && ["main", "master", "trunk"].includes(snapshot.branch)) {
    return snapshot.branch;
  }
  for (const candidate of ["main", "master", "trunk"]) {
    const local = await git(
      exec,
      snapshot.root,
      ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`],
      signal,
    );
    if (local.code === 0) return candidate;
    const remote = await git(
      exec,
      snapshot.root,
      ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`],
      signal,
    );
    if (remote.code === 0) return candidate;
  }
  throw new Error("Cannot determine main, master, or trunk as the delivery base branch");
}

interface WorktreeRecord {
  path: string;
  branch: string | null;
}

function parseWorktrees(output: string): WorktreeRecord[] {
  return output.trim().split(/\n\n+/).flatMap((record) => {
    let path = "";
    let branch: string | null = null;
    for (const line of record.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
      if (line.startsWith("branch refs/heads/")) branch = line.slice("branch refs/heads/".length);
    }
    return path ? [{ path, branch }] : [];
  });
}

export interface BranchOrientationResult {
  readonly snapshot: WorkEnvironmentSnapshot;
  readonly changed: boolean;
}

export async function orientDeliveryBranch(
  exec: ExtensionExec,
  cwd: string,
  delivery: DeliveryIdentity,
  current: WorkEnvironmentSnapshot,
  signal?: AbortSignal,
): Promise<BranchOrientationResult> {
  if (!current.root || !current.repository) {
    throw new Error("Delivery branch attachment requires a Git repository with an origin remote");
  }
  if (current.repository !== delivery.repository) {
    throw new Error(
      `Wrong repository for ${delivery.key}: expected ${delivery.repository}, found ${current.repository}`,
    );
  }
  if (current.branch === delivery.workBranch) return { snapshot: current, changed: false };
  if (!current.branch) throw new Error("Detached HEAD cannot be reoriented automatically");
  if (current.dirtyCount > 0) {
    throw new Error(
      `Refusing to switch from dirty branch ${current.branch}; preserve or remove local changes first`,
    );
  }

  const worktrees = await requireGit(
    exec,
    current.root,
    ["worktree", "list", "--porcelain"],
    "Git worktree inspection",
    signal,
  );
  const occupied = parseWorktrees(worktrees.stdout).find((worktree) =>
    worktree.branch === delivery.workBranch && worktree.path !== current.root
  );
  if (occupied) {
    throw new Error(
      `Delivery branch ${delivery.workBranch} is already attached at ${occupied.path}`,
    );
  }

  const local = await git(
    exec,
    current.root,
    ["show-ref", "--verify", "--quiet", `refs/heads/${delivery.workBranch}`],
    signal,
  );
  if (local.code === 0) {
    await requireGit(
      exec,
      current.root,
      ["switch", delivery.workBranch],
      `Switch to ${delivery.workBranch}`,
      signal,
    );
  } else {
    const trackedRemote = await git(
      exec,
      current.root,
      ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${delivery.workBranch}`],
      signal,
    );
    const remote = trackedRemote.code === 0
      ? trackedRemote
      : await git(
        exec,
        current.root,
        ["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${delivery.workBranch}`],
        signal,
        NETWORK_TIMEOUT_MS,
      );
    if (remote.code === 0) {
      await requireGit(
        exec,
        current.root,
        ["switch", "--track", "-c", delivery.workBranch, `origin/${delivery.workBranch}`],
        `Attach remote branch ${delivery.workBranch}`,
        signal,
      );
    } else {
      const localBase = await git(
        exec,
        current.root,
        ["show-ref", "--verify", "--quiet", `refs/heads/${delivery.baseBranch}`],
        signal,
      );
      const baseRef = localBase.code === 0
        ? delivery.baseBranch
        : `refs/remotes/origin/${delivery.baseBranch}`;
      const base = await git(exec, current.root, ["rev-parse", "--verify", `${baseRef}^{commit}`], signal);
      if (base.code !== 0) throw failure(base, `Resolve base branch ${delivery.baseBranch}`);
      await requireGit(
        exec,
        current.root,
        ["switch", "-c", delivery.workBranch, baseRef],
        `Create ${delivery.workBranch}`,
        signal,
      );
    }
  }

  const snapshot = await inspectWorkEnvironment(exec, current.root, signal);
  if (
    snapshot.repository !== delivery.repository ||
    snapshot.branch !== delivery.workBranch
  ) {
    throw new Error(`Git reported success but did not attach ${delivery.workBranch}`);
  }
  return { snapshot, changed: true };
}

export interface PullRequestSnapshot {
  readonly number: number;
  readonly url: string;
  readonly state: "OPEN" | "CLOSED" | "MERGED";
  readonly baseBranch: string;
  readonly workBranch: string;
  readonly reviewDecision: string;
  readonly mergeCommit: string | null;
}

interface GhPullRequest {
  number?: unknown;
  url?: unknown;
  state?: unknown;
  baseRefName?: unknown;
  headRefName?: unknown;
  reviewDecision?: unknown;
  mergeCommit?: { oid?: unknown } | null;
}

export async function inspectPullRequest(
  exec: ExtensionExec,
  delivery: DeliveryIdentity,
  cwd: string,
  signal?: AbortSignal,
): Promise<PullRequestSnapshot | null> {
  const result = await run(exec, "gh", [
    "pr",
    "list",
    "--repo",
    delivery.repository,
    "--head",
    delivery.workBranch,
    "--state",
    "all",
    "--limit",
    "20",
    "--json",
    "number,url,state,baseRefName,headRefName,reviewDecision,mergeCommit",
  ], signal, NETWORK_TIMEOUT_MS);
  if (result.code !== 0) throw failure(result, "GitHub pull-request inspection");
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("GitHub pull-request inspection returned invalid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("GitHub pull-request inspection returned a non-array");
  const matches = (parsed as GhPullRequest[]).filter((pull) =>
    pull.baseRefName === delivery.baseBranch && pull.headRefName === delivery.workBranch
  );
  if (matches.length === 0) return null;
  const pull = matches.find((candidate) => candidate.state === "OPEN") ?? matches[0]!;
  if (
    !Number.isSafeInteger(pull.number) ||
    typeof pull.url !== "string" ||
    !["OPEN", "CLOSED", "MERGED"].includes(String(pull.state)) ||
    typeof pull.baseRefName !== "string" ||
    typeof pull.headRefName !== "string"
  ) {
    throw new Error("GitHub pull-request inspection returned an invalid record");
  }
  const mergeCommit = pull.mergeCommit?.oid;
  return {
    number: pull.number as number,
    url: pull.url,
    state: pull.state as PullRequestSnapshot["state"],
    baseBranch: pull.baseRefName,
    workBranch: pull.headRefName,
    reviewDecision: typeof pull.reviewDecision === "string" ? pull.reviewDecision : "",
    mergeCommit: typeof mergeCommit === "string" && mergeCommit ? mergeCommit : null,
  };
}
