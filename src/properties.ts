import type {
  BlockProperty,
  PropertyFilter,
  PropertyPatchOperation,
  PropertyPlacement,
  PropertyQueryScope,
  PropertyRecord,
} from "./types";

const PROPERTY_PATTERN = /\[([A-Za-z][A-Za-z0-9_.-]*)::([^\]\r\n]+)\]/g;
const PROPERTY_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]*$/;

export const PROPERTY_PARSER_VERSION = 2;

interface SourceRange {
  start: number;
  end: number;
}

interface SourceLine extends SourceRange {
  contentEnd: number;
}

interface FenceMarker {
  delimiter: "`" | "~";
  length: number;
  end: number;
}

interface PropertyMatch {
  match: RegExpExecArray;
  start: number;
}

type PropertyCandidate = Omit<PropertyRecord, "ordinal" | "scope">;

function createPropertyPattern(): RegExp {
  return new RegExp(PROPERTY_PATTERN.source, "g");
}

function sourceLines(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline < 0 ? text.length : newline + 1;
    const contentEnd = newline < 0 ? text.length : newline > start && text[newline - 1] === "\r" ? newline - 1 : newline;
    lines.push({ start, end, contentEnd });
    start = end;
  }
  if (text.length === 0) lines.push({ start: 0, end: 0, contentEnd: 0 });
  return lines;
}

function fenceMarker(text: string, line: SourceLine): FenceMarker | null {
  let cursor = line.start;
  while (cursor < line.contentEnd && cursor - line.start < 4 && text[cursor] === " ") cursor += 1;
  if (cursor - line.start > 3) return null;
  const delimiter = text[cursor];
  if (delimiter !== "`" && delimiter !== "~") return null;
  let end = cursor;
  while (end < line.contentEnd && text[end] === delimiter) end += 1;
  const length = end - cursor;
  return length >= 3 ? { delimiter, length, end } : null;
}

function isClosingFence(text: string, line: SourceLine, opening: FenceMarker): boolean {
  const marker = fenceMarker(text, line);
  if (!marker || marker.delimiter !== opening.delimiter || marker.length < opening.length) return false;
  let cursor = marker.end;
  while (cursor < line.contentEnd && (text[cursor] === " " || text[cursor] === "\t")) cursor += 1;
  return cursor === line.contentEnd;
}

function fencedRanges(text: string, lines: SourceLine[]): SourceRange[] {
  const ranges: SourceRange[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const opening = fenceMarker(text, lines[index]);
    if (!opening) continue;
    let closingIndex = index + 1;
    while (closingIndex < lines.length && !isClosingFence(text, lines[closingIndex], opening)) {
      closingIndex += 1;
    }
    const end = closingIndex < lines.length ? lines[closingIndex].end : text.length;
    ranges.push({ start: lines[index].start, end });
    index = closingIndex;
  }
  return ranges;
}

function findEqualBacktickRun(text: string, start: number, end: number, length: number): number {
  let cursor = start;
  while (cursor < end) {
    const opener = text.indexOf("`", cursor);
    if (opener < 0 || opener >= end) return -1;
    let runEnd = opener + 1;
    while (runEnd < end && text[runEnd] === "`") runEnd += 1;
    if (runEnd - opener === length) return opener;
    cursor = runEnd;
  }
  return -1;
}

