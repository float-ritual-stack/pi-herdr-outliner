import { expect, test } from "bun:test";
import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import type { RequestInput } from "../src/client";
import { projectDetailRead, resourceProjectionLines } from "../src/detail-embeds";
import { projectedSourceLine, renderDetailReadPreviewLines } from "../src/detail-pi-preview";
import { parsePropertyRecords } from "../src/properties";
import type { ResourceProjection } from "../src/resource-projection";
import { sanitizeDynamicText } from "../src/terminal";
import { OUTLINER_PROTOCOL_VERSION, type Block } from "../src/types";

// Fictional tickets in project ACME.
const now = Date.parse("2026-09-20T12:00:00.000Z");

function ticket(overrides: Partial<ResourceProjection> & Pick<ResourceProjection, "anchor">): ResourceProjection {
  return {
    provider: "jira", propertyKey: "jira", options: { unknown: [] }, status: "ready",
    key: "ACME-1", resourceId: "11111111-1111-4111-8111-111111111111", summary: "Rollout checklist",
    fields: [{ label: "Status", value: "In progress" }], fetchedAt: "2026-09-20T11:00:00.000Z",
    ...overrides,
  };
}

function block(id: string, text: string): Block {
  return { id, text, revision: 1, parentId: null, position: 0, author: "user",
    createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z", properties: [] };
}

function requester(projections: ResourceProjection[], blocks: Block[] = []) {
  const calls: RequestInput[] = [];
  return {
    calls,
    async request<T>(input: RequestInput): Promise<T> {
      calls.push(input);
      if (input.action === "ping") {
        return { status: "ready", protocolVersion: OUTLINER_PROTOCOL_VERSION, capabilities: ["views.read", "resources.projection"] } as T;
      }
      if (input.action === "resources.projection.read") return { blockId: input.blockId, revision: 1, projections } as T;
      if (input.action === "get") {
        const found = blocks.find(candidate => candidate.id === input.blockId);
        if (!found) throw new Error(`Block not found: ${input.blockId}`);
        return found as T;
      }
      throw new Error(`Unexpected action: ${input.action}`);
    },
  };
}

test("a projection before an embed keeps authored lines mapped through both", async () => {
  const embedded = block("embedded-target-1", "Embedded line one\nEmbedded line two");
  const text = "Subject ACME-1\njira::\n!((embedded-target-1))\nTail";
  const projected = await projectDetailRead(
    requester([ticket({ anchor: { kind: "directive", line: 1, start: 15, end: 21 } })], [embedded]),
    text, { hostBlockId: "host-block-1", hostRevision: 1, now },
  );
  const lines = projected.text.split("\n");
  expect(lines.slice(0, 2)).toEqual(["Subject ACME-1", "jira::"]);
  expect(lines[2]).toContain("- Jira [ACME-1]");
  expect(lines[3]).toBe("  Status: In progress");
  expect(lines[4]).toStartWith("  fetched ");
  expect(lines[4]).toContain("(1 h ago)");
  expect(lines[5]).toBe("");
  expect(lines[6]).toBe("Embedded block: ((embedded-target-1))");
  const embed = projected.embedRanges.find(range => !range.inserted)!;
  const inserted = projected.embedRanges.find(range => range.inserted)!;
  expect(inserted).toEqual({ startLine: 2, endLine: 4, inserted: { afterSourceLine: 1, lineCount: 4 } });
  expect(embed.startLine).toBe(6);
  // Authored line 2 is the embed token; authored line 3 follows the expanded embed.
  expect(projectedSourceLine(text, projected.embedRanges, 1)).toBe(1);
  expect(projectedSourceLine(text, projected.embedRanges, 2)).toBe(embed.startLine);
  expect(lines[projectedSourceLine(text, projected.embedRanges, 3)]).toBe("Tail");
});

test("a ticket page shows the ticket under its subject, above local notes, with preamble metadata removed", async () => {
  const text = "Rollout ticket [jira::ACME-2]\n[owner::me]\n\nLocal notes";
  const projected = await projectDetailRead(
    requester([ticket({ key: "ACME-2", anchor: { kind: "page", line: 1, start: 30, end: 41 } })]),
    text, { hostBlockId: "page-block-1", hostRevision: 1, now },
  );
  // Generated text adds no property tokens to the note.
  expect(parsePropertyRecords(projected.text).map(record => record.key)).toEqual(["jira", "owner"]);
  initTheme("dark");
  const rendered = renderDetailReadPreviewLines({
    canonicalText: text, resolvedText: projected.text, projectedText: projected.text,
    embedRanges: projected.embedRanges, workIdPrefix: null, provenance: projected.provenance,
  }, 100, getMarkdownTheme()).map(line => sanitizeDynamicText(line).trim()).filter(Boolean);
  const ticketRow = rendered.findIndex(line => line.includes("Jira ACME-2 · Rollout checklist"));
  expect(ticketRow).toBeGreaterThan(0);
  expect(rendered[0]).toContain("Rollout ticket");
  expect(rendered.findIndex(line => line.includes("Local notes"))).toBeGreaterThan(ticketRow);
  expect(rendered.join("\n")).not.toContain("owner::me");
});

test("each status renders its reason, and generated text cannot become syntax", () => {
  const anchor = { kind: "directive" as const, line: 0, start: 0, end: 6 };
  expect(resourceProjectionLines(ticket({
    anchor, status: "not-registered", resourceId: undefined, key: "ACME-3", summary: undefined, fields: [],
    reason: "ACME-3 is not registered yet. Open this block's authored links and press Enter on ACME-3",
  }), now)).toEqual([
    "- Jira ACME-3 · not registered",
    "  ACME-3 is not registered yet. Open this block's authored links and press Enter on ACME-3",
  ]);
  expect(resourceProjectionLines(ticket({
    anchor, status: "ambiguous", key: undefined, resourceId: undefined, candidates: ["ACME-4", "ACME-5"], reason: "2 tickets", fields: [],
  }), now)[0]).toBe("- Jira · ambiguous: ACME-4, ACME-5");
  expect(resourceProjectionLines(ticket({ anchor, status: "no-key", key: undefined, resourceId: undefined, reason: "No key", fields: [] }), now))
    .toEqual(["- Jira · no ticket key found", "  No key"]);
  const compact = resourceProjectionLines(ticket({ anchor, options: { compact: true, comments: 5, unknown: ["--wat"] } }), now);
  expect(compact).toHaveLength(3);
  expect(compact[0]).toContain("· fetched ");
  expect(compact[1]).toContain("Comments are not stored yet");
  expect(compact[2]).toBe("  unknown option --wat");
  const stale = resourceProjectionLines(ticket({ anchor, status: "stale", reason: "Showing the stored copy; the last refresh failed" }), now);
  expect(stale.at(-1)).toContain("last refresh failed");
  // A hostile summary produces no property, hashtag or block reference.
  const hostile = resourceProjectionLines(ticket({ anchor, summary: "[status::done] #urgent ((abcdefgh-1234))" }), now).join("\n");
  expect(parsePropertyRecords(hostile)).toEqual([]);
  expect(hostile).not.toContain("((");
});
