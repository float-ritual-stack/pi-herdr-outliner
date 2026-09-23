import {createHash} from "node:crypto";
import type {
  AuthoredLinkDiagnostic,
  AuthoredLinkGroup,
  AuthoredLinksSnapshot,
  AuthoredOutlink,
  AuthoredResourceLink,
} from "./authored-links";
import type { AuthoredResourceReference, OutlinerNavigationTarget, VisibleBlock } from "./types";
import type { ProjectionBlock, TreeRow } from "./virtual-branches";

export type TreeLinkGroupName = "outlinks" | "resources" | "backlinks";

export interface AuthoredLinksOwnerOccurrence {
  readonly rowId: string;
  readonly blockId: string;
}

export interface AuthoredLinkGroupProvider {
  readonly group: TreeLinkGroupName;
  readonly label: string;
}

export const AUTHORED_LINK_GROUP_PROVIDERS: readonly AuthoredLinkGroupProvider[] = [
  {group:"outlinks",label:"Outlinks"},
  {group:"resources",label:"Resources"},
  {group:"backlinks",label:"Backlinks"},
];

export type BacklinksPanelLoad =
  | {readonly kind:"loading"}
  | {readonly kind:"error"; readonly message:string}
  | {readonly kind:"ready"; readonly group:AuthoredLinkGroup<AuthoredOutlink>};

export type AuthoredLinksPanelLoad =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly snapshot: AuthoredLinksSnapshot }
  | { readonly kind: "error"; readonly message: string };

export interface OpenAuthoredLinksPanel {
  readonly kind: "open";
  readonly owner: AuthoredLinksOwnerOccurrence;
  readonly generation: number;
  readonly collapsedGroups: Readonly<Record<TreeLinkGroupName, boolean>>;
  readonly load: AuthoredLinksPanelLoad;
  readonly backlinks: BacklinksPanelLoad;
}


export type AuthoredLinkHeaderState =
  | {
      readonly kind: "loading";
      readonly message: string;
    }
  | {
      readonly kind: "ready";
      readonly entryCount: number;
      readonly invalidCount: number;
      readonly limited: boolean;
      readonly diagnostics: readonly AuthoredLinkDiagnostic[];
    }
  | {
      readonly kind: "unavailable";
      readonly message: string;
    }
  | {
      readonly kind: "error";
      readonly message: string;
    };

export interface AuthoredLinkHeaderRow {
  readonly kind: "authored-link-header";
  readonly rowId: string;
  readonly parentRowId: string;
  readonly owner: AuthoredLinksOwnerOccurrence;
  readonly group: TreeLinkGroupName;
  readonly label: string;
  readonly depth: number;
  readonly collapsed: boolean;
  readonly state: AuthoredLinkHeaderState;
}

export interface AuthoredLinkRow {
  readonly kind: "authored-link";
  readonly rowId: string;
  readonly parentRowId: string;
  readonly owner: AuthoredLinksOwnerOccurrence;
  readonly group: TreeLinkGroupName;
  readonly depth: number;
  readonly link: AuthoredOutlink | AuthoredResourceLink;
  readonly connectionsOpen?: boolean;
}

export type TreeDisplayRow<T extends ProjectionBlock = VisibleBlock> = TreeRow<T> | AuthoredLinkHeaderRow | AuthoredLinkRow;

export function isBlockTreeRow<T extends ProjectionBlock>(row: TreeDisplayRow<T> | undefined): row is TreeRow<T> {
  return row?.kind === "physical" || row?.kind === "occurrence";
}

export function authoredLinkHeaderRowId(
  ownerRowId: string,
  group: TreeLinkGroupName,
): string {
  return "connections:"+createHash("sha256").update(JSON.stringify([ownerRowId,group])).digest("hex");
}

export function authoredLinkRowId(
  ownerRowId: string,
  group: TreeLinkGroupName,
  destinationKey: string,
): string {
  return "connection:"+createHash("sha256").update(JSON.stringify([ownerRowId,group,destinationKey])).digest("hex");
}

function headerState(
  panel: OpenAuthoredLinksPanel,
  provider: AuthoredLinkGroupProvider,
): AuthoredLinkHeaderState {
  if(provider.group === "backlinks") {
    if(panel.backlinks.kind === "loading")return{kind:"loading",message:"Loading backlinks"};
    if(panel.backlinks.kind === "error")return{kind:"error",message:panel.backlinks.message};
    const group=panel.backlinks.group;
    return{kind:"ready",entryCount:group.entries.length,invalidCount:0,limited:group.completeness.kind==='limited',diagnostics:[]};
  }
  if (panel.load.kind === "loading") {
    return { kind: "loading", message: "Loading authored links" };
  }
  if (panel.load.kind === "error") {
    return { kind: "error", message: panel.load.message };
  }
  const snapshot = panel.load.snapshot;
  if (snapshot.kind === "owner-unavailable") {
    return {
      kind: "unavailable",
      message: snapshot.reason === "deleted" ? "Owner block is in Trash" : "Owner block is missing",
    };
  }
  if (snapshot.kind === "source-too-large") {
    return {
      kind: "unavailable",
      message: `Owner text exceeds ${snapshot.maximumUtf16Units} UTF-16 units`,
    };
  }
  const linkGroup = snapshot[provider.group];
  return {
    kind: "ready",
    entryCount: linkGroup.entries.length,
    invalidCount: linkGroup.invalidCount,
    limited: linkGroup.completeness.kind === "limited",
    diagnostics: linkGroup.diagnostics,
  };
}

