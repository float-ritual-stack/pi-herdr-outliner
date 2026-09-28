import { createHash } from "node:crypto";
import { protectedCodeRanges } from "./markdown-code-ranges";
import { parsePropertyDirectiveLines, parsePropertyRecords } from "./properties";

export type AuthoredResourceReference =
  | { readonly kind: "resource"; readonly resourceId: string }
  | { readonly kind: "filesystem"; readonly path: string }
  | { readonly kind: "web"; readonly url: string }
  | { readonly kind: "jira"; readonly key: string }
  | { readonly kind: "application"; readonly uri: string };

export type AuthoredResourceReferenceOccurrence =
  | {
      readonly kind: "authored-resource";
      readonly reference: AuthoredResourceReference;
      readonly label: string;
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly kind: "invalid-authored-resource";
      readonly start: number;
      readonly end: number;
      readonly message: string;
    };

export type AuthoredResourceReferenceLookup =
  | { readonly kind: "ready"; readonly resourceId: string }
  | { readonly kind: "unregistered"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly reason: string };

const REMOTE_FILE_PATTERN = /^([^/@\s]+)@([^/\s]+)\/(.+)$/;
const JIRA_KEY_PATTERN = /^([A-Z][A-Z0-9_]*)-([1-9][0-9]*)$/;
const MAX_AUTHORED_RESOURCE_LOCATOR_UNITS = 4_096;
const MAX_JIRA_KEY_UNITS = 255;

function invalid(start: number, end: number, message: string): AuthoredResourceReferenceOccurrence {
  return { kind: "invalid-authored-resource", start, end, message };
}

