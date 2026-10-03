import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gotoCandidates, rankGotoWithJev } from "../src/goto-search";
import { OutlinerStore } from "../src/store";
import type { Block } from "../src/types";

// A fictional garden outline:
//   Allotment ─┬─ Spring sowing (the note being edited)
//              ├─ Seed order                (a sibling, titled like a far note)
//              └─ Beds ── Tomato bed        (a cousin's parent and a niece)
//   Kitchen ──── Recipes ── Seed order      (far away, same title)
//   Workshop ─── Gardening tools            (far)
const at = (day: number) => `2026-09-${String(day).padStart(2, "0")}T10:00:00.000Z`;
function block(id: string, text: string, parentId: string | null, day: number, author = "user"): Block {
  return { id, text, parentId, revision: 1, position: 0, properties: [], author, createdAt: at(1), updatedAt: at(day) } as Block;
}
const blocks = [
  block("allotment", "Allotment", null, 2),
  block("spring", "Spring sowing\nWhat goes in the ground first.", "allotment", 3),
  block("near-seed", "Seed order", "allotment", 4),
  block("beds", "Beds\nLinks ((far-seed)) for the soup.", "allotment", 5),
  block("tomato", "Tomato bed", "beds", 6),
  block("kitchen", "Kitchen", null, 7),
  block("recipes", "Recipes", "kitchen", 8),
  block("far-seed", "Seed order", "recipes", 20),
  block("workshop", "Workshop garden", null, 9, "agent"),
  block("tools", "Gardening tools\nThe spade lives here.", "workshop", 10),
];
const ids = (query: string, contextBlockId?: string) => gotoCandidates(blocks, query, { contextBlockId }).matches.map(match => match.block.id);

describe("search from a note", () => {
  test("two notes with the same title: the sibling first, though the far one is newer", () => {
    expect(ids("seed order").slice(0, 2)).toEqual(["far-seed", "near-seed"]);
    expect(ids("seed order", "spring").slice(0, 2)).toEqual(["near-seed", "far-seed"]);
  });

  test("a far match as typed still beats a near typo", () => {
    // From the tomato bed, "garden tools": nothing near holds it; "Gardn tools" is far but every word
    // of the query is there only within a typo, so "Workshop garden" (far, one term as typed) is not lifted
    // above it, and no near note jumps a rung.
    const kinds = gotoCandidates(blocks, "seed order", { contextBlockId: "tomato" }).matches.map(match => match.block.id);
    expect(kinds.slice(0, 2)).toEqual(["near-seed", "far-seed"]);
    const near = [...blocks, block("near-typo", "Sed ordr", "allotment", 30)];
    expect(gotoCandidates(near, "seed order", { contextBlockId: "spring" }).matches.map(match => match.block.id).slice(0, 3)).toEqual(["near-seed", "far-seed", "near-typo"]);
  });

  test("inside a rung, a title match is not reordered below a nearer, newer mention in a body", () => {
    // From the spring note, "gardning tools" (a typo): "Shed notes" (a sibling, newest) has the words in its body
    // only; "Gardening tools" (far) has them in its title. Both are typo-terms; the title wins.
    const mention = [...blocks, block("shed-notes", "Shed notes\nThe gardening tools hang by the door.", "allotment", 31)];
    const ranked = gotoCandidates(mention, "gardning tools", { contextBlockId: "spring" }).matches.map(match => match.block.id);
    expect(ranked.slice(0, 2)).toEqual(["tools", "shed-notes"]);
  });

  test("without a context note the order is today's", () => {
    expect(gotoCandidates(blocks, "seed order").context).toBeUndefined();
    expect(gotoCandidates(blocks, "seed order", { contextBlockId: "spring" }).context).toEqual({ blockId: "spring", title: "Spring sowing", path: "Allotment" });
  });

  test("an empty query lists what the parent and siblings link to, then near notes, then the person's edits", () => {
    const listed = gotoCandidates(blocks, "", { contextBlockId: "spring" }).matches;
    expect(listed.map(match => [match.block.id, match.reason])).toEqual([
      ["far-seed", "linked"],
      ["tomato", "near"], ["beds", "near"], ["near-seed", "near"], ["allotment", "near"],
      ["tools", "yours"], ["recipes", "yours"], ["kitchen", "yours"],
    ]);
  });
});

