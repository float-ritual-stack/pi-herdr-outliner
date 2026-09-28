import { checklistItems } from "./checklist-items";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { outlinerActionLink } from "./outliner-actions";
import { annotationSourceHash, annotationReferenceContextsEqual, extractAnnotationBody } from "./annotations";
import type { DetailState } from "./detail-controller";
import { renderMarkdownLine, sanitizeDynamicText } from "./terminal";
import type { Block, AnnotationRecord, AnnotationTarget, AnnotationThread } from "./types";

/** The displayed evidence needed by both Detail and local Preview comment readers. */
export interface AnnotationReaderState extends Pick<DetailState,
  "target" | "resolvedSelectedText" | "annotationThreads" | "selectedAnnotationId" | "previewRegions" | "annotationReferences"> {
  /** Work IDs in comment text link with the same prefix as the note they discuss. */
  workIdPrefix?: string | null;
  context: {selected: Pick<Block, "id" | "text"> | null};
  historical?:boolean;
  document: {kind: "empty" | "loading" | "failed"} | {
    kind: "ready";
    document: {kind: "block"} | {kind: "resource"; description: import("./resources").ResourceDescription};
  };
}

/**
 * Resolve block-reference titles in comment and reply text, keyed by the stored
 * text. Only text that can contain `((…))` is resolved; failures keep the
 * stored text, which still links pages, Work IDs and block IDs.
 */
export function annotationReferenceTexts(threads: readonly AnnotationThread[]): Set<string> {
  return new Set(threads.flatMap(thread => [thread.body, ...thread.replies.map(reply => reply.body)])
    .filter(body => body.includes("((")));
}

export async function resolveAnnotationReferences(
  threads: readonly AnnotationThread[],
  resolve: (text: string) => Promise<{ text: string }>,
): Promise<Map<string, string>> {
  const bodies = annotationReferenceTexts(threads);
  const resolved = new Map<string, string>();
  await Promise.all([...bodies].map(async body => {
    try {
      const result = await resolve(body);
      if (result.text !== body) resolved.set(body, result.text);
    } catch { /* The stored text remains readable and linkable. */ }
  }));
  return resolved;
}

export function sameAnnotationReferences(
  left: ReadonlyMap<string, string> | undefined,
  right: ReadonlyMap<string, string> | undefined,
): boolean {
  if ((left?.size ?? 0) !== (right?.size ?? 0)) return false;
  for (const [body, text] of left ?? []) if (right?.get(body) !== text) return false;
  return true;
}

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
  state: Pick<AnnotationReaderState, "document" | "resolvedSelectedText">,
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
  placement: "inline" | "general" | "unpositioned";
  threads: AnnotationThread[];
  /** Legacy exact evidence; newer captures carry their fragments on the thread. */
  target?: AnnotationTarget;
}

