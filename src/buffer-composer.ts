import {
  CURSOR_MARKER,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { layoutDetailEditor } from "./detail-editor-layout";
import { sanitizeDynamicText } from "./terminal";
import type { TextBuffer } from "./text-buffer";

export interface BufferComposerModel {
  title: string;
  context: string;
  buffer: Readonly<TextBuffer>;
  placeholder: string;
  commitAction: string;
  cancelAction: string;
  viewportOffset?: number;
}

function pad(value: string, width: number): string {
  const clipped = truncateToWidth(value, Math.max(0, width));
  return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function framed(value: string, width: number): string {
  if (width < 2) return truncateToWidth(value, width);
  return `│${pad(value, width - 2)}│`;
}

export class BufferComposer implements Component {
  focused = true;

  constructor(private readonly model: () => BufferComposerModel) {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    const innerWidth = Math.max(1, safeWidth - 4);
    const model = this.model();
    const title = truncateToWidth(
      `─ ${sanitizeDynamicText(model.title)} `,
      Math.max(0, safeWidth - 2),
    );
    const top = safeWidth < 2
      ? "─".repeat(safeWidth)
      : `┌${title}${"─".repeat(Math.max(0, safeWidth - 2 - visibleWidth(title)))}┐`;
    const excerpt = sanitizeDynamicText(model.context.replace(/\s+/g, " ")).trim();
    const context = excerpt ? ` “${excerpt}”` : "";
    const editor = layoutDetailEditor(
      model.buffer.lines,
      model.buffer.row,
      model.buffer.column,
      innerWidth + 5,
    );
    const offset = Math.max(0, Math.floor(model.viewportOffset ?? 0));
    const body = editor.rows.slice(offset, offset + 3).map((row, index) => {
      let text = row.text;
      if (offset + index === editor.cursorRow && this.focused) {
        const before = sliceByColumn(text, 0, editor.cursorColumn, true);
        const after = sliceByColumn(text, editor.cursorColumn, Number.POSITIVE_INFINITY, true);
        const atCursor = sliceByColumn(after, 0, 1, true);
        const remainder = sliceByColumn(after, 1, Number.POSITIVE_INFINITY, true);
        text = `${before}${CURSOR_MARKER}\x1b[7m${atCursor || " "}\x1b[27m${remainder}`;
      }
      return framed(` ${text}`, safeWidth);
    });
    while (body.length < 3) body.push(framed("", safeWidth));
    if (!model.buffer.text && body.length > 0) {
      body[0] = framed(` \x1b[2m${sanitizeDynamicText(model.placeholder)}\x1b[0m`, safeWidth);
      if (this.focused) body[0] = body[0]!.replace("\x1b[2m", `${CURSOR_MARKER}\x1b[2m`);
    }
    const divider = safeWidth < 2 ? "─".repeat(safeWidth) : `├${"─".repeat(safeWidth - 2)}┤`;
    const footer = ` ${model.cancelAction} cancel · ${model.commitAction} save `;
    const bottom = safeWidth < 2
      ? "─".repeat(safeWidth)
      : `└${pad(footer, safeWidth - 2)}┘`;
    return [top, framed(context, safeWidth), divider, ...body, bottom];
  }

  invalidate(): void {}
}
