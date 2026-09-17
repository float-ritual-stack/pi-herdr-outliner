import { describe, expect, test } from "bun:test";
import {
  attentionClientState,
  normalizeAttentionMark,
} from "../src/attention";
import { createAnnotationAnchor } from "../src/annotations";
import { emptyAttentionState } from "../src/attention";
import {
  createDetailController,
  renderedSelectionAnnotationTarget,
  visibleBacklinkSources,
  type DetailControllerOptions,
  type DetailEffects,
  type DetailReadyDocument,
  type DetailViewport,
} from "../src/detail-controller";
import { OutlinerActionKeymap } from "../src/outliner-actions";
import { detailBacklinkRegions } from "../src/detail-pi-preview";
import { detailPropertyInspectorRegions } from "../src/detail-pi-renderer";
import type { ReferencedFile } from "../src/files";
import type { OutlinerLinkTarget } from "../src/outliner-links";
import { patchPropertyText } from "../src/properties";
import { deriveResourceCapabilityReport } from "../src/resources";
import {
  negotiateResourcePresentation,
  TUI_RESOURCE_PRESENTATION_CONTEXT,
} from "../src/resource-presentation";
import type {
  AnnotationRecord,
  AnnotationReconcileInput,
  AnnotationResolutionEvent,
  AnnotationTarget,
  AnnotationThread,
  BacklinkCollection,
  BacklinkQuery,
  Block,
  BlockSearchQuery,
  OutlinerEvent,
  OutlinerUiCommand,
  PageAddressCollection,
  SelectionContext,
  ResourceDescription,
  VisibleBlockCollection,
} from "../src/types";

const viewport: DetailViewport = { width: 60, height: 12 };

function makeBlock(overrides: Partial<Block> = {}): Block {
  return {
    id: "block-1",
    parentId: null,
    position: 0,
    text: "Raw block text",
    author: "user",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "version-1",
    properties: [],
    ...overrides,
  };
}


