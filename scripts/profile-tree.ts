import { closeSync, openSync, writeSync } from "node:fs";
import { performance } from "node:perf_hooks";
import type { RequestInput } from "../src/client";
import { TerminalInputDecoder } from "../src/terminal";
import { createTreeController, type TreeControllerEffects, type TreeView } from "../src/tree-controller";
import { renderTreeFrame } from "../src/tree-renderer";
import type { BlockProperty, VisibleBlock, VisibleBlockCollection, WorkspaceSnapshot } from "../src/types";
import { projectVirtualBranches, type TreePresentationState } from "../src/virtual-branches";

const blockCount = positiveInteger(process.env.PIE_TREE_PROFILE_BLOCKS, 24_000);
const iterations = positiveInteger(process.env.PIE_TREE_PROFILE_ITERATIONS, 80);
const projectionIterations = Math.max(8, Math.ceil(iterations / 8));
const width = positiveInteger(process.env.COLUMNS, 100);
const height = positiveInteger(process.env.LINES, 32);
const timestamp = "2026-08-31T00:00:00.000Z";

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function percentile(samples: readonly number[], fraction: number): number {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))] ?? 0;
}

async function measure(name: string, count: number, operation: () => void | Promise<void>): Promise<void> {
  const samples: number[] = [];
  for (let index = 0; index < count + 3; index += 1) {
    const started = performance.now();
    await operation();
    if (index >= 3) samples.push(performance.now() - started);
  }
  console.log(`${name.padEnd(24)} p50=${percentile(samples, 0.5).toFixed(3)}ms p95=${percentile(samples, 0.95).toFixed(3)}ms`);
}

function properties(index: number): BlockProperty[] {
  const result: BlockProperty[] = [
    { key: "status", value: index % 5 === 0 ? "active" : "backlog" },
    { key: "project", value: `area-${index % 16}` },
  ];
  if (index > 0 && index % 4_000 === 0) {
    result.push(
      { key: "type", value: "virtual-branch" },
      { key: "query", value: "status=active" },
      { key: "limit", value: "200" },
    );
  }
  return result;
}

function createFixture(): VisibleBlock[] {
  return Array.from({ length: blockCount }, (_, index) => {
    const groupOffset = index % 120;
    const depth = groupOffset === 0 ? 0 : groupOffset < 12 ? 1 : 2;
    const parentIndex = depth === 0 ? null : depth === 1 ? index - groupOffset : index - (groupOffset % 12);
    const id = `block-${index.toString().padStart(6, "0")}`;
    const subject = `PIE-${(index % 2_000).toString().padStart(3, "0")} realistic outline item ${index}`;
    const text = index % 97 === 0
      ? `${subject}\nSupporting context line for wrapping, references, and markdown rendering.\n- deterministic item ${index}`
      : `${subject} [status::${index % 5 === 0 ? "active" : "backlog"}]`;
    return {
      id,
      parentId: parentIndex === null ? null : `block-${parentIndex.toString().padStart(6, "0")}`,
      position: groupOffset,
      text,
      author: index % 7 === 0 ? "agent" : "user",
      createdAt: timestamp,
      updatedAt: timestamp,
      properties: properties(index),
      depth,
      hasChildren: groupOffset === 0 || (groupOffset > 0 && groupOffset < 12),
      displayText: text,
    } satisfies VisibleBlock;
  });
}

const physical = createFixture();
const branchMatches = physical.filter((_, index) => index % 5 === 0).slice(0, 201);
const complete = { kind: "complete" } as const;
const snapshot: WorkspaceSnapshot = {
  visible: { blocks: physical, completeness: complete },
  physical: { blocks: physical, completeness: complete },
  selection: { selected: physical[Math.floor(physical.length / 2)] ?? null, ancestors: [], children: [] },
  virtualOccurrenceRanks: [],
  sequence: 1,
  workIdPrefix: "PIE",
};
const presentation: TreePresentationState = {
  collapsedBlockIds: new Set(),
  multilineExpandedRowIds: new Set(),
};

function queryBlocks(): Promise<VisibleBlockCollection> {
  return Promise.resolve({ blocks: branchMatches, completeness: complete });
}

function request<T>(input: RequestInput): Promise<T> {
  if (input.action === "workspace.snapshot") return Promise.resolve(snapshot as T);
  if (input.action === "blocks.query") return Promise.resolve({ blocks: branchMatches, completeness: complete } as T);
  return Promise.resolve({} as T);
}

const effects: TreeControllerEffects = {
  workspaceRoot: "/profile/realistic-workspace",
  clientId: "tree-profiler",
  browsingContextId: "tree-profiler-context",
  request,
  filesystem: {
    completeReferencedPaths: () => [],
    readReferencedFile: () => ({ path: "", content: "" }),
  },
  createDetailPane: async () => {},
  focusSelf: () => {},
  terminalWidth: () => width,
  terminalHeight: () => height,
  stop: () => {},
  invalidate: () => {},
};

console.log(`Tree profile: ${blockCount.toLocaleString()} physical blocks, ${branchMatches.length} matches/virtual branch, ${width}x${height}`);

await measure("projection", projectionIterations, async () => {
  await projectVirtualBranches(physical, physical, queryBlocks, [], presentation);
});

await measure("controller-initialize", projectionIterations, async () => {
  const controller = createTreeController(effects);
  await controller.initialize();
});

const controller = createTreeController(effects);
await controller.initialize();
const decoder = new TerminalInputDecoder();
await measure("input-controller", iterations, async () => {
  const key = { name: controller.view().selectedIndex >= controller.view().rows.length - 2 ? "up" : "down" };
  await controller.handleKeypress("", key, decoder.consume("", key));
});

let scrollStart = 0;
let frame = "";
let selectedIndex = Math.floor(controller.view().rows.length / 2);
await measure("layout-render-jump", iterations, () => {
  const view: TreeView = { ...controller.view(), selectedIndex };
  frame = renderTreeFrame(view, width, height, 0).frame;
});

await measure("layout-render", iterations, () => {
  selectedIndex = selectedIndex >= controller.view().rows.length - 2 ? selectedIndex - 1 : selectedIndex + 1;
  const view: TreeView = { ...controller.view(), selectedIndex };
  const rendered = renderTreeFrame(view, width, height, scrollStart);
  scrollStart = rendered.scrollStartEntryIndex;
  frame = rendered.frame;
});
const selectedText = controller.view().rows[selectedIndex]?.block.displayText.match(/realistic outline item \d+/)?.[0];
if (!selectedText || !frame.includes(selectedText)) {
  throw new Error("Rendered frame did not contain the selected projected row");
}


const nullFd = openSync("/dev/null", "w");
try {
  await measure("terminal-frame", iterations, () => {
    writeSync(nullFd, frame);
  });
} finally {
  closeSync(nullFd);
}
