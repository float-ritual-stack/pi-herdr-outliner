// An agent addressed while you write (PIE-501). The service sends `respond` with the note as the person
// sees it (their live draft, when a door holds one) and the request line, the mark. `@tidy` tidies the
// paragraph just above the mark; `@tidy all` everything above it. It answers patches: the text it saw
// and what it becomes. The service applies them as an attributed edit (draft.patch, the edit policy);
// only if the person was typing in that passage does it become a proposal. It never runs a model:
// swap `respond` for a call to one (with a deadline up to 5m and effects "spend") and the rest stays.

interface Request {
  operation: string;
  input: { agent: string; request: string; mark: string; note: { id: string; revision: number; text: string } };
}

/** Links, references, anchors, properties and code: tidying never goes inside one. */
const PROTECTED = /\[\[[^\]\r\n]*\]\]|!?\(\([^)\r\n]*\)\)|\[[A-Za-z][A-Za-z0-9_.-]*::[^\]\r\n]*\]|(?<=\s)\^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$|`[^`\r\n]*`/g;

function tidyGap(text: string): string {
  return text.replace(/\*\*\s+([^*\n]*?)\s+\*\*/g, "**$1**").replace(/ {2,}/g, " ");
}

/** One line: bullets as `-`, one space after a list marker and a heading's `#`, no runs of spaces, no trailing space. */
function tidyLine(line: string): string {
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

const request = (await Bun.stdin.json()) as Request;
if (request.operation !== "respond") {
  process.stdout.write(JSON.stringify({ ok: false, code: "invalid-config" }));
} else {
  const lines = request.input.note.text.split("\n");
  const markAt = lines.indexOf(request.input.mark);
  let end = markAt - 1;
  while (end >= 0 && !lines[end]!.trim()) end -= 1;
  let start = end;
  if (/^all\b/i.test(request.input.request)) start = 0;
  else while (start > 0 && lines[start - 1]!.trim()) start -= 1;
  // Never the note's title line: tidy what is under it.
  start = Math.max(start, 1);
  const observed = end >= start ? lines.slice(start, end + 1).join("\n") : "";
  const replacement = lines.slice(start, end + 1).map(tidyLine).join("\n");
  const value = !observed.trim() || replacement === observed
    ? { message: "nothing to tidy above" }
    : {
      message: `tidied ${end - start + 1} line${end === start ? "" : "s"} above`,
      patches: [{
        observed, replacement,
        // The text either side, so the service finds the passage even if the note moved around it.
        before: lines.slice(0, start).join("\n").slice(-80), after: lines.slice(end + 1).join("\n").slice(0, 80),
      }],
    };
  process.stdout.write(JSON.stringify({ ok: true, value }));
}
