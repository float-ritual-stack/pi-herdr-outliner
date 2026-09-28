import {TreeComments} from "./tree-comments";
import {TreeBranchFilter} from "./tree-branch-filter";
import {adjacentReaderMenu, readerMenuFromAction, readerMenuItems, type ReaderDensity, type ReaderMenu} from "./reader-chrome";
import {wrapTextWithAnsi} from '@earendil-works/pi-tui';
import {inspectWorkspaceConnection,type WorkspaceReport} from './workspace-diagnostics';
import {layoutWorkspaceReport} from './workspace-report-view';
import { ReferenceCompletionSession, referenceCompletionProvider, type ReferenceCompletionItem } from "./reference-completion";
import {TreeConnections} from "./tree-connections";
import {TreeWorkingSelection} from "./tree-working-selection";
import {OpenDestinationChooser, destinationRecoveryKey, missingNavigationDestination, type OpenDestinationTarget} from "./open-destination-chooser";
import type {DetailDestinationPlacement} from "./detail-pane-placement";
import type {ChangeFeedPage, MutationProvenance, OutlinerCapability, OutlinerServiceStatus, OutlinerViewAddress} from "./types";
import {checkServiceCompatibility} from "./service-compatibility";
import {DocumentPreview, type DocumentPreviewState} from './document-preview';
import {treePreviewFrame, defaultPreviewPreferences, type PreviewPreferences} from './tree-preview';
import type { RequestInput } from "./client";
import { emptyAttentionState } from "./attention";
import { GotoController } from "./goto-controller";
import { handleGotoMouse as routeGotoMouse } from "./goto-renderer";
import { InboxController } from "./inbox-controller";
import { inboxStatusCue } from "./inbox-renderer";
import {
  filterCompletionTargetAtCursor,
  parseSearchExpression,
  serializePropertyFilterValue,
} from "./block-query";
import { referencedFilePreview, type FileContents } from "./files";
import { getProperty, parseProperties } from "./properties";
import {
  firstOutlinerReference,
  outlinerLinkUri, parseOutlinerLinkUri,
  followResourceOccurrence,
  navigateOutlinerLink,
  resolveOutlinerLinkTarget,
} from "./outliner-links";
import { blockDisplayTitle } from "./references";
import {
  DEFAULT_OUTLINER_ACTION_KEYMAP,
  displayActionChord,
  filterActionMenuItems,
  type OutlinerActionKeymap,
  type OutlinerActionMenuItem,
} from "./outliner-actions";
import { navigationDestinationItems, navigationPlacementItems, navigationPlacementStatus, navigationDestinationStatus, NavigationDestinationPreview, NavigationDestinationDisplay } from "./navigation-destination-menu";
import type { TreeNavigation, NavigationRouteOptions } from "./navigation-routes";
import {
  historyNavigationDirection,
  isDetailToggle,
  isPrintableInput,
  sanitizeDynamicText,
  type TerminalInputAction,
  type TerminalKey,
} from "./terminal";
import {
  authoredLinkActivation,
  authoredLinkCanOpen,
  authoredLinkFallbackRowIds,
  authoredLinkHeaderRowId,
  authoredLinkTarget,
  authoredLinkUnavailableReason,
  connectionOwner,
  isBlockTreeRow,
  type AuthoredLinkHeaderRow,
  type TreeDisplayRow as ProjectedDisplayRow,
} from "./tree-rows";
import { isVirtualBranchDefinition } from "./virtual-branches";
import { TextBuffer } from "./text-buffer";
import type {
  AttentionClientState,
  Block,
  BookmarkStatus,
  BookmarkToggleReceipt,
  BlockCollectionCompleteness,
  InternResourceReceipt,
  OutlinerEvent,
  OutlinerNavigationIntent,
  NavigationLinkState,
  OutlinerNavigationTarget,
  PropertyCatalogItem,
  SavedViewReadResult,
  TreeIndexBlock,
  TreeIndexCollection,
  TreeIndexSnapshot,
  ResolvedBlockReferences,
} from "./types";
import {
  buildVirtualBranchCreationText,
  isVirtualBranchOccurrence,
  isVirtualBranchRootOccurrence,
  projectVirtualBranches,
  planVirtualChild,
  savedViewMembership,
  type PhysicalTreeRow as ProjectedPhysicalRow,
  type TreeRow as ProjectedTreeRow,
  type VirtualBranchOccurrenceRow as ProjectedOccurrenceRow,
  type VirtualBranchState,
  type TreePresentationState,
} from "./virtual-branches";

type TreeRow = ProjectedTreeRow<TreeIndexBlock>;
type PhysicalTreeRow = ProjectedPhysicalRow<TreeIndexBlock>;
type VirtualBranchOccurrenceRow = ProjectedOccurrenceRow<TreeIndexBlock>;
type TreeDisplayRow = ProjectedDisplayRow<TreeIndexBlock>;

export interface ExpandedTreeDocument {
  readonly block: Block;
  readonly resolved: ResolvedBlockReferences;
}

export type TreeInputMode =
  | "edit"
  | "add-child"
  | "add-sibling"
  | "filter"
  | "branch-filter"
  | "goto"
  | "purge";
export type TreeMode = "browse" | "delete" | "viewer" | "action-menu" | "inbox" | TreeInputMode;

export type TreeQuickCompletionItem = ReferenceCompletionItem;

export interface TreeQuickCompletion {
  readonly start: number;
  readonly end: number;
  readonly index: number;
  readonly truncatedLimit: number | null;
  readonly message?:string;
  readonly loading?:boolean;
  readonly generation?:number;
  readonly items: readonly TreeQuickCompletionItem[];
}

export interface TreeRoot { readonly rowId: string; readonly canonicalId: string; readonly label: string }

export interface TreeView {
  readonly density?: ReaderDensity;
  readonly actionMenuCategory?: ReaderMenu;
  readonly root?: TreeRoot | null;
  readonly breadcrumbs?: readonly (TreeRoot & {kind:"physical"|"occurrence"})[];
  readonly breadcrumbStart?: number | null;
  readonly indentationMode?: "viewport" | "selection";
  readonly scrollStartEntryIndex?: number;
  readonly workspaceRoot: string;
  readonly rows: readonly TreeDisplayRow[];
  readonly physicalBlocksById: ReadonlyMap<string, TreeIndexBlock>;
  readonly expandedDocuments: ReadonlyMap<string, ExpandedTreeDocument>;
  readonly physicalRowCount: number;
  readonly occurrenceRowCount: number;
  readonly workIdPrefix: string | null;
  readonly visibleCompleteness: BlockCollectionCompleteness;
  readonly branchStates: ReadonlyMap<string, VirtualBranchState>;
  readonly workspaceContextBlockId: string | null;
  readonly selectedIndex: number;
  readonly activeFilter: string;
  readonly branchFilterCue?: string;
  readonly mode: TreeMode;
  readonly quickInput: string;
  readonly quickColumn: number;
  readonly quickCompletion: TreeQuickCompletion | null;
  readonly goto?: GotoController | null;
  readonly inbox?: InboxController | null;
  readonly inboxCue?: string;
  readonly localPreview?: DocumentPreviewState | null;
  readonly previewHelp?: string;
  readonly previewPreferences?: PreviewPreferences;
  readonly viewerLines: readonly string[];
  readonly viewerPath: string;
  readonly viewerOffset: number;
  readonly workspaceReport?: WorkspaceReport | null;
  readonly viewerStatus?: string;
  readonly viewerHelp?: string;
  readonly expandedBlockOffset: number;
  readonly status: string;
  readonly refreshPending: boolean;
  readonly actionHelpText?: string;
  readonly actionMenuItems?: readonly OutlinerActionMenuItem[];
  readonly actionMenuIndex?: number;
  readonly actionMenuOrigin?: { column: number; row: number } | null;
  readonly attention: AttentionClientState;
  readonly actionMenuQuery?: string;
  readonly destinationPreview?: NavigationDestinationPreview;
  readonly destinationInstructions?: string;
  readonly destinationPurpose?: "link" | "open" | "place";
  readonly navigationDestinationLabel?: string;
  readonly recoveryHelp?:string;
  readonly recoveryStatus?:string;
  readonly collectedIds?: ReadonlySet<string>;
  readonly selectionCue?: string;
  readonly recoverableSelections?: number;
  readonly recoverableSelectionsTruncated?: boolean;
}

export interface TreeControllerEffects {
  previewSelectionInput?: import('./document-preview').PreviewSelectionInput;
  density?(): ReaderDensity;
  inspectProperties?(blockId: string): void | Promise<void>;
  setDensity?(density: ReaderDensity): void;
  copyText?(text:string):void;
  openExternal?(url:string):void|Promise<void>;
  readonly initialRoot?: TreeRoot;
  createTreePane?(root: TreeRoot | null, direction: "right" | "down"): Promise<void>;
  readonly workspaceRoot: string;
  readonly navigation: TreeNavigation;
  readonly clientId: string;
  readonly browsingContextId: string;
  request<T>(input: RequestInput): Promise<T>;
  createDetailPane(blockId: string, direction?: "right" | "down", targetPaneId?: string): Promise<void>;
  createDetailDestination?(blockId: string, placement: DetailDestinationPlacement): Promise<OutlinerViewAddress>;
  openKeyInspector?(): void;
  openCapturePopup(capturedFromBlockId: string): Promise<void>;
  openGotoPopup?(): void | Promise<void>;
  openVirtualBranchNavigator(viewId: string, adapter?: "bookmark" | "mentions"): void | Promise<void>;
  focusSelf(): void;
  terminalWidth(): number;
  terminalHeight(): number;
  stop(): void;
  invalidate(): void;
  readonly actionKeymap?: OutlinerActionKeymap;
}

export interface TreeExpandedPage {
  readonly rowId: string;
  readonly pageSize: number;
  readonly totalRows: number;
  readonly offset: number;
}

export interface TreeController {
  readonly mode: TreeMode;
  copyViewerSelection(text: string): void;
  setViewportStart(index: number, expandedPage?: TreeExpandedPage | null): void;
  setBreadcrumbStart(index: number): void;
  view(): TreeView;
  revealBlock(blockId: string): Promise<void>;
  initialize(): Promise<void>;
  handleKeypress(str: string, key: TerminalKey, inputAction: TerminalInputAction): Promise<void>;
  handleTreeWheel(direction: "up" | "down"): Promise<void>;
  handleLink(uri:string):Promise<void>;
  handlePaste(text: string): Promise<void>;
  handleGotoMouse(sequence: string): Promise<void>;
  focusLocalPreview(focused?: boolean): void;
  scrollLocalPreview(delta:number): void;
  resizeLocalPreview(fraction:number): void;
  handleDisclosure(rowId: string): Promise<void>;
  handleRowClick(rowId: string, activate?: boolean): Promise<void>;
  handleAction(actionId: string, origin?: { column: number; row: number }): Promise<void>;
  handleServiceEvent(event: OutlinerEvent): Promise<void>;
  handleConnect(): Promise<void>;
  handleDisconnect(): void;
  handleError(error: unknown): void;
}

interface MutableQuickCompletion {
  start: number;
  end: number;
  index: number;
  items: TreeQuickCompletionItem[];
  truncatedLimit: number | null;
  message?:string;
  loading?:boolean;
  generation?:number;
}

interface TreeNavigationEntry {
  readonly root: TreeRoot | null;
  readonly scrollStartEntryIndex: number;
  readonly rowId: string;
  readonly canonicalId: string;
}

interface PendingBrowsingPublication {
  rowId: string | null;
  readonly target: OutlinerNavigationTarget | null;
  readonly dispatchPreview: boolean;
}
/** Who the Tree says made a change: the person, through the Tree. */
const TREE_MUTATION = { author: "user", actorId: "tree" } as const satisfies MutationProvenance;

const MAX_TREE_HISTORY_ENTRIES = 200;


function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const GENERATED_ROW_DISABLED_ACTIONS: Record<string, true> = {
  "tree.bookmark.toggle": true,
  "tree.capture": true,
  "tree.add.child": true,
  "tree.add.sibling": true,
  "tree.current.reveal": true,
  "tree.delete": true,
  "tree.detail.below": true,
  "tree.detail.right": true,
  "tree.edit": true,
  "tree.file.open": true,
  "tree.reference.open": true,
  "tree.reference.reveal": true,
  "tree.reorder.up": true,
  "tree.reorder.down": true,
  "tree.virtual-branch.open": true,
};

function rowIndexForIdentity(
  rows: readonly TreeDisplayRow[],
  rowId: string,
  canonicalId = rowId,
): number {
  const exactIndex = rows.findIndex((row) => row.rowId === rowId);
  if (exactIndex >= 0) return exactIndex;
  const physicalIndex = rows.findIndex(
    (row) => row.kind === "physical" && row.canonicalId === canonicalId,
  );
  if (physicalIndex >= 0) return physicalIndex;
  return rows.findIndex((row) => isBlockTreeRow(row) && row.canonicalId === canonicalId);
}

function fallbackRowBeforeDelete(
  rows: readonly TreeDisplayRow[],
  selectedIndex: number,
  physicalBlocksById: ReadonlyMap<string, TreeIndexBlock>,
): TreeRow | null {
  const selected = rows[selectedIndex];
  if (!isBlockTreeRow(selected)) return null;
  const blockRows = rows.filter(isBlockTreeRow);
  const selectedBlockIndex = blockRows.findIndex((row) => row.rowId === selected.rowId);
  const removedCanonicalIds = new Set([selected.canonicalId]);
  let discoveredDescendant = true;
  while (discoveredDescendant) {
    discoveredDescendant = false;
    for (const block of physicalBlocksById.values()) {
      if (
        block.parentId &&
        removedCanonicalIds.has(block.parentId) &&
        !removedCanonicalIds.has(block.id)
      ) {
        removedCanonicalIds.add(block.id);
        discoveredDescendant = true;
      }
    }
  }
  const survives = (row: TreeRow): boolean =>
    !removedCanonicalIds.has(row.canonicalId) &&
    !(row.kind === "occurrence" && removedCanonicalIds.has(row.viewId));
  const survivingRows = blockRows.filter(survives);
  if (survivingRows.length === 0) return null;
  const removedBefore = blockRows
    .slice(0, selectedBlockIndex)
    .filter((row) => !survives(row))
    .length;
  const fallbackIndex = Math.min(
    selectedBlockIndex - removedBefore,
    survivingRows.length - 1,
  );
  return survivingRows[Math.max(0, fallbackIndex)] ?? null;
}

/**
 * Capabilities every process hosting a Tree controller requires at startup:
 * saved views are read with views.read, and virtual-child admission sends a
 * saved view's parsed `where` with tree.query, which an older service would
 * ignore and answer unfiltered.
 */
export const TREE_SERVICE_CAPABILITIES: readonly OutlinerCapability[] = ["views.read", "query.expression"];

