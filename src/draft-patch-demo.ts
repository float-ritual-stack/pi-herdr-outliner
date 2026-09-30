/**
 * A tiny proof agent for `draft.patch` (PIE-501), for demos and tests only: it
 * is not the @-watcher. `outliner patch-demo --block <id> --tidy-above <mark>`
 * reads the note as its live draft has it (`drafts.read`), tidies the paragraph
 * just above the mark line (whitespace and Markdown markers, never inside a
 * link, reference or property token), and proposes that as one span.
 */
import { spanContext, type DraftPatchSpan } from "./draft-patch-compare";

/** Links, references, anchors and property tokens: tidying never goes inside one. */
const PROTECTED = /\[\[[^\]\r\n]*\]\]|!?\(\([^)\r\n]*\)\)|\[[A-Za-z][A-Za-z0-9_.-]*::[^\]\r\n]*\]|(?<=\s)\^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$|`[^`\r\n]*`/g;

function tidyGap(text: string): string {
  return text
    .replace(/\*\*\s+([^*\n]*?)\s+\*\*/g, "**$1**")
    .replace(/ {2,}/g, " ");
}

/** One line tidied: bullets as `-`, a heading's space after `#`, runs of spaces, trailing space. */
export function tidyLine(line: string): string {
  let out = line.replace(/\s+$/, "");
  out = out.replace(/^(\s*)[*+](\s+)/, "$1-$2").replace(/^(\s*)([-]|\d{1,9}[.)])\s{2,}/, "$1$2 ");
  out = out.replace(/^(#{1,6})(?=[^#\s])/, "$1 ");
  const lead = /^\s*(?:(?:[-*+]|\d{1,9}[.)])\s+)?/.exec(out)![0];
  let body = "";
  let cursor = lead.length;
  for (const match of out.slice(lead.length).matchAll(PROTECTED)) {
    const at = lead.length + match.index!;
    body += tidyGap(out.slice(cursor, at)) + match[0];
    cursor = at + match[0].length;
  }
  body += tidyGap(out.slice(cursor));
  return lead + body;
}

/**
 * The paragraph above the mark line (the nearest run of non-blank lines above
 * it), tidied, as a `draft.patch` span; null when there is none, or nothing to tidy.
 */
export function tidyAboveMark(text: string, mark: string): DraftPatchSpan | null {
  const lines = text.split("\n");
  const at = lines.findIndex(line => line.trim() === mark.trim());
  if (at < 0) throw new Error("the mark isn't a line of the note");
  let end = at - 1;
  while (end >= 0 && !lines[end]!.trim()) end -= 1;
  if (end < 0) return null;
  let start = end;
  while (start > 0 && lines[start - 1]!.trim()) start -= 1;
  const offset = lines.slice(0, start).reduce((sum, line) => sum + line.length + 1, 0);
  const observed = lines.slice(start, end + 1).join("\n");
  const replacement = lines.slice(start, end + 1).map(tidyLine).join("\n");
  if (replacement === observed) return null;
  // The text either side goes along, so "apply anyway" can still place it after the person edits the passage.
  return { observed, replacement, range: { start: offset, end: offset + observed.length }, unit: "utf16", ...spanContext(text, offset, offset + observed.length) };
}
