import { parseArgs } from "node:util";
import { createOutlinerClient } from "./client";
import { resolveClientPaths } from "./paths";
import { orchestrateWorkflowRun } from "./workflow-orchestrator";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "run-id": { type: "string" },
  },
  strict: true,
});
const runId = values["run-id"]?.trim();
if (!runId) throw new Error("workflow runner requires --run-id");

const client = createOutlinerClient(resolveClientPaths());
const result = await orchestrateWorkflowRun(client, runId);
console.log(JSON.stringify(result, null, 2));
