import {
  hyperlink,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { extractFileAnnotationComment } from "./annotations";
import { completionWindow } from "./completion";
import { outlinerLinkUri } from "./outliner-links";
import { blockDisplayTitle } from "./references";
import {
  detailHelpText,
  detailVisibleEditorHeight,
  selectedDetailFileRange,
  type DetailState,
  type DetailViewport,
} from "./detail-controller";
import { layoutDetailEditor } from "./detail-editor-layout";
import { renderTextBufferEditorRow } from "./text-buffer-editor";
import { renderMarkdownLine, sanitizeDynamicText } from "./terminal";

const ESC = "\x1b[";

function fitToWidth(value: string, width: number): string {
  const fitted = truncateToWidth(value, Math.max(0, width), "…");
  return value.includes("\x1b") ? fitted : fitted.replaceAll("\x1b[0m", "");
}

function fitDynamicText(value: string, width: number): string {
  return fitToWidth(sanitizeDynamicText(value), width);
}

const EMBED_BACKGROUND = "\x1b[48;5;236m";

function renderEmbedBackground(line: string, width: number): string {
  const padding = " ".repeat(Math.max(0, width - visibleWidth(line)));
  return `${EMBED_BACKGROUND}${
    line.replaceAll("\x1b[0m", `\x1b[0m${EMBED_BACKGROUND}`)
  }${padding}\x1b[0m`;
}

function isEmbeddedLine(state: Readonly<DetailState>, line: number): boolean {
  return state.embedBackgroundEnabled &&
    state.embedRanges.some((range) => line >= range.startLine && line <= range.endLine);
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

function fitLinkedBreadcrumb(state: Readonly<DetailState>, width: number): string {
  const blocks = [
    ...state.context.ancestors,
    ...(state.context.selected
      ? [{ ...state.context.selected, text: state.resolvedSelectedText }]
      : []),
  ];
  if (blocks.length === 0) return fitBreadcrumb(state.resolvedBreadcrumb, width);

  const titles = blocks.map((block, index) => {
    const title = sanitizeDynamicText(blockDisplayTitle(block));
    return state.targetFragmentId && index === blocks.length - 1
      ? `${title} · ^${state.targetFragmentId}`
      : title;
  });
  let start = titles.length - 1;
  let suffix = titles[start];
  while (start > 0) {
    const candidate = `${titles[start - 1]} › ${suffix}`;
    if (visibleWidth(`… › ${candidate}`) > width) break;
    start -= 1;
    suffix = candidate;
  }
  const linked = blocks.slice(start).map((block, index) => {
    const blockIndex = start + index;
    return hyperlink(
      titles[blockIndex],
      outlinerLinkUri("block", block.id, {
        intent: "reveal",
        ...(state.targetFragmentId && blockIndex === blocks.length - 1
          ? { fragmentId: state.targetFragmentId }
          : {}),
      }),
    );
  }).join(" › ");
  return fitToWidth(`${start > 0 ? "… › " : ""}${linked}`, width);
}

export interface DetailHeaderOptions {
  linkBreadcrumbs?: boolean;
  surface?: string;
  focused?: boolean;
}
const DETAIL_ACTION_MENU_URI = "pi-outliner-action:detail.menu.open";
const detailActionMenuLink = `\x1b]8;;${DETAIL_ACTION_MENU_URI}\x1b\\[⋯]\x1b]8;;\x1b\\`;

export function renderDetailHeader(
  state: Readonly<DetailState>,
  width: number,
  options: DetailHeaderOptions = {},
): string[] {
  const connection = state.connectionMode === "locked" ? "Locked" : "Unlocked";
  const label = `${options.surface ?? "Detail"} · ${connection}`;
  const breadcrumb = state.targetFragmentId
    ? `${state.resolvedBreadcrumb} · ^${state.targetFragmentId}`
    : state.resolvedBreadcrumb;
  const labelStyle = options.focused === false ? "\x1b[2;36m" : "\x1b[1;36m";
  let header: string;
  const menuWidth = 5;
  if (width <= label.length + menuWidth + 2) {
    const labelWidth = Math.max(1, width - menuWidth);
    header = `${labelStyle}${fitToWidth(label, labelWidth)}\x1b[0m ${detailActionMenuLink}`;
  } else {
    const breadcrumbWidth = Math.max(1, width - label.length - menuWidth - 2);
    const renderedBreadcrumb = options.linkBreadcrumbs
      ? fitLinkedBreadcrumb(state, breadcrumbWidth)
      : fitBreadcrumb(breadcrumb, breadcrumbWidth);
    header = `${labelStyle}${label}\x1b[0m ${detailActionMenuLink} \x1b[2m${renderedBreadcrumb}\x1b[0m`;
  }
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

export interface DetailRenderOptions {
  header?: DetailHeaderOptions;
  helpPrefix?: string;
  helpText?: string;
}

export function renderDetailLines(
  state: Readonly<DetailState>,
  viewport: DetailViewport,
  options: DetailRenderOptions = {},
): string[] {
  const width = viewport.width;
  const height = viewport.height;
  const bodyHeight = Math.max(1, height - 5);
  const output = renderDetailHeader(state, width, options.header);

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
      output.push(renderTextBufferEditorRow(layout, row, state.editorVisualOffset + index));
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
    const lines = state.resolvedSelectedText.split(/\r?\n/);
    for (
      let lineIndex = state.previewOffset;
      lineIndex < Math.min(lines.length, state.previewOffset + bodyHeight);
      lineIndex += 1
    ) {
      const rendered = renderMarkdownLine(fitDynamicText(lines[lineIndex]!, width));
      output.push(
        isEmbeddedLine(state, lineIndex) ? renderEmbedBackground(rendered, width) : rendered,
      );
    }
  }

  while (output.length < height - 2) output.push("");
  const helpText = options.helpText ??
    (options.helpPrefix
      ? `${options.helpPrefix}  ${detailHelpText(state.mode)}`
      : detailHelpText(state.mode));
  output.push(...renderDetailFooter(state, width, state.mode, helpText));
  if (output.length <= height) return output;
  if (height <= 1) return output.slice(0, Math.max(0, height));
  const footerCount = Math.min(2, height - 1);
  return [...output.slice(0, height - footerCount), ...output.slice(-footerCount)];
}

export function renderDetailAnsi(
  state: Readonly<DetailState>,
  viewport: DetailViewport,
  options: DetailRenderOptions = {},
): string {
  const lines = renderDetailLines(state, viewport, options);
  lines[0] = `${ESC}H${ESC}2J`;
  return lines.join("\n");
}
