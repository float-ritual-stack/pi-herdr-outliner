import {atomicDocument, concatDocuments, generatedDocument, sliceDocument, type MappedDocument} from "./document-provenance";
import {listItemFoldId} from "./document-folds";
import {CHECKLIST_MARKS, checklistItems} from "./checklist-items";
import {previewRegionActionUri, type PreviewRegion, type PreviewRegionState} from "./detail-preview-regions";
import type {Block, ChecklistItem} from "./types";
import type {DetailEmbedRange} from "./detail-embeds";

/** A rendered control retains its observed canonical item, not a painted row as an edit target. */
export interface ChecklistControl extends PreviewRegion {
  kind: "checklist";
  blockId: string;
  revision: number;
  item: ChecklistItem;
  occurrenceId?: string;
  sourceBlock?: Block;
}

export function checklistControlId(blockId: string, item: ChecklistItem, revision: number, occurrenceId?: string): string {
  return `checklist:${blockId}:${item.identity === "unique" ? `^${item.itemId}` : `${revision}:${item.span.start}`}${occurrenceId ? `:${occurrenceId}` : ""}`;
}

/** Separate visible occurrences share canonical item evidence, but retain local focus. */
export function embeddedChecklistControls(ranges: readonly DetailEmbedRange[], lineForProjected: (line:number)=>number): ChecklistControl[] {
  return ranges.flatMap((range, index) => {
    return [...(range.source?[range.source]:[]),...(range.sources??[])].flatMap((source,sourceIndex)=>{
    const occurrenceId = `embed-${index}${range.sources?`-${sourceIndex}`:''}`;
    return checklistControls(source.block, line => lineForProjected(source.contentStartLine + line - source.startLine))
      .filter(control => control.item.span.startLine >= source.startLine && control.item.span.endLine <= source.endLine &&
        (!source.itemStarts||source.itemStarts.includes(control.item.span.start)))
      .map(control => {
        const id = checklistControlId(control.blockId, control.item, control.revision, occurrenceId);
        return {...control, id, occurrenceId, sourceBlock:source.block, activation:{type:"checklist.open" as const,regionId:id}};
      });
    });
  });
}

export function checklistControls(block: Pick<Block, "id" | "text" | "revision">,
  lineForSource: (line: number) => number = line => line): ChecklistControl[] {
  return checklistItems(block.text).map(item => {
    const id = checklistControlId(block.id, item, block.revision);
    return {id, kind: "checklist", blockId: block.id, revision: block.revision, item,
      sourceSpan: {...item.span, startLine: lineForSource(item.span.startLine), endLine: lineForSource(item.span.endLine)},
      parentId: null, childIds: [], focusable: true, disclosure: null,
      activation: {type: "checklist.open", regionId: id}};
  });
}

/** Projected Markdown hides anchors; retain unique item/occurrence identity for folding. */
export function checklistFoldIdentities(controls: readonly ChecklistControl[]): ReadonlyMap<number, string> {
  return new Map(controls.filter(control => control.item.identity === "unique")
    .map(control => [control.sourceSpan!.startLine, control.id]));
}

/** Capture only the admitted item's local disclosure, never infer an anonymous
 * identity across arbitrary edits. The successful receipt supplies the new ID. */
export function checklistFoldState(state: PreviewRegionState, control: ChecklistControl): boolean | undefined {
  if (control.item.identity !== "unassigned") return undefined;
  const fold = state.regions.find(region => region.kind === "document-fold" &&
    region.sourceSpan?.startLine === control.sourceSpan?.startLine && region.id.includes(":list-item:"));
  return fold ? state.disclosureOverrides.get(fold.id) ?? fold.disclosure?.expanded : undefined;
}

export function restoreChecklistFold(state: PreviewRegionState, controlId: string, expanded: boolean | undefined): void {
  if (expanded !== undefined) state.disclosureOverrides.set(listItemFoldId(controlId), expanded);
}

export function findChecklistControl(regions: readonly PreviewRegion[], id: string): ChecklistControl | undefined {
  return regions.find((region): region is ChecklistControl => region.kind === "checklist" && region.id === id);
}

/** Decorate only mapped canonical item headers, after folding has placed its independent disclosure. */
export function renderChecklistControls(source: MappedDocument, controls: readonly ChecklistControl[]): MappedDocument {
  if (!controls.length) return source;
  let offset = 0;
  const lines = source.text.split(/(?<=\n)/).map(text => {
    const line = sliceDocument(source, offset, offset + text.length); offset += text.length; return line;
  });
  for (const control of controls) {
    const line = control.sourceSpan!.startLine, mapped = lines[line];
    if (!mapped) continue;
    // A note beginning with a list can acquire a presentation-only title prefix.
    const match = /^(?:#{1,6}[ \t]+)?(?:[ \t]*>[ \t]?)*[ \t]*(?:[-+*]|\d+[.)])[ \t]+(\[[ xX~!]\])(?=[ \t\r\n]|$)/.exec(mapped.text);
    if (!match || match[1]!.toLowerCase() !== CHECKLIST_MARKS[control.item.status]) continue;
    const start = match[0].length - 3;
    let status = sliceDocument(mapped, start + 1, start + 2);
    if (status.text === "X") status = concatDocuments(status.runs.map(run => atomicDocument("x", run.origin)));
    const generated = (text: string) => generatedDocument(text, "checklist control syntax");
    lines[line] = concatDocuments([sliceDocument(mapped, 0, start), generated("[\\"),
      sliceDocument(mapped, start, start + 1), status, generated("\\"), sliceDocument(mapped, start + 2, start + 3),
      generated(`](${previewRegionActionUri(control.activation!)})`), sliceDocument(mapped, start + 3)]);
  }
  return concatDocuments(lines);
}

/** Quote the focused step's authored header, excluding its mark and hidden address. */
export function checklistCommentRange(control: ChecklistControl): {start: number; end: number} {
  const item = control.item;
  const header = item.text.split(/\r?\n/, 1)[0]!;
  const markEnd = item.markerStart - item.span.start + 3;
  let end = header.trimEnd().length;
  if (item.itemId && header.slice(0, end).endsWith(`^${item.itemId}`)) end -= item.itemId.length + 1;
  const body = header.slice(markEnd, end).trim();
  if (!body) return {start: item.markerStart, end: item.markerStart + 3};
  const start = header.indexOf(body, markEnd);
  return {start: item.span.start + start, end: item.span.start + start + body.length};
}
