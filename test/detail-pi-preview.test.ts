import {
  stripTerminalSequences,
  visibleWidth,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";
import { describe, expect, test } from "bun:test";
import type { DetailState } from "../src/detail-controller";
import {
  DetailPiPreviewLayout,
  sanitizeMarkdownDocument,
} from "../src/detail-pi-preview";
import { TextBuffer } from "../src/text-buffer";
import type { Block } from "../src/types";

function block(id: string, text: string): Block {
  return {
    id,
    parentId: null,
    position: 0,
    text,
    author: "user",
    collapsed: false,
    createdAt: "created",
    updatedAt: "updated",
    properties: [],
  };
}

function state(text: string): DetailState {
  const selected = block("block-1", "raw edit source");
  return {
    context: { selected, ancestors: [], children: [] },
    resolvedSelectedText: text,
    resolvedBreadcrumb: "Resolved block",
    mode: "preview",
    buffer: new TextBuffer(),
    referencedFile: null,
    previewOffset: 0,
    editorVisualOffset: 0,
    fileOffset: 0,
    fileCursor: 0,
    selectionAnchor: null,
    annotationRange: null,
    completion: null,
    status: "",
    busy: false,
    refreshPending: false,
  };
}

const plainMarkdownTheme: MarkdownTheme = {
  heading: (text) => text,
  link: (text) => text,
  linkUrl: (text) => text,
  code: (text) => text,
  codeBlock: (text) => text,
  codeBlockBorder: (text) => text,
  quote: (text) => text,
  quoteBorder: (text) => text,
  hr: (text) => text,
  listBullet: (text) => text,
  bold: (text) => text,
  italic: (text) => text,
  strikethrough: (text) => text,
  underline: (text) => text,
};

function previewLayout(detail: DetailState): DetailPiPreviewLayout {
  return new DetailPiPreviewLayout(detail, plainMarkdownTheme);
}

function renderedDocument(layout: DetailPiPreviewLayout, width: number): string[] {
  layout.render(width);
  return layout.markdown.render(width).map(stripTerminalSequences);
}


  test("synchronizes Markdown before the viewport layout renders child nodes directly", () => {
    const detail = state("Body rendered by the child Markdown component");
    const layout = previewLayout(detail);

    layout.syncState();

    expect(
      layout.markdown.render(40).map(stripTerminalSequences).join(" ").replace(/\s+/g, " "),
    ).toContain("Body rendered by the child Markdown component");
  });
describe("Pi Markdown detail preview", () => {
  test("wraps long document lines without ellipsizing and hangs list continuations", () => {
    const detail = state([
      "A deliberately long paragraph with enough words to wrap across several terminal rows without losing its ending.",
      "",
      "- alpha beta gamma delta epsilon zeta eta theta",
    ].join("\n"));
    const layout = previewLayout(detail);
    const lines = renderedDocument(layout, 24);

    expect(lines.length).toBeGreaterThan(4);
    expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);
    expect(lines.map((line) => line.trimEnd()).join(" ").replace(/\s+/g, " ")).toContain(
      "without losing its ending",
    );
    expect(lines.join("\n")).not.toContain("…");

    const listStart = lines.findIndex((line) => line.startsWith("- alpha"));
    expect(listStart).toBeGreaterThanOrEqual(0);
    expect(lines[listStart + 1]).toMatch(/^  \S/);
  });

  test("keeps the custom header, rule, status, and help outside the document body", () => {
    const detail = state("Body text");
    detail.status = "Ready";
    const lines = previewLayout(detail).render(32).map(stripTerminalSequences);

    expect(lines[0]).toBe("");
    expect(lines[1]).toContain("Detail  Resolved block");
    expect(lines[2]).toBe("─".repeat(32));
    expect(lines.at(-2)).toBe("Ready");
    expect(lines.at(-1)).toContain("^U/D half");
    expect(previewLayout(detail).scrollView.scrollbar).toBe("always");
  });

  test("keeps the selected breadcrumb leaf visible in a narrow header", () => {
    const detail = state("Body text");
    detail.resolvedBreadcrumb =
      "A very long workspace title › A very long parent title › Selected leaf";
    const lines = previewLayout(detail).render(42).map(stripTerminalSequences);

    expect(lines[1]).toContain("… › Selected leaf");
  });

  test("sanitizes the complete resolved document before Markdown parses it", () => {
    const safe = sanitizeMarkdownDocument(
      "Resolved **block**\nsecond\tline\x1b]0;owned\nstill owned\x07done\x90payload\x1b\\tail",
    );
    expect(safe).toBe("Resolved **block**\nsecond    linedonetail");

    const layout = previewLayout(state(safe));
    const rendered = renderedDocument(layout, 40).join("\n");
    expect(rendered).toContain("Resolved block");
    expect(rendered).toContain("second    linedonetail");
    expect(rendered).not.toContain("owned");
    expect(rendered).not.toContain("payload");
  });

  test("scrolls the primary view by contracted amounts and reaches long content", () => {
    const detail = state(Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n"));
    const layout = previewLayout(detail);
    layout.scrollView.setScrollbar("hidden");
    const contentHeight = renderedDocument(layout, 20).length;
    layout.scrollView.updateLayout(contentHeight, 6, () => {});

    expect(layout.handleInput("\x1b[B")).toBe(true);
    expect(layout.handleInput("\x04")).toBe(true);
    expect(layout.scrollView.scrollTop).toBe(4);
    expect(layout.handleInput("\x15")).toBe(true);
    expect(layout.scrollView.scrollTop).toBe(1);
    expect(layout.handleInput("\x1b[6~")).toBe(true);
    expect(layout.scrollView.scrollTop).toBe(7);
    expect(layout.handleInput("\x1b[5~")).toBe(true);
    expect(layout.scrollView.scrollTop).toBe(1);
    expect(layout.handleInput("\x1b[A")).toBe(true);
    expect(layout.scrollView.scrollTop).toBe(0);
    expect(layout.handleInput("G")).toBe(true);
    expect(layout.scrollView.scrollTop).toBe(contentHeight - 6);
    expect(layout.handleInput("g")).toBe(true);
    expect(layout.scrollView.scrollTop).toBe(0);
    expect(layout.handleInput("e")).toBe(false);
    detail.mode = "edit";
    expect(layout.handleInput("\x1b[B")).toBe(false);
  });

  test("resets only for canonical selection changes and preview mode entry", () => {
    const detail = state(Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"));
    const layout = previewLayout(detail);
    layout.scrollView.setScrollbar("hidden");
    const contentHeight = renderedDocument(layout, 20).length;
    layout.scrollView.updateLayout(contentHeight, 4, () => {});
    layout.scrollView.scrollBy(5);

    detail.status = "ordinary status update";
    detail.resolvedSelectedText += "\nupdated content";
    layout.render(20);
    expect(layout.scrollView.scrollTop).toBe(5);

    detail.mode = "edit";
    layout.setActive(false);
    detail.mode = "preview";
    layout.setActive(true);
    layout.render(20);
    expect(layout.scrollView.scrollTop).toBe(0);

    layout.scrollView.updateLayout(contentHeight, 4, () => {});
    layout.scrollView.scrollBy(3);
    detail.context = {
      selected: block("block-2", "other raw source"),
      ancestors: [],
      children: [],
    };
    layout.render(20);
    expect(layout.scrollView.scrollTop).toBe(0);
  });

  test("sanitizes and updates Markdown only when the resolved source changes", () => {
    const detail = state("Initial **document**");
    const layout = previewLayout(detail);
    const originalSetText = layout.markdown.setText.bind(layout.markdown);
    let updates = 0;
    layout.markdown.setText = (text: string): void => {
      updates += 1;
      originalSetText(text);
    };

    layout.render(40);
    layout.render(40);
    detail.status = "status-only change";
    layout.render(40);
    expect(updates).toBe(1);

    detail.resolvedSelectedText = `${"word ".repeat(10_000)}complete ending`;
    const lines = renderedDocument(layout, 80);
    expect(updates).toBe(2);
    expect(lines.map((line) => line.trim()).join(" ")).toContain("complete ending");
  });
});
