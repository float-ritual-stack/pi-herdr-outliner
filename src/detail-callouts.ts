import {
  Box,
  Markdown,
  truncateToWidth,
  visibleWidth,
  type Component,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";
import {
  previewRegionActionUri,
  type PreviewRegion,
  type PreviewRegionState,
  type PreviewSourceSpan,
} from "./detail-preview-regions";
import {
  DEFAULT_DETAIL_CALLOUT_THEME,
  detailCalloutStyle,
  type DetailCalloutStyle,
  type DetailCalloutTheme,
} from "./detail-callout-theme";

export type DetailCalloutFoldMarker = "+" | "-" | null;

export interface DetailCalloutRegion extends PreviewRegion {
  kind: "callout";
  calloutType: string;
  canonicalType: string;
  title: string;
  icon: string;
  foldMarker: DetailCalloutFoldMarker;
  depth: number;
  headerLine: number;
}

interface SourceLine {
  raw: string;
  text: string;
  start: number;
  end: number;
  index: number;
  quoteDepth: number;
  content: string;
}

interface MutableCallout {
  calloutType: string;
  canonicalType: string;
  title: string;
  icon: string;
  foldMarker: DetailCalloutFoldMarker;
  depth: number;
  headerLine: number;
  endLine: number;
  start: number;
  end: number;
  parent: MutableCallout | null;
  children: MutableCallout[];
  id: string;
}

const CALLOUT_TYPES: Record<string, { canonical: string; title: string }> = {
  note: { canonical: "note", title: "Note" },
  abstract: { canonical: "abstract", title: "Abstract" },
  summary: { canonical: "abstract", title: "Abstract" },
  tldr: { canonical: "abstract", title: "Abstract" },
  info: { canonical: "info", title: "Info" },
  todo: { canonical: "todo", title: "Todo" },
  tip: { canonical: "tip", title: "Tip" },
  hint: { canonical: "tip", title: "Tip" },
  important: { canonical: "tip", title: "Tip" },
  success: { canonical: "success", title: "Success" },
  check: { canonical: "success", title: "Success" },
  done: { canonical: "success", title: "Success" },
  question: { canonical: "question", title: "Question" },
  help: { canonical: "question", title: "Question" },
  faq: { canonical: "question", title: "Question" },
  warning: { canonical: "warning", title: "Warning" },
  caution: { canonical: "warning", title: "Warning" },
  attention: { canonical: "warning", title: "Warning" },
  failure: { canonical: "failure", title: "Failure" },
  fail: { canonical: "failure", title: "Failure" },
  missing: { canonical: "failure", title: "Failure" },
  danger: { canonical: "danger", title: "Danger" },
  error: { canonical: "danger", title: "Danger" },
  bug: { canonical: "bug", title: "Bug" },
  example: { canonical: "example", title: "Example" },
  quote: { canonical: "quote", title: "Quote" },
  cite: { canonical: "quote", title: "Quote" },
};

function fallbackTitle(type: string): string {
  return type.replace(/[-_]+/g, " ").replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}

function quoteContent(text: string): { depth: number; content: string } {
  let cursor = 0;
  let depth = 0;
  while (cursor < text.length) {
    const match = /^[ \t]{0,3}>[ \t]?/.exec(text.slice(cursor));
    if (!match) break;
    cursor += match[0].length;
    depth += 1;
  }
  return { depth, content: text.slice(cursor) };
}

function sourceLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  let index = 0;
  while (start < source.length) {
    const newline = source.indexOf("\n", start);
    const end = newline < 0 ? source.length : newline + 1;
    const raw = source.slice(start, end);
    const text = raw.endsWith("\n") ? raw.slice(0, -1).replace(/\r$/, "") : raw;
    const quoted = quoteContent(text);
    lines.push({ raw, text, start, end, index, quoteDepth: quoted.depth, content: quoted.content });
    start = end;
    index += 1;
  }
  return lines;
}

function stripQuoteDepth(text: string, depth: number): string {
  let cursor = 0;
  for (let level = 0; level < depth; level += 1) {
    const match = /^[ \t]{0,3}>[ \t]?/.exec(text.slice(cursor));
    if (!match) break;
    cursor += match[0].length;
  }
  return text.slice(cursor);
}

