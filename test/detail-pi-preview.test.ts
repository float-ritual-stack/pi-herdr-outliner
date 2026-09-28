import {concatDocuments,generatedDocument,observeDocument,sourceDocument} from '../src/document-provenance';
import {captureAnnotationPassage} from '../src/document-annotation';
import {resolveAnnotationPassage, passageResolutionStatus} from '../src/annotation-passages';
import {projectDetailRead} from '../src/detail-embeds';
import {measureRenderedLinks, withInternalLinks} from '../src/rendered-links';
import {resourceContentDocument} from '../src/document-resources';
import {terminalFixture} from './terminal-fixture';
import type {DocumentSelection} from '../src/document-frame';
import type {TuiCopySelection} from '@earendil-works/pi-tui/dist/tui-alt-screen';
import {renderLayoutFrame} from '@earendil-works/pi-tui/dist/layout.js';
import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { annotationScopeLabel, detailAnnotationGroups } from "../src/detail-annotations";
import { detailPropertyInspectorRegions } from "../src/property-inspector";
import {
  getCapabilities,
  getOsc8LinkAtColumn,
  Markdown,
  TuiAltScreen,
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
import { annotationSourceHash, createAnnotationAnchor, createAnnotationReferenceContext } from "../src/annotations";
import {
  DEFAULT_DETAIL_CALLOUT_THEME,
  type DetailCalloutTheme,
} from "../src/detail-callout-theme";
import { parseDetailCallouts } from "../src/detail-callouts";
import { renderedSelectionAnnotationTarget, type DetailState } from "../src/detail-controller";
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
  renderPropertyInspectorDocument,
} from "../src/detail-pi-renderer";
import { createPropertyInspectorModel } from "../src/property-inspector";
import {
  previewRegionActionUri,
  resolvePreviewPointerAction,
  togglePreviewRegionDisclosure,
} from "../src/detail-preview-regions";
import { outlinerLinkUri, parseOutlinerLinkUri } from "../src/outliner-links";
import {
  deriveResourceCapabilityReport,
  type Resource,
  type ResourceDescription,
  type ResourceSource,
} from "../src/resources";
import { createOpenDestinationChooserState } from "../src/open-destination-chooser";
import { negotiateResourcePresentation, TUI_RESOURCE_PRESENTATION_CONTEXT } from "../src/resource-presentation";
import {
  SourceSpannedMarkdown,
  sourceSpannedMarkdownSegments,
} from "../src/source-spanned-markdown";
import { TextBuffer } from "../src/text-buffer";
import type {
  AnnotationRepresentation,
  AnnotationTarget,
  AnnotationThread,
  BacklinkCollection,
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
        contentHash: annotationSourceHash(text),
      },
      adapter: { id: "outliner.block-text", version: 1 },
      mediaType: "text/markdown",
      contentHash: annotationSourceHash(text),
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

function passageThread(detail: DetailState, selection: DocumentSelection, id: string, body: string): AnnotationThread {
  const passage = captureAnnotationPassage(selection);
  const target = renderedSelectionAnnotationTarget(detail, {
    quote: selection.text, passage, capturedAt: "2026-01-02T03:04:05.000Z", hostBlockId: "block-1",
    paneId: "w1:p2", contentRevision: 1, contextId: "fixture", detailClientId: "reader",
    validation: "detail-pointer", snapshotText: selection.text,
  });
  const thread = annotationThread(id, target, body);
  const resolution = {...thread.currentResolution, passageResolution: resolveAnnotationPassage(passage,
    "2026-01-02T03:04:05.000Z", observed => observed)};
  return {...thread, currentResolution: resolution, resolutionHistory: [resolution]};
}

test("passage comments follow the selected embed occurrence and host tail through resize", async () => {
  const targetId = "10000000-0000-4000-8000-000000000001";
  const raw = `# Reader\n\n!((${targetId}))\n\nBetween copies\n\n!((${targetId}))\n\nTail marker`;
  const source = block(targetId, "# Shared\n\nRepeated passage for this reader");
  const projection = await projectDetailRead({async request<T>(input: import('../src/client').RequestInput): Promise<T> {
    if (input.action === "get" && input.blockId === targetId) return source as T;
    throw new Error(`Unexpected projection request ${input.action}`);
  }}, raw, {hostBlockId: "block-1", hostRevision: 1});
  const detail = state(projection.text, raw);
  detail.projectedSelectedText = projection.text;
  detail.resolvedProvenance = projection.provenance;
  detail.embedRanges = projection.embedRanges;
  const layout = previewLayout(detail);
  layout.render(64);
  const frame = layout.markdown.renderedFrame!;
  const rows = frame.lines.map(stripTerminalSequences);
  const repeated = rows.flatMap((line, row) => line.includes("Repeated passage") ? [row] : []);
  expect(repeated).toHaveLength(2);
  const tail = rows.findIndex(line => line.includes("Tail marker"));
  const selected = frame.selectRanges([
    {row: repeated[1]!, start: 0, end: 64}, {row: tail, start: 0, end: 64},
  ]);
  const thread = passageThread(detail, selected, "passage-comment", "One discussion across two sources");
  detail.annotationThreads = [thread];

  for (const width of [64, 30, 64]) {
    const lines = layout.render(width).map(stripTerminalSequences);
    const copies = lines.filter(line => line.includes("Repeated passage"));
    expect(copies).toHaveLength(2);
    expect(copies[0]).not.toStartWith("+ ");
    expect(copies[1]).toStartWith("+ ");
    expect(lines.find(line => line.includes("Tail marker"))).toStartWith("+ ");
    expect(lines.find(line => line.includes("Between copies"))).not.toStartWith("+ ");
    expect(lines.join("\n")).not.toContain("Unpositioned comments");
  }
  const group = detail.previewRegions.regions.find(region => region.kind === "annotation")!;
  expect(group.sourceSpan).toBeNull(); // Two sources must never become a broad host interval.
  togglePreviewRegionDisclosure(detail.previewRegions, group.id);
  const expanded = layout.render(64).map(stripTerminalSequences).join("\n");
  expect(expanded.match(/One discussion across two sources/g)).toHaveLength(1);
  expect(detail.previewRegions.regions.filter(region => region.kind === "annotation-thread")).toHaveLength(1);

  // Navigating to a hidden occurrence opens its ancestors, not its identical sibling.
  const sharedFolds=detail.previewRegions.regions.filter(region=>region.kind==='document-fold'&&
    region.sourceSpan&&projection.text.split('\n')[region.sourceSpan.startLine]?.includes('# Shared'));
  expect(sharedFolds).toHaveLength(2);
  for(const fold of sharedFolds)detail.previewRegions.disclosureOverrides.set(fold.id,false);
  expect(layout.render(64).map(stripTerminalSequences).join('\n')).not.toContain('Repeated passage');
  detail.selectedAnnotationId=thread.block.id;
  detail.previewRegions.focusedRegionId=`annotation-thread:${thread.block.id}`;
  const revealed=layout.render(64).map(stripTerminalSequences).join('\n');
  expect(revealed.match(/Repeated passage for this reader/g)).toHaveLength(1);
  expect(detail.previewRegions.disclosureOverrides.get(sharedFolds[0]!.id)).toBe(false);
  expect(detail.previewRegions.disclosureOverrides.get(sharedFolds[1]!.id)).toBe(true);
  detail.previewRegions.disclosureOverrides.set(sharedFolds[0]!.id,true);

  // Only the embedded source becomes ambiguous. The surviving host fragment
  // stays positioned even though the aggregate thread is unresolved.
  const changedSource = observeDocument({kind:"block", blockId:targetId},
    "Repeated passage for this reader / Repeated passage for this reader", 2);
  const passageResolution = resolveAnnotationPassage(thread.originalTarget.passage!, "2026-01-03T00:00:00.000Z",
    observed => observed.subject.kind === "block" && observed.subject.blockId === targetId ? changedSource : observed);
  expect(passageResolutionStatus(passageResolution)).toBe("unresolved");
  detail.annotationThreads = [{...thread, resolvedTarget:null,
    currentResolution:{...thread.currentResolution, status:"unresolved", resolvedTarget:null, passageResolution}}];
  const partial = layout.render(64).map(stripTerminalSequences);
  expect(partial.filter(line => line.includes("Repeated passage")).every(line => !line.startsWith("− "))).toBe(true);
  expect(partial.find(line => line.includes("Tail marker"))).toStartWith("− ");
  expect(partial.join("\n")).toContain("partly unresolved");
});

