import { describe, expect, test } from "bun:test";
import {
  CapturePopupController,
  renderCapturePopupFrame,
  type CapturePopupSaveInput,
} from "../src/capture-popup";

function popup(options: {
  save?: (input: CapturePopupSaveInput) => Promise<void>;
} = {}) {
  const saves: CapturePopupSaveInput[] = [];
  let closes = 0;
  let invalidations = 0;
  const controller = new CapturePopupController({
    async save(input) {
      saves.push(input);
      await options.save?.(input);
    },
    close() {
      closes += 1;
    },
    invalidate() {
      invalidations += 1;
    },
  }, {
    requestId: "capture-request",
    capturedFromBlockId: "origin",
  });
  return {
    controller,
    saves,
    closes: () => closes,
    invalidations: () => invalidations,
  };
}

describe("CapturePopupController", () => {
  test("edits and saves a multiline capture with fixed retry identity", async () => {
    const state = popup();
    await state.controller.handleKeypress("First line", { sequence: "First line" }, "pass");
    await state.controller.handleKeypress("", { name: "return" }, "pass");
    await state.controller.handleKeypress("Second line", { sequence: "Second line" }, "pass");

    const frame = renderCapturePopupFrame(state.controller, 60, 10);
    expect(frame).toContain("Quick capture · Inbox · line 2/2");
    expect(frame).toContain("First line");
    expect(frame).toContain("Second line▏");
    expect(frame).toContain("Enter newline · Ctrl+S save · Esc cancel");

    await state.controller.handleKeypress("", { name: "s", ctrl: true }, "pass");
    expect(state.saves).toEqual([{
      requestId: "capture-request",
      text: "First line\nSecond line",
      capturedFromBlockId: "origin",
    }]);
    expect(state.closes()).toBe(1);
  });

  test("retains the full draft and request ID after a failed save", async () => {
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
    expect(state.closes()).toBe(1);
  });

  test("cancels without saving", async () => {
    const state = popup();
    state.controller.handlePaste("Discard me");

    await state.controller.handleKeypress("", { name: "escape" }, "pass");

    expect(state.saves).toHaveLength(0);
    expect(state.closes()).toBe(1);
  });
});
