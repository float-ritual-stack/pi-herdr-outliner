import { createHash } from "node:crypto";
import type { ResourceRepresentationAdapter } from "./resources";

export interface WebSnapshotInput {
  readonly html: string;
  readonly url: string;
}

export interface WebMarkdownExtractor {
  readonly adapter: ResourceRepresentationAdapter;
  extract(snapshot: WebSnapshotInput): string;
}

export const BASIC_WEB_MARKDOWN_ADAPTER: ResourceRepresentationAdapter = {
  id: "builtin.basic-html-to-markdown",
  version: 1,
};

function decodeHtmlEntities(value: string): string {
  const named: Readonly<Record<string, string>> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#x")) {
      const codePoint = Number.parseInt(entity.slice(2), 16);
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    }
    if (entity.startsWith("#")) {
      const codePoint = Number.parseInt(entity.slice(1), 10);
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function absoluteLink(href: string, baseUrl: string): string {
  try {
    return new URL(decodeHtmlEntities(href), baseUrl).href;
  } catch {
    return decodeHtmlEntities(href);
  }
}

export class BasicWebMarkdownExtractor implements WebMarkdownExtractor {
  readonly adapter = BASIC_WEB_MARKDOWN_ADAPTER;

  extract(snapshot: WebSnapshotInput): string {
    let markdown = snapshot.html
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi, (_match, _quote, href: string, label: string) => {
        const text = label.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        return text ? `[${text}](${absoluteLink(href, snapshot.url)})` : absoluteLink(href, snapshot.url);
      })
      .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_match, level: string, text: string) => `\n\n${"#".repeat(Number(level))} ${text}\n\n`)
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<\/(?:p|div|section|article|main|header|footer|nav|aside|ul|ol|pre|blockquote)\s*>/gi, "\n\n")
      .replace(/<(?:p|div|section|article|main|header|footer|nav|aside|ul|ol|pre|blockquote)\b[^>]*>/gi, "\n")
      .replace(/<strong\b[^>]*>([\s\S]*?)<\/strong\s*>/gi, "**$1**")
      .replace(/<b\b[^>]*>([\s\S]*?)<\/b\s*>/gi, "**$1**")
      .replace(/<em\b[^>]*>([\s\S]*?)<\/em\s*>/gi, "*$1*")
      .replace(/<i\b[^>]*>([\s\S]*?)<\/i\s*>/gi, "*$1*")
      .replace(/<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi, "`$1`")
      .replace(/<[^>]+>/g, " ");
    markdown = decodeHtmlEntities(markdown)
      .replace(/[\t\f\v ]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return markdown;
  }
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