function headerRow<T extends ProjectionBlock>(
  ownerRow: TreeDisplayRow<T>,
  panel: OpenAuthoredLinksPanel,
  provider: AuthoredLinkGroupProvider,
): AuthoredLinkHeaderRow {
  return {
    kind: "authored-link-header",
    rowId: authoredLinkHeaderRowId(ownerRow.rowId, provider.group),
    parentRowId: ownerRow.rowId,
    owner: panel.owner,
    group: provider.group,
    label: provider.label,
    depth: ownerRow.depth + 1,
    collapsed: panel.collapsedGroups[provider.group],
    state: headerState(panel, provider),
  };
}

function groupEntries(
  panel: OpenAuthoredLinksPanel,
  provider: AuthoredLinkGroupProvider,
): readonly (AuthoredOutlink | AuthoredResourceLink)[] {
  if(provider.group === "backlinks")return panel.backlinks.kind==='ready'?panel.backlinks.group.entries:[];
  if (panel.load.kind !== "ready" || panel.load.snapshot.kind !== "ready") return [];
  return panel.load.snapshot[provider.group].entries;
}

function groupVisible(
  panel: OpenAuthoredLinksPanel,
  provider: AuthoredLinkGroupProvider,
): boolean {
  if(provider.group === "backlinks")return true;
  if (panel.load.kind !== "ready" || panel.load.snapshot.kind !== "ready") return true;
  const group = panel.load.snapshot[provider.group];
  return group.entries.length > 0 ||
    group.invalidCount > 0 ||
    group.diagnostics.length > 0 ||
    group.completeness.kind === "limited";
}

export function connectionOwner<T extends ProjectionBlock>(row: TreeDisplayRow<T> | undefined): AuthoredLinksOwnerOccurrence | null {
  if(isBlockTreeRow(row))return{rowId:row.rowId,blockId:row.canonicalId};
  if(row?.kind==='authored-link' && row.link.resolution.kind==='ready' && row.link.resolution.target.kind==='block')return{rowId:row.rowId,blockId:row.link.resolution.target.blockId};
  return null;
}

/** Compose only explicitly disclosed paths. Cycles need another distinct user-owned occurrence. */
export function composeAuthoredLinkRows<T extends ProjectionBlock>(
  blockRows: readonly TreeRow<T>[],
  panels: ReadonlyMap<string,OpenAuthoredLinksPanel>,
  ownerCollapsed: (row: TreeRow<T>) => boolean = row=>!!row.collapsed,
): TreeDisplayRow<T>[] {
  const composed:TreeDisplayRow<T>[]=[];
  const stack:TreeDisplayRow<T>[]=[...blockRows].reverse();
  while(stack.length){
    let row=stack.pop()!;
    const owner=connectionOwner(row),panel=owner?panels.get(owner.rowId):undefined;
    const owns=panel && panel.owner.blockId===owner?.blockId;
    if(isBlockTreeRow(row)&&owns)row={...row,hasChildren:true,collapsed:ownerCollapsed(row)};
    if(row.kind==='authored-link')row={...row,connectionsOpen:!!owns};
    composed.push(row);
    if(!owns || (isBlockTreeRow(row)&&row.collapsed))continue;
    const children:TreeDisplayRow<T>[]=[];
    for(const provider of AUTHORED_LINK_GROUP_PROVIDERS){
      if(!groupVisible(panel,provider))continue;
      const header=headerRow(row,panel,provider);children.push(header);
      if(header.collapsed)continue;
      for(const link of groupEntries(panel,provider))children.push({kind:'authored-link',rowId:authoredLinkRowId(row.rowId,provider.group,link.key),parentRowId:header.rowId,owner:panel.owner,group:provider.group,depth:row.depth+2,link});
    }
    stack.push(...children.reverse());
  }
  return composed;
}

export type AuthoredLinkActivation =
  | { readonly kind: "target"; readonly target: OutlinerNavigationTarget }
  | { readonly kind: "follow-page"; readonly address: string }
  | { readonly kind: "follow-resource"; readonly reference: AuthoredResourceReference }
  | { readonly kind: "unavailable"; readonly reason: string };

export function authoredLinkActivation(row: AuthoredLinkRow): AuthoredLinkActivation {
  const { resolution } = row.link;
  if (resolution.kind === "ready") return { kind: "target", target: resolution.target };
  if (resolution.kind === "unregistered-page") {
    return { kind: "follow-page", address: resolution.address };
  }
  if (resolution.kind === "unregistered") {
    return { kind: "follow-resource", reference: resolution.reference };
  }
  return { kind: "unavailable", reason: resolution.reason };
}

export function authoredLinkCanOpen(row: AuthoredLinkRow): boolean {
  return authoredLinkActivation(row).kind !== "unavailable";
}

export function authoredLinkTarget(row: AuthoredLinkRow): OutlinerNavigationTarget | null {
  return row.link.resolution.kind === "ready" ? row.link.resolution.target : null;
}

export function authoredLinkUnavailableReason(row: AuthoredLinkRow): string | null {
  const { resolution } = row.link;
  if (resolution.kind === "ready") return null;
  if (resolution.kind === "unregistered-page") {
    return `${resolution.reason} · Enter creates the page`;
  }
  if (resolution.kind === "unregistered") {
    return `${resolution.reason} · Enter creates the Resource`;
  }
  return resolution.reason;
}

export function authoredLinkFallbackRowIds<T extends ProjectionBlock>(row: TreeDisplayRow<T>): readonly string[] {
  if (row.kind === "authored-link") {
    return [authoredLinkHeaderRowId(row.owner.rowId, row.group), row.owner.rowId];
  }
  if (row.kind === "authored-link-header") return [row.owner.rowId];
  return [];
}
