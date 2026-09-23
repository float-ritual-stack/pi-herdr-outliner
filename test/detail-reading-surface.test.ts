import { expect, test } from "bun:test";
import type { DetailController } from "../src/detail-controller";
import { DetailReadingSurface, detailReaderGeometry } from "../src/detail-reading-surface";

test("a common 120-column reader exposes Preview beside Current", () => {
  expect(detailReaderGeometry(120, 22, true)).toEqual({
    arrangement: "beside",
    current: {x: 0, y: 0, width: 59, height: 22},
    preview: {x: 60, y: 0, width: 60, height: 22},
  });
});

test("a narrow tall reader exposes Preview below Current with separate viewports", () => {
  expect(detailReaderGeometry(80, 31, true)).toEqual({
    arrangement: "below",
    current: {x: 0, y: 0, width: 80, height: 15},
    preview: {x: 0, y: 16, width: 80, height: 15},
  });
  expect(detailReaderGeometry(80, 20, true).arrangement).toBe("switch");
  expect(detailReaderGeometry(120, 40, false).current).toEqual({x: 0, y: 0, width: 120, height: 40});
});

function reader() {
  let releases = 0;
  const controller = {
    state: {
      target: {kind: "block", blockId: "retained"}, mode: "preview", selectionAnchor: null as number | null,
      destinationChooser: {active: false}, propertyInspector: {edit: null, filterDraft: null},
      backlinks: {filterDraft: null}, completion: null, buffer: {text: "retained draft"},
    },
    isBufferMode() { return this.state.mode === "edit" || this.state.mode === "comment"; },
    releaseDocument() { releases++; },
  };
  return {state: controller.state, controller: controller as unknown as DetailController, releases: () => releases};
}

test("Escape closes only focused Preview and leaves Current draft and selection intact", async () => {
  const current = reader(); const preview = reader(); let released = 0;
  const surface = new DetailReadingSurface(current.controller, preview.controller, () => {}, async () => {released++;});
  current.state.mode = "edit";
  current.state.selectionAnchor = 4;
  const before = JSON.stringify(current.controller.state);
  surface.previewVisible = true;
  expect(await surface.escapePreview()).toBe(false);
  surface.focused = "preview";
  expect(await surface.escapePreview()).toBe(true);
  expect(surface.previewVisible).toBe(false);
  expect(String(surface.focused)).toBe("current");
  expect(JSON.stringify(current.controller.state)).toBe(before);
  expect(current.releases()).toBe(0);
  expect(preview.releases()).toBe(1);
  expect(released).toBe(1);
});

test("Escape preserves a focused Preview file-line selection outside buffer mode", async () => {
  const current = reader(); const preview = reader(); let released = 0;
  const surface = new DetailReadingSurface(current.controller, preview.controller, () => {}, async () => {released++;});
  surface.previewVisible = true; surface.focused = "preview";
  preview.state.mode = "file";
  preview.state.selectionAnchor = 0;
  expect(preview.controller.isBufferMode()).toBe(false);
  expect(await surface.escapePreview()).toBe(false);
  expect(surface.previewVisible).toBe(true);
  expect(surface.focused).toBe("preview");
  expect(preview.state.selectionAnchor).toBe(0);
  expect(preview.releases()).toBe(0);
  expect(released).toBe(0);
  preview.state.selectionAnchor = null;
  expect(await surface.escapePreview()).toBe(true);
  expect(preview.releases()).toBe(1);
  expect(released).toBe(1);
});

test("Escape defers to Preview local editors, filters, chooser and source selection", async () => {
  const current = reader(); const preview = reader();
  const surface = new DetailReadingSurface(current.controller, preview.controller, () => {}, async () => {});
  surface.previewVisible = true; surface.focused = "preview";
  for (const mode of ["edit", "comment", "select"] as const) {
    preview.state.mode = mode;
    expect(await surface.escapePreview()).toBe(false);
  }
  preview.state.mode = "preview";
  preview.controller.state.destinationChooser.active = true;
  expect(await surface.escapePreview()).toBe(false);
  preview.controller.state.destinationChooser.active = false;
  preview.controller.state.backlinks.filterDraft = "query";
  expect(await surface.escapePreview()).toBe(false);
  preview.controller.state.backlinks.filterDraft = null;
  preview.controller.state.propertyInspector.filterDraft = "property";
  expect(await surface.escapePreview()).toBe(false);
  expect(surface.previewVisible).toBe(true);
  expect(preview.releases()).toBe(0);
});
