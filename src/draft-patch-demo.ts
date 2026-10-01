/**
 * A CLI demo of `draft.patch` with the `prose` policy (PIE-501), for demos and
 * tests only. It is not the `@tidy` agent: that is the tidy extension
 * (`extensions/tidy`), which the service runs on a person's `@tidy` line and
 * whose patches go through the `edit` policy. `outliner patch-demo --block <id>
 * --tidy-above <mark>` reads the note as its live draft has it (`drafts.read`),
 * tidies the paragraph just above the mark line with the extension's own line
 * rules (`tidyLine`), and sends that as one span, as actor `patch-demo`.
 */
import { tidyLine } from "../extensions/tidy/tidy-line";
import { spanContext, type DraftPatchSpan } from "./draft-patch-compare";

export { tidyLine };

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
  // The text either side goes along, so "apply anyway" can tell which copy of the passage it means.
  return { observed, replacement, range: { start: offset, end: offset + observed.length }, unit: "utf16", ...spanContext(text, offset, offset + observed.length) };
}
