import type { BlockProperty, PropertyFilter } from "./types";

const PROPERTY_PATTERN = /\[([A-Za-z][A-Za-z0-9_.-]*)::([^\]\r\n]+)\]/g;

export function parseProperties(text: string): BlockProperty[] {
  const properties: BlockProperty[] = [];
  for (const match of text.matchAll(PROPERTY_PATTERN)) {
    properties.push({ key: match[1].toLowerCase(), value: match[2].trim() });
  }
  return properties;
}

export function stripProperties(text: string): string {
  return text.replace(PROPERTY_PATTERN, "").replace(/\s{2,}/g, " ").trim();
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