function displayedResourceRepresentationId(state: Readonly<AnnotationReaderState>): string | null {
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

export function annotationScopeLabel(thread: AnnotationThread, state: Pick<AnnotationReaderState, "target" | "historical">): string {
  if (thread.originalTarget.passage) {
    const positions = thread.currentResolution.passageResolution?.fragments.flatMap(fragment => [
      ...fragment.sources, ...(fragment.occurrence ? [fragment.occurrence.host, ...fragment.occurrence.path] : []),
    ]) ?? [];
    const missing = positions.filter(position => position.status !== "resolved").length;
    const attached = positions.some(position => position.resolvedTarget?.anchor.kind === "list-item");
    return `Rendered passage${state.historical ? " · saved version; current resolution recorded separately" : `${missing ? " · partly unresolved" : ""}${attached ? " · task attachment; quoted words changed" : ""}`}`;
  }
  if (thread.originalTarget.listItemId) {
    if (thread.resolvedTarget?.anchor.kind === "list-item") return "Item attachment · original passage changed";
    return thread.resolvedTarget ? "Checklist passage" : "Checklist item · unresolved";
  }
  const original = thread.originalTarget.referenceContext;
  if (!original) return thread.originalTarget.representation.subject.kind === "resource" ? "Resource-wide" : "Block comment";
  const context = thread.resolvedTarget?.referenceContext ?? original;
  const blockId = context.representation.subject.kind === "block" ? context.representation.subject.blockId : "unknown";
  const line = sourceLineAt(sourceLineStarts(context.sourceText), context.anchor.start ?? 0) + 1;
  const scope = state.target?.kind === "resource"
    ? thread.resolvedTarget?.referenceContext && annotationReferenceContextsEqual(thread.resolvedTarget.referenceContext, state.target.referenceContext) ? "This reference" : "Other reference"
    : "Reference occurrence";
  return `${scope} · ${blockId.slice(0, 8)}:L${line}${thread.resolvedTarget ? "" : " · original"}`;
}

export function detailAnnotationGroups(state:Readonly<AnnotationReaderState>):DetailAnnotationGroup[] {
  const selected=state.context.selected;
  const displayedBlockId=state.target?.kind==='block'?state.target.blockId:selected?.id;
  const hash=selected?annotationSourceHash(selected.text):null;
  const resourceId=state.target?.kind==='resource'?state.target.resourceId:null;
  const representationId=resourceId?displayedResourceRepresentationId(state):null;
  const groups:DetailAnnotationGroup[]=[];
  const unpositioned:AnnotationThread[]=[],general:AnnotationThread[]=[];
  const offsets=new Map<string,number>();
  const compare=(a:AnnotationThread,b:AnnotationThread)=>(offsets.get(a.block.id)??Infinity)-(offsets.get(b.block.id)??Infinity)
    ||a.block.createdAt.localeCompare(b.block.createdAt)||a.block.id.localeCompare(b.block.id);
  for(const thread of state.annotationThreads){
    const originalContext=thread.originalTarget.referenceContext,currentContext=thread.resolvedTarget?.referenceContext;
    if(originalContext&&(thread.currentResolution.status!=='resolved'||!currentContext)||
      resourceId&&originalContext&&!annotationReferenceContextsEqual(currentContext,state.target?.kind==='resource'?state.target.referenceContext:undefined)){
      unpositioned.push(thread);continue;
    }
    if(thread.originalTarget.passage){
      groups.push({regionId:`annotation:passage:${thread.block.id}`,placement:'inline',threads:[thread]});continue;
    }
    const subject=thread.originalTarget.representation.subject;
    if(thread.originalTarget.anchor.kind==='whole-subject'&&
      (resourceId?subject.kind==='resource'&&subject.resourceId===resourceId:subject.kind==='block'&&subject.blockId===displayedBlockId)){
      general.push(thread);continue;
    }
    let target=thread.resolvedTarget;
    if(resourceId){
      target=[...thread.resolutionHistory].reverse().map(event=>event.resolvedTarget).find(candidate=>
        candidate?.representation.id===representationId&&candidate.representation.subject.kind==='resource'&&
        candidate.representation.subject.resourceId===resourceId&&
        (!originalContext||annotationReferenceContextsEqual(candidate.referenceContext,currentContext)))??null;
    }else if(state.historical&&selected&&!originalContext){
      target=[...thread.resolutionHistory].reverse().map(event=>event.resolvedTarget).concat(thread.originalTarget).find(candidate=>{
        const snapshot=candidate?.representation.sourceSnapshot;
        return snapshot?.kind==='block'&&snapshot.blockId===selected.id&&snapshot.contentHash===hash&&candidate?.representation.contentHash===hash;
      })??null;
    }else if(thread.currentResolution.status!=='resolved')target=null;
    else if(selected&&currentContext)target={representation:currentContext.representation,anchor:currentContext.anchor};
    if(!target||target.representation.sourceSnapshot.kind==='rendered') {unpositioned.push(thread);continue;}
    const anchor=target.anchor,targetSubject=target.representation.subject;
    if(anchor.kind==='list-item'&&selected&&!resourceId){
      const snapshot=target.representation.sourceSnapshot;
      const items=checklistItems(selected.text).filter(item=>item.itemId===anchor.itemId);
      if(snapshot.kind!=='block'||snapshot.blockId!==selected.id||snapshot.contentHash!==hash||target.representation.contentHash!==hash||items.length!==1||items[0]!.identity!=='unique'){
        unpositioned.push(thread);continue;
      }
      offsets.set(thread.block.id,items[0]!.markerStart);
    }else if((anchor.kind==='text-quote'||anchor.kind==='pdf-page-region')&&anchor.start!==null&&anchor.end!==null&&anchor.exact!==null){
      const content=resourceId?displayedResourceText(state):selected?.text;
      const snapshot=target.representation.sourceSnapshot;
      const sameSubject=resourceId?targetSubject.kind==='resource'&&targetSubject.resourceId===resourceId
        :targetSubject.kind==='block'&&targetSubject.blockId===selected?.id&&snapshot.kind==='block'&&snapshot.contentHash===hash&&target.representation.contentHash===hash;
      if(!sameSubject||content==null||content.slice(anchor.start,anchor.end)!==anchor.exact){unpositioned.push(thread);continue;}
      offsets.set(thread.block.id,anchor.start);
    }else{unpositioned.push(thread);continue;}
    groups.push({regionId:`annotation:exact:${thread.block.id}`,placement:'inline',target,threads:[thread]});
  }
  groups.sort((a,b)=>compare(a.threads[0]!,b.threads[0]!));
  return [...groups,...(general.length?[{regionId:`annotation:${resourceId??displayedBlockId}:general`,placement:'general' as const,threads:general.sort(compare)}]:[]),
    ...(unpositioned.length?[{regionId:`annotation:${resourceId??displayedBlockId}:unpositioned`,placement:'unpositioned' as const,threads:unpositioned.sort(compare)}]:[])];
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
    case "whole-subject":
      return "Whole note";
    case "list-item":
      return `Checklist item ^${anchor.itemId}`;
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

export function selectedAnnotationThread(state: Pick<AnnotationReaderState, "annotationThreads" | "selectedAnnotationId" | "context">): AnnotationThread | null {
  return state.annotationThreads.find(thread => thread.block.id === state.selectedAnnotationId)
    ?? state.annotationThreads.find(thread => thread.block.id === state.context.selected?.id ||
      thread.replies.some(reply => reply.block.id === state.context.selected?.id)) ?? null;
}
