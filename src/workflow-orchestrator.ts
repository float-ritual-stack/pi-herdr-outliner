import { scriptEngine, tool } from "callscript";
import { OutlinerClient } from "./client";
import { planWorkflowRoute } from "./workflows";
import type {
  WorkflowComparison,
  WorkflowMetrics,
  WorkflowPlanInput,
  WorkflowRun,
  WorkflowStep,
  WorkflowStructure,
} from "./types";

interface WorkflowOrchestrationResult {
  run: WorkflowRun;
  directRoute: WorkflowStep[];
  callscriptRoute: WorkflowStep[];
  comparison: WorkflowComparison;
}

function directMetrics(structure: WorkflowStructure, wallTimeMs: number): WorkflowMetrics {
  const operations = Math.max(1, structure.items.length + 1);
  return {
    planner: "pi-direct",
    modelTurns: operations,
    operations,
    contextBytes: structure.contextBytes,
    wallTimeMs,
    completeness: structure.completeness,
    artifactQuality: "usable",
    structureFirst: true,
  };
}

function callscriptMetrics(
  structure: WorkflowStructure,
  wallTimeMs: number,
  operations: number,
): WorkflowMetrics {
  return {
    planner: "callscript",
    modelTurns: 1,
    operations,
    contextBytes: structure.contextBytes,
    wallTimeMs,
    completeness: structure.completeness,
    artifactQuality: "usable",
    structureFirst: true,
  };
}

export async function orchestrateWorkflowRun(
  client: Pick<OutlinerClient, "request">,
  runId: string,
): Promise<WorkflowOrchestrationResult> {
  const initial = await client.request<WorkflowRun>({ action: "workflows.get", runId });
  if (initial.cancellationRequested || initial.status === "cancelled") {
    throw new Error("Workflow run is cancelled");
  }

  const directStarted = performance.now();
  const directStructure = await client.request<WorkflowStructure>({
    action: "workflows.structure",
    runId,
  });
  const directRoute = planWorkflowRoute(directStructure);
  const direct = directMetrics(
    directStructure,
    Math.max(0, Math.round(performance.now() - directStarted)),
  );

  const structureTool = tool({
    name: "outline.structure",
    description: "Read bounded outline structure and source anchors without copying full block bodies",
    idempotent: true,
    execute: async (args: { runId: string }): Promise<WorkflowStructure> => {
      const current = await client.request<WorkflowRun>({ action: "workflows.get", runId: args.runId });
      if (current.cancellationRequested || current.status === "cancelled") {
        throw new Error("Workflow run is cancelled");
      }
      return client.request<WorkflowStructure>({ action: "workflows.structure", runId: args.runId });
    },
  });
  const routeTool = tool({
    name: "outline.route",
    description: "Choose a deterministic semantic walkthrough order from bounded structure",
    idempotent: true,
    execute: (args: { structure: WorkflowStructure }): WorkflowStep[] => planWorkflowRoute(args.structure),
  });
  const engine = scriptEngine({
    tools: [structureTool, routeTool],
    limits: {
      maxSteps: Math.min(10, initial.limits.calls),
      maxItemsPerStep: initial.limits.fanOut,
      maxTotalCalls: initial.limits.calls,
      maxConcurrency: Math.min(4, initial.limits.fanOut),
    },
  });
  const script = {
    version: "2" as const,
    intent: "Plan a bounded structure-first outline walkthrough",
    steps: [
      {
        id: "structure",
        call: "outline.structure",
        args: { runId },
        reason: "Inspect bounded structure before choosing a route",
      },
      {
        id: "route",
        call: "outline.route",
        args: { structure: "=structure" },
        reason: "Order canonical anchors without copying source bodies",
      },
    ],
    output: "=route",
  };
  const callscriptStarted = performance.now();
  const callscriptResult = await engine.run({ script });
  if (callscriptResult.status !== "ok" || !Array.isArray(callscriptResult.output)) {
    const detail = callscriptResult.status === "error"
      ? `${callscriptResult.error.code ?? "error"}: ${callscriptResult.error.message}`
      : callscriptResult.status;
    throw new Error(`Callscript walkthrough plan failed: ${detail}`);
  }
  const callscriptRoute = callscriptResult.output as WorkflowStep[];
  const callscript = callscriptMetrics(
    directStructure,
    Math.max(0, Math.round(performance.now() - callscriptStarted)),
    2,
  );
  const comparison: WorkflowComparison = {
    direct,
    callscript,
    contextBytesSaved: Math.max(0, direct.contextBytes - callscript.contextBytes),
    operationDelta: direct.operations - callscript.operations,
  };
  const selectedRoute = initial.planner === "callscript" ? callscriptRoute : directRoute;
  const selectedMetrics = initial.planner === "callscript" ? callscript : direct;
  const planInput: WorkflowPlanInput = {
    runId,
    route: selectedRoute,
    metrics: selectedMetrics,
    comparison,
  };
  const run = await client.request<WorkflowRun>({ action: "workflows.plan", input: planInput });
  return { run, directRoute, callscriptRoute, comparison };
}
