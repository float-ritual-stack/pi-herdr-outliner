import { describe, expect, test } from "bun:test";
import {
  matchesSearchText, rankTextSearchMatches, searchFold, typoBudget, typoDistance, type SearchDocument,
} from "../src/search-match";

// Fictional notes.
const doc = (id: string, title: string, body = ""): SearchDocument => ({ id, title, text: body ? `${title}\n${body}` : title });
const hats = doc("11111111-aaaa-4aaa-8aaa-111111111111", "PIE-333 Fat cats in party hats", "Streamers for the garden shed.");
const cast = doc("22222222-bbbb-4bbb-8bbb-222222222222", "Cast list for the spring play");
const claude = doc("33333333-cccc-4ccc-8ccc-333333333333", "Claude - now", "What the agent is doing this minute.");
const dash = doc("44444444-dddd-4ddd-8ddd-444444444444", "Claude—now board");
const hasNote = doc("55555555-eeee-4eee-8eee-555555555555", "The shed has a party light");
const docs = [hats, cast, claude, dash, hasNote];
const top = (query: string) => rankTextSearchMatches(docs, query, 10);
const ids = (query: string) => top(query).map(match => match.document.id);

describe("folding", () => {
  test("punctuation, dashes and case fold to single spaces", () => {
    expect(searchFold("Claude - now")).toBe("claude now");
    expect(searchFold("Claude—now")).toBe("claude now");
    expect(searchFold("Claude – now · later_on/today")).toBe("claude now later on today");
    expect(searchFold("Don't  STOP")).toBe("dont stop");
  });
});

describe("typo distance", () => {
  test("a swap is one edit, and the start of a longer word counts", () => {
    expect(typoDistance("hast", "hats", 1)).toBe(1);
    expect(typoDistance("cluade", "claude", 1)).toBe(1);
    expect(typoDistance("cluad", "claudes", 1)).toBe(1);
    expect(typoDistance("hast", "has", 1)).toBe(2);
    expect(typoDistance("party", "porty", 1)).toBe(1);
    expect(typoDistance("party", "pxrtx", 1)).toBe(2);
    expect(typoDistance("streamesr", "streamers", 2)).toBe(1);
  });

  test("budgets: none under four characters or without a letter, one to seven, then two", () => {
    expect([typoBudget("cat"), typoBudget("2026"), typoBudget("hats"), typoBudget("streamer"), typoBudget("streamers")]).toEqual([0, 0, 1, 2, 2]);
  });
});

describe("the rungs", () => {
  test("PIE-333 hats, fat cat party and party hast all find the party hats note first", () => {
    expect(top("PIE-333 hats")[0]).toMatchObject({ document: { id: hats.id }, kind: "title-terms" });
    expect(top("fat cat party")[0]).toMatchObject({ document: { id: hats.id }, kind: "title-terms" });
    expect(top("party hast")[0]).toMatchObject({ document: { id: hats.id }, kind: "typo-terms" });
  });

  test("punctuation never decides: claude now, Claude—now and cluade now find Claude - now", () => {
    expect(top("claude now")[0]).toMatchObject({ document: { id: claude.id }, kind: "exact-title" });
    expect(top("Claude—now")[0]).toMatchObject({ document: { id: claude.id }, kind: "exact-title" });
    expect(top("cluade now").slice(0, 2).map(match => [match.document.id, match.kind])).toEqual([
      [claude.id, "typo-terms"], [dash.id, "typo-terms"],
    ]);
  });

  test("a typo never outranks a word as typed: cats puts fat cats above cast", () => {
    const ranked = top("cats");
    expect(ranked.map(match => match.document.id).slice(0, 2)).toEqual([hats.id, cast.id]);
    expect(ranked[1]!.kind).toBe("typo-terms");
  });

  test("every typed term outranks typos, which outrank all but one term", () => {
    // "shed party": both typed in two notes; "shed partty": a typo; "shed party zebra": all but one.
    expect(top("shed party").slice(0, 2).map(match => match.kind)).toEqual(["title-terms", "text-terms"]);
    expect(top("shed partty")[0]!.kind).toBe("typo-terms");
    const partial = top("shed party zebra");
    expect(partial.map(match => match.kind).slice(0, 2)).toEqual(["partial-terms", "partial-terms"]);
    expect(new Set(ids("shed party zebra").slice(0, 2))).toEqual(new Set([hasNote.id, hats.id]));
  });

  test("short terms, numbers and short words match only as typed", () => {
    // "334" is a number: no typo reaches 333, so PIE-334 holds all but one term.
    expect(top("PIE-334").map(match => [match.document.id, match.kind])).toEqual([[hats.id, "partial-terms"]]);
    expect(top("hat")[0]).toMatchObject({ document: { id: hats.id }, kind: "title-contains" });
    // "has" is too short to be a typo of "hast": only the hats note holds every term.
    expect(top("party hast").map(match => match.kind).slice(0, 2)).toEqual(["typo-terms", "partial-terms"]);
  });

  test("exact ids, id prefixes and exact titles keep their rungs", () => {
    expect(top(hats.id)[0]!.kind).toBe("exact-id");
    expect(top("1111111")[0]!.kind).toBe("id-prefix");
    expect(top("Cast list for the spring play")[0]!.kind).toBe("exact-title");
  });

  test("a query of punctuation alone still matches as typed", () => {
    expect(rankTextSearchMatches([doc("66666666-ffff-4fff-8fff-666666666666", "Links ((here))")], "((", 5)[0]!.kind).toBe("title-contains");
  });
});

describe("list filters", () => {
  test("match a phrase, every term in any order and field, within typo budgets unless asked not to", () => {
    expect(matchesSearchText("", ["anything"])).toBe(true);
    expect(matchesSearchText("claude now", ["Claude - now"])).toBe(true);
    expect(matchesSearchText("hats party", ["PIE-333", "Fat cats in party hats"])).toBe(true);
    expect(matchesSearchText("party hast", ["Fat cats in party hats"])).toBe(true);
    expect(matchesSearchText("party hast", ["Fat cats in party hats"], { typos: false })).toBe(false);
    expect(matchesSearchText("party zebra", ["Fat cats in party hats"])).toBe(false);
  });
});
