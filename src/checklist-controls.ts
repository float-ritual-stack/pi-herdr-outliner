import {CHECKLIST_MARKS, checklistItems} from "./checklist-items";
import {previewRegionActionUri, type PreviewRegion} from "./detail-preview-regions";
import type {Block, ChecklistItem} from "./types";

/** A rendered control retains its observed canonical item, not a painted row as an edit target. */
export interface ChecklistControl extends PreviewRegion {
  kind: "checklist";
  blockId: string;
  revision: number;
  item: ChecklistItem;
}

export function checklistControlId(blockId: string, item: ChecklistItem, revision: number): string {
  return `checklist:${blockId}:${item.identity === "unique" ? `^${item.itemId}` : `${revision}:${item.span.start}`}`;
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

export function findChecklistControl(regions: readonly PreviewRegion[], id: string): ChecklistControl | undefined {
  return regions.find((region): region is ChecklistControl => region.kind === "checklist" && region.id === id);
}

/** Decorate only mapped canonical item headers, after folding has placed its independent disclosure. */
export function renderChecklistControls(source: string, controls: readonly ChecklistControl[]): string {
  if (!controls.length) return source;
  const lines = source.split(/(?<=\n)/);
  for (const control of controls) {
    const line = control.sourceSpan!.startLine, text = lines[line];
    if (text === undefined) continue;
    // A note beginning with a list can acquire a presentation-only title prefix.
    const match = /^(?:#{1,6}[ \t]+)?(?:[ \t]*>[ \t]?)*[ \t]*(?:[-+*]|\d+[.)])[ \t]+(\[[ xX~!]\])(?=[ \t\r\n]|$)/.exec(text);
    if (!match || match[1]!.toLowerCase() !== CHECKLIST_MARKS[control.item.status]) continue;
    const start = match[0].length - 3;
    const label = CHECKLIST_MARKS[control.item.status].replaceAll("[", "\\[").replaceAll("]", "\\]");
    lines[line] = text.slice(0, start) + `[${label}](${previewRegionActionUri(control.activation!)})` + text.slice(start + 3);
  }
  return lines.join("");
}
