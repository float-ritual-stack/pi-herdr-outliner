import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAnnotationAnchor } from "../src/annotations";
import type { RequestInput } from "../src/client";
import { orchestrateWorkflowRun } from "../src/workflow-orchestrator";
import { OutlinerStore } from "../src/store";
import type {
  WorkflowCapability,
  WorkflowPlanInput,
  WorkflowRun,
  WorkflowStartInput,
  WorkflowStructure,
} from "../src/types";
import { planWorkflowRoute, WorkflowManager } from "../src/workflows";

const directories: string[] = [];
const stores: OutlinerStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup(): { store: OutlinerStore; workflows: WorkflowManager } {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-workflows-"));
  directories.push(directory);
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  stores.push(store);
  return { store, workflows: new WorkflowManager(store) };
}

const allCapabilities: WorkflowCapability[] = [
  "outline.structure",
  "outline.route",
  "attention.mark",
  "annotations.create",
  "annotations.reply",
  "annotations.batch",
  "promotion.preview",
  "promotion.commit",
];

function startInput(sourceBlockId: string, requestId = "workflow-start"): WorkflowStartInput {
  return {
    requestId,
    actionId: "walkthrough.plan",
    invocation: { kind: "block", sourceBlockId },
    capabilities: allCapabilities,
    limits: { fanOut: 8, calls: 12 },
    planner: "callscript",
    provenance: { actorId: "pi", sessionId: "session", taskId: requestId },
  };
}

function savePlan(workflows: WorkflowManager, run: WorkflowRun): WorkflowRun {
  const structure = workflows.structure(run.runId);
  const route = planWorkflowRoute(structure);
  const input: WorkflowPlanInput = {
    runId: run.runId,
    route,
    metrics: {
      planner: run.planner,
      modelTurns: 1,
      operations: 2,
      contextBytes: structure.contextBytes,
      wallTimeMs: 1,
      completeness: structure.completeness,
      artifactQuality: "usable",
      structureFirst: true,
    },
  };
  return workflows.savePlan(input);
}

