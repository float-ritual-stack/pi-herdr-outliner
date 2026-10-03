/**
 * The one text matcher every search uses: Tree's Goto (`tree.search`), Inbox
 * history (`inbox.search`), `[[` completion (`pages.complete`), the backlink
 * filter, and the door's `((` popup, search overlay and list filters.
 *
 * It forgives what an editor, a person or a model changes without meaning to:
 * case, width, punctuation ("Claude - now", "Claude—now" and "claude now"
 * compare equal), word order, one or two typos in a longer word, and one
 * missing word. Exact evidence always ranks first: a typo or a missing word
 * never puts a note above one that holds every word as typed.
 *
 * It imports nothing, because the door filters lists it already holds with
 * it on every key: ep0ch-door keeps this file byte for byte in
 * `src/vendor/search-match.ts` (checked by its tests). Bump
 * `SEARCH_MATCH_VERSION` with any change to what matches or how it ranks;
 * `ping` reports it (`ping.searchMatch`).
 *
 * The rungs, best first (a document scores on the first rung it reaches):
 *
 * | kind            | score          | when                                                         |
 * |-----------------|----------------|--------------------------------------------------------------|
 * | `exact-id`      | 100000         | the query is the id                                          |
 * | `id-prefix`     | 90000 + length | the id starts with the query (4 characters or more)          |
 * | `exact-title`   | 80000          | the folded title is the folded query                         |
 * | `title-prefix`  | 70000          | the folded title starts with it                              |
 * | `title-contains`| 60000          | the folded title holds it                                    |
 * | `text-contains` | 50000          | the folded text holds it                                     |
 * | `title-terms`   | 40000 + terms  | every term is in the title, in any order                     |
 * | `text-terms`    | 20000 – 31000  | every term is in the title or text                           |
 * | `typo-terms`    | 15500 – 19800  | every term matches, at least one only within its typo budget |
 * | `partial-terms` | 12200 – 15300  | all but one term match (two terms or more)                   |
 * | `some-terms`    | 12000 – 12150  | fewer match as typed, one of them 3 characters or more       |
 * | `title-fuzzy`   | 10001 – 11000  | the query's letters appear in order in the title             |
 * | `text-fuzzy`    | 5001 – 6000    | the query's letters appear in order in the text              |
 *
 * Terms are the folded query's words, without filler words ("the", "find",
 * "note"…) when anything else is left. A term matches a document word as
 * typed when the folded title or text holds it. Its typo budget is a
 * Damerau–Levenshtein distance (adjacent swaps count once) to a document
 * word or to the start of one: 1 for terms of 4–7 characters, 2 for 8 or
 * more; shorter terms, and terms without a letter (numbers, dates), must
 * match as typed, and a word under 4 characters is never a typo's match.
 */

export const SEARCH_MATCH_VERSION = 1;

/** The rungs, best first. A rung is a tier: no ordering inside one (nearness, recency) lifts a match above it. */
export const SEARCH_MATCH_KINDS = [
  "exact-id",
  "id-prefix",
  "exact-title",
  "title-prefix",
  "title-contains",
  "text-contains",
  "title-terms",
  "text-terms",
  "typo-terms",
  "partial-terms",
  "some-terms",
  "title-fuzzy",
  "text-fuzzy",
] as const;
export type SearchMatchKind = (typeof SEARCH_MATCH_KINDS)[number];

export interface SearchDocument { id: string; title: string; text: string }
export interface TextSearchMatch<T> {
  document: T;
  kind: SearchMatchKind;
  score: number;
  title: string;
  /** The share of the query found in the title (0–1): inside a rung, the quality a context never reorders across. */
  inTitle: number;
  /** Typo edits it took (`typo-terms`, `partial-terms`): fewer is better, which a context never reorders across either. */
  edits?: number;
}

// Search prose often contains words absent from the remembered note's title.
const QUERY_FILLER = new Set("a an the that this those these it its of on in at to for with and or about where when how i we my our was is are were be been thing things note page block please find show me what did does do would could should can have has had will then again something some any using get got".split(" "));