function inlineLiteralRanges(text: string, lines: SourceLine[], fences: SourceRange[]): SourceRange[] {
  const ranges: SourceRange[] = [];
  let lineIndex = 0;

  function scanRegion(start: number, end: number): void {
    let cursor = start;
    while (cursor < end) {
      const opener = text.indexOf("`", cursor);
      if (opener < 0 || opener >= end) return;
      while (lineIndex + 1 < lines.length && lines[lineIndex].end <= opener) lineIndex += 1;

      let openerEnd = opener + 1;
      while (openerEnd < end && text[openerEnd] === "`") openerEnd += 1;
      const length = openerEnd - opener;
      const closing = findEqualBacktickRun(text, openerEnd, end, length);
      if (closing >= 0) {
        const rangeEnd = closing + length;
        ranges.push({ start: opener, end: rangeEnd });
        cursor = rangeEnd;
      } else {
        ranges.push({ start: opener, end: lines[lineIndex].contentEnd });
        cursor = lines[lineIndex].end;
      }
    }
  }

  let regionStart = 0;
  for (const fence of fences) {
    scanRegion(regionStart, fence.start);
    regionStart = fence.end;
  }
  scanRegion(regionStart, text.length);
  return ranges;
}

export function scanPropertyLiteralRanges(text: string): SourceRange[] {
  const lines = sourceLines(text);
  const fences = fencedRanges(text, lines);
  const inlineLiterals = inlineLiteralRanges(text, lines, fences);
  return [...fences, ...inlineLiterals].sort((left, right) => left.start - right.start);
}

function containsNonWhitespace(text: string, start: number, end: number): boolean {
  for (let cursor = start; cursor < end; cursor += 1) {
    if (!/\s/.test(text[cursor])) return true;
  }
  return false;
}

function hasOddBackslashEscape(text: string, offset: number): boolean {
  let cursor = offset;
  while (cursor > 0 && text[cursor - 1] === "\\") cursor -= 1;
  return (offset - cursor) % 2 === 1;
}

function removeRanges(text: string, ranges: SourceRange[], start = 0, end = text.length): string {
  if (ranges.length === 0) return text.slice(start, end);

  const parts: string[] = [];
  let cursor = start;
  for (const range of ranges) {
    if (range.end <= cursor) continue;
    if (range.start >= end) break;
    if (cursor < range.start) parts.push(text.slice(cursor, range.start));
    cursor = Math.min(Math.max(cursor, range.end), end);
  }
  if (cursor < end) parts.push(text.slice(cursor, end));
  return parts.join("");
}

function propertyCandidateLines(
  candidates: readonly PropertyCandidate[],
): Map<number, PropertyCandidate[]> {
  const byLine = new Map<number, PropertyCandidate[]>();
  for (const candidate of candidates) {
    const lineCandidates = byLine.get(candidate.line);
    if (lineCandidates) lineCandidates.push(candidate);
    else byLine.set(candidate.line, [candidate]);
  }
  return byLine;
}

function lineContainsOnlyProperties(
  text: string,
  line: SourceLine,
  candidates: readonly PropertyCandidate[],
): boolean {
  if (candidates.length === 0) return false;
  let cursor = line.start;
  for (const candidate of candidates) {
    if (containsNonWhitespace(text, cursor, candidate.start)) return false;
    cursor = candidate.end;
  }
  return !containsNonWhitespace(text, cursor, line.contentEnd);
}

function offsetInRanges(offset: number, ranges: readonly SourceRange[]): boolean {
  return ranges.some((range) => range.start <= offset && offset < range.end);
}

function parseBarePropertyCandidate(
  text: string,
  line: SourceLine,
  lineIndex: number,
  literalRanges: readonly SourceRange[],
  bracketCandidates: readonly PropertyCandidate[],
): PropertyCandidate | null {
  const content = text.slice(line.start, line.contentEnd);
  const match = /^([ \t]*)([A-Za-z][A-Za-z0-9_.-]*)::[ \t]*/.exec(content);
  if (!match) return null;

  const start = line.start + match[1].length;
  if (offsetInRanges(start, literalRanges)) return null;
  const valueStart = line.start + match[0].length;
  const firstBracket = bracketCandidates.find((candidate) => candidate.start >= valueStart);
  let end = firstBracket?.start ?? line.contentEnd;
  while (end > valueStart && /[ \t]/.test(text[end - 1])) end -= 1;
  const value = text.slice(valueStart, end).trim();
  if (!value) return null;

  return {
    key: match[2].toLowerCase(),
    value,
    raw: text.slice(start, end),
    start,
    end,
    line: lineIndex,
    column: start - line.start,
    placement: "metadata-line",
    syntax: "bare",
  };
}

