import {
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { extractFileAnnotationComment } from "./annotations";
import { completionWindow } from "./completion";
import {
  detailHelpText,
  detailVisibleEditorHeight,
  selectedDetailFileRange,
  type DetailState,
  type DetailViewport,
} from "./detail-controller";
import {
  layoutDetailEditor,
  type DetailEditorLayout,
  type DetailEditorVisualRow,
} from "./detail-editor-layout";
import { renderMarkdownLine, sanitizeDynamicText } from "./terminal";

const ESC = "\x1b[";

function fitToWidth(value: string, width: number): string {
  const fitted = truncateToWidth(value, Math.max(0, width), "…");
  return value.includes("\x1b") ? fitted : fitted.replaceAll("\x1b[0m", "");
}

function fitDynamicText(value: string, width: number): string {
  return fitToWidth(sanitizeDynamicText(value), width);
}

function fitBreadcrumb(value: string, width: number): string {
  const safe = sanitizeDynamicText(value || "No block selected");
  if (visibleWidth(safe) <= width) return safe;
  const segments = safe.split(" › ");
  let suffix = segments.pop() ?? safe;
  while (segments.length > 0) {
    const candidate = `${segments.at(-1)} › ${suffix}`;
    if (visibleWidth(`… › ${candidate}`) > width) break;
    suffix = candidate;
    segments.pop();
  }
  return fitToWidth(`… › ${suffix}`, width);
}

export function renderDetailHeader(
  state: Readonly<DetailState>,
  width: number,
): string[] {
  const connection = state.connectionMode === "locked" ? "Locked" : "Unlocked";
  const label = `Detail · ${connection}`;
  const header = width <= label.length + 2
    ? `\x1b[1;36m${fitToWidth(label, width)}\x1b[0m`
    : `\x1b[1;36m${label}\x1b[0m  \x1b[2m${fitBreadcrumb(
        state.resolvedBreadcrumb,
        Math.max(1, width - label.length - 2),
      )}\x1b[0m`;
  return [
    "",
    header,
    "─".repeat(width),
  ];
}

export function renderDetailFooter(
  state: Readonly<DetailState>,
  width: number,
  mode: DetailState["mode"] = state.mode,
  helpText = detailHelpText(mode),
): string[] {
  return [
    fitDynamicText(state.status, width),
    `\x1b[2m${fitToWidth(helpText, width)}\x1b[0m`,
  ];
}

function renderEditorText(
  row: DetailEditorVisualRow,
  startColumn: number,
  endColumn: number,
): string {
  const { selectionStartColumn, selectionEndColumn } = row;
  if (
    selectionStartColumn === null ||
    selectionEndColumn === null ||
    selectionEndColumn <= startColumn ||
    selectionStartColumn >= endColumn
  ) {
    return sliceByColumn(row.text, startColumn, endColumn - startColumn, true);
  }

  const selectedStart = Math.max(startColumn, selectionStartColumn);
  const selectedEnd = Math.min(endColumn, selectionEndColumn);
  const before = sliceByColumn(row.text, startColumn, selectedStart - startColumn, true);
  const selected = sliceByColumn(row.text, selectedStart, selectedEnd - selectedStart, true);
  const after = sliceByColumn(row.text, selectedEnd, endColumn - selectedEnd, true);
  return `${before}\x1b[7m${selected}\x1b[0m${after}`;
}

function renderEditorRow(
  layout: DetailEditorLayout,
  row: DetailEditorVisualRow,
  visualRowIndex: number,
): string {
  const prefix = row.continuation
    ? " ".repeat(layout.lineNumberWidth + 1)
    : `${String(row.logicalRow + 1).padStart(layout.lineNumberWidth)} `;
  const rowWidth = row.endColumn - row.startColumn;
  if (visualRowIndex !== layout.cursorRow) {
    return `${prefix}${renderEditorText(row, 0, rowWidth)}`;
  }

  const before = renderEditorText(row, 0, layout.cursorColumn);
  const afterWidth = Math.max(0, layout.contentWidth - visibleWidth(before) - 1);
  const after = renderEditorText(
    row,
    layout.cursorColumn,
    Math.min(rowWidth, layout.cursorColumn + afterWidth),
  );
  return `${prefix}${before}▏${after}`;
}

function appendCompletion(
  output: string[],
  state: Readonly<DetailState>,
  width: number,
  height: number,
): void {
  const completion = state.completion;
  if (!completion) return;
  const available = Math.min(6, height - output.length - 3);
  if (available < 1) return;
  const window = completionWindow(completion.items.length, completion.index, available);
  const title = `Completions ${completion.index + 1}/${completion.items.length}`;
  output.push(`\x1b[2m${fitToWidth(title, width)}\x1b[0m`);
  for (let index = window.start; index < window.end; index++) {
    const label = fitDynamicText(completion.items[index].label, Math.max(1, width - 2));
    output.push(index === completion.index ? `\x1b[7m› ${label}\x1b[0m` : `  ${label}`);
  }
}

export function buildDetailAnnotationView(
  state: Readonly<DetailState>,
  width: number,
): string[] {
  if (!state.context.selected) return [];
  const output: string[] = [];
  if (state.referencedFile) {
    const file = state.referencedFile;
    const lastLine = file.firstLine + Math.max(0, file.lines.length - 1);
    output.push(
      `\x1b[2m${fitDynamicText(
        `Source: ${file.sourcePath}:${file.firstLine}-${lastLine}`,
        width,
      )}\x1b[0m`,
    );
    const lineNumberWidth = String(lastLine).length;
    for (const [index, line] of file.lines.entries()) {
      const lineNumber = file.firstLine + index;
      const prefix = `${String(lineNumber).padStart(lineNumberWidth)} │ `;
      output.push(`${prefix}${fitDynamicText(line, Math.max(1, width - prefix.length))}`);
    }
    output.push("─".repeat(width));
  }
  output.push("\x1b[1mComment\x1b[0m");
  const comment = extractFileAnnotationComment(state.resolvedSelectedText);
  for (const line of (comment || "(No comment text)").split(/\r?\n/)) {
    output.push(renderMarkdownLine(fitDynamicText(line, width)));
  }
  return output;
}

export function renderDetailLines(
  state: Readonly<DetailState>,
  viewport: DetailViewport,
): string[] {
  const width = viewport.width;
  const height = viewport.height;
  const bodyHeight = Math.max(1, height - 5);
  const output = renderDetailHeader(state, width);

  if (!state.context.selected) {
    output.push("Select a block in the outliner pane.");
  } else if (state.mode === "edit" || state.mode === "comment") {
    const editorHeight = detailVisibleEditorHeight(state, viewport);
    const layout = layoutDetailEditor(
      state.buffer.lines,
      state.buffer.row,
      state.buffer.column,
      width,
      state.buffer.selectionRange,
    );
    const visibleRows = layout.rows.slice(
      state.editorVisualOffset,
      state.editorVisualOffset + editorHeight,
    );
    visibleRows.forEach((row, index) => {
      output.push(renderEditorRow(layout, row, state.editorVisualOffset + index));
    });
    appendCompletion(output, state, width, height);
  } else if (state.mode === "annotation") {
    for (const line of buildDetailAnnotationView(state, width).slice(
      state.previewOffset,
      state.previewOffset + bodyHeight,
    )) {
      output.push(line);
    }
  } else if (state.mode === "file" && state.referencedFile) {
    const file = state.referencedFile;
    const range = selectedDetailFileRange(state);
    const lineNumberWidth = String(file.firstLine + file.lines.length).length;
    const visibleLines = file.lines.slice(state.fileOffset, state.fileOffset + bodyHeight);
    for (const [index, line] of visibleLines.entries()) {
      const localIndex = state.fileOffset + index;
      const lineNumber = file.firstLine + localIndex;
      const inRange = range !== null && lineNumber >= range.startLine && lineNumber <= range.endLine;
      const current = localIndex === state.fileCursor;
      const prefix = `${current ? ">" : " "}${String(lineNumber).padStart(lineNumberWidth)} ${inRange ? "│" : " "} `;
      const rendered = renderMarkdownLine(
        fitDynamicText(line, Math.max(1, width - prefix.length)),
      );
      output.push(current ? `\x1b[48;5;238m${prefix}${rendered}\x1b[0m` : `${prefix}${rendered}`);
    }
  } else {
    for (const line of state.resolvedSelectedText
      .split(/\r?\n/)
      .slice(state.previewOffset, state.previewOffset + bodyHeight)) {
      output.push(renderMarkdownLine(fitDynamicText(line, width)));
    }
  }

  while (output.length < height - 2) output.push("");
  output.push(...renderDetailFooter(state, width));
  if (output.length <= height) return output;
  if (height <= 1) return output.slice(0, Math.max(0, height));
  const footerCount = Math.min(2, height - 1);
  return [...output.slice(0, height - footerCount), ...output.slice(-footerCount)];
}

export function renderDetailAnsi(
  state: Readonly<DetailState>,
  viewport: DetailViewport,
): string {
  const lines = renderDetailLines(state, viewport);
  lines[0] = `${ESC}H${ESC}2J`;
  return lines.join("\n");
}
