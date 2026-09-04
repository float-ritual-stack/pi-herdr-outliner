export type WorkOrientationClass =
  | "oriented"
  | "main"
  | "mismatch"
  | "detached"
  | "non-git"
  | "unbound-work"
  | "clear";

export interface WorkEnvironmentSnapshot {
  readonly cwd: string;
  readonly repository: string | null;
  readonly root: string | null;
  readonly branch: string | null;
  readonly head: string | null;
  readonly dirtyCount: number;
  readonly ahead: number;
  readonly behind: number;
}

export interface WorkOrientation {
  readonly classification: WorkOrientationClass;
  readonly snapshot: WorkEnvironmentSnapshot;
  readonly activeWorkId: string | null;
  readonly branchWorkId: string | null;
  readonly summary: string;
  readonly guidance: string | null;
  readonly fingerprint: string;
}

const WORK_ID_PATTERN = /(?:^|[^a-z0-9])([a-z]+-\d+)(?=$|[^a-z0-9])/i;
const DEFAULT_BRANCHES = new Set(["main", "master", "trunk"]);

function normalizeWorkId(value: string | null): string | null {
  const match = value?.match(/^([a-z]+)-(\d+)$/i);
  return match ? `${match[1]!.toUpperCase()}-${match[2]}` : null;
}

export function workIdFromBranch(branch: string | null): string | null {
  return normalizeWorkId(branch?.match(WORK_ID_PATTERN)?.[1] ?? null);
}

function snapshotLabel(snapshot: WorkEnvironmentSnapshot): string {
  if (!snapshot.root) return "not a Git repository";
  const repository = snapshot.repository ?? snapshot.root;
  const branch = snapshot.branch ?? "detached HEAD";
  const dirty = snapshot.dirtyCount === 0 ? "clean" : `dirty ${snapshot.dirtyCount}`;
  return `repo ${repository} · branch ${branch} · ${dirty} · ahead ${snapshot.ahead} · behind ${snapshot.behind}`;
}

function guidanceFor(
  classification: WorkOrientationClass,
  activeWorkId: string | null,
  branchWorkId: string | null,
  snapshot: WorkEnvironmentSnapshot,
): string | null {
  if (classification === "clear" || classification === "oriented") return null;
  if (classification === "unbound-work") {
    return `Work branch ${snapshot.branch} appears to belong to ${branchWorkId}. Resume that roadmap item explicitly before mutation; no task was bound automatically.`;
  }
  const observed = !snapshot.root
    ? `current cwd ${snapshot.cwd} is not a Git repository`
    : snapshot.branch
      ? `current branch ${snapshot.branch}`
      : "current checkout is detached HEAD";
  const expected = activeWorkId
    ? `expected a feature/fix branch containing ${activeWorkId.toLowerCase()}`
    : "expected an explicitly bound roadmap task";
  return `Reorientation required before task work: active task ${activeWorkId ?? "none"}; ${observed}; ${expected}. Inspect existing worktrees/branches, then attach or create the correct branch before mutation.`;
}

export function classifyWorkEnvironment(
  snapshot: WorkEnvironmentSnapshot,
  activeWorkIdValue: string | null,
): WorkOrientation {
  const activeWorkId = normalizeWorkId(activeWorkIdValue);
  const branchWorkId = workIdFromBranch(snapshot.branch);
  let classification: WorkOrientationClass;
  if (!snapshot.root) {
    classification = activeWorkId ? "non-git" : "clear";
  } else if (!activeWorkId) {
    classification = branchWorkId ? "unbound-work" : "clear";
  } else if (!snapshot.branch) {
    classification = "detached";
  } else if (branchWorkId === activeWorkId) {
    classification = "oriented";
  } else if (DEFAULT_BRANCHES.has(snapshot.branch.toLowerCase())) {
    classification = "main";
  } else {
    classification = "mismatch";
  }

  const summary = activeWorkId
    ? `Work environment: ${activeWorkId} · ${snapshotLabel(snapshot)}`
    : snapshotLabel(snapshot);
  const guidance = guidanceFor(classification, activeWorkId, branchWorkId, snapshot);
  const fingerprint = [
    activeWorkId ?? "none",
    snapshot.cwd,
    snapshot.repository ?? "none",
    snapshot.branch ?? "detached",
    snapshot.head ?? "none",
    snapshot.dirtyCount,
    snapshot.ahead,
    snapshot.behind,
    classification,
  ].join("|");
  return {
    classification,
    snapshot,
    activeWorkId,
    branchWorkId,
    summary,
    guidance,
    fingerprint,
  };
}

export function workEnvironmentStatus(orientation: WorkOrientation): string | undefined {
  if (!orientation.activeWorkId && orientation.classification === "clear") return undefined;
  const branch = orientation.snapshot.branch ?? (orientation.snapshot.root ? "detached" : "non-git");
  const dirty = orientation.snapshot.dirtyCount === 0 ? "clean" : `dirty ${orientation.snapshot.dirtyCount}`;
  return `${orientation.activeWorkId ?? orientation.branchWorkId ?? "unbound"} · ${branch} · ${dirty}`;
}
