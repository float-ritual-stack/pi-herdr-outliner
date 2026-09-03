import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import type {
  DetailEditorLayout,
  DetailEditorVisualRow,
} from "./detail-editor-layout";
import { TextBuffer } from "./text-buffer";
import { isPrintableInput, type TerminalKey } from "./terminal";

export type TextBufferEditorMoveDirection =
  | "left"
  | "right"
  | "up"
  | "down"
  | "home"
  | "end"
  | "word-left"
  | "word-right";

export type TextBufferEditorCommand =
  | { type: "save" }
  | { type: "cancel" }
  | { type: "select-all" }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "newline" }
  | { type: "backspace" }
  | { type: "delete" }
  | { type: "move"; direction: TextBufferEditorMoveDirection; extend?: boolean }
  | { type: "insert"; text: string }
  | { type: "redraw" };

export function textBufferEditorCommand(
  str: string,
  key: TerminalKey,
  modifiedEnter: boolean,
): TextBufferEditorCommand {
  if ((key.ctrl || key.meta) && key.name === "z") {
    return { type: key.shift ? "redo" : "undo" };
  }
  if (key.ctrl && key.name === "y") return { type: "redo" };
  if (key.ctrl && key.name === "s") return { type: "save" };
  if (key.name === "escape") return { type: "cancel" };
  if ((key.meta && key.name === "a") || (key.ctrl && key.shift && key.name === "a")) {
    return { type: "select-all" };
  }
  if (key.ctrl && key.name === "a") {
    return { type: "move", direction: "home", extend: key.shift };
  }
  if (key.ctrl && key.name === "e") {
    return { type: "move", direction: "end", extend: key.shift };
  }
  if (key.ctrl || key.meta) {
    if (key.name === "left" || key.name === "b") {
      return { type: "move", direction: "word-left", extend: key.shift };
    }
    if (key.name === "right" || key.name === "f") {
      return { type: "move", direction: "word-right", extend: key.shift };
    }
  }
  if (key.name === "return" || modifiedEnter) return { type: "newline" };
  if (key.name === "backspace") return { type: "backspace" };
  if (key.name === "delete") return { type: "delete" };
  if (
    key.name === "left" ||
    key.name === "right" ||
    key.name === "up" ||
    key.name === "down" ||
    key.name === "home" ||
    key.name === "end"
  ) {
    return { type: "move", direction: key.name, extend: key.shift };
  }
  if (isPrintableInput(str, key)) return { type: "insert", text: str };
  return { type: "redraw" };
}

export function applyTextBufferEditorCommand(
  buffer: TextBuffer,
  command: TextBufferEditorCommand,
): "changed" | "save" | "cancel" | "redraw" {
  if (command.type === "save" || command.type === "cancel" || command.type === "redraw") {
    return command.type;
  }
  if (command.type === "select-all") buffer.selectAll();
  else if (command.type === "undo") buffer.undo();
  else if (command.type === "redo") buffer.redo();
  else if (command.type === "newline") buffer.newline();
  else if (command.type === "backspace") buffer.backspace();
  else if (command.type === "delete") buffer.deleteForward();
  else if (command.type === "insert") buffer.insert(command.text);
  else if (command.direction === "left") buffer.moveLeft(command.extend);
  else if (command.direction === "right") buffer.moveRight(command.extend);
  else if (command.direction === "up") buffer.moveUp(command.extend);
  else if (command.direction === "down") buffer.moveDown(command.extend);
  else if (command.direction === "home") buffer.moveHome(command.extend);
  else if (command.direction === "end") buffer.moveEnd(command.extend);
  else if (command.direction === "word-left") buffer.moveWordLeft(command.extend);
  else buffer.moveWordRight(command.extend);
  return "changed";
}

function renderEditorText(
  row: DetailEditorVisualRow,
  startColumn: number,
  endColumn: number,
): string {
  const { selectionStartColumn, selectionEndColumn } = row;
  if (
    selectionStartColumn === null ||
    selectionEndColumn === null ||
    selectionEndColumn <= startColumn ||
    selectionStartColumn >= endColumn
  ) {
    return sliceByColumn(row.text, startColumn, endColumn - startColumn, true);
  }
  const selectedStart = Math.max(startColumn, selectionStartColumn);
  const selectedEnd = Math.min(endColumn, selectionEndColumn);
  const before = sliceByColumn(row.text, startColumn, selectedStart - startColumn, true);
  const selected = sliceByColumn(row.text, selectedStart, selectedEnd - selectedStart, true);
  const after = sliceByColumn(row.text, selectedEnd, endColumn - selectedEnd, true);
  return `${before}\x1b[7m${selected}\x1b[0m${after}`;
}

export function renderTextBufferEditorRow(
  layout: DetailEditorLayout,
  row: DetailEditorVisualRow,
  visualRowIndex: number,
): string {
  const prefix = row.continuation
    ? " ".repeat(layout.lineNumberWidth + 1)
    : `${String(row.logicalRow + 1).padStart(layout.lineNumberWidth)} `;
  const rowWidth = row.endColumn - row.startColumn;
  if (visualRowIndex !== layout.cursorRow) {
    return `${prefix}${renderEditorText(row, 0, rowWidth)}`;
  }
  const before = renderEditorText(row, 0, layout.cursorColumn);
  const afterWidth = Math.max(0, layout.contentWidth - visibleWidth(before) - 1);
  const after = renderEditorText(
    row,
    layout.cursorColumn,
    Math.min(rowWidth, layout.cursorColumn + afterWidth),
  );
  return `${prefix}${before}▏${after}`;
}
