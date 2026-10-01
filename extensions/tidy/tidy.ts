// An agent addressed while you write (PIE-501). The service sends `respond` with the note as the person
// sees it (their live draft, when a door holds one) and the request line, the mark. `@tidy` tidies the
// paragraph just above the mark; `@tidy all` everything above it. It answers patches: the text it saw
// and what it becomes. The service applies them as an attributed edit (draft.patch, the edit policy);
// only if the person was typing in that passage does it become a proposal. It never runs a model:
// swap `respond` for a call to one (with a deadline up to 5m and effects "spend") and the rest stays.

import { tidyLine } from "./tidy-line";

interface Request {
  operation: string;
  input: { agent: string; request: string; mark: string; note: { id: string; revision: number; text: string } };
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
