import { truncateToWidth } from "@earendil-works/pi-tui";
import { outlinerActionLink } from "./outliner-actions";
import { annotationSourceHash, extractAnnotationBody } from "./annotations";
import type { DetailState } from "./detail-controller";
import type { PreviewRegion } from "./detail-preview-regions";
import { renderMarkdownLine, sanitizeDynamicText } from "./terminal";
import type { AnnotationRecord, AnnotationReferenceContext, AnnotationTarget, AnnotationThread } from "./types";

function fitDynamicText(value: string, width: number): string {
  return truncateToWidth(sanitizeDynamicText(value), Math.max(0, width), "…").replaceAll("\x1b[0m", "");
}

export function sourceLineStarts(text: string): number[] {
  const starts = [0];
  for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) {
    starts.push(index + 1);
  }
  return starts;
}

export function sourceLineAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle]! <= offset) low = middle;
    else high = middle;
  }
  return low;
}

export function displayedResourceText(
  state: Pick<DetailState, "document" | "resolvedSelectedText">,
): string | null {
  const description = state.document.kind === "ready" && state.document.document.kind === "resource"
    ? state.document.document.description : null;
  if (description?.presentation && description.presentation.selected?.representation !== "cached-markdown") return null;
  const text = description?.pdf?.markdown ??
    description?.web?.markdown ??
    description?.filesystem?.text ??
    null;
  // Resource documents render selected source bytes first, followed by optional
  // metadata. Availability alone does not establish this coordinate mapping.
  return text !== null && state.resolvedSelectedText.startsWith(text) ? text : null;
}

export interface DetailAnnotationGroup {
  regionId: string;
  placement: "inline" | "unpositioned";
  startLine: number;
  endLine: number;
  sourceLineCount: number;
  sourceSpan: PreviewRegion["sourceSpan"];
  threads: AnnotationThread[];
}

function displayedResourceRepresentationId(state: Readonly<DetailState>): string | null {
  const description = state.document.kind === "ready" && state.document.document.kind === "resource"
    ? state.document.document.description : null;
  if (!description || displayedResourceText(state) === null) return null;
  if (description.pdf) return description.pdf.representation.id;
  if (description.web) return description.web.representation.id;
  const filesystem = description.filesystem;
  if (!filesystem || filesystem.revision.revision.kind !== "filesystem") return null;
  const revision = filesystem.revision.revision;
  return `filesystem:${description.resource.id}:${revision.mtimeNs}:${revision.size}:${filesystem.contentHash}`;
}

function sameReferenceContext(left: AnnotationReferenceContext | undefined, right: AnnotationReferenceContext | undefined): boolean {
  return Boolean(left && right &&
    left.representation.subject.kind === "block" && right.representation.subject.kind === "block" &&
    left.representation.subject.blockId === right.representation.subject.blockId &&
    left.representation.contentHash === right.representation.contentHash &&
    left.anchor.start === right.anchor.start && left.anchor.end === right.anchor.end &&
    left.anchor.exact === right.anchor.exact);
}

export function annotationScopeLabel(thread: AnnotationThread, state: Readonly<DetailState>): string {
  const original = thread.originalTarget.referenceContext;
  if (!original) return thread.originalTarget.representation.subject.kind === "resource" ? "Resource-wide" : "Block comment";
  const context = thread.resolvedTarget?.referenceContext ?? original;
  const blockId = context.representation.subject.kind === "block" ? context.representation.subject.blockId : "unknown";
  const line = sourceLineAt(sourceLineStarts(context.sourceText), context.anchor.start ?? 0) + 1;
  const scope = state.target?.kind === "resource"
    ? sameReferenceContext(thread.resolvedTarget?.referenceContext, state.target.referenceContext) ? "This reference" : "Other reference"
    : "Reference occurrence";
  return `${scope} · ${blockId.slice(0, 8)}:L${line}${thread.resolvedTarget ? "" : " · original"}`;
}