function parseAbsoluteUri(value: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URI`);
  }
  if (parsed.password || parsed.hash) {
    throw new Error(`${label} cannot contain a password or fragment`);
  }
  return parsed;
}

function boundedLocator(
  value: string,
  label: string,
  maximum = MAX_AUTHORED_RESOURCE_LOCATOR_UNITS,
): string {
  if (value.length > maximum) {
    throw new Error(`${label} exceeds ${maximum} UTF-16 units`);
  }
  return value;
}

export function authoredResourceReferenceKey(reference: AuthoredResourceReference): string {
  let locator: string;
  switch (reference.kind) {
    case "resource": locator=reference.resourceId;break;
    case "filesystem":
      locator = reference.path;
      break;
    case "web":
      locator = reference.url;
      break;
    case "jira":
      locator = reference.key;
      break;
    case "application":
      locator = reference.uri;
      break;
  }
  const digest = createHash("sha256").update(locator).digest("hex");
  return JSON.stringify(["authored-resource", reference.kind, digest]);
}

/**
 * A provider whose property key may be written as a line of its own
 * (`jira::`, `jira:: --comments`, `- jira:: KEY`). The key pattern is the
 * provider's, so context resolution stays provider-agnostic. Slice 5 of
 * PIE-445 derives this table from the extension registry; until then Jira is
 * its only entry.
 */
export interface ResourceDirectiveProvider {
  readonly provider: "jira";
  readonly propertyKey: string;
  /** One whole key, anchored. */
  readonly keyPattern: RegExp;
  /** The same grammar unanchored, with the boundaries a key needs in prose. */
  readonly keyInProsePattern: RegExp;
}

export const RESOURCE_DIRECTIVE_PROVIDERS: readonly ResourceDirectiveProvider[] = [{
  provider: "jira",
  propertyKey: "jira",
  keyPattern: JIRA_KEY_PATTERN,
  keyInProsePattern: /(?<![\p{L}\p{N}_-])[A-Z][A-Z0-9_]*-[1-9][0-9]*(?![\p{L}\p{N}_-])/gu,
}];

const DIRECTIVE_KEYS: ReadonlySet<string> = new Set(
  RESOURCE_DIRECTIVE_PROVIDERS.map((provider) => provider.propertyKey),
);

export function resourceDirectiveProvider(propertyKey: string): ResourceDirectiveProvider | undefined {
  return RESOURCE_DIRECTIVE_PROVIDERS.find((provider) => provider.propertyKey === propertyKey);
}

/** Host display options. They never reach a provider. */
export interface ResourceDirectiveOptions {
  readonly comments?: number;
  readonly compact?: true;
  readonly full?: true;
  readonly unknown: readonly string[];
}

export interface ResourceDirectiveOccurrence {
  readonly kind: "resource-directive";
  readonly provider: ResourceDirectiveProvider["provider"];
  readonly propertyKey: string;
  /** A key written after `::`; it always wins over context. */
  readonly explicitKey?: string;
  readonly options: ResourceDirectiveOptions;
  readonly line: number;
  readonly indent: string;
  readonly start: number;
  readonly end: number;
}

const DEFAULT_DIRECTIVE_COMMENTS = 5;
const MAX_DIRECTIVE_COMMENTS = 100;

function parseDirectiveValue(
  provider: ResourceDirectiveProvider,
  value: string,
): { explicitKey?: string; options: ResourceDirectiveOptions } | null {
  const words = value.split(/[ \t]+/).filter(Boolean);
  let explicitKey: string | undefined;
  if (words[0] && !words[0].startsWith("--")) {
    const key = words[0].toUpperCase();
    if (!provider.keyPattern.test(key) || key.length > MAX_JIRA_KEY_UNITS) return null;
    explicitKey = key;
    words.shift();
  }
  let comments: number | undefined;
  let compact = false;
  let full = false;
  const unknown: string[] = [];
  for (const word of words) {
    if (!word.startsWith("--")) return null;
    const option = /^--comments(?:=([1-9][0-9]{0,2}))?$/.exec(word);
    if (option) {
      comments = Math.min(MAX_DIRECTIVE_COMMENTS, Number(option[1] ?? DEFAULT_DIRECTIVE_COMMENTS));
    } else if (word === "--compact") compact = true;
    else if (word === "--full") full = true;
    else unknown.push(word);
  }
  return {
    ...(explicitKey ? { explicitKey } : {}),
    options: {
      ...(comments !== undefined ? { comments } : {}),
      ...(compact ? { compact: true as const } : {}),
      ...(full ? { full: true as const } : {}),
      unknown,
    },
  };
}

/**
 * Provider lines that ask for the ticket named here or by context. A value
 * that is neither a key nor options (`jira:: hello`) is not a directive and
 * keeps its authored-reference diagnostic. A preamble `jira:: KEY` is the
 * block's own property (the ticket page), not a directive.
 */
export function resourceDirectiveOccurrences(text: string): ResourceDirectiveOccurrence[] {
  return parsePropertyDirectiveLines(text, DIRECTIVE_KEYS).flatMap((line) => {
    const provider = resourceDirectiveProvider(line.key)!;
    const parsed = parseDirectiveValue(provider, line.value);
    // A preamble `jira:: KEY` alone is the page's property; with options it is a directive.
    if (!parsed || (line.blockScope && parsed.explicitKey && line.value.trim().toUpperCase() === parsed.explicitKey)) return [];
    return [{
      kind: "resource-directive" as const,
      provider: provider.provider,
      propertyKey: provider.propertyKey,
      ...parsed,
      line: line.line,
      indent: line.indent,
      start: line.start,
      end: line.end,
    }];
  });
}

/**
 * Whether text could hold a provider line or a provider block property. Only
 * a cheap guard so readers skip a service round trip; the service decides.
 */
export function mayHaveResourceProjections(text: string): boolean {
  if (!text.includes("::")) return false;
  return resourceDirectiveOccurrences(text).length > 0 ||
    parsePropertyRecords(text).some((record) => record.scope === "block" && DIRECTIVE_KEYS.has(record.key));
}

export interface ProviderKeyOccurrence {
  readonly key: string;
  readonly start: number;
  readonly end: number;
}

/** Key-shaped tokens in prose, outside code. Callers apply their own claim filter. */
export function providerKeyOccurrences(
  provider: ResourceDirectiveProvider,
  text: string,
): ProviderKeyOccurrence[] {
  const code = protectedCodeRanges(text);
  return [...text.matchAll(new RegExp(provider.keyInProsePattern.source, provider.keyInProsePattern.flags))]
    .filter((match) => !code.some((range) => range.start < match.index + match[0].length && match.index < range.end))
    .map((match) => ({ key: match[0], start: match.index, end: match.index + match[0].length }));
}

export function authoredResourceReferenceOccurrences(
  text: string,
): AuthoredResourceReferenceOccurrence[] {
  const occurrences: AuthoredResourceReferenceOccurrence[] = [];
  const directives = new Map(resourceDirectiveOccurrences(text).map((directive) => [directive.start, directive]));
  for (const property of parsePropertyRecords(text)) {
    const directive = property.syntax === "bare" ? directives.get(property.start) : undefined;
    if (directive) {
      directives.delete(property.start);
      if (directive.explicitKey) {
        occurrences.push({
          kind: "authored-resource",
          reference: { kind: "jira", key: directive.explicitKey },
          label: directive.explicitKey,
          start: property.start,
          end: property.end,
        });
      }
      continue;
    }
    if (
      property.key !== "file" && property.key !== "web" &&
      property.key !== "jira" && property.key !== "app" && property.key !== "raw-capture" && property.key !== "before-rewrite"
    ) continue;
    const value = property.value.trim();
    const range = { start: property.start, end: property.end };
    if (value.length > MAX_AUTHORED_RESOURCE_LOCATOR_UNITS) {
      occurrences.push(invalid(
        range.start,
        range.end,
        `Authored Resource locator exceeds ${MAX_AUTHORED_RESOURCE_LOCATOR_UNITS} UTF-16 units`,
      ));
      continue;
    }
    try {
      if(property.key==="raw-capture"||property.key==="before-rewrite"){
        if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))throw Error("Preserved capture Resource ID is invalid or unavailable");
        occurrences.push({kind:"authored-resource",reference:{kind:"resource",resourceId:value.toLowerCase()},label:property.key==="raw-capture"?"Original capture":"Before this rewrite",...range});continue;
      }
      if (property.key === "file") {
        const remote = REMOTE_FILE_PATTERN.exec(value);
        if (remote) {
          const encodedPath = remote[3]!.split("/")
            .map((segment) => encodeURIComponent(segment))
            .join("/");
          const uri = boundedLocator(
            parseAbsoluteUri(
              `ssh://${encodeURIComponent(remote[1]!)}@${remote[2]}/${encodedPath}`,
              "Remote file Resource URI",
            ).href,
            "Remote file Resource URI",
          );
          occurrences.push({
            kind: "authored-resource",
            reference: { kind: "application", uri },
            label: value,
            ...range,
          });
        } else {
          occurrences.push({
            kind: "authored-resource",
            reference: { kind: "filesystem", path: value },
            label: value,
            ...range,
          });
        }
        continue;
      }
      if (property.key === "web") {
        const parsed = parseAbsoluteUri(value, "Web Resource URL");
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          throw new Error("Web Resource URL must use http or https");
        }
        const url = boundedLocator(parsed.href, "Web Resource URL");
        occurrences.push({
          kind: "authored-resource",
          reference: { kind: "web", url },
          label: value,
          ...range,
        });
        continue;
      }
      if (property.key === "jira") {
        const key = value.toUpperCase();
        if (!JIRA_KEY_PATTERN.test(key)) throw new Error("Jira Resource key must look like PROJECT-123");
        boundedLocator(key, "Jira Resource key", MAX_JIRA_KEY_UNITS);
        occurrences.push({
          kind: "authored-resource",
          reference: { kind: "jira", key },
          label: key,
          ...range,
        });
        continue;
      }
      if (property.key === "app") {
        const parsed = parseAbsoluteUri(value, "Application Resource URI");
        const uri = boundedLocator(parsed.href, "Application Resource URI");
        occurrences.push({
          kind: "authored-resource",
          reference: { kind: "application", uri },
          label: value,
          ...range,
        });
      }
    } catch (error) {
      occurrences.push(invalid(
        range.start,
        range.end,
        error instanceof Error ? error.message : String(error),
      ));
    }
  }
  // A bulleted provider line is not a property record, but its explicit key is
  // still an authored reference.
  for (const directive of directives.values()) {
    if (!directive.explicitKey) continue;
    occurrences.push({
      kind: "authored-resource",
      reference: { kind: "jira", key: directive.explicitKey },
      label: directive.explicitKey,
      start: directive.start,
      end: directive.end,
    });
  }
  return occurrences.sort((left, right) => left.start - right.start);
}


/** Only a precise, authored file occurrence qualifies for automatic local Preview. */
export function isAuthoredFileOccurrence(text:string,start:number,end:number):boolean {
  return authoredResourceReferenceOccurrences(text).some(occurrence=>occurrence.kind==="authored-resource"&&occurrence.reference.kind==="filesystem"&&occurrence.start===start&&occurrence.end===end);
}
