import { expect, test } from "bun:test";
import { formatMissingReportSession } from "../src/report-startup";

test("lists available report session IDs with a rerun command", () => {
  expect(formatMissingReportSession([
    { sessionId: "newest-session" },
    { sessionId: "older-session" },
  ])).toBe([
    "OUTLINER_REPORT_SESSION_ID is required.",
    "",
    "Available report session IDs:",
    "  newest-session",
    "  older-session",
    "",
    "Set one and rerun:",
    "  OUTLINER_REPORT_SESSION_ID=<session-id> bun run src/report-main.ts",
  ].join("\n"));
});

test("explains empty and unavailable report listings", () => {
  expect(formatMissingReportSession([])).toContain(
    "(none — wait for an agent report to be published)",
  );
  expect(formatMissingReportSession([], "service unavailable")).toContain(
    "(unavailable: service unavailable)",
  );
});
