export interface ExpandedBlockLayoutOptions {
  text: string;
  width: number;
  depth: number;
  marker: string;
  author: string;
}

export interface TreeLayoutRow {
  prefix: string;
  text: string;
  suffix: string;
}

function wrapLine(line: string, firstWidth: number, continuationWidth: number): string[] {
  if (!line) return [""];

  const rows: string[] = [];
  let remaining = line;
  let width = firstWidth;

  while (remaining.length > width) {
    let boundary = width;
    while (boundary > 0 && !/\s/.test(remaining[boundary])) boundary -= 1;
    if (boundary > 0) {
      rows.push(remaining.slice(0, boundary));
      remaining = remaining.slice(boundary).replace(/^\s+/, "");
    } else {
      rows.push(remaining.slice(0, width));
      remaining = remaining.slice(width).replace(/^\s+/, "");
    }
    width = continuationWidth;
  }

  rows.push(remaining);
  return rows;
}

function fitAffixes(prefix: string, suffix: string, width: number): [string, string, number] {
  const decorationWidth = Math.max(0, width - 1);
  const fittedPrefix = prefix.slice(0, decorationWidth);
  const suffixWidth = decorationWidth - fittedPrefix.length;
  const fittedSuffix = suffix.slice(Math.max(0, suffix.length - suffixWidth));
  return [fittedPrefix, fittedSuffix, width - fittedPrefix.length - fittedSuffix.length];
}

export function layoutExpandedBlock(options: ExpandedBlockLayoutOptions): TreeLayoutRow[] {
  const width = Math.max(1, Math.floor(options.width));
  const firstPrefix = `${"  ".repeat(Math.max(0, options.depth))}${options.marker} `;
  const firstSuffix = `  ${options.author}`;
  const continuationPrefix = `${"  ".repeat(Math.max(0, options.depth + 1))}│ `;
  const [fittedFirstPrefix, fittedFirstSuffix, firstContentWidth] = fitAffixes(
    firstPrefix,
    firstSuffix,
    width,
  );
  const [fittedContinuationPrefix, , continuationContentWidth] = fitAffixes(
    continuationPrefix,
    "",
    width,
  );

  const rows: TreeLayoutRow[] = [];
  const logicalLines = options.text.split(/\r?\n/);
  logicalLines.forEach((line, logicalIndex) => {
    const firstWidth = logicalIndex === 0 ? firstContentWidth : continuationContentWidth;
    const wrapped = wrapLine(line, firstWidth, continuationContentWidth);
    wrapped.forEach((text, physicalIndex) => {
      const isFirstRow = logicalIndex === 0 && physicalIndex === 0;
      rows.push({
        prefix: isFirstRow ? fittedFirstPrefix : fittedContinuationPrefix,
        text,
        suffix: isFirstRow ? fittedFirstSuffix : "",
      });
    });
  });
  return rows;
}