describe("typed outline workflows", () => {
  test("starts idempotently, exposes bounded structure, and persists walkthrough transitions", () => {
    const { store, workflows } = setup();
    const hiddenBody = `PRIVATE-${"z".repeat(4_000)}`;
    const source = store.create([
      "Plan",
      "",
      "## Next actions",
      hiddenBody,
      "",
      "## Decision",
      "Choose the safe route.",
      "",
      "## Problem",
      "Understand the document.",
    ].join("\n"));
    const userComment = store.create("Owner comment: do not auto-resolve", source.id, "user");
    store.setSelection(source.id);
    const selectedBefore = store.getSelection().selected?.id;
    const textBefore = source.text;

    const started = workflows.start(startInput(source.id));
    expect(started.deduplicated).toBe(false);
    expect(started.run.status).toBe("planning");
    expect(started.run.capabilities).toEqual(allCapabilities);
    expect(started.run.limits).toEqual({ fanOut: 8, calls: 12 });
    expect(started.run.provenance).toEqual({
      actorId: "pi",
      sessionId: "session",
      taskId: "workflow-start",
    });
    const repeated = workflows.start(startInput(source.id));
    expect(repeated.deduplicated).toBe(true);
    expect(repeated.run.runId).toBe(started.run.runId);
    expect(() => workflows.start({
      ...startInput(source.id),
      limits: { fanOut: 2, calls: 4 },
    })).toThrow("different input");

    const structure = workflows.structure(started.run.runId);
    expect(structure.completeness).toEqual({ kind: "complete" });
    expect(structure.items[0]?.regions.map((region) => region.title)).toEqual([
      "Next actions",
      "Decision",
      "Problem",
    ]);
    expect(JSON.stringify(structure)).not.toContain(hiddenBody);
    expect(structure.items[0]?.sourceBytes).toBe(Buffer.byteLength(source.text));

    let run = savePlan(workflows, started.run);
    expect(run.status).toBe("ready");
    expect(run.route.map((step) => step.title)).toEqual([
      "Problem",
      "Decision",
      "Owner comment: do not auto-resolve",
      "Next actions",
    ]);
    expect(JSON.stringify(run.route)).not.toContain(hiddenBody);

    run = workflows.transition({ runId: run.runId, action: "next" });
    expect(run.currentStepIndex).toBe(0);
    expect(run.route[0]?.status).toBe("current");
    run = workflows.transition({ runId: run.runId, action: "next" });
    expect(run.currentStepIndex).toBe(1);
    expect(run.route[0]?.status).toBe("visited");
    run = workflows.transition({ runId: run.runId, action: "previous" });
    expect(run.currentStepIndex).toBe(0);
    run = workflows.transition({ runId: run.runId, action: "branch", question: "Keep this owner choice?" });
    expect(run.status).toBe("paused");
    expect(run.branchQuestion).toEqual(expect.objectContaining({
      stepId: run.route[0]?.stepId,
      question: "Keep this owner choice?",
    }));
    run = workflows.transition({ runId: run.runId, action: "resume" });
    expect(run.status).toBe("active");
    run = workflows.transition({ runId: run.runId, action: "skip" });
    expect(run.route[0]?.status).toBe("skipped");
    run = workflows.transition({ runId: run.runId, action: "pause" });
    expect(run.status).toBe("paused");
    run = workflows.transition({ runId: run.runId, action: "end" });
    expect(run.status).toBe("completed");

    const restarted = new WorkflowManager(store).get(run.runId);
    expect(restarted).toEqual(run);
    expect(store.require(source.id).text).toBe(textBefore);
    expect(store.require(userComment.id).text).toBe("Owner comment: do not auto-resolve");
    expect(store.getSelection().selected?.id).toBe(selectedBefore);
  });

  test("requires exact approval for idempotent annotation promotion without resolving owner judgment", () => {
    const { store, workflows } = setup();
    const source = store.create("Review\n\n## Decision\nKeep the explicit boundary.");
    const start = source.text.indexOf("Decision");
    const annotation = store.createAnnotation(
      "workflow-question",
      {
        target: {
          kind: "block",
          sourceBlockId: source.id,
          anchor: createAnnotationAnchor(source.text, start, start + "Decision".length, source.updatedAt),
        },
        body: "Owner asks whether this should become a decision.",
        source: "user",
      },
      "user",
    ).annotations[0]!;
    let run = savePlan(workflows, workflows.start(startInput(source.id, "promotion-run")).run);
    const decisionStep = run.route.find((step) => step.title === "Decision")!;
    const preview = workflows.previewPromotion({
      runId: run.runId,
      stepId: decisionStep.stepId,
      approvedBy: "owner",
      annotationId: annotation.block.id,
      kind: "decision",
      title: "Decision: keep explicit publication",
      body: "Owner approved this outcome.",
    });
    expect(preview.text).toContain(`[source-block::${annotation.block.id}]`);
    expect(preview.text).toContain(`[workflow-step::${decisionStep.stepId}]`);
    const blocksBefore = store.queryBlocks({ limit: 1_000 }).blocks.length;
    expect(() => workflows.commitPromotion({
      requestId: "promotion-commit",
      approvalToken: "wrong",
      input: preview.input,
    }, { actorId: "pi", sessionId: "session", taskId: "call" })).toThrow("exact preview");
    expect(store.queryBlocks({ limit: 1_000 }).blocks).toHaveLength(blocksBefore);

    const committed = workflows.commitPromotion({
      requestId: "promotion-commit",
      approvalToken: preview.approvalToken,
      input: preview.input,
    }, { actorId: "pi", sessionId: "session", taskId: "call" });
    expect(committed.deduplicated).toBe(false);
    expect(committed.block.author).toBe("agent");
    expect(committed.block.text).toContain("[approved-by::owner]");
    expect(committed.run.resultBlockIds).toEqual([committed.block.id]);
    expect(store.listAnnotationThreads({ sourceBlockId: source.id })[0]?.lifecycle).toBe("open");

    const replayed = new WorkflowManager(store).commitPromotion({
      requestId: "promotion-commit",
      approvalToken: preview.approvalToken,
      input: preview.input,
    });
    expect(replayed.deduplicated).toBe(true);
    expect(replayed.block.id).toBe(committed.block.id);
    const differentApproval = workflows.previewPromotion({
      ...preview.input,
      approvedBy: "different-owner",
    });
    expect(() => workflows.commitPromotion({
      requestId: "promotion-commit",
      approvalToken: differentApproval.approvalToken,
      input: differentApproval.input,
    })).toThrow("different approval");
    const resultQuery = store.queryBlocks({
      filters: [{ key: "workflow-run", value: run.runId }],
      limit: 10,
    });
    expect(resultQuery.blocks.map((block) => block.id)).toEqual([committed.block.id]);
    run = workflows.get(run.runId);
    expect(run.resultBlockIds).toEqual([committed.block.id]);
  });

  test("executes a bounded Callscript plan and records a direct-tool comparison", async () => {
    const { store, workflows } = setup();
    const source = store.create([
      "Architecture review",
      "",
      "## Context",
      "x".repeat(12_000),
      "",
      "## Risk",
      "Review the boundary.",
      "",
      "## Next action",
      "Record the result.",
    ].join("\n"));
    const started = workflows.start(startInput(source.id, "orchestration-run"));
    const requests: RequestInput[] = [];
    const client = {
      request: async <T>(request: RequestInput): Promise<T> => {
        requests.push(request);
        switch (request.action) {
          case "workflows.get":
            return workflows.get(request.runId) as T;
          case "workflows.structure":
            return workflows.structure(request.runId) as T;
          case "workflows.plan":
            return workflows.savePlan(request.input) as T;
          default:
            throw new Error(`Unexpected request: ${request.action}`);
        }
      },
    };

    const result = await orchestrateWorkflowRun(client, started.run.runId);
    expect(result.run.status).toBe("ready");
    expect(result.callscriptRoute).toEqual(result.directRoute);
    expect(result.comparison.callscript.modelTurns).toBe(1);
    expect(result.comparison.callscript.operations).toBe(2);
    expect(result.comparison.direct.modelTurns).toBeGreaterThan(1);
    expect(result.comparison.contextBytesSaved).toBeGreaterThan(10_000);
    expect(result.comparison.callscript.contextBytes).toBeLessThan(
      result.comparison.direct.contextBytes,
    );
    expect(requests.filter((request) => request.action === "workflows.structure")).toHaveLength(2);
    expect(requests.some((request) => request.action === "get")).toBe(false);

    const cancelled = workflows.start(startInput(source.id, "cancelled-run")).run;
    workflows.cancel(cancelled.runId);
    expect(() => workflows.structure(cancelled.runId)).toThrow("cancelled");
  });
});
