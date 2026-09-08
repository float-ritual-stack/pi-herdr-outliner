import { describe, expect, test } from "bun:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { createAnnotationAnchor } from "../src/annotations";
import {
  attentionClientState,
  attentionSourceState,
  currentAttentionMark,
  normalizeAttentionMark,
} from "../src/attention";
import {
  attentionBanner,
  attentionReturnSummary,
  decorateAttentionLines,
} from "../src/attention-render";
import type { Block, OutlinerClientRegistration } from "../src/types";

const source: Block = {
  id: "source-block",
  parentId: null,
  position: 0,
  text: "alpha 🧭 beta\nsecond line",
  author: "user",
  createdAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-05T00:00:01.000Z",
  properties: [],
};
const client: OutlinerClientRegistration = {
  clientId: "detail-one",
  role: "detail",
  contextId: "context-one",
};

function mark(now = Date.parse("2026-09-05T00:01:00.000Z")) {
  return normalizeAttentionMark({
    markId: "mark-one",
    targetClientId: client.clientId,
    target: {
      kind: "block",
      sourceBlockId: source.id,
      anchor: createAnnotationAnchor(source.text, 6, 13, source.updatedAt),
    },
    tone: "warning",
    sender: "agent-one",
    expiresInMs: 1_000,
  }, client, source, now);
}

describe("ephemeral attention", () => {
  test("normalizes an exact UTF-16 anchor with bounded expiry", () => {
    const normalized = mark();
    expect(normalized.target.anchor?.excerpt).toBe("🧭 beta");
    expect(normalized.sourceState).toBe("active");
    expect(normalized.role).toBe("current");
    expect(Date.parse(normalized.expiresAt) - Date.parse(normalized.createdAt)).toBe(1_000);
  });

  test("rejects stale source evidence and mismatched excerpts", () => {
    const anchor = createAnnotationAnchor(source.text, 0, 5, source.updatedAt);
    expect(() => normalizeAttentionMark({
      markId: "stale",
      targetClientId: client.clientId,
      target: {
        kind: "block",
        sourceBlockId: source.id,
        anchor: { ...anchor, sourceHash: "stale" },
      },
      tone: "current",
      sender: "agent",
    }, client, source)).toThrow("source evidence");
    expect(() => normalizeAttentionMark({
      markId: "wrong-excerpt",
      targetClientId: client.clientId,
      target: {
        kind: "block",
        sourceBlockId: source.id,
        anchor: { ...anchor, excerpt: "omega" },
      },
      tone: "current",
      sender: "agent",
    }, client, source)).toThrow("excerpt");
  });

  test("reports changed block sources as stale without moving the range", () => {
    const normalized = mark();
    expect(attentionSourceState(normalized, source)).toBe("active");
    expect(attentionSourceState(normalized, {
      ...source,
      text: `prefix ${source.text}`,
      updatedAt: "2026-09-05T00:02:00.000Z",
    })).toBe("stale");
    expect(normalized.target.anchor?.start).toBe(6);
  });

  test("coalesces pending cues and retains one dominant current mark", () => {
    const normalized = mark();
    const supporting = { ...normalized, markId: "support", role: "supporting" as const };
    const state = attentionClientState(client.clientId, [supporting, normalized], 4);
    expect(state.currentMarkId).toBe(normalized.markId);
    expect(state.summary).toBe("4 attention cues · latest warning on source-b");
    expect(currentAttentionMark(state, source.id)?.markId).toBe(normalized.markId);
  });

  test("renders an exact non-color phrase treatment and width-safe return cue", () => {
    const normalized = mark();
    const state = attentionClientState(client.clientId, [normalized], 3);
    const lines = decorateAttentionLines(["alpha 🧭 beta continues"], normalized, 24);
    expect(stripTerminalSequences(lines[0]!)).toContain("▐ alpha 🧭 beta");
    expect(lines[0]).toContain("\x1b[1;4;33m");
    expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(24);
    expect(stripTerminalSequences(attentionBanner(state, source.id, 48)!)).toContain(
      "ATTENTION WARNING",
    );
    const summary = attentionReturnSummary(state, 32)!;
    expect(stripTerminalSequences(summary)).toContain("3 attention cues");
    expect(visibleWidth(summary)).toBeLessThanOrEqual(32);
  });

  test("uses source offsets to mark the intended repeated phrase", () => {
    const duplicateSource = {
      ...source,
      text: "repeat then repeat",
      updatedAt: "duplicate-v1",
    };
    const secondStart = duplicateSource.text.lastIndexOf("repeat");
    const duplicate = normalizeAttentionMark({
      markId: "duplicate",
      targetClientId: client.clientId,
      target: {
        kind: "block",
        sourceBlockId: duplicateSource.id,
        anchor: createAnnotationAnchor(
          duplicateSource.text,
          secondStart,
          secondStart + "repeat".length,
          duplicateSource.updatedAt,
        ),
      },
      tone: "warning",
      sender: "agent-one",
    }, client, duplicateSource);
    const rendered = decorateAttentionLines(
      [duplicateSource.text],
      duplicate,
      80,
      duplicateSource.text,
    )[0]!;

    expect(rendered).toContain(`repeat then \x1b[1;4;33mrepeat`);
    expect(rendered).not.toContain(`\x1b[1;4;33mrepeat then`);
  });
});
