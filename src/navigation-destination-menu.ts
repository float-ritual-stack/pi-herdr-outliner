import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { OutlinerRequester } from "./client-target";
import { loadDetailReadPreview } from "./detail-read-preview";
import { renderDetailReadPreviewLines, type DetailReadPreviewDocument } from "./detail-pi-preview";
import { sanitizeDynamicText } from "./terminal";
import type { OutlinerActionMenuItem } from "./outliner-actions";
import type { Block, NavigationLinkState, OutlinerEvent, OutlinerViewAddress, ResourceDescription } from "./types";

type Destination = NavigationLinkState["destinations"][number];

/** A cached header projection of the service-owned link, never a routing authority. */
export class NavigationDestinationDisplay {
  text = "Loading destination…";
  private state: NavigationLinkState | undefined;
  private pending: Promise<void> | undefined;
  private requested = false;
  private disposed = false;

  constructor(private readonly client: OutlinerRequester, private readonly source: OutlinerViewAddress, private readonly invalidate: () => void) {}

  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.requested = true;
    return this.pending ??= this.load().finally(() => { this.pending = undefined; });
  }

  private async load(): Promise<void> {
    while (this.requested && !this.disposed) {
      this.requested = false;
      try {
        const state = await this.client.request<NavigationLinkState>({action: "navigation.link.get", source: this.source});
        if (this.disposed || this.requested) continue;
        this.state = state;
        const destination = state.destinations.find(item => item.view.clientId === state.destination?.clientId && item.view.region === state.destination.region);
        this.text = sanitizeDynamicText(destination?.label || (state.destination ? "Destination unavailable" : "Not linked"));
      } catch {
        if (this.disposed || this.requested) continue;
        this.text = "Destination unavailable";
      }
      this.invalidate();
    }
  }

  onEvent(event: OutlinerEvent): Promise<void> {
    const destination = this.state?.destination;
    const entry = this.state?.destinations.find(item => item.view.clientId === destination?.clientId && item.view.region === destination.region);
    if ((event.domain === "view" && (
      (event.action === "navigation.link.set" && event.clientId === this.source.clientId) ||
      (["clients.update", "clients.unregister"].includes(event.action) && !!destination && event.clientId === destination.clientId)
    )) || (event.domain === "content" && entry?.target?.kind === "block" && (!event.blockId || event.blockId === entry.target.blockId))) return this.refresh();
    return Promise.resolve();
  }

  dispose(): void { this.disposed = true; }
}

/** Lists existing logical Details without resolving targets or touching Resources. */
export function navigationDestinationItems(state: NavigationLinkState, unlink: boolean, showOther = false): OutlinerActionMenuItem[] {
  const items: OutlinerActionMenuItem[] = state.destinations.flatMap(({view, label, description, protection, otherLocation}, index) => !showOther && otherLocation ? [] : [{
    id: `destination:${index}`, label: sanitizeDynamicText(`${label}${state.destination?.clientId === view.clientId && state.destination.region === view.region ? " ← linked" : ""}`),
    description: sanitizeDynamicText(`${description ?? `${view.clientId} / ${view.region}`}${protection ? ` · protected: ${protection}` : ""}`),
    binding: "", group: "Pane",
  }]);
  const otherCount = state.destinations.filter(item => item.otherLocation).length;
  if (otherCount) items.push({id: "destination:other", label: `${showOther ? "Hide" : "Show"} other connected views (${otherCount})`, description: "Other hosts and readers whose pane location is unavailable", binding: "", group: "Pane"});
  if (unlink) items.push(
    {id: "destination:new-right", label: "New Detail right", description: "Open a new reader to the right; choose Link destination again to link it", binding: "", group: "Pane"},
    {id: "destination:new-below", label: "New Detail below", description: "Open a new reader below; choose Link destination again to link it", binding: "", group: "Pane"},
  );
  if (unlink && state.destinations.some(item => item.placementPaneId)) items.push(
    {id: "destination:place-right", label: "New Detail right of another…", description: "Choose a local reader beside which to create the new Detail", binding: "", group: "Pane"},
    {id: "destination:place-below", label: "New Detail below another…", description: "Choose a local reader below which to create the new Detail", binding: "", group: "Pane"},
  );
  if (unlink && state.destination) items.push({id: "destination:unlink", label: "Unlink destination", description: "Explicit Open will ask for a destination", binding: "", group: "Pane"});
  return items;
}

export function navigationPlacementItems(state: NavigationLinkState): OutlinerActionMenuItem[] {
  return [
    ...state.destinations.flatMap((item, index) => item.placementPaneId ? [{
      id: `placement:${index}`, label: sanitizeDynamicText(item.label),
      description: sanitizeDynamicText(item.description ?? "Local Detail"), binding: "", group: "Pane",
    }] : []),
    {id: "placement:back", label: "Back to destinations", description: "Return without creating a pane", binding: "", group: "Pane"},
  ];
}

