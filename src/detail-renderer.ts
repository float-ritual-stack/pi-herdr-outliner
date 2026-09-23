import {
  hyperlink,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  attentionBanner,
  attentionReturnSummary,
  decorateAttentionBlockLine,
  decorateAttentionLines,
} from "./attention-render";
import { currentAttentionMark } from "./attention";
import { annotationScopeLabel, annotationTargetText, buildDetailAnnotationView, detailAnnotationGroups } from "./detail-annotations";
import { completionWindow } from "./completion";
import { outlinerLinkUri } from "./outliner-links";
import { filterPropertyInspectorEntries } from "./property-inspector";
import { blockDisplayTitle } from "./references";
import { resourceAddressLabel } from "./resources";
import { outlinerActionLink } from "./outliner-actions";
import {
  detailBlockTarget,
  detailResourceDescription,
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
    : (state.resource ? resourceAddressLabel(state.resource.address) : state.resolvedBreadcrumb) ||
      "No block selected";
  const fragmentId = detailBlockTarget(state)?.fragmentId;
  return fragmentId ? `${title} · ^${fragmentId}` : title;
}

function renderDetailTitle(
  state: Readonly<DetailState>,
  width: number,
  linksEnabled: boolean,
  focused: boolean | undefined,
): string {
  const safe = sanitizeDynamicText(detailTitle(state));
  const fitted = fitToWidth(safe, width);
  const blockTarget = detailBlockTarget(state);
  const resource = state.resource;
  const linked = linksEnabled && state.context.selected && blockTarget
    ? hyperlink(
      fitted,
      outlinerLinkUri("block", state.context.selected.id, {
        intent: "reveal",
        ...(blockTarget.fragmentId ? { fragmentId: blockTarget.fragmentId } : {}),
      }),
    )
    : linksEnabled && resource
      ? hyperlink(fitted, outlinerLinkUri("resource", resource.id))
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
  const resource = detailResourceDescription(state);
  if (resource) {
    const context = state.target?.kind === "resource" ? state.target.referenceContext : undefined;
    return fitDynamicText(
      context
        ? `reference · ${context.sourceText.split(/\r?\n/)[0]} · line ${context.sourceText.slice(0, context.anchor.start!).split("\n").length}`
        : `resource · ${resource.source.name} · ${resource.resource.provider}`,
      width,
    );
  }
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
  destinationLabel?: string;
}