function filePreview(overrides: Partial<ReferencedFile> = {}): ReferencedFile {
  return {
    absolutePath: "/workspace/src/example.ts",
    displayPath: "src/example.ts",
    sourcePath: "src/example.ts",
    lines: ["one", "two", "three", "four", "five", "six", "seven", "eight"],
    firstLine: 10,
    sourceVersion: "1770000000000000000:39",
    sourceHash: "filesystem-content-hash",
    capturedAt: "2026-02-02T00:00:00.000Z",
    ...overrides,
  };
}
function annotationRecord(
  target: AnnotationTarget,
  overrides: Partial<AnnotationRecord> = {},
): AnnotationRecord {
  const block = makeBlock({ id: "annotation-1", text: "Comment\n[type::annotation]\nBody" });
  const event: AnnotationResolutionEvent = {
    id: "resolution-1",
    annotationId: block.id,
    sequence: 0,
    sourceRepresentation: target.representation,
    targetRepresentation: target.representation,
    resolvedTarget: target,
    method: {
      kind: "codec",
      codecId: "text-quote",
      codecVersion: 1,
      method: "capture",
    },
    reviewer: { kind: "system", id: "annotation-repository" },
    confidence: 1,
    candidates: [],
    status: "resolved",
    appliesCurrent: true,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  return {
    block,
    originalTarget: target,
    resolvedTarget: target,
    currentResolution: event,
    resolutionHistory: [event],
    body: "Body",
    source: "user",
    lifecycle: "open",
    ...overrides,
  };
}


interface Harness {
  controller: ReturnType<typeof createDetailController>;
  effects: DetailEffects;
  calls: {
    selections: number;
    setSelections: string[];
    projectedReads: string[];
    projectedReadHosts: Array<string | undefined>;
    updates: Array<{ blockId: string; text: string; expectedUpdatedAt: string }>;
    externalDrafts: Array<Parameters<DetailEffects["editExternalDraft"]>[0]>;
    propertyPatches: Array<Parameters<DetailEffects["patchProperties"]>[0]>;
    creates: Array<Parameters<DetailEffects["createAnnotation"]>[0]>;
    restores: string[];
    histories: Array<"back" | "forward">;
    followedReferences: OutlinerLinkTarget[];
    queries: BlockSearchQuery[];
    backlinkQueries: BacklinkQuery[];
    navigationDispatches: Array<{
      blockId: string;
      intent: "preview" | "open" | "reveal";
      preserveSource: boolean;
      fragmentId?: string;
      focusTarget?: boolean;
    }>;
    pageQueries: Array<{ query: string | undefined; limit: number }>;
    focuses: number;
    selfFocuses: number;
    locks: boolean[];
    currentBlocks: Array<string | null>;
    propertyInspectorPanes: string[];
    backlinkPeeks: Array<Parameters<DetailEffects["openBacklinkPeek"]>[0]>;
    virtualNavigators: string[];
    virtualNavigatorAdapters: Array<"bookmark" | undefined>;
    bookmarkToggles: string[];
    openedDetails: Array<{
      blockId: string;
      direction: "right" | "down";
      fragmentId?: string;
    }>;
    copiedTexts: string[];
    filesystemInterns: string[];
    reconciles: AnnotationReconcileInput[];
  };
  setSelection(selection: SelectionContext): void;
  setUpdate(implementation: DetailEffects["updateBlock"]): void;
  setExternalEdit(implementation: DetailEffects["editExternalDraft"]): void;
  setQueryResults(results: VisibleBlockCollection[]): void;
  setBacklinkResults(results: BacklinkCollection[]): void;
  setPageQueryResults(results: PageAddressCollection[]): void;
  setFocusError(error: Error | null): void;
}

function createHarness(
  initial: Block,
  referencedFile: ReferencedFile | null = null,
  resolveReferences: DetailEffects["resolveReferences"] = async (text) => ({
    text: `resolved:${text}`,
    references: [],
    workIdPrefix: "PIE",
  }),
  projectRead: DetailEffects["projectRead"] = async (text) => ({
    text,
    embeds: [],
    embedRanges: [],
  }),
  controllerOptions: DetailControllerOptions = {},
): Harness {
  let selection: SelectionContext = { selected: initial, ancestors: [], children: [] };
  let update: DetailEffects["updateBlock"] = async (input) => makeBlock({
    id: input.blockId,
    text: input.text,
    updatedAt: "version-2",
    properties: initial.properties,
  });
  let externalEdit: DetailEffects["editExternalDraft"] = async (input) => ({
    text: input.text,
    changed: false,
    recoveryPath: "/tmp/unchanged-draft",
    cleanup() {},
  });
  let queryResults: VisibleBlockCollection[] = [];
  let backlinkResults: BacklinkCollection[] = [];
  let focusError: Error | null = null;
  let bookmarkRecord: Block | null = null;
  let pageQueryResults: PageAddressCollection[] = [];
  let annotationThreads: AnnotationThread[] = [];
  const calls: Harness["calls"] = {
    selections: 0,
    setSelections: [],
    projectedReads: [],
    projectedReadHosts: [],
    updates: [],
    externalDrafts: [],
    creates: [],
    restores: [],
    histories: [],
    followedReferences: [],
    queries: [],
    backlinkQueries: [],
    navigationDispatches: [],
    pageQueries: [],
    focuses: 0,
    selfFocuses: 0,
    locks: [],
    currentBlocks: [],
    propertyInspectorPanes: [],
    propertyPatches: [],
    backlinkPeeks: [],
    openedDetails: [],
    virtualNavigators: [],
    virtualNavigatorAdapters: [],
    bookmarkToggles: [],
    copiedTexts: [],
    filesystemInterns: [],
    reconciles: [],
  };
  const effects: DetailEffects = {
    clientId: "detail-test",
    browsingContextId: "context-test",
    focusSelf() {
      calls.selfFocuses += 1;
    },
    async getBrowsingContext() {
      calls.selections += 1;
      return {
        contextId: "context-test",
        target: selection.selected
          ? { kind: "block", blockId: selection.selected.id }
          : null,
      };
    },
    async loadTarget(target) {
      if (target.kind === "block") {
        calls.selections += 1;
        const context = selection.selected?.id === target.blockId
          ? selection
          : {
              selected: makeBlock({ id: target.blockId, text: `Target ${target.blockId}` }),
              ancestors: [],
              children: [],
            };
        return { kind: "block", target, context };
      }
      const source = {
        id: "20000000-0000-4000-8000-000000000001",
        name: "Test files",
        provider: "filesystem" as const,
        boundary: { kind: "filesystem" as const, root: "/workspace" },
        policy: { deniedCapabilities: [] },
        version: 1,
        createdAt: "created",
        updatedAt: "updated",
      };
      const resource = {
        id: target.resourceId,
        sourceId: source.id,
        provider: "filesystem" as const,
        address: { kind: "filesystem" as const, path: "notes/example.md" },
        version: 1,
        addressVersion: 1,
        mediaType: "text/markdown",
        createdAt: "created",
        updatedAt: "updated",
      };
      return {
        kind: "resource",
        target,
        description: {
          resource,
          source,
          requestedRevision: target.revision ?? null,
          capabilities: deriveResourceCapabilityReport(source, true),
          web: null,
          webHistory: null,
          webStatus: null,
          remoteEntity: null,
          remoteStatus: null,
          availableCommands: [],
        },
      };
    },
    async setLocked(locked) {
      calls.locks.push(locked);
    },
    async setCurrentTarget(target) {
      calls.currentBlocks.push(target?.kind === "block" ? target.blockId : null);
    },
    async dispatchNavigation(target, intent, options) {
      const blockTarget = target.kind === "block" ? target : null;
      calls.navigationDispatches.push({
        blockId: target.kind === "block" ? target.blockId : target.resourceId,
        intent,
        preserveSource: options?.preserveSource === true,
        ...(blockTarget?.fragmentId ? { fragmentId: blockTarget.fragmentId } : {}),
        ...(options?.focusTarget ? { focusTarget: true } : {}),
      });
      const targetClientId = options?.preserveSource ? "detail-other" : "detail-test";
      let command: OutlinerUiCommand;
      if (intent === "reveal") {
        if (!blockTarget) throw new Error("Cannot reveal a resource in a Tree");
        command = {
          targetClientId,
          command: "reveal",
          target: blockTarget,
          ...(options?.focusTarget ? { focus: true } : {}),
        };
      } else {
        command = {
          targetClientId,
          command: intent,
          target,
          ...(options?.focusTarget ? { focus: true } : {}),
        };
      }
      return {
        sourceClientId: "detail-test",
        targetClientId,
        intent,
        resolution: "unlocked",
        command,
      };
    },
    resolveReferences,
    async projectRead(text, hostBlockId) {
      calls.projectedReads.push(text);
      calls.projectedReadHosts.push(hostBlockId);
      return projectRead(text, hostBlockId);
    },
    async queryBacklinks(query) {
      calls.backlinkQueries.push(query);
      return backlinkResults.shift() ?? {
        targetBlockId: query.targetBlockId,
        sources: [],
        completeness: { kind: "complete" },
      };
    },
    openBacklinkPeek(input) {
      calls.backlinkPeeks.push(input);
    },
    openDetailPane(target, direction) {
      calls.openedDetails.push({
        blockId: target.kind === "block" ? target.blockId : target.resourceId,
        direction,
        ...(target.kind === "block" && target.fragmentId
          ? { fragmentId: target.fragmentId }
          : {}),
      });
    },
    copyText(text) {
      calls.copiedTexts.push(text);
    },
    async editExternalDraft(input) {
      calls.externalDrafts.push(input);
      return externalEdit(input);
    },
    async resolveNavigation(intent) {
      return {
        sourceClientId: "detail-test",
        targetClientId: "detail-test",
        intent,
        resolution: "unlocked",
      };
    },
    async updateBlock(input) {
      calls.updates.push(input);
      return update(input);
    },
    async patchProperties(input) {
      calls.propertyPatches.push(input);
      const current = selection.selected?.id === input.blockId
        ? selection.selected
        : makeBlock({ id: input.blockId });
      const updated = makeBlock({
        ...current,
        text: patchPropertyText(current.text, input.operations),
        updatedAt: "version-2",
      });
      if (selection.selected?.id === input.blockId) {
        selection = { ...selection, selected: updated };
      }
      return updated;
    },
    async restoreBlock(blockId) {
      calls.restores.push(blockId);
      if (selection.selected?.id === blockId) {
        selection = {
          ...selection,
          selected: makeBlock({ ...selection.selected, deletedAt: undefined, effectiveDeletedRootId: undefined }),
        };
      }
      return selection.selected!;
    },
    async resolveReference(target) {
      calls.followedReferences.push(target);
      const blockId = target.kind === "block" ? target.value : `resolved-${target.kind}`;
      return {
        block: selection.selected?.id === blockId
          ? selection.selected
          : makeBlock({ id: blockId, text: `Target ${blockId}` }),
        ...(target.fragmentId ? { fragmentId: target.fragmentId } : {}),
      };
    },
    async createAnnotation(input) {
      calls.creates.push(input);
      const record = annotationRecord(input.input.target, {
        body: input.input.body,
        source: input.input.source,
      });
      annotationThreads = [{ ...record, replies: [] }];
      return {
        annotations: [record],
        deduplicated: false,
      };
    },
    async internFilesystem(path) {
      calls.filesystemInterns.push(path);
      return {
        resource: {
          id: "30000000-0000-4000-8000-000000000001",
          sourceId: "20000000-0000-4000-8000-000000000001",
          provider: "filesystem",
          address: { kind: "filesystem", path },
          version: 1,
          addressVersion: 1,
          mediaType: "text/plain",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        created: false,
      };
    },
    async refreshResource() {
      throw new Error("No web resource configured");
    },
    openExternal() {},
    async getAnnotation(annotationId) {
      const thread = annotationThreads.find(({ block }) => block.id === annotationId);
      if (!thread) throw new Error(`Missing annotation ${annotationId}`);
      return thread;
    },
    async listAnnotations() {
      return annotationThreads;
    },
    async reconcileAnnotations(input) {
      calls.reconciles.push(input);
      return { threads: annotationThreads, changed: true };
    },
    async getAttention() {
      return emptyAttentionState("detail-test");
    },
    async acknowledgeAttention() {
      return emptyAttentionState("detail-test");
    },
    async queryBlocks(query) {
      calls.queries.push(query);
      return queryResults.shift() ?? { blocks: [], completeness: { kind: "complete" } };
    },
    async queryPageAddresses(query, limit) {
      calls.pageQueries.push({ query, limit });
      return pageQueryResults.shift() ?? { addresses: [], completeness: { kind: "complete" } };
    },
    readFile() {
      if (!referencedFile) throw new Error("file unavailable");
      return referencedFile;
    },
    completeFiles(query) {
      return query === "src/"
        ? [
            { sourcePath: "src/components/", isDirectory: true },
            { sourcePath: "src/detail.ts", isDirectory: false },
          ]
        : [];
    },
    async focusOutliner() {
      calls.focuses += 1;
      if (focusError) throw focusError;
    },
    openPropertyInspectorPane(blockId) {
      calls.propertyInspectorPanes.push(blockId);
      return "pane-inspector";
    },
    openVirtualBranchNavigator(viewId, adapter) {
      calls.virtualNavigators.push(viewId);
      calls.virtualNavigatorAdapters.push(adapter);
    },
    async bookmarkStatus(targetBlockId) {
      return {
        root: makeBlock({ id: "bookmarks-root", text: "Bookmarks" }),
        targetBlockId,
        record: bookmarkRecord,
      };
    },
    async toggleBookmark(targetBlockId) {
      calls.bookmarkToggles.push(targetBlockId);
      bookmarkRecord = bookmarkRecord
        ? null
        : makeBlock({ id: "bookmark-record", text: "Bookmark record" });
      return {
        bookmarked: bookmarkRecord !== null,
        record: bookmarkRecord ?? makeBlock({ id: "bookmark-record", deletedAt: "deleted" }),
        root: makeBlock({ id: "bookmarks-root", text: "Bookmarks" }),
        target: selection.selected?.id === targetBlockId
          ? selection.selected
          : makeBlock({ id: targetBlockId }),
      };
    },
    async bookmarksRoot() {
      return makeBlock({ id: "bookmarks-root", text: "Bookmarks" });
    },
  };
  return {
    controller: createDetailController(effects, undefined, controllerOptions),
    effects,
    calls,
    setSelection(next) {
      selection = next;
    },
    setUpdate(implementation) {
      update = implementation;
    },
    setExternalEdit(implementation) {
      externalEdit = implementation;
    },
    setQueryResults(next) {
      queryResults = [...next];
    },
    setBacklinkResults(next) {
      backlinkResults = [...next];
    },
    setPageQueryResults(next) {
      pageQueryResults = [...next];
    },
    setFocusError(error) {
      focusError = error;
    },
  };
}

function event(domain: OutlinerEvent["domain"], command?: OutlinerEvent["command"]): OutlinerEvent {
  return { id: "event-1", domain, action: "changed", sequence: 1, command };
}

describe("detail controller projection and deferred refresh", () => {
  test("chooses annotation before file and preserves raw text for editing", async () => {
    const block = makeBlock({
      text: "Raw ((reference))",
      properties: [
        { key: "file", value: "src/example.ts" },
        { key: "type", value: "annotation" },
      ],
    });
    const harness = createHarness(block, filePreview());

    await harness.controller.initialize();
    expect(harness.controller.state.mode).toBe("annotation");
    expect(harness.controller.state.resolvedSelectedText).toBe("resolved:Raw ((reference))");
    expect(harness.calls.currentBlocks).toEqual([]);


    await harness.controller.dispatch({ type: "edit.begin" }, viewport);
    expect(harness.controller.state.buffer.text).toBe("Raw ((reference))");
    expect(harness.controller.state.mode).toBe("edit");
  });

  test("copies the exact editor selection through the terminal effect", async () => {
    const harness = createHarness(makeBlock({ text: "alpha beta\ngamma" }));
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "edit.begin" }, viewport);
    await harness.controller.dispatch({
      type: "editor.cursor.place",
      visualRow: 0,
      contentColumn: 2,
    }, viewport);
    await harness.controller.dispatch({
      type: "editor.cursor.place",
      visualRow: 1,
      contentColumn: 3,
      extend: true,
    }, viewport);

    await harness.controller.dispatch({ type: "buffer.copy" }, viewport);
    expect(harness.calls.copiedTexts).toEqual(["pha beta\ngam"]);
    expect(harness.controller.state.status).toBe("Copied 12 characters");

    await harness.controller.dispatch({
      type: "editor.cursor.place",
      visualRow: 0,
      contentColumn: 0,
    }, viewport);
    await harness.controller.dispatch({ type: "buffer.copy" }, viewport);
    expect(harness.calls.copiedTexts).toEqual(["pha beta\ngam"]);
    expect(harness.controller.state.status).toBe("No text selected");
  });

  test("keeps wheel viewport movement independent until cursor input resumes following", async () => {
    const text = Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n");
    const harness = createHarness(makeBlock({ text }));
    const smallViewport: DetailViewport = { width: 24, editorWidth: 24, height: 10 };
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "edit.begin" }, smallViewport);
    const cursor = {
      row: harness.controller.state.buffer.row,
      column: harness.controller.state.buffer.column,
    };
    const cursorOffset = harness.controller.state.editorVisualOffset;

    await harness.controller.dispatch(
      { type: "editor.viewport.scroll", delta: -4 },
      smallViewport,
    );
    expect(harness.controller.state.editorVisualOffset).toBe(cursorOffset - 4);
    expect(harness.controller.state.editorViewportManual).toBe(true);
    expect({
      row: harness.controller.state.buffer.row,
      column: harness.controller.state.buffer.column,
    }).toEqual(cursor);

    await harness.controller.dispatch(
      { type: "buffer.move", direction: "left" },
      smallViewport,
    );
    expect(harness.controller.state.editorViewportManual).toBe(false);
    expect(harness.controller.state.editorVisualOffset).toBe(cursorOffset);

    await harness.controller.dispatch(
      { type: "editor.cursor.place", visualRow: 0, contentColumn: 0 },
      smallViewport,
    );
    expect({
      row: harness.controller.state.buffer.row,
      column: harness.controller.state.buffer.column,
    }).toEqual({ row: 0, column: 0 });
    expect(harness.controller.state.editorVisualOffset).toBe(0);

    const originalText = harness.controller.state.buffer.text;
    await harness.controller.dispatch({ type: "draft-preview.link.toggle" }, {
      ...smallViewport,
      width: 120,
      editorWidth: 60,
    });
    expect(harness.controller.state.draftPreviewLinked).toBe(true);
    expect(harness.controller.state.buffer.text).toBe(originalText);
    await harness.controller.dispatch({ type: "viewport.changed" }, smallViewport);
    expect(harness.controller.state.draftPreviewLinked).toBe(false);
  });
  test("refreshes generated read projection on content events without changing canonical text", async () => {
    const selected = makeBlock({ text: "Recommendation\n!((view-next))" });
    let version = 1;
    const harness = createHarness(
      selected,
      null,
      async (text) => ({ text, references: [] }),
      async () => ({
        text: `Recommendation\nEmbedded view version ${version}\n- ((result-one))`,
        embeds: [{
          blockId: "view-next",
          status: "ready",
          count: 1,
          completeness: { kind: "complete" },
        }],
        embedRanges: [{ startLine: 1, endLine: 2 }],
      }),
    );

    await harness.controller.initialize();
    expect(harness.controller.state.projectedSelectedText).toContain("version 1");
    expect(harness.controller.state.embedStates[0]?.status).toBe("ready");

    version = 2;
    await harness.controller.onServiceEvent(event("content"), viewport);

    expect(harness.controller.state.projectedSelectedText).toContain("version 2");
    expect(harness.controller.state.context.selected?.text).toBe(selected.text);
    expect(harness.calls.projectedReads).toEqual([selected.text, selected.text]);
    expect(harness.calls.projectedReadHosts).toEqual([selected.id, selected.id]);
  });

  test("toggles embedded item backgrounds per Detail without changing projection data", async () => {
    const selected = makeBlock({ text: "Recommendation\n!((view-next))" });
    const harness = createHarness(selected);
    await harness.controller.initialize();

    expect(harness.controller.state.embedBackgroundEnabled).toBe(true);
    await harness.controller.dispatch({ type: "embed-background.toggle" }, viewport);
    expect(harness.controller.state.embedBackgroundEnabled).toBe(false);
    expect(harness.controller.state.status).toBe("Embedded item backgrounds hidden");
    await harness.controller.dispatch({ type: "embed-background.toggle" }, viewport);
    expect(harness.controller.state.embedBackgroundEnabled).toBe(true);
    expect(harness.controller.state.status).toBe("Embedded item backgrounds shown");
  });

  test("keeps trashed blocks read-only and restores direct Trash roots explicitly", async () => {
    const deleted = makeBlock({
      deletedAt: "deleted-at",
      effectiveDeletedRootId: "block-1",
    });
    const harness = createHarness(deleted);
    await harness.controller.initialize();

    expect(harness.controller.state.status).toContain("In Trash");
    await harness.controller.dispatch({ type: "edit.begin" }, viewport);
    expect(harness.controller.state.mode).toBe("preview");
    expect(harness.controller.state.status).toContain("restore before editing");

    await harness.controller.dispatch({ type: "trash.restore" }, viewport);
    expect(harness.calls.restores).toEqual([deleted.id]);
    expect(harness.controller.state.context.selected?.effectiveDeletedRootId).toBeUndefined();
    expect(harness.controller.state.status).toBe("Restored from Trash");
  });

  test("keeps inherited Trash descendants read-only without offering direct restore", async () => {
    const deletedFile = makeBlock({
      effectiveDeletedRootId: "deleted-root",
      properties: [{ key: "file", value: "src/example.ts" }],
    });
    const harness = createHarness(deletedFile, filePreview());
    await harness.controller.initialize();

    expect(harness.controller.state.status).toBe(
      "In Trash — read-only · restore its direct Trash root",
    );
    await harness.controller.dispatch({ type: "comment.begin" }, viewport);
    expect(harness.controller.state.mode).toBe("file");
    expect(harness.controller.state.status).toContain("restore before adding annotations");
    expect(harness.calls.creates).toEqual([]);
  });

  test("reveals the current Detail target without following its references", async () => {
    const source = makeBlock({ id: "current-block", text: "See ((target01))" });
    const harness = createHarness(source);
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "lock.toggle" }, viewport);

    await harness.controller.dispatch({ type: "current.reveal" }, viewport);

    expect(harness.calls.navigationDispatches).toEqual([{
      blockId: source.id,
      intent: "reveal",
      preserveSource: false,
      focusTarget: true,
    }]);
    expect(harness.calls.followedReferences).toEqual([]);
    expect(harness.controller.state.context.selected?.id).toBe(source.id);
    expect(harness.controller.state.connectionMode).toBe("locked");
    expect(harness.controller.state.status).toBe("Revealed See ((target01))");
  });

  test("opens the generic navigator only for the current virtual branch", async () => {
    const view = makeBlock({
      id: "next-view",
      text: "Next\n[type::virtual-branch]",
      properties: [{ key: "type", value: "virtual-branch" }],
    });
    const harness = createHarness(view);
    await harness.controller.initialize();

    await harness.controller.dispatch({ type: "virtual-branch.open" }, viewport);
    expect(harness.calls.virtualNavigators).toEqual([view.id]);

    const ordinary = createHarness(makeBlock({ id: "ordinary", text: "Ordinary" }));
    await ordinary.controller.initialize();
    await ordinary.controller.dispatch({ type: "virtual-branch.open" }, viewport);
    expect(ordinary.calls.virtualNavigators).toEqual([]);
    expect(ordinary.controller.state.status).toBe("Current block is not a virtual branch");
  });

  test("toggles the current bookmark and opens its adapted navigator", async () => {
    const target = makeBlock({ id: "bookmark-target", text: "Bookmark target" });
    const harness = createHarness(target);
    await harness.controller.initialize();

    await harness.controller.dispatch({ type: "bookmark.toggle" }, viewport);
    expect(harness.calls.bookmarkToggles).toEqual([target.id]);
    expect(harness.controller.state.status).toBe("Bookmarked");

    await harness.controller.dispatch({ type: "bookmark.toggle" }, viewport);
    expect(harness.controller.state.status).toBe("Bookmark removed");

    await harness.controller.dispatch({ type: "bookmarks.open" }, viewport);
    expect(harness.calls.virtualNavigators).toEqual(["bookmarks-root"]);
    expect(harness.calls.virtualNavigatorAdapters).toEqual(["bookmark"]);
    expect(harness.controller.state.context.selected?.id).toBe(target.id);
  });

  test("reports bookmark failures and does not bookmark Trash targets", async () => {
    const target = makeBlock({ id: "bookmark-target", text: "Bookmark target" });
    const statusFailure = createHarness(target);
    await statusFailure.controller.initialize();
    statusFailure.effects.bookmarkStatus = async () => {
      throw new Error("Bookmark target is unavailable");
    };
    await statusFailure.controller.dispatch({ type: "bookmark.toggle" }, viewport);
    expect(statusFailure.controller.state.status).toBe("Bookmark target is unavailable");

    const toggleFailure = createHarness(target);
    await toggleFailure.controller.initialize();
    toggleFailure.effects.toggleBookmark = async () => {
      throw new Error("Bookmark changed; refresh and retry");
    };
    await toggleFailure.controller.dispatch({ type: "bookmark.toggle" }, viewport);
    expect(toggleFailure.controller.state.status).toBe("Bookmark changed; refresh and retry");

    const deleted = createHarness(makeBlock({
      id: "deleted-target",
      deletedAt: "deleted-at",
      effectiveDeletedRootId: "deleted-target",
    }));
    await deleted.controller.initialize();
    await deleted.controller.dispatch({ type: "bookmark.toggle" }, viewport);
    expect(deleted.calls.bookmarkToggles).toEqual([]);
    expect(deleted.controller.state.status).toBe("Block is in Trash; restore before bookmarking");
  });

  test("keeps navigation history local and loads deleted targets read-only", async () => {
    const source = makeBlock({ text: "See ((target01))" });
    const harness = createHarness(source);
    await harness.controller.initialize();

    await harness.controller.dispatch({ type: "reference.follow" }, viewport);
    expect(harness.controller.state.destinationChooser).toMatchObject({
      active: true,
      target: {
        target: { kind: "block", blockId: "target01" },
      },
    });
    expect(harness.controller.state.context.selected?.id).toBe(source.id);
    await harness.controller.handleDestinationChooserKeypress("", { name: "return" });
    expect(harness.calls.followedReferences).toEqual([{ kind: "block", value: "target01" }]);
    expect(harness.controller.state.context.selected?.id).toBe("target01");
    expect(harness.controller.state.connectionMode).toBe("unlocked");

    harness.setSelection({
      selected: makeBlock({
        id: "deleted1",
        deletedAt: "deleted-at",
        effectiveDeletedRootId: "deleted1",
      }),
      ancestors: [],
      children: [],
    });
    await harness.controller.onServiceEvent(
      event("ui", { targetClientId: "detail-test", command: "reveal", target: { kind: "block", blockId: "deleted1" } }),
      viewport,
    );
    await harness.controller.dispatch({ type: "navigation.back" }, viewport);
    expect(harness.controller.state.context.selected?.id).toBe("target01");
    await harness.controller.dispatch({ type: "navigation.forward" }, viewport);
    expect(harness.controller.state.context.selected).toMatchObject({
      id: "deleted1",
      effectiveDeletedRootId: "deleted1",
    });
    expect(harness.controller.state.mode).toBe("preview");

    await harness.controller.dispatch({ type: "edit.begin" }, viewport);
    expect(harness.controller.state.status).toContain("restore before editing");
  });

  test("follows a durable fragment reference to its anchored preview line", async () => {
    const source = makeBlock({ text: "See ((target01^decision|the approved boundary))" });
    const target = makeBlock({
      id: "target01",
      text: "Target\n\nIntro\n\n## Decision ^decision\nBody",
    });
    const harness = createHarness(source);
    await harness.controller.initialize();
    harness.setSelection({ selected: target, ancestors: [], children: [] });

    await harness.controller.dispatch({ type: "reference.follow" }, viewport);
    expect(harness.calls.navigationDispatches).toEqual([]);
    await harness.controller.handleDestinationChooserKeypress("", { name: "return" });

    expect(harness.calls.followedReferences).toEqual([{
      kind: "block",
      value: target.id,
      fragmentId: "decision",
    }]);
    expect(harness.calls.navigationDispatches).toEqual([{
      blockId: target.id,
      intent: "open",
      preserveSource: false,
      fragmentId: "decision",
    }]);
    expect(harness.controller.state.context.selected?.id).toBe(target.id);
    expect(harness.controller.state.previewOffset).toBe(4);

    const renamed = makeBlock({
      ...target,
      text: "Target\n\nIntro revised\n\n## Renamed decision ^decision\nBody",

      updatedAt: "renamed-version",
    });
    harness.setSelection({ selected: renamed, ancestors: [], children: [] });
    await harness.controller.onServiceEvent(event("content"), viewport);
    expect(harness.controller.state.target).toMatchObject({ kind: "block", fragmentId: "decision" });
    expect(harness.controller.state.previewOffset).toBe(4);

    await harness.controller.dispatch({ type: "navigation.back" }, viewport);
    await harness.controller.dispatch({ type: "navigation.forward" }, viewport);
    expect(harness.controller.state.context.selected?.id).toBe(target.id);
    expect(harness.controller.state.target).toMatchObject({ kind: "block", fragmentId: "decision" });
    expect(harness.controller.state.previewOffset).toBe(4);
  });
  test("opens a resource target without creating block context", async () => {
    const initial = makeBlock({ id: "block-anchor", text: "Anchor" });
    const harness = createHarness(initial);
    await harness.controller.initialize();

    await harness.controller.onServiceEvent(event("ui", {
      targetClientId: "detail-test",
      command: "open",
      target: {
        kind: "resource",
        resourceId: "10000000-0000-4000-8000-000000000001",
      },
    }), viewport);

    expect(harness.controller.state.target).toEqual({
      kind: "resource",
      resourceId: "10000000-0000-4000-8000-000000000001",
    });
    expect(harness.controller.state.resource).toMatchObject({
      address: { kind: "filesystem", path: "notes/example.md" },
      mediaType: "text/markdown",
    });
    expect(harness.controller.state.context).toEqual({
      selected: null,
      ancestors: [],
      children: [],
    });
    expect(harness.controller.state.resolvedSelectedText).toContain(
      "10000000-0000-4000-8000-000000000001",
    );

    await harness.controller.dispatch({ type: "navigation.back" }, viewport);
    expect(harness.controller.state.target).toEqual({
      kind: "block",
      blockId: initial.id,
    });
  });

  test("opens, annotates, refreshes, and externally opens cached web Markdown", async () => {
    const harness = createHarness(makeBlock({ id: "block-anchor" }));
    const target = {
      kind: "resource" as const,
      resourceId: "10000000-0000-4000-8000-000000000001",
    };
    const source = {
      id: "20000000-0000-4000-8000-000000000001",
      name: "Web fixture",
      provider: "web" as const,
      boundary: { kind: "web" as const, baseUrl: "https://example.com/" },
      policy: { deniedCapabilities: [] },
      version: 1,
      createdAt: "created",
      updatedAt: "updated",
    };
    const resource = {
      id: target.resourceId,
      sourceId: source.id,
      provider: "web" as const,
      address: { kind: "web" as const, url: "https://example.com/article" },
      version: 1,
      addressVersion: 1,
      mediaType: "text/html",
      createdAt: "created",
      updatedAt: "updated",
    };
    const description = (markdown: string, revision: string): ResourceDescription => {
      const sourceSnapshot = {
        id: `source-snapshot-${revision}`,
        resourceId: resource.id,
        addressVersion: resource.addressVersion,
        canonicalUrl: resource.address.url,
        contentHash: revision.repeat(64).slice(0, 64),
        revision: {
          resourceId: resource.id,
          addressVersion: resource.addressVersion,
          revision: {
            kind: "web" as const,
            validator: { kind: "etag" as const, value: revision, weak: false },
          },
        },
        fetchedAt: "2026-09-17T12:00:00.000Z",
        bodyAvailable: true,
        evictedAt: null,
      };
      const representation = {
        id: `representation-${revision}`,
        sourceSnapshotId: sourceSnapshot.id,
        mediaType: "text/markdown" as const,
        adapter: { id: "fixture", version: 1 },
        contentHash: revision.repeat(64).slice(0, 64),
        derivedAt: "2026-09-17T12:00:01.000Z",
        contentAvailable: true,
        evictedAt: null,
      };
      const result: ResourceDescription = {
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
          checkedAt: "2026-09-17T12:00:02.000Z",
          lastError: null,
        },
        remoteEntity: null,
        remoteStatus: null,
        availableCommands: [],
      };
      return {
        ...result,
        presentation: negotiateResourcePresentation(result, {
          ...TUI_RESOURCE_PRESENTATION_CONTEXT,
          providerAccess: { credentials: "available", connectivity: "available" },
        }),
      };
    };
    let current = description("# First\n\nStable quote", "a");
    const externalUrls: string[] = [];
    harness.effects.loadTarget = async () => ({ kind: "resource", target, description: current });
    harness.effects.refreshResource = async () => {
      current = description("# Second\n\nChanged page", "b");
      return current;
    };
    harness.effects.openExternal = (url) => {
      externalUrls.push(url);
    };
    await harness.controller.initialize();
    await harness.controller.onServiceEvent(event("ui", {
      targetClientId: "detail-test",
      command: "open",
      target,
    }), viewport);
    expect(harness.calls.reconciles.at(-1)).toMatchObject({
      subject: { kind: "resource", resourceId: resource.id },
      newRepresentation: { id: "representation-a" },
      content: "# First\n\nStable quote",
    });
    const reconcilesBeforeContentEvent = harness.calls.reconciles.length;
    await harness.controller.onServiceEvent(event("content"), viewport);
    expect(harness.calls.reconciles).toHaveLength(reconcilesBeforeContentEvent + 1);
    const loadLatestTarget = harness.effects.loadTarget;
    const pinnedTarget = {
      ...target,
      revision: current.web!.sourceSnapshot.revision,
    };
    harness.effects.loadTarget = async (candidate) => candidate.kind === "resource" &&
        candidate.revision
      ? {
          kind: "resource",
          target: candidate,
          description: { ...current, requestedRevision: candidate.revision },
        }
      : loadLatestTarget(candidate);
    const reconcilesBeforePinnedOpen = harness.calls.reconciles.length;
    await harness.controller.onServiceEvent(event("ui", {
      targetClientId: "detail-test",
      command: "open",
      target: pinnedTarget,
    }), viewport);
    expect(harness.calls.reconciles).toHaveLength(reconcilesBeforePinnedOpen);
    harness.effects.loadTarget = loadLatestTarget;
    await harness.controller.onServiceEvent(event("ui", {
      targetClientId: "detail-test",
      command: "open",
      target,
    }), viewport);

    expect(harness.controller.state.resolvedSelectedText.startsWith("# First\n\nStable quote"))
      .toBe(true);
    expect(harness.controller.state.resolvedSelectedText).toContain(
      "- Freshness: **fresh**",
    );
    expect(harness.controller.state.resolvedSelectedText).toContain(
      "- Source snapshot ID: `source-snapshot-a`",
    );
    expect(harness.controller.state.resolvedSelectedText).toContain(
      `- Source hash: \`${"a".repeat(64)}\``,
    );
    expect(harness.controller.state.resolvedSelectedText).toContain(
      "- Provider revision: web ETag a",
    );
    expect(harness.controller.state.resolvedSelectedText).toContain(
      "- Fetched: 2026-09-17T12:00:00.000Z",
    );
    expect(harness.controller.state.resolvedSelectedText).toContain(
      "- Representation ID: `representation-a`",
    );
    expect(harness.controller.state.resolvedSelectedText).toContain(
      "- Adapter: `fixture@1`",
    );
    expect(harness.controller.state.resolvedSelectedText).toContain(
      `- Representation hash: \`${"a".repeat(64)}\``,
    );
    expect(harness.controller.state.resolvedSelectedText).toContain(
      "- Derived: 2026-09-17T12:00:01.000Z",
    );
    expect(harness.controller.state.resolvedSelectedText).toContain(
      "## Retained history\n\n- Source snapshots: 1\n- Representations: 1",
    );

    current = description("# Workspace collection\n\nFresh history state", "a");
    await harness.controller.onServiceEvent(event("resource-catalog"), viewport);
    expect(harness.controller.state.resolvedSelectedText).toContain("Fresh history state");

    for (
      const [freshness, guidance] of [
        ["stale", "older than the freshness window"],
        ["unknown", "Provider freshness has not been checked"],
        ["refreshing", "Refresh is reconciling with the provider"],
        ["failed", "The last refresh failed"],
      ] as const
    ) {
      current = {
        ...current,
        webStatus: {
          freshness,
          checkedAt: "2026-09-17T12:00:02.000Z",
          lastError: freshness === "failed" ? "fixture offline" : null,
        },
      };
      await harness.controller.onServiceEvent({
        ...event("resource-catalog"),
        resourceId: resource.id,
      }, viewport);
      expect(harness.controller.state.resolvedSelectedText).toContain(
        `- Freshness: **${freshness}**`,
      );
      expect(harness.controller.state.resolvedSelectedText).toContain(guidance);
    }
    current = description("# First\n\nStable quote", "a");
    await harness.controller.onServiceEvent({
      ...event("resource-catalog"),
      resourceId: resource.id,
    }, viewport);
    await harness.controller.dispatch({
      type: "annotation.selection.begin",
      sourceLine: 2,
      sourceColumn: 0,
    }, viewport);
    await harness.controller.dispatch({
      type: "annotation.selection.place",
      row: 2,
      column: 12,
      extend: true,
    }, viewport);
    await harness.controller.dispatch({ type: "comment.begin" }, viewport);
    await harness.controller.dispatch({ type: "buffer.insert", text: "Keep this evidence" }, viewport);
    await harness.controller.dispatch({ type: "buffer.save" }, viewport);
    const created = harness.calls.creates[0]!.input;
    expect(created.target.anchor).toMatchObject({
      kind: "text-quote",
      exact: "Stable quote",
    });
    expect(created.body).toBe("Keep this evidence");
    expect(created.target.representation.sourceSnapshot).toMatchObject({
      kind: "resource",
      sourceSnapshotId: "source-snapshot-a",
    });
    expect(created.target.representation.id).toBe("representation-a");
    expect(harness.controller.state.annotationThreads[0]?.body).toBe("Keep this evidence");

    await harness.controller.dispatch({ type: "resource.open-external" }, viewport);
    expect(externalUrls).toEqual(["https://example.com/article"]);
    await harness.controller.dispatch({ type: "resource.refresh" }, viewport);
    expect(harness.controller.state.resolvedSelectedText.startsWith("# Second\n\nChanged page"))
      .toBe(true);
    expect(harness.controller.state.status).toBe("Web resource refreshed");
    expect(harness.calls.reconciles.at(-1)).toMatchObject({
      subject: { kind: "resource", resourceId: resource.id },
      newRepresentation: { id: "representation-b" },
      content: "# Second\n\nChanged page",
    });


    const unavailable = description("# Unavailable", "c");
    current = {
      ...unavailable,
      web: null,
      webStatus: {
        freshness: "unknown",
        checkedAt: null,
        lastError: null,
      },
      webError: "fixture offline",
    };
    current = {
      ...current,
      presentation: negotiateResourcePresentation(current, {
        ...TUI_RESOURCE_PRESENTATION_CONTEXT,
        providerAccess: { credentials: "available", connectivity: "available" },
      }),
    };
    await harness.controller.onServiceEvent({
      ...event("resource-catalog"),
      resourceId: resource.id,
    }, viewport);
    expect(harness.controller.state.resolvedSelectedText).toContain(
      "- Freshness: **unknown**",
    );
    expect(harness.controller.state.resolvedSelectedText).toContain(
      "No local snapshot is available. Press r to refresh explicitly.",
    );
    expect(harness.controller.state.resolvedSelectedText).toContain(
      "Opening this resource only reads local storage and never contacts the provider.",
    );
    expect(harness.controller.state.resolvedSelectedText).not.toContain("# Unavailable");
    await harness.controller.dispatch({ type: "resource.open-external" }, viewport);
    expect(externalUrls).toEqual([
      "https://example.com/article",
      "https://example.com/article",
    ]);

    current = {
      ...current,
      source: {
        ...source,
        policy: { deniedCapabilities: ["open-external"] },
      },
    };
    current = {
      ...current,
      presentation: negotiateResourcePresentation(current, {
        ...TUI_RESOURCE_PRESENTATION_CONTEXT,
        providerAccess: { credentials: "available", connectivity: "available" },
      }),
    };
    await harness.controller.onServiceEvent({
      ...event("resource-catalog"),
      resourceId: resource.id,
    }, viewport);
    await harness.controller.dispatch({ type: "resource.open-external" }, viewport);
    expect(externalUrls).toHaveLength(2);
    expect(harness.controller.state.status).toBe(
      "Workspace policy denies open-external",
    );
    await harness.controller.dispatch({
      type: "resource.open-url",
      url: "https://example.com/linked",
    }, viewport);
    expect(externalUrls).toEqual([
      "https://example.com/article",
      "https://example.com/article",
      "https://example.com/linked",
    ]);
    expect(harness.controller.state.status).toBe("Opened URL externally");
  });
  test("renders retained remote entities, refreshes them, and opens only negotiated deep links", async () => {
    const harness = createHarness(makeBlock({ id: "remote-anchor" }));
    const target = {
      kind: "resource" as const,
      resourceId: "10000000-0000-4000-8000-000000000255",
    };
    const source = {
      id: "20000000-0000-4000-8000-000000000255",
      name: "Product Jira",
      provider: "jira" as const,
      boundary: {
        kind: "jira" as const,
        origin: "https://jira.example.test",
        project: "PIE",
        credentialEnv: "JIRA_TOKEN",
      },
      policy: { deniedCapabilities: [] },
      version: 1,
      createdAt: "created",
      updatedAt: "updated",
    };
    const resource = {
      id: target.resourceId,
      sourceId: source.id,
      provider: "jira" as const,
      address: { kind: "jira" as const, entityId: "10042", key: "PIE-255" },
      version: 1,
      addressVersion: 1,
      mediaType: "text/markdown",
      createdAt: "created",
      updatedAt: "updated",
    };
    const describe = (
      markdown: string,
      availableCommands: ResourceDescription["availableCommands"],
    ): ResourceDescription => {
      const result: ResourceDescription = {
        resource,
        source,
        requestedRevision: null,
        capabilities: deriveResourceCapabilityReport(source, true),
        web: null,
        webHistory: null,
        webStatus: null,
        remoteEntity: {
          title: "Remote entities",
          metadata: {
            status: "In Progress",
            labels: ["resources", "providers"],
            parent: null,
          },
          markdown,
          externalUrl: "https://jira.example.test/browse/PIE-255",
          sourceSnapshot: {
            contentHash: "c".repeat(64),
            provider: "jira",
            resourceId: resource.id,
            addressVersion: 1,
            entityId: "10042",
            locator: "PIE-255",
            revision: {
              resourceId: resource.id,
              addressVersion: 1,
              revision: {
                kind: "jira",
                validator: {
                  kind: "updated-at",
                  value: "2026-09-17T12:00:00.000Z",
                },
              },
            },
            fetchedAt: "2026-09-17T12:00:01.000Z",
          },
          representation: {
            mediaType: "text/markdown",
            adapter: { id: "jira.issue-markdown", version: 1 },
            contentHash: "d".repeat(64),
            derivedAt: "2026-09-17T12:00:02.000Z",
          },
          commandDescriptors: [{
            provider: "jira",
            command: "comment.create",
            label: "Provider-advertised command",
            input: {
              body: { type: "string", required: true, maxLength: 10_000 },
            },
          }],
        },
        remoteStatus: {
          freshness: "fresh",
          checkedAt: "2026-09-17T12:00:03.000Z",
          lastError: null,
        },
        availableCommands,
      };
      return {
        ...result,
        presentation: negotiateResourcePresentation(result, {
          ...TUI_RESOURCE_PRESENTATION_CONTEXT,
          providerAccess: { credentials: "available", connectivity: "available" },
        }),
      };
    };
    let current = describe("# Remote entities\n\nRetained Jira body.", []);
    const externalUrls: string[] = [];
    harness.effects.loadTarget = async () => ({ kind: "resource", target, description: current });
    harness.effects.refreshResource = async () => {
      current = describe("# Remote entities\n\nRefreshed Jira body.", [{
        provider: "jira",
        command: "comment.create",
        label: "Create comment",
        input: {
          body: { type: "string", required: true, maxLength: 10_000 },
        },
      }]);
      return current;
    };
    harness.effects.openExternal = (url) => {
      externalUrls.push(url);
    };

    await harness.controller.initialize();
    await harness.controller.onServiceEvent(event("ui", {
      targetClientId: "detail-test",
      command: "open",
      target,
    }), viewport);

    const rendered = harness.controller.state.resolvedSelectedText;
    expect(rendered.startsWith("# Remote entities\n\nRetained Jira body.")).toBe(true);
    expect(rendered).toContain('"status": "In Progress"');
    expect(rendered).toContain('"labels": [');
    expect(rendered).toContain("- Provider revision: Jira updated-at 2026-09-17T12:00:00.000Z");
    expect(rendered).toContain("- Entity ID: `10042`");
    expect(rendered).toContain("- Adapter: `jira.issue-markdown@1`");
    expect(rendered).toContain("- Freshness: **fresh**");
    expect(rendered).not.toContain("Provider-advertised command");
    expect(rendered).not.toContain("## Available commands");

    await harness.controller.dispatch({ type: "resource.open-external" }, viewport);
    expect(externalUrls).toEqual(["https://jira.example.test/browse/PIE-255"]);
    await harness.controller.dispatch({ type: "resource.refresh" }, viewport);
    expect(harness.controller.state.status).toBe("Jira resource refreshed");
    expect(harness.controller.state.resolvedSelectedText).toContain("Refreshed Jira body.");
    expect(harness.controller.state.resolvedSelectedText).toContain("## Available commands");
    expect(harness.controller.state.resolvedSelectedText).toContain("Create comment");
    expect(harness.controller.state.resolvedSelectedText).not.toContain(
      "Provider-advertised command",
    );
  });

  test("keeps application deep-link-only resources useful without inline content", async () => {
    const harness = createHarness(makeBlock({ id: "application-anchor" }));
    const target = {
      kind: "resource" as const,
      resourceId: "10000000-0000-4000-8000-000000000256",
    };
    const source = {
      id: "20000000-0000-4000-8000-000000000256",
      name: "Team chat",
      provider: "application" as const,
      boundary: {
        kind: "application" as const,
        scheme: "slack",
        authority: "channel",
        namespace: "workspace",
      },
      policy: { deniedCapabilities: [] },
      version: 1,
      createdAt: "created",
      updatedAt: "updated",
    };
    const result: ResourceDescription = {
      resource: {
        id: target.resourceId,
        sourceId: source.id,
        provider: "application",
        address: { kind: "application", uri: "slack://channel/workspace/C0123" },
        version: 1,
        addressVersion: 1,
        mediaType: null,
        createdAt: "created",
        updatedAt: "updated",
      },
      source,
      requestedRevision: null,
      capabilities: deriveResourceCapabilityReport(source, true),
      web: null,
      webHistory: null,
      webStatus: null,
      remoteEntity: null,
      remoteStatus: null,
      availableCommands: [],
    };
    let description: ResourceDescription = {
      ...result,
      presentation: negotiateResourcePresentation(result, TUI_RESOURCE_PRESENTATION_CONTEXT),
    };
    const externalUrls: string[] = [];
    harness.effects.loadTarget = async () => ({ kind: "resource", target, description });
    harness.effects.openExternal = (url) => {
      externalUrls.push(url);
    };

    await harness.controller.initialize();
    await harness.controller.onServiceEvent(event("ui", {
      targetClientId: "detail-test",
      command: "open",
      target,
    }), viewport);

    expect(harness.controller.state.resolvedSelectedText).toContain(
      "# slack://channel/workspace/C0123",
    );
    expect(harness.controller.state.resolvedSelectedText).toContain(
      "- Provider: `application`",
    );
    expect(harness.controller.state.resolvedSelectedText).toContain(
      "- External URL: `slack://channel/workspace/C0123`",
    );
    expect(harness.controller.state.resolvedSelectedText).toContain(
      "- Open externally: Press Alt+O",
    );
    expect(harness.controller.state.resolvedSelectedText).not.toContain(
      "Retained Jira body",
    );
    await harness.controller.dispatch({ type: "resource.open-external" }, viewport);
    expect(externalUrls).toEqual(["slack://channel/workspace/C0123"]);
    description = {
      ...result,
      presentation: negotiateResourcePresentation(result, {
        ...TUI_RESOURCE_PRESENTATION_CONTEXT,
        host: {
          ...TUI_RESOURCE_PRESENTATION_CONTEXT.host,
          capabilities: ["read", "refresh"],
        },
      }),
    };
    await harness.controller.onServiceEvent({
      ...event("resource-catalog"),
      resourceId: result.resource.id,
    }, viewport);
    expect(harness.controller.state.resolvedSelectedText).toContain(
      "This Detail host has no open-external executor",
    );
    await harness.controller.dispatch({ type: "resource.open-external" }, viewport);
    expect(externalUrls).toEqual(["slack://channel/workspace/C0123"]);
  });

  test("selects PDF page evidence and refreshes filesystem PDFs", async () => {
    const harness = createHarness(makeBlock());
    const target = {
      kind: "resource" as const,
      resourceId: "30000000-0000-4000-8000-000000000254",
    };
    const markdown = "## Page 1\n\nStable PDF quote";
    const quoteStart = markdown.indexOf("Stable PDF quote");
    const source = {
      id: "20000000-0000-4000-8000-000000000254",
      name: "PDF files",
      provider: "filesystem" as const,
      boundary: { kind: "filesystem" as const, root: "/workspace" },
      policy: { deniedCapabilities: [] },
      version: 1,
      createdAt: "created",
      updatedAt: "updated",
    };
    const resource = {
      id: target.resourceId,
      sourceId: source.id,
      provider: "filesystem" as const,
      address: { kind: "filesystem" as const, path: "evidence.pdf" },
      version: 1,
      addressVersion: 1,
      mediaType: "application/pdf",
      createdAt: "created",
      updatedAt: "updated",
    };
    const revision = {
      resourceId: resource.id,
      addressVersion: 1,
      revision: { kind: "filesystem" as const, mtimeNs: "1", size: "10" },
    };
    const snapshot = {
      id: "pdf-snapshot",
      resourceId: resource.id,
      addressVersion: 1,
      locator: "evidence.pdf",
      contentHash: "a".repeat(64),
      revision,
      capturedAt: "2026-09-17T12:00:00.000Z",
      bytesAvailable: true,
      evictedAt: null,
    };
    const representation = {
      id: "pdf-text-representation",
      sourceSnapshotId: snapshot.id,
      mediaType: "text/markdown" as const,
      adapter: { id: "fixture.pdf-text", version: 1 },
      contentHash: "b".repeat(64),
      derivedAt: "2026-09-17T12:00:01.000Z",
      contentAvailable: true,
      evictedAt: null,
    };
    const nativeRepresentation = {
      ...representation,
      id: "pdf-native-representation",
      mediaType: "application/pdf" as const,
      adapter: { id: "builtin.pdf-native", version: 1 },
      contentHash: snapshot.contentHash,
    };
    const description: ResourceDescription = {
      resource,
      source,
      requestedRevision: null,
      capabilities: deriveResourceCapabilityReport(source, true),
      pdf: {
        markdown,
        pages: [{
          page: 1,
          width: 300,
          height: 400,
          start: 0,
          end: markdown.length,
          spans: [{
            start: quoteStart,
            end: markdown.length,
            region: { x: 36, y: 40, width: 120, height: 16 },
          }],
        }],
        sourceSnapshot: snapshot,
        representation,
        nativeRepresentation,
      },
      pdfHistory: {
        sourceSnapshots: [snapshot],
        representations: [representation, nativeRepresentation],
      },
      web: null,
      webHistory: null,
      webStatus: null,
      remoteEntity: null,
      remoteStatus: null,
      availableCommands: [],
    };
    harness.effects.loadTarget = async () => ({ kind: "resource", target, description });
    let refreshes = 0;
    harness.effects.refreshResource = async () => {
      refreshes += 1;
      return description;
    };
    await harness.controller.initialize();
    await harness.controller.onServiceEvent(event("ui", {
      targetClientId: "detail-test",
      command: "open",
      target,
    }), viewport);
    await harness.controller.dispatch({ type: "resource.refresh" }, viewport);
    expect(refreshes).toBe(1);
    expect(harness.controller.state.status).toBe("PDF resource refreshed");

    const bufferBeforeSelection = harness.controller.state.buffer;
    const locksBeforeSelection = [...harness.calls.locks];
    const documentLines = harness.controller.state.resolvedSelectedText.split("\n");
    for (const sourceLine of [markdown.split("\n").length, documentLines.indexOf("## PDF resource")]) {
      expect(sourceLine).toBeGreaterThanOrEqual(markdown.split("\n").length);
      await harness.controller.dispatch({
        type: "annotation.selection.begin",
        sourceLine,
        sourceColumn: 0,
      }, viewport);
      expect(harness.controller.state.mode).toBe("preview");
      expect(harness.controller.state.buffer).toBe(bufferBeforeSelection);
      expect(harness.controller.state.annotationDraft).toBeUndefined();
      expect(harness.calls.locks).toEqual(locksBeforeSelection);
      expect(harness.controller.state.status).toBe(
        "Select PDF text, not resource metadata, before adding annotations",
      );
    }

    await harness.controller.dispatch({
      type: "annotation.selection.begin",
      sourceLine: 2,
      sourceColumn: 0,
    }, viewport);
    await harness.controller.dispatch({
      type: "annotation.selection.place",
      row: 2,
      column: "Stable PDF quote".length,
      extend: true,
    }, viewport);
    await harness.controller.dispatch({ type: "comment.begin" }, viewport);
    expect(harness.controller.state.annotationDraft?.target).toMatchObject({
      representation: {
        id: representation.id,
        sourceSnapshot: { kind: "resource", sourceSnapshotId: snapshot.id },
      },
      anchor: {
        kind: "pdf-page-region",
        page: 1,
        exact: "Stable PDF quote",
        regions: [{ x: 36, y: 40, width: 120, height: 16 }],
      },
    });
  });
  test("ignores a late resource load after a newer mixed-target navigation", async () => {
    const initial = makeBlock({ id: "block-anchor", text: "Anchor" });
    const harness = createHarness(initial);
    await harness.controller.initialize();
    const originalLoadTarget = harness.effects.loadTarget;
    const slowTarget = {
      kind: "resource" as const,
      resourceId: "10000000-0000-4000-8000-000000000001",
    };
    const slow = Promise.withResolvers<DetailReadyDocument>();

    harness.effects.loadTarget = (target) =>
      target.kind === "resource" && target.resourceId === slowTarget.resourceId
        ? slow.promise
        : originalLoadTarget(target);

    const slowNavigation = harness.controller.onServiceEvent(event("ui", {
      targetClientId: "detail-test",
      command: "open",
      target: slowTarget,
    }), viewport);
    await harness.controller.onServiceEvent(event("ui", {
      targetClientId: "detail-test",
      command: "open",
      target: { kind: "block", blockId: "newer-block" },
    }), viewport);
    slow.resolve(await originalLoadTarget(slowTarget));
    await slowNavigation;

    expect(harness.controller.state.document).toMatchObject({
      kind: "ready",
      document: {
        kind: "block",
        target: { blockId: "newer-block" },
      },
    });
  });

  test("retains a failed resource target without invoking block projections", async () => {
    const harness = createHarness(makeBlock({ id: "block-anchor" }));
    await harness.controller.initialize();
    const projectedBefore = harness.calls.projectedReads.length;
    harness.effects.loadTarget = async () => {
      throw new Error("provider offline");
    };
    const target = {
      kind: "resource" as const,
      resourceId: "10000000-0000-4000-8000-000000000009",
    };

    await harness.controller.onServiceEvent(event("ui", {
      targetClientId: "detail-test",
      command: "open",
      target,
    }), viewport);

    expect(harness.controller.state.document).toEqual({
      kind: "failed",
      target,
      message: "provider offline",
    });
    expect(harness.controller.state.target).toEqual(target);
    expect(harness.calls.projectedReads).toHaveLength(projectedBefore);
  });

  test("returns to an unlocked Tree preview after opening its link", async () => {
    const previous = makeBlock({ id: "previous-block", text: "Previous" });
    const previewed = makeBlock({ id: "c021d559-preview", text: "See linked block" });
    const harness = createHarness(previous);
    await harness.controller.initialize();

    harness.setSelection({ selected: previewed, ancestors: [], children: [] });
    await harness.controller.onServiceEvent(
      event("ui", { targetClientId: "detail-test", command: "preview", target: { kind: "block", blockId: previewed.id } }),
      viewport,
    );
    await harness.controller.dispatch({
      type: "reference.open",
      target: { kind: "block", value: "linked-block" },
    }, viewport);
    expect(harness.controller.state.context.selected?.id).toBe(previewed.id);
    await harness.controller.handleDestinationChooserKeypress("", { name: "return" });
    expect(harness.controller.state.context.selected?.id).toBe("linked-block");

    await harness.controller.dispatch({ type: "navigation.back" }, viewport);
    expect(harness.controller.state.context.selected?.id).toBe(previewed.id);
    await harness.controller.dispatch({ type: "navigation.forward" }, viewport);
    expect(harness.controller.state.context.selected?.id).toBe("linked-block");
  });

  test("locks an anchor out of preview updates until explicitly unlocked", async () => {
    const first = makeBlock({ id: "first-block", text: "First" });
    const second = makeBlock({ id: "second-block", text: "Second" });
    const third = makeBlock({ id: "third-block", text: "Third" });
    const harness = createHarness(first);
    await harness.controller.initialize();

    await harness.controller.onServiceEvent(
      event("ui", { targetClientId: "detail-test", command: "preview", target: { kind: "block", blockId: second.id } }),
      viewport,
    );
    expect(harness.controller.state.context.selected?.id).toBe(second.id);
    expect(harness.controller.state.connectionMode).toBe("unlocked");

    await harness.controller.dispatch({ type: "lock.toggle" }, viewport);
    await harness.controller.onServiceEvent(
      event("ui", { targetClientId: "detail-test", command: "preview", target: { kind: "block", blockId: third.id } }),
      viewport,
    );
    expect(harness.controller.state.context.selected?.id).toBe(second.id);
    expect(harness.controller.state.connectionMode).toBe("locked");

    await harness.controller.onServiceEvent(
      event("ui", { targetClientId: "detail-test", command: "open", target: { kind: "block", blockId: third.id } }),
      viewport,
    );
    expect(harness.controller.state.context.selected?.id).toBe(second.id);
    expect(harness.calls.selfFocuses).toBe(0);

    await harness.controller.dispatch({ type: "lock.toggle" }, viewport);
    await harness.controller.onServiceEvent(
      event("ui", { targetClientId: "detail-test", command: "preview", target: { kind: "block", blockId: third.id } }),
      viewport,
    );
    expect(harness.controller.state.context.selected?.id).toBe(third.id);
    expect(harness.controller.state.connectionMode).toBe("unlocked");
    expect(harness.calls.locks).toEqual([true, false]);
  });

  test("routes plain-click links directly to the first unlocked Detail", async () => {
    const source = makeBlock({ id: "plain-source", text: "See ((plain-target#decision))" });
    const harness = createHarness(source);
    await harness.controller.initialize();

    await harness.controller.dispatch({
      type: "reference.open",
      target: { kind: "block", value: "plain-target", fragmentId: "decision" },
      routing: "first-unlocked",
    }, viewport);

    expect(harness.controller.state.destinationChooser.active).toBe(false);
    expect(harness.calls.navigationDispatches).toEqual([{
      blockId: "plain-target",
      intent: "open",
      preserveSource: false,
      fragmentId: "decision",
    }]);
    expect(harness.controller.state.context.selected?.id).toBe("plain-target");
    expect(harness.controller.state.target).toMatchObject({ kind: "block", fragmentId: "decision" });
  });

  test("opens the chooser without replacing a locked anchor when no Detail is available", async () => {
    const source = makeBlock({ id: "locked-source", text: "See ((locked-target))" });
    const harness = createHarness(source);
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "lock.toggle" }, viewport);
    harness.effects.dispatchNavigation = async () => {
      throw new Error(
        "All Details in this tab are locked · unlock one or open another Detail",
      );
    };

    await harness.controller.dispatch({
      type: "reference.open",
      target: { kind: "block", value: "locked-target" },
      routing: "first-unlocked",
    }, viewport);

    expect(harness.controller.state.destinationChooser.active).toBe(true);
    expect(harness.controller.state.context.selected?.id).toBe(source.id);
    expect(harness.controller.state.connectionMode).toBe("locked");
    expect(harness.calls.openedDetails).toEqual([]);
  });
  test("defers chooser routing without navigating an available Detail", async () => {
    const source = makeBlock({ id: "modified-source", text: "See ((modified-target))" });
    const harness = createHarness(source);
    await harness.controller.initialize();

    await harness.controller.dispatch({
      type: "reference.open",
      target: { kind: "block", value: "modified-target" },
      routing: "chooser",
    }, viewport);

    expect(harness.controller.state.destinationChooser.active).toBe(true);
    expect(harness.calls.navigationDispatches).toEqual([]);
    expect(harness.controller.state.context.selected?.id).toBe(source.id);
  });

  test("keeps missing targets and mutable buffers safe on plain-click routing", async () => {
    const editing = createHarness(makeBlock({
      id: "editing-source",
      text: "See ((editing-target))",
    }));
    await editing.controller.initialize();
    await editing.controller.dispatch({ type: "edit.begin" }, viewport);
    await editing.controller.dispatch({
      type: "reference.open",
      target: { kind: "block", value: "editing-target" },
      routing: "first-unlocked",
    }, viewport);
    expect(editing.calls.navigationDispatches).toEqual([]);
    expect(editing.controller.state.destinationChooser.active).toBe(false);
    expect(editing.controller.state.status).toBe(
      "Finish or cancel the active edit before opening another target",
    );

    const missing = createHarness(makeBlock({
      id: "missing-source",
      text: "See ((missing-target))",
    }));
    await missing.controller.initialize();
    missing.effects.resolveReference = async () => {
      throw new Error("No block matches missing-target");
    };
    await expect(missing.controller.dispatch({
      type: "reference.open",
      target: { kind: "block", value: "missing-target" },
      routing: "first-unlocked",
    }, viewport)).rejects.toThrow("No block matches missing-target");
    expect(missing.calls.navigationDispatches).toEqual([]);
    expect(missing.controller.state.context.selected?.id).toBe("missing-source");
  });

  test("keeps a locked Detail unchanged until a destination is confirmed", async () => {
    const source = makeBlock({ id: "source-block", text: "See ((target01))" });
    const harness = createHarness(source);
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "lock.toggle" }, viewport);

    await harness.controller.dispatch({ type: "reference.follow" }, viewport);

    expect(harness.controller.state.context.selected?.id).toBe(source.id);
    expect(harness.controller.state.connectionMode).toBe("locked");
    expect(harness.controller.state.destinationChooser.active).toBe(true);
    expect(harness.calls.navigationDispatches).toEqual([]);
    await harness.controller.handleDestinationChooserKeypress("", { name: "escape" });
    expect(harness.controller.state.context.selected?.id).toBe(source.id);
    expect(harness.controller.state.connectionMode).toBe("locked");
  });

  test("replaces a locked Detail only after explicit Shift+R", async () => {
    const source = makeBlock({ id: "locked-source", text: "See ((target01))" });
    const harness = createHarness(source);
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "lock.toggle" }, viewport);
    await harness.controller.dispatch({ type: "reference.follow" }, viewport);

    expect(harness.controller.state.context.selected?.id).toBe(source.id);
    await harness.controller.handleDestinationChooserKeypress("R", {
      name: "r",
      shift: true,
    });

    expect(harness.controller.state.context.selected?.id).toBe("target01");
    expect(harness.controller.state.connectionMode).toBe("locked");
    expect(harness.calls.navigationDispatches).toEqual([]);
  });

  test("routes explicit split choices without mutating the current Detail", async () => {
    for (const [input, direction] of [
      ["r", "right"],
      ["d", "down"],
    ] as const) {
      const source = makeBlock({ id: `source-${direction}`, text: "See ((target01))" });
      const harness = createHarness(source);
      await harness.controller.initialize();
      await harness.controller.dispatch({ type: "reference.follow" }, viewport);
      await harness.controller.handleDestinationChooserKeypress(input, { name: input });

      expect(harness.calls.openedDetails).toEqual([{ blockId: "target01", direction }]);
      expect(harness.controller.state.context.selected?.id).toBe(source.id);
      expect(harness.controller.state.destinationChooser.active).toBe(false);
    }
  });
  test("uses configured directional bindings in the Detail destination chooser", async () => {
    const actionKeymap = new OutlinerActionKeymap("<test>", {
      "detail.pane.right": ["Shift+ArrowRight"],
      "detail.pane.below": ["Shift+ArrowDown"],
    });
    for (const [keyName, direction] of [
      ["right", "right"],
      ["down", "down"],
    ] as const) {
      const source = makeBlock({ id: `source-${direction}`, text: "See ((target01))" });
      const harness = createHarness(source);
      const controller = createDetailController(harness.effects, undefined, { actionKeymap });
      await controller.initialize();
      await controller.dispatch({ type: "reference.follow" }, viewport);
      await controller.handleDestinationChooserKeypress("", {
        name: keyName,
        shift: true,
      });

      expect(harness.calls.openedDetails).toEqual([{ blockId: "target01", direction }]);
      expect(controller.state.context.selected?.id).toBe(source.id);
      expect(controller.state.destinationChooser.active).toBe(false);
    }
  });


  test("preserves fragment identity in explicit and fallback splits", async () => {
    const source = makeBlock({ text: "See ((target01^decision))" });

    const explicit = createHarness(source);
    await explicit.controller.initialize();
    await explicit.controller.dispatch({ type: "reference.follow" }, viewport);
    await explicit.controller.handleDestinationChooserKeypress("d", { name: "d" });
    expect(explicit.calls.openedDetails).toEqual([{
      blockId: "target01",
      direction: "down",
      fragmentId: "decision",
    }]);

    const fallback = createHarness(source);
    fallback.effects.dispatchNavigation = async () => {
      throw new Error("All Details in this tab are locked · unlock one or open another Detail");
    };
    await fallback.controller.initialize();
    await fallback.controller.dispatch({ type: "reference.follow" }, viewport);
    await fallback.controller.handleDestinationChooserKeypress("", { name: "return" });
    expect(fallback.calls.openedDetails).toEqual([{
      blockId: "target01",
      direction: "right",
      fragmentId: "decision",
    }]);
  });

  test("applies a split Detail's startup fragment once", async () => {
    const target = makeBlock({
      id: "target01",
      text: "Target\n\n## Decision ^decision\nBody",
    });
    const harness = createHarness(
      target,
      null,
      undefined,
      undefined,
      { initialTarget: { kind: "block", blockId: target.id, fragmentId: "decision" } },
    );

    await harness.controller.initialize();

    expect(harness.controller.state.target).toMatchObject({ kind: "block", fragmentId: "decision" });
    expect(harness.controller.state.previewOffset).toBe(2);
  });

  test("keeps explicit first-unlocked choice available after all Details reject it", async () => {
    const source = makeBlock({ text: "See ((target01))" });
    const harness = createHarness(source);
    harness.effects.dispatchNavigation = async () => {
      throw new Error("All Details in this tab are locked · unlock one or open another Detail");
    };
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "reference.follow" }, viewport);
    await harness.controller.handleDestinationChooserKeypress("f", { name: "f" });

    expect(harness.controller.state.destinationChooser.active).toBe(true);
    expect(harness.controller.state.destinationChooser.status).toContain(
      "No unlocked Detail is available",
    );
    expect(harness.calls.openedDetails).toEqual([]);
    expect(harness.controller.state.context.selected?.id).toBe(source.id);
  });

  test("dismisses a pending destination choice on timeout and target change", async () => {
    let dismissOnIdle = () => {};
    const source = makeBlock({ id: "source-block", text: "See ((target01))" });
    const harness = createHarness(
      source,
      null,
      undefined,
      undefined,
      {
        destinationTimeoutMs: 1_000,
        destinationScheduler: {
          set(callback) {
            dismissOnIdle = callback;
            return callback;
          },
          clear() {},
        },
      },
    );
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "reference.follow" }, viewport);
    dismissOnIdle();
    expect(harness.controller.state.destinationChooser.active).toBe(false);
    expect(harness.calls.navigationDispatches).toEqual([]);
    expect(harness.calls.followedReferences).toEqual([]);

    await harness.controller.dispatch({ type: "reference.follow" }, viewport);
    harness.setSelection({
      selected: makeBlock({ id: "other-target", text: "Other" }),
      ancestors: [],
      children: [],
    });
    await harness.controller.onServiceEvent(
      event("ui", { targetClientId: "detail-test", command: "preview", target: { kind: "block", blockId: "other-target" },  }),
      viewport,
    );
    expect(harness.controller.state.destinationChooser.active).toBe(false);
    expect(harness.calls.followedReferences).toEqual([]);
  });

  test("disposes a pending choice when only the current fragment changes", async () => {
    const source = makeBlock({
      id: "source-block",
      text: "## First ^first\nSee ((target01))\n## Second ^second",
    });
    const harness = createHarness(
      source,
      null,
      undefined,
      undefined,
      { initialTarget: { kind: "block", blockId: source.id, fragmentId: "first" } },
    );
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "reference.follow" }, viewport);
    expect(harness.controller.state.destinationChooser.active).toBe(true);

    await harness.controller.onServiceEvent(
      event("ui", {
        targetClientId: "detail-test",
        command: "replace",
        target: { kind: "block", blockId: source.id, fragmentId: "second" },
      }),
      viewport,
    );

    expect(harness.controller.state.target).toMatchObject({ kind: "block", fragmentId: "second" });
    expect(harness.controller.state.destinationChooser.active).toBe(false);
    expect(harness.calls.followedReferences).toEqual([]);
  });

  test("follows symbolic references through the page-address path", async () => {
    const harness = createHarness(makeBlock({ text: "See [[Future Page]]" }));
    await harness.controller.initialize();

    await harness.controller.dispatch({ type: "reference.follow" }, viewport);

    expect(harness.calls.followedReferences).toEqual([]);
    await harness.controller.handleDestinationChooserKeypress("f", { name: "f" });
    expect(harness.calls.followedReferences).toEqual([{
      kind: "page",
      value: "Future Page",
    }]);
  });

  test("follows bare Work IDs for the configured project prefix", async () => {
    const harness = createHarness(
      makeBlock({ text: "See ABC-001 and PIE-001" }),
      null,
      async (text) => ({ text, references: [], workIdPrefix: "ABC" }),
    );
    await harness.controller.initialize();

    await harness.controller.dispatch({ type: "reference.follow" }, viewport);

    expect(harness.controller.state.workIdPrefix).toBe("ABC");
    expect(harness.calls.followedReferences).toEqual([]);
    await harness.controller.handleDestinationChooserKeypress("f", { name: "f" });
    expect(harness.calls.followedReferences).toEqual([{
      kind: "work",
      value: "ABC-001",
    }]);
  });

  test("defaults ordinary file blocks to file mode and other blocks to preview", async () => {
    const fileHarness = createHarness(
      makeBlock({ properties: [{ key: "file", value: "src/example.ts" }] }),
      filePreview(),
    );
    const previewHarness = createHarness(makeBlock());

    await fileHarness.controller.initialize();
    await previewHarness.controller.initialize();

    expect(fileHarness.controller.state.mode).toBe("file");
    expect(previewHarness.controller.state.mode).toBe("preview");
  });

  test("navigates every line introduced by resolved references", async () => {
    const resolvedLines = ["Reference", "expanded line one", "expanded line two", "expanded line three"];
    const harness = createHarness(
      makeBlock({ text: "((reference))" }),
      null,
      async () => ({ text: resolvedLines.join("\n"), references: [] }),
    );
    await harness.controller.initialize();

    expect(harness.controller.state.context.selected?.text.split(/\r?\n/)).toHaveLength(1);
    for (let line = 1; line < resolvedLines.length; line += 1) {
      await harness.controller.dispatch({ type: "preview.navigate", direction: "down" }, viewport);
      expect(harness.controller.state.previewOffset).toBe(line);
    }
  });

  test("jumps preview navigation to semantic top and bottom boundaries", async () => {
    const harness = createHarness(
      makeBlock({ text: "one\ntwo\nthree\nfour" }),
      null,
      async (text) => ({ text, references: [] }),
    );
    await harness.controller.initialize();

    await harness.controller.dispatch({ type: "preview.navigate", direction: "bottom" }, viewport);
    expect(harness.controller.state.previewOffset).toBe(3);
    await harness.controller.dispatch({ type: "preview.navigate", direction: "top" }, viewport);
    expect(harness.controller.state.previewOffset).toBe(0);
  });

  test("defers content and detail UI commands while editing, then refreshes after cancel", async () => {
    const harness = createHarness(makeBlock());
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "edit.begin" }, viewport);
    await harness.controller.dispatch({ type: "buffer.insert", text: "!" }, viewport);
    const protectedText = harness.controller.state.buffer.text;
    const selectionLoads = harness.calls.selections;

    await harness.controller.onServiceEvent(event("content"), viewport);
    await harness.controller.onServiceEvent(
      event("ui", { targetClientId: "detail-test", command: "edit", target: { kind: "block", blockId: "other-block" } }),
      viewport,
    );

    expect(harness.controller.state.refreshPending).toBe(true);
    expect(harness.controller.state.buffer.text).toBe(protectedText);
    expect(harness.calls.selections).toBe(selectionLoads);
    expect(harness.calls.setSelections).toEqual([]);

    await harness.controller.dispatch({ type: "buffer.cancel" }, viewport);
    expect(harness.controller.state.mode).toBe("preview");
    await harness.controller.refreshPendingSelection();
    expect(harness.calls.selections).toBe(selectionLoads + 1);
    expect(harness.controller.state.refreshPending).toBe(false);
    expect(harness.controller.state.context.selected?.id).toBe("other-block");
    expect(harness.controller.state.connectionMode).toBe("locked");
  });

  test("connect marks a comment buffer pending without replacing it", async () => {
    const block = makeBlock({ properties: [{ key: "file", value: "src/example.ts" }] });
    const harness = createHarness(block, filePreview());
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "comment.begin" }, viewport);
    await harness.controller.dispatch({ type: "buffer.insert", text: "keep me" }, viewport);
    const loads = harness.calls.selections;

    await harness.controller.onServiceConnect(viewport);

    expect(harness.controller.state.mode).toBe("comment");
    expect(harness.controller.state.buffer.text).toBe("keep me");
    expect(harness.controller.state.refreshPending).toBe(true);
    expect(harness.calls.selections).toBe(loads);
    expect(harness.calls.currentBlocks).toEqual([block.id]);
  });
  test("keeps disclosure overrides on refresh but clears them for an exact target change", async () => {
    const harness = createHarness(makeBlock());
    const region = {
      id: "annotation:block-1:0",
      kind: "annotation" as const,
      sourceSpan: null,
      parentId: null,
      childIds: [],
      focusable: true,
      disclosure: { defaultExpanded: false, expanded: false },
      activation: {
        type: "annotation.disclosure.toggle" as const,
        regionId: "annotation:block-1:0",
      },
    };
    await harness.controller.initialize();
    harness.controller.setPreviewRegions([region]);
    await harness.controller.dispatch({
      type: "preview.action",
      action: region.activation,
    }, viewport);
    expect(harness.controller.state.previewRegions.disclosureOverrides.get(region.id))
      .toBe(true);

    await harness.controller.onServiceEvent(
      event("ui", { targetClientId: "detail-test", command: "preview", target: { kind: "block", blockId: "other-block" },  }),
      viewport,
    );
    expect(harness.controller.state.target).toEqual({ kind: "block", blockId: "other-block" });
    expect(harness.controller.state.previewRegions.disclosureOverrides.size).toBe(0);

    harness.controller.setPreviewRegions([region]);
    await harness.controller.dispatch({
      type: "preview.action",
      action: region.activation,
    }, viewport);
    await harness.controller.onServiceEvent(event("content"), viewport);
    harness.controller.setPreviewRegions([region]);
    expect(harness.controller.state.previewRegions.disclosureOverrides.get(region.id))
      .toBe(true);
    expect(harness.controller.state.previewRegions.regions[0]!.disclosure?.expanded)
      .toBe(true);
  });

});

