import { parseArgs } from "node:util";
import { OutlinerClient } from "./client";
import { resolvePaths } from "./paths";
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

const client = new OutlinerClient(resolvePaths().socket);
const result = await orchestrateWorkflowRun(client, runId);
console.log(JSON.stringify(result, null, 2));
