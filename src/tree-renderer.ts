import type {DocumentPreviewFrame} from "./document-preview-renderer";
import {renderNavigationDestinationPreview} from './navigation-destination-menu';
import {treePreviewFrame} from './tree-preview';
import { renderGotoFrame } from "./goto-renderer";
import { renderInboxFrame } from "./inbox-renderer";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { currentAttentionMark } from "./attention";
import {
  attentionReturnSummary,
  decorateAttentionBlockLine,
} from "./attention-render";
import {
  actionMenuItemText,
  DEFAULT_OUTLINER_ACTION_KEYMAP,
  outlinerActionLink,
} from "./outliner-actions";
import { completionWindow } from "./completion";
import { createOutlinerTextLinker } from "./outliner-links";
import { quickInsertionPoint } from "./quick-edit";
import {
  DEFAULT_PROPERTY_SUMMARY_KEYS,
  propertySummarySegments,
} from "./property-summary";
import { layoutExpandedBlock } from "./tree-layout";
import { renderMarkdownLine, sanitizeDynamicText, truncate } from "./terminal";
import type { Block, TreeIndexBlock } from "./types";
import type { TreeQuickCompletion, TreeView } from "./tree-controller";
import {
  isBlockTreeRow,
  type AuthoredLinkHeaderRow,
  type AuthoredLinkRow,
  type TreeDisplayRow as ProjectedDisplayRow,
} from "./tree-rows";
import type { TreeMouseTarget } from "./tree-mouse";
import {
  decorateVirtualBranchDefinitionText,
  virtualBranchStateLabel,
  type TreeRow as ProjectedTreeRow,
  type VirtualBranchState,
} from "./virtual-branches";

type TreeRow = ProjectedTreeRow<TreeIndexBlock>;
type TreeDisplayRow = ProjectedDisplayRow<TreeIndexBlock>;

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function branchStatusText(state: VirtualBranchState): string {
  const details = [
    countLabel(state.count, "matched root"),
    countLabel(state.descendantCount, "contextual descendant"),
  ];
  if (state.truncation.rootQuery) {
    details.push(`ROOT QUERY TRUNCATED at ${state.completeness?.kind === "truncated" ? state.completeness.limit : state.count}`);
  }
  if (state.truncation.depth) details.push("DESCENDANTS TRUNCATED at relative depth 2");
  if (state.truncation.budget) details.push("PROJECTION TRUNCATED at 1000 rows");
  if (state.configurationErrors.length > 0) {
    details.push(`CONFIG ERROR: ${state.configurationErrors.join("; ")}`);
  }
  if (state.queryError) details.push(`QUERY ERROR: ${state.queryError}`);
  if (state.creationErrors.length > 0) {
    details.push(`READ-ONLY: ${state.creationErrors.join("; ")}`);
  } else if (state.config?.readOnly) {
    details.push("READ-ONLY: configure create and create-parent");
  }
  return `Virtual branch · ${details.join(" · ")}`;
}

function virtualBranchCreationHelp(
  state: VirtualBranchState | undefined,
  physicalBlocksById: ReadonlyMap<string, TreeIndexBlock>,
): string | null {
  const config = state?.config;
  if (!config || config.readOnly || !config.create || !config.createParentId) return null;
  const parent = physicalBlocksById.get(config.createParentId);
  const parentTitle = parent?.preview ?? config.createParentId;
  return `Create canonical under ${parentTitle} · sets [${config.create.key}::${config.create.value}] · ↵ save · ⎋ cancel`;
}

function isCanonicalDescendant(
  candidateId: string,
  ancestorId: string,
  physicalBlocksById: ReadonlyMap<string, TreeIndexBlock>,
): boolean {
  let candidate = physicalBlocksById.get(candidateId);
  while (candidate?.parentId) {
    if (candidate.parentId === ancestorId) return true;
    candidate = physicalBlocksById.get(candidate.parentId);
  }
  return false;
}

function isVisualDescendant(
  candidate: TreeRow,
  ancestor: TreeRow,
  physicalBlocksById: ReadonlyMap<string, TreeIndexBlock>,
): boolean {
  if (ancestor.kind === "occurrence") return false;
  if (candidate.kind === "occurrence") {
    return (
      candidate.viewId === ancestor.canonicalId ||
      isCanonicalDescendant(candidate.viewId, ancestor.canonicalId, physicalBlocksById)
    );
  }
  return isCanonicalDescendant(candidate.canonicalId, ancestor.canonicalId, physicalBlocksById);
}

const ESC = "\x1b[";
const AUTHOR_MARKERS: Record<Block["author"], string> = {
  agent: "A",
  system: "S",
  user: " ",
};
export type TreeSemanticState = "blocked" | "doing" | "review" | "done" | "unprioritized";

interface TreeSemanticTreatment {
  readonly glyph: string;
  readonly sgr: string;
}

const TREE_SEMANTIC_TREATMENTS: Record<TreeSemanticState, TreeSemanticTreatment> = {
  blocked: { glyph: "!", sgr: `${ESC}1;31m` },
  doing: { glyph: "●", sgr: `${ESC}1;36m` },
  review: { glyph: "◆", sgr: `${ESC}35m` },
  done: { glyph: "✓", sgr: `${ESC}2;32m` },
  unprioritized: { glyph: "·", sgr: `${ESC}2m` },
};

