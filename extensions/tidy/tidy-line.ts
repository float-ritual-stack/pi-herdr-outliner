// What @tidy does to one line, kept apart from tidy.ts (which reads its request from stdin) so the
// service's `outliner patch-demo` uses the same rules instead of a copy.

/** Links, references, anchors, properties and code: tidying never goes inside one. */
const PROTECTED = /\[\[[^\]\r\n]*\]\]|!?\(\([^)\r\n]*\)\)|\[[A-Za-z][A-Za-z0-9_.-]*::[^\]\r\n]*\]|(?<=\s)\^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$|`[^`\r\n]*`/g;

function tidyGap(text: string): string {
  return text.replace(/\*\*\s+([^*\n]*?)\s+\*\*/g, "**$1**").replace(/ {2,}/g, " ");
}

/** One line: bullets as `-`, one space after a list marker and a heading's `#`, no runs of spaces, no trailing space. */
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
  return lead + body + tidyGap(out.slice(cursor));
}
