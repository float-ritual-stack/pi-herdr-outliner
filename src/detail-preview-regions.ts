export interface PreviewSourceSpan {
  start: number;
  end: number;
  startLine: number;
  endLine: number;
}

export type PreviewRegionKind =
  | "callout"
  | "backlinks"
  | "backlink-source"
  | "property-inspector"
  | "property-group"
  | "property-entry";

export type PreviewRegionAction =
  | { type: "callout.disclosure.toggle"; regionId: string }
  | { type: "backlinks.disclosure.toggle" }
  | { type: "backlink.open"; blockId: string }
  | { type: "backlink.source.disclosure.toggle"; blockId: string }
  | { type: "property-inspector.disclosure.toggle" }
  | { type: "property-inspector.pane.open" }
  | { type: "property-inspector.target.open"; occurrenceId: string };

export interface PreviewRegionDisclosure {
  defaultExpanded: boolean;
  expanded: boolean;
}

export interface PreviewRegion {
  id: string;
  kind: PreviewRegionKind;
  sourceSpan: PreviewSourceSpan | null;
  parentId: string | null;
  childIds: string[];
  focusable: boolean;
  disclosure: PreviewRegionDisclosure | null;
  activation: PreviewRegionAction | null;
}

export interface PreviewRegionState {
  regions: PreviewRegion[];
  focusedRegionId: string | null;
  /** Session-only overrides. Canonical Markdown is never rewritten when a region folds. */
  disclosureOverrides: Map<string, boolean>;
}

const DETAIL_PREVIEW_SCHEME = "pi-outliner-detail:";

export function previewRegionActionUri(action: PreviewRegionAction): string {
  switch (action.type) {
    case "callout.disclosure.toggle":
      return `${DETAIL_PREVIEW_SCHEME}//callout-toggle/${encodeURIComponent(action.regionId)}`;
    case "backlinks.disclosure.toggle":
      return `${DETAIL_PREVIEW_SCHEME}//backlinks-toggle`;
    case "backlink.open":
      if (!action.blockId.trim()) throw new Error("Backlink source ID cannot be empty");
      return `${DETAIL_PREVIEW_SCHEME}//backlink-open/${encodeURIComponent(action.blockId)}`;
    case "backlink.source.disclosure.toggle":
      if (!action.blockId.trim()) throw new Error("Backlink source ID cannot be empty");
      return `${DETAIL_PREVIEW_SCHEME}//backlink-toggle/${encodeURIComponent(action.blockId)}`;
    case "property-inspector.disclosure.toggle":
      return `${DETAIL_PREVIEW_SCHEME}//property-inspector-toggle`;
    case "property-inspector.pane.open":
      return `${DETAIL_PREVIEW_SCHEME}//property-inspector-pane`;
    case "property-inspector.target.open":
      if (!action.occurrenceId.trim()) throw new Error("Property occurrence ID cannot be empty");
      return `${DETAIL_PREVIEW_SCHEME}//property-target/${encodeURIComponent(action.occurrenceId)}`;
  }
}

export function parsePreviewRegionActionUri(uri: string): PreviewRegionAction | null {
  if (!URL.canParse(uri)) return null;
  const parsed = new URL(uri);
  if (parsed.protocol !== DETAIL_PREVIEW_SCHEME) return null;
  if (parsed.search || parsed.hash) throw new Error("Invalid Detail preview action URI");

  const encoded = parsed.pathname.startsWith("/") ? parsed.pathname.slice(1) : parsed.pathname;
  let value: string;
  try {
    value = decodeURIComponent(encoded);
  } catch {
    throw new Error("Invalid Detail preview action encoding");
  }

  switch (parsed.hostname) {
    case "callout-toggle":
      if (!value) throw new Error("Invalid Detail callout region");
      return { type: "callout.disclosure.toggle", regionId: value };
    case "backlinks-toggle":
      if (value) throw new Error("Invalid Detail backlinks action URI");
      return { type: "backlinks.disclosure.toggle" };
    case "backlink-open":
      if (!value) throw new Error("Invalid Detail backlink source");
      return { type: "backlink.open", blockId: value };
    case "backlink-toggle":
      if (!value) throw new Error("Invalid Detail backlink source");
      return { type: "backlink.source.disclosure.toggle", blockId: value };
    case "property-inspector-toggle":
      if (value) throw new Error("Invalid property inspector action URI");
      return { type: "property-inspector.disclosure.toggle" };
    case "property-inspector-pane":
      if (value) throw new Error("Invalid property inspector pane action URI");
      return { type: "property-inspector.pane.open" };
    case "property-target":
      if (!value) throw new Error("Invalid property occurrence");
      return { type: "property-inspector.target.open", occurrenceId: value };
    default:
      throw new Error("Invalid Detail preview action URI");
  }
}

export function focusedPreviewRegion(
  state: Readonly<PreviewRegionState>,
): PreviewRegion | null {
  return state.regions.find((region) => region.id === state.focusedRegionId) ?? null;
}
function visibleFocusableRegions(
  regions: readonly PreviewRegion[],
): PreviewRegion[] {
  const byId = new Map(regions.map((region) => [region.id, region]));
  const visibility = new Map<string, boolean>();
  const visiting = new Set<string>();

  function isVisible(region: PreviewRegion): boolean {
    const cached = visibility.get(region.id);
    if (cached !== undefined) return cached;
    if (!region.parentId) {
      visibility.set(region.id, true);
      return true;
    }
    if (visiting.has(region.id)) return false;
    visiting.add(region.id);
    const parent = byId.get(region.parentId);
    const visible = Boolean(
      parent &&
        parent.disclosure?.expanded !== false &&
        isVisible(parent),
    );
    visiting.delete(region.id);
    visibility.set(region.id, visible);
    return visible;
  }

  return regions.filter((region) => region.focusable && isVisible(region));
}


export function reconcilePreviewRegions(
  state: PreviewRegionState,
  regions: readonly PreviewRegion[],
): void {
  state.regions = regions.map((region) => ({
    ...region,
    childIds: [...region.childIds],
    disclosure: region.disclosure && {
      ...region.disclosure,
      expanded: state.disclosureOverrides.get(region.id) ?? region.disclosure.defaultExpanded,
    },
  }));
  const focusable = visibleFocusableRegions(state.regions);
  if (!focusable.some((region) => region.id === state.focusedRegionId)) {
    state.focusedRegionId = null;
  }

  const liveIds = new Set(state.regions.map((region) => region.id));
  for (const id of state.disclosureOverrides.keys()) {
    if (!liveIds.has(id)) state.disclosureOverrides.delete(id);
  }
}

export function movePreviewRegionFocus(
  state: PreviewRegionState,
  delta: -1 | 1,
): PreviewRegion | null {
  const focusable = visibleFocusableRegions(state.regions);
  if (focusable.length === 0) {
    state.focusedRegionId = null;
    return null;
  }
  const current = focusable.findIndex((region) => region.id === state.focusedRegionId);
  let next: number;
  if (current >= 0) {
    next = (current + delta + focusable.length) % focusable.length;
  } else {
    next = delta > 0 ? 0 : focusable.length - 1;
  }
  state.focusedRegionId = focusable[next]!.id;
  return focusable[next]!;
}

export function togglePreviewRegionDisclosure(
  state: PreviewRegionState,
  regionId: string,
): boolean | null {
  const region = state.regions.find((candidate) => candidate.id === regionId);
  if (!region?.disclosure) return null;
  const expanded = !region.disclosure.expanded;
  state.disclosureOverrides.set(regionId, expanded);
  region.disclosure.expanded = expanded;
  return expanded;
}
