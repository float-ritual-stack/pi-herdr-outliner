import { expect, test } from "bun:test";
import {
  createReportController,
  renderAgentReportMarkdown,
  renderAgentReportSelectionLines,
  type ReportEffects,
} from "../src/report-controller";
import type { AgentReport, AgentReportPromotion, Block } from "../src/types";

function block(text: string): Block {
  return {
    id: "promoted-block",
    parentId: null,
    position: 0,
    text,
    author: "agent",
    actorId: "pi-outliner.agent-report",
    sessionId: "session-1",
    createdAt: "created",
    updatedAt: "updated",
    properties: [],
  };
}

function report(revision = 1): AgentReport {
  return {
    sessionId: "session-1",
    rawText: "Summary\nSee ((target-block)) and [[Roadmap]] and PIE-159\nFinal line",
    resolvedText: "Summary\nSee ((Target title)) and [[Roadmap]] and PIE-159\nFinal line",
    publishedAt: "published",
    revision,
    workIdPrefix: "PIE",
  };
}

function harness(initial = report()) {
  let current: AgentReport | null = initial;
  const promoted: Array<{ startLine?: number; endLine?: number }> = [];
  const openedReferences: unknown[] = [];
  const openedBlocks: Block[] = [];
  const effects: ReportEffects = {
    async load() {
      if (!current) throw new Error("unavailable");
      return current;
    },
    async promote(startLine, endLine): Promise<AgentReportPromotion> {
      promoted.push({ startLine, endLine });
      return {
        reportRevision: current!.revision,
        block: block(startLine === undefined ? current!.rawText : "selected excerpt"),
        startLine: startLine ?? 0,
        endLine: endLine ?? 2,
      };
    },
    async clear() {
      current = null;
    },
    async openReference(target) {
      openedReferences.push(target);
    },
    async openPromoted(target) {
      openedBlocks.push(target);
    },
  };
  const controller = createReportController(effects, () => {});
  return {
    controller,
    promoted,
    openedReferences,
    openedBlocks,
    replace(next: AgentReport | null) {
      current = next;
    },
  };
}

test("renders sanitized navigable Markdown without rewriting report text", async () => {
  const { controller } = harness();
  await controller.initialize();

  const rendered = renderAgentReportMarkdown(controller.state);
  expect(rendered).toContain("[PIE-159](pi-outliner://work/PIE-159)");
  expect(rendered).toContain("pi-outliner://page/Roadmap");
  expect(rendered).toContain("pi-outliner://block/target-block");
  expect(controller.state.report?.rawText).toBe(report().rawText);
});

test("replaces reports and keeps either the whole report or selected lines", async () => {
  const harnessed = harness();
  await harnessed.controller.initialize();

  await harnessed.controller.dispatch({ type: "report.keep" });
  expect(harnessed.promoted).toEqual([{ startLine: undefined, endLine: undefined }]);
  expect(harnessed.openedBlocks).toHaveLength(1);

  await harnessed.controller.dispatch({ type: "cursor.move", delta: 1 });
  await harnessed.controller.dispatch({ type: "selection.toggle" });
  await harnessed.controller.dispatch({ type: "cursor.move", delta: 1 });
  expect(renderAgentReportSelectionLines(harnessed.controller.state)).toContain(
    "▶ KEEP    3 │ Final line",
  );
  await harnessed.controller.dispatch({ type: "report.keep" });
  expect(harnessed.promoted.at(-1)).toEqual({ startLine: 1, endLine: 2 });

  harnessed.replace(report(2));
  await harnessed.controller.onServiceEvent({
    id: "event",
    domain: "report",
    action: "reports.publish",
    sequence: 1,
  });
  expect(harnessed.controller.state.report?.revision).toBe(2);
  expect(harnessed.controller.state.cursorLine).toBe(0);
});

test("opens references and discards without promotion", async () => {
  const harnessed = harness();
  await harnessed.controller.initialize();
  await harnessed.controller.dispatch({ type: "reference.open" });
  expect(harnessed.openedReferences).toEqual([{
    kind: "block",
    value: "target-block",
  }]);

  await harnessed.controller.dispatch({ type: "report.discard" });
  expect(harnessed.controller.state.report).toBeNull();
  expect(harnessed.promoted).toEqual([]);
});
