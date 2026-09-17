import { createTextQuoteAnchor } from "./annotations";
import type {
  AnnotationAnchor,
  AnnotationRepresentation,
  AnnotationResolutionCandidate,
  AnnotationResolutionMethod,
  AnnotationResolutionStatus,
  AnnotationTarget,
} from "./types";

const TEXT_CODEC = { kind: "codec", codecId: "text-quote", codecVersion: 1 } as const;
const PROVIDER_CODEC = { kind: "codec", codecId: "provider-native", codecVersion: 1 } as const;
const HIGH_CONFIDENCE = 0.8;
const MEDIUM_CONFIDENCE = 0.65;
const MINIMUM_CANDIDATE = 0.25;
const MINIMUM_MARGIN = 0.05;
const MAX_CANDIDATES = 8;
const MAX_SEGMENTS = 512;
const MAX_FUZZY_UNITS = 512;
const MAX_FUZZY_WINDOW_UNITS = 65_536;

export interface AnnotationReanchorResult {
  readonly resolvedTarget: AnnotationTarget | null;
  readonly method: AnnotationResolutionMethod;
  readonly confidence: number | null;
  readonly status: AnnotationResolutionStatus;
  readonly candidates: readonly AnnotationResolutionCandidate[];
}

function method(codec: typeof TEXT_CODEC | typeof PROVIDER_CODEC, name: string): AnnotationResolutionMethod {
  return { ...codec, method: name };
}

function textTarget(
  representation: AnnotationRepresentation,
  content: string,
  start: number,
  end: number,
): AnnotationTarget {
  return {
    representation,
    anchor: createTextQuoteAnchor(content, start, end),
  };
}

function candidate(
  target: AnnotationTarget,
  resolutionMethod: AnnotationResolutionMethod,
  confidence: number,
): AnnotationResolutionCandidate {
  return { target, method: resolutionMethod, confidence };
}

function resolved(
  entry: AnnotationResolutionCandidate,
  candidates: readonly AnnotationResolutionCandidate[] = [entry],
): AnnotationReanchorResult {
  return {
    resolvedTarget: entry.target,
    method: entry.method,
    confidence: entry.confidence,
    status: "resolved",
    candidates,
  };
}

function unresolved(
  resolutionMethod: AnnotationResolutionMethod,
  candidates: readonly AnnotationResolutionCandidate[],
  noCandidateStatus: AnnotationResolutionStatus,
): AnnotationReanchorResult {
  if (candidates.length === 0) {
    return {
      resolvedTarget: null,
      method: resolutionMethod,
      confidence: null,
      status: noCandidateStatus,
      candidates,
    };
  }
  const [best, runnerUp] = candidates;
  if (!best) throw new Error("Reanchor candidate ranking cannot be empty");
  const hasMargin = runnerUp === undefined || best.confidence - runnerUp.confidence >= MINIMUM_MARGIN;
  if (best.confidence >= HIGH_CONFIDENCE && hasMargin) return resolved(best, candidates);
  if (best.confidence >= MEDIUM_CONFIDENCE && hasMargin) {
    return {
      resolvedTarget: null,
      method: best.method,
      confidence: best.confidence,
      status: "probable",
      candidates,
    };
  }
  const status = best.confidence >= MEDIUM_CONFIDENCE ? "ambiguous" : "unresolved";
  return {
    resolvedTarget: null,
    method: resolutionMethod,
    confidence: status === "ambiguous" ? null : best.confidence,
    status,
    candidates,
  };
}

function commonPrefixRatio(expected: string, actual: string): number {
  if (expected.length === 0) return actual.length === 0 ? 1 : 0;
  const limit = Math.min(expected.length, actual.length);
  let common = 0;
  while (common < limit && expected.charCodeAt(common) === actual.charCodeAt(common)) common += 1;
  return common / expected.length;
}

function commonSuffixRatio(expected: string, actual: string): number {
  if (expected.length === 0) return actual.length === 0 ? 1 : 0;
  const limit = Math.min(expected.length, actual.length);
  let common = 0;
  while (
    common < limit &&
    expected.charCodeAt(expected.length - common - 1) === actual.charCodeAt(actual.length - common - 1)
  ) common += 1;
  return common / expected.length;
}

function contextScore(
  anchor: Extract<AnnotationAnchor, { kind: "text-quote" }>,
  content: string,
  start: number,
  end: number,
): number {
  const before = content.slice(Math.max(0, start - anchor.prefix.length), start);
  const after = content.slice(end, end + anchor.suffix.length);
  return (commonSuffixRatio(anchor.prefix, before) + commonPrefixRatio(anchor.suffix, after)) / 2;
}

interface ExactOccurrence {
  readonly start: number;
  readonly confidence: number;
}