export function detailAnnotationGroups(
  state: Readonly<DetailState>,
  renderedLineForAuthoredLine: (line: number) => number,
  renderedSourceLineCount: number,
  renderedAnchorText: string,
): DetailAnnotationGroup[] {
  if (state.annotationThreads.length === 0) return [];
  const selected = state.context.selected;
  const blockContentHash = selected ? annotationSourceHash(selected.text) : null;
  const displayedResourceTargetId = state.target?.kind === "resource"
    ? state.target.resourceId
    : null;
  const displayedResourceId = displayedResourceTargetId
    ? displayedResourceRepresentationId(state)
    : null;
  const renderedStarts = sourceLineStarts(renderedAnchorText);
  const groups = new Map<string, DetailAnnotationGroup>();
  const unpositioned: AnnotationThread[] = [];
  const displayedOffsets = new Map<string, number>();
  const compareThreads = (left: AnnotationThread, right: AnnotationThread): number =>
    (displayedOffsets.get(left.block.id) ?? Number.MAX_SAFE_INTEGER) -
      (displayedOffsets.get(right.block.id) ?? Number.MAX_SAFE_INTEGER) ||
    left.block.createdAt.localeCompare(right.block.createdAt) || left.block.id.localeCompare(right.block.id);
  for (const thread of state.annotationThreads) {
    let target = thread.resolvedTarget;
    const originalContext = thread.originalTarget.referenceContext;
    const currentContext = thread.resolvedTarget?.referenceContext;
    if (originalContext && (thread.currentResolution.status !== "resolved" || !currentContext)) {
      unpositioned.push(thread);
      continue;
    }
    if (displayedResourceTargetId && originalContext &&
      !sameReferenceContext(currentContext, state.target?.kind === "resource" ? state.target.referenceContext : undefined)) {
      unpositioned.push(thread);
      continue;
    }
    if (displayedResourceTargetId) {
      target = [...thread.resolutionHistory]
        .reverse()
        .map((event) => event.resolvedTarget)
        .find((candidate) =>
          candidate?.representation.id === displayedResourceId &&
          candidate.representation.subject.kind === "resource" &&
          candidate.representation.subject.resourceId === displayedResourceTargetId &&
          (!originalContext || sameReferenceContext(candidate.referenceContext, currentContext))
        ) ?? null;
    } else if (thread.currentResolution.status !== "resolved") {
      target = null;
    } else if (selected && currentContext) {
      target = { representation: currentContext.representation, anchor: currentContext.anchor };
    }
    if (
      !target ||
      (target.anchor.kind !== "text-quote" &&
        target.anchor.kind !== "pdf-page-region")
    ) {
      unpositioned.push(thread);
      continue;
    }
    const subject = target.representation.subject;
    const anchor = target.anchor;
    if (anchor.start === null || anchor.end === null || anchor.exact === null ||
      target.representation.sourceSnapshot.kind === "rendered") {
      // Pane captures include chrome, wrapping and history. Their offsets are
      // evidence in that capture, never coordinates in this Markdown document.
      unpositioned.push(thread);
      continue;
    }
    if (
      state.target?.kind === "resource" &&
      subject.kind === "resource" &&
      subject.resourceId === state.target.resourceId
    ) {
      const content = displayedResourceText(state);
      if (content === null || content.slice(anchor.start, anchor.end) !== anchor.exact) {
        unpositioned.push(thread);
        continue;
      }
      displayedOffsets.set(thread.block.id, anchor.start);
      const startLine = sourceLineAt(renderedStarts, anchor.start);
      const endLine = sourceLineAt(renderedStarts, Math.max(anchor.start, anchor.end - 1));
      const key = `resource:${startLine}`;
      const existing = groups.get(key);
      if (existing) {
        existing.endLine = Math.max(existing.endLine, endLine);
        existing.threads.push(thread);
      } else {
        groups.set(key, {
          regionId: `annotation:${subject.resourceId}:resource:${startLine}`,
          placement: "inline",
          startLine,
          endLine,
          sourceLineCount: renderedSourceLineCount,
          threads: [thread],
          sourceSpan: null,
        });
      }
      continue;
    }
    if (
      !selected ||
      subject.kind !== "block" ||
      subject.blockId !== selected.id
    ) { unpositioned.push(thread); continue; }
    const snapshot = target.representation.sourceSnapshot;
    if (snapshot.kind !== "block" || snapshot.blockId !== selected.id || snapshot.contentHash !== blockContentHash ||
      target.representation.contentHash !== blockContentHash ||
      selected.text.slice(anchor.start, anchor.end) !== anchor.exact) {
      unpositioned.push(thread);
      continue;
    }
    displayedOffsets.set(thread.block.id, anchor.start);
    const starts = sourceLineStarts(selected.text);
    let markerOffset = anchor.start;
    while (
      markerOffset < anchor.end &&
      /\s/.test(selected.text[markerOffset] ?? "")
    ) markerOffset += 1;
    const authoredStartLine = sourceLineAt(
      starts,
      markerOffset < anchor.end ? markerOffset : anchor.start,
    );
    const authoredEndLine = sourceLineAt(
      starts,
      Math.max(anchor.start, anchor.end - 1),
    );
    const startLine = renderedLineForAuthoredLine(authoredStartLine);
    const endLine = renderedLineForAuthoredLine(authoredEndLine);
    const key = `source:${startLine}`;
    const existing = groups.get(key);
    if (existing) {
      existing.endLine = Math.max(existing.endLine, endLine);
      existing.sourceSpan!.start = Math.min(existing.sourceSpan!.start, anchor.start);
      existing.sourceSpan!.end = Math.max(existing.sourceSpan!.end, anchor.end);
      existing.sourceSpan!.startLine = Math.min(
        existing.sourceSpan!.startLine,
        authoredStartLine,
      );
      existing.sourceSpan!.endLine = Math.max(
        existing.sourceSpan!.endLine,
        authoredEndLine,
      );
      existing.threads.push(thread);
      continue;
    }
    groups.set(key, {
      regionId: `annotation:${selected.id}:${authoredStartLine}`,
      placement: "inline",
      startLine,
      endLine,
      sourceLineCount: renderedSourceLineCount,
      sourceSpan: {
        start: anchor.start,
        end: anchor.end,
        startLine: authoredStartLine,
        endLine: authoredEndLine,
      },
      threads: [thread],
    });
  }
  const positioned = [...groups.values()].sort((left, right) => left.startLine - right.startLine);
  for (const group of positioned) group.threads.sort(compareThreads);
  return [
    ...positioned,
    ...(unpositioned.length === 0 ? [] : [{
      regionId: `annotation:${displayedResourceTargetId ?? selected?.id}:unpositioned`,
      placement: "unpositioned" as const,
      startLine: renderedSourceLineCount,
      endLine: renderedSourceLineCount,
      sourceLineCount: renderedSourceLineCount,
      sourceSpan: null,
      threads: unpositioned.sort(compareThreads),
    }]),
  ];
}

