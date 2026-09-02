const FRAGMENT_ID_SOURCE = String.raw`[A-Za-z0-9][A-Za-z0-9_-]{0,63}`;
const FRAGMENT_ANCHOR_PATTERN = new RegExp(String.raw`(?:^|\s)\^(${FRAGMENT_ID_SOURCE})\s*$`);
const HEADING_PATTERN = /^(#{1,6})\s+(.+?)\s*$/;

export type FragmentKind = "heading" | "paragraph";

export interface FragmentAnchor {
  id: string;
  kind: FragmentKind;
  label: string;
  lineIndex: number;
  markerStart: number;
}

export interface FragmentCandidate {
  kind: FragmentKind;
  label: string;
  lineIndex: number;
  fragmentId?: string;
}

export type FragmentResolution =
  | { status: "resolved"; anchor: FragmentAnchor }
  | { status: "missing" }
  | { status: "duplicate"; anchors: FragmentAnchor[] };

export interface FragmentSlice {
  anchor: FragmentAnchor;
  text: string;
  startLine: number;
  endLine: number;
}

export type FragmentSliceResolution =
  | { status: "resolved"; slice: FragmentSlice }
  | { status: "missing" }
  | { status: "duplicate"; anchors: FragmentAnchor[] };

export interface FragmentCompletionQuery {
  blockQuery: string;
  fragmentQuery: string;
  mode: "heading" | "id";
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function lineOffsets(text: string): number[] {
  const offsets = [0];
  for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) {
    offsets.push(index + 1);
  }
  return offsets;
}

function anchorMatch(line: string): RegExpMatchArray | null {
  return line.match(FRAGMENT_ANCHOR_PATTERN);
}

function contentBeforeAnchor(line: string, match: RegExpMatchArray | null): string {
  return match ? line.slice(0, match.index).trimEnd() : line.trimEnd();
}

function paragraphLabel(lines: readonly string[], lineIndex: number, finalLine: string): string {
  let start = lineIndex;
  while (
    start > 0 &&
    lines[start - 1]!.trim() !== "" &&
    !contentBeforeAnchor(
      lines[start - 1]!,
      anchorMatch(lines[start - 1]!),
    ).match(HEADING_PATTERN)
  ) {
    start -= 1;
  }
  const paragraph = [...lines.slice(start, lineIndex), finalLine]
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
  return paragraph || `Line ${lineIndex + 1}`;
}

export function isFragmentId(value: string): boolean {
  return new RegExp(`^${FRAGMENT_ID_SOURCE}$`).test(value);
}

export function fragmentAnchors(text: string): FragmentAnchor[] {
  const lines = text.split(/\r?\n/);
  const offsets = lineOffsets(text);
  const anchors: FragmentAnchor[] = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!;
    const match = anchorMatch(line);
    if (!match) continue;
    const content = contentBeforeAnchor(line, match);
    const heading = content.match(HEADING_PATTERN);
    anchors.push({
      id: match[1]!,
      kind: heading ? "heading" : "paragraph",
      label: heading?.[2]?.trim() || paragraphLabel(lines, lineIndex, content),
      lineIndex,
      markerStart: offsets[lineIndex]! + match.index!,
    });
  }
  return anchors;
}

export function resolveFragment(text: string, fragmentId: string): FragmentResolution {
  const matches = fragmentAnchors(text).filter((anchor) => anchor.id === fragmentId);
  if (matches.length === 0) return { status: "missing" };
  if (matches.length > 1) return { status: "duplicate", anchors: matches };
  return { status: "resolved", anchor: matches[0]! };
}

