import type { AgentReportSummary } from "./types";

export function formatMissingReportSession(
  reports: readonly Pick<AgentReportSummary, "sessionId">[],
  listingError?: string,
): string {
  const available = listingError
    ? [`  (unavailable: ${listingError})`]
    : reports.length === 0
    ? ["  (none — wait for an agent report to be published)"]
    : reports.map((report) => `  ${report.sessionId}`);
  return [
    "OUTLINER_REPORT_SESSION_ID is required.",
    "",
    "Available report session IDs:",
    ...available,
    "",
    "Set one and rerun:",
    "  OUTLINER_REPORT_SESSION_ID=<session-id> bun run src/report-main.ts",
  ].join("\n");
}