export function parseDetailCallouts(
  source: string,
  theme: DetailCalloutTheme = DEFAULT_DETAIL_CALLOUT_THEME,
): DetailCalloutRegion[] {
  const lines = sourceLines(source);
  const callouts: MutableCallout[] = [];

  for (const line of lines) {
    if (line.quoteDepth === 0) continue;
    const marker = /^\[!([^\]\r\n]+)\]([+-]?)(?:[ \t]+(.*))?[ \t]*$/.exec(line.content);
    if (!marker) continue;
    const calloutType = marker[1]!.trim().toLowerCase();
    if (!calloutType) continue;
    const known = CALLOUT_TYPES[calloutType];
    const foldMarker = marker[2] === "+" || marker[2] === "-" ? marker[2] : null;
    let endLine = line.index;
    for (let next = line.index + 1; next < lines.length; next += 1) {
      const candidate = lines[next]!;
      if (
        candidate.quoteDepth < line.quoteDepth ||
        (candidate.quoteDepth === line.quoteDepth &&
          /^\[![^\]\r\n]+\][+-]?(?:[ \t]+.*)?[ \t]*$/.test(candidate.content))
      ) {
        break;
      }
      endLine = next;
    }
    const end = lines[endLine]?.end ?? line.end;
    const parent = [...callouts].reverse().find((candidate) =>
      candidate.depth < line.quoteDepth && candidate.end >= line.start
    ) ?? null;
    const siblings = parent ? parent.children : callouts.filter((candidate) => candidate.parent === null);
    const path = parent
      ? `${parent.id.split(":", 2)[1]}.${siblings.length}`
      : `${siblings.length}`;
    const canonicalType = known?.canonical ?? calloutType;
    const current: MutableCallout = {
      calloutType,
      canonicalType,
      title: marker[3]?.trim() || known?.title || fallbackTitle(calloutType),
      icon: detailCalloutStyle(theme, canonicalType).glyph,
      foldMarker,
      depth: line.quoteDepth,
      headerLine: line.index,
      endLine,
      start: line.start,
      end,
      parent,
      children: [],
      id: `callout:${path}:${calloutType}`,
    };
    parent?.children.push(current);
    callouts.push(current);
  }

  return callouts.map((callout) => {
    const sourceSpan: PreviewSourceSpan = {
      start: callout.start,
      end: callout.end,
      startLine: callout.headerLine,
      endLine: callout.endLine,
    };
    const foldable = callout.foldMarker !== null;
    return {
      id: callout.id,
      kind: "callout",
      sourceSpan,
      parentId: callout.parent?.id ?? null,
      childIds: callout.children.map((child) => child.id),
      focusable: foldable,
      disclosure: foldable
        ? { defaultExpanded: callout.foldMarker !== "-", expanded: callout.foldMarker !== "-" }
        : null,
      activation: foldable ? { type: "callout.disclosure.toggle", regionId: callout.id } : null,
      calloutType: callout.calloutType,
      canonicalType: callout.canonicalType,
      title: callout.title,
      icon: callout.icon,
      foldMarker: callout.foldMarker,
      depth: callout.depth,
      headerLine: callout.headerLine,
    };
  });
}
export interface DetailCalloutDecoration {
  ranges: readonly { startLine: number; endLine: number }[];
  decorate(text: string): string;
}

function lineIsDecorated(
  line: number,
  decoration: DetailCalloutDecoration | undefined,
): boolean {
  return decoration?.ranges.some((range) =>
    range.startLine <= line && range.endLine >= line
  ) ?? false;
}

function markdownComponents(
  lines: readonly SourceLine[],
  textForLine: (line: SourceLine) => string,
  theme: MarkdownTheme,
  decoration: DetailCalloutDecoration | undefined,
): Component[] {
  const components: Component[] = [];
  let text = "";
  let decorated = false;

  function flush(): void {
    if (!text) return;
    const markdown = new Markdown(text, 0, 0, theme);
    if (!decorated || !decoration) {
      components.push(markdown);
    } else {
      const box = new Box(0, 0, decoration.decorate);
      box.addChild(markdown);
      components.push(box);
    }
    text = "";
  }

  for (const line of lines) {
    const nextDecorated = lineIsDecorated(line.index, decoration);
    if (text && nextDecorated !== decorated) flush();
    decorated = nextDecorated;
    text += textForLine(line);
  }
  flush();
  return components;
}


interface RenderPiece {
  component?: Component;
  child?: CalloutNode;
}
class BlankRows implements Component {
  constructor(private readonly count: number) {}

  render(_width: number): string[] {
    return Array.from({ length: this.count }, () => "");
  }

  invalidate(): void {}
}

const RESET_STYLE = "\x1b[0m";

function trueColorSequence(channel: 38 | 48, color: string): string {
  const red = Number.parseInt(color.slice(1, 3), 16);
  const green = Number.parseInt(color.slice(3, 5), 16);
  const blue = Number.parseInt(color.slice(5, 7), 16);
  return `\x1b[${channel};2;${red};${green};${blue}m`;
}

function renderCalloutLine(
  content: string,
  width: number,
  style: DetailCalloutStyle,
  focused = false,
): string {
  const accent = trueColorSequence(38, style.accent);
  const rail = `${focused ? "\x1b[1m" : ""}${accent}│${RESET_STYLE}`;
  if (width <= 1) return rail;

  const foreground = trueColorSequence(38, style.foreground);
  const background = trueColorSequence(48, style.background);
  const base = `${background}${foreground}${focused ? "\x1b[1;4m" : ""}`;
  const available = Math.max(0, width - 2);
  const fitted = truncateToWidth(content, available, "…");
  const styled = fitted.replaceAll(RESET_STYLE, `${RESET_STYLE}${base}`);
  const padding = " ".repeat(Math.max(0, available - visibleWidth(fitted)));
  return `${rail}${base} ${styled}${padding}${RESET_STYLE}`;
}

