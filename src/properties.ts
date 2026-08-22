import type {
  BlockProperty,
  PropertyFilter,
  PropertyPatchOperation,
  PropertyPlacement,
  PropertyToken,
} from "./types";

const PROPERTY_PATTERN = /\[([A-Za-z][A-Za-z0-9_.-]*)::([^\]\r\n]+)\]/g;
const PROPERTY_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]*$/;

function createPropertyPattern(): RegExp {
  return new RegExp(PROPERTY_PATTERN.source, "g");
}

export function parsePropertyTokens(text: string): PropertyToken[] {
  const tokens: PropertyToken[] = [];
  const lines = text.split("\n");
  let offset = 0;

  lines.forEach((line, lineIndex) => {
    const matches = [...line.matchAll(createPropertyPattern())];
    const lineWithoutProperties = line.replace(createPropertyPattern(), "").trim();
    const metadataLine = matches.length > 0 && lineWithoutProperties === "";

    for (const match of matches) {
      const column = match.index;
      const raw = match[0];
      const suffixWithoutProperties = line
        .slice(column + raw.length)
        .replace(createPropertyPattern(), "")
        .trim();
      let placement: PropertyPlacement = "inline";
      if (metadataLine) {
        placement = "metadata-line";
      } else if (suffixWithoutProperties === "") {
        placement = "trailing-metadata";
      }
      tokens.push({
        key: match[1].toLowerCase(),
        value: match[2].trim(),
        ordinal: tokens.length,
        raw,
        start: offset + column,
        end: offset + column + raw.length,
        line: lineIndex,
        column,
        placement,
      });
    }
    offset += line.length + 1;
  });

  return tokens;
}

export function parseProperties(text: string): BlockProperty[] {
  return parsePropertyTokens(text).map(({ key, value }) => ({ key, value }));
}

export function stripProperties(text: string): string {
  return text.replace(createPropertyPattern(), "").replace(/\s{2,}/g, " ").trim();
}

export function validateProperty(key: string, value: string): BlockProperty {
  if (!PROPERTY_KEY_PATTERN.test(key)) throw new Error(`Invalid property key: ${key}`);
  const normalizedValue = value.trim();
  if (!normalizedValue) throw new Error(`Property value cannot be empty: ${key}`);
  if (/[\]\r\n]/.test(normalizedValue)) {
    throw new Error(`Property value cannot contain ], CR, or LF: ${key}`);
  }
  return { key: key.toLowerCase(), value: normalizedValue };
}

export function formatProperty(property: BlockProperty): string {
  const validated = validateProperty(property.key, property.value);
  return `[${validated.key}::${validated.value}]`;
}

export function patchPropertyText(text: string, operations: PropertyPatchOperation[]): string {
  const tokens = parsePropertyTokens(text);
  const mutations: Array<{ start: number; end: number; replacement: string }> = [];
  const touchedOrdinals = new Set<number>();
  const appends: BlockProperty[] = [];

  for (const operation of operations) {
    const operationKind: string = operation.op;
    if (operationKind === "append") {
      const append = operation as Extract<PropertyPatchOperation, { op: "append" }>;
      appends.push(validateProperty(append.key, append.value));
      continue;
    }
    if (operationKind !== "remove" && operationKind !== "replace") {
      throw new Error(`Unknown property patch operation: ${operationKind}`);
    }
    const tokenOperation = operation as Exclude<PropertyPatchOperation, { op: "append" }>;
    if (!Number.isInteger(tokenOperation.ordinal) || tokenOperation.ordinal < 0) {
      throw new Error(`Invalid property token ordinal: ${tokenOperation.ordinal}`);
    }
    if (touchedOrdinals.has(tokenOperation.ordinal)) {
      throw new Error(`Property token patched more than once: ${tokenOperation.ordinal}`);
    }
    touchedOrdinals.add(tokenOperation.ordinal);
    const token = tokens[tokenOperation.ordinal];
    if (!token) throw new Error(`Property token not found: ${tokenOperation.ordinal}`);
    let replacement = "";
    if (operationKind === "replace") {
      const key = "key" in tokenOperation ? tokenOperation.key ?? token.key : token.key;
      const value = "value" in tokenOperation ? tokenOperation.value : token.value;
      replacement = formatProperty({ key, value });
    }
    mutations.push({ start: token.start, end: token.end, replacement });
  }

  let patched = text;
  for (const mutation of mutations.sort((left, right) => right.start - left.start)) {
    patched = patched.slice(0, mutation.start) + mutation.replacement + patched.slice(mutation.end);
  }
  if (appends.length === 0) return patched;

  const appendedText = appends.map(formatProperty).join(" ");
  const metadataToken = parsePropertyTokens(patched).find((token) => token.placement === "metadata-line");
  if (metadataToken) {
    const lineEnd = patched.indexOf("\n", metadataToken.end);
    let insertion = lineEnd < 0 ? patched.length : lineEnd;
    if (insertion > 0 && patched[insertion - 1] === "\r") insertion -= 1;
    const separator = patched.slice(0, insertion).endsWith(" ") ? "" : " ";
    return patched.slice(0, insertion) + separator + appendedText + patched.slice(insertion);
  }
  if (!patched) return appendedText;

  const firstNewline = patched.indexOf("\n");
  if (firstNewline < 0) return `${patched}\n${appendedText}`;
  const usesCrlf = firstNewline > 0 && patched[firstNewline - 1] === "\r";
  const lineBreak = usesCrlf ? "\r\n" : "\n";
  const firstLineEnd = usesCrlf ? firstNewline - 1 : firstNewline;
  return `${patched.slice(0, firstLineEnd)}${lineBreak}${appendedText}${patched.slice(firstLineEnd)}`;
}

export function parseFilter(input: string): PropertyFilter[] {
  const trimmed = input.trim();
  if (!trimmed) return [];

  return trimmed.split(/\s+/).map((token) => {
    const separator = token.includes("::") ? "::" : "=";
    const index = token.indexOf(separator);
    if (index < 1) return { key: token.toLowerCase() };
    return {
      key: token.slice(0, index).toLowerCase(),
      value: token.slice(index + separator.length),
    };
  });
}

export function matchesFilters(properties: BlockProperty[], filters: PropertyFilter[]): boolean {
  return filters.every((filter) =>
    properties.some(
      (property) =>
        property.key === filter.key &&
        (filter.value === undefined || property.value.toLowerCase() === filter.value.toLowerCase()),
    ),
  );
}

export function getProperty(properties: BlockProperty[], key: string): string | undefined {
  return properties.find((property) => property.key === key.toLowerCase())?.value;
}
