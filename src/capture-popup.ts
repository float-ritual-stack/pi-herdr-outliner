import { truncateToWidth } from "@earendil-works/pi-tui";
import { layoutDetailEditor } from "./detail-editor-layout";
import { TextBuffer } from "./text-buffer";
import {
  applyTextBufferEditorCommand,
  renderTextBufferEditorRow,
  textBufferEditorCommand,
} from "./text-buffer-editor";
import { type TerminalInputAction, type TerminalKey } from "./terminal";
import type { QuickCaptureDraft, QuickCaptureDraftSaveInput } from "./types";

export interface CapturePopupSaveInput {
  requestId: string;
  text: string;
  capturedFromBlockId?: string;
}

export interface CapturePopupEffects {
  save(input: CapturePopupSaveInput): Promise<void>;
  persistDraft(input: QuickCaptureDraftSaveInput): Promise<QuickCaptureDraft>;
  clearDraft(expectedRevision: number | null): Promise<void>;
  close(): void;
  invalidate(): void;
}

export interface CapturePopupScheduler {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export interface CapturePopupOptions {
  requestId: string;
  capturedFromBlockId?: string;
  draft?: QuickCaptureDraft;
  persistDelayMs?: number;
  scheduler?: CapturePopupScheduler;
}

const defaultScheduler: CapturePopupScheduler = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class CapturePopupController {
  readonly buffer: TextBuffer;
  status: string;
  saving = false;
  private closed = false;
  private readonly requestId: string;
  private readonly capturedFromBlockId: string | undefined;
  private draftRevision: number | null;
  private readonly persistDelayMs: number;
  private readonly scheduler: CapturePopupScheduler;
  private persistTimer: unknown;
  private persistenceTail: Promise<void> = Promise.resolve();
  private discardArmed = false;

  constructor(
    private readonly effects: CapturePopupEffects,
    options: CapturePopupOptions,
  ) {
    const draft = options.draft;
    this.requestId = draft?.requestId ?? options.requestId;
    this.capturedFromBlockId = draft?.capturedFromBlockId ?? options.capturedFromBlockId;
    this.draftRevision = draft?.revision ?? null;
    this.persistDelayMs = options.persistDelayMs ?? 250;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.buffer = new TextBuffer(draft?.text ?? "");
    if (draft) this.buffer.placeCursor(draft.cursorRow, draft.cursorColumn);
    this.status = draft ? "Resumed retained draft" : "";
  }

  handlePaste(text: string): void {
    if (this.closed || this.saving) return;
    this.discardArmed = false;
    this.buffer.insert(text);
    this.scheduleDraftPersistence();
    this.effects.invalidate();
  }

  async handleKeypress(
    str: string,
    key: TerminalKey,
    inputAction: TerminalInputAction,
  ): Promise<void> {
    if (this.closed || this.saving || inputAction === "suppress") return;
    if (key.ctrl && key.name === "c") {
      await this.closeRetainingDraft();
      return;
    }
    if (key.ctrl && key.name === "d") {
      await this.confirmDiscard();
      return;
    }
    this.discardArmed = false;
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
      await this.closeRetainingDraft();
      return;
    }
    if (result === "changed") this.scheduleDraftPersistence();
    this.effects.invalidate();
  }

  async retainDraft(): Promise<void> {
    if (this.closed) return;
    await this.flushDraft();
  }

  async closeRetainingDraft(): Promise<void> {
    if (this.closed) return;
    try {
      await this.flushDraft();
      this.closed = true;
      this.effects.close();
    } catch (error) {
      this.status = `Draft retain failed: ${error instanceof Error ? error.message : String(error)}`;
      this.effects.invalidate();
    }
  }

  private scheduleDraftPersistence(): void {
    this.clearPersistTimer();
    this.persistTimer = this.scheduler.set(() => {
      this.persistTimer = undefined;
      void this.enqueueDraftPersistence().catch(() => {});
    }, this.persistDelayMs);
  }

  private enqueueDraftPersistence(): Promise<void> {
    const text = this.buffer.text;
    const cursorRow = this.buffer.row;
    const cursorColumn = this.buffer.column;
    const operation = this.persistenceTail.then(async () => {
      if (!text.trim()) {
        if (this.draftRevision !== null) {
          await this.effects.clearDraft(this.draftRevision);
          this.draftRevision = null;
        }
        return;
      }
      const draft = await this.effects.persistDraft({
        requestId: this.requestId,
        text,
        cursorRow,
        cursorColumn,
        ...(this.capturedFromBlockId
          ? { capturedFromBlockId: this.capturedFromBlockId }
          : {}),
        expectedRevision: this.draftRevision,
      });
      this.draftRevision = draft.revision;
    });
    this.persistenceTail = operation.catch((error) => {
      this.status = `Draft retain failed: ${error instanceof Error ? error.message : String(error)}`;
      this.effects.invalidate();
    });
    return operation;
  }

  private async flushDraft(): Promise<void> {
    this.clearPersistTimer();
    await this.enqueueDraftPersistence();
  }

  private clearPersistTimer(): void {
    if (this.persistTimer === undefined) return;
    this.scheduler.clear(this.persistTimer);
    this.persistTimer = undefined;
  }

  private async confirmDiscard(): Promise<void> {
    if (!this.buffer.text.trim() && this.draftRevision === null) {
      this.closed = true;
      this.effects.close();
      return;
    }
    if (!this.discardArmed) {
      this.discardArmed = true;
      this.status = "Press Ctrl+D again to discard this draft";
      this.effects.invalidate();
      return;
    }
    this.clearPersistTimer();
    await this.persistenceTail;
    try {
      await this.effects.clearDraft(this.draftRevision);
      this.draftRevision = null;
      this.closed = true;
      this.effects.close();
    } catch (error) {
      this.discardArmed = false;
      this.status = `Discard failed: ${error instanceof Error ? error.message : String(error)}`;
      this.effects.invalidate();
    }
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
    let captured = false;
    try {
      await this.flushDraft();
      await this.effects.save({
        requestId: this.requestId,
        text,
        capturedFromBlockId: this.capturedFromBlockId,
      });
      captured = true;
      await this.effects.clearDraft(this.draftRevision);
      this.draftRevision = null;
      this.closed = true;
      this.effects.close();
    } catch (error) {
      this.saving = false;
      this.status = captured
        ? `Capture saved; draft cleanup failed: ${error instanceof Error ? error.message : String(error)}`
        : `Capture failed: ${error instanceof Error ? error.message : String(error)}`;
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
  const status = controller.status || "Draft retained automatically";
  output.push(truncateToWidth(status, frameWidth, "…"));
  output.push(
    `\x1b[2m${truncateToWidth(
      "Enter newline · Ctrl+S save · Esc retain · Ctrl+D discard",
      frameWidth,
      "…",
    )}\x1b[0m`,
  );
  return `\x1b[H\x1b[2J${output.slice(0, frameHeight).join("\n")}`;
}
