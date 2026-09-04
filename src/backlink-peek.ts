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

export type BacklinkPeekDestination =
  | "default"
  | "replace"
  | "first-unlocked"
  | "split-right"
  | "split-down";

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
  destinationChooserOpen = false;
  private closed = false;

  constructor(
    readonly targetBlockId: string,
    readonly sources: readonly BacklinkSource[],
    selectedSourceBlockId: string,
    private readonly effects: BacklinkPeekEffects,
  ) {
    const selectedIndex = sources.findIndex((source) => source.blockId === selectedSourceBlockId);
    this.selectedIndex = selectedIndex < 0 ? 0 : selectedIndex;
  }

  get selectedSource(): BacklinkSource | undefined {
    return this.sources[this.selectedIndex];
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
    if (this.closed || inputAction === "suppress") return;
    if ((key.ctrl && key.name === "c") || str === "q") {
      await this.cancel();
      return;
    }
    if (this.destinationChooserOpen) {
      if (key.name === "escape") {
        this.destinationChooserOpen = false;
        this.status = "";
        this.effects.invalidate();
        return;
      }
      if (this.loading) return;
      if (key.name === "return") {
        await this.openDestination("default");
        return;
      }
      const destination = str === "R"
        ? "replace"
        : str.toLowerCase() === "f"
        ? "first-unlocked"
        : str.toLowerCase() === "r"
        ? "split-right"
        : str.toLowerCase() === "d"
        ? "split-down"
        : null;
      if (destination) await this.openDestination(destination);
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
      this.destinationChooserOpen = true;
      this.status = "Choose destination · default: first unlocked, otherwise split right";
      this.effects.invalidate();
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

  private async openDestination(destination: BacklinkPeekDestination): Promise<void> {
    const source = this.selectedSource;
    if (!source) return;
    this.loading = true;
    this.status = destination === "replace"
      ? `Replacing this Detail with ${source.title}…`
      : destination === "first-unlocked"
      ? `Opening ${source.title} in the first unlocked Detail…`
      : destination === "split-down"
      ? `Opening ${source.title} below…`
      : destination === "split-right"
      ? `Opening ${source.title} to the right…`
      : `Opening ${source.title}…`;
    this.effects.invalidate();
    try {
      if (destination === "replace") {
        await this.effects.replaceSource(source.blockId);
      } else {
        await this.effects.restoreSelection(source.blockId);
        if (destination === "first-unlocked") {
          if (!(await this.effects.openInFirstUnlocked(source.blockId))) {
            this.loading = false;
            this.status = "No unlocked Detail is available · choose ⇧R, R, or D";
            this.effects.invalidate();
            return;
          }
        } else if (destination === "split-down") {
          await this.effects.openInNewDetail(source.blockId, "down");
        } else if (destination === "split-right") {
          await this.effects.openInNewDetail(source.blockId, "right");
        } else if (!(await this.effects.openInFirstUnlocked(source.blockId))) {
          await this.effects.openInNewDetail(source.blockId, "right");
        }
      }
      this.closed = true;
      this.effects.close();
    } catch (error) {
      this.loading = false;
      this.status = `Open failed: ${error instanceof Error ? error.message : String(error)}`;
      this.effects.invalidate();
    }
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
  const status = controller.loading ? controller.status || "Loading…" : controller.status;
  output.push(truncateToWidth(`\x1b[2m${stripTerminalSequences(status)}\x1b[0m`, width));
  output.push(truncateToWidth(
    controller.destinationChooserOpen
      ? "⇧R replace here  f first unlocked  r split right  d split down  Esc close  Enter default"
      : "Esc cancel  ←/→ peek  ↑/↓ scroll  Enter choose destination",
    width,
  ));
  return output.join("\n");
}
