import { describe, expect, test } from "bun:test";
import {
  createDetailController,
  visibleBacklinkSources,
  type DetailEffects,
  type DetailViewport,
} from "../src/detail-controller";
import type { ReferencedFile } from "../src/files";
import type { OutlinerLinkTarget } from "../src/outliner-links";
import type {
  BacklinkCollection,
  BacklinkQuery,
  Block,
  BlockSearchQuery,
  OutlinerEvent,
  PageAddressCollection,
  SelectionContext,
  VisibleBlock,
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

function makeVisibleBlock(overrides: Partial<VisibleBlock> = {}): VisibleBlock {
  return {
    ...makeBlock(overrides),
    depth: 0,
    hasChildren: false,
    displayText: overrides.text ?? "Raw block text",
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
    creates: Array<{ parentId: string; text: string; author: "user" }>;
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
    }>;
    pageQueries: Array<{ query: string | undefined; limit: number }>;
    focuses: number;
    selfFocuses: number;
    locks: boolean[];
    currentBlocks: Array<string | null>;
  };
  setSelection(selection: SelectionContext): void;
  setUpdate(implementation: DetailEffects["updateBlock"]): void;
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
): Harness {
  let selection: SelectionContext = { selected: initial, ancestors: [], children: [] };
  let update: DetailEffects["updateBlock"] = async (input) => makeBlock({
    id: input.blockId,
    text: input.text,
    updatedAt: "version-2",
    properties: initial.properties,
  });
  let queryResults: VisibleBlockCollection[] = [];
  let backlinkResults: BacklinkCollection[] = [];
  let focusError: Error | null = null;
  let pageQueryResults: PageAddressCollection[] = [];
  const calls: Harness["calls"] = {
    selections: 0,
    setSelections: [],
    projectedReads: [],
    projectedReadHosts: [],
    updates: [],
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
  };
  const effects: DetailEffects = {
    clientId: "detail-test",
    browsingContextId: "context-test",
    focusSelf() {
      calls.selfFocuses += 1;
    },
    async getBrowsingContext() {
      calls.selections += 1;
      return { contextId: "context-test", target: selection };
    },
    async getBlockContext(blockId) {
      calls.selections += 1;
      if (selection.selected?.id === blockId) return selection;
      return {
        selected: makeBlock({ id: blockId, text: `Target ${blockId}` }),
        ancestors: [],
        children: [],
      };
    },
    async setLocked(locked) {
      calls.locks.push(locked);
    },
    async setCurrentBlock(blockId) {
      calls.currentBlocks.push(blockId);
    },
    async dispatchNavigation(blockId, intent, options) {
      calls.navigationDispatches.push({
        blockId,
        intent,
        preserveSource: options?.preserveSource === true,
        ...(options?.fragmentId ? { fragmentId: options.fragmentId } : {}),
      });
      const targetClientId = options?.preserveSource ? "detail-other" : "detail-test";
      return {
        sourceClientId: "detail-test",
        targetClientId,
        blockId,
        intent,
        resolution: "unlocked",
        command: {
          targetClientId,
          command: intent,
          blockId,
          ...(options?.fragmentId ? { fragmentId: options.fragmentId } : {}),
        },
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
      };
    },
    async createBlock(input) {
      calls.creates.push(input);
      return makeBlock({ id: "annotation-1" });
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
  };
  return {
    controller: createDetailController(effects),
    effects,
    calls,
    setSelection(next) {
      selection = next;
    },
    setUpdate(implementation) {
      update = implementation;
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

  test("keeps navigation history local and loads deleted targets read-only", async () => {
    const source = makeBlock({ text: "See ((target01))" });
    const harness = createHarness(source);
    await harness.controller.initialize();

    await harness.controller.dispatch({ type: "reference.follow" }, viewport);
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
      event("ui", { targetClientId: "detail-test", command: "reveal", blockId: "deleted1" }),
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
    const source = makeBlock({ text: "See ((target01^decision))" });
    const target = makeBlock({
      id: "target01",
      text: "Target\n\nIntro\n\n## Decision ^decision\nBody",
    });
    const harness = createHarness(source);
    await harness.controller.initialize();
    harness.setSelection({ selected: target, ancestors: [], children: [] });

    await harness.controller.dispatch({ type: "reference.follow" }, viewport);

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
    expect(harness.controller.state.targetFragmentId).toBe("decision");
    expect(harness.controller.state.previewOffset).toBe(4);

    await harness.controller.dispatch({ type: "navigation.back" }, viewport);
    await harness.controller.dispatch({ type: "navigation.forward" }, viewport);
    expect(harness.controller.state.context.selected?.id).toBe(target.id);
    expect(harness.controller.state.targetFragmentId).toBe("decision");
    expect(harness.controller.state.previewOffset).toBe(4);
  });

  test("returns to an unlocked Tree preview after opening its link", async () => {
    const previous = makeBlock({ id: "previous-block", text: "Previous" });
    const previewed = makeBlock({ id: "c021d559-preview", text: "See linked block" });
    const harness = createHarness(previous);
    await harness.controller.initialize();

    harness.setSelection({ selected: previewed, ancestors: [], children: [] });
    await harness.controller.onServiceEvent(
      event("ui", { targetClientId: "detail-test", command: "preview", blockId: previewed.id }),
      viewport,
    );
    await harness.controller.dispatch({
      type: "reference.open",
      target: { kind: "block", value: "linked-block" },
    }, viewport);
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
      event("ui", { targetClientId: "detail-test", command: "preview", blockId: second.id }),
      viewport,
    );
    expect(harness.controller.state.context.selected?.id).toBe(second.id);
    expect(harness.controller.state.connectionMode).toBe("unlocked");

    await harness.controller.dispatch({ type: "lock.toggle" }, viewport);
    await harness.controller.onServiceEvent(
      event("ui", { targetClientId: "detail-test", command: "preview", blockId: third.id }),
      viewport,
    );
    expect(harness.controller.state.context.selected?.id).toBe(second.id);
    expect(harness.controller.state.connectionMode).toBe("locked");

    await harness.controller.onServiceEvent(
      event("ui", { targetClientId: "detail-test", command: "open", blockId: third.id }),
      viewport,
    );
    expect(harness.controller.state.context.selected?.id).toBe(second.id);
    expect(harness.calls.selfFocuses).toBe(0);

    await harness.controller.dispatch({ type: "lock.toggle" }, viewport);
    await harness.controller.onServiceEvent(
      event("ui", { targetClientId: "detail-test", command: "preview", blockId: third.id }),
      viewport,
    );
    expect(harness.controller.state.context.selected?.id).toBe(third.id);
    expect(harness.controller.state.connectionMode).toBe("unlocked");
    expect(harness.calls.locks).toEqual([true, false]);
  });

  test("keeps a locked Detail unchanged when an ordinary link resolves back to itself", async () => {
    const source = makeBlock({ id: "source-block", text: "See ((target01))" });
    const harness = createHarness(source);
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "lock.toggle" }, viewport);

    await harness.controller.dispatch({ type: "reference.follow" }, viewport);

    expect(harness.controller.state.context.selected?.id).toBe(source.id);
    expect(harness.controller.state.connectionMode).toBe("locked");
    expect(harness.controller.state.status).toBe(
      "Locked · ordinary navigation preserved this Detail",
    );
  });

  test("follows symbolic references through the page-address path", async () => {
    const harness = createHarness(makeBlock({ text: "See [[Future Page]]" }));
    await harness.controller.initialize();

    await harness.controller.dispatch({ type: "reference.follow" }, viewport);

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

  test("defers content and detail UI commands while editing, then refreshes after cancel", async () => {
    const harness = createHarness(makeBlock());
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "edit.begin" }, viewport);
    await harness.controller.dispatch({ type: "buffer.insert", text: "!" }, viewport);
    const protectedText = harness.controller.state.buffer.text;
    const selectionLoads = harness.calls.selections;

    await harness.controller.onServiceEvent(event("content"), viewport);
    await harness.controller.onServiceEvent(
      event("ui", { targetClientId: "detail-test", command: "edit", blockId: "other-block" }),
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
    expect(harness.calls.selections).toBe(2);
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
    expect(harness.calls.creates[0].parentId).toBe("block-1");
    expect(harness.calls.creates[0].author).toBe("user");
    expect(harness.calls.creates[0].text).toContain("[line-start::10] [line-end::17]");
    expect(harness.calls.creates[0].text).toContain("[source-block::block-1]");
    expect(harness.calls.creates[0].text).toContain("Explain this range.");
    expect(harness.controller.state.mode).toBe("file");
    expect(harness.controller.state.selectionAnchor).toBeNull();
    expect(harness.controller.state.status).toBe("Annotation added for lines 10-17");
  });

  test("rejects an empty annotation without leaving comment mode", async () => {
    const block = makeBlock({ properties: [{ key: "file", value: "src/example.ts" }] });
    const harness = createHarness(block, filePreview());
    await harness.controller.initialize();
    await harness.controller.dispatch({ type: "comment.begin" }, viewport);
    await harness.controller.dispatch({ type: "buffer.save" }, viewport);

    expect(harness.calls.creates).toEqual([]);
    expect(harness.controller.state.mode).toBe("comment");
    expect(harness.controller.state.status).toBe("Annotation comment cannot be empty");
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

  test("accepts Work-ID page completion as an exact titled block reference", async () => {
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

    expect(harness.controller.state.buffer.text).toBe("See ((target-block-126))");
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
      event("ui", {
        targetClientId: "detail-test",
        command: "preview",
        blockId: next.id,
      }),
      viewport,
    );

    expect(harness.controller.state.connectionMode).toBe("unlocked");
    expect(harness.controller.state.targetBlockId).toBe(next.id);
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
      event("ui", { targetClientId: "detail-test", command: "open", blockId: "block-2" }),
      viewport,
    );

    expect(harness.controller.state.context.selected?.id).toBe("block-2");
    expect(harness.controller.state.connectionMode).toBe("unlocked");
    expect(harness.calls.selfFocuses).toBe(1);
    expect(harness.calls.locks).toEqual([]);
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
      event("ui", {
        targetClientId: "detail-test",
        command: "preview",
        blockId: second.id,
      }),
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
      event("ui", {
        targetClientId: "detail-test",
        command: "preview",
        blockId: second.id,
      }),
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
    });
  });

  test("navigates the selected backlink through explicit inspect and reveal actions", async () => {
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
    await harness.controller.dispatch({ type: "backlinks.move", delta: 1 }, viewport);
    await harness.controller.dispatch({ type: "backlinks.open" }, viewport);
    await harness.controller.dispatch({ type: "backlinks.reveal" }, viewport);

    expect(harness.controller.state.backlinks.selectedIndex).toBe(1);
    expect(harness.calls.navigationDispatches).toEqual([
      { blockId: "source-two", intent: "open", preserveSource: true },
      { blockId: "source-two", intent: "reveal", preserveSource: false },
    ]);
    expect(harness.controller.state.context.selected?.id).toBe(hub.id);
    expect(harness.controller.state.status).toBe("Revealed Source two");
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
