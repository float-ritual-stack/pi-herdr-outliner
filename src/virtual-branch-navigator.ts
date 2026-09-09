import {
  fuzzyFilter,
  Markdown,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";
import {
  renderDetailReadPreviewLines,
  sanitizeMarkdownDocument,
  type DetailReadPreviewDocument,
} from "./detail-pi-preview";
import {
  createOpenDestinationChooserState,
  OpenDestinationChooser,
  type OpenDestinationTarget,
} from "./open-destination-chooser";
import {
  DEFAULT_OUTLINER_ACTION_KEYMAP,
  type OutlinerActionKeymap,
} from "./outliner-actions";
import { blockDisplayTitle } from "./references";
import { sanitizeDynamicText, type TerminalInputAction, type TerminalKey } from "./terminal";
import {
  parseTreePrimaryClick,
  parseTreeWheelEvent,
  treeClickActivates,
} from "./tree-mouse";
import type { OutlinerClientRole } from "./types";
import {
  virtualBranchStateLabel,
  type VirtualBranchOccurrenceRow,
  type VirtualBranchState,
} from "./virtual-branches";

export interface VirtualBranchNavigatorLaunch {
  sourceClientId: string;
  sourceRole: OutlinerClientRole;
  browsingContextId: string;
  viewId: string;
  adapter?: "bookmark";
}

export interface VirtualBranchNavigatorProjection {
  title: string;
  rows: readonly VirtualBranchOccurrenceRow[];
  state: VirtualBranchState;
}

export type VirtualBranchNavigatorPreview =
  | {
    document: DetailReadPreviewDocument;
    target: OpenDestinationTarget;
  }
  | {
    document: DetailReadPreviewDocument;
    target: null;
    unavailableReason: string;
  };

export interface VirtualBranchNavigatorEffects {
  loadProjection(
    collapsedOccurrenceRowIds: ReadonlySet<string>,
  ): Promise<VirtualBranchNavigatorProjection>;
  loadPreview(row: VirtualBranchOccurrenceRow): Promise<VirtualBranchNavigatorPreview>;
  replaceTarget(blockId: string): Promise<void>;
  openInFirstUnlocked(blockId: string): Promise<boolean>;
  openInNewDetail(blockId: string, direction: "right" | "down"): Promise<void>;
  revealSource(blockId: string): Promise<void>;
  removeSelectedRecord?(row: VirtualBranchOccurrenceRow): Promise<void>;
  close(): void;
  invalidate(): void;
}

export interface VirtualBranchNavigatorOptions {
  destinationTimeoutMs?: number;
  actionKeymap?: OutlinerActionKeymap;
}

export interface VirtualBranchNavigatorMouseTarget {
  rowId: string;
  disclosureColumn: number;
}

export interface VirtualBranchNavigatorRenderResult {
  frame: string;
  mouseTargets: readonly (VirtualBranchNavigatorMouseTarget | null)[];
  listWidth: number;
  narrow: boolean;
}

const WIDE_MINIMUM_WIDTH = 84;
const SELECTED_ROW_STYLE = "\x1b[48;5;238m\x1b[1m";

function rowSearchText(row: VirtualBranchOccurrenceRow): string {
  return `${row.block.displayText} ${row.block.properties.map(({ key, value }) => `${key} ${value}`).join(" ")}`;
}

function selectedLine(line: string): string {
  return `${SELECTED_ROW_STYLE}${line.replaceAll("\x1b[0m", `\x1b[0m${SELECTED_ROW_STYLE}`)}\x1b[0m`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class VirtualBranchNavigatorController {
  title = "Virtual branch";
  rows: readonly VirtualBranchOccurrenceRow[] = [];
  visibleRows: readonly VirtualBranchOccurrenceRow[] = [];
  branchState: VirtualBranchState | null = null;
  selectedIndex = 0;
  filter = "";
  filterDraft: string | null = null;
  private loadedPreview: { rowId: string; value: VirtualBranchNavigatorPreview } | null = null;
  previewOffset = 0;
  listOffset = 0;
  status = "";
  loadingProjection = false;
  loadingPreview = false;
  projectionError = "";
  previewError = "";
  narrowPane: "list" | "preview" = "list";
  readonly destinationChooserState = createOpenDestinationChooserState();
  readonly collapsedOccurrenceRowIds = new Set<string>();
  private readonly actionKeymap: OutlinerActionKeymap;
  private readonly destinationChooser: OpenDestinationChooser;
  private refreshGeneration = 0;
  private previewGeneration = 0;
  private closed = false;

  constructor(
    readonly sourceRole: OutlinerClientRole,
    private readonly effects: VirtualBranchNavigatorEffects,
    options: VirtualBranchNavigatorOptions = {},
  ) {
    this.actionKeymap = options.actionKeymap ?? DEFAULT_OUTLINER_ACTION_KEYMAP;
    this.destinationChooser = new OpenDestinationChooser({
      replace: (target) => effects.replaceTarget(target.blockId),
      openFirstUnlocked: (target) => effects.openInFirstUnlocked(target.blockId),
      openNewDetail: (target, direction) => effects.openInNewDetail(target.blockId, direction),
      opened: () => this.finish(),
      invalidate: () => {
        this.status = this.destinationChooserState.status;
        effects.invalidate();
      },
    }, {
      state: this.destinationChooserState,
      ...(options.destinationTimeoutMs === undefined ? {} : { timeoutMs: options.destinationTimeoutMs }),
      actionKeymap: this.actionKeymap,
    });
  }

  get selectedRow(): VirtualBranchOccurrenceRow | undefined {
    return this.visibleRows[this.selectedIndex];
  }

  get canRemoveSelectedRecord(): boolean {
    return this.effects.removeSelectedRecord !== undefined;
  }

  get preview(): DetailReadPreviewDocument | null {
    return this.loadedPreview?.value.document ?? null;
  }

  get destinationChooserHelpText(): string {
    return this.destinationChooser.helpText();
  }


  async initialize(): Promise<void> {
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const generation = ++this.refreshGeneration;
    ++this.previewGeneration;
    this.loadingPreview = false;
    const previousRowId = this.selectedRow?.rowId;
    const previousIndex = this.selectedIndex;
    this.loadingProjection = true;
    this.effects.invalidate();
    try {
      const projection = await this.effects.loadProjection(this.collapsedOccurrenceRowIds);
      if (generation !== this.refreshGeneration || this.closed) return;
      this.title = projection.title;
      this.rows = projection.rows;
      this.branchState = projection.state;
      this.projectionError = "";
      this.applyFilter(previousRowId, previousIndex);
      this.startPreview();
    } catch (error) {
      if (generation !== this.refreshGeneration || this.closed) return;
      this.title = "Virtual branch";
      this.rows = [];
      this.visibleRows = [];
      this.branchState = null;
      this.selectedIndex = 0;
      this.loadedPreview = null;
      this.loadingPreview = false;
      this.projectionError = errorMessage(error);
      this.previewError = "";
    } finally {
      if (generation === this.refreshGeneration && !this.closed) {
        this.loadingProjection = false;
        this.effects.invalidate();
      }
    }
  }

  async handleKeypress(
    str: string,
    key: TerminalKey,
    inputAction: TerminalInputAction,
    viewportHeight: number,
    narrow: boolean,
  ): Promise<void> {
    if (this.closed || inputAction === "suppress") return;
    if (key.ctrl && key.name === "c") {
      this.cancel();
      return;
    }
    if (this.destinationChooserState.active) {
      await this.destinationChooser.handleKeypress(str, key);
      return;
    }
    if (this.filterDraft !== null) {
      this.handleFilterInput(str, key);
      return;
    }

    const mapped = this.actionKeymap.canonicalize(
      this.sourceRole,
      this.sourceRole === "tree" ? "browse" : "preview",
      str,
      key,
    );
    if (
      mapped.actionId === "tree.bookmark.toggle" ||
      mapped.actionId === "detail.bookmark.toggle"
    ) {
      await this.removeSelectedRecord();
      return;
    }
    if (
      mapped.actionId === "tree.current.reveal" ||
      mapped.actionId === "detail.current.reveal"
    ) {
      await this.revealSelected();
      return;
    }
    const directional = this.actionKeymap.canonicalize("detail", "destination", str, key);
    if (
      directional.actionId === "detail.pane.right" ||
      directional.actionId === "detail.pane.below"
    ) {
      this.openDestinationChooser();
      if (this.destinationChooserState.active) {
        await this.destinationChooser.handleKeypress(str, key);
      }
      return;
    }

    if (str === "q" || key.name === "escape") {
      this.cancel();
      return;
    }
    if (str === "/") {
      this.filterDraft = this.filter;
      this.status = "Filter projected rows";
      this.effects.invalidate();
      return;
    }
    if (key.name === "tab" && narrow) {
      this.narrowPane = this.narrowPane === "list" ? "preview" : "list";
      this.status = this.narrowPane === "list" ? "Showing projected rows" : "Showing selected preview";
      this.effects.invalidate();
      return;
    }
    if (key.name === "return") {
      this.openDestinationChooser();
      return;
    }
    if (key.name === "up") this.moveSelection(-1);
    else if (key.name === "down") this.moveSelection(1);
    else if (key.name === "pageup") this.scrollPreview(-Math.max(1, viewportHeight - 6));
    else if (key.name === "pagedown") this.scrollPreview(Math.max(1, viewportHeight - 6));
    else if (key.name === "home") this.previewOffset = 0;
    else if (key.name === "left" && (!narrow || this.narrowPane === "list")) await this.moveLeft();
    else if (key.name === "right" && (!narrow || this.narrowPane === "list")) await this.moveRight();
    else return;
    this.effects.invalidate();
  }

  async handleMouse(
    sequence: string,
    rendered: VirtualBranchNavigatorRenderResult,
  ): Promise<void> {
    if (this.closed || this.destinationChooserState.active || this.filterDraft !== null) return;
    const wheel = parseTreeWheelEvent(sequence);
    if (wheel) {
      const previewArea = rendered.narrow
        ? this.narrowPane === "preview"
        : wheel.column > rendered.listWidth;
      if (previewArea) this.scrollPreview(wheel.direction === "up" ? -3 : 3);
      else this.moveSelection(wheel.direction === "up" ? -1 : 1);
      this.effects.invalidate();
      return;
    }
    const click = parseTreePrimaryClick(sequence);
    if (!click) return;
    if (!rendered.narrow && click.column > rendered.listWidth) return;
    const target = rendered.mouseTargets[click.row];
    if (!target) return;
    const index = this.visibleRows.findIndex((row) => row.rowId === target.rowId);
    if (index < 0) return;
    const selectionChanged = this.selectedRow?.rowId !== target.rowId;
    this.selectedIndex = index;
    if (selectionChanged) this.startPreview();
    if (click.column === target.disclosureColumn) {
      await this.toggleDisclosure(target.rowId);
    } else if (treeClickActivates(click)) {
      this.openDestinationChooser();
    }
  }

  clampOffsets(viewportHeight: number, previewLineCount: number): void {
    const selected = this.selectedIndex;
    if (selected < this.listOffset) this.listOffset = selected;
    if (selected >= this.listOffset + viewportHeight) {
      this.listOffset = selected - viewportHeight + 1;
    }
    this.listOffset = Math.max(
      0,
      Math.min(this.listOffset, Math.max(0, this.visibleRows.length - viewportHeight)),
    );
    this.previewOffset = Math.max(
      0,
      Math.min(this.previewOffset, Math.max(0, previewLineCount - viewportHeight)),
    );
  }

  notice(): string {
    if (this.projectionError) return `UNAVAILABLE: ${this.projectionError}`;
    const state = this.branchState;
    if (!state) return this.loadingProjection ? "Loading virtual branch…" : "Virtual branch unavailable";
    if (state.configurationErrors.length > 0) {
      return `CONFIG ERROR: ${state.configurationErrors.join("; ")}`;
    }
    if (state.queryError) return `QUERY ERROR: ${state.queryError}`;
    if (this.filter && this.visibleRows.length === 0) return `No rows match “${this.filter}”`;
    if (state.queried && this.rows.length === 0) return "No projected rows";
    return `Virtual branch${virtualBranchStateLabel(state)}`;
  }

  private applyFilter(
    preferredRowId?: string,
    fallbackIndex = 0,
    query = this.filter,
  ): void {
    this.visibleRows = query
      ? fuzzyFilter([...this.rows], query, rowSearchText)
      : this.rows;
    const exactIndex = preferredRowId
      ? this.visibleRows.findIndex((row) => row.rowId === preferredRowId)
      : -1;
    this.selectedIndex = exactIndex >= 0
      ? exactIndex
      : Math.min(Math.max(0, fallbackIndex), Math.max(0, this.visibleRows.length - 1));
    this.listOffset = Math.min(this.listOffset, this.selectedIndex);
  }

  private handleFilterInput(str: string, key: TerminalKey): void {
    const previousRowId = this.selectedRow?.rowId;
    if (key.name === "escape") {
      this.filterDraft = null;
      this.applyFilter(previousRowId, 0);
      this.startPreview();
      this.status = "Filter unchanged";
    } else if (key.name === "return") {
      this.filter = this.filterDraft?.trim() ?? "";
      this.filterDraft = null;
      this.applyFilter(previousRowId, 0);
      this.startPreview();
      this.status = this.filter ? `Filtered by “${this.filter}”` : "Filter cleared";
    } else if (key.name === "backspace") {
      this.filterDraft = [...(this.filterDraft ?? "")].slice(0, -1).join("");
      this.applyFilter(previousRowId, 0, this.filterDraft);
      this.startPreview();
    } else if (str && !key.ctrl && !key.meta) {
      this.filterDraft += str;
      this.applyFilter(previousRowId, 0, this.filterDraft ?? "");
      this.startPreview();
    } else {
      return;
    }
    this.effects.invalidate();
  }

  private moveSelection(delta: number): void {
    if (this.visibleRows.length === 0) return;
    const next = Math.max(0, Math.min(this.visibleRows.length - 1, this.selectedIndex + delta));
    if (next === this.selectedIndex) {
      this.status = delta < 0 ? "First projected row" : "Last projected row";
      return;
    }
    this.selectedIndex = next;
    this.status = "";
    this.startPreview();
  }

  private async moveLeft(): Promise<void> {
    const selected = this.selectedRow;
    if (!selected) return;
    if (selected.hasChildren && !selected.collapsed) {
      await this.toggleDisclosure(selected.rowId);
      return;
    }
    const parentIndex = this.visibleRows.findIndex((row) => row.rowId === selected.parentRowId);
    if (parentIndex >= 0) {
      this.selectedIndex = parentIndex;
      this.startPreview();
    }
  }

  private async moveRight(): Promise<void> {
    const selected = this.selectedRow;
    if (!selected) return;
    if (selected.hasChildren && selected.collapsed) {
      await this.toggleDisclosure(selected.rowId);
      return;
    }
    const childIndex = this.visibleRows.findIndex((row) => row.parentRowId === selected.rowId);
    if (childIndex >= 0) {
      this.selectedIndex = childIndex;
      this.startPreview();
    }
  }

  private async toggleDisclosure(rowId: string): Promise<void> {
    if (!this.collapsedOccurrenceRowIds.delete(rowId)) this.collapsedOccurrenceRowIds.add(rowId);
    await this.refresh();
  }

  private startPreview(): void {
    const row = this.selectedRow;
    const generation = ++this.previewGeneration;
    this.previewOffset = 0;
    this.previewError = "";
    if (!row) {
      this.loadedPreview = null;
      this.loadingPreview = false;
      this.effects.invalidate();
      return;
    }
    this.loadingPreview = true;
    this.loadedPreview = null;
    this.effects.invalidate();
    void this.effects.loadPreview(row).then((preview) => {
      if (generation !== this.previewGeneration || this.closed || this.selectedRow?.rowId !== row.rowId) return;
      this.loadedPreview = { rowId: row.rowId, value: preview };
      this.loadingPreview = false;
      this.effects.invalidate();
    }).catch((error) => {
      if (generation !== this.previewGeneration || this.closed || this.selectedRow?.rowId !== row.rowId) return;
      this.loadedPreview = null;
      this.loadingPreview = false;
      this.previewError = errorMessage(error);
      this.effects.invalidate();
    });
  }

  private scrollPreview(delta: number): void {
    this.previewOffset = Math.max(0, this.previewOffset + delta);
  }

  private selectedPreview(): VirtualBranchNavigatorPreview | null {
    const row = this.selectedRow;
    if (
      !row ||
      this.loadingPreview ||
      this.loadedPreview?.rowId !== row.rowId
    ) return null;
    return this.loadedPreview.value;
  }

  private selectedTarget(): OpenDestinationTarget | null {
    return this.selectedPreview()?.target ?? null;
  }

  private selectedUnavailableReason(): string {
    if (this.loadingPreview) return "Loading preview… retry when it finishes";
    const preview = this.selectedPreview();
    return preview?.target === null
      ? preview.unavailableReason ?? "Selected target is not available"
      : "Selected target is not available";
  }

  private openDestinationChooser(): void {
    const row = this.selectedRow;
    if (!row) {
      this.status = "No projected row selected";
      this.effects.invalidate();
      return;
    }
    const target = this.selectedTarget();
    if (!target) {
      this.status = this.selectedUnavailableReason();
      this.effects.invalidate();
      return;
    }
    this.destinationChooser.open(target);
  }

  private async revealSelected(): Promise<void> {
    const target = this.selectedTarget();
    if (!target) {
      this.status = this.selectedUnavailableReason();
      this.effects.invalidate();
      return;
    }
    try {
      await this.effects.revealSource(target.blockId);
      this.finish();
    } catch (error) {
      this.status = errorMessage(error);
      this.effects.invalidate();
    }
  }

  private async removeSelectedRecord(): Promise<void> {
    const row = this.selectedRow;
    if (!row || !this.effects.removeSelectedRecord) return;
    if (row.relativeDepth !== 0) {
      this.status = "Select the bookmark record row to remove it";
      this.effects.invalidate();
      return;
    }
    try {
      await this.effects.removeSelectedRecord(row);
      await this.refresh();
      this.status = "Bookmark removed";
    } catch (error) {
      this.status = errorMessage(error);
    }
    this.effects.invalidate();
  }

  private cancel(): void {
    this.destinationChooser.dispose();
    this.finish();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    ++this.refreshGeneration;
    ++this.previewGeneration;
    this.effects.close();
  }
}

function renderListLine(
  row: VirtualBranchOccurrenceRow,
  selected: boolean,
  width: number,
): { line: string; disclosureColumn: number } {
  const indent = "  ".repeat(Math.max(0, row.relativeDepth));
  const disclosure = row.hasChildren ? (row.collapsed ? "▸" : "▾") : "•";
  const prefix = `${indent}${disclosure} `;
  const title = sanitizeDynamicText(blockDisplayTitle(row.block));
  const line = truncateToWidth(`${prefix}${title}`, width);
  return {
    line: selected ? selectedLine(line) : line,
    disclosureColumn: visibleWidth(indent),
  };
}

export function renderVirtualBranchNavigatorFrame(
  controller: VirtualBranchNavigatorController,
  width: number,
  height: number,
  theme: MarkdownTheme,
): VirtualBranchNavigatorRenderResult {
  const safeWidth = Math.max(20, width);
  const safeHeight = Math.max(8, height);
  const narrow = safeWidth < WIDE_MINIMUM_WIDTH;
  const listWidth = narrow ? safeWidth : Math.max(30, Math.floor((safeWidth - 1) * 0.4));
  const previewWidth = narrow ? safeWidth : Math.max(1, safeWidth - listWidth - 1);
  const bodyHeight = Math.max(1, safeHeight - 5);
  const previewStatus = controller.previewError
    ? `Preview failed: ${controller.previewError}`
    : controller.loadingPreview
    ? "Loading preview…"
    : controller.preview
    ? null
    : "No preview available.";
  const preview = controller.preview;
  const previewLines = previewStatus === null && preview
    ? renderDetailReadPreviewLines(preview, previewWidth, theme)
    : new Markdown(
      sanitizeMarkdownDocument(previewStatus ?? "No preview available."),
      0,
      0,
      theme,
    ).render(previewWidth);
  controller.clampOffsets(bodyHeight, previewLines.length);

  const title = sanitizeDynamicText(controller.title);
  const mode = narrow ? ` · ${controller.narrowPane}` : " · split";
  const output = [`\x1b[H\x1b[2J${truncateToWidth(`\x1b[1;36m${title}${mode}\x1b[0m`, safeWidth)}`];
  output.push(truncateToWidth(`\x1b[2m${stripTerminalSequences(controller.notice())}\x1b[0m`, safeWidth));
  output.push("─".repeat(safeWidth));
  const mouseTargets: Array<VirtualBranchNavigatorMouseTarget | null> = [null, null, null];

  const listRows = controller.visibleRows.slice(controller.listOffset, controller.listOffset + bodyHeight);
  for (let index = 0; index < bodyHeight; index += 1) {
    const row = listRows[index];
    const preview = previewLines[controller.previewOffset + index] ?? "";
    if (narrow && controller.narrowPane === "preview") {
      output.push(truncateToWidth(preview, safeWidth));
      mouseTargets.push(null);
      continue;
    }
    const rendered = row
      ? renderListLine(
        row,
        controller.visibleRows[controller.selectedIndex]?.rowId === row.rowId,
        listWidth,
      )
      : { line: "", disclosureColumn: 0 };
    if (narrow) {
      output.push(truncateToWidth(rendered.line, safeWidth));
    } else {
      const padding = " ".repeat(Math.max(0, listWidth - visibleWidth(rendered.line)));
      output.push(`${rendered.line}${padding}\x1b[2m│\x1b[0m${truncateToWidth(preview, previewWidth)}`);
    }
    mouseTargets.push(row ? { rowId: row.rowId, disclosureColumn: rendered.disclosureColumn } : null);
  }

  const status = controller.destinationChooserState.active
    ? controller.destinationChooserState.status
    : controller.filterDraft !== null
    ? `Filter: ${controller.filterDraft}▏`
    : controller.status;
  output.push(truncateToWidth(`\x1b[2m${stripTerminalSequences(status)}\x1b[0m`, safeWidth));
  output.push(truncateToWidth(
    controller.destinationChooserState.active
      ? controller.destinationChooserHelpText
      : `Esc/q close  ↑/↓ select  ←/→ disclose  / filter  Enter choose  ⇧R reveal${controller.canRemoveSelectedRecord ? "  ⌥M remove" : ""}${narrow ? "  Tab list/preview" : ""}`,
    safeWidth,
  ));
  mouseTargets.push(null, null);
  return { frame: output.join("\n"), mouseTargets, listWidth, narrow };
}