test("table comments keep independent controls when cell passages share a row or reflow to cards", () => {
  const raw = "# Table\n\n| Left | Right |\n| --- | --- |\n| alpha | beta |\n| untouched | other |";
  const detail = state(raw, raw);
  const layout = previewLayout(detail);
  layout.render(64);
  const frame = layout.markdown.renderedFrame!;
  const lines = frame.lines.map(stripTerminalSequences);
  const row = lines.findIndex(line => line.includes("alpha"));
  const threads = ["alpha", "beta"].map(word => {
    const column = lines[row]!.indexOf(word);
    return passageThread(detail, frame.selectRanges([{row, start:column, end:column + word.length}]), word, `Discuss ${word}`);
  });
  detail.annotationThreads = threads;
  const closed = withInternalLinks(() => layout.render(64));
  const regions = detail.previewRegions.regions.filter(region => region.kind === "annotation");
  expect(regions).toHaveLength(2);
  const links = measureRenderedLinks(closed).map(link => link.uri);
  for (const region of regions) {
    expect(links).toContain(previewRegionActionUri({type:"annotation.disclosure.toggle", regionId:region.id}));
    togglePreviewRegionDisclosure(detail.previewRegions, region.id);
  }
  for (const width of [64, 20, 64]) {
    const rendered = layout.render(width).map(stripTerminalSequences);
    expect(rendered.join("\n").match(/Discuss alpha/g)).toHaveLength(1);
    expect(rendered.join("\n").match(/Discuss beta/g)).toHaveLength(1);
    expect(rendered.find(line => line.includes("untouched"))).not.toStartWith("− ");
    expect(rendered.join("\n")).not.toContain("Unpositioned comments");
  }
  detail.selectedAnnotationId = "alpha";
  const focused = layout.render(64).find(line => stripTerminalSequences(line).includes("alpha") && stripTerminalSequences(line).includes("beta"))!;
  expect(focused).toContain("\x1b[1;97;48;5;24malpha\x1b[0m");
  expect(focused).not.toContain("\x1b[1;97;48;5;24mbeta");
});


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
    
    canNavigateBack: false,
    canNavigateForward: false,
    resolvedProvenance: text===rawText?sourceDocument(observeDocument({kind:"block",blockId:selected.id},rawText,selected.revision)):null,
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
      showRelated: false,
      showResolved: false,
      kindFilter: null,
      stageFilter: "all",
      expandedKinds: new Set(),
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
    contentHash: annotationSourceHash(markdown),
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
  detail.resolvedProvenance=concatDocuments([resourceContentDocument(description)!,generatedDocument(renderedDocument.slice(markdown.length),"resource metadata")]);
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
  detail.resolvedProvenance=concatDocuments([resourceContentDocument(description)!,generatedDocument(renderedDocument.slice(markdown.length),"resource metadata")]);
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

// These existing journeys characterize Expanded's metadata and source-row layout.
function expandedPreview(...args: ConstructorParameters<typeof DetailPiPreviewLayout>): DetailPiPreviewLayout {
  return new DetailPiPreviewLayout(args[0], args[1], args[2], args[3], {density: () => "expanded", ...args[4]});
}

function previewLayout(detail: DetailState): DetailPiPreviewLayout {
  return expandedPreview(detail, plainMarkdownTheme, false);
}

function renderedDocument(layout: DetailPiPreviewLayout, width: number): string[] {
  layout.render(width);
  return layout.markdown.render(width).map(stripTerminalSequences);
}

