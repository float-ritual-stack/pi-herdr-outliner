import {
  getCapabilities,
  getOsc8LinkAtColumn,
  setCapabilities,
  stripTerminalSequences,
  visibleWidth,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";
import { describe, expect, test } from "bun:test";
import type { DetailState } from "../src/detail-controller";
import {
  DetailPiPreviewLayout,
  detailBacklinkToggleUri,
  parseDetailPreviewActionUri,
  renderBacklinksDocument,
  sanitizeMarkdownDocument,
} from "../src/detail-pi-preview";
import { outlinerLinkUri } from "../src/outliner-links";
import { TextBuffer } from "../src/text-buffer";
import type { Block } from "../src/types";

function block(id: string, text: string): Block {
  return {
    id,
    parentId: null,
    position: 0,
    text,
    author: "user",
    createdAt: "created",
    updatedAt: "updated",
    properties: [],
  };
}

function state(text: string, rawText = "raw edit source"): DetailState {
  const selected = block("block-1", rawText);
  return {
    context: { selected, ancestors: [], children: [] },
    targetBlockId: selected.id,
    connectionMode: "unlocked",
    canNavigateBack: false,
    canNavigateForward: false,
    resolvedSelectedText: text,
    projectedSelectedText: rawText,
    embedStates: [],
    workIdPrefix: "PIE",
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
    backlinks: {
      expanded: false,
      selectedIndex: 0,
      loading: false,
      collection: null,
      error: "",
      filter: "",
      filterDraft: null,
      sortField: "updated",
      sortDirection: "desc",
      expandedSourceIds: new Set(),
    },
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
  return new DetailPiPreviewLayout(detail, plainMarkdownTheme, false);
}

function renderedDocument(layout: DetailPiPreviewLayout, width: number): string[] {
  layout.render(width);
  return layout.markdown.render(width).map(stripTerminalSequences);
}

describe("Pi Markdown detail preview", () => {
  test("synchronizes Markdown before the viewport layout renders child nodes directly", () => {
    const detail = state("Body rendered by the child Markdown component");
    const layout = previewLayout(detail);

    layout.syncState();

    expect(
      layout.markdown.render(40).map(stripTerminalSequences).join(" ").replace(/\s+/g, " "),
    ).toContain("Body rendered by the child Markdown component");
  });

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
    expect(lines[1]).toContain("Detail · Unlocked");
    expect(lines[2]).toBe("─".repeat(32));
    expect(lines.at(-2)).toBe("Ready");
    expect(lines.at(-1)).toContain("b backlinks");
    expect(lines.at(-1)).not.toContain("Enter edit");
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

  test("renders generated outliner Markdown links as OSC 8 hyperlinks in Herdr", () => {
    const capabilities = getCapabilities();
    setCapabilities({ ...capabilities, hyperlinks: true });
    try {
      const targetId = "550e8400-e29b-41d4-a716-446655440000";
      const detail = state(
        "PIE-133 and ((Target decision))",
        `PIE-133 and ((${targetId}))`,
      );
      const layout = new DetailPiPreviewLayout(detail, plainMarkdownTheme, true);
      layout.syncState();
      const rendered = layout.markdown.render(80);
      const line = rendered.find((candidate) =>
        stripTerminalSequences(candidate).includes("PIE-133 and")
      );
      expect(line).toBeDefined();
      const visible = stripTerminalSequences(line!);
      expect(getOsc8LinkAtColumn(line!, visible.indexOf("PIE-133") + 2)).toBe(
        "pi-outliner://work/PIE-133",
      );
      expect(getOsc8LinkAtColumn(line!, visible.indexOf("Target decision") + 2)).toBe(
        `pi-outliner://block/${targetId}`,
      );
    } finally {
      setCapabilities(capabilities);
    }
  });

  test("links generated embed result rows from projected raw text", () => {
    const capabilities = getCapabilities();
    setCapabilities({ ...capabilities, hyperlinks: true });
    try {
      const resultId = "550e8400-e29b-41d4-a716-446655440001";
      const detail = state(
        "Embedded view: ((Next items)) · 1 result\n- ((Projected result))",
        "!((view-next))",
      );
      detail.projectedSelectedText =
        `Embedded view: ((view-next)) · 1 result\n- ((${resultId}))`;
      const layout = new DetailPiPreviewLayout(detail, plainMarkdownTheme, true);
      layout.syncState();
      const rendered = layout.markdown.render(80);
      const line = rendered.find((candidate) =>
        stripTerminalSequences(candidate).includes("Projected result")
      );

      expect(line).toBeDefined();
      const visible = stripTerminalSequences(line!);
      expect(getOsc8LinkAtColumn(line!, visible.indexOf("Projected result") + 2)).toBe(
        `pi-outliner://block/${resultId}`,
      );
      expect(detail.context.selected?.text).toBe("!((view-next))");
    } finally {
      setCapabilities(capabilities);
    }
  });

  test("links each Detail breadcrumb segment to an explicit Tree reveal", () => {
    const capabilities = getCapabilities();
    setCapabilities({ ...capabilities, hyperlinks: true });
    try {
      const detail = state("Selected leaf");
      detail.context = {
        selected: block("selected-01", "Selected leaf"),
        ancestors: [block("parent-001", "Parent page")],
        children: [],
      };
      const line = new DetailPiPreviewLayout(detail, plainMarkdownTheme, true).render(80)[1]!;
      const visible = stripTerminalSequences(line);

      expect(getOsc8LinkAtColumn(line, visible.indexOf("Parent page") + 2)).toBe(
        outlinerLinkUri("block", "parent-001", { intent: "reveal" }),
      );
      expect(getOsc8LinkAtColumn(line, visible.indexOf("Selected leaf") + 2)).toBe(
        outlinerLinkUri("block", "selected-01", { intent: "reveal" }),
      );
    } finally {
      setCapabilities(capabilities);
    }
  });

  test("renders only the configured Work-ID prefix", () => {
    const capabilities = getCapabilities();
    setCapabilities({ ...capabilities, hyperlinks: true });
    try {
      const detail = state("ABC-001 and PIE-001", "ABC-001 and PIE-001");
      detail.workIdPrefix = "ABC";
      const layout = new DetailPiPreviewLayout(detail, plainMarkdownTheme, true);
      layout.syncState();
      const line = layout.markdown.render(80).find((candidate) =>
        stripTerminalSequences(candidate).includes("ABC-001 and")
      )!;
      const visible = stripTerminalSequences(line);
      expect(getOsc8LinkAtColumn(line, visible.indexOf("ABC-001") + 2)).toBe(
        "pi-outliner://work/ABC-001",
      );
      expect(getOsc8LinkAtColumn(line, visible.indexOf("PIE-001") + 2)).toBeUndefined();
    } finally {
      setCapabilities(capabilities);
    }
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

  test("without links, updates Markdown only when the resolved source changes", () => {
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
    detail.context.selected!.text = "raw-only change";
    layout.render(40);
    expect(updates).toBe(1);

    detail.resolvedSelectedText = `${"word ".repeat(10_000)}complete ending`;
    const lines = renderedDocument(layout, 80);
    expect(updates).toBe(2);
    expect(lines.map((line) => line.trim()).join(" ")).toContain("complete ending");
  });
});

describe("generated backlink preview", () => {
  test("keeps collapsed and expanded backlink Markdown separate from authored content", () => {
    const detail = state("Canonical **authored** document", "Canonical raw source");
    const layout = previewLayout(detail);
    layout.syncState();

    expect(layout.markdown.render(80).map(stripTerminalSequences).join(" ")).toContain(
      "Canonical authored document",
    );
    expect(layout.markdown.render(80).map(stripTerminalSequences).join(" ")).not.toContain(
      "Backlinks",
    );
    expect(
      layout.backlinkMarkdown.render(80).map(stripTerminalSequences).join(" ").replace(/\s+/g, " "),
    ).toContain("Backlinks Collapsed");

    detail.backlinks = {
      expanded: true,
      loading: false,
      selectedIndex: 0,
      error: "",
      filter: "",
      filterDraft: null,
      sortField: "updated",
      sortDirection: "desc",
      expandedSourceIds: new Set(["source-target"]),
      collection: {
        targetBlockId: "block-1",
        sources: [{
          blockId: "source-target",
          title: "Duplicate source",
          parentContext: "Project › Notes",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
          occurrenceCount: 3,
          referenceGroups: [
            { kind: "block", count: 1 },
            { kind: "property", propertyKey: "source-block", count: 2 },
          ],
          occurrences: [{
            kind: "block",
            label: "((block-1))",
            snippet: "See ((block-1)) from here",
            start: 4,
            end: 15,
          }, {
            kind: "property",
            propertyKey: "source-block",
            label: "[source-block::block-1]",
            snippet: "[source-block::Canonical target]",
            start: 16,
            end: 39,
          }],
          occurrencesTruncated: true,
        }],
        completeness: { kind: "truncated", limit: 1 },
      },
    };
    layout.syncState();

    const generated = renderBacklinksDocument(detail);
    expect(generated).toContain(
      outlinerLinkUri("block", "source-target", { preserveSource: true }),
    );
    expect(generated).toContain("Additional occurrences omitted");
    expect(generated).toContain("Showing first 1 source blocks");
    expect(generated).toContain("source-block property ×2");
    expect(generated).toContain("**source-block property**");
    expect(generated).toContain("Filter: none");
    expect(generated).toContain("Sort: Updated ↓");
    expect(generated).toContain("▶ ACTIVE");
    const highlighted = layout.backlinkMarkdown.render(80).find((line) =>
      stripTerminalSequences(line).includes("▶ ACTIVE")
    );
    expect(highlighted).toContain("\x1b[1;97;48;5;24m");
    expect(generated).toContain(detailBacklinkToggleUri("source-target"));
    expect(parseDetailPreviewActionUri(detailBacklinkToggleUri("source-target"))).toEqual({
      kind: "backlink-toggle",
      blockId: "source-target",
    });
    detail.backlinks.expandedSourceIds.clear();
    expect(renderBacklinksDocument(detail)).not.toContain("See ((block-1)) from here");
    detail.backlinks.filter = "missing";
    expect(renderBacklinksDocument(detail)).toContain("No backlinks match the current filter.");
    expect(layout.markdown.render(80).map(stripTerminalSequences).join(" ")).not.toContain(
      "Duplicate source",
    );
    expect(layout.backlinkMarkdown.render(80).map(stripTerminalSequences).join(" ")).toContain(
      "Duplicate source",
    );
    expect(detail.context.selected?.text).toBe("Canonical raw source");
    expect(
      layout.backlinkMarkdown.render(80).map(stripTerminalSequences).join(" "),
    ).not.toContain("source-target");
  });

  test("scrolls a changed backlink selection into the preview viewport", () => {
    const detail = state("Hub");
    detail.backlinks = {
      expanded: true,
      loading: false,
      selectedIndex: 0,
      error: "",
      filter: "",
      filterDraft: null,
      sortField: "updated",
      sortDirection: "desc",
      expandedSourceIds: new Set(),
      collection: {
        targetBlockId: "block-1",
        sources: Array.from({ length: 4 }, (_, index) => ({
          blockId: `source-${index}`,
          title: `Backlink source ${index} with a wrapping title`,
          parentContext: "Top level",
          occurrenceCount: 1,
          referenceGroups: [{ kind: "block" as const, count: 1 }],
          createdAt: `2026-01-0${index + 1}T00:00:00.000Z`,
          updatedAt: `2026-02-0${index + 1}T00:00:00.000Z`,
          occurrences: [{
            kind: "block" as const,
            label: "((block-1))",
            snippet: `Long backlink snippet ${index} that wraps in a narrow pane`,
            start: 0,
            end: 11,
          }],
          occurrencesTruncated: false,
        })),
        completeness: { kind: "complete" },
      },
    };
    const layout = previewLayout(detail);
    layout.syncState();
    const width = 20;
    const contentWidth = layout.scrollView.getContentWidth(width);
    const contentHeight = layout.markdown.render(contentWidth).length + 1 +
      layout.backlinkMarkdown.render(contentWidth).length;
    layout.scrollView.updateLayout(contentHeight, 6, () => {});
    layout.render(width);

    detail.backlinks.selectedIndex = 3;
    layout.syncState();
    layout.render(width);

    const selectedLine = layout.backlinkMarkdown.render(contentWidth)
      .findIndex((line) => line.includes("▶ ACTIVE"));
    const selectedRow = layout.markdown.render(contentWidth).length + 1 + selectedLine;
    expect(layout.scrollView.scrollTop).toBeGreaterThan(0);
    expect(selectedRow).toBeGreaterThanOrEqual(layout.scrollView.scrollTop);
    expect(selectedRow).toBeLessThan(
      layout.scrollView.scrollTop + layout.scrollView.viewportHeight,
    );
  });

  test("renders explicit empty, deleted-target, loading, and error states", () => {
    const detail = state("Target");
    detail.backlinks = {
      expanded: true,
      loading: true,
      selectedIndex: 0,
      collection: null,
      error: "",
      filter: "",
      filterDraft: null,
      sortField: "updated",
      sortDirection: "desc",
      expandedSourceIds: new Set(),
    };
    expect(renderBacklinksDocument(detail)).toContain("Loading");

    detail.backlinks.loading = false;
    detail.backlinks.error = "service unavailable";
    expect(renderBacklinksDocument(detail)).toContain("service unavailable");

    detail.backlinks.error = "";
    detail.backlinks.collection = {
      targetBlockId: "block-1",
      targetDeletedRootId: "block-1",
      sources: [],
      completeness: { kind: "complete" },
    };
    const empty = renderBacklinksDocument(detail);
    expect(empty).toContain("Target is in Trash");
    expect(empty).toContain("No backlinks");
  });
});