export function treeSemanticState(block: Pick<Block, "properties">): TreeSemanticState | null {
  const values = (key: string) =>
    block.properties
      .filter((property) => property.key.toLowerCase() === key)
      .map((property) => property.value.toLowerCase());
  const status = values("type").includes("roadmap-item") ? [] : values("status");
  const stage = values("work-stage");
  if (status.includes("blocked") || stage.includes("blocked")) return "blocked";
  if (
    status.some((value) => value === "active" || value === "doing" || value === "in-progress") ||
    stage.includes("doing")
  ) return "doing";
  if (status.includes("review") || stage.some((value) => value === "review" || value === "validate")) {
    return "review";
  }
  if (
    status.some((value) => value === "done" || value === "complete") ||
    stage.some((value) => value === "done" || value === "complete")
  ) return "done";
  if (status.includes("unprioritized") || stage.includes("unprioritized")) return "unprioritized";
  return null;
}

function semanticText(text: string, treatment: TreeSemanticTreatment | null): string {
  if (!treatment) return text;
  const newline = text.search(/\r?\n/);
  const firstLine = newline < 0 ? text : text.slice(0, newline);
  const remainder = newline < 0 ? "" : text.slice(newline);
  return `${treatment.sgr}${treatment.glyph} ${firstLine}${ESC}0m${remainder}`;
}

const SELECTED_ROW_STYLE = `${ESC}48;5;238m${ESC}1m`;

function applySelectedRow(line: string): string {
  return `${SELECTED_ROW_STYLE}${
    line.replaceAll(`${ESC}0m`, `${ESC}0m${SELECTED_ROW_STYLE}`)
  }${ESC}0m`;
}

type TreeRenderEntry =
  | { kind: "block"; blockIndex: number }
  | { kind: "quick"; depth: number };

export interface TreeRenderResult {
  readonly preview?: DocumentPreviewFrame;
  readonly frame: string;
  readonly scrollStartEntryIndex: number;
  readonly breadcrumbStart?: number;
  readonly expandedPage?: import("./tree-controller").TreeExpandedPage | null;
  readonly mouseTargets: readonly (TreeMouseTarget | null | undefined)[];
}

export interface TreeRenderOptions {
  readonly propertyKeys?: readonly string[];
  readonly clearScreen?: boolean;
  readonly focused?: boolean;
}

function propertyKeysForRow(
  view: TreeView,
  row: TreeRow,
  options: TreeRenderOptions,
): readonly string[] {
  if (row.kind === "occurrence") {
    const configured = view.branchStates.get(row.viewId)?.config?.summaryPropertyKeys;
    if (configured !== undefined) return configured;
  }
  return options.propertyKeys ?? DEFAULT_PROPERTY_SUMMARY_KEYS;
}

function renderSummarySegment(label: string, value: string): string {
  const renderedLabel = label ? `\x1b[2m${label}\x1b[0m ` : "";
  return `${renderedLabel}\x1b[36m${value}\x1b[0m`;
}

function renderCollapsedRow(
  prefix: string,
  title: string,
  summary: readonly { label: string; value: string; plain: string }[],
  fixedSuffix: string,
  optionalSuffix: string,
  width: number,
): string {
  let suffix = `${fixedSuffix}${optionalSuffix}`;
  let available = Math.max(1, width - visibleWidth(prefix) - visibleWidth(suffix));
  const segments = [...summary];
  const separator = "  ";
  const plainSummary = () => segments.length === 1
    ? segments[0]!.value
    : segments.map((segment) => segment.plain).join(" · ");
  if (
    segments.length > 0 &&
    optionalSuffix &&
    visibleWidth(title) + visibleWidth(separator) + visibleWidth(plainSummary()) > available
  ) {
    suffix = fixedSuffix;
    available = Math.max(1, width - visibleWidth(prefix) - visibleWidth(suffix));
  }

  while (
    segments.length > 1 &&
    visibleWidth(title) + visibleWidth(separator) + visibleWidth(plainSummary()) > available
  ) {
    segments.pop();
  }

  if (segments.length === 0) {
    if (!fixedSuffix) return truncate(`${prefix}${title}${suffix}`, width);
    return truncateToWidth(`${prefix}${truncateToWidth(title, available)}${suffix}`, width);
  }

  const renderedSummary = () =>
    segments.length === 1
      ? renderSummarySegment("", segments[0]!.value)
      : segments
        .map((segment) => renderSummarySegment(segment.label, segment.value))
        .join(" \x1b[2m·\x1b[0m ");
  if (
    visibleWidth(title) + visibleWidth(separator) + visibleWidth(plainSummary()) <= available
  ) {
    const gap = " ".repeat(
      available - visibleWidth(title) - visibleWidth(plainSummary()),
    );
    return truncateToWidth(`${prefix}${title}${gap}${renderedSummary()}${suffix}`, width);
  }

  const contentWidth = Math.max(1, available - visibleWidth(separator));
  const titleFloor = Math.min(
    visibleWidth(title),
    4,
    Math.max(1, contentWidth - 1),
  );
  const summaryWidth = Math.min(
    visibleWidth(plainSummary()),
    Math.max(1, contentWidth - titleFloor),
  );
  const titleWidth = Math.max(1, contentWidth - summaryWidth);
  return truncateToWidth(
    `${prefix}${truncateToWidth(title, titleWidth)}${separator}${
      truncateToWidth(renderedSummary(), summaryWidth)
    }${suffix}`,
    width,
  );
}

