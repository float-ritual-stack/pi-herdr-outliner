import { createHash } from "node:crypto";
import { requestLines } from "./agent-requests";
import { protectedCodeRanges } from "./markdown-code-ranges";
import { parsePropertyRecords } from "./properties";

/** Metadata changes do not create new prose; authored hashtags still carry meaning. */
export function contentOfText(text: string): string {
  let content = text;
  for (const property of parsePropertyRecords(text).filter(property => property.scope === "block" && property.syntax !== "hashtag").reverse()) {
    content = content.slice(0, property.start) + content.slice(property.end);
  }
  return content.trim();
}

const sentences = new Intl.Segmenter("en", { granularity: "sentence" });

/**
 * Keep real prose passages, with no candidate cap: checkpoints must remember all of them. A line addressed to
 * an extension's agent (`@tidy …`, a name in `agentNames`) is that agent's request, not one for note assistance.
 */
export function requestPassages(text: string, agentNames?: ReadonlySet<string>): string[] {
  const content = contentOfText(text);
  const code = protectedCodeRanges(content);
  let offset = 0;
  const passages: string[] = [];
  let prose = "";
  const flush = () => {
    passages.push(...[...sentences.segment(prose)].map(value => value.segment.trim()).filter(Boolean));
    prose = "";
  };
  for (const line of content.split("\n")) {
    const start = offset + line.length - line.trimStart().length;
    const end = offset + line.trimEnd().length;
    offset += line.length + 1;
    // Preserve inline code inside prose: "list `type` values" and "do `not`
    // deploy" must retain their meaning. Quoted/code-only lines are context only.
    if (!line.trim() || /^\s*>/.test(line) || code.some(range => range.start <= start && range.end >= end) ||
      (agentNames?.size && requestLines(line, agentNames).length)) {
      flush();
      continue;
    }
    // Segmenter treats newlines as sentence boundaries, so unfold soft wraps first.
    prose += `${line.trim()} `;
  }
  flush();
  return passages;
}

export function passageKey(text: string): string {
  return createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex");
}
