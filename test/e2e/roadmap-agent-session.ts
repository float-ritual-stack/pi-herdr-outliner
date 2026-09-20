// A separate process exercises Pi's real extension runtime and persisted session.
// No model request or GitHub operation is needed to test task binding/reentry.
import assert from "node:assert/strict";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import outlinerExtension from "../../pi-extension/index";
import { createOutlinerClient } from "../../src/client";
import { resolveClientPaths } from "../../src/paths";
import type { Block } from "../../src/types";

const [mode, artifactRoot, batchId, firstId, secondId, sessionFile] = process.argv.slice(2);
assert.ok(artifactRoot && batchId && firstId && secondId);
const cwd = process.cwd();
const agentDir = join(artifactRoot, "pi-config");
const manager = sessionFile
  ? SessionManager.open(sessionFile)
  : SessionManager.create(cwd, join(artifactRoot, "pi-sessions"));
if (!sessionFile) {
  // Pi defers file creation until a first assistant message. This is fixture
  // history only; task bindings below are written by the production extension.
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Batch reentry fixture" }],
    api: "openai-responses", provider: "fixture", model: "fixture", stopReason: "stop", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
}
const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true,
  noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  extensionFactories: [{ name: "outliner-under-test", factory: outlinerExtension }] });
await loader.reload();
const { session } = await createAgentSession({ cwd, agentDir, resourceLoader: loader, sessionManager: manager });
const errors: unknown[] = [];
await session.bindExtensions({ onError: error => errors.push(error) });
const runner = session.extensionRunner;
const call = async (name: string, params: Record<string, unknown>) => {
  const tool = runner.getToolDefinition(name);
  assert.ok(tool, `Missing production extension tool ${name}`);
  const result = await tool.execute(crypto.randomUUID(), params, undefined, undefined, runner.createContext());
  return JSON.parse(result.content.filter(part => part.type === "text").map(part => part.text).join("\n"));
};
const client = createOutlinerClient(resolveClientPaths());
const stage = async (id: string, value: string) => {
  const block = await client.request<Block>({ action: "get", blockId: id });
  const delivery = (await client.request<Block[]>({ action: "children", parentId: id })).find(b => b.properties.some(p => p.key === "type" && p.value === "delivery"))!;
  const number = value === "review" ? 1 : 2;
  await client.request({ action: "deliveries.sync", input: {
    taskBlockId: id,
    deliveryBlockId: delivery.id, expectedDeliveryRevision: delivery.revision, expectedTaskRevision: block.revision,
    pullRequest: { number, url: `https://github.com/fixture/outliner-batch-test/pull/${number}`,
      state: value === "review" ? "OPEN" : "MERGED", mergeCommit: value === "validate" ? "fixture-merge-commit" : null },
  }, mutation: { author: "agent", actorId: "batch-harness" } });
};
try {
  if (mode === "start") {
    assert.equal((await call("outliner_task", { operation: "start", address: secondId })).stage, "doing");
    await call("outliner_task", { operation: "pause" });
    await stage(secondId, "validate");
    assert.equal((await call("outliner_task", { operation: "start", address: firstId })).stage, "doing");
    await stage(firstId, "review");
  } else {
    assert.equal(mode, "resume");
  }
  const status = await call("outliner_task", { operation: "status" });
  assert.equal(status.blockId, firstId);
  assert.equal(status.stage, "review");
  assert.equal(status.workBatchId, batchId);
  const report = await call("outliner_query", { filters: [{ key: "type", value: "roadmap-item" }, { key: "work-batch", value: batchId }], limit: 10 });
  assert.equal(report.completeness.kind, "complete");
  assert.equal(report.blocks.length, 3);
  assert.deepEqual(report.blocks.map((block: Block) => block.properties.find(p => p.key === "work-stage")!.value).sort(), ["queued", "review", "validate"]);
  assert.equal(errors.length, 0, JSON.stringify(errors));
  console.log(JSON.stringify({ mode, pid: process.pid, sessionFile: manager.getSessionFile(), status, report }));
} finally {
  await runner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
}