export function navigationPlacementStatus(direction: "right" | "down"): string {
  return `Create ${direction === "right" ? "to the right of" : "below"} the selected reader · Enter creates · Esc cancels`;
}

export function navigationDestinationStatus(state: NavigationLinkState, purpose: "link" | "open" = "link", showOther = false): string {
  const linked = state.destinations.find(item => item.view.clientId === state.destination?.clientId && item.view.region === state.destination.region);
  const source = state.source.region === "tree" ? "Tree" : "Detail";
  const current = linked ? `${source} → ${linked.label}` : state.destination ? `${source} → destination unavailable` : `${source} has no linked destination`;
  return sanitizeDynamicText(`${current} · ${state.destinations.some(item => showOther || !item.otherLocation) ? `Select a reader · Enter to ${purpose === "link" ? "link" : "open once"}` : (state.destinations.some(item => item.otherLocation) ? (purpose === "link" ? "No nearby readers · create a Detail or show other connected views" : "No nearby readers · show other connected views") : (purpose === "link" ? "No available readers · create a Detail right or below" : "No available readers · cancel and open a Detail first"))} · Esc cancels`);
}

/** Disposable, read-only document inspection for either destination picker. */
export class NavigationDestinationPreview {
  document: DetailReadPreviewDocument | null = null;
  loading = false;
  error = "Select a reader to preview its document";
  private generation = 0;
  private selected: Destination | undefined;

  constructor(private readonly client: OutlinerRequester, private readonly invalidate: () => void) {}

  clear(): void {
    ++this.generation;
    this.selected = undefined;
    this.document = null;
    this.loading = false;
    this.error = "Select a reader to preview its document";
  }

  async select(destination: Destination | undefined): Promise<void> {
    if (destination === this.selected) return;
    this.clear();
    this.selected = destination;
    const target = destination?.target;
    if (!target) {
      this.error = destination ? "This reader has no document yet" : "Create a new reader, or select an existing destination";
      this.invalidate();
      return;
    }
    const generation = this.generation;
    this.loading = true;
    this.invalidate();
    try {
      let document: DetailReadPreviewDocument;
      if (target.kind === "block") {
        const block = await this.client.request<Block>({action: "get", blockId: target.blockId});
        document = await loadDetailReadPreview(this.client, block, 12_000);
      } else {
        const description = await this.client.request<ResourceDescription>({action: "resources.describe", destinationClientId: destination!.view.clientId, target});
        const text = description.filesystem?.text ?? description.web?.markdown ?? description.remoteEntity?.markdown ?? description.pdf?.markdown ?? description.computed?.markdown;
        if (text === undefined) throw new Error("No cached readable preview for this Resource");
        const boundary = text.length > 12_000 ? new Intl.Segmenter(undefined, {granularity: "grapheme"}).segment(text).containing(12_000)?.index ?? 12_000 : text.length;
        const clipped = text.slice(0, boundary);
        document = {canonicalText: clipped, resolvedText: clipped, projectedText: clipped, truncated: clipped.length < text.length, embedRanges: [], workIdPrefix: null};
      }
      if (generation !== this.generation) return;
      this.document = document;
      this.error = "";
    } catch (error) {
      if (generation !== this.generation) return;
      this.error = sanitizeDynamicText(error instanceof Error ? error.message : String(error));
    } finally {
      if (generation === this.generation) { this.loading = false; this.invalidate(); }
    }
  }
}

const renderedPreviews = new WeakMap<DetailReadPreviewDocument, {width: number; lines: string[]}>();
export function renderNavigationDestinationPreview(preview: NavigationDestinationPreview, width: number, height: number, offset = 0): string[] {
  width = Math.max(1, width);
  height = Math.max(1, height);
  let lines: string[];
  if (preview.document) {
    const cached = renderedPreviews.get(preview.document);
    if (cached?.width === width) lines = cached.lines;
    else {
      lines = renderDetailReadPreviewLines(preview.document, width, getMarkdownTheme())
        .map(line => line.replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, ""));
      if (preview.document.truncated) lines.unshift("Preview shortened · open for full document", "");
      renderedPreviews.set(preview.document, {width, lines});
    }
  } else lines = [preview.loading ? "Loading destination preview…" : sanitizeDynamicText(preview.error)];
  const start = Math.min(Math.max(0, offset), Math.max(0, lines.length - height));
  return Array.from({length: height}, (_, i) => truncateToWidth(lines[start + i] ?? "", width));
}