describe("detail controller saves and annotations", () => {
  test("sends the raw buffer with the selected optimistic version", async () => {
    const harness = createHarness(makeBlock({ text: "raw", updatedAt: "original-version" }));
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "edit.begin" }, viewport);
    await harness.controller.dispatch({ type: "buffer.insert", text: " changed" }, viewport);
    await harness.controller.dispatch({ type: "buffer.save" }, viewport);

    expect(harness.calls.updates).toEqual([
      { blockId: "block-1", text: "raw changed", expectedUpdatedAt: "original-version" },
    ]);
    expect(harness.controller.state.context.selected?.updatedAt).toBe("version-2");
    expect(harness.controller.state.resolvedSelectedText).toBe("resolved:raw changed");
    expect(harness.controller.state.mode).toBe("preview");
  });

  test("starts a canonical draft and imports an empty external edit without saving", async () => {
    const harness = createHarness(makeBlock({
      text: "canonical",
      updatedAt: "original-version",
    }));
    harness.setExternalEdit(async (input) => {
      expect(input).toEqual({
        blockId: "block-1",
        text: "canonical",
        expectedUpdatedAt: "original-version",
      });
      return { text: "", changed: true, recoveryPath: "/tmp/empty-draft", cleanup() {} };
    });
    await harness.controller.initialize();

    await harness.controller.dispatch({ type: "edit.external" }, viewport);

    expect(harness.controller.state.mode).toBe("edit");
    expect(harness.controller.state.buffer.text).toBe("");
    expect(harness.calls.locks).toContain(true);
    expect(harness.calls.updates).toEqual([]);
    await harness.controller.dispatch({ type: "buffer.cancel" }, viewport);
    expect(harness.controller.state.context.selected?.text).toBe("canonical");
    expect(harness.calls.updates).toEqual([]);
  });

  test("round-trips the exact unsaved draft as one undoable edit before optimistic save", async () => {
    const harness = createHarness(makeBlock({
      text: "canonical",
      updatedAt: "original-version",
    }));
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "edit.begin" }, viewport);
    await harness.controller.dispatch({ type: "buffer.select-all" }, viewport);
    await harness.controller.dispatch({
      type: "buffer.insert",
      text: "unsaved draft\nline two",
    }, viewport);
    harness.controller.state.buffer.placeCursor(0, 2);
    harness.controller.state.buffer.placeCursor(1, 4, true);
    const priorSelection = harness.controller.state.buffer.selectionRange;
    let cleanedExternalDraft = false;
    harness.setExternalEdit(async (input) => {
      expect(input.text).toBe("unsaved draft\nline two");
      return {
        text: "editor draft\nwith several\nchanged lines",
        changed: true,
        recoveryPath: "/tmp/changed-draft",
        cleanup() {
          expect(harness.controller.state.buffer.text).toBe(
            "editor draft\nwith several\nchanged lines",
          );
          cleanedExternalDraft = true;
        },
      };
    });

    await harness.controller.dispatch({ type: "edit.external" }, viewport);
    expect(harness.controller.state.buffer.text).toBe(
      "editor draft\nwith several\nchanged lines",
    );
    expect(cleanedExternalDraft).toBe(true);
    await harness.controller.dispatch({ type: "buffer.undo" }, viewport);
    expect(harness.controller.state.buffer.text).toBe("unsaved draft\nline two");
    expect(harness.controller.state.buffer.selectionRange).toEqual(priorSelection);
    await harness.controller.dispatch({ type: "buffer.redo" }, viewport);
    await harness.controller.dispatch({ type: "buffer.save" }, viewport);
    expect(harness.calls.updates).toEqual([{
      blockId: "block-1",
      text: "editor draft\nwith several\nchanged lines",
      expectedUpdatedAt: "original-version",
    }]);
  });

  test("treats an unchanged external file as a no-op", async () => {
    const harness = createHarness(makeBlock({ text: "unchanged" }));
    await harness.controller.initialize();

    await harness.controller.dispatch({ type: "edit.external" }, viewport);
    await harness.controller.dispatch({ type: "buffer.undo" }, viewport);

    expect(harness.controller.state.buffer.text).toBe("unchanged");
    expect(harness.controller.state.status).toBe("Nothing to undo");
  });

  test("treats an equivalent returned draft as unchanged and cleans its recovery file", async () => {
    const harness = createHarness(makeBlock({ text: "canonical" }));
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "edit.begin" }, viewport);
    await harness.controller.dispatch({
      type: "buffer.insert",
      text: "\nunsaved",
    }, viewport);
    let cleaned = false;
    harness.setExternalEdit(async (input) => ({
      text: input.text,
      changed: true,
      recoveryPath: "/tmp/equivalent-draft",
      cleanup() {
        cleaned = true;
      },
    }));

    await harness.controller.dispatch({ type: "edit.external" }, viewport);

    expect(harness.controller.state.buffer.text).toBe("canonical\nunsaved");
    expect(harness.controller.state.status).toBe("$EDITOR returned an unchanged draft");
    expect(harness.controller.state.busy).toBe(false);
    expect(cleaned).toBe(true);
    expect(harness.calls.updates).toEqual([]);
    await harness.controller.dispatch({ type: "buffer.undo" }, viewport);
    expect(harness.controller.state.buffer.text).toBe("canonical");
    await harness.controller.dispatch({ type: "buffer.undo" }, viewport);
    expect(harness.controller.state.status).toBe("Nothing to undo");
  });

  test("keeps the exact draft after a recoverable external editor failure", async () => {
    const harness = createHarness(makeBlock({ text: "canonical" }));
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "edit.begin" }, viewport);
    await harness.controller.dispatch({ type: "buffer.insert", text: " unsaved" }, viewport);
    harness.setExternalEdit(async () => {
      throw new Error(
        "editor exited with status 2. Recoverable editor file: /tmp/recovery/draft.md",
      );
    });

    await harness.controller.dispatch({ type: "edit.external" }, viewport);

    expect(harness.controller.state.mode).toBe("edit");
    expect(harness.controller.state.buffer.text).toBe("canonical unsaved");
    expect(harness.controller.state.status).toContain("/tmp/recovery/draft.md");
    expect(harness.calls.updates).toEqual([]);
  });

  test("never serializes generated backlink projection content", async () => {
    const harness = createHarness(makeBlock({ text: "raw", updatedAt: "original-version" }));
    harness.setBacklinkResults([{
      targetBlockId: "block-1",
      sources: [{
        blockId: "source-block",
        title: "Generated backlink",
        parentContext: "Top level",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        occurrenceCount: 1,
        referenceGroups: [{ kind: "block", count: 1 }],
        occurrences: [{
          kind: "block",
          label: "((block-1))",
          snippet: "Generated backlink snippet",
          start: 0,
          end: 11,
        }],
        occurrencesTruncated: false,
      }],
      completeness: { kind: "complete" },
    }]);
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "backlinks.toggle" }, viewport);
    await harness.controller.dispatch({ type: "edit.begin" }, viewport);
    await harness.controller.dispatch({ type: "buffer.insert", text: " changed" }, viewport);
    await harness.controller.dispatch({ type: "buffer.save" }, viewport);

    expect(harness.calls.updates).toEqual([
      { blockId: "block-1", text: "raw changed", expectedUpdatedAt: "original-version" },
    ]);
  });

  test("replaces a motion-selected range before an optimistic save", async () => {
    const harness = createHarness(makeBlock({
      text: "alpha beta",
      updatedAt: "original-version",
    }));
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "edit.begin" }, viewport);
    await harness.controller.dispatch(
      { type: "buffer.move", direction: "word-left" },
      viewport,
    );
    await harness.controller.dispatch(
      { type: "buffer.move", direction: "home", extend: true },
      viewport,
    );

    expect(harness.controller.state.buffer.selectionRange).toEqual({
      start: { row: 0, column: 0 },
      end: { row: 0, column: 6 },
    });

    await harness.controller.dispatch({ type: "buffer.insert", text: "A " }, viewport);
    await harness.controller.dispatch({ type: "buffer.save" }, viewport);
    expect(harness.calls.updates).toEqual([
      { blockId: "block-1", text: "A beta", expectedUpdatedAt: "original-version" },
    ]);
  });

  test("consumes a pending refresh after a successful optimistic save", async () => {
    const harness = createHarness(makeBlock({ text: "draft" }));
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "edit.begin" }, viewport);
    await harness.controller.dispatch({ type: "buffer.insert", text: "!" }, viewport);
    harness.setSelection({
      selected: makeBlock({ text: "draft!", updatedAt: "version-2" }),
      ancestors: [],
      children: [],
    });
    await harness.controller.onServiceEvent(event("content"), viewport);

    await harness.controller.dispatch({ type: "buffer.save" }, viewport);

    expect(harness.controller.state.refreshPending).toBe(false);
    expect(harness.controller.state.context.selected?.updatedAt).toBe("version-2");
  });

  test("keeps the editable buffer and pending refresh on an optimistic conflict", async () => {
    const harness = createHarness(makeBlock({ text: "draft" }));
    harness.setUpdate(async () => {
      throw new Error("Block changed since it was loaded");
    });
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "edit.begin" }, viewport);
    await harness.controller.onServiceEvent(event("content"), viewport);
    await harness.controller.dispatch({ type: "buffer.insert", text: "!" }, viewport);
    await harness.controller.dispatch({ type: "buffer.save" }, viewport);

    expect(harness.controller.state.mode).toBe("edit");
    expect(harness.controller.state.buffer.text).toBe("draft!");
    expect(harness.controller.state.refreshPending).toBe(true);
    expect(harness.controller.state.status).toBe("Block changed since it was loaded");
  });

  test("serializes a normalized reversed file range into a child annotation", async () => {
    const block = makeBlock({ properties: [{ key: "file", value: "src/example.ts" }] });
    const harness = createHarness(block, filePreview());
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "file.navigate", direction: "end" }, viewport);
    await harness.controller.dispatch({ type: "file.selection.toggle" }, viewport);
    await harness.controller.dispatch({ type: "file.navigate", direction: "home" }, viewport);
    await harness.controller.dispatch({ type: "comment.begin" }, viewport);
    await harness.controller.dispatch({ type: "buffer.insert", text: "  Explain this range.  " }, viewport);
    await harness.controller.dispatch({ type: "buffer.save" }, viewport);

    expect(harness.calls.creates).toHaveLength(1);
    expect(harness.calls.creates[0].input.target).toMatchObject({
      representation: {
        subject: {
          kind: "resource",
          resourceId: "30000000-0000-4000-8000-000000000001",
        },
        sourceSnapshot: { kind: "resource" },
      },
      anchor: { kind: "text-quote", start: 0, exact: "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight" },
    });
    expect(harness.calls.creates[0].input.body).toBe("Explain this range.");
    expect(harness.calls.creates[0].input.source).toBe("user");
    expect(harness.controller.state.mode).toBe("file");
    expect(harness.controller.state.selectionAnchor).toBeNull();
    expect(harness.controller.state.status).toBe("Annotation added for lines 10-17");
  });

  test("uses file evidence rather than host block versions for filesystem representations", async () => {
    const first = createHarness(
      makeBlock({
        id: "file-host-1",
        updatedAt: "host-version-1",
        properties: [{ key: "file", value: "src/example.ts" }],
      }),
      filePreview(),
    );
    const second = createHarness(
      makeBlock({
        id: "file-host-2",
        updatedAt: "host-version-2",
        properties: [{ key: "file", value: "src/example.ts" }],
      }),
      filePreview(),
    );
    for (const harness of [first, second]) {
      await harness.controller.initialize();
      await harness.controller.dispatch({ type: "comment.begin" }, viewport);
    }
    expect(first.calls.filesystemInterns).toContain("/workspace/src/example.ts");
    expect(second.calls.filesystemInterns).toContain("/workspace/src/example.ts");

    expect(first.controller.state.annotationDraft?.target.representation).toEqual(
      second.controller.state.annotationDraft?.target.representation,
    );
    expect(first.controller.state.annotationDraft?.target.representation.sourceSnapshot)
      .toMatchObject({
        kind: "resource",
        revision: {
          revision: {
            kind: "filesystem",
            mtimeNs: "1770000000000000000",
            size: "39",
          },
        },
      });
  });


  test("opens and reveals filesystem annotations through Resource content", async () => {
    const file = filePreview();
    const harness = createHarness(
      makeBlock({ properties: [{ key: "file", value: file.sourcePath }] }),
      file,
    );
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "comment.begin" }, viewport);
    await harness.controller.dispatch({ type: "buffer.insert", text: "Inspect this line" }, viewport);
    await harness.controller.dispatch({ type: "buffer.save" }, viewport);
    Object.assign(harness.controller.state as unknown as { connectionMode: "unlocked" }, {
      connectionMode: "unlocked",
    });
    const annotation = harness.controller.state.annotationThreads[0]!;
    const annotationId = annotation.block.id;
    const resourceId = "30000000-0000-4000-8000-000000000001";
    const source = {
      id: "20000000-0000-4000-8000-000000000001",
      name: "Test files",
      provider: "filesystem" as const,
      boundary: { kind: "filesystem" as const, root: "/workspace" },
      policy: { deniedCapabilities: [] },
      version: 1,
      createdAt: "created",
      updatedAt: "updated",
    };
    const resource = {
      id: resourceId,
      sourceId: source.id,
      provider: "filesystem" as const,
      address: { kind: "filesystem" as const, path: file.sourcePath },
      version: 1,
      addressVersion: 1,
      mediaType: "text/plain",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const revision = {
      resourceId,
      addressVersion: 1,
      revision: {
        kind: "filesystem" as const,
        mtimeNs: "1770000000000000000",
        size: "39",
      },
    };
    const content = file.lines.join("\n");
    const description: ResourceDescription = {
      resource,
      source,
      requestedRevision: null,
      capabilities: deriveResourceCapabilityReport(source, true, ["read"]),
      filesystem: {
        text: content,
        contentHash: file.sourceHash!,
        capturedAt: file.capturedAt!,
        revision,
      },
      web: null,
      webHistory: null,
      webStatus: null,
      remoteEntity: null,
      remoteStatus: null,
      availableCommands: [],
    };
    const target = { kind: "resource" as const, resourceId };
    const unrelatedFile = filePreview({
      absolutePath: "/workspace/other.ts",
      displayPath: "other.ts",
      sourcePath: "other.ts",
    });
    harness.effects.readFile = () => unrelatedFile;
    const internFilesystem = harness.effects.internFilesystem;
    harness.effects.internFilesystem = async (path) => {
      const receipt = await internFilesystem(path);
      if (path === unrelatedFile.absolutePath && receipt.resource.provider === "filesystem") {
        return {
          ...receipt,
          resource: {
            ...receipt.resource,
            id: "30000000-0000-4000-8000-000000000099",
            address: { kind: "filesystem", path: unrelatedFile.sourcePath },
          },
        };
      }
      return receipt;
    };
    harness.effects.loadTarget = async (candidate) => candidate.kind === "resource"
      ? { kind: "resource", target, description }
      : {
          kind: "block",
          target: candidate,
          context: {
            selected: {
              ...annotation.block,
              properties: [{ key: "type", value: "annotation" }],
            },
            ancestors: [
              makeBlock({
                id: "unrelated-file-host",
                properties: [{ key: "file", value: unrelatedFile.sourcePath }],
              }),
            ],
            children: [],
          },
        };

    await harness.controller.onServiceEvent(event("ui", {
      targetClientId: "detail-test",
      command: "open",
      target: { kind: "block", blockId: annotationId },
    }), viewport);
    expect(harness.controller.state.referencedFile?.absolutePath).toBe(unrelatedFile.absolutePath);
    await harness.controller.dispatch({ type: "annotation.reveal" }, viewport);
    expect(harness.controller.state.resolvedSelectedText).toBe(content);
    expect(harness.controller.state.context.selected).toBeNull();
    expect(harness.controller.state.status).toBe("Revealed resolved text quote 0-3");
    expect(harness.controller.state.previewOffset).toBe(0);
  });
  test("selects an exact block source range and opens a local comment composer", async () => {
    const harness = createHarness(makeBlock({ text: "alpha 🧭 beta\nsecond" }));
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "annotation.selection.begin" }, viewport);
    expect(harness.controller.state.mode).toBe("select");
    expect(harness.calls.locks.at(-1)).toBe(true);

    for (let index = 0; index < 7; index += 1) {
      await harness.controller.dispatch({
        type: "buffer.move",
        direction: "right",
        extend: true,
      }, viewport);
    }
    expect(harness.controller.state.buffer.selectedText).toBe("alpha 🧭");
    await harness.controller.dispatch({ type: "comment.begin" }, viewport);
    expect(harness.controller.state.mode).toBe("comment");
    expect(harness.controller.state.annotationDraft?.target).toMatchObject({
      representation: {
        subject: { kind: "block", blockId: "block-1" },
        sourceSnapshot: { kind: "block" },
      },
      anchor: { kind: "text-quote", start: 0, end: 8, exact: "alpha 🧭" },
    });

    await harness.controller.dispatch({ type: "buffer.insert", text: "Keep this bearing." }, viewport);
    await harness.controller.dispatch({ type: "buffer.save" }, viewport);
    expect(harness.calls.creates).toHaveLength(1);
    expect(harness.calls.creates[0].input.body).toBe("Keep this bearing.");
    expect(harness.controller.state.mode).toBe("preview");
    expect(harness.controller.state.status).toBe("Annotation added for source range 0-8");
  });

  test("opens a contextual composer directly from an exact rendered range", async () => {
    const excerpt =
      "1. Open the block in **Detail**.\n2. Press **`v`** to enter read-only source selec";
    const text = `${"x".repeat(141)}${excerpt} trailing`;
    const harness = createHarness(makeBlock({ text }));
    await harness.controller.initialize();

    await harness.controller.dispatch({
      type: "comment.begin",
      sourceRange: { start: 141, end: 222 },
    }, viewport);

    expect(harness.controller.state.mode).toBe("comment");
    expect(harness.controller.state.context.selected?.id).toBe("block-1");
    expect(harness.controller.state.annotationDraft?.target).toMatchObject({
      representation: {
        subject: { kind: "block", blockId: "block-1" },
        sourceSnapshot: { kind: "block" },
      },
      anchor: { kind: "text-quote", start: 141, end: 222, exact: excerpt },
    });

    await harness.controller.dispatch({
      type: "buffer.insert",
      text: "Keep the reader and selection visible.",
    }, viewport);
    await harness.controller.dispatch({ type: "buffer.save" }, viewport);

    expect(harness.controller.state.mode).toBe("preview");
    expect(harness.controller.state.context.selected?.id).toBe("block-1");
    expect(harness.calls.creates[0].input.target).toMatchObject({
      representation: {
        subject: { kind: "block", blockId: "block-1" },
      },
      anchor: { kind: "text-quote", start: 141, end: 222, exact: excerpt },
    });
  });

  test("opens the composer from one revision-validated native canonical selection", async () => {
    const block = makeBlock({ text: "alpha βeta gamma" });
    const harness = createHarness(
      block,
      null,
      async (text) => ({ text, references: [] }),
    );
    await harness.controller.initialize();
    const capture = {
      quote: "βeta",
      capturedAt: "2026-01-02T03:04:05.000Z",
      hostBlockId: block.id,
      paneId: "w1:p2",
      contentRevision: 42,
      contextId: "context-test",
      detailClientId: "detail-test",
      validation: "herdr-keybinding" as const,
      snapshotText: "Block Detail\n\nalpha βeta gamma",
    };
    const event = {
      id: "native-comment",
      domain: "ui" as const,
      action: "ui.command.send",
      sequence: 1,
      command: {
        targetClientId: "detail-test",
        command: "comment.selection" as const,
        renderedSelection: capture,
      },
    };

    await harness.controller.onServiceEvent(event, viewport);
    expect(harness.controller.state.mode).toBe("comment");
    expect(harness.controller.state.annotationDraft?.target).toMatchObject({
      representation: {
        subject: { kind: "block", blockId: block.id },
        sourceSnapshot: {
          kind: "rendered",
          observation: { quote: "βeta", contentRevision: 42, projection: "canonical" },
        },
      },
      anchor: { kind: "text-quote", exact: "βeta" },
    });
    await harness.controller.dispatch({ type: "buffer.cancel" }, viewport);
    expect(harness.calls.creates).toEqual([]);

    await harness.controller.onServiceEvent({ ...event, sequence: 2 }, viewport);
    await harness.controller.dispatch({ type: "buffer.insert", text: "Keep this quote." }, viewport);
    await harness.controller.dispatch({ type: "buffer.save" }, viewport);
    expect(harness.calls.creates[0]!.input.target).toMatchObject({
      representation: {
        sourceSnapshot: {
          kind: "rendered",
          observation: { quote: "βeta", contentRevision: 42 },
        },
      },
      anchor: { kind: "text-quote", exact: "βeta" },
    });
  });
  test("does not invent a source anchor when chrome duplicates the rendered quote", async () => {
    const block = makeBlock({ text: "alpha βeta gamma" });
    const harness = createHarness(
      block,
      null,
      async (text) => ({ text, references: [] }),
    );
    await harness.controller.initialize();

    expect(renderedSelectionAnnotationTarget(harness.controller.state, {
      quote: "βeta",
      capturedAt: "2026-01-02T03:04:05.000Z",
      hostBlockId: block.id,
      paneId: "w1:p2",
      contentRevision: 42,
      contextId: "context-test",
      detailClientId: "detail-test",
      validation: "herdr-keybinding",
      snapshotText: "βeta appears in chrome\nalpha βeta gamma",
    })).toMatchObject({
      representation: {
        subject: { kind: "block", blockId: block.id },
        sourceSnapshot: {
          kind: "rendered",
          observation: { quote: "βeta", projection: "canonical" },
        },
      },
      anchor: {
        kind: "text-quote",
        start: null,
        end: null,
        exact: "βeta",
      },
    });
  });


  test("stores a hub result as observed passage provenance without a source range", async () => {
    const block = makeBlock({ text: "Roadmap Hub\n!((next-items))" });
    const rendered = "Roadmap Hub\nPIE-300 — Rendered title\nQuery result body";
    const harness = createHarness(
      block,
      null,
      async (text) => ({ text, references: [] }),
      async () => ({
        text: rendered,
        embeds: [{ blockId: "next-items", status: "ready", count: 2 }],
        embedRanges: [{ startLine: 1, endLine: 2 }],
      }),
    );
    await harness.controller.initialize();
    const quote = "PIE-300 — Rendered title\nQuery result body";

    await harness.controller.onServiceEvent({
      id: "hub-native-comment",
      domain: "ui",
      action: "ui.command.send",
      sequence: 1,
      command: {
        targetClientId: "detail-test",
        command: "comment.selection",
        renderedSelection: {
          quote,
          capturedAt: "2026-01-02T03:04:05.000Z",
          hostBlockId: block.id,
          paneId: "w1:p2",
          contentRevision: 84,
          contextId: "context-test",
          detailClientId: "detail-test",
          validation: "herdr-keybinding",
          snapshotText: `Block Detail\n\n${rendered}`,
        },
      },
    }, viewport);

    expect(harness.controller.state.annotationDraft?.target).toMatchObject({
      representation: {
        subject: { kind: "block", blockId: block.id },
        sourceSnapshot: {
          kind: "rendered",
          observation: {
            quote,
            contentRevision: 84,
            projection: "generated",
          },
        },
      },
      anchor: { kind: "text-quote", exact: quote },
    });
    await harness.controller.dispatch({ type: "buffer.insert", text: "Discuss this result." }, viewport);
    await harness.controller.dispatch({ type: "buffer.save" }, viewport);
    expect(harness.calls.creates[0]!.input.target).toMatchObject({
      representation: {
        sourceSnapshot: {
          kind: "rendered",
          observation: { quote, projection: "generated" },
        },
      },
      anchor: { kind: "text-quote", exact: quote },
    });
  });

  test("rejects an empty annotation without leaving comment mode", async () => {
    const block = makeBlock({ properties: [{ key: "file", value: "src/example.ts" }] });
    const harness = createHarness(block, filePreview());
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "comment.begin" }, viewport);
    await harness.controller.dispatch({ type: "buffer.save" }, viewport);

    expect(harness.calls.creates).toEqual([]);
    expect(harness.controller.state.mode).toBe("comment");
    expect(harness.controller.state.status).toBe("Annotation body cannot be empty");
  });
});