export function annotationTargetLabel(target: AnnotationTarget): string {
  const subject = target.representation.subject;
  const subjectLabel = subject.kind === "block"
    ? `block ${subject.blockId}`
    : subject.kind === "resource"
      ? `resource ${subject.resourceId}`
      : `legacy file ${subject.filePath}`;
  const anchor = target.anchor;
  if (anchor.kind === "text-quote") {
    const position = anchor.start !== null && anchor.end !== null
      ? ` @${anchor.start}-${anchor.end}`
      : " · unpositioned";
    return `${subjectLabel}${position}`;
  }
  return `${subjectLabel} · ${anchor.kind}`;
}

export function annotationTargetText(target: AnnotationTarget): string {
  const anchor = target.anchor;
  switch (anchor.kind) {
    case "text-quote":
    case "dom-range":
      return anchor.exact;
    case "pdf-page-region":
      return anchor.exact ?? `PDF page ${anchor.page}`;
    case "structured-entity-field":
      return `${anchor.entityType} ${anchor.entityId} · ${anchor.fieldPath.join(".")}`;
    case "provider-comment-id":
      return `${anchor.provider} comment ${anchor.commentId}`;
  }
}

function selectedAnnotationRecord(state: Readonly<DetailState>): AnnotationRecord | null {
  const selectedId = state.context.selected?.id;
  if (!selectedId) return null;
  for (const thread of state.annotationThreads) {
    if (thread.block.id === selectedId) return thread;
    const reply = thread.replies.find((candidate) => candidate.block.id === selectedId);
    if (reply) return reply;
  }
  return null;
}

