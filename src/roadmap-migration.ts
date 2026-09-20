import { parsePropertyRecords, patchPropertyText } from "./properties";
import { ROADMAP_WORK_STAGES, type Block, type PropertyPatchOperation } from "./types";

/** Plan explicit metadata edits; historical prose and other block types remain untouched. */
export function migrateRoadmapText(block: Pick<Block, "id" | "text">): string {
  const records = parsePropertyRecords(block.text).filter(record => record.scope === "block");
  const named = (key: string) => records.filter(record => record.key === key);
  if (!named("type").some(record => record.value === "roadmap-item")) return block.text;
  const stages = named("work-stage");
  const statuses = named("status");
  const fail = (reason: string): never => { throw new Error(`${block.id}: ${reason}`); };
  if (stages.length !== 1 || statuses.length > 1) fail("ambiguous roadmap lifecycle metadata");
  const oldStage = stages[0]!;
  const status = statuses[0]?.value;
  if (status && !["planned", "complete", "done", "superseded"].includes(status)) {
    fail(`unrecognized legacy status ${status}`);
  }
  let stage = oldStage.value === "next" ? "queued" : oldStage.value;
  if (status === "superseded") {
    if (named("superseded-by").length !== 1) fail("superseded item needs its replacement link");
    stage = "superseded";
  } else if (status && (status === "planned") === (stage === "done")) {
    fail("status and work-stage disagree; inspect delivery evidence");
  }
  if (!(ROADMAP_WORK_STAGES as readonly string[]).includes(stage)) fail(`unknown work-stage ${stage}`);
  const operations: PropertyPatchOperation[] = statuses.map(record => ({ op: "remove", ordinal: record.ordinal }));
  if (stage !== oldStage.value) operations.push({ op: "replace", ordinal: oldStage.ordinal, value: stage });
  return operations.length ? patchPropertyText(block.text, operations) : block.text;
}