describe("detail controller undo and redo", () => {
  test("restores edit groups and resets history across cancel boundaries", async () => {
    const harness = createHarness(makeBlock({ text: "base" }));
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "edit.begin" }, viewport);
    await harness.controller.dispatch({ type: "buffer.insert", text: " one" }, viewport);
    await harness.controller.dispatch({ type: "buffer.insert", text: "!" }, viewport);
    expect(harness.controller.state.buffer.text).toBe("base one!");

    await harness.controller.dispatch({ type: "buffer.undo" }, viewport);
    expect(harness.controller.state.buffer.text).toBe("base one");
    expect(harness.controller.state.status).toBe("Undo");
    await harness.controller.dispatch({ type: "buffer.undo" }, viewport);
    expect(harness.controller.state.buffer.text).toBe("base");

    await harness.controller.dispatch({ type: "buffer.redo" }, viewport);
    expect(harness.controller.state.buffer.text).toBe("base one");
    await harness.controller.dispatch({ type: "buffer.redo" }, viewport);
    expect(harness.controller.state.buffer.text).toBe("base one!");
    expect(harness.controller.state.status).toBe("Redo");

    await harness.controller.dispatch({ type: "buffer.cancel" }, viewport);
    await harness.controller.dispatch({ type: "edit.begin" }, viewport);
    await harness.controller.dispatch({ type: "buffer.undo" }, viewport);
    expect(harness.controller.state.buffer.text).toBe("base");
    expect(harness.controller.state.status).toBe("Nothing to undo");
  });
});

