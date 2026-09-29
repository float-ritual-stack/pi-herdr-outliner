/** Where a `((…))` envelope ends, shared by reference parsing and every re-scan of resolved text. */

/**
 * The `))` that closes a `((` opened just before `from`. Parentheses inside
 * are balanced, so `((Rough edges (x)))` closes after `(x)`; when they cannot
 * balance (`((Smile :)))`), the first `))` at or after `minimum` closes it.
 * Returns the offset after the closing `))`, or -1.
 */
export function referenceEnvelopeEnd(text: string, from: number, singleLine = false, minimum = from): number {
  let depth = 0;
  let first = -1;
  for (let cursor = from; cursor < text.length - 1; cursor += 1) {
    const character = text[cursor]!;
    // Titles and labels are one line: once a close is known, balance only within it.
    if ((singleLine || first >= 0) && (character === "\n" || character === "\r")) break;
    if (character === ")" && text[cursor + 1] === ")" && cursor >= minimum) {
      if (first < 0) first = cursor + 2;
      if (depth <= 0) return depth === 0 ? cursor + 2 : first;
    }
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    if (depth < 0 && first >= 0) return first;
  }
  return first;
}

export interface BlockReferenceEnvelope {
  start: number;
  end: number;
}

export function blockReferenceEnvelopeRanges(text: string): BlockReferenceEnvelope[] {
  const ranges: BlockReferenceEnvelope[] = [];
  for (let start = text.indexOf("(("); start >= 0; start = text.indexOf("((", start)) {
    const end = referenceEnvelopeEnd(text, start + 2);
    if (end < 0) break;
    ranges.push({ start, end });
    start = end;
  }
  return ranges;
}
