import type { PreviewRegionAction } from "./detail-preview-regions";
import type { DetailController, DetailOpenRouting, DetailViewport } from "./detail-controller";
import type { OutlinerEvent, OutlinerNavigationTarget, OutlinerUiCommand } from "./types";

export interface DetailReaderRectangle { x: number; y: number; width: number; height: number }
export interface DetailReaderGeometry {
  arrangement: "single" | "beside" | "below" | "switch";
  current: DetailReaderRectangle;
  preview: DetailReaderRectangle;
}

export function detailReaderGeometry(width: number, height: number, previewVisible: boolean): DetailReaderGeometry {
  const full = {x: 0, y: 0, width, height};
  if (!previewVisible) return {arrangement: "single", current: full, preview: full};
  if (width >= 101) {
    const left = Math.floor((width - 1) / 2);
    return {arrangement: "beside", current: {...full, width: left}, preview: {...full, x: left + 1, width: width - left - 1}};
  }
  if (height >= 24) {
    const top = Math.floor((height - 1) / 2);
    return {arrangement: "below", current: {...full, height: top}, preview: {...full, y: top + 1, height: height - top - 1}};
  }
  return {arrangement: "switch", current: full, preview: full};
}

/** One retained reader and one inspection surface with its own comment draft. */
export class DetailReadingSurface {
  previewVisible = false;
  focused: "current" | "preview" = "current";

  constructor(
    readonly current: DetailController,
    readonly preview: DetailController,
    private readonly invalidate: () => void,
    private readonly releasePreview: () => Promise<void>,
  ) {}

  get active(): DetailController {
    return this.previewVisible && this.focused === "preview" ? this.preview : this.current;
  }

  toggleFocus(): void {
    if (!this.previewVisible) {
      this.current.onServiceError(new Error("Select an item to inspect in Preview"));
      return;
    }
    this.focused = this.focused === "current" ? "preview" : "current";
    this.invalidate();
  }

  async escapePreview(): Promise<boolean> {
    if (this.active !== this.preview) return false;
    const state = this.preview.state;
    if (this.preview.isBufferMode() || state.mode === "select" || state.selectionAnchor !== null ||
      state.destinationChooser.active || state.propertyInspector.edit ||
      state.propertyInspector.filterDraft !== null || state.backlinks.filterDraft !== null ||
      state.completion) return false;
    await this.closePreview();
    return true;
  }

  async closePreview(): Promise<void> {
    if (this.preview.isBufferMode()) {
      this.preview.onServiceError(new Error("Save or cancel the Preview draft before closing it"));
      return;
    }
    this.previewVisible = false;
    this.preview.releaseDocument();
    this.focused = "current";
    await this.releasePreview();
    this.invalidate();
  }

  async previewHere(target:OutlinerNavigationTarget,viewport:DetailViewport):Promise<void> {
    this.previewVisible=true;this.focused="preview";
    await this.preview.handleUiCommand({command:"preview",targetClientId:"local-preview",target},viewport);
    this.invalidate();
  }

  async receive(command: OutlinerUiCommand, viewport: DetailViewport): Promise<void> {
    if (command.command === "preview") {
      this.previewVisible = true;
      if (!this.current.state.target) this.focused = "preview";
      await this.preview.handleUiCommand(command, viewport);
    } else {
      this.focused = "current";
      await this.current.handleUiCommand(command, viewport);
    }
    this.invalidate();
  }

  async onServiceEvent(event: OutlinerEvent, viewport: DetailViewport): Promise<void> {
    if (event.domain === "ui" && event.command) return this.receive(event.command, viewport);
    await this.current.onServiceEvent(event, viewport);
    if (this.previewVisible && event.domain !== "attention") await this.preview.onServiceEvent(event, viewport);
  }

  async activatePreviewAction(action: PreviewRegionAction, viewport: DetailViewport, routing?: DetailOpenRouting): Promise<void> {
    await this.active.dispatch({type: "preview.action", action, ...(routing ? {routing} : {})}, viewport);
  }

  async keepPreview(viewport: DetailViewport): Promise<boolean> {
    const target: OutlinerNavigationTarget | null = this.preview.state.target;
    if (!this.previewVisible || !target) return false;
    return this.openHere(target, viewport);
  }

  async openHere(target: OutlinerNavigationTarget, viewport: DetailViewport): Promise<boolean> {
    if (this.preview.isBufferMode()) {
      this.preview.onServiceError(new Error("Save or cancel the Preview draft before opening another target"));
      return false;
    }
    if (this.current.isBufferMode() || this.current.state.selectionAnchor !== null) {
      this.preview.onServiceError(new Error("Finish or cancel the Current draft or source selection before keeping Preview"));
      return false;
    }
    await this.current.handleUiCommand({command: "replace", targetClientId: "local-current", target}, viewport);
    if (JSON.stringify(this.current.state.target) !== JSON.stringify(target)) return false;
    await this.closePreview();
    return true;
  }
}