describe("detail controller wrapped editor scrolling", () => {
  test("tracks the cursor by wrapped visual rows across movement and resize", async () => {
    const text = Array.from({ length: 18 }, (_, index) => `item-${index + 1}`).join(" ");
    const harness = createHarness(makeBlock({ text }));
    const narrowViewport = { width: 20, height: 8 };
    await harness.controller.initialize();

    await harness.controller.dispatch({ type: "edit.begin" }, narrowViewport);
    const endOffset = harness.controller.state.editorVisualOffset;
    expect(endOffset).toBeGreaterThan(0);

    await harness.controller.dispatch(
      { type: "buffer.move", direction: "home" },
      narrowViewport,
    );
    expect(harness.controller.state.editorVisualOffset).toBe(0);

    await harness.controller.dispatch(
      { type: "buffer.move", direction: "end" },
      narrowViewport,
    );
    expect(harness.controller.state.editorVisualOffset).toBe(endOffset);

    await harness.controller.dispatch(
      { type: "viewport.changed" },
      { width: 14, height: 8 },
    );
    expect(harness.controller.state.editorVisualOffset).toBeGreaterThan(endOffset);
    expect(harness.controller.state.buffer.text).toBe(text);
  });
});

describe("detail controller completion, navigation, and focus", () => {
  test("queries registered page addresses and applies their authored label", async () => {
    const harness = createHarness(makeBlock({ text: "See [[rel" }));
    harness.setPageQueryResults([{
      addresses: [{
        address: "release-notes",
        normalizedAddress: "release-notes",
        blockId: "release-id",
        kind: "page",
        title: "Release Notes",
      }],
      completeness: { kind: "truncated", limit: 20 },
    }]);
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "edit.begin" }, viewport);
    await harness.controller.dispatch({ type: "completion.open" }, viewport);

    expect(harness.calls.pageQueries).toEqual([{ query: "rel", limit: 20 }]);
    expect(harness.calls.queries).toEqual([]);
    expect(harness.controller.state.status).toBe("Showing first 20 matches");
    await harness.controller.dispatch({ type: "completion.accept" }, viewport);
    expect(harness.controller.state.buffer.text).toBe("See [[release-notes]]");
    expect(harness.controller.state.completion).toBeNull();
    expect(harness.controller.state.status).toBe("");
  });

  test("accepts Work-ID completion as a titled canonical wikilink", async () => {
    const harness = createHarness(makeBlock({ text: "See [[PIE-126" }));
    harness.setPageQueryResults([{
      addresses: [{
        address: "PIE-126",
        normalizedAddress: "pie-126",
        blockId: "target-block-126",
        kind: "work-id",
        title: "PIE-126 — Render oversized Tree expansions",
      }],
      completeness: { kind: "complete" },
    }]);
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "edit.begin" }, viewport);
    await harness.controller.dispatch({ type: "completion.open" }, viewport);
    expect(harness.controller.state.completion?.items[0]?.label).toBe(
      "PIE-126 — Render oversized Tree expansions",
    );
    await harness.controller.dispatch({ type: "completion.accept" }, viewport);

    expect(harness.controller.state.buffer.text).toBe(
      "See [[PIE-126|PIE-126 — Render oversized Tree expansions]]",
    );
  });

  test("creates a stable heading anchor only when fragment completion is accepted", async () => {
    const target = makeBlock({
      id: "fragment-target",
      text: "Target\n\n## Durable heading\nBody",
    });
    const harness = createHarness(makeBlock({ text: "See ((fragment-target#durable" }));
    harness.setQueryResults([{
      blocks: [{ ...target, depth: 0, hasChildren: false, displayText: target.text }],
      completeness: { kind: "complete" },
    }]);
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "edit.begin" }, viewport);
    await harness.controller.dispatch({ type: "completion.open" }, viewport);

    expect(harness.calls.updates).toEqual([]);
    expect(harness.controller.state.completion?.items).toMatchObject([{
      label: "Target › # Durable heading · create anchor",
      insertion: "((fragment-target^durable-heading))",
      anchor: {
        blockId: "fragment-target",
        fragmentId: "durable-heading",
        lineIndex: 2,
      },
    }]);


    await harness.controller.dispatch({ type: "completion.accept" }, viewport);
    expect(harness.calls.updates).toMatchObject([{
      blockId: "fragment-target",
      text: "Target\n\n## Durable heading ^durable-heading\nBody",
      expectedUpdatedAt: target.updatedAt,
    }]);
    expect(harness.controller.state.buffer.text).toBe(
      "See ((fragment-target^durable-heading))",
    );
    expect(harness.controller.state.status).toBe("Created fragment · ^durable-heading");
  });
  test("stages a same-block heading anchor in the current buffer before inserting its reference", async () => {
    const source = makeBlock({
      id: "current-block",
      text: "## Local heading\n\nSee ((current-block#local",
    });
    const harness = createHarness(source);
    harness.setQueryResults([{
      blocks: [{ ...source, depth: 0, hasChildren: false, displayText: source.text }],
      completeness: { kind: "complete" },
    }]);
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "edit.begin" }, viewport);
    await harness.controller.dispatch({ type: "completion.open" }, viewport);
    await harness.controller.dispatch({ type: "completion.accept" }, viewport);

    expect(harness.calls.updates).toEqual([]);
    expect(harness.controller.state.buffer.text).toBe(
      "## Local heading ^local-heading\n\nSee ((current-block^local-heading))",
    );
    expect(harness.controller.state.buffer.undo()).toBe(true);
    expect(harness.controller.state.buffer.text).toBe(
      "## Local heading ^local-heading\n\nSee ((current-block#local",
    );
  });

  test("reuses an existing fragment anchor without updating its target", async () => {
    const target = makeBlock({
      id: "fragment-target",
      text: "Target\n\nParagraph ^stable-paragraph",
    });
    const harness = createHarness(makeBlock({ text: "See ((fragment-target^stable" }));
    harness.setQueryResults([{
      blocks: [{ ...target, depth: 0, hasChildren: false, displayText: target.text }],
      completeness: { kind: "complete" },
    }]);
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "edit.begin" }, viewport);
    await harness.controller.dispatch({ type: "completion.open" }, viewport);
    await harness.controller.dispatch({ type: "completion.accept" }, viewport);

    expect(harness.calls.updates).toEqual([]);
    expect(harness.controller.state.buffer.text).toBe(
      "See ((fragment-target^stable-paragraph))",
    );
  });

  test("completes directories without closing and files with a closing bracket", async () => {
    const harness = createHarness(makeBlock({ text: "[file::src/" }));
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "edit.begin" }, viewport);
    await harness.controller.dispatch({ type: "completion.open" }, viewport);
    expect(harness.controller.state.completion?.items.map((item) => item.insertion)).toEqual([
      "[file::src/components/",
      "[file::src/detail.ts]",
    ]);
  });

  test("keeps the file cursor visible when the viewport shrinks", async () => {
    const block = makeBlock({ properties: [{ key: "file", value: "src/example.ts" }] });
    const harness = createHarness(block, filePreview());
    const shortViewport = { width: 40, height: 9 };
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "file.navigate", direction: "pagedown" }, shortViewport);
    await harness.controller.dispatch({ type: "file.selection.toggle" }, shortViewport);
    await harness.controller.dispatch({ type: "file.navigate", direction: "end" }, shortViewport);

    expect(harness.controller.state.fileCursor).toBe(7);
    expect(harness.controller.state.fileOffset).toBe(5);
    expect(harness.controller.state.selectionAnchor).toBe(3);

    await harness.controller.dispatch({ type: "viewport.changed" }, { width: 40, height: 6 });
    expect(harness.controller.state.fileOffset).toBe(7);
  });

  test("opens the raw block preview from file mode", async () => {
    const block = makeBlock({ properties: [{ key: "file", value: "src/example.ts" }] });
    const harness = createHarness(block, filePreview());
    await harness.controller.initialize();

    await harness.controller.dispatch({ type: "view.block" }, viewport);

    expect(harness.controller.state.mode).toBe("preview");
    expect(harness.controller.state.previewOffset).toBe(0);
  });

  test("preserves focus failures when an announcement was requested", async () => {
    const harness = createHarness(makeBlock());
    harness.setFocusError(new Error("pane missing"));
    await harness.controller.initialize();

    await harness.controller.dispatch({ type: "focus.outliner" }, viewport);
    expect(harness.controller.state.status).toBe("pane missing");
    await harness.controller.dispatch({ type: "focus.outliner", announce: true }, viewport);
    expect(harness.controller.state.status).toBe("pane missing");
    expect(harness.calls.focuses).toBe(2);
  });

  test("a targeted preview updates the unlocked reader without stealing focus", async () => {
    const initial = makeBlock({ id: "block-1", text: "Initial" });
    const next = makeBlock({ id: "block-2", text: "Next" });
    const harness = createHarness(initial);
    await harness.controller.initialize();
    harness.setSelection({ selected: next, ancestors: [], children: [] });

    await harness.controller.onServiceEvent(
      event("ui", { targetClientId: "detail-test", command: "preview", target: { kind: "block", blockId: next.id },  }),
      viewport,
    );

    expect(harness.controller.state.connectionMode).toBe("unlocked");
    expect(harness.controller.state.target).toEqual({ kind: "block", blockId: next.id });
    expect(harness.controller.state.status).toBe(
      "Previewing Tree selection · L locks this block",
    );
    expect(harness.calls.selfFocuses).toBe(0);
  });

  test("an ordinary open focuses its unlocked destination without locking it", async () => {
    const first = makeBlock();
    const second = makeBlock({ id: "block-2", text: "second", updatedAt: "version-2" });
    const harness = createHarness(first);
    await harness.controller.initialize();
    harness.setSelection({ selected: second, ancestors: [], children: [] });

    await harness.controller.onServiceEvent(
      event("ui", { targetClientId: "detail-test", command: "open", target: { kind: "block", blockId: "block-2" } }),
      viewport,
    );

    expect(harness.controller.state.context.selected?.id).toBe("block-2");
    expect(harness.controller.state.connectionMode).toBe("unlocked");
    expect(harness.calls.selfFocuses).toBe(1);
    expect(harness.calls.locks).toEqual([]);
  });

  test("an explicit replace retargets the invoking Detail without clearing its lock", async () => {
    const first = makeBlock();
    const second = makeBlock({ id: "block-2", text: "second", updatedAt: "version-2" });
    const harness = createHarness(first);
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "lock.toggle" }, viewport);
    harness.setSelection({ selected: second, ancestors: [], children: [] });

    await harness.controller.onServiceEvent(
      event("ui", { targetClientId: "detail-test", command: "replace", target: { kind: "block", blockId: second.id } }),
      viewport,
    );

    expect(harness.controller.state.context.selected?.id).toBe(second.id);
    expect(harness.controller.state.connectionMode).toBe("locked");
    expect(harness.controller.state.status).toBe(
      "Replaced here · remains locked · L unlocks this block",
    );
    expect(harness.calls.selfFocuses).toBe(1);
    expect(harness.calls.locks).toEqual([true]);
  });

  test("entering edit mode locks the current Detail anchor", async () => {
    const harness = createHarness(makeBlock());
    await harness.controller.initialize();

    await harness.controller.dispatch({ type: "edit.begin" }, viewport);

    expect(harness.controller.state.mode).toBe("edit");
    expect(harness.controller.state.connectionMode).toBe("locked");
    expect(harness.calls.locks).toEqual([true]);
    expect(harness.controller.state.status).toBe("Locked for editing");
  });
});

