import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Block } from "../../src/types";
import { runHerdrScenario } from "./herdr-runner";

const renderer = process.argv.includes("--ansi") ? "ansi" : "pi-tui";
const result = await runHerdrScenario({
  name: `resource-occurrences-${renderer}`,
  async prepare(root) {
    await writeFile(join(root, "same.md"), "# Shared Resource\nFIRST FILE LINE\nSECOND FILE LINE\n");
  },
  async run(session) {
    await session.attachClient();
    const panes = renderer === "ansi"
      ? await session.openRemoteBrowsingContext({ renderer }) : session.panes;
    const sourceText = "Occurrence choices\n\nFirst use [file::same.md].\nSecond use [file::same.md].";
    const source = await session.client.request<Block>({ action: "create", parentId: null, text: sourceText });
    const resourceCount = () => (session.database.query("SELECT count(*) AS count FROM resources").get() as { count: number }).count;
    const baseline = resourceCount();
    const registration = (await session.registrations()).find(client => client.runtime?.paneId === panes.detail);
    assert.ok(registration);
    const current = async () => (await session.registrations()).find(client => client.clientId === registration.clientId);
    const revealSource = async () => {
      await session.revealTree(panes.tree, source.id);
      await session.waitFor("source target published", current, client =>
        client?.currentTarget?.kind === "block" && client.currentTarget.blockId === source.id);
      const frame = await session.waitVisible(panes.detail, "Occurrence choices");
      await session.focus(panes.detail);
      if (renderer === "ansi" ? frame.includes("Properties ·") : frame.includes("▾ Properties")) {
        await session.keys(panes.detail, "p");
      }
      await session.waitVisible(panes.detail, "First use");
    };
    await revealSource();
    assert.equal(resourceCount(), baseline);
    await session.checkpoint("01-passive-duplicate-occurrences");
    await session.keys(panes.detail, "o");
    await session.waitVisible(panes.detail, "Choose a reference");
    assert.equal(resourceCount(), baseline);
    await session.checkpoint("02-choose-occurrence-without-interning");
    await session.keys(panes.detail, "tab");
    await session.keys(panes.detail, "o");
    await session.waitVisible(panes.detail, "Choose destination");
    assert.equal(resourceCount(), baseline);
    await session.keys(panes.detail, "enter");
    await session.waitVisible(panes.detail, "SECOND FILE LINE");
    await session.waitFor("Resource target published", current, client => client?.currentTarget?.kind === "resource");
    assert.equal(resourceCount(), baseline + 1);
    const resourceTarget = (await current())!.currentTarget;
    await session.checkpoint("03-second-occurrence-opens-resource");

    await revealSource();
    await session.keys(panes.detail, "o");
    await session.waitVisible(panes.detail, "Choose a reference");
    await session.keys(panes.detail, "o");
    await session.waitVisible(panes.detail, "Choose destination");
    await session.keys(panes.detail, "enter");
    await session.waitVisible(panes.detail, "SECOND FILE LINE");
    await session.waitFor("same canonical Resource reused", current, client =>
      JSON.stringify(client?.currentTarget) === JSON.stringify(resourceTarget));
    assert.equal(resourceCount(), baseline + 1);
    assert.equal((await session.client.request<Block>({ action: "get", blockId: source.id })).text, sourceText);
    await session.record("occurrence-result", { renderer, sourceId: source.id, sourceText,
      baselineResourceCount: baseline, finalResourceCount: resourceCount(), resourceTarget,
      input: "RPC Tree reveal setup; real Detail o/Tab/o/Enter, repeat first occurrence",
      limits: "Keyboard activation; native pointer activation has renderer/controller coverage only." });
    await session.checkpoint("04-first-occurrence-reuses-resource");
  },
});
process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.status === "failed") process.exitCode = 1;
