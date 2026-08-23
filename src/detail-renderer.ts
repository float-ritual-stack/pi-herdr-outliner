import {
  sliceByColumn,
  stripTerminalSequences,
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
import { renderMarkdownLine } from "./terminal";

const ESC = "\x1b[";

function sanitizeDynamicText(value: string): string {
  return stripTerminalSequences(value)
    .replace(/\t/g, "    ")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

function fitToWidth(value: string, width: number): string {
  const fitted = truncateToWidth(value, Math.max(0, width), "…");
  return value.includes("\x1b") ? fitted : fitted.replaceAll("\x1b[0m", "");
}

function fitDynamicText(value: string, width: number): string {
  return fitToWidth(sanitizeDynamicText(value), width);
}

function renderEditorLine(
  state: Readonly<DetailState>,
  line: string,
  row: number,
  width: number,
): string {
  const safeLine = sanitizeDynamicText(line);
  if (row !== state.buffer.row) return fitToWidth(safeLine, width);

  const textWidth = Math.max(0, width - 1);
  const cursorIndex = Math.min(state.buffer.column, line.length);
  const cursorColumn = visibleWidth(sanitizeDynamicText(line.slice(0, cursorIndex)));
  const horizontalOffset = Math.max(0, cursorColumn - textWidth);
  const before = sliceByColumn(
    safeLine,
    horizontalOffset,
    cursorColumn - horizontalOffset,
    true,
  );
  const after = sliceByColumn(
    safeLine,
    cursorColumn,
    textWidth - visibleWidth(before),
    true,
  );
  return `${before}▏${after}`;
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
  const output: string[] = [""];
  output.push(
    `\x1b[1;36mDetail\x1b[0m  \x1b[2m${fitDynamicText(
      state.resolvedBreadcrumb || "No block selected",
      Math.max(1, width - 8),
    )}\x1b[0m`,
  );
  output.push("─".repeat(width));

  if (!state.context.selected) {
    output.push("Select a block in the outliner pane.");
  } else if (state.mode === "edit" || state.mode === "comment") {
    const editorHeight = detailVisibleEditorHeight(state, viewport);
    const lines = state.buffer.lines.slice(state.editorOffset, state.editorOffset + editorHeight);
    for (const [index, line] of lines.entries()) {
      const row = state.editorOffset + index;
      const prefix = `${String(row + 1).padStart(4)} `;
      output.push(
        `${prefix}${renderEditorLine(state, line, row, Math.max(1, width - prefix.length))}`,
      );
    }
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
  output.push(fitDynamicText(state.status, width));
  output.push(`\x1b[2m${fitToWidth(detailHelpText(state.mode), width)}\x1b[0m`);
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