describe("detail backlink loading and navigation", () => {
  test("does not query while collapsed and caches loaded results until invalidated", async () => {
    const first = makeBlock({ id: "block-1", text: "First" });
    const second = makeBlock({ id: "block-2", text: "Second" });
    const harness = createHarness(first);
    harness.setBacklinkResults([
      {
        targetBlockId: second.id,
        sources: [],
        completeness: { kind: "complete" },
      },
      {
        targetBlockId: second.id,
        sources: [],
        completeness: { kind: "complete" },
      },
    ]);

    await harness.controller.initialize();
    harness.setSelection({ selected: second, ancestors: [], children: [] });
    await harness.controller.onServiceEvent(
      event("ui", { targetClientId: "detail-test", command: "preview", target: { kind: "block", blockId: second.id },  }),
      viewport,
    );
    expect(harness.calls.backlinkQueries).toEqual([]);

    await harness.controller.dispatch({ type: "backlinks.toggle" }, viewport);
    expect(harness.calls.backlinkQueries).toEqual([{ targetBlockId: second.id, limit: 50 }]);

    await harness.controller.dispatch({ type: "backlinks.toggle" }, viewport);
    await harness.controller.dispatch({ type: "backlinks.toggle" }, viewport);
    expect(harness.calls.backlinkQueries).toHaveLength(1);

    await harness.controller.onServiceEvent(event("content"), viewport);
    expect(harness.calls.backlinkQueries).toEqual([
      { targetBlockId: second.id, limit: 50 },
      { targetBlockId: second.id, limit: 50 },
    ]);
  });

  test("reloads an expanded backlink projection when its target changes", async () => {
    const first = makeBlock({ id: "block-1", text: "First" });
    const second = makeBlock({ id: "block-2", text: "Second" });
    const harness = createHarness(first);
    harness.setBacklinkResults([
      {
        targetBlockId: first.id,
        sources: [],
        completeness: { kind: "complete" },
      },
      {
        targetBlockId: second.id,
        sources: [],
        completeness: { kind: "complete" },
      },
    ]);
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "backlinks.toggle" }, viewport);

    harness.setSelection({ selected: second, ancestors: [], children: [] });
    await harness.controller.onServiceEvent(
      event("ui", { targetClientId: "detail-test", command: "preview", target: { kind: "block", blockId: second.id },  }),
      viewport,
    );

    expect(harness.calls.backlinkQueries).toEqual([
      { targetBlockId: first.id, limit: 50 },
      { targetBlockId: second.id, limit: 50 },
    ]);
    expect(harness.controller.state.backlinks.collection?.targetBlockId).toBe(second.id);
  });

  test("dispatches generated backlink targets with source preservation", async () => {
    const source = makeBlock({ id: "hub-block", text: "Hub" });
    const harness = createHarness(source);
    await harness.controller.initialize();

    await harness.controller.dispatch({
      type: "reference.open",
      target: {
        kind: "block",
        value: "source-block",
        preserveSource: true,
      },
    }, viewport);
    expect(harness.calls.navigationDispatches).toEqual([]);
    expect(harness.controller.state.context.selected?.id).toBe(source.id);
    await harness.controller.handleDestinationChooserKeypress("f", { name: "f" });

    expect(harness.calls.navigationDispatches).toEqual([{
      blockId: "source-block",
      intent: "open",
      preserveSource: true,
    }]);
    expect(harness.controller.state.context.selected?.id).toBe(source.id);
    expect(harness.controller.state.status).toContain("first unlocked Detail");

    await harness.controller.dispatch({
      type: "reference.open",
      target: {
        kind: "block",
        value: "ancestor-block",
        intent: "reveal",
      },
    }, viewport);
    expect(harness.calls.navigationDispatches.at(-1)).toEqual({
      blockId: "ancestor-block",
      intent: "reveal",
      preserveSource: false,
      focusTarget: true,
    });
  });

  test("peeks the selected backlink and preserves explicit reveal navigation", async () => {
    const hub = makeBlock({ id: "hub-block", text: "Hub" });
    const harness = createHarness(hub);
    harness.setBacklinkResults([{
      targetBlockId: hub.id,
      sources: [
        {
          blockId: "source-one",
          title: "Source one",
          parentContext: "Top level",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-04T00:00:00.000Z",
          occurrenceCount: 1,
          referenceGroups: [{ kind: "block", count: 1 }],
          occurrences: [],
          occurrencesTruncated: false,
        },
        {
          blockId: "source-two",
          title: "Source two",
          parentContext: "Top level",
          createdAt: "2026-01-03T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
          occurrenceCount: 1,
          referenceGroups: [{ kind: "page", count: 1 }],
          occurrences: [],
          occurrencesTruncated: false,
        },
      ],
      completeness: { kind: "complete" },
    }]);
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "backlinks.toggle" }, viewport);
    harness.controller.setPreviewRegions(detailBacklinkRegions(harness.controller.state));
    await harness.controller.dispatch({
      type: "preview.focus.set",
      regionId: "backlink:source-two",
    }, viewport);
    await harness.controller.dispatch({ type: "preview.activate" }, viewport);
    await harness.controller.dispatch({ type: "backlinks.reveal" }, viewport);

    expect(harness.controller.state.backlinks.selectedIndex).toBe(1);
    expect(harness.calls.backlinkPeeks).toEqual([{
      sourceClientId: "detail-test",
      browsingContextId: "context-test",
      targetBlockId: "hub-block",
      selectedSourceBlockId: "source-two",
      filter: "",
      sortField: "updated",
      sortDirection: "desc",
    }]);
    expect(harness.calls.navigationDispatches).toEqual([
      { blockId: "source-two", intent: "reveal", preserveSource: false, focusTarget: true },
    ]);
    expect(harness.controller.state.context.selected?.id).toBe(hub.id);
    expect(harness.controller.state.status).toBe("Revealed Source two");
  });

  test("restores the exact inline backlink row after a popup selection command", async () => {
    const hub = makeBlock({ id: "hub-block", text: "Hub" });
    const harness = createHarness(hub);
    harness.setBacklinkResults([{
      targetBlockId: hub.id,
      sources: [
        {
          blockId: "source-one",
          title: "Source one",
          parentContext: "Top level",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
          occurrenceCount: 1,
          referenceGroups: [{ kind: "block", count: 1 }],
          occurrences: [],
          occurrencesTruncated: false,
        },
        {
          blockId: "source-two",
          title: "Source two",
          parentContext: "Top level",
          createdAt: "2026-01-02T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          occurrenceCount: 1,
          referenceGroups: [{ kind: "block", count: 1 }],
          occurrences: [],
          occurrencesTruncated: false,
        },
      ],
      completeness: { kind: "complete" },
    }]);
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "backlinks.toggle" }, viewport);

    await harness.controller.onServiceEvent(event("ui", {
      targetClientId: "detail-test",
      command: "backlinks.select",
      targetBlockId: hub.id,
      sourceBlockId: "source-two",
    }), viewport);

    expect(harness.controller.state.context.selected?.id).toBe(hub.id);
    expect(harness.controller.state.backlinks.selectedIndex).toBe(1);
    expect(harness.controller.state.previewRegions.focusedRegionId).toBe("backlink:source-two");
    expect(harness.calls.selfFocuses).toBe(1);
  });

  test("filters fuzzily, cycles timestamp sorting, and toggles source detail", async () => {
    const hub = makeBlock({ id: "hub-block", text: "Hub" });
    const harness = createHarness(hub);
    harness.setBacklinkResults([{
      targetBlockId: hub.id,
      sources: [
        {
          blockId: "alpha-source",
          title: "Alpha source",
          parentContext: "Research",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-04T00:00:00.000Z",
          occurrenceCount: 1,
          referenceGroups: [{ kind: "block", count: 1 }],
          occurrences: [{
            kind: "block",
            label: "synthetic",
            snippet: "Project integration evidence - phase 1 had 5 findings and 1 follow-up",
            start: 0,
            end: 9,
          }],
          occurrencesTruncated: false,
        },
        {
          blockId: "gamma-source",
          title: "Gamma source",
          parentContext: "Architecture",
          createdAt: "2026-01-03T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
          occurrenceCount: 1,
          referenceGroups: [{ kind: "property", propertyKey: "source-block", count: 1 }],
          occurrences: [],
          occurrencesTruncated: false,
        },
      ],
      completeness: { kind: "complete" },
    }]);
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "backlinks.toggle" }, viewport);

    expect(visibleBacklinkSources(harness.controller.state.backlinks).map((source) => source.blockId))
      .toEqual(["alpha-source", "gamma-source"]);
    await harness.controller.dispatch({ type: "backlinks.sort.cycle" }, viewport);
    expect(visibleBacklinkSources(harness.controller.state.backlinks).map((source) => source.blockId))
      .toEqual(["gamma-source", "alpha-source"]);

    await harness.controller.dispatch({ type: "backlinks.filter.begin" }, viewport);
    await harness.controller.dispatch({ type: "backlinks.filter.input", text: "gm" }, viewport);
    await harness.controller.dispatch({ type: "backlinks.filter.commit" }, viewport);
    expect(visibleBacklinkSources(harness.controller.state.backlinks).map((source) => source.blockId))
      .toEqual(["gamma-source"]);

    await harness.controller.dispatch({ type: "backlinks.source.toggle" }, viewport);
    expect(harness.controller.state.backlinks.expandedSourceIds).toEqual(
      new Set(["gamma-source"]),
    );

    harness.controller.state.backlinks.filter = "PIE-151";
    expect(visibleBacklinkSources(harness.controller.state.backlinks)).toEqual([]);
  });
});

