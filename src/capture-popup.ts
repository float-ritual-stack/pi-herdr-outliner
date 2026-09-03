import { truncateToWidth } from "@earendil-works/pi-tui";
import { layoutDetailEditor } from "./detail-editor-layout";
import { TextBuffer } from "./text-buffer";
import {
  applyTextBufferEditorCommand,
  renderTextBufferEditorRow,
  textBufferEditorCommand,
} from "./text-buffer-editor";
import { type TerminalInputAction, type TerminalKey } from "./terminal";

export interface CapturePopupSaveInput {
  requestId: string;
  text: string;
  capturedFromBlockId?: string;
}

export interface CapturePopupEffects {
  save(input: CapturePopupSaveInput): Promise<void>;
  close(): void;
  invalidate(): void;
}

export interface CapturePopupOptions {
  requestId: string;
  capturedFromBlockId?: string;
}

export class CapturePopupController {
  readonly buffer = new TextBuffer();
  status = "";
  saving = false;
  private closed = false;

  constructor(
    private readonly effects: CapturePopupEffects,
    private readonly options: CapturePopupOptions,
  ) {}

  handlePaste(text: string): void {
    if (this.closed || this.saving) return;
    this.buffer.insert(text);
    this.effects.invalidate();
  }

  async handleKeypress(
    str: string,
    key: TerminalKey,
    inputAction: TerminalInputAction,
  ): Promise<void> {
    if (this.closed || this.saving || inputAction === "suppress") return;
    if (key.ctrl && key.name === "c") {
      this.closed = true;
      this.effects.close();
      return;
    }
    const command = textBufferEditorCommand(
      str,
      key,
      inputAction === "modified-enter",
    );
    const result = applyTextBufferEditorCommand(this.buffer, command);
    if (result === "save") {
      await this.save();
      return;
    }
    if (result === "cancel") {
      this.closed = true;
      this.effects.close();
      return;
    }
    this.effects.invalidate();
  }

  private async save(): Promise<void> {
    const text = this.buffer.text.trim();
    if (!text) {
      this.status = "Capture text cannot be empty";
      this.effects.invalidate();
      return;
    }
    this.saving = true;
    this.status = "Saving…";
    this.effects.invalidate();
    try {
      await this.effects.save({
        requestId: this.options.requestId,
        text,
        capturedFromBlockId: this.options.capturedFromBlockId,
      });
      this.closed = true;
      this.effects.close();
    } catch (error) {
      this.saving = false;
      this.status = `Capture failed: ${error instanceof Error ? error.message : String(error)}`;
      this.effects.invalidate();
    }
  }
}


export function renderCapturePopupFrame(
  controller: CapturePopupController,
  width: number,
  height: number,
): string {
  const frameWidth = Math.max(1, Math.floor(width));
  const frameHeight = Math.max(1, Math.floor(height));
  const bodyHeight = Math.max(1, frameHeight - 4);
  const layout = layoutDetailEditor(
    controller.buffer.lines,
    controller.buffer.row,
    controller.buffer.column,
    frameWidth,
  );
  const firstVisibleRow = Math.max(
    0,
    Math.min(
      layout.cursorRow - Math.floor(bodyHeight / 2),
      Math.max(0, layout.rows.length - bodyHeight),
    ),
  );
  const output = [
    `\x1b[1m${truncateToWidth(
      `Quick capture · Inbox · line ${controller.buffer.row + 1}/${controller.buffer.lines.length}`,
      frameWidth,
      "…",
    )}\x1b[0m`,
    "─".repeat(frameWidth),
  ];
  for (let offset = 0; offset < bodyHeight; offset += 1) {
    const visualRow = firstVisibleRow + offset;
    const row = layout.rows[visualRow];
    output.push(
      row
        ? truncateToWidth(renderTextBufferEditorRow(layout, row, visualRow), frameWidth)
        : "",
    );
  }
  const status = controller.status || "Draft remains local until save succeeds";
  output.push(truncateToWidth(status, frameWidth, "…"));
  output.push(
    `\x1b[2m${truncateToWidth(
      "Enter newline · Ctrl+S save · Esc cancel",
      frameWidth,
      "…",
    )}\x1b[0m`,
  );
  return `\x1b[H\x1b[2J${output.slice(0, frameHeight).join("\n")}`;
}
