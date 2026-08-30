import {
  firstOutlinerReference,
  linkOutlinerMarkdown,
  type OutlinerLinkTarget,
} from "./outliner-links";
import { sanitizeDynamicText } from "./terminal";
import type {
  AgentReport,
  AgentReportPromotion,
  Block,
  OutlinerEvent,
} from "./types";

export interface ReportState {
  report: AgentReport | null;
  cursorLine: number;
  selectionAnchor: number | null;
  status: string;
  busy: boolean;
}

export interface ReportEffects {
  load(): Promise<AgentReport>;
  promote(startLine?: number, endLine?: number): Promise<AgentReportPromotion>;
  clear(): Promise<void>;
  openReference(target: OutlinerLinkTarget): Promise<void>;
  openPromoted(block: Block): Promise<void>;
}

export type ReportIntent =
  | { type: "cursor.move"; delta: number }
  | { type: "selection.toggle" }
  | { type: "report.keep" }
  | { type: "report.discard" }
  | { type: "reference.open" };

export interface ReportController {
  readonly state: ReportState;
  initialize(): Promise<void>;
  dispatch(intent: ReportIntent): Promise<void>;
  onServiceEvent(event: OutlinerEvent): Promise<void>;
  onServiceError(error: unknown): void;
}

function reportLineCount(report: AgentReport | null): number {
  return report ? report.rawText.split(/\r?\n/).length : 1;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function selectedRange(state: Readonly<ReportState>): { startLine: number; endLine: number } | null {
  if (state.selectionAnchor === null) return null;
  return {
    startLine: Math.min(state.selectionAnchor, state.cursorLine),
    endLine: Math.max(state.selectionAnchor, state.cursorLine),
  };
}


export function renderAgentReportMarkdown(state: Readonly<ReportState>): string {
  const report = state.report;
  if (!report) return "_No settled agent report is available._";
  return linkOutlinerMarkdown(
    sanitizeDynamicText(report.resolvedText, true),
    sanitizeDynamicText(report.rawText, true),
    report.workIdPrefix ?? null,
  );
}

export function renderAgentReportSelectionLines(
  state: Readonly<ReportState>,
): string[] {
  const report = state.report;
  if (!report || state.selectionAnchor === null) return [];
  const range = selectedRange(state)!;
  return report.rawText.split(/\r?\n/).map((line, index) => {
    const selected = index >= range.startLine && index <= range.endLine;
    const cursor = index === state.cursorLine ? "▶" : " ";
    return `${cursor} ${selected ? "KEEP" : "    "} ${String(index + 1).padStart(4)} │ ${
      sanitizeDynamicText(line, true)
    }`;
  });
}

export function createReportController(
  effects: ReportEffects,
  onChange: (state: Readonly<ReportState>) => void,
): ReportController {
  const state: ReportState = {
    report: null,
    cursorLine: 0,
    selectionAnchor: null,
    status: "",
    busy: false,
  };

  const emit = (): void => onChange(state);
  const replaceReport = (report: AgentReport | null): void => {
    state.report = report;
    state.cursorLine = 0;
    state.selectionAnchor = null;
  };
  const load = async (): Promise<void> => {
    try {
      replaceReport(await effects.load());
      state.status = "Disposable · replaced by the next settled agent message";
    } catch {
      replaceReport(null);
      state.status = "Waiting for the next settled agent message";
    }
  };

  return {
    state,
    async initialize() {
      await load();
      emit();
    },
    async dispatch(intent) {
      if (state.busy) return;
      switch (intent.type) {
        case "cursor.move": {
          const maximum = Math.max(0, reportLineCount(state.report) - 1);
          state.cursorLine = Math.max(0, Math.min(maximum, state.cursorLine + intent.delta));
          break;
        }
        case "selection.toggle":
          if (!state.report) break;
          state.selectionAnchor = state.selectionAnchor === null ? state.cursorLine : null;
          state.status = state.selectionAnchor === null
            ? "Excerpt selection cancelled"
            : "Excerpt selection · move with ↑↓ · k keeps selected lines";
          break;
        case "report.keep": {
          if (!state.report) break;
          state.busy = true;
          emit();
          try {
            const range = selectedRange(state);
            const promoted = await effects.promote(range?.startLine, range?.endLine);
            state.selectionAnchor = null;
            state.status = range
              ? `Kept lines ${range.startLine + 1}-${range.endLine + 1} · ((${promoted.block.id}))`
              : `Kept report · ((${promoted.block.id}))`;
            try {
              await effects.openPromoted(promoted.block);
            } catch (error) {
              state.status += ` · navigation unavailable: ${errorMessage(error)}`;
            }
          } catch (error) {
            state.status = `Keep failed · ${errorMessage(error)}`;
          } finally {
            state.busy = false;
          }
          break;
        }
        case "report.discard":
          state.busy = true;
          emit();
          try {
            await effects.clear();
            replaceReport(null);
            state.status = "Discarded · no canonical block created";
          } catch (error) {
            state.status = `Discard failed · ${errorMessage(error)}`;
          } finally {
            state.busy = false;
          }
          break;
        case "reference.open": {
          if (!state.report) break;
          const reference = firstOutlinerReference(
            state.report.rawText,
            state.report.workIdPrefix ?? null,
          );
          if (!reference) {
            state.status = "No Outliner reference in this report";
            break;
          }
          try {
            await effects.openReference(reference);
            state.status = "Opened first Outliner reference";
          } catch (error) {
            state.status = `Navigation failed · ${errorMessage(error)}`;
          }
          break;
        }
      }
      emit();
    },
    async onServiceEvent(event) {
      if (event.domain !== "report") return;
      await load();
      emit();
    },
    onServiceError(error) {
      state.status = `Service error · ${errorMessage(error)}`;
      emit();
    },
  };
}
