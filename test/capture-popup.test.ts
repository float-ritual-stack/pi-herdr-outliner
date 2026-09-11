import { describe, expect, test } from "bun:test";
import {
  CapturePopupController,
  renderCapturePopupFrame,
  type CapturePopupSaveInput,
  type CapturePopupScheduler,
} from "../src/capture-popup";
import type {
  QuickCaptureDraft,
  QuickCaptureDraftSaveInput,
} from "../src/types";

function popup(options: {
  save?: (input: CapturePopupSaveInput) => Promise<void>;
  persistDraft?: (input: QuickCaptureDraftSaveInput) => Promise<QuickCaptureDraft>;
  clearDraft?: (expectedRevision: number | null) => Promise<void>;
  draft?: QuickCaptureDraft;
  requestId?: string;
  capturedFromBlockId?: string;
  scheduler?: CapturePopupScheduler;
} = {}) {
  const saves: CapturePopupSaveInput[] = [];
  const persists: QuickCaptureDraftSaveInput[] = [];
  const clears: Array<number | null> = [];
  let revision = options.draft?.revision ?? 0;
  let closes = 0;
  let invalidations = 0;
  const controller = new CapturePopupController({
    async save(input) {
      saves.push(input);
      await options.save?.(input);
    },
    async persistDraft(input) {
      persists.push(input);
      if (options.persistDraft) return await options.persistDraft(input);
      revision += 1;
      return {
        requestId: input.requestId,
        text: input.text,
        cursorRow: input.cursorRow,
        cursorColumn: input.cursorColumn,
        ...(input.capturedFromBlockId
          ? { capturedFromBlockId: input.capturedFromBlockId }
          : {}),
        revision,
        updatedAt: `2026-01-01T00:00:0${revision}.000Z`,
      };
    },
    async clearDraft(expectedRevision) {
      clears.push(expectedRevision);
      await options.clearDraft?.(expectedRevision);
    },
    close() {
      closes += 1;
    },
    invalidate() {
      invalidations += 1;
    },
  }, {
    requestId: options.requestId ?? "capture-request",
    capturedFromBlockId: options.capturedFromBlockId ?? "origin",
    draft: options.draft,
    scheduler: options.scheduler,
  });
  return {
    controller,
    saves,
    persists,
    clears,
    closes: () => closes,
    invalidations: () => invalidations,
  };
}

describe("CapturePopupController", () => {
  test("persists, captures, and clears a multiline draft with one retry identity", async () => {
    const state = popup();
    await state.controller.handleKeypress("First line", { sequence: "First line" }, "pass");
    await state.controller.handleKeypress("", { name: "return" }, "pass");
    await state.controller.handleKeypress("Second line", { sequence: "Second line" }, "pass");

    const frame = renderCapturePopupFrame(state.controller, 72, 10);
    expect(frame).toContain("Quick capture · Inbox · line 2/2");
    expect(frame).toContain("First line");
    expect(frame).toContain("Second line▏");
    expect(frame).toContain("Esc retain · Ctrl+D discard");

    await state.controller.handleKeypress("", { name: "s", ctrl: true }, "pass");
    expect(state.persists.at(-1)).toEqual({
      requestId: "capture-request",
      text: "First line\nSecond line",
      cursorRow: 1,
      cursorColumn: 11,
      capturedFromBlockId: "origin",
      expectedRevision: null,
    });
    expect(state.saves).toEqual([{
      requestId: "capture-request",
      text: "First line\nSecond line",
      capturedFromBlockId: "origin",
    }]);
    expect(state.clears).toEqual([1]);
    expect(state.closes()).toBe(1);
  });

  test("retains the full draft and request ID after a failed capture", async () => {
    let attempts = 0;
    const state = popup({
      async save() {
        attempts += 1;
        if (attempts === 1) throw new Error("service unavailable");
      },
    });
    state.controller.handlePaste("Retry title\nStill here");

    await state.controller.handleKeypress("", { name: "s", ctrl: true }, "pass");
    expect(state.controller.buffer.text).toBe("Retry title\nStill here");
    expect(state.controller.status).toBe("Capture failed: service unavailable");
    expect(state.closes()).toBe(0);

    await state.controller.handleKeypress("", { name: "s", ctrl: true }, "pass");
    expect(state.saves.map((input) => input.requestId)).toEqual([
      "capture-request",
      "capture-request",
    ]);
    expect(state.clears).toEqual([2]);
    expect(state.closes()).toBe(1);
  });

  test("retains on Escape and resumes text, cursor, identity, and original context", async () => {
    const first = popup();
    first.controller.handlePaste("Draft from first pane");
    await first.controller.handleKeypress("", { name: "left" }, "pass");
    await first.controller.handleKeypress("", { name: "escape" }, "pass");
    expect(first.closes()).toBe(1);

    const saved = first.persists.at(-1)!;
    const retained: QuickCaptureDraft = {
      requestId: saved.requestId,
      text: saved.text,
      cursorRow: saved.cursorRow,
      cursorColumn: saved.cursorColumn,
      capturedFromBlockId: saved.capturedFromBlockId,
      revision: 1,
      updatedAt: "2026-01-01T00:00:01.000Z",
    };
    const reopened = popup({
      draft: retained,
      requestId: "new-pane-request",
      capturedFromBlockId: "new-pane-origin",
    });
    expect(reopened.controller.buffer.text).toBe("Draft from first pane");
    expect(reopened.controller.buffer.column).toBe(20);
    expect(reopened.controller.status).toBe("Resumed retained draft");

    await reopened.controller.handleKeypress("", { name: "s", ctrl: true }, "pass");
    expect(reopened.saves[0]).toEqual({
      requestId: "capture-request",
      text: "Draft from first pane",
      capturedFromBlockId: "origin",
    });
  });

  test("requires confirmation before explicitly discarding a retained draft", async () => {
    const state = popup({
      draft: {
        requestId: "retained-request",
        text: "Discard me",
        cursorRow: 0,
        cursorColumn: 10,
        capturedFromBlockId: "original-pane",
        revision: 7,
        updatedAt: "2026-01-01T00:00:07.000Z",
      },
    });

    await state.controller.handleKeypress("", { name: "d", ctrl: true }, "pass");
    expect(state.controller.status).toBe("Press Ctrl+D again to discard this draft");
    expect(state.clears).toEqual([]);
    expect(state.closes()).toBe(0);

    await state.controller.handleKeypress("", { name: "d", ctrl: true }, "pass");
    expect(state.clears).toEqual([7]);
    expect(state.closes()).toBe(1);
  });

  test("debounces persistence while the popup remains open", async () => {
    let pending: (() => void) | undefined;
    const scheduler: CapturePopupScheduler = {
      set(callback) {
        pending = callback;
        return callback;
      },
      clear(handle) {
        if (pending === handle) pending = undefined;
      },
    };
    const persisted = Promise.withResolvers<void>();
    const state = popup({
      scheduler,
      async persistDraft(input) {
        persisted.resolve();
        return {
          requestId: input.requestId,
          text: input.text,
          cursorRow: input.cursorRow,
          cursorColumn: input.cursorColumn,
          capturedFromBlockId: input.capturedFromBlockId,
          revision: 1,
          updatedAt: "2026-01-01T00:00:01.000Z",
        };
      },
    });
    state.controller.handlePaste("First");
    state.controller.handlePaste(" second");
    expect(state.persists).toHaveLength(0);

    pending?.();
    await persisted.promise;
    expect(state.persists).toHaveLength(1);
    expect(state.persists[0]?.text).toBe("First second");
  });
});
