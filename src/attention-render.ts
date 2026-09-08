import {
  stripTerminalSequences,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { currentAttentionMark } from "./attention";
import { sanitizeDynamicText } from "./terminal";
import type {
  AttentionClientState,
  AttentionMark,
  AttentionTone,
} from "./types";

const RESET = "\x1b[0m";
const TONE_STYLE: Record<AttentionTone, string> = {
  current: "\x1b[1;4;97;48;5;24m",
  info: "\x1b[1;4;96m",
  warning: "\x1b[1;4;33m",
  error: "\x1b[1;4;31m",
  match: "\x1b[1;4;32m",
  dim: "\x1b[2;4m",
};

function terminalVisibleOffsets(value: string): { text: string; offsets: number[] } {
  let text = "";
  const offsets: number[] = [];
  let index = 0;
  while (index < value.length) {
    if (value[index] === "\x1b") {
      const escape = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(value.slice(index));
      if (escape) {
        index += escape[0].length;
        continue;
      }
    }
    offsets.push(index);
    text += value[index]!;
    index += 1;
  }
  offsets.push(value.length);
  return { text, offsets };
}

function styleTerminalSubstring(
  value: string,
  needle: string,
  style: string,
  occurrence: number,
): string | null {
  const visible = terminalVisibleOffsets(value);
  let start = -1;
  let searchFrom = 0;
  for (let index = 0; index <= occurrence; index += 1) {
    start = visible.text.indexOf(needle, searchFrom);
    if (start < 0) return null;
    searchFrom = start + Math.max(1, needle.length);
  }
  const rawStart = visible.offsets[start]!;
  const rawEnd = visible.offsets[start + needle.length]!;
  const selected = value.slice(rawStart, rawEnd).replaceAll(RESET, `${RESET}${style}`);
  return `${value.slice(0, rawStart)}${style}${selected}${RESET}${value.slice(rawEnd)}`;
}

function plainAttentionTerm(value: string): string {
  return value
    .replace(/^[ \t]{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])[ \t]+/, "")
    .replace(/^[ \t]*\[![^\]]+\][+-]?[ \t]*/i, "")
    .replace(/\\([\\`*{}\[\]()#+\-.!_>~])/g, "$1")
    .replace(/[*_~`]/g, "")
    .trim();
}

export function attentionExcerpt(mark: AttentionMark): string {
  return mark.target.anchor?.excerpt ?? "";
}

interface AttentionTerm {
  group: number;
  term: string;
  occurrence: number;
  plain: boolean;
}

function countOccurrences(value: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= value.length - needle.length) {
    const found = value.indexOf(needle, offset);
    if (found < 0) break;
    count += 1;
    offset = found + Math.max(1, needle.length);
  }
  return count;
}

function plainAttentionText(value: string): string {
  return value.split(/\r?\n/).map(plainAttentionTerm).join("\n");
}

function attentionTerms(mark: AttentionMark, sourceText?: string): AttentionTerm[] {
  const terms: AttentionTerm[] = [];
  let excerptOffset = 0;
  for (const [group, line] of attentionExcerpt(mark).split(/\r?\n/).entries()) {
    const exact = sanitizeDynamicText(line).trim();
    const trimmedOffset = line.indexOf(exact);
    const sourceOffset = mark.target.anchor!.start + excerptOffset + Math.max(0, trimmedOffset);
    if (exact) {
      terms.push({
        group,
        term: exact,
        occurrence: sourceText
          ? countOccurrences(sourceText.slice(0, sourceOffset), exact)
          : 0,
        plain: false,
      });
    }
    const plain = plainAttentionTerm(exact);
    if (plain && plain !== exact) {
      terms.push({
        group,
        term: plain,
        occurrence: sourceText
          ? countOccurrences(plainAttentionText(sourceText.slice(0, sourceOffset)), plain)
          : 0,
        plain: true,
      });
    }
    excerptOffset += line.length + 1;
  }
  return terms.sort((left, right) => right.term.length - left.term.length);
}

export function decorateAttentionLines(
  lines: readonly string[],
  mark: AttentionMark | null,
  width?: number,
  sourceText?: string,
  sourcePrefix = "",
): string[] {
  if (!mark || mark.sourceState !== "active" || !mark.target.anchor) return [...lines];
  const style = TONE_STYLE[mark.tone];
  const terms = attentionTerms(mark, sourceText);
  const matchedGroups = new Set<number>();
  const seen = new Map(
    terms.map((term) => [
      term,
      countOccurrences(
        term.plain ? plainAttentionText(sourcePrefix) : sourcePrefix,
        term.term,
      ),
    ]),
  );
  return lines.map((line) => {
    let rendered = line;
    const visible = terminalVisibleOffsets(line).text;
    for (const term of terms) {
      if (matchedGroups.has(term.group)) continue;
      const prior = seen.get(term) ?? 0;
      const found = countOccurrences(visible, term.term);
      if (term.occurrence >= prior && term.occurrence < prior + found) {
        const styled = styleTerminalSubstring(
          rendered,
          term.term,
          style,
          term.occurrence - prior,
        );
        if (styled) {
          rendered = styled;
          matchedGroups.add(term.group);
        }
      }
      seen.set(term, prior + found);
    }
    if (rendered === line) return line;
    const marked = `\x1b[1m▐${RESET} ${rendered}`;
    return width === undefined ? marked : truncateToWidth(marked, width, "…");
  });
}

export function decorateAttentionBlockLine(
  value: string,
  mark: AttentionMark | null,
  width: number,
): string {
  if (!mark || mark.sourceState !== "active") return value;
  const style = TONE_STYLE[mark.tone];
  const styled = value.replaceAll(RESET, `${RESET}${style}`);
  return truncateToWidth(`${style}${styled}${RESET} \x1b[1m◀${RESET}`, width, "…");
}

export function attentionBanner(
  state: Readonly<AttentionClientState>,
  sourceBlockId: string | null | undefined,
  width: number,
): string | null {
  const active = currentAttentionMark(state, sourceBlockId);
  const stale = state.marks.find((mark) =>
    mark.role === "current" &&
    mark.target.sourceBlockId === sourceBlockId &&
    mark.sourceState === "stale"
  );
  const mark = active ?? stale;
  if (!mark) return null;
  const excerpt = attentionExcerpt(mark).replace(/\s+/g, " ").trim();
  const stateLabel = mark.sourceState === "stale" ? "STALE" : mark.tone.toUpperCase();
  const quoted = excerpt ? ` · “${excerpt}”` : "";
  const banner = `▶ ATTENTION ${stateLabel} · ${mark.sender}${quoted} · ⌃X acknowledge`;
  const style = mark.sourceState === "stale" ? TONE_STYLE.warning : TONE_STYLE[mark.tone];
  return `${style}${truncateToWidth(stripTerminalSequences(banner), width, "…")}${RESET}`;
}

export function attentionReturnSummary(
  state: Readonly<AttentionClientState>,
  width: number,
): string | null {
  if (!state.summary) return null;
  return `\x1b[1;33m${truncateToWidth(`↩ ${state.summary} · ⌃X acknowledge`, width, "…")}${RESET}`;
}