export function parsePropertyRecords(text: string): PropertyRecord[] {
  const literalRanges = scanPropertyLiteralRanges(text);
  const matches: PropertyMatch[] = [];
  let literalIndex = 0;
  for (const match of text.matchAll(createPropertyPattern())) {
    const start = match.index;
    while (literalIndex < literalRanges.length && literalRanges[literalIndex].end <= start) {
      literalIndex += 1;
    }
    const literalRange = literalRanges[literalIndex];
    const isLiteral = literalRange !== undefined && literalRange.start <= start;
    if (!isLiteral && !hasOddBackslashEscape(text, start)) matches.push({ match, start });
  }

  const lines = sourceLines(text);
  const bracketCandidates: PropertyCandidate[] = [];
  for (let lineIndex = 0, matchIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const lineMatches: PropertyMatch[] = [];
    while (matchIndex < matches.length && matches[matchIndex].start < line.end) {
      lineMatches.push(matches[matchIndex]);
      matchIndex += 1;
    }
    if (lineMatches.length === 0) continue;

    const trailingMetadata = new Array<boolean>(lineMatches.length);
    const lastMatch = lineMatches[lineMatches.length - 1];
    let hasContentOutsideProperties = containsNonWhitespace(
      text,
      lastMatch.start + lastMatch.match[0].length,
      line.contentEnd,
    );
    for (let index = lineMatches.length - 1; index >= 0; index -= 1) {
      trailingMetadata[index] = !hasContentOutsideProperties;
      const gapStart =
        index === 0
          ? line.start
          : lineMatches[index - 1].start + lineMatches[index - 1].match[0].length;
      if (!hasContentOutsideProperties) {
        hasContentOutsideProperties = containsNonWhitespace(text, gapStart, lineMatches[index].start);
      }
    }
    const metadataLine = !hasContentOutsideProperties;

    for (let index = 0; index < lineMatches.length; index += 1) {
      const { match, start } = lineMatches[index];
      const raw = match[0];
      let placement: PropertyPlacement = "inline";
      if (metadataLine) placement = "metadata-line";
      else if (trailingMetadata[index]) placement = "trailing-metadata";
      bracketCandidates.push({
        key: match[1].toLowerCase(),
        value: match[2].trim(),
        raw,
        start,
        end: start + raw.length,
        line: lineIndex,
        column: start - line.start,
        placement,
        syntax: "bracket",
      });
    }
  }

  const bracketCandidatesByLine = propertyCandidateLines(bracketCandidates);
  const bareCandidates = lines.flatMap((line, lineIndex) => {
    const candidate = parseBarePropertyCandidate(
      text,
      line,
      lineIndex,
      literalRanges,
      bracketCandidatesByLine.get(lineIndex) ?? [],
    );
    return candidate ? [candidate] : [];
  });
  const candidates = [...bracketCandidates, ...bareCandidates].sort(
    (left, right) => left.start - right.start,
  );
  const candidatesByLine = propertyCandidateLines(candidates);
  const purePropertyLines = new Set<number>();
  for (const [lineIndex, lineCandidates] of candidatesByLine) {
    if (lineContainsOnlyProperties(text, lines[lineIndex], lineCandidates)) {
      purePropertyLines.add(lineIndex);
    }
  }

  const firstNonblankLine = lines.findIndex((line) =>
    containsNonWhitespace(text, line.start, line.contentEnd)
  );
  let subjectLine = -1;
  let preambleStart = -1;
  if (firstNonblankLine >= 0) {
    if (purePropertyLines.has(firstNonblankLine)) {
      preambleStart = firstNonblankLine;
    } else {
      subjectLine = firstNonblankLine;
      let cursor = firstNonblankLine + 1;
      while (
        cursor < lines.length &&
        !containsNonWhitespace(text, lines[cursor].start, lines[cursor].contentEnd)
      ) {
        cursor += 1;
      }
      if (purePropertyLines.has(cursor)) preambleStart = cursor;
    }
  }

  let preambleEnd = preambleStart;
  while (preambleEnd >= 0 && purePropertyLines.has(preambleEnd + 1)) {
    preambleEnd += 1;
  }

  return candidates.map((candidate, ordinal) => {
    let scope: PropertyRecord["scope"];
    if (
      preambleStart >= 0 &&
      candidate.line >= preambleStart &&
      candidate.line <= preambleEnd
    ) {
      scope = "block";
    } else if (
      candidate.line === subjectLine &&
      candidate.syntax === "bracket" &&
      candidate.placement === "trailing-metadata"
    ) {
      scope = "block";
    } else {
      scope = candidate.syntax === "bare" ? "line" : "inline";
    }
    return { ...candidate, ordinal, scope };
  });
}

