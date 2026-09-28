import {atomicDocument, concatDocuments, generatedDocument, sliceDocument, type MappedDocument, type ObservedDocument} from './document-provenance';
import {isLiteralMarkerLine, literalMarkerLineStarts, scanLiteralRegions, type SourceRange} from './properties';
import {sanitizedTextParts} from './terminal';

/** Sanitizing and mapping consume the same scanner, including OSC/CSI controls. */
export function sanitizeReaderDocument(document: MappedDocument): MappedDocument {
  return concatDocuments(sanitizedTextParts(document.text, true).map(part => {
    const source = sliceDocument(document, part.start, part.end);
    if (source.text === part.text) return source;
    // The scanner's only text substitution is a single tab -> four spaces.
    // All four cells share the one authored code unit; no proportional offsets.
    return source.runs.length === 1
      ? atomicDocument(part.text, source.runs[0]!.origin)
      : generatedDocument(part.text, 'terminal substitution without one observed origin');
  }));
}

interface LiteralMarkerPresentation {
  /** Offsets in the presented document of matched marker lines to blank. */
  markerStarts: Set<number>;
  /** Whether some shown note's own text has an opener without a closer. */
  unterminated: boolean;
}

/**
 * Regions belong to the note that authored them. An embed can show a slice of
 * another note, so each line is judged by its source note's own parse: a slice
 * holding only one marker of a closed region hides it without a warning, and
 * the host's regions cannot pair with an embed's markers. A document with no
 * observed source (plain reader text) is parsed as a whole.
 */
function literalMarkerPresentation(document: MappedDocument): LiteralMarkerPresentation {
  const sourceRuns = document.runs.filter(run => run.origin.kind === 'source');
  if (!sourceRuns.length) {
    const scan = scanLiteralRegions(document.text);
    return {
      markerStarts: new Set(scan.regions.flatMap(region => [region.opener.start, region.closer.start])),
      unterminated: scan.unterminated !== null,
    };
  }
  const scans = new Map<ObservedDocument, {markers: SourceRange[]; unterminated: number | null}>();
  const scanOf = (observed: ObservedDocument) => {
    let scan = scans.get(observed);
    if (!scan) {
      const parsed = scanLiteralRegions(observed.text);
      scan = {
        markers: parsed.regions.flatMap(region => [region.opener, region.closer]),
        unterminated: parsed.unterminated?.start ?? null,
      };
      scans.set(observed, scan);
    }
    return scan;
  };
  let unterminated = false;
  for (const run of sourceRuns) {
    if (run.origin.kind !== 'source') continue;
    for (const slice of run.origin.slices) {
      const opener = scanOf(slice.document).unterminated;
      if (opener !== null && slice.start <= opener && opener < slice.end) unterminated = true;
    }
  }
  const markerStarts = new Set<number>();
  let offset = 0;
  for (const sourceLine of document.text.split(/(?<=\n)/)) {
    const lineStart = offset;
    offset += sourceLine.length;
    const content = sourceLine.replace(/\r?\n$/, '');
    if (!/^ {0,3}<!--/.test(content)) continue;
    // The marker text itself must come from a note where it is a matched marker.
    const markerAt = lineStart + content.length - content.trimStart().length;
    const run = document.runs.find(candidate => candidate.start <= markerAt && markerAt < candidate.end);
    if (!run || run.origin.kind !== 'source' || run.origin.slices.length !== 1) continue;
    const slice = run.origin.slices[0]!;
    const sourceOffset = run.mapping === 'linear' ? slice.start + markerAt - run.start : slice.start;
    const matched = scanOf(slice.document).markers
      .some(marker => marker.start <= sourceOffset && sourceOffset < marker.end);
    if (matched && isLiteralMarkerLine(content)) markerStarts.add(lineStart);
  }
  return {markerStarts, unterminated};
}

/** Blank matched marker lines in plain reader Markdown, keeping its line count. */
export function hideLiteralMarkers(text: string): string {
  const starts = literalMarkerLineStarts(text);
  if (!starts.size) return text;
  let offset = 0;
  return text.split(/(?<=\n)/).map(line => {
    const start = offset;
    offset += line.length;
    return starts.has(start) ? line.slice(line.replace(/\r?\n$/, '').length) : line;
  }).join('');
}

/** Preserve authored titles while emitting reader-only heading syntax separately. */
export function presentReaderHeadings(document: MappedDocument): MappedDocument {
  let fence: {marker: string; length: number} | null = null;
  let offset = 0;
  const parts: MappedDocument[] = [];
  // Literal-region markers read as a paragraph break, like an HTML comment
  // block. Blanking (not removing) them keeps authored line numbers aligned.
  const literal = literalMarkerPresentation(document);
  const markerStarts = literal.markerStarts;
  let titlePending = true;
  for (const sourceLine of document.text.split(/(?<=\n)/)) {
    const newlineLength = sourceLine.endsWith('\r\n') ? 2 : sourceLine.endsWith('\n') ? 1 : 0;
    const line = sourceLine.slice(0, sourceLine.length - newlineLength);
    const end = offset + sourceLine.length;
    const fenceMatch = /^((?: {0,3}>[ \t]?)* {0,3})(`{3,}|~{3,})/.exec(line);
    const appendLine = () => parts.push(sliceDocument(document, offset, end));
    const isTitleLine = titlePending && !markerStarts.has(offset);
    if (isTitleLine) titlePending = false;
    if (markerStarts.has(offset)) {
      parts.push(sliceDocument(document, end - newlineLength, end));
    } else if (fence) {
      if (fenceMatch && fenceMatch[2]![0] === fence.marker && fenceMatch[2]!.length >= fence.length) fence = null;
      appendLine();
    } else if (fenceMatch) {
      fence = {marker:fenceMatch[2]![0]!,length:fenceMatch[2]!.length};
      appendLine();
    } else {
      const heading = /^((?: {0,3}>[ \t]?)* {0,3})(#{1,6})[ \t]+(.*)$/.exec(line);
      if (isTitleLine && line.trim()) {
        const titleStart = heading && heading[1] === '' ? line.length - heading[3]!.length : 0;
        parts.push(generatedDocument('# ', 'reader title marker'), sliceDocument(document, offset + titleStart, end));
      } else if (heading && heading[2]!.length >= 3) {
        const titleStart = line.length - heading[3]!.length;
        parts.push(sliceDocument(document, offset, offset + heading[1]!.length),
          generatedDocument(`## ${'›'.repeat(heading[2]!.length - 2)} `, 'reader heading depth'),
          sliceDocument(document, offset + titleStart, end));
      } else appendLine();
    }
    offset = end;
  }
  if (literal.unterminated) {
    parts.push(generatedDocument(
      '\n\n> ⚠ A `<!-- literal -->` region has no closing `<!-- /literal -->` line, so outline syntax inside it is still read as properties.',
      'unterminated literal region warning',
    ));
  }
  return concatDocuments(parts);
}
