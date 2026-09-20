import { expect, test } from "bun:test";
import { composedPointer, composedWidths } from "../src/composed-surface";

test("pointer coordinates retain source rows and subtract only the Detail rectangle's offset after resize", () => {
  for (const width of [30, 80, 200]) {
    const {tree, detail, detailX} = composedWidths(width);
    expect(tree + 1 + detail).toBe(width);
    expect(composedPointer(`\u001b[<0;${detailX + 8};13M`, width)).toEqual({region: "detail", data: "\u001b[<0;8;13M"});
    expect(composedPointer("\u001b[<0;2;13M", width)).toEqual({region: "tree", data: "\u001b[<0;2;13M"});
  }
  expect(composedPointer("e", 80)).toBeNull();
});