export function resolveFragmentSlice(
  text: string,
  fragmentId: string,
): FragmentSliceResolution {
  const resolution = resolveFragment(text, fragmentId);
  if (resolution.status !== "resolved") return resolution;

  const lines = text.split(/\r?\n/);
  const anchor = resolution.anchor;
  let startLine = anchor.lineIndex;
  let endLine = anchor.lineIndex;
  if (anchor.kind === "heading") {
    const heading = contentBeforeAnchor(
      lines[anchor.lineIndex]!,
      anchorMatch(lines[anchor.lineIndex]!),
    ).match(HEADING_PATTERN)!;
    const depth = heading[1]!.length;
    endLine = lines.length - 1;
    for (let lineIndex = anchor.lineIndex + 1; lineIndex < lines.length; lineIndex += 1) {
      const candidate = contentBeforeAnchor(
        lines[lineIndex]!,
        anchorMatch(lines[lineIndex]!),
      ).match(HEADING_PATTERN);
      if (candidate && candidate[1]!.length <= depth) {
        endLine = lineIndex - 1;
        break;
      }
    }
  } else {
    while (
      startLine > 0 &&
      lines[startLine - 1]!.trim() !== "" &&
      !contentBeforeAnchor(
        lines[startLine - 1]!,
        anchorMatch(lines[startLine - 1]!),
      ).match(HEADING_PATTERN)
    ) {
      startLine -= 1;
    }
  }

  const sliceText = stripFragmentAnchors(lines.slice(startLine, endLine + 1).join("\n"))
    .trimEnd();
  return {
    status: "resolved",
    slice: { anchor, text: sliceText, startLine, endLine },
  };
}

export function fragmentCandidates(
  text: string,
  query = "",
  mode: "heading" | "id" = "heading",
): FragmentCandidate[] {
  const lines = text.split(/\r?\n/);
  const anchors = fragmentAnchors(text);
  const anchorsByLine = new Map(anchors.map((anchor) => [anchor.lineIndex, anchor]));
  const candidates: FragmentCandidate[] = [];

  if (mode === "heading") {
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex]!;
      const match = anchorMatch(line);
      const heading = contentBeforeAnchor(line, match).match(HEADING_PATTERN);
      if (!heading) continue;
      const anchor = anchorsByLine.get(lineIndex);
      candidates.push({
        kind: "heading",
        label: heading[2]!.trim(),
        lineIndex,
        ...(anchor ? { fragmentId: anchor.id } : {}),
      });
    }
  }

  for (const anchor of anchors) {
    if (mode === "heading" && anchor.kind === "heading") continue;
    candidates.push({
      kind: anchor.kind,
      label: anchor.label,
      lineIndex: anchor.lineIndex,
      fragmentId: anchor.id,
    });
  }

  const normalizedQuery = normalize(query);
  return candidates.filter((candidate) =>
    !normalizedQuery ||
    normalize(candidate.label).includes(normalizedQuery) ||
    normalize(candidate.fragmentId ?? "").includes(normalizedQuery)
  );
}

function fragmentSlug(label: string): string {
  const slug = label
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|-+$/g, "")
    .slice(0, 48);
  return slug || "fragment";
}

function uniqueFragmentId(base: string, usedIds: ReadonlySet<string>): string {
  if (!usedIds.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base.slice(0, Math.max(1, 63 - String(suffix).length))}-${suffix}`;
    if (!usedIds.has(candidate)) return candidate;
  }
}

export function ensureHeadingFragment(
  text: string,
  lineIndex: number,
): { text: string; fragmentId: string; created: boolean } {
  const lines = text.split(/\r?\n/);
  const line = lines[lineIndex];
  if (line === undefined) throw new Error(`Fragment heading line is unavailable: ${lineIndex + 1}`);
  const existing = anchorMatch(line);
  const content = contentBeforeAnchor(line, existing);
  const heading = content.match(HEADING_PATTERN);
  if (!heading) throw new Error(`Fragment target is not a Markdown heading: line ${lineIndex + 1}`);
  if (existing) return { text, fragmentId: existing[1]!, created: false };

  const usedIds = new Set(fragmentAnchors(text).map((anchor) => anchor.id));
  const fragmentId = uniqueFragmentId(fragmentSlug(heading[2]!), usedIds);
  const start = lineOffsets(text)[lineIndex]!;
  return {
    text: text.slice(0, start) + `${content} ^${fragmentId}` +
      text.slice(start + line.length),
    fragmentId,
    created: true,
  };
}

export function stripFragmentAnchors(text: string): string {
  return text.split(/\r?\n/).map((line) => contentBeforeAnchor(line, anchorMatch(line))).join("\n");
}

export function parseFragmentCompletionQuery(query: string): FragmentCompletionQuery | null {
  const headingDelimiter = query.lastIndexOf("#");
  const idDelimiter = query.lastIndexOf("^");
  const delimiter = Math.max(headingDelimiter, idDelimiter);
  if (delimiter < 0) return null;
  return {
    blockQuery: query.slice(0, delimiter).trim(),
    fragmentQuery: query.slice(delimiter + 1).trim(),
    mode: delimiter === headingDelimiter ? "heading" : "id",
  };
}
