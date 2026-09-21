import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { renderDetailReadPreviewLines } from "./detail-pi-preview";
import type { GotoController } from "./goto-controller";
import { sanitizeDynamicText } from "./terminal";
import type { DetailReadPreviewDocument } from "./detail-pi-preview";

// Rendered rows belong to this preview snapshot. Scrolling must not parse it again.
const renderedPreviews = new WeakMap<DetailReadPreviewDocument, { width: number; lines: string[] }>();
function previewLines(document: DetailReadPreviewDocument, width: number): string[] {
  const cached = renderedPreviews.get(document);
  if (cached?.width === width) return cached.lines;
  const lines = renderDetailReadPreviewLines(document, width, getMarkdownTheme())
    .map(line => line.replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, ""));
  if (document.truncated) lines.unshift("Preview shortened · open for full document", "");
  renderedPreviews.set(document, { width, lines });
  return lines;
}

export function gotoLayout(width: number, height: number, index: number) {
  const inner = Math.max(1, width - 4), body = Math.max(1, height - 7);
  const wide = inner >= 76;
  const listWidth = wide ? Math.floor(inner * 0.42) : inner;
  const listHeight = wide ? body : Math.max(2, Math.floor(body * 0.45));
  const slots = Math.max(1, Math.floor(listHeight / 2));
  const start = Math.max(0, index - slots + 1);
  return { inner, body, wide, listWidth, listHeight, slots, start, previewWidth: wide ? inner - listWidth - 1 : inner,
    previewHeight: wide ? body : Math.max(1, body - listHeight - 1) };
}

export function renderGotoFrame(controller: GotoController, width: number, height: number, help: string): string[] {
  if (width < 12 || height < 9) return Array.from({ length: Math.max(1, height) }, (_, i) => i === 0 ? truncateToWidth("Go to · enlarge terminal", Math.max(1, width)) : "");
  const layout = gotoLayout(width, height, controller.index);
  const { inner, body, wide, listWidth, listHeight, slots, start, previewWidth, previewHeight } = layout;
  const fit = (line: string, columns: number) => {
    const text = truncateToWidth(line, columns);
    return text + " ".repeat(Math.max(0, columns - visibleWidth(text)));
  };
  const bordered = (line: string) => ` │${fit(line, inner)}│ `;
  const selected = controller.selected;
  const query = sanitizeDynamicText(controller.query);
  const before = query.slice(0, controller.column), after = query.slice(controller.column);
  const cursorInput = `${sliceByColumn(before, Math.max(0, visibleWidth(before) - Math.max(1, inner - 8)), Math.max(1, inner - 8), true)}▏${after}`;
  const semanticStatus = controller.ranking ? "Jev ranking…" : controller.semantic.message ?? (controller.semantic.status === "ranked" ? "Jev ranked" : "Text matches");
  const status = controller.status || (controller.loading ? "Searching…" : controller.matches.length ? `${controller.matches.length} results · ${semanticStatus}${controller.completeness.kind === "truncated" ? " · more matches omitted" : ""}` : "No matches · try fewer words");
  const list: string[] = [];
  for (const [offset, match] of controller.matches.slice(start, start + slots).entries()) {
    const active = start + offset === controller.index;
    const line = fit(`${active ? "›" : " "} ${sanitizeDynamicText(match.title)}`, listWidth);
    list.push(active ? `\x1b[48;5;238m\x1b[1m${line}\x1b[0m` : line);
    list.push(fit(`  \x1b[2m${sanitizeDynamicText(match.path || match.block.id.slice(0, 8))}\x1b[0m`, listWidth));
  }
  const preview = controller.preview
    ? previewLines(controller.preview, previewWidth)
    : [controller.previewLoading ? "Loading preview…" : sanitizeDynamicText(controller.previewError || "Select a result to preview")];
  const maxOffset = Math.max(0, preview.length - Math.max(1, previewHeight - 1));
  controller.previewOffset = Math.min(controller.previewOffset, maxOffset);
  const previewRows = [truncateToWidth(`\x1b[33m${sanitizeDynamicText(selected?.title ?? "Preview")}\x1b[0m`, previewWidth), ...preview.slice(controller.previewOffset, controller.previewOffset + Math.max(1, previewHeight - 1))];
  const output = ["", ` ┌${"─".repeat(inner)}┐ `,
    bordered(`\x1b[1;36mGo to\x1b[0m  ${cursorInput}`), bordered(`\x1b[2m${sanitizeDynamicText(status)}\x1b[0m`)];
  for (let row = 0; row < body; row++) {
    if (wide) output.push(bordered(`${fit(list[row] ?? "", listWidth)}│${fit(previewRows[row] ?? "", previewWidth)}`));
    else output.push(bordered(row < listHeight ? list[row] ?? "" : row === listHeight ? "─".repeat(inner) : previewRows[row - listHeight - 1] ?? ""));
  }
  output.push(bordered(`\x1b[2m${help}\x1b[0m`), ` └${"─".repeat(inner)}┘ `, "");
  return output.slice(0, height);
}