export function createTreeController(effects: TreeControllerEffects): TreeController {
  let baseRows: TreeRow[] = [];
  let rows: TreeDisplayRow[] = [];
  let root: TreeRoot | null = effects.initialRoot ?? null;
  let expandedPage: TreeExpandedPage | null = null;
  let fullRowsById = new Map<string,TreeRow>();
  let breadcrumbRowId: string | undefined;
  let breadcrumbStart: number | null = null;
  let indentationMode: "viewport" | "selection" = "viewport";
  let scrollStartEntryIndex = 0;
  let physicalBlocksById = new Map<string, TreeIndexBlock>();
  let expandedDocuments = new Map<string, ExpandedTreeDocument>();
  let indexSequence: number | null = null;
  // True from the start of a row fetch until one completes. A fetch that fails
  // (e.g. a view-state change while the service is down) leaves the rows stale
  // even when the change feed later reports no writes.
  let rowsNeedFetch = false;
  // The database `ping` reported for the service the loaded rows and
  // `indexSequence` came from; null when unknown.
  let serviceDatabase: string | null = null;
  let quickEditSource: Pick<Block, "id" | "revision"> | null = null;
  let projectedChildDraft: { parent: VirtualBranchOccurrenceRow; created?: Block; rowId?: (id: string) => string } | null = null;
  let projectionVisible: TreeIndexBlock[] = [];
  let projectionRanks: TreeIndexSnapshot["virtualOccurrenceRanks"] = [];
  let physicalRowCount = 0;
  let occurrenceRowCount = 0;
  let workIdPrefix: string | null = null;
  let visibleCompleteness: BlockCollectionCompleteness = { kind: "complete" };
  let branchStates = new Map<string, VirtualBranchState>();
  const collapsedBlockIds = new Set<string>();
  const comments=new TreeComments();
  const connections=new TreeConnections(effects,()=>{recomposeAuthoredRows();effects.invalidate();});
  const collapsedOccurrenceRowIds = new Set<string>();
  const expandedOccurrenceRowIds = new Set<string>();
  const multilineExpandedRowIds = new Set<string>();
  const uncollapsedPresentationIds = new Set<string>();
  const navigationHistory: TreeNavigationEntry[] = [];
  let navigationIndex = -1;
  let initialWorkspaceSelectionApplied = false;
  let workspaceContextBlockId: string | null = null;
  let selectedIndex = 0;
  let activeFilter = "";
  let branchFilter: TreeBranchFilter | null = null;
  let branchFilterReturn: {root: TreeRoot | null; scroll: number; collapsed: Set<string>; occurrences: Set<string>; expanded: Set<string>; multiline: Set<string>; documentOffset: number} | null = null;
  let placementMenu: "before" | "after" | null = null;
  let mode: TreeMode = "browse";
  let quickBuffer = new TextBuffer();
  let quickCompletion: MutableQuickCompletion | null = null;
  const completions=new ReferenceCompletionSession(referenceCompletionProvider(effects,"tree"),()=>quickBuffer,()=>workIdPrefix,
    ()=>{quickCompletion=completions.state?{...completions.state,truncatedLimit:completions.state.truncatedLimit??null}:null;effects.invalidate();},
    ()=>["edit","add-child","add-sibling"].includes(mode),()=>quickEditSource?{blockId:quickEditSource.id,text:quickBuffer.text}:undefined);


  const localReader = new DocumentPreview(effects, () => effects.invalidate(), effects.clientId,effects.openExternal,effects.previewSelectionInput,effects.actionKeymap,effects.copyText);
  let previewPreferences = defaultPreviewPreferences();
  let viewerLines: string[] = [];
  let viewerPath = "";
  let viewerOffset = 0;
  let viewerWrap=false;
  let workspaceReport:WorkspaceReport|null=null;
  let viewerField=0;
  let viewerStatus="";
  const reportLayout=()=>workspaceReport?layoutWorkspaceReport(workspaceReport.entries,effects.terminalWidth(),viewerField):null;
  const displayedViewerLines=()=>reportLayout()?.lines??(viewerWrap?viewerLines.flatMap(line=>wrapTextWithAnsi(line,Math.max(1,effects.terminalWidth()))):viewerLines);
  let expandedBlockOffset = 0;
  let lastVisibleCanonicalId: string | null = null;
  let status = "";
  const collected = new TreeWorkingSelection(effects, effects.clientId, () => effects.invalidate());
  let selectionMenu = false;
  let disconnected = false;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  function routineNotice(message: string): void {
    status = message;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { if (status === message) { status = ""; effects.invalidate(); } }, 3_000);
    noticeTimer.unref();
  }

  let browsingPublicationStatus = "";
  let refreshPending = false;
  let attention = emptyAttentionState(effects.clientId);
  const actionKeymap = effects.actionKeymap ?? DEFAULT_OUTLINER_ACTION_KEYMAP;
  let actionMenuOrigin: { column: number; row: number } | null = null;
  let actionMenuIndex = 0;
  const destinationPreview=new NavigationDestinationPreview(effects,effects.invalidate);
  const navigationDisplay = new NavigationDestinationDisplay(effects, {clientId: effects.clientId, region: "tree"}, effects.invalidate);
  let showOtherDestinations=false;
  let actionMenuQuery = "";
  let actionMenuReturnMode: TreeMode = "browse";
  let actionMenuScope = "browse";
  let actionMenuCategory: ReaderMenu = "all";
  let locationMenu: OutlinerActionMenuItem[] | null = null;
  let lastInboxCue = "";
  let pendingBrowsingPublication: PendingBrowsingPublication | null = null;
  let browsingPublicationPump: Promise<void> | null = null;

  const goto = new GotoController({
    request: input => effects.request(input),
    invalidate: () => effects.invalidate(),
    async close() {
      mode = "browse"; status = "";
      if (refreshPending) await reload();
      effects.invalidate();
    },
    async open(blockId, destination) {
      if (destination === "detail") {
        mode = "browse";
        if (!await dispatchRecoverable({ kind: "block", blockId }, "open")) return;
      }
      else await selectVisibleBlock(blockId, { recordNavigation: true });
      mode = "browse"; routineNotice(destination === "detail" ? "Opened in Detail" : "Focused selected result");
      if (refreshPending) await reload();
    },
  });

  const inbox = new InboxController({
    actionKeymap,
    clientId: effects.clientId,
    openPreview: openPreviewTarget,
    openExternal: effects.openExternal,
    copyText: effects.copyText,
    request: input => effects.request(input),
    async openResource(resourceId) {
      if (!await dispatchRecoverable({ kind: "resource", resourceId }, "open")) return;
      mode = "browse";
      routineNotice("Pi session opened in Detail");
      if (refreshPending) await reload();
      effects.invalidate();
    },
    invalidate() {
      const cue = inboxStatusCue(inbox.snapshot, inbox.error);
      if (mode === "inbox" || cue !== lastInboxCue) effects.invalidate();
      lastInboxCue = cue;
    },
    async close() {
      mode = "browse";
      status = "";
      if (refreshPending) await reload();
      effects.invalidate();
    },
    async open(blockId, destination) {
      if (destination === "detail") {
        if (!await dispatchRecoverable({kind:"block",blockId},"open")) return;
      } else { await selectVisibleBlock(blockId, { recordNavigation: true, physicalSource: true }); mode = "browse"; }
      routineNotice(destination === "detail" ? "Inbox result opened in Detail" : "Inbox block revealed in Tree");
      if (refreshPending) await reload();
      effects.invalidate();
    },
  });

  function actionScope(): string {
    if(mode==='browse'&&localReader.state?.focused)return 'reader';
    if(mode==='inbox'&&!inbox.searchEditing&&!inbox.steering&&inbox.previewMode==='content'&&inbox.reader.state?.focused)return 'inbox-reader';
    if(mode==="viewer"&&workspaceReport)return "workspace";
    return mode === "inbox" && inbox.searchEditing ? "inbox-search" : mode === "inbox" && inbox.steering ? "inbox-steer" : mode;
  }

  async function handleGotoMouse(sequence: string): Promise<void> {
    if (mode !== "goto") return;
    await routeGotoMouse(goto, sequence, effects.terminalWidth(), effects.terminalHeight());
  }

  let placementDirection: "right" | "down" | null = null;
  let destinationMenu: {state: NavigationLinkState; purpose: "link" | "open"; target?:OutlinerNavigationTarget; recoveryTarget?:OpenDestinationTarget} | null = null;

  const recoveryResolvers=new WeakMap<OpenDestinationTarget,()=>Promise<OutlinerNavigationTarget>>();
  let recoveryOrigin='';
  let navigationGeneration=0;
  let readSequence = 0;
  let lastRead: {origin: string; at: number; destination: OutlinerViewAddress} | null = null;
  function cancelReadSequence(): void { lastRead = null; readSequence++; }
  let closed=false;
  const originKey=()=>JSON.stringify([mode,rows[selectedIndex]?.rowId,mode==='inbox'?inbox.selected?.id:null,mode==='inbox'?inbox.targetIndex:null,mode==='inbox'?inbox.reader.state?.target:localReader.state?.target]);
  async function materializeRecovery(target:OpenDestinationTarget):Promise<OutlinerNavigationTarget>{
    const resolve=recoveryResolvers.get(target);
    if(resolve){target.target=await resolve();recoveryResolvers.delete(target);}
    return target.target;
  }
  const openRecovery=new OpenDestinationChooser({
    beforeOpen:async target=>{
      await materializeRecovery(target);
      if (recoveryOrigin !== originKey()) openRecovery.dismiss();
    },
    replace:async target=>{
      if(mode==='inbox')await inbox.openHere(target.target);
      else {
        previewPreferences={...previewPreferences,enabled:true};
        const generation=navigationGeneration;
        const visited=await localReader.visit(target.target);
        if(visited && !closed && generation===navigationGeneration){
          localReader.focus();
          await effects.request({action:'clients.update',clientId:effects.clientId,previewTarget:target.target});
        }
      }
      status='Opened here in Preview';
    },
    openChosen:async target=>{
      await handleAction('tree.navigation.once');
      if(destinationMenu)destinationMenu.recoveryTarget=target;
      return false;
    },
    openLinked:async target=>{await effects.navigation.dispatch(target.target,'open');return true;},
    openNewDetail: async (target, direction) => {
      if (!effects.createDetailDestination) throw Error("Creating a destination is unavailable in this host");
      const row = rows[selectedIndex];
      const blockId = target.target.kind === "block" ? target.target.blockId : (isBlockTreeRow(row) ? row.canonicalId : undefined);
      if (!blockId) throw Error("Select a block to create a Detail destination");
      const destination = await effects.createDetailDestination(blockId, {kind:"split", direction});
      await effects.navigation.dispatch(target.target, "open", {destination});
    },
    invalidate:()=>effects.invalidate(),
  });
  function offerRecovery(target:OutlinerNavigationTarget,title:string,resolve?:()=>Promise<OutlinerNavigationTarget>):void{
    const request={target,title};if(resolve)recoveryResolvers.set(request,resolve);
    recoveryOrigin=originKey();status='';openRecovery.recover(request);
  }
  async function dispatchRecoverable(target:OutlinerNavigationTarget,intent:OutlinerNavigationIntent,options?:NavigationRouteOptions){
    const origin=originKey(), generation=++navigationGeneration;
    try{return await effects.navigation.dispatch(target,intent,options);}
    catch(error){
      if(intent!=='open'||options?.destination||!missingNavigationDestination(error))throw error;
      if(!closed&&generation===navigationGeneration&&origin===originKey())offerRecovery(target,target.kind==='block'?target.blockId:target.resourceId);
      return undefined;
    }
  }
  async function openPreviewTarget(target:OutlinerNavigationTarget):Promise<void>{await dispatchRecoverable(target,'open');}
  async function handleLink(uri:string):Promise<void>{
    const origin=originKey(), generation=++navigationGeneration;
    openRecovery.dismiss();
    try {
      const opened = await navigateOutlinerLink(effects,uri,{sourceClientId:effects.clientId,navigation:effects.navigation,intent:'open'});
      routineNotice(`${opened.created ? 'Created and opened' : 'Opened'} ${opened.title} in ${effects.navigation.readerLabel}`);
    }
    catch(error){
      if(!missingNavigationDestination(error))throw error;
      if(closed||generation!==navigationGeneration||origin!==originKey())return;
      const reference=parseOutlinerLinkUri(uri);
      const placeholder:OutlinerNavigationTarget=reference.kind==='resource'?{kind:'resource',resourceId:reference.value}:{kind:'block',blockId:reference.value};
      offerRecovery(placeholder,reference.value,async()=>{
        if(reference.kind==='resource')return{kind:'resource',resourceId:reference.value};
        if(reference.kind==='reference'){const followed=await followResourceOccurrence(effects,reference);return{kind:'resource',resourceId:followed.resource.id,referenceContext:followed.referenceContext};}
        const resolved=await resolveOutlinerLinkTarget(effects,reference);
        return{kind:'block',blockId:resolved.block.id,...resolved.fragmentId?{fragmentId:resolved.fragmentId}:{}};
      });
    }
  }

  function selectionRankReason(): string | null {
    const reason = collected.rankReason();
    if (reason) return reason;
    const viewId = collected.current?.targets[0]?.viewId;
    const sort = viewId ? branchStates.get(viewId)?.config?.sort : undefined;
    return sort ? `Virtual branch is sorted by ${sort.field} ${sort.direction}; manual reorder is disabled` : null;
  }

  function selectionMenuItems(): OutlinerActionMenuItem[] {
    const result = actionKeymap.menuItems("tree", "browse").filter(item => item.id.startsWith("tree.selection.") && !["tree.selection.inspect","tree.selection.toggle"].includes(item.id));
    if (placementMenu) {
      if (selectionRankReason()) return [];
      const targets = collected.current?.targets ?? [], first = targets[0];
      const selectedIds = new Set(targets.map(t=>t.blockId));
      return rows.filter((row):row is VirtualBranchOccurrenceRow => isBlockTreeRow(row) && isVirtualBranchRootOccurrence(row)
        && row.viewId === first?.viewId && row.parentRowId === first.parentRowId && !selectedIds.has(row.canonicalId))
        .map(row=>({id:`tree.selection.place:${placementMenu}:${row.canonicalId}`, label:`${placementMenu === "before" ? "Before" : "After"} · ${row.block.preview}`,description:"Place in full branch order, preserving hidden items",binding:"",group:"Edit"}));
    }
    const reason = selectionRankReason();
    for (const item of result) {
      if (item.id.startsWith("tree.selection.move-") && reason) item.description = `Unavailable: ${reason}`;
    }
    for (const target of collected.ordered(rows.map(r=>r.rowId))) {
      const block = physicalBlocksById.get(target.blockId);
      const label = block?.preview ?? target.blockId;
      const availability = !block ? "not in current index" : block.effectiveDeletedRootId ? "in Trash"
        : rows.some(r=>r.rowId===target.rowId) ? "in this view" : "outside this view";
      result.push({id:`tree.selection.read:${target.blockId}`,label:`Read · ${label}`,description:availability,binding:"",group:"Navigate"},
        {id:`tree.selection.remove:${target.blockId}`,label:`Unselect · ${label}`,description:availability,binding:"",group:"Edit"});
    }
    for (const record of collected.recovery?.selections ?? []) {
      result.push({id:`tree.selection.resume:${record.id}`,label:`Recover ${record.targets.length} selected · ${record.updatedAt}`,
        description:(collected.current ? "Clear the current selection before recovering another" : "Resume a retained selection from a closed pane") +
          (collected.recovery.completeness.kind === "truncated" ? "; newest 100 shown, recover and clear sets to reach older ones" : ""),binding:"",group:"View"});
    }
    return result;
  }

  function filteredActionMenuItems(): OutlinerActionMenuItem[] {
    if (selectionMenu) {
      const items = selectionMenuItems();
      const matches = filterActionMenuItems(items, actionMenuQuery);
      // IDs carry identity, but must not outrank a fully typed visible title.
      const exact = items.find(item => item.label.toLowerCase() === actionMenuQuery.trim().toLowerCase());
      return exact ? [exact, ...matches.filter(item => item.id !== exact.id)] : matches;
    }
    if (locationMenu) return filterActionMenuItems(locationMenu, actionMenuQuery);
    if (destinationMenu) return filterActionMenuItems(placementDirection ? navigationPlacementItems(destinationMenu.state) : navigationDestinationItems(destinationMenu.state, destinationMenu.purpose === "link",showOtherDestinations), actionMenuQuery);
    const selected = rows[selectedIndex];
    let items = readerMenuItems(actionKeymap.menuItems("tree", actionMenuScope), actionMenuCategory);
    if (actionMenuScope !== "browse") return filterActionMenuItems(items
      .filter(item => !inbox.attentionOnly || !["tree.inbox.older", "tree.inbox.newer"].includes(item.id))
      .map(item => item.id === "tree.inbox.attention"
      ? { ...item, label: inbox.attentionOnly ? "Show recent results" : `Show needs attention (${inbox.snapshot?.attentionCount ?? 0})` }
      : item), actionMenuQuery);
    if (connectionOwner(selected)) {
      const hiding = connections.isOpen(selected!.rowId);
      items = items.map((item) =>
        item.id === "tree.authored-links.toggle"
          ? { ...item, label: hiding ? "Hide authored links" : "Show authored links" }
          : item
      );
      if (isBlockTreeRow(selected) && isVirtualBranchOccurrence(selected) &&
        (!isVirtualBranchRootOccurrence(selected) || branchStates.get(selected.viewId)?.config?.sort)) {
        items = items.filter(item => item.id !== "tree.reorder.up" && item.id !== "tree.reorder.down");
      }
    }
    if (!isBlockTreeRow(selected)) {
      items = items.filter((item) => {
        if (item.id === "tree.authored-links.toggle") return !!connectionOwner(selected);
        if (GENERATED_ROW_DISABLED_ACTIONS[item.id]) return false;
        if (item.id === "tree.read") {
          return selected?.kind === "authored-link" && authoredLinkCanOpen(selected);
        }
        if (item.id === "tree.disclosure.toggle") {
          return (selected?.kind === "authored-link-header" || selected?.kind === "comment-group") || !!connectionOwner(selected);
        }
        return true;
      });
    }
    return filterActionMenuItems(items, actionMenuQuery);
  }

  function updateDestinationPreview():void {
    const item=filteredActionMenuItems()[actionMenuIndex];
    void destinationPreview.select(destinationMenu?.state.destinations[Number(item?.id.split(":")[1])]);
  }
  function updateActionMenuQuery(query: string): void {
    actionMenuQuery = query;
    actionMenuIndex = 0;
    if(destinationMenu)updateDestinationPreview();
  }

  function quickInputText(): string {
    return quickBuffer.lines[quickBuffer.row] ?? "";
  }

  function inboxHelpText(): string | null {
    if (mode !== "inbox") return null;
    if(actionScope()==='inbox-reader')return actionKeymap.helpText("tree","inbox-reader");
    if(inbox.searchEditing)return "Esc cancel search · Enter browse results · Alt+Enter open Detail\nType to search all history · ↑↓ select";
    if (inbox.steering) return actionKeymap.helpText("tree", "inbox-steer", ["tree.cancel", "tree.inbox.retry.submit"]);
    const main = actionKeymap.helpText("tree", "inbox", [
      "tree.cancel", "tree.inbox.pause", "tree.inbox.tree", "tree.inbox.detail", "tree.inbox.undo", "tree.inbox.reconsider",
    ]);
    const toggle = `${displayActionChord(actionKeymap.primaryBinding("tree.inbox.attention"))} ${inbox.attentionOnly ? "show recent results" : `needs attention (${inbox.snapshot?.attentionCount ?? 0})`}`;
    const navigation = actionKeymap.helpText("tree", "inbox", [
      ...inbox.attentionOnly ? [] : ["tree.inbox.older", "tree.inbox.newer"],
      "tree.inbox.preview.focus", "tree.inbox.preview.source", "tree.inbox.preview.output", "tree.inbox.preview.activity", "tree.inbox.source", "tree.inbox.target", "tree.inbox.up", "tree.inbox.down", "tree.inbox.pageup", "tree.inbox.pagedown",
    ]);
    return `${toggle}  ${main}\n${actionKeymap.helpText("tree", "inbox", ["tree.menu.open"])}  ${navigation}`;
  }

  function breadcrumbs(): Array<TreeRoot & {kind:"physical"|"occurrence"}> {
    const selected=rows[selectedIndex];
    const path: Array<TreeRoot & {kind:"physical"|"occurrence"}> = [];
    let row=fullRowsById.get(isBlockTreeRow(selected) ? selected.rowId : selected?.owner.rowId ?? "");
    const seen=new Set<string>();
    while(row && !seen.has(row.rowId)) {
      seen.add(row.rowId);
      path.unshift({rowId:row.rowId,canonicalId:row.canonicalId,label:row.block.preview,kind:row.kind});
      row=fullRowsById.get(row.kind === "occurrence" ? row.parentRowId : row.block.parentId ?? "");
    }
    return path;
  }

  function view(): TreeView {
    const selectedTargets = collected.current?.targets ?? [];
    const hidden = selectedTargets.filter(t => !rows.some(r => r.rowId === t.rowId)).length;
    return {
      collectedIds: new Set(selectedTargets.map(t => t.blockId)),
      selectionCue: collected.error ? `Selection: ${collected.error}` : selectedTargets.length
        ? `${collected.recovered ? "Recovered · " : ""}${selectedTargets.length} selected${hidden ? ` · ${hidden} outside this view` : ""}${collected.busy ? " · saving…" : ""}` : "",
      recoverableSelections: collected.recovery?.selections.length ?? 0,
      recoverableSelectionsTruncated: collected.recovery?.completeness.kind === "truncated",
      workspaceRoot: effects.workspaceRoot,
      ...(openRecovery.state.active&&recoveryOrigin===originKey()?{recoveryHelp:openRecovery.helpText(),recoveryStatus:openRecovery.state.status}:{}),
      root, scrollStartEntryIndex,
      breadcrumbs:breadcrumbs(),
      indentationMode,
      breadcrumbStart:breadcrumbRowId === rows[selectedIndex]?.rowId ? breadcrumbStart : null,
      rows,
      physicalBlocksById,
      expandedDocuments,
      physicalRowCount,
      occurrenceRowCount,
      workIdPrefix,
      visibleCompleteness,
      workspaceContextBlockId,
      branchStates,
      selectedIndex,
      activeFilter,
      branchFilterCue: branchFilter?.cue,
      mode,
      quickInput: mode === "goto" ? goto.query : quickInputText(),
      quickColumn: quickBuffer.column,
      quickCompletion,
      goto: mode === "goto" ? goto : null,
      inbox: mode === "inbox" ? inbox : null,
      inboxCue: inboxStatusCue(inbox.snapshot, inbox.error),
      localPreview: localReader.state,
      previewPreferences,
      density: effects.density?.() ?? "compact",
      actionMenuCategory,
      navigationDestinationLabel: navigationDisplay.text,
      previewHelp: `${actionKeymap.helpText("tree", "browse", ["tree.preview.focus", "tree.preview.close"])} · drag to copy`,
      viewerLines:displayedViewerLines(),
      viewerPath,
      workspaceReport,viewerStatus,
      viewerHelp: workspaceReport?actionKeymap.helpText("tree","workspace",["tree.viewer.copy","tree.viewer.next-field","tree.cancel"]):undefined,
      viewerOffset:Math.min(viewerOffset,Math.max(0,displayedViewerLines().length-1)),
      expandedBlockOffset,
      status: disconnected ? "Workspace service disconnected; reconnecting…" : status,
      refreshPending,
      attention,
      actionHelpText: mode === "branch-filter" ? "Type to find · Enter browse results · Esc clear · Ctrl+Q close" : inboxHelpText() ?? actionKeymap.helpText("tree", actionScope()),
      actionMenuItems: mode === "action-menu" ? filteredActionMenuItems() : [],
      actionMenuOrigin,
      actionMenuIndex,
      actionMenuQuery,
      ...(destinationMenu && mode === "action-menu" ? {destinationPreview,destinationPurpose:placementDirection ? "place" : destinationMenu.purpose,destinationInstructions:placementDirection ? navigationPlacementStatus(placementDirection) : navigationDestinationStatus(destinationMenu.state,destinationMenu.purpose,showOtherDestinations)}:{}),
    };
  }

  function connectionCollapsed(row:TreeRow):boolean {
    return row.kind==='occurrence'?(row.collapsed || collapsedOccurrenceRowIds.has(row.rowId)):collapsedBlockIds.has(row.canonicalId);
  }
  function composeRows(revealIdentity?: string | null): TreeDisplayRow[] {
    const connected=connections.compose(baseRows,connectionCollapsed);
    const target=revealIdentity ? connected[rowIndexForIdentity(connected,revealIdentity)] : undefined;
    return comments.compose(connected,{revealRowId:target?.rowId,revealAll:Boolean(branchFilter)});
  }
  function recomposeAuthoredRows(preferredRowId?: string): void {
    const previous = rows[selectedIndex];
    rows = composeRows();
    let nextIndex = preferredRowId === undefined
      ? previous ? rows.findIndex((row) => row.rowId === previous.rowId) : -1
      : rows.findIndex((row) => row.rowId === preferredRowId);
    if (nextIndex < 0 && previous) {
      for (const fallbackRowId of authoredLinkFallbackRowIds(previous)) {
        nextIndex = rows.findIndex((row) => row.rowId === fallbackRowId);
        if (nextIndex >= 0) break;
      }
    }
    selectedIndex = Math.max(
      0,
      Math.min(nextIndex >= 0 ? nextIndex : selectedIndex, rows.length - 1),
    );
  }

  function refreshAuthoredLinks(markDirty=true):Promise<void>{
    if(markDirty)connections.invalidate();
    return connections.refresh(()=>rows,()=>physicalBlocksById);
  }

  async function reload(
    preferredRowId?: string | null,
    options?: { exactRowIdOnly?: boolean },
  ): Promise<boolean> {
    const currentSelected = rows[selectedIndex];
    rowsNeedFetch = true;
    const snapshot = await effects.request<TreeIndexSnapshot>({
      action: "tree.index",
      view: activeFilter && !branchFilter
        ? {
            query: { ...parseSearchExpression(activeFilter), limit: 500 },
          }
        : undefined,
    });
    workIdPrefix = snapshot.workIdPrefix ?? null;
    const indexed = new Map(snapshot.blocks.map(block => [block.id, block]));
    const requireEntry = (id: string): TreeIndexBlock => {
      const block = indexed.get(id);
      if (!block) throw new Error(`Tree index is missing canonical entry ${id}`);
      return block;
    };
    const physical = snapshot.physicalBlockIds.map(requireEntry);
    const visible = snapshot.visible.rows.map(row => ({ ...requireEntry(row.id), ...row }));

    const presentation: TreePresentationState = {
      collapsedBlockIds: activeFilter || branchFilter ? uncollapsedPresentationIds : collapsedBlockIds,
      collapsedOccurrenceRowIds: branchFilter ? uncollapsedPresentationIds : collapsedOccurrenceRowIds,
      revealCollapsed: Boolean(branchFilter),
      expandedOccurrenceRowIds,
      multilineExpandedRowIds,
    };
    const projection = await projectVirtualBranches(
      visible,
      physical,
      { members: savedViewMembership(viewId => effects.request<SavedViewReadResult<TreeIndexBlock>>({ action: "views.read", viewId, format: "tree" })) },
      snapshot.virtualOccurrenceRanks,
      presentation,
    );
    // Retain revealed paths until an explicit collapse/reset; resolving attention
    // must not remove the row the reader is currently navigating.
    for (const row of projection.rows) {
      if (!branchFilter && row.kind === "occurrence" && row.attention && row.hasChildren && !row.collapsed) expandedOccurrenceRowIds.add(row.rowId);
    }
    projectionVisible = visible;
    projectionRanks = snapshot.virtualOccurrenceRanks;
    fullRowsById = new Map(projection.rows.map(row=>[row.rowId,row]));
    const rootIndex = root ? projection.rows.findIndex(row => row.rowId === root!.rowId) : -1;
    let scope = projection.rows;
    if(root) {
      const anchor = projection.rows[rootIndex];
      if(!anchor) scope = [];
      else {
        root = {...root,label:anchor.block.preview};
        let end = rootIndex+1;
        while(end<projection.rows.length && projection.rows[end]!.depth>anchor.depth) end++;
        scope = projection.rows.slice(rootIndex,end).map(row=>({...row,depth:row.depth-anchor.depth}));
      }
    }
    if(root && rootIndex < 0) status = "Focused occurrence is no longer visible · return to workspace from actions";
    if (branchFilter) {
      await branchFilter.refresh(projection, effects);
      scope = branchFilter.rows();
    }
    const expanded = new Map(scope.filter(row => row.multilineExpanded).map(row => [row.canonicalId, row.block]));
    const loaded = new Map<string, ExpandedTreeDocument>();
    await Promise.all([...expanded].map(async ([id, entry]) => {
      const retained = indexSequence === snapshot.sequence ? expandedDocuments.get(id) : undefined;
      if (retained?.block.revision === entry.revision) {
        loaded.set(id, retained);
        return;
      }
      const block = await effects.request<Block>({ action: "get", blockId: id });
      if (block.revision !== entry.revision) throw new Error("Block changed while expanding; refresh the Tree");
      const resolved = await effects.request<ResolvedBlockReferences>({ action: "references.resolve", text: block.text });
      loaded.set(id, { block, resolved });
    }));
    expandedDocuments = loaded;
    indexSequence = snapshot.sequence;
    baseRows = scope;
    physicalBlocksById = new Map(physical.map((block) => [block.id, block]));
    connections.reconcile(physicalBlocksById);
    const nextRows=composeRows(preferredRowId ?? (!initialWorkspaceSelectionApplied ? snapshot.selectedBlockId : undefined));
    const serviceSelectedId = snapshot.selectedBlockId;
    let nextIndex = -1;
    if (preferredRowId !== undefined) {
      if (preferredRowId) {
        nextIndex = options?.exactRowIdOnly
          ? nextRows.findIndex((row) => row.rowId === preferredRowId)
          : rowIndexForIdentity(nextRows, preferredRowId);
      }
    } else if (currentSelected) {
      nextIndex = nextRows.findIndex((row) => row.rowId === currentSelected.rowId);
      if (nextIndex < 0) {
        for (const fallbackRowId of authoredLinkFallbackRowIds(currentSelected)) {
          nextIndex = nextRows.findIndex((row) => row.rowId === fallbackRowId);
          if (nextIndex >= 0) break;
        }
      }
    }
    if (
      nextIndex < 0 &&
      preferredRowId === undefined &&
      !initialWorkspaceSelectionApplied &&
      serviceSelectedId
    ) {
      nextIndex = nextRows.findIndex(
        (row) => isBlockTreeRow(row) && row.canonicalId === serviceSelectedId,
      );
    }
    const nextSelectedIndex = Math.max(
      0,
      Math.min(nextIndex >= 0 ? nextIndex : selectedIndex, nextRows.length - 1),
    );
    const nextSelectedRow = nextRows[nextSelectedIndex];
    const selectedRowChanged = currentSelected?.rowId !== nextSelectedRow?.rowId;
    const currentMultilineExpanded = isBlockTreeRow(currentSelected)
      ? currentSelected.multilineExpanded
      : false;
    const nextMultilineExpanded = isBlockTreeRow(nextSelectedRow)
      ? nextSelectedRow.multilineExpanded
      : false;
    if (selectedRowChanged || currentMultilineExpanded !== nextMultilineExpanded) {
      resetExpandedBlockPaging();
    }
    rows = nextRows;
    physicalRowCount = projection.physicalRowCount;
    occurrenceRowCount = projection.occurrenceRowCount;
    visibleCompleteness = snapshot.visible.completeness;
    branchStates = projection.branchStates;
    selectedIndex = nextSelectedIndex;
    const selectedBlock = rows[selectedIndex];
    lastVisibleCanonicalId = isBlockTreeRow(selectedBlock) ? selectedBlock.canonicalId : null;
    initialWorkspaceSelectionApplied = true;
    if (lastVisibleCanonicalId) workspaceContextBlockId = lastVisibleCanonicalId;
    refreshPending = false;
    rowsNeedFetch = false;
    if (connections.needsRefresh) await refreshAuthoredLinks(false);
    return rows.length > 0;
  }

  function applyBranchFilter(): void {
    if (!branchFilter) return;
    branchFilter.query = quickInputText();
    baseRows = branchFilter.rows();
    rows = composeRows();
    selectedIndex = 0;
    scrollStartEntryIndex = 0;
    effects.invalidate();
  }

  async function beginBranchFilter(): Promise<void> {
    const selected = rows[selectedIndex];
    if (!branchFilter) {
      if (!isBlockTreeRow(selected)) { status = "Select a block or virtual branch to filter its descendants"; return; }
      branchFilter = new TreeBranchFilter(selected.rowId, selected.block.preview);
      branchFilterReturn = {root, scroll: scrollStartEntryIndex, collapsed:new Set(collapsedBlockIds), occurrences:new Set(collapsedOccurrenceRowIds), expanded:new Set(expandedOccurrenceRowIds), multiline:new Set(multilineExpandedRowIds), documentOffset:expandedBlockOffset};
    }
    mode = "branch-filter"; status = "";
    quickBuffer = new TextBuffer(branchFilter.query); quickBuffer.moveEnd(); quickCompletion = null;
    await reload(branchFilter.rowId, {exactRowIdOnly:true});
    applyBranchFilter();
  }

  async function clearBranchFilter(): Promise<void> {
    if (!branchFilter) return;
    const origin = branchFilter.rowId, restore = branchFilterReturn;
    branchFilter = null; branchFilterReturn = null;
    mode = "browse"; resetQuickEditor();
    if (restore) {
      root = restore.root;
      for (const [target,saved] of [[collapsedBlockIds,restore.collapsed],[collapsedOccurrenceRowIds,restore.occurrences],[expandedOccurrenceRowIds,restore.expanded],[multilineExpandedRowIds,restore.multiline]] as const) {
        target.clear(); for(const id of saved) target.add(id);
      }
    }
    await reload(origin, {exactRowIdOnly:true});
    if (restore && rows[selectedIndex]?.rowId === origin) {
      scrollStartEntryIndex = restore.scroll;
      expandedBlockOffset = restore.documentOffset;
      expandedPage = null;
    }
    status = rows.some(row=>row.rowId===origin) ? "Branch filter cleared" : "Filter cleared; original occurrence is no longer available";
    await publishDisplayRowSelection(rows[selectedIndex]); effects.invalidate();
  }

  function scrollSelectedExpandedBlock(direction: "pageup" | "pagedown"): void {
    const selected = rows[selectedIndex];
    if (!isBlockTreeRow(selected) || !selected.multilineExpanded) {
      expandedBlockOffset = 0;
      status = isBlockTreeRow(selected)
        ? "Expand the selected block before paging within it"
        : "Generated rows are single-line";
      return;
    }
    if (!expandedPage || expandedPage.rowId !== selected.rowId) {
      status = "Waiting for expanded block layout";
      return;
    }
    const { totalRows, pageSize } = expandedPage;
    const maxOffset = Math.max(0, totalRows - pageSize);
    if (maxOffset === 0) {
      expandedBlockOffset = 0;
      status = `Expanded block fits in ${totalRows} visual row${totalRows === 1 ? "" : "s"}`;
      return;
    }
    const currentOffset = Math.min(expandedBlockOffset, maxOffset);
    expandedBlockOffset = direction === "pageup"
      ? Math.max(0, currentOffset - pageSize)
      : Math.min(maxOffset, currentOffset + pageSize);
    const end = Math.min(totalRows, expandedBlockOffset + pageSize);
    status = `Expanded block rows ${expandedBlockOffset + 1}-${end}/${totalRows}`;
  }

  function resetExpandedBlockPaging(): void {
    expandedBlockOffset = 0;
    if (status.startsWith("Expanded block") || status.startsWith("Expand the selected")) {
      status = "";
    }
  }

  function resetQuickEditor(): void {
    projectedChildDraft = null;
    quickBuffer = new TextBuffer();
    quickEditSource = null;
    quickCompletion = null;
    goto.dispose();
    openRecovery.dispose();
  }


  function moveQuickCompletion(delta: number, wrap = false): void {
    if(mode!=="filter"){completions.move(delta);return;}
    if (!quickCompletion) return;
    const itemCount = quickCompletion.items.length;
    quickCompletion.index = wrap
      ? (quickCompletion.index + delta + itemCount) % itemCount
      : Math.max(0, Math.min(itemCount - 1, quickCompletion.index + delta));
  }

  function updateQuickBuffer(str: string, key: TerminalKey): boolean {
    if((key.ctrl||key.meta)&&key.name==="z")return key.shift?quickBuffer.redo():quickBuffer.undo();
    if(key.ctrl&&key.name==="y")return quickBuffer.redo();
    if(key.meta&&key.name==="a"){quickBuffer.selectAll();return false;}
    switch (key.name) {
      case "backspace":
        quickBuffer.backspace();
        return true;
      case "delete":
        quickBuffer.deleteForward();
        return true;
      case "left":
        quickBuffer.moveLeft();
        return false;
      case "right":
        quickBuffer.moveRight();
        return false;
      case "home":
        quickBuffer.moveHome();
        return false;
      case "end":
        quickBuffer.moveEnd();
        return false;
    }
    if (!isPrintableInput(str, key)) return false;
    quickBuffer.insert(str);
    return true;
  }

  async function beginInput(nextMode: TreeInputMode, initial = ""): Promise<void> {
    if (nextMode === "goto" && effects.openGotoPopup) {
      await effects.openGotoPopup();
      return;
    }
    const selected = rows[selectedIndex];
    if (
      !isBlockTreeRow(selected) &&
      nextMode !== "filter" &&
      nextMode !== "goto"
    ) {
      status = "Generated rows cannot enter block input modes";
      return;
    }
    if (nextMode === "add-child" && selected?.kind === "physical" && selected.collapsed) {
      collapsedBlockIds.delete(selected.canonicalId);
      await reload(selected.rowId);
    }
    if (nextMode === "add-child" && selected?.kind === "occurrence") {
      projectedChildDraft = { parent: selected };
    }
    mode = nextMode;
    if (nextMode === "goto") { goto.start(); return; }
    quickBuffer = new TextBuffer(initial);
    quickBuffer.moveEnd();
    quickCompletion = null;
    effects.invalidate();
  }

  async function commitQuickBlock(): Promise<string | null> {
    const selected = rows[selectedIndex];
    if (!isBlockTreeRow(selected)) {
      if (projectedChildDraft) throw new Error("The selected occurrence is no longer available; draft retained.");
      return null;
    }
    const text = quickInputText();
    if (!text.trim()) return mode === "edit" ? selected.canonicalId : null;

    if (mode === "edit") {
      if (!quickEditSource || quickEditSource.id !== selected.canonicalId) throw new Error("The draft has no matching source revision");
      await effects.request<Block>({
        action: "update",
        blockId: selected.canonicalId,
        text,
        expectedRevision: quickEditSource.revision,
        mutation: TREE_MUTATION,
      });
      return selected.canonicalId;
    }
    if (mode === "add-child" && projectedChildDraft) {
      const draft = projectedChildDraft;
      if (!draft.created) {
        // Refresh bounds and identity at commit, not only when the editor opened.
        await reload(draft.parent.rowId, { exactRowIdOnly: true });
        const current = rows[selectedIndex];
        if (current?.rowId !== draft.parent.rowId || current.kind !== "occurrence") {
          throw new Error("The selected occurrence is no longer available; draft retained. Cancel and reveal source to add there.");
        }
        const placement = await projectedChildPlacement(current, text);
        if ("problem" in placement) throw new Error(placement.problem);
        draft.rowId = placement.rowId;
        const created = await effects.request<Block>({
          action: "create", parentId: draft.parent.canonicalId, text, author: "user",
        });
        draft.created = created;
      }
      if (draft.created.text !== text) {
        draft.created = await effects.request<Block>({
          action: "update", blockId: draft.created.id, expectedRevision: draft.created.revision,
          text, mutation: TREE_MUTATION,
        });
      }
      // Keep the receipt until the move succeeds, so retry cannot create a second child.
      await effects.request({
        action: "move", blockId: draft.created.id, parentId: draft.parent.canonicalId, position: 0,
        mutation: TREE_MUTATION,
      });
      setCollapsed(draft.parent, false);
      return draft.created.id;
    }
    if (mode === "add-child") {
      const branchState = branchStates.get(selected.canonicalId);
      if (branchState) {
        const config = branchState.config;
        if (!config || config.readOnly) {
          throw new Error("Virtual branch is read-only");
        }
        const created = await effects.request<Block>({
          action: "create",
          parentId: config.createParentId,
          text: buildVirtualBranchCreationText(text, config),
          author: "user",
        });
        return created.id;
      }
      const created = await effects.request<Block>({
        action: "create",
        parentId: selected.canonicalId,
        text,
        author: "user",
      });
      await effects.request({
        action: "move",
        mutation: TREE_MUTATION,
        blockId: created.id,
        parentId: selected.canonicalId,
        position: 0,
      });
      return created.id;
    }
    if (mode === "add-sibling") {
      const canonical = await effects.request<Block>({
        action: "get",
        blockId: selected.canonicalId,
      });
      const created = await effects.request<Block>({
        action: "create",
        parentId: canonical.parentId,
        text,
        author: "user",
      });
      await effects.request({
        action: "move",
        mutation: TREE_MUTATION,
        blockId: created.id,
        parentId: canonical.parentId,
        position: canonical.position + 1,
      });
      return created.id;
    }
    return null;
  }

  function navigationEntry(row: TreeDisplayRow | undefined): TreeNavigationEntry | null {
    return isBlockTreeRow(row) ? { rowId: row.rowId, canonicalId: row.canonicalId, root, scrollStartEntryIndex } : null;
  }

  function sameNavigationEntry(
    left: TreeNavigationEntry | null | undefined,
    right: TreeNavigationEntry | null | undefined,
  ): boolean {
    return left?.rowId === right?.rowId && left?.canonicalId === right?.canonicalId && left?.root?.rowId === right?.root?.rowId;
  }

  function recordNavigation(
    source: TreeNavigationEntry | null,
    target: TreeNavigationEntry | null,
  ): void {
    if (!source || !target || sameNavigationEntry(source, target)) return;

    if (!sameNavigationEntry(navigationHistory[navigationIndex], source)) {
      navigationHistory.splice(navigationIndex + 1);
      navigationHistory.push(source);
      navigationIndex = navigationHistory.length - 1;
    } else {
      navigationHistory.splice(navigationIndex + 1);
    }
    navigationHistory.push(target);
    navigationIndex = navigationHistory.length - 1;
    if (navigationHistory.length > MAX_TREE_HISTORY_ENTRIES) {
      const excess = navigationHistory.length - MAX_TREE_HISTORY_ENTRIES;
      navigationHistory.splice(0, excess);
      navigationIndex -= excess;
    }
  }

  async function inspectLocally(target: OutlinerNavigationTarget): Promise<void> {
    if (!previewPreferences.enabled) return;
    if (await localReader.load(target)) {
      try { await effects.request({action:"clients.update",clientId:effects.clientId,previewTarget:target}); }
      catch (error) { status = errorMessage(error); effects.invalidate(); }
    }
  }

  async function drainBrowsingPublications(): Promise<void> {
    while (pendingBrowsingPublication) {
      const desired = pendingBrowsingPublication;
      pendingBrowsingPublication = null;
      const publication = await effects.navigation.publish(desired.target, desired.dispatchPreview, desired.rowId);
      if (!pendingBrowsingPublication) {
        workspaceContextBlockId =
          desired.target?.kind === "block" ? desired.target.blockId : null;
        if (publication.unavailable) {
          status = publication.unavailable;
          browsingPublicationStatus = publication.unavailable;

        } else {
          if (desired.dispatchPreview && desired.target && publication.preview?.targetClientId === effects.clientId && publication.preview.targetRegion === "tree") {
            void inspectLocally(desired.target);
          } else if (localReader.state && publication.preview) {
            if(localReader.clear())await effects.request({action: "clients.update", clientId: effects.clientId, previewTarget: null});
          }
          if (status === browsingPublicationStatus) {
            status = "";
            browsingPublicationStatus = "";
          }
        }
        effects.invalidate();
      }
    }
  }

  function startBrowsingPublicationPump(): Promise<void> {
    if (browsingPublicationPump) return browsingPublicationPump;
    const running = drainBrowsingPublications();
    browsingPublicationPump = running;
    const finish = (): void => {
      if (browsingPublicationPump !== running) return;
      browsingPublicationPump = null;
      if (pendingBrowsingPublication) {
        void startBrowsingPublicationPump().catch((error) => {
          status = errorMessage(error);
          browsingPublicationStatus = status;
          effects.invalidate();
        });
      }
    };
    void running.then(finish, finish);
    return running;
  }

  async function flushBrowsingPublications(): Promise<void> {
    while (browsingPublicationPump) {
      try {
        await browsingPublicationPump;
      } catch {
        // Queued publication reports its own failure; only ordering matters here.
      }
    }
  }

  async function publishBrowsingTarget(
    target: OutlinerNavigationTarget | null,
    dispatchPreview = true,
  ): Promise<void> {
    localReader.cancelLoad();
    pendingBrowsingPublication = { target, dispatchPreview, rowId: rows[selectedIndex]?.rowId ?? null };
    await startBrowsingPublicationPump();
  }

  async function publishBrowsingContext(blockId: string | null): Promise<void> {
    await publishBrowsingTarget(blockId ? { kind: "block", blockId } : null);
  }

  function headerSelectionStatus(row: AuthoredLinkHeaderRow): string {
    if (row.state.kind !== "ready") return row.state.message;
    const details = [`${row.state.entryCount} authored ${row.label}`];
    if (row.state.invalidCount > 0) details.push(`${row.state.invalidCount} invalid`);
    if (row.state.limited) details.push("limited");
    if (row.state.diagnostics[0]) details.push(row.state.diagnostics[0].message);
    return details.join(" · ");
  }

  async function publishDisplayRowSelection(row: TreeDisplayRow | undefined): Promise<void> {
    if (openRecovery.state.active && recoveryOrigin !== originKey()) openRecovery.dismiss();
    if (isBlockTreeRow(row)) {
      lastVisibleCanonicalId = row.canonicalId;
      await publishBrowsingContext(row.canonicalId);
      return;
    }
    lastVisibleCanonicalId = null;
    if (!row) {
      await publishBrowsingTarget(null, false);
      return;
    }
    if (row.kind === "comment-group") {
      status = `${row.threadCount} comment threads in this view · Enter expands or collapses`;
      await publishBrowsingTarget(null, false);
      return;
    }
    if (row.kind === "authored-link-header") {
      status = headerSelectionStatus(row);
      await publishBrowsingTarget(null, false);
      return;
    }
    const target = authoredLinkTarget(row);
    if (target) {
      status = `${row.link.label} selected · Enter opens in Detail`;
      await publishBrowsingTarget(target);
    } else {
      status = authoredLinkUnavailableReason(row) ?? "Authored target is unavailable";
      await publishBrowsingTarget(null, false);
    }
  }

  function queueDisplayRowSelection(row: TreeDisplayRow | undefined): void {
    void publishDisplayRowSelection(row).catch((error) => {
      status = errorMessage(error);
      browsingPublicationStatus = status;
      effects.invalidate();
    });
  }

  async function selectVisibleBlock(
    canonicalId: string | null,
    options?: {
      preferredRowId?: string;
      recordNavigation?: boolean;
      physicalSource?: boolean;
      exactOccurrence?: boolean;
    },
  ): Promise<void> {
    const source = navigationEntry(rows[selectedIndex]);
    let visibilityChanged = false;
    if (options?.physicalSource) root = null;
    if (!canonicalId || !options?.physicalSource) {
      await reload(options?.preferredRowId ?? canonicalId, { exactRowIdOnly: options?.exactOccurrence });
      if (options?.exactOccurrence && rows[selectedIndex]?.rowId !== options.preferredRowId) {
        status = "Child saved, but this projection changed. Reveal source to find it; staying in this view.";
        return;
      }
    }
    const currentSelected = rows[selectedIndex];
    if (
      canonicalId &&
      (options?.physicalSource ||
        !isBlockTreeRow(currentSelected) ||
        currentSelected.canonicalId !== canonicalId)
    ) {
      if (branchFilter) await clearBranchFilter();
      root = null;
      const target = physicalBlocksById.get(canonicalId);
      if (!target) throw new Error(`Block not found: ${canonicalId}`);
      if (activeFilter) {
        activeFilter = "";
        visibilityChanged = true;
      }
      let parentId = target.parentId;
      while (parentId) {
        const parent = physicalBlocksById.get(parentId);
        if (!parent) throw new Error(`Block ancestry is incomplete at ${parentId}`);
        if (collapsedBlockIds.delete(parent.id)) visibilityChanged = true;
        parentId = parent.parentId;
      }
      await reload(canonicalId);
    }
    const selected = rows[selectedIndex];
    const visibleCanonicalId = isBlockTreeRow(selected) ? selected.canonicalId : null;
    if (
      canonicalId &&
      (visibleCanonicalId !== canonicalId || (options?.physicalSource && selected?.kind !== "physical"))
    ) {
      throw new Error(`Block ${canonicalId} could not be revealed`);
    }
    const target = navigationEntry(selected);
    if (options?.recordNavigation) recordNavigation(source, target);
    lastVisibleCanonicalId = visibleCanonicalId;
    await publishBrowsingContext(visibleCanonicalId);
    if (visibilityChanged) status = "Filter cleared or collapsed ancestors expanded to reveal block";
  }

  async function finishInput(): Promise<void> {
    if (mode === "branch-filter") {
      if (refreshPending) await reload();
      mode = "browse"; resetQuickEditor();
      selectedIndex = Math.min(1, rows.length - 1);
      selectedIndex = Math.max(0, selectedIndex);
      await publishDisplayRowSelection(rows[selectedIndex]); effects.invalidate(); return;
    }
    if (mode === "filter") {
      const candidate = quickInputText().trim();
      try {
        parseSearchExpression(candidate);
      } catch (error) {
        quickCompletion = null;
        status = `Invalid filter: ${errorMessage(error)}`;
        effects.invalidate();
        return;
      }
      activeFilter = candidate;
      mode = "browse";
      resetQuickEditor();
      await selectVisibleBlock(null);
      effects.invalidate();
      return;
    }
    if (mode === "purge") {
      const selected = rows[selectedIndex];
      const confirmation = quickInputText().trim();
      mode = "browse";
      resetQuickEditor();
      if (!isBlockTreeRow(selected) || !selected.block.deletedAt) {
        status = "Selected block is not a Trash root";
      } else {
        await effects.request({
          action: "trash.purge",
          blockId: selected.canonicalId,
          confirmation,
        });
        status = "Permanently purged";
        await reload();
        const nextSelected = rows[selectedIndex];
        const visibleCanonicalId = isBlockTreeRow(nextSelected) ? nextSelected.canonicalId : null;
        await publishBrowsingContext(visibleCanonicalId);
      }
      effects.invalidate();
      return;
    }

    const selected = rows[selectedIndex];
    const editingRowId = mode === "edit" ? selected?.rowId : undefined;
    const committedBlockId = await commitQuickBlock();
    const occurrenceRowId = projectedChildRowId();
    const fallbackId = isBlockTreeRow(selected) ? selected.canonicalId : null;
    mode = "browse";
    resetQuickEditor();
    await selectVisibleBlock(committedBlockId ?? fallbackId, {
      preferredRowId: occurrenceRowId ?? editingRowId,
      exactOccurrence: !!occurrenceRowId,
    });
    if (occurrenceRowId && rows[selectedIndex]?.rowId === occurrenceRowId) status = "Added child in this view";
    effects.invalidate();
  }

  async function focusDetailReader(routeOptions: NavigationRouteOptions = {}) {
    const selected = rows[selectedIndex];
    if (!selected) return;
    if (selected.kind === "comment-group") { await handleDisclosure(selected.rowId); return; }
    if (selected.kind === "authored-link-header") {
      status = headerSelectionStatus(selected);
      effects.invalidate();
      return;
    }
    await flushBrowsingPublications();
    if (selected.kind === "authored-link") {
      const activation = authoredLinkActivation(selected);
      if (activation.kind === "unavailable") {
        status = activation.reason;
        effects.invalidate();
        return;
      }
      const origin = originKey(), generation = ++navigationGeneration;
      const resolveTarget = async (): Promise<OutlinerNavigationTarget> => {
        if (activation.kind === "follow-page") {
          const resolved = await resolveOutlinerLinkTarget(effects, {kind: "page", value: activation.address});
          return {kind: "block", blockId: resolved.block.id};
        }
        if (activation.kind === "follow-resource") {
          const receipt = await effects.request<InternResourceReceipt>({action:"resources.follow-authored", reference:activation.reference});
          return {kind:"resource", resourceId:receipt.resource.id};
        }
        return activation.target;
      };
      try {
        await effects.navigation.resolve("open", routeOptions);
        if(closed || generation!==navigationGeneration || origin!==originKey())return;
        const target=await resolveTarget();
        if(closed || generation!==navigationGeneration || origin!==originKey())return;
        const opened = await dispatchRecoverable(target, "open", {...routeOptions, preserveSource:true});
        if (opened) {
          routineNotice(`Authored target opened in ${effects.navigation.readerLabel}`);
          effects.invalidate();
          return opened;
        }
      } catch (error) {
        if (missingNavigationDestination(error) && !routeOptions.destination) {
          if (!closed && generation === navigationGeneration && origin === originKey()) offerRecovery({kind:"block", blockId:selected.owner.blockId}, "Selected authored link", resolveTarget);
        } else status = errorMessage(error);
      }
      effects.invalidate();
      return;
    }
    try {
      const opened = await dispatchRecoverable({
        kind: "block",
        blockId: selected.canonicalId,
      }, "open", routeOptions);
      if (!opened) return;
      routineNotice(`Reader opened in ${effects.navigation.readerLabel}`);
      effects.invalidate();
      return opened;
    } catch (error) {
      status = errorMessage(error);
    }
    effects.invalidate();
  }

  const readOriginKey=()=>JSON.stringify([mode,rows[selectedIndex]?.rowId,mode==='inbox'?inbox.selected?.id:null,mode==='inbox'?inbox.targetIndex:null]);
  async function readSelected(focusImmediately = false): Promise<void> {
    const row = rows[selectedIndex];
    if (row?.kind === "authored-link-header" || row?.kind === "comment-group") { cancelReadSequence(); await handleDisclosure(row.rowId); return; }
    const origin = readOriginKey(), at = Date.now(), sequence = readSequence;
    const previous = lastRead;
    lastRead = null;
    let focusTarget = focusImmediately;
    let destination: OutlinerViewAddress | undefined;
    if (!focusImmediately && previous?.origin === origin && at >= previous.at && at - previous.at <= 1000) {
      try {
        const route = await effects.navigation.resolve("open");
        if (sequence !== readSequence || origin !== readOriginKey()) return;
        destination = {clientId: route.targetClientId, region: route.targetRegion ?? "detail"};
        focusTarget = destination.clientId === previous.destination.clientId && destination.region === previous.destination.region;
      } catch { /* The ordinary Open below owns error and destination recovery. */ }
    }
    if (sequence !== readSequence || origin !== readOriginKey()) return;
    const opened = await focusDetailReader({focusTarget, ...(destination ? {destination} : {})});
    if (opened && sequence === readSequence && origin === readOriginKey() && !focusTarget) {
      lastRead = {origin, at: Date.now(), destination: {clientId: opened.targetClientId, region: opened.targetRegion ?? "detail"}};
      status += ` · Enter again within 1s or ${actionKeymap.primaryBinding("tree.read.focus")} to focus`;
      effects.invalidate();
    }
  }

  async function createLinkedDetail(placement: DetailDestinationPlacement): Promise<void> {
    const selected = rows[selectedIndex];
    const purpose = destinationMenu?.purpose ?? "link";
    const recoveryTarget=destinationMenu?.recoveryTarget;
    let target=destinationMenu?.target;
    const callerMode = destinationMenu ? actionMenuReturnMode : mode;
    const selectedBlockId = isBlockTreeRow(selected) ? selected.canonicalId : undefined;
    destinationMenu = null; placementDirection = null; destinationPreview.clear(); mode = callerMode;
    try {
      if(recoveryTarget)target=await materializeRecovery(recoveryTarget);
      const blockId = target?.kind==="block"?target.blockId:callerMode === "inbox" ? await inbox.resolveContentTarget() : selectedBlockId;
      if (!blockId) throw new Error("Select a block to create a Detail destination");
      if (!effects.createDetailDestination) throw new Error("Creating a destination is unavailable in this host");
      status = "Creating Detail · waiting for the new reader to connect…";
      if (callerMode === "inbox") inbox.notice = status;
      effects.invalidate();
      const destination = await effects.createDetailDestination(blockId, placement);
      if(target)await dispatchRecoverable(target,"open",{destination});
      if (purpose === "link") await effects.request({action: "navigation.link.set", source: {clientId: effects.clientId, region: "tree"}, destination});
      void navigationDisplay.refresh();
      routineNotice(purpose === "link" ? "Linked: Tree → new Detail" : "Opened once in new Detail");
      if (callerMode === "inbox") inbox.notice = status;
    } catch (error) {
      status = errorMessage(error);
      if (callerMode === "inbox") inbox.notice = `${status} · Use Link destination or Open once to retry`;
    }
    effects.invalidate();
  }

  async function createDetailPane(direction: "right" | "down" = "down", targetPaneId?: string): Promise<void> {
    const selected = rows[selectedIndex];
    if (!isBlockTreeRow(selected)) {
      status = "Open authored targets in the existing Detail";
      effects.invalidate();
      return;
    }
    try {
      await effects.createDetailPane(selected.canonicalId, direction, targetPaneId);
      routineNotice(`Opened new independent Detail ${direction} for ${selected.block.preview}`);
    } catch (error) {
      status = errorMessage(error);
    }
    effects.invalidate();
  }

  async function handoffToDetail(): Promise<void> {
    const selected = rows[selectedIndex];
    if (!isBlockTreeRow(selected)) {
      status = "Authored-link rows cannot enter the block editor";
      effects.invalidate();
      return;
    }
    const committedBlockId = await commitQuickBlock();
    if ((mode === "add-child" || mode === "add-sibling") && !committedBlockId) {
      status = "Type a title before opening multiline detail";
      effects.invalidate();
      return;
    }
    const targetId = committedBlockId ?? selected.canonicalId;
    const occurrenceRowId = projectedChildRowId();
    const targetRowId = occurrenceRowId ?? (mode === "edit" ? selected.rowId : undefined);
    mode = "browse";
    resetQuickEditor();
    await selectVisibleBlock(targetId, { preferredRowId: targetRowId, exactOccurrence: !!occurrenceRowId });
    try {
      await effects.navigation.edit(targetId);
      routineNotice(`Multiline editor opened in ${effects.navigation.readerLabel}`);
    } catch (error) {
      status = errorMessage(error);
    }
    effects.invalidate();
  }

  async function openQuickCompletion(): Promise<void> {
    if (mode === "filter") {
      const target = filterCompletionTargetAtCursor(quickInputText(), quickBuffer.column);
      if (!target) {
        status = "Type a valid property key before requesting filter completion";
        return;
      }
      const catalog = await effects.request<PropertyCatalogItem[]>({
        action: "properties.catalog",
        ...(target.kind === "value" ? { key: target.key } : {}),
        prefix: target.prefix,
        limit: target.kind === "value" ? 20 : 100,
      });
      let items: TreeQuickCompletionItem[];
      if (target.kind === "value") {
        items = catalog.map((item) => ({
          label: `${item.value} (${item.count})`,
          insertion: `${target.key}=${serializePropertyFilterValue(item.value)}`,
        }));
      } else {
        const counts = new Map<string, number>();
        for (const item of catalog) counts.set(item.key, (counts.get(item.key) ?? 0) + item.count);
        items = [...counts]
          .sort(([leftKey, leftCount], [rightKey, rightCount]) =>
            rightCount - leftCount || leftKey.localeCompare(rightKey)
          )
          .map(([key, count]) => ({
            label: `${key} (${count})`,
            insertion: `${key}=`,
          }));
      }
      if (items.length === 0) {
        quickCompletion = null;
        status = target.kind === "value"
          ? `No matching values for ${target.key}`
          : "No matching property keys";
        return;
      }
      quickCompletion = {
        start: target.start,
        end: target.end,
        index: 0,
        items,
        truncatedLimit: null,
      };
      status = "";
      return;
    }
    await completions.refresh();
  }

  async function applyQuickCompletion(): Promise<void> {
    if(mode!=="filter"){await completions.accept();return;}
    if (!quickCompletion) return;
    const item = quickCompletion.items[quickCompletion.index];
    if(!item)return;
    quickBuffer.replaceCurrentLine(quickCompletion.start, quickCompletion.end, item.insertion);
    quickCompletion = null;
  }

  async function openReferencedFile(block: Pick<Block, "properties">): Promise<void> {
    const rowId = rows[selectedIndex]?.rowId;
    const path = getProperty(block.properties, "file");
    if (!path) {
      status = "Selected block has no [file::path] property";
      return;
    }
    mode = "viewer";
    viewerLines = [];
    viewerPath = path;
    viewerWrap=false;workspaceReport=null;viewerStatus="";
    viewerOffset = 0;
    status = "Loading file…";
    effects.invalidate();
    try {
      const contents = await effects.request<FileContents>({ action: "files.read", path });
      if (mode !== "viewer" || rows[selectedIndex]?.rowId !== rowId) return;
      const file = referencedFilePreview(block, contents);
      viewerLines = file.lines;
      viewerPath = `${file.displayPath}${file.firstLine > 1 ? `:${file.firstLine}` : ""}`;
      viewerOffset = 0;
      mode = "viewer";
      status = "";
    } catch (error) {
      if (mode !== "viewer" || rows[selectedIndex]?.rowId !== rowId) return;
      mode = "browse";
      status = errorMessage(error);
    }
  }

  async function indent(selected: PhysicalTreeRow): Promise<void> {
    for (let index = selectedIndex - 1; index >= 0; index--) {
      const candidate = rows[index];
      if (candidate.depth < selected.depth) break;
      if (
        candidate.kind === "physical" &&
        candidate.depth === selected.depth &&
        candidate.block.parentId === selected.block.parentId
      ) {
        await effects.request({
          action: "move",
          mutation: TREE_MUTATION,
          blockId: selected.canonicalId,
          parentId: candidate.canonicalId,
        });
        return;
      }
    }
    status = "No previous sibling to indent beneath";
  }

  async function outdent(selected: PhysicalTreeRow): Promise<void> {
    const canonical = await effects.request<Block>({
      action: "get",
      blockId: selected.canonicalId,
    });
    if (!canonical.parentId) return;
    const parent = await effects.request<Block>({ action: "get", blockId: canonical.parentId });
    await effects.request({
      action: "move",
      mutation: TREE_MUTATION,
      blockId: canonical.id,
      parentId: parent.parentId,
      position: parent.position + 1,
    });
  }

  async function moveSibling(selected: PhysicalTreeRow, offset: -1 | 1): Promise<string> {
    const canonical = await effects.request<Block>({
      action: "get",
      blockId: selected.canonicalId,
    });
    const siblings = await effects.request<Block[]>({
      action: "children",
      parentId: canonical.parentId,
    });
    const currentIndex = siblings.findIndex((sibling) => sibling.id === canonical.id);
    const targetIndex = currentIndex + offset;
    if (currentIndex < 0 || targetIndex < 0) {
      status = "Already first sibling";
    } else if (targetIndex >= siblings.length) {
      status = "Already last sibling";
    } else {
      await effects.request({
        action: "move",
        mutation: TREE_MUTATION,
        blockId: canonical.id,
        parentId: canonical.parentId,
        position: targetIndex,
      });
      status = offset < 0 ? "Moved up among siblings" : "Moved down among siblings";
    }
    return canonical.id;
  }

  async function moveOccurrenceSibling(
    selected: VirtualBranchOccurrenceRow,
    offset: -1 | 1,
  ): Promise<string | null> {
    const sort = branchStates.get(selected.viewId)?.config?.sort;
    if (sort) {
      status = `Virtual branch is sorted by ${sort.field} ${sort.direction}; manual reorder is disabled`;
      return null;
    }
    if (branchFilter) {
      const expected = await effects.request<import("./types").VirtualBranchOrder>({action:"virtual.occurrences.order",viewId:selected.viewId});
      await effects.request({action:"virtual.occurrences.place",input:{expected,selectedBlockIds:[selected.canonicalId],placement:{kind:offset<0?"up":"down"}}});
      status = "Moved one position in full branch order (including hidden items)"; return selected.rowId;
    }
    const branchRows = rows.filter(
      (row): row is VirtualBranchOccurrenceRow =>
        isBlockTreeRow(row) &&
        isVirtualBranchRootOccurrence(row) &&
        row.viewId === selected.viewId &&
        row.parentRowId === selected.parentRowId,
    );
    const currentIndex = branchRows.findIndex((row) => row.rowId === selected.rowId);
    const targetIndex = currentIndex + offset;
    if (currentIndex < 0 || targetIndex < 0) {
      status = "Already first in virtual branch; canonical order unchanged";
      return null;
    }
    if (targetIndex >= branchRows.length) {
      status = "Already last in virtual branch; canonical order unchanged";
      return null;
    }

    const orderedBlockIds = branchRows.map((row) => row.canonicalId);
    [orderedBlockIds[currentIndex], orderedBlockIds[targetIndex]] = [
      orderedBlockIds[targetIndex]!,
      orderedBlockIds[currentIndex]!,
    ];
    await effects.request({
      action: "virtual.occurrences.reorder",
      viewId: selected.viewId,
      orderedBlockIds,
    });
    status = offset < 0
      ? "Moved up within virtual branch; canonical order unchanged"
      : "Moved down within virtual branch; canonical order unchanged";
    return selected.rowId;
  }

  function projectedChildRowId(): string | undefined {
    const draft = projectedChildDraft;
    return draft?.created ? draft.rowId?.(draft.created.id) : undefined;
  }

  async function projectedChildPlacement(selected: VirtualBranchOccurrenceRow, text = "") {
    if (selected.block.effectiveDeletedRootId) return { problem: "Cannot add a child in Trash; restore the parent first." };
    const parent = physicalBlocksById.get(selected.canonicalId);
    if (!parent) return { problem: "The canonical parent is no longer available" };
    const child: TreeIndexBlock = {
      ...parent, id: crypto.randomUUID(), parentId: parent.id, position: 0,
      depth: parent.depth + 1, hasChildren: false, properties: parseProperties(text),
    };
    return planVirtualChild(selected, child, projectionVisible, [...physicalBlocksById.values()],
      query => effects.request<TreeIndexCollection>({ action: "tree.query", query }),
      projectionRanks, { collapsedBlockIds: activeFilter ? uncollapsedPresentationIds : collapsedBlockIds, collapsedOccurrenceRowIds, expandedOccurrenceRowIds, multilineExpandedRowIds });
  }

  function occurrenceMutationDisabled(action: string): void {
    status = `Virtual occurrence ${action} is disabled; canonical hierarchy unchanged`;
  }

  function virtualBranchCreationProblem(selected: PhysicalTreeRow): string | null {
    const state = branchStates.get(selected.canonicalId);
    if (!state) return null;
    if (state.configurationErrors.length > 0) {
      return `Virtual branch is invalid: ${state.configurationErrors.join("; ")}`;
    }
    if (!state.config || state.config.readOnly) {
      const reason = state.creationErrors.join("; ");
      return reason
        ? `Virtual branch is read-only: ${reason}`
        : "Virtual branch is read-only: configure create and create-parent";
    }
    return null;
  }

  async function handleServiceEvent(event: OutlinerEvent): Promise<void> {
    if (event.domain === "content" ||
        (event.domain === "ui" && event.command?.targetClientId === effects.clientId && event.command.targetRegion !== "detail" && ["focus", "reveal"].includes(event.command.command)) ||
        (event.domain === "view" && event.action === "navigation.link.set")) cancelReadSequence();
    navigationDisplay.onEvent(event);
    if (event.domain === "view" && (event.action === "navigation.link.set" || event.action.startsWith("clients."))) return;
    if (event.domain === "inbox") {
      // Progress must not queue provider/status round trips ahead of keyboard input.
      void inbox.refresh();
      return;
    }
    if (event.domain === "attention") {
      if (!event.attention || event.attention.targetClientId !== effects.clientId) return;
      attention = event.attention;
      const instruction = event.attentionInstruction;
      const mark = instruction
        ? attention.marks.find((candidate) => candidate.markId === instruction.markId)
        : undefined;
      if (mark && instruction?.reveal) {
        await selectVisibleBlock(mark.target.sourceBlockId, { recordNavigation: true });
        status = mark.sourceState === "stale"
          ? "Attention source changed; mark is stale"
          : `Attention · ${mark.tone} · ${mark.target.sourceBlockId.slice(0, 8)}`;
      }
      if (instruction?.focus) effects.focusSelf();
      effects.invalidate();
      return;
    }
    if (event.domain === "ui") {
      const command = event.command;
      if (!command || command.targetClientId !== effects.clientId) return;
      // The publication pump owns these previews and rejects obsolete selections.
      // Its echoed UI event must not restart the read or restore an older target.
      if (command.command === "preview" && event.action === "browsing-context.publish") return;
      if (mode !== "browse") {
        refreshPending = true;
        return;
      }
      if (command.command === "preview") {
        void inspectLocally(command.target);
        return;
      }
      if ("target" in command && command.target?.kind === "block") {
        await selectVisibleBlock(command.target.blockId, {
          recordNavigation: true,
          physicalSource: command.command === "reveal",
        });
      }
      if (command.command === "focus" || ("focus" in command && command.focus)) effects.focusSelf();
      effects.invalidate();
      return;
    }
    if (event.domain === "browsing-context") {
      if (event.contextId !== effects.browsingContextId) return;
      workspaceContextBlockId = event.blockId ?? null;
      effects.invalidate();
      return;
    }
    if (event.domain === "resource-catalog") {
      if (connections.active) await refreshAuthoredLinks();
      effects.invalidate();
      return;
    }
    if (event.domain === "selection" || event.domain === "mentions") return;
    inbox.contentChanged();
    if (connections.active) connections.invalidate();
    // Every outline change advances the sequence. A change at or before the loaded
    // index is already reflected, e.g. the echo of this Tree's own edit or the
    // tail of a burst that an earlier reload already read.
    const indexed = indexSequence !== null && event.sequence <= indexSequence;
    if (indexed) {
      if (mode === "browse" || mode === "branch-filter") {
        if (connections.needsRefresh) await refreshAuthoredLinks(false);
        if (event.domain === "content") await localReader.refreshContent();
      }
      effects.invalidate();
      return;
    }
    if (mode !== "browse" && mode !== "branch-filter") {
      refreshPending = true;
      return;
    }
    const previousRow = rows[selectedIndex];
    await reload();
    if(event.domain==='content')await localReader.refreshContent();
    if (previousRow && !rows.some((row) => row.rowId === previousRow.rowId)) {
      if (branchFilter) status = `${isBlockTreeRow(previousRow) ? previousRow.block.preview : "Previous item"} is no longer in these results; branch refreshed`;
      await publishDisplayRowSelection(rows[selectedIndex]);
    }
    effects.invalidate();
  }

  async function navigateTreeHistory(direction: "back" | "forward"): Promise<void> {
    const targetIndex = navigationIndex + (direction === "back" ? -1 : 1);
    const target = navigationHistory[targetIndex];
    if (!target) {
      status = "No further navigation history";
      return;
    }

    let canonical: Block;
    try {
      canonical = await effects.request<Block>({
        action: "get",
        blockId: target.canonicalId,
      });
    } catch {
      status = "Navigation target no longer exists";
      return;
    }
    navigationIndex = targetIndex;
    if (canonical.effectiveDeletedRootId) {
      await flushBrowsingPublications();
      await dispatchRecoverable({kind: "block", blockId: canonical.id}, "open");
      status = `Navigation history opened deleted block read-only in ${effects.navigation.readerLabel}`;
      return;
    }

    if (branchFilter) await clearBranchFilter();
    root = target.root;
    if(root) {
      await reload(target.rowId,{exactRowIdOnly:true});
      await publishDisplayRowSelection(rows[selectedIndex]);
    } else await selectVisibleBlock(canonical.id, { preferredRowId: target.rowId });
    scrollStartEntryIndex = target.scrollStartEntryIndex;
    status = direction === "back" ? "Navigation back" : "Navigation forward";
  }

  async function handleConnect(): Promise<void> {
    disconnected = false;
    cancelReadSequence();
    void navigationDisplay.refresh();
    resetExpandedBlockPaging();
    status = "";
    attention = await effects.request<AttentionClientState>({
      action: "attention.get",
      targetClientId: effects.clientId,
    });
    await inbox.refresh();
    const service = await observeService();
    if (mode === "browse") {
      const missed = rowsNeedFetch ? "outline" : await changesSince(indexSequence, service);
      if (missed === "outline") {
        if (connections.active) connections.invalidate();
        await reload();
      } else if (missed === "resource-catalog" && connections.active) {
        await refreshAuthoredLinks();
      }
      await publishDisplayRowSelection(rows[selectedIndex]);
    } else {
      refreshPending = true;
      inbox.contentChanged();
      if (connections.active) connections.invalidate();
    }
    effects.invalidate();
  }

  function databaseIdentity(service: OutlinerServiceStatus | undefined): string | null {
    const location = service?.location;
    return location ? JSON.stringify([location.hostname, location.workspaceRoot, location.database]) : null;
  }

  /**
   * Pings the service and records which database it uses. Returns the status
   * with whether that database is the one the loaded rows came from; a failed
   * ping or an unreported location counts as a different database.
   */
  async function observeService(): Promise<{ status: OutlinerServiceStatus; sameDatabase: boolean } | null> {
    let status: OutlinerServiceStatus;
    try {
      status = await effects.request<OutlinerServiceStatus>({ action: "ping" });
    } catch {
      serviceDatabase = null;
      return null;
    }
    const identity = databaseIdentity(status);
    const sameDatabase = identity !== null && identity === serviceDatabase;
    serviceDatabase = identity;
    return { status, sameDatabase };
  }

  /**
   * Asks the change feed what a reconnect missed; any doubt means `outline`.
   * The feed hides sequence advances that change no outline content (Resource
   * catalog bookkeeping), so a later sequence with no visible change is one.
   * A sequence only means something within one database, so a service now
   * using a different database, or one that did not answer `ping`, is not
   * asked. Neither is a service without the `changes.since` capability; like
   * a failed request, each falls back to a full reload.
   */
  async function changesSince(
    sequence: number | null,
    service: { status: OutlinerServiceStatus; sameDatabase: boolean } | null,
  ): Promise<"outline" | "resource-catalog" | "none"> {
    if (sequence === null || !service?.sameDatabase) return "outline";
    try {
      if (checkServiceCompatibility(service.status, ["changes.since"])) return "outline";
      const page = await effects.request<ChangeFeedPage>({ action: "changes.since", sequence, limit: 1 });
      if (page.kind === "reset" || page.changes.length > 0) return "outline";
      return page.sequence > sequence ? "resource-catalog" : "none";
    } catch {
      return "outline";
    }
  }

  function handleDisconnect(): void {
    disconnected = true; clearTimeout(noticeTimer);
    cancelReadSequence();
    status = "Workspace service disconnected; reconnecting…";
    inbox.disconnected();
    effects.invalidate();
  }

  function handleError(error: unknown): void {
    clearTimeout(noticeTimer);
    status = errorMessage(error);
    effects.invalidate();
  }

  async function navigateSelectedReference(
    selected: TreeRow,
    intent: OutlinerNavigationIntent,
  ): Promise<void> {
    await flushBrowsingPublications();
    const source = await effects.request<Block>({ action: "get", blockId: selected.canonicalId });
    const reference = firstOutlinerReference(source.text, workIdPrefix);
    if (!reference) {
      status = "Selected block has no block or page references";
      return;
    }
    if (intent === "open") {
      await handleLink(outlinerLinkUri(reference.kind, reference.value, reference));
      return;
    }
    const resolved = await resolveOutlinerLinkTarget(effects, reference);
    const dispatched = await dispatchRecoverable({
        kind: "block",
        blockId: resolved.block.id,
        ...(resolved.fragmentId ? { fragmentId: resolved.fragmentId } : {}),
      }, intent, {focusTarget: intent === "reveal"});
    status = `Revealed ${blockDisplayTitle(resolved.block)} · ${dispatched?.resolution ?? "unavailable"}`;
  }

  function setCollapsed(row: TreeRow, collapsed: boolean): void {
    const ids = row.kind === "occurrence" ? collapsedOccurrenceRowIds : collapsedBlockIds;
    const id = row.kind === "occurrence" ? row.rowId : row.canonicalId;
    if(collapsed) ids.add(id); else ids.delete(id);
    if(row.kind === "occurrence"){if(collapsed)expandedOccurrenceRowIds.delete(id);else expandedOccurrenceRowIds.add(id);}
  }

  async function changeDepth(expand: boolean): Promise<void> {
    const selected = rows[selectedIndex];
    if(!isBlockTreeRow(selected)) return;
    const branch = () => {
      const index = rows.findIndex(row => row.rowId === selected.rowId);
      const result: TreeRow[] = [];
      for(let i=index; i>=0 && i<rows.length; i++) {
        const row=rows[i]!;
        if(i>index && row.depth<=selected.depth) break;
        if(isBlockTreeRow(row)) result.push(row);
      }
      return result;
    };
    const previouslyVisible = new Set(branch().map(row=>row.rowId));
    const candidates = branch().filter(row=>row.hasChildren && row.collapsed === expand);
    if(!candidates.length) return;
    const depth = expand ? Math.min(...candidates.map(row=>row.depth)) : Math.max(...candidates.map(row=>row.depth));
    for(const row of candidates) if(row.depth === depth) setCollapsed(row,!expand);
    await reload(selected.rowId,{exactRowIdOnly:true});
    if(expand) {
      // A newly exposed child starts closed even if it was expanded before hiding.
      for(const row of branch()) if(row.depth === depth+1 && row.hasChildren && !previouslyVisible.has(row.rowId)) setCollapsed(row,true);
      await reload(selected.rowId,{exactRowIdOnly:true});
    }
    status = expand ? "Expanded one layer" : "Collapsed one layer";
  }

  async function focusRoot(next: TreeRoot | null): Promise<void> {
    if (branchFilter) await clearBranchFilter();
    const source = navigationEntry(rows[selectedIndex]);
    root = next;
    scrollStartEntryIndex = 0;
    await reload(next?.rowId ?? source?.rowId);
    recordNavigation(source,navigationEntry(rows[selectedIndex]));
    await publishDisplayRowSelection(rows[selectedIndex]);
    status = next ? `Focused branch: ${next.label}` : "Workspace Tree";
  }

  async function handleDisclosure(rowId: string): Promise<void> {
    cancelReadSequence();
    const rowIndex = rows.findIndex((row) => row.rowId === rowId);
    const row = rows[rowIndex];
    if (!row) return;
    selectedIndex = rowIndex;
    if (row.kind === "comment-group") {
      if (branchFilter) { status = "Clear the branch filter to change expansion"; effects.invalidate(); return; }
      comments.toggle(row);
      recomposeAuthoredRows(row.rowId);
      await publishDisplayRowSelection(rows[selectedIndex]);
      effects.invalidate();
      return;
    }
    if (row.kind === "authored-link-header") {
      connections.toggleGroup(row);
      recomposeAuthoredRows(row.rowId);
      await refreshAuthoredLinks(false);
      await publishDisplayRowSelection(rows[selectedIndex]);
      effects.invalidate();
      return;
    }
    if(row.kind==='authored-link' && connectionOwner(row)) {
      connections.toggle(row);recomposeAuthoredRows(row.rowId);effects.invalidate();
      await refreshAuthoredLinks(false);
      await publishDisplayRowSelection(rows[selectedIndex]);return;
    }
    if (!isBlockTreeRow(row) || !row.hasChildren) return;
    if (branchFilter) { status = "Clear the branch filter to change expansion"; effects.invalidate(); return; }
    if (isVirtualBranchOccurrence(row)) {
      setCollapsed(row,!row.collapsed);
    } else if (!collapsedBlockIds.delete(row.canonicalId)) {
      collapsedBlockIds.add(row.canonicalId);
    }
    await reload(row.rowId, { exactRowIdOnly: true });
    await publishDisplayRowSelection(rows[selectedIndex]);
    effects.invalidate();
  }

  async function handleRowClick(rowId: string, activate = false): Promise<void> {
    cancelReadSequence();
    if (mode !== "browse") return;
    navigationGeneration++;
    const rowIndex = rows.findIndex((row) => row.rowId === rowId);
    if (rowIndex < 0) return;
    if (rows[selectedIndex]?.rowId !== rowId) resetExpandedBlockPaging();
    selectedIndex = rowIndex;
    await publishDisplayRowSelection(rows[selectedIndex]);
    effects.invalidate();
    if (activate) await focusDetailReader();
  }

  function focusLocalPreview(focused = true):void {if(mode === "inbox") inbox.focusReader(focused); else localReader.focus(focused);}
  function scrollLocalPreview(delta:number):void {
    if(mode === "inbox") { inbox.scrollPreview(delta); return; }
    if(!localReader.state)return;
    const frame=treePreviewFrame(localReader.state,effects.terminalWidth(),effects.terminalHeight(),"",previewPreferences,effects.density?.() ?? "compact");
    localReader.scroll(delta,frame.content.width,frame.content.height);
  }
  function resizeLocalPreview(fraction: number): void {
    if (!localReader.state || !Number.isFinite(fraction)) return;
    const frame = treePreviewFrame(localReader.state,effects.terminalWidth(),effects.terminalHeight(),"",previewPreferences,effects.density?.() ?? "compact");
    const key = frame.placement === 'beside' ? 'sideFraction' : 'bottomFraction';
    previewPreferences = {...previewPreferences, [key]: Math.max(.2, Math.min(.8, fraction))};
    effects.invalidate();
  }
  function copyViewerText(text: string, kind: "Value" | "Selection"): void {
    try {
      if (!effects.copyText) throw Error("Clipboard output is unavailable in this host");
      effects.copyText(text);
      viewerStatus = `${kind} sent to terminal clipboard`;
    } catch (error) {
      viewerStatus = errorMessage(error);
    }
    effects.invalidate();
  }

  async function handleAction(
    actionId: string,
    origin?: { column: number; row: number },
  ): Promise<void> {
    if (actionId !== "tree.read") cancelReadSequence();
    if (actionId === "tree.filter" || actionId === "tree.filter.clear" || actionId === "tree.filter.properties") {
      const activeMode = mode === "action-menu" ? actionMenuReturnMode : mode;
      if (activeMode !== "browse" && activeMode !== "branch-filter") { status = "Finish or cancel the active draft before changing filters"; effects.invalidate(); return; }
      if (mode === "action-menu") mode = actionMenuReturnMode;
      if (actionId === "tree.filter.clear") await clearBranchFilter();
      else if (actionId === "tree.filter.properties") { await clearBranchFilter(); await beginInput("filter", activeFilter); }
      else await beginBranchFilter();
      effects.invalidate(); return;
    }
    if (actionId.startsWith("tree.selection.place:")) {
      if ((mode === "action-menu" ? actionMenuReturnMode : mode) !== "browse") return;
      const reason = selectionRankReason();
      if (reason) { mode = "browse"; selectionMenu = false; placementMenu = null; status = reason; effects.invalidate(); return; }
      const [kind, anchorBlockId] = actionId.slice("tree.selection.place:".length).split(":");
      mode = "browse"; selectionMenu = false; placementMenu = null;
      try { if ((kind !== "before" && kind !== "after") || !anchorBlockId) throw Error("Invalid placement");
        await collected.rank({kind, anchorId:anchorBlockId}); await reload();
        status = `Moved selected ${kind} anchor in full branch order`;
      } catch(error) { status = errorMessage(error); }
      effects.invalidate(); return;
    }
    if (actionId.startsWith("tree.selection.")) {
      const activeMode = mode === "action-menu" ? actionMenuReturnMode : mode;
      if (activeMode !== "browse") return;
      status = "";
      const origin = rows[selectedIndex]?.rowId;
      try {
        if (actionId === "tree.selection.inspect") {
          const generation = ++navigationGeneration;
          await collected.refresh();
          if (closed || generation !== navigationGeneration) return;
          if ((mode === "action-menu" ? actionMenuReturnMode : mode) !== "browse") return;
          placementMenu = null; selectionMenu = true; locationMenu = null; destinationMenu = null;
          actionMenuReturnMode = "browse"; actionMenuScope = "browse"; mode = "action-menu";
          updateActionMenuQuery(""); effects.invalidate(); return;
        }
        selectionMenu = false;
        if (mode === "action-menu") mode = "browse";
        const rowId = actionId.startsWith("tree.selection.toggle:") ? decodeURIComponent(actionId.slice("tree.selection.toggle:".length)) : origin;
        if (actionId === "tree.selection.toggle" || actionId.startsWith("tree.selection.toggle:")) {
          const row = rows.find(r => r.rowId === rowId);
          if (!isBlockTreeRow(row)) throw Error("Select a block row to collect it");
          await collected.toggle({blockId:row.canonicalId,rowId:row.rowId,
            ...(row.kind === "occurrence" ? {viewId:row.viewId,parentRowId:row.parentRowId,rankRoot:isVirtualBranchRootOccurrence(row)} : {})}, rows.map(r=>r.rowId));
        } else if (actionId === "tree.selection.clear") {
          await collected.clear(); routineNotice("Selection cleared");
        } else if (actionId.startsWith("tree.selection.resume:")) {
          await collected.resume(actionId.slice("tree.selection.resume:".length));
        } else if (actionId.startsWith("tree.selection.read:")) {
          const id = actionId.slice("tree.selection.read:".length);
          if (!collected.current?.targets.some(t=>t.blockId===id)) throw Error("Item is no longer in the selection");
          previewPreferences = {...previewPreferences, enabled:true};
          await inspectLocally({kind:"block",blockId:id});
        } else if (actionId.startsWith("tree.selection.remove:")) {
          const target = collected.current?.targets.find(t=>t.blockId===actionId.slice("tree.selection.remove:".length));
          if (target) await collected.toggle(target,rows.map(r=>r.rowId));
        } else if (actionId.startsWith("tree.selection.move-")) {
          const kind = actionId.slice("tree.selection.move-".length);
          if (kind === "before" || kind === "after") {
            const reason = selectionRankReason(); if (reason) throw Error(reason);
            await reload(origin);
            const refreshedReason = selectionRankReason(); if (refreshedReason) throw Error(refreshedReason);
            placementMenu = kind; selectionMenu = true; locationMenu = null; destinationMenu = null;
            actionMenuReturnMode = "browse"; mode = "action-menu"; updateActionMenuQuery(""); effects.invalidate(); return;
          }
          if (!["up","down","top","bottom"].includes(kind)) return;
          await collected.rank({kind:kind as "up"|"down"|"top"|"bottom"});
          await reload(origin); routineNotice(`Moved selected ${kind} in full branch order${branchFilter ? " (including hidden items)" : ""}`);
        } else if (actionId.startsWith("tree.selection.copy-")) {
          const kind = actionId.slice("tree.selection.copy-".length);
          if (!["ids","references","pages"].includes(kind)) return;
          if (!effects.copyText) throw Error("Clipboard output is unavailable in this host");
          effects.copyText(await collected.copy(kind as "ids"|"references"|"pages",rows.map(r=>r.rowId)));
          routineNotice(`Selected ${kind === "ids" ? "block IDs" : kind === "pages" ? "page links" : "block references"} sent to terminal clipboard`);
        }
      } catch (error) { status = errorMessage(error); }
      effects.invalidate(); return;
    }
    if (actionId === "tree.property.inspect") {
      if (mode === "action-menu") mode = actionMenuReturnMode;
      const selected = rows[selectedIndex];
      if (!isBlockTreeRow(selected)) { status = "Select a block to inspect properties"; }
      else if (!effects.inspectProperties) status = "Property pane unavailable in this host";
      else await effects.inspectProperties(selected.canonicalId);
      effects.invalidate(); return;
    }
    if (actionId === "tree.view.inspect") {
      const selected = rows[selectedIndex];
      const branch = isBlockTreeRow(selected) ? branchStates.get(selected.kind === "occurrence" ? selected.viewId : selected.canonicalId) : undefined;
      viewerPath = "View status"; viewerOffset = 0; viewerWrap = true; workspaceReport = null;
      viewerLines = [effects.workspaceRoot, `${physicalRowCount} physical blocks · ${occurrenceRowCount} projected occurrences`,
        inboxStatusCue(inbox.snapshot, inbox.error), `Opens in: ${navigationDisplay.text}`,
        `Filter: ${activeFilter || "none"}`, ...branch ? [
          "", "Virtual branch",
          `Query: ${branch.config?.query || "not configured"}`,
          `Matches: ${branch.count} · descendants: ${branch.descendantCount}`,
          `Children depth: ${branch.config?.childDepth ?? "default"}`,
          `Initially expanded: ${branch.config?.expanded ?? "default"}`,
          `Truncated: ${Object.entries(branch.truncation).filter(([,active]) => active).map(([name]) => name).join(", ") || "no"}`,
          ...branch.configurationErrors, ...branch.creationErrors,
          ...branch.queryError ? [`Query error: ${branch.queryError}`] : [],
        ] : []].map(line => sanitizeDynamicText(line));
      mode = "viewer"; effects.invalidate(); return;
    }
    if (actionId.startsWith("tree.density.")) {
      const density = actionId.slice("tree.density.".length);
      if (density !== "compact" && density !== "expanded") return;
      try { effects.setDensity?.(density); if (mode === "action-menu") mode = actionMenuReturnMode; }
      catch (error) { status = errorMessage(error); }
      effects.invalidate(); return;
    }
    if (actionId === "tree.location") {
      await handleAction("tree.menu.open");
      locationMenu = (view().breadcrumbs ?? []).map(part => ({
        id: `tree.breadcrumb.focus:${encodeURIComponent(part.rowId)}`, label: part.label, description: "Go to this ancestor", binding: "", group: "Navigate",
      }));
      locationMenu.unshift({id: "tree.root.workspace", label: "Workspace", description: effects.workspaceRoot, binding: "", group: "Navigate"});
      effects.invalidate(); return;
    }


    if(actionId==='tree.workspace.inspect'){
      const generation=++navigationGeneration;
      mode='viewer';viewerWrap=true;workspaceReport=null;viewerField=0;viewerStatus='';viewerPath='Workspace and connection';viewerOffset=0;viewerLines=['Checking workspace and connection…'];effects.invalidate();
      const report=await inspectWorkspaceConnection();
      if(mode==='viewer'&&generation===navigationGeneration){workspaceReport=report;viewerLines=report.lines;effects.invalidate();}
      return;
    }
    if(actionId.startsWith('viewer.copy:')||['tree.viewer.copy','tree.viewer.next-field','tree.viewer.previous-field'].includes(actionId)){
      if(mode==='action-menu'&&actionMenuReturnMode==='viewer')mode='viewer';
      if(mode!=='viewer'||!workspaceReport)return;
      const fields=workspaceReport.entries.filter(entry=>entry.kind==='field');
      if(actionId==='tree.viewer.next-field'||actionId==='tree.viewer.previous-field'){
        if(!fields.length)return;
        viewerField=(viewerField+(actionId==='tree.viewer.next-field'?1:fields.length-1))%fields.length;
        const row=reportLayout()!.fieldRows[viewerField]!;
        const page=Math.max(1,effects.terminalHeight()-3);
        if(row<viewerOffset||row>=viewerOffset+page-1)viewerOffset=row;
        viewerStatus='';
      }else{
        const index=actionId.startsWith('viewer.copy:')?Number(actionId.slice('viewer.copy:'.length)):viewerField;
        const field=Number.isSafeInteger(index)?fields[index]:undefined;
        if(!field)return;
        viewerField=index;
        copyViewerText(field.value, "Value");
        return;
      }
      effects.invalidate();return;
    }
    if(actionId.startsWith("completion.choose:")){
      const [index,generation]=actionId.slice("completion.choose:".length).split(":").map(Number);
      if(index===undefined||!Number.isSafeInteger(index)||index<0)return;
      if(mode!=="filter")await completions.accept(index,generation);
      else if(quickCompletion?.items[index]){quickCompletion.index=index;await applyQuickCompletion();effects.invalidate();}
      return;
    }

    const recovery=destinationRecoveryKey(actionId);
    if(recovery){if(openRecovery.state.active&&recoveryOrigin===originKey())await openRecovery.handleKeypress(recovery.str,recovery.key);return;}
    navigationGeneration++;
    if(openRecovery.state.active)openRecovery.dismiss();
    if(mode==='inbox' && inbox.retainCommentDraft())return;
    if(actionId.startsWith('tree.reader.')){
      if(mode==='action-menu')mode=actionMenuReturnMode;
      const action='preview.'+actionId.slice('tree.reader.'.length);
      if(mode==='inbox')await inbox.previewAction(action);
      else await localReader.action(action,openPreviewTarget);
      return;
    }
    if(actionId.startsWith('preview.')){
      if(mode==='inbox')await inbox.previewAction(actionId);
      else await localReader.action(actionId,openPreviewTarget);
      return;
    }
    if (mode === "action-menu" && actionId.startsWith("tree.preview.")) mode = actionMenuReturnMode;
    if (actionId === "tree.preview.close" || actionId === "tree.preview.toggle") {
      if(localReader.hasDraft){localReader.clear();return;}
      const enabled = actionId === "tree.preview.toggle" && !previewPreferences.enabled;
      previewPreferences = {...previewPreferences, enabled};
      if (!enabled) {
        const hadPreview = !!localReader.state;
        localReader.clear();
        try { if (hadPreview) await effects.request({action:"clients.update",clientId:effects.clientId,previewTarget:null}); }
        catch (error) { status = errorMessage(error); }
      } else {
        const selected = rows[selectedIndex];
        if (isBlockTreeRow(selected)) await inspectLocally({kind:"block",blockId:selected.canonicalId});
        else await publishDisplayRowSelection(selected);
      }
      effects.invalidate(); return;
    }
    if (["tree.preview.right", "tree.preview.bottom", "tree.preview.auto"].includes(actionId)) {
      previewPreferences = {...previewPreferences, dock: actionId.split('.').at(-1) as PreviewPreferences['dock']};
      effects.invalidate(); return;
    }
    if (actionId === "tree.preview.grow" || actionId === "tree.preview.shrink") {
      const frame = localReader.state && treePreviewFrame(localReader.state,effects.terminalWidth(),effects.terminalHeight(),"",previewPreferences,effects.density?.() ?? "compact");
      const fraction = frame?.placement === 'beside' ? previewPreferences.sideFraction : previewPreferences.bottomFraction;
      resizeLocalPreview(fraction + (actionId.endsWith('grow') ? .05 : -.05)); return;
    }
    if(actionId==="tree.preview.focus") {if(localReader.state)localReader.focus(!localReader.state.focused);else status="Select an item to preview it here";effects.invalidate();return;}
    if (mode === "action-menu" && actionMenuReturnMode === "inbox" && actionId.startsWith("tree.inbox.preview.")) {mode="inbox";}
    if (mode === "inbox") {
      if (actionId === "tree.inbox.preview.next-output") {inbox.nextOutput();return;}
      if (actionId.startsWith('tree.inbox.select:')) {inbox.selectResult(Number(actionId.split(':')[1]));return;}
      if (actionId.startsWith('tree.inbox.preview-target:')) {inbox.selectTarget(Number(actionId.split(':')[1]));return;}
      if (actionId === 'tree.inbox.preview.activity') {inbox.showActivity();return;}
      if (actionId === 'tree.inbox.preview.before') {inbox.setSourceVersion('before');return;}
      if (actionId === 'tree.inbox.preview.current') {inbox.setSourceVersion('current');return;}
      if (actionId === 'tree.inbox.preview.technical') {inbox.toggleTechnicalDetails();return;}
      if (actionId === 'tree.inbox.preview.focus') {inbox.focusReader(!inbox.reader.state?.focused);return;}
      if (actionId === 'tree.inbox.preview.source' || actionId === 'tree.inbox.preview.output') {
        const role=actionId.endsWith('source')?'source':'output';
        const index=inbox.targets.findIndex(target=>target.role===role);
        if(index>=0)inbox.selectTarget(index);else inbox.notice='No separate output; preview the current Source';
        effects.invalidate();return;
      }
    }
    if(actionId==="tree.inbox.search"&&(mode==="inbox"||(mode==="action-menu"&&actionMenuReturnMode==="inbox"))){mode="inbox";inbox.startSearch();return;}
    if(actionId==="tree.inbox.search.clear"&&mode==="inbox"){await inbox.cancelSearch();return;}
    if (actionId.startsWith("tree.inbox.open-target:") && mode === "inbox") {
      const index=Number(actionId.split(":")[1]);
      if (Number.isInteger(index) && inbox.targets[index]?.role !== "diagnostics" && inbox.targets[index]) {
        inbox.targetIndex=index; await inbox.input("",{name:"return",meta:true});
      }
      return;
    }
    if (mode === "goto" && actionId === "tree.goto.detail") { await goto.accept("detail"); return; }
    if (actionId === "tree.navigation.link" || actionId === "tree.navigation.once") {
      const activeMode=mode === "action-menu" ? actionMenuReturnMode : mode;
      if(activeMode !== "browse" && activeMode !== "inbox") {
        status="Finish or cancel the active edit/filter before changing destinations";
        effects.invalidate();return;
      }
      const state = await effects.request<NavigationLinkState>({action: "navigation.link.get", source: {clientId: effects.clientId, region: "tree"}});
      showOtherDestinations=false;
      placementDirection=null;
      destinationMenu = {state, purpose: actionId === "tree.navigation.link" ? "link" : "open"};
      actionMenuReturnMode = activeMode;
      mode = "action-menu";
      updateActionMenuQuery("");
      status = navigationDestinationStatus(state,destinationMenu.purpose);
      effects.invalidate();
      return;
    }
    if (destinationMenu && actionId === "placement:back") {
      placementDirection=null;updateActionMenuQuery("");effects.invalidate();return;
    }
    if (destinationMenu && placementDirection && actionId.startsWith("placement:")) {
      const anchor=destinationMenu.state.destinations[Number(actionId.split(":")[1])];
      if (!anchor?.placementPaneId) return;
      const direction=placementDirection;
      placementDirection=null;destinationPreview.clear();mode=actionMenuReturnMode;
      await createLinkedDetail({kind:"split",direction,targetPaneId:anchor.placementPaneId});return;
    }
    if (actionId.startsWith("destination:") && destinationMenu) {
      if (/^destination:sidebar-(outliner|tab)-(left|right)$/.test(actionId)) {
        const [,scope,side]=actionId.match(/^destination:sidebar-(outliner|tab)-(left|right)$/)!;
        await createLinkedDetail({kind:"sidebar",scope:scope as "outliner"|"tab",side:side as "left"|"right"});return;
      }
      if(actionId==='destination:place-right'||actionId==='destination:place-below') {
        placementDirection=actionId.endsWith('right')?'right':'down';updateActionMenuQuery("");effects.invalidate();return;
      }
      if(actionId==='destination:other'){showOtherDestinations=!showOtherDestinations;updateActionMenuQuery("");effects.invalidate();return;}
      if(actionId==='destination:new-right'||actionId==='destination:new-below'){
        destinationPreview.clear();mode=actionMenuReturnMode;
        await createLinkedDetail({kind:'split',direction:actionId.endsWith('right')?'right':'down'});return;
      }
      const menu = destinationMenu;
      const destination = actionId === "destination:unlink" ? null : menu.state.destinations[Number(actionId.slice(12))]?.view;
      if (destination === undefined) return;
      destinationMenu = null;placementDirection=null;destinationPreview.clear();
      mode = actionMenuReturnMode;
      try {
      if (menu.purpose === "link") {
        await effects.request({action: "navigation.link.set", source: menu.state.source, destination});
        void navigationDisplay.refresh();
        status = destination ? `Linked: Tree → ${menu.state.destinations.find(entry=>entry.view.clientId===destination.clientId)?.label ?? "Detail"}` : "Open unlinked · choose once or new split";
      } else if (destination) {
        if(menu.recoveryTarget)await dispatchRecoverable(await materializeRecovery(menu.recoveryTarget),"open",{destination});
        else if(menu.target)await dispatchRecoverable(menu.target,"open",{destination});
        else if (mode === "inbox") {
          const blockId = await inbox.resolveContentTarget();
          await dispatchRecoverable({kind:"block",blockId},"open",{destination});
        } else await focusDetailReader({destination});
      }
      } catch (error) {
        const failure = errorMessage(error);
        if (mode === "inbox") {
          inbox.notice = failure;
          try {
            await handleAction(menu.purpose === "link" ? "tree.navigation.link" : "tree.navigation.once");
            if(destinationMenu) (destinationMenu as {target?:OutlinerNavigationTarget;recoveryTarget?:OpenDestinationTarget}).target=menu.target;
            if(destinationMenu)(destinationMenu as {recoveryTarget?:OpenDestinationTarget}).recoveryTarget=menu.recoveryTarget;
          }
          catch { /* Keep the original failure visible even if discovery is unavailable. */ }
        }
        status = failure;
      }
      effects.invalidate();
      return;
    }
    const readerMenu = readerMenuFromAction(actionId);
    if (readerMenu) {
      selectionMenu = false;
      actionMenuCategory = readerMenu; locationMenu = null;
      destinationMenu = null;placementDirection=null;destinationPreview.clear();
      if (mode !== "action-menu") {
        actionMenuReturnMode = mode;
        actionMenuScope = actionScope();
      }
      mode = "action-menu";
      actionMenuOrigin = origin ?? null;
      updateActionMenuQuery("");
      effects.invalidate();
      return;
    }
    if (mode === "action-menu" && actionId === "tree.cancel") {
      destinationMenu = null;placementDirection=null;destinationPreview.clear();
      mode = actionMenuReturnMode;
      status = "";
      effects.invalidate();
      return;
    }
    if (mode === "action-menu") mode = actionMenuReturnMode;
    if (mode === "browse" && (actionId === "tree.read" || actionId === "tree.read.focus")) {
      await readSelected(actionId === "tree.read.focus");
      return;
    }
    if (actionId === "tree.debug.keys") {
      if(effects.openKeyInspector) effects.openKeyInspector();
      else status="Key inspector is unavailable in this host";
      effects.invalidate();return;
    }
    if (actionId === "tree.inbox.open") {
      if (mode !== "browse") {
        status = "Finish or cancel the Tree editor before opening Inbox activity";
        effects.invalidate();
        return;
      }
      mode = "inbox";
      status = "";
      await inbox.start();
      return;
    }
    if (actionId === "tree.note.assist") {
      const selected = rows[selectedIndex];
      if (!isBlockTreeRow(selected)) status = "Select a note to assist";
      else {
        try {
          await effects.request({ action: "inbox.retry", sourceId: selected.canonicalId });
          status = "Note queued for assistance; open Inbox activity to inspect the result";
        } catch (error) { status = error instanceof Error ? error.message : "Note assistance unavailable"; }
      }
      effects.invalidate();
      return;
    }
    if (actionId === "tree.indentation.toggle") {
      indentationMode = indentationMode === "viewport" ? "selection" : "viewport";
      status = indentationMode === "selection"
        ? "Indentation follows selection · ‹ marks rows extending left of this view"
        : "Indentation fits the whole viewport";
      effects.invalidate();
      return;
    }
    if(actionId.startsWith("tree.breadcrumb.focus:")) {
      let id: string;
      try { id=decodeURIComponent(actionId.slice("tree.breadcrumb.focus:".length)); }
      catch { return; }
      const target=breadcrumbs().find(crumb=>crumb.rowId === id);
      if(target) await focusRoot(target);
      effects.invalidate();return;
    }
    if(actionId === "tree.breadcrumb.left" || actionId === "tree.breadcrumb.right") {
      const path=breadcrumbs();
      breadcrumbStart=Math.max(0,Math.min(path.length-1,(breadcrumbStart ?? 0)+(actionId.endsWith("left") ? -1 : 1)));
      breadcrumbRowId=rows[selectedIndex]?.rowId;
      effects.invalidate();return;
    }
    if (actionId === "tree.pane.new") {
      try { if (!effects.createTreePane) throw new Error("Creating a Tree pane is unavailable in this host");
        await effects.createTreePane(null, "right"); status = "Opened new workspace Tree";
      } catch (error) { status = errorMessage(error); }
      effects.invalidate(); return;
    }
    if(actionId === "tree.root.parent") {
      const path=breadcrumbs();
      if(path.length>1) await focusRoot(path[path.length-2]!);
      else await focusRoot(null);
      effects.invalidate();return;
    }
    if(actionId === "tree.virtual-branch.reset-expansion") {
      const row=rows[selectedIndex];
      const viewId=row?.kind === "occurrence" ? (branchStates.has(row.canonicalId) ? row.canonicalId : row.viewId) : isBlockTreeRow(row) ? row.canonicalId : undefined;
      if(viewId && branchStates.has(viewId)) {
        for(const set of [collapsedOccurrenceRowIds,expandedOccurrenceRowIds]) for(const id of set) {
          if(id.split("/").some(part=>part.startsWith(`occurrence:${viewId}:`)))set.delete(id);
        }
        await reload(row?.rowId);status="Reset this view to its expansion defaults";
      } else status="Select a virtual branch or one of its results";
      effects.invalidate();return;
    }
    if (["tree.root.focus","tree.root.workspace","tree.root.right","tree.root.below","tree.depth.expand","tree.depth.collapse"].includes(actionId)) {
      const row=rows[selectedIndex];
      if(actionId === "tree.root.workspace") await focusRoot(null);
      else if(actionId.startsWith("tree.depth.")) await changeDepth(actionId === "tree.depth.expand");
      else if(isBlockTreeRow(row)) {
        const next={rowId:row.rowId,canonicalId:row.canonicalId,label:row.block.preview};
        if(actionId === "tree.root.focus") await focusRoot(next);
        else if(effects.createTreePane) await effects.createTreePane(next,actionId === "tree.root.right" ? "right" : "down");
        else status = "Creating a Tree split requires a pane host";
      }
      effects.invalidate(); return;
    }
    if (actionId === "tree.detail.right" || actionId === "tree.detail.below") {
      await createDetailPane(actionId === "tree.detail.right" ? "right" : "down");
      return;
    }
    if (actionId === "tree.attention.acknowledge") {
      attention = await effects.request<AttentionClientState>({
        action: "attention.acknowledge",
        input: { targetClientId: effects.clientId },
      });
      status = "Attention cue acknowledged; active marks remain";
      effects.invalidate();
      return;
    }
    if (actionId === "tree.keymap.reload") {
      const result = actionKeymap.reload();
      status = result.ok ? "Outliner keymap reloaded" : `Keymap unchanged: ${result.error}`;
      effects.invalidate();
      return;
    }
    const selected = rows[selectedIndex];
    if (actionId === "tree.reorder.up" || actionId === "tree.reorder.down") {
      const offset = actionId === "tree.reorder.up" ? -1 : 1;
      let preferredRowId: string | null = null;
      if (!isBlockTreeRow(selected)) {
        status = "Select an ordinary block occurrence to reorder";
      } else if (isVirtualBranchRootOccurrence(selected)) {
        preferredRowId = await moveOccurrenceSibling(selected, offset);
      } else if (isVirtualBranchOccurrence(selected)) {
        occurrenceMutationDisabled("reorder");
      } else {
        preferredRowId = await moveSibling(selected, offset);
      }
      if (preferredRowId) {
        await reload(preferredRowId);
        await publishDisplayRowSelection(rows[selectedIndex]);
      }
      effects.invalidate();
      return;
    }
    if (actionId === "tree.authored-links.toggle") {
      if(!selected || !connectionOwner(selected)){status="Select a resolved block target to show connections";effects.invalidate();return;}
      const wasCollapsed=isBlockTreeRow(selected) && connectionCollapsed(selected);
      const opened=connections.toggle(selected);
      if(opened && isBlockTreeRow(selected)){
        if(selected.kind==='occurrence'){if(wasCollapsed)setCollapsed(selected,false);}
        else collapsedBlockIds.delete(selected.canonicalId);
      }
      if(opened && wasCollapsed) await reload(selected.rowId,{exactRowIdOnly:true});
      else recomposeAuthoredRows(selected.rowId);
      effects.invalidate();
      await refreshAuthoredLinks(false);
      status=opened?"Authored links shown · Outlinks, Resources and Backlinks":"Authored links hidden";
      effects.invalidate();return;
    }
    if (actionId === "tree.virtual-branch.open") {
      if (!isBlockTreeRow(selected)) {
        status = "No block selected";
      } else if (!isVirtualBranchDefinition(selected.block)) {
        status = "Selected block is not a virtual branch";
      } else {
        try {
          await effects.openVirtualBranchNavigator(selected.canonicalId);
          status = `Opened virtual navigator for ${selected.block.preview}`;
        } catch (error) {
          status = errorMessage(error);
        }
      }
      effects.invalidate();
      return;
    }
    if (actionId === "tree.mentions.open") {
      try {
        await effects.openVirtualBranchNavigator("recent-mentions", "mentions");
        status = "Opened recent agent mentions";
      } catch (error) {
        status = errorMessage(error);
      }
      effects.invalidate();
      return;
    }
    if (actionId === "tree.bookmarks.open") {
      try {
        const root = await effects.request<Block>({ action: "bookmarks.root" });
        await effects.openVirtualBranchNavigator(root.id, "bookmark");
        status = "Opened Bookmarks";
      } catch (error) {
        status = errorMessage(error);
      }
      effects.invalidate();
      return;
    }
    if (actionId === "tree.bookmark.toggle") {
      if (!isBlockTreeRow(selected)) {
        status = "No block selected";
      } else {
        try {
          const bookmark = await effects.request<BookmarkStatus>({
            action: "bookmarks.status",
            targetBlockId: selected.canonicalId,
          });
          const receipt = await effects.request<BookmarkToggleReceipt>({
            action: "bookmarks.toggle",
            targetBlockId: selected.canonicalId,
            expectedRecordId: bookmark.record?.id ?? null,
          });
          status = receipt.bookmarked ? "Bookmarked" : "Bookmark removed";
        } catch (error) {
          status = errorMessage(error);
        }
      }
      effects.invalidate();
      return;
    }
    if (actionId === "tree.current.reveal") {
      if (!isBlockTreeRow(selected)) {
        status = "No block selected";
      } else {
        try {
          await selectVisibleBlock(selected.canonicalId, {
            recordNavigation: true,
            physicalSource: true,
          });
          effects.focusSelf();
          status = `Revealed source ${selected.block.preview}`;
        } catch (error) {
          status = errorMessage(error);
        }
      }
      effects.invalidate();
      return;
    }
    if (actionId === "tree.reference.open" || actionId === "tree.reference.reveal") {
      if (!isBlockTreeRow(selected)) {
        status = "No block selected";
      } else {
        try {
          await navigateSelectedReference(
            selected,
            actionId === "tree.reference.reveal" ? "reveal" : "open",
          );
        } catch (error) {
          status = errorMessage(error);
        }
      }
      effects.invalidate();
      return;
    }
    const input = actionKeymap.defaultInput(actionId);
    if (!input) {
      status = `${actionKeymap.action(actionId).label} has no direct invocation`;
      effects.invalidate();
      return;
    }
    await handleKeypress(input.str, input.key, "pass", false);
  }

  async function handlePaste(text: string): Promise<void> {
    if(mode === "browse" && localReader.state?.focused && localReader.paste(text))return;
    cancelReadSequence();
    if (mode === "goto") { goto.paste(text); return; }
    if (mode === "inbox") { inbox.paste(text); return; }
    if (mode === "action-menu") {
      updateActionMenuQuery(actionMenuQuery + text);
    } else if (mode !== "browse" && mode !== "delete" && mode !== "viewer") {
      quickBuffer.insert(text);
      if (mode === "branch-filter") { applyBranchFilter(); return; }
      if(mode!=="filter"&&mode!=="purge")void completions.refresh();
    }
    effects.invalidate();
  }

  async function handleKeypress(
    str: string,
    key: TerminalKey,
    inputAction: TerminalInputAction,
    resolveAction = true,
    treePointer = false,
  ): Promise<void> {
    if(openRecovery.state.active&&inputAction!=='suppress'){
      cancelReadSequence();
      if(recoveryOrigin!==originKey()){openRecovery.dismiss();}
      else if(key.name==='return'||key.name==='escape'||str.toLowerCase()==='l'){
        await openRecovery.handleKeypress(str,key);return;
      }else openRecovery.dismiss();
    }
    if(inputAction!=='suppress' && mode==='inbox' && inbox.hasCommentDraft){
      await inbox.input(str,key);return;
    }
    if(inputAction!=='suppress')navigationGeneration++;
    if(resolveAction && inputAction !== "suppress" && mode !== "browse" && mode !== "action-menu" && (key.meta || key.ctrl)) {
      const browseAction=actionKeymap.canonicalize("tree","browse",str,key);
      if(browseAction.actionId === "tree.navigation.link" || browseAction.actionId === "tree.navigation.once") {
        await handleAction(browseAction.actionId);return;
      }
    }
    if (!treePointer && inputAction !== "suppress" && mode === "browse" && localReader.state?.focused) {
      cancelReadSequence();
      if(localReader.hasDraft||localReader.state?.checklistPicker){
        const frame=treePreviewFrame(localReader.state,effects.terminalWidth(),effects.terminalHeight(),"",previewPreferences,effects.density?.() ?? "compact");
        await localReader.key(key,frame.content.width,frame.content.height,openPreviewTarget,str);return;
      }
      if(key.name==="escape"){
        if(localReader.state.selecting||localReader.state.passageSelected){await localReader.key(key,0,0,openPreviewTarget,str);return;}
        localReader.focus(false);return;
      }
      const action=actionKeymap.canonicalize("tree","reader",str,key);
      if(action.suppressed)return;
      if(action.actionId?.startsWith("tree.reader."))return handleAction(action.actionId);
      if(action.actionId && (action.actionId.startsWith("tree.preview.") || ["tree.preview.focus","tree.preview.close","tree.pane.new","tree.navigation.link","tree.navigation.once","tree.menu.open"].includes(action.actionId))) return handleAction(action.actionId);
      const frame=treePreviewFrame(localReader.state,effects.terminalWidth(),effects.terminalHeight(),"",previewPreferences,effects.density?.() ?? "compact");
      if(await localReader.key(key,frame.content.width,frame.content.height,openPreviewTarget,str))return;
      const delta=key.name==="up"?-1:key.name==="down"?1:key.name==="pageup"?-frame.content.height:key.name==="pagedown"?frame.content.height:0;
      if(delta) scrollLocalPreview(delta);
      else if(key.name==="return") { try {await dispatchRecoverable(localReader.state.target,"open");} catch(error){status=errorMessage(error);} }
      else if(!(key.ctrl&&key.name==="q")) return;
      if(!(key.ctrl&&key.name==="q")){effects.invalidate();return;}
    }
    if (resolveAction) {
      const mapped = actionKeymap.canonicalize("tree", actionScope(), str, key);
      if (mapped.suppressed) return;
      if (mapped.actionId) {
        if (branchFilter && mode === "browse" && mapped.actionId === "tree.preview.close" && key.name === "escape") { await clearBranchFilter(); return; }
        await handleAction(mapped.actionId);
        return;
      }
      str = mapped.str;
      key = mapped.key;
    }
    if (inputAction === "suppress") return;
    if (key.name !== "return" || key.ctrl || key.meta || key.shift || mode !== "browse") cancelReadSequence();
    if (key.ctrl && key.name === "q") {
      if(localReader.hasDraft||inbox.hasCommentDraft){status="Comment draft retained · save or cancel before closing";effects.invalidate();return;}
      closed=true;navigationGeneration++;openRecovery.dispose();
      effects.stop();
      return;
    }
    if (key.ctrl && key.name === "c") {
      if (mode === "branch-filter") { await clearBranchFilter(); return; }
      if (mode === "inbox" || (mode === "action-menu" && actionMenuReturnMode === "inbox")) { await inbox.close(); return; }
      if (mode !== "browse") {
        mode = "browse";
        resetQuickEditor();
        if (refreshPending) await reload();
      } else {
        status = "⌃Q closes the outliner pane";
      }
      effects.invalidate();
      return;
    }
    const detailHandoffRequested = inputAction === "modified-enter" || (key.name === "e" && key.ctrl);

    if (mode === "viewer") {
      const page = Math.max(1, effects.terminalHeight() - 4);
      const maxOffset = Math.max(0, displayedViewerLines().length - 1);
      if (key.name === "escape" || key.name === "q") {
        mode = "browse";
        if (refreshPending) await reload();
      } else if (key.name === "up") viewerOffset = Math.max(0, viewerOffset - 1);
      else if (key.name === "down") viewerOffset = Math.min(maxOffset, viewerOffset + 1);
      else if (key.name === "pageup") viewerOffset = Math.max(0, viewerOffset - page);
      else if (key.name === "pagedown") viewerOffset = Math.min(maxOffset, viewerOffset + page);
      else if (str === "g") viewerOffset = 0;
      else if (str === "G") viewerOffset = Math.max(0, displayedViewerLines().length - page);
      effects.invalidate();
      return;
    }
    if (mode === "action-menu") {
      const items = filteredActionMenuItems();
      if (!selectionMenu && !destinationMenu && !locationMenu && (key.name === "left" || key.name === "right")) {
        actionMenuCategory = adjacentReaderMenu(actionMenuCategory, key.name === "right" ? 1 : -1);
        updateActionMenuQuery("");
      } else if (key.name === "escape") {
        mode = actionMenuReturnMode;
        status = "";
        destinationMenu=null;destinationPreview.clear();
      } else if (key.name === "up") {
        actionMenuIndex = Math.max(0, actionMenuIndex - 1);
      } else if (key.name === "down") {
        actionMenuIndex = Math.min(Math.max(0, items.length - 1), actionMenuIndex + 1);
      } else if (key.name === "return") {
        const action = items[actionMenuIndex];
        if (action) {
          await handleAction(action.id);
          return;
        }
      } else if (key.name === "backspace") {
        updateActionMenuQuery([...actionMenuQuery].slice(0, -1).join(""));
      } else if (isPrintableInput(str, key)) {
        updateActionMenuQuery(actionMenuQuery + str);
      }
      if(destinationMenu)updateDestinationPreview();
      effects.invalidate();
      return;
    }

    if (mode === "delete") {
      const selected = rows[selectedIndex];
      if (str.toLowerCase() === "y" && isBlockTreeRow(selected)) {
        const fallback = fallbackRowBeforeDelete(rows, selectedIndex, physicalBlocksById);
        await publishBrowsingContext(fallback?.canonicalId ?? null);
        await effects.request({ action: "delete", blockId: selected.canonicalId, mutation: TREE_MUTATION });
        await reload(fallback?.rowId ?? null, { exactRowIdOnly: true });
        const visible = rows[selectedIndex];
        lastVisibleCanonicalId = isBlockTreeRow(visible) ? visible.canonicalId : null;
        status = "Moved to Trash";
      } else if (refreshPending) {
        await reload();
      }
      mode = "browse";
      effects.invalidate();
      return;
    }


    if (mode === "branch-filter") {
      if (key.name === "escape") await clearBranchFilter();
      else if (key.name === "return") await finishInput();
      else { updateQuickBuffer(str,key); applyBranchFilter(); }
      effects.invalidate(); return;
    }
    if (mode === "browse" && key.name === "escape" && branchFilter) { await clearBranchFilter(); return; }
    if (mode === "goto") { await goto.input(str, key); return; }
    if (mode === "inbox") { await inbox.input(str, key); return; }

    if (mode !== "browse") {
      if (quickCompletion && ["up","down","return","tab","escape"].includes(key.name??"")) {
        if (key.name === "up") moveQuickCompletion(-1);
        else if (key.name === "down") moveQuickCompletion(1);
        else if (key.name === "return" && !quickCompletion.items.length) await finishInput();
        else if (key.name === "return" || key.name === "tab") await applyQuickCompletion();
        else if (key.name === "escape") {if(mode==="filter")quickCompletion=null;else completions.dismiss();}
        effects.invalidate();
        return;
      }

      if (mode !== "filter" && mode !== "purge" && detailHandoffRequested) {
        await handoffToDetail();
        return;
      }
      if (key.name === "escape") {
        mode = "browse";
        resetQuickEditor();
        if (refreshPending) await reload();
      } else if (key.name === "return") {
        await finishInput();
        return;
      } else if (key.name === "tab" && mode !== "purge") {
        await openQuickCompletion();
      } else {
        updateQuickBuffer(str, key);
        if(mode!=="filter"&&mode!=="purge")void completions.refresh();
      }
      effects.invalidate();
      return;
    }

    const selected = rows[selectedIndex];
    let preferredRowId: string | undefined;
    let reloadRequired = false;
    let queueSelectionPublication = false;
    const historyDirection = historyNavigationDirection(key);
    if (historyDirection) {
      await navigateTreeHistory(historyDirection);
      effects.invalidate();
      return;
    }
    if (selected && !isBlockTreeRow(selected)) {
      if (key.name === "q") {
        status = "Outliner remains open; ⌃Q closes this pane";
      } else if (key.name === "up" || key.name === "down") {
        const delta = key.name === "up" ? -1 : 1;
        selectedIndex = Math.max(0, Math.min(rows.length - 1, selectedIndex + delta));
        resetExpandedBlockPaging();
        queueDisplayRowSelection(rows[selectedIndex]);
      } else if (key.name === "right" && selected.kind==='authored-link' && connectionOwner(selected)) {
        if(!connections.isOpen(selected.rowId))await handleDisclosure(selected.rowId);
        else {selectedIndex=Math.min(rows.length-1,selectedIndex+1);await publishDisplayRowSelection(rows[selectedIndex]);}
      } else if (key.name === "left") {
        if(selected.kind==='authored-link' && connections.isOpen(selected.rowId)){await handleDisclosure(selected.rowId);return;}
        if ((selected.kind === "authored-link-header" || selected.kind === "comment-group") && !selected.collapsed) {
          await handleDisclosure(selected.rowId);
          return;
        }
        const targetRowId = selected.kind === "authored-link-header" || selected.kind === "comment-group"
          ? selected.owner.rowId
          : authoredLinkHeaderRowId(selected.owner.rowId, selected.group);
        const targetIndex = rows.findIndex((row) => row.rowId === targetRowId);
        if (targetIndex >= 0) {
          selectedIndex = targetIndex;
          await publishDisplayRowSelection(rows[selectedIndex]);
        }
      } else if (
        (selected.kind === "authored-link-header" || selected.kind === "comment-group") &&
        (key.name === "right" || key.name === "space" || key.name === "return")
      ) {
        await handleDisclosure(selected.rowId);
        return;
      } else if (key.name === "return" || detailHandoffRequested) {
        await readSelected(detailHandoffRequested);
        return;
      } else if (key.name === "pageup" || key.name === "pagedown" || isDetailToggle(str, key)) {
        status = "Generated rows are single-line";
      } else if (str === "g") {
        await beginInput("goto");
        return;
      } else if (str === "/") {
        await beginBranchFilter();
        return;
      } else if (key.name === "escape" && activeFilter) {
        activeFilter = "";
        await reload(selected.rowId, { exactRowIdOnly: true });
        await publishDisplayRowSelection(rows[selectedIndex]);

      } else {
        status = "Generated rows are read-only; Enter opens or expands";
      }
      effects.invalidate();
      return;
    }
    if (key.name === "q") {
      status = "Outliner remains open; ⌃Q closes this pane";
    } else if (isDetailToggle(str, key)) {
      if (!selected) {
        status = "No block selected";
      } else {
        resetExpandedBlockPaging();
        const expanded = !multilineExpandedRowIds.delete(selected.rowId);
        if (expanded) multilineExpandedRowIds.add(selected.rowId);
        status = expanded ? "Block detail expanded" : "Block detail collapsed";
        preferredRowId = selected.rowId;
        reloadRequired = true;
      }
    } else if (detailHandoffRequested) {
      await handoffToDetail();
      return;
    } else if (key.name === "pageup" || key.name === "pagedown") {
      scrollSelectedExpandedBlock(key.name);
    } else if (key.name === "up") {
      selectedIndex = Math.max(0, selectedIndex - 1);
      queueSelectionPublication = true;
    } else if (key.name === "down") {
      selectedIndex = Math.min(rows.length - 1, selectedIndex + 1);
      queueSelectionPublication = true;
    } else if (key.name === "left" && selected) {
      if (isVirtualBranchOccurrence(selected)) {
        if (!selected.collapsed && selected.hasChildren) {
          setCollapsed(selected,true);
          preferredRowId = selected.rowId;
          reloadRequired = true;
        } else {
          selectedIndex = Math.max(
            0,
            rows.findIndex((row) => row.rowId === (comments.parentGroup(selected.rowId) ?? selected.parentRowId)),
          );
        }
      } else if (!selected.collapsed && selected.hasChildren) {
        collapsedBlockIds.add(selected.canonicalId);
        reloadRequired = true;
      } else if (selected.block.parentId) {
        selectedIndex = Math.max(
          0,
          rows.findIndex((row) => row.rowId === (comments.parentGroup(selected.rowId) ?? selected.block.parentId)),
        );
      }
    } else if (key.name === "right" && selected) {
      if (isVirtualBranchOccurrence(selected)) {
        if (selected.collapsed) {
          setCollapsed(selected,false);
          preferredRowId = selected.rowId;
          reloadRequired = true;
        } else if (selected.hasChildren) {
          const child = rows[selectedIndex+1];
          if (child && child.depth > selected.depth) selectedIndex++;
        }
      } else if (selected.collapsed) {
        collapsedBlockIds.delete(selected.canonicalId);
        reloadRequired = true;
      } else if (selected.hasChildren) selectedIndex = Math.min(rows.length - 1, selectedIndex + 1);
    } else if (str === "r" && selected?.block.deletedAt) {
      await effects.request({ action: "trash.restore", blockId: selected.canonicalId, mutation: TREE_MUTATION });
      status = "Restored from Trash";
      reloadRequired = true;
    } else if (str === "p" && selected?.block.deletedAt) {
      const required =
        selected.block.properties.find((property) => property.key === "work-id")?.value
        ?? selected.canonicalId.slice(0, 8);
      status = `Type ${required} to permanently purge`;
      await beginInput("purge");
      return;
    } else if (key.name === "return" && selected) {
      await readSelected();
      return;
    } else if (str === "e" && selected) {
      if (selected.block.effectiveDeletedRootId) {
        status = "Block is in Trash; open it read-only with ↵";
        effects.invalidate();
        return;
      }
      const exact = await effects.request<Block>({ action: "get", blockId: selected.canonicalId });
      if (exact.text.includes("\n")) {
        await handoffToDetail();
        return;
      }
      quickEditSource = { id: exact.id, revision: exact.revision };
      await beginInput("edit", exact.text);
      return;
    } else if (key.name === "tab" && selected) {
      if (isVirtualBranchOccurrence(selected)) {
        occurrenceMutationDisabled(key.shift ? "outdent" : "indent");
      } else {
        if (key.shift) await outdent(selected);
        else await indent(selected);
        preferredRowId = selected.canonicalId;
        reloadRequired = true;
      }
    } else if (key.name === "space" && selected) {
      if (isVirtualBranchOccurrence(selected)) {
        if (selected.hasChildren) {
          setCollapsed(selected,!selected.collapsed);
          preferredRowId = selected.rowId;
          reloadRequired = true;
        }
      } else {
        if (!collapsedBlockIds.delete(selected.canonicalId)) {
          collapsedBlockIds.add(selected.canonicalId);
        }
        reloadRequired = true;
      }
    } else if (str === "c" && selected) {
      try {
        await effects.openCapturePopup(selected.canonicalId);
        status = "Opened quick capture popup";
      } catch (error) {
        status = errorMessage(error);
      }
      effects.invalidate();
      return;
    } else if (str === "a" && selected) {
      const placement = isVirtualBranchOccurrence(selected) ? await projectedChildPlacement(selected) : null;
      const problem = placement && "problem" in placement ? placement.problem
        : selected.kind === "physical" ? virtualBranchCreationProblem(selected) : null;
      if (problem) status = problem;
      else {
        await beginInput("add-child");
        return;
      }
    } else if (str === "s" && selected) {
      if (isVirtualBranchOccurrence(selected)) {
        occurrenceMutationDisabled("add-sibling");
      } else {
        await beginInput("add-sibling");
        return;
      }
    } else if (str === "g") {
      await beginInput("goto");
      return;
    } else if (str === "/") {
      await beginBranchFilter();
      return;
    } else if (key.name === "delete" && selected) mode = "delete";
    else if (str === "f" && selected) await openReferencedFile(selected.block);
    else if (key.name === "escape" && activeFilter) {
      activeFilter = "";
      reloadRequired = true;
    }

    if (rows[selectedIndex]?.rowId !== selected?.rowId) resetExpandedBlockPaging();
    if (reloadRequired) await reload(preferredRowId);
    const visible = rows[selectedIndex];
    if (visible?.rowId !== selected?.rowId || reloadRequired) {
      if (queueSelectionPublication) queueDisplayRowSelection(visible);
      else await publishDisplayRowSelection(visible);
    }
    effects.invalidate();
  }

  async function initialize(): Promise<void> {
    void navigationDisplay.refresh();
    await observeService();
    await reload();
    await publishDisplayRowSelection(rows[selectedIndex]);
    await inbox.refresh();
    try { await collected.refresh(); collected.recovered = Boolean(collected.current); }
    catch { /* Selection failure stays visible without preventing ordinary browsing. */ }
  }
  return {
    get mode(){return mode;},
    copyViewerSelection(text) {
      if (mode === "viewer" && workspaceReport) copyViewerText(text, "Selection");
    },
    focusLocalPreview,
    scrollLocalPreview,
    resizeLocalPreview,
    setViewportStart(index, page) {
      scrollStartEntryIndex = index;
      expandedPage = page ?? null;
      if (page) expandedBlockOffset = page.offset;
    },
    setBreadcrumbStart(index) { breadcrumbStart=index;breadcrumbRowId=rows[selectedIndex]?.rowId; },
    view,
    async revealBlock(blockId) {
      if (mode !== "browse") throw new Error("Finish or cancel the Tree editor before navigating");
      await selectVisibleBlock(blockId, { recordNavigation: true, physicalSource: true });
      effects.focusSelf();
      effects.invalidate();
    },
    initialize,
    handleKeypress,
    handleTreeWheel: async direction => {if(mode === "inbox") {inbox.reader.focus(false);inbox.move(direction === "up"?-1:1);}else await handleKeypress("", {name: direction}, "pass", false, true);},
    handleLink,
    handlePaste,
    handleGotoMouse,
    handleDisclosure,
    handleRowClick,
    handleAction,
    handleServiceEvent,
    handleConnect,
    handleDisconnect,
    handleError,
  };
}
