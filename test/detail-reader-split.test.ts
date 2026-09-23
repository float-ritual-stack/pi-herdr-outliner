import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "bun:test";
import { DetailReaderSplitLayout, DetailReaderVerticalLayout, renderDetailDestinationPicker } from "../src/detail-pi-renderer";

test("switching Current components and resizing invalidates only the displayed readers", () => {
  function pane(label: string) {
    let cachedText: string | undefined;
    return {
      version: 0,
      invalidations: 0,
      render(width: number): string[] {
        cachedText ??= `${label}${this.version}`;
        return [cachedText.padEnd(width)];
      },
      invalidate(): void {
        this.invalidations++;
        cachedText = undefined;
      },
    };
  }
  const current = pane("Current");
  const editor = pane("Editor");
  const preview = pane("Preview");
  const split = new DetailReaderSplitLayout(current, preview);
  current.render(30);
  editor.render(30);
  preview.render(30);

  for (let turn = 1; turn <= 12; turn++) {
    const active = turn % 2 ? editor : current;
    const inactive = active === current ? editor : current;
    for (const width of [150, 201, 160]) {
      active.version++;
      preview.version++;
      const activeInvalidations = active.invalidations;
      const inactiveInvalidations = inactive.invalidations;
      const previewInvalidations = preview.invalidations;
      split.setLayout(active, width);
      split.invalidate();
      const lines = split.render(width).map(stripTerminalSequences);
      const leftWidth = Math.floor((width - 1) / 2);
      expect(lines).toHaveLength(1);
      expect(lines[0]!.slice(0, leftWidth).trim()).toBe(`${active === current ? "Current" : "Editor"}${active.version}`);
      expect(lines[0]!.slice(leftWidth + 1).trim()).toBe(`Preview${preview.version}`);
      expect(visibleWidth(lines[0]!)).toBe(width);
      expect(active.invalidations).toBe(activeInvalidations + 1);
      expect(preview.invalidations).toBe(previewInvalidations + 1);
      expect(inactive.invalidations).toBe(inactiveInvalidations);
    }
  }
});

test("destination picker keeps purpose, choices and document preview visible beside or below", () => {
  for (const [width, height] of [[120, 22], [80, 31]] as const) {
    const rendered = renderDetailDestinationPicker({
      width, height, purpose: "link", status: "Detail has no linked destination", query: "research",
      list: () => ["Research notes", "New Detail right"],
      preview: () => ["SELECTED DOCUMENT", "A retained paragraph to recognize this destination"],
    });
    expect(rendered).toHaveLength(height);
    expect(rendered.every(line => visibleWidth(line) <= width)).toBe(true);
    const text = rendered.map(stripTerminalSequences).join("\n");
    expect(text).toContain("Link destination");
    expect(text).toContain("Detail has no linked destination");
    expect(text).toContain("Research notes");
    expect(text).toContain("SELECTED DOCUMENT");
    expect(text).toContain("Esc cancels");
  }
});

test("below layout keeps both documents visible within the resized terminal height", () => {
  const current = {render: (width: number) => Array.from({length: 100}, (_, i) => `Current ${i}`.padEnd(width)), invalidate() {}};
  const preview = {render: (width: number) => Array.from({length: 100}, (_, i) => `Preview ${i}`.padEnd(width)), invalidate() {}};
  const layout = new DetailReaderVerticalLayout(current, preview);
  for (const [width, height] of [[80, 31], [60, 24], [90, 40], [80, 31]]) {
    layout.setLayout(current, height!);
    const lines = layout.render(width!).map(stripTerminalSequences);
    expect(lines).toHaveLength(height!);
    expect(lines[0]!.trim()).toBe("Current 0");
    expect(lines[Math.floor((height! - 1) / 2) + 1]!.trim()).toBe("Preview 0");
    expect(lines.every(line => visibleWidth(line) <= width!)).toBe(true);
  }
});
