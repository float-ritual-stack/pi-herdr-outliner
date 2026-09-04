import { sanitizeDynamicText } from "./terminal";
import type { BlockProperty } from "./types";

export const DEFAULT_PROPERTY_SUMMARY_KEYS = [
  "status",
  "work-stage",
  "priority",
  "track",
] as const;

export interface PropertySummarySegment {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly plain: string;
}

export function parsePropertySummaryKeys(
  value: string | undefined,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value.split(",")) {
    const key = candidate.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

export function propertySummarySegments(
  properties: readonly BlockProperty[],
  keys: readonly string[] = DEFAULT_PROPERTY_SUMMARY_KEYS,
): PropertySummarySegment[] {
  return keys.flatMap((key) => {
    const values = [...new Set(
      properties
        .filter((property) => property.key.toLowerCase() === key)
        .map((property) => sanitizeDynamicText(property.value))
        .filter(Boolean),
    )];
    if (values.length === 0) return [];
    const label = key === "work-stage" ? "stage" : key;
    const value = values.join(", ");
    return [{ key, label, value, plain: `${label} ${value}` }];
  });
}
