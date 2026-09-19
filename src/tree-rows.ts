import type {
  AuthoredLinkDiagnostic,
  AuthoredLinkGroup,
  AuthoredLinkGroupName,
  AuthoredLinksSnapshot,
  AuthoredOutlink,
  AuthoredResourceLink,
} from "./authored-links";
import type { AuthoredResourceReference, OutlinerNavigationTarget, VisibleBlock } from "./types";
import type { ProjectionBlock, TreeRow } from "./virtual-branches";

export interface AuthoredLinksOwnerOccurrence {
  readonly rowId: string;
  readonly blockId: string;
}

export interface AuthoredLinkGroupProvider {
  readonly group: AuthoredLinkGroupName;
  readonly label: string;
  select(
    snapshot: Extract<AuthoredLinksSnapshot, { readonly kind: "ready" }>,
  ): AuthoredLinkGroup<AuthoredOutlink | AuthoredResourceLink>;
}

export const AUTHORED_LINK_GROUP_PROVIDERS = [
  {
    group: "outlinks",
    label: "Outlinks",
    select: (snapshot) => snapshot.outlinks,
  },
  {
    group: "resources",
    label: "Resources",
    select: (snapshot) => snapshot.resources,
  },
] satisfies readonly AuthoredLinkGroupProvider[];

export type AuthoredLinksPanelLoad =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly snapshot: AuthoredLinksSnapshot }
  | { readonly kind: "error"; readonly message: string };

export interface OpenAuthoredLinksPanel {
  readonly kind: "open";
  readonly owner: AuthoredLinksOwnerOccurrence;
  readonly generation: number;
  readonly collapsedGroups: Readonly<Record<AuthoredLinkGroupName, boolean>>;
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
  readonly group: AuthoredLinkGroupName;
  readonly depth: number;
  readonly link: AuthoredOutlink | AuthoredResourceLink;
}

export type TreeDisplayRow<T extends ProjectionBlock = VisibleBlock> = TreeRow<T> | AuthoredLinkHeaderRow | AuthoredLinkRow;

export function isBlockTreeRow<T extends ProjectionBlock>(row: TreeDisplayRow<T> | undefined): row is TreeRow<T> {
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
  provider: AuthoredLinkGroupProvider,
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
  const linkGroup = provider.select(snapshot);
  return {
    kind: "ready",
    entryCount: linkGroup.entries.length,
    invalidCount: linkGroup.invalidCount,
    limited: linkGroup.completeness.kind === "limited",
    diagnostics: linkGroup.diagnostics,
  };
}

function headerRow<T extends ProjectionBlock>(
  ownerRow: TreeRow<T>,
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
  if (panel.load.kind !== "ready" || panel.load.snapshot.kind !== "ready") return [];
  return provider.select(panel.load.snapshot).entries;
}

function groupVisible(
  panel: OpenAuthoredLinksPanel,
  provider: AuthoredLinkGroupProvider,
): boolean {
  if (panel.load.kind !== "ready" || panel.load.snapshot.kind !== "ready") return true;
  const group = provider.select(panel.load.snapshot);
  return group.entries.length > 0 ||
    group.invalidCount > 0 ||
    group.diagnostics.length > 0 ||
    group.completeness.kind === "limited";
}

export function composeAuthoredLinkRows<T extends ProjectionBlock>(
  blockRows: readonly TreeRow<T>[],
  panel: AuthoredLinksPanel,
  ownerCollapsed?: boolean,
): TreeDisplayRow<T>[] {
  if (panel.kind === "closed") return [...blockRows];
  const composed: TreeDisplayRow<T>[] = [];
  for (const projectedRow of blockRows) {
    const ownsPanel =
      projectedRow.rowId === panel.owner.rowId &&
      projectedRow.canonicalId === panel.owner.blockId;
    const row: TreeRow<T> = ownsPanel
      ? {
          ...projectedRow,
          hasChildren: true,
          collapsed: ownerCollapsed ?? projectedRow.collapsed,
        }
      : projectedRow;
    composed.push(row);
    if (!ownsPanel || row.collapsed) continue;
    for (const provider of AUTHORED_LINK_GROUP_PROVIDERS) {
      if (!groupVisible(panel, provider)) continue;
      const header = headerRow(row, panel, provider);
      composed.push(header);
      if (header.collapsed) continue;
      for (const link of groupEntries(panel, provider)) {
        composed.push({
          kind: "authored-link",
          rowId: authoredLinkRowId(row.rowId, provider.group, link.key),
          parentRowId: header.rowId,
          owner: panel.owner,
          group: provider.group,
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