function renderQuickInputRow(
  quickInput: string,
  quickColumn: number,
  depth: number,
  marker: string,
  author: string,
  width: number,
): string {
  const prefix = `${"  ".repeat(depth)}${marker} `;
  const suffix = `  ${author}`;
  const available = Math.max(1, width - prefix.length - suffix.length);
  const textWidth = Math.max(0, available - 1);
  const horizontalOffset = Math.max(0, quickColumn - textWidth);
  const visible = quickInput.slice(horizontalOffset, horizontalOffset + textWidth);
  const cursor = Math.max(0, quickColumn - horizontalOffset);
  const content = `${visible.slice(0, cursor)}▏${visible.slice(cursor)}`;
  return truncate(`${prefix}${content}${suffix}`, width);
}


function renderQuickCompletionRows(
  completion: TreeQuickCompletion | null,
  depth: number,
  width: number,
): string[] {
  if (!completion) return [];
  const prefix = `${"  ".repeat(depth)}  `;
  const window = completionWindow(completion.items.length, completion.index, 6);
  const truncationLabel =
    completion.truncatedLimit === null ? "" : ` · Showing first ${completion.truncatedLimit} matches`;
  const rows = [
    `${prefix}\x1b[2m${truncate(
      `Completions ${completion.index + 1}/${completion.items.length}${truncationLabel}`,
      Math.max(1, width - prefix.length),
    )}\x1b[0m`,
  ];
  for (let index = window.start; index < window.end; index++) {
    const item = completion.items[index];
    const label = truncate(item.label, Math.max(1, width - prefix.length - 2));
    rows.push(index === completion.index ? `${prefix}\x1b[7m› ${label}\x1b[0m` : `${prefix}  ${label}`);
  }
  return rows;
}
function authoredHeaderStateText(row: AuthoredLinkHeaderRow): string {
  const { state } = row;
  let text: string;
  if (state.kind === "loading") text = state.message;
  else if (state.kind === "error") text = `Error: ${state.message}`;
  else if (state.kind === "unavailable") text = state.message;
  else {
    const details = [countLabel(state.entryCount, "link")];
    if (state.invalidCount > 0) details.push(countLabel(state.invalidCount, "invalid reference"));
    if (state.limited) details.push("results limited");
    if (state.diagnostics.length > 0) {
      details.push(state.diagnostics.map((diagnostic) => diagnostic.message).join("; "));
    }
    text = details.join(" · ");
  }
  return sanitizeDynamicText(text);
}

function renderAuthoredLinkDisplay(row: AuthoredLinkRow, width: number, clippedLeft = false): string {
  const prefix = `${"  ".repeat(row.depth)}${clippedLeft ? "‹" : row.link.resolution.kind === "ready" ? "↗" : "!"} `;
  const duplicateLabel = row.link.occurrenceCount > 1
    ? ` · ${row.link.occurrenceCount} occurrences`
    : "";
  let content: string;
  if (row.link.kind === "outlink") {
    const resolution = row.link.resolution;
    if (resolution.kind === "ready") {
      content = `${row.link.label} → ${resolution.title} · ${row.link.referenceKind}${duplicateLabel}`;
    } else if (resolution.kind === "unregistered-page") {
      content = `${row.link.label} · page not registered · Enter creates${duplicateLabel}`;
    } else {
      content = `${row.link.label} · unavailable: ${resolution.reason}${duplicateLabel}`;
    }
  } else {
    const resolution = row.link.resolution;
    content = resolution.kind === "ready"
      ? `${row.link.label} → ${resolution.sourceName} · ${resolution.provider} · ${resolution.addressLabel}${duplicateLabel}`
      : resolution.kind === "unregistered"
      ? `${row.link.label} · Resource not registered · Enter creates${duplicateLabel}`
      : `${row.link.label} · unavailable: ${resolution.reason}${duplicateLabel}`;
  }
  return truncateToWidth(`${prefix}${sanitizeDynamicText(content)}`, width);
}

