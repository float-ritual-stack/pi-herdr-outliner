export interface PreviewSourceSpan {
  start: number;
  end: number;
  startLine: number;
  endLine: number;
}

export type PreviewRegionKind =
  | "checklist"
  | "document-fold"
  | "body-link"
  | "annotation"
  | "annotation-thread"
  | "callout"
  | "backlinks"
  | "backlink-group"
  | "backlink-source"
  | "property-inspector"
  | "property-group"
  | "property-entry";

export type PreviewRegionAction =
  | { type: "checklist.open"; regionId: string }
  | { type: "document.disclosure.toggle"; regionId: string }
  | { type: "link.open"; uri: string }
  | { type: "preview.region.focus"; regionId: string }
  | { type: "annotation.disclosure.toggle"; regionId: string }
  | { type: "annotation.thread.select"; annotationId: string }
  | { type: "annotation.thread.reply"; annotationId: string }
  | { type: "annotation.thread.lifecycle"; annotationId: string }
  | { type: "annotation.thread.move"; delta: -1 | 1 }
  | { type: "callout.disclosure.toggle"; regionId: string }
  | { type: "backlinks.disclosure.toggle" }
  | { type: "backlink.open"; blockId: string }
  | { type: "backlink.source.disclosure.toggle"; blockId: string }
  | { type: "backlink.group.disclosure.toggle"; kind: string }
  | { type: "backlinks.control"; control: BacklinkControl }
  | { type: "property-inspector.disclosure.toggle" }
  | { type: "property-inspector.pane.open" }
  | { type: "property-inspector.value.copy"; occurrenceId: string }
  | { type: "property-inspector.target.open"; occurrenceId: string };

/** Panel-level backlink toggles, reachable by pointer as well as by key. */
export const BACKLINK_CONTROLS = ["kind", "stage", "resolved", "related", "sort"] as const;
export type BacklinkControl = (typeof BACKLINK_CONTROLS)[number];

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
    case "checklist.open":
      return `${DETAIL_PREVIEW_SCHEME}//checklist/${encodeURIComponent(action.regionId)}`;
    case "document.disclosure.toggle":
      return `${DETAIL_PREVIEW_SCHEME}//document-toggle/${encodeURIComponent(action.regionId)}`;
    case "link.open":
      return `${DETAIL_PREVIEW_SCHEME}//link-open/${encodeURIComponent(action.uri)}`;
    case "preview.region.focus":
      if (!action.regionId.trim()) throw new Error("Preview region ID cannot be empty");
      return `${DETAIL_PREVIEW_SCHEME}//focus/${encodeURIComponent(action.regionId)}`;
    case "annotation.thread.move":
      return `${DETAIL_PREVIEW_SCHEME}//annotation-${action.delta === 1 ? "next" : "previous"}`;
    case "annotation.thread.select":
    case "annotation.thread.reply":
    case "annotation.thread.lifecycle":
      if (!action.annotationId.trim()) throw new Error("Annotation ID cannot be empty");
      return `${DETAIL_PREVIEW_SCHEME}//${action.type.replaceAll(".", "-")}/${encodeURIComponent(action.annotationId)}`;
    case "annotation.disclosure.toggle":
      return `${DETAIL_PREVIEW_SCHEME}//annotation-toggle/${encodeURIComponent(action.regionId)}`;
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
    case "backlink.group.disclosure.toggle":
      if (!action.kind.trim()) throw new Error("Backlink group kind cannot be empty");
      return `${DETAIL_PREVIEW_SCHEME}//backlink-group/${encodeURIComponent(action.kind)}`;
    case "backlinks.control":
      return `${DETAIL_PREVIEW_SCHEME}//backlinks-control/${action.control}`;
    case "property-inspector.disclosure.toggle":
      return `${DETAIL_PREVIEW_SCHEME}//property-inspector-toggle`;
    case "property-inspector.pane.open":
      return `${DETAIL_PREVIEW_SCHEME}//property-inspector-pane`;
    case "property-inspector.value.copy":
      if (!action.occurrenceId.trim()) throw new Error("Property occurrence ID cannot be empty");
      return `${DETAIL_PREVIEW_SCHEME}//property-copy/${encodeURIComponent(action.occurrenceId)}`;
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
    case "checklist":
      if (!value) throw new Error("Invalid checklist control");
      return {type: "checklist.open", regionId: value};
    case "document-control":
    case "document-toggle":
      if (!value) throw new Error("Invalid document disclosure");
      return {type: "document.disclosure.toggle", regionId: value};
    case "link-open":
      if (!value) throw new Error("Invalid document link");
      return {type:"link.open",uri:value};
    case "focus":
      if (!value) throw new Error("Invalid Detail preview region");
      return { type: "preview.region.focus", regionId: value };
    case "annotation-next":
    case "annotation-previous":
      if (value) throw new Error("Invalid annotation navigation URI");
      return { type: "annotation.thread.move", delta: parsed.hostname === "annotation-next" ? 1 : -1 };
    case "annotation-thread-select":
    case "annotation-thread-reply":
    case "annotation-thread-lifecycle":
      if (!value) throw new Error("Invalid annotation thread URI");
      return { type: parsed.hostname.replaceAll("-", ".") as "annotation.thread.select" | "annotation.thread.reply" | "annotation.thread.lifecycle", annotationId: value };
    case "annotation-toggle":
      if (!value) throw new Error("Invalid Detail annotation region");
      return { type: "annotation.disclosure.toggle", regionId: value };
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
    case "backlink-group":
      if (!value) throw new Error("Invalid Detail backlink group");
      return { type: "backlink.group.disclosure.toggle", kind: value };
    case "backlinks-control":
      if (!BACKLINK_CONTROLS.includes(value as BacklinkControl)) throw new Error("Invalid Detail backlinks control");
      return { type: "backlinks.control", control: value as BacklinkControl };
    case "property-inspector-toggle":
      if (value) throw new Error("Invalid property inspector action URI");
      return { type: "property-inspector.disclosure.toggle" };
    case "property-inspector-pane":
      if (value) throw new Error("Invalid property inspector pane action URI");
      return { type: "property-inspector.pane.open" };
    case "property-copy":
      if (!value) throw new Error("Invalid property occurrence");
      return {type: "property-inspector.value.copy", occurrenceId: value};
    case "property-target":
      if (!value) throw new Error("Invalid property occurrence");
      return { type: "property-inspector.target.open", occurrenceId: value };
    default:
      throw new Error("Invalid Detail preview action URI");
  }
}

