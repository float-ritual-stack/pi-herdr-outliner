import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { GotoController } from "../src/goto-controller";
import { gotoCandidates, rankGotoWithJev, visibleGotoResults } from "../src/goto-search";
import { renderGotoFrame } from "../src/goto-renderer";
import type { RequestInput } from "../src/client";
import { loadDetailReadPreview } from "../src/detail-read-preview";
import type { Block, GotoSearchCollection } from "../src/types";

function block(id: string, text: string, overrides: Partial<Block> = {}): Block {
  return { id, text, parentId: null, revision: 1, position: 0, properties: [], author: "user", createdAt: "2026-09-20", updatedAt: "2026-09-20", ...overrides };
}
const notes = [block("river-note", "Detail river\nA browser arranges terminal panes beside their source."), block("keyboard-note", "Terminal pane shortcuts\nKeyboard controls in Herdr."), block("guide-note", "How this workboard works\nNext is the committed work batch.")];
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!check()) { if (Date.now() > deadline) throw new Error("Condition did not settle"); await sleep(2); }
}
function harness(search?: (input: Extract<RequestInput, { action: "tree.search" }>) => Promise<GotoSearchCollection> | GotoSearchCollection, get: (id: string) => Promise<Block | null> | Block | null | undefined = id => notes.find(note => note.id === id)) {
  const opened: Array<{ id: string; destination: string }> = [];
  let closed = 0;
  const controller = new GotoController({
    async request<T>(input: RequestInput): Promise<T> {
      if (input.action === "tree.search") return (await (search?.(input) ?? visibleGotoResults(gotoCandidates(notes, input.query)))) as T;
      if (input.action === "get") return await get(input.blockId) as T;
      if (input.action === "references.resolve") return { text: input.text, references: [] } as T;
      throw new Error(`Unexpected ${input.action}`);
    }, invalidate() {}, async open(id, destination) { opened.push({ id, destination }); }, close() { closed++; },
  }, 5);
  return { controller, opened, get closed() { return closed; } };
}
const fakeFetch = (scores: number[]) => (async (_url: unknown, init?: RequestInit) => {
  const body = JSON.parse(init!.body as string);
  expect(Object.keys(body.questions)).toHaveLength(scores.length);
  expect(body.questions.candidate_0.instructions).toContain("Candidate:");
  return Response.json({ model: "jev-test", answers: Object.fromEntries(scores.map((score, i) => [`candidate_${i}`, { type: "score", score }])), usage: { input_tokens: 123 } });
});
const promptDirectories: string[] = [];
afterEach(() => { for (const directory of promptDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function promptFixture() {
  const directory = mkdtempSync(join(tmpdir(), "outliner-goto-prompt-"));
  promptDirectories.push(directory);
  const path = join(directory, "goto-ranking.json");
  return {
    directory, path,
    write(instructions: string, criteria = ["No match", "Related topic", "Relevant note", "Exact requested note"]) {
      const text = JSON.stringify({ instructions, criteria }, null, 2) + "\n";
      writeFileSync(path, text);
      return { path, sha256: createHash("sha256").update(text).digest("hex"), text };
    },
  };
}

describe("Goto search", () => {
  test("finds descriptions with extra words, includes ancestry, and excludes Trash", () => {
    const parent = block("experiments", "Experiments");
    const target = { ...notes[0]!, parentId: parent.id };
    const result = gotoCandidates([parent, target, { ...notes[1]!, deletedAt: "now" }], "that browser thing with draggable terminals");
    expect(result.matches.map(match => match.block.id)).toEqual([target.id]);
    expect(result.matches[0]!.path).toBe("Experiments");
  });
  test("preserves exact identities and shows explicit bounded results", () => {
    const many = Array.from({ length: 120 }, (_, i) => block(`note-${i}`, `Reference ${i}\nCommon subject.`));
    many[100]!.properties = [{ key: "work-id", value: "PIE-999" }];
    expect(gotoCandidates(many, "PIE-999", { exactAddressId: "note-100" }).matches[0]!.block.id).toBe("note-100");
    expect(visibleGotoResults(gotoCandidates(many, "reference"))).toMatchObject({ matches: expect.any(Array), completeness: { kind: "truncated", limit: 30 } });
    expect(gotoCandidates(many, "reference").matches).toHaveLength(80);
    expect(gotoCandidates(many, "totally unrelated query").matches).toHaveLength(0);
  });
  test("descriptive word evidence survives a crowd of long accidental fuzzy matches", () => {
    const noise = Array.from({length: 100}, (_, i) => block(`noise-${i}`, `Archive ${i}\n${"abcdefghijklmnopqrstuvwxyz ".repeat(200)}`));
    const target = block("lock-change", "Make the Detail lock indicator distinguishable at a glance\nUse a padlock with a key.");
    expect(gotoCandidates([...noise, target], "make the lock easier to see").matches[0]!.block.id).toBe(target.id);
  });
  test("uses typed scores to reorder only supplied candidates", async () => {
    const candidates = gotoCandidates(notes, "terminal");
    const result = await rankGotoWithJev("terminal", candidates, { apiKey: "fixture", fetch: fakeFetch([0.2, 2.8]) });
    expect(result.matches[0]!.block.id).toBe(candidates.matches[1]!.block.id);
    expect(result.semantic).toMatchObject({ status: "ranked", candidateCount: 2, inputTokens: 123 });
  });
  test("reloads edited instructions for the next search while an in-flight search retains its prompt", async () => {
    const fixture = promptFixture();
    const firstRevision = fixture.write("Prioritize the remembered interaction.");
    const candidates = gotoCandidates(notes, "terminal");
    const firstResponse = Promise.withResolvers<Response>();
    const requests: Array<{ questions: Record<string, { instructions: string; criteria: string[] }> }> = [];
    const fetch = async (_url: string, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string));
      if (requests.length === 1) return firstResponse.promise;
      return fakeFetch([0.2, 2.8])(_url, init);
    };
    const options = { apiKey: "fixture", promptDirectory: fixture.directory, fetch };
    const firstSearch = rankGotoWithJev("terminal", candidates, options);
    await until(() => requests.length === 1);

    const criteria = ["Unrelated", "Mention only", "Substantive match", "Direct match"];
    const secondRevision = fixture.write("Prioritize the note itself, not incidental mentions.", criteria);
    const second = await rankGotoWithJev("terminal", candidates, options);
    firstResponse.resolve(Response.json({ answers: { candidate_0: { type: "score", score: 2.8 }, candidate_1: { type: "score", score: 0.2 } } }));
    const first = await firstSearch;

    expect(requests[0]!.questions.candidate_0!.instructions).toStartWith("Prioritize the remembered interaction.\nCandidate:");
    expect(requests[1]!.questions.candidate_0!.instructions).toStartWith("Prioritize the note itself, not incidental mentions.\nCandidate:");
    expect(requests[1]!.questions.candidate_0!.criteria).toEqual(criteria);
    expect(first.semantic.promptRevisions).toEqual([firstRevision]);
    expect(second.semantic.promptRevisions).toEqual([secondRevision]);
    expect(first.matches[0]!.block.id).toBe(candidates.matches[0]!.block.id);
    expect(second.matches[0]!.block.id).toBe(candidates.matches[1]!.block.id);
  });
  test("invalid prompt JSON identifies the file and preserves text matches without calling Jev", async () => {
    const fixture = promptFixture();
    writeFileSync(fixture.path, "{ invalid JSON");
    const candidates = gotoCandidates(notes, "terminal");
    let calls = 0;
    const result = await rankGotoWithJev("terminal", candidates, { apiKey: "fixture", promptDirectory: fixture.directory, fetch: async () => {
      calls++;
      throw new Error("Must not call provider");
    } });
    expect(calls).toBe(0);
    expect(result.matches).toEqual(candidates.matches);
    expect(result.semantic.status).toBe("unavailable");
    expect(result.semantic.message).toContain("goto-ranking.json");
    expect(result.semantic.message).toMatch(/JSON/i);
    expect(result.semantic.promptRevisions).toBeUndefined();
    const h = harness();
    h.controller.matches = result.matches;
    h.controller.semantic = result.semantic;
    initTheme(undefined, false);
    const visibleStatus = stripTerminalSequences(renderGotoFrame(h.controller, 80, 26, "Esc cancel")[3]!);
    expect(visibleStatus).toContain("goto-ranking.json");
    expect(visibleStatus).toContain("invalid JSON");
  });
  test("a provider failure keeps the attempted prompt revision without exposing provider text", async () => {
    const fixture = promptFixture();
    const revision = fixture.write("Judge relevance to the query.");
    const candidates = gotoCandidates(notes, "terminal");
    const result = await rankGotoWithJev("terminal", candidates, { apiKey: "fixture", promptDirectory: fixture.directory, fetch: async () => {
      throw new Error("SECRET provider text");
    } });
    expect(result.matches).toEqual(candidates.matches);
    expect(result.semantic).toMatchObject({ status: "unavailable", promptRevisions: [revision] });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
  test("keeps lexical results when unconfigured, malformed, or timed out", async () => {
    const candidates = gotoCandidates(notes, "terminal");
    const cases = [
      { apiKey: "" },
      { apiKey: "fixture", fetch: (async () => Response.json({ answers: { candidate_0: { type: "score", score: 999 } } })) },
      { apiKey: "fixture", fetch: (async () => { throw new Error("timeout SECRET provider text"); }) },
    ];
    for (const options of cases) {
      const result = await rankGotoWithJev("terminal", candidates, options);
      expect(result.matches).toEqual(candidates.matches);
      expect(result.semantic.status).toBe("unavailable");
      expect(JSON.stringify(result)).not.toContain("SECRET");
    }
  });

  test("abort deadline retains text matches when the provider never answers", async () => {
    const candidates = gotoCandidates(notes, "terminal");
    let aborted = false;
    const result = await rankGotoWithJev("terminal", candidates, { apiKey: "fixture", timeoutMs: 10, fetch: async (_url, init) => {
      await new Promise((_, reject) => init.signal!.addEventListener("abort", () => { aborted = true; reject(init.signal!.reason); }, { once: true }));
      throw new Error("unreachable");
    }});
    expect(aborted).toBe(true); expect(result.matches).toEqual(candidates.matches); expect(result.semantic.status).toBe("unavailable");
  });
  test("short searches and exact addresses need neither prompt files nor Jev", async () => {
    const fixture = promptFixture(); // Deliberately leave the prompt file absent.
    for (const query of ["te", "river-note"]) {
      const candidates = gotoCandidates(notes, query);
      const result = await rankGotoWithJev(query, candidates, { apiKey: "fixture", promptDirectory: fixture.directory, fetch: (() => { throw new Error("Must not call"); }) });
      expect(result).toBe(candidates);
      expect(result.semantic.status).toBe("lexical");
    }
  });
});

describe("Goto interaction", () => {
  test("previews without navigation; Escape cancels and invalidates pending work", async () => {
    const h = harness(); h.controller.start(); h.controller.paste("browser");
    await until(() => !!h.controller.preview);
    expect(h.controller.preview!.canonicalText).toContain("Detail river");
    expect(h.opened).toEqual([]);
    await h.controller.cancel();
    expect(h.closed).toBe(1);
    await h.controller.accept("tree"); expect(h.opened).toEqual([]);
  });
  test("late ranking preserves the user's selected identity and ordering", async () => {
    const pending = Promise.withResolvers<GotoSearchCollection>();
    let semanticStarted = false;
    const candidates = gotoCandidates(notes, "terminal");
    const h = harness(input => input.semantic ? (semanticStarted = true, pending.promise) : gotoCandidates(notes, input.query));
    h.controller.start(); h.controller.paste("terminal");
    await until(() => !h.controller.loading && semanticStarted);
    h.controller.move(1);
    const selected = h.controller.selected!.block.id;
    const order = h.controller.matches.map(match => match.block.id);
    pending.resolve({ ...candidates, matches: [...candidates.matches].reverse(), semantic: { status: "ranked" } });
    await until(() => !h.controller.ranking);
    expect(h.controller.selected!.block.id).toBe(selected);
    expect(h.controller.matches.map(match => match.block.id)).toEqual(order);
    await h.controller.accept("detail"); expect(h.opened).toEqual([{ id: selected, destination: "detail" }]);
  });
  test("an old semantic response cannot replace a new query or reopened modal", async () => {
    const pending = Promise.withResolvers<GotoSearchCollection>();
    let started = false;
    const h = harness(input => input.semantic && input.query === "terminal" ? (started = true, pending.promise) : gotoCandidates(notes, input.query));
    h.controller.start(); h.controller.paste("terminal");
    await until(() => started);
    await h.controller.cancel(); h.controller.start(); h.controller.paste("workboard");
    await until(() => !h.controller.loading);
    pending.resolve({ ...gotoCandidates(notes, "terminal"), semantic: { status: "ranked" } });
    await until(() => !h.controller.ranking);
    expect(h.controller.query).toBe("workboard"); expect(h.controller.selected!.block.id).toBe("guide-note");
    await h.controller.cancel();
  });
  test("Enter during a search is cancellable and never opens an old query", async () => {
    const pending = Promise.withResolvers<GotoSearchCollection>();
    const h = harness(() => pending.promise);
    h.controller.start(); h.controller.paste("browser");
    await h.controller.accept("tree"); await h.controller.cancel();
    pending.resolve(gotoCandidates(notes, "browser"));
    await sleep(10);
    expect(h.opened).toEqual([]);
  });

  test("top-30 truncation cannot displace a chosen result among 80 candidates", async () => {
    const many = Array.from({length: 80}, (_, i) => block(`match-${i}`, `Related note ${i}`));
    const candidates = gotoCandidates(many, "related");
    const pending = Promise.withResolvers<GotoSearchCollection>();
    let started = false;
    const h = harness(input => input.semantic ? (started = true, pending.promise) : visibleGotoResults(candidates));
    h.controller.start(); h.controller.paste("related");
    await until(() => started && !h.controller.loading);
    h.controller.select(29);
    const selected = h.controller.selected!.block.id;
    const order = h.controller.matches.map(match => match.block.id);
    pending.resolve(visibleGotoResults({...candidates, matches: [...candidates.matches].reverse(), semantic: {status: "ranked"}}));
    await until(() => !h.controller.ranking);
    expect(h.controller.selected!.block.id).toBe(selected);
    expect(h.controller.matches.map(match => match.block.id)).toEqual(order);
    await h.controller.cancel();
  });
  test("late preview cannot overwrite a new query preview", async () => {
    const pending = Promise.withResolvers<Block>();
    let started = false;
    const h = harness(undefined, id => id === "river-note" ? (started = true, pending.promise) : notes.find(note => note.id === id));
    h.controller.start(); h.controller.paste("browser");
    await until(() => started);
    await h.controller.cancel(); h.controller.start(); h.controller.paste("workboard");
    await until(() => !!h.controller.preview);
    pending.resolve(notes[0]!); await sleep(10);
    expect(h.controller.preview!.canonicalText).toContain("How this workboard works");
    await h.controller.cancel();
  });
  test("a deleted candidate cannot navigate on accept", async () => {
    const h = harness(undefined, () => ({...notes[0]!, deletedAt: "now"}));
    h.controller.start(); h.controller.paste("browser");
    await until(() => !h.controller.loading);
    await h.controller.accept("tree");
    expect(h.opened).toEqual([]); expect(h.controller.status).toContain("no longer available");
    await h.controller.cancel();
  });
  test("input capacity never splits an emoji or combining grapheme", async () => {
    for (const suffix of ["😀", "e\u0301"]) {
      const h = harness(); h.controller.start(); h.controller.paste("a".repeat(499) + suffix);
      expect(h.controller.query).toBe("a".repeat(499));
      await h.controller.input(suffix, {});
      expect(h.controller.query).toBe("a".repeat(499));
      await h.controller.cancel();
    }
  });
  test("long previews are explicitly bounded and disclose omitted content", async () => {
    const text = "Long document\n\n" + "A paragraph of original text.\n\n".repeat(1000);
    const document = await loadDetailReadPreview({async request<T>(input: RequestInput) { if(input.action === "references.resolve") return {text: input.text, references: []} as T; throw new Error(input.action); }}, block("long", text), 12000);
    expect(document.truncated).toBe(true); expect(document.canonicalText.length).toBeLessThanOrEqual(12000);
    const h = harness(); h.controller.preview = document;
    initTheme(undefined, false);
    expect(stripTerminalSequences(renderGotoFrame(h.controller, 120, 26, "Enter go").join("\n"))).toContain("Preview shortened");
  });
  test("renders results and actual preview at narrow/wide widths with no terminal injection", async () => {
    initTheme(undefined, false);
    const h = harness(); h.controller.start(); h.controller.paste("browser");
    await until(() => !!h.controller.preview);
    for (const width of [24, 40, 80, 120]) {
      const lines = renderGotoFrame(h.controller, width, 26, "Enter go · Esc cancel");
      expect(lines).toHaveLength(26);
      expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
      const text = stripTerminalSequences(lines.join("\n"));
      expect(text).toContain("Go to"); expect(text).toContain("Detail river");
    }
    h.controller.paste("\x1b]52;;malicious\x07");
    expect(h.controller.query).not.toContain("\x1b");
    await h.controller.cancel();
  });
});
