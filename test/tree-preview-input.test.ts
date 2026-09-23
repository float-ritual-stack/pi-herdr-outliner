import {expect, test} from "bun:test";
import {TreePreviewInput} from "../src/tree-preview-input";
import type {TreeController} from "../src/tree-controller";
import type {TreePreviewFrame} from "../src/tree-preview";

const pointer = (column: number, row: number, phase: "down" | "drag" | "up" = "down") => `\x1b[<${phase === "drag" ? 32 : 0};${column + 1};${row + 1}${phase === "up" ? "m" : "M"}`;
function fixture(placement: "beside" | "below") {
  const rect = placement === "beside" ? {x: 10, y: 0, width: 10, height: 10} : {x: 0, y: 10, width: 20, height: 10};
  const frame: TreePreviewFrame = {rect, content: {...rect, y: rect.y + 2, height: rect.height - 3}, lines: [], totalRows: 50, offset: 0, treeWidth: rect.x || rect.width, treeHeight: rect.y || rect.height, placement};
  let focused = false;
  const focusCalls: boolean[] = [];
  const controller = {focusLocalPreview(value = true) {focused = value; focusCalls.push(value);}, scrollLocalPreview() {}} as unknown as TreeController;
  const input = new TreePreviewInput();
  input.render(Array.from({length: 20}, () => "tree text preview text"), frame, undefined);
  return {input, controller, frame, focusCalls, focused: () => focused, send: (sequence: string) => input.handle(sequence, controller, () => {}, () => {})};
}

for (const placement of ["beside", "below"] as const) {
  test(`clicking Tree restores keyboard focus after clicking ${placement} Preview`, () => {
    const h = fixture(placement);
    const {x, y} = h.frame.content;
    expect(h.send(pointer(x + 1, y))).toBe(true);
    h.send(pointer(x + 1, y, "up"));
    expect(h.focused()).toBe(true);
    expect(h.send(pointer(2, 3))).toBe(false); // Tree adapter must still receive the click.
    expect(h.focused()).toBe(false);
    expect(h.focusCalls.at(-1)).toBe(false);
  });

  test(`a drag from ${placement} Preview stays focused until released outside`, () => {
    const h = fixture(placement);
    h.send(pointer(h.frame.content.x + 1, h.frame.content.y));
    expect(h.send(pointer(2, 3, "drag"))).toBe(true);
    expect(h.send(pointer(2, 3, "up"))).toBe(true);
    expect(h.focused()).toBe(true);
    expect(h.focusCalls).not.toContain(false);
  });
}
