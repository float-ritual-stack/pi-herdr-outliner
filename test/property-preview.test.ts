import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutlinerClient, type RequestInput } from "../src/client";
import { PROPERTY_PARSER_VERSION } from "../src/properties";
import { OutlinerServer } from "../src/server";
import { OutlinerStore } from "../src/store";
import type { PropertyParsePreview, VisibleBlockCollection } from "../src/types";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function startService() {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-property-preview-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  const socket = join(directory, "outliner.sock");
  const server = new OutlinerServer(store, socket);
  await server.start();
  cleanups.push(async () => {
    await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, client: new OutlinerClient(socket) };
}

const drafts = {
  trailing: "Card title [stage::queued]",
  typedAfterTrailing: "Card title [stage::queued] still typing",
  preamble: "Card title\n[type::note] [stage::doing]\n\nBody mentions [owner::sam] inline",
  lineScoped: "Card title\n\nSome prose\nfollow-up:: later",
  literal: "Card title `[stage::queued]`",
};

test("previews block properties and token placement with the save-time parser", async () => {
  const { client } = await startService();
  const preview = (text: string) => client.request<PropertyParsePreview>({ action: "properties.preview", text });

  const trailing = await preview(drafts.trailing);
  expect(trailing.parserVersion).toBe(PROPERTY_PARSER_VERSION);
  expect(trailing.properties).toEqual([{ key: "stage", value: "queued" }]);
  expect(trailing.tokens).toMatchObject([{
    key: "stage", value: "queued", raw: "[stage::queued]", ordinal: 0,
    line: 0, column: 11, start: 11, end: 26,
    placement: "trailing-metadata", scope: "block", syntax: "bracket",
  }]);

  // Text typed after a trailing subject token turns it into inline prose.
  const typed = await preview(drafts.typedAfterTrailing);
  expect(typed.properties).toEqual([]);
  expect(typed.tokens).toMatchObject([{ key: "stage", placement: "inline", scope: "inline", line: 0 }]);

  const preamble = await preview(drafts.preamble);
  expect(preamble.properties).toEqual([{ key: "type", value: "note" }, { key: "stage", value: "doing" }]);
  expect(preamble.tokens.map(({ key, line, placement, scope }) => ({ key, line, placement, scope }))).toEqual([
    { key: "type", line: 1, placement: "metadata-line", scope: "block" },
    { key: "stage", line: 1, placement: "metadata-line", scope: "block" },
    { key: "owner", line: 3, placement: "inline", scope: "inline" },
  ]);

  const lineScoped = await preview(drafts.lineScoped);
  expect(lineScoped.properties).toEqual([]);
  expect(lineScoped.tokens).toMatchObject([{ key: "follow-up", value: "later", syntax: "bare", scope: "line", line: 3 }]);

  expect(await preview(drafts.literal)).toEqual({ parserVersion: PROPERTY_PARSER_VERSION, properties: [], tokens: [] });
});

test("preview agrees with what a save indexes and changes nothing", async () => {
  const { store, client } = await startService();
  const existing = store.create("Existing card [stage::queued]");
  const readIds = async () => (await client.request<VisibleBlockCollection>({
    action: "blocks.query", query: { limit: 1000 },
  })).blocks.map((block) => block.id);
  const idsBefore = await readIds();
  const sequenceBefore = store.sequence;

  const previews: PropertyParsePreview[] = [];
  for (const text of Object.values(drafts)) {
    previews.push(await client.request<PropertyParsePreview>({ action: "properties.preview", text }));
  }
  expect(store.sequence).toBe(sequenceBefore);
  expect(await readIds()).toEqual(idsBefore);
  expect(store.require(existing.id).revision).toBe(existing.revision);

  // Saving the same drafts indexes exactly the previewed block properties.
  for (const [index, text] of Object.values(drafts).entries()) {
    expect(store.create(text).properties).toEqual(previews[index]!.properties);
  }
});

test("rejects a preview without text", async () => {
  const { client } = await startService();
  await expect(
    client.request({ action: "properties.preview" } as unknown as RequestInput),
  ).rejects.toThrow("properties.preview requires text");
});
