import type { Block, DeliveryStage } from "./types";

const DELIVERY_STAGES = new Set<DeliveryStage>(["work", "review", "validate", "complete"]);
export function isValidGitBranchName(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 255 ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ||
    value === "@" ||
    value.includes("..") ||
    value.includes("@{") ||
    value.includes("//") ||
    value.endsWith("/") ||
    value.endsWith(".")
  ) return false;
  return value.split("/").every((component) =>
    component.length > 0 &&
    !component.startsWith(".") &&
    !component.endsWith(".lock")
  );
}

export interface DeliveryIdentity {
  readonly block: Block;
  readonly key: string;
  readonly repository: string;
  readonly baseBranch: string;
  readonly workBranch: string;
  readonly stage: DeliveryStage;
  readonly pullRequestNumber: number | null;
  readonly pullRequestUrl: string | null;
  readonly mergeCommit: string | null;
  readonly overrideReason: string | null;
}

function singletonProperty(block: Block, key: string, required = true): string | null {
  const values = block.properties.filter((property) => property.key === key);
  if (values.length > 1 || (required && values.length !== 1)) {
    throw new Error(`Delivery ${block.id} must have exactly one [${key}::…] property`);
  }
  return values[0]?.value ?? null;
}

export function parseDeliveryIdentity(block: Block): DeliveryIdentity {
  if (singletonProperty(block, "type") !== "delivery") {
    throw new Error(`Block is not a delivery record: ${block.id}`);
  }
  const key = singletonProperty(block, "delivery-key")!;
  const repository = singletonProperty(block, "repository")!;
  const baseBranch = singletonProperty(block, "base-branch")!;
  const workBranch = singletonProperty(block, "work-branch")!;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(`Delivery ${key} has invalid repository: ${repository}`);
  }
  if (!isValidGitBranchName(baseBranch)) {
    throw new Error(`Delivery ${key} has invalid base branch: ${baseBranch}`);
  }
  if (!isValidGitBranchName(workBranch)) {
    throw new Error(`Delivery ${key} has invalid work branch: ${workBranch}`);
  }
  const stageValue = singletonProperty(block, "delivery-stage")!;
  if (!DELIVERY_STAGES.has(stageValue as DeliveryStage)) {
    throw new Error(`Delivery ${key} has invalid stage: ${stageValue}`);
  }
  const pullRequestNumberValue = singletonProperty(block, "pull-request-number", false);
  const pullRequestNumber = pullRequestNumberValue === null ? null : Number(pullRequestNumberValue);
  if (
    pullRequestNumber !== null &&
    (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber <= 0)
  ) {
    throw new Error(`Delivery ${key} has invalid pull-request-number: ${pullRequestNumberValue}`);
  }
  const overrideState = singletonProperty(block, "lifecycle-override", false);
  const recordedOverrideReason = singletonProperty(
    block,
    "lifecycle-override-reason",
    false,
  );
  if (overrideState !== null && overrideState !== "active") {
    throw new Error(`Delivery ${key} has invalid lifecycle-override: ${overrideState}`);
  }
  if (overrideState === "active" && !recordedOverrideReason) {
    throw new Error(`Delivery ${key} has an active override without a reason`);
  }
  if (overrideState === null && recordedOverrideReason !== null) {
    throw new Error(`Delivery ${key} has an override reason without an active override`);
  }
  return {
    block,
    key,
    repository,
    baseBranch,
    workBranch,
    stage: stageValue as DeliveryStage,
    pullRequestNumber,
    pullRequestUrl: singletonProperty(block, "pull-request-url", false),
    mergeCommit: singletonProperty(block, "merge-commit", false),
    overrideReason: overrideState === "active" ? recordedOverrideReason : null,
  };
}

export function deliveryIdentities(children: readonly Block[]): DeliveryIdentity[] {
  return children
    .filter((block) => block.properties.some((property) =>
      property.key === "type" && property.value === "delivery"
    ))
    .map(parseDeliveryIdentity);
}

export function selectActiveDelivery(
  children: readonly Block[],
  repository?: string | null,
  branch?: string | null,
): DeliveryIdentity | null {
  const records = deliveryIdentities(children);
  const exact = repository && branch
    ? records.filter((record) =>
      record.repository === repository && record.workBranch === branch
    )
    : [];
  if (exact.length > 1) {
    throw new Error(`Multiple delivery records claim ${repository}:${branch}`);
  }
  const open = records.filter((record) => record.stage !== "complete");
  if (open.length > 1) {
    const exactOpen = exact.filter((record) => record.stage !== "complete");
    if (exactOpen.length === 1) return exactOpen[0]!;
    throw new Error("Multiple incomplete delivery records exist; orient to a recorded branch explicitly");
  }
  if (open.length === 1) return open[0]!;
  return exact[0] ?? null;
}

export function deterministicDeliveryIdentity(workId: string): {
  deliveryKey: string;
  workBranch: string;
} {
  const normalized = workId.trim().toLowerCase();
  if (!/^[a-z]+-\d+$/.test(normalized)) throw new Error(`Invalid Work ID: ${workId}`);
  return {
    deliveryKey: `${workId.toUpperCase()}/primary`,
    workBranch: `feature/${normalized}`,
  };
}