export function renderTreeBreadcrumbs(view:TreeView,width:number): {line:string;start:number} | null {
  const path=view.breadcrumbs;
  if(!path?.length) return null;
  const room=Math.max(1,width-6);
  const label=(index:number)=>`${path[index]!.kind === "occurrence" ? "◇ " : ""}${sanitizeDynamicText(path[index]!.label)}`;
  let start=view.breadcrumbStart ?? path.length-1;
  start=Math.max(0,Math.min(path.length-1,start));
  if(view.breadcrumbStart == null) {
    let used=visibleWidth(label(start));
    while(start>0 && used+3+visibleWidth(label(start-1))<=room) used+=3+visibleWidth(label(--start));
  }
  let content="";
  for(let i=start;i<path.length;i++) {
    const prefix=content ? " › " : "";
    const remaining=room-visibleWidth(content)-visibleWidth(prefix);
    if(remaining<=0) break;
    content+=prefix+outlinerActionLink(`tree.breadcrumb.focus:${encodeURIComponent(path[i]!.rowId)}`,truncateToWidth(label(i),remaining));
    if(visibleWidth(label(i))>remaining) break;
  }
  const padding=" ".repeat(Math.max(0,room-visibleWidth(content)));
  return {start,line:truncateToWidth(`${outlinerActionLink("tree.root.workspace","⌂")} ${outlinerActionLink("tree.breadcrumb.left","<")} ${content}${padding} ${outlinerActionLink("tree.breadcrumb.right",">")}`,width)};
}

