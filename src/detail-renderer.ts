import { extractFileAnnotationComment } from "./annotations";
import { completionWindow } from "./completion";
import {
  detailHelpText,
  selectedDetailFileRange,
  type DetailState,
  type DetailViewport,
} from "./detail-controller";
import { renderMarkdownLine, truncate } from "./terminal";

const ESC = "\x1b[";

function renderEditorLine(
  state: Readonly<DetailState>,
  line: string,
  row: number,
  width: number,
): string {
  if (row !== state.buffer.row) return truncate(line, width);
  const horizontalOffset = Math.max(0, state.buffer.column - width + 1);
  const visible = line.slice(horizontalOffset, horizontalOffset + width);
  const cursor = state.buffer.column - horizontalOffset;
  return `${visible.slice(0, cursor)}▏${visible.slice(cursor)}`;
}

function appendCompletion(
  output: string[],
  state: Readonly<DetailState>,
  width: number,
  height: number,
): void {
  const completion = state.completion;
  if (!completion) return;
  const available = Math.max(1, Math.min(6, height - output.length - 1));
  const window = completionWindow(completion.items.length, completion.index, available);
  const title = `Completions ${completion.index + 1}/${completion.items.length}`;
  output.push(`\x1b[2m${truncate(title, width)}\x1b[0m`);
  for (let index = window.start; index < window.end; index++) {
    const label = truncate(completion.items[index].label, Math.max(1, width - 2));
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
      `\x1b[2m${truncate(`Source: ${file.sourcePath}:${file.firstLine}-${lastLine}`, width)}\x1b[0m`,
    );
    const lineNumberWidth = String(lastLine).length;
    for (const [index, line] of file.lines.entries()) {
      const lineNumber = file.firstLine + index;
      const prefix = `${String(lineNumber).padStart(lineNumberWidth)} │ `;
      output.push(`${prefix}${truncate(line, Math.max(1, width - prefix.length))}`);
    }
    output.push("─".repeat(width));
  }
  output.push("\x1b[1mComment\x1b[0m");
  const comment = extractFileAnnotationComment(state.resolvedSelectedText);
  for (const line of (comment || "(No comment text)").split(/\r?\n/)) {
    output.push(renderMarkdownLine(truncate(line, width)));
  }
  return output;
}

export function renderDetailAnsi(
  state: Readonly<DetailState>,
  viewport: DetailViewport,
): string {
  const width = viewport.width;
  const height = viewport.height;
  const bodyHeight = Math.max(1, height - 5);
  const output: string[] = [`${ESC}H${ESC}2J`];
  output.push(
    `\x1b[1;36mDetail\x1b[0m  \x1b[2m${truncate(
      state.resolvedBreadcrumb || "No block selected",
      Math.max(1, width - 8),
    )}\x1b[0m`,
  );
  output.push("─".repeat(width));

  if (!state.context.selected) {
    output.push("Select a block in the outliner pane.");
  } else if (state.mode === "edit" || state.mode === "comment") {
    const lines = state.buffer.lines.slice(state.editorOffset, state.editorOffset + bodyHeight);
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
      const rendered = renderMarkdownLine(truncate(line, Math.max(1, width - prefix.length)));
      output.push(current ? `\x1b[48;5;238m${prefix}${rendered}\x1b[0m` : `${prefix}${rendered}`);
    }
  } else {
    for (const line of state.resolvedSelectedText
      .split(/\r?\n/)
      .slice(state.previewOffset, state.previewOffset + bodyHeight)) {
      output.push(renderMarkdownLine(truncate(line, width)));
    }
  }

  while (output.length < height - 2) output.push("");
  output.push(truncate(state.status, width));
  output.push(`\x1b[2m${truncate(detailHelpText(state.mode), width)}\x1b[0m`);
  return output.join("\n");
}
