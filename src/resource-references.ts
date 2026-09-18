import { createHash } from "node:crypto";
import { parsePropertyRecords } from "./properties";

export type AuthoredResourceReference =
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

export function authoredResourceReferenceOccurrences(
  text: string,
): AuthoredResourceReferenceOccurrence[] {
  const occurrences: AuthoredResourceReferenceOccurrence[] = [];
  for (const property of parsePropertyRecords(text)) {
    if (
      property.key !== "file" && property.key !== "web" &&
      property.key !== "jira" && property.key !== "app"
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
  return occurrences;
}
