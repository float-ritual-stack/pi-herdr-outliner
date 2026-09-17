import type {
  AuthoredLinkDiagnostic,
  AuthoredLinkGroupName,
  AuthoredLinksSnapshot,
  AuthoredOutlink,
  AuthoredResourceLink,
} from "./authored-links";
import type { OutlinerNavigationTarget } from "./types";
import type { TreeRow } from "./virtual-branches";

export interface AuthoredLinksOwnerOccurrence {
  readonly rowId: string;
  readonly blockId: string;
}

export type AuthoredLinksPanelLoad =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly snapshot: AuthoredLinksSnapshot }
  | { readonly kind: "error"; readonly message: string };

export interface OpenAuthoredLinksPanel {
  readonly kind: "open";
  readonly owner: AuthoredLinksOwnerOccurrence;
  readonly generation: number;
  readonly outlinksCollapsed: boolean;
  readonly resourcesCollapsed: boolean;
  readonly load: AuthoredLinksPanelLoad;
}

export type AuthoredLinksPanel = { readonly kind: "closed" } | OpenAuthoredLinksPanel;

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
  readonly group: AuthoredLinkGroupName;
  readonly depth: number;
  readonly collapsed: boolean;
  readonly state: AuthoredLinkHeaderState;
}

export interface AuthoredLinkRow {
  readonly kind: "authored-link";
  readonly rowId: string;
  readonly parentRowId: string;
  readonly owner: AuthoredLinksOwnerOccurrence;
  readonly group: AuthoredLinkGroupName;
  readonly depth: number;
  readonly link: AuthoredOutlink | AuthoredResourceLink;
}

export type TreeDisplayRow = TreeRow | AuthoredLinkHeaderRow | AuthoredLinkRow;

export function isBlockTreeRow(row: TreeDisplayRow | undefined): row is TreeRow {
  return row?.kind === "physical" || row?.kind === "occurrence";
}

export function authoredLinkHeaderRowId(
  ownerRowId: string,
  group: AuthoredLinkGroupName,
): string {
  return JSON.stringify(["authored-links", ownerRowId, group]);
}

export function authoredLinkRowId(
  ownerRowId: string,
  group: AuthoredLinkGroupName,
  destinationKey: string,
): string {
  return JSON.stringify(["authored-links", ownerRowId, group, destinationKey]);
}

function headerState(
  panel: OpenAuthoredLinksPanel,
  group: AuthoredLinkGroupName,
): AuthoredLinkHeaderState {
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
  const linkGroup = group === "outlinks" ? snapshot.outlinks : snapshot.resources;
  return {
    kind: "ready",
    entryCount: linkGroup.entries.length,
    invalidCount: linkGroup.invalidCount,
    limited: linkGroup.completeness.kind === "limited",
    diagnostics: linkGroup.diagnostics,
  };
}

function headerRow(
  ownerRow: TreeRow,
  panel: OpenAuthoredLinksPanel,
  group: AuthoredLinkGroupName,
): AuthoredLinkHeaderRow {
  const collapsed = group === "outlinks"
    ? panel.outlinksCollapsed
    : panel.resourcesCollapsed;
  return {
    kind: "authored-link-header",
    rowId: authoredLinkHeaderRowId(ownerRow.rowId, group),
    parentRowId: ownerRow.rowId,
    owner: panel.owner,
    group,
    depth: ownerRow.depth + 1,
    collapsed,
    state: headerState(panel, group),
  };
}

function groupEntries(
  panel: OpenAuthoredLinksPanel,
  group: AuthoredLinkGroupName,
): readonly (AuthoredOutlink | AuthoredResourceLink)[] {
  if (panel.load.kind !== "ready" || panel.load.snapshot.kind !== "ready") return [];
  return group === "outlinks"
    ? panel.load.snapshot.outlinks.entries
    : panel.load.snapshot.resources.entries;
}

export function composeAuthoredLinkRows(
  blockRows: readonly TreeRow[],
  panel: AuthoredLinksPanel,
  ownerCollapsed?: boolean,
): TreeDisplayRow[] {
  if (panel.kind === "closed") return [...blockRows];
  const composed: TreeDisplayRow[] = [];
  for (const projectedRow of blockRows) {
    const ownsPanel =
      projectedRow.rowId === panel.owner.rowId &&
      projectedRow.canonicalId === panel.owner.blockId;
    const row: TreeRow = ownsPanel
      ? {
          ...projectedRow,
          hasChildren: true,
          collapsed: ownerCollapsed ?? projectedRow.collapsed,
        }
      : projectedRow;
    composed.push(row);
    if (!ownsPanel || row.collapsed) continue;
    for (const group of ["outlinks", "resources"] as const) {
      const header = headerRow(row, panel, group);
      composed.push(header);
      if (header.collapsed) continue;
      for (const link of groupEntries(panel, group)) {
        composed.push({
          kind: "authored-link",
          rowId: authoredLinkRowId(row.rowId, group, link.key),
          parentRowId: header.rowId,
          owner: panel.owner,
          group,
          depth: row.depth + 2,
          link,
        });
      }
    }
  }
  return composed;
}

export type AuthoredLinkActivation =
  | { readonly kind: "target"; readonly target: OutlinerNavigationTarget }
  | { readonly kind: "follow-page"; readonly address: string }
  | { readonly kind: "unavailable"; readonly reason: string };

export function authoredLinkActivation(row: AuthoredLinkRow): AuthoredLinkActivation {
  const { resolution } = row.link;
  if (resolution.kind === "ready") return { kind: "target", target: resolution.target };
  if (resolution.kind === "unregistered-page") {
    return { kind: "follow-page", address: resolution.address };
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
  return resolution.reason;
}

export function authoredLinkFallbackRowIds(row: TreeDisplayRow): readonly string[] {
  if (row.kind === "authored-link") {
    return [authoredLinkHeaderRowId(row.owner.rowId, row.group), row.owner.rowId];
  }
  if (row.kind === "authored-link-header") return [row.owner.rowId];
  return [];
}