describe("Pi Markdown detail preview", () => {
  test("heading and list folds retain local choices and exact fragment navigation reveals only its ancestors", () => {
    const source = "Plan\n\n## First\n- Parent\n  - Hidden [destination](https://example.test) ^step\n\n## Other\nOther body";
    const detail = state(source, source), layout = previewLayout(detail);
    const paint = (width = 70) => renderedDocument(layout, width).join('\n');
    expect(paint()).toContain('Hidden');
    const folds = detail.previewRegions.regions.filter(region => region.kind === 'document-fold');
    const first = folds.find(region => region.sourceSpan!.startLine === 2)!;
    const list = folds.find(region => region.sourceSpan!.startLine === 3)!;
    const other = folds.find(region => region.sourceSpan!.startLine === 6)!;
    togglePreviewRegionDisclosure(detail.previewRegions, list.id);
    togglePreviewRegionDisclosure(detail.previewRegions, first.id);
    togglePreviewRegionDisclosure(detail.previewRegions, other.id);
    expect(paint()).not.toContain('Hidden');
    togglePreviewRegionDisclosure(detail.previewRegions, first.id);
    expect(paint(25)).toContain('Parent');
    expect(paint(25)).not.toContain('Hidden');
    expect(detail.previewRegions.regions.some(region => region.activation?.type === 'link.open' && region.activation.uri === 'https://example.test')).toBe(false);
    setBlockDocument(detail, detail.context, {kind:'block',blockId:detail.context.selected!.id,fragmentId:'step'});
    detail.previewOffset = 4;
    expect(paint(25)).toContain('Hidden');
    expect(paint(25)).not.toContain('Other body');
    expect(detail.context.selected!.text).toBe(source);
    const another = previewLayout(state(source, source));
    expect(renderedDocument(another, 25).join('\n')).toContain('Other body');
  });

  test("comments remain reachable under folded content and visible text maps to its original source line", () => {
    const text = 'Plan\n\n## Hidden section\nSecret target\n\n## Other section\nVisible target';
    const detail = state(text, text), layout = previewLayout(detail);
    const start = text.indexOf('Secret target');
    detail.annotationThreads = [annotationThread('comment-hidden', textTarget(text,start,start+13), 'Check the target')];
    layout.render(70);
    const fold = detail.previewRegions.regions.find(region => region.kind === 'document-fold')!;
    togglePreviewRegionDisclosure(detail.previewRegions,fold.id);
    const lines = layout.render(70).map(stripTerminalSequences);
    expect(lines.join('\n')).not.toContain('Secret target');
    const content = layout.scrollView.render(70).map(stripTerminalSequences);
    const row = content.findIndex(line => line.includes('Visible target'));
    expect(row).toBeGreaterThanOrEqual(0);
    expect(layout.sourcePointAtViewport(row+3,content[row]!.indexOf('Visible target'),70)?.row).toBe(6);
    const comment = detail.previewRegions.regions.find(region => region.kind === 'annotation')!;
    detail.previewRegions.focusedRegionId = comment.id;
    togglePreviewRegionDisclosure(detail.previewRegions,comment.id);
    const revealed = layout.render(70).map(stripTerminalSequences).join('\n');
    expect(revealed).toContain('Secret target');
    expect(revealed).toContain('Check the target');
  });

  test("Current, Preview and dedicated Properties retain a live destination header action", () => {
    let label = "Reading notes";
    for (const surface of ["Current", "Preview", "Properties"]) {
      const detail = state("Document body");
      if (surface === "Properties") detail.propertyInspector.presentation = "dedicated";
      const layout = expandedPreview(detail, plainMarkdownTheme, false, () => {}, {
        surfaceLabel: () => surface,
        destinationLabel: () => label,
      });
      const header = () => layout.render(60).find(line => stripTerminalSequences(line).startsWith("Opens in:"))!;
      label = "Reading notes";
      expect(stripTerminalSequences(header())).toContain("Reading notes");
      expect(getOsc8LinkAtColumn(header(), 0)).toBe("pi-outliner-action:detail.navigation.link");
      label = "Not linked";
      expect(stripTerminalSequences(header())).toContain("Not linked");
    }
  });
  test("renders distinct Resource occurrence links and renews them after metadata-only edits", () => {
    const capabilities = getCapabilities();
    setCapabilities({ ...capabilities, hyperlinks: true });
    try {
      const source = "References [status::open]\n\nFirst [file::same.md] and second [file::same.md].";
      const detail = state(source, source);
      detail.context.selected!.id = "source-block-001";
      const layout = expandedPreview(detail, plainMarkdownTheme, true);
      const targets = () => {
        layout.syncState();
        const line = layout.markdown.render(120).find(row => stripTerminalSequences(row).includes("First"))!;
        const visible = stripTerminalSequences(line);
        return [visible.indexOf("file::"), visible.lastIndexOf("file::")].map(column =>
          parseOutlinerLinkUri(getOsc8LinkAtColumn(line, column)!));
      };
      const initial = targets();
      expect(initial.map(target => target.occurrence?.start)).toEqual([
        source.indexOf("[file::same.md]"), source.lastIndexOf("[file::same.md]"),
      ]);
      setBlockDocument(detail, {
        selected: { ...detail.context.selected!, id: "source-block-002" }, ancestors: [], children: [],
      });
      expect(targets().map(target => target.value)).toEqual(["source-block-002", "source-block-002"]);
      detail.context.selected!.text = source.replace("open", "done");
      detail.context.selected!.revision += 1;
      detail.projectedSelectedText = detail.context.selected!.text;
      detail.resolvedSelectedText = detail.context.selected!.text;
      expect(targets().map(target => target.occurrence?.revision)).toEqual([2, 2]);
    } finally {
      setCapabilities(capabilities);
    }
  });
  test("does not report a missing reference before resolution has completed", () => {
    const source = "Related ((550e8400-e29b-41d4-a716-446655440123|Reference label))";
    const detail = state(source, source);
    detail.readStatus = "pending";
    const layout = expandedPreview(detail, plainMarkdownTheme, false);
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
      const layout = expandedPreview(detail, plainMarkdownTheme, true);
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
    const layout = expandedPreview(detail, styledTheme, false);

    layout.syncState();
    const raw = layout.markdown.render(80);
    const visible = raw.map((line) => stripTerminalSequences(line).trimEnd());

    expect(raw[0]).toContain("\x1b[4m");
    expect(visible[0]!.trimEnd()).toBe("Block title");
    expect(visible).toContain("▾ Section");
    expect(visible).toContain("▾ › Subsection");
    expect(visible).toContain("▾ ›› Detail");
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
    expect(lines[0]).toMatch(/\[⋯\]$/);
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

  test("includes visible body links in Detail keyboard traversal", () => {
    const capabilities = getCapabilities();
    setCapabilities({ ...capabilities, hyperlinks: true });
    try {
      const raw = "Document\n\n[[Decision Log|First body link]]\n\n[Second body link](https://example.com)";
      const detail = state(raw, raw);
      detail.context.selected!.id = "550e8400-e29b-41d4-a716-446655440000";
      const layout = expandedPreview(detail, plainMarkdownTheme, true);
      layout.render(60);
      const actions = detail.previewRegions.regions.filter(region => region.focusable)
        .map(region => JSON.stringify(region.activation)).join("\n");
      expect(actions).toContain(outlinerLinkUri("page", "Decision Log"));
      expect(actions).toContain("https://example.com");
    } finally {
      setCapabilities(capabilities);
    }
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
      const layout = expandedPreview(detail, plainMarkdownTheme, true);
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

      const fallback = expandedPreview(detail, plainMarkdownTheme, false);
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
      const layout = expandedPreview(detail, plainMarkdownTheme, true);
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
      const layout = expandedPreview(detail, plainMarkdownTheme, true);
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
    const commentRegions=detail.previewRegions.regions.filter(candidate=>candidate.kind==='annotation');
    expect(commentRegions).toHaveLength(2);
    const collapsedTarget = collapsed.find((line) => line.includes("target phrase"))!;
    expect(collapsedTarget.startsWith("+ ")).toBe(true);
    expect(collapsed.join("\n")).not.toContain("Comments ·");
    expect(collapsed.join("\n")).not.toContain("Check this range.");

    layout.scrollView.updateLayout(12, 6, () => {});
    detail.previewRegions.focusedRegionId = region.id;
    for(const comment of commentRegions)expect(togglePreviewRegionDisclosure(detail.previewRegions,comment.id)).toBe(true);
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
  test("comment threads render references and formatting like note text, reachable by keyboard", () => {
    const raw = "Title\n\ntarget phrase\n\nafter";
    const detail = state(raw, raw);
    // A linked header needs a real block identity.
    detail.context.selected = {...detail.context.selected!, id: "20000000-0000-4000-8000-000000000001"};
    const target = textTarget(raw, raw.indexOf("target phrase"), raw.indexOf("\n\nafter"));
    const blockId = "20000000-0000-4000-8000-000000000002";
    const body = `See [[Launch plan]], ((${blockId})) and **bold** in PIE-420.`;
    const root = annotationThread("comment-links", target, body);
    const reply = annotationThread("reply-links", target, "Filed [[PIE-419]] with `code`.", "agent");
    detail.annotationThreads = [{...root, replies: [{...reply, parentAnnotationId: root.block.id}]}];
    detail.annotationReferences = new Map([[body, `See [[Launch plan]], ((Resolved title)) and **bold** in PIE-420.`]]);
    const layout = expandedPreview(detail, plainMarkdownTheme, true);
    withInternalLinks(() => layout.render(72));
    const region = detail.previewRegions.regions.find(candidate => candidate.kind === "annotation")!;
    togglePreviewRegionDisclosure(detail.previewRegions, region.id);
    layout.scrollView.updateLayout(40, 40, () => {});
    const lines = withInternalLinks(() => layout.render(72));
    const text = lines.map(stripTerminalSequences).join("\n");
    expect(text).toContain("See Launch plan, Resolved title and bold in PIE-420.");
    expect(text).toContain("agent: Filed PIE-419 with code.");
    expect(text).not.toContain("\\");
    expect(text).not.toContain("**");
    const uris = measureRenderedLinks(lines).map(link => link.uri);
    for (const uri of [outlinerLinkUri("page", "Launch plan"), outlinerLinkUri("block", blockId),
      outlinerLinkUri("work", "PIE-420"), outlinerLinkUri("page", "PIE-419")]) expect(uris).toContain(uri);

    // Keyboard focus reaches the same links (and Open thread), after their thread, in reading order.
    const ids = detail.previewRegions.regions.map(candidate => candidate.id);
    const commentLinks = detail.previewRegions.regions.filter(candidate => candidate.id.startsWith("body-link:comment:"));
    expect(commentLinks.map(candidate => candidate.activation)).toEqual([
      outlinerLinkUri("page", "Launch plan"), outlinerLinkUri("block", blockId),
      outlinerLinkUri("work", "PIE-420"), outlinerLinkUri("block", root.block.id), outlinerLinkUri("page", "PIE-419"),
    ].map(uri => ({type: "link.open", uri})));
    expect(ids.indexOf(commentLinks[0]!.id)).toBeGreaterThan(ids.indexOf(`annotation-thread:${root.block.id}`));
    detail.previewRegions.focusedRegionId = commentLinks[1]!.id;
    const titleLine = () => withInternalLinks(() => layout.render(72)).find(line => stripTerminalSequences(line).includes("Resolved title"))!;
    const focused = titleLine();
    const start = focused.indexOf("\x1b[1;97;48;5;24m");
    expect(start).toBeGreaterThan(-1);
    expect(stripTerminalSequences(focused.slice(start))).toStartWith("Resolved title");
    detail.previewRegions.focusedRegionId = null;
    expect(titleLine()).not.toContain("\x1b[1;97;48;5;24m");
  });

  test("a wrapped comment link is one keyboard stop whose id does not depend on width", () => {
    const raw = "Title\n\ntarget phrase\n\nafter";
    const detail = state(raw, raw);
    detail.context.selected = {...detail.context.selected!, id: "20000000-0000-4000-8000-000000000001"};
    const target = textTarget(raw, raw.indexOf("target phrase"), raw.indexOf("\n\nafter"));
    const page = "Seasonal seed ordering and compost rota plan";
    detail.annotationThreads = [annotationThread("comment-wrap", target, `See [[${page}]] then [[${page}]] again.`)];
    const layout = expandedPreview(detail, plainMarkdownTheme, true);
    withInternalLinks(() => layout.render(34));
    togglePreviewRegionDisclosure(detail.previewRegions,
      detail.previewRegions.regions.find(candidate => candidate.kind === "annotation")!.id);
    layout.scrollView.updateLayout(40, 60, () => {});
    const uri = outlinerLinkUri("page", page);
    const stops = (width: number) => {
      withInternalLinks(() => layout.render(width));
      return detail.previewRegions.regions.filter(region => region.id.startsWith("body-link:comment:") &&
        region.activation?.type === "link.open" && region.activation.uri === uri).map(region => region.id);
    };
    const narrow = stops(34);
    const lines = withInternalLinks(() => layout.render(34));
    // The page name wraps at this width, yet each occurrence is a single stop.
    const rows = new Set(measureRenderedLinks(lines).filter(link => link.uri === uri).map(link => link.row));
    expect(rows.size).toBeGreaterThan(2);
    expect(narrow).toHaveLength(2);
    expect(stops(72)).toEqual(narrow);
    expect(stops(34)).toEqual(narrow);
    // Focus highlights every row of the first occurrence and nothing of the second.
    detail.previewRegions.focusedRegionId = narrow[0]!;
    const focused = withInternalLinks(() => layout.render(34))
      .filter(line => line.includes("\x1b[1;97;48;5;24m")).map(stripTerminalSequences);
    expect(focused.length).toBeGreaterThan(1);
    expect(focused[0]).toContain("See Seasonal");
    expect(focused.join(" ")).not.toContain("again");
  });

  function renderedComment(body: string): string[] {
    const raw = "Title\n\ntarget phrase\n\nafter";
    const detail = state(raw, raw);
    detail.context.selected = {...detail.context.selected!, id: "20000000-0000-4000-8000-000000000001"};
    const target = textTarget(raw, raw.indexOf("target phrase"), raw.indexOf("\n\nafter"));
    detail.annotationThreads = [annotationThread("comment-lines", target, body)];
    const layout = expandedPreview(detail, plainMarkdownTheme, true);
    withInternalLinks(() => layout.render(72));
    togglePreviewRegionDisclosure(detail.previewRegions,
      detail.previewRegions.regions.find(candidate => candidate.kind === "annotation")!.id);
    layout.scrollView.updateLayout(40, 40, () => {});
    return withInternalLinks(() => layout.render(72));
  }

  test("a comment line starting with an autolink links its address, not the closing bracket", () => {
    const lines = renderedComment(["<https://example.com/a>", "<div>still text</div>"].join("\n"));
    const uris = measureRenderedLinks(lines).map(link => link.uri);
    expect(uris).toContain("https://example.com/a");
    expect(uris.some(uri => uri.endsWith(">"))).toBe(false);
    expect(lines.map(stripTerminalSequences).join("\n")).toContain("<div>still text</div>");
  });

  test("a comment line shaped like a reference definition stays visible", () => {
    const text = renderedComment("Sources:\n\n[1]: https://example.com/ref").map(stripTerminalSequences).join("\n");
    expect(text).toContain("[1]: https://example.com/ref");
    expect(text).not.toContain("\\");
  });

  test("comment block syntax that would break the thread box renders as plain lines", () => {
    const raw = "Title\n\ntarget phrase\n\nafter";
    const detail = state(raw, raw);
    const target = textTarget(raw, raw.indexOf("target phrase"), raw.indexOf("\n\nafter"));
    const body = ["# Heading", "```ts", "const x = 1;", "```", "| a | b |", "| - | - |", "| 1 | 2 |",
      "<div>raw</div>", "Setext", "---", "- still a list with [[PIE-419]]"].join("\n");
    detail.annotationThreads = [annotationThread("comment-structure", target, body)];
    const layout = previewLayout(detail);
    layout.render(60);
    togglePreviewRegionDisclosure(detail.previewRegions,
      detail.previewRegions.regions.find(candidate => candidate.kind === "annotation")!.id);
    const lines = layout.render(60).map(stripTerminalSequences);
    const top = lines.findIndex(line => line.includes("╭ Comment 1"));
    const bottom = lines.findIndex((line, row) => row > top && line.includes("╰"));
    expect(lines.slice(top + 1, bottom).every(line => line.trimStart().startsWith("│"))).toBe(true);
    const panel = lines.slice(top + 1, bottom).join("\n");
    for (const literal of ["# Heading", "```ts", "| - | - |", "<div>raw</div>", "---", "still a list with PIE-419"]) {
      expect(panel).toContain(literal);
    }
    expect(panel).not.toContain("\\");
  });

  test("keeps pane-capture annotations reachable without applying screen offsets to Markdown", () => {
    const rendered = "Hub\n\n[Generated result](outliner://block/target)\n\nUnrelated final paragraph";
    const detail = state(rendered, "Hub\n\n!((virtual-branch))");
    const capturedFrame = previewLayout(detail).render(36).map(stripTerminalSequences).join("\n");
    const target = renderedSelectionAnnotationTarget(detail, {
      quote: "Generated result",
      capturedAt: "2026-01-02T03:04:05.000Z",
      hostBlockId: "block-1",
      paneId: "w1:p2",
      contentRevision: 42,
      contextId: "context-1",
      detailClientId: "detail-1",
      validation: "herdr-keybinding" as const,
      snapshotText: `Previous terminal history\n${capturedFrame}`,
    });
    expect(target.anchor.kind === "text-quote" && target.anchor.start).toBeGreaterThan(rendered.length);
    detail.annotationThreads = [
      annotationThread(
        "annotation-rendered",
        target,
        "Discuss the generated result.",
      ),
    ];
    const layout = previewLayout(detail);

    for (const width of [36, 72]) {
      const collapsed = layout.render(width).map(stripTerminalSequences);
      const region = detail.previewRegions.regions.find((candidate) =>
        candidate.kind === "annotation"
      )!;
      expect(region.sourceSpan).toBeNull();
      expect(collapsed.find((line) => line.includes("Generated result"))).not.toStartWith("+ ");
      expect(collapsed.find((line) => line.includes("Unrelated final"))).not.toStartWith("+ ");
      expect(collapsed.join("\n")).toContain("Unpositioned comments");
      expect(togglePreviewRegionDisclosure(detail.previewRegions, region.id)).toBe(true);
      const expanded = layout.render(width).map(stripTerminalSequences).join("\n");
      expect(expanded).toContain("Discuss the generated result.");
      expect(expanded).toContain("Generated result");
      expect(detail.annotationThreads[0]!.originalTarget).toEqual(target);
      expect(togglePreviewRegionDisclosure(detail.previewRegions, region.id)).toBe(false);
    }
  });

  test("general note comments have their own reachable group beside lost passages", () => {
    const original = "Title\n\nOld passage";
    const current = "Title\n\nRewritten body";
    const detail = state(current, current);
    const passage = textTarget(original, 7, original.length);
    const whole = { ...passage, anchor: { kind: "whole-subject" as const } };
    detail.annotationThreads = [
      annotationThread("general-note", whole, "Overall feedback"),
      annotationThread("lost-passage", passage, "Passage feedback"),
    ];
    const layout = previewLayout(detail);
    for (const width of [32, 72]) {
      const collapsed = layout.render(width).map(stripTerminalSequences).join("\n");
      expect(collapsed).toContain("Note comments (1)");
      expect(collapsed).toContain("Unpositioned comments (1)");
      const group = detail.previewRegions.regions.find(region => region.id.endsWith(":general"))!;
      expect(group.sourceSpan).toBeNull();
      expect(togglePreviewRegionDisclosure(detail.previewRegions, group.id)).toBe(true);
      const expanded = layout.render(width).map(stripTerminalSequences).join("\n");
      expect(expanded).toContain("Overall feedback");
      expect(expanded).not.toContain("Passage feedback");
      expect(expanded).not.toContain("Original quote:");
      togglePreviewRegionDisclosure(detail.previewRegions, group.id);
    }
  });

  test("item attachment places the comment at its step without claiming the old quote matches", () => {
    const old = "# Plan\n\n- [ ] Old wording ^task";
    const current = "# Plan\n\n- [x] Entirely new wording ^task\n- [ ] Neighbor";
    const original = {...textTarget(old, old.indexOf("Old wording"), old.indexOf(" ^task")), listItemId: "task"};
    const resolved: AnnotationTarget = {representation: textTarget(current, 0, 1).representation,
      anchor: {kind: "list-item", itemId: "task"}};
    const detail = state(current, current);
    const thread = {...annotationThread("item-comment", resolved, "Keep the original context."), originalTarget: original};
    const exact = {...textTarget(current, current.indexOf("Entirely"), current.indexOf(" ^task")), listItemId: "task"};
    detail.annotationThreads = [thread, annotationThread("current-passage", exact, "Comment on the current words.")];
    const layout = previewLayout(detail);
    for (const width of [36, 72]) {
      const collapsed = layout.render(width).map(stripTerminalSequences).join("\n");
      expect(collapsed).not.toContain("Unpositioned comments");
      const region = detail.previewRegions.regions.find(region => region.kind === "annotation")!;
      const comments=detail.previewRegions.regions.filter(region=>region.kind==='annotation');
      expect(comments).toHaveLength(2);
      expect(region.sourceSpan).toBeNull();
      for(const comment of comments)togglePreviewRegionDisclosure(detail.previewRegions,comment.id);
      const expanded = layout.render(width).map(stripTerminalSequences).join("\n");
      expect(expanded).toContain("Item attachment");
      expect(expanded).toContain("Old wording");
      expect(expanded).toContain("Keep the original context.");
      expect(expanded).toContain("Comment on the current words.");
      expect(annotationScopeLabel(thread, detail)).toContain("original passage changed");
      for(const comment of comments)togglePreviewRegionDisclosure(detail.previewRegions,comment.id);
    }
  });

  test("keeps a stale source representation unpositioned even when its quote still exists", () => {
    const original = "Title\n\nTarget quote\n\nOriginal ending";
    const current = original.replace("Original ending", "Different ending");
    const detail = state(current, current);
    const start = original.indexOf("Target quote");
    detail.annotationThreads = [annotationThread("stale-source", textTarget(original, start, start + 12), "Keep this evidence")];
    const layout = previewLayout(detail);
    const frame = layout.render(50).map(stripTerminalSequences);
    expect(frame.find((line) => line.includes("Target quote"))).not.toStartWith("+ ");
    expect(frame.join("\n")).toContain("Unpositioned comments");
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

  test("places contextual Resource threads only at the matching reference and keeps other or lost contexts reachable", () => {
    const raw = "Reference host\n\nFirst [file::same.md].\nSecond [file::same.md].";
    const host = state(raw, raw);
    const first = createAnnotationReferenceContext({ ...host.context.selected!, updatedAt: "2026-09-19T12:00:00.000Z" }, raw.indexOf("[file::"), raw.indexOf("[file::") + "[file::same.md]".length);
    const second = createAnnotationReferenceContext({ ...host.context.selected!, updatedAt: "2026-09-19T12:00:00.000Z" }, raw.lastIndexOf("[file::"), raw.lastIndexOf("[file::") + "[file::same.md]".length);
    const text = "Resource passage";
    const resource = filesystemState(text);
    if (resource.document.kind !== "ready" || resource.document.document.kind !== "resource") throw new Error("Resource fixture required");
    const document = resource.document.document;
    const file = document.description.filesystem!;
    const target = textTarget(text, 0, text.length, {
      id: `filesystem:${document.description.resource.id}:1:${text.length}:${file.contentHash}`,
      subject: { kind: "resource", resourceId: document.description.resource.id },
      sourceSnapshot: { kind: "resource", resourceId: document.description.resource.id, sourceSnapshotId: null, revision: file.revision },
      adapter: { id: "filesystem.text", version: 1 }, mediaType: "text/plain", contentHash: file.contentHash, capturedAt: file.capturedAt,
    });
    const global = annotationThread("annotation-global", target, "Resource-wide comment");
    const firstThread = annotationThread("annotation-first", { ...target, referenceContext: first }, "First reference comment");
    const secondThread = annotationThread("annotation-second", { ...target, referenceContext: second }, "Second reference comment");
    const missing: AnnotationThread = { ...firstThread, block: block("annotation-missing", ""), resolvedTarget: null,
      currentResolution: { ...firstThread.currentResolution, status: "ambiguous", resolvedTarget: null } };
    resource.document = { kind: "ready", document: { ...document, target: { ...document.target, referenceContext: second } } };
    Object.defineProperty(resource, "target", { get: () => resource.document.kind === "ready" ? resource.document.document.target : null });
    resource.annotationThreads = [firstThread, secondThread, global, missing];
    const groups = detailAnnotationGroups(resource);
    expect(groups.filter(group => group.placement === "inline").flatMap(group => group.threads.map(thread => thread.block.id))).toEqual(["annotation-global", "annotation-second"]);
    expect(groups.find(group => group.placement === "unpositioned")!.threads.map(thread => thread.block.id)).toEqual(["annotation-first", "annotation-missing"]);
    expect(annotationScopeLabel(global, resource)).toBe("Resource-wide");
    expect(annotationScopeLabel(secondThread, resource)).toContain("This reference");
    expect(annotationScopeLabel(firstThread, resource)).toContain("Other reference");
    expect(annotationScopeLabel(missing, resource)).toContain("original");
    const globalView = { ...resource, target: document.target };
    expect(annotationScopeLabel(missing, globalView)).toContain("Other reference");
    // The newer passage representation must retain the same reference scoping.
    const passage=captureAnnotationPassage({text,origins:[{kind:'source',slices:[{
      document:{...observeDocument({kind:'resource',resourceId:document.description.resource.id},text),
        resource:{revision:file.revision,adapter:{id:'filesystem.text',version:1},capturedAt:file.capturedAt}},start:0,end:text.length,
    }]}]});
    resource.annotationThreads=resource.annotationThreads.map(thread=>({...thread,
      originalTarget:{...thread.originalTarget,passage}}));
    const passageGroups=detailAnnotationGroups(resource);
    expect(passageGroups.filter(group=>group.placement==='inline').flatMap(group=>group.threads.map(thread=>thread.block.id)).sort())
      .toEqual(['annotation-global','annotation-second']);
    expect(passageGroups.find(group=>group.placement==='unpositioned')!.threads.map(thread=>thread.block.id))
      .toEqual(['annotation-first','annotation-missing']);
    resource.annotationThreads=[firstThread,secondThread,global,missing];
    host.annotationThreads = [secondThread];
    const hostGroup = detailAnnotationGroups(host)[0]!;
    expect(hostGroup.placement).toBe("inline");
    expect(hostGroup.target?.anchor).toEqual(secondThread.resolvedTarget!.referenceContext!.anchor);
    const capabilities = getCapabilities();
    setCapabilities({ ...capabilities, hyperlinks: true });
    try {
    const layout = previewLayout(resource);
    layout.render(45);
    const unpositioned = resource.previewRegions.regions.find(region => region.id.endsWith(":unpositioned"))!;
    togglePreviewRegionDisclosure(resource.previewRegions, unpositioned.id);
    const rendered = layout.render(45);
    const visible = rendered.map(stripTerminalSequences).join("\n");
    expect(visible).toContain("First reference comment");
    const replyUri = previewRegionActionUri({ type: "annotation.thread.reply", annotationId: "annotation-first" });
    expect(rendered.join("\n")).toContain(replyUri);
    expect(resolvePreviewPointerAction(parseDetailPreviewActionUri(replyUri)!, true)).toEqual({
      type: "activate", action: { type: "annotation.thread.reply", annotationId: "annotation-first" },
    });
    } finally { setCapabilities(capabilities); }
  });

  test("keeps available Resource text unpositioned when metadata is the selected presentation", () => {
    const text = "Actual source\n\nStable quote";
    const detail = filesystemState(text);
    if (detail.document.kind !== "ready" || detail.document.document.kind !== "resource") throw new Error("Resource fixture required");
    const resourceDocument = detail.document.document;
    const originalDescription = resourceDocument.description;
    const binaryDescription = { ...originalDescription, resource: { ...originalDescription.resource, mediaType: "application/octet-stream" } };
    const description = { ...binaryDescription, presentation: negotiateResourcePresentation(binaryDescription, TUI_RESOURCE_PRESENTATION_CONTEXT) };
    detail.document = { kind: "ready", document: { ...resourceDocument, description } };
    if (!description.filesystem) throw new Error("Filesystem fixture required");
    expect(description.presentation.selected?.representation).toBe("metadata");
    const representation: AnnotationRepresentation = {
      id: `filesystem:${description.resource.id}:1:${text.length}:${description.filesystem.contentHash}`,
      subject: { kind: "resource", resourceId: description.resource.id },
      sourceSnapshot: { kind: "resource", resourceId: description.resource.id, sourceSnapshotId: null, revision: description.filesystem.revision },
      adapter: { id: "filesystem.text", version: 1 }, mediaType: "application/octet-stream",
      contentHash: description.filesystem.contentHash, capturedAt: description.filesystem.capturedAt,
    };
    detail.annotationThreads = [annotationThread("metadata-source-annotation", textTarget(text, text.indexOf("Stable quote"), text.length, representation), "Retain hidden source comment")];
    detail.resolvedSelectedText = "# notes/fixture.md\n\nStable Resource link\n\n## Negotiated presentation\n\n- Representation: metadata";
    detail.projectedSelectedText = detail.resolvedSelectedText;
    const layout = previewLayout(detail);
    const frame = layout.render(72).map(stripTerminalSequences);
    expect(frame.some((line) => line.startsWith("+ ") && line.includes("notes/fixture.md"))).toBe(false);
    expect(frame.join("\n")).toContain("Unpositioned comments");
    expect(layout.sourcePointAtViewport(3, 5, 72)).toBeNull();
    expect(layout.sourceLineAtScroll(72)).toBeNull();
    const region = detail.previewRegions.regions.find((candidate) => candidate.kind === "annotation")!;
    expect(togglePreviewRegionDisclosure(detail.previewRegions, region.id)).toBe(true);
    const expanded = layout.render(72).map(stripTerminalSequences).join("\n");
    expect(expanded).toContain("Retain hidden source comment");
    expect(expanded).toContain("Stable quote");
    const textualDescription = { ...originalDescription, presentation: negotiateResourcePresentation(originalDescription, TUI_RESOURCE_PRESENTATION_CONTEXT) };
    expect(textualDescription.presentation.selected?.representation).toBe("cached-markdown");
    detail.document = { kind: "ready", document: { ...resourceDocument, description: textualDescription } };
    expect(layout.render(72).map(stripTerminalSequences).join("\n")).toContain("Unpositioned comments");
    expect(layout.sourcePointAtViewport(3, 5, 72)).toBeNull();
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
      const lines = expandedPreview(
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

  test("renders external ticket keys alongside the configured Work-ID prefix", () => {
    const capabilities = getCapabilities();
    setCapabilities({ ...capabilities, hyperlinks: true });
    try {
      const detail = state("ABC-001 and PIE-001", "ABC-001 and PIE-001");
      detail.workIdPrefix = "ABC";
      const layout = expandedPreview(detail, plainMarkdownTheme, true);
      layout.syncState();
      const line = layout.markdown.render(80).find((candidate) =>
        stripTerminalSequences(candidate).includes("ABC-001 and")
      )!;
      const visible = stripTerminalSequences(line);
      expect(getOsc8LinkAtColumn(line, visible.indexOf("ABC-001") + 2)).toBe(
        "pi-outliner://work/ABC-001",
      );
      expect(getOsc8LinkAtColumn(line, visible.indexOf("PIE-001") + 2)).toBe("pi-outliner://work/PIE-001");
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
    const layout = expandedPreview(
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
      const layout = expandedPreview(
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
      const draftFrame=layout.markdown.renderedFrame!;
      const firstSource=draftFrame.cells.find(cell=>cell.text==='U')!.origins.find(origin=>origin.kind==='source')!;
      expect(firstSource.kind==='source'&&firstSource.slices[0]!.document).toMatchObject({
        subject:{kind:'block',blockId:'block-1'},text:`Unsaved ((${targetId})) draft`,draft:true,
      });
      expect(firstSource.kind==='source'&&firstSource.slices[0]!.document.revision).toBeUndefined();
      expect(getOsc8LinkAtColumn(draftLine!, draftText.indexOf(targetId) + 2)).toBe(
        `pi-outliner://block/${targetId}`,
      );

      editing = false;
      detail.mode = "preview";
      layout.syncState();
      const canonical = layout.markdown.render(80).map(stripTerminalSequences).join(" ");
      expect(canonical).toContain("Canonical preview");
      expect(canonical).not.toContain("Unsaved");
      expect(draftFrame.cells.find(cell=>cell.text==='U')?.origins).toEqual([firstSource]);
    } finally {
      setCapabilities(capabilities);
    }
  });

  test("replaces the immediate draft with its generated read projection", async () => {
    const detail = state("Canonical preview", "Canonical source");
    detail.mode = "edit";
    detail.buffer = new TextBuffer("!((view-next))");
    const projected = Promise.withResolvers<void>();
    const layout = expandedPreview(
      detail,
      plainMarkdownTheme,
      false,
      projected.resolve,
      {
        draftText: () => detail.buffer.text,
        projectionDelayMs: 0,
        async projectDraft(source) {
          const text=source.text;
          expect(text).toBe("!((view-next))");
          return {
            provenance: generatedDocument("Embedded draft result", "fixture projection"),
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
    const layout = expandedPreview(
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
        async projectDraft(source) {
          const text=source.text;
          attempts += 1;
          if (attempts === 1) throw new Error("temporary projection failure");
          return {
            provenance: generatedDocument("Recovered draft projection", "fixture projection"),
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
    const layout = expandedPreview(
      detail,
      plainMarkdownTheme,
      false,
      () => {
        if (attempts === 2) retryFinished.resolve();
      },
      {
        draftText: () => detail.buffer.text,
        projectionDelayMs: 0,
        async projectDraft(source) {
          const text=source.text;
          attempts += 1;
          if (attempts === 1) {
            firstStarted.resolve();
            await firstResponse.promise;
            return {
              provenance: generatedDocument("Stale projection", "fixture projection"),
              rawText: text,
              embedRanges: [],
              workIdPrefix: null,
            };
          }
          return {
            provenance: generatedDocument("Restarted projection", "fixture projection"),
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
    const layout = expandedPreview(
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
        async projectDraft(source) {
          const text=source.text;
          attempts += 1;
          return {
            provenance: generatedDocument(`Projection for ${detail.context.selected?.id}`, "fixture projection"),
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
      showRelated: false,
      showResolved: false,
      kindFilter: null,
      stageFilter: "all",
      expandedKinds: new Set(),
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
    const generated = renderBacklinksDocument(detail, 160);
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
    expect(generated).toContain("1 of 1 match");
    expect(generated).toContain("Sort: Updated ↓");
    expect(generated).toContain("▶ ACTIVE");
    const highlighted = layout.backlinkMarkdown.render(80).find((line) =>
      stripTerminalSequences(line).includes("▶ ACTIVE")
    );
    expect(highlighted).toContain("\x1b[1;97;48;5;24m");
    // Generated snippets escape without pi-tui reading `\\[…\\]` as LaTeX.
    const backlinkText = layout.backlinkMarkdown.render(80).map(stripTerminalSequences).join("\n");
    expect(backlinkText).toContain("[source-block::Canonical target]");
    expect(backlinkText).not.toContain("\\[");
    expect(generated).toContain(detailBacklinkToggleUri("source-target"));
    expect(parseDetailPreviewActionUri(detailBacklinkToggleUri("source-target"))).toEqual({
      type: "backlink.source.disclosure.toggle",
      blockId: "source-target",
    });
    // A `[` inside a generated link label cannot restart the label.
    const source = detail.backlinks.collection!.sources[0]!;
    detail.backlinks.collection!.sources[0] = {...source, title: "Meeting [draft] notes", parentContext: "Project [2026] › Notes"};
    const labels = measureRenderedLinks(withInternalLinks(() =>
      new Markdown(renderBacklinksDocument(detail, 160), 0, 0, plainMarkdownTheme).render(160)))
      .filter(link => link.uri === backlinkUri).map(link => link.label);
    expect(labels[0]).toBe("Meeting [draft] notes");
    expect(labels[1]).toStartWith("— Project [2026] › Notes · block reference ×1");
    detail.backlinks.collection!.sources[0] = source;
    detail.backlinks.expandedSourceIds.clear();
    expect(renderBacklinksDocument(detail)).not.toContain("See ((block-1)) from here");
    detail.backlinks.filter = "missing";
    expect(renderBacklinksDocument(detail)).toContain("No backlinks match the current filter.");
    // Generated rows follow the current state at render time.
    detail.backlinks.filter = "";
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

  test("groups faceted sources by kind, one line per row, with counts that add up", () => {
    // Fictional garden-club ticket: long titles and breadcrumbs that would wrap.
    const detail = state("Ticket");
    const long = "A deliberately long letter title about seed trays and the spring table rota";
    const source = (blockId: string, title: string, facets: NonNullable<BacklinkCollection["sources"][number]["facets"]>) => ({
      blockId, title, parentContext: "Garden club › Correspondence › Outgoing letters archive",
      createdAt: "2031-02-01T00:00:00.000Z", updatedAt: `2031-02-0${blockId.length % 9 + 1}T00:00:00.000Z`,
      occurrenceCount: 2, referenceGroups: [{ kind: "work-id" as const, count: 2 }],
      occurrences: [], occurrencesTruncated: false, facets,
    });
    const letter = (stage: "waiting" | "draft" | "done") => ({
      kind: "letter", kindLabel: "Letter", placement: "other" as const,
      stage: { property: "outbox", value: stage, bucket: stage },
    });
    detail.backlinks.expanded = true;
    detail.backlinks.collection = {
      targetBlockId: "block-1",
      completeness: { kind: "complete" },
      sources: [
        source("w", long, letter("waiting")),
        source("dr", `${long} (draft)`, letter("draft")),
        source("d1", "Thanks", letter("done")),
        source("d22", "Receipt", letter("done")),
        source("day", "Monday", { kind: "day-page", kindLabel: "Day page", placement: "other" }),
        source("self", "Ticket", { kind: "note", kindLabel: "Note", placement: "self" }),
        source("old", "Old question", { kind: "comment", kindLabel: "Comment", placement: "other", comment: { resolved: true } }),
      ],
    };
    const layout = previewLayout(detail);
    layout.syncState();
    for (const width of [48, 72, 120]) {
      const lines = layout.backlinkMarkdown.render(width).map(stripTerminalSequences);
      const text = lines.join("\n");
      // The status line may wrap; rows may not.
      expect(text.replace(/\s+/g, " ")).toContain("5 of 7 match · 1 this note hidden · 1 resolved hidden");
      expect(text).toContain("Letter 4 (1 waiting · 1 draft · 2 done)");
      expect(text).toContain("Day page 1");
      // Collapsed groups show their open items only; each on one line.
      const rows = lines.filter((line) => line.includes("A deliberately"));
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(visibleWidth(row.trimEnd())).toBeLessThan(width);
        expect(row).toContain("—");
      }
      expect(text).not.toContain("Thanks");
      expect(text).not.toContain("Monday");
    }
    const wide = layout.backlinkMarkdown.render(160).map(stripTerminalSequences).join("\n");
    expect(wide).toContain("waiting · Garden club › Correspondence › Outgoing letters archive · Work ID ×2");
    const generated = renderBacklinksDocument(detail, 120);
    for (const control of ["kind", "stage", "resolved", "related", "sort"] as const) {
      const uri = previewRegionActionUri({ type: "backlinks.control", control });
      expect(generated).toContain(uri);
      expect(parseDetailPreviewActionUri(uri)).toEqual({ type: "backlinks.control", control });
    }
    // Keyboard focus on a header moves the single selection marker to it.
    detail.previewRegions.focusedRegionId = "backlink-group:day-page";
    const focusedLines = renderBacklinksDocument(detail, 120).split("\n");
    expect(focusedLines.filter((line) => line.includes("▶ ACTIVE"))).toHaveLength(1);
    expect(focusedLines.find((line) => line.includes("▶ ACTIVE"))).toContain("Day page 1");
    detail.previewRegions.focusedRegionId = null;
    const group = previewRegionActionUri({ type: "backlink.group.disclosure.toggle", kind: "day-page" });
    expect(generated).toContain(group);
    expect(parseDetailPreviewActionUri(group)).toEqual({ type: "backlink.group.disclosure.toggle", kind: "day-page" });
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
      showRelated: false,
      showResolved: false,
      kindFilter: null,
      stageFilter: "all",
      expandedKinds: new Set(),
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

    detail.previewRegions.focusedRegionId = "backlink:source-0";
    layout.syncState(60);
    layout.ensureFocusVisible(60, 40);
    renderLayoutFrame(layout, 60, 40, () => {});
    layout.ensureFocusVisible(60, 12);
    const resized = renderLayoutFrame(layout, 60, 12, () => {}).lines
      .map(stripTerminalSequences).join("\n");
    expect(resized).toContain("ACTIVE Backlink source 0");
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
      showRelated: false,
      showResolved: false,
      kindFilter: null,
      stageFilter: "all",
      expandedKinds: new Set(),
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
      } else expect(region.activation).toEqual({type: "property-inspector.value.copy", occurrenceId: entry.occurrenceId});
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
      routing: "linked",
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
    const layout = expandedPreview(detail, plainMarkdownTheme, false);

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
    const layout = expandedPreview(detail, plainMarkdownTheme, false);
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
    const layout = expandedPreview(
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
  test("keeps themed inline property focus visible during keyboard traversal", () => {
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
    initTheme("dark");
    const layout = expandedPreview(detail, getMarkdownTheme(), false);
    const width = 40;
    layout.syncState(width);
    renderLayoutFrame(layout,width,11,()=>{});
    const contentWidth=layout.scrollView.getContentWidth(width);
    const authored=layout.markdown.render(contentWidth);
    const lastEntry=detail.propertyInspector.model!.entries.at(-1)!;
    detail.previewRegions.focusedRegionId=lastEntry.occurrenceId;
    layout.syncState(width);
    layout.ensureFocusVisible(width);
    const frame=renderLayoutFrame(layout,width,11,()=>{});
    expect(frame.lines.map(stripTerminalSequences).join("\n")).toContain("value-19");

    const titleEnd = authored.findIndex((line) => stripTerminalSequences(line).trim() === "");
    const selectedLine = layout.inspectorMarkdown.render(contentWidth)
      .findIndex((line) => stripTerminalSequences(line).includes("▶ "));
    const selectedRow = titleEnd + 1 + selectedLine;
    expect(selectedRow).toBeGreaterThanOrEqual(layout.scrollView.scrollTop);
    expect(selectedRow).toBeLessThan(
      layout.scrollView.scrollTop + layout.scrollView.viewportHeight,
    );
  });

  test("reflows the whole focused property entry into the live viewport after resize", () => {
    const canonical = ["Properties", ...Array.from({ length: 24 }, (_, i) =>
      `[field-${i}::value-${i}]`), "", "Body"].join("\n");
    const detail = state(canonical, canonical);
    detail.propertyInspector = {
      ...detail.propertyInspector,
      presentation: "inline",
      expanded: true,
      model: createPropertyInspectorModel(detail.context.selected!.id, canonical),
    };
    const layout = expandedPreview(detail, plainMarkdownTheme, false);
    layout.syncState(60);
    layout.ensureFocusVisible(60, 40);
    renderLayoutFrame(layout, 60, 40, () => {});
    const entry = detail.propertyInspector.model!.entries.at(-1)!;
    detail.previewRegions.focusedRegionId = entry.occurrenceId;
    layout.syncState(60);
    layout.ensureFocusVisible(60, 40);
    renderLayoutFrame(layout, 60, 40, () => {});

    layout.syncState(30);
    layout.ensureFocusVisible(30, 22);
    const frame = renderLayoutFrame(layout, 30, 22, () => {}).lines
      .map(stripTerminalSequences).join("\n");
    expect(detail.previewRegions.focusedRegionId).toBe(entry.occurrenceId);
    expect(frame).toContain("▶");
    expect(frame).toContain("#23");
    expect(frame).toContain("L25:C");
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

  const highlightedRow=selecting.findIndex(line=>stripTerminalSequences(line).includes("selected phrase"));
  const highlighted=stripTerminalSequences(selecting[highlightedRow]!);
  const column=visibleWidth(highlighted.slice(0,highlighted.indexOf("selected phrase")));
  // ScrollView.render returns its whole content; pointer coordinates are viewport-relative.
  expect(layout.sourcePointAtViewport(highlightedRow-initialScroll+layout.headerHeight(48),column+3,48))
    .toEqual({row:8,column:11});

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

test("selection highlights transformed source cells and rejects stale draft coordinates", () => {
  const raw = "# Selection\n\nFirst &amp; echo. Second &amp; **echo**. [label](https://example.test/hidden)";
  const start = raw.lastIndexOf("&amp;");
  for (const width of [28, 60]) {
    const detail = state(raw, raw);
    const layout = previewLayout(detail);
    layout.scrollView.setScrollbar("hidden");
    detail.mode = "select";
    detail.buffer = new TextBuffer(raw);
    const line = raw.split("\n")[2]!;
    const column = line.lastIndexOf("&amp;");
    detail.buffer.placeCursor(2, column);
    detail.buffer.placeCursor(2, column + 5, true);
    layout.syncState(width);
    const selecting = layout.scrollView.render(width);
    expect(selecting.join("\n")).toContain("\x1b[1;4;97;48;5;24m&");
    expect(selecting.join("\n").match(/\x1b\[1;4;97;48;5;24m&/g)?.length).toBe(1);

    detail.mode = "comment";
    detail.annotationDraft = {requestId: "transformed", returnMode: "preview", target: textTarget(raw, start, start + 5)};
    detail.buffer = new TextBuffer("Comment draft");
    layout.syncState(width);
    expect(layout.scrollView.render(width).join("\n")).toContain("\x1b[1;4;97;48;5;24m&");

    detail.annotationDraft.target = textTarget(raw + " stale", start, start + 5);
    layout.syncState(width);
    expect(layout.scrollView.render(width).join("\n")).not.toContain("\x1b[1;4;97;48;5;24m");

    const hidden = raw.indexOf("https://");
    detail.annotationDraft.target = textTarget(raw, hidden, hidden + 5);
    layout.syncState(width);
    expect(layout.scrollView.render(width).join("\n")).not.toContain("\x1b[1;4;97;48;5;24m");
  }
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

test("pointer coordinates follow graphemes, decoded entities and generated reader rows", () => {
  for(const raw of [
    "# Title\n[tag::fixture]\n\né 👩‍💻 **needleword** after",
    "# Title\n[tag::fixture]\n\n&gt; &amp; **needleword** after",
    "# Title\n[tag::fixture]\n\n> [!note] Read\n> **needleword** after",
    "# Title\n[tag::fixture]\n\n| Name | Value |\n| --- | --- |\n| first | **needleword** |",
  ]) for(const width of [28,60]) {
    const detail=state(raw,raw);
    detail.propertyInspector={...detail.propertyInspector,expanded:true,
      model:createPropertyInspectorModel("block-1",raw)};
    detail.annotationThreads=[annotationThread("title-comment",textTarget(raw,2,7),"Panel content")];
    const layout=previewLayout(detail);
    layout.scrollView.setScrollbar("hidden");
    layout.syncState(width);
    const comment=detail.previewRegions.regions.find(region=>region.kind==="annotation")!;
    togglePreviewRegionDisclosure(detail.previewRegions,comment.id);
    layout.syncState(width);
    const lines=layout.scrollView.render(width).map(stripTerminalSequences);
    expect(lines.join("\n")).toContain("Panel content");
    const row=lines.findIndex(line=>line.includes("needleword"));
    expect(row).toBeGreaterThanOrEqual(0);
    const line=lines[row]!;
    const column=visibleWidth(line.slice(0,line.indexOf("needleword")));
    const offset=raw.indexOf("needleword");
    const prefix=raw.slice(0,offset).split("\n");
    expect(layout.sourcePointAtViewport(row+layout.headerHeight(width),column+2,width)).toEqual({
      row:prefix.length-1,column:prefix.at(-1)!.length+2,
    });
    const propertyRow=lines.findIndex(line=>line.includes("fixture"));
    if(propertyRow>=0)expect(layout.sourcePointAtViewport(propertyRow+layout.headerHeight(width),0,width)).toBeNull();
  }
});

test.each([
  {label:"formatted phrase",raw:"# Capture\n\nA界 **needle** after",needle:"needle",wholeRow:false,expected:"needle",ranges:[[16,22]]},
  {label:"table row",raw:"# Capture\n\n| Name | State |\n| --- | --- |\n| item | **ready** |",needle:"item",wholeRow:true,expected:"item ready",ranges:[[44,48],[53,58]]},
])("terminal mouse copy captures $label and rejects a later same-text render",({raw,needle,wholeRow,expected,ranges})=>{
  const detail=state(raw,raw);
  const layout=new DetailPiPreviewLayout(detail,plainMarkdownTheme,true,undefined,{density:()=>"compact"});
  const {terminal,input}=terminalFixture();
  layout.scrollView.setScrollbar('hidden');
  layout.syncState(terminal.columns);
  const screen=renderLayoutFrame(layout,terminal.columns,terminal.rows,()=>{}).lines.map(stripTerminalSequences);
  const row=screen.findIndex(line=>line.includes(needle));
  const column=wholeRow?0:visibleWidth(screen[row]!.slice(0,screen[row]!.indexOf(needle)));
  const end=wholeRow?visibleWidth(screen[row]!.trimEnd()):column+needle.length;
  let captured:DocumentSelection|null=null,selection:TuiCopySelection|undefined;
  const tui=new TuiAltScreen(terminal,false,undefined,{mouse:true,async copySelection(_text,_lines,event){
    selection=event;captured=layout.captureSelection(event);return true;
  }});
  tui.setLayoutRoot(layout);
  try {
    tui.start();tui.renderNow();
    input(`\x1b[<0;${column+1};${row+1}M`);
    input(`\x1b[<32;${end};${row+1}M`);
    input(`\x1b[<0;${end};${row+1}m`);
    expect(captured).not.toBeNull();
    const snapshot=captured! as DocumentSelection;
    expect(snapshot.text).toBe(expected);
    expect(snapshot.origins.filter(origin=>origin.kind==='source').flatMap(origin=>origin.slices.map(slice=>[slice.document.subject,slice.start,slice.end])))
      .toEqual(ranges.map(([start,end])=>[{kind:'block',blockId:'block-1'},start,end]));
    // Same visible bytes do not prove the same render generation.
    tui.renderNow();
    expect(layout.captureSelection(selection!)).toBeNull();
    expect(snapshot.text).toBe(expected);
    expect(Object.isFrozen(snapshot.origins)).toBe(true);
  } finally {tui.stop();}
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
  if (detail.document.document.kind !== "resource") throw new Error("Expected PDF Resource");
  detail.resolvedProvenance = concatDocuments([
    resourceContentDocument(detail.document.document.description)!,
    generatedDocument(detail.resolvedSelectedText.slice(markdown.length), "resource metadata"),
  ]);
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

test("deleted contextual occurrence stays unpositioned in Resource view", async () => {
  const { createAnnotationReferenceContext } = await import("../src/annotations");
  const { OutlinerStore } = await import("../src/store");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const root = mkdtempSync("/tmp/pie282-spec-record-");
  const rendered = "Shared file passage\nSecond file line";
  writeFileSync(join(root, "same.md"), rendered);
  const store = new OutlinerStore(join(root, "outline.sqlite"));
  try {
    const host = store.create("First [file::same.md].\nSecond [file::same.md].");
    const resource = store.resources.internFilesystem({ path: join(root, "same.md") }).resource;
    const description = store.resources.describe(resource.id, true);
    const file = description.filesystem!;
    const rev = file.revision.revision;
    if (rev.kind !== "filesystem") throw new Error("File fixture required");
    const representation: AnnotationRepresentation = {
      id: `filesystem:${resource.id}:${rev.mtimeNs}:${rev.size}:${file.contentHash}`,
      subject: { kind: "resource", resourceId: resource.id },
      sourceSnapshot: { kind: "resource", resourceId: resource.id, sourceSnapshotId: null, revision: file.revision },
      adapter: { id: "filesystem.text", version: 1 }, mediaType: "text/plain",
      contentHash: file.contentHash, capturedAt: file.capturedAt,
    };
    const referenceContext = createAnnotationReferenceContext(host, host.text.indexOf("[file::"), host.text.indexOf("[file::") + 15);
    const target = { ...textTarget(rendered, 0, 19, representation), referenceContext };
    store.createAnnotation("capture", { target, body: "FIRST USE ONLY", source: "user" });
    const changed = store.update(host.id, "Second [file::same.md].", host.revision, { author: "user", actorId: "spec-review" });
    const hash = annotationSourceHash(changed.text);
    store.reconcileAnnotationThreads({ subject: { kind: "block", blockId: host.id }, newRepresentation: {
      ...referenceContext.representation, id: `block:${host.id}:${hash}`, contentHash: hash,
      sourceSnapshot: { kind: "block", blockId: host.id, updatedAt: changed.updatedAt, contentHash: hash },
    }});
    const threads = store.listAnnotationThreads({ subject: { kind: "resource", resourceId: resource.id } });
    expect(threads[0]!.currentResolution.status).toBe("orphaned");
    expect(threads[0]!.resolvedTarget).toBeNull();
    const detail = filesystemState(rendered);
    const navigationTarget = { kind: "resource" as const, resourceId: resource.id };
    detail.document = { kind: "ready", document: { kind: "resource", target: navigationTarget, description } };
    Object.assign(detail, { target: navigationTarget, resource });
    detail.annotationThreads = threads;
    const layout = previewLayout(detail);
    const frame = layout.render(72).map(stripTerminalSequences).join("\n");
    expect(frame).toContain("Unpositioned comments");
    expect(frame.split("\n").find(line => line.includes("Shared file passage"))).not.toStartWith("+ ");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("historical Resource thread navigation follows the displayed anchors within one line", () => {
  const displayed = "Alpha quote then Beta quote";
  const latest = "Beta quote then Alpha quote";
  const detail = webState(displayed);
  if (detail.document.kind !== "ready" || detail.document.document.kind !== "resource" || !detail.document.document.description.web) throw new Error("Missing fixture");
  const web = detail.document.document.description.web;
  const representation: AnnotationRepresentation = {
    id: web.representation.id,
    subject: { kind: "resource", resourceId: detail.document.document.description.resource.id },
    sourceSnapshot: { kind: "resource", resourceId: detail.document.document.description.resource.id, sourceSnapshotId: web.sourceSnapshot.id, revision: web.sourceSnapshot.revision },
    adapter: web.representation.adapter, mediaType: web.representation.mediaType,
    contentHash: annotationSourceHash(displayed), capturedAt: web.representation.derivedAt!,
  };
  detail.annotationThreads = ["Alpha quote", "Beta quote"].map((quote, index) => {
    const original = textTarget(displayed, displayed.indexOf(quote), displayed.indexOf(quote) + quote.length, representation);
    const historical = annotationThread(`thread-${index}`, original, quote);
    const current = annotationThread(`thread-${index}`, textTarget(latest, latest.indexOf(quote), latest.indexOf(quote) + quote.length, { ...representation, id: "newer-representation", contentHash: annotationSourceHash(latest) }), quote);
    return { ...current, originalTarget: original, resolutionHistory: [...historical.resolutionHistory, ...current.resolutionHistory] };
  });
  const groups = detailAnnotationGroups(detail);
  expect(groups.flatMap(group => group.threads.map(thread => thread.block.id))).toEqual(["thread-0", "thread-1"]);
});

test("body links scroll and highlight in Pi layout without terminal hyperlink support",()=>{
 const caps=getCapabilities();setCapabilities({...caps,hyperlinks:false});
 try{
  const raw=["Document",...Array.from({length:30},(_,i)=>`Paragraph ${i}\n`),"[Late body target](https://example.com/late)"].join("\n");
  const detail=state(raw,raw);const layout=expandedPreview(detail,plainMarkdownTheme,false);
  layout.syncState(40);renderLayoutFrame(layout,40,12,()=>{});
  const region=detail.previewRegions.regions.find(r=>r.kind==='body-link')!;
  expect(region).toBeDefined();detail.previewRegions.focusedRegionId=region.id;
  layout.syncState(40);layout.ensureFocusVisible(40);
  const lines=renderLayoutFrame(layout,40,12,()=>{}).lines;
  expect(lines.map(stripTerminalSequences).join('\n')).toContain('Late body target');
  expect(lines.some(line=>stripTerminalSequences(line).includes('Late body target')&&line.includes('48;5;24m'))).toBe(true);
  expect(lines.join('')).not.toContain('https://example.com/late');
  layout.syncState(24);layout.ensureFocusVisible(24);renderLayoutFrame(layout,24,12,()=>{});
  expect(detail.previewRegions.focusedRegionId).toBe(region.id);
 }finally{setCapabilities(caps);}
});

test("folded callout links are omitted and document focus order includes inline properties",()=>{
 const raw="Document\n[type::note]\n\n[Before](https://example.com/before)\n\n> [!note]- Folded\n> [Hidden](https://example.com/hidden)\n\n[After](https://example.com/after)";
 const detail=state(raw,raw);detail.propertyInspector.model=createPropertyInspectorModel(detail.context.selected!.id,raw);
 const layout=expandedPreview(detail,plainMarkdownTheme,false);layout.syncState(50);
 const regions=detail.previewRegions.regions.filter(r=>r.focusable);
 expect(regions.map(r=>r.activation)).not.toContainEqual({type:'link.open',uri:'https://example.com/hidden'});
 expect(regions.findIndex(r=>r.id==='property-inspector')).toBeLessThan(regions.findIndex(r=>r.kind==='body-link'));
 const callout=regions.find(r=>r.kind==='callout')!;
 detail.previewRegions.disclosureOverrides.set(callout.id,true);layout.syncState(50);
 expect(detail.previewRegions.regions.map(r=>r.activation)).toContainEqual({type:'link.open',uri:'https://example.com/hidden'});
});

test("duplicate body links retain occurrence focus through wrap, resize and folding",()=>{
 const raw="Document\n\n> [!note]+ Earlier\n> [Earlier link](https://example.com)\n\n- [First occurrence](https://example.com)\n- [Second occurrence](https://example.com)";
 const detail=state(raw,raw);const layout=expandedPreview(detail,plainMarkdownTheme,false);layout.syncState(60);
 const links=()=>detail.previewRegions.regions.filter(r=>r.kind==='body-link');
 expect(links()).toHaveLength(3);
 const second=links()[2]!.id;detail.previewRegions.focusedRegionId=second;
 layout.syncState(18);expect(links()).toHaveLength(3);expect(detail.previewRegions.focusedRegionId).toBe(second);
 const callout=detail.previewRegions.regions.find(r=>r.kind==='callout')!;
 detail.previewRegions.disclosureOverrides.set(callout.id,false);layout.syncState(18);
 expect(links()).toHaveLength(2);expect(detail.previewRegions.focusedRegionId).toBe(second);
 const output=layout.render(18).join('');expect(output).not.toContain('outliner-link=');
});


test("compact Detail keeps authored content and source selection aligned when density changes", () => {
  const detail = state("# Sample note\n\n## Heading\nA selectable paragraph.\n\nTail", "# Sample note\n\n## Heading\nA selectable paragraph.\n\nTail");
  let density: "compact" | "expanded" = "compact";
  const layout = new DetailPiPreviewLayout(detail, plainMarkdownTheme, false, undefined, {density: () => density});
  const first = layout.render(40).map(stripTerminalSequences);
  expect(first[0]).toContain("[⋯]");
  expect(first.findIndex(line => line.includes("Sample note"))).toBeLessThan(3);
  expect(first.join("\n")).not.toContain("Collapsed · press b");
  expect(layout.headerHeight(40)).toBe(1);
  const row = first.findIndex(line => line.includes("A selectable paragraph."));
  expect(row).toBeGreaterThan(0);
  expect(layout.sourcePointAtViewport(row, 4, 40)?.row).toBe(3);
  // A blank separator at the viewport top should anchor to the next authored line.
  const body=layout.scrollView.render(40).map(stripTerminalSequences);
  const paragraph=body.findIndex(line=>line.includes("A selectable paragraph."));
  const separator=body.findIndex((line,index)=>index>paragraph&&!line.trim());
  expect(separator).toBeGreaterThan(paragraph);
  layout.scrollView.updateLayout(body.length,1,()=>{});
  layout.scrollView.scrollTo(separator);
  expect(layout.sourceLineAtScroll(40)).toBe(5);
  layout.scrollView.scrollTo(0);
  density = "expanded";
  const expanded = layout.render(40).map(stripTerminalSequences);
  expect(layout.headerHeight(40)).toBe(3);
  expect(expanded.join("\n")).toContain("Collapsed · press b");
  density = "compact";
  detail.status = "Workspace service disconnected; reconnecting…";
  expect(layout.render(40).map(stripTerminalSequences).join("\n")).toContain("Workspace service disconnected");
});


test("focused checklist remains visible when narrower geometry reflows preceding prose", () => {
  const raw=['# Plan','',...Array.from({length:20},(_,i)=>`Paragraph ${i}. ${'Context prose '.repeat(10)}\n`),'- [ ] Last destination ^last'].join('\n');
  const detail=state(raw,raw);
  const layout=new DetailPiPreviewLayout(detail,plainMarkdownTheme,false);
  layout.syncState(80);renderLayoutFrame(layout,80,20,()=>{});
  const region=detail.previewRegions.regions.find(r=>r.kind==='checklist')!;
  detail.previewRegions.focusedRegionId=region.id;
  layout.syncState(80);layout.ensureFocusVisible(80,20);
  expect(renderLayoutFrame(layout,80,20,()=>{}).lines.map(stripTerminalSequences).join('\n')).toContain('Last destination');
  layout.syncState(24);layout.ensureFocusVisible(24,10);
  expect(renderLayoutFrame(layout,24,10,()=>{}).lines.map(stripTerminalSequences).join('\n')).toContain('Last destination');
  expect(detail.previewRegions.focusedRegionId).toBe(region.id);
});

test('legacy exact comments follow the visible quote through wrapping and leave hidden URL syntax unpositioned',()=>{
  const raw='Title\n\nSeveral ordinary words precede the TARGET phrase at the end of this paragraph.\n\n[Label](https://example.test/hidden)';
  const detail=state(raw,raw);
  const start=raw.indexOf('TARGET');
  detail.annotationThreads=[annotationThread('legacy-visible',textTarget(raw,start,start+6),'Visible passage')];
  const layout=previewLayout(detail);
  for(const width of [30,45]){
    const lines=layout.render(width).map(stripTerminalSequences);
    expect(lines.find(line=>line.includes('TARGET'))).toStartWith('+ ');
    const opening=lines.find(line=>line.includes('Several'))!;
    if(!opening.includes('TARGET'))expect(opening).not.toStartWith('+ ');
  }
  const hidden=raw.indexOf('https://');
  detail.annotationThreads=[annotationThread('legacy-hidden',textTarget(raw,hidden,hidden+'https://example.test/hidden'.length),'Hidden URL')];
  const hiddenLines=layout.render(45).map(stripTerminalSequences);
  expect(hiddenLines.join('\n')).toContain('Unpositioned comments (1)');
  expect(hiddenLines.find(line=>line.trim()==='Label')).not.toStartWith('+ ');
});

test("a resource projection's link is a focusable resource region, and its age is painted, not projected", () => {
 const caps=getCapabilities();setCapabilities({...caps,hyperlinks:false});
 try{
  const resourceId="11111111-1111-4111-8111-111111111111";
  const fetchedAt=new Date(Date.now()-3*60*60_000).toISOString();
  const raw=["Vendor call ACME-1","jira::",`- Jira [ACME-1](pi-outliner://resource/${resourceId}) · Rollout checklist`,"  Status: In progress","  fetched 2026-09-20 10:00","","After"].join("\n");
  const detail=state(raw,raw);
  detail.embedRanges=[{startLine:2,endLine:4,inserted:{afterSourceLine:1,lineCount:4},resource:{resourceId,fetchedAt,fetchedLine:2}}];
  const layout=expandedPreview(detail,plainMarkdownTheme,false);
  layout.syncState(80);renderLayoutFrame(layout,80,20,()=>{});
  const region=detail.previewRegions.regions.find(r=>r.kind==='resource')!;
  expect(region).toBeDefined();
  expect(region.focusable).toBe(true);
  expect(region.activation).toEqual({type:'link.open',uri:`pi-outliner://resource/${resourceId}`});
  expect(detail.previewRegions.regions.some(r=>r.kind==='body-link'&&r.activation?.type==='link.open'&&r.activation.uri.includes(resourceId))).toBe(false);
  const lines=renderLayoutFrame(layout,80,20,()=>{}).lines.map(stripTerminalSequences);
  expect(lines.some(line=>line.includes("fetched 2026-09-20 10:00 (3 h ago)"))).toBe(true);
  expect(detail.projectedSelectedText).not.toContain("ago");
 }finally{setCapabilities(caps);}
});