describe("Detail property inspector integration", () => {
  const relatedBlockId = "550e8400-e29b-41d4-a716-446655440010";
  const source = [
    "PIE-154 property fixture [type::design-note]",
    `[related-to:: ${relatedBlockId}]`,
    "[related-to:: 550e8400-e29b-41d4-a716-446655440011]",
    "[page:: Planning / Inbox]",
    "",
    "ctx:: body-line",
    "Body [work-id:: PIE-171] [unknown-key:: kept]",
  ].join("\n");

  test("routes a plain-click typed Property target to the first unlocked Detail", async () => {
    const targetId = "8a3a9c31-58ff-48d1-9d25-95db5f78e9eb";
    const harness = createHarness(makeBlock({
      id: "property-source",
      text: `Property source\n[related-to::${targetId}]`,
    }));
    await harness.controller.initialize();
    const entry = harness.controller.state.propertyInspector.model?.entries.find(
      (candidate) => candidate.target?.kind === "block",
    );
    expect(entry).toBeDefined();

    await harness.controller.dispatch({
      type: "property-inspector.target.open",
      occurrenceId: entry!.occurrenceId,
      intent: "open",
      routing: "first-unlocked",
    }, viewport);

    expect(harness.controller.state.destinationChooser.active).toBe(false);
    expect(harness.calls.navigationDispatches).toEqual([{
      blockId: targetId,
      intent: "open",
      preserveSource: false,
    }]);
    expect(harness.controller.state.context.selected?.id).toBe(targetId);
  });

  test("preserves a dedicated inspector when directly routing a typed target", async () => {
    const targetId = "8a3a9c31-58ff-48d1-9d25-95db5f78e9eb";
    const harness = createHarness(makeBlock({
      id: "property-source",
      text: `Property source\n[related-to::${targetId}]`,
    }));
    const controller = createDetailController(harness.effects, undefined, {
      propertyInspectorPresentation: "dedicated",
    });
    await controller.initialize();
    await controller.dispatch({ type: "lock.toggle" }, viewport);
    const entry = controller.state.propertyInspector.model?.entries.find(
      (candidate) => candidate.target?.kind === "block",
    );
    expect(entry).toBeDefined();

    await controller.dispatch({
      type: "property-inspector.target.open",
      occurrenceId: entry!.occurrenceId,
      intent: "open",
      routing: "first-unlocked",
    }, viewport);

    expect(controller.state.destinationChooser.active).toBe(false);
    expect(harness.calls.navigationDispatches).toEqual([{
      blockId: targetId,
      intent: "open",
      preserveSource: true,
    }]);
    expect(controller.state.context.selected?.id).toBe("property-source");
  });

  test("unlocks a dedicated inspector and opens its current target in a sibling Detail", async () => {
    const harness = createHarness(makeBlock({ id: "property-source", text: source }));
    const controller = createDetailController(harness.effects, undefined, {
      propertyInspectorPresentation: "dedicated",
    });
    await controller.initialize();

    await controller.dispatch({ type: "lock.toggle" }, viewport);
    await controller.onServiceEvent(
      event("ui", { targetClientId: "detail-test", command: "preview", target: { kind: "block", blockId: "routed-property-target" },  }),
      viewport,
    );
    await controller.dispatch({ type: "pane.open", direction: "down" }, viewport);

    expect(controller.state.connectionMode).toBe("unlocked");
    expect(harness.calls.locks).toEqual([false]);
    expect(controller.state.context.selected?.id).toBe("routed-property-target");
    expect(harness.calls.openedDetails).toEqual([{
      blockId: "routed-property-target",
      direction: "down",
    }]);
    expect(controller.state.propertyInspector.presentation).toBe("dedicated");
  });

  test("keeps inspector interaction ephemeral and routes typed targets through Detail navigation", async () => {
    const harness = createHarness(makeBlock({ id: "property-source", text: source }));
    const controller = createDetailController(harness.effects, undefined, {
      propertyInspectorPresentation: "dedicated",
    });
    await controller.initialize();

    expect(controller.state.connectionMode).toBe("locked");
    expect(controller.state.propertyInspector.model?.canonicalText).toBe(source);
    expect(controller.state.propertyInspector.model?.entries.map((entry) => entry.scope))
      .toEqual(["block", "block", "block", "block", "line", "inline", "inline"]);

    await controller.dispatch({ type: "property-inspector.group.cycle" }, viewport);
    await controller.dispatch({ type: "property-inspector.filter.begin" }, viewport);
    await controller.dispatch({ type: "property-inspector.filter.input", text: "related" }, viewport);
    await controller.dispatch({ type: "property-inspector.filter.commit" }, viewport);
    await controller.dispatch({ type: "property-inspector.viewport.navigate", direction: "down" }, viewport);
    await controller.dispatch({ type: "property-inspector.pane.open" }, viewport);

    const target = controller.state.propertyInspector.model?.entries.find(
      (entry) => entry.value === relatedBlockId,
    );
    expect(target?.target?.kind).toBe("block");
    await controller.dispatch({
      type: "property-inspector.target.open",
      occurrenceId: target!.occurrenceId,
      intent: "open",
    }, viewport);
    await controller.handleDestinationChooserKeypress("r", { name: "r" });
    const pageTarget = controller.state.propertyInspector.model!.entries.find(
      (entry) => entry.target?.kind === "page",
    )!;
    const workTarget = controller.state.propertyInspector.model!.entries.find(
      (entry) => entry.target?.kind === "work-id",
    )!;
    for (const entry of [pageTarget, workTarget]) {
      await controller.dispatch({
        type: "property-inspector.target.open",
        occurrenceId: entry.occurrenceId,
        intent: "open",
      }, viewport);
      await controller.handleDestinationChooserKeypress("r", { name: "r" });
    }
    const plain = controller.state.propertyInspector.model!.entries.find(
      (entry) => entry.key === "unknown-key",
    )!;
    const followedBeforePlain = harness.calls.followedReferences.length;
    await controller.dispatch({
      type: "property-inspector.target.open",
      occurrenceId: plain.occurrenceId,
      intent: "open",
    }, viewport);

    expect(harness.calls.propertyInspectorPanes).toEqual(["property-source"]);
    expect(harness.calls.followedReferences).toContainEqual({
      kind: "block",
      value: relatedBlockId,
      preserveSource: true,
    });
    expect(harness.calls.followedReferences).toContainEqual({
      kind: "page",
      value: "Planning / Inbox",
      preserveSource: true,
    });
    expect(harness.calls.followedReferences).toContainEqual({
      kind: "work",
      value: "PIE-171",
      preserveSource: true,
    });
    expect(harness.calls.followedReferences).toHaveLength(followedBeforePlain);
    expect(controller.state.status).toBe("unknown-key has no navigation target");
    expect(harness.calls.updates).toEqual([]);
    expect(controller.state.context.selected?.text).toBe(source);
  });


  test("tabs to the inline disclosure and expands it with activation", async () => {
    const harness = createHarness(makeBlock({ text: "Subject [status::planned]" }));
    const controller = harness.controller;
    await controller.initialize();
    controller.setPreviewRegions(detailPropertyInspectorRegions(controller.state));

    await controller.dispatch({ type: "preview.focus.move", delta: 1 }, viewport);
    expect(controller.state.previewRegions.focusedRegionId).toBe("property-inspector");
    await controller.dispatch({ type: "preview.activate" }, viewport);
    expect(controller.state.propertyInspector.expanded).toBe(true);

    controller.setPreviewRegions(detailPropertyInspectorRegions(controller.state));
    await controller.dispatch({ type: "preview.focus.move", delta: 1 }, viewport);
    expect(controller.state.previewRegions.focusedRegionId).toBe(
      controller.state.propertyInspector.model!.entries[0]!.occurrenceId,
    );
  });
  test("edits one focused property through an optimistic canonical patch", async () => {
    const canonical = "Subject [status::planned] [owner::evan]";
    const harness = createHarness(makeBlock({ id: "property-source", text: canonical }));
    const controller = createDetailController(harness.effects, undefined, {
      propertyInspectorPresentation: "dedicated",
    });
    await controller.initialize();
    const status = controller.state.propertyInspector.model!.entries[0]!;
    controller.state.previewRegions.focusedRegionId = status.occurrenceId;

    await controller.dispatch({ type: "property-inspector.edit.begin" }, viewport);
    expect(controller.isBufferMode()).toBe(true);
    expect(controller.state.connectionMode).toBe("locked");
    expect(controller.state.propertyInspector.edit?.buffer.text).toBe("planned");
    await controller.dispatch({ type: "property-inspector.edit.select-all" }, viewport);
    await controller.dispatch({ type: "property-inspector.edit.insert", text: "complete" }, viewport);
    expect(controller.state.context.selected?.text).toBe(canonical);

    await controller.dispatch({ type: "property-inspector.edit.commit" }, viewport);

    expect(harness.calls.propertyPatches).toEqual([{
      blockId: "property-source",
      expectedUpdatedAt: "version-1",
      operations: [{ op: "replace", ordinal: 0, value: "complete" }],
    }]);
    expect(controller.state.context.selected?.text).toBe(
      "Subject [status::complete] [owner::evan]",
    );
    expect(controller.state.propertyInspector.model?.entries.map((entry) => entry.value))
      .toEqual(["complete", "evan"]);
    expect(controller.state.propertyInspector.edit).toBeNull();
    expect(controller.state.previewRegions.focusedRegionId).toBe(
      controller.state.propertyInspector.model!.entries[0]!.occurrenceId,
    );
    expect(controller.isBufferMode()).toBe(false);
  });

  test("consumes queued navigation before projecting a property update for the old target", async () => {
    const sourceBlock = makeBlock({
      id: "property-source",
      text: "Subject [status::planned]",
    });
    const harness = createHarness(
      sourceBlock,
      null,
      async (text) => ({ text: `resolved:${text}`, references: [] }),
      async (text, hostBlockId) => {
        if (hostBlockId === sourceBlock.id && text.includes("[status::complete]")) {
          throw new Error("stale edited-target projection");
        }
        return { text, embeds: [], embedRanges: [] };
      },
    );
    const controller = createDetailController(harness.effects, undefined, {
      propertyInspectorPresentation: "dedicated",
    });
    await controller.initialize();
    const status = controller.state.propertyInspector.model!.entries[0]!;
    controller.state.previewRegions.focusedRegionId = status.occurrenceId;
    await controller.dispatch({ type: "property-inspector.edit.begin" }, viewport);
    await controller.dispatch({ type: "property-inspector.edit.select-all" }, viewport);
    await controller.dispatch({
      type: "property-inspector.edit.insert",
      text: "complete",
    }, viewport);
    await controller.onServiceEvent(
      event("ui", { targetClientId: "detail-test", command: "edit", target: { kind: "block", blockId: "other-block" },  }),
      viewport,
    );
    expect(controller.state.refreshPending).toBe(true);

    await controller.dispatch({ type: "property-inspector.edit.commit" }, viewport);

    expect(controller.state.refreshPending).toBe(false);
    expect(controller.state.target).toEqual({ kind: "block", blockId: "other-block" });
    expect(controller.state.context.selected?.id).toBe("other-block");
    expect(controller.state.previewRegions.focusedRegionId).toBeNull();
    expect(controller.state.propertyInspector.edit).toBeNull();
    expect(controller.state.projectedSelectedText).toBe("Target other-block");
    expect(harness.calls.projectedReadHosts).toEqual(["property-source", "other-block"]);
  });
});