/** Case and width folded, whitespace collapsed: the form ids and punctuation-only queries compare in. */
export function searchNormalize(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * `searchNormalize`, with apostrophes dropped ("don't" is "dont") and every other run of punctuation,
 * symbols and spaces made one space: "Claude - now", "Claude—now" and "claude/now" fold to "claude now".
 */
export function searchFold(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/['’ʼ]/g, "").replace(/[^\p{L}\p{M}\p{N}]+/gu, " ").trim();
}

/**
 * The words `blocks.query` `text` requires, each as a case-folded substring of a note's text (SQLite's `INSTR` on
 * `LOWER(text)` and the same in memory): split where `searchFold` splits, but with apostrophes kept, since the
 * stored text isn't folded. A query of punctuation alone is one term as typed.
 */
export function searchTextTerms(value: string): string[] {
  const lower = value.normalize("NFKC").toLowerCase();
  const terms = lower.split(/[^\p{L}\p{M}\p{N}'’ʼ]+/u).map(term => term.replace(/^['’ʼ]+|['’ʼ]+$/g, "")).filter(Boolean);
  return terms.length ? [...new Set(terms)] : lower.trim() ? [lower.trim()] : [];
}

/** The letters of `query` in order in `candidate`: 1000 less the gaps and the extra length, or 0. */
export function subsequenceScore(query: string, candidate: string): number {
  if (!query || query.length > candidate.length) return 0;
  let queryIndex = 0;
  let previousMatch = -1;
  let gaps = 0;
  for (let index = 0; index < candidate.length && queryIndex < query.length; index += 1) {
    if (candidate[index] !== query[queryIndex]) continue;
    if (previousMatch >= 0) gaps += index - previousMatch - 1;
    previousMatch = index;
    queryIndex += 1;
  }
  if (queryIndex !== query.length || gaps > query.length * 2) return 0;
  return Math.max(1, 1_000 - gaps - Math.max(0, candidate.length - query.length));
}

/** Neither a term nor the word (or start of a word) it matches with a typo is shorter than this. */
const TYPO_MIN_LENGTH = 4;

/** How many edits a term may be off by: none under 4 characters or without a letter, 1 to 7, then 2. */
export function typoBudget(term: string): number {
  if (term.length < TYPO_MIN_LENGTH || !/\p{L}/u.test(term)) return 0;
  return term.length < 8 ? 1 : 2;
}

/**
 * The Damerau–Levenshtein distance (optimal string alignment: an adjacent swap is one edit) from `term`
 * to `word` or, for a term of 5 characters or more, to the start of `word` (4 characters or more), whichever
 * is less, or `max + 1` once it is sure to be more than `max`. A word under 4 characters is never a typo of
 * anything. (A 4-letter term against word starts would match half the dictionary: "form" in "foreign".)
 */
export function typoDistance(term: string, word: string, max: number): number {
  const m = term.length, shortest = Math.max(TYPO_MIN_LENGTH, m - max);
  if (word.length < shortest) return max + 1;
  const n = Math.min(word.length, m + max);
  let before = new Array<number>(n + 1), previous = new Array<number>(n + 1), current = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) previous[j] = j;
  for (let i = 1; i <= m; i++) {
    current[0] = i;
    let least = i;
    for (let j = 1; j <= n; j++) {
      const cost = term[i - 1] === word[j - 1] ? 0 : 1;
      let d = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
      if (i > 1 && j > 1 && term[i - 1] === word[j - 2] && term[i - 2] === word[j - 1]) d = Math.min(d, before[j - 2]! + 1);
      current[j] = d;
      if (d < least) least = d;
    }
    if (least > max) return max + 1;
    [before, previous, current] = [previous, current, before];
  }
  let best = max + 1;
  if (m < 5) return word.length > n ? max + 1 : Math.min(previous[n]!, max + 1);
  for (let j = shortest; j <= n; j++) if (previous[j]! < best) best = previous[j]!;
  return best;
}

// ── preparation, cached by the text itself ──────────────────────────────────────────────────────

/**
 * A cache of `compute(key)` by key, kept for the keys seen in the last two generations of `size` misses: what
 * every search reads again (each note's folded text and words) is folded once, and an edited note's old text
 * ages out. Keyed by the string itself, so a stale entry can never answer for changed text.
 */
export function searchMemo<T>(compute: (key: string) => T, size = 20_000): (key: string) => T {
  let current = new Map<string, T>(), previous = new Map<string, T>();
  return (key: string) => {
    let value = current.get(key);
    if (value !== undefined) return value;
    value = previous.get(key);
    if (value === undefined) value = compute(key);
    if (current.size >= size) { previous = current; current = new Map(); }
    current.set(key, value);
    return value;
  };
}

interface Field { folded: string; words: string[] | null }
// Two keys per note (its title and text), so 50,000 a generation holds an outline of ~25,000 notes warm.
const field = searchMemo<Field>(value => ({ folded: searchFold(value), words: null }), 50_000);
function words(f: Field): string[] {
  return f.words ??= [...new Set(f.folded.split(" "))].filter(Boolean);
}

/** A query, prepared once for every document it is matched against. */
export interface SearchQuery {
  /** `searchNormalize`d: what ids compare against. */
  raw: string;
  /** The folded query, or the raw one when folding leaves nothing (a query of punctuation, `((` or `#`). */
  phrase: string;
  folded: boolean;
  terms: string[];
  budgets: number[];
  /** Each term's distance to each document word seen so far. */
  distances: Map<string, number>[];
}

export function prepareSearchQuery(query: string): SearchQuery | null {
  const raw = searchNormalize(query);
  if (!raw) return null;
  const folded = searchFold(query);
  const all = folded ? folded.split(" ") : [];
  const useful = all.filter(term => term.length >= 2 && !QUERY_FILLER.has(term));
  const terms = useful.length ? useful : all;
  return { raw, phrase: folded || raw, folded: !!folded, terms, budgets: terms.map(typoBudget), distances: terms.map(() => new Map()) };
}

function closest(q: SearchQuery, index: number, f: Field): number {
  const term = q.terms[index]!, max = q.budgets[index]!, seen = q.distances[index]!;
  let best = max + 1;
  for (const word of words(f)) {
    let d = seen.get(word);
    if (d === undefined) seen.set(word, d = typoDistance(term, word, max));
    // A term missing as typed is at least one edit from every word: 1 is the best there is.
    if (d < best) { best = d; if (best <= 1) break; }
  }
  return best;
}

// ── ranking ─────────────────────────────────────────────────────────────────────────────────────

export function scoreSearchDocument<T extends SearchDocument>(document: T, q: SearchQuery): TextSearchMatch<T> | null {
  const title = document.title;
  const id = document.id.toLowerCase();
  if (id === q.raw) return { document, kind: "exact-id", score: 100_000, title, inTitle: 1 };
  if (q.raw.length >= 4 && id.startsWith(q.raw)) return { document, kind: "id-prefix", score: 90_000 + q.raw.length, title, inTitle: 1 };

  const titleField = field(title), textField = field(document.text);
  const titleText = q.folded ? titleField.folded : searchNormalize(title);
  const bodyText = q.folded ? textField.folded : searchNormalize(document.text);
  if (titleText === q.phrase) return { document, kind: "exact-title", score: 80_000, title, inTitle: 1 };
  if (titleText.startsWith(q.phrase)) return { document, kind: "title-prefix", score: 70_000, title, inTitle: 1 };
  if (titleText.includes(q.phrase)) return { document, kind: "title-contains", score: 60_000, title, inTitle: 1 };
  if (bodyText.includes(q.phrase)) return { document, kind: "text-contains", score: 50_000, title, inTitle: 0 };

  const n = q.terms.length;
  if (n) {
    let inTitle = 0, inText = 0, typed = 0, typos = 0, distance = 0, titled = 0, telling = 0;
    const missing: number[] = [];
    q.terms.forEach((term, index) => {
      const t = titleText.includes(term), x = bodyText.includes(term);
      if (t) inTitle++;
      if (x) inText++;
      if (t || x) { typed++; if (t) titled++; if (term.length >= 3) telling++; } else missing.push(index);
    });
    if (inTitle === n) return { document, kind: "title-terms", score: 40_000 + n, title, inTitle: 1 };
    const shortness = 1_000 / (1 + bodyText.length / 1_000);
    if (!missing.length) return { document, kind: "text-terms", score: 20_000 + (inTitle / n) * 10_000 + shortness, title, inTitle: inTitle / n };
    // Typos only reach the rungs below every term-as-typed one, so they never outrank exact evidence.
    let unmatched = 0;
    for (const index of missing) {
      if (unmatched > 1) break;
      const max = q.budgets[index]!;
      if (!max) { unmatched++; continue; }
      const t = closest(q, index, titleField);
      const d = t <= max ? t : closest(q, index, textField);
      if (d > max) { unmatched++; continue; }
      typos++;
      distance += d;
      if (t <= max) titled++;
    }
    // Within a rung: terms in the title, terms as typed, a title about as long as the query, fewer edits.
    const matched = typed + typos, penalty = Math.min(distance, 5) * 100;
    const near = shortness / 2 + 300 * (q.phrase.length / Math.max(q.phrase.length, titleText.length));
    if (matched === n) return { document, kind: "typo-terms", score: 16_000 + (titled / n) * 2_000 + (typed / n) * 1_000 + near - penalty, title, inTitle: titled / n, edits: distance };
    if (n >= 2 && matched === n - 1) return { document, kind: "partial-terms", score: 12_700 + (titled / n) * 1_000 + (typed / n) * 800 + near - penalty, title, inTitle: titled / n, edits: distance };
    // A two-letter term ("no" of "no-such-thing") is in too many words to be evidence on its own.
    if (telling > 0) return { document, kind: "some-terms", score: 12_000 + (typed / n) * 150, title, inTitle: inTitle / n };
  }
  if (q.phrase.length >= 3) {
    const titleScore = subsequenceScore(q.phrase, titleText);
    if (titleScore > 0) return { document, kind: "title-fuzzy", score: 10_000 + titleScore, title, inTitle: 1 };
    const textScore = subsequenceScore(q.phrase, bodyText);
    if (textScore > 0) return { document, kind: "text-fuzzy", score: 5_000 + textScore, title, inTitle: 0 };
  }
  return null;
}

/** Every document that matches, best first: score, then title, then id. */
export function rankTextSearchMatches<T extends SearchDocument>(documents: readonly T[], query: string, limit = Infinity): TextSearchMatch<T>[] {
  if (limit !== Infinity && (!Number.isInteger(limit) || limit <= 0)) throw new Error("Search limit must be positive");
  const q = prepareSearchQuery(query);
  if (!q) return [];
  const matches: TextSearchMatch<T>[] = [];
  for (const document of documents) {
    const match = scoreSearchDocument(document, q);
    if (match) matches.push(match);
  }
  return matches.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title) || a.document.id.localeCompare(b.document.id)).slice(0, limit);
}

/**
 * Whether a list row whose text is `fields` passes a filter of `query`: the folded query is in one field,
 * every term is in some field (each within its typo budget unless `typos` is false), or the query's letters
 * appear in one field in order and close together. An empty query passes everything.
 */
export function matchesSearchText(query: string | SearchQuery | null, fields: readonly string[], options: { typos?: boolean } = {}): boolean {
  // A list filters every row with one query: prepare it once (`prepareSearchQuery`) and pass that.
  const q = typeof query === "string" ? prepareSearchQuery(query) : query;
  if (!q) return true;
  const folded = fields.map(value => q.folded ? field(value) : { folded: searchNormalize(value), words: null });
  if (folded.some(f => f.folded.includes(q.phrase))) return true;
  const termsMatch = q.terms.length > 0 && q.terms.every((term, index) =>
    folded.some(f => f.folded.includes(term)) ||
    (options.typos !== false && q.budgets[index]! > 0 && folded.some(f => closest(q, index, f) <= q.budgets[index]!)));
  return termsMatch || folded.some(f => subsequenceScore(q.phrase, f.folded) >= 900);
}