class CalloutNode {
  private readonly pieces: RenderPiece[];

  constructor(
    private readonly region: DetailCalloutRegion,
    lines: readonly SourceLine[],
    children: readonly DetailCalloutRegion[],
    allRegions: readonly DetailCalloutRegion[],
    private readonly theme: MarkdownTheme,
    private readonly state: Readonly<PreviewRegionState>,
    private readonly linksEnabled: boolean,
    private readonly decoration?: DetailCalloutDecoration,
    private readonly calloutTheme: DetailCalloutTheme = DEFAULT_DETAIL_CALLOUT_THEME,
  ) {
    this.pieces = [];
    let cursor = region.headerLine + 1;
    for (const child of children) {
      this.appendMarkdown(lines, cursor, child.headerLine);
      this.pieces.push({
        child: new CalloutNode(
          child,
          lines,
          allRegions.filter((candidate) => candidate.parentId === child.id),
          allRegions,
          theme,
          state,
          linksEnabled,
          decoration,
          calloutTheme,
        ),
      });
      cursor = child.sourceSpan!.endLine + 1;
    }
    this.appendMarkdown(lines, cursor, region.sourceSpan!.endLine + 1);
  }

  private appendMarkdown(lines: readonly SourceLine[], start: number, end: number): void {
    if (end <= start) return;
    const components = markdownComponents(
      lines.slice(start, end),
      (line) =>
        `${stripQuoteDepth(line.text, this.region.depth)}${line.raw.endsWith("\n") ? "\n" : ""}`,
      this.theme,
      this.decoration,
    );
    this.pieces.push(...components.map((component) => ({ component })));
  }

  render(width: number): string[] {
    const live = this.state.regions.find((candidate) => candidate.id === this.region.id) ?? this.region;
    const expanded = live.disclosure?.expanded ?? true;
    const focused = this.state.focusedRegionId === this.region.id;
    let disclosure = "•";
    if (live.disclosure) disclosure = expanded ? "−" : "+";
    const style = detailCalloutStyle(this.calloutTheme, this.region.canonicalType);
    const label = `${disclosure} ${style.glyph} ${this.region.title}`;
    const title = this.linksEnabled && live.activation
      ? new Markdown(`[${label}](${previewRegionActionUri(live.activation)})`, 0, 0, this.theme).render(Math.max(1, width - 2))[0] ?? label
      : label;
    const output = [renderCalloutLine(title, width, style, focused)];
    if (!expanded) return output;
    for (const piece of this.pieces) {
      const rendered = piece.child
        ? piece.child.render(Math.max(1, width - 2))
        : piece.component!.render(Math.max(1, width - 2));
      output.push(...rendered.map((line) => renderCalloutLine(line, width, style)));
    }
    return output;
  }
}

export class DetailCalloutDocument implements Component {
  private readonly pieces: RenderPiece[] = [];

  constructor(
    source: string,
    regions: readonly DetailCalloutRegion[],
    theme: MarkdownTheme,
    state: Readonly<PreviewRegionState>,
    linksEnabled: boolean,
    decoration?: DetailCalloutDecoration,
    calloutTheme: DetailCalloutTheme = DEFAULT_DETAIL_CALLOUT_THEME,
  ) {
    const lines = sourceLines(source);
    const roots = regions.filter((region) => region.parentId === null);
    let cursor = 0;
    let hasPreviousRoot = false;
    for (const root of roots) {
      if (root.headerLine > cursor) {
        const between = lines.slice(cursor, root.headerLine);
        if (
          hasPreviousRoot &&
          between.every((line) => line.quoteDepth === 0 && line.text.trim().length === 0)
        ) {
          this.pieces.push({ component: new BlankRows(between.length) });
        } else {
          this.pieces.push(...markdownComponents(
            between,
            (line) => line.raw,
            theme,
            decoration,
          ).map((component) => ({ component })));
        }
      }
      this.pieces.push({
        child: new CalloutNode(
          root,
          lines,
          regions.filter((region) => region.parentId === root.id),
          regions,
          theme,
          state,
          linksEnabled,
          decoration,
          calloutTheme,
        ),
      });
      cursor = root.sourceSpan!.endLine + 1;
      hasPreviousRoot = true;
    }
    if (cursor < lines.length) {
      this.pieces.push(...markdownComponents(
        lines.slice(cursor),
        (line) => line.raw,
        theme,
        decoration,
      ).map((component) => ({ component })));
    }
  }

  render(width: number): string[] {
    return this.pieces.flatMap((piece) =>
      piece.child ? piece.child.render(width) : piece.component!.render(width)
    );
  }

  invalidate(): void {
    for (const piece of this.pieces) piece.component?.invalidate();
  }
}
