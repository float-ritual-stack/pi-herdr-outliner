import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { OutlinerClient } from "../src/client";
import { renderDetailReadPreviewLines } from "../src/detail-pi-preview";
import { presentReaderHeadings } from "../src/document-presentation";
import { generatedDocument, observeDocument, sliceDocument, sourceDocument } from "../src/document-provenance";
import {
  parseProperties,
  parsePropertyRecords,
  PROPERTY_PARSER_VERSION,
  scanLiteralRegions,
  stripPropertyTokens,
} from "../src/properties";
import { readSavedView } from "../src/saved-view-read";
import { OutlinerServer } from "../src/server";
import { OutlinerStore } from "../src/store";
import { sanitizeDynamicText } from "../src/terminal";
import type { Block, PropertyParsePreview, VisibleBlockCollection } from "../src/types";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function makeStore(): { store: OutlinerStore; directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-literal-regions-"));
  const path = join(directory, "outliner.sqlite");
  const fixture = { store: new OutlinerStore(path), directory, path };
  cleanups.push(() => {
    fixture.store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return fixture;
}

const tokens = (text: string) => parsePropertyRecords(text).map(({ key, value, scope }) => `${key}=${value}:${scope}`);

// A brief that shows outline syntax as prose: nothing between the markers is metadata.
const brief = [
  "Property syntax brief [type::note]",
  "",
  "<!-- literal -->",
  "Write `[stage::queued]` as [stage::queued] on the subject line.",
  "stage:: doing",
  "Tag it #example-tag.",
  "<!-- /literal -->",
  "",
  "owner:: sam",
].join("\n");

test("a literal region contributes no bracket, bare or hashtag properties", () => {
  expect(tokens(brief)).toEqual(["type=note:block", "owner=sam:line"]);
  expect(parseProperties(brief)).toEqual([{ key: "type", value: "note" }]);
  // Stripping tokens leaves the region's examples as authored text.
  expect(stripPropertyTokens(brief)).toContain("[stage::queued] on the subject line.\nstage:: doing\nTag it #example-tag.");
});

test("markers stand alone on a line, tolerate spacing and case, and do not nest", () => {
  for (const [open, close] of [
    ["<!--literal-->", "<!--/literal-->"],
    ["   <!--  LITERAL  -->  ", "<!-- /Literal -->\t"],
  ]) {
    expect(tokens(`Title\n${open}\n[a::1]\n${close}\n[b::2]`)).toEqual(["b=2:inline"]);
  }
  // Four spaces is indented code, and trailing prose makes it an ordinary line.
  expect(scanLiteralRegions("Title\n    <!-- literal -->\n[a::1]\n<!-- /literal -->").regions).toEqual([]);
  expect(tokens("Title\n    <!-- literal -->\n[a::1]\n<!-- /literal -->")).toEqual(["a=1:inline"]);
  expect(tokens("Title\n<!-- literal --> note\n[a::1]\n<!-- /literal -->")).toEqual(["a=1:inline"]);
  // A second opener is text; the first closer ends the region.
  expect(tokens("T\n<!-- literal -->\n<!-- literal -->\n[a::1]\n<!-- /literal -->\n[b::2]\n<!-- /literal -->"))
    .toEqual(["b=2:inline"]);
  // A stray closer protects nothing.
  expect(tokens("Title\n<!-- /literal -->\n[a::1]")).toEqual(["a=1:inline"]);
  // CRLF notes behave the same.
  expect(tokens("Title\r\n<!-- literal -->\r\n[a::1]\r\n<!-- /literal -->\r\n[b::2]")).toEqual(["b=2:inline"]);
});

test("fences inside regions keep their content and hide a closer they contain", () => {
  const fenceInRegion = [
    "Title",
    "<!-- literal -->",
    "```md",
    "<!-- /literal -->",
    "```",
    "[a::1]",
    "<!-- /literal -->",
    "[b::2]",
  ].join("\n");
  expect(tokens(fenceInRegion)).toEqual(["b=2:inline"]);

  // A fence opened inside a region and never closed runs to the end, so the
  // closer is code: the region is unterminated and skips nothing.
  const unclosedFence = "Title\n<!-- literal -->\n```\n[a::1]\n<!-- /literal -->\nafter:: x";
  expect(scanLiteralRegions(unclosedFence)).toMatchObject({ regions: [], unterminated: { start: 6 } });
  expect(tokens(unclosedFence)).toEqual([]);
});

test("markers inside a fence are code, not a region", () => {
  const regionInFence = "Title\n```\n<!-- literal -->\n```\n[a::1]\n```\n<!-- /literal -->\n```";
  expect(scanLiteralRegions(regionInFence)).toEqual({ regions: [], unterminated: null });
  expect(tokens(regionInFence)).toEqual(["a=1:inline"]);
});

test("inline code does not pair backticks across a region boundary", () => {
  const text = "Title\n<!-- literal -->\nopen ` here\n<!-- /literal -->\nclose ` [a::1]\n[b::2]";
  // The trailing backtick outside is unmatched, so only the rest of its own line is code.
  expect(tokens(text)).toEqual(["b=2:inline"]);
});

test("a region on the subject line or in the preamble keeps its properties out", () => {
  const onSubject = "<!-- literal -->\nTitle [a::1]\n<!-- /literal -->\n[b::2]";
  expect(tokens(onSubject)).toEqual(["b=2:inline"]);

  const inPreamble = "Title\n[type::note]\n<!-- literal -->\n[stage::queued]\n<!-- /literal -->\n[owner::sam]";
  expect(tokens(inPreamble)).toEqual(["type=note:block", "owner=sam:inline"]);

  // A marker line ends the property-only run after the subject.
  const beforePreamble = "Title\n<!-- literal -->\nx:: y\n<!-- /literal -->\n[type::note]";
  expect(tokens(beforePreamble)).toEqual(["type=note:inline"]);
});

test("an unterminated region skips nothing and is reported", () => {
  const text = "Title\n\n<!-- literal -->\n[a::1]\nkey:: value\nSee #tag";
  expect(scanLiteralRegions(text)).toEqual({ regions: [], unterminated: { start: 7, end: 23 } });
  expect(tokens(text)).toEqual(["a=1:inline", "key=value:line", "tag=tag:block"]);
});

test("saves, blocks.query, views.read and properties.preview agree on a literal region", async () => {
  const { store, directory } = makeStore();
  const socket = join(directory, "outliner.sock");
  const server = new OutlinerServer(store, socket);
  await server.start();
  cleanups.push(() => server.close());
  const client = new OutlinerClient(socket);

  const note = await client.request<Block>({ action: "create", text: brief });
  const real = await client.request<Block>({ action: "create", text: "Real card [stage::queued]" });
  expect(note.properties).toEqual([{ key: "type", value: "note" }]);

  const preview = await client.request<PropertyParsePreview>({ action: "properties.preview", text: brief });
  expect(preview.parserVersion).toBe(PROPERTY_PARSER_VERSION);
  expect(preview.properties).toEqual(note.properties);
  expect(preview.tokens.map(token => token.key)).toEqual(["type", "owner"]);

  const query = async (expression: string) => (await client.request<VisibleBlockCollection>({
    action: "blocks.query", query: { expression, limit: 100 },
  })).blocks.map(block => block.id);
  expect(await query("stage=queued")).toEqual([real.id]);
  expect(await query("stage")).toEqual([real.id]);
  expect(await query("tag=example-tag")).toEqual([]);

  const view = await client.request<Block>({ action: "create", text: "Queued [type::virtual-branch] [query::stage=queued]" });
  expect((await readSavedView(client, view.id)).blocks.map(block => block.id)).toEqual([real.id]);
});

test("links inside a literal region still resolve", () => {
  const { store } = makeStore();
  let target = store.create("Target decision [page::Target Page]");
  store.configureWorkIdPrefix("PIE");
  target = store.allocateWorkId(target.id, target.revision).block;
  const source = store.create([
    "Source",
    "<!-- literal -->",
    `See ((${target.id})), [[Target Page]] and PIE-001 [stage::queued]`,
    "<!-- /literal -->",
  ].join("\n"));
  expect(source.properties).toEqual([]);
  const backlinks = store.queryBacklinks({ targetBlockId: target.id, limit: 10 });
  expect(backlinks.sources.map(entry => entry.blockId)).toEqual([source.id]);
  expect(backlinks.sources[0]!.occurrences.map(occurrence => occurrence.kind)).toEqual(["block", "page", "work-id"]);
});

test("startup on a version-three workspace re-indexes regions without rewriting notes, idempotently", () => {
  const fixture = makeStore();
  const original = fixture.store.create(brief);
  // Simulate the index a version-three parser wrote for this note.
  fixture.store.database.exec(`
    INSERT INTO block_properties (block_id, key, value, ordinal, raw, start, end, line, column, placement, scope, syntax)
    VALUES ('${original.id}', 'stage', 'queued', 9, '[stage::queued]', 0, 0, 3, 0, 'trailing-metadata', 'block', 'bracket');
    UPDATE metadata SET value = '3' WHERE key = 'property_parser_version';
  `);
  expect(fixture.store.queryBlocks({ filters: [{ key: "stage" }], limit: 20 }).blocks.map(block => block.id))
    .toEqual([original.id]);
  const before = fixture.store.sequence;
  fixture.store.close();

  fixture.store = new OutlinerStore(fixture.path);
  expect(fixture.store.require(original.id)).toEqual(original);
  expect(fixture.store.queryBlocks({ filters: [{ key: "stage" }], limit: 20 }).blocks).toEqual([]);
  expect(fixture.store.database.query("SELECT value FROM metadata WHERE key = 'property_parser_version'").get())
    .toEqual({ value: String(PROPERTY_PARSER_VERSION) });
  expect(fixture.store.sequence).toBe(before + 1);
  fixture.store.close();

  fixture.store = new OutlinerStore(fixture.path);
  expect(fixture.store.sequence).toBe(before + 1);
  expect(fixture.store.require(original.id)).toEqual(original);
});

test("Detail hides the markers, keeps line numbers and renders the region as ordinary text", () => {
  const text = "<!-- literal -->\nTitle [a::1]\n<!-- /literal -->\nBody *emphasis*";
  const observed = observeDocument({ kind: "block", blockId: "synthetic-literal" }, text, 1);
  const presented = presentReaderHeadings(sourceDocument(observed));
  // The first visible line becomes the title; marker lines become blank lines.
  expect(presented.text).toBe("\n# Title [a::1]\n\nBody *emphasis*");
  const title = sliceDocument(presented, 3, 8).runs[0]!.origin;
  expect(title.kind === "source" && title.slices.map(slice => [slice.start, slice.end])).toEqual([[17, 22]]);

  initTheme("dark");
  const render = (value: string) => renderDetailReadPreviewLines({
    canonicalText: value, resolvedText: value, projectedText: value, embedRanges: [], workIdPrefix: null,
  }, 80, getMarkdownTheme()).map(line => sanitizeDynamicText(line).trimEnd()).filter(Boolean);
  const lines = render(brief);
  expect(lines.join("\n")).not.toContain("literal -->");
  expect(lines).toContain("stage:: doing");
  expect(lines.some(line => line.includes("as [stage::queued] on the subject line."))).toBe(true);
  expect(lines.join("\n")).not.toContain("no closing");
});

test("Detail warns about an unterminated region and leaves its marker visible", () => {
  const presented = presentReaderHeadings(generatedDocument("Title\n<!-- literal -->\n[a::1]", "test"));
  expect(presented.text.split("\n").slice(0, 3)).toEqual(["# Title", "<!-- literal -->", "[a::1]"]);
  expect(presented.text).toContain("> ⚠ A `<!-- literal -->` region has no closing `<!-- /literal -->` line");
});