export function parseProperties(text: string): BlockProperty[] {
  return parsePropertyRecords(text)
    .filter((property) => property.scope === "block")
    .map(({ key, value }) => ({ key, value }));
}
export function stripPropertyTokens(text: string): string {
  return removeRanges(text, parsePropertyRecords(text));
}

export function firstLineWithoutPropertyTokens(text: string): string | undefined {
  const tokens = parsePropertyRecords(text);
  let tokenIndex = 0;
  for (const line of sourceLines(text)) {
    const firstLineToken = tokenIndex;
    while (tokenIndex < tokens.length && tokens[tokenIndex].start < line.end) tokenIndex += 1;
    const lineWithoutProperties = removeRanges(
      text,
      tokens.slice(firstLineToken, tokenIndex),
      line.start,
      line.contentEnd,
    );
    if (lineWithoutProperties.trim()) return lineWithoutProperties;
  }
  return undefined;
}

export function stripProperties(text: string): string {
  return stripPropertyTokens(text).replace(/\s{2,}/g, " ").trim();
}

export function normalizePropertyKey(key: string): string {
  const normalized = key.trim();
  if (!PROPERTY_KEY_PATTERN.test(normalized)) throw new Error(`Invalid property key: ${key}`);
  return normalized.toLowerCase();
}

export function validateProperty(key: string, value: string): BlockProperty {
  const normalizedKey = normalizePropertyKey(key);
  const normalizedValue = value.trim();
  if (!normalizedValue) throw new Error(`Property value cannot be empty: ${key}`);
  if (/[\]\r\n]/.test(normalizedValue)) {
    throw new Error(`Property value cannot contain ], CR, or LF: ${key}`);
  }
  return { key: normalizedKey, value: normalizedValue };
}

export function formatProperty(property: BlockProperty): string {
  const validated = validateProperty(property.key, property.value);
  return `[${validated.key}::${validated.value}]`;
}

