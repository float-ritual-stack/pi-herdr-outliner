import {atomicDocument, concatDocuments, generatedDocument, sliceDocument, type MappedDocument} from './document-provenance';
import {scanLiteralRegions} from './properties';
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

/** Preserve authored titles while emitting reader-only heading syntax separately. */
export function presentReaderHeadings(document: MappedDocument): MappedDocument {
  let fence: {marker: string; length: number} | null = null;
  let offset = 0;
  const parts: MappedDocument[] = [];
  // Literal-region markers read as a paragraph break, like an HTML comment
  // block. Blanking (not removing) them keeps authored line numbers aligned.
  const literal = scanLiteralRegions(document.text);
  const markerStarts = new Set(literal.regions.flatMap(region => [region.opener.start, region.closer.start]));
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