export function buildDetailAnnotationView(
  state: Readonly<DetailState>,
  width: number,
): string[] {
  if (!state.context.selected) return [];
  const output: string[] = [];
  const annotation = selectedAnnotationRecord(state);
  const thread = selectedAnnotationThread(state);
  if (thread) {
    output.push(truncateToWidth([
      outlinerActionLink("detail.annotation.previous", "‹"),
      outlinerActionLink("detail.annotation.next", "›"),
      outlinerActionLink("detail.annotation.reply", "Reply"),
      outlinerActionLink("detail.annotation.lifecycle", thread.lifecycle === "open" ? "Resolve" : "Reopen"),
      `· ${thread.lifecycle}`,
    ].join(" "), width, "…"));
  }
  if (annotation) {
    output.push(`\x1b[2m${fitDynamicText(
      `Original target: ${annotationTargetLabel(annotation.originalTarget)}`,
      width,
    )}\x1b[0m`);
    for (const line of annotationTargetText(annotation.originalTarget).split(/\r?\n/)) {
      output.push(`│ ${fitDynamicText(line, Math.max(1, width - 2))}`);
    }
    const context = annotation.originalTarget.referenceContext;
    if (context) {
      const line = sourceLineAt(sourceLineStarts(context.sourceText), context.anchor.start ?? 0);
      output.push(fitDynamicText(`Original reference · ${context.representation.subject.kind === "block" ? context.representation.subject.blockId : "unknown"}:L${line + 1}`, width));
      output.push(`│ ${fitDynamicText(context.sourceText.split(/\r?\n/)[line] ?? context.anchor.exact, Math.max(1, width - 2))}`);
    }
    output.push(`\x1b[2m${fitDynamicText(
      `Stored resolution: ${annotation.currentResolution.status}${
        annotation.resolvedTarget ? ` · ${annotationTargetLabel(annotation.resolvedTarget)}` : ""
      }`,
      width,
    )}\x1b[0m`);
    if (annotation.resolvedTarget) {
      for (const line of annotationTargetText(annotation.resolvedTarget).split(/\r?\n/)) {
        output.push(`│ ${fitDynamicText(line, Math.max(1, width - 2))}`);
      }
    }
    output.push("\x1b[1mResolution history\x1b[0m");
    for (const event of annotation.resolutionHistory) {
      const method = event.method.kind === "codec"
        ? `${event.method.codecId}@${event.method.codecVersion}:${event.method.method}`
        : event.method.method;
      output.push(fitDynamicText(
        `#${event.sequence} ${event.status}${event.appliesCurrent ? " · current" : ""} · ${method} · ${event.reviewer.kind}:${event.reviewer.id}${
          event.confidence === null ? "" : ` · ${event.confidence}`
        }`,
        width,
      ));
      for (const [index, candidate] of event.candidates.entries()) {
        output.push(fitDynamicText(
          `  candidate ${index + 1} · ${candidate.confidence.toFixed(3)} · ${annotationTargetLabel(candidate.target)}`,
          width,
        ));
      }
      if (event.method.kind === "agent") {
        output.push(fitDynamicText(`  rationale · ${event.method.rationale}`, width));
        for (const evidence of event.method.evidence) {
          output.push(fitDynamicText(`  evidence · ${evidence}`, width));
        }
      } else if (event.method.kind === "human" && event.method.proposalEventId) {
        output.push(fitDynamicText(`  proposal · ${event.method.proposalEventId}`, width));
      }
    }
    output.push("─".repeat(width));
  }
  output.push("\x1b[1mComment\x1b[0m");
  const comment = extractAnnotationBody(state.resolvedSelectedText);
  for (const line of (comment || "(No comment text)").split(/\r?\n/)) {
    output.push(renderMarkdownLine(fitDynamicText(line, width)));
  }
  if (thread) {
    for (const reply of thread.replies) {
      if (reply.block.id === state.context.selected?.id) continue;
      output.push("", fitDynamicText(`${reply.source} reply:`, width));
      output.push(...reply.body.split(/\r?\n/).map(line => renderMarkdownLine(fitDynamicText(line, width))));
    }
  }
  return output;
}

export function selectedAnnotationThread(state: Readonly<DetailState>): AnnotationThread | null {
  return state.annotationThreads.find(thread => thread.block.id === state.selectedAnnotationId)
    ?? state.annotationThreads.find(thread => thread.block.id === state.context.selected?.id ||
      thread.replies.some(reply => reply.block.id === state.context.selected?.id)) ?? null;
}
