import {
  hyperlink,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { extractAnnotationBody, parseAnnotationBlock } from "./annotations";
import { completionWindow } from "./completion";
import { outlinerLinkUri } from "./outliner-links";
import { blockDisplayTitle } from "./references";
import { outlinerActionLink } from "./outliner-actions";
import {
  detailHelpText,
  detailVisibleEditorHeight,
  selectedDetailFileRange,
  type DetailState,
  type DetailViewport,
} from "./detail-controller";
import { layoutDetailEditor } from "./detail-editor-layout";
import { openDestinationChooserHelp } from "./open-destination-chooser";
import {
  DEFAULT_PROPERTY_SUMMARY_KEYS,
  propertySummarySegments,
} from "./property-summary";
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
  const safe = sanitizeDynamicText(value);
  if (!safe || width <= 0) return "";
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

function detailTitle(state: Readonly<DetailState>): string {
  const selected = state.context.selected;
  const breadcrumbTitle = state.resolvedBreadcrumb
    .split(" › ")
    .at(-1)
    ?.trim();
  const title = selected
    ? breadcrumbTitle || blockDisplayTitle(selected)
    : state.resolvedBreadcrumb || "No block selected";
  return state.targetFragmentId ? `${title} · ^${state.targetFragmentId}` : title;
}

function renderDetailTitle(
  state: Readonly<DetailState>,
  width: number,
  linksEnabled: boolean,
  focused: boolean | undefined,
): string {
  const safe = sanitizeDynamicText(detailTitle(state));
  const fitted = fitToWidth(safe, width);
  const linked = linksEnabled && state.context.selected
    ? hyperlink(
      fitted,
      outlinerLinkUri("block", state.context.selected.id, {
        intent: "reveal",
        ...(state.targetFragmentId ? { fragmentId: state.targetFragmentId } : {}),
      }),
    )
    : fitted;
  const style = focused === false ? "\x1b[2;37m" : "\x1b[1;97m";
  return `${style}${linked}\x1b[0m`;
}

function fitLinkedAncestors(state: Readonly<DetailState>, width: number): string {
  const blocks = state.context.ancestors;
  if (blocks.length === 0 || width <= 0) return "";
  const titles = blocks.map((block) => sanitizeDynamicText(blockDisplayTitle(block)));
  let start = titles.length - 1;
  let suffix = titles[start]!;
  while (start > 0) {
    const candidate = `${titles[start - 1]} › ${suffix}`;
    if (visibleWidth(`… › ${candidate}`) > width) break;
    start -= 1;
    suffix = candidate;
  }
  const linked = blocks.slice(start).map((block, index) =>
    hyperlink(
      titles[start + index]!,
      outlinerLinkUri("block", block.id, { intent: "reveal" }),
    )
  ).join(" › ");
  return fitToWidth(`${start > 0 ? "… › " : ""}${linked}`, width);
}

function renderAncestors(
  state: Readonly<DetailState>,
  width: number,
  linksEnabled: boolean,
): string {
  if (width <= 0) return "";
  if (linksEnabled) return fitLinkedAncestors(state, width);
  const breadcrumb = state.context.ancestors
    .map((block) => blockDisplayTitle(block))
    .join(" › ");
  return fitBreadcrumb(breadcrumb, width);
}


function renderDetailMetadata(
  state: Readonly<DetailState>,
  width: number,
  options: DetailHeaderOptions,
): string {
  const keys = options.propertyKeys ?? DEFAULT_PROPERTY_SUMMARY_KEYS;
  const segments = propertySummarySegments(state.context.selected?.properties ?? [], keys);
  while (
    segments.length > 1 &&
    visibleWidth(segments.map((segment) => segment.plain).join(" · ")) > width
  ) {
    segments.pop();
  }
  let summary = segments
    .map((segment) => `\x1b[2m${segment.label}\x1b[0m \x1b[36m${segment.value}\x1b[0m`)
    .join(" \x1b[2m·\x1b[0m ");
  if (visibleWidth(summary) > width) summary = fitToWidth(summary, width);

  const separator = "  \x1b[2m·\x1b[0m  ";
  const ancestorWidth = width - visibleWidth(summary) -
    (summary ? visibleWidth(separator) : 0);
  const ancestors = ancestorWidth >= 8
    ? renderAncestors(state, ancestorWidth, options.linkBreadcrumbs === true)
    : "";
  const metadata = `${summary}${summary && ancestors ? separator : ""}${
    ancestors ? `\x1b[2m${ancestors}\x1b[0m` : ""
  }`;
  return fitToWidth(metadata, width);
}

export interface DetailHeaderOptions {
  linkBreadcrumbs?: boolean;
  surface?: string;
  focused?: boolean;
  propertyKeys?: readonly string[];
}

function renderHeaderControls(state: Readonly<DetailState>): string {
  const locked = state.connectionMode === "locked";
  const lock = outlinerActionLink(
    "detail.lock.toggle",
    `${locked ? "\x1b[33m🔒" : "\x1b[32m🔓"}\x1b[0m`,
  );
  const menu = outlinerActionLink("detail.menu.open", "\x1b[2;36m[⋯]\x1b[0m");
  return `${lock} ${menu}`;
}

function alignHeaderControls(left: string, controls: string, width: number): string {
  const controlsWidth = visibleWidth(controls);
  if (controlsWidth >= width) return fitToWidth(controls, width);
  const leftWidth = Math.max(1, width - controlsWidth - 1);
  const fittedLeft = fitToWidth(left, leftWidth);
  const padding = " ".repeat(Math.max(1, width - visibleWidth(fittedLeft) - controlsWidth));
  return `${fittedLeft}${padding}${controls}`;
}

export function renderDetailHeader(
  state: Readonly<DetailState>,
  width: number,
  options: DetailHeaderOptions = {},
): string[] {
  const title = renderDetailTitle(
    state,
    width,
    options.linkBreadcrumbs === true,
    options.focused,
  );
  const surface = options.surface?.trim();
  const surfaceStyle = options.focused === false ? "\x1b[2;36m" : "\x1b[36m";
  const left = surface
    ? `${surfaceStyle}${fitDynamicText(surface, width)}\x1b[0m \x1b[2m·\x1b[0m ${title}`
    : title;
  return [
    alignHeaderControls(left, renderHeaderControls(state), width),
    renderDetailMetadata(state, width, options),
    `\x1b[2m${"─".repeat(width)}\x1b[0m`,
  ];
}

export function renderDetailFooter(
  state: Readonly<DetailState>,
  width: number,
  mode: DetailState["mode"] = state.mode,
  helpText = detailHelpText(mode),
  chooserHelpText = openDestinationChooserHelp(),
): string[] {
  const destinationChooserOpen = state.destinationChooser.active;
  return [
    fitDynamicText(
      destinationChooserOpen ? state.destinationChooser.status : state.status,
      width,
    ),
    `\x1b[2m${
      fitToWidth(
        destinationChooserOpen ? chooserHelpText : helpText,
        width,
      )
    }\x1b[0m`,
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
  let annotation;
  try {
    annotation = parseAnnotationBlock(state.context.selected);
  } catch {
    annotation = null;
  }
  if (annotation?.target.kind === "block") {
    output.push(
      `\x1b[2m${fitDynamicText(
        `Source: block ${annotation.target.sourceBlockId} @${annotation.target.anchor.start}-${annotation.target.anchor.end} · ${annotation.anchorState}`,
        width,
      )}\x1b[0m`,
    );
    for (const line of annotation.target.anchor.excerpt.split(/\r?\n/)) {
      output.push(`│ ${fitDynamicText(line, Math.max(1, width - 2))}`);
    }
    output.push("─".repeat(width));
  }
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
  const comment = extractAnnotationBody(state.resolvedSelectedText);
  for (const line of (comment || "(No comment text)").split(/\r?\n/)) {
    output.push(renderMarkdownLine(fitDynamicText(line, width)));
  }
  return output;
}

export interface DetailRenderOptions {
  header?: DetailHeaderOptions;
  helpPrefix?: string;
  helpText?: string;
  chooserHelpText?: string;
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
  } else if (state.mode === "edit" || state.mode === "select" || state.mode === "comment") {
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
    if (state.annotationThreads.length > 0 && output.length < height - 2) {
      const threads = state.annotationThreads;
      output.push(`\x1b[1mComments · ${threads.length} ${threads.length === 1 ? "thread" : "threads"}\x1b[0m`);
      for (const [index, thread] of threads.entries()) {
        if (output.length >= height - 2) break;
        const range = thread.target.kind === "file"
          ? `${thread.target.filePath}:${thread.target.startLine}-${thread.target.endLine}`
          : `source ${thread.target.anchor.start}-${thread.target.anchor.end}`;
        output.push(
          fitDynamicText(
            `[${index + 1}] ${range} · ${thread.anchorState} · ${thread.lifecycle} — ${thread.body}`,
            width,
          ),
        );
      }
    }
  }

  while (output.length < height - 2) output.push("");
  const helpText = options.helpText ??
    (options.helpPrefix
      ? `${options.helpPrefix}  ${detailHelpText(state.mode)}`
      : detailHelpText(state.mode));
  output.push(...renderDetailFooter(
    state,
    width,
    state.mode,
    helpText,
    options.chooserHelpText,
  ));
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
  lines[0] = `${ESC}H${ESC}2J${lines[0] ?? ""}`;
  return lines.join("\n");
}