export function renderTreeFrame(
  view: TreeView,
  width: number,
  height: number,
  initialScrollStartEntryIndex = 0,
  options: TreeRenderOptions = {},
): TreeRenderResult {
  if (view.localPreview && view.mode === "browse") {
    const preview=treePreviewFrame(view.localPreview,width,height,view.previewHelp ?? "Alt+P Tree/Preview · Esc close · drag to copy",view.previewPreferences);
    const tree=renderTreeFrame({...view,localPreview:null},preview.treeWidth,preview.treeHeight,initialScrollStartEntryIndex,{...options,clearScreen:false});
    const treeLines=tree.frame.split("\n");
    let lines:string[];
    if(preview.placement==='beside') lines=preview.lines.map((line,index)=>{
      const left=truncateToWidth(treeLines[index]??'',preview.treeWidth);
      return left+' '.repeat(Math.max(0,preview.treeWidth-visibleWidth(left)))+'│'+line;
    });
    else if(preview.placement==='below') lines=[...treeLines,'─'.repeat(width),...preview.lines];
    else {lines=view.localPreview.focused?preview.lines:treeLines;if(!view.localPreview.focused)lines[height-1]=truncateToWidth('Preview available · '+(view.previewHelp??'Alt+P focus · Esc close'),width);}
    const mouseTargets=preview.placement==='compact'&&view.localPreview.focused?[]:tree.mouseTargets.map(target=>target?{...target,minColumn:0,maxColumn:preview.treeWidth-1}:target);
    return{...tree,preview,mouseTargets,frame:`${options.clearScreen===false?'':`${ESC}H${ESC}2J`}${lines.slice(0,height).join("\n")}`};
  }
  if(view.mode==='action-menu' && view.destinationPreview) {
    const fit=(text:string,w:number)=>truncateToWidth(text,w);
    const body=Math.max(1,height-5),beside=width>=90;
    const listWidth=beside?Math.floor((width-1)*.48):width;
    const listHeight=beside?body:Math.max(2,Math.floor((body-1)*.5));
    const slots=Math.max(1,Math.floor(listHeight/2));
    const items=view.actionMenuItems??[],index=view.actionMenuIndex??0;
    const start=Math.max(0,index-slots+1), list:string[]=[];
    for(const [i,item] of items.slice(start,start+slots).entries()) {
      const label=fit(`${i+start===index?'›':' '} ${item.label}`,Math.max(1,listWidth));
      list.push(outlinerActionLink(item.id,i+start===index?`\x1b[7m${label}\x1b[0m`:label));
      list.push(fit(`  ${item.description}`,listWidth));
    }
    if(!items.length)list.push('No matching destinations');
    while(list.length<listHeight)list.push('');
    const previewWidth=beside?width-listWidth-1:width,previewHeight=beside?body:Math.max(1,body-listHeight-1);
    const preview=renderNavigationDestinationPreview(view.destinationPreview,previewWidth,previewHeight);
    const middle=beside?list.map((line,i)=>line+' '.repeat(Math.max(0,listWidth-visibleWidth(line)))+'│'+(preview[i]??'')):[...list,'─'.repeat(width),...preview];
    const openingOnce = view.destinationPurpose === 'open';
    const placing = view.destinationPurpose === 'place';
    const title = placing ? 'New Detail placement · Tree' : openingOnce ? 'Open once in… · Tree' : 'Link destination · Tree';
    const footer = placing ? '↑↓ choose anchor · Enter creates · Esc cancel · saved link unchanged' : openingOnce ? '↑↓ choose · Enter open once · Esc cancel · saved link unchanged' : '↑↓ choose · Enter link · Esc cancel · Alt+L link destination';
    const lines=[fit(title,width),fit(view.destinationInstructions??(openingOnce ? 'Choose where this item opens once' : 'Choose where links from Tree open'),width),fit(`Find: ${view.actionMenuQuery??''}▏`,width),'─'.repeat(width),...middle,fit(footer,width)];
    return{frame:(options.clearScreen===false?'':`${ESC}H${ESC}2J`)+lines.slice(0,height).join('\n'),scrollStartEntryIndex:initialScrollStartEntryIndex,mouseTargets:[]};
  }
  const output: string[] = [options.clearScreen === false ? "" : `${ESC}H${ESC}2J`];
  const mouseTargets: Array<TreeMouseTarget | null | undefined> = [];

  if (view.mode === "inbox" && view.inbox) {
    const lines = renderInboxFrame(view.inbox, width, height, view.actionHelpText ?? DEFAULT_OUTLINER_ACTION_KEYMAP.helpText("tree", "inbox"));
    return { frame: `${options.clearScreen === false ? "" : `${ESC}H${ESC}2J`}${lines.join("\n")}`, scrollStartEntryIndex: initialScrollStartEntryIndex, mouseTargets: [], preview:undefined };
  }

  if (view.mode === "goto" && view.goto) {
    const lines = renderGotoFrame(view.goto, width, height, view.actionHelpText ?? DEFAULT_OUTLINER_ACTION_KEYMAP.helpText("tree", "goto"));
    return { frame: `${options.clearScreen === false ? "" : `${ESC}H${ESC}2J`}${lines.join("\n")}`, scrollStartEntryIndex: initialScrollStartEntryIndex, mouseTargets: [] };
  }

  if (view.mode === "viewer") {
    output.push(`\x1b[1m${truncate(view.viewerPath, width)}\x1b[0m`);
    output.push("─".repeat(width));
    const bodyHeight = Math.max(1, height - 3);
    for (const line of view.viewerLines.slice(view.viewerOffset, view.viewerOffset + bodyHeight)) {
      output.push(renderMarkdownLine(truncate(line, width)));
    }
    while (output.length < height - 1) output.push("");
    output.push(
      `\x1b[2m${truncate(
        view.actionHelpText ?? DEFAULT_OUTLINER_ACTION_KEYMAP.helpText("tree", "viewer"),
        width,
      )}\x1b[0m`,
    );
    return {
      frame: output.join("\n"),
      scrollStartEntryIndex: initialScrollStartEntryIndex,
      mouseTargets,
    };
  }

  const breadcrumb=renderTreeBreadcrumbs(view,width);
  const paneMenu = outlinerActionLink("tree.menu.open", "[⋯]");
  const previewToggle = outlinerActionLink("tree.preview.toggle", view.previewPreferences?.enabled === false ? "[Show Preview]" : "[Hide Preview]");
  const indentationBadge = outlinerActionLink("tree.indentation.toggle", `[Indent: ${view.indentationMode ?? "viewport"}]`);
  output.push(
    truncateToWidth(`\x1b[1;36m${options.focused === undefined ? "Outliner" : `${options.focused ? "●" : "○"} Tree`}\x1b[0m  \x1b[2m${truncate(view.workspaceRoot, Math.max(1, width - 65))}\x1b[0m  ${paneMenu} ${previewToggle} ${indentationBadge}`, width),
  );
  const filterLabel = view.activeFilter ? `  \x1b[33mfilter: ${view.activeFilter}\x1b[0m` : "";
  const truncationLabel =
    view.visibleCompleteness.kind === "truncated"
      ? `  \x1b[33mWARNING: truncated at ${view.visibleCompleteness.limit}\x1b[0m`
      : "";
  const physicalCount = view.physicalRowCount;
  const occurrenceCount = view.occurrenceRowCount;
  const returnSummary = attentionReturnSummary(view.attention, width);
  output.push((view.root && !breadcrumb ? truncateToWidth(outlinerActionLink("tree.root.workspace", `← Workspace · ${sanitizeDynamicText(view.root.label)}`),width) : returnSummary) ?? truncateToWidth(
    `\x1b[2m${view.inboxCue ? `${outlinerActionLink("tree.inbox.open", view.inboxCue)} · ` : ""}${countLabel(physicalCount, "physical block")} · ${countLabel(
      occurrenceCount,
      "projected occurrence",
    )}${filterLabel}\x1b[0m${truncationLabel}`,
    width,
  ));
  if (breadcrumb) output.push(breadcrumb.line);
  output.push(view.navigationDestinationLabel === undefined ? "─".repeat(width)
    : outlinerActionLink("tree.navigation.link", truncateToWidth(`Opens in: ${truncateToWidth(sanitizeDynamicText(view.navigationDestinationLabel), Math.max(1, width - 21))} / Change`, width)));
  const headerHeight = output.length;
  const bodyHeight = Math.max(1, height - 6 - (breadcrumb ? 1 : 0));
  if (view.mode === "action-menu") {
    const actionMenuItems = view.actionMenuItems ?? [];
    const actionMenuIndex = view.actionMenuIndex ?? 0;
    const actionMenuQuery = view.actionMenuQuery ?? "";
    const originRow = view.actionMenuOrigin
      ? Math.max(0, Math.min(bodyHeight - 1, view.actionMenuOrigin.row - headerHeight))
      : 0;
    const menuColumn = view.actionMenuOrigin
      ? Math.max(0, Math.min(view.actionMenuOrigin.column, Math.max(0, width - 24)))
      : 0;
    const menuHeight = Math.max(1, bodyHeight - originRow);
    const menuWidth = Math.max(1, width - menuColumn);
    const window = completionWindow(
      actionMenuItems.length,
      actionMenuIndex,
      menuHeight,
    );
    for (let row = 0; row < originRow; row += 1) output.push("");
    for (let index = window.start; index < window.end; index++) {
      const item = actionMenuItems[index]!;
      const text = actionMenuItemText(item);
      const linked = outlinerActionLink(item.id, truncate(text, Math.max(1, menuWidth - 2)));
      const prefix = " ".repeat(menuColumn);
      output.push(
        `${prefix}${index === actionMenuIndex ? `\x1b[7m› ${linked}\x1b[0m` : `  ${linked}`}`,
      );
    }
    while (output.length < height - 2) output.push("");
    const selected = actionMenuItems[actionMenuIndex];
    const description = selected ? ` · ${selected.description}` : "";
    output.push(truncate(`Find: ${actionMenuQuery}▏${description}`, width));
    output.push(`\x1b[2m${truncate("↑↓ choose  ↵ invoke  ⎋ close", width)}\x1b[0m`);
    return {
      frame: output.join("\n"),
      scrollStartEntryIndex: initialScrollStartEntryIndex,
      mouseTargets,
    };
  }
  const selectedExpandedInfo = {
    current: null as { offset: number; end: number; total: number } | null,
  };

  function rowIsVisualDescendant(
    candidate: TreeDisplayRow,
    ancestor: TreeDisplayRow,
  ): boolean {
    if (!isBlockTreeRow(ancestor)) return false;
    if (!isBlockTreeRow(candidate)) return candidate.owner.rowId === ancestor.rowId;
    return isVisualDescendant(candidate, ancestor, view.physicalBlocksById);
  }
  const insertionPoint =
    view.mode === "add-child" || view.mode === "add-sibling"
      ? quickInsertionPoint(view.rows, view.selectedIndex, view.mode, rowIsVisualDescendant)
      : null;
  const quickEntryIndex = insertionPoint?.gap ?? -1;
  const entryCount = view.rows.length + Number(insertionPoint !== null);
  function entryAt(index: number): TreeRenderEntry {
    if (insertionPoint && index === quickEntryIndex) {
      return { kind: "quick", depth: insertionPoint.depth };
    }
    return {
      kind: "block",
      blockIndex: insertionPoint && index > quickEntryIndex ? index - 1 : index,
    };
  }


  let indentOffset=0;
  const displayDepth=(depth:number)=>Math.max(0,depth-indentOffset);
  const renderedRows: Array<string[] | undefined> = [];
  function getBlockRows(index: number): string[] {
    const cached = renderedRows[index];
    if (cached) return cached;

    const sourceRow = view.rows[index]!;
    const row = {...sourceRow,depth:displayDepth(sourceRow.depth)};
    const clippedLeft = sourceRow.depth < indentOffset;
    if (!isBlockTreeRow(row)) {
      const result = row.kind === "authored-link-header"
        ? [
            truncateToWidth(
              `${"  ".repeat(row.depth)}${clippedLeft ? "‹" : row.collapsed ? "▸" : "▾"} ${
                sanitizeDynamicText(row.label)
              }  \x1b[2m${authoredHeaderStateText(row)}\x1b[0m`,
              width,
            ),
          ]
        : [renderAuthoredLinkDisplay(row, width, clippedLeft)];
      renderedRows[index] = result;
      return result;
    }
    const block = row.block;
    let marker = row.kind === "occurrence" ? "◇" : "•";
    if (row.hasChildren) marker = row.collapsed ? "▸" : "▾";
    if (clippedLeft) marker = "‹";
    const author = AUTHOR_MARKERS[block.author];
    const editingInline = view.mode === "edit" && index === view.selectedIndex;
    if (editingInline) {
      const result = [
        renderQuickInputRow(view.quickInput, view.quickColumn, row.depth, marker, author, width),
        ...renderQuickCompletionRows(view.quickCompletion, row.depth + 1, width),
      ];
      renderedRows[index] = result;
      return result;
    }

    const document = row.multilineExpanded ? view.expandedDocuments.get(block.id) : undefined;
    if (row.multilineExpanded && !document) throw new Error(`Missing expanded Tree document: ${block.id}`);
    const linker = createOutlinerTextLinker(
      document?.resolved.references ?? block,
      (blockId) => view.physicalBlocksById.has(blockId),
      view.workIdPrefix,
    );

    const branchState =
      row.kind === "physical" ? view.branchStates.get(row.canonicalId) : undefined;
    let trashLabel = "";
    if (block.deletedAt) {
      trashLabel = `  [Trash · ${block.deletedDescendantCount ?? 0} descendants]`;
    } else if (block.effectiveDeletedRootId) {
      trashLabel = "  [Trash]";
    }
    const semanticState = block.deletedAt || block.effectiveDeletedRootId
      ? null
      : treeSemanticState(block);
    const semanticTreatment = semanticState ? TREE_SEMANTIC_TREATMENTS[semanticState] : null;
    let result: string[];
    if (!row.multilineExpanded) {
      const prefix = `${"  ".repeat(row.depth)}${marker} `;
      const branchBadge = branchState ? virtualBranchStateLabel(branchState) : "";
      const fixedSuffix = `${branchBadge}${trashLabel}`;
      const optionalSuffix = `  ${author}`;
      const summary = propertySummarySegments(
        block.properties,
        propertyKeysForRow(view, row, options),
      );
      result = [
        linker.link(
          renderCollapsedRow(
            prefix,
            semanticText(block.preview, semanticTreatment),
            summary,
            fixedSuffix,
            optionalSuffix,
            width,
          ),
          prefix.length + (semanticTreatment ? semanticTreatment.sgr.length + semanticTreatment.glyph.length + 1 : 0),
        ),
      ];
    } else {
      const displayText = decorateVirtualBranchDefinitionText(
        `${semanticText(document!.resolved.text, semanticTreatment)}${trashLabel}`,
        branchState,
      );
      const expandedRows = layoutExpandedBlock({
        text: displayText,
        width,
        depth: row.depth,
        marker,
        author,
      }).map((renderedRow, rowIndex) => {
        const linkedText = linker.link(renderedRow.text);
        const text = rowIndex === 0 ? linkedText : renderMarkdownLine(linkedText);
        return `${renderedRow.prefix}${text}${renderedRow.suffix}`;
      });
      if (index === view.selectedIndex) {
        const maxOffset = Math.max(0, expandedRows.length - bodyHeight);
        const offset = Math.min(view.expandedBlockOffset, maxOffset);
        const end = Math.min(expandedRows.length, offset + bodyHeight);
        selectedExpandedInfo.current = {
          offset,
          end,
          total: expandedRows.length,
        };
        result = expandedRows.slice(offset, end);
      } else {
        result = expandedRows;
      }
    }
    const attention = currentAttentionMark(view.attention, row.canonicalId);
    if (attention) {
      result = result.map((line, lineIndex) =>
        lineIndex === 0 ? decorateAttentionBlockLine(line, attention, width) : line
      );
    }
    renderedRows[index] = result;
    return result;
  }

  function getEntryRows(entry: TreeRenderEntry): string[] {
    if (entry.kind === "block") return getBlockRows(entry.blockIndex);
    return [
      renderQuickInputRow(view.quickInput, view.quickColumn, displayDepth(entry.depth), "•", AUTHOR_MARKERS.user, width),
      ...renderQuickCompletionRows(view.quickCompletion, displayDepth(entry.depth) + 1, width),
    ];
  }

  function getEntryHeight(entryIndex: number): number {
    const entry = entryAt(entryIndex);
    if (entry.kind === "quick") return getEntryRows(entry).length;
    const row = view.rows[entry.blockIndex];
    const editingInline =
      isBlockTreeRow(row) && view.mode === "edit" && entry.blockIndex === view.selectedIndex;
    return isBlockTreeRow(row) && (row.multilineExpanded || editingInline)
      ? getEntryRows(entry).length
      : 1;
  }

  const targetEntryIndex = insertionPoint
    ? quickEntryIndex
    : Math.max(0, view.selectedIndex + Number(quickEntryIndex >= 0 && view.selectedIndex >= quickEntryIndex));
  let scrollStartEntryIndex = Math.max(
    0,
    Math.min(initialScrollStartEntryIndex, Math.max(0, entryCount - 1)),
  );
  if (targetEntryIndex < scrollStartEntryIndex) {
    scrollStartEntryIndex = targetEntryIndex;
  } else if (scrollStartEntryIndex < targetEntryIndex) {
    let requiredHeight = 0;
    let scanIndex = scrollStartEntryIndex;
    while (scanIndex <= targetEntryIndex && requiredHeight <= bodyHeight) {
      requiredHeight += getEntryHeight(scanIndex);
      scanIndex += 1;
    }
    if (scanIndex <= targetEntryIndex) {
      scrollStartEntryIndex = targetEntryIndex;
      requiredHeight = getEntryHeight(targetEntryIndex);
      while (scrollStartEntryIndex > 0) {
        const previousHeight = getEntryHeight(scrollStartEntryIndex - 1);
        if (requiredHeight + previousHeight > bodyHeight) break;
        scrollStartEntryIndex -= 1;
        requiredHeight += previousHeight;
      }
    } else {
      while (requiredHeight > bodyHeight && scrollStartEntryIndex < targetEntryIndex) {
        requiredHeight -= getEntryHeight(scrollStartEntryIndex);
        scrollStartEntryIndex += 1;
      }
    }
  }

  // Rewrapping may expose shallower rows. Reduce the shared shift until every
  // row in the final viewport fits that ancestry; never flatten parent/child rows.
  function commonViewportDepth(): number {
    let scanHeight = 0;
    let commonDepth = Infinity;
    for (let index = scrollStartEntryIndex; index < entryCount && scanHeight < bodyHeight; index++) {
      const entry = entryAt(index);
      commonDepth = Math.min(commonDepth, entry.kind === "quick" ? entry.depth : view.rows[entry.blockIndex]!.depth);
      scanHeight += getEntryHeight(index);
    }
    return Number.isFinite(commonDepth) ? Math.max(0, commonDepth - 1) : 0;
  }
  indentOffset = view.indentationMode === "selection"
    ? Math.max(0, (insertionPoint?.depth ?? view.rows[view.selectedIndex]?.depth ?? 0) - 1)
    : commonViewportDepth();
  if (indentOffset) renderedRows.length = 0;
  while (view.indentationMode !== "selection" && indentOffset > 0) {
    const nextOffset = commonViewportDepth();
    if (nextOffset >= indentOffset) break;
    indentOffset = nextOffset;
    renderedRows.length = 0;
  }
  let renderedBodyLines = 0;
  for (let entryIndex = scrollStartEntryIndex; entryIndex < entryCount; entryIndex++) {
    if (renderedBodyLines >= bodyHeight) break;
    const entry = entryAt(entryIndex);
    const entryRows = getEntryRows(entry);
    for (let lineIndex = 0; lineIndex < entryRows.length; lineIndex++) {
      if (renderedBodyLines >= bodyHeight) break;
      const line = entryRows[lineIndex];
      if (entry.kind === "block") {
        const row = view.rows[entry.blockIndex];
        const disclosureMarkerVisible =
          lineIndex === 0 &&
          (!isBlockTreeRow(row) ||
            !row.multilineExpanded ||
            entry.blockIndex !== view.selectedIndex ||
            view.expandedBlockOffset === 0);
        mouseTargets[output.length] = {
          rowId: row.rowId,
          disclosureColumn:
            row.depth >= indentOffset && (row.kind === "authored-link-header" ||
              (isBlockTreeRow(row) && row.hasChildren && disclosureMarkerVisible))
              ? displayDepth(row.depth) * 2
              : -1,
        };
      }
      output.push(
        entryIndex === targetEntryIndex && lineIndex === 0
          ? applySelectedRow(line)
          : line,
      );
      renderedBodyLines += 1;
    }
  }
  while (output.length < height - 2) output.push("");

  const selectedRow = view.rows[view.selectedIndex];
  const selectedBranchState =
    selectedRow?.kind === "physical"
      ? view.branchStates.get(selectedRow.canonicalId)
      : undefined;
  const selectedInfo = selectedExpandedInfo.current;
  const expandedScrollable = selectedInfo !== null && selectedInfo.total > bodyHeight;
  const expandedStatus = expandedScrollable
    ? `Expanded block rows ${selectedInfo.offset + 1}-${selectedInfo.end}/${selectedInfo.total}`
    : "";
  const creationHelp =
    view.mode === "add-child"
      ? virtualBranchCreationHelp(selectedBranchState, view.physicalBlocksById)
      : null;
  if (view.mode === "edit" || view.mode === "add-child" || view.mode === "add-sibling") {
    output.push(
      creationHelp
        ? truncate(creationHelp, width)
        : truncate(
          view.actionHelpText ?? DEFAULT_OUTLINER_ACTION_KEYMAP.helpText("tree", view.mode),
          width,
        ),
    );
  } else if (view.mode === "purge") {
    const required =
      isBlockTreeRow(selectedRow)
        ? selectedRow.block.properties.find((property) => property.key === "work-id")?.value
          ?? selectedRow.canonicalId.slice(0, 8)
        : "identifier";
    output.push(`\x1b[31;1mPurge ${required}: \x1b[0m${view.quickInput}▏`);
  } else if (view.mode === "filter") {
    const label = "Filter";
    const completion = view.quickCompletion;
    const selectedCompletion = completion?.items[completion.index];
    let completionSuffix = "";
    if (completion && selectedCompletion) {
      completionSuffix = `  ${completion.index + 1}/${completion.items.length} ${selectedCompletion.label}`;
    } else if (view.status) {
      completionSuffix = `  ${view.status}`;
    }
    output.push(
      `\x1b[1m${label}:\x1b[0m ${truncate(
        `${view.quickInput}▏${completionSuffix}`,
        Math.max(1, width - label.length - 3),
      )}`,
    );
  } else if (view.mode === "delete") {
    if (selectedRow?.kind === "occurrence") {
      output.push(
        `\x1b[33;1m${truncate(
          `Move canonical block “${selectedRow.block.preview}” and its descendants to Trash? y/N`,
          width,
        )}\x1b[0m`,
      );
    } else {
      output.push("\x1b[33;1mMove this block and its descendants to Trash? y/N\x1b[0m");
    }
  } else {
    const contextualStatus =
      view.status ||
      expandedStatus ||
      (selectedBranchState ? branchStatusText(selectedBranchState) : "");
    output.push(truncate(contextualStatus, width));
  }
  const help = view.actionHelpText ??
    DEFAULT_OUTLINER_ACTION_KEYMAP.helpText("tree", view.mode);
  output.push(`\x1b[2m${truncate(options.focused === undefined ? help : `F6 Detail  ${help}`, width)}\x1b[0m`);
  return { frame: output.join("\n"), scrollStartEntryIndex, mouseTargets, breadcrumbStart:breadcrumb?.start,
    expandedPage: selectedInfo && isBlockTreeRow(selectedRow) && selectedRow.multilineExpanded
      ? {rowId:selectedRow.rowId,pageSize:bodyHeight,totalRows:selectedInfo.total,offset:selectedInfo.offset} : null,
  };
}
