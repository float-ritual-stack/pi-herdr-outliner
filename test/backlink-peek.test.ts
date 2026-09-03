import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { describe, expect, test } from "bun:test";
import {
  BacklinkPeekController,
  renderBacklinkPeekFrame,
  type BacklinkPeekEffects,
  type BacklinkPeekPreview,
} from "../src/backlink-peek";
import { projectedSourceLine } from "../src/detail-pi-preview";
import type { BacklinkSource, Block } from "../src/types";

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

function block(id: string, text = id): Block {
  return {
    id,
    parentId: null,
    position: 0,
    text,
    author: "user",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    properties: [],
  };
}

function source(id: string): BacklinkSource {
  return {
    blockId: id,
    title: `Source ${id}`,
    parentContext: "Roadmap",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    occurrenceCount: 1,
    referenceGroups: [{ kind: "block", count: 1 }],
    occurrences: [],
    occurrencesTruncated: false,
  };
}

interface Harness {
  controller: BacklinkPeekController;
  calls: {
    loaded: string[];
    restored: string[];
    openedHere: string[];
    openedNew: string[];
    closes: number;
    invalidations: number;
  };
  failOpenHere(message: string): void;
  failOpenNew(message: string): void;
}

function harness(selected = "two"): Harness {
  const calls: Harness["calls"] = {
    loaded: [],
    restored: [],
    openedHere: [],
    openedNew: [],
    closes: 0,
    invalidations: 0,
  };
  let openHereError: Error | null = null;
  let openNewError: Error | null = null;
  const effects: BacklinkPeekEffects = {
    async loadSource(item): Promise<BacklinkPeekPreview> {
      calls.loaded.push(item.blockId);
      return { block: block(item.blockId, `# ${item.title}`), text: `# ${item.title}`, sourceLine: 3 };
    },
    async restoreSelection(sourceBlockId) {
      calls.restored.push(sourceBlockId);
    },
    async openInSource(sourceBlockId) {
      calls.openedHere.push(sourceBlockId);
      if (openHereError) throw openHereError;
    },
    async openInNewDetail(sourceBlockId) {
      calls.openedNew.push(sourceBlockId);
      if (openNewError) throw openNewError;
    },
    close() {
      calls.closes += 1;
    },
    invalidate() {
      calls.invalidations += 1;
    },
  };
  return {
    controller: new BacklinkPeekController(
      "target",
      [source("one"), source("two"), source("three")],
      selected,
      effects,
    ),
    calls,
    failOpenHere(message) {
      openHereError = new Error(message);
    },
    failOpenNew(message) {
      openNewError = new Error(message);
    },
  };
}

describe("backlink peek controller", () => {
  test("loads the selected snapshot entry and traverses only within its boundaries", async () => {
    const state = harness();
    await state.controller.initialize();
    expect(state.controller.selectedSource?.blockId).toBe("two");
    expect(state.calls.loaded).toEqual(["two"]);
    expect(state.controller.scrollOffset).toBe(1);

    await state.controller.move(-1);
    await state.controller.move(-1);
    expect(state.controller.selectedSource?.blockId).toBe("one");
    expect(state.calls.loaded).toEqual(["two", "one"]);
    expect(state.controller.status).toBe("First backlink source");

    await state.controller.move(1);
    await state.controller.move(1);
    await state.controller.move(1);
    expect(state.controller.selectedSource?.blockId).toBe("three");
    expect(state.calls.loaded).toEqual(["two", "one", "two", "three"]);
    expect(state.controller.status).toBe("Last backlink source");
  });

  test("scrolls by the rendered body height", async () => {
    const state = harness();
    await state.controller.initialize();

    await state.controller.handleKeypress("", { name: "pagedown" }, "pass", 10);

    expect(state.controller.scrollOffset).toBe(5);
  });

  test("sanitizes canonical text before rendering Markdown", async () => {
    const state = harness();
    await state.controller.initialize();
    state.controller.preview = {
      block: block("two"),
      text: "\u001b]0;malicious-title\u0007# Safe content",
      sourceLine: 0,
    };
    state.controller.scrollOffset = 0;

    const frame = renderBacklinkPeekFrame(state.controller, 80, 12, plainMarkdownTheme);

    expect(frame).toContain("Safe content");
    expect(frame).not.toContain("\u001b]0;malicious-title\u0007");
  });

  test("maps authored occurrence lines through preceding embed expansion", () => {
    const embedId = "3a0530ad-6bb9-4d3a-842d-08ea53654ea8";
    const authored = `Before\n!((${embedId}))\nAfter`;

    expect(projectedSourceLine(authored, [{ startLine: 1, endLine: 4 }], 1)).toBe(1);
    expect(projectedSourceLine(authored, [{ startLine: 1, endLine: 4 }], 2)).toBe(5);
  });

  test("cancel restores the currently previewed inline row before closing", async () => {
    const state = harness();
    await state.controller.initialize();
    await state.controller.move(1);

    await state.controller.handleKeypress("", { name: "escape" }, "pass", 20);

    expect(state.calls.restored).toEqual(["three"]);
    expect(state.calls.openedHere).toEqual([]);
    expect(state.calls.openedNew).toEqual([]);
    expect(state.calls.closes).toBe(1);
  });

  test("enter commits directly into the invoking Detail", async () => {
    const state = harness();
    await state.controller.initialize();

    await state.controller.handleKeypress("\r", { name: "return" }, "pass", 20);

    expect(state.calls.openedHere).toEqual(["two"]);
    expect(state.calls.restored).toEqual([]);
    expect(state.calls.closes).toBe(1);
  });

  test("modified enter restores the row and opens an explicit new Detail", async () => {
    const state = harness();
    await state.controller.initialize();
    await state.controller.move(-1);

    await state.controller.handleKeypress("", { name: "return" }, "modified-enter", 20);

    expect(state.calls.restored).toEqual(["one"]);
    expect(state.calls.openedNew).toEqual(["one"]);
    expect(state.calls.openedHere).toEqual([]);
    expect(state.calls.closes).toBe(1);
  });

  test("keeps the popup open when a commit is rejected", async () => {
    const state = harness();
    state.failOpenHere("invoking Detail is locked");
    await state.controller.initialize();

    await state.controller.handleKeypress("\r", { name: "return" }, "pass", 20);

    expect(state.calls.openedHere).toEqual(["two"]);
    expect(state.calls.closes).toBe(0);
    expect(state.controller.loading).toBe(false);
    expect(state.controller.status).toBe("Open failed: invoking Detail is locked");

    await state.controller.handleKeypress("", { name: "escape" }, "pass", 20);
    expect(state.calls.restored).toEqual(["two"]);
    expect(state.calls.closes).toBe(1);
  });
});