test("Jev's state carries the note being edited", async () => {
  let state: unknown;
  // Not the exact title: Jev never reorders an exact match, so it is not asked.
  const candidates = gotoCandidates(blocks, "seed ordr", { contextBlockId: "spring" });
  await rankGotoWithJev("seed ordr", candidates, {
    apiKey: "fixture", note: { title: candidates.context!.title, path: candidates.context!.path },
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body as string);
      state = body.state;
      return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map(key => [key, { type: "score", score: 1 }])) });
    },
  });
  expect(state).toEqual({ query: "seed ordr", note: { title: "Spring sowing", path: "Allotment" } });
});

describe("pages.complete", () => {
  test("ranks addresses forgivingly, nearer the note first inside a rung", () => {
    const dir = mkdtempSync(join(tmpdir(), "search-context-"));
    try {
      const store = new OutlinerStore(join(dir, "outline.sqlite"), { workspaceRoot: dir });
      const garden = store.create("Garden");
      const edited = store.create("Sowing plan", garden.id);
      const near = store.create("Fat cats in party hats [page::party-hats-garden]", garden.id);
      const far = store.create("Party hats for the shed [page::party-hats-shed]");
      const addresses = (query: string | undefined, context?: string) => store.completePageAddresses(query, 10, context).addresses.map(address => address.address);
      expect(addresses("party hats")).toEqual(["party-hats-garden", "party-hats-shed"]);
      expect(addresses("party hast").sort()).toEqual(["party-hats-garden", "party-hats-shed"]);
      // The Work ID or page is found by its note's title; "cats" is a typo of "hats", so the shed page holds all but one term.
      expect(addresses("fat cats")).toEqual(["party-hats-garden", "party-hats-shed"]);
      expect(addresses("hats", far.id)).toEqual(["party-hats-shed", "party-hats-garden"]);
      expect(addresses("hats", edited.id)).toEqual(["party-hats-garden", "party-hats-shed"]);
      expect(addresses(undefined, edited.id)[0]).toBe("party-hats-garden");
      expect(near.id).toBeTruthy();
      store.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

test("over the socket: tree.search and pages.complete take the note, ping names the matcher", async () => {
  const { OutlinerServer } = await import("../src/server");
  const { OutlinerClient } = await import("../src/client");
  const { SEARCH_MATCH_VERSION } = await import("../src/search-match");
  const dir = mkdtempSync(join(tmpdir(), "search-socket-"));
  const key = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  const store = new OutlinerStore(join(dir, "outline.sqlite"), { workspaceRoot: dir });
  const server = new OutlinerServer(store, join(dir, "s.sock"));
  await server.start();
  const client = new OutlinerClient(join(dir, "s.sock"));
  try {
    const garden = store.create("Garden");
    const edited = store.create("Sowing plan", garden.id);
    store.create("Seed order [page::seed-order-garden]", garden.id);
    store.create("Seed order [page::seed-order-kitchen]");
    const ping = await client.request<{ capabilities: string[]; searchMatch: { version: number } }>({ action: "ping" });
    expect(ping.capabilities).toEqual(expect.arrayContaining(["search.forgiving", "search.context", "ping.searchMatch"]));
    expect(ping.searchMatch).toEqual({ version: SEARCH_MATCH_VERSION });
    const searched = await client.request<{ matches: { title: string }[]; context: { blockId: string } }>({ action: "tree.search", query: "sed ordr", contextBlockId: edited.id });
    expect(searched.context.blockId).toBe(edited.id);
    const pages = await client.request<{ addresses: { address: string }[]; semantic: { status: string } }>({ action: "pages.complete", query: "sed ordr", limit: 5, semantic: true, contextBlockId: edited.id });
    expect(pages.addresses.map(address => address.address)).toEqual(["seed-order-garden", "seed-order-kitchen"]);
    expect(pages.semantic.status).toBe("unavailable");
    await expect(client.request({ action: "pages.complete", query: "x", limit: 5, semantic: "yes" } as never)).rejects.toThrow(/semantic/);
  } finally {
    if (key !== undefined) process.env.TYPESAFE_API_KEY = key;
    await server.close(); store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