function exactOccurrences(
  content: string,
  anchor: Extract<AnnotationAnchor, { kind: "text-quote" }>,
): { readonly count: number; readonly ranked: readonly ExactOccurrence[] } {
  const ranked: ExactOccurrence[] = [];
  let count = 0;
  let cursor = 0;
  while (cursor <= content.length - anchor.exact.length) {
    const start = content.indexOf(anchor.exact, cursor);
    if (start < 0) break;
    count += 1;
    ranked.push({
      start,
      confidence: 0.7 + 0.3 * contextScore(
        anchor,
        content,
        start,
        start + anchor.exact.length,
      ),
    });
    ranked.sort((left, right) => right.confidence - left.confidence || left.start - right.start);
    if (ranked.length > MAX_CANDIDATES) ranked.pop();
    cursor = start + 1;
  }
  return { count, ranked };
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function words(value: string): Set<string> {
  return new Set(normalized(value).match(/[\p{L}\p{N}]+/gu) ?? []);
}

function diceSimilarity(left: string, right: string): number {
  const leftWords = words(left);
  const rightWords = words(right);
  if (leftWords.size === 0 || rightWords.size === 0) return 0;
  let shared = 0;
  for (const word of leftWords) if (rightWords.has(word)) shared += 1;
  return (2 * shared) / (leftWords.size + rightWords.size);
}

function editSimilarity(left: string, right: string): number {
  const normalizedLeft = normalized(left);
  const normalizedRight = normalized(right);
  const coverage = Math.min(
    1,
    MAX_FUZZY_UNITS / Math.max(normalizedLeft.length, normalizedRight.length),
  );
  const a = [...normalizedLeft.slice(0, MAX_FUZZY_UNITS)];
  const b = [...normalizedRight.slice(0, MAX_FUZZY_UNITS)];
  if (a.length === 0 || b.length === 0) return 0;
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  const sampledSimilarity = 1 -
    (previous[b.length] ?? Math.max(a.length, b.length)) / Math.max(a.length, b.length);
  return sampledSimilarity * coverage;
}

interface TextSegment {
  readonly start: number;
  readonly end: number;
}

interface FuzzySegments {
  readonly segments: readonly TextSegment[];
  readonly exhaustive: boolean;
}

function fuzzySegments(
  content: string,
  quote: string,
  capturedStart: number | null,
): FuzzySegments {
  const expectedWords = Math.max(1, normalized(quote).split(" ").length);
  const center = Math.max(0, Math.min(content.length, capturedStart ?? Math.floor(content.length / 2)));
  const radius = Math.floor(MAX_FUZZY_WINDOW_UNITS / 2);
  const windowStart = Math.max(0, center - radius);
  const windowEnd = Math.min(content.length, center + radius);
  const window = content.slice(windowStart, windowEnd);
  const lines = [...window.matchAll(/[^\r\n]+/g)]
    .map((match) => ({
      raw: match[0],
      start: windowStart + match.index,
    }))
    .sort((left, right) =>
      Math.abs(left.start + left.raw.length / 2 - center) -
      Math.abs(right.start + right.raw.length / 2 - center) ||
      left.start - right.start
    );
  const segments = new Map<string, TextSegment>();
  let exhaustive = windowStart === 0 && windowEnd === content.length;
  for (const line of lines) {
    if (segments.size >= MAX_SEGMENTS) {
      exhaustive = false;
      break;
    }
    const leading = line.raw.length - line.raw.trimStart().length;
    const trailing = line.raw.length - line.raw.trimEnd().length;
    const start = line.start + leading;
    const end = line.start + line.raw.length - trailing;
    if (end <= start) continue;
    segments.set(`${start}:${end}`, { start, end });
    const tokens = [...content.slice(start, end).matchAll(/\S+/g)];
    for (const size of [expectedWords - 1, expectedWords, expectedWords + 1]) {
      if (size < 1) continue;
      const indexes = Array.from(
        { length: Math.max(0, tokens.length - size + 1) },
        (_, index) => index,
      ).sort((left, right) => {
        const leftToken = tokens[left];
        const rightToken = tokens[right];
        const leftPosition = start + (leftToken?.index ?? 0);
        const rightPosition = start + (rightToken?.index ?? 0);
        return Math.abs(leftPosition - center) - Math.abs(rightPosition - center) || left - right;
      });
      for (const index of indexes) {
        if (segments.size >= MAX_SEGMENTS) {
          exhaustive = false;
          break;
        }
        const first = tokens[index];
        const last = tokens[index + size - 1];
        if (!first || !last || first.index === undefined || last.index === undefined) continue;
        const segmentStart = start + first.index;
        const segmentEnd = start + last.index + last[0].length;
        segments.set(`${segmentStart}:${segmentEnd}`, { start: segmentStart, end: segmentEnd });
      }
    }
  }
  return { segments: [...segments.values()], exhaustive };
}

interface FuzzyCandidates {
  readonly candidates: readonly AnnotationResolutionCandidate[];
  readonly exhaustive: boolean;
}

function fuzzyCandidates(
  anchor: Extract<AnnotationAnchor, { kind: "text-quote" }>,
  representation: AnnotationRepresentation,
  content: string,
): FuzzyCandidates {
  if (words(anchor.exact).size < 2) return { candidates: [], exhaustive: true };
  const fuzzyMethod = method(TEXT_CODEC, "local-fuzzy");
  const search = fuzzySegments(content, anchor.exact, anchor.start);
  const ranked = search.segments
    .map(({ start, end }) => {
      const selected = content.slice(start, end);
      const confidence = 0.65 * editSimilarity(anchor.exact, selected) +
        0.25 * diceSimilarity(anchor.exact, selected) +
        0.1 * contextScore(anchor, content, start, end);
      return candidate(textTarget(representation, content, start, end), fuzzyMethod, confidence);
    })
    .filter((entry) => entry.confidence >= MINIMUM_CANDIDATE)
    .sort((left, right) =>
      right.confidence - left.confidence ||
      ((left.target.anchor.kind === "text-quote" ? left.target.anchor.start : 0) ?? 0) -
        ((right.target.anchor.kind === "text-quote" ? right.target.anchor.start : 0) ?? 0)
    );
  const distinct: AnnotationResolutionCandidate[] = [];
  for (const entry of ranked) {
    const entryAnchor = entry.target.anchor;
    if (entryAnchor.kind !== "text-quote" || entryAnchor.start === null || entryAnchor.end === null) continue;
    const entryStart = entryAnchor.start;
    const entryEnd = entryAnchor.end;
    const overlaps = distinct.some(({ target }) => {
      const retained = target.anchor;
      if (retained.kind !== "text-quote" || retained.start === null || retained.end === null) return false;
      const intersection = Math.max(
        0,
        Math.min(entryEnd, retained.end) - Math.max(entryStart, retained.start),
      );
      return intersection / Math.min(
        entryEnd - entryStart,
        retained.end - retained.start,
      ) > 0.5;
    });
    if (!overlaps) distinct.push(entry);
    if (distinct.length === MAX_CANDIDATES) break;
  }
  return { candidates: distinct, exhaustive: search.exhaustive };
}

export function reanchorAnnotationTarget(
  target: AnnotationTarget,
  representation: AnnotationRepresentation,
  content: string | null,
): AnnotationReanchorResult {
  const anchor = target.anchor;
  if (
    target.representation.contentHash !== null &&
    target.representation.contentHash === representation.contentHash
  ) {
    return resolved(candidate(
      { representation, anchor },
      method(TEXT_CODEC, "unchanged-representation"),
      1,
    ));
  }
  if (anchor.kind === "provider-comment-id") {
    return resolved(candidate(
      { representation, anchor },
      method(PROVIDER_CODEC, "stable-comment-id"),
      1,
    ));
  }
  if (anchor.kind !== "text-quote" || content === null) {
    return {
      resolvedTarget: null,
      method: method(TEXT_CODEC, anchor.kind === "text-quote" ? "content-unavailable" : "unsupported-anchor"),
      confidence: null,
      status: "unsupported",
      candidates: [],
    };
  }
  if (
    anchor.start !== null &&
    anchor.end !== null &&
    content.slice(anchor.start, anchor.end) === anchor.exact
  ) {
    return resolved(candidate(
      textTarget(representation, content, anchor.start, anchor.end),
      method(TEXT_CODEC, "structural-replay"),
      1,
    ));
  }
  const exact = exactOccurrences(content, anchor);
  if (exact.count === 1) {
    const start = exact.ranked[0]!.start;
    return resolved(candidate(
      textTarget(representation, content, start, start + anchor.exact.length),
      method(TEXT_CODEC, "unique-exact-quote"),
      1,
    ));
  }
  if (exact.count > 1) {
    const contextMethod = method(TEXT_CODEC, "quote-context");
    const candidates = exact.ranked.map(({ start, confidence }) => candidate(
      textTarget(representation, content, start, start + anchor.exact.length),
      contextMethod,
      confidence,
    ));
    return unresolved(contextMethod, candidates, "ambiguous");
  }
  const fuzzy = fuzzyCandidates(anchor, representation, content);
  return unresolved(
    method(TEXT_CODEC, "local-fuzzy"),
    fuzzy.candidates,
    fuzzy.exhaustive ? "orphaned" : "unresolved",
  );
}
