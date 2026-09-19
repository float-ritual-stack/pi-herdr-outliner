import {
  getCapabilities,
  getOsc8LinkAtColumn,
  Markdown,
  setCapabilities,
  stripTerminalSequences,
  visibleWidth,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";
import { describe, expect, test } from "bun:test";
import {
  attentionClientState,
  emptyAttentionState,
  normalizeAttentionMark,
} from "../src/attention";
import { createAnnotationAnchor } from "../src/annotations";
import {
  DEFAULT_DETAIL_CALLOUT_THEME,
  type DetailCalloutTheme,
} from "../src/detail-callout-theme";
import { parseDetailCallouts } from "../src/detail-callouts";
import type { DetailState } from "../src/detail-controller";
import {
  DetailPiPreviewLayout,
  draftSourceRowAnchors,
  nearestDraftSourceLine,
  detailBacklinkToggleUri,
  parseDetailPreviewActionUri,
  renderBacklinksDocument,
  sanitizeMarkdownDocument,
} from "../src/detail-pi-preview";
import {
  detailPropertyInspectorRegions,
  renderPropertyInspectorDocument,
} from "../src/detail-pi-renderer";
import { createPropertyInspectorModel } from "../src/property-inspector";
import {
  previewRegionActionUri,
  resolvePreviewPointerAction,
  togglePreviewRegionDisclosure,
} from "../src/detail-preview-regions";
import { outlinerLinkUri } from "../src/outliner-links";
import {
  deriveResourceCapabilityReport,
  type Resource,
  type ResourceDescription,
  type ResourceSource,
} from "../src/resources";
import { createOpenDestinationChooserState } from "../src/open-destination-chooser";
import {
  SourceSpannedMarkdown,
  sourceSpannedMarkdownSegments,
} from "../src/source-spanned-markdown";
import { TextBuffer } from "../src/text-buffer";
import type {
  AnnotationRepresentation,
  AnnotationTarget,
  AnnotationThread,
  Block,
  OutlinerNavigationTarget,
  SelectionContext,
} from "../src/types";

function block(id: string, text: string): Block {
  return {
    revision: 1,
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
function textTarget(
  text: string,
  start: number,
  end: number,
  representation?: AnnotationRepresentation,
): AnnotationTarget {
  return {
    representation: representation ?? {
      id: `block:block-1:${text.length}`,
      subject: { kind: "block", blockId: "block-1" },
      sourceSnapshot: {
        kind: "block",
        blockId: "block-1",
        updatedAt: "updated",
        contentHash: "fixture",
      },
      adapter: { id: "outliner.block-text", version: 1 },
      mediaType: "text/markdown",
      contentHash: "fixture",
      capturedAt: "2026-01-01T00:00:00.000Z",
    },
    anchor: {
      kind: "text-quote",
      start,
      end,
      exact: text.slice(start, end),
      prefix: text.slice(Math.max(0, start - 64), start),
      suffix: text.slice(end, end + 64),
    },
  };
}

function annotationThread(
  id: string,
  target: AnnotationTarget,
  body: string,
  source: "user" | "agent" = "user",
): AnnotationThread {
  const annotation = block(id, "");
  const resolution = {
    id: `${id}-resolution`,
    annotationId: id,
    sequence: 0,
    sourceRepresentation: target.representation,
    targetRepresentation: target.representation,
    resolvedTarget: target,
    method: {
      kind: "codec" as const,
      codecId: "text-quote",
      codecVersion: 1,
      method: "capture",
    },
    reviewer: { kind: "system" as const, id: "annotation-repository" },
    confidence: 1,
    candidates: [],
    status: "resolved" as const,
    appliesCurrent: true,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  return {
    block: annotation,
    originalTarget: target,
    resolvedTarget: target,
    currentResolution: resolution,
    resolutionHistory: [resolution],
    body,
    source,
    lifecycle: "open",
    replies: [],
  };
}


function state(text: string, rawText = "raw edit source"): DetailState {
  const selected = block("block-1", rawText);
  return {
    document: {
      kind: "ready",
      document: {
        kind: "block",
        target: { kind: "block", blockId: selected.id },
        context: { selected, ancestors: [], children: [] },
      },
    },
    context: { selected, ancestors: [], children: [] },
    target: { kind: "block", blockId: selected.id },
    resource: null,
    connectionMode: "unlocked",
    canNavigateBack: false,
    canNavigateForward: false,
    resolvedSelectedText: text,
    projectedSelectedText: rawText,
    readStatus: "ready",
    embedStates: [],
    embedRanges: [],
    embedBackgroundEnabled: true,
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
    annotationThreads: [],
    attention: emptyAttentionState("detail-test"),
    attentionRevealSourceLine: null,
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
    propertyInspector: {
      presentation: "inline",
      model: null,
      expanded: false,
      groupBy: null,
      filter: "",
      filterDraft: null,
      viewportOffset: 0,
      edit: null,
    },
    previewRegions: {
      regions: [],
      focusedRegionId: null,
      disclosureOverrides: new Map(),
    },
    destinationChooser: createOpenDestinationChooserState(),
  };
}

function setBlockDocument(
  detail: DetailState,
  context: SelectionContext,
  target: Extract<OutlinerNavigationTarget, { kind: "block" }> = {
    kind: "block",
    blockId: context.selected?.id ?? "",
  },
): void {
  detail.document = { kind: "ready", document: { kind: "block", target, context } };
  Object.assign(detail as unknown as {
    context: SelectionContext;
    target: OutlinerNavigationTarget;
    resource: null;
  }, { context, target, resource: null });
}
function webState(markdown: string): DetailState {
  const detail = state(markdown, markdown);
  const source: ResourceSource = {
    id: "20000000-0000-4000-8000-000000000001",
    name: "Web fixture",
    provider: "web",
    boundary: { kind: "web", baseUrl: "https://example.com/" },
    policy: { deniedCapabilities: [] },
    version: 1,
    createdAt: "created",
    updatedAt: "updated",
  };
  const resource: Resource = {
    id: "10000000-0000-4000-8000-000000000001",
    sourceId: source.id,
    provider: "web",
    address: { kind: "web", url: "https://example.com/article" },
    version: 1,
    addressVersion: 1,
    mediaType: "text/html",
    createdAt: "created",
    updatedAt: "updated",
  };
  const target = { kind: "resource" as const, resourceId: resource.id };
  const sourceSnapshot = {
    id: "30000000-0000-4000-8000-000000000001",
    resourceId: resource.id,
    addressVersion: resource.addressVersion,
    canonicalUrl: resource.address.url,
    contentHash: "b".repeat(64),
    revision: {
      resourceId: resource.id,
      addressVersion: resource.addressVersion,
      revision: {
        kind: "web" as const,
        validator: { kind: "etag" as const, value: "fixture", weak: false },
      },
    },
    fetchedAt: "2026-09-17T12:00:00.000Z",
    bodyAvailable: true,
    evictedAt: null,
  };
  const representation = {
    id: "40000000-0000-4000-8000-000000000001",
    sourceSnapshotId: sourceSnapshot.id,
    mediaType: "text/markdown" as const,
    adapter: { id: "fixture", version: 1 },
    contentHash: "a".repeat(64),
    derivedAt: "2026-09-17T12:00:01.000Z",
    contentAvailable: true,
    evictedAt: null,
  };
  const description: ResourceDescription = {
    resource,
    source,
    requestedRevision: null,
    capabilities: deriveResourceCapabilityReport(source, true),
    web: {
      markdown,
      sourceSnapshot,
      representation,
    },
    webHistory: {
      sourceSnapshots: [sourceSnapshot],
      representations: [representation],
    },
    webStatus: {
      freshness: "fresh",
      checkedAt: "2026-09-17T12:00:00.000Z",
      lastError: null,
    },
    remoteEntity: null,
    remoteStatus: null,
    availableCommands: [],
  };
  const renderedDocument = [
    markdown,
    "",
    "---",
    "",
    "## Web resource",
    "",
    `[Open externally](<${resource.address.url}>)`,
    "",
    "## Local status",
    "",
    "- Freshness: **fresh**",
    "",
    "## Selected immutable content",
    "",
    `- Source snapshot ID: \`${sourceSnapshot.id}\``,
    `- Source hash: \`${sourceSnapshot.contentHash}\``,
    `- Representation ID: \`${representation.id}\``,
    `- Representation hash: \`${representation.contentHash}\``,
  ].join("\n");
  detail.document = {
    kind: "ready",
    document: { kind: "resource", target, description },
  };
  Object.assign(detail as unknown as {
    context: SelectionContext;
    target: OutlinerNavigationTarget;
    resource: Resource;
  }, {
    context: { selected: null, ancestors: [], children: [] },
    target,
    resource,
  });
  detail.resolvedSelectedText = renderedDocument;
  detail.projectedSelectedText = renderedDocument;
  detail.resolvedBreadcrumb = resource.address.url;
  return detail;
}
function filesystemState(markdown: string): DetailState {
  const detail = state(markdown, markdown);
  const source: ResourceSource = {
    id: "20000000-0000-4000-8000-000000000002",
    name: "Filesystem fixture",
    provider: "filesystem",
    boundary: { kind: "filesystem", root: "/workspace" },
    policy: { deniedCapabilities: [] },
    version: 1,
    createdAt: "created",
    updatedAt: "updated",
  };
  const resource: Resource = {
    id: "10000000-0000-4000-8000-000000000002",
    sourceId: source.id,
    provider: "filesystem",
    address: { kind: "filesystem", path: "notes/fixture.md" },
    version: 1,
    addressVersion: 1,
    mediaType: "text/markdown",
    createdAt: "created",
    updatedAt: "updated",
  };
  const target = { kind: "resource" as const, resourceId: resource.id };
  const revision = {
    resourceId: resource.id,
    addressVersion: resource.addressVersion,
    revision: {
      kind: "filesystem" as const,
      mtimeNs: "1",
      size: String(markdown.length),
    },
  };
  const description: ResourceDescription = {
    resource,
    source,
    requestedRevision: null,
    capabilities: deriveResourceCapabilityReport(source, true),
    filesystem: {
      text: markdown,
      contentHash: "c".repeat(64),
      capturedAt: "2026-09-17T12:00:00.000Z",
      revision,
    },
    web: null,
    webHistory: null,
    remoteEntity: null,
    webStatus: null,
    remoteStatus: null,
    availableCommands: [],
  };
  const renderedDocument = [
    markdown,
    "",
    "---",
    "",
    "## Filesystem Resource",
    "",
    "- Local source",
  ].join("\n");
  detail.document = {
    kind: "ready",
    document: { kind: "resource", target, description },
  };
  Object.assign(detail as unknown as {
    context: SelectionContext;
    target: OutlinerNavigationTarget;
    resource: Resource;
  }, {
    context: { selected: null, ancestors: [], children: [] },
    target,
    resource,
  });
  detail.resolvedSelectedText = renderedDocument;
  detail.projectedSelectedText = renderedDocument;
  detail.resolvedBreadcrumb = resource.address.path;
  return detail;
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
  test("does not report a missing reference before resolution has completed", () => {
    const source = "Related ((550e8400-e29b-41d4-a716-446655440123|Reference label))";
    const detail = state(source, source);
    detail.readStatus = "pending";
    const layout = new DetailPiPreviewLayout(detail, plainMarkdownTheme, false);
    expect(renderedDocument(layout, 120).join("\n")).not.toContain("Missing target");
    detail.readStatus = "ready";
    expect(renderedDocument(layout, 120).join("\n")).toContain("Reference label · Missing target");
  });

  test("enables reference hyperlinks only after the displayed source becomes ready", () => {
    const capabilities = getCapabilities();
    setCapabilities({ ...capabilities, hyperlinks: true });
    try {
      const id = "550e8400-e29b-41d4-a716-446655440123";
      const source = `Reference ${id}`;
      const detail = state(source, source);
      detail.readStatus = "pending";
      const layout = new DetailPiPreviewLayout(detail, plainMarkdownTheme, true);
      const link = () => {
        layout.syncState();
        const line = layout.markdown.render(120).find(row => stripTerminalSequences(row).includes(id))!;
        return getOsc8LinkAtColumn(line, stripTerminalSequences(line).indexOf(id));
      };
      expect(link()).toBeUndefined();
      detail.readStatus = "ready";
      expect(link()).toBe(outlinerLinkUri("block", id));
    } finally {
      setCapabilities(capabilities);
    }
  });

  test("synchronizes Markdown before the viewport layout renders child nodes directly", () => {
    const detail = state("Body rendered by the child Markdown component");
    const layout = previewLayout(detail);

    layout.syncState();

    expect(
      layout.markdown.render(40).map(stripTerminalSequences).join(" ").replace(/\s+/g, " "),
    ).toContain("Body rendered by the child Markdown component");
  });

  test("promotes the block title and replaces deep heading hashes without changing source", () => {
    const source = [
      "Block title",
      "",
      "## Section",
      "### Subsection",
      "#### Detail",
      "",
      "```md",
      "### literal code",
      "```",
    ].join("\n");
    const detail = state(source, source);
    const styledTheme: MarkdownTheme = {
      ...plainMarkdownTheme,
      heading: (text) => `\x1b[38;5;214m${text}\x1b[39m`,
      bold: (text) => `\x1b[1m${text}\x1b[22m`,
      underline: (text) => `\x1b[4m${text}\x1b[24m`,
    };
    const layout = new DetailPiPreviewLayout(detail, styledTheme, false);

    layout.syncState();
    const raw = layout.markdown.render(80);
    const visible = raw.map((line) => stripTerminalSequences(line).trimEnd());

    expect(raw[0]).toContain("\x1b[4m");
    expect(visible[0]!.trimEnd()).toBe("Block title");
    expect(visible).toContain("Section");
    expect(visible).toContain("› Subsection");
    expect(visible).toContain("›› Detail");
    expect(visible).not.toContain("### Subsection");
    expect(visible.some((line) => line.includes("### literal code"))).toBe(true);
    expect(detail.context.selected?.text).toBe(source);
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

  test("maps linked draft scrolling through source-line anchors rather than proportional offsets", () => {
    const source = [
      "A deliberately long first source line that wraps several times.",
      "short",
      "Another source line with **Markdown** and more wrapping.",
    ].join("\n");
    const anchors = draftSourceRowAnchors(source, 14, plainMarkdownTheme);
    expect(anchors).toHaveLength(3);
    expect(anchors[1]).toBeGreaterThan(1);
    expect(anchors[2]).toBeGreaterThan(anchors[1]!);
    expect(nearestDraftSourceLine(anchors, anchors[1]!)).toBe(1);
    expect(nearestDraftSourceLine(anchors, anchors[2]! - 1)).toBe(1);
    expect(nearestDraftSourceLine([], 4)).toBeNull();
  });

  test("keeps dense header chrome, status, and help outside the document body", () => {
    const detail = state("Body text");
    detail.status = "Ready";
    const lines = previewLayout(detail).render(32).map(stripTerminalSequences);

    expect(lines[0]).toContain("Resolved block");
    expect(lines[0]).toMatch(/🔓 \[⋯\]$/);
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe("─".repeat(32));
    expect(lines.at(-2)).toBe("Ready");
    expect(lines.at(-1)).toContain("e edit");
    expect(lines.at(-1)).not.toContain("Enter edit");
    expect(previewLayout(detail).scrollView.scrollbar).toBe("always");
  });

  test("prioritizes the selected title over a deep breadcrumb", () => {
    const detail = state("Selected leaf");
    setBlockDocument(detail, {
      selected: block("selected", "Selected leaf"),
      ancestors: [
        block("workspace", "A very long workspace title"),
        block("parent", "A very long parent title"),
      ],
      children: [],
    });
    detail.resolvedBreadcrumb =
      "A very long workspace title › A very long parent title › Selected leaf";
    const lines = previewLayout(detail).render(42).map(stripTerminalSequences);

    expect(lines[0]).toStartWith("Selected leaf");
    expect(lines[1]).toContain("… › A very long parent title");
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

  test("renders clean semantic links while preserving exact authored source", () => {
    const capabilities = getCapabilities();
    setCapabilities({ ...capabilities, hyperlinks: true });
    try {
      const targetId = "550e8400-e29b-41d4-a716-446655440000";
      const raw = [
        "PIE-133",
        `((${targetId}|the **approved** boundary))`,
        "[[Decision Log|supporting context]]",
      ].join(" and ");
      const detail = state(
        "PIE-133 and ((the **approved** boundary)) and [[Decision Log|supporting context]]",
        raw,
      );
      const layout = new DetailPiPreviewLayout(detail, plainMarkdownTheme, true);
      layout.syncState();
      const rendered = layout.markdown.render(80);
      const line = rendered.find((candidate) =>
        stripTerminalSequences(candidate).includes("approved")
      );
      expect(line).toBeDefined();
      const visible = stripTerminalSequences(line!);
      expect(visible).not.toContain("((");
      expect(visible).not.toContain("[[");
      expect(getOsc8LinkAtColumn(line!, visible.indexOf("approved") + 2)).toBe(
        `pi-outliner://block/${targetId}`,
      );
      expect(getOsc8LinkAtColumn(line!, visible.indexOf("supporting") + 2)).toBe(
        outlinerLinkUri("page", "Decision Log"),
      );
      expect(detail.context.selected?.text).toBe(raw);

      const fallback = new DetailPiPreviewLayout(detail, plainMarkdownTheme, false);
      fallback.syncState();
      const fallbackLine = fallback.markdown.render(80).find((candidate) =>
        stripTerminalSequences(candidate).includes("approved")
      )!;
      const fallbackVisible = stripTerminalSequences(fallbackLine);
      expect(fallbackVisible).not.toContain("((");
      expect(fallbackVisible).not.toContain("[[");
      expect(getOsc8LinkAtColumn(fallbackLine, fallbackVisible.indexOf("approved"))).toBeUndefined();
    } finally {
      setCapabilities(capabilities);
    }
  });
  test("keeps clean titled links actionable when narrow preview rows wrap", () => {
    const capabilities = getCapabilities();
    setCapabilities({ ...capabilities, hyperlinks: true });
    try {
      const targetId = "550e8400-e29b-41d4-a716-446655440000";
      const label = "a deliberately long approved boundary explanation";
      const detail = state(
        `Preview title\n((${label}))`,
        `Preview title\n((${targetId}|${label}))`,
      );
      const layout = new DetailPiPreviewLayout(detail, plainMarkdownTheme, true);
      layout.syncState();
      const rendered = layout.markdown.renderWithSourceLineRow(22, 1);
      const visible = rendered.lines.map(stripTerminalSequences);
      const labelRows = rendered.lines.filter((line) =>
        /deliberately|approved|boundary|explanation/.test(stripTerminalSequences(line))
      );

      expect(visible.join("\n")).not.toContain("((");
      expect(rendered.sourceLineRow).toBeGreaterThan(0);
      expect(labelRows.length).toBeGreaterThan(1);
      expect(labelRows.every((line) => {
        const text = stripTerminalSequences(line);
        const contentColumn = text.search(/\S/);
        return getOsc8LinkAtColumn(line, contentColumn) === `pi-outliner://block/${targetId}`;
      })).toBe(true);
    } finally {
      setCapabilities(capabilities);
    }
  });

  test("links generated embed result rows from projected raw text", () => {
    const capabilities = getCapabilities();
    setCapabilities({ ...capabilities, hyperlinks: true });
    try {
      const resultId = "550e8400-e29b-41d4-a716-446655440001";
      const viewId = "550e8400-e29b-41d4-a716-446655440002";
      const nestedTitleReferenceId = "550e8400-e29b-41d4-a716-446655440003";
      const detail = state(
        `Embedded view: ((Next items with ((${nestedTitleReferenceId})))) · 1 result\n- ((Projected result))`,
        "!((view-next))",
      );
      detail.projectedSelectedText =
        `Embedded view: ((${viewId})) · 1 result\n- ((${resultId}))`;
      detail.embedRanges = [{ startLine: 0, endLine: 1 }];
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

  test("shades only projected embed lines and can disable the background", () => {
    const detail = state(
      "Before\nEmbedded block: ((Demo))\nProjected body\nAfter",
      "Before\n!((demo-block))\nAfter",
    );
    detail.embedRanges = [{ startLine: 1, endLine: 2 }];
    const layout = previewLayout(detail);
    layout.syncState();

    let rendered = layout.markdown.render(48);
    expect(rendered.find((line) => line.includes("Embedded block"))).toContain("\x1b[48;5;236m");
    expect(rendered.find((line) => line.includes("Projected body"))).toContain("\x1b[48;5;236m");
    expect(rendered.find((line) => line.includes("Before"))).not.toContain("\x1b[48;5;236m");
    expect(rendered.find((line) => line.includes("After"))).not.toContain("\x1b[48;5;236m");

    detail.embedBackgroundEnabled = false;
    layout.syncState();
    rendered = layout.markdown.render(48);
    expect(rendered.some((line) => line.includes("\x1b[48;5;236m"))).toBe(false);
  });

  test("remaps embed decoration after removing block metadata lines", () => {
    const canonical = [
      "[type::fixture]",
      "",
      "Before",
      "!((embed-block))",
      "After",
    ].join("\n");
    const projected = [
      "[type::fixture]",
      "",
      "Before",
      "Embedded block",
      "Projected body",
      "After",
    ].join("\n");
    const detail = state(projected, canonical);
    detail.projectedSelectedText = projected;
    detail.embedRanges = [{ startLine: 3, endLine: 4 }];
    const layout = previewLayout(detail);
    layout.syncState();

    const rendered = layout.markdown.render(48);
    const lineContaining = (text: string): string =>
      rendered.find((line) => stripTerminalSequences(line).includes(text))!;
    expect(lineContaining("Embedded block")).toContain("\x1b[48;5;236m");
    expect(lineContaining("Projected body")).toContain("\x1b[48;5;236m");
    expect(lineContaining("Before")).not.toContain("\x1b[48;5;236m");
    expect(lineContaining("After")).not.toContain("\x1b[48;5;236m");
  });

  test("decorates post-parse structural blocks without breaking Markdown context", () => {
    const document = [
      "Before",
      "",
      "> Quoted embed",
      "> continuation",
      "",
      "- list embed",
      "- second item",
      "",
      "```ts",
      "const answer = 42;",
      "```",
      "",
      "| Name | Value |",
      "| --- | --- |",
      "| Embed | yes |",
      "",
      "After",
    ].join("\n");
    const ranges = [
      { startLine: 2, endLine: 3 },
      { startLine: 5, endLine: 6 },
      { startLine: 8, endLine: 10 },
      { startLine: 12, endLine: 14 },
    ];
    const segments = sourceSpannedMarkdownSegments(document, ranges);
    expect(segments.map((segment) => segment.text).join("")).toBe(document);
    expect(segments.every((segment) =>
      segment.text === document.slice(segment.span.start, segment.span.end)
    )).toBe(true);
    expect(segments.filter((segment) => segment.decorated).map((segment) =>
      segment.text.trim()
    )).toEqual([
      "> Quoted embed\n> continuation",
      "- list embed\n- second item",
      "```ts\nconst answer = 42;\n```",
      "| Name | Value |\n| --- | --- |\n| Embed | yes |",
    ]);

    const detail = state(document, document);
    detail.embedRanges = ranges;
    const layout = previewLayout(detail);
    layout.syncState();

    for (const width of [32, 80]) {
      const rendered = layout.markdown.render(width);
      function lineContaining(text: string): string | undefined {
        return rendered.find((line) => stripTerminalSequences(line).includes(text));
      }
      expect(stripTerminalSequences(lineContaining("Quoted embed")!)).toContain(
        "│ Quoted embed",
      );
      expect(stripTerminalSequences(lineContaining("list embed")!)).toContain(
        "- list embed",
      );
      expect(stripTerminalSequences(lineContaining("answer = 42")!)).toContain(
        "const answer = 42;",
      );
      expect(stripTerminalSequences(lineContaining("Embed")!)).toContain("Embed");
      for (const text of ["Quoted embed", "list embed", "answer = 42", "Embed"]) {
        expect(lineContaining(text)).toContain("\x1b[48;5;236m");
      }
      expect(lineContaining("Before")).not.toContain("\x1b[48;5;236m");
      expect(lineContaining("After")).not.toContain("\x1b[48;5;236m");
    }
  });

  test("preserves CRLF source slices and offsets while decorating Markdown tokens", () => {
    const document = "Before\r\n\r\n> Embedded\r\n> body\r\n\r\nAfter\r\n";
    const segments = sourceSpannedMarkdownSegments(document, [{
      startLine: 2,
      endLine: 3,
    }]);

    expect(segments.map((segment) => segment.text).join("")).toBe(document);
    expect(segments.every((segment) =>
      segment.text === document.slice(segment.span.start, segment.span.end)
    )).toBe(true);
    expect(
      segments.filter((segment) => segment.decorated).map((segment) => segment.text).join(""),
    ).toBe("> Embedded\r\n> body");
  });

  test("recovers a final lazy blockquote token without a trailing newline", () => {
    const document = "> 1. Open. 2. Press \\*\\*\\`v\\`\\*\\*.\ncomment body";
    const segments = sourceSpannedMarkdownSegments(document, []);

    expect(segments.map((segment) => segment.text).join("")).toBe(document);
    expect(segments.every((segment) =>
      segment.text === document.slice(segment.span.start, segment.span.end)
    )).toBe(true);

    const markdown = new SourceSpannedMarkdown(plainMarkdownTheme, (value) => value);
    markdown.setContent(document, [], false);
    expect(
      markdown.renderWithSourceLineRow(40, 1).lines
        .map(stripTerminalSequences)
        .join("\n"),
    ).toContain("comment body");
  });

  test("anchors interactive comment markers in a two-column gutter and expands inline", () => {
    const raw = [
      "Title",
      "",
      "before",
      "target phrase",
      "range line 2",
      "range line 3",
      "range line 4",
      "range line 5",
      "range line 6",
      "after",
    ].join("\n");
    const detail = state(raw, raw);
    const start = raw.indexOf("target phrase");
    const end = raw.indexOf("\nafter");
    const target = textTarget(raw, start, end);
    const leadingTarget = textTarget(raw, start - 1, end);
    const root = annotationThread("annotation-1", target, "Check this range.");
    const reply = annotationThread("reply-1", target, "Verified.", "agent");
    detail.annotationThreads = [{
      ...root,
      replies: [{
        ...reply,
        parentAnnotationId: root.block.id,
      }],
    }, annotationThread(
      "annotation-2",
      leadingTarget,
      "Second comment.",
      "agent",
    )];
    const layout = previewLayout(detail);

    const collapsed = layout.render(72).map(stripTerminalSequences);
    const region = detail.previewRegions.regions.find((candidate) =>
      candidate.kind === "annotation"
    )!;
    expect(detail.previewRegions.regions.filter((candidate) =>
      candidate.kind === "annotation"
    )).toHaveLength(1);
    const collapsedTarget = collapsed.find((line) => line.includes("target phrase"))!;
    expect(collapsedTarget.startsWith("+ ")).toBe(true);
    expect(collapsed.join("\n")).not.toContain("Comments ·");
    expect(collapsed.join("\n")).not.toContain("Check this range.");

    layout.scrollView.updateLayout(12, 6, () => {});
    detail.previewRegions.focusedRegionId = region.id;
    expect(togglePreviewRegionDisclosure(detail.previewRegions, region.id)).toBe(true);
    const expanded = layout.render(72).map(stripTerminalSequences);
    const targetRow = expanded.findIndex((line) => line.includes("target phrase"));
    const commentRow = expanded.findIndex((line) => line.includes("Check this range."));
    const afterRow = expanded.findIndex((line) => line.includes("after"));
    expect(expanded[targetRow]!.startsWith("− ")).toBe(true);
    expect(commentRow).toBeGreaterThan(targetRow);
    expect(commentRow).toBeLessThan(afterRow);
    expect(expanded.join("\n")).toContain("agent: Verified.");
    expect(expanded.join("\n")).toContain("Second comment.");
    expect(layout.render(72).every((line) => visibleWidth(line) <= 72)).toBe(true);
    expect(layout.scrollView.scrollTop).toBeGreaterThan(0);
    expect(
      layout.scrollView.render(72).map(stripTerminalSequences).join("\n"),
    ).toContain("Check this range.");
  });
  test("shows rendered-passage threads only after preview enrichment is ready", () => {
    const rendered = "Hub\n\nGenerated result";
    const detail = state(rendered, "Hub\n\n!((virtual-branch))");
    const observation = {
      quote: "Generated result",
      capturedAt: "2026-01-02T03:04:05.000Z",
      hostBlockId: "block-1",
      paneId: "w1:p2",
      contentRevision: 42,
      contextId: "context-1",
      detailClientId: "detail-1",
      validation: "herdr-keybinding" as const,
      projection: "generated" as const,
    };
    const representation: AnnotationRepresentation = {
      id: "rendered-1",
      subject: { kind: "block", blockId: "block-1" },
      sourceSnapshot: { kind: "rendered", observation },
      adapter: { id: "herdr.rendered-passage", version: 1 },
      mediaType: "text/plain",
      contentHash: "rendered-hash",
      capturedAt: observation.capturedAt,
      observation,
    };
    const start = rendered.indexOf(observation.quote);
    const target = textTarget(
      rendered,
      start,
      start + observation.quote.length,
      representation,
    );
    detail.annotationThreads = [
      annotationThread(
        "annotation-rendered",
        target,
        "Discuss the generated result.",
      ),
    ];
    const layout = previewLayout(detail);

    detail.readStatus = "pending";
    detail.resolvedSelectedText = detail.context.selected!.text;
    layout.render(72);
    expect(detail.previewRegions.regions.some(region => region.kind === "annotation")).toBe(false);
    detail.readStatus = "ready";
    detail.resolvedSelectedText = rendered;

    const collapsed = layout.render(72).map(stripTerminalSequences);
    const region = detail.previewRegions.regions.find((candidate) =>
      candidate.kind === "annotation"
    )!;
    expect(region.sourceSpan).toBeNull();
    expect(collapsed.find((line) => line.includes("Generated result"))).toStartWith("+ ");
    expect(togglePreviewRegionDisclosure(detail.previewRegions, region.id)).toBe(true);
    expect(layout.render(72).map(stripTerminalSequences).join("\n")).toContain(
      "Discuss the generated result.",
    );
  });

  test("shows Resource threads at offsets matching the displayed historical representation", () => {
    const rendered = "# Resource\n\nStable quote";
    const detail = webState(rendered);
    if (
      detail.document.kind !== "ready" ||
      detail.document.document.kind !== "resource" ||
      !detail.document.document.description.web
    ) throw new Error("Web Resource fixture is unavailable");
    const web = detail.document.document.description.web;
    const representation: AnnotationRepresentation = {
      id: web.representation.id,
      subject: {
        kind: "resource",
        resourceId: "10000000-0000-4000-8000-000000000001",
      },
      sourceSnapshot: {
        kind: "resource",
        resourceId: "10000000-0000-4000-8000-000000000001",
        sourceSnapshotId: web.sourceSnapshot.id,
        revision: web.sourceSnapshot.revision,
      },
      adapter: web.representation.adapter,
      mediaType: web.representation.mediaType,
      contentHash: web.representation.contentHash,
      capturedAt: web.representation.derivedAt!,
    };
    const start = rendered.indexOf("Stable quote");
    const historicalTarget = textTarget(
      rendered,
      start,
      start + "Stable quote".length,
      representation,
    );
    const historical = annotationThread(
      "annotation-resource",
      historicalTarget,
      "Discuss the Resource evidence.",
    );
    const currentTarget = textTarget(rendered, 0, "# Resource".length, {
      ...representation,
      id: "newer-resource-representation",
    });
    const current = annotationThread(
      "annotation-resource",
      currentTarget,
      "Discuss the Resource evidence.",
    );
    detail.annotationThreads = [{
      ...current,
      originalTarget: historicalTarget,
      resolutionHistory: [
        historical.currentResolution,
        current.currentResolution,
      ],
    }];
    const layout = previewLayout(detail);

    const collapsed = layout.render(72).map(stripTerminalSequences);
    const region = detail.previewRegions.regions.find((candidate) =>
      candidate.kind === "annotation"
    )!;
    expect(region.sourceSpan).toBeNull();
    expect(collapsed.find((line) => line.includes("Stable quote"))).toStartWith("+ ");
    expect(togglePreviewRegionDisclosure(detail.previewRegions, region.id)).toBe(true);
    expect(layout.render(72).map(stripTerminalSequences).join("\n")).toContain(
      "Discuss the Resource evidence.",
    );
  });


  test("maps source clicks around inline panels and ignores generated rows", () => {
    const raw = "Title\n\ntarget phrase\n\nafter";
    const detail = state(raw, raw);
    const start = raw.indexOf("target phrase");
    detail.annotationThreads = [
      annotationThread(
        "annotation-1",
        textTarget(raw, start, start + "target phrase".length),
        "Comment content",
      ),
    ];
    const layout = previewLayout(detail);
    layout.scrollView.setScrollbar("hidden");
    layout.syncState(60);
    const region = detail.previewRegions.regions.find((candidate) =>
      candidate.kind === "annotation"
    )!;

    for (const expanded of [false, true]) {
      if (expanded) togglePreviewRegionDisclosure(detail.previewRegions, region.id);
      layout.syncState(60);
      const lines = layout.scrollView.render(60).map(stripTerminalSequences);
      for (const [text, sourceRow] of [["target phrase", 2], ["after", 4]] as const) {
        const row = lines.findIndex((line) => line.includes(text));
        expect(row).toBeGreaterThanOrEqual(0);
        expect(layout.sourcePointAtViewport(row + 3, lines[row]!.indexOf(text), 60))
          .toEqual({ row: sourceRow, column: 0 });
      }
      const inspectorRow = lines.findIndex((line) => line.includes("Properties"));
      expect(inspectorRow).toBeGreaterThanOrEqual(0);
      expect(layout.sourcePointAtViewport(inspectorRow + 3, 0, 60)).toBeNull();
      expect(layout.sourcePointAtViewport(inspectorRow + 2, 0, 60)).toBeNull();
      if (expanded) {
        const commentRow = lines.findIndex((line) => line.includes("Comment content"));
        expect(commentRow).toBeGreaterThanOrEqual(0);
        expect(layout.sourcePointAtViewport(commentRow + 3, 4, 60)).toBeNull();
      }
    }
  });

  test("correlates authored callouts by projected origin instead of colliding positions", () => {
    const canonical = [
      "!((embed-block))",
      "",
      "> [!note]- Authored",
      "> authored body",
    ].join("\n");
    const projected = [
      "> [!note]+ Generated",
      "> generated body",
      "",
      "> [!note]- Authored",
      "> authored body",
    ].join("\n");
    const detail = state(projected, canonical);
    detail.projectedSelectedText = projected;
    detail.embedRanges = [{ startLine: 0, endLine: 1 }];
    const layout = previewLayout(detail);

    const rendered = layout.render(60).map(stripTerminalSequences).join("\n");
    expect(rendered).toContain("Generated");
    expect(rendered).toContain("generated body");
    expect(rendered).toContain("Authored");
    expect(rendered).not.toContain("authored body");
    expect(
      detail.previewRegions.regions.filter((region) => region.kind === "callout").map((region) =>
        region.id
      ),
    ).toEqual(["callout:0:note"]);
  });

  test("links the primary title and each visible ancestor to explicit Tree reveals", () => {
    const capabilities = getCapabilities();
    setCapabilities({ ...capabilities, hyperlinks: true });
    try {
      const detail = state("Selected leaf");
      setBlockDocument(detail, {
        selected: block("selected-01", "Selected leaf"),
        ancestors: [block("parent-001", "Parent page")],
        children: [],
      });
      detail.resolvedBreadcrumb = "Parent page › Selected leaf";
      const lines = new DetailPiPreviewLayout(
        detail,
        plainMarkdownTheme,
        true,
      ).render(80);
      const title = lines[0]!;
      const metadata = lines[1]!;

      expect(getOsc8LinkAtColumn(title, 2)).toBe(
        outlinerLinkUri("block", "selected-01", { intent: "reveal" }),
      );
      const visibleMetadata = stripTerminalSequences(metadata);
      expect(
        getOsc8LinkAtColumn(metadata, visibleMetadata.indexOf("Parent page") + 2),
      ).toBe(
        outlinerLinkUri("block", "parent-001", { intent: "reveal" }),
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
    layout.render(20);
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
    setBlockDocument(detail, {
      selected: block("block-2", "other raw source"),
      ancestors: [],
      children: [],
    });
    layout.render(20);
    expect(layout.scrollView.scrollTop).toBe(0);
  });

  test("opens and preserves durable fragment offsets", () => {
    const detail = state(Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n"));
    const layout = previewLayout(detail);
    layout.scrollView.setScrollbar("hidden");
    const contentHeight = renderedDocument(layout, 20).length;
    layout.scrollView.updateLayout(contentHeight, 6, () => {});

    setBlockDocument(detail, detail.context, {
      kind: "block",
      blockId: detail.context.selected!.id,
      fragmentId: "decision",
    });
    detail.previewOffset = 15;
    layout.render(20);
    const targetRow = layout.markdown.render(20).findIndex((line) =>
      stripTerminalSequences(line).includes("line 15")
    );
    const inspectorHeight = layout.inspectorMarkdown.render(20).length + 1;
    expect(layout.scrollView.scrollTop).toBe(inspectorHeight + targetRow);
    const initialScrollTop = layout.scrollView.scrollTop;

    layout.scrollView.scrollBy(2);
    detail.status = "ordinary status update";
    layout.render(20);
    expect(layout.scrollView.scrollTop).toBe(initialScrollTop + 2);

    detail.resolvedSelectedText = `new leading line\n${detail.resolvedSelectedText}`;
    detail.previewOffset = 16;
    layout.render(20);
    const shiftedTargetRow = layout.markdown.render(20).findIndex((line) =>
      stripTerminalSequences(line).includes("line 15")
    );
    expect(layout.scrollView.scrollTop).toBe(inspectorHeight + shiftedTargetRow);
  });

  test("late enrichment preserves scrolling away from the opened fragment", () => {
    const text = Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n");
    const detail = state(text, text);
    detail.readStatus = "pending";
    setBlockDocument(detail, detail.context, { kind: "block", blockId: "block-1", fragmentId: "decision" });
    detail.previewOffset = 10;
    const layout = previewLayout(detail);
    layout.scrollView.setScrollbar("hidden");
    const contentHeight = renderedDocument(layout, 40).length;
    layout.scrollView.updateLayout(contentHeight, 6, () => {});
    layout.render(40);
    layout.scrollView.scrollBy(3);
    const userScroll = layout.scrollView.scrollTop;

    detail.resolvedSelectedText = text.replace("line 0", "Resolved opening line");
    detail.readStatus = "ready";
    layout.render(40);
    expect(layout.scrollView.scrollTop).toBe(userScroll);
  });

  test("maps fragment lines through embed projection and wrapped Markdown rows", () => {
    const canonical = [
      "!((embed-block))",
      "",
      "## Target ^target",
      ...Array.from({ length: 16 }, (_, index) => `tail ${index}`),
    ].join("\n");
    const projected = [
      "A generated embed line long enough to wrap over several rendered rows",
      "generated second",
      "generated third",
      "",
      "## Target",
      ...Array.from({ length: 16 }, (_, index) => `tail ${index}`),
    ].join("\n");
    const detail = state(projected, canonical);
    detail.projectedSelectedText = projected;
    detail.embedRanges = [{ startLine: 0, endLine: 2 }];
    const layout = previewLayout(detail);
    layout.scrollView.setScrollbar("hidden");
    const contentHeight = renderedDocument(layout, 18).length;
    layout.scrollView.updateLayout(contentHeight, 5, () => {});

    setBlockDocument(detail, detail.context, {
      kind: "block",
      blockId: detail.context.selected!.id,
      fragmentId: "target",
    });
    detail.previewOffset = 2;
    layout.render(18);

    const inspectorHeight = layout.inspectorMarkdown.render(18).length + 1;
    const expectedSourceRow = draftSourceRowAnchors(
      projected,
      18,
      plainMarkdownTheme,
    )[4]!;
    const renderedTargetRow = layout.markdown.render(18).findIndex((line) =>
      stripTerminalSequences(line).includes("Target")
    );
    expect(expectedSourceRow).toBe(renderedTargetRow);
    expect(inspectorHeight + expectedSourceRow).toBeGreaterThan(detail.previewOffset);
    expect(layout.scrollView.scrollTop).toBe(inspectorHeight + renderedTargetRow);
  });

  test("maps a fragment below a collapsed callout to the displayed row", () => {
    const canonical = [
      "Before",
      "",
      "> [!note]- Hidden details",
      "> A hidden line that would wrap across several rows in the preview.",
      "> Another hidden line.",
      "",
      "## Target ^target",
      ...Array.from({ length: 16 }, (_, index) => `tail ${index}`),
    ].join("\n");
    const projected = canonical.replace(" ^target", "");
    const detail = state(projected, canonical);
    detail.projectedSelectedText = projected;
    setBlockDocument(detail, detail.context, {
      kind: "block",
      blockId: detail.context.selected!.id,
      fragmentId: "target",
    });
    detail.previewOffset = 6;
    const layout = previewLayout(detail);
    layout.scrollView.setScrollbar("hidden");
    const contentHeight = renderedDocument(layout, 18).length;
    layout.scrollView.updateLayout(contentHeight, 5, () => {});

    layout.render(18);

    const rendered = layout.markdown.render(18);
    const targetRow = rendered.findIndex((line) =>
      stripTerminalSequences(line).includes("Target")
    );
    expect(targetRow).toBeGreaterThanOrEqual(0);
    const inspectorLines = layout.inspectorMarkdown.render(18);
    const inspectorHeight = inspectorLines.length > 0 ? inspectorLines.length + 1 : 0;
    expect(rendered.some((line) =>
      stripTerminalSequences(line).includes("A hidden line")
    )).toBe(false);
    expect(layout.scrollView.scrollTop).toBe(inspectorHeight + targetRow);
  });

  test("maps a fragment after a fenced block using the full rendered document", () => {
    const canonical = [
      "A paragraph whose words wrap onto several displayed rows at this width.",
      "",
      "```ts",
      "const deliberatelyLongName = 'a value that wraps';",
      "```",
      "## Target ^target",
      ...Array.from({ length: 16 }, (_, index) => `tail ${index}`),
    ].join("\n");
    const projected = canonical.replace(" ^target", "");
    const detail = state(projected, canonical);
    detail.projectedSelectedText = projected;
    setBlockDocument(detail, detail.context, {
      kind: "block",
      blockId: detail.context.selected!.id,
      fragmentId: "target",
    });
    detail.previewOffset = 5;
    const layout = previewLayout(detail);
    layout.scrollView.setScrollbar("hidden");
    const contentHeight = renderedDocument(layout, 18).length;
    layout.scrollView.updateLayout(contentHeight, 5, () => {});

    layout.render(18);

    const rendered = layout.markdown.render(18);
    const targetRow = rendered.findIndex((line) =>
      stripTerminalSequences(line).includes("Target")
    );
    const inspectorLines = layout.inspectorMarkdown.render(18);
    const inspectorHeight = inspectorLines.length > 0 ? inspectorLines.length + 1 : 0;
    expect(targetRow).toBeGreaterThan(detail.previewOffset);
    expect(layout.scrollView.scrollTop).toBe(inspectorHeight + targetRow);
  });

  test("maps one requested source line without quadratic Markdown prefix work", () => {
    const originalRender = Markdown.prototype.render;
    function measuredMapping(lineCount: number): { row: number; work: number } {
      let work = 0;
      Markdown.prototype.render = function (width: number): string[] {
        work += (this as unknown as { text: string }).text.length;
        return originalRender.call(this, width);
      };
      try {
        const text = Array.from(
          { length: lineCount },
          (_, index) => `source line ${index} contains enough words to wrap`,
        ).join("\n");
        const markdown = new SourceSpannedMarkdown(plainMarkdownTheme, (value) => value);
        markdown.setContent(text, [], false);
        const rendered = markdown.renderWithSourceLineRow(24, lineCount - 1);
        return { row: rendered.sourceLineRow, work };
      } finally {
        Markdown.prototype.render = originalRender;
      }
    }

    const small = measuredMapping(80);
    const large = measuredMapping(160);
    expect(small.row).toBeGreaterThan(0);
    expect(large.row).toBeGreaterThan(small.row);
    expect(large.work).toBeLessThan(small.work * 3);
  });

  test("indexes sibling callouts once when mapping a source row", () => {
    function measuredMapping(calloutCount: number): { row: number; accesses: number } {
      const source = [
        ...Array.from(
          { length: calloutCount },
          (_, index) => `> [!note] Callout ${index}\n> body ${index}`,
        ),
        "## Target",
      ].join("\n");
      const parsed = parseDetailCallouts(source);
      let accesses = 0;
      const callouts = new Proxy(parsed, {
        get(target, property, receiver) {
          if (typeof property === "string" && /^\d+$/.test(property)) accesses += 1;
          return Reflect.get(target, property, receiver);
        },
      });
      const previewRegions = {
        regions: parsed,
        focusedRegionId: null,
        disclosureOverrides: new Map(),
      };
      const markdown = new SourceSpannedMarkdown(
        plainMarkdownTheme,
        (value) => value,
        previewRegions,
      );
      markdown.setContent(source, [], false, callouts);
      accesses = 0;
      const rendered = markdown.renderWithSourceLineRow(40, calloutCount * 2);
      return { row: rendered.sourceLineRow, accesses };
    }

    const small = measuredMapping(40);
    const large = measuredMapping(80);
    expect(small.row).toBeGreaterThan(0);
    expect(large.row).toBeGreaterThan(small.row);
    expect(large.accesses).toBeLessThan(small.accesses * 3);
  });

  test("without links, updates Markdown only when the resolved source changes", () => {
    const detail = state("Initial **document**");
    const layout = previewLayout(detail);
    const originalSetContent = layout.markdown.setContent.bind(layout.markdown);
    let updates = 0;
    layout.markdown.setContent = (text, ranges, enabled): void => {
      updates += 1;
      originalSetContent(text, ranges, enabled);
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

  test("reuses authored callout parsing until the authored source changes", () => {
    let styleLookups = 0;
    const calloutTheme: DetailCalloutTheme = {
      ...DEFAULT_DETAIL_CALLOUT_THEME,
      types: new Proxy(DEFAULT_DETAIL_CALLOUT_THEME.types, {
        get(target, property, receiver) {
          styleLookups += 1;
          return Reflect.get(target, property, receiver);
        },
      }),
    };
    const note = "> [!note]+ Cached callout\n> stable body";
    const detail = state(note, note);
    const layout = new DetailPiPreviewLayout(
      detail,
      plainMarkdownTheme,
      false,
      undefined,
      { calloutTheme },
    );

    layout.syncState();
    const initialLookups = styleLookups;
    expect(initialLookups).toBeGreaterThan(0);
    detail.status = "status-only change";
    detail.previewOffset = 1;
    detail.previewRegions.focusedRegionId = detail.previewRegions.regions.find(
      (region) => region.kind === "callout",
    )?.id ?? null;
    layout.syncState();
    expect(styleLookups).toBe(initialLookups);

    const warning = "> [!warning]+ Changed callout\n> changed body";
    detail.context.selected!.text = warning;
    detail.resolvedSelectedText = warning;
    detail.projectedSelectedText = warning;
    layout.syncState();
    expect(styleLookups).toBeGreaterThan(initialLookups);
    expect(
      detail.previewRegions.regions.find((region) => region.kind === "callout"),
    ).toEqual(expect.objectContaining({
      calloutType: "warning",
      title: "Changed callout",
    }));

    const warningLookups = styleLookups;
    const renamedWarning = "> [!warning]+ Renamed callout\n> changed body";
    detail.context.selected!.text = renamedWarning;
    detail.resolvedSelectedText = renamedWarning;
    detail.projectedSelectedText = renamedWarning;
    layout.syncState();
    expect(styleLookups).toBeGreaterThan(warningLookups);
    expect(
      detail.previewRegions.regions.find((region) => region.kind === "callout"),
    ).toEqual(expect.objectContaining({
      calloutType: "warning",
      title: "Renamed callout",
    }));
  });
  test("renders a clickable unsaved draft and restores canonical preview on cancel", () => {
    const capabilities = getCapabilities();
    setCapabilities({ ...capabilities, hyperlinks: true });
    try {
      const targetId = "550e8400-e29b-41d4-a716-446655440000";
      const detail = state("Canonical preview", "Canonical source");
      detail.mode = "edit";
      detail.buffer = new TextBuffer(`Unsaved ((${targetId})) draft`);
      let editing = true;
      const layout = new DetailPiPreviewLayout(
        detail,
        plainMarkdownTheme,
        true,
        undefined,
        { draftText: () => editing ? detail.buffer.text : null },
      );
      layout.setActive(true);
      layout.syncState();

      const draftLine = layout.markdown.render(80).find((line) =>
        stripTerminalSequences(line).includes("Unsaved")
      );
      expect(draftLine).toBeDefined();
      const draftText = stripTerminalSequences(draftLine!);
      expect(getOsc8LinkAtColumn(draftLine!, draftText.indexOf(targetId) + 2)).toBe(
        `pi-outliner://block/${targetId}`,
      );

      editing = false;
      detail.mode = "preview";
      layout.syncState();
      const canonical = layout.markdown.render(80).map(stripTerminalSequences).join(" ");
      expect(canonical).toContain("Canonical preview");
      expect(canonical).not.toContain("Unsaved");
    } finally {
      setCapabilities(capabilities);
    }
  });

  test("replaces the immediate draft with its generated read projection", async () => {
    const detail = state("Canonical preview", "Canonical source");
    detail.mode = "edit";
    detail.buffer = new TextBuffer("!((view-next))");
    const projected = Promise.withResolvers<void>();
    const layout = new DetailPiPreviewLayout(
      detail,
      plainMarkdownTheme,
      false,
      projected.resolve,
      {
        draftText: () => detail.buffer.text,
        projectionDelayMs: 0,
        async projectDraft(text) {
          expect(text).toBe("!((view-next))");
          return {
            sourceText: "Embedded draft result",
            rawText: text,
            embedRanges: [{ startLine: 0, endLine: 0 }],
            workIdPrefix: null,
          };
        },
      },
    );
    layout.setActive(true);
    layout.syncState();
    expect(layout.markdown.render(80).map(stripTerminalSequences).join(" ")).toContain(
      "!((view-next))",
    );

    await projected.promise;

    expect(layout.markdown.render(80).map(stripTerminalSequences).join(" ")).toContain(
      "Embedded draft result",
    );
  });

  test("retries a failed draft projection after leaving and re-entering edit mode", async () => {
    const detail = state("Canonical preview", "Canonical source");
    detail.mode = "edit";
    detail.buffer = new TextBuffer("draft source");
    let editing = true;
    let attempts = 0;
    const firstFinished = Promise.withResolvers<void>();
    const retryFinished = Promise.withResolvers<void>();
    const layout = new DetailPiPreviewLayout(
      detail,
      plainMarkdownTheme,
      false,
      () => {
        if (attempts === 1) firstFinished.resolve();
        else if (attempts === 2) retryFinished.resolve();
      },
      {
        draftText: () => editing ? detail.buffer.text : null,
        projectionDelayMs: 0,
        async projectDraft(text) {
          attempts += 1;
          if (attempts === 1) throw new Error("temporary projection failure");
          return {
            sourceText: "Recovered draft projection",
            rawText: text,
            embedRanges: [],
            workIdPrefix: null,
          };
        },
      },
    );
    layout.setActive(true);
    layout.syncState();

    await firstFinished.promise;
    expect(renderedDocument(layout, 80).join(" ")).toContain(
      "Draft preview error: temporary projection failure",
    );

    editing = false;
    detail.mode = "preview";
    layout.syncState();
    expect(renderedDocument(layout, 80).join(" ")).toContain("Canonical preview");

    editing = true;
    detail.mode = "edit";
    layout.syncState();
    await retryFinished.promise;

    expect(attempts).toBe(2);
    expect(renderedDocument(layout, 80).join(" ")).toContain(
      "Recovered draft projection",
    );
  });

  test("restarts an in-flight projection after split deactivation", async () => {
    const detail = state("Canonical preview", "Canonical source");
    detail.mode = "edit";
    detail.buffer = new TextBuffer("unchanged draft");
    let attempts = 0;
    const firstStarted = Promise.withResolvers<void>();
    const firstResponse = Promise.withResolvers<void>();
    const retryFinished = Promise.withResolvers<void>();
    const layout = new DetailPiPreviewLayout(
      detail,
      plainMarkdownTheme,
      false,
      () => {
        if (attempts === 2) retryFinished.resolve();
      },
      {
        draftText: () => detail.buffer.text,
        projectionDelayMs: 0,
        async projectDraft(text) {
          attempts += 1;
          if (attempts === 1) {
            firstStarted.resolve();
            await firstResponse.promise;
            return {
              sourceText: "Stale projection",
              rawText: text,
              embedRanges: [],
              workIdPrefix: null,
            };
          }
          return {
            sourceText: "Restarted projection",
            rawText: text,
            embedRanges: [],
            workIdPrefix: null,
          };
        },
      },
    );
    layout.setActive(true);
    layout.syncState();
    await firstStarted.promise;

    layout.setActive(false);
    firstResponse.resolve();
    await Promise.resolve();
    await Promise.resolve();
    layout.setActive(true);
    layout.syncState();
    await retryFinished.promise;

    expect(attempts).toBe(2);
    expect(renderedDocument(layout, 80).join(" ")).toContain("Restarted projection");
  });

  test("does not reuse a same-text projection across selected blocks", async () => {
    const detail = state("Canonical preview", "same draft");
    detail.mode = "edit";
    detail.buffer = new TextBuffer("same draft");
    let attempts = 0;
    const firstFinished = Promise.withResolvers<void>();
    const secondFinished = Promise.withResolvers<void>();
    const layout = new DetailPiPreviewLayout(
      detail,
      plainMarkdownTheme,
      false,
      () => {
        if (attempts === 1) firstFinished.resolve();
        else if (attempts === 2) secondFinished.resolve();
      },
      {
        draftText: () => detail.buffer.text,
        projectionDelayMs: 0,
        async projectDraft(text) {
          attempts += 1;
          return {
            sourceText: `Projection for ${detail.context.selected?.id}`,
            rawText: text,
            embedRanges: [],
            workIdPrefix: null,
          };
        },
      },
    );
    layout.setActive(true);
    layout.syncState();
    await firstFinished.promise;
    expect(renderedDocument(layout, 80).join(" ")).toContain("Projection for block-1");

    detail.context.selected = block("block-2", "same draft");
    layout.syncState();
    await secondFinished.promise;

    const rendered = renderedDocument(layout, 80).join(" ");
    expect(attempts).toBe(2);
    expect(rendered).toContain("Projection for block-2");
    expect(rendered).not.toContain("Projection for block-1");
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

    const backlinkAction = { type: "backlink.open", blockId: "source-target" } as const;
    const backlinkUri = previewRegionActionUri(backlinkAction);
    const generated = renderBacklinksDocument(detail);
    expect(generated.match(new RegExp(backlinkUri, "g"))).toHaveLength(2);
    expect(resolvePreviewPointerAction(backlinkAction, false)).toEqual({
      type: "focus",
      regionId: "backlink:source-target",
    });
    expect(resolvePreviewPointerAction(backlinkAction, true)).toEqual({
      type: "activate",
      action: backlinkAction,
    });
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
      type: "backlink.source.disclosure.toggle",
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

describe("structured property inspector presentations", () => {
  const relationshipIds = [
    "550e8400-e29b-41d4-a716-446655440010",
    "550e8400-e29b-41d4-a716-446655440011",
  ];
  const canonical = [
    "PIE-154 property fixture [type::design-note]",
    `[related-to:: ${relationshipIds[0]}]`,
    `[related-to:: ${relationshipIds[1]}]`,
    "[page:: Planning / Inbox]",
    "",
    "ctx:: body-line",
    "Body [work-id:: PIE-171] [unknown-key:: kept]",
    "",
    "> [!note]+ Existing callout",
    "> unchanged",
  ].join("\n");

  function propertyState(presentation: "inline" | "dedicated"): DetailState {
    const detail = state("> [!note]+ Existing callout\n> unchanged", canonical);
    detail.propertyInspector = {
      presentation,
      model: createPropertyInspectorModel(detail.context.selected!.id, canonical),
      expanded: true,
      groupBy: null,
      filter: "",
      filterDraft: null,
      viewportOffset: 0,
      edit: null,
    };
    return detail;
  }

  test("uses one canonical model for inline and dedicated rows without losing occurrence data", () => {
    const inline = propertyState("inline");
    const dedicated = propertyState("dedicated");
    const inlineEntries = detailPropertyInspectorRegions(inline)
      .filter((region) => region.kind === "property-entry");
    const dedicatedEntries = detailPropertyInspectorRegions(dedicated)
      .filter((region) => region.kind === "property-entry");

    expect(inlineEntries.map((region) => region.id)).toEqual(
      inline.propertyInspector.model!.entries.map((entry) => entry.occurrenceId),
    );
    expect(dedicatedEntries.map((region) => region.id)).toEqual(
      inlineEntries.map((region) => region.id),
    );
    expect(inline.propertyInspector.model?.entries.map((entry) => entry.scope))
      .toEqual(["block", "block", "block", "block", "line", "inline", "inline"]);
    expect(
      inline.propertyInspector.model?.entries
        .filter((entry) => entry.key === "related-to")
        .map((entry) => entry.value),
    ).toEqual(relationshipIds);
    expect(inline.propertyInspector.model?.canonicalText).toBe(canonical);
    expect(inline.context.selected?.text).toBe(canonical);
  });

  test("renders responsive table columns and typed target actions", () => {
    const detail = propertyState("inline");
    const regions = detailPropertyInspectorRegions(detail);
    const model = detail.propertyInspector.model!;
    for (const entry of model.entries) {
      const region = regions.find((candidate) => candidate.id === entry.occurrenceId)!;
      expect(region.sourceSpan).toMatchObject({
        start: entry.start,
        end: entry.end,
        startLine: entry.line,
      });
      if (entry.target) {
        expect(region.activation).toEqual({
          type: "property-inspector.target.open",
          occurrenceId: entry.occurrenceId,
        });
      } else expect(region.activation).toBeNull();
    }

    const wide = renderPropertyInspectorDocument(detail, 100);
    const narrow = renderPropertyInspectorDocument(detail, 36);
    expect(wide).toContain("| Property | Value | Scope | Source |");
    expect(wide).toContain("| [**related-to**](pi-outliner-detail://focus/");
    expect(wide).toContain("#1 · L2:C1");
    expect(wide).toContain("unknown-key");
    expect(narrow).toContain("| Property | Value | Source |");
    expect(narrow).not.toContain("| Property | Value | Scope | Source |");
    const typed = model.entries.find((entry) => entry.target?.kind === "work-id")!;
    const uri = previewRegionActionUri({
      type: "property-inspector.target.open",
      occurrenceId: typed.occurrenceId,
    });
    expect(parseDetailPreviewActionUri(uri)).toEqual({
      type: "property-inspector.target.open",
      occurrenceId: typed.occurrenceId,
    });
    const focusUri = previewRegionActionUri({
      type: "preview.region.focus",
      regionId: typed.occurrenceId,
    });
    expect(parseDetailPreviewActionUri(focusUri)).toEqual({
      type: "preview.region.focus",
      regionId: typed.occurrenceId,
    });
    expect(resolvePreviewPointerAction({
      type: "property-inspector.target.open",
      occurrenceId: typed.occurrenceId,
    }, false)).toEqual({
      type: "activate",
      action: {
        type: "property-inspector.target.open",
        occurrenceId: typed.occurrenceId,
      },
      routing: "first-unlocked",
    });
    expect(resolvePreviewPointerAction({
      type: "property-inspector.target.open",
      occurrenceId: typed.occurrenceId,
    }, true)).toEqual({
      type: "activate",
      action: {
        type: "property-inspector.target.open",
        occurrenceId: typed.occurrenceId,
      },
      routing: "chooser",
    });
    expect(detail.context.selected?.text).toBe(canonical);
  });

  test("uses the Backlinks active background for the focused property row", () => {
    const detail = propertyState("dedicated");
    const entry = detail.propertyInspector.model!.entries[0]!;
    detail.previewRegions.focusedRegionId = entry.occurrenceId;
    const layout = new DetailPiPreviewLayout(detail, plainMarkdownTheme, false);

    const activeRow = layout.render(100).find((line) =>
      stripTerminalSequences(line).includes("▶ type")
    );
    expect(activeRow).toContain("\x1b[1;97;48;5;24m");
  });

  test("renders the focused property value as an in-place editable table cell", () => {
    const detail = propertyState("dedicated");
    const entry = detail.propertyInspector.model!.entries[0]!;
    const buffer = new TextBuffer("design-note-updated");
    buffer.moveEnd();
    detail.propertyInspector.edit = {
      occurrenceId: entry.occurrenceId,
      ordinal: entry.ordinal,
      blockId: detail.context.selected!.id,
      expectedRevision: detail.context.selected!.revision,
      buffer,
    };
    detail.previewRegions.focusedRegionId = entry.occurrenceId;

    const document = renderPropertyInspectorDocument(detail, 100);
    expect(document).toContain("Editing type");
    expect(document).toContain("✎ design-note-updated▏");
    expect(document).toContain("↵ save · ⎋ cancel");
  });

  test("adds inspector regions beside existing callout and Backlinks regions", () => {
    const detail = propertyState("inline");
    const layout = new DetailPiPreviewLayout(detail, plainMarkdownTheme, false);
    const rendered = layout.render(80).map(stripTerminalSequences).join("\n");
    const kinds = new Set(detail.previewRegions.regions.map((region) => region.kind));

    expect(kinds).toContain("callout");
    expect(kinds).toContain("property-inspector");
    expect(kinds).toContain("property-entry");
    expect(kinds).toContain("backlinks");
    expect(rendered).toContain("Existing callout");
    expect(rendered).toContain("Properties");
    expect(rendered).toContain("Backlinks");
    expect(detail.context.selected?.text).toBe(canonical);
  });

  test("places the promoted title above Properties and hides duplicate block metadata", () => {
    const detail = state(canonical, canonical);
    detail.propertyInspector = propertyState("inline").propertyInspector;
    detail.propertyInspector.expanded = false;
    const layout = previewLayout(detail);

    const collapsed = layout.render(100).map(stripTerminalSequences).join("\n");
    const collapsedTitle = collapsed.lastIndexOf("PIE-154 property fixture");
    expect(collapsedTitle).toBeGreaterThanOrEqual(0);
    expect(collapsedTitle).toBeLessThan(collapsed.indexOf("Properties"));
    expect(collapsed.indexOf("Properties")).toBeLessThan(collapsed.indexOf("ctx:: body-line"));
    expect(collapsed).not.toContain("[type::design-note]");
    expect(collapsed).not.toContain("[related-to::");
    expect(collapsed).toContain("[work-id:: PIE-171]");
    expect(collapsed).not.toContain("│ Property");

    detail.propertyInspector.expanded = true;
    const expanded = layout.render(100).map(stripTerminalSequences).join("\n");
    const expandedTitle = expanded.lastIndexOf("PIE-154 property fixture");
    expect(expandedTitle).toBeLessThan(expanded.indexOf("│ Property"));
    expect(expanded.indexOf("│ Property")).toBeLessThan(expanded.indexOf("ctx:: body-line"));
    expect(detail.context.selected?.text).toBe(canonical);
  });

  test("keeps callout PreviewRegion spans anchored to authored source", () => {
    const targetId = "550e8400-e29b-41d4-a716-446655440000";
    const canonical = [
      `Before ((${targetId}))`,
      "> [!note]+ Exact span",
      `> Body ((${targetId}))`,
    ].join("\n");
    const resolved = [
      "Before a substantially longer resolved reference title",
      "> [!note]+ Exact span",
      "> Body another substantially longer resolved reference title",
    ].join("\n");
    const detail = state(resolved, canonical);
    detail.context.selected!.id = targetId;
    setBlockDocument(detail, detail.context, { kind: "block", blockId: targetId });
    const layout = new DetailPiPreviewLayout(
      detail,
      plainMarkdownTheme,
      true,
    );

    layout.render(80);

    const callout = detail.previewRegions.regions.find((region) =>
      region.kind === "callout"
    );
    expect(callout?.sourceSpan).not.toBeNull();
    expect(
      canonical.slice(callout!.sourceSpan!.start, callout!.sourceSpan!.end),
    ).toBe([
      "> [!note]+ Exact span",
      `> Body ((${targetId}))`,
    ].join("\n"));
    expect(layout.markdown.render(80).join("\n")).toContain("Exact span");
  });

  test("synchronizes dedicated inspector content before layout-node rendering", () => {
    const detail = propertyState("dedicated");
    const layout = previewLayout(detail);

    layout.syncState(80);

    expect(
      layout.inspectorMarkdown
        .render(layout.scrollView.getContentWidth(80))
        .map(stripTerminalSequences)
        .join("\n"),
    ).toContain("Properties");
  });

  test("scrolls focused property rows into view at narrow and wide widths", () => {
    const canonical = [
      "Many properties",
      ...Array.from(
        { length: 20 },
        (_, index) => `[field-${index}::value-${index}]`,
      ),
    ].join("\n");

    for (const width of [40, 100]) {
      const detail = state(canonical, canonical);
      detail.propertyInspector = {
        presentation: "dedicated",
        model: createPropertyInspectorModel(
          detail.context.selected!.id,
          canonical,
        ),
        expanded: true,
        groupBy: "key",
        filter: "",
        filterDraft: null,
        viewportOffset: 0,
        edit: null,
      };
      const layout = previewLayout(detail);
      layout.render(width);
      const contentWidth = layout.scrollView.getContentWidth(width);
      const contentHeight = layout.inspectorMarkdown.render(contentWidth).length;
      layout.scrollView.updateLayout(contentHeight, 6, () => {});
      const lastEntry = detail.propertyInspector.model!.entries.at(-1)!;
      detail.previewRegions.focusedRegionId = lastEntry.occurrenceId;

      layout.render(width);

      const selectedRow = layout.inspectorMarkdown.render(contentWidth)
        .findIndex((line) => line.includes("▶ "));
      expect(selectedRow).toBeGreaterThanOrEqual(layout.scrollView.scrollTop);
      expect(selectedRow).toBeLessThan(
        layout.scrollView.scrollTop + layout.scrollView.viewportHeight,
      );
    }
  });

  test("scrolls a focused inline property row from beneath the document title", () => {
    const canonical = [
      "Inline properties",
      ...Array.from(
        { length: 20 },
        (_, index) => `[field-${index}::value-${index}]`,
      ),
      "",
      "Body",
    ].join("\n");
    const detail = state(canonical, canonical);
    detail.propertyInspector = {
      presentation: "inline",
      model: createPropertyInspectorModel(
        detail.context.selected!.id,
        canonical,
      ),
      expanded: true,
      groupBy: "key",
      filter: "",
      filterDraft: null,
      viewportOffset: 0,
      edit: null,
    };
    const layout = previewLayout(detail);
    const width = 40;
    layout.render(width);
    const contentWidth = layout.scrollView.getContentWidth(width);
    const authored = layout.markdown.render(contentWidth);
    const inspector = layout.inspectorMarkdown.render(contentWidth);
    layout.scrollView.updateLayout(authored.length + inspector.length + 1, 6, () => {});
    const lastEntry = detail.propertyInspector.model!.entries.at(-1)!;
    detail.previewRegions.focusedRegionId = lastEntry.occurrenceId;

    layout.render(width);

    const titleEnd = authored.findIndex((line) => stripTerminalSequences(line).trim() === "");
    const selectedLine = layout.inspectorMarkdown.render(contentWidth)
      .findIndex((line) => line.includes("▶ "));
    const selectedRow = titleEnd + 1 + selectedLine;
    expect(selectedRow).toBeGreaterThanOrEqual(layout.scrollView.scrollTop);
    expect(selectedRow).toBeLessThan(
      layout.scrollView.scrollTop + layout.scrollView.viewportHeight,
    );
  });
});

test("keeps reader selection highlighted without changing preview scroll", () => {
  const raw = Array.from({ length: 40 }, (_, index) =>
    index === 8 ? "alpha **selected phrase** omega" : `line ${index}`
  ).join("\n");
  const detail = state(raw, raw);
  const layout = previewLayout(detail);
  layout.scrollView.setScrollbar("hidden");
  layout.syncState(48);
  const contentHeight = renderedDocument(layout, 48).length;
  layout.scrollView.updateLayout(contentHeight, 8, () => {});
  layout.scrollView.scrollBy(5);
  const initialScroll = layout.scrollView.scrollTop;

  detail.mode = "select";
  detail.buffer = new TextBuffer(raw);
  detail.buffer.placeCursor(8, 8);
  detail.buffer.placeCursor(8, 23, true);
  const selecting = layout.scrollView.render(48);

  expect(layout.scrollView.scrollTop).toBe(initialScroll);
  expect(selecting.some((line) => {
    const visible = stripTerminalSequences(line);
    return visible.includes("▐ ") && visible.includes("selected phrase");
  })).toBe(true);

  const start = raw.indexOf("selected phrase");
  detail.mode = "comment";
  detail.annotationDraft = {
    requestId: "request-1",
    returnMode: "preview",
    target: textTarget(raw, start, start + "selected phrase".length),
  };
  detail.buffer = new TextBuffer("A contextual comment");
  layout.syncState(48);
  const commenting = layout.scrollView.render(48);

  expect(layout.scrollView.scrollTop).toBe(initialScroll);
  expect(commenting.some((line) => {
    const visible = stripTerminalSequences(line);
    return visible.includes("▐ ") && visible.includes("selected phrase");
  })).toBe(true);
});

test("maps rendered Markdown points back to UTF-16 source positions", () => {
  const raw = "1. Open the block in **Detail**.";
  const detail = state(raw, raw);
  const layout = previewLayout(detail);
  layout.syncState(60);
  layout.render(60);

  const point = layout.sourcePointAtViewport(3, 25, 60);

  expect(point).toEqual({ row: 0, column: raw.indexOf("Detail") + 4 });
});

test("maps cached web Markdown points without requiring a selected block", () => {
  const markdown = "# Web article\n\nChoose the **cached phrase** from this paragraph.";
  const detail = webState(markdown);
  const layout = previewLayout(detail);
  layout.scrollView.setScrollbar("hidden");
  layout.syncState(60);
  const rendered = layout.scrollView.render(60).map(stripTerminalSequences);
  const renderedRow = rendered.findIndex((line) => line.includes("cached phrase"));
  const renderedColumn = rendered[renderedRow]!.indexOf("cached phrase") + 4;

  expect(detail.context.selected).toBeNull();
  expect(
    layout.sourcePointAtViewport(renderedRow + 3, renderedColumn, 60),
  ).toEqual({
    row: 2,
    column: markdown.split("\n")[2]!.indexOf("cached phrase") + 4,
  });
});

test("renders a no-cache web resource without exposing generated guidance as source", () => {
  const detail = webState("# unavailable cache fixture");
  if (detail.document.kind !== "ready" || detail.document.document.kind !== "resource") {
    throw new Error("Expected a loaded web resource fixture");
  }
  const loaded = detail.document.document;
  detail.document = {
    kind: "ready",
    document: {
      ...loaded,
      description: {
        ...loaded.description,
        web: null,
        webStatus: {
          freshness: "unknown",
          checkedAt: null,
          lastError: null,
        },
      },
    },
  };
  const generated = [
    "# https://example.com/article",
    "",
    "## Local status",
    "",
    "- Freshness: **unknown**",
    "",
    "No local snapshot is available. Press r to refresh explicitly.",
  ].join("\n");
  detail.resolvedSelectedText = generated;
  detail.projectedSelectedText = generated;
  const layout = previewLayout(detail);
  layout.scrollView.setScrollbar("hidden");
  layout.syncState(50);
  const rendered = layout.scrollView.render(50).map(stripTerminalSequences);

  expect(rendered.join("\n")).toContain("No local snapshot is available");
  for (let row = 0; row < rendered.length; row += 1) {
    if (!rendered[row]!.trim()) continue;
    expect(layout.sourcePointAtViewport(row + 3, 0, 50)).toBeNull();
  }
});

test("resets cached web preview scroll by representation identity while hashes remain evidence", () => {
  const markdown = Array.from({ length: 24 }, (_, index) => `cached line ${index}`).join("\n");
  const detail = webState(markdown);
  if (detail.document.kind !== "ready" || detail.document.document.kind !== "resource") {
    throw new Error("Expected a loaded web resource fixture");
  }
  const target = detail.document.document.target;
  const initial = detail.document.document.description;
  const initialWeb = initial.web!;
  const layout = previewLayout(detail);
  layout.scrollView.setScrollbar("hidden");
  const contentHeight = renderedDocument(layout, 28).length;
  layout.scrollView.updateLayout(contentHeight, 5, () => {});
  layout.applyPendingFragmentScroll(28);
  layout.scrollView.scrollBy(4);

  expect(layout.scrollView.scrollTop).toBe(4);
  expect(detail.resolvedSelectedText).toContain(
    `- Source hash: \`${initialWeb.sourceSnapshot.contentHash}\``,
  );
  expect(detail.resolvedSelectedText).toContain(
    `- Representation hash: \`${initialWeb.representation.contentHash}\``,
  );

  detail.document = {
    kind: "ready",
    document: {
      kind: "resource",
      target,
      description: {
        ...initial,
        webStatus: {
          freshness: "stale",
          checkedAt: "2026-09-17T13:00:00.000Z",
          lastError: null,
        },
      },
    },
  };
  detail.resolvedSelectedText = detail.resolvedSelectedText.replace(
    "- Freshness: **fresh**",
    "- Freshness: **stale**",
  );
  detail.projectedSelectedText = detail.resolvedSelectedText;
  layout.render(28);
  expect(layout.scrollView.scrollTop).toBe(4);

  const nextRepresentation = {
    ...initialWeb.representation,
    id: "40000000-0000-4000-8000-000000000002",
  };
  detail.document = {
    kind: "ready",
    document: {
      kind: "resource",
      target,
      description: {
        ...initial,
        webStatus: {
          freshness: "stale",
          checkedAt: "2026-09-17T13:00:00.000Z",
          lastError: null,
        },
        web: {
          ...initialWeb,
          representation: nextRepresentation,
        },
        webHistory: {
          ...initial.webHistory!,
          representations: [
            ...initial.webHistory!.representations,
            nextRepresentation,
          ],
        },
      },
    },
  };
  detail.resolvedSelectedText = detail.resolvedSelectedText.replace(
    initialWeb.representation.id,
    nextRepresentation.id,
  );
  detail.projectedSelectedText = detail.resolvedSelectedText;
  layout.render(28);
  expect(nextRepresentation.contentHash).toBe(initialWeb.representation.contentHash);
  expect(layout.scrollView.scrollTop).toBe(0);
});

test("rejects generated web metadata rows for clicks and scroll source mapping", () => {
  for (const width of [24, 60]) {
    for (const ending of ["", "\n\n", "\r\n"]) {
      const markdown = "# Web article\n\nA cached paragraph that wraps across rows and ends with finalword." + ending;
      const detail = webState(markdown);
      const layout = previewLayout(detail);
      layout.scrollView.setScrollbar("hidden");
      layout.syncState(width);
      const rendered = layout.scrollView.render(width).map(stripTerminalSequences);
      const lastContentRow = rendered.findIndex((line) => line.includes("finalword"));
      const metadataRow = rendered.findIndex((line) => line.includes("Web resource"));
      expect(lastContentRow).toBeGreaterThanOrEqual(0);
      expect(metadataRow).toBeGreaterThan(lastContentRow);
      expect(layout.sourcePointAtViewport(lastContentRow + 3, 0, width)?.row).toBe(2);
      for (let row = lastContentRow + 1; row < rendered.length; row += 1) {
        if (!rendered[row]!.trim()) continue;
        expect(layout.sourcePointAtViewport(row + 3, 0, width)).toBeNull();
      }

      layout.scrollView.updateLayout(rendered.length, 1, () => {});
      layout.scrollView.scrollTo(lastContentRow);
      expect(layout.sourceLineAtScroll(width)).toBe(2);
      expect(layout.sourcePointAtViewport(3, 0, width)?.row).toBe(2);
      for (let row = lastContentRow + 1; row < rendered.length; row += 1) {
        if (!rendered[row]!.trim()) continue;
        layout.scrollView.scrollTo(row);
        expect(layout.sourceLineAtScroll(width)).toBeNull();
        expect(layout.sourcePointAtViewport(3, 0, width)).toBeNull();
      }
    }
  }
});

test("maps filesystem Resource text to mouse annotation selections", () => {
  const markdown = "# Field notes\n\nChoose the selectable phrase from this paragraph.";
  const detail = filesystemState(markdown);
  const layout = previewLayout(detail);
  const width = 60;
  layout.setActive(true);
  layout.syncState(width);
  const rendered = layout.scrollView.render(width).map(stripTerminalSequences);
  const renderedRow = rendered.findIndex((line) => line.includes("selectable phrase"));
  const renderedColumn = rendered[renderedRow]!.indexOf("selectable phrase");

  const start = layout.sourcePointAtViewport(renderedRow + 3, renderedColumn, width);
  const end = layout.sourcePointAtViewport(
    renderedRow + 3,
    renderedColumn + "selectable phrase".length,
    width,
  );

  expect(start).toEqual({ row: 2, column: markdown.split("\n")[2]!.indexOf("selectable phrase") });
  expect(end).toEqual({
    row: 2,
    column: markdown.split("\n")[2]!.indexOf("selectable phrase") + "selectable phrase".length,
  });
});

test("maps cached Web Resource Markdown to mouse annotation selections", () => {
  const markdown = "# Example Domain\n\nThis domain is for use in documentation examples.";
  const detail = webState(markdown);
  const layout = previewLayout(detail);
  const width = 60;
  layout.setActive(true);
  layout.syncState(width);
  const rendered = layout.scrollView.render(width).map(stripTerminalSequences);
  const renderedRow = rendered.findIndex((line) => line.includes("documentation examples"));
  const renderedColumn = rendered[renderedRow]!.indexOf("documentation examples");

  const start = layout.sourcePointAtViewport(renderedRow + 3, renderedColumn, width);
  const end = layout.sourcePointAtViewport(
    renderedRow + 3,
    renderedColumn + "documentation examples".length,
    width,
  );

  const sourceLine = markdown.split("\n")[2]!;
  const sourceColumn = sourceLine.indexOf("documentation examples");
  expect(start).toEqual({ row: 2, column: sourceColumn });
  expect(end).toEqual({
    row: 2,
    column: sourceColumn + "documentation examples".length,
  });
});

test("highlights keyboard selection in cached web Markdown", () => {
  const markdown = "# Web article\n\nChoose the **cached phrase** from this paragraph.";
  const detail = webState(markdown);
  const sourceLine = markdown.split("\n")[2]!;
  const selectionStart = sourceLine.indexOf("cached phrase");
  detail.mode = "select";
  detail.buffer = new TextBuffer(markdown);
  detail.buffer.placeCursor(2, selectionStart);
  detail.buffer.placeCursor(2, selectionStart + "cached phrase".length, true);

  const layout = previewLayout(detail);
  layout.setActive(true);
  layout.syncState(60);
  const selectedLine = layout.render(60).find((line) =>
    stripTerminalSequences(line).includes("cached phrase")
  )!;

  expect(stripTerminalSequences(selectedLine)).toContain("▐ ");
  expect(selectedLine).toContain("\x1b[1;4;97;48;5;24m");
});

test("maps keyboard selection through cached PDF Markdown", () => {
  const markdown = "## Page 1\n\nChoose the **PDF phrase** from this page.";
  const detail = webState(markdown);
  if (detail.document.kind !== "ready" || detail.document.document.kind !== "resource") {
    throw new Error("Expected a loaded Resource fixture");
  }
  const loaded = detail.document.document;
  const web = loaded.description.web;
  if (!web) throw new Error("Expected a retained fixture representation");
  const sourceSnapshot = {
    id: web.sourceSnapshot.id,
    resourceId: loaded.description.resource.id,
    addressVersion: loaded.description.resource.addressVersion,
    locator: loaded.description.resource.address.kind === "web"
      ? loaded.description.resource.address.url
      : "fixture.pdf",
    contentHash: web.sourceSnapshot.contentHash ?? "a".repeat(64),
    revision: web.sourceSnapshot.revision,
    capturedAt: web.sourceSnapshot.fetchedAt ?? "2026-09-17T12:00:00.000Z",
    bytesAvailable: true,
    evictedAt: null,
  };
  const representation = {
    ...web.representation,
    mediaType: "text/markdown" as const,
    derivedAt: web.representation.derivedAt ?? "2026-09-17T12:00:01.000Z",
  };
  const nativeRepresentation = {
    ...representation,
    id: "40000000-0000-4000-8000-000000000002",
    mediaType: "application/pdf" as const,
    adapter: { id: "builtin.pdf-native", version: 1 },
    contentHash: sourceSnapshot.contentHash,
  };
  detail.document = {
    kind: "ready",
    document: {
      ...loaded,
      description: {
        ...loaded.description,
        resource: { ...loaded.description.resource, mediaType: "application/pdf" },
        pdf: {
          markdown,
          pages: [{
            page: 1,
            width: 300,
            height: 400,
            start: 0,
            end: markdown.length,
            spans: [{
              start: markdown.indexOf("PDF phrase"),
              end: markdown.indexOf("PDF phrase") + "PDF phrase".length,
              region: { x: 36, y: 40, width: 80, height: 16 },
            }],
          }],
          sourceSnapshot,
          representation,
          nativeRepresentation,
        },
        pdfHistory: {
          sourceSnapshots: [sourceSnapshot],
          representations: [representation, nativeRepresentation],
        },
        web: null,
        webHistory: null,
      },
    },
  };
  detail.resolvedSelectedText = [
    markdown,
    "",
    "---",
    "",
    "## PDF resource",
    "",
    "PDF metadata",
  ].join("\n");
  detail.projectedSelectedText = detail.resolvedSelectedText;
  const absoluteStart = markdown.indexOf("PDF phrase");
  const pdfTarget: AnnotationTarget = {
    representation: {
      id: representation.id,
      subject: { kind: "resource", resourceId: loaded.description.resource.id },
      sourceSnapshot: {
        kind: "resource",
        resourceId: loaded.description.resource.id,
        sourceSnapshotId: sourceSnapshot.id,
        revision: sourceSnapshot.revision,
      },
      adapter: representation.adapter,
      mediaType: representation.mediaType,
      contentHash: representation.contentHash,
      capturedAt: representation.derivedAt,
    },
    anchor: {
      kind: "pdf-page-region",
      page: 1,
      regions: [{ x: 36, y: 40, width: 80, height: 16 }],
      start: absoluteStart,
      end: absoluteStart + "PDF phrase".length,
      exact: "PDF phrase",
      prefix: markdown.slice(Math.max(0, absoluteStart - 64), absoluteStart),
      suffix: markdown.slice(absoluteStart + "PDF phrase".length),
    },
  };
  detail.annotationThreads = [
    annotationThread("annotation-pdf", pdfTarget, "PDF comment"),
  ];
  const sourceLine = markdown.split("\n")[2]!;
  const selectionStart = sourceLine.indexOf("PDF phrase");
  detail.mode = "select";
  detail.buffer = new TextBuffer(markdown);
  detail.buffer.placeCursor(2, selectionStart);
  detail.buffer.placeCursor(2, selectionStart + "PDF phrase".length, true);

  const layout = previewLayout(detail);
  layout.setActive(true);
  layout.syncState(60);
  const selectedLine = layout.render(60).find((line) =>
    stripTerminalSequences(line).includes("PDF phrase")
  )!;
  expect(selectedLine).toContain("\x1b[1;4;97;48;5;24m");
  expect(detail.previewRegions.regions.some(({ kind }) => kind === "annotation")).toBe(true);
  const rendered = layout.scrollView.render(60).map(stripTerminalSequences);
  const metadataRow = rendered.findIndex((line) => line.includes("PDF metadata"));
  expect(metadataRow).toBeGreaterThanOrEqual(0);
  expect(layout.sourcePointAtViewport(metadataRow + 3, 0, 60)).toBeNull();
});

test("decorates the exact active attention phrase in Pi preview", () => {
  const detail = state(
    "target phrase then target phrase omega",
    "target phrase then target phrase omega",
  );
  const selected = detail.context.selected!;
  const start = selected.text.lastIndexOf("target");
  const mark = normalizeAttentionMark({
    markId: "pi-preview-mark",
    targetClientId: "detail-test",
    target: {
      kind: "block",
      sourceBlockId: selected.id,
      anchor: createAnnotationAnchor(
        selected.text,
        start,
        start + "target phrase".length,
        selected.updatedAt,
      ),
    },
    tone: "match",
    sender: "agent-test",
  }, {
    clientId: "detail-test",
    role: "detail",
    contextId: "detail-test",
  }, selected);
  detail.attention = attentionClientState("detail-test", [mark], 1);

  const layout = previewLayout(detail);
  const rendered = layout.render(48);
  const visible = rendered.map(stripTerminalSequences);
  expect(visible.some((line) => line.includes("ATTENTION MATCH"))).toBe(true);
  expect(visible.some((line) => line.includes("▐ target phrase then target phrase omega"))).toBe(true);
  expect(rendered.some((line) => line.includes("\x1b[1;4;32m"))).toBe(true);
  expect(rendered.join("\n")).toContain(`target phrase then \x1b[1;4;32mtarget phrase`);
  expect(rendered.every((line) => visibleWidth(line) <= 48)).toBe(true);
  const wrapped = layout.render(24);
  expect(wrapped.map(stripTerminalSequences).join("\n")).toContain("target phrase");
  expect(wrapped.some((line) => line.includes("\x1b[1;4;32m"))).toBe(true);
  expect(wrapped.every((line) => visibleWidth(line) <= 24)).toBe(true);
});