export type PreviewPointerResolution =
  | { type: "focus"; regionId: string }
  | {
      type: "activate";
      action: PreviewRegionAction;
      routing?: "linked" | "chooser";
    };

export function resolvePreviewPointerAction(
  action: PreviewRegionAction,
  activate: boolean,
): PreviewPointerResolution {
  if (action.type === "preview.region.focus") {
    return { type: "focus", regionId: action.regionId };
  }
  if (!activate && action.type === "backlink.open") {
    return { type: "focus", regionId: `backlink:${action.blockId}` };
  }
  if (action.type === "property-inspector.target.open") {
    return {
      type: "activate",
      action,
      routing: activate ? "chooser" : "linked",
    };
  }
  return { type: "activate", action };
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
  retainMissingDisclosures = false,
): void {
  state.regions = regions.map((region) => {
    const disclosure = region.disclosure
      ? {
          ...region.disclosure,
          expanded: state.disclosureOverrides.get(region.id) ??
            region.disclosure.expanded,
        }
      : null;
    return {
      ...region,
      childIds: [...region.childIds],
      disclosure,
    };
  });
  const focusable = visibleFocusableRegions(state.regions);
  if (!focusable.some((region) => region.id === state.focusedRegionId)) {
    state.focusedRegionId = null;
  }

  const liveIds = new Set(state.regions.map((region) => region.id));
  for (const id of state.disclosureOverrides.keys()) {
    if (!retainMissingDisclosures && !liveIds.has(id)) state.disclosureOverrides.delete(id);
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
  if (!expanded) {
    const byId = new Map(state.regions.map(candidate => [candidate.id, candidate]));
    let focused = byId.get(state.focusedRegionId ?? "");
    const visited = new Set<string>();
    while (focused?.parentId && !visited.has(focused.id)) {
      visited.add(focused.id);
      if (focused.parentId === regionId) {state.focusedRegionId = regionId; break;}
      focused = byId.get(focused.parentId);
    }
  }
  return expanded;
}