test("reveals exact targeted attention without mutating source or durable annotations", async () => {
  const selected = makeBlock({ text: "first line\npoint here\nlast line" });
  const harness = createHarness(selected);
  await harness.controller.initialize();
  const start = selected.text.indexOf("point");
  const mark = normalizeAttentionMark({
    markId: "attention-one",
    targetClientId: "detail-test",
    target: {
      kind: "block",
      sourceBlockId: selected.id,
      anchor: createAnnotationAnchor(
        selected.text,
        start,
        start + "point here".length,
        selected.updatedAt,
      ),
    },
    tone: "current",
    sender: "agent-test",
    reveal: true,
    focus: true,
  }, {
    clientId: "detail-test",
    role: "detail",
    contextId: "context-test",
  }, selected);
  const attention = attentionClientState("detail-test", [mark], 1);

  await harness.controller.onServiceEvent({
    id: "attention-event",
    domain: "attention",
    action: "attention.mark",
    sequence: 1,
    blockId: selected.id,
    attention,
    attentionInstruction: {
      markId: mark.markId,
      reveal: true,
      focus: true,
    },
  }, viewport);

  expect(harness.controller.state.target).toEqual({ kind: "block", blockId: selected.id });
  expect(harness.controller.state.attentionRevealSourceLine).toBe(1);
  expect(harness.controller.state.previewOffset).toBe(1);
  expect(harness.controller.state.mode).toBe("preview");
  expect(harness.controller.state.annotationThreads).toEqual([]);
  expect(harness.controller.state.context.selected?.text).toBe(selected.text);
  expect(harness.controller.state.status).toBe(`Attention · source range ${start}-${start + 10}`);
  expect(harness.calls.selfFocuses).toBe(1);

  await harness.controller.onServiceEvent({
    id: "other-client",
    domain: "attention",
    action: "attention.clear",
    sequence: 1,
    attention: { ...attention, targetClientId: "detail-other" },
  }, viewport);
  expect(harness.controller.state.attention.currentMarkId).toBe(mark.markId);

  await harness.controller.dispatch({ type: "attention.acknowledge" }, viewport);
  expect(harness.controller.state.attention.marks).toEqual([]);
  expect(harness.controller.state.status).toBe(
    "Attention cue acknowledged; active marks remain",
  );
});
