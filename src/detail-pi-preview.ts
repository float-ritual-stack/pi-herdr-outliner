import {
  Key,
  Markdown,
  matchesKey,
  ScrollView,
  type Component,
  type MarkdownTheme,
  VStack,
} from "@earendil-works/pi-tui";
import type { DetailState } from "./detail-controller";
import {
  renderDetailFooter,
  renderDetailHeader,
} from "./detail-renderer";
import { sanitizeDynamicText } from "./terminal";

export function sanitizeMarkdownDocument(value: string): string {
  return sanitizeDynamicText(value, true);
}

const PREVIEW_HELP = "↑↓ line  ^U/D half  Fn+↑↓ page  g/G ends  Enter edit  q tree  ^Q close";

class DetailPreviewHeader implements Component {
  constructor(private readonly state: Readonly<DetailState>) {}

  render(width: number): string[] {
    return renderDetailHeader(this.state, width);
  }

  invalidate(): void {}
}

class DetailPreviewFooter implements Component {
  constructor(private readonly state: Readonly<DetailState>) {}

  render(width: number): string[] {
    return renderDetailFooter(this.state, width, "preview", PREVIEW_HELP);
  }

  invalidate(): void {}
}

export class DetailPiPreviewLayout extends VStack {
  readonly markdown: Markdown;
  readonly scrollView: ScrollView;
  private sourceText: string | undefined;

  private renderedText: string | undefined;
  private previousSelectionId: string | null | undefined;
  private active: boolean;
  private resetScroll = false;

  constructor(
    private readonly state: Readonly<DetailState>,
    markdownTheme: MarkdownTheme,
  ) {
    const markdown = new Markdown("", 0, 0, markdownTheme);
    const scrollView = new ScrollView(markdown, {
      primary: true,
      follow: "none",
      scrollbar: "always",
    });
    super([
      { component: new DetailPreviewHeader(state), basis: 3, shrink: 0 },
      { component: scrollView, grow: 1, shrink: 1, minSize: 1 },
      { component: new DetailPreviewFooter(state), basis: 2, shrink: 0 },
    ]);
    this.markdown = markdown;
    this.scrollView = scrollView;
    this.active = state.mode === "preview";
  }

  setActive(active: boolean): void {
    if (active && !this.active) this.resetScroll = true;
    this.active = active;
  }

  handleInput(data: string): boolean {
    if (!this.active || this.state.mode !== "preview") return false;

    if (matchesKey(data, Key.up)) this.scrollView.scrollBy(-1);
    else if (matchesKey(data, Key.down)) this.scrollView.scrollBy(1);
    else if (matchesKey(data, Key.ctrl("u"))) {
      this.scrollView.scrollBy(
        -Math.max(1, Math.floor(this.scrollView.viewportHeight / 2)),
      );
    } else if (matchesKey(data, Key.ctrl("d"))) {
      this.scrollView.scrollBy(
        Math.max(1, Math.floor(this.scrollView.viewportHeight / 2)),
      );
    } else if (matchesKey(data, Key.pageUp)) {
      this.scrollView.scrollBy(-Math.max(1, this.scrollView.viewportHeight));
    } else if (matchesKey(data, Key.pageDown)) {
      this.scrollView.scrollBy(Math.max(1, this.scrollView.viewportHeight));
    } else if (matchesKey(data, "g")) this.scrollView.scrollToStart();
    else if (matchesKey(data, Key.shift("g"))) this.scrollView.scrollToEnd();
    else return false;

    return true;
  }

  syncState(): void {
    if (!this.active) return;

    const selectionId = this.state.context.selected?.id ?? null;
    const selectionChanged = selectionId !== this.previousSelectionId;
    this.previousSelectionId = selectionId;
    const sourceText = this.state.context.selected
      ? this.state.resolvedSelectedText
      : "Select a block in the outliner pane.";
    if (sourceText !== this.sourceText) {
      this.sourceText = sourceText;
      // Preserve the complete document; source and Markdown render caches avoid repeated full-text work.
      this.renderedText = this.state.context.selected
        ? sanitizeMarkdownDocument(sourceText)
        : sourceText;
      this.markdown.setText(this.renderedText);
    }
    if (this.resetScroll || selectionChanged) this.scrollView.scrollToStart();
    this.resetScroll = false;
  }

  override render(width: number): string[] {
    this.syncState();
    return super.render(width);
  }
}