export function patchPropertyText(text: string, operations: PropertyPatchOperation[]): string {
  const tokens = parsePropertyRecords(text);
  const mutations: Array<{ start: number; end: number; replacement: string }> = [];
  const touchedOrdinals = new Set<number>();
  const appends: BlockProperty[] = [];

  for (const operation of operations) {
    const operationKind: string = operation.op;
    if (operationKind === "append") {
      const append = operation as Extract<PropertyPatchOperation, { op: "append" }>;
      appends.push(validateProperty(append.key, append.value));
      continue;
    }
    if (operationKind !== "remove" && operationKind !== "replace") {
      throw new Error(`Unknown property patch operation: ${operationKind}`);
    }
    const tokenOperation = operation as Exclude<PropertyPatchOperation, { op: "append" }>;
    if (!Number.isInteger(tokenOperation.ordinal) || tokenOperation.ordinal < 0) {
      throw new Error(`Invalid property token ordinal: ${tokenOperation.ordinal}`);
    }
    if (touchedOrdinals.has(tokenOperation.ordinal)) {
      throw new Error(`Property token patched more than once: ${tokenOperation.ordinal}`);
    }
    touchedOrdinals.add(tokenOperation.ordinal);
    const token = tokens[tokenOperation.ordinal];
    if (!token) throw new Error(`Property token not found: ${tokenOperation.ordinal}`);
    let replacement = "";
    if (operationKind === "replace") {
      const key = "key" in tokenOperation ? tokenOperation.key ?? token.key : token.key;
      const value = "value" in tokenOperation ? tokenOperation.value : token.value;
      const validated = validateProperty(key, value);
      replacement = token.syntax === "bare"
        ? `${validated.key}:: ${validated.value}`
        : formatProperty(validated);
    }
    mutations.push({ start: token.start, end: token.end, replacement });
  }

  let patched = text;
  for (const mutation of mutations.sort((left, right) => right.start - left.start)) {
    patched = patched.slice(0, mutation.start) + mutation.replacement + patched.slice(mutation.end);
  }
  if (appends.length === 0) return patched;

  const appendedText = appends.map(formatProperty).join(" ");
  const metadataToken = parsePropertyRecords(patched).find(
    (token) => token.scope === "block" && token.placement === "metadata-line",
  );
  if (metadataToken) {
    const lineEnd = patched.indexOf("\n", metadataToken.end);
    let insertion = lineEnd < 0 ? patched.length : lineEnd;
    if (insertion > 0 && patched[insertion - 1] === "\r") insertion -= 1;
    const separator = patched.slice(0, insertion).endsWith(" ") ? "" : " ";
    return patched.slice(0, insertion) + separator + appendedText + patched.slice(insertion);
  }
  if (!patched) return appendedText;

  const firstNewline = patched.indexOf("\n");
  const usesCrlf = firstNewline > 0 && patched[firstNewline - 1] === "\r";
  const lineBreak = usesCrlf ? "\r\n" : "\n";
  let firstLineEnd = firstNewline;
  if (firstNewline < 0) {
    firstLineEnd = patched.length;
  } else if (usesCrlf) {
    firstLineEnd -= 1;
  }
  const firstLine = {
    start: 0,
    end: firstNewline < 0 ? patched.length : firstNewline + 1,
    contentEnd: firstLineEnd,
  };
  if (fenceMarker(patched, firstLine)) return `${appendedText}${lineBreak}${patched}`;
  if (firstNewline < 0) return `${patched}\n${appendedText}`;
  return `${patched.slice(0, firstLineEnd)}${lineBreak}${appendedText}${patched.slice(firstLineEnd)}`;
}

export function matchingPropertyRecords(
  properties: readonly PropertyRecord[],
  filters: readonly PropertyFilter[],
  propertyScope: PropertyQueryScope = "block",
): PropertyRecord[] {
  const scoped = propertyScope === "all"
    ? properties
    : properties.filter((property) => property.scope === propertyScope);
  if (filters.length === 0) return [...scoped];
  return scoped.filter((property) =>
    filters.some(
      (filter) =>
        property.key === filter.key &&
        (filter.value === undefined ||
          property.value.toLowerCase() === filter.value.toLowerCase()),
    )
  );
}

export function matchesFilters(
  properties: readonly (BlockProperty | PropertyRecord)[],
  filters: readonly PropertyFilter[],
  propertyScope: PropertyQueryScope = "block",
): boolean {
  const scoped = propertyScope === "all"
    ? properties
    : properties.filter((property) =>
      ("scope" in property ? property.scope : "block") === propertyScope
    );
  return filters.every((filter) =>
    scoped.some(
      (property) =>
        property.key === filter.key &&
        (filter.value === undefined ||
          property.value.toLowerCase() === filter.value.toLowerCase()),
    )
  );
}

export function getProperty(properties: readonly BlockProperty[], key: string): string | undefined {
  return properties.find((property) => property.key === key.toLowerCase())?.value;
}
