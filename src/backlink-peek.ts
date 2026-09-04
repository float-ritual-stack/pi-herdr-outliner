import {
  Markdown,
  stripTerminalSequences,
  truncateToWidth,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";
import {
  detailMarkdownPresentation,
  sanitizeMarkdownDocument,
} from "./detail-pi-preview";
import {
  createOpenDestinationChooserState,
  OpenDestinationChooser,
  openDestinationChooserHelp,
} from "./open-destination-chooser";
import type { TerminalInputAction, TerminalKey } from "./terminal";
import type { BacklinkSource, Block } from "./types";

export interface BacklinkPeekLaunch {
  sourceClientId: string;
  browsingContextId: string;
  targetBlockId: string;
  selectedSourceBlockId: string;
  filter: string;
  sortField: "created" | "updated";
  sortDirection: "asc" | "desc";
}

export interface BacklinkPeekPreview {
  block: Block;
  text: string;
  sourceLine: number;
}


export interface BacklinkPeekEffects {
  loadSource(source: BacklinkSource): Promise<BacklinkPeekPreview>;
  restoreSelection(sourceBlockId: string): Promise<void>;
  replaceSource(sourceBlockId: string): Promise<void>;
  openInFirstUnlocked(sourceBlockId: string): Promise<boolean>;
  openInNewDetail(
    sourceBlockId: string,
    direction: "right" | "down",
  ): Promise<void>;
  close(): void;
  invalidate(): void;
}

export class BacklinkPeekController {
  selectedIndex: number;
  preview: BacklinkPeekPreview | null = null;
  scrollOffset = 0;
  status = "";
  loading = false;
  readonly destinationChooserState = createOpenDestinationChooserState();
  private readonly destinationChooser: OpenDestinationChooser;
  private closed = false;

  constructor(
    readonly targetBlockId: string,
    readonly sources: readonly BacklinkSource[],
    selectedSourceBlockId: string,
    private readonly effects: BacklinkPeekEffects,
    destinationTimeoutMs?: number,
  ) {
    const selectedIndex = sources.findIndex((source) => source.blockId === selectedSourceBlockId);
    this.selectedIndex = selectedIndex < 0 ? 0 : selectedIndex;
    this.destinationChooser = new OpenDestinationChooser({
      beforeOpen: async (target, destination) => {
        if (destination !== "replace") await effects.restoreSelection(target.blockId);
      },
      replace: (target) => effects.replaceSource(target.blockId),
      openFirstUnlocked: (target) => effects.openInFirstUnlocked(target.blockId),
      openNewDetail: (target, direction) => effects.openInNewDetail(target.blockId, direction),
      opened: () => {
        this.closed = true;
        effects.close();
      },
      invalidate: () => {
        this.status = this.destinationChooserState.status;
        effects.invalidate();
      },
    }, {
      state: this.destinationChooserState,
      ...(destinationTimeoutMs === undefined ? {} : { timeoutMs: destinationTimeoutMs }),
    });
  }

  get selectedSource(): BacklinkSource | undefined {
    return this.sources[this.selectedIndex];
  }

  get destinationChooserOpen(): boolean {
    return this.destinationChooserState.active;
  }

  async initialize(): Promise<void> {
    await this.loadSelected();
  }

  async handleKeypress(
    str: string,
    key: TerminalKey,
    inputAction: TerminalInputAction,
    viewportHeight: number,
  ): Promise<void> {
    if (this.closed) return;
    if (key.ctrl && key.name === "c") {
      await this.cancel();
      return;
    }
    if (this.destinationChooserState.active) {
      await this.destinationChooser.handleKeypress(
        inputAction === "suppress" ? "" : str,
        inputAction === "suppress" ? { name: "input" } : key,
      );
      return;
    }
    if (inputAction === "suppress") return;
    if (str === "q") {
      await this.cancel();
      return;
    }
    if (key.name === "escape") {
      await this.cancel();
      return;
    }
    if (this.loading) return;
    if (key.name === "left") {
      await this.move(-1);
      return;
    }
    if (key.name === "right") {
      await this.move(1);
      return;
    }
    if (key.name === "return") {
      const source = this.selectedSource;
      if (source) {
        this.destinationChooser.open({ blockId: source.blockId, title: source.title });
      }
      return;
    }
    const page = Math.max(1, viewportHeight - 6);
    if (key.name === "up") this.scrollBy(-1);
    else if (key.name === "down") this.scrollBy(1);
    else if (key.name === "pageup") this.scrollBy(-page);
    else if (key.name === "pagedown") this.scrollBy(page);
    else if (key.name === "home") this.scrollOffset = 0;
    else return;
    this.effects.invalidate();
  }

  async move(delta: -1 | 1): Promise<void> {
    const next = this.selectedIndex + delta;
    if (next < 0 || next >= this.sources.length) {
      this.status = delta < 0 ? "First backlink source" : "Last backlink source";
      this.effects.invalidate();
      return;
    }
    this.selectedIndex = next;
    await this.loadSelected();
  }

  clampScroll(renderedLineCount: number, viewportHeight: number): void {
    const maximum = Math.max(0, renderedLineCount - Math.max(1, viewportHeight));
    this.scrollOffset = Math.min(this.scrollOffset, maximum);
  }

  private scrollBy(delta: number): void {
    this.scrollOffset = Math.max(0, this.scrollOffset + delta);
  }

  private async loadSelected(): Promise<void> {
    const source = this.selectedSource;
    if (!source) {
      this.preview = null;
      this.status = "No backlink source is available";
      this.effects.invalidate();
      return;
    }
    this.loading = true;
    this.status = `Loading ${source.title}…`;
    this.effects.invalidate();
    try {
      this.preview = await this.effects.loadSource(source);
      this.scrollOffset = Math.max(0, this.preview.sourceLine - 2);
      this.status = "";
    } catch (error) {
      this.preview = null;
      this.scrollOffset = 0;
      this.status = `Preview failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.loading = false;
      this.effects.invalidate();
    }
  }

  private async cancel(): Promise<void> {
    const source = this.selectedSource;
    this.destinationChooser.dispose();
    this.closed = true;
    if (source) {
      try {
        await this.effects.restoreSelection(source.blockId);
      } catch {
        // Closing the popup remains available after the source Detail disappears.
      }
    }
    this.effects.close();
  }

}

function occurrenceSummary(source: BacklinkSource): string {
  const count = source.occurrenceCount === 1 ? "1 reference" : `${source.occurrenceCount} references`;
  return `${source.parentContext} · ${count}`;
}

export function renderBacklinkPeekFrame(
  controller: Readonly<BacklinkPeekController>,
  width: number,
  height: number,
  theme: MarkdownTheme,
): string {
  const output = ["\x1b[H\x1b[2J"];
  const source = controller.selectedSource;
  const position = source
    ? `Backlink ${controller.selectedIndex + 1}/${controller.sources.length}`
    : "Backlink peek";
  output.push(truncateToWidth(`\x1b[1;36m${position}\x1b[0m  ${source?.title ?? "No source"}`, width));
  output.push(truncateToWidth(`\x1b[2m${source ? occurrenceSummary(source) : controller.targetBlockId}\x1b[0m`, width));
  output.push("─".repeat(Math.max(1, width)));

  const bodyHeight = Math.max(1, height - 6);
  const previewText = controller.preview?.text ?? "_No preview available._";
  const markdown = new Markdown(
    detailMarkdownPresentation(sanitizeMarkdownDocument(previewText)),
    0,
    0,
    theme,
  );
  const rendered = markdown.render(Math.max(1, width));
  output.push(...rendered.slice(controller.scrollOffset, controller.scrollOffset + bodyHeight));
  while (output.length < height - 2) output.push("");
  const status = controller.destinationChooserState.active
    ? controller.destinationChooserState.status
    : controller.loading
    ? controller.status || "Loading…"
    : controller.status;
  output.push(truncateToWidth(`\x1b[2m${stripTerminalSequences(status)}\x1b[0m`, width));
  output.push(truncateToWidth(
    controller.destinationChooserState.active
      ? openDestinationChooserHelp()
      : "Esc cancel  ←/→ peek  ↑/↓ scroll  Enter choose destination",
    width,
  ));
  return output.join("\n");
}
