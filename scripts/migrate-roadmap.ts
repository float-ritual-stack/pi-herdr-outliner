import { parseArgs } from "node:util";
import { writeFile } from "node:fs/promises";
import { createOutlinerClient } from "../src/client";
import { resolveClientPaths } from "../src/paths";
import { migrateRoadmapText } from "../src/roadmap-migration";
import type { Block, VisibleBlockCollection } from "../src/types";

const { values } = parseArgs({ options: {
  project: { type: "string" }, apply: { type: "boolean" }, backup: { type: "string" },
}, strict: true });
if (!values.project) throw new Error("--project is required");
if (values.apply && !values.backup) throw new Error("--apply requires --backup <new-file>");
const client = createOutlinerClient(resolveClientPaths());
await client.requireCompatibleService();
const result = await client.request<VisibleBlockCollection>({ action: "blocks.query", query: {
  filters: [{ key: "type", value: "roadmap-item" }, { key: "project", value: values.project }],
  propertyScope: "block", limit: 1000,
} });
if (result.completeness.kind !== "complete") throw new Error("Roadmap query is truncated; narrow the project before migration");
const edits = result.blocks.map(block => ({ block, text: migrateRoadmapText(block) })).filter(edit => edit.text !== edit.block.text);
console.log(JSON.stringify({ mode: values.apply ? "apply" : "dry-run", project: values.project, checked: result.blocks.length, changes: edits.map(({ block }) => block.id) }));
if (values.apply && edits.length) {
  await writeFile(values.backup!, JSON.stringify({ at: new Date().toISOString(), project: values.project, edits }, null, 2), { flag: "wx", mode: 0o600 });
  for (const { block, text } of edits) {
    const updated = await client.request<Block>({ action: "update", blockId: block.id, text, expectedRevision: block.revision, mutation: { author: "agent", actorId: "roadmap-migration" } });
    const verified = await client.request<Block>({ action: "get", blockId: block.id });
    if (verified.revision !== updated.revision || verified.text !== text) throw new Error(`Migration readback changed: ${block.id}`);
    console.log(JSON.stringify({ updated: block.id, revision: verified.revision }));
  }
}
