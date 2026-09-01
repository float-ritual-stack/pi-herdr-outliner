import { PROPERTY_PARSER_VERSION } from "./properties";

import { isCanonicalWorkId } from "./work-ids";

const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const PAGE_ADDRESS_PATTERN = /\[\[([^\]\r\n]+)\]\]/g;

export const PAGE_ADDRESS_MAX_LENGTH = 512;
export const PAGE_ADDRESS_REGISTRY_VERSION = PROPERTY_PARSER_VERSION;

export interface NormalizedPageAddress {
  displayAddress: string;
  normalizedAddress: string;
}

export interface PageAddressReference extends NormalizedPageAddress {
  label?: string;
  start: number;
  end: number;
}
export function isWorkIdAddress(address: string): boolean {
  return isCanonicalWorkId(address);
}

export function normalizePageAddress(input: string): NormalizedPageAddress {
  const displayAddress = input.trim();
  if (!displayAddress) throw new Error("Page address cannot be empty");
  if (displayAddress.length > PAGE_ADDRESS_MAX_LENGTH) {
    throw new Error(`Page address cannot exceed ${PAGE_ADDRESS_MAX_LENGTH} characters`);
  }
  if (CONTROL_PATTERN.test(displayAddress)) {
    throw new Error("Page address contains control characters");
  }
  if (displayAddress.includes("]")) {
    throw new Error("Page address cannot contain ]");
  }
  // Upper-then-lower performs stable caseless canonicalization for forms such as ß and final sigma.
  const normalizedAddress = displayAddress
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .toUpperCase()
    .toLowerCase();
  return { displayAddress, normalizedAddress };
}

export function tryNormalizePageAddress(input: string): NormalizedPageAddress | null {
  try {
    return normalizePageAddress(input);
  } catch {
    return null;
  }
}

export function pageAddressReferences(text: string): PageAddressReference[] {
  const references: PageAddressReference[] = [];
  for (const match of text.matchAll(PAGE_ADDRESS_PATTERN)) {
    const authored = match[1]!;
    const separator = authored.indexOf("|");
    const target = separator < 0 ? authored : authored.slice(0, separator);
    const label = separator < 0 ? undefined : authored.slice(separator + 1).trim();
    if (separator >= 0 && !label) continue;
    try {
      references.push({
        ...normalizePageAddress(target),
        ...(label ? { label } : {}),
        start: match.index,
        end: match.index + match[0].length,
      });
    } catch {
      // Invalid authored syntax stays visible but is not actionable.
    }
  }
  return references;
}