function renderHeaderControls(): string {
  return outlinerActionLink("detail.menu.open", "\x1b[2;36m[⋯]\x1b[0m");
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
  const attention = attentionBanner(state.attention, detailBlockTarget(state)?.blockId ?? null, width);
  return [
    alignHeaderControls(left, renderHeaderControls(), width),
    (state.recoveryCount ?? 0) > 0 ? outlinerActionLink("detail.edit.recover",`Recover writing · ${state.recoveryCount} retained draft${state.recoveryCount===1?"":"s"} · Alt+R`) : attention ?? renderDetailMetadata(state, width, options),
    options.destinationLabel === undefined ? `\x1b[2m${"─".repeat(width)}\x1b[0m`
      : outlinerActionLink("detail.navigation.link", alignHeaderControls(`Opens in: ${fitDynamicText(options.destinationLabel, width)}`, "/ Change", width)),
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
  const returnSummary = attentionReturnSummary(state.attention, width);
  return [
    returnSummary ?? fitDynamicText(
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

export interface DetailRenderOptions {
  header?: DetailHeaderOptions;
  helpPrefix?: string;
  helpText?: string;
  chooserHelpText?: string;
}

/** Ordinary ANSI reader rows. Appended comment evidence has no source position. */
export function buildDetailAnsiPreview(
  state: Readonly<DetailState>,
  width: number,
): NonNullable<DetailViewport["preview"]> {
  const sourceLines = state.resolvedSelectedText.split(/\r?\n/);
  const annotationLines: string[] = [];
  const threadRows = new Map<string, number>();
  const groups = detailAnnotationGroups(state, line => line, sourceLines.length, state.resolvedSelectedText);
  const append = (text: string, prefix = "") => {
    for (const line of wrapTextWithAnsi(sanitizeDynamicText(text, true), Math.max(1, width - visibleWidth(prefix)))) {
      annotationLines.push(`${prefix}${line}`);
    }
  };
  if (groups.length > 0) {
    annotationLines.push("", fitDynamicText(`Comments · ${state.annotationThreads.length} threads · [ previous · ] next`, width));
    let index = 0;
    for (const group of groups) {
      for (const thread of group.threads) {
        index += 1;
        threadRows.set(thread.block.id, sourceLines.length + annotationLines.length);
        append(`${thread.block.id === state.selectedAnnotationId ? "▶" : " "} Comment ${index} · ${thread.lifecycle}`);
        append(`C reply · D ${thread.lifecycle === "open" ? "resolve" : "reopen"}`);
        append(annotationScopeLabel(thread, state));
        append(`${group.placement} · ${thread.currentResolution.status}`);
        if (group.placement === "unpositioned") {
          append("Original quote:");
          append(annotationTargetText(thread.originalTarget), "│ ");
        }
        append(thread.body || "(No comment text)");
        for (const reply of thread.replies) {
          append(`${reply.source} reply:`);
          append(reply.body);
        }
        annotationLines.push("");
      }
    }
  }
  return { sourceLines, annotationLines, threadRows };
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
  const bodyStart = output.length;
  let sourceRowsInViewport: number | undefined;

  if (state.document.kind === "loading") {
    output.push(
      state.document.target.kind === "resource"
        ? "Loading resource metadata…"
        : "Loading block…",
    );
  } else if (state.document.kind === "failed") {
    output.push(fitDynamicText(state.document.message, width));
  } else if (state.document.kind === "empty") {
    output.push("Select a block or resource in the outliner pane.");
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
  } else if (state.propertyInspector.model &&
      (state.propertyInspector.expanded || state.propertyInspector.presentation === "dedicated")) {
    const inspector = state.propertyInspector;
    const entries = filterPropertyInspectorEntries(inspector.model?.entries ?? [], {
      query: inspector.filterDraft ?? inspector.filter,
    });
    const focused = entries.findIndex(entry => entry.occurrenceId === state.previewRegions.focusedRegionId);
    const available = Math.max(1, bodyHeight - 2);
    const start = Math.max(0, Math.min(
      focused >= 0 ? focused - Math.floor(available / 2) : inspector.viewportOffset,
      entries.length - available,
    ));
    output.push(`Properties · ${entries.length} records`);
    for (const entry of entries.slice(start, start + available)) {
      const edit = inspector.edit?.occurrenceId === entry.occurrenceId ? inspector.edit.buffer : null;
      const value = edit ? `${edit.text.slice(0, edit.column)}▏${edit.text.slice(edit.column)}` : entry.value;
      output.push(fitDynamicText(`${state.previewRegions.focusedRegionId === entry.occurrenceId ? "▶" : " "} ${entry.key}::${value} · ${entry.scope} · L${entry.line + 1}:C${entry.column + 1}`, width));
    }
    output.push(fitDynamicText(inspector.filterDraft !== null
      ? `Filter: ${inspector.filterDraft}▏ · Enter applies · Esc cancels`
      : "Tab selects · o opens · Enter edits · / filters · p closes", width));
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
    const attention = currentAttentionMark(state.attention, detailBlockTarget(state)?.blockId ?? null);
    const lineNumberWidth = String(file.firstLine + file.lines.length).length;
    const visibleLines = file.lines.slice(state.fileOffset, state.fileOffset + bodyHeight);
    const rows = visibleLines.map((line, index) => {
      const localIndex = state.fileOffset + index;
      const lineNumber = file.firstLine + localIndex;
      const inRange = range !== null && lineNumber >= range.startLine && lineNumber <= range.endLine;
      const current = localIndex === state.fileCursor;
      const prefix = `${current ? ">" : " "}${String(lineNumber).padStart(lineNumberWidth)} ${inRange ? "│" : " "} `;
      const rendered = renderMarkdownLine(
        fitDynamicText(line, Math.max(1, width - prefix.length)),
      );
      return current ? `\x1b[48;5;238m${prefix}${rendered}\x1b[0m` : `${prefix}${rendered}`;
    });
    const sourcePrefix = file.sourceText
      ?.split(/\r?\n/)
      .slice(0, file.firstLine - 1 + state.fileOffset)
      .join("\n") ?? "";
    const decorated = decorateAttentionLines(
      rows,
      attention?.target.kind === "file" ? attention : null,
      width,
      file.sourceText,
      sourcePrefix,
    );
    decorated.forEach((row, index) => {
      const lineNumber = file.firstLine + state.fileOffset + index;
      output.push(
        row === rows[index] &&
          attention?.target.kind === "file" &&
          lineNumber >= attention.target.startLine &&
          lineNumber <= attention.target.endLine
          ? decorateAttentionBlockLine(row, attention, width)
          : row,
      );
    });
  } else {
    const preview = viewport.preview ?? buildDetailAnsiPreview(state, width);
    const lineCount = preview.sourceLines.length + preview.annotationLines.length;
    for (let row = state.previewOffset; row < Math.min(lineCount, state.previewOffset + bodyHeight); row += 1) {
      if (row < preview.sourceLines.length) {
        const rendered = renderMarkdownLine(fitDynamicText(preview.sourceLines[row]!, width));
        output.push(isEmbeddedLine(state, row) ? renderEmbedBackground(rendered, width) : rendered);
      } else {
        output.push(preview.annotationLines[row - preview.sourceLines.length]!);
      }
    }
    sourceRowsInViewport = Math.max(0, Math.min(bodyHeight, preview.sourceLines.length - state.previewOffset));
  }

  while (output.length < height - 2) output.push("");
  const helpText = options.helpText ??
    (options.helpPrefix
      ? `${options.helpPrefix}  ${detailHelpText(state.mode)}`
      : detailHelpText(state.mode));
  if (state.mode === "preview") {
    const mark = currentAttentionMark(state.attention, detailBlockTarget(state)?.blockId ?? null);
    const count = sourceRowsInViewport ?? output.length - bodyStart;
    const decorated = decorateAttentionLines(
      output.slice(bodyStart, bodyStart + count),
      mark,
      width,
      state.context.selected?.text,
    );
    output.splice(bodyStart, count, ...decorated);
  }
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
